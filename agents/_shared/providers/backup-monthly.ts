/**
 * GIOCORE Frente H · 1.6 — Construcción del backup mensual cifrado para B2.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §3.
 *
 * Ajustes pragmáticos vs. brief:
 *   - Brief dice "zip cifrado con password". Implementación: AES-256-GCM
 *     directo sobre JSON gzipped, en vez de ZIP encryption (que requiere libs
 *     externas y formatos legacy con keys débiles). Usa sólo `node:crypto`
 *     built-in. Output: `.bin` (gz cifrado) + `.iv` (initialization vector)
 *     subidos juntos a B2.
 *
 *   - Brief incluye Vault Obsidian local en el zip. En Vercel serverless NO
 *     hay acceso FS al vault de Isaac → omitimos (vault se exporta vía script
 *     local separado cuando Isaac quiera).
 *
 *   - Brief incluye "dump SQL semanal más reciente". Ese dump vive en B2
 *     (subido por GitHub Action `sql-dump-weekly.yml`); el backup mensual NO
 *     lo re-empaqueta, sólo lista su existencia en el manifiesto.
 *
 * Estructura del payload mensual (pre-encrypt):
 * {
 *   "version": 1,
 *   "month": "2026-05",
 *   "generated_at": "2026-06-01T08:00:00.000Z",
 *   "snapshot_daily_rows": [ ... rows de backups_manifest ],
 *   "wapify_historical_rows": [ ... ],
 *   "wapify_delta_rows": [ ... ],
 *   "stats": { ... }
 * }
 *
 * Encryption flow:
 *   key = scrypt(B2_ZIP_PASSPHRASE, salt='giocore-monthly', N=32)
 *   iv  = randomBytes(12)
 *   ciphertext = AES-256-GCM(key, iv, gzippedJson) || authTag(16 bytes)
 *
 * Decryption (en restore):
 *   key = scrypt(B2_ZIP_PASSPHRASE, salt='giocore-monthly', N=32)
 *   iv  = read from .iv file
 *   plaintext = AES-256-GCM-Decrypt(key, iv, ciphertext_minus_authTag, authTag)
 *
 * Restricciones:
 *   - B2_ZIP_PASSPHRASE mínimo 32 chars (sanity check). 1Password recomendado.
 *   - Si passphrase falta → return aborted (NO subimos sin cifrar).
 *   - Retención 12 meses en B2 (rotación al final del run).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { uploadToB2, listB2, deleteFromB2, isB2Configured } from './backblaze.js';

/* ── Configuración ──────────────────────────────────────────────────────── */

const ENCRYPTION_SALT = 'giocore-monthly-v1';
const ENCRYPTION_ALGO = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;  // GCM standard
const AUTH_TAG_LENGTH = 16;
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const MIN_PASSPHRASE_LEN = 32;
const B2_RETENTION_MONTHS = 12;

/* ── Tipos ──────────────────────────────────────────────────────────────── */

export interface MonthlyBackupResult {
  month: string;                  // 'YYYY-MM'
  generated_at: string;           // ISO
  snapshot_daily_count: number;
  wapify_historical_count: number;
  wapify_delta_count: number;
  payload_uncompressed_bytes: number;
  payload_gz_bytes: number;
  encrypted_bytes: number;
  encryption_ratio: number;       // encrypted/uncompressed
  sha256_of_encrypted: string;
  b2_key_bin: string | null;      // null si dry_run o B2 falla
  b2_key_iv: string | null;
  status: 'completed' | 'failed' | 'aborted';
  error?: string;
  rotation: {
    keys_listed: number;
    keys_deleted: number;
  };
  manifest_id: number | null;
  notes: string[];
}

export interface MonthlyBackupOptions {
  /** Override del mes (default = mes anterior, completo). */
  month?: string;        // 'YYYY-MM'
  dry_run?: boolean;
  /** Override passphrase (tests). Default: process.env.B2_ZIP_PASSPHRASE. */
  passphrase?: string;
  /** Si true, skip upload B2 (útil para test local). */
  skip_upload?: boolean;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function previousMonth(today = new Date()): string {
  const d = new Date(today);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function monthBounds(monthYYYYMM: string): { from: string; to: string } {
  const [y, m] = monthYYYYMM.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from: from.toISOString(), to: to.toISOString() };
}

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, ENCRYPTION_SALT, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
}

