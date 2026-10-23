# Protocol v2 — Robot Status and Soil Status (PROPOSED)

> **Status: PROPOSAL ONLY. No implementation is authorised.**
> Protocol v1 (`docs/protocol.md`) is the only implemented contract.
> This document defines no byte layout, field offset, identifier, unit,
> checksum, timing value or ACK behaviour beyond what v1 specifies.
> No hardware, firmware, LoRa, USB-serial or robot testing has been
> performed. Existing behaviour cited here was verified only in software
> tests and simulation.

## Tags used in this document

- **[EXISTING]**: behaviour in the repository today, with its source.
- **[CONFIRMED DECISION]**: a protocol or data decision confirmed by the
  project lead.
- **[APPROVED SCOPE]**: a scope direction stated by the project lead.
- **[RECOMMENDED]**: a proposed design, not approved for implementation.
- **[UNRESOLVED]**: needs the firmware owner, a team decision or
  measurement. Tracked in `docs/OPEN_ITEMS.md` items 26 to 34.

## 1. Purpose

The project lead decided that a proposed six-flag error mapping requires
a new protocol version (v2). Protocol v1 flag meanings stay frozen, and
v1 packets and v1 records are never reinterpreted with the v2 table.
This document records the proposed v2 direction so that the firmware
owner and the team can confirm or correct it before any implementation.

"Soil Status" and "Robot Status" are descriptive names. The logical
message kinds remain `READING` (Soil Status) and `STATUS` (Robot
Status). This document does not rename them.

## 2. Decisions and scope for this semester

- **[CONFIRMED DECISION]** Soil Status retains `cellIndex` for reading
  identity and idempotency, using the existing logical key
  `(runId, cellIndex, seq)`.
- **[APPROVED SCOPE]** Excluded from this semester's application scope:
  field selection, cell maps, cell-progress counts (including
  `cellsCompleted` and `totalCells`) and cell-progress UI.
- **[APPROVED SCOPE]** Retaining `cellIndex` in the protocol and database
  identity does not authorise field selection, cell visualisation,
  progress tracking or progress UI. Completion is never inferred from
  received readings.
- **[APPROVED SCOPE]** The proposed six-flag mapping (section 5) belongs
  to v2 only. It is a proposal, not permission to implement it.
- **[APPROVED SCOPE]** The 3-second transmission interval is a temporary
  development target, not a hardware-validated timing requirement.
- **[APPROVED SCOPE]** The ESP32 bridge forwards the original LoRa
  application payload unchanged. The separate USB serial framing
  envelope remains (section 3).
- **[APPROVED SCOPE]** A successful reading ACK only follows a durable
  commit to the gateway SQLite database.
- **[APPROVED SCOPE]** No robot-control downlink or app-to-robot command
  routes are authorised. `MANUAL_COMMANDS_APPROVED` remains `false`
  (`packages/shared/src/protocol/manualCommands.ts:23`).

## 3. Existing v1 behaviour that v2 builds on

- **[EXISTING]** Every logical message carries `contractVersion`, fixed
  to 1. Any other value is rejected with `VERSION_MISMATCH`.
  Source: `packages/shared/src/protocol/lora.ts` lines 27, 52-58 and
  283-289.
- **[EXISTING]** The on-air byte layout, including where the version is
  carried, is not defined, and no authoritative on-air specification
  exists in the repository. The current codec is a placeholder that
  refuses every real payload. Source: `lora.ts` lines 6-9, 397-399 and
  432-441; OPEN_ITEMS item 1.
- **[EXISTING]** `READING` is defined at `lora.ts` lines 60-78 and
  `STATUS` at `lora.ts` lines 80-91.
- **[EXISTING]** Readings are unique on `(run_id, cell_index, seq)`
  (`apps/gateway/migrations/0001_initial.sql` line 108). Each reading is
  written in one transaction, and a `STORAGE_ACK` is queued only after
  that transaction commits. A failed write produces no ACK. Source:
  `apps/gateway/src/protocol/uplink.ts` lines 102-108 and
  `apps/gateway/src/protocol/bridgeSession.ts` lines 178-189. Verified
  in software tests and simulation only, not on hardware.
- **[EXISTING]** Status is never acknowledged and never retried
  (`lora.ts` line 80). Each v1 status is stored as an immutable row
  keyed on `(robot_id, robot_reported_at, state, cells_completed)`
  (`0001_initial.sql` line 149). The v1 status served to clients is the
  row with the latest robot-side time (`0001_initial.sql` lines 159-166;
  `apps/gateway/src/store/status.ts` lines 96-101).
