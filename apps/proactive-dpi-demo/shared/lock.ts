import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** PID of the live process holding this lock, if any. */
export function lockOwner(path: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? undefined : pid;
  }
}

/** One process owns a SQLite file at a time. Returns the release function. */
export function lockFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const owner = lockOwner(path);
  if (owner !== undefined && owner !== process.pid)
    throw Error(`Already owned by process ${owner}: ${path}`);
  writeFileSync(path, String(process.pid), { mode: 0o600 });
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}
