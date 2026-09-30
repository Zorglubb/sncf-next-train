// api/index.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');
  const fromDatetime = searchParams.get('from_datetime');

  // 1. Gares
  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';
  
  // 2. Bascule selon l'heure
  const optionsDate = { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false };
  const currentHour = parseInt(new Intl.DateTimeFormat('fr-FR', optionsDate).format(new Date()), 10);
  
  let depart, arrivee, destinationLabel;

  if (currentHour >= 4 && currentHour < 13) {
      depart = GARE_VIERZON;
      arrivee = GARE_BOURGES;
      destinationLabel = "Bourges";
  } else {
      depart = GARE_BOURGES;
      arrivee = GARE_VIERZON;
      destinationLabel = "Vierzon";
  }

  if (dirParam === 'vierzon') {
      depart = GARE_BOURGES;
      arrivee = GARE_VIERZON;
      destinationLabel = "Vierzon";
  } else if (dirParam === 'bourges') {
      depart = GARE_VIERZON;
      arrivee = GARE_BOURGES;
      destinationLabel = "Bourges";
  }

  // 3. Date / Heure
  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
      const now = new Date();
      dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
  }

  // Exclusion des autocars et bus à la source + trains directs uniquement
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=6&max_nb_transfers=0&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;
  
  try {
    const sncfResponse = await fetch(sncfUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(process.env.SNCF_API_KEY + ':')
      }
    });

    const data = await sncfResponse.json();

    if (!data.journeys || data.journeys.length === 0) {
        return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
          headers: { 'content-type': 'application/json' }
        });
    }

    // Filtrage strict : éliminer tout autocar résiduel
    const realTrains = data.journeys.filter(journey => {
        const isCoach = journey.sections?.some(s => 
            s.display_informations?.physical_mode?.toLowerCase().includes('coach') ||
            s.display_informations?.physical_mode?.toLowerCase().includes('car') ||
            s.display_informations?.physical_mode?.toLowerCase().includes('autocar') ||
            s.display_informations?.commercial_mode?.toLowerCase().includes('car') ||
            s.display_informations?.commercial_mode?.toLowerCase().includes('autocar')
        );
        return !isCoach;
    });

    // On ne garde que les 4 premiers après filtrage
    const selectedJourneys = realTrains.slice(0, 4);

    const trains = selectedJourneys.map(journey => {
        const rawTime = journey.departure_date_time;
        const heure = rawTime.substring(9, 11);
        const minute = rawTime.substring(11, 13);

        const rawArrival = journey.arrival_date_time;
        const heureArr = rawArrival.substring(9, 11);
        const minArr = rawArrival.substring(11, 13);

        const departureIsoRaw = rawTime;

        // Calcul du retard
        const theorie = journey.sections?.[0]?.base_departure_date_time;
        const reel = journey.sections?.[0]?.departure_date_time;
        let retardMinutes = 0;
        
        if (theorie && reel && theorie !== reel) {
            const dtTheorie = new Date(
              theorie.substring(0,4), theorie.substring(4,6)-1, theorie.substring(6,8),
              theorie.substring(9,11), theorie.substring(11,13), theorie.substring(13,15)
            );
            const dtReel = new Date(
              reel.substring(0,4), reel.substring(4,6)-1, reel.substring(6,8),
              reel.substring(9,11), reel.substring(11,13), reel.substring(13,15)
            );
            retardMinutes = Math.round((dtReel - dtTheorie) / 60000);
        }

        return {
            depart: `${heure}:${minute}`,
            arrivee: `${heureArr}:${minArr}`,
            rawDeparture: departureIsoRaw,
            retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
            estEnRetard: retardMinutes > 0,
            duree: Math.round(journey.duration / 60) + " min"
        };
    });

    return new Response(JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: realTrains.length >= 4
    }), {
      headers: { 'content-type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: "Erreur de connexion" }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}
