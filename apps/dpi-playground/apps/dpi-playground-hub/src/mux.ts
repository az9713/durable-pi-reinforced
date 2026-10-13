// One SSE connection per browser tab. The tab names the streams it wants (subscription keys);
// the hub opens one authenticated upstream per key and tags every frame with its key.
//   network                                  registry + live status of every device
//   <device>/device[?docs=a,b]               device stream
//   <device>/session/<sessionId>             session stream
//   <device>/agent/<sessionId>/<agentId>[?docs=a,b]
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { DpiClient } from "../../../../dpi-sdk/src/client.js";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import type { MuxFrame } from "../../../../dpi-sdk/src/api.js";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor } from "./monitor.js";

interface BrowserStream {
  send(frame: MuxFrame): void;
  upstreams: Map<string, AbortController>;
}

const KEY =
  /^([a-z0-9][a-z0-9-]{0,31})\/(device|session|agent)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\?docs=([a-z0-9.,-]*))?$/;

export function parseSubKey(key: string) {
  const m = key.match(KEY);
  if (!m) throw Error(`Invalid subscription key: ${key}`);
  const [, deviceId, scope, a, b, docs] = m;
  const q = docs ? `?docs=${docs}` : "";
  const enc = encodeURIComponent;
  if (scope === "device") return { key, deviceId, path: `/v1/events${q}` };
  if (scope === "session" && a && !b)
    return { key, deviceId, path: `/v1/sessions/${enc(decodeURIComponent(a))}/events` };
  if (scope === "agent" && a && b)
    return {
      key,
      deviceId,
      path: `/v1/sessions/${enc(decodeURIComponent(a))}/agents/${enc(decodeURIComponent(b))}/events${q}`,
    };
  throw Error(`Invalid subscription key: ${key}`);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export class StreamMux {
  private streams = new Map<string, BrowserStream>();

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly monitor: DeviceMonitor,
  ) {}

  get size() {
    return this.streams.size;
  }

  open(_req: Request, res: Response) {
    const streamId = randomUUID();
    res.status(200).set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    const stream: BrowserStream = {
      upstreams: new Map(),
      send: (frame) => {
        if (closed) return;
        if (res.writableLength > 4_000_000) return void res.end();
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      },
    };
    this.streams.set(streamId, stream);
    stream.send({ sub: "hello", frame: { type: "stream", streamId } });
    const pushNetwork = () =>
      stream.send({ sub: "network", frame: { type: "network", devices: this.monitor.network() } });
    pushNetwork();
    const off = this.monitor.onChange(pushNetwork);
    const ping = setInterval(() => !closed && res.write(": ping\n\n"), 15_000);
    res.on("close", () => {
      closed = true;
      clearInterval(ping);
      off();
      for (const ctl of stream.upstreams.values()) ctl.abort();
      this.streams.delete(streamId);
    });
  }

  /** Replace a tab's subscription set: open new upstreams, close dropped ones. */
  subscribe(streamId: string, keys: unknown) {
    const stream = this.streams.get(streamId);
    if (!stream) throw Object.assign(Error("Stream closed; reconnect"), { status: 404 });
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string") || keys.length > 20)
      throw Object.assign(Error("subs must be a list of up to 20 keys"), { status: 400 });
    const wanted = new Map(
      (keys as string[]).filter((k) => k !== "network").map((k) => [k, parseSubKey(k)]),
    );
    for (const [key, ctl] of stream.upstreams)
      if (!wanted.has(key)) {
        ctl.abort();
        stream.upstreams.delete(key);
      }
    for (const [key, sub] of wanted)
      if (!stream.upstreams.has(key)) {
        if (!this.registry.get(sub.deviceId))
          throw Object.assign(Error(`No device ${sub.deviceId}`), { status: 404 });
        const ctl = new AbortController();
        stream.upstreams.set(key, ctl);
        void this.follow(stream, sub, ctl.signal);
      }
    return { subs: ["network", ...wanted.keys()] };
  }

  private async follow(
    stream: BrowserStream,
    sub: ReturnType<typeof parseSubKey>,
    signal: AbortSignal,
  ) {
    let backoff = 1_000;
    while (!signal.aborted) {
      await this.monitor.whenOnline(sub.deviceId, signal);
      if (signal.aborted) return;
      const device = this.registry.get(sub.deviceId);
      if (!device?.token) return;
      try {
        for await (const frame of new DpiClient(device.url, device.token).stream(
          sub.path,
          signal,
        )) {
          stream.send({ sub: sub.key, frame });
          if (frame.type === "hello") backoff = 1_000;
        }
        if (signal.aborted) return;
        stream.send({ sub: sub.key, frame: { type: "disconnected", reason: "Stream ended" } });
      } catch (e) {
        if (signal.aborted) return;
        const err =
          e instanceof DpiError ? e : new DpiError("offline", String((e as Error)?.message ?? e));
        if (err.code === "not_found" || err.code === "invalid" || err.code === "ambiguous") {
          stream.send({
            sub: sub.key,
            frame: { type: "fault", error: { code: err.code, message: err.message } },
          });
          return;
        }
        stream.send({ sub: sub.key, frame: { type: "disconnected", reason: err.message } });
      }
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}
