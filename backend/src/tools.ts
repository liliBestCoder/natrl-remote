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

// ─── Tool Context (mutable, accumulates results for frontend response) ───

export interface ToolContext {
  userId: string;
  message: string;                    // Accumulated for final response
  irCommand?: IRCommand;             // Last generated IR command (phone emits this)
  phase: "discovery" | "setup" | "control";
  setupStep?: "probing" | "verifying" | "done";
  deviceId?: string;
  probeBrand?: string;
  probeStep?: number;
  probeTotal?: number;
}

// ─── In-memory state (probe sessions) ───────────────────────────────

const probeSessions = new Map<string, ProbeSession>();

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
        "通常在 discover_device 之后自动调用。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备ID。不传则使用最新未验证的设备。",
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

  ctx.phase = "setup";
  ctx.deviceId = device.id;

  return JSON.stringify({
    success: true,
    device_id: device.id,
    device_name: device.name,
    room: device.room,
    device_type: device.deviceType,
    verified: false,
    hint: "设备已创建。下一步应调用 probe_brand 开始品牌探测。",
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

  // Start new probe session
  const probeCommands = await getProbeCommands(26, "cool", "auto");
  const session: ProbeSession = {
    deviceId: device.id,
    steps: probeCommands.map((cmd) => ({
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
  ctx.phase = "setup";
  ctx.setupStep = "probing";
  ctx.deviceId = device.id;
  ctx.probeBrand = firstStep.brandCode;
  ctx.probeStep = 1;
  ctx.probeTotal = session.steps.length;

  return JSON.stringify({
    success: true,
    current_brand: firstStep.brandCode,
    step: 1,
    total: session.steps.length,
    message: `探测信号已发送（品牌: ${firstStep.brandCode}）。红外信号已通过手机发射。请观察空调是否有反应（开机/蜂鸣/灯闪），然后告诉用户询问'有反应吗？'。`,
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
  ctx.phase = "setup";

  if (reacted && currentStep) {
    // Brand matched!
    session.matchedBrand = currentStep.brandCode;
    session.complete = true;
    probeSessions.delete(device.id);

    device.brandCode = currentStep.brandCode;
    device.protocol = "NEC";
    await setDevice(device);

    ctx.setupStep = "verifying";
    return JSON.stringify({
      success: true,
      matched_brand: currentStep.brandCode,
      status: "brand_identified",
      message: "品牌匹配成功。下一步应调用 verify_device 让用户确认空调吹冷风是否正常。",
    });
  }

  // Try next brand
  const nextStep = session.steps.find((s) => !s.attempted);
  if (!nextStep) {
    session.complete = true;
    probeSessions.delete(device.id);

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

  ctx.irCommand = nextStep.irCommand;
  ctx.setupStep = "probing";
  ctx.probeBrand = nextStep.brandCode;
  ctx.probeStep = session.steps.filter((s) => s.attempted).length;
  ctx.probeTotal = session.steps.length;

  return JSON.stringify({
    success: true,
    current_brand: nextStep.brandCode,
    step: ctx.probeStep,
    total: ctx.probeTotal,
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
    ctx.phase = "setup";
    ctx.setupStep = "probing";
    return JSON.stringify({
      success: false,
      status: "rejected",
      message: "品牌识别可能有误。建议重新探测或换一种方式。",
    });
  }
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
