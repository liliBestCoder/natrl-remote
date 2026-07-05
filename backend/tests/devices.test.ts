import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";

vi.mock("../src/device-registry", () => ({
  setDevice: vi.fn(),
  getDevice: vi.fn(),
  getUserDevices: vi.fn(),
  deleteDevice: vi.fn(),
  updateDeviceState: vi.fn(),
}));
vi.mock("../src/ir-engine-client", () => ({
  matchProtocol: vi.fn(),
  getProbeCommands: vi.fn(),
  generateWaveform: vi.fn(),
}));
vi.mock("../src/mqtt-client", () => ({
  publishCommand: vi.fn(),
  connectMqtt: vi.fn(),
}));

import { devicesRouter } from "../src/routes/devices";
import { setDevice, getDevice, getUserDevices } from "../src/device-registry";
import { matchProtocol } from "../src/ir-engine-client";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/devices", devicesRouter);
  return app;
}

describe("Device Routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /api/devices", () => {
    it("should create a device", async () => {
      vi.mocked(setDevice).mockResolvedValue(undefined);

      const app = makeApp();
      const res = await request(app)
        .post("/api/devices")
        .send({ userId: "user-1", room: "bedroom", name: "卧室空调" });

      expect(res.status).toBe(201);
      expect(res.body.device.room).toBe("bedroom");
      expect(res.body.device.deviceType).toBe("ac");
      expect(res.body.device.verified).toBe(false);
    });

    it("should return 400 if fields missing", async () => {
      const app = makeApp();
      const res = await request(app).post("/api/devices").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/devices", () => {
    it("should return user devices", async () => {
      vi.mocked(getUserDevices).mockResolvedValue([{
        id: "dev-1",
        userId: "user-1",
        room: "bedroom",
        name: "卧室空调",
        deviceType: "ac",
        brandCode: "gree_nec_v1",
        protocol: "NEC",
        mqttTopic: "home/bedroom/dev-1",
        lastState: { power: false, temperature: 24, mode: "cool", fan_speed: "auto" } as any,
        verified: true,
        createdAt: new Date().toISOString(),
      }]);

      const app = makeApp();
      const res = await request(app).get("/api/devices?userId=user-1");

      expect(res.status).toBe(200);
      expect(res.body.devices).toHaveLength(1);
    });
  });

  describe("POST /api/devices/:id/learn/result", () => {
    it("should identify brand from learned signal", async () => {
      vi.mocked(getDevice).mockResolvedValue({
        id: "dev-1",
        userId: "user-1",
        room: "bedroom",
        name: "卧室空调",
        deviceType: "ac",
        brandCode: null,
        protocol: null,
        mqttTopic: "home/bedroom/dev-1",
        lastState: { power: false, temperature: 24, mode: "cool", fan_speed: "auto" } as any,
        verified: false,
        createdAt: new Date().toISOString(),
      });

      vi.mocked(matchProtocol).mockResolvedValue({ brandCode: "gree_nec_v1", confidence: 0.92 });
      vi.mocked(setDevice).mockResolvedValue(undefined);

      const app = makeApp();
      const res = await request(app)
        .post("/api/devices/dev-1/learn/result")
        .send({ raw_timing: [9000, 4500, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 560, 560, 560, 560, 1690] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("identified");
      expect(res.body.brandCode).toBe("gree_nec_v1");
    });
  });
});
