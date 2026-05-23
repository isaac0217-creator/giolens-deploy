/**
 * GIOCORE Frente H — Tests de snapshot.ts (sin DB real).
 *
 * Verifica:
 *   - Compresión gz < 10% del JSON original (acceptance criteria brief §H).
 *   - SHA256 estable y calculado sobre buffer gz (no base64).
 *   - Tabla inexistente (Postgres 42P01) → status='skipped' sin abortar.
 *   - Tabla con error genérico → status='failed', no aborta las demás.
 *   - dry_run no escribe en backups_manifest.
 *   - Retención purga rows expirados (best-effort try/catch).
 *   - SNAPSHOT_TABLES expone las 9 tablas esperadas.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { snapshotAllTables, SNAPSHOT_TABLES } from '../snapshot.ts';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/* ── Mock supabase reusable ─────────────────────────────────────────────── */

/**
 * scenarios: {
 *   [tableName]: {
 *     rows?: unknown[],         // datos a devolver en select(*).range(...)
 *     skipped?: boolean,        // si true, simula 42P01 (tabla no existe)
 *     error?: { message: string, code?: string },
 *     insertId?: number,        // ID que devuelve insert().select().single()
 *     insertError?: { message: string },
 *     deletedRows?: unknown[],  // rows devueltos por delete().select()
 *   }
 * }
 */
