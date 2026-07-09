# IRext 全栈解码引擎集成 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 irext-core C 库替换现有三套 IR 编码系统，统一为后端编码 raw_timing、APK 极薄发射的架构。

**Architecture:** irext-core/decoder 编译为 Linux .so → Python ctypes 包装 → FastAPI 编码服务 → Node.js backend 调服务 → raw_timing 发给 APK → ConsumerIrManager.transmit()

**Tech Stack:** C (gcc/cmake), Python 3 (ctypes/FastAPI/uvicorn), Node.js/TypeScript, MySQL, React Native

## Global Constraints

- .so 编译目标: Linux x86_64 (当前服务器环境)
- Python FastAPI 端口: 8002 (不与 8001 waveform-engine 冲突)
- 所有 .bin 文件位于: /root/natrl-remote/irext-data/irext-binaries_20260519/
- MySQL irext 数据库: localhost, user root, database irext
- APK 端: 只改 HomeScreen.tsx，保留 emitRawTiming 回退路径

---

## File Structure

### 新建
| 文件 | 职责 |
|------|------|
| `irext-core/build/irdecode.so` | 编译产物，C 解码库 |
| `backend/irext-encode/__init__.py` | Python 包 |
| `backend/irext-encode/irext_binding.py` | ctypes 包装 C API |
| `backend/irext-encode/server.py` | FastAPI 服务: POST /encode, POST /encode_key, GET /health |
| `backend/irext-encode/bin_loader.py` | 启动时加载全部 .bin 到内存 |
| `backend/irext-encode/requirements.txt` | Python 依赖 |

### 修改
| 文件 | 改动 |
|------|------|
| `backend/src/irext-engine.ts` | 加入 MySQL binary_md5 查询 + HTTP 调 irext-encode |
| `backend/src/tools.ts` | execControlAc/Tv/probe 改用新 irext-engine |
| `backend/src/types.ts` | 确保 ToolCallArgs 有 raw_timing/carrier_freq/repeat |
| `app/src/screens/HomeScreen.tsx` | 已有 raw_timing 优先路径，确认无误 |

### 废弃
| 文件 | 原因 |
|------|------|
| `waveform-engine/` | 被 irext-encode 替代 |
| `backend/src/ir-engine-client.ts` | 合并进 irext-engine.ts |
| `firmware/IRremoteESP8266` | 被 irext-core 替代 |

> 注: `backend/src/brand-db.ts` 保留，probe 流程的品牌匹配/排序仍需要它。

---

### Task 1: 编译 irext-core decoder 为 Linux 共享库

**Files:**
- Create: `irext-core/build/irdecode.so` (编译输出)
- Modify: `irext-core/decoder/CMakeLists.txt` (添加 -fPIC 到 SHARED target)

**Interfaces:**
- Produces: `libirdecode.so` — 包含 ir_binary_open, ir_decode, ir_close, ir_decode_combo, get_temperature_range, get_supported_mode, get_supported_wind_speed 等函数

- [ ] **Step 1: 修复 CMakeLists.txt 中 SHARED target 缺少 -fPIC**

`irext-core/decoder/CMakeLists.txt` 第 60-61 行，在 `irdecode` SHARED target 加 `-fPIC`:

```cmake
target_compile_options(irdecode PRIVATE
        -DBOARD_PC -fPIC)
```

- [ ] **Step 2: 创建 build 目录并运行 cmake**

```bash
mkdir -p /root/natrl-remote/irext-core/build
cd /root/natrl-remote/irext-core/build
cmake ../decoder -DCMAKE_BUILD_TYPE=Release
```

- [ ] **Step 3: 编译**

```bash
make irdecode -j$(nproc)
```

- [ ] **Step 4: 验证 .so 文件**

```bash
ls -la /root/natrl-remote/irext-core/build/libirdecode.so
file /root/natrl-remote/irext-core/build/libirdecode.so
```
Expected: ELF 64-bit LSB shared object, x86-64

- [ ] **Step 5: 快速 smoke test — 用 test 程序验证**

