// Each incident agent works in its own git worktree of checkout-api, on its own branch.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoDir } from "../../../shared/paths.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();

export function ensureWorktree(branch: string, path: string) {
  if (existsSync(join(path, ".git"))) return;
  git(repoDir, "worktree", "prune");
  let exists = true;
  try {
    git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    exists = false;
  }
  if (exists) git(repoDir, "worktree", "add", "-q", path, branch);
  else git(repoDir, "worktree", "add", "-q", "-b", branch, path, "main");
}

/** What the engineer reviews: commits on the incident branch and the diff against main. */
export function branchReview(path: string) {
  if (!existsSync(join(path, ".git"))) return { ahead: 0, head: null, log: "", diffStat: "", diff: "" };
  return {
    ahead: Number(git(path, "rev-list", "--count", "main..HEAD")),
    head: git(path, "rev-parse", "--short", "HEAD"),
    log: git(path, "log", "--format=%h %an: %s", "main..HEAD"),
    diffStat: git(path, "diff", "--stat", "main...HEAD"),
    diff: git(path, "diff", "main...HEAD"),
  };
}

function runTests(cwd: string, files: string[] = []) {
  const result = spawnSync("node", ["--test", ...files], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 60_000,
  });
  const lines = `${result.stdout}${result.stderr}`.split("\n");
  const counts = lines.filter((l) => /^ℹ (tests|pass|fail) /.test(l)).map((l) => l.slice(2));
  // The spec reporter prints each failed test twice: inline and in its closing summary.
  const failed = [...new Set(lines.filter((l) => l.startsWith("✖") && !l.startsWith("✖ failing tests")))].slice(0, 5);
  return { ok: result.status === 0, summary: [counts.join(", "), ...failed].filter(Boolean).join("\n") };
}

/**
 * Proves a fix before it is offered for review: the changed tests fail on main's code, the whole
 * suite passes on the branch, then it commits. Running it again after a crash reuses the commit.
 */
export function verifyAndCommit(worktree: string, message: string) {
  git(worktree, "add", "-A");
  const changed = git(worktree, "diff", "--cached", "--name-only", "main").split("\n").filter(Boolean);
  if (!changed.length) throw Error("Nothing differs from main yet. Make the fix and the regression test first.");
  const tests = changed.filter((p) => /^test\/.+\.test\.ts$/.test(p) && existsSync(join(worktree, p)));
  if (!tests.length) throw Error("Add a regression test under test/ that reproduces the failure.");
  const scratch = mkdtempSync(join(tmpdir(), "incident-verify-"));
  let before: ReturnType<typeof runTests>;
  try {
    execSync(`git archive main | tar -x -C "${scratch}"`, { cwd: worktree });
    for (const test of tests) {
      mkdirSync(dirname(join(scratch, test)), { recursive: true });
      copyFileSync(join(worktree, test), join(scratch, test));
    }
    before = runTests(scratch, tests);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (before.ok)
    throw Error(`The regression test passes on main, so it does not reproduce the failure.\n${before.summary}`);
  const after = runTests(worktree);
  if (!after.ok) throw Error(`The suite fails with the fix.\n${after.summary}`);
  if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: worktree }).status !== 0)
    git(worktree, "commit", "-q", "-m", message);
  return {
    head: git(worktree, "rev-parse", "--short", "HEAD"),
    diffStat: git(worktree, "diff", "--stat", "main...HEAD"),
    before: before.summary,
    after: after.summary,
  };
}
