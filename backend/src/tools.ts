/**
 * Tool Definitions & Executors
 *
 * DeepSeek function calling tools. The LLM decides which tool(s) to call
 * and what arguments to pass. The backend just executes and returns results.
 *
 * ═══ NEW ARCHITECTURE ═══
 * Backend: NLP intent analysis → produces tool_call JSON (parameters only)
 * Client:  Receives tool_call → calls local .so library (IRremoteESP8266)
 *          → generates raw_timing → emits via Android ConsumerIrManager
 *
 * No IR waveform data flows through the backend anymore.
 * The .so library is compiled locally and packaged with the APK.
 *
 * IR limitation: infrared is TRANSMIT-ONLY. We cannot read physical state.
 */

import { v4 as uuidv4 } from "uuid";
import {
  getUserDevices, getDevice, setDevice, updateDeviceState, deleteDevice,
} from "./device-registry";
import { Device, DeviceState, ToolCall, ProbeSession } from "./types";
import { SessionState } from "./session-store";

// ─── Tool Context (mutable, accumulates results for frontend response) ───

export interface ToolContext {
  userId: string;
  session: SessionState;              // Live session state (read/write)
  message: string;
  toolCall?: ToolCall;                // single tool call for client to execute
  phase: "discovery" | "registration" | "control";
  setupStep?: "probing" | "verifying" | "done";
  deviceId?: string;
  probeBrand?: string;
  probeStep?: number;
  probeTotal?: number;
}

// ─── In-memory state (probe sessions) ───────────────────────────────

const probeSessions = new Map<string, ProbeSession>();

import { matchBrandHint, getProbeOrder, getBrandDisplay } from "./brand-db";

// ─── Tool Definitions (DeepSeek format) ──────────────────────────────

