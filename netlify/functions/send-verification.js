// netlify/functions/send-verification.js
//
// Generates a one-time verification token for an email that just started a
// trial/subscription, saves it on that subscriber's record, and emails them
// a link to click to prove the address is real and reachable. Access isn't
// granted (see check-access.js) until that link has been clicked.
//
// Requires these Netlify environment variables:
//   - RESEND_API_KEY     (from resend.com -> API Keys)
//   - RESEND_FROM_EMAIL  (e.g. "CareAuditPro <verify@careauditpro.co.uk>" —
//                          must be on a domain you've verified in Resend)
// Also uses NETLIFY_BLOBS_SITE_ID / NETLIFY_BLOBS_TOKEN, same as the other
// functions, to read and update the subscriber record.

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_SECONDS = 24 * 60 * 60; // verification links are valid for 24 hours

function getSubscribersStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'subscribers', siteID, token });
  }
  return getStore('subscribers');
}

function getAppBaseUrl() {
  // APP_BASE_URL lets you override explicitly; otherwise fall back to the
  // URL Netlify automatically injects for the live site.
  return process.env.APP_BASE_URL || process.env.URL || '';
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ sent: false, reason: 'method_not_allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ sent: false, reason: 'invalid_body' }) };
  }

  const rawEmail = body.email || '';
  const email = rawEmail.toLowerCase().trim();

  if (!email || !EMAIL_RE.test(email)) {
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false, reason: 'invalid_email' }) };
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!resendApiKey || !fromEmail) {
    console.error('Missing RESEND_API_KEY or RESEND_FROM_EMAIL env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ sent: false, reason: 'server_error' }) };
  }

  const store = getSubscribersStore();

  let record;
  try {
    record = await store.get(email, { type: 'json' });
  } catch (err) {
    console.error('Error reading subscriber store:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ sent: false, reason: 'server_error' }) };
  }

  if (!record) {
    // No subscription record yet — nothing to verify against. Don't leak
    // whether an email exists in our system beyond this generic response.
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false, reason: 'not_found' }) };
  }

  if (record.emailVerified) {
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false, reason: 'already_verified' }) };
  }

  // Avoid resending if a link was already sent very recently (basic spam-click guard).
  const now = Math.floor(Date.now() / 1000);
  if (record.verificationSentAt && now - record.verificationSentAt < 30) {
    return { statusCode: 200, headers, body: JSON.stringify({ sent: true, reason: 'already_sent_recently' }) };
  }

  const token = crypto.randomBytes(24).toString('hex');
  const updatedRecord = Object.assign({}, record, {
    verificationToken: token,
    verificationSentAt: now,
  });

  try {
    await store.setJSON(email, updatedRecord);
  } catch (err) {
    console.error('Error saving verification token:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ sent: false, reason: 'server_error' }) };
  }

  const baseUrl = getAppBaseUrl();
  const verifyLink =
    baseUrl.replace(/\/$/, '') +
    '/?verify=' + encodeURIComponent(token) +
    '&email=' + encodeURIComponent(email);

  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resendApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: 'Confirm your email for CareAuditPro',
        html:
          '<p>Thanks for starting your CareAuditPro trial.</p>' +
          '<p>Please confirm this is your email address by clicking the link below:</p>' +
          '<p><a href="' + verifyLink + '">Confirm my email</a></p>' +
          '<p>This link expires in 24 hours. If you did not request this, you can ignore this email.</p>',
        text:
          'Thanks for starting your CareAuditPro trial.\n\n' +
          'Please confirm this is your email address by opening this link:\n' +
          verifyLink + '\n\n' +
          'This link expires in 24 hours. If you did not request this, you can ignore this email.',
      }),
    });

    if (!resendResponse.ok) {
      const errText = await resendResponse.text();
      console.error('Resend API error:', resendResponse.status, errText);
      return { statusCode: 500, headers, body: JSON.stringify({ sent: false, reason: 'email_provider_error' }) };
    }
  } catch (err) {
    console.error('Error calling Resend:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ sent: false, reason: 'email_provider_error' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ sent: true }) };
};
