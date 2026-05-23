/**
 * GIOCORE Frente D.2 — tests unit del verificador de salud del token Meta.
 *
 * Mockea `fetch` global. NO toca red real.
 * Convención: source `.ts` importado directo, archivo `.test.js`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkMetaToken,
  severityForStatus,
  statusNeedsAction,
  REFRESH_THRESHOLD_DAYS,
  AUTO_REFRESH_DAYS,
  maskToken,
  extendLongLivedToken,
} from '../meta-token.ts';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('providers/meta-token.ts — checkMetaToken', () => {
  const ORIGINAL_TOKEN = process.env.META_TOKEN;
  const ORIGINAL_EXPIRES = process.env.META_TOKEN_EXPIRES;

  beforeEach(() => {
    process.env.META_TOKEN = 'test-meta-token';
    process.env.META_TOKEN_EXPIRES = '2026-08-01';
    global.fetch = vi.fn();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.META_TOKEN;
    else process.env.META_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_EXPIRES === undefined) delete process.env.META_TOKEN_EXPIRES;
    else process.env.META_TOKEN_EXPIRES = ORIGINAL_EXPIRES;
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('devuelve invalid si falta META_TOKEN (no llama a Graph)', async () => {
    delete process.env.META_TOKEN;
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('invalid');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(r.raw.error).toMatch(/META_TOKEN/);
  });

  it('devuelve ok si Graph /me responde 200 y quedan >7 días', async () => {
    process.env.META_TOKEN_EXPIRES = '2026-08-01'; // ~71 días desde NOW
    global.fetch.mockResolvedValue(
      jsonResponse({ name: 'GioLens', id: '1234567890' }),
    );
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('ok');
    expect(r.days_left).toBeGreaterThan(REFRESH_THRESHOLD_DAYS);
    expect(r.probe.http_status).toBe(200);
    expect(r.probe.ok).toBe(true);
  });

  it('devuelve expiring_soon si daysLeft < 7 pero token vivo', async () => {
    // NOW = 2026-05-22, expires 2026-05-26 → ~4 días
    process.env.META_TOKEN_EXPIRES = '2026-05-26';
    global.fetch.mockResolvedValue(jsonResponse({ name: 'X', id: '1' }));
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('expiring_soon');
    expect(r.days_left).toBeLessThan(REFRESH_THRESHOLD_DAYS);
    expect(r.days_left).toBeGreaterThan(0);
  });

  it('devuelve expired si Graph responde HTTP 400 con code 190 (OAuth)', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(
        { error: { code: 190, message: 'Session has expired' } },
        { ok: false, status: 400 },
      ),
    );
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('expired');
    expect(r.probe.http_status).toBe(400);
  });

  it('devuelve expired si Graph responde 401', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ error: { message: 'Unauthorized' } }, { ok: false, status: 401 }),
    );
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('expired');
  });

  it('devuelve unknown si fetch falla con error de red', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('unknown');
    expect(r.raw.error).toMatch(/ECONNREFUSED/);
  });

  it('devuelve unknown si no hay META_TOKEN_EXPIRES y probe OK', async () => {
    delete process.env.META_TOKEN_EXPIRES;
    global.fetch.mockResolvedValue(jsonResponse({ name: 'X', id: '1' }));
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('unknown');
    expect(r.days_left).toBeNull();
  });

  it('marca expired si daysLeft <= 0 aunque Graph siga 200 (gracia)', async () => {
    process.env.META_TOKEN_EXPIRES = '2026-05-21'; // ayer relativo a NOW
    global.fetch.mockResolvedValue(jsonResponse({ name: 'X', id: '1' }));
    const r = await checkMetaToken(NOW);
    expect(r.status).toBe('expired');
    expect(r.days_left).toBeLessThanOrEqual(0);
  });

  it('usa el endpoint v23.0/me con access_token URL-encoded', async () => {
    process.env.META_TOKEN = 'abc+def/ghi';
    global.fetch.mockResolvedValue(jsonResponse({ name: 'X', id: '1' }));
    await checkMetaToken(NOW);
    const url = String(global.fetch.mock.calls[0][0]);
    expect(url).toContain('graph.facebook.com/v23.0/me');
    expect(url).toContain('access_token=abc%2Bdef%2Fghi');
  });
});

describe('providers/meta-token.ts — severityForStatus', () => {
  it('expired/invalid → 1.0 (crítico)', () => {
    expect(severityForStatus('expired')).toBe(1.0);
    expect(severityForStatus('invalid')).toBe(1.0);
  });
  it('expiring_soon → 0.7', () => {
    expect(severityForStatus('expiring_soon')).toBe(0.7);
  });
  it('unknown → 0.4', () => {
    expect(severityForStatus('unknown')).toBe(0.4);
  });
  it('ok → 0.1', () => {
    expect(severityForStatus('ok')).toBe(0.1);
  });
});

describe('providers/meta-token.ts — statusNeedsAction', () => {
  it('true para expired, expiring_soon, invalid', () => {
    expect(statusNeedsAction('expired')).toBe(true);
    expect(statusNeedsAction('expiring_soon')).toBe(true);
    expect(statusNeedsAction('invalid')).toBe(true);
  });
  it('false para ok y unknown', () => {
    expect(statusNeedsAction('ok')).toBe(false);
    expect(statusNeedsAction('unknown')).toBe(false);
  });
});

/* ── Frente B (auto-refresh) ────────────────────────────────────────────── */

