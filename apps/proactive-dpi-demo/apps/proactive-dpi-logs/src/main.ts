// Mock Cloud Logging sink for Lumen Market. Streams production traffic into logs.sqlite and,
// on schedule or on request, deploys the checkout-api commit that breaks guest checkout.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dataDir, logsDbPath } from "../../../shared/paths.ts";
import { lockFile } from "../../../shared/lock.ts";
import { ensureLogSchema, readControl, writeControl } from "../../../shared/log-store.ts";
import { loadRevision, type Revision } from "./deploys.ts";
import { deployEvents, guestCheckout, nextEvent, type Generated } from "./traffic.ts";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const rate = Number(option("--rate", "2"));
const bugAtOption = option("--bug-at", "5");
const quiet = args.includes("--quiet");
if (!(rate > 0 && rate <= 50)) throw Error("--rate must be between 0 and 50 rows per second");
if (bugAtOption !== "off" && !(Number(bugAtOption) >= 0))
  throw Error("--bug-at takes seconds after start, or off");

mkdirSync(dataDir, { recursive: true });
const unlock = lockFile(`${logsDbPath}.lock`);
const db = new DatabaseSync(logsDbPath);
db.exec("PRAGMA busy_timeout=5000");
ensureLogSchema(db);

const good = await loadRevision("HEAD~1", "checkout-api-00041-rup");
const bad = await loadRevision("HEAD", "checkout-api-00042-vex");
const startedAt = Date.now();
let control = readControl(db);
// A restart keeps whatever revision was live, including a fix the incident agent deployed.
let live: Revision = control.live_commit
  ? await loadRevision(control.live_commit, control.live_revision)
  : control.bug_injected_at
    ? bad
    : good;
writeControl(db, "started_at", String(startedAt));
writeControl(db, "rate", String(rate));
writeControl(db, "good_revision", `${good.name} ${good.commit}`);
writeControl(db, "bad_revision", `${bad.name} ${bad.commit}`);
writeControl(db, "live_revision", live.name);
if (!control.bug_injected_at)
  writeControl(db, "bug_at", bugAtOption === "off" ? null : String(startedAt + Number(bugAtOption) * 1000));

const insert = db.prepare(
  "INSERT INTO logs(insert_id, ts, severity, service, revision, method, route, status, latency_ms, message, error_type, entry) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
);
const COLORS: Record<string, string> = { DEBUG: "90", INFO: "37", NOTICE: "36", WARNING: "33", ERROR: "31" };
function write(row: Generated) {
  const { lastInsertRowid } = insert.run(
    row.entry.insertId,
    row.entry.timestamp,
    row.entry.severity,
    row.service,
    row.revision,
    row.method,
    row.route,
    row.status,
    row.latencyMs,
    row.message,
    row.errorType,
    JSON.stringify(row.entry),
  );
  if (quiet) return;
  const request = row.method ? `${row.method} ${row.route} ${row.status} ${row.latencyMs}ms ` : "";
  console.log(
    `\x1b[${COLORS[row.entry.severity] ?? "37"}m#${lastInsertRowid} ${row.entry.timestamp.slice(11, 19)} ${row.entry.severity.padEnd(7)} ${row.service.padEnd(16)} ${request}${row.message.slice(0, 90)}\x1b[0m`,
  );
}

// A spike of guest checkouts meets every new revision right away. After the bad deploy the failures
// show within a second; after a fix the deploy check sees guests succeed. Both keep the demo timeline predictable.
let burst = 0;

function rollout(to: Revision) {
  for (const row of deployEvents(live, to)) write(row);
  live = to;
  burst = 3;
  writeControl(db, "live_revision", to.name);
  writeControl(db, "live_commit", to.commit);
  schedule(0);
}

function deployBug(reason: string) {
  rollout(bad);
  writeControl(db, "bug_injected_at", String(Date.now()));
  writeControl(db, "inject_request", null);
  console.log(`\x1b[35m>>> ${reason}: ${bad.name} (${bad.commit}) is live. Guest checkouts now fail.\x1b[0m`);
}

/** A deploy the incident agent's durable deploy task asked for, acknowledged once it serves traffic. */
async function deployRequested(raw: string) {
  const request = JSON.parse(raw) as { id: number; commit: string; revision: string };
  if (control.deployed && JSON.parse(control.deployed).id === request.id) return;
  rollout(await loadRevision(request.commit, request.revision));
  writeControl(db, "deployed", JSON.stringify({ ...request, at: Date.now() }));
  writeControl(db, "deploy_request", null);
  console.log(`\x1b[35m>>> Deployed ${request.revision} (${request.commit}).\x1b[0m`);
}

// Deploys land within 100ms of their schedule or request, independent of the traffic rate.
let watching = false;
async function watchControl() {
  if (stopped || watching) return;
  watching = true;
  try {
    control = readControl(db);
    if (!control.bug_injected_at) {
      if (control.inject_request) deployBug("Bug injected on request");
      else if (control.bug_at && Number(control.bug_at) <= Date.now()) deployBug("Scheduled bug deploy");
    }
    if (control.deploy_request) await deployRequested(control.deploy_request);
  } finally {
    watching = false;
  }
}

let stopped = false;
let timer: NodeJS.Timeout | undefined;
let ticking = false;
let wake = false;
function schedule(ms: number) {
  if (ticking) {
    wake = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => void tick().catch(fail), ms);
}
async function tick() {
  if (stopped) return;
  ticking = true;
  const spike = burst > 0;
  if (spike) burst--;
  write(await (spike ? guestCheckout(live) : nextEvent(live)));
  ticking = false;
  // Exponential gaps give bursty, realistic arrival times around the target rate.
  const gap =
    burst > 0 || wake ? 200 : Math.min(3000, Math.max(60, (-Math.log(1 - Math.random()) / rate) * 1000));
  wake = false;
  schedule(gap);
}
function fail(error: unknown) {
  console.error(error);
  shutdown(1);
}
function shutdown(code = 0) {
  stopped = true;
  db.close();
  unlock();
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

const bugAt = readControl(db).bug_at;
console.log(
  `Lumen Market log stream → ${logsDbPath}\n  rate ${rate}/s  live ${live.name} (${live.commit})  ${
    control.bug_injected_at ? "bug already deployed" : bugAt ? `bug deploys in ${Math.round((Number(bugAt) - Date.now()) / 1000)}s` : "bug deploy off"
  }`,
);
setInterval(() => void watchControl().catch(fail), 100);
void tick().catch(fail);
