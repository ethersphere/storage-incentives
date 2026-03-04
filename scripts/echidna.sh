#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. Install Docker Desktop (or another docker runtime) to run Echidna." >&2
  exit 127
fi

cd "$ROOT_DIR"

IMAGE="${ECHIDNA_IMAGE:-ghcr.io/crytic/echidna/echidna:latest}"
CONTRACT="${ECHIDNA_CONTRACT:-}"
CONFIG="${ECHIDNA_CONFIG:-echidna/echidna.yaml}"
ARGS="${ECHIDNA_ARGS:-}"

# Compile on the host. The Echidna container image doesn't ship with Node/npx,
# and without Hardhat artifacts CryticCompile will try (and fail) to run `npx hardhat compile`.
yarn -s hardhat compile --force >/dev/null

CONTRACTS_DEFAULT=(
  "EchidnaStakeRegistryHarness"
  "EchidnaPriceOracleHarness"
  "EchidnaPostageStampHarness"
  "EchidnaRedistributionHarness"
  "EchidnaRedistributionClaimHarness"
  "EchidnaSystemHarness"
)

if [[ -n "$CONTRACT" ]]; then
  CONTRACTS_TO_RUN=("$CONTRACT")
else
  CONTRACTS_TO_RUN=("${CONTRACTS_DEFAULT[@]}")
fi

for c in "${CONTRACTS_TO_RUN[@]}"; do
  echo "==> echidna: running contract $c" >&2

  # Avoid stale Crytic compile artifacts causing old properties/tests to run.
  rm -rf crytic-export

  docker run --rm \
    -v "$ROOT_DIR":/src \
    -w /src \
    "$IMAGE" \
    echidna-test . \
    --contract "$c" \
    --config "$CONFIG" \
    $ARGS
done
