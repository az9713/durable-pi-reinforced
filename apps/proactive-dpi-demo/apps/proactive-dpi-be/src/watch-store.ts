// watch.sqlite holds one Jev verdict per log row. The mock log store is attached read-mostly as `lg`.
import { DatabaseSync } from "node:sqlite";
import { logsDbPath, watchDbPath } from "../../../shared/paths.ts";
import {
  LOG_COLUMNS,
  ensureLogSchema,
  readControl,
  toLogRow,
  writeControl,
} from "../../../shared/log-store.ts";
import type { Decision, LogRow, StreamRow, Verdict } from "../../../shared/types.ts";

export type LogQuery = {
  sinceMinutes?: number;
  service?: string;
  route?: string;
  severity?: string;
  status?: number;
  revision?: string;
  text?: string;
  decision?: Decision;
  limit?: number;
};

const SEVERITY_RANK = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"];
const PREFIXED_COLUMNS = LOG_COLUMNS.split(", ")
  .map((c) => `l.${c}`)
  .join(", ");
const VERDICT_COLUMNS =
  "v.status AS vStatus, v.fingerprint AS vFingerprint, v.decision AS vDecision, v.probability AS vProbability, v.probabilities AS vProbabilities, v.impact AS vImpact, v.model AS vModel, v.latency_ms AS vLatencyMs, v.cost AS vCost, v.error AS vError, v.judged_at AS vJudgedAt";

function toStreamRow(record: Record<string, unknown>): StreamRow {
  const row: StreamRow = toLogRow(
    Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith("v"))),
  );
  if (record.vStatus)
    row.verdict = {
      logId: row.id,
      status: record.vStatus as Verdict["status"],
      fingerprint: String(record.vFingerprint),
      decision: (record.vDecision as Decision) ?? undefined,
      probability: (record.vProbability as number) ?? undefined,
      probabilities: record.vProbabilities ? JSON.parse(String(record.vProbabilities)) : undefined,
      impact: (record.vImpact as number) ?? undefined,
      model: (record.vModel as string) ?? undefined,
      latencyMs: (record.vLatencyMs as number) ?? undefined,
      cost: (record.vCost as number) ?? undefined,
      error: (record.vError as string) ?? undefined,
      judgedAt: Number(record.vJudgedAt),
    };
  return row;
}

export class WatchStore {
  readonly db = new DatabaseSync(watchDbPath);

  constructor() {
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.prepare("ATTACH DATABASE ? AS lg").run(logsDbPath);
    ensureLogSchema(this.db, "lg");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verdicts(
        log_id INTEGER PRIMARY KEY,
        log_ts TEXT NOT NULL,
        status TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        decision TEXT,
        probability REAL,
        probabilities TEXT,
        impact REAL,
        model TEXT,
        latency_ms INTEGER,
        cost REAL,
        error TEXT,
        judged_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verdicts_hits ON verdicts(fingerprint, decision, log_ts);
    `);
  }

  /** Rows after `id` that have no verdict yet, oldest first. */
  unjudgedAfter(id: number, limit: number): LogRow[] {
    return this.db
      .prepare(
        `SELECT ${PREFIXED_COLUMNS} FROM lg.logs l LEFT JOIN verdicts v ON v.log_id = l.id WHERE l.id > ? AND v.log_id IS NULL ORDER BY l.id LIMIT ?`,
      )
      .all(id, limit)
      .map((r) => toLogRow(r));
  }

  /** Rows whose Jev call failed at least `ageMs` ago and whose log time is still inside the backlog window. */
  errorsToRetry(ageMs: number, backlogMs: number, limit: number): LogRow[] {
    return this.db
      .prepare(
        `SELECT ${PREFIXED_COLUMNS} FROM lg.logs l JOIN verdicts v ON v.log_id = l.id WHERE v.status = 'error' AND v.judged_at < ? AND v.log_ts > ? ORDER BY l.id LIMIT ?`,
      )
      .all(Date.now() - ageMs, new Date(Date.now() - backlogMs).toISOString(), limit)
      .map((r) => toLogRow(r));
  }

  maxJudged(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(log_id), 0) AS id FROM verdicts").get();
    return Number(row?.id ?? 0);
  }

  saveVerdict(verdict: Verdict, logTs: string) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO verdicts(log_id, log_ts, status, fingerprint, decision, probability, probabilities, impact, model, latency_ms, cost, error, judged_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        verdict.logId,
        logTs,
        verdict.status,
        verdict.fingerprint,
        verdict.decision ?? null,
        verdict.probability ?? null,
        verdict.probabilities ? JSON.stringify(verdict.probabilities) : null,
        verdict.impact ?? null,
        verdict.model ?? null,
        verdict.latencyMs ?? null,
        verdict.cost ?? null,
        verdict.error ?? null,
        verdict.judgedAt,
      );
  }

  /** Newest rows with their verdicts, oldest first. */
  recent(limit: number): StreamRow[] {
    return this.db
      .prepare(
        `SELECT * FROM (SELECT ${PREFIXED_COLUMNS}, ${VERDICT_COLUMNS} FROM lg.logs l LEFT JOIN verdicts v ON v.log_id = l.id ORDER BY l.id DESC LIMIT ?) ORDER BY id`,
      )
      .all(limit)
      .map(toStreamRow);
  }

  rows(ids: number[]): StreamRow[] {
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT ${PREFIXED_COLUMNS}, ${VERDICT_COLUMNS} FROM lg.logs l LEFT JOIN verdicts v ON v.log_id = l.id WHERE l.id IN (${ids.map(() => "?").join(",")}) ORDER BY l.id`,
      )
      .all(...ids)
      .map(toStreamRow);
  }

