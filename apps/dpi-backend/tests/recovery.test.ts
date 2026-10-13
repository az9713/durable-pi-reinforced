import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("SIGKILL restart resumes a durable job from its checkpoint with no client attached", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Crash recovery", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: 4, interval_seconds: 2 } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => ((await run())?.phases[1].progress?.done ?? 0) >= 1, 15000, "first check");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await run())?.status === "completed", 30000, "completion after SIGKILL");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.equal(done.phases[1].steps.filter((s) => s.kind === "checkpoint" && s.status === "done").length, 4);
    const history = await main.entries({ scope: "all" });
    assert.equal(history.items.filter((e) => e.kind === "demo.job").length, 1);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
