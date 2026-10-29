-- RoboLime online manual control relay tests (D58). LOCAL/THROWAWAY DATABASES ONLY.
-- Preconditions: all migrations applied and supabase/seeds/demo_synthetic.sql
-- loaded. Everything runs in one transaction that is rolled back.

\set ON_ERROR_STOP on
begin;

-- User 8 holds a claim on the demo robot; user 9 holds none.
insert into auth.users (id) values
  ('88888888-8888-4888-8888-888888888888'),
  ('99999999-9999-4999-8999-999999999999');
insert into public.robot_claims (user_id, robot_id, granted_by)
values ('88888888-8888-4888-8888-888888888888', '458df5a8-212c-54c7-ac9b-364ab56d03b3', 'test');

-- ------------------------------------------- privileges (catalog checks)
do $$
begin
  assert has_function_privilege('authenticated', 'public.request_manual_command(uuid, text)', 'execute'), 'clients request commands';
  assert not has_function_privilege('anon', 'public.request_manual_command(uuid, text)', 'execute'), 'anon cannot command';
  assert has_function_privilege('authenticated', 'public.manual_relay_status(uuid)', 'execute'), 'clients read relay status';
  assert not has_function_privilege('authenticated', 'public.take_manual_commands(text, text, integer)', 'execute'), 'clients cannot take';
  assert not has_function_privilege('authenticated', 'public.finish_manual_command(uuid, text)', 'execute'), 'clients cannot finish';
  assert has_function_privilege('service_role', 'public.take_manual_commands(text, text, integer)', 'execute'), 'gateway takes';
  assert not has_table_privilege('authenticated', 'public.manual_commands', 'insert'), 'no direct insert';
  assert not has_table_privilege('authenticated', 'public.manual_commands', 'update'), 'no direct update';
  assert not has_table_privilege('authenticated', 'public.manual_relay_heartbeats', 'insert,update'), 'clients cannot fake a heartbeat';
  assert not has_table_privilege('anon', 'public.manual_commands', 'select'), 'anon reads nothing';
end $$;

-- ------------------------------------------------ unclaimed user refused
set local role authenticated;
set local "request.jwt.claim.sub" = '99999999-9999-4999-8999-999999999999';
do $$
begin
  perform public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'STOP_ALL');
  raise exception 'a user without a claim must be refused';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  assert (select count(*) from public.manual_relay_status('458df5a8-212c-54c7-ac9b-364ab56d03b3')) = 0, 'no status without a claim';
end $$;
reset role;

-- -------------------------------------------------- claimed user requests
set local role authenticated;
set local "request.jwt.claim.sub" = '88888888-8888-4888-8888-888888888888';
do $$
declare
  r record;
begin
  select * into r from public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'DRIVE:FORWARD:127');
  assert r.result = 'queued' and r.id is not null, 'claimed user queues a command';
  begin
    perform public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'DRIVE:UP:127');
    raise exception 'an invalid line must be refused';
  exception when check_violation then null;
  end;
  begin
    perform public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'DRIVE:FORWARD:256');
    raise exception 'PWM above 255 must be refused';
  exception when check_violation then null;
  end;
  perform public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'STOP_ALL');
  assert (select count(*) from public.manual_commands) = 2, 'claimed user sees own robot commands';
end $$;
reset role;

-- The unclaimed user sees none of them.
set local role authenticated;
set local "request.jwt.claim.sub" = '99999999-9999-4999-8999-999999999999';
do $$
begin
  assert (select count(*) from public.manual_commands) = 0, 'RLS hides other robots'' commands';
end $$;
reset role;

-- ------------------------------------------------------- gateway relay
set local role service_role;
do $$
declare
  r record;
  n integer;
begin
  -- Bridge connected: the newest pending (STOP_ALL) is handed over, the older drive superseded.
  select count(*) into n from public.take_manual_commands('SYNTHETIC-DEMO-ROBOT', 'connected', 10);
  assert n = 1, 'one command handed over';
  assert (select status from public.manual_commands where line = 'STOP_ALL') = 'sent', 'newest is sent';
  assert (select status from public.manual_commands where line = 'DRIVE:FORWARD:127') = 'superseded', 'older is superseded';
  select id into r from public.manual_commands where line = 'STOP_ALL';
  assert public.finish_manual_command(r.id, 'acknowledged'), 'sent command finishes';
  assert not public.finish_manual_command(r.id, 'no-ack'), 'a finished command cannot change';
  assert (select status from public.manual_commands where line = 'STOP_ALL') = 'acknowledged', 'verdict kept';

  -- A stale command is expired, never sent.
  insert into public.manual_commands (robot_id, requested_by, line, requested_at)
  values ('458df5a8-212c-54c7-ac9b-364ab56d03b3', '88888888-8888-4888-8888-888888888888', 'PUMP_ON', now() - interval '30 seconds');
  select count(*) into n from public.take_manual_commands('SYNTHETIC-DEMO-ROBOT', 'connected', 10);
  assert n = 0, 'stale command not handed over';
  assert (select status from public.manual_commands where line = 'PUMP_ON') = 'expired', 'stale command expired';

  -- Bridge not connected: pending commands are answered unavailable.
  insert into public.manual_commands (robot_id, requested_by, line)
  values ('458df5a8-212c-54c7-ac9b-364ab56d03b3', '88888888-8888-4888-8888-888888888888', 'PUMP_OFF');
  select count(*) into n from public.take_manual_commands('SYNTHETIC-DEMO-ROBOT', 'disconnected', 10);
  assert n = 0, 'nothing handed over without a bridge';
  assert (select status from public.manual_commands where line = 'PUMP_OFF') = 'unavailable', 'unavailable at once';

  begin
    perform public.take_manual_commands('NO-SUCH-ROBOT', 'connected', 10);
    raise exception 'unknown robot must be refused';
  exception when no_data_found then null;
  end;
  begin
    perform public.finish_manual_command(r.id, 'pending');
    raise exception 'invalid final status must be refused';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;

-- The claimed user now sees the heartbeat through the status function.
set local role authenticated;
set local "request.jwt.claim.sub" = '88888888-8888-4888-8888-888888888888';
do $$
declare
  r record;
begin
  select * into r from public.manual_relay_status('458df5a8-212c-54c7-ac9b-364ab56d03b3');
  assert r.bridge_state = 'disconnected', 'latest bridge state reported';
  assert r.seen_seconds_ago >= 0 and r.seen_seconds_ago < 60, 'age computed server-side';
end $$;

-- Rate limit: more than 60 commands a minute is refused without inserting.
do $$
declare
  i integer;
  r record;
begin
  for i in 1..60 loop
    perform public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'STOP_ALL');
  end loop;
  select * into r from public.request_manual_command('458df5a8-212c-54c7-ac9b-364ab56d03b3', 'STOP_ALL');
  assert r.result = 'rate-limited' and r.id is null, 'rate limited';
end $$;
reset role;

\echo 'manual_control.test.sql: all assertions passed'
rollback;
