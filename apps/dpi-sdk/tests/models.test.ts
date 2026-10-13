import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentModel, SessionModel, networkTree, lineage } from "../src/models.js";
import { toMarkdown, toTranscript, sumUsage } from "../src/transcript.js";
import type {
  AgentSummary,
  NetworkDevice,
  WireAssistantMessage,
  WireEntry,
  WireSnapshotEvent,
  WireUsage,
} from "../src/api.js";

const usage: WireUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};
const assistant = (content: WireAssistantMessage["content"], extra: Partial<WireAssistantMessage> = {}): WireAssistantMessage => ({
  role: "assistant",
  content,
  provider: "openrouter",
  model: "m",
  usage,
  stopReason: "stop",
  ...extra,
});
const user = (id: number, text: string): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: text }],
});
const snapshot = (entries: WireEntry[], extra: Partial<WireSnapshotEvent> = {}): WireSnapshotEvent => ({
  type: "snapshot",
  entries,
  tools: [],
  compactions: [],
  inbox: [],
  agent: { model: { provider: "openrouter", modelId: "m" } },
  usage: { models: { "openrouter/m": usage }, tools: {} },
  ...extra,
});

test("a streamed turn: snapshot, deltas, tool output, results and dedupe", () => {
  const model = new AgentModel();
  let renders = 0;
  model.subscribe(() => renders++);
  model.apply({ type: "snapshot", snapshot: snapshot([user(1, "hi")]), inbox: [] });
  assert.equal(model.state.ready, true);
  assert.deepEqual(model.state.items.map((i) => i.kind), ["user"]);

  model.apply({
    type: "batch",
    events: [
      { type: "run_start", inputs: [1] },
      { type: "message_start", message: assistant([]) },
      {
        type: "message_update",
        usage,
        changes: [
          { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
          { type: "text_delta", contentIndex: 0, delta: "Let me " },
          { type: "text_delta", contentIndex: 0, delta: "look." },
          { type: "toolcall_start", contentIndex: 1, block: { type: "toolCall", id: "c1", name: "bash", arguments: {} } },
          { type: "toolcall_delta", contentIndex: 1, path: ["arguments", "command"], delta: "ls" },
          { type: "toolcall_delta", contentIndex: 1, path: ["arguments", "command"], delta: " -la" },
        ],
      },
    ],
  });
  let live = model.state.items.at(-1)!;
  assert.equal(live.kind, "assistant");
  assert.equal(live.kind === "assistant" && live.streaming, true);
  assert.deepEqual(live.kind === "assistant" && live.blocks[0], { type: "text", text: "Let me look." });
  const call = live.kind === "assistant" && live.blocks[1].type === "tool" ? live.blocks[1].call : undefined;
  assert.deepEqual(call?.args, { command: "ls -la" });
  assert.equal(model.state.running, true);

  const finalAssistant: WireEntry = {
    id: 2,
    conversationId: 1,
    kind: "pi.assistant",
    model: [assistant([{ type: "text", text: "Let me look." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }])],
  };
  model.apply({
    type: "batch",
    events: [
      { type: "message_end", entry: finalAssistant },
      { type: "entry_appended", entry: finalAssistant }, // duplicate delivery must not duplicate the item
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls -la" } },
      { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", output: { append: "a\nb\n" } },
      { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", output: { trimStart: 2, append: "c\n" } },
    ],
  });
  assert.equal(model.state.items.filter((i) => i.kind === "assistant").length, 1);
  const running = model.state.items[1];
  const runningCall = running.kind === "assistant" && running.blocks[1].type === "tool" ? running.blocks[1].call : undefined;
  assert.equal(runningCall?.status, "running");
  assert.equal(runningCall?.output, "b\nc\n");

  model.apply({
    type: "batch",
    events: [
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        entry: {
          id: 3,
          conversationId: 1,
          kind: "pi.tool-result",
          model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a\nb\nc\n" }], isError: false }],
        },
      },
      { type: "message_end", entry: { id: 4, conversationId: 1, kind: "pi.assistant", model: [assistant([{ type: "text", text: "Done." }])] } },
      { type: "run_end", inputs: [1] },
    ],
  });
  const kinds = model.state.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["user", "assistant", "assistant"]);
  const done = model.state.items[1];
  const doneCall = done.kind === "assistant" && done.blocks[1].type === "tool" ? done.blocks[1].call : undefined;
  assert.equal(doneCall?.status, "done");
  assert.equal(doneCall?.result, "a\nb\nc\n");
  assert.equal(doneCall?.resultEntryId, 3);
  assert.equal(model.state.running, false);
  assert.ok(renders >= 4);
  assert.match(toMarkdown(model.state.items), /### You \(#1\)\n\nhi/);
});

test("overflow snapshot inside a batch replaces state; inbox and docs frames apply", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snapshot([user(1, "a"), user(2, "b")]), inbox: [] });
  model.apply({ type: "batch", events: [snapshot([user(9, "fresh")], { run: { inputs: [9] } })] });
  assert.deepEqual(model.state.items.map((i) => i.kind === "user" && i.text), ["fresh"]);
  assert.equal(model.state.running, true);
  model.apply({ type: "inbox", items: [{ id: 7, mode: "steer", content: "use pnpm" }] });
  model.apply({ type: "doc", kind: "demo.jobs", value: { items: {} } });
  assert.equal(model.state.inbox[0].content, "use pnpm");
  assert.deepEqual(model.state.docs["demo.jobs"], { items: {} });
});

