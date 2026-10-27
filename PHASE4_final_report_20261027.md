# RoboLime Phase 4 — limited database rehearsal report, 2026-10-27

**Verdict: LIMITED DATABASE REHEARSAL PASSED — HOSTED APPLY STILL NO-GO.**
This is a database-level rehearsal on an isolated local container. It is not a
full Supabase integration test and does not authorize applying anything to the
hosted project `bkocxkavdosghmqjckty`, which was not touched.

## Identity
| Item | Value |
|---|---|
| Backup | `C:\Users\doman\RoboLime-backups\robolime-hosted-bkocxkavdosghmqjckty-20261027T093233Z-a69e04.dump`, 439,296 bytes, SHA-256 `2F9BF9347ADEACCA7ED1997F5CD5BA695AFB7BE48A323BF9705C82211BBC0D34` (unchanged before and after); provenance `STATUS: VALIDATED`, source `bkocxkavdosghmqjckty`, server 17.11 |
| Image | `public.ecr.aws/supabase/postgres:17.11.0.006`, `sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`, cached, `--pull never` |
| Database | PostgreSQL 17.11; extensions `pgcrypto` 1.3, `uuid-ossp` 1.1, `pg_stat_statements` 1.11 (schema `extensions`), `supabase_vault` 0.3.1 |
| Rehearsal resources (new, kept for review) | container `robolime-phase4-rehearsal-db` (restart policy `no`), volume `robolime-phase4-rehearsal-data`, network `robolime-phase4-rehearsal-net`, port `127.0.0.1:55322` only |
| Untouched | `supabase-restore-lab` and its volumes/network, `robolime-restore-test` and its volume, host port 5432, the hosted project |
| Migrations | cleanup `0F7E642483C9203E…`, target `21AAA3D2969C7095…` (unchanged) |

## Restore
- Method: `pg_restore -L <list> --single-transaction --exit-on-error` as
  `supabase_admin`, original owners and grants kept. The list is the backup's
  own `SCHEMA - private` entry plus its 182 `public`/`private` entries.
- Not restored (provided by the image instead): `auth`, `storage`, `realtime`,
  `vault`, `extensions`, `graphql*`, `pgbouncer`, event triggers, the
  publication definition (its two legacy members were restored).
- First attempt (`-n public -n private`) failed on `schema "private" does not
  exist` because `-n` omits the schema's own entry; the single transaction
  rolled back fully (verified). Retry with the list: exit 0, no errors.
- Restored state matched the hosted inventory: 17 tables (all 0 rows), 3 views,
  3 sequences, 9 routines (6 `SECURITY DEFINER`), trigger
  `recommendations_dosing_runs_only`, 17 policies, RLS on 17/17, 21 foreign keys
  (including `robot_claims` → `auth.users`), `supabase_realtime` members
  `readings`, `robot_status`; the only catalog dependant of
  `reject_verification_recommendation()` is that trigger, and
  `hash_pairing_code`/`paired_readings` have none. Guard inputs all 0.
- No compatibility objects were created: `supabase_realtime_admin` (absent)
  owns only `realtime` types, and `auth.jwt()` (absent) is not used.

## Migration execution
- Rollback rehearsal: both files inside `BEGIN … ROLLBACK`; inside, 14 public
  tables, no legacy views, `runs.run_type` present; catalog fingerprint
  identical before and after (`8b8b583f…`, 302 items).
- Baseline snapshot before the committed run (scratchpad):
  `phase4-rehearsal-baseline-public-private.dump`, 80,041 bytes.
- Committed run: `psql -v ON_ERROR_STOP=1 --single-transaction -f cleanup -f
  target`, exit 0, 0 errors, 0 warnings, 3 notices (the two public sequences
  were already removed with their tables; `private` already existed).
- A template copy of the database was not possible (the image's `pg_net` and
  `pg_cron` workers stay connected), so the committed run used the restored
  database itself after the rollback rehearsal and the snapshot.

## Post-migration results
| Check | Result |
|---|---|
| 14 target tables; no tables in `private`; no views or sequences left | PASS |
| All 17 legacy tables, 3 views, 3 sequences and 9 routines absent | PASS |
| 5 target functions, `search_path=""`; only the two claim helpers `SECURITY DEFINER` | PASS |
| 10 triggers (incl. `recommendations_dosing_only` → `recommendation_must_be_dosing()`); 8 indexes | PASS |
| `runs.run_type text NOT NULL CHECK (dosing, verification)`; `is_verification` gone | PASS |
| 14 policies, all `SELECT` to `authenticated`, no `WITH CHECK`; RLS 14/14 | PASS |
| `anon` no table privileges; `authenticated` SELECT only; `service_role` SELECT/INSERT/UPDATE/DELETE | PASS |
| Claim helpers executable by `authenticated` only (not PUBLIC/anon); other functions by none of these | PASS |
| `supabase_realtime` has no members afterwards | Observed (target adds none) |
| Cleanup re-run on the migrated database refuses (`legacy cleanup refused`) | PASS |
| Repository RLS test (`rls_robot_scope.test.sql`, role switching + `request.jwt.claim.sub`) | PASS (`RLS AND MIGRATION TESTS PASSED`) |
| Catalog fingerprint unchanged by the guard re-run and RLS test (`9d2e99e6…`, 299 items) | PASS |

