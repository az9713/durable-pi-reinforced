import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_START_DIR, parseNetworkConfig, syncConfigToRegistry } from "../src/node/config.js";
import { NetworkRegistry } from "../src/node/registry.js";

test("dpi-network.example.yaml parses: defaults plus the local device", () => {
  const config = parseNetworkConfig(readFileSync(new URL("../../../dpi-network.example.yaml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(config.devices), ["local"]);
  assert.equal(config.devices.local.url, "http://127.0.0.1:4780");
  assert.deepEqual(config.devices.local.startDirs, [DEFAULT_START_DIR]);
  for (const d of Object.values(config.devices)) {
    assert.ok(["local", "ssh", "exe-dev", "url"].includes(d.kind));
    assert.ok(d.port > 0 && d.node > 0 && d.codeDir && d.homeDir);
    if (d.kind === "exe-dev") assert.equal(d.ssh, `${d.vm}.exe.xyz`);
  }
});

test("validation rejects bad kinds, missing fields and bad ids; exe-dev derives url and ssh", () => {
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: cloud\n    url: http://x"), /kind must be one of/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    url: http://x\n    service: launchd"), /\.ssh must be/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: u@h\n    url: http://x"), /service is required/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: u@h\n    service: cron\n    url: http://x"), /launchd or systemd/);
  assert.throws(() => parseNetworkConfig("devices:\n  Bad_Id:\n    kind: url\n    url: http://x"), /id must match/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: url"), /url must be/);
  const c = parseNetworkConfig("defaults:\n  port: 5000\n  start_dirs: ['~/w']\ndevices:\n  vm:\n    kind: exe-dev\n    vm: my-vm-1\n  here:\n    kind: local");
  assert.equal(c.devices.vm.url, "https://my-vm-1.exe.xyz");
  assert.equal(c.devices.vm.ssh, "my-vm-1.exe.xyz");
  assert.equal(c.devices.vm.service, "systemd");
  assert.equal(c.devices.here.url, "http://127.0.0.1:5000");
  assert.deepEqual(c.devices.here.startDirs, ["~/w"]);
  assert.deepEqual(parseNetworkConfig("devices:\n  a:\n    kind: local").devices.a.startDirs, [DEFAULT_START_DIR]);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    roots: ['~']"), /renamed to "start_dirs"/);
  // host defaults by kind; env merges defaults and device and refuses managed or duplicate keys.
  const e = parseNetworkConfig(
    "defaults:\n  env_keys: [OPENROUTER_API_KEY]\n  env: { DPI_PROVIDER: openrouter, LOG_LEVEL: info }\ndevices:\n  a:\n    kind: local\n    env: { DPI_PROVIDER: faux }\n  b:\n    kind: url\n    url: http://b\n    host: 10.0.0.5",
  );
  assert.equal(e.devices.a.host, "127.0.0.1");
  assert.equal(e.devices.b.host, "10.0.0.5");
  assert.deepEqual(e.devices.a.env, { DPI_PROVIDER: "faux", LOG_LEVEL: "info" });
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env: { DPI_PORT: 1 }"), /own setting/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [X]\n    env: { X: 1 }"), /also in env_keys/);
});

test("sync upserts config devices, keeps UI devices and prunes removed config devices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-cfg-"));
  const reg = new NetworkRegistry(join(dir, "n.sqlite"));
  try {
    reg.upsert({ id: "adhoc", url: "https://a.test", source: "ui" });
    syncConfigToRegistry(parseNetworkConfig("devices:\n  one:\n    kind: url\n    url: http://one\n  two:\n    kind: url\n    url: http://two"), reg);
    assert.deepEqual(reg.list().map((d) => [d.id, d.source]).sort(), [["adhoc", "ui"], ["one", "config"], ["two", "config"]]);
    syncConfigToRegistry(parseNetworkConfig("devices:\n  one:\n    kind: url\n    url: http://one"), reg);
    assert.deepEqual(reg.list().map((d) => d.id).sort(), ["adhoc", "one"]);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
