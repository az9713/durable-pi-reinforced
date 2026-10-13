<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Check,
  CircleHelp,
  Info,
  Network,
  PanelLeft,
  PanelRight,
  Plus,
  X,
  Database,
  GitFork,
  Activity,
} from "lucide-vue-next";
import NetworkSidebar from "./components/NetworkSidebar.vue";
import AgentView from "./components/AgentView.vue";
import Inspector from "./components/Inspector.vue";
import OfflinePanel from "./components/OfflinePanel.vue";
import NewSessionDialog from "./components/NewSessionDialog.vue";
import PromptDialog from "./components/PromptDialog.vue";
import ModelPicker from "./components/ModelPicker.vue";
import {
  attempt,
  boot,
  busy,
  device,
  interrupt,
  network,
  notify,
  online,
  select,
  selected,
  sessionHandle,
  stream,
  streamState,
  treeWidth,
  ui,
  layout,
  showInspector,
  hideInspector,
  panelHotkey,
  toggleTree,
  toggleInspector,
} from "./client/store";

const onlineCount = computed(
  () => network.devices.value.filter((d) => d.status === "online").length,
);
const creatingAgent = ref(false);

async function newAgent() {
  const handle = sessionHandle.value;
  const t = selected.value;
  if (!handle || !t || creatingAgent.value) return;
  creatingAgent.value = true;
  const created = await attempt(() => handle.createAgent({}));
  creatingAgent.value = false;
  if (created) {
    select({ ...t, agentId: created.id });
    notify("New agent. Same session, same shared App State.");
  }
}

function openNewSession() {
  ui.dialog = { kind: "new-session", deviceId: selected.value?.deviceId };
}

function keydown(e: KeyboardEvent) {
  const panel = ui.dialog ? undefined : panelHotkey(e);
  if (panel) {
    e.preventDefault();
    return panel === "tree" ? toggleTree() : toggleInspector();
  }
  if (e.key !== "Escape") return;
  if (ui.dialog) {
    ui.dialog = undefined;
    return;
  }
  if (!e.repeat && !e.isComposing && busy.value) {
    e.preventDefault();
    void interrupt();
  }
  ui.drawer = false;
  ui.inspectorOverlay = false;
}

