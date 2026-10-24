# Local field gateway: storage, pairing, and API contract

Status: **Phase 4, milestone 3**. The durable SQLite store, migrations, local pairing,
sessions, the read-only API handler, the sync outbox contract, and demo
seeding (Phase 2) are implemented and unit tested in `apps/gateway`. Phase 3
added the protocol layer: `src/protocol/uplink.ts` (validated uplink →
SQLite → storage ACK, write before ACK) and `src/protocol/bridgeSession.ts`
(USB serial bytes in/out, half-duplex ACK scheduling), plus the simulator in
`src/sim/` — see [`protocol.md`](protocol.md). Phase 4 milestone 1 added a
**loopback-only** HTTP server for the local API (`src/http/`, `npm run serve`);
milestone 2 added in-memory pairing-attempt rate limiting (D30); milestone 3
added an opt-in **bridge runtime** (`src/runtime/`) that runs the protocol
session over a byte-transport interface, verified with a simulated bridge only
(D31).
**Not built yet:** LAN binding (needs separate approval), web-app hosting,
live updates, the real LoRa byte codec (spec unsigned), a `serialport`
adapter for the runtime, and the cloud sync worker.

Everything in this document works with **no internet** and no Supabase.

## Requirements

- Node.js **22.16+ on the 22.x line, 24.0+, or 26+** (`^22.16.0 || ^24.0.0 ||
  >=26.0.0`). It uses the built-in `node:sqlite` — no native build step, so
  the same code runs on a laptop or Raspberry Pi — including
  `DatabaseSync.isTransaction`, which exists only from v22.16.0 / v24.0.0
  (decision D27). The whole repository (with Expo) needs `^22.16.0 ||
  ^24.3.0 || >=26.0.0`.
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
| Serve the local API over HTTP, **loopback only** (see below) | `npm run serve -w @robolime/gateway -- --db <file> [--host 127.0.0.1] [--port 8780]` |
| Load the **synthetic** demo dataset into a separate demo DB | `npm run db:seed:demo -w @robolime/gateway -- --db <demo file>` |
| Play a **simulated** robot run through the bridge runtime into a demo DB (see below) | `npm run bridge:simulate -w @robolime/gateway -- --db <demo file> [--cells 6] [--seed 1]` |
| Write a research CSV, read-only (see "Research CSV exports") | `npm run export:csv -w @robolime/gateway -- --db <file> --kind <readings, paired or delivery> --run <run id> --out <new file>` |
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
Phase 3 maps them to `STORAGE_ACK` results `STORED` / `DUPLICATE` /
`CONFLICT_RECORDED` (and `REJECTED` for a run-type mismatch; no reply for an
unknown robot or a failed write) — see [`protocol.md`](protocol.md) §4.
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
- Failed pairing attempts are rate limited per client address (see
  "Pairing-attempt rate limiting" below).
- Known limits: plain HTTP on the field LAN (no TLS) means a device on the
  same Wi-Fi could observe tokens; the HTTP server is still loopback-only, and
  exposing the API on the LAN needs a separate approval (D28, D30); anyone
  with the laptop's disk can read the stored data.

### Pairing-attempt rate limiting (decision D30)

- **Policy:** at most **5 failed pairing attempts per client IP address within
  any 15 minutes**. A failure counts for exactly 15 minutes after it happened
  (sliding window). While 5 failures count, every `POST /api/v1/pairing` from
  that address gets `429 PAIRING_RATE_LIMITED` with a `Retry-After` header
  (seconds until the oldest counted failure expires) and a message saying
  roughly how many minutes to wait. One more attempt becomes possible each
  time a counted failure expires.
- **What counts:** only a verified wrong code (`INVALID_PAIRING_CODE`).
  Malformed bodies (`400`), wrong methods (`405`), oversized or non-JSON
  requests rejected by the HTTP server, and `NO_PAIRING_PROVISIONED` do not
  test a code and are not counted. Successful pairings are not counted and do
  not clear earlier failures. Refused (`429`) attempts are not counted either,
  so hammering a limited address does not extend its wait.
