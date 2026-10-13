// Server-Sent Event streams. Three scopes share one frame envelope (see dpi-sdk/src/api.ts):
// device (tree + activity), session (agents, tasks, usage) and agent (pi-durable agent events).
// Streams are viewers only: closing one never aborts work or closes a harness.
import type { Request, Response } from "express";
import { watchEvents, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Activity, DeviceTree, Frame, StreamScope } from "../../dpi-sdk/src/api.js";
import { AGENT_DOC_KINDS, DEVICE_DOC_KINDS, type SessionRow, type Store } from "./store.js";
import { invalid } from "./errors.js";

const MAX_BUFFER = 2_000_000;

export interface Sse {
  send(frame: Frame): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
  sendIfChanged(key: string, frame: Frame): void;
}

export function openSse(res: Response, scope: StreamScope): Sse {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  let seq = 0;
  let closed = false;
  const cleanups: Array<() => void> = [];
  const last = new Map<string, string>();
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }
  };
  res.on("close", close);
  const send = (frame: Frame) => {
    if (closed) return;
    if (res.writableLength > MAX_BUFFER) {
      // A slow viewer reconnects to a fresh snapshot instead of buffering without bound.
      res.end();
      close();
      return;
    }
    res.write(`id: ${++seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  send({ type: "hello", apiVersion: 1, serverTime: Date.now(), scope });
  return {
    send,
    get closed() {
      return closed;
    },
    onClose(fn) {
      if (closed) fn();
      else cleanups.push(fn);
    },
    sendIfChanged(key, frame) {
      const json = JSON.stringify(frame);
      if (last.get(key) === json) return;
      last.set(key, json);
      send(frame);
    },
  };
}

/** Run `fn` at most once per `ms`, never concurrently, always catching up on the latest trigger. */
export function coalesce(fn: () => Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const run = async () => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error("[dpi-backend] stream update failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
      if (again) {
        again = false;
        trigger();
      }
    }
  };
  const trigger = () => {
    if (!timer) timer = setTimeout(() => void run(), ms);
  };
  return Object.assign(trigger, { now: run, cancel: () => timer && clearTimeout(timer) });
}

export function parseDocs(raw: unknown, allowed: readonly string[]): string[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string") throw invalid("docs must be a comma-separated list");
  const kinds = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  for (const kind of kinds)
    if (!allowed.includes(kind)) throw invalid(`Unknown document ${kind}. Allowed: ${allowed.join(", ")}`);
  return kinds;
}

export function diffActivity(prev: DeviceTree | undefined, next: DeviceTree): Activity[] {
  if (!prev) return [];
  const before = new Map(prev.sessions.flatMap((s) => s.agents.map((a) => [`${s.id}/${a.id}`, a.busy] as const)));
  return next.sessions.flatMap((s) =>
    s.agents.flatMap((a): Activity[] => {
      const was = before.get(`${s.id}/${a.id}`) ?? false;
      if (was === a.busy) return [];
      return [{ type: a.busy ? "agent.started" : "agent.finished", sessionId: s.id, agentId: a.id, at: next.at }];
    }),
  );
}

// ---------------------------------------------------------------- device scope

export function deviceStream(store: Store, req: Request, res: Response) {
  const docs = parseDocs(req.query.docs, DEVICE_DOC_KINDS);
  const sse = openSse(res, { kind: "device" });
  let previous: DeviceTree | undefined;
  const push = coalesce(async () => {
    if (sse.closed) return;
    const tree = await store.tree();
    const { at: _at, ...stable } = tree;
    const items = diffActivity(previous, tree);
    previous = tree;
    sse.sendIfChanged("tree", { type: "tree", tree: { ...stable, at: 0 } });
    if (items.length) {
      for (const item of items)
        if (item.type === "agent.finished") {
          const row = store.list().find((r) => r.id === item.sessionId);
          if (row) item.preview = await store.preview(row, item.agentId).catch(() => undefined);
        }
      sse.send({ type: "activity", items });
    }
    for (const kind of docs) {
      const doc = await store.deviceDoc(kind);
      sse.sendIfChanged(`doc:${kind}`, { type: "doc", kind, value: doc.value, revision: doc.revision });
    }
  }, 250);
  sse.onClose(store.subscribe(push));
  sse.onClose(() => push.cancel());
  void push.now();
}

// ---------------------------------------------------------------- session scope

export async function sessionStream(store: Store, row: SessionRow, res: Response) {
  const h = store.harness(row);
  const sse = openSse(res, { kind: "session", sessionId: row.id });
  const watch = await h.watchTaskGraph(ctx);
  const tasksOf = (value: { tasks: Readonly<Record<string, unknown>> }) =>
    Object.values(value.tasks).map((t) => store.taskNode(t));
  let tasks = await store.labelTasks(h, tasksOf(watch.value));
  sse.send({ type: "session", agents: await store.agents(row, tasks), tasks, usage: await store.usage(h) });
  watch.start(async (value) => {
    if (sse.closed) return;
    tasks = await store.labelTasks(h, tasksOf(value));
    sse.sendIfChanged("tasks", { type: "tasks", tasks });
    push();
  });
  const push = coalesce(async () => {
    if (sse.closed || !store.opened.has(row.id)) return;
    sse.sendIfChanged("agents", { type: "agents", agents: await store.agents(row, tasks) });
    sse.sendIfChanged("usage", { type: "usage", usage: await store.usage(h) });
  }, 250);
  const off = h.subscribeCommits(() => push());
  // Agent names live in the device catalog, not the harness: a rename only fires the store's change feed.
  const offCatalog = store.subscribe(() => push());
  sse.onClose(() => {
    off();
    offCatalog();
    push.cancel();
    void watch.stop();
  });
}

// ---------------------------------------------------------------- agent scope

export async function agentStream(
  store: Store,
  target: { row: SessionRow; h: Harness; c: Conversation },
  req: Request,
  res: Response,
) {
  const { row, h, c } = target;
  const docs = parseDocs(req.query.docs, AGENT_DOC_KINDS);
  const stream = await watchEvents(h, c.id, ctx);
  const sse = openSse(res, { kind: "agent", sessionId: row.id, agentId: c.id as number });
  sse.send({
    type: "snapshot",
    snapshot: JSON.parse(JSON.stringify(stream.snapshot)),
    inbox: await store.inbox(h, c),
  });
  const pushDocs = coalesce(async () => {
    for (const kind of docs)
      sse.sendIfChanged(`doc:${kind}`, { type: "doc", kind, value: await store.agentDoc(h, c, kind) });
  }, 150);
  await pushDocs.now();
  stream.start(async (events) => {
    if (sse.closed) return;
    sse.send({ type: "batch", events: JSON.parse(JSON.stringify(events)) });
    if (events.some((e) => e.type === "inbox_update" || e.type === "snapshot"))
      sse.send({ type: "inbox", items: await store.inbox(h, c) });
  });
  const offDocs = docs.length ? h.subscribeCommits(() => pushDocs()) : () => {};
  sse.onClose(() => {
    offDocs();
    pushDocs.cancel();
    void stream.stop();
  });
}
