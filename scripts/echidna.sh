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

# Compile on the host. The Echidna container image doesn't ship with Node/npx,
# and without Hardhat artifacts CryticCompile will try (and fail) to run `npx hardhat compile`.
yarn -s hardhat compile --force >/dev/null

# Auto-discover harness contracts from src/echidna/Echidna*Harness.sol.
CONTRACTS_DEFAULT=()
for f in src/echidna/Echidna*Harness.sol; do
  [[ -f "$f" ]] || continue
  name="$(basename "$f" .sol)"
  CONTRACTS_DEFAULT+=("$name")
done

if [[ -n "$CONTRACT" ]]; then
  CONTRACTS_TO_RUN=("$CONTRACT")
else
  CONTRACTS_TO_RUN=("${CONTRACTS_DEFAULT[@]}")
fi

# Optional CLI overrides (see `echidna-test --help`). Examples:
#   ECHIDNA_TEST_LIMIT=50000 ECHIDNA_SEQ_LEN=300 yarn echidna
#   ECHIDNA_WORKERS=8 ECHIDNA_CONTRACT=EchidnaSystemHarness yarn echidna
# Use a string (not an array) so `set -u` never trips on empty `${arr[*]}` on older Bash.
ECHIDNA_EXTRA_CLI=""
if [[ -n "${ECHIDNA_TEST_LIMIT:-}" ]]; then
  ECHIDNA_EXTRA_CLI+=" --test-limit ${ECHIDNA_TEST_LIMIT}"
fi
if [[ -n "${ECHIDNA_SEQ_LEN:-}" ]]; then
  ECHIDNA_EXTRA_CLI+=" --seq-len ${ECHIDNA_SEQ_LEN}"
fi
if [[ -n "${ECHIDNA_WORKERS:-}" ]]; then
  ECHIDNA_EXTRA_CLI+=" --workers ${ECHIDNA_WORKERS}"
fi

for c in "${CONTRACTS_TO_RUN[@]}"; do
  echo "==> echidna: running contract $c" >&2

  # One corpus + coverage tree per harness so saved sequences stay relevant to
  # that contract (shared corpus mixed unrelated call shapes and diluted learning).
  CORPUS_DIR="echidna/corpus/by-contract/${c}"
  mkdir -p "${ROOT_DIR}/${CORPUS_DIR}"

  # Drop stale Crytic output inside Docker (same uid as container root). A host
  # `rm -rf crytic-export` often fails after Docker created the dir as root.
  docker run --rm \
    --entrypoint sh \
    -v "$ROOT_DIR":/src \
    -w /src \
    "$IMAGE" \
    -c "rm -rf crytic-export && echidna-test . --contract ${c} --config ${CONFIG} \
      --corpus-dir ${CORPUS_DIR} --coverage-dir ${CORPUS_DIR}/coverage${ECHIDNA_EXTRA_CLI}"
done
