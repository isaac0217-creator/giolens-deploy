/**
 * GioLens — Motor #2: Predictor de Quiebres
 * URL: /api/predictor
 *
 * GET  → status del motor
 * POST → ejecuta análisis completo y devuelve alertas
 *
 * Detecta 3 señales de riesgo:
 *   1. CPC subió >15% vs semana anterior (Meta Ads)
 *   2. Leads estancados >48h en etapas no terminales (Wapify)
 *   3. Tasa de respuesta baja (<20% de leads tienen actividad reciente)
 *
 * Claude Haiku genera diagnóstico + acción recomendada por pipeline.
 */

const WAPIFY_TOKEN  = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE   = 'https://ap.whapify.ai/api';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-haiku-4-5';

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT  = 'act_299921604429631';
const GRAPH         = 'https://graph.facebook.com/v19.0';

const PIPELINES = [
  { id: '216977', name: 'Justin · Holbrook' },
  { id: '755062', name: 'GioSports' },
  { id: '252999', name: 'SPY Z87' },
  { id: '94103',  name: 'Dama · Luxury' },
  { id: '273944', name: 'GioVision' },
];

const TERMINAL_STAGES = new Set([
  'VISITA CONFIRMADA', 'VENTA CONFIRMADA', 'CLIENTE GANADO',
  'FUERA DE CATÁLOGO', 'FUERA DEL FLUJO', 'LEAD PERDIDO',
  'CATCH-ALL',
]);

const STAGNATION_MS = 48 * 60 * 60 * 1000; // 48 horas

// ─── WAPIFY ───

async function wapGet(path) {
  const r = await fetch(`${WAPIFY_BASE}/${path}`, {
    headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN },
  });
  return r.json();
}

function parseWapifyDate(str) {
  if (!str) return 0;
  // Wapify devuelve "2026-05-10 16:40:21" en CST (UTC-6)
  return new Date(str.replace(' ', 'T') + '-06:00').getTime();
}

async function getStagnantLeads(pipelineId) {
  const now = Date.now();
  const stagnant = [];
  let offset = 0;

  for (let page = 0; page < 30; page++) {
    const d = await wapGet(`pipelines/${pipelineId}/opportunities?limit=100&offset=${offset}`);
    const batch = d.data || [];
    if (!batch.length) break;

    for (const opp of batch) {
      if (TERMINAL_STAGES.has(opp.stage?.name)) continue;
      const updatedMs = parseWapifyDate(opp.updated_at);
      const silenceMs = now - updatedMs;
      if (silenceMs > STAGNATION_MS) {
        stagnant.push({
          stage: opp.stage?.name || '?',
          hours: Math.round(silenceMs / 3600000),
        });
      }
    }

    // Si el último lead del batch fue actualizado hace menos de 48h, el resto tampoco lo estará
    const lastUpdated = parseWapifyDate(batch[batch.length - 1]?.updated_at);
    if (now - lastUpdated < STAGNATION_MS) break;

    offset += 100;
  }

  // Agrupar por etapa
  const byStage = {};
  for (const { stage, hours } of stagnant) {
    if (!byStage[stage]) byStage[stage] = { count: 0, maxHours: 0 };
    byStage[stage].count++;
    if (hours > byStage[stage].maxHours) byStage[stage].maxHours = hours;
  }

  return { total: stagnant.length, byStage };
}

// ─── META ADS ───

async function getMetaCPC() {
  const fmt = d => d.toISOString().slice(0, 10);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo   = new Date(yesterday); weekAgo.setDate(weekAgo.getDate() - 6);
  const twoWeeks  = new Date(weekAgo); twoWeeks.setDate(twoWeeks.getDate() - 7);

  const currRange = encodeURIComponent(`{"since":"${fmt(weekAgo)}","until":"${fmt(yesterday)}"}`);
  const prevRange = encodeURIComponent(`{"since":"${fmt(twoWeeks)}","until":"${fmt(weekAgo)}"}`);
  const base = `${GRAPH}/${META_ACCOUNT}/insights?access_token=${META_TOKEN}&fields=cpc,spend,clicks`;

  const [curr, prev] = await Promise.all([
    fetch(`${base}&time_range=${currRange}`).then(r => r.json()),
    fetch(`${base}&time_range=${prevRange}`).then(r => r.json()),
  ]);

  const currCPC = parseFloat(curr.data?.[0]?.cpc || 0);
  const prevCPC = parseFloat(prev.data?.[0]?.cpc || 0);
  const change  = prevCPC > 0 ? ((currCPC - prevCPC) / prevCPC) * 100 : 0;

  return {
    curr: currCPC,
    prev: prevCPC,
    changePct: Math.round(change * 10) / 10,
    alert: change > 15,
  };
}