```bash
# 用 irdecode_test binary 测试一个 .bin 文件
./irdecode_test
# 或直接跑测试: echo "test" | ./irdecode_test
```

- [ ] **Step 6: Commit**

```bash
git add irext-core/build/libirdecode.so irext-core/decoder/CMakeLists.txt
git commit -m "feat: compile irext-core decoder as Linux shared library"
```

---

### Task 2: 写 Python ctypes 绑定

**Files:**
- Create: `backend/irext-encode/__init__.py`
- Create: `backend/irext-encode/irext_binding.py`

**Interfaces:**
- Consumes: `libirdecode.so` (from Task 1)
- Produces: `irext_binding.open_binary(binary_data, category, sub_category) -> bool`, `irext_binding.decode(key_code, ac_status_dict) -> list[int]`, `irext_binding.close()`, `irext_binding.get_temp_range(ac_mode) -> (min, max)`, `irext_binding.get_supported_mode() -> int`

- [ ] **Step 1: 写 ctypes 包装**

`backend/irext-encode/irext_binding.py`:

```python
"""ctypes binding to irext-core decoder (libirdecode.so)"""
import ctypes
import os
from ctypes import c_uint8, c_uint16, c_int8, c_char_p, POINTER, byref

_SO_PATH = os.path.join(os.path.dirname(__file__),
                        "../../irext-core/build/libirdecode.so")
_lib = ctypes.CDLL(_SO_PATH)

# ── Type defs ──
UINT8 = c_uint8
INT8  = c_int8
UINT16 = c_uint16
INT16 = ctypes.c_int16

# ── AC Status struct ──
class ACStatus(ctypes.Structure):
    _fields_ = [
        ("ac_power",       UINT8),
        ("ac_temp",        UINT8),
        ("ac_mode",        UINT8),
        ("ac_wind_dir",    UINT8),
        ("ac_wind_speed",  UINT8),
        ("ac_display",     UINT8),
        ("ac_sleep",       UINT8),
        ("ac_timer",       UINT8),
        ("change_wind_direction", UINT8),
    ]

# ── Function signatures ──
_lib.ir_binary_open.argtypes = [UINT8, UINT8, ctypes.POINTER(UINT8), UINT16]
_lib.ir_binary_open.restype = INT8

_lib.ir_decode.argtypes = [UINT8, ctypes.POINTER(UINT16), ctypes.POINTER(ACStatus)]
_lib.ir_decode.restype = UINT16

_lib.ir_close.argtypes = []
_lib.ir_close.restype = INT8

_lib.get_temperature_range.argtypes = [UINT8, ctypes.POINTER(INT8), ctypes.POINTER(INT8)]
_lib.get_temperature_range.restype = INT8

_lib.get_supported_mode.argtypes = [ctypes.POINTER(UINT8)]
_lib.get_supported_mode.restype = INT8

_lib.get_supported_wind_speed.argtypes = [UINT8, ctypes.POINTER(UINT8)]
_lib.get_supported_wind_speed.restype = INT8

# ── Constants ──
CATEGORY_AC = 1
CATEGORY_TV = 2
SUB_CATEGORY_QUATERNARY = 1  # TV/STB (command-based)
SUB_CATEGORY_HEXADECIMAL = 2  # AC (status-based)

AC_MODE_COOL = 0
AC_MODE_HEAT = 1
AC_MODE_AUTO = 2
AC_MODE_FAN  = 3
AC_MODE_DRY  = 4

AC_WS_AUTO   = 0
AC_WS_LOW    = 1
AC_WS_MEDIUM = 2
AC_WS_HIGH   = 3

AC_POWER_ON  = 0
AC_POWER_OFF = 1

AC_TEMP_BASE = 16  # AC_TEMP_16 = 0, so temp = real_temp - 16

USER_DATA_SIZE = 2048
_user_data = (UINT16 * USER_DATA_SIZE)()

# ── Public API ──

def open_binary(binary_data: bytes, category: int, sub_category: int) -> bool:
    """Load .bin content into decoder. Must be called before decode()."""
    buf = (UINT8 * len(binary_data)).from_buffer_copy(binary_data)
    ret = _lib.ir_binary_open(UINT8(category), UINT8(sub_category), buf, UINT16(len(binary_data)))
    return ret == 0

def decode(key_code: int, ac_status: dict | None = None) -> list[int]:
    """
    Decode IR timing for a key (TV) or AC state.
    
    Args:
        key_code: irext key code (e.g., TV_POWER=0, AC_POWER=0)
        ac_status: dict with keys: power(int), temp(int), mode(int), 
                   wind_speed(int), wind_dir(int)
    Returns:
        list of ints: raw_timing in microseconds [mark, space, mark, ...]
    """
    status = ACStatus()
    status_ptr = None
    
    if ac_status is not None:
        status.ac_power      = UINT8(ac_status.get("power", AC_POWER_ON))
        # temp: real °C → irext enum (e.g., 26 → 10)
        temp_val = ac_status.get("temp", 26) - AC_TEMP_BASE
        status.ac_temp        = UINT8(max(0, min(14, temp_val)))
        status.ac_mode        = UINT8(ac_status.get("mode", AC_MODE_COOL))
        status.ac_wind_speed  = UINT8(ac_status.get("wind_speed", AC_WS_AUTO))
        status.ac_wind_dir    = UINT8(ac_status.get("wind_dir", 0))
        status_ptr = byref(status)
    
    # Reset buffer
    for i in range(USER_DATA_SIZE):
        _user_data[i] = 0
    
    count = _lib.ir_decode(UINT8(key_code), _user_data, status_ptr)
    
    if count == 0:
        return []
    
    return list(_user_data[:count])

def close():
    """Release decoder resources."""
    _lib.ir_close()

def get_temp_range(ac_mode: int) -> tuple[int, int]:
    """Get (min, max) temperature in °C for given AC mode."""
    tmin = INT8()
    tmax = INT8()
    ret = _lib.get_temperature_range(UINT8(ac_mode), byref(tmin), byref(tmax))
    if ret != 0:
        return (16, 30)
    return (int(tmin.value), int(tmax.value))

def get_supported_mode() -> int:
    """Get bitmask of supported AC modes."""
    modes = UINT8()
    ret = _lib.get_supported_mode(byref(modes))
    if ret != 0:
        return 0x1F
    return int(modes.value)
```

