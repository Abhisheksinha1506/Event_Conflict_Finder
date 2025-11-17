#!/usr/bin/env node

/**
 * Manual Webhook Testing Script
 * 
 * This script allows you to test Polar webhooks locally without needing
 * a public URL or tunneling service.
 * 
 * Usage:
 *   node test-webhook.js customer.updated test@example.com
 *   node test-webhook.js checkout.succeeded test@example.com checkout-id-123
 *   node test-webhook.js checkout.updated test@example.com checkout-id-123
 */

require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/api/paywall/webhook';
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;

// Event type templates
const eventTemplates = {
  'customer.updated': {
    type: 'customer.updated',
    timestamp: new Date().toISOString(),
    data: {
      id: 'f6778417-e5d0-47ec-9841-eea089840d25',
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
      metadata: {},
      external_id: null,
      email: '', // Will be filled from args
      email_verified: false,
      name: 'Test User',
      billing_address: {
        line1: null,
        line2: null,
        postal_code: null,
        city: null,
        state: null,
        country: 'US'
      },
      tax_id: null,
      organization_id: '73cf086f-1f9b-4311-ab2a-da1968d8c9f4',
      deleted_at: null,
      avatar_url: null
    }
  },
  'checkout.succeeded': {
    type: 'checkout.succeeded',
    timestamp: new Date().toISOString(),
    data: {
      id: '', // Will be filled from args
      status: 'succeeded',
      customer_email: '', // Will be filled from args
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  },
  'checkout.updated': {
    type: 'checkout.updated',
    timestamp: new Date().toISOString(),
    data: {
      id: '', // Will be filled from args
      status: 'succeeded', // or 'pending', 'failed', etc.
      customer_email: '', // Will be filled from args
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  },
  'benefit_grant.created': {
    type: 'benefit_grant.created',
    timestamp: new Date().toISOString(),
    data: {
      order_id: '', // Will be filled from args
      customer: {
        email: '' // Will be filled from args
      }
    }
  }
};

function generateSignature(payload, secret) {
  if (!secret) {
    return null;
  }
  
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadString = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  
  return `t=${timestamp},v1=${signature}`;
}

async function testWebhook(eventType, email, checkoutId = null) {
  console.log('\n🧪 Testing Webhook');
  console.log('='.repeat(60));
  console.log(`Event Type: ${eventType}`);
  console.log(`Email: ${email}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log('='.repeat(60));

  // Get event template
  const template = eventTemplates[eventType];
  if (!template) {
    console.error(`❌ Unknown event type: ${eventType}`);
    console.log(`\nAvailable event types: ${Object.keys(eventTemplates).join(', ')}`);
    process.exit(1);
  }

  // Create payload from template
  const payload = JSON.parse(JSON.stringify(template));
  
  // Fill in email
  if (eventType === 'customer.updated') {
    payload.data.email = email;
  } else if (eventType === 'benefit_grant.created') {
    payload.data.customer.email = email;
    payload.data.order_id = checkoutId || `test-checkout-${Date.now()}`;
  } else {
    payload.data.customer_email = email;
    payload.data.id = checkoutId || `test-checkout-${Date.now()}`;
  }

  // Generate signature if secret is configured
  const signature = generateSignature(payload, POLAR_WEBHOOK_SECRET);
  
  // Prepare headers
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (signature) {
    headers['polar-signature'] = signature;
    console.log('✅ Signature generated');
  } else {
    console.log('⚠️  No webhook secret configured - sending without signature');
  }

  console.log('\n📤 Sending webhook payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('\n');

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseData;
    
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      responseData = { raw: responseText };
    }

    console.log(`📥 Response Status: ${response.status} ${response.statusText}`);
    console.log('📥 Response Body:');
    console.log(JSON.stringify(responseData, null, 2));

    if (response.ok) {
      console.log('\n✅ Webhook test successful!');
    } else {
      console.log('\n❌ Webhook test failed!');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Error sending webhook:');
    console.error(error.message);
    console.error('\n💡 Make sure your server is running:');
    console.error('   npm run dev');
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node test-webhook.js <event-type> <email> [checkout-id]');
  console.log('\nExamples:');
  console.log('  node test-webhook.js customer.updated test@example.com');
  console.log('  node test-webhook.js checkout.succeeded test@example.com checkout-123');
  console.log('  node test-webhook.js checkout.updated test@example.com checkout-123');
  console.log('  node test-webhook.js benefit_grant.created test@example.com checkout-123');
  console.log('\nAvailable event types:');
  Object.keys(eventTemplates).forEach(type => {
    console.log(`  - ${type}`);
  });
  process.exit(1);
}

const [eventType, email, checkoutId] = args;

// Validate email format (basic)
if (!email.includes('@')) {
  console.error('❌ Invalid email format');
  process.exit(1);
}

// Run the test
testWebhook(eventType, email, checkoutId).catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});

