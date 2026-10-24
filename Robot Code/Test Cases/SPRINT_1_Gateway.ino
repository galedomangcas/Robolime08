#include <SPI.h>
#include <LoRa.h>

#define LORA_SS    5
#define LORA_RST   14
#define LORA_DIO0  2

unsigned long lastStatusRequest = 0;
const long statusInterval = 3000; // 3 seconds interval for ROBOT_STATUS

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
  Serial.println(F("[Gateway] Type commands (e.g., get_pH, LED_ON) in the Serial Monitor."));
}

void loop() {
  // 1. Automatic 3-Second Robot Status Request Interval
  if (millis() - lastStatusRequest >= statusInterval) {
    lastStatusRequest = millis();
    
    String autoStatusCmd = "GET_ROBOT_STATUS";

    Serial.println("[Robolime] MSG:ROBOT_STATUS,STATE:ACTIVE,ERR:0,BATTERY:88,TOTAL_LIME:120.5,TS:1771920000");
    
    LoRa.beginPacket();
    LoRa.print(autoStatusCmd);
    LoRa.endPacket();
  }

  // 2. Check if Laptop sent a manual command via Serial Monitor (e.g., "get_pH")
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command.length() > 0) {
      Serial.print(F("[Gateway] Sending manual command: "));
      Serial.println(command);
      Serial.println("[Robolime] MSG:SOIL_STATUS,PH:6.52,EC:1.20,MOISTURE:42.5,TEMP:24.1,LIME:15.0,LAT:14.5995,LON:120.9842,FLAG:0");

      LoRa.beginPacket();
      LoRa.print(command);
      LoRa.endPacket();
    }
  }

  // 3. Listen asynchronously for incoming responses / ACKs / Data from the robot via LoRa
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String incomingData = "";
    while (LoRa.available()) {
      incomingData += (char)LoRa.read();
    }
    incomingData.trim();

    Serial.print(F("[Gateway] Received --> "));
    Serial.println(incomingData);
  }
}