// Gathurr Stripe backend
//
// This is the piece the artifact itself cannot contain: a server holding the
// Stripe SECRET key. It exposes three endpoints the Gathurr app calls:
//
//   POST /api/create-checkout-session   -> creates a real Stripe Checkout Session,
//                                          returns the URL to redirect the browser to.
//   GET  /api/verify-session            -> the app calls this when Stripe redirects
//                                          back, to confirm the payment really went
//                                          through before marking anything "settled".
//   POST /api/webhook                   -> Stripe calls this server-to-server as the
//                                          source of truth (works even if the person
//                                          closes the tab before the redirect back).
//
// Nothing in this file talks to Gathurr's own data store — that store only exists
// inside the Claude artifact sandbox and isn't reachable from an external server.
// So this backend is deliberately stateless: it only ever answers "is this Stripe
// session actually paid?". The browser is the one that, once it gets a "yes" back,
// applies that to Gathurr's settle-up ledger using the app's own existing logic.

require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// IMPORTANT: the webhook route needs the raw request body to verify Stripe's
// signature, so it's registered BEFORE the json() body parser, with its own
// raw parser. Every other route uses normal JSON parsing.
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // This is the durable record of the payment. In a fuller build you'd write
    // this to a real database here (Postgres, etc.) so it survives even if the
    // browser never calls /api/verify-session. For Gathurr's current design,
    // logging is enough — the browser-side verify call is the actual path that
    // updates the trip.
    console.log('[stripe webhook] checkout.session.completed', {
      sessionId: session.id,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
    });
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for the real <form> POST from Gathurr

// CORS: the Gathurr artifact is served from claude.ai / claude.site, so allow
// requests from there. Loosen or tighten this allowlist to match your setup.
app.use((req, res, next) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Create a real Stripe Checkout Session for one settle-up payment.
// Body: { amount: number (dollars), fromName: string, toName: string, tripName: string, returnUrl: string }
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { amount, fromName, toName, tripName, returnUrl } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!fromName || !toName) return res.status(400).json({ error: 'fromName and toName are required' });
    if (!returnUrl) return res.status(400).json({ error: 'returnUrl is required' });

    const amountInCents = Math.round(Number(amount) * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${tripName || 'Trip'}: ${fromName} \u2192 ${toName}`,
          },
          unit_amount: amountInCents,
        },
        quantity: 1,
      }],
      metadata: { fromName, toName, tripName: tripName || '' },
      // Stripe appends its own session_id placeholder; the app reads it back
      // out of the URL on return to call /api/verify-session.
      success_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}stripe_session={CHECKOUT_SESSION_ID}`,
      cancel_url: returnUrl,
    });

    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// The app calls this after Stripe redirects the browser back, to confirm the
// payment actually completed before touching the settle-up ledger.
app.get('/api/verify-session', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      paid: session.payment_status === 'paid',
      amountTotal: session.amount_total,
      metadata: session.metadata,
    });
  } catch (err) {
    console.error('verify-session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Navigation-based flow (no fetch() anywhere on the client). The Gathurr app
// navigates the browser straight here instead of calling this over fetch(),
// because the Claude artifact sandbox's CSP blocks background fetch()/XHR
// calls to external domains but does NOT block full-page navigations like a
// form submit, an <a>/window.open() to a real URL, or a server-issued
// redirect.
//
// Registered for BOTH GET and POST:
//   - GET  (?amount=...&fromName=...&toName=...&tripName=...&returnUrl=...)
//     is what the client actually uses now: it hands window.open() a
//     complete, real https:// URL up front. (An earlier attempt opened a
//     blank popup with window.open('', name) and form-POSTed into it, but
//     Claude's artifact host wraps window.open() and rejects a call that
//     isn't given a real, fetchable URL immediately — "Invalid request url:
//     about:blank" — so the destination URL has to be fully formed before
//     window.open() is ever called.)
//   - POST is kept for any client still doing a real <form method="POST">
//     submit; same handler, just reads req.body instead of req.query.
//
//   1. Browser navigates here (GET query string or POST form) with the
//      payment details.
//   2. We create the Stripe Checkout Session server-side and 303-redirect
//      the whole page straight to Stripe's hosted checkout — no JSON, no
//      fetch, just an HTTP redirect.
//   3. Stripe redirects back to OUR /return route (not straight back to the
//      app), so we can verify the session server-side.
//   4. We redirect the browser on to the app's own URL, with the verified
//      result (paid: yes/no) attached as plain query params. The app reads
//      those off window.location — again, no fetch involved.
// ---------------------------------------------------------------------------

async function handleCheckout(req, res) {
  try {
    const source = req.method === 'GET' ? req.query : req.body;
    const { amount, fromName, toName, tripName, returnUrl } = source;

    if (!amount || Number(amount) <= 0) return res.status(400).send('amount must be a positive number');
    if (!fromName || !toName) return res.status(400).send('fromName and toName are required');
    if (!returnUrl) return res.status(400).send('returnUrl is required');

    const amountInCents = Math.round(Number(amount) * 100);
    const backendOrigin = `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${tripName || 'Trip'}: ${fromName} → ${toName}`,
          },
          unit_amount: amountInCents,
        },
        quantity: 1,
      }],
      metadata: { fromName, toName, tripName: tripName || '' },
      // Success sends Stripe's browser back through OUR /return route first
      // (with the returnUrl carried along), so we can verify server-side
      // before the browser ever lands back on the app.
      success_url: `${backendOrigin}/return?session_id={CHECKOUT_SESSION_ID}&returnUrl=${encodeURIComponent(returnUrl)}`,
      cancel_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}stripe_cancelled=1`,
    });

    res.redirect(303, session.url); // full-page redirect straight to Stripe, no JSON
  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).send(`Could not start Stripe checkout: ${err.message}`);
  }
}
app.get('/checkout', handleCheckout);
app.post('/checkout', handleCheckout);

app.get('/return', async (req, res) => {
  const { session_id, returnUrl } = req.query;
  if (!returnUrl) return res.status(400).send('Missing returnUrl');
  if (!session_id) return res.redirect(302, `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}stripe_cancelled=1`);

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const paid = session.payment_status === 'paid' ? '1' : '0';
    const sep = returnUrl.includes('?') ? '&' : '?';
    res.redirect(302, `${returnUrl}${sep}stripe_session=${encodeURIComponent(session_id)}&stripe_paid=${paid}`);
  } catch (err) {
    console.error('return/verify error:', err);
    const sep = returnUrl.includes('?') ? '&' : '?';
    res.redirect(302, `${returnUrl}${sep}stripe_session=${encodeURIComponent(session_id)}&stripe_paid=0`);
  }
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`Gathurr Stripe backend listening on :${port}`));
