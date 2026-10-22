# RoboLime

Real-Time Soil pH Monitoring and Variable-Rate Lime Dosing with Recommendation
System — BS Computer Engineering thesis, Polytechnic University of the
Philippines.

This repository holds the software (mobile app, web app, shared domain code,
and — in later phases — the offline-first laptop gateway) alongside the
team's hardware files.

> **Status: Phase 1 foundation.** The app currently shows a landing screen
> with honest "no data" states. Robot hardware, the gateway, pairing, cloud
> sync, crop recommendations, and CSV exports are **not implemented yet**.
> See [`docs/architecture.md`](docs/architecture.md).

## Team setup note

Bago kayo gumamit ng git i-link niyo muna yung git sa visual studios niyo

Eto yung tutorial vid >>  https://www.youtube.com/watch?v=V7WpadAi3RI

## Repository layout

| Path | What it is |
|---|---|
| `apps/mobile/` | Expo + React Native + TypeScript app (Android and web from one codebase) |
| `packages/shared/` | Shared domain types and pure, tested utilities (pH/unit formatting, robot-state labels, cell progress, staleness) |
| `docs/` | [Architecture](docs/architecture.md), [open items](docs/OPEN_ITEMS.md), [decisions](docs/decisions.md) |
| `CLAUDE.md` | Software master prompt / requirements |
| `Website/` | Earlier placeholder web page (kept as-is; superseded by the Expo web build) |
| `PCB Schematic/` | KiCad PCB project |

## Requirements

- Node.js 20 or newer (an LTS release is recommended; developed on Node 26.11.1)
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
npm test          # Vitest (packages/shared) + Jest (apps/mobile)
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
