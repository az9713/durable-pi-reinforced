import type { Customer, LoyaltyTier } from "../types.ts";

const TIER_RATES: Record<LoyaltyTier, number> = {
  silver: 0.03,
  gold: 0.05,
  platinum: 0.08,
};

/** Discount in cents for a loyalty member's order. */
export function loyaltyDiscount(customer: Customer, subtotalCents: number): number {
  const rate = TIER_RATES[customer.loyalty!.tier];
  return Math.round(subtotalCents * rate);
}
