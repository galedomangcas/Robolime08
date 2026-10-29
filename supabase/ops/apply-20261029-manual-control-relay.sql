-- RoboLime: apply ONLY 20261029000000_manual_control_relay (D58) to a database
-- that already has the cloud mirror + claim flow (hosted state of 2026-10-29,
-- docs/hosted-migration-runbook.md §7.2). One transaction, ON_ERROR_STOP.
--
--   psql -X -v ON_ERROR_STOP=1 -v finish=rollback ... -f supabase/ops/apply-20261029-manual-control-relay.sql   (dry run)
--   psql -X -v ON_ERROR_STOP=1 -v finish=commit   ... -f supabase/ops/apply-20261029-manual-control-relay.sql
--
-- Run from the repository root (\ir resolves the migration relative to this file).
-- Not `supabase db push`: the hosted project has no migration-history table.
\set ON_ERROR_STOP on
\if :{?finish}
\else
\echo 'Set -v finish=rollback (dry run) or -v finish=commit.'
\quit
\endif

begin;
set local lock_timeout = '15s';

-- ------------------------------------------------------------- precheck
do $$
begin
  assert to_regclass('public.robots') is not null, 'PRECHECK: public.robots missing (cloud mirror not applied)';
  assert to_regclass('public.robot_claims') is not null, 'PRECHECK: public.robot_claims missing';
  assert to_regprocedure('private.has_robot_claim(uuid)') is not null, 'PRECHECK: private.has_robot_claim missing';
  assert to_regprocedure('public.claim_robot(text)') is not null, 'PRECHECK: claim flow (20261028000000) missing';
  assert to_regclass('public.manual_commands') is null, 'PRECHECK: manual_commands already exists (already applied?)';
  assert to_regclass('public.manual_relay_heartbeats') is null, 'PRECHECK: manual_relay_heartbeats already exists';
  assert to_regprocedure('public.request_manual_command(uuid,text)') is null, 'PRECHECK: request_manual_command already exists';
end $$;
\echo 'PRECHECK: passed'

\ir ../migrations/20261029000000_manual_control_relay.sql

-- ------------------------------------------------------------ postcheck
do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.manual_commands'::regclass), 'POSTCHECK: RLS off on manual_commands';
  assert (select relrowsecurity from pg_class where oid = 'public.manual_relay_heartbeats'::regclass), 'POSTCHECK: RLS off on heartbeats';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename in ('manual_commands', 'manual_relay_heartbeats')) = 2,
    'POSTCHECK: expected exactly 2 policies';
  assert not has_table_privilege('anon', 'public.manual_commands', 'select,insert,update,delete'), 'POSTCHECK: anon has table access';
  assert not has_table_privilege('anon', 'public.manual_relay_heartbeats', 'select,insert,update,delete'), 'POSTCHECK: anon has heartbeat access';
  assert not has_table_privilege('authenticated', 'public.manual_commands', 'insert,update,delete'), 'POSTCHECK: clients can write commands';
  assert not has_table_privilege('authenticated', 'public.manual_relay_heartbeats', 'insert,update,delete'), 'POSTCHECK: clients can write heartbeats';
  assert has_table_privilege('authenticated', 'public.manual_commands', 'select'), 'POSTCHECK: clients cannot read commands';
  assert has_function_privilege('authenticated', 'public.request_manual_command(uuid, text)', 'execute'), 'POSTCHECK: clients cannot request';
  assert has_function_privilege('authenticated', 'public.manual_relay_status(uuid)', 'execute'), 'POSTCHECK: clients cannot read status';
  assert not has_function_privilege('anon', 'public.request_manual_command(uuid, text)', 'execute'), 'POSTCHECK: anon can request';
  assert not has_function_privilege('anon', 'public.manual_relay_status(uuid)', 'execute'), 'POSTCHECK: anon can read status';
  assert not has_function_privilege('anon', 'public.take_manual_commands(text, text, integer)', 'execute'), 'POSTCHECK: anon can take';
  assert not has_function_privilege('authenticated', 'public.take_manual_commands(text, text, integer)', 'execute'), 'POSTCHECK: clients can take';
  assert not has_function_privilege('anon', 'public.finish_manual_command(uuid, text)', 'execute'), 'POSTCHECK: anon can finish';
  assert not has_function_privilege('authenticated', 'public.finish_manual_command(uuid, text)', 'execute'), 'POSTCHECK: clients can finish';
  assert has_function_privilege('service_role', 'public.take_manual_commands(text, text, integer)', 'execute'), 'POSTCHECK: gateway cannot take';
  assert has_function_privilege('service_role', 'public.finish_manual_command(uuid, text)', 'execute'), 'POSTCHECK: gateway cannot finish';
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('request_manual_command', 'manual_relay_status', 'take_manual_commands', 'finish_manual_command')
             and p.prosecdef and p.proconfig @> array['search_path=""']) = 4,
    'POSTCHECK: the 4 functions must be SECURITY DEFINER with search_path pinned';
end $$;
\echo 'POSTCHECK: passed'

select :'finish' = 'commit' as do_commit \gset
\if :do_commit
commit;
\echo 'RESULT: COMMITTED'
\else
rollback;
\echo 'RESULT: ROLLED BACK (dry run)'
\endif
