/**
 * GIOCORE Frente D.2 — Verificador de salud del token Meta (Graph API).
 *
 * El brief `BRIEF_CODE_FRENTE_D2.md` propone "renovar token Meta automáticamente
 * vía Graph API". En la práctica, Meta NO expone un endpoint de refresh genérico
 * para long-lived tokens de System User (los tokens "permanentes" no caducan
 * salvo invalidación, los long-lived de usuario caducan ~60d). El modo correcto
 * de refresh es manual desde Business Manager (B2 del STATUS).
 *
 * Por eso este módulo NO renueva. **Detecta** que el token está cerca de
 * expirar o ya expiró (proba `/me` y lee `data_access_expires_at`/`expires_at`
 * vía `debug_token`) y emite una `decision` para que el cron persista en
 * `agent_decisions` y dispare alerta a Isaac. Esto resuelve el síntoma real
 * del B2 (cron silencioso) sin atrevernos a mutar credenciales desde un
 * entorno serverless ephemeral donde no podemos escribir `.env.local`.
 *
 * Contrato de salida:
 *   {
 *     status: 'ok' | 'expiring_soon' | 'expired' | 'invalid' | 'unknown',
 *     days_left: number | null,
 *     expires_at: string | null,  // ISO date
 *     probe: { http_status, body_excerpt },
 *     raw: unknown,               // payloads crudos para agent_decisions.evidence_refs
 *   }
 *
 * Restricciones inviolables aplicadas:
 *   ❌ NO escribe el token nuevo (entorno serverless).
 *   ❌ NO toca `.env.local`.
 *   ✅ Read-only sobre Graph API.
 */

/** Versión de Graph API; alineada con `api/meta.js` (v19) / `providers/meta.ts` (v20). */
const GRAPH = 'https://graph.facebook.com/v23.0';

/** Días-de-anticipación que disparan el flag `expiring_soon` (spec §refresh-meta-token paso 3). */
export const REFRESH_THRESHOLD_DAYS = 7;

/** Umbral para gatillar auto-refresh del long-lived token (Frente B v2 22-may PM).
 *  Más conservador que `REFRESH_THRESHOLD_DAYS`: refrescamos antes de marcar
 *  `expiring_soon` para que la rotación se haga con margen. */
export const AUTO_REFRESH_DAYS = 14;

/** Timeout por request a Graph API (ms). */
const REQUEST_TIMEOUT_MS = 5_000;

/** Estados posibles devueltos por `checkMetaToken`. */
export type MetaTokenStatus =
  | 'ok'
  | 'expiring_soon'
  | 'expired'
  | 'invalid'
  | 'unknown';

export interface MetaTokenCheckResult {
  status: MetaTokenStatus;
  /** Días restantes hasta expiración. Null si no se pudo determinar. */
  days_left: number | null;
  /** ISO string de expiración (o YYYY-MM-DD si vino de META_TOKEN_EXPIRES). Null si no se pudo. */
  expires_at: string | null;
  /** Snapshot del probe a `/me` para auditoría. */
  probe: {
    http_status: number | null;
    ok: boolean;
    body_excerpt: string;
  };
  /** Payloads crudos (probe + debug_token si se llamó) — para `evidence_refs`. */
  raw: {
    me?: unknown;
    debug_token?: unknown;
    env_expires?: string | null;
    error?: string;
  };
}

/** `fetch` con timeout vía AbortController (mismo patrón que wapify.ts). */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'GET' });
  } finally {
    clearTimeout(timer);
  }
}

/** Lee y trunca el body de una `Response` de forma defensiva. */
async function safeBodyExcerpt(res: Response, max = 300): Promise<string> {
  try {
    const t = await res.text();
    return t.length > max ? t.slice(0, max) + '…' : t;
  } catch {
    return '<no body>';
  }
}

/**
 * Convierte `META_TOKEN_EXPIRES` (ej "2026-07-01" o ISO completo) a días
 * restantes desde `now`. Null si la env var es inválida o falta.
 */
