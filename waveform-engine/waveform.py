r"""IR AC frame encoding — brand-specific, ported from IRremoteESP8266.

Each brand has a dedicated encoder that mirrors the C++ source:
  https://github.com/crankyoldgit/IRremoteESP8266

Architecture:
  encode_ac_frame(brand_code, temperature, mode, fan_speed) -> raw_timing list

The raw_timing is a [mark_us, space_us, mark_us, ...] array suitable for IRsend.
"""

from typing import Optional

# ═══════════════════════════════════════════════════════════════
#  Generic NEC timing builder
# ═══════════════════════════════════════════════════════════════

def _nec_timing(
    state_bytes: list[int],
    hdr_mark: int,
    hdr_space: int,
    bit_mark: int,
    one_space: int,
    zero_space: int,
    gap: int,
    *,
    lsb_first: bool = True,   # NEC-based AC protocols are LSB-first
    footer_mark: bool = True,
) -> list[int]:
    """Build raw NEC timing from state bytes."""
    timing = [hdr_mark, hdr_space]
    for byte in state_bytes:
        b = byte
        for _ in range(8):
            timing.append(bit_mark)
            if lsb_first:
                timing.append(one_space if (b & 1) else zero_space)
                b >>= 1
            else:
                timing.append(one_space if (b & 0x80) else zero_space)
                b = (b << 1) & 0xFF
    if footer_mark:
        timing.append(bit_mark)
    if gap:
        timing.append(gap)
    return timing


# ═══════════════════════════════════════════════════════════════
#  Mode & Fan maps (common across many brands)
# ═══════════════════════════════════════════════════════════════

MODE_MAP = {"auto": 0, "cool": 1, "dry": 2, "fan_only": 3, "heat": 4}
FAN_MAP = {"auto": 0, "low": 1, "medium": 2, "high": 3}


# ═══════════════════════════════════════════════════════════════
#  Brand-specific encoders
# ═══════════════════════════════════════════════════════════════

def _encode_gree(temp: int, mode: str, fan: str) -> list[int]:
    """Gree — 8 bytes, Kelvinator block checksum.

    State layout (from GreeProtocol union):
      byte0: Mode(3) | Power(1) | Fan(2) | SwingAuto(1) | Sleep(1)
      byte1: Temp(4) | TimerHalfHr(1) | TimerTensHr(2) | TimerEnabled(1)
      byte2: TimerHours(4) | Turbo(1) | Light(1) | ModelA(1) | Xfan(1)
      byte3: :2 | TempExtraDegreeF(1) | UseFahrenheit(1) | unknown1(4=0b0101)
      byte4: SwingV(4) | SwingH(3) | :1
      byte5: DisplayTemp(2) | IFeel(1) | unknown2(3=0b100) | WiFi(1) | :1
      byte6: 0x00
      byte7: :2 | Econo(1) | :1 | Sum(4)
    """
    m = MODE_MAP.get(mode, 1)
    f = FAN_MAP.get(fan, 0)

    state = [0] * 8
    # byte 0: Mode(3) | Power=1 | Fan(2) | SwingAuto=0 | Sleep=0
    state[0] = (m & 0x7) | (1 << 3) | ((f & 0x3) << 4)
    # byte 1: Temp(4) (temp-16)
    state[1] = (temp - 16) & 0xF
    # byte 2: Light=1 → bit 5 = 0x20
    state[2] = 0x20
    # byte 3: unknown1=0b0101 (high nibble = 0x50)
    state[3] = 0x50
    # byte 4: SwingV=0, SwingH=0
    state[4] = 0x00
    # byte 5: unknown2=0b100 bits 3-5 → 0x20
    state[5] = 0x20
    # byte 6: 0x00
    state[6] = 0x00
    # byte 7: checksum (4-bit Kelvinator) in high nibble
    state[7] = 0x00

    # Kelvinator block checksum: XOR all bytes, sum nibbles + 4, mod 16
    xor_sum = 0
    for i in range(7):
        xor_sum ^= state[i]
    ck = ((xor_sum >> 4) + (xor_sum & 0xF) + 4) & 0xF
    state[7] = ck << 4

    return _nec_timing(state,
                       hdr_mark=9000, hdr_space=4500,
                       bit_mark=620, one_space=1600, zero_space=540,
                       gap=19980)


