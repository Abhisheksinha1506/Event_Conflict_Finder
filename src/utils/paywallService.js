const supabase = require('./supabaseClient');

const TABLE_NAME = process.env.SUPABASE_PLAN_TABLE || 'user_plans';
const FREE_SEARCH_LIMIT = parseInt(process.env.FREE_SEARCH_LIMIT || process.env.FREEMIUM_SEARCH_LIMIT || '3', 10);

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function paywallUnavailable() {
  return !supabase;
}

async function getUserRecord(email) {
  if (paywallUnavailable()) {
    return null;
  }

  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('*')
    .eq('email', normalized)
    .single();

  if (error && error.code !== 'PGRST116') { // record not found
    console.error('Supabase getUserRecord error:', error);
    throw new Error('Failed to read user plan');
  }

  return data || null;
}

async function ensureUserRecord(email) {
  if (paywallUnavailable()) {
    return null;
  }

  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const existing = await getUserRecord(normalized);
  if (existing) return existing;

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert({
      email: normalized,
      plan_status: 'free',
      search_count: 0
    })
    .select()
    .single();

  if (error) {
    console.error('Supabase ensureUserRecord insert error:', error);
    throw new Error('Failed to create user plan record');
  }

  return data;
}

async function recordSearchUsage(email) {
  if (paywallUnavailable()) {
    return { allowed: true, reason: 'paywall_disabled' };
  }

  const normalized = normalizeEmail(email);
  if (!normalized) {
    return { allowed: false, reason: 'missing_email' };
  }

  const user = await ensureUserRecord(normalized);
  if (user.plan_status === 'active') {
    return { allowed: true, planStatus: 'active', searchCount: user.search_count || 0 };
  }

  const currentCount = user.search_count || 0;
  if (currentCount >= FREE_SEARCH_LIMIT) {
    return { allowed: false, planStatus: user.plan_status || 'free', searchCount: currentCount };
  }

  const newCount = currentCount + 1;
  const { error } = await supabase
    .from(TABLE_NAME)
    .update({ search_count: newCount })
    .eq('email', normalized);

  if (error) {
    console.error('Supabase recordSearchUsage update error:', error);
    return { allowed: false, reason: 'storage_error', message: error.message };
  }

  return {
    allowed: true,
    planStatus: user.plan_status || 'free',
    searchCount: newCount
  };
}

async function checkCheckoutStatusFromPolar(checkoutId) {
  const POLAR_API_BASE_URL = process.env.POLAR_API_BASE_URL || 'https://api.polar.sh/v1';
  const POLAR_API_KEY = process.env.POLAR_API_KEY;
  
  if (!POLAR_API_KEY || !checkoutId) {
    return null;
  }

  try {
    const fetch = require('node-fetch');
    const response = await fetch(`${POLAR_API_BASE_URL}/checkout-links/${checkoutId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLAR_API_KEY}`
      }
    });

    if (!response.ok) {
      console.warn(`Failed to fetch checkout status for ${checkoutId}:`, response.status);
      return null;
    }

    const data = await response.json();
    const checkout = data?.data || data;
    const attributes = checkout?.attributes || checkout;
    
    // Check if payment is completed/succeeded
    const status = attributes?.status || checkout?.status;
    const isPaid = status === 'paid' || status === 'completed' || status === 'succeeded' || 
                   attributes?.paid === true || checkout?.paid === true;
    
    return {
      isPaid,
      status,
      email: attributes?.customer_email || checkout?.customer_email
    };
  } catch (error) {
    console.error('Error checking Polar checkout status:', error);
    return null;
  }
}

async function getPlanStatus(email, autoVerifyPending = true) {
  if (paywallUnavailable()) {
    return {
      planStatus: 'unknown',
      allowed: true,
      reason: 'paywall_disabled'
    };
  }

  const normalized = normalizeEmail(email);
  if (!normalized) {
    return { planStatus: 'unknown', allowed: false, reason: 'missing_email' };
  }

  const user = await ensureUserRecord(normalized);
  
  // If status is pending and we have a checkout_id, verify payment status from Polar
  if (autoVerifyPending && user.plan_status === 'pending' && user.checkout_id) {
    console.log(`🔍 Checking payment status for pending checkout: ${user.checkout_id}`);
    const checkoutStatus = await checkCheckoutStatusFromPolar(user.checkout_id);
    
    if (checkoutStatus && checkoutStatus.isPaid) {
      console.log(`✅ Payment confirmed for ${normalized}, activating plan`);
      await activatePlan(normalized, user.checkout_id);
      // Re-fetch user record to get updated status
      const updatedUser = await getUserRecord(normalized);
      return {
        planStatus: updatedUser?.plan_status || 'active',
        searchCount: updatedUser?.search_count || 0,
        allowed: true,
        freeSearchLimit: FREE_SEARCH_LIMIT
      };
    } else if (checkoutStatus) {
      console.log(`⏳ Checkout ${user.checkout_id} status: ${checkoutStatus.status} (not paid yet)`);
    }
  }
  
  return {
    planStatus: user.plan_status || 'free',
    searchCount: user.search_count || 0,
    allowed: user.plan_status === 'active' || (user.search_count || 0) < FREE_SEARCH_LIMIT,
    freeSearchLimit: FREE_SEARCH_LIMIT
  };
}

async function markCheckoutInitiated(email, checkoutId) {
  if (paywallUnavailable()) return;
  const normalized = normalizeEmail(email);
  if (!normalized) return;

  const { error } = await supabase
    .from(TABLE_NAME)
    .upsert({
      email: normalized,
      plan_status: 'pending',
      checkout_id: checkoutId,
      updated_at: new Date().toISOString()
    }, { onConflict: 'email' });

  if (error) {
    console.error('Supabase markCheckoutInitiated error:', error);
  }
}

async function activatePlan(email, checkoutId) {
  if (paywallUnavailable()) return;
  const normalized = normalizeEmail(email);
  if (!normalized) return;

  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      plan_status: 'active',
      checkout_id: checkoutId || null,
      search_count: 0,
      updated_at: new Date().toISOString()
    })
    .eq('email', normalized);

  if (error) {
    console.error('Supabase activatePlan error:', error);
  }
}

module.exports = {
  FREE_SEARCH_LIMIT,
  paywallUnavailable,
  recordSearchUsage,
  getPlanStatus,
  markCheckoutInitiated,
  activatePlan,
  normalizeEmail
};

