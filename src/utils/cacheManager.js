const redis = require('redis');

/**
 * Cache Manager using Redis
 * Handles caching of API responses with 15-minute TTL
 */
class CacheManager {
  constructor() {
    this.client = null;
    this.connected = false;
    this.cacheStats = {
      hits: 0,
      misses: 0,
      sets: 0,
      errors: 0
    };
    this.defaultTTL = parseInt(process.env.CACHE_TTL_SECONDS) || 900; // 15 minutes default
    this.init();
  }

  async init() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.client = redis.createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error('Redis: Max reconnection attempts reached');
              return new Error('Max reconnection attempts');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
        this.connected = false;
        this.cacheStats.errors++;
      });

      this.client.on('connect', () => {
        console.log('✅ Redis connected');
        this.connected = true;
      });

      this.client.on('ready', () => {
        console.log('✅ Redis ready');
        this.connected = true;
      });

      this.client.on('end', () => {
        console.log('Redis connection ended');
        this.connected = false;
      });

      await this.client.connect();
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
      console.warn('⚠️  Caching disabled. Application will continue without cache.');
      this.connected = false;
    }
  }

  /**
   * Generate cache key from API name and location parameters
   */
  generateKey(apiName, lat, lon, radius) {
    // Round coordinates to 4 decimal places (~11 meters precision) for better cache hits
    const roundedLat = parseFloat(lat).toFixed(4);
    const roundedLon = parseFloat(lon).toFixed(4);
    const roundedRadius = Math.round(parseFloat(radius));
    return `events:${apiName}:${roundedLat}:${roundedLon}:${roundedRadius}`;
  }

  /**
   * Get cached data
   */
  async get(apiName, lat, lon, radius) {
    if (!this.connected || !this.client) {
      return null;
    }

    try {
      const key = this.generateKey(apiName, lat, lon, radius);
      const data = await this.client.get(key);
      
      if (data) {
        try {
          const parsed = JSON.parse(data);
          this.cacheStats.hits++;
          return parsed;
        } catch (parseError) {
          // Corrupted cache data, delete it and return null
          console.warn('Cache data corrupted, deleting key:', key);
          await this.client.del(key);
          this.cacheStats.misses++;
          this.cacheStats.errors++;
          return null;
        }
      } else {
        this.cacheStats.misses++;
        return null;
      }
    } catch (error) {
      console.error('Cache get error:', error.message);
      this.cacheStats.errors++;
      this.cacheStats.misses++;
      return null;
    }
  }

  /**
   * Set cached data with TTL
   */
  async set(apiName, lat, lon, radius, data, ttl = null) {
    if (!this.connected || !this.client) {
      return false;
    }

    try {
      const key = this.generateKey(apiName, lat, lon, radius);
      const ttlSeconds = ttl || this.defaultTTL;
      
      // Validate data before serializing
      if (data === undefined || data === null) {
        console.warn('Attempted to cache null/undefined data');
        return false;
      }
      
      const serialized = JSON.stringify(data);
      
      // Check if serialized data is too large (Redis has limits)
      if (serialized.length > 512 * 1024 * 1024) { // 512MB limit
        console.warn('Cache data too large, skipping cache');
        return false;
      }
      
      await this.client.setEx(key, ttlSeconds, serialized);
      this.cacheStats.sets++;
      return true;
    } catch (error) {
      console.error('Cache set error:', error.message);
      this.cacheStats.errors++;
      return false;
    }
  }

  /**
   * Delete cached data
   */
  async delete(apiName, lat, lon, radius) {
    if (!this.connected || !this.client) {
      return false;
    }

    try {
      const key = this.generateKey(apiName, lat, lon, radius);
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error('Cache delete error:', error.message);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? ((this.cacheStats.hits / total) * 100).toFixed(2) : 0;
    
    return {
      ...this.cacheStats,
      total,
      hitRate: `${hitRate}%`,
      connected: this.connected
    };
  }

  /**
   * Clear all cache (use with caution)
   */
  async clear() {
    if (!this.connected || !this.client) {
      return false;
    }

    try {
      const keys = await this.client.keys('events:*');
      if (keys && keys.length > 0) {
        // Redis v4 del accepts array directly
        if (Array.isArray(keys)) {
          await this.client.del(keys);
        } else {
          // Fallback for single key
          await this.client.del([keys]);
        }
      }
      return true;
    } catch (error) {
      console.error('Cache clear error:', error.message);
      return false;
    }
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
module.exports = new CacheManager();

