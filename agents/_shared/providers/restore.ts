/**
 * GIOCORE Frente H · 1.7 — Restore desde snapshot en backups_manifest.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §5 + delta D2.
 *
 * Restaura una tabla desde un row inline de `backups_manifest`:
 *   1. Lee data_b64 + sha256 del manifiesto.
 *   2. Verifica integridad (SHA256 del gz decodificado vs. manifest.sha256).
 *   3. Gunzip + JSON.parse → array de rows originales.
 *   4. (NO dry_run) DELETE FROM target_table WHERE ...; INSERT rows en lotes.
 *
 * Restricciones inviolables:
 *   - PROTECTED_TABLES nunca se restauran (append-only/forensic): `agent_decisions`,
 *     `audit_log`, `human_approvals`, `agent_messages`, `agent_runs`, `stage_events`,
 *     `backups_manifest`. Restaurarlas borraría historia de auditoría.
 *   - dry_run=true devuelve preview (row count + sample) sin escribir.
 *   - Log severity=1.0 SIEMPRE en agent_decisions (restore es destructive).
 *
 * Estrategia de restore:
 *   - "wipe_and_insert" (default): TRUNCATE-equivalent vía DELETE FROM table; INSERT.
 *   - "upsert_only" (opcional): UPSERT rows (no DELETE) — preserva rows nuevas creadas
 *     después del snapshot. Riesgo: deja rows que NO estaban en el snapshot.
 *
 * Limitaciones:
 *   - Supabase JS client no soporta TRUNCATE; usamos `DELETE FROM t` que respeta RLS
 *     (con service_role pasa por encima de RLS).
 *   - No restauramos secuencias (BIGSERIAL); si los rows insertados tienen id explícito,
 *     Postgres no avanza la secuencia → próximo INSERT puede colisionar. Documentar
 *     como issue conocido; mitigación: post-restore `SELECT setval('t_id_seq', MAX(id))`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/* ── Configuración ──────────────────────────────────────────────────────── */

/** Tablas que NO se pueden restaurar (audit / append-only). */
export const PROTECTED_TABLES: ReadonlySet<string> = new Set([
  'agent_decisions',
  'audit_log',
  'human_approvals',
  'agent_messages',
  'agent_runs',
  'stage_events',
  'backups_manifest', // self-reference
]);

const INSERT_BATCH_SIZE = 500;

/* ── Tipos ──────────────────────────────────────────────────────────────── */

export type RestoreStrategy = 'wipe_and_insert' | 'upsert_only';

export interface RestoreOptions {
  manifest_id: number;
  target_table: string;
  strategy?: RestoreStrategy;
  dry_run?: boolean;
  /** Header X-Restore-Intent: descripción human-readable del por qué Isaac hace este restore.
   *  Se persiste en agent_decisions.evidence_refs.intent. Obligatorio en handler. */
  intent: string;
}

export interface RestoreResult {
  manifest_id: number;
  target_table: string;
  strategy: RestoreStrategy;
  dry_run: boolean;

  // Integridad
  manifest_sha256: string;
  recomputed_sha256: string;
  sha256_match: boolean;

  // Conteos
  rows_in_snapshot: number;
  rows_deleted: number;      // 0 si dry_run o upsert_only
  rows_inserted: number;     // 0 si dry_run
  rows_skipped_errors: number;

  // Preview (primeros 3 rows del snapshot, sólo si dry_run)
  preview_sample?: unknown[];

  status: 'completed' | 'failed' | 'aborted';
  error?: string;
  notes: string[];
}

/* ── Función principal ──────────────────────────────────────────────────── */

