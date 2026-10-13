# dpi-backend

The Durable Pi **device server**. Run one on every machine that should host durable agents: your laptop, a Mac mini, a Linux box, an exe.dev VM. It owns the harnesses, the SQLite databases, the tools and the filesystem. Clients connect with the device's **URL and bearer token** through the [v1 API](API.md).

```
client (hub / dpi-tui / curl) ──HTTP + SSE, Bearer──► dpi-backend ──► sessions/<id>/agent.sqlite (pi-durable)
```

## Run it on this machine

Needs Node 22.19 or newer (`.nvmrc` pins 24).

```bash
cd apps/dpi-backend && npm install
npm run token                  # creates ~/.dpi/backend.env with DPI_TOKEN and prints it (npm run token -- --rotate replaces it)
echo "OPENROUTER_API_KEY=sk-or-..." >> ~/.dpi/backend.env
npm start                      # 127.0.0.1:4780; data in ~/.dpi/backend
```

With the repo's network config, `just net up local && just backend run` does the same thing. `just backend run` first stops whatever already listens on the backend's port.

## Configuration: `~/.dpi/backend.env`

| Key | Default | Meaning |
|---|---|---|
| `DPI_TOKEN` | required, ≥32 chars | bearer token for every `/v1` call |
| `DPI_DEVICE_NAME` | hostname | name shown to clients |
| `DPI_PORT` / `DPI_HOST` | `4780` / `127.0.0.1` | listen address. `just net up` writes the YAML `host`, which defaults to `0.0.0.0` for `ssh` and `exe-dev` devices so other machines can reach them |
| `DPI_START_DIRS` | `~/dpi-work` | colon-separated folders where new sessions start, created at startup if missing: the directory browser opens there and relative cwds resolve against the first. Any existing directory is allowed as cwd |
| `DPI_DATA_DIR` | `$DPI_HOME/backend` | catalog, app state, `sessions/`, `archive/` |
| `DPI_HOME` | `~/.dpi` | where `backend.env` is read (set by the service unit) |
| `DPI_ENV_FILE` | `$DPI_HOME/backend.env` | the env file to read |
| `DPI_PROVIDER` | `openrouter` | `faux` gives a free deterministic model for tests |
| `OPENROUTER_API_KEY` | | model access, required unless `DPI_PROVIDER=faux`. Without it the device lists no models. Never sent to clients |
| `TYPESAFE_API_KEY` | | optional: `jev-damage-control` asks Jev with it, else through OpenRouter |
| `DPI_BACKUP_DIR` | | optional: where `POST /v1/sessions/:s/backup` copies an idle session's database. Put it on another disk or a synced folder; call the route from cron, for example `0 * * * * curl -fsS -X POST -H "Authorization: Bearer $DPI_TOKEN" http://127.0.0.1:4780/v1/sessions/<id>/backup` |

Flags `--port`, `--host`, `--name`, `--start-dirs`, `--data-dir` and `--env-file` override the env.

## Deploy to other devices

Devices are declared in the repo root's `dpi-network.yaml` (gitignored; start from [`dpi-network.example.yaml`](../../dpi-network.example.yaml)). Nothing else names a machine:

```bash
just net up <id>   # (exe.dev: create →) provision → deploy → env → service → (exe.dev: expose →) register → wait online
just net status    # probe every device
just net logs <id>  |  just net restart <id>  |  just net deploy <id>  |  just net down <id>  |  just net destroy <id>
just net rotate <id>   # new token, restart, re-register
just net probe <id>    # /healthz 200 and /v1/device 401 without a token
```

| Kind | Service | Notes |
|---|---|---|
| `local` | none (`just backend run`) or launchd/systemd | binds 127.0.0.1 |
| `ssh` | `launchd` → `~/Library/LaunchAgents/dev.dpi.backend.plist`; `systemd` → `/etc/systemd/system/dpi-backend.service` | binds 0.0.0.0 by default; needs passwordless ssh; systemd needs `sudo -n` |
| `exe-dev` | systemd | VM created on demand; the HTTPS proxy is set public, so the token is the gate |
| `url` | none | connect only: `just net register <id> --token <t>` |
| Windows (WSL2) | systemd inside WSL2 | Windows has no restart layer of its own. (1) In WSL2, put `[boot]` and `systemd=true` in `/etc/wsl.conf`, then run `wsl --shutdown` from Windows. (2) Declare the WSL2 machine as kind `local` with `service: systemd` and run `just net up <id>` from inside WSL2 (needs `sudo -n`). (3) In Windows, start WSL2 at log on: `schtasks /Create /TN "dpi-backend WSL" /SC ONLOGON /TR "wsl.exe -d Ubuntu --exec /bin/true"`. Not verified: whether WSL2 keeps the VM up with only the service running, and a restart with nobody logged on. After setup, reboot, log on and check `systemctl status dpi-backend` in WSL2 |

