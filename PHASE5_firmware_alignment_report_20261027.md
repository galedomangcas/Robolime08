# RoboLime Phase 5 — firmware alignment report, 2026-10-27

## 1. Verdict
**BLOCKED — AUTHORITATIVE FIRMWARE/PROTOCOL UNAVAILABLE** (for robot integration).

The firmware itself was available and was read in full. It defines **no
telemetry protocol**: the robot sends nothing over LoRa, takes no soil
readings, and implements no ACK or buffering. There is nothing to align a
decoder with. No software mismatch required a code correction: the app and
gateway handle synthetic data only, and the unsigned codec refuses real
payloads. Two regression tests and documentation were added.

- **Local-field software scope (Phase 5, proposed D43):** implemented as
  reported in `PHASE5_report_20261027.md`; still subject to the owner
  decisions listed there.
- **Real robot integration:** **not verified, and not possible** with the
  current firmware.

## 2. Repository and firmware inspected
| Item | Value |
|---|---|
| Directory / branch | `C:\Users\doman\Documents\GitHub\Robolime`, `main` |
| Local HEAD | `3e37db49c632b3ba9a4b353c815ce79cec1f5df1` (plus uncommitted Phase 4/5 work) |
| Remote | `https://github.com/ginoomapayapa/Robolime.git` (no embedded credentials) |
| Remote `main` | `432d5b32de6c5d5de5d4836fa99d95a4477ed016`, confirmed with `git ls-remote` (read-only); the same as the local `origin/main` ref |
| Firmware location | `Robot Code/Final Code/` exists **only on `origin/main`**, not in the local checkout. Read with `git show origin/main:<path>` (no fetch, pull, merge or checkout) |
| Branch state | **Diverged.** Merge base `93c616d` (2026-10-25). `origin/main` = 7 web-upload commits by `ginoomapayapa` (2026-10-27 19:38–19:41) adding the firmware; it lacks the local Phase 1–4 commits (`3e37db4` and earlier unpushed work). Reconciling them needs an explicit decision (merge or rebase, then push) |

| File (at `432d5b3`) | Bytes | Git blob | SHA-256 | Board (from code) |
|---|---|---|---|---|
| `Robot Code/Final Code/finalcode_sprint1_esp.ino` | 10,411 | `c56d0ce` | `420873f9…372d` | ESP32 (`Serial2.begin(…, RXD2, TXD2)` with pin arguments, 12-bit ADC 4095, `LoRa.h`) |
| `Robot Code/Final Code/finalcode_sprint1_nano.ino` | 3,059 | `7417af1` | `30404020…fd4f` | Arduino Nano (comment "RX = D5, TX = D6", `SoftwareSerial`, Serial on pins 0/1) |
| `Robot Code/Test Cases/SPRINT_1_Gateway.ino` | 1,960 | `3d5528e` | `ac0ab75d…9782` | ESP32 receiver test (`LoRa.h`); identical locally and on the remote |

There are no `.cpp`, `.h`, configuration or README files.

## 3. Firmware findings (directly verified unless marked)
**`finalcode_sprint1_esp.ino` (robot ESP32)**
- 1–3: uses the Sandeep Mistry `LoRa`, `SPI` and `TinyGPSPlus` libraries.
- 21, 68–75: LoRa at **915 MHz**, put in receive mode. No spreading factor,
  bandwidth, sync word or TX power is set, so library defaults apply
  (inferred from the absence of those calls).
- 145–153: received packets are only **printed** to USB serial. There is no
  `beginPacket` anywhere, so **nothing is transmitted**.
- 99–118, 177–278: a USB-serial **interactive menu** drives two BTS7960 motor
  drivers (PWM 0–255, forward, reverse, left, right, stop). Typed
  `ACTUATOR_EXTEND|ACTUATOR_RETRACT|PUMP_ON|PUMP_OFF|STOP_ALL` text is
  forwarded to the Nano (109–113).
- 123–131: Nano lines are printed and set `uartHandshakeSuccess` (never read
  afterwards). It **never sends `ESP32_ACK`**.
- 136–140: GPS bytes are fed to TinyGPSPlus, but no fix, latitude or longitude
  is ever read.
