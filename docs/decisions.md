# Decision log

Newest last. "Locked" decisions come from `CLAUDE.md` and must not be changed
without an explicit architecture decision from the team.

## D1 — Offline-first field architecture (locked)

Robot → LoRa #1 → LoRa #2 (USB) → TypeScript gateway → SQLite (write before
ACK) → local LAN API → mobile/web app. Hosted Supabase is a cloud mirror
synchronized when internet is available; Vercel is an optional online web
host. Neither is required in the field. No self-hosted Supabase stack in the
field baseline.

(Later status, 2026-10-25: D39 makes the hosted Supabase + Vercel deployment a
**release requirement**, not an optional host. Neither service is still
required *in the field*: offline field operation is unchanged.)

## D2 — One Expo codebase for Android and web (locked)

React Native + Expo + strict TypeScript. No Next.js app, no separate web
codebase. The pre-existing `Website/` page is not extended.

## D3 — npm workspaces monorepo (Phase 1)

**Options considered**

1. Single Expo project at the repo root; gateway later imports app files by
   relative path. Simplest today, but mixes Node gateway code with the
   React Native project and its tooling.
2. **npm workspaces**: `apps/mobile` (Expo), `packages/shared` (pure TS
   contracts/utilities), later `apps/gateway`. Shared code has one home and
   no React Native dependency, so the Node gateway can use it unchanged.
3. Separate repositories. Rejected: harder to keep contracts in sync.

**Chosen:** option 2. npm is already installed (no extra package manager), and
Expo SDK 58 configures Metro for workspaces automatically. `packages/shared`
is consumed as TypeScript source (`main: src/index.ts`), so there is no
separate build step.

**Consequence:** install from the repo root; Vercel must build from the repo
root (see `architecture.md`).

## D4 — Test runners

- `packages/shared` (and later the Node gateway): **Vitest** — fast, native
  TypeScript, no React Native transform needed.
- `apps/mobile`: **jest-expo** + React Native Testing Library — the
  Expo-supported way to test React Native components.

Two runners is a deliberate trade-off: each is the standard for its
environment. `npm test` at the root runs both.

## D5 — No navigation library yet

