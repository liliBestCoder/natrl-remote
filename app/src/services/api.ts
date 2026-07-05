import { CommandResult, Device, LearnResult, ProbeStatus } from "../types";

const API_BASE = __DEV__
  ? "http://192.168.1.100:3000"
  : "https://api.natrl.example.com";

const USER_ID = "user-mvp-001";

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const err = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function control(input: string): Promise<CommandResult> {
  return fetchApi<CommandResult>("/api/control", {
    method: "POST",
    body: JSON.stringify({ input, userId: USER_ID }),
  });
}

export async function getDevices(): Promise<{ devices: Device[] }> {
  return fetchApi<{ devices: Device[] }>(
    `/api/devices?userId=${USER_ID}`
  );
}

export async function createDevice(
  room: string,
  name: string
): Promise<{ device: Device }> {
  return fetchApi<{ device: Device }>("/api/devices", {
    method: "POST",
    body: JSON.stringify({ userId: USER_ID, room, name }),
  });
}

export async function learnDevice(
  deviceId: string
): Promise<{ status: string; message: string }> {
  return fetchApi(`/api/devices/${deviceId}/learn`, {
    method: "POST",
  });
}

export async function learnResult(
  deviceId: string,
  rawTiming: number[]
): Promise<LearnResult> {
  return fetchApi<LearnResult>(
    `/api/devices/${deviceId}/learn/result`,
    {
      method: "POST",
      body: JSON.stringify({ raw_timing: rawTiming }),
    }
  );
}

export async function probeDevice(
  deviceId: string
): Promise<ProbeStatus> {
  return fetchApi<ProbeStatus>(`/api/devices/${deviceId}/probe`, {
    method: "POST",
  });
}

export async function probeRespond(
  deviceId: string,
  responded: boolean
): Promise<ProbeStatus> {
  return fetchApi<ProbeStatus>(
    `/api/devices/${deviceId}/probe/respond`,
    {
      method: "POST",
      body: JSON.stringify({ responded }),
    }
  );
}

export async function verifyDevice(
  deviceId: string,
  coldConfirmed: boolean,
  hotConfirmed: boolean
): Promise<{ status: string; message: string }> {
  return fetchApi(`/api/devices/${deviceId}/verify`, {
    method: "POST",
    body: JSON.stringify({ coldConfirmed, hotConfirmed }),
  });
}

export async function deleteDevice(deviceId: string): Promise<void> {
  return fetchApi(`/api/devices/${deviceId}`, { method: "DELETE" });
}
