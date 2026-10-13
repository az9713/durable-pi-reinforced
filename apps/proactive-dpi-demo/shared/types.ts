export type Severity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL";

/** Google Cloud Logging LogEntry, as Cloud Run writes it. */
export type LogEntry = {
  insertId: string;
  logName: string;
  resource: { type: string; labels: Record<string, string> };
  timestamp: string;
  receiveTimestamp: string;
  severity: Severity;
  labels?: Record<string, string>;
  httpRequest?: {
    requestMethod: string;
    requestUrl: string;
    status: number;
    responseSize?: string;
    userAgent: string;
    remoteIp: string;
    latency: string;
    protocol: string;
  };
  jsonPayload?: Record<string, unknown> & { message: string };
  trace?: string;
  spanId?: string;
};

/** One row of the mock log store. */
export type LogRow = {
  id: number;
  ts: string;
  severity: Severity;
  service: string;
  revision: string;
  method: string | null;
  route: string | null;
  status: number | null;
  latencyMs: number | null;
  message: string;
  errorType: string | null;
  entry: LogEntry;
};

export type Decision = "normal" | "suspicious" | "incident";

export type Verdict = {
  logId: number;
  status: "judged" | "error" | "skipped";
  fingerprint: string;
  decision?: Decision;
  probability?: number;
  probabilities?: Record<Decision, number>;
  /** Jev score from 0 (no impact) to 4 (outage). */
  impact?: number;
  model?: string;
  latencyMs?: number;
  cost?: number;
  error?: string;
  judgedAt: number;
};

export type StreamRow = LogRow & { verdict?: Verdict };

export type IncidentStatus =
  | "starting"
  | "investigating"
  | "root_cause_found"
  | "fix_in_progress"
  | "ready_for_review"
  | "deployed"
  | "blocked";

export type Incident = {
  id: string;
  title: string;
  fingerprint: string;
  service: string;
  trigger: Decision;
  status: IncidentStatus;
  summary: string;
  conversationId: number;
  branch: string;
  worktree: string;
  openedAt: number;
  updatedAt: number;
  evidence: { logIds: number[]; firstSeen: string; revision: string; commit: string | null };
  report: {
    rootCause: string | null;
    fix: string | null;
    tests: string | null;
    commit: string | null;
    diffStat: string | null;
    deployedRevision: string | null;
  };
  timeline: { at: number; status: IncidentStatus; summary: string }[];
  announced: { opened: boolean; ready: boolean };
};

export type DeployStatus =
  | "awaiting_approval"
  | "declined"
  | "deploying"
  | "verifying"
  | "deployed"
  | "failed"
  | "cancelled";

/** One deploy request. Its durable task waits for the engineer, rolls out, then verifies. */
export type Deploy = {
  id: number;
  toolTaskId: number;
  incidentId: string;
  conversationId: number;
  commit: string;
  branch: string;
  summary: string;
  diffStat: string;
  status: DeployStatus;
  revision: string | null;
  requestedAt: number;
  decidedAt: number | null;
  note: string | null;
  verification: { checkouts: number; guests: number; errors: number } | null;
};

export type DemoState = {
  startedAt: number | null;
  bugAt: number | null;
  bugInjectedAt: number | null;
  rate: number | null;
  goodRevision: string | null;
  badRevision: string | null;
  liveRevision: string | null;
};
