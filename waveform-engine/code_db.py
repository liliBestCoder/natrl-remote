"""MySQL queries for IR code lookup — uses real codes from ir_codes table."""

import os
import json
import pymysql
import pymysql.cursors


def _parse_dsn(dsn: str):
    """Parse DATABASE_URL in format mysql+pymysql://user:pass@host:port/db"""
    rest = dsn.split("://", 1)[1] if "://" in dsn else dsn
    auth_host, _, db = rest.rpartition("/")
    user_pass, _, host_port = auth_host.rpartition("@")
    user, _, password = user_pass.partition(":")
    host, _, port_str = host_port.partition(":")
    port = int(port_str) if port_str else 3306
    return dict(host=host, port=port, user=user, password=password, database=db)


def get_conn():
    cfg = _parse_dsn(os.environ["DATABASE_URL"])
    return pymysql.connect(
        **cfg,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )


def _parse_raw_timing(row: dict | None, key: str = "raw_timing") -> None:
    """Convert JSON string to list in-place."""
    if row and isinstance(row.get(key), str):
        row[key] = json.loads(row[key])


def _parse_encoding_params(row: dict | None) -> None:
    if row and isinstance(row.get("encoding_params"), str):
        row["encoding_params"] = json.loads(row["encoding_params"])


def get_ir_code(brand_code: str, temperature: int, mode: str, fan_speed: str) -> dict | None:
    """Look up a pre-computed IR code from the database."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT brand_code, temperature, mode, fan_speed, carrier_freq, raw_timing
                   FROM ir_codes
                   WHERE brand_code = %s AND temperature = %s AND mode = %s AND fan_speed = %s
                   LIMIT 1""",
                (brand_code, temperature, mode, fan_speed),
            )
            row = cur.fetchone()
            _parse_raw_timing(row)
            return row
    finally:
        conn.close()


def get_all_protocols() -> list[dict]:
    """Return all known IR protocols with their encoding params."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT brand_code, brand_name, protocol, carrier_freq, encoding_params FROM ir_protocols"
            )
            rows = cur.fetchall()
            for row in rows:
                _parse_encoding_params(row)
            return rows
    finally:
        conn.close()


def get_protocol(brand_code: str) -> dict | None:
    """Get a single protocol's metadata."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT brand_code, brand_name, protocol, carrier_freq, encoding_params FROM ir_protocols WHERE brand_code = %s",
                (brand_code,),
            )
            row = cur.fetchone()
            _parse_encoding_params(row)
            return row
    finally:
        conn.close()


def get_brand_probe_codes(temperature: int = 26, mode: str = "cool", fan_speed: str = "auto") -> list[dict]:
    """Get one IR code per brand (for cloud probing). Returns one entry per brand."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT t1.brand_code, t1.temperature, t1.mode, t1.fan_speed, t1.carrier_freq, t1.raw_timing
                   FROM ir_codes t1
                   INNER JOIN (
                       SELECT brand_code, MIN(id) AS min_id
                       FROM ir_codes
                       WHERE temperature = %s AND mode = %s AND fan_speed = %s
                       GROUP BY brand_code
                   ) t2 ON t1.id = t2.min_id""",
                (temperature, mode, fan_speed),
            )
            rows = cur.fetchall()
            for row in rows:
                _parse_raw_timing(row)
            return rows
    finally:
        conn.close()


def store_captured_signal(
    device_id: str,
    raw_timing: list[int],
    matched_brand_code: str | None,
    confidence: float,
):
    """Store a captured IR signal for later analysis."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO captured_signals (device_id, raw_timing, matched_brand_code, match_confidence) VALUES (%s, %s, %s, %s)",
                (device_id, json.dumps(raw_timing), matched_brand_code, confidence),
            )
        conn.commit()
    finally:
        conn.close()
