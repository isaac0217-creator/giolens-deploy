/**
 * GioLens — Worker: scan-reactivations
 *
 * Reemplaza el cron actual de /api/reactivation-check (que recorre los 5 pipelines en serie).
 * En Inngest hace fan-out: 1 step por pipeline corren en paralelo, y por cada candidato
 * emite `giolens/lead.silence_detected` que dispara send-reactivation.js.
 *
 * Trigger:  cron `*\/5 * * * *` (cada 5 min)
 * Concurrency: 1 (no queremos dos scans solapados)
 * Retries: 0 (si falla, el próximo tick resuelve)
 *
 * Wiring Frente C · C.2.3 (handoff §4 · misión Isaac):
 *   - Steps `scan-pipeline-N`: scan DETERMINISTA (porta getRecentLeads +
 *     needsReactivation de /api/reactivation-check.js). Sin WAPIFY_TOKEN → stub.
 *   - Step `creativo-script-N`: invoca al agente Creativo vía runWithTrace
 *     (executeCreativoOnDemand task=reactivation) para poblar `script_preview`
 *     en el evento `lead.silence_detected`.
 *   - REGLA INVIOLABLE: NUNCA INT1/INT2/INT3 a pipelines 252999 (SPY Z87) ni
 *     273944 (GioVision). Candidatos en esos pipelines NO emiten silence_detected
 *     — se suprimen y se emite `blocker_violation`.
 *   - Cutover legacy cron: `LEGACY_REACTIVATION_CRON` NO se toca en este commit
 *     (esperar OK de Isaac — el reemplazo aún es scan parcial).
 *
 * Output del run: { pipelines_scanned, candidates_emitted, blockers, duration_ms }
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';
import { runWithTrace } from '../../agents/_shared/run-with-trace.js';
import { executeCreativoOnDemand } from '../../agents/creativo/index.js';

const WAPIFY_TOKEN = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE  = 'https://ap.whapify.ai/api';

const PIPELINES = ['216977', '755062', '252999', '94103', '273944'];

// Regla inviolable GioLens: NUNCA INT1/INT2/INT3 a SPY Z87 (252999) ni
// GioVision (273944). Candidatos aquí se suprimen + se emite blocker_violation.
const FORBIDDEN_INT_PIPELINES = new Set(['252999', '273944']);

// Etapas terminales — NO reactivar leads aquí.
const TERMINAL_STAGES = new Set([
  'VISITA CONFIRMADA', 'visita confirmada',
  'FUERA DE CATÁLOGO', 'fuera del flujo', 'FUERA DEL FLUJO',
  'CATCH-ALL',
]);

// Ventana de reactivación: entre 4 y 12 minutos sin respuesta del lead.
const MIN_SILENCE_MS = 4  * 60 * 1000;
const MAX_SILENCE_MS = 12 * 60 * 1000;
// Pre-filtro: solo fetchear contacto si la opportunity se actualizó hace < N ms.
const OPPORTUNITY_WINDOW_MS = 15 * 60 * 1000;
// Cap de seguridad — máximo candidatos procesados por tick (legacy: MAX_SENDS_PER_RUN).
const MAX_CANDIDATES_PER_RUN = 5;

// ─── Scan determinista (portado de /api/reactivation-check.js) ────────────────

function parseWapifyDate(str) {
  if (!str) return 0;
  return new Date(str.replace(' ', 'T') + '-06:00').getTime();
}

async function wapGet(path) {
  try {
    const r = await fetch(`${WAPIFY_BASE}/${path}`, {
      headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN },
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

/** Opportunities de un pipeline con updated_at en los últimos windowMs, no terminales. */
async function getRecentLeads(pipelineId, windowMs) {
  const cutoff = Date.now() - windowMs;
  const recent = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const r = await wapGet(`pipelines/${pipelineId}/opportunities?limit=100&offset=${offset}`);
    const batch = r?.data || [];
    if (batch.length === 0) break;
    for (const opp of batch) {
      const updatedMs = parseWapifyDate(opp.updated_at);
      if (updatedMs >= cutoff && !TERMINAL_STAGES.has(opp.stage?.name)) recent.push(opp);
    }
    const lastUpdated = parseWapifyDate(batch[batch.length - 1]?.updated_at);
    if (lastUpdated < cutoff) break;
    if (batch.length < 100) break;
    offset += 100;
  }
  return recent;
}

/** Verifica si un lead necesita reactivación (bot respondió, lead callado en ventana). */
async function needsReactivation(contactId) {
  const contact = await wapGet(`contacts/${contactId}`);
  if (!contact) return { needs: false };
  const lastInteraction = Number(contact.last_interaction || 0);
  const lastSent        = Number(contact.last_sent || 0);
  if (!lastInteraction) return { needs: false };
  const silenceMs = Date.now() - lastInteraction;
  const botAlreadyReplied = lastSent > lastInteraction;
  const inWindow = silenceMs >= MIN_SILENCE_MS && silenceMs <= MAX_SILENCE_MS;
  if (botAlreadyReplied && inWindow) {
    return { needs: true, silence_ms: silenceMs, last_interaction: lastInteraction, last_sent: lastSent };
  }
  return { needs: false };
}

