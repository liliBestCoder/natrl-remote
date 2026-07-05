import { Router, Request, Response } from "express";
import { parseNaturalLanguage } from "../nlp";
import { getUserDevices, updateDeviceState } from "../device-registry";
import { generateWaveform } from "../ir-engine-client";
import { publishCommand } from "../mqtt-client";
import { DeviceState, CommandResult } from "../types";
import { config } from "../config";

export const controlRouter = Router();

controlRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { input, userId } = req.body as { input: string; userId: string };

    if (!input || !userId) {
      res.status(400).json({ error: "input and userId are required" });
      return;
    }

    // 1. Parse natural language
    const nlpResult = await parseNaturalLanguage(input);

    // 2. Low confidence → ask user to clarify
    if (nlpResult.confidence < config.nlpConfidenceThreshold) {
      const result: CommandResult = {
        success: false,
        deviceId: "",
        intent: nlpResult.parsed,
        irCommand: null,
        mqttPublished: false,
        message:
          nlpResult.needs_clarification || "Could you be more specific?",
      };
      res.status(200).json(result);
      return;
    }

    // 3. Find user's AC devices
    const userDevices = await getUserDevices(userId);
    const acDevices = userDevices.filter(
      (d) => d.deviceType === "ac" && d.verified
    );

    if (acDevices.length === 0) {
      const result: CommandResult = {
        success: false,
        deviceId: "",
        intent: nlpResult.parsed,
        irCommand: null,
        mqttPublished: false,
        message:
          "No AC devices found. Please set up your air conditioner first.",
      };
      res.status(200).json(result);
      return;
    }

    // MVP: use the first AC device
    const device = acDevices[0];

    if (!device.brandCode) {
      const result: CommandResult = {
        success: false,
        deviceId: device.id,
        intent: nlpResult.parsed,
        irCommand: null,
        mqttPublished: false,
        message:
          "AC brand not yet identified. Please complete device setup.",
      };
      res.status(200).json(result);
      return;
    }

    // 4. Compute target state from intent
    const targetState = computeTargetState(device.lastState, nlpResult.parsed);

    // 5. Generate IR waveform
    const irCommand = await generateWaveform(
      device.brandCode,
      targetState.temperature,
      targetState.mode,
      targetState.fan_speed
    );

    // 6. Publish via MQTT
    const payload = Buffer.from(
      JSON.stringify({
        raw_timing: irCommand.raw_timing,
        carrier_freq: irCommand.carrier_freq,
      })
    );
    await publishCommand(device.mqttTopic, payload);

    // 7. Update last known state
    await updateDeviceState(device.id, targetState);

    const result: CommandResult = {
      success: true,
      deviceId: device.id,
      intent: nlpResult.parsed,
      irCommand,
      mqttPublished: true,
      message: `AC set to ${targetState.temperature}°C ${targetState.mode}`,
    };
    res.status(200).json(result);
  } catch (err: any) {
    console.error("[control] error:", err);
    res.status(500).json({ error: err.message });
  }
});

function computeTargetState(current: DeviceState, intent: any): DeviceState {
  const state: DeviceState = { ...current };

  switch (intent.intent) {
    case "power_on":
      state.power = true;
      break;
    case "power_off":
      state.power = false;
      break;
    case "set_temp":
      state.power = true;
      if (intent.params.temperature !== undefined)
        state.temperature = intent.params.temperature;
      if (intent.params.mode) state.mode = intent.params.mode;
      if (intent.params.fan_speed) state.fan_speed = intent.params.fan_speed;
      break;
    case "set_mode":
      state.power = true;
      if (intent.params.mode) state.mode = intent.params.mode;
      break;
    case "set_fan_speed":
      if (intent.params.fan_speed)
        state.fan_speed = intent.params.fan_speed;
      break;
    case "query_state":
      break;
  }
  return state;
}
