#!/usr/bin/env bash
# cmux-tui launcher
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bun run "$SCRIPT_DIR/src/index.ts" "$@"
