// netlify/functions/get-session-email.js
//
// Called by the app right after Stripe redirects a customer back from
// checkout. Stripe's redirect URL carries a {CHECKOUT_SESSION_ID} — this
// function looks that session up and hands back the email address the
// customer checked out with, so the app can check access automatically
// instead of making them type their email in again.
//
// Read-only and safe to expose: it only ever returns an email address for a
// session ID that was itself handed back by Stripe's own redirect, never
// anything else about the session.

const Stripe = require('stripe');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const sessionId = (event.queryStringParameters && event.queryStringParameters.session_id) || '';

  if (!sessionId || !sessionId.startsWith('cs_')) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ email: null, reason: 'invalid_session' }),
    };
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error('Missing STRIPE_SECRET_KEY env var');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ email: null, reason: 'server_error' }),
    };
  }

  const stripe = new Stripe(stripeSecretKey);

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const email =
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ email: email }),
    };
  } catch (err) {
    console.error('Error retrieving checkout session:', err.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ email: null, reason: 'not_found' }),
    };
  }
};
