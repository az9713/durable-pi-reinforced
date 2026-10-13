import { test } from "node:test";
import assert from "node:assert/strict";
import { loyaltyDiscount } from "../src/pricing/loyalty.ts";
import type { Customer, LoyaltyTier } from "../src/types.ts";

const member = (tier: LoyaltyTier): Customer => ({
  id: "cus_9",
  guest: false,
  region: "us-ca",
  loyalty: { tier, points: 500 },
});

test("silver members get 3% off", () => {
  assert.equal(loyaltyDiscount(member("silver"), 10000), 300);
});

test("gold members get 5% off", () => {
  assert.equal(loyaltyDiscount(member("gold"), 10000), 500);
});

test("platinum members get 8% off", () => {
  assert.equal(loyaltyDiscount(member("platinum"), 10000), 800);
});
