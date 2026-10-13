<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Network, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import type { TreeNode } from "@sdk/models";
import TreeRow from "./TreeRow.vue";
import { deviceClient, hub } from "../client/hub";
import {
  attempt,
  expanded,
  layout,
  network,
  notify,
  select,
  selected,
  toggle,
  ui,
  panelKeys,
} from "../client/store";

interface Row {
  node: TreeNode;
  depth: number;
  parent?: string;
}

const rows = computed(() => {
  const out: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number, parent?: string) => {
    for (const node of nodes) {
      out.push({ node, depth, parent });
      if (node.children.length && expanded.value.has(node.key))
        walk(node.children, depth + 1, node.key);
    }
  };
  walk(network.tree.value, 0);
  return out;
});
const focusKey = ref<string>();
const list = ref<HTMLElement>();

const deviceOf = (node: TreeNode) =>
  network.devices.value.find(
    (d) => d.id === (node.type === "device" ? node.device.id : node.deviceId),
  );
const isOnline = (node: TreeNode) => deviceOf(node)?.status === "online";
const isSelected = (node: TreeNode) =>
  node.type === "agent" &&
  selected.value?.deviceId === node.deviceId &&
  selected.value.sessionId === node.sessionId &&
  selected.value.agentId === node.agent.id;

function activate(node: TreeNode) {
  focusKey.value = node.key;
  if (node.type === "device") return toggle(node.key);
  if (node.type === "agent")
    return select({ deviceId: node.deviceId, sessionId: node.sessionId, agentId: node.agent.id });
  const root = node.session.agents.find((a) => a.kind === "root") ?? node.session.agents[0];
  toggle(node.key, true);
  if (root) select({ deviceId: node.deviceId, sessionId: node.session.id, agentId: root.id });
}

async function action(node: TreeNode, name: string) {
  const device = deviceOf(node);
  if (!device) return;
  const client = deviceClient(device.id);
  if (node.type === "device") {
    if (name === "new-session") ui.dialog = { kind: "new-session", deviceId: device.id };
    else if (name === "check") await attempt(() => hub.check(device.id));
    return;
  }
  if (node.type === "session") {
    const s = node.session;
    if (name === "new-agent") {
      const created = await attempt(() => client.session(s.id).createAgent({}));
      if (created) {
        select({ deviceId: device.id, sessionId: s.id, agentId: created.id });
        notify("New agent. Same session, same shared App State.");
      }
    } else if (name === "rename")
      ui.dialog = {
        kind: "prompt",
        title: "Rename session",
        label: "Session name",
        value: s.name,
        submit: "Save name",
        run: (value) => client.session(s.id).rename(value),
      };
    else if (name === "archive")
      ui.dialog = {
        kind: "prompt",
        title: `Archive ${s.name}?`,
        hint: `Stops all of its work and moves its files to archive/ on ${device.id}. Nothing is deleted.`,
        submit: "Archive session",
        danger: true,
        run: async () => {
          await client.session(s.id).archive();
          if (selected.value?.sessionId === s.id) select(undefined);
        },
      };
    return;
  }
  const a = node.agent;
  if (name === "rename")
    ui.dialog = {
      kind: "prompt",
      title: "Rename agent",
      label: "Agent name",
      value: a.named ? a.name : "",
      placeholder: a.name,
      submit: "Save name",
      run: (value) => client.agent(node.sessionId, a.id).rename(value),
    };
}

function move(delta: number) {
  const i = rows.value.findIndex((r) => r.node.key === focusKey.value);
  const next = rows.value[Math.max(0, Math.min(rows.value.length - 1, (i < 0 ? 0 : i) + delta))];
  if (!next) return;
  focusKey.value = next.node.key;
  void nextTick(() =>
    list.value
      ?.querySelector(`[data-key="${CSS.escape(next.node.key)}"]`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}

function focusFirst() {
  focusKey.value ??= rows.value[0]?.node.key;
}

function keydown(e: KeyboardEvent) {
  const row = rows.value.find((r) => r.node.key === focusKey.value);
  if (e.key === "ArrowDown") move(1);
  else if (e.key === "ArrowUp") move(-1);
  else if (e.key === "ArrowRight" && row) {
    if (!row.node.children.length) return;
    if (expanded.value.has(row.node.key)) move(1);
    else toggle(row.node.key, true);
  } else if (e.key === "ArrowLeft" && row) {
    if (row.node.children.length && expanded.value.has(row.node.key)) toggle(row.node.key, false);
    else if (row.parent) focusKey.value = row.parent;
  } else if ((e.key === "Enter" || e.key === " ") && row) activate(row.node);
  else return;
  e.preventDefault();
}
</script>

<template>
  <aside
    class="network-sidebar"
    :class="{ open: ui.drawer, collapsed: !layout.tree && !ui.drawer }"
    aria-label="Network"
  >
    <template v-if="layout.tree || ui.drawer">
      <header class="tree-head">
        <span><Network :size="16" />NETWORK</span>
        <button
          class="icon-button panel-toggle"
          aria-label="Collapse network"
          :title="`Collapse network (${panelKeys.tree})`"
          @click="((layout.tree = false), (ui.drawer = false))"
        >
          <PanelLeftClose :size="18" />
        </button>
      </header>
      <div
        ref="list"
        class="tree-list"
        role="tree"
        tabindex="0"
        aria-label="Devices, sessions and agents"
        @keydown="keydown"
        @focus="focusFirst"
      >
        <TreeRow
          v-for="row in rows"
          :key="row.node.key"
          :node="row.node"
          :depth="row.depth"
          :open="expanded.has(row.node.key)"
          :selected="isSelected(row.node)"
          :focused="focusKey === row.node.key"
          :online="isOnline(row.node)"
          @toggle="toggle(row.node.key)"
          @activate="activate(row.node)"
          @action="action(row.node, $event)"
        />
        <p v-if="!rows.length" class="hint tree-empty">
          No devices yet. Declare them in <code>dpi-network.yaml</code> (start from
          <code>dpi-network.example.yaml</code>), then run <code>just net up &lt;id&gt;</code>.
        </p>
      </div>
    </template>
    <div v-else class="panel-rail" aria-label="Network (collapsed)">
      <button
        class="icon-button panel-toggle"
        aria-label="Expand network"
        :title="`Expand network (${panelKeys.tree})`"
        @click="layout.tree = true"
      >
        <PanelLeftOpen :size="18" />
      </button>
      <button
        v-for="d in network.devices.value"
        :key="d.id"
        class="rail-device"
        :title="`${d.id} · ${d.status}`"
        :aria-label="`Show ${d.id}`"
        @click="((layout.tree = true), toggle(d.id, true))"
      >
        <DeviceIcon :device="d" :size="20" /><i
          class="dot"
          :class="
            d.status === 'online'
              ? 'on'
              : d.status === 'checking'
                ? 'chk'
                : d.status === 'offline'
                  ? 'off'
                  : 'err'
          "
        />
      </button>
    </div>
  </aside>
</template>
