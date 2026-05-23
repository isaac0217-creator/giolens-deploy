/**
 * GIOCORE Frente D — Generador de `.md` Obsidian para expedientes clínicos.
 *
 * Spec: BRIEF_CODE_FRENTE_D_CAPTURA_EXPEDIENTES.md
 *
 * IMPORTANTE: función PURA (sin fs). El brief asume `fs.writeFile` a
 * `~/Documents/Claude/OBSIDIAN/GIOCORE/...`, pero el handler corre en
 * Vercel serverless (sin filesystem persistente ni $HOME mapped). Ajuste
 * pragmático:
 *   1. `generateObsidianMd()` devuelve `{ path, content, frontmatter }`.
 *   2. El handler persiste `content` en `expedientes.vault_md_content` y `path`
 *      en `vault_md_path`.
 *   3. Un script local Isaac (post-MVP) lee filas con `vault_synced_at IS NULL`
 *      y escribe al vault físico.
 *
 * Reglas NOM-024 (privacidad):
 *   ❌ NO incluir PII (nombre, teléfono, email) en frontmatter.
 *   ✅ Frontmatter solo metadata (id, fechas, optometrista, contact_id hash).
 *   ✅ PII vive en body markdown (humano lee, no scrappable por dataview).
 *   ❌ Frontmatter sin nulls/undefined (regla "campos llenados solamente").
 */

import { createHash } from 'crypto';

export interface ExpedienteInput {
  id: number | string;
  contact_id?: string | null;
  paciente_nombre: string;
  paciente_telefono?: string | null;
  paciente_email?: string | null;
  fecha_examen: string; // ISO date YYYY-MM-DD
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
  capturado_por: string;
  capturado_desde?: string | null;
  created_at?: string | null;
}

export interface ObsidianMdResult {
  /** Path relativo al vault (absoluto al construir con VAULT_ROOT en el sync local). */
  path: string;
  /** Contenido completo del `.md` con frontmatter YAML + body markdown. */
  content: string;
  /** Frontmatter parseado (sin PII, para debug/testing). */
  frontmatter: Record<string, unknown>;
}

/** Hash determinístico del teléfono normalizado para path de carpeta paciente.
 *  Solo primeros 16 chars del sha256 → carpeta `MX-{16hex}/`. Si no hay
 *  teléfono, devuelve null (caller usa fallback `Sin-Contacto/`). */
export function patientFolderHash(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const normalized = phone.replace(/[^\d+]/g, '');
  if (!normalized) return null;
  const h = createHash('sha256').update(normalized).digest('hex');
  return h.slice(0, 16);
}

/** Slugifica un nombre para usar en filename. ASCII safe. */
export function slugify(name: string): string {
  if (!name) return 'sin-nombre';
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // remove diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'sin-nombre'
  );
}

