<script setup lang="ts">
// The selected agent's context window: how full it is, where automatic compaction starts in the background, and
// where the next request waits for a summary. Both markers drag (or take arrow keys) and save the session's
// thresholds, which pi-durable reads at its next request.
import { computed, onUnmounted, ref, watch } from "vue";
import { Info, X } from "lucide-vue-next";
import { compactionThresholds, defaultCompaction, type CompactionSettings, type WireAssistantMessage } from "@sdk/api";
import { agentState, attempt, currentModel, sessionHandle, sessionSummary, ui } from "../client/store";

const STEP = 512;
const MIN_AUTO = 4096;
const GAP = 1024;

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const window = computed(() => currentModel.value?.contextWindow ?? 0);

/** The last reply's prompt plus output: what the next request starts from. */
const used = computed(() => {
  const entries = agentState.value.entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind !== "pi.assistant") continue;
    const reply = entries[i].model?.find((m) => m.role === "assistant") as WireAssistantMessage | undefined;
    const u = reply?.usage;
    if (u) return u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
  }
  return 0;
});
const compacting = computed(() => agentState.value.compactions.length > 0);

// A saved value shows at once; the stream's session summary confirms it a moment later.
const saved = ref<CompactionSettings>();
const settings = computed<CompactionSettings>(
  () => saved.value ?? sessionSummary.value?.compaction ?? defaultCompaction(window.value),
);
watch(
  () => JSON.stringify(sessionSummary.value?.compaction),
  (now) => {
    if (saved.value && now === JSON.stringify(saved.value)) saved.value = undefined;
  },
);

const draft = ref<{ auto?: number; wait: number }>();
// The details live in an app dialog, so Escape closes them instead of interrupting the agent.
const detailsOpen = computed(() => ui.dialog?.kind === "compaction");
const closeDetails = () => void (ui.dialog = undefined);
onUnmounted(() => detailsOpen.value && closeDetails());
const marks = computed(() => draft.value ?? compactionThresholds(window.value, settings.value));
const pct = (n: number) => `${Math.min(100, Math.max(0, (100 * n) / (window.value || 1)))}%`;
const fullness = computed(() => Math.round((100 * used.value) / (window.value || 1)));
/** Labels near either end grow inward so they stay inside the panel. */
const align = (n: number) => {
  const at = n / (window.value || 1);
  return at < 0.35 ? "start" : at > 0.65 ? "end" : "center";
};

const clampWait = (w: number, auto?: number) =>
  Math.min(window.value - GAP, Math.max((auto ?? MIN_AUTO) + GAP, w));
const clampAuto = (a: number, wait: number) => Math.min(wait - GAP, Math.max(MIN_AUTO, a));

function move(which: "auto" | "wait", tokens: number) {
  const current = marks.value;
  const t = Math.round(tokens / STEP) * STEP;
  draft.value =
    which === "wait"
      ? { auto: current.auto, wait: clampWait(t, current.auto) }
      : { auto: clampAuto(t, current.wait), wait: current.wait };
}

async function save(patch: Partial<CompactionSettings>) {
  const handle = sessionHandle.value;
  if (!handle) return;
  const result = await attempt(() => handle.setCompaction(patch));
  if (result) saved.value = result;
  draft.value = undefined;
}

function commit() {
  const d = draft.value;
  if (!d) return;
  void save({
    reserveTokens: window.value - d.wait,
    ...(d.auto !== undefined ? { backgroundTokens: d.wait - d.auto } : {}),
  });
}

