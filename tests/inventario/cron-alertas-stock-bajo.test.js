/**
 * Frente E · tests del cron `/api/cron/alertas-stock-bajo`.
 *
 * Cubre:
 *   - 401 sin Authorization
 *   - 200 sin productos bajos → alertas_enviadas=0
 *   - Dedupe: si ya hay agent_decision en últimas 24h, skipped_dedup contabiliza
 *   - Mensaje agrupado (1 solo send para N SKUs)
 *   - Insert de N agent_decisions tras envío OK
 *   - WHATSAPP_ISAAC ausente → 500
 *   - sendWhatsApp falla → no inserta dedupe
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let productosChain, agentDecisionsChain, insertMock, sendWhatsAppMock;

function makeProductosChain(result) {
  const c = {
    select: vi.fn(() => c),
    gt: vi.fn(() => c),
    eq: vi.fn(() => c),
    filter: vi.fn(() => c),
    order: vi.fn(() => Promise.resolve(result)),
  };
  return c;
}
function makeAgentDecisionsSelectChain(result) {
  const c = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    gte: vi.fn(() => Promise.resolve(result)),
  };
  return c;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  process.env.CRON_SECRET = 'test_cron';
  process.env.WHATSAPP_ISAAC = '+52555';

  insertMock = vi.fn().mockResolvedValue({ error: null });
  sendWhatsAppMock = vi.fn().mockResolvedValue({ ok: true, retries: 0, message_id: 'mWA' });
  productosChain = makeProductosChain({ data: [], error: null });
  agentDecisionsChain = makeAgentDecisionsSelectChain({ data: [], error: null });
});

function makeReq(overrides = {}) {
  return { method: 'POST', headers: { authorization: 'Bearer test_cron' }, ...overrides };
}
function makeRes() {
  return {
    statusCode: null, jsonBody: null, headers: {},
    setHeader(n, v) { this.headers[n] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    end() { return this; },
  };
}

async function loadHandler() {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: vi.fn(() => ({
      from: vi.fn((tbl) => {
        if (tbl === 'productos') return productosChain;
        if (tbl === 'agent_decisions') {
          // Si es insert ({ insert: fn }), devolver el insertMock; si es select, devolver chain
          return {
            select: agentDecisionsChain.select,
            insert: insertMock,
          };
        }
        return {};
      }),
    })),
  }));
  vi.doMock('../../agents/_shared/providers/wapify-notify', () => ({
    sendWhatsApp: sendWhatsAppMock,
  }));
  return (await import('../../api/cron/alertas-stock-bajo.ts')).default;
}

describe('Frente E · cron/alertas-stock-bajo', () => {
  it('401 sin Authorization', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('200 sin productos bajos → alertas_enviadas=0', async () => {
    productosChain = makeProductosChain({ data: [], error: null });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alertas_enviadas).toBe(0);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it('dedupe: SKU ya alertado 24h → skipped_dedup, sin send', async () => {
    productosChain = makeProductosChain({
      data: [
        { slug: 'a1', nombre: 'Lente A', stock_actual: 2, stock_minimo: 5, categoria: 'lentes' },
      ],
      error: null,
    });
    agentDecisionsChain = makeAgentDecisionsSelectChain({
      data: [{ payload: { slug: 'a1' }, created_at: new Date().toISOString() }],
      error: null,
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alertas_enviadas).toBe(0);
    expect(res.jsonBody.skipped_dedup).toBe(1);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it('mensaje agrupado: 3 SKUs nuevos → 1 sólo send', async () => {
    productosChain = makeProductosChain({
      data: [
        { slug: 'a1', nombre: 'A', stock_actual: 1, stock_minimo: 5, categoria: 'l' },
        { slug: 'a2', nombre: 'B', stock_actual: 0, stock_minimo: 3, categoria: 'l' },
        { slug: 'a3', nombre: 'C', stock_actual: 2, stock_minimo: 4, categoria: 'l' },
      ],
      error: null,
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alertas_enviadas).toBe(3);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    const [numero, mensaje] = sendWhatsAppMock.mock.calls[0];
    expect(numero).toBe('+52555');
    expect(mensaje).toContain('Stock bajo (3 SKUs)');
    expect(mensaje).toContain('a1');
    expect(mensaje).toContain('a2');
    expect(mensaje).toContain('a3');
  });

  it('Wapify OK → inserta N agent_decisions para dedupe futuro', async () => {
    productosChain = makeProductosChain({
      data: [
        { slug: 'a1', nombre: 'A', stock_actual: 1, stock_minimo: 5, categoria: 'l' },
        { slug: 'a2', nombre: 'B', stock_actual: 0, stock_minimo: 3, categoria: 'l' },
      ],
      error: null,
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const rows = insertMock.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('stock_low_alert');
    expect(rows[0].payload.slug).toBe('a1');
    expect(rows[1].payload.slug).toBe('a2');
  });

  it('Wapify falla → NO inserta dedupe', async () => {
    productosChain = makeProductosChain({
      data: [{ slug: 'a1', nombre: 'A', stock_actual: 1, stock_minimo: 5, categoria: 'l' }],
      error: null,
    });
    sendWhatsAppMock.mockResolvedValueOnce({ ok: false, retries: 3, body_error_code: 503 });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.jsonBody.ok).toBe(false);
    expect(res.jsonBody.alertas_enviadas).toBe(0);
    expect(res.jsonBody.wapify_error_code).toBe(503);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('WHATSAPP_ISAAC ausente → 500', async () => {
    delete process.env.WHATSAPP_ISAAC;
    productosChain = makeProductosChain({
      data: [{ slug: 'a1', nombre: 'A', stock_actual: 1, stock_minimo: 5, categoria: 'l' }],
      error: null,
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.error).toMatch(/WHATSAPP_ISAAC/);
  });

  it('mensaje cap a 20 líneas con extra "+N más"', async () => {
    const data = Array.from({ length: 25 }, (_, i) => ({
      slug: `s${i}`, nombre: `n${i}`, stock_actual: 0, stock_minimo: 1, categoria: 'l',
    }));
    productosChain = makeProductosChain({ data, error: null });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    const mensaje = sendWhatsAppMock.mock.calls[0][1];
    expect(mensaje).toContain('Stock bajo (25 SKUs)');
    expect(mensaje).toContain('+5 más');
    // Las 20 primeras líneas deben estar; la 21 (s20) no
    expect(mensaje).toContain('s0 ');
    expect(mensaje).toContain('s19 ');
    expect(mensaje).not.toContain('s20 ');
  });
});
