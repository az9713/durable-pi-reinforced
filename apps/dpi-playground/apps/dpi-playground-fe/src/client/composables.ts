// Vue bindings over the SDK models. Each model stays a plain object (no deep proxies); a version
// counter bumps on every change so computed views re-evaluate once per frame.
import { computed, ref, shallowRef, watch, type Ref } from "vue";
import { AgentModel, NetworkModel, SessionModel } from "@sdk/models";
import type { Activity, Frame } from "@sdk/api";
import type { AppState } from "@sdk/app-state";
import type { HubStream } from "./stream";

export interface SessionTarget {
  deviceId: string;
  sessionId: string;
}
export interface AgentTarget extends SessionTarget {
  agentId: number;
}
export type FeedStatus = "idle" | "connecting" | "live" | "reconnecting" | "fault";

export const AGENT_DOCS = ["demo.job-runs", "demo.workspace"];
export const agentSub = (t: AgentTarget) =>
  `${t.deviceId}/agent/${t.sessionId}/${t.agentId}?docs=${AGENT_DOCS.join(",")}`;
export const sessionSub = (t: SessionTarget) => `${t.deviceId}/session/${t.sessionId}`;
export const deviceSub = (id: string) => `${id}/device?docs=app.shared-state`;

/** Shared bookkeeping for one stream slot: hello → live, disconnected → reconnecting, fault. */
function feed(
  stream: HubStream,
  slot: "device" | "session" | "agent",
  apply: (frame: Frame) => void,
) {
  const status = ref<FeedStatus>("idle");
  const fault = ref("");
  stream.route(slot, (frame) => {
    if (frame.type === "hello") status.value = "live";
    else if (frame.type === "disconnected") status.value = "reconnecting";
    else if (frame.type === "fault") {
      status.value = "fault";
      fault.value = frame.error.message;
    } else apply(frame);
  });
  const select = (key?: string) => {
    fault.value = "";
    status.value = key ? "connecting" : "idle";
    stream.set(slot, key);
  };
  return { status, fault, select };
}

export function useNetwork(stream: HubStream) {
  const model = new NetworkModel();
  const version = ref(0);
  model.subscribe(() => version.value++);
  stream.onNetwork((devices) => model.apply({ type: "network", devices }));
  const devices = computed(() => (version.value, model.devices));
  const tree = computed(() => (version.value, model.tree()));
  return { model, devices, tree };
}

export function useDevice(stream: HubStream, deviceId: Ref<string | undefined>) {
  const sharedState = shallowRef<{ value: AppState; revision: number }>();
  const activity = shallowRef<Activity[]>([]);
  const { status, select } = feed(stream, "device", (frame) => {
    if (frame.type === "doc" && frame.kind === "app.shared-state")
      sharedState.value = { value: frame.value as AppState, revision: frame.revision ?? 0 };
    else if (frame.type === "activity")
      activity.value = [...activity.value, ...frame.items].slice(-50);
  });
  watch(
    deviceId,
    (id) => {
      sharedState.value = undefined;
      select(id ? deviceSub(id) : undefined);
    },
    { immediate: true },
  );
  return { sharedState, activity, status };
}

export function useSession(stream: HubStream, target: Ref<SessionTarget | undefined>) {
  const model = new SessionModel();
  const version = ref(0);
  model.subscribe(() => version.value++);
  const { status, fault, select } = feed(stream, "session", (frame) => model.apply(frame));
  watch(
    () => (target.value ? sessionSub(target.value) : undefined),
    (key) => {
      model.clear();
      select(key);
    },
    { immediate: true },
  );
  const state = computed(() => (version.value, model.state));
  return { model, state, status, fault };
}

export function useAgent(stream: HubStream, target: Ref<AgentTarget | undefined>) {
  const model = new AgentModel();
  const version = ref(0);
  model.subscribe(() => version.value++);
  const { status, fault, select } = feed(stream, "agent", (frame) => model.apply(frame));
  watch(
    () => (target.value ? agentSub(target.value) : undefined),
    (key) => {
      model.clear();
      select(key);
    },
    { immediate: true },
  );
  // A fresh object per version: the model mutates its state in place.
  const state = computed(() => (version.value, { ...model.state }));
  return { model, state, status, fault, version };
}
