-- RoboLime hosted Supabase CLOUD MIRROR — initial schema.
--
-- The laptop gateway's SQLite database is the system of record in the field.
-- This schema mirrors it one way (gateway -> cloud) for online access.
-- Primary keys are the gateway's deterministic UUIDv5 IDs, so the gateway can
-- upsert idempotently (`on conflict do nothing`) with the same keys as SQLite.
--
-- Writes: only the gateway, using its privileged key from the laptop
-- environment (service_role, which bypasses RLS). Clients get SELECT only.
-- Reads: an authenticated user sees only rows of robots it holds an active
-- claim for in public.robot_claims. Claims are created ONLY by a trusted
-- service-role process; no client can insert, update or delete a claim.
--
-- Local-only (never mirrored): pairing credentials, local sessions, field
-- selections, reading receipts, the sync outbox, gateway settings.
--
-- Timestamps: robot_*_at = robot-side time; gateway_*_at = gateway durable
-- storage time; cloud_received_at = assigned here by the cloud on insert.

create schema if not exists private;
revoke all on schema private from public;

-- ------------------------------------------------------------------ robots
create table public.robots (
  id                uuid primary key,
  source_robot_id   text not null unique check (length(source_robot_id) between 1 and 64),
  display_name      text not null check (length(display_name) >= 1),
  is_synthetic      boolean not null default false,
  tank_capacity_ml  double precision check (tank_capacity_ml is null or (tank_capacity_ml > 0 and tank_capacity_ml <= 5000)),
  created_at        timestamptz not null,
  cloud_received_at timestamptz not null default now()
);

