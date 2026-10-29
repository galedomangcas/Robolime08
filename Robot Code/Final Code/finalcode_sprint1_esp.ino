#include <SPI.h>
#include <LoRa.h>           // Sandeep Mistry LoRa Library
#include <TinyGPSPlus.h>

// --- UART Configuration (ESP32 <-> Nano for Actuator & Pump) ---
#define RXD2 4   
#define TXD2 15  

// --- GPS Module Configuration ---
const int GPS_RX_PIN = 17;   
const int GPS_TX_PIN = 16;   
const uint32_t GPS_BAUD = 9600;

// --- LoRa Pins (Sandeep Mistry) ---
const int LORA_SCK  = 18;
const int LORA_MISO = 19;
const int LORA_MOSI = 23;
const int LORA_SS   = 5;     
const int LORA_RST  = 14;    
const int LORA_DIO0 = 2;     
// Was 915E6. Set to 433E6 to match the gateway bridge and the documented
// Ra-02 (SX1278, 433 MHz band) modules (D57, OPEN_ITEMS #41). MUST MATCH
// finalcode_sprint1_gateway.ino; the hardware owner must confirm the band.
const long LORA_FREQUENCY = 433E6;

// --- Battery Voltage Monitoring Pin ---
const int BATTERY_PIN = 35;           
const float VOLTAGE_MULTIPLIER = 4.0;  

// --- Dual BTS7960 Pin Configuration ---
// Left Driver Module
const int LEFT_EN   = 32;
const int LEFT_RPWM = 13;
const int LEFT_LPWM = 12;

// Right Driver Module
const int RIGHT_EN  = 25;
const int RIGHT_RPWM = 27;
const int RIGHT_LPWM = 26;

// --- Manual control over LoRa (app "Manual control of RoboLime", decision D57) ---
// Every output started by a LoRa command stops by itself after this long,
// even if the STOP never arrives (lost packet, out of range, laptop closed).
// Chosen by the project owner; the hardware owner must confirm it.
const unsigned long MANUAL_AUTO_STOP_MS = 5000;
unsigned long motorStopAt = 0;     // 0 = no pending auto-stop
unsigned long pumpStopAt = 0;
unsigned long actuatorStopAt = 0;

TinyGPSPlus gps;

unsigned long gpsByteCount = 0;
bool uartHandshakeSuccess = false;

// Menu state machine variables
enum MenuState { STATE_MAIN_MENU, STATE_GET_PWM, STATE_GET_DIRECTION, STATE_ACTIVE_MOTION };
MenuState currentMenuState = STATE_MAIN_MENU;
int selectedPwm = 127; // Default PWM
String currentMotionState = "STOPPED";

void setup() {
  // USB Debug Monitor
  Serial.begin(9600);
  while (!Serial);
  delay(1000);

  Serial.println("\n========================================");
  Serial.println("  ESP32 MASTER SYSTEM INITIALIZATION    ");
  Serial.println("========================================");

  // 1. UART Init (for Nano Actuator/Pump control)
  Serial2.begin(9600, SERIAL_8N1, RXD2, TXD2);
  Serial.println("=== UART Ready (ESP32 to Nano) ===");

  // 2. GPS Init
  Serial1.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("=== GPS Serial Active ===");

  // 3. LoRa Init
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_SS);
  LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQUENCY)) {
    Serial.println("LoRa Initialization Failed!");
  } else {
    Serial.println("LoRa Initialized Successfully.");
    LoRa.receive(); 
  }

  // 4. Battery Pin Init
  pinMode(BATTERY_PIN, INPUT);

  // 5. Dual BTS7960 Motor Pins Init
  pinMode(LEFT_EN, OUTPUT);
  pinMode(LEFT_RPWM, OUTPUT);
  pinMode(LEFT_LPWM, OUTPUT);

  pinMode(RIGHT_EN, OUTPUT);
  pinMode(RIGHT_RPWM, OUTPUT);
  pinMode(RIGHT_LPWM, OUTPUT);

  digitalWrite(LEFT_EN, HIGH);
  digitalWrite(RIGHT_EN, HIGH);
  stopMotors();

  Serial.println("========================================");
  Serial.println("      SYSTEM READY - MAIN MENU          ");
  Serial.println("========================================\n");
  printMainMenu();
}

