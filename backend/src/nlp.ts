/**
 * NLP Module — DeepSeek Tool Call Loop (Stateful)
 *
 * Each request includes:
 *   1. Fixed system prompt (rules + three-phase flow)
 *   2. Injected current state context (phase, device info, progress)
 *   3. Conversation history (last N rounds)
 *   4. User input
 */

import { config } from "./config";
import { TOOL_DEFINITIONS, executeToolCall, ToolContext } from "./tools";
import { ToolCall } from "./types";
import {
  getSession, addUserMessage, addAssistantMessage,
  buildStateContext, SessionState,
} from "./session-store";

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 Natrl，一个智能空调语音助手。通过红外信号控制空调。你通过调用函数来完成操作。

## 最重要的规则：每次回复只做一个动作，然后等待用户回应！
- 调用 probe_brand 后 → 必须停住，展示探测结果，等用户说"有反应"或"没反应"
- 调用 respond_probe 后 → 如果匹配成功，进入阶段2等用户起名；如果没匹配，结果里已经自动发了下一品牌，你只需展示结果然后停住等用户反馈
- 绝对禁止在同一次回复里连续调用 probe_brand 和 respond_probe
- 绝对禁止替用户做决定（比如用户还没说话你就调用 respond_probe）

## 三阶段流程（严格按顺序，不能跳过）

### 阶段1 — 设备识别与品牌探测
1. 用户提到空调 → 调用 discover_device
2. 必须问品牌 → 等用户回答
3. 用户说了品牌 → 调用 probe_brand(brand_hint="品牌名")
4. 用户说不知道 → 调用 probe_brand()
5. **调用 probe_brand 后立即停止，把探测结果告诉用户，等用户反馈**
6. 只有用户明确说了"没反应"或"都没反应" → 才调用 respond_probe(reacted:false)
7. 只有用户明确说了"有反应" → 才调用 respond_probe(reacted:true)
8. 全部品牌失败 → 告诉用户探测失败

### 阶段2 — 设备注册
1. 品牌匹配后 → 问用户"想给它起个什么名字？" → 等用户回答
2. 用户给名字 → 调用 register_device(name="名字")
3. 注册成功 → 进入阶段3

### 阶段3 — 日常使用
- "打开/关掉" → control_ac(power:true/false)
- "调到26度" → control_ac(temperature:26)
- "制冷/制热" → control_ac(mode:"cool"/"heat")
- "风大/风小" → control_ac(fan_speed:"high"/"low")
- "现在多少度" → get_device_state

## 硬规则
- 每次回复最多调用一个会触发红外发射的函数
- 用户没说话之前，不要调用 respond_probe
- 探测中只做探测，不要问别名
- 注册中只等别名，不要发控制指令
- 一句话里既有品牌又有其他信息时，先处理品牌探测`;
// ─── Tool Call Loop ─────────────────────────────────────────────────

export interface ProcessResult {
  message: string;
  toolCall?: ToolCall;              // tool_call JSON for client-side IR encoding
  phase: "discovery" | "registration" | "control";
  setupStep?: "probing" | "verifying" | "done";
  deviceId?: string;
  probeBrand?: string;
  probeStep?: number;
  probeTotal?: number;
}

export async function processInput(
  userInput: string,
  userId: string
): Promise<ProcessResult> {
  if (!config.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY not configured");
  }

  // ── Load session state ──
  const session = getSession(userId);

  // ── Save user message to history ──
  addUserMessage(userId, userInput);

  // ── Build state context string ──
  const stateContext = buildStateContext(session);

  // ── Build messages array ──
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Inject state context as a system message
  if (stateContext) {
    messages.push({ role: "system", content: stateContext });
  }

  // Inject conversation history
  for (const h of session.history) {
    messages.push({ role: h.role, content: h.content });
  }

  // ── Tool context for executors ──
  const ctx: ToolContext = {
    userId,
    session,
    message: "",
    phase: session.phase,
    setupStep: undefined,
    deviceId: session.deviceId,
  };

  // ── Tool call loop ──
  const MAX_ITERATIONS = 6;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callDeepSeek(messages);

    const choice = response.choices[0];
    const finishReason = choice.finish_reason;

    if (finishReason === "stop") {
      ctx.message = choice.message.content || "";
      break;
    }

    if (finishReason === "tool_calls") {
      const toolCalls = choice.message.tool_calls || [];

      messages.push({
        role: "assistant",
        content: choice.message.content,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const fnName = tc.function.name;
        let fnArgs: any = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch (_) {
          fnArgs = {};
        }

        console.log(`[nlp] LLM → tool_call: ${fnName}(${JSON.stringify(fnArgs)})`);

        const toolResult = await executeToolCall(fnName, fnArgs, ctx);

        console.log(`[nlp] tool_result: ${toolResult.substring(0, 200)}`);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });

        // ⛔ FORCE STOP: if the tool returned a tool_call for the phone to execute,
        // break immediately — the LLM must NOT continue calling more tools.
        // The user needs time to observe the AC and give feedback.
        if (ctx.toolCall) {
          console.log(`[nlp] ⛔ 强制停止: ${fnName} 返回了tool_call(${ctx.toolCall.name})，等待用户反馈`);
          ctx.message = choice.message.content || "";
          break;
        }
      }

      // If we broke out of the inner loop due to tool_call, also break outer
      if (ctx.toolCall) {
        break;
      }

      continue;
    }

    console.warn(`[nlp] unexpected finish_reason: ${finishReason}`);
    ctx.message = "抱歉，处理出错了，请再试一次。";
    break;
  }

  // ── Save assistant reply to history ──
  const finalMessage = ctx.message || "抱歉，我不太明白你的意思，换个说法试试？";
  addAssistantMessage(userId, finalMessage);

  // ── Build result ──
  const result: ProcessResult = {
    message: finalMessage,
    phase: ctx.phase,
    deviceId: ctx.deviceId,
  };

  if (ctx.toolCall) {
    result.toolCall = ctx.toolCall;
    console.log(`[nlp] 返回 tool_call(${ctx.toolCall.name}) 到前端: ${JSON.stringify(ctx.toolCall.args).substring(0, 150)}`);
  }

  if (ctx.phase === "discovery" || ctx.phase === "registration") {
    result.setupStep = ctx.setupStep;
    result.probeBrand = ctx.probeBrand;
    result.probeStep = ctx.probeStep;
    result.probeTotal = ctx.probeTotal;
  }

  return result;
}

// ─── DeepSeek API Call ──────────────────────────────────────────────

async function callDeepSeek(messages: any[]): Promise<any> {
  const body: any = {
    model: "deepseek-chat",
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
    temperature: 0.3,
    max_tokens: 1024,
  };

  const response = await fetch(
    `${config.deepseekBaseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${text}`);
  }

  return response.json();
}
