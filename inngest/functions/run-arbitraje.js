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
 *   3. analista-recos           → agente Analista (executeAnalistaDailyRun)
 *   4. upsert-supabase          → tabla `arbitraje_runs`
 *   5. emit fatigue events      → para cada campaña 🔴, emite campaign.fatigue_detected
 *
 * Wiring Frente C · C.2.2 (handoff §4 · decisión Isaac):
 *   - Step `analista-recos`: invoca al agente Analista vía runWithTrace
 *     (executeAnalistaDailyRun, period:'last_6h') en lugar del Haiku inline.
 *   - D2-W3 (c): el approval gate aplica solo si delta>$50. El umbral se lee
 *     de env var `APPROVAL_GATE_THRESHOLD_USD` (default 50) y se surface en el
 *     resultado del run. Los insights del Analista son informativos (reportar
 *     fatiga NO requiere approval — solo EJECUTAR cambios lo requiere).
 *   - R5: clave de step determinista (correlation_id) → retry no re-cobra.
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';
import { runWithTrace } from '../../agents/_shared/run-with-trace.js';
import { executeAnalistaDailyRun } from '../../agents/analista/index.js';

// D2-W3 (c): umbral del approval gate, configurable por env var.
const APPROVAL_GATE_THRESHOLD_USD = Number(process.env.APPROVAL_GATE_THRESHOLD_USD) || 50;

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
    // R5: correlation_id estable para claves de step deterministas.
    const correlationId = event?.data?.correlation_id || `arbitraje-${startedAt}`;
    console.log('[run-arbitraje] start', correlationId);

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
        pipeline: c.pipeline || 'unknown',
        ctr_drop_pct: 0,
        cpc_rise_pct: 0,
        semaforo: '🟡',
      }));
    });

    // Step 3: análisis vía agente Analista (runWithTrace).
    // R5: clave de step determinista (correlation_id) → retry reusa cache, no re-cobra.
    const analista = await step.run(`analista-recos-${correlationId}`, async () => {
      const { result, trace, error } = await runWithTrace(
        'analista',
        executeAnalistaDailyRun,
        { period: 'last_6h' },
        { correlation_id: correlationId },
      );
      return {
        insights:   result?.insights?.length ?? 0,
        published:  typeof result?.published === 'number' ? result.published : 0,
        cost_usd:   typeof result?.cost_usd === 'number' ? result.cost_usd : 0,
        latency_ms: typeof result?.latency_ms === 'number' ? result.latency_ms : 0,
        trace_ok:   trace?.ok ?? false,
        trace_steps: Array.isArray(trace?.steps) ? trace.steps.length : 0,
        error:      error || null,
      };
    });

    // Step 4: persistir
    const upsert = await step.run(`upsert-supabase-${correlationId}`, async () => {
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
            correlation_id: `${correlationId}-${s.campaign_id}`,
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
      correlation_id: correlationId,
      campaigns: scored.length,
      fatigue_emitted: fatigueEmitted,
      duration_ms: Date.now() - startedAt,
      upsert,
      analista,
      recos_count: analista.insights,
      // D2-W3 (c): umbral del approval gate surface para downstream.
      approval_gate_threshold_usd: APPROVAL_GATE_THRESHOLD_USD,
    };
    console.log('[run-arbitraje] done', JSON.stringify(result));
    return result;
  },
);