void loop() {
  // =========================================================================
  // 1. Interactive Serial Menu Parser
  // =========================================================================
  if (Serial.available()) {
    String input = Serial.readStringUntil('\n');
    input.trim();

    if (input.length() > 0) {
      // Check if user is typing Nano actuator/pump commands directly
      if (input == "ACTUATOR_EXTEND" || input == "ACTUATOR_RETRACT" || 
          input == "PUMP_ON" || input == "PUMP_OFF" || input == "STOP_ALL") {
        Serial2.println(input);
        Serial.print("You (ESP32) -> Sent to Nano: ");
        Serial.println(input);
      } else {
        handleMenuInput(input);
      }
    }
  }

  // =========================================================================
  // 2. UART Communication Check (Incoming from Nano)
  // =========================================================================
  if (Serial2.available()) {
    String incoming = Serial2.readStringUntil('\n');
    incoming.trim();
    if (incoming.length() > 0) {
      uartHandshakeSuccess = true;
      Serial.print("Nano says <- ");
      Serial.println(incoming);
      if (incoming == "NANO_READY") {
        Serial2.println("ESP32_ACK");  // completes the Nano's handshake so it stops pinging
      }
    }
  }

  // =========================================================================
  // 3. GPS Data Stream Processing
  // =========================================================================
  while (Serial1.available() > 0) {
    char c = Serial1.read();
    gpsByteCount++;
    gps.encode(c);
  }

  // =========================================================================
  // 4. LoRa Packet Listener
  // =========================================================================
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String loraPacket = "";
    while (LoRa.available()) {
      loraPacket += (char)LoRa.read();
    }
    loraPacket.trim();
    Serial.print("\n[LoRa RX] Content: ");
    Serial.println(loraPacket);
    handleLoRaPacket(loraPacket);
  }

  // =========================================================================
  // 4b. Manual-control auto-stop (MANUAL_AUTO_STOP_MS)
  // =========================================================================
  checkAutoStop();

  // =========================================================================
  // 5. Periodic Status Prints (Every 5 seconds)
  // =========================================================================
  static unsigned long lastPeriodicCheck = 0;
  if (millis() - lastPeriodicCheck > 5000) {
    lastPeriodicCheck = millis();

    int adcValue = analogRead(BATTERY_PIN);
    float pinVoltage = (adcValue / 4095.0) * 3.3;
    float batteryVoltage = pinVoltage * VOLTAGE_MULTIPLIER;

    Serial.print("[STATUS] Battery: ");
    Serial.print(batteryVoltage, 2);
    Serial.print("V | Motion: ");
    Serial.print(currentMotionState);
    Serial.print(" | PWM: ");
    Serial.println(selectedPwm);
  }

  delay(10);
}

// --- Interactive Menu Handling Functions ---

void handleMenuInput(String input) {
  switch (currentMenuState) {
    case STATE_MAIN_MENU:
      if (input == "1") {
        currentMenuState = STATE_GET_PWM;
        Serial.println("\n--- STEP 1: SET BTS7960 PWM ---");
        Serial.print("Enter desired PWM value (0 to 255): ");
      } else if (input == "2") {
        stopMotors();
        Serial.println("\n[ACTION] BTS7960 Motors Stopped.");
        printMainMenu();
      } else {
        Serial.println("[WARNING] Invalid option. Enter 1 or 2.");
        printMainMenu();
      }
      break;

    case STATE_GET_PWM:
      {
        int pwmVal = input.toInt();
        if (pwmVal >= 0 && pwmVal <= 255) {
          selectedPwm = pwmVal;
          currentMenuState = STATE_GET_DIRECTION;
          printDirectionMenu();
        } else {
          Serial.println("[WARNING] Invalid PWM (0-255). Try again: ");
        }
      }
      break;

    case STATE_GET_DIRECTION:
      {
        int dirChoice = input.toInt();
        executeMovement(dirChoice, selectedPwm);
      }
      break;

    case STATE_ACTIVE_MOTION:
      {
        if (input == "1") {
          stopMotors();
          printStatusReport();
          currentMenuState = STATE_MAIN_MENU;
          printMainMenu();
        } else if (input == "2") {
          currentMenuState = STATE_GET_PWM;
          Serial.println("\n--- STEP 1: SET BTS7960 PWM ---");
          Serial.print("Enter desired PWM value (0 to 255): ");
        } else {
          Serial.println("[WARNING] Invalid choice. Enter [1] to Stop or [2] for New Movement.");
          printActiveMotionMenu();
        }
      }
      break;
  }
}