- [ ] **Step 2: 验证 .so 可以加载**

```bash
cd /root/natrl-remote
python3 -c "
import sys; sys.path.insert(0, 'backend')
from irext_encode.irext_binding import _lib
print('Library loaded:', _lib)
print('Version:', _lib.get_lib_version())
"
```

- [ ] **Step 3: Commit**

```bash
git add backend/irext-encode/
git commit -m "feat: add Python ctypes binding for irext-core decoder"
```

---

### Task 3: 写 .bin 文件加载器 + FastAPI 编码服务

**Files:**
- Create: `backend/irext-encode/bin_loader.py`
- Create: `backend/irext-encode/server.py`
- Create: `backend/irext-encode/requirements.txt`

**Interfaces:**
- Consumes: irext_binding.py (Task 2), /root/natrl-remote/irext-data/irext-binaries_20260519/
- Produces: HTTP service on :8002
  - `POST /encode` body: `{category, sub_category, binary_data_b64, key_code?, ac_status?}` → `{raw_timing: [int]}`
  - `POST /encode_by_md5` body: `{binary_md5, category, sub_category, key_code?, ac_status?}` → `{raw_timing: [int]}`  
  - `GET /health` → `{status: "ok", loaded_bins: N}`

- [ ] **Step 1: 写 .bin 加载器**

`backend/irext-encode/bin_loader.py`:

```python
"""Load all .bin files into memory at startup, indexed by MD5."""
import os
import hashlib
from pathlib import Path

_BIN_DIR = Path("/root/natrl-remote/irext-data/irext-binaries_20260519")
_binaries: dict[str, bytes] = {}  # MD5 → .bin content

def load_all():
    """Load all .bin files into memory. Returns count."""
    global _binaries
    _binaries.clear()
    for f in _BIN_DIR.glob("*.bin"):
        data = f.read_bytes()
        md5 = hashlib.md5(data).hexdigest()
        _binaries[md5] = data
    return len(_binaries)

def get_binary(md5: str) -> bytes | None:
    """Get .bin content by MD5 hash."""
    return _binaries.get(md5)

def get_binary_count() -> int:
    return len(_binaries)
```

