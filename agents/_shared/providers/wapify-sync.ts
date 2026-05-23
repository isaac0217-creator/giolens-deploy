/**
 * GIOCORE Frente D.2 — Sync delta de contactos Wapify → tabla `contacts`.
 *
 * Spec: BRIEF_CODE_FRENTE_D2.md §sync-wapify-cache.
 *
 * Diferencias con el brief (justificadas por entorno serverless):
 *   - El brief habla de SQLite local + `INDEX_PIPELINE_X.md`. En Vercel no hay
 *     filesystem persistente, así que sync va a Supabase tabla `contacts`
 *     (ya existe en supabase-schema.sql:16; id BIGINT PK con pipeline_id).
 *   - `sync_state` por pipeline: se persiste en `knowledge_base` (category=
 *     'wapify_sync_state', key=`pipeline_<id>`) en vez de una tabla nueva.
 *     Evita migración 004 para un timestamp por pipeline.
 *   - Los `INDEX_PIPELINE_X.md` NO se regeneran desde el cron (filesystem
 *     ephemeral). Se documenta como TODO operativo: regeneración via script
 *     local de Isaac cuando lo necesite.
 *
 * Restricciones inviolables (BRIEF §sync-wapify-cache):
 *   ❌ NO mutar contactos en Wapify (este módulo SOLO hace GET).
 *   ❌ Pipelines protegidos (252999 SPY, 273944 GioVision): allowed para
 *      lectura, JAMÁS escritura. Como acá solo leemos de Wapify y escribimos
 *      a Supabase.contacts, no se mutan en Wapify — OK.
 *   ❌ NO regenerar `.md` por contacto.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/* ── Configuración ──────────────────────────────────────────────────────── */

const WAPIFY_BASE = 'https://ap.whapify.ai/api';

/**
 * Endpoint correcto de contactos por pipeline (alineado con `api/pipeline-summary.js`,
 * que ya corre en prod). Patch 22-may-2026 PM: el path `/contacts` (hint legacy de
 * CLAUDE.md) devolvía HTTP 200 con `{error:{code:405}}` porque no existe; el path
 * real es `pipelines/{pid}/opportunities?offset=N&limit=100`.
 */
const OPPORTUNITIES_PATH = (pid: number, offset: number, limit: number) =>
  `pipelines/${pid}/opportunities?offset=${offset}&limit=${limit}`;

const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
const MAX_RETRIES_PER_PAGE = 3;

/** Los 5 pipelines activos (CLAUDE.md). */
export const PIPELINES: ReadonlyArray<{ id: number; name: string; protected: boolean }> = [
  { id: 216977, name: 'Justin/Holbrook/Litebeam', protected: false },
  { id: 755062, name: 'GioSports Deportivo',     protected: false },
  { id: 94103,  name: 'Dama Luxury',             protected: false },
  // Read-only allowed (no se mutan en Wapify), pero se marcan para que cualquier
  // futuro tool de mutación los excluya automáticamente.
  { id: 252999, name: 'SPY Seguridad Z87',       protected: true },
  { id: 273944, name: 'GioVision Entintados',    protected: true },
];

/** Stage-phase normalizado (alineado a contacts.stage_phase del schema). */
export type StagePhase = 'int1' | 'int2' | 'int3' | 'closing' | 'won' | 'lost' | 'other';

/* ── Tipos ──────────────────────────────────────────────────────────────── */

export interface WapifyContact {
  /** id de Wapify (BIGINT). */
  id: number;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  pipeline_id: number;
  stage_name?: string | null;
  stage_phase?: StagePhase | null;
  last_message?: string | null;
  last_message_at?: string | null;
  /** Payload completo del API por si después necesitamos extraer más campos. */
  raw_payload?: unknown;
}

export interface PipelineSyncResult {
  pipeline_id: number;
  pipeline_name: string;
  /** ISO timestamp del sync previo (lo que persistimos antes de este run). */
  previous_sync_at: string | null;
  /** ISO timestamp de este run (lo que se va a persistir como nuevo `previous_sync_at`). */
  current_sync_at: string;
  contacts_fetched: number;
  contacts_upserted: number;
  /** Si dry_run, NO se hizo upsert ni se actualizó sync_state. */
  dry_run: boolean;
  pages_fetched: number;
  /** Notas sobre limitaciones detectadas (HTTP errores, paginación, etc.). */
  notes: string[];
  errors: string[];
}