- 158–172: every 5 s it prints battery voltage = ADC/4095 × 3.3 × 4.0 (24–25),
  motion state and PWM to USB serial only.
- **Absent:** soil probe, pH, EC, moisture, temperature; robot states 0–6;
  error and component flags; run ID, cell index, sequence, attempt count;
  flash storage or retention; dosing logic, commanded lime and expected
  post-correction pH; timestamps or RTC; ACK handling; retries.

**`finalcode_sprint1_nano.ino` (Nano)**
- 4, 22: `SoftwareSerial` at 9600 on D5/D6.
- 7–10: L298N outputs for a linear actuator (IN1/IN2) and a diaphragm pump
  (IN3/IN4).
- 36–42: sends `NANO_READY` every 2 s until `ESP32_ACK` arrives (49–51). Since
  the ESP32 never sends it, this repeats forever (inferred by combining both
  files).
- 75–103: executes the text commands, and also accepts `STOP`. Pump control is
  on/off only, with no volume or timing.

**`SPRINT_1_Gateway.ino` (receiver test)**
- 12, 18: USB serial at 115200; LoRa at **433 MHz**.
- 28–39: sends `GET_ROBOT_STATUS` over LoRa every 3 s (the D38 basis), and
  each time prints a **hard-coded** sample line
  `[Robolime] MSG:ROBOT_STATUS,STATE:ACTIVE,ERR:0,BATTERY:88,TOTAL_LIME:120.5,TS:1771920000`
  (34).
- 42–55: forwards any typed text over LoRa, and prints a hard-coded
  `MSG:SOIL_STATUS,…` sample (49).
- 58–68: received packets are printed as text.

## 4. Telemetry / protocol table
| Field | Type / units / scaling | Source | Confidence |
|---|---|---|---|
| Any robot→receiver telemetry | none transmitted | `esp.ino` (no `beginPacket`) | **Verified absent** |
| Receiver→robot request `GET_ROBOT_STATUS` | ASCII text over LoRa, no delimiter, CRC or version | `SPRINT_1_Gateway.ino` 32–38 | Verified sent; the robot does not answer it (verified: it only prints, `esp.ino` 145–153) |
| `MSG:ROBOT_STATUS` / `MSG:SOIL_STATUS` fields | text `KEY:value` | `SPRINT_1_Gateway.ino` 34, 49 | **Hard-coded sample strings, not data.** Units unknown (`BATTERY:88` may be a percentage; `STATE:ACTIVE` is not one of the 7 documented states) |
| Battery voltage | volts, ADC × 3.3/4095 × 4.0 | `esp.ino` 24–25, 162–164 | Verified formula; divider ratio and accuracy **need hardware verification**; USB serial only |
| LoRa frequency | 915 MHz (robot) vs 433 MHz (receiver) | `esp.ino` 21; `Gateway.ino` 18 | Verified mismatch; the documented Ra-02/SX1278 parts are 433 MHz-band. **Hardware verification required** |
| ESP32↔Nano link | 9600 baud ASCII lines | `esp.ino` 60; `nano.ino` 22 | Verified; handshake incomplete |
| ACK, retries, deduplication, persistence, `(runId, cellIndex, seq)` | — | — | **Not implemented in firmware** |

