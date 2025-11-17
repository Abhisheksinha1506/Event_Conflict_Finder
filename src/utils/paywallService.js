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

async function getPlanStatus(email) {
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

