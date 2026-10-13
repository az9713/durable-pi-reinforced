<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  Activity,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderOpen,
  GitFork,
  MessageSquare,
  Pencil,
} from "lucide-vue-next";
import type { AgentSummary } from "@sdk/api";
import { lineage } from "@sdk/models";
import TranscriptItem from "./TranscriptItem.vue";
import DeviceIcon from "./DeviceIcon.vue";
import Composer from "./Composer.vue";
import {
  activeLineage,
  agent,
  agentHandle,
  agentState,
  device,
  notify,
  preset,
  select,
  selected,
  sessionAgents,
  sessionSummary,
  toggle,
  layout,
  ui,
} from "../client/store";

const chat = ref<HTMLElement>();
const lineageNav = ref<HTMLElement>();
const picker = ref(false);
const items = computed(() => agentState.value.items);
const liveItem = computed(() => items.value.some((i) => i.kind === "assistant" && i.streaming));
const runningTool = computed(() =>
  items.value.some(
    (i) =>
      (i.kind === "tool" && i.call.status === "running") ||
      (i.kind === "assistant" &&
        i.blocks.some((b) => b.type === "tool" && b.call.status === "running")),
  ),
);

const source = (a: AgentSummary) =>
  a.kind === "fork"
    ? `Forked from agent #${a.parentId} at entry #${a.forkedAt}`
    : a.kind === "subagent"
      ? `Owned by agent #${a.ownerAgentId}`
      : "Root agent";
const choices = computed(() =>
  sessionAgents.value
    .map((a) => ({ ...a, lineage: lineage(sessionAgents.value, a.id) }))
    .sort((a, b) => {
      for (let i = 0; i < Math.min(a.lineage.length, b.lineage.length); i++)
        if (a.lineage[i].id !== b.lineage[i].id) return a.lineage[i].id - b.lineage[i].id;
      return a.lineage.length - b.lineage.length;
    }),
);
const current = computed(() => activeLineage.value.at(-1));

const kindLabel = (a: AgentSummary) => (a.kind === "root" ? "agent" : a.kind);

/** Device crumb: show it in the network tree. Workspace crumb: open its root agent. */
function revealDevice() {
  if (!selected.value) return;
  layout.tree = true;
  toggle(selected.value.deviceId, true);
}
function openWorkspace() {
  const root = sessionAgents.value.find((a) => a.kind === "root") ?? sessionAgents.value[0];
  if (root) choose(root.id);
}

function choose(id: number) {
  picker.value = false;
  if (selected.value) select({ ...selected.value, agentId: id });
}

function fork(entryId: number) {
  const handle = agentHandle.value;
  const t = selected.value;
  if (!handle || !t) return;
  ui.dialog = {
    kind: "prompt",
    title: "Fork conversation",
    hint: `${current.value?.name ?? `Agent #${t.agentId}`} / entry #${entryId}. Leave the name blank to use Fork #ID.`,
    label: "Fork name",
    optional: true,
    placeholder: "e.g. Alternative approach",
    submit: "Create fork",
    run: async (name) => {
      const created = await handle.fork({ entryId, name: name || undefined });
      select({ ...t, agentId: created.id });
      notify(`Forked at entry #${entryId}. App State stays shared.`);
    },
  };
}

function renameAgent() {
  const handle = agentHandle.value;
  const a = current.value;
  if (!handle || !a) return;
  ui.dialog = {
    kind: "prompt",
    title: "Rename agent",
    label: "Agent name",
    value: a.named ? a.name : "",
    placeholder: a.name,
    submit: "Save name",
    run: (name) => handle.rename(name),
  };
}

watch(selected, () => {
  picker.value = false;
});

// Follow the bottom of the transcript unless the reader scrolled up.
let pinned = true;
watch(
  agent.version,
  () => {
    const el = chat.value;
    pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  },
  { flush: "pre" },
);
watch(agent.version, () => {
  if (pinned)
    void nextTick(() =>
      chat.value?.scrollTo({ top: chat.value.scrollHeight, behavior: "instant" }),
    );
});
watch(
  () => activeLineage.value.length,
  () =>
    void nextTick(
      () => lineageNav.value && (lineageNav.value.scrollLeft = lineageNav.value.scrollWidth),
    ),
);
</script>

