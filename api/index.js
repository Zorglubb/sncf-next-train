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

      // Exclusion bus et cars
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

      // Écarter les Intercités nationaux (44xx, 45xx)
      if (commercial.includes('intercit') || network.includes('intercit') || num.startsWith('44') || num.startsWith('45')) {
        return false;
      }

      return true;
    });

    const selectedJourneys = filteredTrains.slice(0, 4);

    // Fonction d'analyse robuste compatible avec tous les formats de date SNCF
    const parseSncfDate = (str) => {
      if (!str) return null;
      const clean = str.replace(/[-:]/g, '');
      if (clean.length < 15) return null;
      const year = parseInt(clean.substring(0, 4), 10);
      const month = parseInt(clean.substring(4, 6), 10) - 1;
      const day = parseInt(clean.substring(6, 8), 10);
      const hour = parseInt(clean.substring(9, 11), 10);
      const min = parseInt(clean.substring(11, 13), 10);
      const sec = parseInt(clean.substring(13, 15), 10);
      return new Date(year, month, day, hour, min, sec);
    };

    const trains = selectedJourneys.map((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      const firstStop = s?.stop_date_times?.[0];

      // Extraction de l'heure brute
      const rawDep = journey.departure_date_time || s?.departure_date_time || firstStop?.departure_date_time;
      const depDate = parseSncfDate(rawDep);

      let heureDep = '00';
      let minDep = '00';
      if (depDate) {
        heureDep = String(depDate.getHours()).padStart(2, '0');
        minDep = String(depDate.getMinutes()).padStart(2, '0');
      }
      const heureAffichee = `${heureDep}:${minDep}`;

      const rawArr = journey.arrival_date_time || s?.arrival_date_time;
      const arrDate = parseSncfDate(rawArr);
      let heureArr = '00';
      let minArr = '00';
      if (arrDate) {
        heureArr = String(arrDate.getHours()).padStart(2, '0');
        minArr = String(arrDate.getMinutes()).padStart(2, '0');
      }

      // 1. Calcul du retard par comparaison théorique / réel
      const thStr = journey.base_departure_date_time || s?.base_departure_date_time || firstStop?.base_departure_date_time;
      const reStr = journey.departure_date_time || s?.departure_date_time || firstStop?.departure_date_time;

      let retardMinutes = 0;
      if (thStr && reStr && thStr !== reStr) {
        const dtTh = parseSncfDate(thStr);
        const dtRe = parseSncfDate(reStr);
        if (dtTh && dtRe) {
          const diffMs = dtRe.getTime() - dtTh.getTime();
          if (diffMs > 0) {
            retardMinutes = Math.round(diffMs / 60000);
          }
        }
      }

      // 2. Recherche dans les perturbations / disruptions (ex. régulation de trafic)
      let motifPerturbation = null;
      const disruptionIds = [
        ...(journey.disruption_ids || []),
        ...(s?.display_informations?.disruption_ids || [])
      ];

      if (disruptionIds.length > 0) {
        disruptionIds.forEach((id) => {
          const dObj = disruptionsList.find((item) => item.id === id);
          if (dObj) {
            const textContent = (dObj.messages || []).map((m) => m.text).join(' ');
            
            // Capture les mentions textuelles de retard
            const matchMin = textContent.match(/retard(?:\s+estim[ée])?(?:\s+[àa])?\s*(\d+)\s*m/i) ||
                             textContent.match(/\+(\d+)\s*m/i);
            if (matchMin) {
              const rMin = parseInt(matchMin[1], 10);
              if (rMin > retardMinutes) retardMinutes = rMin;
            }

            if (dObj.cause) {
              motifPerturbation = dObj.cause;
            }
          }
        });
      }

      // Statut supprimé
      const isCancelled =
        journey.status === 'NO_SERVICE' ||
        s?.display_informations?.status === 'DELETED' ||
        (s?.display_informations?.headsign || '').toLowerCase().includes('supprim');

      // Numéro de train
      let numTrain = s?.display_informations?.headsign || 
                     s?.display_informations?.trip_short_name || 
                     s?.display_informations?.code || '';
      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      // Voie si disponible
      let quai = s?.display_informations?.platform || s?.from?.stop_point?.platform || null;
      if (quai) {
        quai = String(quai).replace(/^Voie\s*/i, '').trim();
        quai = quai ? `Voie ${quai}` : null;
      }

      let retardLabel = "À l'heure";
      if (isCancelled) {
        retardLabel = "Supprimé";
      } else if (retardMinutes > 0) {
        retardLabel = `+${retardMinutes} min`;
      } else if (motifPerturbation) {
        retardLabel = "Perturbé";
      }

      return {
        depart: heureAffichee,
        arrivee: `${heureArr}:${minArr}`,
        rawDeparture: rawDep,
        duree: Math.round(journey.duration / 60) + ' min',
        voie: quai,
        numero: numTrainPure || numTrain,
        retard: retardLabel,
        estEnRetard: retardMinutes > 0 || isCancelled || motifPerturbation !== null,
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
