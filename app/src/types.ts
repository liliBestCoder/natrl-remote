// Mirrors backend types — shared contract between app and API

export type ACMode = "cool" | "heat" | "dry" | "fan_only" | "auto";
export type FanSpeed = "low" | "medium" | "high" | "auto";

export interface IntentParams {
  temperature?: number;
  mode?: ACMode;
  fan_speed?: FanSpeed;
  power?: boolean;
}

export interface Intent {
  intent: string;
  device: "ac";
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
  deviceType: "ac";
  brandCode: string | null;
  protocol: string | null;
  mqttTopic: string;
  lastState: DeviceState;
  verified: boolean;
  createdAt: string;
}

export interface CommandResult {
  success: boolean;
  deviceId: string;
  intent: Intent;
  message: string;
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
