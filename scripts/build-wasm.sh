#!/usr/bin/env bash
#
# Build the contracts to wasm, ONE CRATE PER INVOCATION.
#
# This is not a style preference and the combined form does not work:
#
#   cargo build --release --target wasm32-unknown-unknown -p curve -p factory
#
# `factory` depends on `curve` with `features = ["library"]`, which is the standard
# CosmWasm way of suppressing a dependency's `#[entry_point]` symbols. Cargo UNIFIES
# features across a single invocation, so asking for both crates at once builds `curve`
# once with `library` enabled for the factory's sake, and the factory then links a curve
# that still carries its own entry points:
#
#   rust-lld: error: duplicate symbol: query
#
# That is what the deploy script's own error message told people to run, and it is why
# `factory.wasm` on this machine was six days stale while `cargo test` stayed green:
# native tests never link entry points, so nothing in the suite can see this.
#
# Separate invocations give each crate its own feature resolution.
set -euo pipefail
cd "$(dirname "$0")/.."

# `target-cpu=mvp` is not an optimisation choice, it is what the chain accepts.
#
# Rust 1.82 and later emit post-MVP wasm by default: bulk memory (`memory.copy`,
# `memory.fill`), sign extension, reference types. Injective's wasmvm rejects the
# whole module:
#
#   Deserialization error: "bulk memory support is not enabled (at offset 0x3dba)"
#
# That arrives from the chain after a simulate, so it costs an attempt to discover,
# and the message points at a byte offset rather than at a build flag. This toolchain
# is 1.93, well past the change. `mvp` pins the instruction set back to what the VM
# can decode; the explicit `-bulk-memory,-sign-ext` is belt and braces, since
# `target-cpu` sets a baseline a future toolchain could widen again.
# A PINNED TOOLCHAIN, because the flags alone are not enough.
#
# `target-cpu=mvp` and `-bulk-memory` only affect crates compiled from source. `core`
# and `alloc` ship PRECOMPILED with bulk memory enabled from Rust 1.82 onward, so a
# 1.93 build still carries `memory.copy`, `memory.fill` and `memory.init` from the
# standard library, and Injective's VM refuses the module:
#
#   Deserialization error: "bulk memory support is not enabled (at offset 0x2fe10)"
#
# Measured: with the flags on 1.93 the count went from one offset to another and stayed
# at 10 instructions per module, all of them past 0x2f000, which is library territory.
# 1.81 is the last release whose precompiled std predates the change.
#
# The flags are kept as well. They cover this crate's own code and cost nothing.
TOOLCHAIN="${INJPAD_RUST:-1.81}"
if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
  echo "Rust ${TOOLCHAIN} is not installed. Run:"
  echo "  rustup toolchain install ${TOOLCHAIN} --profile minimal --target wasm32-unknown-unknown"
  exit 1
fi

export RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp -C target-feature=-bulk-memory,-sign-ext"
for crate in curve factory; do
  echo "building $crate with Rust ${TOOLCHAIN}…"
  cargo "+${TOOLCHAIN}" build --release --target wasm32-unknown-unknown -p "$crate"
done

# A wasm that stores fine and fails at instantiate is the failure this catches: built
# with `library` on, it carries no entry points at all and nothing says so until a
# deployment is half done.
python3 scripts/check-wasm-exports.py curve factory

# And that the module only uses instructions the chain can decode. This reads the
# code section and reports the same byte offsets the chain does: verified by matching
# 0x2fe10 for curve.wasm against what the node reported for the same build.
python3 scripts/check-wasm-features.py curve factory
