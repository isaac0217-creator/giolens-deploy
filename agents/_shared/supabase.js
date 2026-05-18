/**
 * GioLens — Supabase clients
 * Fase 3 §15 · Sprint 1 cerrado 18 may 2026.
 *
 * Convención:
 *   - getServiceClient(): usa SUPABASE_SERVICE_ROLE_KEY (server-side, bypass RLS)
 *   - getAnonClient():    usa SUPABASE_ANON_KEY (lectura pública, RLS activo)
 *   - isSupabaseReady():  true si env vars presentes
 *
 * Schema: ver agents/_shared/supabase-schema.sql (11 tablas Cowork · 313 líneas)
 *
 * Singleton pattern: el cliente se reutiliza entre warm starts del mismo
 * contenedor lambda. Cada cold start re-instancia.
 *
 * Keys formato `sb_*` (no JWT) — Hallazgo 20 v14 §22.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Singletons por scope (cada uno cachea su cliente)
let _serviceClient = null;
let _anonClient = null;

/**
 * Cliente con service role (bypass RLS). Para uso server-side / agentes.
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
export function getServiceClient() {
  if (_serviceClient) return _serviceClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[supabase] getServiceClient() — SUPABASE_URL o SERVICE_ROLE_KEY no configurados, retorno null');
    return null;
  }
  _serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}

/**
 * Cliente anónimo (RLS aplicado). Para lecturas públicas o cuando se quiera
 * respetar políticas RLS (ej: dashboard browser).
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
export function getAnonClient() {
  if (_anonClient) return _anonClient;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[supabase] getAnonClient() — SUPABASE_URL o ANON_KEY no configurados, retorno null');
    return null;
  }
  _anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _anonClient;
}

/**
 * Indica si Supabase está disponible (env vars presentes).
 * Útil para guards condicionales en bus.js, cost-tracker.js, etc.
 * @returns {boolean}
 */
export function isSupabaseReady() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Smoke ping: verifica que el cliente puede leer al menos 1 tabla.
 * Devuelve `{ ok: bool, tables_seen: number, error?: string }`.
 * Útil en healthchecks o init de agentes.
 */
export async function smokePing() {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'service client not available' };

  try {
    const { data, error } = await client
      .from('app_config')
      .select('key', { count: 'exact', head: false })
      .limit(1);
    if (error) return { ok: false, error: error.message };
    return { ok: true, app_config_rows_seen: data?.length ?? 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { getServiceClient, getAnonClient, isSupabaseReady, smokePing };
