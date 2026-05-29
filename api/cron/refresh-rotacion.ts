/**
 * GIOCORE Frente E · 1.5 — Cron diario que refresca la materialized view
 * `productos_rotacion_mensual`.
 *
 * Spec: PROMPT_CODE_FRENTE_E.md §1.5.
 *
 * Schedule: `0 9 * * *` (09:00 UTC = 03:00 MX, **1h antes** del cron
 * `snapshot-daily` de Frente H que corre a 10:00 UTC). Esto asegura que el
 * snapshot diario de H captura `productos_movimientos` ya consistente con
 * la matview rebuild — y los análisis offline desde el snapshot quedan
 * sincronizados.
 *
 * Decisión vs. brief: **NO usa `pg.Pool`** (mantiene runtime sin `pg`
 * dependency). En su lugar invoca la RPC `refresh_productos_rotacion()`
 * definida en la migración 009, que:
 *   - corre `REFRESH MATERIALIZED VIEW CONCURRENTLY productos_rotacion_mensual`
 *   - cuenta filas
 *   - devuelve `{ rows, duration_ms, refreshed_at }`
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel cron injecta este header
 * automáticamente). Mismo patrón que `snapshot-daily.ts`.
 *
 * Side effects:
 *   - Logea en `agent_decisions` el resultado (type='rotacion_refresh') para
 *     auditoría y para que el dashboard /inventario.html pueda mostrar
 *     "última actualización".
 *   - Si la RPC falla, envía alerta WhatsApp a Isaac via `wapify-notify` (sin
 *     esto, el data en snapshots de H quedaría stale sin nadie enterado).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sendWhatsApp } from '../../agents/_shared/providers/wapify-notify';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

/* ── Tipos handler ──────────────────────────────────────────────────────── */

interface VercelLikeReq {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

interface RefreshResult {
  rows: number;
  duration_ms: number;
  refreshed_at: string;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function buildSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function notifyFailure(message: string): Promise<void> {
  const numero = process.env.WHATSAPP_ISAAC;
  if (!numero) return; // no number, no alert (silencioso)
  try {
    await sendWhatsApp(numero, `[GIOCORE] cron refresh-rotacion FALLO\n${message}`, {
      maxRetries: 2,
    });
  } catch {
    // never throw from a notifier
  }
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (res.setHeader) res.setHeader('Cache-Control', 'no-store, max-age=0');

  // Auth — Vercel cron incluye Authorization: Bearer <CRON_SECRET> (constant-time, P2-2)
  const auth = req.headers.authorization;
  const authStr = typeof auth === 'string' ? auth : '';
  if (!timingSafeBearer(authStr, process.env.CRON_SECRET ?? '')) {
    res.status(401).end();
    return;
  }

  const t0 = Date.now();
  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await notifyFailure(`buildSupabaseClient: ${msg}`);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  // 1 · Invocar RPC refresh_productos_rotacion
  const { data: rpcData, error: rpcErr } = await supabase.rpc('refresh_productos_rotacion');
  if (rpcErr) {
    console.error(`[cron/refresh-rotacion] RPC error: ${rpcErr.message}`);
    await notifyFailure(`RPC refresh_productos_rotacion: ${rpcErr.message}`);
    res.status(500).json({ ok: false, error: rpcErr.message });
    return;
  }

  const result = (rpcData ?? {}) as Partial<RefreshResult>;
  const rows = typeof result.rows === 'number' ? result.rows : null;
  const dur = Date.now() - t0;

  // 2 · Loggear en agent_decisions para auditoría / Frente H
  try {
    await supabase.from('agent_decisions').insert({
      type: 'rotacion_refresh',
      payload: {
        rows,
        duration_ms_handler: dur,
        duration_ms_rpc: result.duration_ms ?? null,
        refreshed_at: result.refreshed_at ?? new Date().toISOString(),
      },
      severity: 0.1,
    });
  } catch (logErr) {
    // log fail no debe romper el cron; sólo lo dejamos en stderr
    console.warn(
      `[cron/refresh-rotacion] log a agent_decisions falló: ${
        logErr instanceof Error ? logErr.message : String(logErr)
      }`,
    );
  }

  res.status(200).json({
    ok: true,
    rows,
    duration_ms: dur,
    duration_ms_rpc: result.duration_ms ?? null,
    refreshed_at: result.refreshed_at ?? new Date().toISOString(),
  });
}
