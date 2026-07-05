/**
 * End-to-End Integration Test
 *
 * Prerequisites:
 *   1. docker compose up -d (all services running)
 *   2. DEEPSEEK_API_KEY set in environment
 *   3. A real or simulated ESP32 node connected to MQTT
 *
 * Tests the full flow:
 *   Create device → learn brand → control AC → verify state update
 */

const API = "http://localhost:3000";
const USER_ID = "e2e-test-user";

async function api(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  console.log("=== Natrl E2E Integration Test ===\n");

  // 1. Health check
  console.log("1. Health check...");
  const health = await api("/health");
  console.log(`   Status: ${health.status}`);
  if (health.status !== "ok") throw new Error("Backend not healthy");

  // 2. Create device
  console.log("2. Creating device...");
  const create = await api("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      userId: USER_ID,
      room: "bedroom",
      name: "测试空调",
    }),
  });
  const deviceId = create.device.id;
  console.log(`   Device created: ${deviceId}`);

  // 3. List devices
  console.log("3. Listing devices...");
  const list = await api(`/api/devices?userId=${USER_ID}`);
  console.log(`   Found ${list.devices.length} device(s)`);
  if (list.devices.length !== 1) throw new Error("Expected 1 device");

  // 4. Learn — simulate learned IR signal
  console.log("4. Simulating IR learning...");
  const simulatedSignal = [
    9000, 4500, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 560, 560,
    560, 560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 560, 560,
    1690, 560, 1690, 560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560, 560,
    560, 560, 560, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 1690, 560,
    1690, 560, 560, 560, 1690, 560, 1690, 560, 1690, 560, 560, 560,
  ];

  const learnResult = await api(
    `/api/devices/${deviceId}/learn/result`,
    {
      method: "POST",
      body: JSON.stringify({ raw_timing: simulatedSignal }),
    }
  );
  console.log(
    `   Learn result: ${learnResult.status}, brand: ${
      learnResult.brandCode || "unknown"
    }`
  );

  // 5. Verify device
  console.log("5. Verifying device...");
  const verify = await api(`/api/devices/${deviceId}/verify`, {
    method: "POST",
    body: JSON.stringify({ coldConfirmed: true, hotConfirmed: true }),
  });
  console.log(`   Verify result: ${verify.status}`);

  // 6. Control — natural language
  console.log("6. Testing NL control...");
  const cmdResult = await api("/api/control", {
    method: "POST",
    body: JSON.stringify({
      input: "把温度调到26度",
      userId: USER_ID,
    }),
  });
  console.log(
    `   Control result: ${cmdResult.success ? "SUCCESS" : "FAILED"}`
  );
  console.log(`   Message: ${cmdResult.message}`);
  if (!cmdResult.success)
    throw new Error(`Control failed: ${cmdResult.message}`);

  // 7. Verify state was updated
  console.log("7. Checking device state update...");
  const listAfter = await api(`/api/devices?userId=${USER_ID}`);
  const updatedDevice = listAfter.devices[0];
  console.log(`   Temperature: ${updatedDevice.lastState.temperature}°C`);
  if (updatedDevice.lastState.temperature !== 26) {
    throw new Error(
      `Expected 26°C, got ${updatedDevice.lastState.temperature}°C`
    );
  }

  // 8. Clean up
  console.log("8. Cleaning up...");
  await api(`/api/devices/${deviceId}`, { method: "DELETE" });

  console.log("\n=== All E2E tests passed! ✅ ===");
}

main().catch((err) => {
  console.error("\n❌ E2E test failed:", err.message);
  process.exit(1);
});
