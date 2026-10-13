import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Response } from "express";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { AgentModel, SessionModel } from "../../dpi-sdk/src/models.js";
import type { Frame } from "../../dpi-sdk/src/api.js";
import { openSse } from "../src/streams.js";
import { bootServer, delay, faux, newToken, tempStore, until } from "./helpers.js";

function collect(stream: AsyncGenerator<Frame>, sink: Frame[], onFrame?: (f: Frame) => void) {
  return (async () => {
    for await (const frame of stream) {
      sink.push(frame);
      onFrame?.(frame);
    }
  })().catch(() => {});
}

test("agent, session and device streams carry snapshots and deltas that reduce to the transcript", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const stop = new AbortController();
  try {
    const client = new DpiClient(server.base, token);
    const session = await client.createSession({ name: "Streams", cwd: t.work, model: faux });
    const main = client.agent(session.id, "main");

    // Device stream: hello, tree, then activity when the agent works.
    const deviceFrames: Frame[] = [];
    void collect(client.deviceEvents(stop.signal, ["app.shared-state"]), deviceFrames);
    // Session stream: one session snapshot, then tasks/agents updates.
    const sessionFrames: Frame[] = [];
    const sessionModel = new SessionModel();
    void collect(client.session(session.id).events(stop.signal), sessionFrames, (f) => sessionModel.apply(f));
    // Agent stream with documents.
    const agentFrames: Frame[] = [];
    const model = new AgentModel();
    void collect(main.events(stop.signal, ["demo.job-runs"]), agentFrames, (f) => model.apply(f));
    await until(async () => model.state.ready, 5000, "agent snapshot");
    assert.equal(agentFrames[0].type, "hello");
    assert.equal(agentFrames[1].type, "snapshot");
    assert.ok(agentFrames.some((f) => f.type === "doc" && f.kind === "demo.job-runs"));

    // A tool turn streams output and ends in the same items the server normalizes.
    await main.send("!for i in 1 2 3; do echo line$i; sleep 0.4; done", "followUp", "s-1");
    await until(
      async () =>
        model.state.items.some(
          (i) => i.kind === "assistant" && i.blocks.some((b) => b.type === "tool" && b.call.status === "running" && (b.call.output ?? "").includes("line1")),
        ),
      8000,
      "live tool output",
    );
    await until(async () => !model.state.running && model.state.items.filter((i) => i.kind === "assistant").length >= 2, 15000, "run end");
    const server_items = (await main.transcript("json")).items;
    assert.deepEqual(JSON.parse(JSON.stringify(model.state.items)), server_items);
    const types = new Set(agentFrames.flatMap((f) => (f.type === "batch" ? f.events.map((e) => e.type) : [])));
    for (const expected of ["run_start", "message_start", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "run_end"])
      assert.ok(types.has(expected as never), `missing ${expected}`);
    // A long reply streams partial text through message_update deltas.
    let sawPartial = false;
    const unsub = model.subscribe(() => {
      const live = model.state.items.find((i) => i.kind === "assistant" && i.streaming);
      if (live && live.kind === "assistant" && live.blocks.some((b) => b.type === "text" && b.text.length > 10)) sawPartial = true;
    });
    await main.send("slow: " + "durable streaming words ".repeat(40), "followUp", "s-slow");
    await until(async () => !model.state.running && model.state.items.filter((i) => i.kind === "assistant").length >= 3, 20000, "slow reply");
    unsub();
    assert.ok(sawPartial, "saw streamed partial text");
    assert.ok(agentFrames.some((f) => f.type === "batch" && f.events.some((e) => e.type === "message_update")), "message_update frames");
    // RECORD_FIXTURES=1 saves the real frame log as the SDK fixture.
    if (process.env.RECORD_FIXTURES) {
      const fixtures = join(import.meta.dirname, "../../dpi-sdk/tests/fixtures");
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, "agent-tool-turn.json"), JSON.stringify({ frames: agentFrames, transcript: (await main.transcript("json")).items }, null, 1));
    }

    // A late joiner mid-run sees the running state in its snapshot; a steer shows in the inbox with content.
    await main.send("!sleep 1.5; echo late", "followUp", "s-2");
    await delay(500);
    const late = new AgentModel();
    const lateFrames: Frame[] = [];
    const lateStop = new AbortController();
    void collect(main.events(lateStop.signal), lateFrames, (f) => late.apply(f));
    await until(async () => late.state.ready, 5000, "late snapshot");
    assert.equal(late.state.running, true);
    await main.send("then say bye", "steer", "s-3");
    await until(async () => late.state.inbox.some((i) => i.content === "then say bye" && i.mode === "steer"), 5000, "inbox content");
    // Closing a viewer mid-run never stops the run.
    lateStop.abort();
    await until(async () => !model.state.running && model.state.items.some((i) => i.kind === "assistant" && i.blocks.some((b) => b.type === "text" && b.text === "Echo: then say bye")), 15000, "run continues after viewer closes");

    // Session stream saw generation tasks come and go; device stream saw activity.
    assert.equal(sessionFrames[1].type, "session");
    assert.ok(sessionFrames.some((f) => f.type === "tasks" && f.tasks.some((task) => task.kind === "pi.generation")));
    await until(async () => sessionModel.state.tasks.length === 0, 5000, "tasks drained");
    // A rename touches only the catalog; the open session stream still carries the new name.
    await main.rename("Renamed live");
    await until(async () => sessionModel.agent(1)?.name === "Renamed live", 5000, "renamed agent on the session stream");
    assert.ok(deviceFrames.some((f) => f.type === "tree"));
    assert.ok(deviceFrames.some((f) => f.type === "doc" && f.kind === "app.shared-state"));
    const activity = () => deviceFrames.flatMap((f) => (f.type === "activity" ? f.items : []));
    await until(async () => activity().some((a) => a.type === "agent.finished" && (a.preview ?? "").length > 0), 5000, "finished activity with preview");
    assert.ok(activity().some((a) => a.type === "agent.started"));

    // Bad stream requests answer JSON errors before any stream starts.
    const bad = await fetch(`${server.base}/v1/sessions/${session.id}/agents/main/events?docs=nope`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${server.base}/v1/sessions/${session.id}/agents/99/events`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 404);
  } finally {
    stop.abort();
    await server.stop();
    await t.cleanup();
  }
});

test("openSse ends a slow viewer instead of buffering without bound", () => {
  const writes: string[] = [];
  let ended = false;
  const handlers: Record<string, () => void> = {};
  const res = {
    writableLength: 0,
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
    socket: undefined,
    on(event: string, fn: () => void) {
      handlers[event] = fn;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
  };
  const sse = openSse(res as unknown as Response, { kind: "device" });
  assert.match(writes[0], /event: hello/);
  res.writableLength = 3_000_000;
  sse.send({ type: "activity", items: [] });
  assert.equal(ended, true);
  assert.equal(sse.closed, true);
  sse.send({ type: "activity", items: [] });
  assert.equal(writes.length, 1);
});
