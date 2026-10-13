# Test suites. Device suites use a real model and cost money; `unit` and `ui` do not.

set shell := ["zsh", "-cu"]
set positional-arguments

# List test commands
[default]
[no-cd]
default:
    @just --list test

# Type checks and unit tests, every app
[no-cd]
unit:
    cd apps/dpi-sdk && npm run check && npm test
    cd apps/dpi-backend && npm run check && npm test
    cd apps/dpi-playground && npm run build && npm run lint && npm test
    cd apps/dpi-tui && npm run check && npm test

# Web UI suite against two faux devices (builds the UI first)
[no-cd]
ui:
    cd apps/dpi-playground && npm run build && node tests/network-ui.mjs

# UI and agent suites on one device
[no-cd]
device DEVICE:
    cd apps/dpi-playground && for t in device-ui agent-features browser-close; do DPI_DEVICE="$1" node tests/$t.mjs || exit 1; done

# Device suites on every YAML device
[no-cd]
devices:
    for d in $(just net ids); do just test device "$d" || exit 1; done

# TUI smoke: faux, or a device id
[no-cd]
smoke TARGET="faux":
    apps/dpi-tui/tests/smoke.sh "$1"

# TUI + web + restart + fork scenario
[no-cd]
e2e DEVICE:
    cd apps/dpi-playground && DPI_DEVICE="$1" node tests/e2e-network.mjs
