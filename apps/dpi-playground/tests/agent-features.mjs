// Real-model agent features through the hub proxy, against any device in the network:
//   DPI_URL=http://localhost:4781 DPI_DEVICE=local node tests/agent-features.mjs
// Steering, request dedupe, queue withdrawal, busy rejection, read only tools, an owned subagent,
// durable jobs through list_durable_jobs and run_durable_job, compaction and reset/handoff.
import assert from "node:assert/strict";

const hub = process.env.DPI_URL ?? "http://localhost:4781";
const device = process.env.DPI_DEVICE ?? "local";
const v1 = `${hub}/api/devices/${device}/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body, ok = true) {
  const init =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(v1 + path, init);
  const data = await r.json().catch(() => undefined);
  if (ok) assert(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return { status: r.status, data };
}
const get = async (path) => (await call("GET", path)).data;
const post = async (path, body = {}) => (await call("POST", path, body)).data;
async function until(fn, timeout = 180000, label = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(500);
  }
  throw Error(`Timed out waiting for ${label}`);
}

const info = await get("/device");
const model = info.models.find((m) => m.id === info.defaultModel) ?? info.models[0];
const cwd = (await get("/fs/dirs?path=")).dirs[0]?.path;
assert(cwd, "the device has no start dirs");
const session = await post("/sessions", {
  name: `Agent features ${new Date().toISOString().slice(11, 19)}`,
  cwd,
  model: { provider: model.provider, modelId: model.id },
});
console.log("DEVICE", device, "SESSION", session.id, "MODEL", model.id);
const a = `/sessions/${session.id}/agents/main`;
const send = (content, whenBusy = "followUp", requestId = crypto.randomUUID()) =>
  post(`${a}/messages`, { content, whenBusy, requestId });
const liveTasks = () => get(`/sessions/${session.id}/tasks?status=live`);
const idle = () =>
  until(async () => !(await get(a)).busy && !(await liveTasks()).length, 240000, "agent idle");
const state = async () => (await get("/docs/app.shared-state")).value;
const active = async () => (await get(`${a}/entries?scope=active&limit=1000`)).items;

const before = await state();
await send(
  "First run bash with command sleep 8. After that use update_state to increment the counter by 2.",
);
await until(
  async () => (await liveTasks()).some((t) => t.kind === "pi.tool"),
  120000,
  "bash running",
);
const requestId = crypto.randomUUID();
const first = await send("Use update_state to set the goal to Steering demo.", "steer", requestId);
const replay = await send("Use update_state to set the goal to Steering demo.", "steer", requestId);
assert.equal(first.submissionId, replay.submissionId);
const queued = await send(
  "Use update_state to add a note saying This queued input should be withdrawn.",
);
const withdrawn = (await call("DELETE", `${a}/inbox/${queued.submissionId}`)).data;
assert.equal(withdrawn.status, "aborted");
const rejected = await call(
  "POST",
  `${a}/messages`,
  { content: "Do not admit this input", whenBusy: "reject", requestId: crypto.randomUUID() },
  false,
);
assert.equal(rejected.status, 409);
assert.equal(rejected.data.error.code, "busy");
await idle();
let s = await state();
assert.equal(s.goal, "Steering demo");
assert.equal(s.counter, (before.counter ?? 0) + 2);
assert.equal((s.notes ?? []).length, (before.notes ?? []).length);
console.log("PASS steer, queue withdrawal, busy rejection and request deduplication");

await call("PATCH", `${a}/config`, { readOnly: true });
assert.equal((await get(a)).tools.find((t) => t.name === "bash").offered, false);
await send("Which of your tools can change files or run shell commands? Answer in one line.");
await idle();
await call("PATCH", `${a}/config`, { readOnly: false });
assert.equal((await get(a)).tools.find((t) => t.name === "bash").offered, true);
console.log("PASS read only removes the tools that write");

await send(
  "Use subagent to delegate this self-contained task: Reply with the number 42 and use no tools. Then report its answer.",
);
await idle();
assert((await get(`/sessions/${session.id}/agents`)).some((x) => x.kind === "subagent"));
assert(
  (await active()).some(
    (e) =>
      e.kind === "pi.tool-result" && e.model?.some((m) => m.toolName === "subagent" && !m.isError),
  ),
);
console.log("PASS owned subagent");

await send(
  "Call list_durable_jobs, then use run_durable_job to run the workspace-snapshot job with its default inputs. Reply with its task ID.",
);
await idle();
await until(
  async () =>
    Object.values((await get(`${a}/docs/demo.job-runs`)).value.items).some(
      (r) => r.job === "workspace-snapshot" && r.startedBy === "agent" && r.status === "completed",
    ),
  60000,
  "job completed",
);
console.log("PASS durable job through list_durable_jobs and run_durable_job");

const compact = await post(`${a}/compact`, {});
await until(
  async () => !(await liveTasks()).some((t) => t.id === compact.taskId),
  180000,
  "compaction settled",
);
console.log("PASS compaction settles");

await post(`${a}/reset`, {
  note: "Continue from this handoff: the workspace goal remains Steering demo.",
});
s = await state();
assert.equal(s.goal, "Steering demo");
const after = await active();
assert.equal(after[0].kind, "pi.reset");
assert((await get(`${a}/entries?scope=all&limit=1000`)).items.length > after.length);
console.log("PASS reset/handoff preserves state and history");
await call("DELETE", `/sessions/${session.id}`);
console.log(`ALL REAL AGENT FEATURE CHECKS PASSED on ${device}`);
