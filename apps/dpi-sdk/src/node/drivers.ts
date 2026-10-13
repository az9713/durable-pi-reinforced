// One driver per device kind. Drivers know kinds and services, never machines:
// every machine-specific fact comes from dpi-network.yaml.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { DeviceKind } from "../api.js";
import { DpiClient } from "../client.js";
import { syncConfigToRegistry, type NetDevice, type NetworkConfig } from "./config.js";
import { NetworkRegistry } from "./registry.js";
import { exeDev, q, remote, rsync, run, shPath, sleep } from "./ops.js";

export interface DriverContext {
  config: NetworkConfig;
  registry: NetworkRegistry;
  args: string[];
  log: (line: string) => void;
}

export type Verb =
  | "up"
  | "create"
  | "provision"
  | "deploy"
  | "env"
  | "service"
  | "expose"
  | "register"
  | "restart"
  | "down"
  | "logs"
  | "destroy"
  | "rotate";

export type Driver = Partial<Record<Verb, (device: NetDevice, ctx: DriverContext) => Promise<void>>>;

export const SERVICE_LABEL = "dev.dpi.backend";
export const SYSTEMD_UNIT = "dpi-backend";
const NVM_INSTALL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh";

/** Run a script locally (kind local) or on the device over ssh. */
function exec(device: NetDevice, script: string, options: { echo?: boolean; timeoutMs?: number } = {}) {
  if (device.kind === "local")
    return run("sh", ["-s"], {
      ...options,
      stdin: `set -e\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true\n${script}`,
    });
  return remote(device, script, options);
}

