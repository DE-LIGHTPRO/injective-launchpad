"""Parse a wasm module's export section. A string match is not an export."""
import sys, pathlib

def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s
        if not x & 0x80: return r, i
        s += 7

def exports(path):
    b = pathlib.Path(path).read_bytes()
    assert b[:4] == b"\0asm", "not a wasm module"
    i = 8
    out = []
    while i < len(b):
        sec = b[i]; i += 1
        size, i = leb(b, i)
        end = i + size
        if sec == 7:  # export section
            n, i = leb(b, i)
            for _ in range(n):
                ln, i = leb(b, i)
                name = b[i:i+ln].decode(); i += ln
                kind = b[i]; i += 1
                _, i = leb(b, i)
                if kind == 0:  # function
                    out.append(name)
        i = end
    return out

REQUIRED = {"instantiate", "execute", "query"}
bad = False
for name in sys.argv[1:]:
    p = f"target/wasm32-unknown-unknown/release/{name}.wasm"
    ex = set(exports(p))
    missing = REQUIRED - ex
    status = "OK  " if not missing else "BROKEN"
    print(f"  {status} {name}.wasm  exports: {sorted(e for e in ex if not e.startswith('_'))[:8]}")
    if missing:
        print(f"        missing entry points: {sorted(missing)}")
        bad = True
sys.exit(1 if bad else 0)
