/**
 * GioLens — Supabase clients (STUB)
 * Fase 3 §15. Capa compartida.
 *
 * Estado: STUB. Supabase no esta provisionado todavia.
 * Cuando llegue, solo se reemplaza la implementacion de getServiceClient()
 * y getAnonClient() — la API publica (firmas) se mantiene.
 *
 * Convencion futura:
 *   - getServiceClient(): usa SUPABASE_SERVICE_ROLE_KEY (server-side, bypass RLS)
 *   - getAnonClient():    usa SUPABASE_ANON_KEY (lectura publica, RLS activo)
 */

let _warnedService = false;
let _warnedAnon    = false;

/**
 * Cliente con service role (bypass RLS). Para uso server-side.
 * TODO cuando llegue Supabase: importar createClient de '@supabase/supabase-js'
 * y retornar createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 * @returns {object|null}
 */
export function getServiceClient() {
  if (!_warnedService) {
    console.warn('[supabase] getServiceClient() called but Supabase not provisioned yet — returning null');
    _warnedService = true;
  }
  return null;
}

/**
 * Cliente anonimo (RLS aplicado). Para uso client-side o lecturas publicas.
 * TODO cuando llegue Supabase: createClient(SUPABASE_URL, SUPABASE_ANON_KEY).
 * @returns {object|null}
 */
export function getAnonClient() {
  if (!_warnedAnon) {
    console.warn('[supabase] getAnonClient() called but Supabase not provisioned yet — returning null');
    _warnedAnon = true;
  }
  return null;
}

/**
 * Helper de conveniencia: indica si Supabase ya esta disponible.
 * Util para guards condicionales en bus.js, cost-tracker.js, etc.
 * @returns {boolean}
 */
export function isSupabaseReady() {
  // TODO cuando llegue Supabase: return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  return false;
}

export default { getServiceClient, getAnonClient, isSupabaseReady };
