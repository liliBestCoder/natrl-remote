import Redis from "ioredis";
import { Device, DeviceState } from "./types";
import { config } from "./config";
import mysql from "mysql2/promise";

// In-memory store
const memoryStore = new Map<string, Device>();
const userDeviceIndex = new Map<string, Set<string>>();

let redis: Redis | null = null;
let mysqlPool: mysql.Pool | null = null;

async function getRedis(): Promise<Redis | null> {
  if (config.mockRedis) return null;
  if (!redis) {
    try {
      redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      console.log("[db] Redis connected");
    } catch (e) {
      console.warn("[db] Redis unavailable, using in-memory store");
      redis = null;
    }
  }
  return redis;
}

async function getMysql(): Promise<mysql.Pool | null> {
  if (mysqlPool) return mysqlPool;
  try {
    mysqlPool = mysql.createPool({
      uri: process.env.DATABASE_URL || "mysql://natrl:natrl_dev@127.0.0.1:3306/natrl",
      waitForConnections: true,
      connectionLimit: 5,
    });
    await mysqlPool.execute("SELECT 1");
    console.log("[db] MySQL connected for device persistence");
  } catch (e: any) {
    console.warn("[db] MySQL unavailable for devices, using memory only:", e.message);
    mysqlPool = null;
  }
  return mysqlPool;
}

export async function setDevice(device: Device): Promise<void> {
  // In-memory
  memoryStore.set(device.id, device);
  if (!userDeviceIndex.has(device.userId)) userDeviceIndex.set(device.userId, new Set());
  userDeviceIndex.get(device.userId)!.add(device.id);

  // MySQL persistence
  try {
    const pool = await getMysql();
    if (pool) {
      await pool.execute(
        `INSERT INTO devices (id, user_id, room, name, device_type, brand_code, protocol, mqtt_topic, last_state, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           room = VALUES(room), name = VALUES(name), brand_code = VALUES(brand_code),
           protocol = VALUES(protocol), last_state = VALUES(last_state),
           verified = VALUES(verified)`,
        [
          device.id, device.userId, device.room, device.name,
          device.deviceType, device.brandCode || null, device.protocol || null,
          device.mqttTopic, JSON.stringify(device.lastState),
          device.verified ? 1 : 0, device.createdAt,
        ]
      );
    }
  } catch (e: any) {
    console.error("[db] MySQL setDevice error:", e.message);
  }

  // Redis (best-effort)
  try {
    const r = await getRedis();
    if (r) {
      const key = `device:${device.id}`;
      await r.set(key, JSON.stringify(device));
      await r.sadd(`user:${device.userId}:devices`, device.id);
    }
  } catch (_) {}
}

export async function getDevice(deviceId: string): Promise<Device | null> {
  // Check memory first
  const mem = memoryStore.get(deviceId);
  if (mem) return mem;

  try {
    const r = await getRedis();
    if (r) {
      const raw = await r.get(`device:${deviceId}`);
      return raw ? JSON.parse(raw) : null;
    }
  } catch (_) {}
  return null;
}

export async function getUserDevices(userId: string): Promise<Device[]> {
  // Memory store
  const ids = userDeviceIndex.get(userId);
  if (ids && ids.size > 0) {
    return Array.from(ids).map((id) => memoryStore.get(id)!).filter(Boolean);
  }

  // Redis fallback
  try {
    const r = await getRedis();
    if (r) {
      const redisIds = await r.smembers(`user:${userId}:devices`);
      if (redisIds.length === 0) return [];
      const pipeline = r.pipeline();
      redisIds.forEach((id) => pipeline.get(`device:${id}`));
      const results = await pipeline.exec();
      return (results || [])
        .map(([err, raw]) => (raw ? JSON.parse(raw as string) : null))
        .filter(Boolean) as Device[];
    }
  } catch (_) {}
  return [];
}

export async function updateDeviceState(
  deviceId: string,
  state: DeviceState
): Promise<void> {
  const device = memoryStore.get(deviceId) || await getDevice(deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  device.lastState = state;
  memoryStore.set(deviceId, device);

  try {
    const r = await getRedis();
    if (r) await r.set(`device:${deviceId}`, JSON.stringify(device));
  } catch (_) {}
}

export async function deleteDevice(deviceId: string): Promise<void> {
  const device = memoryStore.get(deviceId);
  memoryStore.delete(deviceId);
  if (device) {
    const userSet = userDeviceIndex.get(device.userId);
    if (userSet) userSet.delete(deviceId);
  }

  try {
    const r = await getRedis();
    if (r && device) {
      await r.del(`device:${deviceId}`);
      await r.srem(`user:${device.userId}:devices`, deviceId);
      await r.srem(`user:${device.userId}:room:${device.room}:devices`, deviceId);
    }
  } catch (_) {}
}
