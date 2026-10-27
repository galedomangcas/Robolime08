-- RoboLime online claim flow (decision D52, OPEN_ITEMS #14). Additive to the
-- cloud-mirror schema 20261023000000; changes no existing object.
--
-- How an online user gets read access to one robot's synchronised records:
--  1. The operator creates a CLOUD claim code on the gateway laptop
--     (`npm run cloud:claim-code`). Only its SHA-256 leaves the laptop, sent
--     with the gateway's service_role key to provision_robot_claim_code().
--     The cloud claim code is separate from the local pairing code.
--  2. The online app signs in anonymously (Supabase Auth; no email, phone or
--     third-party identity, CLAUDE.md §4) and calls claim_robot(code).
--  3. claim_robot() verifies the code server-side, rate-limits failures, and
--     only then inserts the user's robot_claims row. The client never names a
--     robot id and can never write robot_claims directly.
-- Possession of the claim code is the deliberately limited single-owner
-- credential (D15/D52); it is not multi-user authentication.

-- ------------------------------------------------------- claim code verifiers
create table private.robot_claim_codes (
  id           bigint generated always as identity primary key,
  robot_id     uuid not null references public.robots (id) on delete cascade,
  code_sha256  text not null check (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  revoked_at   timestamptz
);
-- At most one active code per robot.
create unique index robot_claim_codes_one_active on private.robot_claim_codes (robot_id) where revoked_at is null;
create index robot_claim_codes_hash on private.robot_claim_codes (code_sha256) where revoked_at is null;

-- Failed and successful claim attempts, for rate limiting and audit. No code is stored.
create table private.claim_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  attempted_at timestamptz not null default now(),
  succeeded    boolean not null
);
create index claim_attempts_recent on private.claim_attempts (attempted_at);
create index claim_attempts_user on private.claim_attempts (user_id, attempted_at);

alter table private.robot_claim_codes enable row level security;
alter table private.claim_attempts enable row level security;
revoke all on table private.robot_claim_codes from public, anon, authenticated, service_role;
revoke all on table private.claim_attempts from public, anon, authenticated, service_role;

-- ----------------------------------------------------------- claim_robot()
-- Returns 'claimed', 'invalid-code' or 'rate-limited' (never raises for a wrong
-- code, so the failed attempt is recorded). Limits: 5 failures per user and 30
-- failures overall within 15 minutes (anonymous users are cheap to create, so
-- the overall limit is what bounds guessing).
create function public.claim_robot(p_code text)
returns table (result text, robot_id uuid, display_name text, is_synthetic boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_hash text;
  v_robot uuid;
begin
  if v_user is null then
    raise exception 'sign-in required' using errcode = '28000';
  end if;
  if (select count(*) from private.claim_attempts a
       where a.user_id = v_user and not a.succeeded and a.attempted_at > now() - interval '15 minutes') >= 5
     or (select count(*) from private.claim_attempts a
       where not a.succeeded and a.attempted_at > now() - interval '15 minutes') >= 30 then
    return query select 'rate-limited'::text, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- Same normalisation as the gateway (normalizePairingCode): upper case, letters and
  -- digits only, Crockford look-alikes O -> 0 and I/L -> 1.
  v_hash := encode(sha256(convert_to(translate(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'OIL', '011'), 'UTF8')), 'hex');
  select c.robot_id into v_robot
    from private.robot_claim_codes c
   where c.code_sha256 = v_hash and c.revoked_at is null and (c.expires_at is null or c.expires_at > now());

  insert into private.claim_attempts (user_id, succeeded) values (v_user, v_robot is not null);
  if v_robot is null then
    return query select 'invalid-code'::text, null::uuid, null::text, null::boolean;
    return;
  end if;

  insert into public.robot_claims (user_id, robot_id, granted_by)
  values (v_user, v_robot, 'claim-code')
  on conflict on constraint robot_claims_pkey
  do update set revoked_at = null, granted_at = now(), granted_by = 'claim-code';

  return query select 'claimed'::text, r.id, r.display_name, r.is_synthetic from public.robots r where r.id = v_robot;
end
$$;

-- ---------------------------------------------- provision_robot_claim_code()
-- Gateway/operator only (service_role). Revokes the robot's previous code and
-- stores the new code's SHA-256. Existing claims are kept; revoke them with
-- revoke_robot_claims() if the old code leaked.
create function public.provision_robot_claim_code(p_source_robot_id text, p_code_sha256 text, p_expires_at timestamptz default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_robot uuid;
begin
  if p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'code hash must be 64 lowercase hex characters' using errcode = '22023';
  end if;
  select r.id into v_robot from public.robots r where r.source_robot_id = p_source_robot_id;
  if v_robot is null then
    raise exception 'robot % has not been synchronised to the cloud yet', p_source_robot_id using errcode = 'P0002';
  end if;
  update private.robot_claim_codes set revoked_at = now() where robot_id = v_robot and revoked_at is null;
  insert into private.robot_claim_codes (robot_id, code_sha256, expires_at) values (v_robot, p_code_sha256, p_expires_at);
  return v_robot;
end
$$;

-- Gateway/operator only (service_role): ends every online claim on a robot.
create function public.revoke_robot_claims(p_source_robot_id text)
returns integer
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.robot_claims c set revoked_at = now()
      from public.robots r
     where r.id = c.robot_id and r.source_robot_id = p_source_robot_id and c.revoked_at is null
    returning 1
  )
  select count(*)::integer from done
$$;

revoke all on function public.claim_robot(text) from public, anon;
revoke all on function public.provision_robot_claim_code(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_robot_claims(text) from public, anon, authenticated;
grant execute on function public.claim_robot(text) to authenticated;
grant execute on function public.provision_robot_claim_code(text, text, timestamptz) to service_role;
grant execute on function public.revoke_robot_claims(text) to service_role;
