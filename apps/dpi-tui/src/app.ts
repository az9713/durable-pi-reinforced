// The TUI: one device, one agent at a time. Layout, keys and streams; rendering lives in render.ts.
import {
  CombinedAutocompleteProvider,
  Editor,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type OverlayHandle,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import { DpiClient, follow, type AgentHandle, type ConnectionState } from "../../dpi-sdk/src/client.ts";
import { isDpiError } from "../../dpi-sdk/src/errors.ts";
import { AgentModel, SessionModel } from "../../dpi-sdk/src/models.ts";
import { sumUsage } from "../../dpi-sdk/src/transcript.ts";
import {
  THINKING_LEVELS,
  type DeviceInfo,
  type SessionSummary,
  type ThinkingLevel,
  type WhenBusy,
  type WireAssistantMessage,
} from "../../dpi-sdk/src/api.ts";
import type { NetworkRegistry } from "../../dpi-sdk/src/node/registry.ts";
import { COMMANDS, runCommand } from "./commands.ts";
import { pickModel, pickSession, Prompt } from "./pickers.ts";
import { Line, spinner, TranscriptView } from "./render.ts";
import { c, editorTheme } from "./theme.ts";

export interface DeviceRef {
  id: string;
  name: string;
  url: string;
  token: string;
}

const newId = () => crypto.randomUUID();
/** Quote a shell word only when it needs it. */
const shellWord = (s: string) => (/^[\w.:@/~-]+$/.test(s) ? s : `'${s}'`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const compact = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export class App {
  readonly tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, {
    scrollToEndIndicator: () => c.muted(" ↓ new output "),
  });
  readonly model = new AgentModel();
  readonly session = new SessionModel();
  sessionId?: string;
  agentId?: number;
  handle?: AgentHandle;
  private header = new Line("");
  private view = new TranscriptView();
  private status = new Text("", 1, 0);
  private editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
  private footer = new Line("");
  private connection: ConnectionState | "idle" = "idle";
  private streams?: AbortController;
  private overlays: OverlayHandle[] = [];
  private notice?: { text: string; error: boolean; at: number };
  private ticker?: ReturnType<typeof setInterval>;
  private sessions: SessionSummary[] = [];

  constructor(
    public device: DeviceRef,
    public client: DpiClient,
    public info: DeviceInfo,
    public registry?: NetworkRegistry,
  ) {
    this.tui.setLayoutRoot(
      new VStack([
        { component: this.header, basis: "auto" },
        { component: new ScrollView(this.view, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 3 },
        { component: this.status, basis: "auto", visible: () => this.statusLines().length > 0 },
        { component: this.editor, basis: "auto", shrink: 1, minSize: 1 },
        { component: this.footer, basis: "auto" },
      ]),
    );
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));
    this.editor.onSubmit = (text) => void this.submit(text, this.busy() ? "steer" : "followUp");
    this.tui.addInputListener((data) => this.key(data));
    this.model.subscribe(() => this.redraw());
    this.session.subscribe(() => this.redraw(false));
    this.tui.setFocus(this.editor);
    this.tui.start();
    this.redraw();
  }

  // ------------------------------------------------------------------ streams

  async open(sessionRef?: string, agentRef?: string) {
    if (!sessionRef) return pickSession(this);
    await this.run(async () => {
      const s = await this.client.session(sessionRef).get();
      const agentId = agentRef
        ? (await this.client.agent(s.id, agentRef).get()).id
        : (s.agents.find((a) => a.kind === "root") ?? s.agents[0])?.id ?? 1;
      await this.attach(s.id, agentId);
    });
    if (!this.sessionId) await pickSession(this);
  }

  async attach(sessionId: string, agentId: number) {
    this.streams?.abort();
    const streams = (this.streams = new AbortController());
    const sameSession = sessionId === this.sessionId;
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.handle = this.client.agent(sessionId, agentId);
    this.model.clear();
    this.view.reset();
    if (!sameSession) this.session.clear();
    void this.refreshSessions();
    const handle = this.handle;
    void follow(
      (signal) => handle.events(signal),
      (frame) => this.model.apply(frame),
      (state, error) => {
        this.connection = state;
        if (error && state !== "offline") this.flash(error.message, true);
        this.redraw(false);
      },
      streams.signal,
    );
    void follow(
      (signal) => this.client.session(sessionId).events(signal),
      (frame) => this.session.apply(frame),
      () => {},
      streams.signal,
    );
  }

  async switchDevice(id: string) {
    const row = this.registry?.get(id);
    if (!row?.token) return this.flash(`No token for ${id}. Run: just net register ${id}`, true);
    const client = new DpiClient(row.url, row.token);
    await this.run(async () => {
      this.info = await client.device({ timeoutMs: 8000 });
      this.streams?.abort();
      this.device = { id: row.id, name: row.name, url: row.url, token: row.token! };
      this.client = client;
      this.sessionId = undefined;
      this.agentId = undefined;
      this.handle = undefined;
      this.model.clear();
      this.session.clear();
      this.view.reset();
      await pickSession(this);
    });
  }

  private async refreshSessions() {
    try {
      this.sessions = (await this.client.tree()).sessions;
      this.redraw(false);
    } catch {}
  }

  sessionSummary(): SessionSummary | undefined {
    const s = this.sessions.find((x) => x.id === this.sessionId);
    return s && this.session.state.ready ? { ...s, agents: this.session.state.agents } : s;
  }

  // ------------------------------------------------------------------ input

  busy() {
    return this.model.state.running || (this.agentId !== undefined && this.session.foregroundBusy(this.agentId));
  }

  private key(data: string): TuiInputListenerResult {
    if (matchesKey(data, "ctrl+c")) {
      if (this.overlays.length) return this.closeOverlay(), { consume: true };
      if (this.editor.getText()) return this.editor.setText(""), { consume: true };
      this.exit();
      return { consume: true };
    }
    if (this.overlays.length) return undefined;
    if (matchesKey(data, "ctrl+d") && !this.editor.getText()) return this.exit(), { consume: true };
    if (matchesKey(data, "escape") && !this.editor.isShowingAutocomplete()) {
      if (this.busy()) void this.interrupt();
      return { consume: true };
    }
    if (matchesKey(data, "alt+enter")) {
      const text = this.editor.getText();
      this.editor.setText("");
      void this.submit(text, "followUp");
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) return void this.cycleThinking(), { consume: true };
    if (matchesKey(data, "ctrl+l")) return void pickModel(this), { consume: true };
    if (matchesKey(data, "ctrl+o")) {
      this.view.expand = !this.view.expand;
      this.redraw();
      return { consume: true };
    }
    return undefined;
  }

  private async submit(text: string, whenBusy: WhenBusy) {
    const content = text.trim();
    if (!content) return;
    if (content.startsWith("/") && (await runCommand(this, content))) return;
    if (!this.handle) return this.flash("Pick a session first (/sessions).", true);
    // The same requestId on every retry: the device admits the message exactly once.
    const requestId = newId();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.handle.send(content, whenBusy, requestId);
        this.editor.addToHistory(content);
        if (whenBusy === "steer") this.flash("Steering: joins after the current tool round");
        return;
      } catch (e) {
        if (isDpiError(e) && e.code === "offline" && attempt < 3) {
          await sleep(1000 * attempt);
          continue;
        }
        if (!this.editor.getText()) this.editor.setText(text);
        this.flash(isDpiError(e) && e.code === "busy" ? "Agent is busy (reject mode)" : (e as Error).message, true);
        return;
      }
    }
  }

  private async interrupt() {
    await this.run(async () => {
      await this.handle?.abort(false);
      this.flash("Interrupted. Background jobs continue.");
    });
  }

  private async cycleThinking() {
    if (!this.handle) return;
    const current = (this.model.state.agent.thinkingLevel ?? "low") as ThinkingLevel;
    const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(current) + 1) % THINKING_LEVELS.length];
    await this.run(() => this.handle!.configure({ thinkingLevel: next }));
  }

  // ------------------------------------------------------------------ overlays and helpers

  overlay(component: Component) {
    this.overlays.push(this.tui.showOverlay(component, { width: "70%", minWidth: 40, maxHeight: "80%" }));
    this.tui.requestRender();
  }

  closeOverlay(exitIfNothing = false) {
    this.overlays.pop()?.hide();
    if (!this.overlays.length) this.tui.setFocus(this.editor);
    if (exitIfNothing) return this.exit();
    this.tui.requestRender();
  }

  prompt(label: string, initial: string) {
    return new Promise<string | undefined>((done) => {
      this.overlay(
        new Prompt(
          label,
          initial,
          (value) => {
            this.closeOverlay();
            done(value.trim());
          },
          () => {
            this.closeOverlay();
            done(undefined);
          },
        ),
      );
    });
  }

  flash(text: string, error = false) {
    this.notice = { text, error, at: Date.now() };
    this.redraw(false);
    setTimeout(() => this.redraw(false), 6100);
  }

  async run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.flash((e as Error).message, true);
    }
  }

  exit() {
    this.streams?.abort();
    clearInterval(this.ticker);
    this.tui.stop();
    const ref = this.reattachRef();
    if (ref) {
      const adhoc = this.device.id === "adhoc";
      const target = adhoc
        ? `--url ${this.device.url} --token <token> -s ${shellWord(ref.session)} -a ${shellWord(ref.agent)}`
        : shellWord(`${this.device.id}:${ref.session}:${ref.agent}`);
      process.stdout.write(
        `\n${c.muted("The agent keeps running on")} ${adhoc ? this.device.name : this.device.id}${c.muted(". Reattach:")}\n  just tui attach ${target}\n\n`,
      );
    }
    process.exit(0);
  }

  /** Names when they resolve to exactly this session and agent, otherwise ids. */
  private reattachRef() {
    const session = this.sessionSummary();
    const agent = session?.agents.find((a) => a.id === this.agentId);
    if (!session || this.agentId === undefined) return undefined;
    const usable = (name: string) => !name.includes(":") && !name.includes("'");
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const sessionRef =
      usable(session.name) && this.sessions.filter((s) => same(s.name, session.name)).length === 1 ? session.name : session.id;
    const agentRef =
      agent?.named && usable(agent.name) && session.agents.filter((a) => same(a.name, agent.name)).length === 1
        ? agent.name
        : this.agentId === 1
          ? "main"
          : String(this.agentId);
    return { session: sessionRef, agent: agentRef };
  }

  // ------------------------------------------------------------------ chrome

  /** Context window left, in percent: the last reply's prompt + output against the model's window. */
  private contextLeft(): number | undefined {
    const s = this.model.state;
    const m = s.agent.model;
    const window = this.info.models.find((x) => x.id === m?.modelId && x.provider === m?.provider)?.contextWindow;
    if (!window) return undefined;
    let used = 0;
    for (let i = s.entries.length - 1; i >= 0 && !used; i--) {
      const entry = s.entries[i];
      if (entry.kind !== "pi.assistant") continue;
      const reply = entry.model?.find((x) => x.role === "assistant") as WireAssistantMessage | undefined;
      const u = reply?.usage;
      if (u) used = u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
    }
    return Math.max(0, Math.min(100, Math.floor(100 * (1 - used / window))));
  }

  private statusLines() {
    const s = this.model.state;
    const lines: string[] = [];
    if (this.busy())
      lines.push(
        `${c.warn("●")} ${c.secondary(s.retry ? `retrying: ${s.retry.error}` : s.compactions.length ? "compacting…" : "working…")} ${c.muted("esc to interrupt")}`,
      );
    for (const item of s.inbox)
      lines.push(c.muted(`${item.mode === "steer" ? "↪ steer" : "⏳ queued"}: ${(item.content ?? "context update").replace(/\s+/g, " ")}`));
    for (const n of s.notices.slice(-2)) lines.push(c.err(n));
    if (this.notice && Date.now() - this.notice.at < 6000)
      lines.push(this.notice.error ? c.err(this.notice.text) : c.ok(this.notice.text));
    return lines;
  }

  private redraw(items = true) {
    const s = this.model.state;
    if (items) this.view.update(s.items);
    const running = s.items.some(
      (i) => (i.kind === "tool" && i.call.status === "running") || (i.kind === "assistant" && i.blocks.some((b) => b.type === "tool" && b.call.status === "running")),
    );
    if (running && !this.ticker)
      this.ticker = setInterval(() => {
        spinner.frame++;
        this.tui.requestRender();
      }, 120);
    else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    const conn =
      this.connection === "live"
        ? c.ok("● live")
        : this.connection === "idle"
          ? c.muted("○ no agent")
          : this.connection === "connecting"
            ? c.warn("◌ connecting")
            : c.err(`○ ${this.connection}`);
    const lineage = this.agentId === undefined ? [] : this.session.lineage(this.agentId);
    const label = (kind: string, value: string) => `${c.muted(kind)} ${value}`;
    const agentLabel = lineage.length
      ? lineage
          .map((a) =>
            a.kind === "fork"
              ? label("fork", `⑂ ${a.name}`)
              : a.kind === "subagent"
                ? label("subagent", `↳ ${a.name}`)
                : label("agent", a.name),
          )
          .join(c.muted(" › "))
      : this.agentId !== undefined
        ? label("agent", `#${this.agentId}`)
        : "";
    const session = this.sessions.find((x) => x.id === this.sessionId);
    this.header.text = " " + (
      [
        c.bold(c.accent("dpi")),
        label("device", c.secondary(this.device.id)),
        session ? label("workspace", c.bold(session.name)) : c.muted("no workspace"),
        agentLabel,
        conn,
      ]
        .filter(Boolean)
        .join(c.muted("  │  "))
    );
    this.status.setText(this.statusLines().join("\n"));
    const u = sumUsage(s.usage);
    const model = (s.agent.model?.modelId ?? "").split("/").pop();
    const ctx = this.contextLeft();
    const bg = this.agentId === undefined ? 0 : this.session.backgroundTasks(this.agentId).length;
    this.footer.text = " " + (
      c.muted(
        [
          model ? `${model}: ${s.agent.thinkingLevel ?? "low"}` : "",
          ctx === undefined ? "" : `${ctx}% CTX`,
          `${compact(u.tokens)} tok $${u.cost.toFixed(3)}`,
          bg ? `${bg} bg` : "",
          "/help",
        ]
          .filter(Boolean)
          .join(" │ "),
      )
    );
    this.tui.requestRender();
  }
}
