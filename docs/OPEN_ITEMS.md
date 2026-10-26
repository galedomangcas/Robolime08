# Open items

Items that must be confirmed by the hardware, firmware, or research team
before the related code is treated as final. **Do not resolve these by
guessing.** Update the status column with who confirmed what and when.

| # | Item | Owner | Blocks | How the code handles it now | Status |
|---|---|---|---|---|---|
| 1 | **Signed-off byte-level LoRa packet specification** (reading record and status packet: field order, offsets, widths, endianness, scaling, timestamp encoding, flag bits, ACK format, robot/run identifier formats) | Firmware | Packet decoder, simulator, gateway ingest | Phase 3: the **logical** LoRa v1 contract (kinds, fields, validation, 255-byte limit) is implemented in `packages/shared/src/protocol/lora.ts`; the byte layout plugs in behind `LoRaPayloadCodec`. `UNSIGNED_LORA_CODEC` refuses to decode or encode, so **no real packet can be processed yet**. No byte offsets exist in the code. Identifiers remain opaque text (≤ 64 chars) | Open |
| 2 | **Lime tank capacity** (≤ 5,000 mL; exact value undecided) | Hardware | Any display relating dispensed volume to capacity; `LIME_EMPTY` interpretation | `robots.tank_capacity_ml` is NULL by default with a CHECK of `0 < x ≤ 5000` (SQLite and cloud). `LIME_EMPTY` is taken from the robot's error flag, not computed. No remaining-lime gauge is shown (by requirement) | Open |
| 3 | **Stale-data threshold** (currently 240 s) must be re-checked against the measured time per cell | Research + hardware | Stale labels | `STALE_THRESHOLD_SECONDS = 240` in `packages/shared/src/config.ts`, marked provisional | Open |
| 4 | **"Near target" pH band boundary** for the dashboard map (target pH 6.0 is confirmed) | Research | Map colouring | Not implemented yet; will be a central configuration value | Open |
| 5 | **Crop candidates and sourced suitability ranges** (Batangas-cultivated, non-perennial, Philippine institutional sources), score rules, season boundaries, seasonal weather defaults | Research | Recommendation engine | Only the `CropRecommendation` contract exists; no crop data or ranges in code | Open |
| 6 | **Field network setup**: Wi-Fi AP/hotspot choice, laptop placement, firewall/client-isolation behaviour, Android cleartext-HTTP config if plain HTTP is used on the isolated LAN | Team (physical test) | Gateway LAN API, Android app reaching laptop | The gateway HTTP server binds to **loopback** by default (D28). Opt-in LAN binding is implemented per D36 (`--lan`/`GATEWAY_LAN_MODE=on`, automated tests only; the opt-in real-socket test has not been run): an assigned RFC 1918 address, fail-closed binding, operator-managed firewall rule scoped to Private profile, port and local subnet, plain-HTTP risk accepted for a trusted field network only; the same-subnet restriction is deferred until it is checked on these networks. The web build served by the gateway calls the API on its own origin (D33); native builds would use `EXPO_PUBLIC_GATEWAY_URL`, untested on any device. **LAN, physical-network, Android/native-device and field tests have NOT been run**. **D40 (2026-10-25): LAN is excluded project-wide; no LAN, hotspot or phone-over-LAN test will be performed.** Offline device access is tracked in item 40 | **Out of scope (D40)**; historical |
| 7 | **EC unit reported by the probe** (µS/cm, mS/cm, or dS/m) | Hardware | EC display and CSV headers | `formatEc` requires the unit to be passed explicitly; no default unit assumed. The research CSV exports (D32) write the stored value under `ec_unit_unconfirmed` until the unit is confirmed | Open |
| 8 | **Robot clock source and accuracy** (GPS time? RTC?) — staleness compares robot time with the viewer's clock | Firmware | Accurate "age" display | `describeFreshness` reports a distinct `future` state when the robot clock is ahead instead of hiding it | Open |
| 9 | **Component self-check flag bit positions** (probe, GPS, pump, drive motors, Nano link, LoRa radio, flash, battery sensor) | Firmware | Monitoring-strip dot checker | Component names defined; no bit mapping | Open (part of #1) |
| 10 | **Battery health definition** (how "health" is derived from voltage or reported by the robot) | Hardware | Monitoring strip | Not implemented; only voltage is in the status contract | Open |
| 11 | **Reading-record flag bits** (only "verification run" is known to exist) | Firmware | Decoder, exports | `rawFlags` is preserved; `runType` is a decoded field | Open (part of #1) |
| 12 | **Reference documents** `4108_DP1 Manuscript.md` and `Pasted text(2).txt` are not in the repository | Team | Cross-checking terminology against the manuscript | Work proceeds from `CLAUDE.md` | Open |
| 13 | **Real field survey data**: field name/area, cell count, grid layout, cell centres (if any), and the field key used on the robot profile | Research + hardware | Provisioning the real field; dashboard map | Schema supports it (`fields`, `field_cells`, nullable geometry); only the synthetic demo field exists; no field-provisioning CLI yet | Open (Phase 2) |
| 14 | **Online (cloud) pairing / robot-claim flow**: how an online client proves possession and receives a `robot_claims` row; whether anonymous sign-in is enabled on the hosted project | Team | Vercel/online data access | Claims are writable only by a trusted service-role process; no client path exists. Local `supabase/config.toml` keeps anonymous sign-ins disabled. Offline pairing is unaffected | Open (Phase 2) |
| 15 | **ACK policy for duplicate and conflicting readings**, and whether the attempt count starts at 0 or 1 | Firmware | Phase 3/4 ACK loop; first-attempt delivery ratio | Duplicates and conflicts are durably recorded (`reading_receipts`); the original reading is never overwritten. `attempt_count ≥ 0` is accepted until the base is confirmed. Phase 3 **proposes** (D25): ACK `STORED`/`DUPLICATE`/`CONFLICT_RECORDED` after commit; `REJECTED` for run-type mismatch; silence for unknown robots and storage failures. Because the attempt-number base is unconfirmed, the delivery export (D32) leaves `first_attempt_delivery_ratio` empty and exports the raw attempt numbers | Proposed (Phase 3) |
| 16 | **Local session lifetime and pairing-attempt rate limit** | Team | Security posture of the field LAN | Proposed default session TTL 90 days (`DEFAULT_SESSION_TTL_DAYS`). **Rate limit approved and implemented (Phase 4 M2, D30):** 5 failed pairing attempts per client IP per 15 minutes, `429 PAIRING_RATE_LIMITED` with `Retry-After`, in memory only (resets on gateway restart), socket address only (forwarded headers ignored); unit, API and loopback HTTP tests only. The server stays loopback-only (D28); D36 LAN mode is implemented (automated tests only) and keeps D30 unchanged; a shorter LAN session lifetime is a separate decision | Rate limit: implemented (Phase 4 M2). Session TTL: Proposed (Phase 2) |
| 17 | **Validate the cloud schema on the official Supabase stack** (Docker) and decide when to apply it to the hosted project | Team | Cloud sync (Phase 4) | Migration + RLS tests pass on a throwaway plain PostgreSQL 17 with a test-only auth shim; the sync worker passed its local integration run (A2, 2026-10-25) against throwaway PostgreSQL 17.5 + standalone PostgREST 16.4 with that shim (`cloud-mirror.md`); the official stack (Supabase API gateway and `apikey` handling, real roles, key formats) has **not** been run; **not applied to hosted Supabase**; Docker Desktop was not running | Open (Phase 2) |
| 18 | **LoRa radio settings**: frequency (Philippine NTC-compliant), spreading factor, bandwidth, coding rate, sync word, preamble, TX power, over-air CRC, header mode; resulting airtime and usable payload budget | Firmware + hardware | Real radio link, payload budget, retry timing | Not chosen anywhere in code. Only the SX1278 FIFO maximum (255 bytes) is enforced | Open (Phase 3) |
| 19 | **Gateway bridge firmware + USB details**: gateway ESP32 board/module, USB-UART chip/driver, baud rate, flow control, reset-on-open behaviour; bridge firmware implementing USB serial v1; hardware loopback test | Firmware (software team for the contract) | `serialport` connection (build-order item 8, D34) | USB serial v1 framing implemented and tested in software only (`docs/protocol.md` §2). D22 is under reconsideration for the USB link; D37 proposes a text contract instead (item 35). The only receiver firmware in the repository is `Robot Code/Test Cases/SPRINT_1_Gateway.ino`, a text test harness (115200 baud, 433 MHz) that implements neither D22 nor D37; `serialport` not yet added. Phase 4 M3 (D31) added the bridge runtime behind a `ByteTransport` interface, tested with a simulated bridge only; a serial adapter is still missing | Open (Phase 3) |
| 20 | **Timing**: robot post-uplink receive-window delay/length (must cover SQLite commit + USB round trip), the D38 poll response timeout and no-reply handling, reading retry interval/back-off, bridge TX-result timeout, command ACK timeout / max transmissions / execution-report timeout, link-loss (dead-man) timeout | Firmware + team (measure on hardware) | ACK delivery, any manual command | `RADIO_SCHEDULE = null`, `COMMAND_TIMING = null`; tests use values marked TEST-ONLY. The M3 bridge runtime (D31) refuses hardware while `RADIO_SCHEDULE` is null and has no default poll or reconnect timing | Open (Phase 3) |
| 21 | **Approval of manual commands** (D21): the locked observe-only rule must be amended by an explicit team decision, and the manuscript updated, before any command path is enabled | Team | Manual-command flow (Phase 5) | Specified and simulated; every encode/queue/schedule path fails closed on the committed constant `MANUAL_COMMANDS_APPROVED = false` (no approval argument exists) | Open (Phase 3) |
| 22 | **Actuator specifications and limits**: drive motor interface/specs, maximum manual drive duration, maximum command TTL, which faults block motion; pump limits (no pump command is defined) | Hardware | Manual commands | `MANUAL_COMMAND_LIMITS` all `null` → `LIMIT_UNCONFIRMED`. Motion-blocking fault list is proposed only | Open (Phase 3) |
| 23 | **Emergency stop hardware**: whether a physical E-stop exists, what it de-energises, wiring, and test procedure. Radio STOP is not an E-stop | Hardware | Any physical actuation from manual commands | Not modelled beyond a `localStop()` in the reference robot model | Open (Phase 3) |
| 24 | **Radio STOP during an autonomous run**: should a radio STOP be honoured outside manual mode? Honouring it is app-initiated run control (out of scope today); refusing it means only on-robot stops apply | Team + hardware | Robot safety rules R1–R2 | Reference model refuses all commands outside `MANUAL` (`NOT_IN_MANUAL_MODE`) | Open (Phase 3) |
| 25 | **Robot schematic review**: GPIO/SPI nets between the robot ESP32, Ra-02 and Nano in `PCB Schematic/` | Hardware | Firmware, documentation | Not reviewed; no pin assignments in software or docs | Open (Phase 3) |
| 26 | **On-air protocol-version representation**: position and encoding of the version in every LoRa payload, fixed across all future versions | Firmware | Any v2 decoding; mixed v1/v2 ingest | Logical `contractVersion` must be 1 (`lora.ts` 27, 283-289); placeholder codec refuses real payloads (`lora.ts` 432-441, item 1) | Open (Phase 4) |
| 27 | **v2 error-flag table confirmation**, including reserved bits 6 and 7 always sent as 0 | Firmware + team | v2 status decoding | v1 table frozen (`robot.ts` 21-31); proposed v2 table only in `docs/protocol-v2.md` | Open (Phase 4) |
| 28 | **Component-status encoding and runtime fault semantics** for pump, drive motors and flash storage | Firmware | Pump, drive and storage fault visibility in v2 | Component names in `robot.ts` 40-49; all reported `unknown` (`status.ts` 73-75); extends item 9 | Open (Phase 4) |
| 29 | **v2 status identity, deduplication, retention and client display**, including whether `messageId` or another on-air packet counter exists on air, and its semantics | Firmware + team | v2 status storage and display | v1 key (`0001_initial.sql` 149) ignores a later report with the same key even if other values differ; v1 latest status chosen by robot time (`0001_initial.sql` 159-166) | Open (Phase 4) |
| 30 | **Communication-loss rules**: trigger, setting and clearing rules for `COMMUNICATION_LOST`, and any gateway last-heard threshold | Firmware + team (measurement) | Communication-loss indication | No ACK timeout (item 20); 240 s staleness is provisional (`packages/shared/src/config.ts` 17, item 3); no last-heard tracking | Open (Phase 4) |
| 31 | **ACK compatibility and return routing**: on-air ACK format, ACKs for buffered v1 readings, ACK-to-record matching, addressing, rejection and conflict handling | Firmware | Durable delivery across a firmware upgrade | Logical `STORAGE_ACK` (`lora.ts` 93-109) and write-before-ACK tested in software only; see items 15 and 20 | Open (Phase 4) |
| 32 | **Sensor-to-component mapping**: sensors covered by v2 `PROBE_FAULT`, the ultrasonic sensor, and separate probe channels | Firmware + hardware | v2 diagnostics | Eight components in `robot.ts` 40-49; ultrasonic sensor not modelled | Open (Phase 4) |
| 33 | **3-second feasibility evidence**: airtime, duty cycle, receive window, field loss rate, flash backlog, time per cell, baud rate and clock source | Team + hardware (measurement) | Confirming the temporary development target | No transmission interval in code; `RADIO_SCHEDULE` is `null` (`radioScheduler.ts` 29). D38 (2026-10-25) confirms a 3-second **receiver-initiated** polling interval as a requirement; it is still unverified on hardware, and whether it is the same interval as D29's development target is unresolved | Open (Phase 4) |
| 34 | **Formal requirements and protocol approval for v2**, including the amendment of `CLAUDE.md` section 4 | Team | Implementing any v2 change | `CLAUDE.md` §4 (Persistent robot monitoring strip: progress item, status-byte mapping, error-flag bits), §5 (stale-threshold bullet) and §6 ("Status packet") still specify v1 behaviour; v2 is documentation only (D29); `cellIndex` retention confirmed (D29) | Open (Phase 4) |
| 35 | **Text USB-serial contract approval (D37)**: firmware review, exact per-type field lists, line bound, golden test vectors, and authorisation for a gateway text-framing module | Team + firmware | Any receiver-to-gateway data flow; replacing D22 on the USB link | D37 is PROPOSED only. The gateway still implements D22 (`packages/shared/src/protocol/serial.ts`, `apps/gateway/src/protocol/bridgeSession.ts` 1-21, 79); no text framing exists | Open (Phase 4) |
| 36 | **D38 polling exchange specification**: on-air request and response formats, which data a response carries, whether and when the robot listens (including while driving, dosing or retrying), no-reply handling, retry policy on both sides and its relation to the robot's retry from flash. The robot-side sketch and packet specification are **not available** | Firmware | Any real polled exchange; decoder; ACK loop | Nothing implemented. The sketch's `GET_ROBOT_STATUS` text request (`SPRINT_1_Gateway.ino` 29-39) is sample code, not an approved request; see items 1, 20, 26 | Open (Phase 4) |
| 37 | **Scheduler and ACK delivery under receiver-initiated polling**: a reviewed replacement or amendment of D24, and when a storage ACK can be sent within a polled exchange (with items 15 and 31) | Team + firmware | ACK delivery; hardware bridge runtime | `radioScheduler.ts` and `bridgeSession.ts` still implement D24 (robot-initiated windows); `RADIO_SCHEDULE = null`; the hardware runtime is refused (`bridgeRuntime.ts` 128-142) | Open (Phase 4) |
| 38 | **Delivery statistics and gateway visibility under polling**: whether a polled delivery counts as a first attempt, how post-retry completeness and poll success are reported, whether the receiver reports each request it sends and each missing reply, and the staleness threshold under polling (item 3) | Research + team | Delivery export (D32); stale labels | Delivery export unchanged (D32); `first_attempt_delivery_ratio` left empty (item 15); 240 s staleness provisional | Open (Phase 4) |
| 39 | **`CLAUDE.md` and manuscript amendment for D38 polling** (see Manuscript reconciliation below), including whether a receiver-initiated data request is consistent with the observe-only rule | Team | Formal requirements for polling | `CLAUDE.md` §5 (stale-threshold bullet) and §6 ("Status packet") still say status is sent only after each cell with no heartbeat and no retry; neither `CLAUDE.md` nor the manuscript (item 12) has been changed | Open (Phase 4) |
| 40 | **Offline access to local field data from devices other than the laptop, after D40**: whether and how the Android app (or any phone or tablet) reaches the gateway's local data with no internet now that LAN is excluded. D40 authorises no replacement network or connection method | Team | The local/offline mobile configuration (D39); rows 13-14; Android acceptance | The gateway API and served web app are reachable on the laptop's loopback address only (`DEFAULT_GATEWAY_HOST='127.0.0.1'`). Native builds have only the build-time `EXPO_PUBLIC_GATEWAY_URL`, untested. No device connectivity of any kind has been demonstrated. **Resolution (D41, 2026-10-25):** the field deployment is laptop-only and the phone is not part of field operation, so offline phone or Android access to the laptop is **not required**. This settles the scope question only; it verifies nothing | **Resolved (scope, D41)** |

## Housekeeping (not blocking, deliberately untouched in Phases 1–2)

- `PCB Schematic/PCB_Robolime/.history` is tracked as an orphan submodule
  pointer (no `.gitmodules`). Probably a KiCad local-history folder committed
  by accident.
- `Website/` placeholder page will be superseded by the Expo web build; the
  team decides when to archive it.
- `npm audit` — see "Dependency audit" below.

## Dependency audit (checked 2026-10-23, Expo SDK 58.0.17)

`npm audit --omit=dev` reports 15 high-severity entries (43 total including
dev tooling: 25 high, 18 moderate). The 15 production entries come from
**two root advisories**; the other 13 (`expo`, `@expo/cli`, `@expo/metro`,
`@expo/metro-config`, `@expo/code-signing-certificates`, `metro`,
`metro-config`, `metro-file-map`, `metro-transform-worker`, `micromatch`,
`react-native`, `@react-native/community-cli-plugin`,
`@react-native/virtualized-lists`) are flagged only because they depend on
them. They count as "production" because `expo` and `react-native` list
their CLI/bundler packages as regular dependencies.

| Root advisory | Severity | Installed | Used by | In app bundle? | Non-breaking fix? | Decision |
|---|---|---|---|---|---|---|
| `braces` — [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), stack-exhaustion DoS from deeply nested glob patterns | High | 3.0.3 (latest published) | `micromatch` → Metro file watcher, at dev/build time | **No** in the verified web bundle. App code never imports it, so it is not expected in the Android bundle either (Android release bundle not built yet) | **None** — no patched version exists | Defer. Patterns come from our own build config, not from untrusted input |
| `node-forge` — [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), RSA PKCS#1 v1.5 signature check accepts extra nested DigestAlgorithm elements | High | 1.4.0 (latest published) | `@expo/cli` → `@expo/code-signing-certificates` (signing of `expo-updates` manifests in the dev/CLI tooling) | **No** | **None** — no patched version exists | Defer. RoboLime does not use `expo-updates` code signing |

npm's suggested "fix" is downgrading to `expo@44` / `react-native@0.72`,
which is not a real option, and `npm audit fix --force` was not run.

**Remaining risk:** limited to developer/build machines running Expo CLI and
Metro, with input controlled by the team. No vulnerable package ships to
phones or browsers. **Action:** re-run `npm audit --omit=dev` after each Expo
SDK 58 patch update (`npx expo install --fix`) and before any Vercel
deployment or Android release build; adopt the fix as soon as patched
`braces`/`node-forge` releases are pulled in by Expo.

## Manuscript reconciliation

Record here any place where the software departs from the manuscript or the
master prompt.

- **Phase 3 brief vs CLAUDE.md:** the brief describes a bidirectional
  manual-command flow and a later Manual Control UI; CLAUDE.md §3 forbids
  app-to-robot downlink and app-initiated run control. Implemented as
  "specified but disabled" (D21, item #21). If the team approves manual
  control, CLAUDE.md §3–§4 and the manuscript's system description must be
  updated together.
- **Bidirectional radio:** the radio link carries storage ACKs back to the
  robot (already implied by "acknowledgement to robot" in CLAUDE.md). The
  manuscript should describe the link as two-way for acknowledgements, while
  the applications stay observe-only.
- **Gateway hardware:** the gateway is an ESP32 + Ra-02 bridge connected to
  the laptop by USB serial; the laptop does not drive the radio directly.
- **Receiver-initiated 3-second polling (D38, item 39):** the confirmed
  requirement conflicts with:
  - `CLAUDE.md` §5, stale-threshold bullet (status packets only after each
    cell; no heartbeat)
  - `CLAUDE.md` §6, "Status packet" (status sent once after each cell, not
    retried)
  - the 240-second staleness reasoning in `CLAUDE.md` §5, which assumes one
    status per cell (item 3)
  - D24 (robot-initiated exchange)

  The sketch's ASCII request `GET_ROBOT_STATUS` would also conflict with
  `CLAUDE.md` §6's opening rule (binary packets over the air, never JSON); it
  is sample code, not an approved request. Whether a receiver-initiated data
  request fits `CLAUDE.md` §3 (Robot and transport boundary, observe-only
  bullet) needs team confirmation. The
  manuscript's description of the communication flow must be checked
  against D38; the manuscript is not in the repository (item 12), so its
  exact wording has not been compared. `CLAUDE.md` and the manuscript are
  not changed here.
- **LAN excluded (D40, item 40):** `CLAUDE.md` §3, §7, §10, §11 and §12 items
  4 and 8 describe LAN or field Wi-Fi access (phones on the laptop's
  network, binding to the field LAN, Android-on-LAN tests). A precedence
  note in `CLAUDE.md` §3 marks these as superseded by D40; the passages
  themselves are kept. The manuscript's description of phone access to the
  laptop must be reconciled (item 12).
- **Deployment environments (D41):** online through Vercel + Supabase, plus a
  separate laptop-only local field deployment, with no phone in the field
  workflow. The `CLAUDE.md` §3 precedence note covers D40 and D41. The
  manuscript's deployment and phone-access descriptions must match D41
  (item 12).
- **USB-serial framing (D37, item 35):** if approved, the text contract
  replaces D22 on the USB link only. `CLAUDE.md` specifies no USB framing, so
  no `CLAUDE.md` conflict is known. The manuscript should describe whichever
  contract is finally approved.
