/**
 * GIOCORE Frente H · 1.7 — Endpoint admin de restore desde snapshot.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §5 + delta.
 *
 * SEGURIDAD — triple verificación obligatoria:
 *   1. Header `Authorization: Bearer ${CRON_SECRET}` (sin esto → 401).
 *   2. Query `?confirm=true` (sin esto → 400).
 *   3. Header `X-Restore-Intent: <descripción>` (sin esto → 400).
 *
 * El handler NUNCA acepta GET (sólo POST, restore es destructivo). CORS
 * inexistente — endpoint admin server-to-server, nunca browser.
 *
 * Auditoría:
 *   - Log obligatorio en `agent_decisions` con severity=1.0 (max), independiente
 *     de success/failure. Si la persistencia del log falla, el restore se cancela
 *     (NO permitimos restore sin trail de auditoría).
 *
 * Method: POST con body JSON:
 *   {
 *     "manifest_id": 1234,            // id del row backups_manifest a restaurar
 *     "target_table": "contacts",     // tabla destino (no PROTECTED_TABLES)
 *     "strategy": "wipe_and_insert",  // o "upsert_only" (opcional)
 *     "dry_run": false                // si true: preview, no modifica
 *   }
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  restoreFromManifest,
  PROTECTED_TABLES,
  type RestoreResult,
  type RestoreStrategy,
} from '../../agents/_shared/providers/restore.js';

/* ── Tipos handler ──────────────────────────────────────────────────────── */

interface VercelLikeReq {
  method?: string;
  url?: string;
  body?: unknown;
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

function readQuery(req: VercelLikeReq, name: string): string | null {
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

function readHeader(req: VercelLikeReq, name: string): string | null {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  if (typeof raw === 'string') return raw;
  return null;
}

function parseBody(body: unknown): {
  manifest_id?: number;
  target_table?: string;
  strategy?: RestoreStrategy;
  dry_run?: boolean;
} {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  if (typeof body === 'object') return body as Record<string, unknown> as ReturnType<typeof parseBody>;
  return {};
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (res.setHeader) res.setHeader('Cache-Control', 'no-store, max-age=0');

  // 0 · Method
  if (req.method && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: `Method ${req.method} not allowed; usar POST` });
    return;
  }

  // 1 · Auth
  const auth = readHeader(req, 'authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  // 2 · ?confirm=true obligatorio
  const confirm = readQuery(req, 'confirm');
  if (confirm !== 'true') {
    res.status(400).json({
      ok: false,
      error: 'Query param `?confirm=true` obligatorio para restore (doble confirmación)',
    });
    return;
  }

  // 3 · X-Restore-Intent header obligatorio
  const intent = readHeader(req, 'x-restore-intent');
  if (!intent || intent.length < 10) {
    res.status(400).json({
      ok: false,
      error:
        'Header `X-Restore-Intent` obligatorio (mínimo 10 chars). ' +
        'Describir el motivo del restore, ej: "smoke test post-deploy".',
    });
    return;
  }

  // 4 · Body
  const body = parseBody(req.body);
  const { manifest_id, target_table, strategy, dry_run } = body;

  if (!manifest_id || typeof manifest_id !== 'number') {
    res.status(400).json({ ok: false, error: '`manifest_id` (number) requerido en el body' });
    return;
  }
  if (!target_table || typeof target_table !== 'string') {
    res.status(400).json({ ok: false, error: '`target_table` (string) requerido en el body' });
    return;
  }
  if (PROTECTED_TABLES.has(target_table)) {
    res.status(403).json({
      ok: false,
      error: `target_table "${target_table}" es PROTECTED (append-only audit). Restore prohibido.`,
      protected_list: Array.from(PROTECTED_TABLES),
    });
    return;
  }
  if (strategy && strategy !== 'wipe_and_insert' && strategy !== 'upsert_only') {
    res.status(400).json({
      ok: false,
      error: `strategy inválido "${strategy}"; usar "wipe_and_insert" o "upsert_only"`,
    });
    return;
  }

  // 5 · Cliente Supabase
  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  // 6 · Log PRE-RESTORE (severity 1.0 — independiente del resultado).
  //     Si NO podemos persistir el log, abortamos: nunca restore sin audit.
  const startedAt = new Date().toISOString();
  const preLogKey = `restore_${manifest_id}_${target_table}_${startedAt.replace(/[:.]/g, '-')}`;

  try {
    const { error: preLogErr } = await supabase.from('agent_decisions').insert({
      agent_name: 'admin_restore',
      decision_type: 'data_restore_initiated',
      proposed_action: {
        manifest_id,
        target_table,
        strategy: strategy ?? 'wipe_and_insert',
        dry_run: dry_run === true,
        started_at: startedAt,
      },
      justification:
        `Restore iniciado · manifest_id=${manifest_id} → ${target_table} ` +
        `(strategy=${strategy ?? 'wipe_and_insert'}, dry_run=${dry_run === true}). ` +
        `Intent: "${intent}".`,
      evidence_refs: { intent, decision_key: preLogKey },
      severity: 1.0,
      status: 'auto_approved',
      decision_key: preLogKey,
    });
    if (preLogErr) {
      res.status(503).json({
        ok: false,
        error:
          `No se pudo persistir el log pre-restore en agent_decisions: ${preLogErr.message}. ` +
          'Restore CANCELADO (no permitimos restore sin audit trail).',
      });
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({
      ok: false,
      error: `Excepción al persistir log pre-restore: ${msg}. Restore CANCELADO.`,
    });
    return;
  }

  // 7 · Ejecutar restore
  let result: RestoreResult;
  try {
    result = await restoreFromManifest(supabase, {
      manifest_id,
      target_table,
      strategy,
      dry_run: dry_run === true,
      intent,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log post con failure
    await supabase.from('agent_decisions').insert({
      agent_name: 'admin_restore',
      decision_type: 'data_restore_completed',
      proposed_action: { manifest_id, target_table, error: msg },
      justification: `Restore lanzó excepción: ${msg}`,
      evidence_refs: { intent, pre_log_key: preLogKey, error_stack: err instanceof Error ? err.stack ?? null : null },
      severity: 1.0,
      status: 'pending',
    });
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  // 8 · Log POST-RESTORE
  try {
    await supabase.from('agent_decisions').insert({
      agent_name: 'admin_restore',
      decision_type: 'data_restore_completed',
      proposed_action: {
        manifest_id,
        target_table,
        strategy: result.strategy,
        dry_run: result.dry_run,
        rows_in_snapshot: result.rows_in_snapshot,
        rows_deleted: result.rows_deleted,
        rows_inserted: result.rows_inserted,
        rows_skipped_errors: result.rows_skipped_errors,
        sha256_match: result.sha256_match,
        status: result.status,
      },
      justification:
        `Restore ${result.status} · ${target_table} ← manifest ${manifest_id}. ` +
        `Snapshot=${result.rows_in_snapshot} rows; deleted=${result.rows_deleted}; ` +
        `inserted=${result.rows_inserted}; errors=${result.rows_skipped_errors}. ` +
        `Intent: "${intent}".`,
      evidence_refs: { intent, pre_log_key: preLogKey, notes: result.notes },
      severity: 1.0,
      status: result.status === 'completed' ? 'auto_approved' : 'pending',
    });
  } catch (err) {
    result.notes.push(
      `agent_decisions post-log falló (restore ya ejecutado): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  res.status(result.status === 'failed' ? 500 : 200).json({
    ok: result.status !== 'failed',
    ...result,
  });
}
