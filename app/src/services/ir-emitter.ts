/**
 * IR Emitter Service
 *
 * ═══ NEW ARCHITECTURE ═══
 * 1. Encodes IR frames locally using libnatrl_ir.so (JNI native module)
 * 2. Emits via Android's ConsumerIrManager
 *
 * The .so library contains encoders ported from IRremoteESP8266 for 17 AC brands.
 * No IR waveform data flows through the backend anymore.
 */
import { Platform, NativeModules } from "react-native";
import { IRCommand } from "../types";

// ─── Debug: Raw NEC transmitter (no native code needed) ──────────

/**
 * Generate NEC IR timing pattern from 8-bit address and command.
 * Used for debug / manual code entry.
 */
export function buildNecPattern(address: number, command: number): number[] {
  const HDR_MARK = 9000;
  const HDR_SPACE = 4500;
  const BIT_MARK = 560;
  const ONE_SPACE = 1690;
  const ZERO_SPACE = 560;
  const GAP = 40000;

  const pattern: number[] = [HDR_MARK, HDR_SPACE];

  // Build 32-bit NEC frame: addr(8) + ~addr(8) + cmd(8) + ~cmd(8)
  const bytes = [
    address & 0xFF,
    (~address) & 0xFF,
    command & 0xFF,
    (~command) & 0xFF,
  ];

  for (const byte of bytes) {
    // NEC sends each byte LSB first
    for (let bit = 0; bit < 8; bit++) {
      pattern.push(BIT_MARK);
      pattern.push((byte >> bit) & 1 ? ONE_SPACE : ZERO_SPACE);
    }
  }

  // Stop bit
  pattern.push(BIT_MARK);
  pattern.push(GAP);

  return pattern;
}

/**
 * Transmit raw NEC code (address + command) via IR blaster.
 * Debug tool for testing unknown TV codes.
 */
export async function transmitRawNEC(
  address: number,
  command: number,
): Promise<{ success: boolean; method: string }> {
  const carrierFreq = 38000;
  const pattern = buildNecPattern(address, command);

  console.log(
    `[ir-emitter] Raw NEC: addr=0x${address.toString(16).toUpperCase()} cmd=0x${command.toString(16).toUpperCase()}  pulses=${pattern.length}`
  );

  if (Platform.OS === "android" && InfraredEmitter) {
    try {
      const ok = await InfraredEmitter.transmit(carrierFreq, pattern);
      if (ok) {
        return { success: true, method: "android_raw_nec" };
      }
    } catch (e: any) {
      return { success: false, method: "encode_error" };
    }
  }
  return { success: false, method: "no_hardware" };
}

// ─── Native module interfaces ──────────────────────────────────────

// ─── Native module interfaces ──────────────────────────────────────

interface InfraredEmitterNative {
  hasIrEmitter(): Promise<boolean>;
  transmit(carrierFrequency: number, pattern: number[]): Promise<boolean>;
}

interface InfraredEncoderNative {
  encode(brandCode: string, temperature: number, mode: string, fanSpeed: string, subModel?: string): Promise<{
    carrierFreq: number;
    pattern: number[];
  }>;
  encodeTV(brandCode: string, command: string): Promise<{
    carrierFreq: number;
    pattern: number[];
  }>;
  getCarrierFreq(brandCode: string): Promise<number>;
}

const InfraredEmitter: InfraredEmitterNative | null =
  NativeModules?.InfraredEmitter ?? null;

const InfraredEncoder: InfraredEncoderNative | null =
  NativeModules?.InfraredEncoder ?? null;

// ─── NEW (irext-powered): Direct raw timing transmission ────────────
//
// Backend generates raw_timing + carrier_freq → client just emits.
// No native encoder (.so) needed anymore!

