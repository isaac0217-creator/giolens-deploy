/**
 * GIOCORE Frente H — Snapshot diario de tablas Supabase.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §1.
 *
 * Ajuste pragmático vs. brief:
 *   El brief asumía `~/giolens_deploy/snapshots/{date}/{table}.json.gz` en disco
 *   local. Vercel serverless no expone FS persistente (sólo /tmp ephemeral),
 *   así que persistimos el contenido gzipped + base64 inline en
 *   `backups_manifest.data_b64`. Volumen estimado: <50 MB/año (free tier OK).
 *
 *   Cuando B2 esté configurado, el cron mensual `backup-monthly` agrega los rows
 *   de este mes en un zip y los sube a B2 como capa fría.
 *
 * Restricciones (acceptance criteria brief §H):
 *   - Manifest con SHA256 por archivo (verificación integridad).
 *   - Compresión efectiva: gz < 10% del JSON original (validado por test).
 *   - Retención local (30 días) NO crashea si "disco lleno" — irrelevante con
 *     storage inline DB, pero se preserva el principio: rotación es best-effort,
 *     errores se loguean y no abortan el snapshot.
 *   - Snapshots NO incluyen filas con PII en frontmatter — irrelevante acá
 *     (no hay frontmatter; el dump es JSON crudo).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* ── Configuración ──────────────────────────────────────────────────────── */

/**
 * Lectura del manifest generado por `scripts/discover-tables.mjs` (delta D2).
 * Source of truth para qué tablas snapshotear y con qué columna de orden.
 * Re-generar con: `npm run discover-tables` cuando cambie el schema.
 */
interface TableSpec {
  name: string;
  row_estimate: number;
  pk_columns: string | null;
  order_column: string | null;
  in_brief_h: boolean;
}

interface TablesManifest {
  generated_at: string;
  total_tables: number;
  expected_per_brief_h: number;
  missing_from_brief_h: string[];
  extra_in_db: string[];
  tables: TableSpec[];
}

// Resolver el path relativo al .ts compilado/transpilado.
// Vercel bundlea el archivo JSON con la función serverless.
const __filename_ts = fileURLToPath(import.meta.url);
const MANIFEST_PATH = resolve(dirname(__filename_ts), '../backups/tables-manifest.json');

