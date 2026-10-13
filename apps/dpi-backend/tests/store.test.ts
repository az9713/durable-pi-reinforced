import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "../src/store.js";
import { JOB_RUNS_DOC, type JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { faux, tempStore, until } from "./helpers.js";

const jobs = async (store: Store, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return (await store.agentDoc(h, c, JOB_RUNS_DOC)) as JobRunsDoc;
};
const startJob = async (store: Store, session: string, job: string, input: Record<string, unknown> = {}) => {
  const m = await store.resolveAgent(session, "main");
  return (await store.startJob(m.row, m.h, m.c, { job, input })).taskId;
};

test("sessions, browse, names, forks, jobs, restart recovery, approval, interruption, archive", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const start = await store.browse("");
    assert.deepEqual(start.dirs.map((d) => d.path), [t.work]);
    // A missing start dir is created when the store opens.
    const missingStart = join(t.root, "fresh", "start");
    const other = await (await import("../src/store.js")).Store.open({ ...t.options, dataDir: join(t.root, "data2"), startDirs: [missingStart] });
    assert.ok(existsSync(missingStart));
    await other.close();
    const listing = await store.browse(t.work);
    assert.deepEqual(listing.dirs.map((d) => d.name), ["project"]);
    await assert.rejects(() => store.browse(join(t.work, "missing")), /Not a directory/);
    await assert.rejects(() => store.create({ name: "Bad", cwd: join(t.work, "missing"), model: faux }), /existing folder/);
    await assert.rejects(() => store.create({ name: "Bad", cwd: t.work, model: { provider: "x", modelId: "y" } }), /Unknown model/);

    const session = await store.create({ name: "Test", cwd: "project/nested", model: faux });
    assert.equal(session.cwd, join(t.work, "project", "nested"));
    assert.ok(session.dbPath.startsWith(join(t.options.dataDir, "sessions")));
    assert.equal(store.resolveSession("test").id, session.id);
    assert.deepEqual(session.agents.map((a) => [a.id, a.name, a.kind]), [[1, "Main", "root"]]);
    const db = new DatabaseSync(store.catalogPath);
    assert.equal((db.prepare("SELECT count(*) as n FROM sessions").get() as { n: number }).n, 1);
    db.close();

    // App State changes append an entry; a fork at that entry sees the current shared state.
    const main = await store.resolveAgent(session.id, "main");
    await store.demoState(main.c, { increment: true });
    const entry = (await store.activeEntries(main.c)).at(-1)!;
    await store.demoState(main.c, { increment: true });
    const fork = await store.fork(main.row, main.c, { entryId: entry.id, name: "alt approach" });
    assert.equal(fork.kind, "fork");
    assert.equal(fork.parentId, 1);
    assert.equal((await store.resolveAgent("Test", "alt approach")).c.id, fork.id);
    assert.equal(((await store.deviceDoc("app.shared-state")).value as { counter: number }).counter, 2);

    // A durable job survives a restart: change-watch resumes its watch phase from the last checkpoint.
    const watch = await startJob(store, session.id, "change-watch", { checks: 3, interval_seconds: 2 });
    await until(async () => ((await jobs(store, session.id)).items[watch]?.phases[1].progress?.done ?? 0) >= 1, 15000, "first check");
    await store.close();
    store = await t.open();
    assert.equal(store.list()[0].id, session.id);
    await until(async () => (await jobs(store, session.id)).items[watch]?.status === "completed", 30000, "watch completion");
    let run = (await jobs(store, session.id)).items[watch];
    assert.deepEqual(run.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.equal(run.phases[1].steps.filter((s) => s.kind === "checkpoint").length, 3);
    assert.equal((((await store.deviceDoc("app.shared-state")).value as { jobs: Record<string, { run: number }> }).jobs["change-watch"]).run, 1);

    // The run record names the job and its phase on the task itself.
    let m = await store.resolveAgent(session.id, "main");
    const snapshot = await startJob(store, session.id, "workspace-snapshot");
    await until(async () => (await store.liveTasks(m.h)).some((t) => t.id === snapshot && t.label === "Workspace snapshot #1"), 10000, "job label");
    await until(async () => (await jobs(store, session.id)).items[snapshot]?.status === "completed", 20000, "snapshot");
    run = (await jobs(store, session.id)).items[snapshot];
    assert.ok(run.phases[0].steps.some((s) => s.kind === "command" && s.label.startsWith("git status")));
    assert.match(run.result ?? "", /matches run #1/);
    await assert.rejects(() => startJob(store, session.id, "nope"), /job must be one of/);
    await assert.rejects(() => startJob(store, session.id, "change-watch", { checks: 99 }), /checks must be 2 to 20/);

    // Release check: a subagent's bash call becomes a step; the approval waits across a restart, then publishes.
    const release = await startJob(store, session.id, "release-check");
    await until(async () => (await jobs(store, session.id)).items[release]?.approval === "pending", 20000, "approval");
    run = (await jobs(store, session.id)).items[release];
    assert.ok(run.phases[1].steps.some((s) => s.kind === "tool" && s.label === "bash" && s.status === "done"));
    assert.ok(run.childConversationId);
    await store.close();
    store = await t.open();
    m = await store.resolveAgent(session.id, "main");
    assert.equal((await jobs(store, session.id)).items[release].approval, "pending");
    await store.approveJob(m.c, release, true);
    await assert.rejects(() => store.approveJob(m.c, release, true), /No pending approval/);
    await until(async () => (await jobs(store, session.id)).items[release]?.status === "completed", 20000, "release published");

    // Interrupt stops foreground work only; background=true also stops runs the conversation owns.
    const bg = await startJob(store, session.id, "change-watch", { checks: 20, interval_seconds: 60 });
    await until(async () => (await jobs(store, session.id)).items[bg]?.phase === "watch", 15000, "watching");
    await store.abort(m.c, false);
    assert.equal((await jobs(store, session.id)).items[bg].status, "running");
    await store.abort(m.c, true);
    run = (await jobs(store, session.id)).items[bg];
    assert.equal(run.status, "aborted");
    assert.deepEqual(run.phases.map((p) => p.status), ["done", "aborted", "skipped"]);

    // Compaction thresholds are per session, validated, and persisted.
    assert.deepEqual(store.compactionOf(session.id), { enabled: true, reserveTokens: 16384, backgroundTokens: 32768, keepRecentTokens: 2000 });
    store.setCompaction(m.row, { reserveTokens: 8000, backgroundTokens: 4000 });
    assert.throws(() => store.setCompaction(m.row, { reserveTokens: 10 }), /reserveTokens must be/);
    assert.equal((await store.tree()).sessions[0].compaction?.reserveTokens, 8000);

    // Reset keeps stored history; a new agent copies Main's config.
    await store.reset(m.c);
    assert.ok((await store.entries(m.c, undefined, 100)).items.length > 1);
    const fresh = await store.createAgent(m.row, { name: "reviewer" });
    assert.equal(fresh.kind, "root");
    assert.equal((await store.resolveAgent(session.id, "Reviewer")).c.id, fresh.id);
    const tree = await store.tree();
    // The release check's subagent is listed under its job like any subagent.
    assert.deepEqual(
      tree.sessions[0].agents.map((a) => a.name.replace(/#\d+/, "#n")).sort(),
      ["Main", "Subagent #n", "alt approach", "reviewer"],
    );

    // Archive moves files and removes the catalog row.
    const { archived } = await store.archive(store.row(session.id));
    assert.ok(existsSync(join(archived, "agent.sqlite")));
    assert.equal(store.list().length, 0);
    assert.throws(() => store.resolveSession("Test"), /No session/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("start_session: an agent starts an independent session, once per tool call", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const parent = await store.create({ name: "Parent", cwd: "project", model: faux, thinkingLevel: "minimal" });
    const { h, c } = await store.resolveAgent(parent.id, "main");
    const sent = await store.send(c, { content: "spawn: Child | hello child", requestId: "spawn-1" });
    const answer = await store.settled(h, sent.id as number, 15000);
    assert.equal(answer.status, "done");

    // Relative cwd resolves against the parent's folder; model and thinking level come from the parent.
    const child = store.list().find((r) => r.name === "Child");
    assert.ok(child, "Child session exists");
    assert.equal(child.cwd, join(t.work, "project"));
    assert.equal(child.model, faux.modelId);
    const childMain = await store.resolveAgent(child.id, "main");
    assert.equal((await store.agentDetail(child, childMain.c)).config.thinkingLevel, "minimal");
    await until(async () => (await store.preview(child, 1))?.includes("Echo: hello child") ?? false, 15000, "child reply");

    // The spawn tool records its key with the session, so a replayed call finds the same session and prompt.
    const tool = (await store.agentDetail(store.resolveSession(parent.id), c)).tools.find((x) => x.name === "start_session");
    assert.ok(tool?.parameters, "tool parameters are exposed");
    const first = await store.spawnSession({ key: "k1", name: "Idle", cwd: t.work, model: faux });
    const again = await store.spawnSession({ key: "k1", name: "Idle", cwd: t.work, model: faux });
    assert.equal(first.session.id, again.session.id);
    assert.equal(first.submissionId, undefined, "no prompt by default");
    const prompted = await store.spawnSession({ key: "k2", name: "Prompted", cwd: t.work, model: faux, prompt: "hi" });
    const replayed = await store.spawnSession({ key: "k2", name: "Prompted", cwd: t.work, model: faux, prompt: "hi" });
    assert.equal(prompted.submissionId, replayed.submissionId, "the first prompt is admitted once");
    assert.equal(store.list().filter((r) => r.name === "Idle" || r.name === "Prompted").length, 2);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("custom extensions: jev-damage-control blocks rm -rf only while on; system-prompts renders the checked prompts", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await mkdir(join(t.work, "doomed"));
    const session = await store.create({ name: "Ext", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(session.id, "main");
    let n = 0;
    const turn = async (content: string) => {
      const submission = await store.send(c, { content, requestId: `ext-${++n}` });
      assert.equal((await store.settled(h, submission.id as number, 20000)).status, "done");
    };
    const systemText = async () =>
      JSON.stringify((await store.entries(c, undefined, 500)).items.filter((e) => e.kind === "pi.system").slice(0, 1));

    let ext = await store.extensionsOf(row, c);
    assert.deepEqual(ext.extensions.map((e) => [e.name, e.enabled]), [["system-prompts", false], ["jev-damage-control", false]]);
    assert.deepEqual(ext.builtIn.sort(), ["coding-tools", "playground"]);
    assert.deepEqual(ext.extensions[0].prompts?.map((p) => [p.id, p.enabled]), [["smart_ass_opus_fix.md", true], ["one_sentence.md", false]]);

    // jev-damage-control (offline rules under the faux provider) blocks the delete; turned off, it runs.
    await store.setExtension(row, c, { name: "jev-damage-control", enabled: true });
    await turn("!rm -rf doomed");
    assert.ok(existsSync(join(t.work, "doomed")));
    assert.match(JSON.stringify((await store.entries(c, undefined, 5)).items), /jev-damage-control blocked this command/);
    await turn("!ls");
    assert.match(JSON.stringify((await store.entries(c, undefined, 5)).items), /doomed/);
    ext = await store.setExtension(row, c, { name: "jev-damage-control", enabled: false });
    assert.equal(ext.extensions[1].enabled, false);
    await turn("!rm -rf doomed");
    assert.ok(!existsSync(join(t.work, "doomed")));

    // system-prompts: the checked prompts join the system prompt from the next request.
    await store.setExtension(row, c, { name: "system-prompts", enabled: true });
    await turn("hello");
    assert.match(await systemText(), /Clear, Concise, Actionable Communication/);
    await store.setExtension(row, c, { prompt: "smart_ass_opus_fix.md", enabled: false });
    await store.setExtension(row, c, { prompt: "one_sentence.md", enabled: true });
    await turn("hello again");
    assert.match(await systemText(), /One Sentence/);
    assert.doesNotMatch(await systemText(), /Clear, Concise, Actionable Communication/);
    // Extensions stack: turning one on keeps the other on.
    ext = await store.setExtension(row, c, { name: "jev-damage-control", enabled: true });
    assert.deepEqual(ext.extensions.map((e) => [e.name, e.enabled]), [["system-prompts", true], ["jev-damage-control", true]]);
    assert.deepEqual(ext.builtIn, ["coding-tools", "playground"]);
    await mkdir(join(t.work, "doomed"));
    await turn("!rm -rf doomed");
    assert.ok(existsSync(join(t.work, "doomed")));
    ext = await store.setExtension(row, c, { name: "system-prompts", enabled: false });
    assert.deepEqual(ext.extensions.map((e) => e.enabled), [false, true]);
    await assert.rejects(() => store.setExtension(row, c, { name: "nope", enabled: true }), /Unknown extension/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("read only: the agent is offered only tools that read; turning it off restores them", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await mkdir(join(t.work, "kept"));
    const session = await store.create({ name: "RO", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(session.id, "main");
    const offered = async () => (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok((await offered()).includes("bash"));
    assert.equal((await store.agentDetail(row, c)).config.readOnly, false);

    await store.configure(row, c, { readOnly: true });
    const detail = await store.agentDetail(row, c);
    assert.equal(detail.config.readOnly, true);
    assert.deepEqual(
      detail.tools.filter((x) => !x.offered).map((x) => x.name).sort(),
      detail.tools.filter((x) => x.writes).map((x) => x.name).sort(),
    );
    assert.ok((await offered()).includes("read") && (await offered()).includes("search_history"));
    const submission = await store.send(c, { content: "!rm -rf kept", requestId: "ro-1" });
    assert.equal((await store.settled(h, submission.id as number, 20000)).status, "done");
    assert.ok(existsSync(join(t.work, "kept")), "bash never ran");
    const result = (await store.entries(c, undefined, 5)).items.find((e) => e.kind === "pi.tool-result");
    assert.match(JSON.stringify(result?.model), /Tool bash is not available/);

    await store.configure(row, c, { readOnly: false });
    assert.ok((await offered()).includes("bash"));
    assert.equal((await store.agentDetail(row, c)).config.readOnly, false);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
