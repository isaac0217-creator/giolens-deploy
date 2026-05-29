/**
 * GIOCORE Frente E · 1.4b — API GET inventario/movimientos.
 *
 * Endpoint complementario para alimentar la pestaña "Movimientos" del
 * dashboard `/inventario.html`. Lee el ledger `productos_movimientos`
 * con filtros opcionales por slug, tipo y rango temporal.
 *
 * Endpoint: `GET /api/inventario/movimientos`
 *
 * Query params:
 *   - `?slug=X`           filtra por producto
 *   - `?tipo=X`           filtra por tipo (entrada|salida|ajuste|devolucion)
 *   - `?desde=ISO`        created_at >= desde
 *   - `?hasta=ISO`        created_at < hasta
 *   - `?limit=N`          default 100, máx 500
 *   - `?offset=N`         default 0
 *
 * Auth dual mode (PATCH post-CHECK-1):
 *   - SIN Authorization → respuesta **sanitizada** (sin proveedor, costo_unitario,
 *     motivo, registrado_por). Es el modo que usa el dashboard `/inventario.html`
 *     en el browser.
 *   - CON `Authorization: Bearer ${CRON_SECRET}` → respuesta **completa** (admin)
 *     para tooling interno (smoke tests, debugging, scripts back-office).
 *   - Bearer **inválido** → tratado como público (no 401), sigue devolviendo el
 *     subset sanitizado. Decisión: no leakeamos si el token es válido o no.
 *
 * Campos sensibles ocultos a consumidores anónimos:
 *   - `proveedor`           — secreto comercial
 *   - `costo_unitario`      — business intel (márgenes)
 *   - `motivo`              — puede contener FK a `expedientes` (PII indirecto)
 *   - `registrado_por`      — puede contener email del operador (PII directo)
 *
 * Cache `s-maxage=60`. Patrón consistente con `rotacion.ts`: defense in depth
 * contra inyección via whitelist de columnas para ordenar (orden fijo: created_at DESC).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

/* ── Tipos ──────────────────────────────────────────────────────────────── */

interface VercelLikeReq {
  method?: string;
  url?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const VALID_TIPOS = new Set(['entrada', 'salida', 'ajuste', 'devolucion']);

/** Subset PÚBLICO (sin PII / sin secretos comerciales). */
const SELECT_PUBLIC =
  'id, producto_slug, tipo, cantidad, stock_anterior, stock_nuevo, created_at';
/** Subset ADMIN (todo). Requiere `Authorization: Bearer ${CRON_SECRET}`. */
const SELECT_ADMIN =
  'id, producto_slug, tipo, cantidad, stock_anterior, stock_nuevo, proveedor, costo_unitario, motivo, registrado_por, created_at';

/* ── Helpers ────────────────────────────────────────────────────────────── */

function buildSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido');
  return createClient(url, key, { auth: { persistSession: false } });
}

function readQuery(req: VercelLikeReq, name: string): string | null {
  if (req.query) {
    const v = req.query[name];
    if (Array.isArray(v)) return v[0] ?? null;
    if (typeof v === 'string') return v;
  }
  if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      return u.searchParams.get(name);
    } catch {
      return null;
    }
  }
  return null;
}

function readNumber(req: VercelLikeReq, name: string, def: number, max: number): number {
  const v = readQuery(req, name);
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

function isIsoLike(s: string): boolean {
  // permisivo: cualquier string parseable por Date() que devuelva un timestamp válido
  const t = Date.parse(s);
  return Number.isFinite(t);
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed', expected: 'GET' });
    return;
  }

  // Auth dual: Bearer válido → admin (select completo); resto → público (sanitizado)
  const auth = req.headers.authorization;
  const isAdmin = timingSafeBearer(
    typeof auth === 'string' ? auth : '',
    process.env.CRON_SECRET ?? '',
  );

  const slug = readQuery(req, 'slug') ?? readQuery(req, 'sku');
  const tipo = readQuery(req, 'tipo');
  const desde = readQuery(req, 'desde');
  const hasta = readQuery(req, 'hasta');
  const limit = readNumber(req, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = readNumber(req, 'offset', 0, 1_000_000);

  if (tipo && !VALID_TIPOS.has(tipo)) {
    res.status(400).json({ ok: false, error: 'invalid_tipo', valid: Array.from(VALID_TIPOS) });
    return;
  }
  if (desde && !isIsoLike(desde)) {
    res.status(400).json({ ok: false, error: 'invalid_desde' });
    return;
  }
  if (hasta && !isIsoLike(hasta)) {
    res.status(400).json({ ok: false, error: 'invalid_hasta' });
    return;
  }

  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let q = supabase
    .from('productos_movimientos')
    .select(isAdmin ? SELECT_ADMIN : SELECT_PUBLIC, { count: 'exact' });

  if (slug) q = q.eq('producto_slug', slug);
  if (tipo) q = q.eq('tipo', tipo);
  if (desde) q = q.gte('created_at', desde);
  if (hasta) q = q.lt('created_at', hasta);

  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  if (res.setHeader) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
  }

  res.status(200).json({
    ok: true,
    data: data ?? [],
    count: count ?? 0,
    limit,
    offset,
    mode: isAdmin ? 'admin' : 'public',
    filters: { slug, tipo, desde, hasta },
  });
}
