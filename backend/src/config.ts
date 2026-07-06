export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "sk-4fcc3fdf9de44fd59845fa9ec4f399d1",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  waveformEngineUrl: process.env.WAVEFORM_ENGINE_URL || "http://localhost:8001",
  nlpConfidenceThreshold: 0.7,
  // Phone-based IR: MQTT not needed for IR emission (phone IS the blaster)
  // Set MOCK_MQTT=false only if you have ESP32 nodes as fallback
  mockMqtt: process.env.MOCK_MQTT !== "false",
  mockRedis: process.env.MOCK_REDIS !== "false",
  // Real IR: use waveform engine for actual protocol encoding
  // Set MOCK_IR=true only for dev without waveform-engine running
  mockIr: process.env.MOCK_IR === "true",
};
