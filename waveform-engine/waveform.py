"""IR AC frame encoding. Handles NEC-style AC protocols."""


def encode_ac_frame(
    brand_code: str,
    temperature: int,
    mode: str,
    fan_speed: str,
    params: dict,
) -> list[int]:
    """
    Build raw timing array [mark_us, space_us, mark_us, ...] for an AC IR frame.
    Different brands place temp/mode/fan bits at different positions.
    """

    header_mark = params["header_mark"]
    header_space = params["header_space"]
    bit_mark = params["bit_mark"]
    one_space = params["one_space"]
    zero_space = params["zero_space"]
    temp_offset = params.get("temp_offset", 16)

    # Build 32-bit data word from [mode, temp, fan, checksum]
    mode_map = {"auto": 0, "cool": 1, "dry": 2, "fan_only": 3, "heat": 4}
    fan_map = {"auto": 0, "low": 1, "medium": 2, "high": 3}

    mode_bits = mode_map.get(mode, 1)
    temp_bits = temperature - temp_offset
    fan_bits = fan_map.get(fan_speed, 0)

    # Pack into 4 bytes (brand-specific layout — simplified for NEC)
    b0 = (mode_bits & 0x7) | ((fan_bits & 0x3) << 3) | ((temp_bits & 0x1) << 6)
    b1 = (temp_bits >> 1) & 0xF
    b2 = 0x00  # swing = off, power = on (implicit in frame)
    b3 = (b0 ^ b1 ^ b2) & 0xFF  # checksum

    data = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3

    # Encode to NEC timing
    timing = [header_mark, header_space]
    for i in range(31, -1, -1):
        timing.append(bit_mark)
        timing.append(one_space if (data >> i) & 1 else zero_space)
    timing.append(bit_mark)  # stop bit

    return timing


def estimate_tolerance(raw_timing: list[int]) -> float:
    """Compute timing tolerance as a fraction of the average mark length."""
    marks = raw_timing[0::2]
    if not marks:
        return 0.25
    marks = [m for m in marks if m > 0]
    avg = sum(marks) / len(marks) if marks else 560
    deviation = sum(abs(m - avg) for m in marks) / len(marks) if marks else 0
    return max(0.15, deviation / avg)
