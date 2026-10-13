// The Durable Agent Network wire contract: every JSON body and stream frame between
// dpi-backend and its clients. Types only, so browsers, Node and the TUI share it.
//
// Agent events are pi-durable 1.0.3's `watchEvents()` output passed through verbatim.
// The Wire* event types below copy their JSON shape; apps/dpi-backend/src/contract-check.ts
// fails the build if pi-durable's own types stop fitting them.

import type { JobDef } from "./jobs.js";

export const API_VERSION = 1 as const;

export type DeviceKind = "local" | "ssh" | "exe-dev" | "url";
export type DeviceStatus =
  | "checking"
  | "online"
  | "offline"
  | "unauthorized"
  | "mismatch"
  | "incompatible";
export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid"
  | "busy"
  | "conflict"
  | "ambiguous"
  | "unavailable"
  | "internal"
  | "offline";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export type WhenBusy = "followUp" | "steer" | "reject";

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

// ---------------------------------------------------------------- device

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  tier: string;
  icon: string;
  contextWindow: number;
  reasoning: boolean;
  cost: { input: number; output: number };
}

export interface DeviceInfo {
  uid: string;
  name: string;
  hostname: string;
  platform: string;
  apiVersion: typeof API_VERSION;
  durableVersion: string;
  startedAt: number;
  /** Where new sessions start: the directory browser opens here, relative cwds resolve against the first. */
  startDirs: string[];
  models: ModelInfo[];
  defaultModel: string;
  storage: { dataDir: string; catalogPath: string; appStatePath: string };
  /** The checkout the backend runs from (repo root locally, `code_dir` on deployed devices). */
  codeDir?: string;
  capabilities: Array<"events" | "docs" | "demo" | "jobs">;
  /** Durable jobs any agent on this device can run (`POST .../demo/jobs` or the run_durable_job tool). */
  jobs?: JobDef[];
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: { name: string; path: string }[];
}

// ---------------------------------------------------------------- sessions and agents

export type AgentKind = "root" | "fork" | "subagent";

/** An agent is a pi-durable conversation; `id` is the conversation id. */
export interface AgentRef {
  id: number;
  name: string;
  /** True when `name` was set by a person rather than derived from the id. */
  named: boolean;
  kind: AgentKind;
  parentId?: number;
  forkedAt?: number;
  ownerAgentId?: number;
  ownerTaskId?: number;
}

export interface AgentStatus {
  busy: boolean;
  background: number;
}

export type AgentSummary = AgentRef & AgentStatus;

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  model: string;
  createdAt: number;
  dbPath: string;
  busy: boolean;
  error?: string;
  agents: AgentSummary[];
  /** Automatic compaction thresholds, shared by every agent of the session. */
  compaction?: CompactionSettings;
}

/**
 * pi-durable's compaction policy. Above `contextWindow - reserveTokens` the next request waits for a summary;
 * `backgroundTokens` below that, a summary starts in the background (0 disables it).
 */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  backgroundTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  backgroundTokens: 32768,
  keepRecentTokens: 2000,
};

/** The playground's default marker positions: a summary starts in the background at 200k tokens, and the next
 * request waits for it at 250k. */
export const DEFAULT_COMPACTION_AT = { auto: 200_000, wait: 250_000 };

/** Default thresholds for a model window: the positions above, or pi-durable's own margins when the window is smaller. */
export function defaultCompaction(window: number): CompactionSettings {
  if (!(window > 0)) return { ...DEFAULT_COMPACTION };
  const wait = Math.min(DEFAULT_COMPACTION_AT.wait, window - DEFAULT_COMPACTION.reserveTokens);
  const auto = Math.min(DEFAULT_COMPACTION_AT.auto, wait - DEFAULT_COMPACTION.backgroundTokens);
  return { ...DEFAULT_COMPACTION, reserveTokens: window - wait, backgroundTokens: wait - auto };
}

/** False when the thresholds leave a model with this window under 32k tokens before every request waits for a summary. */
export const compactionFits = (window: number, s: CompactionSettings) => window - s.reserveTokens >= 32_768;

/** Context sizes where compaction starts for a model window: `auto` in the background, `wait` blocking. */
export function compactionThresholds(window: number, s: CompactionSettings) {
  const wait = Math.max(0, window - s.reserveTokens);
  return { wait, auto: s.backgroundTokens > 0 ? Math.max(0, wait - s.backgroundTokens) : undefined };
}

