/**
 * GioLens — state (Supabase-backed kv + timeseries)
 * URL: /api/state
 *
 * Router por ?op=
 *   ?op=kv-get       → lee gl_kv          (GET  ?key=...&user_id=system)
 *   ?op=kv-set       → upsert gl_kv       (POST { key, value, user_id? })
 *   ?op=ts-append    → insert gl_timeseries (POST { bucket, payload, user_id? })
 *   ?op=ts-read      → select gl_timeseries (GET  ?bucket=...&limit=100&user_id=system)
 *
 * Auth: SUPABASE_SERVICE_ROLE_KEY (backend only — NO exponer al cliente).
 * Schema: ver agents/_shared/supabase-schema.sql
 *
 * Reemplaza localStorage como persistencia. Maestro v12 §07 alertaba:
 * "localStorage como persistencia — fragilidad crítica". Este endpoint cierra
 * esa deuda como parte de Fase 1 Sprint 1.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Buckets válidos según CHECK constraint del schema (sección 2)
const VALID_BUCKETS = [
  'webhook_event',
  'motor_run',
  'agent_run',
  'meta_kpi',
  'wapify_event',
  'cost_event',
  'eval_run',
  'audit',
];

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

async function handleKvGet(req, res) {
  const key = req.query?.key;
  const user_id = req.query?.user_id || 'system';
  if (!key) return res.status(400).json({ error: 'Missing key param' });

  const { data, error } = await getClient()
    .from('gl_kv')
    .select('value, updated_at, created_at')
    .eq('user_id', user_id)
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error('[state:kv-get]', error.message);
    return res.status(500).json({ error: error.message });
  }
  if (!data) {
    return res.status(200).json({ key, user_id, value: null, found: false });
  }
  return res.status(200).json({
    key,
    user_id,
    value: data.value,
    updated_at: data.updated_at,
    created_at: data.created_at,
    found: true,
  });
}

// ═══ op=kv-set ══════════════════════════════════════════════════════════════

async function handleKvSet(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'op=kv-set requiere POST' });
  }
  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: 'Body JSON inválido' });

  const { key, value, user_id = 'system' } = body;
  if (!key) return res.status(400).json({ error: 'Missing key in body' });
  if (value === undefined) {
    return res.status(400).json({ error: 'Missing value (puede ser null, [] o {}, pero no undefined)' });
  }

  // Llama la función Postgres kv_upsert (sobrecarga 2: user_id explícito)
  const { data, error } = await getClient().rpc('kv_upsert', {
    p_user_id: user_id,
    p_key: key,
    p_value: value,
  });

  if (error) {
    console.error('[state:kv-set]', error.message);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({
    ok: true,
    key,
    user_id,
    updated_at: data?.updated_at || null,
  });
}

// ═══ op=ts-append ═══════════════════════════════════════════════════════════

async function handleTsAppend(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'op=ts-append requiere POST' });
  }
  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: 'Body JSON inválido' });

  const { bucket, payload, user_id = 'system' } = body;
  if (!bucket) return res.status(400).json({ error: 'Missing bucket in body' });
  if (!VALID_BUCKETS.includes(bucket)) {
    return res.status(400).json({
      error: `bucket inválido: ${bucket}`,
      valid_buckets: VALID_BUCKETS,
    });
  }

  const { data, error } = await getClient()
    .from('gl_timeseries')
    .insert({ user_id, bucket, payload: payload || {} })
    .select('id, ts')
    .single();

  if (error) {
    console.error('[state:ts-append]', error.message);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, id: data.id, ts: data.ts, bucket, user_id });
}

// ═══ op=ts-read ═════════════════════════════════════════════════════════════

async function handleTsRead(req, res) {
  const bucket = req.query?.bucket;
  const user_id = req.query?.user_id || 'system';
  const limitRaw = parseInt(req.query?.limit || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  if (!bucket) return res.status(400).json({ error: 'Missing bucket param' });
  if (!VALID_BUCKETS.includes(bucket)) {
    return res.status(400).json({
      error: `bucket inválido: ${bucket}`,
      valid_buckets: VALID_BUCKETS,
    });
  }

  const { data, error } = await getClient()
    .from('gl_timeseries')
    .select('id, ts, payload')
    .eq('user_id', user_id)
    .eq('bucket', bucket)
    .order('ts', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[state:ts-read]', error.message);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({
    user_id,
    bucket,
    count: data.length,
    limit,
    rows: data,
  });
}

// ═══ Router principal ═══════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

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
        descripcion: 'Supabase-backed kv + timeseries (reemplaza localStorage)',
        operations: [
          { op: 'kv-get',    metodo: 'GET',  ejemplo: '?op=kv-get&key=ai_context&user_id=system' },
          { op: 'kv-set',    metodo: 'POST', body: '{ key, value, user_id? }' },
          { op: 'ts-append', metodo: 'POST', body: '{ bucket, payload, user_id? }' },
          { op: 'ts-read',   metodo: 'GET',  ejemplo: '?op=ts-read&bucket=motor_run&limit=50' },
        ],
        valid_buckets: VALID_BUCKETS,
        schema: 'agents/_shared/supabase-schema.sql',
      });
    }

    return res.status(400).json({
      error: 'Missing ?op= param',
      valid_ops: ['kv-get', 'kv-set', 'ts-append', 'ts-read'],
    });
  } catch (err) {
    console.error('[state]', err);
    return res.status(500).json({ error: err.message });
  }
}