let _manifest: TablesManifest;
try {
  _manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
} catch (err) {
  throw new Error(
    `No se pudo leer tables-manifest.json en ${MANIFEST_PATH}. ` +
    `Regenerar con \`npm run discover-tables\`. Error: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

export const TABLES_MANIFEST: Readonly<TablesManifest> = _manifest;

/** Lista canónica de tablas a snapshotear (delta D2: solo las que existen). */
export const SNAPSHOT_TABLES: readonly string[] = _manifest.tables.map((t) => t.name);

/** Tablas que el brief H esperaba pero NO existen en la DB. Se loguean con
 *  severity=0.3 (info) en agent_decisions sin bloquear el snapshot. */
export const TABLES_MISSING_FROM_BRIEF: readonly string[] = _manifest.missing_from_brief_h;

const PAGE_SIZE = 1000;
const RETENTION_DAYS = 30;

/** Columna de orden por tabla, derivada del PK real detectado en discovery.
 *  Si una tabla no aparece acá, fetchAllRows fallback a 'id' (con error visible
 *  si la columna no existe — 42703 → status='failed', no skipped silencioso). */
const TABLE_ORDER_COLUMN: Record<string, string | null> = Object.fromEntries(
  _manifest.tables.map((t) => [t.name, t.order_column]),
);

/* ── Tipos ──────────────────────────────────────────────────────────────── */

export interface TableSnapshotResult {
  table: string;
  path: string;
  row_count: number;
  uncompressed_bytes: number;
  size_bytes: number;
  sha256: string;
  compression_ratio: number; // size_bytes / uncompressed_bytes (esperado <0.10)
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  /** ID del row creado en backups_manifest (null si dryRun o failed). */
  manifest_id: number | null;
}

export interface SnapshotRunResult {
  date: string; // YYYY-MM-DD
  tables_processed: number;
  tables_succeeded: number;
  tables_failed: number;
  tables_skipped: number; // tablas que no existen (HTTP 42P01 / 404)
  total_size_bytes: number;
  total_uncompressed_bytes: number;
  rows_purged_retention: number;
  results: TableSnapshotResult[];
  notes: string[];
}

export interface SnapshotOptions {
  /** Si true, no escribe en backups_manifest ni purga retención. */
  dry_run?: boolean;
  /** Subconjunto de tablas a snapshotear (default: todas). */
  only_tables?: readonly string[];
  /** Override de fecha (ISO YYYY-MM-DD). Default = hoy en UTC. */
  date?: string;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Pagina TODOS los rows de una tabla. Usa `id` (BIGSERIAL) como cursor cuando
 * existe; si no, usa offset/limit. Defensive contra tablas grandes.
 *
 * Devuelve `{ rows, skipped }` donde `skipped=true` indica que la tabla no
 * existe (Postgres 42P01) y debe omitirse sin fallar el snapshot completo.
 */
async function fetchAllRows(
  supabase: SupabaseClient,
  table: string,
): Promise<{ rows: unknown[]; skipped: boolean; error?: string; truncated?: boolean }> {
  const rows: unknown[] = [];
  let offset = 0;
  const HARD_LIMIT_PAGES = 200; // 200 × 1000 = 200K rows máx por tabla
  const orderCol = TABLE_ORDER_COLUMN[table] ?? 'id';
  let truncated = false;

  for (let page = 0; page < HARD_LIMIT_PAGES; page++) {
    // Si orderCol es null (tabla sin PK ni created_at), paginar sin .order().
    // Es menos seguro (orden no garantizado entre páginas) pero NO crashea.
    let query = supabase.from(table).select('*').range(offset, offset + PAGE_SIZE - 1);
    if (orderCol) {
      query = query.order(orderCol, { ascending: true });
    }
    const { data, error } = await query;

    if (error) {
      const code = (error as { code?: string }).code;
      const msg = error.message ?? '';

      // 42P01 = undefined_table (la tabla no existe → skip benigno explícito).
      // Patch Rectificador: ANTES regex `/does not exist/i` también matcheaba
      // 42703 (column does not exist, p.ej. orderCol erróneo) → bug silencioso
      // donde app_config (PK=`key`) se marcaba como "tabla no existe". Ahora
      // distinguimos por code de Postgres explícito.
      if (code === '42P01') {
        return { rows: [], skipped: true };
      }
      // 42703 = undefined_column (config nuestra mal — falla VISIBLE, no skip).
      if (code === '42703') {
        return {
          rows: [],
          skipped: false,
          error: `column not found en tabla ${table} (¿orderCol=${orderCol} correcto?): ${msg}`,
        };
      }

      // Para errores sin code (mocks, fallos red), regex como fallback DEFENSIVA
      // pero sólo aplicada a "relation does not exist" — frase específica de 42P01.
      if (!code && /relation .+ does not exist/i.test(msg)) {
        return { rows: [], skipped: true };
      }

      return { rows: [], skipped: false, error: msg };
    }

    const batch = (data as unknown[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    // Avisa si llegamos al tope sin terminar (truncamiento silencioso).
    if (page === HARD_LIMIT_PAGES - 1 && batch.length === PAGE_SIZE) {
      truncated = true;
    }
  }

  return { rows, skipped: false, truncated };
}

/** Compress + base64. Devuelve los buffers crudos también (para SHA256 y stats). */
function compressJson(rows: unknown[]): {
  uncompressed: Buffer;
  gz: Buffer;
  b64: string;
} {
  const json = JSON.stringify(rows);
  const uncompressed = Buffer.from(json, 'utf-8');
  const gz = gzipSync(uncompressed, { level: 9 });
  const b64 = gz.toString('base64');
  return { uncompressed, gz, b64 };
}

/* ── Función principal ──────────────────────────────────────────────────── */

/**
 * Ejecuta el snapshot de TODAS las tablas configuradas. Best-effort:
 *   - Una tabla que falla NO aborta las demás.
 *   - Una tabla que no existe (42P01) se marca 'skipped' (no failed).
 *   - La purga de retención corre al final y NUNCA aborta el snapshot.
 */
export async function snapshotAllTables(
  supabase: SupabaseClient,
  opts: SnapshotOptions = {},
): Promise<SnapshotRunResult> {
  const date = opts.date ?? todayUtc();
  const dryRun = opts.dry_run === true;
  const tables = (opts.only_tables ?? SNAPSHOT_TABLES) as readonly string[];

  const results: TableSnapshotResult[] = [];
  const notes: string[] = [];
  let totalSize = 0;
  let totalUncompressed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const table of tables) {
    const path = `snapshot_${date}/${table}.json.gz`;

    const fetched = await fetchAllRows(supabase, table);
    if (fetched.skipped) {
      results.push({
        table,
        path,
        row_count: 0,
        uncompressed_bytes: 0,
        size_bytes: 0,
        sha256: '',
        compression_ratio: 0,
        status: 'skipped',
        manifest_id: null,
      });
      skipped += 1;
      notes.push(`Tabla ${table} no existe (skip benigno).`);
      continue;
    }
    if (fetched.error) {
      results.push({
        table,
        path,
        row_count: 0,
        uncompressed_bytes: 0,
        size_bytes: 0,
        sha256: '',
        compression_ratio: 0,
        status: 'failed',
        error: fetched.error,
        manifest_id: null,
      });
      failed += 1;
      notes.push(`Tabla ${table} falló: ${fetched.error}`);
      continue;
    }
    if (fetched.truncated) {
      notes.push(
        `Tabla ${table} alcanzó HARD_LIMIT_PAGES (${PAGE_SIZE * 200} rows); ` +
          'snapshot puede estar truncado. Considerar subir el límite.',
      );
    }

    const { uncompressed, gz, b64 } = compressJson(fetched.rows);
    const sha = sha256Hex(gz);
    const ratio = uncompressed.byteLength > 0 ? gz.byteLength / uncompressed.byteLength : 0;
    totalSize += gz.byteLength;
    totalUncompressed += uncompressed.byteLength;

    let manifestId: number | null = null;

    if (!dryRun) {
      const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
      const { data: ins, error: insErr } = await supabase
        .from('backups_manifest')
        .insert({
          type: 'snapshot_daily',
          path,
          sha256: sha,
          size_bytes: gz.byteLength,
          uncompressed_bytes: uncompressed.byteLength,
          row_counts: { [table]: fetched.rows.length },
          storage: 'supabase_inline',
          data_b64: b64,
          status: 'completed',
          completed_at: new Date().toISOString(),
          expires_at: expiresAt,
          metadata: { snapshot_date: date, compression_ratio: ratio },
        })
        .select('id')
        .single();

      if (insErr) {
        results.push({
          table,
          path,
          row_count: fetched.rows.length,
          uncompressed_bytes: uncompressed.byteLength,
          size_bytes: gz.byteLength,
          sha256: sha,
          compression_ratio: ratio,
          status: 'failed',
          error: `insert backups_manifest: ${insErr.message}`,
          manifest_id: null,
        });
        failed += 1;
        continue;
      }
      manifestId = (ins as { id: number }).id;
    }

    results.push({
      table,
      path,
      row_count: fetched.rows.length,
      uncompressed_bytes: uncompressed.byteLength,
      size_bytes: gz.byteLength,
      sha256: sha,
      compression_ratio: ratio,
      status: 'completed',
      manifest_id: manifestId,
    });
    succeeded += 1;
  }

  // Retención: borra rows snapshot_daily completados con expires_at en el pasado.
  // Best-effort — si falla, lo logueamos pero no abortamos.
  let rowsPurged = 0;
  if (!dryRun) {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
      const { data: del, error: delErr } = await supabase
        .from('backups_manifest')
        .delete()
        .eq('type', 'snapshot_daily')
        .eq('status', 'completed')
        .lt('created_at', cutoff)
        .select('id');
      if (delErr) {
        notes.push(`Retención falló (best-effort): ${delErr.message}`);
      } else {
        rowsPurged = (del as unknown[] | null)?.length ?? 0;
      }
    } catch (e) {
      notes.push(`Retención exception: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    date,
    tables_processed: results.length,
    tables_succeeded: succeeded,
    tables_failed: failed,
    tables_skipped: skipped,
    total_size_bytes: totalSize,
    total_uncompressed_bytes: totalUncompressed,
    rows_purged_retention: rowsPurged,
    results,
    notes,
  };
}
