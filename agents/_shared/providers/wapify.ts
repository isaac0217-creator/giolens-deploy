/**
 * GIOCORE Bloque 7 — fetcher de consumo de Wapify (WhatsApp CRM).
 *
 * Cuenta los mensajes enviados en un día dado vía la API de Wapify y los
 * normaliza al shape de la tabla Supabase `provider_usage`.
 *
 * Spec: BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §1.5 (Wapify), §2.1 (tabla),
 *       §10 D2 (estimación USD por mensaje).
 *
 * ── Descubrimiento de API (Acción Code C1.5) — EJECUTADO 25-may ───────────
 * Discovery corrido por Code main contra la API real de Wapify:
 *   - GET /api/messages?limit=1   → HTTP 200, body {"error":{"code":404,...}}
 *   - GET /api/account/usage      → HTTP 200, body {"error":{"code":404,...}}
 * CONCLUSIÓN: Wapify NO expone un endpoint de usage NI un endpoint global de
 * mensajes. Su API es pipeline/opportunity-céntrica (`pipelines/{id}/...`).
 * No hay fuente directa de volumen de mensajes para v1.
 *
 * Este fetcher queda construido de forma DEFENSIVA: al pegarle a `/messages`
 * recibe el objeto de error, no encuentra lista de mensajes, y devuelve
 * `messages_sent: 0` con nota explícita en `raw_payload` — NUNCA inventa datos.
 *
 * ⚠️ DECISIÓN PENDIENTE (Cowork/Isaac): definir qué métrica de "consumo Wapify"
 *    usar en v1 — otro endpoint, conteo de opportunities como proxy, o excluir
 *    Wapify de v1. Hasta esa decisión, este fetcher reporta 0 de forma honesta.
 */

import type { ProviderFetcher, ProviderUsageRow } from './types.js';
import { isoDay } from './types.js';

/* ── Configuración de la API ─────────────────────────────────────────────── */

const WAPIFY_BASE = 'https://ap.whapify.ai/api';
const MESSAGES_PATH = '/messages';

/**
 * Nombres de los parámetros de filtro por fecha.
 * Spec §1.5 sugiere `date_from`; el `date_to` es una conjetura simétrica.
 * AJUSTABLE: corregir cuando el descubrimiento en vivo confirme el contrato.
 */
const PARAM_DATE_FROM = 'date_from';
const PARAM_DATE_TO = 'date_to';

/** Tamaño de página al paginar `/messages`. */
const PAGE_LIMIT = 100;

/** Tope duro de páginas para evitar bucles infinitos si la paginación cambia. */
const MAX_PAGES = 200;

/** Timeout por request HTTP (ms) — spec §9: cada fetcher con timeout 5s. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Tarifa estimada por mensaje en USD.
 * Default D2 del spec §10: Wapify NO expone USD; se estima `mensajes × 0.005`.
 * AJUSTABLE: cambiar acá si Isaac confirma la tarifa real de facturación Wapify.
 */
const USD_PER_MESSAGE = 0.005;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** `fetch` con timeout vía AbortController. */
async function fetchWithTimeout(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        'X-ACCESS-TOKEN': token,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrae el array de mensajes de un payload de respuesta sin asumir un único
 * shape. Wapify (y APIs similares) suelen envolver la lista en `data`,
 * `messages`, `items` o `results`; también puede venir como array crudo.
 */
function extractList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['data', 'messages', 'items', 'results', 'rows']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

/**
 * Determina si hay una página siguiente y devuelve el offset/page a usar.
 * Soporta los esquemas de paginación más comunes; si no reconoce ninguno,
 * asume "una sola página llena => seguir por offset" como fallback conservador.
 */
function nextPageParam(payload: unknown, currentPage: number, received: number): number | null {
  if (received < PAGE_LIMIT) return null; // página incompleta => fin
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // Esquemas explícitos: si la API dice que no hay más, respetarlo.
    if (obj.has_more === false || obj.hasMore === false) return null;
    if (obj.next_page === null || obj.next === null) return null;
    const meta = obj.meta as Record<string, unknown> | undefined;
    if (meta) {
      if (typeof meta.current_page === 'number' && typeof meta.last_page === 'number') {
        return meta.current_page >= meta.last_page ? null : meta.current_page + 1;
      }
    }
  }
  return currentPage + 1; // fallback: avanzar por página/offset
}

/** Construye una fila `provider_usage` vacía/cero para Wapify. */
function emptyRow(day: Date, raw: unknown): ProviderUsageRow {
  const iso = isoDay(day);
  return {
    provider: 'wapify',
    model: null,
    account_id: '1187373', // Account ID Wapify de GioLens (CLAUDE.md)
    period_start: iso,
    period_end: iso,
    messages_sent: 0,
    cost_usd: 0,
    raw_payload: raw,
  };
}

/* ── Fetcher ─────────────────────────────────────────────────────────────── */

