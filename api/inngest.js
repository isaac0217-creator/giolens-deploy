/**
 * GioLens — /api/inngest handler (Fase 2 activado · audit 18 may noche tardía)
 *
 * Endpoint público que Inngest Cloud usa para:
 *   - GET → ping de registro de funciones
 *   - POST → ejecutar un step de una función
 *   - PUT → sync del catálogo
 *
 * Cuando `inngest/client.js` está en modo SDK real (env vars seteadas), este
 * handler usa `serve({...})` del SDK Inngest para Node. Sin env vars, devuelve
 * 503 con info de las funciones registradas (compatible con stub).
 *
 * Activación final pendiente:
 *   1. ✅ npm i inngest (package.json)
 *   2. ⏸ Setear INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY en Vercel
 *   3. ⏸ Crear cuenta Inngest Cloud + obtener keys (D2 del reporte maestro)
 *   4. ⏸ Wirear funciones inngest a los 6 agents (pendiente decisión Isaac
 *      según docs/inngest_agents_wiring.md cuando sub-agent termine)
 */

import { serve } from 'inngest/node';
import { inngest } from '../inngest/client.js';

// Importa las 6 funciones canónicas activas.
// (sync-wapify-cache y refresh-meta-token migrados a `api/cron/*.ts` en Frente D.2 · 22-may-2026; legacy borrado.)
import scanReactivations    from '../inngest/functions/scan-reactivations.js';
import sendReactivation     from '../inngest/functions/send-reactivation.js';
import runMicroseg          from '../inngest/functions/run-microseg.js';
import runArbitraje         from '../inngest/functions/run-arbitraje.js';
import distillConversation  from '../inngest/functions/distill-conversation.js';
import batchAutoPrompt      from '../inngest/functions/batch-auto-prompt.js';

export const functions = [
  scanReactivations,
  sendReactivation,
  runMicroseg,
  runArbitraje,
  distillConversation,
  batchAutoPrompt,
];

const HAS_KEYS = Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY);

// Si hay keys: handler real. Sin keys: stub que reporta estado.
const realHandler = HAS_KEYS
  ? serve({
      client: inngest,
      functions,
      signingKey: process.env.INNGEST_SIGNING_KEY,
    })
  : null;

export default async function handler(req, res) {
  if (realHandler) {
    // Delega al SDK Inngest. Maneja GET/POST/PUT internamente.
    return realHandler(req, res);
  }

  // Stub: reporta funciones registradas sin servir.
  console.log('[api/inngest stub] hit', req?.method, 'fns:', functions.length);
  return res.status(503).json({
    error: 'inngest_keys_missing',
    message: 'Setear INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY en Vercel + redeploy para activar.',
    registered_functions: functions.map((f) => f.id),
    docs: 'inngest/README.md',
  });
}
