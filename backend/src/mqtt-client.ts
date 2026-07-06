import mqtt, { MqttClient } from "mqtt";
import { config } from "./config";

let client: MqttClient | null = null;

export function connectMqtt(): Promise<MqttClient | null> {
  return new Promise((resolve, _reject) => {
    if (client && client.connected) return resolve(client);
    if (config.mockMqtt) {
      console.log("[mqtt] mock mode — skipping connection");
      return resolve(null);
    }

    const url = config.mqttUrl;
    client = mqtt.connect(url, {
      clientId: `natrl-backend-${Date.now()}`,
      clean: true,
      connectTimeout: 3000,
    });

    const timeout = setTimeout(() => {
      console.warn("[mqtt] connection timeout — switching to mock");
      client = null;
      resolve(null);
    }, 3500);

    client.once("connect", () => {
      clearTimeout(timeout);
      console.log(`[mqtt] connected to ${url}`);
      resolve(client);
    });

    client.once("error", (err) => {
      clearTimeout(timeout);
      console.warn("[mqtt] unavailable — switching to mock:", err.message);
      client = null;
      resolve(null);
    });
  });
}

export async function publishCommand(
  topic: string,
  payload: Buffer
): Promise<void> {
  try {
    const c = await connectMqtt();
    if (!c) {
      console.log(`[mqtt] mock publish to ${topic}, ${payload.length} bytes (skipped)`);
      return;
    }
    return new Promise((resolve, reject) => {
      c.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) return reject(err);
        console.log(`[mqtt] published to ${topic}, ${payload.length} bytes`);
        resolve();
      });
    });
  } catch (e: any) {
    console.warn(`[mqtt] publish failed (non-fatal):`, e.message);
  }
}

export async function subscribeToLearnedSignals(
  deviceId: string,
  callback: (timing: number[]) => void
): Promise<void> {
  const c = await connectMqtt();
  if (!c) {
    console.log(`[mqtt] mock subscribe to ${deviceId} (skipped)`);
    return;
  }
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
