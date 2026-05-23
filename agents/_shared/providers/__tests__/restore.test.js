/**
 * GIOCORE Frente H · 1.7 — Tests del provider restoreFromManifest.
 *
 * Cubre:
 *   - PROTECTED_TABLES rejection (agent_decisions, audit_log, etc.)
 *   - manifest_id no existe → failed
 *   - manifest.status != 'completed' → aborted
 *   - SHA256 mismatch → failed (tampering detection)
 *   - dry_run devuelve preview sin escribir
 *   - target_table != tabla del snapshot → aborted
 *   - wipe_and_insert: DELETE + INSERT en lotes
 *   - upsert_only: solo upsert (no DELETE)
 *   - Insert errors: contabilizados en rows_skipped_errors
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  restoreFromManifest,
  PROTECTED_TABLES,
} from '../restore.ts';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/* ── Mock supabase reusable ─────────────────────────────────────────────── */

function makeManifestRow({ rows, table, status = 'completed', storage = 'supabase_inline', tampered = false }) {
  const json = JSON.stringify(rows);
  const gz = gzipSync(Buffer.from(json, 'utf-8'));
  const sha = createHash('sha256').update(gz).digest('hex');
  return {
    id: 1234,
    type: 'snapshot_daily',
    path: `snapshot_2026-05-23/${table}.json.gz`,
    sha256: tampered ? 'deadbeef'.repeat(8) : sha,
    size_bytes: gz.byteLength,
    status,
    storage,
    data_b64: gz.toString('base64'),
    row_counts: { [table]: rows.length },
  };
}

