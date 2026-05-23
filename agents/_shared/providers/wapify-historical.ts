/**
 * GIOCORE Frente H — Export histórico/delta de contactos Wapify a backups_manifest.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §4.
 *
 * Diferencia con `wapify-sync.ts`:
 *   - Aquel sincroniza a la tabla `contacts` (datos vivos para dashboard).
 *   - Éste dumpea opportunities RAW (raw_payload completo) a `backups_manifest`
 *     como capa templada de recuperación. Persiste TODO el payload por si
 *     necesitamos forense de campos no normalizados en `contacts`.
 *
 * Modos:
 *   - bootstrap: paginación full del pipeline, resumible vía
 *     `metadata.resume_offset` en backups_manifest. Una corrida puede procesar
 *     hasta `MAX_PAGES_PER_RUN` páginas (~120s con 1.5s sleep) y el cron del
 *     día siguiente continúa donde quedó. ~7-10 días para bootstrap completo
 *     de 36K contactos (5 pipelines × ~80 páginas).
 *   - delta: pagina sólo opportunities con `updated_at > last_export_at`.
 *     Mucho más rápido (cabe en una corrida típica).
 *
 * Restricciones inviolables:
 *   - Pipelines 252999 (SPY) y 273944 (GioVision): SOLO LEER. Nunca PATCH/POST.
 *   - Sleep 1500 ms entre páginas (respeta rate-limit Wapify).
 *   - Dedupe por `id` (paginación con overlap es común — Wapify quirk).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/* ── Configuración ──────────────────────────────────────────────────────── */

const WAPIFY_BASE = 'https://ap.whapify.ai/api';
const PAGE_LIMIT = 100;
const SLEEP_MS_BETWEEN_PAGES = 1500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES_429 = 3;
/** Patch Rectificador: ANTES 80 → 5 pipelines × 80 × 2s ≈ 800s vs maxDuration=300s.
 *  Bajamos a 20 para que 5 pipelines × 20 × 2s ≈ 200s, con margen.
 *  Bootstrap completo (~72 páginas/pipeline) toma ~4 días (72/20). */
const MAX_PAGES_PER_RUN = 20;

/** 5 pipelines activos (alineado a wapify-sync.ts § PIPELINES). */
export const PIPELINES: ReadonlyArray<{
  id: number;
  name: string;
  protected: boolean;
}> = [
  { id: 216977, name: 'Justin/Holbrook/Litebeam', protected: false },
  { id: 755062, name: 'GioSports Deportivo', protected: false },
  { id: 94103, name: 'Dama Luxury', protected: false },
  { id: 252999, name: 'SPY Seguridad Z87', protected: true },
  { id: 273944, name: 'GioVision Entintados', protected: true },
];

export type ExportMode = 'bootstrap' | 'delta';

/* ── Tipos ──────────────────────────────────────────────────────────────── */

export interface PipelineExportResult {
  pipeline_id: number;
  pipeline_name: string;
  mode: ExportMode;
  /** Páginas procesadas en ESTE run (no acumulado). */
  pages_fetched: number;
  /** Opportunities nuevos en este run (post-dedupe). */
  new_opportunities: number;
  /** Total acumulado en backups_manifest (bootstrap completado o pre-existente). */
  total_opportunities: number;
  /** Si bootstrap, offset desde donde retomar próxima corrida. NULL si terminó. */
  resume_offset: number | null;
  /** True si el bootstrap del pipeline llegó a end-of-data (paginación devolvió 0). */
  bootstrap_completed: boolean;
  /** ISO timestamp del último opportunity procesado (max updated_at). */
  last_seen_updated_at: string | null;
  status: 'completed' | 'in_progress' | 'failed' | 'skipped';
  error?: string;
  manifest_id: number | null;
  notes: string[];
}

export interface ExportRunResult {
  pipelines_processed: number;
  pipelines_completed: number;
  pipelines_in_progress: number;
  pipelines_failed: number;
  total_new_opportunities: number;
  results: PipelineExportResult[];
  notes: string[];
}

export interface ExportOptions {
  dry_run?: boolean;
  /** Subset opcional. Default: todos los 5 pipelines. */
  only_pipeline_id?: number;
  /** Override del token (test). Default: process.env.WAPIFY_TOKEN. */
  token?: string;
  /** Override sleep entre páginas (test). */
  sleep_ms?: number;
  /** Override max pages per run (test). */
  max_pages_per_run?: number;
}