/** YAML escape conservador para valores string (sin multiline). */
function yamlEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // Si contiene caracteres especiales o empieza con dígito-like, quote it.
  if (/[:#{}\[\],&*!|>'"%@`\n]/.test(s) || /^[\d\s-]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Construye un bloque de frontmatter YAML omitiendo nulls/undefined/strings vacíos. */
function buildFrontmatter(meta: Record<string, unknown>): { yaml: string; obj: Record<string, unknown> } {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    filtered[k] = v;
  }
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(filtered)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlEscape(item)}`);
    } else {
      lines.push(`${k}: ${yamlEscape(v)}`);
    }
  }
  lines.push('---', '');
  return { yaml: lines.join('\n'), obj: filtered };
}

/** Construye el body markdown con PII (legible por humano, NO scrappable por dataview). */
function buildBody(exp: ExpedienteInput): string {
  const sections: string[] = [];

  // Header con nombre (visible en file picker Obsidian)
  sections.push(`# ${exp.paciente_nombre}`);
  sections.push('');

  // Datos contacto (PII)
  const contacto: string[] = [];
  if (exp.paciente_telefono) contacto.push(`- **Teléfono:** ${exp.paciente_telefono}`);
  if (exp.paciente_email) contacto.push(`- **Email:** ${exp.paciente_email}`);
  if (contacto.length > 0) {
    sections.push('## Contacto');
    sections.push(...contacto, '');
  }

  // Examen
  sections.push('## Examen');
  sections.push(`- **Fecha:** ${exp.fecha_examen}`);
  if (exp.optometrista) sections.push(`- **Optometrista:** ${exp.optometrista}`);
  if (exp.capturado_por) sections.push(`- **Capturado por:** ${exp.capturado_por}`);
  sections.push('');

  // Graduación tabla
  const hasOd =
    exp.od_esfera != null || exp.od_cilindro != null || exp.od_eje != null || exp.od_adicion != null;
  const hasOi =
    exp.oi_esfera != null || exp.oi_cilindro != null || exp.oi_eje != null || exp.oi_adicion != null;

  if (hasOd || hasOi) {
    sections.push('## Graduación');
    sections.push('');
    sections.push('| Ojo | Esfera | Cilindro | Eje | Adición |');
    sections.push('|---|---|---|---|---|');
    const fmt = (v: number | null | undefined) => (v == null ? '—' : String(v));
    sections.push(
      `| OD | ${fmt(exp.od_esfera)} | ${fmt(exp.od_cilindro)} | ${fmt(exp.od_eje)} | ${fmt(exp.od_adicion)} |`,
    );
    sections.push(
      `| OI | ${fmt(exp.oi_esfera)} | ${fmt(exp.oi_cilindro)} | ${fmt(exp.oi_eje)} | ${fmt(exp.oi_adicion)} |`,
    );
    sections.push('');
  }

  if (exp.distancia_interpupilar != null) {
    sections.push(`- **DIP:** ${exp.distancia_interpupilar} mm`);
    sections.push('');
  }

  if (exp.agudeza_visual_od || exp.agudeza_visual_oi) {
    sections.push('## Agudeza visual');
    if (exp.agudeza_visual_od) sections.push(`- **OD:** ${exp.agudeza_visual_od}`);
    if (exp.agudeza_visual_oi) sections.push(`- **OI:** ${exp.agudeza_visual_oi}`);
    sections.push('');
  }

  if (exp.antecedentes) {
    sections.push('## Antecedentes');
    sections.push(exp.antecedentes, '');
  }

  if (exp.observaciones) {
    sections.push('## Observaciones');
    sections.push(exp.observaciones, '');
  }

  if (exp.productos_recomendados && exp.productos_recomendados.length > 0) {
    sections.push('## Productos recomendados');
    for (const p of exp.productos_recomendados) sections.push(`- ${p}`);
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Genera el `.md` Obsidian para un expediente. PURA: no fs, no DB.
 *
 * Returns:
 *   - `path` relativo al vault Obsidian (`Contactos/MX-{hash}/expedientes/{fecha}_{slug}.md`).
 *   - `content` markdown completo (frontmatter + body).
 *   - `frontmatter` objeto parseado (sin PII).
 */
export function generateObsidianMd(exp: ExpedienteInput): ObsidianMdResult {
  const folderHash = patientFolderHash(exp.paciente_telefono);
  const folder = folderHash ? `Contactos/MX-${folderHash}` : 'Contactos/Sin-Contacto';
  const fileSlug = `${exp.fecha_examen}_${slugify(exp.paciente_nombre)}_${exp.id}`;
  const path = `${folder}/expedientes/${fileSlug}.md`;

  // Frontmatter: solo metadata, sin PII.
  const meta: Record<string, unknown> = {
    expediente_id: exp.id,
    fecha_examen: exp.fecha_examen,
    optometrista: exp.optometrista ?? null,
    folder_hash: folderHash, // hash del teléfono — no es PII reversible
    contact_id_hash: exp.contact_id ? exp.contact_id.slice(-4) : null, // last 4 chars solo
    capturado_desde: exp.capturado_desde ?? 'web_form_ipad',
    has_graduacion:
      exp.od_esfera != null || exp.oi_esfera != null ? true : null,
    productos_count:
      exp.productos_recomendados && exp.productos_recomendados.length > 0
        ? exp.productos_recomendados.length
        : null,
    created_at: exp.created_at ?? null,
    tags: ['expediente', 'clinica'],
  };

  const { yaml, obj: frontmatter } = buildFrontmatter(meta);
  const body = buildBody(exp);
  const content = `${yaml}${body}`;

  return { path, content, frontmatter };
}