## 5. Comparison with the software
| Software assumption | Firmware reality | Classification |
|---|---|---|
| Binary LoRa v1 readings and status (`packages/shared/src/protocol/lora.ts`, codec unsigned) | No telemetry exists | Firmware change required (OPEN_ITEMS #1, #42); codec gate kept closed |
| USB serial v1, COBS + CRC (D22; `serial.ts`) | Receiver prints text at 115200 | Specification decision required (D22 vs D37, #35). The existing reader already yields **no frame** from this text; a test now pins that |
| Write-before-ACK; robot retains readings until ACK | No ACK, no flash retention | Firmware change required; hardware verification afterwards |
| Robot-initiated windows (D24) vs 3 s polling (D38) | The receiver polls; the robot ignores the poll | Specification decision required (#36–#37) |
| Robot states 0–6, error/component flags | Absent (only a motion string) | Firmware change required (#9, #27–#28) |
| pH, EC, moisture, temperature, dose, expected post-correction pH | Absent | Firmware change required; EC unit (#7) still open |
| App observe-only | The app has no command path. The robot is driven by a USB-serial menu on the robot ESP32, and the receiver sketch can forward typed text over LoRa (which the robot only prints) | Compliant in software; robot-side command handling is a firmware/team decision (D21, #21) |
| Radio frequency | 915 vs 433 MHz | Hardware verification required (#41, #18) |
| Phase 5 Results/status UI | Shows gateway-stored (currently synthetic) data, with synthetic labels | No mismatch: nothing displayed claims to come from this firmware |

`cellIndex` stays in reading identity per D29. The firmware neither confirms
nor contradicts it, because it produces no records.

## 6. Changed files (uncommitted)
| Path | Change | SHA-256 |
|---|---|---|
| `packages/shared/src/protocol/serial.test.ts` | +2 tests: the receiver sketch's exact text output yields no serial v1 frame, only bounded OVERSIZED errors; each line is rejected even when 0x00-delimited | `c0b0bd5a…b8de` |
| `apps/mobile/src/data/gatewayClient.test.ts` | +1 test: only `pair` is a POST; every other call is a bodiless GET; no command/control/dose/motor/pump route | `460f78b8…0c29` |
| `apps/mobile/src/data/dataSource.test.ts` (new) | The local data source exposes read methods only | `d77dad84…8725` |
| `docs/OPEN_ITEMS.md` | New rows #41–#43 | `b0d74fed…90de` |
| `docs/decisions.md` | New D44 (findings) | `d572b3bf…2259` |
| `PHASE5_firmware_alignment_report_20261027.md` (new) | This report | — |

No production code, firmware, protocol definition, dependency or lockfile
changed. Nothing under `Robot Code/`, `Website/` or `PCB Schematic/` was
touched.

## 7. Commands and observed results (2026-10-27)
| Command | Exit | Result |
|---|---|---|
| `git ls-remote origin refs/heads/main HEAD` | 0 | `432d5b3…` for both |
| `npx vitest run src/protocol/serial.test.ts --root packages/shared` | 0 | 35 passed |
| `npx jest src/data` (apps/mobile) | 0 | 91 passed |
| `npm run typecheck` | 0 | 0 errors |
| `npm run lint` | 0 | 0 errors, 1 pre-existing warning (`config.ts:117`) |
| `npm run test -w @robolime/gateway` | 0 | 522 passed, 15 skipped |
| `npm run test -w @robolime/shared` | 0 | 129 passed (was 127) |
| `npm run test -w @robolime/mobile`, 6 runs | 1 of 6 failed | Run 1, straight after the gateway suite: 3 failed / 111 passed. The other 5 runs passed 114/114. **Intermittent failure, not yet identified**; also seen in the Phase 5 review, affecting pre-existing suites too |
| `git diff --check` | 0 | clean |

Not run: `npm run build:web` (no app source changed since the last export),
any hardware, serial, radio, flashing, or hosted service.

## 8. Remaining decisions and hardware verification
| # | Owner | Needed |
|---|---|---|
| 1 | Firmware | Implement robot telemetry (readings and status), run/cell/sequence identity, flash retention and ACK handling; then sign off a byte or text layout (OPEN_ITEMS #1, #42) |
| 2 | Team + firmware | Choose the USB contract (D22 vs D37, #35) and the scheduling model (D24 vs D38, #36–#37) |
| 3 | Hardware | Confirm the radio module and band; make both sides use one NTC-compliant frequency (#41, #18) |
| 4 | Firmware | Complete the ESP32→Nano `ESP32_ACK` handshake; define component checks (#43, #9) |
| 5 | Hardware | Measure the battery divider and accuracy; define battery health (#43, #10) |
| 6 | Team | Decide whether the USB-serial motor menu and the receiver's text forwarding stay in field firmware (observe-only rule, D21) |
| 7 | Team | Reconcile the diverged `main` branches (merge or rebase, then push) before any further firmware or app work lands on GitHub |
| 8 | Hardware | After 1–5: the physical robot → receiver → USB → gateway test, write-before-ACK on the wire, and the WAN-disconnected field run (checklist rows 12–13) |

## 9. Git status
Nothing was staged, committed, pushed, pulled, merged, fetched, flashed or
deployed. No serial port was opened, and no hosted service, container,
volume or network was touched.