def _encode_midea(temp: int, mode: str, fan: str) -> list[int]:
    """Midea — 6 bytes (48 bits), reversed-bit checksum.

    State layout (from MideaProtocol union, 48 bits):
      byte0 (Sum): checksum
      byte1: SensorTemp(7) | disableSensor(1) → 0xFF when disabled
      byte2: :1 | OffTimer(6) | BeepDisable(1) → 0xFF when disabled
      byte3: Temp(5) | useFahrenheit(1)
      byte4: Mode(3) | Fan(2) | :1 | Sleep(1) | Power(1)
      byte5: Type(3=001) | Header(5=10100) = 0x34

    Mode: auto=2, cool=0, dry=1, heat=3, fan=4
    """
    midea_mode = {"auto": 2, "cool": 0, "dry": 1, "fan_only": 4, "heat": 3}[mode]
    f = FAN_MAP.get(fan, 0)

    state = [0] * 6
    state[0] = 0  # checksum placeholder
    state[1] = 0xFF  # sensor temp disabled
    state[2] = 0xFF  # off timer disabled
    state[3] = (temp - 17) & 0x1F  # temp in 5 bits
    state[4] = ((midea_mode & 0x7) << 5) | ((f & 0x3) << 3) | 0x01  # mode+fan+power
    state[5] = 0x34  # Type=001, Header=10100

    # Midea checksum: reverse bits of bytes 1-5, sum, 256-sum, reverse
    total = 0
    for i in range(1, 6):
        total += _reverse_bits(state[i])
    ck = (256 - (total & 0xFF)) & 0xFF
    state[0] = _reverse_bits(ck)

    return _nec_timing(state,
                       hdr_mark=4480, hdr_space=4480,
                       bit_mark=560, one_space=1680, zero_space=560,
                       gap=8100, lsb_first=False)  # Midea uses MSB-first


def _reverse_bits(x: int) -> int:
    """Reverse 8 bits."""
    result = 0
    for _ in range(8):
        result = (result << 1) | (x & 1)
        x >>= 1
    return result


def _encode_haier(temp: int, mode: str, fan: str) -> list[int]:
    """Haier — 9 bytes (72 bits).

    Mode: see mapping below
    byte0: prefix/mode byte
    byte1: temp(4) | fan(2) in high bits
    bytes 2-7: various settings
    byte8: checksum (sum of bytes 0-7)
    """
    mode_prefix = {
        "auto": 0xA0, "cool": 0xA5, "dry": 0xA9,
        "fan_only": 0xAB, "heat": 0xA7,
    }[mode]
    f = FAN_MAP.get(fan, 0)

    state = [0] * 9
    state[0] = mode_prefix
    state[1] = ((temp - 16) & 0x0F) | ((f & 0x3) << 4)
    state[2] = 0x00
    state[3] = 0x00
    state[4] = 0x00
    state[5] = 0x00
    state[6] = 0x00
    state[7] = 0x00
    state[8] = sum(state[0:8]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=3000, hdr_space=4300,
                       bit_mark=520, one_space=1650, zero_space=650,
                       gap=150000)


def _encode_tcl(temp: int, mode: str, fan: str) -> list[int]:
    """TCL — 12 bytes (96 bits) TCL112.

    Mode: heat=1, dry=2, cool=3, fan=7, auto=8
    Fan: auto=0, low=1, med=2, high=3
    """
    tcl_mode = {"heat": 1, "dry": 2, "cool": 3, "fan_only": 7, "auto": 8}[mode]
    f = FAN_MAP.get(fan, 0)

    state = [0] * 12
    state[0] = 0x01
    state[1] = (temp - 16) & 0x1F
    state[2] = tcl_mode & 0x0F
    state[3] = f & 0x03
    state[4] = 0x00
    state[5] = 0x00
    state[6] = 0x00
    state[7] = 0x00
    state[8] = 0x00
    state[9] = 0x00
    state[10] = 0x00
    state[11] = sum(state[0:11]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=3000, hdr_space=1650,
                       bit_mark=500, one_space=1050, zero_space=325,
                       gap=20000)


