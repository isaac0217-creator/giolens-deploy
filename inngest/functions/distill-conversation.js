/**
 * GioLens — Worker: distill-conversation
 *
 * Comprime conversaciones largas (50+ msgs) en resúmenes estructurados.
 * Habilita análisis histórico sin pagar tokens completos en cada query.
 *
 * Trigger: event `giolens/conversation.distill_requested`
 * Concurrency: { key: 'event.data.pipeline_id', limit: 2 }
 * Retries: 2
 *
 * Steps:
 *   1. fetch-conversations  → Wapify GET contacts/{id}/messages (paralelo)
 *   2. claude-distill       → agente Analista (distillBatch) — 1 call Haiku/lote
 *   3. upsert-supabase      → tabla `conversation_summaries`
 *
 * Wiring Frente C · C.2.5 (decisión Isaac 20 may · opción A):
 *   - Step `claude-distill`: invoca `analista.distillBatch` vía runWithTrace.
 *     distillBatch usa un módulo/prompt separado (agents/analista/distill.js) —
 *     no toca el flujo ni el prompt del daily run del Analista.
 *   - R5: clave de step determinista (correlation_id) → retry no re-cobra.
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';
import { runWithTrace } from '../../agents/_shared/run-with-trace.js';
import { distillBatch } from '../../agents/analista/index.js';

const BATCH_SIZE = 50;

export default inngest.createFunction(
  {
    id: 'giolens-distill-conversation',
    concurrency: { key: 'event.data.pipeline_id', limit: 2 },
    retries: 2,
    // C.2.7 — idempotencia cross-run: re-disparar distill_requested con el
    // mismo correlation_id → run dedupeado, no se re-cobra Anthropic. Función
    // pure-event (sin cron) → la key siempre está presente.
    idempotency: 'event.data.correlation_id',
  },
  { event: EVENTS.CONVERSATION_DISTILL_REQUESTED },
  async ({ event, step }) => {
    const { contact_ids = [], pipeline_id, correlation_id } = event.data || {};
    if (!contact_ids.length) {
      return { skipped: true, reason: 'empty_batch' };
    }

    const correlationId = correlation_id || `distill-${Date.now()}`;
    const batch = contact_ids.slice(0, BATCH_SIZE);
    console.log('[distill-conversation] start', batch.length, 'contacts', pipeline_id, correlationId);

    // Step 1: fetch conversaciones en paralelo
    const conversations = await step.run('fetch-conversations', async () => {
      // TODO Fase 2: Wapify GET contacts/{id}/messages?limit=200 por cada id (Promise.all)
      console.log(`[distill-conversation] stub fetch ${batch.length} convos`);
      return batch.map((id) => ({
        contact_id: id,
        messages: [], // [{role, text, ts}]
      }));
    });

    // Step 2: distilación vía agente Analista (distillBatch) con runWithTrace.
    // R5: clave de step determinista (correlation_id) → retry reusa cache.
    const distill = await step.run(`claude-distill-${correlationId}`, async () => {
      const { result, trace, error } = await runWithTrace(
        'analista',
        distillBatch,
        { conversations },
        { correlation_id: correlationId },
      );
      return {
        items:      Array.isArray(result?.distilled) ? result.distilled : [],
        cost_usd:   typeof result?.cost_usd === 'number' ? result.cost_usd : 0,
        latency_ms: typeof result?.latency_ms === 'number' ? result.latency_ms : 0,
        model:      result?.model || null,
        trace_ok:   trace?.ok ?? false,
        error:      error || result?.error || null,
      };
    });

    // Step 3: persistir
    const upsert = await step.run(`upsert-supabase-${correlationId}`, async () => {
      // TODO Fase 2: upsert masivo en `conversation_summaries`
      console.log('[distill-conversation] stub upsert', distill.items.length);
      return { rows: distill.items.length };
    });

    const result = {
      correlation_id: correlationId,
      pipeline_id,
      processed: distill.items.length,
      distill: { cost_usd: distill.cost_usd, model: distill.model, trace_ok: distill.trace_ok, error: distill.error },
      upsert,
    };
    console.log('[distill-conversation] done', JSON.stringify(result));
    return result;
  }
);
