import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";

vi.mock("../src/nlp", () => ({ parseNaturalLanguage: vi.fn() }));
vi.mock("../src/device-registry", () => ({
  getUserDevices: vi.fn(),
  getDevice: vi.fn(),
  updateDeviceState: vi.fn(),
}));
vi.mock("../src/ir-engine-client", () => ({ generateWaveform: vi.fn() }));
vi.mock("../src/mqtt-client", () => ({
  publishCommand: vi.fn(),
  connectMqtt: vi.fn(),
}));

import { controlRouter } from "../src/routes/control";
import { parseNaturalLanguage } from "../src/nlp";
import { getUserDevices, updateDeviceState } from "../src/device-registry";
import { generateWaveform } from "../src/ir-engine-client";
import { publishCommand } from "../src/mqtt-client";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/control", controlRouter);
  return app;
}

describe("POST /api/control", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 400 if input or userId missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/api/control").send({});
    expect(res.status).toBe(400);
  });

  it("should ask for clarification when confidence is low", async () => {
    vi.mocked(parseNaturalLanguage).mockResolvedValue({
      parsed: { intent: "set_temp", device: "ac", room: null, params: {} as any },
      confidence: 0.3,
      raw_input: "make it cooler",
      needs_clarification: "Did you mean lower temperature?",
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/control")
      .send({ input: "make it cooler", userId: "user-1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Did you mean");
  });

  it("should control AC successfully with valid intent", async () => {
    vi.mocked(parseNaturalLanguage).mockResolvedValue({
      parsed: {
        intent: "set_temp",
        device: "ac",
        room: null,
        params: { temperature: 26, mode: "cool" as any, fan_speed: "auto" as any },
      },
      confidence: 0.95,
      raw_input: "set to 26 degrees",
      needs_clarification: null,
    });

    vi.mocked(getUserDevices).mockResolvedValue([{
      id: "dev-1",
      userId: "user-1",
      room: "bedroom",
      name: "卧室空调",
      deviceType: "ac",
      brandCode: "gree_nec_v1",
      protocol: "NEC",
      mqttTopic: "home/bedroom/dev-1",
      lastState: { power: false, temperature: 24, mode: "cool" as any, fan_speed: "auto" as any },
      verified: true,
      createdAt: new Date().toISOString(),
    }]);

    vi.mocked(generateWaveform).mockResolvedValue({
      brand_code: "gree_nec_v1",
      protocol: "NEC",
      carrier_freq: 38000,
      raw_timing: [9000, 4500, 560, 1690],
    });

    vi.mocked(publishCommand).mockResolvedValue(undefined);
    vi.mocked(updateDeviceState).mockResolvedValue(undefined);

    const app = makeApp();
    const res = await request(app)
      .post("/api/control")
      .send({ input: "调到26度", userId: "user-1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("26");
    expect(publishCommand).toHaveBeenCalledTimes(1);
    expect(updateDeviceState).toHaveBeenCalledTimes(1);
  });

  it("should fail when no AC device is set up", async () => {
    vi.mocked(parseNaturalLanguage).mockResolvedValue({
      parsed: { intent: "set_temp", device: "ac", room: null, params: { temperature: 26 } as any },
      confidence: 0.95,
      raw_input: "set to 26",
      needs_clarification: null,
    });
    vi.mocked(getUserDevices).mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .post("/api/control")
      .send({ input: "调到26度", userId: "user-1" });

    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("No AC devices");
  });
});
