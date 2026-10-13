import { test } from "node:test";
import assert from "node:assert/strict";
import { priceCart, subtotal } from "../src/pricing/cart.ts";
import type { Cart, Customer } from "../src/types.ts";

const cart: Cart = {
  id: "cart_1",
  currency: "USD",
  items: [
    { sku: "lamp-01", name: "Desk lamp", unitCents: 4500, quantity: 2 },
    { sku: "bulb-04", name: "LED bulb", unitCents: 1000, quantity: 1 },
  ],
};

const customer: Customer = {
  id: "cus_1",
  guest: false,
  region: "us-tx",
  loyalty: { tier: "gold", points: 1200 },
};

test("sums line items", () => {
  assert.equal(subtotal(cart), 10000);
});

test("total is subtotal minus discount plus tax", () => {
  const priced = priceCart(cart, customer);
  assert.equal(priced.totalCents, priced.subtotalCents - priced.discountCents + priced.taxCents);
});
