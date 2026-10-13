import { config } from "./config.ts";
import express from "express";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { dataDir, demoDir, repoDir, ttsDir } from "../../../shared/paths.ts";
import { demoState } from "../../../shared/log-store.ts";
import { Jev } from "./jev.ts";
import { Ops } from "./ops.ts";
import { branchReview } from "./repo.ts";
import { Voice } from "./voice.ts";
import { WatchStore } from "./watch-store.ts";
import { Watcher } from "./watcher.ts";

if (!existsSync(join(repoDir, ".git"))) throw Error("Missing the mock repo. Run npm run reset first.");
mkdirSync(dataDir, { recursive: true });

const store = new WatchStore();
const jev = new Jev();
const voice = new Voice(config.tts, ttsDir, config.voiceId, config.voiceModel);
voice.prepare(config.readySpeech);
const ops = await Ops.open(store, voice);
const watcher = new Watcher(
  store,
  jev,
  {
    concurrency: config.jevConcurrency,
    incidentThreshold: config.incidentThreshold,
    suspiciousThreshold: config.suspiciousThreshold,
    windowMs: config.windowMs,
    backlogMs: config.backlogMs,
  },
  (trigger) => ops.openIncident(trigger),
);
watcher.start();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
// Answer only Host names this server serves, so a DNS-rebinding page cannot reach the agent's bash.
const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
if (config.host === "0.0.0.0") {
  const name = hostname().toLowerCase();
  allowedHosts.add(`${name}:${config.port}`);
  allowedHosts.add(`${name.replace(/\.local$/, "")}.local:${config.port}`);
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? []) if (a.family === "IPv4") allowedHosts.add(`${a.address}:${config.port}`);
} else allowedHosts.add(`${config.host}:${config.port}`);
app.use("/api", (req, res, next) => {
  if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
    res.status(403).json({ error: "Unknown host" });
    return;
  }
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    res.status(403).json({ error: "Cross-origin requests are not allowed" });
    return;
  }
  if (!["GET", "HEAD"].includes(req.method) && !req.is("application/json")) {
    res.status(415).json({ error: "JSON required" });
    return;
  }
  next();
});

function sse(res: express.Response) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  return (event: string, data: unknown) => {
    // A slow viewer reconnects to a fresh snapshot instead of buffering indefinitely.
    if (res.writableLength > 2_000_000) res.end();
    else res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

app.get("/api/config", (_req, res) => {
  const models = ops.modelList();
  res.json({
    models,
    defaultModel: models.find((m) => m.id === config.model),
    rootConversationId: ops.root.id,
    jev: jev.provider,
    tts: config.tts,
    thresholds: {
      incident: config.incidentThreshold,
      suspicious: config.suspiciousThreshold,
      windowSeconds: config.windowMs / 1000,
    },
    repo: repoDir,
    version: "1.0.3",
  });
});

// The event stream: every log row as it lands, then its Jev verdict.
app.get("/api/stream", async (req, res) => {
  const send = sse(res);
  const status = () => ({ stats: store.stats(), demo: demoState(store.control()) });
  send("init", { rows: store.recent(400), incidents: await ops.incidents(), ...status() });
  const onLog = (row: unknown) => send("log", row);
  const onVerdict = (verdict: unknown) => send("verdict", verdict);
  const onIncident = (incident: unknown) => send("incident", incident);
  const onSpeech = (speech: unknown) => send("speech", speech);
  watcher.on("log", onLog);
  watcher.on("verdict", onVerdict);
  ops.on("incident", onIncident);
  voice.on("speech", onSpeech);
  const timer = setInterval(() => send("status", status()), 2000);
  req.on("close", () => {
    clearInterval(timer);
    watcher.off("log", onLog);
    watcher.off("verdict", onVerdict);
    ops.off("incident", onIncident);
    voice.off("speech", onSpeech);
  });
});

// One conversation's committed view, pushed after every commit. Closing never cancels work.
app.get("/api/conversations/:cid/events", async (req, res) => {
  const cid = Number(req.params.cid);
  await ops.conversation(cid);
  const send = sse(res);
  let closed = false,
    fetching = false,
    dirty = true,
    previous = "",
    lastSent = 0;
  const unsubscribe = ops.harness.subscribeCommits(() => {
    dirty = true;
  });
  const tick = async () => {
    if (closed || fetching || (!dirty && Date.now() - lastSent < 15000)) return;
    fetching = true;
    dirty = false;
    try {
      const { serverTime, ...stable } = await ops.snapshot(cid);
      const data = JSON.stringify(stable);
      if (!closed && (data !== previous || Date.now() - lastSent > 15000)) {
        send("snapshot", { ...stable, serverTime });
        previous = data;
        lastSent = Date.now();
      }
    } catch (e) {
      if (!closed) {
        send("fault", { error: String(e) });
        res.end();
      }
    } finally {
      fetching = false;
    }
  };
  const timer = setInterval(() => void tick(), 300);
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    unsubscribe();
  });
  void tick();
});

app.post("/api/conversations/:cid/:action", async (req, res) => {
  res.json(await ops.action(Number(req.params.cid), req.params.action, req.body ?? {}));
});

app.get("/api/incidents/:id/review", async (req, res) => {
  const incident = (await ops.incidents()).find((i) => i.id === req.params.id);
  if (!incident) throw Error("Incident not found");
  res.json(branchReview(incident.worktree));
});

app.post("/api/deploys/:id/decide", async (req, res) => {
  const { approved, note } = req.body ?? {};
  if (typeof approved !== "boolean") throw Error("approved must be true or false");
  await ops.decideDeploy(Number(req.params.id), approved, typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null);
  res.json({ ok: true });
});

app.post("/api/demo/deploy-bug", (_req, res) => {
  store.requestBugDeploy();
  res.json({ ok: true });
});

app.use("/api/tts", express.static(ttsDir));
app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[request]", err.message);
  res.status(400).json({ error: err.message });
});

const feDir = resolve(demoDir, "apps/proactive-dpi-fe");
const server = createServer(app);
let vite: Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (config.dev) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    configFile: join(feDir, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(join(feDir, "dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(join(feDir, "dist/index.html")));
}
server.listen(config.port, config.host, () => {
  console.log(
    `Proactive DPI: http://localhost:${config.port}\n  jev ${jev.provider}  model ${config.model}  tts ${config.tts}  incident after ${config.incidentThreshold} incident or ${config.suspiciousThreshold} suspicious verdicts in ${config.windowMs / 1000}s`,
  );
  if (config.host !== "0.0.0.0") return;
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? [])
      if (a.family === "IPv4" && !a.internal) console.log(`  LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  watcher.stop();
  server.close();
  server.closeAllConnections();
  await vite?.close();
  await ops.close();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
