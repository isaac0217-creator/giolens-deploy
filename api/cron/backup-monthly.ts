/**
 * GIOCORE Frente H · 1.6 — Cron mensual de backup cifrado a B2.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §3.
 *
 * Trigger: vercel.json crons "0 8 1 * *" (08:00 UTC del día 1 = 02:00 MX).
 * Auth: Bearer CRON_SECRET.
 *
 * Query params:
 *   - `?dry_run=1`     simula sin escribir backups_manifest ni subir a B2.
 *   - `?month=YYYY-MM` override del mes (default: mes anterior completo).
 *
 * Persistencia:
 *   - B2: `backup_monthly/YYYY-MM/giocore-YYYY-MM.bin` (gzip+AES-256-GCM)
 *         `backup_monthly/YYYY-MM/giocore-YYYY-MM.iv`  (12 bytes IV)
 *   - `backups_manifest` (storage='b2', metadata.b2_key_bin/iv)
 *   - `agent_decisions` resumen (severity ≤0.2 OK, 0.8 si B2 falla)
 *
 * El cron AGGREGA los rows de `backups_manifest` del mes (snapshot_daily +
 * wapify_historical + wapify_delta) en un payload JSON, lo comprime y cifra.
 * NO descomprime ni re-empaqueta el contenido inline — el .bin contiene la
 * misma estructura para restore directo.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildMonthlyBackup,
  type MonthlyBackupResult,
} from '../../agents/_shared/providers/backup-monthly.js';

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
  if (!url) throw new Error('SUPABASE_URL no está definido');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido');
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
  result: MonthlyBackupResult,
  dryRun: boolean,
): Promise<void> {
  const decisionKey = `backup_monthly_${result.month}`;
  const failed = result.status === 'failed' || result.status === 'aborted';
  const severity = result.status === 'aborted' ? 0.9 : failed ? 0.8 : 0.2;
  const status = failed ? 'pending' : 'auto_approved';

  await supabase.from('agent_decisions').upsert(
    {
      agent_name: 'cron_backup_monthly',
      decision_type: 'monthly_b2_backup',
      proposed_action: {
        month: result.month,
        status: result.status,
        snapshot_daily_count: result.snapshot_daily_count,
        wapify_historical_count: result.wapify_historical_count,
        wapify_delta_count: result.wapify_delta_count,
        payload_uncompressed_bytes: result.payload_uncompressed_bytes,
        payload_gz_bytes: result.payload_gz_bytes,
        encrypted_bytes: result.encrypted_bytes,
        encryption_ratio: result.encryption_ratio,
        rotation: result.rotation,
        dry_run: dryRun,
      },
      justification:
        `Backup mensual ${result.month}: ${result.status}. ` +
        `Payload ${(result.payload_uncompressed_bytes / 1024 / 1024).toFixed(2)} MB ` +
        `→ encrypted ${(result.encrypted_bytes / 1024 / 1024).toFixed(2)} MB. ` +
        `Rotación: ${result.rotation.keys_deleted}/${result.rotation.keys_listed} purgados.` +
        (result.error ? ` ERROR: ${result.error}` : ''),
      evidence_refs: {
        sha256_of_encrypted: result.sha256_of_encrypted,
        b2_key_bin: result.b2_key_bin,
        b2_key_iv: result.b2_key_iv,
        manifest_id: result.manifest_id,
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
  const monthParam = readQueryParam(req, 'month');

  if (monthParam && !/^\d{4}-\d{2}$/.test(monthParam)) {
    res.status(400).json({
      ok: false,
      error: `?month inválido "${monthParam}"; formato esperado YYYY-MM`,
    });
    return;
  }

  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/backup-monthly] Supabase client error:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  let result: MonthlyBackupResult;
  try {
    result = await buildMonthlyBackup(supabase, {
      month: monthParam ?? undefined,
      dry_run: dryRun,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/backup-monthly] buildMonthlyBackup lanzó:', msg);
    const today = new Date().toISOString().slice(0, 10);
    try {
      await supabase.from('agent_decisions').upsert(
        {
          agent_name: 'cron_backup_monthly',
          decision_type: 'monthly_b2_backup',
          proposed_action: { error: msg, dry_run: dryRun, month: monthParam },
          justification: `Backup mensual lanzó excepción: ${msg}`,
          evidence_refs: { error_stack: err instanceof Error ? err.stack ?? null : null },
          severity: 0.9,
          status: 'pending',
          decision_key: `backup_monthly_fatal_${today}`,
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
    `[cron/backup-monthly] month=${result.month} status=${result.status} ` +
      `encrypted=${result.encrypted_bytes}b b2_key=${result.b2_key_bin ?? '(none)'} ` +
      `dry_run=${dryRun}`,
  );

  if (!dryRun) {
    try {
      await logAgentDecision(supabase, result, dryRun);
    } catch (err) {
      result.notes.push(
        `agent_decisions log falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 200 si completed, 500 si failed, 503 si aborted (B2 vars ausentes).
  const code =
    result.status === 'completed' ? 200 : result.status === 'aborted' ? 503 : 500;

  res.status(code).json({
    ok: result.status === 'completed',
    dry_run: dryRun,
    ...result,
  });
}
