/**
 * GioLens — Worker: run-microseg
 *
 * Reemplaza /api/microseg invocado manualmente. Ahora se dispara por evento o cron.
 * Hace fan-out a los 5 pipelines en paralelo y consolida en Supabase.
 *
 * Trigger: event `giolens/segmentation.requested` OR cron diario 08:00 CST (14:00 UTC)
 * Concurrency: 1 (la versión es global, no se solapan ejecuciones)
 * Retries: 1 (Anthropic suele recuperarse en el segundo intento)
 *
 * Wiring Frente C · C.2.1 (decisión Isaac 20 may · opción A):
 *   - Steps `segment-pipeline-N`: CLASIFICADOR DETERMINISTA (D4-W3 a — SIN LLM).
 *     Porta classify()/STAGE_POSITION de /api/microseg.js. Cero llamadas Claude.
 *   - Step `optimizacion-analysis`: invoca al agente Optimizacion vía runWithTrace
 *     (executeOptimizacionDailyRun). El agente SÍ usa LLM — el "sin LLM" de
 *     D4-W3(a) aplica a la clasificación de microseg, no al agente.
 *   - PRE-5: schema strict — assertSegmentationSchema valida el contrato
 *     clasificador → análisis antes de pasar al agente.
 *   - R5: claves de step deterministas (incluyen correlation_id) → un retry
 *     reusa el step cacheado, no re-cobra Anthropic.
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';
import { runWithTrace } from '../../agents/_shared/run-with-trace.js';
import { executeOptimizacionDailyRun } from '../../agents/optimizacion/index.js';

const PIPELINES = [
  { id: '216977', name: 'Justin · Holbrook' },
  { id: '755062', name: 'GioSports' },
  { id: '252999', name: 'SPY Z87' },
  { id: '94103',  name: 'Dama · Luxury' },
  { id: '273944', name: 'GioVision' },
];

const WAPIFY_TOKEN = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE  = 'https://ap.whapify.ai/api';

// ─── Clasificador determinista (portado de /api/microseg.js · D4-W3 a) ────────

const H48 = 48 * 3600_000;
const D7  = 7  * 86400_000;
const D14 = 14 * 86400_000;

// Etapas por posición en el funnel (nombres exactos API Wapify, validado 15-may-2026)
const STAGE_POSITION = {
  'NUEVO':            'inicio',
  'BOT ACTIVO':       'inicio',
  'COTIZADO':         'inicio',
  'CTA VISITA':       'inicio',
  'PRECIO ENTREGADO': 'inicio',
  'RUTA MÉDICA':      'inicio',
  'RUTA COMERCIAL':   'inicio',
  'INT2 · CATÁLOGO':  'mitad',
  'INT2 · RE-ENTRADA':'mitad',
  'INT3 · PROMO ACTIVA': 'cierre',
  'NT3 · COMPARATIVA':   'cierre',
  'UBICACIÓN ENVIADA':   'cierre',
  'METODO PAGO':         'cierre',
  'MÉTODO DE PAGO':      'cierre',
  'VISITA CONFIRMADA':   'cierre',
  'VENTA CONFIRMADA':    'cierre',
  'CLIENTE GANADO':      'cierre',
  'FUERA DE CATÁLOGO':   'cierre',
  'FUERA DEL FLUJO':     'cierre',
  'CATCH-ALL':           'cierre',
  'LEAD PERDIDO':        'cierre',
};

/**
 * Parsea "2026-05-10 16:40:21" de Wapify a Unix ms.
 * Wapify devuelve wallclock CST (UTC-6) sin timezone marker. NO cambiar a 'Z'.
 */
function parseWapDate(str) {
  if (!str) return 0;
  return new Date(str.replace(' ', 'T') + '-06:00').getTime();
}

/** Clasificación determinista de una opportunity. Cero LLM. */
function classify(opp, NOW) {
  const created    = parseWapDate(opp.created_at);
  const updated    = parseWapDate(opp.updated_at);
  const stage      = opp.stage?.name || 'NUEVO';
  const ageMs      = NOW - created;
  const silenceMs  = NOW - updated;
  const recencia   = ageMs < D7 ? 'reciente' : ageMs < D14 ? 'semana_pasada' : 'antiguo';
  const posicion   = STAGE_POSITION[stage] || 'inicio';
  const actividad  = silenceMs < H48 ? 'activo' : 'estancado';
  const hora       = new Date(created).getUTCHours() - 6; // CST
  const turno      = hora >= 6 && hora < 12 ? 'mañana'
                   : hora >= 12 && hora < 18 ? 'tarde'
                   : hora >= 18 ? 'noche' : 'madrugada';
  return { recencia, posicion, actividad, turno, stage, silenceHrs: Math.round(silenceMs / 3600_000) };
}

async function wapGet(path) {
  const r = await fetch(`${WAPIFY_BASE}/${path}`, {
    headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN },
  });
  return r.json();
}

/**
 * Clasificador determinista por pipeline. Sin LLM, sin Anthropic.
 * Si no hay WAPIFY_TOKEN (smoke local), devuelve segmentos vacíos sin tocar red.
 */
