"""Postgres queries for IR protocol lookup and signal storage."""

import os

import psycopg2
import psycopg2.extras


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def get_all_protocols() -> list[dict]:
    """Return all known IR protocols with their encoding params."""
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        "SELECT brand_code, brand_name, protocol, carrier_freq, encoding_params FROM ir_protocols"
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


def get_protocol(brand_code: str) -> dict | None:
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        "SELECT brand_code, brand_name, protocol, carrier_freq, encoding_params FROM ir_protocols WHERE brand_code = %s",
        (brand_code,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    return row


def store_captured_signal(
    device_id: str,
    raw_timing: list[int],
    matched_brand_code: str | None,
    confidence: float,
):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO captured_signals (device_id, raw_timing, matched_brand_code, match_confidence) VALUES (%s, %s, %s, %s)",
        (device_id, raw_timing, matched_brand_code, confidence),
    )
    conn.commit()
    cur.close()
    conn.close()
