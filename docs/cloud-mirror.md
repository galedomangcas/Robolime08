# Hosted Supabase cloud mirror

Status: **schema, RLS and generated types (Phase 2); sync worker implemented
(Phase 4, M6b–M6d, decision D35), tested against an in-process fake PostgREST
and, once (A2, 2026-10-25), against a throwaway local PostgreSQL 17.5 with
standalone PostgREST 16.4** (see "Local real-target verification" below).
Nothing has been applied to the hosted Supabase project, and the worker has
never contacted it or the official local Supabase stack.

The cloud is a **one-way mirror** (gateway → Supabase) for online access when
internet is available. Field operation never depends on it.

## Files

| Path | Purpose |
|---|---|
| `supabase/config.toml` | Local Supabase CLI config from `supabase init` (local stack only; seeds the synthetic demo on local `db reset`) |
| `supabase/migrations/20261022000000_remove_legacy_hosted_schema.sql` | Removes the legacy hosted RoboLime objects before the target is installed (D42); designed to change nothing on a fresh database (not yet run) |
| `supabase/migrations/20261023000000_cloud_mirror_initial.sql` | Cloud schema, integrity triggers, grants, RLS |
| `supabase/seeds/demo_synthetic.sql` | **Generated** synthetic demo seed (same IDs as the SQLite demo) |
| `supabase/tests/rls_robot_scope.test.sql` | Migration + RLS assertions (runs in a rolled-back transaction) |
| `supabase/tests/plain_postgres_auth_shim.sql` | **Test-only** emulation of Supabase roles/`auth.uid()` for plain PostgreSQL |
| `supabase/tests/run-local-postgres.mjs` | Creates a throwaway local cluster, applies everything, runs the tests |
| `packages/shared/src/generated/database.types.ts` | **Generated** Supabase TypeScript types (`CloudDatabase`) |

## Mapping SQLite → PostgreSQL

Primary keys are copied unchanged (deterministic UUIDv5 from the gateway), so
`insert … on conflict do nothing` is idempotent and the reading natural key
`(run_id, cell_index, seq)` is unique in both stores.

| SQLite | PostgreSQL |
|---|---|
| `TEXT` UUID | `uuid` |
| `TEXT` canonical UTC timestamp | `timestamptz` |
| `REAL` | `double precision` (exact round-trip) |
| `INTEGER` 0/1 flag | `boolean` |
| `TEXT` JSON (`inputs_json`, `reasons_json`) | `jsonb` (`inputs`, `reasons`) |
| — | `cloud_received_at timestamptz default now()` (assigned by the cloud) |
| `readings`, `field_cells`, `recommendations`, `recommendation_scores` | add denormalised `robot_id` for RLS, kept consistent by composite foreign keys |

The mapping lives in `apps/gateway/src/sync/cloudRows.ts`. Its column lists
are type-checked against the generated `CloudDatabase` types, so a column the
cloud schema does not have (or is missing) fails `npm run typecheck`.

**Local-only (never uploaded):** pairing credentials, local sessions, field
selections, reading receipts, the sync outbox, gateway settings, migration
history. **Cloud-only:** `robot_claims`.

### When is a record "synced"?

Only after the gateway **reads the aggregate back** from the cloud and finds
every row it sent with identical content and no extra rows (D35). The outbox
entry then becomes `synced` with the root row's cloud-assigned
`cloud_received_at`. An attempted upload, a 2xx status, a timeout, or a queued
request never counts. See the state machine in `local-gateway.md`.

## Sync worker (Phase 4, D35)

| Path | Purpose |
|---|---|
| `apps/gateway/src/sync/confirmation.ts` | Outcome contract: failure classification, read-back verification, retry backoff |
| `apps/gateway/src/sync/cloudContract.ts` | Cloud primary keys, read-back columns, root tables (type-checked) |
| `apps/gateway/src/sync/postgrest.ts` | `fetch` transport, target validation, redacted credential |
| `apps/gateway/src/sync/uploadEntity.ts` | Insert one aggregate, read it back, verify |
| `apps/gateway/src/sync/worker.ts` | Lease-holding cycle and long-running worker |
| `apps/gateway/src/cli/sync.ts` | Opt-in command (not yet an npm script) |
| `apps/gateway/src/test/fakePostgrest.ts` | **Test double** of PostgREST used by the sync tests |

