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

  // 1. Requête itinéraire (Navitia journeys)
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=10&max_nb_transfers=0&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;

  // 2. Requête tableau des départs temps réel de la gare (contient les quais/voies)
  const departuresUrl = `https://api.sncf.com/v1/coverage/sncf/stop_areas/${depart}/departures?datetime=${dateSNCF}&count=20`;

  try {
    const [sncfRes, depRes] = await Promise.all([
      fetch(sncfUrl, { headers: { Authorization: authHeader } }),
      fetch(departuresUrl, { headers: { Authorization: authHeader } }).catch(() => null)
    ]);

    const data = await sncfRes.json();
    let departuresList = [];
    if (depRes && depRes.ok) {
      const depData = await depRes.json();
      departuresList = depData.departures || [];
    }

    if (!data.journeys || data.journeys.length === 0) {
      return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Filtrage strict : TER uniquement
    const terOnlyTrains = data.journeys.filter((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      if (!s) return false;
      const info = s.display_informations;
      if (!info) return false;

      const commercial = (info.commercial_mode || '').toLowerCase();
      const physical = (info.physical_mode || '').toLowerCase();
      const headsign = (info.headsign || '').toLowerCase();

      if (physical.includes('coach') || physical.includes('bus') || commercial.includes('car')) return false;
      if (commercial.includes('intercité') || commercial.includes('intercite') || headsign.startsWith('44') || headsign.startsWith('45')) return false;

      return true;
    });

    const selectedJourneys = terOnlyTrains.slice(0, 4);

    const trains = selectedJourneys.map((journey) => {
      const rawDep = journey.departure_date_time;
      const heureDep = rawDep.substring(9, 11);
      const minDep = rawDep.substring(11, 13);

      const rawArr = journey.arrival_date_time;
      const heureArr = rawArr.substring(9, 11);
      const minArr = rawArr.substring(11, 13);

      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];

      // Calcul retard
      const theorie = s?.base_departure_date_time;
      const reel = s?.departure_date_time;
      let retardMinutes = 0;

      if (theorie && reel && theorie !== reel) {
        const dtTheorie = new Date(
          theorie.substring(0, 4), theorie.substring(4, 6) - 1, theorie.substring(6, 8),
          theorie.substring(9, 11), theorie.substring(11, 13), theorie.substring(13, 15)
        );
        const dtReel = new Date(
          reel.substring(0, 4), reel.substring(4, 6) - 1, reel.substring(6, 8),
          reel.substring(9, 11), reel.substring(11, 13), reel.substring(13, 15)
        );
        retardMinutes = Math.round((dtReel - dtTheorie) / 60000);
      }

      // Numéro de train
      let numTrain = s?.display_informations?.headsign || 
                     s?.display_informations?.trip_short_name || 
                     s?.display_informations?.code || '';

      // Recherche de quai :
      // 1. Directement dans l'objet section s'il existe
      let quai = s?.display_informations?.platform || null;

      // 2. Sinon, croisement avec le flux departures de la gare
      if (!quai && departuresList.length > 0) {
        const matchDep = departuresList.find((d) => {
          const depHead = d.display_informations?.headsign;
          const depTrip = d.display_informations?.trip_short_name;
          const depTime = d.stop_date_time?.departure_date_time;

          const sameNum = numTrain && (numTrain === depHead || numTrain === depTrip);
          const sameTime = depTime && depTime.substring(0, 13) === rawDep.substring(0, 13);

          return sameNum || sameTime;
        });

        if (matchDep) {
          quai = matchDep.display_informations?.platform ||
                 matchDep.stop_point?.platform ||
                 null;
          
          if (!quai) {
            const label = matchDep.stop_point?.label || matchDep.stop_point?.name || '';
            const matchVoie = label.match(/voie\s+([a-zA-Z0-9]+)/i);
            if (matchVoie) quai = matchVoie[1];
          }
        }
      }

      if (quai) {
        quai = String(quai).replace(/^Voie\s*/i, '').trim();
      }

      return {
        depart: `${heureDep}:${minDep}`,
        arrivee: `${heureArr}:${minArr}`,
        rawDeparture: rawDep,
        duree: Math.round(journey.duration / 60) + ' min',
        voie: quai ? `Voie ${quai}` : null,
        numero: numTrain,
        retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
        estEnRetard: retardMinutes > 0,
      };
    });

    return new Response(
      JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: terOnlyTrains.length >= 4,
      }),
      {
        headers: { 'content-type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Erreur de connexion' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
