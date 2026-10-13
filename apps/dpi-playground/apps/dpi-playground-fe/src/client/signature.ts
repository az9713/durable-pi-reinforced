// A tool's JSON Schema as a TypeScript function declaration, already split into highlight tokens.
// We generate the code, so we know every token's kind without a highlighter.

export type TokenKind = "keyword" | "function" | "property" | "type" | "string" | "number" | "comment" | "punct" | "text";
export interface Token {
  text: string;
  kind: TokenKind;
}

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

type Emit = (text: string, kind?: TokenKind) => void;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const indent = (depth: number) => "  ".repeat(depth);

export function toolSignature(name: string, parameters: unknown): Token[] {
  const out: Token[] = [];
  const emit: Emit = (text, kind = "text") => out.push({ text, kind });
  emit("function", "keyword");
  emit(" ");
  emit(name, "function");
  emit("(", "punct");
  emit("args");
  emit(": ", "punct");
  type(parameters as Schema, 0, emit);
  emit("): ", "punct");
  emit("Promise", "type");
  emit("<", "punct");
  emit("ToolResult", "type");
  emit(">;", "punct");
  return out;
}

function type(s: Schema | undefined, depth: number, emit: Emit) {
  if (!s || typeof s !== "object") return emit("unknown", "type");
  if ("const" in s) return literal(s.const, emit);
  if (s.enum) return union(s.enum.map((value) => ({ const: value })), depth, emit);
  if (s.anyOf ?? s.oneOf) return union((s.anyOf ?? s.oneOf)!, depth, emit);
  if (Array.isArray(s.type)) return union(s.type.map((t) => ({ ...s, type: t })), depth, emit);
  switch (s.type) {
    case "string":
    case "boolean":
    case "null":
      return emit(s.type, "type");
    case "number":
    case "integer":
      return emit("number", "type");
    case "array": {
      const grouped = !!(s.items?.anyOf ?? s.items?.oneOf ?? s.items?.enum);
      if (grouped) emit("(", "punct");
      type(s.items, depth, emit);
      if (grouped) emit(")", "punct");
      return emit("[]", "punct");
    }
    case "object":
      return object(s, depth, emit);
    default:
      return emit("unknown", "type");
  }
}

function object(s: Schema, depth: number, emit: Emit) {
  const props = Object.entries(s.properties ?? {});
  if (!props.length) {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      emit("Record", "type");
      emit("<", "punct");
      emit("string", "type");
      emit(", ", "punct");
      type(s.additionalProperties, depth, emit);
      return emit(">", "punct");
    }
    return emit("{}", "punct");
  }
  const required = new Set(s.required ?? []);
  emit("{", "punct");
  emit("\n");
  for (const [key, prop] of props) {
    const doc = docComment(prop);
    if (doc) emit(`${indent(depth + 1)}${doc}\n`, "comment");
    emit(indent(depth + 1));
    emit(IDENT.test(key) ? key : JSON.stringify(key), "property");
    emit(required.has(key) ? ": " : "?: ", "punct");
    type(prop, depth + 1, emit);
    emit(";", "punct");
    emit("\n");
  }
  emit(indent(depth));
  emit("}", "punct");
}

function union(variants: Schema[], depth: number, emit: Emit) {
  variants.forEach((variant, i) => {
    if (i) emit(" | ", "punct");
    type(variant, depth, emit);
  });
}

function literal(value: unknown, emit: Emit) {
  if (typeof value === "string") return emit(JSON.stringify(value), "string");
  if (typeof value === "number") return emit(String(value), "number");
  emit(String(value), "type");
}

function docComment(s: Schema) {
  const parts = [
    s.description,
    s.minimum !== undefined ? `@minimum ${s.minimum}` : "",
    s.maximum !== undefined ? `@maximum ${s.maximum}` : "",
    s.default !== undefined ? `@default ${JSON.stringify(s.default)}` : "",
  ].filter(Boolean);
  return parts.length ? `/** ${parts.join(" ")} */` : "";
}
