const fetch = require('node-fetch');

class UrlValidator {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = parseInt(process.env.URL_VALIDATION_TTL || '3600000', 10); // 1 hour default
    this.requestTimeoutMs = parseInt(process.env.URL_VALIDATION_TIMEOUT || '4000', 10);
  }

  getCache(url) {
    const cached = this.cache.get(url);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
      return cached.valid;
    }
    return null;
  }

  setCache(url, valid) {
    this.cache.set(url, { valid, timestamp: Date.now() });
  }

  async isReachable(url) {
    if (!url) {
      return false;
    }

    const cached = this.getCache(url);
    if (cached !== null) {
      return cached;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal
      });

      clearTimeout(timeout);

      // Treat explicit 404/410 as invalid. Everything else (including 403) we keep.
      const valid = response.status !== 404 && response.status !== 410;
      this.setCache(url, valid);
      return valid;
    } catch (error) {
      clearTimeout(timeout);
      // On network errors/timeouts, assume valid to avoid hiding legitimate events.
      console.warn(`URL validation skipped for ${url}: ${error.message}`);
      this.setCache(url, true);
      return true;
    }
  }
}

module.exports = new UrlValidator();





