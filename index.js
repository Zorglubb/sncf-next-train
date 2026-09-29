// api/index.js

export default async function handler(req, res) {
  // 1. Identifiants exacts des gares
  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';
  
  // 2. Récupération de l'heure actuelle en France
  const optionsDate = { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false };
  const currentHour = parseInt(new Intl.DateTimeFormat('fr-FR', optionsDate).format(new Date()), 10);
  
  let depart, arrivee, destinationLabel;

  // 3. Bascule automatique matin / après-midi
  // Matin (de 04h00 à 12h59) : Vierzon -> Bourges
  // Reste de la journée / Soir (de 13h00 à 03h59) : Bourges -> Vierzon
  if (currentHour >= 4 && currentHour < 13) {
      depart = GARE_VIERZON;
      arrivee = GARE_BOURGES;
      destinationLabel = "Bourges";
  } else {
      depart = GARE_BOURGES;
      arrivee = GARE_VIERZON;
      destinationLabel = "Vierzon";
  }

  // Option : permet de forcer manuellement le sens avec ?dir=bourges ou ?dir=vierzon
  if (req.query.dir === 'vierzon') {
      depart = GARE_BOURGES;
      arrivee = GARE_VIERZON;
      destinationLabel = "Vierzon";
  } else if (req.query.dir === 'bourges') {
      depart = GARE_VIERZON;
      arrivee = GARE_BOURGES;
      destinationLabel = "Bourges";
  }

  // 4. Formatage de la date/heure pour la SNCF (format UTC : AAAAMMJJTHHMMSS)
  const now = new Date();
  const dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}`;
  
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

    const prochainTrain = data.journeys[0];
    
    // Extraction de l'heure de départ prévue/réelle (ex: 20260929T181500)
    const rawTime = prochainTrain.departure_date_time;
    const heure = rawTime.substring(9, 11);
    const minute = rawTime.substring(11, 13);

    // Calcul du retard éventuel en comparant l'horaire théorique et réel
    const theorie = prochainTrain.sections[0]?.base_departure_date_time;
    const reel = prochainTrain.sections[0]?.departure_date_time;
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

    // Réponse au format ultra-léger (idéal pour Garmin ou page web)
    return res.status(200).json({
        destination: destinationLabel,
        depart: `${heure}:${minute}`,
        retard: retardMinutes > 0 ? `+${retardMinutes} min` : "À l'heure",
        duree: Math.round(prochainTrain.duration / 60) + " min"
    });

  } catch (error) {
    return res.status(500).json({ error: "Erreur lors de la récupération des trains" });
  }
}
