-- EnergyGuard persistent data schema (PostgreSQL 18 compatible)
-- Intended for the dedicated Render database: energyguard-db.
-- This file is NOT applied to FloodGuard or any shared Supabase project.

create table if not exists energyguard_users (
  id bigserial primary key,
  google_sub text not null unique,
  email text not null,
  display_name text,
  picture_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists energy_systems (
  id uuid primary key,
  user_id bigint not null references energyguard_users(id) on delete cascade,
  name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  daily_consumption_kwh numeric(12,3) not null check (daily_consumption_kwh > 0),
  solar_kwp numeric(12,3) not null check (solar_kwp >= 0),
  battery_kwh numeric(12,3) not null check (battery_kwh >= 0),
  initial_soc_pct numeric(5,2) not null check (initial_soc_pct between 0 and 100),
  ev_battery_kwh numeric(12,3) not null default 0 check (ev_battery_kwh >= 0),
  ev_target_pct numeric(5,2) not null default 80 check (ev_target_pct between 0 and 100),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, name)
);

create index if not exists energy_systems_user_idx on energy_systems(user_id);
create unique index if not exists one_active_system_per_user
  on energy_systems(user_id) where is_active;

create table if not exists forecast_runs (
  id uuid primary key,
  user_id bigint not null references energyguard_users(id) on delete cascade,
  system_id uuid references energy_systems(id) on delete set null,
  model_name text not null,
  model_version text,
  weather_source text,
  forecast_started_at timestamptz not null,
  forecast_horizon_hours integer not null default 24 check (forecast_horizon_hours between 1 and 336),
  solar_kwh numeric(14,4),
  load_kwh numeric(14,4),
  grid_import_kwh numeric(14,4),
  grid_export_kwh numeric(14,4),
  battery_charge_kwh numeric(14,4),
  battery_discharge_kwh numeric(14,4),
  final_soc_pct numeric(5,2),
  solar_coverage_pct numeric(6,2),
  config_snapshot jsonb not null default '{}'::jsonb,
  advisor_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists forecast_runs_user_created_idx
  on forecast_runs(user_id, created_at desc);
create index if not exists forecast_runs_system_created_idx
  on forecast_runs(system_id, created_at desc);

create table if not exists forecast_hours (
  id bigserial primary key,
  run_id uuid not null references forecast_runs(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  forecast_time timestamptz,
  temperature_c numeric(7,3),
  solar_kw numeric(12,4),
  load_kw numeric(12,4),
  battery_charge_kw numeric(12,4),
  battery_discharge_kw numeric(12,4),
  soc_pct numeric(5,2),
  grid_import_kw numeric(12,4),
  grid_export_kw numeric(12,4),
  unique(run_id, step_index)
);

create index if not exists forecast_hours_run_idx on forecast_hours(run_id, step_index);

-- Authorization rule: the API must derive user identity only from a verified
-- EnergyGuard session token. Client-supplied user_id/google_sub values must never
-- be trusted for row ownership.
