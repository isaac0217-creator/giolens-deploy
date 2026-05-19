/**
 * GioLens — Inngest Client (Fase 2 activado · audit 18 may noche tardía)
 *
 * Estado: SDK real cuando INNGEST_EVENT_KEY existe; stub silencioso si no.
 * Permite activación gradual: deploy code → setear env vars → redeploy → live.
 *
 * Pasos de activación pendientes:
 *   1. ✅ npm i inngest (en package.json)
 *   2. ⏸ Vercel env vars:
 *        INNGEST_EVENT_KEY=...  (desde Inngest Cloud dashboard)
 *        INNGEST_SIGNING_KEY=... (idem)
 *   3. ⏸ Redeploy. /api/inngest auto-discovery via URL público.
 *
 * Mientras no haya env vars, `inngest.send()` cae al stub (logs a consola).
 */

import { Inngest } from 'inngest';

const HAS_KEYS = Boolean(process.env.INNGEST_EVENT_KEY);

// Cliente real cuando hay keys. Sin keys, el SDK Inngest también es usable
// en modo "dev" (no envía a Cloud) — pero forzamos stub para claridad.
export const inngest = HAS_KEYS
  ? new Inngest({
      id: 'giolens',
      eventKey: process.env.INNGEST_EVENT_KEY,
    })
  : _buildStub();

function _buildStub() {
  return {
    /**
     * Stub de inngest.send — solo loggea.
     * @param {{name: string, data?: object, user?: object}} event
     * @returns {Promise<{ids: string[]}>}
     */
    send: async (event) => {
      const name = event?.name || 'unknown';
      const data = event?.data || {};
      console.log('[INNGEST STUB] send →', name, JSON.stringify(data).slice(0, 200));
      return { ids: ['stub-' + Date.now()] };
    },

    /**
     * Stub de createFunction — devuelve objeto inerte para que los export default no fallen.
     * @param {{id: string, concurrency?: number|object, retries?: number}} config
     * @param {{event?: string, cron?: string}} trigger
     * @param {(ctx: {event: object, step: object}) => Promise<any>} handler
     */
    createFunction: (config, trigger, handler) => {
      if (typeof trigger === 'function' && handler === undefined) {
        handler = trigger;
        trigger = {};
      }
      return {
        id: config?.id || 'unknown-fn',
        config,
        trigger,
        handler,
        __stub: true,
      };
    },
  };
}

export default inngest;
