# RoboLime — Phase 4 Final Handoff

**Handoff date:** October 26, 2026  
**Phase status:** **INCOMPLETE — restoration rehearsal blocked**  
**Repository:** `C:\Users\doman\Documents\GitHub\Robolime`  
**Branch:** `main`  
**Latest recorded commit:** `3009774` — `test(protocol): expand timestamp validation regression coverage`

## 1. Executive Summary

Phase 4 established evidence for the hosted Supabase backup, candidate application-only SQL, local restore-lab environment, selected automated tests, web build, targeted bundle scan, and a limited offline smoke test.

However, the isolated restoration rehearsal has **not succeeded**. The candidate SQL has not been executed, and the rehearsal database lacks required Supabase-managed objects, including `auth.uid()` and `auth.users`.

The existing local Supabase lab and its persistent database volume must remain intact. The team chose **Option 1: preserve the lab and document the blocker**, rather than modifying the lab to enable experimental named stacks.

**Final verdict: Phase 4 is not complete.** The restoration acceptance criteria remain outstanding.

## 2. Verified Evidence

### 2.1 Hosted backup archive

File:

`C:\Users\doman\RoboLime-backups\robolime-hosted-pre-migration.dump`

| Property | Verified value |
|---|---|
| Size | 439,296 bytes |
| SHA-256 | `83E2EF73EC7264B0266E756535C36A209E434B36F756E967B74D831F683E9323` |
| Format | PostgreSQL custom archive |
| TOC inspection | `pg_restore --list` succeeded |
| Recorded source versions | PostgreSQL 17.11; `pg_dump` 17.5 |

**Interpretation:** The archive is readable and its table of contents was inspected. This does not prove that it can be restored successfully.

### 2.2 Candidate application-only SQL

File:

`C:\Users\doman\RoboLime-backups\robolime-app-only-candidate.dump`

| Property | Verified value |
|---|---|
| Size | 45,839 bytes |
| SHA-256 | `8F980F1DD1660FE740E4099804BDF0AD13CF5DEB63D711BA4C1301486D109D31` |
| Actual format | Plain-text SQL |
| App-table COPY sections | 17, all containing zero rows |
| Views | 3 identified |
| Functions | 9 identified |
| Restore/execution | Not performed |

The file extension `.dump` does not indicate its actual format. The candidate is plain SQL; failure of `pg_restore --list` on this file is therefore expected.

The SQL inspection identified dependencies and objects requiring careful validation, including:

- `auth.uid()` and `auth.users`
- Supabase Realtime
- Private pairing helpers and public ingestion/claim functions
- A recommendation-related trigger
- View definitions and replacements

**Safety conclusion:** Empty application-table data does not establish that the SQL is safe or self-contained. The candidate has not been executed and must remain unexecuted until a compatible, isolated target and an approved restoration plan exist.

### 2.3 Local Supabase restore lab

Location:

`C:\Users\doman\RoboLime-backups\supabase-restore-lab`

Recorded environment:

- Supabase CLI 2.122.0 can be invoked using `npm exec`.
- The project is unlinked.
- The local PostgreSQL container was reported running and healthy.
- PostgreSQL image: `public.ecr.aws/supabase/postgres:17.11.0.006`.
- Database port: `54322`.
- API port: `54321`.
- Studio port: `54323`.
- Mailpit port: `54324`.
- The lab configuration disables migration and seed execution and sets `schema_paths = []`.
- A separate database named `robolime_restore_rehearsal` exists within the local PostgreSQL instance.

The catalog inspection found:

| Database | Observed state |
|---|---|
| Default local `postgres` database | Managed `auth`, `realtime`, and `storage` relations exist; `auth.uid()` and `auth.users` exist |
| `robolime_restore_rehearsal` | Required managed schemas/objects are absent; the inspected `public` schema had two relations |

The default `postgres` database is **not an approved substitute** for the rehearsal database. Copying managed schemas into the rehearsal database is not an approved workaround.

The empty schema-name result from the catalog query was caused by a left join when expected schemas were absent; it was not evidence of a literal empty-named schema.

### 2.4 Named-stack investigation

The following were inspected without intentionally changing the lab:

- Supabase CLI version and command help
- `supabase start --help`
- `supabase db --help`
- `supabase stack --help --experimental`
- The current `supabase/config.toml` experimental section and port settings

The current configuration contains fixed port assignments and an `[experimental]` section, but the inspected output did not establish that named-stack mode is enabled.

The `stack` command was not recognized in the observed invocation. Named-stack support and its configuration requirements were investigated, but no safe procedure was established and validated for this existing lab.

**Decision:** Do not enable experimental named stacks in the current lab as part of this handoff. Preserve the existing configuration, containers, database, and persistent volume.

### 2.5 Automated tests

Previously reported targeted results:

