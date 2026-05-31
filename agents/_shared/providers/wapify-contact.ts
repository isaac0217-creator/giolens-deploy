/**
 * agents/_shared/providers/wapify-contact.ts — lookup PII single-shot del CRM Whapify.
 *
 * Lee nombre + teléfono de un contacto por `contact_id` vía
 * `GET https://ap.whapify.ai/api/contacts/{contact_id}` (header X-ACCESS-TOKEN).
 *
 * Diferencia con `wapify-enrich.ts` (que enriquece `contacts` en lote): este helper
 * es de UN SOLO intento, timeout corto y SIN reintentos — pensado para la ruta
 * SÍNCRONA del endpoint de captura de citas (api/citas/from-whapify), donde NO se
 * puede bloquear el flujo del bot. Best-effort por contrato: ante CUALQUIER fallo
 * (token ausente, red, timeout, 404, rate-limit, shape raro) devuelve `null` — el
 * caller persiste la cita igual con nombre/teléfono NULL (degradación elegante).
 *
 * Shape Wapify `/api/contacts/{id}` (probe 22-may, ver wapify-enrich.ts):
 *   id, full_name, first_name, last_name, phone, email, ...
 *
 * Quirks de Whapify tolerados (memory `project-giocore-wapify-quirks`):
 *   1. HTTP 200 con body `{error:{code:N}}` para 404/rate-limit → tratar como fallo.
 *   2. campos string vacíos `""` → null.
 *
 * PII: NUNCA loguea el nombre/teléfono ni el body crudo. El único log posible es un
 *      motivo de fallo SIN datos del contacto.
 */

const WAPIFY_BASE = 'https://ap.whapify.ai/api';
const DEFAULT_TIMEOUT_MS = 3_500;

export interface ContactPII {
  /** Nombre del paciente (full_name, o first+last compuesto). null si no hay. */
  nombre: string | null;
  /** Teléfono del paciente. null si no hay. */
  telefono: string | null;
}

interface WapifyContactResponse {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
}

function pickNombre(payload: WapifyContactResponse): string | null {
  const fn = (payload.full_name ?? '').trim();
  if (fn) return fn;
  const composed = [payload.first_name, payload.last_name]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .trim();
  return composed || null;
}

function pickTelefono(payload: WapifyContactResponse): string | null {
  const p = (payload.phone ?? '').trim();
  return p || null;
}

/**
 * `fetchContactPII` — lookup best-effort de nombre/teléfono por contact_id.
 *
 * Devuelve `{ nombre, telefono }` (cualquiera puede ser null individualmente) o
 * `null` si el contacto no se pudo resolver. NUNCA lanza (atrapa todo internamente).
 */
export async function fetchContactPII(
  contactId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ContactPII | null> {
  const token = process.env.WAPIFY_TOKEN;
  if (!token || !contactId) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${WAPIFY_BASE}/contacts/${encodeURIComponent(contactId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-ACCESS-TOKEN': token, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null; // 404/429/5xx → degradar a null

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null; // body no-JSON
    }

    // Quirk 1: HTTP 200 con error embedded (404/rate-limit) → fallo.
    if (body && typeof body === 'object' && 'error' in body) return null;
    if (!body || typeof body !== 'object') return null;

    const payload = body as WapifyContactResponse;
    return { nombre: pickNombre(payload), telefono: pickTelefono(payload) };
  } catch {
    // Red / timeout / abort: degradar, NUNCA propagar (no romper el flujo del bot).
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default fetchContactPII;
