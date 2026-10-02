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

    const filteredTrains = data.journeys.filter((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      if (!s) return false;
      const info = s.display_informations;
      if (!info) return false;

      const physical = (info.physical_mode || '').toLowerCase();
      const commercial = (info.commercial_mode || '').toLowerCase();
      const headsign = (info.headsign || '').trim();
      const tripShort = (info.trip_short_name || '').trim();

      // 1. Rejeter autocars / bus
      if (physical.includes('coach') || physical.includes('bus') || commercial.includes('car')) {
        return false;
      }

      // 2. Extraire le numéro de train
      let num = headsign;
      if (!/^\d+$/.test(num)) {
        num = tripShort;
      }
      if (!/^\d+$/.test(num)) {
        const match = (s.id || '').match(/(\d{4,6})/);
        num = match ? match[1] : '';
      }

      // 3. Accepter explicitement les Rémi Express (ligne Paris-Bourges série 39xx)
      if (num.startsWith('39')) {
        return true;
      }

      // 4. Bloquer les vrais Intercités nationaux (Nantes - Lyon : séries 44xx et 45xx)
      if (num.startsWith('44') || num.startsWith('45')) {
        return false;
      }

      // 5. Bloquer tout train dont le label commercial est strictement "intercités" sauf s'il s'agit d'un 39xx
      if (commercial.includes('intercit') && !num.startsWith('39')) {
        return false;
      }

      return true;
    });

    const selectedJourneys = filteredTrains.slice(0, 4);

    const trains = selectedJourneys.map((journey) => {
      const rawDep = journey.departure_date_time;
      const heureDep = rawDep.substring(9, 11);
      const minDep = rawDep.substring(11, 13);
      const heureExacte = `${heureDep}:${minDep}`;

      const rawArr = journey.arrival_date_time;
      const heureArr = rawArr.substring(9, 11);
      const minArr = rawArr.substring(11, 13);

      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];

      // Retard
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

      let numTrain = s?.display_informations?.headsign || 
                     s?.display_informations?.trip_short_name || 
                     s?.display_informations?.code || '';

      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      let quai = s?.display_informations?.platform || s?.from?.stop_point?.platform || null;
      if (quai) {
        quai = String(quai).replace(/^Voie\s*/i, '').trim();
        quai = quai ? `Voie ${quai}` : null;
      }

      return {
        depart: heureExacte,
        arrivee: `${heureArr}:${minArr}`,
        rawDeparture: rawDep,
        duree: Math.round(journey.duration / 60) + ' min',
        voie: quai,
        numero: numTrainPure || numTrain,
        retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
        estEnRetard: retardMinutes > 0,
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
