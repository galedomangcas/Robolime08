# Hosted Supabase migration runbook (D42) — review and history plan

Status, 2026-10-27:
- **Work Order 1 (apply kit): PASS — REPOSITORY-ONLY. Ready for explicit
  human approval.**
- **Work Order 2 (migration history): corrected plan PASS — REPOSITORY-ONLY;
  live state BLOCKED — CREDENTIALS OR HOSTED ACCESS REQUIRED.**
- Nothing in this document has been run against the hosted project.

## 1. Files reviewed
Kit folder: `C:\Users\doman\RoboLime-backups\phase4-apply-20261027\`. It is
outside the repository; all 14 entries in its `CHECKSUMS.txt` were
re-verified on 2026-10-27.

| File | Role | SHA-256 (prefix) |
|---|---|---|
| `robolime-hosted-apply.ps1` | Wrapper you run | `8B2AE7B9…` |
| `apply.sql` | One-transaction driver | `DB1D2A7C…` |
| `precheck.sql` / `postcheck.sql` | Exact legacy / target manifests plus security assertions | `A2BCDF17…` / `DE3EBEB4…` |
| `classify.sql`, `manifest.sql`, `manifest-list.sql` | Read-only LEGACY/TARGET/OTHER | `C7A430C9…`, `AEB37425…`, `D7B391AF…` |
| `legacy-manifest.txt` / `target-manifest.txt` | Expected items (338 / 333) | `BC3ECA42…` / `1AE031BF…` |
| `migration-history-plan.md` | Original history plan (superseded by §4 below) | `3650041A…` |
| `supabase/migrations/20261022000000_remove_legacy_hosted_schema.sql` | Cleanup (**untracked in Git**) | `0F7E6424…` |
| `supabase/migrations/20261023000000_cloud_mirror_initial.sql` | Target (committed) | `21AAA3D2…` |
| Backup `.dump` and `.provenance.txt` | Rollback point | `2F9BF934…`, `09EC7008…` |

## 2. Safety review (Work Order 1)
1. **Target:** project `bkocxkavdosghmqjckty`, database `postgres`, port 5432
   (session mode).
2. **Wrong-target prevention:**
   - You paste the connection template from the dashboard and must re-type
     the host.
   - The host must be `db.bkocxkavdosghmqjckty.supabase.co` with user
     `postgres`, or `*.pooler.supabase.com` with user
     `postgres.bkocxkavdosghmqjckty` (the pooler routes by that user).
   - A read-only classification must return LEGACY, meaning the exact
     338-item legacy manifest, before anything runs.
   - **Limit:** a different project with an identical legacy schema would also
     pass the manifest check; the host/user binding is what ties it to this
     project.
3. **What changes:**
   - **Removed** (cleanup migration):
     - 3 views: `cell_readings_latest`, `run_delivery`, `run_summaries`
     - 17 tables: 15 in `public`, 2 in `private`
     - 2 sequences
     - 9 functions, named by exact signature
     - one trigger, removed with `recommendations`
     - legacy table membership of the `supabase_realtime` publication, which
       goes when the tables are dropped
   - **Created** (target migration):
     - schema `private` (`if not exists`)
     - 14 tables, 7 indexes plus 1 unique index
     - 5 functions; 2 are `SECURITY DEFINER`, all have `search_path=''`
     - 10 triggers and 14 SELECT-only policies
     - RLS enabled on all 14 tables
   - **Grants:** all revoked from `anon` and `authenticated`; `authenticated`
     gets SELECT; `service_role` gets SELECT/INSERT/UPDATE/DELETE; USAGE on
     `private` and EXECUTE on the 2 claim helpers go to `authenticated`.
   - **Outside public/private:** one foreign key to `auth.users ON DELETE
     CASCADE`.
   - **Not touched:** no extension, publication, `auth` setting or
     migration-history object.
4. **Transaction:**
   - Everything runs in one transaction (`BEGIN`; precheck; cleanup; target;
     postcheck; `COMMIT` only if you type it), with `ON_ERROR_STOP`.
   - Any error ends psql and the server rolls back. All of it is rollback-safe
     DDL.
   - After COMMIT there is no automatic undo (see 10).
5. **Preconditions:**
   - The database classifies as LEGACY and all 17 legacy tables are empty
     (so no rows can be lost).
   - The account is the dashboard `postgres` user.
   - The verified backup and its provenance record are present.
6. **Idempotence and interruption:**
   - A second run is refused: classification is TARGET, not LEGACY, and the
     cleanup guard also refuses.
   - If the connection drops during COMMIT, a read-only classification on a
     new connection decides the outcome:
     - TARGET means applied
     - LEGACY means not applied
     - OTHER or no answer means stop and investigate
   - It is never retried automatically, and it was rehearsed for all three
     outcomes.
7. **Checks:** classify (before); precheck (exact legacy manifest, empty
   tables); postcheck (exact target manifest, plus RLS, grants, EXECUTE,
   `private` access and policies); classify (after, new connection).
8. **Postconditions prove state, not just execution:** the 333-item target
   manifest covers owners, ACLs, column definitions, constraints, indexes,
   function definitions, triggers, policies and RLS flags. It does **not**
   cover:
   - schema-level default privileges (schema `private` access is asserted
     separately)
   - comments or data
   - anything outside `public`/`private`
9. **Risks:**
   - **Data loss:** none possible, because empty tables are required.
   - **Lock contention:** `DROP TABLE` takes exclusive locks; busy API or
     Realtime sessions trigger the 15 s `lock_timeout`, which rolls back.
     Stop the gateway's sync first.
   - **Partial application:** impossible (one transaction).
   - **Privilege escalation:** the two definer functions only read
     `robot_claims` for `auth.uid()` with a pinned `search_path`.
   - **Exposure:** `anon` gets nothing.
   - **Hosted differences from the rehearsal** (`supautils`, default
     privileges, role settings) make the pre- or post-check fail and roll
     back: safe, but the apply would not complete.
10. **Recovery after COMMIT:** there is no in-place undo. The rollback point is
    the backup, whose `public`/`private` restore was rehearsed only into local
    containers, never the hosted project. Restoring would mean manually
    dropping the target objects and `pg_restore`-ing that list, which is a
    separate, approval-gated hosted operation.
11. **History order:** history repair must come **after** a confirmed TARGET
    classification, never before (§4).
12. **Unverified assumptions:**
    - hosted `supautils` and default privileges
    - Supabase's GitHub integration (if enabled, pushing migrations to
      `main` could run them automatically; check before any push)
    - interactive COMMIT entry in a Windows console (rehearsed with piped
      input; any other input or an error means rollback)
    - `PGSSLMODE=require` encrypts but does not verify the server
      certificate; `verify-full` needs Supabase's CA file
    - integrations that read the old objects (cron jobs, Edge Functions,
      webhooks); none are recorded

**Go/no-go: GO for an explicit human approval decision.** No defect requires
a change. Before approving:
- stop anything writing to the hosted database
- confirm that no Supabase GitHub integration will run migrations on push
- accept the TLS-verification and rollback limits above

## 3. Required repository precondition (found 2026-10-27)
`supabase/migrations/20261022000000_remove_legacy_hosted_schema.sql` is
**untracked**: it is in neither `HEAD` nor GitHub `main`, which also diverge
(local 20 ahead, 7 behind). The kit pins it by hash, so if the file were
deleted the kit would refuse to run (fail closed). The history repair below
needs both files committed, so the repository and the hosted history agree.
**Committing it is a user decision** (Git operations are not authorised
here).

## 4. Corrected migration-history plan (Work Order 2)
The kit's `migration-history-plan.md` is correct in direction. It is
corrected and extended here:
- **Bookkeeping only:** history repair records which versions ran; it changes
  no schema.
- **Precondition:** the cleanup migration must be committed (§3).
- **Ordering:** apply, then a TARGET classification, before any repair.
- **Read-only checks:** before and after, as in step 5 below.

**Exact records.** Insert exactly two rows, and update or delete none:
`20261022000000` (remove_legacy_hosted_schema) and `20261023000000`
(cloud_mirror_initial). Both are reviewed repository migrations, and their
hashes are pinned in the kit.

**Drift concealment.** Recording these versions is truthful **only** when
`classify.sql` reports TARGET (the exact 333-item manifest). In any other
state, repair would hide drift: **do not repair.**

**Steps** (approval-gated; none run):
1. Approve and run the D42 kit. The outcome must be APPLIED, and a fresh
   `classify.sql` must report `STATE: TARGET`.
2. Commit the cleanup migration (user decision). Confirm that
   `supabase/migrations/` holds exactly these two files with the pinned
   hashes.
3. Read-only before-check:
   `psql … -f supabase/ops/migration-history-check.sql`. Expected today:
   `HISTORY: table absent`. If the table exists with unexpected versions,
   stop.
4. Approval-gated hosted write:
   1. `supabase link --project-ref bkocxkavdosghmqjckty`. This writes only the
      git-ignored `supabase/.temp/`, and asks for the database password.
   2. `supabase migration list`: both versions must show as local only.
   3. `supabase migration repair --status applied 20261022000000 20261023000000`.
      Expected (unverified CLI behaviour): it creates
      `supabase_migrations.schema_migrations` if absent and inserts the two
      versions.
5. Read-only after-check: the history checker must report
   `expected present=2/2; missing=-; unexpected=-`, and `classify.sql` must
   still report TARGET.
6. Record the CLI version, command output and UTC time beside the apply
   record. No credentials.

**Backup and recovery:**
- The history table holds bookkeeping only; a mistaken repair is reversed with
  `migration repair --status reverted <versions>`.
- Take a `pg_dump --schema=supabase_migrations` (if it exists) before step 4.

**Until step 5 passes, do not run `supabase db push`.** It would try
`20261022000000`, whose guard refuses on the target schema.

## 5. Read-only checks that need hosted access (BLOCKED here)
- `classify.sql`: the current hosted state is expected to be LEGACY.
- `migration-history-check.sql`: history table expected absent.

Both need the `postgres` credentials, which are not configured on this
machine; they were not requested.

## 6. OTHER classification: diagnosis and corrected rehearsal (2026-10-28)
Status: **diagnosed; the kit's guard worked; hosted apply still BLOCKED** (needs
the default-privilege check, a reviewed kit correction, and your approval).

- **What happened:** the first hosted run (2026-10-27T17:06Z) stopped at
  pre-apply classification `OTHER` (`6e0f3cc…`, 338 items). Nothing changed.
- **Read-only capture:**
  `hosted-manifest-bkocxkavdosghmqjckty-20261027T172735Z.txt` (SHA-256
  `03DB492B…E939B1`) reproduces `6e0f3cc…` with the manifest algorithm.
- **Difference from the old reference:** 22 items differ from
  `legacy-manifest.txt`, all in grants (18 relations, 4 functions); the
  structure is identical. The hosted grants are narrower: no `anon`, and
  `authenticated` SELECT (or SELECT,INSERT).
- **Cause, proven:**
  - the backup's own GRANT statements equal the hosted grants
  - the rehearsal image has `supabase_admin` default privileges in `public`
    granting everything to `anon`/`authenticated`/`service_role`, which the
    old restore (run as `supabase_admin`) inherited
  - so `legacy-manifest.txt` (`d3943ba3…`) was a rehearsal artifact; the
    hosted project has not drifted since the backup
- **Corrected rehearsal** (new container `robolime-phase4-rehearsal3-db`,
  127.0.0.1:55342; evidence in
  `C:\Users\doman\RoboLime-backups\diag-rehearsal3-20261028\`):
  - with those defaults suspended during the restore, the restored legacy
    listing is **byte-identical** to the hosted capture (same SHA-256,
    `6e0f3cc…`)
  - the **unchanged** kit precheck refuses it (guard intact)
  - cleanup + target + the **unchanged** kit postcheck pass: target
    `3bdf928…` plus all RLS/grant/EXECUTE/schema/policy assertions, both
    rolled back and committed
  - classification is TARGET after the commit; a second cleanup is refused
  - the repository RLS test (with its synthetic seed) passes
- **Remaining unknown:** the hosted **default privileges** of `postgres` in
  `public`/`private`, which decide the grants of the new tables. The
  rehearsal used the image's defaults. Read-only capture script:
  `C:\Users\doman\RoboLime-backups\capture-hosted-default-privileges-readonly.ps1`
  (SHA-256 `054FE4B4…7DAE97`); you run it.
- **Proposed kit correction** (not made; needs review and approval). Build a
  **new** kit folder; never edit `phase4-apply-20261027`:
  1. legacy reference = the corrected-restore listing (`03DB492B…`) and
     fingerprint `6e0f3ccffd45b7100c432dc4900dfc12` (338 items) in
     `precheck.sql` and `classify.sql`;
  2. add a precheck assertion that the hosted `postgres` default privileges
     in `public` equal the rehearsed ones, so the target grants are predicted
     rather than assumed;
  3. keep everything else (cleanup, target, postcheck `3bdf928…`), re-pin all
     hashes, re-rehearse end to end, and re-review before any hosted run.
- **Recovery point:**
  - the backup's `public`/`private` restore is now proven to reproduce the
    hosted structure **and grants** exactly (empty tables)
  - a restore onto the hosted project and a whole-database restore remain
    untested
