// One loop per registry device: probe /v1/device, classify, then follow /v1/events for trees.
// Status machine: checking → online | offline | unauthorized | mismatch | incompatible, retrying
// with backoff (offline: 1s → 30s; states only a human can fix: 30s or an explicit check()).
import { DpiClient } from "../../../../dpi-sdk/src/client.js";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import type {
  DeviceInfo,
  DeviceStatus,
  DeviceTree,
  NetworkDevice,
} from "../../../../dpi-sdk/src/api.js";
import { toPublic, type NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";

export interface LiveState {
  status: DeviceStatus;
  error?: string;
  info?: DeviceInfo;
  tree?: DeviceTree;
  lastSeenAt?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export class DeviceMonitor {
  private live = new Map<string, LiveState>();
  private loops = new Map<string, AbortController>();
  private wakers = new Map<string, () => void>();
  private listeners = new Set<() => void>();
  private persistedAt = new Map<string, number>();
  private emitTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly registry: NetworkRegistry) {}

  start() {
    for (const device of this.registry.list()) this.watch(device.id);
  }

  stop() {
    for (const ctl of this.loops.values()) ctl.abort();
    this.loops.clear();
  }

  watch(id: string) {
    this.loops.get(id)?.abort();
    const ctl = new AbortController();
    this.loops.set(id, ctl);
    this.live.set(id, { ...this.live.get(id), status: "checking", error: undefined });
    this.emit();
    void this.loop(id, ctl.signal);
  }

  forget(id: string) {
    this.loops.get(id)?.abort();
    this.loops.delete(id);
    this.live.delete(id);
    this.emit();
  }

  /** Re-probe now (after a token edit or a manual refresh). */
  check(id: string) {
    this.watch(id);
  }

  state(id: string): LiveState | undefined {
    return this.live.get(id);
  }

  network(): NetworkDevice[] {
    return this.registry.list().map((row) => toPublic(row, this.live.get(row.id)));
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Resolve once the device is online (or the signal aborts). */
  async whenOnline(id: string, signal: AbortSignal) {
    while (!signal.aborted && this.live.get(id)?.status !== "online") {
      await new Promise<void>((resolve) => {
        const off = this.onChange(() => {
          if (this.live.get(id)?.status === "online") done();
        });
        const timer = setTimeout(() => done(), 5000);
        const done = () => {
          off();
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** Resolve when the device leaves `checking` (bounded). */
  async settled(id: string, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && this.live.get(id)?.status === "checking")
      await new Promise((r) => setTimeout(r, 100));
    return this.network().find((d) => d.id === id);
  }

  private emit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      for (const fn of this.listeners) fn();
    }, 50);
  }

  private update(id: string, patch: Partial<LiveState>) {
    if (!this.loops.has(id)) return;
    const previous = this.live.get(id);
    const next: LiveState = { ...previous, ...patch } as LiveState;
    this.live.set(id, next);
    const statusChanged = previous?.status !== next.status || previous?.error !== next.error;
    const now = Date.now();
    if (statusChanged || now - (this.persistedAt.get(id) ?? 0) > 10_000) {
      this.persistedAt.set(id, now);
      try {
        this.registry.recordStatus(id, {
          status: next.status,
          error: next.error ?? null,
          ...(next.lastSeenAt ? { seenAt: next.lastSeenAt } : {}),
          ...(next.info ? { info: next.info } : {}),
          ...(next.tree ? { tree: next.tree } : {}),
        });
      } catch {}
    }
    this.emit();
  }

  private async loop(id: string, signal: AbortSignal) {
    let backoff = 1_000;
    while (!signal.aborted) {
      const device = this.registry.get(id);
      if (!device) return;
      let wait = backoff;
      if (!device.token) {
        this.update(id, {
          status: "unauthorized",
          error: `No token for ${id}. Run: just net register ${id}`,
        });
        await sleep(30_000, signal);
        continue;
      }
      if (this.live.get(id)?.status !== "online") this.update(id, { status: "checking" });
      const client = new DpiClient(device.url, device.token);
      try {
        const info = await client.device({ timeoutMs: 6000, signal });
        if (info.apiVersion !== 1) {
          this.update(id, {
            status: "incompatible",
            error: `${device.url} speaks API v${info.apiVersion}; this hub speaks v1`,
          });
          await sleep(30_000, signal);
          continue;
        }
        if (device.deviceUid && device.deviceUid !== info.uid) {
          this.update(id, {
            status: "mismatch",
            error: `${device.url} now answers as "${info.name}" (uid ${info.uid.slice(0, 8)}), not the device first seen there (uid ${device.deviceUid.slice(0, 8)})`,
          });
          await sleep(30_000, signal);
          continue;
        }
        this.registry.learnUid(id, info.uid);
        this.update(id, { status: "online", error: undefined, info, lastSeenAt: Date.now() });
        backoff = 1_000;
        for await (const frame of client.stream("/v1/events", signal)) {
          if (frame.type === "tree")
            this.update(id, {
              status: "online",
              error: undefined,
              tree: frame.tree,
              lastSeenAt: Date.now(),
            });
        }
        if (signal.aborted) return;
        // The stream was live until now: that is the last time the device was seen.
        this.update(id, {
          status: "offline",
          error: "Event stream ended (device restarting?)",
          lastSeenAt: Date.now(),
        });
        wait = 500;
      } catch (e) {
        if (signal.aborted) return;
        const err =
          e instanceof DpiError ? e : new DpiError("offline", String((e as Error)?.message ?? e));
        if (err.code === "unauthorized") {
          this.update(id, { status: "unauthorized", error: "Token rejected by the device" });
          wait = 30_000;
        } else {
          // A stream that was live until it failed: the device was seen just now.
          const wasOnline = this.live.get(id)?.status === "online";
          this.update(id, {
            status: "offline",
            error: err.message,
            ...(wasOnline ? { lastSeenAt: Date.now() } : {}),
          });
        }
      }
      await sleep(wait, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