def _encode_kelon(temp: int, mode: str, fan: str) -> list[int]:
    """Kelon — 8 bytes, similar to Gree.

    Mode: heat=0, auto=1, cool=2, dry=3, fan=4
    """
    kelon_mode = {"heat": 0, "auto": 1, "cool": 2, "dry": 3, "fan_only": 4}[mode]
    f = FAN_MAP.get(fan, 0)

    state = [0] * 8
    state[0] = 0x09
    state[1] = ((temp - 16) << 4) | (kelon_mode & 0x0F)
    state[2] = 0x50
    state[3] = 0x00
    state[4] = 0x00
    state[5] = (f & 0x3) << 6
    state[6] = 0x00
    # Kelvinator checksum
    xor_sum = 0
    for i in range(7):
        xor_sum ^= state[i]
    ck = ((xor_sum >> 4) + (xor_sum & 0xF) + 4) & 0xF
    state[7] = ck << 4

    return _nec_timing(state,
                       hdr_mark=9000, hdr_space=4600,
                       bit_mark=560, one_space=1680, zero_space=600,
                       gap=19950)


def _encode_panasonic(temp: int, mode: str, fan: str) -> list[int]:
    """Panasonic — 27 bytes (216 bits).

    Mode: auto=0, dry=2, cool=3, heat=4, fan=6
    Frequency: 36700 Hz
    """
    pana_mode = {"auto": 0, "dry": 2, "cool": 3, "heat": 4, "fan_only": 6}[mode]
    # Panasonic fan: min→0, low→1, med→2, high→3, max→4, auto→7 (then shift +3)
    if fan == "auto":
        fan_val = 7
    elif fan == "low":
        fan_val = 1 + 3  # = 4
    elif fan == "medium":
        fan_val = 2 + 3  # = 5
    else:
        fan_val = 3 + 3  # = 6

    state = [0] * 27
    state[0] = 0x02
    state[1] = 0x20
    state[2] = 0xE0
    state[3] = 0x04
    state[4] = 0x00
    state[5] = 0x00
    state[6] = ((pana_mode & 0x7) << 5) | ((temp - 16) & 0x1F)
    state[7] = (fan_val & 0x7) << 5
    state[8:14] = [0x00] * 6
    state[14] = 0x00
    state[15:20] = [0x00] * 5
    state[20] = 0x01  # power on
    state[21] = 0x00
    state[22] = sum(state[0:22]) & 0xFF
    state[23:27] = [0x00] * 4

    return _nec_timing(state,
                       hdr_mark=3456, hdr_space=1728,
                       bit_mark=432, one_space=1296, zero_space=432,
                       gap=10000)


def _encode_coolix(temp: int, mode: str, fan: str) -> list[int]:
    """Coolix — 24 bits, sent normal+inverted.

    Temp uses a lookup table (not linear):
      17→0,18→1,19→3,20→2,21→6,22→7,23→5,24→4,
      25→12,26→13,27→9,28→8,29→10,30→11

    Fan: auto=0b101, low=0b100, med=0b010, high=0b001
    Mode: auto=2, cool=0, dry=1, heat=3, fan=4
    """
    temp_map = [0x0, 0x1, 0x3, 0x2, 0x6, 0x7, 0x5, 0x4,
                0xC, 0xD, 0x9, 0x8, 0xA, 0xB]
    temp_code = temp_map[max(0, min(13, temp - 17))]

    coolix_mode = {"auto": 2, "cool": 0, "dry": 1, "heat": 3, "fan_only": 4}[mode]
    coolix_fan = {"auto": 5, "low": 4, "medium": 2, "high": 1}[fan]

    # Build 24-bit state
    byte0 = ((coolix_mode & 0x3) << 6) | (temp_code & 0xF)
    byte1 = (0x1F << 3) | (coolix_fan & 0x7)  # sensor=ignore
    byte2 = 0x0B  # fixed

    state24 = (byte0 << 16) | (byte1 << 8) | byte2

    # Coolix: header, 3 bytes normal + 3 inverted, footer
    timing = [4692, 4416]
    for shift in [16, 8, 0]:
        b = (state24 >> shift) & 0xFF
        for bit in range(7, -1, -1):
            timing.append(552)
            timing.append(1656 if (b >> bit) & 1 else 552)
    for shift in [16, 8, 0]:
        b = ((~state24) >> shift) & 0xFF
        for bit in range(7, -1, -1):
            timing.append(552)
            timing.append(1656 if (b >> bit) & 1 else 552)
    timing.append(552)
    timing.append(5244)

    return timing


