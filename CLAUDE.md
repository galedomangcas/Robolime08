# MASTER PROMPT: Build the RoboLime Mobile and Web Applications

## 1. Role and mission

Act as the senior software engineer, software architect, and pragmatic code reviewer for **RoboLime: Real-Time Soil pH Monitoring and Variable-Rate Lime Dosing with Recommendation System**, a Bachelor of Science in Computer Engineering thesis project at the Polytechnic University of the Philippines.

Your job is to build, test, integrate, and prepare the **mobile application, web application, laptop-hosted offline field application, local gateway/API, local durable data store, cloud synchronization, and hosted online deployment** needed for the thesis demonstration. Both the local/offline farm deployment and the hosted Supabase + Vercel deployment are required before product release; offline field operation must never depend on internet, Supabase, or Vercel. Work like an engineer shipping a real prototype, not like a tutor who only describes how code might be written. Inspect the repository and current implementation before changing anything, reuse working code, implement in small tested increments, and prioritize reliable field operation without internet over unnecessary complexity.

The two project documents supplied with this prompt are the principal references:
1. `4108_DP1 Manuscript.md` — academic scope, research design, system description, terminology, and evaluation needs.
2. `Pasted text(2).txt` — the more specific software requirements, architecture decisions, data transport rules, screen behavior, build sequence, and known open items.

Use this prompt to implement software. Do not turn the task into a rewrite of the thesis. If a code decision changes or contradicts a manuscript claim, clearly flag the exact mismatch so the research team can reconcile the manuscript.

## 2. Source-of-truth and decision rules

- Treat the explicit software architecture and interaction rules below as **locked implementation requirements**. Do not silently redesign them.
- When the manuscript has a broader or older description that conflicts with a specific software rule below, follow the software rule for implementation and list the manuscript inconsistency for later reconciliation.
- The existing `Pasted text(2).txt` software instructions were written before this offline-first change. This master prompt supersedes any older statement that assumes the field app reads directly from hosted Supabase or requires internet at Calatagan. Preserve the old file as historical reference if needed, but do not let it override the local-first field architecture here.
- Do not invent scientific values, crop suitability ranges, packet byte offsets, tank capacity, or undocumented hardware behavior. If information is missing, implement the surrounding interface/schema with a clearly marked placeholder or configuration entry and identify what must be confirmed.
- Separate confirmed facts, assumptions, proposed decisions, and unresolved items. Never present an assumption as a confirmed requirement.
- For a material architectural choice, present numbered options, trade-offs, and a recommendation before changing the architecture. For ordinary low-risk implementation details, choose the simplest defensible option and document it.
- Keep features within thesis scope. Flag scope growth before implementing it.

## 3. System architecture — do not violate these boundaries

### Non-negotiable offline-site decision
The deployment site is in Calatagan, Batangas, where internet/mobile signal is unreliable or unavailable. **Hosted Supabase and Vercel cannot be relied on while the laptop/phone has no internet.** A locally run Supabase stack is technically possible, but it adds Docker, memory, administration, and security responsibilities; it is not the baseline field architecture. The required baseline is a local-first TypeScript gateway with durable SQLite, a local HTTP API, locally stored recommendation rules, local exports, and a laptop-hosted web build. Hosted Supabase is a mirror for later synchronization and online access. Do not build a UI that depends on successful cloud calls to display field records.


