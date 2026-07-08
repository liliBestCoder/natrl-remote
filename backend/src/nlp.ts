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

const SYSTEM_PROMPT = `你是 Natrl，一个智能家电语音助手。你通过红外信号控制家电。你通过调用函数来完成所有操作。

## ⛔ 核心铁律（违反则系统崩溃）

1. **控制阶段必须调用工具函数。绝对禁止只用文字回复。别整虚的！**
   - 用户说"打开电视" → 必须真的调用 control_tv(command:"power")，不是回复"好的"
   - 用户说"音量加" → 必须真的调用 control_tv(command:"vol_up")，别废话
   - 用户说"静音" → 必须真的调用 control_tv(command:"mute")
   - 用户说"换台" → 必须真的调用 control_tv(command:"ch_up")
   - 用户说"关机" → 必须真的调用 control_tv(command:"power")
   - ⛔ 只回复文字不调函数 = 骗用户 = 系统崩溃 = 红外不会亮！

2. **每次回复最多调用一个会触发红外发射的函数**

3. **探测阶段 respond_probe 是唯一合法操作**
   - 用户说"有反应" → 立即 respond_probe(reacted:true)，禁止文字回复
   - 用户说"没反应" → 立即 respond_probe(reacted:false)，禁止文字回复

## 三阶段流程

### 阶段1 — 设备识别与品牌探测
1. 用户提到设备 → 调用 discover_device
2. 用户说品牌 → 调用 probe_brand(brand_hint="品牌名")
3. 探测后用户反馈 → 调用 respond_probe
4. 绝对禁止跳过步骤

### 阶段2 — 设备注册
1. respond_probe 成功后设备自动创建
2. 用户起名 → register_device

### 阶段3 — 日常使用（控制阶段）
⛔ **铁律：任何操作指令必须调用 control_tv 或 control_ac**
⛔ **别整虚的！别只用文字回复"好的"！必须真的调用函数！**
⛔ **用户要的是红外发射，不是你的废话！不调函数红外灯不会亮！**

**电视命令 → 必须调用 control_tv:**

**电视命令 → 必须调用 control_tv:**
- "打开/关/开机/关机" → control_tv(command:"power")
- "音量+/音量加/音量大/调高" → control_tv(command:"vol_up")
- "音量-/音量减/音量小/调低" → control_tv(command:"vol_down")
- "静音/消音" → control_tv(command:"mute")
- "换台/频道+/下一个" → control_tv(command:"ch_up")
- "频道-/上一个" → control_tv(command:"ch_down")
- "信号源/HDMI/输入" → control_tv(command:"input")
- "菜单/设置" → control_tv(command:"menu")
- "返回" → control_tv(command:"back")
- "退出" → control_tv(command:"exit")
- "主页/首页" → control_tv(command:"home")
- "上/下/左/右/确认/OK" → control_tv(command:"up"/"down"/"left"/"right"/"ok")
- "信息" → control_tv(command:"info")

**空调命令 → 必须调用 control_ac:**
- "打开/关掉" → control_ac(power:true/false)
- "调到26度" → control_ac(temperature:26)
- "制冷/制热" → control_ac(mode:"cool"/"heat")
- 等等

## 关键禁止事项
- ⛔ 控制阶段禁止文字代替函数调用
- ⛔ 探测中禁止跳过 respond_probe
- ⛔ 禁止连续调用多个函数
- ⛔ 禁止替用户做决定`;

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

        console.log(`[nlp] tool_result: ${toolResult}`);

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
          // LLM may not provide content when returning tool_calls (content=null).
          // Fall back to the tool_call's own message (e.g. probe_brand status text).
          ctx.message = choice.message.content || ctx.toolCall.message || "";
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

  // ── Post-loop check: LLM text-replied in control phase without calling a tool ──
  // The LLM sometimes "hallucinates" an IR execution message ("已发送红外指令")
  // without actually calling the tool. Detect and force one retry.
  if (!ctx.toolCall && ctx.phase === "control" && hasCommandIntent(userInput)) {
    console.log(`[nlp] ⚠️ 控制阶段LLM未调用工具，追加强制重试`);
    messages.push({
      role: "system",
      content: "⛔ 你刚才没有调用任何函数！用户要求控制设备，你必须调用 control_ac 或 control_tv 函数来发射红外。绝对禁止只用文字回复！现在立即调用正确的函数。"
    });
    const retryResponse = await callDeepSeek(messages);
    const retryChoice = retryResponse.choices[0];
    if (retryChoice.finish_reason === "tool_calls") {
      const toolCalls = retryChoice.message.tool_calls || [];
      for (const tc of toolCalls) {
        const fnName = tc.function.name;
        let fnArgs: any = {};
        try { fnArgs = JSON.parse(tc.function.arguments); } catch (_) { fnArgs = {}; }
        console.log(`[nlp] 🔄 重试 → tool_call: ${fnName}(${JSON.stringify(fnArgs)})`);
        const toolResult = await executeToolCall(fnName, fnArgs, ctx);
        console.log(`[nlp] 重试结果: ${toolResult}`);
        if (ctx.toolCall) {
          ctx.message = retryChoice.message.content || ctx.toolCall.message || "";
          break;
        }
      }
    } else {
      console.log(`[nlp] 重试仍然失败: ${retryChoice.finish_reason}`);
    }
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
    console.log(`[nlp] 返回 tool_call(${ctx.toolCall.name}) 到前端: ${JSON.stringify(ctx.toolCall.args)}`);
  }

  if (ctx.phase === "discovery" || ctx.phase === "registration") {
    result.setupStep = ctx.setupStep;
    result.probeBrand = ctx.probeBrand;
    result.probeStep = ctx.probeStep;
    result.probeTotal = ctx.probeTotal;
  }

  return result;
}

// ─── Command intent detection ──────────────────────────────────────

function hasCommandIntent(text: string): boolean {
  const cmdPatterns = [
    /开|关|打开|关闭|关机|开机/,
    /音量|声音|大声|小声|调大|调小|调高|调低/,
    /静音|消音/,
    /换台|频道|上一个|下一个/,
    /信号源|HDMI|输入/,
    /菜单|设置|返回|退出|主页|首页/,
    /确认|OK|确定/,
    /上|下|左|右/,
    /温度|制冷|制热|除湿|送风|风大|风小|风速/,
    /调到|调成|改成/,
  ];
  return cmdPatterns.some(p => p.test(text));
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
