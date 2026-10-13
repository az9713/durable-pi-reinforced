// Randomized Lumen Market production traffic, written as Cloud Run log entries.
// Routine warnings stay in for realism; the only failures are the ones a bad deploy causes.
import { randomBytes, randomInt } from "node:crypto";
import type { LogEntry, Severity } from "../../../shared/types.ts";
import type { Revision } from "./deploys.ts";

export type Generated = {
  entry: LogEntry;
  service: string;
  revision: string;
  method: string | null;
  route: string | null;
  status: number | null;
  latencyMs: number | null;
  message: string;
  errorType: string | null;
};

const PROJECT = "lumen-market-prod";
const REGION = "us-central1";
const HOST = "https://api.lumen.market";
const REVISIONS: Record<string, string> = {
  "catalog-api": "catalog-api-00187-qaz",
  "cart-api": "cart-api-00093-lop",
  "auth-api": "auth-api-00051-tiv",
  "payments-webhook": "payments-webhook-00022-fen",
};
const PRODUCTS = [
  { sku: "lamp-01", name: "Arc desk lamp", unitCents: 4500, category: "lighting" },
  { sku: "bulb-04", name: "Warm LED bulb", unitCents: 899, category: "lighting" },
  { sku: "mug-12", name: "Stoneware mug", unitCents: 1800, category: "kitchen" },
  { sku: "kettle-02", name: "Pour-over kettle", unitCents: 6400, category: "kitchen" },
  { sku: "rug-07", name: "Wool runner rug", unitCents: 12900, category: "home" },
  { sku: "throw-03", name: "Linen throw", unitCents: 7200, category: "home" },
  { sku: "plant-09", name: "Ceramic planter", unitCents: 3100, category: "garden" },
];
const REGIONS = ["us-ca", "us-ny", "us-tx", "us-wa", "us-il", "us-fl"];
const TIERS = ["silver", "gold", "platinum"] as const;
const AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
  "LumenMarket/4.12.0 (Android 16; Pixel 10)",
];

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const pick = <T>(items: readonly T[]) => items[randomInt(items.length)];
const between = (low: number, high: number) => Math.round(low + Math.random() * (high - low));
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const ip = () => `${between(23, 223)}.${between(0, 255)}.${between(0, 255)}.${between(1, 254)}`;

type Base = {
  service: string;
  revision: string;
  severity: Severity;
  stream: "requests" | "stdout" | "stderr" | "varlog/system";
  message: string;
  payload?: Record<string, unknown>;
  http?: { method: string; route: string; path: string; status: number; latencyMs: number };
  errorType?: string;
  labels?: Record<string, string>;
};

function build(base: Base, now = new Date()): Generated {
  const entry: LogEntry = {
    insertId: hex(12),
    logName: `projects/${PROJECT}/logs/run.googleapis.com%2F${base.stream.replace("/", "%2F")}`,
    resource: {
      type: "cloud_run_revision",
      labels: {
        project_id: PROJECT,
        service_name: base.service,
        revision_name: base.revision,
        configuration_name: base.service,
        location: REGION,
      },
    },
    timestamp: now.toISOString(),
    receiveTimestamp: new Date(now.getTime() + between(40, 400)).toISOString(),
    severity: base.severity,
    labels: { instanceId: `00${hex(14)}`, ...base.labels },
    trace: `projects/${PROJECT}/traces/${hex(16)}`,
    spanId: hex(8),
    jsonPayload: { message: base.message, ...base.payload },
  };
  if (base.http)
    entry.httpRequest = {
      requestMethod: base.http.method,
      requestUrl: `${HOST}${base.http.path}`,
      status: base.http.status,
      responseSize: String(between(120, 18000)),
      userAgent: pick(AGENTS),
      remoteIp: ip(),
      latency: `${(base.http.latencyMs / 1000).toFixed(6)}s`,
      protocol: "HTTP/1.1",
    };
  return {
    entry,
    service: base.service,
    revision: base.revision,
    method: base.http?.method ?? null,
    route: base.http?.route ?? null,
    status: base.http?.status ?? null,
    latencyMs: base.http?.latencyMs ?? null,
    message: base.message,
    errorType: base.errorType ?? null,
  };
}

