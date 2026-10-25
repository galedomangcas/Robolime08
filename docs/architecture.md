# RoboLime software architecture

Status: **Phase 4 in progress — not complete** (see the Phase 4 exit checklist below), built on **Phase 3 (USB serial + LoRa protocol contracts, simulator; manual commands specified but disabled)**. This document records the confirmed
architecture and what actually exists in the repository today. The full
requirements live in [`CLAUDE.md`](../CLAUDE.md); open questions live in
[`OPEN_ITEMS.md`](OPEN_ITEMS.md); decisions in [`decisions.md`](decisions.md); radio and
serial contracts in [`protocol.md`](protocol.md).

## Starting state (recorded 2026-10-23)

Before Phase 1 the repository (`github.com/ginoomapayapa/Robolime`, branch
`main`) contained only:

- `README.md` — team note on linking Git to VS Code.
- `Website/` — a placeholder static page (`WEB.html`, `STLYES.css`, empty
  `SCRIPT.js`). Not the RoboLime app. Left untouched.
- `PCB Schematic/` — KiCad project files. `PCB_Robolime/.history` is recorded
  in Git as a submodule pointer with no `.gitmodules`; left untouched.

No app, gateway, database migrations, or tests existed. A hosted Supabase
project and a Vercel project have been created by the team but were **not
inspected or modified** in Phase 1.

## Field deployment constraint

The field site (Calatagan, Batangas) has little or no internet or mobile
signal. Everything needed during a field session must therefore run on the
laptop and the local Wi-Fi network with **no WAN access**. Hosted Supabase and
Vercel are used only when internet is available.

## Data paths

### 1. Field path (offline, required)

```
Robot (ESP32-WROOM-32 + Arduino Nano + NEO-6M GPS)
  │  writes each reading to onboard flash, keeps it until acknowledged
  ▼
Ra-02 (SX1278) #1, driven by the robot ESP32 over SPI
  │  plain point-to-point LoRa (NOT LoRaWAN), fixed-layout binary packets,
  │  half-duplex; LoRa contract v1 (logical; byte layout not signed off)
  ▼
Ra-02 (SX1278) #2, driven by the gateway ESP32 over SPI
  │  the gateway ESP32 relays opaque radio payloads
  │  USB serial contract v1 (COBS + CRC-16 frames)
  ▼
TypeScript gateway service (laptop; portable to Raspberry Pi; `serialport` adapter: build-order item 8, D34)
  │  1. decode serial frame → LoRa payload → validate
  │  2. durable write to local SQLite  ◄── system of record in the field
  │  3. STORAGE_ACK back down the same path (only after step 2 commits),
  │     inside the robot's post-uplink receive window
  ▼
Local HTTP API on the field LAN (no internet needed)
  ▼
Mobile app (Android, on the same Wi-Fi) and laptop-hosted web build
```

### 2. Cloud mirror path (optional, when internet returns)

```
Gateway SQLite outbox ──idempotent upsert──► Hosted Supabase (PostgreSQL + RLS)
                                                   ▼
                                     Vercel-hosted web build / online clients
```

Field operation, local recommendations, and CSV exports never depend on
path 2. Records are labelled "synced" only after Supabase confirms
persistence.

### Direction of data

The **radio link is bidirectional**: robot → gateway carries readings, status
packets and (if ever enabled) command reports; gateway → robot carries
storage ACKs. **The applications remain observe-only** (CLAUDE.md, locked):
no commands, settings, navigation plans, or dosing instructions flow from the
app or cloud to the robot. Dose calculation, expected post-correction pH,
navigation, and field decisions stay on the robot.

A manual-command downlink was requested for Phase 3. It is **specified and
simulated but disabled** in code (decision D21): every send path requires an
architecture decision and a hardware safety sign-off that do not exist. See
[`protocol.md`](protocol.md) §6–7 for the contract and the required robot
safe behaviour.

## Repository layout (Phase 3)

