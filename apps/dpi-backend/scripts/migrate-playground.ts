// One-time move of the old single-machine playground's data into a dpi-backend data dir.
//   npm run migrate-playground -- --from ../dpi-playground [--to ~/.dpi/backend]
// Stop the old playground first. The source is left in place; the target must be empty.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const arg = (key: string, fallback: string) => {
  const i = process.argv.indexOf(key);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const from = resolve(arg("--from", "../dpi-playground"));
const to = resolve(arg("--to", join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "backend")).replace(/^~/, homedir()));
const oldCatalog = join(from, ".data", "catalog.sqlite");
const oldState = join(from, ".durable-pi", "app-state.sqlite");
const oldSessions = join(from, ".durable-pi", "sessions");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const lockOwners = [`${oldCatalog}.lock`, `${oldState}.lock`]
  .filter(existsSync)
  .map((f) => Number(readFileSync(f, "utf8")))
  .filter(alive);
if (lockOwners.length) throw Error(`The old playground is still running (pid ${lockOwners.join(", ")}). Stop it first.`);
if (!existsSync(oldCatalog)) throw Error(`No playground catalog at ${oldCatalog}`);
if (existsSync(join(to, "catalog.sqlite"))) throw Error(`${to} already has a catalog; refusing to overwrite`);

const checkpoint = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
};

mkdirSync(join(to, "sessions"), { recursive: true, mode: 0o700 });
checkpoint(oldCatalog);
copyFileSync(oldCatalog, join(to, "catalog.sqlite"));
if (existsSync(oldState)) {
  checkpoint(oldState);
  copyFileSync(oldState, join(to, "app-state.sqlite"));
}
const catalog = new DatabaseSync(join(to, "catalog.sqlite"));
const rows = catalog.prepare("SELECT id, dbPath FROM sessions").all() as { id: string; dbPath: string }[];
let moved = 0;
for (const row of rows) {
  const source = join(oldSessions, row.id);
  const target = join(to, "sessions", row.id);
  if (!existsSync(join(source, "agent.sqlite"))) {
    console.warn(`skip ${row.id}: no agent.sqlite in ${source}`);
    continue;
  }
  checkpoint(join(source, "agent.sqlite"));
  cpSync(source, target, { recursive: true, filter: (p) => !p.endsWith(".lock") });
  catalog.prepare("UPDATE sessions SET dbPath=? WHERE id=?").run(join(target, "agent.sqlite"), row.id);
  moved++;
}
for (const row of catalog.prepare("SELECT dbPath FROM sessions").all() as { dbPath: string }[])
  if (!existsSync(row.dbPath)) throw Error(`Verification failed: missing ${row.dbPath}`);
catalog.close();
console.log(`Migrated ${moved}/${rows.length} sessions into ${to} (${readdirSync(join(to, "sessions")).length} session dirs).`);
