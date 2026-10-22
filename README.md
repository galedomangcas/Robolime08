# RoboLime

Real-Time Soil pH Monitoring and Variable-Rate Lime Dosing with Recommendation
System — BS Computer Engineering thesis, Polytechnic University of the
Philippines.

This repository holds the software (mobile app, web app, shared domain code,
the offline-first laptop gateway, and the Supabase cloud-mirror schema)
alongside the team's hardware files.

> **Status: Phase 2.** The app shows a landing screen with honest "no data"
> states. The offline gateway's SQLite store, local pairing, API contract and
> sync-state model are implemented and tested, and the Supabase cloud-mirror
> schema is tested locally. The radio receiver, HTTP server, cloud upload,
> app screens, crop scoring and CSV exports are **not implemented yet**, and
> nothing has been applied to hosted Supabase.
> See [`docs/architecture.md`](docs/architecture.md).

## Team setup note

Bago kayo gumamit ng git i-link niyo muna yung git sa visual studios niyo

Eto yung tutorial vid >>  https://www.youtube.com/watch?v=V7WpadAi3RI

## Repository layout

| Path | What it is |
|---|---|
| `apps/mobile/` | Expo + React Native + TypeScript app (Android and web from one codebase) |
| `apps/gateway/` | Offline field gateway: SQLite store, migrations, local pairing, read-only API handler, sync outbox ([guide](docs/local-gateway.md)) |
| `packages/shared/` | Shared domain types, local API v1 contract, pure tested utilities, generated Supabase types |
| `supabase/` | Cloud-mirror migrations, RLS, synthetic seed and local tests ([guide](docs/cloud-mirror.md)) |
| `docs/` | [Architecture](docs/architecture.md), [local gateway](docs/local-gateway.md), [cloud mirror](docs/cloud-mirror.md), [open items](docs/OPEN_ITEMS.md), [decisions](docs/decisions.md) |
| `CLAUDE.md` | Software master prompt / requirements |
| `Website/` | Earlier placeholder web page (kept as-is; superseded by the Expo web build) |
| `PCB Schematic/` | KiCad PCB project |

## Requirements

- Node.js 22.13 or newer (the gateway uses the built-in `node:sqlite`; an LTS release is recommended; developed on Node 26.11.1)
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
locally (no CDN), so the same output can be served from the laptop on a field
Wi-Fi network with no internet. Quick local preview:

```bash
cd apps/mobile && npx expo serve
```

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
