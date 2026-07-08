// === NLP Intent Types ===
// Covers the full lifecycle: discover → setup → control

export type IntentType =
  // Device discovery & setup
  | "discover_device"   // "我卧室有个空调"
  | "start_learning"    // "学一下遥控器" / "让它学"
  | "skip_learning"     // "不用学了" / "直接探测"
  | "probe_yes"         // "有反应" / "开了"
  | "probe_no"          // "没反应" / "没动静"
  | "verify_yes"        // "正常" / "可以了"
  | "verify_no"         // "不对" / "没变化"
  // Daily control
  | "set_temp"          // "调到26度"
  | "power_on"          // "打开空调"
  | "power_off"         // "关掉空调"
  | "set_mode"          // "制冷模式"
  | "set_fan_speed"     // "风速调大"
  | "query_state";      // "现在多少度"

export type TVCommand = "power" | "vol_up" | "vol_down" | "ch_up" | "ch_down" | "mute" | "input" | "num_0" | "num_1" | "num_2" | "num_3" | "num_4" | "num_5" | "num_6" | "num_7" | "num_8" | "num_9";

export type DeviceType = "ac" | "tv" | "fan" | "unknown";
export type ACMode = "cool" | "heat" | "dry" | "fan_only" | "auto";
export type FanSpeed = "low" | "medium" | "high" | "auto";

export interface IntentParams {
  temperature?: number;       // 16..30
  mode?: ACMode;
  fan_speed?: FanSpeed;
  power?: boolean;
  // For discover_device
  device_type?: DeviceType;
  device_name?: string;       // user-given name, e.g. "卧室的空调"
}

export interface Intent {
  intent: IntentType;
  device: DeviceType;
  room: string | null;
  params: IntentParams;
}

export interface NLPResult {
  parsed: Intent;
  confidence: number;         // 0.0..1.0
  raw_input: string;
  needs_clarification: string | null;
}

// === IR Waveform Types ===

export interface IRCommand {
  brand_code: string;
  protocol: string;
  carrier_freq: number;
  raw_timing: number[];
}

// === Tool Call Types (new: client-side IR encoding) ===

export interface ToolCallArgs {
  brand_code?: string;
  temperature?: number;
  mode?: string;
  fan_speed?: string;
  power?: boolean;
  device_id?: string;
  room?: string;
  device_type?: string;
  device_name?: string;
  reacted?: boolean;
  confirmed?: boolean;
  name?: string;
  command?: string;   // TV command: power/vol_up/vol_down/ch_up/ch_down/mute/input
  // Probe-specific
  probe_commands?: Array<{
    temperature: number;
    mode: string;
    fan_speed: string;
    power: boolean;
    label: string;
  }>;
  probe_brand?: string;
  probe_step?: number;
  probe_total?: number;
  sub_model?: string;    // AC sub-model for encoding
}

export interface ToolCall {
  name: string;
  args: ToolCallArgs;
  message: string;   // human-readable message for the user
}

// === Device Registry Types ===

export interface DeviceState {
  power: boolean;
  temperature: number;
  mode: ACMode;
  fan_speed: FanSpeed;
}

export interface Device {
  id: string;
  userId: string;
  room: string;
  name: string;
  deviceType: DeviceType;
  brandCode: string | null;
  subModel: string | null;
  protocol: string | null;
  mqttTopic: string;
  lastState: DeviceState;
  verified: boolean;
  createdAt: string;
}

// === API Response Types ===

export interface CommandResult {
  success: boolean;
  phase: "discovery" | "setup" | "control";  // what phase is the user in?
  deviceId: string;
  intent: Intent;
  irCommand: IRCommand | null;
  mqttPublished: boolean;
  message: string;
  // Setup-specific
  setupStep?: "learning" | "probing" | "verifying" | "done";
  probeBrand?: string;
  probeStep?: number;
  probeTotal?: number;
}

// === Device Learning Types ===

export interface LearnSignal {
  deviceId: string;
  rawTiming: number[];
  matchedBrand: string | null;
  matchedProtocol: string | null;
  matchConfidence: number;
}

export interface ProbeStep {
  brandCode: string;
  attempted: boolean;
  userResponse: "yes" | "no" | "pending";
  irCommand: IRCommand | null;
  subModels: string[];           // sub-models to probe for this brand
  subModelIndex: number;         // current sub-model (0-based)
  matchedSubModel: string | null; // saved when user says "有反应"
}

export interface ProbeSession {
  deviceId: string;
  steps: ProbeStep[];
  matchedBrand: string | null;
  matchedSubModel: string | null;
  complete: boolean;
}
