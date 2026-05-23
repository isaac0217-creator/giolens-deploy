-- Migration 005 · contacts enrichment metadata
-- Fecha: 2026-05-22 PM
-- Contexto Frente C: enriquecimiento de `contacts` con name/phone/email vía
-- `GET /api/contacts/{contact_id}` de Wapify (cron horario enrich-contacts).
--
-- Tras el cron sync-wapify-cache (D.2) los 4,690 rows tienen name/phone/email
-- en null porque /pipelines/{pid}/opportunities solo expone `contact_id`
-- (string serializado). Esta migración agrega 3 columnas:
--   • contact_id          TEXT          → backfilleado de raw_payload->>'contact_id'
--   • contact_id_invalid  BOOLEAN       → flag para contact_ids huérfanos (Wapify 404)
--   • enriched_at         TIMESTAMPTZ   → timestamp del último enrich exitoso
--
-- Idempotente con IF NOT EXISTS (Postgres 9.6+).

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS contact_id TEXT,
  ADD COLUMN IF NOT EXISTS contact_id_invalid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMP WITH TIME ZONE;

-- Backfill contact_id desde el raw_payload existente (de sync-wapify-cache).
UPDATE public.contacts
SET contact_id = raw_payload->>'contact_id'
WHERE contact_id IS NULL
  AND raw_payload->>'contact_id' IS NOT NULL;

-- Índice parcial para acelerar el SELECT del enrich (filas pendientes).
CREATE INDEX IF NOT EXISTS idx_contacts_enrichment_pending
  ON public.contacts (contact_id)
  WHERE contact_id IS NOT NULL
    AND contact_id_invalid = FALSE
    AND (name IS NULL OR phone IS NULL OR email IS NULL);
