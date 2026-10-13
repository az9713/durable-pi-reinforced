import { DpiError } from "./errors.js";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Parse a Server-Sent Events body from fetch. Servers send a `: ping` comment every 15s, so
 * `idleMs` of silence means a half-open socket and ends the stream with an `offline` error.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  idleMs = 45_000,
): AsyncGenerator<SseMessage> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = "";
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DpiError("offline", `No data for ${idleMs / 1000}s`)),
          idleMs,
        );
      });
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) return;
      buffer += chunk.value.replaceAll("\r\n", "\n");
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const message = parseBlock(block);
        if (message) yield message;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function parseBlock(block: string): SseMessage | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  return data.length ? { event, data: data.join("\n"), id } : undefined;
}
