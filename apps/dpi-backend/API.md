# dpi-backend API v1

The contract every Durable Agent Network client uses: the web hub, `dpi-tui`, scripts, other agents. Types live in [`../dpi-sdk/src/api.ts`](../dpi-sdk/src/api.ts). [`../dpi-sdk/src/client.ts`](../dpi-sdk/src/client.ts) is a typed client for browsers and Node.

## Conventions

- **Auth.** Every `/v1/*` route requires `Authorization: Bearer <DPI_TOKEN>`. `X-DPI-Token: <DPI_TOKEN>` also works, for proxies that strip `Authorization`. Only `GET /healthz` is open.
- **Vocabulary.** A **session** is one harness and one agent database on the device. An **agent** is a pi-durable conversation in that session: the root (`Main`), a fork, or a subagent. The agent id is the conversation id.
- **Addressing.** `:s` is a session UUID or its unique name (case-insensitive). `:a` is a numeric agent id, `main`, or a unique agent name. Ambiguous names return `409 ambiguous`.
- **Idempotency.** `POST .../messages` takes a required `requestId`, and pi-durable admits each one exactly once. `POST /sessions`, `POST .../agents` and `POST .../fork` accept an `Idempotency-Key` header of up to 128 characters. A repeat gets the stored response with `Idempotent-Replay: true`. Keys are kept for at least 24h, and reusing a key on another route returns `400 invalid`.
- **Errors.** Every error has the shape `{ "error": { "code", "message" } }`. Codes: `unauthorized` 401, `not_found` 404, `invalid` 400, `busy` 409 (reject-if-busy), `conflict` 409 (stale App State revision), `ambiguous` 409, `unavailable` 503 (session failed to open), `internal` 500. Clients can also see `offline`: the SDK raises it when a device cannot be reached, and the hub's proxy returns it with 502.
- **Versioning.** `/v1` and `apiVersion: 1` in `GET /v1/device` and in every `hello` frame. Changes inside v1 are additive.

## Routes