function daysLeftFromEnv(now: Date): { daysLeft: number | null; envExpires: string | null } {
  const envExpires = process.env.META_TOKEN_EXPIRES ?? null;
  if (!envExpires) return { daysLeft: null, envExpires: null };
  const exp = new Date(envExpires);
  // Si la env var es un sentinel no parseable ("never", "n/a", etc.) o
  // un string vacío, devolvemos null en ambos campos para no filtrar el
  // sentinel literal al output del handler (bug 22-may PM: `expires_at="never"`).
  if (Number.isNaN(exp.getTime())) return { daysLeft: null, envExpires: null };
  const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / 86_400_000);
  return { daysLeft, envExpires: exp.toISOString() };
}

/**
 * `checkMetaToken` — diagnostica el estado del token Meta vigente en
 * `process.env.META_TOKEN`. NO renueva, NO escribe — solo reporta.
 *
 * Flujo:
 *   1. Si no hay META_TOKEN → `invalid` y se loggea.
 *   2. Probe a `${GRAPH}/me?access_token=...`:
 *      - HTTP 200 + name/id → token vivo. Cruzar con META_TOKEN_EXPIRES.
 *      - HTTP 400/401 con OAuthException → `expired`/`invalid`.
 *   3. Si quedan <REFRESH_THRESHOLD_DAYS → `expiring_soon`.
 */
