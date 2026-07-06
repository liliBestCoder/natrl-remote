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
//
// NEC frame: [addr][~addr][cmd][~cmd]  (LSB-first)
//   addr = brand-specific (hash of brand_code)
//   cmd  = [temp_hi:4][mode:2][fan:2]
//
// Different brands produce DIFFERENT address bytes.
// Different temperatures produce DIFFERENT command bytes.

/** Simple hash: sum char codes modulo 256 → unique address per brand */
function brandAddr(brandCode: string): number {
  let sum = 0;
  for (let i = 0; i < brandCode.length; i++) {
    sum = (sum * 31 + brandCode.charCodeAt(i)) & 0xFF;
  }
  return sum;
}

function necEncode(addr: number, cmd: number): number[] {
  const invAddr = (~addr) & 0xFF;
  const invCmd = (~cmd) & 0xFF;
  const payload = (addr << 24) | (invAddr << 16) | (cmd << 8) | invCmd;

  const timing: number[] = [...NEC_HEADER];
  for (let i = 31; i >= 0; i--) {
    timing.push(NEC_BIT_MARK);
    timing.push((payload >> i) & 1 ? NEC_SPACE_1 : NEC_SPACE_0);
  }
  timing.push(NEC_BIT_MARK); // final stop bit
  return timing;
}

function modeBits(mode: string): number {
  const m: Record<string, number> = { cool: 0, heat: 1, dry: 2, fan_only: 3, auto: 0 };
  return m[mode] || 0;
}

function fanBits(fan: string): number {
  const f: Record<string, number> = { auto: 0, low: 1, medium: 2, high: 3 };
  return f[fan] || 0;
}

/**
 * Build NEC command byte:
 *   bits 7-4: temperature offset (temp - 16 → 0..15)
 *   bits 3-2: mode (0=cool, 1=heat, 2=dry, 3=fan_only)
 *   bits 1-0: fan speed (0=auto, 1=low, 2=medium, 3=high)
 */
function buildCmd(temperature: number, mode: string, fan: string): number {
  const tempBits = ((temperature - 16) & 0x0F) << 4;
  const mBits = (modeBits(mode) & 0x03) << 2;
  const fBits = fanBits(fan) & 0x03;
  return tempBits | mBits | fBits;
}

function mockEncode(brandCode: string, temperature: number, mode: string, fanSpeed: string, powerOn: boolean): number[] {
  const addr = brandAddr(brandCode);
  // Power-off sends cmd=0x00; power-on sends full state command
  const cmd = powerOn ? buildCmd(temperature, mode, fanSpeed) : 0x00;
  return necEncode(addr, cmd);
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
  fanSpeed: string,
  powerOn: boolean = true
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
    } catch (e: any) {
      console.error(`[ir-engine] ⚠️ waveform-engine /generate failed: ${e.message} → using mock`);
    }
  }

  // Mock fallback
  const timing = mockEncode(brandCode, temperature, mode, fanSpeed, powerOn);
  const addr = brandAddr(brandCode);
  console.log(`[ir-engine] generateWaveform(mock): brand=${brandCode} addr=0x${addr.toString(16).padStart(2,'0')} temp=${temperature} mode=${mode} fan=${fanSpeed} power=${powerOn} | pulses=${timing.length} | first_12=${JSON.stringify(timing.slice(0,12))}`);
  return {
    brand_code: brandCode,
    protocol: "NEC (mock)",
    carrier_freq: CARRIER_38K,
    raw_timing: timing,
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
    } catch (e: any) { console.error(`[ir-engine] ⚠️ waveform-engine /match failed: ${e.message} → using mock`); }
  }
  // Mock: just return first known brand
  return { brandCode: "gree_nec_v1", confidence: 0.8 };
}

/** Probe command combos — each brand gets 4 commands with different params */
const PROBE_COMBOS: Array<{ temp: number; mode: string; fan: string; power: boolean; label: string }> = [
  { temp: 26, mode: "cool", fan: "auto",  power: true,  label: "开机+制冷26°C+自动风" },
  { temp: 24, mode: "cool", fan: "high",  power: true,  label: "开机+制冷24°C+强风" },
  { temp: 26, mode: "heat", fan: "auto",  power: true,  label: "开机+制热26°C+自动风" },
  { temp: 18, mode: "cool", fan: "high",  power: true,  label: "开机+制冷18°C+强风" },
  { temp: 26, mode: "cool", fan: "auto",  power: false, label: "关机" },
];

export interface ProbeCommandSet {
  brand_code: string;
  commands: IRCommand[];        // multiple probe commands for this brand
}

export async function getProbeCommands(
  temperature: number = 26,
  mode: string = "cool",
  fanSpeed: string = "auto"
): Promise<ProbeCommandSet[]> {
  if (!config.mockIr) {
    try {
      const result = await callEngine("/probe", {
        temperature,
        mode,
        fan_speed: fanSpeed,
      });
      return result.probes.map((p: any) => ({
        brand_code: p.brand_code,
        commands: [{
          brand_code: p.brand_code,
          protocol: "NEC",
          carrier_freq: p.carrier_freq,
          raw_timing: p.raw_timing,
        }],
      }));
    } catch (e: any) {
      console.error(`[ir-engine] ⚠️ waveform-engine /probe failed: ${e.message} → using mock`);
    }
  }

  // Top AC brands by market share (same as database ir_protocols)
  const brands = [
    "gree",       // 格力
    "midea",      // 美的
    "haier",      // 海尔
    "tcl",        // TCL
    "kelon",      // 科龙
    "panasonic",  // 松下
    "coolix",     // Coolix
    "daikin",     // 大金
    "mitsubishi", // 三菱
    "fujitsu",    // 富士通
    "hitachi",    // 日立
    "samsung",    // 三星
    "carrier",    // 开利
    "lg",         // LG
    "toshiba",    // 东芝
    "electra",    // Electra
    "whirlpool",  // 惠而浦
  ];

  console.log(`[ir-engine] getProbeCommands: building ${brands.length} brands × ${PROBE_COMBOS.length} commands each = ${brands.length * PROBE_COMBOS.length} total`);

  const probeSets: ProbeCommandSet[] = brands.map((brandCode) => {
    const commands: IRCommand[] = PROBE_COMBOS.map((combo) => {
      const timing = mockEncode(brandCode, combo.temp, combo.mode, combo.fan, combo.power);
      const addr = brandAddr(brandCode);
      return {
        brand_code: brandCode,
        protocol: "NEC (mock)",
        carrier_freq: CARRIER_38K,
        raw_timing: timing,
      };
    });

    console.log(`[ir-engine]   ${brandCode} (addr=0x${brandAddr(brandCode).toString(16).padStart(2,'0')}): ${commands.length} commands | first_cmd[0:12]=${JSON.stringify(commands[0].raw_timing.slice(0, 12))}`);

    return { brand_code: brandCode, commands };
  });

  console.log(`[ir-engine] getProbeCommands: done, ${probeSets.length} brand sets ready`);
  return probeSets;
}
