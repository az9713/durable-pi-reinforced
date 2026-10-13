<script setup lang="ts">
import { ref, watch } from "vue";
import { CornerLeftUp, Folder, FolderOpen, Home } from "lucide-vue-next";
import type { DirListing } from "@sdk/api";
import { deviceClient, message } from "../client/hub";

const props = defineProps<{ deviceId: string }>();
const cwd = defineModel<string>({ required: true });
const listing = ref<DirListing>();
const loading = ref(false);
const error = ref("");

// Only the latest request may update the view: switching devices mid-load must not show the
// previous device's listing.
let seq = 0;
async function open(path: string) {
  const mine = ++seq;
  const deviceId = props.deviceId;
  loading.value = true;
  error.value = "";
  try {
    const result = await deviceClient(deviceId).dirs(path);
    if (mine !== seq) return undefined;
    listing.value = result;
    if (result.path) cwd.value = result.path;
    return result;
  } catch (e) {
    if (mine === seq) error.value = message(e);
    return undefined;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(
  () => props.deviceId,
  async () => {
    listing.value = undefined;
    // Start inside the first root so the list is useful right away.
    const roots = await open("");
    const first = roots?.dirs[0];
    if (first && !roots.path) await open(first.path);
  },
  { immediate: true },
);
</script>

<template>
  <div class="dir-browser">
    <div class="dir-path">
      <input
        v-model="cwd"
        aria-label="Working directory"
        required
        placeholder="/path/to/project"
        spellcheck="false"
        autocomplete="off"
        @keydown.enter.prevent="open(cwd)"
      />
      <button type="button" class="secondary small" :disabled="loading || !cwd" @click="open(cwd)">
        Go
      </button>
    </div>
    <div class="dir-list" role="listbox" aria-label="Directories" :aria-busy="loading">
      <button type="button" class="dir-item" title="Start directories" @click="open('')">
        <Home :size="16" /><span>Start dirs</span>
      </button>
      <button
        v-if="listing?.parent"
        type="button"
        class="dir-item"
        :title="listing.parent"
        @click="open(listing.parent)"
      >
        <CornerLeftUp :size="16" /><span>..</span>
      </button>
      <button
        v-for="d in listing?.dirs"
        :key="d.path"
        type="button"
        class="dir-item"
        role="option"
        :aria-selected="d.path === cwd"
        :title="d.path"
        @click="open(d.path)"
      >
        <FolderOpen v-if="d.path === cwd" :size="16" /><Folder v-else :size="16" /><span>{{
          d.name
        }}</span>
      </button>
      <p v-if="listing && !listing.dirs.length" class="hint">No subdirectories.</p>
    </div>
    <p v-if="error" class="message-error" role="alert">{{ error }}</p>
  </div>
</template>