export interface SyncOptions {
  /** Si se setea, solo sincroniza ese pipeline. Si no, los 5. */
  pipeline_id?: number;
  /** Si true, no escribe en Supabase ni actualiza sync_state. Default false. */
  dry_run?: boolean;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

async function fetchWithTimeout(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        'X-ACCESS-TOKEN': token,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch con backoff exponencial sobre HTTP 429 (rate limit Wapify).
 * Base 1s, cap 8s, hasta `maxRetries` reintentos (default 3 → 4 intentos total).
 * Respeta `Retry-After` (segundos) si Wapify lo devuelve. Si el último intento
 * sigue 429, devuelve esa respuesta para que el caller agregue la nota.
 *
 * Patch F-W · 22-may-2026 PM: antes solo `fetchWithTimeout` directo →
 * 5/5 pipelines fallaban con 429 en la primera página y rompía la paginación.
 */
async function fetchWithBackoff(
  url: string,
  token: string,
  maxRetries = 3,
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchWithTimeout(url, token);
    last = res;
    if (res.status !== 429 || attempt === maxRetries) return res;
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const wait =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 8000)
        : Math.min(2 ** attempt * 1000, 8000);
    await new Promise((r) => setTimeout(r, wait));
  }
  // Defensive (loop siempre return cuando attempt === maxRetries).
  return last as Response;
}

/** Extrae el array de contactos del payload sin asumir un shape único. */
function extractList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['data', 'contacts', 'items', 'results', 'rows']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

/** Sanitiza un timestamp Wapify a ISO o null. Wapify devuelve "0000-00-00 00:00:00"
 *  para opportunities sin fecha — Postgres timestamp rechaza ese valor con
 *  "date/time field value out of range". Devolver null en esos casos. */
function sanitizeDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  // Zero-date Wapify-style (también captura "0000-00-00", "0001-01-01").
  if (raw.startsWith('0000-') || raw.startsWith('0001-')) return null;
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Mapea un stage_name libre a `stage_phase` controlled-vocab. */
function inferStagePhase(stageName?: string | null): StagePhase | null {
  if (!stageName) return null;
  const s = stageName.toLowerCase();
  if (s.includes('cerrado') || s.includes('ganado') || s.includes('won')) return 'won';
  if (s.includes('perdido') || s.includes('lost') || s.includes('descart')) return 'lost';
  if (s.includes('cierre') || s.includes('closing')) return 'closing';
  if (s.includes('3') || s.includes('tercer')) return 'int3';
  if (s.includes('2') || s.includes('segund')) return 'int2';
  if (s.includes('1') || s.includes('primer')) return 'int1';
  return 'other';
}

/** Normaliza un opportunity crudo de Wapify al shape de la tabla `contacts`.
 *
 * Shape Wapify (post-discovery 22-may PM, endpoint `/pipelines/{pid}/opportunities`):
 *   {
 *     id: "119",                          // string en wire, parseable a number
 *     name: string | null,                // a veces en root, a veces en contact
 *     phone: string | null,
 *     email: string | null,
 *     stage: { id: number, name: string }, // objeto, NO string
 *     contact: { name, phone, email } | null,
 *     updated_at, created_at, ...
 *   }
 */
function normalizeContact(raw: unknown, pipelineId: number): WapifyContact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'number' ? r.id : Number(r.id);
  if (!Number.isFinite(id)) return null;

  // `stage` puede venir como objeto {id,name} (endpoint /opportunities) o como
  // string (endpoints legacy / mocks de test). Soportamos ambos.
  const stageRaw = r.stage;
  let stageName: string | null = null;
  if (typeof stageRaw === 'string') {
    stageName = stageRaw;
  } else if (stageRaw && typeof stageRaw === 'object') {
    stageName = ((stageRaw as Record<string, unknown>).name as string | null | undefined) ?? null;
  }
  stageName =
    stageName ??
    (r.stage_name as string | null | undefined) ??
    (r.opportunity_stage as string | null | undefined) ??
    null;

  // `contact` nested puede tener name/phone/email; root también puede tenerlos.
  // Preferimos root, fallback a contact.* (defensive — Wapify devuelve estructura
  // distinta según pipeline / configuración).
  const contactObj =
    r.contact && typeof r.contact === 'object'
      ? (r.contact as Record<string, unknown>)
      : null;

  const pickStr = (key: string): string | null => {
    const rootVal = r[key];
    if (typeof rootVal === 'string' && rootVal) return rootVal;
    if (contactObj) {
      const nested = contactObj[key];
      if (typeof nested === 'string' && nested) return nested;
    }
    return null;
  };

  return {
    id,
    name: pickStr('name') ?? pickStr('full_name'),
    phone: pickStr('phone'),
    email: pickStr('email'),
    pipeline_id: pipelineId,
    stage_name: stageName,
    stage_phase: inferStagePhase(stageName),
    last_message: (r.last_message as string | null | undefined) ?? null,
    last_message_at: sanitizeDate(r.last_message_at ?? r.updated_at),
    raw_payload: raw,
  };
}