- **No information leak:** the API handler refuses a limited address before
  it validates the body or verifies any code, so the `429` is identical for a
  correct code, a wrong code and a wrongly shaped JSON body, and creates no
  session. (The HTTP server still reads the body first and answers non-JSON,
  oversized or unparseable bodies itself with `415`/`413`/`400`, as for any
  client; none of these tests a code.) Responses and logs never contain
  pairing codes or tokens; the request log still holds only method, path,
  status and duration (not the client address).
- **Client address:** taken from the TCP connection
  (`socket.remoteAddress`). `X-Forwarded-For`, `Forwarded` and similar
  headers are **ignored**, because no trusted proxy sits in front of the
  gateway. IPv4-mapped IPv6 addresses count as the plain IPv4 address. If the
  transport cannot report an address, such requests share one counter (fails
  closed).
- **In memory only:** counters are not stored in SQLite and **reset when the
  gateway restarts**; restarting therefore also clears an attacker's
  failures. Expired entries are removed on every pairing attempt, and each
  address keeps at most 5 timestamps.
- **Shared addresses:** every client behind one address shares one counter.
  Today the server is loopback-only, so **all local clients (browser, tests,
  tools) share `127.0.0.1`**; on a future LAN, devices behind a NAT or a
  hotspot that rewrites addresses would share one too, and one of them could
  lock the others out for up to 15 minutes. Conversely, an attacker who can
  use many addresses on the field Wi-Fi gets 5 attempts per address; the
  60-bit code and the scrypt cost remain the main protection.
- **LAN binding remains disabled.** Rate limiting was the documented
  prerequisite; binding to a LAN interface still needs its own approval.

## Local API contract (v1)

Defined in `packages/shared/src/api/v1.ts`; implemented transport-independently
in `apps/gateway/src/api/localApi.ts` (the HTTP server in `src/http/` only
adapts requests to it). All responses are JSON. **There are no robot-control routes.**

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
| `PAIRING_RATE_LIMITED` | 429 | Too many wrong codes from this address; wait (`Retry-After`) |
| `NOT_FOUND` / `NO_ACTIVE_FIELD` | 404 | Not available for the paired robot |
| `BAD_REQUEST` / `METHOD_NOT_ALLOWED` | 400 / 405 | Client error (also: `Host` header not accepted) |
| `PAYLOAD_TOO_LARGE` | 413 | Request body over 16 KiB (HTTP server) |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | POST body not sent as `application/json` (HTTP server) |
| `INTERNAL_ERROR` | 500 | Unexpected gateway failure; details only in the gateway log |

## Local HTTP server (loopback only)

`npm run serve -w @robolime/gateway -- --db <file>` serves the API above over
HTTP. It opens an **existing** gateway database (it never creates, resets or
seeds one), applies pending migrations the same way `pairing:provision`
does, and stops cleanly on Ctrl+C (HTTP server first, then the database).

| Setting | Source (highest first) | Default | Accepted |
|---|---|---|---|
| Host | `--host`, `GATEWAY_HOST` | `127.0.0.1` | **loopback IP literals only** (`127.0.0.0/8`, `::1`) |
| Port | `--port`, `GATEWAY_PORT` | `8780` | integer 1–65535 |
| Web export | `--web-dir`, `GATEWAY_WEB_DIR` | none (static serving off) | folder from `npm run build:web` (see below) |

- **Loopback only (decision D28).** `0.0.0.0`, `::`, LAN addresses and host
  names are refused with an error — never silently replaced. Phones and
  tablets on the field Wi-Fi therefore **cannot** reach this server yet.
  Pairing rate limiting now exists (D30), but LAN binding still needs its own
  approval.
- Only `GET` and `POST` under `/api/v1/`; other methods get `405` (with
  `Allow: GET, POST`). Every path under `/api` (including unknown versions)
  goes to the API and gets its JSON `404` if unknown. Other paths get the
  API's JSON `404` unless the web app is enabled (below). No CORS headers are
  sent.