export async function restoreFromManifest(
  supabase: SupabaseClient,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const strategy: RestoreStrategy = opts.strategy ?? 'wipe_and_insert';
  const dryRun = opts.dry_run === true;
  const notes: string[] = [];

  const baseResult: Omit<RestoreResult, 'status' | 'manifest_sha256' | 'recomputed_sha256' | 'sha256_match' | 'rows_in_snapshot' | 'rows_deleted' | 'rows_inserted' | 'rows_skipped_errors'> = {
    manifest_id: opts.manifest_id,
    target_table: opts.target_table,
    strategy,
    dry_run: dryRun,
    notes,
  };

  // 1 · Validar tabla protected
  if (PROTECTED_TABLES.has(opts.target_table)) {
    return {
      ...baseResult,
      manifest_sha256: '',
      recomputed_sha256: '',
      sha256_match: false,
      rows_in_snapshot: 0,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'aborted',
      error: `target_table "${opts.target_table}" está en PROTECTED_TABLES y NO se puede restaurar`,
      notes,
    };
  }

  // 2 · Leer manifest
  const { data: manifest, error: mfErr } = await supabase
    .from('backups_manifest')
    .select('id, type, path, sha256, size_bytes, status, storage, data_b64, row_counts')
    .eq('id', opts.manifest_id)
    .maybeSingle();

  if (mfErr || !manifest) {
    return {
      ...baseResult,
      manifest_sha256: '',
      recomputed_sha256: '',
      sha256_match: false,
      rows_in_snapshot: 0,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'failed',
      error: `manifest_id ${opts.manifest_id} no encontrado: ${mfErr?.message ?? 'null result'}`,
      notes,
    };
  }

  if (manifest.status !== 'completed') {
    return {
      ...baseResult,
      manifest_sha256: manifest.sha256 ?? '',
      recomputed_sha256: '',
      sha256_match: false,
      rows_in_snapshot: 0,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'aborted',
      error: `manifest status=${manifest.status} (esperado 'completed')`,
      notes,
    };
  }

  if (manifest.storage !== 'supabase_inline' || !manifest.data_b64) {
    return {
      ...baseResult,
      manifest_sha256: manifest.sha256 ?? '',
      recomputed_sha256: '',
      sha256_match: false,
      rows_in_snapshot: 0,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'aborted',
      error: `restore desde storage=${manifest.storage} aún no implementado (post-CHECKPOINT 1.6.5 cuando B2 esté listo)`,
      notes,
    };
  }

  // 3 · Verificar integridad SHA256
  const gzBuf = Buffer.from(manifest.data_b64, 'base64');
  const recomputed = createHash('sha256').update(gzBuf).digest('hex');
  const sha256Match = recomputed === manifest.sha256;

  if (!sha256Match) {
    return {
      ...baseResult,
      manifest_sha256: manifest.sha256 ?? '',
      recomputed_sha256: recomputed,
      sha256_match: false,
      rows_in_snapshot: 0,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'failed',
      error: `SHA256 mismatch: manifest=${manifest.sha256} recomputed=${recomputed}. Manifest corrupto o tampered.`,
      notes,
    };
  }

  // 4 · Decompress + parse
  let rows: unknown[];
  try {
    const json = gunzipSync(gzBuf).toString('utf-8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('parsed JSON no es un array');
    }
    rows = parsed;
  } catch (err) {
    return {
      ...baseResult,
      manifest_sha256: manifest.sha256 ?? '',
      recomputed_sha256: recomputed,
      sha256_match: true,
      rows_in_snapshot: 0,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'failed',
      error: `decompress/parse: ${err instanceof Error ? err.message : String(err)}`,
      notes,
    };
  }

  // 5 · Validar que el snapshot es de la tabla pedida (vía row_counts o path)
  const rowCountsObj = manifest.row_counts as Record<string, number> | null;
  if (rowCountsObj && !(opts.target_table in rowCountsObj)) {
    return {
      ...baseResult,
      manifest_sha256: manifest.sha256 ?? '',
      recomputed_sha256: recomputed,
      sha256_match: true,
      rows_in_snapshot: rows.length,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      status: 'aborted',
      error:
        `manifest_id ${opts.manifest_id} es para tabla(s) ${Object.keys(rowCountsObj).join(',')}, ` +
        `NO ${opts.target_table}`,
      notes,
    };
  }

  // 6 · Dry run: preview y return
  if (dryRun) {
    return {
      ...baseResult,
      manifest_sha256: manifest.sha256 ?? '',
      recomputed_sha256: recomputed,
      sha256_match: true,
      rows_in_snapshot: rows.length,
      rows_deleted: 0,
      rows_inserted: 0,
      rows_skipped_errors: 0,
      preview_sample: rows.slice(0, 3),
      status: 'completed',
      notes: ['dry_run=true; no se modificó la tabla'],
    };
  }

  // 7 · Ejecutar restore real
  let deleted = 0;
  let inserted = 0;
  let skippedErrors = 0;

  // 7.a · DELETE si strategy=wipe_and_insert
  if (strategy === 'wipe_and_insert') {
    // Supabase JS no soporta TRUNCATE; usamos un DELETE incondicional.
    // Para tablas con PK numérica usamos `.neq('id', -1)` (always true);
    // para PK texto fallback `.not('<pk>', 'is', null)`. Defensivo.
    const { error: delErr, count } = await supabase
      .from(opts.target_table)
      .delete({ count: 'exact' })
      .not('ctid', 'is', null); // ctid existe en TODA tabla Postgres

    if (delErr) {
      return {
        ...baseResult,
        manifest_sha256: manifest.sha256 ?? '',
        recomputed_sha256: recomputed,
        sha256_match: true,
        rows_in_snapshot: rows.length,
        rows_deleted: 0,
        rows_inserted: 0,
        rows_skipped_errors: 0,
        status: 'failed',
        error: `DELETE FROM ${opts.target_table} falló: ${delErr.message}`,
        notes,
      };
    }
    deleted = count ?? 0;
  }

  // 7.b · INSERT en lotes
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const op =
      strategy === 'upsert_only'
        ? supabase.from(opts.target_table).upsert(batch as object[])
        : supabase.from(opts.target_table).insert(batch as object[]);
    const { error: insErr } = await op;
    if (insErr) {
      skippedErrors += batch.length;
      notes.push(`Batch ${i / INSERT_BATCH_SIZE} falló (${batch.length} rows): ${insErr.message}`);
    } else {
      inserted += batch.length;
    }
  }

  return {
    ...baseResult,
    manifest_sha256: manifest.sha256 ?? '',
    recomputed_sha256: recomputed,
    sha256_match: true,
    rows_in_snapshot: rows.length,
    rows_deleted: deleted,
    rows_inserted: inserted,
    rows_skipped_errors: skippedErrors,
    status: skippedErrors > 0 && inserted === 0 ? 'failed' : 'completed',
    notes,
  };
}
