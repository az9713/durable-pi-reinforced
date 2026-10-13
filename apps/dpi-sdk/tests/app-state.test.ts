import { test } from "node:test";
import assert from "node:assert/strict";
import { changeState, readState, type AppState } from "../src/app-state.js";

test("App State supports structure changes, nested CRUD, arrays and numeric adjustments", () => {
  let state: AppState = {};
  state = changeState(state, {
    operation: "create",
    path: "/settings",
    value: { enabled: false, retries: 3, tags: [] },
  });
  state = changeState(state, { operation: "update", path: "/settings/enabled", value: true });
  state = changeState(state, { operation: "increment", path: "/settings/retries", value: -1 });
  state = changeState(state, { operation: "create", path: "/settings/tags/-", value: "first" });
  state = changeState(state, {
    operation: "create",
    path: "/settings/tags/-",
    value: { nested: null },
  });
  state = changeState(state, { operation: "delete", path: "/settings/tags/0" });
  assert.deepEqual(readState(state, "/settings"), {
    enabled: true,
    retries: 2,
    tags: [{ nested: null }],
  });
  state = changeState(state, {
    operation: "update",
    path: "/settings/retries",
    value: "unlimited",
  });
  state = changeState(state, { operation: "create", path: "/a~1b~0c", value: 1 });
  assert.equal(readState(state, "/a~1b~0c"), 1);
  assert.throws(() => changeState(state, { operation: "create", path: "/settings", value: {} }));
  assert.throws(() => changeState(state, { operation: "update", path: "/missing", value: 1 }));
  assert.throws(() =>
    changeState(state, { operation: "increment", path: "/settings/retries", value: 1 }),
  );
  assert.throws(() =>
    changeState(state, { operation: "create", path: "/__proto__/polluted", value: true }),
  );
  assert.throws(() => changeState(state, { operation: "update", path: "", value: [] }));
  assert.deepEqual(
    changeState(state, { operation: "update", path: "", value: { newShape: [true, 42] } }),
    { newShape: [true, 42] },
  );
  assert.deepEqual(changeState(state, { operation: "delete", path: "" }), {});
});
