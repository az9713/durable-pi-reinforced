<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Activity,
  Bot,
  Clock3,
  Layers,
  Octagon,
  Play,
  Repeat,
  ShieldCheck,
  Workflow,
  Wrench,
} from "lucide-vue-next";
import type { TaskNode, TaskOutcome } from "@sdk/api";
import { jobRunDone } from "@sdk/jobs";
import { message } from "../client/hub";
import { agentHandle, sessionHandle, tasks } from "../client/store";
import { decide, jobDef, jobDefs, jobRuns, openAgent, pending, revealRun, startJob } from "../client/jobs";

const error = ref("");
const stopping = ref(false);
const recent = ref<TaskOutcome[]>([]);
const inspection = ref<unknown>();

const status = (value: string) =>
  ({
    running: "Running",
    waiting: "Waiting",
    completed: "Completed",
    aborted: "Stopped",
    declined: "Declined",
    failed: "Failed",
    pending: "Queued",
    completing: "Finishing",
    terminal: "Finished",
  })[value] ?? value;

/** The newest run of each job, for its row in the list. */
const latest = computed(() => new Map(jobDefs.value.map((d) => [d.id, jobRuns.value.find((r) => r.job === d.id)])));

// ------------------------------------------------------------------ the live task tree

type Row = { task: TaskNode & { effectiveBackground: boolean }; depth: number };
const rows = computed<Row[]>(() => {
  const all = tasks.value;
  const ids = new Set(all.map((t) => t.id));
  const children = new Map<number | undefined, typeof all>();
  for (const t of all) {
    const parent = t.owner !== undefined && ids.has(t.owner) ? t.owner : undefined;
    children.set(parent, [...(children.get(parent) ?? []), t]);
  }
  const out: Row[] = [];
  const walk = (parent: number | undefined, depth: number) => {
    for (const task of (children.get(parent) ?? []).sort((a, b) => a.id - b.id)) {
      out.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
});
const kindOf = (t: TaskNode) =>
  t.kind === "pi.tool"
    ? { icon: Wrench, name: t.label ?? "Tool call", what: "tool call" }
    : t.kind === "pi.generation"
      ? { icon: Bot, name: "Model response", what: "generation" }
      : t.kind === "pi.compaction"
        ? { icon: Layers, name: "Compaction", what: "compaction" }
        : t.kind.startsWith("demo.job.")
          ? { icon: Workflow, name: t.label ?? jobDef(t.kind.slice(9))?.title ?? t.kind, what: "durable job" }
          : t.kind === "demo.job-approval"
            ? { icon: ShieldCheck, name: "Approval", what: "waits for you" }
            : { icon: Activity, name: t.label ?? t.kind, what: t.kind };
const phaseOf = (t: TaskNode) => {
  if (!t.state.phase) return "";
  if (t.kind.startsWith("demo.job."))
    return jobDef(t.kind.slice(9))?.phases.find((p) => p.id === t.state.phase)?.label ?? t.state.phase;
  return t.state.phase;
};

async function stopAll() {
  if (stopping.value || !agentHandle.value) return;
  stopping.value = true;
  error.value = "";
  try {
    await agentHandle.value.abort(true);
  } catch (e) {
    error.value = message(e);
  } finally {
    stopping.value = false;
  }
}

// Recent outcomes and recovery inspection are read on demand, not streamed.
async function loadRuntime(e: Event) {
  const handle = sessionHandle.value;
  if (!(e.target as HTMLDetailsElement).open || !handle) return;
  try {
    const [r, i] = await Promise.all([handle.tasks("terminal", 40), handle.inspect()]);
    recent.value = r;
    inspection.value = i;
  } catch (err) {
    error.value = message(err);
  }
}
const outcomes = computed(() =>
  recent.value
    .filter((task) => task.state.status === "terminal")
    .slice(-12)
    .reverse(),
);
</script>

<template>
  <div class="tasks-panel">
    <div class="panel-heading">
      <h2>Tasks</h2>
      <span class="tag">{{ tasks.length }} active</span>
    </div>
    <p v-if="error" class="message-error" role="alert">{{ error }}</p>

    <section class="task-section" aria-label="Durable jobs">
      <h3><Repeat :size="18" />Durable jobs</h3>
      <p class="hint">
        Repeatable workflows with named phases. Every run follows the same phases and saves a checkpoint after each one.
        Start one here, or ask your agent: it finds these with <code>list_durable_jobs</code>, starts them with
        <code>run_durable_job</code> and checks them with <code>check_durable_job</code>. Runs play out live in the chat.
      </p>
      <p v-if="!jobDefs.length" class="task-empty">This device has no durable jobs. Deploy the latest backend to it.</p>
      <article v-for="def in jobDefs" :key="def.id" class="job-def" :data-job="def.id">
        <div class="job-def-head">
          <Workflow :size="18" />
          <strong>{{ def.title }}</strong>
          <span v-if="def.approval" class="tag">needs approval</span>
          <span class="tag">~{{ def.seconds }}s</span>
        </div>
        <p>{{ def.summary }}</p>
        <ol class="job-chain" :aria-label="`${def.title} phases`">
          <li v-for="(phase, i) in def.phases" :key="phase.id" :title="phase.summary">
            <span>{{ i + 1 }}</span>{{ phase.label }}<Repeat v-if="phase.kind === 'repeat'" :size="13" /><ShieldCheck
              v-if="phase.kind === 'approval'"
              :size="13"
            />
          </li>
        </ol>
        <div class="job-def-meta">
          <code v-for="input in def.inputs" :key="input.name" :title="input.description">{{ input.name }}={{ input.default }}</code>
          <code :title="`Each run saves its result to App State ${def.resultPath}`">→ {{ def.resultPath }}</code>
        </div>
        <div v-if="latest.get(def.id)" class="job-def-last">
          <span
            >Run #{{ latest.get(def.id)!.run }}:
            <strong>{{ status(latest.get(def.id)!.status) }}</strong
            ><template v-if="!jobRunDone(latest.get(def.id)!)">
              in {{ latest.get(def.id)!.phases.find((p) => p.id === latest.get(def.id)!.phase)?.label }}</template
            ></span
          >
          <button class="text-button" @click="revealRun(latest.get(def.id)!.id)">Show in chat</button>
          <template v-if="latest.get(def.id)!.approval === 'pending'">
            <button class="primary small" :disabled="!!pending" @click="decide(latest.get(def.id)!, true)">Approve</button>
            <button class="secondary" :disabled="!!pending" @click="decide(latest.get(def.id)!, false)">Decline</button>
          </template>
        </div>
        <button class="secondary job-def-run" :disabled="!!pending || !agentHandle" @click="startJob(def)">
          <Play :size="16" />Run {{ def.title }}
        </button>
      </article>
    </section>

    <section class="task-section" aria-label="Agent activity">
      <div class="panel-heading">
        <h3>Agent activity</h3>
        <Activity :size="18" />
      </div>
      <p class="hint">
        Every model response and every tool call is its own durable task with an id, an owner and a checkpoint. Follow
        them live here; after a restart each one resumes or reports how it ended.
      </p>
      <p v-if="!rows.length" class="task-empty">Nothing running. Send a message or run a job.</p>
      <ul v-else class="task-tree">
        <li
          v-for="{ task, depth } in rows"
          :key="task.id"
          class="task-row"
          :style="{ '--depth': depth }"
          :data-task-kind="task.kind"
        >
          <component :is="kindOf(task).icon" :size="16" />
          <strong>{{ kindOf(task).name }}</strong>
          <span class="tag">{{ status(task.state.status) }}</span>
          <span v-if="phaseOf(task)" class="task-phase">{{ phaseOf(task) }}</span>
          <small
            >#{{ task.id }} {{ kindOf(task).what }}, agent #{{ task.conversationId
            }}{{ task.effectiveBackground ? ", background" : "" }}</small
          >
          <button v-for="cid in task.conversations" :key="cid" class="text-button" @click="openAgent(cid)">
            Open agent #{{ cid }}
          </button>
        </li>
      </ul>
      <p class="hint">Interrupt or Esc stops foreground work and what it owns. Stop all also stops background runs.</p>
      <button class="secondary danger" :disabled="!tasks.length || stopping" @click="stopAll">
        <Octagon :size="18" />Stop all
      </button>
    </section>

    <details class="raw task-section" @toggle="loadRuntime">
      <summary><Clock3 :size="18" />Runtime details</summary>
      <p class="hint">Recent task results and recovery records, read from the device when opened.</p>
      <details v-for="task in outcomes" :key="task.id" class="raw">
        <summary>
          {{ task.kind }} #{{ task.id }}<span>{{ status(task.state.outcome?.status ?? task.state.status) }}</span>
        </summary>
        <pre>{{ JSON.stringify(task.state.outcome, null, 2) }}</pre>
      </details>
      <details class="raw">
        <summary>Recovery inspection</summary>
        <pre>{{ JSON.stringify(inspection, null, 2) }}</pre>
      </details>
    </details>
  </div>
</template>
