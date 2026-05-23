/// <reference types="node" />
/**
 * GIOCORE Frente D — POST /api/expediente
 *
 * Spec: BRIEF_CODE_FRENTE_D_CAPTURA_EXPEDIENTES.md
 *
 * Endpoint público (open POST) usado por `public/expediente-form.html` desde
 * iPads dedicados al punto de captura. Sin auth Bearer en MVP — la protección
 * es por origen + rate-limit Vercel + form rendering controlado.
 *
 * Flujo:
 *   1. Validar payload (shape + rangos clínicos).
 *   2. Lookup contact_id por teléfono normalizado (E.164 mexicano).
 *   3. INSERT en `expedientes` (con `raw_form_data` JSONB como backup).
 *   4. Generar `.md` Obsidian (función PURA) y persistir `vault_md_content`.
 *   5. Devolver `{id, vault_md_path}` con Cache-Control no-store.
 *
 * Seguridad:
 *   - Cache-Control: no-store (PII en payload).
 *   - CORS: solo origen prod (`giolens-dashboard.vercel.app`) — preview/dev allowlisted.
 *   - Response NO incluye PII innecesaria (solo id + path).
 */

import { createClient } from '@supabase/supabase-js';
import {
  generateObsidianMd,
  type ExpedienteInput,
} from '../agents/_shared/providers/obsidian-writer.js';

/* ── Tipos handler ──────────────────────────────────────────────────────── */

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

/* ── Helpers ────────────────────────────────────────────────────────────── */