<template>
  <section class="chat-panel">
    <header class="chat-header">
      <div class="lineage-picker">
        <div class="lineage-toolbar">
          <nav
            ref="lineageNav"
            class="crumbs conversation-lineage"
            aria-label="Conversation lineage"
          >
            <button class="crumb" :title="`${device?.name} · ${device?.url}`" @click="revealDevice">
              <span class="crumb-kind">device</span>
              <span class="crumb-main"
                ><DeviceIcon :device="device" :size="18" /><span class="device-chip">{{
                  device?.id
                }}</span></span
              >
            </button>
            <ChevronRight class="crumb-sep" :size="18" aria-hidden="true" />
            <button class="crumb" :title="sessionSummary?.cwd" @click="openWorkspace">
              <span class="crumb-kind">workspace</span>
              <span class="crumb-main"
                ><FolderOpen :size="18" aria-hidden="true" /><span class="crumb-name">{{
                  sessionSummary?.name
                }}</span></span
              >
            </button>
            <template v-for="c in activeLineage" :key="c.id">
              <ChevronRight class="crumb-sep" :size="18" aria-hidden="true" />
              <button
                class="crumb"
                :class="{ current: c.id === selected?.agentId }"
                :aria-current="c.id === selected?.agentId ? 'page' : undefined"
                :title="source(c)"
                @click="choose(c.id)"
              >
                <span class="crumb-kind">{{ kindLabel(c) }}</span>
                <span class="crumb-main"
                  ><GitFork
                    v-if="c.kind === 'fork'"
                    :size="18"
                    aria-hidden="true"
                  /><CornerDownRight
                    v-else-if="c.kind === 'subagent'"
                    :size="18"
                    aria-hidden="true"
                  /><MessageSquare v-else :size="18" aria-hidden="true" /><span
                    class="crumb-name"
                    >{{ c.name }}</span
                  ></span
                >
              </button>
            </template>
          </nav>
          <button
            class="icon-button"
            aria-label="Rename agent"
            title="Rename this agent"
            :disabled="!current"
            @click="renameAgent"
          >
            <Pencil :size="18" />
          </button>
          <button
            class="icon-button conversation-menu-toggle"
            aria-label="Browse conversations"
            aria-haspopup="dialog"
            :aria-expanded="picker"
            aria-controls="conversation-picker"
            title="Browse roots and forks"
            @click="picker = !picker"
          >
            <ChevronDown :size="18" />
          </button>
        </div>
        <div v-if="current && current.kind !== 'root'" class="lineage-source">
          {{ source(current) }}
        </div>
        <template v-if="picker">
          <button
            class="conversation-menu-dismiss"
            aria-label="Close conversation picker"
            @click="picker = false"
          />
          <section
            id="conversation-picker"
            class="conversation-picker"
            role="dialog"
            aria-label="Choose conversation"
          >
            <div class="conversation-picker-heading">Roots &amp; forks</div>
            <button
              v-for="c in choices"
              :key="c.id"
              class="conversation-choice"
              :class="{ selected: c.id === selected?.agentId }"
              :aria-label="c.lineage.map((x) => x.name).join(' → ')"
              :aria-current="c.id === selected?.agentId ? 'page' : undefined"
              @click="choose(c.id)"
            >
              <div class="conversation-choice-content">
                <span class="choice-lineage">
                  <template v-for="(ancestor, index) in c.lineage" :key="ancestor.id">
                    <ChevronRight v-if="index" :size="18" aria-hidden="true" />
                    <span :class="{ 'choice-ancestor': index < c.lineage.length - 1 }">{{
                      ancestor.name
                    }}</span>
                  </template>
                </span>
                <span class="choice-source">{{ source(c) }}</span>
              </div>
              <Check v-if="c.id === selected?.agentId" :size="18" aria-hidden="true" />
              <GitFork v-else-if="c.kind === 'fork'" :size="18" aria-hidden="true" />
              <MessageSquare v-else :size="18" aria-hidden="true" />
            </button>
          </section>
        </template>
      </div>
    </header>
    <div ref="chat" class="chat-scroll" data-testid="chat">
      <div v-if="!agentState.ready" class="chat-empty">
        <Activity :size="30" />
        <h2 v-if="agent.status.value === 'fault'">This agent is unavailable.</h2>
        <h2 v-else>Connecting to the agent…</h2>
        <p v-if="agent.fault.value" class="message-error">{{ agent.fault.value }}</p>
        <p v-else>The agent keeps working on {{ device?.id }} while this view connects.</p>
      </div>
      <template v-else>
        <div v-if="!items.length" class="chat-empty">
          <div class="agent-orb"><img src="/icons/durable-pi.svg" alt="Durable Pi" /><i /></div>
          <span class="eyebrow">YOUR DURABLE AGENT IS READY</span>
          <h2>A conversation with continuity.</h2>
          <p>Messages, tools and state live on {{ device?.id }}, beyond this window.</p>
          <div class="starter-grid">
            <button
              @click="
                preset(
                  'Inspect this directory using your tools and give me a brief overview. Do not modify any files.',
                )
              "
            >
              <FolderOpen :size="18" /><strong>Explore this directory</strong
              ><span>See coding tools in action</span><ArrowUpRight :size="18" /></button
            ><button
              @click="
                preset(
                  'Use read_state, then update_state to add a field called progress with value 1 and a boolean called ready with value false.',
                )
              "
            >
              <Braces :size="18" /><strong>Make a state change</strong
              ><span>Watch the workspace update</span><ArrowUpRight :size="18" />
            </button>
          </div>
        </div>
        <TranscriptItem v-for="item in items" :key="item.id" :item="item" @fork="fork" />
        <div v-if="agentState.running && !liveItem && !runningTool" class="entry live-generation">
          <div class="message-label">
            AGENT
            <span class="streaming">{{ agentState.retry ? "Retry scheduled" : "Working" }}</span>
          </div>
          <div class="typing"><i /><i /><i /></div>
        </div>
        <p v-if="agentState.retry" class="hint retry-note">
          Retrying: {{ agentState.retry.error }}
        </p>
        <p v-for="(n, i) in agentState.notices" :key="i" class="message-error">{{ n }}</p>
      </template>
    </div>
    <Composer />
  </section>
</template>
