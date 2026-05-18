/**
 * GioLens — Sentry wrapper
 *
 * Inicialización idempotente del Sentry SDK para endpoints serverless Vercel.
 * Usa singleton para evitar re-init en warm starts (cada lambda mantiene su
 * Sentry client durante la vida del contenedor).
 *
 * Si SENTRY_DSN no está seteado en env vars (ej: ambiente dev sin Sentry),
 * todos los métodos son no-op silenciosos — NO rompe el flujo del endpoint.
 *
 * Patrón de uso:
 *
 *   import { initSentry, captureException, withSentry } from '../agents/_shared/sentry.js';
 *
 *   // Opción A — wrap handler entero (recomendado):
 *   export default withSentry(async function handler(req, res) {
 *     // tu lógica · si tira, Sentry lo captura automáticamente
 *   }, { endpoint: 'webhook' });
 *
 *   // Opción B — capture manual en try/catch:
 *   try { ... } catch (err) { captureException(err, { tag: 'manual' }); throw err; }
 *
 * Plan §13 v12: Sentry Free tier (5k errors/mes) cubre producción actual.
 * Owner observabilidad: Code (Sprint 1 cierre).
 */

import * as Sentry from '@sentry/node';

const SENTRY_DSN = process.env.SENTRY_DSN;
const VERCEL_ENV = process.env.VERCEL_ENV || 'unknown';
const VERCEL_GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown';

let _initialized = false;

/**
 * Idempotent init. Llamar al inicio de cualquier handler que use Sentry.
 * En warm starts no hace nada (solo verifica el flag).
 */
export function initSentry() {
  if (_initialized) return true;
  if (!SENTRY_DSN) {
    // No-op silencioso si Sentry no configurado (dev local, preview sin DSN)
    _initialized = true;
    return false;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: VERCEL_ENV,                  // 'production' / 'preview' / 'development'
    release: VERCEL_GIT_COMMIT_SHA.slice(0, 7),
    tracesSampleRate: 0.0,                    // Sin performance monitoring por ahora (ahorra cuota)
    sampleRate: 1.0,                          // 100% de errores
    sendDefaultPii: false,                    // No enviamos IPs/userAgents — minimiza PII
    beforeSend(event) {
      // Strip cookies y query strings sensibles antes de enviar
      if (event.request) {
        delete event.request.cookies;
        if (event.request.query_string && typeof event.request.query_string === 'string') {
          // Quitar tokens que vayan en query (rare pero precaución)
          event.request.query_string = event.request.query_string
            .replace(/access_token=[^&]*/gi, 'access_token=REDACTED')
            .replace(/apikey=[^&]*/gi, 'apikey=REDACTED');
        }
      }
      return event;
    },
  });

  _initialized = true;
  console.log(`[sentry] inicializado · env=${VERCEL_ENV} · release=${VERCEL_GIT_COMMIT_SHA.slice(0, 7)}`);
  return true;
}

/**
 * Captura una excepción manualmente con contexto adicional.
 *
 * @param {Error} err - excepción a capturar
 * @param {object} [context] - tags + extras
 * @param {object} [context.tags] - tags Sentry (filtrables)
 * @param {object} [context.extras] - datos adicionales (no filtrables)
 */
export function captureException(err, context = {}) {
  if (!_initialized) initSentry();
  if (!SENTRY_DSN) {
    // Fallback: log estructurado para Vercel logs
    console.error('[sentry-noop]', err?.message || err, JSON.stringify(context));
    return;
  }

  Sentry.withScope((scope) => {
    if (context.tags) {
      Object.entries(context.tags).forEach(([k, v]) => scope.setTag(k, v));
    }
    if (context.extras) {
      Object.entries(context.extras).forEach(([k, v]) => scope.setExtra(k, v));
    }
    if (context.user) scope.setUser(context.user);
    if (context.level) scope.setLevel(context.level);
    Sentry.captureException(err);
  });
}

/**
 * Captura un mensaje (no excepción) — útil para eventos importantes que
 * no son errores pero quieres trackear (ej: cron skipped, lead matched).
 */
export function captureMessage(message, context = {}) {
  if (!_initialized) initSentry();
  if (!SENTRY_DSN) {
    console.log('[sentry-noop-msg]', message, JSON.stringify(context));
    return;
  }

  Sentry.withScope((scope) => {
    if (context.tags) {
      Object.entries(context.tags).forEach(([k, v]) => scope.setTag(k, v));
    }
    if (context.extras) {
      Object.entries(context.extras).forEach(([k, v]) => scope.setExtra(k, v));
    }
    scope.setLevel(context.level || 'info');
    Sentry.captureMessage(message);
  });
}

/**
 * HOF que envuelve un handler Vercel — captura excepciones automáticamente
 * y agrega tags estándar (endpoint, method, status).
 *
 * Asegura flush antes de devolver (las lambdas Vercel matan el proceso
 * cuando termina res.end, así que sin flush los eventos se pierden).
 *
 * @param {function} handler - handler Vercel original
 * @param {object} opts
 * @param {string} opts.endpoint - nombre del endpoint para tags (ej: 'webhook')
 */
export function withSentry(handler, opts = {}) {
  const endpoint = opts.endpoint || 'unknown';

  return async function wrappedHandler(req, res) {
    initSentry();

    if (SENTRY_DSN) {
      Sentry.getCurrentScope().setTag('endpoint', endpoint);
      Sentry.getCurrentScope().setTag('method', req.method || 'unknown');
    }

    try {
      return await handler(req, res);
    } catch (err) {
      captureException(err, {
        tags: { endpoint, method: req.method, fatal: 'true' },
        extras: { url: req.url, query: req.query },
      });

      // Flush pendientes antes de que la lambda muera
      if (SENTRY_DSN) {
        try { await Sentry.flush(2000); } catch { /* timeout flush, no-op */ }
      }

      // Re-throw para que Vercel marque el invoke como fallido (telemetría built-in)
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'internal error' });
      }
      throw err;
    } finally {
      // Flush silencioso en éxito también (eventos captureMessage que se hayan emitido)
      if (SENTRY_DSN) {
        try { await Sentry.flush(1000); } catch { /* timeout flush, no-op */ }
      }
    }
  };
}

// Default export por conveniencia
export default { initSentry, captureException, captureMessage, withSentry };