/* ── Helpers HTTP ───────────────────────────────────────────────────────── */

async function fetchWithTimeout(url: string, token: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { 'X-ACCESS-TOKEN': token, Accept: 'application/json' },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithBackoff(url: string, token: string): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
    const res = await fetchWithTimeout(url, token);
    last = res;
    if (res.status !== 429 || attempt === MAX_RETRIES_429) return res;
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0
      ? Math.min(ra * 1000, 8000)
      : Math.min(2 ** attempt * 1000, 8000);
    await sleep(wait);
  }
  return last as Response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extrae lista del payload sin asumir shape único. (clone de wapify-sync) */
function extractList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const k of ['data', 'contacts', 'items', 'results', 'rows']) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
  }
  return null;
}

/** Detecta error en body con HTTP 200 (Wapify quirk).
 *  Devuelve mensaje si error, null si OK. */
function detectBodyError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  if (o.error && typeof o.error === 'object') {
    const e = o.error as Record<string, unknown>;
    const code = e.code ?? '?';
    const msg = (e.message as string | undefined) ?? '(sin mensaje)';
    return `wapify_error code=${code}: ${msg}`;
  }
  return null;
}

function getOpportunityId(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as Record<string, unknown>).id;
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isFinite(n) ? n : null;
}

function getOpportunityUpdatedAt(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const ua = (raw as Record<string, unknown>).updated_at;
  if (typeof ua !== 'string' || !ua) return null;
  if (ua.startsWith('0000-') || ua.startsWith('0001-')) return null;
  const d = new Date(ua.includes('T') ? ua : ua.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/* ── Estado por pipeline (en backups_manifest.metadata) ─────────────────── */

interface PipelineState {
  mode: ExportMode;
  resume_offset: number;
  total_opportunities: number;
  bootstrap_completed: boolean;
  last_seen_updated_at: string | null;
  /** IDs ya vistos — para dedupe entre corridas. Stored compactly. */
  known_ids?: number[];
}

async function readPipelineState(
  supabase: SupabaseClient,
  pipelineId: number,
): Promise<PipelineState | null> {
  // Buscamos el row más reciente de tipo wapify_historical o wapify_delta para este pipeline.
  // Patch Rectificador: incluimos status 'in_progress' (no sólo 'completed') para
  // que bootstrap parcial se pueda resumir. La migración 008 fue extendida para
  // permitir 'in_progress' como status válido.
  const { data, error } = await supabase
    .from('backups_manifest')
    .select('id, type, metadata')
    .in('type', ['wapify_historical', 'wapify_delta'])
    .in('status', ['completed', 'in_progress'])
    .filter('metadata->>pipeline_id', 'eq', String(pipelineId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const md = data.metadata as Record<string, unknown> | null;
  if (!md) return null;
  return {
    mode: (md.mode as ExportMode) ?? 'bootstrap',
    resume_offset: Number(md.resume_offset ?? 0),
    total_opportunities: Number(md.total_opportunities ?? 0),
    bootstrap_completed: Boolean(md.bootstrap_completed),
    last_seen_updated_at: (md.last_seen_updated_at as string | null) ?? null,
    known_ids: Array.isArray(md.known_ids) ? (md.known_ids as number[]) : undefined,
  };
}

/* ── Export por pipeline ────────────────────────────────────────────────── */

async function exportPipeline(
  supabase: SupabaseClient,
  pipeline: { id: number; name: string; protected: boolean },
  token: string,
  opts: ExportOptions,
): Promise<PipelineExportResult> {
  const notes: string[] = [];
  const prevState = await readPipelineState(supabase, pipeline.id);

  // Determina modo: si bootstrap aún no terminó → bootstrap. Si terminó → delta.
  const mode: ExportMode = prevState?.bootstrap_completed ? 'delta' : 'bootstrap';
  const startOffset = mode === 'bootstrap' ? prevState?.resume_offset ?? 0 : 0;
  const knownIdsSet = new Set<number>(prevState?.known_ids ?? []);
  const newOpportunities: unknown[] = [];
  let maxUpdatedAt = prevState?.last_seen_updated_at ?? null;

  const sleepMs = opts.sleep_ms ?? SLEEP_MS_BETWEEN_PAGES;
  const maxPages = opts.max_pages_per_run ?? MAX_PAGES_PER_RUN;

  let pagesFetched = 0;
  let offset = startOffset;
  let bootstrapCompleted = prevState?.bootstrap_completed ?? false;
  let failedError: string | undefined;

  for (let p = 0; p < maxPages; p++) {
    const url = `${WAPIFY_BASE}/pipelines/${pipeline.id}/opportunities?offset=${offset}&limit=${PAGE_LIMIT}`;
    let res: Response;
    try {
      res = await fetchWithBackoff(url, token);
    } catch (err) {
      failedError = `fetch error pipeline=${pipeline.id} offset=${offset}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      break;
    }
    if (!res.ok) {
      failedError = `HTTP ${res.status} pipeline=${pipeline.id} offset=${offset}`;
      break;
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      failedError = `JSON parse error pipeline=${pipeline.id}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      break;
    }

    // Wapify quirk: HTTP 200 con body {error:{code:...}}
    const bodyErr = detectBodyError(payload);
    if (bodyErr) {
      failedError = `${bodyErr} pipeline=${pipeline.id} offset=${offset}`;
      break;
    }

    const list = extractList(payload) ?? [];
    pagesFetched += 1;

    if (list.length === 0) {
      // End-of-data → bootstrap completado.
      bootstrapCompleted = true;
      notes.push(`Bootstrap completado pipeline=${pipeline.id} en offset=${offset}.`);
      break;
    }

    let dedupedThisPage = 0;
    for (const raw of list) {
      const id = getOpportunityId(raw);
      if (id === null) continue;

      // Modo delta: filtrar por updated_at > last_seen.
      if (mode === 'delta' && prevState?.last_seen_updated_at) {
        const ua = getOpportunityUpdatedAt(raw);
        if (ua && ua <= prevState.last_seen_updated_at) continue;
      }

      if (knownIdsSet.has(id)) {
        dedupedThisPage += 1;
        continue;
      }
      knownIdsSet.add(id);
      newOpportunities.push(raw);

      const ua = getOpportunityUpdatedAt(raw);
      if (ua && (!maxUpdatedAt || ua > maxUpdatedAt)) maxUpdatedAt = ua;
    }

    if (dedupedThisPage > 0) {
      notes.push(
        `Pipeline ${pipeline.id} offset=${offset}: ${dedupedThisPage} duplicados ignorados.`,
      );
    }

    offset += PAGE_LIMIT;

    // Si la página vino con <PAGE_LIMIT, asumimos end-of-data.
    if (list.length < PAGE_LIMIT) {
      bootstrapCompleted = true;
      notes.push(`Bootstrap completado pipeline=${pipeline.id} (página corta).`);
      break;
    }

    // Sleep entre páginas (no después de la última).
    if (p < maxPages - 1) {
      await sleep(sleepMs);
    }
  }

  // Si llegamos al max sin terminar y no hubo error → in_progress (resume next run).
  const status: PipelineExportResult['status'] =
    failedError ? 'failed'
    : bootstrapCompleted || mode === 'delta' ? 'completed'
    : 'in_progress';

  // Persistimos el row de manifiesto con contenido + estado.
  let manifestId: number | null = null;
  if (!opts.dry_run) {
    const path =
      mode === 'bootstrap'
        ? `wapify_historical/pipeline_${pipeline.id}.json.gz`
        : `wapify_delta_${new Date().toISOString().slice(0, 10)}/pipeline_${pipeline.id}.json.gz`;

    const json = JSON.stringify({
      pipeline_id: pipeline.id,
      pipeline_name: pipeline.name,
      mode,
      exported_at: new Date().toISOString(),
      opportunities: newOpportunities,
    });
    const uncompressed = Buffer.from(json, 'utf-8');
    const gz = gzipSync(uncompressed, { level: 9 });
    const b64 = gz.toString('base64');
    const sha = sha256Hex(gz);
    const totalAfter = (prevState?.total_opportunities ?? 0) + newOpportunities.length;

    const metadata = {
      pipeline_id: pipeline.id,
      pipeline_name: pipeline.name,
      mode,
      resume_offset: bootstrapCompleted ? null : offset,
      total_opportunities: totalAfter,
      bootstrap_completed: bootstrapCompleted,
      last_seen_updated_at: maxUpdatedAt,
      pages_fetched_this_run: pagesFetched,
      new_opportunities_this_run: newOpportunities.length,
      // Cap known_ids a 50K para no inflar metadata sin sentido (Postgres JSONB
      // soporta más pero queremos minimizar overhead). Para 36K contactos esto
      // alcanza; si crecemos más, switchamos a una tabla aparte.
      known_ids: Array.from(knownIdsSet).slice(-50_000),
    };

    // Patch Rectificador: el row guarda el status REAL (failed/in_progress/completed),
    // no se aplana a 'completed'. Migración 008 acepta 'in_progress' como valor válido.
    const persistedStatus =
      status === 'failed' ? 'failed' : status === 'in_progress' ? 'in_progress' : 'completed';

    // Patch Rectificador: skip insert si delta sin novedades (row vacío sin valor).
    if (mode === 'delta' && newOpportunities.length === 0 && status === 'completed') {
      notes.push(`Pipeline ${pipeline.id}: delta vacío, skip insert (sin novedades).`);
      return {
        pipeline_id: pipeline.id,
        pipeline_name: pipeline.name,
        mode,
        pages_fetched: pagesFetched,
        new_opportunities: 0,
        total_opportunities: prevState?.total_opportunities ?? 0,
        resume_offset: null,
        bootstrap_completed: true,
        last_seen_updated_at: maxUpdatedAt,
        status,
        error: failedError,
        manifest_id: null,
        notes,
      };
    }

    const { data: ins, error: insErr } = await supabase
      .from('backups_manifest')
      .insert({
        type: mode === 'bootstrap' ? 'wapify_historical' : 'wapify_delta',
        path,
        sha256: sha,
        size_bytes: gz.byteLength,
        uncompressed_bytes: uncompressed.byteLength,
        row_counts: { opportunities: newOpportunities.length },
        storage: 'supabase_inline',
        data_b64: b64,
        status: persistedStatus,
        error_message: failedError,
        completed_at: persistedStatus === 'in_progress' ? null : new Date().toISOString(),
        metadata,
      })
      .select('id')
      .single();

    if (insErr) {
      notes.push(`Insert manifest failed: ${insErr.message}`);
    } else {
      manifestId = (ins as { id: number }).id;
    }
  }

  return {
    pipeline_id: pipeline.id,
    pipeline_name: pipeline.name,
    mode,
    pages_fetched: pagesFetched,
    new_opportunities: newOpportunities.length,
    total_opportunities:
      (prevState?.total_opportunities ?? 0) + newOpportunities.length,
    resume_offset: bootstrapCompleted ? null : offset,
    bootstrap_completed: bootstrapCompleted,
    last_seen_updated_at: maxUpdatedAt,
    status,
    error: failedError,
    manifest_id: manifestId,
    notes,
  };
}

/* ── Función principal ──────────────────────────────────────────────────── */

export async function exportWapifyHistorical(
  supabase: SupabaseClient,
  opts: ExportOptions = {},
): Promise<ExportRunResult> {
  const token = opts.token ?? process.env.WAPIFY_TOKEN;
  if (!token) {
    return {
      pipelines_processed: 0,
      pipelines_completed: 0,
      pipelines_in_progress: 0,
      pipelines_failed: 0,
      total_new_opportunities: 0,
      results: [],
      notes: ['WAPIFY_TOKEN no está en el entorno — abortando.'],
    };
  }

  const pipelines =
    opts.only_pipeline_id !== undefined
      ? PIPELINES.filter((p) => p.id === opts.only_pipeline_id)
      : PIPELINES;

  if (pipelines.length === 0) {
    return {
      pipelines_processed: 0,
      pipelines_completed: 0,
      pipelines_in_progress: 0,
      pipelines_failed: 0,
      total_new_opportunities: 0,
      results: [],
      notes: [`pipeline_id ${opts.only_pipeline_id} no está en la lista activa.`],
    };
  }

  const results: PipelineExportResult[] = [];
  for (const p of pipelines) {
    const r = await exportPipeline(supabase, p, token, opts);
    results.push(r);
  }

  return {
    pipelines_processed: results.length,
    pipelines_completed: results.filter((r) => r.status === 'completed').length,
    pipelines_in_progress: results.filter((r) => r.status === 'in_progress').length,
    pipelines_failed: results.filter((r) => r.status === 'failed').length,
    total_new_opportunities: results.reduce((a, r) => a + r.new_opportunities, 0),
    results,
    notes: [],
  };
}
