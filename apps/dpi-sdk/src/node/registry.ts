// The client-side device registry: ~/.dpi/network.sqlite. Shared by the playground hub,
// dpi-tui and scripts/net.ts on this machine. Holds tokens (mode 0600), live status and UI state.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceInfo, DeviceKind, DeviceStatus, DeviceTree, NetworkDevice } from "../api.js";

export const dpiHome = () => process.env.DPI_HOME ?? join(homedir(), ".dpi");
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEVICE_KINDS: readonly DeviceKind[] = ["local", "ssh", "exe-dev", "url"];

export interface DeviceRow {
  id: string;
  name: string;
  kind: DeviceKind;
  url: string;
  token: string | null;
  source: "config" | "ui";
  position: number;
  deviceUid: string | null;
  lastStatus: DeviceStatus;
  lastError: string | null;
  lastSeenAt: number | null;
  lastInfo: DeviceInfo | null;
  lastTree: DeviceTree | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceInput {
  id: string;
  name?: string;
  kind?: DeviceKind;
  url: string;
  token?: string | null;
  source?: "config" | "ui";
  position?: number;
}

type RawRow = {
  id: string;
  name: string;
  kind: DeviceKind;
  url: string;
  token: string | null;
  source: "config" | "ui";
  position: number;
  device_uid: string | null;
  last_status: DeviceStatus;
  last_error: string | null;
  last_seen_at: number | null;
  last_info_json: string | null;
  last_tree_json: string | null;
  created_at: number;
  updated_at: number;
};

const parse = <T>(json: string | null): T | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

export function normalizeUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw Error(`Invalid URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw Error("URL must use http or https");
  if (parsed.search || parsed.hash) throw Error("URL must not include a query or fragment");
  return parsed.toString().replace(/\/+$/, "");
}

export function validateToken(token: string) {
  if (token.length < 32) throw Error("Token must be at least 32 characters");
  if (/\s/.test(token)) throw Error("Token must not contain whitespace");
  return token;
}

export class NetworkRegistry {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = join(dpiHome(), "network.sqlite")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS devices(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('local','ssh','exe-dev','url')),
        url TEXT NOT NULL,
        token TEXT,
        source TEXT NOT NULL DEFAULT 'ui' CHECK(source IN ('config','ui')),
        position INTEGER NOT NULL DEFAULT 0,
        device_uid TEXT,
        last_status TEXT NOT NULL DEFAULT 'checking',
        last_error TEXT,
        last_seen_at INTEGER,
        last_info_json TEXT,
        last_tree_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  }

  private row(raw: RawRow | undefined): DeviceRow | undefined {
    if (!raw) return undefined;
    return {
      id: raw.id,
      name: raw.name,
      kind: raw.kind,
      url: raw.url,
      token: raw.token,
      source: raw.source,
      position: raw.position,
      deviceUid: raw.device_uid,
      lastStatus: raw.last_status,
      lastError: raw.last_error,
      lastSeenAt: raw.last_seen_at,
      lastInfo: parse<DeviceInfo>(raw.last_info_json),
      lastTree: parse<DeviceTree>(raw.last_tree_json),
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  list(): DeviceRow[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY position, id").all() as RawRow[]).map(
      (raw) => this.row(raw)!,
    );
  }

  get(id: string): DeviceRow | undefined {
    return this.row(this.db.prepare("SELECT * FROM devices WHERE id=?").get(id) as RawRow | undefined);
  }

  /** Insert or update a device. `token: undefined` keeps the stored token; `null` clears it. */
  upsert(input: DeviceInput): DeviceRow {
    if (!DEVICE_ID.test(input.id)) throw Error(`Device id must match ${DEVICE_ID} (got "${input.id}")`);
    const kind = input.kind ?? "url";
    if (!DEVICE_KINDS.includes(kind)) throw Error(`Unknown device kind: ${kind}`);
    const url = normalizeUrl(input.url);
    if (input.token) validateToken(input.token);
    const now = Date.now();
    const current = this.get(input.id);
    if (current && current.source === "config" && input.source === "ui")
      throw Error(`${input.id} comes from dpi-network.yaml; edit it there`);
    const position = input.position ?? current?.position ?? this.list().length;
    const token = input.token === undefined ? (current?.token ?? null) : input.token;
    const urlChanged = current && current.url !== url;
    this.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, url=excluded.url,
           token=excluded.token, source=excluded.source, position=excluded.position, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.name?.trim() || input.id,
        kind,
        url,
        token,
        input.source ?? current?.source ?? "ui",
        position,
        current?.createdAt ?? now,
        now,
      );
    // A new URL may point at a different machine: forget the learned identity and caches.
    if (urlChanged)
      this.db
        .prepare(
          "UPDATE devices SET device_uid=NULL, last_tree_json=NULL, last_info_json=NULL, last_status='checking' WHERE id=?",
        )
        .run(input.id);
    return this.get(input.id)!;
  }

  setToken(id: string, token: string | null) {
    if (token) validateToken(token);
    const result = this.db
      .prepare("UPDATE devices SET token=?, updated_at=? WHERE id=?")
      .run(token, Date.now(), id);
    if (!result.changes) throw Error(`Unknown device: ${id}`);
  }

  remove(id: string) {
    return this.db.prepare("DELETE FROM devices WHERE id=?").run(id).changes > 0;
  }

  /** Drop config devices that are no longer in the YAML. */
  pruneConfig(keep: readonly string[]) {
    for (const row of this.list())
      if (row.source === "config" && !keep.includes(row.id)) this.remove(row.id);
  }

  learnUid(id: string, uid: string) {
    this.db.prepare("UPDATE devices SET device_uid=? WHERE id=? AND device_uid IS NULL").run(uid, id);
  }

  forgetUid(id: string) {
    this.db.prepare("UPDATE devices SET device_uid=NULL WHERE id=?").run(id);
  }

  recordStatus(
    id: string,
    patch: {
      status: DeviceStatus;
      error?: string | null;
      seenAt?: number;
      info?: DeviceInfo;
      tree?: DeviceTree;
    },
  ) {
    const sets = ["last_status=?", "last_error=?"];
    const values: (string | number | null)[] = [patch.status, patch.error ?? null];
    if (patch.seenAt !== undefined) sets.push("last_seen_at=?"), values.push(patch.seenAt);
    if (patch.info) sets.push("last_info_json=?"), values.push(JSON.stringify(patch.info));
    if (patch.tree) sets.push("last_tree_json=?"), values.push(JSON.stringify(patch.tree));
    this.db.prepare(`UPDATE devices SET ${sets.join(",")} WHERE id=?`).run(...values, id);
  }

  uiGet<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM ui_state WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? (parse<T>(row.value) ?? undefined) : undefined;
  }

  uiSet(key: string, value: unknown) {
    const json = JSON.stringify(value);
    if (json.length > 100_000) throw Error("UI state value too large");
    this.db
      .prepare(
        "INSERT INTO ui_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .run(key, json, Date.now());
  }

  close() {
    this.db.close();
  }
}

/** The browser-safe view of a row: never includes the token. */
export function toPublic(
  row: DeviceRow,
  live?: { status: DeviceStatus; error?: string; info?: DeviceInfo; tree?: DeviceTree; lastSeenAt?: number },
): NetworkDevice {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    source: row.source,
    hasToken: !!row.token,
    status: live?.status ?? row.lastStatus,
    error: (live ? live.error : row.lastError) ?? undefined,
    lastSeenAt: live?.lastSeenAt ?? row.lastSeenAt ?? undefined,
    info: live?.info ?? row.lastInfo ?? undefined,
    tree: live?.tree ?? row.lastTree ?? undefined,
  };
}
