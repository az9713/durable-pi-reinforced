import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("REST v1: auth, sessions, agents, messages, waits, idempotency, errors", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "api-box" });
  try {
    // Auth: healthz is open, /v1 needs the token in Authorization or X-DPI-Token.
    assert.deepEqual(await (await fetch(`${server.base}/healthz`)).json(), { ok: true });
    const anon = await fetch(`${server.base}/v1/device`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, "unauthorized");
    assert.equal((await fetch(`${server.base}/v1/device`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${server.base}/v1/device`, { headers: { "x-dpi-token": token } })).status, 200);

    const client = new DpiClient(server.base, token);
    const info = await client.device();
    assert.equal(info.name, "api-box");
    assert.equal(info.apiVersion, 1);
    assert.deepEqual(info.startDirs, [t.work]);
    assert.equal(info.models[0].id, "echo");
    await assert.rejects(() => new DpiClient(server.base, "x".repeat(40)).device(), (e: DpiError) => e.code === "unauthorized");

    // Directory browsing.
    assert.deepEqual((await client.dirs()).dirs.map((d) => d.path), [t.work]);
    assert.deepEqual((await client.dirs(t.work)).dirs.map((d) => d.name), ["project"]);
    await assert.rejects(() => client.dirs(join(t.work, "nope")), (e: DpiError) => e.code === "not_found");

    // Sessions: create (idempotent), validation, rename, name addressing.
    await assert.rejects(() => client.createSession({ name: "x", cwd: "/definitely/missing", model: faux }), (e: DpiError) => e.code === "invalid");
    const key = "create-1";
    const s1 = await client.createSession({ name: "Alpha", cwd: t.work, model: faux }, key);
    const s1again = await client.createSession({ name: "Alpha", cwd: t.work, model: faux }, key);
    assert.equal(s1again.id, s1.id);
    assert.equal((await client.sessions()).length, 1);
    await client.createSession({ name: "Twin", cwd: t.work, model: faux });
    await client.createSession({ name: "twin", cwd: t.work, model: faux });
    await assert.rejects(() => client.session("twin").get(), (e: DpiError) => e.code === "ambiguous");
    assert.equal((await client.session("alpha").get()).id, s1.id);
    assert.equal((await client.session(s1.id).rename("Alpha Prime")).name, "Alpha Prime");

    // Messages: queued, wait for an answer, then the one-request client.
    const main = client.agent("Alpha Prime", "main");
    const queued = await main.send("hello", "followUp", "req-1");
    assert.equal(queued.status, "queued");
    const settled = await client.session(s1.id).submission(queued.submissionId, 15000);
    assert.equal(settled.status, "done");
    assert.equal(settled.status === "done" && settled.answer.text, "Echo: hello");
    const again = await main.send("hello", "followUp", "req-1");
    assert.equal(again.submissionId, queued.submissionId, "same requestId returns the same submission");
    const once = await main.send("ping", "followUp", "req-2", 15000);
    assert.equal(once.status === "done" && once.answer.text, "Echo: ping");

    // A slow tool: waitMs timeout returns pending, work continues; reject-if-busy answers 409.
    const slow = await main.send("!sleep 2; echo finished", "followUp", "req-3", 300);
    assert.equal(slow.status, "pending");
    await assert.rejects(() => main.send("not now", "reject", "req-4"), (e: DpiError) => e.code === "busy" && e.status === 409);
    const steer = await main.send("steer this", "steer", "req-5");
    assert.equal(steer.status, "queued");
    const finished = await client.session(s1.id).submission(slow.submissionId, 20000);
    assert.equal(finished.status, "done");
    const md = await main.transcript("markdown");
    assert.match(md.text!, /`bash` done\n\n```\nfinished/);
    assert.match(md.text!, /Echo: steer this/);

    // Agents: rename, create, fork, config, name resolution.
    await main.rename("Lead");
    assert.equal((await client.agent(s1.id, "lead").get()).id, 1);
    const entries = await main.entries({ scope: "active" });
    const firstAnswer = entries.items.find((e) => e.kind === "pi.assistant")!;
    const fork = await main.fork({ entryId: firstAnswer.id, name: "branch" });
    assert.equal(fork.kind, "fork");
    assert.equal(fork.parentId, 1);
    const reviewer = await client.session(s1.id).createAgent({ name: "reviewer" });
    assert.equal(reviewer.kind, "root");
    const detail = await client.agent(s1.id, "reviewer").get();
    assert.ok(detail.tools.some((tool) => tool.name === "bash"));
    assert.equal(detail.config.model?.modelId, "echo");
    const config = await client.agent(s1.id, "reviewer").configure({ thinkingLevel: "high", instructions: "Be brief." });
    assert.equal(config.thinkingLevel, "high");
    await assert.rejects(() => client.agent(s1.id, "reviewer").configure({ thinkingLevel: "max" as never }), (e: DpiError) => e.code === "invalid");
    await assert.rejects(() => client.agent(s1.id, "nobody").get(), (e: DpiError) => e.code === "not_found");
    const agents = await client.session(s1.id).agents();
    assert.deepEqual(agents.map((a) => a.name).sort(), ["Lead", "branch", "reviewer"]);

    // Demo extension + docs.
    // Durable jobs: definitions on the device, a run started by a client, then one started by the agent's tool.
    assert.deepEqual((await client.device()).jobs?.map((j) => j.id), ["workspace-snapshot", "release-check", "change-watch"]);
    const runs = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items;
    const job = await main.demo<{ taskId: number }>("jobs", { job: "workspace-snapshot" });
    await until(async () => (await runs())[job.taskId]?.status === "completed", 15000, "job");
    await assert.rejects(() => main.demo("jobs", { job: "workspace-snapshot", input: { depth: 2 } }), (e: DpiError) => e.code === "invalid" && /no input depth/.test(e.message));
    assert.ok((await main.entries({ scope: "all" })).items.some((e) => e.kind === "demo.job" && (e.data as { taskId: number }).taskId === job.taskId));
    // The newest result of a tool, as text (entries come newest first).
    const toolText = async (name: string) => {
      const entry = (await main.entries({ scope: "all" })).items.find(
        (e) => e.kind === "pi.tool-result" && (e.model?.[0] as { toolName?: string } | undefined)?.toolName === name,
      );
      return ((entry?.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((c) => c.text ?? "").join("");
    };
    assert.equal((await main.send("jobs?", "followUp", "list-jobs", 20000)).status, "done");
    assert.match(await toolText("list_durable_jobs"), new RegExp(`"taskId":${job.taskId}`), "list_durable_jobs exposes run ids");
    // run_durable_job returns at once; the run continues in the background and check_durable_job reports it.
    assert.equal((await main.send('job: workspace-snapshot {"path":"."}', "followUp", "run-job", 30000)).status, "done");
    assert.match(await toolText("run_durable_job"), /check_durable_job/);
    const byTool = async () => Object.values(await runs()).find((r) => r.startedBy === "agent");
    await until(async () => (await byTool())?.status === "completed", 15000, "agent-started run");
    const agentRun = (await byTool())!;
    assert.ok(agentRun.toolCallId);
    assert.equal(agentRun.run, 2);
    assert.equal(agentRun.background, true);
    assert.equal((await main.send(`check: ${agentRun.id}`, "followUp", "check-job", 20000)).status, "done");
    const checked = JSON.parse(await toolText("check_durable_job")) as { status: string; phases: { steps?: string[] }[] };
    assert.equal(checked.status, "completed");
    assert.ok(checked.phases[0].steps?.some((s) => s.includes("git status --short")));
    await main.send("check: nope-job", "followUp", "check-missing", 20000);
    assert.match(await toolText("check_durable_job"), /No run of nope-job/);

    // search_history finds an earlier tool call by name, and pages.
    await main.send("search: workspace-snapshot", "followUp", "search-1", 20000);
    const searched = (await main.entries({ scope: "all" })).items.find((e) => e.kind === "pi.tool-result" && JSON.stringify(e.model).includes("next_offset"));
    assert.ok(searched, "search_history result");
    assert.match(JSON.stringify(searched!.model), /run_durable_job/);

    // ping_on_call_engineer pages once per agent.
    assert.equal((await main.send("page: checkout is failing", "followUp", "page-1", 20000)).status, "done");
    await main.send("page: again", "followUp", "page-2", 20000);
    const pages = (await main.entries({ scope: "all" })).items.filter((e) => e.kind === "pi.tool-result" && JSON.stringify(e.model).includes("ping_on_call_engineer"));
    assert.equal(pages.length, 2);
    assert.match(JSON.stringify(pages.find((e) => e.id === Math.max(...pages.map((p) => p.id)))!.model), /works once per agent/);

    // Compaction thresholds per session.
    const compaction = await client.request<{ reserveTokens: number }>("PATCH", `/v1/sessions/${s1.id}/compaction`, { reserveTokens: 20000 });
    assert.equal(compaction.reserveTokens, 20000);
    assert.equal((await client.session(s1.id).get()).compaction?.reserveTokens, 20000);
    await assert.rejects(() => client.request("PATCH", `/v1/sessions/${s1.id}/compaction`, { backgroundTokens: -1 }), (e: DpiError) => e.code === "invalid");
    // Read only filters the agent's tools: the ones that write leave its requests.
    assert.equal((await main.configure({ readOnly: true })).readOnly, true);
    const readOnly = await main.get();
    assert.equal(readOnly.tools.find((t) => t.name === "bash")?.offered, false);
    assert.equal(readOnly.tools.find((t) => t.name === "read")?.offered, true);
    assert.equal((await main.configure({ readOnly: false })).readOnly, false);
    const state = await main.demo<{ revision: number }>("state", { increment: true });
    assert.ok(state.revision >= 1);
    assert.equal(((await client.deviceDoc<{ counter: number }>("app.shared-state")).value).counter, 1);
    assert.ok((await client.session(s1.id).tasks("terminal")).length > 0);

    // Compact, reset, abort, archive.
    await main.reset("handoff note");
    const afterReset = await main.entries({ scope: "active" });
    assert.ok(afterReset.items.some((e) => e.kind === "pi.reset"));
    assert.deepEqual(await main.abort(), { ok: true });
    const archived = await client.session("Twin").archive().catch((e: DpiError) => e);
    assert.ok(archived instanceof DpiError && archived.code === "ambiguous");
    const tree = await client.tree();
    await client.session(tree.sessions.find((s) => s.name === "Twin")!.id).archive();
    assert.equal((await client.sessions()).length, 2);

    // Unknown routes and bad JSON use the error envelope.
    const nf = await fetch(`${server.base}/v1/nope`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nf.status, 404);
    const bad = await fetch(`${server.base}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{nope",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "invalid");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
