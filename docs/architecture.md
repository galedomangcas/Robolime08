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

(Later status, 2026-10-25: under D40 and D41 the field deployment is
**laptop-only**. There is no local Wi-Fi network in the field workflow, and
the phone is not part of it.)

## Deployment environments (D41)

| Environment | Purpose | Runs on | Depends on |
|---|---|---|---|
| **Online** | Access for farmers, researchers and thesis panel members when internet is available | Vercel (hosted Expo web build) + hosted Supabase (database, RLS-scoped cloud data access) | Internet |
| **Local field** | Field operation when internet is unavailable | The team's laptop: local app (loopback), TypeScript gateway, SQLite | Nothing online: no internet, Vercel or Supabase |

Both environments come from the one shared codebase (D2), and both are
required before product release (D39). The local field data path is: robot
LoRa → existing receiver hardware → USB serial → laptop gateway → durable
SQLite write → local app. When internet is available, the gateway syncs to
Supabase one way. No phone, LAN or other phone-to-laptop connection is part
of the field deployment (D40, D41).

**Implemented today vs. required** (see D41 for detail):
- **Local, implemented and tested on loopback:** gateway, SQLite, API, local
  web app, CSV exports, and the sync worker (local target only).
- **Local, not implemented or tested:** the physical robot/receiver/USB path
  (row 12).
- **Online, not implemented:** the app's cloud data adapter and the online
  claim flow; the schema hasn't been run on the official Supabase stack or
  applied to the hosted project; Vercel isn't configured or deployed.

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

