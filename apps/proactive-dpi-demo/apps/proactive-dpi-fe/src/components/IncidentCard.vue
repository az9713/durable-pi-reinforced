<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronDown, GitBranch, GitCommitHorizontal, Siren } from "lucide-vue-next";
import { STATUS_LABELS, api } from "../api";
import type { Incident } from "../types";

const props = defineProps<{ incident: Incident }>();
type Review = { ahead: number; head: string | null; log: string; diffStat: string; diff: string };

const STEPS = ["starting", "investigating", "root_cause_found", "fix_in_progress", "ready_for_review", "deployed"];
// Collapsed by default so the agent transcript stays in view. Click to see the report and diff.
const open = ref(false);
const review = ref<Review>();
const loading = ref(false);
const reached = computed(() => STEPS.indexOf(props.incident.status));
const deployed = computed(() => props.incident.status === "deployed");
const time = (t: number | string) => new Date(t).toLocaleTimeString();
const diffLines = computed(() =>
  (review.value?.diff ?? "").split("\n").map((text) => ({
    text,
    kind: text.startsWith("+++") || text.startsWith("---")
      ? "file"
      : text.startsWith("+")
        ? "add"
        : text.startsWith("-")
          ? "del"
          : text.startsWith("@@")
            ? "hunk"
            : "",
  })),
);

async function loadReview() {
  loading.value = true;
  try {
    review.value = await api<Review>(`/incidents/${props.incident.id}/review`);
  } finally {
    loading.value = false;
  }
}

watch(open, (now) => {
  if (now && !review.value) void loadReview();
});
</script>

<template>
  <section class="incident-card" :class="incident.status">
    <button class="incident-top" :aria-expanded="open" @click="open = !open">
      <Siren :size="18" />
      <strong>{{ incident.id }}</strong>
      <span class="incident-title">{{ incident.title }}</span>
      <span class="incident-status"><i />{{ STATUS_LABELS[incident.status] }}</span>
      <ChevronDown :size="18" :class="{ flipped: open }" />
    </button>
    <ol class="incident-steps">
      <li
        v-for="(step, i) in STEPS"
        :key="step"
        :class="{ done: i < reached || (deployed && i === reached), current: i === reached && !deployed }"
      >
        <i />{{ STATUS_LABELS[step] }}
      </li>
    </ol>
    <p class="incident-summary">{{ incident.summary }}</p>
    <div v-if="open" class="incident-body">
      <dl class="incident-facts">
        <div><dt>Fingerprint</dt><dd>{{ incident.fingerprint }}</dd></div>
        <div>
          <dt>Live revision</dt>
          <dd>{{ incident.evidence.revision }}<template v-if="incident.evidence.commit"> ({{ incident.evidence.commit }})</template></dd>
        </div>
        <div><dt>Opened</dt><dd>{{ time(incident.openedAt) }}, first error {{ time(incident.evidence.firstSeen) }}</dd></div>
        <div><dt>Branch</dt><dd><GitBranch :size="16" />{{ incident.branch }}</dd></div>
      </dl>
      <dl v-if="incident.report.rootCause || incident.report.fix" class="incident-report">
        <div v-if="incident.report.rootCause"><dt>Root cause</dt><dd>{{ incident.report.rootCause }}</dd></div>
        <div v-if="incident.report.fix"><dt>Fix</dt><dd>{{ incident.report.fix }}</dd></div>
        <div v-if="incident.report.tests"><dt>Tests</dt><dd>{{ incident.report.tests }}</dd></div>
      </dl>
      <div class="incident-actions">
        <button class="secondary" :disabled="loading" @click="loadReview">
          <GitCommitHorizontal :size="18" />{{ review ? "Refresh diff" : "View diff" }}
        </button>
        <span v-if="review" class="hint">{{ review.ahead }} commit{{ review.ahead === 1 ? "" : "s" }} ahead of main</span>
      </div>
      <template v-if="review">
        <pre v-if="review.log" class="review-log">{{ review.log }}</pre>
        <pre v-if="review.diff" class="diff"><span v-for="(line, i) in diffLines" :key="i" :class="line.kind">{{ line.text }}
</span></pre>
        <p v-else class="hint">No changes on the branch yet.</p>
      </template>
    </div>
  </section>
</template>
