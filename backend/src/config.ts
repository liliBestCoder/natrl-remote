export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  waveformEngineUrl: process.env.WAVEFORM_ENGINE_URL || "http://localhost:8001",
  nlpConfidenceThreshold: 0.7,
};