export const TOOL_DEFINITIONS = [
  // ── Device Discovery ──
  {
    type: "function" as const,
    function: {
      name: "discover_device",
      description:
        "注册新设备。当用户说家里有某个设备时调用（如'我卧室有个空调'）。" +
        "调用后需要继续调用 probe_brand 来识别红外品牌。",
      parameters: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间名，中文如'卧室'、'客厅'" },
          device_type: {
            type: "string",
            enum: ["ac", "tv", "fan"],
            description: "设备类型",
          },
          device_name: {
            type: "string",
            description: "用户给设备的称呼，如'卧室空调'",
          },
        },
        required: ["room", "device_type"],
      },
    },
  },

  // ── Brand Probing ──
  {
    type: "function" as const,
    function: {
      name: "probe_brand",
      description:
        "云端红外品牌探测。对一个品牌发送多条不同参数的红外命令（开机制冷、制热、关机等），" +
        "让用户观察空调是否有任何反应（蜂鸣、灯闪、开机等）。" +
        "每次调用尝试一个品牌的多条命令，用户反馈'有反应'或'没反应'后决定下一步。" +
        "通常在 discover_device 之后自动调用。" +
        "如果用户主动说了品牌（如'格力'、'whirlpool'），请将品牌名填入 brand_hint 参数，系统会优先尝试该品牌。" +
        "如果用户不知道品牌，不要传 brand_hint，系统会按市场占有率从高到低自动探测。" +
        "重要：调用此函数前必须先询问用户品牌。如果用户说了品牌，立即调用不要重复询问。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备ID。不传则使用最新未验证的设备。",
          },
          brand_hint: {
            type: "string",
            description: "用户提供的品牌名（中文或英文），如'格力'、'美的'、'gree'、'whirlpool'。不知道则不传。",
          },
        },
        required: [],
      },
    },
  },

  {
    type: "function" as const,
    function: {
      name: "respond_probe",
      description:
        "处理用户对探测信号的反馈。每次探测对一个品牌发送多条红外命令。" +
        "用户说'有反应'→reacted=true，品牌匹配成功，进入阶段2。" +
        "用户说'没反应'→reacted=false，系统自动尝试下一个品牌。" +
        "不要等待用户确认，探测中一直循环直到有反应或全部试完。",
      parameters: {
        type: "object",
        properties: {
          reacted: {
            type: "boolean",
            description: "空调是否有反应（开机/蜂鸣/灯闪等）",
          },
        },
        required: ["reacted"],
      },
    },
  },

  {
    type: "function" as const,
    function: {
      name: "verify_device",
      description:
        "确认探测识别的品牌是否正确。用户确认后设备变为可用状态（verified）。" +
        "用户说'正常'/'可以'→confirmed=true，'不对'→confirmed=false。",
      parameters: {
        type: "object",
        properties: {
          confirmed: { type: "boolean", description: "品牌是否正确" },
        },
        required: ["confirmed"],
      },
    },
  },

  {
    type: "function" as const,
    function: {
      name: "register_device",
      description:
        "注册设备（起别名并激活）。探测成功后调用，用户提供设备名字。" +
        "例如用户说'叫大白' → name='大白'。注册成功后设备进入阶段3（日常使用）。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "用户给设备起的名字",
          },
        },
        required: ["name"],
      },
    },
  },

  // ── Daily Control ──
  {
    type: "function" as const,
    function: {
      name: "control_ac",
      description:
        "控制空调。通过红外发射指令。只能发送指令，无法读取空调的真实物理状态。" +
        "参数中只需要提供要修改的项，未提供的项保持不变。" +
        "例如'调到26度'→{temperature:26}，'开机'→{power:true}，" +
        "'制冷26度大风'→{mode:'cool',temperature:26,fan_speed:'high'}。",
      parameters: {
        type: "object",
        properties: {
          power: {
            type: "boolean",
            description: "true=开机 false=关机",
          },
          temperature: {
            type: "integer",
            minimum: 16,
            maximum: 30,
            description: "目标温度(°C)",
          },
          mode: {
            type: "string",
            enum: ["cool", "heat", "dry", "fan_only", "auto"],
            description: "工作模式",
          },
          fan_speed: {
            type: "string",
            enum: ["low", "medium", "high", "auto"],
            description: "风速",
          },
          device_id: {
            type: "string",
            description: "设备ID。不传则使用第一个已验证的设备。",
          },
        },
        required: [],
      },
    },
  },

  // ── TV Control ──
  {
    type: "function" as const,
    function: {
      name: "control_tv",
      description:
        "控制电视。通过红外发射指令。" +
        "常用命令: power(开关), vol_up(音量+), vol_down(音量-), ch_up(频道+), ch_down(频道-), mute(静音), input(信号源)," +
        "up(上), down(下), left(左), right(右), ok(确认), menu(菜单), back(返回), exit(退出), home(主页), info(信息)。" +
        "例如'打开电视'→{command:'power'}，'回到主页'→{command:'home'}，'打开菜单'→{command:'menu'}。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["power", "vol_up", "vol_down", "ch_up", "ch_down", "mute", "input",
                   "up", "down", "left", "right", "ok", "menu", "back", "exit", "home", "info"],
            description: "电视命令",
          },
          device_id: {
            type: "string",
            description: "设备ID。不传则使用第一个已验证的电视。",
          },
        },
        required: ["command"],
      },
    },
  },

  // ── State Query ──
  {
    type: "function" as const,
    function: {
      name: "get_device_state",
      description:
        "查询设备的上次设置状态。注意：红外是单向通信，此函数返回的是" +
        "上次发送的指令值，不一定是空调当前的实际状态。" +
        "回复用户时必须说明这是'上次设置的值'，非实时读数。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备ID。不传则使用第一个已验证的设备。",
          },
        },
        required: [],
      },
    },
  },

  // ── Device Management ──
  {
    type: "function" as const,
    function: {
      name: "list_devices",
      description: "列出用户的所有设备及状态。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  {
    type: "function" as const,
    function: {
      name: "remove_device",
      description: "删除一个设备。用户说'删掉'、'移除'时调用。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "要删除的设备ID",
          },
        },
        required: ["device_id"],
      },
    },
  },
];

