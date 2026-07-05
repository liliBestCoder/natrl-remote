// === NLP Intent Types ===

export type IntentType =
  | "set_temp"
  | "power_on"
  | "power_off"
  | "set_mode"
  | "set_fan_speed"
  | "query_state";

export type ACMode = "cool" | "heat" | "dry" | "fan_only" | "auto";
export type FanSpeed = "low" | "medium" | "high" | "auto";

export interface IntentParams {
  temperature?: number; // 16..30
  mode?: ACMode;
  fan_speed?: FanSpeed;
  power?: boolean;
}

export interface Intent {
  intent: IntentType;
  device: "ac";
  room: string | null;
  params: IntentParams;
}

export interface NLPResult {
  parsed: Intent;
  confidence: number; // 0.0..1.0
  raw_input: string;
  needs_clarification: string | null; // question to ask user if confidence low
}

// === IR Waveform Types ===

export interface IRCommand {
  brand_code: string; // e.g. "gree_nec_v1"
  protocol: string; // e.g. "NEC"
  carrier_freq: number; // usually 38000
  raw_timing: number[]; // [on_us, off_us, on_us, off_us, ...]
}

// === Device Registry Types ===

export interface DeviceState {
  power: boolean;
  temperature: number;
  mode: ACMode;
  fan_speed: FanSpeed;
}

export interface Device {
  id: string; // uuid
  userId: string;
  room: string;
  name: string; // user-given name e.g. "卧室空调"
  deviceType: "ac";
  brandCode: string | null; // set after identification
  protocol: string | null;
  mqttTopic: string; // home/{room}/{id}
  lastState: DeviceState;
  verified: boolean;
  createdAt: string; // ISO8601
}

// === Command Result ===

export interface CommandResult {
  success: boolean;
  deviceId: string;
  intent: Intent;
  irCommand: IRCommand | null;
  mqttPublished: boolean;
  message: string;
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
  irCommand: IRCommand;
}

export interface ProbeSession {
  deviceId: string;
  steps: ProbeStep[];
  matchedBrand: string | null;
  complete: boolean;
}