export interface DeviceTree {
  uid: string;
  name: string;
  sessions: SessionSummary[];
  at: number;
}

export interface AgentConfig {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  instructions?: string;
  cwd?: string;
  /** Offer only tools that read: tools that create, update or delete leave the agent's requests. */
  readOnly?: boolean;
}

/** A custom harness extension an agent can turn on or off: `GET / PATCH .../agents/:a/extensions`. */
export interface HarnessExtensionInfo {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  /** For system-prompts: the built-in prompts and which ones this agent renders. */
  prompts?: { id: string; title: string; description: string; enabled: boolean; text: string }[];
}

export interface AgentExtensions {
  extensions: HarnessExtensionInfo[];
  /** Extensions every agent runs, which cannot be turned off here. */
  builtIn: string[];
}

export interface AgentDetail extends AgentSummary {
  sessionId: string;
  config: AgentConfig;
  /**
   * Every tool of the agent's extensions. `parameters` is its JSON Schema, as the model sees it; `writes` marks tools
   * that create, update or delete; `offered` is false for tools the agent's tool filter removes (read only).
   */
  tools: {
    name: string;
    description: string;
    replay: "safe" | "unsafe";
    parameters?: unknown;
    writes: boolean;
    offered: boolean;
  }[];
  extensions: string[];
}

export interface CreateSessionBody {
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface CreateAgentBody {
  from?: number | string;
  name?: string;
}

export interface SendMessageBody {
  content: string;
  whenBusy?: WhenBusy;
  requestId: string;
  waitMs?: number;
}

export type SendResult =
  | { submissionId: number; status: "queued" | "pending" }
  | { submissionId: number; status: "done"; answer: { entryId: number; text: string } }
  | { submissionId: number; status: "unanswered"; reason: string };

export interface ForkBody {
  entryId: number;
  name?: string;
}

export interface Page<T> {
  items: T[];
  next?: string;
}

// ---------------------------------------------------------------- tasks and usage

export interface TaskNode {
  id: number;
  kind: string;
  conversationId: number;
  owner?: number;
  background: boolean;
  aborting?: boolean;
  state: { status: string; phase?: string; on?: number[]; policy?: string };
  conversations: number[];
  /** What the task is: the tool name of a `pi.tool` task, or the job title of a durable job. */
  label?: string;
  /** For `pi.tool` tasks: the tool call id in the transcript. */
  callId?: string;
}

export interface TaskOutcome {
  id: number;
  kind: string;
  conversationId?: number;
  state: {
    status: string;
    outcome?: { status: string; result?: unknown; error?: { message: string } };
  };
}

// ---------------------------------------------------------------- pi-ai / pi-durable JSON shapes

export interface WireText {
  type: "text";
  text: string;
}
export interface WireThinking {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
export interface WireToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
export interface WireImage {
  type: "image";
  data: string;
  mimeType: string;
}
export type WireAssistantBlock = WireText | WireThinking | WireToolCall;

export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface WireUserMessage {
  role: "user";
  content: string | readonly (WireText | WireImage)[];
  timestamp?: number;
}
export interface WireAssistantMessage {
  role: "assistant";
  content: readonly WireAssistantBlock[];
  provider: string;
  model: string;
  usage: WireUsage;
  stopReason: string;
  errorMessage?: string;
  timestamp?: number;
}
export interface WireToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: readonly (WireText | WireImage)[];
  isError: boolean;
  details?: unknown;
  timestamp?: number;
}
export interface WireOtherMessage {
  role: string;
}
export type WireMessage =
  | WireUserMessage
  | WireAssistantMessage
  | WireToolResultMessage
  | WireOtherMessage;

export interface WireEntry {
  id: number;
  conversationId: number;
  kind: string;
  model?: readonly WireMessage[];
  data?: unknown;
  head?: number;
  byTaskId?: number;
}

export interface WireToolSlot {
  callId: string;
  name: string;
  taskId?: number;
  status: "pending" | "running" | "done";
  output?: string;
  droppedBytes?: number;
  droppedLines?: number;
  details?: unknown;
  entry?: number;
}

export interface WireCompaction {
  taskId: number;
  reason: string;
  blocking: boolean;
  attempt: number;
  retry?: { at: number; error: string };
}

export interface WireAgentState {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  extensions?: unknown;
  tools?: unknown;
  instructions?: string;
  cwd?: string;
}

export interface WireUsageState {
  models: Readonly<Record<string, WireUsage>>;
  tools: Readonly<Record<string, WireUsage>>;
}

export interface WireQueued {
  id: number;
  mode: string;
}

export type WireMessageChange =
  | {
      type: "text_start" | "thinking_start" | "toolcall_start";
      contentIndex: number;
      block: WireAssistantBlock;
    }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      path: readonly (string | number)[];
      delta: string;
    }
  | { type: "block"; contentIndex: number; block: WireAssistantBlock }
  | { type: "message"; message: WireAssistantMessage };

