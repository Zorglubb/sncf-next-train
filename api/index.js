// api/index.js

export const config = {
  runtime: 'edge',
  regions: ['cdg1'],
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const dirParam = searchParams.get('dir');
  const fromDatetime = searchParams.get('from_datetime');

  const GARE_VIERZON = 'stop_area:SNCF:87576009';
  const GARE_BOURGES = 'stop_area:SNCF:87576207';

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

  let dateSNCF = fromDatetime;
  if (!dateSNCF) {
    const now = new Date();
    dateSNCF = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const authHeader = 'Basic ' + btoa(process.env.SNCF_API_KEY + ':');
  // data_freshness=realtime force l'extraction immédiate des retards et incidents
  const departuresUrl = `https://api.sncf.com/v1/coverage/sncf/stop_areas/${depart}/departures?datetime=${dateSNCF}&count=30&data_freshness=realtime`;

  try {
    const res = await fetch(departuresUrl, {
      headers: { Authorization: authHeader },
    });

    const data = await res.json();
    const departures = data.departures || [];

    if (departures.length === 0) {
      return new Response(JSON.stringify({ destination: destinationLabel, trains: [], hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const parseSncfDate = (str) => {
      if (!str) return null;
      const clean = str.replace(/[-:]/g, '');
      if (clean.length < 15) return null;
      return new Date(
        parseInt(clean.substring(0, 4), 10),
        parseInt(clean.substring(4, 6), 10) - 1,
        parseInt(clean.substring(6, 8), 10),
        parseInt(clean.substring(9, 11), 10),
        parseInt(clean.substring(11, 13), 10),
        parseInt(clean.substring(13, 15), 10)
      );
    };

    // Filtrer les départs vers la destination souhaitée
    const targetTrains = departures.filter((dep) => {
      const info = dep.display_informations;
      if (!info) return false;

      const physical = (info.physical_mode || '').toLowerCase();
      const commercial = (info.commercial_mode || '').toLowerCase();
      const direction = (info.direction || '').toLowerCase();
      const headsign = (info.headsign || '').trim();
      const tripShort = (info.trip_short_name || '').trim();

      // Vérifier si le train dessert la destination
      const isGoodDirection = direction.includes(destinationLabel.toLowerCase());
      if (!isGoodDirection) return false;

      // Exclusion bus et cars
      if (physical.includes('coach') || physical.includes('bus') || commercial.includes('car')) {
        return false;
      }

      let num = headsign;
      if (!/^\d+$/.test(num)) num = tripShort;
      if (!/^\d+$/.test(num)) {
        const m = (dep.links?.find((l) => l.type === 'vehicle_journey')?.id || '').match(/(\d{4,6})/);
        num = m ? m[1] : '';
      }

      // Conserver les Rémi Express (39xx)
      if (num.startsWith('39')) return true;

      // Écarter les Intercités nationaux (44xx, 45xx)[span_1](start_span)[span_1](end_span)
      if (commercial.includes('intercit') || num.startsWith('44') || num.startsWith('45')) {
        return false;
      }

      return true;
    });

    const selectedDepartures = targetTrains.slice(0, 4);

    const trains = selectedDepartures.map((dep) => {
      const info = dep.display_informations || {};
      const stopDateTime = dep.stop_date_time || {};

      const rawBaseDep = stopDateTime.base_departure_date_time;
      const rawRealDep = stopDateTime.departure_date_time;

      const baseDate = parseSncfDate(rawBaseDep || rawRealDep);
      let heureDep = '00';
      let minDep = '00';
      if (baseDate) {
        heureDep = String(baseDate.getHours()).padStart(2, '0');
        minDep = String(baseDate.getMinutes()).padStart(2, '0');
      }

      // Calcul direct du retard en minutes
      let retardMinutes = 0;
      if (rawBaseDep && rawRealDep && rawBaseDep !== rawRealDep) {
        const dtTh = parseSncfDate(rawBaseDep);
        const dtRe = parseSncfDate(rawRealDep);
        if (dtTh && dtRe) {
          const diff = Math.round((dtRe.getTime() - dtTh.getTime()) / 60000);
          if (diff > 0) retardMinutes = diff;
        }
      }

      // Détection retard dans les messages de perturbation
      const disruptionList = data.disruptions || [];
      const dIds = dep.disruption_ids || [];
      let isPerturbed = false;

      for (const id of dIds) {
        const dObj = disruptionList.find((item) => item.id === id);
        if (dObj) {
          const msg = (dObj.messages || []).map((m) => m.text).join(' ');
          const matchMin = msg.match(/(\d+)\s*(?:min|mn)/i);
          if (matchMin) {
            const val = parseInt(matchMin[1], 10);
            if (val > retardMinutes) retardMinutes = val;
          }
          isPerturbed = true;
        }
      }

      const isCancelled =
        dep.status === 'NO_SERVICE' ||
        info.status === 'DELETED' ||
        (info.headsign || '').toLowerCase().includes('supprim');

      let numTrain = info.headsign || info.trip_short_name || '';
      const numMatch = numTrain.match(/\d{4,6}/);
      const numTrainPure = numMatch ? numMatch[0] : numTrain;

      let retardLabel = "À l'heure";
      if (isCancelled) {
        retardLabel = "Supprimé";
      } else if (retardMinutes > 0) {
        retardLabel = `+${retardMinutes} min`;
      } else if (isPerturbed) {
        retardLabel = "Perturbé";
      }

      return {
        depart: `${heureDep}:${minDep}`,
        arrivee: '--:--',
        rawDeparture: rawRealDep || rawBaseDep,
        duree: '',
        voie: null,
        numero: numTrainPure || numTrain,
        retard: retardLabel,
        estEnRetard: retardMinutes > 0 || isCancelled || isPerturbed,
      };
    });

    return new Response(
      JSON.stringify({
        destination: destinationLabel,
        trains: trains,
        hasMore: targetTrains.length >= 4,
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
