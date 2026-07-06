# Natrl Remote — 环境上下文 (2026-07-05)

## 当前状态

### 已安装 & 运行中的服务

| 服务 | 状态 | 端口 | 备注 |
|------|------|------|------|
| MySQL 8.4 | ✅ 运行中 | 3306 | 数据库 `natrl`，用户 `natrl/natrl_dev` |
| Redis 8.0 | ✅ 运行中 | 6379 | |
| Backend (Node) | ✅ 运行中 | 3000 | `npx tsx src/server.ts`，MOCK_MQTT=true, MOCK_REDIS=false |
| Waveform Engine | ✅ 运行中 | 8001 | Python FastAPI, uvicorn |
| Mosquitto | ❌ 未安装 | — | 不需要，MQTT mock 模式 |

### 数据库

```
MySQL: natrl
├── ir_protocols   (17 rows — 16 品牌协议)
├── ir_codes       (7500 rows — 预计算红外码)
└── captured_signals (0 rows)
```

### 后端环境变量

```
WAVEFORM_ENGINE_URL=http://localhost:8001
MOCK_REDIS=false
MOCK_MQTT=true
REDIS_URL=redis://localhost:6379
```

### 后端 API 验证通过

```
GET  /health          → {"status":"ok"}
POST /api/control     → NLP → 设备发现 → 品牌探测 → IR 码返回 ✅
POST /api/devices     → 设备 CRUD ✅
```

## 关键文件修改

### 本次 pg→mysql 迁移修改：
1. `waveform-engine/server.py` — 注释 "PostgreSQL" → "MySQL"
2. `backend/package.json` — 移除 `@types/pg`
3. `backend/db/init.sql` — DROP INDEX IF EXISTS → 条件判断 (MySQL 8.4 不兼容)
4. `backend/db/02_ir_codes_data.sql` — `'{...}'` → `'[...]'` (PG数组→JSON数组)
5. `backend/db/init.sql` — `state_bytes VARCHAR(64)` → `VARCHAR(128)` (daikin 最长72字符)

## APK 打包进度

### ✅ 已完成
- Android SDK 已安装到 `/opt/android-sdk/`
  - platforms: android-34
  - build-tools: 34.0.0
  - platform-tools: 37.0.0
- JDK 25 已安装（太新！）
- App 图标已生成 (`app/assets/icon.png`)
- `npx expo prebuild --platform android` ✅ 成功生成 `app/android/`
- Gradle 8.10.2 已下载

### ❌ 阻塞问题
```
Unsupported class file major version 69
```
**原因**: JDK 25 (class version 69) 太新，Gradle 8.10.2 最高支持 Java 22  
**解决方案**: 需要安装 JDK 17 或 21

```bash
apt-get install -y openjdk-17-jdk-headless
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64
cd /root/natrl-remote/app/android
./gradlew assembleRelease
```

### APK 输出位置
编译成功后 APK 在:
```
/root/natrl-remote/app/android/app/build/outputs/apk/release/app-release.apk
```

### App 连接后端
App 硬编码后端地址在 `app/src/services/api.ts`:
```typescript
return "http://192.168.21.9:3000";  // ← 需改为实际服务器 IP
```

## 快速恢复命令

```bash
# 启动 MySQL（如果没跑）
mysqld --user=root --datadir=/var/lib/mysql &

# 启动 Redis
redis-server --daemonize yes

# 启动波形引擎
cd /root/natrl-remote/waveform-engine
DATABASE_URL=mysql+pymysql://natrl:natrl_dev@localhost:3306/natrl \
  uvicorn server:app --host 0.0.0.0 --port 8001 &

# 启动后端
cd /root/natrl-remote/backend
WAVEFORM_ENGINE_URL=http://localhost:8001 \
MOCK_REDIS=false MOCK_MQTT=true \
REDIS_URL=redis://localhost:6379 \
npx tsx src/server.ts &

# 构建 APK
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64
cd /root/natrl-remote/app/android
./gradlew assembleRelease
```
