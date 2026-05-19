/**
 * Smoke E2E del wrapper Sentry — uso one-off.
 *
 * Carga .env.local (con SENTRY_DSN bajado de Vercel prod) y emite:
 *   1) captureMessage nivel 'info' con tag distintivo
 *   2) captureException con error sintético nivel 'error'
 *
 * Después flush forzado (5s timeout) para garantizar entrega.
 *
 * Verificación: abrir el proyecto Sentry y buscar tag `smoke_id=<timestamp>`.
 *
 * Correr:
 *   node --env-file=.env.local scripts/sentry-smoke-e2e.mjs
 *
 * NO commitear este script si genera ruido en producción.
 */

import * as Sentry from '@sentry/node';
import { initSentry, captureMessage, captureException } from '../agents/_shared/sentry.js';

const ts = Date.now();
const smokeId = `smoke-e2e-${ts}`;

console.log('═══ Sentry E2E smoke ═══');
console.log(`smoke_id: ${smokeId}`);
console.log(`SENTRY_DSN configurada: ${!!process.env.SENTRY_DSN}`);
console.log(`VERCEL_ENV: ${process.env.VERCEL_ENV || '(unset)'}`);
console.log('');

const ok = initSentry();
console.log(`initSentry() → ${ok ? 'true (SDK activo)' : 'false (no-op)'}`);

if (!ok) {
  console.error('❌ Sentry no se inicializó. Revisar .env.local.');
  process.exit(1);
}

// 1) captureMessage info
captureMessage(`E2E smoke message · ${smokeId}`, {
  level: 'info',
  tags: { smoke_id: smokeId, smoke_kind: 'message', source: 'local-script' },
  extras: { note: 'evento sintético desde scripts/sentry-smoke-e2e.mjs · verificar en dashboard' },
});
console.log('✅ captureMessage emitido (level=info)');

// 2) captureException error
const syntheticError = new Error(`E2E smoke exception · ${smokeId}`);
syntheticError.code = 'SMOKE_E2E_SYNTHETIC';
captureException(syntheticError, {
  level: 'error',
  tags: { smoke_id: smokeId, smoke_kind: 'exception', source: 'local-script' },
  extras: { note: 'excepción sintética — NO es un bug real, smoke E2E' },
});
console.log('✅ captureException emitido (level=error)');

// Flush forzado
console.log('');
console.log('Flushing (timeout 5s)…');
const flushed = await Sentry.flush(5000);
console.log(flushed ? '✅ Flush completado — eventos entregados' : '⚠️ Flush timeout — eventos puede que se hayan perdido');
console.log('');
console.log('═══════════════════════');
console.log(`Verificar en Sentry dashboard buscando: smoke_id:${smokeId}`);
console.log('Deberías ver 2 eventos: 1 message + 1 exception.');