function request(
  service: string,
  method: string,
  route: string,
  path: string,
  status: number,
  latencyMs: number,
  message: string,
  payload?: Record<string, unknown>,
): Generated {
  const severity: Severity = status >= 500 ? "ERROR" : status === 429 ? "WARNING" : "INFO";
  return build({
    service,
    revision: REVISIONS[service],
    severity,
    stream: "requests",
    message,
    payload,
    http: { method, route, path, status, latencyMs },
  });
}

function randomCart() {
  const items = Array.from({ length: between(1, 3) }, () => {
    const product = pick(PRODUCTS);
    return { sku: product.sku, name: product.name, unitCents: product.unitCents, quantity: between(1, 2) };
  });
  return { id: `cart_${hex(3)}`, currency: "USD" as const, items };
}

async function checkout(revision: Revision, kind: "member" | "guest" | "decline"): Promise<Generated> {
  const region = pick(REGIONS);
  const tier = pick(TIERS);
  const customer =
    kind === "guest"
      ? { id: `gst_${hex(4)}`, guest: true, region }
      : { id: `cus_${hex(4)}`, guest: false, region, loyalty: { tier, points: between(80, 9000) } };
  const cart = randomCart();
  const paymentToken = kind === "decline" ? `tok_decline_${hex(3)}` : `tok_${hex(6)}`;
  const who = customer.guest ? "guest" : `member tier=${tier}`;
  const http = { method: "POST", route: "/v1/checkout", path: "/v1/checkout" };
  const base = { service: "checkout-api", revision: revision.name, labels: { commit_sha: revision.commit } };
  try {
    const result = await revision.handleCheckout({ cart, customer, paymentToken });
    const total = Number(result.body.totalCents ?? 0);
    const message =
      result.status === 200
        ? `checkout completed order=${result.body.orderId} total=${dollars(total)} items=${cart.items.length} customer=${who}`
        : `payment declined code=${result.body.error} items=${cart.items.length} customer=${who}`;
    return build({
      ...base,
      severity: "INFO",
      stream: "requests",
      message,
      payload: { customer: { guest: customer.guest, region }, cart: { id: cart.id, items: cart.items.length } },
      http: { ...http, status: result.status, latencyMs: between(140, 420) },
    });
  } catch (error) {
    const err = error as Error;
    return build({
      ...base,
      severity: "ERROR",
      stream: "stderr",
      message: "Unhandled exception in checkout handler",
      errorType: err.name,
      payload: {
        error: { type: err.name, message: err.message },
        stack_trace: revision.containerStack(err.stack ?? String(err)),
        customer: { guest: customer.guest, region },
        cart: { id: cart.id, items: cart.items.length },
      },
      http: { ...http, status: 500, latencyMs: between(8, 40) },
    });
  }
}

export const guestCheckout = (revision: Revision) => checkout(revision, "guest");

type Scenario = [weight: number, make: (checkoutRevision: Revision) => Generated | Promise<Generated>];