/* ── Sync state (en knowledge_base — evita migración 004) ──────────────── */

const SYNC_STATE_CATEGORY = 'wapify_sync_state';

function syncStateKey(pipelineId: number): string {
  return `pipeline_${pipelineId}`;
}

/** Lee el timestamp del último sync de un pipeline desde knowledge_base. */
async function readSyncState(
  supabase: SupabaseClient,
  pipelineId: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('content')
    .eq('category', SYNC_STATE_CATEGORY)
    .eq('key', syncStateKey(pipelineId))
    .maybeSingle();
  if (error) {
    // No relanzar — first-run sin estado previo es válido.
    return null;
  }
  if (!data || !data.content) return null;
  const c = data.content as { last_sync_at?: string };
  return c.last_sync_at ?? null;
}

/** Persiste el timestamp del nuevo sync en knowledge_base (upsert por key). */
async function writeSyncState(
  supabase: SupabaseClient,
  pipelineId: number,
  syncAt: string,
  stats: { contacts_upserted: number; pages_fetched: number },
): Promise<void> {
  // knowledge_base tiene PK por (category, key) o sólo key? Verificamos por upsert
  // sobre key únicamente. Si el schema no soporta upsert, hacemos delete+insert.
  // Schema confirma: knowledge_base tiene category+key como índice (no único per se),
  // así que el patrón seguro es delete + insert atómicos.
  await supabase
    .from('knowledge_base')
    .delete()
    .eq('category', SYNC_STATE_CATEGORY)
    .eq('key', syncStateKey(pipelineId));

  await supabase.from('knowledge_base').insert({
    category: SYNC_STATE_CATEGORY,
    key: syncStateKey(pipelineId),
    content: {
      last_sync_at: syncAt,
      contacts_upserted: stats.contacts_upserted,
      pages_fetched: stats.pages_fetched,
    },
  });
}

/* ── Fetch + upsert por pipeline ────────────────────────────────────────── */

async function fetchPipelineContacts(
  pipelineId: number,
  token: string,
  updatedAfter: string | null,
): Promise<{ contacts: WapifyContact[]; pages: number; notes: string[] }> {
  const notes: string[] = [];
  const contacts: WapifyContact[] = [];
  let pages = 0;

  // Nota: `updatedAfter` queda registrada en knowledge_base pero el endpoint
  // `/pipelines/{pid}/opportunities` no acepta filtro server-side por updated_at,
  // así que el sync trae todo y el upsert por id provee idempotencia.
  void updatedAfter;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const offset = (page - 1) * PAGE_LIMIT;
    const url = `${WAPIFY_BASE}/${OPPORTUNITIES_PATH(pipelineId, offset, PAGE_LIMIT)}`;

    // Retry loop per page: cubre tanto HTTP 429 (status) como Wapify quirk
    // de HTTP 200 + body {error:{code:429,message:"...exceeded the limit..."}}.
    let payload: unknown = null;
    let pageFailed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PAGE; attempt++) {
      let res: Response;
      try {
        res = await fetchWithBackoff(url, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`Network error en page ${page}: ${msg}`);
        pageFailed = true;
        break;
      }
      if (!res.ok) {
        notes.push(`HTTP ${res.status} en page ${page} (pipeline ${pipelineId})`);
        pageFailed = true;
        break;
      }
      try {
        payload = await res.json();
      } catch {
        notes.push(`Body no-JSON en page ${page}`);
        pageFailed = true;
        break;
      }

      // Wapify quirk: HTTP 200 con {error:{code:429,...}} → rate-limit en body.
      // Reintentamos con backoff. Otros códigos (404, 405, etc.) son fatales para la página.
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const e = (payload as { error?: { code?: unknown; message?: unknown } }).error;
        const code = typeof e?.code === 'string' ? Number(e.code) : e?.code;
        if (code === 429 && attempt < MAX_RETRIES_PER_PAGE) {
          const wait = Math.min(2 ** attempt * 1500, 12_000);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        notes.push(`Wapify error object (code ${e?.code}): ${String(e?.message ?? 'unknown')}`);
        pageFailed = true;
        break;
      }
      // Success — salimos del retry loop.
      break;
    }
    if (pageFailed) break;

    const list = extractList(payload);
    if (list === null) {
      notes.push(`Shape irreconocible en page ${page} (claves esperadas: data/contacts/items/results/rows)`);
      break;
    }

    for (const raw of list) {
      const c = normalizeContact(raw, pipelineId);
      if (c) contacts.push(c);
    }
    pages = page;

    if (list.length < PAGE_LIMIT) break; // página incompleta = fin
    if (page === MAX_PAGES) {
      notes.push(`Truncado en MAX_PAGES=${MAX_PAGES}, paginación no terminó`);
    }
  }

  return { contacts, pages, notes };
}

