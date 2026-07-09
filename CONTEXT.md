# Natrl Remote — 环境上下文 (2026-07-09)

## 当前状态

### 已安装 & 运行中的服务

| 服务 | 状态 | 端口 | 备注 |
|------|------|------|------|
| MySQL 8.4 | ✅ 运行中 | 3306 | 数据库 `natrl`(natrl_dev) + `irext`(root) |
| Redis 8.0 | ✅ 运行中 | 6379 | |
| Backend (Node) | ✅ 运行中 | 3000 | `npx tsx src/server.ts`，需要 `IREXT_ENCODE_URL=http://localhost:8002` |
| irext-encode (NEW) | ✅ 运行中 | 8002 | Python FastAPI, ctypes→libirdecode.so, 3904 .bin 已加载 |
| Waveform Engine | ⚠️ 待废弃 | 8001 | 被 irext-encode 替代，仍运行作为回退 |

### 数据库

```
MySQL:
├── natrl (用户: natrl/natrl_dev)
│   ├── ir_protocols   (25 rows)
│   ├── ir_codes       (7500 rows)
│   └── captured_signals (0 rows)
│
└── irext (用户: root)
    ├── brand           (1,818 rows — 品牌)
    ├── remote_index    (7,051 rows — 遥控器索引)
    ├── decode_remote   (108,680 rows — 预计算时序)
    ├── ir_protocol     (222 rows — 协议定义)
    ├── key_mapping     (16 rows — 按键映射)
    └── category        (16 rows — 设备类别)
```

### 后端环境变量

```bash
IREXT_ENCODE_URL=http://localhost:8002   # NEW: irext 编码服务
WAVEFORM_ENGINE_URL=http://localhost:8001 # OLD: 待废弃
MOCK_REDIS=false
MOCK_MQTT=true
REDIS_URL=redis://localhost:6379
```

## irext 集成进度

### ✅ 已完成

1. **MySQL irext DB 导入** — 105MB SQL dump，11 张表，~300K 行
2. **irext_binaries.zip 解压** — 5,125 个 .bin 协议文件
3. **irext-core 源码克隆** — GitHub: irext/core → `/root/natrl-remote/irext-core/`
4. **libirdecode.so 编译** — gcc 直接编译 13 个 C 文件，143KB，版本 1.5.2
5. **Python ctypes 绑定** — `backend/irext_encode/irext_binding.py`，加载 .so 调用 C API
6. **irext-encode FastAPI 服务** — `backend/irext_encode/server.py`，:8002
   - POST `/encode_ac` — AC 状态 → raw_timing ✅
   - POST `/encode_key` — 固定按键 → raw_timing ✅
   - 启动时全量加载 3,904 个唯一 .bin 到内存
7. **irext-engine.ts 重写** — 不再依赖 waveform-engine / decode_remote，改为 MySQL binary_md5 查询 + HTTP 调 irext-encode
8. **tools.ts 适配** — execControlAc/Tv/probe 全部走新的 irext-engine
9. **前端适配** — HomeScreen.tsx 优先用 raw_timing 直发，ir-emitter.ts 新增 emitRawTiming

### 🔄 待处理

- ~~**tools.ts 重启后仍有旧代码**~~ ✅ 已修复
- ~~**irext-encode 未加入 start.sh**~~ ✅ 已加入
- **waveform-engine 待正式下线** — 移除 `/waveform-engine/`
- **IRremoteESP8266 待清理** — 被 irext-core 替代，JNI 不再需要

## 快速恢复命令

```bash
# 一键启动
cd /root/natrl-remote && bash start.sh start

# 手动启动 irext-encode（start.sh 暂未包含）
cd /root/natrl-remote/backend/irext_encode
nohup uvicorn server:app --host 0.0.0.0 --port 8002 > /root/natrl-remote/logs/irext-encode.log 2>&1 &

# 重启后端（带 irext-encode URL）
fuser -k 3000/tcp
cd /root/natrl-remote/backend
IREXT_ENCODE_URL=http://localhost:8002 \
WAVEFORM_ENGINE_URL=http://localhost:8001 \
MOCK_REDIS=false MOCK_MQTT=true \
REDIS_URL=redis://localhost:6379 \
nohup npx tsx src/server.ts > /root/natrl-remote/logs/backend.log 2>&1 &

# 验证
curl http://localhost:8002/health  # irext-encode: {loaded_bins:3904}
curl http://localhost:3000/health   # backend
```

## 架构图（新）

```
NLP (Node.js) → irext-engine.ts
                  ├── MySQL irext DB: brand → binary_md5
                  └── HTTP POST irext-encode:8002
                        └── irext_binding.py (ctypes)
                              └── libirdecode.so (irext-core C)
                                    └── .bin 协议文件 (3904 个)
                                          └── raw_timing → APK transmit()
```

## 关键文件

| 文件 | 用途 |
|------|------|
| `backend/src/irext-engine.ts` | MySQL 查询 + irext-encode HTTP 调用 |
| `backend/irext_encode/server.py` | FastAPI 编码服务 |
| `backend/irext_encode/irext_binding.py` | ctypes 包装 C API |
| `backend/irext_encode/bin_loader.py` | 启动时加载全部 .bin |
| `irext-core/build/libirdecode.so` | C 解码库 (143KB) |
| `irext-core/decoder/src/` | C 源码 (13 .c 文件) |
| `irext-data/irext-binaries_20260519/` | 5,125 个 .bin 协议文件 |
| `app/src/services/ir-emitter.ts` | 前端 IR 发射 (emitRawTiming) |
| `docs/superpowers/specs/2026-07-09-irext-integration-design.md` | 设计文档 |
| `docs/superpowers/plans/2026-07-09-irext-integration.md` | 执行计划 |