function localEnv(config: NetworkConfig): Record<string, string> {
  const file = join(config.root, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

// ------------------------------------------------------------------ shared steps

async function facts(device: NetDevice) {
  const out = (
    await exec(device, `echo "HOME=$HOME"; echo "USER=$(id -un)"; echo "NODE=$(nvm which ${device.node} 2>/dev/null || command -v node || true)"`)
  ).stdout;
  const get = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { home: get("HOME"), user: get("USER"), node: get("NODE") };
}

const abs = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);

async function provision(device: NetDevice, ctx: DriverContext) {
  ctx.log(`provision ${device.id}: nvm + node ${device.node}`);
  const apt =
    device.kind === "exe-dev"
      ? `if command -v apt-get >/dev/null; then sudo -n apt-get update -qq >/dev/null && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git rsync curl build-essential ripgrep >/dev/null; fi\n`
      : "";
  const result = await exec(
    device,
    `${apt}if [ ! -s "$NVM_DIR/nvm.sh" ]; then curl -fsSL ${NVM_INSTALL} | PROFILE=/dev/null bash >/dev/null; fi
. "$NVM_DIR/nvm.sh"
nvm install ${device.node} >/dev/null 2>&1
echo "node: $(nvm which ${device.node})"`,
    { timeoutMs: 900_000 },
  );
  ctx.log(result.stdout.trim());
}

async function deploy(device: NetDevice, ctx: DriverContext) {
  const code = device.codeDir.replace(/^~\//, "");
  ctx.log(`deploy ${device.id}: sync apps/dpi-backend + apps/dpi-sdk → ${device.codeDir}/apps`);
  await exec(
    device,
    `mkdir -p "${shPath(device.codeDir)}/apps" "${shPath(device.codeDir)}/e2e" "${shPath(device.homeDir)}" && chmod 700 "${shPath(device.homeDir)}"`,
  );
  await rsync(device, ["apps/dpi-backend", "apps/dpi-sdk"], `${code}/apps/`, ctx.config.root);
  ctx.log(`deploy ${device.id}: npm ci`);
  await exec(
    device,
    `cd "${shPath(device.codeDir)}/apps/dpi-backend" && nvm exec ${device.node} npm ci --no-audit --no-fund --loglevel=error >/dev/null && echo installed`,
    { timeoutMs: 900_000 },
  );
}

/** Write <home>/backend.env, keeping an existing token unless rotating. Secrets travel on stdin. */
async function writeEnv(device: NetDevice, ctx: DriverContext, rotate = false) {
  const local = localEnv(ctx.config);
  const missing = device.envKeys.filter((k) => !(local[k] ?? process.env[k]));
  if (missing.length) ctx.log(`warning: ${missing.join(", ")} not found in ${join(ctx.config.root, ".env")} or the environment`);
  const home = shPath(device.homeDir);
  const body = [
    `DPI_DEVICE_NAME=${device.id}`,
    `DPI_PORT=${device.port}`,
    `DPI_HOST=${device.host}`,
    `DPI_START_DIRS=${device.startDirs.join(":")}`,
    ...device.envKeys.flatMap((k) => {
      const v = local[k] ?? process.env[k];
      return v && !/[\n\r]/.test(v) ? [`${k}=${v}`] : [];
    }),
    ...Object.entries(device.env).map(([k, v]) => `${k}=${v}`),
  ].join("\n");
  const mkStartDirs = device.startDirs.map((r) => `mkdir -p "${shPath(r)}"`).join("\n");
  await exec(
    device,
    `umask 077
mkdir -p "${home}"
F="${home}/backend.env"
TOKEN=$(grep '^DPI_TOKEN=' "$F" 2>/dev/null | head -1 | cut -d= -f2- || true)
if [ -z "$TOKEN" ] || [ "${rotate ? 1 : 0}" = 1 ]; then TOKEN="dpi_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\\n')"; fi
printf 'DPI_TOKEN=%s\\n' "$TOKEN" > "$F.tmp"
cat >> "$F.tmp" <<'DPI_ENV_EOF'
${body}
DPI_ENV_EOF
mv "$F.tmp" "$F"
chmod 600 "$F"
${mkStartDirs}
echo "env ok"`,
  );
  ctx.log(`env ${device.id}: ${device.homeDir}/backend.env written (${rotate ? "token rotated" : "token kept or created"})`);
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/__([A-Z_]+)__/g, (m, key: string) => {
    if (!(key in values)) throw Error(`Template placeholder ${m} has no value`);
    return values[key];
  });
}

async function installService(device: NetDevice, ctx: DriverContext) {
  if (!device.service) throw Error(`${device.id} has no service in dpi-network.yaml`);
  const f = await facts(device);
  if (!f.node) throw Error(`${device.id}: node ${device.node} not found; run: just net step provision ${device.id}`);
  const app = device.kind === "local" ? join(ctx.config.root, "apps/dpi-backend") : `${abs(device.codeDir, f.home)}/apps/dpi-backend`;
  const dpiHome = abs(device.homeDir, f.home);
  const nodeDir = f.node.replace(/\/node$/, "");
  const values = {
    LABEL: SERVICE_LABEL,
    UNIT: SYSTEMD_UNIT,
    NODE: f.node,
    APP: app,
    HOME: f.home,
    USER: f.user,
    DPI_HOME: dpiHome,
    LOG: `${dpiHome}/backend.log`,
    PATH: `${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const deployDir = join(ctx.config.root, "apps/dpi-backend/deploy");
  if (device.service === "launchd") {
    const plist = fill(readFileSync(join(deployDir, "dpi-backend.plist"), "utf8"), values);
    await exec(
      device,
      `P="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$P" <<'DPI_PLIST_EOF'
${plist}
DPI_PLIST_EOF
launchctl bootout gui/$(id -u)/${SERVICE_LABEL} 2>/dev/null || true
for i in 1 2 3 4 5; do launchctl bootstrap gui/$(id -u) "$P" 2>/dev/null && break; sleep 1; done
launchctl print gui/$(id -u)/${SERVICE_LABEL} >/dev/null && echo "launchd ok"`,
    );
  } else {
    const unit = fill(readFileSync(join(deployDir, "dpi-backend.service"), "utf8"), values);
    await exec(
      device,
      `sudo -n tee /etc/systemd/system/${SYSTEMD_UNIT}.service >/dev/null <<'DPI_UNIT_EOF'
${unit}
DPI_UNIT_EOF
sudo -n systemctl daemon-reload
sudo -n systemctl enable ${SYSTEMD_UNIT} >/dev/null 2>&1
sudo -n systemctl restart ${SYSTEMD_UNIT}
echo "systemd ok"`,
    );
  }
  ctx.log(`service ${device.id}: ${device.service} installed and started`);
}

async function serviceCommand(device: NetDevice, action: "restart" | "down") {
  if (device.service === "launchd")
    return exec(
      device,
      action === "restart"
        ? `launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}`
        : `launchctl bootout gui/$(id -u)/${SERVICE_LABEL} 2>/dev/null || true`,
    );
  if (device.service === "systemd")
    return exec(device, `sudo -n systemctl ${action === "restart" ? "restart" : "stop"} ${SYSTEMD_UNIT}`);
  throw Error(`${device.id} has no service; it runs with \`just backend run\``);
}