/** Upsert masivo de contactos en Supabase `contacts`. Devuelve cantidad escrita. */
async function upsertContacts(
  supabase: SupabaseClient,
  contacts: WapifyContact[],
): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = [];
  if (contacts.length === 0) return { upserted: 0, errors };

  // Wapify a veces devuelve la misma opportunity en páginas adyacentes
  // (paginación por offset no es transaccional). Dedupe por id: el último
  // gana (refleja el estado más reciente fetcheado en este run). Sin esto,
  // Postgres falla el batch entero con:
  //   "ON CONFLICT DO UPDATE command cannot affect row a second time"
  // Patch 22-may-2026 PM tras T6 reportar 11 batch errors / 4574 lost rows.
  const byId = new Map<number, WapifyContact>();
  for (const c of contacts) byId.set(c.id, c);
  const deduped = [...byId.values()];

  // Upsert por id (PK). El schema tiene `updated_at` con trigger automático.
  const rows = deduped.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    pipeline_id: c.pipeline_id,
    stage_name: c.stage_name,
    stage_phase: c.stage_phase,
    last_message: c.last_message,
    last_message_at: c.last_message_at,
    raw_payload: c.raw_payload,
  }));

  // Batchear de a 500 para no exceder límites de tamaño de payload.
  const BATCH_SIZE = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('contacts').upsert(batch, { onConflict: 'id' });
    if (error) {
      errors.push(`Batch ${i / BATCH_SIZE + 1}: ${error.message}`);
    } else {
      upserted += batch.length;
    }
  }
  return { upserted, errors };
}

/* ── API pública ────────────────────────────────────────────────────────── */

/**
 * Sincroniza contactos de Wapify a Supabase `contacts` (delta o full).
 *
 * Si `options.pipeline_id` está seteado, solo procesa ese pipeline.
 * Si `options.dry_run`, recorre la API y reporta cuántos contactos vendría
 * sincronizando, sin escribir nada en Supabase ni actualizar sync_state.
 */
export async function syncWapifyCache(
  supabase: SupabaseClient,
  options: SyncOptions = {},
): Promise<PipelineSyncResult[]> {
  const token = process.env.WAPIFY_TOKEN;
  if (!token) {
    throw new Error('WAPIFY_TOKEN no está definido en el entorno (process.env)');
  }

  const dryRun = options.dry_run === true;
  const targets = options.pipeline_id
    ? PIPELINES.filter((p) => p.id === options.pipeline_id)
    : PIPELINES;

  if (targets.length === 0) {
    throw new Error(`pipeline_id ${options.pipeline_id} no está en la lista de pipelines activos`);
  }

  const results: PipelineSyncResult[] = [];

  for (const pipe of targets) {
    const currentSyncAt = new Date().toISOString();
    const previousSyncAt = await readSyncState(supabase, pipe.id);

    const { contacts, pages, notes } = await fetchPipelineContacts(
      pipe.id,
      token,
      previousSyncAt,
    );

    let upserted = 0;
    const errors: string[] = [];

    if (!dryRun && contacts.length > 0) {
      const r = await upsertContacts(supabase, contacts);
      upserted = r.upserted;
      errors.push(...r.errors);
    }

    if (!dryRun && errors.length === 0) {
      try {
        await writeSyncState(supabase, pipe.id, currentSyncAt, {
          contacts_upserted: upserted,
          pages_fetched: pages,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`writeSyncState falló: ${msg}`);
      }
    }

    results.push({
      pipeline_id: pipe.id,
      pipeline_name: pipe.name,
      previous_sync_at: previousSyncAt,
      current_sync_at: currentSyncAt,
      contacts_fetched: contacts.length,
      contacts_upserted: upserted,
      dry_run: dryRun,
      pages_fetched: pages,
      notes,
      errors,
    });
  }

  return results;
}
