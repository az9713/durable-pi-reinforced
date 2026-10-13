import type { DatabaseSync } from "node:sqlite";
import type { DemoState, LogRow } from "./types.ts";

/** The mock cloud log store. The logs app writes it; the backend tails it. */
export function ensureLogSchema(db: DatabaseSync, schema = "main") {
  db.exec(`
    PRAGMA ${schema}.journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS ${schema}.logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insert_id TEXT NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      revision TEXT NOT NULL,
      method TEXT,
      route TEXT,
      status INTEGER,
      latency_ms INTEGER,
      message TEXT NOT NULL,
      error_type TEXT,
      entry TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${schema}.logs_ts ON logs(ts);
    CREATE TABLE IF NOT EXISTS ${schema}.control(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

export const LOG_COLUMNS =
  "id, ts, severity, service, revision, method, route, status, latency_ms AS latencyMs, message, error_type AS errorType, entry";

export function toLogRow(record: Record<string, unknown>): LogRow {
  return { ...(record as Omit<LogRow, "entry">), entry: JSON.parse(String(record.entry)) };
}

export function readControl(db: DatabaseSync, schema = "main"): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM ${schema}.control`).all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function writeControl(db: DatabaseSync, key: string, value: string | null, schema = "main") {
  if (value === null) db.prepare(`DELETE FROM ${schema}.control WHERE key=?`).run(key);
  else
    db.prepare(
      `INSERT INTO ${schema}.control(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(key, value);
}

export function demoState(control: Record<string, string>): DemoState {
  const num = (key: string) => (control[key] === undefined ? null : Number(control[key]));
  return {
    startedAt: num("started_at"),
    bugAt: num("bug_at"),
    bugInjectedAt: num("bug_injected_at"),
    rate: num("rate"),
    goodRevision: control.good_revision ?? null,
    badRevision: control.bad_revision ?? null,
    liveRevision: control.live_revision ?? null,
  };
}
