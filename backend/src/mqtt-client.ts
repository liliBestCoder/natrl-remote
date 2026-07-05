import mqtt, { MqttClient } from "mqtt";

let client: MqttClient;

export function connectMqtt(): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    if (client && client.connected) return resolve(client);

    const url = process.env.MQTT_URL || "mqtt://localhost:1883";
    client = mqtt.connect(url, {
      clientId: `natrl-backend-${Date.now()}`,
      clean: true,
      connectTimeout: 5000,
    });

    client.once("connect", () => {
      console.log(`[mqtt] connected to ${url}`);
      resolve(client);
    });

    client.once("error", (err) => {
      console.error("[mqtt] connection error:", err.message);
      reject(err);
    });
  });
}

export async function publishCommand(
  topic: string,
  payload: Buffer
): Promise<void> {
  const c = await connectMqtt();
  return new Promise((resolve, reject) => {
    c.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) return reject(err);
      console.log(`[mqtt] published to ${topic}, ${payload.length} bytes`);
      resolve();
    });
  });
}

export async function subscribeToLearnedSignals(
  deviceId: string,
  callback: (timing: number[]) => void
): Promise<void> {
  const c = await connectMqtt();
  const topic = `home/learned/${deviceId}`;
  await c.subscribeAsync(topic, { qos: 1 });
  c.on("message", (receivedTopic, message) => {
    if (receivedTopic === topic) {
      try {
        const timing = JSON.parse(message.toString()) as number[];
        callback(timing);
      } catch (e) {
        console.error("[mqtt] failed to parse learned signal:", e);
      }
    }
  });
  console.log(`[mqtt] subscribed to ${topic}`);
}
