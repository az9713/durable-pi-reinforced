# Proactive DPI demo: Jev log watcher and durable incident agents.
# Every recipe runs in apps/proactive-dpi-demo.

set shell := ["zsh", "-cu"]
set working-directory := "../../apps/proactive-dpi-demo"

port := "4790"

# List proactive demo commands
[default]
default:
    @just --list proactive

# Install the demo's dependencies
install:
    npm install --no-audit --no-fund

# Type check and build the UI
build:
    npm run build

# Wipe data and rebuild the mock repo
reset:
    npm run reset --silent

# Run the demo; prints only the URL
start *ARGS:
    npm start --silent -- {{ ARGS }}

# Fresh take: reset, then start
take *ARGS:
    npm run reset --silent
    npm start --silent -- {{ ARGS }}

# Run with Vue hot reload
dev *ARGS:
    npm run dev -- {{ ARGS }}

# Run only the backend
be *ARGS:
    npm run be -- {{ ARGS }}

# Run only the log stream
stream *ARGS:
    npm run logs -- {{ ARGS }}

# Follow backend and stream output
tail:
    tail -n 40 -f .data/demo.log

# Open the UI in the browser
open:
    open http://localhost:{{ port }}

# Deploy the bug now
bug:
    curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:{{ port }}/api/demo/deploy-bug

# Stop a running demo
stop:
    pkill -INT -f "scripts/demo.ts" || echo "No demo running"
