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
  const departuresUrl = `https://api.sncf.com/v1/coverage/sncf/stop_areas/${depart}/departures?datetime=${dateSNCF}&count=25`;
  const pacoUrl = `https://data.sncf.com/api/explore/v2.1/catalog/datasets/table-affichage-gares-departs/records?where=suggest(gare%2C%20%22${encodeURIComponent(gareOrigineNom)}%22)&limit=40`;

  try {
    const [sncfRes, depRes, pacoRes] = await Promise.all([
      fetch(sncfUrl, { headers: { Authorization: authHeader } }),
      fetch(departuresUrl, { headers: { Authorization: authHeader } }).catch(() => null),
      fetch(pacoUrl).catch(() => null)
    ]);

    const data = await sncfRes.json();

    let departuresList = [];
    if (depRes && depRes.ok) {
      const depData = await depRes.json();
      departuresList = depData.departures || [];
    }

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

      // Nettoyer pour n'avoir que les chiffres (ex: "861412")
      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      // RECHERCHE DE LA VOIE :
      let quaiTrouve = null;

      // Source 1 : Section directe
      if (s?.display_informations?.platform) {
        quaiTrouve = s.display_informations.platform;
      }

      // Source 2 : Table des départs Navitia
      if (!quaiTrouve && departuresList.length > 0) {
        const depMatch = departuresList.find((d) => {
          const dHead = d.display_informations?.headsign || '';
          const dTrip = d.display_informations?.trip_short_name || '';
          const dTime = d.stop_date_time?.departure_date_time || '';
          return (numTrainPure && (dHead.includes(numTrainPure) || dTrip.includes(numTrainPure))) ||
                 (dTime.substring(9, 13) === rawDep.substring(9, 13));
        });

        if (depMatch) {
          quaiTrouve = depMatch.display_informations?.platform ||
                       depMatch.stop_point?.platform || null;
        }
      }

      // Source 3 : Panneaux d'affichage en gare Gares & Connexions
      if (!quaiTrouve && pacoList.length > 0) {
        const pacoMatch = pacoList.find((p) => {
          const pNum = String(p.num || '').trim();
          const pHeure = String(p.heure || '').trim();
          return (numTrainPure && pNum === numTrainPure) || pHeure.startsWith(heureExacte);
        });

        if (pacoMatch && pacoMatch.voie) {
          quaiTrouve = pacoMatch.voie;
        }
      }

      // Formatage final
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
        gareOrigineNom,
        pacoRecordsFound: pacoList.length,
        pacoSample: pacoList.slice(0, 3),
        departuresFound: departuresList.length,
        departuresSample: departuresList.slice(0, 2).map(d => ({
          headsign: d.display_informations?.headsign,
          platform: d.display_informations?.platform,
          stop_platform: d.stop_point?.platform
        })),
        trains
      }, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

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
    return new Response(JSON.stringify({ error: error.message || 'Erreur de connexion' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
