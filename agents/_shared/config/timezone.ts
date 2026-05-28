/**
 * agents/_shared/config/timezone.ts — Frente G · G-13 timezone configurable
 *
 * Resuelve la deuda G-13 del BACKLOG_G: el código tenía `America/Tijuana`
 * hardcoded en serialización GCal (api/citas.ts × 4) y formato fechas Wapify
 * (api/expediente.ts × 1). Si se abre sucursal en CDMX, Cancún, etc., bastará
 * setear `OPTICA_TIMEZONE` en Vercel envs sin tocar código.
 *
 * Opción A del backlog G-13: env global + fallback America/Tijuana.
 * (Opción B per-consultorio queda para cuando aplique multi-sucursal real.)
 *
 * Reglas:
 *   - Sin env → fallback.
 *   - Con env vacía o whitespace → fallback (no respeta el seteo).
 *   - Con formato inválido (regex) → fallback + console.warn.
 *   - Con formato válido pero no reconocido por Intl → fallback + console.warn.
 *   - Memoización por proceso para evitar overhead en hot path
 *     (citas crean ~decenas/día, no millones, pero la memoización es trivial).
 */

const FALLBACK_TZ = 'America/Tijuana';

// IANA TZ format: Region/City (acepta subregion como Argentina/Buenos_Aires)
const VALID_TZ_REGEX = /^[A-Za-z_]+(?:\/[A-Za-z_]+){1,2}$/;

let _cached: string | null = null;
let _cachedRaw: string | undefined = undefined;

export function getOpticaTimezone(): string {
  const raw = process.env.OPTICA_TIMEZONE;
  // Memoize while the env value hasn't changed (vitest setEnv per test invalidates).
  if (_cached !== null && raw === _cachedRaw) return _cached;
  _cachedRaw = raw;
  _cached = resolveTimezone(raw);
  return _cached;
}

/** Reset memo. Solo usado en tests (no exportado del barrel). */
export function _resetTimezoneCache(): void {
  _cached = null;
  _cachedRaw = undefined;
}

function resolveTimezone(raw: string | undefined): string {
  if (raw == null) return FALLBACK_TZ;
  const trimmed = raw.trim();
  if (trimmed === '') return FALLBACK_TZ;
  if (!VALID_TZ_REGEX.test(trimmed)) {
    console.warn(
      `[timezone] OPTICA_TIMEZONE inválida formato "${trimmed}", usando fallback ${FALLBACK_TZ}`,
    );
    return FALLBACK_TZ;
  }
  // Validate against Intl when disponible (Node 14+ siempre lo tiene).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    console.warn(
      `[timezone] OPTICA_TIMEZONE "${trimmed}" no reconocida por Intl, usando fallback ${FALLBACK_TZ}`,
    );
    return FALLBACK_TZ;
  }
}
