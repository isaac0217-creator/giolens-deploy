/**
 * GioLens — state (Supabase-backed kv + timeseries)
 * URL: /api/state
 * Observabilidad: Sentry wrap automático (errores + crash) vía withSentry.
 *
 * Router por ?op=
 *   ?op=kv-get       → lee app_config (GET ?key=...)
 *   ?op=kv-set       → upsert app_config (POST { key, value, updated_by? })
 *   ?op=ts-append    → insert audit_log (POST { action, payload, actor_id?, target_type?, target_id? })
 *   ?op=ts-read      → select audit_log (GET ?actor_id=...&limit=100)
 *
 * Auth: SUPABASE_SERVICE_ROLE_KEY (backend only — NO exponer al cliente).
 * Schema: agents/_shared/supabase-schema.sql (11 tablas Cowork · Sprint 1)
 *
 * Reemplaza localStorage como persistencia. Maestro v12 §07 alertaba:
 * "localStorage como persistencia — fragilidad crítica". Este endpoint cierra
 * esa deuda como parte de Fase 1 Sprint 1.
 *
 * Mapeo a tablas oficiales (esquema Cowork 18 may):
 *   - kv → app_config (key PK, value JSONB, updated_by, updated_at)
 *   - ts → audit_log (actor_type, actor_id, action, target_type, target_id,
 *                     payload JSONB, created_at)
 */

import { createClient } from '@supabase/supabase-js';
import { withSentry, captureException } from '../agents/_shared/sentry.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// actor_type válidos según convención del schema
const VALID_ACTOR_TYPES = ['human', 'agent', 'system'];

// Cliente Supabase reutilizado entre invocaciones (warm starts)
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configurados en Vercel env vars');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

function parseBody(req) {
  if (!req.body) return null;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body;
}

// ═══ op=kv-get ══════════════════════════════════════════════════════════════
// Lee de app_config (1 row por key)

async function handleKvGet(req, res) {
  const key = req.query?.key;
  if (!key) return res.status(400).json({ error: 'Missing key param' });

  const { data, error } = await getClient()
    .from('app_config')
    .select('value, updated_by, updated_at')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error('[state:kv-get]', error.message);
    captureException(error, { tags: { endpoint: 'state', op: 'kv-get' }, extras: { key } });
    return res.status(500).json({ error: error.message });
  }
  if (!data) {
    return res.status(200).json({ key, value: null, found: false });
  }
  return res.status(200).json({
    key,
    value: data.value,
    updated_by: data.updated_by,
    updated_at: data.updated_at,
    found: true,
  });
}

// ═══ op=kv-set ══════════════════════════════════════════════════════════════
// Upsert en app_config

async function handleKvSet(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'op=kv-set requiere POST' });
  }
  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: 'Body JSON inválido' });

  const { key, value, updated_by = 'state-api' } = body;
  if (!key) return res.status(400).json({ error: 'Missing key in body' });
  if (value === undefined) {
    return res.status(400).json({ error: 'Missing value (puede ser null, [] o {}, pero no undefined)' });
  }

  // Upsert nativo de Supabase (UPDATE si existe, INSERT si no)
  const { data, error } = await getClient()
    .from('app_config')
    .upsert(
      { key, value, updated_by, updated_at: new Date().toISOString() },
      { onConflict: 'key', returning: 'representation' }
    )
    .select('key, updated_at')
    .single();

  if (error) {
    console.error('[state:kv-set]', error.message);
    captureException(error, { tags: { endpoint: 'state', op: 'kv-set' }, extras: { key } });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({
    ok: true,
    key: data.key,
    updated_by,
    updated_at: data.updated_at,
  });
}

// ═══ op=ts-append ═══════════════════════════════════════════════════════════
// Insert en audit_log (timeseries-like)

async function handleTsAppend(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'op=ts-append requiere POST' });
  }
  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: 'Body JSON inválido' });

  const {
    action,
    payload,
    actor_type = 'system',
    actor_id = 'state-api',
    target_type = null,
    target_id = null,
  } = body;

  if (!action) return res.status(400).json({ error: 'Missing action in body' });
  if (!VALID_ACTOR_TYPES.includes(actor_type)) {
    return res.status(400).json({
      error: `actor_type inválido: ${actor_type}`,
      valid_actor_types: VALID_ACTOR_TYPES,
    });
  }

  const { data, error } = await getClient()
    .from('audit_log')
    .insert({ actor_type, actor_id, action, target_type, target_id, payload: payload || {} })
    .select('id, created_at')
    .single();

  if (error) {
    console.error('[state:ts-append]', error.message);
    captureException(error, { tags: { endpoint: 'state', op: 'ts-append', action: String(action || '') } });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({
    ok: true,
    id: data.id,
    created_at: data.created_at,
    action,
    actor_type,
    actor_id,
  });
}

