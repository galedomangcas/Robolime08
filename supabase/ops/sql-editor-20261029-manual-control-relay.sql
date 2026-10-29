-- RoboLime: SUPABASE SQL EDITOR version of
-- supabase/ops/apply-20261029-manual-control-relay.sql (decision D58).
-- Paste the WHOLE file into the Dashboard SQL Editor and click Run.
-- One transaction: if any check fails, the editor shows the error and NOTHING is changed.
-- Precheck: the cloud mirror and claim flow exist; the manual-control objects do not.
-- Then 20261029000000_manual_control_relay.sql, then the postcheck (RLS, grants, EXECUTE).
-- Generated from the two files above; do not edit by hand.

begin;
set local lock_timeout = '15s';
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

-- ===== 20261029000000_manual_control_relay.sql =====
-- RoboLime online manual control relay (decision D58). Additive; changes no
-- existing object.
--
-- Path: online app (Vercel / Android) -> request_manual_command() -> this
-- table -> the field gateway (service_role, polling take_manual_commands())
-- -> USB LoRa bridge -> robot. The gateway reports the outcome with
-- finish_manual_command(). It works only while the gateway laptop has
-- internet and the bridge is plugged in.
--
-- Who may command: any signed-in user holding an active claim on the robot
-- (D52 claim code). Clients never write the table directly.
-- Safety: a command older than 10 s when the gateway sees it is EXPIRED and
-- never sent (no stale command runs after a delay). The robot itself stops
-- every manual output 5 s after the last command (D57 firmware).

