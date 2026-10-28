# Vercel deployment (online build) — settings and checklist

Status, 2026-10-27: **PASS — REPOSITORY-ONLY.** Nothing has been deployed.
The hosted Vercel project's dashboard settings, Node version and environment
variables have **not** been inspected: there is no Vercel CLI or project link
on the development machine.

## What the online build is today
- **Online flow (D52):** anonymous Supabase sign-in, then the cloud claim
  code (verified server-side by `claim_robot()`), then the same status and
  results screens as the field build, fed by the hosted mirror under RLS.
  Observe-only; exports stay on the field laptop.
- **Without valid public settings** the build shows "Online access is not
  configured" and makes no requests. On Vercel the build guard fails instead.
- **Data:** only what a field gateway has synced. A demo database can never
  sync to a hosted project, so a fresh project shows "no data" until a field
  robot syncs.

## Repository settings (`vercel.json`)
| Setting | Value |
|---|---|
| Framework | none (`"framework": null`) |
| Root directory | repository root (npm workspaces) |
| Install | `npm ci` (lockfileVersion 3) |
| Build | `EXPO_PUBLIC_ROBOLIME_TARGET=online npm run build:web` |
| Output | `apps/mobile/dist` |
| Rewrites | none needed: state-based navigation, one `index.html` (D5) |
| Headers | see below |

**Headers:**
- **CSP:** `script-src 'self'`; `style-src 'self' 'unsafe-inline'` (Expo
  injects one inline `<style>`; a static header cannot follow its hash the way
  the gateway does); `connect-src 'self'`; `frame-ancestors 'none'`.
- **Others:** `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, a restrictive
  `Permissions-Policy`, and long immutable caching for content-hashed
  `/_expo/static/*`.
- **When the cloud reader is wired in,** `connect-src` must add the project
  URL.

**Build guard** (`apps/mobile/scripts/check-build-target.mjs`, run by
`build:web`):
- On Vercel (`VERCEL=1`), the build fails unless the target is `online`.
- Any target other than `field` or `online` fails.
- Any `EXPO_PUBLIC_*` variable that looks like a secret or service-role key
  fails.
- It prints names, never values.

## Dashboard settings to confirm (needs approval; not done)
1. The project's **Node.js version: 22.x or 24.x.** The root `engines` range is
   `^22.16.0 || ^24.3.0 || >=26.0.0`. Local builds used Node 26.11.1; the build
   has **not** been run on 22 or 24.
2. **No dashboard Build or Output overrides** that differ from `vercel.json`.
3. **Environment variables:**
   - required (Production and Preview): `EXPO_PUBLIC_SUPABASE_URL`
     (`https://pbwucdgmzvvxledtiocm.supabase.co`, D53) and a **publishable/anon**
     `EXPO_PUBLIC_SUPABASE_ANON_KEY`. The build guard fails on Vercel if
     either is missing.
   - **never** add a service-role or `sb_secret_` key. The guard refuses
     `EXPO_PUBLIC_*` names containing SERVICE_ROLE/SECRET, `sb_secret_` values,
     and JWTs whose role is not `anon`.
   - CSP `connect-src` allows only `'self'` and the project origin
     (`vercel.json`).
4. **Git integration:** which branch deploys to production.
   - Local `main` and GitHub `main` have diverged.
   - Pushing will deploy whatever `main` holds.
   - Also check whether a **Supabase** GitHub integration would run migrations
     on push (`docs/hosted-migration-runbook.md` §2.12).

## Pre-deployment checklist
- [ ] Dashboard settings above confirmed; branch divergence resolved.
- [ ] `npm ci && npm run typecheck && npm run lint && npm test` pass.
- [ ] `EXPO_PUBLIC_ROBOLIME_TARGET=online npm run build:web` passes. Scan
      `apps/mobile/dist`: no secrets, no source maps, no external sources, no
      demo code.
- [ ] `npm audit`: only the known Expo/`zod` tooling advisories remain (not in
      the bundle).
- [ ] **Explicit approval to deploy.**
- [ ] After deploying, in a browser:
  - [ ] the notice renders and is styled
  - [ ] no CSP violations in the console
  - [ ] no request leaves the Vercel origin
  - [ ] the headers are present (`curl -I`)