/**
 * Cifra el payload con AES-256-GCM. Devuelve `{ ciphertext, iv, authTag }`.
 * El blob final que se sube a B2 es `ciphertext || authTag` (concatenados).
 * El IV se sube por separado en un archivo `.iv` (NO secreto — IV solo
 * necesita ser único, no privado, en GCM).
 */
export function encryptPayload(plaintext: Buffer, passphrase: string): {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  combined: Buffer; // ciphertext || authTag
} {
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(
      `B2_ZIP_PASSPHRASE debe ser mínimo ${MIN_PASSPHRASE_LEN} chars (actual: ${passphrase.length})`,
    );
  }
  const key = deriveKey(passphrase);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([ciphertext, authTag]);
  return { ciphertext, iv, authTag, combined };
}

/** Inversa de encryptPayload — usado en restore (smoke + futuro endpoint). */
export function decryptPayload(combined: Buffer, iv: Buffer, passphrase: string): Buffer {
  if (combined.byteLength < AUTH_TAG_LENGTH) {
    throw new Error('combined blob demasiado corto (sin authTag)');
  }
  const key = deriveKey(passphrase);
  const ciphertext = combined.subarray(0, combined.byteLength - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.byteLength - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/* ── Función principal ──────────────────────────────────────────────────── */

export async function buildMonthlyBackup(
  supabase: SupabaseClient,
  opts: MonthlyBackupOptions = {},
): Promise<MonthlyBackupResult> {
  const notes: string[] = [];
  const month = opts.month ?? previousMonth();
  const generatedAt = new Date().toISOString();
  const dryRun = opts.dry_run === true;
  const passphrase = opts.passphrase ?? process.env.B2_ZIP_PASSPHRASE ?? '';

  const baseResult: Omit<MonthlyBackupResult, 'status' | 'snapshot_daily_count' | 'wapify_historical_count' | 'wapify_delta_count' | 'payload_uncompressed_bytes' | 'payload_gz_bytes' | 'encrypted_bytes' | 'encryption_ratio' | 'sha256_of_encrypted' | 'b2_key_bin' | 'b2_key_iv' | 'rotation' | 'manifest_id'> = {
    month,
    generated_at: generatedAt,
    notes,
  };

  // 1 · Validar passphrase + B2 configurado
  if (!passphrase) {
    return {
      ...baseResult,
      snapshot_daily_count: 0,
      wapify_historical_count: 0,
      wapify_delta_count: 0,
      payload_uncompressed_bytes: 0,
      payload_gz_bytes: 0,
      encrypted_bytes: 0,
      encryption_ratio: 0,
      sha256_of_encrypted: '',
      b2_key_bin: null,
      b2_key_iv: null,
      rotation: { keys_listed: 0, keys_deleted: 0 },
      manifest_id: null,
      status: 'aborted',
      error: 'B2_ZIP_PASSPHRASE no está en el entorno (Isaac aún no lo cargó).',
    };
  }
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    return {
      ...baseResult,
      snapshot_daily_count: 0,
      wapify_historical_count: 0,
      wapify_delta_count: 0,
      payload_uncompressed_bytes: 0,
      payload_gz_bytes: 0,
      encrypted_bytes: 0,
      encryption_ratio: 0,
      sha256_of_encrypted: '',
      b2_key_bin: null,
      b2_key_iv: null,
      rotation: { keys_listed: 0, keys_deleted: 0 },
      manifest_id: null,
      status: 'aborted',
      error: `B2_ZIP_PASSPHRASE muy corto (${passphrase.length} < ${MIN_PASSPHRASE_LEN}).`,
    };
  }
  if (!dryRun && !opts.skip_upload && !isB2Configured()) {
    return {
      ...baseResult,
      snapshot_daily_count: 0,
      wapify_historical_count: 0,
      wapify_delta_count: 0,
      payload_uncompressed_bytes: 0,
      payload_gz_bytes: 0,
      encrypted_bytes: 0,
      encryption_ratio: 0,
      sha256_of_encrypted: '',
      b2_key_bin: null,
      b2_key_iv: null,
      rotation: { keys_listed: 0, keys_deleted: 0 },
      manifest_id: null,
      status: 'aborted',
      error: 'B2 no configurado (faltan vars B2_KEY_ID/B2_APP_KEY/B2_BUCKET/B2_BUCKET_ID).',
    };
  }

  // 2 · Query backups_manifest del mes
  const { from, to } = monthBounds(month);

  async function fetchRows(types: string[]): Promise<unknown[]> {
    const { data, error } = await supabase
      .from('backups_manifest')
      .select(
        'id, type, path, sha256, size_bytes, uncompressed_bytes, row_counts, ' +
          'storage, b2_key, data_b64, status, error_message, metadata, ' +
          'created_at, completed_at',
      )
      .in('type', types)
      .eq('status', 'completed')
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`Query ${types.join(',')} falló: ${error.message}`);
    }
    return (data as unknown[]) ?? [];
  }

  let snapshotRows: unknown[];
  let historicalRows: unknown[];
  let deltaRows: unknown[];
  try {
    [snapshotRows, historicalRows, deltaRows] = await Promise.all([
      fetchRows(['snapshot_daily']),
      fetchRows(['wapify_historical']),
      fetchRows(['wapify_delta']),
    ]);
  } catch (err) {
    return {
      ...baseResult,
      snapshot_daily_count: 0,
      wapify_historical_count: 0,
      wapify_delta_count: 0,
      payload_uncompressed_bytes: 0,
      payload_gz_bytes: 0,
      encrypted_bytes: 0,
      encryption_ratio: 0,
      sha256_of_encrypted: '',
      b2_key_bin: null,
      b2_key_iv: null,
      rotation: { keys_listed: 0, keys_deleted: 0 },
      manifest_id: null,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3 · Construir payload + comprimir + cifrar
  const payload = {
    version: 1,
    month,
    generated_at: generatedAt,
    bounds: { from, to },
    snapshot_daily_rows: snapshotRows,
    wapify_historical_rows: historicalRows,
    wapify_delta_rows: deltaRows,
    stats: {
      snapshot_daily_count: snapshotRows.length,
      wapify_historical_count: historicalRows.length,
      wapify_delta_count: deltaRows.length,
    },
  };

  const json = JSON.stringify(payload);
  const uncompressed = Buffer.from(json, 'utf-8');
  const gz = gzipSync(uncompressed, { level: 9 });

  let encrypted;
  try {
    encrypted = encryptPayload(gz, passphrase);
  } catch (err) {
    return {
      ...baseResult,
      snapshot_daily_count: snapshotRows.length,
      wapify_historical_count: historicalRows.length,
      wapify_delta_count: deltaRows.length,
      payload_uncompressed_bytes: uncompressed.byteLength,
      payload_gz_bytes: gz.byteLength,
      encrypted_bytes: 0,
      encryption_ratio: 0,
      sha256_of_encrypted: '',
      b2_key_bin: null,
      b2_key_iv: null,
      rotation: { keys_listed: 0, keys_deleted: 0 },
      manifest_id: null,
      status: 'failed',
      error: `encryption error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const shaEncrypted = createHash('sha256').update(encrypted.combined).digest('hex');
  const b2KeyBin = `backup_monthly/${month}/giocore-${month}.bin`;
  const b2KeyIv = `backup_monthly/${month}/giocore-${month}.iv`;

  // 4 · Upload a B2 (o skip si dry_run / skip_upload)
  let uploadOk = false;
  if (!dryRun && !opts.skip_upload) {
    try {
      // Subir ciphertext+authTag (multipart automático si >8 MB)
      await uploadToB2(b2KeyBin, encrypted.combined, {
        contentType: 'application/octet-stream',
        metadata: { month, sha256: shaEncrypted, algo: ENCRYPTION_ALGO },
      });
      // Subir IV (12 bytes; siempre <8 MB)
      await uploadToB2(b2KeyIv, encrypted.iv, {
        contentType: 'application/octet-stream',
      });
      uploadOk = true;
    } catch (err) {
      return {
        ...baseResult,
        snapshot_daily_count: snapshotRows.length,
        wapify_historical_count: historicalRows.length,
        wapify_delta_count: deltaRows.length,
        payload_uncompressed_bytes: uncompressed.byteLength,
        payload_gz_bytes: gz.byteLength,
        encrypted_bytes: encrypted.combined.byteLength,
        encryption_ratio:
          uncompressed.byteLength > 0
            ? encrypted.combined.byteLength / uncompressed.byteLength
            : 0,
        sha256_of_encrypted: shaEncrypted,
        b2_key_bin: null,
        b2_key_iv: null,
        rotation: { keys_listed: 0, keys_deleted: 0 },
        manifest_id: null,
        status: 'failed',
        error: `B2 upload: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 5 · Persistir manifest row
  let manifestId: number | null = null;
  if (!dryRun) {
    const { data: ins, error: insErr } = await supabase
      .from('backups_manifest')
      .insert({
        type: 'backup_monthly',
        path: b2KeyBin,
        sha256: shaEncrypted,
        size_bytes: encrypted.combined.byteLength,
        uncompressed_bytes: uncompressed.byteLength,
        row_counts: {
          snapshot_daily: snapshotRows.length,
          wapify_historical: historicalRows.length,
          wapify_delta: deltaRows.length,
        },
        storage: uploadOk ? 'b2' : 'supabase_inline',
        b2_key: uploadOk ? b2KeyBin : null,
        // NO subimos el contenido cifrado a Supabase (es grande). Sólo metadata.
        data_b64: null,
        status: uploadOk ? 'completed' : 'failed',
        completed_at: new Date().toISOString(),
        metadata: {
          month,
          generated_at: generatedAt,
          encryption_algo: ENCRYPTION_ALGO,
          b2_key_bin: uploadOk ? b2KeyBin : null,
          b2_key_iv: uploadOk ? b2KeyIv : null,
        },
      })
      .select('id')
      .single();
    if (insErr) {
      notes.push(`Insert manifest falló: ${insErr.message}`);
    } else {
      manifestId = (ins as { id: number }).id;
    }
  }

  // 6 · Rotación 12 meses (best-effort)
  let rotation = { keys_listed: 0, keys_deleted: 0 };
  if (!dryRun && uploadOk) {
    try {
      const allBackups = await listB2('backup_monthly/');
      rotation.keys_listed = allBackups.length;
      const cutoffMonth = new Date();
      cutoffMonth.setUTCMonth(cutoffMonth.getUTCMonth() - B2_RETENTION_MONTHS);
      const cutoffStr = cutoffMonth.toISOString().slice(0, 7);

      for (const item of allBackups) {
        // Key shape: backup_monthly/YYYY-MM/giocore-YYYY-MM.{bin,iv}
        const m = item.key.match(/backup_monthly\/(\d{4}-\d{2})\//);
        if (!m) continue;
        if (m[1] < cutoffStr) {
          try {
            await deleteFromB2(item.key);
            rotation.keys_deleted += 1;
          } catch (e) {
            notes.push(
              `Delete ${item.key} falló: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    } catch (err) {
      notes.push(
        `Rotación falló (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    month,
    generated_at: generatedAt,
    snapshot_daily_count: snapshotRows.length,
    wapify_historical_count: historicalRows.length,
    wapify_delta_count: deltaRows.length,
    payload_uncompressed_bytes: uncompressed.byteLength,
    payload_gz_bytes: gz.byteLength,
    encrypted_bytes: encrypted.combined.byteLength,
    encryption_ratio:
      uncompressed.byteLength > 0
        ? encrypted.combined.byteLength / uncompressed.byteLength
        : 0,
    sha256_of_encrypted: shaEncrypted,
    b2_key_bin: uploadOk ? b2KeyBin : null,
    b2_key_iv: uploadOk ? b2KeyIv : null,
    rotation,
    manifest_id: manifestId,
    status: 'completed',
    notes,
  };
}
