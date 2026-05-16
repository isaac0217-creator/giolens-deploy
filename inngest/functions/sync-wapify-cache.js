/**
 * GioLens — Worker: sync-wapify-cache
 *
 * Mantiene Supabase como espejo near-real-time de Wapify para queries rápidas.
 * Evita rate-limit de Wapify en el dashboard y desacopla a los demás workers
 * de la disponibilidad de la API externa.
 *
 * Trigger: cron `*\/15 * * * *` (cada 15 min)
 * Concurrency: 1
 * Retries: 1
 *
 * Steps:
 *   1. resolve-window     → determina since_ms (último sync exitoso desde Supabase)
 *   2. paginate-pipelines → fan-out por pipeline, paginate hasta vaciar updated_at>=since
 *   3. paginate-contacts  → idem para contacts (last_interaction>=since)
 *   4. upsert-supabase    → bulk upsert con conflict on (id) update set ...
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';

const PIPELINES = ['216977', '755062', '252999', '94103', '273944'];
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety cap

export default inngest.createFunction(
  {
    id: 'giolens-sync-wapify-cache',
    concurrency: 1,
    retries: 1,
  },
  [
    { event: EVENTS.SYNC_WAPIFY_PULL },
    { cron: '*/15 * * * *' },
  ],
  async ({ event, step }) => {
    const startedAt = Date.now();

    // Step 1: ventana incremental
    const since = await step.run('resolve-window', async () => {
      // TODO Fase 2: SELECT max(last_synced_at) FROM sync_state
      const fallback = startedAt - 30 * 60_000; // 30 min atrás
      const passed = event?.data?.since_ms;
      console.log('[sync-wapify-cache] window since=', new Date(passed || fallback).toISOString());
      return passed || fallback;
    });

    // Step 2: paginate opportunities por pipeline (paralelo)
    const opportunities = await Promise.all(
      PIPELINES.map((pid) =>
        step.run(`paginate-opportunities-${pid}`, async () => {
          // TODO Fase 2: bucle while page<MAX_PAGES, hasta que el último item del page
          // tenga updated_at < since. Acumular en array.
          console.log(`[sync-wapify-cache] stub paginate opportunities ${pid}`);
          return { pipeline_id: pid, rows: [] };
        })
      )
    );

    // Step 3: paginate contacts (global, no por pipeline)
    const contacts = await step.run('paginate-contacts', async () => {
      // TODO Fase 2: Wapify GET contacts?updated_at_gte=... paginated
      console.log('[sync-wapify-cache] stub paginate contacts');
      return { rows: [] };
    });

    // Step 4: upsert masivo
    const upsert = await step.run('upsert-supabase', async () => {
      const oppRows = opportunities.reduce((sum, p) => sum + p.rows.length, 0);
      const ctcRows = contacts.rows.length;
      // TODO Fase 2:
      //   - upsert into opportunities (...) on conflict (id) do update set ...
      //   - upsert into contacts (...) on conflict (id) do update set ...
      //   - insert into sync_state (last_synced_at) values (startedAt)
      console.log('[sync-wapify-cache] stub upsert opps=', oppRows, 'contacts=', ctcRows);
      return { opportunities: oppRows, contacts: ctcRows };
    });

    const result = {
      since_ms: since,
      duration_ms: Date.now() - startedAt,
      upsert,
    };
    console.log('[sync-wapify-cache] done', result);
    return result;
  }
);
