import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import {
  createDevice,
  learnDevice,
  probeDevice,
  probeRespond,
  verifyDevice,
} from "../services/api";

type Step =
  | "idle"
  | "choose_method"
  | "learning"
  | "probing"
  | "verifying"
  | "done";

interface Props {
  onComplete: () => void;
}

export default function SetupScreen({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [deviceId, setDeviceId] = useState("");
  const [room, setRoom] = useState("bedroom");
  const [name, setName] = useState("卧室空调");
  const [statusMsg, setStatusMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      const result = await createDevice(room, name);
      setDeviceId(result.device.id);
      setStep("choose_method");
      setStatusMsg("设备已创建。请选择识别空调品牌的方式。");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(false);
  };

  const handleLearn = async () => {
    setStep("learning");
    setLoading(true);
    setStatusMsg("请将遥控器对准节点，按下开机键...");
    try {
      await learnDevice(deviceId);
      setStatusMsg("正在等待遥控器信号（15 秒）...");
      setTimeout(() => {
        setStep("verifying");
        setStatusMsg("品牌识别完成！请验证：空调是否正常工作？");
        setLoading(false);
      }, 5000);
    } catch (e: any) {
      Alert.alert("Error", e.message);
      setStep("choose_method");
      setLoading(false);
    }
  };

  const handleProbe = async () => {
    setStep("probing");
    setLoading(true);
    try {
      const result = await probeDevice(deviceId);
      setStatusMsg(result.message);
      setLoading(false);
    } catch (e: any) {
      Alert.alert("Error", e.message);
      setStep("choose_method");
      setLoading(false);
    }
  };

  const handleProbeResponse = async (responded: boolean) => {
    setLoading(true);
    try {
      const result = await probeRespond(deviceId, responded);
      setStatusMsg(result.message);
      if (result.status === "identified") {
        setStep("verifying");
      } else if (result.status === "exhausted") {
        setStatusMsg("已尝试所有品牌，未匹配。请尝试遥控器学习。");
        setStep("choose_method");
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(false);
  };

  const handleVerify = async (coldOk: boolean, hotOk: boolean) => {
    setLoading(true);
    try {
      const result = await verifyDevice(deviceId, coldOk, hotOk);
      if (result.status === "verified") {
        setStep("done");
        setStatusMsg("✅ 设置完成！你的空调已就绪。");
      } else {
        Alert.alert("验证失败", "请重试或更换识别方式。");
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(false);
  };

  if (step === "idle") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>添加设备</Text>
        <Text style={styles.label}>房间</Text>
        <TextInput
          style={styles.input}
          value={room}
          onChangeText={setRoom}
          placeholder="例如：bedroom"
          placeholderTextColor="#484f58"
        />
        <Text style={styles.label}>设备名称</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="例如：卧室空调"
          placeholderTextColor="#484f58"
        />
        <TouchableOpacity style={styles.button} onPress={handleCreate}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>创建设备</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  if (step === "choose_method") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>识别空调品牌</Text>
        <Text style={styles.subtitle}>{statusMsg}</Text>
        <TouchableOpacity style={styles.button} onPress={handleLearn}>
          <Text style={styles.buttonText}>📡 遥控器学习（推荐）</Text>
        </TouchableOpacity>
        <View style={{ height: 12 }} />
        <TouchableOpacity style={styles.buttonOutline} onPress={handleProbe}>
          <Text style={styles.buttonOutlineText}>🔍 云端自动探测</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (step === "learning") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#4fc3f7" />
        <Text style={styles.title}>学习中...</Text>
        <Text style={styles.subtitle}>{statusMsg}</Text>
      </View>
    );
  }

  if (step === "probing") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>云端探测中</Text>
        <Text style={styles.subtitle}>{statusMsg}</Text>
        {loading ? (
          <ActivityIndicator size="large" color="#4fc3f7" />
        ) : (
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.button, { flex: 1, backgroundColor: "#4caf50" }]}
              onPress={() => handleProbeResponse(true)}>
              <Text style={styles.buttonText}>✓ 有反应</Text>
            </TouchableOpacity>
            <View style={{ width: 12 }} />
            <TouchableOpacity
              style={[styles.button, { flex: 1, backgroundColor: "#f44336" }]}
              onPress={() => handleProbeResponse(false)}>
              <Text style={styles.buttonText}>✗ 没反应</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  if (step === "verifying") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>最后验证</Text>
        <Text style={styles.subtitle}>{statusMsg}</Text>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: "#4caf50" }]}
          onPress={() => handleVerify(true, true)}>
          <Text style={styles.buttonText}>✓ 制冷和制热都正常</Text>
        </TouchableOpacity>
        <View style={{ height: 12 }} />
        <TouchableOpacity
          style={[styles.button, { backgroundColor: "#f44336" }]}
          onPress={() =>
            Alert.alert("请重试", "可能需要重新探测或换遥控器学习")
          }>
          <Text style={styles.buttonText}>✗ 有问题，重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>✅</Text>
      <Text style={styles.title}>{statusMsg}</Text>
      <TouchableOpacity style={styles.button} onPress={onComplete}>
        <Text style={styles.buttonText}>开始使用</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
    padding: 24,
    justifyContent: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#e6edf3",
    marginBottom: 16,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: "#8b949e",
    marginBottom: 24,
    textAlign: "center",
    lineHeight: 24,
  },
  emoji: { fontSize: 48, textAlign: "center", marginBottom: 16 },
  label: {
    fontSize: 14,
    color: "#8b949e",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#161b22",
    borderColor: "#30363d",
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: "#e6edf3",
  },
  button: {
    backgroundColor: "#238636",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    marginTop: 24,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  buttonOutline: {
    borderColor: "#30363d",
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
  },
  buttonOutlineText: { color: "#e6edf3", fontSize: 16 },
  row: { flexDirection: "row", marginTop: 24 },
});