// ═══ op=ts-read ═════════════════════════════════════════════════════════════
// Lee audit_log con filtros opcionales

async function handleTsRead(req, res) {
  const actor_id = req.query?.actor_id;
  const actor_type = req.query?.actor_type;
  const action = req.query?.action;
  const limitRaw = parseInt(req.query?.limit || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  let q = getClient()
    .from('audit_log')
    .select('id, actor_type, actor_id, action, target_type, target_id, payload, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (actor_id) q = q.eq('actor_id', actor_id);
  if (actor_type) {
    if (!VALID_ACTOR_TYPES.includes(actor_type)) {
      return res.status(400).json({
        error: `actor_type inválido: ${actor_type}`,
        valid_actor_types: VALID_ACTOR_TYPES,
      });
    }
    q = q.eq('actor_type', actor_type);
  }
  if (action) q = q.eq('action', action);

  const { data, error } = await q;

  if (error) {
    console.error('[state:ts-read]', error.message);
    captureException(error, { tags: { endpoint: 'state', op: 'ts-read' }, extras: { actor_id, actor_type, action, limit } });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({
    filters: { actor_id, actor_type, action },
    count: data.length,
    limit,
    rows: data,
  });
}

// ═══ Router principal ═══════════════════════════════════════════════════════

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // P0 fix (audit api/security 18 may PM tardío): endpoint usa SERVICE_ROLE_KEY
  // (bypass RLS), permite escribir app_config y leer audit_log. Sin auth, riesgo
  // de prompt poisoning + lectura PII. Cuando STATE_API_TOKEN se setea en env,
  // exige header `x-api-token` matcheando para rutas que mutan o exponen PII.
  // Si la env var no está, endpoint sigue abierto (activación gradual sin
  // breaking change para callers existentes).
  const expectedToken = process.env.STATE_API_TOKEN;
  if (expectedToken) {
    const op = String(req.query?.op || '').toLowerCase();
    const isMutation = req.method === 'POST' && (op === 'kv-set' || op === 'ts-append');
    const isPiiRead  = req.method === 'GET'  && op === 'ts-read';
    if ((isMutation || isPiiRead) && req.headers['x-api-token'] !== expectedToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const op = String(req.query?.op || '').toLowerCase();

  try {
    if (op === 'kv-get')    return await handleKvGet(req, res);
    if (op === 'kv-set')    return await handleKvSet(req, res);
    if (op === 'ts-append') return await handleTsAppend(req, res);
    if (op === 'ts-read')   return await handleTsRead(req, res);

    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'ok',
        endpoint: '/api/state',
        descripcion: 'Supabase-backed kv (app_config) + timeseries (audit_log)',
        operations: [
          { op: 'kv-get',    metodo: 'GET',  ejemplo: '?op=kv-get&key=ai_context' },
          { op: 'kv-set',    metodo: 'POST', body: '{ key, value, updated_by? }' },
          { op: 'ts-append', metodo: 'POST', body: '{ action, payload, actor_type?, actor_id?, target_type?, target_id? }' },
          { op: 'ts-read',   metodo: 'GET',  ejemplo: '?op=ts-read&actor_id=state-api&limit=50' },
        ],
        valid_actor_types: VALID_ACTOR_TYPES,
        backing_tables: { kv: 'app_config', ts: 'audit_log' },
        schema: 'agents/_shared/supabase-schema.sql',
      });
    }

    return res.status(400).json({
      error: 'Missing ?op= param',
      valid_ops: ['kv-get', 'kv-set', 'ts-append', 'ts-read'],
    });
  } catch (err) {
    console.error('[state]', err);
    captureException(err, { tags: { endpoint: 'state', op: String(req.query?.op || 'unknown'), component: 'router' } });
    return res.status(500).json({ error: err.message });
  }
}

// Wrap con Sentry (no-op silencioso si SENTRY_DSN no está seteado)
export default withSentry(handler, { endpoint: 'state' });