Run (gateway machine only; reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`):

```bash
cd apps/gateway
npx tsx src/cli/sync.ts --db <file> --once   # one pass, then exit
npx tsx src/cli/sync.ts --db <file>          # until Ctrl+C
```

Requests: `POST /rest/v1/<table>?on_conflict=<primary key>` with
`Prefer: resolution=ignore-duplicates,return=representation`, then
`GET /rest/v1/<table>?select=*&<column>=eq.<entity id>` with
`Prefer: count=exact`. A demo database refuses any non-loopback target;
`https` is required except for a loopback test target. Redirects are never
followed. **Server prerequisite:** PostgREST's row cap (`db-max-rows`,
Supabase default 1000) must be at least the largest aggregate table, or that
aggregate retries as `read_truncated` and never confirms.

Not yet verified: the official Supabase stack (Docker, OPEN_ITEMS #17) and
the hosted project. A plain PostgreSQL + PostgREST target was verified locally
(next section).

### Local real-target verification (A2, 2026-10-25)

**What ran:** the opt-in harness `supabase/tests/run-sync-integration.mjs`
(with `supabase/tests/sync_proxy.mjs` and
`apps/gateway/src/sync/worker.integration.test.ts`; the R14 case and the
proxy's `hold_after_commit` fault were added to the last two files later)
created a throwaway PostgreSQL 17.5 cluster on
`127.0.0.1` (its data directory verified before use), applied the test-only
auth shim and the cloud-mirror migration (no seed), and started two standalone
**PostgREST 16.4** servers on loopback (one with `db-max-rows = 5`). PostgREST
16.4 is the version the pinned Supabase CLI 2.121.0 uses. Each server was
accepted only after its unauthenticated root response carried a per-run nonce
written as the schema comment. Tokens were HS256 test tokens signed with a
per-run throwaway secret; no real credential, `.env` file, hosted service,
Docker, LAN or hardware was used. The demo (synthetic) dataset was synced from
an in-memory demo database, which the worker only allows to sync to loopback.
On Windows the PostgREST build needs `libpq.dll`, so PostgreSQL's `bin` folder
was added to `PATH` for that command only:

```bash
PATH="/c/Program Files/PostgreSQL/17/bin:$PATH" \
POSTGREST_BIN="<path to postgrest.exe>" node supabase/tests/run-sync-integration.mjs
```

**Result:** 12 of 12 integration tests passed in one run; a later run of the
same harness with R14 added passed 13 of 13. After each run the harness
stopped both PostgREST processes and the cluster and deleted its temporary
directory (afterwards: no PostgREST process, no listening test port, no
leftover directory). A pre-existing PostgreSQL Windows service on the machine
was not used, stopped or changed.

| Case | Verified behaviour |
|---|---|
| R1/R11 | Full sync, parents first under real foreign keys; cloud row counts equal local; `cloud_confirmed_at` equals the cloud's `cloud_received_at` (one entry per type) |
| R2 | Replaying everything adds no rows; every entry confirmed as a duplicate |
| R3/R4 | Insert `201` (`Content-Range: */*`), a repeat returns 0 rows; complete read `200` with `0-0/1` |
| R5/R6 | Row-capped read returns **206** with `Content-Range: 0-4/20`, classified `read_truncated` and never confirmed; insert responses are **not** row-capped (20 of 20 reported) |
| R7 | Wrongly signed token and `anon`-role token both `auth_rejected` |
| R8 | Natural-key clash `identity_conflict`; children not uploaded |
| R9 | Changed cloud content, re-queued, `content_conflict` |
| R10 | Dosing-only trigger and immutable-reading update both returned `400` / `23514`; only the dosing-only rejection was asserted through the worker's classifier (`row_rejected`) |
| R12 | Response lost after commit: `outcome_unknown`, then confirmed as a duplicate; one row |
| R13 | Refused connection (`ECONNREFUSED`): `network_unavailable`, untried claims back to `pending`; exactly once after recovery |
| R15 | Lease lost during a request (injected clock): stale worker records nothing; new owner confirms |
| R16 | Partial aggregate (503 on its second table) never confirmed; completed on retry |
| R14 | Restart across two real OS processes with real lease expiry (details below) |

**R14 (two real processes, real lease expiry, no injected clock).** Both
processes are the real sync CLI (`src/cli/sync.ts --once`) on the same
demo-purpose SQLite file. Process A was killed (`taskkill /T /F`) after the
cloud had committed its robot insert but before A received the response, with
that entry still `syncing` under A's lease; A's process was confirmed gone and
the lease and claim were left unchanged. Process B, started while A's lease
was still valid, exited 1 with "Another sync worker holds the lease until
<A's expiry>" and changed nothing. After the stored expiry time had passed, B
took over: its first run confirmed the robot entry as already in the cloud
(attempt 2, no duplicate row) and released the lease, and further `--once`
runs completed the rest. All 48 outbox entries ended `synced`, the lease table
was empty, every `cloud_confirmed_at` equalled the cloud's
`cloud_received_at`, cloud row counts and root-table ID sets matched the local
data exactly, and the cloud held one robot row. This verifies the documented
local scenario (a forced process stop, one shared SQLite file, one machine
clock); it does not cover other failure modes such as power loss during a
SQLite write, clock changes or a second machine.

**Not covered by these runs:** the Supabase API gateway (`apikey` handling),
real Supabase roles (the runs used the test-only auth shim), Supabase key
formats, the official local stack and the hosted project (OPEN_ITEMS #17).
This is not an official Supabase verification.

## Authorization model (RLS)

- **Writes:** only the gateway, using its privileged key (`service_role`,
  which bypasses RLS) from the laptop environment. `anon` and `authenticated`
  have **no** INSERT/UPDATE/DELETE privilege on any table.
- **Reads:** `authenticated` users see a robot's rows only when
  `public.robot_claims` holds an active (non-revoked) claim for
  `(auth.uid(), robot_id)`. Checked by `private.has_robot_claim()`
  (`SECURITY DEFINER`, pinned `search_path`, not exposed via the API schema).
- Rule tables are shared reference data, readable by any user holding at
  least one active claim.
- `anon` has no table access at all.
- Mirrored readings, status reports, recommendations, scores and rule content
  are immutable (update triggers); recommendations must belong to dosing runs;
  synthetic rule sets can never be approved.

### Trusted claim boundary

There is **no client-writable path to `robot_claims`**. A claim can only be
created by a trusted process using the service role (e.g. an operator script
or a future server-side claim function). The online pairing/claim flow is
**not implemented** (OPEN_ITEMS #14). Until it is, online clients see no
robot data unless an operator grants a claim by hand. This does not affect
offline local pairing at all.

## Local validation (no hosted project involved)

```bash
npm run db:cloud:test    # throwaway PostgreSQL: shim + migrations + seed + RLS tests
npm run db:cloud:types   # same, then regenerates packages/shared/src/generated/database.types.ts
```

The runner creates a fresh cluster in a temp directory, binds it to
`127.0.0.1:54329` (override with `PGTEST_PORT`), and deletes it afterwards. It
never reads a connection string or credentials from the environment, and
before applying anything it verifies that the server on that port reports the
throwaway cluster's own `data_directory`; if anything else is listening there
it stops. It therefore cannot reach the hosted project. It needs PostgreSQL
server binaries (`initdb`, `pg_ctl`, `psql`); set `PG_BIN` if they are not on
`PATH`. On Windows it defaults to `C:\Program Files\PostgreSQL\17\bin`.

`db:cloud:types` runs `npx supabase@2.121.0 gen types typescript --db-url
postgresql://postgres@127.0.0.1:<port>/postgres?sslmode=disable --schema public`
against that same throwaway cluster, after the RLS tests pass. This path was
verified to work **without Docker**; the first run downloads the pinned CLI
(internet needed once). The output is written with a "GENERATED" header and
only trailing whitespace stripped. Because the cluster uses the test-only
auth shim, the generated types cover the `public` schema only.

Covered by `rls_robot_scope.test.sql`: RLS enabled on every table; a claimed
user sees exactly its robot's rows (robots, fields, cells, runs, readings,
status, recommendations, scores, claims); clients cannot create/modify claims
or write any table; a second user sees only its robot; users with no claim,
a revoked claim, or no JWT subject see nothing; `anon` is denied; service-role
replay is idempotent; duplicate natural keys and wrong-robot attribution are
rejected; readings are immutable; verification runs cannot get
recommendations; synthetic rule sets cannot be approved.

A mutation check was run once by hand during development: weakening the
readings policy to `using (true)` made the suite fail at "u_demo: 39
readings", confirming the assertions bite. (Repeat it the same way on a
throwaway cluster only; never edit policies on a shared database.)

### Differences from a real Supabase stack — official stack NOT RUN

The shim emulates `anon`/`authenticated`/`service_role`, `auth.users`,
`auth.uid()` (from `request.jwt.claim.sub`) and Supabase's default grants. It
does not run PostgREST, GoTrue or real JWT verification, so these are
**database-level RLS tests, not Supabase integration tests**. The official
local Supabase stack has **not been run** for this project (Docker was not
running; OPEN_ITEMS #17). Before relying on the hosted project, repeat the
tests on the official local stack (requires Docker, and approval to start it):

```bash
npx supabase@2.121.0 start            # needs Docker Desktop running
npx supabase@2.121.0 db reset         # LOCAL: applies migrations + synthetic seed
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls_robot_scope.test.sql
npx supabase@2.121.0 gen types typescript --local --schema public
```

## Legacy hosted schema cleanup (D42)

The hosted project already holds an earlier RoboLime schema whose table names
collide with the target migration. `20261022000000_remove_legacy_hosted_schema.sql`
drops only the legacy objects found by read-only hosted catalog checks
(3 views, 17 tables, 2 sequences, all 9 legacy routines), by explicit name
and routine signature, with no `CASCADE` or dynamic SQL. Its guard refuses
to run when target objects are detected (see the migration header for the
exact checks and the one undetected case). Objects outside its list that
depend on a listed object make it fail instead of being removed. Its safety
properties and the target's authorization scope are pinned by static tests
in `apps/gateway/src/sync/cloudMigrations.test.ts`; those read the SQL text
only and do not prove that it executes.

It has run once, on a fresh throwaway database (`npm run db:cloud:test`,
2026-10-27): every drop was skipped, the target installed and the RLS tests
passed. A limited database-level rehearsal on 2026-10-27 then restored the
legacy `public`/`private` schemas from the hosted backup into an isolated
`supabase/postgres:17.11.0.006` container and ran both files in one
transaction successfully (`PHASE4_final_report_20261027.md`); Supabase
services were not running, and nothing was applied to the hosted project.
Both local runners
(`run-local-postgres.mjs`, `run-sync-integration.mjs`) apply every file in
`migrations/` in file-name order with plain `psql -f`, without a wrapping
transaction or a history table, so their next run would apply it first.
File-name order is not migration history: how a Supabase CLI or other tool
records versions on the hosted project (which has no history table) is
unverified. Before any hosted run, rehearse on a separate approved
environment, after a provenance-recorded backup, applying both files in one
transaction.

## Production restrictions

Do **not** run `supabase link`, `supabase db push`, `supabase db reset
--linked`, `supabase config push`, or any seed against the hosted project
without explicit team approval. Seeds are synthetic and for local databases
only. The service-role key stays in the gateway's environment and must never
appear in the Expo app, the web bundle, Git, or chat.
