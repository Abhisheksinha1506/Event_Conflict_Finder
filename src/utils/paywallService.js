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

  // Do NOT create user record - only check if it exists
  // User records are ONLY created when payment succeeds (via activatePlan)
  const user = await getUserRecord(normalized);
  
  // If user doesn't exist, they haven't paid yet - require payment
  if (!user) {
    return { allowed: false, reason: 'payment_required', planStatus: 'unknown' };
  }

  // User exists - check their plan status
  if (user.plan_status === 'active') {
    return { allowed: true, planStatus: 'active', searchCount: user.search_count || 0 };
  }

  // User has 'free' status - check search limit
  const currentCount = user.search_count || 0;
  if (currentCount >= FREE_SEARCH_LIMIT) {
    return { allowed: false, planStatus: user.plan_status || 'free', searchCount: currentCount };
  }

  // Increment search count for free users
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

    // This is the CORRECT and ONLY reliable endpoint
    const response = await fetch(`${POLAR_API_BASE_URL}/checkout-links/${checkoutId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLAR_API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.warn(`Polar API error ${response.status} for checkout ${checkoutId}:`, errorText);
      return null;
    }

    const json = await response.json();
    const checkout = json?.data || json;

    if (!checkout) {
      console.warn(`No checkout data returned from Polar for ${checkoutId}`);
      return null;
    }

    // This is the key field! Status can be: draft, open, pending, succeeded, failed, canceled, expired
    const status = checkout.status;
    const normalizedStatus = (status || '').toLowerCase();
    const paidStatuses = new Set(['succeeded', 'paid', 'completed', 'confirmed']);
    const isPaid = paidStatuses.has(normalizedStatus);
    
    // Extract email - prioritize customer_email field, fallback to success_url parsing
    let email = checkout.customer_email || null;
    
    if (!email && checkout.success_url) {
      try {
        const url = new URL(checkout.success_url);
        // url.searchParams.get() already decodes URL-encoded values
        email = url.searchParams.get('email') || url.searchParams.get('customer_email');
      } catch (e) {
        // If URL parsing fails, try regex and decode manually
        const emailMatch = checkout.success_url.match(/[?&]email=([^&]+)/i);
        if (emailMatch) {
          email = decodeURIComponent(emailMatch[1]);
        }
      }
    }

    console.log(`💰 Checkout ${checkoutId} → Status: ${status}, Paid: ${isPaid}, Email: ${email || 'unknown'}`);

    return {
      isPaid,
      status: status || 'unknown',
      email: email || null,
      order_id: checkout.order_id || null,
      customer_id: checkout.customer_id || null,
    };
  } catch (error) {
    console.error('Error checking Polar checkout status:', error);
    console.error('Error stack:', error.stack);
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

  // Do NOT create user record - only check if it exists
  // User records are ONLY created when payment succeeds (via activatePlan)
  const user = await getUserRecord(normalized);
  
  // If user doesn't exist, they haven't paid yet - require payment
  if (!user) {
    return {
      planStatus: 'unknown',
      allowed: false,
      reason: 'payment_required',
      freeSearchLimit: FREE_SEARCH_LIMIT
    };
  }
  
  // Handle legacy pending records (for backward compatibility)
  // Convert pending to free if payment not confirmed
  if (user.plan_status === 'pending' && user.checkout_id) {
    if (autoVerifyPending) {
      console.log(`🔍 Checking payment status for legacy pending checkout: ${user.checkout_id}`);
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
      } else {
        // Payment not confirmed - convert pending to free (preserve search_count)
        console.log(`⏳ Checkout ${user.checkout_id} status: ${checkoutStatus?.status || 'unknown'} - Converting pending to free`);
        const { error } = await supabase
          .from(TABLE_NAME)
          .update({
            plan_status: 'free',
            checkout_id: null // Clear checkout_id since payment not confirmed
          })
          .eq('email', normalized);
        
        if (error) {
          console.error('Error converting pending to free:', error);
        }
        
        // Return free status with preserved search_count
        return {
          planStatus: 'free',
          searchCount: user.search_count || 0,
          allowed: (user.search_count || 0) < FREE_SEARCH_LIMIT,
          freeSearchLimit: FREE_SEARCH_LIMIT
        };
      }
    }
  }
  
  // Normal flow: only 'active' or 'free' states exist
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

  // Don't create database record or change status when checkout is initiated
  // Only log it. Database record will be created ONLY when payment succeeds (via activatePlan)
  console.log(`🛒 Checkout initiated for ${normalized} (checkout: ${checkoutId})`);
  
  // If user already exists, don't modify their record - keep current state
  // If user doesn't exist, they will NOT be created until payment succeeds
  // Payment success (via activatePlan) will be the ONLY time we create records with 'active' status
}

async function activatePlan(email, checkoutId) {
  if (paywallUnavailable()) {
    console.error('❌ CRITICAL: Paywall unavailable - Supabase not configured!');
    console.error('   SUPABASE_URL:', process.env.SUPABASE_URL ? 'set' : 'missing');
    console.error('   SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'missing');
    throw new Error('Paywall unavailable - Supabase not configured');
  }
  
  const normalized = normalizeEmail(email);
  if (!normalized) {
    console.error('❌ CRITICAL: Cannot activate plan - invalid email:', email);
    throw new Error('Invalid email address');
  }

  console.log(`🔄 activatePlan called: email=${normalized}, checkoutId=${checkoutId || 'none'}`);
  console.log(`📊 Table name: ${TABLE_NAME}`);

  // ONLY create/update database record when payment succeeds
  // This is the ONLY place where we set plan_status to 'active'
  try {
    const { data, error } = await supabase
    .from(TABLE_NAME)
    .upsert({
      email: normalized,
      plan_status: 'active',
      checkout_id: checkoutId || null,
      search_count: 0, // Reset search count when payment succeeds
      updated_at: new Date().toISOString()
    }, { 
      onConflict: 'email',
      ignoreDuplicates: false
      })
      .select();

  if (error) {
      console.error('❌ Supabase activatePlan error:', error);
      console.error('   Error code:', error.code);
      console.error('   Error message:', error.message);
      console.error('   Error details:', error.details);
    throw error;
  }
  
  console.log(`✅ Plan activated for ${normalized}${checkoutId ? ` (checkout: ${checkoutId})` : ''}`);
    console.log(`📦 Upsert result:`, data);
  
  // Verify the update was successful
  const updated = await getUserRecord(normalized);
    if (updated) {
      console.log(`🔍 Verification - Retrieved record:`, {
        email: updated.email,
        plan_status: updated.plan_status,
        search_count: updated.search_count,
        checkout_id: updated.checkout_id
      });
      
      if (updated.plan_status !== 'active') {
        console.error(`❌ CRITICAL: Plan status update failed! Expected 'active', got '${updated.plan_status}'`);
        throw new Error(`Plan activation failed - status is '${updated.plan_status}' instead of 'active'`);
      } else {
        console.log(`✅ Verification successful - plan_status is 'active'`);
      }
    } else {
      console.error('❌ CRITICAL: Verification failed - record not found after activation!');
      throw new Error('Record not found after activation');
    }
  } catch (error) {
    console.error('❌ activatePlan exception:', error.message);
    console.error('❌ Stack trace:', error.stack);
    throw error;
  }
}

async function markPaymentFailed(email, checkoutId, reason = null) {
  if (paywallUnavailable()) return;
  const normalized = normalizeEmail(email);
  if (!normalized) return;

  // Don't update database when payment fails
  // Keep user's current state (search_count, plan_status) unchanged
  // Only log the failure for debugging
  console.log(`❌ Payment failed for ${normalized}${checkoutId ? ` (checkout: ${checkoutId})` : ''}${reason ? ` - ${reason}` : ''}`);
  console.log(`   → User's current state preserved (search_count and plan_status unchanged)`);
}

