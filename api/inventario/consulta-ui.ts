/// <reference types="node" />
/**
 * GIOCORE Frente INV · GET /api/inventario/consulta-ui — Módulo M3 (UI de inventario).
 *
 * BFF Origin-gated de LECTURA para la pantalla de inventario del dashboard. Existe
 * porque los reads actuales de inventario (movimientos.ts, rotacion.ts) son Bearer-gated
 * (para crons/scripts) y el browser del dashboard no manda Bearer — mismo motivo por el
 * que existe citas-ui frente a citas. La ESCRITURA sigue por el BFF existente
 * /api/inventario/operaciones-ui (NO se toca). Este endpoint NO escribe nada.
 *
 * Métodos:
 *   GET /api/inventario/consulta-ui?q=texto   — buscar productos (nombre/sku/slug)
 *   GET /api/inventario/consulta-ui?slug=...   — detalle de un producto + últimos movimientos
 *
 * Reglas:
 *   - SOLO GET/OPTIONS. Origin/Referer allowlist (igual que citas-ui). no-store.
 *   - SIN DINERO (regla 5): NUNCA se devuelven precio_costo/precio_publico/precio_promo
 *     ni costo_unitario/proveedor (datos sensibles de costo). Solo CANTIDADES.
 *   - Sin PII (inventario no tiene PII de paciente). Sin secretos en logs.
 */

import { createClient } from '@supabase/supabase-js';

interface VercelLikeReq {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

const ORIGIN_RE = /^https:\/\/giolens-dashboard(-[a-z0-9-]+)?\.vercel\.app(\/|$)|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const val = headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}
function isAllowedOrigin(req: VercelLikeReq): boolean {
  const source = getHeader(req.headers, 'origin') || getHeader(req.headers, 'referer');
  if (!source) return false;
  return ORIGIN_RE.test(source);
}
function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
function setBaseHeaders(res: VercelLikeRes, origin: string): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const allowOrigin = ORIGIN_RE.test(origin) ? origin : 'https://giolens-dashboard.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Columnas de producto SIN DINERO (regla 5: precios viven en eOptis y hoy son NULL).
const PRODUCTO_COLS = 'slug, sku, nombre, marca, categoria, estado, stock_actual, stock_minimo, ubicacion';
// Columnas de movimiento NO sensibles (sin costo_unitario/proveedor — esos son admin/Bearer).
const MOV_COLS = 'id, tipo, cantidad, stock_anterior, stock_nuevo, motivo, created_at';

function firstStr(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}

export default async function handler(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const origin = getHeader(req.headers, 'origin');
  setBaseHeaders(res, origin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method && req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!isAllowedOrigin(req)) { res.status(403).json({ ok: false, error: 'origin_forbidden' }); return; }

  const supabase = buildSupabaseClient();
  if (!supabase) { res.status(500).json({ ok: false, error: 'service_unavailable' }); return; }

  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  const slug = firstStr(q.slug);

  // ── Detalle de producto + últimos movimientos ──
  if (slug) {
    const { data: producto, error: pErr } = await supabase
      .from('productos')
      .select(PRODUCTO_COLS)
      .eq('slug', slug)
      .maybeSingle();
    if (pErr) {
      console.error('[inventario/consulta-ui detalle]', pErr.code ?? 'err');
      res.status(500).json({ ok: false, error: 'internal_error' });
      return;
    }
    if (!producto) { res.status(404).json({ ok: false, error: 'producto_no_encontrado' }); return; }

    const { data: movimientos, error: mErr } = await supabase
      .from('productos_movimientos')
      .select(MOV_COLS)
      .eq('producto_slug', slug)
      .order('created_at', { ascending: false })
      .limit(20);
    if (mErr) {
      console.error('[inventario/consulta-ui movimientos]', mErr.code ?? 'err');
      res.status(500).json({ ok: false, error: 'internal_error' });
      return;
    }
    res.status(200).json({ ok: true, producto, movimientos: movimientos ?? [] });
    return;
  }

  // ── Búsqueda de productos ──
  const term = firstStr(q.q);
  if (!term) { res.status(400).json({ ok: false, error: 'q_o_slug_requerido' }); return; }
  // Sanea el término: quita caracteres que romperían el filtro .or()/ilike de PostgREST
  // (comas, paréntesis, %, _, backslash, comillas). Búsqueda parcial case-insensitive.
  const safe = term.replace(/[,()%_\\"'*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe) { res.status(200).json({ ok: true, productos: [] }); return; }
  const pattern = `%${safe}%`;

  const { data, error } = await supabase
    .from('productos')
    .select(PRODUCTO_COLS)
    .or(`nombre.ilike.${pattern},sku.ilike.${pattern},slug.ilike.${pattern}`)
    .order('nombre', { ascending: true })
    .limit(50);
  if (error) {
    console.error('[inventario/consulta-ui buscar]', error.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  res.status(200).json({ ok: true, productos: data ?? [] });
}
