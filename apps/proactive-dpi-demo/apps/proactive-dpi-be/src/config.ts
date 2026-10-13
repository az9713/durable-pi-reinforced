import { existsSync } from "node:fs";
import { projectEnvPath } from "../../../shared/paths.ts";

// OPENROUTER_API_KEY and ELEVENLABS_API_KEY live in the project root .env.
if (existsSync(projectEnvPath)) process.loadEnvFile(projectEnvPath);

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};
// Host playback uses afplay, which only macOS has. Elsewhere the voice plays in the browser.
const tts = option("--tts", process.platform === "darwin" ? "host" : "browser");
if (!["host", "browser", "both", "off"].includes(tts)) throw Error("--tts is host, browser, both, or off");

export const config = {
  port: Number(option("--port", "4790")),
  /** Loopback by default: the UI has no login and the incident agent runs bash. Pass --host 0.0.0.0 for a LAN. */
  host: option("--host", "127.0.0.1"),
  dev: args.includes("--dev"),
  model: option("--model", "anthropic/claude-sonnet-5.5"),
  thinking: option("--thinking", "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  /** Incident verdicts sharing one fingerprint inside the window that open an incident. */
  incidentThreshold: Number(option("--incident-threshold", "3")),
  /** Suspicious verdicts sharing one fingerprint inside the window that open an incident. */
  suspiciousThreshold: Number(option("--suspicious-threshold", "8")),
  windowMs: Number(option("--window", "120")) * 1000,
  jevConcurrency: Number(option("--jev-concurrency", "6")),
  /** Rows older than this when first seen are marked skipped instead of judged. */
  backlogMs: Number(option("--backlog", "300")) * 1000,
  tts: tts as "host" | "browser" | "both" | "off",
  /** Also speak when an incident opens. Off by default: the demo has one voice line, at ready for review. */
  announceOpen: args.includes("--announce-open"),
  voiceId: process.env.ELEVENLABS_VOICE_ID ?? "56bWURjYFHyYyVf490Dp",
  voiceModel: process.env.ELEVENLABS_MODEL ?? "eleven_v4_turbo",
  openedSpeech:
    process.env.DPI_OPENED_SPEECH ??
    "Engineer, heads up. Jev flagged a production issue in {service}. A durable agent is investigating.",
  readySpeech:
    process.env.DPI_READY_SPEECH ??
    "Engineer, your Durable Agent Red Team found a production issue, and found the fix. It's waiting on your review.",
};
