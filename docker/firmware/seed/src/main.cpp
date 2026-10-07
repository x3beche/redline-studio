// Seed: pulls every pooled library into the build once, so each is
// downloaded and compiled while the image is made.
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <U8g2lib.h>
#include <ESP32Encoder.h>
#include <ArduinoJson.h>
#include <Bounce2.h>

Adafruit_SSD1306 oled(128, 32, &Wire, -1);
U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C u8g2(U8G2_R0);
ESP32Encoder enc;
Bounce button;

void setup() {
  Serial.begin(115200);
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  u8g2.begin();
  enc.attachHalfQuad(32, 33);
  button.attach(4, INPUT_PULLUP);
  JsonDocument doc;
  doc["ok"] = true;
  serializeJson(doc, Serial);
}

void loop() { button.update(); }
