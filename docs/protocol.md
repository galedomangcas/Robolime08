# Radio and serial protocol contracts (Phase 3)

Status: **Phase 3 — protocol foundation.** Two separately versioned contracts
are defined and implemented as pure, tested TypeScript in
`packages/shared/src/protocol/`, with a protocol session, simulator and
robot reference model in `apps/gateway/src/`. **Nothing here has run on
hardware.** No firmware exists in this repository, the LoRa byte layout is not
signed off, and **manual commands are specified but disabled** (decision D21).

| Contract | Between | Owner | Status |
|---|---|---|---|
| **USB serial v1** | Laptop (TypeScript gateway) ⇄ gateway ESP32 | Software team (bridge firmware implements it) | Byte layout defined here — **proposed** until the bridge firmware implements it and a loopback test passes (OPEN_ITEMS #19) |
| **LoRa v1** | Robot Ra-02 ⇄ gateway Ra-02 | Firmware team | **Logical** contract defined here (kinds, fields, rules, limits). **Byte layout not signed off** (OPEN_ITEMS #1); the code refuses to encode/decode real packets |

## 1. Hardware topology

```
 ROBOT                                           GATEWAY (field laptop side)
┌──────────────────────────────┐               ┌───────────────────────────┐        ┌────────────────────────┐
│ ESP32-WROOM-32 (robot MCU)   │               │ Gateway ESP32 (bridge)    │  USB   │ Laptop                 │
│  sensing, navigation, dosing │   LoRa (P2P)  │  drives the radio, relays │ serial │  TypeScript gateway    │
│  decisions, flash buffer     │ ◄───────────► │  opaque radio payloads    │ ◄────► │  (`serialport`, Ph. 4) │
│  └─ SPI ─ Ra-02 (SX1278) #1  │  half-duplex  │  └─ SPI ─ Ra-02 (SX1278)#2│        │  SQLite · LAN API      │
│ Arduino Nano (low-level I/O) │               └───────────────────────────┘        └────────────────────────┘
│ NEO-6M GPS                   │
└──────────────────────────────┘
```

- **Two ESP32 boards** and **two Ai-Thinker Ra-02 (Semtech SX1278)
  transceivers**: one ESP32 + Ra-02 on the robot, one ESP32 + Ra-02 as the
  gateway bridge.
- Each Ra-02 is driven by its own ESP32 over the module's SPI interface
  (plus its interrupt/reset lines). **The laptop never talks to the Ra-02
  directly**: it talks to the gateway ESP32 over USB serial, and the gateway
  ESP32 talks to the radio.
- Plain point-to-point LoRa, **not LoRaWAN**. No robot Wi-Fi or cellular.
- The radio link is **bidirectional**: robot → gateway carries telemetry
  (readings, status) and command reports; gateway → robot carries storage
  ACKs and, only if ever approved, manual commands.

### Unverified hardware details — do not assume

| Item | Known | Not verified / not chosen |
|---|---|---|
| Robot ESP32 | ESP32-WROOM-32 (CLAUDE.md) | GPIO / SPI pin assignment to the Ra-02. `PCB Schematic/` contains an ESP32 30-pin, an Arduino Nano and a Ra-02 symbol; its nets were **not** reviewed for Phase 3 |
| Gateway ESP32 | An ESP32 with a Ra-02, USB to laptop | Exact board/module, USB-UART chip and driver, pin assignment, power |
| Ra-02 radio settings | SX1278-based module | Frequency (must comply with Philippine NTC rules), spreading factor, bandwidth, coding rate, sync word, preamble, TX power, over-air CRC, implicit/explicit header (OPEN_ITEMS #18) |
| USB serial | — | Baud rate, flow control, whether the bridge resets when the port opens (OPEN_ITEMS #19) |
| Motors / pump / actuators | — | Specs, limits, drive interface. **None are encoded in software** (OPEN_ITEMS #22) |
| Emergency stop | — | Whether a physical E-stop exists, what it cuts, and how it is wired (OPEN_ITEMS #23) |
| Robot clock | — | GPS time or RTC (OPEN_ITEMS #8) |

## 2. USB serial contract v1 (laptop ⇄ gateway ESP32)

Source: `packages/shared/src/protocol/serial.ts`. Radio payloads pass through
as opaque bytes, so this contract does not depend on the LoRa byte layout.

### Framing

```
on the wire:   COBS( header | payload | crc16 )  0x00
```

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Serial protocol version (= 1). **Frozen at offset 0 in all versions** |
| 1 | 1 | Frame type |
| 2 | 2 | Frame id, uint16 little-endian. Per sender, wraps 0…0xFFFE; 0xFFFF is reserved for "unknown" |
| 4 | 2 | Payload length, uint16 LE |
| 6 | n | Payload |
| 6+n | 2 | CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over bytes 0…5+n, uint16 LE. **Frozen in all versions** |

- **COBS** byte stuffing removes every 0x00 from the frame, so 0x00 is a
  frame delimiter. A receiver that starts mid-stream, drops a byte, or sees
  noise resynchronises at the next 0x00. Repeated 0x00 bytes are ignored. The
  host sends one 0x00 when it opens the port to terminate any partial frame
  in the bridge's buffer.
- The CRC is checked **before** any header field is trusted. Because the
  version byte and the CRC never move, any receiver can detect a version
  mismatch reliably.
- Limits: payload ≤ 512 bytes; stuffed frame ≤ 523 bytes. A frame that grows
  past the limit without a delimiter is reported once as `OVERSIZED` and
  discarded up to the next 0x00, so memory use is bounded.

### Frame types

| Code | Type | Direction | Payload |
|---|---|---|---|
| 0x01 | `HELLO` | both, first frame after the port opens | role u8 (1 = host, 2 = bridge) + build id (printable ASCII, ≤ 32 bytes) |
| 0x02 | `PING` | host → bridge | empty. USB liveness only — says nothing about the radio |
| 0x03 | `PONG` | bridge → host | ref frame id u16 |
| 0x10 | `LORA_RX` | bridge → host | RSSI int16 dBm, SNR int16 (tenths of dB), bridge uptime uint32 ms, then the radio payload (1…255 bytes) |
| 0x11 | `LORA_TX` | host → bridge | radio payload (1…255 bytes). Transmit **once**; the bridge never retries on its own |
| 0x12 | `LORA_TX_RESULT` | bridge → host | ref frame id u16 (the `LORA_TX`), result u8: 0 `SENT`, 1 `CHANNEL_BUSY_RX`, 2 `RADIO_ERROR`, 3 `REJECTED_TOO_LARGE`, 4 `TX_TIMEOUT` |
| 0x20 | `BRIDGE_FAULT` | bridge → host | fault u8 (1 `RADIO_INIT_FAILED`, 2 `RADIO_RX_OVERFLOW`, 3 `SERIAL_RX_OVERFLOW`, 4 `RADIO_CRC_ERROR`) + count u16 |
| 0x7F | `FRAME_REJECTED` | both | ref frame id u16 (0xFFFF if unknown, e.g. bad CRC) + reason u8: 1 `BAD_CRC`, 2 `UNSUPPORTED_VERSION`, 3 `UNKNOWN_TYPE`, 4 `BAD_LENGTH`, 5 `MALFORMED_PAYLOAD`, 6 `OVERSIZED`, 7 `COBS_INVALID` |

All multi-byte integers are little-endian (native on the ESP32). Each payload
has an exact length rule; anything else is `MALFORMED_PAYLOAD`. The receiver
answers every undecodable frame with `FRAME_REJECTED` and keeps processing
the stream. A valid `FRAME_REJECTED` is never itself rejected, so the two
sides cannot loop.

**`SENT` means the radio transmitted the bytes — not that the robot received
them.**

### Port open / reconnection

On (re)open the host: discards any partial input, forgets in-flight
transmissions and the current response window (queued ACKs are kept), sends
0x00 + `HELLO`, and expects the bridge's `HELLO`. A `LORA_TX_RESULT` that
never arrives is abandoned after a timeout and the item is retried later;
only the latest `LORA_TX` is tracked, so a late result for an abandoned
attempt is ignored instead of settling the retransmission.

## 3. LoRa contract v1 (robot ⇄ gateway) — logical level

Source: `packages/shared/src/protocol/lora.ts`.

### Message kinds

| Kind | Direction | Retried by sender? | Acknowledged by |
|---|---|---|---|
| `READING` | robot → gateway | **Yes**, from flash, until a storage ACK releases it | `STORAGE_ACK` |
| `STATUS` | robot → gateway | No (once per cell) | nothing |
| `STORAGE_ACK` | gateway → robot | No — re-sent when the reading is retried | — |
| `MANUAL_COMMAND` | gateway → robot | Yes, until ACK, retry limit or expiry | `COMMAND_ACK` — **DISABLED (D21)** |
| `COMMAND_ACK` | robot → gateway | (only as an answer to a retransmission) | — |
| `COMMAND_STATUS` | robot → gateway | firmware to decide | — |

### Identifiers

- Envelope: `contractVersion` (= 1), `kind`, `robotId` (firmware robot id,
  opaque, ≤ 64 characters in the gateway), `messageId` (per-sender counter,
  **diagnostics only — not a dedupe key**).
- Readings are identified by **`(runId, cellIndex, seq)`**, the same key the
  SQLite store and Supabase use for idempotency.
- Manual commands are identified by **`commandSeq`**, strictly increasing
  per gateway and reused by retransmissions.

### Fields

| Kind | Fields (decoded values) |
|---|---|
| `READING` | runId, runType (from the verification flag), cellIndex, seq, attemptCount, pH, EC, moisture %, temperature °C, dose volume mL, expected post-correction pH (nullable), GPS fix (nullable), raw flags, robot-recorded time |
| `STATUS` | state code (0–6), error flags (8 bits), component flags (nullable, bit layout pending), battery voltage, total lime **commanded** mL, cells completed, total cells, robot-reported time |
| `STORAGE_ACK` | runId, cellIndex, seq, result: `STORED` · `DUPLICATE` · `CONFLICT_RECORDED` · `REJECTED` |
| `MANUAL_COMMAND` | commandSeq, ttlRemainingMs, command (`STOP`, `ENTER_MANUAL`, `EXIT_MANUAL`, `DRIVE{direction, durationMs}`) |
| `COMMAND_ACK` | commandSeq, disposition `ACCEPTED` · `DUPLICATE` · `REJECTED`, reject reason (exactly when rejected) |
| `COMMAND_STATUS` | commandSeq, execution `EXECUTING` · `COMPLETED` · `ABORTED` · `FAILED`, abort reason (exactly when aborted), robot-reported time |

### Validation and limits

- Radio payload: 1…**255 bytes** (SX1278 FIFO limit). The usable budget will
  be smaller once airtime settings are fixed (OPEN_ITEMS #18).
- Every decoded message is validated: version first (`VERSION_MISMATCH`),
  then kind (`UNKNOWN_KIND`), then all fields at once (`INVALID_FIELD`),
  then direction (`WRONG_DIRECTION`: e.g. a "robot" sending `STORAGE_ACK`).
  Checks are representational only — pH 0–14, moisture 0–100 %, valid
  coordinates, integer counters, 8-bit error flags, documented state codes,
  ISO-8601 UTC times. **No agronomic or calibration ranges are imposed.**
- Rejected packets are logged as events and **never stored or ACKed**.

### Codec boundary (where the byte layout will live)

`LoRaPayloadCodec` is the only place a byte layout may exist. Until the
firmware spec is signed off, `UNSIGNED_LORA_CODEC` throws
`PacketSpecNotSignedOffError` in both directions, so the gateway
deliberately cannot decode or send real packets. The simulator uses
`SimulationLoRaCodec` ("SIM" magic + an in-memory handle, `isWireFormat:
false`), which exercises every other layer without inventing offsets.
`assertHardwareCodec` rejects any codec with `isWireFormat: false`.
`BridgeProtocolSession` — the only producer of bytes for the serial port —
requires an explicit `link` option with no default; `link: 'hardware'`
calls `assertHardwareCodec` in the constructor, so a simulation codec is
refused before any byte can reach a port. The serial adapter (build-order item 8, D34) must
construct the session with `link: 'hardware'` (that adapter does not exist
yet). The simulation codec also refuses to register a `MANUAL_COMMAND`, so
it is no way around the gate.

The firmware owner must supply, per kind: field order, widths, scaling,
signedness, endianness, timestamp and identifier encodings, flag bits, and the
protocol-version field (OPEN_ITEMS #1, #9, #11).

## 4. Three acknowledgements — never conflated

| Fact | Evidence | Means | Does NOT mean |
|---|---|---|---|
| **Radio transmitted** | `LORA_TX_RESULT = SENT` from the bridge | The gateway radio put the bytes on air | The robot heard them |
| **Durably stored** | `STORAGE_ACK` (`STORED`/`DUPLICATE`/`CONFLICT_RECORDED`) | The gateway committed the reading to SQLite (`synchronous=FULL`) **before** sending the ACK | Cloud-synced (a separate outbox state) |
| **Command received** | `COMMAND_ACK` | The robot received the command and accepted/rejected it | That it ran |
| **Command executed** | `COMMAND_STATUS` | What physically happened, as the robot reports it | That lime/motion was independently measured |

### Reading flow (write before ACK)

```
robot: write reading to flash → transmit READING (attempt n)
bridge: LORA_RX → laptop
laptop: CRC/COBS ok → LoRa decode + validate → SQLite transaction commits
        → only then queue STORAGE_ACK → transmit in the robot's response window
robot: on STORED / DUPLICATE / CONFLICT_RECORDED → release from flash
       on REJECTED or no ACK → keep in flash, retry later
```

- SQLite failure (disk full, I/O error) → **no ACK** → robot retries.
- `handleUplink` refuses to run inside an already-open transaction (it would
  only write a savepoint, so an ACK could precede the real COMMIT) → no ACK.
  A test confirms the row is visible to a second connection when the ACK is
  emitted.
- Unknown robot → **silence** (it may be another radio on the channel).
- Run-type mismatch → `REJECTED` (nothing stored; robot keeps the record).
- Duplicates are answered `DUPLICATE` so a robot whose ACK was lost can
  release the record. Whether `CONFLICT_RECORDED` should release flash is
  OPEN_ITEMS #15.
- First-attempt delivery and post-retry completeness remain computable from
  `reading_receipts` (Phase 2) and are never merged.

### Duplicate suppression

| What | Key | Where |
|---|---|---|
| Reading | `(runId, cellIndex, seq)` | SQLite unique key + Supabase upsert (Phase 2) |
| Status | `(robot, robot time, state, cells completed)` | SQLite (Phase 2) |
| Storage ACK queued twice | `ack:robot:run:cell:seq` | Scheduler replaces in place |
| Manual command | `commandSeq` | Robot: equal → answer `DUPLICATE`, never re-execute; lower → `STALE_SEQUENCE` |
| Command reports | state machine | Gateway ignores repeats and state regressions |
| Serial frames | — | Not deduplicated (USB is ordered); frame ids correlate results only |

### Retries and timeouts

| Who | What | Rule | Value |
|---|---|---|---|
| Robot | Readings | Until a releasing ACK | interval/back-off: firmware (OPEN_ITEMS #20) |
| Robot | Status | Never | — |
| Bridge | Any `LORA_TX` | Never retries by itself | — |
| Gateway | `LORA_TX_RESULT` wait | Abandon after `txResultTimeoutMs`, retry at the next window | unconfirmed |
| Gateway | Storage ACK | Re-sent whenever the reading arrives again | — |
| Gateway | Manual command | Retransmit after `ackTimeoutMs`, at most `maxTransmissions`, never after expiry | unconfirmed; `COMMAND_TIMING = null` |

## 5. Half-duplex scheduling

Source: `packages/shared/src/protocol/radioScheduler.ts`. An SX1278 transmits
or receives, never both. **The robot initiates every exchange**: after each
uplink it listens for a response window; the gateway transmits only inside
that window and only one frame at a time (no `LORA_TX` while one is awaiting
its result). Priority: `STOP` > storage ACKs > other commands. Outside a
window the gateway stays silent with its receiver open. `CHANNEL_BUSY_RX`
keeps the item queued.

Consequence to confirm with the firmware owner: the window must be long
enough for the laptop's SQLite commit **plus** a USB round trip, and in
manual mode the robot must send uplinks often enough to open windows
(OPEN_ITEMS #20). All timing is `RADIO_SCHEDULE = null` (unconfirmed);
tests use clearly marked TEST-ONLY values.

## 6. Manual commands — SPECIFIED, NOT APPROVED

CLAUDE.md (locked) makes the apps **observe-only** and lists app-to-robot
downlink and app-initiated run control as out of scope. The Phase 3 brief
asked for a manual-command flow; the team chose to have it **specified and
tested but disabled** (D21). Therefore:

- The gate reads **only** the committed constant `MANUAL_COMMANDS_APPROVED =
  false`. No function takes an approval argument, so no caller can open it by
  constructing an object or passing a flag. `encodeLoRaMessage`,
  `CommandTracker.submit` and the scheduler's command priorities throw
  `ManualCommandsNotApprovedError` for every command, including `STOP`
  (guard test: `manualCommandGate.test.ts`, no mocks). Lifting it requires a
  reviewed commit changing that constant and the guard test, after D21's
  conditions are met. Simulation tests open it only via `vi.mock`.
- `MANUAL_COMMAND_LIMITS` (max drive duration, max TTL) and `COMMAND_TIMING`
  are `null`; any command depending on them is rejected `LIMIT_UNCONFIRMED`.
- The gateway session (`BridgeProtocolSession`) has **no code path** that
  sends a command: its queue is typed for storage ACKs, and its drain
  discards anything whose kind is not `STORAGE_ACK` before encoding. The local API exposes none. There is no UI.
- The unsigned codec cannot encode a command anyway.
- **No pump/dispense command exists.** A manual dose would be a dosing
  instruction from the app, which CLAUDE.md forbids outright; it would need
  its own decision.

### Lifecycle (gateway side, `commandTracker.ts`)

```
QUEUED ─SENT─► TRANSMITTED ─COMMAND_ACK─► ACCEPTED ─► EXECUTING ─► COMPLETED | ABORTED | FAILED
   │                │  └─retry after ackTimeout (same seq, smaller ttlRemaining)
   │                ├─► REJECTED (robot reason)
   │                ├─► UNCONFIRMED  (expired or retries exhausted; robot MAY have acted)
   │                └─► SUPERSEDED   (a STOP replaced it while unacknowledged)
   └─► EXPIRED_UNSENT (never left the gateway — certainly not executed)
ACCEPTED/EXECUTING ─silence─► NO_EXECUTION_REPORT (outcome unknown)
```

Unresolved states (`UNCONFIRMED`, `SUPERSEDED`, `NO_EXECUTION_REPORT`) can
still be resolved by a late robot report; nothing is ever shown as completed
without a `COMMAND_STATUS = COMPLETED`. Only one command may await
acknowledgement at a time; only `STOP` may supersede it.

### Expiry without synchronised clocks

The robot clock source is unconfirmed, so commands do not carry absolute
times. Each (re)transmission carries **`ttlRemainingMs`**, recomputed by the
gateway; the robot rejects `ttlRemainingMs ≤ 0`, never runs past it, and
rejects any `commandSeq` lower than the last one it saw. The gateway never
transmits an expired command. The tracker's next `commandSeq` must be
persisted so sequences stay increasing across a gateway restart (Phase 4/5).

## 7. Required robot behaviour (normative for the firmware)

These rules apply **if manual control is ever approved**; R1, R9 and R10
apply regardless. `apps/gateway/src/sim/simulatedRobot.ts` is an executable
reference model of them, tested in `simulatedRobot.test.ts`. It is not
firmware and drives no hardware.

| # | Rule |
|---|---|
| R1 | **Radio is never a safety system.** A radio `STOP` is a convenience, not an emergency stop. Safe stopping must not depend on the link, the laptop, or the app (physical E-stop: OPEN_ITEMS #23) |
| R2 | **Mode gate.** Motion commands are accepted only in `MANUAL` (state 6). `ENTER_MANUAL` is refused during an autonomous run (`WORKING`/`PAUSED`), during `INITIALIZING` (`MODE_CONFLICT`), and in `ERROR` (`FAULT_ACTIVE`). Commands never start, stop or alter an autonomous run (app-initiated run control is out of scope); whether a radio `STOP` should be honoured during an autonomous run is OPEN_ITEMS #24 |
| R3 | **Bounded motion.** Every `DRIVE` has a duration and stops by itself; it never runs past the command's remaining TTL |
| R4 | **Own limits.** The robot enforces its own limits and rejects anything depending on an unconfirmed limit; it never trusts the gateway's checks |
| R5 | **Communication loss (dead-man).** In manual mode, if no valid downlink arrives within the link-loss timeout, motion stops (`ABORTED: LINK_LOST`) |
| R6 | **No resume on reconnection.** After a link-loss stop, a reconnected link or a retransmitted old command does nothing; only a **new** `commandSeq` moves the robot |
| R7 | **Stale commands.** `ttlRemainingMs ≤ 0` → `EXPIRED`; `commandSeq` lower than the last seen → `STALE_SEQUENCE` |
| R8 | **Duplicates.** Same `commandSeq` → answer with the earlier decision (`DUPLICATE` or the same rejection); never execute twice |
| R9 | **Faults.** A motion-blocking fault stops motion (`ABORTED: FAULT`) and blocks new motion (`FAULT_ACTIVE`); `STOP` is always accepted in manual mode. The fault list is proposed (drive fault, battery critical, Nano link lost) |
| R10 | **Reboot.** After a power cycle the robot is out of manual mode, not moving, and has forgotten command sequences — so a late retransmission cannot move it |
| R11 | **Conflicting modes.** A newer `DRIVE` replaces the current one (`ABORTED: REPLACED`); `EXIT_MANUAL` stops motion first; an on-robot stop works without the radio |
| R12 | **Telemetry continues.** Readings stay in flash until acknowledged regardless of mode; a lost LoRa link alone is not a robot error |

### Passing these tests does not mean

- that any firmware implements these rules;
- that manual commands are approved or safe to enable;
- that any timing, limit, or radio setting is correct;
- that physical actuation has been tested. **Do not enable actuation because
  a software test passed.**

## 8. Code map

| File | Purpose |
|---|---|
| `packages/shared/src/protocol/crc16.ts`, `cobs.ts` | Checksum and byte stuffing |
| `packages/shared/src/protocol/serial.ts` | USB serial v1: encode/decode, streaming `SerialFrameReader`, frame ids |
| `packages/shared/src/protocol/lora.ts` | LoRa v1 logical messages, validator, codec boundary, unsigned placeholder |
| `packages/shared/src/protocol/manualCommands.ts` | Command set, approval gate (disabled), limits (unconfirmed), checks |
| `packages/shared/src/protocol/commandTracker.ts` | Gateway command lifecycle: retries, expiry, timeouts, supersede |
| `packages/shared/src/protocol/radioScheduler.ts` | Half-duplex response-window scheduler |
| `apps/gateway/src/protocol/uplink.ts` | Validated uplink → SQLite store → ACK draft (write before ACK) |
| `apps/gateway/src/protocol/bridgeSession.ts` | Serial bytes in → store/ACK → serial bytes out; no port, no timers |
| `apps/gateway/src/sim/` | SIMULATION-ONLY codec, synthetic run/bridge simulator, robot reference model |

Not in Phase 3: the `serialport` connection (build-order item 8, D34),
timers, persisted command sequence, LAN HTTP server and cloud worker
(Phase 4); any Manual Control UI
(Phase 5, and only if D21 is lifted); firmware.
