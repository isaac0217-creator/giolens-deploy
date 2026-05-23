/**
 * GIOCORE Frente D.2 — tests del cron `api/cron/sync-wapify-cache.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    upserts: [], // {table, row, options}
    inserts: [], // {table, row}
  };
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
    syncWapifyCache: vi.fn(),
    PIPELINES: [
      { id: 216977, name: 'Justin/Holbrook/Litebeam', protected: false },
      { id: 755062, name: 'GioSports', protected: false },
      { id: 94103, name: 'Dama', protected: false },
      { id: 252999, name: 'SPY', protected: true },
      { id: 273944, name: 'GioVision', protected: true },
    ],
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/wapify-sync', () => ({
  syncWapifyCache: mocks.syncWapifyCache,
  PIPELINES: mocks.PIPELINES,
}));

function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    ended: false,
    status(code) {
      r.statusCode = code;
      return r;
    },
    json(body) {
      r.body = body;
      return r;
    },
    end() {
      r.ended = true;
      return r;
    },
  };
  return r;
}

function makeResult(overrides = {}) {
  return {
    pipeline_id: 216977,
    pipeline_name: 'Justin/Holbrook/Litebeam',
    previous_sync_at: null,
    current_sync_at: '2026-05-22T13:30:00.000Z',
    contacts_fetched: 10,
    contacts_upserted: 10,
    dry_run: false,
    pages_fetched: 1,
    notes: [],
    errors: [],
    ...overrides,
  };
}

describe('api/cron/sync-wapify-cache.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.syncWapifyCache.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T13:30:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/sync-wapify-cache.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 401 sin Authorization', async () => {
    const res = makeRes();
    await handler({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mocks.syncWapifyCache).not.toHaveBeenCalled();
  });

  it('(b) 400 si pipeline_id no es uno de los 5 conocidos', async () => {
    const res = makeRes();
    await handler(
      {
        url: '/api/cron/sync-wapify-cache?pipeline_id=99',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/99/);
  });

  it('(c) sync OK → 200, upsertea decisión con status=auto_approved', async () => {
    mocks.syncWapifyCache.mockResolvedValue([makeResult()]);

    const res = makeRes();
    await handler(
      {
        url: '/api/cron/sync-wapify-cache?pipeline_id=216977',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dry_run).toBe(false);
    expect(res.body.totals.contacts_upserted).toBe(10);

    const upserts = mocks.calls.upserts.filter((u) => u.table === 'agent_decisions');
    expect(upserts).toHaveLength(1);
    const row = upserts[0].row;
    expect(row.agent_name).toBe('cron_sync_wapify_cache');
    expect(row.decision_type).toBe('wapify_cache_sync');
    expect(row.status).toBe('auto_approved');
    expect(row.severity).toBe(0.2);
    expect(row.decision_key).toBe('wapify_sync_2026-05-22_p216977');
  });

  it('(d) sync con errores → status=pending + severity alta', async () => {
    mocks.syncWapifyCache.mockResolvedValue([
      makeResult({ errors: ['fallo X'], contacts_upserted: 5, contacts_fetched: 10 }),
    ]);

    const res = makeRes();
    await handler(
      {
        url: '/api/cron/sync-wapify-cache?pipeline_id=216977',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const row = mocks.calls.upserts.filter((u) => u.table === 'agent_decisions')[0].row;
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(0.6);
  });

  it('(e) dry_run=1 → NO inserta decisión', async () => {
    mocks.syncWapifyCache.mockResolvedValue([makeResult({ dry_run: true, contacts_upserted: 0 })]);

    const res = makeRes();
    await handler(
      {
        url: '/api/cron/sync-wapify-cache?dry_run=1&pipeline_id=216977',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.dry_run).toBe(true);
    const decisionUpserts = mocks.calls.upserts.filter((u) => u.table === 'agent_decisions');
    expect(decisionUpserts).toHaveLength(0);
  });

  it('(f) syncWapifyCache lanza → 500 + log de error en agent_decisions', async () => {
    mocks.syncWapifyCache.mockRejectedValue(new Error('Wapify down'));

    const res = makeRes();
    await handler(
      {
        url: '/api/cron/sync-wapify-cache?pipeline_id=216977',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/Wapify down/);

    // Insert (NO upsert) en agent_decisions con shape de error
    const errInserts = mocks.calls.inserts.filter((i) => i.table === 'agent_decisions');
    expect(errInserts).toHaveLength(1);
    const row = errInserts[0].row;
    expect(row.decision_type).toBe('wapify_sync_error');
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(0.8);
  });

  it('(g) sin pipeline_id procesa todos → decision_key con _all', async () => {
    mocks.syncWapifyCache.mockResolvedValue([
      makeResult({ pipeline_id: 216977 }),
      makeResult({ pipeline_id: 755062 }),
      makeResult({ pipeline_id: 94103 }),
      makeResult({ pipeline_id: 252999 }),
      makeResult({ pipeline_id: 273944 }),
    ]);

    const res = makeRes();
    await handler(
      { headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    expect(res.body.pipelines_processed).toBe(5);
    const row = mocks.calls.upserts.filter((u) => u.table === 'agent_decisions')[0].row;
    expect(row.decision_key).toBe('wapify_sync_2026-05-22_all');
  });

  it('(h) llama syncWapifyCache con dry_run y pipeline_id correctos', async () => {
    mocks.syncWapifyCache.mockResolvedValue([makeResult()]);

    const res = makeRes();
    await handler(
      {
        url: '/api/cron/sync-wapify-cache?pipeline_id=216977&dry_run=1',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(mocks.syncWapifyCache).toHaveBeenCalledTimes(1);
    const [, options] = mocks.syncWapifyCache.mock.calls[0];
    expect(options).toMatchObject({ pipeline_id: 216977, dry_run: true });
  });
});
