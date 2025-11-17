const FREE_SEARCH_LIMIT = parseInt(
  process.env.FREE_SEARCH_LIMIT ||
  process.env.FREEMIUM_SEARCH_LIMIT ||
  '3',
  10
);

const FREE_SEARCH_WINDOW_MS = parseInt(
  process.env.FREE_SEARCH_WINDOW_MS ||
  process.env.FREEMIUM_SEARCH_WINDOW_MS ||
  (24 * 60 * 60 * 1000).toString(), // 24 hours default
  10
);

/**
 * In-memory fallback tracker for free searches when Supabase (paywall storage)
 * isn't available or when a user hasn't provided an email address yet.
 * The tracker resets counts after the configured rolling window.
 */
class FreeSearchLimiter {
  constructor() {
    this.usage = new Map();
  }

  /**
   * Record a search for the provided identifier.
   * @param {string} identifier - user identifier (email/ip/userId).
   * @returns {{allowed:boolean, searchCount:number, freeSearchLimit:number, planStatus:string}}
   */
  recordSearch(identifier) {
    if (!identifier) {
      return {
        allowed: true,
        planStatus: 'free',
        searchCount: 0,
        freeSearchLimit: FREE_SEARCH_LIMIT,
        reason: 'missing_identifier'
      };
    }

    const now = Date.now();
    let entry = this.usage.get(identifier);

    if (!entry || now >= entry.expiresAt) {
      entry = {
        count: 0,
        expiresAt: now + FREE_SEARCH_WINDOW_MS
      };
    }

    if (entry.count >= FREE_SEARCH_LIMIT) {
      this.usage.set(identifier, entry);
      return {
        allowed: false,
        planStatus: 'free',
        searchCount: entry.count,
        freeSearchLimit: FREE_SEARCH_LIMIT
      };
    }

    entry.count += 1;
    this.usage.set(identifier, entry);

    return {
      allowed: true,
      planStatus: 'free',
      searchCount: entry.count,
      freeSearchLimit: FREE_SEARCH_LIMIT
    };
  }

  /**
   * Reset the stored usage for a specific identifier (used after upgrades).
   */
  reset(identifier) {
    if (identifier) {
      this.usage.delete(identifier);
    }
  }
}

module.exports = new FreeSearchLimiter();

