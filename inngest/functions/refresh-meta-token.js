/**
 * GioLens — Worker: refresh-meta-token
 *
 * El long-lived token de Meta caduca a los 60 días. Hay que refrescarlo
 * antes para no perder visibilidad de campañas (afecta a run-arbitraje).
 *
 * Trigger: cron diario 03:00 CST (rango bajo de tráfico)
 * Concurrency: 1
 * Retries: 3 (fallar acá es crítico, reintentar)
 *
 * Steps:
 *   1. fetch-current-token   → de Supabase secrets
 *   2. check-expiry          → si > 7 días para expirar, skip
 *   3. exchange-token        → GET graph.facebook.com/v19.0/oauth/access_token
 *   4. persist-supabase      → upsert en `secrets` con metadata expiry_at
 *   5. emit-token-refreshed  → (futuro: para notificación admin)
 */

import { inngest } from '../client.js';

const REFRESH_THRESHOLD_MS = 7 * 24 * 3600_000;

export default inngest.createFunction(
  {
    id: 'giolens-refresh-meta-token',
    concurrency: 1,
    retries: 3,
  },
  { cron: 'TZ=America/Tijuana 0 3 * * *' },
  async ({ event, step }) => {
    const startedAt = Date.now();

    // Step 1: leer token actual
    const current = await step.run('fetch-current-token', async () => {
      // TODO Fase 2: SELECT value, expires_at FROM secrets WHERE name='META_TOKEN'
      console.log('[refresh-meta-token] stub fetch current');
      return {
        token: process.env.META_TOKEN || 'stub-token',
        expires_at: startedAt + 30 * 24 * 3600_000, // 30d
      };
    });

    // Step 2: skip si todavía hay margen
    const remaining = current.expires_at - startedAt;
    if (remaining > REFRESH_THRESHOLD_MS) {
      const days = Math.round(remaining / 86400_000);
      console.log(`[refresh-meta-token] skip — expira en ${days}d`);
      return { skipped: true, expires_in_days: days };
    }

    // Step 3: exchange
    const refreshed = await step.run('exchange-token', async () => {
      // TODO Fase 2:
      // GET https://graph.facebook.com/v19.0/oauth/access_token
      //   ?grant_type=fb_exchange_token
      //   &client_id={app_id}
      //   &client_secret={app_secret}
      //   &fb_exchange_token={current.token}
      console.log('[refresh-meta-token] stub exchange');
      return {
        access_token: 'stub-refreshed-token-' + startedAt,
        expires_in: 60 * 24 * 3600,
      };
    });

    // Step 4: persistir
    const upsert = await step.run('persist-supabase', async () => {
      const newExpiry = startedAt + refreshed.expires_in * 1000;
      // TODO Fase 2: UPSERT secrets(name='META_TOKEN', value=refreshed.access_token, expires_at=newExpiry)
      // Y propagar a Vercel env vars vía REST API si se decide en Fase 2C.
      console.log('[refresh-meta-token] stub persist newExpiry=', new Date(newExpiry).toISOString());
      return { expires_at: newExpiry };
    });

    const result = {
      refreshed: true,
      duration_ms: Date.now() - startedAt,
      expires_at: upsert.expires_at,
    };
    console.log('[refresh-meta-token] done', result);
    return result;
  }
);
