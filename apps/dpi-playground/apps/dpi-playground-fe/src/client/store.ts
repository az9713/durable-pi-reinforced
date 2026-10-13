// App-wide state: one hub stream, the network, the selected agent and its session/device feeds,
// plus the command helpers every component shares.
import { computed, reactive, ref, shallowRef, watch } from "vue";
import type { AgentDetail, ModelInfo, NetworkDevice, TaskNode } from "@sdk/api";
import { sumUsage } from "@sdk/transcript";
import { lineage } from "@sdk/models";
import { HubStream } from "./stream";
import { deviceClient, hub, message } from "./hub";
import { useAgent, useDevice, useNetwork, useSession, type AgentTarget } from "./composables";

export const stream = new HubStream();
export const streamState = ref(stream.state);
stream.onState((s) => (streamState.value = s));
export const network = useNetwork(stream);
export const configFile = ref<string>();

// ------------------------------------------------------------------ selection + persisted UI state

export const selected = ref<AgentTarget>();
export const expanded = ref(new Set<string>());
export const treeWidth = ref(300);
/** Which side panels are expanded (persisted). Collapsed panels shrink to an icon rail. */
export const layout = reactive({ tree: true, inspector: true });
const uiLoaded = ref(false);

export const deviceId = computed(() => selected.value?.deviceId);
export const device = computed(() => network.devices.value.find((d) => d.id === deviceId.value));
export const online = computed(() => device.value?.status === "online");
export const sessionTarget = computed(() =>
  selected.value
    ? { deviceId: selected.value.deviceId, sessionId: selected.value.sessionId }
    : undefined,
);
export const session = useSession(stream, sessionTarget);
export const agent = useAgent(stream, selected);
export const deviceFeed = useDevice(stream, deviceId);

export const sessionSummary = computed(() =>
  device.value?.tree?.sessions.find((s) => s.id === selected.value?.sessionId),
);
export const client = computed(() => (deviceId.value ? deviceClient(deviceId.value) : undefined));
export const agentHandle = computed(() =>
  selected.value && client.value
    ? client.value.agent(selected.value.sessionId, selected.value.agentId)
    : undefined,
);
export const sessionHandle = computed(() =>
  selected.value && client.value ? client.value.session(selected.value.sessionId) : undefined,
);

export function select(target: AgentTarget | undefined) {
  selected.value = target;
  ui.drawer = false;
  pendingReveal = !!target;
  reveal();
}

// Expand the selected agent's device, session and ancestors once it shows up in the tree (a new
// fork or agent appears a moment after the call that created it).
let pendingReveal = false;
function reveal() {
  const t = selected.value;
  if (!pendingReveal || !t) return;
  const agents = network.devices.value
    .find((d) => d.id === t.deviceId)
    ?.tree?.sessions.find((s) => s.id === t.sessionId)?.agents;
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const keys = [
    t.deviceId,
    `${t.deviceId}/s/${t.sessionId}`,
    `${t.deviceId}/s/${t.sessionId}/a/${t.agentId}`,
  ];
  let current = byId.get(t.agentId);
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = current.parentId ?? current.ownerAgentId;
    if (parent === undefined) break;
    keys.push(`${t.deviceId}/s/${t.sessionId}/a/${parent}`);
    current = byId.get(parent);
  }
  if (keys.some((k) => !expanded.value.has(k)))
    expanded.value = new Set([...expanded.value, ...keys]);
  if (byId.has(t.agentId)) pendingReveal = false;
}
watch(() => network.devices.value, reveal);

export function toggle(key: string, open?: boolean) {
  const next = new Set(expanded.value);
  if (open ?? !next.has(key)) next.add(key);
  else next.delete(key);
  expanded.value = next;
}

const saveLater = (() => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return (key: string, value: unknown) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => void hub.uiSet(key, value).catch(() => {}), 300),
    );
  };
})();
// Selection saves at once so a quick reload restores it; drags (width) debounce.
watch(
  selected,
  (v) => uiLoaded.value && void hub.uiSet("tree.selected", v ?? null).catch(() => {}),
);
watch(treeWidth, (v) => uiLoaded.value && saveLater("tree.width", v));
watch(layout, (v) => uiLoaded.value && saveLater("layout.panels", { ...v }));