/**
 * `fetchWapifyUsage` — cuenta los mensajes enviados en `day` y devuelve una
 * fila normalizada para `provider_usage`.
 *
 * Siempre devuelve exactamente un `ProviderUsageRow` en el array. Ante
 * cualquier fallo recuperable, devuelve `messages_sent: 0` con una nota en
 * `raw_payload` (no lanza), salvo la ausencia del token, que SÍ lanza por ser
 * un error de configuración del entorno.
 */
export const fetchWapifyUsage: ProviderFetcher = async (
  day: Date,
): Promise<ProviderUsageRow[]> => {
  const token = process.env.WAPIFY_TOKEN;
  if (!token) {
    // Error de configuración: el cron debe loggearlo en `agent_decisions`.
    throw new Error('WAPIFY_TOKEN no está definido en el entorno (process.env)');
  }

  const iso = isoDay(day);

  let totalMessages = 0;
  let pagesFetched = 0;
  let limitation: string | null = null;
  let lastPayloadSample: unknown = null;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const offset = (page - 1) * PAGE_LIMIT;
      const url =
        `${WAPIFY_BASE}${MESSAGES_PATH}` +
        `?limit=${PAGE_LIMIT}` +
        `&offset=${offset}` +
        `&page=${page}` +
        `&${PARAM_DATE_FROM}=${encodeURIComponent(iso)}` +
        `&${PARAM_DATE_TO}=${encodeURIComponent(iso)}`;

      const res = await fetchWithTimeout(url, token);

      if (!res.ok) {
        limitation =
          `Wapify ${MESSAGES_PATH} respondió HTTP ${res.status} ` +
          `en la página ${page}. messages_sent reportado como 0 (no se inventan datos).`;
        break;
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        limitation =
          `Wapify ${MESSAGES_PATH} devolvió un cuerpo no-JSON en la página ${page}. ` +
          `messages_sent reportado como 0.`;
        break;
      }

      if (page === 1) lastPayloadSample = payload;

      // Wapify devuelve HTTP 200 con {"error":{...}} cuando el endpoint no existe
      // (confirmado en el discovery C1.5 — ver cabecera del archivo).
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const e = (payload as { error?: { code?: unknown } }).error;
        limitation =
          `Wapify ${MESSAGES_PATH} devolvió un objeto de error (code ${e?.code}): ` +
          `el endpoint no existe. messages_sent = 0.`;
        break;
      }

      const list = extractList(payload);
      if (list === null) {
        limitation =
          `No se reconoció un array de mensajes en la respuesta de Wapify ` +
          `${MESSAGES_PATH} (claves esperadas: data/messages/items/results/rows). ` +
          `Revisar el shape real con el descubrimiento C1.5. messages_sent = 0.`;
        break;
      }

      totalMessages += list.length;
      pagesFetched = page;

      const next = nextPageParam(payload, page, list.length);
      if (next === null) break;

      if (page === MAX_PAGES) {
        limitation =
          `Se alcanzó el tope de ${MAX_PAGES} páginas sin fin de paginación; ` +
          `el conteo puede estar truncado. Revisar paginación real de Wapify.`;
      }
    }
  } catch (err) {
    // Error de red / timeout / abort: degradar con elegancia, no lanzar.
    limitation =
      `Fallo de red al consultar Wapify ${MESSAGES_PATH}: ` +
      `${err instanceof Error ? err.message : String(err)}. messages_sent = 0.`;
    return [
      {
        ...emptyRow(day, {
          source: 'wapify_api',
          endpoint: `${WAPIFY_BASE}${MESSAGES_PATH}`,
          day: iso,
          note: limitation,
          discovery_status:
            'C1.5 sin ejecutar — endpoint/paginación/filtro de fecha NO confirmados en vivo',
        }),
      },
    ];
  }

  // Si hubo limitación, devolver fila cero con la nota; no inventar datos.
  if (limitation) {
    return [
      {
        ...emptyRow(day, {
          source: 'wapify_api',
          endpoint: `${WAPIFY_BASE}${MESSAGES_PATH}`,
          day: iso,
          pages_fetched: pagesFetched,
          note: limitation,
          last_payload_sample: lastPayloadSample,
          discovery_status:
            'C1.5 sin ejecutar — endpoint/paginación/filtro de fecha NO confirmados en vivo',
        }),
      },
    ];
  }

  const costUsd = Number((totalMessages * USD_PER_MESSAGE).toFixed(4));

  return [
    {
      provider: 'wapify',
      model: null,
      account_id: '1187373',
      period_start: iso,
      period_end: iso,
      messages_sent: totalMessages,
      cost_usd: costUsd,
      raw_payload: {
        source: 'wapify_api',
        endpoint: `${WAPIFY_BASE}${MESSAGES_PATH}`,
        day: iso,
        messages_counted: totalMessages,
        pages_fetched: pagesFetched,
        cost_estimation: {
          method: 'messages_count * USD_PER_MESSAGE (spec §10 D2)',
          usd_per_message: USD_PER_MESSAGE,
          note: 'Estimación — Wapify no expone USD; tarifa ajustable.',
        },
        discovery_status:
          'C1.5 sin ejecutar — endpoint/paginación/filtro de fecha NO confirmados en vivo',
      },
    },
  ];
};

export default fetchWapifyUsage;
