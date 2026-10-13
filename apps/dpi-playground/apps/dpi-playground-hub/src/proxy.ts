// REST proxy: /api/devices/:id/v1/... → <device url>/v1/... with the device token injected.
// Streams never go through here; browsers get them from the mux (one connection per tab).
import type { RequestHandler } from "express";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor } from "./monitor.js";

const err = (code: string, message: string) => ({ error: { code, message } });

export function proxy(registry: NetworkRegistry, monitor: DeviceMonitor): RequestHandler {
  return async (req, res) => {
    const id = String(req.params.id);
    const device = registry.get(id);
    if (!device) return void res.status(404).json(err("not_found", `No device ${id}`));
    const live = monitor.state(id);
    if (live?.status !== "online" || !device.token)
      return void res
        .status(503)
        .json(
          err(
            "unavailable",
            `${device.name} is ${live?.status ?? "checking"}${live?.error ? `: ${live.error}` : ""}`,
          ),
        );
    const prefix = `/api/devices/${encodeURIComponent(id)}`;
    const path = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : req.originalUrl;
    if (/\/events(\?|$)/.test(path))
      return void res.status(400).json(err("invalid", "Streams are served by /api/stream"));
    const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method);
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    try {
      const upstream = await fetch(device.url + path, {
        method: req.method,
        headers: {
          authorization: `Bearer ${device.token}`,
          "x-dpi-token": device.token,
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(req.get("idempotency-key") ? { "idempotency-key": req.get("idempotency-key")! } : {}),
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.any([closed.signal, AbortSignal.timeout(330_000)]),
      });
      const text = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get("content-type") ?? "application/json")
        .send(text);
    } catch (e) {
      if (closed.signal.aborted) return;
      monitor.check(id);
      res
        .status(502)
        .json(err("offline", `${device.name} did not answer: ${(e as Error).message}`));
    }
  };
}
