// Rebuilds the demo from nothing: empty databases and a fresh checkout-api git repo
// whose newest commit carries the guest checkout bug.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentDbPath, dataDir, logsDbPath, repoDir, templateDir, workspaceDir } from "../shared/paths.ts";
import { lockOwner } from "../shared/lock.ts";

for (const db of [logsDbPath, agentDbPath]) {
  const owner = lockOwner(`${db}.lock`);
  if (owner !== undefined) {
    console.error(`Stop the demo first. Process ${owner} owns ${db}.`);
    process.exit(1);
  }
}

rmSync(dataDir, { recursive: true, force: true });
rmSync(workspaceDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoDir, { recursive: true });

const git = (args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, { cwd: repoDir, env: { ...process.env, ...env }, encoding: "utf8" }).trim();

git(["init", "-q", "-b", "main"]);
// Commits the incident agent makes are attributed to it.
git(["config", "user.name", "Proactive DPI Agent"]);
git(["config", "user.email", "agent@lumen.market"]);

const commits = JSON.parse(readFileSync(join(templateDir, "commits.json"), "utf8")) as {
  dir: string;
  message: string;
  author: string;
  hoursAgo: number;
}[];
for (const commit of commits) {
  cpSync(join(templateDir, commit.dir), repoDir, { recursive: true });
  const [, name, email] = /^(.*) <(.*)>$/.exec(commit.author)!;
  const date = new Date(Date.now() - commit.hoursAgo * 3_600_000).toISOString();
  git(["add", "-A"]);
  git(["commit", "-q", "-m", commit.message], {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  });
}

// The buggy commit passes its own tests. That is how it reached production.
execFileSync("npm", ["test", "--silent"], { cwd: repoDir, stdio: "ignore" });

console.log(`Reset complete.
  repo      ${repoDir}
  history   ${git(["log", "--oneline"]).split("\n").join("\n            ")}
  data      ${existsSync(dataDir) ? dataDir : "missing"}`);
