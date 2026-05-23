/**
 * GIOCORE Bloque 7 — fetcher de consumo de Meta Ads.
 *
 * Consulta el endpoint Graph API insights de cada cuenta publicitaria y
 * normaliza el spend diario al shape de la tabla Supabase `provider_usage`.
 *
 * Ver:
 *  - BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §1.3 (Meta Ads) y §2.1 (provider_usage).
 *  - ./types.ts (contrato compartido — NO se modifica).
 *
 * Reutiliza los IDs de cuenta y la env var del token de `api/meta.js`:
 *  - cuentas: `act_299921604429631` (nuevo) y `act_2241343302609141` (anterior).
 *  - token:   `process.env.META_TOKEN` (confirmado en .env.local; el spec lo
 *             nombraba tentativamente `META_ACCESS_TOKEN`, pero el repo y el
 *             archivo existente usan `META_TOKEN`).
 */

import type { ProviderFetcher, ProviderUsageRow } from './types.js';
import { isoDay } from './types.js';

/** Versión de Graph API según spec §1.3. */
const GRAPH = 'https://graph.facebook.com/v20.0';

/** Nombre de la env var del token (reutilizado de api/meta.js). */
const TOKEN_ENV_VAR = 'META_TOKEN';

/** Campos solicitados al endpoint insights (spec §1.3). */
const FIELDS = 'spend,cpc,cpm,impressions,clicks,actions';

/**
 * Cuentas publicitarias Meta — mismos IDs `act_...` que `api/meta.js`.
 * `nuevo`    = portafolio nuevo (activo).
 * `anterior` = portafolio anterior (mayor rendimiento histórico).
 */
const AD_ACCOUNTS: ReadonlyArray<string> = [
  'act_299921604429631',
  'act_2241343302609141',
];

/** Shape (parcial) de una fila de insight devuelta por Graph API. */
interface MetaInsightRow {
  spend?: string;
  cpc?: string;
  cpm?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  date_start?: string;
  date_stop?: string;
  [key: string]: unknown;
}

/** Parsea un valor numérico de Meta (que llega como string) de forma segura. */
function num(value: unknown): number {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Consulta los insights de UNA cuenta para el día dado.
 * Lanza Error descriptivo si la respuesta HTTP no es OK o si Graph API
 * devuelve un objeto `error` en el body.
 */
async function fetchAccountInsight(
  accountId: string,
  day: string,
  token: string,
): Promise<MetaInsightRow | null> {
  const timeRange = encodeURIComponent(`{"since":"${day}","until":"${day}"}`);
  const url =
    `${GRAPH}/${accountId}/insights` +
    `?fields=${FIELDS}` +
    `&time_range=${timeRange}` +
    `&time_increment=1` +
    `&access_token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Meta insights fetch falló (red) para ${accountId} ${day}: ${msg}`);
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignorar — body opcional para el mensaje */
    }
    throw new Error(
      `Meta insights HTTP ${res.status} ${res.statusText} para ${accountId} ${day}: ${body}`,
    );
  }

  const json = (await res.json()) as { data?: MetaInsightRow[]; error?: { message?: string } };

  if (json && json.error) {
    throw new Error(
      `Meta Graph API error para ${accountId} ${day}: ${json.error.message ?? 'unknown'}`,
    );
  }

  // Sin actividad ese día → Meta devuelve `data: []`.
  return (json.data && json.data[0]) || null;
}

/**
 * Fetcher de consumo de Meta Ads.
 *
 * Para el `day` dado consulta los insights de cada cuenta publicitaria y
 * devuelve un `ProviderUsageRow` por cuenta. Si una cuenta no tuvo actividad
 * ese día igual emite una fila con `cost_usd: 0` para mantener el histórico.
 */
export const fetchMetaUsage: ProviderFetcher = async (
  day: Date,
): Promise<ProviderUsageRow[]> => {
  const token = process.env[TOKEN_ENV_VAR];
  if (!token) {
    throw new Error(
      `Meta fetcher: falta la env var ${TOKEN_ENV_VAR} (token long-lived de Meta).`,
    );
  }

  const period = isoDay(day);

  const rows = await Promise.all(
    AD_ACCOUNTS.map(async (accountId): Promise<ProviderUsageRow> => {
      const insight = await fetchAccountInsight(accountId, period, token);

      return {
        provider: 'meta',
        model: null,
        account_id: accountId,
        period_start: period,
        period_end: period,
        cost_usd: num(insight?.spend),
        // Meta no expone "requests" de API; usamos clicks como proxy de
        // interacciones pagadas e impresiones como invocations del servicio.
        requests: insight ? num(insight.clicks) : 0,
        invocations: insight ? num(insight.impressions) : 0,
        raw_payload: insight ?? { note: 'sin actividad', account_id: accountId, day: period },
      };
    }),
  );

  return rows;
};

export default fetchMetaUsage;
