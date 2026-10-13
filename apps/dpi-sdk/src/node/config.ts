// Load dpi-network.yaml: the declared devices of a Durable Agent Network.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { DeviceKind } from "../api.js";
import { DEVICE_ID, DEVICE_KINDS, NetworkRegistry, normalizeUrl } from "./registry.js";

export const NETWORK_FILE = "dpi-network.yaml";
export type ServiceKind = "launchd" | "systemd";

/** Where new sessions start when a device sets no start_dirs (created by `just net up`). */
export const DEFAULT_START_DIR = "~/dpi-work";

export interface NetDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  url: string;
  port: number;
  node: number;
  codeDir: string;
  homeDir: string;
  /** Bind address written as DPI_HOST: 127.0.0.1 for local devices, 0.0.0.0 otherwise. */
  host: string;
  startDirs: string[];
  /** Variables copied by name from this checkout's .env (secrets). */
  envKeys: string[];
  /** Literal extra variables for backend.env (defaults.env merged with the device's env). */
  env: Record<string, string>;
  ssh?: string;
  service?: ServiceKind;
  vm?: string;
  create?: { cpu?: number; memory?: string; disk?: string };
  tokenEnv?: string;
}

export interface NetworkConfig {
  file: string;
  root: string;
  devices: Record<string, NetDevice>;
}

type Raw = Record<string, unknown>;

function findNetworkFile(start = process.cwd()): string | undefined {
  if (process.env.DPI_NETWORK_FILE) return resolve(process.env.DPI_NETWORK_FILE);
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, NETWORK_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const str = (v: unknown, where: string) => {
  if (typeof v !== "string" || !v.trim()) throw Error(`${where} must be a non-empty string`);
  return v.trim();
};
/** backend.env keys the drivers write from dedicated config fields. */
export const MANAGED_ENV = ["DPI_TOKEN", "DPI_DEVICE_NAME", "DPI_PORT", "DPI_HOST", "DPI_START_DIRS"] as const;

function envMap(base: unknown, own: unknown, envKeys: string[], where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [layer, value] of [["defaults.env", base], [`${where}.env`, own]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error(`${layer} must be a map`);
    for (const [key, v] of Object.entries(value as Raw)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw Error(`${layer}.${key}: names are UPPER_SNAKE_CASE`);
      if ((MANAGED_ENV as readonly string[]).includes(key))
        throw Error(`${layer}.${key} is written from its own setting (port, host, start_dirs); set that instead`);
      if (envKeys.includes(key)) throw Error(`${layer}.${key} is also in env_keys; keep it in one place`);
      if (!["string", "number", "boolean"].includes(typeof v) || /[\n\r]/.test(String(v)))
        throw Error(`${layer}.${key} must be a single-line string, number or boolean`);
      out[key] = String(v);
    }
  }
  return out;
}

const strList = (v: unknown, where: string) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw Error(`${where} must be a list of strings`);
  return v as string[];
};

export function parseNetworkConfig(text: string, file = NETWORK_FILE): NetworkConfig {
  const raw = (parse(text) ?? {}) as Raw;
  const defaults = (raw.defaults ?? {}) as Raw;
  const devicesRaw = (raw.devices ?? {}) as Raw;
  if (typeof devicesRaw !== "object" || Array.isArray(devicesRaw)) throw Error(`${file}: devices must be a map`);
  const devices: Record<string, NetDevice> = {};
  for (const [id, value] of Object.entries(devicesRaw)) {
    const where = `${file}: devices.${id}`;
    if (!DEVICE_ID.test(id)) throw Error(`${where}: id must match ${DEVICE_ID}`);
    const d = { ...defaults, ...(value as Raw) } as Raw;
    if (d.roots !== undefined) throw Error(`${where}: "roots" was renamed to "start_dirs"`);
    const kind = str(d.kind, `${where}.kind`) as DeviceKind;
    if (!DEVICE_KINDS.includes(kind)) throw Error(`${where}.kind must be one of ${DEVICE_KINDS.join(", ")}`);
    const port = Number(d.port ?? 4780);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error(`${where}.port is invalid`);
    const device: NetDevice = {
      id,
      name: typeof d.name === "string" ? d.name : id,
      kind,
      url: "",
      port,
      node: Number(d.node ?? 24),
      codeDir: typeof d.code_dir === "string" ? d.code_dir : "~/dpi",
      homeDir: typeof d.home_dir === "string" ? d.home_dir : "~/.dpi",
      startDirs: d.start_dirs === undefined ? [DEFAULT_START_DIR] : strList(d.start_dirs, `${where}.start_dirs`),
      host: d.host === undefined ? (kind === "local" ? "127.0.0.1" : "0.0.0.0") : str(d.host, `${where}.host`),
      envKeys: d.env_keys === undefined ? [] : strList(d.env_keys, `${where}.env_keys`),
      env: {},
      ...(typeof d.token_env === "string" ? { tokenEnv: d.token_env } : {}),
    };
    device.env = envMap(defaults.env, (value as Raw).env, device.envKeys, where);
    if (d.service !== undefined) {
      if (d.service !== "launchd" && d.service !== "systemd") throw Error(`${where}.service must be launchd or systemd`);
      device.service = d.service;
    }
    if (kind === "ssh") device.ssh = str(d.ssh, `${where}.ssh`);
    if (kind === "exe-dev") {
      device.vm = str(d.vm, `${where}.vm`);
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(device.vm)) throw Error(`${where}.vm is not a valid exe.dev name`);
      device.ssh = `${device.vm}.exe.xyz`;
      device.service ??= "systemd";
      const create = (d.create ?? {}) as Raw;
      device.create = {
        ...(create.cpu !== undefined ? { cpu: Number(create.cpu) } : {}),
        ...(typeof create.memory === "string" ? { memory: create.memory } : {}),
        ...(typeof create.disk === "string" ? { disk: create.disk } : {}),
      };
    }
    if ((kind === "ssh" || kind === "exe-dev") && !device.service) throw Error(`${where}.service is required for kind ${kind}`);
    const defaultUrl =
      kind === "local" ? `http://127.0.0.1:${port}` : kind === "exe-dev" ? `https://${device.vm}.exe.xyz` : undefined;
    const url = d.url ?? defaultUrl;
    device.url = normalizeUrl(str(url, `${where}.url`));
    devices[id] = device;
  }
  return { file, root: dirname(file), devices };
}

export function loadNetworkConfig(start?: string): NetworkConfig {
  const file = findNetworkFile(start);
  if (!file)
    throw Error(
      `No ${NETWORK_FILE} found from ${start ?? process.cwd()} upward. Create it from the template: cp dpi-network.example.yaml ${NETWORK_FILE}`,
    );
  return parseNetworkConfig(readFileSync(file, "utf8"), file);
}

/** Like loadNetworkConfig, but a missing file means "no config devices". */
export function tryLoadNetworkConfig(start?: string): NetworkConfig | undefined {
  const file = findNetworkFile(start);
  return file ? parseNetworkConfig(readFileSync(file, "utf8"), file) : undefined;
}

/** Upsert config devices into the registry (source: config) and drop config devices removed from the file. */
export function syncConfigToRegistry(config: NetworkConfig, registry: NetworkRegistry) {
  Object.values(config.devices).forEach((device, position) => {
    const token = device.tokenEnv ? process.env[device.tokenEnv] : undefined;
    registry.upsert({
      id: device.id,
      name: device.name,
      kind: device.kind,
      url: device.url,
      source: "config",
      position,
      ...(token ? { token } : {}),
    });
  });
  registry.pruneConfig(Object.keys(config.devices));
}
