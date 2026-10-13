// One browser connection to the hub: EventSource('/api/stream'). The first frame names the
// stream; named slots (device, session, agent) map to subscription keys that a debounced
// PUT /api/stream/:id sends. Every (re)connect opens fresh upstreams, so each model restarts
// from its server snapshot.
import type { Frame, MuxFrame, NetworkDevice } from "@sdk/api";

export type Slot = "device" | "session" | "agent";
export type StreamState = "connecting" | "live" | "offline";

export class HubStream {
  state: StreamState = "connecting";
  private source?: EventSource;
  private streamId = "";
  private slots = new Map<Slot, string>();
  private fresh = new Set<string>();
  private applied: string[] = [];
  private routes = new Map<Slot, Set<(frame: Frame) => void>>();
  private networkFns = new Set<(devices: NetworkDevice[]) => void>();
  private stateFns = new Set<(state: StreamState) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = Promise.resolve();

  start() {
    this.source?.close();
    this.streamId = "";
    this.source = new EventSource("/api/stream");
    this.source.onmessage = (e) => this.receive(JSON.parse(e.data) as MuxFrame);
    // EventSource reconnects on its own; the next hello re-sends the subscriptions.
    this.source.onerror = () => {
      this.streamId = "";
      this.setState(this.source?.readyState === EventSource.CLOSED ? "offline" : "connecting");
      if (this.source?.readyState === EventSource.CLOSED) setTimeout(() => this.start(), 2000);
    };
  }

  stop() {
    clearTimeout(this.timer);
    this.source?.close();
  }

  /** Point a slot at a subscription key (or clear it). A changed key always gets a fresh snapshot. */
  set(slot: Slot, key?: string) {
    if (this.slots.get(slot) === key) return;
    if (key) {
      this.slots.set(slot, key);
      this.fresh.add(key);
    } else this.slots.delete(slot);
    this.schedule();
  }

  route(slot: Slot, fn: (frame: Frame) => void) {
    const set = this.routes.get(slot) ?? new Set();
    set.add(fn);
    this.routes.set(slot, set);
    return () => void set.delete(fn);
  }

  onNetwork(fn: (devices: NetworkDevice[]) => void) {
    this.networkFns.add(fn);
    return () => void this.networkFns.delete(fn);
  }

  onState(fn: (state: StreamState) => void) {
    this.stateFns.add(fn);
    return () => void this.stateFns.delete(fn);
  }

  private setState(state: StreamState) {
    if (state === this.state) return;
    this.state = state;
    for (const fn of this.stateFns) fn(state);
  }

  private receive(m: MuxFrame) {
    const frame = m.frame;
    if (frame.type === "stream") {
      this.streamId = frame.streamId;
      this.applied = [];
      this.setState("live");
      this.schedule(0);
      return;
    }
    if (frame.type === "network") {
      for (const fn of this.networkFns) fn(frame.devices);
      return;
    }
    for (const [slot, key] of this.slots)
      if (key === m.sub) for (const fn of this.routes.get(slot) ?? []) fn(frame);
  }

  private schedule(ms = 30) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flushing = this.flushing.then(() => this.flush());
    }, ms);
  }

  private async flush() {
    const streamId = this.streamId;
    if (!streamId) return;
    const subs = [...new Set(this.slots.values())];
    // A key re-selected while its upstream is still open would get no new snapshot: drop it once.
    const reopen = subs.filter((k) => this.fresh.has(k) && this.applied.includes(k));
    this.fresh.clear();
    if (
      reopen.length &&
      !(await this.put(
        streamId,
        subs.filter((k) => !reopen.includes(k)),
      ))
    )
      return;
    if (subs.join("\n") !== this.applied.join("\n") || reopen.length)
      await this.put(streamId, subs);
  }

  private async put(streamId: string, subs: string[]) {
    try {
      const r = await fetch(`/api/stream/${streamId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subs }),
      });
      if (r.ok) {
        this.applied = subs;
        return true;
      }
      if (r.status === 404 && streamId === this.streamId) this.start();
      else console.warn("subscription rejected", await r.text());
    } catch {
      this.schedule(1000);
    }
    return false;
  }
}