async function deactivatePlan(email, reason = 'revoked') {
  if (paywallUnavailable()) {
    console.warn('Paywall unavailable while attempting to deactivate plan');
    return;
  }

  const normalized = normalizeEmail(email);
  if (!normalized) {
    console.warn('Cannot deactivate plan for invalid email:', email);
    return;
  }

  try {
    console.log(`🔻 Deactivating plan for ${normalized} (reason: ${reason})`);
    const { error } = await supabase
      .from(TABLE_NAME)
      .update({
        plan_status: 'free',
        checkout_id: null,
        search_count: 0,
        updated_at: new Date().toISOString()
      })
      .eq('email', normalized);

    if (error) {
      console.error('Supabase deactivatePlan error:', error);
    } else {
      console.log(`✅ Plan set to free for ${normalized}`);
    }
  } catch (error) {
    console.error('❌ deactivatePlan exception:', error.message);
  }
}

async function getAllPendingCheckouts() {
  if (paywallUnavailable()) {
    return [];
  }

  try {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('email, checkout_id, plan_status, updated_at')
      .eq('plan_status', 'pending')
      .not('checkout_id', 'is', null);

    if (error) {
      console.error('Supabase getAllPendingCheckouts error:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Error fetching pending checkouts:', error);
    return [];
  }
}

async function verifyAndActivatePendingCheckout(email, checkoutId) {
  if (!checkoutId) {
    return { success: false, error: 'No checkout ID provided' };
  }

  console.log(`🔍 Verifying pending checkout for ${email}: ${checkoutId}`);
  const checkoutStatus = await checkCheckoutStatusFromPolar(checkoutId);
  
  if (!checkoutStatus) {
    return { 
      success: false, 
      error: 'Could not fetch checkout status from Polar',
      email,
      checkoutId
    };
  }

  if (checkoutStatus.isPaid) {
    // Use email from checkout if available, otherwise use provided email
    const emailToUse = checkoutStatus.email || email;
    if (emailToUse) {
      await activatePlan(emailToUse, checkoutId);
      return {
        success: true,
        message: 'Payment confirmed and plan activated',
        email: emailToUse,
        checkoutId,
        checkoutStatus
      };
    } else {
      return {
        success: false,
        error: 'No email found in checkout status',
        checkoutId,
        checkoutStatus
      };
    }
  } else {
    return {
      success: false,
      error: `Payment not confirmed. Status: ${checkoutStatus.status}`,
      email,
      checkoutId,
      checkoutStatus
    };
  }
}

module.exports = {
  FREE_SEARCH_LIMIT,
  paywallUnavailable,
  recordSearchUsage,
  getPlanStatus,
  markCheckoutInitiated,
  activatePlan,
  markPaymentFailed,
  deactivatePlan,
  normalizeEmail,
  checkCheckoutStatusFromPolar,
  getAllPendingCheckouts,
  verifyAndActivatePendingCheckout
};

