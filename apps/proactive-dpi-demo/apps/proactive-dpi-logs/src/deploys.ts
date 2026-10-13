// Production runs real code: each Cloud Run revision is a `git archive` of one checkout-api commit.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir, repoDir } from "../../../shared/paths.ts";

export type CheckoutResult = { status: number; body: Record<string, unknown> };

export type Revision = {
  name: string;
  commit: string;
  subject: string;
  handleCheckout: (request: unknown) => Promise<CheckoutResult>;
  /** Rewrites a local stack trace into what the container would print. */
  containerStack: (stack: string) => string;
};

export async function loadRevision(ref: string, name: string): Promise<Revision> {
  if (!existsSync(join(repoDir, ".git")))
    throw Error(`Missing mock repo at ${repoDir}. Run npm run reset first.`);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "--short", ref);
  const subject = git("log", "-1", "--format=%s", ref);
  const dir = join(dataDir, "deploys", `${name}-${commit}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execSync(`git archive ${ref} | tar -x -C "${dir}"`, { cwd: repoDir });
  }
  const mod = await import(pathToFileURL(join(dir, "src/routes/checkout.ts")).href);
  const server = readFileSync(join(dir, "src/server.ts"), "utf8").split("\n");
  const serverLine = server.findIndex((line) => line.includes("handleCheckout(JSON"));
  const serverFrame = `    at Server.<anonymous> (file:///workspace/src/server.ts:${serverLine + 1}:${server[serverLine].indexOf("handleCheckout") + 1})`;
  const url = pathToFileURL(dir).href;
  return {
    name,
    commit,
    subject,
    handleCheckout: mod.handleCheckout,
    // Frames name the revision's files as file URLs under node and as plain paths under tsx.
    containerStack: (stack) => {
      const own = stack.split("\n").filter((line, i) => i === 0 || line.includes(dir));
      const frames = own.map((line) =>
        line.replaceAll(url, "file:///workspace").replaceAll(dir, "file:///workspace"),
      );
      return [...frames, serverFrame].join("\n");
    },
  };
}
