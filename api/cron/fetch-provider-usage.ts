/**
 * GIOCORE Bloque 7 — Cron diario que dispara los fetchers de consumo por
 * proveedor y persiste el resultado en Supabase (`provider_usage`).
 *
 * Spec: BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §3.
 * Brief Fase 2 (22-may): D2=a → Wapify EXCLUIDO de v1 (fetcher disponible en
 *   providers/wapify.ts, pero no se llama acá). Resto de proveedores
 *   (Anthropic/OpenAI/Vercel) BLOQUEADOS por B3/D1/B5 hasta tener Admin Keys.
 *
 * Trigger: vercel.json → cron "0 12 * * *" (12:00 UTC = 06:00 MX, spec §3.1).
 *
 * Cuando se agreguen los demás proveedores, sumar su llamada al array `tasks`
 * y extender PROVIDER_LABELS en el mismo orden (se usa para etiquetar errores).
 */

import { createClient } from '@supabase/supabase-js';
import { fetchMetaUsage } from '../../agents/_shared/providers/meta.js';
import type { ProviderUsageRow } from '../../agents/_shared/providers/types.js';

/* ── Tipos mínimos de handler Vercel (evitamos dep en @vercel/node) ─────── */

interface VercelLikeReq {
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
}

/* ── Configuración ──────────────────────────────────────────────────────── */

/**
 * Etiquetas de proveedor en el mismo orden que `tasks` (para mapear índice ↔
 * proveedor al loggear errores rechazados por Promise.allSettled).
 */
const PROVIDER_LABELS: readonly string[] = [
  'meta',
  // 'wapify' — excluido de v1 por D2=a
  // 'anthropic', 'openai', 'vercel' — pendientes B3/D1/B5
];

/* ── Helpers ────────────────────────────────────────────────────────────── */

/** Construye el cliente Supabase con service_role (RLS bypass; el endpoint
 *  público sanitiza separado). Falla rápido si faltan envs. */
function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Calcula la fecha "ayer" en UTC. El cron corre 12:00 UTC; "ayer" cubre el
 * día completo cerrado.
 */
function yesterdayUTC(now: Date = new Date()): Date {
  return new Date(now.getTime() - 86_400_000);
}

/**
 * Inserta una fila en `agent_decisions` documentando el fallo de un fetcher.
 *
 * IMPORTANTE: el shape se alinea al schema REAL (supabase-schema.sql + 002).
 * El spec §3.2 usa pseudocódigo (`type`, `provider`, `payload`) que NO existe
 * en la tabla real — el brief manda alinear al SQL como SoT.
 *
 * Columnas usadas:
 *   - agent_name      (NOT NULL): 'cron_fetch_provider_usage' (identifica al cron)
 *   - decision_type   (NOT NULL): 'provider_usage_fetch_error'
 *   - proposed_action (NOT NULL): { provider, error_message, error_stack, day }
 *   - justification   (NOT NULL): mensaje legible para auditoría
 *   - evidence_refs            : payload técnico crudo
 *   - severity                  : 0.50 (operacional, no crítico — degrada gracefully)
 *   - status                    : 'auto_approved' (no requiere review humano por defecto)
 */
async function logFetchError(
  supabase: ReturnType<typeof buildSupabaseClient>,
  provider: string,
  reason: unknown,
  day: string,
): Promise<void> {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'unknown';
  const stack = reason instanceof Error ? reason.stack ?? null : null;

  const row = {
    agent_name: 'cron_fetch_provider_usage',
    decision_type: 'provider_usage_fetch_error',
    proposed_action: { provider, day, error_message: message },
    justification: `Fetcher de ${provider} falló al obtener usage de ${day}: ${message}`,
    evidence_refs: { provider, day, error_message: message, error_stack: stack },
    severity: 0.5,
    status: 'auto_approved',
  };

  const { error } = await supabase.from('agent_decisions').insert(row);
  if (error) {
    // No relanzamos: el cron debe completar todos los proveedores aún si el
    // log de un error falla. Sólo lo dejamos en stdout para Vercel logs.
    console.error(
      `[cron/fetch-provider-usage] No se pudo loggear error de ${provider} en agent_decisions:`,
      error.message,
    );
  }
}