- [ ] **Step 2: 写 FastAPI 服务**

`backend/irext-encode/server.py`:

```python
"""IRext Encode Service — FastAPI wrapper around irext-core decoder."""
import base64
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from irext_binding import (
    open_binary, decode, close, CATEGORY_AC, CATEGORY_TV,
    SUB_CATEGORY_QUATERNARY, SUB_CATEGORY_HEXADECIMAL,
    AC_MODE_COOL, AC_MODE_HEAT, AC_MODE_AUTO, AC_MODE_FAN, AC_MODE_DRY,
    AC_WS_AUTO, AC_WS_LOW, AC_WS_MEDIUM, AC_WS_HIGH,
    AC_POWER_ON, AC_POWER_OFF,
)
from bin_loader import load_all, get_binary, get_binary_count

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("irext-encode")

@asynccontextmanager
async def lifespan(app: FastAPI):
    count = load_all()
    log.info(f"Loaded {count} .bin files into memory")
    yield

app = FastAPI(title="irext-encode", lifespan=lifespan)

# ── Mode maps (natrl → irext) ──
MODE_MAP = {"cool": AC_MODE_COOL, "heat": AC_MODE_HEAT,
            "auto": AC_MODE_AUTO, "fan_only": AC_MODE_FAN, "dry": AC_MODE_DRY}
FAN_MAP  = {"auto": AC_WS_AUTO, "low": AC_WS_LOW,
            "medium": AC_WS_MEDIUM, "high": AC_WS_HIGH}

class EncodeACRequest(BaseModel):
    binary_md5: str
    temperature: int = 26
    mode: str = "cool"          # cool/heat/auto/fan_only/dry
    fan_speed: str = "auto"     # auto/low/medium/high
    power: bool = True

class EncodeKeyRequest(BaseModel):
    binary_md5: str
    category: int               # 1=AC, 2=TV, etc.
    key_code: int               # irext key code

class EncodeResponse(BaseModel):
    raw_timing: list[int]
    carrier_freq: int = 38000

@app.post("/encode_ac", response_model=EncodeResponse)
def encode_ac(req: EncodeACRequest):
    """Encode AC state → raw_timing using irext .bin protocol."""
    bin_data = get_binary(req.binary_md5)
    if not bin_data:
        raise HTTPException(404, f"Binary not found: {req.binary_md5}")

    if not open_binary(bin_data, CATEGORY_AC, SUB_CATEGORY_HEXADECIMAL):
        raise HTTPException(500, "Failed to open binary")

    try:
        ac_status = {
            "power": AC_POWER_ON if req.power else AC_POWER_OFF,
            "temp": req.temperature,
            "mode": MODE_MAP.get(req.mode, AC_MODE_COOL),
            "wind_speed": FAN_MAP.get(req.fan_speed, AC_WS_AUTO),
            "wind_dir": 0,
        }
        timing = decode(0, ac_status)  # key_code=0 = AC_POWER
    finally:
        close()

    if not timing:
        raise HTTPException(500, "Decode returned empty timing")
    
    log.info(f"AC encode: md5={req.binary_md5[:8]} t={req.temperature} {req.mode} {req.fan_speed} → {len(timing)} pulses")
    return EncodeResponse(raw_timing=timing)

@app.post("/encode_key", response_model=EncodeResponse)
def encode_key(req: EncodeKeyRequest):
    """Encode a fixed key → raw_timing."""
    bin_data = get_binary(req.binary_md5)
    if not bin_data:
        raise HTTPException(404, f"Binary not found: {req.binary_md5}")

    sub_cat = SUB_CATEGORY_HEXADECIMAL if req.category == 1 else SUB_CATEGORY_QUATERNARY
    if not open_binary(bin_data, req.category, sub_cat):
        raise HTTPException(500, "Failed to open binary")

    try:
        timing = decode(req.key_code, None)
    finally:
        close()

    if not timing:
        raise HTTPException(500, "Decode returned empty timing")

    log.info(f"Key encode: md5={req.binary_md5[:8]} cat={req.category} key={req.key_code} → {len(timing)} pulses")
    return EncodeResponse(raw_timing=timing)

@app.get("/health")
def health():
    return {"status": "ok", "loaded_bins": get_binary_count()}

@app.get("/bin/{md5}")
def check_bin(md5: str):
    """Check if a .bin is loaded."""
    data = get_binary(md5)
    return {"found": data is not None, "size": len(data) if data else 0}
```

