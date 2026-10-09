"""
Refuse a module carrying instructions Injective's VM cannot decode.

The chain reports this as `bulk memory support is not enabled (at offset 0x…)`, which
arrives after a simulate and names a byte offset rather than a build flag. Two attempts
were spent discovering it. This reads the same thing locally, for free.

Scans the CODE SECTION only. A naive scan of the whole file would match these byte pairs
inside data and string literals and refuse a module that is fine.
"""
import sys, pathlib

BULK = {0x08: "memory.init", 0x09: "data.drop", 0x0A: "memory.copy", 0x0B: "memory.fill"}

def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s
        if not x & 0x80:
            return r, i
        s += 7

def code_section(b):
    i = 8
    while i < len(b):
        sec = b[i]; i += 1
        size, i = leb(b, i)
        if sec == 10:
            return i, i + size
        i += size
    return None

def scan(path):
    b = pathlib.Path(path).read_bytes()
    span = code_section(b)
    if span is None:
        return ["no code section"]
    lo, hi = span
    found = []
    for i in range(lo, hi - 1):
        if b[i] == 0xFC and b[i + 1] in BULK:
            found.append((i, BULK[b[i + 1]]))
    return found

bad = False
for name in sys.argv[1:]:
    p = f"target/wasm32-unknown-unknown/release/{name}.wasm"
    hits = scan(p)
    if hits:
        bad = True
        print(f"  REFUSED {name}.wasm carries {len(hits)} post-MVP instruction(s)")
        for off, op in hits[:4]:
            print(f"          0x{off:x}  {op}")
        print(f"          Injective's VM cannot decode these. Build with the 1.81 toolchain;")
        print(f"          -C target-feature cannot reach them, they are in the precompiled std.")
    else:
        print(f"  OK      {name}.wasm carries no post-MVP instructions")
sys.exit(1 if bad else 0)
