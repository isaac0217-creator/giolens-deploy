/**
 * GioLens — Placeholder de /api/inngest.js
 *
 * Este archivo NO se importa todavía. Es la plantilla que se moverá a
 * /api/inngest.js cuando activemos Inngest en Vercel.
 *
 * Pasos de activación:
 *   1. npm i inngest
 *   2. Vercel env vars:
 *        INNGEST_EVENT_KEY=...
 *        INNGEST_SIGNING_KEY=...
 *   3. Reemplazar el stub de /inngest/client.js por el SDK real
 *   4. Copiar este archivo a /api/inngest.js (renombrar)
 *   5. Vercel deploy → Inngest auto-discovery vía URL /api/inngest
 *
 * El endpoint /api/inngest atiende:
 *   - GET  → Inngest pings para registrar funciones
 *   - POST → Ejecución de un step
 *   - PUT  → Sync de catálogo de funciones
 *
 * TODO Fase 2: mover a /api/inngest.js y descomentar import del SDK.
 */

// TODO Fase 2: descomentar cuando esté instalado el SDK Inngest
// import { serve } from 'inngest/next';

import { inngest } from './client.js';

// Importa las 8 funciones canónicas + 1 experimental
import scanReactivations    from './functions/scan-reactivations.js';
import sendReactivation     from './functions/send-reactivation.js';
import runMicroseg          from './functions/run-microseg.js';
import runArbitraje         from './functions/run-arbitraje.js';
import distillConversation  from './functions/distill-conversation.js';
import syncWapifyCache      from './functions/sync-wapify-cache.js';
import refreshMetaToken     from './functions/refresh-meta-token.js';
import batchAutoPrompt      from './functions/batch-auto-prompt.js';

export const functions = [
  scanReactivations,
  sendReactivation,
  runMicroseg,
  runArbitraje,
  distillConversation,
  syncWapifyCache,
  refreshMetaToken,
  batchAutoPrompt,
];

// TODO Fase 2: cambiar a:
// export default serve({ client: inngest, functions });

export default function handler(req, res) {
  // Stub para no romper si alguien hace fetch al endpoint antes del corte real.
  console.log('[api-handler-stub] hit', req?.method, 'functions registered:', functions.length);
  if (res?.status) {
    return res.status(503).json({
      error: 'inngest_not_deployed',
      message: 'Stub placeholder. Activar Fase 2 (ver inngest/README.md).',
      registered_functions: functions.map((f) => f.id),
    });
  }
  return { stub: true, functions: functions.map((f) => f.id) };
}
