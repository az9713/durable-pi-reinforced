import type { RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time check of `Authorization: Bearer <token>`, or `X-DPI-Token` for proxies that strip Authorization. */
export function bearerAuth(token: string): RequestHandler {
  const expected = createHash("sha256").update(token).digest();
  return (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.get("x-dpi-token") ?? "").trim();
    const actual = createHash("sha256").update(presented).digest();
    if (!presented || !timingSafeEqual(actual, expected)) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="dpi"')
        .json({ error: { code: "unauthorized", message: "Missing or invalid device token" } });
      return;
    }
    next();
  };
}
