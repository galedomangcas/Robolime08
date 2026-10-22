-- TEST-ONLY SHIM — never apply to a Supabase project (local or hosted).
--
-- Emulates the parts of Supabase the cloud-mirror migration relies on, so the
-- migration and RLS tests can run on a throwaway plain PostgreSQL cluster when
-- the Supabase local stack (Docker) is unavailable:
--   * roles anon / authenticated / service_role (service_role bypasses RLS)
--   * auth.users and auth.uid() reading the JWT subject from request settings,
--     the same mechanism Supabase's PostgREST uses
--   * Supabase's default table grants to anon/authenticated/service_role, so
--     the migration's explicit REVOKEs are genuinely exercised.
-- Differences from real Supabase are documented in docs/cloud-mirror.md.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create table auth.users (id uuid primary key);

create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
