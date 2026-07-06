import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Platform, Pressable, ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Device, CommandResult } from "../types";
import { control, getDevices } from "../services/api";
import { emitIr, emitIrSequence, describeIrCommand, hasIrBlaster } from "../services/ir-emitter";

function StateBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <View style={[st.badge, active ? st.badgeOn : st.badgeOff]}>
      <Text style={[st.badgeText, active ? st.badgeTextOn : st.badgeTextOff]}>{label}</Text>
    </View>
  );
}

function modeLabel(m: string): string {
  const m2: Record<string, string> = { cool: "制冷", heat: "制热", dry: "除湿", fan_only: "送风", auto: "自动" };
  return m2[m] || m;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [devices, setDevices] = useState<Device[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [_, setInitialLoad] = useState(true);
  const chatRef = useRef<ScrollView>(null);

  // IR blaster
  const [irSupported, setIrSupported] = useState(false);
  const [irStatus, setIrStatus] = useState<string | null>(null);

  // Setup
  const [setupStep, setSetupStep] = useState<"learning" | "probing" | "verifying" | "done" | null>(null);
  const [setupDeviceId, setSetupDeviceId] = useState<string | null>(null);
  const [probeBrand, setProbeBrand] = useState("");
  const [probeStep, setProbeStep] = useState(0);
  const [probeTotal, setProbeTotal] = useState(0);

  // Voice mode (default) vs text mode
  const [textMode, setTextMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceBlocked, setVoiceBlocked] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const hasSR = !!SR;
      setVoiceSupported(hasSR);
      console.log("[voice] supported:", hasSR);

      // Check if permission already denied
      if (hasSR && navigator.permissions) {
        navigator.permissions.query({ name: "microphone" as PermissionName })
          .then((status) => {
            if (status.state === "denied") {
              setVoiceBlocked(true);
              console.log("[voice] permission already denied");
            }
            status.onchange = () => {
              if (status.state === "denied") setVoiceBlocked(true);
              else setVoiceBlocked(false);
            };
          })
          .catch(() => {});
      }
    }
  }, []);

  // Check IR blaster on mount
  useEffect(() => {
    hasIrBlaster().then((ok) => {
      setIrSupported(ok);
      console.log("[ir] blaster supported:", ok);
    });
  }, []);

  const addAssistantMsg = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: "assistant", text }]);
  }, []);

  const addUserMsg = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: "user", text }]);
  }, []);

  const loadDevices = useCallback(async (isInitial = false) => {
    try {
      const result = await getDevices();
      setDevices(result.devices);
      // Only set default setup UI on initial load — API responses drive the active flow
      if (isInitial) {
        const unverified = result.devices.find((d: Device) => !d.verified);
        if (unverified) {
          setSetupDeviceId(unverified.id);
          if (unverified.brandCode) {
            setSetupStep("verifying");
            addAssistantMsg("品牌已识别！请确认空调是否正常工作。");
          } else {
            setSetupStep("learning");
            addAssistantMsg("把遥控器对准节点，按一下开机键...");
          }
        }
      }
    } catch (_e) {}
    setInitialLoad(false);
  }, [addAssistantMsg]);

  useEffect(() => { loadDevices(true); }, [loadDevices]);

  // === VOICE: Hold-to-talk ===
  const startVoice = useCallback(async () => {
    // Check browser support
    if (!voiceSupported) {
      setListening(false);
      addAssistantMsg("当前浏览器不支持语音识别，请使用 Chrome 浏览器。");
      return;
    }

    try {
      // Step 1: explicitly request microphone permission (must be in user gesture chain)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately — we only needed the permission grant
      stream.getTracks().forEach((t) => t.stop());

    } catch (permErr: any) {
      setListening(false);
      console.log("[voice] mic permission err:", permErr.name, permErr.message);
      if (permErr.name === "NotAllowedError" || permErr.name === "PermissionDeniedError") {
        setVoiceBlocked(true);
        addAssistantMsg("麦克风权限已被阻止。请点击地址栏左侧锁图标 → 麦克风设为「允许」→ 刷新页面。");
      } else if (permErr.name === "NotFoundError") {
        addAssistantMsg("未检测到麦克风设备，请检查设备连接。");
      } else {
        addAssistantMsg(`麦克风错误: ${permErr.message}`);
      }
      return;
    }

    // Step 2: start speech recognition
    try {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (recognitionRef.current) { recognitionRef.current.abort(); }
      const rec = new SR();
      rec.lang = "zh-CN";
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (e: any) => {
        const text = e.results[0][0].transcript;
        console.log("[voice] ok:", text);
        setListening(false);
        handleSend(text);
      };
      rec.onerror = (e: any) => {
        console.log("[voice] sr err:", e.error);
        setListening(false);
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setVoiceBlocked(true);
          addAssistantMsg("语音服务被阻止。请点击地址栏锁图标 → 麦克风设为「允许」→ 刷新。");
        } else if (e.error !== "aborted") {
          addAssistantMsg(`语音错误: ${e.error}`);
        }
      };
      rec.onend = () => { setListening(false); };
      rec.onstart = () => { setListening(true); };
      recognitionRef.current = rec;
      rec.start();
    } catch (srErr: any) {
      setListening(false);
      console.log("[voice] sr start err:", srErr);
      addAssistantMsg(`无法启动语音识别: ${srErr.message}`);
    }
  }, [voiceSupported, addAssistantMsg]);

  const stopVoice = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
    }
    setListening(false);
  }, []);

  // Hold-to-talk handlers
  const handlePressIn = useCallback(() => {
    if (textMode) return; // don't voice in text mode
    setListening(true);
    // Must call synchronously within user gesture — setTimeout breaks it
    startVoice();
  }, [textMode, startVoice]);

  const handlePressOut = useCallback(() => {
    stopVoice();
    setListening(false);
  }, [stopVoice]);

  // === SEND ===
  const handleSend = async (textOverride?: string) => {
    const text = (textOverride || input).trim();
    if (!text) return;
    setInput("");
    addUserMsg(text);
    setLoading(true);

    try {
      const result: CommandResult = await control(text);
      addAssistantMsg(result.message);
      if (result.phase === "setup" || result.phase === "discovery" || result.phase === "registration") {
        setSetupStep(result.setupStep || null);
        if (result.deviceId) setSetupDeviceId(result.deviceId);
        if (result.probeBrand) setProbeBrand(result.probeBrand);
        if (result.probeStep) setProbeStep(result.probeStep);
        if (result.probeTotal) setProbeTotal(result.probeTotal);
      }
      if (result.phase === "control") {
        setSetupStep(null);
        setSetupDeviceId(null);
      }

      // Emit IR command(s) via phone's IR blaster
      if (result.irCommands && result.irCommands.length > 0) {
        const cmdCount = result.irCommands.length;
        const brand = result.irCommands[0].brand_code;

        // Probe command labels (match backend PROBE_COMBO_DESCS)
        const probeLabels = [
          "制冷26°C+自动风",
          "制冷24°C+强风",
          "制热26°C+自动风",
          "制冷18°C+强风",
          "关机",
        ];

        const emitResults: string[] = [];

        emitIrSequence(result.irCommands, 2000, (idx, total, cmd, success) => {
          const label = probeLabels[idx - 1] || `命令${idx}`;
          const icon = success ? "📡" : "❌";
          emitResults.push(`${icon} ${idx}/${total}: ${label}`);
          // Show last 3 results + current status
          const recent = emitResults.slice(-3).join("\n");
          setIrStatus(`🔍 探测: ${brand}\n${recent}`);
        }).then((seqResults) => {
          const successCount = seqResults.filter((r) => r.success).length;
          if (successCount === cmdCount) {
            setIrStatus(`✅ ${cmdCount}条命令已全部发射 (${brand})\n观察空调是否有反应...`);
          } else if (successCount > 0) {
            setIrStatus(`⚠️ ${successCount}/${cmdCount} 条已发射 (${brand})\n观察空调是否有反应...`);
          } else {
            setIrStatus(`❌ 无红外硬件，无法发射 (${brand})\n请确认手机支持红外`);
          }
          setTimeout(() => setIrStatus(null), 10000);
        });
      } else if (result.irCommand) {
        const irResult = await emitIr(result.irCommand);
        if (irResult.success) {
          setIrStatus(`📡 红外已发射 (${describeIrCommand(result.irCommand)})`);
        } else {
          setIrStatus(`⚠️ 无红外硬件 — ${describeIrCommand(result.irCommand)}`);
        }
        // Clear IR status after 6 seconds
        setTimeout(() => setIrStatus(null), 6000);
      }

      await loadDevices();
    } catch (e: any) {
      if (e.message?.includes("fetch") || e.message?.includes("Network")) {
        addAssistantMsg("后端服务未启动，请先启动后端。连接地址: " + (
          Platform.OS === "web" && typeof window !== "undefined"
            ? `http://${window.location.hostname}:3000` : "http://192.168.21.9:3000"
        ));
      } else {
        addAssistantMsg(e.message);
      }
    }
    setLoading(false);
  };

  const acDevice = devices.find((d) => d.verified);

  // === RENDER: Setup ===
  if (setupStep) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={[styles.outer, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.hdr}>Natrl Remote</Text>
        <View style={styles.setupCard}>
          {setupStep === "learning" && (
            <>
              <ActivityIndicator size="large" color="#4fc3f7" />
              <Text style={styles.setupTitle}>正在学习红外信号</Text>
              <Text style={styles.setupHintSmall}>12秒无信号自动切换云端探测</Text>
              <TouchableOpacity style={styles.linkBtn} onPress={() => handleSend("直接探测")}>
                <Text style={styles.linkBtnText}>跳过 →</Text>
              </TouchableOpacity>
            </>
          )}
          {setupStep === "probing" && (
            <>
              <Text style={styles.setupIcon}>🔍</Text>
              <Text style={styles.setupTitle}>云端自动探测</Text>
              {probeBrand ? (
                <Text style={styles.ptext}>当前: {probeBrand} ({probeStep}/{probeTotal})</Text>
              ) : (
                probeTotal > 0 && <Text style={styles.ptext}>第 {probeStep}/{probeTotal} 品牌</Text>
              )}
              <Text style={styles.setupHintSmall}>观察空调，说"有反应"或"没反应"</Text>
            </>
          )}
          {setupStep === "verifying" && (
            <>
              <Text style={styles.setupIcon}>✅</Text>
              <Text style={styles.setupTitle}>最后验证</Text>
              <Text style={styles.setupHintSmall}>说"正常"或"不对"</Text>
            </>
          )}
        </View>
        {/* Chat history */}
        <ScrollView
          ref={chatRef}
          style={styles.chatScroll}
          contentContainerStyle={styles.chatContent}
          onContentSizeChange={() => chatRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.map((msg, i) => (
            <View key={i} style={[styles.chatBubble, msg.role === "user" ? styles.chatUser : styles.chatAssistant]}>
              <Text style={[styles.chatText, msg.role === "user" ? styles.chatTextUser : styles.chatTextAssistant]}>
                {msg.text}
              </Text>
            </View>
          ))}
          {loading && <ActivityIndicator style={{ marginTop: 8 }} color="#58a6ff" />}
        </ScrollView>
        {irStatus && <View style={styles.irMsg}><Text style={styles.irMsgT}>{irStatus}</Text></View>}
        {renderBar()}
        <View style={{ height: insets.bottom + 8 }} />
      </View>
      </KeyboardAvoidingView>
    );
  }

  // === RENDER: Main ===
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
    <View style={[styles.outer, { paddingTop: insets.top + 16 }]}>
      <Text style={styles.hdr}>Natrl Remote</Text>
      {acDevice ? (
        <View style={styles.card}>
          <View style={styles.cIcon}><Text style={{ fontSize: 40 }}>❄️</Text></View>
          <View style={styles.cInfo}>
            <Text style={styles.cName}>{acDevice.name}</Text>
            <Text style={styles.cRoom}>{acDevice.room}</Text>
            <View style={styles.cRow}>
              <StateBadge label={acDevice.lastState.power ? "开" : "关"} active={acDevice.lastState.power} />
              <StateBadge label={`${acDevice.lastState.temperature}°C`} active />
              <StateBadge label={modeLabel(acDevice.lastState.mode)} active />
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.empty}>
          <Text style={styles.empIcon}>🎙️</Text>
          <Text style={styles.empTitle}>还没有设备</Text>
          <Text style={styles.empHint}>直接说话就好{"\n"}按着下面说 "我卧室有个空调"</Text>
        </View>
      )}
      {/* Chat history */}
      <ScrollView
        ref={chatRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={() => chatRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.map((msg, i) => (
          <View key={i} style={[styles.chatBubble, msg.role === "user" ? styles.chatUser : styles.chatAssistant]}>
            <Text style={[styles.chatText, msg.role === "user" ? styles.chatTextUser : styles.chatTextAssistant]}>
              {msg.text}
            </Text>
          </View>
        ))}
        {loading && <ActivityIndicator style={{ marginTop: 8 }} color="#58a6ff" />}
      </ScrollView>
      {irStatus && <View style={styles.irMsg}><Text style={styles.irMsgT}>{irStatus}</Text></View>}
      {renderBar()}
      <View style={{ height: insets.bottom + 8 }} />
    </View>
    </KeyboardAvoidingView>
  );

  function renderBar() {
    if (!textMode) {
      // === VOICE MODE: gray bar with centered "按住说话", mode switch above ===
      return (
        <View>
          {voiceBlocked && (
            <View style={styles.voiceNotice}>
              <Text style={styles.voiceNoticeText}>
                ⚠️ 麦克风已阻止 — 点地址栏🔒→允许→刷新
              </Text>
            </View>
          )}
          {!voiceSupported && (
            <View style={styles.voiceNotice}>
              <Text style={styles.voiceNoticeText}>
                ⚠️ 浏览器不支持语音，请用 Chrome
              </Text>
            </View>
          )}
          {/* Mode switch ABOVE the bar */}
          <TouchableOpacity style={styles.modeSwitchAbove} onPress={() => setTextMode(true)}>
            <Text style={styles.modeSwitchIcon}>⌨</Text>
          </TouchableOpacity>
          {/* Voice bar: gray background, centered text */}
          <Pressable
            style={[styles.vBtn, listening && styles.vBtnActive, voiceBlocked && styles.vBtnBlocked]}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            delayLongPress={0}>
            <Text style={styles.vIcon}>{listening ? "⏺" : voiceBlocked ? "🔇" : "🎙️"}</Text>
            <Text style={styles.vText}>
              {listening ? "正在聆听...松开发送"
                : voiceBlocked ? "已阻止（点我重试）"
                : "按住说话"}
            </Text>
          </Pressable>
        </View>
      );
    }

    // === TEXT MODE: mode switch above, input bar below ===
    const ph = acDevice ? "输入指令..." : "比如：我卧室有个空调";
    return (
      <View>
        <TouchableOpacity style={styles.modeSwitchAbove} onPress={() => setTextMode(false)}>
          <Text style={styles.modeSwitchIcon}>🎤</Text>
        </TouchableOpacity>
        <View style={styles.tBar}>
          <TextInput
            style={styles.tInput}
            value={input}
            onChangeText={setInput}
            placeholder={ph}
            placeholderTextColor="#484f58"
            returnKeyType="send"
            onSubmitEditing={() => handleSend()}
            editable={!loading}
            autoFocus
          />
          {input.trim().length > 0 && (
            <TouchableOpacity style={styles.tSend} onPress={() => handleSend()} disabled={loading}>
              {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.tSendT}>↑</Text>}
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }
}

const st = StyleSheet.create({
  badge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginRight: 6, marginTop: 4 },
  badgeOn: { backgroundColor: "#1f6feb33" },
  badgeOff: { backgroundColor: "#30363d" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  badgeTextOn: { color: "#58a6ff" },
  badgeTextOff: { color: "#8b949e" },
});

const styles = StyleSheet.create({
  outer: { flex: 1, backgroundColor: "#0d1117", paddingHorizontal: 20 },
  hdr: { fontSize: 28, fontWeight: "800", color: "#e6edf3", marginBottom: 24 },

  // Setup
  setupCard: { backgroundColor: "#161b22", borderRadius: 16, padding: 24, alignItems: "center", borderColor: "#30363d", borderWidth: 1, marginTop: 20 },
  setupIcon: { fontSize: 48, marginBottom: 12 },
  setupTitle: { fontSize: 20, fontWeight: "700", color: "#e6edf3", marginBottom: 12, textAlign: "center" },
  setupHintSmall: { fontSize: 12, color: "#484f58", textAlign: "center", marginTop: 8 },
  ptext: { fontSize: 14, color: "#58a6ff", marginBottom: 8 },

  // Empty
  empty: { backgroundColor: "#161b22", borderRadius: 16, padding: 32, alignItems: "center", borderColor: "#30363d", borderWidth: 1, marginTop: 40 },
  empIcon: { fontSize: 56, marginBottom: 16 },
  empTitle: { fontSize: 22, fontWeight: "700", color: "#e6edf3", marginBottom: 8 },
  empHint: { fontSize: 14, color: "#8b949e", textAlign: "center", lineHeight: 22 },

  // Device
  card: { backgroundColor: "#161b22", borderRadius: 16, padding: 20, flexDirection: "row", alignItems: "center", borderColor: "#30363d", borderWidth: 1 },
  cIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: "#0d1117", justifyContent: "center", alignItems: "center", marginRight: 16 },
  cInfo: { flex: 1 },
  cName: { fontSize: 20, fontWeight: "700", color: "#e6edf3" },
  cRoom: { fontSize: 14, color: "#8b949e", marginTop: 2 },
  cRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },

  // Chat history
  chatScroll: { flex: 1, marginTop: 12 },
  chatContent: { paddingBottom: 8 },
  chatBubble: { maxWidth: "85%", borderRadius: 16, padding: 12, marginBottom: 8 },
  chatUser: { alignSelf: "flex-end", backgroundColor: "#1f6feb33", borderColor: "#1f6feb44", borderWidth: 1 },
  chatAssistant: { alignSelf: "flex-start", backgroundColor: "#21262d", borderColor: "#30363d", borderWidth: 1 },
  chatText: { fontSize: 15, lineHeight: 21 },
  chatTextUser: { color: "#e6edf3" },
  chatTextAssistant: { color: "#c9d1d9" },

  // IR status
  irMsg: { backgroundColor: "#1a3a1a", borderRadius: 12, padding: 12, marginTop: 10, borderColor: "#2d5a2d", borderWidth: 1 },
  irMsgT: { color: "#7ec97e", fontSize: 13, textAlign: "center", lineHeight: 18 },

  // Voice bar
  voiceNotice: { backgroundColor: "#332b00", borderRadius: 10, padding: 10, marginBottom: 6, borderColor: "#665500", borderWidth: 1 },
  voiceNoticeText: { color: "#ffa726", fontSize: 13, textAlign: "center", lineHeight: 18 },
  vBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#30363d", borderRadius: 28, paddingVertical: 16,
  },
  vBtnActive: { backgroundColor: "#f44336" },
  vBtnBlocked: { backgroundColor: "#484f58", opacity: 0.8 },
  vIcon: { fontSize: 22, marginRight: 8 },
  vText: { color: "#e6edf3", fontSize: 17, fontWeight: "600" },

  // Text bar
  tBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#161b22", borderRadius: 28,
    borderColor: "#30363d", borderWidth: 1, paddingLeft: 18, paddingRight: 6, paddingVertical: 6,
  },
  tInput: { flex: 1, fontSize: 16, color: "#e6edf3", paddingVertical: 10 },
  tSend: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#238636", justifyContent: "center", alignItems: "center", marginLeft: 4 },
  tSendT: { color: "#fff", fontSize: 20, fontWeight: "700" },

  // Mode switch — positioned above the bar
  modeSwitchAbove: { alignSelf: "flex-end", width: 36, height: 36, borderRadius: 18, justifyContent: "center", alignItems: "center", marginBottom: 6, backgroundColor: "#30363d" },
  modeSwitchIcon: { fontSize: 18 },

  // Misc
  linkBtn: { marginTop: 16, alignItems: "center", paddingVertical: 8 },
  linkBtnText: { color: "#58a6ff", fontSize: 14 },
});
