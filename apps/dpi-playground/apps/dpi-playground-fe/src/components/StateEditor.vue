<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Plus, Minus, Trash2 } from "lucide-vue-next";
import { statePath, type JsonValue, type StateChange } from "@sdk/app-state";

const props = withDefaults(
  defineProps<{ value: JsonValue; path?: string; label?: string; disabled?: boolean }>(),
  { path: "", label: "App State" },
);
const emit = defineEmits<{ change: [change: StateChange] }>();
const kind = computed(() =>
  props.value === null ? "null" : Array.isArray(props.value) ? "array" : typeof props.value,
);
const container = computed(() => kind.value === "object" || kind.value === "array");
const children = computed(() =>
  container.value ? Object.entries(props.value as Record<string, JsonValue>) : [],
);
const draft = ref("");
const editing = ref(false);
const key = ref("");
const newType = ref("string");
const adding = ref(false);
const types = ["string", "number", "boolean", "object", "array", "null"];
const defaults: Record<string, () => JsonValue> = {
  string: () => "",
  number: () => 0,
  boolean: () => false,
  object: () => ({}),
  array: () => [],
  null: () => null,
};
watch(
  () => props.value,
  (value) => {
    if (!editing.value) draft.value = String(value ?? "");
  },
  { immediate: true },
);
function change(operation: StateChange["operation"], value?: JsonValue) {
  emit("change", { operation, path: props.path, value });
}
function save() {
  editing.value = false;
  const value = kind.value === "number" ? Number(draft.value) : draft.value;
  if (kind.value === "number" && (!String(draft.value).trim() || !Number.isFinite(value))) {
    draft.value = String(props.value);
    return;
  }
  if (value !== props.value) change("update", value);
}
function add() {
  const name = kind.value === "array" ? "-" : key.value.trim();
  if (!name) return;
  emit("change", {
    operation: "create",
    path: statePath(props.path, name),
    value: defaults[newType.value]!(),
  });
  key.value = "";
  adding.value = false;
}
</script>

<template>
  <div class="state-field" :class="{ 'state-root': path === '' }" :data-state-path="path">
    <div v-if="path !== ''" class="state-field-heading">
      <strong>{{ label }}</strong>
      <select
        :value="kind"
        :aria-label="`Type of ${path}`"
        :disabled="disabled"
        @change="change('update', defaults[($event.target as HTMLSelectElement).value]!())"
      >
        <option v-for="type in types" :key="type" :value="type">{{ type }}</option>
      </select>
      <button
        class="icon-button"
        :aria-label="`Delete ${path}`"
        title="Delete field"
        :disabled="disabled"
        @click="change('delete')"
      >
        <Trash2 :size="18" />
      </button>
    </div>
    <template v-if="container">
      <StateEditor
        v-for="[childKey, child] in children"
        :key="childKey"
        :value="child"
        :path="statePath(path, childKey)"
        :label="childKey"
        :disabled="disabled"
        @change="emit('change', $event)"
      />
      <form v-if="adding && kind === 'array'" class="state-add" @submit.prevent="add">
        <input
          v-if="kind !== 'array'"
          v-model="key"
          placeholder="Field name"
          :aria-label="`New field name in ${path || '/'}`"
          required
          :disabled="disabled"
        />
        <select
          v-model="newType"
          :aria-label="`New field type in ${path || '/'}`"
          :disabled="disabled"
        >
          <option v-for="type in types" :key="type" :value="type">{{ type }}</option>
        </select>
        <button class="secondary small" :disabled="disabled || (kind !== 'array' && !key.trim())">
          Add
        </button>
        <button type="button" class="text-button" @click="adding = false">Cancel</button>
      </form>
      <button
        v-else-if="kind === 'array'"
        class="text-button state-add-button"
        :disabled="disabled"
        :aria-label="`Add ${kind === 'array' ? 'item' : 'field'} to ${path || '/'}`"
        @click="adding = true"
      >
        <Plus :size="18" />{{ kind === "array" ? "Add item" : "Add field" }}
      </button>
    </template>
    <div v-else-if="kind === 'number'" class="state-number">
      <button
        class="secondary"
        :aria-label="`Decrement ${path}`"
        :disabled="disabled"
        @click="change('increment', -1)"
      >
        <Minus :size="18" />
      </button>
      <input
        v-model="draft"
        type="number"
        step="any"
        :aria-label="`Value of ${path}`"
        :disabled="disabled"
        @focus="editing = true"
        @blur="save"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <button
        class="secondary"
        :aria-label="`Increment ${path}`"
        :disabled="disabled"
        @click="change('increment', 1)"
      >
        <Plus :size="18" />
      </button>
    </div>
    <div v-else-if="kind === 'boolean'" class="state-boolean">
      <button
        class="switch"
        role="switch"
        :aria-label="`Value of ${path}`"
        :aria-checked="value === true"
        :class="{ on: value === true }"
        :disabled="disabled"
        @click="change('update', !value)"
      >
        <span /></button
      ><span>{{ value }}</span>
    </div>
    <textarea
      v-else-if="kind === 'string'"
      v-model="draft"
      rows="2"
      :aria-label="`Value of ${path}`"
      :disabled="disabled"
      @focus="editing = true"
      @blur="save"
    />
    <span v-else class="muted">null</span>
  </div>
</template>