async function register(device: NetDevice, ctx: DriverContext) {
  syncConfigToRegistry(ctx.config, ctx.registry);
  const token = (await exec(device, `grep '^DPI_TOKEN=' "${shPath(device.homeDir)}/backend.env" | head -1 | cut -d= -f2-`)).stdout.trim();
  if (!token) throw Error(`${device.id}: no DPI_TOKEN in ${device.homeDir}/backend.env; run: just net step env ${device.id}`);
  ctx.registry.setToken(device.id, token);
  ctx.registry.forgetUid(device.id);
  ctx.log(`register ${device.id}: token stored in ${ctx.registry.path}`);
}

export async function waitOnline(device: NetDevice, ctx: DriverContext, timeoutMs = 90_000) {
  const token = ctx.registry.get(device.id)?.token;
  if (!token) throw Error(`${device.id} has no token; run: just net register ${device.id}`);
  const client = new DpiClient(device.url, token);
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const info = await client.device({ timeoutMs: 5000 });
      ctx.log(`online ${device.id}: ${device.url} (${info.name}, uid ${info.uid}, ${info.models.length} models)`);
      return info;
    } catch (e) {
      last = (e as Error).message;
      await sleep(2000);
    }
  }
  throw Error(`${device.id} did not come online at ${device.url}: ${last}`);
}

async function logs(device: NetDevice, ctx: DriverContext) {
  const n = Number(ctx.args[0] ?? 80) || 80;
  const out = await exec(device, `tail -n ${n} "${shPath(device.homeDir)}/backend.log" 2>/dev/null || echo "(no log yet at ${device.homeDir}/backend.log)"`);
  process.stdout.write(out.stdout);
}

// ------------------------------------------------------------------ drivers

const sshDriver: Driver = {
  provision,
  deploy,
  env: (d, ctx) => writeEnv(d, ctx),
  rotate: async (d, ctx) => {
    await writeEnv(d, ctx, true);
    await serviceCommand(d, "restart");
    await register(d, ctx);
  },
  service: installService,
  register,
  restart: async (d, ctx) => {
    await serviceCommand(d, "restart");
    ctx.log(`restart ${d.id}: done`);
  },
  down: async (d, ctx) => {
    await serviceCommand(d, "down");
    ctx.log(`down ${d.id}: stopped`);
  },
  logs,
  async up(d, ctx) {
    await provision(d, ctx);
    await deploy(d, ctx);
    await writeEnv(d, ctx);
    await installService(d, ctx);
    await register(d, ctx);
    await waitOnline(d, ctx);
  },
};

async function exeVms(): Promise<string[]> {
  const out = await exeDev<{ vms?: { vm_name?: string; name?: string; dns_name?: string }[] }>(["ls"]);
  return (out.vms ?? []).map((v) => v.vm_name ?? v.name ?? (v.dns_name ?? "").replace(/\.exe\.xyz$/, ""));
}

