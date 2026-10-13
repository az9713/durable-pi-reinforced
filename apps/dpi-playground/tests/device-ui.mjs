// The web UI feature suite against one real device through the running hub (real model):
//   DPI_URL=http://localhost:4781 DPI_DEVICE=<id> node tests/device-ui.mjs      (HEADED=1 to watch)
// Creates a session on the device, exercises every inspector tab, fork/rename/new agent,
// compact/reset/history, then archives the session.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");

const hub = process.env.DPI_URL ?? "http://localhost:4781";
const device = process.env.DPI_DEVICE ?? "local";
const v1 = `${hub}/api/devices/${device}/v1`;
const get = async (path) => (await fetch(v1 + path)).json();
const name = `UI suite ${new Date().toISOString().slice(11, 19)}`;
const pass = (msg) => console.log(`PASS [${device}] ${msg}`);

// Start from expanded side panels; the hub persists the layout across runs.
await fetch(`${hub}/api/ui-state/layout.panels`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ value: { tree: true, inspector: true } }),
});
const browser = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED });
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 1000 } })
).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const chat = () => page.getByTestId("chat");
const tab = (label) => page.getByRole("tab", { name: label, exact: true }).click();
const idle = () =>
  expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeDisabled({
    timeout: 180000,
  });
let sessionId;
try {
  await page.goto(hub);
  await expect(page.locator(`.tree-row[data-key="${device}"] .dot.on`)).toBeVisible({
    timeout: 20000,
  });
  pass("device online in the tree");

  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByLabel("Device", { exact: true }).selectOption(device);
  await page.getByLabel("Session name").fill(name);
  await expect(page.getByLabel("Working directory", { exact: true })).not.toHaveValue("", {
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.locator(".device-chip")).toHaveText(device);
  await expect(page.getByText("A conversation with continuity.")).toBeVisible({ timeout: 20000 });
  sessionId = (await get("/sessions")).find((s) => s.name === name)?.id;
  pass(`session created on ${device} via the dir browser`);

  await page.getByLabel("Message your agent").fill("Reply with exactly: UI OK");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    chat()
      .locator(".markdown")
      .filter({ hasText: /^\s*UI OK\s*$/ }),
  ).toBeVisible({ timeout: 120000 });
  await idle();
  pass("real-model turn streams into the transcript");

  await page
    .getByLabel("Message your agent")
    .fill("Run the bash command `pwd` once and reply with its output only.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat().locator(".tool-call").filter({ hasText: "bash" }).first()).toContainText(
    "Done",
    { timeout: 120000 },
  );
  await idle();
  pass("tool call renders with its result");

  // Session tab: model picker + thinking level persist on the device.
  const info = await get("/device");
  const other =
    info.models.find((m) => m.id !== info.defaultModel && /flash|luna/i.test(m.name)) ??
    info.models[0];
  await page.locator(".model-button").click();
  await page.getByLabel("Search models").fill(other.name);
  await page.locator(".model-list button").filter({ hasText: other.name }).first().click();
  await expect(page.locator(".model-button")).toContainText(other.name);
  await page.getByLabel("Thinking level").selectOption("minimal");
  await expect(page.locator(".toast")).toContainText("Thinking minimal");
  await page.reload();
  await expect(page.getByLabel("Thinking level")).toHaveValue("minimal", { timeout: 20000 });
  await expect(page.locator(".usage-breakdown")).toBeVisible();
  pass("model picker, thinking level and usage table");

  // State tab (device-wide App State).
  await tab("State");
  const counter = page.getByRole("spinbutton", { name: "Value of /counter", exact: true });
  const before = Number(await counter.inputValue());
  await page.getByRole("button", { name: "Increment /counter", exact: true }).click();
  await expect(counter).toHaveValue(String(before + 1));
  const json = page.getByLabel("App State JSON");
  const current = JSON.parse(await json.inputValue());
  await json.fill(JSON.stringify({ ...current, uiSuite: `${device} ${Date.now()}` }, null, 2));
  await page.getByRole("button", { name: "Save JSON" }).click();
  await expect(page.locator(".toast")).toContainText("Shared App State saved.");
  pass("App State live controls and JSON save");

  // Tasks tab: durable jobs run as cards in the chat; stop one, approve one, runtime details.
  await tab("Tasks");
  await page.getByRole("button", { name: "Run Change watch" }).click();
  const watching = page.locator(".job-run").filter({ hasText: "Change watch" }).first();
  await expect(watching.locator(".job-stepper .ph-running")).toBeVisible({ timeout: 20000 });
  await watching.getByRole("button", { name: "Stop" }).click();
  await expect(watching).toContainText("Stopped", { timeout: 20000 });
  await page.getByRole("button", { name: "Run Release check" }).click();
  const release = page.locator(".job-run").filter({ hasText: "Release check" }).first();
  await expect(release.getByRole("button", { name: /Approve/ })).toBeVisible({ timeout: 120000 });
  await expect(release.locator(".job-steps .k-tool")).not.toHaveCount(0);
  await release.getByRole("button", { name: /Approve/ }).click();
  await expect(release).toContainText("Completed", { timeout: 30000 });
  await page.locator("summary").filter({ hasText: "Runtime details" }).click();
  await expect(
    page
      .locator(".tasks-panel details.raw details.raw summary")
      .filter({ hasText: /#\d+/ })
      .first(),
  ).toBeVisible({ timeout: 15000 });
  pass("durable jobs, stop job, approval and runtime details");

  // Tools tab: read only disables the tools that write, then restores them.
  await tab("Tools");
  await page.getByRole("switch", { name: "Read only" }).click();
  await expect(page.getByRole("switch", { name: "Read only" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".tool-row.disabled").first()).toContainText("disabled");
  await page.getByRole("switch", { name: "Read only" }).click();
  await expect(page.getByRole("switch", { name: "Read only" })).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".tool-row.disabled")).toHaveCount(0);
  pass("read only toggle");

  // Fork, picker, renames, new agent.
  await chat()
    .locator(".entry.pi-assistant")
    .first()
    .getByRole("button", { name: /Fork at entry/ })
    .click();
  await page.getByLabel("Fork name").fill("suite-fork");
  await page.getByRole("button", { name: "Create fork", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Conversation lineage" }).locator('[aria-current="page"]'),
  ).toContainText("suite-fork");
  await expect(page.locator(".tree-row.agent.sel")).toContainText("suite-fork");
  await page.getByRole("button", { name: "Browse conversations" }).click();
  await page.locator(".conversation-choice").filter({ hasText: "Main" }).first().click();
  await page.getByRole("button", { name: "Rename agent", exact: true }).click();
  await page.getByLabel("Agent name").fill("Lead");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".tree-row.agent.sel")).toContainText("Lead");
  await tab("Session");
  await page.getByRole("button", { name: "Rename session", exact: true }).click();
  await page.getByLabel("Session name").fill(`${name} renamed`);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.locator(".tree-row.session").filter({ hasText: `${name} renamed` }),
  ).toBeVisible();
  pass("fork at an entry, conversation picker, rename agent and session");

  // Slash commands: /compact, /reset with a handoff note.
  const composer = page.getByLabel("Message your agent");
  await composer.fill("/compact");
  await composer.press("Enter");
  await expect(page.locator(".toast")).toContainText("Compaction requested");
  await expect
    .poll(async () => (await get(`/sessions/${sessionId}/tasks?status=live`)).length, {
      timeout: 180000,
    })
    .toBe(0);
  await composer.fill("/reset Continue from the UI suite handoff.");
  await composer.press("Enter");
  await expect(
    chat()
      .locator(".markdown")
      .filter({ hasText: /^\s*UI OK\s*$/ }),
  ).toHaveCount(0, { timeout: 15000 });
  pass("slash commands /compact and /reset");

  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(page.getByText("A conversation with continuity.")).toBeVisible({ timeout: 15000 });
  pass("new agent");

  expect(errors).toEqual([]);
  console.log(`ALL DEVICE UI CHECKS PASSED on ${device}`);
} catch (e) {
  await page.screenshot({ path: `/tmp/dpi-device-ui-${device}.png` }).catch(() => {});
  throw e;
} finally {
  await browser.close();
  if (sessionId) await fetch(`${v1}/sessions/${sessionId}`, { method: "DELETE" });
}
