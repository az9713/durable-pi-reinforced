<script setup lang="ts">
import { computed, ref } from "vue";
import { Copy, RefreshCw, ShieldAlert, WifiOff, Loader } from "lucide-vue-next";
import type { NetworkDevice } from "@sdk/api";
import { hub, message } from "../client/hub";
import { ago, notify } from "../client/store";

const props = defineProps<{ device: NetworkDevice }>();
const busy = ref(false);
const error = ref("");

/** The exact fix for this device's state. Device setup happens in the terminal, never in this UI. */
const fix = computed(() => {
  const d = props.device;
  const config = d.source === "config";
  switch (d.status) {
    case "checking":
      return {
        title: `Checking ${d.id}…`,
        text: "Probing the device. This view fills in as soon as it answers.",
      };
    case "unauthorized":
      return {
        title: d.hasToken ? `${d.id} rejected its token` : `No token for ${d.id}`,
        text: d.hasToken
          ? "The device's DPI_TOKEN changed (a rotate or a rebuilt device). Copy the current token into this hub's registry, then check again."
          : "This hub has no token for the device yet. Register it, then check again.",
        command:
          config && d.kind !== "url"
            ? `just net register ${d.id}`
            : `just net register ${d.id} --token <token>`,
      };
    case "mismatch":
      return {
        title: `${d.id} answers as a different device`,
        text: "The URL now reaches a backend with another identity (a rebuilt VM or a new data directory). If that is expected, register it again: that trusts the identity it answers with now.",
        command:
          d.kind === "url"
            ? `just net register ${d.id} --token <token>`
            : `just net register ${d.id}`,
      };
    case "incompatible":
      return {
        title: `${d.id} speaks another API version`,
        text: "Update the device's dpi-backend.",
        command: config ? `just net deploy ${d.id}` : undefined,
      };
    default:
      return {
        title: `${d.id} is offline`,
        text: `Last seen ${ago(d.lastSeenAt)}. Its agents keep their state on the device and resume when its backend starts again. The tree shows the last known sessions.`,
        command: !config
          ? undefined
          : d.kind === "local"
            ? "just backend run"
            : d.kind === "url"
              ? undefined
              : `just net restart ${d.id}`,
        alt: config && d.kind !== "local" && d.kind !== "url" ? `just net up ${d.id}` : undefined,
      };
  }
});

async function check() {
  busy.value = true;
  error.value = "";
  try {
    const d = await hub.check(props.device.id);
    if (d.status === "online") notify(`${d.id} is online.`);
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify("Copied.");
  } catch {
    notify("Clipboard needs localhost or HTTPS. Select the text to copy.");
  }
}
</script>

<template>
  <section class="chat-panel offline-panel" :class="device.status" aria-live="polite">
    <div class="chat-empty">
      <Loader v-if="device.status === 'checking'" class="spin" :size="30" />
      <ShieldAlert
        v-else-if="device.status === 'mismatch' || device.status === 'unauthorized'"
        :size="30"
      />
      <WifiOff v-else :size="30" />
      <span class="eyebrow">{{ device.kind.toUpperCase() }} · {{ device.url }}</span>
      <h2>{{ fix.title }}</h2>
      <p>{{ fix.text }}</p>
      <p v-if="device.error" class="hint offline-error">{{ device.error }}</p>
      <div v-if="fix.command" class="offline-command">
        <code>{{ fix.command }}</code>
        <button class="icon-button" aria-label="Copy command" @click="copy(fix.command)">
          <Copy :size="18" />
        </button>
      </div>
      <p v-if="fix.command" class="hint">Run it in this repo's terminal, then press Check now.</p>
      <p v-if="fix.alt" class="hint">
        Never deployed or rebuilt? <code>{{ fix.alt }}</code> provisions it from scratch.
      </p>
      <div class="offline-actions">
        <button class="secondary" :disabled="busy" @click="check()">
          <RefreshCw :size="18" />{{ busy ? "Checking…" : "Check now" }}
        </button>
      </div>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>