def _encode_daikin(temp: int, mode: str, fan: str) -> list[int]:
    """Daikin — 35 bytes (280 bits), 3 sections.

    Mode: auto=0, cool=1, dry=2, heat=4, fan=6
    Fan: auto=0xA, low=3, med=5, high=7
    """
    daikin_mode = {"auto": 0, "cool": 1, "dry": 2, "heat": 4, "fan_only": 6}[mode]
    daikin_fan = {"auto": 0xA, "low": 3, "medium": 5, "high": 7}[fan]

    state = [0] * 35

    # Section 1
    state[0] = 0x11
    state[1] = 0xDA
    state[2] = 0x27
    state[3] = 0x00
    state[4] = 0x00
    state[5] = 0x41 | ((daikin_mode & 0x7) << 4)  # power=1 in bit 0 + mode
    state[6] = (temp - 10) & 0x3F
    state[7] = sum(state[0:7]) & 0xFF

    # Section 2
    state[8]  = 0x00
    state[9]  = 0x00
    state[10] = 0x00
    state[11] = (daikin_fan & 0xF) << 4
    state[12] = 0x00
    state[13] = 0x00
    state[14] = 0x00
    state[15] = sum(state[8:15]) & 0xFF

    # Section 3
    state[16] = 0xC0
    state[17:21] = [0x00, 0x00, 0x00, 0x00]
    state[21] = 0x08
    state[22:34] = [0x00] * 12
    state[34] = sum(state[16:34]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=3650, hdr_space=1623,
                       bit_mark=428, one_space=1280, zero_space=428,
                       gap=29500)


def _encode_mitsubishi(temp: int, mode: str, fan: str) -> list[int]:
    """Mitsubishi — 18 bytes (144 bits).

    Mode values: auto=0x20, cool=0x18, dry=0x10, heat=0x08, fan=0x38
    Fan: auto=0, low=2, med=3, high=4
    """
    mitsu_mode = {"auto": 0x20, "cool": 0x18, "dry": 0x10, "heat": 0x08, "fan_only": 0x38}[mode]
    mitsu_fan = {"auto": 0, "low": 2, "medium": 3, "high": 4}[fan]

    state = [0] * 18
    state[0]  = 0x23
    state[1]  = 0xCB
    state[2]  = 0x26
    state[3]  = 0x01
    state[4]  = 0x00
    state[5]  = 0x20  # power on, default vane
    state[6]  = (temp - 16) & 0x0F
    state[7]  = mitsu_mode
    state[8]  = mitsu_fan & 0x7
    state[9:17] = [0x00] * 8
    state[17] = sum(state[0:17]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=3400, hdr_space=1750,
                       bit_mark=450, one_space=1300, zero_space=420,
                       gap=17500)


def _encode_fujitsu(temp: int, mode: str, fan: str) -> list[int]:
    """Fujitsu — 16 bytes (128 bits).

    Mode: auto=0, cool=1, dry=2, fan=3, heat=4
    Fan: auto=0, low=3, med=2, high=1
    """
    fujitsu_mode = {"auto": 0, "cool": 1, "dry": 2, "fan_only": 3, "heat": 4}[mode]
    fujitsu_fan = {"auto": 0, "low": 3, "medium": 2, "high": 1}[fan]

    state = [0] * 16
    state[0]  = 0x14
    state[1]  = 0x63
    state[2]  = 0x00
    state[3]  = 0x10
    state[4]  = ((temp - 16) << 4) & 0xF0
    state[5]  = (fujitsu_mode & 0x7) << 4
    state[6]  = fujitsu_fan & 0x7
    state[7]  = 0x00
    state[8]  = 0x20  # power on
    state[9:15] = [0x00] * 6
    state[15] = sum(state[0:15]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=3324, hdr_space=1574,
                       bit_mark=448, one_space=1188, zero_space=420,
                       gap=10500)