- [ ] **Step 3: 写 requirements.txt**

`backend/irext-encode/requirements.txt`:
```
fastapi>=0.100.0
uvicorn>=0.23.0
pydantic>=2.0.0
```

- [ ] **Step 4: 安装依赖并启动服务测试**

```bash
cd /root/natrl-remote/backend/irext-encode
pip3 install -r requirements.txt -q
# 后台启动
nohup uvicorn server:app --host 0.0.0.0 --port 8002 > /root/natrl-remote/logs/irext-encode.log 2>&1 &
sleep 2
curl -s http://localhost:8002/health
```

- [ ] **Step 5: 用真实 .bin 测试编码**

```bash
# 先获取一个 AC .bin 的 MD5
MD5=$(mysql -u root irext -N -e "
  SELECT binary_md5 FROM remote_index 
  WHERE category_id=1 AND brand_id=(SELECT id FROM brand WHERE name_en='GREE') 
  LIMIT 1
")
echo "Testing with binary_md5=$MD5"

# 测试 AC 编码
curl -s -X POST http://localhost:8002/encode_ac \
  -H "Content-Type: application/json" \
  -d "{\"binary_md5\":\"$MD5\",\"temperature\":26,\"mode\":\"cool\",\"fan_speed\":\"auto\",\"power\":true}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'pulses={len(d[\"raw_timing\"])} first10={d[\"raw_timing\"][:10]}')"
```

Expected: `pulses>0 first10=[9000, 4500, ...]`

- [ ] **Step 6: Commit**

```bash
git add backend/irext-encode/
git commit -m "feat: add irext FastAPI encode service with .bin loader"
```

---

### Task 4: 改造 irext-engine.ts — MySQL 查询 + 调 irext-encode

**Files:**
- Modify: `backend/src/irext-engine.ts`

**Interfaces:**
- Consumes: irext-encode service (Task 3), MySQL irext DB
- Produces: `getACTiming()`, `getFixedKeyTiming()`, `getACProbeTiming()` — same signatures as before but now use irext-encode internally

- [ ] **Step 1: 添加 MySQL 查询 binary_md5 + 调 irext-encode 的函数**

替换 `backend/src/irext-engine.ts` 中的 `getACTiming` 和 `getFixedKeyTiming`:

```typescript
const IREXT_ENCODE_URL = process.env.IREXT_ENCODE_URL || "http://localhost:8002";

/** Resolve brand → binary_md5 via irext MySQL */
async function resolveBinaryMd5(
  brandNameEn: string,
  categoryId: number,
): Promise<string | null> {
  const p = getIrextPool();
  const [rows] = await p.query(
    `SELECT ri.binary_md5 FROM remote_index ri
     JOIN brand b ON ri.brand_id = b.id
     WHERE UPPER(b.name_en) = UPPER(?) AND ri.category_id = ?
     LIMIT 1`,
    [brandNameEn, categoryId],
  ) as any;
  if (rows.length === 0) return null;
  return rows[0].binary_md5;
}

/** Call irext-encode service for AC state encoding */
async function callEncodeAC(
  binaryMd5: string,
  temperature: number,
  mode: string,
  fanSpeed: string,
  powerOn: boolean,
): Promise<IRCommand> {
  const resp = await fetch(`${IREXT_ENCODE_URL}/encode_ac`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      binary_md5: binaryMd5,
      temperature,
      mode,
      fan_speed: fanSpeed,
      power: powerOn,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`irext-encode /encode_ac failed: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return {
    brand_code: "",
    protocol: "irext",
    carrier_freq: data.carrier_freq || 38000,
    raw_timing: data.raw_timing,
  };
}

