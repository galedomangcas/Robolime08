# RoboLime — consolidated Phase 4–5 handoff, 2026-10-27

HEAD `3e37db49c632b3ba9a4b353c815ce79cec1f5df1` (`main`). All work below is
**uncommitted and unpushed**. Nothing was deployed. **No hosted Supabase or
Vercel resource was contacted or changed.**

## Verdicts
| Phase | Verdict | Basis |
|---|---|---|
| 4 | **COMPLETE LOCALLY — HOSTED APPLY PENDING** | Mandatory checklist rows 1–4 and 6–11 have local evidence (`docs/architecture.md`). The D42 apply kit passed its final review and a role-faithful local rehearsal. The checklist and its closing rule are still PROPOSED (D34/D39), so `docs/architecture.md` keeps "Phase 4 is not complete" until the owner confirms them |
| 5 | **PARTIALLY COMPLETE** | Local adapter, Results section, strip on every section and verification hiding are done and verified locally. Cloud adapter, claim flow, sticky strip, self-check/battery health, completed-run filter, recommendation engine and devices remain (`PHASE5_report_20261027.md`) |

## What is and isn't established
| Category | Items |
|---|---|
| Local implementation completed | Phase 4 gateway, SQLite, loopback API, sync worker, CSV exports; D42 cleanup migration and apply kit; Phase 5 local adapter and Results section (D43) |
| Local tests passed (2026-10-27) | Typecheck 0; lint 0 errors (1 old warning); gateway 522 passed/15 skipped; shared 127; mobile 112; `build:web`; bundle scan; `db:cloud:test`; 16/16 loopback API + headless-Edge checks |
| Isolated database rehearsals passed | Rehearsal 1 (`127.0.0.1:55322`): restore, rollback, commit, guard re-run, RLS. Rehearsal 2 (`127.0.0.1:55332`, as local `postgres`): exact pre/post manifests, rollback, commit → TARGET, refusal on re-run, mutation rejections |
| Hosted changes not performed | Cleanup + target migrations; migration-history repair; any Vercel configuration or deployment |
| External dependencies not verified | Hosted `supautils`/role settings; official Supabase stack (#17); online claim flow (#14); Vercel build and environment variables |
| Hardware tests not performed | Robot → receiver → USB serial → laptop path (row 12); WAN-disconnected field run (row 13); devices and outdoor readability (row 14). All NOT RUN — HARDWARE UNAVAILABLE |
| Outstanding decisions | Confirm the Phase 4 checklist (D34/D39); confirm the Phase 5 scope (D43); compact sticky strip design; per-run completion signal; D37/D38 protocol (#35–#39) |

## Hosted apply — operator checklist (run only after explicit approval)
1. In PowerShell, verify every SHA-256 in
   `C:\Users\doman\RoboLime-backups\phase4-apply-20261027\CHECKSUMS.txt`
   with `Get-FileHash -Algorithm SHA256`. Wrapper:
   `8B2AE7B9071A3B668971C344ED08EC8D9C6E077C56A3107101C826D863C6DCA4`.
2. Make sure nothing else is writing to the hosted database (gateway sync stopped).
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\doman\RoboLime-backups\phase4-apply-20261027\robolime-hosted-apply.ps1"`.
4. Prompts, in order:
   - the Dashboard > Connect *session pooler* template, with `[YOUR-PASSWORD]` left in place (hidden input)
   - the host, re-typed
   - the password (hidden input)
   - after the post-check, type `COMMIT`
5. **Stop without typing COMMIT** if any of these happens:
   - the pre-apply state is not LEGACY
   - a "MANIFEST MISMATCH" or "precheck:"/"postcheck:" error appears
   - a lock timeout occurs
   - the post-check did not print "matches the rehearsed target schema"
6. Read `OUTCOME:` and the exit code:

   | Exit | Meaning |
   |---|---|
   | 0 | APPLIED |
   | 1 | Not applied |
   | 2 | UNKNOWN or contradiction: stop, do not re-run, classify read-only |
   | 3 | The record wasn't written: save the console output |
7. Recovery: the rollback point is the backup
   `robolime-hosted-bkocxkavdosghmqjckty-20261027T093233Z-a69e04.dump`
   (`2F9BF934…0D34`). It has been restored only into local rehearsal databases.
8. Afterwards, with separate approval:
   - migration-history repair per `migration-history-plan.md`
   - do **not** run `supabase db push` before that

## Resources left running (not modified)
- `robolime-phase4-rehearsal-db`
- `robolime-phase4-rehearsal2-db`
- `supabase_db_supabase-restore-lab`
- `robolime-restore-test`

The test gateway (port 18791) and headless Edge were stopped.

## One next action per blocker
| Blocker | Next action |
|---|---|
| Hosted apply | Owner explicitly approves, then runs the checklist above |
| Migration history | After TARGET, approve and run `migration repair` per the plan |
| Cloud adapter / claim flow (#14) | Decide the online claim flow and approve a Supabase client dependency |
| Vercel | Approve configuring the existing project per `docs/architecture.md` "Vercel", then deploy |
| Phase 4 closure | Owner confirms the D34/D39 checklist designation |
| Phase 5 scope | Owner confirms D43 and decides on the sticky strip and the completion signal |
| Crop data (#5) | Research team supplies sourced candidates and ranges |
| Self-check bits / battery health (#9, #10) | Firmware/hardware owners specify them |
| Hardware path (row 12) | Signed-off packet layout and receiver firmware (#1, #19, #35–#37) |
