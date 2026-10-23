# Decision log

Newest last. "Locked" decisions come from `CLAUDE.md` and must not be changed
without an explicit architecture decision from the team.

## D1 — Offline-first field architecture (locked)

Robot → LoRa #1 → LoRa #2 (USB) → TypeScript gateway → SQLite (write before
ACK) → local LAN API → mobile/web app. Hosted Supabase is a cloud mirror
synchronized when internet is available; Vercel is an optional online web
host. Neither is required in the field. No self-hosted Supabase stack in the
field baseline.

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
