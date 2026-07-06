/**
 * IR Emitter Service
 *
 * Emits IR signals using the phone's built-in IR blaster (Android)
 * or an external WiFi-to-IR bridge.
 *
 * Android: Uses ConsumerIrManager via native module
 * iOS: Not supported (no IR blaster on iPhones)
 * Web: Falls back to console log + user notification
 */

import { Platform, NativeModules } from "react-native";
import { IRCommand } from "../types";

// ─── Native module interface ───────────────────────────────────────
interface InfraredNative {
  hasIrEmitter(): Promise<boolean>;
  transmit(carrierFrequency: number, pattern: number[]): Promise<boolean>;
}

const Infrared: InfraredNative | null =
  NativeModules?.InfraredEmitter ?? null;

// ─── Public API ────────────────────────────────────────────────────

let onIrEmitted: ((cmd: IRCommand) => void) | null = null;

/** Register a callback invoked when an IR command is emitted (for UI feedback) */
export function setOnIrEmitted(cb: ((cmd: IRCommand) => void) | null) {
  onIrEmitted = cb;
}

/**
 * Check if the device supports IR emission.
 * Returns true only on Android devices with a built-in IR blaster.
 */
export async function hasIrBlaster(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    if (Infrared) {
      return await Infrared.hasIrEmitter();
    }
  } catch (_) {}
  return false;
}

/**
 * Emit an IR command through the phone's IR blaster.
 *
 * @returns true if the command was successfully emitted
 */
export async function emitIr(cmd: IRCommand): Promise<{ success: boolean; method: string }> {
  const { carrier_freq, raw_timing } = cmd;

  console.log(
    `[ir-emitter] Emitting IR: ${raw_timing.length} pulses @ ${carrier_freq}Hz, brand=${cmd.brand_code}`
  );

  // 1. Try native Android IR blaster
  if (Platform.OS === "android" && Infrared) {
    try {
      const ok = await Infrared.transmit(carrier_freq, raw_timing);
      if (ok) {
        console.log("[ir-emitter] ✅ Emitted via Android IR blaster");
        onIrEmitted?.(cmd);
        return { success: true, method: "android_native" };
      }
    } catch (e: any) {
      console.warn("[ir-emitter] Android IR failed:", e.message);
    }
  }

  // 2. Fallback: WiFi-to-IR bridge (e.g. Broadlink RM, Tuya)
  //    Uncomment and configure if you have a bridge device:
  // try {
  //   const ok = await emitViaBridge(cmd);
  //   if (ok) return { success: true, method: "wifi_bridge" };
  // } catch (_) {}

  // 3. Web/fallback: log the IR data for debugging
  console.warn(
    "[ir-emitter] ⚠️ No IR hardware available. IR data:",
    JSON.stringify({ carrier_freq, pattern_length: raw_timing.length, first_10: raw_timing.slice(0, 10) })
  );

  onIrEmitted?.(cmd);
  return { success: false, method: "none" };
}

/**
 * Emit multiple IR commands sequentially with a delay between each.
 * Used for probing: one brand gets multiple commands to maximize hit chance.
 *
 * @returns array of results for each command
 */
export async function emitIrSequence(
  cmds: IRCommand[],
  delayMs: number = 2000
): Promise<Array<{ index: number; brand: string; success: boolean; method: string }>> {
  const results: Array<{ index: number; brand: string; success: boolean; method: string }> = [];

  console.log(`[ir-emitter] 🔁 开始序列发射 ${cmds.length} 条命令, 间隔=${delayMs}ms`);

  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i];
    console.log(`[ir-emitter]   发射 ${i + 1}/${cmds.length}: ${cmd.brand_code} | ${cmd.raw_timing.length} pulses @ ${cmd.carrier_freq}Hz`);

    const result = await emitIr(cmd);
    results.push({ index: i + 1, brand: cmd.brand_code, ...result });

    // Delay between commands (skip delay after last)
    if (i < cmds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log(`[ir-emitter] ✅ 序列发射完成: ${results.filter(r => r.success).length}/${cmds.length} 成功`);
  return results;
}

/**
 * Build a human-readable description of the IR command for UI display.
 */
export function describeIrCommand(cmd: IRCommand): string {
  return [
    `品牌: ${cmd.brand_code}`,
    `协议: ${cmd.protocol}`,
    `载波: ${cmd.carrier_freq / 1000}kHz`,
    `脉冲: ${cmd.raw_timing.length}个`,
  ].join(" | ");
}
