/**
 * GIOCORE Frente H · 1.6 — Tests del cron api/cron/backup-monthly.ts.
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
    buildMonthlyBackup: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../../providers/backup-monthly', () => ({
  buildMonthlyBackup: mocks.buildMonthlyBackup,
}));

function makeRes() {
  const r = {
    statusCode: null, body: null, ended: false, headers: {},
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
    end() { r.ended = true; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
  };
  return r;
}

function makeResult(overrides = {}) {
  return {
    month: '2026-04',
    generated_at: '2026-05-01T08:00:00.000Z',
    snapshot_daily_count: 30,
    wapify_historical_count: 5,
    wapify_delta_count: 25,
    payload_uncompressed_bytes: 50_000_000,
    payload_gz_bytes: 5_000_000,
    encrypted_bytes: 5_000_016,
    encryption_ratio: 0.1,
    sha256_of_encrypted: 'abc'.repeat(21).slice(0, 64),
    b2_key_bin: 'backup_monthly/2026-04/giocore-2026-04.bin',
    b2_key_iv: 'backup_monthly/2026-04/giocore-2026-04.iv',
    status: 'completed',
    rotation: { keys_listed: 3, keys_deleted: 1 },
    manifest_id: 5000,
    notes: [],
    ...overrides,
  };
}

describe('api/cron/backup-monthly.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.buildMonthlyBackup.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T08:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/backup-monthly.ts');
    handler = mod.default;
  });

  afterEach(() => { vi.useRealTimers(); });

  it('(a) 401 sin Authorization', async () => {
    const res = makeRes();
    await handler({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('(b) 400 si ?month tiene formato inválido', async () => {
    const res = makeRes();
    await handler(
      { url: '/?month=2026/04', headers: { authorization: 'Bearer test-secret' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM/);
  });

  it('(c) 200 success → decision_key idempotente + severity 0.2', async () => {
    mocks.buildMonthlyBackup.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-secret' } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const u = mocks.calls.upserts.find((x) => x.table === 'agent_decisions');
    expect(u.row.decision_key).toBe('backup_monthly_2026-04');
    expect(u.row.severity).toBe(0.2);
    expect(u.row.status).toBe('auto_approved');
  });

  it('(d) 503 si provider devuelve aborted (B2_ZIP_PASSPHRASE ausente)', async () => {
    mocks.buildMonthlyBackup.mockResolvedValueOnce(
      makeResult({ status: 'aborted', error: 'B2_ZIP_PASSPHRASE no está en el entorno' }),
    );
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-secret' } },
      res,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    const u = mocks.calls.upserts.find((x) => x.table === 'agent_decisions');
    expect(u.row.severity).toBe(0.9);
    expect(u.row.status).toBe('pending');
  });

  it('(e) 500 si provider devuelve failed (B2 upload fail) + severity 0.8', async () => {
    mocks.buildMonthlyBackup.mockResolvedValueOnce(
      makeResult({ status: 'failed', error: 'B2 upload: timeout' }),
    );
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-secret' } },
      res,
    );
    expect(res.statusCode).toBe(500);
    const u = mocks.calls.upserts.find((x) => x.table === 'agent_decisions');
    expect(u.row.severity).toBe(0.8);
  });

  it('(f) dry_run=1 no escribe agent_decisions', async () => {
    mocks.buildMonthlyBackup.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      {
        url: '/?dry_run=1',
        headers: { authorization: 'Bearer test-secret' },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.dry_run).toBe(true);
    const ups = mocks.calls.upserts.filter((x) => x.table === 'agent_decisions');
    expect(ups).toHaveLength(0);
  });

  it('(g) ?month=YYYY-MM override pasa al provider', async () => {
    mocks.buildMonthlyBackup.mockResolvedValueOnce(makeResult({ month: '2026-02' }));
    const res = makeRes();
    await handler(
      {
        url: '/?month=2026-02',
        headers: { authorization: 'Bearer test-secret' },
      },
      res,
    );
    expect(mocks.buildMonthlyBackup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ month: '2026-02' }),
    );
  });

  it('(h) provider lanza → 500 + decision_key fatal idempotente', async () => {
    mocks.buildMonthlyBackup.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-secret' } },
      res,
    );
    expect(res.statusCode).toBe(500);
    const fatal = mocks.calls.upserts.find(
      (x) => x.row.decision_key?.startsWith('backup_monthly_fatal_'),
    );
    expect(fatal).toBeTruthy();
    expect(fatal.row.severity).toBe(0.9);
  });

  it('(i) Cache-Control: no-store', async () => {
    mocks.buildMonthlyBackup.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await handler(
      { url: '/', headers: { authorization: 'Bearer test-secret' } },
      res,
    );
    expect(res.headers['Cache-Control']).toMatch(/no-store/);
  });
});
