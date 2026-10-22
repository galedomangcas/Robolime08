# Local field gateway: storage, pairing, and API contract

Status: **Phase 2**. The durable SQLite store, migrations, local pairing,
sessions, the read-only API handler, the sync outbox contract, and demo
seeding are implemented and unit tested in `apps/gateway`. **Not built yet:**
the LoRa/USB receiver and packet decoder (Phase 3), the LAN HTTP server, ACK
loop, and cloud sync worker (Phase 4).

Everything in this document works with **no internet** and no Supabase.

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`; no native
  build step, so the same code runs on a laptop or Raspberry Pi).
- Install from the repository root: `npm install`.

## Commands

All commands accept `--db <file>`; most fall back to `GATEWAY_DB_PATH`. Only
`db:init` (field) and `db:seed:demo` (demo) create a database file.
`robot:provision`, `pairing:provision` and `db:backup` require an existing,
initialised gateway database, so a mistyped path fails instead of silently
creating (or "backing up") an empty database. `robot:provision` additionally
requires a `field` database.

| Purpose | Command |
|---|---|
| Create or migrate the **field** database (never seeds) | `npm run db:init -w @robolime/gateway -- --db <file>` |
| Register the robot this gateway serves | `npm run robot:provision -w @robolime/gateway -- --db <file> --source-id <firmware robot id> --name "<name>"` |
| Create a pairing code (shown once) | `npm run pairing:provision -w @robolime/gateway -- --db <file> --robot <firmware robot id>` |
| Back up the live database | `npm run db:backup -w @robolime/gateway -- --db <file> --out <new file>` |
| Load the **synthetic** demo dataset into a separate demo DB | `npm run db:seed:demo -w @robolime/gateway -- --db <demo file>` |
| Regenerate the cloud demo seed SQL | `npm run cloud-seed:generate -w @robolime/gateway` |
| Tests | `npm test -w @robolime/gateway` |

Field provisioning of the real field geometry (area, cell count, cell
centres) needs the surveyed values and has no CLI yet (OPEN_ITEMS #13).

## Database file and durability

- Every connection sets `foreign_keys=ON`, `journal_mode=WAL`,
  `synchronous=FULL`, `busy_timeout=5000`. With `synchronous=FULL`, a
  committed transaction survives power loss, which is what makes
  "write to SQLite, then ACK the robot" safe.
- Each database records its **purpose** (`field` or `demo`) in
  `gateway_settings`. The demo seeder refuses `field` databases, and a field
  database cannot be reopened as `demo`.
- Migrations live in `apps/gateway/migrations/NNNN_name.sql`, numbered
  consecutively, each applied in its own transaction and recorded in
  `schema_migrations` with a SHA-256 checksum (line endings normalised, so a
  Windows CRLF checkout matches a Pi LF checkout). The gateway refuses to
  start if an applied migration file was edited, or if the database was
  migrated by a newer build. **Never edit an applied migration; add a new one.**

## Schema (migration 0001)

| Table | Purpose | Mirrored to cloud? |
|---|---|---|
| `robots` | Robot identity; firmware ID kept as opaque text; `tank_capacity_ml` NULL until confirmed (≤ 5,000 mL) | yes |
| `fields`, `field_cells` | One active field per robot, cells by index; geometry from the operator | yes |
| `runs` | Dosing / verification run, unique per (robot, firmware run ID) | yes |
| `readings` | Immutable cell readings, unique `(run_id, cell_index, seq)` | yes |
| `reading_receipts` | Every received copy (attempt count, outcome, conflicting payload) | **local only** |
| `robot_status_reports` + view `robot_latest_status` | Immutable status history; latest by robot time | yes |
| `pairing_credentials` | Salted scrypt verifier of the pairing code | **local only** |
| `local_sessions` | SHA-256 of session secrets, expiry, revocation | **local only** |
| `field_selections` | Record of intent from the field-selection screen | **local only** |
| `rule_sets`, `rule_crops`, `rule_suitability_ranges`, `rule_seasons`, `rule_seasonal_weather_defaults` | Versioned recommendation rules | yes |
| `recommendations`, `recommendation_scores` | Immutable stored recommendation snapshots | yes |
| `sync_outbox` | Durable cloud-sync state per mirrored entity | **local only** |
| `gateway_settings`, `schema_migrations` | Purpose, seed marker, migration history | **local only** |

Selected rules enforced **by the database**, not just by code:

- Timestamps must be canonical UTC `YYYY-MM-DDTHH:MM:SS.sssZ`.
- Readings, status reports, recommendations and scores are immutable.
- A recommendation must belong to a **dosing** run; real runs need an
  **approved** rule set; synthetic rule sets can never be approved and only
  serve synthetic runs.
- Rule content is locked once its rule set leaves `draft` **or** any stored
  recommendation references it.
- `sync_outbox` only allows the transitions listed below, and `synced`
  requires `cloud_confirmed_at`.

### Three clocks

| Column(s) | Meaning | Use |
|---|---|---|
| `robot_recorded_at`, `robot_reported_at` | Robot-side time | The only user-facing measurement time |
| `gateway_received_at`, `gateway_first_received_at` | When this gateway durably stored the record | Delivery diagnostics |
| `sync_outbox.cloud_confirmed_at` | Cloud receipt time returned by Supabase after a confirmed write | Sync diagnostics |

How the firmware encodes robot time is part of the pending packet spec; the
Phase 3 decoder converts it before storage.

## Identity and idempotency

- IDs are **UUIDv5** values derived from natural keys under a fixed RoboLime
  namespace (`apps/gateway/src/db/ids.ts`):
  `robot(source_robot_id)`, `field(robot, field_key)`,
  `run(robot, source_run_id)`, **`reading(run_id, cell_index, seq)`**,
  `status(robot, robot time, state, cells_completed)`, `rule_set(version)`,
  `recommendation(run)`.
- The firmware run identifier is stored as `source_run_id` text and is **not**
  assumed to be a UUID; the internal `runs.id` is derived from it.
- Because IDs are derived, a gateway rebuilt from a robot-flash replay produces
  the same IDs, and the cloud mirror uses the very same primary keys.

`recordReading` (in one transaction):

| Situation | Outcome | Effect |
|---|---|---|
| First copy of `(run, cell, seq)` | `inserted` | Row stored, outbox row queued, receipt logged |
| Same key, identical payload (e.g. retry after a lost ACK) | `duplicate` | Stored row unchanged (keeps the first copy's attempt count); receipt logged |
| Same key, different payload | `conflict` | **Original kept**; differing payload logged in `reading_receipts` for review |
| Unknown robot | error `UNKNOWN_ROBOT` | Nothing stored (do not ACK) |
| Run already stored with the other run type | error `RUN_TYPE_MISMATCH` | Nothing stored |

Gaps, late and out-of-order arrivals are simply stored; no ordering is
assumed. Status reports (never retried by the robot) are keyed by
`(robot, robot time, state, cells_completed)`; a second report with the same
key is treated as a duplicate and ignored, even if other values differ
(acceptable while status packets are not retried; revisit with the packet spec). All three outcomes are durable when the call returns; whether a
`conflict` should be ACKed is decided with the firmware owner (OPEN_ITEMS #15).
The gateway never computes dose volume or expected post-correction pH.

## Sync outbox contract (local → cloud, one way)

Producers enqueue the entity **in the same transaction** that stores it.

```
pending ──claim──► syncing ──confirmed write──► synced
   ▲                  │  └──error/timeout──► failed ──retry due──► syncing
   └──restart recovery┘                                  synced ──content changed──► pending
