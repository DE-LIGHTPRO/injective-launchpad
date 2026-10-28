#!/usr/bin/env bash
# Confirm a deployed factory is really there and configured as intended.
#
#   ./script/verify-deployment.sh 0xFACTORY
#
# Reads the chain rather than the broadcast log: a broadcast file records what was
# sent, not what landed.
set -euo pipefail
F="${1:?usage: verify-deployment.sh <factory address>}"
RPC="${RPC:-https://sentry.evm-rpc.injective.network}"

code=$(cast code "$F" --rpc-url "$RPC")
if [ "$code" = "0x" ]; then
  echo "  no contract code at $F"
  exit 1
fi
echo "  factory      $F  (${#code} hex chars of code)"
echo "  chain id     $(cast chain-id --rpc-url "$RPC")"
echo "  admin        $(cast call "$F" 'admin()(address)' --rpc-url "$RPC")"
echo "  platform     $(cast call "$F" 'platform()(address)' --rpc-url "$RPC")"
echo "  launch fee   $(cast call "$F" 'launchFee()(uint256)' --rpc-url "$RPC") wei"
echo "  launches     $(cast call "$F" 'launchCount()(uint256)' --rpc-url "$RPC")"
echo "  curve supply $(cast call "$F" 'CURVE_SUPPLY()(uint256)' --rpc-url "$RPC")"
echo "  lp reserve   $(cast call "$F" 'LP_RESERVE()(uint256)' --rpc-url "$RPC")"
