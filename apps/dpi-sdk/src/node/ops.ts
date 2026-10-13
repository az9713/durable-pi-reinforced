// Process helpers for the network ops CLI: local commands, remote shell scripts over ssh
// (scripts and secrets travel on stdin, never argv), rsync and the exe.dev control plane.
import { spawn } from "node:child_process";
import type { NetDevice } from "./config.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  /** Stream output to this process's stdout/stderr while capturing it. */
  echo?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          stderr += `\n[timeout after ${options.timeoutMs}ms]`;
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
      if (options.echo) process.stderr.write(chunk);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFail)
        reject(Object.assign(Error(`${cmd} ${args.slice(0, 3).join(" ")} … failed (exit ${result.code}): ${stderr.trim().slice(-800)}`), { result }));
      else resolve(result);
    });
    child.stdin.end(options.stdin ?? "");
  });
}

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15"];

/** "~/x" → "$HOME/x" for use inside double-quoted remote shell strings. */
export const shPath = (p: string) => (p === "~" ? "$HOME" : p.startsWith("~/") ? `$HOME/${p.slice(2)}` : p);
/** Single-quote a value for a POSIX shell. */
export const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const PRELUDE = `set -e
export NVM_DIR="$HOME/.nvm"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
`;

export function sshTarget(device: NetDevice) {
  if (!device.ssh) throw Error(`${device.id} (kind ${device.kind}) has no ssh target`);
  return device.ssh;
}

/** Run a POSIX shell script on the device. The script (and anything embedded in it) goes over stdin. */
export function remote(device: NetDevice, script: string, options: Omit<RunOptions, "stdin"> = {}) {
  return run("ssh", [...SSH_OPTS, sshTarget(device), "sh -s"], { ...options, stdin: PRELUDE + script });
}

export function rsync(device: NetDevice, sources: string[], dest: string, cwd: string) {
  return run(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude", "node_modules",
      "--exclude", ".data",
      "--exclude", ".durable-pi",
      "--exclude", "dist",
      "--exclude", "*.log",
      "--exclude", ".DS_Store",
      "-e", `ssh ${SSH_OPTS.join(" ")}`,
      ...sources,
      `${sshTarget(device)}:${dest}`,
    ],
    { cwd, timeoutMs: 600_000 },
  );
}

/** The exe.dev control plane (`ssh exe.dev <verb> --json`). */
export async function exeDev<T = unknown>(args: string[], timeoutMs = 60_000): Promise<T> {
  const result = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "exe.dev", ...args, "--json"], { timeoutMs });
  const text = result.stdout.trim();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return { raw: text } as T;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
