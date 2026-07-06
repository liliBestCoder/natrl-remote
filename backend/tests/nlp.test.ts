import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the entire tools module
vi.mock("../src/tools", () => ({
  TOOL_DEFINITIONS: [],
  executeToolCall: vi.fn(),
}));

// Mock config
vi.mock("../src/config", () => ({
  config: {
    deepseekApiKey: "sk-test-key",
    deepseekBaseUrl: "https://api.deepseek.com",
    waveformEngineUrl: "http://localhost:8001",
    mockIr: false,
    mockMqtt: true,
    mockRedis: true,
    nlpConfidenceThreshold: 0.7,
    mqttUrl: "",
    redisUrl: "",
    port: 3000,
  },
}));

describe("processInput (Tool Call Architecture)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should call DeepSeek and return final text response (no tool calls)", async () => {
    // Mock: LLM returns text directly without tool calls
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "好的，已帮你把空调温度调到26度。",
              },
            },
          ],
        }),
    });

    const { processInput } = await import("../src/nlp");
    const result = await processInput("调到26度", "user-1");

    expect(result.message).toContain("26");
    expect(result.phase).toBe("control");
  });

  it("should handle tool_call → execute → final response", async () => {
    const { executeToolCall } = await import("../src/tools");
    vi.mocked(executeToolCall).mockResolvedValue(
      JSON.stringify({ success: true, temperature: 26 })
    );

    // Call 1: LLM makes a tool call
    // Call 2: LLM returns final text after tool result
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_001",
                      type: "function",
                      function: {
                        name: "get_device_state",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content:
                    "上次设置的温度是26°C（注意：这是上次发送的指令值，非实时读数）",
                },
              },
            ],
          }),
      });

    const { processInput } = await import("../src/nlp");
    const result = await processInput("现在多少度", "user-1");

    expect(result.message).toContain("26");
    expect(executeToolCall).toHaveBeenCalledWith(
      "get_device_state",
      {},
      expect.anything()
    );
  });

  it("should handle multiple sequential tool calls", async () => {
    const { executeToolCall } = await import("../src/tools");
    vi.mocked(executeToolCall)
      .mockResolvedValueOnce(
        JSON.stringify({ success: true, temperature: 28, power: true, mode: "cool" })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ success: true, changes: "温度24°C", ir_sent: true })
      );

    // Call 1: get_device_state
    // Call 2: control_ac (after seeing current state)
    // Call 3: final text
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_001",
                      type: "function",
                      function: {
                        name: "get_device_state",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_002",
                      type: "function",
                      function: {
                        name: "control_ac",
                        arguments: '{"temperature":24}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "现在28°C确实有点热，已帮你调到24°C制冷。",
                },
              },
            ],
          }),
      });

    const { processInput } = await import("../src/nlp");
    const result = await processInput("太热了", "user-1");

    expect(result.message).toContain("24");
    expect(executeToolCall).toHaveBeenCalledTimes(2);
  });
});
