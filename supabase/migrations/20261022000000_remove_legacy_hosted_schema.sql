-- RoboLime hosted Supabase: remove the LEGACY application schema (D42).
--
-- The hosted project bkocxkavdosghmqjckty was given an earlier RoboLime
-- schema before the cloud-mirror design was locked. Several of its table
-- names collide with 20261023000000_cloud_mirror_initial.sql (which uses
-- plain `create table`), and its routines and grants contradict the target
-- authorization model (gateway-only writes through service_role,
-- claim-scoped SELECT for authenticated, nothing for anon). The project
-- owner approved clean replacement and declared the legacy application data
-- disposable (D42, 2026-10-27). The file name sorts BEFORE the target
-- migration; its timestamp is deliberately earlier than its authoring date.
-- Sorting only orders files: it says nothing about which versions a given
-- database's migration history records as applied.
--
-- Scope: only the legacy objects named below, each schema-qualified, each
-- routine with its full argument signature. There is no CASCADE, no DROP
-- SCHEMA, no DROP OWNED, no dynamic SQL, and no privilege or publication
-- statement. Nothing in auth, storage, realtime, vault, extensions, graphql
-- or any other Supabase-managed schema is named. PostgreSQL itself still
-- removes what a dropped table owns: its indexes, constraints, triggers,
-- RLS policies, owned sequences, publication memberships and, if a listed
-- table is partitioned, its partitions.
--
-- Dependencies outside this list are NOT removed. If any unlisted object
-- depends on a listed one (a foreign key from another table, a view, a
-- policy or default expression that calls a listed routine or sequence), or
-- if a listed name has an unexpected object type or belongs to an extension,
-- the statement fails and the migration stops. This file contains no
-- transaction control: apply it together with the target in one transaction
-- so that such a failure leaves nothing half-removed. Every statement is
-- idempotent, so a re-run after a fixed failure is safe.
--
-- Provenance: names and signatures come from read-only catalog checks the
-- project owner ran in the hosted SQL Editor and supplied: 17 legacy tables
-- (15 public, 2 private), 3 views, 2 public sequences, 9 routines in public
-- and private, and the trigger recommendations_dosing_runs_only on
-- public.recommendations, which calls
-- private.reject_verification_recommendation(). The legacy colliding tables
-- reported there do not have a cloud_received_at column. The unverified
-- 2026-10-25 dump files were NOT used as evidence.
--
-- Fresh databases: designed to change nothing (the guard finds no target
-- object and every drop uses IF EXISTS). Not yet verified by execution.
--
-- History: record this version as applied only after it actually ran.

-- 1. Refuse to run when target-schema objects are detected. Without this
--    guard the colliding table names below (robots, runs, readings, ...)
--    would drop target tables. It checks exactly three things:
--    (a) the five tables only the target creates: public.field_cells,
--        robot_status_reports, rule_suitability_ranges,
--        rule_seasonal_weather_defaults and recommendation_scores (the
--        hosted catalog checks found none of them);
--    (b) a cloud_received_at column on six colliding tables: public.robots,
--        fields, runs, readings, rule_sets and recommendations. The target
--        version of each has this column; the legacy versions reported by
--        the hosted catalog checks do not;
--    (c) the five functions only the target creates in private:
--        reject_update, recommendation_must_be_dosing, guard_rule_set_update,
--        has_robot_claim and has_any_robot_claim (none is among the nine
--        reported legacy routines).
--    It does NOT detect every possible partial target installation. The
--    target versions of public.robot_claims, public.rule_crops and
--    public.rule_seasons have no cloud_received_at column and their names
--    collide with legacy tables, so if they were the only target objects
--    present the guard would pass and step 3 would drop them. When the
--    target file is applied in order this state does not arise: its first
--    table, public.robots, has cloud_received_at and is caught by (b).
--    The checks read the catalog directly, so a missing schema (a fresh
--    database has no `private` yet) cannot raise an error.
do $$
begin
  if exists (
       select 1
       from pg_catalog.pg_class as c
       join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('field_cells', 'robot_status_reports', 'rule_suitability_ranges',
                           'rule_seasonal_weather_defaults', 'recommendation_scores'))
     or exists (
       select 1
       from pg_catalog.pg_attribute as a
       join pg_catalog.pg_class as c on c.oid = a.attrelid
       join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('robots', 'fields', 'runs', 'readings', 'rule_sets', 'recommendations')
         and a.attname = 'cloud_received_at'
         and a.attnum > 0
         and not a.attisdropped)
     or exists (
       select 1
       from pg_catalog.pg_proc as p
       join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'private'
         and p.proname in ('reject_update', 'recommendation_must_be_dosing', 'guard_rule_set_update',
                           'has_robot_claim', 'has_any_robot_claim')) then
    raise exception 'cloud-mirror target schema (or part of it) already present; legacy cleanup refused'
      using errcode = 'object_in_use';
  end if;
end;
$$;

-- 2. Legacy views (they depend on legacy tables, so they go first).
drop view if exists
  public.cell_readings_latest,
  public.run_delivery,
  public.run_summaries;

-- 3. Legacy tables. One statement lets foreign keys AMONG these tables
--    resolve without CASCADE; it does not help with dependants outside the
--    list, which make it fail (see the header). Dropping
--    public.recommendations also removes its trigger
--    recommendations_dosing_runs_only, so no DROP TRIGGER is needed.
drop table if exists
  public.field_selections,
  public.fields,
  public.grid_cells,
  public.readings,
  public.recommendations,
  public.robot_claims,
  public.robot_status,
  public.robots,
  public.rule_crop_ranges,
  public.rule_crops,
  public.rule_parameters,
  public.rule_seasons,
  public.rule_sets,
  public.rule_weather_defaults,
  public.runs,
  private.pairing_attempts,
  private.robot_pairing;

-- 4. Legacy sequences, in case they were not owned by a dropped column.
--    private.pairing_attempts_id_seq is not listed: the hosted catalog
--    checks show it internally owned by private.pairing_attempts (deptype
--    'i'), so step 3 removes it and naming it here would fail.
drop sequence if exists
  public.field_selections_id_seq,
  public.robot_status_id_seq;

-- 5. Legacy routines, each with its reported signature. They run after the
--    tables because legacy RLS policies called the private claim helpers.
drop function if exists private.has_any_claim();
drop function if exists private.has_claim(uuid);
drop function if exists private.set_pairing_code(uuid, text);
drop function if exists public.claim_robot(text);
drop function if exists public.ingest_readings(uuid, jsonb);
drop function if exists public.ingest_status(uuid, jsonb);

-- 6. The three remaining legacy routines. reject_verification_recommendation
--    goes after step 3, which removed the trigger that called it;
--    hash_pairing_code goes last, after the pairing routines that call it.
drop function if exists private.reject_verification_recommendation();
drop function if exists public.paired_readings(uuid, uuid);
drop function if exists private.hash_pairing_code(text);
