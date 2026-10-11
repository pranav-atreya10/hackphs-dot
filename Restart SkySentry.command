#!/bin/bash
set -euo pipefail

# Finder does not inherit the same PATH as an interactive terminal.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
TASK_ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
exec /bin/bash "$TASK_ROOT/PRANAV/scripts/restart-local.sh" "$@"
