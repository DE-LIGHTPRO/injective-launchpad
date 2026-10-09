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

export RUSTFLAGS="-C link-arg=-s"
for crate in curve factory; do
  echo "building $crate…"
  cargo build --release --target wasm32-unknown-unknown -p "$crate"
done

# A wasm that stores fine and fails at instantiate is the failure this catches: built
# with `library` on, it carries no entry points at all and nothing says so until a
# deployment is half done.
python3 scripts/check-wasm-exports.py curve factory
