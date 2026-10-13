import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentModel } from "../../dpi-sdk/src/models.ts";
import type { Frame } from "../../dpi-sdk/src/api.ts";
import type { TranscriptItem } from "../../dpi-sdk/src/transcript.ts";
import { itemComponent, TranscriptView } from "../src/render.ts";

const long = "x".repeat(500);
const wide = "漢字とかなの混在テキスト🙂🚀✨ ".repeat(20);
const items: TranscriptItem[] = [
  { kind: "user", id: 1, text: `hello ${wide}\nsecond line ${long}` },
  {
    kind: "assistant",
    id: 2,
    streaming: false,
    model: "m",
    blocks: [
      { type: "thinking", text: `planning ${wide}` },
      { type: "text", text: `# Title\n\nSome **bold** text, \`code\`, and a list:\n\n- one ${wide}\n- two\n\n\`\`\`ts\nconst x = "${long}";\n\`\`\`` },
      {
        type: "tool",
        call: { callId: "a", name: "bash", args: { command: `echo ${long}` }, status: "done", result: `${wide}\n`.repeat(12), resultEntryId: 3 },
      },
      { type: "tool", call: { callId: "b", name: "write", args: { path: `/very/${long}/file.ts`, content: long }, status: "running", output: "partial\noutput" } },
      { type: "tool", call: { callId: "c", name: "edit", args: { edits: [{ old: long, new: wide }] }, status: "error", result: `failed ${wide}` } },
    ],
    error: `Provider request failed ${long}`,
  },
  { kind: "assistant", id: "live", streaming: true, blocks: [] },
  { kind: "tool-result", id: 4, name: "read", text: `${wide}\n${long}`, isError: true },
  { kind: "tool", id: "d", call: { callId: "d", name: "grep", args: { pattern: wide }, status: "pending" } },
  { kind: "event", id: 5, entryKind: "pi.compaction", text: `Context compacted ${wide}` },
];

for (const width of [40, 80, 200])
  for (const expand of [false, true])
    test(`every item kind fits width ${width}${expand ? " (expanded)" : ""}`, () => {
      for (const item of items) {
        const lines = itemComponent(item, expand).render(width);
        assert.ok(lines.length > 0, `${item.kind} renders`);
        for (const line of lines)
          assert.ok(visibleWidth(line) <= width, `${item.kind} line is ${visibleWidth(line)} > ${width}: ${JSON.stringify(line).slice(0, 120)}`);
      }
    });

test("collapsed tool output shows the last 6 lines and a count; expanded shows all", () => {
  const item = items[1] as Extract<TranscriptItem, { kind: "assistant" }>;
  const tool = item.blocks[2] as Extract<(typeof item.blocks)[number], { type: "tool" }>;
  const collapsed = itemComponent({ kind: "tool", id: "a", call: tool.call }, false).render(200);
  assert.ok(collapsed.some((l) => l.includes("6 earlier lines")));
  assert.equal(collapsed.length, 1 + 1 + 6);
  const expanded = itemComponent({ kind: "tool", id: "a", call: tool.call }, true).render(200);
  assert.ok(expanded.length > collapsed.length);
});

test("TranscriptView reuses components for unchanged items and renders a recorded tool turn", () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../dpi-sdk/tests/fixtures/agent-tool-turn.json"), "utf8")) as { frames: Frame[] };
  const model = new AgentModel();
  const view = new TranscriptView();
  for (const frame of fixture.frames) {
    model.apply(frame);
    view.update(model.state.items);
  }
  const first = [...view.children];
  view.update(model.state.items);
  assert.deepEqual(view.children, first, "same components when nothing changed");
  const text = view.render(100).join("\n");
  assert.match(text, /bash/);
  for (const line of view.render(60)) assert.ok(visibleWidth(line) <= 60);
});