function makeSupabase(manifestRow, opts = {}) {
  const calls = { deletes: [], inserts: [], upserts: [], selects: [] };
  const insertError = opts.insertError ?? null;
  const deleteError = opts.deleteError ?? null;

  return {
    calls,
    client: {
      from(table) {
        if (table === 'backups_manifest') {
          return {
            select() {
              const state = { eq: {} };
              const chain = {
                eq(col, val) { state.eq[col] = val; return chain; },
                maybeSingle() {
                  calls.selects.push({ table, ...state });
                  if (!manifestRow || (state.eq.id && state.eq.id !== manifestRow.id)) {
                    return Promise.resolve({ data: null, error: null });
                  }
                  return Promise.resolve({ data: manifestRow, error: null });
                },
              };
              return chain;
            },
          };
        }
        // Para la tabla destino: delete + insert/upsert
        return {
          delete(deleteOpts = {}) {
            const state = { neq: {}, not: {} };
            const chain = {
              not(col, op, val) { state.not = { col, op, val }; return chain; },
              neq(col, val) { state.neq[col] = val; return chain; },
              then(resolve) {
                calls.deletes.push({ table, count: deleteOpts.count, ...state });
                if (deleteError) {
                  return Promise.resolve({ error: deleteError, count: 0 }).then(resolve);
                }
                // Simula que había 42 rows
                return Promise.resolve({ error: null, count: 42 }).then(resolve);
              },
            };
            return chain;
          },
          insert(batch) {
            calls.inserts.push({ table, batch });
            return Promise.resolve({ error: insertError });
          },
          upsert(batch) {
            calls.upserts.push({ table, batch });
            return Promise.resolve({ error: insertError });
          },
        };
      },
    },
  };
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe('providers/restore.ts — PROTECTED_TABLES', () => {
  it('incluye tablas append-only / audit', () => {
    expect(PROTECTED_TABLES.has('agent_decisions')).toBe(true);
    expect(PROTECTED_TABLES.has('audit_log')).toBe(true);
    expect(PROTECTED_TABLES.has('human_approvals')).toBe(true);
    expect(PROTECTED_TABLES.has('backups_manifest')).toBe(true);
  });

  it('NO incluye tablas de datos restaurables', () => {
    expect(PROTECTED_TABLES.has('contacts')).toBe(false);
    expect(PROTECTED_TABLES.has('productos')).toBe(false);
    expect(PROTECTED_TABLES.has('expedientes')).toBe(false);
  });
});

describe('providers/restore.ts — restoreFromManifest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T12:00:00.000Z'));
  });

  it('rechaza target_table en PROTECTED_TABLES', async () => {
    const { client } = makeSupabase(null);
    const r = await restoreFromManifest(client, {
      manifest_id: 1,
      target_table: 'agent_decisions',
      intent: 'smoke test',
    });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/PROTECTED_TABLES/);
  });

  it('rechaza si manifest_id no existe', async () => {
    const { client } = makeSupabase(null);
    const r = await restoreFromManifest(client, {
      manifest_id: 9999,
      target_table: 'contacts',
      intent: 'test recovery',
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/9999/);
  });

  it('rechaza si manifest status != completed', async () => {
    const mf = makeManifestRow({
      rows: [{ id: 1 }],
      table: 'contacts',
      status: 'in_progress',
    });
    const { client } = makeSupabase(mf);
    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'test recovery',
    });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/in_progress/);
  });

  it('rechaza si SHA256 no matchea (tampering)', async () => {
    const mf = makeManifestRow({
      rows: [{ id: 1 }],
      table: 'contacts',
      tampered: true,
    });
    const { client } = makeSupabase(mf);
    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'test recovery',
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/SHA256 mismatch/);
    expect(r.sha256_match).toBe(false);
  });

  it('rechaza si target_table no matchea el snapshot', async () => {
    const mf = makeManifestRow({
      rows: [{ id: 1 }],
      table: 'productos',
    });
    const { client } = makeSupabase(mf);
    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'test recovery',
    });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/productos/);
  });

  it('dry_run=true devuelve preview sin escribir', async () => {
    const rows = [
      { id: 1, name: 'Ana' },
      { id: 2, name: 'Luis' },
      { id: 3, name: 'Maria' },
      { id: 4, name: 'Pedro' },
    ];
    const mf = makeManifestRow({ rows, table: 'contacts' });
    const { client, calls } = makeSupabase(mf);

    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'test recovery',
      dry_run: true,
    });

    expect(r.status).toBe('completed');
    expect(r.dry_run).toBe(true);
    expect(r.sha256_match).toBe(true);
    expect(r.rows_in_snapshot).toBe(4);
    expect(r.preview_sample).toHaveLength(3);
    expect(r.preview_sample[0]).toEqual({ id: 1, name: 'Ana' });
    expect(calls.deletes).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it('wipe_and_insert: DELETE + INSERT en lotes', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `R${i}` }));
    const mf = makeManifestRow({ rows, table: 'contacts' });
    const { client, calls } = makeSupabase(mf);

    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'test recovery end-to-end',
    });

    expect(r.status).toBe('completed');
    expect(r.rows_in_snapshot).toBe(1200);
    expect(r.rows_deleted).toBe(42);  // mock devuelve 42
    expect(r.rows_inserted).toBe(1200);
    expect(calls.deletes).toHaveLength(1);
    // 1200 / 500 batch = 3 lotes (500 + 500 + 200)
    expect(calls.inserts).toHaveLength(3);
    expect(calls.inserts[0].batch).toHaveLength(500);
    expect(calls.inserts[2].batch).toHaveLength(200);
  });

  it('upsert_only: solo upsert (no DELETE)', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const mf = makeManifestRow({ rows, table: 'contacts' });
    const { client, calls } = makeSupabase(mf);

    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'merge nuevo schema',
      strategy: 'upsert_only',
    });

    expect(r.status).toBe('completed');
    expect(calls.deletes).toHaveLength(0);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0].batch).toHaveLength(2);
    expect(r.rows_inserted).toBe(2);
  });

  it('insert errors → rows_skipped_errors', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    const mf = makeManifestRow({ rows, table: 'contacts' });
    const { client } = makeSupabase(mf, {
      insertError: { message: 'unique violation' },
    });

    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'test partial failure',
    });

    expect(r.status).toBe('failed'); // 0 inserted + skipped>0
    expect(r.rows_skipped_errors).toBe(600);
    expect(r.rows_inserted).toBe(0);
    expect(r.notes.some((n) => /unique violation/.test(n))).toBe(true);
  });

  it('storage=b2 (futuro) → aborted con mensaje claro', async () => {
    const mf = makeManifestRow({ rows: [], table: 'contacts', storage: 'b2' });
    mf.data_b64 = null;
    const { client } = makeSupabase(mf);
    const r = await restoreFromManifest(client, {
      manifest_id: 1234,
      target_table: 'contacts',
      intent: 'restore from cold storage',
    });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/storage=b2/);
  });
});
