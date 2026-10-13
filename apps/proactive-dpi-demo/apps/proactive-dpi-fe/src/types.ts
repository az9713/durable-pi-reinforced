import type { Deploy, DemoState, Incident, StreamRow, Verdict } from "../../../shared/types.ts";
export type { Deploy, DemoState, Incident, StreamRow, Verdict };

export type Model = {
  id: string;
  provider: string;
  name: string;
  tier: string;
  icon: string;
  contextWindow: number;
};
export type Config = {
  models: Model[];
  defaultModel?: Model;
  rootConversationId: number;
  jev: string;
  tts: "host" | "browser" | "both" | "off";
  thresholds: { incident: number; suspicious: number; windowSeconds: number };
  repo: string;
  version: string;
};
export type Stats = {
  rows: number;
  judged: number;
  normal: number;
  suspicious: number;
  incident: number;
  errors: number;
  skipped: number;
  spend: number;
  latencyMs: number;
};
export type Speech = { text: string; url: string | null; at: number; browser: boolean };

export type Block = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
};
export type Message = {
  role: string;
  toolCallId?: string;
  content: string | Block[];
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
};
export type Entry = {
  id: number;
  kind: string;
  model?: Message[];
  data?: { text?: string };
};
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
};
export type Live = {
  run?: { taskId: number };
  generation?: { message?: Message; retry?: { at: number; error: string }; attempt: number };
  tools?: { callId: string; name: string; status: string; output?: string }[];
};
export type ChatSnapshot = {
  conversationId: number;
  view: {
    entries: Entry[];
    docs: {
      "pi.agent"?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
      "pi.live"?: Live;
      "pi.inbox"?: { items: { id: number; mode: string; content?: unknown }[] };
      "pi.usage"?: { models: Record<string, Usage> };
    };
  };
  incidents: Incident[];
  deploys: Deploy[];
  tools: string[];
  serverTime: number;
};