def _encode_hitachi(temp: int, mode: str, fan: str) -> list[int]:
    """Hitachi — 28 bytes (224 bits).

    Mode: auto=2, cool=4, dry=5, fan=0, heat=3
    Fan: auto=1, low=2, med=3, high=5
    """
    hitachi_mode = {"auto": 2, "cool": 4, "dry": 5, "fan_only": 0, "heat": 3}[mode]
    hitachi_fan = {"auto": 1, "low": 2, "medium": 3, "high": 5}[fan]

    state = [0] * 28
    state[0]  = 0x01
    state[1]  = 0x10
    state[2]  = 0x00
    state[3]  = 0x40
    state[4]  = 0xBF
    state[5]  = 0xFF
    state[6]  = 0x00
    state[7]  = 0xCC
    state[8]  = 0x30 | ((temp - 16) & 0x0F)
    state[9]  = (hitachi_mode & 0x7) << 4
    state[10] = hitachi_fan & 0x7
    state[11:27] = [0x00] * 16
    state[27] = sum(state[0:27]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=3300, hdr_space=1700,
                       bit_mark=400, one_space=1250, zero_space=500,
                       gap=44500)


def _encode_samsung(temp: int, mode: str, fan: str) -> list[int]:
    """Samsung — 14 bytes (112 bits), 2 sections.

    Mode: auto=0, cool=1, dry=2, fan=3, heat=4
    Fan: auto=0, low=2, med=4, high=5
    """
    samsung_mode = {"auto": 0, "cool": 1, "dry": 2, "fan_only": 3, "heat": 4}[mode]
    samsung_fan = {"auto": 0, "low": 2, "medium": 4, "high": 5}[fan]

    state = [0] * 14

    # Section 1
    state[0] = 0x02
    state[1] = 0x00
    state[2] = 0x00
    state[3] = 0x00
    state[4] = 0x00
    state[5] = 0x00
    state[6] = 0x10  # power on

    s1_sum = sum(state[0:7]) & 0xFF
    state[2] = (state[2] & 0xF0) | ((s1_sum >> 4) & 0x0F)
    state[1] = (state[1] & 0xF0) | (s1_sum & 0x0F)

    # Section 2
    state[7]  = 0x02
    state[8]  = 0x00
    state[9]  = 0x00
    state[10] = 0x00
    state[11] = ((temp - 16) & 0x0F) << 4
    state[12] = ((samsung_fan & 0x7) << 4) | ((samsung_mode & 0x7) << 1)
    state[13] = 0x10  # power on

    s2_sum = sum(state[7:14]) & 0xFF
    state[9]  = (state[9] & 0xF0) | ((s2_sum >> 4) & 0x0F)
    state[8]  = (state[8] & 0xF0) | (s2_sum & 0x0F)

    return _nec_timing(state,
                       hdr_mark=4500, hdr_space=4500,
                       bit_mark=590, one_space=1690, zero_space=590,
                       gap=45000)


def _encode_carrier(temp: int, mode: str, fan: str) -> list[int]:
    """Carrier — 8 bytes (64 bits).

    Mode: cool=0, heat=1, fan=2 (dry/auto → cool)
    """
    carrier_mode = {"cool": 0, "heat": 1, "fan_only": 2, "dry": 0, "auto": 0}[mode]
    f = FAN_MAP.get(fan, 0)

    state = [0] * 8
    state[0] = 0x09
    state[1] = (temp - 16) & 0x0F
    state[2] = (carrier_mode & 0x7) | ((f & 0x3) << 3)
    state[3:7] = [0x00] * 4
    ck = sum(state[0:7]) & 0xF
    state[7] = ck << 4

    return _nec_timing(state,
                       hdr_mark=4500, hdr_space=4500,
                       bit_mark=570, one_space=1670, zero_space=570,
                       gap=20000)


def _encode_lg(temp: int, mode: str, fan: str) -> list[int]:
    """LG — 28 bits.

    32-bit layout:
      bits 0-3:   Sum(4)
      bits 4-7:   Fan(4)
      bits 8-11:  Temp(4)
      bits 12-14: Mode(3)
      bits 15-17: :3
      bits 18-19: Power(2) = 0b00 (on)
      bits 20-27: Sign(8) = 0x88

    Mode: cool=0, dry=1, fan=2, auto=3, heat=4
    Fan: auto=5, low=1, med=2, high=10
    """
    lg_mode = {"cool": 0, "dry": 1, "fan_only": 2, "auto": 3, "heat": 4}[mode]
    lg_fan  = {"auto": 5, "low": 1, "medium": 2, "high": 10}[fan]

    state32 = (0x88 << 20) | ((lg_mode & 0x7) << 12) | \
              (((temp - 15) & 0xF) << 8) | ((lg_fan & 0xF) << 4)

    # Checksum: sum of upper 7 nibbles
    nib_sum = 0
    val = state32 >> 4
    for _ in range(7):
        nib_sum += val & 0xF
        val >>= 4
    state32 |= nib_sum & 0xF

    # 28 bits as NEC
    timing = [8500, 4250]
    for byte_pos in range(4):
        b = (state32 >> (24 - byte_pos * 8)) & 0xFF
        bits = 4 if byte_pos == 0 else 8
        for bit_pos in range(bits - 1, -1, -1):
            timing.append(550)
            timing.append(1600 if (b >> bit_pos) & 1 else 550)
    timing.append(550)
    timing.append(50000)
    return timing


