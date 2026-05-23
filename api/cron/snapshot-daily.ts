/**
 * GIOCORE Frente H — Cron diario de snapshot Supabase a backups_manifest.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §1.
 *
 * Trigger: vercel.json crons "0 10 * * *" (10:00 UTC = 04:00 MX).
 * Auth: Bearer CRON_SECRET.
 *
 * Query params:
 *   - `?dry_run=1`  simula sin escribir en backups_manifest ni purgar retención.
 *   - `?table=X`    sólo esa tabla (debug — debe estar en SNAPSHOT_TABLES).
 *
 * Persistencia:
 *   - `backups_manifest` (1 fila por tabla snapshoteada).
 *   - `agent_decisions` (1 fila resumen del run, severity ≤0.2 OK, 0.6 si falla
 *     alguna tabla, 0.9 si exception fatal).
 *
 * Patrón pragmático: storage='supabase_inline' (data_b64 gzipped + base64) por
 * limitación de FS persistente en Vercel serverless. Cuando B2 esté configurado,
 * `backup-monthly.ts` agrega estos rows en un zip y los sube a B2 como capa fría.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  snapshotAllTables,
  SNAPSHOT_TABLES,
  TABLES_MISSING_FROM_BRIEF,
  TABLES_MANIFEST,
  type SnapshotRunResult,
} from '../../agents/_shared/providers/snapshot.js';

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

async function logAgentDecision(
  supabase: SupabaseClient,
  result: SnapshotRunResult,
  dryRun: boolean,
): Promise<void> {
  const today = result.date;
  const decisionKey = `snapshot_daily_${today}`;

  const hasFailures = result.tables_failed > 0;
  const allSkipped = result.tables_succeeded === 0 && result.tables_failed === 0;
  const severity = hasFailures ? 0.6 : allSkipped ? 0.4 : 0.1;
  const status = hasFailures || allSkipped ? 'pending' : 'auto_approved';

  const compressionRatio =
    result.total_uncompressed_bytes > 0
      ? result.total_size_bytes / result.total_uncompressed_bytes
      : 0;

  await supabase.from('agent_decisions').upsert(
    {
      agent_name: 'cron_snapshot_daily',
      decision_type: 'supabase_snapshot',
      proposed_action: {
        date: today,
        tables_processed: result.tables_processed,
        tables_succeeded: result.tables_succeeded,
        tables_failed: result.tables_failed,
        tables_skipped: result.tables_skipped,
        total_size_bytes: result.total_size_bytes,
        total_uncompressed_bytes: result.total_uncompressed_bytes,
        compression_ratio: compressionRatio,
        rows_purged_retention: result.rows_purged_retention,
        dry_run: dryRun,
      },
      justification:
        `Snapshot ${today}: ${result.tables_succeeded}/${result.tables_processed} OK, ` +
        `${result.tables_failed} failed, ${result.tables_skipped} skipped. ` +
        `Tamaño total ${(result.total_size_bytes / 1024).toFixed(1)} KB ` +
        `(ratio ${(compressionRatio * 100).toFixed(1)}%). ` +
        `Retención purgó ${result.rows_purged_retention} rows.`,
      evidence_refs: {
        results: result.results.map((r) => ({
          table: r.table,
          status: r.status,
          row_count: r.row_count,
          size_bytes: r.size_bytes,
          compression_ratio: r.compression_ratio,
          sha256: r.sha256,
          error: r.error,
          manifest_id: r.manifest_id,
        })),
        notes: result.notes,
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
  const onlyTable = readQueryParam(req, 'table');

  // Validar `?table=X` si vino
  if (onlyTable && !(SNAPSHOT_TABLES as readonly string[]).includes(onlyTable)) {
    res.status(400).json({
      ok: false,
      error: `table "${onlyTable}" no está en SNAPSHOT_TABLES`,
      valid: SNAPSHOT_TABLES,
    });
    return;
  }

  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/snapshot-daily] No se pudo construir cliente Supabase:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  let result: SnapshotRunResult;
  try {
    result = await snapshotAllTables(supabase, {
      dry_run: dryRun,
      only_tables: onlyTable ? [onlyTable] : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/snapshot-daily] snapshotAllTables lanzó:', msg);
    // Patch Rectificador: usamos decision_key idempotente por día para que dobles
    // fatales el mismo día actualicen el row en vez de duplicar.
    const today = new Date().toISOString().slice(0, 10);
    try {
      await supabase.from('agent_decisions').upsert(
        {
          agent_name: 'cron_snapshot_daily',
          decision_type: 'supabase_snapshot',
          proposed_action: { error: msg, dry_run: dryRun },
          justification: `Snapshot diario lanzó excepción: ${msg}`,
          evidence_refs: { error_stack: err instanceof Error ? err.stack ?? null : null },
          severity: 0.9,
          status: 'pending',
          decision_key: `snapshot_daily_fatal_${today}`,
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
    `[cron/snapshot-daily] date=${result.date} ok=${result.tables_succeeded} ` +
      `failed=${result.tables_failed} skipped=${result.tables_skipped} ` +
      `size=${result.total_size_bytes}b purged=${result.rows_purged_retention} dry_run=${dryRun}`,
  );

  if (!dryRun) {
    try {
      await logAgentDecision(supabase, result, dryRun);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.notes.push(`agent_decisions log falló: ${msg}`);
    }

    // Delta D2: loguear tablas esperadas-pero-ausentes con severity=0.3 (info).
    // Cron diario lo upserta idempotente (1 row por día), no inflas la tabla.
    if (TABLES_MISSING_FROM_BRIEF.length > 0) {
      const today = result.date;
      try {
        await supabase.from('agent_decisions').upsert(
          {
            agent_name: 'cron_snapshot_daily',
            decision_type: 'snapshot_schema_drift',
            proposed_action: {
              missing: TABLES_MISSING_FROM_BRIEF,
              manifest_generated_at: TABLES_MANIFEST.generated_at,
            },
            justification:
              `Tablas esperadas por brief-H pero ausentes en DB: ` +
              `${TABLES_MISSING_FROM_BRIEF.join(', ')}. ` +
              `Snapshot omite estas tablas (no falla). ` +
              `Si una migración debería haberlas creado, investigar.`,
            evidence_refs: {
              manifest_path: 'agents/_shared/backups/tables-manifest.json',
            },
            severity: 0.3,
            status: 'auto_approved',
            decision_key: `snapshot_schema_drift_${today}`,
          },
          { onConflict: 'decision_key' },
        );
      } catch {
        /* swallow — el drift log es informativo, nunca debe romper el cron */
      }
    }
  }

  res.status(200).json({
    ok: true,
    dry_run: dryRun,
    tables_count: SNAPSHOT_TABLES.length,
    tables_missing_from_brief: TABLES_MISSING_FROM_BRIEF,
    ...result,
  });
}
