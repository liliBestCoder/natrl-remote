import Redis from "ioredis";
import { Device, DeviceState } from "./types";

let redis: Redis;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  }
  return redis;
}

export async function setDevice(device: Device): Promise<void> {
  const r = getRedis();
  const key = `device:${device.id}`;
  await r.set(key, JSON.stringify(device));
  // Index: user's devices
  await r.sadd(`user:${device.userId}:devices`, device.id);
  // Index: room devices
  await r.sadd(`user:${device.userId}:room:${device.room}:devices`, device.id);
}

export async function getDevice(deviceId: string): Promise<Device | null> {
  const r = getRedis();
  const raw = await r.get(`device:${deviceId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function getUserDevices(userId: string): Promise<Device[]> {
  const r = getRedis();
  const ids = await r.smembers(`user:${userId}:devices`);
  if (ids.length === 0) return [];
  const pipeline = r.pipeline();
  ids.forEach((id) => pipeline.get(`device:${id}`));
  const results = await pipeline.exec();
  return (results || [])
    .map(([err, raw]) => (raw ? JSON.parse(raw as string) : null))
    .filter(Boolean) as Device[];
}

export async function updateDeviceState(
  deviceId: string,
  state: DeviceState
): Promise<void> {
  const r = getRedis();
  const device = await getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  device.lastState = state;
  await r.set(`device:${deviceId}`, JSON.stringify(device));
}

export async function deleteDevice(deviceId: string): Promise<void> {
  const r = getRedis();
  const device = await getDevice(deviceId);
  if (!device) return;
  await r.del(`device:${deviceId}`);
  await r.srem(`user:${device.userId}:devices`, deviceId);
  await r.srem(`user:${device.userId}:room:${device.room}:devices`, deviceId);
}
