/**
 * GioLens — Motor #4: Arbitraje de Canal
 * URL: /api/arbitraje
 *
 * GET  → status del motor
 * POST → ejecuta análisis de ROI por campaña y genera recomendaciones de presupuesto
 *
 * Analiza las 5 campañas de Meta Ads:
 *   - Eficiencia: CPC, CTR, clicks/peso gastado
 *   - Tendencia: semana actual vs semana anterior
 *   - Score combinado → 🟢 Escalar / 🟡 Mantener / 🔴 Reducir
 *
 * Claude genera recomendaciones concretas de redistribución de presupuesto.
 * NOTA: Las recomendaciones son advisory — el equipo decide si aplicarlas en Meta Ads.
 */

const META_TOKEN  = process.env.META_TOKEN;
const META_ACCOUNT = 'act_299921604429631';
const GRAPH        = 'https://graph.facebook.com/v19.0';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-haiku-4-5';

// Mapeo de campañas a pipelines (por nombre)
const CAMPAIGN_PIPELINE = {
  '120243518605340263': { pipeline: 'Justin · Holbrook', tipo: 'prospección' },
  '120243519211130263': { pipeline: 'Justin · Holbrook', tipo: 'retargeting' },
  '120244599911580263': { pipeline: 'Dama · Luxury',     tipo: 'prospección' },
  '120244603173850263': { pipeline: 'GioVision',         tipo: 'prospección' },
  '120244682313890263': { pipeline: 'GioSports + SPY',   tipo: 'prospección' },
};

function buildTimeRanges() {
  const fmt = d => d.toISOString().slice(0, 10);
  const now = new Date();
  const until = new Date(now); until.setDate(until.getDate() - 1);
  const since = new Date(until); since.setDate(since.getDate() - 6);
  const prevUntil = new Date(since); prevUntil.setDate(prevUntil.getDate() - 1);
  const prevSince = new Date(prevUntil); prevSince.setDate(prevSince.getDate() - 6);
  return {
    curr: `{"since":"${fmt(since)}","until":"${fmt(until)}"}`,
    prev: `{"since":"${fmt(prevSince)}","until":"${fmt(prevUntil)}"}`,
  };
}

async function getCampaigns() {
  const { curr, prev } = buildTimeRanges();
  const fields = 'campaign_id,campaign_name,spend,cpc,cpm,impressions,clicks,ctr,actions';
  const base   = `${GRAPH}/${META_ACCOUNT}/insights?access_token=${META_TOKEN}&fields=${fields}&level=campaign`;

  const [currData, prevData] = await Promise.all([
    fetch(`${base}&time_range=${encodeURIComponent(curr)}`).then(r => r.json()),
    fetch(`${base}&time_range=${encodeURIComponent(prev)}`).then(r => r.json()),
  ]);

  const prevMap = {};
  (prevData.data || []).forEach(c => { prevMap[c.campaign_id] = c; });

  return (currData.data || []).map(c => {
    const p = prevMap[c.campaign_id] || {};
    const info = CAMPAIGN_PIPELINE[c.campaign_id] || { pipeline: 'Otro', tipo: '—' };

    const spend  = parseFloat(c.spend  || 0);
    const cpc    = parseFloat(c.cpc    || 0);
    const ctr    = parseFloat(c.ctr    || 0);
    const clicks = parseInt(c.clicks   || 0);

    const pSpend  = parseFloat(p.spend  || 0);
    const pCpc    = parseFloat(p.cpc    || 0);
    const pCtr    = parseFloat(p.ctr    || 0);

    // Eficiencia = clicks por peso gastado (más alto = mejor)
    const efficiency = spend > 0 ? clicks / spend : 0;
    const pEfficiency = pSpend > 0 ? parseInt(p.clicks || 0) / pSpend : 0;

    // Score 0-100: combina eficiencia (70%) + CTR (30%), normalizados entre campañas
    // Se normaliza después de tener todos los datos
    const rawScore = efficiency * 0.7 + (ctr / 3) * 0.3; // CTR normalizado a ~3% max

    // Tendencia vs semana anterior
    const cpcDelta = pCpc > 0 ? ((cpc - pCpc) / pCpc) * 100 : 0;
    const ctrDelta = pCtr > 0 ? ((ctr - pCtr) / pCtr) * 100 : 0;

    return {
      id: c.campaign_id,
      name: c.campaign_name,
      pipeline: info.pipeline,
      tipo: info.tipo,
      spend, cpc, ctr, clicks,
      efficiency,
      rawScore,
      cpcDelta: Math.round(cpcDelta * 10) / 10,
      ctrDelta: Math.round(ctrDelta * 10) / 10,
      prev: { spend: pSpend, cpc: pCpc, ctr: pCtr },
    };
  });
}

