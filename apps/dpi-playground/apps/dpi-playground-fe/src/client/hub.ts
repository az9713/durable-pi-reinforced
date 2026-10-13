// Commands. Device calls go through the hub proxy (it injects the token, so the browser never
// holds one); status checks and UI state go to the hub itself.
import { DpiClient } from "@sdk/client";
import { DpiError } from "@sdk/errors";
import type { ErrorCode, NetworkDevice } from "@sdk/api";

export const deviceClient = (id: string) => new DpiClient(`/api/devices/${encodeURIComponent(id)}`);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => undefined);
  if (!r.ok) {
    const error = (data as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
    throw new DpiError(
      error?.code ?? "internal",
      error?.message ?? `${r.status} ${r.statusText}`,
      r.status,
    );
  }
  return data as T;
}

export const hub = {
  network: () => call<{ configFile?: string; devices: NetworkDevice[] }>("GET", "/network"),
  /** Probe a device now. Devices themselves are configured in dpi-network.yaml, not here. */
  check: (id: string) =>
    call<NetworkDevice>("POST", `/devices/${encodeURIComponent(id)}/check`, {}),
  async uiGet<T>(key: string): Promise<T | undefined> {
    return ((await call<{ value: T | null }>("GET", `/ui-state/${encodeURIComponent(key)}`))
      .value ?? undefined) as T | undefined;
  },
  uiSet: (key: string, value: unknown) =>
    call<{ ok: true }>("PUT", `/ui-state/${encodeURIComponent(key)}`, { value }),
};

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
