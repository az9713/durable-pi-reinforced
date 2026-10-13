# Durable Agent Network on exe.dev (and every other device kind)

Every device in the repo's `dpi-network.yaml` runs `apps/dpi-backend`, the durable pi device server. Clients (the playground hub, `dpi-tui`, curl) connect with a **URL + bearer token**. This cookbook covers operating those devices. The exe.dev specifics are in the `exe-dev` sections.

## The one rule

**Touch only VMs named in `dpi-network.yaml`.** The exe.dev account holds other people's and other projects' VMs. The ops CLI enforces this: the `exe-dev` driver only issues control-plane verbs for the `vm:` of a device in the YAML.

## Mental model

```
dpi-network.yaml  ──►  just net <verb> <id>  ──►  apps/dpi-sdk/scripts/net.ts  ──►  driver for kind
                                                                          local | ssh | exe-dev | url
```

- **Device facts live only in the YAML** (ssh target, VM name, service, url, start_dirs). No code or recipe names a machine.
- **Tokens never live in the YAML or git.** Each device generates `DPI_TOKEN` in `<home_dir>/backend.env` (mode 0600). `just net register <id>` copies it into `~/.dpi/network.sqlite` on the operator machine.
- **Code and data are separate.** Code is rsynced to `<code_dir>/apps/{dpi-backend,dpi-sdk}`. Data, env and logs live in `<home_dir>` (`backend/`, `backend.env`, `backend.log`). Deploys only create `home_dir` (mode 700) and never change what is inside it.

## Verbs

| Verb | local | ssh | exe-dev | url |
|---|---|---|---|---|
| `just net up <id>` | env + register (+ service and wait online if set) | provision → deploy → env → service → register → wait online | create → same as ssh → expose → register → wait | register (`--token` or `token_env`) → wait online |
| `just net step create <id>` | | | `ssh exe.dev new --name=<vm>` if `ls` lacks it | |
| `just net step provision <id>` | | nvm + node `<node>` | + apt build tools, rsync, ripgrep | |
| `just net deploy <id>` | | rsync + `npm ci` + restart | same | |
| `just net step env <id>` | writes backend.env | same over ssh (`env_keys` piped from `.env` on stdin) | same | |
| `just net step service <id>` | optional launchd/systemd | LaunchAgent `dev.dpi.backend` or systemd `dpi-backend` | systemd | |
| `just net step expose <id>` | | | `share port <vm> <port>` + `share set-public` | |
| `just net register <id>` | reads local token | reads token over ssh | same | `--token <t>` or `token_env` |
| `just net restart/down/logs <id>` | if service | launchctl / systemctl, `tail backend.log` | same | |
| `just net rotate <id>` | new token, re-register | new token, restart, re-register | same | |
| `just net destroy <id>` | | | `ssh exe.dev rm <vm>` after typing the VM name (or `--yes`) | |
| `just net status [id]` | probe | probe | probe | probe |
| `just net probe <id>` | `/healthz` 200, `/v1/device` 401 without a token | same | same | same |

## exe-dev: bring a VM online

```bash
just net up vm-1        # creates the VM named in `vm:` if missing, then everything else (~3-5 min)
just net status vm-1    # online, uid, api v1, session count
just net probe vm-1     # /healthz 200 and /v1/device 401 without a token
```

What `up` does on exe.dev:

1. `ssh exe.dev ls --json`. If the VM is missing: `ssh exe.dev new --name=<vm> --cpu --memory --disk` from `create:`.
2. Waits for `ssh <vm>.exe.xyz` (accepts the new host key once).
3. Installs git, rsync, curl, build-essential and ripgrep with `sudo -n apt-get`, then nvm + Node `<node>`.
4. Rsyncs `apps/dpi-backend` + `apps/dpi-sdk` to `~/dpi/apps/` and runs `npm ci`.
5. Writes `~/.dpi/backend.env` from the YAML only: `DPI_TOKEN` (kept), `DPI_DEVICE_NAME`, `DPI_PORT`, `DPI_HOST` (`host`, `0.0.0.0` so the proxy can reach it), `DPI_START_DIRS`, the `env_keys` secrets from `.env`, and any `env` entries.
6. Installs `/etc/systemd/system/dpi-backend.service` from `apps/dpi-backend/deploy/dpi-backend.service`, then `enable` + `restart`.
7. `ssh exe.dev share port <vm> 4780` and `share set-public <vm>`. The public proxy is anonymous, so **the bearer token is the only gate**. Every `/v1` route needs it.
8. Copies the token into the local registry and waits for `GET /v1/device`.

Verified on exe.dev (2026-10-05): the HTTPS proxy forwards `Authorization: Bearer`, `X-DPI-Token` also works, anonymous `/v1` calls get 401, and SSE frames arrive in about 0.15s (no proxy buffering).

## exe-dev: debug

```bash
just net logs vm-1 200                                            # ~/.dpi/backend.log on the VM
ssh my-dpi-vm-1.exe.xyz 'systemctl status dpi-backend --no-pager | head -20'
ssh my-dpi-vm-1.exe.xyz 'curl -s localhost:4780/healthz'    # bypass the proxy
ssh exe.dev share show my-dpi-vm-1 --json                   # proxy port + visibility
```

| Symptom | Cause | Fix |
|---|---|---|
| `https://<vm>.exe.xyz` redirects to exe.dev login | share is private | `just net step expose <id>` |
| 502 from the proxy | backend down or bound to 127.0.0.1 | `just net logs <id>`; set `host: 0.0.0.0` in `dpi-network.yaml` (the exe-dev default), then `just net step env <id>` and `just net restart <id>` |
| `unauthorized` in `just net status` | the registry token is stale (VM recreated or token rotated) | `just net register <id>` |
| `mismatch` in the web UI | the URL now answers with a different device uid (VM recreated) | confirm, then `just net register <id>` (it forgets the old uid) |
| `npm ci` fails | Node missing or wrong major | `just net step provision <id>` |

## exe-dev: tear down

```bash
just net destroy vm-1             # prompts for the VM name; deletes the disk (no undo)
```

`destroy` refuses VMs not in the YAML. To keep the data, archive `~/.dpi` first (`exedev files download-dir <vm> /home/exedev/.dpi ./archive/<vm>`), or use the fleet scripts in [fleet.md](fleet.md).

## ssh devices (Mac minis, Linux boxes)

The same verbs apply. macOS hosts use a LaunchAgent (`~/Library/LaunchAgents/dev.dpi.backend.plist`), so the backend runs in the logged-in GUI session and needs auto-login to survive reboots. If agents work under `~/Documents`, grant the pinned node binary Full Disk Access (macOS privacy), or keep `start_dirs` outside `~/Documents` as the default `~/dpi-work` does.

## Adding a device

1. Add an entry to `dpi-network.yaml` (gitignored; created from `dpi-network.example.yaml`, whose commented `ssh` and `exe-dev` entries are the templates).
2. `just net up <id>`.
3. `just net status`. The hub (`just hub start`) and `just tui attach <id>` pick it up automatically.
