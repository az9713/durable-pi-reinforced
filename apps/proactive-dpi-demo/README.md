# Proactive DPI demo

A proactive durable agent. A watcher sends every production log row to Jev. When failures cluster, code opens an incident and starts a Durable Pi agent. The agent works the incident timeline on its own git branch, then asks you out loud to approve the deploy and waits durably for your decision.

See the [repository README](../../README.md#the-hook-a-proactive-durable-agent) for why it matters. The root `/install` command sets it up. Vue 3 + Vite, TypeScript Node, `@earendil-works/pi-durable` **1.0.3** on SQLite. Node **24.14+**.

## Run

```bash
cd apps/proactive-dpi-demo
npm install
npm run reset   # fresh databases and a checkout-api git repo whose HEAD carries the bug
npm run build
npm start       # prints the URL to open
```

From the project root, `just proactive` lists install, build, reset, start, take, dev, be, stream, tail, open, bug and stop. `just proactive take` resets and starts a fresh take, `just proactive bug` deploys the bug on demand, and `just proactive stop` ends a running demo.

`npm start` boots the backend, starts the log stream, and prints a short banner with the URL. The terminal shows nothing else, so it can stay on camera. Process output goes to `.data/demo.log`; `--verbose` shows it instead.

Keys come from the project root `.env`. `OPENROUTER_API_KEY` covers Claude Sonnet 5.5 and Jev (`~typesafe/jev-latest`). `ELEVENLABS_API_KEY` covers the voice (default voice Emma from the ElevenLabs voice library; set `ELEVENLABS_VOICE_ID` to any voice in your account). Without it the line shows only as a toast. With `--tts browser` (the default off macOS), click the page once so the browser allows audio. `TYPESAFE_API_KEY`, when set, sends Jev calls to TypeSafe directly. `npm run dev` adds Vue hot reload. `npm run logs` and `npm run be` run the two processes separately.

Run `npm run reset` before every take. The demo must be stopped first.

## Demo timeline

The clock starts when the URL prints. Measured on 2026-10-05 across 2 runs with Sonnet 5.5 on high thinking:

| Time | What happens |
| --- | --- |
| T+0s | URL prints. Healthy traffic streams and Jev judges every row |
| T+5.0s | Revision 00042 deploys. A spike of guest checkouts hits it and fails |
| T+5.8s to T+5.9s | Jev labels 3 rows incident. The incident opens (Detected) and its durable agent starts |
| about T+8s | Investigating: `log_summary` and `query_logs` |
| about T+18s | Root cause found, then Fixing: `git show`, `read`, the fix, and a regression test |
| about T+21s | Ready for review: `submit_fix` proves the test fails on main, passes on the branch, and commits |
| T+25.3s to T+30.3s | The agent calls `deploy`, which waits for approval. The voice line plays: "Engineer, your Durable Agent Red Team found a production issue, and found the fix. It's waiting on your review." |

Open the URL after the voice line. The page opens on the incident agent with **Deploy waiting for your approval** above the composer. The live take continues:

1. **Cancel.** Press **Interrupt** or **Decline**. Interrupt aborts the deploy call and its durable task; Decline returns the decision to the agent. Nothing ships.
2. **Ask.** Ask the agent about the deploy. It answers without deploying.
3. **Deploy.** Ask it to deploy. It calls `deploy` again and a new approval appears.
4. **Approve.** Click **Approve deploy**. The stream rolls out `checkout-api-00043-<first 3 characters of the fix commit>` built from the agent's fix, guest checkouts succeed, and the incident moves to Deployed. Rollout plus verification takes about 3 seconds.

The timeline depends on Jev. Up to 6 Jev calls run at once, and 429, 502, 503 and 529 answers are retried up to 3 times. During a longer Jev outage, rows show `jev error` and the incident opens only once Jev recovers. Check with `just proactive tail` and run another take.

| Flag | Default | Effect |
| --- | --- | --- |
| `--bug-at <s\|off>` | `5` | Seconds after the URL prints before the bad commit deploys |
| `--rate <n>` | `2` | Log rows per second (up to 50) |
| `--tts host\|browser\|both\|off` | `host` on macOS, else `browser` | Where the voice plays. `host` uses `afplay` on the backend Mac, `browser` plays in every open client |
| `--announce-open` | off | Also speak when the incident opens (`DPI_OPENED_SPEECH`) |
| `--incident-threshold <n>` | `3` | Incident verdicts (probability 0.6 or more) with one fingerprint that open an incident |
| `--suspicious-threshold <n>` | `8` | Suspicious verdicts with one fingerprint that open an incident |
| `--window <s>` | `120` | Window for both thresholds |
| `--model <id>` | `anthropic/claude-sonnet-5.5` | Agent model (OpenRouter). Switchable per conversation in the UI |
| `--thinking <level>` | `high` | Agent thinking level |
| `--verbose` | off | Show process output in the terminal |
| `--log-rows` | off | Print every log row (with `--verbose`) |
| `--port <n>` | `4790` | UI and API port |
| `--host <addr>` | `127.0.0.1` | Bind address. `0.0.0.0` serves the LAN; the UI has no login and the agent runs bash |
| `--backlog <s>` | `300` | Rows older than this when first seen are marked skipped instead of judged |
| `--jev-concurrency <n>` | `6` | Jev calls in flight |

Example: `npm start -- --bug-at 30`. The flask icon in the top bar shows the countdown and can deploy the bug on demand. `DPI_READY_SPEECH` changes the spoken line. It plays when the agent first asks to deploy, and is synthesized at boot so it plays without delay. `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL` override the voice. One incident costs about $0.09 of Sonnet 5.5 through deploy, and Jev costs about $0.00003 per row.

## How it works

1. **proactive-dpi-logs** runs the real checkout-api code. It `git archive`s `HEAD~1` as revision `00041-rup` and `HEAD` as `00042-vex`, then writes Google Cloud Run `LogEntry` rows to `.data/logs.sqlite`. Traffic carries routine warnings (slow queries, upstream retries, a rate-limited scraper); the only failures are the ones a bad deploy causes.
   - At `--bug-at` it writes two deploy rows and routes checkout to 00042. Three guest checkouts follow 200ms apart and throw a real `TypeError` with a real stack trace.
   - It also rolls out any revision the deploy task requests, built from the incident branch commit.
2. **The watcher** in proactive-dpi-be tails the store and makes one Jev call per row, a `choice` verdict plus an `impact` score. It stores the verdict in `.data/watch.sqlite`. Code owns the thresholds; Jev owns the judgment.
3. **Opening an incident** is one Durable Pi commit. It writes the incident to the session document `ops.incidents` and creates an ownerless conversation with the `--model` (Sonnet 5.5 by default), the coding tools (`read`, `write`, `edit`, `bash`), the ops tools (`query_logs`, `log_summary`, `list_incidents`, `update_incident`, `submit_fix`, `deploy`), and the incident playbook. The Ops desk has only the first three ops tools. Its `cwd` is the incident worktree. The backend creates `workspace/incidents/inc-000N` on branch `incident/inc-000N`, then submits the brief (flagged rows and stack trace) with request ID `incident:<id>:brief`.
4. **The incident agent** works the timeline in order. Tool calls run sequentially, so the chat reads like the timeline:
   - `update_incident investigating`, `log_summary`, and `query_logs`
   - `git show` and `read`
   - `update_incident root_cause_found` and `fix_in_progress`, then the fix and a regression test
   - `submit_fix`, which runs the changed tests against `main` (they must fail) and the full suite on the branch (it must pass), then commits
   - `deploy`
   
   The tools refuse a skipped stage. A `beforeTool` hook blocks `git push`, `merge`, `rebase`, `reset --hard`, branch switching, deleting or renaming branches, and worktree changes.
5. **The deploy** is the `ops.deploy` durable task, owned by the `deploy` tool call. Its phases are checkpointed:
   - `approval` waits for the engineer's decision in the session document `ops.deploys`.
   - `rollout` asks the stream for the new revision and waits up to 30 seconds for it to serve.
   - `verify` waits up to 20 seconds for 3 checkouts on the revision and passes with at least one checkout and 0 errors.
   
   The tool streams each phase into its live output. Interrupt aborts the tool, which aborts the task it owns. A backend restart resumes the task in its phase and reruns the replay-safe tool, which finds the same task.
6. **The UI** has two columns.
   - Left is the agent chat: the Ops desk (root conversation) plus one tab per incident. The collapsible incident card shows the six stages, the report, and the diff. The deploy approval sits above the composer.
   - Right is the event stream. Every row arrives as `judging`, then gets its Jev decision. Click a row for the probabilities and the raw entry.

## Durability, verified 2026-10-05

- **Restart mid-run.** SIGKILL the backend during a run and restart it. The run resumes and answers.
- **Restart while waiting for approval.** SIGKILL the backend while the deploy waits. After restart, the same deploy task is still awaiting approval and the same tool call is waiting on it. Nothing is duplicated and the voice does not replay.
- **No duplicate briefs.** On restart, every incident brief is resubmitted with its request ID. One brief remains and no run repeats.
- **No lost rows.** The watcher re-judges rows that were in flight. Rows older than `--backlog` seconds (default 300) are marked skipped instead of judged.
- **Viewers only.** Browsers subscribe to committed state over SSE. Closing every tab never stops work.

## Layout

| Path | Role |
| --- | --- |
| `scripts/demo.ts`, `scripts/reset.ts` | `npm start` (backend + stream, one URL) and `npm run reset` |
| `shared/` | Paths, the log store and types shared by both processes |
| `apps/proactive-dpi-logs/` | Mock Cloud Logging sink: traffic, deploys, bug injection |
| `apps/proactive-dpi-be/src/main.ts`, `config.ts` | HTTP API, SSE streams, flags and env |
| `apps/proactive-dpi-be/src/watcher.ts` | Jev questions, fingerprints, thresholds |
| `apps/proactive-dpi-be/src/ops.ts` | Harness, Ops desk, atomic incident open, recovery |
| `apps/proactive-dpi-be/src/extensions.ts` | `ops.incidents` and `ops.deploys` docs, the `ops.deploy` task, tools, playbook, git guard hook |
| `apps/proactive-dpi-be/src/jev.ts`, `watch-store.ts`, `repo.ts` | Jev client, verdict store, branch diffs for review |
| `apps/proactive-dpi-be/src/voice.ts` | ElevenLabs speech, host or browser playback |
| `apps/proactive-dpi-fe/` | Two-column UI in the dpi-playground theme |
| `mock-repo-template/` | Three commit overlays that `npm run reset` turns into `workspace/checkout-api` |
| `workspace/` | The checkout-api repo and one worktree per incident (created by reset) |
| `.data/` | `logs.sqlite`, `watch.sqlite`, `agent.sqlite`, `tts/`, `deploys/`, `demo.log` |

## Boundaries

This is a local demo with no authentication, and the incident agent's `bash` runs as you, unsandboxed. So the backend binds `127.0.0.1`, and `/api` answers only its own Host names (no DNS rebinding), rejects cross-origin requests and accepts only JSON writes. `--host 0.0.0.0` exposes it to your LAN; use it only on a network you trust. An approved revision's code runs inside the log-stream process. `logs.sqlite` and `agent.sqlite` each have one owner process, enforced by a PID lock.
