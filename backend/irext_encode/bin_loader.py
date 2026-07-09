"""Load all .bin files into memory at startup, indexed by MD5."""
import os
import hashlib
from pathlib import Path

_BIN_DIR = Path(os.environ.get("IREXT_BIN_DIR", "/root/natrl-remote/irext-data/irext-binaries_20260519"))
_binaries: dict[str, bytes] = {}  # MD5 → .bin content

def load_all():
    """Load all .bin files into memory. Returns count."""
    global _binaries
    _binaries.clear()
    count = 0
    for f in _BIN_DIR.glob("*.bin"):
        try:
            data = f.read_bytes()
            md5 = hashlib.md5(data).hexdigest()
            _binaries[md5] = data
            count += 1
        except Exception as e:
            print(f"WARN: failed to load {f.name}: {e}")
    return count

def get_binary(md5: str) -> bytes | None:
    """Get .bin content by MD5 hash."""
    return _binaries.get(md5)

def get_binary_count() -> int:
    return len(_binaries)