describe('providers/meta-token.ts — constantes Frente B', () => {
  it('AUTO_REFRESH_DAYS = 14 (más conservador que REFRESH_THRESHOLD_DAYS=7)', () => {
    expect(AUTO_REFRESH_DAYS).toBe(14);
    expect(AUTO_REFRESH_DAYS).toBeGreaterThan(REFRESH_THRESHOLD_DAYS);
  });
});

describe('providers/meta-token.ts — maskToken', () => {
  it('null/undefined/short → "***"', () => {
    expect(maskToken(null)).toBe('***');
    expect(maskToken(undefined)).toBe('***');
    expect(maskToken('')).toBe('***');
    expect(maskToken('short')).toBe('***');
  });
  it('token largo → primeros 4 + … + últimos 4', () => {
    expect(maskToken('EAAExampleTokenStringLongEnough')).toBe('EAAE…ough');
  });
  it('no filtra el token completo en el resultado', () => {
    const t = 'EAA-secret-value-1234567890';
    const m = maskToken(t);
    expect(m).not.toContain('secret');
    expect(m.length).toBeLessThanOrEqual(t.length);
  });
});

describe('providers/meta-token.ts — extendLongLivedToken', () => {
  const NOW_FIXED = new Date('2026-05-22T13:00:00.000Z');

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falta currentToken/appId/appSecret → error sin llamar fetch', async () => {
    const r1 = await extendLongLivedToken('', 'app', 'secret');
    expect(r1.ok).toBe(false);
    expect(r1.error?.message).toMatch(/vacío|currentToken/i);

    const r2 = await extendLongLivedToken('tok', '', 'secret');
    expect(r2.ok).toBe(false);

    const r3 = await extendLongLivedToken('tok', 'app', '');
    expect(r3.ok).toBe(false);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('Meta devuelve access_token + expires_in → ok, ISO derivado', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({
        access_token: 'EAA-new-token-9876543210',
        token_type: 'bearer',
        expires_in: 5_184_000,
      }),
    );
    const r = await extendLongLivedToken('old-tok', 'app-id', 'app-secret', NOW_FIXED);
    expect(r.ok).toBe(true);
    expect(r.token).toBe('EAA-new-token-9876543210');
    expect(r.expires_in_sec).toBe(5_184_000);
    expect(r.expires_at).toBe('2026-07-21T13:00:00.000Z'); // 60 días después
  });

  it('Meta devuelve HTTP 400 con error 190 → ok=false, error.code=190', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(
        { error: { code: 190, message: 'Invalid OAuth access token' } },
        { ok: false, status: 400 },
      ),
    );
    const r = await extendLongLivedToken('bad-tok', 'app-id', 'app-secret');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(190);
    expect(r.error?.message).toMatch(/Invalid OAuth/);
    expect(r.token).toBeUndefined();
  });

  it('Meta devuelve HTTP 200 sin access_token → ok=false', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ token_type: 'bearer' }), // sin access_token
    );
    const r = await extendLongLivedToken('tok', 'app', 'secret');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/access_token ausente/);
  });

  it('fetch falla (red) → ok=false, error transport', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await extendLongLivedToken('tok', 'app', 'secret');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/fetch falló/);
  });
});