export interface WireSnapshotEvent {
  type: "snapshot";
  entries: readonly WireEntry[];
  run?: { inputs: readonly number[] };
  generation?: {
    attempt: number;
    message?: WireAssistantMessage;
    retry?: { at: number; error: string };
    deferred?: { pollAt: number };
  };
  tools: readonly WireToolSlot[];
  compactions: readonly WireCompaction[];
  inbox: readonly WireQueued[];
  agent: WireAgentState;
  usage: WireUsageState;
}

export type WireAgentEvent =
  | WireSnapshotEvent
  | { type: "run_start" | "run_end"; inputs: readonly number[] }
  | { type: "turn_start" | "turn_end" }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_update"; usage: WireUsage; changes: readonly WireMessageChange[] }
  | { type: "message_end"; entry: WireEntry }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      output?: { trimStart?: number; append?: string } | { set: string };
      details?: unknown;
      diagnostics?: readonly unknown[];
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: WireEntry }
  | { type: "inbox_update"; items: readonly WireQueued[] }
  | { type: "submission"; record: { id: number; status: string } }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "entry_appended"; entry: WireEntry }
  | { type: "agent_changed"; agent: WireAgentState }
  | { type: "usage_changed"; usage: WireUsageState }
  | { type: "task_failed"; taskId: number; kind: string; message: string }
  | { type: "compaction_start"; taskId: number; reason: string; blocking: boolean }
  | { type: "compaction_end"; taskId: number; reason: string };

/** A queued submission with its content, read from the conversation's `pi.inbox` document. */
export interface InboxItem {
  id: number;
  mode: "steer" | "followUp" | "write";
  content?: string;
}

// ---------------------------------------------------------------- stream frames

export interface StreamScope {
  kind: "device" | "session" | "agent";
  sessionId?: string;
  agentId?: number;
}

export interface Activity {
  type: "agent.started" | "agent.finished";
  sessionId: string;
  agentId: number;
  at: number;
  preview?: string;
}

export interface UsageTotals {
  models: Record<string, WireUsage>;
  tools: Record<string, WireUsage>;
}

/** The public view of a registry device (the token never leaves the hub or TUI process). */
export interface NetworkDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  url: string;
  source: "config" | "ui";
  hasToken: boolean;
  status: DeviceStatus;
  error?: string;
  lastSeenAt?: number;
  info?: DeviceInfo;
  tree?: DeviceTree;
}

export type Frame =
  | { type: "hello"; apiVersion: typeof API_VERSION; serverTime: number; scope: StreamScope }
  | { type: "fault"; error: { code: ErrorCode; message: string } }
  // device scope
  | { type: "tree"; tree: DeviceTree }
  | { type: "activity"; items: Activity[] }
  // session scope
  | { type: "session"; agents: AgentSummary[]; tasks: TaskNode[]; usage: UsageTotals }
  | { type: "agents"; agents: AgentSummary[] }
  | { type: "tasks"; tasks: TaskNode[] }
  | { type: "usage"; usage: UsageTotals }
  // agent scope
  | { type: "snapshot"; snapshot: WireSnapshotEvent; inbox: InboxItem[] }
  | { type: "batch"; events: readonly WireAgentEvent[] }
  | { type: "inbox"; items: InboxItem[] }
  // any scope that asked for documents
  | { type: "doc"; kind: string; value: unknown; revision?: number }
  // hub mux only
  | { type: "network"; devices: NetworkDevice[] }
  | { type: "disconnected"; reason: string };

/** One frame of the hub's multiplexed browser stream. */
export interface MuxFrame {
  sub: string;
  frame: Frame | { type: "stream"; streamId: string };
}
