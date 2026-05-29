/**
 * GIOCORE Frente E · 1.6 — Cron horario que detecta stock bajo y manda alerta
 * agrupada por WhatsApp a Isaac (vía Wapify).
 *
 * Spec: PROMPT_CODE_FRENTE_E.md §1.6.
 *
 * Schedule: `15 * * * *` (cada hora al minuto 15). Decisión: el brief sugería
 * `0 * * * *` pero ya hay `enrich-contacts` corriendo a esa hora. Para evitar
 * pico de carga simultánea movemos a `:15`.
 *
 * Lógica:
 *   1. Detectar productos con `stock_actual <= stock_minimo` AND `stock_minimo > 0`
 *      AND `estado='activo'`.
 *   2. Filtrar los que YA tuvieron alerta `stock_low_alert` en `agent_decisions`
 *      en las últimas 24h (idempotencia — no spamear).
 *   3. Si quedan SKUs nuevos, componer **1 solo mensaje** agrupado (no N).
 *   4. Mandar vía Wapify. Solo si OK → insertar N filas en agent_decisions
 *      (1 por SKU alertado) para dedupe en próximas corridas.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sendWhatsApp } from '../../agents/_shared/providers/wapify-notify';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

/* ── Tipos ──────────────────────────────────────────────────────────────── */

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

interface ProductoBajo {
  slug: string;
  nombre: string;
  stock_actual: number;
  stock_minimo: number;
  categoria: string | null;
  estado?: string;
}

const MAX_LINEAS_MSG = 20;

/* ── Helpers ────────────────────────────────────────────────────────────── */

function buildSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido');
  return createClient(url, key, { auth: { persistSession: false } });
}

function formatMensaje(productos: ProductoBajo[]): string {
  const total = productos.length;
  const visibles = productos.slice(0, MAX_LINEAS_MSG);
  const extra = total > MAX_LINEAS_MSG ? `\n+${total - MAX_LINEAS_MSG} más…` : '';

  const lineas = visibles
    .map((p) => {
      const cat = p.categoria ? ` (${p.categoria})` : '';
      return `• ${p.slug} ${p.nombre} · stock ${p.stock_actual}/${p.stock_minimo}${cat}`;
    })
    .join('\n');

  return `[GIOCORE] Stock bajo (${total} SKU${total === 1 ? '' : 's'}):\n${lineas}${extra}`;
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  if (res.setHeader) res.setHeader('Cache-Control', 'no-store, max-age=0');

  // Auth — comparación constant-time (P2-2)
  const auth = req.headers.authorization;
  const authStr = typeof auth === 'string' ? auth : '';
  if (!timingSafeBearer(authStr, process.env.CRON_SECRET ?? '')) {
    res.status(401).end();
    return;
  }

  let supabase: SupabaseClient;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  // 1 · Detectar productos candidatos (mínimo > 0, activos).
  //
  //     Decisión post-CHECK-2: supabase-js NO soporta column-vs-column en
  //     `.filter(col, op, otraCol)` — trata el 2º arg como literal string y
  //     trata de castearlo al tipo de la columna. La llamada original
  //     `.filter('stock_actual', 'lte', 'stock_minimo')` reventaba con
  //     "invalid input syntax for type integer: 'stock_minimo'".
  //
  //     Workaround: fetch del universo (activos con stock_minimo>0) y filtro
  //     client-side. Con 3860 SKUs totales en producción y la mayoría sin
  //     mínimo configurado, el universo es bounded — sin riesgo de OOM.
  //     Si Fase 3 escala >50k SKUs, evaluar RPC `productos_stock_bajo()`.
  const { data: universo, error: errBajos } = await supabase
    .from('productos')
    .select('slug, nombre, stock_actual, stock_minimo, categoria, estado')
    .gt('stock_minimo', 0)
    .eq('estado', 'activo')
    .order('stock_actual', { ascending: true });

  if (errBajos) {
    res.status(500).json({ ok: false, error: errBajos.message });
    return;
  }

  const bajos = ((universo ?? []) as ProductoBajo[]).filter(
    (p) => p.stock_actual <= p.stock_minimo,
  );

  if (bajos.length === 0) {
    res.status(200).json({
      ok: true,
      alertas_enviadas: 0,
      productos_bajos: 0,
      universo: universo?.length ?? 0,
    });
    return;
  }

  // 2 · Filtrar los ya alertados en últimas 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: yaAlertados, error: errYa } = await supabase
    .from('agent_decisions')
    .select('payload, created_at')
    .eq('type', 'stock_low_alert')
    .gte('created_at', since);

  if (errYa) {
    // No fail abierta — si no podemos consultar dedupe, alertamos igual (mejor
    // dup que silencio total). Loggear warning.
    console.warn(
      `[cron/alertas-stock-bajo] no se pudo leer agent_decisions: ${errYa.message}`,
    );
  }

  const skusYaAlertados = new Set<string>();
  for (const row of yaAlertados ?? []) {
    const payload = row.payload as Record<string, unknown> | null;
    const slug = (payload?.slug as string | undefined) ?? (payload?.sku as string | undefined);
    if (slug) skusYaAlertados.add(slug);
  }

  const aAlertar: ProductoBajo[] = (bajos as ProductoBajo[]).filter(
    (p) => !skusYaAlertados.has(p.slug),
  );

  if (aAlertar.length === 0) {
    res.status(200).json({
      ok: true,
      alertas_enviadas: 0,
      productos_bajos: bajos.length,
      skipped_dedup: bajos.length,
    });
    return;
  }

  // 3 · Componer 1 mensaje agrupado
  const numero = process.env.WHATSAPP_ISAAC;
  if (!numero) {
    res.status(500).json({
      ok: false,
      error: 'WHATSAPP_ISAAC no está en el entorno',
      productos_a_alertar: aAlertar.length,
    });
    return;
  }
  const mensaje = formatMensaje(aAlertar);

  // 4 · Send Wapify
  const resWapify = await sendWhatsApp(numero, mensaje);

  // 5 · Si OK, registrar dedupe en agent_decisions
  if (resWapify.ok) {
    const rows = aAlertar.map((p) => ({
      type: 'stock_low_alert',
      payload: {
        slug: p.slug,
        nombre: p.nombre,
        stock_actual: p.stock_actual,
        stock_minimo: p.stock_minimo,
        categoria: p.categoria,
      },
      severity: 0.5,
    }));
    const { error: errInsert } = await supabase.from('agent_decisions').insert(rows);
    if (errInsert) {
      console.warn(
        `[cron/alertas-stock-bajo] insert agent_decisions falló: ${errInsert.message}`,
      );
    }
  }

  res.status(200).json({
    ok: resWapify.ok,
    alertas_enviadas: resWapify.ok ? aAlertar.length : 0,
    productos_bajos: bajos.length,
    skipped_dedup: bajos.length - aAlertar.length,
    wapify_retries: resWapify.retries,
    wapify_message_id: resWapify.message_id ?? null,
    wapify_error_code: resWapify.body_error_code ?? resWapify.http_status ?? resWapify.error,
  });
}