  /** Log IDs with this fingerprint and decision since `sinceIso`. */
  hits(fingerprint: string, decision: Decision, sinceIso: string): number[] {
    return this.db
      .prepare(
        "SELECT log_id FROM verdicts WHERE fingerprint = ? AND decision = ? AND log_ts >= ? ORDER BY log_id",
      )
      .all(fingerprint, decision, sinceIso)
      .map((r) => Number(r.log_id));
  }

  /** Verdict counts per fingerprint for non-normal decisions since `sinceIso`. */
  fingerprintCounts(sinceIso: string) {
    return this.db
      .prepare(
        "SELECT fingerprint, decision, COUNT(*) AS count, MIN(log_ts) AS first, MAX(log_ts) AS last FROM verdicts WHERE decision IN ('suspicious','incident') AND log_ts >= ? GROUP BY fingerprint, decision ORDER BY count DESC",
      )
      .all(sinceIso) as {
      fingerprint: string;
      decision: Decision;
      count: number;
      first: string;
      last: string;
    }[];
  }

  query(q: LogQuery): StreamRow[] {
    const where = ["l.ts >= ?"];
    const params: (string | number)[] = [
      new Date(Date.now() - (q.sinceMinutes ?? 30) * 60_000).toISOString(),
    ];
    if (q.service) where.push("l.service = ?") && params.push(q.service);
    if (q.route) where.push("l.route = ?") && params.push(q.route);
    if (q.status) where.push("l.status = ?") && params.push(q.status);
    if (q.revision) where.push("l.revision = ?") && params.push(q.revision);
    if (q.decision) where.push("v.decision = ?") && params.push(q.decision);
    if (q.severity) {
      const allowed = SEVERITY_RANK.slice(Math.max(0, SEVERITY_RANK.indexOf(q.severity)));
      where.push(`l.severity IN (${allowed.map(() => "?").join(",")})`);
      params.push(...allowed);
    }
    if (q.text) where.push("l.entry LIKE ?") && params.push(`%${q.text}%`);
    return this.db
      .prepare(
        `SELECT ${PREFIXED_COLUMNS}, ${VERDICT_COLUMNS} FROM lg.logs l LEFT JOIN verdicts v ON v.log_id = l.id WHERE ${where.join(" AND ")} ORDER BY l.id DESC LIMIT ?`,
      )
      .all(...params, Math.min(q.limit ?? 30, 100))
      .map(toStreamRow);
  }

