import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { searchHistory } from "../src/history.js";

const user = (id: number, text: string): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: text }],
});
const call = (id: number, name: string, args: unknown, text = ""): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [...(text ? [{ type: "text" as const, text }] : []), { type: "toolCall" as const, id: `c${id}`, name, arguments: args }],
    } as never,
  ],
});
const result = (id: number, name: string, text: string, isError = false): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId: `c${id - 1}`, toolName: name, content: [{ type: "text", text }], isError }],
});

// 1-4 before a reset at 5, 6-9 compacted (the latest head is 10), 10-13 active.
const entries: WireEntry[] = [
  user(1, "Find the flaky login test"),
  call(2, "bash", { command: "npm test -- login" }),
  result(3, "bash", "1 failing: login redirects twice"),
  { id: 4, conversationId: 1, kind: "pi.system", model: [] },
  { id: 5, conversationId: 1, kind: "pi.reset", head: 5 },
  user(6, "Now fix checkout totals"),
  call(7, "read", { path: "src/cart.ts" }),
  result(8, "read", "export function total() {}"),
  { id: 9, conversationId: 1, kind: "demo.job", data: { text: "Started Release check" } },
  { id: 10, conversationId: 1, kind: "pi.compaction", head: 10 },
  call(11, "search_history", { query: "login" }),
  result(12, "search_history", "{...}"),
  user(13, "What was the login failure?"),
];
const marks = { activeFrom: 10, lastReset: 5 };

test("search_history: words, contexts, tools, entry numbers, kinds and paging", () => {
  const login = searchHistory(entries, { query: "login" }, marks);
  assert.deepEqual(login.results.map((r) => [r.entry, r.context]), [
    [13, "active"],
    [3, "before reset"],
    [2, "before reset"],
    [1, "before reset"],
  ]);
  assert.equal(login.active_from, 10);

  assert.deepEqual(searchHistory(entries, { query: "LOGIN redirects" }, marks).results.map((r) => r.entry), [3]);
  assert.deepEqual(searchHistory(entries, { tool: "read" }, marks).results.map((r) => [r.entry, r.context, r.kind]), [
    [8, "compacted", "tool_result"],
    [7, "compacted", "assistant"],
  ]);
  assert.deepEqual(searchHistory(entries, { kind: "tool_call" }, marks).results.map((r) => r.entry), [7, 2]);
  assert.deepEqual(searchHistory(entries, { tool: "search_history" }, marks).results.map((r) => r.entry), [12, 11]);
  assert.deepEqual(searchHistory(entries, { kind: "event" }, marks).results.map((r) => [r.entry, r.text]), [
    [10, "Context compacted. Summary of the older entries:"],
    [9, "Started Release check"],
    [5, "New context started (reset or handoff)."],
  ]);

  const one = searchHistory(entries, { entry: 2 }, marks);
  assert.equal(one.total, 1);
  assert.match(one.results[0].text, /→ bash \{"command":"npm test -- login"\}/);
  assert.equal(searchHistory(entries, { entry: 4 }, marks).total, 0, "system entries are never results");

  const first = searchHistory(entries, { from_entry: 2, to_entry: 9, order: "oldest", limit: 3 }, marks);
  assert.deepEqual(first.results.map((r) => r.entry), [2, 3, 5]);
  assert.equal(first.total, 7);
  assert.equal(first.next_offset, 3);
  const second = searchHistory(entries, { from_entry: 2, to_entry: 9, order: "oldest", limit: 3, offset: first.next_offset! }, marks);
  assert.deepEqual(second.results.map((r) => r.entry), [6, 7, 8]);
  const last = searchHistory(entries, { from_entry: 2, to_entry: 9, order: "oldest", limit: 3, offset: 6 }, marks);
  assert.deepEqual(last.results.map((r) => r.entry), [9]);
  assert.equal(last.next_offset, null);
  assert.equal(searchHistory(entries, { limit: 500 }, marks).limit, 50);
});
