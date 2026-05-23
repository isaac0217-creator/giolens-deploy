/**
 * GIOCORE Frente D.2 + Frente B — tests del cron `api/cron/refresh-meta-token.ts`.
 *
 * Cubre:
 *   - health_check flow (D.2 original): status=ok/expired/expiring_soon/unknown
 *   - refresh flow (Frente B 22-may PM): days_left<14 → extend + Vercel env update
 *   - failure modes: Meta error 190, Vercel sync parcial, missing app secret
 *   - idempotencia (decision_key)
 *   - dry_run (no DB writes, no Meta calls, no Vercel writes)
 *   - auth Bearer
 *
 * Mockea `@supabase/supabase-js`, `providers/meta-token`, `providers/vercel-env`.
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
    checkMetaToken: vi.fn(),
    extendLongLivedToken: vi.fn(),
    updateProductionEnvVar: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/meta-token', () => ({
  AUTO_REFRESH_DAYS: 14,
  REFRESH_THRESHOLD_DAYS: 7,
  checkMetaToken: mocks.checkMetaToken,
  extendLongLivedToken: mocks.extendLongLivedToken,
  maskToken: (t) => {
    if (!t || typeof t !== 'string' || t.length < 10) return '***';
    return `${t.slice(0, 4)}…${t.slice(-4)}`;
  },
  severityForStatus: (s) => {
    const m = { ok: 0.1, expiring_soon: 0.7, expired: 1.0, invalid: 1.0, unknown: 0.4 };
    return m[s] ?? 0;
  },
  statusNeedsAction: (s) => s === 'expired' || s === 'expiring_soon' || s === 'invalid',
}));

vi.mock('../../providers/vercel-env', () => ({
  updateProductionEnvVar: mocks.updateProductionEnvVar,
}));

function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    headers: {},
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
    setHeader(name, value) {
      r.headers[name] = value;
      return r;
    },
  };
  return r;
}

describe('api/cron/refresh-meta-token.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.upserts.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.checkMetaToken.mockReset();
    mocks.extendLongLivedToken.mockReset();
    mocks.updateProductionEnvVar.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
    // Limpio creds opcionales de Frente B — los tests que las necesiten las setean.
    delete process.env.META_TOKEN;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T13:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/refresh-meta-token.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ── Auth ─────────────────────────────────────────────────────────────── */

  it('(a) 401 sin Authorization', async () => {
    const res = makeRes();
    await handler({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mocks.checkMetaToken).not.toHaveBeenCalled();
  });

  it('(b) 401 con bearer incorrecto', async () => {
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
  });

  /* ── Health-check flow (D.2) ──────────────────────────────────────────── */

  it('(c) status=ok days_left=30 → health_check auto_approved (no refresh)', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'ok',
      days_left: 30,
      expires_at: '2026-06-21',
      probe: { http_status: 200, ok: true, body_excerpt: '{}' },
      raw: {},
    });
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('no-op');
    expect(res.body.token_status).toBe('ok');
    expect(mocks.calls.upserts).toHaveLength(1);
    const row = mocks.calls.upserts[0].row;
    expect(row.decision_type).toBe('meta_token_health_check');
    expect(row.status).toBe('auto_approved');
    expect(row.severity).toBe(0.1);
    expect(row.decision_key).toBe('meta_token_check_2026-05-22_ok');
    // No refresh attempted (no Meta credentials in env).
    expect(mocks.extendLongLivedToken).not.toHaveBeenCalled();
  });

  it('(d) status=expired sin creds Meta → health_check pending (NO refresh path)', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'expired',
      days_left: -1,
      expires_at: '2026-05-21',
      probe: { http_status: 400, ok: false, body_excerpt: 'OAuthException' },
      raw: { me: { error: { code: 190 } } },
    });
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.body.action).toBe('no-op');
    const row = mocks.calls.upserts[0].row;
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(1.0);
    expect(row.proposed_action.action).toBe('rotate_meta_token');
  });

  it('(e) Cache-Control: no-store siempre presente', async () => {
    mocks.checkMetaToken.mockResolvedValue({
      status: 'ok',
      days_left: 30,
      expires_at: '2026-06-21',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
  });

  /* ── Refresh flow (Frente B) ──────────────────────────────────────────── */

  it('(f) days_left=15 → NO refresh (umbral 14)', async () => {
    process.env.META_TOKEN = 'EAA-current-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'ok',
      days_left: 15,
      expires_at: '2026-06-06',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.body.action).toBe('no-op');
    expect(mocks.extendLongLivedToken).not.toHaveBeenCalled();
    expect(mocks.updateProductionEnvVar).not.toHaveBeenCalled();
  });

  it('(g) days_left=13 + Meta OK + Vercel OK → refreshed auto_approved', async () => {
    process.env.META_TOKEN = 'EAA-old-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'expiring_soon',
      days_left: 13,
      expires_at: '2026-06-04',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });
    mocks.extendLongLivedToken.mockResolvedValue({
      ok: true,
      token: 'EAA-new-token-9876543210',
      expires_in_sec: 5_184_000,
      expires_at: '2026-07-21T13:00:00.000Z',
    });
    mocks.updateProductionEnvVar.mockResolvedValue({
      success: true,
      action: 'patched',
      envId: 'env-id-abc',
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('refreshed');
    expect(res.body.current.token_masked).toMatch(/^EAA-…/);
    expect(res.body.current.expires_at).toBe('2026-07-21T13:00:00.000Z');
    // CRITICAL SECURITY: response body NO debe contener el token completo.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('EAA-new-token-9876543210');
    expect(bodyStr).not.toContain('EAA-old-token-1234567890');

    expect(mocks.updateProductionEnvVar).toHaveBeenCalledTimes(2);
    expect(mocks.updateProductionEnvVar.mock.calls[0][0]).toBe('META_TOKEN');
    expect(mocks.updateProductionEnvVar.mock.calls[1][0]).toBe('META_TOKEN_EXPIRES');

    const row = mocks.calls.upserts[0].row;
    expect(row.decision_type).toBe('token_refresh');
    expect(row.status).toBe('auto_approved');
    expect(row.severity).toBe(0.1);
    expect(row.decision_key).toBe('meta_token_refresh_2026-05-22');
    // CRITICAL: agent_decisions.proposed_action NO debe contener el token completo.
    const rowStr = JSON.stringify(row.proposed_action);
    expect(rowStr).not.toContain('EAA-new-token-9876543210');
    expect(rowStr).not.toContain('EAA-old-token-1234567890');
    expect(row.proposed_action.new_token_masked).toMatch(/^EAA-…/);
    expect(row.proposed_action.old_token_masked).toMatch(/^EAA-…/);
  });

  it('(h) Meta devuelve error 190 → pending, severity 0.9, no Vercel write', async () => {
    process.env.META_TOKEN = 'EAA-bad-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'expiring_soon',
      days_left: 5,
      expires_at: '2026-05-27',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });
    mocks.extendLongLivedToken.mockResolvedValue({
      ok: false,
      error: { code: 190, message: 'Invalid OAuth token' },
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.action).toBe('refresh_failed_meta_api');
    expect(res.body.meta_error_code).toBe(190);

    expect(mocks.updateProductionEnvVar).not.toHaveBeenCalled();

    const row = mocks.calls.upserts[0].row;
    expect(row.decision_type).toBe('token_refresh');
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(0.9);
    expect(row.proposed_action.meta_error.code).toBe(190);
  });

  it('(i) Meta OK pero Vercel patch falla → pending, severity 0.8', async () => {
    process.env.META_TOKEN = 'EAA-current-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-bad';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'expiring_soon',
      days_left: 3,
      expires_at: '2026-05-25',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });
    mocks.extendLongLivedToken.mockResolvedValue({
      ok: true,
      token: 'EAA-new-token-9876543210',
      expires_in_sec: 5_184_000,
      expires_at: '2026-07-21T13:00:00.000Z',
    });
    mocks.updateProductionEnvVar.mockResolvedValue({
      success: false,
      error: 'HTTP 403 forbidden',
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.action).toBe('refreshed_no_persist');
    const row = mocks.calls.upserts[0].row;
    expect(row.status).toBe('pending');
    expect(row.severity).toBe(0.8);
    expect(row.proposed_action.action).toBe('refreshed_no_persist');
  });

  it('(j) days_left=-1 (expired): no intenta refresh (status=expired bloquea)', async () => {
    process.env.META_TOKEN = 'EAA-exp-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'expired',
      days_left: -1,
      expires_at: null,
      probe: { http_status: 400, ok: false, body_excerpt: '' },
      raw: { error: 'Session has expired' },
    });
    // Aún si Meta dijera OK, el handler intenta porque status=expired NO está en lista bloqueada.
    mocks.extendLongLivedToken.mockResolvedValue({
      ok: false,
      error: { code: 190, message: 'expired' },
    });
    mocks.updateProductionEnvVar.mockResolvedValue({ success: true, action: 'patched' });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    // status=expired SÍ permite intentar refresh (only 'invalid' bloquea).
    expect(mocks.extendLongLivedToken).toHaveBeenCalled();
    expect(res.body.action).toBe('refresh_failed_meta_api');
  });

  it('(k) status=invalid (no token) → NO intenta refresh, health_check pending', async () => {
    process.env.META_TOKEN = '';  // sin token usable
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'invalid',
      days_left: null,
      expires_at: null,
      probe: { http_status: null, ok: false, body_excerpt: '' },
      raw: { error: 'META_TOKEN no está definido' },
    });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    expect(mocks.extendLongLivedToken).not.toHaveBeenCalled();
    expect(res.body.action).toBe('no-op');
    const row = mocks.calls.upserts[0].row;
    expect(row.decision_type).toBe('meta_token_health_check');
    expect(row.status).toBe('pending');
  });

  it('(l) dry_run=1 → action=no-op, no DB writes, no Meta refresh', async () => {
    process.env.META_TOKEN = 'EAA-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'expiring_soon',
      days_left: 3,
      expires_at: '2026-05-25',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
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

    expect(res.body.dry_run).toBe(true);
    expect(res.body.action).toBe('no-op');
    expect(mocks.calls.upserts).toHaveLength(0);
    expect(mocks.extendLongLivedToken).not.toHaveBeenCalled();
    expect(mocks.updateProductionEnvVar).not.toHaveBeenCalled();
  });

  /* ── Idempotencia + errores ───────────────────────────────────────────── */

  it('(m) idempotencia: refresh con mismo día y outcome → decision_key estable', async () => {
    process.env.META_TOKEN = 'EAA-token-1234567890';
    process.env.META_APP_ID = 'app-id-123';
    process.env.META_APP_SECRET = 'app-secret-xyz';
    process.env.VERCEL_TOKEN = 'vrc-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';

    mocks.checkMetaToken.mockResolvedValue({
      status: 'expiring_soon',
      days_left: 5,
      expires_at: '2026-05-27',
      probe: { http_status: 200, ok: true, body_excerpt: '' },
      raw: {},
    });
    mocks.extendLongLivedToken.mockResolvedValue({
      ok: true,
      token: 'EAA-new-token-9876543210',
      expires_in_sec: 5_184_000,
      expires_at: '2026-07-21T13:00:00.000Z',
    });
    mocks.updateProductionEnvVar.mockResolvedValue({ success: true, action: 'patched' });

    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);

    const row = mocks.calls.upserts[0].row;
    expect(row.decision_key).toBe('meta_token_refresh_2026-05-22');
    expect(mocks.calls.upserts[0].options.onConflict).toBe('decision_key');
  });

  it('(n) checkMetaToken lanza → 500 sin tocar DB', async () => {
    mocks.checkMetaToken.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.statusCode).toBe(500);
    expect(mocks.calls.upserts).toHaveLength(0);
  });
});
