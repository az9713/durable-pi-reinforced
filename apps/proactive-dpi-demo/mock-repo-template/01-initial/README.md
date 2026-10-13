# checkout-api

Lumen Market checkout service. Prices a cart, charges the payment token, and returns an order.

Deployed to Cloud Run as `checkout-api` in `lumen-market-prod` (`us-central1`).

```bash
npm start   # node src/server.ts on PORT (default 8080)
npm test    # node --test, no dependencies
```

| Path | Role |
| --- | --- |
| `src/server.ts` | HTTP entry point. `POST /v1/checkout` |
| `src/routes/checkout.ts` | Validates the request, prices the cart, charges payment |
| `src/pricing/` | Subtotal, discounts, and tax |
| `src/payments/charge.ts` | Payment provider client |
| `test/` | `node:test` suites |

Customers are either signed-in members or guests (`guest: true`). Guests check out without an account.
