// api/index.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');
  const fromDatetime = searchParams.get('from_datetime');

  // 1. Identifiants des gares
  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';

  // 2. Bascule selon l'heure (Europe/Paris)
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

  // 3. Date / Heure
  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
    const now = new Date();
    dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=10&max_nb_transfers=0&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;

  try {
    const sncfResponse = await fetch(sncfUrl, {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + btoa(process.env.SNCF_API_KEY + ':'),
      },
    });

    const data = await sncfResponse.json();

    if (!data.journeys || data.journeys.length === 0) {
      return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Filtrage strict : TER uniquement (exclusion cars/bus et Intercités)
    const terOnlyTrains = data.journeys.filter((journey) => {
      const trainSection = journey.sections?.find((s) => s.type === 'public_transport') || journey.sections?.[0];
      if (!trainSection) return false;

      const info = trainSection.display_informations;
      if (!info) return false;

      const commercial = (info.commercial_mode || '').toLowerCase();
      const physical = (info.physical_mode || '').toLowerCase();
      const network = (info.network || '').toLowerCase();
      const label = (info.label || '').toLowerCase();
      const headsign = (info.headsign || '').toLowerCase();

      const isCoachOrBus = physical.includes('coach') || physical.includes('bus') || commercial.includes('car');
      if (isCoachOrBus) return false;

      const isIntercites =
        commercial.includes('intercité') ||
        commercial.includes('intercite') ||
        network.includes('intercité') ||
        network.includes('intercite') ||
        label.includes('intercité') ||
        headsign.startsWith('44') ||
        headsign.startsWith('45');
      if (isIntercites) return false;

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

      const trainSection = journey.sections?.find((s) => s.type === 'public_transport') || journey.sections?.[0];

      const theorie = trainSection?.base_departure_date_time;
      const reel = trainSection?.departure_date_time;
      let retardMinutes = 0;

      if (theorie && reel && theorie !== reel) {
        const dtTheorie = new Date(
          theorie.substring(0, 4),
          theorie.substring(4, 6) - 1,
          theorie.substring(6, 8),
          theorie.substring(9, 11),
          theorie.substring(11, 13),
          theorie.substring(13, 15)
        );
        const dtReel = new Date(
          reel.substring(0, 4),
          reel.substring(4, 6) - 1,
          reel.substring(6, 8),
          reel.substring(9, 11),
          reel.substring(11, 13),
          reel.substring(13, 15)
        );
        retardMinutes = Math.round((dtReel - dtTheorie) / 60000);
      }

      const quai =
        trainSection?.from?.stop_point?.label?.match(/voie\s+([a-zA-Z0-9]+)/i)?.[0] ||
        trainSection?.display_informations?.platform ||
        null;

      const numTrain =
        trainSection?.display_informations?.headsign ||
        trainSection?.display_informations?.trip_short_name ||
        trainSection?.display_informations?.code ||
        '';

      return {
        depart: `${heureDep}:${minDep}`,
        arrivee: `${heureArr}:${minArr}`,
        rawDeparture: rawDep,
        duree: Math.round(journey.duration / 60) + ' min',
        voie: quai,
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
