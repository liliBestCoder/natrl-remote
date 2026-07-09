"""IRext Encode Service — FastAPI wrapper around irext-core decoder."""
import logging
import threading
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

# C library is NOT thread-safe — protect with mutex
_codec_lock = threading.Lock()

@asynccontextmanager
async def lifespan(app: FastAPI):
    count = load_all()
    log.info(f"Loaded {count} .bin files into memory")
    yield

app = FastAPI(title="irext-encode", lifespan=lifespan)

# ── Mode maps (natrl → irext enum) ──
MODE_MAP = {"cool": AC_MODE_COOL, "heat": AC_MODE_HEAT,
            "auto": AC_MODE_AUTO, "fan_only": AC_MODE_FAN, "dry": AC_MODE_DRY}
FAN_MAP  = {"auto": AC_WS_AUTO, "low": AC_WS_LOW,
            "medium": AC_WS_MEDIUM, "high": AC_WS_HIGH}

class EncodeACRequest(BaseModel):
    binary_md5: str
    temperature: int = 26
    mode: str = "cool"
    fan_speed: str = "auto"
    power: bool = True

class EncodeKeyRequest(BaseModel):
    binary_md5: str
    category: int
    key_code: int

class EncodeResponse(BaseModel):
    raw_timing: list[int]
    carrier_freq: int = 38000

@app.post("/encode_ac", response_model=EncodeResponse)
def encode_ac(req: EncodeACRequest):
    """Encode AC state → raw_timing using irext .bin protocol."""
    bin_data = get_binary(req.binary_md5)
    if not bin_data:
        raise HTTPException(404, f"Binary not found: {req.binary_md5[:16]}...")

    with _codec_lock:
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
            timing = decode(0, ac_status)
        finally:
            close()

    if not timing:
        raise HTTPException(500, "Decode returned empty timing")

    log.info(f"AC: md5={req.binary_md5[:8]} t={req.temperature} {req.mode} {req.fan_speed} → {len(timing)} pulses")
    return EncodeResponse(raw_timing=timing)

@app.post("/encode_key", response_model=EncodeResponse)
def encode_key(req: EncodeKeyRequest):
    """Encode a fixed key → raw_timing."""
    bin_data = get_binary(req.binary_md5)
    if not bin_data:
        raise HTTPException(404, f"Binary not found: {req.binary_md5[:16]}...")

    sub_cat = SUB_CATEGORY_HEXADECIMAL if req.category == 1 else SUB_CATEGORY_QUATERNARY
    with _codec_lock:
        if not open_binary(bin_data, req.category, sub_cat):
            raise HTTPException(500, "Failed to open binary")
        try:
            timing = decode(req.key_code, None)
        finally:
            close()

    if not timing:
        raise HTTPException(500, "Decode returned empty timing")

    log.info(f"Key: md5={req.binary_md5[:8]} cat={req.category} key={req.key_code} → {len(timing)} pulses")
    return EncodeResponse(raw_timing=timing)

@app.get("/health")
def health():
    return {"status": "ok", "loaded_bins": get_binary_count()}

@app.get("/bin/{md5}")
def check_bin(md5: str):
    data = get_binary(md5)
    return {"found": data is not None, "size": len(data) if data else 0}
