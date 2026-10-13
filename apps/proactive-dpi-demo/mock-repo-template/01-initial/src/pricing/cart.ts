import type { Cart, Customer, PricedCart } from "../types.ts";
import { taxFor } from "./tax.ts";

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}

export function priceCart(cart: Cart, customer: Customer): PricedCart {
  const subtotalCents = subtotal(cart);
  const discountCents = 0;
  const taxCents = taxFor(customer.region, subtotalCents - discountCents);
  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}
