/**
 * NLP Module — DeepSeek Tool Call Loop
 *
 * Architecture:
 *   大模型 = 大脑（决策调哪个 tool、传什么参数）
 *   后端   = 手脚（执行 tool、返回结果给大模型）
 *
 * Flow:
 *   user_input → DeepSeek(tools) → tool_call → execute → tool_result
 *   → DeepSeek(tool_result) → tool_call or final_text → response
 */

import { config } from "./config";
import { TOOL_DEFINITIONS, executeToolCall, ToolContext } from "./tools";
import { IRCommand } from "./types";

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 Natrl，一个智能家居语音助手。你可以通过调用函数来控制用户的空调等红外设备。

## 核心原理
你通过调用函数来工作。每个函数对应一个操作（注册设备、发送红外信号、查询状态等）。
用户说中文，你理解意图，调用对应函数，然后根据函数返回结果生成友好的中文回复。

## 红外通信的重要限制
红外是单向发射技术，只能发送指令，不能读取设备的真实状态。
- 发送控制指令后，你只能说"已发送XX指令"，不能说"已设置为XX"
- 查询状态时，返回的是"上次发送的指令值"，不是实时读数
- 如果用户问"空调现在多少度"，回复时必须说明这是上次设置的温度值
- 不确定指令是否生效时，可以建议用户观察空调反应

## 设备发现与设置流程
当用户提到拥有某个设备时：
1. 调用 discover_device 注册设备
2. **重要：不要立即调用 probe_brand！先询问用户："请问您知道空调的品牌吗？比如格力、美的、海尔？"**
3. 如果用户说了品牌（如"格力"），调用 probe_brand 时填入 brand_hint 参数
4. 如果用户说"不知道"或"不清楚"，调用 probe_brand 时不传 brand_hint（系统按市场占有率自动探测）
5. 告诉用户：正在通过手机发送红外探测信号，请观察空调

品牌探测交互：
- 系统会优先尝试用户提到的品牌，然后是市场占有率最高的5个品牌，最后是次要品牌
- probe_brand 发送一个品牌的信号 → 用户反馈"有反应"/"没反应"
- "有反应" → respond_probe(reacted:true) → 匹配成功 → verify_device(confirmed:true)
- "没反应" → respond_probe(reacted:false) → 自动换下一个品牌 → 继续询问
- 如果前5个品牌都没匹配，系统会自动继续尝试剩余5个品牌
- "正常"/"可以"/"好了" → verify_device(confirmed:true) → 设备就绪
- "不对"/"不行" → verify_device(confirmed:false) → 重新探测

## 日常控制
- "打开空调" → control_ac(power:true)
- "关掉" → control_ac(power:false)
- "调到26度" → control_ac(temperature:26)
- "制冷模式" → control_ac(mode:"cool")
- "风大一点" → control_ac(fan_speed:"high")
- "太热了" → 先 get_device_state 查看当前设置 → 再 control_ac 调低温度
- "现在多少度" → get_device_state（回复时说明是上次设置的值）

## 回复风格
- 简洁友好，中文
- 设置操作后：说明发了什么指令
- 状态查询后：说明这是上次设置的值
- 探测过程中：告诉用户当前探测的品牌，请用户观察
- 出错时：说明问题并给出建议

## 规则
- 一次可以调用多个不相互依赖的函数
- 如果函数返回 error，根据 hint 引导用户
- 不要编造信息，如实报告函数返回的结果`;

// ─── Tool Call Loop ─────────────────────────────────────────────────

export interface ProcessResult {
  message: string;              // LLM's final text response
  irCommand?: IRCommand;       // IR command for phone to emit (if any)
  phase: "discovery" | "setup" | "control";
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

  const ctx: ToolContext = {
    userId,
    message: "",
    phase: "control",
    setupStep: undefined,
    deviceId: undefined,
  };

  // System prompt + user input
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userInput },
  ];

  // Loop: LLM may call tools, we execute, return results, LLM responds
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callDeepSeek(messages);

    const choice = response.choices[0];
    const finishReason = choice.finish_reason;

    if (finishReason === "stop") {
      // LLM produced final text response
      ctx.message = choice.message.content || "";
      break;
    }

    if (finishReason === "tool_calls") {
      const toolCalls = choice.message.tool_calls || [];

      // Add assistant's tool call message to history
      messages.push({
        role: "assistant",
        content: choice.message.content,
        tool_calls: toolCalls,
      });

      // Execute each tool call
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

      // Continue loop — LLM will process tool results
      continue;
    }

    // Unexpected finish reason
    console.warn(`[nlp] unexpected finish_reason: ${finishReason}`);
    ctx.message = "抱歉，处理出错了，请再试一次。";
    break;
  }

  // Build final result from context
  const result: ProcessResult = {
    message: ctx.message || "抱歉，我不太明白你的意思，换个说法试试？",
    phase: ctx.phase,
    deviceId: ctx.deviceId,
  };

  // Only include IR command if one was generated
  if (ctx.irCommand) {
    result.irCommand = ctx.irCommand;
  }

  // Setup-specific fields
  if (ctx.phase === "setup") {
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
