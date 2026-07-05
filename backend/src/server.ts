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

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "natrl-backend" });
  });

  // Routes
  app.use("/api/control", controlRouter);
  app.use("/api/devices", devicesRouter);

  app.listen(config.port, () => {
    console.log(`[server] natrl-backend listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
