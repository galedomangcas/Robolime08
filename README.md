# RoboLime

Real-Time Soil pH Monitoring and Variable-Rate Lime Dosing with Recommendation
System — BS Computer Engineering thesis, Polytechnic University of the
Philippines.

This repository holds the software (mobile app, web app, shared domain code,
the offline-first laptop gateway, and the Supabase cloud-mirror schema)
alongside the team's hardware files.

> **Status: Phase 4 milestones M1–M3 and the research CSV exports (M4) are
> implemented and committed on the local `main` branch.** As of 2026-10-24
> they had **not yet been published**: the remote `origin/main` was still at
> the Phase 3 commit `3a0e695`. Run `git log origin/main..main` to see what
> is not on the remote yet. See [`docs/architecture.md`](docs/architecture.md).
>
> **Software that exists (verified only by automated tests on a development
> computer):**
> - Expo app: a landing screen with honest "no data" states.
> - Offline field gateway (`apps/gateway`): durable SQLite store and
>   migrations, local pairing and sessions, a **loopback-only** HTTP server
>   for the read-only local API with pairing-attempt rate limiting, cloud-sync
>   outbox, write-before-ACK ingest of simulated radio messages (no real LoRa
>   decoder yet), a USB-serial protocol session and an opt-in bridge runtime
>   tested only with a simulated bridge (no serial port attached), and offline
>   research CSV exports (`npm run export:csv`).
> - USB serial and LoRa protocol contracts, a packet simulator, and the
>   Supabase cloud-mirror schema (tested on a throwaway local PostgreSQL only).
>
> **Not implemented:** the serial-port adapter, LAN access (the API is
> loopback-only; LAN binding needs separate approval), cloud upload, app
> screens and crop scoring. Nothing has been applied to hosted Supabase.
> **Manual commands are specified but disabled.**
>
> **Work in progress — M5a, NOT committed yet (decision D33):** in the
> working tree only, the web build adds a pairing screen and a robot status
> screen (state, faults, battery voltage, commanded lime, robot time and age,
> stale and "gateway unavailable" states), served by the gateway on loopback
> with `--web-dir`. No cell-progress display, map or field selection. Checked
> by automated tests and headless Edge on loopback with synthetic data only;
> not on a phone, LAN, Android device, outdoors or hardware. Until it is
> committed, the statements above describe the committed state.
>
> **Not verified on hardware:** no physical robot, ESP32, Ra-02 radio, USB
> serial link, Android device or field network has been tested. The LoRa byte
> layout is not signed off and no firmware is in this repository.

## Team setup note

Bago kayo gumamit ng git i-link niyo muna yung git sa visual studios niyo

Eto yung tutorial vid >>  https://www.youtube.com/watch?v=V7WpadAi3RI

## Repository layout

| Path | What it is |
|---|---|
| `apps/mobile/` | Expo + React Native + TypeScript app (Android and web from one codebase) |
| `apps/gateway/` | Offline field gateway: SQLite store, migrations, local pairing, read-only API handler, sync outbox, protocol session and simulator ([guide](docs/local-gateway.md)) |
| `packages/shared/` | Shared domain types, local API v1 contract, USB serial + LoRa protocol contracts ([protocol](docs/protocol.md)), pure tested utilities, generated Supabase types |
| `supabase/` | Cloud-mirror migrations, RLS, synthetic seed and local tests ([guide](docs/cloud-mirror.md)) |
| `docs/` | [Architecture](docs/architecture.md), [protocol](docs/protocol.md), [local gateway](docs/local-gateway.md), [cloud mirror](docs/cloud-mirror.md), [open items](docs/OPEN_ITEMS.md), [decisions](docs/decisions.md) |
| `CLAUDE.md` | Software master prompt / requirements |
| `Website/` | Earlier placeholder web page (kept as-is; superseded by the Expo web build) |
| `PCB Schematic/` | KiCad PCB project |

## Requirements

- **Node.js 24 LTS is recommended** for setup. The reviewed release is
  Node.js 24.22.1, listed as LTS ("Krypton") in the official Node.js release
  index; it satisfies the project's engine requirements.
  - Accepted range (`engines`): `^22.16.0 || ^24.3.0 || >=26.0.0`. The
    gateway's built-in `node:sqlite` code needs 22.16+ / 24+, and Expo SDK 58
    needs 24.3+ on the 24 line (see [decision D27](docs/decisions.md)).
  - Local validation ran on Node.js 26.11.1, which is not an LTS release.
    No other Node.js version has been run.
  - A version being accepted by `engines` does not mean it has been tested;
    in particular, future Node.js major releases are untested.
- npm (comes with Node; developed on npm 11.20.0)
- Git
- For Android: the **Expo Go** app on the phone, or Android Studio for an emulator

## Install

Always install from the **repository root** (it is an npm workspace):

```bash
npm install
```

To set a default field gateway address, copy the template and edit it:

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
```

All variables are optional; the app launches without any of them and without
internet. Never put secrets in `EXPO_PUBLIC_*` variables — they are bundled
into the app.

## Develop

```bash
npm run start     # Expo dev server (scan the QR code with Expo Go)
npm run web       # open the app in a browser
npm run android   # open on a connected Android device/emulator
```

## Check

```bash
npm run typecheck # strict TypeScript, all workspaces
npm run lint      # ESLint (expo config + no-explicit-any)
npm test          # Vitest (packages/shared, apps/gateway) + Jest (apps/mobile)
npm run check     # all three
```

## Build for the web

```bash
npm run build:web
```

Output goes to `apps/mobile/dist/`. All JavaScript and assets are bundled
locally (no CDN). To use the web app with the gateway (loopback only, on the
gateway computer):

```bash
npm run serve -w @robolime/gateway -- --db <field.sqlite> --web-dir <ABSOLUTE path to apps/mobile/dist>
# then open http://127.0.0.1:8780/
```

The web app calls the API on its own origin only, so it must be opened from
the gateway; `npm run web` (Expo dev server) and `npx expo serve` show the
screens but cannot reach the API. Details: [`docs/local-gateway.md`](docs/local-gateway.md#serving-the-web-app-opt-in-decision-d33).

Vercel deployment is **not configured yet**; the required settings are in
[`docs/architecture.md`](docs/architecture.md#vercel-future-settings--not-applied).

## Field gateway (offline)

```bash
npm run db:init -w @robolime/gateway -- --db <field.sqlite>          # create/migrate (never seeds)
npm run robot:provision -w @robolime/gateway -- --db <field.sqlite> --source-id <id> --name "<name>"
npm run pairing:provision -w @robolime/gateway -- --db <field.sqlite> --robot <id>   # shows a code once
npm run db:backup -w @robolime/gateway -- --db <field.sqlite> --out <backup.sqlite>
npm run db:seed:demo -w @robolime/gateway -- --db <demo.sqlite>       # SYNTHETIC data, separate file
```

Never commit database files, pairing codes or session tokens. Details:
[`docs/local-gateway.md`](docs/local-gateway.md).

## Cloud mirror (local tests only)

```bash
npm run db:cloud:test     # throwaway local PostgreSQL: migrations + synthetic seed + RLS tests
npm run db:cloud:types    # same, then regenerate packages/shared/src/generated/database.types.ts
```

Requires PostgreSQL server binaries (`PG_BIN`). These commands never connect
to the hosted Supabase project; do not link or push to it without team
approval. Details: [`docs/cloud-mirror.md`](docs/cloud-mirror.md).
