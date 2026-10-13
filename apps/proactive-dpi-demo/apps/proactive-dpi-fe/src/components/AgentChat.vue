<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  Activity,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Info,
  Layers,
  MessageSquare,
  Radar,
  Square,
  Wrench,
  X,
  Clock3,
  GitCommitHorizontal,
  Rocket,
} from "lucide-vue-next";
import { marked } from "marked";
import DOMPurify from "dompurify";
import IncidentCard from "./IncidentCard.vue";
import { api } from "../api";
import type { ChatSnapshot, Config, Incident, Message, Model } from "../types";

const props = defineProps<{ config: Config; conversationId: number; incidents: Incident[] }>();
const emit = defineEmits<{
  select: [id: number];
  incidents: [list: Incident[]];
  notify: [text: string];
}>();

const snap = ref<ChatSnapshot>();
const connected = ref(false);
const input = ref("");
const mode = ref("followUp");
const pending = ref(false);
const error = ref("");
const modelMenu = ref(false);
const modelSearch = ref("");
const chat = ref<HTMLElement>();
let events: EventSource | undefined;
let epoch = 0;

const rootId = computed(() => props.config.rootConversationId);
const incident = computed(() => props.incidents.find((i) => i.conversationId === props.conversationId));
const tabs = computed(() => [...props.incidents].sort((a, b) => a.openedAt - b.openedAt));
const agent = computed(() => snap.value?.view.docs["pi.agent"]);
const live = computed(() => snap.value?.view.docs["pi.live"]);
const busy = computed(() => !!live.value?.run);
const inbox = computed(() => snap.value?.view.docs["pi.inbox"]?.items ?? []);
const pendingDeploy = computed(() => snap.value?.deploys.find((d) => d.status === "awaiting_approval"));
const rollingDeploy = computed(() =>
  snap.value?.deploys.find((d) => d.status === "deploying" || d.status === "verifying"),
);
const deciding = ref(false);
const entries = computed(() => snap.value?.view.entries ?? []);
const selectedModel = computed(() =>
  props.config.models.find((m) => m.id === agent.value?.model?.modelId),
);
const filteredModels = computed(() =>
  props.config.models.filter((m) =>
    `${m.name} ${m.id} ${m.tier}`.toLowerCase().includes(modelSearch.value.toLowerCase()),
  ),
);
const usage = computed(() =>
  Object.values(snap.value?.view.docs["pi.usage"]?.models ?? {}).reduce(
    (a, u) => ({
      tokens: a.tokens + (u.totalTokens ?? u.input + u.output + u.cacheRead + u.cacheWrite),
      cost: a.cost + (u.cost?.total ?? 0),
    }),
    { tokens: 0, cost: 0 },
  ),
);
const blocks = (m: Message) =>
  typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
const toolCallIds = computed(
  () =>
    new Set(
      entries.value
        .filter((e) => e.kind === "pi.assistant")
        .flatMap((e) => (e.model ?? []).flatMap(blocks))
        .filter((b) => b.type === "toolCall" && b.id)
        .map((b) => b.id!),
    ),
);
const toolResults = computed(() => {
  const results = new Map<string, Message>();
  for (const entry of entries.value)
    if (entry.kind === "pi.tool-result")
      for (const m of entry.model ?? []) if (m.toolCallId) results.set(m.toolCallId, m);
  return results;
});
const liveTools = computed(() => new Map((live.value?.tools ?? []).map((t) => [t.callId, t])));
const unmatched = (messages: Message[] = []) =>
  messages.filter((m) => !m.toolCallId || !toolCallIds.value.has(m.toolCallId));
const visibleEntries = computed(() =>
  entries.value.filter(
    (e) => e.kind !== "pi.system" && (e.kind !== "pi.tool-result" || unmatched(e.model).length),
  ),
);
/** The watcher's brief is the incident conversation's first user message. */
const briefEntryId = computed(() =>
  incident.value ? entries.value.find((e) => e.kind === "pi.user")?.id : undefined,
);
const textOf = (m: Message) => blocks(m).map((b) => b.text ?? "").join("");
const markdown = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string);
const json = (v: unknown) => JSON.stringify(v, null, 2);
const number = (n: number) =>
  Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const icon = (id = "") => `/icons/${props.config.models.find((m) => m.id === id)?.icon ?? "lab.png"}`;

function connect() {
  events?.close();
  snap.value = undefined;
  connected.value = false;
  const current = ++epoch;
  events = new EventSource(`/api/conversations/${props.conversationId}/events`);
  events.addEventListener("snapshot", (e) => {
    if (current !== epoch) return;
    const nearBottom =
      !chat.value || chat.value.scrollHeight - chat.value.scrollTop - chat.value.clientHeight < 160;
    snap.value = JSON.parse((e as MessageEvent).data);
    connected.value = true;
    emit("incidents", snap.value!.incidents);
    if (nearBottom) void nextTick(() => chat.value?.scrollTo({ top: chat.value.scrollHeight, behavior: "instant" }));
  });
  events.addEventListener("fault", (e) => {
    error.value = JSON.parse((e as MessageEvent).data).error;
  });
  events.onerror = () => (connected.value = false);
}

