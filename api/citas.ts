/**
 * api/citas.ts — Frente G · BFF citas + Calendar Sync (Bearer-gated)
 *
 * Rutas:
 *   POST /api/citas        — crear cita + GCal event + Wapify si confirmada
 *   GET  /api/citas        — listar paginado sin PII
 *   PUT  /api/citas        — actualizar estado (?id=N en query o en body)
 *
 * Auth: exige `Authorization: Bearer ${CRON_SECRET}` para TODOS los métodos
 *   (cron / scripts / programático). El browser del dashboard NO usa este
 *   endpoint para mutar: usa el BFF Origin-gated /api/citas-write-ui (sin
 *   Bearer). Ambos comparten la MISMA lógica de negocio vía
 *   agents/_shared/citas/citas-core.ts (sin duplicar). checkBearer NO cambia.
 *
 * Reglas PII / GCal / Wapify: documentadas y aplicadas en citas-core.ts.
 */

import { createCita, updateCita, listCitas } from '../agents/_shared/citas/citas-core.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VercelLikeReq {
  url?: string;
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

// ---------------------------------------------------------------------------
// Auth & CORS Constants
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set<string>([
  'https://giolens-dashboard.vercel.app',
]);

/** Regex que matchea solo deployments del proyecto giolens-dashboard.
 *  Cubre prod (`giolens-dashboard.vercel.app`), preview branches
 *  (`giolens-dashboard-git-{branch}-{team}.vercel.app`), y deploys instantáneos
 *  (`giolens-dashboard-{hash}-{team}.vercel.app`). NO matchea proyectos
 *  terceros en *.vercel.app. */
const PROJECT_VERCEL_RE = /^https:\/\/giolens-dashboard(-[a-z0-9-]+){0,3}\.vercel\.app$/;

function setBaseHeaders(res: VercelLikeRes, origin: string | undefined): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const allowOrigin =
    origin && (ALLOWED_ORIGINS.has(origin) || PROJECT_VERCEL_RE.test(origin))
      ? origin
      : 'https://giolens-dashboard.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

/** Verifica Authorization: Bearer {CRON_SECRET}.
 *  Devuelve true si es válido, false si no (el caller debe enviar 401). */
function checkBearer(req: VercelLikeReq): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = typeof req.headers.authorization === 'string'
    ? req.headers.authorization
    : Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0] ?? ''
      : '';
  return auth === `Bearer ${secret}`;
}

// ---------------------------------------------------------------------------
// Handlers — wrappers finos sobre citas-core (req/res ↔ { status, body })
// ---------------------------------------------------------------------------

async function handleGet(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const { status, body } = await listCitas((req.query ?? {}) as Record<string, string | string[] | undefined>);
  res.status(status).json(body);
}

async function handlePost(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const { status, body } = await createCita(req.body);
  res.status(status).json(body);
}

async function handlePut(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const idRaw = req.query?.id ?? (req.body as { id?: unknown } | undefined)?.id;
  const { status, body } = await updateCita(idRaw, req.body);
  res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// Router principal
// ---------------------------------------------------------------------------

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes
): Promise<void> {
  setBaseHeaders(res, req.headers.origin as string | undefined);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!checkBearer(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  switch (req.method) {
    case 'GET':
      await handleGet(req, res);
      break;
    case 'POST':
      await handlePost(req, res);
      break;
    case 'PUT':
      await handlePut(req, res);
      break;
    default:
      res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
}
