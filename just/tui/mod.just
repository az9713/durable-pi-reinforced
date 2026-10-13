# dpi-tui, the terminal client. Targets look like <device>[:<session>[:<agent>]].

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/dpi-tui"

# List terminal client commands
[default]
default:
    @just --list tui

# Attach to a device, session or agent
attach TARGET *ARGS:
    npm start --silent -- "$@"

# Create a session on a device, attach
new DEVICE NAME *ARGS:
    npm start --silent -- "$1" --new "$2" "${@:3}"

# Type check and run render tests
check:
    npm run check
    npm test
