#!/bin/bash
set -euo pipefail

SERVER_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js 20.12 or newer is needed. Install Node.js, then reopen this file."
  exit 1
fi
if [ ! -d "$SERVER_DIR/node_modules/express" ]; then
  echo "Install the server dependencies first: cd PRANAV && npm ci"
  exit 1
fi

# Node parses .env itself. Never source a credentials file as shell code.
# Output only the port; secret values are never included in command arguments.
PORT_NUMBER="$(SKYSENTRY_ENV_FILE="$SERVER_DIR/.env" "$NODE_BIN" -e '
  if (typeof process.loadEnvFile !== "function") {
    console.error("Node.js 20.12 or newer is needed."); process.exit(1);
  }
  try { process.loadEnvFile(process.env.SKYSENTRY_ENV_FILE); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!process.env.CAMERA_API_KEY) {
    console.error("Add CAMERA_API_KEY to PRANAV/.env before starting. Use the same key as your iPhone.");
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8095);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT in PRANAV/.env must be a number from 1 to 65535."); process.exit(1);
  }
  console.log(port);
')"

LISTENERS="$(lsof -nP -tiTCP:"$PORT_NUMBER" -sTCP:LISTEN 2>/dev/null || true)"
for TASK_PID in $LISTENERS; do
  TASK_DETAILS="$(lsof -a -p "$TASK_PID" -d cwd -F cnu 2>/dev/null)"
  TASK_CWD="$(printf '%s\n' "$TASK_DETAILS" | sed -n 's/^n//p')"
  TASK_COMMAND="$(printf '%s\n' "$TASK_DETAILS" | sed -n 's/^c//p')"
  TASK_OWNER="$(printf '%s\n' "$TASK_DETAILS" | sed -n 's/^u//p')"
  if [ "$TASK_CWD" != "$SERVER_DIR" ] || [ "$TASK_COMMAND" != "node" ] || [ "$TASK_OWNER" != "$(id -u)" ]; then
    echo "Port $PORT_NUMBER belongs to another app. SkySentry did not stop it."
    exit 1
  fi
done

if [ "${1:-}" = "--check" ]; then
  echo "SkySentry startup is ready on port $PORT_NUMBER. No process was changed."
  exit 0
elif [ "$#" -gt 0 ]; then
  echo "Usage: restart-local.sh [--check]"
  exit 1
fi

for TASK_PID in $LISTENERS; do
  echo "Restarting the existing SkySentry server on port $PORT_NUMBER…"
  if ! kill -TERM "$TASK_PID"; then
    echo "This terminal could not stop the existing server. Stop it in its original terminal, then reopen Restart SkySentry.command."
    exit 1
  fi
done
for WAIT_STEP in {1..50}; do
  if ! lsof -nP -tiTCP:"$PORT_NUMBER" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if lsof -nP -tiTCP:"$PORT_NUMBER" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The previous server is still closing. Wait a moment, then reopen Restart SkySentry.command."
  exit 1
fi

cd "$SERVER_DIR"
export PORT="$PORT_NUMBER"
ENV_ARGS=()
if [ -f "$SERVER_DIR/.env" ]; then ENV_ARGS=("--env-file=$SERVER_DIR/.env"); fi
"$NODE_BIN" "${ENV_ARGS[@]}" server.js &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! "$NODE_BIN" -e '
  (async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.PORT}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === "ok") process.exit(0);
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.error("SkySentry did not become healthy. Read the error above.");
    process.exit(1);
  })();
'; then exit 1; fi

echo "SkySentry is ready: http://localhost:$PORT_NUMBER/tower.html"
echo "Keep this terminal open while using the iPhone. Press Control-C to stop."
if command -v open >/dev/null 2>&1; then
  open "http://localhost:$PORT_NUMBER/tower.html" || true
fi
wait "$SERVER_PID"