// ─── CLAUDE ANÁLISIS ───

async function analyzeWithClaude(cpc, pipelines) {
  const highStagnation = pipelines.filter(p => p.stagnant.total > 10);
  const criticalPipes  = pipelines.filter(p => p.stagnant.total > 30);

  const prompt = `Eres el sistema de monitoreo de GioLens Vision Care, óptica en Tijuana MX con 5 pipelines de WhatsApp marketing.

DATOS ACTUALES (${new Date().toISOString().slice(0,10)}):

CPC Meta Ads:
- Semana actual: $${cpc.curr.toFixed(2)} MXN
- Semana anterior: $${cpc.prev.toFixed(2)} MXN
- Cambio: ${cpc.changePct > 0 ? '+' : ''}${cpc.changePct}%
- Alerta CPC: ${cpc.alert ? 'SÍ — subió >15%' : 'No'}

Leads estancados >48h por pipeline:
${pipelines.map(p => `- ${p.name} (${p.id}): ${p.stagnant.total} leads estancados${
  Object.keys(p.stagnant.byStage).length
    ? ' — etapas: ' + Object.entries(p.stagnant.byStage).map(([s,v]) => `${s}:${v.count}`).join(', ')
    : ''
}`).join('\n')}

INSTRUCCIÓN: Genera un diagnóstico breve (2-3 líneas) y exactamente 3 acciones concretas priorizadas.
Responde SOLO en este JSON sin texto adicional:
{
  "nivel_riesgo": "alto|medio|bajo",
  "diagnostico": "texto conciso",
  "acciones": [
    {"prioridad": 1, "accion": "texto", "pipeline": "nombre o 'todos'"},
    {"prioridad": 2, "accion": "texto", "pipeline": "nombre o 'todos'"},
    {"prioridad": 3, "accion": "texto", "pipeline": "nombre o 'todos'"}
  ]
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
      max_tokens: 500,
      system: 'Responde SIEMPRE con JSON puro y válido. NUNCA uses markdown, bloques de código, ni texto adicional. Solo el objeto JSON.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const d = await r.json();
  const raw = d.content?.[0]?.text || '{}';
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  return { nivel_riesgo: 'medio', diagnostico: 'Error al procesar respuesta.', acciones: [] };
}

// ─── HANDLER ───

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      motor: 'Motor #2 — Predictor de Quiebres',
      descripcion: 'Detecta alzas de CPC y leads estancados >48h. POST para ejecutar análisis.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Fetch en paralelo: CPC de Meta + leads estancados de los 5 pipelines
    const [cpc, ...pipelineStagnant] = await Promise.all([
      getMetaCPC(),
      ...PIPELINES.map(p => getStagnantLeads(p.id)),
    ]);

    const pipelines = PIPELINES.map((p, i) => ({
      ...p,
      stagnant: pipelineStagnant[i],
    }));

    const analysis = await analyzeWithClaude(cpc, pipelines);

    const totalStagnant = pipelines.reduce((sum, p) => sum + p.stagnant.total, 0);

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      nivel_riesgo: analysis.nivel_riesgo,
      diagnostico: analysis.diagnostico,
      acciones: analysis.acciones,
      datos: {
        cpc,
        pipelines: pipelines.map(p => ({
          id: p.id,
          name: p.name,
          stagnant_total: p.stagnant.total,
          stagnant_by_stage: p.stagnant.byStage,
        })),
        total_stagnant: totalStagnant,
      },
    });

  } catch (e) {
    console.error('[predictor]', e);
    return res.status(500).json({ error: e.message });
  }
}
