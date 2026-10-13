const REGION_RATES: Record<string, number> = {
  "us-ca": 0.0725,
  "us-ny": 0.04,
  "us-tx": 0.0625,
  "us-wa": 0.065,
};
const DEFAULT_RATE = 0.06;

export function taxRate(region: string): number {
  return REGION_RATES[region] ?? DEFAULT_RATE;
}

export function taxFor(region: string, taxableCents: number): number {
  return Math.round(taxableCents * taxRate(region));
}
