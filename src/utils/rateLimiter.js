const rateLimits = require('../config/rateLimits');
const redis = require('redis');

/**
 * Rate Limiter with per-user and global pool tracking
 * Uses Redis for distributed rate limiting across multiple instances
 */
class RateLimiter {
  constructor() {
    this.client = null;
    this.connected = false;
    this.fallbackLimits = new Map(); // In-memory fallback if Redis unavailable
    this.init();
  }

  async init() {
    // Skip Redis connection if REDIS_URL is not set (common in serverless environments)
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || redisUrl === 'redis://localhost:6379') {
      // Only warn if explicitly trying to use localhost in production
      if (process.env.NODE_ENV === 'production' && redisUrl === 'redis://localhost:6379') {
        console.warn('⚠️  Rate Limiter: Redis URL not configured. Using in-memory fallback. Set REDIS_URL for distributed rate limiting.');
      } else if (!redisUrl) {
        console.warn('⚠️  Rate Limiter: Redis URL not configured. Using in-memory fallback. Set REDIS_URL for distributed rate limiting.');
      }
      this.connected = false;
      return;
    }

    try {
      this.client = redis.createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              return new Error('Max reconnection attempts');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      // Only log errors once to reduce log noise
      let errorLogged = false;
      this.client.on('error', (err) => {
        if (!errorLogged) {
          console.error('Rate Limiter Redis Error:', err.message);
          errorLogged = true;
        }
        this.connected = false;
      });

      this.client.on('connect', () => {
        this.connected = true;
      });

      await this.client.connect();
      console.log('✅ Rate Limiter Redis connected');
    } catch (error) {
      console.warn('⚠️  Rate Limiter: Redis unavailable, using in-memory fallback');
      this.connected = false;
    }
  }

  /**
   * Generate user identifier from request
   */
  getUserIdentifier(req) {
    // Use IP address as user identifier (can be enhanced with user ID if authenticated)
    return req.ip || req.connection?.remoteAddress || 'unknown';
  }

  /**
   * Check if request is allowed (per-user limit)
   */
  async checkUserLimit(apiName, userId) {
    const config = rateLimits[apiName];
    if (!config) return { allowed: true, waitTime: 0 };

    const userKey = `ratelimit:user:${apiName}:${userId}`;
    const limit = config.perUserPerHour;

    try {
      if (this.connected && this.client) {
        // Use Redis with sliding window
        const current = await this.client.incr(userKey);
        if (current === 1) {
          await this.client.expire(userKey, 3600); // 1 hour
        }

        if (current > limit) {
          const ttl = await this.client.ttl(userKey);
          return { allowed: false, waitTime: ttl, reason: 'user_limit' };
        }

        return { allowed: true, waitTime: 0 };
      } else {
        // Fallback to in-memory
        return this.checkUserLimitFallback(apiName, userId, limit);
      }
    } catch (error) {
      console.error(`Rate limit check error for ${apiName}:`, error.message);
      // On error, allow request but log warning
      return { allowed: true, waitTime: 0, error: true };
    }
  }

  /**
   * In-memory fallback for user limits
   */
  checkUserLimitFallback(apiName, userId, limit) {
    const key = `${apiName}:${userId}`;
    const now = Date.now();
    const hourAgo = now - 3600000;

    if (!this.fallbackLimits.has(key)) {
      this.fallbackLimits.set(key, []);
    }

    const requests = this.fallbackLimits.get(key);
    // Remove requests older than 1 hour
    const recentRequests = requests.filter(timestamp => timestamp > hourAgo);
    
    if (recentRequests.length >= limit) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = Math.ceil((oldestRequest + 3600000 - now) / 1000);
      return { allowed: false, waitTime, reason: 'user_limit' };
    }

    recentRequests.push(now);
    this.fallbackLimits.set(key, recentRequests);
    return { allowed: true, waitTime: 0 };
  }

  /**
   * Check global pool quota
   */
  async checkGlobalQuota(apiName) {
    const config = rateLimits[apiName];
    if (!config) return { allowed: true, waitTime: 0, quotaUsed: 0 };

    const globalKey = `ratelimit:global:${apiName}`;
    const quotaKey = `ratelimit:quota:${apiName}`;

    try {
      if (this.connected && this.client) {
        // Check if we're using daily or hourly quota
        const isDaily = config.dailyQuota !== undefined;
        const quota = isDaily ? config.dailyQuota : config.hourlyQuota;
        const window = isDaily ? 86400 : 3600; // seconds

        // Get current usage
        const current = await this.client.incr(quotaKey);
        if (current === 1) {
          await this.client.expire(quotaKey, window);
        }

        const quotaUsed = current / quota;
        const queueThreshold = config.queueThreshold || 0.8;

        // If over quota, deny
        if (current > quota) {
          const ttl = await this.client.ttl(quotaKey);
          return { 
            allowed: false, 
            waitTime: ttl, 
            quotaUsed: 1.0,
            reason: 'quota_exceeded' 
          };
        }

        // If approaching threshold, indicate queuing needed
        if (quotaUsed >= queueThreshold) {
          return { 
            allowed: true, 
            waitTime: 0, 
            quotaUsed,
            shouldQueue: true,
            reason: 'approaching_limit' 
          };
        }

        return { allowed: true, waitTime: 0, quotaUsed };
      } else {
        // Fallback to in-memory
        return this.checkGlobalQuotaFallback(apiName, config);
      }
    } catch (error) {
      console.error(`Global quota check error for ${apiName}:`, error.message);
      return { allowed: true, waitTime: 0, quotaUsed: 0, error: true };
    }
  }

  /**
   * In-memory fallback for global quota
   */
  checkGlobalQuotaFallback(apiName, config) {
    const key = `global:${apiName}`;
    const now = Date.now();
    const isDaily = config.dailyQuota !== undefined;
    const window = isDaily ? 86400000 : 3600000; // milliseconds
    const quota = isDaily ? config.dailyQuota : config.hourlyQuota;
    const windowStart = now - window;

    if (!this.fallbackLimits.has(key)) {
      this.fallbackLimits.set(key, []);
    }

    const requests = this.fallbackLimits.get(key);
    const recentRequests = requests.filter(timestamp => timestamp > windowStart);
    
    const quotaUsed = recentRequests.length / quota;
    const queueThreshold = config.queueThreshold || 0.8;

    if (recentRequests.length >= quota) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = Math.ceil((oldestRequest + window - now) / 1000);
      return { 
        allowed: false, 
        waitTime, 
        quotaUsed: 1.0,
        reason: 'quota_exceeded' 
      };
    }

    if (quotaUsed >= queueThreshold) {
      return { 
        allowed: true, 
        waitTime: 0, 
        quotaUsed,
        shouldQueue: true,
        reason: 'approaching_limit' 
      };
    }

    recentRequests.push(now);
    this.fallbackLimits.set(key, recentRequests);
    return { allowed: true, waitTime: 0, quotaUsed };
  }

  /**
   * Check rate limit (requests per second/minute)
   */
  async checkRateLimit(apiName) {
    const config = rateLimits[apiName];
    if (!config) return { allowed: true, waitTime: 0 };

    const rateKey = `ratelimit:rate:${apiName}`;
    const isPerSecond = config.requestsPerSecond !== undefined;
    const rate = isPerSecond ? config.requestsPerSecond : config.requestsPerMinute;
    const window = isPerSecond ? 1 : 60; // seconds

    try {
      if (this.connected && this.client) {
        // Use sliding window log algorithm
        const now = Date.now();
        const windowStart = now - (window * 1000);
        
        // Remove old entries (Redis v4 API)
        await this.client.zRemRangeByScore(rateKey, 0, windowStart);
        
        // Count current requests in window
        const count = await this.client.zCard(rateKey);
        
        if (count >= rate) {
          // Get oldest request to calculate wait time
          // zRange returns array of values (strings) by default
          const oldest = await this.client.zRange(rateKey, 0, 0);
          if (oldest && oldest.length > 0) {
            // oldest[0] is the value (timestamp string)
            const oldestTime = parseInt(oldest[0]);
            if (!isNaN(oldestTime) && oldestTime > 0) {
              const waitTime = Math.ceil((oldestTime + (window * 1000) - now) / 1000);
              return { allowed: false, waitTime: Math.max(0, waitTime), reason: 'rate_limit' };
            }
          }
          // If we can't calculate wait time, still deny the request
          return { allowed: false, waitTime: window, reason: 'rate_limit' };
        }

        // Add current request (Redis v4 API - zAdd accepts array of objects)
        await this.client.zAdd(rateKey, { score: now, value: `${now}` });
        await this.client.expire(rateKey, window);
        
        return { allowed: true, waitTime: 0 };
      } else {
        // Fallback to in-memory
        return this.checkRateLimitFallback(apiName, config, rate, window);
      }
    } catch (error) {
      console.error(`Rate limit check error for ${apiName}:`, error.message);
      return { allowed: true, waitTime: 0, error: true };
    }
  }

  /**
   * In-memory fallback for rate limiting
   */
  checkRateLimitFallback(apiName, config, rate, window) {
    const key = `rate:${apiName}`;
    const now = Date.now();
    const windowMs = window * 1000;
    const windowStart = now - windowMs;

    if (!this.fallbackLimits.has(key)) {
      this.fallbackLimits.set(key, []);
    }

    const requests = this.fallbackLimits.get(key);
    const recentRequests = requests.filter(timestamp => timestamp > windowStart);
    
    if (recentRequests.length >= rate) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = Math.ceil((oldestRequest + windowMs - now) / 1000);
      return { allowed: false, waitTime, reason: 'rate_limit' };
    }

    recentRequests.push(now);
    this.fallbackLimits.set(key, recentRequests);
    return { allowed: true, waitTime: 0 };
  }

  /**
   * Comprehensive check: user limit + global quota + rate limit
   */
  async checkAllLimits(apiName, userId) {
    // Check user limit
    const userCheck = await this.checkUserLimit(apiName, userId);
    if (!userCheck.allowed) {
      return userCheck;
    }

    // Check global quota
    const quotaCheck = await this.checkGlobalQuota(apiName);
    if (!quotaCheck.allowed) {
      return quotaCheck;
    }

    // Check rate limit
    const rateCheck = await this.checkRateLimit(apiName);
    if (!rateCheck.allowed) {
      return rateCheck;
    }

    // All checks passed
    return {
      allowed: true,
      waitTime: 0,
      quotaUsed: quotaCheck.quotaUsed,
      shouldQueue: quotaCheck.shouldQueue || false
    };
  }

  /**
   * Get quota status for monitoring
   */
  async getQuotaStatus(apiName) {
    const config = rateLimits[apiName];
    if (!config) return null;

    try {
      if (this.connected && this.client) {
        const isDaily = config.dailyQuota !== undefined;
        const quotaKey = `ratelimit:quota:${apiName}`;
        const current = await this.client.get(quotaKey) || 0;
        const quota = isDaily ? config.dailyQuota : config.hourlyQuota;
        const quotaUsed = parseInt(current) / quota;
        
        return {
          current: parseInt(current),
          quota,
          quotaUsed: quotaUsed.toFixed(2),
          percentage: (quotaUsed * 100).toFixed(2)
        };
      }
    } catch (error) {
      console.error(`Error getting quota status for ${apiName}:`, error.message);
    }
    
    return null;
  }

  /**
   * Gracefully close Redis connection
   */
  async close() {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

// Export singleton instance
module.exports = new RateLimiter();

