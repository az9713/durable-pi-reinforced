import { test } from "node:test";
import assert from "node:assert/strict";
import { faux, tempStore } from "./helpers.js";

test("Shared App State persists across reload and is current across forks and sessions", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const session = await store.create({ name: "State", cwd: t.work, model: faux });
    const main = await store.resolveAgent(session.id, "main");
    await store.demoState(main.c, { operation: "update", path: "", value: { custom: { count: 4, ready: false } } });
    const entry = (await store.activeEntries(main.c)).at(-1)!;
    await store.demoState(main.c, { operation: "delete", path: "/custom/ready" });
    await store.demoState(main.c, { operation: "increment", path: "/custom/count", value: -2 });
    const fork = await store.fork(main.row, main.c, { entryId: entry.id });
    assert.equal(fork.kind, "fork");
    assert.deepEqual((await store.deviceDoc("app.shared-state")).value, { custom: { count: 2 } });
    const other = await store.create({ name: "Other agent", cwd: t.work, model: faux });
    const otherMain = await store.resolveAgent(other.id, "main");
    await store.demoState(otherMain.c, { operation: "increment", path: "/custom/count", value: 1 });
    assert.deepEqual((await store.deviceDoc("app.shared-state")).value, { custom: { count: 3 } });
    const revision = (await store.shared.snapshot()).revision;
    await store.shared.change({ operation: "increment", path: "/custom/count", value: 1 }, "repeatable-tool");
    await store.shared.change({ operation: "increment", path: "/custom/count", value: 1 }, "repeatable-tool");
    assert.deepEqual((await store.deviceDoc("app.shared-state")).value, { custom: { count: 4 } });
    await assert.rejects(() => store.shared.change({ operation: "update", path: "", value: {} }, undefined, revision));
    await store.close();
    store = await t.open();
    assert.deepEqual((await store.deviceDoc("app.shared-state")).value, { custom: { count: 4 } });
  } finally {
    await store.close();
    await t.cleanup();
  }
});