- **[EXISTING]** Stored records carry no protocol version. Error-flag
  values are stored as raw integers and decoded at read time with the v1
  table (`packages/shared/src/format/robotState.ts` lines 17-20;
  `status.ts` line 82).
- **[EXISTING]** In the proposed USB serial contract, the gateway ESP32
  carries each radio payload as opaque bytes inside a separate serial
  frame with its own header and CRC
  (`packages/shared/src/protocol/serial.ts` lines 7-11 and 89). That
  serial contract is itself proposed, and no bridge firmware exists in
  the repository (OPEN_ITEMS item 19). The serial frame has its own
  version byte (`serial.ts` lines 14 and 28), which versions only the
  USB framing and must not carry the LoRa protocol version.

## 4. Proposed v2 logical contract

### 4.1 Envelope

- Fields: `contractVersion` equal to 2, `robotId`, `messageId`.
- **[UNRESOLVED]** The on-air representation of the version (item 26).
  **[RECOMMENDED]** A version field at a position that never moves in
  any future version, read before the rest of the payload. No position,
  width or encoding is assumed.
- **[UNRESOLVED]** Whether `messageId` exists on air, and its semantics
  (items 1 and 29). In v1 it is documented as a diagnostic counter that
  is not a deduplication key (`lora.ts` lines 56-57).

### 4.2 Robot Status (`STATUS`, robot to gateway)

- Proposed fields: `stateCode` (the existing codes 0 to 6),
  `errorFlags` (8-bit, proposed v2 table in section 5),
  `componentFlags` (section 6), `batteryVoltage`,
  `totalLimeCommandedMl` and `robotReportedAt`.
- `totalLimeCommandedMl` is the robot's commanded volume, not a
  measurement of lime actually delivered.
- **[APPROVED SCOPE]** `cellsCompleted` and `totalCells` are not part
  of v2.
- **[RECOMMENDED]** Keep the v1 status delivery semantics unchanged:
  not acknowledged and not retried.
- **[RECOMMENDED]** In principle, a genuinely new status snapshot should
  not be silently discarded.
- **[UNRESOLVED]** How v2 status snapshots are identified,
  deduplicated, stored and retained, and which snapshot clients are
  shown (section 8, item 29). No v2 storage or display policy is
  settled.
- Transmission cadence is robot-side and configurable, with a temporary
  development target of 3 seconds (section 11).
- Battery level and battery health remain undefined (OPEN_ITEMS
  item 10).

### 4.3 Soil Status (`READING`, robot to gateway)

- The logical reading fields and the existing identity contract are
  unchanged from v1 (`lora.ts` lines 60-78). This does not define a
  physical or on-air byte layout, which remains unspecified (items 1
  and 26).
- **[CONFIRMED DECISION]** `cellIndex` is retained for reading identity
  and idempotency, using `(runId, cellIndex, seq)`.
- A reading is sent only for genuine completed-cell data. A timer never
  creates, repeats or fabricates a reading.
- Each reading is kept in robot flash until a releasing `STORAGE_ACK`
  arrives, and is retransmitted exactly as originally encoded.
- A successful ACK only follows a durable commit to gateway SQLite.

### 4.4 Storage acknowledgement (`STORAGE_ACK`, gateway to robot)

- The logical fields and result meanings are unchanged from v1
  (`lora.ts` lines 93-109).
- **[UNRESOLVED]** On-air ACK format, return routing, compatibility
  with buffered v1 readings, and rejection and conflict handling
  (section 10, item 31).

### 4.5 Excluded

- All manual-command and robot-control message kinds, and any
  app-to-robot command route.

## 5. Error flags: v1 (frozen) and proposed v2

| Bit | v1 (frozen, CLAUDE.md section 4) | v2 (proposed) |
|---:|---|---|
| 0 | `LIME_EMPTY` | `LIME_EMPTY` |
| 1 | `BATTERY_CRITICAL` | `BATTERY_CRITICAL` |
| 2 | `PROBE_FAULT` | `PROBE_FAULT` (see note) |
| 3 | `GPS_NO_FIX` | `GPS_NO_FIX` |
| 4 | `PUMP_FAULT` | `NANO_LINK_LOST` |
| 5 | `DRIVE_FAULT` | `COMMUNICATION_LOST` (section 9) |
| 6 | `NANO_LINK_LOST` | reserved |
| 7 | `STORAGE_FAULT` | reserved |

Source for the v1 table: `packages/shared/src/domain/robot.ts`
lines 21-31.

