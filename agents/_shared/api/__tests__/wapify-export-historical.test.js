/**
 * GIOCORE Frente H — Tests del cron `api/cron/wapify-export-historical.ts`.
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
    exportWapifyHistorical: vi.fn(),
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

vi.mock('../../providers/wapify-historical', () => ({
  exportWapifyHistorical: mocks.exportWapifyHistorical,
  PIPELINES: mocks.PIPELINES,
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
    pipelines_processed: 5,
    pipelines_completed: 5,
    pipelines_in_progress: 0,
    pipelines_failed: 0,
    total_new_opportunities: 100,
    results: [
      {
        pipeline_id: 216977,
        pipeline_name: 'Justin/Holbrook/Litebeam',
        mode: 'bootstrap',
        pages_fetched: 1,
        new_opportunities: 100,
        total_opportunities: 100,
        resume_offset: null,
        bootstrap_completed: true,
        last_seen_updated_at: '2026-05-22T10:00:00.000Z',
        status: 'completed',
        manifest_id: 1000,
        notes: [],
      },
    ],
    notes: [],
    ...overrides,
  };
}

describe('api/cron/wapify-export-historical.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.exportWapifyHistorical.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T10:30:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/wapify-export-historical.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 401 sin Authorization', async () => {
    const res = makeRes();
    await handler({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mocks.exportWapifyHistorical).not.toHaveBeenCalled();
  });

  it('(b) 400 si pipeline_id no es uno de los 5 conocidos', async () => {
    const res = makeRes();
    await handler(
      {
        url: '/?pipeline_id=999',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/999/);
    expect(mocks.exportWapifyHistorical).not.toHaveBeenCalled();
  });

  it('(c) 200 success path persiste decision_key idempotente', async () => {
    mocks.exportWapifyHistorical.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    expect(res.statusCode).toBe(200);
    const upsert = mocks.calls.upserts.find((u) => u.table === 'agent_decisions');
    expect(upsert.row.decision_key).toBe('wapify_export_2026-05-23');
    expect(upsert.row.severity).toBe(0.1);
    expect(upsert.row.status).toBe('auto_approved');
    expect(upsert.options.onConflict).toBe('decision_key');
  });

  it('(d) pipeline_id válido pasa el filtro al provider', async () => {
    mocks.exportWapifyHistorical.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      {
        url: '/?pipeline_id=216977',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(mocks.exportWapifyHistorical).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ only_pipeline_id: 216977 }),
    );
  });

  it('(e) dry_run=1 NO escribe en agent_decisions', async () => {
    mocks.exportWapifyHistorical.mockResolvedValueOnce(makeResult());
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
    const upserts = mocks.calls.upserts.filter((u) => u.table === 'agent_decisions');
    expect(upserts).toHaveLength(0);
  });

  it('(f) algún pipeline failed → severity 0.6 + status pending', async () => {
    mocks.exportWapifyHistorical.mockResolvedValueOnce(
      makeResult({ pipelines_completed: 4, pipelines_failed: 1 }),
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

  it('(g) provider lanza → 500 + upsert severity 0.9 con decision_key idempotente', async () => {
    mocks.exportWapifyHistorical.mockRejectedValueOnce(new Error('connection refused'));
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );

    expect(res.statusCode).toBe(500);
    const fatalUpsert = mocks.calls.upserts.find(
      (u) => u.table === 'agent_decisions' && u.row.decision_key?.startsWith('wapify_export_fatal_'),
    );
    expect(fatalUpsert).toBeTruthy();
    expect(fatalUpsert.row.severity).toBe(0.9);
    expect(fatalUpsert.row.justification).toMatch(/connection refused/);
    expect(fatalUpsert.options.onConflict).toBe('decision_key');
  });

  it('(h) Cache-Control: no-store seteado', async () => {
    mocks.exportWapifyHistorical.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );
    expect(res.headers['Cache-Control']).toMatch(/no-store/);
  });
});