const bar = ref<HTMLElement>();
let dragging: "auto" | "wait" | undefined;
function down(which: "auto" | "wait", e: PointerEvent) {
  dragging = which;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function drag(e: PointerEvent) {
  if (!dragging || !bar.value) return;
  const rect = bar.value.getBoundingClientRect();
  move(dragging, ((e.clientX - rect.left) / rect.width) * window.value);
}
function up() {
  if (!dragging) return;
  dragging = undefined;
  commit();
}
function key(which: "auto" | "wait", e: KeyboardEvent) {
  const delta = (e.shiftKey ? 8192 : 1024) * (e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0);
  if (!delta) return;
  e.preventDefault();
  const current = marks.value;
  move(which, (which === "auto" ? (current.auto ?? MIN_AUTO) : current.wait) + delta);
}
</script>

<template>
  <section class="context-section" aria-labelledby="context-title">
    <div class="section-label">
      <span id="context-title">CONTEXT</span>
      <button v-if="window" class="context-details-toggle" @click="ui.dialog = { kind: 'compaction' }">
        <Info :size="16" />Details
      </button>
    </div>
    <div v-if="!window" class="hint">Pick a model to see its context window.</div>
    <template v-else>
      <div class="context-numbers">
        <strong>{{ k(used) }}</strong><span>of {{ k(window) }} tokens</span><span class="context-pct">{{ fullness }}%</span>
        <span v-if="compacting" class="context-compacting"><i />Compacting</span>
      </div>
      <div
        ref="bar"
        class="context-bar"
        :class="{ off: !settings.enabled }"
        @pointermove="drag"
        @pointerup="up"
        @pointercancel="up"
      >
        <div class="context-fill" :class="{ hot: marks.auto !== undefined && used >= marks.auto }" :style="{ width: pct(used) }" />
        <div class="context-reserve" :style="{ left: pct(marks.wait) }" title="Reserved for the answer" />
        <button
          v-if="marks.auto !== undefined"
          class="context-marker auto"
          :class="`label-${align(marks.auto)}`"
          role="slider"
          aria-label="Automatic compaction starts at"
          :aria-valuemin="MIN_AUTO"
          :aria-valuemax="marks.wait - GAP"
          :aria-valuenow="marks.auto"
          :aria-valuetext="`${k(marks.auto)} tokens`"
          :style="{ left: pct(marks.auto) }"
          @pointerdown="down('auto', $event)"
          @keydown="key('auto', $event)"
          @keyup="commit"
          @blur="commit"
        >
          <span class="context-marker-label">Auto-compact at {{ k(marks.auto) }}</span>
        </button>
        <button
          class="context-marker wait"
          :class="`label-${align(marks.wait)}`"
          role="slider"
          aria-label="The next request waits for a summary at"
          :aria-valuemin="(marks.auto ?? MIN_AUTO) + GAP"
          :aria-valuemax="window - GAP"
          :aria-valuenow="marks.wait"
          :aria-valuetext="`${k(marks.wait)} tokens, ${k(window - marks.wait)} reserved`"
          :style="{ left: pct(marks.wait) }"
          @pointerdown="down('wait', $event)"
          @keydown="key('wait', $event)"
          @keyup="commit"
          @blur="commit"
        >
          <span class="context-marker-label">Reserve at {{ k(marks.wait) }}</span>
        </button>
      </div>
      <p class="hint context-hint">
        <template v-if="settings.enabled"
          >Compacts in the background at <strong>{{ k(marks.auto ?? marks.wait) }}</strong> and waits at
          <strong>{{ k(marks.wait) }}</strong>.</template
        ><template v-else>Automatic compaction is off.</template>
      </p>
    </template>
  </section>
  <Teleport to="body">
    <div v-if="detailsOpen" class="modal-backdrop" @click.self="closeDetails">
      <section class="modal compaction-modal" role="dialog" aria-modal="true" aria-labelledby="compaction-title">
        <header>
          <h2 id="compaction-title">Context compaction</h2>
          <button class="icon-button" aria-label="Close context compaction" @click="closeDetails">
            <X :size="18" />
          </button>
        </header>
        <p>
          A summary starts in the background at <strong>{{ k(marks.auto ?? marks.wait) }}</strong>. Above
          <strong>{{ k(marks.wait) }}</strong> the next request waits for it, keeping {{ k(window - marks.wait) }} free
          for the answer. Drag a marker on the bar to change either point.
        </p>
        <p>Older entries stay stored, and <code>search_history</code> still finds them.</p>
        <label class="context-toggle">
          <input
            type="checkbox"
            :checked="settings.enabled"
            @change="save({ enabled: ($event.target as HTMLInputElement).checked })"
          />
          Automatic compaction
        </label>
        <p class="hint">Applies to every agent in this session. <code>/compact</code> works either way.</p>
        <footer><button class="secondary" @click="closeDetails">Close</button></footer>
      </section>
    </div>
  </Teleport>
</template>
