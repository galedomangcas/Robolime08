-- RoboLime online claim flow tests (D52). LOCAL/THROWAWAY DATABASES ONLY.
-- Preconditions: all migrations applied and supabase/seeds/demo_synthetic.sql
-- loaded. Everything runs in one transaction that is rolled back.

\set ON_ERROR_STOP on
begin;

insert into auth.users (id) values
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666'),
  ('77777777-7777-4777-8777-777777777777');

-- ------------------------------------------- privileges (catalog checks)
do $$
begin
  assert has_function_privilege('authenticated', 'public.claim_robot(text)', 'execute'), 'authenticated can claim';
  assert not has_function_privilege('anon', 'public.claim_robot(text)', 'execute'), 'anon cannot claim';
  assert not has_function_privilege('authenticated', 'public.provision_robot_claim_code(text, text, timestamptz)', 'execute'),
    'clients cannot provision codes';
  assert not has_function_privilege('anon', 'public.provision_robot_claim_code(text, text, timestamptz)', 'execute'),
    'anon cannot provision codes';
  assert not has_function_privilege('authenticated', 'public.revoke_robot_claims(text)', 'execute'), 'clients cannot revoke';
  assert has_function_privilege('service_role', 'public.provision_robot_claim_code(text, text, timestamptz)', 'execute'),
    'service_role provisions codes';
  assert not has_table_privilege('authenticated', 'private.robot_claim_codes', 'select'), 'verifiers are not readable';
  assert not has_table_privilege('service_role', 'private.robot_claim_codes', 'select'), 'verifiers are not readable directly';
  assert not has_table_privilege('authenticated', 'private.claim_attempts', 'select,insert'), 'attempts are not reachable';
end $$;

-- ------------------------------------- provisioning (service_role only)
set local role service_role;
do $$
begin
  perform public.provision_robot_claim_code('NO-SUCH-ROBOT', repeat('a', 64));
  raise exception 'unknown robot must be refused';
exception when no_data_found then null;
end $$;
do $$
begin
  perform public.provision_robot_claim_code('SYNTHETIC-DEMO-ROBOT', 'not-a-hash');
  raise exception 'malformed hash must be refused';
exception when invalid_parameter_value then null;
end $$;
-- Old code, then the real one (which revokes the old).
select public.provision_robot_claim_code('SYNTHETIC-DEMO-ROBOT',
  encode(sha256(convert_to('OLDCODE1234', 'UTF8')), 'hex'));
select public.provision_robot_claim_code('SYNTHETIC-DEMO-ROBOT',
  encode(sha256(convert_to('ABCD2345EFGH', 'UTF8')), 'hex'));
reset role;
do $$
begin
  assert (select count(*) from private.robot_claim_codes where revoked_at is null) = 1, 'one active code';
end $$;

-- ------------------------------------------------- authenticated claims
set local role authenticated;
set local "request.jwt.claim.sub" = '55555555-5555-4555-8555-555555555555';
do $$
begin
  assert (select count(*) from public.readings) = 0, 'no claim yet: no readings';
  assert (select result from public.claim_robot('OLDCODE1234')) = 'invalid-code', 'revoked code refused';
  assert (select result from public.claim_robot('wrong-code')) = 'invalid-code', 'wrong code refused';
  assert (select count(*) from public.readings) = 0, 'failed claim grants nothing';
  -- Normalisation: lower case and separators are accepted.
  assert (select result from public.claim_robot('abcd-2345-efgh')) = 'claimed', 'valid code claims';
  assert (select count(*) from public.readings) = 39, 'claimed: synthetic readings visible';
  assert (select count(*) from public.robots) = 1, 'claimed: one robot';
  assert (select result from public.claim_robot('ABCD2345EFGH')) = 'claimed', 'repeat claim is idempotent';
  assert (select count(*) from public.robot_claims) = 1, 'one claim row';
end $$;
do $$
begin
  insert into public.robot_claims (user_id, robot_id, granted_by)
  select '55555555-5555-4555-8555-555555555555', id, 'client' from public.robots;
  raise exception 'clients must not insert claims directly';
exception when insufficient_privilege then null;
end $$;

-- Per-user rate limit: 5 failures within 15 minutes.
set local "request.jwt.claim.sub" = '66666666-6666-4666-8666-666666666666';
do $$
declare i int;
begin
  for i in 1..5 loop
    assert (select result from public.claim_robot('guess-' || i)) = 'invalid-code', 'guess refused';
  end loop;
  assert (select result from public.claim_robot('ABCD2345EFGH')) = 'rate-limited', 'limited even with the right code';
  assert (select count(*) from public.readings) = 0, 'rate-limited user sees nothing';
end $$;

-- No signed-in user: refused outright.
set local "request.jwt.claim.sub" = '';
do $$
begin
  perform public.claim_robot('ABCD2345EFGH');
  raise exception 'anonymous request must be refused';
exception when invalid_authorization_specification then null;
end $$;
reset role;

-- Overall limit: 30 failures across users within 15 minutes.
insert into private.claim_attempts (user_id, succeeded)
select '77777777-7777-4777-8777-777777777777', false from generate_series(1, 30);
update private.claim_attempts set user_id = gen_random_uuid() where user_id = '77777777-7777-4777-8777-777777777777';
set local role authenticated;
set local "request.jwt.claim.sub" = '77777777-7777-4777-8777-777777777777';
do $$
begin
  assert (select result from public.claim_robot('ABCD2345EFGH')) = 'rate-limited', 'overall limit applies';
end $$;
reset role;

-- --------------------------------------------- revocation (service_role)
set local role service_role;
do $$
begin
  assert public.revoke_robot_claims('SYNTHETIC-DEMO-ROBOT') = 1, 'one claim revoked';
end $$;
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '55555555-5555-4555-8555-555555555555';
do $$
begin
  assert (select count(*) from public.readings) = 0, 'revoked claim: no readings';
end $$;
reset role;

rollback;
\echo 'claim_flow.test.sql: all assertions passed'
