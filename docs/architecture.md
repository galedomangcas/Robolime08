# RoboLime software architecture

Status: **Phase 1 (foundation)**. This document records the confirmed
architecture and what actually exists in the repository today. The full
requirements live in [`CLAUDE.md`](../CLAUDE.md); open questions live in
[`OPEN_ITEMS.md`](OPEN_ITEMS.md); decisions in [`decisions.md`](decisions.md).

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
LoRa radio #1 (on robot)
  │  plain point-to-point LoRa (NOT LoRaWAN), fixed-layout binary packets
  ▼
LoRa radio #2 (ESP32/LoRa bridge, USB to laptop)
  ▼
TypeScript gateway service (laptop; portable to Raspberry Pi)
  │  1. decode packet
  │  2. durable write to local SQLite  ◄── system of record in the field
  │  3. ACK to robot (only after step 2 succeeds)
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

Robot → app only. The apps are **observe-only**: no commands, settings,
navigation plans, or dosing instructions flow back to the robot. Dose
calculation, expected post-correction pH, navigation, and field decisions stay
on the robot.

## Repository layout (Phase 1)

```
Robolime/
├── apps/
│   └── mobile/            Expo + React Native + TypeScript app (Android + web)
├── packages/
│   └── shared/            Domain contracts + pure utilities (app and future gateway)
├── docs/                  Architecture, open items, decisions
├── Website/               Pre-existing placeholder page (untouched)
├── PCB Schematic/         Pre-existing KiCad files (untouched)
├── eslint.config.js       One lint config for all workspaces
└── package.json           npm workspaces root
```

Planned for later phases (not created yet): `apps/gateway/` (TypeScript
service + SQLite + LAN API), local SQLite migrations, `supabase/` migrations,
packet simulator.

## Components and their status

| Component | Status |
|---|---|
| Shared domain types (readings, status, run type, timestamps, sync state, field selection, recommendation) | Phase 1 — implemented as contracts |
| Formatting utilities (pH, metric units, state labels, cell progress, staleness) | Phase 1 — implemented and unit tested |
| Expo app landing screen | Phase 1 — implemented; shows honest "no data" state only |
| Web export (`expo export --platform web`) | Phase 1 — builds locally; all assets bundled, no CDN references |
| Local/cloud data-source adapters | Not started |
| Gateway, SQLite, LAN API, ACK ordering | Not started |
| Binary packet decoder and simulator | Not started — blocked on signed-off packet spec |
| Pairing (local and cloud) | Not started |
| Supabase schema, RLS, sync | Not started; hosted project not touched |
| Crop recommendation engine | Not started — needs sourced crop data |
| CSV exports | Not started |
| Vercel deployment | Not changed — see "Vercel" below |

## Timestamps

Every record carries up to three clocks (`RobotTimestamps` in
`packages/shared`): robot-side time (the only user-facing measurement time),
gateway receipt time, and cloud sync time. They are never conflated.

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

The same `apps/mobile/dist` output will be served from the laptop to phones
on the field Wi-Fi. In a later phase the gateway (or a local static server)
will serve it on the LAN interface only. For a quick local preview now:
`npx expo serve` from `apps/mobile` after `npm run build:web`.
