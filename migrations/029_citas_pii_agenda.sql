-- Migration: 029_citas_pii_agenda.sql
-- Frente G · Rebanada "enriquecer tarjeta de agenda" — Nombre + Teléfono + Producto/Motivo.
--
-- Propósito: la tarjeta de "Agenda · Citas del día" (public/index.html) hoy solo
-- muestra hora + tipo + estado + paciente_hash. Esta migration agrega 3 columnas
-- NULLABLE a `citas` para que el BFF de lectura (/api/citas-ui) pueda enriquecerla:
--   - nombre_paciente    TEXT  — PII. Snapshot al momento de agendar, leído del CRM
--                                de Whapify por contact_id (GET /api/contacts/{id}).
--   - telefono_paciente  TEXT  — PII. Misma fuente que nombre.
--   - producto_motivo    TEXT  — NO PII. Producto/lente o padecimiento que el paciente
--                                mencionó en la conversación (tag extendido PROD: del
--                                bot). VACÍO si no lo mencionó (nunca se inventa).
--
-- ADITIVA Y NO DESTRUCTIVA: las 3 columnas son nullable sin DEFAULT. Las citas
-- existentes quedan con NULL en las 3 (back-compat: la tarjeta omite esas líneas).
-- No toca columnas, índices, constraints ni triggers existentes.
--
-- PII — patrón de protección (igual que `expedientes` y `contacts`):
--   nombre/teléfono se guardan en TEXTO PLANO en una tabla de acceso restringido
--   (service_role para escritura/lectura backend; el browser SOLO los ve vía el BFF
--   Origin-gated /api/citas-ui, jamás vía /api/citas Bearer-gated ni en logs). El
--   repo NO tiene patrón de cifrado a nivel columna (el único AES es para backups B2
--   en agents/_shared/providers/backup-monthly.ts, no para columnas vivas), así que
--   el patrón aplicado es ACCESO RESTRINGIDO, consistente con expedientes.paciente_*.
--   producto_motivo NO es PII.
--
-- PRE-CHECK (Cowork antes de aplicar): confirmar que las columnas no existan ya con
-- OTRO tipo distinto de text. Se espera 0 filas:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='citas'
--     AND column_name IN ('nombre_paciente','telefono_paciente','producto_motivo')
--     AND data_type <> 'text';
--   -- 0 filas = OK (columnas nuevas, o ya existen como text → migration no-op).
--   -- >0 filas = ABORTAR: una columna ya existe con tipo incompatible. La guarda
--   --   DO-block de abajo lo atrapa y aborta la tx automáticamente (no silencioso).
--
-- Idempotente (ADD COLUMN IF NOT EXISTS) y tx-safe (BEGIN/COMMIT).
-- Aplica Cowork a prod (patrón del proyecto: migrations a prod vía Supabase SQL
-- Editor / psql, NUNCA Code). DEBE aplicarse ANTES de mergear/deployar el PR:
-- el INSERT de /api/citas/from-whapify y el SELECT de /api/citas-ui referencian
-- estas columnas por nombre.
--
-- ROLLBACK:
--   ALTER TABLE citas DROP COLUMN IF EXISTS producto_motivo;
--   ALTER TABLE citas DROP COLUMN IF EXISTS telefono_paciente;
--   ALTER TABLE citas DROP COLUMN IF EXISTS nombre_paciente;

BEGIN;

-- Auto-guarda (P1): si alguna de las 3 columnas YA existe con un tipo distinto de
-- text, el `ADD COLUMN IF NOT EXISTS` haría un no-op SILENCIOSO y el código (INSERT
-- de from-whapify / SELECT de citas-ui) fallaría en runtime. Abortamos antes con un
-- mensaje accionable (la tx hace ROLLBACK). Convierte el PRE-CHECK manual en una
-- salvaguarda ejecutable. Idempotente: si no existen, o existen como text, no hace nada.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(column_name || ' (' || data_type || ')', ', ')
    INTO bad
  FROM information_schema.columns
  WHERE table_name = 'citas'
    AND column_name IN ('nombre_paciente', 'telefono_paciente', 'producto_motivo')
    AND data_type <> 'text';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 029 abortada: columna(s) preexistente(s) con tipo != text: %. Resolver antes de aplicar (ver PRE-CHECK).', bad;
  END IF;
END $$;

ALTER TABLE citas ADD COLUMN IF NOT EXISTS nombre_paciente   TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS telefono_paciente TEXT;
ALTER TABLE citas ADD COLUMN IF NOT EXISTS producto_motivo   TEXT;

COMMENT ON COLUMN citas.nombre_paciente IS
  '029: PII. Nombre del paciente, snapshot al agendar leído del CRM Whapify por '
  'contact_id (best-effort; NULL si el lookup falla o no es origen whapify). '
  'Acceso restringido: solo backend service_role + BFF Origin-gated /api/citas-ui. '
  'NUNCA exponer vía /api/citas (Bearer) ni loguear.';

COMMENT ON COLUMN citas.telefono_paciente IS
  '029: PII. Teléfono del paciente, misma fuente y protección que nombre_paciente.';

COMMENT ON COLUMN citas.producto_motivo IS
  '029: NO PII. Producto/lente o padecimiento que el paciente mencionó (tag '
  'extendido PROD: del bot). NULL si no lo mencionó — nunca se inventa.';

COMMIT;