export async function emitRawTiming(
  carrierFreq: number,
  rawTiming: number[],
  repeat: number = 1,
): Promise<{ success: boolean; method: string }> {
  console.log(`[ir-emitter] Raw emit: ${rawTiming.length} pulses @ ${carrierFreq}Hz x${repeat}`);

  if (Platform.OS !== "android" || !InfraredEmitter) {
    console.warn("[ir-emitter] No IR hardware available");
    return { success: false, method: "no_hardware" };
  }

  for (let i = 0; i < repeat; i++) {
    try {
      const ok = await InfraredEmitter.transmit(carrierFreq, rawTiming);
      if (!ok) {
        console.warn(`[ir-emitter] Transmit failed on repeat ${i + 1}/${repeat}`);
        if (i === 0) return { success: false, method: "transmit_failed" };
      }
      if (i < repeat - 1) {
        // Gap between repeats (typical: 45ms for TV, 100ms for AC)
        await new Promise(resolve => setTimeout(resolve, repeat > 2 ? 45 : 100));
      }
    } catch (e: any) {
      console.warn(`[ir-emitter] Transmit error: ${e.message}`);
      return { success: false, method: "transmit_error" };
    }
  }

  console.log(`[ir-emitter] Emitted ${repeat}x OK`);
  return { success: true, method: "android_raw" };
}

/**
 * Handle a tool_call that contains raw_timing directly from backend.
 * This is the NEW architecture — backend encodes, client transmits.
 */
export async function executeToolCallWithTiming(
  toolCall: { name: string; args: any; message?: string },
): Promise<{ success: boolean; method: string }> {
  const args = toolCall.args || {};
  const carrierFreq = args.carrier_freq || 38000;
  const rawTiming = args.raw_timing || [];
  const repeat = args.repeat || 1;

  if (!rawTiming || rawTiming.length === 0) {
    console.warn("[ir-emitter] No raw_timing in tool_call");
    return { success: false, method: "no_timing" };
  }

  if (toolCall.name === "control_tv") {
    // TV commands: no repeat — timing already includes protocol-specific repeat frame
    return emitRawTiming(carrierFreq, rawTiming, repeat || 1);
  }

  return emitRawTiming(carrierFreq, rawTiming, repeat);
}

// ─── Public API ────────────────────────────────────────────────────

let onIrEmitted: ((cmd: IRCommand) => void) | null = null;

export function setOnIrEmitted(cb: ((cmd: IRCommand) => void) | null) {
  onIrEmitted = cb;
}

export async function hasIrBlaster(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    if (InfraredEmitter) return await InfraredEmitter.hasIrEmitter();
  } catch (_) {}
  return false;
}

export function hasEncoder(): boolean {
  return InfraredEncoder !== null;
}

/**
 * Encode IR locally, then emit via Android IR blaster.
 *
 * @param brandCode   e.g. "gree", "midea"
 * @param temperature 16-30
 * @param mode        "cool", "heat", "dry", "fan_only", "auto"
 * @param fanSpeed    "auto", "low", "medium", "high"
 */
export async function encodeAndEmit(
  brandCode: string,
  temperature: number,
  mode: string,
  fanSpeed: string,
  subModel?: string,
): Promise<{ success: boolean; method: string }> {
  console.log(
    `[ir-emitter] Encode+Emit: brand=${brandCode}${subModel ? ` sub=${subModel}` : ""} temp=${temperature} mode=${mode} fan=${fanSpeed}`
  );

  // Step 1: Encode locally using .so library
  let carrierFreq = 38000;
  let pattern: number[] = [];

  if (InfraredEncoder) {
    try {
      const encoded = await InfraredEncoder.encode(brandCode, temperature, mode, fanSpeed, subModel);
      carrierFreq = encoded.carrierFreq;
      pattern = encoded.pattern;
      console.log(`[ir-emitter] ✅ Local encode: ${pattern.length} pulses @ ${carrierFreq}Hz`);
    } catch (e: any) {
      console.warn("[ir-emitter] ⚠️ Local encode failed:", e.message);
      return { success: false, method: "encode_error" };
    }
  } else {
    console.warn("[ir-emitter] ⚠️ No native encoder available (.so not loaded)");
    return { success: false, method: "no_encoder" };
  }

  // Step 2: Emit via Android IR blaster
  if (Platform.OS === "android" && InfraredEmitter) {
    try {
      const ok = await InfraredEmitter.transmit(carrierFreq, pattern);
      if (ok) {
        console.log("[ir-emitter] ✅ Emitted via Android IR blaster");
        const cmd: IRCommand = { brand_code: brandCode, protocol: "NEC", carrier_freq: carrierFreq, raw_timing: pattern };
        onIrEmitted?.(cmd);
        return { success: true, method: "android_native" };
      }
    } catch (e: any) {
      console.warn("[ir-emitter] Android IR failed:", e.message);
    }
  }

  // Fallback: log
  console.warn(
    "[ir-emitter] ⚠️ No IR hardware. IR data:",
    JSON.stringify({ carrier_freq: carrierFreq, pattern_length: pattern.length, first_10: pattern.slice(0, 10) })
  );
  return { success: false, method: "no_hardware" };
}

