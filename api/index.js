// api/index.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');
  const fromDatetime = searchParams.get('from_datetime');
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';

  // Bascule selon l'heure (Europe/Paris)
  const optionsDate = { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false };
  const currentHour = parseInt(new Intl.DateTimeFormat('fr-FR', optionsDate).format(new Date()), 10);

  let depart, arrivee, destinationLabel;

  if (currentHour >= 4 && currentHour < 13) {
    depart = GARE_VIERZON;
    arrivee = GARE_BOURGES;
    destinationLabel = 'Bourges';
  } else {
    depart = GARE_BOURGES;
    arrivee = GARE_VIERZON;
    destinationLabel = 'Vierzon';
  }

  if (dirParam === 'vierzon') {
    depart = GARE_BOURGES;
    arrivee = GARE_VIERZON;
    destinationLabel = 'Vierzon';
  } else if (dirParam === 'bourges') {
    depart = GARE_VIERZON;
    arrivee = GARE_BOURGES;
    destinationLabel = 'Bourges';
  }

  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
    const now = new Date();
    dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const authHeader = 'Basic ' + btoa(process.env.SNCF_API_KEY + ':');
  
  // Itinéraires directs stricts avec données temps réel
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=25&max_nb_transfers=0&data_freshness=realtime&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;

  try {
    const res = await fetch(sncfUrl, {
      headers: { Authorization: authHeader },
    });

    const data = await res.json();
    const journeys = data.journeys || [];

    if (journeys.length === 0) {
      return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const disruptionsList = data.disruptions || [];

    const parseSncfDate = (str) => {
      if (!str) return null;
      const clean = str.replace(/[-:]/g, '');
      if (clean.length < 15) return null;
      return new Date(
        parseInt(clean.substring(0, 4), 10),
        parseInt(clean.substring(4, 6), 10) - 1,
        parseInt(clean.substring(6, 8), 10),
        parseInt(clean.substring(9, 11), 10),
        parseInt(clean.substring(11, 13), 10),
        parseInt(clean.substring(13, 15), 10)
      );
    };

    const formatHHMM = (d) => {
      if (!d) return '--:--';
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    // Filtrage strict : exclure les cars et les vrais Intercités
    const validJourneys = journeys.filter((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      if (!s) return false;
      const info = s.display_informations;
      if (!info) return false;

      const physical = (info.physical_mode || '').toLowerCase();
      const commercial = (info.commercial_mode || '').toLowerCase();
      const network = (info.network || '').toLowerCase();
      const headsign = (info.headsign || '').trim();
      const tripShort = (info.trip_short_name || '').trim();

      if (physical.includes('coach') || physical.includes('bus') || commercial.includes('car')) return false;

      let num = headsign;
      if (!/^\d+$/.test(num)) num = tripShort;
      if (!/^\d+$/.test(num)) {
        const m = (s.id || '').match(/(\d{4,6})/);
        num = m ? m[1] : '';
      }

      // Conserver les Rémi Express (39xx)
      if (num.startsWith('39')) return true;

      // Écarter strictement les Intercités nationaux (44xx, 45xx)
      if (commercial.includes('intercit') || network.includes('intercit') || num.startsWith('44') || num.startsWith('45')) {
        return false;
      }

      return true;
    });

    const selectedJourneys = validJourneys.slice(offset, offset + 4);

    const trains = selectedJourneys.map((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      const stopTimes = s?.stop_date_times || [];
      const firstStop = stopTimes[0];
      const lastStop = stopTimes[stopTimes.length - 1];

      // Extraction des dates de départ (théorique vs réel)
      const rawBaseDep =
        firstStop?.base_departure_date_time ||
        s?.base_departure_date_time ||
        journey.base_departure_date_time;

      const rawRealDep =
        firstStop?.departure_date_time ||
        s?.departure_date_time ||
        journey.departure_date_time;

      // Extraction des dates d'arrivée (théorique vs réel)
      const rawBaseArr =
        lastStop?.base_arrival_date_time ||
        s?.base_arrival_date_time ||
        journey.base_arrival_date_time;

      const rawRealArr =
        lastStop?.arrival_date_time ||
        s?.arrival_date_time ||
        journey.arrival_date_time;

      const dateBaseDep = parseSncfDate(rawBaseDep || rawRealDep);
      const dateRealDep = parseSncfDate(rawRealDep || rawBaseDep);

      const dateBaseArr = parseSncfDate(rawBaseArr || rawRealArr);
      const dateRealArr = parseSncfDate(rawRealArr || rawBaseArr);

      // Calcul du retard en minutes
      let retardMinutes = 0;
      if (dateBaseDep && dateRealDep) {
        const diff = Math.round((dateRealDep.getTime() - dateBaseDep.getTime()) / 60000);
        if (diff > 0) retardMinutes = diff;
      }

      // Vérification des bulletins d'incidents / perturbations
      const dIds = [
        ...(journey.disruption_ids || []),
        ...(s?.display_informations?.disruption_ids || [])
      ];
      let isPerturbed = false;

      for (const id of dIds) {
        const dObj = disruptionsList.find((item) => item.id === id);
        if (dObj) {
          const msg = (dObj.messages || []).map((m) => m.text).join(' ');
          const matchMin = msg.match(/(\d+)\s*(?:min|mn)/i);
          if (matchMin) {
            const val = parseInt(matchMin[1], 10);
            if (val > retardMinutes) retardMinutes = val;
          }
          isPerturbed = true;
        }
      }

      // Recalcul des heures avec le retard si présent
      const finalDepReel = dateRealDep || new Date(dateBaseDep.getTime() + retardMinutes * 60000);
      const finalArrReel = dateRealArr || new Date((dateBaseArr || dateBaseDep).getTime() + retardMinutes * 60000);

      // Durée exacte du trajet
      const dureeCalc = Math.round((dateBaseArr.getTime() - dateBaseDep.getTime()) / 60000);
      const dureeMinutes = dureeCalc > 0 ? dureeCalc : Math.round(journey.duration / 60);

      const isCancelled =
        journey.status === 'NO_SERVICE' ||
        s?.display_informations?.status === 'DELETED';

      let numTrain = s?.display_informations?.headsign || 
                     s?.display_informations?.trip_short_name || '';
      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      let retardLabel = "À l'heure";
      if (isCancelled) {
        retardLabel = 'Supprimé';
      } else if (retardMinutes > 0) {
        retardLabel = `+${retardMinutes} min`;
      } else if (isPerturbed) {
        retardLabel = 'Perturbé';
      }

      return {
        departTheorique: formatHHMM(dateBaseDep),
        departReel: formatHHMM(finalDepReel),
        arriveeTheorique: formatHHMM(dateBaseArr),
        arriveeReelle: formatHHMM(finalArrReel),
        duree: `${dureeMinutes} min`,
        retardMinutes: retardMinutes,
        numero: numTrainPure || numTrain,
        retard: retardLabel,
        estEnRetard: retardMinutes > 0 || isCancelled || isPerturbed,
        estSupprime: isCancelled,
      };
    });

    return new Response(
      JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: validJourneys.length > offset + 4,
      }),
      {
        headers: { 'content-type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Erreur de connexion' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
