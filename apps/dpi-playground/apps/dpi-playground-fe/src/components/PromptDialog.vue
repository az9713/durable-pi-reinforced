<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { X } from "lucide-vue-next";
import { message } from "../client/hub";
import type { Dialog } from "../client/store";

// One dialog for every name/note/confirm prompt: rename, fork, reset, archive, remove.
const props = defineProps<{ dialog: Extract<Dialog, { kind: "prompt" }> }>();
const emit = defineEmits<{ close: [] }>();
const value = ref(props.dialog.value ?? "");
const busy = ref(false);
const error = ref("");
const input = ref<HTMLInputElement | HTMLTextAreaElement>();
const hasInput = !!props.dialog.label;

async function submit() {
  if (busy.value) return;
  if (hasInput && !props.dialog.optional && !value.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    await props.dialog.run(value.value.trim());
    emit("close");
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => void nextTick(() => (input.value?.focus(), input.value?.select())));
</script>

<template>
  <div class="modal-backdrop" @click.self="!busy && emit('close')">
    <form
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
      @submit.prevent="submit"
    >
      <header>
        <h2 id="prompt-title">{{ dialog.title }}</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Close dialog"
          :disabled="busy"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>
      <p v-if="dialog.hint" class="hint">{{ dialog.hint }}</p>
      <label v-if="hasInput"
        >{{ dialog.label }}
        <span v-if="dialog.optional" class="muted">(optional)</span>
        <textarea
          v-if="dialog.multiline"
          ref="input"
          v-model="value"
          rows="4"
          :placeholder="dialog.placeholder"
          :disabled="busy" /><input
          v-else
          ref="input"
          v-model="value"
          maxlength="100"
          :required="!dialog.optional"
          :placeholder="dialog.placeholder"
          :aria-label="dialog.label"
          :disabled="busy"
      /></label>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button
          class="primary"
          :class="{ danger: dialog.danger }"
          :disabled="busy || (hasInput && !dialog.optional && !value.trim())"
        >
          {{ busy ? "Working…" : dialog.submit }}
        </button>
      </footer>
    </form>
  </div>
</template>
