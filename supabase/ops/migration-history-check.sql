-- RoboLime: READ-ONLY migration-history check (psql). Never writes.
--   psql -X -q -At ... -f supabase/ops/migration-history-check.sql
-- Runs in a READ ONLY transaction that is rolled back. Reports whether
-- supabase_migrations.schema_migrations exists and, if it does, compares its
-- versions with the reviewed repository migrations. Use it before AND after
-- any history repair (docs/hosted-migration-runbook.md). It does not check
-- the schema itself: use the D42 kit's classify.sql for that. A history row
-- never proves that a schema exists.
\set ON_ERROR_STOP on
begin read only;
select to_regclass('supabase_migrations.schema_migrations') is not null as history_table_exists \gset
\if :history_table_exists
with expected(version) as (values ('20261022000000'), ('20261023000000')),
     recorded as (select version::text as version from supabase_migrations.schema_migrations)
select 'HISTORY: table present; recorded=' || (select count(*) from recorded)
       || '; expected present=' || (select count(*) from expected e where e.version in (select version from recorded))
       || '/2; missing=' || coalesce((select string_agg(version, ',' order by version) from expected e where e.version not in (select version from recorded)), '-')
       || '; unexpected=' || coalesce((select string_agg(version, ',' order by version) from recorded r where r.version not in (select version from expected)), '-')
       as history_report;
\else
select 'HISTORY: table absent (supabase_migrations.schema_migrations does not exist)' as history_report;
\endif
rollback;
