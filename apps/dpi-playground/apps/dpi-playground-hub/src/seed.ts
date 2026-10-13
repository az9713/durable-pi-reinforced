// At boot: load dpi-network.yaml (if any) into the registry. The UI never edits devices;
// `just net register <id>` sets their tokens.
import { tryLoadNetworkConfig, syncConfigToRegistry } from "../../../../dpi-sdk/src/node/config.js";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";

export function seedFromConfig(registry: NetworkRegistry, start: string) {
  const config = tryLoadNetworkConfig(start);
  if (!config) return undefined;
  syncConfigToRegistry(config, registry);
  return config.file;
}
