/**
 * GIOCORE Bloque 7 — contrato compartido de los fetchers de consumo por proveedor.
 *
 * Cada `providers/<x>.ts` exporta un fetcher que llama la API de usage de su
 * proveedor y normaliza el resultado al shape de la tabla Supabase
 * `provider_usage` (ver BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §2.1).
 */

export type Provider = 'anthropic' | 'openai' | 'meta' | 'vercel' | 'wapify';

/** Una fila normalizada, lista para upsert en `provider_usage`. */
export interface ProviderUsageRow {
  provider: Provider;
  /** Modelo (Anthropic/OpenAI) o `null` para proveedores sin desglose por modelo. */
  model?: string | null;
  workspace_id?: string | null;
  account_id?: string | null;
  /** Inicio del período cubierto, formato 'YYYY-MM-DD'. */
  period_start: string;
  /** Fin del período cubierto, formato 'YYYY-MM-DD'. */
  period_end: string;
  tokens_in?: number;
  tokens_in_cached?: number;
  tokens_out?: number;
  requests?: number;
  invocations?: number;
  bandwidth_gb?: number;
  messages_sent?: number;
  cost_usd?: number;
  /** Payload crudo de la API, para auditoría (se persiste como JSONB). */
  raw_payload?: unknown;
}

/**
 * Firma común de todos los fetchers de proveedor.
 * `day` es el día UTC a consultar (el cron pasa "ayer").
 */
export type ProviderFetcher = (day: Date) => Promise<ProviderUsageRow[]>;

/** Helper: formatea un Date a 'YYYY-MM-DD' en UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