function scoreAndRank(campaigns) {
  if (!campaigns.length) return campaigns;
  const maxRaw = Math.max(...campaigns.map(c => c.rawScore), 0.001);
  return campaigns.map(c => {
    const score = Math.round((c.rawScore / maxRaw) * 100);
    const decision = score >= 70 ? 'escalar'
                   : score >= 40 ? 'mantener'
                   : 'reducir';
    return { ...c, score, decision };
  }).sort((a, b) => b.score - a.score);
}

async function analyzeWithClaude(campaigns, totalSpend) {
  const resumen = campaigns.map(c =>
    `[Score ${c.score}/100] ${c.name} (${c.pipeline} · ${c.tipo})\n` +
    `  Gasto: $${c.spend.toFixed(0)} MXN | CPC: $${c.cpc.toFixed(2)} | CTR: ${c.ctr.toFixed(2)}% | ` +
    `Clicks: ${c.clicks} | CPC vs semana ant.: ${c.cpcDelta > 0 ? '+' : ''}${c.cpcDelta}%`
  ).join('\n\n');

  const prompt = `Eres el sistema de arbitraje de presupuesto de Meta Ads para GioLens Vision Care, Tijuana MX.

GASTO TOTAL SEMANA ACTUAL: $${totalSpend.toFixed(0)} MXN

RENDIMIENTO POR CAMPAÑA (ordenadas por score de eficiencia):
${resumen}

CONTEXTO:
- Score 70-100: campaña eficiente → recomendar escalar presupuesto
- Score 40-69: rendimiento aceptable → mantener
- Score 0-39: bajo rendimiento → recomendar reducir o pausar

INSTRUCCIÓN: Genera 3 recomendaciones concretas de redistribución. Sé específico con porcentajes o montos.
Responde SOLO en este JSON sin texto adicional ni markdown:
{
  "recomendaciones": [
    {"prioridad": 1, "accion": "escalar|mantener|reducir|pausar", "campana": "nombre exacto", "detalle": "qué hacer y por qué (1 línea)", "impacto": "resultado esperado"},
    {"prioridad": 2, "accion": "escalar|mantener|reducir|pausar", "campana": "nombre exacto", "detalle": "qué hacer y por qué (1 línea)", "impacto": "resultado esperado"},
    {"prioridad": 3, "accion": "escalar|mantener|reducir|pausar", "campana": "nombre exacto", "detalle": "qué hacer y por qué (1 línea)", "impacto": "resultado esperado"}
  ],
  "resumen": "Una línea con la estrategia general de presupuesto esta semana"
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: 'Responde SIEMPRE con JSON puro y válido. NUNCA uses markdown, bloques de código, ni texto adicional. Solo el objeto JSON.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const d = await r.json();
  if (d.error) console.error('[arbitraje] Claude error:', JSON.stringify(d.error));
  const raw = d.content?.[0]?.text || '{}';
  console.log('[arbitraje] Claude raw:', raw.slice(0, 300));
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { console.error('[arbitraje] JSON parse fail:', e.message, raw.slice(start, start+200)); }
  }
  return { recomendaciones: [], resumen: 'Error al procesar respuesta de Claude.' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      motor: 'Motor #4 — Arbitraje de Canal',
      descripcion: 'Analiza ROI por campaña Meta Ads y recomienda redistribución de presupuesto. POST para ejecutar.',
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawCampaigns = await getCampaigns();
    const campaigns    = scoreAndRank(rawCampaigns);
    const totalSpend   = campaigns.reduce((s, c) => s + c.spend, 0);
    const analysis     = await analyzeWithClaude(campaigns, totalSpend);

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      resumen: analysis.resumen,
      recomendaciones: analysis.recomendaciones,
      campanas: campaigns.map(c => ({
        id: c.id,
        name: c.name,
        pipeline: c.pipeline,
        tipo: c.tipo,
        score: c.score,
        decision: c.decision,
        spend: c.spend,
        cpc: c.cpc,
        ctr: c.ctr,
        clicks: c.clicks,
        cpcDelta: c.cpcDelta,
        ctrDelta: c.ctrDelta,
      })),
      total_spend: totalSpend,
    });
  } catch (e) {
    console.error('[arbitraje]', e);
    return res.status(500).json({ error: e.message });
  }
}
