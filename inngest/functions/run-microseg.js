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
 * Steps:
 *   1. get-pipelines       → lista activa
 *   2. segment-pipeline-N  → clasifica leads en 4 segmentos (paralelo)
 *   3. claude-analysis     → 1 llamada por pipeline (Haiku) genera perfil + script + frecuencia
 *   4. upsert-supabase     → escribe en tabla `segmentations` con version
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';

const PIPELINES = [
  { id: '216977', name: 'Justin · Holbrook' },
  { id: '755062', name: 'GioSports' },
  { id: '252999', name: 'SPY Z87' },
  { id: '94103',  name: 'Dama · Luxury' },
  { id: '273944', name: 'GioVision' },
];

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
    const requested = event?.data?.pipeline_ids;
    const targets = requested?.length
      ? PIPELINES.filter((p) => requested.includes(p.id))
      : PIPELINES;

    console.log('[run-microseg] start', targets.map((p) => p.id));

    // Step 1: fan-out clasificación
    const classifications = await Promise.all(
      targets.map((p) =>
        step.run(`segment-pipeline-${p.id}`, async () => {
          // TODO Fase 2: replicar lógica de /api/microseg.js (classify(), STAGE_POSITION).
          console.log(`[run-microseg] stub classify pipeline ${p.id}`);
          return {
            pipeline_id: p.id,
            segments: {
              reciente_activo: [],
              reciente_estancado: [],
              antiguo_activo: [],
              antiguo_estancado: [],
            },
            counts: { total: 0 },
          };
        })
      )
    );

    // Step 2: análisis Claude (1 call por pipeline)
    const analyses = await Promise.all(
      classifications.map((c) =>
        step.run(`claude-analysis-${c.pipeline_id}`, async () => {
          // TODO Fase 2: llamada real a Anthropic (model claude-haiku-4-5)
          console.log(`[run-microseg] stub claude analysis ${c.pipeline_id}`);
          return {
            pipeline_id: c.pipeline_id,
            perfiles: { /* segment → perfil + script + frecuencia */ },
            model: 'claude-haiku-4-5',
          };
        })
      )
    );

    // Step 3: persistir
    const upsert = await step.run('upsert-supabase', async () => {
      // TODO Fase 2: upsert en Supabase tabla `segmentations` (version=Date.now())
      console.log('[run-microseg] stub upsert', analyses.length, 'rows');
      return { upserted: analyses.length, version: startedAt };
    });

    const result = {
      pipelines: targets.length,
      duration_ms: Date.now() - startedAt,
      upsert,
    };
    console.log('[run-microseg] done', result);
    return result;
  }
);
