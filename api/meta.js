const META_TOKEN = process.env.META_TOKEN;

const ACCOUNTS = {
  nuevo:    'act_299921604429631',   // Portafolio nuevo (activo)
  anterior: 'act_2241343302609141',  // Portafolio anterior (mayor rendimiento)
};

const GRAPH  = 'https://graph.facebook.com/v19.0';
const FIELDS = 'campaign_id,campaign_name,spend,cpc,cpm,impressions,clicks,ctr,reach,actions';

function buildTimeRanges() {
  const now   = new Date();
  const fmt   = d => d.toISOString().slice(0,10);
  const until = new Date(now); until.setDate(until.getDate() - 1);
  const since = new Date(until); since.setDate(since.getDate() - 6);
  const prevUntil = new Date(since); prevUntil.setDate(prevUntil.getDate() - 1);
  const prevSince = new Date(prevUntil); prevSince.setDate(prevSince.getDate() - 6);
  return {
    curr: `{"since":"${fmt(since)}","until":"${fmt(until)}"}`,
    prev: `{"since":"${fmt(prevSince)}","until":"${fmt(prevUntil)}"}`,
  };
}

async function fetchAccount(accountId, level) {
  const { curr, prev } = buildTimeRanges();
  const base = `${GRAPH}/${accountId}/insights?access_token=${META_TOKEN}`;

  if (level === 'campaign') {
    const [c, p] = await Promise.all([
      fetch(`${base}&fields=${FIELDS}&time_range=${encodeURIComponent(curr)}&level=campaign`).then(r=>r.json()),
      fetch(`${base}&fields=${FIELDS}&time_range=${encodeURIComponent(prev)}&level=campaign`).then(r=>r.json()),
    ]);
    const prevMap = {};
    (p.data||[]).forEach(x => { prevMap[x.campaign_id] = x; });
    return { data: (c.data||[]).map(x => ({ ...x, prev: prevMap[x.campaign_id]||null })) };
  }

  const overviewFields = 'spend,cpc,cpm,impressions,clicks,ctr,reach,actions';
  const [c, p] = await Promise.all([
    fetch(`${base}&fields=${overviewFields}&time_range=${encodeURIComponent(curr)}`).then(r=>r.json()),
    fetch(`${base}&fields=${overviewFields}&time_range=${encodeURIComponent(prev)}`).then(r=>r.json()),
  ]);
  return {
    curr: c.data?.[0] || null,
    prev: p.data?.[0] || null,
  };
}

// Fetch 30-day daily breakdown for trend charts
async function fetchDaily(accountId, days = 30) {
  const now = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  const until = new Date(now); until.setDate(until.getDate() - 1);
  const since = new Date(until); since.setDate(since.getDate() - (days - 1));
  const timeRange = encodeURIComponent(`{"since":"${fmt(since)}","until":"${fmt(until)}"}`);
  const fields = 'spend,impressions,clicks,actions,date_start';
  const url = `${GRAPH}/${accountId}/insights?access_token=${META_TOKEN}&fields=${fields}&time_range=${timeRange}&time_increment=1`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    // Extraer "mensajes" (conversaciones WhatsApp iniciadas)
    // Meta puede devolver distintos action_types según el tipo de campaña y ventana de atribución
    const WA_TYPES = [
      'onsite_conversion.messaging_conversation_started_7d',  // Mensajes Meta Ads (7d click)
      'messaging_conversation_started_7d',                    // Alternativo sin prefijo
      'onsite_conversion.messaging_conversation_started_1d',  // 1-day window
      'messaging_conversation_started',                       // Sin ventana específica
    ];
    function extractConv(actions) {
      if (!actions || !actions.length) return 0;
      for (const t of WA_TYPES) {
        const hit = actions.find(a => a.action_type === t);
        if (hit && parseFloat(hit.value) > 0) return parseFloat(hit.value);
      }
      return 0;
    }
    return (d.data || []).map(row => ({
      date: row.date_start,
      spend: parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
      conv: extractConv(row.actions || []),
    }));
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { account = 'nuevo', level, days } = req.query;
  const accountId = ACCOUNTS[account] || ACCOUNTS.nuevo;

  try {
    if (level === 'daily') {
      const data = await fetchDaily(accountId, days ? parseInt(days) : 30);
      return res.status(200).json({ data });
    }
    const data = await fetchAccount(accountId, level === 'campaign' ? 'campaign' : 'overview');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