// Drives the BTS7960s. Returns false (and stops) for an unknown direction.
bool driveMotors(int directionOption, int pwm) {
  digitalWrite(LEFT_EN, HIGH);
  digitalWrite(RIGHT_EN, HIGH);

  switch (directionOption) {
    case 1: // Forward
      currentMotionState = "FORWARD";
      analogWrite(LEFT_RPWM, pwm);  analogWrite(LEFT_LPWM, 0);
      analogWrite(RIGHT_RPWM, pwm); analogWrite(RIGHT_LPWM, 0);
      return true;

    case 2: // Reversing
      currentMotionState = "REVERSING";
      analogWrite(LEFT_RPWM, 0);  analogWrite(LEFT_LPWM, pwm);
      analogWrite(RIGHT_RPWM, 0); analogWrite(RIGHT_LPWM, pwm);
      return true;

    case 3: // Turning Left (Right driver only)
      currentMotionState = "TURNING LEFT";
      analogWrite(LEFT_RPWM, 0);    analogWrite(LEFT_LPWM, 0);
      analogWrite(RIGHT_RPWM, pwm); analogWrite(RIGHT_LPWM, 0);
      return true;

    case 4: // Turning Right (Left driver only)
      currentMotionState = "TURNING RIGHT";
      analogWrite(LEFT_RPWM, pwm);  analogWrite(LEFT_LPWM, 0);
      analogWrite(RIGHT_RPWM, 0);   analogWrite(RIGHT_LPWM, 0);
      return true;

    default:
      stopMotors();
      return false;
  }
}

void executeMovement(int directionOption, int pwm) {
  motorStopAt = 0;  // USB bench menu: no LoRa auto-stop; stop from the menu
  if (!driveMotors(directionOption, pwm)) {
    Serial.println("[WARNING] Invalid choice. Stopping motors.");
  }

  // Print Status Report immediately after execution
  printStatusReport();

  // Transition to Active Motion state to give the user a direct option to stop
  currentMenuState = STATE_ACTIVE_MOTION;
  printActiveMotionMenu();
}

void stopMotors() {
  analogWrite(LEFT_RPWM, 0);
  analogWrite(LEFT_LPWM, 0);
  analogWrite(RIGHT_RPWM, 0);
  analogWrite(RIGHT_LPWM, 0);
  currentMotionState = "STOPPED";
  motorStopAt = 0;
}

// --- Manual control over LoRa (D57) ---
// Commands come from the laptop gateway through the LoRa bridge
// (finalcode_sprint1_gateway.ino). Every recognised command is answered with
// "ACK:<command>", anything else with "NACK:<command>". The bridge retries a
// command until it sees the ACK, so a repeated command is simply re-applied.
//   STOP_ALL | STOP            motors off + Nano STOP_ALL (pump and actuator off)
//   MOTOR_STOP                 motors off
//   DRIVE:<DIR>:<PWM>          DIR = FORWARD | REVERSE | LEFT | RIGHT, PWM 0-255
//   ACTUATOR_EXTEND | ACTUATOR_RETRACT | ACTUATOR_STOP
//   PUMP_ON | PUMP_OFF | PUMP_STOP
// DRIVE, PUMP_ON and ACTUATOR_EXTEND/RETRACT stop by themselves after MANUAL_AUTO_STOP_MS.

void sendLoRa(const String &message) {
  LoRa.beginPacket();
  LoRa.print(message);
  LoRa.endPacket();
  LoRa.receive();
}

unsigned long autoStopDeadline() {
  unsigned long at = millis() + MANUAL_AUTO_STOP_MS;
  return at == 0 ? 1 : at;  // 0 means "no deadline"
}

bool deadlinePassed(unsigned long at) {
  return at != 0 && (long)(millis() - at) >= 0;
}

int driveOptionFor(const String &direction) {
  if (direction == "FORWARD") return 1;
  if (direction == "REVERSE") return 2;
  if (direction == "LEFT") return 3;
  if (direction == "RIGHT") return 4;
  return 0;
}

bool isWholeNumber(const String &s) {
  if (s.length() == 0 || s.length() > 3) return false;
  for (unsigned int i = 0; i < s.length(); i++) {
    if (!isDigit(s.charAt(i))) return false;
  }
  return true;
}

void sendToNano(const char *command) {
  Serial2.println(command);
  Serial.print("[LoRa CMD] -> Nano: ");
  Serial.println(command);
}