def _encode_toshiba(temp: int, mode: str, fan: str) -> list[int]:
    """Toshiba — 9 bytes (72 bits).

    Mode: auto=0, cool=1, dry=2, heat=3, fan=4
    Fan: auto=0, min=1, med=3, max=5
    Checksum: XOR of bytes 0-7
    """
    toshiba_mode = {"auto": 0, "cool": 1, "dry": 2, "heat": 3, "fan_only": 4}[mode]
    toshiba_fan  = {"auto": 0, "low": 1, "medium": 3, "high": 5}[fan]

    state = [0] * 9
    state[0] = 0xF2
    state[1] = 0x0D
    state[2] = 0x03
    state[3] = 0xFC
    state[4] = 0x01
    state[5] = 0x20 | ((temp - 17) & 0x1F)
    state[6] = (toshiba_fan & 0x7) << 3 | (toshiba_mode & 0x7)
    state[7] = 0x00

    ck = 0
    for i in range(8):
        ck ^= state[i]
    state[8] = ck

    return _nec_timing(state,
                       hdr_mark=4400, hdr_space=4300,
                       bit_mark=540, one_space=1620, zero_space=540,
                       gap=15000)


def _encode_electra(temp: int, mode: str, fan: str) -> list[int]:
    """Electra — 13 bytes (104 bits).

    Mode: auto=7, cool=1, dry=2, heat=3, fan=4
    Fan: auto=0, low=3, med=2, high=1 (reversed)
    """
    electra_mode = {"auto": 7, "cool": 1, "dry": 2, "heat": 3, "fan_only": 4}[mode]
    electra_fan  = {"auto": 0, "low": 3, "medium": 2, "high": 1}[fan]

    state = [0] * 13
    state[0]  = 0x09
    state[1]  = 0x10
    state[2]  = 0x00
    state[3]  = 0x20
    state[4]  = (temp - 16 + 8) & 0xFF
    state[5]  = electra_mode & 0x7
    state[6]  = electra_fan & 0x3
    state[7:12] = [0x00] * 5
    state[12] = sum(state[0:12]) & 0xFF

    return _nec_timing(state,
                       hdr_mark=9160, hdr_space=4510,
                       bit_mark=646, one_space=1645, zero_space=646,
                       gap=20000)


