import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Platform, Pressable, ScrollView,
  KeyboardAvoidingView, PermissionsAndroid, NativeEventEmitter,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Device, CommandResult } from "../types";
import { control, getDevices } from "../services/api";
import { emitIr, describeIrCommand, hasIrBlaster, transmitRawNEC, emitRawTiming, executeToolCallWithTiming } from "../services/ir-emitter";

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
  const [probeDeviceType, setProbeDeviceType] = useState<string>("ac");

  // Voice mode (default) vs text mode
  const [textMode, setTextMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  const [voiceBlocked, setVoiceBlocked] = useState(false);
  const [diag, setDiag] = useState<string | null>(null);  // diagnostic panel with copyable text
  const handleSendRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null); // web only

  // Debug panel: raw NEC transmitter
  const [showDebug, setShowDebug] = useState(false);
  const [necAddr, setNecAddr] = useState("");
  const [necCmd, setNecCmd] = useState("");
  const [necResult, setNecResult] = useState<string | null>(null);

  // Compare C++ native vs JS encoding
  const handleTestNativeTV = async () => {
    setNecResult("调用原生编码中...");
    try {
      const { NativeModules } = require("react-native");
      const enc = NativeModules.InfraredEncoder;
      if (!enc) { setNecResult("❌ InfraredEncoder 未加载"); return; }
      const result = await enc.encodeTV("changhong", "power");
      const pat = result.pattern;
      setNecResult(`[原生C++] freq=${result.carrierFreq}Hz len=${pat.length}\n前14: ${pat.slice(0, 14).join(", ")}`);
    } catch (e: any) {
      setNecResult(`❌ ${e.message}`);
    }
    setTimeout(() => setNecResult(null), 20000);
  };

  const handleTestJSNEC = () => {
    const { buildNecPattern } = require("../services/ir-emitter");
    const pat = buildNecPattern(0x40, 0x12);
    setNecResult(`[JS调试] addr=0x40 cmd=0x12 len=${pat.length}\n前14: ${pat.slice(0, 14).join(", ")}`);
    setTimeout(() => setNecResult(null), 20000);
  };

  const handleSendNEC = async () => {
    const addr = parseInt(necAddr.trim(), 16);
    const cmd = parseInt(necCmd.trim(), 16);
    if (isNaN(addr) || isNaN(cmd)) {
      setNecResult("❌ 请输入十六进制 (例: 40 12)");
      return;
    }
    setNecResult("发射中...");
    const result = await transmitRawNEC(addr, cmd);
    if (result.success) {
      setNecResult(`✅ 已发射 NEC addr=0x${addr.toString(16).toUpperCase()} cmd=0x${cmd.toString(16).toUpperCase()}`);
    } else {
      setNecResult(`❌ 发射失败: ${result.method}`);
    }
    setTimeout(() => setNecResult(null), 6000);
  };

  const lastTranscriptRef = useRef("");
  const voiceModuleRef = useRef<any>(null); // cached ref to VoiceRecognition native module

  // ── Voice Recognition setup (in-app SpeechRecognizer, no dialog, no IME) ──
  useEffect(() => {
    if (Platform.OS === "web") {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      setVoiceAvailable(!!SR);
    } else {
      const { NativeModules } = require("react-native");
      const VR = NativeModules.VoiceRecognition;
      voiceModuleRef.current = VR;

      if (!VR) {
        setDiag("❌ VoiceRecognition 原生模块未找到\n→ APK 可能缺少原生代码，请确认已安装最新版本");
        return;
      }

      const emitter = new NativeEventEmitter(VR);
      emitter.addListener("voiceStart", () => setListening(true));
      emitter.addListener("voiceResult", (e: any) => {
        if (e?.transcript) {
          lastTranscriptRef.current = e.transcript;
          if (e.isFinal) {
            setListening(false);
            handleSendRef.current(e.transcript);
          }
        }
      });
      emitter.addListener("voiceError", (e: any) => {
        setListening(false);
        setDiag(`❌ 语音识别错误\n${e?.error || JSON.stringify(e)}`);
        if ((e?.error || '').includes("权限")) setVoiceBlocked(true);
      });
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
    if (Platform.OS === "web") {
      if (!voiceAvailable) {
        setDiag("❌ 浏览器不支持 SpeechRecognition API");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (permErr: any) {
        if (permErr.name === "NotAllowedError") {
          setVoiceBlocked(true);
          setDiag("❌ 麦克风权限被拒绝\n→ 点浏览器地址栏左侧🔒→允许麦克风→刷新页面");
        }
        return;
      }
      try {
        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (recognitionRef.current) recognitionRef.current.abort();
        const rec = new SR();
        rec.lang = "zh-CN";
        rec.interimResults = false;
        rec.continuous = false;
        rec.onresult = (e: any) => {
          handleSendRef.current(e.results[0][0].transcript);
        };
        rec.onerror = (e: any) => {
          if (e.error === "not-allowed") setVoiceBlocked(true);
        };
        recognitionRef.current = rec;
        rec.start();
      } catch (_e: any) {}
    } else {
      try {
        const granted = await PermissionsAndroid.request(
          "android.permission.RECORD_AUDIO",
          { title: "麦克风权限", message: "语音控制需要麦克风权限",
            buttonPositive: "允许", buttonNegative: "拒绝" }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setVoiceBlocked(true);
          setDiag("❌ RECORD_AUDIO 权限被拒绝\n→ 系统设置→应用→Natrl→权限→允许麦克风");
          return;
        }
        const VR = voiceModuleRef.current;
        if (!VR) {
          setDiag("❌ VoiceRecognition 模块引用为空\n→ APK 可能缺少原生代码，请更新APP");
          return;
        }
        if (!VR.startListening) {
          setDiag("❌ VoiceRecognition.startListening 方法不存在\n→ 原生模块注册异常，请更新APP");
          return;
        }
        await VR.startListening("zh-CN");
      } catch (e: any) {
        if (e?.code === "NO_ENGINE") {
          setDiag("❌ SpeechRecognizer 创建失败 (NO_ENGINE)\n→ 系统无可用的语音识别服务");
        } else {
          setDiag(`❌ startListening 失败\ncode: ${e?.code || 'none'}\nmessage: ${e?.message || String(e)}`);
        }
      }
    }
  }, [voiceAvailable, addAssistantMsg]);

  const stopVoice = useCallback(() => {
    if (Platform.OS === "web") {
      if (recognitionRef.current) recognitionRef.current.abort();
    } else {
      try {
        const { NativeModules } = require("react-native");
        NativeModules.VoiceRecognition?.stopListening();
      } catch (_e) {}
    }
  }, []);

  const handleSend = async (textOverride?: string) => {
    const text = (textOverride || input).trim();
    if (!text) return;
    setInput("");
    addUserMsg(text);
    setLoading(true);

    try {
      const result: CommandResult = await control(text);
      addAssistantMsg(result.message);
      if (result.phase === "discovery" || result.phase === "registration") {
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

      // ── Execute tool_call — NEW: raw_timing from backend, client just transmits ──
      if (result.toolCall) {
        const tc = result.toolCall;
        console.log(`[app] tool_call: ${tc.name}`, JSON.stringify(tc.args).substring(0, 200));

        // Check if backend sent raw_timing (new irext-powered mode)
        if (tc.args.raw_timing && tc.args.raw_timing.length > 0) {
          // ═══ NEW MODE: backend encoded, client just emits ═══
          const irResult = await executeToolCallWithTiming(tc);
          const nameMap: Record<string, string> = {
            control_ac: "❄️ AC", control_tv: "📺 TV", probe_brand: "🔍 探测",
          };
          const prefix = nameMap[tc.name] || "📡";
          if (irResult.success) {
            setIrStatus(`${prefix} 红外已发射 | ${tc.args.raw_timing.length} pulses @ ${tc.args.carrier_freq || 38000}Hz`);
          } else {
            setDiag(irResult.method === "no_hardware"
              ? `❌ 无红外硬件\n→ 手机不支持 ConsumerIrManager`
              : `❌ 发射失败\n→ reason: ${irResult.method}`);
          }
          setTimeout(() => setIrStatus(null), 8000);

        } else if (tc.name === "probe_brand" && tc.args.probe_commands) {
          const brandCode = tc.args.brand_code || "unknown";
          const probeCmds = tc.args.probe_commands;
          const emitResults: string[] = [];

          const isTVProbe = probeCmds.length === 1 && (probeCmds[0] as any).temperature === 0;
          setProbeDeviceType(isTVProbe ? "tv" : "ac");

          const hasRawTiming = probeCmds.length > 0 && (probeCmds[0] as any).raw_timing?.length > 0;

          if (!hasRawTiming) {
            setDiag(`❌ 后端未能生成红外编码\n→ 该品牌遥控器数据可能不完整`);
            setTimeout(() => setIrStatus(null), 8000);
          } else {
            for (let i = 0; i < probeCmds.length; i++) {
              const cmd = probeCmds[i] as any;
              const idx = i + 1;
              const result = await emitRawTiming(cmd.carrier_freq || 38000, cmd.raw_timing, 1);
              const icon = result.success ? "📡" : "❌";
              emitResults.push(`${icon} ${idx}/${probeCmds.length}: ${cmd.label}`);
              setIrStatus(`🔍 探测: ${brandCode}\n${emitResults.slice(-3).join("\n")}`);

              if (i < probeCmds.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            const successCount = emitResults.filter(r => r.startsWith("📡")).length;
            if (successCount === probeCmds.length) {
              setIrStatus(`✅ ${probeCmds.length}条命令已全部发射 (${brandCode})\n观察空调是否有反应...`);
            } else if (successCount > 0) {
              setIrStatus(`⚠️ ${successCount}/${probeCmds.length} 条已发射 (${brandCode})\n观察空调是否有反应...`);
            } else {
              setDiag(`❌ 无红外硬件\n→ 手机不支持红外发射 (${brandCode})`);
            }
            setTimeout(() => setIrStatus(null), 10000);
          }

        } else if (tc.name === "control_ac" || tc.name === "control_tv") {
          // Should not reach here — raw_timing path above handles both.
          // If we do, it means backend sent a toolCall without raw_timing.
          setDiag(`❌ 后端未提供红外编码数据\n→ 请检查 irext-encode 服务是否正常`);
          setTimeout(() => setIrStatus(null), 6000);
        }
      }

      await loadDevices();
    } catch (e: any) {
      if (e.message?.includes("fetch") || e.message?.includes("Network")) {
        setDiag(`❌ 网络请求失败\n→ ${e.message}\n→ 请确认后端已启动`);
      } else {
        setDiag(`❌ 请求异常\n→ ${e.message || String(e)}`);
      }
    }
    setLoading(false);
  };

  // Keep ref in sync so event listeners always use the latest handleSend
  handleSendRef.current = handleSend;

  // Hold-to-talk handlers (after handleSend so closure captures it)
  const handlePressIn = useCallback(() => {
    if (textMode) return;
    lastTranscriptRef.current = "";
    setListening(true);
    startVoice();
  }, [textMode, startVoice]);

  const handlePressOut = useCallback(() => {
    stopVoice();
    setListening(false);
    const text = lastTranscriptRef.current.trim();
    if (text) handleSend(text);
  }, [stopVoice, handleSend]);

  const activeDevice = devices.find((d) => d.verified);
  const isTV = activeDevice?.deviceType === "tv";

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
              <Text style={styles.setupHintSmall}>观察{probeDeviceType === "tv" ? "电视" : "空调"}，说"有反应"或"没反应"</Text>
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
        {diag && (
          <View style={styles.diagPanel}>
            <View style={styles.diagHeader}>
              <Text style={styles.diagTitle}>🔧 诊断</Text>
              <TouchableOpacity onPress={() => setDiag(null)}>
                <Text style={styles.diagClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={styles.diagText} value={diag} multiline editable={false} selectTextOnFocus />
          </View>
        )}
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
      {activeDevice ? (isTV ? (
        <View style={styles.card}>
          <View style={styles.cIcon}><Text style={{ fontSize: 40 }}>📺</Text></View>
          <View style={styles.cInfo}>
            <Text style={styles.cName}>{activeDevice.name}</Text>
            <Text style={styles.cRoom}>{activeDevice.room}</Text>
            <View style={styles.cRow}>
              <StateBadge label={activeDevice.lastState.power ? "开" : "关"} active={activeDevice.lastState.power} />
              <StateBadge label={activeDevice.brandCode || "TV"} active={!!activeDevice.brandCode} />
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.cIcon}><Text style={{ fontSize: 40 }}>❄️</Text></View>
          <View style={styles.cInfo}>
            <Text style={styles.cName}>{activeDevice.name}</Text>
            <Text style={styles.cRoom}>{activeDevice.room}</Text>
            <View style={styles.cRow}>
              <StateBadge label={activeDevice.lastState.power ? "开" : "关"} active={activeDevice.lastState.power} />
              <StateBadge label={`${activeDevice.lastState.temperature}°C`} active />
              <StateBadge label={modeLabel(activeDevice.lastState.mode)} active />
            </View>
          </View>
        </View>
      )) : (
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

      {/* ── Diagnostic Panel (copyable) ── */}
      {diag && (
        <View style={styles.diagPanel}>
          <View style={styles.diagHeader}>
            <Text style={styles.diagTitle}>🔧 诊断</Text>
            <TouchableOpacity onPress={() => setDiag(null)}>
              <Text style={styles.diagClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.diagText}
            value={diag}
            multiline
            editable={false}
            selectTextOnFocus
          />
        </View>
      )}

      {/* ── Debug Panel: Raw NEC Transmitter ── */}
      <TouchableOpacity style={styles.debugToggle} onPress={() => setShowDebug(!showDebug)}>
        <Text style={styles.debugToggleText}>🔧 {showDebug ? "隐藏" : "调试"}面板</Text>
      </TouchableOpacity>
      {showDebug && (
        <View style={styles.debugPanel}>
          {/* Compare native vs JS encoding */}
          <View style={styles.debugRowBtns}>
            <TouchableOpacity style={styles.debugBtnSm} onPress={handleTestNativeTV}>
              <Text style={styles.debugBtnText}>🔬 C++原生编码</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.debugBtnSm} onPress={handleTestJSNEC}>
              <Text style={styles.debugBtnText}>📐 JS编码</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.debugRow}>
            <Text style={styles.debugLabel}>NEC 地址 (hex):</Text>
            <TextInput
              style={styles.debugInput}
              value={necAddr}
              onChangeText={setNecAddr}
              placeholder="40"
              placeholderTextColor="#484f58"
              autoCapitalize="none"
            />
          </View>
          <View style={styles.debugRow}>
            <Text style={styles.debugLabel}>NEC 命令 (hex):</Text>
            <TextInput
              style={styles.debugInput}
              value={necCmd}
              onChangeText={setNecCmd}
              placeholder="12"
              placeholderTextColor="#484f58"
              autoCapitalize="none"
            />
          </View>
          <TouchableOpacity style={styles.debugSend} onPress={handleSendNEC}>
            <Text style={styles.debugSendText}>📡 发射 NEC</Text>
          </TouchableOpacity>
          {necResult && (
            <TextInput
              style={styles.debugResult}
              value={necResult}
              multiline
              editable={false}
              selectTextOnFocus
            />
          )}
        </View>
      )}

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
                ⚠️ 麦克风已阻止 — {Platform.OS === "web"
                  ? "点地址栏🔒→允许→刷新"
                  : "请在系统设置→应用权限中允许麦克风权限"}
              </Text>
            </View>
          )}
          {Platform.OS === "web" && !voiceAvailable && (
            <View style={styles.voiceNotice}>
              <Text style={styles.voiceNoticeText}>⚠️ 浏览器不支持语音，请用 Chrome</Text>
            </View>
          )}
          {/* Voice bar: same container style as text bar, mode switch inside */}
          <View style={styles.tBar}>
            <Pressable
              style={[styles.vBtnInner, listening && styles.vBtnInnerActive, voiceBlocked && styles.vBtnInnerBlocked]}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}>
              <Text style={styles.vText}>
                {listening ? "⏺ 聆听中...松开发送"
                  : voiceBlocked ? "已阻止（点我重试）"
                  : "按住说话"}
              </Text>
            </Pressable>
            <TouchableOpacity style={styles.modeSwitch} onPress={() => setTextMode(true)}>
              <Text style={styles.modeSwitchIcon}>⌨</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    // === TEXT MODE: input bar with voice switch on right ===
    const ph = activeDevice ? "输入指令..." : "比如：我卧室有个空调";
    return (
      <View>
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
          <TouchableOpacity style={styles.modeSwitch} onPress={() => setTextMode(false)}>
            <Text style={styles.modeSwitchIcon}>🗣️</Text>
          </TouchableOpacity>
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
  vBtnInner: {
    flex: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 10,
  },
  vBtnInnerActive: { backgroundColor: "#f4433622" },
  vBtnInnerBlocked: { opacity: 0.6 },
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

  // Mode switch — inside the bar, right side
  modeSwitch: { width: 40, height: 40, borderRadius: 20, justifyContent: "center", alignItems: "center", marginLeft: 8, backgroundColor: "#30363d" },
  modeSwitchIcon: { fontSize: 18 },

  // Misc
  linkBtn: { marginTop: 16, alignItems: "center", paddingVertical: 8 },
  linkBtnText: { color: "#58a6ff", fontSize: 14 },

  // Voice diagnostic panel (copyable)
  diagPanel: {
    backgroundColor: "#1a1a2e", borderRadius: 12, padding: 10,
    borderColor: "#ffa726", borderWidth: 1, marginTop: 8,
  },
  diagHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  diagTitle: { color: "#ffa726", fontSize: 13, fontWeight: "700" },
  diagClose: { color: "#ffa726", fontSize: 18, paddingHorizontal: 4 },
  diagText: {
    color: "#e6edf3", fontSize: 12, lineHeight: 18,
    backgroundColor: "#0d1117", borderRadius: 8, padding: 8,
    borderColor: "#30363d", borderWidth: 1, textAlignVertical: "top",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },

  // Debug panel
  debugToggle: { alignSelf: "flex-end", paddingVertical: 4, paddingHorizontal: 8, marginTop: 4 },
  debugToggleText: { color: "#8b949e", fontSize: 12 },
  debugPanel: {
    backgroundColor: "#161b22", borderRadius: 12, padding: 12,
    borderColor: "#30363d", borderWidth: 1, marginTop: 4,
  },
  debugRowBtns: { flexDirection: "row", gap: 8, marginBottom: 10 },
  debugBtnSm: {
    flex: 1, backgroundColor: "#21262d", borderRadius: 8, paddingVertical: 8,
    alignItems: "center", borderColor: "#30363d", borderWidth: 1,
  },
  debugBtnText: { color: "#58a6ff", fontSize: 13, fontWeight: "600" },
  debugRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  debugLabel: { color: "#8b949e", fontSize: 13, width: 100 },
  debugInput: {
    flex: 1, backgroundColor: "#0d1117", borderRadius: 8,
    borderColor: "#30363d", borderWidth: 1, paddingHorizontal: 10,
    paddingVertical: 6, fontSize: 14, color: "#e6edf3", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  debugSend: {
    backgroundColor: "#238636", borderRadius: 8, paddingVertical: 8,
    alignItems: "center", marginTop: 4,
  },
  debugSendText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  debugResult: {
    color: "#7ec97e", fontSize: 12, marginTop: 6,
    backgroundColor: "#0d1117", borderRadius: 8, padding: 8,
    borderColor: "#30363d", borderWidth: 1, textAlignVertical: "top",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
