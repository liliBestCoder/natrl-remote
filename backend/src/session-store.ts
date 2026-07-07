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
      if (session.deviceType && session.room) {
        const typeName = session.deviceType === "ac" ? "空调" : session.deviceType;
        lines.push(`已识别: ${typeName}, 房间: ${session.room}`);
      }
      if (session.brandHint) {
        lines.push(`用户提到品牌: ${session.brandHint} → 应立即调用 probe_brand`);
      }
      if (session.probingActive) {
        lines.push(`探测中: 第${session.probeStep}/${session.probeTotal}个 (${session.currentProbeBrand || "?"})`);
        lines.push("⛔ 当前唯一合法操作: respond_probe。收到用户'有反应'或'没反应'后立即调用 respond_probe，绝对禁止调用其他函数！");
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
      lines.push("设备已就绪，等待控制指令。可操作: 开关/调温/模式/风速/查询");
      break;
    }
  }

  return lines.join("\n");
}
