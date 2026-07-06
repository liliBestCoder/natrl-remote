/**
 * Tool Definitions & Executors
 *
 * DeepSeek function calling tools. The LLM decides which tool(s) to call
 * and what arguments to pass. The backend just executes and returns results.
 *
 * IR limitation: infrared is TRANSMIT-ONLY. We cannot read physical state.
 * Tools return "IR sent" status, not confirmed device state.
 */

import { v4 as uuidv4 } from "uuid";
import {
  getUserDevices, getDevice, setDevice, updateDeviceState, deleteDevice,
} from "./device-registry";
import { generateWaveform, getProbeCommands } from "./ir-engine-client";
import { publishCommand } from "./mqtt-client";
import { Device, DeviceState, IRCommand, ProbeSession } from "./types";
import { config } from "./config";
import { SessionState, getSession } from "./session-store";

// ─── Tool Context (mutable, accumulates results for frontend response) ───

export interface ToolContext {
  userId: string;
  session: SessionState;              // Live session state (read/write)
  message: string;
  irCommand?: IRCommand;
  phase: "discovery" | "registration" | "control";
  setupStep?: "probing" | "verifying" | "done";
  deviceId?: string;
  probeBrand?: string;
  probeStep?: number;
  probeTotal?: number;
}

// ─── In-memory state (probe sessions) ───────────────────────────────

const probeSessions = new Map<string, ProbeSession>();

// Brand name → brand_code mapping for Chinese user input
const BRAND_ALIASES: Record<string, string[]> = {
  gree:    ["gree_nec_v1"],
  格力:    ["gree_nec_v1"],
  midea:   ["midea_nec_v1"],
  美的:    ["midea_nec_v1"],
  haier:   ["haier_nec_v1"],
  海尔:    ["haier_nec_v1"],
  hisense: ["hisense_nec_v1"],
  海信:    ["hisense_nec_v1"],
  aux:     ["aux_nec_v1"],
  奥克斯:  ["aux_nec_v1"],
  tcl:     ["tcl_nec_v1"],
  长虹:    ["changhong_nec_v1"],
  changhong:["changhong_nec_v1"],
  chigo:   ["chigo_nec_v1"],
  志高:    ["chigo_nec_v1"],
  panasonic:["panasonic_nec_v1"],
  松下:    ["panasonic_nec_v1"],
  daikin:  ["daikin_nec_v1"],
  大金:    ["daikin_nec_v1"],
};