// Drag the tree's right edge; the width persists in the hub's ui_state.
function resize(e: PointerEvent) {
  const start = e.clientX;
  const width = treeWidth.value;
  const move = (m: PointerEvent) =>
    (treeWidth.value = Math.max(220, Math.min(560, width + m.clientX - start)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

onMounted(() => {
  document.addEventListener("keydown", keydown);
  void boot();
});
onBeforeUnmount(() => {
  stream.stop();
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <button
          class="icon-button tree-toggle"
          aria-label="Toggle network"
          title="Network"
          @click="ui.drawer = !ui.drawer"
        >
          <PanelLeft :size="19" /></button
        ><img class="brandmark" src="/icons/durable-pi.svg" alt="Durable Pi" /><strong
          >Durable Pi</strong
        ><span
          class="network-summary"
          :title="`${onlineCount} of ${network.devices.value.length} devices online`"
          ><Network :size="16" />{{ onlineCount }} of
          {{ network.devices.value.length }} online</span
        >
      </div>
      <div class="top-actions">
        <span class="connection"
          ><i :class="{ online: streamState === 'live' }" />{{
            streamState === "live" ? "Connected" : "Reconnecting"
          }}</span
        ><button
          class="icon-button"
          title="How this works"
          aria-label="How this works"
          @click="ui.dialog = { kind: 'help' }"
        >
          <CircleHelp :size="19" /></button
        ><button
          class="secondary small new-agent-button"
          :disabled="!selected || !online || creatingAgent"
          title="Start a fresh agent in this session"
          @click="newAgent"
        >
          <Plus :size="18" />New agent
        </button>
        <button class="primary small" @click="openNewSession">
          <Plus :size="18" />New session
        </button>
        <button
          class="icon-button inspector-toggle"
          aria-label="Toggle inspector"
          title="Inspector"
          :disabled="!selected || !online"
          @click="ui.inspectorOverlay ? hideInspector() : showInspector()"
        >
          <PanelRight :size="19" />
        </button>
      </div>
    </header>
    <div v-if="ui.error" class="error-banner" role="alert">
      <Info :size="18" /><span>{{ ui.error }}</span
      ><button class="icon-button" aria-label="Dismiss error" @click="ui.error = ''">×</button>
    </div>
    <main class="net-workspace" :style="{ '--tree-w': `${treeWidth}px` }">
      <NetworkSidebar />
      <div
        v-if="layout.tree"
        class="tree-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize network tree"
        @pointerdown.prevent="resize"
      />
      <div v-if="ui.drawer" class="tree-backdrop" @click="ui.drawer = false" />
      <template v-if="selected && device && online">
        <Inspector />
        <div v-if="ui.inspectorOverlay" class="inspector-backdrop" @click="hideInspector()" />
        <AgentView :key="`${selected.deviceId}/${selected.sessionId}`" />
      </template>
      <OfflinePanel v-else-if="selected && device" :device="device" />
      <section v-else class="welcome">
        <img class="welcome-symbol" src="/icons/durable-pi.svg" alt="Durable Pi" />
        <span class="eyebrow">THE DURABLE AGENT NETWORK</span>
        <h1>Close the tab.<br />The work continues.</h1>
        <p>Agents run on your devices. This page is only a window into them.</p>
        <button class="primary" :disabled="!onlineCount" @click="openNewSession">
          <Plus :size="18" />{{
            network.devices.value.length ? "Create a session" : "Add a device to dpi-network.yaml"
          }}
        </button>
        <div class="welcome-features">
          <span><Database :size="18" />SQLite on each device</span
          ><span><GitFork :size="18" />Branch any agent</span
          ><span><Activity :size="18" />Watch from anywhere</span>
        </div>
      </section>
    </main>

    <NewSessionDialog
      v-if="ui.dialog?.kind === 'new-session'"
      :device-id="ui.dialog.deviceId"
      @close="ui.dialog = undefined"
    />
    <PromptDialog
      v-else-if="ui.dialog?.kind === 'prompt'"
      :dialog="ui.dialog"
      @close="ui.dialog = undefined"
    />
    <ModelPicker v-else-if="ui.dialog?.kind === 'models'" @close="ui.dialog = undefined" />
    <div
      v-else-if="ui.dialog?.kind === 'path'"
      class="modal-backdrop"
      @click.self="ui.dialog = undefined"
    >
      <section
        class="modal path-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="path-title"
      >
        <header>
          <h2 id="path-title">Working directory</h2>
          <button
            class="icon-button"
            aria-label="Close working directory"
            @click="ui.dialog = undefined"
          >
            <X :size="18" />
          </button>
        </header>
        <code class="full-directory">{{ ui.dialog.path }}</code>
        <footer><button class="secondary" @click="ui.dialog = undefined">Close</button></footer>
      </section>
    </div>
    <div
      v-else-if="ui.dialog?.kind === 'help'"
      class="modal-backdrop"
      @click.self="ui.dialog = undefined"
    >
      <section class="modal help-modal">
        <header>
          <div>
            <span class="eyebrow">LEARN BY DOING</span>
            <h2>What makes this durable?</h2>
          </div>
          <button class="icon-button" aria-label="Close help" @click="ui.dialog = undefined">
            <X :size="18" />
          </button>
        </header>
        <ol class="learning-list">
          <li>
            <span>01</span>
            <div>
              <strong>Pick a device, start a session</strong>
              <p>
                Every device in the tree runs dpi-backend. A session gets its own SQLite database on
                that device, in the directory you choose.
              </p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Send work, then close the browser</strong>
              <p>
                The device owns the run. Reopening restores committed messages, state and live
                progress.
              </p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Change state and fork</strong>
              <p>
                Edit App State by hand or through the agent. Every session and fork on a device
                shares it.
              </p>
            </div>
          </li>
          <li>
            <span>04</span>
            <div>
              <strong>Interrupt deliberately</strong>
              <p>
                Interrupt stops foreground work and owned subagents. Background jobs continue. Stop
                all includes them.
              </p>
            </div>
          </li>
          <li>
            <span>05</span>
            <div>
              <strong>Explore the boundaries</strong>
              <p>
                Queue a follow-up, steer after tools, wait for approval, compact context, reset or
                inspect raw state.
              </p>
            </div>
          </li>
          <li>
            <span>06</span>
            <div>
              <strong>Restart a device</strong>
              <p>
                Its tree dims and shows the restart command. Checkpointed jobs recover on boot.
                Replay-safe tools may rerun. Other interrupted tools return an error.
              </p>
            </div>
          </li>
        </ol>
        <div class="callout">
          <Info :size="18" /><span
            >Durable does not mean exactly-once external effects. Checkpoints protect progress.
            Tools still need their own idempotency.</span
          >
        </div>
      </section>
    </div>
    <Transition name="toast"
      ><div v-if="ui.toast" class="toast" role="status">
        <Check :size="18" />{{ ui.toast }}
      </div></Transition
    >
  </div>
</template>
