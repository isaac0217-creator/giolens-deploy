-- Migration: 025_citas_origen.sql
-- Frente G · Sesión 10 · Doble-escritura calendario — Opción (a) cron pull GCal → citas
-- Decisión: DECISION_DOBLE_ESCRITURA_CALENDAR.md (Isaac, 2026-05-28, ADOPTADA).
--
-- Propósito: que la tabla `citas` refleje TODOS los slots ocupados del calendario
-- "Citas GIOCORE", incluidas las reservas Path A (paciente auto-reserva vía Whapify
-- Gestor de Reservas) que hoy SOLO existen en Google Calendar. Un cron lee GCal y
-- por cada evento sin fila en `citas` inserta una con origen='whapify'.
--
-- Cambios:
--   1. citas.origen TEXT NOT NULL DEFAULT 'dashboard' · CHECK origen IN
--      ('dashboard','whapify','import'). Las filas existentes (todas Path B,
--      creadas por POST /api/citas) toman el DEFAULT 'dashboard'.
--   2. idx_citas_gcal_event_id sobre gcal_event_id — clave del upsert idempotente
--      del cron (busca "¿ya existe fila con este gcal_event_id?").
--
-- NOTA: gcal_event_id YA EXISTE (migration 010, línea "gcal_event_id TEXT").
-- Esta migration NO lo redefine; sólo indexa.
--
-- Idempotente (IF NOT EXISTS / guard DO $$) y tx-safe (BEGIN/COMMIT).
-- Aplica Cowork a prod (patrón del proyecto: migrations a prod vía psql, nunca Code).
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_citas_gcal_event_id;
--   ALTER TABLE citas DROP CONSTRAINT IF EXISTS citas_origen_check;
--   ALTER TABLE citas DROP COLUMN IF EXISTS origen;

BEGIN;

-- 1 · Columna origen (idempotente)
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'dashboard';

-- CHECK por separado y guardado (ADD COLUMN ... CHECK no es idempotente si la
-- columna ya existía de una corrida previa). DO-block evita error si ya está.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'citas_origen_check'
  ) THEN
    ALTER TABLE citas
      ADD CONSTRAINT citas_origen_check
      CHECK (origen IN ('dashboard','whapify','import'));
  END IF;
END $$;

COMMENT ON COLUMN citas.origen IS
  'Origen de la cita: dashboard (Path B, POST /api/citas por Cynthia), '
  'whapify (Path A, auto-reserva del paciente importada por cron pull-gcal), '
  'import (carga manual/histórica). DEFAULT dashboard.';

-- 2 · Índice de lookup para el upsert idempotente del cron (no UNIQUE: GCal
-- podría, en teoría, repetir un id tras un restore; el cron hace check-then-insert).
CREATE INDEX IF NOT EXISTS idx_citas_gcal_event_id
  ON citas(gcal_event_id);

COMMENT ON INDEX idx_citas_gcal_event_id IS
  '025: lookup O(log n) por gcal_event_id para el cron pull-gcal (idempotencia).';

COMMIT;
