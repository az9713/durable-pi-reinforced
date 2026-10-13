import { Type } from "@earendil-works/pi-ai";
import {
  ToolTask,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Deploy, Incident, IncidentStatus, StreamRow } from "../../../shared/types.ts";
import { verifyAndCommit } from "./repo.ts";
import type { WatchStore } from "./watch-store.ts";

/** Every incident the watcher opened. Session scoped: shared by all conversations, committed atomically. */
export const Incidents = defineDoc<{ seq: number; items: Record<string, Incident> }>({
  kind: "ops.incidents",
  version: 1,
  scope: "session",
  initial: () => ({ seq: 0, items: {} }),
});

/** Every deploy request and where its durable task stands. Session scoped, so any client can approve it. */
export const Deploys = defineDoc<{ items: Record<string, Deploy> }>({
  kind: "ops.deploys",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
});

/** The incident timeline. An agent reports each stage in order; submit_fix and the deploy finish it. */
const STAGES: IncidentStatus[] = [
  "starting",
  "investigating",
  "root_cause_found",
  "fix_in_progress",
  "ready_for_review",
  "deployed",
];

export function logLine(row: StreamRow): string {
  const v = row.verdict;
  const jev =
    v?.status === "judged"
      ? `jev=${v.decision} ${v.probability?.toFixed(2)}`
      : `jev=${v?.status ?? "pending"}`;
  const request = row.method ? `${row.method} ${row.route} ${row.status} ${row.latencyMs}ms ` : "";
  const error = row.errorType ? ` [${row.errorType}]` : "";
  return `#${row.id} ${row.ts} ${row.severity} ${row.service}@${row.revision} ${request}${row.message}${error} ${jev}`;
}

type DeployInput = { incidentId: string; commit: string };
type DeployState =
  | { phase: "approval" }
  | { phase: "rollout"; revision: string }
  | { phase: "verify"; revision: string; liveAt: number };
type DeployResult = {
  approved: boolean;
  note: string | null;
  revision: string | null;
  checkouts: number;
  guests: number;
  errors: number;
};