Note: in v2, `PROBE_FAULT` is proposed to cover a soil pH probe,
ultrasonic sensor or other sensor fault. Which sensors are included is
unresolved (section 13, item 32).

- v2 removes the dedicated `PUMP_FAULT`, `DRIVE_FAULT` and
  `STORAGE_FAULT` bits that exist in v1 (section 6).
- **[APPROVED SCOPE]** Flags are decoded only with the table of the
  record's own version. v1 meanings are never changed, and v1 records
  are never reinterpreted with v2 meanings.
- **[RECOMMENDED]** Preserve the raw flag value. When reserved bits are
  set, record an "unknown bits" diagnostic instead of discarding the
  status, where safe validation permits.
- **[UNRESOLVED]** Confirmation of the v2 table, and that reserved bits
  6 and 7 are always sent as 0 (item 27).

## 6. Pump, drive and storage faults in v2

The proposed v2 table has no dedicated pump, drive or storage bits.
These signals carry safety and diagnostic value. A pump fault means the
commanded lime volume may not have been delivered. A storage fault
threatens the flash buffer that holds unacknowledged readings.

- **[EXISTING]** The status message already has a component-status
  field (`lora.ts` line 85). Its component list includes `PUMP`,
  `DRIVE_MOTORS` and `FLASH_STORAGE` (`robot.ts` lines 40-49). Its bit
  layout is not specified, so the gateway reports every component as
  `unknown` (`status.ts` lines 73-75; OPEN_ITEMS item 9).
- **[RECOMMENDED]** Investigate retaining these conditions through the
  existing component-status field. No spare packet capacity is assumed.
- **[UNRESOLVED]** The component encoding, and whether the field
  reports current runtime faults rather than only a boot-time
  self-check (item 28). Until that is confirmed, the component field is
  not claimed to replace the v1 pump, drive and storage bits. If it
  reports only a boot-time self-check, a separately versioned fault
  field would be needed, and only if the firmware owner confirms that
  the packet has capacity for it.

## 7. Versioning, compatibility and unsupported versions

Every item in this section is a proposal. None is implemented.

- **[RECOMMENDED]** The gateway accepts v1 and v2 side by side, because
  the robot may still hold v1 readings in flash after a firmware
  upgrade.
- **[RECOMMENDED]** Store `contractVersion` with every local and cloud
  record, with existing records identified as v1. This is a proposed
  schema design only. No versioned schema or migration exists, none is
  created by this document, and applied migrations are never edited.
- **[RECOMMENDED]** Reject unsupported versions before any other field
  is parsed: store nothing, send no ACK so that the robot keeps the
  record, and raise an operator-visible diagnostic. This matches the
  existing v1 `VERSION_MISMATCH` behaviour (`lora.ts` lines 283-289).

## 8. Status snapshots and duplicate retransmissions

- A periodic snapshot is new information. A duplicate retransmission is
  the same packet received more than once. They need different
  treatment.
- **[EXISTING]** The v1 key `(robot_id, robot_reported_at, state,
  cells_completed)` treats a second report with the same key as a
  duplicate and ignores it, even if other values differ
  (`0001_initial.sql` line 149; `docs/local-gateway.md`, section
  "Identity and idempotency"). The v1 status shown to clients is the
  latest by robot-side time (`0001_initial.sql` lines 159-166).
- **[UNRESOLVED]** v2 status identity, deduplication, retention and
  client display (item 29). These remain open pending a documented
  decision. Candidate approaches, none adopted:
  - A key that includes a hash of the decoded contents. It needs no new
    field, but it cannot distinguish a repeated identical snapshot from
    a genuinely new snapshot with identical contents, so it would
    collapse them into one. It is not a definitive solution.
  - A firmware-provided packet counter. It could identify duplicates
    exactly, but only if the firmware owner confirms that one exists on
    air and how it behaves across reboots.
- No sequence or counter field is assumed by this document.

## 9. Communication loss: two separate observations

1. **Robot-reported communication-loss history.** `COMMUNICATION_LOST`,
   proposed v2 bit 5, is a robot-reported indication. Its precise
   trigger, its setting and clearing rules, and its relationship to
   communication recovery are unresolved. While the link is unavailable
   the robot cannot deliver any LoRa message, so this indication can
   only reach the gateway after communication recovers. It is a record
   of past loss, not a live alarm, and it is not an ERROR state.
   `CLAUDE.md` section 4 states that a lost LoRa link alone is not a
   robot error (`CLAUDE.md` line 124).
2. **Gateway-observed last-heard time and connection freshness.** This
   is the time since the gateway last received any valid packet. It is
   a separate observation made by the gateway. It is not implemented
   today as a finalised live alarm: no gateway last-heard tracking
   exists, and the only freshness logic is the age of the latest
   status. It is never shown as a robot error.

