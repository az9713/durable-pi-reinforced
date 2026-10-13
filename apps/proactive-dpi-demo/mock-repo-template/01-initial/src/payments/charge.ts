export type ChargeResult = { ok: true; orderId: string } | { ok: false; declineCode: string };

/** Payment provider client. Test tokens starting with `tok_decline` are declined. */
export async function charge(paymentToken: string, amountCents: number): Promise<ChargeResult> {
  if (amountCents <= 0) return { ok: false, declineCode: "invalid_amount" };
  if (paymentToken.startsWith("tok_decline")) return { ok: false, declineCode: "card_declined" };
  return { ok: true, orderId: `ord_${paymentToken.slice(-6)}` };
}