  /** Per-minute and per-revision aggregates for incident sizing. */
  summary(sinceMinutes: number, service?: string) {
    const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const filter = service ? "AND l.service = ?" : "";
    const params = service ? [since, service] : [since];
    const minutes = this.db
      .prepare(
        `SELECT substr(l.ts, 12, 5) AS minute, COUNT(*) AS rows, SUM(l.severity IN ('ERROR','CRITICAL')) AS errors, SUM(l.status >= 500) AS http5xx, SUM(v.decision = 'incident') AS incident, SUM(v.decision = 'suspicious') AS suspicious FROM lg.logs l LEFT JOIN verdicts v ON v.log_id = l.id WHERE l.ts >= ? ${filter} GROUP BY minute ORDER BY minute`,
      )
      .all(...params);
    const revisions = this.db
      .prepare(
        `SELECT l.service, l.revision, COUNT(*) AS rows, SUM(l.status >= 500) AS http5xx, MIN(l.ts) AS first, MAX(l.ts) AS last FROM lg.logs l WHERE l.ts >= ? ${filter} GROUP BY l.service, l.revision ORDER BY l.service, first`,
      )
      .all(...params);
    const notices = this.db
      .prepare(
        `SELECT l.id, l.ts, l.service, l.message FROM lg.logs l WHERE l.ts >= ? AND l.severity = 'NOTICE' ${filter} ORDER BY l.id`,
      )
      .all(...params);
    return { since, minutes, revisions, deploys: notices, fingerprints: this.fingerprintCounts(since) };
  }

  stats() {
    const row = this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM lg.logs) AS rows, COUNT(*) AS judged, SUM(decision='normal') AS normal, SUM(decision='suspicious') AS suspicious, SUM(decision='incident') AS incident, SUM(status='error') AS errors, SUM(status='skipped') AS skipped, COALESCE(SUM(cost), 0) AS spend, AVG(latency_ms) AS latency FROM verdicts",
      )
      .get() as Record<string, number | null>;
    return {
      rows: Number(row.rows ?? 0),
      judged: Number(row.judged ?? 0),
      normal: Number(row.normal ?? 0),
      suspicious: Number(row.suspicious ?? 0),
      incident: Number(row.incident ?? 0),
      errors: Number(row.errors ?? 0),
      skipped: Number(row.skipped ?? 0),
      spend: Number(row.spend ?? 0),
      latencyMs: Math.round(Number(row.latency ?? 0)),
    };
  }

  control() {
    return readControl(this.db, "lg");
  }

  requestBugDeploy() {
    writeControl(this.db, "inject_request", String(Date.now()), "lg");
  }

  /** Asks the log stream to roll out a revision built from `commit`. Rewriting the same request is harmless. */
  requestDeploy(request: { id: number; commit: string; revision: string }) {
    writeControl(this.db, "deploy_request", JSON.stringify(request), "lg");
  }

  /** Withdraws a deploy request the stream has not picked up yet. */
  cancelDeploy(id: number) {
    const raw = this.control().deploy_request;
    if (raw && JSON.parse(raw).id === id) writeControl(this.db, "deploy_request", null, "lg");
  }

  /** The stream's acknowledgment of the last deploy it rolled out. */
  deployed(): { id: number; commit: string; revision: string; at: number } | undefined {
    const raw = this.control().deployed;
    return raw ? JSON.parse(raw) : undefined;
  }

  /** Checkout traffic a revision has served: requests, guest requests, and 5xx. */
  checkoutStats(revision: string) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS checkouts, SUM(json_extract(entry, '$.jsonPayload.customer.guest') = 1) AS guests, SUM(status >= 500) AS errors FROM lg.logs WHERE revision = ? AND route = '/v1/checkout'",
      )
      .get(revision) as Record<string, number | null>;
    return {
      checkouts: Number(row.checkouts ?? 0),
      guests: Number(row.guests ?? 0),
      errors: Number(row.errors ?? 0),
    };
  }

  close() {
    this.db.close();
  }
}
