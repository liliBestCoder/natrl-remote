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
1. 用户提到设备（空调/电视）→ **必须先调用 discover_device**，把 device_type 明确设为 "ac" 或 "tv"
2. ⛔ **绝对禁止跳过 discover_device 直接调用 probe_brand**。即使用户说了品牌，也必须先 discover_device 再 probe_brand
3. discover_device 之后如果用户还没说品牌 → 问一次，然后等待
4. ⚠️ 用户说了品牌关键词（空调: 格力/美的/海尔/TCL/大金/松下/三菱/日立/三星/LG/惠而浦/科龙/奥克斯/富士通/开利/东芝/whirlpool/gree/midea/haier/daikin/panasonic... 电视: 海信/创维/长虹/康佳/小米/索尼/飞利浦/夏普/hisense/skyworth/changhong/konka/xiaomi/sony/philips/sharp...）→ 立即调用 probe_brand(brand_hint="品牌名")，绝对不要再问品牌
5. 用户说不知道 → 直接调用 probe_brand()，不要再追问
6. ⚠️ 严禁车轱辘话：如果用户上一轮已经说了品牌，本轮必须调用 probe_brand，绝不能再次询问
7. **调用 probe_brand 后立即停止**，展示探测结果，等用户反馈
8. 只有用户明确说了"没反应"/"都没反应"/"没动静" → 调用 respond_probe(reacted:false)
9. 只有用户明确说了"有反应"/"开了"/"响了" → 调用 respond_probe(reacted:true)
10. 全部品牌失败 → 告诉用户探测失败

### 阶段2 — 设备注册
1. ⛔ respond_probe 成功后，系统会自动创建并注册设备。你只需要展示成功消息。
2. 如果用户主动说名字（如"叫它大白"），可以调用 register_device(name="名字") 改名。
3. 注册成功 → 进入阶段3

### 阶段3 — 日常使用
⛔ 阶段3的核心规则：用户的任何操作指令**必须**调用 control_ac 或 control_tv 函数来发射红外。绝对禁止只用文字回复（如"好的，已打开"）而不调用函数！

**空调:**
- "打开/关掉" → control_ac(power:true/false)
- "调到26度" → control_ac(temperature:26)
- "制冷/制热" → control_ac(mode:"cool"/"heat")
- "风大/风小" → control_ac(fan_speed:"high"/"low")
- "现在多少度" → get_device_state

**电视:**
- "打开电视"/"关电视" → control_tv(command:"power")
- "音量大一点"/"声音调高" → control_tv(command:"vol_up")
- "音量小一点"/"声音调低" → control_tv(command:"vol_down")
- "换台"/"下一个频道" → control_tv(command:"ch_up")
- "上一个频道" → control_tv(command:"ch_down")
- "静音" → control_tv(command:"mute")
- "切换信号源"/"HDMI" → control_tv(command:"input")
- "上"/"下"/"左"/"右" → control_tv(command:"up"/"down"/"left"/"right")
- "确认"/"OK" → control_tv(command:"ok")
- "菜单"/"设置" → control_tv(command:"menu")
- "返回" → control_tv(command:"back")
- "退出" → control_tv(command:"exit")
- "主页"/"回到首页" → control_tv(command:"home")
- "信息"/"节目信息" → control_tv(command:"info")

## 硬规则
- 每次回复最多调用一个会触发红外发射的函数
- ⛔ **respond_probe 是 probe_brand 之后唯一有效的下一步**。即使用户同时说了"有反应"和名字，也必须先 respond_probe，名字等设备创建后再处理
- ⛔ 绝对禁止在 respond_probe 之前调用 register_device 或 verify_device
- 用户没说话之前，不要调用 respond_probe
- 探测中只做探测，不要问别名
- 注册中只等别名，不要发控制指令
- 一句话里既有品牌又有其他信息时，先处理品牌探测
- 禁止重复询问已获取的信息。用户回答过品牌就立即 probe_brand，问过名字就立即 register_device`;
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
