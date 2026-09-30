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
  
  // 2. Bascule selon l'heure
  const optionsDate = { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false };
  const currentHour = parseInt(new Intl.DateTimeFormat('fr-FR', optionsDate).format(new Date()), 10);
  
  let departStopArea, arriveeStopArea, destinationLabel;

  if (currentHour >= 4 && currentHour < 13) {
      departStopArea = GARE_VIERZON;
      arriveeStopArea = GARE_BOURGES;
      destinationLabel = "Bourges";
  } else {
      departStopArea = GARE_BOURGES;
      arriveeStopArea = GARE_VIERZON;
      destinationLabel = "Vierzon";
  }

  if (dirParam === 'vierzon') {
      departStopArea = GARE_BOURGES;
      arriveeStopArea = GARE_VIERZON;
      destinationLabel = "Vierzon";
  } else if (dirParam === 'bourges') {
      departStopArea = GARE_VIERZON;
      arriveeStopArea = GARE_BOURGES;
      destinationLabel = "Bourges";
  }

  // 3. Date / Heure
  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
      const now = new Date();
      dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
  }

  // Requête directe sur le tableau des départs (beaucoup plus rapide que /journeys)
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/stop_areas/${departStopArea}/departures?from_datetime=${dateSNCF}&count=15&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;
  
  try {
    const sncfResponse = await fetch(sncfUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(process.env.SNCF_API_KEY + ':')
      }
    });

    const data = await sncfResponse.json();

    if (!data.departures || data.departures.length === 0) {
        return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
          headers: { 'content-type': 'application/json' }
        });
    }

    // Filtrer les départs pour ne garder que ceux qui s'arrêtent ou vont vers la gare d'arrivée voulue,
    // et exclure les cars/bus
    const relevantDepartures = data.departures.filter(dep => {
        const info = dep.display_informations;
        if (!info) return false;

        const isBusOrCoach = 
            info.physical_mode?.toLowerCase().includes('coach') ||
            info.physical_mode?.toLowerCase().includes('car') ||
            info.physical_mode?.toLowerCase().includes('bus') ||
            info.commercial_mode?.toLowerCase().includes('car') ||
            info.commercial_mode?.toLowerCase().includes('autocar');
        if (isBusOrCoach) return false;

        // Vérifier la destination ou le sens de circulation
        const directionStr = (info.direction || '').toLowerCase();
        const routeLabel = (dep.route?.name || '').toLowerCase();
        const searchTarget = destinationLabel.toLowerCase();

        return directionStr.includes(searchTarget) || 
               routeLabel.includes(searchTarget) ||
               (destinationLabel === "Bourges" && (directionStr.includes("nevers") || directionStr.includes("lyon") || directionStr.includes("montluçon"))) ||
               (destinationLabel === "Vierzon" && (directionStr.includes("paris") || directionStr.includes("orléans") || directionStr.includes("tours") || directionStr.includes("nantes")));
    });

    const selectedDepartures = relevantDepartures.slice(0, 4);

    const trains = selectedDepartures.map(dep => {
        const rawTime = dep.stop_date_time?.departure_date_time || dep.stop_date_time?.base_departure_date_time;
        const heure = rawTime.substring(9, 11);
        const minute = rawTime.substring(11, 13);

        const theorie = dep.stop_date_time?.base_departure_date_time;
        const reel = dep.stop_date_time?.departure_date_time;
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

        // Récupération de la voie / quai si disponible
        const quai = dep.stop_point?.label?.match(/voie\s+([a-zA-Z0-9]+)/i)?.[0] || 
                     dep.display_informations?.platform || 
                     null;

        return {
            depart: `${heure}:${minute}`,
            rawDeparture: rawTime,
            voie: quai,
            numero: dep.display_informations?.headsign || dep.display_informations?.code || '',
            retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
            estEnRetard: retardMinutes > 0
        };
    });

    return new Response(JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: relevantDepartures.length >= 4
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
