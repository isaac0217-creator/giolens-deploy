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
 *   1. batch-contacts          → recibe array de hasta 50 contact_ids
 *   2. fetch-conversations     → Wapify GET contacts/{id}/messages (paralelo)
 *   3. claude-distill          → 1 call Haiku por lote (no por contacto, ahorra ~5x tokens)
 *   4. upsert-supabase         → tabla `conversation_summaries`
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';

const BATCH_SIZE = 50;

export default inngest.createFunction(
  {
    id: 'giolens-distill-conversation',
    concurrency: { key: 'event.data.pipeline_id', limit: 2 },
    retries: 2,
  },
  { event: EVENTS.CONVERSATION_DISTILL_REQUESTED },
  async ({ event, step }) => {
    const { contact_ids = [], pipeline_id, correlation_id } = event.data || {};
    if (!contact_ids.length) {
      return { skipped: true, reason: 'empty_batch' };
    }

    const batch = contact_ids.slice(0, BATCH_SIZE);
    console.log('[distill-conversation] start', batch.length, 'contacts', pipeline_id);

    // Step 1: fetch conversaciones en paralelo
    const conversations = await step.run('fetch-conversations', async () => {
      // TODO Fase 2: Wapify GET contacts/{id}/messages?limit=200 por cada id (Promise.all)
      console.log(`[distill-conversation] stub fetch ${batch.length} convos`);
      return batch.map((id) => ({
        contact_id: id,
        messages: [], // [{role, text, ts}]
      }));
    });

    // Step 2: distilación Claude (1 prompt con todos los lotes para amortizar)
    const distilled = await step.run('claude-distill', async () => {
      // TODO Fase 2: prompt batched a claude-haiku-4-5 con schema JSON estricto
      console.log(`[distill-conversation] stub claude distill batch=${conversations.length}`);
      return conversations.map((c) => ({
        contact_id: c.contact_id,
        summary: 'stub: lead pregunta precio, bot responde, lead pide ubicación',
        sentiment: 'neutral',
        next_action: 'enviar ubicación',
        objections: [],
      }));
    });

    // Step 3: persistir
    const upsert = await step.run('upsert-supabase', async () => {
      // TODO Fase 2: upsert masivo en `conversation_summaries`
      console.log('[distill-conversation] stub upsert', distilled.length);
      return { rows: distilled.length };
    });

    const result = {
      correlation_id,
      pipeline_id,
      processed: distilled.length,
      upsert,
    };
    console.log('[distill-conversation] done', result);
    return result;
  }
);
