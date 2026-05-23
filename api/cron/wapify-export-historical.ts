/**
 * GIOCORE Frente H — Cron de export histórico + delta de Wapify a backups_manifest.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §4.
 *
 * Trigger: vercel.json crons "30 10 * * *" (10:30 UTC = 04:30 MX, 30 min después
 *          de snapshot-daily para no solapar load contra Wapify).
 * Auth: Bearer CRON_SECRET.
 *
 * Modos automáticos:
 *   - Si el pipeline aún no completó bootstrap → continúa bootstrap resumible
 *     (hasta MAX_PAGES_PER_RUN páginas por corrida).
 *   - Si el pipeline ya completó bootstrap → modo delta (sólo updated_at > last).
 *
 * Query params:
 *   - `?dry_run=1` simula sin escribir en backups_manifest.
 *   - `?pipeline_id=N` sólo ese pipeline (debug). Default: los 5 activos.
 *
 * Persistencia:
 *   - `backups_manifest` (1 fila por pipeline procesado).
 *   - `agent_decisions` (1 fila resumen del run).
 *
 * Restricciones inviolables:
 *   - Pipelines 252999 (SPY) y 273944 (GioVision): SOLO LEER. Nunca PATCH/POST.
 *   - El provider sólo hace GET — no muta Wapify.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  exportWapifyHistorical,
  PIPELINES,
  type ExportRunResult,
} from '../../agents/_shared/providers/wapify-historical.js';

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

function buildSupabaseClient(): SupabaseClient {
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

async function logAgentDecision(
  supabase: SupabaseClient,
  result: ExportRunResult,
  dryRun: boolean,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const decisionKey = `wapify_export_${today}`;
  const hasFailures = result.pipelines_failed > 0;
  const severity = hasFailures ? 0.6 : 0.1;
  const status = hasFailures ? 'pending' : 'auto_approved';

  await supabase.from('agent_decisions').upsert(
    {
      agent_name: 'cron_wapify_export_historical',
      decision_type: 'wapify_historical_export',
      proposed_action: {
        date: today,
        pipelines_processed: result.pipelines_processed,
        pipelines_completed: result.pipelines_completed,
        pipelines_in_progress: result.pipelines_in_progress,
        pipelines_failed: result.pipelines_failed,
        total_new_opportunities: result.total_new_opportunities,
        dry_run: dryRun,
      },
      justification:
        `Wapify export ${today}: ${result.pipelines_completed}/${result.pipelines_processed} ` +
        `pipelines done, ${result.pipelines_in_progress} in-progress, ` +
        `${result.pipelines_failed} failed. ` +
        `${result.total_new_opportunities} opportunities nuevas.`,
      evidence_refs: {
        results: result.results.map((r) => ({
          pipeline_id: r.pipeline_id,
          pipeline_name: r.pipeline_name,
          mode: r.mode,
          pages_fetched: r.pages_fetched,
          new_opportunities: r.new_opportunities,
          total_opportunities: r.total_opportunities,
          resume_offset: r.resume_offset,
          bootstrap_completed: r.bootstrap_completed,
          status: r.status,
          error: r.error,
          manifest_id: r.manifest_id,
          notes_count: r.notes.length,
        })),
      },
      severity,
      status,
      decision_key: decisionKey,
    },
    { onConflict: 'decision_key' },
  );
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (res.setHeader) res.setHeader('Cache-Control', 'no-store, max-age=0');

  // 1 · Auth
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  const dryRun = isDryRun(req);
  const pipelineId = readPipelineId(req);

  if (pipelineId !== null && !PIPELINES.some((p) => p.id === pipelineId)) {
    res.status(400).json({
      ok: false,
      error: `pipeline_id ${pipelineId} no está en la lista activa`,
      valid_pipelines: PIPELINES.map((p) => p.id),
    });
    return;
  }

  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/wapify-export-historical] Supabase client error:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  let result: ExportRunResult;
  try {
    result = await exportWapifyHistorical(supabase, {
      dry_run: dryRun,
      only_pipeline_id: pipelineId ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/wapify-export-historical] exportWapifyHistorical lanzó:', msg);
    // Patch Rectificador: decision_key idempotente por día.
    const today = new Date().toISOString().slice(0, 10);
    try {
      await supabase.from('agent_decisions').upsert(
        {
          agent_name: 'cron_wapify_export_historical',
          decision_type: 'wapify_historical_export',
          proposed_action: { error: msg, dry_run: dryRun, pipeline_id: pipelineId },
          justification: `Wapify export lanzó excepción: ${msg}`,
          evidence_refs: { error_stack: err instanceof Error ? err.stack ?? null : null },
          severity: 0.9,
          status: 'pending',
          decision_key: `wapify_export_fatal_${today}`,
        },
        { onConflict: 'decision_key' },
      );
    } catch {
      /* swallow */
    }
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  console.log(
    `[cron/wapify-export-historical] pipelines=${result.pipelines_processed} ` +
      `completed=${result.pipelines_completed} in_progress=${result.pipelines_in_progress} ` +
      `failed=${result.pipelines_failed} new=${result.total_new_opportunities} dry_run=${dryRun}`,
  );

  if (!dryRun) {
    try {
      await logAgentDecision(supabase, result, dryRun);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.notes.push(`agent_decisions log falló: ${msg}`);
    }
  }

  res.status(200).json({
    ok: true,
    dry_run: dryRun,
    pipeline_id: pipelineId,
    ...result,
  });
}