def _encode_whirlpool(temp: int, mode: str, fan: str) -> list[int]:
    """Whirlpool — 21 bytes, 3-section send with 2 checksums.

    State layout (from WhirlpoolProtocol union):
      byte 0: 0x83 (fixed)
      byte 1: 0x06 (fixed)
      byte 2: Fan(2 bits 0-1) | Power(1 bit 2) | Sleep(1 bit 3) | Swing1(1 bit 7)
      byte 3: Mode(3 bits 0-2) | Temp(4 bits 4-7)
      byte 4-5: 0
      byte 6: 0x80 (LightOff=1, from stateReset)
      byte 7-12: timer/clock, all 0
      byte 13: Sum1 = XOR(bytes 2-12)
      byte 14: 0
      byte 15: Cmd (0x06 = Mode command)
      byte 16-19: 0
      byte 20: Sum2 = XOR(bytes 14-19)

    Send: 3 sections with gaps
      Sec1: hdr(8950,4484) + bytes 0-5 + gap(7920)
      Sec2: bytes 6-13 + gap(7920)
      Sec3: bytes 14-20

    Mode: heat=0, auto=1, cool=2, dry=3, fan=4
    Fan: auto=0, high=1, medium=2, low=3
    Temp: temp - 18 (minTemp=18 for DG11J13A model)
    """
    wp_mode = {"heat": 0, "auto": 1, "cool": 2, "dry": 3, "fan_only": 4}[mode]
    wp_fan  = {"auto": 0, "high": 1, "medium": 2, "low": 3}[fan]

    state = [0] * 21

    # Fixed prefix
    state[0] = 0x83
    state[1] = 0x06

    # Byte 2: Fan(bits 0-1) | Power=0(no toggle) | Sleep=0 | Swing1=0
    # Power is a TOGGLE in Whirlpool — do NOT set it unless explicitly toggling power.
    state[2] = (wp_fan & 0x3)  # Power=0, no toggle

    # Byte 3: Mode(bits 0-2) | :1(bit 3) | Temp(bits 4-7)
    state[3] = (wp_mode & 0x7) | (((temp - 18) & 0xF) << 4)

    # Bytes 4-5: 0
    state[4] = 0x00
    state[5] = 0x00

    # Byte 6: LightOff=1 → bit 5 = 1 → 0x20
    # Wait, from stateReset: _.raw[6] = 0x80
    # In struct: ClockHours(5 bits 0-4) | LightOff(1 bit 5) | :2
    # 0x80 = 0b10000000 → bit 7 set. Hmm, this doesn't match LightOff=1 in bit 5.
    # Actually looking at the struct:
    #   uint8_t ClockHours  :5;  // bits 0-4
    #   uint8_t LightOff    :1;  // bit 5
    #   uint8_t             :2;  // bits 6-7
    # 0x80 = 0b10000000 would be bits 7=1, 6-0=0, which means :2=0b10, LightOff=0.
    # That seems wrong for "LightOff=1"...
    # Let me re-read stateReset: it sets _.raw[6] = 0x80
    # Then setLight(false) would set LightOff=!false=true, setting bit 5.
    # But stateReset sets raw[6]=0x80 which doesn't set bit 5.
    # Actually wait: maybe 0x80 is a default where ClockHours has some non-zero bits?
    # 0x80 = bit 7 = 1. This is in the :2 field.
    # Let me just follow stateReset exactly: byte 6 = 0x80
    state[6] = 0x80

    # Bytes 7-12: 0 (no timers, no clock)
    for i in range(7, 13):
        state[i] = 0x00

    # Byte 13: Sum1 = XOR(bytes 2-12)
    sum1 = 0
    for i in range(2, 13):
        sum1 ^= state[i]
    state[13] = sum1

    # Byte 14: 0
    state[14] = 0x00

    # Byte 15: Cmd = 0x02 (Temp command — changes temperature, most visible change)
    # Whirlpool is command-based: each Cmd triggers ONE action.
    # 0x02=Temp change is the most noticeable — AC display shows new temp.
    state[15] = 0x02

    # Bytes 16-19: 0
    for i in range(16, 20):
        state[i] = 0x00

    # Byte 20: Sum2 = XOR(bytes 14-19)
    sum2 = 0
    for i in range(14, 20):
        sum2 ^= state[i]
    state[20] = sum2

    # === 3-Section Send (real-world timing from test capture) ===
    # IRremoteESP8266 constants are idealized; real remotes use slightly different values.
    # Phone ConsumerIrManager may need exact real-world timing.
    _hdr_m  = 9092; _hdr_s  = 4556
    _bit_m  = 610;  _one_s  = 1670; _zero_s = 525
    _gap    = 8030

    def _encode_bytes(data, start, length):
        timing = []
        for i in range(start, start + length):
            b = data[i]
            for _ in range(8):  # LSB first
                timing.append(_bit_m)
                timing.append(_one_s if (b & 1) else _zero_s)
                b >>= 1
        timing.append(_bit_m)
        return timing

    timing = []
    # Section 1: header + bytes 0-5 + gap
    timing.extend([_hdr_m, _hdr_s])
    timing.extend(_encode_bytes(state, 0, 6))
    timing.append(_gap)
    # Section 2: bytes 6-13 + gap
    timing.extend(_encode_bytes(state, 6, 8))
    timing.append(_gap)
    # Section 3: bytes 14-20 + trailing gap
    timing.extend(_encode_bytes(state, 14, 7))
    timing.append(_gap)

    # Repeat once more
    timing.extend([_hdr_m, _hdr_s])
    timing.extend(_encode_bytes(state, 0, 6))
    timing.append(_gap)
    timing.extend(_encode_bytes(state, 6, 8))
    timing.append(_gap)
    timing.extend(_encode_bytes(state, 14, 7))

    return timing


