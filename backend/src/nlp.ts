import { NLPResult } from "./types";
import { config } from "./config";

const SYSTEM_PROMPT = `You are a smart home intent parser. Extract the user's air conditioner command into structured JSON.

INTENT TYPES: set_temp, power_on, power_off, set_mode, set_fan_speed, query_state
MODES: cool, heat, dry, fan_only, auto
FAN SPEEDS: low, medium, high, auto

Rules:
- "turn on" / "open" / "start" → power_on
- "turn off" / "shut" / "close" / "stop" → power_off
- "cooler" / "cold" / "lower" → set_temp (decrease temperature)
- "warmer" / "hot" / "heat" → set_temp AND mode: heat
- "XX degrees" / "set to XX" → set_temp with value
- If the input is ambiguous (e.g., "make it cooler" without a target temperature), set confidence low and provide a clarification question.
- room is null if not specified.
- Output ONLY valid JSON, no explanation.`;

export async function parseNaturalLanguage(input: string): Promise<NLPResult> {
  const response = await fetch(
    `${config.deepseekBaseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ac_intent",
            strict: true,
            schema: {
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  enum: [
                    "set_temp",
                    "power_on",
                    "power_off",
                    "set_mode",
                    "set_fan_speed",
                    "query_state",
                  ],
                },
                device: { type: "string", const: "ac" },
                room: { type: ["string", "null"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                needs_clarification: { type: ["string", "null"] },
                params: {
                  type: "object",
                  properties: {
                    temperature: {
                      type: "integer",
                      minimum: 16,
                      maximum: 30,
                    },
                    mode: {
                      type: "string",
                      enum: ["cool", "heat", "dry", "fan_only", "auto"],
                    },
                    fan_speed: {
                      type: "string",
                      enum: ["low", "medium", "high", "auto"],
                    },
                    power: { type: "boolean" },
                  },
                  required: [],
                  additionalProperties: false,
                },
              },
              required: [
                "intent",
                "device",
                "room",
                "confidence",
                "needs_clarification",
                "params",
              ],
              additionalProperties: false,
            },
          },
        },
        max_tokens: 256,
        temperature: 0.1,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as any;
  const raw = JSON.parse(data.choices[0].message.content) as NLPResult;

  return {
    parsed: {
      intent: raw.parsed.intent,
      device: "ac",
      room: raw.parsed.room || null,
      params: {
        temperature: raw.parsed.params?.temperature,
        mode: raw.parsed.params?.mode,
        fan_speed: raw.parsed.params?.fan_speed,
        power: raw.parsed.params?.power,
      },
    },
    confidence: raw.confidence,
    raw_input: input,
    needs_clarification: raw.needs_clarification || null,
  };
}