```
Robolime/
├── apps/
│   ├── mobile/            Expo + React Native + TypeScript app (Android + web)
│   └── gateway/           Offline field gateway (Node, TypeScript, node:sqlite)
│       ├── migrations/    Ordered SQLite migrations (0001_initial.sql)
│       └── src/           db, store, pairing, api, sync mapping, seed, cli,
│                          protocol (uplink + bridge session), sim (simulator)
├── packages/
│   └── shared/            Domain contracts, local API v1 contract, pure
│                          utilities, protocol contracts (src/protocol),
│                          generated Supabase types (src/generated)
├── supabase/              Cloud-mirror migrations, synthetic seed, RLS tests
├── docs/                  Architecture, protocol, gateway, cloud mirror, open items, decisions
├── Website/               Pre-existing placeholder page (untouched)
├── PCB Schematic/         Pre-existing KiCad files (untouched)
├── eslint.config.js       One lint config for all workspaces
└── package.json           npm workspaces root
```

Details: [`local-gateway.md`](local-gateway.md) (SQLite, pairing, API,
outbox, backup) and [`cloud-mirror.md`](cloud-mirror.md) (Supabase schema,
mapping, RLS, type generation).

## Components and their status

| Component | Status |
|---|---|
| Shared domain types (readings, status, run type, timestamps, sync state, field selection, recommendation) | Phase 1–2 — implemented as contracts |
| Formatting utilities (pH, metric units, state labels, cell progress, staleness) | Phase 1 — implemented and unit tested |
| Expo app landing screen | Phase 1 — implemented; now shown only on native builds with no gateway URL configured |
| Web app: pairing + robot status, served by the gateway (`--web-dir`, loopback) | M5a — implemented and committed locally (not yet published); unit/screen tests and headless-Edge checks on loopback with synthetic data (D33); no cell progress, map or field selection; not tested on a phone, LAN, Android device, outdoors or hardware |
| Web export (`expo export --platform web`) | Phase 1 — builds locally; all assets bundled, no CDN references |
| Local SQLite schema, migrations, idempotent reading/status storage | Phase 2 — implemented and tested |
| Durable sync outbox (state machine, restart recovery) | Phase 2 — contract implemented and tested; Phase 4 M6a added the worker lease, fenced claims and blocked entries (migration 0002); the upload worker is the cloud sync worker row below |
| Local pairing (scrypt verifier) and persisted sessions | Phase 2 — implemented and tested, offline |
| Local API v1 contract + transport-independent handler with robot-scoped auth | Phase 2 — implemented and tested |
| Local HTTP server for the API (`src/http`, `npm run serve`) | Phase 4 M1 — implemented and tested on **loopback only** (D28); M1 itself had no LAN binding, web hosting or live updates. Opt-in web-app hosting on loopback was added later by M5a (D33); opt-in LAN binding was added later by D36 (see the LAN binding row) |
| Pairing-attempt rate limiting (5 failures per client IP per 15 min, in memory) | Phase 4 M2 — implemented and tested on loopback only (D30); not tested on a LAN or phone |
| Cloud-mirror schema, RLS, generated types | Phase 2 — tested on a throwaway local PostgreSQL; **not applied to hosted Supabase** |
| Synthetic demo seed (SQLite + generated cloud SQL with the same IDs) | Phase 2 — implemented and tested |
| Local/cloud data-source adapters in the app | Not started (Phase 5) |
| USB serial contract v1 (COBS + CRC-16 framing, streaming reader) | Phase 3 — implemented and tested in software; **proposed** until bridge firmware + loopback test |
| LoRa contract v1 (logical messages, validation, size limit, codec boundary) | Phase 3 — implemented and tested; **byte layout not signed off**, so the real codec refuses to decode/encode |
| Write-before-ACK uplink handling + bridge protocol session | Phase 3 — implemented and tested with the simulator (no serial port, no timers) |
| Bridge runtime (`src/runtime`: transport interface, poll timer, ordered writes, reconnect, `bridge:simulate`) | Phase 4 M3 — implemented and tested with a **simulated** bridge into demo databases only (D31); refuses hardware while the radio schedule and wire codec are unconfirmed; no serial adapter |
| Packet/bridge simulator (duplicates, gaps, late/out-of-order, retries, dosing + verification) | Phase 3 — implemented; SIMULATION-ONLY codec |
| Half-duplex downlink scheduler | Phase 3 — implemented and tested; window timing unconfirmed |
| Manual-command contract, tracker, robot reference model | Phase 3 — specified and tested in simulation; **disabled (D21)** |
| Firmware (robot ESP32, gateway bridge ESP32, Nano) | Not in this repository; nothing built or flashed |
| LAN binding for the HTTP server (opt-in; D28 sets the loopback-only policy and the rate-limit prerequisite, D30 records LAN binding as unauthorised; D36 sets the opt-in policy) | Phase 4 — implemented (D36), opt-in only: `GATEWAY_LAN_MODE=on`/`--lan` plus an assigned RFC 1918 IPv4 address, fail closed, exact `<IPv4>:<port>` Host; loopback stays the default. Automated tests only; opt-in real-socket and physical phone/LAN tests not run |
| Cloud sync worker (retrying, resumable, idempotent upload from the outbox) | Phase 4 M6a–M6d — implemented (D35: single-worker lease, verified read-back confirmation, retry/ambiguity/conflict handling; `src/sync/`, `src/cli/sync.ts`, not yet an npm script); tested against an in-process fake PostgREST and, in the opt-in A2 run (2026-10-25), against a throwaway local PostgreSQL 17.5 + standalone PostgREST 16.4 on loopback (12 of 12 integration tests passed; a later run that added R14, a restart across two real processes with real lease expiry, passed 13 of 13; `cloud-mirror.md`). **Not verified on the official Supabase stack or the hosted project** (OPEN_ITEMS #17); see exit checklist rows 6–9 |
| `serialport` adapter for the bridge runtime and physical hardware integration | Not implemented — moved to build-order item 8 (D34); blocked on firmware/hardware sign-offs (OPEN_ITEMS #1, #8, #15, #18, #19, #20, #26, #31, #33) |
| Push-based live updates (server-sent events, WebSockets) | Not planned for Phase 4 — the 10 s status polling satisfies status refresh (D34); filling map cells as records arrive is dashboard work (build-order item 5) |
| Online (cloud) pairing / robot-claim flow | Not started — trusted boundary defined (OPEN_ITEMS #14) |
| Crop recommendation engine | Not started — rule tables exist; needs sourced crop data |
| Research CSV exports (`src/exports`, `npm run export:csv`: readings, paired dosing/verification, delivery) | M4 — implemented and tested offline from local SQLite, read-only (D32); first-attempt delivery ratio not computed (OPEN_ITEMS #15); EC unit unconfirmed (#7); no HTTP route or app UI yet |
| Vercel deployment | Not changed — see "Vercel" below |

## Phase 4 exit checklist (PROPOSED, D34)

Scope rulings A–C are decided in D34. The criteria, statuses and closing
rule below are **PROPOSED** and need the project lead's approval. Sources:
`CLAUDE.md` §12 item 4 (the Phase 4 definition), §3, §6, §7 and §10.

Status key: **Verified** = implemented and verified by automated or local
integration tests; **Partly verified** = implemented but not adequately
verified; **Not implemented**; **Blocked** = waiting on a prerequisite or
approval; **Deferred** = assigned to another build-order item by D34.

| # | Criterion | Source | Status | Evidence / what is still needed |
|---|---|---|---|---|
| 1 | SQLite is the durable source of truth (WAL, `synchronous=FULL`, migrations, purpose guard) | §3, §7; item 4 | Verified | Gateway store and migration tests |
| 2 | Write-before-ACK ordering | §6; item 4 | Verified in simulation; wire-level proof **Deferred** to item 8 | `bridgeSession.ts` + simulator tests; real serial/LoRa proof needs the item 8 adapter |
| 3 | Offline gateway operation, including research CSV exports | §3, §9; item 4 | Verified on loopback | M1–M4 tests; no LAN or field run |
| 4 | Loopback HTTP API and its security boundary (Host check, JSON-only POST, body/time limits, rate limit, robot-scoped sessions) | §3, §7; D28, D30 | Verified on loopback | `src/http` and pairing tests |
| 5 | **LAN HTTP API** (opt-in binding, private-interface policy, existing Host/rate-limit checks on the LAN) | item 4; §3 | **Partly verified**: implemented per D36; automated security tests pass (address policy and fail-closed binding with injected interfaces, a real failed bind with no fallback, the exact LAN Host check plus auth, robot scope, D30, request limits, headers and no CORS on loopback sockets with the LAN policy) | The opt-in real-socket test on a private interface (`ROBOLIME_LAN_SOCKET_TEST=1`, not run); the physical phone/LAN test (item 8, #6) |
| 6 | **Retrying, resumable, idempotent cloud sync**, one-way, with pending/syncing/synced/failed states | item 4; §6, §7 | **Verified** against a local target: implemented (M6b–M6d, D35); automated tests against the fake PostgREST, plus the opt-in A2 integration run (2026-10-25) against a throwaway local PostgreSQL 17.5 and standalone PostgREST 16.4 on loopback, 12 of 12 passing, and 13 of 13 in a later run that added R14 (full sync, replay, retry after network loss, ambiguous write, partial aggregate, restart across two real processes; `cloud-mirror.md`) | Not verified on the official Supabase stack (gateway `apikey` handling, real roles, key formats: OPEN_ITEMS #17) or the hosted project; an npm script for the worker (needs approval) |
| 7 | Recovery after interrupted writes, gateway restart, partial upload and network loss; records end up in the cloud exactly once | §10 ("internet loss … exactly once"); §7 ("replayed cloud sync, gateway restart, disk/write failure, and partial upload") | Local outbox and lease recovery Verified (`recoverInterrupted`, `syncLease.test.ts`); local write failure Verified: a failed SQLite write sends no ACK (`bridgeSession.test.ts`, `bridgeRuntime.test.ts`); worker recovery **Verified** against a local target: network loss mid-run, lost response after commit, partial aggregate and lost lease (injected clock) verified against local PostgreSQL 17.5 + standalone PostgREST 16.4 (A2 R12, R13, R15, R16); sync-worker CLI process restart/recovery (`src/cli/sync.ts`; not the HTTP server or the bridge runtime) verified with two real OS processes sharing one SQLite file and **real** lease expiry, no injected clock (A2 R14: the first process killed after the cloud committed its insert, the second refused while the lease was live, then taking over after expiry; scenario and scope limits in `cloud-mirror.md`), each ending with every record in the cloud exactly once; restart on a file database with lease takeover also verified against the fake endpoint (`sync/worker.test.ts`) | Not verified on the official Supabase stack (OPEN_ITEMS #17) |
| 8 | Duplicates ignored, parents before children, cloud confirmation required before `synced` | §6, §7 | Local contract Verified (parent gating across batches, fenced `markSyncedFenced` that requires a verified read-back confirmation, database trigger, idempotent ingest); end-to-end **Verified** against local PostgreSQL 17.5 + standalone PostgREST 16.4 (A2: parents first under real foreign keys with nothing blocked; `synced` only after read-back, with the cloud's own `cloud_received_at`; natural-key clash blocked as `identity_conflict`, differing content as `content_conflict`, database checks as `row_rejected`; a row-capped read, HTTP 206, never confirmed); conflicting duplicates are blocked for review (`failed` + `block_reason`), not retried forever | Not verified on the official Supabase stack (OPEN_ITEMS #17) |
| 9 | Replaying a batch twice creates no duplicates | §10 | Local batch replay Verified (gateway store and simulator tests); SQL-level: `rls_robot_scope.test.sql` checks only a **single-row** `insert … on conflict do nothing` replay (not batch replay through a worker); worker-level: replay of the whole demo dataset **Verified** against the fake endpoint and against local PostgreSQL 17.5 + standalone PostgREST 16.4 (A2 R2: no new cloud rows; every entry confirmed as a duplicate) | Not verified on the official Supabase stack (OPEN_ITEMS #17) |
| 10 | Safety gates and simulation/field separation unchanged (`MANUAL_COMMANDS_APPROVED = false`, `RADIO_SCHEDULE = null`, loopback default, no CORS, demo-only simulation, no secrets) | §3; D17, D21, D28, D31 | Verified | Code and tests; must still hold at exit |
| 11 | Status refresh: 10 s non-overlapping polling with ages, stale and unavailable states | §5; D33, D34-B | Verified (tests + headless Edge on loopback) | Push updates not in Phase 4 |
| 12 | Serial/LoRa adapter and hardware integration | §3, §6; item 8 | **Deferred** to item 8 and **Blocked** (OPEN_ITEMS #1, #8, #15, #18, #19, #20, #26, #31, #33) | Firmware/hardware sign-offs first |
| 13 | Field workflow with WAN disconnected, Android app on the LAN, physical network (#6) | §10 ("Test the complete field workflow …"); item 8 | **Deferred** to item 8 — not verified | Physical test |
| 14 | All screens on Android and web under the §10 conditions; outdoor readability | §10; items 8–9 | **Deferred** — not verified | Devices and outdoor test |
| 15 | Hosted Supabase validation and "later cloud synchronization" tests; Vercel build | §10; items 8–9 (Vercel: item 9); OPEN_ITEMS #14, #17 | **Blocked** on approval / **Deferred** to items 8–9 (Vercel: item 9) | Docker and hosted access approvals |

**Proposed closing rule:** Phase 4 software closes only when rows 1–11 are
Verified at the level each row states, and rows 12–15 stay recorded as
Deferred or Blocked with their sources. This requires:
- row 5: the LAN HTTP API implemented and verified by automated tests (after
  a new decision authorises LAN binding);
- rows 6–9: the retrying cloud sync worker implemented, with its end-to-end
  local tests (recovery, replay, ordering, confirmation before `synced`)
  passing; the existing local outbox and single-row SQL evidence is not
  enough on its own;
- row 2: verified in simulation; its wire-level proof stays Deferred to
  item 8 and does not block Phase 4.

Closing Phase 4 would not imply LAN, field, hosted or hardware readiness.

## Timestamps

Every record carries up to three clocks (`RobotTimestamps` in
`packages/shared`): robot-side time (the only user-facing measurement time),
gateway receipt time, and cloud sync time. They are never conflated. In
SQLite they are separate columns (`robot_*_at`, `gateway_*_at`) plus
`sync_outbox.cloud_confirmed_at`; in the cloud, `cloud_received_at` is set by
the database itself.

## Identity

Every mirrored row uses a deterministic UUIDv5 derived from its natural key,
identical in SQLite and PostgreSQL. Readings are keyed by
`(run_id, cell_index, seq)`; firmware run/robot identifiers are stored as
opaque text and never assumed to be UUIDs. See `local-gateway.md`.

## Staleness

Status packets arrive once per cell with no heartbeat, so the app can only
know the state as of the last completed cell. Telemetry older than
`STALE_THRESHOLD_SECONDS` (provisionally 240 s) is shown as stale; nothing is
ever labelled "live".

## Vercel (future settings — not applied)

The Expo app lives in `apps/mobile` inside an npm workspace, so dependencies
must be installed from the repository root. When the team approves the
online deployment, configure the **existing** Vercel project as follows:

| Setting | Value |
|---|---|
| Framework preset | Other |
| Root Directory | *(repository root — leave empty)* |
| Install Command | `npm ci` |
| Build Command | `npm run build:web` |
| Output Directory | `apps/mobile/dist` |
| Node.js version | an LTS version supported by Expo SDK 58 (e.g. 22.x or 24.x) |

When multi-screen navigation is added, a rewrite of unknown paths to
`/index.html` (or Expo Router static output) will also be needed. Until the
Expo build is actually deployed there, the current Vercel site must not be
described as the RoboLime app.

## Local (laptop) web hosting

The gateway already serves the `apps/mobile/dist` export, opt-in with
`--web-dir` or `GATEWAY_WEB_DIR`, on its **loopback** address only (M5a, D33;
see `local-gateway.md`). With opt-in LAN mode (D36) it is served on the
laptop's private LAN address instead; that is verified by automated tests
only, and phone/field-network acceptance is still outstanding (checklist row
5, OPEN_ITEMS #6). `npx expo serve` from `apps/mobile` previews the screens but cannot
reach the API, because the web app only calls its own origin.
