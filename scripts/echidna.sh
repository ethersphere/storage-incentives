#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. Install Docker Desktop (or another docker runtime) to run Echidna." >&2
  exit 127
fi

cd "$ROOT_DIR"

IMAGE="ghcr.io/crytic/echidna:latest"
CONTRACT="EchidnaStakeRegistryHarness"

docker run --rm \
  -v "$ROOT_DIR":/src \
  -w /src \
  "$IMAGE" \
  echidna-test . \
  --contract "$CONTRACT" \
  --config echidna/echidna.yaml
