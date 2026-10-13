#!/usr/bin/env bash
# Drive dpi-tui in tmux against a live device and grep the screen.
#   tests/smoke.sh faux       boot a faux-provider dpi-backend (deterministic, no model costs)
#   tests/smoke.sh <device>   a device from ~/.dpi/network.sqlite with its real model (e.g. mac-mini)
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=${1:-faux}
S="dpi-smoke-$$"
TMP=$(mktemp -d /tmp/dpi-smoke.XXXXXX)
BACKEND_PID=""
cleanup() {
  tmux kill-session -t "$S" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { echo "PASS $*"; }
screen() { tmux capture-pane -t "$S" -p -J -S -400; }
wait_for() { # pattern [seconds]
  local end=$((SECONDS + ${2:-30}))
  while ((SECONDS < end)); do
    screen | grep -Eq -- "$1" && return 0
    sleep 0.3
  done
  echo "FAIL: timed out waiting for /$1/"
  screen | tail -40
  exit 1
}
send() { tmux send-keys -t "$S" -l -- "$1"; tmux send-keys -t "$S" Enter; }
tui() { # args...
  tmux kill-session -t "$S" 2>/dev/null || true
  tmux new-session -d -s "$S" -x 120 -y 40 "NODE_NO_WARNINGS=1 npx tsx src/main.ts $*; sleep 600"
}
reattach_ref() { screen | grep -Eo 'just tui attach [^ ].*' | tail -1 | sed 's/^just tui attach //'; }

if [ "$TARGET" = "faux" ]; then
  PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
  TOKEN=$(openssl rand -hex 24)
  mkdir -p "$TMP/home" "$TMP/work/project"
  (cd ../dpi-backend && exec env DPI_HOME="$TMP/home" DPI_ENV_FILE="$TMP/home/none.env" DPI_TOKEN="$TOKEN" DPI_PROVIDER=faux \
    DPI_START_DIRS="$TMP/work" DPI_DEVICE_NAME=faux-smoke node --import tsx src/main.ts --port "$PORT" --host 127.0.0.1 >"$TMP/backend.log" 2>&1) &
  BACKEND_PID=$!
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.1; done
  CONNECT="--url http://127.0.0.1:$PORT --token $TOKEN"
  tui "$CONNECT --new smoke --cwd $TMP/work/project"
  wait_for "● live" 20
  pass "connected to a faux device"

  send "hello smoke"
  wait_for "Echo: hello smoke"
  pass "a prompt streams an answer"

  send "!sleep 4; echo BASE"
  wait_for "working…" 10
  send "steer this"
  wait_for "↪ steer: steer this" 5
  wait_for "Echo: steer this" 20
  pass "a steer while busy shows in the queue, then lands after the tool round"

  send "!sleep 30"
  wait_for "working…" 10
  sleep 1
  tmux send-keys -t "$S" Escape
  wait_for "Interrupted" 10
  wait_for "aborted" 10
  pass "Esc aborts the running tool"

  send "/fork smoke-fork"
  wait_for "⑂ smoke-fork" 10
  pass "/fork switches to the new agent"

  tmux send-keys -t "$S" C-c
  wait_for "Reattach:" 10
  REF=$(reattach_ref | sed "s/<token>/$TOKEN/")
  case "$REF" in *"-s smoke -a smoke-fork"*) ;; *) echo "FAIL: reattach hint should use names, got: $REF"; exit 1 ;; esac
  pass "Ctrl+C exits with a reattach hint by name (-s smoke -a smoke-fork)"
  tui "$REF"
  wait_for "⑂ smoke-fork" 20
  wait_for "Echo: hello smoke" 10
  pass "reattaching shows the agent's history"
  echo "ALL TUI SMOKE CHECKS PASSED (faux)"
  exit 0
fi

# ------------------------------------------------------------------ real device, real model
NAME="smoke-$(date +%H%M%S)"
tui "$TARGET --new $NAME"
wait_for "● live" 30
pass "connected to $TARGET"

send "Reply with exactly: SMOKE OK"
wait_for "^ *SMOKE OK *$" 120
pass "a real-model answer on $TARGET"

# Streaming: the answer grows across screen captures while the agent works.
send "Count from 1 to 60, one number per line, nothing else."
wait_for "working…" 30
counts=()
for _ in $(seq 1 80); do
  n=$(screen | grep -Ec '^ *[0-9]+ *$' || true)
  counts+=("$n")
  screen | grep -q "working…" || break
  sleep 0.25
done
distinct=$(printf '%s\n' "${counts[@]}" | sort -un | wc -l | tr -d ' ')
[ "$distinct" -ge 3 ] || { echo "FAIL: no incremental streaming (${counts[*]})"; exit 1; }
pass "tokens stream into the transcript ($distinct distinct line counts while working)"

send "Run this bash command exactly once: sleep 15; echo TUI_REATTACH_OK. After it finishes reply with: reattached."
wait_for "sleep 15" 90
wait_for "working…" 10
tmux send-keys -t "$S" C-c
wait_for "Reattach:" 10
REF=$(reattach_ref)
case "$REF" in "$TARGET:$NAME:main") ;; *) echo "FAIL: reattach hint should be $TARGET:$NAME:main, got: $REF"; exit 1 ;; esac
pass "exited mid-tool; hint reattaches by name ($REF)"
sleep 20
tui "$REF"
wait_for "TUI_REATTACH_OK" 60
pass "reattaching shows the completed tool result"
SID=$(echo "$REF" | cut -d: -f2)
curl -sf -X DELETE "http://localhost:4781/api/devices/$TARGET/v1/sessions/$SID" >/dev/null && echo "archived $NAME via the hub" || true
echo "ALL TUI SMOKE CHECKS PASSED ($TARGET)"