async function exeCreate(device: NetDevice, ctx: DriverContext) {
  const vm = device.vm!;
  if ((await exeVms()).includes(vm)) {
    ctx.log(`create ${device.id}: VM ${vm} already exists`);
  } else {
    const c = device.create ?? {};
    ctx.log(`create ${device.id}: ssh exe.dev new --name=${vm}`);
    await exeDev(
      [
        "new",
        `--name=${vm}`,
        ...(c.cpu ? [`--cpu=${c.cpu}`] : []),
        ...(c.memory ? [`--memory=${c.memory}`] : []),
        ...(c.disk ? [`--disk=${c.disk}`] : []),
      ],
      300_000,
    );
  }
  for (let i = 0; i < 40; i++) {
    const ok = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", device.ssh!, "echo READY"], {
      allowFail: true,
      timeoutMs: 20_000,
    });
    if (ok.stdout.includes("READY")) return ctx.log(`create ${device.id}: ssh ${device.ssh} ready`);
    await sleep(3000);
  }
  throw Error(`${device.id}: ${device.ssh} never accepted ssh`);
}

async function exeExpose(device: NetDevice, ctx: DriverContext) {
  await exeDev(["share", "port", device.vm!, String(device.port)]);
  await exeDev(["share", "set-public", device.vm!]);
  ctx.log(`expose ${device.id}: ${device.url} → :${device.port}, public (the bearer token is the gate)`);
}

async function exeDestroy(device: NetDevice, ctx: DriverContext) {
  const vm = device.vm!;
  if (!(await exeVms()).includes(vm)) return ctx.log(`destroy ${device.id}: VM ${vm} does not exist`);
  if (!ctx.args.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Destroy exe.dev VM ${vm} and its disk? Type the VM name to confirm: `);
    rl.close();
    if (answer.trim() !== vm) return ctx.log("destroy: cancelled");
  }
  await exeDev(["rm", vm], 120_000);
  ctx.registry.forgetUid(device.id);
  ctx.log(`destroy ${device.id}: VM ${vm} removed`);
}

const exeDevDriver: Driver = {
  ...sshDriver,
  create: exeCreate,
  expose: exeExpose,
  destroy: exeDestroy,
  async up(d, ctx) {
    await exeCreate(d, ctx);
    await provision(d, ctx);
    await deploy(d, ctx);
    await writeEnv(d, ctx);
    await installService(d, ctx);
    await exeExpose(d, ctx);
    await register(d, ctx);
    await waitOnline(d, ctx);
  },
};

const localDriver: Driver = {
  env: (d, ctx) => writeEnv(d, ctx),
  register,
  logs,
  rotate: async (d, ctx) => {
    await writeEnv(d, ctx, true);
    await register(d, ctx);
    ctx.log("restart the local backend to use the new token");
  },
  service: installService,
  restart: async (d, ctx) => {
    await serviceCommand(d, "restart");
    ctx.log(`restart ${d.id}: done`);
  },
  down: async (d, ctx) => {
    await serviceCommand(d, "down");
    ctx.log(`down ${d.id}: stopped`);
  },
  async up(d, ctx) {
    await writeEnv(d, ctx);
    await register(d, ctx);
    if (d.service) {
      await installService(d, ctx);
      await waitOnline(d, ctx);
    } else ctx.log(`up ${d.id}: env ready. Start it with: just backend run   (it reads ${d.homeDir}/backend.env)`);
  },
};

const urlDriver: Driver = {
  async register(d, ctx) {
    syncConfigToRegistry(ctx.config, ctx.registry);
    const i = ctx.args.indexOf("--token");
    const token = i >= 0 ? ctx.args[i + 1] : d.tokenEnv ? process.env[d.tokenEnv] : undefined;
    if (!token) throw Error(`${d.id} is a url device: pass --token <token>${d.tokenEnv ? ` or set ${d.tokenEnv}` : ""}`);
    ctx.registry.setToken(d.id, token);
    ctx.registry.forgetUid(d.id);
    ctx.log(`register ${d.id}: token stored`);
  },
  async up(d, ctx) {
    await urlDriver.register!(d, ctx);
    await waitOnline(d, ctx);
  },
};

export const drivers: Record<DeviceKind, Driver> = {
  local: localDriver,
  ssh: sshDriver,
  "exe-dev": exeDevDriver,
  url: urlDriver,
};

export const defaultHome = () => homedir();
export { q };