| Test group | Suites | Passed |
|---|---:|---:|
| Gateway storage, bridge session, runtime, local API | 4 | 91 |
| Mobile gateway client and response validation | 2 | 55 |
| Gateway HTTP, static files, and serving | 3 | 105 |
| Simulation and simulated robot | 2 | 18 |
| **Total** | **11** | **269** |

Two tests were skipped.

These are targeted results, not a full repository test run. Do not describe them as a complete test-suite pass.

### 2.6 Web build and targeted secret scan

Previously reported:

- `npm run build:web --workspace @robolime/mobile` passed.
- Output bundle: `apps\mobile\dist\_expo\static\js\web\index-32bc77c97e8e78c982a49c4cb645d2df.js`
- Bundle size: 459,560 bytes.
- `index.html` size: 1,203 bytes.

The targeted JavaScript bundle scan did not find the checked indicators for service-role credentials, `sb_secret_...` keys, PostgreSQL credential URLs, or PEM private-key markers.

**Limitation:** This was a targeted scan, not a comprehensive security audit or proof that all secrets and security risks are absent.

### 2.7 Limited offline smoke test

A temporary synthetic database was used:

`%TEMP%\robolime-phase4-offline-demo.sqlite`

Resolved path:

`C:\Users\doman\AppData\Local\Temp\robolime-phase4-offline-demo.sqlite`

Recorded size: 299,008 bytes.

The test used deterministic synthetic data only. It did not contain real field readings, actual GPS measurements, or real pairing credentials.

Observed behavior:

- `GET /` loaded the local pairing screen.
- `GET /api/v1` returned 404; no root route was established for that API prefix.
- Unauthenticated `GET /api/v1/robot/status` returned 401.
- A fake pairing request returned 503 `NO_PAIRING_PROVISIONED`.
- The test process was stopped cleanly.

**Limitations:** An authenticated dashboard flow was not tested, pairing was not established, and physical hardware integration was not tested.

## 3. Repository State — Preserve As-Is

Last recorded repository state:

```text
Branch: main
HEAD: 3009774 test(protocol): expand timestamp validation regression coverage

Modified tracked files:
 M CLAUDE.md
 M README.md
 M apps/gateway/package.json
 M docs/OPEN_ITEMS.md
 M docs/architecture.md
 M docs/decisions.md
 M docs/local-gateway.md
 M docs/protocol.md

Untracked file:
 ?? INPUT_LENGTH=0
```

The origin of `INPUT_LENGTH=0` is unknown. Leave it untouched.

**Do not** stage, revert, delete, clean, commit, or push these changes as part of this handoff. Preserve `Website/` and `PCB Schematic/` as well.

This is the last recorded repository state; it has not been rechecked as part of this handoff.

## 4. Explicitly Not Completed or Not Verified

- Successful restoration of the hosted backup.
- Successful restoration of the candidate application-only SQL.
- Post-restore validation of schema objects, functions, triggers, policies, and dependencies.
- Acceptance of a compatible isolated restoration target.
- Authenticated synthetic dashboard end-to-end flow.
- Physical robot-to-LoRa-to-USB-to-laptop integration.
- Comprehensive security audit.
- Full repository test-suite execution during this Phase 4 evidence collection.
- Final Phase 4 acceptance.

Do not represent these items as passed.

## 5. Safety and Change-Control Decisions

Until a compatible restoration target and plan are approved:

1. Do not execute the candidate SQL.
2. Do not run `supabase db reset`, `supabase db push`, or a restore against the current lab.
3. Do not stop, recreate, reset, or delete the current database container or persistent volume.
4. Do not copy managed Supabase schemas into the rehearsal database as a workaround.
5. Do not alter the current lab configuration to enable named stacks.
6. Do not modify or migrate the hosted Supabase project.
7. Do not deploy to Vercel or create replacement cloud projects.
8. Do not stage, revert, commit, or push the current repository changes without explicit authorization.
9. Do not repeat local development credentials previously exposed in terminal output. Assess rotation if those credentials are still in use; distinguish local credentials from hosted production secrets.

## 6. Remaining Acceptance Criteria

Phase 4 should remain open until the following are addressed:

- [ ] Establish and approve a compatible isolated restore target without jeopardizing the existing lab or its volume.
- [ ] Document the exact restoration procedure and recovery plan before executing any restore.
- [ ] Restore the intended artifact into the approved target.
- [ ] Validate expected schemas, tables, views, functions, triggers, policies, and required managed-service dependencies.
- [ ] Record restoration logs, outcomes, and any deviations.
- [ ] Complete any separately required acceptance checks, explicitly distinguishing untested hardware integration and security-audit scope.
- [ ] Obtain stakeholder acceptance for any remaining limitations before declaring Phase 4 complete.

## 7. Recommended Next Action

No additional command is required for the selected Option 1.

Preserve the existing lab and files, mark the restoration rehearsal as **BLOCKED — compatible isolated restore target not established**, and retain the evidence above. Resume restoration work only after a safe target and approved plan have been established.

**Final status: Phase 4 incomplete. Existing evidence retained; no successful restore claimed.**