-- Trusted robot claims: which authenticated user may read which robot.
create table public.robot_claims (
  user_id    uuid not null references auth.users (id) on delete cascade,
  robot_id   uuid not null references public.robots (id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by text not null check (length(granted_by) >= 1),
  revoked_at timestamptz,
  primary key (user_id, robot_id)
);
create index robot_claims_robot on public.robot_claims (robot_id);

-- ------------------------------------------------------------ field/cells
create table public.fields (
  id                uuid primary key,
  robot_id          uuid not null references public.robots (id) on delete restrict,
  field_key         text not null check (length(field_key) between 1 and 64),
  name              text not null check (length(name) >= 1),
  location_label    text not null,
  area_m2           double precision check (area_m2 is null or area_m2 > 0),
  cell_size_m       double precision not null default 2 check (cell_size_m > 0),
  total_cells       integer check (total_cells is null or total_cells > 0),
  is_active         boolean not null default true,
  is_synthetic      boolean not null default false,
  created_at        timestamptz not null,
  cloud_received_at timestamptz not null default now(),
  unique (robot_id, field_key),
  unique (id, robot_id)
);
create unique index fields_one_active_per_robot on public.fields (robot_id) where is_active;

create table public.field_cells (
  field_id          uuid not null,
  robot_id          uuid not null,
  cell_index        integer not null check (cell_index >= 0),
  grid_row          integer check (grid_row is null or grid_row >= 0),
  grid_column       integer check (grid_column is null or grid_column >= 0),
  center_latitude   double precision check (center_latitude is null or center_latitude between -90 and 90),
  center_longitude  double precision check (center_longitude is null or center_longitude between -180 and 180),
  cloud_received_at timestamptz not null default now(),
  check ((center_latitude is null) = (center_longitude is null)),
  primary key (field_id, cell_index),
  foreign key (field_id, robot_id) references public.fields (id, robot_id) on delete cascade
);
create index field_cells_robot on public.field_cells (robot_id);

-- -------------------------------------------------------------------- runs
create table public.runs (
  id                        uuid primary key,
  robot_id                  uuid not null references public.robots (id) on delete restrict,
  source_run_id             text not null check (length(source_run_id) between 1 and 64),
  run_type                  text not null check (run_type in ('dosing', 'verification')),
  field_id                  uuid,
  gateway_first_received_at timestamptz not null,
  is_synthetic              boolean not null default false,
  cloud_received_at         timestamptz not null default now(),
  unique (robot_id, source_run_id),
  unique (id, robot_id),
  foreign key (field_id, robot_id) references public.fields (id, robot_id) on delete restrict
);
create index runs_robot on public.runs (robot_id);

-- ---------------------------------------------------------------- readings
-- robot_id is denormalised for RLS; the composite FK keeps it consistent with the run.
create table public.readings (
  id                          uuid primary key,
  run_id                      uuid not null,
  robot_id                    uuid not null,
  cell_index                  integer not null check (cell_index >= 0),
  seq                         integer not null check (seq >= 0),
  attempt_count               integer not null check (attempt_count >= 0),
  ph                          double precision not null check (ph between 0 and 14),
  ec                          double precision not null check (ec >= 0), -- unit pending (OPEN_ITEMS #7)
  moisture_percent            double precision not null check (moisture_percent between 0 and 100),
  temperature_c               double precision not null,
  dose_volume_ml              double precision not null check (dose_volume_ml >= 0), -- commanded, not measured
  expected_post_correction_ph double precision check (expected_post_correction_ph is null or expected_post_correction_ph between 0 and 14),
  gps_latitude                double precision check (gps_latitude is null or gps_latitude between -90 and 90),
  gps_longitude               double precision check (gps_longitude is null or gps_longitude between -180 and 180),
  raw_flags                   integer not null check (raw_flags >= 0),
  robot_recorded_at           timestamptz not null,
  gateway_received_at         timestamptz not null,
  cloud_received_at           timestamptz not null default now(),
  check ((gps_latitude is null) = (gps_longitude is null)),
  unique (run_id, cell_index, seq),
  foreign key (run_id, robot_id) references public.runs (id, robot_id) on delete restrict
);
create index readings_robot on public.readings (robot_id);

-- ----------------------------------------------------------- robot status
create table public.robot_status_reports (
  id                      uuid primary key,
  robot_id                uuid not null references public.robots (id) on delete restrict,
  state                   text not null check (state in ('INITIALIZING', 'IDLE', 'WORKING', 'PAUSED', 'COMPLETED', 'ERROR', 'MANUAL')),
  error_flags             integer not null check (error_flags between 0 and 255),
  component_flags         integer check (component_flags is null or component_flags >= 0),
  battery_voltage         double precision not null check (battery_voltage >= 0),
  total_lime_commanded_ml double precision not null check (total_lime_commanded_ml >= 0),
  cells_completed         integer not null check (cells_completed >= 0),
  total_cells             integer not null check (total_cells >= 0),
  robot_reported_at       timestamptz not null,
  gateway_received_at     timestamptz not null,
  cloud_received_at       timestamptz not null default now(),
  unique (robot_id, robot_reported_at, state, cells_completed)
);
create index robot_status_reports_latest on public.robot_status_reports (robot_id, robot_reported_at desc);

-- ------------------------------------------------- versioned rule tables
create table public.rule_sets (
  id                uuid primary key,
  version           text not null unique check (length(version) between 1 and 64),
  status            text not null check (status in ('draft', 'approved', 'retired')),
  scoring_method    text not null check (length(scoring_method) >= 1),
  is_synthetic      boolean not null default false,
  source_notes      text not null,
  created_at        timestamptz not null,
  approved_at       timestamptz,
  cloud_received_at timestamptz not null default now(),
  check (not (is_synthetic and status = 'approved')),
  check ((status = 'draft') = (approved_at is null))
);

create table public.rule_crops (
  rule_set_id           uuid not null references public.rule_sets (id) on delete restrict,
  crop_key              text not null check (length(crop_key) between 1 and 64),
  display_name          text not null,
  category              text not null,
  is_perennial_or_tree  boolean not null default false check (not is_perennial_or_tree),
  cultivation_reference text not null,
  primary key (rule_set_id, crop_key)
);

create table public.rule_suitability_ranges (
  rule_set_id      uuid not null,
  crop_key         text not null,
  parameter        text not null check (length(parameter) >= 1),
  min_value        double precision not null,
  max_value        double precision not null,
  unit             text not null,
  weight           double precision not null default 1 check (weight > 0),
  source_reference text not null,
  check (min_value <= max_value),
  primary key (rule_set_id, crop_key, parameter),
  foreign key (rule_set_id, crop_key) references public.rule_crops (rule_set_id, crop_key) on delete restrict
);

create table public.rule_seasons (
  rule_set_id uuid not null references public.rule_sets (id) on delete restrict,
  season_key  text not null check (length(season_key) between 1 and 64),
  label       text not null,
  start_month integer not null check (start_month between 1 and 12),
  start_day   integer not null check (start_day between 1 and 31),
  end_month   integer not null check (end_month between 1 and 12),
  end_day     integer not null check (end_day between 1 and 31),
  primary key (rule_set_id, season_key)
);

create table public.rule_seasonal_weather_defaults (
  rule_set_id      uuid not null,
  season_key       text not null,
  parameter        text not null check (length(parameter) >= 1),
  value            double precision not null,
  unit             text not null,
  source_reference text not null,
  primary key (rule_set_id, season_key, parameter),
  foreign key (rule_set_id, season_key) references public.rule_seasons (rule_set_id, season_key) on delete restrict
);

-- ------------------------------------------------ stored recommendations
create table public.recommendations (
  id                uuid primary key,
  run_id            uuid not null unique,
  robot_id          uuid not null,
  rule_set_id       uuid not null references public.rule_sets (id) on delete restrict,
  inputs            jsonb not null check (jsonb_typeof(inputs) = 'object'),
  weather_source    text not null check (weather_source in ('forecast', 'seasonal-defaults')),
  computed_at       timestamptz not null,
  cloud_received_at timestamptz not null default now(),
  unique (id, rule_set_id),
  unique (id, robot_id),
  foreign key (run_id, robot_id) references public.runs (id, robot_id) on delete restrict
);
create index recommendations_robot on public.recommendations (robot_id);

create table public.recommendation_scores (
  recommendation_id uuid not null,
  robot_id          uuid not null,
  rule_set_id       uuid not null,
  crop_key          text not null,
  score             double precision not null,
  shortlist_rank    integer check (shortlist_rank is null or shortlist_rank between 1 and 5),
  reasons           jsonb not null check (jsonb_typeof(reasons) = 'array'),
  primary key (recommendation_id, crop_key),
  unique (recommendation_id, shortlist_rank),
  foreign key (recommendation_id, robot_id) references public.recommendations (id, robot_id) on delete cascade,
  foreign key (recommendation_id, rule_set_id) references public.recommendations (id, rule_set_id) on delete cascade,
  foreign key (rule_set_id, crop_key) references public.rule_crops (rule_set_id, crop_key) on delete restrict
);
create index recommendation_scores_robot on public.recommendation_scores (robot_id);

-- ------------------------------------------------------------ integrity
create function private.reject_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '%.% rows are immutable once mirrored', tg_table_schema, tg_table_name
    using errcode = 'check_violation';
end;
$$;

create function private.recommendation_must_be_dosing() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select r.run_type from public.runs as r where r.id = new.run_id) is distinct from 'dosing' then
    raise exception 'recommendations are only stored for dosing runs' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Only draft->approved->retired status moves are allowed; rule identity is fixed.
create function private.guard_rule_set_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.version <> old.version or new.scoring_method <> old.scoring_method
     or new.is_synthetic <> old.is_synthetic or new.source_notes <> old.source_notes
     or new.created_at <> old.created_at
     or (old.status = 'approved' and new.status not in ('approved', 'retired'))
     or (old.status = 'retired' and new.status <> 'retired') then
    raise exception 'rule set identity is fixed; only status changes are allowed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_update() from public;
revoke all on function private.recommendation_must_be_dosing() from public;
revoke all on function private.guard_rule_set_update() from public;

create trigger readings_immutable before update on public.readings
  for each row execute function private.reject_update();
create trigger robot_status_reports_immutable before update on public.robot_status_reports
  for each row execute function private.reject_update();
create trigger recommendations_immutable before update on public.recommendations
  for each row execute function private.reject_update();
create trigger recommendation_scores_immutable before update on public.recommendation_scores
  for each row execute function private.reject_update();
create trigger rule_crops_immutable before update on public.rule_crops
  for each row execute function private.reject_update();
create trigger rule_suitability_ranges_immutable before update on public.rule_suitability_ranges
  for each row execute function private.reject_update();
create trigger rule_seasons_immutable before update on public.rule_seasons
  for each row execute function private.reject_update();
create trigger rule_seasonal_weather_defaults_immutable before update on public.rule_seasonal_weather_defaults
  for each row execute function private.reject_update();
create trigger recommendations_dosing_only before insert on public.recommendations
  for each row execute function private.recommendation_must_be_dosing();
create trigger rule_sets_guard_update before update on public.rule_sets
  for each row execute function private.guard_rule_set_update();

-- ------------------------------------------------- authorization helpers
-- SECURITY DEFINER so policies can consult robot_claims without exposing it;
-- search_path is pinned and auth.uid() is the only caller-controlled input.
create function private.has_robot_claim(target_robot_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.robot_claims as c
    where c.robot_id = target_robot_id
      and c.user_id = (select auth.uid())
      and c.revoked_at is null
  );
$$;

create function private.has_any_robot_claim() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.robot_claims as c
    where c.user_id = (select auth.uid()) and c.revoked_at is null
  );
