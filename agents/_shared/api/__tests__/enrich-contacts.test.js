/**
 * GIOCORE Frente C — tests del cron `api/cron/enrich-contacts.ts`.
 *
 * Verifica auth, query params, persistencia agent_decisions, manejo de error.
 * El módulo `wapify-enrich` está mockeado (tests propios viven en
 * `providers/__tests__/wapify-enrich.test.js`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    inserts: [], // {table, row}
    upserts: [], // {table, row, options}
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
    enrichContacts: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/wapify-enrich', () => ({
  enrichContacts: mocks.enrichContacts,
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
    processed: 5,
    enriched: 4,
    invalid: 0,
    failed: 1,
    rate_limited_retries: 0,
    notes: [],
    ...overrides,
  };
}

describe('api/cron/enrich-contacts.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.inserts.length = 0;
    mocks.calls.upserts.length = 0;
    mocks.enrichContacts.mockReset();
    mocks.createClient.mockClear();

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T22:30:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/enrich-contacts.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 401 sin Authorization Bearer', async () => {
    const res = makeRes();
    await handler({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mocks.enrichContacts).not.toHaveBeenCalled();
  });

  it('(b) 401 con bearer incorrecto', async () => {
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('(c) HTTP 200 con bearer correcto y stats en response', async () => {
    mocks.enrichContacts.mockResolvedValue(makeResult());
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(5);
    expect(res.body.enriched).toBe(4);
    expect(res.body.batch_size).toBe(50);
    expect(res.body.throttle_ms).toBe(1500);
  });

  it('(d) query params batch_size / throttle_ms se honran', async () => {
    mocks.enrichContacts.mockResolvedValue(makeResult());
    const res = makeRes();
    await handler(
      {
        headers: { authorization: 'Bearer test-cron-secret' },
        url: '/api/cron/enrich-contacts?batch_size=10&throttle_ms=500',
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.enrichContacts).toHaveBeenCalledTimes(1);
    const opts = mocks.enrichContacts.mock.calls[0][1];
    expect(opts.batchSize).toBe(10);
    expect(opts.throttleMs).toBe(500);
  });

  it('(e) dry_run=1 se propaga a enrichContacts y respuesta', async () => {
    mocks.enrichContacts.mockResolvedValue(makeResult({ failed: 0 }));
    const res = makeRes();
    await handler(
      {
        headers: { authorization: 'Bearer test-cron-secret' },
        url: '/api/cron/enrich-contacts?dry_run=1',
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.dry_run).toBe(true);
    const opts = mocks.enrichContacts.mock.calls[0][1];
    expect(opts.dry_run).toBe(true);
  });

  it('(f) upsert idempotente en agent_decisions con decision_key por hora', async () => {
    mocks.enrichContacts.mockResolvedValue(makeResult({ failed: 0 }));
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(mocks.calls.upserts).toHaveLength(1);
    const u = mocks.calls.upserts[0];
    expect(u.table).toBe('agent_decisions');
    expect(u.row.decision_key).toBe('enrich_contacts_2026-05-22T22');
    expect(u.options.onConflict).toBe('decision_key');
    expect(u.row.status).toBe('auto_approved'); // failed=0, retries=0
  });

  it('(g) status pending si hubo failed > 0', async () => {
    mocks.enrichContacts.mockResolvedValue(makeResult({ failed: 3 }));
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    const u = mocks.calls.upserts[0];
    expect(u.row.status).toBe('pending');
    expect(u.row.severity).toBeGreaterThan(0.3);
  });

  it('(h) enrichContacts lanza → 500 + log en agent_decisions', async () => {
    mocks.enrichContacts.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await handler({ headers: { authorization: 'Bearer test-cron-secret' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(mocks.calls.inserts).toHaveLength(1);
    expect(mocks.calls.inserts[0].table).toBe('agent_decisions');
    expect(mocks.calls.inserts[0].row.severity).toBe(0.9);
    expect(mocks.calls.inserts[0].row.status).toBe('pending');
  });
});
