-- ═══ SECCIÓN 0 · METADATA ═══════════════════════════════════════════════════
-- GioLens · Schema Supabase Fase 1 Sprint 1
-- 2 tablas (gl_timeseries, gl_kv) + RLS + TTL 30d via pg_cron + helpers
-- Aplicar en SQL Editor de Supabase (Web). Idempotente.
-- Tier objetivo: Free. Sin extensiones de pago.
-- Generado: 2026-05-16

-- ═══ SECCIÓN 1 · EXTENSIONES ════════════════════════════════════════════════
create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";

-- ═══ SECCIÓN 2 · TABLA gl_timeseries ════════════════════════════════════════
-- Serie temporal append-only. Buckets bien acotados por CHECK.
-- TTL: rows con ts < now() - 30d se purgan vía cron.
create table if not exists public.gl_timeseries (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default 'system',
  bucket      text not null,
  ts          timestamptz not null default now(),
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint gl_timeseries_bucket_chk check (
    bucket in (
      'webhook_event',
      'motor_run',
      'agent_run',
      'meta_kpi',
      'wapify_event',
      'cost_event',
      'eval_run',
      'audit'
    )
  )
);

-- Índices: lecturas típicas por user+bucket+ts desc, purge por ts, auditoría por created_at.
create index if not exists gl_timeseries_user_bucket_ts_idx
  on public.gl_timeseries (user_id, bucket, ts desc);

create index if not exists gl_timeseries_ts_brin_idx
  on public.gl_timeseries using brin (ts);

create index if not exists gl_timeseries_created_at_idx
  on public.gl_timeseries (created_at);

-- ═══ SECCIÓN 3 · TABLA gl_kv ════════════════════════════════════════════════
-- Key-value por usuario. PK compuesta (user_id, key). updated_at via trigger.
create table if not exists public.gl_kv (
  user_id     text not null default 'system',
  key         text not null,
  value       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

create or replace function public.gl_kv_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists gl_kv_touch_updated_at_trg on public.gl_kv;
create trigger gl_kv_touch_updated_at_trg
  before update on public.gl_kv
  for each row execute function public.gl_kv_touch_updated_at();

-- ═══ SECCIÓN 4 · ROW LEVEL SECURITY ═════════════════════════════════════════
-- service_role tiene full access; anon solo SELECT (lectura pública controlada).
alter table public.gl_timeseries enable row level security;
alter table public.gl_kv         enable row level security;

drop policy if exists gl_timeseries_service_all on public.gl_timeseries;
create policy gl_timeseries_service_all
  on public.gl_timeseries
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists gl_timeseries_anon_select on public.gl_timeseries;
create policy gl_timeseries_anon_select
  on public.gl_timeseries
  as permissive
  for select
  to anon
  using (true);

drop policy if exists gl_kv_service_all on public.gl_kv;
create policy gl_kv_service_all
  on public.gl_kv
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists gl_kv_anon_select on public.gl_kv;
create policy gl_kv_anon_select
  on public.gl_kv
  as permissive
  for select
  to anon
  using (true);

-- ═══ SECCIÓN 5 · TTL · PURGE 30 DÍAS ═══════════════════════════════════════
create or replace function public.gl_timeseries_purge_old()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.gl_timeseries
   where ts < now() - interval '30 days';
  get diagnostics deleted_count = row_count;
  return coalesce(deleted_count, 0);
end;
$$;

-- Job pg_cron: corre cada día a las 03:15. Idempotente (re-agenda si ya existe).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'gl_timeseries_purge_old') then
    perform cron.unschedule('gl_timeseries_purge_old');
  end if;
end;
$$;

select cron.schedule(
  'gl_timeseries_purge_old',
  '15 3 * * *',
  $$select public.gl_timeseries_purge_old();$$
);

-- ═══ SECCIÓN 6 · HELPERS kv_upsert ═════════════════════════════════════════
-- Sobrecarga 1: upsert con user_id='system' por defecto.
create or replace function public.kv_upsert(p_key text, p_value jsonb)
returns public.gl_kv
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.gl_kv;
begin
  insert into public.gl_kv (user_id, key, value)
       values ('system', p_key, p_value)
  on conflict (user_id, key) do update
       set value = excluded.value,
           updated_at = now()
  returning * into row_out;
  return row_out;
end;
$$;

-- Sobrecarga 2: upsert con user_id explícito.
create or replace function public.kv_upsert(p_user_id text, p_key text, p_value jsonb)
returns public.gl_kv
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.gl_kv;
begin
  insert into public.gl_kv (user_id, key, value)
       values (p_user_id, p_key, p_value)
  on conflict (user_id, key) do update
       set value = excluded.value,
           updated_at = now()
  returning * into row_out;
  return row_out;
end;
$$;

-- ═══ SECCIÓN 7 · SEED ══════════════════════════════════════════════════════
-- 3 rows iniciales en gl_kv para que el dashboard no falle leyendo claves vacías.
insert into public.gl_kv (user_id, key, value) values
  ('system', 'ai_context',     '{}'::jsonb),
  ('system', 'motor_results',  '{}'::jsonb),
  ('system', 'prompt_library', '{}'::jsonb)
on conflict (user_id, key) do nothing;

-- ═══ SECCIÓN 8 · VERIFICACIÓN ══════════════════════════════════════════════
-- Ejecutar manualmente tras aplicar el schema. Resultados esperados:
--   tables_ok = 2  (gl_timeseries, gl_kv)
--   policies_ok = 4  (2 service_all + 2 anon_select)
--   cron_ok = 1  (gl_timeseries_purge_old)
--   kv_seed_ok = 3  (ai_context, motor_results, prompt_library)
--   kv_upsert_overloads = 2

select
  (select count(*) from pg_tables
     where schemaname='public' and tablename in ('gl_timeseries','gl_kv'))    as tables_ok,
  (select count(*) from pg_policies
     where schemaname='public' and tablename in ('gl_timeseries','gl_kv'))    as policies_ok,
  (select count(*) from cron.job
     where jobname='gl_timeseries_purge_old')                                  as cron_ok,
  (select count(*) from public.gl_kv where user_id='system')                   as kv_seed_ok,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='kv_upsert')                        as kv_upsert_overloads;
