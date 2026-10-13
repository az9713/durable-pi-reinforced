#!/usr/bin/env node
// Run the TypeScript entry through tsx so `npm link` / `npx dpi-tui` work without a build step.
import { register } from "tsx/esm/api";
register();
await import("../src/main.ts");
