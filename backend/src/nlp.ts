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
import { IRCommand } from "./types";
import {
  getSession, addUserMessage, addAssistantMessage,
  buildStateContext, SessionState,
} from "./session-store";

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 Natrl，一个智能空调语音助手。通过红外信号控制空调。你通过调用函数来完成操作。

## 三阶段流程（严格按顺序，不能跳过）

### 阶段1 — 设备识别与品牌探测
当用户提到有空调时：
1. 识别设备和房间
2. **必须先主动询问品牌**（如"请问是什么品牌的？格力、美的、海尔？"）
3. 用户说了品牌 → 调用 probe_brand(brand_hint="品牌名")
4. 用户说"不知道" → 调用 probe_brand() 不传 hint
5. 探测中每次发送一个品牌信号，等用户反馈：
   - "有反应" → respond_probe(reacted:true) → 匹配成功 → 进入阶段2
   - "没反应" → respond_probe(reacted:false) → 自动下一个品牌
6. 10个品牌全失败 → 告诉用户探测失败

### 阶段2 — 设备注册
品牌匹配成功后：
1. 询问用户"想给它起个什么名字？"
2. 用户提供名字后 → 调用 register_device(name="用户起的名字")
3. 注册成功 → 进入阶段3

### 阶段3 — 日常使用
设备就绪后，处理控制指令：
- "打开/关掉" → control_ac(power:true/false)
- "调到26度" → control_ac(temperature:26)
- "制冷/制热" → control_ac(mode:"cool"/"heat")
- "风大/风小" → control_ac(fan_speed:"high"/"low")
- "现在多少度" → get_device_state（回复时说明是上次设置值）

## 硬规则
- 阶段1没完成，绝不跳到阶段2
- 阶段2没完成，绝不跳到阶段3
- 探测中只做探测，不要问别名
- 注册中只等别名，不要发控制指令
- 探测没反应时自动换下一个，不要问"要不要继续"
- 一句话里既有品牌又有其他信息时，先处理品牌探测
- 用户中途说无关的话，先完成当前阶段`;
// ─── Tool Call Loop ─────────────────────────────────────────────────

export interface ProcessResult {
  message: string;
  irCommand?: IRCommand;
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

  if (ctx.irCommand) {
    result.irCommand = ctx.irCommand;
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