Phase 1 has one screen, so it keeps the template's `App.tsx` entry. Expo
Router (Expo's recommended navigation) will be adopted when the pairing,
field-selection, dashboard, and results screens are built.

## D6 — Units and missing values

- pH always shown to two decimals; temperature °C (1 dp); moisture % (1 dp);
  volume mL; voltage V (2 dp).
- Thousands separators are applied by our own code, not `Intl`, so output is
  identical on Hermes (Android) and browsers.
- Missing or non-finite values render as `—`, never as `0` or a sample value.
- EC unit is unconfirmed (OPEN_ITEMS #7), so the formatter requires it as an
  argument.

## D7 — Cell progress rounds down

`cellProgress` uses whole percent rounded **down** (199 of 200 → 99%) so a
run never displays 100% before it completes. Inconsistent counts (total ≤ 0,
completed > total, non-integers) return `null` and the label says progress is
unavailable instead of showing a misleading number.

## D8 — Staleness semantics

Telemetry is stale when strictly older than the threshold (age = 240 s is
still fresh; 241 s is stale). A robot timestamp ahead of the viewer's clock is
reported as a distinct `future` state rather than clamped to "0 s ago".
"Fresh" means "recently reported", not "live", because there is no heartbeat.

## D9 — Commanded lime volume naming

The status contract names the field `totalLimeCommandedMl` to make clear it
is the robot's commanded volume, not a measurement of liquid delivered.

## D10 — Dependency versions

Versions are pinned to what `npx expo install` resolves for Expo SDK 58
(React 19.3, React Native 0.88, TypeScript 6.0). TypeScript 6 no longer
includes `@types/*` packages automatically, so each `tsconfig.json` lists
the ambient types it needs (`"types": ["jest"]` in the app).

## D11 — Gateway storage on built-in `node:sqlite` (Phase 2)

**Options:** (1) `better-sqlite3` (native addon; needs prebuilt binaries per
Node version/CPU, a risk on Node 26 and on a Raspberry Pi); (2) **`node:sqlite`**
built into Node ≥ 22.13 (synchronous API, no native build, SQLite 3.53 here);
(3) an ORM. **Chosen:** (2) — zero native dependencies keeps laptop → Pi
portability to "install Node, copy the code". Gateway runs TypeScript through
`tsx` (a runtime dependency) so there is no separate build step.

## D12 — Deterministic UUIDv5 IDs shared by SQLite and Supabase (Phase 2)

Every mirrored row's primary key is a UUIDv5 of its natural key under a fixed
RoboLime namespace. Same ID locally and in the cloud; a gateway rebuilt from
robot-flash replay re-derives identical IDs, so cloud upserts stay idempotent.
Firmware robot/run identifiers are stored as opaque text (`source_*_id`) and
never assumed to be UUIDs. The namespace and name formats must never change.

## D13 — Readings are immutable; conflicts are logged, not merged (Phase 2)

On a repeated `(run_id, cell_index, seq)`: identical payload → `duplicate`;
different payload → `conflict`, original kept, differing copy stored in
`reading_receipts`. Every received copy is logged (attempt count, time) so
first-attempt delivery and post-retry completeness can be computed later
without mutating readings. Enforced by an UPDATE-rejecting trigger in both
stores.

## D14 — Transactional outbox with a database-enforced state machine (Phase 2)

Sync state lives in `sync_outbox` (one row per mirrored aggregate), written in
the same transaction as the entity. Transitions are enforced by a trigger;
`synced` requires `cloud_confirmed_at`, which only a confirmed cloud write
supplies. Interrupted `syncing` rows return to `pending` at startup. Sync
order: robot → field → rule set → run → reading → status → recommendation.

**Amended by D35 (Phase 4).** This record is kept as the Phase 2 decision. For
the sync worker, D35 replaces two parts of it: interrupted claims are
recovered by takeover of the expired worker lease (or returned on release),
not by a startup reset; and a fixed type order is replaced by per-entry
parent gating (a child is claimed only when every parent entry is `synced`).
A `synced` entry also needs a verified read-back confirmation, not just a
confirmed write. The outbox table, its states and its trigger-enforced
transitions are unchanged.

## D15 — Local pairing: scrypt verifier + hashed opaque session tokens (Phase 2)

Gateway-generated 60-bit codes, stored as salted scrypt (`N=2^14, r=8, p=1`);
tokens `rlg1.<uuid>.<256-bit secret>` with only SHA-256 of the secret stored.
One active credential per robot; re-provisioning revokes all sessions from the
old code. Proposed session TTL 90 days (OPEN_ITEMS #16). No email, phone, or
third-party identity.

## D16 — API handler separated from transport (Phase 2)

The v1 contract is in `packages/shared/src/api/v1.ts`; the gateway implements
it as a pure request → response function with the session/robot-scope check,
tested directly. The Phase 4 HTTP server only adapts requests. Farmer-facing
routes never serve verification runs; other robots' data is indistinguishable
from missing data (404).

## D17 — Database purpose guard for demo data (Phase 2)

Each SQLite file records `field` or `demo`. The synthetic seeder only runs on
`demo` databases and only via an explicit command with `--db` (it ignores
`GATEWAY_DB_PATH`). Synthetic rule sets can never be approved and can only
serve synthetic runs (database CHECK + trigger).

## D18 — Cloud RLS via trusted robot claims (Phase 2)

Clients get SELECT only; all writes come from the gateway's service role.
Reads require an active row in `robot_claims`, which no client can write.
`robot_id` is denormalised onto child tables for simple, indexable policies
and kept consistent by composite foreign keys. Rule tables are readable by
any user holding an active claim. The online claim flow is deferred
(OPEN_ITEMS #14).

## D19 — Cloud validation on a throwaway plain PostgreSQL (Phase 2)

Docker (needed for the official local Supabase stack) was not running, so the
migration and RLS tests run on a temporary PostgreSQL 17 cluster with a
**test-only** shim for Supabase roles and `auth.uid()`. The runner hard-codes
`127.0.0.1` and creates/deletes its own cluster, so it cannot reach hosted
Supabase. Supabase types are generated by the Supabase CLI from that
validated schema (`npm run db:cloud:types`), and the gateway's cloud column
lists are type-checked against them. Re-validation on the official stack is
OPEN_ITEMS #17.

## D20 — `@robolime/shared` is an ES module (Phase 2)

`"type": "module"` was added so the Node gateway (ESM, run by `tsx`) can
import the shared TypeScript source. Metro, Jest and the web export were
re-verified after the change.

## D21 — Manual commands: specified and simulated, but disabled (Phase 3)

**Conflict.** CLAUDE.md (locked) makes the apps observe-only and lists
"app-initiated run control" and "app-to-robot downlink" as out of scope. The
Phase 3 brief asked for a bidirectional manual-command flow.

**Options presented to the team:** (1) lift observe-only for manual mode and
build it; (2) telemetry + storage ACK only, manual commands as a written
proposal; (3) **specify the command contract and safety rules in code and
tests, but block every send path**; (4) supply a newer master prompt first.

**Chosen (team, 2026-10-23):** option 3.

**Consequences**
- **Fail-closed gate:** the only input is the committed constant
  `MANUAL_COMMANDS_APPROVED = false` in `manualCommands.ts`. No function
  takes an approval argument or option, so constructing an "approval" object
  or passing `approved: true` has no effect. `encodeLoRaMessage`,
  `CommandTracker.submit` and `HalfDuplexScheduler.enqueue` (command
  priorities) all throw `ManualCommandsNotApprovedError`. An unmocked guard
  test (`manualCommandGate.test.ts`) exercises every path, including forged
  arguments. Lifecycle tests open the gate only through the test runner's
  module mock (`vi.mock`), which has no production equivalent. The
  simulation codec refuses commands too, and the bridge session's drain
  discards any non-`STORAGE_ACK` item.
- Limits and timing are `null` (unconfirmed); dependent commands are rejected.
- No gateway session path, API route or UI sends a command. CLAUDE.md is
  **not** changed: observe-only remains the approved architecture.
- No pump/dispense command is defined (it would be an app dosing instruction).
- To lift: record a new decision here that amends CLAUDE.md §3, obtain the
  hardware owner's safety sign-off (E-stop, limits, bench test), confirm
  OPEN_ITEMS #20–#24, and update the manuscript.

## D22 — USB serial framing: COBS + CRC-16/CCITT-FALSE, little-endian (Phase 3)

**Options:** (1) newline-delimited text/JSON (easy to debug, but escaping,
size and parsing cost on the ESP32, and binary radio payloads need encoding);
(2) SLIP; (3) **COBS with a 0x00 delimiter, fixed 6-byte header and CRC-16**.
**Chosen:** (3) — constant, small overhead (≤ 1 byte per 254), binary
payloads pass through untouched, resynchronisation at any 0x00, cheap on an
ESP32. The version byte (offset 0) and CRC trailer are frozen across
versions so mismatches are always detectable. This contract is software-owned
and proposed until the bridge firmware implements it (OPEN_ITEMS #19).

(Later status, 2026-10-25: under reconsideration for the USB-serial link only.
The project owner declined to adopt D22 unchanged; D37 proposes a text-based
replacement for the USB link. D37 is not approved, so the gateway code still
implements D22. The rationale above is kept as the historical record. The LoRa
contract (D23) is not affected.)

## D23 — LoRa contract is logical; the byte layout sits behind a codec (Phase 3)

The radio message set, fields, identifiers, validation and size limits are
defined now; field offsets/encodings are not invented. `LoRaPayloadCodec` is
the single place a layout may live. `UNSIGNED_LORA_CODEC` refuses both
directions until the firmware spec is signed off; the simulator's codec is
marked `isWireFormat: false` and uses a "SIM" magic so it cannot be mistaken
for real packets.

## D24 — Robot-initiated half-duplex scheduling (Phase 3)

The gateway transmits only in a response window that the robot opens after
each uplink, one frame at a time, STOP > storage ACK > other commands. This
avoids collisions on a half-duplex SX1278 pair without clock sync. Window
timing is unconfirmed (OPEN_ITEMS #20).

(Later status, 2026-10-25: D38 confirms that the receiver initiates a
robot-data request every 3 seconds. That conflicts with D24's assumption that
the robot opens every exchange. D24 needs a reviewed replacement or amendment
(OPEN_ITEMS #37). Until then `radioScheduler.ts` and `bridgeSession.ts` still
implement D24 unchanged, and `RADIO_SCHEDULE` stays `null`.)

## D25 — Storage ACK semantics (Phase 3, proposed to firmware)

`STORED`, `DUPLICATE`, `CONFLICT_RECORDED` are sent only after the SQLite
commit and mean "durably recorded". `REJECTED` (run-type mismatch) means
"not stored, keep it". Unknown robots get no reply; storage failures get no
reply. Status packets are not acknowledged. Whether `CONFLICT_RECORDED`
releases flash stays OPEN_ITEMS #15.

## D26 — Command expiry by remaining TTL and a monotonic sequence (Phase 3)

Because the robot clock source is unconfirmed (OPEN_ITEMS #8), commands carry
`ttlRemainingMs` recomputed on each retransmission plus a strictly increasing
`commandSeq`. The robot rejects expired and lower-sequence commands and
answers equal sequences as duplicates. Gateway outcomes distinguish
"never sent" (`EXPIRED_UNSENT`) from "sent but unconfirmed" (`UNCONFIRMED`):
the latter never claims the robot did or did not act.

## D27 — Node.js engine range corrected (pre-publication review)

**Evidence.** The gateway uses `node:sqlite` (`DatabaseSync`, its
`readOnly` option, `prepare`/`exec`/`close`) and the
`DatabaseSync.isTransaction` property (`withTransaction` and the
`handleUplink` nested-transaction guard). Node.js v22 `node:sqlite`
documentation (https://nodejs.org/docs/latest-v22.x/api/sqlite.html, which
documented v22.23.4 when accessed on 2026-10-23): `node:sqlite` is unflagged
from v22.13.0; `database.isTransaction` was added in v22.16.0.
`@types/node` 26.6.5 marks `isTransaction` `@since v24.0.0` and `readOnly`
`@since v22.12.0`. Neither source shows
`isTransaction` on Node 23. On 22.13–22.15 the property would be
`undefined`, so the nested-transaction guard would silently never fire.
Tooling `engines.node`, as declared in each package's own `package.json`
and recorded identically in `package-lock.json`: vitest 5.0.5
`^22.12.0 || ^24.0.0 || >=26.0.0`; expo 58.0.17 `^22.13.0 || ^24.3.0 ||
^26.0.0 || >=27.0.0`; react-native 0.88.0 and metro 0.87.1 `^22.13.0 ||
^24.3.0 || >= 26.0.0` (equivalent ranges).

**Chosen.** Gateway `engines.node`: `^22.16.0 || ^24.0.0 || >=26.0.0`
(code ∩ vitest). Root `engines.node`: `^22.16.0 || ^24.3.0 || >=26.0.0`
(adds Expo/React Native). Previously `>=22.13` and `>=20`. No dependency
or SQLite code was changed. Only Node 26.11.1 has actually been run.

Node.js 25 is excluded because the locked toolchain does not declare support
for it. The open-ended `>=26.0.0` range follows upstream package engine
declarations; compatibility with future Node.js major releases remains
unverified until tested.

## D28 — Local HTTP server: plain `node:http`, loopback-only (Phase 4 M1)

**Options:** (1) a web framework (Express/Fastify: a new dependency for eight
routes); (2) **`node:http` around the existing transport-independent handler**
(no dependency; routing, validation and authorization stay in
`createLocalApi`, D16).

**Chosen:** (2). The adapter only maps HTTP to `ApiRequest`/`ApiResponse`,
adds a 16 KiB body limit, request/header/keep-alive timeouts, JSON error
bodies (`PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR` added to the v1 error codes)
and a log that never contains headers, bodies, pairing codes or tokens.

**Bind policy:** default `127.0.0.1:8780`; only loopback IP literals are
accepted, and wildcard or LAN addresses are refused with an error instead of
being silently replaced. Pairing-attempt rate limiting (OPEN_ITEMS #16) must
exist before LAN binding is allowed; until then the field Wi-Fi cannot reach
the API, which is intentional. Tested on loopback only; no LAN, phone or
hardware testing has been done. (Later status: D36 amends this with an opt-in LAN
bind policy, now implemented with automated tests; loopback remains the
default, and LAN acceptance needs the D36 §10 tests.)

**Browser-originated requests (M1 review fix):** loopback binding alone does
not stop a web page on the same laptop from reaching the server. Every
request must therefore name this server's own address and port (or
`localhost:<port>`) in `Host` — defeating DNS rebinding — and every POST must
be `application/json` (UTF-8), so browsers need a CORS preflight that the
server never approves. Rejected requests (`400` / `415`) never reach the API
handler. These checks do not replace binding or session authorization.

## D29 — Protocol v2 direction (PROPOSED, documentation only)

**Context:** the project lead decided that a proposed six-flag error
mapping requires a new protocol version, that v1 flag meanings stay
frozen, and that v1 packets and records must never be reinterpreted
with the v2 table. The proposal is documented in `docs/protocol-v2.md`.

**Confirmed decision (project lead, 2026-10-24):**
- Soil Status retains `cellIndex` for reading identity and idempotency,
  using the existing logical key `(runId, cellIndex, seq)`. This
  retains protocol and database identity only. It does not authorise
  field selection, cell visualisation, progress tracking or progress
  UI.

**Approved scope (project lead, 2026-10-24):**
- The six-flag mapping belongs to protocol v2 only. It is a proposal,
  not an implementation authorisation.
- Excluded from this semester's application scope: field selection,
  cell maps, cell-progress counts (including `cellsCompleted` and
  `totalCells`) and cell-progress UI.
- Completion is never inferred from received readings.
- The 3-second transmission interval is a temporary development
  target, not a hardware-validated timing requirement.
- The ESP32 bridge forwards the original LoRa application payload
  unchanged. The separate USB serial framing envelope remains.
- A successful reading ACK only follows a durable SQLite commit.
- No robot-control downlink or app-to-robot command routes are
  authorised. `MANUAL_COMMANDS_APPROVED` remains `false`.

**Recommended (not approved for implementation):**
- Store `contractVersion` with local and cloud records, identifying
  existing records as v1. This is a proposed schema design only.
- Accept v1 and v2 side by side, decode flags only with the table of
  the record's own version, and preserve raw flag values with
  unknown-bit diagnostics where safe validation permits.
- Investigate retaining pump, drive and storage faults through the
  existing component-status field.
- Keep the v1 status delivery semantics (not acknowledged, not
  retried) unchanged in v2.
- Extend the local API additively and version-aware, if backward
  compatibility can be maintained.
- Reject unsupported versions without storing or acknowledging them.

**Unresolved (items in `docs/OPEN_ITEMS.md`):** on-air version
representation (26); v2 error-flag table and reserved bits (27);
component-status encoding and runtime fault semantics (28); v2 status
identity, deduplication, retention and client display (29);
communication-loss rules and gateway connection freshness (30); ACK
compatibility and return routing (31); sensor-to-component mapping
(32); 3-second feasibility evidence (33); formal requirements and
protocol approval for v2 (34).

**This entry authorises no implementation, schema change, migration,
API change, firmware change or `CLAUDE.md` modification.**

## D30 — Pairing-attempt rate limiting: per client IP, in memory (Phase 4 M2)

**Approved policy (project lead):** at most 5 failed pairing attempts per
client IP address within 15 minutes; counters in memory only, reset on
gateway restart; LAN binding stays out of scope and unauthorised.

(Later status: D36 subsequently authorised and implemented opt-in LAN binding;
D30's rate-limit requirements above are unchanged and apply in LAN mode too.)

**Options considered for the key:** (1) one gateway-wide counter: simplest,
but anyone could lock the real owner out; (2) **per client IP** (chosen):
keeps other devices usable, at the cost of sharing a counter behind one
address and giving an attacker with many addresses more attempts; (3)
counters persisted in SQLite: survive restarts but need a migration
(rejected for this milestone).

**Implementation:** `apps/gateway/src/pairing/rateLimit.ts`, applied inside
the transport-independent API handler (D16) so it is tested directly; the
HTTP server only supplies the socket's peer address
(`socket.remoteAddress`) and turns `retryAfterSeconds` into a `Retry-After`
header. Forwarded headers are never trusted (no proxy exists). Sliding
window: a failure counts while younger than 15 minutes; with 5 counted, the
address gets `429 PAIRING_RATE_LIMITED` (new additive error code) until the
oldest expires. Only verified wrong codes count; malformed requests, wrong
methods, `NO_PAIRING_PROVISIONED`, successes and refused attempts do not. A
limited address is refused by the handler before the body is validated or
any code is verified, so the response reveals nothing about the code (the
HTTP server's own 400/413/415 checks on unreadable bodies still run first,
for every client). The check and the record run synchronously in one
handler call, so concurrent requests cannot interleave between them. No
schema change.

**Not verified:** behaviour on a real LAN, a phone, or behind a NAT/hotspot;
tested with unit, API-handler and loopback HTTP tests only.

## D31 — Bridge runtime over a transport interface, simulation only (Phase 4 M3)

**Context:** `BridgeProtocolSession` (D24, D25) had no caller outside tests:
nothing connected it to a byte stream, called `poll`, ordered writes or
handled reconnection.

**Decision:** `apps/gateway/src/runtime/` adds a `ByteTransport` interface,
a `BridgeRuntime` that drives the unchanged session over it, an in-memory
`SimulatedBridgeTransport`, and the opt-in `bridge:simulate` command. The
runtime adds lifecycle only (connect, poll timer, one-at-a-time writes,
reconnect with supplied delays, idempotent stop with a generation guard
against stale async work); framing, storage, deduplication and ACK rules stay
in the session and store.

**Safety rules:** a hardware runtime is refused while `RADIO_SCHEDULE` is
null or the codec is not a signed-off wire format (the unsigned placeholder
included), and uses only the committed schedule. A simulation runtime refuses
any database not recorded as `demo` (D17) and any wire-format codec. Link and
transport kinds must match. Poll interval, reconnect delays,
`maxConsecutiveFailures` and `maxPendingWrites` have no defaults (OPEN_ITEMS
#20); tests use TEST_ONLY values and `bridge:simulate` SIMULATION_ONLY values.
Repeated failures end in state `failed` (the count resets only on a valid
frame from the bridge); excess queued writes are dropped and reported, which
is safe because ACKs are sent only after commit and stay owed until the
bridge reports them sent. Events are payload-free, and the event sink is best
effort (an exception from it is ignored).

**Write capacity (audit fix):** `maxPendingWrites` counts the current
connection's write in progress plus its queued writes; a write still pending
from a lost connection does not count. Minimum 2, because `session.open()`
emits a raw resync byte and `HELLO` on every connection.

**Contract a future hardware adapter must meet (not yet enforced by
timeouts):** the runtime has no timeouts around transport operations, so a
real `ByteTransport` (e.g. a serial adapter) must guarantee that:
- `open()` settles: it resolves once bytes can flow, or rejects; it must not
  stay pending indefinitely (a driver that can hang needs its own timeout).
- `write()` settles for every call: it resolves once the bytes were handed to
  the driver, or rejects on failure. On disconnect or `close()`, every pending
  write must reject (or resolve) promptly; a write that never settles holds
  back all later writes, including the next connection's handshake.
- `close()` is idempotent and settles; after it settles no handler is called.
- `onClose` is reported only for a connection ended without `close()`, and no
  `onData` follows it.
Whether these guarantees are met with timeouts in the adapter or in the
runtime is decided with the adapter (OPEN_ITEMS #19); no timeout values are
chosen here.

**Not done / not verified:** no serial-port adapter or dependency, no real
codec, no radio timing; not started by `serve`. Tested with unit tests, a
simulated bridge and a local CLI run only; no serial, LoRa, LAN, phone or
hardware testing.

## D32 — Offline research CSV exports from local SQLite (M4)

**Context:** CLAUDE.md §9 requires three research exports (readings per
run, paired dosing/verification, delivery) generated from local durable
records without internet.

**Decision:** `apps/gateway/src/exports/` and `npm run export:csv` build the
CSVs from the existing tables only, through a connection opened with
SQLite's read-only flag. The file is never overwritten and never left
partial: it is written to a temporary file in the same folder, fsynced, and
published with a hard link (atomic, fails if the name exists), then the
temporary file is removed. There is deliberately no fallback to a direct
write: link error codes (e.g. EPERM) cannot reliably distinguish "hard links
unsupported" from permission or I/O failures, so any link failure fails the
export with nothing published; the target folders (NTFS, ext4) support hard
links. RFC 4180, UTF-8, CRLF, fixed headers,
empty field for a missing value. No schema change, HTTP route, UI or network
use.

**Formula-injection hardening:** every text field that would start a
spreadsheet formula (`=`, `+`, `-`, `@`, also after leading whitespace or
control characters, or a leading tab or CR) is written with one leading `'`;
the original text follows unchanged and the database is not modified.
Numbers are never prefixed. This follows OWASP guidance and is not claimed to
protect every spreadsheet application.

**Research definitions approved by the project lead (2026-10-24):**
- EC is exported as the stored value under `…ec_unit_unconfirmed`,
  provisional until OPEN_ITEMS #7 confirms the unit.
- Paired export: rows pair by cell index only (no run-to-run link exists in
  the schema). A cell with more than one reading in either run is
  `ambiguous_multiple_readings`, with values empty and counts given; no
  reading is chosen.
- Post-retry completeness: denominator = the run's field `total_cells`
  (`runs.field_id` → `fields`); empty, with the reason, when the run has no
  field or the field has no total.
- First-attempt delivery ratio: not computed until OPEN_ITEMS #15 confirms
  the attempt-number base; the column stays in the header, always empty.

**Not decided here:** the EC unit (#7), the attempt-number base and a
first-attempt denominator (#15), real field cell counts (#13), robot clock
accuracy for elapsed times (#8). Tested with unit tests on temporary
synthetic databases only.

## D33 — Local web app: pairing and status, served opt-in by the gateway (M5a)

**Scope:** the web build gets a pairing screen and a robot-status screen,
served by the gateway on its loopback address. No cell-progress counts,
percentages, map or field-selection UI this milestone; no LAN binding, CORS,
serial/radio, robot control or cloud work.

**Serving:** opt-in with `--web-dir` / `GATEWAY_WEB_DIR` (off by default, so
existing behaviour is unchanged). The export is scanned once at startup into
an exact in-memory allowlist (`/`, `/index.html`, `/favicon.ico`, regular
files under `/_expo/static/`); no filesystem path is built from a URL. Expo's
`metadata.json` is not served (the app does not need it). No SPA fallback:
unknown paths get 404. `/api` and everything under it always go to the API.
The Host check runs before static serving. `GET`/`HEAD` only.

**CSP (verified in headless Edge, 2026-10-24):** `style-src 'self'` alone
produced two violations (Expo's inline `expo-reset` style in `index.html`,
and an empty `<style>` element react-native-web creates) and an unstyled
page. Adding SHA-256 hashes of those two exact contents gave zero violations
and a render byte-identical to `'unsafe-inline'`. **Chosen:** hashes,
computed by the gateway at startup from the served `index.html` plus the
empty-string hash; `'unsafe-inline'` is not used. Scripts: `'self'` only.
`connect-src 'self'`. A future export whose styles change is covered after a
restart; any other new inline style would show up as a CSP violation, not be
silently allowed.

**Hash input = the text the browser parses, not the file bytes.** Verified
in Edge for CRLF: a CRLF copy of the export, hashed from raw bytes, was
blocked; Edge reported the `expo-reset` text with no CR and hashed it (via
`crypto.subtle` on `textContent`) to the same value as the LF export. The
gateway therefore applies the HTML parser's own rules before hashing:
newline normalization (CRLF and lone CR → LF), U+0000 → U+FFFD inside
`<style>`, and a style ends at `</style` followed by whitespace, `/` or `>`
(case-insensitive). With that, CRLF and LF exports both gave zero violations
and identical renders in Edge. Lone-CR and NUL handling were NOT checked in a
browser: they follow the HTML parsing rules and are covered by unit tests.
Only HTML `<style>` elements are handled (not SVG `<style>`); an
unterminated style gets no hash and is blocked (fails closed).

**Successful answers are validated at runtime** before reaching the screens
(`responseValidation.ts`): required fields, primitive types, the shared enums
(robot state, error flags, component checks), nullable timestamps, and
`IsoDateTime` as documented ("ISO 8601 with an explicit offset"). The
written date and time must be real: day within the month (Gregorian leap
years), hour 0–23, minute and second 0–59 (no leap second), offset hours
0–23 and minutes 0–59, matching the LoRa validator's rules (commit
`395ceee`). They are checked as written, not against the UTC date, so an
offset crossing midnight stays valid; `Date.parse` alone was not enough
because it silently shifts e.g. 2026-02-30 to March 2. Numbers must be finite; no ranges are invented because the contract
gives none. Unknown extra fields are ignored. A failure is an
`invalid-response` ("unreadable answer"): a retained report becomes "Last
received" (stale), otherwise "No status data"; the payload is not shown,
logged or stored. One judgement call: an empty `sessionToken` is rejected
(the contract types it only as `string`, but an empty bearer token can never
authenticate and the session store already refuses it).

**App behaviour:**
- Typed client (pairing, session, robot status) that never throws; failures
  are `timeout` (own 10 s abort), `unreachable`, `api` (status, code,
  `Retry-After`) or `invalid-response`. Error details are not kept.
- Polling: next status request 10 s after the previous one FINISHES (never
  overlapping); stops on unmount, "Forget this device", and when the gateway
  rejects the session (UNPAIRED / INVALID_SESSION / SESSION_EXPIRED /
  SESSION_REVOKED → token cleared, back to pairing with a notice). Ages
  re-render every 1 s locally (no request).
- Token storage: `localStorage` on web (survives reloads and gateway
  restarts); in-memory elsewhere; storage errors behave as "no session".
  Known limits: readable by any script in the page (mitigated, not removed,
  by the CSP and no third-party code) and by anyone using the browser
  profile. "Forget this device" clears only the browser copy; the gateway
  session stays valid until it expires or the code is re-provisioned. The
  pairing code is never stored.
- Display: progress-free state label (WORKING → "Working"), reported faults,
  battery voltage, total lime **commanded** (labelled as not a measurement),
  robot time and age, component self-check "Unknown" (bit layout pending).
  Fresh/stale uses the gateway's threshold (stale only when strictly older).
  If the gateway becomes unavailable, a retained report is relabelled "Last
  received" with its time and age and marked stale; with nothing retained,
  "No status data". Nothing is ever labelled live.
- The web app always calls its own origin; native builds use
  `EXPO_PUBLIC_GATEWAY_URL` (unchanged; not tested on a device).

**Tests:** gateway static-serving tests (traversal, encodings, NUL,
dotfiles, `metadata.json`, methods, Host, `/api` routing, MIME, caching,
CSP hashing for LF/CRLF/lone CR); app tests for validation, timing (fake
clock: 10 s timeout, 10 s gap after completion, 1 s local age refresh with no
request), polling stop on unmount / forget / invalid session, stale boundary
and gateway-unavailable states. **Symlink escape:** on the Windows
development machine the file-symlink test is SKIPPED (creating symlinks needs
extra privileges); a directory-junction escape test runs there and passes,
and the realpath containment check is a second guard.

**Not done / not tested:** LAN access and phones (loopback only), Android
devices, outdoor readability, any hardware. Browser checks were headless
Edge on loopback with synthetic data only. Timings are provisional
(OPEN_ITEMS #3).

## D34 — Phase 4 scope reconciliation and exit evidence

**Context:** the read-only Phase 4 closure audit (2026-10-24) found no
written acceptance criteria for Phase 4. The only authoritative definition is
`CLAUDE.md` §12 item 4: "TypeScript laptop gateway with SQLite durability, LAN
HTTP API, ACK ordering, offline operation, and retrying cloud sync". Project
documents had also listed the `serialport` adapter and "live updates" as
later Phase 4 milestones, which item 4 does not name.

**Rulings (decided by the project lead, 2026-10-24).** These are scope
classifications only; none of them claims that any work is complete.

- **A. Serial/LoRa hardware integration moves to build-order item 8**
  ("… hardware integration, and failure testing"). The `serialport` adapter,
  wire-level ACK proof and all physical bridge work leave the Phase 4 exit
  gate. Every prerequisite stays open and unresolved: signed-off byte layout
  (OPEN_ITEMS #1), radio settings (#18), bridge firmware and USB details
  (#19), timing (#20), on-air version field (#26), ACK format and routing
  (#31), ACK policy and attempt-count base (#15), 3-second feasibility
  evidence (#33), and robot clock source (#8). `RADIO_SCHEDULE` stays `null`,
  `MANUAL_COMMANDS_APPROVED` stays `false`, the hardware-runtime refusal
  (D31) stays in force, and no protocol definition changes. The adapter
  remains blocked until those items and the firmware/hardware approvals exist.
- **B. Status refresh is satisfied by the existing polling** (D33: a 10 s gap
  after each completed request, never overlapping, with timestamps, ages,
  stale labels, cancellation and "gateway unavailable" handling, all
  unchanged). No server-sent events, WebSockets, other push channel or new
  dependency in Phase 4. `CLAUDE.md` §4 "When working, fill in cells as
  records arrive" is dashboard behaviour (build-order item 5, Phase 5); it is
  NOT implemented, and cell maps, field selection, cell-progress counts and
  progress UI stay outside Phase 4.
- **C. Phase 4 software exit evidence** is automated tests plus reproducible
  local integration tests (including local cloud-sync recovery tests against
  a local PostgreSQL/Supabase target). Physical LAN, Android-on-LAN, field,
  hosted Supabase, Vercel and hardware validation are tracked separately
  under build-order items 8 and 9, as `CLAUDE.md` §12 already lists them
  there. Local tests are never claimed as evidence for those. No `CLAUDE.md`
  §10 requirement is removed or downgraded; each stays traceable in the
  checklist.

**Still required inside Phase 4 (item 4):** the LAN HTTP API (opt-in) and the
retrying cloud sync worker with its local recovery tests. Neither exists yet.
(Later status: the sync worker was implemented in M6a–M6d, see D35, and is
tested against a fake endpoint and a local PostgreSQL + standalone PostgREST
target, but not the official Supabase stack; the LAN HTTP API is still not
built.) (Later status, 2026-10-25: D36 has since implemented opt-in LAN
binding (commit `ef2ba25`), with automated tests only. The opt-in real-socket
test and physical-device acceptance remain unverified. The previous sentence
was accurate when written.)
LAN binding stays prohibited until a new explicit decision authorises it: D28
sets the loopback-only bind policy and makes pairing rate limiting a
prerequisite (now met by D30), and D30 records LAN binding as out of scope
and unauthorised. D34 does not authorise it. (Later status: D36 records the
LAN binding policy and plain-HTTP threat model and is implemented with
automated tests; the physical LAN test is still outstanding.)

**Exit checklist:** `docs/architecture.md`, "Phase 4 exit checklist". Its
criteria and the closing rule are **PROPOSED** and need the project lead's
approval; only rulings A–C above are decided.

**Open questions (not decided here):** the LAN binding policy and plain-HTTP
threat model (for the new decision that would authorise LAN binding); the cloud worker's HTTP client (plain `fetch`
or a new dependency), aggregate atomicity (read-back verification or a cloud
migration), conflict and backoff policy; Docker approval for the official
local stack (#17); hosted access (#14, #17).

## D35 — Cloud-sync confirmation contract, outcomes and retry policy (Phase 4, M6a–M6d)

**Status:** implemented; tested against an in-process **fake** PostgREST and,
in the opt-in A2 run (2026-10-25), against a throwaway local PostgreSQL 17.5 +
standalone PostgREST 16.4 (12 of 12 integration tests passed; a later run
adding R14, a restart across two real processes with real lease expiry, passed
13 of 13; `cloud-mirror.md`). Not run against the official Supabase stack or the hosted
project. Resolves the D34 open questions on the HTTP client, aggregate
atomicity, conflicts and backoff. The values below are the M6 design
choices approved by the project lead.

**Single worker (M6a, migration 0002):** one lease row (TTL 120 s, renewed
every 30 s, also while the worker sleeps). The owner id is a fresh
`randomUUID` per acquisition. Every outbox change made by the worker checks
owner and expiry inside its own `BEGIN IMMEDIATE` transaction, reading the
clock there; a database trigger also rejects claims, completions and
ownership changes by anyone but the current owner. Taking over an expired
lease returns its claims to `pending` in the same transaction.

**Transport:** built-in `fetch` (no dependency). Inserts are
`POST /rest/v1/<table>?on_conflict=<primary key>` with
`Prefer: resolution=ignore-duplicates,return=representation`, so a replay is
a no-op and the response lists only newly inserted rows. Conflicts target the
primary key only, so a clash on another unique (natural) key is an error, not
a silently skipped row. Every request has a 30 s timeout covering the body;
responses are capped at 4 MiB and shape-checked; redirects are never
followed; the service-role key sits in a credential object that cannot be
printed or serialised; server error messages are discarded, only the status
and the error code are kept. `https` is required except for a loopback
target, and a demo database may only sync to loopback.

**Confirmation:** an entry becomes `synced` only with a `VerifiedConfirmation`.
After inserting, the worker reads every table of the aggregate back by the
entity id (`Prefer: count=exact`) and compares each column with what it sent
(timestamps as instants, UUIDs case-insensitively, `jsonb` ignoring key
order). Every local row present with identical content and no extra cloud
rows → confirmed, with the root row's cloud-assigned `cloud_received_at`.
"Duplicate" means nothing new was inserted. The confirmation is checked at
run time (a type cast cannot forge one) and must name the same entry.

**Outcomes:**

| Outcome | When | Outbox result |
|---|---|---|
| confirmed / duplicate | read-back matched | `synced` |
| retryable | not sent (connection refused, DNS, connect timeout), 401/403/42501, 404/schema errors, 429, 5xx with a database code, rejected request, read failures, missing rows (`verification_incomplete`), row-capped read (`read_truncated`) | `failed`, fixed code, backoff retry |
| ambiguous (`outcome_unknown`) | a write timed out, lost its response, got a 408, or a 5xx without a database code | `failed`, backoff retry. Never treated as success or as failure: the idempotent re-insert plus read-back decides |
| permanent | 23505 → `identity_conflict`; differing content or extra cloud rows → `content_conflict`; other 23xxx (e.g. 23503 parent missing in the cloud) → `constraint_conflict`; 23514/23502/22xxx → `row_rejected`; aggregate over 512 KiB → `aggregate_too_large` | blocked (`failed`, no retry) until an operator requeues it |

A target-wide failure (network, credentials, server, ambiguous write) stops
the cycle: unattempted claims return to `pending` with no error recorded.

**Retry policy:** full jitter, `delay = random × min(15 min, 5 s × 2^(attempts−1))`.
The worker sleeps at least 5 s after a target-wide failure, 15 s when idle, and
not at all when a full batch (100) was claimed. Retry times are stored in
SQLite, so they survive restarts. Entries older than 24 h or with at least 20
attempts are reported by `syncDiagnostics`, never discarded.

**Ordering and fairness:** a child is claimed only when every parent entry is
`synced`, across batches; each entity type takes at most half of a batch;
oldest first.

**Known limitations:**
- An aggregate (field + cells, rule set + rules, recommendation + scores) is
  several requests, so online readers can briefly see part of one. It is
  never confirmed until complete. Single-request atomicity would need a cloud
  RPC and migration (not added).
- Every 23505 becomes `identity_conflict`; there is no follow-up lookup to
  tell a natural-key clash from another unique constraint (e.g. a second
  active field).
- A rule set is uploaded once and never re-synced. No gateway code changes a
  rule set after inserting it, and nothing re-queues a synced entry
  (`markChanged` exists but has no caller). If its status (e.g. approval) or
  its still-unlocked draft rules were changed locally after it synced (for
  example by hand), the outbox entry would stay `synced` and the cloud would
  silently keep the old copy. If such an entry were re-queued by hand, the
  read-back would find different content and block it as `content_conflict`,
  because the mirror only inserts and never updates rows. Rule-set re-sync is
  deferred.
- PostgREST's `db-max-rows` (Supabase default 1000) must be at least the
  largest aggregate table, or that aggregate retries as `read_truncated`.
- The trigger checks owner identity only; expiry is checked in code. A wall
  clock that jumps forward can end a lease early (the old owner is then
  fenced out); one that jumps back can delay retries.
- An unexpected exception inside the transport is treated as ambiguous.
- Tested against the fake endpoint (`src/test/fakePostgrest.ts`) and against
  local PostgreSQL 17.5 + standalone PostgREST 16.4 with a test-only auth shim
  (A2), including a restart across two real processes with real lease expiry
  (R14). Not covered: the Supabase API gateway (`apikey`), real Supabase roles,
  Supabase key formats and the hosted project. The CLI (`src/cli/sync.ts`) is
  not an npm script yet.

## D36 — Opt-in LAN binding for the local HTTP API (Phase 4, checklist row 5)

**Status: APPROVED; implemented in the gateway with automated tests
(uncommitted, under review). LAN acceptance NOT established:** the opt-in
real-socket test and the physical phone-on-Wi-Fi test (§10) have not been run.
Amends D28's bind policy only; D30 is unchanged. Loopback remains the default.

(Later status, 2026-10-25: the implementation is no longer uncommitted. It was
committed as `ef2ba25741a5d632b5fb7cfaf771babe08b9e6f9`, "feat(gateway): add
opt-in LAN binding", locally on `main` and not pushed. LAN acceptance is still
NOT established: the opt-in real-socket test and the physical test (§10)
have not been run.)

**Implementation (approved choices C1–C6):** `GATEWAY_LAN_MODE=on|off`
(case-insensitive; any other value refuses to start) or `npm run serve --
--lan` (an absent flag defers to the environment); `GATEWAY_HOST`/`--host`
carries the address. One listener on that address only (no second loopback
listener). The Host allow-list is exactly `<IPv4>:<port>`, also on port 80.
`apps/gateway/src/http/config.ts` validates the address (RFC 1918 classifier,
assignment check against `os.networkInterfaces()`, injectable for tests);
`server.ts` re-validates it before `listen` and never retries elsewhere;
`cli/serve.ts` prints the plain-HTTP/trusted-network warning, the LAN-URL
requirement for browsers and the firewall reminder. Normal tests use injected
interfaces and the LAN Host policy on loopback sockets; the successful LAN
start is tested through a test-only `listen` hook that opens a loopback socket
(validation still runs first, and the server stops if the bound address is not
the validated one). A real bind on a private interface runs only with
`ROBOLIME_LAN_SOCKET_TEST=1` (it can expose the test server to the network and
trigger a Windows Firewall prompt).

**Context:** `CLAUDE.md` §3 requires the gateway API and the gateway-served web
app to be reachable from a phone on the field Wi-Fi without internet, bound to
the intended LAN interface and never exposed publicly. D28 made the server
loopback-only and named pairing rate limiting as the prerequisite; D30 met it
but recorded LAN binding as unauthorised; D34 left "the LAN binding policy and
plain-HTTP threat model" open.

**1. Default (unchanged).** With no LAN setting the gateway binds `127.0.0.1`
(`DEFAULT_GATEWAY_HOST`) and refuses every non-loopback address, exactly as
today.

**2. Explicit opt-in.** LAN access requires **both** an explicit LAN-mode
setting **and** an explicit bind address that is an IPv4 literal inside
RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and assigned to a
local network interface at start-up. Either one alone is refused. Implemented
as `GATEWAY_LAN_MODE=on|off` (case-insensitive; any other value, even with
`--lan`, refuses to start) or the `--lan` flag (an absent flag defers to the
environment), with the address in `GATEWAY_HOST`/`--host`.

**3. Fail closed.** The gateway refuses to start, with an error that names the
problem and echoes no other setting, when LAN mode is on and the address is
missing; is a wildcard (`0.0.0.0`, `::`), loopback, public, link-local
(`169.254/16`), CGNAT (`100.64/10`), multicast, IPv6 or not an IP literal; is
not assigned to a local interface; or cannot be bound. It never falls back to
loopback, another interface or a broader address. If the address disappears
while running (Wi-Fi/DHCP change) the gateway does not rebind on its own; the
operator restarts it.

**4. Request security.** In LAN mode the Host check accepts **exactly**
`<bound LAN IPv4>:<port>` (amending D28's allow-list, which also accepts
`localhost`); there are **no extra hostnames** in the initial design. Every
other D28 control stays unchanged for every client: `GET`/`POST` only;
JSON-only UTF-8 `POST` checked before the body is read; the 16 KiB body limit;
header/request/keep-alive timeouts; no CORS headers; `no-store`/`nosniff`/
`no-referrer`; generic 500s; logs without headers, bodies, pairing codes,
tokens or query strings. Authorisation is unchanged: a valid session token on
every route except pairing, sessions scoped to one robot, the scrypt pairing
verifier and hashed tokens, and no robot-control routes. The D33 web app keeps
its same-origin CSP.

**5. D30 unchanged.** At most 5 failed pairing attempts per client socket
address within 15 minutes, `429 PAIRING_RATE_LIMITED` with `Retry-After`, in
memory only, forwarded headers ignored.

**6. Threat model and accepted risk.** For a trusted, password-protected
(WPA2/WPA3) field Wi-Fi or laptop hotspot only; **never** the public internet
or a public/shared network. Plain HTTP is not encrypted: any device on the same
network can observe or alter traffic, including pairing codes, session tokens
and field data, and could replay a captured token until it expires. Wi-Fi
encryption protects against outsiders, not other members of the network. A
private IP address provides neither authentication nor confidentiality. This
risk is **accepted for this semester** and documented, not mitigated.
**Operator precautions:** a Wi-Fi password and team devices only; a Windows
firewall inbound rule scoped to the Private profile, the gateway port and the
local subnet, removed after use; the gateway never changes firewall settings.

**7. Deferred: same-subnet restriction.** Refusing clients outside the bound
interface's subnet is **not adopted**. Whether it works correctly with the
Windows hotspot and the intended field access points is unknown (OPEN_ITEMS
#6); it needs evidence from those networks and a separate decision.

**8. Separate decisions or milestones (not part of D36):** TLS for LAN mode; a
shorter session lifetime (OPEN_ITEMS #16); the Android in-app gateway URL
setting; persistent native session storage; Android cleartext-HTTP
configuration for release builds. Until then the build-time
`EXPO_PUBLIC_GATEWAY_URL` stays the only native URL source.

**9. Unchanged safety boundaries.** `MANUAL_COMMANDS_APPROVED=false`,
`RADIO_SCHEDULE=null` and `DEFAULT_GATEWAY_HOST='127.0.0.1'` stay as they are.
Offline-first: SQLite remains the source of truth, LAN mode needs no internet or
Supabase, and write-before-ACK ordering and durability are untouched. No robot
commands, serial/LoRa transmission, actuator control or Protocol v2.

**10. Acceptance (both required, neither done).** *Automated security tests:*
default stays loopback; opt-in needs mode and address; RFC 1918 classifier
with boundary cases; unassigned/invalid/unbindable addresses fail closed with
no fallback; LAN-mode Host check rejects `localhost`, other IPs, the wrong
port, rebinding names and malformed or missing `Host`; over a real socket on a
private address, unpaired, invalid-token, robot-scope and D30 behaviour;
unchanged 405/413/415/408/500, no CORS, secret-free logs; works without
internet and survives a restart; all suites, typecheck and lint green with the
gates unchanged. The real-socket test on a private interface is **opt-in**
(`ROBOLIME_LAN_SOCKET_TEST=1`; it can expose the test server to the network and
trigger a Windows Firewall prompt), skips visibly otherwise or when no private
interface exists, and has **not** been run. *Physical test* (build-order item 8, OPEN_ITEMS #6): an
Android phone on the laptop hotspot or field access point with no internet,
the firewall rule, client isolation, pairing and status over the LAN IP, the
served web app, unreachability from other networks, and data surviving a
restart. Automated tests alone do not establish LAN acceptance.

(Later status, 2026-10-25: D40 excludes LAN from the whole project. This entry
and its code stay as the historical record. No LAN test or LAN acceptance will
be performed, and §10's LAN acceptance is out of scope.)

**Relationship to other decisions:** amends D28's bind policy and its Host
allow-list in LAN mode; keeps all other D28 controls and all of D30; records
the policy D34 left open. Checklist row 5: **Partly verified** (implemented;
automated tests only; opt-in real-socket and physical tests not run).

## D37 — Proposed text-based USB-serial contract (Phase 4)

**Status: PROPOSED — not approved.** Documentation only; it authorises no
firmware, gateway, test, dependency or hardware work.

**Context:** the project owner declined to adopt D22's COBS binary framing
unchanged (2026-10-25); the project adapts the incoming-byte handling on the
TypeScript side. The existing sketch `Robot Code/Test Cases/SPRINT_1_Gateway.ino`
prints free text, turns received radio bytes into a trimmed `String`
(lines 60-67) and mixes sample output into the same port. Its two
`[Robolime] MSG:…` lines (34, 49) are confirmed sample output, not telemetry.
None of that can be used as a protocol: it is unbounded, has no checksum and
can corrupt binary payloads.

**Proposal:**
1. **Framing.** One frame per line, terminated by LF (a CR before the LF is
   tolerated). Printable ASCII (0x20-0x7E) only. At most **640 characters**
   per line excluding the terminator (proposed bound: a 255-byte payload as
   hex is 510 characters, plus the other fields). A longer line is discarded
   up to the next LF and reported once.
2. **Structure.** `RL1 <TYPE> <key>=<value> … *<CRC>`. `RL1` names text
   contract version 1 and stays at the start of every line in all versions.
   Fields appear in a fixed order per type. `<CRC>` is CRC-16/CCITT-FALSE
   (poly 0x1021, init 0xFFFF, as in `packages/shared/src/protocol/crc16.ts`)
   over every byte before `*`, as 4 uppercase hex digits. The CRC is checked
   before any field is trusted.
3. **Message types.** The same meanings as D22, so the gateway session's
   rules stay unchanged: `HELLO` (both directions), `PING`/`PONG`, `RX`
   (receiver → laptop: RSSI, SNR, receiver uptime, payload length, payload),
   `TX` (laptop → receiver: transmit once), `TXR` (transmit result), `FAULT`
   and `REJ` (line rejected; a valid `REJ` is never itself rejected). Exact
   per-type field lists are fixed in review, not here.
4. **Opaque payload.** Radio bytes travel as uppercase hex: exactly 2 × len
   digits, len 1-255. The receiver never interprets, trims or alters them and
   keeps them in a fixed-size byte buffer, never a `String`. What the bytes
   mean is governed by the signed-off on-air specification (OPEN_ITEMS #1,
   #26), not by D37.
5. **Diagnostics.** Lines starting with `#` are diagnostic. The gateway logs
   them (bounded) and never parses them. Any other line that does not start
   with `RL1` is rejected and counted. Sample or debug text never appears on
   a protocol line.
6. **Errors.** A bad CRC, unknown type, bad field or over-long line is
   rejected without stopping the stream.
7. **Unchanged.** Write-before-ACK; the gateway transmits only
   `STORAGE_ACK`s; `guardedSchedule`, `MANUAL_COMMANDS_APPROVED=false`,
   `RADIO_SCHEDULE=null` and `DEFAULT_GATEWAY_HOST='127.0.0.1'`.

**Illustrative only** — placeholders, not telemetry and not a final wire
format:

```
RL1 RX rssi=<int> snr=<int> up=<uint> len=<n> hex=<2n hex digits>*<crc4>
# receiver diagnostic text, never parsed
```

**Trade-offs:** readable in a serial monitor and simple to emit on the ESP32;
payloads take about twice the bytes of D22. Assuming the sketch's
unconfirmed 115200 baud (OPEN_ITEMS #19), a maximum-length line takes about
56 ms.

**If approved:** D37 supersedes D22 for the USB-serial link only. The gateway
change (a text framing module plugged into the bridge session, with golden
test vectors) needs separate authorisation, and the firmware team must review
the contract (OPEN_ITEMS #35). The LoRa contract (D23) and D25 are unaffected.

## D38 — Three-second receiver-initiated polling requirement (Phase 4)

**Status: CONFIRMED project requirement (project owner, 2026-10-25).** The
behaviour is **not verified on hardware**, and this entry authorises no
firmware, gateway, scheduler or hardware work.

**Confirmed:** the receiver ESP32 (connected to the laptop by USB) initiates a
robot-data request every **3 seconds**. The robot ESP32 is intended to listen
for each request and respond with the requested data.

**Not verified:** that the robot actually listens for and answers each
request; whether it can listen while driving, dosing, transmitting or
retrying; and whether a 3-second cycle fits the radio airtime. The robot-side
sketch and the approved packet specification are not available yet. The
existing receiver sketch implements a 3-second timer (lines 8-9, 29-39) with
the ASCII request `GET_ROBOT_STATUS`, which is sample code, not an approved
on-air request.

**Unresolved (not invented or approved here):**
- request and response packet formats, and which data a response carries
  (status, readings, buffered readings) — OPEN_ITEMS #1, #26, #36
- robot listening windows, response timeout and handling of no reply — #20,
  #36
- retry policy on both sides, and whether polling replaces or adds to the
  robot's retry from flash — #20, #36
- radio settings and Philippine NTC compliance, including duty cycle at a
  3-second cycle — #18, #33
- ACK behaviour within a polled exchange: format, timing, record matching and
  the D25 meanings — #15, #31, #37
- the scheduler that replaces or amends D24 — #37
- delivery-statistics definitions under polling, and the staleness threshold
  — #3, #38
- whether the gateway can see each poll: the receiver could report every
  request it sends, and every missing reply (a proposal, not a decision) — #38

**Relationship to other decisions and requirements:**
- Conflicts with D24 (robot-initiated exchange).
- Conflicts with `CLAUDE.md` §5 (Staleness, timestamps, and display rules,
  stale-threshold bullet) and §6 (Binary packet decoding and gateway
  ingestion, "Status packet"): status only after each cell, no heartbeat, not
  retried. Listed under Manuscript reconciliation in
  `OPEN_ITEMS.md` (#39).
- Relationship to D29: D29 called "the 3-second transmission interval" a
  temporary development target. D38 confirms 3 seconds as the receiver's
  polling interval. Whether these are the same interval is unresolved (#33).
- A poll is a data request, not a command, so D21 and
  `MANUAL_COMMANDS_APPROVED=false` are unchanged. Whether a receiver-initiated
  request is consistent with `CLAUDE.md` §3 (Robot and transport boundary,
  observe-only bullet) needs team confirmation (#39).
- `RADIO_SCHEDULE` stays `null` and the hardware guard stays in place.

## D39 — Both deployment targets are required for release; D34 closing rule amended

**Status: DECIDED (project owner, 2026-10-25).** Documentation only. This
entry marks no phase complete and authorises no implementation, migration,
deployment or hardware work.

**1. Dual-deployment release requirement.** A product release requires
**both**:
- the **local/offline farm deployment**: the laptop TypeScript gateway, SQLite
  as the local source of truth, the local API, and the local Expo web/mobile
  app, working with no internet; and
- the **hosted online deployment**: the **existing** Supabase project (cloud
  mirror, RLS-scoped online data access) and the **existing** Vercel project
  (hosted Expo web build), working online.

Supabase validation and the Vercel deployment are release requirements, not
optional future work. These are two **deployment configurations of the one
shared Expo + TypeScript codebase** (D2), not two codebases. Field operation
still never depends on the cloud (D1): the local configuration must work with
no internet, and the gateway syncs to Supabase only when connectivity exists.

**Mismatch recorded, not resolved here (historical; superseded):** at the time
of this decision, four `CLAUDE.md` passages described the online deployment as
optional. The quoted phrases below are **superseded wording**, not current
requirements; they were corrected later (see the later-status note at the end
of this entry):
- §1 (Role and mission): "optional online deployment"
- §12 (Implementation workflow), build-order item 9: "optional Vercel online
  deployment"
- §12, the "Protect the field data path" paragraph: "before optional cloud
  polish"
- §14 (First action — adapt to the real starting state): "optional cloud
  sync"

So did D1 (later-status note added) and, previously, the D34 rulings, which
track hosted validation under build-order items 8–9. When D39 was originally
recorded, `CLAUDE.md` was not edited as part of this entry; it was left for
the team to amend, and the manuscript to be checked (OPEN_ITEMS #12 and #39
cover the related reconciliation). That describes the state at the time: the
later-status note below records that the `CLAUDE.md` passages were
subsequently corrected.

**2. D34 closing rule: AMENDED (not approved as proposed).** The proposed
rule in `docs/architecture.md` ("Phase 4 exit checklist") is kept as its
historical record. The owner amended it with these principles:
- Phase 4 may close only when every criterion designated as **mandatory for
  Phase 4** has adequate documented evidence.
- Deferred hardware, field and production-release requirements stay
  explicitly open and are never described as passed.
- Phase 4 closure is **not** product release readiness.
- Both deployment targets (§1) remain required before product release.
- No closing rule overrides the safety gates: `MANUAL_COMMANDS_APPROVED=false`,
  `RADIO_SCHEDULE=null`, `DEFAULT_GATEWAY_HOST='127.0.0.1'`, the hardware
  guard, and write-before-ACK.

**Phase 4 is not complete.** Which rows are mandatory for Phase 4 is not
re-designated here. The proposal's split (rows 1–11 mandatory; rows 12–15
Deferred or Blocked) remains the working designation until the owner confirms
or changes it.

**Unchanged:** D36 and its restrictions (no separate LAN-policy decision is
reopened); D37 remains PROPOSED and unapproved; D38 polling is a confirmed
requirement without hardware verification.

(Later status, 2026-10-25, project owner:
- **Mandatory rows confirmed:** rows 1–11 are mandatory for Phase 4; rows
  12–15 are Deferred or Blocked. Every mandatory row needs adequate
  documented evidence, and a partly verified row (currently row 5) stays
  explicitly partial. Phase 4 is still not complete.
- **`CLAUDE.md` corrected:** the four passages above (§1; §12 build-order
  item 9; §12 "Protect the field data path" paragraph; §14) were narrowly
  amended to state that both deployments are required before
  product release, and that offline field operation never depends on
  internet, Supabase or Vercel. The mismatch in §1 is resolved. The
  manuscript still has to be checked (OPEN_ITEMS #12).
- **Build-order placement:** hosted Supabase validation and the Vercel
  deployment stay in build-order items 8–9. They are mandatory release
  requirements, not Phase 4 closure criteria, and neither is complete.)

(Later status, 2026-10-25: D40 excludes LAN project-wide. Row 5's LAN
acceptance is Out of Scope and leaves the mandatory closure criteria; every
other mandatory row still needs adequate documented evidence.)

## D40 — LAN networking excluded from the entire project

**Status: DECIDED (project owner, 2026-10-25).** A project-wide scope
decision. Documentation only: no code, test, script or configuration is
changed or removed.

**Decision:**
- LAN networking is **excluded from the entire RoboLime project**. LAN will
  not be used at any point.
- No LAN real-socket test (`ROBOLIME_LAN_SOCKET_TEST=1`), physical
  phone-over-LAN test or LAN acceptance test will be performed.
- LAN-specific behaviour is **not** a product requirement and **not** a
  Phase 4 closure criterion.
- The local/offline deployment **remains required** (D39).
- D40 authorises **no replacement networking architecture**. No Wi-Fi, other
  network or new connection method is assumed or approved.

**Historical records kept:** D28, D30, D34 and D36 are unchanged. D36's
opt-in LAN code (`GATEWAY_LAN_MODE`/`--lan`, `apps/gateway/src/http/config.ts`,
`server.ts`, `cli/serve.ts`) and its tests stay in the repository untouched.
Its presence does not mean LAN is in scope or will be used. Removing it would
need a separate, explicit decision. Loopback stays the default
(`DEFAULT_GATEWAY_HOST='127.0.0.1'`).

**Consequence (recorded, not resolved):** `CLAUDE.md` §3 relied on the
laptop's LAN for phones and tablets to reach the gateway offline. With LAN
excluded, the gateway's local API and web app are reachable **only on the
laptop itself** (loopback). How, or whether, the Android app or another
device accesses local field data offline is now **undefined** (OPEN_ITEMS
#40). No device connectivity of any kind has been demonstrated.

**Checklist effect:** row 5 (LAN HTTP API) is **Out of Scope under D40**,
neither passed nor failed. The loopback API requirements stay in row 4. The
LAN parts of rows 13 and 14 are out of scope too; their non-LAN parts stay
Deferred. The mandatory Phase 4 set (D39) is now rows 1-4 and 6-11, each
still needing adequate documented evidence. Phase 4 is not complete, and
Phase 4 closure is still not product release readiness.

**Unchanged:** `MANUAL_COMMANDS_APPROVED=false`, `RADIO_SCHEDULE=null`,
`DEFAULT_GATEWAY_HOST='127.0.0.1'`, the hardware guard and write-before-ACK.
No hardware, serial, radio, cloud or deployment work is authorised.

(Later status, 2026-10-25: D41 resolves the consequence above. The field
deployment is laptop-only, and offline phone or Android access to the laptop
is not a requirement (OPEN_ITEMS #40 resolved as a scope question).)

## D41 — Two deployment environments: online (Vercel + Supabase) and local laptop

**Status: DECIDED (project owner, 2026-10-25).** Definitive deployment
architecture. Documentation only: no code, test, script or configuration is
changed. It clarifies D39 and D40 and resolves the offline-phone question
D40 raised. D28, D30, D34, D36, D39 and D40 stay as historical records.

**A. Online deployment (internet available).**
- Vercel hosts the online RoboLime application, and hosted Supabase provides
  the database and cloud data access.
- Farmers, researchers and thesis panel members use it when they have
  internet access.
- It is a separate environment from the laptop's local field deployment.
- Hosted Supabase validation and the Vercel deployment remain required before
  product release (D39).
- **Implementation status (unchanged by D41):** no Supabase client or cloud
  data adapter exists in the app; the online claim/pairing flow is not
  implemented (OPEN_ITEMS #14); the schema has not been run on the official
  stack or applied to the hosted project (#17); Vercel is not configured or
  deployed. Cloud sync is implemented in the gateway and verified against a
  local PostgreSQL/PostgREST target only (D35). Hosted live telemetry is not
  implemented or verified.

**B. Offline field deployment (no internet).**
- The team runs RoboLime **locally on its laptop**: the local app, the
  TypeScript gateway and SQLite storage.
- The data path is unchanged: robot LoRa radio → existing receiver hardware
  → USB serial → laptop TypeScript gateway → durable SQLite write → local app.
  There is no second gateway. SQLite durability and write-before-ACK are
  unchanged.
- It does not depend on internet access, Vercel or Supabase.
- The laptop is the field operator's interface and local data store. The app
  is used on the laptop itself (loopback).
- **The phone is not part of field operation.** Offline Android or phone
  access to the laptop is not a requirement, and no phone-to-laptop
  connection is needed.
- **Implementation status:** the laptop gateway, SQLite, loopback API, local
  web app and CSV exports are implemented and tested on loopback. The
  physical robot → receiver → USB → laptop path is **not** implemented or
  tested: there is no serial adapter, no signed-off LoRa layout, and the
  receiver sketch implements neither D22 nor D37 (checklist row 12).

**C. No LAN and no alternative phone connection.** D40 stands: LAN, hotspot,
Bluetooth, Wi-Fi Direct, USB phone connectivity and any other phone-to-laptop
connection are not required, and none is designed or authorised. The D36
opt-in LAN code and tests stay untouched and out of scope, and loopback stays
the default. This does not remove the Android app, the shared Expo codebase
(D2) or the hosted application.

**D. Phase 4 and release.** D39's distinction between Phase 4 closure and
product release still applies, as amended by D40 and D41:
- The mandatory Phase 4 criteria stay rows 1–4 and 6–11, each needing
  adequate documented evidence.
- Row 5 stays Out of Scope (D40), and offline Android access is not a
  criterion.
- Rows 12–15 stay Deferred or Blocked.
- **Phase 4 is not complete.**

**E. External (farmer- and panel-facing) wording.** Internal records stay
precise. External descriptions focus on the actual deployment capabilities:

> "RoboLime supports online access through Vercel and Supabase when an
> internet connection is available. When internet access is unavailable, a
> locally deployed version of the application runs on the team's laptop for
> field operation."

External material need not describe internal networking deliberations or
rejected alternatives. That is a presentation choice, not permission to hide
a material limitation when asked, or to claim unimplemented or unverified
functionality.

**Unchanged:** `MANUAL_COMMANDS_APPROVED=false`, `RADIO_SCHEDULE=null`,
`DEFAULT_GATEWAY_HOST='127.0.0.1'`, the hardware guard. No implementation,
hardware, serial, radio, cloud or deployment work is authorised.

## D42 — Clean replacement of the legacy hosted Supabase schema

**Status: DECIDED (project owner, 2026-10-27).** The existing hosted project
(`bkocxkavdosghmqjckty`) is kept; no replacement project is created. Its
earlier RoboLime schema predates the locked cloud-mirror design and is
replaced, not archived. The legacy RoboLime application data is disposable.
The committed migrations are the source of truth.

- **Cleanup migration:** `supabase/migrations/20261022000000_remove_legacy_hosted_schema.sql`
  sorts before `20261023000000_cloud_mirror_initial.sql` (file order only;
  it says nothing about any database's migration history). It drops only
  legacy objects named in read-only hosted evidence: 3 views, 15 `public`
  and 2 `private` tables, 2 sequences and all 9 legacy routines by exact
  signature (the trigger `recommendations_dosing_runs_only` goes with
  `public.recommendations`, and `private.pairing_attempts_id_seq` is
  internally owned by its table).
  It has no `CASCADE`, dynamic SQL, schema drop or privilege/publication
  statement, and names no Supabase-managed schema. Dependants outside the
  list make it fail rather than being removed. Its guard refuses to run when
  target objects are detected (five target-only tables, `cloud_received_at`
  on six colliding tables including the target's first table
  `public.robots`, or the five target `private` functions); it does not
  independently detect target-only `robot_claims`, `rule_crops` or
  `rule_seasons`. The unverified 2026-10-25 dump files are not evidence for it.
- **Hosted inventory (read-only SQL Editor checks supplied by the project
  owner):** 9 routines in `public`/`private`; publication `supabase_realtime`
  with `public.readings` and `public.robot_status`; no catalog dependants of
  `public.paired_readings` or `private.hash_pairing_code(text)`; the only
  dependant of `private.reject_verification_recommendation()` is the trigger
  on `public.recommendations`; 0 rows in `private.pairing_attempts` and
  `private.robot_pairing`. References inside PL/pgSQL bodies or dynamic SQL
  are not visible to these checks.
- **Backup:** `C:\Users\doman\RoboLime-backups\robolime-hosted-bkocxkavdosghmqjckty-20261027T093233Z-a69e04.dump`
  (439,296 bytes, SHA-256 `2F9BF9347ADEACCA7ED1997F5CD5BA695AFB7BE48A323BF9705C82211BBC0D34`),
  taken 2026-10-27 with a provenance record (archive coverage 23/23). It
  has **not** been restored.
- **Validation so far:** static tests (`apps/gateway/src/sync/cloudMigrations.test.ts`),
  a PostgreSQL 17 grammar parse (`ecpg`), and one run of the throwaway-cluster
  runner (`npm run db:cloud:test`, 2026-10-27) on a fresh database: the
  cleanup changed nothing (all drops skipped), the target installed, and the
  RLS tests passed.
- **Limited database rehearsal (2026-10-27): passed.** The backup's `public`
  and `private` schemas were restored into an isolated database-only container
  of `supabase/postgres:17.11.0.006` on `127.0.0.1:55322`; both files ran in one
  transaction (after a rolled-back run left the catalog unchanged); all legacy
  objects were removed, the target installed, the cleanup's guard refused a
  re-run, and the repository RLS test passed. Auth, Realtime, Storage and the
  Data API were not running. Details: `PHASE4_final_report_20261027.md`.
- **Apply kit (2026-10-27):** `C:\Users\doman\RoboLime-backups\phase4-apply-20261027\`
  runs both files in one transaction with exact-manifest pre/post-checks, a
  COMMIT only on operator confirmation, and read-only LEGACY/TARGET/OTHER
  classification before and after. It was rehearsed end to end as the local
  non-superuser `postgres` role. It does not write migration history
  (`migration-history-plan.md` there).
- **Not yet done:** nothing has been applied to the hosted project. That needs
  an explicit project-owner decision to run the kit, and afterwards the
  migration-history reconciliation in that plan. A version is recorded as
  applied only after it actually ran.
- **Unchanged:** offline field operation never depends on Supabase; the
  target schema (gateway-only writes through `service_role`, claim-scoped
  SELECT for `authenticated`, nothing for `anon`, no field selection or cell
  features this semester).

## D43 — Phase 5 scope (derived) and the local Results section (M5b)

**Status: PROPOSED scope, implemented locally (2026-10-27); needs the project
owner's confirmation.** No written Phase 5 acceptance criteria exist in the
repository. The scope below is **derived** from `CLAUDE.md` §12 build-order
item 5 ("Pairing, common monitoring strip, dashboard, and results screens
using explicit local/cloud data adapters"), §4 and D29. It is not a prior
agreement.

- **Implemented (uncommitted):**
  - `apps/mobile/src/data/dataSource.ts`: an explicit `FieldDataSource`
    interface. Screens read status, runs, readings and recommendations only
    through it. Only the local gateway adapter exists.
  - The gateway client reads the existing read-only API routes `runs`,
    `runs/:id/readings` and `runs/:id/recommendation` (no gateway change).
  - Runtime validation of those answers. A verification run or verification
    reading makes the whole answer invalid, so research data cannot reach
    farmer-facing screens.
  - A "Run results" section beside "Robot status". It lists dosing runs, then
    shows one run's reading records (pH to two decimals, EC as stored with
    "unit unconfirmed" (OPEN_ITEMS #7), moisture, temperature, commanded lime,
    "expected post-correction pH", robot time) and its stored crop
    recommendation (top five, reasons, rule-set version and status, inputs,
    weather source). Synthetic, draft and retired rule sets carry a warning.
    The Open-Meteo credit appears only when a forecast was used.
  - The robot status card stays at the top of both sections, and polling
    continues while switching.
- **Judgement calls:** the run total of commanded lime is a display-only sum
  of stored records, labelled "commanded". Results load on demand with
  "Try again"; there is no polling. Runs are listed whether or not they are
  finished, because the API has no per-run completion signal.
- **Not done, and why:**
  - Cloud adapter and online claim flow: OPEN_ITEMS #14, D42 (hosted schema
    not applied), and no approved Supabase client dependency.
  - A visually fixed (sticky) monitoring strip: the card scrolls with the
    content. A compact strip is a design decision.
  - Component self-check bits (#9) and battery health (#10).
  - Field selection, cell map and cell-progress counts: excluded (D29).
  - "Completed runs only": needs a per-run completion signal.
  - The recommendation engine and sourced crop data (build-order item 6,
    OPEN_ITEMS #5).
  - Android, device and outdoor checks (checklist row 14).
- **Unchanged:** observe-only (no command, dosing or expected-pH calculation in
  the app), loopback only (D40), `MANUAL_COMMANDS_APPROVED=false`,
  `RADIO_SCHEDULE=null`, no new dependency, no network or CDN use.

## D44 — Firmware inspection: no telemetry contract exists yet (Phase 5)

**Status: FINDINGS RECORDED (2026-10-27).** Documentation and tests only; no
firmware, protocol definition, codec, gateway or app behaviour was changed.

- **Source inspected:** GitHub `origin/main` at
  `432d5b32de6c5d5de5d4836fa99d95a4477ed016` (confirmed with `git ls-remote`),
  read from local git objects without checkout:
  `Robot Code/Final Code/finalcode_sprint1_esp.ino` (blob `c56d0ce`),
  `Robot Code/Final Code/finalcode_sprint1_nano.ino` (blob `7417af1`),
  `Robot Code/Test Cases/SPRINT_1_Gateway.ino` (blob `3d5528e`, identical to
  the local copy). Local `main` (`3e37db4`) has diverged from `origin/main`
  (merge base `93c616d`): `origin/main` lacks the local Phase 1–4 commits, and
  local `main` lacks the firmware upload. Nothing was pulled or merged.
- **Verified behaviour:** the robot ESP32 sketch is a bench-test program:
  - a USB-serial menu drives the BTS7960 motors (PWM 0–255)
  - typed `ACTUATOR_*`/`PUMP_*`/`STOP_ALL` text is forwarded to the Nano,
    which switches an L298N
  - LoRa starts at 915 MHz in receive mode and only prints packets
  - battery voltage is printed every 5 s
- **Not present:** soil sensing, robot states 0–6, error or component flags,
  run/cell/sequence identity, flash buffering, any LoRa transmission, and any
  ACK. The receiver sketch sends `GET_ROBOT_STATUS` every 3 s (D38) and
  forwards typed text over LoRa. Its `[Robolime] MSG:...` lines are hard-coded
  samples, not received data.
- **Consequences:**
  - there is no firmware telemetry contract to align with
  - the D22/D37 decision, the LoRa byte layout (OPEN_ITEMS #1) and real
    integration (checklist row 12) remain blocked
  - the app's displayed fields are not contradicted by the firmware, because
    none are produced by it yet
- **New open items:**
  - #41: 915 MHz robot vs 433 MHz receiver and Ra-02 modules
  - #42: telemetry not implemented
  - #43: the ESP32–Nano handshake is incomplete, and the battery divider is
    unconfirmed
- **Tests added:**
  - the receiver's exact text output yields no USB serial v1 frame
  - the app client and data source expose only pairing plus GET reads
- **Unchanged:** observe-only, `MANUAL_COMMANDS_APPROVED=false`,
  `RADIO_SCHEDULE=null`, the unsigned codec gate, loopback only, synthetic-only
  simulation.

## D45 — Existing robot firmware is the Phase 5 baseline (not modified)

**Status: DECIDED (project owner, 2026-10-27).** The firmware in
`Robot Code/Final Code` on GitHub `main` at
`432d5b32de6c5d5de5d4836fa99d95a4477ed016` is the approved firmware baseline:
`finalcode_sprint1_esp.ino` (blob `c56d0ce`) and `finalcode_sprint1_nano.ino`
(blob `7417af1`). The receiver sketch `Robot Code/Test Cases/SPRINT_1_Gateway.ino`
(blob `3d5528e`) stays a test harness. Findings: D44,
`PHASE5_firmware_alignment_report_20261027.md`.

- **Not modified in Phase 5:** no firmware is rewritten, replaced or
  reformatted. Any change needs a separate, explicitly approved firmware
  revision.
- **Software follows what the firmware demonstrably does.** It doesn't
  transmit telemetry, so the gateway and app receive no robot data from it.
  Nothing is assumed to exist that the source does not show (readings,
  states, flags, ACKs, flash buffering, packet formats).
- **Kept unchanged:**
  - the LoRa codec stays unsigned (`UNSIGNED_LORA_CODEC` refuses real payloads)
  - D22 serial validation is not loosened
  - no text decoder is added for the receiver's hard-coded sample lines
  - the app stays observe-only, with no app or cloud command or dosing path
  - `MANUAL_COMMANDS_APPROVED=false` and `RADIO_SCHEDULE=null`
- **Testing data:** application features keep using clearly labelled
  synthetic data.
- **Consequence for the field workflow (locked in `CLAUDE.md` §3, §6):** with
  this baseline, the robot → receiver → USB → gateway → SQLite → ACK path
  **cannot operate**:
  - the robot never transmits (#42)
  - robot and receiver use different frequencies (#41)
  - there is no ACK, retention or record identity (#42)
- **Integration status:** real robot integration (checklist rows 12–13) is
  **not possible** with this baseline, and must not be described as
  complete. This is a deliberate project limitation, not a software defect.
  The manuscript's description of robot telemetry, write-before-ACK and
  onboard buffering does not match this baseline and needs reconciliation by
  the research team (OPEN_ITEMS #12).
- **Observe-only note:** the baseline lets the robot be driven by a
  USB-serial menu on the robot ESP32. The receiver sketch can forward typed
  text over LoRa, which the robot only prints. Neither is an app or cloud
  path. Whether these remain in field firmware is a team decision (D21).
- **Not decided here:** the diverged `main` histories (D44) stay unresolved.

## D46 — Status strip scrolls normally; Results lists all runs (Phase 5 UI)

**Status: DECIDED (project owner, 2026-10-27).** This settles two questions
D43 left open. D44 and D45 are unchanged.

- **Status strip:** the robot status card is shown at the top of each section
  after pairing (below the title, robot name and connection banner) and
  **scrolls normally** with the page. It is not fixed or sticky. CLAUDE.md
  §4's "pin the strip at the top of every screen" is satisfied in this sense.
  No sticky layout is to be built.
- **Results run list:** **all** dosing runs are listed, including incomplete
  ones; nothing is filtered by completion. The data contract carries no run
  status:
  - the gateway `runs` table has no completion, failure or end-time column
  - `RunSummary` has no status field
  - `robot_status_reports` rows are not linked to a run

  So every run carries the same honest label, "Run status: not reported by
  the gateway". The list explains that runs may still be in progress or were
  interrupted. Completion is never inferred from reading counts, timestamps
  or the robot's current state. Distinguishing completed, incomplete or
  failed runs needs a future, approved data-contract change (and firmware
  that reports run boundaries, D45).
- **Unchanged:** verification runs and readings stay hidden from farmer-facing
  screens (validators reject them).

## D47 — Temporary demo-only pairing code `10302026`

**Status: DECIDED (project owner request, 2026-10-27). Demo use only.** The
local UI may be previewed with the fixed code `10302026`. It is a
**predictable, publicly known credential and must never be used in a field
deployment.** Details and the preview procedure: `docs/local-gateway.md`,
"Demo-only fixed pairing code".

- **Off by default.** It is accepted only when all of these hold:
  - the gateway runs with `--demo-pairing` or `GATEWAY_DEMO_PAIRING=on`
    (strictly `on`/`off`)
  - the gateway is bound to loopback (refused with LAN mode)
  - the database purpose is `demo`
  - the code was explicitly provisioned with
    `pairing:provision --demo-code`, for a synthetic robot

  Anything else fails closed. Nothing is provisioned, overwritten or revoked at
  startup, and the code is never printed or logged.
- **Normal mode unchanged:**
  - random 60-bit codes, scrypt verifiers and the 10-character minimum are
    kept for normal provisioning
  - the demo verifier uses a domain-separated hash input that normal
    verification cannot produce
  - without demo mode, the demo credential is invisible and its sessions are
    refused
  - rate limiting, session validation and robot scoping apply in both modes
- **No schema change:** the existing `verifier LIKE 'scrypt$%'` check is kept.
  The demo credential is marked by a reserved label.
- **Known limitation:** anyone with write access to the database file could
  relabel credentials. That access already defeats local pairing, as before
  (D15).

## D48 — Online build target and Vercel configuration (no deployment)

**Status: IMPLEMENTED LOCALLY (2026-10-27); deployment not authorised.**

- **Problem:** the web build always ran the field pairing flow against its own
  origin. Deployed on Vercel, it would call `/api/v1/pairing` on the Vercel
  domain, get a 404 and show "Pairing failed (gateway error 404)". That
  implies a field gateway exists online, which CLAUDE.md §5 forbids ("cloud
  mode must report clearly when internet/cloud services are unavailable").
- **Change:** a build-time `EXPO_PUBLIC_ROBOLIME_TARGET`:
  - unset or `field` (default): unchanged laptop field build
  - `online`: shows "Online access is not available yet" with no data and no
    requests
  - anything else: fails closed to a "misconfigured" notice
- **Vercel:** `vercel.json` uses `npm ci`, builds with
  `EXPO_PUBLIC_ROBOLIME_TARGET=online npm run build:web`, and outputs
  `apps/mobile/dist`. It takes effect only when a commit containing it is
  deployed.
- **Unchanged:** no cloud data adapter, Supabase client or credential was
  added. The online target becomes useful only after the claim flow (#14)
  and the hosted schema apply (D42).
- **Test reliability:** the intermittent mobile failure was diagnosed. The
  first rendering test in each screen suite exceeded Jest's default 5 s
  per-test timeout under CPU contention (reproduced on demand). The mobile Jest
  `testTimeout` is now 30 s. No assertion changed. Under extreme load (suites
  around 100 s) it can still time out.

## D49 — Cloud read client and online-build safeguards (no claim flow, no deployment)

**Status: IMPLEMENTED LOCALLY (2026-10-27).** It is not wired into any screen.
The online build still shows "not available yet" (D48).

- **Public configuration** (`apps/mobile/src/config/cloudConfig.ts`): reads
  only `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. It
  accepts only an `https://<ref>.supabase.co` URL and a publishable key or
  `anon` JWT for the same project. It refuses `sb_secret_` keys and JWTs whose
  role is not `anon`. Every failure fails closed, and no value is echoed.
- **Read client** (`apps/mobile/src/data/cloudReader.ts`):
  - plain `fetch` to PostgREST, so no `@supabase/supabase-js` dependency
  - **GET only**, and only when the user's own access token is present
  - reads `robot_claims` (own claims) and the latest `robot_status_reports`
    row for a UUID-validated robot
  - RLS-hidden rows mean "no data", never a claim
  - 401 is `auth-required` and 403 is `forbidden`
  - every row is validated; component checks stay "unknown" (#9)
- **Not built, because it needs a decision (OPEN_ITEMS #14):**
  - how an online user signs in (anonymous sign-in is disabled; email and
    phone are excluded by CLAUDE.md)
  - how a `robot_claims` row is granted (today only `service_role` can write
    it, and no claim function exists)

  No session provider, sign-in, claim or RPC was invented.
- **Build guard and Vercel headers:** see `docs/vercel-deployment.md`.
- **Dependency:** `node-forge` 1.4.0 → 1.4.2, an in-range patch for
  `@expo/cli`'s `^1.4.0`. The lockfile changed only in that entry, and it
  clears GHSA-86w9-cpqp-85rv.

## D50 — Canva mockups implemented in the existing app (visual layer only)

**Status: IMPLEMENTED LOCALLY (2026-10-28).** Source:
- `ui reference/RoboLime App Mockup.pdf`, 6 phone pages, SHA-256 `ed8559df…`
- `ui reference/Web build (laptop-hosted, field LAN).pdf`, 1 laptop page,
  SHA-256 `f173ebae…`

The prompt's path `docs/ui-reference/robolime-ui-mockups.pdf` does not exist;
these two files were used. No data contract, gateway, cloud or dependency
changed.

| Mockup | Implemented as | Deliberate differences |
|---|---|---|
| p1 Pairing | `PairingScreen` | "Field laptop found [LAPTOP-LAN-IP]" becomes "Field gateway on this computer" and "Pair this phone" becomes "Pair this device" (D40, D41). The decorative hero grid uses neutral greens, not pH colours |
| p2 Field selection | not built | Excluded this semester (D29) |
| p3 Field / dashboard | `StatusScreen` (Field section) + `StatusStrip` + bottom tabs | No "Working: x of y cells (z%)" or progress bar, no "x of y needed lime", and no field map (D29, D33). Self-check dots are outlined "Unknown" (#9). "Battery · health TBC" is kept (#10). The field name/area header is replaced by the robot name, because the app does not read the field |
| p4 Cell sheet | `ReadingSheet`, opened from a reading in Results | Opened from the reading list, not a map. "Too acidic / Near target" is not shown (cut-off unconfirmed, #4); only "Below / At or above target 6.00". The gauge is a continuous blend with one marked target |
| p5 Run results | `ResultsScreen` detail | No map or "Cells limed x of y"/"20/20 cells done" (D29). The median pH, conditions, weather note and top-5 crops come only from the stored recommendation. Score bars are relative to the top crop (the score scale is undefined) |
| p6 Exports | `ExportsScreen` | Downloads are shown disabled with the `npm run export:csv` instruction (no HTTP route, D32). No counts or delivery percentages (#15) |
| Web (laptop) | `SideNav` + wide `StatusStrip` + readings table | "Field laptop · local network" becomes the connection pill. "Cloud sync … queued" is omitted (no API). The map is omitted (D29) |

- **No new dependency:** icons are drawn with views, the hero gradient is a
  solid colour with stripes, and the system font is used (the font file was
  not supplied).
- **Responsive:** phones get bottom tabs; at a width of 900 or more there is a
  side rail and the readings table (`WIDE_BREAKPOINT`).
- **Unchanged:**
  - observe-only, no new requests
  - the online build still shows "not available yet" (D48)
  - the cloud reader is not wired in
  - the status strip scrolls normally (D46)

## D51 — OTHER classification explained; kit correction proposed (not applied)

**Status: FINDINGS RECORDED (2026-10-28).** No hosted change; the apply kit
`phase4-apply-20261027` is unchanged and still refuses (OTHER).

- **Cause:** the kit's legacy reference was built from a local restore that
  inherited the rehearsal image's `supabase_admin` default privileges in
  `public`. The hosted grants equal the backup's.
- **Proof:** a restore with those defaults suspended reproduces the hosted
  listing byte-for-byte (`6e0f3cc…`). From there, cleanup + target pass the
  unchanged postcheck (`3bdf928…`) and the RLS test.
- **Before any hosted apply:**
  - capture the hosted default privileges (read-only script; you run it)
  - review and approve a corrected **new** kit (runbook §6)
  - your explicit approval of the hosted run
- **Unchanged:** migrations, RLS design (D18) and the open claim flow (#14).
  Details: `docs/hosted-migration-runbook.md` §6.

## D52 — Online sign-in, claim flow, demo pairing command and apply kit v3

**Status: IMPLEMENTED LOCALLY (2026-10-28). Hosted apply and Vercel deployment pending.**
Requested by the project owner (finalize Supabase, online app, pairing code `10302026`, Vercel).

- **Online sign-in = Supabase anonymous sign-in.** Email OTP was considered and
  not used: CLAUDE.md §4 forbids requesting email, phone or third-party
  identity, and names "anonymous auth plus an approved database function".
  An anonymous session alone grants nothing (RLS).
- **Claim = server-verified cloud claim code** (migration
  `20261028000000_online_claim_flow.sql`, additive):
  - `npm run cloud:claim-code -- --robot <id>` (gateway laptop, service-role
    key from the gateway env) generates a random 60-bit code, shows it once,
    and sends only its SHA-256 to `provision_robot_claim_code()` (service_role only)
  - `claim_robot(code)` (authenticated only, SECURITY DEFINER,
    `search_path=''`) verifies it and inserts the caller's `robot_claims` row;
    5 failures per user / 30 overall per 15 minutes → `rate-limited`
  - the client never names a robot id; cloud claim codes are separate from
    local pairing codes
- **Online app:** `cloudAuth.ts` (anonymous sign-in, refresh, sign-out over
  `fetch`; no new dependency), `cloudReader.ts` (claim RPC + runs, readings,
  recommendations, status; every row validated), `createCloudDataSource`
  (same `FieldDataSource` interface as the field build), `OnlineRoot.tsx`
  (claim screen, offline/error states). Screens name their source ("Field
  gateway" / "RoboLime cloud"). Verification runs stay hidden. Observe-only.
- **Vercel:** CSP `connect-src` adds the project origin. The build guard also
  refuses non-`anon` JWTs in `EXPO_PUBLIC_*` and, on Vercel, missing public
  Supabase settings.
- **Local demo pairing (D47 unchanged):** `npm run demo:pairing` creates or
  reuses a DEMO database in `%LOCALAPPDATA%\RoboLime\demo\`, loads the synthetic
  fixture, provisions `10302026` and prints it. `npm run demo:serve` serves it
  on loopback with demo pairing. Field databases are refused, as before. The
  code is printed only by this command; it is not logged and is not in any web
  bundle. It was already in Git history (D47 docs and `codes.ts`), so it cannot
  be "kept out of history"; it is a public demo credential by design.
- **Apply kit v3** (`C:\Users\doman\RoboLime-backups\phase4-apply-20261028-v3\`):
  v2 + the claim-flow migration in the same transaction. Target fingerprint
  `71fdcd2d…` (368 items). Rehearsed on a fresh faithful restore (rehearsal5):
  LEGACY `6e0f3cc` → rollback → commit → TARGET → re-run refused; RLS and
  claim tests pass. Details: `docs/hosted-migration-runbook.md` §7.
- **Not done here (needs the owner):** running kit v3 on the hosted project (DB
  password), enabling anonymous sign-ins (dashboard), Vercel login/link and
  environment variables. No hosted resource was contacted or changed.

## D53 — Hosted project for online access is `pbwucdgmzvvxledtiocm`

**Status: DECIDED by the project owner (2026-10-29).**

- The Vercel project (`https://robolime.vercel.app/`, connected to
  `ginoomapayapa/Robolime` `main`) uses Supabase project
  **`pbwucdgmzvvxledtiocm`** through the Vercel–Supabase integration. This
  replaces `bkocxkavdosghmqjckty` for online access.
- The D52 schema (cloud mirror + online claim flow) was applied to it with
  `robolime-supabase-schema-EMPTY-PROJECT.sql`; the owner ran the VERIFY query
  and every row matched.
- `bkocxkavdosghmqjckty` was not changed by this work: kit v3/v4 refused, so it
  still holds the legacy schema. Its references in the apply kits, runbook and
  backups describe that project and stay as they are.
- `vercel.json` CSP `connect-src` now allows `https://pbwucdgmzvvxledtiocm.supabase.co`.
- Live checks against the deployed configuration (2026-10-29):
  - the site serves the online build and the headers are present
  - the bundle holds the `anon` key of `pbwucdgmzvvxledtiocm` and no
    service-role key or demo code
  - anonymous sign-in works, and a wrong claim code returns `invalid-code`
  - a signed-in user without a claim sees no robots or readings
  - the public key alone cannot read readings or provision claim codes (401)
- **Gateway sync:** the field gateway's `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` (in `apps/gateway/.env.local`) must name
  `pbwucdgmzvvxledtiocm`.
- **Amendment (2026-10-29):** the CSP `connect-src` is now `'self' https://*.supabase.co`.
  - **Why:** the Vercel–Supabase integration decides which project the build
    uses. A pinned ref in `vercel.json` fell out of step twice, and every
    browser request was then blocked ("Cannot reach RoboLime cloud").
  - **Still unchanged:** scripts load only from `'self'`; the bundle carries
    only one project's public URL and anon key; RLS protects the data.
  - **Diagnosis aids:** the online error screen shows the configured project
    ref (public), and an "Enter a claim code instead" button clears a stored
    sign-in that no longer works.
## D54 — Full mockup UI built for the demo, with labelled placeholders (scope change)

**Status: DECIDED by the project owner (2026-10-29): "build all, put placeholders for demo purposes".**
This **supersedes D29 for the UI** (field selection, cell map, cell progress)
and reverses D33's "no cell progress". CLAUDE.md §4 still marks these
*(excluded this semester)*; reconcile CLAUDE.md and the manuscript with D54.

- **Built, after `ui reference/RoboLime App Mockup.pdf` p2–p6 and the laptop page:**
  - **p2 field selection:** a one-field card, two "Other fields not yet
    available." placeholders and a confirm sheet. It is a record of intent:
    stored by the gateway (`POST /field-selections`) on the field laptop, and
    on this browser only online. Shown once per robot per device, and skipped
    where the device cannot store it (native app, blocked storage).
  - **p3 field:** "Working: x of y cells (z%)" with a progress bar, the field
    header, "N of M measured cells needed lime · K cells left" and the field
    map with zoom. Without a provisioned field the map uses a labelled
    placeholder 5-column layout.
  - **p4 cell sheet:** opened from a map cell. It shows the band label
    (Too acidic / Near target / At target).
  - **p5 run results:** four tiles (cells limed, commanded lime, median
    measured pH, median expected pH) and the map with a "Measured pH /
    Expected after lime" toggle.
  - **p6 exports:** dosing and verification run pickers. The three CSVs are
    built by the gateway over two new loopback routes, `GET /exports/runs` and
    `POST /exports/csv` (read-only, same builders and headers as
    `export:csv`), and downloaded in the browser. Pair counts and post-retry
    completeness are shown.
  - **Laptop page:** a cell-readings table beside the map.
- **Placeholders, always labelled on screen:**
  - near-target cut-off **5.50**: `apps/mobile/src/config/phBands.ts`, OPEN_ITEMS #4
  - self-check dots: "not reported yet (placeholder)"; never "8/8 OK" (#9)
  - battery health: "TBC" (#10)
  - first-attempt delivery: "Not computed" (#15)
  - the "Next" cell: assumes the robot visits cells in number order
  - the placeholder grid layout
- **Rules kept:**
  - cells are placed by cell index, never GPS
  - every colour has a text label, and "too acidic" also has stripes
  - verification runs appear only in the export area
  - observe-only: no robot downlink
  - displayed cell numbers are 1-based (C1 = cell index 0); exports keep the
    raw `cell_index`
  - online exports: none (field laptop only)
- **Verified:**
  - unit and screen tests
  - gateway export-route tests
  - headless-Edge run on loopback with the synthetic demo database, pairing
    through the real UI with `10302026`: field selection → field map → cell
    sheet → results with tiles and map → a downloaded readings CSV, plus the
    laptop layout
  - not verified on a real phone, outdoors, or with real robot data
## D55 — Crop-list placeholder in Results; header shows "RoboLime"

**Status: DECIDED by the project owner (2026-10-29).**

- **Results:** when no recommendation is stored for a run, and when there are
  no dosing runs at all, a "Top 5 crops for this field" placeholder shows five
  slots ("Crop placeholder 1–5", "Category to be sourced", score "—"). A red
  notice says that no recommendation exists yet. There are no crop names,
  scores or ranges, so nothing is invented (OPEN_ITEMS #5); stored
  recommendations display exactly as before.
- **Header:** the paired screens' title is now **"RoboLime"** instead of the
  robot's display name. The subtitle names only the data source ("Field
  gateway on this computer" / "Online · synchronised records"). The SYNTHETIC
  badge still appears for synthetic robots.
## D56 — Demo shows only the Field and Results tabs

**Status: DECIDED by the project owner (2026-10-29).** The Exports tab is
removed from the phone tab bar and the laptop side rail.

- **Kept, so it can be re-enabled by adding the tab back in
  `apps/mobile/src/ui/Navigation.tsx`:** `ExportsScreen`, the gateway export
  routes, and their tests.
- **CSV exports remain available on the field laptop:** `npm run export:csv`.
- **Manuscript/CLAUDE.md mismatch:** CLAUDE.md §9 asks for an export area for
  the research team. In the app UI it is hidden for the demo; the command-line
  export still meets the requirement.
## D57 — Manual control of RoboLime over LoRa (observe-only lifted for manual control)

**Status: DECIDED (project owner, 2026-10-29).** The owner chose "approve and
build it" and a 5-second auto-stop. This entry is also the explicitly approved
firmware revision that D45 requires for the files listed below.

- **What it is:** a "Manual control" tab (screen title "Manual control of
  RoboLime") in the **field build on the laptop only**. It sends drive,
  pump and actuator commands: app → loopback API → gateway → USB serial →
  LoRa bridge → LoRa → robot ESP32 (→ Nano for pump/actuator).
- **Supersedes, for manual control only:** the observe-only rule and "no
  app-to-robot downlink" in `CLAUDE.md` §3, and D21's "disabled" status for a
  manual-control path. Dosing runs, dose calculation, navigation and field
  decisions stay on the robot. The cloud/Vercel build has no command path
  (`manualControl: null`).
- **Wire format:** the Sprint 1 firmware's own text commands, one line per
  command over USB serial (`packages/shared/src/protocol/manualControl.ts`):
  `STOP_ALL`, `DRIVE:<FORWARD|REVERSE|LEFT|RIGHT>:<PWM 0-255>`,
  `ACTUATOR_EXTEND|RETRACT`, `PUMP_ON|OFF`. The robot answers `ACK:<cmd>` or
  `NACK:<cmd>`; the bridge retries 3 times at 1 s. This is a narrow
  manual-control channel: it does **not** adopt D37 for telemetry and does not
  change D22, the unsigned LoRa codec, `RADIO_SCHEDULE=null` or the D21 binary
  contract (`MANUAL_COMMANDS_APPROVED` stays `false` for that contract).
- **Safety:**
  - every output started over LoRa (drive, pump, actuator) stops by itself
    after `MANUAL_AUTO_STOP_MS = 5000` on the robot, even if no STOP arrives
    (owner-chosen; hardware sign-off pending, OPEN_ITEMS #22)
  - STOP EVERYTHING is always available while the bridge is connected and
    replaces any pending command
  - loopback only: `--serial-port` is refused with `--lan` (D40)
  - same paired session as every other route
  - the app reports only what the bridge saw (ACK, NACK, no reply), never
    that the robot moved
- **Gateway:** `npm run serve -- --db <file> --serial-port COM5` (or
  `GATEWAY_SERIAL_PORT`; `GATEWAY_SERIAL_BAUD`, default 115200). New dependency
  `serialport` (laptop and Raspberry Pi prebuilds). Routes
  `GET /api/v1/manual/status`, `POST /api/v1/manual/commands`. Command
  history and the bridge log are in memory only (cleared on restart); nothing
  is written to SQLite.
- **Firmware revision (approved here):**
  - `finalcode_sprint1_esp.ino`: handles LoRa commands, sends ACK/NACK,
    auto-stops after 5 s, answers the Nano's `NANO_READY` with `ESP32_ACK`
    (#43), LoRa frequency 915E6 → **433E6** to match the bridge and the
    documented Ra-02 modules (#41)
  - `finalcode_sprint1_nano.ino`: adds `ACTUATOR_STOP` and the `PUMP_STOP` alias
  - `finalcode_sprint1_gateway.ino`: the bridge, based on the
    `SPRINT_1_Gateway.ino` test sketch, with NACK handling; 433E6
  - the USB serial bench menu on the robot is unchanged and has no auto-stop
- **Manual pump use is not part of a dosing run** and is not recorded as
  dispensed lime.
- **Verified:** gateway unit tests (fake serial bridge), app screen tests,
  typecheck. **Not verified:** the sketches were not compiled (no
  `arduino-cli` on this machine) and nothing was run on real hardware.
- **Manuscript mismatch:** the manuscript and `CLAUDE.md` describe the apps
  as observe-only. Both need to mention laptop-only manual control (#44).