Templates live in [`deploy/`](deploy/). The operator skill [`.claude/skills/agent-sandboxes-exe-dev/cookbook/dpi-network.md`](../../.claude/skills/agent-sandboxes-exe-dev/cookbook/dpi-network.md) covers debugging per kind.

## Layout on a device

```
~/dpi/apps/dpi-backend, ~/dpi/apps/dpi-sdk     code (rsynced; safe to replace)
~/.dpi/backend.env                              token + config (0600)
~/.dpi/backend/catalog.sqlite                   sessions, agent names, device uid, idempotency keys, compaction thresholds
~/.dpi/backend/app-state.sqlite                 the device's shared App State (demo extension)
~/.dpi/backend/sessions/<uuid>/agent.sqlite     one pi-durable harness per session
~/.dpi/backend/archive/                          archived sessions (DELETE never removes files)
~/.dpi/backend.log                              service log
```

## Guarantees and boundaries

- Closing a client never stops work. A backend restart resumes unfinished tasks from their checkpoints. Replay-safe tools may rerun, and unsafe ones return an interrupted result.
- A token holder has the agent's shell and filesystem access on that device. Start dirs are where sessions begin, not a sandbox.
- macOS `ssh` devices run as a LaunchAgent in the logged-in session, so enable auto-login for unattended reboots. Agents working under `~/Documents` need Full Disk Access for the node binary.
- LAN `ssh` devices speak plain HTTP, so the token crosses the LAN in cleartext. exe.dev devices use HTTPS.
- `jev-damage-control` is off by default. When on, it sends each bash command to the Jev API, and the command runs if Jev fails. It is a guardrail, not a sandbox.

## Demo runbook: hop into an already running agent

Any device id from `dpi-network.yaml` whose backend runs as a service works. `DEVICE=mac-mini` below.

```bash
just net status                                      # 1. every device online
just hub start                                       # 2. web UI: http://localhost:4781
just tui new $DEVICE e2e-network --cwd '~/dpi/e2e'   # 3. a session in the repo's e2e/ folder on the device, attached
```

| Step | Do | Expect |
|---|---|---|
| 4 | In the TUI, prompt a multi-tool task (write a script, run it, improve it three times) | The TUI header shows `● live`, the status line `working…`, and tool rows with spinners |
| 5 | Open the web UI | The tree shows `$DEVICE › e2e-network › Main` with a pulsing dot. The transcript streams in both clients |
| 6 | In the web composer pick **Steer** and send "use bash only for verification runs" | The TUI shows `↪ steer: …`, then the message lands after the current tool round |
| 7 | Ctrl+C the TUI (it prints `just tui attach $DEVICE:<session>:<agent>`), close the browser, run `just net restart $DEVICE` while a tool runs | Nothing is watching. The service restarts in about a second |
| 8 | Reopen the web UI | The device dims, then returns online. The run resumes from its checkpoint, and an interrupted bash call shows its interrupted result |
| 9 | Fork from the web at an earlier reply, name it `e2e-fork`, then run `just tui attach $DEVICE:e2e-network:e2e-fork` | The TUI header shows `⑂ e2e-fork` with the history up to that entry |

`just test e2e $DEVICE` runs steps 3 to 9 unattended and checks the committed state. Its session works in `<code_dir>/e2e` on the device, one `fib-<time>/` folder per run.

The one-request client needs nothing but curl. The answer comes back in the same request:

```bash
read U T < <(sqlite3 -separator ' ' ~/.dpi/network.sqlite "select url, token from devices where id='vm-1'")
H=(-H "Authorization: Bearer $T" -H 'content-type: application/json')
# cwd "." is the device's first start dir
curl -s "$U/v1/sessions" "${H[@]}" -d '{"name":"oneshot","cwd":".","model":{"provider":"openrouter","modelId":"anthropic/claude-sonnet-5.5"}}'
curl -s "$U/v1/sessions/oneshot/agents/main/messages" "${H[@]}" \
  -d '{"content":"How many files are in this directory? Use bash.","requestId":"oneshot-1","waitMs":120000}'
# {"submissionId":…,"status":"done","answer":{"entryId":…,"text":"…"}}  (on timeout: 202 "pending" or "queued"; poll /submissions/<id>?waitMs=)
```

## Development

```bash
npm run dev     # restart on file changes (just backend dev)
npm run check   # strict types, including the pi-durable ↔ SDK wire contract check
npm test        # api, streams, store (jobs, start_session, extensions, read only), search_history, shared state and SIGKILL recovery (faux provider, no network)
```
