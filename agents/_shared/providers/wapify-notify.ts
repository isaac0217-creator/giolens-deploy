/**
 * GIOCORE Frente E · 1.2 — Helper para enviar mensajes WhatsApp vía Wapify.
 *
 * Usado por `api/cron/alertas-stock-bajo.ts` y `api/cron/refresh-rotacion.ts`
 * (este último solo en path de error). Mantiene los mismos patrones defensivos
 * que `wapify-sync.ts`:
 *   - Token desde `WAPIFY_TOKEN` env, header `X-ACCESS-TOKEN`.
 *   - Wapify devuelve HTTP 200 con `{error:{code:N}}` para errores → parsear body.
 *   - Backoff exponencial body-level 429/503: 1s, 2s, 4s (cap 8s).
 *   - fetch nativo Node 22 con AbortController timeout.
 *
 * Decisión vs. brief: NO usa `node-fetch` (Node 22 trae fetch global; mantenemos
 * cero deps nuevas runtime).
 *
 * Edge cases que el helper maneja silently:
 *   - WAPIFY_TOKEN ausente → return { ok: false, error: 'no_token' } (no throw).
 *   - HTTP 5xx → retry hasta maxRetries y devolver detalle.
 *   - Endpoint /send-message no existe (HTTP 404) → ok=false body_error_code=404.
 *
 * NUNCA loggea el token. NUNCA loguea el mensaje completo si contiene PII
 * (los callers son responsables de no incluir teléfonos/contactos).
 */

const WAPIFY_BASE = 'https://ap.whapify.ai/api';
const SEND_PATH = '/send-message';
const ACCOUNT_ID = '1187373';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 8000;

/* ── Tipos ──────────────────────────────────────────────────────────────── */

export interface WapifyNotifyResult {
  ok: boolean;
  /** Si body devolvió `{error:{code:N}}` (Wapify quirk). */
  body_error_code?: number | string;
  body_error_message?: string;
  /** Si HTTP status NO ok (red/5xx). */
  http_status?: number;
  /** Si el handler error'd antes de pegarle a Wapify. */
  error?: string;
  retries: number;
  message_id?: string;
}

export interface SendOptions {
  maxRetries?: number;
  /** Override del token (tests). */
  token?: string;
  /** Override del account_id (tests). */
  account_id?: string;
  /** Función de sleep inyectable (tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  // attempt 1 → 1s, attempt 2 → 2s, attempt 3 → 4s
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ── Función principal ──────────────────────────────────────────────────── */

/**
 * Envía un mensaje WhatsApp via Wapify. NO lanza — siempre devuelve un
 * `WapifyNotifyResult` con `ok` y detalle del error si aplica.
 */
export async function sendWhatsApp(
  numero: string,
  mensaje: string,
  opts: SendOptions = {},
): Promise<WapifyNotifyResult> {
  const token = opts.token ?? process.env.WAPIFY_TOKEN;
  if (!token) {
    return { ok: false, error: 'WAPIFY_TOKEN no está en el entorno', retries: 0 };
  }
  if (!numero || typeof numero !== 'string') {
    return { ok: false, error: 'numero (string) requerido', retries: 0 };
  }
  if (!mensaje || typeof mensaje !== 'string') {
    return { ok: false, error: 'mensaje (string) requerido', retries: 0 };
  }

  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleepFn ?? defaultSleep;
  const accountId = opts.account_id ?? ACCOUNT_ID;
  const url = `${WAPIFY_BASE}${SEND_PATH}`;
  const body = JSON.stringify({ account_id: accountId, phone: numero, message: mensaje });

  let lastResult: WapifyNotifyResult = { ok: false, retries: 0 };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs(attempt));
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'X-ACCESS-TOKEN': token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body,
        },
        REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      // Timeout / network error → retry si quedan intentos.
      lastResult = {
        ok: false,
        error: `network: ${err instanceof Error ? err.message : String(err)}`,
        retries: attempt,
      };
      continue;
    }

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // No-JSON body — Wapify a veces devuelve plain text en errores 5xx.
      payload = null;
    }

    // Wapify quirk: HTTP 200 con body { error: { code, message } }
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      const errBlock = obj.error;
      if (errBlock && typeof errBlock === 'object') {
        const e = errBlock as Record<string, unknown>;
        const code = e.code as number | string | undefined;
        const msg = (e.message as string | undefined) ?? '';
        // 429 (rate limit) y 503 (service unavailable) → retry con backoff.
        if (code === 429 || code === 503 || code === '429' || code === '503') {
          lastResult = {
            ok: false,
            body_error_code: code,
            body_error_message: msg,
            retries: attempt,
          };
          continue;
        }
        // Otros body-level errors son terminales (404 endpoint, etc.).
        return {
          ok: false,
          body_error_code: code,
          body_error_message: msg,
          retries: attempt,
        };
      }
    }

    // HTTP no-ok sin body-level error → retry si 5xx, terminar si 4xx.
    if (!res.ok) {
      if (res.status >= 500 && res.status < 600) {
        lastResult = { ok: false, http_status: res.status, retries: attempt };
        continue;
      }
      return { ok: false, http_status: res.status, retries: attempt };
    }

    // Éxito — extraer message_id si vino.
    const messageId =
      payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).message_id as string | undefined) ??
          ((payload as Record<string, unknown>).id as string | undefined)
        : undefined;
    return { ok: true, retries: attempt, message_id: messageId };
  }

  return { ...lastResult, retries: maxRetries };
}
