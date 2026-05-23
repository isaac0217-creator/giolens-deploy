/**
 * GIOCORE Frente D.2 — Cron diario de sync delta Wapify → Supabase.contacts.
 *
 * Spec: BRIEF_CODE_FRENTE_D2.md §sync-wapify-cache.
 *
 * Trigger: vercel.json crons "30 12 * * *" (30 min después del fetch-provider-usage
 * para no solapar load contra Wapify).
 *
 * Query params:
 *   - `?pipeline_id=216977` (opcional): solo ese pipeline. Si vacío, los 5.
 *   - `?dry_run=1`: simula sin escribir en Supabase (validación segura).
 *
 * Persistencia:
 *   - `contacts` (upsert por id Wapify).
 *   - `knowledge_base` (sync_state por pipeline; ver providers/wapify-sync.ts).
 *   - `agent_decisions` (una fila por run, status auto_approved si OK, pending si hubo errores).
 *
 * Restricciones inviolables:
 *   ❌ NO mutar contactos en Wapify (este cron solo lee).
 *   ❌ Pipelines 252999 (SPY) y 273944 (GioVision): allowed para lectura,
 *      la lógica de protected SE APLICA si alguna vez se agrega mutación.
 *   ❌ NO regenerar .md por contacto.
 */

import { createClient } from '@supabase/supabase-js';
import { syncWapifyCache, PIPELINES } from '../../agents/_shared/providers/wapify-sync.js';
import type { PipelineSyncResult } from '../../agents/_shared/providers/wapify-sync.js';

/* ── Tipos handler ──────────────────────────────────────────────────────── */

interface VercelLikeReq {
  url?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

function readQueryParam(req: VercelLikeReq, name: string): string | null {
  if (req.query) {
    const v = req.query[name];
    if (Array.isArray(v)) return v[0] ?? null;
    if (typeof v === 'string') return v;
  }
  if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      return u.searchParams.get(name);
    } catch {
      return null;
    }
  }
  return null;
}

function isDryRun(req: VercelLikeReq): boolean {
  const v = readQueryParam(req, 'dry_run');
  return v === '1' || v === 'true';
}

function readPipelineId(req: VercelLikeReq): number | null {
  const v = readQueryParam(req, 'pipeline_id');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function totals(results: PipelineSyncResult[]) {
  return results.reduce(
    (acc, r) => ({
      contacts_fetched: acc.contacts_fetched + r.contacts_fetched,
      contacts_upserted: acc.contacts_upserted + r.contacts_upserted,
      errors_count: acc.errors_count + r.errors.length,
      notes_count: acc.notes_count + r.notes.length,
    }),
    { contacts_fetched: 0, contacts_upserted: 0, errors_count: 0, notes_count: 0 },
  );
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  // 1 · Auth
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  const dryRun = isDryRun(req);
  const pipelineId = readPipelineId(req);

  // Validar pipeline_id si vino
  if (pipelineId !== null && !PIPELINES.some((p) => p.id === pipelineId)) {
    res.status(400).json({
      ok: false,
      error: `pipeline_id ${pipelineId} no está en la lista de pipelines activos`,
      valid_pipelines: PIPELINES.map((p) => p.id),
    });
    return;
  }

  // 2 · Construir cliente Supabase
  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/sync-wapify-cache] No se pudo construir cliente Supabase:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  // 3 · Sync
  let results: PipelineSyncResult[];
  try {
    results = await syncWapifyCache(supabase, {
      pipeline_id: pipelineId ?? undefined,
      dry_run: dryRun,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/sync-wapify-cache] syncWapifyCache lanzó:', msg);

    // Log error en agent_decisions
    try {
      await supabase.from('agent_decisions').insert({
        agent_name: 'cron_sync_wapify_cache',
        decision_type: 'wapify_sync_error',
        proposed_action: { pipeline_id: pipelineId, dry_run: dryRun, error_message: msg },
        justification: `Sync Wapify falló (pipeline=${pipelineId ?? 'all'}, dry_run=${dryRun}): ${msg}`,
        evidence_refs: {
          error_message: msg,
          error_stack: err instanceof Error ? err.stack ?? null : null,
        },
        severity: 0.8,
        status: 'pending',
      });
    } catch (logErr) {
      console.error(
        '[cron/sync-wapify-cache] No se pudo loggear error en agent_decisions:',
        logErr instanceof Error ? logErr.message : String(logErr),
      );
    }

    res.status(500).json({ ok: false, error: msg });
    return;
  }

  const t = totals(results);

  console.log(
    `[cron/sync-wapify-cache] pipelines=${results.length} fetched=${t.contacts_fetched} ` +
      `upserted=${t.contacts_upserted} errors=${t.errors_count} dry_run=${dryRun}`,
  );

  // 4 · Si NO es dry_run, persistir decisión resumen en agent_decisions
  if (!dryRun) {
    const today = new Date().toISOString().slice(0, 10);
    const pipeKey = pipelineId ? `_p${pipelineId}` : '_all';
    const decisionKey = `wapify_sync_${today}${pipeKey}`;
    const hasErrors = t.errors_count > 0;

    const row = {
      agent_name: 'cron_sync_wapify_cache',
      decision_type: 'wapify_cache_sync',
      proposed_action: {
        action: 'wapify_contacts_synced',
        pipeline_id: pipelineId,
        contacts_upserted: t.contacts_upserted,
        contacts_fetched: t.contacts_fetched,
        pipelines_processed: results.length,
      },
      justification:
        `Sync Wapify completado: ${t.contacts_upserted}/${t.contacts_fetched} contactos ` +
        `upserteados en ${results.length} pipeline(s). ` +
        `${t.errors_count} errores, ${t.notes_count} notas.`,
      evidence_refs: {
        results: results.map((r) => ({
          pipeline_id: r.pipeline_id,
          pipeline_name: r.pipeline_name,
          previous_sync_at: r.previous_sync_at,
          current_sync_at: r.current_sync_at,
          contacts_fetched: r.contacts_fetched,
          contacts_upserted: r.contacts_upserted,
          pages_fetched: r.pages_fetched,
          notes: r.notes,
          errors: r.errors,
        })),
      },
      severity: hasErrors ? 0.6 : 0.2,
      status: hasErrors ? 'pending' : 'auto_approved',
      decision_key: decisionKey,
    };

    const { error } = await supabase
      .from('agent_decisions')
      .upsert(row, { onConflict: 'decision_key' });

    if (error) {
      console.error(
        '[cron/sync-wapify-cache] No se pudo persistir decisión:',
        error.message,
      );
      // No abortamos — el sync ya pasó. Solo lo dejamos en stdout.
    }
  }

  res.status(200).json({
    ok: true,
    dry_run: dryRun,
    pipeline_id: pipelineId,
    pipelines_processed: results.length,
    totals: t,
    results: results.map((r) => ({
      pipeline_id: r.pipeline_id,
      pipeline_name: r.pipeline_name,
      previous_sync_at: r.previous_sync_at,
      contacts_fetched: r.contacts_fetched,
      contacts_upserted: r.contacts_upserted,
      pages_fetched: r.pages_fetched,
      notes_count: r.notes.length,
      errors_count: r.errors.length,
      notes: r.notes,
      errors: r.errors,
    })),
  });
}
