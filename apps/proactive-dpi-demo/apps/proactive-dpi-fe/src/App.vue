<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowUpRight, FlaskConical, Info, Rocket, Siren, Volume2, X } from "lucide-vue-next";
import AgentChat from "./components/AgentChat.vue";
import EventStream from "./components/EventStream.vue";
import { api } from "./api";
import type { Config, DemoState, Incident, Speech, Stats, StreamRow, Verdict } from "./types";

const MAX_ROWS = 600;
const config = ref<Config>();
const rows = ref<StreamRow[]>([]);
const stats = ref<Stats>();
const demo = ref<DemoState>();
const incidents = ref<Incident[]>([]);
const streamConnected = ref(false);
const conversationId = ref(0);
const error = ref("");
const toast = ref<{ text: string; voice: boolean }>();
const alert = ref<Incident>();
const demoMenu = ref(false);
const now = ref(Date.now());
let stream: EventSource | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
let clock: ReturnType<typeof setInterval>;
const earlyVerdicts = new Map<number, Verdict>();

const liveRevision = computed(() => demo.value?.liveRevision?.replace("checkout-api-", "") ?? "…");
const countdown = computed(() => {
  if (!demo.value) return "Waiting for the log stream";
  if (demo.value.bugInjectedAt) return `Bug deployed at ${new Date(demo.value.bugInjectedAt).toLocaleTimeString()}`;
  if (!demo.value.bugAt) return "Scheduled bug deploy is off";
  const seconds = Math.max(0, Math.round((demo.value.bugAt - now.value) / 1000));
  return `Bug deploys in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});

function notify(text: string, voice = false) {
  toast.value = { text, voice };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = undefined), voice ? 9000 : 4500);
}

function upsertIncidents(list: Incident[]) {
  for (const incident of list) {
    const i = incidents.value.findIndex((x) => x.id === incident.id);
    if (i < 0) incidents.value.unshift(incident);
    else if (incident.updatedAt >= incidents.value[i].updatedAt) incidents.value[i] = incident;
  }
}

function selectConversation(id: number) {
  conversationId.value = id;
  if (alert.value?.conversationId === id) alert.value = undefined;
}

function connectStream() {
  stream?.close();
  stream = new EventSource("/api/stream");
  stream.addEventListener("init", (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    rows.value = data.rows;
    stats.value = data.stats;
    demo.value = data.demo;
    upsertIncidents(data.incidents);
    streamConnected.value = true;
    // Opening the page mid-incident lands on the agent doing the work.
    if (!conversationId.value) {
      const newest = [...incidents.value].sort((a, b) => b.openedAt - a.openedAt)[0];
      selectConversation(newest?.conversationId ?? config.value!.rootConversationId);
    }
  });
  stream.addEventListener("log", (e) => {
    const row: StreamRow = JSON.parse((e as MessageEvent).data);
    if (rows.value.length && rows.value[rows.value.length - 1].id >= row.id) return;
    row.verdict = earlyVerdicts.get(row.id);
    earlyVerdicts.delete(row.id);
    rows.value.push(row);
    if (rows.value.length > MAX_ROWS) rows.value.splice(0, rows.value.length - MAX_ROWS);
  });
  stream.addEventListener("verdict", (e) => {
    const verdict: Verdict = JSON.parse((e as MessageEvent).data);
    for (let i = rows.value.length - 1; i >= 0; i--)
      if (rows.value[i].id === verdict.logId) {
        rows.value[i].verdict = verdict;
        return;
      }
    earlyVerdicts.set(verdict.logId, verdict);
  });
  stream.addEventListener("status", (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    stats.value = data.stats;
    demo.value = data.demo;
  });
  stream.addEventListener("incident", (e) => {
    const incident: Incident = JSON.parse((e as MessageEvent).data);
    const fresh = !incidents.value.some((i) => i.id === incident.id);
    upsertIncidents([incident]);
    if (fresh && conversationId.value !== incident.conversationId) alert.value = incident;
  });
  stream.addEventListener("speech", (e) => {
    const speech: Speech = JSON.parse((e as MessageEvent).data);
    notify(speech.text, true);
    if (speech.browser && speech.url) void new Audio(speech.url).play().catch(() => {});
  });
  stream.onerror = () => (streamConnected.value = false);
}

async function deployBug() {
  demoMenu.value = false;
  try {
    await api("/demo/deploy-bug", {});
    notify("Bug deploy requested. The log stream ships it on its next row.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function keydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    demoMenu.value = false;
    alert.value = undefined;
  }
}

onMounted(async () => {
  document.addEventListener("keydown", keydown);
  clock = setInterval(() => (now.value = Date.now()), 1000);
  try {
    config.value = await api<Config>("/config");
    connectStream();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
onBeforeUnmount(() => {
  stream?.close();
  clearInterval(clock);
  clearTimeout(toastTimer);
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img class="brandmark" src="/icons/durable-pi.svg" alt="Durable Pi" /><strong
          >Proactive Agent</strong
        ><span class="brand-separator">/</span><span class="brand-scope">Lumen Market prod</span>
      </div>
      <div class="top-actions">
        <span class="watch-pill" :class="{ live: streamConnected }"
          ><i />Watching{{ demo?.rate ? ` ${demo.rate} rows/s` : "" }}</span
        ><span class="revision-pill" title="Live checkout-api revision"
          >checkout-api <b>{{ liveRevision }}</b></span
        >
        <div class="relative">
          <button
            class="icon-button"
            title="Demo controls"
            aria-label="Demo controls"
            :class="{ selected: demoMenu }"
            @click="demoMenu = !demoMenu"
          >
            <FlaskConical :size="19" />
          </button>
          <div v-if="demoMenu" class="dropdown demo-menu">
            <p class="demo-countdown">{{ countdown }}</p>
            <button :disabled="!!demo?.bugInjectedAt" @click="deployBug">
              <Rocket :size="18" />Deploy the bug now
            </button>
            <p class="hint">
              An incident opens after {{ config?.thresholds.incident }} incident verdicts or
              {{ config?.thresholds.suspicious }} suspicious verdicts with one fingerprint in
              {{ config?.thresholds.windowSeconds }}s. Jev via {{ config?.jev }}. Voice:
              {{ config?.tts }}.
            </p>
          </div>
        </div>
        <span class="version">v{{ config?.version ?? "1.0.3" }}</span>
      </div>
    </header>
    <div v-if="error" class="error-banner" role="alert">
      <Info :size="18" /><span>{{ error }}</span
      ><button class="icon-button" aria-label="Dismiss error" @click="error = ''">×</button>
    </div>
    <main class="workspace">
      <AgentChat
        v-if="config && conversationId"
        :config="config"
        :conversation-id="conversationId"
        :incidents="incidents"
        @select="selectConversation"
        @incidents="upsertIncidents"
        @notify="notify"
      />
      <section v-else class="chat-panel" />
      <EventStream
        :rows="rows"
        :stats="stats"
        :incidents="incidents"
        :connected="streamConnected"
        :selected="conversationId"
        @open="selectConversation"
      />
    </main>
    <Transition name="toast">
      <div v-if="alert" class="incident-alert" role="alert">
        <Siren :size="20" />
        <div>
          <strong>{{ alert.id }} opened by the watcher</strong>
          <span>{{ alert.title }}. A durable agent is already on it.</span>
        </div>
        <button class="primary small" @click="selectConversation(alert.conversationId)">
          Open agent<ArrowUpRight :size="18" />
        </button>
        <button class="icon-button" aria-label="Dismiss" @click="alert = undefined">
          <X :size="18" />
        </button>
      </div>
    </Transition>
    <Transition name="toast"
      ><div v-if="toast" class="toast" :class="{ voice: toast.voice }" role="status">
        <Volume2 v-if="toast.voice" :size="18" /><Info v-else :size="18" />{{ toast.text }}
      </div></Transition
    >
  </div>
</template>