/**
 * Emit legacy IRCommand (for backward compat — when caller already has raw_timing).
 */
export async function emitIr(cmd: IRCommand): Promise<{ success: boolean; method: string }> {
  const { carrier_freq, raw_timing } = cmd;
  console.log(`[ir-emitter] Emitting (legacy): ${raw_timing.length} pulses @ ${carrier_freq}Hz, brand=${cmd.brand_code}`);

  if (Platform.OS === "android" && InfraredEmitter) {
    try {
      const ok = await InfraredEmitter.transmit(carrier_freq, raw_timing);
      if (ok) {
        onIrEmitted?.(cmd);
        return { success: true, method: "android_native" };
      }
    } catch (e: any) {
      console.warn("[ir-emitter] Android IR failed:", e.message);
    }
  }
  onIrEmitted?.(cmd);
  return { success: false, method: "none" };
}

/**
 * Encode + emit a sequence of probe commands for one brand.
 */
export async function encodeAndEmitProbeSequence(
  brandCode: string,
  commands: Array<{ temperature: number; mode: string; fanSpeed: string; power: boolean; label: string }>,
  delayMs: number = 2000,
  subModel?: string,
  onProgress?: (index: number, total: number, label: string, success: boolean) => void
): Promise<Array<{ index: number; label: string; success: boolean; method: string }>> {
  const results: Array<{ index: number; label: string; success: boolean; method: string }> = [];

  console.log(`[ir-emitter] 🔁 Probe sequence: ${commands.length} commands for ${brandCode}${subModel ? ` sub=${subModel}` : ""}`);

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const idx = i + 1;
    console.log(`[ir-emitter]   Probe ${idx}/${commands.length}: ${cmd.label}`);

    const result = await encodeAndEmit(brandCode, cmd.temperature, cmd.mode, cmd.fanSpeed, subModel);
    results.push({ index: idx, label: cmd.label, ...result });
    onProgress?.(idx, commands.length, cmd.label, result.success);

    if (i < commands.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`[ir-emitter] ✅ Probe done: ${successCount}/${commands.length} succeeded`);
  return results;
}

/**
 * Encode TV IR locally, then emit via Android IR blaster.
 */
export async function encodeAndEmitTV(
  brandCode: string,
  command: string,
): Promise<{ success: boolean; method: string }> {
  console.log(`[ir-emitter] TV encode+emit: brand=${brandCode} cmd=${command}`);

  if (InfraredEncoder) {
    try {
      const encoded = await InfraredEncoder.encodeTV(brandCode, command);
      const carrierFreq = encoded.carrierFreq;
      const pattern = encoded.pattern;
      console.log(`[ir-emitter] ✅ TV encode: ${pattern.length} pulses @ ${carrierFreq}Hz`);

      if (Platform.OS === "android" && InfraredEmitter) {
        // Transmit 3 times with 45ms gap for reliability.
        // Many TVs require the NEC command to be repeated to register.
        for (let attempt = 0; attempt < 3; attempt++) {
          const ok = await InfraredEmitter.transmit(carrierFreq, pattern);
          if (!ok && attempt === 0) {
            console.warn("[ir-emitter] ⚠️ TV transmit failed on first attempt");
            return { success: false, method: "no_hardware" };
          }
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 45));
          }
        }
        console.log("[ir-emitter] ✅ TV emitted x3 via Android IR blaster");
        return { success: true, method: "android_native" };
      }
      return { success: false, method: "no_hardware" };
    } catch (e: any) {
      console.warn("[ir-emitter] ⚠️ TV encode failed:", e.message);
      return { success: false, method: "encode_error" };
    }
  }
  return { success: false, method: "no_encoder" };
}

/**
 * Build a human-readable description of an IR command.
 */
export function describeIrCommand(cmd: IRCommand): string {
  return [
    `品牌: ${cmd.brand_code}`,
    `协议: ${cmd.protocol}`,
    `载波: ${cmd.carrier_freq / 1000}kHz`,
    `脉冲: ${cmd.raw_timing.length}个`,
  ].join(" | ");
}

