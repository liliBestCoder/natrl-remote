/**
 * Session Store — in-memory state per user
 *
 * Each user has ONE active session tracking their current phase.
 * Session state is injected into the LLM prompt so the LLM knows
 * exactly where we are in the three-phase flow.
 */

export type Phase = "discovery" | "registration" | "control";

export interface SessionState {
  userId: string;
  phase: Phase;

  // Phase 1 — Discovery / Probing
  deviceType?: string;
  room?: string;
  brandHint?: string;
  pendingDeviceName?: string;
  probeStep?: number;
  probeTotal?: number;
  currentProbeBrand?: string;
  matchedBrand?: string;
  probingActive: boolean;

  // Phase 2 — Registration
  deviceId?: string;
  alias?: string;

  // Phase 3 — Control
  // (device info comes from device registry, not session)

  // Conversation history
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

const MAX_HISTORY = 12;

const sessions = new Map<string, SessionState>();

function createSession(userId: string): SessionState {
  return {
    userId,
    phase: "discovery",
    probingActive: false,
    history: [],
  };
}

export function getSession(userId: string): SessionState {
  let session = sessions.get(userId);
  if (!session) {
    session = createSession(userId);
    sessions.set(userId, session);
  }
  return session;
}

export function addUserMessage(userId: string, content: string) {
  const s = getSession(userId);
  s.history.push({ role: "user", content });
  if (s.history.length > MAX_HISTORY) {
    s.history = s.history.slice(-MAX_HISTORY);
  }
}

export function addAssistantMessage(userId: string, content: string) {
  const s = getSession(userId);
  s.history.push({ role: "assistant", content });
  if (s.history.length > MAX_HISTORY) {
    s.history = s.history.slice(-MAX_HISTORY);
  }
}

export function clearSession(userId: string) {
  sessions.set(userId, createSession(userId));
}

// ─── State Context Builder ──────────────────────────────────────────

export function buildStateContext(session: SessionState): string {
  const lines: string[] = [];

  switch (session.phase) {
    case "discovery": {
      lines.push("[当前阶段: 阶段1 — 设备识别与品牌探测]");
      if (session.probingActive) {
        // Probing is live — override everything. Only respond_probe is allowed.
        lines.push(`⛔ 正在探测品牌: ${session.currentProbeBrand || "?"} (第${session.probeStep}/${session.probeTotal}个)`);
        lines.push("⛔ 唯一合法操作: respond_probe(reacted:true/false)");
        lines.push(`⛔ 用户说"有反应"/"开了"/"滴了" → 立即调用 respond_probe(reacted:true)`);
        lines.push(`⛔ 用户说"没反应"/"没动静" → 立即调用 respond_probe(reacted:false)`);
        lines.push("⛔ 绝对禁止调用 probe_brand / register_device / discover_device！");
        lines.push("⛔ 绝对禁止只用文字回复！必须调用 respond_probe！");
      } else {
        if (session.deviceType && session.room) {
          const typeName = session.deviceType === "ac" ? "空调" : session.deviceType;
          lines.push(`已识别: ${typeName}, 房间: ${session.room}`);
        }
        if (session.brandHint) {
          lines.push(`用户提到品牌: ${session.brandHint} → 应立即调用 probe_brand`);
        }
      }
      if (session.matchedBrand) {
        lines.push(`品牌匹配成功: ${session.matchedBrand} → 进入阶段2`);
      }
      break;
    }

    case "registration": {
      lines.push("[当前阶段: 阶段2 — 设备注册]");
      if (session.matchedBrand) lines.push(`品牌: ${session.matchedBrand}`);
      if (session.room) lines.push(`房间: ${session.room}`);
      lines.push("询问用户起别名，收到别名后调用 register_device");
      break;
    }

    case "control": {
      lines.push("[当前阶段: 阶段3 — 日常使用]");
      lines.push("⛔⛔⛔ 你的唯一任务：收到用户指令 → 调用 control_tv 或 control_ac → 停止 ⛔⛔⛔");
      lines.push("⛔ 文字回复而不调用函数 = 红外不会发射 = 系统失效");
      if (session.deviceType === "tv") {
        lines.push("用户有电视。调用 control_tv(command:\"power\"/\"vol_up\"/\"vol_down\"/\"ch_up\"/\"ch_down\"/\"mute\"/\"input\"/\"up\"/\"down\"/\"left\"/\"right\"/\"ok\"/\"menu\"/\"back\"/\"exit\"/\"home\"/\"info\")");
      } else {
        lines.push("用户有空调。调用 control_ac(power:/temperature:/mode:/fan_speed:)");
      }
      break;
    }
  }

  return lines.join("\n");
}
