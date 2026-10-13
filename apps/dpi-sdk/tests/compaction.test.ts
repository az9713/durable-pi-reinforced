import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionFits, compactionThresholds, DEFAULT_COMPACTION, defaultCompaction } from "../src/api.js";

test("compaction defaults sit at 200k and 250k, and fall back to pi-durable's margins on small windows", () => {
  assert.deepEqual(compactionThresholds(1_000_000, defaultCompaction(1_000_000)), { auto: 200_000, wait: 250_000 });
  assert.deepEqual(compactionThresholds(500_000, defaultCompaction(500_000)), { auto: 200_000, wait: 250_000 });
  assert.deepEqual(defaultCompaction(128_000), DEFAULT_COMPACTION);
  assert.deepEqual(compactionThresholds(200_000, defaultCompaction(200_000)), { auto: 150_848, wait: 183_616 });
  assert.deepEqual(defaultCompaction(0), DEFAULT_COMPACTION);
  // A 1M model's thresholds leave a 500k model no room, so a switch to it refits them.
  assert.equal(compactionFits(500_000, defaultCompaction(1_000_000)), false);
  assert.equal(compactionFits(1_000_000, defaultCompaction(500_000)), true);
});
