import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const demoDir = fileURLToPath(new URL("../", import.meta.url));
export const projectEnvPath = resolve(demoDir, "../../.env");
export const dataDir = join(demoDir, ".data");
export const ttsDir = join(dataDir, "tts");
export const logsDbPath = join(dataDir, "logs.sqlite");
export const watchDbPath = join(dataDir, "watch.sqlite");
export const agentDbPath = join(dataDir, "agent.sqlite");
export const templateDir = join(demoDir, "mock-repo-template");
export const workspaceDir = join(demoDir, "workspace");
export const repoDir = join(workspaceDir, "checkout-api");
export const worktreesDir = join(workspaceDir, "incidents");