// Look up brand codes matching a user hint (case-insensitive substring match)
function matchBrandHint(hint: string): string[] {
  const lower = hint.toLowerCase().trim();
  const matched: string[] = [];
  for (const [key, codes] of Object.entries(BRAND_ALIASES)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      matched.push(...codes);
    }
  }
  return [...new Set(matched)]; // deduplicate
}

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
        "云端红外品牌探测。发送一个品牌的 IR 信号，让用户观察空调是否有反应。" +
        "每次调用尝试一个品牌，用户反馈'有反应'或'没反应'后决定下一步。" +
        "通常在 discover_device 之后自动调用。" +
        "如果用户主动说了品牌（如'格力'），请将品牌名填入 brand_hint 参数，系统会优先尝试该品牌。" +
        "如果用户不知道品牌，不要传 brand_hint，系统会按市场占有率从高到低自动探测。" +
        "重要：在调用此函数之前，必须先主动询问用户'请问您知道空调的品牌吗？'",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备ID。不传则使用最新未验证的设备。",
          },
          brand_hint: {
            type: "string",
            description: "用户提供的品牌名（中文或英文），如'格力'、'美的'、'gree'。不知道则不传。",
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
        "处理用户对探测信号的反馈。用户说'有反应'→reacted=true，'没反应'→reacted=false。" +
        "如果 reacted=true，品牌匹配成功，后续需要 verify_device 确认。" +
        "如果 reacted=false，系统自动尝试下一个品牌。",
      parameters: {
        type: "object",
        properties: {
          reacted: {
            type: "boolean",
            description: "空调是否有反应",
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

  const id = uuidv4();
  const device: Device = {
    id,
    userId: ctx.userId,
    room,
    name: devName,
    deviceType,
    brandCode: null,
    protocol: null,
    mqttTopic: `home/${room}/${id}`,
    lastState: {
      power: false,
      temperature: 24,
      mode: "cool",
      fan_speed: "auto",
    },
    verified: false,
    createdAt: new Date().toISOString(),
  };

  await setDevice(device);

  ctx.phase = "discovery";
  ctx.deviceId = device.id;

  // Update session state
  ctx.session.phase = "discovery";
  ctx.session.deviceId = device.id;
  ctx.session.deviceType = device.deviceType;
  ctx.session.room = device.room;
  ctx.session.probingActive = false;
  ctx.session.matchedBrand = null as any;
  ctx.session.brandHint = undefined;

  return JSON.stringify({
    success: true,
    device_id: device.id,
    device_name: device.name,
    room: device.room,
    device_type: device.deviceType,
    verified: false,
    hint: "设备已创建。请先询问用户品牌的名称，然后调用 probe_brand 开始探测。",
  });
}

async function execProbeBrand(
  args: any,
  ctx: ToolContext
): Promise<string> {
  let deviceId = args.device_id;
  if (!deviceId) {
    // Find latest unverified device
    const devices = await getUserDevices(ctx.userId);
    const unverified = devices.filter((d) => !d.verified);
    if (unverified.length === 0) {
      return JSON.stringify({
        error: "没有需要探测的设备。请先调用 discover_device。",
      });
    }
    deviceId = unverified[0].id;
  }

  const device = await getDevice(deviceId);
  if (!device) {
    return JSON.stringify({ error: `设备 ${deviceId} 不存在` });
  }

  // Get probe commands (10 brands)
  const allProbes = await getProbeCommands(26, "cool", "auto");

  // Reorder based on brand hint
  let orderedProbes = allProbes;
  const hint = args.brand_hint?.trim();
  if (hint) {
    ctx.session.brandHint = hint;
    const matchedCodes = matchBrandHint(hint);
    if (matchedCodes.length > 0) {
      // Move matched brands to the front
      const matchedProbes = allProbes.filter((p) => matchedCodes.includes(p.brand_code));
      const otherProbes = allProbes.filter((p) => !matchedCodes.includes(p.brand_code));
      orderedProbes = [...matchedProbes, ...otherProbes];
      console.log(`[probe] brand hint "${hint}" matched: ${matchedCodes.join(", ")}, reordered ${matchedProbes.length} to front`);
    }
  } else {
    ctx.session.brandHint = undefined;
  }

  // Start new probe session
  const session: ProbeSession = {
    deviceId: device.id,
    steps: orderedProbes.map((cmd) => ({
      brandCode: cmd.brand_code,
      attempted: false,
      userResponse: "pending",
      irCommand: cmd,
    })),
    matchedBrand: null,
    complete: false,
  };
  probeSessions.set(device.id, session);

  // Send first probe
  const firstStep = session.steps[0];
  firstStep.attempted = true;

  // Also try MQTT (no-op in mock mode)
  const payload = Buffer.from(
    JSON.stringify({
      raw_timing: firstStep.irCommand.raw_timing,
      carrier_freq: firstStep.irCommand.carrier_freq,
    })
  );
  await publishCommand(device.mqttTopic, payload);

  // Return IR command for phone emission
  ctx.irCommand = firstStep.irCommand;
  ctx.phase = "discovery";
  ctx.setupStep = "probing";
  ctx.deviceId = device.id;
  ctx.probeBrand = firstStep.brandCode;
  ctx.probeStep = 1;
  ctx.probeTotal = session.steps.length;

  // Update session state
  ctx.session.phase = "discovery";
  ctx.session.probingActive = true;
  ctx.session.probeStep = 1;
  ctx.session.probeTotal = session.steps.length;
  ctx.session.currentProbeBrand = firstStep.brandCode;
  ctx.session.deviceId = device.id;

  const hintMsg = hint ? `优先尝试用户提到的品牌: ${hint}。` : "";

  return JSON.stringify({
    success: true,
    current_brand: firstStep.brandCode,
    step: 1,
    total: session.steps.length,
    message: `${hintMsg}探测信号已发送（品牌: ${firstStep.brandCode}）。红外信号已通过手机发射。请观察空调是否有反应（开机/蜂鸣/灯闪），然后告诉用户询问'有反应吗？'。`,
  });
}

async function execRespondProbe(
  args: any,
  ctx: ToolContext
): Promise<string> {
  const reacted: boolean = args.reacted;

  // Find active probe session
  let deviceId: string | null = null;
  for (const [id, session] of probeSessions.entries()) {
    if (!session.complete) {
      deviceId = id;
      break;
    }
  }

  if (!deviceId) {
    return JSON.stringify({
      error: "没有正在进行的探测。请先调用 discover_device 再 probe_brand。",
    });
  }

  const device = await getDevice(deviceId);
  if (!device) {
    return JSON.stringify({ error: "设备不存在" });
  }

  const session = probeSessions.get(deviceId)!;
  const currentStep = session.steps.find(
    (s) => s.attempted && s.userResponse === "pending"
  );
  if (currentStep) {
    currentStep.userResponse = reacted ? "yes" : "no";
  }

  ctx.deviceId = device.id;
  ctx.phase = "discovery";

  if (reacted && currentStep) {
    // Brand matched! Move to registration phase
    session.matchedBrand = currentStep.brandCode;
    session.complete = true;
    probeSessions.delete(device.id);

    device.brandCode = currentStep.brandCode;
    device.protocol = "NEC";
    await setDevice(device);

    // Update session → registration phase
    ctx.phase = "registration";
    ctx.session.phase = "registration";
    ctx.session.matchedBrand = currentStep.brandCode;
    ctx.session.probingActive = false;
    ctx.setupStep = undefined;

    return JSON.stringify({
      success: true,
      matched_brand: currentStep.brandCode,
      status: "brand_identified",
      message: "品牌匹配成功！请询问用户'想给它起个什么名字？'，等待用户提供名字后调用 register_device。",
    });
  }

  // Try next brand
  const nextStep = session.steps.find((s) => !s.attempted);
  if (!nextStep) {
    session.complete = true;
    probeSessions.delete(device.id);

    ctx.session.probingActive = false;
    ctx.session.phase = "discovery";
    ctx.phase = "discovery";
    ctx.setupStep = undefined;

    return JSON.stringify({
      success: false,
      status: "exhausted",
      message: "已尝试所有已知品牌，均未匹配。建议用户尝试用遥控器学习，或联系客服。",
    });
  }

  nextStep.attempted = true;
  const payload = Buffer.from(
    JSON.stringify({
      raw_timing: nextStep.irCommand.raw_timing,
      carrier_freq: nextStep.irCommand.carrier_freq,
    })
  );
  await publishCommand(device.mqttTopic, payload);

  const attemptedCount = session.steps.filter((s) => s.attempted).length;

  ctx.irCommand = nextStep.irCommand;
  ctx.phase = "discovery";
  ctx.setupStep = "probing";
  ctx.probeBrand = nextStep.brandCode;
  ctx.probeStep = attemptedCount;
  ctx.probeTotal = session.steps.length;

  // Update session state
  ctx.session.probeStep = attemptedCount;
  ctx.session.probeTotal = session.steps.length;
  ctx.session.currentProbeBrand = nextStep.brandCode;
  ctx.session.probingActive = true;
  ctx.session.phase = "discovery";

  return JSON.stringify({
    success: true,
    current_brand: nextStep.brandCode,
    step: attemptedCount,
    total: session.steps.length,
    message: `下一个探测品牌: ${nextStep.brandCode}。红外信号已通过手机发射。询问用户是否有反应。`,
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
      error: "没有待验证的设备。请先完成品牌探测。",
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
      error: "没有待注册的设备。请先完成品牌探测。",
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

  // If power is being turned on, ensure reasonable defaults
  if (args.power === true && !current.power) {
    // Already handled by spread above
  }

  // Generate IR waveform
  const irCommand = await generateWaveform(
    device.brandCode,
    target.temperature,
    target.mode,
    target.fan_speed
  );

  // Publish via MQTT (no-op in mock mode)
  const payload = Buffer.from(
    JSON.stringify({
      raw_timing: irCommand.raw_timing,
      carrier_freq: irCommand.carrier_freq,
    })
  );
  await publishCommand(device.mqttTopic, payload);

  // Update last known state
  await updateDeviceState(device.id, target);

  // Set context for frontend
  ctx.irCommand = irCommand;
  ctx.phase = "control";
  ctx.session.phase = "control";
  ctx.deviceId = device.id;
  ctx.setupStep = undefined;

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

  return JSON.stringify({
    success: true,
    device_name: device.name,
    ir_sent: true,
    carrier_freq: irCommand.carrier_freq,
    pulse_count: irCommand.raw_timing.length,
    changes: changes.join("，"),
    new_state: {
      power: target.power,
      temperature: target.temperature,
      mode: target.mode,
      fan_speed: target.fan_speed,
    },
    ir_disclaimer:
      "红外指令已发送。注意：红外是单向通信，无法确认空调是否真正执行。建议在回复用户时使用'已发送...指令'而非'已设置...'。",
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
