# CareAuditPro — Stripe-Verified Access Gate: Setup Guide

This replaces the old URL-based gate (`?auth=CAP50` / `?auth=Trial-YYYY-MM-DD`)
with a real one: Stripe is the source of truth for who has an active trial or
subscription, and the app checks with a small server-side function before
unlocking — nothing a visitor can fake by editing the address bar.

You need a **Stripe account** and a **Netlify account** (you already have the
latter, since that's where the app is hosted). Everything below is a one-time
setup. After it's done, new customers, trials, cancellations and renewals are
all handled automatically — you don't touch anything per customer.

---

## 1. How it works (30 seconds)

```
Customer starts trial/subscribes
        │
        ▼
   Stripe Checkout (your Payment Link, with a 14-day free trial attached)
        │
        ▼
Stripe fires a webhook event ──▶ netlify/functions/stripe-webhook.js
        │                              │
        │                              ▼
        │                     writes "this email is trialing/active"
        │                     into Netlify's built-in key-value store
        ▼
Customer opens the app, enters their email
        │
        ▼
netlify/functions/check-access.js looks up that email in the store
        │
        ▼
   access granted → app unlocks
   access denied  → lock screen + "Activate" button (your Stripe link)
```

Nothing in the browser ever decides access — it only asks the server, and the
server only trusts what Stripe told it via the webhook.

---

## 2. Set up the Stripe product with a built-in 14-day trial

1. In the Stripe Dashboard, go to **Product catalogue → Add product**.
2. Create a recurring price: **£49.00 / month**.
3. Under the price's **advanced options**, set **Free trial period → 14 days**.
   (This replaces the app's old hand-written date math — Stripe now manages
   the trial clock, sends its own reminder emails, and auto-charges the card
   on file when the trial ends.)
4. Create a **Payment Link** for this price (Product → Create payment link).
   Copy the link — you'll paste it into the app in step 5.

## 3. Deploy this project to Netlify

If you haven't already, drag this whole folder into Netlify (or connect it to
a Git repo and let Netlify build it). Netlify will run `npm install` (from
`netlify.toml`) and automatically detect the two functions in
`netlify/functions/`.

Once deployed, note your site's function URLs — they'll look like:

```
https://your-site-name.netlify.app/.netlify/functions/stripe-webhook
https://your-site-name.netlify.app/.netlify/functions/check-access
```

`check-access` is already wired into `index.html` as a relative path
(`/.netlify/functions/check-access`), so no edit is needed there as long as
the app and the functions are deployed on the same Netlify site.

## 4. Register the webhook in Stripe

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://your-site-name.netlify.app/.netlify/functions/stripe-webhook`
3. Select these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.trial_will_end` (optional — lets you later add a
     "your trial ends soon" reminder if you want one)
4. Save, then open the endpoint and copy its **Signing secret** (starts with
   `whsec_...`) — you need it in the next step.

## 5. Set your Netlify environment variables

In Netlify: **Site configuration → Environment variables**, add:

| Key | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe **secret** key (Developers → API keys). Never put this in `index.html` or any file that ships to the browser. |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_...` value from step 4. |

Then redeploy the site so the functions pick up the new variables.

## 6. Add your live Stripe Payment Link to the app

In `index.html`, find this line (near the top of the `<script>` block):

```js
var STRIPE_PAYMENT_LINK = "https://buy.stripe.com/REPLACE_WITH_YOUR_LIVE_LINK";
```

Replace the placeholder with the Payment Link you created in step 2, then
redeploy.

## 7. Test it end-to-end

1. Open your deployed site. You should see the **"Verify Your Access"** email
   gate.
2. Click "Activate", complete a Stripe test-mode checkout (use Stripe's test
   card `4242 4242 4242 4242`, any future expiry/CVC) with a real email
   address you control.
3. Within a few seconds, Stripe should call your webhook — check
   **Netlify → your site → Functions → stripe-webhook → logs** for
   `Updated subscriber record for ... → trialing`.
4. Go back to the app, enter that same email, click "Check Access" — it
   should unlock immediately.
5. In Stripe, cancel that test subscription and confirm the app locks that
   email out again (the cached unlock expires after 12 hours, or you can
   clear it immediately by clearing the site's local storage).

## 8. The admin/support override

`?auth=CAP50` still works as a permanent bypass with no server check — keep
this for your own testing, demos, or manually unlocking a customer you're
supporting by phone. It is **not shown to customers anywhere in the UI** and
should be treated like a password: don't publish it, and change it (the
`MASTER_PASSKEY` constant in `index.html`) if you ever suspect it's leaked.

---

## What this does and doesn't solve

**Solved:** access is now decided by your actual Stripe subscription data,
verified server-side. Editing the URL, the page source, or local storage no
longer grants access — the check happens against a record only your webhook
can write.

**Still worth knowing:**
- The "12-hour cache" means a customer who cancels mid-session, or right
  after your webhook processes the cancellation, keeps access for up to 12
  hours until the app re-checks. Lower `CACHE_TTL_SECONDS` in `index.html` if
  you want tighter enforcement (at the cost of one extra network call per
  visit).
- There's no password on the email gate — anyone who knows a paying
  customer's email could type it in and get access too, since the app has no
  real login/account system. If that matters to you, the next step up would
  be a magic-link email (Stripe or a service like Netlify Identity/Auth0
  sends a one-time link) instead of a bare email field — say the word if
  you'd like that built next.
- Netlify Blobs is a per-site key-value store included free with your
  Netlify plan — no separate database service or sign-up needed.
