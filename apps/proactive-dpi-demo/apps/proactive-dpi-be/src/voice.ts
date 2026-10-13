// ElevenLabs text to speech (ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL).
// Plays on the backend host with afplay (macOS), in connected browsers, or both.
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Speech = { text: string; url: string | null; at: number; browser: boolean };

export class Voice extends EventEmitter {
  private queue = Promise.resolve();
  private files = new Map<string, Promise<string>>();

  constructor(
    private readonly mode: "host" | "browser" | "both" | "off",
    private readonly dir: string,
    private readonly voiceId: string,
    private readonly model: string,
  ) {
    super();
  }

  private get enabled() {
    return this.mode !== "off" && !!process.env.ELEVENLABS_API_KEY;
  }

  /** Synthesize ahead of time so `say` plays without waiting on the API. */
  prepare(text: string) {
    if (this.enabled) this.file(text).catch((e) => console.error("[voice]", e instanceof Error ? e.message : e));
  }

  say(text: string) {
    console.log(`[voice] ${text}`);
    if (!this.enabled) {
      this.emit("speech", { text, url: null, at: Date.now(), browser: false } satisfies Speech);
      return;
    }
    // One announcement at a time, so two alerts never talk over each other.
    this.queue = this.queue
      .then(() => this.speak(text))
      .catch((e) => console.error("[voice]", e instanceof Error ? e.message : e));
  }

  private async speak(text: string) {
    const path = await this.file(text);
    const browser = this.mode === "browser" || this.mode === "both";
    this.emit("speech", { text, url: `/api/tts/${path.split("/").pop()}`, at: Date.now(), browser } satisfies Speech);
    if (this.mode === "host" || this.mode === "both")
      await new Promise<void>((resolve) => execFile("afplay", [path], () => resolve()));
  }

  private file(text: string) {
    let file = this.files.get(text);
    if (!file) {
      file = this.synthesize(text);
      this.files.set(text, file);
      file.catch(() => this.files.delete(text));
    }
    return file;
  }

  private async synthesize(text: string) {
    const hash = createHash("sha1").update(`${this.voiceId}|${this.model}|${text}`).digest("hex").slice(0, 16);
    const path = join(this.dir, `${hash}.mp3`);
    if (existsSync(path)) return path;
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0 },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    return path;
  }
}
