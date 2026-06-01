-- Migration: 032_atenciones.sql
-- Frente SC (Servicio al Cliente) · Módulo M4 — registrar atenciones/seguimientos
-- ligados a un paciente (o contacto suelto) para el dashboard.
--
-- Tabla NUEVA `atenciones`. Una atención = una interacción de servicio (consulta,
-- queja, seguimiento) por algún canal (whatsapp, llamada, presencial). Puede o no
-- estar ligada a un contacto del CRM.
--
-- LIGA AL PACIENTE: por `contact_id` TEXT (misma convención que citas/expedientes;
-- el sistema NO usa un paciente_id numérico — la identidad vive en contacts.contact_id,
-- text, y expedientes/citas la referencian por ese mismo text, sin FK declarada).
-- `contact_id` es NULLABLE → permite atención de contacto anónimo/suelto (sin paciente).
-- NO se declara FK a contacts: (1) coherente con el resto del sistema (citas/expedientes
-- tampoco la declaran), (2) contacts es un cache de Wapify que puede repoblarse; un FK
-- duro podría bloquear inserts válidos durante un resync. La validación de existencia
-- del contacto se hace a nivel de aplicación (best-effort) en /api/atenciones-ui.
--
-- ADITIVA Y NO DESTRUCTIVA: CREATE TABLE IF NOT EXISTS. No toca ninguna tabla existente.
-- Idempotente y tx-safe (BEGIN/COMMIT). Guarda DO-block: si `atenciones` ya existe con
-- una forma incompatible (falta alguna columna esperada), aborta con mensaje accionable.
--
-- PII: `nota` puede contener datos del paciente → acceso restringido (service_role).
-- Se expone SOLO por el BFF Origin-gated /api/atenciones-ui (no-store), NUNCA por un
-- endpoint Bearer ni en logs.
--
-- PRE-CHECK (Isaac antes de aplicar): confirmar que no exista ya una tabla `atenciones`
-- con otra forma. Se espera 0 filas (tabla nueva):
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='atenciones';
--   -- 0 filas = OK (la crea). >0 = ya existe → revisar la guarda DO-block de abajo.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS atenciones;

BEGIN;

CREATE TABLE IF NOT EXISTS atenciones (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id    text,                                    -- liga a contacts.contact_id (nullable = contacto suelto)
  canal         text NOT NULL,                           -- whatsapp | llamada | presencial | ...
  tipo          text NOT NULL,                           -- consulta | queja | seguimiento | ...
  nota          text,                                    -- PII potencial: nunca loguear
  estado        text NOT NULL DEFAULT 'abierta'
                  CHECK (estado IN ('abierta', 'cerrada')),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- Auto-guarda: si `atenciones` preexistía con otra forma (falta alguna columna que el
-- INSERT/SELECT de /api/atenciones-ui referencia por nombre), abortamos con mensaje
-- accionable en vez de fallar opacamente en runtime. Idempotente.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO missing
  FROM unnest(ARRAY['id','contact_id','canal','tipo','nota','estado','creado_en','actualizado_en']) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='atenciones' AND column_name=c
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 032 abortada: tabla atenciones preexistente sin columna(s): %. Resolver antes de aplicar (ver PRE-CHECK / ROLLBACK).', missing;
  END IF;
END $$;

-- Índices de las consultas del BFF: por estado (listar abiertas) y por contacto
-- (historial del paciente, reusado por M2). created_en desc para orden estable.
CREATE INDEX IF NOT EXISTS idx_atenciones_estado       ON atenciones (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_atenciones_contact      ON atenciones (contact_id, creado_en DESC)
  WHERE contact_id IS NOT NULL;

COMMENT ON TABLE  atenciones IS
  '032 · M4 Servicio al Cliente. Atenciones/seguimientos ligados a contacts.contact_id '
  '(text, nullable=contacto suelto). Acceso restringido: solo backend service_role + BFF '
  'Origin-gated /api/atenciones-ui. nota puede contener PII: nunca loguear.';
COMMENT ON COLUMN atenciones.contact_id IS
  'Liga a contacts.contact_id (text, sin FK declarada — convención del sistema). NULL = contacto suelto/anónimo.';

COMMIT;
