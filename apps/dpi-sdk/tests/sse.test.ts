import { test } from "node:test";
import assert from "node:assert/strict";
import { readSse, parseBlock } from "../src/sse.js";
import { DpiError } from "../src/errors.js";

function streamOf(chunks: string[], delayMs = 0, hold = false) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(enc.encode(chunk));
      }
      if (!hold) controller.close();
    },
  });
}

test("parses events split across chunks, comments, multi-line data and CRLF", async () => {
  const body = streamOf([
    ": ping\n\nid: 1\nevent: hel",
    'lo\ndata: {"a":1}\n\n',
    "event: batch\r\ndata: line1\r\ndata: line2\r\n\r\n",
    "data: last\n\n",
  ]);
  const out = [];
  for await (const m of readSse(body)) out.push(m);
  assert.deepEqual(out, [
    { event: "hello", data: '{"a":1}', id: "1" },
    { event: "batch", data: "line1\nline2", id: undefined },
    { event: "message", data: "last", id: undefined },
  ]);
});

test("ignores blocks without data", () => {
  assert.equal(parseBlock(": comment only"), undefined);
  assert.equal(parseBlock("event: x"), undefined);
});

test("idle timeout ends a silent stream with an offline error", async () => {
  const body = streamOf(["data: one\n\n"], 0, true);
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const m of readSse(body, 150)) seen.push(m.data);
    })(),
    (e: unknown) => e instanceof DpiError && e.code === "offline",
  );
  assert.deepEqual(seen, ["one"]);
});
