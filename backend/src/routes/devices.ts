import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  setDevice,
  getDevice,
  getUserDevices,
  deleteDevice as removeDevice,
} from "../device-registry";
import {
  matchProtocol,
  getProbeCommands,
} from "../ir-engine-client";
import { publishCommand } from "../mqtt-client";
import { Device, ProbeSession } from "../types";

export const devicesRouter = Router();

// In-memory probe sessions (MVP: single-user)
const probeSessions = new Map<string, ProbeSession>();

// GET /api/devices?userId=X
devicesRouter.get("/", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const devices = await getUserDevices(userId);
  res.json({ devices });
});

// POST /api/devices — create a new device
devicesRouter.post("/", async (req: Request, res: Response) => {
  const { userId, room, name } = req.body as {
    userId: string;
    room: string;
    name: string;
  };
  if (!userId || !room || !name) {
    res
      .status(400)
      .json({ error: "userId, room, and name are required" });
    return;
  }

  const id = uuidv4();
  const device: Device = {
    id,
    userId,
    room,
    name,
    deviceType: "ac",
    brandCode: null,
    protocol: null,
    mqttTopic: `home/${room}/${id}`,
    lastState: {
      power: false,
      temperature: 24,
      mode: "cool",
      fan_speed: "auto",
    },
    verified: false,
    createdAt: new Date().toISOString(),
  };

  await setDevice(device);
  res.status(201).json({ device });
});

// POST /api/devices/:id/learn — trigger remote learning
devicesRouter.post("/:id/learn", async (req: Request, res: Response) => {
  const device = await getDevice(req.params.id);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }

  await publishCommand(
    device.mqttTopic,
    Buffer.from(
      JSON.stringify({ command: "learn", timeout_ms: 15000 })
    )
  );

  res.json({
    status: "learning",
    message:
      "Point your remote at the node and press the power button. Waiting 15 seconds...",
  });
});

// POST /api/devices/:id/learn/result — node reports learned signal
devicesRouter.post(
  "/:id/learn/result",
  async (req: Request, res: Response) => {
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    const { raw_timing } = req.body as { raw_timing: number[] };
    if (!raw_timing || raw_timing.length < 10) {
      res.status(400).json({ error: "Invalid IR signal" });
      return;
    }

    const match = await matchProtocol(raw_timing, device.id);

    if (match.brandCode && match.confidence > 0.5) {
      device.brandCode = match.brandCode;
      device.protocol = "NEC";
      await setDevice(device);

      res.json({
        status: "identified",
        brandCode: match.brandCode,
        confidence: match.confidence,
        message:
          "AC brand identified! Verify it works in the next step.",
      });
    } else {
      res.json({
        status: "unmatched",
        confidence: match.confidence,
        message:
          "Could not match the signal. Try again or use auto-probe instead.",
      });
    }
  }
);

// POST /api/devices/:id/probe — start cloud probing
devicesRouter.post("/:id/probe", async (req: Request, res: Response) => {
  const device = await getDevice(req.params.id);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }

  const probeCommandSets = await getProbeCommands(26, "cool", "auto");

  // Use the first command from each brand set as the representative
  const session: ProbeSession = {
    deviceId: device.id,
    steps: probeCommandSets.map((set) => ({
      brandCode: set.brand_code,
      attempted: false,
      userResponse: "pending",
      irCommand: set.commands[0],  // first command as representative
    })),
    matchedBrand: null,
    complete: false,
  };

  probeSessions.set(device.id, session);

  // Send the first probe
  const firstStep = session.steps[0];
  firstStep.attempted = true;

  const firstCmd = firstStep.irCommand;
  if (!firstCmd) {
    res.status(500).json({ error: "No IR command available for first probe step" });
    return;
  }
  const payload = Buffer.from(
    JSON.stringify({
      raw_timing: firstCmd.raw_timing,
      carrier_freq: firstCmd.carrier_freq,
    })
  );
  await publishCommand(device.mqttTopic, payload);

  res.json({
    status: "probing",
    currentBrand: firstStep.brandCode,
    step: 1,
    total: session.steps.length,
    message: `Sent probe for ${firstStep.brandCode}. Did the AC respond?`,
  });
});

// POST /api/devices/:id/probe/respond — user response to current probe
devicesRouter.post(
  "/:id/probe/respond",
  async (req: Request, res: Response) => {
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    const { responded } = req.body as { responded: boolean };

    const session = probeSessions.get(device.id);
    if (!session || session.complete) {
      res.status(400).json({ error: "No active probe session" });
      return;
    }

    const currentStep = session.steps.find(
      (s) => s.attempted && s.userResponse === "pending"
    );
    if (currentStep) {
      currentStep.userResponse = responded ? "yes" : "no";
    }

    if (responded && currentStep) {
      session.matchedBrand = currentStep.brandCode;
      session.complete = true;

      device.brandCode = currentStep.brandCode;
      device.protocol = "NEC";
      await setDevice(device);

      res.json({
        status: "identified",
        brandCode: currentStep.brandCode,
        message: `AC brand identified as ${currentStep.brandCode}! Proceed to verification.`,
      });
      return;
    }

    const nextStep = session.steps.find((s) => !s.attempted);
    if (!nextStep) {
      session.complete = true;
      res.json({
        status: "exhausted",
        message:
          "Tried all known brands. None matched. Please try remote learning or contact support.",
      });
      return;
    }

    nextStep.attempted = true;
    const nextCmd = nextStep.irCommand;
    if (!nextCmd) {
      res.status(500).json({ error: "No IR command available for next probe step" });
      return;
    }
    const payload = Buffer.from(
      JSON.stringify({
        raw_timing: nextCmd.raw_timing,
        carrier_freq: nextCmd.carrier_freq,
      })
    );
    await publishCommand(device.mqttTopic, payload);

    res.json({
      status: "probing",
      currentBrand: nextStep.brandCode,
      step: session.steps.filter((s) => s.attempted).length,
      total: session.steps.length,
      message: `Sent probe for ${nextStep.brandCode}. Did the AC respond?`,
    });
  }
);

// POST /api/devices/:id/verify
devicesRouter.post("/:id/verify", async (req: Request, res: Response) => {
  const device = await getDevice(req.params.id);
  if (!device || !device.brandCode) {
    res
      .status(400)
      .json({ error: "Device not found or brand not identified" });
    return;
  }

  const { coldConfirmed, hotConfirmed } = req.body as {
    coldConfirmed: boolean;
    hotConfirmed: boolean;
  };

  if (coldConfirmed && hotConfirmed) {
    device.verified = true;
    await setDevice(device);
    res.json({ status: "verified", message: "Your AC is ready to use!" });
  } else {
    res.json({
      status: "verification_failed",
      message:
        "Verification failed. The detected brand may be incorrect. Try probing again.",
    });
  }
});

// DELETE /api/devices/:id
devicesRouter.delete("/:id", async (req: Request, res: Response) => {
  await removeDevice(req.params.id);
  res.json({ status: "deleted" });
});
