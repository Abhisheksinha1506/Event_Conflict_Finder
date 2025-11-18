const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const paywallService = require('../utils/paywallService');

const router = express.Router();

function deriveFrontendUrl(req) {
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL;
  }

  // Prefer explicit Origin header when present (e.g. browsers making same-origin requests)
  if (req?.headers?.origin) {
    return req.headers.origin;
  }

  // Fall back to forwarded host/proto (Vercel / proxies)
  const forwardedHost = req?.headers?.['x-forwarded-host'];
  if (forwardedHost) {
    const forwardedProto = req?.headers?.['x-forwarded-proto'] || 'https';
    return `${forwardedProto}://${forwardedHost}`;
  }

  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.startsWith('http')
      ? process.env.VERCEL_URL
      : `https://${process.env.VERCEL_URL}`;
    return host;
  }

  if (req?.headers?.host) {
    const protocol = req?.protocol || req?.headers?.['x-forwarded-proto'] || 'http';
    return `${protocol}://${req.headers.host}`;
  }

  return 'http://localhost:3000';
}

const POLAR_API_BASE_URL = process.env.POLAR_API_BASE_URL || 'https://api.polar.sh/v1';
const POLAR_API_KEY = process.env.POLAR_API_KEY;
const POLAR_PRODUCT_ID = process.env.POLAR_PRODUCT_ID;
const POLAR_PRODUCT_PRICE_ID = process.env.POLAR_PRODUCT_PRICE_ID;
const POLAR_PAYMENT_PROCESSOR = process.env.POLAR_PAYMENT_PROCESSOR || 'stripe';
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;

