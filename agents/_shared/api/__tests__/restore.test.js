/**
 * GIOCORE Frente H · 1.7 — Tests del endpoint admin/restore.ts.
 *
 * Triple verificación + audit obligatorio:
 *   - 401 sin Authorization
 *   - 405 si method != POST
 *   - 400 sin ?confirm=true
 *   - 400 sin X-Restore-Intent header
 *   - 400 sin manifest_id o target_table
 *   - 403 si target_table en PROTECTED_TABLES
 *   - 503 si log pre-restore falla (no permite restore sin audit)
 *   - 200 si restore success + 2 logs en agent_decisions (pre + post)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = { upserts: [], inserts: [] };
  let insertShouldFail = false;
  const supabaseClient = {
    from(table) {
      return {
        insert(row) {
          calls.inserts.push({ table, row });
          if (insertShouldFail && row.decision_type === 'data_restore_initiated') {
            return Promise.resolve({ data: null, error: { message: 'log fail' } });
          }
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
    setInsertFail: (v) => { insertShouldFail = v; },
    createClient: vi.fn(() => supabaseClient),
    restoreFromManifest: vi.fn(),
    PROTECTED_TABLES: new Set([
      'agent_decisions',
      'audit_log',
      'human_approvals',
      'agent_messages',
      'agent_runs',
      'stage_events',
      'backups_manifest',
    ]),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/restore', () => ({
  restoreFromManifest: mocks.restoreFromManifest,
  PROTECTED_TABLES: mocks.PROTECTED_TABLES,
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

function authedReq(extras = {}) {
  return {
    method: 'POST',
    url: '/?confirm=true',
    headers: {
      authorization: 'Bearer test-cron-secret',
      'x-restore-intent': 'smoke test recovery end-to-end',
      ...extras.headers,
    },
    body: {
      manifest_id: 1234,
      target_table: 'contacts',
      ...extras.body,
    },
    ...extras.req,
  };
}

describe('api/admin/restore.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.restoreFromManifest.mockReset();
    mocks.createClient.mockClear();
    mocks.setInsertFail(false);

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T15:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/admin/restore.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 405 si method GET', async () => {
    const res = makeRes();
    await handler(
      { method: 'GET', url: '/', headers: { authorization: 'Bearer test-cron-secret' } },
      res,
    );
    expect(res.statusCode).toBe(405);
  });

  it('(b) 401 sin Authorization', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('(c) 400 sin ?confirm=true', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        url: '/',
        headers: {
          authorization: 'Bearer test-cron-secret',
          'x-restore-intent': 'test recovery',
        },
        body: { manifest_id: 1, target_table: 'contacts' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/confirm=true/);
  });

  it('(d) 400 sin X-Restore-Intent header', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        url: '/?confirm=true',
        headers: { authorization: 'Bearer test-cron-secret' },
        body: { manifest_id: 1, target_table: 'contacts' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/X-Restore-Intent/);
  });

  it('(e) 400 si X-Restore-Intent < 10 chars', async () => {
    const res = makeRes();
    await handler(authedReq({ headers: { 'x-restore-intent': 'short' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('(f) 400 si falta manifest_id en body', async () => {
    const res = makeRes();
    await handler(authedReq({ body: { manifest_id: undefined, target_table: 'contacts' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/manifest_id/);
  });

  it('(g) 403 si target_table en PROTECTED_TABLES', async () => {
    const res = makeRes();
    await handler(authedReq({ body: { target_table: 'agent_decisions' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/PROTECTED/);
  });

  it('(h) 503 si log pre-restore falla', async () => {
    mocks.setInsertFail(true);
    const res = makeRes();
    await handler(authedReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/audit trail/);
    expect(mocks.restoreFromManifest).not.toHaveBeenCalled();
  });

  it('(i) 200 success + 2 logs (pre + post) en agent_decisions', async () => {
    mocks.restoreFromManifest.mockResolvedValueOnce({
      manifest_id: 1234,
      target_table: 'contacts',
      strategy: 'wipe_and_insert',
      dry_run: false,
      manifest_sha256: 'abc',
      recomputed_sha256: 'abc',
      sha256_match: true,
      rows_in_snapshot: 100,
      rows_deleted: 42,
      rows_inserted: 100,
      rows_skipped_errors: 0,
      status: 'completed',
      notes: [],
    });
    const res = makeRes();
    await handler(authedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    // 2 inserts en agent_decisions (pre + post)
    const ads = mocks.calls.inserts.filter((c) => c.table === 'agent_decisions');
    expect(ads).toHaveLength(2);
    expect(ads[0].row.decision_type).toBe('data_restore_initiated');
    expect(ads[0].row.severity).toBe(1.0);
    expect(ads[1].row.decision_type).toBe('data_restore_completed');
    expect(ads[1].row.severity).toBe(1.0);
    expect(ads[1].row.status).toBe('auto_approved');
  });

  it('(j) Cache-Control: no-store', async () => {
    mocks.restoreFromManifest.mockResolvedValueOnce({
      manifest_id: 1234, target_table: 'contacts', strategy: 'wipe_and_insert',
      dry_run: true, manifest_sha256: '', recomputed_sha256: '', sha256_match: true,
      rows_in_snapshot: 0, rows_deleted: 0, rows_inserted: 0, rows_skipped_errors: 0,
      status: 'completed', notes: [],
    });
    const res = makeRes();
    await handler(authedReq(), res);
    expect(res.headers['Cache-Control']).toMatch(/no-store/);
  });

  it('(k) restore failed → 500 + pending status en log post', async () => {
    mocks.restoreFromManifest.mockResolvedValueOnce({
      manifest_id: 1234, target_table: 'contacts', strategy: 'wipe_and_insert',
      dry_run: false, manifest_sha256: 'abc', recomputed_sha256: 'abc', sha256_match: true,
      rows_in_snapshot: 100, rows_deleted: 0, rows_inserted: 0, rows_skipped_errors: 100,
      status: 'failed', error: 'insert errors', notes: ['batch 0 failed'],
    });
    const res = makeRes();
    await handler(authedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    const ads = mocks.calls.inserts.filter((c) => c.table === 'agent_decisions');
    expect(ads).toHaveLength(2);
    expect(ads[1].row.status).toBe('pending');
  });
});
