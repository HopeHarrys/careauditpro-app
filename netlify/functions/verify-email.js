// netlify/functions/verify-email.js
//
// Called when a customer clicks the confirmation link from send-verification.js.
// Checks the token matches what we sent for that email, hasn't expired, and if
// so marks the subscriber record as emailVerified — which check-access.js then
// requires before granting access.

const { getStore } = require('@netlify/blobs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_SECONDS = 24 * 60 * 60; // must match send-verification.js

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
    'Access-Control-Allow-Origin': '*',
  };

  const qs = event.queryStringParameters || {};
  const rawEmail = qs.email || '';
  const email = rawEmail.toLowerCase().trim();
  const token = qs.token || '';

  if (!email || !EMAIL_RE.test(email) || !token) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, reason: 'invalid_request' }) };
  }

  const store = getSubscribersStore();

  let record;
  try {
    record = await store.get(email, { type: 'json' });
  } catch (err) {
    console.error('Error reading subscriber store:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ verified: false, reason: 'server_error' }) };
  }

  if (!record) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, reason: 'not_found' }) };
  }

  if (record.emailVerified) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: true, reason: 'already_verified' }) };
  }

  if (!record.verificationToken || record.verificationToken !== token) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, reason: 'token_mismatch' }) };
  }

  const now = Math.floor(Date.now() / 1000);
  if (record.verificationSentAt && now - record.verificationSentAt > TOKEN_TTL_SECONDS) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, reason: 'token_expired' }) };
  }

  const updatedRecord = Object.assign({}, record, {
    emailVerified: true,
    verificationToken: null,
  });

  try {
    await store.setJSON(email, updatedRecord);
  } catch (err) {
    console.error('Error saving verified status:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ verified: false, reason: 'server_error' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ verified: true }) };
};
