/**
 * GIOCORE Frente C — Enriquecimiento de `contacts` con name/phone/email
 * vía `GET /api/contacts/{contact_id}` de Wapify.
 *
 * Spec: PROMPT_CODE_LOTE_v2.md §FRENTE C (T7-T9).
 *
 * Contexto: tras D.2 `sync-wapify-cache`, la tabla `contacts` tiene 4,7k+ rows
 * con name/phone/email en NULL — el endpoint `/pipelines/{pid}/opportunities`
 * solo trae `contact_id` (string). Este módulo llama `/api/contacts/{cid}`
 * por contact_id distinto, con throttle conservador para respetar el quota
 * Wapify (100 req/60s = ~1.5s entre requests).
 *
 * Shape Wapify `/api/contacts/{id}` (probe 22-may PM):
 *   id, full_name, first_name, last_name, phone, email,
 *   country, channel, account_id, archived, blocked,
 *   created_at, last_interaction, last_seen, last_sent, last_delivered,
 *   external_id, gender, live_chat, locale, page_id, profile_pic,
 *   subscribed, subscribed_date, timezone
 *
 * Wapify quirks aplicables (memory `project-giocore-wapify-quirks`):
 *   1. HTTP 200 con `{error:{code:N}}` en body para rate-limit/error → parsear body.
 *   2. `email` puede venir como `""` (string vacío) → tratar como null.
 *   3. 404 ⇒ contact_id huérfano → marcar `contact_id_invalid=true` para no retry.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const WAPIFY_BASE = 'https://ap.whapify.ai/api';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 3;

export interface EnrichResult {
  processed: number;
  enriched: number;
  failed: number;
  invalid: number;
  rate_limited_retries: number;
  notes: string[];
}

export interface EnrichOptions {
  /** Cuántos contact_ids únicos procesar por run. Default 50. */
  batchSize?: number;
  /** Sleep entre requests Wapify. Default 1500 ms (~40 req/min). */
  throttleMs?: number;
  /** Si true, no ejecuta UPDATE en Supabase. */
  dry_run?: boolean;
}

/* ── HTTP helpers (self-contained: no shared dep con wapify-sync.ts) ─────── */

