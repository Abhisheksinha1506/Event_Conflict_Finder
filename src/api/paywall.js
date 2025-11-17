const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const paywallService = require('../utils/paywallService');

const router = express.Router();

const POLAR_API_BASE_URL = process.env.POLAR_API_BASE_URL || 'https://api.polar.sh/v1';
const POLAR_API_KEY = process.env.POLAR_API_KEY;
const POLAR_PRODUCT_ID = process.env.POLAR_PRODUCT_ID;
const POLAR_SUCCESS_URL = process.env.POLAR_SUCCESS_URL || process.env.FRONTEND_URL || 'http://localhost:3000/?payment=success';
const POLAR_CANCEL_URL = process.env.POLAR_CANCEL_URL || process.env.FRONTEND_URL || 'http://localhost:3000/?payment=cancelled';
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;

function paywallConfigured() {
  return !!(POLAR_API_KEY && POLAR_PRODUCT_ID && !paywallService.paywallUnavailable());
}

router.post('/status', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const status = await paywallService.getPlanStatus(email);
    res.json({
      ...status,
      paywallEnabled: paywallConfigured(),
      freeSearchLimit: paywallService.FREE_SEARCH_LIMIT
    });
  } catch (error) {
    console.error('Paywall status error:', error);
    res.status(500).json({ error: 'Failed to fetch plan status' });
  }
});

router.post('/checkout', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!paywallConfigured()) {
      return res.status(503).json({ error: 'Checkout disabled. Missing configuration.' });
    }

    const payload = {
      product_id: POLAR_PRODUCT_ID,
      customer_email: email,
      success_url: `${POLAR_SUCCESS_URL}${POLAR_SUCCESS_URL.includes('?') ? '&' : '?'}email=${encodeURIComponent(email)}&payment=success`,
      cancel_url: POLAR_CANCEL_URL
    };

    const response = await fetch(`${POLAR_API_BASE_URL}/checkout-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLAR_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Polar checkout creation failed:', errorText);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkout = await response.json();
    const checkoutId = checkout?.data?.id || checkout?.id;
    const checkoutUrl = checkout?.data?.attributes?.url || checkout?.url;

    await paywallService.markCheckoutInitiated(email, checkoutId);

    res.json({
      checkoutId,
      checkoutUrl
    });
  } catch (error) {
    console.error('Checkout creation error:', error);
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

router.post('/webhook', async (req, res) => {
  if (!POLAR_WEBHOOK_SECRET) {
    console.warn('Polar webhook received but no secret configured.');
    return res.status(200).send('ok');
  }

  const signature = req.headers['x-polar-signature'] || req.headers['polar-signature'];

  if (!signature) {
    return res.status(400).send('Missing signature');
  }

  const rawBody = req.rawBody
    ? req.rawBody
    : Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));
  const expectedSignature = crypto.createHmac('sha256', POLAR_WEBHOOK_SECRET).update(rawBody).digest('hex');

  if (signature !== expectedSignature) {
    console.warn('Polar webhook signature mismatch');
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = JSON.parse(rawBody.toString('utf8'));
    const eventType = payload?.type || payload?.event;
    const checkoutData = payload?.data || payload?.object;

    if (eventType === 'checkout.payment_succeeded' || eventType === 'checkout.completed') {
      const attributes = checkoutData?.attributes || checkoutData;
      const email = attributes?.customer_email || attributes?.metadata?.email;
      const checkoutId = checkoutData?.id;

      if (email) {
        await paywallService.activatePlan(email, checkoutId);
      }
    }

    res.status(200).send('ok');
  } catch (error) {
    console.error('Polar webhook processing error:', error);
    res.status(500).send('error');
  }
});

module.exports = router;

