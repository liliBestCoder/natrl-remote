/**
 * IRext Engine — IR code generation powered by irext database + irext-core.
 *
 * Architecture:
 *   - MySQL irext DB: brand → remote_index → binary_md5 → .bin file
 *   - irext-encode service: .bin + state → raw_timing
 *   - No fallback — unsupported brands return empty timing
 *
 * The frontend just receives raw_timing + carrier_freq and calls transmit().
 */

import mysql from "mysql2/promise";
import { IRCommand } from "./types";
import { config } from "./config";

// ═══════════════════════════════════════════════════════════════
//  MySQL pool — irext database
// ═══════════════════════════════════════════════════════════════

let irextPool: mysql.Pool | null = null;

function getIrextPool(): mysql.Pool {
  if (!irextPool) {
    irextPool = mysql.createPool({
      host: "127.0.0.1",
      user: "natrl",
      password: "natrl_dev",
      database: "irext",
      charset: "utf8",
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return irextPool;
}

// ═══════════════════════════════════════════════════════════════
//  Brand mapping: natrl brand_code ↔ irext brand name_en
// ═══════════════════════════════════════════════════════════════

const BRAND_CODE_TO_NAME_EN: Record<string, string> = {
  gree: "GREE",
  midea: "MIDEA",
  haier: "Haier",
  tcl: "TCL",
  kelon: "KELON",
  panasonic: "Panasonic",
  coolix: "Coolix",
  daikin: "DAIKIN",
  mitsubishi: "MITSUBISHI",
  fujitsu: "FUJITSU",
  hitachi: "HITACHI",
  samsung: "SAMSUNG",
  carrier: "Carrier",
  lg: "LG",
  toshiba: "TOSHIBA",
  electra: "Electra",
  whirlpool: "WHIRLPOOL",
  aux: "AUX",
  changhong: "CHANG HONG",
  chunlan: "CHUN LAN",
  hisense: "HISENSE",
  kongka: "KONGKA",
  zhigao: "Zhi Gao",
  skyworth: "Skyworth",
  sony: "Sony",
  sharp: "SHARP",
  philips: "Philips",
  sanyo: "Sanyo",
  // Legacy aliases
  gree_nec_v1: "GREE",
  midea_nec_v1: "MIDEA",
  haier_nec_v1: "Haier",
  aux_nec_v1: "AUX",
  daikin_nec_v1: "DAIKIN",
  panasonic_nec_v1: "Panasonic",
  hisense_nec_v1: "HISENSE",
  kelon_nec_v1: "KELON",
  changhong_nec_v1: "CHANG HONG",
};

export function resolveBrandNameEn(brandCode: string): string | null {
  if (BRAND_CODE_TO_NAME_EN[brandCode]) return BRAND_CODE_TO_NAME_EN[brandCode];
  const lower = brandCode.toLowerCase();
  for (const [k, v] of Object.entries(BRAND_CODE_TO_NAME_EN)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  Category mapping
// ═══════════════════════════════════════════════════════════════

const CATEGORY_TO_IR: Record<string, { id: number; name: string }> = {
  ac: { id: 1, name: "空调" },
  tv: { id: 2, name: "电视机" },
  stb: { id: 3, name: "机顶盒" },
  fan: { id: 7, name: "风扇" },
  dvd: { id: 6, name: "DVD" },
  projector: { id: 8, name: "投影仪" },
  audio: { id: 9, name: "音响" },
  light: { id: 10, name: "灯" },
  cleaner: { id: 12, name: "扫地机器人" },
  purifier: { id: 13, name: "空气净化器" },
  heater: { id: 16, name: "热水器" },
};

// ═══════════════════════════════════════════════════════════════
//  Carrier frequency lookup
// ═══════════════════════════════════════════════════════════════

const CARRIER_DEFAULT = 38000;
const CARRIER_BY_PROTOCOL: Record<string, number> = {
  nec: 38000, nec1: 38000, necx: 38000,
  rc5: 36000, rc6: 36000, rcmm: 36000,
  sony: 40000, sirc: 40000,
  panasonic: 36700,
  whirlpool: 38400,
};

function getCarrierFreq(protocol: string): number {
  const lower = protocol?.toLowerCase() || "";
  if (CARRIER_BY_PROTOCOL[lower]) return CARRIER_BY_PROTOCOL[lower];
  for (const [k, v] of Object.entries(CARRIER_BY_PROTOCOL)) {
    if (lower.includes(k)) return v;
  }
  return CARRIER_DEFAULT;
}

// ═══════════════════════════════════════════════════════════════
//  Key aliases
// ═══════════════════════════════════════════════════════════════

const KEY_ALIASES: Record<string, string[]> = {
  power: ["power", "POWER", "on_off", "onoff"],
  mute: ["mute", "MUTE", "muting"],
  vol_up: ["vol+", "vol_up", "volume_up", "volume+", "VOL_PLUS"],
  vol_down: ["vol-", "vol_down", "volume_down", "volume-", "VOL_NEG"],
  ch_up: ["ch+", "ch_up", "channel_up", "channel+", "CH_PLUS", "program_up"],
  ch_down: ["ch-", "ch_down", "channel_down", "channel-", "CH_NEG"],
  up: ["up", "UP", "arrow_up", "navigation_up"],
  down: ["down", "DOWN", "arrow_down"],
  left: ["left", "LEFT", "arrow_left"],
  right: ["right", "RIGHT", "arrow_right"],
  ok: ["ok", "OK", "enter", "select", "confirm"],
  menu: ["menu", "MENU", "settings"],
  back: ["back", "BACK", "return", "RETURN"],
  exit: ["exit", "EXIT", "quit"],
  home: ["home", "HOME", "smart", "SMART"],
  info: ["info", "INFO", "display", "DISPLAY"],
  input: ["input", "INPUT", "source", "SOURCE", "av", "TV/AV", "hdmi"],
};

function normalizeKeyName(command: string): string[] {
  if (KEY_ALIASES[command]) return KEY_ALIASES[command];
  for (const aliases of Object.values(KEY_ALIASES)) {
    if (aliases.includes(command)) return aliases;
  }
  return [command];
}

// ═══════════════════════════════════════════════════════════════
//  Database queries
// ═══════════════════════════════════════════════════════════════

interface RemoteIndexRow {
  id: number;
  protocol: string;
  remote: string;
  remote_map: string;
  binary_md5: string;
  brand_name: string;
}

async function findRemoteIndex(brandNameEn: string, categoryId: number): Promise<RemoteIndexRow | null> {
  const p = getIrextPool();
  const [rows] = await p.query(
    `SELECT ri.id, ri.protocol, ri.remote, ri.remote_map, ri.binary_md5, b.name_en as brand_name
     FROM remote_index ri
     JOIN brand b ON ri.brand_id = b.id
     WHERE UPPER(b.name_en) = UPPER(?) AND ri.category_id = ?
     ORDER BY ri.id ASC LIMIT 1`,
    [brandNameEn, categoryId],
  ) as any;
  if (rows.length > 0) return rows[0] as RemoteIndexRow;

  // Fuzzy match
  const [rows2] = await p.query(
    `SELECT ri.id, ri.protocol, ri.remote, ri.remote_map, ri.binary_md5, b.name_en as brand_name
     FROM remote_index ri
     JOIN brand b ON ri.brand_id = b.id
     WHERE b.name_en LIKE ? AND ri.category_id = ?
     ORDER BY ri.id ASC LIMIT 1`,
    [`%${brandNameEn}%`, categoryId],
  ) as any;
  if (rows2.length > 0) return rows2[0] as RemoteIndexRow;
  return null;
}

function parseTimingCSV(csv: string): number[] {
  if (!csv || typeof csv !== "string") return [];
  return csv.split(",").filter(s => s.trim() !== "").map(Number).filter(n => !isNaN(n));
}

async function lookupKeyTiming(
  remoteIndexId: number,
  keyNames: string[],
): Promise<{ key_name: string; key_value: number[] } | null> {
  const p = getIrextPool();
  const placeholders = keyNames.map(() => "?").join(",");
  const [rows] = await p.query(
    `SELECT key_name, key_value FROM decode_remote
     WHERE remote_index_id = ? AND key_name IN (${placeholders})
     LIMIT 1`,
    [remoteIndexId, ...keyNames],
  ) as any;

  if (rows.length > 0) {
    return { key_name: rows[0].key_name, key_value: parseTimingCSV(rows[0].key_value) };
  }

  // Try LIKE
  for (const kn of keyNames) {
    const [rows2] = await p.query(
      `SELECT key_name, key_value FROM decode_remote
       WHERE remote_index_id = ? AND key_name LIKE ?
       LIMIT 1`,
      [remoteIndexId, `%${kn}%`],
    ) as any;
    if (rows2.length > 0) {
      return { key_name: rows2[0].key_name, key_value: parseTimingCSV(rows2[0].key_value) };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  irext-encode service client
// ═══════════════════════════════════════════════════════════════

const IREXT_ENCODE_URL = process.env.IREXT_ENCODE_URL || "http://localhost:8002";

/** Resolve brand → binary_md5 via irext MySQL. Optionally filter by remote variant name. */
async function resolveBinaryMd5(
  brandNameEn: string,
  categoryId: number,
  remote?: string,
): Promise<string | null> {
  const p = getIrextPool();
  if (remote) {
    // Exact match by variant name (e.g., "remote_tv_018")
    const [rows] = await p.query(
      `SELECT ri.binary_md5 FROM remote_index ri
       JOIN brand b ON ri.brand_id = b.id
       WHERE UPPER(b.name_en) = UPPER(?) AND ri.category_id = ? AND ri.remote = ?
       LIMIT 1`,
      [brandNameEn, categoryId, remote],
    ) as any;
    if (rows.length > 0) return rows[0].binary_md5;
    // Fallback: try LIKE match
    const [rows2] = await p.query(
      `SELECT ri.binary_md5 FROM remote_index ri
       JOIN brand b ON ri.brand_id = b.id
       WHERE UPPER(b.name_en) = UPPER(?) AND ri.category_id = ? AND ri.remote LIKE ?
       LIMIT 1`,
      [brandNameEn, categoryId, `%${remote}%`],
    ) as any;
    if (rows2.length > 0) return rows2[0].binary_md5;
  }
  // No remote filter — return first variant
  const [rows] = await p.query(
    `SELECT ri.binary_md5 FROM remote_index ri
     JOIN brand b ON ri.brand_id = b.id
     WHERE UPPER(b.name_en) = UPPER(?) AND ri.category_id = ?
     LIMIT 1`,
    [brandNameEn, categoryId],
  ) as any;
  if (rows.length === 0) return null;
  return rows[0].binary_md5;
}

async function callEncodeAC(md5: string, temperature: number, mode: string, fanSpeed: string, powerOn: boolean): Promise<number[]> {
  const resp = await fetch(`${IREXT_ENCODE_URL}/encode_ac`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ binary_md5: md5, temperature, mode, fan_speed: fanSpeed, power: powerOn }),
  });
  if (!resp.ok) throw new Error(`irext-encode /encode_ac: ${resp.status}`);
  const data = await resp.json();
  return data.raw_timing;
}

async function callEncodeKey(md5: string, category: number, keyCode: number): Promise<number[]> {
  const resp = await fetch(`${IREXT_ENCODE_URL}/encode_key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ binary_md5: md5, category, key_code: keyCode }),
  });
  if (!resp.ok) throw new Error(`irext-encode /encode_key: ${resp.status}`);
  const data = await resp.json();
  return data.raw_timing;
}

// ═══════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════

/** Map natrl command → irext TV key code */
const TV_KEY_MAP: Record<string, number> = {
  power: 0, mute: 1, up: 2, down: 3, left: 4, right: 5,
  ok: 6, vol_up: 7, vol_down: 8, back: 9, input: 10,
  menu: 11, home: 12, settings: 13,
  // Number keys 0-9 → 14-23
  "0": 14, "1": 15, "2": 16, "3": 17, "4": 18,
  "5": 19, "6": 20, "7": 21, "8": 22, "9": 23,
};

/**
 * Get raw timing for a fixed-function device key (TV, STB, fan, etc.)
 * Uses .bin encoding (irext-encode) for correct per-key timing.
 * @param subModel — optional remote variant name (e.g., "remote_tv_018").
 */
export async function getFixedKeyTiming(
  brandCode: string,
  deviceType: string,
  command: string,
  subModel?: string | null,
): Promise<IRCommand | null> {
  const brandNameEn = resolveBrandNameEn(brandCode);
  if (!brandNameEn) {
    console.log(`[irext] ⚠ Unknown brand: ${brandCode}`);
    return null;
  }
  const cat = CATEGORY_TO_IR[deviceType];
  if (!cat) {
    console.log(`[irext] ⚠ Unknown device type: ${deviceType}`);
    return null;
  }

  // Use .bin encoding via irext-encode
  const md5 = await resolveBinaryMd5(brandNameEn, cat.id, subModel || undefined);
  if (!md5) {
    console.log(`[irext] ⚠ No .bin for ${brandNameEn}/${cat.name}${subModel ? ` variant=${subModel}` : ""}`);
    return null;
  }

  const keyCode = TV_KEY_MAP[command] ?? 0;
  try {
    const timing = await callEncodeKey(md5, cat.id, keyCode);
    console.log(`[irext] ✅ ${brandNameEn} ${command}(key=${keyCode})${subModel ? ` var=${subModel}` : ""}: ${timing.length} pulses`);
    return { brand_code: brandCode, protocol: "irext", carrier_freq: 38000, raw_timing: timing };
  } catch (e: any) {
    console.error(`[irext] Key encode failed for ${brandNameEn}/${command}: ${e.message}`);
    return null;
  }
}

/**
 * Get raw timing for an AC (dynamic state). Uses irext-encode service.
 */
export async function getACTiming(
  brandCode: string,
  temperature: number,
  mode: string,
  fanSpeed: string,
  powerOn: boolean = true,
): Promise<IRCommand> {
  const brandNameEn = resolveBrandNameEn(brandCode);
  if (!brandNameEn) {
    console.log(`[irext] ⚠ Unknown AC brand: ${brandCode} — not in brand map`);
    return { brand_code: brandCode, protocol: "unsupported", carrier_freq: 38000, raw_timing: [] };
  }

  const md5 = await resolveBinaryMd5(brandNameEn, 1);
  if (!md5) {
    console.log(`[irext] ⚠ No .bin for ${brandNameEn} AC — brand not in irext database`);
    return { brand_code: brandCode, protocol: "unsupported", carrier_freq: 38000, raw_timing: [] };
  }

  try {
    const timing = await callEncodeAC(md5, temperature, mode, fanSpeed, powerOn);
    console.log(`[irext] ✅ AC: ${brandNameEn} t=${temperature} ${mode} ${fanSpeed}: ${timing.length} pulses`);
    return { brand_code: brandCode, protocol: "irext", carrier_freq: 38000, raw_timing: timing };
  } catch (e: any) {
    console.error(`[irext] ❌ AC encode failed for ${brandCode}/${brandNameEn}: ${e.message}`);
    return { brand_code: brandCode, protocol: "encode_failed", carrier_freq: 38000, raw_timing: [] };
  }
}

/**
 * Encode AC state using a specific binary_md5 (bypasses brand resolution).
 * For probing individual remote variants.
 */
export async function encodeACByMd5(
  binaryMd5: string,
  temperature: number,
  mode: string,
  fanSpeed: string,
  powerOn: boolean,
): Promise<{ raw_timing: number[]; carrier_freq: number }> {
  try {
    const timing = await callEncodeAC(binaryMd5, temperature, mode, fanSpeed, powerOn);
    return { raw_timing: timing, carrier_freq: 38000 };
  } catch (e: any) {
    console.error(`[irext] AC encode by md5 ${binaryMd5.slice(0, 8)}: ${e.message}`);
    return { raw_timing: [], carrier_freq: 38000 };
  }
}

/**
 * Encode a fixed key using a specific binary_md5 (bypasses brand resolution).
 */
export async function encodeKeyByMd5(
  binaryMd5: string,
  category: number,
  keyCode: number,
): Promise<{ raw_timing: number[]; carrier_freq: number }> {
  try {
    const timing = await callEncodeKey(binaryMd5, category, keyCode);
    return { raw_timing: timing, carrier_freq: 38000 };
  } catch (e: any) {
    console.error(`[irext] Key encode by md5 ${binaryMd5.slice(0, 8)}: ${e.message}`);
    return { raw_timing: [], carrier_freq: 38000 };
  }
}

/** Export pool for external modules (tools.ts needs it for getRemoteVariants) */
export { getIrextPool };
