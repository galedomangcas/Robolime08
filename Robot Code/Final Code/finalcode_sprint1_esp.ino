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
const long LORA_FREQUENCY = 915E6; 

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
    Serial.print("\n[LoRa RX] Content: ");
    Serial.println(loraPacket);
  }

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

void executeMovement(int directionOption, int pwm) {
  digitalWrite(LEFT_EN, HIGH);
  digitalWrite(RIGHT_EN, HIGH);

  switch (directionOption) {
    case 1: // Forward
      currentMotionState = "FORWARD";
      analogWrite(LEFT_RPWM, pwm);  analogWrite(LEFT_LPWM, 0);
      analogWrite(RIGHT_RPWM, pwm); analogWrite(RIGHT_LPWM, 0);
      break;

    case 2: // Reversing
      currentMotionState = "REVERSING";
      analogWrite(LEFT_RPWM, 0);  analogWrite(LEFT_LPWM, pwm);
      analogWrite(RIGHT_RPWM, 0); analogWrite(RIGHT_LPWM, pwm);
      break;

    case 3: // Turning Left (Right driver only)
      currentMotionState = "TURNING LEFT";
      analogWrite(LEFT_RPWM, 0);    analogWrite(LEFT_LPWM, 0);
      analogWrite(RIGHT_RPWM, pwm); analogWrite(RIGHT_LPWM, 0);
      break;

    case 4: // Turning Right (Left driver only)
      currentMotionState = "TURNING RIGHT";
      analogWrite(LEFT_RPWM, pwm);  analogWrite(LEFT_LPWM, 0);
      analogWrite(RIGHT_RPWM, 0);   analogWrite(RIGHT_LPWM, 0);
      break;

    default:
      currentMotionState = "STOPPED";
      stopMotors();
      Serial.println("[WARNING] Invalid choice. Stopping motors.");
      break;
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