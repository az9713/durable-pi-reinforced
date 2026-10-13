# The playground hub and web client: http://localhost:4781.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/dpi-playground"

port := env("DPI_HUB_PORT", "4781")
free-port := source_directory() / ".." / "free-port.sh"

# List hub commands
[default]
default:
    @just --list hub

# Serve the built web UI (frees the port first)
start *ARGS:
    @{{ free-port }} {{ port }}
    DPI_HUB_PORT={{ port }} npm start -- "$@"

# Serve with Vite hot reload (frees the port)
dev *ARGS:
    @{{ free-port }} {{ port }}
    DPI_HUB_PORT={{ port }} npm run dev -- "$@"

# Type check and build the web UI
build:
    npm run build

# Open the web UI in the browser
open:
    open http://localhost:{{ port }}

# Build, lint and run the hub test
check:
    npm run build
    npm run lint
    npm test
