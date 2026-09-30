// api/index.js

export default async function handler(req, res) {
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

  if (req.query.dir === 'vierzon') {
      depart = GARE_BOURGES;
      arrivee = GARE_VIERZON;
      destinationLabel = "Vierzon";
  } else if (req.query.dir === 'bourges') {
      depart = GARE_VIERZON;
      arrivee = GARE_BOURGES;
      destinationLabel = "Bourges";
  }

  // Nombre de trains demandé (4 par défaut, ou la valeur passée dans l'URL)
  const count = parseInt(req.query.count, 10) || 4;

  // 3. Appel API SNCF
  const now = new Date();
  const dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=${count}`;
  
  try {
    const sncfResponse = await fetch(sncfUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.SNCF_API_KEY + ':').toString('base64')
      }
    });

    const data = await sncfResponse.json();

    if (!data.journeys || data.journeys.length === 0) {
        return res.status(200).json({ error: "Aucun train trouvé pour le moment" });
    }

    const trains = data.journeys.map(journey => {
        const rawTime = journey.departure_date_time;
        const heure = rawTime.substring(9, 11);
        const minute = rawTime.substring(11, 13);

        const rawArrival = journey.arrival_date_time;
        const heureArr = rawArrival.substring(9, 11);
        const minArr = rawArrival.substring(11, 13);

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
            retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
            estEnRetard: retardMinutes > 0,
            duree: Math.round(journey.duration / 60) + " min"
        };
    });

    return res.status(200).json({
        destination: destinationLabel,
        trains: trains
    });

  } catch (error) {
    return res.status(500).json({ error: "Erreur lors de la récupération des trains" });
  }
}
