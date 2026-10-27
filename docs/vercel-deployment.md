# Vercel deployment (online build) — settings and checklist

Status, 2026-10-27: **PASS — REPOSITORY-ONLY.** Nothing has been deployed.
The hosted Vercel project's dashboard settings, Node version and environment
variables have **not** been inspected: there is no Vercel CLI or project link
on the development machine.

## What the online build is today
- **Notice only:** the online build shows "Online access is not available
  yet" and makes no requests (D48).
- **No online data path yet:** the cloud read client exists but is not wired
  in (D49). It waits for the online claim flow (OPEN_ITEMS #14) and the hosted
  schema (D42).
- **Not a live service:** a deployment today must not be described as live
  telemetry or robot access.

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
   - none are required today
   - **never** add a service-role or `sb_secret_` key
   - later, only `EXPO_PUBLIC_SUPABASE_URL` and a **publishable/anon**
     `EXPO_PUBLIC_SUPABASE_ANON_KEY`
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
