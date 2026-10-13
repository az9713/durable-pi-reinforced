<script setup lang="ts">
// One durable job run, live: its named phases as a stepper, every step each phase took (commands, a subagent's
// tool calls, App State writes, checkpoints), the approval when it waits, and how it is owned.
import { computed, h, type FunctionalComponent } from "vue";
import {
  Bot,
  Braces,
  Check,
  Flag,
  Hand,
  ListChecks,
  LoaderCircle,
  Octagon,
  Repeat,
  ShieldCheck,
  Terminal,
  Workflow,
  Wrench,
  X,
} from "lucide-vue-next";
import { jobRunDone, type JobPhaseRun, type JobRun, type JobStep } from "@sdk/jobs";
import { decide, jobDef, now, openAgent, pending, seconds, stopRun } from "../client/jobs";

const props = defineProps<{ run: JobRun }>();
const def = computed(() => jobDef(props.run.job));
const done = computed(() => jobRunDone(props.run));
const elapsed = computed(() => seconds((props.run.endedAt ?? now.value) - props.run.startedAt));
const statusText: Record<JobRun["status"], string> = {
  running: "Running",
  waiting: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  aborted: "Stopped",
  declined: "Declined",
};
const stepIcon = { command: Terminal, tool: Wrench, agent: Bot, state: Braces, approval: ShieldCheck, checkpoint: Flag, note: ListChecks };
const stepTitle = (s: JobStep) => (s.kind === "tool" ? `${s.label}: a subagent tool call, its own durable task` : s.label);

/** One step: what kind, what ran, how it ended, how long it took. */
const JobStepLine: FunctionalComponent<{ step: JobStep }> = (p) => {
  const s = p.step;
  const label = ["command", "tool", "state"].includes(s.kind)
    ? h("code", { title: stepTitle(s) }, s.label)
    : h("span", { class: "job-step-text" }, s.label);
  const state =
    s.status === "running"
      ? h(LoaderCircle, { size: 15, class: "spin" })
      : s.status === "done"
        ? h(Check, { size: 15 })
        : s.status === "waiting"
          ? h(Hand, { size: 15 })
          : h(X, { size: 15 });
  return [
    h(stepIcon[s.kind], { size: 16, class: "job-step-kind" }),
    label,
    s.kind === "tool" && s.detail ? h("span", { class: "job-step-args", title: s.detail }, s.detail) : null,
    h("span", { class: "job-step-state" }, [state, s.ms !== undefined && s.kind !== "note" ? h("span", seconds(s.ms)) : null]),
  ];
};
JobStepLine.props = ["step"];
const phaseSpec = (id: string) => def.value?.phases.find((p) => p.id === id);
const phaseTime = (p: JobPhaseRun) =>
  p.startedAt ? seconds((p.endedAt ?? (p.status === "running" || p.status === "waiting" ? now.value : p.startedAt)) - p.startedAt) : "";
const open = (p: JobPhaseRun) => p.status !== "pending" && p.status !== "skipped";
const inputs = computed(() => Object.entries(props.run.input));
const approvalPhase = computed(() => props.run.phases.find((p) => p.status === "waiting"));
</script>

