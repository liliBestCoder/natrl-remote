import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Device } from "../types";
import { control, getDevices } from "../services/api";
import SetupScreen from "./SetupScreen";

function StateBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <View
      style={[
        stateStyles.badge,
        active ? stateStyles.active : stateStyles.inactive,
      ]}>
      <Text
        style={[
          stateStyles.badgeText,
          active ? stateStyles.activeText : stateStyles.inactiveText,
        ]}>
        {label}
      </Text>
    </View>
  );
}

function modeLabel(mode: string): string {
  const map: Record<string, string> = {
    cool: "制冷",
    heat: "制热",
    dry: "除湿",
    fan_only: "送风",
    auto: "自动",
  };
  return map[mode] || mode;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [devices, setDevices] = useState<Device[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);

  const loadDevices = useCallback(async () => {
    try {
      const result = await getDevices();
      setDevices(result.devices);
      if (
        result.devices.length === 0 ||
        !result.devices.some((d) => d.verified)
      ) {
        setShowSetup(true);
      }
    } catch (_e) {
      if (initialLoad) setShowSetup(true);
    }
    setInitialLoad(false);
  }, [initialLoad]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const handleControl = async () => {
    const text = input.trim();
    if (!text) return;
    setLoading(true);
    setInput("");
    setLastMessage(null);
    try {
      const result = await control(text);
      setLastMessage(result.message);
      await loadDevices();
    } catch (e: any) {
      setLastMessage(`错误: ${e.message}`);
    }
    setLoading(false);
  };

  if (showSetup) {
    return (
      <SetupScreen
        onComplete={() => {
          setShowSetup(false);
          loadDevices();
        }}
      />
    );
  }

  const acDevice = devices.find(
    (d) => d.deviceType === "ac" && d.verified
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <Text style={styles.headerTitle}>Natrl Remote</Text>

      {acDevice ? (
        <View style={styles.deviceCard}>
          <View style={styles.deviceIcon}>
            <Text style={{ fontSize: 40 }}>❄️</Text>
          </View>
          <View style={styles.deviceInfo}>
            <Text style={styles.deviceName}>{acDevice.name}</Text>
            <Text style={styles.deviceRoom}>{acDevice.room}</Text>
            <View style={styles.stateRow}>
              <StateBadge
                label={acDevice.lastState.power ? "开" : "关"}
                active={acDevice.lastState.power}
              />
              <StateBadge
                label={`${acDevice.lastState.temperature}°C`}
                active={true}
              />
              <StateBadge
                label={modeLabel(acDevice.lastState.mode)}
                active={true}
              />
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>暂无设备</Text>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => setShowSetup(true)}>
            <Text style={styles.addButtonText}>+ 添加空调</Text>
          </TouchableOpacity>
        </View>
      )}

      {lastMessage && (
        <View style={styles.messageBanner}>
          <Text style={styles.messageText}>{lastMessage}</Text>
        </View>
      )}

      <View style={{ flex: 1 }} />

      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          placeholder="告诉我要做什么... 例如：调到26度"
          placeholderTextColor="#484f58"
          returnKeyType="send"
          onSubmitEditing={handleControl}
          editable={!loading}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            loading && styles.sendButtonDisabled,
          ]}
          onPress={handleControl}
          disabled={loading || !input.trim()}>
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.sendButtonText}>↑</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={{ height: insets.bottom + 8 }} />
    </View>
  );
}

const stateStyles = StyleSheet.create({
  badge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 6,
    marginTop: 4,
  },
  active: { backgroundColor: "#1f6feb33" },
  inactive: { backgroundColor: "#30363d" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  activeText: { color: "#58a6ff" },
  inactiveText: { color: "#8b949e" },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
    paddingHorizontal: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: "#e6edf3",
    marginBottom: 24,
  },
  deviceCard: {
    backgroundColor: "#161b22",
    borderRadius: 16,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    borderColor: "#30363d",
    borderWidth: 1,
  },
  deviceIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#0d1117",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 20, fontWeight: "700", color: "#e6edf3" },
  deviceRoom: { fontSize: 14, color: "#8b949e", marginTop: 2 },
  stateRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 8,
  },
  emptyCard: {
    backgroundColor: "#161b22",
    borderRadius: 16,
    padding: 32,
    alignItems: "center",
    borderColor: "#30363d",
    borderWidth: 1,
  },
  emptyText: {
    fontSize: 16,
    color: "#8b949e",
    marginBottom: 16,
  },
  addButton: {
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  addButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  messageBanner: {
    backgroundColor: "#1f6feb22",
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
    borderColor: "#1f6feb44",
    borderWidth: 1,
  },
  messageText: {
    color: "#e6edf3",
    fontSize: 15,
    textAlign: "center",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#161b22",
    borderRadius: 24,
    borderColor: "#30363d",
    borderWidth: 1,
    paddingLeft: 18,
    paddingRight: 6,
    paddingVertical: 6,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    color: "#e6edf3",
    paddingVertical: 8,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#238636",
    justifyContent: "center",
    alignItems: "center",
  },
  sendButtonDisabled: { backgroundColor: "#30363d" },
  sendButtonText: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