- **[UNRESOLVED]** The robot's trigger for bit 5 and its rules for
  setting and clearing it, and any gateway no-contact threshold
  (item 30). No ACK timeout or stale threshold is defined here. The
  current 240-second staleness value is provisional
  (`packages/shared/src/config.ts` line 17; OPEN_ITEMS item 3).

## 10. ACK contract and version compatibility

- **[EXISTING]** `STORAGE_ACK` carries the addressed `robotId`, `runId`,
  `cellIndex`, `seq` and a result. The results `STORED`, `DUPLICATE`
  and `CONFLICT_RECORDED` let the robot release the record from flash;
  `REJECTED` does not (`lora.ts` lines 93-109). It is queued only after
  the commit (`bridgeSession.ts` lines 178-189) and transmitted only in
  the response window after an uplink
  (`packages/shared/src/protocol/radioScheduler.ts` lines 81-94). The
  bridge reports only that a packet left the antenna, not that it was
  received (`serial.ts` lines 53-55). Verified in software tests and
  simulation only.
- **[EXISTING]** Response-window timing is not configured:
  `RADIO_SCHEDULE` is `null` (`radioScheduler.ts` line 29; OPEN_ITEMS
  item 20).
- **[UNRESOLVED]** (item 31):
  - the on-air ACK format, and whether it differs between versions;
  - whether v2 firmware accepts ACKs for v1 readings still in flash;
  - how the robot matches an ACK to a stored record;
  - on-air addressing and return routing;
  - receive-window timing (OPEN_ITEMS item 20);
  - the policy for `REJECTED` and `CONFLICT_RECORDED` (OPEN_ITEMS
    item 15).

## 11. Timing: temporary 3-second development target

Five quantities that must not be conflated:

1. sensor sampling frequency;
2. Robot Status transmission frequency;
3. Soil Status (completed-cell) availability;
4. Soil Status transmission frequency;
5. ACK, retry and buffering behaviour.

- **[RECOMMENDED]** A completed reading that becomes available between
  ticks is queued in flash and sent at the next transmit opportunity,
  oldest unacknowledged reading first, ahead of status.
- **[UNRESOLVED]** Feasibility of the 3-second target (item 33):
  airtime per packet, duty-cycle limits, receive-window timing, loss
  rate at field distances, flash backlog capacity, time per cell, USB
  baud rate and robot clock source. Hardware feasibility is not
  claimed.

## 12. Local API

- **[EXISTING]** `RobotStatus` requires `cellsCompleted` and
  `totalCells` and lists error flags by v1 name
  (`packages/shared/src/domain/robot.ts` lines 60-74;
  `packages/shared/src/api/v1.ts` lines 78-82). No application code
  consumes the API yet.
- **[RECOMMENDED]** Extend the existing local API additively: add
  `protocolVersion`, the raw flag value and version-specific flag
  names, with cell fields present only for v1 records, provided that
  backward compatibility can be maintained for existing v1 records and
  for any client that exists by then. No API extension exists, and none
  is authorised by this document.

## 13. Components

- **[EXISTING]** Supported components: `SOIL_PROBE`, `GPS`, `PUMP`,
  `DRIVE_MOTORS`, `NANO_LINK`, `LORA_RADIO`, `FLASH_STORAGE` and
  `BATTERY_SENSOR` (`robot.ts` lines 40-49).
- **[UNRESOLVED]** The ultrasonic sensor, and any separate probe
  channels for pH, EC, moisture or temperature, remain unassigned until
  confirmed (item 32).

## 14. Work this design would require (proposed, not authorised)

- Robot firmware.
- Gateway ingest and storage, including any dual-version ingestion.
- Shared protocol and domain types.
- Local and cloud schemas, including any version persistence, using new
  migrations only.
- Cloud row mapping and generated types.
- Local API.
- App monitoring strip.
- Tests and simulator.
- Formal requirements and protocol approval, including an amendment to
  `CLAUDE.md` section 4 by team decision (item 34).

None of this work exists or is authorised. The ESP32 bridge needs no
versioning change as long as it forwards the LoRa payload unchanged.

## 15. What this document does not do

- It changes no code, schema, migration, test, simulator or app file.
- It does not change, or authorise changes to, `CLAUDE.md`.
- It defines no bytes, offsets, identifiers, units, checksums, baud
  rates, radio timing, frequencies, sensor mappings or ACK behaviour
  beyond v1.
- It enables no robot-control path.
