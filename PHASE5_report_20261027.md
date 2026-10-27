# RoboLime Phase 5 — checklist and completion report, 2026-10-27

**Verdict: PARTIALLY COMPLETE.** The local-field parts of Phase 5 are
implemented and verified locally with synthetic data. The cloud parts are
blocked, and several items need a project decision or hardware/devices.

## Scope source
There are no written Phase 5 acceptance criteria in the repository. The scope
is **derived** (D43, PROPOSED) from `CLAUDE.md` §12 build-order item 5:
"Pairing, common monitoring strip, dashboard, and results screens using
explicit local/cloud data adapters", read with §4 and the semester exclusions
in D29. `docs/architecture.md` already assigned "Local/cloud data-source
adapters in the app" to Phase 5. The project owner should confirm it.

## Checklist
| # | Deliverable | Acceptance criterion | Evidence | Status |
|---|---|---|---|---|
| 1 | Local pairing screen | First launch pairs against the loopback gateway with no internet; the code is never stored or shown | M5a tests (D33); headless Edge 2026-10-27 (pairing screen on first launch, API pairing 201, unpaired 401) | COMPLETE — VERIFIED (locally) |
| 2 | Online (cloud) pairing / claim flow | An online client reads only its claimed robot's synced data | None: OPEN_ITEMS #14 open, hosted schema not applied (D42) | BLOCKED — EXTERNAL DEPENDENCY |
| 3 | Monitoring strip on every screen after pairing | State, faults, battery voltage, commanded lime, age/stale, self-check dot, on every section | Shown at the top of both sections, and polling continues across them (`ResultsScreen.test.tsx`, Edge) | COMPLETE — VERIFIED (presence) |
| 3a | Strip visually fixed ("pinned") while scrolling | Stays on screen while content scrolls | The card scrolls with the content; a compact sticky strip is a design choice | UNDECIDED — REQUIRES PROJECT DECISION |
| 3b | Component self-check results and battery health | Real per-component dots; a battery-health value | Shown as "Unknown"; bit layout (#9) and health definition (#10) open | BLOCKED — EXTERNAL DEPENDENCY |
| 4 | Dashboard (status) | Stale, no-data and gateway-unavailable states; never "live" | M5a tests + Edge (D33) | COMPLETE — VERIFIED (locally) |
| 5 | Results: one dosing run's readings | pH (2 dp), EC, moisture, temperature, robot timestamp per reading; commanded lime; "expected post-correction pH" | `resultsView.test.ts`, `ResultsScreen.test.tsx`, Edge (20 synthetic readings) | COMPLETE — VERIFIED (locally) |
| 5a | "Completed" runs only | Only finished dosing runs offered | The API has no per-run completion flag; all dosing runs are listed | UNDECIDED — REQUIRES PROJECT DECISION |
| 6 | Results: top-five crop recommendations with reasons | Five category leaders with traceable reasons; rule-set version; weather source; synthetic/draft clearly marked; Open-Meteo credit when a forecast is used | Display implemented and tested with the stored synthetic fixture | COMPLETE — VERIFIED (display). The engine and sourced crop data are build-order item 6 / OPEN_ITEMS #5: BLOCKED |
| 7 | Verification data never on farmer screens | No verification run, reading or observed post-treatment pH shown | Validators reject verification data (`runValidation.test.ts`, client test); Edge text check | COMPLETE — VERIFIED |
| 8 | Explicit local/cloud data adapters | Screens use an adapter, not a transport | `FieldDataSource` + local adapter | Local: COMPLETE — VERIFIED. Cloud: BLOCKED — EXTERNAL DEPENDENCY |
| 9 | Field selection, cell map, cell progress | — | D29 | OUT OF SCOPE (this semester) |
| 10 | Manual-command flow (OPEN_ITEMS #21 mentions Phase 5) | — | D21: disabled; observe-only locked | OUT OF SCOPE |
| 11 | Android/device and outdoor readability | §10 | No device | BLOCKED — EXTERNAL DEPENDENCY (row 14); NOT RUN |

## Tests run (2026-10-27, Windows 11, Node.js v26.11.1)
No `ROBOLIME_*`, `PGTEST_*`, `POSTGREST_*`, `SUPABASE_*` or `EXPO_PUBLIC_*`
variables were set.

| Check | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | 0 errors (gateway, mobile, shared) |
| Lint | `npm run lint` | 0 | 0 errors, 1 pre-existing warning (`apps/gateway/src/http/config.ts:117`) |
| Gateway tests | `npm run test -w @robolime/gateway` | 0 | 27 files passed, 1 skipped; 522 passed, 15 skipped (the same opt-in skips as before) |
| Shared tests | `npm run test -w @robolime/shared` | 0 | 127 passed |
| Mobile tests | `npm run test -w @robolime/mobile` | 0 | 11 suites, 112 passed (was 92) |
| Web export | `npm run build:web` | 0 | 4 files; JS bundle 472,958 bytes |
| Bundle scan | Node counts-only scan of `apps/mobile/dist` | — | 0 secret markers, Supabase variables, `EXPO_PUBLIC_*` names, JWTs, connection strings, PEM keys, user paths or emails; 0 external `src`/`href` in `index.html`. Remote-host strings: `necolas.github.io`, `react.dev`, `www.w3.org` (library doc links and the SVG namespace, not loaded) |
| Cloud migration + RLS | `npm run db:cloud:test` (throwaway local PostgreSQL 17) | 0 | `RLS AND MIGRATION TESTS PASSED` |
| Loopback end to end | Synthetic demo DB, `npm run serve … --host 127.0.0.1 --port 18791 --web-dir …`, then API + headless Edge over CDP | — | 16/16 checks passed: pairing, unpaired refusal, dosing-only runs and readings, recommendation answered, strip present on results, readings and wording, EC caveat, no cell progress, no console errors/CSP violations, only same-origin requests. The gateway and browser were stopped afterwards |

**Not run:** `npm ci` (lockfile unchanged; would rewrite `node_modules`); Expo
Doctor (needs network access to Expo's servers); the opt-in sync integration
harness (gateway unchanged); Android build or device; outdoor readability;
hardware; online (Vercel/Supabase) mode.

## Files (uncommitted)
New: `apps/mobile/src/data/dataSource.ts` (`4f08ceb4…`),
`apps/mobile/src/data/resultsView.ts` (`ebf8cd0f…`),
`apps/mobile/src/data/resultsView.test.ts` (`435000f6…`),
`apps/mobile/src/data/runValidation.test.ts` (`e73c8dfa…`),
`apps/mobile/src/screens/ResultsScreen.tsx` (`78748ca0…`),
`apps/mobile/src/screens/ResultsScreen.test.tsx` (`f6bc8dc7…`).
Modified: `apps/mobile/src/data/gatewayClient.ts` (`96f7fa1d…`),
`gatewayClient.test.ts` (`dadd728f…`), `responseValidation.ts` (`3cbba0b0…`),
`apps/mobile/src/screens/AppRoot.tsx` (`83d7c2b1…`), `AppRoot.test.tsx`
(`7a9b7aac…`), `StatusScreen.tsx` (`c0742b8a…`), `docs/architecture.md`
(two component rows), `docs/decisions.md` (D43).

No gateway, shared, migration, dependency or lockfile change.

## Addendum: firmware baseline (D45, 2026-10-27)
The existing `Robot Code/Final Code` firmware (`origin/main` `432d5b3`) is the
approved baseline and is **not modified** in Phase 5. The details are in D44,
D45 and `PHASE5_firmware_alignment_report_20261027.md`. The verdicts are now
kept separate:

- **Local Phase 5 software:** PARTIALLY COMPLETE (unchanged; see the checklist
  above). Every robot-data feature is exercised with labelled synthetic data
  only.
- **Real robot integration:** **NOT POSSIBLE with the baseline firmware; not
  verified.** This is a project limitation, not a software defect.

### Requirements against the baseline firmware
**Supported by the existing firmware** (on the robot, for bench use; none of
it reaches the gateway or app):
- Motor drive through a USB-serial menu (`finalcode_sprint1_esp.ino` 99–118,
  177–286).
- Actuator and pump on/off from text commands, via the Nano
  (`finalcode_sprint1_nano.ino` 75–103).
- Battery voltage, printed to USB serial every 5 s (`esp.ino` 158–172);
  divider unconfirmed (#43).
- A LoRa radio initialised in receive mode, printing what it receives
  (`esp.ino` 68–75, 145–153).

**Software features testable with synthetic data** (implemented and tested;
synthetic only):
- Local pairing, sessions, loopback API.
- SQLite durability, write-before-ACK, idempotency on `(runId, cellIndex, seq)`.
- Status strip (state, faults, battery voltage, commanded lime, staleness).
- Results section (readings, commanded lime, expected post-correction pH,
  stored recommendation), and verification-data hiding.
- Cloud sync to a local target.
- CSV exports.

**Unsupported by the existing firmware:**
- Any LoRa transmission from the robot, so no readings or status reach the
  gateway.
- Soil readings (pH, EC, moisture, temperature).
- Robot states 0–6, error flags, component checks.
- Run ID, cell index, sequence and attempt count.
- Commanded dose and expected post-correction pH.
- Robot timestamps; GPS position (parsed, never read).
- Flash buffering, ACK handling, retries.
- An answer to the receiver's `GET_ROBOT_STATUS` poll.
- A working radio link: robot at 915 MHz vs receiver at 433 MHz (#41).
- A completed ESP32–Nano handshake: the Nano waits for `ESP32_ACK`, which the
  ESP32 never sends (#43).

**Requiring a future, separately approved firmware revision or hardware change:**
- Robot telemetry and a signed-off packet layout (#1, #42).
- Retention until ACK, plus ACK handling (#15, #31).
- One NTC-compliant frequency on both radios, and confirmation of the radio
  modules (#41, #18).
- The `ESP32_ACK` handshake and component-check encoding (#43, #9).
- Battery divider calibration and a battery-health definition (#43, #10).
- The receiver's USB contract (D22 vs D37, #35).
- The poll response (D38, #36–#37).
- After that: the physical robot → receiver → USB → gateway test and the
  WAN-disconnected field run (rows 12–13).

## Addendum: UI defect fixes and decisions (D46, 2026-10-27)
**Decisions now settled (D46):**
- The status card scrolls normally at the top of each section; it is not
  sticky. Checklist row 3a is closed.
- All dosing runs are listed, including incomplete ones, each labelled "Run
  status: not reported by the gateway". Row 5a is closed as a documented
  data-contract limitation: the contract carries no run status.

**Fixed (with regression tests):**
- **Run identity:** the client rejects a readings or recommendation answer for
  a different run, or with records of another run, as `invalid-response`.
- **Recommendation retry:** a failed recommendation shows an error and a
  "Try again" that reloads only the recommendation (read-only GET). A missing
  recommendation (404) is a settled "not stored yet" state.
- **Late answers:** answers from an earlier visit, run or request are
  ignored. Readings and recommendation load independently, with cancellation.
- **Session rejection while loading:** returns to pairing; no run data stays
  visible.
- **Missing run:** a 404 on readings says "This run is no longer available on
  the field gateway", not "gateway unavailable".
- **EC precision:** shown with up to 6 significant digits, still without a unit
  ("unit unconfirmed").
- **Weather wording:** states only what the stored record says. It no longer
  claims a fetch, or that the defaults are "approved".
- **Tests and comments:** the ineffective progress assertion now uses data
  (7 of 20 cells) that a regression would render, with a self-check that the
  pattern detects the excluded format. The StatusScreen comment matches D46.

**UI review (headless Edge, loopback, synthetic database):** 37/37 checks
passed at 1280 px and 375 px:
- pairing, status, run list, run detail, back and section switching
- no horizontal scroll at either width
- honest labels; no excluded wording
- no console errors or CSP violations; same-origin requests only

**Limitations:**
- CSV exports have no UI entry point; they are CLI only
  (`npm run export:csv`, D32).
- Offline and gateway-unavailable states are covered by screen tests, not by
  a browser run.
- The intermittent mobile-suite failure was **not reproduced** in 11 full
  runs plus 3 runs under CPU contention after these changes. It remains
  **unresolved**; the suspected cause is timing under load.
