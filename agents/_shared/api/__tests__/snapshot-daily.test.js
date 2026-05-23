/**
 * GIOCORE Frente H — Tests del cron `api/cron/snapshot-daily.ts`.
 *
 * Mockea el provider `snapshotAllTables` + cliente Supabase para verificar:
 *   - 401 sin Authorization.
 *   - 400 si ?table=X no está en SNAPSHOT_TABLES.
 *   - 200 dry_run no toca agent_decisions.
 *   - 200 success path persiste decision_key idempotente.
 *   - 500 si provider lanza, persiste severity 0.9.
 *   - severity 0.6 si alguna tabla falló.
 *   - Cache-Control: no-store seteado.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = { upserts: [], inserts: [] };
  const supabaseClient = {
    from(table) {
      return {
        insert(row) {
          calls.inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        upsert(row, options) {
          calls.upserts.push({ table, row, options });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return {
    calls,
    createClient: vi.fn(() => supabaseClient),
    snapshotAllTables: vi.fn(),
    SNAPSHOT_TABLES: [
      'contacts',
      'productos',
      'expedientes',
      'agent_decisions',
      'meta_metrics',
      'provider_usage',
      'auth_tokens',
      'app_config',
      // Delta D2: mock incluye también las descubiertas (extras-no-brief)
      'agent_messages',
      'agent_runs',
      'audit_log',
      'human_approvals',
      'knowledge_base',
      'stage_events',
    ],
    TABLES_MISSING_FROM_BRIEF: ['productos_movimientos'],
    TABLES_MANIFEST: {
      generated_at: '2026-05-23T21:00:00.000Z',
      total_tables: 14,
      expected_per_brief_h: 9,
      missing_from_brief_h: ['productos_movimientos'],
      extra_in_db: ['agent_messages', 'agent_runs', 'audit_log', 'human_approvals', 'knowledge_base', 'stage_events'],
      tables: [],
    },
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/snapshot', () => ({
  snapshotAllTables: mocks.snapshotAllTables,
  SNAPSHOT_TABLES: mocks.SNAPSHOT_TABLES,
  TABLES_MISSING_FROM_BRIEF: mocks.TABLES_MISSING_FROM_BRIEF,
  TABLES_MANIFEST: mocks.TABLES_MANIFEST,
}));

function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    ended: false,
    headers: {},
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
    end() { r.ended = true; return r; },
    setHeader(name, value) { r.headers[name] = value; return r; },
  };
  return r;
}

function makeResult(overrides = {}) {
  return {
    date: '2026-05-23',
    tables_processed: 9,
    tables_succeeded: 9,
    tables_failed: 0,
    tables_skipped: 0,
    total_size_bytes: 50_000,
    total_uncompressed_bytes: 500_000,
    rows_purged_retention: 3,
    results: [],
    notes: [],
    ...overrides,
  };
}

describe('api/cron/snapshot-daily.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.snapshotAllTables.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T10:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/snapshot-daily.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 401 sin Authorization', async () => {
    const res = makeRes();
    await handler({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mocks.snapshotAllTables).not.toHaveBeenCalled();
  });

  it('(b) 400 si ?table=X no está en SNAPSHOT_TABLES', async () => {
    const res = makeRes();
    await handler(
      {
        url: '/?table=invalid_table',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid_table/);
    expect(mocks.snapshotAllTables).not.toHaveBeenCalled();
  });

  it('(c) 200 success path persiste decision_key idempotente', async () => {
    mocks.snapshotAllTables.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mocks.snapshotAllTables).toHaveBeenCalledOnce();

    const decisionUpsert = mocks.calls.upserts.find((u) => u.table === 'agent_decisions');
    expect(decisionUpsert).toBeTruthy();
    expect(decisionUpsert.row.decision_key).toBe('snapshot_daily_2026-05-23');
    expect(decisionUpsert.row.severity).toBeLessThanOrEqual(0.2);
    expect(decisionUpsert.row.status).toBe('auto_approved');
    expect(decisionUpsert.options.onConflict).toBe('decision_key');
  });

  it('(d) dry_run=1 no escribe en agent_decisions', async () => {
    mocks.snapshotAllTables.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      {
        url: '/?dry_run=1',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.dry_run).toBe(true);
    const decisionUpserts = mocks.calls.upserts.filter((u) => u.table === 'agent_decisions');
    expect(decisionUpserts).toHaveLength(0);
  });

  it('(e) si alguna tabla falló → severity 0.6 + status pending', async () => {
    mocks.snapshotAllTables.mockResolvedValueOnce(
      makeResult({ tables_succeeded: 8, tables_failed: 1 }),
    );
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    const upsert = mocks.calls.upserts.find((u) => u.table === 'agent_decisions');
    expect(upsert.row.severity).toBe(0.6);
    expect(upsert.row.status).toBe('pending');
  });

  it('(f) si todas skipped → severity 0.4 + status pending', async () => {
    mocks.snapshotAllTables.mockResolvedValueOnce(
      makeResult({ tables_succeeded: 0, tables_failed: 0, tables_skipped: 9 }),
    );
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    const upsert = mocks.calls.upserts.find((u) => u.table === 'agent_decisions');
    expect(upsert.row.severity).toBe(0.4);
    expect(upsert.row.status).toBe('pending');
  });

  it('(g) si provider lanza → 500 + upsert severity 0.9 con decision_key idempotente', async () => {
    mocks.snapshotAllTables.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    expect(res.statusCode).toBe(500);
    // Patch Rectificador: el fatal usa upsert con decision_key idempotente
    const fatalUpsert = mocks.calls.upserts.find(
      (u) => u.table === 'agent_decisions' && u.row.decision_key?.startsWith('snapshot_daily_fatal_'),
    );
    expect(fatalUpsert).toBeTruthy();
    expect(fatalUpsert.row.severity).toBe(0.9);
    expect(fatalUpsert.row.status).toBe('pending');
    expect(fatalUpsert.row.justification).toMatch(/boom/);
    expect(fatalUpsert.options.onConflict).toBe('decision_key');
  });

  it('(h) Cache-Control: no-store seteado', async () => {
    mocks.snapshotAllTables.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );
    expect(res.headers['Cache-Control']).toMatch(/no-store/);
  });

  it('(i) ?table=contacts solo pasa esa tabla al provider', async () => {
    mocks.snapshotAllTables.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      {
        url: '/?table=contacts',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(mocks.snapshotAllTables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ only_tables: ['contacts'] }),
    );
  });
});