// ─── Tool Executors ──────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<string> {
  // Dispatch
  switch (name) {
    case "discover_device":
      return execDiscoverDevice(args, ctx);
    case "probe_brand":
      return execProbeBrand(args, ctx);
    case "respond_probe":
      return execRespondProbe(args, ctx);
    case "verify_device":
      return execVerifyDevice(args, ctx);
    case "control_ac":
      return execControlAc(args, ctx);
    case "control_tv":
      return execControlTv(args, ctx);
    case "get_device_state":
      return execGetDeviceState(args, ctx);
    case "list_devices":
      return execListDevices(args, ctx);
    case "register_device":
      return execRegisterDevice(args, ctx);
    case "remove_device":
      return execRemoveDevice(args, ctx);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Individual Executors ─────────────────────────────────────────────

async function execDiscoverDevice(
  args: any,
  ctx: ToolContext
): Promise<string> {
  const room = args.room || "room";
  const deviceType = args.device_type || "ac";
  const devName =
    args.device_name ||
    (room === "卧室" || room === "bedroom"
      ? "卧室空调"
      : room === "客厅" || room === "living_room"
      ? "客厅空调"
      : "空调");

  // Don't create device yet — only create after probing succeeds.
  // Store intent in session for probe_brand to use.
  const pendingId = uuidv4();
  ctx.phase = "discovery";
  ctx.deviceId = pendingId;

  ctx.session.phase = "discovery";
  ctx.session.deviceId = pendingId;
  ctx.session.deviceType = deviceType;
  ctx.session.room = room;
  ctx.session.pendingDeviceName = devName;
  ctx.session.probingActive = false;
  ctx.session.matchedBrand = null as any;
  ctx.session.brandHint = undefined;

  // Clean up any stale probe sessions for this user
  for (const [id, s] of probeSessions.entries()) {
    if (s.complete || s.deviceId === pendingId) probeSessions.delete(id);
  }

  return JSON.stringify({
    success: true,
    device_id: pendingId,
    device_name: devName,
    room: room,
    device_type: deviceType,
    verified: false,
    hint: "请询问用户空调品牌，然后调用 probe_brand 开始探测。只有探测成功确认品牌后，设备才会被创建。",
  });
}

async function execProbeBrand(
  args: any,
  ctx: ToolContext
): Promise<string> {
  let deviceId = args.device_id || ctx.session.deviceId;
  if (!deviceId) {
    return JSON.stringify({
      error: "没有待探测的设备。请先调用 discover_device。",
    });
  }

  // Use session data (device not yet created in DB)
  const room = ctx.session.room || "卧室";

  // ── Auto-detect deviceType from brand_hint ──
  // If the LLM skipped discover_device, session.deviceType may be wrong or unset.
  // Use brand_hint to cross-check against the database.
  const hint = args.brand_hint?.trim();
  let effectiveDeviceType: "ac" | "tv" = (ctx.session.deviceType === "tv" ? "tv" : "ac");

  if (hint) {
    const acMatches = await matchBrandHint(hint, "ac");
    const tvMatches = await matchBrandHint(hint, "tv");

    if (acMatches.length > 0 && tvMatches.length === 0) {
      // Hint only matches AC brands → force AC
      if (effectiveDeviceType !== "ac") {
        console.log(`[probe] 🔄 品牌"${hint}"仅匹配AC，设备类型从 ${effectiveDeviceType} 纠正为 ac`);
        effectiveDeviceType = "ac";
      }
    } else if (tvMatches.length > 0 && acMatches.length === 0) {
      // Hint only matches TV brands → force TV
      if (effectiveDeviceType !== "tv") {
        console.log(`[probe] 🔄 品牌"${hint}"仅匹配TV，设备类型从 ${effectiveDeviceType} 纠正为 tv`);
        effectiveDeviceType = "tv";
      }
    }
    // If matches both or neither, keep current deviceType
  }

  // Persist corrected deviceType back to session
  ctx.session.deviceType = effectiveDeviceType;
  const devName = ctx.session.pendingDeviceName
    || (effectiveDeviceType === "tv" ? "电视" : "空调");

  // Get all brand codes to probe
  const allBrands = await getProbeOrder(effectiveDeviceType);

  // Reorder based on brand hint
  let orderedBrands = allBrands;
  if (hint) {
    ctx.session.brandHint = hint;
    const matchedCodes = await matchBrandHint(hint, effectiveDeviceType);
    console.log(`[probe] 用户提示品牌: "${hint}" (deviceType=${effectiveDeviceType}) → 匹配: ${matchedCodes.length > 0 ? matchedCodes.join(", ") : "无"}`);
    if (matchedCodes.length > 0) {
      orderedBrands = [...matchedCodes.filter(b => allBrands.includes(b)), ...allBrands.filter(b => !matchedCodes.includes(b))];
      console.log(`[probe] 重排: ${orderedBrands.join(" → ")}`);
    } else {
      console.log(`[probe] ⚠️ 品牌"${hint}"不在${effectiveDeviceType}库中，按默认顺序探测`);
    }
  } else {
    ctx.session.brandHint = undefined;
    console.log(`[probe] 无品牌提示，默认顺序探测 (deviceType=${effectiveDeviceType})`);
  }

  // ── Build probe session (one step per brand) ──
  const session: ProbeSession = {
    deviceId,
    steps: orderedBrands.map((brandCode) => ({
      brandCode,
      attempted: false,
      userResponse: "pending",
      irCommand: null as any, // no IR generated server-side anymore
    })),
    matchedBrand: null,
    complete: false,
  };
  probeSessions.set(deviceId, session);

  // ── Pick FIRST brand, prepare probe commands ──
  const firstBrandCode = orderedBrands[0];
  const firstStep = session.steps[0];
  firstStep.attempted = true;

  const isTV = effectiveDeviceType === "tv";

  // Probe commands (params only, client encodes with .so)
  const probeCombos = isTV
    ? [{ temperature: 0, mode: "", fan_speed: "", power: true, label: "开机/关机" } as any]
    : [
        { temperature: 26, mode: "cool", fan_speed: "auto",  power: true,  label: "开机+制冷26°C+自动风" },
        { temperature: 24, mode: "cool", fan_speed: "high",  power: true,  label: "开机+制冷24°C+强风" },
        { temperature: 26, mode: "heat", fan_speed: "auto",  power: true,  label: "开机+制热26°C+自动风" },
        { temperature: 18, mode: "cool", fan_speed: "high",  power: true,  label: "开机+制冷18°C+强风" },
        { temperature: 26, mode: "cool", fan_speed: "auto",  power: false, label: "关机" },
      ];

  console.log(`[probe] ───── 第 1/${orderedBrands.length} 个品牌: ${firstBrandCode} (${isTV ? "TV" : "AC"}) ─────`);
  console.log(`[probe] 准备 ${probeCombos.length} 条探测命令(客户端本地编码)`);

  // Build tool_call for client
  const brandDisplay = await getBrandDisplay(firstBrandCode);
  const cmdDesc = probeCombos.map((c: any, i: number) => `  命令${i + 1}: ${c.label}`).join("\n");
  const hintMsg = hint ? `\n🎯 优先尝试: "${hint}" → ${brandDisplay}` : "";
  const deviceWord = isTV ? "电视" : "空调";

  const toolCall: ToolCall = {
    name: "probe_brand",
    args: {
      brand_code: firstBrandCode,
      probe_brand: brandDisplay,
      probe_step: 1,
      probe_total: orderedBrands.length,
      probe_commands: probeCombos.map((c: any) => ({
        temperature: c.temperature || 0,
        mode: c.mode || "",
        fan_speed: c.fan_speed || "",
        power: c.power,
        label: c.label,
      })),
    },
    message: `📡 正在探测品牌: **${brandDisplay}** (第 1/${orderedBrands.length} 个)${hintMsg}\n\n发送了 ${probeCombos.length} 条红外命令：\n${cmdDesc}\n\n⚠️ 手机将依次发射这些命令（间隔约2秒）。\n请观察${deviceWord}：\n• ${isTV ? "电视有开机/关机反应" : "听到\"嘀\"声或蜂鸣"} → 说"有反应"\n• 完全没动静 → 说"没反应"`,
  };

  ctx.toolCall = toolCall;
  ctx.phase = "discovery";
  ctx.setupStep = "probing";
  ctx.deviceId = deviceId;
  ctx.probeBrand = firstBrandCode;
  ctx.probeStep = 1;
  ctx.probeTotal = orderedBrands.length;

  // Update session
  ctx.session.phase = "discovery";
  ctx.session.probingActive = true;
  ctx.session.probeStep = 1;
  ctx.session.probeTotal = orderedBrands.length;
  ctx.session.currentProbeBrand = firstBrandCode;
  ctx.session.deviceId = deviceId;

  console.log(`[probe] ✅ 品牌 ${firstBrandCode} 的 ${probeCombos.length} 条命令参数已准备`);

  return JSON.stringify({
    success: true,
    brand_code: firstBrandCode,
    brand_display: brandDisplay,
    command_count: probeCombos.length,
    step: 1,
    total: orderedBrands.length,
    tool_call: toolCall,
  });
}



async function execRespondProbe(
  args: any,
  ctx: ToolContext
): Promise<string> {
  const reacted: boolean = args.reacted;

  // Find active probe session
  let deviceId: string | null = null;
  for (const [id, s] of probeSessions.entries()) {
    if (!s.complete) {
      deviceId = id;
      break;
    }
  }

  if (!deviceId) {
    return JSON.stringify({
      error: "没有正在进行的探测。请先调用 discover_device 再 probe_brand。",
    });
  }

  // Device not yet created in DB — use session data
  const session = probeSessions.get(deviceId)!;

  // Find the current (attempted but pending) step
  const currentStepIndex = session.steps.findIndex(
    (s) => s.attempted && s.userResponse === "pending"
  );
  const currentStep = currentStepIndex >= 0 ? session.steps[currentStepIndex] : null;

  if (currentStep) {
    currentStep.userResponse = reacted ? "yes" : "no";
    console.log(`[probe] 用户反馈: ${reacted ? "有反应 ✅" : "没反应 ❌"} → 品牌 ${currentStep.brandCode} → ${currentStep.userResponse}`);
  }

  ctx.deviceId = deviceId;

  if (reacted && currentStep) {
    // ── Brand matched! Create device in DB now ──
    session.matchedBrand = currentStep.brandCode;
    session.complete = true;
    probeSessions.delete(deviceId);

    const now = new Date().toISOString();
    const room = ctx.session.room || "卧室";
    const devName = ctx.session.pendingDeviceName || `${room}空调`;
    const newDevice: Device = {
      id: deviceId,
      userId: ctx.userId,
      room,
      name: devName,
      deviceType: (ctx.session.deviceType as Device["deviceType"]) || "ac",
      brandCode: currentStep.brandCode,
      protocol: "NEC",
      mqttTopic: `home/${room}/${deviceId}`,
      lastState: { power: false, temperature: 24, mode: "cool", fan_speed: "auto" },
      verified: true,
      createdAt: now,
    };
    await setDevice(newDevice);

    const attemptedCount = session.steps.filter((s: import("./types").ProbeStep) => s.attempted).length;
    console.log(`[probe] ✅ 匹配成功! 品牌: ${currentStep.brandCode} (第 ${attemptedCount}/${session.steps.length} 个尝试) → 设备已创建并验证`);

    ctx.phase = "control";
    ctx.session.phase = "control";
    ctx.session.matchedBrand = currentStep.brandCode;
    ctx.session.probingActive = false;
    ctx.setupStep = undefined;

    const brandName = await getBrandDisplay(currentStep.brandCode);
    return JSON.stringify({
      success: true,
      matched_brand: currentStep.brandCode,
      matched_brand_display: brandName,
      attempts: attemptedCount,
      total: session.steps.length,
      status: "device_ready",
      device_id: deviceId,
      message: `🎉 探测成功！已识别为 **${brandName}**，设备「${devName}」已就绪。你可以直接说"打开${ctx.session.deviceType === 'tv' ? '电视' : '空调'}"来控制。`,
      hint: "设备已自动创建并验证。注意：不要调用 register_device，设备已就绪可直接控制。",
    });
  }

  // ── Not matched → try next brand ──
  const nextUnattempted = session.steps.findIndex((s: import("./types").ProbeStep) => !s.attempted);

  if (nextUnattempted < 0) {
    // All brands exhausted
    session.complete = true;
    probeSessions.delete(deviceId);

    ctx.session.probingActive = false;
    ctx.session.phase = "discovery";
    ctx.phase = "discovery";
    ctx.setupStep = undefined;

    console.log(`[probe] ❌ 所有 ${session.steps.length} 个品牌已探测完毕，均未匹配`);
    return JSON.stringify({
      success: false,
      status: "exhausted",
      total_attempted: session.steps.length,
      message: `已尝试全部 ${session.steps.length} 个品牌，均未匹配。\n可能是红外发射问题（手机无红外硬件），或品牌不在库中。\n建议：检查手机是否支持红外，或用遥控器学习。`,
    });
  }

  // ── Advance to next brand, prepare probe params ──
  const nextStep = session.steps[nextUnattempted];
  nextStep.attempted = true;
  const brandCode = nextStep.brandCode;

  const isTV2 = ctx.session.deviceType === "tv";

  // Probe commands (params only, client encodes with .so)
  const probeCombos2 = isTV2
    ? [{ temperature: 0, mode: "", fan_speed: "", power: true, label: "开机/关机" } as any]
    : [
        { temperature: 26, mode: "cool", fan_speed: "auto",  power: true,  label: "开机+制冷26°C+自动风" },
        { temperature: 24, mode: "cool", fan_speed: "high",  power: true,  label: "开机+制冷24°C+强风" },
        { temperature: 26, mode: "heat", fan_speed: "auto",  power: true,  label: "开机+制热26°C+自动风" },
        { temperature: 18, mode: "cool", fan_speed: "high",  power: true,  label: "开机+制冷18°C+强风" },
        { temperature: 26, mode: "cool", fan_speed: "auto",  power: false, label: "关机" },
      ];

  const attemptedCount2 = session.steps.filter((s: import("./types").ProbeStep) => s.attempted).length;
  const progressPct = Math.round((attemptedCount2 / session.steps.length) * 100);

  console.log(`[probe] ───── 第 ${attemptedCount2}/${session.steps.length} 个品牌: ${brandCode} (${isTV2 ? "TV" : "AC"}) ─────`);

  const brandDisplay = await getBrandDisplay(brandCode);
  const cmdDesc = probeCombos2.map((c: any, i: number) => `  命令${i + 1}: ${c.label}`).join("\n");
  const deviceWord2 = isTV2 ? "电视" : "空调";

  const toolCall: ToolCall = {
    name: "probe_brand",
    args: {
      brand_code: brandCode,
      probe_brand: brandDisplay,
      probe_step: attemptedCount2,
      probe_total: session.steps.length,
      probe_commands: probeCombos2.map((c: any) => ({
        temperature: c.temperature || 0,
        mode: c.mode || "",
        fan_speed: c.fan_speed || "",
        power: c.power,
        label: c.label,
      })),
    },
    message: `📡 正在探测品牌: **${brandDisplay}** (第 ${attemptedCount2}/${session.steps.length} 个, ${progressPct}%)\n\n发送了 ${probeCombos2.length} 条红外命令：\n${cmdDesc}\n\n观察${deviceWord2}反应后说"有反应"或"没反应"。`,
  };

  ctx.toolCall = toolCall;
  ctx.phase = "discovery";
  ctx.setupStep = "probing";
  ctx.probeBrand = brandCode;
  ctx.probeStep = attemptedCount2;
  ctx.probeTotal = session.steps.length;

  // Update session
  ctx.session.probeStep = attemptedCount2;
  ctx.session.probeTotal = session.steps.length;
  ctx.session.currentProbeBrand = brandCode;
  ctx.session.probingActive = true;
  ctx.session.phase = "discovery";

  console.log(`[probe] 📡 下一个品牌 ${brandCode} 的 ${probeCombos2.length} 条命令参数已准备 (进度 ${attemptedCount2}/${session.steps.length} = ${progressPct}%)`);

  return JSON.stringify({
    success: true,
    brand_code: brandCode,
    brand_display: brandDisplay,
    command_count: probeCombos2.length,
    step: attemptedCount2,
    total: session.steps.length,
    progress_pct: progressPct,
    tool_call: toolCall,
  });
}

async function execVerifyDevice(
  args: any,
  ctx: ToolContext
): Promise<string> {
  const confirmed: boolean = args.confirmed;

  // Find latest unverified device with brandCode
  const devices = await getUserDevices(ctx.userId);
  const unverified = devices.filter((d) => !d.verified && d.brandCode);
  if (unverified.length === 0) {
    return JSON.stringify({
      error: "没有待验证的设备。必须先调用 respond_probe 响应探测结果，成功后才能验证。",
    });
  }

  const device = unverified[0];
  ctx.deviceId = device.id;

  if (confirmed) {
    device.verified = true;
    await setDevice(device);
    ctx.phase = "control";
    ctx.session.phase = "control";
    ctx.session.probingActive = false;
    ctx.setupStep = "done";
    return JSON.stringify({
      success: true,
      device_name: device.name,
      brand_code: device.brandCode,
      status: "verified",
      message: `设备 ${device.name} 已就绪。用户现在可以说'调到26度'之类的指令来控制空调。`,
    });
  } else {
    // Verification failed — reset brand
    device.brandCode = null;
    device.protocol = null;
    await setDevice(device);
    ctx.phase = "discovery";
    ctx.session.phase = "discovery";
    ctx.session.matchedBrand = null as any;
    ctx.session.probingActive = false;
    ctx.setupStep = "probing";
    return JSON.stringify({
      success: false,
      status: "rejected",
      message: "品牌识别可能有误。建议重新探测或换一种方式。",
    });
  }
}

async function execRegisterDevice(
  args: any,
  ctx: ToolContext
): Promise<string> {
  const name: string = args.name?.trim();
  if (!name) {
    return JSON.stringify({ error: "请提供设备名字。" });
  }

  // Find the unverified device with a matched brand (latest)
  const devices = await getUserDevices(ctx.userId);
  const pending = devices.filter((d) => !d.verified && d.brandCode);
  if (pending.length === 0) {
    return JSON.stringify({
      error: "没有待注册的设备。必须先调用 respond_probe 响应探测结果。探测成功后设备会自动创建，无需手动注册。",
    });
  }

  const device = pending[0];

  // Register: set name + mark verified
  device.name = name;
  device.verified = true;
  await setDevice(device);

  // Update session
  ctx.phase = "control";
  ctx.session.phase = "control";
  ctx.session.alias = name;
  ctx.session.probingActive = false;
  ctx.deviceId = device.id;
  ctx.setupStep = "done";

  return JSON.stringify({
    success: true,
    device_id: device.id,
    device_name: name,
    room: device.room,
    brand_code: device.brandCode,
    status: "registered",
    message: `设备 ${name} 已注册成功！用户现在可以控制它了（调到XX度、开关等）。`,
  });
}

async function execControlAc(
  args: any,
  ctx: ToolContext
): Promise<string> {
  let deviceId = args.device_id;
  if (!deviceId) {
    const devices = await getUserDevices(ctx.userId);
    const verified = devices.filter((d) => d.verified);
    if (verified.length === 0) {
      return JSON.stringify({
        error: "没有已就绪的设备。请先添加设备并完成品牌识别。",
        hint: "引导用户说'我卧室有个空调'来添加设备。",
      });
    }
    deviceId = verified[0].id;
  }

  const device = await getDevice(deviceId);
  if (!device) {
    return JSON.stringify({ error: `设备 ${deviceId} 不存在` });
  }
  if (!device.verified) {
    return JSON.stringify({
      error: "设备尚未验证，请先完成品牌识别。",
    });
  }
  if (!device.brandCode) {
    return JSON.stringify({
      error: "设备品牌未识别，请先完成品牌探测。",
    });
  }

  // Compute target state from current + args
  const current = device.lastState;
  const target: DeviceState = {
    power: args.power !== undefined ? args.power : current.power,
    temperature: args.temperature !== undefined ? args.temperature : current.temperature,
    mode: args.mode || current.mode,
    fan_speed: args.fan_speed || current.fan_speed,
  };

  // Update last known state
  await updateDeviceState(device.id, target);

  // Describe what changed
  const changes: string[] = [];
  if (args.power !== undefined)
    changes.push(args.power ? "开机" : "关机");
  if (args.temperature !== undefined)
    changes.push(`温度${args.temperature}°C`);
  if (args.mode)
    changes.push(`模式: ${args.mode}`);
  if (args.fan_speed)
    changes.push(`风速: ${args.fan_speed}`);

  const toolMessage = `📡 已发送红外指令: ${changes.join("，")} → ${device.name} (${device.brandCode})`;

  // Build tool_call for client: client uses local .so to encode + emit
  const toolCall: ToolCall = {
    name: "control_ac",
    args: {
      brand_code: device.brandCode,
      temperature: target.temperature,
      mode: target.mode,
      fan_speed: target.fan_speed,
      power: target.power,
      device_id: device.id,
    },
    message: toolMessage,
  };

  ctx.toolCall = toolCall;
  ctx.phase = "control";
  ctx.session.phase = "control";
  ctx.deviceId = device.id;
  ctx.setupStep = undefined;

  console.log(`[control] tool_call: control_ac brand=${device.brandCode} temp=${target.temperature} mode=${target.mode} fan=${target.fan_speed} power=${target.power}`);

  return JSON.stringify({
    success: true,
    device_name: device.name,
    tool_call: toolCall,
    changes: changes.join("，"),
    new_state: {
      power: target.power,
      temperature: target.temperature,
      mode: target.mode,
      fan_speed: target.fan_speed,
    },
    ir_disclaimer:
      "红外指令已发送。注意：红外是单向通信，无法确认空调是否真正执行。",
  });
}

async function execControlTv(
  args: any,
  ctx: ToolContext
): Promise<string> {
  let deviceId = args.device_id;
  if (!deviceId) {
    const devices = await getUserDevices(ctx.userId);
    const verified = devices.filter((d) => d.verified && d.deviceType === "tv");
    if (verified.length === 0) {
      return JSON.stringify({
        error: "没有已就绪的电视。请先说'我客厅有个电视'来添加设备。",
      });
    }
    deviceId = verified[0].id;
  }

  const device = await getDevice(deviceId);
  if (!device || !device.brandCode) {
    return JSON.stringify({ error: "电视设备未就绪，请先完成品牌识别。" });
  }

  const command: string = args.command || "power";
  const cmdNames: Record<string, string> = {
    power: "开关", vol_up: "音量+", vol_down: "音量-",
    ch_up: "频道+", ch_down: "频道-", mute: "静音", input: "信号源",
    up: "上", down: "下", left: "左", right: "右",
    ok: "确认", menu: "菜单", back: "返回", exit: "退出",
    home: "主页", info: "信息",
  };
  const cmdName = cmdNames[command] || command;

  const toolCall: ToolCall = {
    name: "control_tv",
    args: {
      brand_code: device.brandCode,
      command,
      device_id: device.id,
    },
    message: `📺 已发送红外指令: ${cmdName} → ${device.name} (${device.brandCode})`,
  };

  ctx.toolCall = toolCall;
  ctx.phase = "control";
  ctx.deviceId = device.id;

  console.log(`[control] tool_call: control_tv brand=${device.brandCode} cmd=${command}`);

  return JSON.stringify({
    success: true,
    device_name: device.name,
    brand_code: device.brandCode,
    command,
    cmd_name: cmdName,
    tool_call: toolCall,
  });
}

async function execGetDeviceState(
  args: any,
  ctx: ToolContext
): Promise<string> {
  let deviceId = args.device_id;
  if (!deviceId) {
    const devices = await getUserDevices(ctx.userId);
    const verified = devices.filter((d) => d.verified);
    if (verified.length === 0) {
      return JSON.stringify({
        error: "没有设备",
        hint: "引导用户添加设备。",
      });
    }
    deviceId = verified[0].id;
  }

  const device = await getDevice(deviceId);
  if (!device) {
    return JSON.stringify({ error: "设备不存在" });
  }

  ctx.phase = "control";
  ctx.deviceId = device.id;

  return JSON.stringify({
    success: true,
    device_name: device.name,
    power: device.lastState.power,
    temperature: device.lastState.temperature,
    mode: device.lastState.mode,
    fan_speed: device.lastState.fan_speed,
    brand_code: device.brandCode,
    verified: device.verified,
    disclaimer:
      "以上是上次发送的红外指令参数，不是空调的实际传感器读数。红外无法获取设备真实状态。",
  });
}

async function execListDevices(
  _args: any,
  ctx: ToolContext
): Promise<string> {
  const devices = await getUserDevices(ctx.userId);
  ctx.phase = "control";

  return JSON.stringify({
    total: devices.length,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      room: d.room,
      type: d.deviceType,
      brand_code: d.brandCode,
      verified: d.verified,
      last_state: d.lastState,
    })),
  });
}

async function execRemoveDevice(
  args: any,
  ctx: ToolContext
): Promise<string> {
  const deviceId = args.device_id;
  const device = await getDevice(deviceId);
  if (!device) {
    return JSON.stringify({ error: "设备不存在" });
  }

  await deleteDevice(deviceId);
  ctx.phase = "control";

  return JSON.stringify({
    success: true,
    removed: device.name,
    message: `设备 ${device.name} 已删除。`,
  });
}
