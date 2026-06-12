# Payments

Integrate payment providers with your project.

---

## Overview

The payments plugin connects your project to any payment provider, which are processors like <a href="https://stripe.com" target="_blank" rel="noopener">Stripe</a> or <a href="https://www.revolut.com/business/merchant-accounts/" target="_blank" rel="noopener">Revolut</a>, and merchants of record like <a href="https://www.paddle.com" target="_blank" rel="noopener">Paddle</a> or <a href="https://www.lemonsqueezy.com" target="_blank" rel="noopener">Lemon Squeezy</a> that also handle sales tax for you. Buyers check out on the provider's secure page or in a popup over yours, and your project never sees card numbers or secret keys.

There are two ways to use it. **Payment links** simply send buyers to a checkout or donation page you already have, with no backend needed. **Full checkout** adds a small [payment function](#payment-function) so you can sell by product name, confirm payments reliably, and unlock features the moment someone pays.

---

## Setup

The payments plugin is included in `manifest.js` with all core plugins, or can be selectively loaded. It activates when `manifest.json` contains a `payments` block, or whenever it's declared in `data-plugins`.

<div x-code-group copy>

```html "All Plugins (default)"
<!-- Meta -->
<link rel="manifest" href="/manifest.json">

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Selective"
<!-- Meta -->
<link rel="manifest" href="/manifest.json">

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
    data-plugins="payments"></script>
```

</div>

---

## Payment Links

The simplest checkout is a link. Most providers let you create a hosted payment page in their dashboard — a Stripe payment link, a Revolut payment link, a Patreon or Buy Me a Coffee page — and `x-pay` sends the buyer straight to it. Alternatively, just use regular `<a href="...">` links.

```html "HTML" copy
<button x-pay="'https://buy.stripe.com/your-link'">Buy now</button>

<a x-pay="'https://patreon.com/yourpage'">Become a patron</a>
<a x-pay="'https://buymeacoffee.com/yourpage'">Buy me a coffee</a>
```

This needs no configuration and no backend; any absolute URL just navigates. It suits donations, tips, community memberships, and one-off products where the provider's dashboard tells you who paid.

---

## Full Checkouts

Full checkouts allow your project to communicate with the payment solution.

### Configuration

Register the payment provider in `manifest.json` under a `payments` block, pointing at your payment function.

```json "manifest.json" copy
{
    "payments": {
        "provider": "revolut",
        "endpoint": "https://your-function-url",
        "state": { "url": "https://your-function-url/state" }
    }
}
```

| Property | Default | Description |
|---|---|---|
| `provider`{copy} | – | Your payment provider. Built in: `stripe`, `paypal`, `square`, `braintree`, `adyen`, `mollie`, `revolut`, `paddle`, `lemonsqueezy`, `polar`, `razorpay` — or any name you register a [custom adapter](#providers) for. Five of these support popup checkouts; the rest use the provider's hosted page. |
| `endpoint`{copy} | – | Your payment function's URL. Creates checkouts and confirms payments. |
| `mode`{copy} | `"redirect"` | Preferred checkout style: `redirect` (provider's page) or `overlay` (popup). |
| `publicKey`{copy} | – | A publishable key, if your provider's popup needs one. Safe to commit. |
| `state.url`{copy} | – | Where to read payment state for `$pay.state`. Appwrite projects can use [databases](/docs/appwrite-plugins/databases) and `$x` instead. |

::: brand icon="lucide:info"
Your provider's <b>secret key</b> never goes in `manifest.json`, HTML, or anywhere else a browser can see. It lives only in the payment function's environment variables.
:::

---

## Start a Checkout

Add `x-pay` to any element with a product reference, with the value being a transaction name like `pro-upgrade` or `credits-1000` that you define in your payment function (alongside its real price). Clicking it opens the provider's checkout UI. The frame below runs against a demo provider — no real charges; popup purchases grant credits instantly, and redirect buttons report their destination instead of leaving the page.

<div x-code-group copy>

```html "HTML"
<button x-pay="'pro-upgrade'">Upgrade to Pro</button>
<button x-pay.overlay="'credits-1000'">Buy 1,000 credits</button>
<button class="outlined" x-pay.portal>Manage billing</button>

<p>
    Plan: <b x-text="$pay.state?.plan ?? '—'"></b> ·
    Credits: <b x-text="$pay.state?.credits ?? '—'"></b>
</p>
<small x-show="$pay.last?.url">Would open: <code x-text="$pay.last?.url"></code></small>
```

```js "Function"
// The refs your buttons use, defined server-side with their REAL prices.
// (See Payment Function below for the full main.js snippet)

const PRODUCTS = {
    'pro-upgrade':  { price: { amount: 4900, currency: 'USD' }, grant: { type: 'plan', plan: 'pro', credits: 1000 } },
    'credits-1000': { price: { amount: 500, currency: 'USD' }, grant: { type: 'credits', amount: 1000 } }
}

// POST { ref, context } → look up the price, create the provider checkout
const { ref, context } = JSON.parse(req.bodyRaw)
const product = PRODUCTS[ref]
if (!product) return res.json({ error: 'unknown ref' }, 400)

const order = await createProviderOrder(product.price, {
    workspace_id: context?.workspaceId, ref
})
return res.json({ mode: 'redirect', url: order.checkout_url })
```

```json "manifest.json"
{
    "payments": {
        "provider": "revolut",
        "endpoint": "https://your-function-url",
        "state": { "url": "https://your-function-url/state" }
    }
}
```

::: frame col gap-3
<div class="row-wrap gap-2">
    <button x-pay="'pro-upgrade'">Upgrade to Pro</button>
    <button x-pay.overlay="'credits-1000'">Buy 1,000 credits</button>
    <button class="outlined" x-pay.portal>Manage billing</button>
</div>
<p>
    Plan: <b x-text="$pay.state?.plan ?? '—'"></b> ·
    Credits: <b x-text="$pay.state?.credits ?? '—'"></b>
</p>
<small x-show="$pay.last?.url">Would open: <code x-text="$pay.last?.url"></code></small>
:::

</div>

Because prices live in the function, nothing on the page can be tampered with — the browser only ever mentions the product by name. The same buttons work for any provider and either checkout style; switching is a configuration change, never an HTML change.

| Modifier | Description |
|---|---|
| `x-pay.overlay`{copy} | Ask for a popup checkout over the current page. |
| `x-pay.redirect`{copy} | Ask for the provider's hosted checkout page. |
| `x-pay.portal`{copy} | Open the provider's billing portal instead of a checkout. Provider-dependent: Stripe, Paddle, Lemon Squeezy, and Polar host one; Revolut doesn't, and the template answers with a clear error. |

Checkouts can also start from any Alpine expression using the `$pay` magic method, with an optional payload your function receives:

<div x-code-group copy>

```html "HTML"
<button @click="$pay('donate-25', { campaign: 'spring' })">Donate $25</button>
```

```js "Function"
// The payload arrives alongside the ref — read it however you like.
const { ref, payload, context } = JSON.parse(req.bodyRaw)

const PRODUCTS = {
    'donate-25': { price: { amount: 2500, currency: 'USD' }, grant: { type: 'credits', amount: 0 } }
}
const product = PRODUCTS[ref]

const order = await createProviderOrder(product.price, {
    workspace_id: context?.workspaceId, ref,
    campaign: payload?.campaign
})
return res.json({ mode: 'redirect', url: order.checkout_url })
```

::: frame col gap-2
<button @click="$pay('donate-25', { campaign: 'spring' })">Donate $25</button>
<small x-show="$pay.last?.url">Would open: <code x-text="$pay.last?.url"></code></small>
:::

</div>

If the signed-in user and active team are available from [auth](/docs/appwrite-plugins/auth), the plugin sends them along automatically — so your function knows which account to credit without extra wiring. The payload also suits quantities, coupon codes, or anything else your function wants at checkout time — it travels as-is.

::: brand icon="lucide:info"
Full checkouts need a <b>signed-in buyer</b> — the grant is credited to their workspace, so the function refuses anonymous checkouts rather than taking money it can't assign. For anonymous purchases (donations, one-off sales), use [payment links](#payment-links). Buttons also handle themselves during a checkout: they disable while the flow opens (no double-charges from double-clicks), and failures surface automatically as a toast when the toasts plugin is loaded.
:::

---

## Payment State

`$pay.state` holds whatever record your payment function returns — plan, credits, or anything you define. Read it like any reactive value to gate features or show balances. In the frame below, the demo account is on the `pro` plan with a low balance — both lines react to the record.

<div x-code-group copy>

```html "HTML"
<div x-show="$pay.state?.plan === 'pro'">Welcome, Pro member!</div>

<p x-show="$pay.state?.credits < 50">
    Running low — <button x-pay="'credits-1000'">top up</button>
</p>
```

```js "Function"
// GET /state?workspace=… → whatever shape your pages want to read.
const workspace = req.query?.workspace
const e = workspace ? await getEntitlement(workspace) : null
return res.json(e ? { plan: e.plan, status: e.status, credits: e.credits } : {})
```

::: frame col gap-2
<div x-show="$pay.state?.plan === 'pro'">Welcome, Pro member!</div>
<p x-show="$pay.state?.credits < 50" class="row gap-2 items-center">
    Running low — <button x-pay="'credits-1000'">top up</button>
</p>
<small x-show="$pay.last?.url">Would open: <code x-text="$pay.last?.url"></code></small>
:::

</div>

| Property | Type | Description |
|---|---|---|
| `$pay(ref, payload?)`{copy} | method | Start a checkout. Returns a Promise. |
| `$pay.portal()`{copy} | method | Open the billing portal. |
| `$pay.refresh()`{copy} | method | Re-fetch `$pay.state` from your function. |
| `$pay.state`{copy} | reactive | Your function's payment record — shaped however you like. |
| `$pay.loading`{copy} | reactive | `true` while a checkout is opening. |
| `$pay.error`{copy} | reactive | The last error message, or `null`. |

Appwrite-enabled projects can skip `state.url` and store the payment record in a [database](/docs/appwrite-plugins/databases) instead. The function writes it, and your pages read it reactively through `$x` with realtime updates.

---

## Providers

Two checkout styles are supported, and every provider gets at least one:

- **Redirect** sends the buyer to the provider's hosted checkout page. Every provider with a hosted page works this way — including ones Manifest has never heard of.
- **Overlay** opens the provider's own popup over your page, for providers that offer one.

| Style | Providers |
|---|---|
| Overlay popup | `revolut`{copy}, `paddle`{copy}, `lemonsqueezy`{copy}, `polar`{copy}, `razorpay`{copy} |
| Redirect | `stripe`{copy}, `square`{copy}, `paypal`{copy}, `braintree`{copy}, `adyen`{copy}, `mollie`{copy}, and any provider with a hosted checkout |

If a popup isn't available, the plugin automatically falls back to redirect so clickthroughs never dead-end. Popup SDKs load on demand from the provider's own CDN — sites with a strict Content Security Policy should allow that provider's domain in `script-src`. Providers outside the list can add popup support without touching the framework:

```html "Custom overlay" copy
<script>
    document.addEventListener('alpine:init', () => {
        ManifestPaymentsAdapters.register('myprovider', {
            supportsOverlay: true,
            async open({ url, params, config }) {
                // open the provider's SDK popup, resolve when done
                return { status: 'complete' }
            }
        })
    })
</script>
```

---

## Payment Function

Real payments need one small piece of server code, because two things can never happen in a browser: creating a checkout with your secret key, and confirming that money actually arrived. The payment function does both.

Your function answers three requests:

| Request | Purpose |
|---|---|
| `POST /`{copy} | Turns a product reference into a checkout, using the real price from your product list. |
| `POST /webhook`{copy} | Receives the provider's signed payment confirmation and updates the buyer's record. |
| `GET /state`{copy} | Returns a payment record for `$pay.state`. |

The webhook deserves a plain-language note: when someone finishes paying, the provider's servers send your function a cryptographically signed message. That message — not the buyer returning to your site — is what the template trusts before granting anything. It's the difference between "the buyer's browser says they paid" and "the provider says they paid."

::: brand icon="lucide:wand-sparkles"
**Manifest AI can wire this up for you.** Projects connected to <a href="https://manifestx.dev" target="_blank" rel="noopener">Manifest AI</a> can skip the function entirely: ask for payments, share your provider key and product list, and it provisions a managed payment function — webhook registration included — and hands back the `payments` block for `manifest.json`.
:::

### Appwrite Template

Appwrite-enabled projects can use an <a href="https://appwrite.io/docs/products/functions" target="_blank" rel="noopener">Appwrite Function</a>. The template function below is complete and ready to deploy — edit `PRODUCTS` to match what you sell, deploy it as an Appwrite Function (Node runtime, `node-appwrite` dependency), and set the environment variables. The full multi-file template with tests lives in the <a href="https://github.com/Manifest-X/Manifest/tree/main/templates/payments-function" target="_blank" rel="noopener">Manifest repository</a>.

<div x-code-group lines collapse="10" copy>

```js "main.js"
import { Client, Databases, Query, ID } from 'node-appwrite'
import crypto from 'node:crypto'

// Your catalogue. Prices live HERE, server-side — the page only sends the ref.
// Grant types: `credits` tops up a balance; `plan` is a one-time unlock that
// can bundle credits. (True subscriptions need a provider with recurring
// billing — an MoR like Paddle or Polar, or Stripe. Revolut orders are
// one-time, so nothing here renews or expires.)
const PRODUCTS = {
    'credits-1000': { price: { amount: 500, currency: 'USD' }, grant: { type: 'credits', amount: 1000 } },
    'pro-upgrade':  { price: { amount: 4900, currency: 'USD' }, grant: { type: 'plan', plan: 'pro', credits: 1000 } }
}

const REVOLUT_BASE = process.env.PAYMENTS_ENV === 'live'
    ? 'https://merchant.revolut.com' : 'https://sandbox-merchant.revolut.com'
const HEADERS = {
    'Authorization': `Bearer ${process.env.REVOLUT_SECRET_KEY}`,
    'Revolut-Api-Version': '2024-09-01',
    'Content-Type': 'application/json'
}

function db() {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT)
        .setKey(process.env.APPWRITE_API_KEY)
    return new Databases(client)
}

async function getEntitlement(workspaceId) {
    const r = await db().listDocuments(process.env.PAY_DATABASE_ID, 'entitlements',
        [Query.equal('workspace_id', workspaceId), Query.limit(1)])
    return r.documents[0] || null
}

async function saveEntitlement(workspaceId, data) {
    const existing = await getEntitlement(workspaceId)
    if (existing) return db().updateDocument(process.env.PAY_DATABASE_ID, 'entitlements', existing.$id, data)
    return db().createDocument(process.env.PAY_DATABASE_ID, 'entitlements', ID.unique(), { workspace_id: workspaceId, ...data })
}

// Append-only audit trail. Doubles as the idempotency record: webhooks are
// delivered at-least-once, so "was this order already granted?" is answered
// by the ledger — a redelivered event must never grant twice.
async function addLedger(entry) {
    return db().createDocument(process.env.PAY_DATABASE_ID, 'ledger', ID.unique(), entry)
}

async function hasLedger(orderId, reason) {
    const queries = [Query.equal('order_id', orderId), Query.limit(1)]
    if (reason) queries.unshift(Query.equal('reason', reason))
    const r = await db().listDocuments(process.env.PAY_DATABASE_ID, 'ledger', queries)
    return r.documents.length > 0
}

// Verify Revolut's signature: HMAC-SHA256 over `v1.{timestamp}.{body}`.
function verifySignature(rawBody, signature, timestamp) {
    if (!signature || !timestamp) return false
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false
    const expected = 'v1=' + crypto.createHmac('sha256', process.env.REVOLUT_WEBHOOK_SECRET)
        .update(`v1.${timestamp}.${rawBody}`).digest('hex')
    return signature.split(/\s+/).some((sig) =>
        sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
}

export default async ({ req, res, log }) => {
    // 1. The provider's signed confirmations. ORDER_COMPLETED grants the
    //    workspace (once — the ledger dedupes redeliveries); DISPUTE_LOST
    //    means a chargeback was lost, so the same grant is reversed.
    if (req.method === 'POST' && req.path.endsWith('/webhook')) {
        const ok = verifySignature(req.bodyRaw,
            req.headers['revolut-signature'], req.headers['revolut-request-timestamp'])
        if (!ok) return res.json({ ok: false }, 401)

        const { event, order_id } = JSON.parse(req.bodyRaw)
        if (order_id && (event === 'ORDER_COMPLETED' || event === 'DISPUTE_LOST')) {
            const order = await (await fetch(`${REVOLUT_BASE}/api/orders/${order_id}`, { headers: HEADERS })).json()
            const { workspace_id, ref } = order.metadata || {}
            const grant = PRODUCTS[ref]?.grant
            if (workspace_id && grant) {
                const current = await getEntitlement(workspace_id)
                const credits = current?.credits || 0
                const amount = grant.amount || grant.credits || 0

                if (event === 'ORDER_COMPLETED' && !(await hasLedger(order_id))) {
                    await saveEntitlement(workspace_id, grant.type === 'credits'
                        ? { credits: credits + amount }
                        : { plan: grant.plan, status: 'active', credits: credits + amount })
                    await addLedger({ workspace_id, delta: amount, reason: grant.type === 'credits' ? 'topup' : 'grant', ref, order_id })
                    log(`granted ${ref} to ${workspace_id}`)
                }
                if (event === 'DISPUTE_LOST' && (await hasLedger(order_id)) && !(await hasLedger(order_id, 'refund'))) {
                    await saveEntitlement(workspace_id, grant.type === 'credits'
                        ? { credits: Math.max(0, credits - amount) }
                        : { plan: 'free', status: 'revoked', credits: Math.max(0, credits - amount) })
                    await addLedger({ workspace_id, delta: -amount, reason: 'refund', ref, order_id })
                    log(`revoked ${ref} from ${workspace_id}`)
                }
            }
        }
        return res.json({ ok: true })
    }

    // 2. Burn credits (pay-as-you-go). Server-to-server only: YOUR backend
    //    calls this with the shared key — never the browser, or buyers could
    //    skip the spend.
    if (req.method === 'POST' && req.path.endsWith('/consume')) {
        if (req.headers['x-consume-key'] !== process.env.PAYMENTS_CONSUME_KEY) {
            return res.json({ error: 'unauthorized' }, 401)
        }
        const { workspace, amount, reason } = JSON.parse(req.bodyRaw || '{}')
        const e = await getEntitlement(workspace)
        if (!e) return res.json({ error: 'unknown workspace' }, 404)
        if ((e.credits || 0) < amount) return res.json({ error: 'insufficient credits' }, 402)
        await saveEntitlement(workspace, { credits: e.credits - amount })
        await addLedger({ workspace_id: workspace, delta: -amount, reason: reason || 'usage' })
        return res.json({ ok: true, credits: e.credits - amount })
    }

    // 3. Turn a product ref into a checkout (price looked up server-side).
    //    Anonymous checkouts are refused: the grant needs a workspace to land
    //    in, so taking the money without one would lose the purchase.
    if (req.method === 'POST') {
        const { ref, context } = JSON.parse(req.bodyRaw || '{}')
        if (ref === 'portal') return res.json({ error: 'portal not available: Revolut has no customer portal' }, 400)
        if (!context?.workspaceId) return res.json({ error: 'sign in required' }, 401)
        const product = PRODUCTS[ref]
        if (!product) return res.json({ error: 'unknown ref' }, 400)
        const order = await (await fetch(`${REVOLUT_BASE}/api/orders`, {
            method: 'POST', headers: HEADERS,
            body: JSON.stringify({
                amount: product.price.amount, currency: product.price.currency,
                redirect_url: process.env.PAYMENTS_SUCCESS_URL,
                metadata: { workspace_id: context.workspaceId, ref }
            })
        })).json()
        if (context?.preferMode === 'overlay') {
            return res.json({ mode: 'overlay', provider: 'revolut', params: { token: order.token } })
        }
        return res.json({ mode: 'redirect', url: order.checkout_url })
    }

    // 4. The payment record for $pay.state. Readable by workspace id (an
    //    unguessable Appwrite team id) — treat its contents as non-secret.
    const workspace = req.query?.workspace
    const e = workspace ? await getEntitlement(workspace) : null
    return res.json(e ? { plan: e.plan, status: e.status, credits: e.credits } : {})
}
```

```env "Environment"
REVOLUT_SECRET_KEY=sk_…          # provider SECRET key (sandbox to start)
REVOLUT_WEBHOOK_SECRET=…         # returned when you register the webhook
PAYMENTS_ENV=sandbox             # sandbox | live
PAYMENTS_SUCCESS_URL=https://yourapp.com/thanks?checkout=1
PAYMENTS_CONSUME_KEY=…           # any long random string; guards POST /consume
APPWRITE_ENDPOINT=…
APPWRITE_PROJECT=…
APPWRITE_API_KEY=…
PAY_DATABASE_ID=…                # database with `entitlements` + `ledger` collections
```

</div>

This example uses <a href="https://help.revolut.com/business/help/merchant-accounts/setting-up-a-merchant-account/what-is-a-merchant-account/" target="_blank" rel="noopener">Revolut Merchant</a>, verified end-to-end against its sandbox. The structure is the same for any provider — swap the two `fetch` calls and the signature check for your provider's equivalents, and the rest (products, grants, state) is untouched. On the page, every provider already works: popups for the five built-in adapters, hosted redirect for everything else.

---

## Returning from Checkout

After a checkout redirect, the provider sends the buyer back to a success URL you choose. Add `checkout=1` to it — when the buyer lands, the plugin refreshes `$pay.state` against your function and tidies the URL.

```text "Success URL" copy
https://yourapp.com/thanks?checkout=1
```

Popup checkouts stay on the page and refresh state automatically when the popup completes. Because the provider's confirmation can arrive a few seconds after the buyer does, the plugin re-checks state on a short backoff after the return — the page settles on the webhook-confirmed record without any author code, so what buyers see is what your function actually granted.

| Event | Fires when |
|---|---|
| `manifest:pay:result`{copy} | A popup checkout completes or is cancelled. |
| `manifest:pay:return`{copy} | The buyer returns from a redirect checkout. |
| `manifest:pay:error`{copy} | A checkout could not be started. |
