import type { RequestHandler } from "express";
import type { Store } from "./store.js";

/** Replays the stored response for a repeated `Idempotency-Key` on create routes. */
export function idempotent(store: Store): RequestHandler {
  return (req, res, next) => {
    const key = req.get("idempotency-key");
    if (!key) return next();
    if (key.length > 128) return void res.status(400).json({ error: { code: "invalid", message: "Idempotency-Key too long" } });
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const stored = store.replay(key, route);
    if (stored) return void res.status(stored.status).set("Idempotent-Replay", "true").json(stored.body);
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) store.remember(key, route, res.statusCode, body);
      return json(body);
    };
    next();
  };
}
