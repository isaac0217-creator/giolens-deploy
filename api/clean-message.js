/**
 * GioLens — Clean Message
 * URL: /api/clean-message
 *
 * Recibe el output completo de GPT (Respuesta_ChatGPT) y
 * devuelve el texto limpio — sin el tag ##ESTADO:...## al final.
 *
 * Uso en Wapify: HTTP Action POST antes de "Enviar mensaje #1"
 * Body: { "text": "{{Respuesta_ChatGPT}}" }
 * Guardar respuesta en campo: mensaje_limpio
 */

export default function handler(req, res) {
  // Aceptar GET (test) y POST (Wapify)
  const text = req.method === 'POST'
    ? req.body?.text
    : req.query?.text;

  if (!text) {
    return res.status(400).json({ error: 'Missing text param' });
  }

  // Elimina TODOS los tags ##ESTADO:...## (no solo el del final).
  // Cuando GPT genera 2 respuestas concatenadas, el tag intermedio queda visible.
  const clean = text
    .replace(/\n?##ESTADO:[^#\n]+##[ \t]*/g, '')
    .trimEnd();

  return res.status(200).json({ clean });
}
