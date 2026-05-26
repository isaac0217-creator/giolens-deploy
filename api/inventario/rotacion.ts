/**
 * GIOCORE Frente E · 1.4 — API GET inventario/rotacion.
 *
 * Spec: PROMPT_CODE_FRENTE_E.md §1.4.
 *
 * Endpoint: `GET /api/inventario/rotacion`
 *
 * Query params:
 *   - `?categoria=X`         filtra por categoría
 *   - `?orden=col.dir`       default `ventas_30d.desc`. Columnas válidas:
 *                            ventas_30d, ventas_90d, unidades_30d, unidades_90d,
 *                            rotacion_30d, stock_actual, nombre, sku
 *   - `?limit=N`             default 100, máx 500
 *   - `?offset=N`            default 0
 *   - `?muertos=true`        filtra `ventas_90d=0 AND stock_actual>0`
 *
 * Auth dual mode (PATCH post-CHECK-1):
 *   - SIN Authorization → respuesta **sanitizada**: strip `precio_publico` y
 *     `precio_costo` del set de columnas devueltas. Es el modo del dashboard
 *     `/inventario.html` en el browser.
 *   - CON `Authorization: Bearer ${CRON_SECRET}` → respuesta **completa**
 *     incluyendo `precio_publico` y `precio_costo` (admin / tooling interno).
 *   - Bearer inválido → tratado como público (no 401), responde con subset
 *     sanitizado. Decisión: no leakeamos si el token es válido o no.
 *
 * Campos sensibles ocultos a consumidores anónimos:
 *   - `precio_publico` — estrategia pricing
 *   - `precio_costo`   — márgenes / business intel
 *
 * Cache 5 min vía `Cache-Control: s-maxage=300, stale-while-revalidate=60`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

/* ── Constantes ─────────────────────────────────────────────────────────── */

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const VALID_ORDER_COLS = new Set([
  'ventas_30d',
  'ventas_90d',
  'unidades_30d',
  'unidades_90d',
  'rotacion_30d',
  'stock_actual',
  'nombre',
  'sku',
  'ultima_venta_real',
]);

/** Columnas devueltas al consumidor PÚBLICO (sin precio_publico ni precio_costo). */
const SELECT_PUBLIC =
  'sku, nombre, categoria, stock_actual, stock_minimo, ventas_30d, ventas_90d, unidades_30d, unidades_90d, rotacion_30d, ultima_venta_real, computed_at';
/** Columnas devueltas al ADMIN (todo el matview). Bearer `${CRON_SECRET}`. */
const SELECT_ADMIN = '*';

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

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed', expected: 'GET' });
    return;
  }

  // Auth dual: Bearer válido → admin (todas las columnas); resto → público (sanitizado)
  const auth = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const isAdmin =
    typeof auth === 'string' &&
    !!cronSecret &&
    auth === `Bearer ${cronSecret}`;

  const categoria = readQuery(req, 'categoria');
  const ordenRaw = readQuery(req, 'orden') ?? 'ventas_30d.desc';
  const limit = readNumber(req, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = readNumber(req, 'offset', 0, 1_000_000);
  const muertos = (readQuery(req, 'muertos') ?? '') === 'true';

  // Validar orden contra whitelist (defense in depth).
  const [col, dirRaw] = ordenRaw.split('.');
  if (!VALID_ORDER_COLS.has(col)) {
    res.status(400).json({
      ok: false,
      error: 'invalid_orden',
      valid: Array.from(VALID_ORDER_COLS),
    });
    return;
  }
  const ascending = dirRaw !== 'desc';

  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let q = supabase
    .from('productos_rotacion_mensual')
    .select(isAdmin ? SELECT_ADMIN : SELECT_PUBLIC, { count: 'exact' });
  if (categoria) q = q.eq('categoria', categoria);
  if (muertos) {
    q = q.eq('ventas_90d', 0).gt('stock_actual', 0);
  }
  q = q.order(col, { ascending }).range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  if (res.setHeader) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  }

  const total = count ?? 0;
  res.status(200).json({
    ok: true,
    data: data ?? [],
    count: total,
    limit,
    offset,
    pagination: {
      limit,
      offset,
      total,
      has_more: offset + limit < total,
    },
    mode: isAdmin ? 'admin' : 'public',
    filters: { categoria, orden: ordenRaw, muertos },
  });
}
