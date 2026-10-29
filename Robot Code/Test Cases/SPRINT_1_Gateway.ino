#include <SPI.h>
#include <LoRa.h>

#define LORA_SS    5
#define LORA_RST   14
#define LORA_DIO0  2

unsigned long lastStatusRequest = 0;
const long statusInterval = 3000; // 3 seconds interval for ROBOT_STATUS requests

String pendingCommand = "";
bool waitingForAck = false;
unsigned long lastSendTime = 0;
const unsigned long retryInterval = 1000; 
int retryCount = 0;
const int maxRetries = 3;

void setup() {
  Serial.begin(115200);
  while (!Serial);

  Serial.println(F("[Gateway] Initializing LoRa..."));
  LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);

  if (!LoRa.begin(433E6)) {
    Serial.println(F("[Gateway] Starting LoRa failed!"));
    while (1);
  }
  
  Serial.println(F("[Gateway] LoRa Initialized Successfully!"));
  Serial.println(F("[Gateway] Type commands (e.g., MOTOR_STOP, PUMP_STOP, ACTUATOR_STOP, STOP_ALL) in Serial Monitor."));
  LoRa.receive(); 
}

void loop() {
  if (millis() - lastStatusRequest >= statusInterval) {
    lastStatusRequest = millis();
    
    String autoStatusCmd = "GET_ROBOT_STATUS";
    LoRa.beginPacket();
    LoRa.print(autoStatusCmd);
    LoRa.endPacket();
    LoRa.receive(); 
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

      LoRa.beginPacket();
      LoRa.print(pendingCommand);
      LoRa.endPacket();
      LoRa.receive(); 
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

      LoRa.beginPacket();
      LoRa.print(pendingCommand);
      LoRa.endPacket();
      LoRa.receive();
    } else {
      Serial.println(F("[Gateway] Error: Command timed out. No acknowledgment from robot."));
      pendingCommand = "";
      waitingForAck = false;
      retryCount = 0;
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
        pendingCommand = "";
        waitingForAck = false;
        retryCount = 0;
      }
    } else {
      LoRa.beginPacket();
      LoRa.print("ACK:");
      LoRa.print(incomingData);
      LoRa.endPacket();
      LoRa.receive(); 
    }
  }
}