---
description: Understand Durable Pi: durable agents that run on any device, the v1 API, the web and terminal clients, and the proactive incident agent demo
---

# Purpose

Orient yourself in the Durable Pi repo. Durable pi agents live on a device that runs `dpi-backend` and commit every step to SQLite, so their work survives restarts and outlives every client. Thin clients (the web hub, `dpi-tui`, curl) reach them by URL and bearer token.

## Workflow

1. Run `git ls-files`, skipping `ai_docs/`, `images/`, icons and lockfiles. The apps are `apps/dpi-sdk`, `apps/dpi-backend`, `apps/dpi-playground` (hub and Vue client), `apps/dpi-tui` and `apps/proactive-dpi-demo`.
2. Read `README.md`, `justfile`, `just/*/mod.just` and `dpi-network.example.yaml`. The real `dpi-network.yaml` is gitignored and is the only place that names machines. Every device recipe takes a device id from it, and only exe.dev VMs named there may be touched.
3. Read `apps/dpi-backend/README.md` and `apps/dpi-backend/API.md`, then skim `apps/dpi-backend/src/store.ts`, `routes.ts`, `streams.ts`, `jobs.ts` and `addons.ts`.
4. Read `apps/dpi-sdk/README.md`, then `apps/dpi-sdk/src/api.ts` (wire contract), `client.ts` (`DpiClient`, `follow`) and `models.ts` (`AgentModel`, `SessionModel`, network tree). The web client and the TUI render the same transcript items from these.
5. Read `apps/dpi-playground/README.md` and `apps/dpi-tui/README.md`. For operating devices, read `.claude/skills/agent-sandboxes-exe-dev/cookbook/dpi-network.md`.
6. Read `apps/proactive-dpi-demo/README.md`, then skim `apps/proactive-dpi-demo/apps/proactive-dpi-be/src/watcher.ts` (Jev questions, thresholds), `ops.ts` (atomic incident open, recovery) and `extensions.ts` (tools, the `ops.deploy` approval task, the playbook).
7. For pi-durable itself, read `ai_docs/durable_pi/readme.md`.
8. Summarize the purpose, stack, structure, entry points (`just backend run`, `just hub start`, `just tui attach <device>`, `just net up|status|deploy|logs|restart <device>`, `just proactive take`), persistence (device catalog, one `agent.sqlite` per session, device App State, hub registry) and test commands (`just check`, `just test ui`, `just test device|e2e <device>`). Note that closing a client never stops an agent, and that a device restart resumes unfinished work from its checkpoints.
