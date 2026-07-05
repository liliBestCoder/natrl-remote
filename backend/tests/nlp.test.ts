import { describe, it, expect, vi } from "vitest";

const mockDeepSeekResponse = (intent: string, temp?: number, mode?: string) => ({
  choices: [{
    message: {
      content: JSON.stringify({
        parsed: {
          intent,
          device: "ac",
          room: null,
          params: { temperature: temp, mode, fan_speed: "auto" },
        },
        confidence: 0.95,
        raw_input: "test",
        needs_clarification: null,
      }),
    },
  }],
});

describe("parseNaturalLanguage", () => {
  it("should parse set_temp command", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockDeepSeekResponse("set_temp", 26, "cool")),
    });

    const { parseNaturalLanguage } = await import("../src/nlp");
    const result = await parseNaturalLanguage("调到26度");

    expect(result.parsed.intent).toBe("set_temp");
    expect(result.parsed.params.temperature).toBe(26);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("should parse power_off command", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockDeepSeekResponse("power_off")),
    });

    const { parseNaturalLanguage } = await import("../src/nlp");
    const result = await parseNaturalLanguage("关掉空调");

    expect(result.parsed.intent).toBe("power_off");
  });

  it("should handle ambiguous input with low confidence", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: {
            content: JSON.stringify({
              parsed: { intent: "set_temp", device: "ac", room: null, params: {} },
              confidence: 0.4,
              raw_input: "test",
              needs_clarification: "Did you mean lower the temperature, or switch to cool mode?",
            }),
          },
        }],
      }),
    });

    const { parseNaturalLanguage } = await import("../src/nlp");
    const result = await parseNaturalLanguage("凉快一点");

    expect(result.confidence).toBeLessThan(0.7);
    expect(result.needs_clarification).toBeTruthy();
  });
});
