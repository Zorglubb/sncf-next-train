// api/garmin.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');

  // Gares
  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';

  // Heure de Paris pour bascule auto
  const optionsDate = { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false };
  const currentHour = parseInt(new Intl.DateTimeFormat('fr-FR', optionsDate).format(new Date()), 10);

  let depart, arrivee, destination;

  if (currentHour >= 4 && currentHour < 13) {
    depart = GARE_VIERZON;
    arrivee = GARE_BOURGES;
    destination = "Bourges";
  } else {
    depart = GARE_BOURGES;
    arrivee = GARE_VIERZON;
    destination = "Vierzon";
  }

  if (dirParam === 'vierzon') {
    depart = GARE_BOURGES;
    arrivee = GARE_VIERZON;
    destination = "Vierzon";
  } else if (dirParam === 'bourges') {
    depart = GARE_VIERZON;
    arrivee = GARE_BOURGES;
    destination = "Bourges";
  }

  const now = new Date();
  const dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
  const sncfUrl = `https://api.sncf.com/v1/coverage/sncf/journeys?from=${depart}&to=${arrivee}&datetime=${dateSNCF}&count=8&max_nb_transfers=0&forbidden_uris[]=physical_mode:Coach&forbidden_uris[]=physical_mode:Bus`;

  try {
    const res = await fetch(sncfUrl, {
      headers: {
        'Authorization': 'Basic ' + btoa(process.env.SNCF_API_KEY + ':')
      }
    });

    const data = await res.json();

    if (!data.journeys || data.journeys.length === 0) {
      return new Response(JSON.stringify({ dest: destination, trains: [] }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    // Filtrer les autocars et les intercités
    const terTrains = data.journeys.filter(journey => {
      const s = journey.sections?.find(sec => sec.type === 'public_transport') || journey.sections?.[0];
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

    const selected = terTrains.slice(0, 3);

    const trains = selected.map(j => {
      const d = j.departure_date_time;
      const a = j.arrival_date_time;
      const s = j.sections?.find(sec => sec.type === 'public_transport') || j.sections?.[0];

      const theorie = s?.base_departure_date_time;
      const reel = s?.departure_date_time;
      let retard = 0;

      if (theorie && reel && theorie !== reel) {
        const dtTh = new Date(
          theorie.substring(0,4), theorie.substring(4,6)-1, theorie.substring(6,8),
          theorie.substring(9,11), theorie.substring(11,13), theorie.substring(13,15)
        );
        const dtRe = new Date(
          reel.substring(0,4), reel.substring(4,6)-1, reel.substring(6,8),
          reel.substring(9,11), reel.substring(11,13), reel.substring(13,15)
        );
        retard = Math.round((dtRe - dtTh) / 60000);
      }

      return {
        dep: `${d.substring(9,11)}:${d.substring(11,13)}`,
        arr: `${a.substring(9,11)}:${a.substring(11,13)}`,
        dur: `${Math.round(j.duration / 60)}m`,
        ret: retard > 0 ? `+${retard}m` : "OK",
        late: retard > 0
      };
    });

    return new Response(JSON.stringify({
      dest: destination,
      trains: trains
    }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=30'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: true }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}