test("reset entry drops the old context; aborted partials and unmatched results render", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snapshot([user(1, "old"), user(2, "older")]), inbox: [] });
  model.apply({ type: "batch", events: [{ type: "entry_appended", entry: { id: 5, conversationId: 1, kind: "pi.reset", head: 5 } }] });
  assert.deepEqual(model.state.items.map((i) => i.kind), ["event"]);
  // pi-durable delivers a reset with a handoff note as message_end, not entry_appended.
  const viaMessage = new AgentModel();
  viaMessage.apply({ type: "snapshot", snapshot: snapshot([user(1, "old")]), inbox: [] });
  viaMessage.apply({
    type: "batch",
    events: [{ type: "message_end", entry: { id: 7, conversationId: 1, kind: "pi.reset", head: 7, model: [{ role: "user", content: "note" }] } }],
  });
  assert.deepEqual(viaMessage.state.entries.map((e) => e.id), [7]);

  const items = toTranscript([
    { id: 1, conversationId: 1, kind: "pi.assistant", model: [assistant([{ type: "text", text: "part" }], { stopReason: "aborted" })] },
    { id: 2, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "gone", toolName: "read", content: [{ type: "text", text: "x" }], isError: true }] },
    { id: 3, conversationId: 1, kind: "pi.system", model: [] },
    { id: 4, conversationId: 1, kind: "demo.event", data: { text: "Job done" } },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ["assistant", "tool-result", "event"]);
  assert.equal(items[0].kind === "assistant" && items[0].error, "Interrupted. Partial response preserved.");
  assert.equal(items[2].kind === "event" && items[2].text, "Job done");
  assert.equal(sumUsage({ models: { a: usage, b: usage } }).tokens, 30);
});

test("session lineage and network tree nest forks and subagents", () => {
  const agents: AgentSummary[] = [
    { id: 1, name: "Main", named: false, kind: "root", busy: true, background: 0 },
    { id: 4, name: "alt", named: true, kind: "fork", parentId: 1, forkedAt: 3, busy: false, background: 0 },
    { id: 6, name: "Subagent #6", named: false, kind: "subagent", ownerAgentId: 4, ownerTaskId: 9, busy: true, background: 0 },
    { id: 7, name: "Root #7", named: false, kind: "root", busy: false, background: 1 },
  ];
  assert.deepEqual(lineage(agents, 4).map((a) => a.id), [1, 4]);
  const session = new SessionModel();
  session.apply({ type: "session", agents, tasks: [{ id: 1, kind: "pi.generation", conversationId: 1, background: false, state: { status: "running" }, conversations: [] }], usage: { models: {}, tools: {} } });
  assert.equal(session.foregroundBusy(1), true);
  assert.equal(session.foregroundBusy(7), false);
  const device: NetworkDevice = {
    id: "box",
    name: "Box",
    kind: "ssh",
    url: "http://box:4780",
    source: "config",
    hasToken: true,
    status: "online",
    tree: { uid: "u", name: "box", at: 1, sessions: [{ id: "s1", name: "S", cwd: "/w", model: "m", createdAt: 1, dbPath: "/d", busy: true, agents }] },
  };
  const [root] = networkTree([device]);
  const sessionNode = root.children[0];
  assert.equal(sessionNode.key, "box/s/s1");
  assert.deepEqual(sessionNode.children.map((n) => n.type === "agent" && n.agent.id), [1, 7]);
  const main = sessionNode.children[0];
  assert.deepEqual(main.children.map((n) => n.type === "agent" && n.agent.id), [4]);
  assert.deepEqual(main.children[0].children.map((n) => n.type === "agent" && n.agent.id), [6]);
  assert.equal(networkTree([{ ...device, status: "offline" }])[0].stale, true);
});

test("a recorded real stream (dpi-backend + pi-durable watchEvents) reduces to the server's transcript", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-tool-turn.json", import.meta.url), "utf8"));
  const model = new AgentModel();
  for (const frame of fixture.frames) model.apply(frame);
  assert.deepEqual(JSON.parse(JSON.stringify(model.state.items)), fixture.transcript);
  assert.equal(model.state.running, false);
  // Replaying from a mid-stream snapshot converges too.
  const fromSnapshot = new AgentModel();
  const start = fixture.frames.findIndex((f: { type: string }) => f.type === "snapshot");
  for (const frame of fixture.frames.slice(start)) fromSnapshot.apply(frame);
  assert.deepEqual(fromSnapshot.state.items, model.state.items);
});