export function createExtensions(deps: {
  store: WatchStore;
  /** Called after an incident changed; `announce` means the engineer should hear about it. */
  incidentChanged: (incident: Incident, announce: boolean) => void;
}) {
  const queryLogs = defineTool({
    name: "query_logs",
    description:
      "Search the production log stream (Google Cloud Logging, Cloud Run, project lumen-market-prod). Every row carries the Jev verdict the watcher gave it. Returns newest first. Use full=true for the complete JSON entry, including stack traces.",
    parameters: Type.Object({
      since_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Default 30" })),
      service: Type.Optional(Type.String({ description: "checkout-api, catalog-api, cart-api, auth-api, payments-webhook" })),
      route: Type.Optional(Type.String({ description: "Route template, such as /v1/checkout" })),
      min_severity: Type.Optional(
        Type.Union(["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR"].map((s) => Type.Literal(s))),
      ),
      status: Type.Optional(Type.Integer({ description: "HTTP status" })),
      revision: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ description: "Substring of the raw entry: message, error, stack trace, customer fields" })),
      jev: Type.Optional(
        Type.Union([Type.Literal("normal"), Type.Literal("suspicious"), Type.Literal("incident")]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Default 30" })),
      full: Type.Optional(Type.Boolean()),
    }),
    replay: "safe",
    execute: async (args) => {
      const rows = deps.store.query({
        sinceMinutes: args.since_minutes,
        service: args.service,
        route: args.route,
        severity: args.min_severity,
        status: args.status,
        revision: args.revision,
        text: args.text,
        decision: args.jev,
        limit: args.limit,
      });
      const text = rows.length
        ? rows.map((row) => (args.full ? `${logLine(row)}\n${JSON.stringify(row.entry)}` : logLine(row))).join("\n")
        : "No matching rows.";
      return { content: [{ type: "text", text: `${rows.length} rows, newest first\n${text}` }] };
    },
  });

  const logSummary = defineTool({
    name: "log_summary",
    description:
      "Aggregate the log stream: rows, errors, 5xx, and Jev verdicts per minute; traffic per revision; deploy notices; and the fingerprints Jev flagged. Use it to size impact and line the start of a failure up with a deploy.",
    parameters: Type.Object({
      since_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Default 15" })),
      service: Type.Optional(Type.String()),
    }),
    replay: "safe",
    execute: async (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(deps.store.summary(args.since_minutes ?? 15, args.service), null, 1),
        },
      ],
    }),
  });

  const listIncidents = defineTool({
    name: "list_incidents",
    description: "List incidents the watcher opened, with status, branch, and report.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const doc = await api.snapshot(Incidents, context);
      const items = Object.values(doc?.items ?? {}).map(({ timeline: _, ...incident }) => incident);
      return { content: [{ type: "text", text: items.length ? JSON.stringify(items, null, 1) : "No incidents." }] };
    },
  });

  async function ownIncident(api: ToolExecutionApi, context: Context) {
    const doc = await api.snapshot(Incidents, context);
    const incident = Object.values(doc?.items ?? {}).find((i) => i.conversationId === api.conversationId);
    if (!incident) throw Error("This conversation does not own an incident.");
    return incident as Incident;
  }

  /** Applies one change to this conversation's incident and records it on the timeline. */
  async function changeIncident(api: ToolExecutionApi, context: Context, change: (item: Incident) => void) {
    const incident = await api.commit(async (tx) => {
      const doc = await tx.doc(Incidents);
      const item = Object.values(doc.items).find((i) => i.conversationId === api.conversationId);
      if (!item) throw Error("This conversation does not own an incident.");
      change(item);
      item.updatedAt = Date.now();
      item.timeline.push({ at: item.updatedAt, status: item.status, summary: item.summary });
      return JSON.parse(JSON.stringify(item)) as Incident;
    }, context);
    deps.incidentChanged(incident, false);
    return incident;
  }

  /** The last stage reached, looking past a blocked report. */
  const stageOf = (item: Incident) =>
    item.status !== "blocked"
      ? item.status
      : ([...item.timeline].reverse().find((t) => t.status !== "blocked")?.status ?? "starting");

  const updateIncident = defineTool({
    name: "update_incident",
    description:
      "Move your incident to its next stage on the timeline the engineer watches: investigating, then root_cause_found, then fix_in_progress. Stages go in order and none can be skipped. Use blocked if you cannot proceed. submit_fix and deploy finish the timeline.",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("investigating"),
        Type.Literal("root_cause_found"),
        Type.Literal("fix_in_progress"),
        Type.Literal("blocked"),
      ]),
      summary: Type.String({ description: "One or two sentences for the engineer" }),
      root_cause: Type.Optional(Type.String()),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const incident = await changeIncident(api, context, (item) => {
        const next = STAGES.indexOf(args.status as IncidentStatus);
        const reached = STAGES.indexOf(stageOf(item));
        if (args.status !== "blocked" && next > reached + 1)
          throw Error(`Report ${STAGES[reached + 1]} first. Stages go in order and none can be skipped.`);
        item.status = args.status as IncidentStatus;
        item.summary = args.summary;
        if (args.root_cause) item.report.rootCause = args.root_cause;
      });
      return { content: [{ type: "text", text: `${incident.id} is now ${incident.status}.` }] };
    },
  });

  const submitFix = defineTool({
    name: "submit_fix",
    description:
      "Move the incident to ready_for_review after fix_in_progress. Proves the fix: the changed tests under test/ must fail on main's code and the whole suite must pass on your branch. Then it commits everything on your incident branch. If verification fails it explains why and changes nothing; fix the problem and call it again.",
    parameters: Type.Object({
      summary: Type.String({ description: "One or two sentences for the engineer" }),
      root_cause: Type.String(),
      fix: Type.String({ description: "What the change does" }),
      commit_message: Type.String({ description: "fix(<area>): <what> (<incident id>)" }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const found = await ownIncident(api, context);
      if (!["fix_in_progress", "ready_for_review"].includes(stageOf(found)))
        throw Error("Report fix_in_progress with update_incident first.");
      const proof = verifyAndCommit(found.worktree, args.commit_message);
      const tests = `Regression test on main: ${proof.before}\nFull suite with the fix: ${proof.after}`;
      const incident = await changeIncident(api, context, (item) => {
        item.status = "ready_for_review";
        item.summary = args.summary;
        item.report = {
          rootCause: args.root_cause,
          fix: args.fix,
          tests,
          commit: proof.head,
          diffStat: proof.diffStat,
          deployedRevision: null,
        };
      });
      return {
        content: [
          {
            type: "text",
            text: `Committed ${proof.head} on ${incident.branch}. ${incident.id} is ready for review.\n${tests}\n${proof.diffStat}`,
          },
        ],
      };
    },
  });

  // Approve, roll out, verify. Each phase is checkpointed, so a backend restart resumes the deploy where it stood,
  // including the wait for the engineer. Waiting polls a committed document; Durable Pi has no built-in signal.
  const DeployTask = defineTask<DeployInput, DeployState, DeployResult>({
    name: "ops.deploy",
    version: 1,
    initial: () => ({ phase: "approval" }),
    phases: {
      approval: async (task, runtime, context) => {
        for (;;) {
          const request = (await runtime.snapshot(Deploys, context))?.items[String(task.id)];
          if (request?.status === "declined") {
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: { approved: false, note: request.note, revision: null, checkouts: 0, guests: 0, errors: 0 },
                },
              }),
              context,
            );
            return;
          }
          if (request?.status === "deploying") {
            await runtime.commit(async (tx) => {
              const deploys = await tx.doc(Deploys);
              const seq = 43 + Object.values(deploys.items).filter((d) => d.revision).length;
              const revision = `checkout-api-${String(seq).padStart(5, "0")}-${task.input.commit.slice(0, 3)}`;
              deploys.items[String(task.id)].revision = revision;
              return { status: "running", checkpoint: { phase: "rollout", revision } };
            }, context);
            return;
          }
          await runtime.sleep(runtime.now() + 400, context);
        }
      },
      rollout: async (task, runtime, context) => {
        const { revision } = task.state.checkpoint as { revision: string };
        deps.store.requestDeploy({ id: Number(task.id), commit: task.input.commit, revision });
        const deadline = runtime.now() + 30_000;
        while (deps.store.deployed()?.id !== Number(task.id)) {
          if (runtime.now() > deadline) {
            await runtime.commit(async (tx) => {
              (await tx.doc(Deploys)).items[String(task.id)].status = "failed";
              return {
                status: "terminal",
                outcome: { status: "failed", error: { message: "The log stream did not roll out the revision within 30s." } },
              };
            }, context);
            return;
          }
          await runtime.sleep(runtime.now() + 250, context);
        }
        await runtime.commit(async (tx) => {
          (await tx.doc(Deploys)).items[String(task.id)].status = "verifying";
          return { status: "running", checkpoint: { phase: "verify", revision, liveAt: runtime.now() } };
        }, context);
      },
      verify: async (task, runtime, context) => {
        const { revision, liveAt } = task.state.checkpoint as { revision: string; liveAt: number };
        let stats = deps.store.checkoutStats(revision);
        while (stats.checkouts < 3 && runtime.now() < liveAt + 20_000) {
          await runtime.sleep(runtime.now() + 400, context);
          stats = deps.store.checkoutStats(revision);
        }
        const ok = stats.checkouts > 0 && stats.errors === 0;
        await runtime.commit(async (tx) => {
          const request = (await tx.doc(Deploys)).items[String(task.id)];
          request.status = ok ? "deployed" : "failed";
          request.verification = stats;
          if (!ok)
            return {
              status: "terminal",
              outcome: {
                status: "failed",
                error: { message: `${revision} served ${stats.checkouts} checkouts with ${stats.errors} errors.` },
              },
            };
          const incident = (await tx.doc(Incidents)).items[task.input.incidentId];
          incident.status = "deployed";
          incident.summary = `${revision} is live: ${stats.checkouts} checkouts, ${stats.guests} from guests, 0 errors.`;
          incident.report.deployedRevision = revision;
          incident.updatedAt = runtime.now();
          incident.timeline.push({ at: incident.updatedAt, status: "deployed", summary: incident.summary });
          return {
            status: "terminal",
            outcome: { status: "completed", result: { approved: true, note: request.note, revision, ...stats } },
          };
        }, context);
        const incident = (await runtime.snapshot(Incidents, context))?.items[task.input.incidentId];
        if (incident) deps.incidentChanged(incident as Incident, false);
      },
    },
    // Interrupt aborts the deploy call, and with it this task: nothing ships after a cancel.
    abort: async (task, runtime, context) => {
      deps.store.cancelDeploy(Number(task.id));
      await runtime.commit(async (tx) => {
        const request = (await tx.doc(Deploys)).items[String(task.id)];
        if (request && ["awaiting_approval", "deploying", "verifying"].includes(request.status))
          request.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });

  const PROGRESS: Record<string, string> = {
    awaiting_approval: "Waiting for the engineer to approve the deploy.",
    deploying: "Approved. Rolling out a new checkout-api revision.",
    verifying: "The revision is live. Verifying guest checkouts.",
  };

  const deploy = defineTool({
    name: "deploy",
    description:
      "Ship the fix on your incident branch to production. Asks the on-call engineer to approve and waits durably for the decision, through restarts. When approved, it rolls out a new checkout-api revision built from your commit and verifies live guest checkouts. Call it only after submit_fix. If the engineer declines, do not call it again until they ask.",
    parameters: Type.Object({
      summary: Type.String({ description: "One sentence: what ships and why it is safe" }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const incident = await ownIncident(api, context);
      if (incident.status === "deployed")
        return { content: [{ type: "text", text: `Already deployed as ${incident.report.deployedRevision}.` }] };
      if (incident.status !== "ready_for_review" || !incident.report.commit)
        throw Error("Nothing to deploy yet. Run submit_fix first.");
      const commit = incident.report.commit;
      // A rerun after a crash finds the same request and keeps waiting on the same durable task.
      const { id, announce } = await api.commit(async (tx) => {
        const deploys = await tx.doc(Deploys);
        const existing = Object.values(deploys.items).find((d) => d.toolTaskId === Number(api.taskId));
        if (existing) return { id: existing.id as TaskId<DeployResult>, announce: false };
        const id = await tx.createTask(
          DeployTask,
          { incidentId: incident.id, commit },
          { ownership: { kind: "task", taskId: api.taskId } },
        );
        deploys.items[String(id)] = {
          id: Number(id),
          toolTaskId: Number(api.taskId),
          incidentId: incident.id,
          conversationId: Number(api.conversationId),
          commit,
          branch: incident.branch,
          summary: args.summary,
          diffStat: incident.report.diffStat ?? "",
          status: "awaiting_approval",
          revision: null,
          requestedAt: Date.now(),
          decidedAt: null,
          note: null,
          verification: null,
        };
        const item = (await tx.doc(Incidents)).items[incident.id];
        const announce = !item.announced.ready;
        item.announced.ready = true;
        return { id, announce };
      }, context);
      deps.incidentChanged(incident, announce);
      await api.details({ deployTaskId: Number(id) }, context);

      // Stream each stage of the durable task into this call's live output.
      let shown = "";
      const report = async () => {
        const status = (await api.snapshot(Deploys, context))?.items[String(id)]?.status ?? "";
        if (status === shown || !PROGRESS[status]) return;
        shown = status;
        api.output(`${PROGRESS[status]}\n`);
      };
      await report();
      const progress = setInterval(() => void report().catch(() => {}), 400);
      let settled;
      try {
        settled = await api.waitForTask(id, context);
      } finally {
        clearInterval(progress);
      }
      const outcome = settled.state.outcome;
      if (outcome.status === "completed" && outcome.result.approved) {
        const r = outcome.result;
        return {
          content: [
            {
              type: "text",
              text: `Deployed ${commit} as ${r.revision}. Verified on live traffic: ${r.checkouts} checkouts, ${r.guests} from guests, ${r.errors} errors.`,
            },
          ],
        };
      }
      if (outcome.status === "completed")
        return {
          content: [
            {
              type: "text",
              text: `The engineer declined the deploy${outcome.result.note ? `: ${outcome.result.note}` : ""}. Nothing shipped. Wait for their direction and call deploy again only if they ask.`,
            },
          ],
        };
      throw Error(outcome.status === "failed" ? `Deploy failed: ${outcome.error.message}` : `Deploy ${outcome.status}.`);
    },
  });

  const OpsTools = defineExtension({
    name: "ops-tools",
    tools: [queryLogs, logSummary, listIncidents],
  });

  const Desk = defineExtension({
    name: "ops-desk",
    sections: [
      section(
        "ops_desk",
        () =>
          `You are the Ops desk agent for Lumen Market, an online store running on Google Cloud Run. A proactive watcher sends every production log row to Jev, which labels it normal, suspicious, or incident. When labels with the same fingerprint cluster, the watcher opens an incident and starts a dedicated durable incident agent in its own conversation, on its own git branch of checkout-api. You answer the on-call engineer's questions about the live stream and the open incidents with query_logs, log_summary, and list_incidents. Be brief and specific: numbers, times, revisions. You do not change code.`,
        { tag: false },
      ),
    ],
  });

  const BLOCKED_GIT =
    /\bgit\s+(push|merge|rebase|switch|worktree|reset\s+--hard|branch\s+-[dDmM]|checkout\s+(-b|-B|main\b|master\b))/;
  const IncidentAgent = defineExtension({
    name: "incident-agent",
    tools: [updateIncident, submitFix, deploy],
    tasks: [DeployTask],
    sections: [
      section(
        "incident_playbook",
        () =>
          `You are an incident agent for Lumen Market. The proactive stream watcher started you on its own: Jev flagged a cluster of failing production log rows. The on-call engineer is not watching yet. Work the incident through every stage, in order, so they can follow the timeline when they arrive.

Your working directory is a git worktree of checkout-api, already on your incident branch, created from main. Main is what production runs. Tool calls in one turn run in the order you write them.

1. Investigate. In one turn: update_incident investigating, log_summary for the failing service, and query_logs for the failing rows with full=true and limit 2.
2. Locate. In one turn: bash with git log --oneline -5 and git show of the commit the failing revision was built from, and read the file at the top stack frame.
3. Fix. In one turn: update_incident root_cause_found with the root cause, update_incident fix_in_progress, then write the smallest fix and a regression test under test/ that reproduces the failure. The files are small: write each changed file in full.
4. Review. submit_fix. It proves the test fails on main and the suite passes with your fix, then commits on your branch.
5. Deploy. In one message, write a short review note (impact, root cause, fix, verification) and call deploy. The deploy waits for the engineer's approval.

When deploy returns:
- Declined: acknowledge in one sentence. Answer the engineer's questions. Call deploy again only when they ask.
- Deployed: report the verification in two sentences.

Rules: never push, merge, rebase, switch branches, or touch main. Read logs with tools, not bash. Be concise.`,
        { tag: false },
      ),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) => {
          if (call.name !== "bash") return undefined;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          if (BLOCKED_GIT.test(command))
            return {
              block:
                "Blocked by the incident guard. Stay on your incident branch: no push, merge, rebase, branch switching, or worktree changes. A human reviews and merges.",
            };
          return undefined;
        },
      }),
    ],
  });

  return { OpsTools, Desk, IncidentAgent };
}
