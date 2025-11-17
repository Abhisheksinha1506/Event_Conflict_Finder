const rateLimiter = require('./rateLimiter');
const cacheManager = require('./cacheManager');
const requestQueue = require('./requestQueue');

/**
 * Monitoring and Logging Utility
 * Provides status information about rate limits, cache, and queues
 */
class Monitoring {
  constructor() {
    this.logInterval = null;
    this.logIntervalMs = parseInt(process.env.MONITORING_LOG_INTERVAL) || 300000; // 5 minutes default
    this.performanceHistoryLimit = parseInt(process.env.MONITORING_PERF_HISTORY) || 25;
    this.performanceMetrics = {
      event_search: [],
      conflict_detection: [],
      conflict_detection_location: [],
      bandsintown_fanout: [],
      bandsintown_service: []
    };
  }

  /**
   * Get comprehensive status
   */
  async getStatus() {
    const status = {
      timestamp: new Date().toISOString(),
      cache: cacheManager.getStats(),
      queues: requestQueue.getStats(),
      rateLimits: {},
      performance: this.getPerformanceSnapshot()
    };

    // Get quota status for each API
    const apis = ['ticketmaster', 'bandsintown'];
    for (const api of apis) {
      const quotaStatus = await rateLimiter.getQuotaStatus(api);
      status.rateLimits[api] = quotaStatus;
    }

    return status;
  }

  /**
   * Log status periodically
   */
  startPeriodicLogging() {
    if (this.logInterval) {
      return; // Already started
    }

    this.logInterval = setInterval(async () => {
      const status = await this.getStatus();
      this.logStatus(status);
    }, this.logIntervalMs);

    // Log immediately
    this.getStatus()
      .then(status => this.logStatus(status))
      .catch(error => console.error('Monitoring: Error getting initial status:', error.message));
  }

  /**
   * Stop periodic logging
   */
  stopPeriodicLogging() {
    if (this.logInterval) {
      clearInterval(this.logInterval);
      this.logInterval = null;
    }
  }

  /**
   * Log status to console
   */
  logStatus(status) {
    console.log('\n' + '='.repeat(70));
    console.log('📊 SYSTEM STATUS');
    console.log('='.repeat(70));
    
    // Cache stats
    console.log('\n💾 Cache:');
    console.log(`   Connected: ${status.cache.connected ? '✅' : '❌'}`);
    console.log(`   Hits: ${status.cache.hits} | Misses: ${status.cache.misses} | Hit Rate: ${status.cache.hitRate}`);
    console.log(`   Sets: ${status.cache.sets} | Errors: ${status.cache.errors}`);

    // Rate limits
    console.log('\n🚦 Rate Limits:');
    Object.entries(status.rateLimits).forEach(([api, quota]) => {
      if (quota) {
        const percentage = parseFloat(quota.percentage);
        const indicator = percentage >= 80 ? '⚠️' : percentage >= 50 ? '⚡' : '✅';
        console.log(`   ${indicator} ${api}: ${quota.current}/${quota.quota} (${quota.percentage}%)`);
      } else {
        console.log(`   ⚠️  ${api}: Status unavailable`);
      }
    });

    // Queues
    console.log('\n📋 Request Queues:');
    const queueEntries = Object.entries(status.queues);
    if (queueEntries.length === 0) {
      console.log('   ✅ No active queues');
    } else {
      queueEntries.forEach(([api, queueInfo]) => {
        const indicator = queueInfo.length > 0 ? '⏳' : '✅';
        console.log(`   ${indicator} ${api}: ${queueInfo.length} queued (processing: ${queueInfo.processing})`);
      });
    }

    // Performance
    this.logPerformanceStatus(status.performance);

    console.log('='.repeat(70) + '\n');
  }

  logPerformanceStatus(performance = {}) {
    if (!performance || Object.values(performance).every(value => !value)) {
      return;
    }

    console.log('\n⏱  Performance (recent averages):');
    Object.entries(performance).forEach(([category, data]) => {
      if (!data) {
        console.log(`   ${category}: no samples`);
        return;
      }

      const avg = data.averageDurationMs !== null ? `${data.averageDurationMs}ms` : 'n/a';
      const lastDuration = data.last?.durationMs !== undefined ? `${Math.round(data.last.durationMs)}ms` : 'n/a';
      console.log(`   • ${category}: avg ${avg} over ${data.samples} samples (last ${lastDuration})`);
    });
  }

  /**
   * Record performance metrics for a category
   */
  recordPerformanceMetric(category, data = {}) {
    if (!this.performanceMetrics[category]) {
      this.performanceMetrics[category] = [];
    }

    const entry = {
      ...data,
      timestamp: new Date().toISOString()
    };

    this.performanceMetrics[category].push(entry);

    if (this.performanceMetrics[category].length > this.performanceHistoryLimit) {
      this.performanceMetrics[category].shift();
    }
  }

  /**
   * Build a snapshot with aggregates
   */
  getPerformanceSnapshot() {
    const snapshot = {};

    Object.entries(this.performanceMetrics).forEach(([category, entries]) => {
      if (!entries || entries.length === 0) {
        snapshot[category] = null;
        return;
      }

      const durationEntries = entries.filter(entry => typeof entry.durationMs === 'number');
      const avgDuration = durationEntries.length > 0
        ? durationEntries.reduce((sum, entry) => sum + entry.durationMs, 0) / durationEntries.length
        : null;

      snapshot[category] = {
        samples: entries.length,
        averageDurationMs: avgDuration !== null ? Number(avgDuration.toFixed(2)) : null,
        last: entries[entries.length - 1]
      };
    });

    return snapshot;
  }

  /**
   * Get health check status
   */
  async getHealthCheck() {
    const status = await this.getStatus();
    const cacheHealthy = status.cache.connected || status.cache.hits > 0; // Cache working or has served requests
    const queuesHealthy = Object.values(status.queues).every(q => q.length < 100); // No excessive queuing
    
    const healthy = cacheHealthy && queuesHealthy;
    
    return {
      healthy,
      status: healthy ? 'ok' : 'degraded',
      timestamp: status.timestamp,
      details: {
        cache: status.cache.connected,
        queues: Object.values(status.queues).reduce((sum, q) => sum + q.length, 0)
      }
    };
  }
}

// Export singleton instance
module.exports = new Monitoring();

