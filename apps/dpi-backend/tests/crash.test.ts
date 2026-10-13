// Crash tests: SIGKILL the backend while a tool or job step runs, restart it, and check what happened to the effect.
// Run in WSL2, Linux or macOS: the cases need bash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import type { TaskNode } from "../../dpi-sdk/src/api.js";
import { once } from "../src/extensions.js";
import { lockFile } from "../src/store.js";
import { bootServer, delay, faux, newToken, tempStore, until } from "./helpers.js";

async function crashSession(name: string) {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const client = new DpiClient(server.base, token);
  const done = async () => {
    await server.stop();
    await t.cleanup();
  };
  const s = await client.createSession({ name, cwd: t.work, model: faux }).catch(async (e) => {
    await done();
    throw e;
  });
  const main = client.agent(s.id, "main");
  const session = client.session(s.id);
  const liveTool = async (label: string) =>
    ((await session.tasks("live")) as unknown as TaskNode[]).some((n) => n.label === label);
  const transcript = async () => (await main.transcript("markdown")).text as string;
  return { t, server, client, main, session, liveTool, transcript, done };
}

test("the built-in bash, read, write and edit tools report their replay policy", async () => {
  const c = await crashSession("Policy");
  try {
    const tools = Object.fromEntries((await c.main.get()).tools.map((t) => [t.name, t.replay]));
    console.log("replay policies:", JSON.stringify({ bash: tools.bash, read: tools.read, write: tools.write, edit: tools.edit }));
    assert.equal(tools.bash, "unsafe");
  } finally {
    await c.done();
  }
});

test("bash cut off by SIGKILL comes back interrupted and does not run again", async () => {
  const c = await crashSession("Bash crash");
  const runs = join(c.t.work, "runs.txt");
  const lines = (word: string) => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter((l) => l === word).length : 0);
  try {
    await c.main.send("!echo start >> runs.txt; sleep 5; echo end >> runs.txt");
    await until(async () => lines("start") === 1, 15000, "bash start");
    await c.server.stop("SIGKILL");
    await c.server.start();
    await until(async () => (await c.transcript()).includes("was interrupted"), 20000, "interrupted result");
    await delay(6000);
    assert.equal(lines("start"), 1);
    // The shell child may outlive the backend and finish on its own: an effect nobody reports.
    console.log(`bash child finished after the kill: ${lines("end") === 1}`);
  } finally {
    await c.done();
  }
});

test("an unsafe repo tool cut off by SIGKILL comes back interrupted and never pages", async () => {
  const c = await crashSession("Page crash");
  try {
    await c.main.send("page: first");
    await until(() => c.liveTool("ping_on_call_engineer"), 15000, "page call");
    await c.server.stop("SIGKILL"); // inside the 1.5 s pause before the page is recorded
    await c.server.start();
    await until(async () => (await c.transcript()).includes("was interrupted"), 20000, "interrupted result");
    // The first call never recorded a page, so a second call pages.
    await c.main.send("page: second", "followUp", undefined, 20000);
    assert.match(await c.transcript(), /Paged the on-call engineer/);
  } finally {
    await c.done();
  }
});

test("a safe repo tool cut off by SIGKILL applies its App State change once", async () => {
  const c = await crashSession("State crash");
  const counter = async () => ((await c.client.deviceDoc<{ counter: number }>("app.shared-state")).value.counter);
  try {
    const before = await counter();
    await c.main.send("state: increment /counter 1");
    await until(() => c.liveTool("update_state"), 15000, "update_state call").catch(() => {});
    await c.server.stop("SIGKILL");
    await c.server.start();
    await until(async () => (await c.session.tasks("live")).length === 0, 20000, "settled tool");
    assert.equal(await counter(), before + 1);
  } finally {
    await c.done();
  }
});

test("a job's subagent step cut off by SIGKILL admits its prompt once", async () => {
  const c = await crashSession("Job crash");
  try {
    const { taskId } = await c.main.demo<{ taskId: number }>("jobs", { job: "release-check", input: { commits: 2 } });
    const run = async () => (await c.main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => (await run())?.childConversationId !== undefined, 20000, "gather subagent");
    await c.server.stop("SIGKILL");
    await c.server.start();
    await until(async () => (await run())?.approval === "pending", 30000, "gather done after restart");
    const child = c.client.agent((await c.main.get()).sessionId, (await run()).childConversationId!);
    const prompts = (await child.entries({ scope: "all" })).items.filter((e) => e.kind === "pi.user");
    assert.equal(prompts.length, 1);
  } finally {
    await c.done();
  }
});

test("stuck reports nothing on an idle session; backup copies the database and the session keeps working", async () => {
  const t = await tempStore();
  process.env.DPI_BACKUP_DIR = join(t.root, "backups");
  const store = await t.open();
  try {
    const s = await store.create({ name: "Backup", cwd: t.work, model: faux });
    const row = store.row(s.id);
    assert.deepEqual(await store.stuck(store.harness(row)), { blocked: [], queued: [] });
    const { backup } = await store.backup(row);
    assert.ok(existsSync(join(backup, "agent.sqlite")));
    const { h, c } = await store.resolveAgent(s.id, "main");
    const sub = await store.send(c, { content: "after backup", requestId: "after-backup" });
    assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
  } finally {
    delete process.env.DPI_BACKUP_DIR;
    await store.close();
    await t.cleanup();
  }
});

test("a lock from another boot is stale even when its PID is alive", { skip: !existsSync("/proc/sys/kernel/random/boot_id") }, async () => {
  const t = await tempStore();
  try {
    mkdirSync(t.root, { recursive: true });
    const path = join(t.root, "x.sqlite.lock");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    writeFileSync(path, `${process.ppid} ${boot}`);
    assert.throws(() => lockFile(path), /already owned/);
    writeFileSync(path, `${process.ppid} 00000000-0000-0000-0000-000000000000`);
    const unlock = lockFile(path);
    unlock();
    assert.equal(existsSync(path), false);
  } finally {
    await t.cleanup();
  }
});

test("once() returns the stored result and never runs the effect twice", async () => {
  const docs = new Map<number, { applied: boolean; result: string }>();
  const api = {
    taskId: 7,
    commit: async (fn: (tx: unknown) => unknown) =>
      fn({ doc: async (_d: unknown, id: number) => docs.get(id) ?? (docs.set(id, { applied: false, result: "" }), docs.get(id)) }),
  } as never;
  let calls = 0;
  const effect = async (key: string) => (calls++, `sent with ${key}`);
  assert.equal(await once(api, {} as never, "s1", effect), "sent with s1:7");
  assert.equal(await once(api, {} as never, "s1", effect), "sent with s1:7");
  assert.equal(calls, 1);
});
