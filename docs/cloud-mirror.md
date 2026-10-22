# Hosted Supabase cloud mirror

Status: **Phase 2 — schema, RLS, generated types, and local tests only.**
Nothing has been applied to the hosted Supabase project. The sync worker that
uploads records is Phase 4.

The cloud is a **one-way mirror** (gateway → Supabase) for online access when
internet is available. Field operation never depends on it.

## Files

| Path | Purpose |
|---|---|
| `supabase/config.toml` | Local Supabase CLI config from `supabase init` (local stack only; seeds the synthetic demo on local `db reset`) |
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

Only after a Supabase write **confirms** persistence and returns its
`cloud_received_at`; the gateway then marks the outbox entry `synced` with
that time. An attempted upload, a timeout, or a queued request never counts.
See the state machine in `local-gateway.md`.

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

## Production restrictions

Do **not** run `supabase link`, `supabase db push`, `supabase db reset
--linked`, `supabase config push`, or any seed against the hosted project
without explicit team approval. Seeds are synthetic and for local databases
only. The service-role key stays in the gateway's environment and must never
appear in the Expo app, the web bundle, Git, or chat.