create table public.manual_commands (
  id           uuid primary key default gen_random_uuid(),
  -- Request order (requested_at can tie within one transaction).
  seq          bigint generated always as identity unique,
  robot_id     uuid not null references public.robots (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  -- Exactly the firmware text commands of packages/shared/src/protocol/manualControl.ts.
  line         text not null check (line ~ '^(STOP_ALL|DRIVE:(FORWARD|REVERSE|LEFT|RIGHT):(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])|ACTUATOR_(EXTEND|RETRACT)|PUMP_(ON|OFF))$'),
  status       text not null default 'pending'
               check (status in ('pending', 'sent', 'acknowledged', 'rejected', 'no-ack', 'superseded', 'expired', 'unavailable')),
  requested_at timestamptz not null default now(),
  picked_up_at timestamptz,
  finished_at  timestamptz
);
create index manual_commands_pending on public.manual_commands (robot_id, seq) where status = 'pending';
create index manual_commands_recent on public.manual_commands (robot_id, requested_at desc);
create index manual_commands_user on public.manual_commands (requested_by, requested_at);

-- Last time the gateway relay polled for a robot, and its bridge state then.
create table public.manual_relay_heartbeats (
  robot_id     uuid primary key references public.robots (id) on delete cascade,
  bridge_state text not null check (bridge_state in ('not-configured', 'connecting', 'connected', 'disconnected')),
  seen_at      timestamptz not null default now()
);

alter table public.manual_commands enable row level security;
alter table public.manual_relay_heartbeats enable row level security;
revoke all on table public.manual_commands from anon, authenticated;
revoke all on table public.manual_relay_heartbeats from anon, authenticated;
grant select on table public.manual_commands to authenticated;
grant select on table public.manual_relay_heartbeats to authenticated;
grant select, insert, update, delete on table public.manual_commands to service_role;
grant select, insert, update, delete on table public.manual_relay_heartbeats to service_role;

create policy "manual_commands: claimed robot only" on public.manual_commands
  for select to authenticated using ((select private.has_robot_claim(robot_id)));
-- The app reads heartbeats through manual_relay_status(), which computes the age server-side.
create policy "manual_relay_heartbeats: claimed robot only" on public.manual_relay_heartbeats
  for select to authenticated using ((select private.has_robot_claim(robot_id)));

-- --------------------------------------------------- request_manual_command()
-- Returns 'queued' with the new id, or 'rate-limited' (more than 60 commands
-- from this user in the last minute). Raises 42501 without a claim.
create function public.request_manual_command(p_robot_id uuid, p_line text)
returns table (result text, id uuid, requested_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'sign-in required' using errcode = '28000';
  end if;
  if not private.has_robot_claim(p_robot_id) then
    raise exception 'no claim on this robot' using errcode = '42501';
  end if;
  if (select count(*) from public.manual_commands m
       where m.requested_by = v_user and m.requested_at > now() - interval '1 minute') >= 60 then
    return query select 'rate-limited'::text, null::uuid, null::timestamptz;
    return;
  end if;
  return query
    insert into public.manual_commands as m (robot_id, requested_by, line)
    values (p_robot_id, v_user, p_line)
    returning 'queued'::text, m.id, m.requested_at;
end
$$;

-- ----------------------------------------------------- manual_relay_status()
-- For a claimed robot: the bridge state last reported by the gateway and how
-- many seconds ago (computed here, so client clocks do not matter). No row
-- if the gateway has never polled.
create function public.manual_relay_status(p_robot_id uuid)
returns table (bridge_state text, seen_seconds_ago double precision)
language sql stable security definer set search_path = '' as $$
  select h.bridge_state, extract(epoch from (now() - h.seen_at))::double precision
    from public.manual_relay_heartbeats h
   where h.robot_id = p_robot_id and private.has_robot_claim(p_robot_id)
$$;

-- --------------------------------------------------- take_manual_commands()
-- Gateway only (service_role). Records the heartbeat, expires commands older
-- than p_max_age_seconds, and, when the bridge is connected, hands over the
-- NEWEST pending command (older pending ones are superseded, as the bridge
-- itself does). When the bridge is not connected, pending commands are
-- answered 'unavailable' at once.
create function public.take_manual_commands(p_source_robot_id text, p_bridge_state text, p_max_age_seconds integer default 10)
returns table (id uuid, line text, requested_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_robot uuid;
  v_next uuid;
begin
  select r.id into v_robot from public.robots r where r.source_robot_id = p_source_robot_id;
  if v_robot is null then
    raise exception 'robot % has not been synchronised to the cloud yet', p_source_robot_id using errcode = 'P0002';
  end if;
  if p_max_age_seconds is null or p_max_age_seconds < 1 or p_max_age_seconds > 60 then
    raise exception 'max age must be 1-60 seconds' using errcode = '22023';
  end if;

  insert into public.manual_relay_heartbeats as h (robot_id, bridge_state, seen_at)
  values (v_robot, p_bridge_state, now())
  on conflict (robot_id) do update set bridge_state = excluded.bridge_state, seen_at = excluded.seen_at;

  update public.manual_commands m set status = 'expired', finished_at = now()
   where m.robot_id = v_robot and m.status = 'pending'
     and m.requested_at < now() - make_interval(secs => p_max_age_seconds);

  if p_bridge_state <> 'connected' then
    update public.manual_commands m set status = 'unavailable', finished_at = now()
     where m.robot_id = v_robot and m.status = 'pending';
    return;
  end if;

  select m.id into v_next from public.manual_commands m
   where m.robot_id = v_robot and m.status = 'pending'
   order by m.seq desc
   limit 1
   for update;
  if v_next is null then
    return;
  end if;

  update public.manual_commands m set status = 'superseded', finished_at = now()
   where m.robot_id = v_robot and m.status = 'pending' and m.id <> v_next;

  return query
    update public.manual_commands m set status = 'sent', picked_up_at = now()
     where m.id = v_next
    returning m.id, m.line, m.requested_at;
end
$$;

-- -------------------------------------------------- finish_manual_command()
-- Gateway only (service_role): the bridge's verdict for a command it took.
-- Only a 'sent' command can be finished; returns false otherwise.
create function public.finish_manual_command(p_id uuid, p_status text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('acknowledged', 'rejected', 'no-ack', 'superseded', 'unavailable') then
    raise exception 'invalid final status %', p_status using errcode = '22023';
  end if;
  update public.manual_commands m set status = p_status, finished_at = now()
   where m.id = p_id and m.status = 'sent';
  return found;
end
$$;

revoke all on function public.request_manual_command(uuid, text) from public, anon;
revoke all on function public.manual_relay_status(uuid) from public, anon;
revoke all on function public.take_manual_commands(text, text, integer) from public, anon, authenticated;
revoke all on function public.finish_manual_command(uuid, text) from public, anon, authenticated;
grant execute on function public.request_manual_command(uuid, text) to authenticated;
grant execute on function public.manual_relay_status(uuid) to authenticated;
grant execute on function public.take_manual_commands(text, text, integer) to service_role;
grant execute on function public.finish_manual_command(uuid, text) to service_role;

-- ===== postcheck =====
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

commit;
