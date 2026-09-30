// netlify/functions/stripe-webhook.js
//
// Stripe calls this endpoint automatically every time something changes on a
// subscription (created, trial ending, renewed, cancelled, payment failed...).
// It verifies the request really came from Stripe, then writes the current
// status for that customer's email into Netlify Blobs so check-access.js can
// answer "is this person allowed in?" without ever calling Stripe itself.
//
// One-time setup required (see SETUP.md):
//   - STRIPE_SECRET_KEY       (Stripe dashboard -> Developers -> API keys)
//   - STRIPE_WEBHOOK_SECRET   (created when you register this URL as a webhook
//                              endpoint in the Stripe dashboard)
// Both must be set as Netlify environment variables, never hard-coded here.

const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');

// Netlify is supposed to auto-configure Blobs for functions running on its own
// infrastructure, but that auto-detection doesn't always kick in. Falling back
// to explicit siteID/token (set as NETLIFY_BLOBS_SITE_ID / NETLIFY_BLOBS_TOKEN
// in Netlify's environment variables) makes this work regardless.
function getSubscribersStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'subscribers', siteID, token });
  }
  return getStore('subscribers');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecretKey || !webhookSecret) {
    console.error('Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET env vars');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  const stripe = new Stripe(stripeSecretKey);
  const signature = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  const store = getSubscribersStore();

  async function upsertFromSubscription(subscription, emailOverride) {
    let email = emailOverride;

    if (!email) {
      try {
        const customer = await stripe.customers.retrieve(subscription.customer);
        if (customer && !customer.deleted) {
          email = customer.email;
        }
      } catch (err) {
        console.error('Could not retrieve customer for subscription', subscription.id, err.message);
      }
    }

    if (!email) {
      console.warn('No email found for subscription', subscription.id, '— skipping');
      return;
    }

    const key = email.toLowerCase().trim();
    const record = {
      email: key,
      customerId: subscription.customer,
      subscriptionId: subscription.id,
      status: subscription.status, // trialing | active | past_due | canceled | unpaid | incomplete...
      currentPeriodEnd: subscription.current_period_end || null,
      trialEnd: subscription.trial_end || null,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    await store.setJSON(key, record);
    console.log('Updated subscriber record for', key, '→', record.status);
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const email =
            (session.customer_details && session.customer_details.email) ||
            session.customer_email ||
            null;
          await upsertFromSubscription(subscription, email);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.trial_will_end': {
        const subscription = stripeEvent.data.object;
        await upsertFromSubscription(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        await upsertFromSubscription({ ...subscription, status: 'canceled' });
        break;
      }

      default:
        // Every other event type is ignored on purpose — we only care about
        // whether a subscription is currently trialing/active/inactive.
        break;
    }
  } catch (err) {
    console.error('Error handling Stripe webhook event:', err);
    return { statusCode: 500, body: 'Internal error processing webhook' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
