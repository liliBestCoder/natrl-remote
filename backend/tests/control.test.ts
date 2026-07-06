import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";

// Mock NLP module
vi.mock("../src/nlp", () => ({
  processInput: vi.fn(),
}));

import { controlRouter } from "../src/routes/control";
import { processInput } from "../src/nlp";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/control", controlRouter);
  return app;
}

describe("POST /api/control (Tool Call Architecture)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 400 if input or userId missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/api/control").send({});
    expect(res.status).toBe(400);
  });

  it("should proxy result from processInput", async () => {
    vi.mocked(processInput).mockResolvedValue({
      message: "已帮你把空调温度调到26度",
      phase: "control",
      deviceId: "dev-1",
      irCommand: {
        brand_code: "gree_nec_v1",
        protocol: "NEC",
        carrier_freq: 38000,
        raw_timing: [9000, 4500, 560, 1690],
      },
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/control")
      .send({ input: "调到26度", userId: "user-1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("26");
    expect(res.body.irCommand).toBeDefined();
    expect(res.body.irCommand.carrier_freq).toBe(38000);
    expect(processInput).toHaveBeenCalledWith("调到26度", "user-1");
  });

  it("should return setup phase result with probe info", async () => {
    vi.mocked(processInput).mockResolvedValue({
      message: "已添加卧室空调。探测信号已发送（品牌: gree_nec_v1），请观察空调是否有反应。",
      phase: "setup",
      deviceId: "dev-2",
      setupStep: "probing",
      probeBrand: "gree_nec_v1",
      probeStep: 1,
      probeTotal: 5,
      irCommand: {
        brand_code: "gree_nec_v1",
        protocol: "NEC",
        carrier_freq: 38000,
        raw_timing: [9000, 4500, 560, 1690],
      },
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/control")
      .send({ input: "我卧室有个空调", userId: "user-1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.phase).toBe("setup");
    expect(res.body.setupStep).toBe("probing");
    expect(res.body.probeBrand).toBe("gree_nec_v1");
    expect(res.body.probeTotal).toBe(5);
    expect(res.body.irCommand).toBeDefined();
  });

  it("should return 500 on NLP error", async () => {
    vi.mocked(processInput).mockRejectedValue(new Error("DeepSeek API error"));

    const app = makeApp();
    const res = await request(app)
      .post("/api/control")
      .send({ input: "调到26度", userId: "user-1" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("DeepSeek");
  });
});
