import type { CheckoutRequest } from "../types.ts";
import { charge } from "../payments/charge.ts";
import { priceCart } from "../pricing/cart.ts";

export type CheckoutResponse =
  | { status: 200; body: { orderId: string; totalCents: number } }
  | { status: 400 | 402; body: { error: string } };

export async function handleCheckout(request: CheckoutRequest): Promise<CheckoutResponse> {
  if (!request.cart?.items?.length) return { status: 400, body: { error: "empty_cart" } };
  if (!request.customer) return { status: 400, body: { error: "missing_customer" } };

  const priced = priceCart(request.cart, request.customer);
  const payment = await charge(request.paymentToken, priced.totalCents);
  if (!payment.ok) return { status: 402, body: { error: payment.declineCode } };

  return { status: 200, body: { orderId: payment.orderId, totalCents: priced.totalCents } };
}
