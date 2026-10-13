// Closing the whole browser mid-tool never stops the agent: the device finishes the run, and a new
// browser process reattaches to the result. Real model, any device:
//   DPI_URL=http://localhost:4781 DPI_DEVICE=local node tests/browser-close.mjs   (HEADED=1 to watch)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");

const hub = process.env.DPI_URL ?? "http://localhost:4781";
const device = process.env.DPI_DEVICE ?? "local";
const v1 = `${hub}/api/devices/${device}/v1`;
const json = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const get = async (path) => (await fetch(v1 + path)).json();

const info = await get("/device");
const model = info.models.find((m) => m.id === info.defaultModel) ?? info.models[0];
const cwd = (await get("/fs/dirs?path=")).dirs[0].path;
const session = await (
  await fetch(
    `${v1}/sessions`,
    json("POST", {
      name: "Browser close",
      cwd,
      model: { provider: model.provider, modelId: model.id },
    }),
  )
).json();
const a = `/sessions/${session.id}/agents/main`;
const target = { deviceId: device, sessionId: session.id, agentId: 1 };
await fetch(`${hub}/api/ui-state/tree.selected`, json("PUT", { value: target }));
console.log("DEVICE", device, "SESSION", session.id);

// Start from expanded side panels; the hub persists the layout across runs.
await fetch(`${hub}/api/ui-state/layout.panels`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ value: { tree: true, inspector: true } }),
});
const launch = () => chromium.launch({ channel: "chrome", headless: !process.env.HEADED });
let browser = await launch();
let page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
try {
  await page.goto(hub);
  await expect(page.locator(".device-chip")).toHaveText(device, { timeout: 20000 });
  await expect(page.locator(".model-button")).toBeVisible();
  // Model picker and a persisted thinking level.
  const other = info.models.find((m) => m.id !== model.id && /flash|luna/i.test(m.name)) ?? model;
  await page.locator(".model-button").click();
  await page.getByLabel("Search models").fill(other.name);
  await page.locator(".model-list button").filter({ hasText: other.name }).first().click();
  await expect(page.locator(".model-modal")).toHaveCount(0);
  await expect(page.locator(".model-button")).toContainText(other.name);
  await page.getByLabel("Thinking level").selectOption("minimal");
  await expect(page.locator(".toast")).toContainText("Thinking minimal");
  await page.reload();
  await expect(page.getByLabel("Thinking level")).toHaveValue("minimal", { timeout: 20000 });

  await page
    .getByLabel("Message your agent")
    .fill(
      'Run bash with command sleep 15; printf "FULL_BROWSER_QUIT_OK\\n". When done, reply Browser quit verified.',
    );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await get(`/sessions/${session.id}/tasks?status=live`)).some((t) => t.kind === "pi.tool"),
      {
        timeout: 120000,
      },
    )
    .toBe(true);
  await browser.close();
  console.log("CLOSED CHROME PROCESS");
  await expect.poll(async () => !(await get(a)).busy, { timeout: 180000 }).toBe(true);
  const entries = (await get(`${a}/entries?scope=active&limit=1000`)).items;
  expect(JSON.stringify(entries)).toContain("FULL_BROWSER_QUIT_OK");

  browser = await launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(hub);
  await expect(page.locator(".markdown").filter({ hasText: "Browser quit verified" })).toBeVisible({
    timeout: 20000,
  });
  await page.screenshot({ path: "/tmp/dpi-browser-reopened.png" });
  console.log(
    `PASS on ${device}: browser quit mid-tool, the device finished the run, a new browser reattached`,
  );
} finally {
  await browser.close();
  await fetch(`${v1}/sessions/${session.id}`, { method: "DELETE" });
}
