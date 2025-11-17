/**
 * Rate Limit Configuration
 * Defines rate limits for each API service
 */

module.exports = {
  ticketmaster: {
    // Daily quota: 5000 requests
    dailyQuota: parseInt(process.env.TICKETMASTER_DAILY_QUOTA) || 5000,
    // Rate limit: 5 requests per second (using 4 for safety margin)
    requestsPerSecond: parseFloat(process.env.TICKETMASTER_RPS) || 4,
    // Per-user limit: 100 requests per hour
    perUserPerHour: parseInt(process.env.TICKETMASTER_USER_HOUR_LIMIT) || 100,
    // Queue threshold: Start queuing at 80% of daily quota
    queueThreshold: 0.8,
    // Name for logging
    name: 'Ticketmaster'
  },
  
  bandsintown: {
    // Conservative estimate: 600 requests per hour (10 per minute)
    hourlyQuota: parseInt(process.env.BANDSINTOWN_HOURLY_QUOTA) || 600,
    // Rate limit: 8 requests per minute (conservative)
    requestsPerMinute: parseFloat(process.env.BANDSINTOWN_RPM) || 8,
    // Per-user limit: 30 requests per hour
    perUserPerHour: parseInt(process.env.BANDSINTOWN_USER_HOUR_LIMIT) || 30,
    // Queue threshold: Start queuing at 80% of hourly quota
    queueThreshold: 0.8,
    // Name for logging
    name: 'Bandsintown'
  }
};

