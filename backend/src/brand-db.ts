/**
 * Brand database queries — single source of truth for brand codes & aliases.
 * Replaces hardcoded BRAND_ALIASES / BRAND_MARKET_ORDER in tools.ts.
 */
import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: "127.0.0.1",
      user: "root",
      database: "natrl",
    });
  }
  return pool;
}

export interface BrandInfo {
  brand_code: string;
  brand_name: string;
  aliases: string[];     // Chinese names
  device_type: "ac" | "tv";
  protocol: string;
  carrier_freq: number;
  priority: number;
}

let brandCache: BrandInfo[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

export async function getAllBrands(): Promise<BrandInfo[]> {
  const now = Date.now();
  if (brandCache && (now - cacheTime) < CACHE_TTL) return brandCache;

  const p = getPool();
  const [rows] = await p.query(
    `SELECT brand_code, brand_name, aliases, device_type, protocol, carrier_freq, priority
     FROM ir_protocols ORDER BY device_type, priority`
  ) as any;

  brandCache = (rows as any[]).map((r: any) => ({
    brand_code: r.brand_code,
    brand_name: r.brand_name,
    aliases: (typeof r.aliases === "string" ? JSON.parse(r.aliases) : r.aliases) || [],
    device_type: r.device_type,
    protocol: r.protocol,
    carrier_freq: r.carrier_freq,
    priority: r.priority || 0,
  }));
  cacheTime = now;
  return brandCache;
}

/** Get brand codes matching a user hint (case-insensitive) */
export async function matchBrandHint(hint: string, deviceType?: "ac" | "tv"): Promise<string[]> {
  const brands = await getAllBrands();
  const lower = hint.toLowerCase().trim();
  const matched: string[] = [];

  for (const b of brands) {
    if (deviceType && b.device_type !== deviceType) continue;
    // Match brand_code
    if (b.brand_code.toLowerCase().includes(lower) || lower.includes(b.brand_code.toLowerCase())) {
      matched.push(b.brand_code);
      continue;
    }
    // Match aliases
    for (const alias of b.aliases) {
      if (alias.toLowerCase().includes(lower) || lower.includes(alias.toLowerCase())) {
        matched.push(b.brand_code);
        break;
      }
    }
  }
  return [...new Set(matched)];
}

/** Get probe order for a given device type, with hints first */
export async function getProbeOrder(deviceType: "ac" | "tv", hint?: string): Promise<string[]> {
  const brands = await getAllBrands();
  const typeBrands = brands.filter(b => b.device_type === deviceType);
  typeBrands.sort((a, b) => a.priority - b.priority);
  let codes = typeBrands.map(b => b.brand_code);

  if (hint) {
    const hinted = await matchBrandHint(hint, deviceType);
    const others = codes.filter(c => !hinted.includes(c));
    codes = [...hinted, ...others];
  }

  return codes;
}

/** Get a human-readable display name for a brand code */
export async function getBrandDisplay(brandCode: string): Promise<string> {
  const brands = await getAllBrands();
  const b = brands.find(b => b.brand_code === brandCode);
  if (!b) return brandCode;
  const alias = b.aliases.length > 0 ? b.aliases[0] : "";
  return alias ? `${alias} (${b.brand_code})` : b.brand_code;
}