/** Scan determinista de un pipeline → lista de candidatos a reactivación. */
async function scanPipeline(pipelineId) {
  if (!WAPIFY_TOKEN) {
    return { pipeline_id: pipelineId, stub_mode: true, candidates: [] };
  }
  const candidates = [];
  const recentLeads = await getRecentLeads(pipelineId, OPPORTUNITY_WINDOW_MS);
  for (const opp of recentLeads) {
    const contactId = opp.contact_id;
    const stageName = opp.stage?.name || 'NUEVO';
    const check = await needsReactivation(contactId);
    if (check.needs) {
      candidates.push({
        contact_id: contactId,
        stage_name: stageName,
        silence_ms: check.silence_ms,
        last_interaction: check.last_interaction,
        last_sent: check.last_sent,
      });
    }
  }
  return { pipeline_id: pipelineId, stub_mode: false, candidates };
}

/** Extrae un preview de script del resultado del agente Creativo (defensivo). */
function scriptPreviewFrom(creativoResult) {
  const draft = creativoResult?.draft;
  if (!draft) return null;
  const p = draft.primary;
  const text = typeof p === 'string' ? p : (p?.body || p?.text || p?.message || '');
  return text ? String(text).slice(0, 80) : null;
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export default inngest.createFunction(
  {
    id: 'giolens-scan-reactivations',
    concurrency: 1,
    retries: 0,
  },
  { cron: '*/5 * * * *' },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const runId = `scan-${startedAt}`;
    console.log('[scan-reactivations] tick', new Date().toISOString(), runId);

    // Step 1: fan-out — scan determinista por pipeline (sin LLM).
    const perPipeline = await Promise.all(
      PIPELINES.map((pid) =>
        step.run(`scan-pipeline-${pid}`, async () => scanPipeline(pid))
      )
    );

    // Step 2: por cada candidato — guard regla inviolable, script Creativo, emit.
    let emitted = 0;
    let blockers = 0;
    let processed = 0;

    for (const { pipeline_id, candidates } of perPipeline) {
      // REGLA INVIOLABLE: pipelines SPY/GioVision nunca reciben INT → blocker_violation.
      if (FORBIDDEN_INT_PIPELINES.has(pipeline_id) && candidates.length > 0) {
        await step.sendEvent(`blocker-violation-${pipeline_id}-${startedAt}`, {
          name: 'giolens/agent.blocker_violation',
          data: {
            correlation_id: `${runId}-blocker-${pipeline_id}`,
            from_agent: 'scan-reactivations',
            pipeline_id,
            suppressed_count: candidates.length,
            reason: 'INT_forbidden_pipeline',
            rule: 'NUNCA INT1/INT2/INT3 a 252999 (SPY) ni 273944 (GioVision)',
          },
        });
        blockers++;
        console.warn(`[scan-reactivations] blocker_violation: ${candidates.length} candidato(s) suprimido(s) en pipeline ${pipeline_id}`);
        continue;
      }

      for (const c of candidates) {
        if (processed >= MAX_CANDIDATES_PER_RUN) break;
        processed++;
        const correlationId = `${runId}-${c.contact_id}`;

        // Script de reactivación vía agente Creativo (runWithTrace).
        const creativo = await step.run(`creativo-script-${c.contact_id}-${startedAt}`, async () => {
          const { result, trace, error } = await runWithTrace(
            'creativo',
            executeCreativoOnDemand,
            {
              task: 'reactivation',
              params: {
                pipelineId: pipeline_id,
                stageIn: c.stage_name,
                daysInactive: Math.round((c.silence_ms / 86_400_000) * 100) / 100,
              },
            },
            { correlation_id: correlationId },
          );
          return {
            script_preview: scriptPreviewFrom(result),
            cost_usd: typeof result?.cost_usd === 'number' ? result.cost_usd : 0,
            trace_ok: trace?.ok ?? false,
            error: error || result?.error || null,
          };
        });

        // Emite lead.silence_detected — step.sendEvent (idempotente bajo retry).
        await step.sendEvent(`emit-${c.contact_id}`, {
          name: EVENTS.LEAD_SILENCE_DETECTED,
          data: {
            correlation_id:   correlationId,
            contact_id:       c.contact_id,
            pipeline_id,
            stage_name:       c.stage_name,
            silence_ms:       c.silence_ms,
            last_interaction: c.last_interaction,
            last_sent:        c.last_sent,
            script_preview:   creativo.script_preview,
          },
        });
        emitted++;
      }
    }

    const result = {
      run_id: runId,
      pipelines_scanned: PIPELINES.length,
      candidates_emitted: emitted,
      blockers,
      stub_mode: perPipeline.some((p) => p.stub_mode),
      duration_ms: Date.now() - startedAt,
    };
    console.log('[scan-reactivations] done', JSON.stringify(result));
    return result;
  }
);
