// Compile-time proof that pi-durable's agent events still fit the SDK's wire contract.
// If a pi-durable upgrade changes these shapes, `npm run check` fails here.
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { WireAgentEvent, WireSnapshotEvent } from "../../dpi-sdk/src/api.js";

export const agentEventFits = (e: AgentEvent): WireAgentEvent => e;
export const snapshotFits = (e: SnapshotEvent): WireSnapshotEvent => e;
