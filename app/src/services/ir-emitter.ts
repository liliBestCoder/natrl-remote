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

// ─── Native module interfaces ──────────────────────────────────────

interface InfraredEmitterNative {
  hasIrEmitter(): Promise<boolean>;
  transmit(carrierFrequency: number, pattern: number[]): Promise<boolean>;
}

interface InfraredEncoderNative {
  encode(brandCode: string, temperature: number, mode: string, fanSpeed: string): Promise<{
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
): Promise<{ success: boolean; method: string }> {
  console.log(
    `[ir-emitter] Encode+Emit: brand=${brandCode} temp=${temperature} mode=${mode} fan=${fanSpeed}`
  );

  // Step 1: Encode locally using .so library
  let carrierFreq = 38000;
  let pattern: number[] = [];

  if (InfraredEncoder) {
    try {
      const encoded = await InfraredEncoder.encode(brandCode, temperature, mode, fanSpeed);
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
  onProgress?: (index: number, total: number, label: string, success: boolean) => void
): Promise<Array<{ index: number; label: string; success: boolean; method: string }>> {
  const results: Array<{ index: number; label: string; success: boolean; method: string }> = [];

  console.log(`[ir-emitter] 🔁 Probe sequence: ${commands.length} commands for ${brandCode}`);

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const idx = i + 1;
    console.log(`[ir-emitter]   Probe ${idx}/${commands.length}: ${cmd.label}`);

    const result = await encodeAndEmit(brandCode, cmd.temperature, cmd.mode, cmd.fanSpeed);
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
        const ok = await InfraredEmitter.transmit(carrierFreq, pattern);
        if (ok) {
          console.log("[ir-emitter] ✅ TV emitted via Android IR blaster");
          return { success: true, method: "android_native" };
        }
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

