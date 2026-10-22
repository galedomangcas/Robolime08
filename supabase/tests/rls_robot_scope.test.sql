-- RoboLime cloud-mirror migration + RLS tests. LOCAL/THROWAWAY DATABASES ONLY.
--
-- Preconditions: migrations applied and supabase/seeds/demo_synthetic.sql
-- loaded (one synthetic demo robot: 2 runs, 39 readings, 3 status reports,
-- 20 cells, 1 recommendation with 6 scores, 1 rule set).
-- Everything runs inside one transaction that is rolled back at the end.
-- Run with: psql -v ON_ERROR_STOP=1 -f rls_robot_scope.test.sql

\set ON_ERROR_STOP on
begin;

-- ---------------------------------------------------------------- fixtures
-- u_demo: claim on the demo robot; u_other: claim on a second robot;
-- u_none: no claim; u_revoked: revoked claim on the demo robot.
insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');

insert into public.robots (id, source_robot_id, display_name, is_synthetic, created_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'TEST-OTHER-ROBOT', 'Other test robot', true, now());
insert into public.runs (id, robot_id, source_run_id, run_type, gateway_first_received_at, is_synthetic)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'OTHER-RUN', 'dosing', now(), true);
insert into public.readings (id, run_id, robot_id, cell_index, seq, attempt_count, ph, ec, moisture_percent,
  temperature_c, dose_volume_ml, raw_flags, robot_recorded_at, gateway_received_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 0, 1, 5.5, 0.3, 25, 27, 50, 0, now(), now());

insert into public.robot_claims (user_id, robot_id, granted_by)
select '11111111-1111-4111-8111-111111111111', id, 'rls-test' from public.robots where source_robot_id = 'SYNTHETIC-DEMO-ROBOT';
insert into public.robot_claims (user_id, robot_id, granted_by)
values ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rls-test');
insert into public.robot_claims (user_id, robot_id, granted_by, revoked_at)
select '44444444-4444-4444-8444-444444444444', id, 'rls-test', now() from public.robots where source_robot_id = 'SYNTHETIC-DEMO-ROBOT';

-- ------------------------------------------- RLS is enabled everywhere
do $$
begin
  assert (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) = 0,
    'every public table must have RLS enabled';
  assert not has_table_privilege('anon', 'public.readings', 'select'), 'anon must not read readings';
  assert not has_table_privilege('authenticated', 'public.robot_claims', 'insert'), 'clients must not insert claims';
  assert not has_table_privilege('authenticated', 'public.readings', 'insert,update,delete'), 'clients must not write';
end $$;

-- ------------------------------------- 1. claimed user sees only own robot
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
do $$
begin
  assert (select count(*) from public.robots) = 1, 'u_demo: 1 robot';
  assert (select source_robot_id from public.robots) = 'SYNTHETIC-DEMO-ROBOT', 'u_demo: demo robot only';
  assert (select count(*) from public.readings) = 39, 'u_demo: 39 readings';
  assert (select count(*) from public.readings where robot_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 0, 'u_demo: no foreign readings';
  assert (select count(*) from public.runs) = 2, 'u_demo: 2 runs';
  assert (select count(*) from public.fields) = 1, 'u_demo: 1 field';
  assert (select count(*) from public.field_cells) = 20, 'u_demo: 20 cells';
  assert (select count(*) from public.robot_status_reports) = 3, 'u_demo: 3 status reports';
  assert (select count(*) from public.recommendations) = 1, 'u_demo: 1 recommendation';
  assert (select count(*) from public.recommendation_scores) = 6, 'u_demo: 6 scores';
  assert (select count(*) from public.rule_sets) = 1, 'u_demo: rule set visible';
  assert (select count(*) from public.robot_claims) = 1, 'u_demo: own claim only';
  assert not private.has_robot_claim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'u_demo: no claim on other robot';
end $$;

-- ------------------------------------- 2. clients cannot write or self-claim
do $$
begin
  begin
    insert into public.robot_claims (user_id, robot_id, granted_by)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'self');
    raise exception 'FAIL: client created its own robot claim';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.robot_claims set revoked_at = null;
    raise exception 'FAIL: client modified a claim';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.readings set ph = 7;
    raise exception 'FAIL: client updated readings';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.runs;
    raise exception 'FAIL: client deleted runs';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.robots (id, source_robot_id, display_name, created_at)
    values (gen_random_uuid(), 'EVIL', 'x', now());
    raise exception 'FAIL: client inserted a robot';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------- 3. other user sees only the other robot
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
do $$
begin
  assert (select count(*) from public.robots) = 1, 'u_other: 1 robot';
  assert (select source_robot_id from public.robots) = 'TEST-OTHER-ROBOT', 'u_other: own robot';
  assert (select count(*) from public.readings) = 1, 'u_other: 1 reading';
  assert (select count(*) from public.recommendations) = 0, 'u_other: no demo recommendation';
  assert (select count(*) from public.field_cells) = 0, 'u_other: no demo cells';
  assert (select count(*) from public.robot_claims) = 1, 'u_other: own claim only';
