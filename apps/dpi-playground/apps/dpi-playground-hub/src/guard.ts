import type { RequestHandler } from "express";

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * The hub holds every device token and has no login of its own, so it only answers requests
 * whose Host is one it serves (blocks DNS rebinding) from its own origin (blocks CSRF), and
 * only accepts JSON writes (forces a CORS preflight that cross-origin pages cannot pass).
 */
export function guard(allowedHosts: Set<string>): RequestHandler {
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host))
      return void res.status(421).json(err("invalid", `Unknown Host header: ${host}`));
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {}
      if (originHost !== host)
        return void res
          .status(403)
          .json(err("unauthorized", "Cross-origin requests are not allowed"));
    }
    if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json"))
      return void res.status(415).json(err("invalid", "JSON required"));
    next();
  };
}
