/**
 * agents/_shared/providers/gcal.ts — cliente Google Calendar (Service Account).
 *
 * Frente G · Sesión 10. Hogar canónico del cliente GCal del proyecto:
 *   - getGCalToken()   — OAuth2 vía Service Account JWT (RS256, crypto nativo,
 *                        sin googleapis npm). Extraído de api/citas.ts para
 *                        reuso por el cron pull-gcal (DECISION_DOBLE_ESCRITURA
 *                        _CALENDAR.md §3.2 "reusar cliente SA del frente G").
 *   - listGCalEvents() — lista eventos de un calendario en una ventana temporal
 *                        (singleEvents=true para expandir recurrencias), con
 *                        paginación. NUEVO para la opción (a) de doble-escritura.
 *
 * Envs (nunca al repo): GCAL_SERVICE_ACCOUNT_JSON, GCAL_CALENDAR_ID.
 * Degradación: si falta credencial o la API falla, las funciones devuelven null
 * (el caller responde 200 + _warnings, nunca 500 — no romper el scheduler).
 *
 * PII: este módulo NO loggea nombre/teléfono/email. Los eventos pueden traer
 * datos del paciente en summary/description; es responsabilidad del caller no
 * persistirlos (el cron sólo deriva fecha/hora/gcal_event_id + hash).
 */

import { createSign } from 'crypto';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface GCalEventDateTime {
  dateTime?: string; // RFC3339 con offset, ej. 2026-05-28T10:00:00-07:00
  date?: string;     // all-day, ej. 2026-05-28
  timeZone?: string;
}

export interface GCalEvent {
  id: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  start?: GCalEventDateTime;
  end?: GCalEventDateTime;
}

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const FETCH_TIMEOUT_MS = 8000;
const MAX_PAGES = 10; // tope defensivo de paginación (2500 ev/pág × 10 = 25k)

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Obtiene access_token de Google OAuth2 usando Service Account JWT.
 *  Devuelve null (no lanza) ante cualquier fallo, para degradación graceful. */
export async function getGCalToken(): Promise<string | null> {
  const saJson = process.env.GCAL_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    console.warn('[gcal] GCAL_SERVICE_ACCOUNT_JSON no configurado — GCal desactivado');
    return null;
  }
  let sa: ServiceAccountKey;
  try {
    sa = JSON.parse(saJson) as ServiceAccountKey;
  } catch {
    console.error('[gcal] GCAL_SERVICE_ACCOUNT_JSON no es JSON válido');
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: OAUTH_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const signing = `${header}.${claim}`;
  let sig: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signing);
    sig = b64url(signer.sign(sa.private_key));
  } catch (err) {
    console.error('[gcal] Error firmando JWT:', err instanceof Error ? err.message : String(err));
    return null;
  }
  const jwt = `${signing}.${sig}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const data = await res.json() as { access_token?: string; error?: string };
    if (!data.access_token) {
      console.error('[gcal] Token error:', data.error ?? JSON.stringify(data));
      return null;
    }
    return data.access_token;
  } catch (err) {
    console.error('[gcal] getGCalToken fetch error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Lista eventos de un calendario en [timeMin, timeMax] (RFC3339).
 * - singleEvents=true expande recurrencias a instancias individuales.
 * - showDeleted=false: no trae cancelados (Path A cancelado no debe re-insertarse).
 * - Pagina hasta MAX_PAGES.
 * Devuelve null ante fallo de credencial/red/API (degradación graceful);
 * devuelve [] si el calendario no tiene eventos en la ventana.
 */
export async function listGCalEvents(opts: {
  timeMin: string;
  timeMax: string;
  calendarId?: string;
}): Promise<GCalEvent[] | null> {
  const calendarId = opts.calendarId ?? process.env.GCAL_CALENDAR_ID;
  if (!calendarId) {
    console.warn('[gcal] GCAL_CALENDAR_ID no configurado — skip listGCalEvents');
    return null;
  }
  const token = await getGCalToken();
  if (!token) return null;

  const events: GCalEvent[] = [];
  let pageToken: string | undefined;
  let page = 0;

  try {
    do {
      const params = new URLSearchParams({
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        showDeleted: 'false',
        maxResults: '2500',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal },
      );
      clearTimeout(timer);

      const body = await res.json() as {
        items?: GCalEvent[];
        nextPageToken?: string;
        error?: unknown;
      };
      if (!res.ok || body.error) {
        console.error('[gcal] listGCalEvents API error:', res.status, JSON.stringify(body.error ?? {}));
        return null;
      }
      for (const ev of body.items ?? []) {
        if (ev && typeof ev.id === 'string') events.push(ev);
      }
      pageToken = body.nextPageToken;
      page++;
    } while (pageToken && page < MAX_PAGES);
  } catch (err) {
    console.error('[gcal] listGCalEvents fetch error:', err instanceof Error ? err.message : String(err));
    return null;
  }

  return events;
}
