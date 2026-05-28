/**
 * api/cron/refresh-clinica.ts — Frente I.2 · refresh matview cada 1 h
 *
 * Vercel cron: { path: "/api/cron/refresh-clinica", schedule: "0 * * * *" }
 * Auth: Bearer ${CRON_SECRET} (también acepta GET para invoke manual).
 *
 * Llama RPC refresh_mv_analitica_clinica() definida en migration 019.
 * Si la función no existe (Postgres '42883'), responde 503 sin exponer detalles.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

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

function setBaseHeaders(res: VercelLikeRes): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function checkBearer(req: VercelLikeReq): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  const authStr =
    typeof auth === 'string'
      ? auth
      : Array.isArray(auth)
        ? auth[0] ?? ''
        : '';
  return timingSafeBearer(authStr, secret);
}

function buildSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  setBaseHeaders(res);

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  if (!checkBearer(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const supa = buildSupabaseClient();
  if (!supa) {
    res.status(500).json({ ok: false, error: 'supabase_unavailable' });
    return;
  }

  const startedAt = Date.now();
  try {
    const { error } = await supa.rpc('refresh_mv_analitica_clinica');
    if (error) throw error;
    const durationMs = Date.now() - startedAt;
    res.status(200).json({
      ok: true,
      refreshed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    if (err?.code === '42883') {
      res.status(503).json({ ok: false, error: 'function_pending_migration_019' });
      return;
    }
    console.error('[cron/refresh-clinica]', err?.message ?? e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
