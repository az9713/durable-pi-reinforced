// search_history: look back through an agent's whole stored history, including entries before a reset, handoff or
// compaction that the model no longer sees. Pure over a list of entries, so it is testable without a harness.
import type { WireAssistantMessage, WireEntry, WireMessage, WireToolResultMessage } from "../../dpi-sdk/src/api.js";
import { messageText } from "../../dpi-sdk/src/transcript.js";

export type HistoryKind = "user" | "assistant" | "tool_call" | "tool_result" | "event";

export interface HistoryQuery {
  /** Words that must all appear, case-insensitive. */
  query?: string;
  /** Only calls to and results from this tool. */
  tool?: string;
  /** One entry by number, returned in full. */
  entry?: number;
  kind?: HistoryKind;
  from_entry?: number;
  to_entry?: number;
  order?: "newest" | "oldest";
  limit?: number;
  offset?: number;
}

export type HistoryContext = "active" | "compacted" | "before reset";

export interface HistoryHit {
  entry: number;
  kind: Exclude<HistoryKind, "tool_call">;
  context: HistoryContext;
  tools?: string[];
  text: string;
}

export interface HistoryPage {
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  /** The first entry the model still sees; older entries are only reachable through this tool. */
  active_from?: number;
  results: HistoryHit[];
}

const SEARCH_TOOL = "search_history";
const SNIPPET = 360;
const FULL = 4000;

interface Parsed {
  id: number;
  kind: HistoryHit["kind"];
  tools: string[];
  /** Searchable text: message text, tool names and arguments, result text. */
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function parse(entry: WireEntry): Parsed | undefined {
  const messages = (entry.model ?? []) as WireMessage[];
  if (entry.kind === "pi.system") return undefined;
  if (entry.kind === "pi.user")
    return { id: entry.id, kind: "user", tools: [], text: messages.map(messageText).join("\n").trim() };
  if (entry.kind === "pi.assistant") {
    const tools: string[] = [];
    const parts: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const block of (m as WireAssistantMessage).content) {
        if (block.type === "text") parts.push(block.text);
        if (block.type === "toolCall") {
          tools.push(block.name);
          parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
        }
      }
    }
    return { id: entry.id, kind: "assistant", tools, text: parts.join("\n").trim() };
  }
  if (entry.kind === "pi.tool-result") {
    const results = messages.filter((m): m is WireToolResultMessage => m.role === "toolResult");
    return {
      id: entry.id,
      kind: "tool_result",
      tools: results.map((r) => r.toolName),
      text: results.map((r) => `${r.toolName}${r.isError ? " (error)" : ""}: ${messageText(r)}`).join("\n").trim(),
    };
  }
  const data = entry.data as { text?: unknown } | undefined;
  const note = messages.map(messageText).join("\n");
  const title =
    typeof data?.text === "string"
      ? data.text
      : entry.kind === "pi.reset"
        ? "New context started (reset or handoff)."
        : entry.kind === "pi.compaction"
          ? "Context compacted. Summary of the older entries:"
          : entry.kind;
  const text = [title, note].filter(Boolean).join("\n");
  return { id: entry.id, kind: "event", tools: [], text: text.trim() };
}

function snippet(text: string, terms: string[]) {
  if (!terms.length) return clip(text, SNIPPET);
  const at = text.toLowerCase().indexOf(terms[0]);
  const start = Math.max(0, at - 100);
  return `${start > 0 ? "…" : ""}${clip(text.slice(start), SNIPPET)}`;
}

/**
 * `entries` is every visible entry in any order. `activeFrom` is the first entry of the active context (the latest
 * head marker's head); `lastReset` is the newest `pi.reset` entry, which separates reset history from compacted history.
 */
export function searchHistory(
  entries: readonly WireEntry[],
  q: HistoryQuery,
  marks: { activeFrom?: number; lastReset?: number },
): HistoryPage {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 10), 1), 50);
  const offset = Math.max(Math.trunc(q.offset ?? 0), 0);
  const context = (id: number): HistoryContext =>
    marks.activeFrom === undefined || id >= marks.activeFrom
      ? "active"
      : marks.lastReset !== undefined && id < marks.lastReset
        ? "before reset"
        : "compacted";
  const hit = (p: Parsed, terms: string[], full: boolean): HistoryHit => ({
    entry: p.id,
    kind: p.kind,
    context: context(p.id),
    ...(p.tools.length ? { tools: p.tools } : {}),
    text: full ? clip(p.text, FULL) : snippet(p.text, terms),
  });
  const page = (results: HistoryHit[], total: number): HistoryPage => ({
    total,
    offset,
    limit,
    next_offset: offset + results.length < total ? offset + results.length : null,
    ...(marks.activeFrom !== undefined ? { active_from: marks.activeFrom } : {}),
    results,
  });

  const parsed = entries.flatMap((e) => parse(e) ?? []);
  if (q.entry !== undefined) {
    const found = parsed.find((p) => p.id === q.entry);
    return page(found && offset === 0 ? [hit(found, [], true)] : [], found ? 1 : 0);
  }

  const terms = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tool = q.tool?.trim().toLowerCase();
  const matches = parsed
    .filter((p) => {
      // The search's own calls and results only match when asked for by name.
      if (tool !== SEARCH_TOOL && p.tools.length && p.tools.every((t) => t === SEARCH_TOOL)) return false;
      if (q.from_entry !== undefined && p.id < q.from_entry) return false;
      if (q.to_entry !== undefined && p.id > q.to_entry) return false;
      if (tool && !p.tools.some((t) => t.toLowerCase() === tool)) return false;
      if (q.kind === "tool_call" && !(p.kind === "assistant" && p.tools.length)) return false;
      if (q.kind && q.kind !== "tool_call" && p.kind !== q.kind) return false;
      const text = p.text.toLowerCase();
      return terms.every((t) => text.includes(t));
    })
    .sort((a, b) => (q.order === "oldest" ? a.id - b.id : b.id - a.id));
  return page(
    matches.slice(offset, offset + limit).map((p) => hit(p, terms, false)),
    matches.length,
  );
}
