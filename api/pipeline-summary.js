/**
 * GioLens — Pipeline Summary + Journey Analytics + CRM Metrics (fusionado)
 *
 * MODO ESTÁNDAR:  GET /api/pipeline-summary?pipeline_id=216977
 *   → conteo de leads por etapa (vista CRM general)
 *
 * MODO JOURNEY:   GET /api/pipeline-summary?pipeline_id=216977&mode=journey
 *   → mapea cada lead a Int 1 / Int 2 / Int 3 / Cierre / Ganado / Perdido
 *   → calcula tasas de avance del embudo
 *
 * MODO MÉTRICAS:  GET /api/pipeline-summary?pipeline_id=216977&mode=metrics
 *                 GET /api/pipeline-summary?all=1&mode=metrics
 *   → estancamiento >48h, won/lost/active, tasa de cierre
 *   → (fusión de crm-metrics.js eliminado para respetar límite Hobby 12/12)
 *
 * Wapify devuelve máx 100 items por llamada.
 * Este endpoint pagina server-side y devuelve conteos exactos.
 *
 * Mapeo de etapas → interacción (validado 15 mayo 2026 via API /stages):
 *   Int 1  : NUEVO, BOT ACTIVO, RUTA COMERCIAL, RUTA MÉDICA,
 *            COTIZADO, PRECIO ENTREGADO, CTA VISITA
 *   Int 2  : contiene "INT2"
 *   Int 3  : contiene "INT3" o "NT3" (typo real en la API de Wapify)
 *   Cierre : UBICACIÓN ENVIADA, METODO PAGO / MÉTODO DE PAGO
 *   Won    : VISITA CONFIRMADA, VENTA CONFIRMADA, CLIENTE GANADO
 *   Lost   : FUERA DE CATÁLOGO, CATCH-ALL, LEAD PERDIDO
 *
 * Nota: pipeline 94103 usa "MÉTODO DE PAGO" (con acento y "DE")
 *       pipelines 216977 y 755062 usan "METODO PAGO" (sin acento ni "DE")
 *       classifyStage normaliza acentos y usa METODO.*PAGO para cubrir ambos.
 */

const WAPIFY_TOKEN = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE  = 'https://ap.whapify.ai/api';

const ALL_PIPELINES = ['216977', '755062', '252999', '94103', '273944'];
const STAGNANT_MS   = 48 * 60 * 60 * 1000; // 48 horas

// Etapas terminales de éxito (case-insensitive, sin acento)
const WIN_STAGE_NAMES = ['visita confirmada', 'venta confirmada', 'cliente ganado'];
// Etapas terminales de pérdida (case-insensitive, sin acento)
const LOST_STAGE_NAMES = ['fuera de catalogo', 'fuera del flujo', 'lead perdido', 'catch-all'];

function normalizeStage(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const WIN_STAGES  = { has: s => WIN_STAGE_NAMES.includes(normalizeStage(s)) };
const LOST_STAGES = { has: s => LOST_STAGE_NAMES.includes(normalizeStage(s)) };

async function wapGet(path, retries = 3, backoffMs = 1200) {
  const r = await fetch(`${WAPIFY_BASE}/${path}`, {
    headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN },
  });
  if (r.status === 429 && retries > 0) {
    await new Promise(res => setTimeout(res, backoffMs));
    return wapGet(path, retries - 1, backoffMs * 1.5);
  }
  if (!r.ok) return null;
  return r.json();
}

// Clasifica una etapa por su nombre en una fase del journey
function classifyStage(name = '') {
  const n = name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (/VISITA CONFIRMADA|VENTA CONFIRMADA|CLIENTE GANADO/.test(n)) return 'won';
  if (/FUERA DE CATALOGO|CATCH.ALL|LEAD PERDIDO/.test(n))          return 'lost';
  if (/INT3|NT3/.test(n))                                           return 'int3';
  if (/INT2/.test(n))                                               return 'int2';
  // Cubre: "METODO PAGO" (216977, 755062) y "MÉTODO DE PAGO" (94103)
  if (/UBICACI|METODO.*PAGO/.test(n))                               return 'closing';
  return 'int1';
}

