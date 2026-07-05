"""Waveform Engine — FastAPI server.

POST /generate  — build IR timing array from (brand_code, temp, mode, fan)
POST /match     — match a raw IR capture to known protocol
POST /probe     — generate probe frames for all known protocols
GET  /health    — liveness check
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from code_db import get_all_protocols, get_protocol, store_captured_signal
from waveform import encode_ac_frame, estimate_tolerance

app = FastAPI(title="natrl-waveform-engine")


class GenerateRequest(BaseModel):
    brand_code: str
    temperature: int = 26
    mode: str = "cool"
    fan_speed: str = "auto"


class MatchRequest(BaseModel):
    raw_timing: list[int]
    device_id: str = ""


class ProbeRequest(BaseModel):
    temperature: int = 26
    mode: str = "cool"
    fan_speed: str = "auto"


@app.post("/generate")
def generate(req: GenerateRequest):
    protocol = get_protocol(req.brand_code)
    if not protocol:
        raise HTTPException(
            status_code=404, detail=f"Unknown brand_code: {req.brand_code}"
        )

    raw_timing = encode_ac_frame(
        req.brand_code,
        req.temperature,
        req.mode,
        req.fan_speed,
        protocol["encoding_params"],
    )

    return {
        "brand_code": req.brand_code,
        "protocol": protocol["protocol"],
        "carrier_freq": protocol["carrier_freq"],
        "raw_timing": raw_timing,
    }


@app.post("/match")
def match_signal(req: MatchRequest):
    """Match a raw IR capture against all known protocols by timing fingerprint."""
    if not req.raw_timing or len(req.raw_timing) < 10:
        return {"brand_code": None, "confidence": 0.0, "message": "signal too short"}

    protocols = get_all_protocols()
    capture_tol = estimate_tolerance(req.raw_timing)
    capture_header = req.raw_timing[0] if req.raw_timing else 0
    capture_bit_mark = min(req.raw_timing[0::2]) if len(req.raw_timing) > 2 else 0

    best_match = None
    best_score = 0.0

    for p in protocols:
        params = p["encoding_params"]
        score = 0.0

        # Header mark match (40% weight)
        hdr_diff = abs(capture_header - params.get("header_mark", 9000))
        header_score = max(0, 1.0 - hdr_diff / params.get("header_mark", 9000))
        score += header_score * 0.4

        # Bit mark match (30% weight)
        bit_diff = abs(capture_bit_mark - params.get("bit_mark", 560))
        bit_score = max(0, 1.0 - bit_diff / params.get("bit_mark", 560))
        score += bit_score * 0.3

        # Timing tolerance check (30% weight)
        tol_score = max(0, 1.0 - capture_tol)
        score += tol_score * 0.3

        if score > best_score:
            best_score = score
            best_match = p

    if best_match and best_score > 0.5:
        confidence = min(1.0, best_score)
        if req.device_id:
            store_captured_signal(
                req.device_id,
                req.raw_timing,
                best_match["brand_code"],
                confidence,
            )
        return {
            "brand_code": best_match["brand_code"],
            "confidence": confidence,
            "brand_name": best_match["brand_name"],
        }
    else:
        if req.device_id:
            store_captured_signal(req.device_id, req.raw_timing, None, best_score)
        return {"brand_code": None, "confidence": best_score, "message": "no match"}


@app.post("/probe")
def probe(req: ProbeRequest):
    """Generate probe frames for ALL known protocols (used by cloud probing flow)."""
    protocols = get_all_protocols()
    results = []
    for p in protocols:
        raw_timing = encode_ac_frame(
            p["brand_code"],
            req.temperature,
            req.mode,
            req.fan_speed,
            p["encoding_params"],
        )
        results.append(
            {
                "brand_code": p["brand_code"],
                "brand_name": p["brand_name"],
                "raw_timing": raw_timing,
                "carrier_freq": p["carrier_freq"],
            }
        )
    # Return in order (market share: top brands first)
    return {"probes": results}


@app.get("/health")
def health():
    return {"status": "ok"}
