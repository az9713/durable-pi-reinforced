// Durable jobs: repeatable workflows. Each run is one pi-durable task whose checkpoint phases are the job's named
// phases. The run's record lives in the conversation document `demo.job-runs`, so every client renders the same
// phases, steps and approval, live and after a restart. Types are aliases (not interfaces) so they stay JSON documents.

export const JOB_RUNS_DOC = "demo.job-runs";

export type JobInputValue = string | number | boolean;

export type JobInputSpec = {
  name: string;
  type: "string" | "integer";
  description: string;
  default: JobInputValue;
  min?: number;
  max?: number;
};

export type JobPhaseSpec = {
  id: string;
  label: string;
  summary: string;
  /** `approval` phases wait for a person's decision; `repeat` phases save one checkpoint per iteration. */
  kind?: "approval" | "repeat";
};

export type JobDef = {
  id: string;
  title: string;
  summary: string;
  phases: JobPhaseSpec[];
  inputs: JobInputSpec[];
  /** The run pauses in an approval phase until a person approves or declines. */
  approval: boolean;
  /** App State path where every run saves its result. */
  resultPath: string;
  /** Typical run time in seconds, without the approval wait. */
  seconds: number;
};

export type JobStepKind = "command" | "tool" | "agent" | "state" | "approval" | "checkpoint" | "note";
export type JobStepStatus = "running" | "done" | "error" | "waiting";
export type JobPhaseStatus = "pending" | "running" | "waiting" | "done" | "failed" | "aborted" | "skipped";
export type JobRunStatus = "running" | "waiting" | "completed" | "failed" | "aborted" | "declined";

export type JobStep = {
  id: string;
  kind: JobStepKind;
  label: string;
  detail?: string;
  status: JobStepStatus;
  /** The phase iteration that recorded the step; a resumed iteration replaces its own steps. */
  iteration: number;
  at: number;
  ms?: number;
  /** For subagent steps: the child conversation that made the call. */
  conversationId?: number;
};

export type JobPhaseRun = {
  id: string;
  label: string;
  status: JobPhaseStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  steps: JobStep[];
  progress?: { done: number; total: number };
};

export type JobRun = {
  /** The job's durable task id. */
  id: number;
  job: string;
  title: string;
  /** The nth run of this job in this conversation. */
  run: number;
  input: Record<string, JobInputValue>;
  startedBy: "agent" | "you";
  /** Set when the agent started the run: the run_durable_job call that owns it. */
  toolCallId?: string;
  background: boolean;
  status: JobRunStatus;
  phase?: string;
  phases: JobPhaseRun[];
  approval?: "pending" | "approved" | "declined" | "cancelled";
  childConversationId?: number;
  /** How many times the run continued from a checkpoint after a restart. */
  resumed: number;
  result?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
};

export type JobRunsDoc = { counts: Record<string, number>; items: Record<string, JobRun> };

export const jobRunDone = (run: Pick<JobRun, "status">) =>
  run.status !== "running" && run.status !== "waiting";
