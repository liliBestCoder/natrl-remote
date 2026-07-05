#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <IRrecv.h>
#include <IRutils.h>

// === Pin Configuration ===
const int IR_LED_PIN_1 = 4;
const int IR_LED_PIN_2 = 17;
const int IR_LED_PIN_3 = 18;
const int IR_RECV_PIN = 19;
const int STATUS_LED_PIN = 2;
const int BUTTON_PIN = 0;

// === MQTT Configuration ===
const char* MQTT_SERVER = "192.168.1.100";
const int MQTT_PORT = 1883;
const char* DEVICE_ID = "natrl-node-001";

// === State ===
enum NodeState {
  STATE_SETUP,
  STATE_CONNECTING,
  STATE_READY,
  STATE_EMITTING,
  STATE_LEARNING
};
NodeState nodeState = STATE_SETUP;

// === Objects ===
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
IRsend irsend1(IR_LED_PIN_1);
IRsend irsend2(IR_LED_PIN_2);
IRsend irsend3(IR_LED_PIN_3);
IRrecv irrecv(IR_RECV_PIN);
decode_results irResults;

String mqttTopic = "home/bedroom/unknown";
String learnResultTopic = "";

// === LED ===
void setLed(int r, int g, int b) {
  if (r == 0 && g == 0 && b > 0) digitalWrite(STATUS_LED_PIN, HIGH);
  else if (r > 0 && g == 0 && b == 0) digitalWrite(STATUS_LED_PIN, LOW);
  else digitalWrite(STATUS_LED_PIN, (g > 0 || b > 0) ? HIGH : LOW);
}

// === IR Emission ===
void emitIR(const uint16_t* rawTiming, size_t length, uint16_t carrierFreq) {
  nodeState = STATE_EMITTING;
  setLed(0, 1, 0);

  irsend1.sendRaw(rawTiming, length, carrierFreq);
  irsend2.sendRaw(rawTiming, length, carrierFreq);
  irsend3.sendRaw(rawTiming, length, carrierFreq);

  delay(50);
  nodeState = STATE_READY;
  setLed(0, 0, 1);
}

// === IR Learning ===
void startLearning() {
  nodeState = STATE_LEARNING;
  setLed(1, 1, 0);
  irrecv.enableIRIn();
}

// === MQTT Callback ===
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  msg.reserve(length);
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  if (msg.indexOf("\"command\":\"learn\"") >= 0) {
    learnResultTopic = String(topic);
    startLearning();
    return;
  }

  if (msg.indexOf("\"set_topic\"") >= 0) {
    int start = msg.indexOf("\"set_topic\":\"") + 13;
    int end = msg.indexOf("\"", start);
    if (start > 12 && end > start) {
      mqttTopic = msg.substring(start, end);
      mqttClient.subscribe(mqttTopic.c_str());
    }
    return;
  }

  if (msg.indexOf("\"raw_timing\"") >= 0) {
    int freqStart = msg.indexOf("\"carrier_freq\":") + 15;
    int freqEnd = msg.indexOf(",", freqStart);
    if (freqEnd < 0) freqEnd = msg.indexOf("}", freqStart);
    uint16_t freq = (freqStart > 14) ? msg.substring(freqStart, freqEnd).toInt() : 38000;

    int arrStart = msg.indexOf("[");
    int arrEnd = msg.indexOf("]");
    if (arrStart < 0 || arrEnd < 0) return;

    String arrStr = msg.substring(arrStart + 1, arrEnd);
    int count = 1;
    for (int i = 0; i < arrStr.length(); i++)
      if (arrStr.charAt(i) == ',') count++;

    uint16_t timing[count];
    int idx = 0, lastComma = 0;
    for (int i = 0; i <= arrStr.length(); i++) {
      if (i == arrStr.length() || arrStr.charAt(i) == ',') {
        if (idx < count) timing[idx++] = (uint16_t)arrStr.substring(lastComma, i).toInt();
        lastComma = i + 1;
      }
    }

    emitIR(timing, count, freq);

    String ack = "{\"status\":\"ok\",\"timestamp\":" + String(millis()) + "}";
    mqttClient.publish((mqttTopic + "/ack").c_str(), ack.c_str());
  }
}

// === MQTT Reconnect ===
void reconnectMQTT() {
  while (!mqttClient.connected()) {
    if (mqttClient.connect(DEVICE_ID)) {
      mqttClient.subscribe(mqttTopic.c_str());
      mqttClient.subscribe("home/config");
      nodeState = STATE_READY;
      setLed(0, 0, 1);
    } else {
      setLed(1, 0, 0);
      delay(5000);
    }
  }
}

// === Setup ===
void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  setLed(1, 0, 0);

  irsend1.begin();
  irsend2.begin();
  irsend3.begin();

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);

  WiFiManagerParameter mqttParam("mqtt_server", "MQTT Server", MQTT_SERVER, 40);
  wm.addParameter(&mqttParam);

  if (!wm.autoConnect("Natrl-Node-Setup")) {
    ESP.restart();
  }

  String mqttServer = mqttParam.getValue();
  mqttClient.setServer(
    mqttServer.length() > 0 ? mqttServer.c_str() : MQTT_SERVER,
    MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  reconnectMQTT();
}

// === Main Loop ===
void loop() {
  if (!mqttClient.connected()) reconnectMQTT();
  mqttClient.loop();

  if (nodeState == STATE_LEARNING && irrecv.decode(&irResults)) {
    String timingJson = "[";
    uint16_t* rawBuf = irResults.rawbuf;
    for (uint16_t i = 1; i < irResults.rawlen; i++) {
      timingJson += String(rawBuf[i] * RAWTICK);
      if (i < irResults.rawlen - 1) timingJson += ",";
    }
    timingJson += "]";

    String payload = "{\"raw_timing\":" + timingJson + "}";
    String resultTopic = learnResultTopic.length() > 0 ? learnResultTopic : mqttTopic + "/learned";
    mqttClient.publish(resultTopic.c_str(), payload.c_str());

    irrecv.disableIRIn();
    nodeState = STATE_READY;
    setLed(0, 0, 1);
  }

  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(3000);
    if (digitalRead(BUTTON_PIN) == LOW) {
      WiFiManager wm;
      wm.resetSettings();
      ESP.restart();
    }
  }

  delay(10);
}
