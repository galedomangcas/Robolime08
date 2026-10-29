#include <SoftwareSerial.h>

// RX = D5, TX = D6 (Connected to ESP32 via Logic Level Shifter)
SoftwareSerial nanoSerial(5, 6); 

// --- L298N Pin Configuration ---
const int ACTUATOR_IN1 = 10;
const int ACTUATOR_IN2 = 9;
const int PUMP_IN3 = 8;
const int PUMP_IN4 = 7;

bool espAcknowledged = false;
unsigned long lastPingTime = 0;
const unsigned long pingInterval = 2000; // Repeat handshake ping every 2 seconds until acknowledged

void setup() {
  // USB Debug Monitor on Nano (Pins 0 & 1)
  Serial.begin(9600);
  while (!Serial);

  // Communication with ESP32 via SoftwareSerial
  nanoSerial.begin(9600);
  Serial.println("=== Nano Initialized ===");

  // Set motor driver control pins as outputs
  pinMode(ACTUATOR_IN1, OUTPUT);
  pinMode(ACTUATOR_IN2, OUTPUT);
  pinMode(PUMP_IN3, OUTPUT);
  pinMode(PUMP_IN4, OUTPUT);
  
  stopAll();
}

void loop() {
  // 1. Perform UART Handshake if not yet acknowledged by ESP32
  if (!espAcknowledged) {
    if (millis() - lastPingTime >= pingInterval) {
      lastPingTime = millis();
      nanoSerial.println("NANO_READY");
      Serial.println("[UART] Sent initialization string to ESP32: NANO_READY");
    }
  }

  // 2. Receive incoming data from ESP32
  if (nanoSerial.available()) {
    String incoming = nanoSerial.readStringUntil('\n');
    incoming.trim();
    
    if (incoming == "ESP32_ACK") {
      espAcknowledged = true;
      Serial.println("[UART HANDSHAKE SUCCESS] Acknowledgment received from ESP32!");
    } else {
      incoming.toUpperCase();
      if (incoming.length() > 0) {
        Serial.print("ESP32 says <- ");
        Serial.println(incoming);
        executeCommand(incoming);
      }
    }
  }

  // 3. Manual serial input from Nano monitor to ESP32
  if (Serial.available()) {
    String msg = Serial.readStringUntil('\n');
    msg.trim();
    if (msg.length() > 0) {
      nanoSerial.println(msg);
      Serial.print("You (Nano) -> ");
      Serial.println(msg);
    }
  }
}

// Function to execute motor/pump commands
void executeCommand(String cmd) {
  if (cmd == "ACTUATOR_EXTEND") {
    digitalWrite(ACTUATOR_IN1, HIGH);
    digitalWrite(ACTUATOR_IN2, LOW);
    Serial.println("[ACTION] Linear Actuator Extending...");
  } 
  else if (cmd == "ACTUATOR_RETRACT") {
    digitalWrite(ACTUATOR_IN1, LOW);
    digitalWrite(ACTUATOR_IN2, HIGH);
    Serial.println("[ACTION] Linear Actuator Retracting...");
  } 
  else if (cmd == "ACTUATOR_STOP") {
    // Sent by the ESP32 when a manual actuator command times out (D57).
    digitalWrite(ACTUATOR_IN1, LOW);
    digitalWrite(ACTUATOR_IN2, LOW);
    Serial.println("[ACTION] Linear Actuator Stopped.");
  }
  else if (cmd == "PUMP_ON") {
    digitalWrite(PUMP_IN3, HIGH);
    digitalWrite(PUMP_IN4, LOW);
    Serial.println("[ACTION] Diaphragm Pump ON.");
  } 
  else if (cmd == "PUMP_OFF" || cmd == "PUMP_STOP") {
    digitalWrite(PUMP_IN3, LOW);
    digitalWrite(PUMP_IN4, LOW);
    Serial.println("[ACTION] Diaphragm Pump OFF.");
  } 
  else if (cmd == "STOP_ALL" || cmd == "STOP") {
    stopAll();
    Serial.println("[ACTION] All actuators and pumps stopped.");
  } 
  else {
    Serial.println("[WARNING] Unknown command received.");
  }
}

void stopAll() {
  digitalWrite(ACTUATOR_IN1, LOW);
  digitalWrite(ACTUATOR_IN2, LOW);
  digitalWrite(PUMP_IN3, LOW);
  digitalWrite(PUMP_IN4, LOW);
}