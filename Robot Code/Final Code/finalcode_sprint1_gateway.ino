// RoboLime gateway LoRa bridge (laptop side), Sprint 1.
// Based on "Test Cases/SPRINT_1_Gateway.ino".
//
// Connected to the laptop over USB serial (115200 baud). The laptop gateway
// (`npm run serve -- --serial-port <port>`, decision D57) writes one command
// per line; this bridge sends it to the robot over LoRa, retries up to
// maxRetries times until the robot answers "ACK:<command>" (or "NACK:<command>"),
// and prints what happened. The laptop gateway reads these printed lines:
//   [Gateway] Received --> ACK:<command>     robot received the command
//   [Gateway] Received --> NACK:<command>    robot did not recognise it
//   [Gateway] Error: Command timed out...    no answer after all retries
// Keep those three line formats unchanged, or update
// apps/gateway/src/manual/manualControlLink.ts to match.

#include <SPI.h>
#include <LoRa.h>

#define LORA_SS    5
#define LORA_RST   14
#define LORA_DIO0  2

// MUST MATCH the robot (finalcode_sprint1_esp.ino) and the Ra-02 (SX1278,
// 433 MHz band) modules. Confirm with the hardware owner before field use.
const long LORA_FREQUENCY = 433E6;

unsigned long lastStatusRequest = 0;
const long statusInterval = 3000; // 3 seconds interval for ROBOT_STATUS requests

String pendingCommand = "";
bool waitingForAck = false;
unsigned long lastSendTime = 0;
const unsigned long retryInterval = 1000;
int retryCount = 0;
const int maxRetries = 3;

void sendLoRa(const String &message) {
  LoRa.beginPacket();
  LoRa.print(message);
  LoRa.endPacket();
  LoRa.receive();
}

void clearPending() {
  pendingCommand = "";
  waitingForAck = false;
  retryCount = 0;
}

void setup() {
  Serial.begin(115200);
  while (!Serial);

  Serial.println(F("[Gateway] Initializing LoRa..."));
  LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);

  if (!LoRa.begin(LORA_FREQUENCY)) {
    Serial.println(F("[Gateway] Starting LoRa failed!"));
    while (1);
  }

  Serial.println(F("[Gateway] LoRa Initialized Successfully!"));
  Serial.println(F("[Gateway] Commands: STOP_ALL, DRIVE:<FORWARD|REVERSE|LEFT|RIGHT>:<0-255>, PUMP_ON, PUMP_OFF, ACTUATOR_EXTEND, ACTUATOR_RETRACT"));
  LoRa.receive();
}

void loop() {
  if (millis() - lastStatusRequest >= statusInterval) {
    lastStatusRequest = millis();
    sendLoRa("GET_ROBOT_STATUS");
  }

  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command.length() > 0) {
      if (waitingForAck) {
        Serial.println(F("[Gateway] Warning: Previous command superseded. Queueing new command."));
      }

      pendingCommand = command;
      waitingForAck = true;
      retryCount = 0;
      lastSendTime = millis();

      Serial.print(F("[Gateway] Sending command: "));
      Serial.println(pendingCommand);
      sendLoRa(pendingCommand);
    }
  }

  if (waitingForAck && (millis() - lastSendTime >= retryInterval)) {
    lastSendTime = millis();
    retryCount++;

    if (retryCount <= maxRetries) {
      Serial.print(F("[Gateway] No ACK received. Retrying (Attempt "));
      Serial.print(retryCount);
      Serial.print(F("/"));
      Serial.print(maxRetries);
      Serial.print(F("): "));
      Serial.println(pendingCommand);
      sendLoRa(pendingCommand);
    } else {
      Serial.println(F("[Gateway] Error: Command timed out. No acknowledgment from robot."));
      clearPending();
    }
  }

  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String incomingData = "";
    while (LoRa.available()) {
      incomingData += (char)LoRa.read();
    }
    incomingData.trim();

    Serial.print(F("[Gateway] Received --> "));
    Serial.println(incomingData);

    if (incomingData.startsWith("ACK:")) {
      String ackedCmd = incomingData.substring(4);
      if (waitingForAck && ackedCmd.equalsIgnoreCase(pendingCommand)) {
        Serial.println(F("[Gateway] SUCCESS: Command acknowledged by robot."));
        clearPending();
      }
    } else if (incomingData.startsWith("NACK:")) {
      String rejectedCmd = incomingData.substring(5);
      if (waitingForAck && rejectedCmd.equalsIgnoreCase(pendingCommand)) {
        Serial.println(F("[Gateway] REJECTED: Robot did not recognise the command."));
        clearPending();
      }
    } else {
      sendLoRa("ACK:" + incomingData);
    }
  }
}