async function fetchWithTimeout(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { 'X-ACCESS-TOKEN': token, Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Resultado discriminado del fetch de un contacto. */
type ContactFetch =
  | { type: 'ok'; payload: WapifyContactResponse; retries: number }
  | { type: 'invalid'; reason: string }      // 404 / contact_id huérfano
  | { type: 'rate_limited'; retries: number } // 429 persistente tras maxRetries
  | { type: 'error'; reason: string };        // otros errores

interface WapifyContactResponse {
  id?: string | number;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
}

async function fetchContact(contactId: string, token: string): Promise<ContactFetch> {
  const url = `${WAPIFY_BASE}/contacts/${encodeURIComponent(contactId)}`;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: 'error', reason: `network: ${msg}` };
    }

    if (res.status === 404) return { type: 'invalid', reason: 'HTTP 404' };
    if (res.status === 429) {
      retries++;
      if (attempt === MAX_RATE_LIMIT_RETRIES) {
        return { type: 'rate_limited', retries };
      }
      const wait = Math.min(2 ** attempt * 1500, 12_000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) return { type: 'error', reason: `HTTP ${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { type: 'error', reason: 'body no JSON' };
    }

    // Wapify quirk: HTTP 200 con error embedded.
    if (body && typeof body === 'object' && 'error' in body) {
      const e = (body as { error?: { code?: unknown; message?: unknown } }).error;
      const code = typeof e?.code === 'string' ? Number(e.code) : e?.code;
      if (code === 429) {
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          retries++;
          const wait = Math.min(2 ** attempt * 1500, 12_000);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        // Retries agotados con body-level 429 → tratar como rate_limited (break loop en caller).
        return { type: 'rate_limited', retries };
      }
      if (code === 404) return { type: 'invalid', reason: `Wapify 404: ${String(e?.message ?? '')}` };
      return { type: 'error', reason: `Wapify ${code}: ${String(e?.message ?? '')}` };
    }

    return { type: 'ok', payload: body as WapifyContactResponse, retries };
  }
  return { type: 'rate_limited', retries };
}

/* ── Normalización del response a campos de la tabla `contacts` ──────────── */

function pickName(payload: WapifyContactResponse): string | null {
  const fn = (payload.full_name ?? '').trim();
  if (fn) return fn;
  const composed = [payload.first_name, payload.last_name]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .trim();
  return composed || null;
}

function pickPhone(payload: WapifyContactResponse): string | null {
  const p = (payload.phone ?? '').trim();
  return p || null;
}

function pickEmail(payload: WapifyContactResponse): string | null {
  const e = (payload.email ?? '').trim();
  return e || null;
}

/* ── Selección de candidatos pendientes (idempotente, dedupe en JS) ──────── */

async function selectPendingContactIds(
  supabase: SupabaseClient,
  batchSize: number,
): Promise<string[]> {
  // Sobre-fetch porque mismo contact_id aparece en N opportunities; dedupe en JS.
  // Limit defensivo: batchSize × 10 (cubre pipelines grandes con muchas opp/contacto).
  const oversample = Math.max(batchSize * 10, 100);
  const { data, error } = await supabase
    .from('contacts')
    .select('contact_id')
    .or('name.is.null,phone.is.null,email.is.null')
    .not('contact_id', 'is', null)
    .eq('contact_id_invalid', false)
    .limit(oversample);

  if (error) throw new Error(`select pending: ${error.message}`);
  const rows = (data ?? []) as { contact_id: string | null }[];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of rows) {
    if (!r.contact_id || seen.has(r.contact_id)) continue;
    seen.add(r.contact_id);
    unique.push(r.contact_id);
    if (unique.length >= batchSize) break;
  }
  return unique;
}

/* ── Función pública ─────────────────────────────────────────────────────── */

export async function enrichContacts(
  supabase: SupabaseClient,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const batchSize = options.batchSize ?? 50;
  const throttleMs = options.throttleMs ?? 1500;
  const dryRun = options.dry_run ?? false;

  const token = process.env.WAPIFY_TOKEN;
  if (!token) {
    throw new Error('WAPIFY_TOKEN no está definido en el entorno (process.env)');
  }

  const result: EnrichResult = {
    processed: 0,
    enriched: 0,
    failed: 0,
    invalid: 0,
    rate_limited_retries: 0,
    notes: [],
  };

  const contactIds = await selectPendingContactIds(supabase, batchSize);
  result.processed = contactIds.length;
  if (contactIds.length === 0) {
    result.notes.push('No hay contact_ids pendientes de enrich.');
    return result;
  }

  for (let i = 0; i < contactIds.length; i++) {
    const cid = contactIds[i];
    if (i > 0) await new Promise((r) => setTimeout(r, throttleMs));

    const fetched = await fetchContact(cid, token);

    if (fetched.type === 'invalid') {
      result.invalid++;
      if (!dryRun) {
        await supabase
          .from('contacts')
          .update({ contact_id_invalid: true })
          .eq('contact_id', cid);
      }
      continue;
    }
    if (fetched.type === 'rate_limited') {
      result.failed++;
      result.rate_limited_retries += fetched.retries;
      result.notes.push(`rate-limited persistente en contact_id=${cid}`);
      // Importante: si Wapify dejó de responder, no seguimos para no quemar quota.
      break;
    }
    if (fetched.type === 'error') {
      result.failed++;
      result.notes.push(`error en contact_id=${cid}: ${fetched.reason}`);
      continue;
    }

    // type === 'ok'
    result.rate_limited_retries += fetched.retries;
    const payload = fetched.payload;
    const update: {
      name: string | null;
      phone: string | null;
      email: string | null;
      enriched_at: string;
    } = {
      name: pickName(payload),
      phone: pickPhone(payload),
      email: pickEmail(payload),
      enriched_at: new Date().toISOString(),
    };

    if (dryRun) {
      result.enriched++;
      continue;
    }

    const { error } = await supabase
      .from('contacts')
      .update(update)
      .eq('contact_id', cid);
    if (error) {
      result.failed++;
      result.notes.push(`update fallo contact_id=${cid}: ${error.message}`);
    } else {
      result.enriched++;
    }
  }

  return result;
}