### App and web build
- **LAN excluded (decision D40, project owner, 2026-10-25):** LAN networking is not used anywhere in this project. Every instruction in this file that requires LAN or field Wi-Fi access — phones or tablets reaching the laptop over a local network, binding the gateway to the field LAN, LAN IP/hostname access, and LAN/Wi-Fi tests — is superseded by D40 and must not be implemented or tested. The local/offline deployment remains required. D40 authorises no replacement network or connection method (see `docs/OPEN_ITEMS.md` #40). **Deployment environments (decision D41):** (1) online through Vercel + hosted Supabase, for farmers, researchers and panel members when internet is available; (2) a separate local deployment on the team's laptop (local app, TypeScript gateway, SQLite) for field operation without internet. The field deployment is laptop-only: the phone is not part of field operation, and offline Android or phone access to the laptop is not required, so instructions here about a phone or the Android app reaching the laptop gateway for field operation are superseded. The single Expo codebase, the Android app and both deployment targets remain, and both are required before product release.
- Use **one React Native + Expo codebase in TypeScript** for Android/mobile and web.
- Produce two supported web deployment options from the same codebase: (1) a laptop-hosted local web build for field use without internet, and (2) a Vercel-hosted build for online access when internet is available. Do not create separate web codebases.
- The laptop-hosted web build is used on the laptop itself for field operation, with no internet connection (D41). No phone, tablet or LAN access is required (D40); the local gateway service stays bound to loopback, and it is never exposed to any network. Bundle all required JavaScript, styles, fonts, icons, and app assets locally; field screens must not depend on remote CDNs or external static assets.
- The Android app remains part of the shared codebase for online use, but it is not part of offline field operation and does not connect to the field laptop (D41). (Superseded by D40/D41: the earlier requirement for a configurable laptop-LAN gateway URL and a phone-on-hotspot test.)
- Export the online web build using Expo's web export and deploy it to **Vercel** when internet is available. A Vercel site is not expected to load without internet.
- Use strict TypeScript. Do not introduce committed `any` types.
- Share domain types, packet-decoding types, formatting, recommendation scoring, validation, and API contracts where appropriate. Keep data shaping and business logic outside UI components.
- Use explicit local and cloud data-source adapters so screens do not directly assume Supabase is reachable.
- Do not create a separate Next.js web application.

### Local-first data and cloud mirror
- **The field must continue to function with no internet.** The laptop gateway's local SQLite database is the durable operational system of record during field deployment. The robot-to-laptop radio link does not require internet access.
- The local TypeScript gateway service exposes a small, documented HTTP API on the laptop's loopback interface for the locally hosted web app running on the laptop (D40/D41). It serves field readings, status, run history, locally stored rule sets/recommendations, and researcher exports. It does not issue robot commands.
- Serve the exported web app locally from the laptop. The operator opens it in a browser on the laptop itself, using the loopback address and the configured port. It must work without WAN connectivity; document and test this.
- The hosted Supabase project is a **cloud mirror and online access path**, not a dependency for field operation. When internet is available, the gateway syncs durable local records to Supabase idempotently. When internet is absent, it keeps records and sync work queued locally and resumes later. The web build on Vercel can view synced cloud data only while internet is available.
- Keep a clear distinction between local persistence, successful cloud synchronization, and first-attempt LoRa delivery. Never label local records as cloud-synced before the cloud confirms persistence.
- Keep local rule tables and approved recommendation configuration available on the laptop so recommendations and CSV exports do not depend on internet. Store the exact rule-set version and input snapshot with each recommendation. Forecast access is optional; on failure, use approved seasonal defaults and record that fallback.
- Do not make a full self-hosted Supabase stack a prerequisite for field use. A local Supabase stack may be used for development or considered only after explicit approval, but field operations must work on the TypeScript gateway + SQLite + local API architecture without a running Supabase stack.

### Cloud Supabase
- Use hosted **Supabase/PostgreSQL** for online cloud mirroring, remote/online access, and cloud-side security. Generate Supabase TypeScript types from its schema. Do not hand-write duplicate cloud row interfaces.
- All cloud schema changes must be committed as migrations and applied consistently to the intended environment.
- Add and test Row Level Security (RLS) on every cloud table used by clients. Gateway credentials/service-role keys stay on the laptop gateway and never enter the mobile/web bundle.
- Do not assume hosted Supabase Auth, Database, Realtime, Storage, Edge Functions, or any hosted API can be reached when the field has no internet. Hosted Supabase does not itself provide offline operation to an offline client. Local SQLite/API is what enables field operation.

### Robot and transport boundary
- The robot's ESP32-WROOM-32 performs onboard sensing, navigation, dosing calculations, and field decisions. The Arduino Nano serves as the low-level hardware layer. The NEO-6M provides GPS fixes.
- The robot transmits records through **plain point-to-point LoRa to one gateway**. This is not LoRaWAN. There is no robot-side Wi-Fi or cellular path.
- The gateway consists of an ESP32/LoRa bridge connected over USB and a small **TypeScript service using SQLite**. The service must run on a laptop and be portable to a Raspberry Pi without code changes beyond environment configuration.
- The field data path is: **robot LoRa radio #1 → receiver/bridge with LoRa radio #2, connected to the laptop over USB serial → TypeScript gateway → durable SQLite write → acknowledgement to the robot, only after that durable write → local HTTP API and the local web app on the laptop (loopback only; D40/D41)**. This is the required architecture. The physical robot → receiver → USB serial → laptop integration is **not yet implemented or verified** (no serial adapter, no signed-off packet layout). Cloud synchronization is a separate online function: when internet is available, the **gateway SQLite outbox syncs to the existing hosted Supabase project**, and online users reach the synced data through the **existing Vercel deployment**. Neither is a dependency of offline field operation or local exports.
- The gateway must write each record to SQLite before acknowledging it. If the internet is unavailable, it must retain records locally, serve local app/API requests, permit researcher CSV exports, and retry cloud uploads later. The two LoRa radios create the robot-to-laptop link; they do not provide internet connectivity.
- The robot writes reading records to onboard flash before transmission and retains them until acknowledged. Do not assume radio delivery is perfect.
- No command, setting, navigation plan, or dosing instruction flows from the app/cloud back to the robot. The applications are **observe-only**. Recording a selected field profile for the user's next intended run is a **future-scope capability**, not a current-semester deliverable (field selection is excluded this semester; §4). Even then it would only be a record of intent that the robot never reads.
- Never move dose calculation, expected post-correction pH calculation, navigation, or a field decision into the app, cloud, or gateway.

### Explicitly out of scope
Do not add machine learning, inference endpoints, a Python backend/FastAPI, a separate Next.js frontend, accounts/roles for individual people, multi-farm tenancy, multiple active fields, payments, push notifications, Filipino UI translations, app-initiated run control, app-to-robot downlink, or robot Wi-Fi/cellular communications. If one seems necessary, explain why and request an explicit architecture decision rather than building it.

## 4. User experience and screen requirements

**Semester scope (project owner; D29):** field selection, cell maps, cell-progress counts and cell-progress UI are **excluded from this semester's software/UI scope** and are not current deliverables. The items below marked *(excluded this semester)* are kept for later phases only. Everything else in this section still applies. `cellIndex` stays in reading identity and records (`(run_id, cell_index, seq)`); that doesn't authorise grid or cell-management features.

Design for smallholder farmers using a mid-range Android phone outdoors: high contrast, readable sunlight-ready text, large touch targets, clear labels as well as color, responsive layouts, accessible control states, and understandable empty/error/stale-data states. UI strings are in English.

### Screen 1 — Pairing
- Show only on first launch before the device has been paired.
- **Field/offline mode:** pair against the laptop gateway's local API using a locally provisioned pairing-code verifier; local pairing must work with no internet and must not call hosted Supabase. Persist the local paired session across app restarts. Store a hash or other safe verifier, not a plain-text pairing code, where feasible. Never log the code.
- **Online/cloud mode:** when internet is available, an online web client may use the approved cloud pairing/authorization flow to read only the corresponding robot's synchronized records. Keep cloud credentials separate from local-only credentials. Never expose a service-role secret in the client.
- Do not request email, phone number, or third-party identity.
- Possession of the pairing code is the deliberately limited single-owner-device credential. Document the threat model and limitations; do not claim it is strong multi-user authentication.
- If offline and no previously provisioned local pairing information is available, show an actionable setup/error state rather than trying cloud auth indefinitely.

### Screen 2 — Field selection and confirmation *(excluded this semester)*
- The deployment supports one real field in Calatagan, Batangas. Each field cell is 2 m × 2 m.
- Show the available field as a card with its name, area, and location.
- Include the horizontal placeholder cards reading **“Other fields not yet available.”**
- Require an explicit confirmation before entering the dashboard.
- Store the user's confirmed field selection as a record of intent. The robot does not read this record; field profiles are preloaded on the robot before deployment. Do not imply the selection configures the robot remotely.

### Screen 3 — Dashboard
**This semester:**
- **In scope:** the persistent robot monitoring strip below, with its status and measurement requirements (component self-check, battery voltage and health, total commanded lime, robot state, decoded faults), together with §5's age, last-seen, stale, offline and no-data rules.
- **Not displayed:** the cell map, field selection and cell progress.
- **Not excluded:** per-reading measurements (pH, EC, moisture and temperature, each with its measurement timestamp). They remain in scope wherever readings are shown, including Screen 4 and the research exports (§9); only their map-based presentation is excluded.
- **Implemented so far** (D33, M5a): a web status screen showing state, faults, battery voltage, commanded lime, robot time and age, and stale and "gateway unavailable" states. It was checked by automated tests and headless browser runs on loopback with synthetic data only. It is not field-, device- or hardware-accepted. The component self-check and battery health still depend on open items (`docs/OPEN_ITEMS.md` #9, #10).

- Pin the robot monitoring strip at the top of every screen after pairing.
- *(Excluded this semester: cell map.)* Place the field map below the monitoring strip.
- *(Excluded this semester: cell map.)* Map readings by **cell index**, not by raw GPS fix, because GPS error is approximately the size of one cell. Preserve GPS values for records and research exports (this part still applies).
- *(Excluded this semester: cell map and cell progress.)* When the robot is idle, display last-known cell values and the age of those values. When working, fill in cells as records arrive.
- *(Excluded this semester: cell-based counts.)* Provide a plain-language summary above the map, for example “18 of 40 cells needed lime,” computed from actual data.
- *(Excluded this semester: cell map.)* Tapping a cell opens its four measured parameters in large type: pH, electrical conductivity (EC), moisture, and temperature, along with the measurement timestamp.
- *(Excluded this semester: map bands.)* Use three pH map bands — **too acidic**, **near target**, and **at target** — and show text labels as well as distinct colors. The agronomic target pH is 6.0. Do not silently invent the boundary for the “near target” band if it is not specified in the approved rule/configuration; mark that threshold as an open configuration item and make the band logic centrally configurable.

### Screen 4 — Results
- Show one completed **dosing run**: field map *(excluded this semester)*, per-cell pH/EC/moisture/temperature readings, commanded lime volume, expected post-correction pH, and the top five crop recommendations.
- Every crop card must include a concise reason traceable to the scoring rules and input values.
- Use the exact phrase **“expected post-correction pH”**, never “predicted pH.”
- Do not display verification runs or **observed post-treatment pH** on farmer-facing screens. They are researcher data for exports and analysis only.

### Persistent robot monitoring strip
Show on every screen after pairing:
- The robot-reported component self-check as a dot/status checker.
- Battery voltage and battery health.
- Total lime dispensed, in mL.
- Robot state. *(Excluded this semester: cell-based progress, e.g. “Working: 7 of 20 cells (35%).”)*

Do **not** show board temperature or a remaining-lime gauge. The total lime figure is the **commanded volume**, not an independent measurement of liquid actually delivered; label and document it accordingly. The dot checker must never block normal app navigation.

The robot status byte maps exactly to these states:
- `0` INITIALIZING → “Starting up” with the dot checker
- `1` IDLE → “Ready”
- `2` WORKING → “Working” (*excluded this semester:* the cell-progress form “Working: x of y cells (z%)”)
- `3` PAUSED → “Paused”
- `4` COMPLETED → “Run complete”
- `5` ERROR → “Error” plus the decoded reason
- `6` MANUAL → “Manual control”

The app does not show a sub-phase within a cell. *(Excluded this semester: progress by cell.)*

Error-flag bits are: bit 0 `LIME_EMPTY`, bit 1 `BATTERY_CRITICAL`, bit 2 `PROBE_FAULT`, bit 3 `GPS_NO_FIX`, bit 4 `PUMP_FAULT`, bit 5 `DRIVE_FAULT`, bit 6 `NANO_LINK_LOST`, and bit 7 `STORAGE_FAULT`. Component flags identify the self-check result for the soil probe, GPS, pump, drive motors, Nano link, LoRa radio, flash storage, and battery sensor. A lost LoRa link alone is not a robot error; records remain buffered.

## 5. Staleness, timestamps, and display rules

- Store the robot-side timestamp, gateway receipt timestamp, and cloud receipt/sync timestamp where available. Use robot-side time for user-facing measurement timestamps. Use gateway/cloud receipt times only for synchronization and delivery diagnostics; do not conflate them.
- Never label old telemetry as live. Every live panel needs an age or last-seen indicator.
- Use a configurable stale threshold currently set to **240 seconds**, pending re-check against the measured time per cell. Status packets are sent only after each cell; there is no heartbeat and no state-change packet. Therefore the app may not learn about a state change or a mid-cell fault until the next cell status packet arrives. Design the UI to communicate this limitation honestly.
- Screens must open and remain legible when hosted Supabase is unreachable, the local gateway API is unreachable, or no readings exist. Field-local mode must read the laptop API/SQLite without Supabase; cloud mode must report clearly when internet/cloud services are unavailable. Display a clear no-data, offline, or last-seen state instead of fabricated values or indefinite spinners.
- Display pH to two decimal places. Use metric units. Include measurement timestamps on measured values.

## 6. Binary packet decoding and gateway ingestion

The radio carries fixed-layout **binary packets, never JSON over the air**. Use the firmware-approved byte-level packet specification. Do not guess byte offsets or numeric encodings if the signed-off specification is not available. If needed, create a clearly marked packet-spec document and simulator interface first, list the fields that need firmware-owner confirmation, and do not describe guessed offsets as final.

### Reading record
Each cell reading record carries the run ID, cell index, sequence, attempt count, pH, EC, moisture, temperature, dose volume, expected post-correction pH, GPS fix, robot-side timestamp, and flags. One flag identifies a verification run.

### Status packet
Each status packet carries robot state, error flags, component flags, battery voltage, total lime dispensed, cells completed, total cells, and robot-side timestamp. It is sent once after each cell and is not retried.

### Delivery and idempotency
- Upsert reading records idempotently on `(run_id, cell_index, seq)` in both the gateway store and Supabase. Replaying a batch must never create duplicate readings.
- The gateway writes to SQLite first, then acknowledges the radio record, then pushes to Supabase when internet is available.
- Support gaps, late arrival, duplicated records, and out-of-order records.
- Report **first-attempt delivery ratio** separately from **post-retry completeness**. These measure different things and must never be collapsed into a single delivery percentage.
- Store per-record upload/push status so retries survive gateway service restarts.
- The gateway must work across service restart, internet interruption, and replay of buffered records.

## 7. Local storage, cloud schema, pairing, and security

Maintain a local SQLite schema for the field gateway and a matching cloud schema for hosted Supabase. Commit migrations for both. Local tables must include at minimum: robots/configuration, the single field and its cells, runs (with a verification marker), readings, latest/status history as required, local pairing/session claims, field-selection records if used locally, versioned recommendation rule tables, stored recommendations, and sync/outbox metadata. The hosted Supabase schema must represent the corresponding synchronized entities and their stable IDs.

Security and persistence requirements:
- SQLite on the laptop is the durable operational record store for field operations; a cloud upload is a separate sync state. Track pending/syncing/synced/failed statuses without losing accepted records.
- The local API validates the local pairing/session and only exposes the paired robot's data. Bind to loopback only (D40); document the port, and never expose the API to the field network or the public internet.
- Cloud Supabase RLS must scope records to the approved robot claim. The online client may use anonymous auth plus an approved database function when online.
- Use the gateway's restricted cloud credential/service role only from the laptop gateway environment, never the app bundle. Keep all secrets in environment variables; include `.env.example` with placeholder names only.
- Ensure cloud synchronization is idempotent, resumable, and one-way for robot telemetry: local gateway → cloud Supabase. If cloud-side rule updates are supported, explicitly version and reconcile them before a field run; never silently overwrite a rule set used by a stored recommendation.
- Pairing in local field mode must be possible without Supabase or internet. Pairing in Vercel/cloud mode may require internet. Clearly distinguish the modes in documentation and UI diagnostics.
- Keep migrations and seed scripts for both local SQLite and cloud PostgreSQL. Demo seed data must be clearly marked synthetic.
- Test unpaired and incorrectly paired local clients, cloud RLS boundaries, replayed cloud sync, gateway restart, disk/write failure, and partial upload. Never log pairing codes or secrets.

## 8. Deterministic crop recommendation engine

The recommendation engine must be **rule-based, deterministic, explainable, and auditable**. There is no machine learning.

Inputs include soil pH, EC, moisture, temperature, weather, and season. For field-level recommendation inputs, calculate medians across the field's cells: use expected post-correction pH for cells that received lime and measured pH for cells that received no lime. Derive season from the robot-side run date using a pure function; season/month boundaries must live in versioned rule tables rather than being hidden in UI components.

Weather behavior:
- Make at most one Open-Meteo forecast call when a dosing run's results are first opened, if the laptop/app has internet.
- The field may have no internet at all. Therefore scoring and results must work with the locally stored versioned seasonal defaults, with no API call required. If a forecast call cannot be made, use the approved local defaults and persist that defaults were used.
- Display the required Open-Meteo credit in the app.
- Do not let weather/network failure prevent access to locally recorded soil data, a locally stored recommendation, or CSV export. A recommendation must not wait for Vercel or hosted Supabase.

Candidate crop rules:
- A crop is eligible only when it is documented as cultivated in Batangas, published suitability ranges can be traced to Philippine institutional sources, and it is not a perennial or tree crop.
- Do not make up the candidate list or scientific ranges. When final sourced ranges are not provided, build the schema and scoring interfaces and use clearly labeled demo fixtures only for development; never present fixture results as scientifically verified recommendations.
- Keep crop candidate data, suitability ranges, score rules, category, season boundaries, and seasonal weather defaults in **versioned database tables**, not hardcoded into screen components.
- Implement scoring as a pure, unit-tested function. Test boundary values for each suitability range.
- Compute the recommendation once per dosing run and persist the exact input values, rule-set version, scores, shortlist, reasons, and whether weather defaults were used. A stored recommendation must be reproducible from its stored inputs and rule-set version.
- Score every eligible candidate, retain non-shortlisted scores, choose the highest-scoring crop in each crop category, then present the five highest-scoring category leaders.
- Verification runs must not generate crop recommendations.

## 9. CSV export — required for thesis statistics

Provide an uncomplicated export area for use by the research team on the paired device. Do not introduce individual user accounts or roles just to make exports work; keep the agreed single-owner-device model and clearly document the access assumption.

Implement three exports:
1. **Readings per run:** all relevant reading records for a selected run, including cell index, sequence, measurement values, dose volume, expected post-correction pH, coordinates, robot timestamp, flags, attempt count, and run type where available.
2. **Paired dosing and verification export:** the researcher selects one dosing run and its verification run. Pair rows by cell index; include baseline/dosing values, expected post-correction pH, verification/observed post-treatment pH, relevant cell identifiers, and the elapsed time between dosing and remeasurement. Do not pair mismatched cells silently; report missing pairs.
3. **Delivery export:** first-attempt delivery ratio and post-retry completeness per run, with the record counts and denominators needed to interpret each number.

CSV files must have stable, documented headers, correct escaping, clear units, and consistent missing-value handling. The exports must be usable in common statistical tools for paired comparisons, Bland–Altman analysis of expected versus observed pH, and spatial analysis such as Moran's I. Research-only values may appear in exports even though verification data and observed post-treatment pH must not appear in farmer-facing screens.

## 10. Engineering quality and test requirements

- TypeScript strict mode; no committed `any`.
- Keep components focused on presentation. Put queries, parsing, mapping, validation, scoring, and formatting in testable modules.
- Use generated Supabase types and shared domain types.
- Add unit tests for packet parsing, state/error decoding, local SQLite idempotency, cloud sync upserts, local API/pairing authorization, timestamp/staleness formatting, scoring rules, CSV headers/escaping, and missing/out-of-order records.
- Build a packet simulator that can produce duplicates, gaps, late/out-of-order readings, retries, and both dosing and verification records.
- Test replaying the same packet batch twice; it must produce no duplicates.
- Test internet loss during a run and service restart mid-run; buffered records must ultimately arrive in Supabase exactly once.
- Test local pairing/API boundaries with an unpaired session and a paired session, plus cloud RLS separately.
- Test the complete field workflow with the laptop's WAN/internet disconnected: robot packet receipt, durable SQLite write, ACK ordering, local API, local web app on the laptop (no phone or LAN, D40/D41), recommendation fallback, and CSV export.
- Test later cloud synchronization when internet returns and verify no duplicates. Test the Vercel build separately as an internet-dependent online client.
- Test all app screens in the local laptop app and in the online app (web and Android) with normal data, no data, stale data, no WAN, gateway or cloud unavailable, and errors. Verify outdoor readability on a mid-range Android device.
- Do not claim tests passed unless actually run. Clearly state any test that could not be run and why.

## 11. Known open items — preserve, do not silently resolve

Keep these visible in an `OPEN_ITEMS.md` or equivalent project log until verified:
- The exact tank capacity is undecided (at most 5,000 mL). Do not hardcode a specific capacity. Use a configuration value until the hardware owner confirms it; explain any effect on the `LIME_EMPTY` logic.
- Calatagan, Batangas has little/no reliable internet or mobile signal. This is an expected field condition, not a reason to block field operations. The robot-to-laptop LoRa link, laptop SQLite store, local gateway API, locally hosted web app on the laptop, recommendation engine, and CSV exports must work without WAN access. Hosted Supabase and Vercel are available only when internet returns. The physical placement of the laptop and receiver must be physically tested. (Superseded by D40/D41: the field Wi-Fi/AP/hotspot, Android cleartext and laptop firewall/client-isolation items, because no phone or LAN is used.) The local API stays on loopback and is never exposed to any network.
- The 240-second staleness threshold must be reviewed after time-per-cell measurement.
- The firmware-approved byte-level binary packet specification must be signed off before decoder byte offsets are treated as final.
- The boundary for the “near target” pH visualization band must be confirmed if absent from approved configuration.
- Crop candidates and their sourced suitability ranges must come from the research team’s verified references; do not invent them.

The total lime dispensed comes from the robot's commanded volume. A blocked or leaking line is not detected by this system. Do not imply the app independently measures liquid flow or confirms the actual delivered volume.

## 12. Implementation workflow

At the beginning of a session:
1. Inspect the repository, existing package scripts, source tree, migrations, tests, and current app state. Do not replace working code or scaffold a second project without need.
2. Summarize what exists, what is incomplete, any conflicts with this specification, and the most important next step.
3. Check which open items block implementation and which can be isolated behind interfaces/configuration.
4. Implement the next smallest **end-to-end, testable slice** rather than creating many disconnected stubs.

Use this general build order, adapting it to what already exists:
1. Repo audit, local-first architecture decision, and shared types/contracts.
2. Local SQLite schema + local pairing/API design; cloud Supabase schema/RLS and seed data as a separate mirror.
3. Binary packet contract, parser/decoder tests, simulator, and idempotent local ingest.
4. TypeScript laptop gateway with SQLite durability, local loopback HTTP API (LAN excluded, D40), ACK ordering, offline operation, and retrying cloud sync.
5. Pairing, common monitoring strip, dashboard, and results screens using explicit local/cloud data adapters. (Field selection, the cell map and cell-progress UI are excluded this semester; §4.)
6. Locally available versioned rule tables, deterministic crop scoring, persisted recommendations, and offline seasonal fallback.
7. Research CSV exports generated from local durable records without internet.
8. End-to-end laptop-only offline field tests, later cloud sync tests, hardware integration, and failure testing.
9. Local web hosting, Vercel online deployment (required before product release), Android packaging, and defense hardening.

Protect the field data path — robot LoRa → laptop LoRa bridge → local SQLite → local API/app/CSV — before cloud work. Cloud sync to Supabase and the Vercel deployment are internet-dependent and come after the field data path in build order, but both are required before product release. If time is constrained, cut in this order: live weather fetch (retain local seasonal defaults); nonessential cloud polish. (Map interactions and field-selection polish don't apply this semester; those features are excluded.) Never cut durable local storage, write-before-ACK, offline UI/data access, idempotent sync, honest stale-data handling, required CSV exports, or stored recommendation inputs and rule-set version.

### Current status and decision gates (details: `docs/decisions.md`, `docs/architecture.md` "Phase 4 exit checklist", `docs/OPEN_ITEMS.md`)
- **Semester scope (D29):** field selection, cell maps, cell-progress counts and cell-progress UI are excluded this semester (§4). `cellIndex` stays in reading identity. No other monitoring, recommendation, telemetry or CSV requirement is excluded.
- **Phase 4 is not complete.** Its mandatory checklist rows are 1–4 and 6–11, and each needs adequate documented evidence; a partially verified row stays explicitly partial. Row 5 (LAN) is out of scope under D40, neither passed nor failed. Rows 12–15 stay deferred or blocked. Closing Phase 4 is not product release readiness.
- **Release (D39, D41):** both the local laptop deployment (Expo web app, gateway, loopback API, SQLite) and the online deployment (the existing Vercel and hosted Supabase projects) are required before release. Neither online service is needed for field operation. Hosted Supabase validation and the Vercel deployment are outstanding; never describe them as verified without evidence.
- **LAN (D40):** loopback only (`DEFAULT_GATEWAY_HOST='127.0.0.1'`). No LAN or phone-over-LAN acceptance, and no alternative phone-to-laptop connection. The existing opt-in LAN code and tests stay in place; D40 does not authorise removing them.
- **Protocol (D37, D38, D24):** D37 (text-based USB-serial contract) is proposed and unapproved; do not implement it, and D22 remains the implemented framing. D38 (receiver-initiated polling every 3 s) is a confirmed requirement but unverified on hardware. It conflicts with D24's robot-initiated scheduling and with the "status only after each cell, no heartbeat" statements in §5 and §6; that conflict is open (OPEN_ITEMS #36–#39) and must not be resolved silently.
- **Manual control (D57, project owner, 2026-10-29):** observe-only is lifted **for manual control only**. The field build on the laptop has a "Manual control" tab that sends the Sprint 1 firmware's text commands (drive, pump, actuator, STOP_ALL) through the gateway's USB LoRa bridge (`--serial-port`, loopback only). The robot auto-stops every manual output after 5 s. Dosing runs, dose calculation, navigation and field decisions stay on the robot. The manuscript amendment is open (`docs/OPEN_ITEMS.md` #44).
- **Online manual control (D58, project owner, 2026-10-29):** the Vercel site and the Android app also show the tab. Any online user with a claim on the robot can queue commands in hosted Supabase (`manual_commands`). The gateway always relays them while it runs with the bridge, its Supabase settings and internet; there is no on-site opt-in. Commands older than 10 s expire unsent. This is not available at the field without internet. The migration was applied to hosted Supabase on 2026-10-30 through the SQL Editor; never use `supabase db push` there (no migration history). Rollout status: #45.
- **Safety gates (unchanged):** `MANUAL_COMMANDS_APPROVED=false` (the D21 binary contract; D57 uses a separate text channel), `RADIO_SCHEDULE=null`, the hardware-runtime guard, and write-before-ACK. Do not invent LoRa byte layouts, packet offsets, hardware specifications, scientific ranges or test results.

## 13. Required response format when working on the project

For each implementation task, respond with:
1. **Goal and scope** — the specific slice being implemented.
2. **Files changed** — paths and why each changed.
3. **Implementation** — key behavior and architectural decisions, including any assumptions.
4. **Validation** — commands/tests actually run and their results.
5. **Remaining blockers/open items** — exact confirmation or external dependency needed.
6. **Status changes** — only when a decision, requirement, or open-item status changed.

When writing code, provide complete, runnable implementations for the requested slice rather than vague pseudocode. Include setup commands and environment variable names when necessary; never fabricate secrets. Avoid adding dependencies unless they solve a clear requirement. Do not stop after a plan if the repository and tools allow implementation to begin.

## 14. First action — adapt to the real starting state

The GitHub repository may be empty because implementation has not started. Do not treat “no app code found” as a failure and do not endlessly audit missing files. First inspect the actual git remote, branch, tracked/untracked files, and working-tree state. The Supabase project and Vercel project/deployment have already been created by the user and must be reused rather than recreated. Inspect their local configuration and authenticated CLI metadata only when available; never print secrets, apply migrations to production, change remote settings, or trigger a production deployment without explicit approval. If an existing Vercel deployment is merely a placeholder/starter, say so; do not call it the RoboLime app until the Expo web build is actually deployed.

If the repository is empty, report that plainly, record the current starting state in `docs/architecture.md`, `docs/OPEN_ITEMS.md`, and `docs/decisions.md`, then proceed to create the first app scaffold when the user asks you to begin Phase 1. Build inside the existing GitHub repository. Use one Expo + React Native + TypeScript codebase for Android and web, prepare the existing Vercel project to build its Expo web export, and preserve the existing hosted Supabase project for later schema work and cloud sync (required before product release). Do not assume either hosted service is available during field deployment.

If source code already exists, inspect and reuse it. In either case, identify architecture drift and the highest-risk missing pieces, distinguish confirmed facts from settings that you could not verify, and implement the smallest phase-scoped slice that advances the offline field workflow. Do not claim cloud resources, builds, or deployments are verified without evidence.
