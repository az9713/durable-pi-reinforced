// The proactive part: tail the log store, ask Jev about every row, and open an incident when
// judgments cluster. Code owns the thresholds; Jev owns the judgment.
import { EventEmitter } from "node:events";
import type { Decision, LogRow, Verdict } from "../../../shared/types.ts";
import type { ChoiceAnswer, Jev, Question, ScoreAnswer } from "./jev.ts";
import type { WatchStore } from "./watch-store.ts";

export const QUESTIONS: Record<string, Question> = {
  verdict: {
    type: "choice",
    instructions:
      "You watch the production log stream of Lumen Market, an online store. Decide what this one log entry means for the on-call engineer.",
    criteria: {
      normal:
        "Routine and expected. Successful requests, debug and cache output, deploy and autoscaling notices, and expected client outcomes: 404 unknown product, 401 expired session, 402 card declined, 429 rate limit on a scraper bot.",
      suspicious:
        "Worth a look but not clearly broken. Slow queries, upstream timeouts that recovered on retry, unusual warnings.",
      incident:
        "Our code is failing real customers. Unhandled exceptions, stack traces, 5xx responses on core flows such as checkout, crashes, data loss.",
    },
  },
  impact: {
    type: "score",
    instructions: "How much does this entry show customers being hurt?",
    criteria: [
      "No customer impact",
      "Minor or cosmetic",
      "Degraded but working",
      "A customer is blocked from buying or signing in",
      "Many customers blocked and revenue is being lost",
    ],
  },
};

export type Trigger = { fingerprint: string; decision: Decision; logIds: number[] };

/** Groups rows that share a cause: service, route, and the error type, status, or message shape. */
export function fingerprint(row: LogRow): string {
  const kind =
    row.errorType ??
    (row.status !== null && row.status >= 400
      ? `HTTP ${row.status}`
      : row.message
          .replace(/\b(sku|order|user|cart|key|client|category)=\S+/g, "$1=*")
          .replace(/\d+/g, "#")
          .slice(0, 64));
  return [row.service, row.method ? `${row.method} ${row.route}` : null, kind]
    .filter(Boolean)
    .join(" · ");
}

/** What Jev sees: the entry without IDs, traces, and other noise. */
function jevState(row: LogRow) {
  const { message, stack_trace, ...details } = row.entry.jsonPayload ?? { message: row.message };
  return {
    severity: row.severity,
    service: row.service,
    revision: row.revision,
    request: row.method
      ? `${row.method} ${row.route} → ${row.status} in ${row.latencyMs}ms`
      : undefined,
    message,
    stack_trace: stack_trace ? String(stack_trace).split("\n").slice(0, 3).join("\n") : undefined,
    ...details,
  };
}

export class Watcher extends EventEmitter {
  private cursor = 0;
  private queue: LogRow[] = [];
  private active = 0;
  private timer?: NodeJS.Timeout;
  private triggering = new Set<string>();
  /** Row ids queued or in flight, so a retry never queues a row twice. */
  private pending = new Set<number>();

  constructor(
    private readonly store: WatchStore,
    private readonly jev: Jev,
    private readonly options: {
      concurrency: number;
      incidentThreshold: number;
      suspiciousThreshold: number;
      windowMs: number;
      backlogMs: number;
    },
    private readonly onTrigger: (trigger: Trigger) => Promise<void>,
  ) {
    super();
  }

  start() {
    // Rows judged out of order before a restart sit just below the newest verdict.
    this.cursor = Math.max(0, this.store.maxJudged() - 500);
    this.timer = setInterval(() => this.poll(), 300);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  private poll() {
    for (const row of this.store.unjudgedAfter(this.cursor, 200)) {
      this.cursor = Math.max(this.cursor, row.id);
      this.emit("log", row);
      if (Date.now() - Date.parse(row.ts) > this.options.backlogMs) {
        this.record(row, { status: "skipped", error: "Older than the backlog window" });
        continue;
      }
      this.enqueue(row);
    }
    // A failed Jev call is retried at most once a minute while the row is inside the backlog window (about 4 times).
    // ponytail: a verdicts scan every 300 ms; add an index on (status, judged_at) if the table grows past demo size.
    for (const row of this.store.errorsToRetry(60_000, this.options.backlogMs, 50)) this.enqueue(row);
    this.pump();
  }

  private enqueue(row: LogRow) {
    if (this.pending.has(row.id)) return;
    this.pending.add(row.id);
    this.queue.push(row);
  }

  private pump() {
    while (this.active < this.options.concurrency && this.queue.length) {
      const row = this.queue.shift()!;
      this.active++;
      void this.judge(row)
        .catch((e) => console.error("[watcher]", e))
        .finally(() => {
          this.pending.delete(row.id);
          this.active--;
          this.pump();
        });
    }
  }

  private record(row: LogRow, fields: Partial<Verdict>): Verdict {
    const verdict: Verdict = {
      logId: row.id,
      status: "judged",
      fingerprint: fingerprint(row),
      judgedAt: Date.now(),
      ...fields,
    };
    this.store.saveVerdict(verdict, row.ts);
    this.emit("verdict", verdict);
    return verdict;
  }

  private async judge(row: LogRow) {
    let verdict: Verdict;
    try {
      const result = await this.jev.ask(jevState(row), QUESTIONS);
      const choice = result.answers.verdict as ChoiceAnswer;
      const decision = choice.choice as Decision;
      verdict = this.record(row, {
        decision,
        probability: choice.probabilities[decision],
        probabilities: choice.probabilities as Record<Decision, number>,
        impact: (result.answers.impact as ScoreAnswer).score,
        model: result.model,
        latencyMs: result.latencyMs,
        cost: result.cost ?? undefined,
      });
    } catch (e) {
      this.record(row, { status: "error", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    await this.evaluate(verdict);
  }

  private async evaluate(verdict: Verdict) {
    const { decision, fingerprint } = verdict;
    if (decision === "normal" || decision === undefined) return;
    if (decision === "incident" && (verdict.probability ?? 0) < 0.6) return;
    const threshold =
      decision === "incident" ? this.options.incidentThreshold : this.options.suspiciousThreshold;
    const since = new Date(Date.now() - this.options.windowMs).toISOString();
    const logIds = this.store.hits(fingerprint, decision, since);
    if (logIds.length < threshold || this.triggering.has(fingerprint)) return;
    this.triggering.add(fingerprint);
    try {
      await this.onTrigger({ fingerprint, decision, logIds });
    } finally {
      this.triggering.delete(fingerprint);
    }
  }
}
