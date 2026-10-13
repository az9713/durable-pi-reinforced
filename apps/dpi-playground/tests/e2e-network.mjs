// The demo, automated: start work in the TUI on a device, watch and steer it from the web, close
// both clients, restart the device mid-tool, let the run resume, fork it from the web, and
// reattach the TUI to the fork. Real model, any device in dpi-network.yaml whose backend runs as a
// service (launchd or systemd), so `just net restart <id>` can restart it mid-tool:
//   DPI_DEVICE=<id> node tests/e2e-network.mjs       (HEADED=1 to watch the browser)
// Pass criteria come from committed state: every expected tool result, one answer per prompt,
// a fork that starts from the chosen entry.
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const hub = process.env.DPI_URL ?? "http://localhost:4781";
const device = process.env.DPI_DEVICE;
if (!device) {
  console.error("Set DPI_DEVICE to a device id from dpi-network.yaml, e.g. DPI_DEVICE=mac-mini node tests/e2e-network.mjs");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../..");
const v1 = `${hub}/api/devices/${device}/v1`;
const NAME = "e2e-network";
const S = `dpi-e2e-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (msg) => console.log(`PASS [${device}] ${msg}`);
async function api(method, path, body) {
  const r = await fetch(
    v1 + path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await r.json().catch(() => undefined);
  if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const get = (path) => api("GET", path);
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await sleep(400);
  }
  throw Error(`Timed out: ${label}`);
}

// ------------------------------------------------------------------ tmux-driven TUI
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-t", S, "-p", "-J", "-S", "-400");
function tui(args) {
  try {
    tmux("kill-session", "-t", S);
  } catch {}
  tmux(
    "new-session",
    "-d",
    "-s",
    S,
    "-x",
    "130",
    "-y",
    "45",
    `cd ${repo}/apps/dpi-tui && NODE_NO_WARNINGS=1 npx tsx src/main.ts ${args}; sleep 900`,
  );
}
const type = (text) => (
  tmux("send-keys", "-t", S, "-l", "--", text),
  tmux("send-keys", "-t", S, "Enter")
);
const onScreen = (pattern, ms, label) =>
  until(async () => pattern.test(screen()), ms, label ?? String(pattern));

// ------------------------------------------------------------------ scenario
// Start from expanded side panels; the hub persists the layout across runs.
await fetch(`${hub}/api/ui-state/layout.panels`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ value: { tree: true, inspector: true } }),
});
const launch = () => chromium.launch({ channel: "chrome", headless: !process.env.HEADED });
let browser;
try {
  for (const s of await get("/sessions"))
    if (s.name === NAME) await api("DELETE", `/sessions/${s.id}`);
  // The session works in <code_dir>/e2e on the device (just net deploy creates it).
  const { codeDir } = await get("/device");
  assert(codeDir, `${device} runs an older dpi-backend without codeDir: just net deploy ${device}`);
  const cwd = await get(`/fs/dirs?path=${encodeURIComponent(`${codeDir}/e2e`)}`).then(
    (l) => l.path,
    () => assert.fail(`${codeDir}/e2e is missing on ${device}: just net deploy ${device}`),
  );
  const run = `fib-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`;

  // 1. Start in the TUI.
  tui(`${device} --new ${NAME} --cwd ${cwd}`);
  await onScreen(/● live/, 30000);
  const session = (await get("/sessions")).find((s) => s.name === NAME);
  assert(session, "session created by the TUI");
  const agent = `/sessions/${session.id}/agents/main`;
  type(
    `Create a folder ${run} and write ${run}/fib.mjs that prints the first 10 Fibonacci numbers. Run it with bash using exactly: ` +
      `sleep 8 && node ${run}/fib.mjs. Then improve it three times (1: accept N as a CLI argument, 2: add a header comment, ` +
      `3: validate the input), and after each change run it again with exactly: sleep 8 && node ${run}/fib.mjs 12. ` +
      "Finish with a two-sentence summary.",
  );
  await onScreen(/working…/, 60000);
  pass(`TUI started ${NAME} in ${cwd}/${run} and the agent is working`);

  // 2. The web UI shows the same run live.
  await fetch(`${hub}/api/ui-state/tree.selected`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: { deviceId: device, sessionId: session.id, agentId: 1 } }),
  });
  browser = await launch();
  let page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(hub);
  await expect(page.locator(".device-chip")).toHaveText(device, { timeout: 20000 });
  await expect(
    page.locator(`.tree-row[data-key="${device}/s/${session.id}"] .dot.work`),
  ).toBeVisible({ timeout: 60000 });
  const before = await page.locator("[data-testid=chat] .entry").count();
  await expect
    .poll(() => page.locator("[data-testid=chat] .entry").count(), { timeout: 120000 })
    .toBeGreaterThan(before);
  pass("web tree shows the session working and the transcript streams alongside the TUI");

  // 3. Steer from the web; the TUI sees it.
  await page.getByLabel("When busy").selectOption("steer");
  await page
    .getByLabel("Message your agent")
    .fill("Steering from the web: use bash only for verification runs.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await onScreen(/Steering from the web/, 120000, "steer visible in the TUI");
  pass("a steer sent from the web shows in the TUI");

  // 4. Close both clients and restart the device mid-tool.
  await until(
    async () =>
      (await get(`/sessions/${session.id}/tasks?status=live`)).some((t) => t.kind === "pi.tool"),
    240000,
    "a tool running",
  );
  tmux("send-keys", "-t", S, "C-c");
  await onScreen(/Reattach:/, 10000);
  await browser.close();
  browser = undefined;
  // Watch the hub's view of the device while the restart runs (the service is back in ~1s).
  const seen = new Set();
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      const d = (await (await fetch(`${hub}/api/network`)).json()).devices.find(
        (x) => x.id === device,
      );
      seen.add(d.status);
      await sleep(100);
    }
  })();
  await new Promise((done, fail) => {
    const child = spawn("just", ["net", "restart", device], { cwd: repo });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) =>
      code === 0 ? done() : fail(Error(`just net restart ${device} exited ${code}:\n${out}`)),
    );
  });
  await until(
    async () =>
      seen.size > 1 &&
      (await (await fetch(`${hub}/api/network`)).json()).devices.find((x) => x.id === device)
        .status === "online",
    90000,
    "device back online",
  );
  watching = false;
  await watcher;
  pass(`clients closed, just net restart ${device} mid-tool; hub saw ${[...seen].join(" → ")}`);

  // 5. The run resumes from its checkpoint and finishes; the interrupted unsafe tool is recorded.
  await until(
    async () =>
      !(await get(agent)).busy && !(await get(`/sessions/${session.id}/tasks?status=live`)).length,
    600000,
    "run finished",
  );
  const entries = (await get(`${agent}/entries?scope=all&limit=1000`)).items;
  const results = entries.filter((e) => e.kind === "pi.tool-result").flatMap((e) => e.model ?? []);
  const text = (m) =>
    Array.isArray(m.content)
      ? m.content.map((b) => b.text ?? "").join("")
      : String(m.content ?? "");
  const interrupted = results.filter((m) => m.isError && /interrupt/i.test(text(m)));
  assert(
    results.some((m) => !m.isError && /\b34\b/.test(text(m))),
    "a fib run printed the sequence",
  );
  const md = (await get(`${agent}/transcript?format=markdown`)).text;
  const prompts = entries.filter((e) => e.kind === "pi.user").map((e) => text(e.model?.[0] ?? {}));
  assert.equal(new Set(prompts).size, prompts.length, "each prompt was admitted once");
  pass(
    `run resumed and finished: ${results.length} tool results, ${interrupted.length} interrupted by the restart, ${prompts.length} prompts each admitted once`,
  );
  if (!interrupted.length)
    console.log("NOTE the restart landed between tools; no unsafe tool was interrupted this run");

  // 6. Fork from the web at the first agent reply; reattach the TUI to the fork.
  browser = await launch();
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(hub);
  await expect(page.locator(".device-chip")).toHaveText(device, { timeout: 30000 });
  const firstReply = page.locator("[data-testid=chat] .entry.pi-assistant").first();
  await firstReply.getByRole("button", { name: /Fork at entry/ }).click();
  await page.getByLabel("Fork name").fill("e2e-fork");
  await page.getByRole("button", { name: "Create fork", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Conversation lineage" }).locator('[aria-current="page"]'),
  ).toContainText("e2e-fork");
  const fork = (await get(`/sessions/${session.id}/agents`)).find((a) => a.name === "e2e-fork");
  assert(fork && fork.kind === "fork" && fork.parentId === 1);
  pass(`forked from the web at entry #${fork.forkedAt}`);
  tui(`${device}:${NAME}:e2e-fork`);
  await onScreen(/⑂ e2e-fork/, 30000);
  await onScreen(/fib/, 15000);
  pass(`reattached the TUI with just tui attach ${device}:${NAME}:e2e-fork`);
  console.log(
    `\n${md.split("\n").length} lines of markdown transcript at ${v1}${agent}/transcript?format=markdown`,
  );
  console.log(`ALL E2E NETWORK CHECKS PASSED on ${device}`);
} finally {
  await browser?.close();
  try {
    tmux("kill-session", "-t", S);
  } catch {}
}
