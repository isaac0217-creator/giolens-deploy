/**
 * GioLens — Worker: batch-auto-prompt
 *
 * Reemplaza /api/auto-prompt cuando hay que generar N variantes en paralelo
 * (ej. tras campaign.fatigue_detected, o lote masivo desde dashboard).
 *
 * ⏸ ESTADO (Frente C · decisión §3.2 opción C — D1 Chat 19 may): DIFERIDO A
 *   FRENTE D. Este worker NO se wirea en Frente C. El evento experimental
 *   CAMPAIGN_BATCH_VARIANT_REQUESTED permanece en EVENTS_EXPERIMENTAL (no se
 *   promueve a EVENTS canónico). El endpoint síncrono /api/text-utils?op=prompt
 *   cubre la generación de variantes hoy. Re-evaluar promoción/descarte en
 *   Frente D. El stub se mantiene registrado para no romper el manifest Inngest.
 *
 * Trigger: event `giolens/campaign.batch_variant_requested`
 * Concurrency: { key: 'event.data.pipeline_id', limit: 3 }
 * Retries: 2
 *
 * Steps:
 *   1. resolve-context     → carga pipeline meta (producto, precio, público) desde Supabase
 *   2. fan-out-variantes   → Promise.all sobre N steps, uno por ángulo
 *   3. dedup-and-rank      → elimina muy similares, ordena por score heurístico
 *   4. upsert-supabase     → tabla `auto_prompt_variants` con version
 *
 * Nota: cada variante es 1 step independiente para que Inngest tenga checkpointing
 * fino — si una falla, las demás no se reintentan.
 */

import { inngest } from '../client.js';
import { EVENTS_EXPERIMENTAL } from '../events.js';

const DEFAULT_ANGULOS = ['urgencia', 'valor', 'social_proof'];

export default inngest.createFunction(
  {
    id: 'giolens-batch-auto-prompt',
    concurrency: { key: 'event.data.pipeline_id', limit: 3 },
    retries: 2,
  },
  { event: EVENTS_EXPERIMENTAL.CAMPAIGN_BATCH_VARIANT_REQUESTED },
  async ({ event, step }) => {
    const {
      pipeline_id,
      stage_name,
      n_variants = 3,
      angulos = DEFAULT_ANGULOS,
      correlation_id,
    } = event.data || {};

    const targetAngulos = angulos.slice(0, Math.max(1, Math.min(10, n_variants)));
    console.log('[batch-auto-prompt] start', pipeline_id, stage_name, targetAngulos);

    // Step 1: contexto del pipeline
    const ctx = await step.run('resolve-context', async () => {
      // TODO Fase 2: SELECT * FROM pipelines WHERE id=pipeline_id
      // Stub: shape igual al PIPELINES de /api/auto-prompt.js
      console.log('[batch-auto-prompt] stub resolve-context', pipeline_id);
      return {
        id: pipeline_id,
        name: 'stub-pipeline',
        producto: 'stub-producto',
        precio: 'stub-precio',
        diferenciadores: 'stub-diff',
        publico: 'stub-publico',
      };
    });

    // Step 2: fan-out variantes (1 step por ángulo → checkpoint independiente)
    const variantes = await Promise.all(
      targetAngulos.map((angulo) =>
        step.run(`claude-variant-${angulo}`, async () => {
          // TODO Fase 2: llamada Anthropic Haiku con prompt de /api/auto-prompt.js
          console.log(`[batch-auto-prompt] stub claude variant ${angulo}`);
          return {
            id: `${angulo}-${Date.now()}`,
            angulo,
            mensaje: `stub mensaje ángulo=${angulo}`,
            cuando_usar: 'cuando el lead lleva 2-4 días sin responder',
            tono: angulo === 'urgencia' ? 'directo' : 'cercano',
          };
        })
      )
    );

    // Step 3: dedup + rank
    const ranked = await step.run('dedup-and-rank', async () => {
      // TODO Fase 2: cosine similarity / Levenshtein < 0.8 elimina near-duplicates
      console.log('[batch-auto-prompt] stub dedup', variantes.length);
      return variantes;
    });

    // Step 4: persistir
    const upsert = await step.run('upsert-supabase', async () => {
      // TODO Fase 2: INSERT auto_prompt_variants (pipeline_id, stage_name, variants jsonb, version)
      console.log('[batch-auto-prompt] stub upsert', ranked.length);
      return { rows: ranked.length, version: Date.now() };
    });

    const result = {
      correlation_id,
      pipeline_id,
      stage_name,
      generated: ranked.length,
      upsert,
    };
    console.log('[batch-auto-prompt] done', result);
    return result;
  }
);