async function segmentPipelineDeterministic(pipelineId, NOW) {
  const buckets = { caliente: [], activo: [], tibio: [], frio: [] };
  let total = 0;
  let stub_mode = false;

  if (!WAPIFY_TOKEN) {
    stub_mode = true;
  } else {
    let offset = 0;
    for (let page = 0; page < 25; page++) {
      const d = await wapGet(`pipelines/${pipelineId}/opportunities?limit=100&offset=${offset}`);
      const batch = d?.data || [];
      if (!batch.length) break;
      total += batch.length;
      for (const opp of batch) {
        const c = classify(opp, NOW);
        if (c.actividad === 'activo' && c.posicion === 'cierre')        buckets.caliente.push(c);
        else if (c.actividad === 'activo' && c.recencia === 'reciente') buckets.activo.push(c);
        else if (c.actividad === 'estancado' && c.posicion === 'mitad') buckets.tibio.push(c);
        else                                                            buckets.frio.push(c);
      }
      offset += 100;
    }
  }

  const all = [...buckets.caliente, ...buckets.activo, ...buckets.tibio, ...buckets.frio];
  const turnoCounts = { mañana: 0, tarde: 0, noche: 0, madrugada: 0 };
  all.forEach((l) => { turnoCounts[l.turno]++; });
  const horaPico = Object.entries(turnoCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'tarde';

  const topStage = (seg) => {
    const cnt = {};
    seg.forEach((l) => { cnt[l.stage] = (cnt[l.stage] || 0) + 1; });
    return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  };

  return {
    pipeline_id: pipelineId,
    total,
    horaPico,
    stub_mode,
    segments: {
      caliente: { count: buckets.caliente.length, etapa_top: topStage(buckets.caliente) },
      activo:   { count: buckets.activo.length,   etapa_top: topStage(buckets.activo) },
      tibio:    { count: buckets.tibio.length,    etapa_top: topStage(buckets.tibio) },
      frio:     { count: buckets.frio.length,     etapa_top: topStage(buckets.frio) },
    },
  };
}

const SEGMENT_KEYS = ['caliente', 'activo', 'tibio', 'frio'];

/**
 * PRE-5 — schema strict del contrato clasificador → análisis.
 * Lanza si la clasificación no cumple el shape esperado por el agente downstream.
 */
export function assertSegmentationSchema(c) {
  if (!c || typeof c !== 'object') {
    throw new Error('[run-microseg][PRE-5] classification debe ser objeto');
  }
  if (typeof c.pipeline_id !== 'string' || !c.pipeline_id) {
    throw new Error('[run-microseg][PRE-5] pipeline_id requerido (string)');
  }
  if (typeof c.total !== 'number') {
    throw new Error(`[run-microseg][PRE-5] total inválido en pipeline ${c.pipeline_id}`);
  }
  if (!c.segments || typeof c.segments !== 'object') {
    throw new Error(`[run-microseg][PRE-5] segments faltante en pipeline ${c.pipeline_id}`);
  }
  for (const k of SEGMENT_KEYS) {
    const seg = c.segments[k];
    if (!seg || typeof seg.count !== 'number' || typeof seg.etapa_top !== 'string') {
      throw new Error(`[run-microseg][PRE-5] segmento "${k}" inválido en pipeline ${c.pipeline_id}`);
    }
  }
  return c;
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export default inngest.createFunction(
  {
    id: 'giolens-run-microseg',
    concurrency: 1,
    retries: 1,
  },
  [
    { event: EVENTS.SEGMENTATION_REQUESTED },
    { cron: 'TZ=America/Tijuana 0 8 * * *' },
  ],
  async ({ event, step }) => {
    const startedAt = Date.now();
    // R5: correlation_id estable para claves de step deterministas.
    const correlationId = event?.data?.correlation_id || `microseg-${startedAt}`;
    const requested = event?.data?.pipeline_ids;
    const targets = requested?.length
      ? PIPELINES.filter((p) => requested.includes(p.id))
      : PIPELINES;

    console.log('[run-microseg] start', correlationId, targets.map((p) => p.id));

    // Step 1: clasificación DETERMINISTA fan-out (D4-W3 a — sin LLM).
    // PRE-5: cada step valida su salida con assertSegmentationSchema.
    const classifications = await Promise.all(
      targets.map((p) =>
        step.run(`segment-pipeline-${p.id}-${correlationId}`, async () => {
          const NOW = Date.now();
          const c = await segmentPipelineDeterministic(p.id, NOW);
          return assertSegmentationSchema(c);
        })
      )
    );

    const totals = SEGMENT_KEYS.reduce((acc, k) => {
      acc[k] = classifications.reduce((s, c) => s + c.segments[k].count, 0);
      return acc;
    }, {});

    // Step 2: análisis vía agente Optimizacion (runWithTrace).
    // R5: clave de step determinista (correlation_id) → retry reusa cache, no re-cobra.
    const optimizacion = await step.run(`optimizacion-analysis-${correlationId}`, async () => {
      const { result, trace, error } = await runWithTrace(
        'optimizacion',
        executeOptimizacionDailyRun,
        { period: 'last_24h' },
        { correlation_id: correlationId },
      );
      return {
        proposals:  result?.proposals?.length  ?? 0,
        validated:  result?.validated?.length  ?? 0,
        blocked:    result?.blocked?.length    ?? 0,
        cost_usd:   typeof result?.cost_usd === 'number' ? result.cost_usd : 0,
        latency_ms: typeof result?.latency_ms === 'number' ? result.latency_ms : 0,
        trace_ok:   trace?.ok ?? false,
        trace_steps: Array.isArray(trace?.steps) ? trace.steps.length : 0,
        error:      error || null,
      };
    });

    // Step 3: persistir (Supabase real → Frente D; hoy stub estructurado).
    const upsert = await step.run(`upsert-supabase-${correlationId}`, async () => {
      console.log('[run-microseg] stub upsert', classifications.length, 'segmentations');
      return { upserted: classifications.length, version: startedAt };
    });

    const result = {
      correlation_id: correlationId,
      pipelines: targets.length,
      stub_mode: classifications.some((c) => c.stub_mode),
      totals,
      optimizacion,
      upsert,
      duration_ms: Date.now() - startedAt,
    };
    console.log('[run-microseg] done', JSON.stringify(result));
    return result;
  },
);
