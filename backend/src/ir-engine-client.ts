import { IRCommand } from "./types";
import { config } from "./config";

// ============================================================
//  Mock IR engine — built-in NEC timing for common AC brands
//  Used when WAVEFORM_ENGINE_URL is unreachable (MVP mode)
// ============================================================

// NEC carrier freq: 38kHz
const CARRIER_38K = 38000;

// NEC header: 9000us mark, 4500us space
const NEC_HEADER = [9000, 4500];

// NEC bit timing: mark=560us, space=560us(0) or 1690us(1)
const NEC_BIT_MARK = 560;
const NEC_SPACE_0 = 560;
const NEC_SPACE_1 = 1690;

// Pre-defined IR frames for (temp, mode, fan) combos per brand
// Each combo → 4-byte NEC payload → raw_timing array
// Real devices have longer frames; we use 4-byte NEC for MVP demo

function necEncode(data: number): number[] {
  // Invert for standard NEC (address + ~address + command + ~command)
  const cmd = data & 0xFF;
  const invCmd = (~cmd) & 0xFF;
  const addr = 0x00; // generic address
  const invAddr = (~addr) & 0xFF;
  const payload = (addr << 24) | (invAddr << 16) | (cmd << 8) | invCmd;

  const timing: number[] = [...NEC_HEADER];
  for (let i = 31; i >= 0; i--) {
    timing.push(NEC_BIT_MARK);
    timing.push((payload >> i) & 1 ? NEC_SPACE_1 : NEC_SPACE_0);
  }
  timing.push(NEC_BIT_MARK); // final stop bit
  return timing;
}

function modeCode(mode: string): number {
  const m: Record<string, number> = { cool: 0x10, heat: 0x20, dry: 0x30, fan_only: 0x40, auto: 0x50 };
  return m[mode] || 0x10;
}

function fanCode(fan: string): number {
  const f: Record<string, number> = { auto: 0x00, low: 0x01, medium: 0x02, high: 0x03 };
  return f[fan] || 0x00;
}

function mockEncode(brandCode: string, temperature: number, mode: string, fanSpeed: string): number[] {
  // Build a simple command byte from (temp, mode, fan)
  // Format: high nibble = mode, low nibble = fan
  const cmd = modeCode(mode) | fanCode(fanSpeed);
  return necEncode(cmd);
}

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

// ============================================================
//  Public API
// ============================================================

export async function generateWaveform(
  brandCode: string,
  temperature: number,
  mode: string,
  fanSpeed: string
): Promise<IRCommand> {
  // Try real engine first
  if (!config.mockIr) {
    try {
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
    } catch (e) { /* fall through to mock */ }
  }

  // Mock
  return {
    brand_code: brandCode,
    protocol: "NEC (mock)",
    carrier_freq: CARRIER_38K,
    raw_timing: mockEncode(brandCode, temperature, mode, fanSpeed),
  };
}

export async function matchProtocol(
  rawTiming: number[],
  deviceId: string
): Promise<{ brandCode: string | null; confidence: number }> {
  if (!config.mockIr) {
    try {
      const result = await callEngine("/match", {
        raw_timing: rawTiming,
        device_id: deviceId,
      });
      return {
        brandCode: result.brand_code || null,
        confidence: result.confidence,
      };
    } catch (e) { /* fall through */ }
  }
  // Mock: just return first known brand
  return { brandCode: "gree_nec_v1", confidence: 0.8 };
}

export async function getProbeCommands(
  temperature: number = 26,
  mode: string = "cool",
  fanSpeed: string = "auto"
): Promise<IRCommand[]> {
  if (!config.mockIr) {
    try {
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
    } catch (e) { /* fall through */ }
  }

  // Mock: top 5 Chinese AC brands
  const brands = [
    "gree_nec_v1",
    "midea_nec_v1",
    "haier_nec_v1",
    "aux_nec_v1",
    "hisense_nec_v1",
  ];
  return brands.map((b) => ({
    brand_code: b,
    protocol: "NEC (mock)",
    carrier_freq: CARRIER_38K,
    raw_timing: mockEncode(b, temperature, mode, fanSpeed),
  }));
}