// ── MODO MÉTRICAS: estancamiento, won/lost/active, tasa de cierre ──
async function metricsForPipeline(pid) {
  const opportunities = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const r = await wapGet(`pipelines/${pid}/opportunities?offset=${offset}&limit=100`);
    const batch = r?.data || [];
    if (!batch.length) break;
    opportunities.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }

  const now = Date.now();
  const stagnantByStage = {};
  const hoursByStage    = {};
  let won = 0, lost = 0, active = 0, stagnantTotal = 0;

  opportunities.forEach(o => {
    const stageName = o.stage?.name || 'Sin etapa';
    const updatedAt = o.updated_at ? new Date(o.updated_at).getTime() : null;
    const ageMs     = updatedAt ? (now - updatedAt) : null;
    const ageH      = ageMs !== null ? ageMs / 3_600_000 : null;

    if (WIN_STAGES.has(stageName))       won++;
    else if (LOST_STAGES.has(stageName)) lost++;
    else {
      active++;
      if (ageMs !== null && ageMs > STAGNANT_MS) {
        stagnantByStage[stageName] = (stagnantByStage[stageName] || 0) + 1;
        stagnantTotal++;
      }
    }

    if (ageH !== null) {
      if (!hoursByStage[stageName]) hoursByStage[stageName] = [];
      hoursByStage[stageName].push(ageH);
    }
  });

  const avgHoursByStage = {};
  Object.entries(hoursByStage).forEach(([s, arr]) => {
    avgHoursByStage[s] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10;
  });

  return {
    pipeline_id:    pid,
    total:          opportunities.length,
    won, lost, active,
    stagnantTotal,
    stagnantRate:   active > 0 ? Math.round(stagnantTotal / active * 1000) / 10 : 0,
    stagnantByStage,
    avgHoursByStage,
    convRate:       (won + lost) > 0 ? Math.round(won / (won + lost) * 1000) / 10 : null,
    generated_at:   new Date().toISOString(),
  };
}

// ── MODO ESTÁNDAR / JOURNEY: conteo por etapa + embudo ──
async function summaryForPipeline(pid, journey) {
  const stagesRes = await wapGet(`pipelines/${pid}/stages`);
  const stages    = stagesRes?.data || [];

  const stageMap = {};
  stages.forEach(s => {
    stageMap[s.id] = { name: s.name, phase: classifyStage(s.name) };
  });

  const byStageId   = {};
  const phaseCounts = { int1: 0, int2: 0, int3: 0, closing: 0, won: 0, lost: 0 };
  let total  = 0;
  let offset = 0;

  for (let page = 0; page < 50; page++) {
    const r     = await wapGet(`pipelines/${pid}/opportunities?offset=${offset}&limit=100`);
    const batch = r?.data || [];
    if (!batch.length) break;

    batch.forEach(o => {
      const sid  = o.stage?.id;
      const info = sid ? stageMap[sid] : null;
      if (sid) byStageId[sid] = (byStageId[sid] || 0) + 1;
      if (journey && info) phaseCounts[info.phase] = (phaseCounts[info.phase] || 0) + 1;
    });

    total += batch.length;
    if (batch.length < 100) break;
    offset += 100;
  }

  const stageCounts = stages.map(s => ({
    id:    s.id,
    name:  s.name,
    count: byStageId[s.id] || 0,
    ...(journey ? { phase: stageMap[s.id]?.phase || 'int1' } : {}),
  })).sort((a, b) => b.count - a.count);

  const base = {
    pipeline_id:   pid,
    total,
    pages_fetched: Math.ceil(total / 100) || 0,
    stageCounts,
    generated_at:  new Date().toISOString(),
  };

  if (!journey) return base;

  const active = phaseCounts.int1 + phaseCounts.int2 + phaseCounts.int3 + phaseCounts.closing;
  const rate12 = active > 0
    ? Math.round(((phaseCounts.int2 + phaseCounts.int3 + phaseCounts.closing) / active) * 100) : 0;
  const rate23 = (phaseCounts.int2 + phaseCounts.int3) > 0
    ? Math.round((phaseCounts.int3 / (phaseCounts.int2 + phaseCounts.int3)) * 100) : 0;
  const rateWon = total > 0 ? Math.round((phaseCounts.won / total) * 100) : 0;

  const stageDetail = stages.map(s => ({
    id:    s.id,
    name:  s.name,
    phase: stageMap[s.id]?.phase || 'int1',
    count: byStageId[s.id] || 0,
  })).sort((a, b) => b.count - a.count);

  return {
    ...base,
    active_leads: active,
    by_phase: phaseCounts,
    funnel_rates: {
      int1_to_int2_pct: rate12,
      int2_to_int3_pct: rate23,
      overall_won_pct:  rateWon,
    },
    stage_detail: stageDetail,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { pipeline_id: pid, mode, all } = req.query;

  try {
    // ── MODO MÉTRICAS ──
    if (mode === 'metrics') {
      if (all === '1') {
        const results = await Promise.allSettled(ALL_PIPELINES.map(metricsForPipeline));
        const data = results.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : { pipeline_id: ALL_PIPELINES[i], error: r.reason?.message }
        );
        return res.status(200).json({ data });
      }
      if (!pid) return res.status(400).json({ error: 'pipeline_id o all=1 requerido' });
      return res.status(200).json(await metricsForPipeline(pid));
    }

    // ── MODO ESTÁNDAR / JOURNEY ──
    if (!pid) return res.status(400).json({ error: 'pipeline_id requerido' });
    const journey = mode === 'journey';
    return res.status(200).json(await summaryForPipeline(pid, journey));

  } catch (err) {
    console.error('[pipeline-summary]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
