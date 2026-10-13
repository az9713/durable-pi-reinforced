// Normalize pi-durable entries + live generation state into renderable transcript items.
// The web UI, the TUI and the backend's /transcript endpoint all use this, so every
// interface stitches tool calls, results and live output the same way.
import type {
  WireAssistantMessage,
  WireEntry,
  WireMessage,
  WireToolResultMessage,
  WireToolSlot,
  WireUsage,
  WireUsageState,
} from "./api.js";

export type ToolStatus = "pending" | "running" | "done" | "error";

export interface ToolCallView {
  callId: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  /** Live output while running. */
  output?: string;
  /** Result text once the result entry exists. */
  result?: string;
  resultEntryId?: number;
}

export type AssistantBlockView =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; call: ToolCallView };

export type TranscriptItem =
  | { kind: "user"; id: number; text: string }
  | {
      kind: "assistant";
      id: number | "live";
      streaming: boolean;
      blocks: AssistantBlockView[];
      error?: string;
      model?: string;
    }
  | { kind: "tool-result"; id: number; name: string; text: string; isError: boolean }
  | { kind: "tool"; id: string; call: ToolCallView }
  | { kind: "event"; id: number; entryKind: string; text: string; note?: string; data?: unknown };

export interface LiveTool {
  name: string;
  status: "pending" | "running" | "done";
  output: string;
  args?: unknown;
}

const isAssistant = (m: WireMessage): m is WireAssistantMessage => m.role === "assistant";
const isToolResult = (m: WireMessage): m is WireToolResultMessage => m.role === "toolResult";

export function messageText(message: WireMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

export function assistantError(message: WireAssistantMessage): string | undefined {
  if (message.errorMessage) return message.errorMessage;
  if (message.stopReason === "aborted") return "Interrupted. Partial response preserved.";
  if (message.stopReason === "error") return "Provider request failed.";
  return undefined;
}

function eventText(entry: WireEntry): string {
  const data = entry.data as { text?: unknown } | undefined;
  if (typeof data?.text === "string") return data.text;
  if (entry.kind === "pi.reset") return "New context started. Earlier entries remain stored.";
  if (entry.kind === "pi.compaction") return "Context compacted. Earlier entries remain stored.";
  return entry.kind;
}

export function toTranscript(
  entries: readonly WireEntry[],
  live?: WireAssistantMessage,
  tools: ReadonlyMap<string, LiveTool> = new Map(),
): TranscriptItem[] {
  const results = new Map<string, { entryId: number; message: WireToolResultMessage }>();
  const callIds = new Set<string>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (entry.kind === "pi.tool-result" && isToolResult(message))
        results.set(message.toolCallId, { entryId: entry.id, message });
      if (entry.kind === "pi.assistant" && isAssistant(message))
        for (const block of message.content) if (block.type === "toolCall") callIds.add(block.id);
    }
  }
  if (live) for (const block of live.content) if (block.type === "toolCall") callIds.add(block.id);

  const toolView = (id: string, name: string, args: unknown): ToolCallView => {
    const result = results.get(id);
    const running = tools.get(id);
    if (result)
      return {
        callId: id,
        name,
        args,
        status: result.message.isError ? "error" : "done",
        result: messageText(result.message),
        resultEntryId: result.entryId,
      };
    return {
      callId: id,
      name,
      args,
      status: running?.status === "running" ? "running" : "pending",
      output: running?.output || undefined,
    };
  };

  const assistantBlocks = (message: WireAssistantMessage): AssistantBlockView[] =>
    message.content.flatMap((block): AssistantBlockView[] => {
      if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
      if (block.type === "thinking")
        return block.thinking ? [{ type: "thinking", text: block.thinking }] : [];
      return [{ type: "tool", call: toolView(block.id, block.name, block.arguments) }];
    });

  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "pi.system") continue;
    if (entry.kind === "pi.user") {
      items.push({
        kind: "user",
        id: entry.id,
        text: (entry.model ?? []).map(messageText).join("\n"),
      });
    } else if (entry.kind === "pi.assistant") {
      const messages = (entry.model ?? []).filter(isAssistant);
      items.push({
        kind: "assistant",
        id: entry.id,
        streaming: false,
        blocks: messages.flatMap(assistantBlocks),
        error: messages.map(assistantError).find(Boolean),
        model: messages[0]?.model,
      });
    } else if (entry.kind === "pi.tool-result") {
      for (const message of (entry.model ?? []).filter(isToolResult)) {
        if (callIds.has(message.toolCallId)) continue;
        items.push({
          kind: "tool-result",
          id: entry.id,
          name: message.toolName,
          text: messageText(message),
          isError: message.isError,
        });
      }
    } else {
      items.push({
        kind: "event",
        id: entry.id,
        entryKind: entry.kind,
        text: eventText(entry),
        note: entry.model?.length ? (entry.model ?? []).map(messageText).join("\n") : undefined,
        ...(entry.data !== undefined ? { data: entry.data } : {}),
      });
    }
  }
  if (live)
    items.push({
      kind: "assistant",
      id: "live",
      streaming: true,
      blocks: assistantBlocks(live),
      model: live.model,
    });
  for (const [callId, tool] of tools)
    if (tool.status !== "done" && !callIds.has(callId))
      items.push({ kind: "tool", id: callId, call: toolView(callId, tool.name, tool.args) });
  return items;
}