```

- `markSynced` requires a `CloudConfirmation` (the server-side receipt time
  from a successful Supabase write) and only works on a `syncing` entry. An
  attempt alone can never produce `synced`.
- On startup, `recoverInterrupted` returns `syncing` entries to `pending`
  (outcome unknown); re-sending is safe because cloud writes are idempotent
  on the shared IDs.
- Entities sync parents first: robot → field → rule set → run → reading →
  status report → recommendation.
- The Phase 4 worker will implement retries/backoff and the actual upload.

## Local pairing and sessions

Threat model: possession of the pairing code is a **deliberately limited
single-owner-device credential** on an isolated field LAN. It is not
multi-user authentication and does not identify a person.

- `pairing:provision` generates a 12-symbol Crockford base32 code
  (60 bits, shown as `XXXX-XXXX-XXXX`) and prints it **once**. Only a salted
  scrypt verifier (`N=16384, r=8, p=1`) is stored. Re-provisioning revokes
  the old code **and every session paired with it**.
- Pairing exchanges the code for a session token
  `rlg1.<session-id>.<256-bit secret>`; only SHA-256 of the secret is stored,
  so a copied database cannot mint tokens. Sessions persist across gateway
  restarts and expire after 90 days (proposed default, OPEN_ITEMS #16).
- Each session is bound to exactly one robot; every API read is filtered by
  that robot.
- Never log, commit, or paste a pairing code or token. Tests use a fixture
  named `TEST_ONLY_PAIRING_CODE` that no CLI or seed ever provisions.
- Known limits: plain HTTP on the field LAN (no TLS) means a device on the
  same Wi-Fi could observe tokens; request rate limiting arrives with the HTTP
  server in Phase 4; anyone with the laptop's disk can read the stored data.

## Local API contract (v1)

Defined in `packages/shared/src/api/v1.ts`; implemented transport-independently
in `apps/gateway/src/api/localApi.ts` (the HTTP server in Phase 4 only adapts
requests to it). All responses are JSON. **There are no robot-control routes.**

| Method & path | Auth | Returns |
|---|---|---|
| `POST /api/v1/pairing` `{pairingCode}` | none | `201 {sessionToken, robot, expiresAt}` |
| `GET /api/v1/session` | Bearer | `{robot, expiresAt}` |
| `GET /api/v1/robot/status` | Bearer | `{status \| null, staleThresholdSeconds}` (latest by robot time) |
| `GET /api/v1/field` | Bearer | `{field, cells}` |
| `POST /api/v1/field-selections` `{fieldId}` | Bearer | `201 {selection}` — record of intent only |
| `GET /api/v1/runs` | Bearer | Dosing runs only (`{runs}`) |
| `GET /api/v1/runs/:id/readings` | Bearer | `{run, readings}` for a dosing run |
| `GET /api/v1/runs/:id/recommendation` | Bearer | `{recommendation, ruleSetStatus, isSynthetic}` |

Verification runs are never served by these farmer-facing routes (research
exports come in Phase 7). Another robot's run, a verification run, and a
missing run all return the same `404 NOT_FOUND`.

| Error code | HTTP | Meaning / user guidance |
|---|---|---|
| `UNPAIRED` | 401 | No token: pair this device |
| `INVALID_SESSION` | 401 | Unknown/malformed token: pair again |
| `SESSION_EXPIRED` | 401 | Pair again |
| `SESSION_REVOKED` | 401 | Code was re-provisioned: pair with the new code |
| `NO_PAIRING_PROVISIONED` | 503 | Operator must run `pairing:provision` |
| `INVALID_PAIRING_CODE` | 401 | Wrong code |
| `NOT_FOUND` / `NO_ACTIVE_FIELD` | 404 | Not available for the paired robot |
| `BAD_REQUEST` / `METHOD_NOT_ALLOWED` | 400 / 405 | Client error |

## Demo data (synthetic only)

`db:seed:demo` creates a separate database marked `demo` and loads a fixed,
deterministic fixture: one synthetic robot, a 4 × 5 synthetic field, a dosing
run (20 cells, two retried records, one duplicate delivery), a verification
run missing its last cell, three status reports, a **draft, synthetic** rule
set with fictional crops, and one synthetic recommendation. No GPS
coordinates, no real location, no pairing credential. Re-running is a no-op.
Normal `db:init` never seeds anything.

## Backup and restore

- **Backup (safe while running):** `npm run db:backup -w @robolime/gateway -- --db <live> --out <new file>`
  writes a consistent copy with `VACUUM INTO` and verifies it with
  `PRAGMA integrity_check`. Never copy only the `.sqlite` file of a running
  gateway: recent commits may still be in the `-wal` file.
- **Restore:** stop the gateway; move the current `<db>`, `<db>-wal`,
  `<db>-shm` aside (do not delete them until the restore is verified); copy
  the backup to `<db>`; run `npm run db:init -w @robolime/gateway -- --db <db>`
  to verify migrations; start the gateway. Restored outbox rows keep their
  states; anything already in the cloud is skipped by idempotent upserts.
- Store backups off the laptop (USB drive) after each field day.
