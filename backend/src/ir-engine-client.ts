import { IRCommand } from "./types";
import { config } from "./config";

async function callEngine(endpoint: string, body: object): Promise<any> {
  const url = `${config.waveformEngineUrl}${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Waveform engine error ${response.status}: ${text}`);
  }
  return response.json();
}

export async function generateWaveform(
  brandCode: string,
  temperature: number,
  mode: string,
  fanSpeed: string
): Promise<IRCommand> {
  const result = await callEngine("/generate", {
    brand_code: brandCode,
    temperature,
    mode,
    fan_speed: fanSpeed,
  });
  return {
    brand_code: result.brand_code,
    protocol: result.protocol,
    carrier_freq: result.carrier_freq,
    raw_timing: result.raw_timing,
  };
}

export async function matchProtocol(
  rawTiming: number[],
  deviceId: string
): Promise<{ brandCode: string | null; confidence: number }> {
  const result = await callEngine("/match", {
    raw_timing: rawTiming,
    device_id: deviceId,
  });
  return {
    brandCode: result.brand_code || null,
    confidence: result.confidence,
  };
}

export async function getProbeCommands(
  temperature: number = 26,
  mode: string = "cool",
  fanSpeed: string = "auto"
): Promise<IRCommand[]> {
  const result = await callEngine("/probe", {
    temperature,
    mode,
    fan_speed: fanSpeed,
  });
  return result.probes.map((p: any) => ({
    brand_code: p.brand_code,
    protocol: "NEC",
    carrier_freq: p.carrier_freq,
    raw_timing: p.raw_timing,
  }));
}
