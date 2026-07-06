import express from "express";
import { config } from "./config";
import { connectMqtt } from "./mqtt-client";
import { controlRouter } from "./routes/control";
import { devicesRouter } from "./routes/devices";

async function main() {
  // Connect MQTT on startup
  try {
    await connectMqtt();
    console.log("[server] MQTT connected");
  } catch (err) {
    console.warn(
      "[server] MQTT not available (will retry on first publish):",
      (err as Error).message
    );
  }

  const app = express();
  app.use(express.json());

  // CORS — allow web frontend from any origin (dev/phone browser)
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "natrl-backend" });
  });

  // Routes
  app.use("/api/control", controlRouter);
  app.use("/api/devices", devicesRouter);

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`[server] natrl-backend listening on 0.0.0.0:${config.port}`);
  });
}

main().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
