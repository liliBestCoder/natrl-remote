# IRext 全栈解码引擎集成设计

**日期**: 2026-07-09
**状态**: 已确认

## 目标

用 irext 核心库（irext-core）替换当前三套互不统属的 IR 编码系统，统一为单一解码引擎，后端编码 raw_timing，APK 极薄层只负责发射。

## 现状问题

当前存在三套编码系统，没有一套使用 .bin 文件：

| 系统 | 位置 | 覆盖 | 新增品牌成本 |
|------|------|------|------------|
| C++ IRremoteESP8266 (.so/JNI) | APK | 17 AC + 12 TV | 改 C++ 重编译 .so |
| Python waveform-engine | 后端 | 18 AC | 改 Python |
| MySQL decode_remote | 后端 | 108K 固定码 | 依赖已有数据 |

irext 数据库 + .bin 协议文件 + irext-core C 库可以统一替代以上全部。

## 架构

```
用户语音/文字输入
       │
       ▼
┌──────────────────────────────┐
│ NLP (Node.js + DeepSeek)      │
│ 意图提取 → tool_call JSON     │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ irext-engine.ts (Node.js)     │
│                               │
│ 1. 查 MySQL irext DB:         │
│    brand → remote_index       │
│    → protocol + binary_md5    │
│                               │
│ 2. 调 irext-encode 服务:     │
│    POST /encode               │
│    {binary_md5, state}        │
│    → {raw_timing, carrier}    │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ irext-encode (Python FastAPI) │
│                               │
│ 启动时加载全部 .bin 文件      │
│ ctypes 调 irext_decoder.so    │
│ → 实时编码 raw_timing         │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ HTTP Response → APK           │
│ toolCall {                    │
│   raw_timing: [9000,4500,...] │
│   carrier_freq: 38000         │
│ }                             │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ APK (React Native - 极薄层)   │
│ ConsumerIrManager             │
│   .transmit(freq, timing)     │
└──────────────────────────────┘
```

## 各层职责与边界

| 层 | 负责 | 不负责 |
|----|------|--------|
| NLP | 自然语言 → 结构化意图 | IR 编码、数据库查询 |
| irext-engine.ts | MySQL 查询（品牌→协议→.bin）、调编码服务 | 解析 .bin、生成时序 |
| irext-encode | 加载 .bin、实时编码 AC/TV 时序 | 品牌名解析、NLP |
| APK | 收到 raw_timing → transmit() | 编码、状态管理 |

## NLP 与 .bin 的关系

NLP 和 .bin 之间隔了两层，通过 MySQL 连接：

```
NLP 输出: "格力空调制冷26度"
  → brand="格力", device_type="ac", action={temp:26, mode:"cool"}

MySQL irext DB:
  brand 表: "格力" → brand_id=4, category_id=1 (空调)
  remote_index 表: brand_id=4 + category_id=1
    → protocol="new_ac"
    → binary_md5="abc123..."

.bin 文件: abc123.bin
  → irext decoder 加载 + state params
  → raw_timing [9000, 4500, 620, ...]
```

MySQL 是"用户语言 → 机器协议"的翻译层。NLP 不需要知道 .bin 格式，.bin 不需要知道中文品牌名。

## 关键组件

### 1. irext_decoder.so

- 源码: irext-core/decoder/src/*.c (13 个 C 文件)
- 构建: 已有 CMakeLists.txt，适配 Linux target
- 输入: .bin 文件 + 状态参数
- 输出: raw_timing 数组

### 2. irext-encode 服务 (新建)

- Python FastAPI，端口 8002
- 启动时全量加载 5,125 个 .bin 文件（~3MB）
- 通过 ctypes 调用 irext_decoder.so
- API:
  - `POST /encode` — AC 动态编码 `{binary_md5, temperature, mode, fan_speed, power}`
  - `POST /encode_key` — 固定码编码 `{binary_md5, key_name}`

### 3. irext-engine.ts (改造)

- 保留现有 MySQL 查询逻辑
- 新增: 通过 remote_index 查询 binary_md5
- 新增: HTTP 调用 irext-encode 服务获取 raw_timing
- 替代: 旧的 getACTiming（waveform-engine）和 getFixedKeyTiming（decode_remote）

### 4. tools.ts (修改)

- execControlAc: 品牌→binary_md5→/encode→raw_timing→toolCall
- execControlTv: 品牌→binary_md5→/encode_key→raw_timing→toolCall
- execProbeBrand: 同上逻辑，每个探测命令生成 raw_timing

## 需要废弃的组件

- `waveform-engine/` — 被 irext-encode 替代
- `firmware/IRremoteESP8266/` — 被 irext-core 替代
- `backend/src/ir-engine-client.ts` — 功能合并进 irext-engine.ts
- `backend/src/brand-db.ts` — 合并进 irext-engine.ts（直接查 irext DB）

## 不需要改动的组件

- `app/src/services/ir-emitter.ts` — 已有 emitRawTiming()，直接可用
- `app/android/` JNI — 不再需要本地编码，可以后续清理
- `backend/src/nlp.ts` — 接口不变
- `backend/src/server.ts` — 路由不变

## 实施顺序

1. 编译 irext-core/decoder → Linux .so
2. 写 Python ctypes 包装 + FastAPI 编码服务（irext-encode）
3. 改造 irext-engine.ts：MySQL 查询 binary_md5 + 调 irext-encode
4. 替换 tools.ts 中的编码调用
5. 废弃旧 waveform-engine
