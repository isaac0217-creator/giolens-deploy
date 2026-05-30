-- Migration: 028_citas_whapify_idempotency.sql
-- Frente G · W2 · Rama B — endpoint POST /api/citas/from-whapify
-- Decisión: DECISION_CITA_CALENDARIO_W2 (ingest de citas confirmadas por el bot
-- GPT "ALPHA" de Whapify → revalidación backend → GCal + tabla citas).
--
-- Propósito: hacer race-safe la idempotencia del endpoint. El endpoint hace
-- check-then-insert por (paciente_hash, fecha, hora) para que un doble POST del
-- nodo HTTP de Whapify = 1 sola cita/evento. Bajo concurrencia, el check-then-
-- insert tiene una ventana de carrera; este índice único parcial la cierra:
-- el segundo INSERT recibe 23505 y el endpoint re-SELECTea al ganador.
--
-- Alcance ACOTADO a origen='whapify' a propósito:
--   - NO afecta las citas Path B (origen='dashboard', POST /api/citas por Cynthia),
--     que ya tienen su propia UNIQUE de slot (idx_citas_slot_unique, mig 011).
--   - whapify usa paciente_hash = sha256(contact_id)[:16]; dashboard usa
--     sha256(email|telefono)[:16] → hashes de espacios distintos, no colisionan
--     entre orígenes aunque coincidan fecha/hora. Por eso el filtro origen.
--   - WHERE estado != 'cancelada': una cita cancelada libera el slot (permite
--     re-agendar al mismo paciente en el mismo horario).
--
-- NOTA cron pull-gcal: NO interfiere. El cron dedup por gcal_event_id (mig 025);
-- las filas del cron (origen='whapify', paciente_hash = sha256(gcal_event_id)[:16])
-- y las de este endpoint comparten origen pero difieren en paciente_hash salvo
-- que sean la MISMA cita — en cuyo caso el endpoint ya escribió gcal_event_id y el
-- cron la omite antes de intentar insertar. La unicidad por hash no se cruza.
--
-- PRE-CHECK (Cowork antes de aplicar): si existieran duplicados previos, el CREATE
-- UNIQUE INDEX fallará. Verificar con:
--   SELECT paciente_hash, fecha, hora, count(*)
--   FROM citas WHERE origen='whapify' AND estado != 'cancelada'
--   GROUP BY 1,2,3 HAVING count(*) > 1;
-- (Se espera 0 filas; tabla citas hoy no tiene filas whapify de este endpoint.)
--
-- Idempotente (IF NOT EXISTS) y tx-safe (BEGIN/COMMIT). Aplica Cowork a prod
-- (patrón del proyecto: migrations a prod vía psql, nunca Code).
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_citas_whapify_slot_unique;

BEGIN;

-- Auto-guarda (L-2): si existieran duplicados previos en el espacio que el índice
-- volverá único, el CREATE fallaría con un error genérico de "could not create
-- unique index". Abortamos antes con un mensaje accionable (la tx hace ROLLBACK).
-- Esto convierte el PRE-CHECK manual de arriba en una salvaguarda ejecutable.
DO $$
DECLARE
  dups int;
BEGIN
  SELECT count(*) INTO dups FROM (
    SELECT 1
    FROM citas
    WHERE origen = 'whapify' AND estado != 'cancelada'
    GROUP BY paciente_hash, fecha, hora
    HAVING count(*) > 1
  ) d;
  IF dups > 0 THEN
    RAISE EXCEPTION
      'Migration 028 abortada: % grupo(s) (paciente_hash,fecha,hora) duplicados en citas whapify activas. Resolverlos antes de crear el índice único (ver PRE-CHECK arriba).', dups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_citas_whapify_slot_unique
  ON citas (paciente_hash, fecha, hora)
  WHERE origen = 'whapify' AND estado != 'cancelada';

COMMENT ON INDEX idx_citas_whapify_slot_unique IS
  '028: idempotencia del endpoint /api/citas/from-whapify. UNIQUE parcial '
  '(paciente_hash, fecha, hora) acotada a origen=whapify y estado activo: doble '
  'POST del nodo Whapify => 1 cita. No afecta dashboard ni el cron pull-gcal.';

COMMIT;