const ALLOWED_ORIGINS = new Set<string>([
  'https://giolens-dashboard.vercel.app',
  // permitir preview deploys del mismo proyecto (subdominio variable)
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Normaliza teléfono MX a `+52XXXXXXXXXX` (10 dígitos sin 1 después del +52).
 *  Acepta entradas: `+5216631180788`, `6631180788`, `+1 663 118 0788`, etc. */
export function normalizeMxPhone(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Si ya viene con prefijo, mantener (cubre +1 USA del Bloque 7 enriquecidos).
  if (digits.startsWith('52') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('521') && digits.length === 13) return `+${digits}`;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  // 10 dígitos crudos → asumir MX
  if (digits.length === 10) return `+52${digits}`;
  return `+${digits}`;
}

/* ── Validación payload ─────────────────────────────────────────────────── */

type ValidationOk = { ok: true; payload: ExpedientePayload };
type ValidationErr = { ok: false; error: string };
type ValidationResult = ValidationOk | ValidationErr;

interface ExpedientePayload {
  paciente_nombre: string;
  paciente_telefono?: string | null;
  paciente_email?: string | null;
  fecha_examen?: string | null;
  optometrista?: string | null;
  od_esfera?: number | null;
  od_cilindro?: number | null;
  od_eje?: number | null;
  od_adicion?: number | null;
  oi_esfera?: number | null;
  oi_cilindro?: number | null;
  oi_eje?: number | null;
  oi_adicion?: number | null;
  distancia_interpupilar?: number | null;
  agudeza_visual_od?: string | null;
  agudeza_visual_oi?: string | null;
  antecedentes?: string | null;
  observaciones?: string | null;
  productos_recomendados?: string[] | null;
  firma_data_url?: string | null;
  capturado_por: string;
}

function pickNum(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function pickStr(v: unknown, maxLen = 5000): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function validatePayload(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'body debe ser objeto JSON' };
  }
  const r = input as Record<string, unknown>;

  const nombre = pickStr(r.paciente_nombre, 200);
  if (!nombre) return { ok: false, error: 'paciente_nombre requerido' };

  const capturadoPor = pickStr(r.capturado_por, 100);
  if (!capturadoPor) return { ok: false, error: 'capturado_por requerido' };

  // fecha_examen: ISO yyyy-mm-dd, no más de 30 días en futuro, no antes de 1990
  let fecha = pickStr(r.fecha_examen, 10);
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return { ok: false, error: 'fecha_examen debe ser YYYY-MM-DD' };
  }
  if (fecha) {
    const d = new Date(fecha);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'fecha_examen inválida' };
    const maxFuture = Date.now() + 30 * 86400_000;
    if (d.getTime() > maxFuture) return { ok: false, error: 'fecha_examen demasiado en el futuro' };
    if (d.getFullYear() < 1990) return { ok: false, error: 'fecha_examen demasiado antigua' };
  }
  if (!fecha) fecha = new Date().toISOString().slice(0, 10);

  const productos = Array.isArray(r.productos_recomendados)
    ? (r.productos_recomendados as unknown[])
        .map((p) => pickStr(p, 200))
        .filter((p): p is string => p !== null)
    : null;

  const payload: ExpedientePayload = {
    paciente_nombre: nombre,
    paciente_telefono: pickStr(r.paciente_telefono, 30),
    paciente_email: pickStr(r.paciente_email, 200),
    fecha_examen: fecha,
    optometrista: pickStr(r.optometrista, 100),
    od_esfera: pickNum(r.od_esfera, -25, 25),
    od_cilindro: pickNum(r.od_cilindro, -12, 12),
    od_eje: pickNum(r.od_eje, 0, 180),
    od_adicion: pickNum(r.od_adicion, 0, 5),
    oi_esfera: pickNum(r.oi_esfera, -25, 25),
    oi_cilindro: pickNum(r.oi_cilindro, -12, 12),
    oi_eje: pickNum(r.oi_eje, 0, 180),
    oi_adicion: pickNum(r.oi_adicion, 0, 5),
    distancia_interpupilar: pickNum(r.distancia_interpupilar, 40, 90),
    agudeza_visual_od: pickStr(r.agudeza_visual_od, 20),
    agudeza_visual_oi: pickStr(r.agudeza_visual_oi, 20),
    antecedentes: pickStr(r.antecedentes, 5000),
    observaciones: pickStr(r.observaciones, 5000),
    productos_recomendados: productos && productos.length > 0 ? productos : null,
    firma_data_url: pickStr(r.firma_data_url, 200_000),
    capturado_por: capturadoPor,
  };

  return { ok: true, payload };
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  setBaseHeaders(res, origin);

  // 1 · CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  // 2 · Validate payload
  const validation = validatePayload(req.body);
  if (!validation.ok) {
    res.status(400).json({ ok: false, error: validation.error });
    return;
  }
  const payload = validation.payload;

  // 3 · Supabase client
  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/expediente] buildSupabaseClient:', msg);
    res.status(500).json({ ok: false, error: 'service unavailable' });
    return;
  }

  // 4 · Lookup contact_id por teléfono normalizado.
  let contactId: string | null = null;
  const phoneNorm = normalizeMxPhone(payload.paciente_telefono);
  if (phoneNorm) {
    const { data: contactRow } = await supabase
      .from('contacts')
      .select('contact_id')
      .eq('phone', phoneNorm)
      .not('contact_id', 'is', null)
      .limit(1)
      .maybeSingle();
    contactId = (contactRow as { contact_id?: string } | null)?.contact_id ?? null;
  }

  // 5 · INSERT expediente (without vault_md_* todavía).
  const insertRow = {
    contact_id: contactId,
    paciente_nombre: payload.paciente_nombre,
    paciente_telefono: phoneNorm,
    paciente_email: payload.paciente_email,
    fecha_examen: payload.fecha_examen,
    optometrista: payload.optometrista,
    od_esfera: payload.od_esfera,
    od_cilindro: payload.od_cilindro,
    od_eje: payload.od_eje,
    od_adicion: payload.od_adicion,
    oi_esfera: payload.oi_esfera,
    oi_cilindro: payload.oi_cilindro,
    oi_eje: payload.oi_eje,
    oi_adicion: payload.oi_adicion,
    distancia_interpupilar: payload.distancia_interpupilar,
    agudeza_visual_od: payload.agudeza_visual_od,
    agudeza_visual_oi: payload.agudeza_visual_oi,
    antecedentes: payload.antecedentes,
    observaciones: payload.observaciones,
    productos_recomendados: payload.productos_recomendados,
    firma_data_url: payload.firma_data_url,
    capturado_por: payload.capturado_por,
    capturado_desde: 'web_form_ipad',
    raw_form_data: req.body ?? null,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('expedientes')
    .insert(insertRow)
    .select('id, fecha_examen, created_at')
    .single();

  if (insertErr || !inserted) {
    console.error('[api/expediente] insert fallo:', insertErr?.message);
    res.status(500).json({ ok: false, error: insertErr?.message ?? 'insert failed' });
    return;
  }

  const expId = (inserted as { id: number }).id;
  const createdAt = (inserted as { created_at?: string }).created_at ?? null;

  // 6 · Generar `.md` Obsidian (pura). Si falla, log a agent_decisions pero
  //     NO bloquea la respuesta (el row ya está en DB con raw_form_data).
  let vaultMdPath: string | null = null;
  try {
    const md = generateObsidianMd({
      id: expId,
      contact_id: contactId,
      paciente_nombre: payload.paciente_nombre,
      paciente_telefono: phoneNorm,
      paciente_email: payload.paciente_email,
      fecha_examen: payload.fecha_examen as string,
      optometrista: payload.optometrista,
      od_esfera: payload.od_esfera,
      od_cilindro: payload.od_cilindro,
      od_eje: payload.od_eje,
      od_adicion: payload.od_adicion,
      oi_esfera: payload.oi_esfera,
      oi_cilindro: payload.oi_cilindro,
      oi_eje: payload.oi_eje,
      oi_adicion: payload.oi_adicion,
      distancia_interpupilar: payload.distancia_interpupilar,
      agudeza_visual_od: payload.agudeza_visual_od,
      agudeza_visual_oi: payload.agudeza_visual_oi,
      antecedentes: payload.antecedentes,
      observaciones: payload.observaciones,
      productos_recomendados: payload.productos_recomendados,
      capturado_por: payload.capturado_por,
      capturado_desde: 'web_form_ipad',
      created_at: createdAt,
    });
    vaultMdPath = md.path;
    const { error: updErr } = await supabase
      .from('expedientes')
      .update({ vault_md_path: md.path, vault_md_content: md.content })
      .eq('id', expId);
    if (updErr) {
      console.error('[api/expediente] vault_md update fallo:', updErr.message);
      // Best-effort log a agent_decisions (no bloquea respuesta)
      await supabase
        .from('agent_decisions')
        .insert({
          agent_name: 'api_expediente',
          decision_type: 'obsidian_write_pending',
          proposed_action: { expediente_id: expId, error: updErr.message },
          justification: 'INSERT OK pero UPDATE de vault_md_content falló; raw_form_data ya persisten.',
          severity: 0.3,
          status: 'pending',
        })
        .then(() => undefined);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/expediente] generateObsidianMd lanzó:', msg);
    await supabase
      .from('agent_decisions')
      .insert({
        agent_name: 'api_expediente',
        decision_type: 'obsidian_write_failed',
        proposed_action: { expediente_id: expId, error: msg },
        justification: 'Expediente persistido en DB pero .md NO generado; raw_form_data disponible para reproceso.',
        severity: 0.3,
        status: 'pending',
      })
      .then(() => undefined);
  }

  res.status(201).json({
    ok: true,
    id: expId,
    vault_md_path: vaultMdPath,
    contact_id: contactId,
    fecha_examen: payload.fecha_examen,
  });
}
