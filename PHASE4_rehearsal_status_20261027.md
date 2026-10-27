# RoboLime Phase 4 — rehearsal status, 2026-10-27

> **Superseded** by `PHASE4_final_report_20261027.md`: a limited
> database-level rehearsal later passed on an isolated database-only
> container (Option 2). The CLI-stack blocker below still applies.

**Verdict: LOCAL REHEARSAL BLOCKED — HOSTED APPLY NO-GO.**
Nothing was applied to the hosted project (`bkocxkavdosghmqjckty`). The
existing `supabase-restore-lab` stack, the `robolime-restore-test` container,
their volumes and networks, and the earlier handoff (`PHASE4_handoff.md`)
were not touched.

## Blocker
The isolated rehearsal stack was **not started**. Supabase CLI 2.122.0 (the
cached `npx` copy, run offline with outbound HTTP blocked) has no option to
bind published ports to 127.0.0.1: `start --help` lists only `--exclude`,
`--ignore-health-check` and global flags, `config.toml` has no bind/host
setting for ports, and the existing lab started by the same CLI publishes on
`0.0.0.0`/`[::]`. The rehearsal brief requires stopping before start-up in
that case. A project-owner decision is needed (see "Decision needed").

## Evidence collected
| Item | Status | Evidence |
|---|---|---|
| Backup integrity | PASS | `C:\Users\doman\RoboLime-backups\robolime-hosted-bkocxkavdosghmqjckty-20261027T093233Z-a69e04.dump`, 439,296 bytes, SHA-256 `2F9BF9347ADEACCA7ED1997F5CD5BA695AFB7BE48A323BF9705C82211BBC0D34`; provenance record `STATUS: VALIDATED` (table-of-contents coverage only), source `bkocxkavdosghmqjckty` via `aws-0-ap-northeast-2.pooler.supabase.com`, server 17.11, pg_dump 17.5, 744 entries |
| Backup restored | NOT DONE | Blocked with the rehearsal stack |
| Restore prerequisites (from the archive, offline) | Identified | Legacy objects need `auth.users` (FK from `public.robot_claims`), `auth.uid()`, publication `supabase_realtime` (members `public.readings`, `public.robot_status`), extensions `pgcrypto`, `uuid-ossp`, `supabase_vault`, `pg_stat_statements`, and roles `postgres`, `supabase_admin`, `supabase_realtime_admin`, `pg_database_owner` as owners. A plain PostgreSQL target is not equivalent |
| Supabase CLI | PASS | 2.122.0 (`--version`, offline) |
| Required images cached | PASS | `supabase/postgres:17.11.0.006`, `gotrue:v2.197.0`, `storage-api:v1.84.19`, `realtime:v2.147.1`, `postgrest:v16.5`, `kong:2.8.1`, `postgres-meta:v0.100.0`, `studio:2026.10.19-sha-b375769`, `edge-runtime:v1.77.8`, `mailpit:v1.31.3`, `vector:0.58.0-alpine`, `logflare:1.50.15` |
| Localhost-only binding with the CLI | FAIL (not supported) | See "Blocker" |
| Candidate ports 55320–55329, 55083, 55433 | PASS (free when checked) | No listener, not published by Docker, outside Windows excluded ranges |
| Docker capacity | NOT VERIFIED | 8.1 GB total memory, 12 CPUs; the 12-container lab is running and its `vector` container is restart-looping |
| Fresh-database migration chain | PASS | `npm run db:cloud:test` (throwaway cluster on 127.0.0.1:54329, deleted afterwards): cleanup ran with every drop skipped (NOTICEs only), target installed, synthetic seed loaded, `RLS AND MIGRATION TESTS PASSED` |
| Cleanup and target on the legacy schema | NOT TESTED | Needs the restored backup |
| Typecheck | PASS | `npm run typecheck`, exit 0 |
| Lint | PASS | `npm run lint`, 0 errors, 1 pre-existing warning (`array-type`) |
| Tests | PASS | `npm test`: 522 passed / 15 skipped (gateway), 92 passed (mobile), 127 passed (shared) |
| External references (offline) | PASS for the repository; NOT VERIFIED elsewhere | No application code references the legacy objects; no `supabase/functions`, Vercel or CI configuration in the repository. Hosted cron jobs, Edge Functions, webhooks and the deployed Vercel app were not inspected (network) |
| Documentation | Reconciled | D42 in `docs/decisions.md` and the D42 section of `docs/cloud-mirror.md` now reflect the 9-routine inventory, the backup and the fresh-database run |

## Not run, and why
- `supabase init` / `supabase start` for `robolime-phase4-rehearsal`: blocked (localhost binding).
- Backup restore, legacy-schema migration rehearsal, post-migration catalog and role tests: depend on the stack.
- Anything against the hosted project: not authorized.

## Decision needed
Choose one rehearsal target (both isolated from the lab, the test container and the hosted project; images are already cached, so no network is needed):
1. **CLI stack published on all interfaces**, as the existing lab already is, with unneeded services excluded (`--exclude studio,mailpit,logflare,vector,edge-runtime,imgproxy,supavisor,postgres-meta`) and ports 55320–55329.
2. **Database-only container** from the cached `supabase/postgres:17.11.0.006` image, published on `127.0.0.1:55322` only, in its own volume and network. Its built-in Supabase roles, schemas and functions must first be verified to cover the restore prerequisites above; without the auth, storage and realtime services, the restore would be limited to what that image provides.