Deviation: the synthetic seed (`supabase/seeds/demo_synthetic.sql`, marked
synthetic) ends with its own `commit`, so its rows were committed in the
rehearsal database (1 robot, 2 runs, 39 readings, ...). Schema unaffected.

## Not tested here
Supabase Auth (GoTrue) sign-in and JWTs, Realtime, Storage, the Data API
(PostgREST/Kong) end to end, how the Supabase CLI or hosted migration history
records versions, the hosted project's own settings, hosted cron jobs, Edge
Functions, webhooks and the deployed Vercel app.

## Hosted apply remains NO-GO until
1. The apply mechanism is chosen and verified: both files in one transaction,
   and how history is recorded on a project without `supabase_migrations`.
2. A project-owner decision authorizes the hosted run, with the backup above as
   the rollback point.
3. Post-apply verification on the hosted project (catalog checks, RLS through
   the real API, one synthetic sync).

## Artifacts (scratchpad, not in the repository)
`phase4-rehearsal.pgpass` (throwaway local credential; not printed),
`phase4-restore.log`, `phase4-restore-2.log`, `phase4-restore.list`,
`phase4-fingerprint.sql`, `phase4-rollback-run.log`, `phase4-rollback-run-2.log`,
`phase4-committed-run.log`, `phase4-guard-rerun.log`, `phase4-rls-test.log`,
`phase4-rehearsal-baseline-public-private.dump`.

To stop only the rehearsal database: `docker stop robolime-phase4-rehearsal-db`.

## Addendum: corrected hosted apply kit (2026-10-27)
Location: `C:\Users\doman\RoboLime-backups\phase4-apply-20261027\` (all hashes in
its `CHECKSUMS.txt`; wrapper `robolime-hosted-apply.ps1`, SHA-256
`8B2AE7B9071A3B668971C344ED08EC8D9C6E077C56A3107101C826D863C6DCA4`). It
supersedes the earlier scratchpad apply files, which must not be used.

- Pre-check: exact structural manifest of `public`/`private` (owners, grants,
  RLS, columns, constraints, indexes, routine definitions, triggers, policies,
  views, sequences, publication membership, types, extensions) must equal the
  restored legacy manifest `d3943ba3ce98760d13bfed81a6457c63` (338 items), and
  all 17 legacy tables must be empty.
- Post-check: exact target manifest `3bdf928655385e6d123d2b6d3a73430a` (333
  items) plus explicit RLS, table-grant, routine-EXECUTE, `private`-schema and
  policy assertions.
- Outcome: read-only `classify.sql` on new connections before (must be LEGACY)
  and after every attempt (TARGET = applied, LEGACY = not applied, OTHER or no
  answer = stop and investigate; never re-run automatically). A PENDING record
  is written before connecting.
- Role fidelity: a second disposable container (`robolime-phase4-rehearsal2-db`,
  `127.0.0.1:55332`) restored the legacy schema and ran the whole kit as the
  local `postgres` role (non-superuser, BYPASSRLS, `supautils` loaded): the
  pre-check passed on the genuine legacy schema, a non-COMMIT answer rolled back
  (still LEGACY), COMMIT produced TARGET, and a second run refused at the
  pre-check. Hosted `supautils` configuration and hosted role settings remain
  unverified.
- Migration history is not written; see `migration-history-plan.md`.

## Final release review of the apply kit (2026-10-27)
**Verdict: READY FOR SEPARATELY APPROVED HOSTED APPLY.** This is a review
result, not evidence that the apply is safe on the hosted project.
- All 14 `CHECKSUMS.txt` entries exist and match on disk, including the
  wrapper, every helper, both migrations, the backup and its provenance record.
  The wrapper pins the same 12 hashes and has no placeholders left.
- Re-running the current `classify.sql`/`manifest.sql` (read-only) on the
  rehearsal databases reproduced the reported states: rehearsal2 `TARGET`, with
  live items identical to `target-manifest.txt`; rehearsal 1 `OTHER`.
- The transaction flow, outcome handling and credential handling match this
  report.
- Not exercised: the wrapper's main section (it accepts only Supabase hosts),
  the empty-table refusal, and a record-write failure after a commit.
  `PGSSLMODE=require` does not verify the server certificate (`verify-full`
  would).
- **No hosted change has been made.** Operator checklist:
  `PHASE4-5_handoff_20261027.md`.
