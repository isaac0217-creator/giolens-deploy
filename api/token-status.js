/**
 * GioLens — Token Status
 * URL: /api/token-status
 *
 * Expone fechas de expiración de tokens (NO los tokens mismos).
 * Usado por el dashboard para mostrar alertas de vencimiento.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const metaExpires   = process.env.META_TOKEN_EXPIRES   || null; // ej: "2026-07-01"
  const metaConfigured  = !!process.env.META_TOKEN;
  const wapifyConfigured = !!process.env.WAPIFY_TOKEN;

  let metaDaysLeft = null;
  if (metaExpires) {
    const exp = new Date(metaExpires);
    const now = new Date();
    metaDaysLeft = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
  }

  res.status(200).json({
    meta: {
      configured: metaConfigured,
      expires: metaExpires,
      daysLeft: metaDaysLeft,
    },
    wapify: {
      configured: wapifyConfigured,
    },
  });
}