<template>
  <article
    class="job-run"
    :class="`is-${run.status}`"
    :data-job-run="run.id"
    :aria-label="`${run.title} run ${run.run}: ${statusText[run.status]}`"
  >
    <header class="job-run-head">
      <span class="job-run-icon"><Workflow :size="22" /></span>
      <div class="job-run-titles">
        <div class="job-run-eyebrow">
          <span>DURABLE JOB</span>
          <span class="job-run-repeat"><Repeat :size="15" />Repeatable workflow, run #{{ run.run }}</span>
        </div>
        <h3>{{ run.title }}</h3>
      </div>
      <span class="job-run-status" :class="run.status"><i />{{ statusText[run.status] }}</span>
    </header>
    <p v-if="def" class="job-run-about">{{ def.summary }}</p>
    <div class="job-run-meta">
      <span>task #{{ run.id }}</span>
      <span>{{ run.startedBy === "agent" ? "started by the agent" : "started by you" }}</span>
      <span>{{ elapsed }}</span>
      <span v-for="[k, v] in inputs" :key="k" class="job-run-input">{{ k }}={{ v }}</span>
      <span v-if="run.resumed" class="job-run-resumed">resumed {{ run.resumed }}× after restart</span>
    </div>

    <ol class="job-stepper" aria-label="Phases">
      <li
        v-for="(phase, i) in run.phases"
        :key="phase.id"
        :class="`ph-${phase.status}`"
        :aria-current="run.phase === phase.id && !done ? 'step' : undefined"
      >
        <span class="job-chip"><span class="job-step-dot">
          <Check v-if="phase.status === 'done'" :size="15" />
          <LoaderCircle v-else-if="phase.status === 'running'" :size="15" class="spin" />
          <Hand v-else-if="phase.status === 'waiting'" :size="15" />
          <X v-else-if="['failed', 'aborted'].includes(phase.status)" :size="15" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="job-step-label">{{ phase.label }}</span>
        <span v-if="phase.progress" class="job-step-progress">{{ phase.progress.done }}/{{ phase.progress.total }}</span></span>
      </li>
    </ol>

    <div class="job-phases">
      <details v-for="(phase, i) in run.phases" :key="phase.id" class="job-phase" :class="`ph-${phase.status}`" :open="open(phase)">
        <summary>
          <span class="job-phase-n">{{ i + 1 }}</span>
          <strong>{{ phase.label }}</strong>
          <span class="job-phase-summary">{{
            phase.summary ?? (phase.status === "pending" ? phaseSpec(phase.id)?.summary : phase.status === "skipped" ? "Skipped" : "")
          }}</span>
          <span class="job-phase-time">{{ phaseTime(phase) }}</span>
        </summary>
        <p v-if="phase.status !== 'done'" class="job-phase-about">
          {{ phaseSpec(phase.id)?.summary }}
        </p>
        <ul v-if="phase.steps.length" class="job-steps">
          <li v-for="step in phase.steps" :key="step.id" :class="[`k-${step.kind}`, `st-${step.status}`]">
            <details v-if="step.detail && step.kind !== 'tool'" :open="step.status === 'error'">
              <summary><JobStepLine :step="step" /></summary>
              <pre>{{ step.detail }}</pre>
            </details>
            <div v-else class="job-step-line"><JobStepLine :step="step" /></div>
            <button
              v-if="step.kind === 'agent' && step.conversationId"
              class="text-button job-step-link"
              @click="openAgent(step.conversationId)"
            >
              Open subagent #{{ step.conversationId }}
            </button>
          </li>
        </ul>
        <p v-else-if="phase.status === 'pending'" class="job-phase-empty">Not started yet.</p>
      </details>
    </div>

    <div v-if="run.approval === 'pending'" class="job-approval" role="group" aria-label="Approval">
      <div><ShieldCheck :size="20" /><strong>Approve to continue</strong></div>
      <p>
        {{ approvalPhase ? phaseSpec(approvalPhase.id)?.summary : "This run waits for you" }}. It is paused on a saved
        checkpoint: close the browser or restart the device and the decision will still be waiting.
      </p>
      <div class="job-approval-buttons">
        <button class="primary small" :disabled="!!pending" @click="decide(run, true)"><Check :size="18" />Approve &amp; continue</button>
        <button class="secondary" :disabled="!!pending" @click="decide(run, false)">Decline</button>
      </div>
    </div>
    <p v-if="run.error && run.status !== 'aborted'" class="message-error">{{ run.error }}</p>

    <footer class="job-run-foot">
      <span>{{
        run.background
          ? "Runs in the background: the conversation owns it, so Interrupt leaves it running."
          : "Owned by this tool call: Interrupt stops it."
      }}
        Each phase saves a checkpoint, so a restart resumes the current phase.</span>
      <button v-if="!done" class="secondary danger" :disabled="!!pending" @click="stopRun(run)"><Octagon :size="16" />Stop</button>
    </footer>
  </article>
</template>
