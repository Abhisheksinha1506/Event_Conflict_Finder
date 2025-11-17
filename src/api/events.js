const express = require('express');
const router = express.Router();
const TicketmasterService = require('../services/ticketmaster');
const BandsintownService = require('../services/bandsintown');
const rateLimiter = require('../utils/rateLimiter');
const cacheManager = require('../utils/cacheManager');
const monitoring = require('../utils/monitoring');
const paywallService = require('../utils/paywallService');
const freeSearchLimiter = require('../utils/freeSearchLimiter');

// Track pending requests for deduplication (same location queries)
const pendingRequests = new Map();

// Get events by location
router.get('/search', async (req, res) => {
  const requestStart = process.hrtime.bigint();

  const recordMetrics = (payload = {}, overrides = {}) => {
    const durationMs = Number(process.hrtime.bigint() - requestStart) / 1e6;
    monitoring.recordPerformanceMetric('event_search', {
      durationMs,
      totalEvents: payload.total || 0,
      ticketmasterCount: payload.sources?.ticketmaster?.count || 0,
      bandsintownCount: payload.sources?.bandsintown?.count || 0,
      cacheHitRate: payload.cache?.hitRate,
      deduplicatedRequest: overrides.deduplicatedRequest || false,
      radius: payload.searchParams?.radius,
      lat: payload.searchParams?.lat,
      lon: payload.searchParams?.lon,
      ticketmasterDurationMs: overrides.ticketmasterDurationMs,
      bandsintownDurationMs: overrides.bandsintownDurationMs
    });
  };

  const measureServiceCall = async (label, fn) => {
    const serviceStart = process.hrtime.bigint();
    try {
      const value = await fn();
      return {
        status: 'fulfilled',
        value,
        durationMs: Number(process.hrtime.bigint() - serviceStart) / 1e6
      };
    } catch (error) {
      return {
        status: 'rejected',
        reason: error,
        durationMs: Number(process.hrtime.bigint() - serviceStart) / 1e6
      };
    }
  };

  try {
    const { lat, lon, radius = 10 } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ 
        error: 'Latitude and longitude are required',
        message: 'Please provide lat and lon query parameters'
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    const searchRadius = parseFloat(radius);

    // Validate coordinates
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ 
        error: 'Invalid coordinates',
        message: 'Latitude and longitude must be valid numbers'
      });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ 
        error: 'Invalid coordinate range',
        message: 'Latitude must be between -90 and 90, longitude between -180 and 180'
      });
    }

    // Get user identifier for rate limiting
    const userId = rateLimiter.getUserIdentifier(req) || req.ip || req.headers['x-forwarded-for'] || 'anonymous';
    const userEmail = (req.headers['x-user-email'] || '').toString().toLowerCase().trim();
    let paywallOutcome = null;
    const shouldUseSupabase = !!(userEmail && !paywallService.paywallUnavailable());
    const fallbackLimiterKey = userEmail ? `user:${userEmail}` : `ip:${userId}`;

    if (shouldUseSupabase) {
      try {
        paywallOutcome = await paywallService.recordSearchUsage(userEmail);
        if (!paywallOutcome.allowed) {
          return res.status(402).json({
            error: 'PAYWALL_LIMIT_REACHED',
            message: 'Free searches exhausted. Purchase the unlimited plan to continue.',
            planStatus: paywallOutcome.planStatus,
            searchCount: paywallOutcome.searchCount,
            freeSearchLimit: paywallService.FREE_SEARCH_LIMIT
          });
        }
      } catch (error) {
        console.error('Paywall enforcement error:', error);
        return res.status(500).json({
          error: 'PAYWALL_ENFORCEMENT_FAILED',
          message: 'Unable to verify subscription status. Please try again later.'
        });
      }
    } else {
      paywallOutcome = freeSearchLimiter.recordSearch(fallbackLimiterKey);
      if (!paywallOutcome.allowed) {
        return res.status(402).json({
          error: 'PAYWALL_LIMIT_REACHED',
          message: 'Free searches exhausted. Purchase the unlimited plan to continue.',
          planStatus: paywallOutcome.planStatus,
          searchCount: paywallOutcome.searchCount,
          freeSearchLimit: paywallOutcome.freeSearchLimit || paywallService.FREE_SEARCH_LIMIT
        });
      }
    }

    // Check for request deduplication - if same query is already in progress, wait for it
    const requestKey = `search:${latitude.toFixed(4)}:${longitude.toFixed(4)}:${searchRadius}`;
    
    if (pendingRequests.has(requestKey)) {
      // Another request for same location is in progress, wait for it
      try {
        const pendingPromise = pendingRequests.get(requestKey);
        if (pendingPromise) {
          const result = await pendingPromise;
          recordMetrics(result, { deduplicatedRequest: true });
          res.json(result);
          return;
        }
      } catch (error) {
        // If the pending request failed, continue with new request
        console.warn('Pending request failed, creating new request:', error.message);
        pendingRequests.delete(requestKey);
      }
    }

    // Create promise for this request
    const requestPromise = (async () => {
      try {
        // Parallel API calls with error handling
        const [ticketmasterResult, bandsintownResult] = await Promise.all([
          measureServiceCall('ticketmaster', () => 
            TicketmasterService.getEventsByLocation(latitude, longitude, searchRadius, userId)
          ),
          measureServiceCall('bandsintown', () => 
            BandsintownService.getEventsByLocation(latitude, longitude, searchRadius, userId)
          )
        ]);

        const ticketmasterEvents = (ticketmasterResult.status === 'fulfilled' && Array.isArray(ticketmasterResult.value)) 
          ? ticketmasterResult.value 
          : [];
        const bandsintownEvents = (bandsintownResult.status === 'fulfilled' && Array.isArray(bandsintownResult.value)) 
          ? bandsintownResult.value 
          : [];

        const allEvents = [
          ...ticketmasterEvents,
          ...bandsintownEvents
        ];

        // Get enabled status from services
        const ticketmasterEnabled = TicketmasterService.enabled;
        const bandsintownEnabled = BandsintownService.enabled;

        // Get cache stats for monitoring
        const cacheStats = cacheManager.getStats();

        const response = {
          events: allEvents,
          total: allEvents.length,
          sources: {
            ticketmaster: {
              enabled: ticketmasterEnabled,
              count: ticketmasterEvents.length,
              success: ticketmasterResult.status === 'fulfilled',
              error: ticketmasterResult.status === 'rejected' ? ticketmasterResult.reason?.message : null
            },
            bandsintown: {
              enabled: bandsintownEnabled,
              count: bandsintownEvents.length,
              success: bandsintownResult.status === 'fulfilled',
              error: bandsintownResult.status === 'rejected' ? bandsintownResult.reason?.message : null
            }
          },
          searchParams: {
            lat: latitude,
            lon: longitude,
            radius: searchRadius
          },
          cache: {
            hitRate: cacheStats.hitRate,
            connected: cacheStats.connected
          }
        };

        recordMetrics(response, {
          ticketmasterDurationMs: ticketmasterResult.durationMs,
          bandsintownDurationMs: bandsintownResult.durationMs
        });
        return response;
      } finally {
        // Remove from pending requests
        pendingRequests.delete(requestKey);
      }
    })();

    // Store promise for deduplication
    pendingRequests.set(requestKey, requestPromise);

    // Wait for result
    const result = await requestPromise;

    // Add cache headers
    res.set('Cache-Control', 'public, max-age=900'); // 15 minutes
    res.set('X-Cache-Hit-Rate', result.cache.hitRate);
    if (paywallOutcome) {
      res.set('X-Paywall-Plan', paywallOutcome.planStatus || 'free');
    }
    
    res.json(result);
  } catch (error) {
    console.error('Events search error:', error);
    monitoring.recordPerformanceMetric('event_search', {
      durationMs: Number(process.hrtime.bigint() - requestStart) / 1e6,
      error: error.message,
      totalEvents: 0
    });
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to search events. Please try again later.'
    });
  }
});

module.exports = router;