$$;

revoke all on function private.has_robot_claim(uuid) from public;
revoke all on function private.has_any_robot_claim() from public;
grant usage on schema private to authenticated;
grant execute on function private.has_robot_claim(uuid) to authenticated;
grant execute on function private.has_any_robot_claim() to authenticated;

-- ------------------------------------------------------------ RLS + grants
-- Supabase grants table privileges to anon/authenticated by default; revoke
-- them explicitly and grant only what each role needs.
do $$
declare
  t text;
begin
  foreach t in array array[
    'robots', 'robot_claims', 'fields', 'field_cells', 'runs', 'readings', 'robot_status_reports',
    'rule_sets', 'rule_crops', 'rule_suitability_ranges', 'rule_seasons', 'rule_seasonal_weather_defaults',
    'recommendations', 'recommendation_scores'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end;
$$;

create policy "robots: claimed robot only" on public.robots
  for select to authenticated using ((select private.has_robot_claim(id)));

create policy "robot_claims: own active claims only" on public.robot_claims
  for select to authenticated using (user_id = (select auth.uid()) and revoked_at is null);

create policy "fields: claimed robot only" on public.fields
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
create policy "field_cells: claimed robot only" on public.field_cells
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
create policy "runs: claimed robot only" on public.runs
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
create policy "readings: claimed robot only" on public.readings
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
create policy "robot_status_reports: claimed robot only" on public.robot_status_reports
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
create policy "recommendations: claimed robot only" on public.recommendations
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
create policy "recommendation_scores: claimed robot only" on public.recommendation_scores
  for select to authenticated using ((select private.has_robot_claim(robot_id)));

-- Rule tables are shared reference data (not robot-specific), readable by any
-- user who holds at least one active robot claim.
create policy "rule_sets: any claimed user" on public.rule_sets
  for select to authenticated using ((select private.has_any_robot_claim()));
create policy "rule_crops: any claimed user" on public.rule_crops
  for select to authenticated using ((select private.has_any_robot_claim()));
create policy "rule_suitability_ranges: any claimed user" on public.rule_suitability_ranges
  for select to authenticated using ((select private.has_any_robot_claim()));
create policy "rule_seasons: any claimed user" on public.rule_seasons
  for select to authenticated using ((select private.has_any_robot_claim()));
create policy "rule_seasonal_weather_defaults: any claimed user" on public.rule_seasonal_weather_defaults
  for select to authenticated using ((select private.has_any_robot_claim()));