/** Call irext-encode service for fixed key encoding */
async function callEncodeKey(
  binaryMd5: string,
  category: number,
  keyCode: number,
): Promise<IRCommand> {
  const resp = await fetch(`${IREXT_ENCODE_URL}/encode_key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ binary_md5: binaryMd5, category, key_code: keyCode }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`irext-encode /encode_key failed: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return {
    brand_code: "",
    protocol: "irext",
    carrier_freq: data.carrier_freq || 38000,
    raw_timing: data.raw_timing,
  };
}
```

- [ ] **Step 2: 重写 getACTiming**

```typescript
export async function getACTiming(
  brandCode: string,
  temperature: number,
  mode: string,
  fanSpeed: string,
  powerOn: boolean = true,
): Promise<IRCommand> {
  const brandNameEn = resolveBrandNameEn(brandCode);
  if (!brandNameEn) {
    console.warn(`[irext] Unknown brand: ${brandCode}, falling back to generic NEC`);
    const timing = buildGenericNEC(brandCode, temperature, mode, fanSpeed, powerOn);
    return { brand_code: brandCode, protocol: "NEC (fallback)", carrier_freq: 38000, raw_timing: timing };
  }

  const md5 = await resolveBinaryMd5(brandNameEn, 1); // category_id=1 = AC
  if (!md5) {
    console.warn(`[irext] No .bin for ${brandNameEn} AC, falling back`);
    const timing = buildGenericNEC(brandCode, temperature, mode, fanSpeed, powerOn);
    return { brand_code: brandCode, protocol: "NEC (fallback)", carrier_freq: 38000, raw_timing: timing };
  }

  try {
    const cmd = await callEncodeAC(md5, temperature, mode, fanSpeed, powerOn);
    cmd.brand_code = brandCode;
    return cmd;
  } catch (e: any) {
    console.error(`[irext] AC encode failed for ${brandCode}: ${e.message}`);
    const timing = buildGenericNEC(brandCode, temperature, mode, fanSpeed, powerOn);
    return { brand_code: brandCode, protocol: "NEC (fallback)", carrier_freq: 38000, raw_timing: timing };
  }
}
```

- [ ] **Step 3: 重写 getFixedKeyTiming**

```typescript
/** Map natrl command name → irext TV key code */
const TV_KEY_MAP: Record<string, number> = {
  power: 0, mute: 1, up: 2, down: 3, left: 4, right: 5,
  ok: 6, vol_up: 7, vol_down: 8, back: 9, input: 10,
  menu: 11, home: 12, settings: 13,
};

export async function getFixedKeyTiming(
  brandCode: string,
  deviceType: string,
  command: string,
): Promise<IRCommand | null> {
  const brandNameEn = resolveBrandNameEn(brandCode);
  if (!brandNameEn) return null;

  const cat = CATEGORY_TO_IR[deviceType];
  if (!cat) return null;

  const md5 = await resolveBinaryMd5(brandNameEn, cat.id);
  if (!md5) {
    console.log(`[irext] No .bin for ${brandNameEn}/${cat.name}`);
    return null;
  }

  const keyCode = TV_KEY_MAP[command] ?? 0;

  try {
    const cmd = await callEncodeKey(md5, cat.id, keyCode);
    cmd.brand_code = brandCode;
    return cmd;
  } catch (e: any) {
    console.error(`[irext] Key encode failed: ${e.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/irext-engine.ts
git commit -m "feat: rewrite irext-engine to use irext-encode service + MySQL binary_md5 lookup"
```

---

### Task 5: 替换 tools.ts 编码调用 + 废弃旧组件

**Files:**
- Modify: `backend/src/tools.ts` (移除 ir-engine-client import，确认调用 irext-engine 新函数)
- Delete: `backend/src/ir-engine-client.ts` (废弃)
- Delete: `backend/src/brand-db.ts` (废弃，迁移到 irext-engine)

**Interfaces:**
- tools.ts 中 execControlAc/Tv/probe 已调用 getACTiming/getFixedKeyTiming，这俩函数签名不变，只需确认 import 路径正确

- [ ] **Step 1: 确认 tools.ts import 正确**

查看 `backend/src/tools.ts` 第 43 行附近，确认:
```typescript
import { getACTiming, getFixedKeyTiming } from "./irext-engine";
```

- [ ] **Step 2: 移除旧的 ir-engine-client import**

如果 tools.ts 或其他文件仍有 `import { ... } from "./ir-engine-client"`，全部移除。

- [ ] **Step 3: 删除旧 ir-engine-client**

```bash
rm backend/src/ir-engine-client.ts
# brand-db.ts 保留，probe 流程仍需品牌匹配
```

- [ ] **Step 4: 更新 start.sh — 启动 irext-encode 服务**

在 `start.sh` 的 backend 启动前加入:

```bash
# 5. Start irext-encode
log "────────── irext-encode ──────────"
cd "$PROJECT_DIR/backend/irext-encode"
nohup uvicorn server:app --host 0.0.0.0 --port 8002 &>"$LOG_DIR/irext-encode.log" &
echo $! > "$PID_DIR/irext-encode.pid"
cd "$PROJECT_DIR"
```

- [ ] **Step 5: 重启后端并端到端测试**

```bash
bash /root/natrl-remote/start.sh restart

# 测试: AC 控制
curl -s -X POST http://localhost:3000/api/control \
  -H "Content-Type: application/json" \
  -d '{"input":"打开格力空调制冷26度","userId":"test-irext-final"}'
```

- [ ] **Step 6: Commit**

```bash
git rm backend/src/ir-engine-client.ts
git add backend/src/tools.ts start.sh
git commit -m "feat: switch to irext-encode, remove old ir-engine-client"
```

---

### Task 6: 清理废弃的 waveform-engine

**Files:**
- Remove: `waveform-engine/` 整个目录

- [ ] **Step 1: 停止旧 waveform-engine 进程**

```bash
fuser -k 8001/tcp 2>/dev/null || true
```

- [ ] **Step 2: 移除目录**

```bash
rm -rf /root/natrl-remote/waveform-engine
```

- [ ] **Step 3: 更新 start.sh 移除 waveform-engine 启动**

删除 start.sh 中任何启动 waveform-engine 的命令。

- [ ] **Step 4: Commit**

```bash
git rm -r waveform-engine
git add start.sh
git commit -m "chore: remove deprecated waveform-engine, replaced by irext-encode"
```

---

### Task 7: 配置环境变量 + 最终验证

- [ ] **Step 1: 确认 backend 环境变量**

```bash
# backend 需要:
export IREXT_ENCODE_URL=http://localhost:8002
# 这行加到 start.sh 的 backend 启动命令中
```

- [ ] **Step 2: 全链路测试**

```bash
# 确认所有服务运行中
curl http://localhost:8002/health  # irext-encode: {status:"ok", loaded_bins:5125}
curl http://localhost:3000/health  # backend

# TV 控制测试 (创维/Skyworth)
curl -s -X POST http://localhost:3000/api/control \
  -H 'Content-Type: application/json' \
  -d '{"input":"打开电视","userId":"final-test"}'

# AC 控制测试 (格力)
curl -s -X POST http://localhost:3000/api/control \
  -H 'Content-Type: application/json' \
  -d '{"input":"格力制冷26度","userId":"final-test"}'
```

- [ ] **Step 3: 检查 tool_call 包含 raw_timing**

验证返回的 toolCall.args 包含 raw_timing 数组:
```bash
curl -s ... | python3 -c "import sys,json; d=json.load(sys.stdin); tc=d.get('toolCall'); print('raw_timing' in str(tc.get('args',{})) if tc else 'no toolCall')"
```

- [ ] **Step 4: Commit**

```bash
git add start.sh backend/src/config.ts
git commit -m "chore: configure IREXT_ENCODE_URL, final integration verification"
```
