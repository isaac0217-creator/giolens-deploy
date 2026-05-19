/**
 * GioLens — Worker: run-arbitraje
 *
 * Reemplaza POST /api/arbitraje. Análisis de ROI por campaña Meta vs semana previa.
 *
 * Trigger: event `giolens/arbitrage.requested` OR cron cada 6h (`0 *\/6 * * *`)
 * Concurrency: 1
 * Retries: 1
 *
 * Steps:
 *   1. meta-curr  ‖ meta-prev   → fetch Meta insights (paralelo)
 *   2. score-campaigns          → CTR/CPC drop, semáforo 🟢🟡🔴
 *   3. claude-recos             → Haiku genera recomendaciones de presupuesto
 *   4. upsert-supabase          → tabla `arbitraje_runs`
 *   5. emit fatigue events      → para cada campaña 🔴, emite campaign.fatigue_detected
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';

export default inngest.createFunction(
  {
    id: 'giolens-run-arbitraje',
    concurrency: 1,
    retries: 1,
  },
  [
    { event: EVENTS.ARBITRAGE_REQUESTED },
    { cron: '0 */6 * * *' },
  ],
  async ({ event, step }) => {
    const startedAt = Date.now();
    console.log('[run-arbitraje] start');

    // Step 1: fetch en paralelo
    const [curr, prev] = await Promise.all([
      step.run('meta-curr', async () => {
        // TODO Fase 2: fetch real a graph.facebook.com/v19.0/{account}/insights
        // ventana semana actual (since: now-7, until: yesterday)
        console.log('[run-arbitraje] stub meta-curr');
        return { campaigns: [] };
      }),
      step.run('meta-prev', async () => {
        // TODO Fase 2: misma llamada con ventana semana previa
        console.log('[run-arbitraje] stub meta-prev');
        return { campaigns: [] };
      }),
    ]);

    // Step 2: score
    const scored = await step.run('score-campaigns', async () => {
      // TODO Fase 2: replicar lógica de scoreCampaigns en /api/arbitraje.js
      console.log('[run-arbitraje] stub score');
      return curr.campaigns.map((c) => ({
        campaign_id: c.campaign_id,
        ctr_drop_pct: 0,
        cpc_rise_pct: 0,
        semaforo: '🟡',
      }));
    });

    // Step 3: Claude
    const recos = await step.run('claude-recos', async () => {
      // TODO Fase 2: llamada Anthropic
      console.log('[run-arbitraje] stub claude');
      return { recomendaciones: [], model: 'claude-haiku-4-5' };
    });

    // Step 4: persistir
    const upsert = await step.run('upsert-supabase', async () => {
      console.log('[run-arbitraje] stub upsert');
      return { run_id: startedAt, rows: scored.length };
    });

    // Step 5: emitir fatigue para campañas en rojo — usar step.sendEvent
    // (idempotencia bajo retry). Antes `inngest.send` directo → duplicaba
    // eventos si el run reintentaba. Cierra P0 audit Agent E.
    let fatigueEmitted = 0;
    for (const s of scored) {
      if (s.semaforo === '🔴') {
        await step.sendEvent(`emit-fatigue-${s.campaign_id}`, {
          name: EVENTS.CAMPAIGN_FATIGUE_DETECTED,
          data: {
            correlation_id: `arbitraje-${startedAt}-${s.campaign_id}`,
            campaign_id: s.campaign_id,
            pipeline: s.pipeline || 'unknown',
            ctr_drop_pct: s.ctr_drop_pct,
            cpc_rise_pct: s.cpc_rise_pct,
            semaforo: '🔴',
          },
        });
        fatigueEmitted++;
      }
    }

    const result = {
      campaigns: scored.length,
      fatigue_emitted: fatigueEmitted,
      duration_ms: Date.now() - startedAt,
      upsert,
      recos_count: recos?.recomendaciones?.length || 0,
    };
    console.log('[run-arbitraje] done', result);
    return result;
  }
);
