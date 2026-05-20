/**
 * GioLens — Worker: send-reactivation
 *
 * Reemplaza el bloque "para cada candidato → copiloto → send" de /api/reactivation-check.
 * En Inngest cada lead es un evento independiente: aislamiento por contact_id,
 * retries automáticos en error transient, concurrency limit por contacto para no spamear.
 *
 * Trigger: event `giolens/lead.silence_detected`
 * Concurrency: { key: 'event.data.contact_id', limit: 1 }  — nunca dos sends al mismo contacto en paralelo
 * Retries: 2 (con backoff exponencial nativo de Inngest)
 *
 * Steps:
 *   1. script           → path legacy (POST /api/copiloto) o agente Creativo
 *   2. jitter-sleep     → step.sleep(0..10s) para evitar patrón bot
 *   3. wapify-send      → POST contacts/{id}/send (respeta REACTIVATION_DRY_RUN)
 *   4. emit-reactivation-sent → giolens/lead.reactivation_sent
 *
 * Wiring Frente C · C.2.4 (handoff §4 · misión Isaac):
 *   - PRE-4 / D1-W3 (b): feature flag `LEGACY_SEND_REACTIVATION_ENABLED` para
 *     la convivencia 30 días. Por defecto TRUE → path legacy (copiloto inline).
 *     Isaac lo pone =false para cortar al agente Creativo cuando esté validado.
 *   - REGLA INVIOLABLE (defense-in-depth): si el silence_detected viene de un
 *     pipeline prohibido (252999 SPY / 273944 GioVision) NO se envía INT —
 *     se emite blocker_violation y se aborta.
 *   - REACTIVATION_DRY_RUN intacto (NUNCA =false sin confirmación de Isaac).
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';
import { runWithTrace } from '../../agents/_shared/run-with-trace.js';
import { executeCreativoOnDemand } from '../../agents/creativo/index.js';

const DRY_RUN = process.env.REACTIVATION_DRY_RUN !== 'false';

// PRE-4 / D1-W3 (b): durante la convivencia 30 días el path legacy (copiloto
// inline) está activo por defecto. Isaac lo apaga (=false) para enrutar al
// agente Creativo cuando el path nuevo esté validado. Se lee dentro del
// handler (no congelado al import) para que el toggle no requiera reimport.
function legacyReactivationEnabled() {
  return process.env.LEGACY_SEND_REACTIVATION_ENABLED !== 'false';
}

const WAPIFY_BASE  = 'https://ap.whapify.ai/api';
const WAPIFY_TOKEN = process.env.WAPIFY_TOKEN;

// Regla inviolable GioLens: NUNCA INT1/INT2/INT3 a SPY Z87 ni GioVision.
const FORBIDDEN_INT_PIPELINES = new Set(['252999', '273944']);

/** Path legacy: pide script al copiloto vía POST /api/copiloto. */
async function getLegacyCopilotoScript({ pipeline_id, stage_name, contact_id }) {
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';
    const r = await fetch(`${baseUrl}/api/copiloto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_id, stage_name, contact_id }),
    });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

/** Extrae script + alternativa del resultado del agente Creativo (defensivo). */
function scriptFromCreativo(creativoResult) {
  const draft = creativoResult?.draft;
  if (!draft) return null;
  const pick = (v) => (typeof v === 'string' ? v : (v?.body || v?.text || v?.message || ''));
  const script = pick(draft.primary);
  if (!script) return null;
  const altRaw = Array.isArray(draft.alternatives) ? draft.alternatives[0] : null;
  const alt = altRaw ? pick(altRaw) : '';
  return { script: String(script), alternativa: alt || null, urgencia: draft.urgencia || 'media' };
}

export default inngest.createFunction(
  {
    id: 'giolens-send-reactivation',
    concurrency: { key: 'event.data.contact_id', limit: 1 },
    retries: 2,
    // C.2.7 — idempotencia cross-run: re-disparar el mismo silence_detected
    // (mismo correlation_id) dentro de la ventana de Inngest → run dedupeado,
    // no se re-cobra el script ni se re-envía el mensaje. Función pure-event
    // (sin cron) → la key siempre está presente.
    idempotency: 'event.data.correlation_id',
  },
  { event: EVENTS.LEAD_SILENCE_DETECTED },
  async ({ event, step }) => {
    const { contact_id, pipeline_id, stage_name, silence_ms, correlation_id } = event.data || {};
    const corr = correlation_id || `send-${Date.now()}-${contact_id}`;
    const legacyEnabled = legacyReactivationEnabled();
    console.log('[send-reactivation] start', contact_id, stage_name, 'legacy=', legacyEnabled);

    // REGLA INVIOLABLE (defense-in-depth): pipeline prohibido → blocker_violation.
    if (FORBIDDEN_INT_PIPELINES.has(String(pipeline_id))) {
      await step.sendEvent(`blocker-violation-${corr}`, {
        name: 'giolens/agent.blocker_violation',
        data: {
          correlation_id: `${corr}-blocker`,
          from_agent: 'send-reactivation',
          pipeline_id,
          contact_id,
          reason: 'INT_forbidden_pipeline',
          rule: 'NUNCA INT1/INT2/INT3 a 252999 (SPY) ni 273944 (GioVision)',
        },
      });
      console.warn('[send-reactivation] blocker_violation — INT suprimido', pipeline_id, contact_id);
      return { skipped: true, reason: 'blocker_violation', pipeline_id, contact_id };
    }

    // Step 1: obtener script — path legacy (copiloto) o agente Creativo (D1-W3 b).
    const copiloto = await step.run(`script-${corr}`, async () => {
      if (legacyEnabled) {
        const legacy = await getLegacyCopilotoScript({ pipeline_id, stage_name, contact_id });
        return {
          source: 'legacy_copiloto',
          script: legacy?.script || null,
          alternativa: legacy?.alternativa || null,
          urgencia: legacy?.urgencia || 'media',
          cost_usd: 0,
          error: legacy ? null : 'legacy_copiloto_unavailable',
        };
      }
      // Path nuevo: agente Creativo vía runWithTrace.
      const { result, trace, error } = await runWithTrace(
        'creativo',
        executeCreativoOnDemand,
        {
          task: 'reactivation',
          params: {
            pipelineId: pipeline_id,
            stageIn: stage_name,
            daysInactive: Math.round((Number(silence_ms || 0) / 86_400_000) * 100) / 100,
          },
        },
        { correlation_id: corr },
      );
      const s = scriptFromCreativo(result);
      return {
        source: 'creativo_agent',
        script: s?.script || null,
        alternativa: s?.alternativa || null,
        urgencia: s?.urgencia || 'media',
        cost_usd: typeof result?.cost_usd === 'number' ? result.cost_usd : 0,
        trace_ok: trace?.ok ?? false,
        error: error || result?.error || null,
      };
    });

    const scriptText = copiloto?.script || copiloto?.alternativa;
    if (!scriptText) {
      console.warn('[send-reactivation] no script, abort', contact_id, copiloto?.error);
      return { skipped: true, reason: 'no_script', source: copiloto?.source, error: copiloto?.error || null };
    }

    // Step 2: jitter aleatorio 0-10s para no parecer bot.
    const jitterMs = Math.floor(Math.random() * 10_000);
    await step.sleep?.('jitter', `${jitterMs}ms`);

    // Step 3: envío vía Wapify (respeta REACTIVATION_DRY_RUN).
    const sendResult = await step.run(`wapify-send-${corr}`, async () => {
      const wapify_payload = { contact_id, message: scriptText, type: 'text' };
      if (DRY_RUN) {
        console.log(`[send-reactivation][DRY] ${contact_id} ← "${scriptText.slice(0, 60)}"`);
        return { dry_run: true, status: 200, wapify_payload };
      }
      try {
        const r = await fetch(`${WAPIFY_BASE}/contacts/${contact_id}/send`, {
          method: 'POST',
          headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: scriptText, type: 'text' }),
        });
        return { dry_run: false, status: r.status, wapify_payload };
      } catch (err) {
        return { dry_run: false, status: 0, error: err.message, wapify_payload };
      }
    });

    // Step 4: emite reactivation_sent — step.sendEvent (idempotencia bajo retry).
    await step.sendEvent(`emit-reactivation-sent-${corr}`, {
      name: EVENTS.LEAD_REACTIVATION_SENT,
      data: {
        correlation_id: corr,
        contact_id,
        pipeline_id,
        stage_name,
        urgencia: copiloto.urgencia || 'media',
        script_preview: scriptText.slice(0, 80),
        script_source: copiloto.source,
        sent_at: Date.now(),
        dry_run: DRY_RUN,
      },
    });

    return {
      sent: true,
      contact_id,
      dry_run: DRY_RUN,
      script_source: copiloto.source,
      jitter_ms: jitterMs,
      send_result: sendResult,
    };
  }
);
