-- Migration: 031_citas_resumen_expediente.sql
-- Frente G · Rebanada "Resumen de conversación para el expediente" — persistir un
-- resumen breve de la conversación (qué busca el paciente, padecimiento/síntomas,
-- recomendación/tratamiento sugerido) que el bot emite como campo OPCIONAL `RESUMEN:`
-- en el tag de cita, para ir llenando el expediente desde la tarjeta de agenda.
--
-- Propósito: hoy `citas` guarda nombre/teléfono (mig 029) y contact_id (mig 030). Esta
-- columna añade el resumen clínico que el bot capturó de la conversación. ADITIVA: una
-- sola columna nueva, nullable, sin DEFAULT.
--   - resumen_expediente  TEXT  — INFORMACIÓN CLÍNICA SENSIBLE. Resumen breve emitido por
--                         el bot. Acceso restringido (trato igual o MÁS estricto que
--                         nombre/teléfono): NUNCA se devuelve por /api/citas (Bearer) ni
--                         se loguea; se expone ÚNICAMENTE por el BFF Origin-gated
--                         /api/citas-ui (no-store), para la recepcionista.
--
-- ADITIVA Y NO DESTRUCTIVA: columna nullable sin DEFAULT. Las citas existentes (y las
-- de otros orígenes) quedan con NULL (back-compat: la cadena sigue funcionando igual).
-- No toca columnas, índices, constraints ni triggers existentes.
--
-- PII / CLÍNICO — patrón de protección (igual que las columnas PII de migrations 029/030):
--   texto plano en tabla de acceso restringido (service_role backend). El repo NO cifra a
--   nivel columna. El resumen es información clínica sensible: se trata con el mismo (o
--   mayor) cuidado que nombre/teléfono y no se expone por ninguna ruta Bearer ni en logs.
--
-- PRE-CHECK (Cowork antes de aplicar): confirmar que la columna no exista ya con OTRO
-- tipo distinto de text. Se espera 0 filas:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='citas' AND column_name='resumen_expediente' AND data_type <> 'text';
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
--   ALTER TABLE citas DROP COLUMN IF EXISTS resumen_expediente;

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
    AND column_name = 'resumen_expediente'
    AND data_type <> 'text';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 031 abortada: citas.resumen_expediente preexistente con tipo != text (%). Resolver antes de aplicar (ver PRE-CHECK).', bad;
  END IF;
END $$;

ALTER TABLE citas ADD COLUMN IF NOT EXISTS resumen_expediente TEXT;

COMMENT ON COLUMN citas.resumen_expediente IS
  '031: información clínica sensible. Resumen breve de la conversación (qué busca el '
  'paciente, padecimiento/síntomas, recomendación/tratamiento) emitido por el bot en el '
  'tag (campo opcional RESUMEN:). Acceso restringido: solo backend service_role. NUNCA '
  'exponer vía /api/citas (Bearer) ni loguear; se expone solo vía el BFF /api/citas-ui.';

COMMIT;