/**
 * Upsertea una fila normalizada en `provider_usage` vía la función SQL
 * `upsert_provider_usage` (15 parámetros — ver 003_provider_usage.sql).
 */
async function upsertRow(
  supabase: ReturnType<typeof buildSupabaseClient>,
  row: ProviderUsageRow,
): Promise<number | null> {
  const { data, error } = await supabase.rpc('upsert_provider_usage', {
    p_provider: row.provider,
    p_model: row.model ?? null,
    p_workspace_id: row.workspace_id ?? null,
    p_account_id: row.account_id ?? null,
    p_period_start: row.period_start,
    p_period_end: row.period_end,
    p_tokens_in: row.tokens_in ?? 0,
    p_tokens_in_cached: row.tokens_in_cached ?? 0,
    p_tokens_out: row.tokens_out ?? 0,
    p_requests: row.requests ?? 0,
    p_invocations: row.invocations ?? 0,
    p_bandwidth_gb: row.bandwidth_gb ?? 0,
    p_messages_sent: row.messages_sent ?? 0,
    p_cost_usd: row.cost_usd ?? 0,
    p_raw_payload: (row.raw_payload as unknown) ?? null,
  });
  if (error) {
    throw new Error(
      `upsert_provider_usage falló para ${row.provider} ${row.period_start}: ${error.message}`,
    );
  }
  return (data as number | null) ?? null;
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  // 1 · Auth (header `Authorization: Bearer ${CRON_SECRET}`)
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  // 2 · Día a consultar = ayer UTC
  const day = yesterdayUTC();
  const dayIso = day.toISOString().slice(0, 10);

  // 3 · Disparar fetchers en paralelo (un solo proveedor activo en v1)
  const tasks: Array<Promise<ProviderUsageRow[]>> = [
    fetchMetaUsage(day),
    // fetchWapifyUsage: excluido v1 (D2=a) — fetcher en providers/wapify.ts queda disponible
    // fetchAnthropic / fetchOpenAI / fetchVercel: bloqueados por B3/D1/B5 — agregar cuando existan
  ];

  const settled = await Promise.allSettled(tasks);

  // 4 · Procesar resultados: upsert o log de error
  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/fetch-provider-usage] No se pudo construir cliente Supabase:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  const summary: Array<{
    provider: string;
    status: 'fulfilled' | 'rejected';
    rows_upserted?: number;
    error?: string;
  }> = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const provider = PROVIDER_LABELS[i] ?? `idx_${i}`;

    if (result.status === 'fulfilled') {
      const rows = result.value;
      let upserted = 0;
      let firstError: string | null = null;
      for (const row of rows) {
        try {
          await upsertRow(supabase, row);
          upserted++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!firstError) firstError = msg;
          // Loggear el error de upsert también va a agent_decisions: el fetcher
          // funcionó pero la persistencia no — útil para diagnosticar drift.
          await logFetchError(supabase, provider, err, dayIso);
        }
      }
      console.log(
        `[cron/fetch-provider-usage] ${provider}: ${upserted}/${rows.length} filas upserteadas (day=${dayIso})`,
      );
      summary.push({
        provider,
        status: 'fulfilled',
        rows_upserted: upserted,
        ...(firstError ? { error: firstError } : {}),
      });
    } else {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.log(`[cron/fetch-provider-usage] ${provider}: REJECTED — ${msg}`);
      await logFetchError(supabase, provider, result.reason, dayIso);
      summary.push({ provider, status: 'rejected', error: msg });
    }
  }

  res.status(200).json({
    ok: true,
    day: dayIso,
    results: summary,
  });
}