function appendParams(baseUrl, params = {}) {
  if (!baseUrl) {
    return baseUrl;
  }

  try {
    const url = new URL(baseUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  } catch (error) {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    if (!query) {
      return baseUrl;
    }
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query}`;
  }
}

function resolveRedirectUrls(req, email = null) {
  const baseUrl = deriveFrontendUrl(req);
  const successBase = process.env.POLAR_SUCCESS_URL || `${baseUrl}?payment=success`;
  const cancelBase = process.env.POLAR_CANCEL_URL || `${baseUrl}?payment=cancelled`;

  const successParams = {
    payment: 'success'
  };
  
  // Include email in success URL if provided (helps with automatic sign-in)
  if (email && typeof email === 'string') {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail) {
      successParams.email = normalizedEmail;
    }
  }

  const successUrl = appendParams(successBase, successParams);

  const cancelUrl = appendParams(cancelBase, {
    payment: 'cancelled'
  });

  return { successUrl, cancelUrl };
}

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

    // Auto-verify pending payments when checking status
    const status = await paywallService.getPlanStatus(email, true);
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
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!paywallConfigured()) {
      return res.status(503).json({ error: 'Checkout disabled. Missing configuration.' });
    }

    const { successUrl, cancelUrl } = resolveRedirectUrls(req, normalizedEmail);

    const payload = {
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_processor: POLAR_PAYMENT_PROCESSOR
    };

    if (normalizedEmail) {
      payload.customer_email = normalizedEmail;
    }

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

    await paywallService.markCheckoutInitiated(normalizedEmail, checkoutId);

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
  // Always return 200 OK to prevent Polar from disabling the webhook
  // Even if there are errors, we log them but return success
  try {
    console.error('📥 WEBHOOK: Polar webhook received');
    console.error('📋 WEBHOOK: Event type will be determined from payload');
    
    // Get raw body for signature verification
    // Try multiple methods to ensure we get the raw body (works on both localhost and Vercel)
    let rawBody;
    try {
      if (req.rawBody) {
        rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
      } else if (Buffer.isBuffer(req.body)) {
        rawBody = req.body;
      } else if (typeof req.body === 'string') {
        rawBody = Buffer.from(req.body);
      } else {
        // Fallback: reconstruct from parsed body (less secure but ensures we don't fail)
        rawBody = Buffer.from(JSON.stringify(req.body || {}));
        console.warn('⚠️  Using reconstructed raw body from parsed JSON - signature verification may fail');
      }
    } catch (rawBodyError) {
      console.error('❌ Error getting raw body:', rawBodyError.message);
      // Use empty buffer as fallback
      rawBody = Buffer.from('{}');
    }

    // Verify signature if secret is configured
    if (POLAR_WEBHOOK_SECRET) {
      // Check all possible header name variations (Vercel normalizes to lowercase)
      const signatureHeader = 
        req.headers['polar-signature'] || 
        req.headers['Polar-Signature'] ||
        req.headers['POLAR-SIGNATURE'] ||
        req.headers['x-polar-signature'] ||
        req.headers['X-Polar-Signature'];
      
      if (!signatureHeader) {
        console.warn('⚠️  Webhook missing signature header');
        const allHeaderKeys = Object.keys(req.headers || {});
        console.warn('All header keys:', allHeaderKeys.join(', '));
        console.warn('Headers containing "polar":', allHeaderKeys.filter(h => h.toLowerCase().includes('polar')).join(', '));
        // Continue processing but log the warning - don't return early
        // This allows customer.updated and other non-payment events to be processed
      } else {
      // Polar signature format: "t=timestamp,v1=signature"
      // Polar signs: timestamp + "." + rawBody
      const matches = signatureHeader.match(/t=([^,]+),v1=([^&]+)/);
      
      if (!matches) {
          console.warn('⚠️  Invalid signature format:', signatureHeader);
        } else {
      const timestamp = matches[1];
      const providedHash = matches[2];
      
      // Polar signs: timestamp + "." + rawBody (as UTF-8 string)
      const rawBodyString = rawBody.toString('utf8');
      const signedPayload = `${timestamp}.${rawBodyString}`;
      
      const expectedHash = crypto
        .createHmac('sha256', POLAR_WEBHOOK_SECRET)
        .update(signedPayload)
        .digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      try {
        const providedBuffer = Buffer.from(providedHash, 'hex');
        const expectedBuffer = Buffer.from(expectedHash, 'hex');
        
        if (providedBuffer.length !== expectedBuffer.length) {
              console.warn('⚠️  Signature length mismatch');
            } else if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
              console.warn('⚠️  Signature mismatch');
            } else {
              console.error('✅ WEBHOOK: Signature verified successfully');
            }
      } catch (sigError) {
        console.error('❌ Error during signature verification:', sigError.message);
          }
        }
      }
    } else {
      console.warn('⚠️  Polar webhook secret not configured - skipping signature verification');
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
      console.error('📦 WEBHOOK: Payload type:', payload?.type || payload?.event || 'unknown');
    } catch (parseError) {
      console.error('❌ Failed to parse webhook payload:', parseError.message);
      return res.status(200).json({ received: true, error: 'Invalid JSON payload' });
    }

    const eventType = payload?.type || payload?.event || payload?.event_type;
    const checkoutData = payload?.data || payload?.object || payload?.checkout;
    
    console.error('🔔 WEBHOOK: Event type:', eventType);
    console.error('📦 WEBHOOK: Payload data keys:', Object.keys(payload?.data || {}).join(', '));

    // Handle customer.updated events
    if (eventType === 'customer.updated') {
      const customerEmail = payload?.data?.email;
      if (customerEmail) {
        console.error('👤 WEBHOOK: Customer updated:', customerEmail);
        // Check if customer has an active plan and update if needed
        // This is informational - no action needed unless customer status changed
        try {
          const status = await paywallService.getPlanStatus(customerEmail, true);
          console.error('📊 WEBHOOK: Customer plan status:', status.planStatus);
        } catch (error) {
          console.error('❌ Error checking customer status:', error.message);
        }
      }
      // Always return success for customer.updated
      return res.status(200).json({ received: true, event: 'customer.updated', processed: true });
    }

    // Handle checkout.updated events - consider multiple success-ish statuses
    // checkout.updated is sent when checkout status changes (pending -> confirmed -> succeeded, etc.)
    const checkoutStatus = (checkoutData?.status || '').toString().toLowerCase();
    const checkoutSuccessStatuses = new Set(['succeeded', 'paid', 'completed', 'confirmed']);
    let isCheckoutSucceeded = false;
    if (eventType === 'checkout.updated' && checkoutSuccessStatuses.has(checkoutStatus)) {
      isCheckoutSucceeded = true;
      console.error(`✅ WEBHOOK: checkout.updated with status=${checkoutStatus} treated as success`);
    } else if (eventType === 'checkout.updated' && checkoutStatus && !checkoutSuccessStatuses.has(checkoutStatus)) {
      console.error(`ℹ️  WEBHOOK: checkout.updated status=${checkoutStatus} (not final) – waiting for Polar to send success/failure`);
      if (!res.headersSent) {
        return res.status(200).json({
          received: true,
          event: eventType,
          processed: false,
          status: checkoutStatus
        });
      }
      return;
    }

    // Handle multiple event types that indicate payment success
    // benefit_grant.created is sent when a benefit is granted (payment succeeded)
    // checkout.succeeded is the PRIMARY event Polar sends for successful payments
    // checkout.updated with a final status also indicates successful payment
    const successEvents = [
      'benefit_grant.created', // PRIMARY - benefit granted = payment succeeded
      'checkout.succeeded', // PRIMARY event - must be first
      'checkout.payment_succeeded',
      'checkout.completed',
      'payment.succeeded',
      'checkout.paid',
      'checkout_link.paid',
      'checkout_link.completed',
      'order.completed',
      'order.paid',
      'payment.completed'
    ];

    // Handle payment failure events / revocations
    const failureEvents = [
      'checkout.payment_failed',
      'checkout.failed',
      'payment.failed',
      'order.failed',
      'checkout.cancelled',
      'checkout.expired'
    ];

    // Extract email and checkout ID (common for both success and failure)
    // For benefit_grant.created, email is in data.customer.email
    // For checkout.updated, email is in data.customer_email
    const attributes = checkoutData?.attributes || checkoutData;
    
    // Priority order for email extraction:
    // 1. payload.data.customer.email (for benefit_grant.created)
    // 2. payload.data.customer_email (for checkout.updated)
    // 3. Other fallbacks
    const email = 
      payload?.data?.customer?.email || // For benefit_grant.created events - HIGHEST PRIORITY
      payload?.data?.customer_email || // For checkout.updated events
      attributes?.customer_email || 
      attributes?.customer?.email ||
      attributes?.metadata?.email ||
      checkoutData?.customer_email ||
      payload?.customer_email ||
      payload?.data?.customer_email ||
      payload?.data?.attributes?.customer_email;
    
    // For benefit_grant.created, checkout_id is in order_id
    // For checkout.updated, checkout_id is in data.id
    const checkoutId = 
      payload?.data?.order_id || // For benefit_grant.created events - HIGHEST PRIORITY
      payload?.data?.id || // For checkout.updated events (checkout ID)
      checkoutData?.id || 
      checkoutData?.checkout_id || 
      checkoutData?.checkout_link_id ||
      attributes?.id ||
      payload?.checkout_id ||
      payload?.checkout_link_id;

    // Log extracted values - use console.error for visibility in Vercel logs
    console.error('📧 WEBHOOK EMAIL EXTRACTION:', email || 'NOT FOUND');
    console.error('🆔 WEBHOOK CHECKOUT/ORDER ID:', checkoutId || 'NOT FOUND');
    console.error('🔍 EMAIL EXTRACTION DEBUG:', JSON.stringify({
      'payload.data.customer.email': payload?.data?.customer?.email,
      'payload.data.customer_email': payload?.data?.customer_email,
      'payload.data.order_id': payload?.data?.order_id,
      'eventType': eventType,
      'isSuccessEvent': successEvents.includes(eventType)
    }));

    // Process events
    // Handle checkout.updated with succeeded status OR other success events
    if (isCheckoutSucceeded || successEvents.includes(eventType)) {
      console.error(`💰 WEBHOOK: Processing payment success event: ${eventType}`);
      try {
        if (email) {
          console.error(`🔄 WEBHOOK: Activating plan for email: ${email}, checkout/order ID: ${checkoutId || 'none'}`);
          await paywallService.activatePlan(email, checkoutId);
          console.error('✅ WEBHOOK: Plan activated successfully for:', email);
          
          // Verify activation
          const verifyStatus = await paywallService.getPlanStatus(email, false);
          console.error('🔍 WEBHOOK: Verification - Plan status after activation:', verifyStatus.planStatus);
          if (verifyStatus.planStatus !== 'active') {
            console.error('❌ WEBHOOK CRITICAL: Plan activation may have failed! Status:', verifyStatus.planStatus);
          } else {
            console.error('✅ WEBHOOK: Plan activation verified - status is active');
          }
        } else {
          console.error('⚠️  WEBHOOK: No email found in webhook payload');
          console.error('📦 WEBHOOK: Full payload for debugging:', JSON.stringify(payload, null, 2));
          
          // If we have checkout ID but no email, try to fetch from Polar API
          if (checkoutId) {
            console.error('🔄 WEBHOOK: Attempting to fetch checkout details from Polar API using order_id:', checkoutId);
            const checkoutStatus = await paywallService.checkCheckoutStatusFromPolar(checkoutId);
            console.error('📥 WEBHOOK: Checkout status from API:', JSON.stringify(checkoutStatus));
            if (checkoutStatus && checkoutStatus.email && checkoutStatus.isPaid) {
              await paywallService.activatePlan(checkoutStatus.email, checkoutId);
              console.error('✅ WEBHOOK: Plan activated via API fetch for:', checkoutStatus.email);
            } else {
              console.error('⚠️  WEBHOOK: Could not activate plan - email not found and checkout not paid');
              console.error('   WEBHOOK: Checkout status:', JSON.stringify(checkoutStatus));
            }
          } else {
            console.error('❌ WEBHOOK: Cannot activate plan - no email and no checkout/order ID');
          }
        }
      } catch (activationError) {
        console.error('❌ WEBHOOK ERROR: Error activating plan:', activationError.message);
        console.error('❌ WEBHOOK ERROR: Error stack:', activationError.stack);
        // Continue - don't throw, return 200 OK
      }
    } else if (failureEvents.includes(eventType)) {
      try {
        // Handle payment failures - don't update database, just log
        if (email) {
          await paywallService.markPaymentFailed(email, checkoutId, `Payment failed: ${eventType}`);
          console.error('❌ WEBHOOK: Payment failed for:', email, '- Database not updated, user state preserved');
        } else if (checkoutId) {
          console.warn('⚠️  Payment failed but no email found. Checkout ID:', checkoutId);
          // Try to get email from checkout for logging purposes only
          const checkoutStatus = await paywallService.checkCheckoutStatusFromPolar(checkoutId);
          if (checkoutStatus && checkoutStatus.email) {
            await paywallService.markPaymentFailed(checkoutStatus.email, checkoutId, `Payment failed: ${eventType}`);
            console.error('❌ WEBHOOK: Payment failed for:', checkoutStatus.email, '- Database not updated, user state preserved');
          }
        }
      } catch (failureError) {
        console.error('❌ Error processing payment failure:', failureError.message);
        // Continue - don't throw, return 200 OK
      }
    } else if (eventType === 'benefit_grant.revoked') {
      if (email) {
        console.error(`🔻 WEBHOOK: Benefit revoked for ${email}, reverting plan`);
        await paywallService.deactivatePlan(email, 'benefit_revoked');
      } else {
        console.warn('⚠️  WEBHOOK: benefit_grant.revoked missing customer email');
      }
    } else {
      console.error('ℹ️  WEBHOOK: Event type not handled:', eventType);
      // For unknown event types, log the full payload for debugging
      if (eventType && (eventType.includes('checkout') || eventType.includes('payment'))) {
        console.error('⚠️  WEBHOOK: Unhandled checkout/payment event, full payload:', JSON.stringify(payload, null, 2));
      }
    }

    // Always return 200 OK with JSON response
    // Use try-catch to ensure response is sent even if there's an error
    try {
      if (!res.headersSent) {
        res.status(200).json({ received: true });
      }
    } catch (responseError) {
      // If response was already sent or there's an error sending response, log it
      console.error('❌ Error sending response:', responseError.message);
      // Try to send response again if headers haven't been sent
      if (!res.headersSent) {
        try {
          res.status(200).json({ received: true, warning: 'Response error handled' });
        } catch (e) {
          // Last resort - just log
          console.error('❌ Failed to send response after retry');
        }
      }
    }
  } catch (error) {
    // Catch-all error handler - always return 200 OK to prevent disabling
    console.error('❌ Polar webhook unexpected error:', error);
    console.error('Error stack:', error.stack);
    // Return 200 OK even on unexpected errors to prevent Polar from disabling
    try {
      if (!res.headersSent) {
        res.status(200).json({ received: true, error: 'Internal processing error (logged)' });
      }
    } catch (responseError) {
      // If we can't send response, log it (but don't throw - we've done our best)
      console.error('❌ Failed to send error response:', responseError.message);
    }
  }
});

// Manual activation endpoint for testing/admin use
router.post('/activate', async (req, res) => {
  try {
    const { email, checkoutId } = req.body || {};
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log(`🔧 Manual activation requested for: ${email}${checkoutId ? ` (checkout: ${checkoutId})` : ''}`);
    
    // If checkoutId is provided, verify payment status first
    if (checkoutId) {
      const checkoutStatus = await paywallService.checkCheckoutStatusFromPolar(checkoutId);
      if (checkoutStatus) {
        console.log(`💰 Checkout status: ${checkoutStatus.status}, Paid: ${checkoutStatus.isPaid}`);
        if (!checkoutStatus.isPaid) {
          return res.status(400).json({ 
            error: 'Payment not confirmed', 
            message: `Checkout status: ${checkoutStatus.status}. Payment must be confirmed before activation.`,
            checkoutStatus 
          });
        }
        // Use email from checkout if available and different
        const emailToUse = checkoutStatus.email || email;
        await paywallService.activatePlan(emailToUse, checkoutId);
      } else {
        // If we can't verify, still allow manual activation (for admin/testing)
        console.warn('⚠️  Could not verify checkout status, proceeding with manual activation');
        await paywallService.activatePlan(email, checkoutId);
      }
    } else {
      await paywallService.activatePlan(email, checkoutId);
    }
    
    const status = await paywallService.getPlanStatus(email);
    res.json({
      success: true,
      message: 'Plan activated successfully',
      status
    });
  } catch (error) {
    console.error('Manual activation error:', error);
    res.status(500).json({ error: 'Failed to activate plan', message: error.message });
  }
});

// Check payment status by checkout ID
router.post('/verify-checkout', async (req, res) => {
  try {
    const { checkoutId, email } = req.body || {};
    
    if (!checkoutId) {
      return res.status(400).json({ error: 'Checkout ID is required' });
    }

    console.log(`🔍 Verifying checkout: ${checkoutId}`);
    const result = await paywallService.verifyAndActivatePendingCheckout(email, checkoutId);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    const planStatus = await paywallService.getPlanStatus(result.email);
    res.json({
      ...result,
      planStatus
    });
  } catch (error) {
    console.error('Checkout verification error:', error);
    res.status(500).json({ error: 'Failed to verify checkout', message: error.message });
  }
});

// List all pending checkouts
router.get('/pending', async (req, res) => {
  try {
    const pendingCheckouts = await paywallService.getAllPendingCheckouts();
    res.json({
      count: pendingCheckouts.length,
      checkouts: pendingCheckouts
    });
  } catch (error) {
    console.error('Error fetching pending checkouts:', error);
    res.status(500).json({ error: 'Failed to fetch pending checkouts', message: error.message });
  }
});

// Verify and activate all pending checkouts
router.post('/verify-all-pending', async (req, res) => {
  try {
    const pendingCheckouts = await paywallService.getAllPendingCheckouts();
    
    if (pendingCheckouts.length === 0) {
      return res.json({
        message: 'No pending checkouts found',
        results: []
      });
    }

    console.log(`🔍 Verifying ${pendingCheckouts.length} pending checkout(s)...`);
    
    const results = [];
    for (const checkout of pendingCheckouts) {
      try {
        const result = await paywallService.verifyAndActivatePendingCheckout(
          checkout.email,
          checkout.checkout_id
        );
        results.push({
          email: checkout.email,
          checkoutId: checkout.checkout_id,
          ...result
        });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`Error verifying checkout ${checkout.checkout_id}:`, error);
        results.push({
          email: checkout.email,
          checkoutId: checkout.checkout_id,
          success: false,
          error: error.message
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      message: `Verified ${pendingCheckouts.length} checkout(s): ${successful} activated, ${failed} failed`,
      total: pendingCheckouts.length,
      successful,
      failed,
      results
    });
  } catch (error) {
    console.error('Error verifying all pending checkouts:', error);
    res.status(500).json({ error: 'Failed to verify pending checkouts', message: error.message });
  }
});

// Admin endpoint: Update all users to active status
router.post('/admin/update-all-active', async (req, res) => {
  try {
    const supabase = require('../utils/supabaseClient');
    const TABLE_NAME = process.env.SUPABASE_PLAN_TABLE || 'user_plans';

    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    // Get count before update
    const { count: beforeCount } = await supabase
      .from(TABLE_NAME)
      .select('*', { count: 'exact', head: true });

    // Update all users to active
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .update({
        plan_status: 'active',
        updated_at: new Date().toISOString()
      })
      .neq('email', '')
      .select();

    if (error) {
      console.error('Error updating all users:', error);
      return res.status(500).json({ error: 'Failed to update users', message: error.message });
    }

    // Verify update
    const { count: activeCount } = await supabase
      .from(TABLE_NAME)
      .select('*', { count: 'exact', head: true })
      .eq('plan_status', 'active');

    res.json({
      success: true,
      message: `Successfully updated all users to active status`,
      beforeCount: beforeCount || 0,
      updatedCount: data?.length || 0,
      activeCount: activeCount || 0,
      updatedUsers: data || []
    });
  } catch (error) {
    console.error('Error in update-all-active endpoint:', error);
    res.status(500).json({ error: 'Failed to update users', message: error.message });
  }
});

module.exports = router;

