// Composer slash commands: the same names as dpi-tui. Unknown commands are sent to the agent as text.
import { THINKING_LEVELS, type ThinkingLevel } from "@sdk/api";
import {
  agentHandle,
  agentState,
  notify,
  refreshDetail,
  select,
  selected,
  sessionHandle,
  showInspector,
  ui,
} from "./store";

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  run: (arg: string) => unknown | Promise<unknown>;
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw Error(`No ${what} selected`);
  return value;
};

export const commands: SlashCommand[] = [
  {
    name: "compact",
    args: "[instructions]",
    description: "Summarize older context; stored entries stay",
    run: async (arg) => {
      await need(agentHandle.value, "agent").compact(arg || undefined);
      notify("Compaction requested. /tasks shows its outcome.");
    },
  },
  {
    name: "reset",
    args: "[handoff note]",
    description: "Start a fresh context; history stays stored",
    run: async (arg) => {
      await need(agentHandle.value, "agent").reset(arg || undefined);
      notify("New context started.");
    },
  },
  { name: "tasks", description: "Open the Tasks panel", run: () => showInspector("tasks") },
  {
    name: "new",
    args: "[name]",
    description: "New agent in this workspace",
    run: async (arg) => {
      const t = need(selected.value, "workspace");
      const created = await need(sessionHandle.value, "workspace").createAgent(
        arg ? { name: arg } : {},
      );
      select({ ...t, agentId: created.id });
      notify(`New agent ${created.name}.`);
    },
  },
  {
    name: "fork",
    args: "[entryId] [name]",
    description: "Fork at an entry (default: the last reply)",
    run: async (arg) => {
      const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
      const explicit = first && /^\d+$/.test(first) ? Number(first) : undefined;
      const name = (explicit === undefined ? [first, ...rest] : rest).filter(Boolean).join(" ");
      const entryId =
        explicit ?? agentState.value.entries.filter((e) => e.kind === "pi.assistant").at(-1)?.id;
      if (entryId === undefined) throw Error("Nothing to fork yet");
      const t = need(selected.value, "agent");
      const created = await need(agentHandle.value, "agent").fork({
        entryId,
        name: name || undefined,
      });
      select({ ...t, agentId: created.id });
      notify(`Forked at entry #${entryId}. App State stays shared.`);
    },
  },
  {
    name: "name",
    args: "<name>",
    description: "Rename this agent",
    run: async (arg) => {
      if (!arg) throw Error("Usage: /name <name>");
      await need(agentHandle.value, "agent").rename(arg);
      notify(`Agent renamed to ${arg}.`);
    },
  },
  {
    name: "model",
    description: "Choose this agent's model",
    run: () => (ui.dialog = { kind: "models" }),
  },
  {
    name: "thinking",
    args: "<level>",
    description: `Thinking level: ${THINKING_LEVELS.join(", ")}`,
    run: async (arg) => {
      if (!THINKING_LEVELS.includes(arg as ThinkingLevel))
        throw Error(`Levels: ${THINKING_LEVELS.join(", ")}`);
      await need(agentHandle.value, "agent").configure({ thinkingLevel: arg as ThinkingLevel });
      await refreshDetail();
      notify(`Thinking ${arg}. Used on the next turn.`);
    },
  },
  {
    name: "help",
    description: "How this works, keys and commands",
    run: () => (ui.dialog = { kind: "help" }),
  },
];

/** `/name rest` → the command and its argument, or undefined when the text is not a known command. */
export function parseCommand(text: string) {
  const m = text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
  const command = m && commands.find((c) => c.name === m[1]);
  return command ? { command, arg: m![2].trim() } : undefined;
}
