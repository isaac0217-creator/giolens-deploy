-- Migration: 030_citas_contact_id.sql
-- Frente G · Rebanada "arreglar enriquecimiento de la tarjeta de agenda" — persistir
-- el contact_id (raw) de las citas origen='whapify'.
--
-- Propósito: hoy `citas` sólo guarda `paciente_hash` = sha256(contact_id)[:16], que es
-- IRREVERSIBLE. Cuando el lookup CRM (Vía A) falla al agendar (típico en Messenger),
-- nombre/teléfono quedan NULL y NO hay forma de re-intentarlo: el contact_id se perdió.
-- Esta columna lo persiste para que un re-enriquecimiento posterior (best-effort, fuera
-- de la ruta síncrona del bot) pueda volver a consultar el CRM por contact_id.
--   - contact_id  TEXT  — PII-handle. Identificador del contacto en Whapify/Messenger.
--                         Acceso restringido (mismo trato que nombre/teléfono): NUNCA
--                         se devuelve por /api/citas (Bearer) ni por el BFF Origin-gated
--                         /api/citas-ui, ni se loguea.
--
-- ADITIVA Y NO DESTRUCTIVA: columna nullable sin DEFAULT. Las citas existentes (y las
-- de otros orígenes) quedan con NULL (back-compat: la cadena sigue funcionando igual).
-- No toca columnas, índices, constraints ni triggers existentes.
--
-- PII — patrón de protección (igual que `expedientes`, `contacts` y las columnas PII de
--   migration 029): texto plano en tabla de acceso restringido (service_role backend).
--   El repo NO cifra a nivel columna. contact_id es un handle a PII, no PII directa,
--   pero se trata con el mismo cuidado: no se expone por ninguna ruta del dashboard.
--
-- PRE-CHECK (Cowork antes de aplicar): confirmar que la columna no exista ya con OTRO
-- tipo distinto de text. Se espera 0 filas:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='citas' AND column_name='contact_id' AND data_type <> 'text';
--   -- 0 filas = OK (columna nueva, o ya existe como text → migration no-op).
--   -- >0 filas = ABORTAR: ya existe con tipo incompatible. La guarda DO-block de abajo
--   --   lo atrapa y aborta la tx automáticamente (no silencioso).
--
-- Idempotente (ADD COLUMN IF NOT EXISTS) y tx-safe (BEGIN/COMMIT).
-- Aplica Cowork a prod (patrón del proyecto: migrations a prod vía Supabase SQL Editor /
-- psql, NUNCA Code). DEBE aplicarse ANTES de mergear/deployar el PR: el INSERT de
-- /api/citas/from-whapify referencia esta columna por nombre.
--
-- ROLLBACK:
--   ALTER TABLE citas DROP COLUMN IF EXISTS contact_id;

BEGIN;

-- Auto-guarda (P1): si la columna YA existe con un tipo distinto de text, el
-- `ADD COLUMN IF NOT EXISTS` haría un no-op SILENCIOSO y el INSERT de from-whapify
-- fallaría en runtime. Abortamos antes con un mensaje accionable (la tx hace ROLLBACK).
-- Idempotente: si no existe, o existe como text, no hace nada.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT data_type INTO bad
  FROM information_schema.columns
  WHERE table_name = 'citas'
    AND column_name = 'contact_id'
    AND data_type <> 'text';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 030 abortada: citas.contact_id preexistente con tipo != text (%). Resolver antes de aplicar (ver PRE-CHECK).', bad;
  END IF;
END $$;

ALTER TABLE citas ADD COLUMN IF NOT EXISTS contact_id TEXT;

COMMENT ON COLUMN citas.contact_id IS
  '030: PII-handle. contact_id (raw) del contacto Whapify/Messenger, persistido para '
  're-enriquecer (Vía A, lookup CRM) las citas cuyo lookup falló al agendar. Acceso '
  'restringido: solo backend service_role. NUNCA exponer vía /api/citas (Bearer) ni '
  'vía el BFF /api/citas-ui, ni loguear.';

COMMIT;
