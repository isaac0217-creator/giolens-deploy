/**
 * GIOCORE Frente E · 1.3 — API POST inventario/operaciones.
 *
 * Spec: PROMPT_CODE_FRENTE_E.md §1.3.
 *
 * Endpoint: `POST /api/inventario/operaciones`
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (same secret usado para crons).
 * Body (JSON):
 *   {
 *     "sku": "string",             // slug del producto (PK)
 *     "tipo": "entrada|salida|ajuste|devolucion",
 *     "cantidad": integer (≠ 0),
 *     "proveedor": "string?",       // solo entrada
 *     "costo_unitario": number?,    // solo entrada (recalcula promedio ponderado)
 *     "motivo": "string?",
 *     "registrado_por": "string?",  // default "api"
 *     "idempotency_key": "string?"  // si pasada y existe → devuelve mismo id
 *   }
 *
 * Respuestas:
 *   200 { ok:true, movimiento_id, stock_nuevo }
 *   400 { ok:false, error: 'missing_fields|invalid_tipo|invalid_cantidad' }
 *   401 { } (sin Authorization)
 *   404 { ok:false, error: 'producto no existe' }
 *   405 { ok:false, error: 'method_not_allowed' }
 *   409 { ok:false, error: 'stock negativo' }
 *   500 { ok:false, error }
 *
 * Llama a la PG function `registrar_movimiento` (FOR UPDATE atomic + idempotente
 * vía uq_mov_idempotency). El handler NO INSERTa directo en productos_movimientos.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

/* ── Tipos handler ──────────────────────────────────────────────────────── */

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

/* ── Helpers ────────────────────────────────────────────────────────────── */

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
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  if (typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

const VALID_TIPOS = new Set(['entrada', 'salida', 'ajuste', 'devolucion']);

/**
 * Mapea el error de Postgres/Supabase a un HTTP status apropiado.
 * Los códigos vienen de RAISE EXCEPTION en registrar_movimiento.
 */
function classifyError(msg: string): { status: number; code: string } {
  const lower = msg.toLowerCase();
  if (lower.includes('stock negativo')) return { status: 409, code: 'stock_insuficiente' };
  if (lower.includes('producto no existe')) return { status: 404, code: 'producto_no_existe' };
  if (lower.includes('tipo inválido') || lower.includes('cantidad no puede')) {
    return { status: 400, code: 'validation_error' };
  }
  return { status: 500, code: 'rpc_error' };
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (res.setHeader) res.setHeader('Cache-Control', 'no-store, max-age=0');

  // 0 · Method
  if (req.method && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed', expected: 'POST' });
    return;
  }

  // 1 · Auth — comparación constant-time (cierra P2-2 en write endpoint inventario)
  const auth = req.headers.authorization;
  const authStr = typeof auth === 'string' ? auth : '';
  if (!timingSafeBearer(authStr, process.env.CRON_SECRET ?? '')) {
    res.status(401).end();
    return;
  }

  // 2 · Parse body
  const body = parseBody(req.body);
  const sku = (body.sku ?? body.slug) as string | undefined;
  const tipo = body.tipo as string | undefined;
  const cantidadRaw = body.cantidad;
  const proveedor = body.proveedor as string | null | undefined;
  const costo_unitario = body.costo_unitario as number | null | undefined;
  const motivo = body.motivo as string | null | undefined;
  const registrado_por = (body.registrado_por as string | undefined) ?? 'api';
  const idempotency_key = body.idempotency_key as string | null | undefined;
  const metadata = body.metadata as Record<string, unknown> | null | undefined;

  // 3 · Validación
  if (!sku || typeof sku !== 'string') {
    res.status(400).json({
      ok: false,
      error: 'missing_fields',
      required: ['sku (slug del producto)', 'tipo', 'cantidad'],
    });
    return;
  }
  if (!tipo || !VALID_TIPOS.has(tipo)) {
    res.status(400).json({
      ok: false,
      error: 'invalid_tipo',
      valid: Array.from(VALID_TIPOS),
    });
    return;
  }
  const cantidad =
    typeof cantidadRaw === 'number'
      ? cantidadRaw
      : typeof cantidadRaw === 'string'
        ? Number(cantidadRaw)
        : NaN;
  if (!Number.isInteger(cantidad) || cantidad === 0) {
    res.status(400).json({
      ok: false,
      error: 'invalid_cantidad',
      detail: 'debe ser entero distinto de 0',
    });
    return;
  }
  if (
    costo_unitario !== null &&
    costo_unitario !== undefined &&
    (typeof costo_unitario !== 'number' || costo_unitario < 0)
  ) {
    res.status(400).json({ ok: false, error: 'invalid_costo_unitario' });
    return;
  }

  // 4 · RPC
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
    p_proveedor: proveedor ?? null,
    p_costo_unitario: costo_unitario ?? null,
    p_motivo: motivo ?? null,
    p_registrado_por: registrado_por,
    p_idempotency_key: idempotency_key ?? null,
    p_metadata: metadata ?? null,
  });

  if (rpcErr) {
    const { status, code } = classifyError(rpcErr.message ?? '');
    console.error(
      `[api/inventario/operaciones] RPC error · sku=${sku} tipo=${tipo} cant=${cantidad}: ${rpcErr.message}`,
    );
    res.status(status).json({
      ok: false,
      error: code,
      detail: rpcErr.message,
    });
    return;
  }

  // 5 · Releer stock del producto para devolver al caller
  const { data: prod, error: readErr } = await supabase
    .from('productos')
    .select('stock_actual, stock_minimo')
    .eq('slug', sku)
    .maybeSingle();

  if (readErr) {
    // El movimiento ya se persistió. Devolvemos OK con stock_nuevo=null + warning.
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
