// Mirrors backend types — shared contract between app and API

export type DeviceType = "ac" | "tv" | "fan" | "unknown";
export type ACMode = "cool" | "heat" | "dry" | "fan_only" | "auto";
export type FanSpeed = "low" | "medium" | "high" | "auto";

export interface IntentParams {
  temperature?: number;
  mode?: ACMode;
  fan_speed?: FanSpeed;
  power?: boolean;
  device_type?: DeviceType;
  device_name?: string;
}

export interface Intent {
  intent: string;
  device: string;
  room: string | null;
  params: IntentParams;
}

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
  deviceType: string;
  brandCode: string | null;
  protocol: string | null;
  mqttTopic: string;
  lastState: DeviceState;
  verified: boolean;
  createdAt: string;
}

export interface IRCommand {
  brand_code: string;
  protocol: string;
  carrier_freq: number;
  raw_timing: number[];
}

export interface CommandResult {
  success: boolean;
  phase: "discovery" | "setup" | "control";
  deviceId: string;
  intent: Intent;
  irCommand?: IRCommand | null;
  mqttPublished?: boolean;
  message: string;
  setupStep?: "learning" | "probing" | "verifying" | "done";
  probeBrand?: string;
  probeStep?: number;
  probeTotal?: number;
}

export interface LearnResult {
  status: string;
  brandCode?: string;
  confidence?: number;
  message: string;
}

export interface ProbeStatus {
  status: string;
  currentBrand?: string;
  step?: number;
  total?: number;
  brandCode?: string;
  message: string;
}