(Later status, 2026-10-25: D40 excludes LAN project-wide. The last two steps
above are historical. The local API and web build are reachable on the
laptop's loopback address only. D41 resolved the resulting question of
offline phone access (OPEN_ITEMS #40): the phone is not part of field
operation, and the local app runs on the laptop.)

### 2. Cloud mirror path (optional, when internet returns)

(Later status: the online deployment this path feeds is a release
requirement (D39, D41). It is "optional" only in the sense that field
operation never waits for it.)

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
| LAN binding for the HTTP server (opt-in; D28 sets the loopback-only policy and the rate-limit prerequisite, D30 records LAN binding as unauthorised; D36 sets the opt-in policy) | Phase 4 — implemented (D36), opt-in only: `GATEWAY_LAN_MODE=on`/`--lan` plus an assigned RFC 1918 IPv4 address, fail closed, exact `<IPv4>:<port>` Host; loopback stays the default. Automated tests only; opt-in real-socket and physical phone/LAN tests not run. **D40: LAN excluded project-wide; the code stays, unused and out of scope; those tests will not be performed** |
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
| 3 | Offline gateway operation, including research CSV exports | §3, §9; item 4 | Verified on loopback | M1–M4 tests; no LAN or field run. The absence of any network or cloud dependency is shown by code and automated tests (e.g. `localApi.test.ts`, "…need no Supabase client, cloud request or network"); **no test with the network physically disconnected has been run** (that is the row 13 field test) |
| 4 | Loopback HTTP API and its security boundary (Host check, JSON-only POST, body/time limits, rate limit, robot-scoped sessions) | §3, §7; D28, D30 | Verified on loopback | `src/http` and pairing tests |
| 5 | **LAN HTTP API** (opt-in binding, private-interface policy, existing Host/rate-limit checks on the LAN) | item 4; §3 | **Out of Scope under D40** (2026-10-25): LAN is excluded project-wide; neither passed nor failed, and not a mandatory closure criterion. Historical status before D40: Partly verified (D36 code with automated tests on loopback sockets) | None for Phase 4. The real-socket and physical LAN tests will **not** be performed (D40). Loopback API requirements stay in row 4 |
| 6 | **Retrying, resumable, idempotent cloud sync**, one-way, with pending/syncing/synced/failed states | item 4; §6, §7 | **Verified** against a local target: implemented (M6b–M6d, D35); automated tests against the fake PostgREST, plus the opt-in A2 integration run (2026-10-25) against a throwaway local PostgreSQL 17.5 and standalone PostgREST 16.4 on loopback, 12 of 12 passing, and 13 of 13 in a later run that added R14 (full sync, replay, retry after network loss, ambiguous write, partial aggregate, restart across two real processes; `cloud-mirror.md`). Re-run at commit `3009774` (2026-10-25 17:35–17:38, same harness and versions): 13 of 13 passed (see "Verification record — local sync integration run at `3009774`") | Not verified on the official Supabase stack (gateway `apikey` handling, real roles, key formats: OPEN_ITEMS #17) or the hosted project; an npm script for the worker (needs approval); no physical robot/serial/LoRa data path (row 12) |
| 7 | Recovery after interrupted writes, gateway restart, partial upload and network loss; records end up in the cloud exactly once | §10 ("internet loss … exactly once"); §7 ("replayed cloud sync, gateway restart, disk/write failure, and partial upload") | Local outbox and lease recovery Verified (`recoverInterrupted`, `syncLease.test.ts`); local write failure Verified: a failed SQLite write sends no ACK (`bridgeSession.test.ts`, `bridgeRuntime.test.ts`); worker recovery **Verified** against a local target: network loss mid-run, lost response after commit, partial aggregate and lost lease (injected clock) verified against local PostgreSQL 17.5 + standalone PostgREST 16.4 (A2 R12, R13, R15, R16); sync-worker CLI process restart/recovery (`src/cli/sync.ts`; not the HTTP server or the bridge runtime) verified with two real OS processes sharing one SQLite file and **real** lease expiry, no injected clock (A2 R14: the first process killed after the cloud committed its insert, the second refused while the lease was live, then taking over after expiry; scenario and scope limits in `cloud-mirror.md`), each ending with every record in the cloud exactly once; restart on a file database with lease takeover also verified against the fake endpoint (`sync/worker.test.ts`). A2 R12–R16 re-run at `3009774` (2026-10-25): passed | Not verified on the official Supabase stack (OPEN_ITEMS #17) or the hosted project; no physical robot/serial/LoRa data path (row 12) |
| 8 | Duplicates ignored, parents before children, cloud confirmation required before `synced` | §6, §7 | Local contract Verified (parent gating across batches, fenced `markSyncedFenced` that requires a verified read-back confirmation, database trigger, idempotent ingest); end-to-end **Verified** against local PostgreSQL 17.5 + standalone PostgREST 16.4 (A2: parents first under real foreign keys with nothing blocked; `synced` only after read-back, with the cloud's own `cloud_received_at`; natural-key clash blocked as `identity_conflict`, differing content as `content_conflict`, database checks as `row_rejected`; a row-capped read, HTTP 206, never confirmed); conflicting duplicates are blocked for review (`failed` + `block_reason`), not retried forever. A2 re-run at `3009774` (2026-10-25): passed | Not verified on the official Supabase stack (OPEN_ITEMS #17) or the hosted project |
| 9 | Replaying a batch twice creates no duplicates | §10 | Local batch replay Verified (gateway store and simulator tests); SQL-level: `rls_robot_scope.test.sql` checks only a **single-row** `insert … on conflict do nothing` replay (not batch replay through a worker); worker-level: replay of the whole demo dataset **Verified** against the fake endpoint and against local PostgreSQL 17.5 + standalone PostgREST 16.4 (A2 R2: no new cloud rows; every entry confirmed as a duplicate); A2 R2 re-run at `3009774` (2026-10-25): passed | Not verified on the official Supabase stack (OPEN_ITEMS #17) or the hosted project |
| 10 | Safety gates and simulation/field separation unchanged (`MANUAL_COMMANDS_APPROVED = false`, `RADIO_SCHEDULE = null`, loopback default, no CORS, demo-only simulation, no secrets) | §3; D17, D21, D28, D31 | Verified for the gates and simulation/field separation (code and tests). "No secrets": code inspection and `.gitignore`, plus a counts-only scan of a **locally built** web export (2026-10-25, commit `3009774`, 0 matches in every category; see "Verification record — local web-bundle secret scan") | Code and tests; must still hold at exit. **Only the local build was scanned**: the Vercel-built bundle and Vercel's environment variables have **not** been scanned (release-time check) |
| 11 | Status refresh: 10 s non-overlapping polling with ages, stale and unavailable states | §5; D33, D34-B | Verified (tests + headless Edge on loopback) | Push updates not in Phase 4 |
| 12 | Serial/LoRa adapter and hardware integration | §3, §6; item 8 | **Deferred** to item 8 and **Blocked** (OPEN_ITEMS #1, #8, #15, #18, #19, #20, #26, #31, #33) | Firmware/hardware sign-offs first |
| 13 | Field workflow with WAN disconnected, Android app on the LAN, physical network (#6) | §10 ("Test the complete field workflow …"); item 8 | **Deferred** to item 8 — not verified. The "Android app on the LAN" part is Out of Scope under D40; under D41 no phone is part of field operation (#40 resolved) | Physical test of the WAN-disconnected **laptop-only** field workflow |
| 14 | All screens on Android and web under the §10 conditions; outdoor readability | §10; items 8–9 | **Deferred** — not verified. Under D41, offline Android access to the laptop is not required; the field screens run on the laptop | Devices and outdoor test, for the laptop app and the online app |
| 15 | Hosted Supabase validation and "later cloud synchronization" tests; Vercel build | §10; items 8–9 (Vercel: item 9); OPEN_ITEMS #14, #17 | **Blocked** on approval / **Deferred** to items 8–9 (Vercel: item 9) | Docker and hosted access approvals |

**Proposed closing rule:** Phase 4 software closes only when rows 1–11 are
Verified at the level each row states, and rows 12–15 stay recorded as
Deferred or Blocked with their sources. This requires:
- row 5: the LAN HTTP API implemented and verified by automated tests (after
  a new decision authorises LAN binding); (later status, 2026-10-25: D36 was
  that decision and implemented opt-in LAN binding; no further LAN-policy
  decision is needed. The opt-in real-socket test and physical-device
  acceptance remain unverified);
- rows 6–9: the retrying cloud sync worker implemented, with its end-to-end
  local tests (recovery, replay, ordering, confirmation before `synced`)
  passing; the existing local outbox and single-row SQL evidence is not
  enough on its own;
- row 2: verified in simulation; its wire-level proof stays Deferred to
  item 8 and does not block Phase 4.

Closing Phase 4 would not imply LAN, field, hosted or hardware readiness.

**Closing rule AMENDED (D39, 2026-10-25):** the rule above is kept as the
original proposal. The project owner amended it:
- Phase 4 may close only when every criterion designated as mandatory for
  Phase 4 has adequate documented evidence.
- Deferred hardware, field and production-release requirements stay
  explicitly open and are never described as passed.
- Closing Phase 4 is not product release readiness. Both the local/offline
  and the hosted Supabase + Vercel deployments are required before release
  (D39).
- No closing rule overrides the safety gates.

The rows 1–11 / 12–15 split stays the working designation until the owner
confirms it. **Phase 4 is not complete.**

**D40 reconciliation (2026-10-25):** LAN is excluded project-wide. Row 5 is
Out of Scope and leaves the mandatory set, so the mandatory Phase 4 criteria
are now **rows 1–4 and 6–11**. Each still needs adequate documented evidence.
Rows 12–15 stay Deferred or Blocked; their LAN parts are out of scope. The
row-5 bullet of the proposed rule above is historical. Phase 4 closure still
does not mean product release readiness. **Phase 4 is not complete.**

**D41 (2026-10-25):** the field deployment is laptop-only, and offline
Android access is not a criterion. The mandatory set stays rows 1–4 and 6–11,
with the same evidence requirements. Hosted Supabase validation and the
Vercel deployment remain release requirements (D39), not Phase 4 criteria.
**Phase 4 is not complete.**

### Verification record — automated suites, 2026-10-25

- **When and where:** 2026-10-25, 15:52–15:53 Philippine time (UTC+08:00;
  the shell labelled it "MPST"). Windows 11, Node.js v26.11.1, run from the
  repository root.
- **Source state:** HEAD `ef2ba25741a5d632b5fb7cfaf771babe08b9e6f9` plus an
  **uncommitted, dirty working tree.** The uncommitted changes were
  documentation (`CLAUDE.md`, `docs/OPEN_ITEMS.md`, `docs/architecture.md`,
  `docs/decisions.md`, `docs/protocol.md`) and the `description` field of
  `apps/gateway/package.json`. No source, test, script, dependency or lockfile
  differed from HEAD. This record was itself added to `docs/architecture.md`
  after the runs.
- **Environment:** `ROBOLIME_LAN_SOCKET_TEST`, the `ROBOLIME_SYNC_IT_*`
  variables and all `SUPABASE_*` variables were **unset**, so the opt-in tests
  skipped. No network, LAN bind, serial, radio, hardware, Docker, Supabase or
  Vercel use.

| Suite | Command (from the repository root) | Exit | Result |
|---|---|---|---|
| Gateway | `npm run test -w @robolime/gateway` (vitest) | 0 | 26 files passed, 1 skipped (27); **507 passed, 15 skipped** (522); 0 failed |
| Shared | `npm run test -w @robolime/shared` (vitest) | 0 | 8 files passed; **124 passed**; 0 failed, 0 skipped |
| Mobile | `npm run test -w @robolime/mobile` (jest) | 0 | 8 suites passed; **92 passed**; 0 failed, 0 skipped; 0 snapshots |

A second gateway run with the verbose reporter
(`npx vitest run --reporter=verbose` in `apps/gateway`, exit 0, same totals)
identified the 15 skipped tests:
- 13 in `src/sync/worker.integration.test.ts`. These are opt-in and need the
  `run-sync-integration.mjs` harness (local PostgreSQL + PostgREST); their
  latest recorded results are the A2 runs in `cloud-mirror.md`, **not** this
  run.
- 1 in `src/http/server.test.ts`, the opt-in real LAN bind
  (`ROBOLIME_LAN_SOCKET_TEST=1`, not run).
- 1 in `src/http/static.test.ts`, the symlink test (symlinks unavailable on
  this Windows account).

The machine-dependent cases (IPv6 loopback, unassigned-address
`EADDRNOTAVAIL`) ran and passed. No warnings were reported.

**What this establishes:** the automated unit and loopback-socket tests for
rows 1–4 and 9–11, and the fake-endpoint and simulation parts of rows 2 and
6–9, pass on this source state.

**What it does not establish:**
- the opt-in LAN real-socket test or physical LAN/Android acceptance (row 5,
  #6)
- real robot, serial or LoRa integration (row 12)
- the local PostgreSQL/PostgREST integration runs (see A2)
- official Supabase validation or the hosted project (#17)
- a Vercel deployment
- full offline field acceptance with the network disconnected (row 13)

Typecheck and lint were not part of this run. Phase 4 is still not complete.

### Verification record — local web-bundle secret scan, 2026-10-25 (row 10)

- **When and source:** build started 17:17:32 Philippine time (UTC+08:00),
  scan at 17:20:44. HEAD `30097746c0f6aa514e6036fc7339517320aeeacc`, with
  uncommitted changes limited to documentation and the `description` field of
  `apps/gateway/package.json` (no app source, configuration or dependency
  differed from HEAD). Windows 11, Node.js v26.11.1.
- **Build environment:** no `.env` file was found in the repository root,
  `apps/mobile` or `apps/gateway` (presence checked only). The shell
  environment at build time was **not** captured, so it is not established
  that every `EXPO_PUBLIC_*` value was unset. A check performed **after** the
  build found zero `EXPO_PUBLIC_*` variables in the current shell; that does
  not establish the build-time environment.
- **Build:** `npm run build:web` (= `expo export --platform web` in
  `apps/mobile`), exit 0.
- **Output scanned:** `apps/mobile/dist` (Expo's default output, ignored by
  Git). The export replaced the earlier output: all **4** files were newer
  than the build start, and no older file remained. Files: the JS bundle
  `_expo/static/js/web/index-32bc77c97e8e78c982a49c4cb645d2df.js`,
  `index.html`, `metadata.json` and `favicon.ico`; 475,322 bytes in total.
  There are no source maps (`*.map`) and no `sourceMappingURL` references.
- **Method:** a Node script read every file in full and reported counts only,
  never matched values. A positive control showed every pattern matches
  synthetic markers, and that the script reads the real bundle (it finds
  known strings such as `/api/v1`).
- **Result: 0 matches in every category:**
  - secret names and markers: `SUPABASE_SERVICE_ROLE_KEY`, `service_role`,
    `sb_secret_`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `sb_publishable_`
  - every gateway-only variable in `apps/gateway/.env.example`:
    `GATEWAY_DB_PATH`, `GATEWAY_HOST`, `GATEWAY_LAN_MODE`, `GATEWAY_PORT`,
    `GATEWAY_WEB_DIR`, `GATEWAY_SERIAL_PORT`, `GATEWAY_SESSION_TTL_DAYS`
  - test-only variables: `ROBOLIME_*`, `PGTEST_`, `POSTGREST_`, `PG_BIN`
  - `EXPO_PUBLIC_*` names
  - PEM private-key headers, JWT-shaped strings, `postgres://` connection
    strings, password assignments
  - local user paths, email addresses

**Limitations:** this covers only this locally built bundle, built with no
`.env` file present (build-time shell environment not captured). It does not
cover the bundle Vercel builds, Vercel's
environment variables, a build with a populated `.env`, or the native
Android bundle. Pattern scanning can't prove the absence of every possible
secret format. Phase 4 is still not complete.

### Verification record — typecheck, lint and all suites at `3009774`, 2026-10-25

- **When and source:** 17:26:28–17:27:04 Philippine time (UTC+08:00), with a
  verbose gateway rerun at 17:27:35. HEAD
  `30097746c0f6aa514e6036fc7339517320aeeacc`, which includes the expanded
  timestamp regression tests. Uncommitted changes: documentation, plus the
  `description` field of `apps/gateway/package.json`; no source, test,
  script, configuration, dependency or lockfile differed from HEAD.
  Windows 11, Node.js v26.11.1, npm 11.20.0, run from the repository root.
- **Environment:** no `ROBOLIME_*`, `PGTEST_*`, `POSTGREST_*`, `SUPABASE_*`
  or `EXPO_PUBLIC_*` variables were set in the shell (checked before the
  run), so the opt-in tests skipped. No network, LAN bind, serial, radio,
  hardware, Docker, Supabase or Vercel use.

| Check | Command | Exit | Result |
|---|---|---|---|
| Typecheck (static) | `npm run typecheck` (`tsc --noEmit` in gateway, mobile, shared) | 0 | 0 errors |
| Lint (static) | `npm run lint` (`eslint .`) | 0 | 0 errors, **1 warning**: `apps/gateway/src/http/config.ts:117`, `@typescript-eslint/array-type` (prefer `readonly T[]` over `ReadonlyArray<T>`); the line comes from commit `ef2ba25` (D36). Not fixed: code changes were out of scope |
| Gateway tests | `npm run test -w @robolime/gateway` (vitest) | 0 | 26 files passed, 1 skipped (27); **507 passed, 15 skipped** (522); 0 failed |
| Shared tests | `npm run test -w @robolime/shared` (vitest) | 0 | 8 files; **127 passed**; 0 failed or skipped |
| Mobile tests | `npm run test -w @robolime/mobile` (jest) | 0 | 8 suites; **92 passed**; 0 failed or skipped; 0 snapshots |

The 15 gateway skips (confirmed by
`npx vitest run --reporter=verbose` in `apps/gateway`, exit 0, same totals):
- 13 in `src/sync/worker.integration.test.ts` (R1–R16). These are opt-in
  local integration tests; their latest recorded results are the A2 runs in
  `cloud-mirror.md`, **not** this run.
- 1 in `src/http/server.test.ts`: the opt-in real LAN bind (out of scope
  under D40).
- 1 in `src/http/static.test.ts`: the symlink test (symlinks unavailable on
  this Windows account).

**What this establishes:** static checks (typecheck, lint) and automated unit
and loopback-socket tests pass at `3009774`. This includes the simulation
evidence for row 2 and the fake-endpoint sync tests for rows 6–9. It
supersedes the earlier "automated suites" record as the current evidence for
automated tests; that record remains as history.

**What it does not establish:**
- the local PostgreSQL/PostgREST integration runs (A2, not rerun)
- official Supabase validation or the hosted project
- a Vercel build or deployment
- physical robot, serial or LoRa integration
- a run of the laptop field workflow with the internet disconnected (row 13)
- device or outdoor checks (row 14)
- the row 6 worker npm script, which still doesn't exist

Phase 4 is still not complete.

### Verification record — local sync integration run at `3009774`, 2026-10-25 (rows 6–9)

- **When and source:** about 17:35:51–17:38:05 Philippine time (UTC+08:00).
  HEAD `30097746c0f6aa514e6036fc7339517320aeeacc`; uncommitted changes were
  documentation plus the `description` field of `apps/gateway/package.json`
  (no source, test, configuration or dependency differed from HEAD).
- **Harness:** `node supabase/tests/run-sync-integration.mjs`, run once from
  the repository root in Git Bash. For that command only, PostgreSQL's `bin`
  folder was added to `PATH`, and `POSTGREST_BIN` pointed at an already
  installed PostgREST executable. Nothing was downloaded or installed.
- **Environment:** a **throwaway local** PostgreSQL **17.5** cluster in a new
  temp directory on `127.0.0.1:54339` (the harness confirmed the cluster's
  data directory before applying anything), with the test-only auth shim and
  the cloud-mirror migration. Two standalone PostgREST **16.4** servers ran
  on loopback (`127.0.0.1:62121`, and `127.0.0.1:62127` capped at
  `db-max-rows=5`); each was accepted only after it served this run's
  nonce-marked schema. Tokens were generated per run and never printed. No
  hosted Supabase, Vercel, Docker, LAN, hardware, serial or LoRa use.
- **Result:** exit 0; `worker.integration.test.ts` **13 passed, 0 failed, 0
  skipped** (test time 126.51 s), covering R1–R16 as in the A2 table in
  `cloud-mirror.md`. Behaviour the run reported:
  - connection refusal (`ECONNREFUSED`) handled as `network_unavailable` (R13)
  - lease contention and takeover: a second real process was refused while
    the first held the lease, then took over and recognised its record as
    already in the cloud (R14)
  - a dosing-only change rejected with database error code `23514`
- **Cleanup:** the harness reported "temporary cluster and files deleted".
  Afterwards no `robolime-sync-it-*` folder, no PostgREST process and no
  listener on ports 54339, 62121 or 62127 remained.
- **Existing PostgreSQL service:** `postgresql-x64-17` on port 5432 was not
  intentionally accessed or modified. It was running before and after on the
  same process, with the same `postgres.exe` process count, checked from the
  service status and process list only.

**What this establishes:** the A2 local integration evidence for rows 6–9
holds at `3009774` against real PostgreSQL and PostgREST on loopback. It
does **not** mark those rows or Phase 4 complete.

**Still outstanding:**
- validation on the official Supabase stack and the hosted project (#17)
- a Vercel deployment
- the row 6 worker npm script
- physical robot → receiver → USB serial → laptop verification, including
  LoRa (row 12)

Phase 4 is still not complete.

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
5, OPEN_ITEMS #6). (Later status, 2026-10-25: D40 excludes LAN project-wide.
The web app is served on loopback only, and LAN mode is not used. Under D41
this laptop-local app is the field interface.) `npx expo serve` from `apps/mobile` previews the screens but cannot
reach the API, because the web app only calls its own origin.