export function toMarkdown(items: readonly TranscriptItem[]): string {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "user") out.push(`### You (#${item.id})\n\n${item.text}`);
    else if (item.kind === "assistant") {
      const parts = item.blocks.map((block) =>
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? `> _thinking:_ ${block.text.replaceAll("\n", " ").slice(0, 400)}`
            : `- \`${block.call.name}\` ${block.call.status}${block.call.result ? `\n\n\`\`\`\n${block.call.result.slice(0, 2000)}\n\`\`\`` : ""}`,
      );
      if (item.error) parts.push(`> ${item.error}`);
      out.push(`### Agent (${item.id === "live" ? "working" : `#${item.id}`})\n\n${parts.join("\n\n")}`);
    } else if (item.kind === "tool-result")
      out.push(`- \`${item.name}\` ${item.isError ? "error" : "result"}\n\n\`\`\`\n${item.text.slice(0, 2000)}\n\`\`\``);
    else if (item.kind === "tool") out.push(`- \`${item.call.name}\` ${item.call.status}`);
    else out.push(`_${item.text}_`);
  }
  return out.join("\n\n") + "\n";
}

/** Text of the last assistant entry, for previews and simple clients. */
export function lastAssistantText(entries: readonly WireEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "pi.assistant") continue;
    const text = (entry.model ?? []).filter(isAssistant).map(messageText).join("").trim();
    if (text) return text;
  }
  return undefined;
}

export interface UsageSummary {
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
}

export function sumUsage(state?: Pick<WireUsageState, "models"> | { models: Record<string, WireUsage> }): UsageSummary {
  const total: UsageSummary = {
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
  for (const u of Object.values(state?.models ?? {})) {
    total.tokens += u.totalTokens ?? u.input + u.output + u.cacheRead + u.cacheWrite;
    total.cost += u.cost?.total ?? 0;
    total.input += u.input ?? 0;
    total.output += u.output ?? 0;
    total.cacheRead += u.cacheRead ?? 0;
    total.cacheWrite += u.cacheWrite ?? 0;
    total.inputCost += u.cost?.input ?? 0;
    total.outputCost += u.cost?.output ?? 0;
    total.cacheReadCost += u.cost?.cacheRead ?? 0;
    total.cacheWriteCost += u.cost?.cacheWrite ?? 0;
  }
  return total;
}

export type { WireToolSlot };
