/**
 * GIOCORE Frente D.2 — tests del cron `api/cron/refresh-meta-token.ts`.
 *
 * Mockea `@supabase/supabase-js` y `providers/meta-token.js` con `vi.mock`.
 * Verifica auth, shape de agent_decisions, dry_run, idempotencia.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    rpc: [],
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
    checkMetaToken: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/meta-token', () => ({
  checkMetaToken: mocks.checkMetaToken,
  severityForStatus: (s) => {
    const m = { ok: 0.1, expiring_soon: 0.7, expired: 1.0, invalid: 1.0, unknown: 0.4 };
    return m[s] ?? 0;
  },
  statusNeedsAction: (s) => s === 'expired' || s === 'expiring_soon' || s === 'invalid',
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

describe('api/cron/refresh-meta-token.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.rpc.length = 0;
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.checkMetaToken.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T13:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/refresh-meta-token.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 401 sin Authorization', async () => {
    mocks.checkMetaToken.mockResolvedValue({ status: 'ok', days_left: 30, expires_at: '2026-06-21', probe: { http_status: 200, ok: true, body_excerpt: '' }, raw: {} });

    const res = makeRes();
    await handler({ headers: {} }, res);

    expect(res.statusCode).toBe(401);
    expect(mocks.checkMetaToken).not.toHaveBeenCalled();
  });

  it('(b) 401 con bearer incorrecto', async () => {
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer nope' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('(c) status=ok → inserta decisión con status=auto_approved y severity baja', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'ok',
      days_left: 30,
      expires_at: '2026-06-21',
      probe: { http_status: 200, ok: true, body_excerpt: '{"name":"X"}' },
      raw: { me: { name: 'X' } },
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      token_status: 'ok',
      action_required: false,
    });
    expect(mocks.calls.upserts).toHaveLength(1);
    const { table, row, options } = mocks.calls.upserts[0];
    expect(table).toBe('agent_decisions');
    expect(options).toMatchObject({ onConflict: 'decision_key' });
    expect(row.agent_name).toBe('cron_refresh_meta_token');
    expect(row.decision_type).toBe('meta_token_health_check');
    expect(row.status).toBe('auto_approved');
    expect(row.severity).toBe(0.1);
    expect(row.decision_key).toMatch(/^meta_token_check_2026-05-22_ok$/);
  });

  it('(d) status=expired → decisión con status=pending y severity 1.0', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'expired',
      days_left: -1,
      expires_at: '2026-05-21',
      probe: { http_status: 400, ok: false, body_excerpt: 'OAuthException' },
      raw: { me: { error: { code: 190 } } },
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      token_status: 'expired',
      action_required: true,
    });
    const row = mocks.calls.upserts[0].row;
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(1.0);
    expect(row.proposed_action.action).toBe('rotate_meta_token');
    expect(row.justification).toMatch(/EXPIRADO/);
  });

  it('(e) status=expiring_soon → pending + severity 0.7', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'expiring_soon',
      days_left: 4,
      expires_at: '2026-05-26',
      probe: { http_status: 200, ok: true, body_excerpt: '{}' },
      raw: {},
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    const row = mocks.calls.upserts[0].row;
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(0.7);
  });

  it('(f) dry_run=1 → NO inserta en agent_decisions, devuelve probe', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'expired',
      days_left: -1,
      expires_at: '2026-05-21',
      probe: { http_status: 400, ok: false, body_excerpt: '' },
      raw: {},
    });

    const res = makeRes();
    await handler(
      {
        url: '/api/cron/refresh-meta-token?dry_run=1',
        headers: { authorization: 'Bearer test-cron-secret' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      dry_run: true,
      token_status: 'expired',
      action_required: true,
    });
    expect(mocks.calls.upserts).toHaveLength(0);
    expect(mocks.calls.inserts).toHaveLength(0);
  });

  it('(g) idempotencia: decision_key incluye fecha + status', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'ok',
      days_left: 30,
      expires_at: '2026-06-21',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    const row = mocks.calls.upserts[0].row;
    expect(row.decision_key).toBe('meta_token_check_2026-05-22_ok');
  });

  it('(h) checkMetaToken lanza → 500 sin tocar Supabase', async () => {
    mocks.checkMetaToken.mockRejectedValue(new Error('boom'));

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(res.statusCode).toBe(500);
    expect(mocks.calls.upserts).toHaveLength(0);
  });
});