| Route | Body / query | Returns |
|---|---|---|
| `GET /healthz` | (no auth) | `{ok:true}` |
| `GET /v1/device` | | `DeviceInfo`: uid, name, hostname, platform, `apiVersion`, `durableVersion`, `startedAt`, models, `defaultModel`, `startDirs`, storage, `codeDir` (the checkout it runs from), capabilities, `jobs` (durable job definitions) |
| `GET /v1/tree` | | `DeviceTree`: sessions with agents and busy/background |
| `GET /v1/events` | `?docs=app.shared-state` | device stream |
| `GET /v1/fs/dirs` | `?path=` (empty = start dirs) | `{path, parent, dirs[]}`, one level, directories only |
| `GET /v1/docs/app.shared-state` | | `{kind, value, revision}` |
| `GET /v1/sessions` | | `SessionSummary[]` |
| `POST /v1/sessions` | `{name, cwd, model:{provider,modelId}, thinkingLevel?}` | `201 SessionSummary` |
| `GET / PATCH / DELETE /v1/sessions/:s` | PATCH `{name}` | summary (with its `compaction` thresholds); DELETE aborts all work, moves the files to `archive/` and returns `{archived}` |
| `GET / PATCH /v1/sessions/:s/compaction` | PATCH `{enabled?, reserveTokens?, backgroundTokens?, keepRecentTokens?}` | the session's automatic compaction thresholds, read by pi-durable at its next request. Values are margins: the blocking summary starts at the model's context window minus `reserveTokens`, and the background one `backgroundTokens` earlier (0 turns it off). Default: a background summary at 200k tokens and a blocking one at 250k, or pi-durable's margins on smaller windows. Switching an agent to a window the thresholds do not fit refits them |
| `GET /v1/sessions/:s/events` | | session stream |
| `GET /v1/sessions/:s/tasks` | `?status=live\|terminal&limit=` | task nodes / recent outcomes |
| `POST /v1/sessions/:s/tasks/:taskId/abort` | | `{status}` |
| `GET /v1/sessions/:s/inspect` | | recovery inspection |
| `GET /v1/sessions/:s/stuck` | | `{blocked:[{taskId,kind,conversationId,reason}], queued:[{submissionId,conversationId}]}`: tasks no definition can run (restore it, or abort the task: it ends `orphaned`) and follow-ups queued where no foreground work runs (withdraw them or send a new message). Reads only |
| `POST /v1/sessions/:s/backup` | | `{backup}`: copies the idle session's `agent.sqlite` (and `-wal`/`-shm`) to `$DPI_BACKUP_DIR/<id>-<ms>/`. The session closes for the copy and reopens. `409 conflict` while any task is live or a submission is queued; `503` without `DPI_BACKUP_DIR` |
| `GET /v1/sessions/:s/submissions/:id` | `?waitMs=` (≤300000) | `SendResult`, optionally long-polled |
| `GET / POST /v1/sessions/:s/agents` | POST `{from?, name?}` | `AgentSummary[]` / `201 AgentSummary` |
| `GET / PATCH .../agents/:a` | PATCH `{name}` | `AgentDetail` (config with `readOnly`, every tool with `replay`, `writes` and `offered`, extensions) / summary |
| `GET .../agents/:a/events` | `?docs=demo.job-runs` | agent stream |
| `GET .../agents/:a/entries` | `?scope=all\|active&cursor=&limit=` | `{items, next}` stored history; `limit` defaults to 500 (max 2000). `scope=active` returns `{items}`, the active context, unpaged |
| `GET .../agents/:a/transcript` | `?format=json\|markdown` | normalized transcript |
| `POST .../agents/:a/messages` | `{content, whenBusy?: followUp\|steer\|reject, requestId, waitMs?}` (`whenBusy` defaults to `followUp`; `waitMs` ≤300000) | `202 {submissionId, status:"queued"\|"pending"}`, `200 {status:"done", answer:{entryId,text}}` or `200 {status:"unanswered", reason}` |
| `DELETE .../agents/:a/inbox/:submissionId` | | withdraw a queued input |
| `POST .../agents/:a/abort` | `{background?}` | stops foreground work (and background with `true`) |
| `POST .../agents/:a/fork` | `{entryId, name?}` | `201 AgentSummary` |
| `GET / PATCH .../agents/:a/config` | `{model?, thinkingLevel?, instructions?, cwd?, readOnly?}` | config; applies from the next request. `readOnly` filters the agent's tools to the ones that only read |
| `GET / PATCH .../agents/:a/extensions` | PATCH `{name, enabled}` or `{prompt, enabled}` | `{extensions, builtIn}`: the custom extensions `system-prompts` (a checklist of the prompts in `prompts/`) and `jev-damage-control` (Jev judges each bash command and blocks destructive ones; the command goes to the Jev API, and a Jev error lets it run). Both are off by default. A change applies from the agent's next request |
| `POST .../agents/:a/compact` | `{instructions?}` | `{taskId}` |
| `POST .../agents/:a/reset` | `{note?}` | `{ok}` |
| `GET .../agents/:a/docs/:kind` | `demo.job-runs` | `{kind, value}` |
| `POST .../agents/:a/demo/state` | `{operation, path, value?, expectedRevision?}` | `{ok, value, revision}`: the new App State. A stale `expectedRevision` returns `409 conflict` |
| `POST .../agents/:a/demo/jobs` | `{job, input?}` | `201 {taskId}`: a durable job run the conversation owns in the background, anchored by a `demo.job` entry |
| `POST .../agents/:a/demo/jobs/:taskId/approval` | `{approved}` | `{ok}`; `409 conflict` when the run is not waiting |

## Agent tools

