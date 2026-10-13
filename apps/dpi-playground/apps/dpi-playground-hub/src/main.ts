// The playground hub: the local registry of devices (~/.dpi/network.sqlite), their live status,
// a REST proxy that injects device tokens, one multiplexed SSE stream per browser tab, and the
// Vue client. It runs no agents; every agent lives in some device's dpi-backend.
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import { DeviceMonitor } from "./monitor.js";
import { StreamMux } from "./mux.js";
import { proxy } from "./proxy.js";
import { guard } from "./guard.js";
import { seedFromConfig } from "./seed.js";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};
const appDir = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(option("--port", process.env.DPI_HUB_PORT ?? "4781"));
const host = option("--host", process.env.DPI_HUB_HOST ?? "127.0.0.1");

const registry = new NetworkRegistry();
const configFile = seedFromConfig(registry, appDir);
const monitor = new DeviceMonitor(registry);
monitor.start();
const mux = new StreamMux(registry, monitor);

const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
if (host !== "127.0.0.1" && host !== "localhost") {
  allowedHosts.add(`${hostname().toLowerCase()}:${port}`);
  allowedHosts.add(
    `${hostname()
      .toLowerCase()
      .replace(/\.local$/, "")}.local:${port}`,
  );
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? [])
      if (a.family === "IPv4") allowedHosts.add(`${a.address}:${port}`);
}

const err = (code: string, message: string) => ({ error: { code, message } });
type Handler = (req: express.Request, res: express.Response) => unknown;
const safe =
  (fn: Handler): express.RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      if (!res.headersSent)
        res
          .status(status)
          .json(err(status === 404 ? "not_found" : "invalid", (e as Error).message));
    }
  };

const app = express();
app.disable("x-powered-by");
app.use("/api", guard(allowedHosts), express.json({ limit: "256kb" }));

app.get("/api/network", (_req, res) => res.json({ configFile, devices: monitor.network() }));
// Devices are configured in dpi-network.yaml and `just net register`; the hub only reads them.
app.post(
  "/api/devices/:id/check",
  safe(async (req, res) => {
    const id = String(req.params.id);
    if (!registry.get(id)) throw Object.assign(Error(`No device ${id}`), { status: 404 });
    monitor.check(id);
    res.json(await monitor.settled(id));
  }),
);
app.get("/api/ui-state/:key", (req, res) =>
  res.json({ value: registry.uiGet(String(req.params.key)) ?? null }),
);
app.put(
  "/api/ui-state/:key",
  safe((req, res) => {
    registry.uiSet(String(req.params.key), req.body?.value ?? null);
    res.json({ ok: true });
  }),
);
app.get("/api/stream", (req, res) => mux.open(req, res));
app.put(
  "/api/stream/:streamId",
  safe((req, res) => res.json(mux.subscribe(String(req.params.streamId), req.body?.subs))),
);
app.all("/api/devices/:id/v1/{*rest}", proxy(registry, monitor));
app.use("/api", (_req, res) => res.status(404).json(err("not_found", "API route not found")));

const server = createServer(app);
let vite: Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (args.includes("--dev")) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    configFile: resolve(appDir, "apps/dpi-playground-fe/vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(resolve(appDir, "apps/dpi-playground-fe/dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(appDir, "apps/dpi-playground-fe/dist/index.html")),
  );
}

server.listen(port, host, () => {
  console.log(`Durable Pi hub: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(
    `registry: ${registry.path}${configFile ? `  config: ${configFile}` : "  (no dpi-network.yaml)"}`,
  );
  console.log(
    `devices: ${
      registry
        .list()
        .map((d) => d.id)
        .join(", ") || "none"
    }`,
  );
  if (host !== "127.0.0.1" && host !== "localhost")
    console.warn(
      `WARNING: the hub is listening on ${host}. Anyone who can reach it can drive every device it holds tokens for.`,
    );
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  monitor.stop();
  server.close();
  server.closeAllConnections();
  await vite?.close();
  registry.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