end $$;
reset role;

-- ------------------------------------- 4. no claim / revoked claim: nothing
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
do $$
begin
  assert (select count(*) from public.robots) = 0, 'u_none: no robots';
  assert (select count(*) from public.readings) = 0, 'u_none: no readings';
  assert (select count(*) from public.rule_sets) = 0, 'u_none: no rule sets';
  assert (select count(*) from public.robot_claims) = 0, 'u_none: no claims';
end $$;
set local "request.jwt.claim.sub" = '44444444-4444-4444-8444-444444444444';
do $$
begin
  assert (select count(*) from public.robots) = 0, 'u_revoked: no robots';
  assert (select count(*) from public.readings) = 0, 'u_revoked: no readings';
  assert (select count(*) from public.robot_claims) = 0, 'u_revoked: revoked claim hidden';
end $$;
-- Exhaustive: the revoked user sees zero rows in EVERY public table.
do $$
declare
  t text;
  n bigint;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('select count(*) from public.%I', t) into n;
    assert n = 0, format('u_revoked can see %s rows in %s', n, t);
  end loop;
end $$;
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
do $$
declare
  t text;
  n bigint;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('select count(*) from public.%I', t) into n;
    assert n = 0, format('u_none can see %s rows in %s', n, t);
  end loop;
end $$;
-- An authenticated request without a subject sees nothing.
set local "request.jwt.claim.sub" = '';
do $$
begin
  assert (select count(*) from public.readings) = 0, 'no subject: no readings';
end $$;
reset role;

-- ------------------------------------- 5. anon has no table access at all
set local role anon;
do $$
begin
  begin
    perform count(*) from public.readings;
    raise exception 'FAIL: anon read readings';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.robot_claims;
    raise exception 'FAIL: anon read claims';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------- 6. gateway (service_role) mirror semantics
set local role service_role;
do $$
declare
  demo_run uuid;
  verify_run uuid;
  demo_robot uuid;
  sample public.readings%rowtype;
begin
  assert (select count(*) from public.readings) = 40, 'service_role sees all readings';
  select * into sample from public.readings where robot_id <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' limit 1;

  -- Idempotent replay of an existing row is a no-op.
  insert into public.readings select sample.* on conflict do nothing;
  assert (select count(*) from public.readings) = 40, 'replay must not duplicate';

  -- Same logical key (run, cell, seq) under a different id is rejected.
  begin
    insert into public.readings (id, run_id, robot_id, cell_index, seq, attempt_count, ph, ec, moisture_percent,
      temperature_c, dose_volume_ml, raw_flags, robot_recorded_at, gateway_received_at)
    values (gen_random_uuid(), sample.run_id, sample.robot_id, sample.cell_index, sample.seq, 1, 5, 0, 0, 0, 0, 0, now(), now());
    raise exception 'FAIL: duplicate natural key accepted';
  exception when unique_violation then null;
  end;

  -- robot_id must match the run's robot.
  begin
    insert into public.readings (id, run_id, robot_id, cell_index, seq, attempt_count, ph, ec, moisture_percent,
      temperature_c, dose_volume_ml, raw_flags, robot_recorded_at, gateway_received_at)
    values (gen_random_uuid(), sample.run_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 99, 0, 1, 5, 0, 0, 0, 0, 0, now(), now());
    raise exception 'FAIL: reading attributed to the wrong robot';
  exception when foreign_key_violation then null;
  end;

  -- Mirrored readings are immutable.
  begin
    update public.readings set ph = 7 where id = sample.id;
    raise exception 'FAIL: reading updated';
  exception when check_violation then null;
  end;

  -- Verification runs never get recommendations.
  select id, robot_id into verify_run, demo_robot from public.runs where run_type = 'verification' limit 1;
  begin
    insert into public.recommendations (id, run_id, robot_id, rule_set_id, inputs, weather_source, computed_at)
    select gen_random_uuid(), verify_run, demo_robot, id, '{}'::jsonb, 'seasonal-defaults', now() from public.rule_sets limit 1;
    raise exception 'FAIL: recommendation stored for a verification run';
  exception when check_violation then null;
  end;

  -- Synthetic rule sets can never be approved.
  begin
    update public.rule_sets set status = 'approved', approved_at = now() where is_synthetic;
    raise exception 'FAIL: synthetic rule set approved';
  exception when check_violation then null;
  end;

  select id into demo_run from public.runs where run_type = 'dosing' and robot_id = demo_robot;
  assert (select count(*) from public.recommendations where run_id = demo_run) = 1, 'one recommendation per dosing run';
end $$;
reset role;

rollback;
\echo 'RLS AND MIGRATION TESTS PASSED'
