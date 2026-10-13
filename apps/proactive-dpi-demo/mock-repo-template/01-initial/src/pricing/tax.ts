const FLAT_RATE = 0.08;

export function taxFor(_region: string, taxableCents: number): number {
  return Math.round(taxableCents * FLAT_RATE);
}