const SCENARIOS: Scenario[] = [
  [9, (rev) => checkout(rev, "member")],
  [6, (rev) => checkout(rev, "guest")],
  [1.5, (rev) => checkout(rev, "decline")],
  [
    12,
    () => {
      const category = pick(PRODUCTS).category;
      return request("catalog-api", "GET", "/v1/products", `/v1/products?category=${category}`, 200, between(18, 95), `listed ${between(8, 40)} products category=${category} cache=${Math.random() < 0.7 ? "hit" : "miss"}`);
    },
  ],
  [
    8,
    () => {
      const product = pick(PRODUCTS);
      return request("catalog-api", "GET", "/v1/products/:sku", `/v1/products/${product.sku}`, 200, between(12, 70), `product sku=${product.sku} stock=${between(0, 60)}`);
    },
  ],
  [
    1.5,
    () => {
      const sku = `${pick(["lamp", "mug", "rug", "desk"])}-${between(40, 99)}`;
      return request("catalog-api", "GET", "/v1/products/:sku", `/v1/products/${sku}`, 404, between(9, 30), `product not found sku=${sku}`);
    },
  ],
  [
    5,
    () =>
      build({
        service: "catalog-api",
        revision: REVISIONS["catalog-api"],
        severity: "DEBUG",
        stream: "stdout",
        message: `cache hit key=products:category=${pick(PRODUCTS).category} ttl=${between(30, 300)}s`,
      }),
  ],
  [
    0.5,
    () =>
      build({
        service: "catalog-api",
        revision: REVISIONS["catalog-api"],
        severity: "WARNING",
        stream: "stdout",
        message: `slow query ${between(1400, 2600)}ms: SELECT * FROM products WHERE category = $1 ORDER BY popularity DESC`,
        payload: { db: { pool: "catalog-primary", waiting: between(0, 4) } },
      }),
  ],
  [
    0.5,
    () => request("catalog-api", "GET", "/v1/products", "/v1/products?page=" + between(30, 90), 429, between(2, 9), `rate limited client=scraper-bot/2.1 limit=120/min`),
  ],
  [
    8,
    () => {
      const product = pick(PRODUCTS);
      return request("cart-api", "POST", "/v1/cart/items", "/v1/cart/items", 201, between(25, 110), `added sku=${product.sku} qty=${between(1, 3)} cart=cart_${hex(3)}`);
    },
  ],
  [
    2,
    () => {
      const product = pick(PRODUCTS);
      return request("cart-api", "DELETE", "/v1/cart/items/:sku", `/v1/cart/items/${product.sku}`, 204, between(20, 80), `removed sku=${product.sku} cart=cart_${hex(3)}`);
    },
  ],
  [
    0.5,
    () =>
      build({
        service: "cart-api",
        revision: REVISIONS["cart-api"],
        severity: "WARNING",
        stream: "stdout",
        message: `inventory-service timeout after 2000ms, retry 1/3 succeeded sku=${pick(PRODUCTS).sku}`,
      }),
  ],
  [
    6,
    () => request("auth-api", "POST", "/v1/sessions", "/v1/sessions", 200, between(60, 180), `session created user=cus_${hex(4)} method=${pick(["password", "passkey", "google"])}`),
  ],
  [
    2,
    () => request("auth-api", "POST", "/v1/sessions/refresh", "/v1/sessions/refresh", 401, between(8, 25), `session token expired user=cus_${hex(4)}`),
  ],
  [
    5,
    () => request("payments-webhook", "POST", "/webhooks/payments", "/webhooks/payments", 200, between(15, 60), `event=payment_intent.succeeded order=ord_${hex(3)} amount=${dollars(between(900, 32000))}`),
  ],
  [
    0.6,
    () => {
      const service = pick(Object.keys(REVISIONS));
      return build({
        service,
        revision: REVISIONS[service],
        severity: "INFO",
        stream: "varlog/system",
        message: Math.random() < 0.5 ? `Container instance started in ${between(280, 900)}ms` : `Autoscaling: ${service} instances ${between(2, 4)} → ${between(3, 6)}`,
      });
    },
  ],
];
const TOTAL_WEIGHT = SCENARIOS.reduce((sum, [weight]) => sum + weight, 0);

export async function nextEvent(checkoutRevision: Revision): Promise<Generated> {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const [weight, make] of SCENARIOS) {
    roll -= weight;
    if (roll <= 0) return make(checkoutRevision);
  }
  return SCENARIOS[0][1](checkoutRevision);
}

/** The two system rows Cloud Run writes when a new revision takes traffic. */
export function deployEvents(from: Revision, to: Revision): Generated[] {
  const base = { service: "checkout-api", stream: "varlog/system" as const, severity: "NOTICE" as const };
  return [
    build({
      ...base,
      revision: from.name,
      message: `Deploying revision ${to.name} (commit ${to.commit} "${to.subject}")`,
      payload: { deploy: { from: from.name, to: to.name, commit: to.commit } },
    }),
    build({
      ...base,
      revision: to.name,
      labels: { commit_sha: to.commit },
      message: `Revision ${to.name} is ready. Routing 100% of traffic.`,
    }),
  ];
}
