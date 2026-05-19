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
 * Dependencias:
 *   - WAPIFY_TOKEN (env)
 *   - Lógica equivalente a /api/reactivation-check.js
 *
 * Output del run: { pipelines_scanned, candidates_emitted, duration_ms }
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';

const PIPELINES = ['216977', '755062', '252999', '94103', '273944'];

export default inngest.createFunction(
  {
    id: 'giolens-scan-reactivations',
    concurrency: 1,
    retries: 0,
  },
  { cron: '*/5 * * * *' },
  async ({ event, step }) => {
    const startedAt = Date.now();
    console.log('[scan-reactivations] tick', new Date().toISOString());

    // Step 1: obtener lista de pipelines activos (hoy hard-coded, futuro: Supabase)
    const pipelines = await step.run('get-pipelines', async () => {
      // TODO Fase 2: leer de Supabase `pipelines` table cuando sync-wapify-cache esté operativo
      return PIPELINES;
    });

    // Step 2: fan-out — un step por pipeline corre en paralelo
    const perPipeline = await Promise.all(
      pipelines.map((pid) =>
        step.run(`scan-pipeline-${pid}`, async () => {
          // TODO Fase 2: replicar lógica de getRecentLeads + needsReactivation
          // desde /api/reactivation-check.js (líneas 88-145).
          // Por ahora retorna stub realista.
          console.log(`[scan-reactivations] stub scanning pipeline ${pid}`);
          return {
            pipeline_id: pid,
            candidates: [
              // shape esperado:
              // { contact_id, stage_name, silence_ms, last_interaction, last_sent }
            ],
          };
        })
      )
    );

    // Step 3: emite lead.silence_detected por cada candidato
    let emitted = 0;
    for (const { pipeline_id, candidates } of perPipeline) {
      for (const c of candidates) {
        // P0 fix (audit Agent E 18 may noche tardía): el fallback
        // `step.sendEvent?.(...) ?? await inngest.send(...)` rompía idempotencia
        // bajo retry porque `inngest.send` directo NO es checkpointado por Inngest.
        // Solo `step.sendEvent` es idempotente bajo retries. Si step no existe,
        // significa que estamos en stub mode (sin Inngest activo) → no-op silencioso
        // emitido vía `inngest.send` del stub (loggea, no envía).
        await step.sendEvent(`emit-${c.contact_id}`, {
          name: EVENTS.LEAD_SILENCE_DETECTED,
          data: {
            correlation_id: `scan-${startedAt}-${c.contact_id}`,
            contact_id:       c.contact_id,
            pipeline_id,
            stage_name:       c.stage_name,
            silence_ms:       c.silence_ms,
            last_interaction: c.last_interaction,
            last_sent:        c.last_sent,
          },
        });
        emitted++;
      }
    }

    const result = {
      pipelines_scanned: pipelines.length,
      candidates_emitted: emitted,
      duration_ms: Date.now() - startedAt,
    };
    console.log('[scan-reactivations] done', result);
    return result;
  }
);
