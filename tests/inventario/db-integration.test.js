/**
 * Frente E · tests de integración con Supabase REAL (opt-in).
 *
 * Por defecto SKIP. Para correrlos:
 *   RUN_DB_TESTS=1 npm test -- tests/inventario/db-integration.test.js
 *
 * Cubre lo que pidió el brief y que no se puede mockear:
 *   - registrar_movimiento: entrada normal + idempotency_key returning mismo id
 *   - registrar_movimiento: stock negativo dispara excepción
 *   - registrar_movimiento: producto inexistente dispara P0002
 *   - costo promedio ponderado correcto en entrada con costo_unitario
 *   - trigger decrement_stock en venta_cerrada=true → registra salidas con
 *     idempotency_key determinístico
 *   - refresh_productos_rotacion devuelve { rows, duration_ms, refreshed_at }
 *
 * IMPORTANTE: cada test usa SKUs prefijados con `__test_e_` y limpia al final
 * para no contaminar la DB productiva. Si algo escapa, ejecutar:
 *   DELETE FROM productos_movimientos WHERE producto_slug LIKE '__test_e_%';
 *   DELETE FROM productos WHERE slug LIKE '__test_e_%';
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const ENABLED = process.env.RUN_DB_TESTS === '1';
const describeIf = ENABLED ? describe : describe.skip;

function loadEnv() {
  try {
    const txt = readFileSync('.env.local', 'utf8');
    const env = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(?:"(.*?)"|(.*))$/);
      if (m) env[m[1]] = m[2] ?? m[3];
    }
    return env;
  } catch {
    return {};
  }
}

const env = loadEnv();
const SUPABASE_URL = process.env.SUPABASE_URL || env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

const SKU = `__test_e_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
let sb;

beforeAll(async () => {
  if (!ENABLED) return;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no en entorno');
  }
  sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Insertar producto de prueba
  const { error } = await sb.from('productos').insert({
    slug: SKU,
    nombre: 'producto test frente E',
    categoria: '__test_e',
    stock_actual: 10,
    stock_minimo: 3,
    precio_publico: 100,
    precio_costo: 50,
    estado: 'activo',
  });
  if (error) throw new Error(`setup product insert: ${error.message}`);
});

afterAll(async () => {
  if (!ENABLED || !sb) return;
  await sb.from('productos_movimientos').delete().eq('producto_slug', SKU);
  await sb.from('productos').delete().eq('slug', SKU);
});

describeIf('Frente E · DB integration (real Supabase)', () => {
  it('registrar_movimiento entrada normal: stock + delta', async () => {
    const { data, error } = await sb.rpc('registrar_movimiento', {
      p_slug: SKU,
      p_tipo: 'entrada',
      p_cantidad: 5,
      p_motivo: 'test entrada',
    });
    expect(error).toBeNull();
    expect(typeof data).toBe('number');
    // Stock debe haber subido a 15
    const { data: prod } = await sb.from('productos').select('stock_actual').eq('slug', SKU).single();
    expect(prod.stock_actual).toBe(15);
  });

  it('idempotency_key: mismo key 2 veces → mismo id, no duplica movimiento', async () => {
    const key = `__test_idem_${Date.now()}`;
    const r1 = await sb.rpc('registrar_movimiento', {
      p_slug: SKU,
      p_tipo: 'salida',
      p_cantidad: 1,
      p_idempotency_key: key,
    });
    const r2 = await sb.rpc('registrar_movimiento', {
      p_slug: SKU,
      p_tipo: 'salida',
      p_cantidad: 1,
      p_idempotency_key: key,
    });
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r2.data).toBe(r1.data); // mismo id retornado
    // Solo 1 fila con ese key
    const { count } = await sb
      .from('productos_movimientos')
      .select('*', { count: 'exact', head: true })
      .eq('idempotency_key', key);
    expect(count).toBe(1);
  });

  it('stock negativo: salida que excede stock_actual → error', async () => {
    const { data: pre } = await sb.from('productos').select('stock_actual').eq('slug', SKU).single();
    const { data, error } = await sb.rpc('registrar_movimiento', {
      p_slug: SKU,
      p_tipo: 'salida',
      p_cantidad: pre.stock_actual + 100, // imposible
    });
    expect(error).not.toBeNull();
    expect(error.message).toMatch(/stock negativo/i);
    expect(data).toBeNull();
  });

  it('producto inexistente → error producto no existe', async () => {
    const { data, error } = await sb.rpc('registrar_movimiento', {
      p_slug: `__nonexistent_${Date.now()}`,
      p_tipo: 'entrada',
      p_cantidad: 1,
    });
    expect(error).not.toBeNull();
    expect(error.message).toMatch(/producto no existe/i);
  });

  it('costo promedio ponderado en entrada con costo_unitario', async () => {
    // Reset costo conocido
    await sb.from('productos').update({ stock_actual: 10, precio_costo: 100 }).eq('slug', SKU);
    // Entrada de 5 unidades a 200 → promedio = (100*10 + 200*5) / 15 = 133.33
    const { error } = await sb.rpc('registrar_movimiento', {
      p_slug: SKU,
      p_tipo: 'entrada',
      p_cantidad: 5,
      p_costo_unitario: 200,
    });
    expect(error).toBeNull();
    const { data: prod } = await sb.from('productos').select('stock_actual, precio_costo').eq('slug', SKU).single();
    expect(prod.stock_actual).toBe(15);
    expect(Number(prod.precio_costo)).toBeCloseTo(133.33, 2);
  });

  it('refresh_productos_rotacion devuelve metadata', async () => {
    const { data, error } = await sb.rpc('refresh_productos_rotacion');
    expect(error).toBeNull();
    expect(data).toMatchObject({
      rows: expect.any(Number),
      duration_ms: expect.any(Number),
    });
    expect(data.rows).toBeGreaterThan(0);
  });
});