Every agent gets the coding tools `read`, `write`, `edit` and `bash`, plus the playground tools `read_state`, `update_state`, `list_durable_jobs`, `run_durable_job`, `check_durable_job`, `search_history`, `ping_on_call_engineer`, `subagent`, `start_session` and `handoff`. `readOnly` removes the eight that write: `bash`, `write`, `edit`, `update_state`, `run_durable_job`, `ping_on_call_engineer`, `subagent` and `start_session`. `GET .../agents/:a` lists each tool with its replay policy and whether it is offered.

## Durable jobs

A durable job is a repeatable workflow with named phases. Each run is one pi-durable task (`demo.job.<id>`) whose checkpoint phases are the job's phases, so a restart resumes the current phase. The run's record, with every phase and step (commands, a subagent's tool calls, App State writes, checkpoints, the approval), is the conversation document `demo.job-runs`; types are in [`../dpi-sdk/src/jobs.ts`](../dpi-sdk/src/jobs.ts). Every run saves its result to App State under `/jobs/<id>`.

| Job | Phases | Inputs |
|---|---|---|
| `workspace-snapshot` | scan → measure → save → verify | `path` |
| `release-check` | plan → gather (subagent with read and bash) → approve (waits for a person) → publish → verify | `commits` |
| `change-watch` | baseline → watch (one checkpoint per check) → report | `path`, `checks`, `interval_seconds` |

Agents use the playground tools: `list_durable_jobs` (ids, phases, inputs, approval, result path and recent runs with their task ids), `run_durable_job {job, input?, wait?}` and `check_durable_job {task_id? | job?}` (one run's phases, steps and result, a job's latest run, or recent runs). A run starts in the background, owned by the conversation; with `wait: true` the call owns it and waits, so an interrupt stops it. The same extension adds `search_history {query?, tool?, entry?, kind?, from_entry?, to_entry?, order?, limit?, offset?}`, which pages through the agent's whole stored history including entries before a reset or compaction, and `ping_on_call_engineer {summary, severity?}`, a simulated pager (no external call) that is not replay-safe and works once per agent.

## Streams

Server-Sent Events. Each connection sends `hello`, then a snapshot, then deltas, plus a `: ping` comment every 15s. Treat 45s of silence as a dead socket. Reconnects get a fresh snapshot and nothing is replayed (pi-durable's watch semantics). A viewer that falls 2 MB behind is disconnected. Closing a stream never stops work.

```
id: 7
event: batch
data: {"type":"batch","events":[{"type":"message_update", ...}]}
```

| Scope | Frames |
|---|---|
| device `/v1/events` | `tree {tree}` (deduped, coalesced 250ms), `activity {items:[{type:"agent.started"\|"agent.finished", sessionId, agentId, at, preview?}]}`, `doc {kind, value, revision}` |
| session `/v1/sessions/:s/events` | `session {agents, tasks, usage}`, then `agents`, `tasks`, `usage` |
| agent `.../agents/:a/events` | `snapshot {snapshot, inbox}`, `batch {events}` (pi-durable `watchEvents()` verbatim), `inbox {items}` (queued content), `doc {kind, value}` |
| all | `hello {apiVersion, scope, serverTime}` |

The hub's multiplexed stream (`/api/stream`) carries these frames per subscription and adds `stream {streamId}`, `network {devices}`, `fault {error}` and `disconnected {reason}`.

To render a transcript from the agent stream in JS, feed frames to `AgentModel` from the SDK. It handles text/thinking/tool-call deltas, tool output windows, results, resets and overflow snapshots.

## Recipes

```bash
T=<token>; U=https://my-dpi-vm-1.exe.xyz   # any device URL from dpi-network.yaml
# Send work and wait for the answer, all in one request:
curl -s -X POST $U/v1/sessions/my-session/agents/main/messages -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"content":"Summarize the failing tests","requestId":"ci-4812","waitMs":120000}'
# Read the whole conversation as markdown:
curl -s "$U/v1/sessions/my-session/agents/main/transcript?format=markdown" -H "Authorization: Bearer $T" | jq -r .text
# Watch everything on a device:
curl -sN $U/v1/events -H "Authorization: Bearer $T"
```
