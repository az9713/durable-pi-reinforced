export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type AppState = { [key: string]: JsonValue };
export type StateChange = {
  operation: "create" | "update" | "delete" | "increment";
  path: string;
  value?: JsonValue;
};

export function statePath(parent: string, key: string) {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function parts(path: string) {
  if (path === "") return [];
  if (!path.startsWith("/")) throw Error("Use a JSON Pointer path, such as /counter");
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?![01])/u.test(part)) throw Error("Invalid JSON Pointer escape");
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw Error("Reserved field name");
      return key;
    });
}

function child(value: JsonValue, key: string): JsonValue {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
    throw Error(`Field does not exist: ${key}`);
  if (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(key)) throw Error("Invalid array index");
  return (value as AppState)[key]!;
}

export function readState(state: AppState, path = ""): JsonValue {
  return parts(path).reduce<JsonValue>(child, state);
}

function validate(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 24) throw Error("State is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) throw Error("Value must be valid JSON");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("Reserved field name");
    validate(item, depth + 1);
  }
}

export function changeState(state: AppState, input: StateChange): AppState {
  if (!["create", "update", "delete", "increment"].includes(input.operation))
    throw Error("Invalid state operation");
  if (typeof input.path !== "string") throw Error("State path is required");
  const path = parts(input.path);
  const next: AppState = JSON.parse(JSON.stringify(state));
  if (!path.length) {
    if (input.operation === "delete") return {};
    if (
      input.operation !== "update" ||
      input.value === null ||
      Array.isArray(input.value) ||
      typeof input.value !== "object"
    )
      throw Error("The state root must be a JSON object. Use update to replace it.");
    validate(input.value);
    if (JSON.stringify(input.value).length > 100000)
      throw Error("App State must be under 100,000 characters");
    return JSON.parse(JSON.stringify(input.value));
  }
  const key = path.pop()!;
  const parent = path.reduce<JsonValue>(child, next);
  if (parent === null || typeof parent !== "object")
    throw Error("Parent must be an object or array");
  const exists = Object.hasOwn(parent, key);
  const array = Array.isArray(parent);
  const append = array && (key === "-" || key === String(parent.length));
  if (array && !append && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length))
    throw Error("Invalid array index");
  if (input.operation === "create" && exists) throw Error("Field already exists. Use update.");
  if (input.operation !== "create" && !exists) throw Error("Field does not exist. Use create.");
  if (input.operation === "delete") {
    if (array) parent.splice(Number(key), 1);
    else delete parent[key];
  } else {
    let value = input.value;
    if (input.operation === "increment") {
      const current = (parent as AppState)[key];
      if (typeof current !== "number" || typeof value !== "number")
        throw Error("Increment requires numbers");
      value = current + value;
    }
    validate(value);
    if (array) parent[append ? parent.length : Number(key)] = value;
    else parent[key] = value;
  }
  validate(next);
  if (JSON.stringify(next).length > 100000)
    throw Error("App State must be under 100,000 characters");
  return next;
}

export function replaceState(target: AppState, next: AppState) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}
