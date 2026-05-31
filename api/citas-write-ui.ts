/// <reference types="node" />
/**
 * GIOCORE Frente G · POST/PUT /api/citas-write-ui
 *
 * BFF de ESCRITURA para la "Agenda" del dashboard gen-1 (public/index.html).
 * Resuelve PARADA-1: el browser confirma/cancela/crea citas SIN Bearer.
 *
 * Por qué existe: /api/citas exige `Authorization: Bearer ${CRON_SECRET}` para
 * TODOS sus métodos (pensado para crons/scripts). La recepcionista no pega un
 * token a mano → las 3 escrituras del modal de agenda respondían 401. Este BFF
 * valida Origin/Referer (mismo patrón que el BFF de lectura /api/citas-ui) y
 * ejecuta la mutación con service role, SIN Bearer. /api/citas sigue intacto y
 * Bearer-gated para lo programático.
 *
 * Superficie MÍNIMA — exactamente 3 acciones, nada más amplio:
 *   - POST /api/citas-write-ui                              → crear cita
 *   - PUT  /api/citas-write-ui?id=N  {estado:'confirmada'}  → confirmar
 *   - PUT  /api/citas-write-ui?id=N  {estado:'cancelada'}   → cancelar
 *   Cualquier otro `estado` en PUT → 400. NINGÚN otro campo de update
 *   (notas/optometrista/expediente_id/gcal_event_id) es alcanzable desde el
 *   browser: el PUT propaga al núcleo ÚNICAMENTE `{ estado }`. No hay GET (la
 *   lectura es /api/citas-ui) ni DELETE.
 *
 * Lógica de negocio: COMPARTIDA con /api/citas vía citas-core.ts (sin duplicar).
 *
 * Seguridad:
 *   - Origin/Referer: giolens-dashboard*.vercel.app + localhost (reemplaza al
 *     Bearer para el browser; Origin es más débil que Bearer — riesgo residual
 *     documentado en el reporte: aceptable por ser red interna + no-store + el
 *     mismo modelo que /api/citas-ui de lectura ya en prod).
 *   - Cache-Control: no-store.
 *   - Errores genéricos heredados del núcleo (sin PII ni internals).
 */

import { createCita, updateCita } from '../agents/_shared/citas/citas-core.js';

interface VercelLikeReq {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

/* ── Origin/Referer guard (idéntico a /api/citas-ui) ──────────────────────── */

const ORIGIN_RE = /^https:\/\/giolens-dashboard(-[a-z0-9-]+)?\.vercel\.app(\/|$)|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const val = headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}

function isAllowedOrigin(req: VercelLikeReq): boolean {
  const origin = getHeader(req.headers, 'origin');
  const referer = getHeader(req.headers, 'referer');
  const source = origin || referer;
  if (!source) return false;
  return ORIGIN_RE.test(source);
}

function setBaseHeaders(res: VercelLikeRes, origin: string): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const allowOrigin = ORIGIN_RE.test(origin) ? origin : 'https://giolens-dashboard.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

/** Estados que el browser PUEDE fijar al CONFIRMAR/CANCELAR (PUT). */
const ESTADOS_WRITE = new Set(['confirmada', 'cancelada']);

/** Estados con los que el browser PUEDE CREAR una cita (POST). Una cita de la
 *  agenda nace 'agendada' (default) o 'confirmada' (walk-in confirmado al vuelo).
 *  'realizada'/'cancelada' como estado inicial NO son acciones de la agenda →
 *  se rechazan para mantener la superficie estrecha (no es ampliación del flujo:
 *  el form de "nueva cita" del dashboard no expone el campo `estado`). El
 *  endpoint Bearer /api/citas mantiene la superficie completa para programático. */
const ESTADOS_CREATE = new Set(['agendada', 'confirmada']);

/* ── Handler ──────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  const origin = getHeader(req.headers, 'origin');
  setBaseHeaders(res, origin);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const method = req.method ?? 'GET';
  if (method !== 'POST' && method !== 'PUT') {
    res.setHeader?.('Allow', 'POST, PUT, OPTIONS');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Origin/Referer guard (reemplaza al Bearer para el browser del dashboard).
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ ok: false, error: 'origin_forbidden' });
    return;
  }

  try {
    if (method === 'POST') {
      // Crear cita — delega al núcleo (misma validación/efectos que /api/citas),
      // pero con la superficie de `estado` inicial estrechada a la agenda.
      const estadoInicial = (req.body as { estado?: unknown } | undefined)?.estado;
      if (estadoInicial !== undefined && (typeof estadoInicial !== 'string' || !ESTADOS_CREATE.has(estadoInicial))) {
        res.status(400).json({
          ok: false,
          error: 'accion_no_permitida',
          detail: "estado inicial debe ser 'agendada' o 'confirmada'",
        });
        return;
      }
      const { status, body } = await createCita(req.body);
      res.status(status).json(body);
      return;
    }

    // PUT — confirmar / cancelar. Superficie estrecha:
    //   1) sólo se acepta estado ∈ {confirmada, cancelada}.
    //   2) sólo se propaga `estado` al núcleo (ningún otro campo de update).
    const idRaw = req.query?.id ?? (req.body as { id?: unknown } | undefined)?.id;
    const estado = (req.body as { estado?: unknown } | undefined)?.estado;

    if (typeof estado !== 'string' || !ESTADOS_WRITE.has(estado)) {
      res.status(400).json({
        ok: false,
        error: 'accion_no_permitida',
        detail: "estado debe ser 'confirmada' o 'cancelada'",
      });
      return;
    }

    const { status, body } = await updateCita(idRaw, { estado });
    res.status(status).json(body);
  } catch (e) {
    console.error('[api/citas-write-ui]', e instanceof Error ? e.message : String(e));
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
