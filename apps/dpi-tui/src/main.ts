// dpi-tui: a pi-like terminal client for one Durable Agent Network device.
//   dpi-tui <device>[:<session>[:<agent>]]        device from ~/.dpi/network.sqlite (seeded from dpi-network.yaml)
//   dpi-tui --url <url> --token <token> [--save <id>]
//   dpi-tui mac-mini --new triage                 create a session (in the device's first start dir) and attach
import { parseArgs } from "node:util";
import { DpiClient } from "../../dpi-sdk/src/client.ts";
import { isDpiError } from "../../dpi-sdk/src/errors.ts";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.ts";
import { syncConfigToRegistry, tryLoadNetworkConfig } from "../../dpi-sdk/src/node/config.ts";
import { App, type DeviceRef } from "./app.ts";

const USAGE = `usage: dpi-tui <device>[:<session>[:<agent>]] [options]
       dpi-tui --url <url> --token <token> [--save <id>]

  -s, --session <ref>   session id or name (else a picker opens)
  -a, --agent <ref>     agent id, "main" or name (default: the session's root agent)
  --new <name>          create a session on the device and attach
  --cwd <dir>           working directory on the device for --new (absolute, or relative to its first start dir)
  --model <id>          model for --new (default: the device's default)
  --url, --token        connect to any dpi-backend directly (also DPI_URL, DPI_TOKEN)
  --save <id>           store a --url device in ~/.dpi/network.sqlite under <id>`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    save: { type: "string" },
    session: { type: "string", short: "s" },
    agent: { type: "string", short: "a" },
    new: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const registry = new NetworkRegistry();
const config = tryLoadNetworkConfig(process.env.INIT_CWD ?? process.cwd());
if (config) syncConfigToRegistry(config, registry);

const url = values.url ?? process.env.DPI_URL;
const [deviceRef = "", sessionRef = values.session, agentRef = values.agent] = (
  positionals[0] ?? (url ? "" : (process.env.DPI_DEVICE ?? ""))
).split(":");

let device: DeviceRef;
if (url) {
  const token = values.token ?? process.env.DPI_TOKEN ?? "";
  if (!token) fail("--url needs --token (or DPI_TOKEN)");
  device = { id: values.save ?? "adhoc", name: values.save ?? new URL(url).host, url: url.replace(/\/+$/, ""), token };
} else {
  const known = registry.list().map((d) => d.id);
  if (!deviceRef) fail(`${USAGE}\n\nKnown devices: ${known.join(", ") || "none"}`);
  const row = registry.get(deviceRef);
  if (!row) fail(`Unknown device "${deviceRef}". Known: ${known.join(", ") || "none (add one to dpi-network.yaml)"}`);
  if (!row.token) fail(`No token for ${row.id}. Run: just net register ${row.id}`);
  device = { id: row.id, name: row.name, url: row.url, token: row.token };
}

const client = new DpiClient(device.url, device.token);
const info = await client.device({ timeoutMs: 8000 }).catch((e: unknown) =>
  fail(
    isDpiError(e) && e.code === "unauthorized"
      ? `${device.id}: token rejected by ${device.url}`
      : `${device.id} is offline at ${device.url} (${(e as Error).message})`,
  ),
);
if (values.save && url)
  registry.upsert({ id: values.save, name: values.save, url: device.url, kind: "url", source: "ui", token: device.token });

let session = sessionRef;
if (values.new) {
  const cwd = values.cwd ?? (await client.dirs("")).dirs[0]?.path;
  if (!cwd) fail(`${device.id} has no start dirs; pass --cwd`);
  const modelId = values.model ?? info.defaultModel;
  const model = info.models.find((m) => m.id === modelId);
  if (!model) fail(`Unknown model ${modelId}. Available: ${info.models.map((m) => m.id).join(", ")}`);
  const created = await client
    .createSession({ name: values.new, cwd, model: { provider: model.provider, modelId: model.id } })
    .catch((e: Error) => fail(`Could not create the session: ${e.message}`));
  session = created.id;
}

const app = new App(device, client, info, registry);
await app.open(session, agentRef);