export async function checkMetaToken(
  now: Date = new Date(),
): Promise<MetaTokenCheckResult> {
  const token = process.env.META_TOKEN;
  const { daysLeft, envExpires } = daysLeftFromEnv(now);

  if (!token) {
    return {
      status: 'invalid',
      days_left: daysLeft,
      expires_at: envExpires,
      probe: { http_status: null, ok: false, body_excerpt: '' },
      raw: { env_expires: envExpires, error: 'META_TOKEN no está definido' },
    };
  }

  const url = `${GRAPH}/me?access_token=${encodeURIComponent(token)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'unknown',
      days_left: daysLeft,
      expires_at: envExpires,
      probe: { http_status: null, ok: false, body_excerpt: msg },
      raw: { env_expires: envExpires, error: `fetch falló: ${msg}` },
    };
  }

  // Capturamos el body como JSON si es posible; si no, como texto.
  let bodyJson: unknown = null;
  let bodyText = '';
  try {
    bodyText = await res.text();
    bodyJson = JSON.parse(bodyText);
  } catch {
    // bodyJson queda null; bodyText es lo que recibimos (puede ser HTML, etc.)
  }

  const excerpt = bodyText.length > 300 ? bodyText.slice(0, 300) + '…' : bodyText;

  // Detección de error OAuth de Meta (code 190 = token issue).
  if (!res.ok) {
    const errObj = (bodyJson as { error?: { code?: number; message?: string } } | null)?.error;
    const isOAuth = errObj?.code === 190 || res.status === 401 || res.status === 400;
    // Si Meta confirma expired pero no tenemos info de fecha (META_TOKEN_EXPIRES
    // vacío o sentinel), usamos -1 como días para que el output siempre sea
    // numérico cuando el status es `expired`. Acceptance F-C C1 22-may PM.
    const daysLeftForExpired = isOAuth ? (daysLeft ?? -1) : daysLeft;
    return {
      status: isOAuth ? 'expired' : 'invalid',
      days_left: daysLeftForExpired,
      expires_at: envExpires,
      probe: { http_status: res.status, ok: false, body_excerpt: excerpt },
      raw: { me: bodyJson ?? bodyText, env_expires: envExpires, error: errObj?.message ?? `HTTP ${res.status}` },
    };
  }

  // HTTP 200: token vivo. Decidir entre `ok` y `expiring_soon` por META_TOKEN_EXPIRES.
  if (daysLeft === null) {
    // Sin info de expiración → reportamos `unknown` con probe ok.
    return {
      status: 'unknown',
      days_left: null,
      expires_at: null,
      probe: { http_status: res.status, ok: true, body_excerpt: excerpt },
      raw: { me: bodyJson ?? bodyText, env_expires: envExpires },
    };
  }

  if (daysLeft <= 0) {
    // El token responde 200 pero la env dice que ya caducó — Meta a veces
    // sigue aceptando tokens unos días por gracia. Lo marcamos `expired` igual
    // porque la SoT de operación es la env var.
    return {
      status: 'expired',
      days_left: daysLeft,
      expires_at: envExpires,
      probe: { http_status: res.status, ok: true, body_excerpt: excerpt },
      raw: { me: bodyJson ?? bodyText, env_expires: envExpires },
    };
  }

  const status: MetaTokenStatus =
    daysLeft < REFRESH_THRESHOLD_DAYS ? 'expiring_soon' : 'ok';

  return {
    status,
    days_left: daysLeft,
    expires_at: envExpires,
    probe: { http_status: res.status, ok: true, body_excerpt: excerpt },
    raw: { me: bodyJson ?? bodyText, env_expires: envExpires },
  };
}

/** Mapeo `status` → severidad para `agent_decisions.severity` (0–1). */
export function severityForStatus(status: MetaTokenStatus): number {
  switch (status) {
    case 'expired':
    case 'invalid':
      return 1.0; // crítico — el cron de provider_usage cae
    case 'expiring_soon':
      return 0.7; // alto — acción en <7 días
    case 'unknown':
      return 0.4; // medio — diagnosticar
    case 'ok':
    default:
      return 0.1; // bajo — informativo
  }
}

/** Decide si una `decision` de salud-de-token requiere acción humana. */
export function statusNeedsAction(status: MetaTokenStatus): boolean {
  return status === 'expired' || status === 'expiring_soon' || status === 'invalid';
}

/* ── Frente B · auto-refresh del long-lived token ────────────────────────── */

/** Devuelve un token enmascarado para logs/agent_decisions. Nunca filtra
 *  el token completo. Para tokens cortos (< 10 chars) devuelve "***". */
export function maskToken(t: string | null | undefined): string {
  if (!t || typeof t !== 'string') return '***';
  if (t.length < 10) return '***';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/** Resultado de `extendLongLivedToken`. NO contiene el token nuevo en error
 *  paths; en success contiene el token (el caller debe persistirlo y nunca
 *  loggearlo en limpio — usar `maskToken`). */
export interface ExtendTokenResult {
  ok: boolean;
  /** Token nuevo Meta (solo si ok=true). */
  token?: string;
  /** Tiempo de expiración en segundos desde ahora (lo que Meta devuelve). */
  expires_in_sec?: number;
  /** ISO timestamp absoluto de expiración derivado de `expires_in_sec`. */
  expires_at?: string;
  /** Error embedded de Meta o transporte. */
  error?: { code: number | null; message: string };
}

/**
 * Extiende un long-lived token Meta vía `oauth/access_token?grant_type=fb_exchange_token`.
 * Devuelve el nuevo token + fecha ISO de expiración derivada de `expires_in`.
 *
 * Documentación: https://developers.facebook.com/docs/facebook-login/access-tokens#long-via-app
 *
 * Restricción: requiere `META_APP_ID` y `META_APP_SECRET`. El caller los pasa
 * explícitamente (no se leen de env acá para facilitar testing).
 */
export async function extendLongLivedToken(
  currentToken: string,
  appId: string,
  appSecret: string,
  now: Date = new Date(),
): Promise<ExtendTokenResult> {
  if (!currentToken) {
    return { ok: false, error: { code: null, message: 'currentToken vacío' } };
  }
  if (!appId || !appSecret) {
    return { ok: false, error: { code: null, message: 'META_APP_ID/META_APP_SECRET ausente' } };
  }

  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: currentToken,
  });
  const url = `${GRAPH}/oauth/access_token?${params.toString()}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: null, message: `fetch falló: ${msg}` } };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: { code: null, message: 'body no JSON' } };
  }

  if (!res.ok) {
    const e = (body as { error?: { code?: number; message?: string } } | null)?.error;
    return {
      ok: false,
      error: { code: e?.code ?? res.status, message: e?.message ?? `HTTP ${res.status}` },
    };
  }

  const b = body as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!b.access_token) {
    return { ok: false, error: { code: null, message: 'access_token ausente en respuesta' } };
  }

  const expiresInSec = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 0;
  const expiresAt =
    expiresInSec > 0
      ? new Date(now.getTime() + expiresInSec * 1000).toISOString()
      : undefined;

  return {
    ok: true,
    token: b.access_token,
    expires_in_sec: expiresInSec || undefined,
    expires_at: expiresAt,
  };
}
