// Slash commands. Anything that is not a known command goes to the agent as text, as in pi.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../../dpi-sdk/src/api.ts";
import type { App } from "./app.ts";
import { Panel, pickAgent, pickDevice, pickModel, pickSession } from "./pickers.ts";
import { c } from "./theme.ts";

export const COMMANDS: SlashCommand[] = [
  { name: "sessions", description: "switch or create a session on this device" },
  { name: "agents", description: "switch agent: roots, forks, subagents" },
  { name: "model", description: "choose this agent's model" },
  { name: "devices", description: "switch device" },
  { name: "new", description: "new agent in this session", argumentHint: "[name]" },
  { name: "fork", description: "fork at an entry (default: the last reply)", argumentHint: "[entryId] [name]" },
  {
    name: "thinking",
    description: "set the thinking level",
    argumentHint: "<level>",
    getArgumentCompletions: (prefix) =>
      THINKING_LEVELS.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l })),
  },
  { name: "compact", description: "summarize older context", argumentHint: "[instructions]" },
  { name: "reset", description: "start a fresh context", argumentHint: "[handoff note]" },
  { name: "name", description: "rename this agent", argumentHint: "<name>" },
  { name: "tasks", description: "live tasks in this session" },
  { name: "help", description: "keys and commands" },
  { name: "quit", description: "exit (the agent keeps running)" },
];

const KEYS: [string, string][] = [
  ["enter", "send; steers the agent while it works"],
  ["alt+enter", "queue as a follow-up"],
  ["esc", "interrupt foreground work"],
  ["shift+tab", "cycle thinking level"],
  ["ctrl+l", "model picker"],
  ["ctrl+o", "expand tool output and thinking"],
  ["ctrl+c", "clear input, or exit when empty"],
  ["ctrl+d", "exit"],
];

/** Returns false when `text` is not a command, so the caller sends it to the agent. */
export async function runCommand(app: App, text: string): Promise<boolean> {
  const match = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  const command = COMMANDS.find((c) => c.name === match?.[1]);
  if (!match || !command) return false;
  const arg = match[2].trim();
  const handle = app.handle;
  switch (command.name) {
    case "sessions":
      await pickSession(app);
      break;
    case "agents":
      pickAgent(app);
      break;
    case "model":
      await pickModel(app);
      break;
    case "devices":
      pickDevice(app);
      break;
    case "new":
      await app.run(async () => {
        const created = await app.client.session(app.sessionId!).createAgent(arg ? { name: arg } : {});
        await app.attach(app.sessionId!, created.id);
        app.flash(`New agent ${created.name}`);
      });
      break;
    case "fork": {
      const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
      const explicit = first && /^\d+$/.test(first) ? Number(first) : undefined;
      const name = (explicit === undefined ? [first, ...rest] : rest).filter(Boolean).join(" ") || undefined;
      const entryId =
        explicit ?? app.model.state.entries.filter((e) => e.kind === "pi.assistant").at(-1)?.id;
      if (entryId === undefined) return app.flash("Nothing to fork yet.", true), true;
      await app.run(async () => {
        const created = await handle!.fork({ entryId, name });
        await app.attach(app.sessionId!, created.id);
        app.flash(`Forked at #${entryId} → ${created.name}`);
      });
      break;
    }
    case "thinking": {
      if (!THINKING_LEVELS.includes(arg as ThinkingLevel))
        return app.flash(`Levels: ${THINKING_LEVELS.join(", ")}`, true), true;
      await app.run(async () => {
        await handle!.configure({ thinkingLevel: arg as ThinkingLevel });
      });
      break;
    }
    case "compact":
      await app.run(async () => {
        await handle!.compact(arg || undefined);
        app.flash("Compaction requested");
      });
      break;
    case "reset":
      await app.run(async () => {
        await handle!.reset(arg || undefined);
        app.flash("New context started; history stays stored");
      });
      break;
    case "name":
      if (!arg) return app.flash("Usage: /name <name>", true), true;
      await app.run(async () => {
        await handle!.rename(arg);
        app.flash(`Agent renamed to ${arg}`);
      });
      break;
    case "tasks":
      app.overlay(
        new Panel(() => {
          const tasks = app.session.state.tasks;
          const lines = [c.bold(c.accent(`Live tasks in ${app.sessionSummary()?.name ?? "session"}`)), ""];
          if (!tasks.length) lines.push(c.muted("No live tasks."));
          for (const t of tasks)
            lines.push(
              `${t.background ? c.secondary("◌ bg") : c.warn("● fg")} #${t.id} ${t.kind} ${c.muted(`agent #${t.conversationId} │ ${t.state.status}${t.state.phase ? `/${t.state.phase}` : ""}`)}`,
            );
          lines.push("", c.muted("esc close"));
          return lines;
        }, () => app.closeOverlay()),
      );
      break;
    case "help":
      app.overlay(
        new Panel(
          () => [
            c.bold(c.accent("dpi-tui")),
            c.muted(`${app.device.id} │ ${app.device.url}`),
            "",
            ...KEYS.map(([k, d]) => `${c.secondary(k.padEnd(11))} ${d}`),
            "",
            ...COMMANDS.map((x) => `${c.secondary(`/${x.name}`.padEnd(11))} ${x.description ?? ""}`),
            "",
            c.muted("Closing dpi-tui never stops the agent. esc to close."),
          ],
          () => app.closeOverlay(),
        ),
      );
      break;
    case "quit":
      app.exit();
      break;
  }
  return true;
}