export async function boot() {
  stream.start();
  try {
    const [net, sel, width, panels] = await Promise.all([
      hub.network(),
      hub.uiGet<AgentTarget>("tree.selected"),
      hub.uiGet<number>("tree.width"),
      hub.uiGet<{ tree: boolean; inspector: boolean }>("layout.panels"),
    ]);
    if (panels) Object.assign(layout, panels);
    configFile.value = net.configFile;
    if (!network.model.devices.length)
      network.model.apply({ type: "network", devices: net.devices });
    // Every device starts folded; select() opens only the active device, workspace and agent.
    expanded.value = new Set();
    if (width) treeWidth.value = width;
    if (sel && net.devices.some((d) => d.id === sel.deviceId)) select(sel);
    else autoSelect(net.devices);
  } catch (e) {
    ui.error = message(e);
  } finally {
    uiLoaded.value = true;
  }
}

/** With nothing saved, open the first agent on the first online device that has a session. */
function autoSelect(devices: NetworkDevice[]) {
  for (const d of devices) {
    const s = d.status === "online" ? d.tree?.sessions[0] : undefined;
    const a = s?.agents.find((x) => x.kind === "root") ?? s?.agents[0];
    if (s && a) return select({ deviceId: d.id, sessionId: s.id, agentId: a.id });
  }
}

// The device answered "not found" for the selected agent and its session left the tree: it was archived.
watch(
  () => [agent.status.value, sessionSummary.value] as const,
  ([status, summary]) => {
    if (status !== "fault" || summary || !online.value) return;
    notify("That session was archived on its device.");
    select(undefined);
  },
);

// ------------------------------------------------------------------ derived agent views

export const models = computed<ModelInfo[]>(() => device.value?.info?.models ?? []);
export const agentState = agent.state;
export const sessionAgents = computed(() =>
  session.state.value.agents.length
    ? session.state.value.agents
    : (sessionSummary.value?.agents ?? []),
);
export const agentSummary = computed(() =>
  sessionAgents.value.find((a) => a.id === selected.value?.agentId),
);
export const activeLineage = computed(() =>
  selected.value ? lineage(sessionAgents.value, selected.value.agentId) : [],
);

/** Tasks of this agent and every subagent it owns (transitively), with inherited background. */
export const tasks = computed(() => {
  const id = selected.value?.agentId;
  if (id === undefined) return [] as (TaskNode & { effectiveBackground: boolean })[];
  const agents = sessionAgents.value;
  const owned = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const a of agents)
      if (a.ownerAgentId !== undefined && owned.has(a.ownerAgentId) && !owned.has(a.id)) {
        owned.add(a.id);
        changed = true;
      }
  }
  const all = session.state.value.tasks;
  const byId = new Map(all.map((t) => [t.id, t]));
  const ownerTask = new Map(agents.map((a) => [a.id, a.ownerTaskId]));
  return all
    .filter((t) => owned.has(t.conversationId))
    .map((task) => {
      let current: TaskNode | undefined = task;
      let effectiveBackground = false;
      const seen = new Set<number>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.background) {
          effectiveBackground = true;
          break;
        }
        const ownerId: number | undefined = current.owner ?? ownerTask.get(current.conversationId);
        current = ownerId === undefined ? undefined : byId.get(ownerId);
      }
      return { ...task, effectiveBackground };
    });
});
export const busy = computed(
  () =>
    agentState.value.running ||
    tasks.value.some((t) => !t.effectiveBackground && t.conversationId === selected.value?.agentId),
);
export const usage = computed(() => sumUsage(agentState.value.usage));
export const currentModel = computed(() => {
  const m = agentState.value.agent.model;
  return models.value.find((x) => x.provider === m?.provider && x.id === m?.modelId);
});

