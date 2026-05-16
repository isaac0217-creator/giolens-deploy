/**
 * GioLens — Proxy Wapify (server-side, autenticado)
 * Solo acepta solicitudes desde el propio dominio del dashboard.
 * NUNCA exponer el WAPIFY_TOKEN al cliente.
 */
const TOKEN    = process.env.WAPIFY_TOKEN;
const API_BASE = 'https://ap.whapify.ai/api';

// Orígenes permitidos — dashboard en producción + localhost dev
const ALLOWED_ORIGINS = [
  'https://giolens-dashboard.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000',
];

// Rutas de Wapify permitidas (whitelist explícita)
const ALLOWED_PATH_PREFIXES = [
  'pipelines',
  'contacts',
  'opportunities',
  'funnels',
];

export default async function handler(req, res) {
  // Validar origen
  const origin = req.headers.origin || req.headers.referer || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));

  // En Vercel, las llamadas server-to-server no tienen origin — permitir si no hay header
  const isServerCall = !req.headers.origin && !req.headers.referer;

  if (!allowed && !isServerCall) {
    return res.status(403).json({ error: 'Acceso no autorizado' });
  }

  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.query.path || '';

  // Validar que la ruta sea permitida
  const pathAllowed = ALLOWED_PATH_PREFIXES.some(p => path.startsWith(p));
  if (!path || !pathAllowed) {
    return res.status(400).json({ error: `Ruta no permitida: ${path || '(vacía)'}` });
  }

  const queryParams = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `${API_BASE}/${path}${queryParams ? '?' + queryParams : ''}`;

  try {
    const response = await fetch(url, {
      headers: { 'X-ACCESS-TOKEN': TOKEN }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
