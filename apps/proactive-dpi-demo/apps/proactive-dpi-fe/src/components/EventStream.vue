<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { ArrowDown, ArrowUpRight, Radar, Siren, X } from "lucide-vue-next";
import { STATUS_LABELS } from "../api";
import type { Incident, Stats, StreamRow } from "../types";

const props = defineProps<{
  rows: StreamRow[];
  stats?: Stats;
  incidents: Incident[];
  connected: boolean;
  selected: number;
}>();
const emit = defineEmits<{ open: [conversationId: number] }>();

// Incident strips: ✕ dismisses one. A deployed incident (rolled out and verified) closes itself
// after a moment if it was watched getting there, and stays closed if it was already deployed on load.
const DEPLOYED_CLOSE_MS = 6000;
const dismissed = reactive(new Set<string>());
const watchedOpen = new Set<string>();
const closing = new Set<string>();
const visibleIncidents = computed(() => props.incidents.filter((i) => !dismissed.has(i.id)));
watch(
  () => props.incidents.map((i) => [i.id, i.status] as const),
  (list) => {
    for (const [id, status] of list) {
      if (status !== "deployed") watchedOpen.add(id);
      else if (!watchedOpen.has(id)) dismissed.add(id);
      else if (!closing.has(id)) {
        closing.add(id);
        setTimeout(() => dismissed.add(id), DEPLOYED_CLOSE_MS);
      }
    }
  },
  { immediate: true },
);

const scroller = ref<HTMLElement>();
const paused = ref(false);
const unseen = ref(0);
const expanded = reactive(new Set<number>());
const DECISIONS = ["normal", "suspicious", "incident"] as const;

const lastId = computed(() => props.rows.at(-1)?.id ?? 0);
const time = (ts: string) => ts.slice(11, 19);
const statusClass = (status: number | null) =>
  status === null ? "" : status >= 500 ? "s5" : status >= 400 ? "s4" : "s2";

function jev(row: StreamRow) {
  const v = row.verdict;
  if (!v) return { kind: "pending", label: "judging" };
  if (v.status === "error") return { kind: "error", label: "jev error" };
  if (v.status === "skipped") return { kind: "skipped", label: "skipped" };
  return { kind: v.decision!, label: `${v.decision} ${v.probability?.toFixed(2)}` };
}

function toggle(id: number) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

// The newest scroll position the stream set itself. A scroll event that lands there is ours, even when
// rows arrived in between; only a scroll above it is the viewer reading back.
let followTop = 0;

function follow() {
  const el = scroller.value;
  if (!el) return;
  followTop = el.scrollHeight - el.clientHeight;
  el.scrollTop = followTop;
}

function onScroll() {
  const el = scroller.value!;
  if (!paused.value && el.scrollTop >= followTop - 2) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  paused.value = !atBottom;
  if (atBottom) unseen.value = 0;
}

function resume() {
  paused.value = false;
  unseen.value = 0;
  void nextTick(follow);
}

watch(lastId, (now, before) => {
  if (paused.value) {
    unseen.value += Math.max(0, now - before);
    return;
  }
  void nextTick(follow);
});
</script>

<template>
  <section class="stream-panel">
    <header class="stream-header">
      <div class="stream-title">
        <Radar :size="20" />
        <div>
          <h2>Event stream</h2>
          <small>lumen-market-prod / Cloud Run / us-central1</small>
        </div>
      </div>
      <span v-if="!connected" class="stream-live"><i />Reconnecting</span>
    </header>
    <div class="stream-stats">
      <div><span>{{ stats?.judged ?? 0 }}</span><small>judged</small></div>
      <div class="normal"><span>{{ stats?.normal ?? 0 }}</span><small>normal</small></div>
      <div class="suspicious"><span>{{ stats?.suspicious ?? 0 }}</span><small>suspicious</small></div>
      <div class="incident"><span>{{ stats?.incident ?? 0 }}</span><small>incident</small></div>
      <div><span>${{ (stats?.spend ?? 0).toFixed(4) }}</span><small>Jev spend</small></div>
      <div><span>{{ stats?.latencyMs ?? 0 }}ms</span><small>avg decision</small></div>
    </div>
    <TransitionGroup name="toast">
      <div
        v-for="incident in visibleIncidents"
        :key="incident.id"
        class="stream-incident"
        :class="[incident.status, { current: incident.conversationId === selected }]"
      >
        <button class="stream-incident-open" @click="emit('open', incident.conversationId)">
          <Siren :size="18" /><strong>{{ incident.id }}</strong
          ><span class="stream-incident-title">{{ incident.title }}</span
          ><span class="incident-status"><i />{{ STATUS_LABELS[incident.status] }}</span
          ><span class="open-agent">Open agent<ArrowUpRight :size="16" /></span>
        </button>
        <button
          class="icon-button stream-incident-close"
          :aria-label="`Dismiss ${incident.id}`"
          title="Dismiss"
          @click="dismissed.add(incident.id)"
        >
          <X :size="18" />
        </button>
      </div>
    </TransitionGroup>
    <div class="log-head">
      <span>Time</span><span>Severity</span><span>Service</span><span>Event</span><span>Jev decision</span>
    </div>
    <div ref="scroller" class="log-scroll" @scroll="onScroll">
      <div v-if="!rows.length" class="empty-panel">
        <Radar :size="28" /><strong>Waiting for log rows</strong
        ><span>Start the log stream with npm run logs.</span>
      </div>
      <div
        v-for="row in rows"
        :key="row.id"
        class="log-row"
        :class="[`jev-${jev(row).kind}`, { open: expanded.has(row.id) }]"
        @click="toggle(row.id)"
      >
        <span class="log-time">{{ time(row.ts) }}</span>
        <span class="sev" :class="row.severity">{{ row.severity }}</span>
        <span class="log-service">{{ row.service }}</span>
        <span class="log-event"
          ><template v-if="row.method"
            ><b>{{ row.method }}</b> {{ row.route }}
            <em :class="statusClass(row.status)">{{ row.status }}</em>
            <small>{{ row.latencyMs }}ms</small> </template
          >{{ row.message }}<em v-if="row.errorType" class="s5 error-type">{{ row.errorType }}</em></span
        >
        <span class="jev-chip" :class="jev(row).kind">{{ jev(row).label }}</span>
        <div v-if="expanded.has(row.id)" class="log-detail" @click.stop>
          <div v-if="row.verdict?.probabilities" class="jev-bars">
            <div v-for="d in DECISIONS" :key="d" :class="d">
              <span>{{ d }}</span>
              <div><i :style="{ width: `${(row.verdict.probabilities[d] ?? 0) * 100}%` }" /></div>
              <b>{{ (row.verdict.probabilities[d] ?? 0).toFixed(2) }}</b>
            </div>
          </div>
          <p v-if="row.verdict" class="jev-facts">
            <template v-if="row.verdict.impact !== undefined"
              >Impact {{ row.verdict.impact.toFixed(2) }} of 4 / </template
            >{{ row.verdict.fingerprint }}<template v-if="row.verdict.latencyMs">
              / {{ row.verdict.latencyMs }}ms / ${{ (row.verdict.cost ?? 0).toFixed(6) }} /
              {{ row.verdict.model }}</template
            ><template v-if="row.verdict.error"> / {{ row.verdict.error }}</template>
          </p>
          <pre>{{ JSON.stringify(row.entry, null, 2) }}</pre>
        </div>
      </div>
    </div>
    <button v-if="paused && unseen" class="resume-stream" @click="resume">
      <ArrowDown :size="16" />{{ unseen }} new rows
    </button>
  </section>
</template>
