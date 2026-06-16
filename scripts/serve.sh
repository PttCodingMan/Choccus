#!/usr/bin/env bash
# scripts/serve.sh — build the client (if needed) then start the production server.
#
# Usage:
#   bash scripts/serve.sh                 # use existing dist/ if present
#   bash scripts/serve.sh --rebuild       # force a fresh client build
#   CHOCCUS_PORT=9000 bash scripts/serve.sh
#
# The script must be run from the repository root (or any subdirectory of it).

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REBUILD=false
for arg in "$@"; do
  [[ "$arg" == "--rebuild" ]] && REBUILD=true
done

# ── 1. Build client if dist/ is missing or --rebuild requested ────────────────
DIST_DIR="$REPO_ROOT/client/dist"
if [[ "$REBUILD" == "true" || ! -d "$DIST_DIR" ]]; then
  echo "[serve.sh] Building client …"
  # Build from the repo root using npm workspaces.
  npm run build --workspace @choccus/client --prefix "$REPO_ROOT"
  echo "[serve.sh] Client build complete → $DIST_DIR"
else
  echo "[serve.sh] Using existing build at $DIST_DIR (pass --rebuild to refresh)"
fi

# ── 2. Activate Python venv ───────────────────────────────────────────────────
VENV="$REPO_ROOT/server/.venv"
if [[ ! -f "$VENV/bin/activate" ]]; then
  echo "[serve.sh] ERROR: Python venv not found at $VENV"
  echo "           Run: python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt"
  exit 1
fi
# shellcheck disable=SC1090
source "$VENV/bin/activate"

# ── 3. Start production server ────────────────────────────────────────────────
echo "[serve.sh] Starting production server …"
python "$REPO_ROOT/server/serve.py" \
  ${CHOCCUS_PORT:+--port "$CHOCCUS_PORT"} \
  ${CHOCCUS_STATIC_PORT:+--static-port "$CHOCCUS_STATIC_PORT"} \
  ${CHOCCUS_STATIC_DIR:+--static-dir "$CHOCCUS_STATIC_DIR"} \
  "$@"
