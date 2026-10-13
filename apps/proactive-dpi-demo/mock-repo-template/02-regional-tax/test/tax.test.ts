import { test } from "node:test";
import assert from "node:assert/strict";
import { taxFor } from "../src/pricing/tax.ts";

test("uses the regional rate", () => {
  assert.equal(taxFor("us-ca", 10000), 725);
});

test("falls back to the default rate", () => {
  assert.equal(taxFor("eu-de", 10000), 600);
});