# ═══════════════════════════════════════════════════════════════
#  Dispatch table
# ═══════════════════════════════════════════════════════════════


def _encode_test_nec(temp: int, mode: str, fan: str) -> list[int]:
    """Simple NEC test signal — 32 bits, standard timing."""
    # NEC: addr=0x00, ~addr=0xFF, cmd=0x12, ~cmd=0xED
    state = [0x00, 0xFF, 0x12, 0xED]
    return _nec_timing(state,
                       hdr_mark=9000, hdr_space=4500,
                       bit_mark=560, one_space=1690, zero_space=560,
                       gap=40000)

ENCODERS = {
    "test_nec": _encode_test_nec,
    "gree":        _encode_gree,
    "midea":       _encode_midea,
    "haier":       _encode_haier,
    "tcl":         _encode_tcl,
    "kelon":       _encode_kelon,
    "panasonic":   _encode_panasonic,
    "coolix":      _encode_coolix,
    "daikin":      _encode_daikin,
    "mitsubishi":  _encode_mitsubishi,
    "fujitsu":     _encode_fujitsu,
    "hitachi":     _encode_hitachi,
    "samsung":     _encode_samsung,
    "carrier":     _encode_carrier,
    "lg":          _encode_lg,
    "toshiba":     _encode_toshiba,
    "electra":     _encode_electra,
    "whirlpool":   _encode_whirlpool,
}

# Legacy aliases
ENCODERS["gree_nec_v1"]      = _encode_gree
ENCODERS["midea_nec_v1"]     = _encode_midea
ENCODERS["haier_nec_v1"]     = _encode_haier
ENCODERS["aux_nec_v1"]       = _encode_gree
ENCODERS["daikin_nec_v1"]    = _encode_daikin
ENCODERS["panasonic_nec_v1"] = _encode_panasonic

CARRIER_FREQ = {"panasonic": 36700, "whirlpool": 38400}
DEFAULT_CARRIER = 38000


# ═══════════════════════════════════════════════════════════════
#  Public API
# ═══════════════════════════════════════════════════════════════

def encode_ac_frame(
    brand_code: str,
    temperature: int,
    mode: str,
    fan_speed: str,
    params: Optional[dict] = None,
) -> list[int]:
    """Build raw timing array for an AC IR frame.

    Uses brand-specific encoders ported from IRremoteESP8266.
    """
    encoder = ENCODERS.get(brand_code)
    if encoder is None:
        # Fallback: generic NEC encoder
        return _encode_generic(temperature, mode, fan_speed,
                              params or {"header_mark": 9000, "header_space": 4500,
                                         "bit_mark": 560, "one_space": 1690,
                                         "zero_space": 560, "temp_offset": 16})
    return encoder(temperature, mode, fan_speed)


def get_carrier_freq(brand_code: str) -> int:
    """Get the IR carrier frequency for a brand."""
    return CARRIER_FREQ.get(brand_code, DEFAULT_CARRIER)


def _encode_generic(temp: int, mode: str, fan: str, params: dict) -> list[int]:
    """Generic NEC encoder (fallback for unknown brands)."""
    header_mark  = params["header_mark"]
    header_space = params["header_space"]
    bit_mark     = params["bit_mark"]
    one_space    = params["one_space"]
    zero_space   = params["zero_space"]
    temp_offset  = params.get("temp_offset", 16)

    m = MODE_MAP.get(mode, 1)
    f = FAN_MAP.get(fan, 0)
    tb = temp - temp_offset

    b0 = (m & 0x7) | ((f & 0x3) << 3) | ((tb & 0x1) << 6)
    b1 = (tb >> 1) & 0xF
    b2 = 0x00
    b3 = (b0 ^ b1 ^ b2) & 0xFF

    return _nec_timing([b0, b1, b2, b3],
                       hdr_mark=header_mark, hdr_space=header_space,
                       bit_mark=bit_mark, one_space=one_space, zero_space=zero_space,
                       gap=20000)


def estimate_tolerance(raw_timing: list[int]) -> float:
    """Compute timing tolerance as a fraction of the average mark length."""
    marks = raw_timing[0::2]
    if not marks:
        return 0.25
    marks = [m for m in marks if m > 0]
    avg = sum(marks) / len(marks) if marks else 560
    deviation = sum(abs(m - avg) for m in marks) / len(marks) if marks else 0
    return max(0.15, deviation / avg)
