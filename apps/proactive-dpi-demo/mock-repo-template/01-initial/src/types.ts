export type LoyaltyTier = "silver" | "gold" | "platinum";

export type Customer = {
  id: string;
  /** Guests check out without an account and never have loyalty data. */
  guest: boolean;
  region: string;
  loyalty?: { tier: LoyaltyTier; points: number };
};

export type CartItem = { sku: string; name: string; unitCents: number; quantity: number };

export type Cart = { id: string; currency: "USD"; items: CartItem[] };

export type PricedCart = {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

export type CheckoutRequest = { cart: Cart; customer: Customer; paymentToken: string };
