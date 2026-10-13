// Create (or with --rotate, replace) DPI_TOKEN in $DPI_HOME/backend.env and print it.
// `just net up <device>` does this remotely; this script is for manual setups.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const file = process.env.DPI_ENV_FILE ?? join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "backend.env");
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
const current = text.match(/^DPI_TOKEN=(.+)$/m)?.[1];
if (current && !process.argv.includes("--rotate")) {
  console.log(current);
} else {
  const token = `dpi_${randomBytes(32).toString("base64url")}`;
  const rest = text.replace(/^DPI_TOKEN=.*\n?/m, "");
  writeFileSync(file, `DPI_TOKEN=${token}\n${rest}`, { mode: 0o600 });
  console.log(token);
}
