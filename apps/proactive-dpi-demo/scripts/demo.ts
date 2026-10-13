// Runs the backend and the log stream together, then prints only the URL to open.
// Log flags go to the stream, the rest to the backend: npm start -- --bug-at 5 --tts host
// Process output goes to .data/demo.log, so the terminal can stay on camera. --verbose shows it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { dataDir, demoDir, repoDir } from "../shared/paths.ts";

if (!existsSync(join(repoDir, ".git"))) {
  console.error("Missing the mock repo. Run npm run reset first.");
  process.exit(1);
}

const LOG_FLAGS = new Set(["--rate", "--bug-at"]);
const logArgs: string[] = [];
const beArgs: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (LOG_FLAGS.has(args[i])) logArgs.push(args[i], args[++i]);
  else if (args[i] === "--log-rows" || args[i] === "--verbose") continue;
  else beArgs.push(args[i]);
}
if (!args.includes("--log-rows")) logArgs.push("--quiet");
const verbose = args.includes("--verbose");
const portIndex = beArgs.indexOf("--port");
const port = portIndex < 0 ? 4790 : Number(beArgs[portIndex + 1]);
// The backend binds loopback unless --host asks for the LAN (0.0.0.0) or one address.
const hostIndex = beArgs.indexOf("--host");
const host = hostIndex < 0 ? "127.0.0.1" : beArgs[hostIndex + 1];
const onLan = host === "0.0.0.0";
const reachable = onLan ? "127.0.0.1" : host;

mkdirSync(dataDir, { recursive: true });
const logPath = join(dataDir, "demo.log");
const logFd = openSync(logPath, "a");
const tsx = join(demoDir, "node_modules/.bin/tsx");
const children: ChildProcess[] = [];
let stopping = false;

function run(name: string, script: string, scriptArgs: string[]) {
  const child = spawn(tsx, [script, ...scriptArgs], {
    cwd: demoDir,
    stdio: verbose ? "inherit" : ["ignore", logFd, logFd],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`\n${name} stopped (exit ${code}). Last lines of ${logPath}:\n`);
    console.error(readFileSync(logPath, "utf8").trim().split("\n").slice(-15).join("\n"));
    shutdown(1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

run("backend", "apps/proactive-dpi-be/src/main.ts", beArgs);
const deadline = Date.now() + 60_000;
while (!stopping) {
  try {
    if ((await fetch(`http://${reachable}:${port}/api/config`)).ok) break;
  } catch {}
  if (Date.now() > deadline) {
    console.error(`The backend did not answer on port ${port} within 60s. See ${logPath}.`);
    shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (stopping) await new Promise(() => {}); // shutdown() exits the process
// The stream starts once the backend is listening, so --bug-at counts from the moment the URL shows.
run("log stream", "apps/proactive-dpi-logs/src/main.ts", logArgs);

const lan = Object.values(networkInterfaces())
  .flat()
  .filter(() => onLan)
  .filter((a) => a?.family === "IPv4" && !a.internal)
  .map((a) => `http://${a!.address}:${port}`);
console.log(`
  Proactive Agent is live

    \x1b[1mhttp://${onLan || reachable === "127.0.0.1" ? "localhost" : reachable}:${port}\x1b[0m
${lan.map((url) => `    ${url}`).join("\n")}

  Ctrl+C stops everything.
`);