// Applies one manual command. Returns false if it is not recognised.
bool applyLoRaCommand(String cmd) {
  cmd.toUpperCase();

  if (cmd == "STOP_ALL" || cmd == "STOP") {
    stopMotors();
    sendToNano("STOP_ALL");
    pumpStopAt = 0;
    actuatorStopAt = 0;
    return true;
  }
  if (cmd == "MOTOR_STOP") {
    stopMotors();
    return true;
  }
  if (cmd == "PUMP_ON") {
    sendToNano("PUMP_ON");
    pumpStopAt = autoStopDeadline();
    return true;
  }
  if (cmd == "PUMP_OFF" || cmd == "PUMP_STOP") {
    sendToNano("PUMP_OFF");
    pumpStopAt = 0;
    return true;
  }
  if (cmd == "ACTUATOR_EXTEND" || cmd == "ACTUATOR_RETRACT") {
    sendToNano(cmd == "ACTUATOR_EXTEND" ? "ACTUATOR_EXTEND" : "ACTUATOR_RETRACT");
    actuatorStopAt = autoStopDeadline();
    return true;
  }
  if (cmd == "ACTUATOR_STOP") {
    sendToNano("ACTUATOR_STOP");
    actuatorStopAt = 0;
    return true;
  }
  if (cmd.startsWith("DRIVE:")) {
    int second = cmd.indexOf(':', 6);
    if (second < 0) return false;
    int option = driveOptionFor(cmd.substring(6, second));
    String pwmText = cmd.substring(second + 1);
    if (option == 0 || !isWholeNumber(pwmText)) return false;
    int pwm = pwmText.toInt();
    if (pwm < 0 || pwm > 255) return false;
    driveMotors(option, pwm);
    motorStopAt = autoStopDeadline();
    Serial.print("[LoRa CMD] Motion: ");
    Serial.print(currentMotionState);
    Serial.print(" | PWM: ");
    Serial.println(pwm);
    return true;
  }
  return false;
}

void handleLoRaPacket(const String &packet) {
  if (packet.length() == 0) return;
  // The bridge ACKs every packet it receives, including our own ACK/NACK replies: ignore those.
  if (packet.startsWith("ACK:") || packet.startsWith("NACK:")) return;
  // The bridge polls every 3 s. The status reply format is not agreed yet
  // (OPEN_ITEMS #36-#39), so the poll is not answered here.
  if (packet == "GET_ROBOT_STATUS") return;

  if (applyLoRaCommand(packet)) {
    sendLoRa("ACK:" + packet);
  } else {
    Serial.println("[LoRa CMD] Unknown command; replying NACK.");
    sendLoRa("NACK:" + packet);
  }
}

void checkAutoStop() {
  if (deadlinePassed(motorStopAt)) {
    stopMotors();
    Serial.println("[AUTO-STOP] Motors stopped (no new drive command).");
  }
  if (deadlinePassed(pumpStopAt)) {
    pumpStopAt = 0;
    sendToNano("PUMP_OFF");
    Serial.println("[AUTO-STOP] Pump stopped.");
  }
  if (deadlinePassed(actuatorStopAt)) {
    actuatorStopAt = 0;
    sendToNano("ACTUATOR_STOP");
    Serial.println("[AUTO-STOP] Actuator stopped.");
  }
}

void printStatusReport() {
  Serial.println("\n========================================");
  Serial.println("           ROBOT STATUS REPORT          ");
  Serial.println("========================================");
  Serial.print  (" -> Motion State : "); Serial.println(currentMotionState);
  Serial.print  (" -> Active PWM   : "); Serial.println(selectedPwm);
  Serial.println(" -> Left Driver  : Active");
  Serial.println(" -> Right Driver : Active");
  Serial.println("========================================");
}

void printMainMenu() {
  Serial.println("\n========================================");
  Serial.println("        MASTER NODE MAIN MENU           ");
  Serial.println("========================================");
  Serial.println(" [1] Configure Dual BTS7960 Movement & PWM");
  Serial.println(" [2] STOP BTS7960 Motors");
  Serial.println("----------------------------------------");
  Serial.print("Select option (1-2): ");
}

void printDirectionMenu() {
  Serial.println("\n--- STEP 2: SELECT MOTION DIRECTION ---");
  Serial.print("PWM Value Locked: "); Serial.println(selectedPwm);
  Serial.println("---------------------------------------");
  Serial.println(" [1] Forward (Both Drivers)");
  Serial.println(" [2] Reversing (Both Drivers Reversed)");
  Serial.println(" [3] Turn Left (Right Driver Only)");
  Serial.println(" [4] Turn Right (Left Driver Only)");
  Serial.println("---------------------------------------");
  Serial.print("Select movement option (1-4): ");
}

void printActiveMotionMenu() {
  Serial.println("\n--- ACTIVE MOTION CONTROLS ---");
  Serial.println(" [1] STOP Robot Now");
  Serial.println(" [2] Configure New Movement / PWM");
  Serial.println("------------------------------");
  Serial.print("Select option (1-2): ");
}