/** Tools and extensions come from GET agent (not streamed); refresh on selection and config changes. */
export const detail = shallowRef<AgentDetail>();
let detailSeq = 0;
export async function refreshDetail() {
  const handle = agentHandle.value;
  const seq = ++detailSeq;
  if (!handle || !online.value) return void (detail.value = undefined);
  try {
    const d = await handle.get();
    if (seq === detailSeq) detail.value = d;
  } catch {
    if (seq === detailSeq) detail.value = undefined;
  }
}
watch([agentHandle, online], () => void refreshDetail(), { immediate: true });

// ------------------------------------------------------------------ UI chrome

export const ui = reactive({
  error: "",
  toast: "",
  drawer: false,
  /** Narrow screens: the inspector opens over the chat instead of taking a column. */
  inspectorOverlay: false,
  tab: "session",
  composer: "",
  dialog: undefined as Dialog | undefined,
});

export type Dialog =
  | { kind: "new-session"; deviceId?: string }
  | { kind: "models" }
  | { kind: "help" }
  | { kind: "path"; path: string }
  | { kind: "compaction" }
  | {
      kind: "prompt";
      title: string;
      label?: string;
      value?: string;
      placeholder?: string;
      hint?: string;
      multiline?: boolean;
      optional?: boolean;
      submit: string;
      danger?: boolean;
      run: (value: string) => Promise<unknown>;
    };

let toastTimer: ReturnType<typeof setTimeout>;
export function notify(text: string) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast = ""), 4500);
}

export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  ui.error = "";
  try {
    return await fn();
  } catch (e) {
    ui.error = message(e);
    return undefined;
  }
}

export function preset(text: string) {
  ui.composer = text;
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
}

// ------------------------------------------------------------------ formatting

export const number = (n: number) =>
  Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const json = (v: unknown) => JSON.stringify(v, null, 2);
export const icon = (modelId = "") =>
  `/icons/${models.value.find((m) => m.id === modelId)?.icon ?? "lab.png"}`;
export const shortPath = (s = "", n = 34) => (s.length > n ? "…" + s.slice(-(n - 1)) : s);
export function ago(ms?: number) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ------------------------------------------------------------------ shared agent commands

export const interrupting = ref(false);
/** Escape and the Interrupt button: stop foreground work and owned subagents; background jobs continue. */
export async function interrupt() {
  if (!busy.value || interrupting.value || !agentHandle.value) return;
  interrupting.value = true;
  const done = await attempt(() => agentHandle.value!.abort(false));
  if (done) notify("Foreground work interrupted. Background jobs continue.");
  interrupting.value = false;
}

// ------------------------------------------------------------------ panel layout

const narrowQuery = window.matchMedia("(max-width: 1100px)");
/** Below 1100px the inspector never takes a column; it opens over the chat. */
export const narrow = ref(narrowQuery.matches);
narrowQuery.addEventListener("change", (e) => (narrow.value = e.matches));
export const inspectorExpanded = computed(() =>
  narrow.value ? ui.inspectorOverlay : layout.inspector,
);

/** Show the inspector, optionally on a tab: expand its column, or open it over the chat when narrow. */
export function showInspector(tab?: string) {
  if (tab) ui.tab = tab;
  if (narrow.value) ui.inspectorOverlay = true;
  else layout.inspector = true;
}

export function hideInspector() {
  if (narrow.value) ui.inspectorOverlay = false;
  else layout.inspector = false;
}

export function toggleTree() {
  if (!narrow.value) layout.tree = !layout.tree;
  else if ((ui.drawer = !ui.drawer)) layout.tree = true;
}

export function toggleInspector() {
  if (inspectorExpanded.value) hideInspector();
  else showInspector();
}

// Panel hotkeys. macOS browsers use Cmd for new window/tab, so Ctrl+N and Ctrl+T reach the page;
// elsewhere browsers reserve Ctrl+N and Ctrl+T, so Alt+Shift takes their place.
const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
export const panelKeys = mac
  ? { tree: "Ctrl+N", inspector: "Ctrl+T" }
  : { tree: "Alt+Shift+N", inspector: "Alt+Shift+T" };

export function panelHotkey(e: KeyboardEvent): "tree" | "inspector" | undefined {
  const held = mac
    ? e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    : e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
  if (!held || e.repeat || e.isComposing) return;
  if (e.code === "KeyN") return "tree";
  if (e.code === "KeyT") return "inspector";
}
