// netlify/functions/check-access.js
//
// Called by the app's lock screen with a visitor's email. Looks up the
// subscriber record that stripe-webhook.js kept in sync and answers whether
// this email currently has a trialing or active Stripe subscription.
//
// This never talks to Stripe directly — it only reads what the webhook has
// already written to Netlify Blobs, so it stays fast and doesn't need the
// Stripe secret key at all.

const { getStore } = require('@netlify/blobs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVE_STATUSES = ['trialing', 'active'];

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
  const headers = {
    'Content-Type': 'application/json',
    // Same-origin in production (the app and the function share a domain on
    // Netlify), left open here so local testing / a staging domain also works.
    'Access-Control-Allow-Origin': '*',
  };

  const rawEmail = (event.queryStringParameters && event.queryStringParameters.email) || '';
  const email = rawEmail.toLowerCase().trim();

  if (!email || !EMAIL_RE.test(email)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ access: false, reason: 'invalid_email' }),
    };
  }

  let record;
  try {
    const store = getSubscribersStore();
    record = await store.get(email, { type: 'json' });
  } catch (err) {
    console.error('Error reading subscriber store:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ access: false, reason: 'server_error' }),
    };
  }

  if (!record) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ access: false, reason: 'not_found' }),
    };
  }

  const granted = ACTIVE_STATUSES.includes(record.status);

  if (!granted) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ access: false, reason: 'inactive', status: record.status }),
    };
  }

  // Require the email to have been confirmed (see send-verification.js /
  // verify-email.js) before granting access, even if the Stripe subscription
  // itself is trialing/active. Stops someone unlocking the app with an email
  // address that isn't actually theirs.
  if (!record.emailVerified) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ access: false, reason: 'unverified', status: record.status }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      access: true,
      status: record.status,
      trialEnd: record.trialEnd,
      currentPeriodEnd: record.currentPeriodEnd,
    }),
  };
};
