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
