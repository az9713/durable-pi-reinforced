# dpi-sdk

The shared contract of the Durable Agent Network. Every client in this repo (the hub, the web client, `dpi-tui`, the test suites and `just net`) builds on it, and so can yours. It has no runtime dependencies in `src/`, and everything outside `src/node/` also runs in browsers. `src/node/` uses `yaml`, `node:sqlite` and child processes, so it needs Node 22.19 or newer (the repo pins 24).

The apps import it by relative path (`../../dpi-sdk/src/client.ts`, or `@sdk/*` in the Vite client). It is not published to npm.

## Layout

| File | Exports |
|---|---|
| `src/api.ts` | The v1 wire contract: `DeviceInfo`, `DeviceTree`, `SessionSummary`, `AgentSummary`, `AgentDetail`, `SendResult`, `TaskNode`, `WireEntry`, the stream `Frame` and the hub's `MuxFrame`, `API_VERSION`, `THINKING_LEVELS` and the compaction defaults and helpers |
| `src/client.ts` | `DpiClient` (device, tree, dirs, sessions, createSession, device docs and events, plus raw `request` and `stream`), `SessionHandle` (get, rename, archive, agents, createAgent, tasks, abortTask, inspect, compaction, setCompaction, submission, events), `AgentHandle` (get, rename, `send` with a `whenBusy` of follow-up, steer or reject, withdraw, abort, fork, config, configure, compact, reset, entries, transcript, doc, extensions, setExtension, demo for App State edits and job runs, events) and `follow()`, which keeps a stream open with backoff |
| `src/sse.ts` | `readSse()`, a fetch-based SSE reader that works in browsers and Node |
| `src/models.ts` | Reducers that turn frames into view state: `AgentModel` (transcript items, live tools, inbox, usage), `SessionModel` (agents, tasks, lineage) and `NetworkModel` with `networkTree()` |
| `src/transcript.ts` | `toTranscript()` (the items both clients render), `toMarkdown()`, `sumUsage()` and message text helpers |
| `src/app-state.ts` | App State paths and changes: `readState()`, `changeState()`, `replaceState()` |
| `src/jobs.ts` | Durable job definitions and run records (`JobDef`, `JobRun`, the `demo.job-runs` document) |
| `src/errors.ts` | `DpiError` with the API error code, and `isDpiError()` |
| `src/node/registry.ts` | `NetworkRegistry`: the client-side device registry in `~/.dpi/network.sqlite` (URLs, tokens, live status, UI state), and `toPublic()`, the token-free view the hub serves |
| `src/node/config.ts` | Parses `dpi-network.yaml` (found by walking up from the working directory, or `DPI_NETWORK_FILE`) and syncs it into the registry |
| `src/node/drivers.ts`, `ops.ts` | One driver per device kind (`local`, `ssh`, `exe-dev`, `url`) with the steps behind `just net` |
| `scripts/net.ts` | The ops CLI behind every `just net` recipe. From this folder: `npx tsx scripts/net.ts <verb> [device]` or `npm run net -- <verb> [device]`. `help` lists the verbs |

## Use it

Send work and wait for the answer in one request:

```ts
import { DpiClient } from "./src/client.ts";

const client = new DpiClient("http://127.0.0.1:4780", process.env.DPI_TOKEN);
const agent = client.agent("my-session", "main");
const result = await agent.send("Summarize the failing tests", "followUp", "ci-4812", 120_000);
if (result.status === "done") console.log(result.answer.text);
```

The `requestId` (`ci-4812`) makes the send idempotent: retry with the same id and the device admits it once.

Render a live transcript. The stream sends `hello`, a snapshot, then deltas, and a reconnect starts from a fresh snapshot:

```ts
import { follow } from "./src/client.ts";
import { AgentModel } from "./src/models.ts";

const model = new AgentModel();
model.subscribe(() => render(model.state.items));
const stop = new AbortController();
const following = follow(
  (signal) => agent.events(signal),
  (frame) => model.apply(frame),
  (state) => console.log("stream", state), // connecting | live | offline | unauthorized | gone
  stop.signal,
);
```

`follow()` reconnects with backoff, and each reconnect starts from a fresh snapshot. Its promise resolves only after `stop.abort()`, or when the device answers `unauthorized` or `not_found`, so don't await it on your main path. Closing the stream never stops the agent.

## Test

```bash
npm run check   # strict types
npm test        # SSE parsing, reducers against a recorded stream, compaction, App State, YAML config, registry
```