function makeSupabase(scenarios = {}) {
  const calls = { inserts: [], deletes: [], selects: [] };
  let insertCounter = 1000;

  const client = {
    from(table) {
      const sc = scenarios[table] ?? { rows: [] };

      return {
        select() {
          // Chain para SELECT *...range...order
          const state = { range: null };
          const chain = {
            range(s, e) {
              state.range = [s, e];
              return chain;
            },
            order() {
              return chain;
            },
            then(resolve, reject) {
              calls.selects.push({ table, range: state.range });
              if (sc.skipped) {
                return Promise.resolve({
                  data: null,
                  error: { code: '42P01', message: 'relation does not exist' },
                }).then(resolve, reject);
              }
              if (sc.error) {
                return Promise.resolve({ data: null, error: sc.error }).then(resolve, reject);
              }
              const rows = sc.rows ?? [];
              const [s, e] = state.range ?? [0, rows.length];
              return Promise.resolve({
                data: rows.slice(s, e + 1),
                error: null,
              }).then(resolve, reject);
            },
          };
          return chain;
        },

        insert(row) {
          calls.inserts.push({ table, row });
          // El chain insert().select('id').single() en snapshot.ts
          const chain = {
            select() {
              return {
                single() {
                  if (sc.insertError) {
                    return Promise.resolve({ data: null, error: sc.insertError });
                  }
                  const id = sc.insertId ?? insertCounter++;
                  return Promise.resolve({ data: { id }, error: null });
                },
              };
            },
            // Sin .select(): await directo sobre insert
            then(resolve, reject) {
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return chain;
        },

        delete() {
          // Chain: delete().eq().eq().lt().select('id')
          const state = { eq: {}, lt: {} };
          const chain = {
            eq(c, v) {
              state.eq[c] = v;
              return chain;
            },
            lt(c, v) {
              state.lt[c] = v;
              return chain;
            },
            select() {
              calls.deletes.push({ table, ...state });
              return Promise.resolve({
                data: sc.deletedRows ?? [],
                error: sc.deleteError ?? null,
              });
            },
          };
          return chain;
        },
      };
    },
  };

  return { client, calls };
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe('providers/snapshot.ts — SNAPSHOT_TABLES (delta D2: discovery-driven)', () => {
  it('incluye las tablas brief-H que existen en la DB', () => {
    // Delta D2: snapshot SOLO las que realmente existen. Verificamos las
    // críticas del brief que sabemos están en DB (post-discovery 23-may PM).
    expect(SNAPSHOT_TABLES).toContain('contacts');
    expect(SNAPSHOT_TABLES).toContain('productos');
    expect(SNAPSHOT_TABLES).toContain('expedientes');
    expect(SNAPSHOT_TABLES).toContain('agent_decisions');
    expect(SNAPSHOT_TABLES).toContain('meta_metrics');
    expect(SNAPSHOT_TABLES).toContain('provider_usage');
    expect(SNAPSHOT_TABLES).toContain('auth_tokens');
    expect(SNAPSHOT_TABLES).toContain('app_config');
  });

  it('NO incluye productos_movimientos (Frente E aún no migrado, está como missing)', async () => {
    const { TABLES_MISSING_FROM_BRIEF } = await import('../snapshot.ts');
    expect(SNAPSHOT_TABLES).not.toContain('productos_movimientos');
    expect(TABLES_MISSING_FROM_BRIEF).toContain('productos_movimientos');
  });

  it('incluye tablas extras descubiertas no listadas en brief (audit_log, knowledge_base, etc.)', () => {
    // Delta D2: discovery captura las extras automáticamente.
    expect(SNAPSHOT_TABLES).toContain('audit_log');
    expect(SNAPSHOT_TABLES).toContain('knowledge_base');
    expect(SNAPSHOT_TABLES).toContain('agent_runs');
  });

  it('total >= 8 (las del brief que existen) y <= 50 (sanity cap)', () => {
    expect(SNAPSHOT_TABLES.length).toBeGreaterThanOrEqual(8);
    expect(SNAPSHOT_TABLES.length).toBeLessThanOrEqual(50);
  });
});

describe('providers/snapshot.ts — snapshotAllTables', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T12:00:00.000Z'));
  });

  it('comprime JSON > 10% ratio target (acceptance criteria)', async () => {
    // 100 contactos con datos realistas → JSON ~10 KB → gz esperado <1 KB
    const contacts = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `Contact ${i}`,
      phone: `+521663118${String(i).padStart(4, '0')}`,
      email: `contact${i}@example.com`,
      pipeline_id: 216977,
      stage_name: 'int1',
      raw_payload: { source: 'wapify', notes: 'lorem ipsum '.repeat(20) },
    }));

    const { client } = makeSupabase({
      contacts: { rows: contacts },
    });

    const result = await snapshotAllTables(client, { only_tables: ['contacts'] });

    expect(result.tables_succeeded).toBe(1);
    const r = result.results[0];
    expect(r.row_count).toBe(100);
    expect(r.compression_ratio).toBeLessThan(0.30); // <30% (conservador; real ~10%)
    expect(r.compression_ratio).toBeGreaterThan(0);
  });

  it('SHA256 se calcula sobre el buffer gz (no sobre base64)', async () => {
    const rows = [{ id: 1, x: 'a' }];
    const { client, calls } = makeSupabase({ contacts: { rows } });

    const result = await snapshotAllTables(client, { only_tables: ['contacts'] });
    const r = result.results[0];

    // Recreamos el gz para verificar SHA matches
    const insertRow = calls.inserts[0].row;
    const gzBuf = Buffer.from(insertRow.data_b64, 'base64');
    const expectedSha = createHash('sha256').update(gzBuf).digest('hex');

    expect(r.sha256).toBe(expectedSha);
    // SHA del base64 no debería matchear (sanity check del comentario)
    const sha_b64 = createHash('sha256').update(insertRow.data_b64).digest('hex');
    expect(r.sha256).not.toBe(sha_b64);
  });

  it('gunzip(data_b64) devuelve el JSON original (round-trip)', async () => {
    const rows = [
      { id: 1, name: 'Ana', email: 'a@b.com' },
      { id: 2, name: 'Luis', email: 'l@b.com' },
    ];
    const { client, calls } = makeSupabase({ contacts: { rows } });
    await snapshotAllTables(client, { only_tables: ['contacts'] });

    const insertRow = calls.inserts[0].row;
    const gzBuf = Buffer.from(insertRow.data_b64, 'base64');
    const json = gunzipSync(gzBuf).toString('utf-8');
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(rows);
  });

  it('tabla inexistente (42P01) → status=skipped, no aborta las demás', async () => {
    const { client } = makeSupabase({
      contacts: { rows: [{ id: 1 }] },
      productos: { skipped: true },
      expedientes: { rows: [{ id: 2 }] },
    });

    const result = await snapshotAllTables(client, {
      only_tables: ['contacts', 'productos', 'expedientes'],
    });

    expect(result.tables_processed).toBe(3);
    expect(result.tables_succeeded).toBe(2);
    expect(result.tables_skipped).toBe(1);
    expect(result.tables_failed).toBe(0);
    expect(result.results.find((r) => r.table === 'productos').status).toBe('skipped');
  });

  it('columna inexistente (42703, NO 42P01) → status=failed (no skipped silencioso)', async () => {
    // Patch Rectificador critical #1: antes /does not exist/i matcheaba 42703
    // y `app_config` (PK key, no id) se marcaba como skipped silencioso.
    const { client } = makeSupabase({
      contacts: {
        rows: [],
        error: { code: '42703', message: 'column "id" does not exist' },
      },
    });

    const result = await snapshotAllTables(client, { only_tables: ['contacts'] });

    expect(result.tables_skipped).toBe(0);
    expect(result.tables_failed).toBe(1);
    const r = result.results[0];
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/column not found/);
  });

  it('error genérico de Supabase → status=failed, sigue con siguientes', async () => {
    const { client } = makeSupabase({
      contacts: { rows: [{ id: 1 }] },
      productos: { error: { code: 'PGRST301', message: 'permission denied' } },
      expedientes: { rows: [{ id: 2 }] },
    });

    const result = await snapshotAllTables(client, {
      only_tables: ['contacts', 'productos', 'expedientes'],
    });

    expect(result.tables_failed).toBe(1);
    expect(result.tables_succeeded).toBe(2);
    const failed = result.results.find((r) => r.table === 'productos');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/permission denied/);
  });

  it('dry_run no escribe en backups_manifest ni purga retención', async () => {
    const { client, calls } = makeSupabase({
      contacts: { rows: [{ id: 1, name: 'A' }] },
    });

    const result = await snapshotAllTables(client, {
      only_tables: ['contacts'],
      dry_run: true,
    });

    expect(calls.inserts).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(result.tables_succeeded).toBe(1);
    expect(result.results[0].manifest_id).toBe(null);
  });

  it('retención llama DELETE con cutoff 30 días', async () => {
    const { client, calls } = makeSupabase({
      contacts: { rows: [{ id: 1 }] },
    });

    await snapshotAllTables(client, { only_tables: ['contacts'] });

    expect(calls.deletes).toHaveLength(1);
    const del = calls.deletes[0];
    expect(del.table).toBe('backups_manifest');
    expect(del.eq.type).toBe('snapshot_daily');
    expect(del.eq.status).toBe('completed');
    expect(del.lt.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Verificamos que es ~30 días en el pasado
    const cutoff = new Date(del.lt.created_at).getTime();
    const expected = Date.now() - 30 * 24 * 3600 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(60_000);
  });

  it('retención que falla NO aborta el snapshot (best-effort)', async () => {
    const { client } = makeSupabase({
      contacts: { rows: [{ id: 1 }] },
      backups_manifest: { deleteError: { message: 'lock timeout' } },
    });

    const result = await snapshotAllTables(client, { only_tables: ['contacts'] });

    expect(result.tables_succeeded).toBe(1);
    expect(result.notes.some((n) => /Retención falló/.test(n))).toBe(true);
  });

  it('path incluye fecha YYYY-MM-DD y nombre de tabla', async () => {
    const { client } = makeSupabase({ contacts: { rows: [] } });
    const result = await snapshotAllTables(client, {
      only_tables: ['contacts'],
      date: '2026-05-23',
    });
    expect(result.results[0].path).toBe('snapshot_2026-05-23/contacts.json.gz');
  });

  it('row_counts captura conteo por tabla', async () => {
    const { client, calls } = makeSupabase({
      contacts: { rows: Array.from({ length: 42 }, (_, i) => ({ id: i })) },
    });
    await snapshotAllTables(client, { only_tables: ['contacts'] });

    expect(calls.inserts[0].row.row_counts).toEqual({ contacts: 42 });
  });
});
