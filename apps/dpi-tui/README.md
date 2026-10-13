# dpi-tui

A pi-like terminal client for one Durable Agent Network device. It talks straight to a device's `dpi-backend` over the [v1 API](../dpi-backend/API.md) with the device's bearer token, and renders the same transcript items as the web client (`AgentModel` + `toTranscript` from [`dpi-sdk`](../dpi-sdk)). Closing it never stops the agent.

```bash
just tui attach mac-mini                   # pick a session on mac-mini (or create one in any directory)
just tui attach mac-mini:triage            # session by name or id; its root agent
just tui attach mac-mini:triage:alt-path   # a specific agent (id, "main" or name)
just tui new vm-1 review                   # in the device's first start dir; --cwd takes a path on the device
cd apps/dpi-tui && npm start -- --url https://my-vm.exe.xyz --token $DPI_TOKEN --save my-vm
```

Device ids come from `~/.dpi/network.sqlite`, seeded from the repo's `dpi-network.yaml` (created from `dpi-network.example.yaml`). Tokens come from `just net register <id>`. `--url/--token` connects to any backend, and `--save <id>` stores it.

`-s/--session` and `-a/--agent` pick a session and agent. `--new <name>` creates a session, with `--cwd <dir>` on the device and `--model <id>`. `DPI_URL` and `DPI_TOKEN` stand in for `--url` and `--token`, and `DPI_DEVICE` names the default device. `--help` lists every option.

## Keys

| Key | Action |
|---|---|
| Enter | send; while the agent works it steers (joins after the current tool round) |
| Alt+Enter | queue as a follow-up |
| Esc | interrupt foreground work (background jobs continue) |
| Shift+Tab | cycle thinking level |
| Ctrl+L | model picker |
| Ctrl+O | expand tool output and thinking |
| Ctrl+C | close an open picker or panel, else clear the input; on an empty input, exit and print the reattach command (session and agent by name when unique, else ids) |
| Ctrl+D | exit (on an empty input) |

Commands: `/sessions`, `/agents`, `/model`, `/devices`, `/new [name]`, `/fork [entryId] [name]`, `/thinking <level>`, `/compact [instructions]`, `/reset [note]`, `/name <name>`, `/tasks`, `/help`, `/quit`. Any other text starting with `/` goes to the agent.

A send that fails on the network retries with the same `requestId`, so the device admits it once. A failed send keeps the editor text.

## Layout

```
src/main.ts      args, device resolution, --new
src/app.ts       TuiAltScreen layout, agent + session streams (SDK follow), keys, submit
src/render.ts    transcript items → components, cached by item id
src/pickers.ts   sessions (+ new session with a remote directory walk), agents, models, devices
src/commands.ts  slash commands
src/theme.ts     colors and pi-tui themes
bin/dpi-tui.mjs  runs src/main.ts through tsx, for npm link or npx dpi-tui
```

## Tests

```bash
npm run check && npm test   # types; every item kind fits widths 40/80/200 (CJK, emoji, long args)
tests/smoke.sh faux         # tmux end to end against a faux-provider backend: streaming, steer, Esc, fork, reattach by name
tests/smoke.sh <device>     # real model on a device: streaming, exit mid-tool, reattach
```

From the repo root, `just tui check` and `just test smoke [faux|<id>]` run the same. The smoke script needs tmux, curl and openssl. The device run archives its session through the hub at `http://localhost:4781`, so start the hub first or archive the session yourself.
