# Manifest payments function (Appwrite) — Revolut reference

The server half of the Manifest `payments` plugin. It speaks the one contract the
client plugin (`x-pay` / `$pay`) talks to, and keeps every secret server-side:

| Endpoint | Purpose |
|---|---|
| `POST /` | Create a checkout for an opaque `ref` → `{mode:'redirect',url}` or `{mode:'overlay',provider,params}`. Requires a signed-in workspace; answers the `portal` ref explicitly (Revolut has none). |
| `POST /webhook` | Verify the provider's signed webhook, then grant (idempotently) on `ORDER_COMPLETED` or revoke on `DISPUTE_LOST` |
| `POST /consume` | Burn credits (pay-as-you-go) — server-to-server, guarded by `PAYMENTS_CONSUME_KEY` |
| `GET /state?workspace=…` | Return the workspace's entitlement record for `$pay.state` |

`ref` is opaque to the client — **all pricing and commerce semantics live here**, in
`src/entitlements.js` (`PRODUCTS`). Pricing is server-authoritative: the client's
amount is never trusted.

## Files

- `src/entitlements.js` — your catalogue (`PRODUCTS`), entitlement + credit-ledger logic *(pure, tested)*
- `src/revolut.js` — Revolut Merchant adapter: create/retrieve order, webhook signature verify *(tested)*
- `src/fulfillment.js` — checkout building + webhook fulfillment *(tested)*
- `src/store.js` — in-memory store (tests/local)
- `src/store.appwrite.js` — production store (Appwrite Databases)
- `src/main.js` — Appwrite Function entrypoint (routes the 3 endpoints)

Swap providers by writing a sibling of `revolut.js` (same `createOrder` / `verifySignature`
shape) — the contract and fulfillment logic are provider-agnostic.

## Deploy (Appwrite)

1. Create two Appwrite collections:
   - **entitlements**: `workspace_id` (string, indexed), `plan` (string), `status` (string), `period_end` (string), `credits` (integer).
   - **credit_ledger**: `workspace_id`, `delta` (integer), `reason`, `ref`, `orderId` (indexed — it's the webhook-idempotency key), `ts`.
2. Create an Appwrite Function (Node runtime), point it at this folder, set entrypoint `src/main.js`, run `npm install`.
3. Set env vars:
   ```
   REVOLUT_SECRET_KEY=…          # Merchant API secret (sandbox to start)
   REVOLUT_WEBHOOK_SECRET=…      # from Revolut "Create webhook"
   PAYMENTS_ENV=sandbox          # sandbox | live
   PAYMENTS_SUCCESS_URL=https://yourapp/checkout-complete?checkout=1
   PAYMENTS_CONSUME_KEY=…        # any long random string; guards POST /consume
   APPWRITE_ENDPOINT=…  APPWRITE_PROJECT=…  APPWRITE_API_KEY=…
   PAY_DATABASE_ID=…  PAY_ENTITLEMENTS_COLLECTION=entitlements  PAY_LEDGER_COLLECTION=credit_ledger
   ```
4. Register the webhook via the **Merchant API** (there is no dashboard UI for this):
   `POST /api/1.0/webhooks` with `{ url: "https://<fn-url>/webhook", events: ["ORDER_COMPLETED", "DISPUTE_LOST"] }`
   — use `createWebhook()` from `revolut.js`. The response's **`signing_secret`** is your
   `REVOLUT_WEBHOOK_SECRET`. (Verified live: orders are under `/api/orders`, webhooks under `/api/1.0/webhooks`.)
5. Point your `manifest.json` at the function:
   ```json
   "payments": { "provider": "revolut", "endpoint": "https://<fn-url>", "state": { "url": "https://<fn-url>/state" } }
   ```

## Test

Pure logic + adapter (signature, pricing, fulfillment) is covered by
`tests/payments-function.test.js` in the repo root (`npm test`). Live sandbox
verification needs a Revolut Merchant sandbox key + webhook secret.
