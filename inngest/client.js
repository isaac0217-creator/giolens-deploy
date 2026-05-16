/**
 * GioLens — Inngest Client (STUB Fase 2)
 *
 * Estado: NO operativo. Stub local sin conexión a Inngest Cloud.
 * Permite que /inngest/events.js y /inngest/functions/* importen `inngest`
 * sin romper en build/dev mientras se prepara el deploy real.
 *
 * Cuando activemos Inngest:
 *   1. npm i inngest
 *   2. Descomentar import del SDK
 *   3. Configurar INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY en Vercel
 *   4. Reemplazar el bloque `export const inngest = { ... }` por el cliente real
 *   5. Crear /api/inngest.js (ver api-handler-stub.js)
 *
 * Mientras tanto, llamadas a `inngest.send(...)` solo loggean a consola
 * para poder cablear emisores en el código sin spamear servicios externos.
 */

// TODO Fase 2: descomentar cuando esté instalado el SDK
// import { Inngest } from 'inngest';
// export const inngest = new Inngest({
//   id: 'giolens',
//   eventKey: process.env.INNGEST_EVENT_KEY,
//   // signingKey se usa en /api/inngest.js (handler), no aquí
// });

// ─── STUB — Reemplazar cuando lleguen INNGEST_EVENT_KEY y INNGEST_SIGNING_KEY env vars ───
export const inngest = {
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
   * Stub de createFunction — no registra ni ejecuta nada.
   * Solo devuelve un objeto inerte para que los `export default` no fallen.
   * @param {{id: string, concurrency?: number|object, retries?: number}} config
   * @param {{event?: string, cron?: string}} trigger
   * @param {(ctx: {event: object, step: object}) => Promise<any>} handler
   */
  createFunction: (config, trigger, handler) => {
    // Soporta firma de 2 args (config, handler) usada por algunos workers simples
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

export default inngest;
