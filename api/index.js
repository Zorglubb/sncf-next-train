// api/index.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');
  const fromDatetime = searchParams.get('from_datetime');
  const debugMode = searchParams.get('debug') === '1';

  // Gares SNCF
  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';
  const NOM_VIERZON = 'Vierzon';
  const NOM_BOURGES = 'Bourges';

  // Bascule selon l'heure (Europe/Paris)
  const optionsDate = { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false };
  const currentHour = parseInt(new Intl.DateTimeFormat('fr-FR', optionsDate).format(new Date()), 10);

  let depart, arrivee, destinationLabel, gareOrigineNom;

  if (currentHour >= 4 && currentHour < 13) {
    depart = GARE_VIERZON;
    arrivee = GARE_BOURGES;
    destinationLabel = 'Bourges';
    gareOrigineNom = NOM_VIERZON;
  } else {
    depart = GARE_BOURGES;
    arrivee = GARE_VIERZON;
    destinationLabel = 'Vierzon';
    gareOrigineNom = NOM_BOURGES;
  }

  if (dirParam === 'vierzon') {
    depart = GARE_BOURGES;
    arrivee = GARE_VIERZON;
    destinationLabel = 'Vierzon';
    gareOrigineNom = NOM_BOURGES;
  } else if (dirParam === 'bourges') {
    depart = GARE_VIERZON;
    arrivee = GARE_BOURGES;
    destinationLabel = 'Bourges';
    gareOrigineNom = NOM_VIERZON;
  }

  // Date / Heure
  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
    const now = new Date();
    dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const authHeader = 'Basic ' + btoa(process.env.SNCF_API_KEY + ':');

  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=10&max_nb_transfers=0&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;
  const pacoUrl = `https://data.sncf.com/api/explore/v2.1/catalog/datasets/table-affichage-gares-departs/records?q=${encodeURIComponent(gareOrigineNom)}&limit=50`;

  try {
    const [sncfRes, pacoRes] = await Promise.all([
      fetch(sncfUrl, { headers: { Authorization: authHeader } }),
      fetch(pacoUrl).catch(() => null)
    ]);

    const data = await sncfRes.json();

    let pacoList = [];
    if (pacoRes && pacoRes.ok) {
      const pacoData = await pacoRes.json();
      pacoList = pacoData.results || [];
    }

    if (!data.journeys || data.journeys.length === 0) {
      return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Filtrage : trains uniquement (TER, Rémi Express 39xx inclus, exclusion stricte des bus/cars)
    const validTrains = data.journeys.filter((journey) => {
      const s = journey.sections?.find((sec) => sec.type === 'public_transport') || journey.sections?.[0];
      if (!s) return false;
      const info = s.display_informations;
      if (!info) return false;

      const commercial = (info.commercial_mode || '').toLowerCase();
      const physical = (info.physical_mode || '').toLowerCase();

      const isCoachOrBus = physical.includes('coach') || physical.includes('bus') || commercial.includes('car');
      return !isCoachOrBus;
    });

    const selectedJourneys = validTrains.slice(0, 4);

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

      // Numéro de train
      let numTrain = s?.display_informations?.headsign || 
                     s?.display_informations?.trip_short_name || 
                     s?.display_informations?.code || '';

      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      // Recherche de la voie
      let quaiTrouve = s?.display_informations?.platform || null;

      if (!quaiTrouve && pacoList.length > 0) {
        const matchPaco = pacoList.find((p) => {
          const pNum = String(p.num || '').trim();
          const pHeure = String(p.heure || '').trim();
          
          const matchNum = numTrainPure && pNum === numTrainPure;
          const matchHoraire = pHeure.startsWith(heureExacte);
          return matchNum || matchHoraire;
        });

        if (matchPaco && matchPaco.voie) {
          quaiTrouve = matchPaco.voie;
        }
      }

      let quaiPropre = null;
      if (quaiTrouve) {
        quaiPropre = String(quaiTrouve).replace(/^Voie\s*/i, '').trim();
        quaiPropre = quaiPropre ? `Voie ${quaiPropre}` : null;
      }

      return {
        depart: heureExacte,
        arrivee: `${heureArr}:${minArr}`,
        rawDeparture: rawDep,
        duree: Math.round(journey.duration / 60) + ' min',
        voie: quaiPropre,
        numero: numTrainPure || numTrain,
        retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
        estEnRetard: retardMinutes > 0,
      };
    });

    if (debugMode) {
      return new Response(JSON.stringify({
        gareOrigine: gareOrigineNom,
        pacoCount: pacoList.length,
        pacoRecords: pacoList.map(p => ({ num: p.num, heure: p.heure, voie: p.voie, destination: p.origdest })),
        trains
      }, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: validTrains.length >= 4,
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