- **Browser-originated requests.** Every request must carry a `Host` header
  naming this server's own bound address and port — `127.0.0.1:<port>`
  (`[::1]:<port>` when bound to IPv6) or `localhost:<port>`; anything else,
  including a missing `Host`, gets `400` before reaching the API (this blocks
  DNS-rebinding pages). Every POST must be `Content-Type: application/json`
  (an optional `charset` must be UTF-8); anything else gets
  `415 UNSUPPORTED_MEDIA_TYPE` before the body is read, so a web page cannot
  send a cross-site "simple" request without a CORS preflight, which this
  server never approves. These checks complement — they do not replace —
  loopback-only binding and session authorization.
- Request bodies are limited to **16 KiB** (`413 PAYLOAD_TOO_LARGE`);
  malformed JSON gets `400 BAD_REQUEST`. Timeouts: headers 10 s, whole
  request 15 s, idle keep-alive 5 s. Open connections are checked every
  second (Node's default is every 30 s), so a stalled or slowly trickled
  request is closed with `408` within about 1 s of its timeout (measured on
  loopback: 10.1 s for stalled headers, 15.1 s for a stalled or trickled body).
- Unexpected failures return a generic `500 INTERNAL_ERROR`; the gateway
  logs only the error class.
- The request log contains only time, method, path (without query string),
  status and duration — never headers, `Authorization`, bodies, pairing codes
  or tokens.
- Not part of this server: LAN access, live updates, the serial bridge and
  cloud sync. Nothing here has been tested on a phone, a LAN or hardware.

### Serving the web app (opt-in, decision D33)

```bash
npm run build:web
npm run serve -w @robolime/gateway -- --db <file> --web-dir <ABSOLUTE path to apps/mobile/dist>
```

Then open `http://127.0.0.1:8780/` **on the gateway computer** (loopback
only; phones cannot reach it until LAN binding is approved). Pass an absolute
path, or `../mobile/dist`: `npm run -w` runs inside `apps/gateway`, so
`apps/mobile/dist` does not resolve there (the gateway then refuses to start
with "Web export folder not found").

- **Off by default.** Without `--web-dir`/`GATEWAY_WEB_DIR` nothing changes:
  `/` gets the API's JSON 404. A missing folder or one without `index.html`
  stops startup before the database is opened.
- **Exact allowlist, loaded once at startup into memory:** `/` and
  `/index.html` (the app shell), `/favicon.ico`, and regular files under
  `/_expo/static/` with an allowed extension. Expo's `metadata.json`,
  dotfiles, directories, source maps, symlinks/junctions and anything outside
  the export are never served; there is **no single-page-app fallback**
  (unknown paths get a plain-text 404). Requests are an exact map lookup; a
  request target whose raw form differs from its parsed form (`..`, `//`,
  percent-encoding, backslashes, NUL) is not resolved. Error responses
  contain no file paths. Rebuilding the export needs a gateway restart.
  Test coverage note: on the Windows development machine the file-symlink
  escape test is **skipped** (symlink creation needs extra privileges); the
  directory-junction escape test runs and passes, and a realpath containment
  check guards both cases.
- `GET` and `HEAD` only (`405` with `Allow: GET, HEAD` otherwise). The `Host`
  check above applies to static files too.
- Caching: the app shell is `no-store`; content-hashed bundles
  (`index-<hash>.js`) are `public, max-age=31536000, immutable`; other
  allowed files `no-cache`.
- Security headers on every static response (including 404/405):
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, and
  `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' <hashes>; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
  The style hashes are computed at startup from the served `index.html`
  (Expo's inline `expo-reset` style) plus the empty string (react-native-web
  creates an empty `<style>` and fills it through the CSSOM, which CSP does
  not govern). They hash the style text **as the browser parses it** (CRLF
  and lone CR normalized to LF, NUL → U+FFFD). CRLF and LF exports were
  verified in headless Edge; lone-CR and NUL handling follow the HTML parsing
  rules and are covered by unit tests only. `'unsafe-inline'` is not used.
- The app validates every successful API answer against the shared
  contract before showing it; a malformed answer is reported as "unreadable
  answer" and never displayed as status.
- The web app calls the API on its own origin only, so it needs no
  configuration and no CORS.

## Bridge runtime (simulation only, decision D31)

`src/runtime/bridgeRuntime.ts` runs the existing protocol session
(`src/protocol/bridgeSession.ts`) over a `ByteTransport`
(`src/runtime/byteTransport.ts`). It adds connecting, a poll timer, ordered
writes, reconnecting and shutdown; it adds **no** protocol rules, so framing,
write-before-ACK, deduplication and ACK decisions are exactly those of the
session and the store. It is opt-in: `npm run serve` does not start it.

- **Transport:** the only implementation is the in-memory
  `SimulatedBridgeTransport`. There is **no serial-port adapter** and no
  `serialport` dependency (OPEN_ITEMS #19).
- **Hardware is refused.** A runtime with `link: 'hardware'` throws
  `HardwareNotConfiguredError` while `RADIO_SCHEDULE` is `null`
  (OPEN_ITEMS #20) or the codec is not a signed-off wire format (the
  `UNSIGNED_LORA_CODEC` placeholder counts as not signed off; OPEN_ITEMS #1).
  A hardware runtime uses only the committed `RADIO_SCHEDULE`, never a
  supplied one. Link and transport kinds must match.
- **Simulation only touches demo databases.** A simulation runtime reads the
  database's recorded purpose (D17) and refuses anything that is not `demo`,
  including a database whose purpose cannot be read. It also refuses a
  wire-format codec.
- **No timing defaults.** Poll interval, reconnect delays, the failure limit
  and the write-queue bound must all be supplied. Tests use values marked
  `TEST_ONLY`; `bridge:simulate` uses values marked `SIMULATION_ONLY`, which
  only pace an in-memory simulation and are not radio timing.
- **Lifecycle:** `start()` connects and sends the session's resync + `HELLO`;
  incoming chunks go to the session with the injected clock; queued ACKs are
  offered on every poll. Writes are strictly one at a time. `start()` twice is
  a no-op, `stop()` is idempotent and cancels every timer, and a stopped
  runtime cannot be restarted (create a new one). Work from an earlier
  connection or a stopped runtime is ignored, so a late open or write can
  never revive it.
- **Failures:** a disconnect or failed write drops frames queued for that
  connection (they are never replayed on the next one; the session resets the
  link on reconnect) and reconnects after the supplied delay. Failed opens
  and disconnects in a row count towards `maxConsecutiveFailures`; the count
  resets only when the bridge sends a valid frame, so a link that keeps
  connecting without working also gives up. The runtime then stays in state
  `failed` until it is replaced.
- **Bounded writes:** `maxPendingWrites` is the most writes held for the
  current connection at once, **counting its write in progress plus the
  queued ones**; further writes are dropped and reported (`writes_dropped`).
  A write still pending from a lost connection does not count against the new
  connection. The minimum is 2 (`MIN_PENDING_WRITES`), so the opening resync
  byte and `HELLO` always fit; smaller values are refused when the runtime is
  created. Dropping or failing an ACK write never marks the ACK as sent: the
  reading is already committed, the ACK stays owed, and it is sent in a later
  response window, in practice after the robot's retry (stored as a
  `DUPLICATE`).
- **Events:** an injected sink receives structured events (state, counts,
  error class names, short session codes such as
  `reading_stored:inserted`). They never contain payload bytes, reading
  values, identifiers of robots or runs, error messages, codes or tokens. The
  sink is best effort: if it throws, the error is ignored and connecting,
  writing and shutdown carry on.
- **What is written to the USB link:** on every connection, one raw resync
  byte (a lone `0x00` delimiter that ends any partial frame left in the
  bridge, not a frame) and a `HELLO` frame; `FRAME_REJECTED` frames answering
  corrupt serial frames from the bridge (a USB-link reply, not sent over the
  radio); and `LORA_TX` frames whose radio payload is a `STORAGE_ACK`. These
  ACKs are the only radio downlinks; manual commands stay disabled (D21).
- **Transport contract (limits):** the runtime relies on the transport
  settling its operations. It has **no timeouts** around `open()`, `write()`
  or `close()`: an `open()` that never settles leaves the runtime in
  `connecting` (`stop()` still works); a write from a lost connection that
  never settles holds back the next connection's writes, because writes stay
  strictly one at a time; and a `close()` that never settles keeps `stop()`
  pending. `close()` throwing or rejecting is tolerated. The simulated
  transport always settles; the rules a future serial adapter must follow are
  in D31.

`bridge:simulate` requires an explicit `--db` (it ignores `GATEWAY_DB_PATH`),
an existing **demo** database that contains the synthetic demo robot (run
`db:seed:demo` first), and refuses field databases. It plays one synthetic run
(`SIM-RUN-<seed>`) one uplink at a time, prints a summary (new, duplicate and
conflicting readings, ACKs sent), and stops on Ctrl+C. Re-running the same
seed adds no readings: robot timestamps differ between runs, so the copies
are logged as conflicts and the originals are kept. Run `serve` on the same
demo database to see the result through the API. Verified with unit tests and
a local CLI run only — no serial port, radio, LAN, phone or hardware.

## Research CSV exports (decision D32)

`npm run export:csv` writes one CSV for the research team from a local
gateway database, with no network, cloud or hardware involved. It opens the
database with SQLite's **read-only** flag (it cannot change it), works on
`field` and `demo` databases, and **never overwrites** an existing file
(choose a new `--out`). The whole CSV is built before anything is written.
It is then written to a uniquely named temporary file in the same folder,
flushed to disk, and published under the final name with a hard link, which
is atomic and fails if the name already exists; the temporary file is then
removed. So the output name is either absent or complete, and a failed write
leaves no partial output file. If the temporary file cannot be removed, the
original error is kept and the message (or, after a successful export, a
warning) names the leftover file.
- **Limitation:** there is no fallback to a direct write. If the hard link
  cannot be created for any reason (for example a FAT32/exFAT USB drive
  without hard links, missing permission, a full disk), the export fails,
  nothing is published, the temporary file is removed and the error says so.
  Export to an NTFS (Windows laptop) or ext4 (Raspberry Pi) folder, then copy
  the finished file elsewhere if needed.

```
npm run export:csv -w @robolime/gateway -- --db <file> --kind readings --run <run id> --out <new.csv>
npm run export:csv -w @robolime/gateway -- --db <file> --kind delivery --run <run id> --out <new.csv>
npm run export:csv -w @robolime/gateway -- --db <file> --kind paired --run <dosing run id> \
  --verification-run <verification run id> --out <new.csv>
```

- `--db`, `--kind`, `--run` and `--out` are required (`GATEWAY_DB_PATH` is
  not used). `--run` is the **firmware run id** (`runs.source_run_id`). Add
  `--robot <firmware robot id>` if the same run id exists for more than one
  robot. `--verification-run` is required for, and only accepted with,
  `--kind paired`.
- Format: RFC 4180, UTF-8 without BOM, CRLF line endings, a header row with
  the exact column names below. Fields containing a comma, quote or line
  break are quoted (quotes doubled). **A missing value is an empty field**;
  no other placeholder or numeric default is used. Booleans are
  `true`/`false`. Timestamps are UTC ISO-8601 with milliseconds. Units: pH
  unitless, moisture %, temperature °C, volumes mL, elapsed time seconds.
  **EC is the stored value with an unconfirmed unit** (`…ec_unit_unconfirmed`,
  OPEN_ITEMS #7).
- **Spreadsheet formula injection:** quoting alone does not stop a
  spreadsheet from running a cell such as `=HYPERLINK(…)`. Every text field
  that would start a formula gets one leading `'` (single quote) in the
  file, which Excel, LibreOffice and Google Sheets treat as "this cell is
  text". A field is prefixed when it starts with `=`, `+`, `-` or `@`, when
  one of those follows leading whitespace or control characters (including
  tab, CR, LF, NUL, U+00A0 no-break space, U+200B zero-width space and
  U+FEFF), or when it starts with a tab or CR. The original text follows the
  `'` unchanged, so remove exactly one leading `'` to recover it; the
  database is never changed, and `--run`/`--robot` take the real,
  un-prefixed identifiers. In practice only identifier columns (`run_id`,
  `robot_id`, `dosing_run_id`, `verification_run_id`) can be affected; all
  measurements, counts and ratios are written as numbers and are never
  prefixed, so negative values such as `-1.5` stay numeric. This follows
  common guidance (OWASP) and is not a guarantee for every application;
  open exported files as text or import them as CSV rather than relying on
  a spreadsheet's automatic interpretation.
- Synthetic data is marked: `is_synthetic` is `true` for demo or simulated
  runs.

**`readings`** — one row per stored reading, i.e. per reading identity
(run, `cell_index`, `seq`), ordered by `cell_index` then `seq`. Values are
exactly as stored from the first copy received; retransmitted copies are not
repeated (they are counted in `delivery`). Columns: `run_id, run_type,
robot_id, is_synthetic, cell_index, seq, attempt_count, ph,
ec_unit_unconfirmed, moisture_percent, temperature_c, dose_volume_ml,
expected_post_correction_ph, gps_latitude, gps_longitude, raw_flags,
robot_recorded_at, gateway_received_at`. `attempt_count` is the robot's
attempt number of the first copy received; whether numbering starts at 0 or
1 is unconfirmed (OPEN_ITEMS #15). `dose_volume_ml` is the commanded volume.

**`paired`** — the schema records no link between a dosing run and its
verification run, so both are named, and rows are paired **only by
`cell_index`**. The runs must be a dosing and a verification run of the same
robot, and not on different recorded fields; otherwise the export is
refused. One row per cell index present in either run, ascending.
`pair_status` is `paired` (exactly one reading in each run),
`missing_verification` / `missing_dosing` (only that run's values are
filled), or `ambiguous_multiple_readings` (a run holds more than one reading
for the cell: **no reading is chosen**, all value columns are empty and only
the counts are given). Columns: `cell_index, pair_status, dosing_run_id,
verification_run_id, robot_id, is_synthetic, dosing_reading_count,
verification_reading_count, dosing_seq, verification_seq, baseline_ph,
baseline_ec_unit_unconfirmed, baseline_moisture_percent,
baseline_temperature_c, dose_volume_ml, expected_post_correction_ph,
observed_post_treatment_ph, verification_ec_unit_unconfirmed,
verification_moisture_percent, verification_temperature_c,
dosing_gps_latitude, dosing_gps_longitude, dosing_robot_recorded_at,
verification_robot_recorded_at, elapsed_seconds`.
`expected_post_correction_ph` is the robot's stored value (never
recalculated); `observed_post_treatment_ph` is the verification reading's
measured pH. `elapsed_seconds` = verification `robot_recorded_at` − dosing
`robot_recorded_at`, positive when the verification is later; both come from
the robot clock, whose accuracy is unconfirmed (OPEN_ITEMS #8). This export
is research data and is never shown on farmer-facing screens.

**`delivery`** — one row for the run. Columns: `run_id, run_type, robot_id,
is_synthetic, readings_stored, distinct_cells_received, receipts_total,
receipts_inserted, receipts_duplicate, receipts_conflict,
readings_with_retransmissions, expected_cells, expected_cells_source,
completeness_numerator, completeness_denominator, post_retry_completeness,
cells_outside_field, completeness_note, first_attempt_delivery_ratio,
first_attempt_note`.
- Sources: `readings` (one row per reading identity) and `reading_receipts`
  (every received copy, with outcome `inserted`, `duplicate` or `conflict`).
  Copies the gateway never received leave no trace.
- **Post-retry completeness** = distinct cell indices with at least one
  stored reading and `0 ≤ cell_index < expected_cells`, divided by
  `expected_cells`. `expected_cells` is the `total_cells` of the field the
  run was recorded on (`runs.field_id`); cell indices 0 … total_cells − 1 are
  the field's valid cells (enforced when a field is provisioned). Received
  cells outside that range are counted in `cells_outside_field`. If the run
  has no field, or the field has no `total_cells`, the completeness columns
  are empty and `completeness_note` gives the reason (OPEN_ITEMS #13).
- **First-attempt delivery ratio is not computed**: whether attempt numbers
  start at 0 or 1 is unconfirmed (OPEN_ITEMS #15). The column is always
  empty, `first_attempt_note` says why, and the raw attempt numbers are in
  the `readings` export.

Not included: an HTTP export route, app or web UI, statistics, or any
cloud upload. Verified with unit tests on temporary synthetic databases
only.

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
