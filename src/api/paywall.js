const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const paywallService = require('../utils/paywallService');

const router = express.Router();

const POLAR_API_BASE_URL = process.env.POLAR_API_BASE_URL || 'https://api.polar.sh/v1';
const POLAR_API_KEY = process.env.POLAR_API_KEY;
const POLAR_PRODUCT_ID = process.env.POLAR_PRODUCT_ID;
const POLAR_PRODUCT_PRICE_ID = process.env.POLAR_PRODUCT_PRICE_ID;
const POLAR_PAYMENT_PROCESSOR = process.env.POLAR_PAYMENT_PROCESSOR || 'stripe';
const POLAR_SUCCESS_URL = process.env.POLAR_SUCCESS_URL || process.env.FRONTEND_URL || 'http://localhost:3000/?payment=success';
const POLAR_CANCEL_URL = process.env.POLAR_CANCEL_URL || process.env.FRONTEND_URL || 'http://localhost:3000/?payment=cancelled';
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;

function paywallConfigured() {
  return !!(
    POLAR_API_KEY &&
    POLAR_PAYMENT_PROCESSOR &&
    (POLAR_PRODUCT_PRICE_ID || POLAR_PRODUCT_ID) &&
    !paywallService.paywallUnavailable()
  );
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
      customer_email: email,
      success_url: `${POLAR_SUCCESS_URL}${POLAR_SUCCESS_URL.includes('?') ? '&' : '?'}email=${encodeURIComponent(email)}&payment=success`,
      cancel_url: POLAR_CANCEL_URL,
      payment_processor: POLAR_PAYMENT_PROCESSOR
    };

    if (POLAR_PRODUCT_PRICE_ID) {
      payload.product_price_id = POLAR_PRODUCT_PRICE_ID;
    } else if (POLAR_PRODUCT_ID) {
      payload.product_id = POLAR_PRODUCT_ID;
    }

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
      let detail = 'Failed to create checkout session';
      try {
        const parsed = JSON.parse(errorText);
        if (parsed?.detail) {
          detail = Array.isArray(parsed.detail)
            ? parsed.detail.map(item => item.msg).join('; ')
            : parsed.detail;
        } else if (parsed?.error) {
          detail = parsed.error;
        }
      } catch (err) {
        // ignore JSON parse errors
      }
      return res.status(500).json({ error: detail });
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
  console.log('📥 Polar webhook received');
  
  if (!POLAR_WEBHOOK_SECRET) {
    console.warn('⚠️  Polar webhook received but no secret configured.');
    return res.status(200).send('ok');
  }

  const signature = req.headers['x-polar-signature'] || req.headers['polar-signature'];

  if (!signature) {
    console.warn('⚠️  Webhook missing signature header');
    return res.status(400).send('Missing signature');
  }

  const rawBody = req.rawBody
    ? req.rawBody
    : Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));
  const expectedSignature = crypto.createHmac('sha256', POLAR_WEBHOOK_SECRET).update(rawBody).digest('hex');

  if (signature !== expectedSignature) {
    console.warn('⚠️  Polar webhook signature mismatch');
    console.warn('Expected:', expectedSignature);
    console.warn('Received:', signature);
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = JSON.parse(rawBody.toString('utf8'));
    console.log('📦 Webhook payload:', JSON.stringify(payload, null, 2));
    
    const eventType = payload?.type || payload?.event || payload?.event_type;
    const checkoutData = payload?.data || payload?.object || payload?.checkout;
    
    console.log('🔔 Event type:', eventType);
    console.log('🛒 Checkout data:', JSON.stringify(checkoutData, null, 2));

    // Handle multiple event types that indicate payment success
    const successEvents = [
      'checkout.payment_succeeded',
      'checkout.completed',
      'checkout.succeeded',
      'payment.succeeded',
      'checkout.paid'
    ];

    if (successEvents.includes(eventType)) {
      // Try multiple ways to extract email
      const attributes = checkoutData?.attributes || checkoutData;
      const email = 
        attributes?.customer_email || 
        attributes?.customer?.email ||
        attributes?.metadata?.email ||
        checkoutData?.customer_email ||
        payload?.customer_email;
      
      const checkoutId = checkoutData?.id || checkoutData?.checkout_id || attributes?.id;

      console.log('📧 Extracted email:', email);
      console.log('🆔 Checkout ID:', checkoutId);

      if (email) {
        await paywallService.activatePlan(email, checkoutId);
        console.log('✅ Plan activated for:', email);
      } else {
        console.warn('⚠️  No email found in webhook payload');
      }
    } else {
      console.log('ℹ️  Event type not handled:', eventType);
    }

    res.status(200).send('ok');
  } catch (error) {
    console.error('❌ Polar webhook processing error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).send('error');
  }
});

// Manual activation endpoint for testing/admin use
router.post('/activate', async (req, res) => {
  try {
    const { email, checkoutId } = req.body || {};
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log(`🔧 Manual activation requested for: ${email}`);
    await paywallService.activatePlan(email, checkoutId);
    
    const status = await paywallService.getPlanStatus(email);
    res.json({
      success: true,
      message: 'Plan activated successfully',
      status
    });
  } catch (error) {
    console.error('Manual activation error:', error);
    res.status(500).json({ error: 'Failed to activate plan' });
  }
});

module.exports = router;