async function act(action: string, body: unknown = {}) {
  error.value = "";
  try {
    return await api<{ id?: number }>(`/conversations/${props.conversationId}/${action}`, body);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function send() {
  const content = input.value.trim();
  if (!content || pending.value) return;
  pending.value = true;
  const result = await act("send", { content, whenBusy: mode.value, requestId: crypto.randomUUID() });
  if (result) input.value = "";
  pending.value = false;
}

async function changeModel(m: Model) {
  if (await act("configure", { model: { provider: m.provider, modelId: m.id } })) {
    modelMenu.value = false;
    emit("notify", "Model saved. Used on the next turn.");
  }
}

async function decide(approved: boolean) {
  if (!pendingDeploy.value || deciding.value) return;
  deciding.value = true;
  error.value = "";
  try {
    await api(`/deploys/${pendingDeploy.value.id}/decide`, { approved });
    emit("notify", approved ? "Deploy approved. Rolling out." : "Deploy declined. Nothing shipped.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    deciding.value = false;
  }
}

function preset(text: string) {
  input.value = text;
  void nextTick(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
}

watch(() => props.conversationId, connect, { immediate: true });
onBeforeUnmount(() => events?.close());
</script>

<template>
  <section class="chat-panel">
    <header class="chat-header">
      <nav class="conversation-tabs" aria-label="Conversations">
        <button
          class="conversation-tab"
          :class="{ current: conversationId === rootId }"
          @click="emit('select', rootId)"
        >
          <MessageSquare :size="18" />Ops desk
        </button>
        <button
          v-for="i in tabs"
          :key="i.id"
          class="conversation-tab"
          :class="[{ current: conversationId === i.conversationId }, i.status]"
          :title="i.title"
          @click="emit('select', i.conversationId)"
        >
          <i class="status-dot" />{{ i.id }}
        </button>
      </nav>
      <div class="chat-header-actions">
        <span class="chat-cost" :title="`${usage.tokens.toLocaleString('en-US')} tokens`"
          >${{ usage.cost.toFixed(4) }} / {{ number(usage.tokens) }}</span
        >
        <button class="model-chip" title="Model for this conversation" @click="modelMenu = true">
          <img :src="icon(agent?.model?.modelId)" alt="" />{{
            selectedModel?.name ?? agent?.model?.modelId ?? "Model"
          }}<ChevronDown :size="16" />
        </button>
        <select
          aria-label="Thinking level"
          class="thinking-select"
          :value="agent?.thinkingLevel ?? 'low'"
          @change="act('configure', { thinkingLevel: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="level in ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']" :key="level">
            {{ level }}
          </option>
        </select>
      </div>
    </header>
    <IncidentCard v-if="incident" :key="incident.id" :incident="incident" />
    <div v-if="error" class="error-banner" role="alert">
      <Info :size="18" /><span>{{ error }}</span
      ><button class="icon-button" aria-label="Dismiss error" @click="error = ''">×</button>
    </div>
    <div ref="chat" class="chat-scroll">
      <div v-if="!snap" class="chat-empty">
        <Activity :size="30" />
        <h2>Connecting to the agent…</h2>
        <p>It keeps working while this view connects.</p>
      </div>
      <div v-else-if="!visibleEntries.length && !live?.generation" class="chat-empty">
        <div class="agent-orb"><img src="/icons/durable-pi.svg" alt="Durable Pi" /><i /></div>
        <span class="eyebrow">OPS DESK</span>
        <h2>The watcher never sleeps.</h2>
        <p>
          Jev judges every production log row. When failures cluster, a durable agent starts on its
          own and opens a tab here.
        </p>
        <div class="starter-grid">
          <button @click="preset('What happened in production over the last 10 minutes?')">
            <Radar :size="18" /><strong>Read the stream</strong><span>Summarize the last 10 minutes</span
            ><ArrowUpRight :size="18" /></button
          ><button @click="preset('Which incidents are open, and where is each one?')">
            <Layers :size="18" /><strong>Check incidents</strong><span>Status, branch, report</span
            ><ArrowUpRight :size="18" />
          </button>
        </div>
      </div>
      <article
        v-for="entry in visibleEntries"
        :key="entry.id"
        class="entry"
        :class="entry.kind.replaceAll('.', '-')"
      >
        <template v-if="entry.kind === 'pi.user' && entry.id === briefEntryId">
          <div class="message-label watcher-label">
            <Radar :size="18" />PROACTIVE WATCHER <span>#{{ entry.id }}</span>
          </div>
          <div v-for="(m, i) in entry.model" :key="i" class="watcher-brief">
            <p>{{ textOf(m).split("\n\n").slice(0, 2).join("\n\n") }}</p>
            <details>
              <summary>Evidence the watcher handed over</summary>
              <pre>{{ textOf(m).split("\n\n").slice(2).join("\n\n") }}</pre>
            </details>
          </div>
        </template>
        <template v-else-if="entry.kind === 'pi.user'"
          ><div class="message-label">
            YOU <span>#{{ entry.id }}</span>
          </div>
          <div v-for="(m, i) in entry.model" :key="i" class="user-message">{{ textOf(m) }}</div></template
        >
        <template v-else-if="entry.kind === 'pi.assistant'"
          ><div class="message-label">
            AGENT <span>#{{ entry.id }}</span>
          </div>
          <template v-for="(m, i) in entry.model" :key="i"
            ><template v-for="(b, j) in blocks(m)" :key="j"
              ><div v-if="b.type === 'text'" class="markdown" v-html="markdown(b.text ?? '')" />
              <details v-else-if="b.type === 'thinking'" class="thinking">
                <summary>Thinking</summary>
                <div>{{ b.thinking }}</div>
              </details>
              <details
                v-else-if="b.type === 'toolCall'"
                class="tool-call"
                :class="{ failed: toolResults.get(b.id ?? '')?.isError }"
              >
                <summary>
                  <Info v-if="toolResults.get(b.id ?? '')?.isError" :size="18" />
                  <Check v-else-if="toolResults.has(b.id ?? '')" :size="18" />
                  <Activity v-else-if="liveTools.has(b.id ?? '')" :size="18" class="spin" />
                  <Wrench v-else :size="18" /><strong>{{ b.name }}</strong
                  ><code>{{ json(b.arguments)?.slice(0, 120) }}</code>
                  <span class="tool-status">{{
                    toolResults.has(b.id ?? "")
                      ? toolResults.get(b.id ?? "")?.isError
                        ? "Error"
                        : "Done"
                      : liveTools.get(b.id ?? "")?.status
                  }}</span>
                </summary>
                <div class="tool-section-label">Input</div>
                <pre>{{ json(b.arguments) }}</pre>
                <template v-if="toolResults.has(b.id ?? '')">
                  <div class="tool-section-label">Result</div>
                  <pre v-for="(r, k) in blocks(toolResults.get(b.id ?? '')!)" :key="k">{{
                    r.text ?? json(r)
                  }}</pre>
                </template>
                <template v-else-if="liveTools.get(b.id ?? '')?.output">
                  <div class="tool-section-label">Live output</div>
                  <pre>{{ liveTools.get(b.id ?? "")?.output }}</pre>
                </template>
              </details></template
            >
            <div
              v-if="m.errorMessage || m.stopReason === 'error' || m.stopReason === 'aborted'"
              class="message-error"
            >
              {{
                m.errorMessage ??
                (m.stopReason === "aborted"
                  ? "Interrupted. Partial response preserved."
                  : "Provider request failed.")
              }}
            </div></template
          ></template
        >
        <template v-else-if="entry.kind === 'pi.tool-result'"
          ><details
            v-for="(m, i) in unmatched(entry.model)"
            :key="i"
            class="tool-result"
            :class="{ failed: m.isError }"
          >
            <summary>
              <Check v-if="!m.isError" :size="18" /><Info v-else :size="18" /><strong>{{
                m.toolName ?? "Tool"
              }}</strong
              ><span>{{ m.isError ? "error" : "result" }}</span>
            </summary>
            <pre v-for="(b, j) in blocks(m)" :key="j">{{ b.text }}</pre>
          </details></template
        >
        <div v-else class="event-line">
          <Layers :size="18" /><span>{{
            entry.data?.text ??
            (entry.kind === "pi.reset"
              ? "New context started. Earlier entries remain stored."
              : entry.kind === "pi.compaction"
                ? "Context compacted. Earlier entries remain stored."
                : entry.kind)
          }}</span>
        </div>
      </article>
      <div v-if="live?.generation" class="entry live-generation">
        <div class="message-label">
          AGENT
          <span class="streaming">{{ live.generation.retry ? "Retry scheduled" : "Working" }}</span>
        </div>
        <p v-if="live.generation.retry" class="hint">{{ live.generation.retry.error }}</p>
        <template v-if="live.generation.message"
          ><template v-for="(b, j) in blocks(live.generation.message)" :key="j"
            ><div v-if="b.type === 'text'" class="markdown" v-html="markdown(b.text ?? '')" />
            <details v-if="b.type === 'thinking'" class="thinking">
              <summary>Thinking</summary>
              <div>{{ b.thinking }}</div>
            </details></template
          ></template
        >
        <div v-else class="typing"><i /><i /><i /></div>
      </div>
      <div
        v-for="tool in live?.tools?.filter((t) => t.status !== 'done' && !toolCallIds.has(t.callId))"
        :key="tool.callId"
        class="live-tool"
      >
        <div>
          <Activity :size="18" /><strong>{{ tool.name }}</strong><span>{{ tool.status }}</span>
        </div>
        <pre v-if="tool.output">{{ tool.output }}</pre>
      </div>
    </div>
    <div class="composer-region">
      <section v-if="pendingDeploy" class="deploy-panel" aria-label="Deploy approval">
        <div class="deploy-head">
          <Rocket :size="18" /><strong>Deploy waiting for your approval</strong
          ><span class="deploy-task">durable task #{{ pendingDeploy.id }}</span>
        </div>
        <p>{{ pendingDeploy.summary }}</p>
        <div class="deploy-meta">
          <GitCommitHorizontal :size="16" />{{ pendingDeploy.commit }} on {{ pendingDeploy.branch }} to
          checkout-api production
        </div>
        <pre v-if="pendingDeploy.diffStat">{{ pendingDeploy.diffStat }}</pre>
        <div class="deploy-actions">
          <button class="secondary" :disabled="deciding" @click="decide(false)">Decline</button
          ><button class="primary small" :disabled="deciding" @click="decide(true)">
            <Rocket :size="16" />Approve deploy
          </button>
        </div>
      </section>
      <section v-else-if="rollingDeploy" class="deploy-panel rolling" aria-label="Deploy progress">
        <div class="deploy-head">
          <Rocket :size="18" /><strong>{{
            rollingDeploy.status === "deploying"
              ? `Rolling out ${rollingDeploy.revision ?? "a new revision"}`
              : `Verifying guest checkouts on ${rollingDeploy.revision}`
          }}</strong
          ><span class="deploy-task">durable task #{{ rollingDeploy.id }}</span>
        </div>
      </section>
      <div v-if="inbox.length" class="queue">
        <div v-for="item in inbox" :key="item.id">
          <Clock3 :size="18" /><span
            >{{ item.mode === "steer" ? "Steer" : "Queued" }}:
            {{ typeof item.content === "string" ? item.content : "Context update" }}</span
          ><button
            class="icon-button"
            :aria-label="`Withdraw submission ${item.id}`"
            @click="act('withdraw', { submissionId: item.id })"
          >
            <X :size="18" />
          </button>
        </div>
      </div>
      <div class="composer">
        <textarea
          v-model="input"
          rows="2"
          :placeholder="incident ? `Talk to the ${incident.id} agent…` : 'Ask the Ops desk about production…'"
          aria-label="Message the agent"
          @keydown.enter.exact.prevent="send"
        />
        <div class="composer-toolbar">
          <div class="composer-left">
            <select v-model="mode" aria-label="When busy" title="Follow-up waits for this run. Steer joins after a tool round.">
              <option value="followUp">Follow-up</option>
              <option value="steer">Steer</option>
              <option value="reject">Reject if busy</option>
            </select>
          </div>
          <div class="composer-right">
            <button
              class="interrupt"
              :disabled="!busy"
              title="Stop this conversation's current work"
              @click="act('interrupt')"
            >
              <Square :size="18" fill="currentColor" />Interrupt</button
            ><button
              class="send"
              aria-label="Send message"
              :disabled="!input.trim() || pending || !snap"
              @click="send"
            >
              <ArrowUp :size="20" />
            </button>
          </div>
        </div>
      </div>
      <div class="composer-footnote">
        <span><i class="live-dot" />Closing this window never interrupts the agent.</span
        ><span>Enter to send <span class="muted">/</span> Shift + Enter for newline</span>
      </div>
    </div>
    <div v-if="modelMenu" class="modal-backdrop" @click.self="modelMenu = false">
      <section class="modal model-modal">
        <header>
          <div>
            <span class="eyebrow">PER CONVERSATION</span>
            <h2>Choose a model</h2>
          </div>
          <button class="icon-button" aria-label="Close model picker" @click="modelMenu = false">
            <X :size="18" />
          </button>
        </header>
        <input v-model="modelSearch" placeholder="Search models or tiers…" aria-label="Search models" />
        <div class="model-list">
          <button
            v-for="m in filteredModels"
            :key="m.id"
            :class="{ selected: m.id === agent?.model?.modelId }"
            @click="changeModel(m)"
          >
            <img :src="icon(m.id)" alt="" />
            <div>
              <strong>{{ m.name }}</strong
              ><small>{{ m.tier }} / OpenRouter / {{ number(m.contextWindow) }} context</small>
            </div>
            <Check v-if="m.id === agent?.model?.modelId" :size="18" />
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
