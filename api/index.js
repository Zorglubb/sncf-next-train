// api/index.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');
  const fromDatetime = searchParams.get('from_datetime');

  // Gares SNCF
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

  // Date / Heure
  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
    const now = new Date();
    dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const authHeader = 'Basic ' + btoa(process.env.SNCF_API_KEY + ':');
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=20&max_nb_transfers=0&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;

  try {
    const sncfRes = await fetch(sncfUrl, {
      headers: { Authorization: authHeader },
    });

    const data = await sncfRes.json();

    if (!data.journeys || data.journeys.length === 0) {
      return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const disruptionsList = data.disruptions || [];

    const filteredTrains = data.journeys.filter((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      if (!s) return false;
      const info = s.display_informations;
      if (!info) return false;

      const physical = (info.physical_mode || '').toLowerCase();
      const commercial = (info.commercial_mode || '').toLowerCase();
      const network = (info.network || '').toLowerCase();
      const headsign = (info.headsign || '').trim();
      const tripShort = (info.trip_short_name || '').trim();

      // Exclusion bus/cars
      if (physical.includes('coach') || physical.includes('bus') || commercial.includes('car')) {
        return false;
      }

      // Extraction du numéro
      let num = headsign;
      if (!/^\d+$/.test(num)) num = tripShort;
      if (!/^\d+$/.test(num)) {
        const m = (s.id || '').match(/(\d{4,6})/);
        num = m ? m[1] : '';
      }

      // Conserver les Rémi Express (39xx)
      if (num.startsWith('39')) {
        return true;
      }

      // Écarter strictement les Intercités nationaux (comme le 14:42 de la capture)
      if (commercial.includes('intercit') || network.includes('intercit') || num.startsWith('44') || num.startsWith('45')) {
        return false;
      }

      return true;
    });

    const selectedJourneys = filteredTrains.slice(0, 4);

    const parseSncfDate = (str) => {
      if (!str) return null;
      const clean = str.replace(/[-:]/g, '');
      if (clean.length < 15) return null;
      const y = parseInt(clean.substring(0, 4), 10);
      const m = parseInt(clean.substring(4, 6), 10) - 1;
      const d = parseInt(clean.substring(6, 8), 10);
      const h = parseInt(clean.substring(9, 11), 10);
      const min = parseInt(clean.substring(11, 13), 10);
      const s = parseInt(clean.substring(13, 15), 10);
      return new Date(y, m, d, h, min, s);
    };

    const trains = selectedJourneys.map((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      const stopTimes = s?.stop_date_times || [];
      const firstStop = stopTimes[0];

      // 1. Détection des heures de départ (théorique vs temps réel)
      const depTheorique =
        firstStop?.base_departure_date_time ||
        s?.base_departure_date_time ||
        journey.base_departure_date_time;

      const depReel =
        firstStop?.departure_date_time ||
        s?.departure_date_time ||
        journey.departure_date_time;

      let retardMinutes = 0;
      if (depTheorique && depReel) {
        const dtTh = parseSncfDate(depTheorique);
        const dtRe = parseSncfDate(depReel);
        if (dtTh && dtRe) {
          const diffMin = Math.round((dtRe.getTime() - dtTh.getTime()) / 60000);
          if (diffMin > 0) {
            retardMinutes = diffMin;
          }
        }
      }

      // 2. Détection via disruptions / régulation de trafic
      let causePerturbation = null;
      const dIds = [
        ...(journey.disruption_ids || []),
        ...(s?.display_informations?.disruption_ids || [])
      ];

      for (const id of dIds) {
        const dObj = disruptionsList.find((item) => item.id === id);
        if (dObj) {
          const fullText = (dObj.messages || []).map((m) => m.text).join(' ');
          
          // Chercher "Retard estimé à X min", "+X min", etc.
          const match = fullText.match(/(\d+)\s*(?:min|mn)/i);
          if (match) {
            const val = parseInt(match[1], 10);
            if (val > retardMinutes) {
              retardMinutes = val;
            }
          }
          if (dObj.cause || dObj.severity?.name) {
            causePerturbation = dObj.cause || dObj.severity?.name;
          }
        }
      }

      // Heure affichée : heure théorique
      const baseDate = parseSncfDate(depTheorique || depReel);
      let heureDep = '00';
      let minDep = '00';
      if (baseDate) {
        heureDep = String(baseDate.getHours()).padStart(2, '0');
        minDep = String(baseDate.getMinutes()).padStart(2, '0');
      }

      // Heure d'arrivée
      const rawArr = journey.arrival_date_time || s?.arrival_date_time;
      const arrDate = parseSncfDate(rawArr);
      let heureArr = '00';
      let minArr = '00';
      if (arrDate) {
        heureArr = String(arrDate.getHours()).padStart(2, '0');
        minArr = String(arrDate.getMinutes()).padStart(2, '0');
      }

      // Statut
      const isCancelled =
        journey.status === 'NO_SERVICE' ||
        s?.display_informations?.status === 'DELETED';

      // Numéro de train
      let numTrain = s?.display_informations?.headsign || 
                     s?.display_informations?.trip_short_name || 
                     s?.display_informations?.code || '';
      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      let retardLabel = "À l'heure";
      if (isCancelled) {
        retardLabel = "Supprimé";
      } else if (retardMinutes > 0) {
        retardLabel = `+${retardMinutes} min`;
      } else if (causePerturbation) {
        retardLabel = "Perturbé";
      }

      return {
        depart: `${heureDep}:${minDep}`,
        arrivee: `${heureArr}:${minArr}`,
        rawDeparture: depReel || depTheorique,
        duree: Math.round(journey.duration / 60) + ' min',
        voie: null,
        numero: numTrainPure || numTrain,
        retard: retardLabel,
        estEnRetard: retardMinutes > 0 || isCancelled || causePerturbation !== null,
      };
    });

    return new Response(
      JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: filteredTrains.length >= 4,
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
