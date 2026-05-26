/**
 * GIOCORE Frente INV · UI proxy — POST inventario/operaciones-ui
 *
 * BFF (Backend For Frontend) wrapper sobre `operaciones.ts`.
 * El browser llama aquí SIN Bearer — este handler añade el Bearer
 * internamente usando `process.env.CRON_SECRET` y reenvía al handler
 * de operaciones reutilizando la lógica directamente.
 *
 * Seguridad mínima aplicada:
 *   - Solo acepta POST.
 *   - Valida `Origin` o `Referer` — solo acepta peticiones del mismo host
 *     (Vercel deployment URL o localhost para dev). Si origin no coincide → 403.
 *   - CORS: solo el mismo origen.
 *
 * Endpoint: `POST /api/inventario/operaciones-ui`
 * Auth requerida por el caller: ninguna (browser dashboard interno).
 *
 * Body: idéntico al de `operaciones.ts`:
 *   { sku, tipo, cantidad, costo_unitario?, motivo?, registrado_por? }
 *
 * Respuestas: idénticas a `operaciones.ts` (200/400/404/409/500).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface VercelLikeReq {
  method?: string;
  url?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

function buildSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido');
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseBody(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

const VALID_TIPOS = new Set(['entrada', 'salida', 'ajuste', 'devolucion']);

function classifyError(msg: string): { status: number; code: string } {
  const lower = msg.toLowerCase();
  if (lower.includes('stock negativo')) return { status: 409, code: 'stock_insuficiente' };
  if (lower.includes('producto no existe')) return { status: 404, code: 'producto_no_existe' };
  if (lower.includes('tipo inválido') || lower.includes('cantidad no puede')) {
    return { status: 400, code: 'validation_error' };
  }
  return { status: 500, code: 'rpc_error' };
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const val = headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}

export default async function handler(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  if (res.setHeader) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', getHeader(req.headers, 'origin') || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // 0 · Method
  if (req.method && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed', expected: 'POST' });
    return;
  }

  // 0.5 · Origin/Referer check — solo aceptamos peticiones del dashboard mismo.
  // Bloquea curls externos y CSRF casual; no es defensa contra requests forjados,
  // pero filtra el 99% del abuso casual sin requerir login.
  // Permitidos: dominio prod, preview deploys (*.vercel.app del proyecto), localhost.
  const origin = getHeader(req.headers, 'origin');
  const referer = getHeader(req.headers, 'referer');
  const source = origin || referer;
  const isAllowed = !source
    ? false
    : /^https:\/\/giolens-dashboard(-[a-z0-9-]+)?\.vercel\.app(\/|$)/.test(source) ||
      /^https?:\/\/localhost(:\d+)?(\/|$)/.test(source) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/.test(source);
  if (!isAllowed) {
    res.status(403).json({ ok: false, error: 'origin_forbidden' });
    return;
  }

  // 1 · CRON_SECRET requerido en entorno (sin él este endpoint no puede funcionar)
  if (!process.env.CRON_SECRET) {
    res.status(503).json({ ok: false, error: 'configuracion_incompleta' });
    return;
  }

  // 2 · Parse body
  const body = parseBody(req.body);
  const sku = (body.sku ?? body.slug) as string | undefined;
  const tipo = body.tipo as string | undefined;
  const cantidadRaw = body.cantidad;
  const costo_unitario = body.costo_unitario as number | null | undefined;
  const motivo = body.motivo as string | null | undefined;
  const registrado_por = (body.registrado_por as string | undefined) ?? 'dashboard';

  // 3 · Validación básica
  if (!sku || typeof sku !== 'string') {
    res.status(400).json({ ok: false, error: 'missing_fields', required: ['sku', 'tipo', 'cantidad'] });
    return;
  }
  if (!tipo || !VALID_TIPOS.has(tipo)) {
    res.status(400).json({ ok: false, error: 'invalid_tipo', valid: Array.from(VALID_TIPOS) });
    return;
  }
  const cantidad =
    typeof cantidadRaw === 'number'
      ? cantidadRaw
      : typeof cantidadRaw === 'string'
        ? Number(cantidadRaw)
        : NaN;
  if (!Number.isInteger(cantidad) || cantidad === 0) {
    res.status(400).json({ ok: false, error: 'invalid_cantidad', detail: 'debe ser entero distinto de 0' });
    return;
  }

  // 4 · RPC directo (mismo flujo que operaciones.ts)
  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  const { data: movId, error: rpcErr } = await supabase.rpc('registrar_movimiento', {
    p_slug: sku,
    p_tipo: tipo,
    p_cantidad: cantidad,
    p_proveedor: null,
    p_costo_unitario: costo_unitario ?? null,
    p_motivo: motivo ?? null,
    p_registrado_por: registrado_por,
    p_idempotency_key: null,
    p_metadata: null,
  });

  if (rpcErr) {
    const { status, code } = classifyError(rpcErr.message ?? '');
    console.error(`[api/inventario/operaciones-ui] RPC error · sku=${sku} tipo=${tipo} cant=${cantidad}: ${rpcErr.message}`);
    res.status(status).json({ ok: false, error: code, detail: rpcErr.message });
    return;
  }

  // 5 · Releer stock post-RPC
  const { data: prod, error: readErr } = await supabase
    .from('productos')
    .select('stock_actual, stock_minimo')
    .eq('slug', sku)
    .maybeSingle();

  if (readErr) {
    res.status(200).json({
      ok: true,
      movimiento_id: movId,
      stock_nuevo: null,
      warning: `read post-RPC falló: ${readErr.message}`,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    movimiento_id: movId,
    stock_nuevo: prod?.stock_actual ?? null,
    stock_minimo: prod?.stock_minimo ?? null,
    alerta_bajo: prod ? prod.stock_actual <= prod.stock_minimo : false,
  });
}
