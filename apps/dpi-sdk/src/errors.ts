import type { ErrorCode } from "./api.js";

/** Every client-side failure: `offline` when the device can't be reached, otherwise the server's error code. */
export class DpiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 0,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DpiError";
  }
}

export const isDpiError = (e: unknown): e is DpiError => e instanceof DpiError;
