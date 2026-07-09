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
# WARNING: C enums are int (4 bytes), NOT uint8!
class ACStatus(ctypes.Structure):
    _fields_ = [
        ("ac_power",       ctypes.c_int),   # t_ac_power enum → int
        ("ac_temp",        ctypes.c_int),   # t_ac_temperature enum → int
        ("ac_mode",        ctypes.c_int),   # t_ac_mode enum → int
        ("ac_wind_dir",    ctypes.c_int),   # t_ac_swing enum → int
        ("ac_wind_speed",  ctypes.c_int),   # t_ac_wind_speed enum → int
        ("ac_display",     UINT8),
        ("ac_sleep",       UINT8),
        ("ac_timer",       UINT8),
        ("change_wind_direction", UINT8),
    ]

# ── Function signatures ──
_lib.get_lib_version.restype = c_char_p

_lib.ir_binary_open.argtypes = [UINT8, UINT8, POINTER(UINT8), UINT16]
_lib.ir_binary_open.restype = INT8

_lib.ir_decode.argtypes = [UINT8, POINTER(UINT16), POINTER(ACStatus)]
_lib.ir_decode.restype = UINT16

_lib.ir_close.argtypes = []
_lib.ir_close.restype = INT8

_lib.get_temperature_range.argtypes = [UINT8, POINTER(INT8), POINTER(INT8)]
_lib.get_temperature_range.restype = INT8

_lib.get_supported_mode.argtypes = [POINTER(UINT8)]
_lib.get_supported_mode.restype = INT8

_lib.get_supported_wind_speed.argtypes = [UINT8, POINTER(UINT8)]
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

AC_TEMP_BASE = 16

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
        key_code: irext key code (e.g., TV_POWER=0)
        ac_status: dict for AC with keys: power, temp, mode, wind_speed, wind_dir
    Returns:
        list of ints: raw_timing in microseconds [mark, space, mark, ...]
    """
    status = ACStatus()
    status_ptr = None

    if ac_status is not None:
        # Use c_int for enum fields
        status.ac_power      = ac_status.get("power", AC_POWER_ON)
        temp_val = ac_status.get("temp", 26) - AC_TEMP_BASE
        status.ac_temp        = max(0, min(14, temp_val))
        status.ac_mode        = ac_status.get("mode", AC_MODE_COOL)
        status.ac_wind_speed  = ac_status.get("wind_speed", AC_WS_AUTO)
        status.ac_wind_dir    = ac_status.get("wind_dir", 0)
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
    """Get (min, max) temperature in C for given AC mode."""
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
