/**
 * GIOCORE Frente B — helper para actualizar env vars de un proyecto Vercel
 * via REST API (`api.vercel.com`). Usado por el cron `refresh-meta-token`
 * para persistir el token Meta renovado sin intervención humana.
 *
 * Spec: PROMPT_CODE_LOTE_v2.md §FRENTE B (T4).
 *
 * Endpoints Vercel:
 *   GET  /v9/projects/{projectId}/env?decrypt=false
 *        → lista env vars (sin valores), para encontrar el `id` del var existente.
 *   PATCH /v10/projects/{projectId}/env/{envId}
 *        → actualiza value de var existente.
 *   POST /v10/projects/{projectId}/env
 *        → crea var nuevo si no existía.
 *
 * Auth: header `Authorization: Bearer ${VERCEL_TOKEN}` (PAT con scope env:write).
 *
 * Seguridad:
 *   - El value entra por argumento, NUNCA se loggea ni se devuelve en el resultado.
 *   - El caller es responsable de pasar valores ya validados.
 *   - Si VERCEL_TOKEN o VERCEL_PROJECT_ID faltan → success=false, no se llama Vercel.
 */

const VERCEL_API_BASE = 'https://api.vercel.com';
const REQUEST_TIMEOUT_MS = 10_000;

export interface VercelEnvUpdateResult {
  success: boolean;
  action?: 'patched' | 'created';
  envId?: string;
  error?: string;
}

export interface VercelEnvConfig {
  token: string;
  projectId: string;
  /** Target environment(s). Default `['production']`. */
  target?: string[];
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

interface VercelEnvListEntry {
  id: string;
  key: string;
  target?: string[];
}

/**
 * Upsert idempotente de un env var en Vercel para los targets dados.
 *
 * Estrategia:
 *   1. GET de la lista (decrypt=false) para encontrar id por key+target.
 *   2. PATCH si existe; POST si no existe.
 *
 * El método NO escribe el `value` en logs ni lo devuelve. Solo metadata
 * (action / envId / error) para auditoría.
 */
export async function updateProductionEnvVar(
  name: string,
  value: string,
  config: VercelEnvConfig,
): Promise<VercelEnvUpdateResult> {
  const { token, projectId } = config;
  const target = config.target && config.target.length > 0 ? config.target : ['production'];

  if (!token) {
    return { success: false, error: 'VERCEL_TOKEN ausente' };
  }
  if (!projectId) {
    return { success: false, error: 'VERCEL_PROJECT_ID ausente' };
  }
  if (!value) {
    return { success: false, error: 'value vacío (refuso escribir env var vacío)' };
  }

  // 1 · Listar para encontrar id existente.
  let listRes: Response;
  try {
    listRes = await fetchWithTimeout(
      `${VERCEL_API_BASE}/v9/projects/${projectId}/env?decrypt=false`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `list fetch falló: ${msg}` };
  }
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => '');
    return { success: false, error: `list HTTP ${listRes.status}: ${body.slice(0, 160)}` };
  }

  let listBody: { envs?: VercelEnvListEntry[] };
  try {
    listBody = (await listRes.json()) as { envs?: VercelEnvListEntry[] };
  } catch {
    return { success: false, error: 'list body no JSON' };
  }

  const existing = (listBody.envs ?? []).find(
    (e) => e.key === name && (e.target ?? []).some((t) => target.includes(t)),
  );

  // 2 · PATCH si existe.
  if (existing) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${VERCEL_API_BASE}/v10/projects/${projectId}/env/${existing.id}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value, target }),
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `patch fetch falló: ${msg}`, envId: existing.id };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        success: false,
        error: `patch HTTP ${res.status}: ${body.slice(0, 160)}`,
        envId: existing.id,
      };
    }
    return { success: true, action: 'patched', envId: existing.id };
  }

  // 3 · POST si no existía.
  let res: Response;
  try {
    res = await fetchWithTimeout(`${VERCEL_API_BASE}/v10/projects/${projectId}/env`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: name, value, target, type: 'encrypted' }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `post fetch falló: ${msg}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { success: false, error: `post HTTP ${res.status}: ${body.slice(0, 160)}` };
  }
  return { success: true, action: 'created' };
}
