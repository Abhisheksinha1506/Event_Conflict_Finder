const express = require('express');
const router = express.Router();
const ConflictDetector = require('../utils/conflictDetector');
const TicketmasterService = require('../services/ticketmaster');
const BandsintownService = require('../services/bandsintown');
const rateLimiter = require('../utils/rateLimiter');
const monitoring = require('../utils/monitoring');
const {
  filterEventsByDateRange,
  parseDateRangeFilters,
  sanitizeVenueRadiusKm
} = require('../utils/searchFilters');

const DEFAULT_VENUE_THRESHOLD_KM = 1;
const METRO_VENUE_THRESHOLD_KM = 3;

// Detect conflicts for a set of events
router.post('/detect', async (req, res) => {
  const requestStart = process.hrtime.bigint();

  const recordMetrics = (payload = {}) => {
    monitoring.recordPerformanceMetric('conflict_detection', {
      durationMs: Number(process.hrtime.bigint() - requestStart) / 1e6,
      totalEvents: payload.totalEvents,
      uniqueEvents: payload.uniqueEvents,
      conflictCount: payload.conflictCount,
      duplicatesFiltered: payload.duplicatesFiltered,
      timeBuffer: payload.timeBuffer,
      venueProximityThreshold: payload.venueProximityThreshold
    });
  };

  try {
    const {
      events,
      timeBuffer = 30,
      venueProximityThreshold,
      startDate: startDateRaw,
      endDate: endDateRaw,
      venueRadiusKm: venueRadiusRaw,
      context = {}
    } = req.body;

    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ 
        error: 'Invalid request',
        message: 'Valid events array is required'
      });
    }

    if (events.length === 0) {
      const emptyResponse = {
        conflicts: [],
        totalEvents: 0,
        uniqueEvents: 0,
        duplicatesFiltered: 0,
        conflictCount: 0,
        analyzedAt: new Date().toISOString()
      };
      recordMetrics(emptyResponse);
      return res.json(emptyResponse);
    }

    const buffer = parseInt(timeBuffer);
    if (isNaN(buffer) || buffer < 0) {
      return res.status(400).json({ 
        error: 'Invalid time buffer',
        message: 'Time buffer must be a non-negative number (in minutes)'
      });
    }

    const { startDate, endDate } = parseDateRangeFilters(startDateRaw, endDateRaw);
    const filteredEvents = filterEventsByDateRange(events, startDate, endDate);

    if (filteredEvents.length === 0) {
      const emptyPayload = {
        conflicts: [],
        totalEvents: events.length,
        uniqueEvents: 0,
        duplicatesFiltered: events.length,
        conflictCount: 0,
        analyzedAt: new Date().toISOString(),
        timeBuffer: buffer,
        venueProximityThreshold: null,
        thresholdMode: 'dynamic',
        filters: {
          startDate: startDate ? startDate.toISOString() : null,
          endDate: endDate ? endDate.toISOString() : null,
          venueRadiusKm: null
        }
      };
      recordMetrics(emptyPayload);
      return res.json(emptyPayload);
    }

    const uniqueEvents = ConflictDetector.filterDuplicates(filteredEvents);
    const duplicatesFiltered = filteredEvents.length - uniqueEvents.length;

    let manualThreshold = undefined;
    if (venueProximityThreshold !== undefined && venueProximityThreshold !== null) {
      manualThreshold = sanitizeVenueRadiusKm(venueProximityThreshold, DEFAULT_VENUE_THRESHOLD_KM);
    }

    const hasVenueRadiusOverride = venueRadiusRaw !== undefined && venueRadiusRaw !== null && venueRadiusRaw !== '';
    const venueRadiusKm = hasVenueRadiusOverride ? sanitizeVenueRadiusKm(venueRadiusRaw, DEFAULT_VENUE_THRESHOLD_KM) : null;

    const contextLat = context && context.lat !== undefined ? parseFloat(context.lat) : null;
    const contextLon = context && context.lon !== undefined ? parseFloat(context.lon) : null;

    const detectionContext = {
      lat: Number.isFinite(contextLat) ? contextLat : null,
      lon: Number.isFinite(contextLon) ? contextLon : null,
      venueRadiusKm
    };

    const detectionOptions = {
      context: detectionContext,
      baseThresholdKm: DEFAULT_VENUE_THRESHOLD_KM,
      metroThresholdKm: METRO_VENUE_THRESHOLD_KM,
      dynamicBaseKm: 0.3
    };

    const resolvedThreshold = ConflictDetector.resolveVenueThreshold(uniqueEvents, manualThreshold, detectionOptions);
    const conflicts = ConflictDetector.findConflicts(uniqueEvents, buffer, manualThreshold, true, detectionOptions);

    const responsePayload = {
      conflicts,
      totalEvents: events.length,
      uniqueEvents: uniqueEvents.length,
      duplicatesFiltered: duplicatesFiltered,
      conflictCount: conflicts.length,
      analyzedAt: new Date().toISOString(),
      timeBuffer: buffer,
      venueProximityThreshold: resolvedThreshold,
      thresholdMode: manualThreshold !== undefined && manualThreshold !== null
        ? 'manual'
        : (hasVenueRadiusOverride ? 'user_override' : 'dynamic'),
      filters: {
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
        venueRadiusKm
      }
    };

    recordMetrics(responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Conflict detection error:', error);
    monitoring.recordPerformanceMetric('conflict_detection', {
      durationMs: Number(process.hrtime.bigint() - requestStart) / 1e6,
      error: error.message
    });
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to detect conflicts. Please try again later.'
    });
  }
});

// Get conflicts for specific location
router.get('/location', async (req, res) => {
  const requestStart = process.hrtime.bigint();

  const recordMetrics = (payload = {}) => {
    monitoring.recordPerformanceMetric('conflict_detection_location', {
      durationMs: Number(process.hrtime.bigint() - requestStart) / 1e6,
      totalEvents: payload.summary?.totalEvents,
      uniqueEvents: payload.summary?.uniqueEvents,
      conflictCount: payload.summary?.conflictCount,
      duplicatesFiltered: payload.summary?.duplicatesFiltered,
      timeBuffer: payload.timeBuffer,
      venueProximityThreshold: payload.venueProximityThreshold,
      radius: payload.location?.radius
    });
  };

  try {
    const {
      lat,
      lon,
      radius = 10,
      timeBuffer = 30,
      venueProximityThreshold,
      startDate: startDateRaw,
      endDate: endDateRaw,
      venueRadiusKm: venueRadiusRaw
    } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ 
        error: 'Latitude and longitude are required',
        message: 'Please provide lat and lon query parameters'
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    const searchRadius = parseFloat(radius);
    const buffer = parseInt(timeBuffer);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ 
        error: 'Invalid coordinates',
        message: 'Latitude and longitude must be valid numbers'
      });
    }

    const { startDate, endDate } = parseDateRangeFilters(startDateRaw, endDateRaw);

    let manualThreshold = undefined;
    if (venueProximityThreshold !== undefined && venueProximityThreshold !== null && venueProximityThreshold !== '') {
      manualThreshold = sanitizeVenueRadiusKm(venueProximityThreshold, DEFAULT_VENUE_THRESHOLD_KM);
    }

    const hasVenueRadiusOverride = venueRadiusRaw !== undefined && venueRadiusRaw !== null && venueRadiusRaw !== '';
    const venueRadiusKm = hasVenueRadiusOverride ? sanitizeVenueRadiusKm(venueRadiusRaw, DEFAULT_VENUE_THRESHOLD_KM) : null;

    const userId = rateLimiter.getUserIdentifier(req);
    const serviceOptions = { startDate, endDate };

    const [ticketmasterResult, bandsintownResult] = await Promise.allSettled([
      TicketmasterService.getEventsByLocation(latitude, longitude, searchRadius, userId, serviceOptions),
      BandsintownService.getEventsByLocation(latitude, longitude, searchRadius, userId, serviceOptions)
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
    const filteredEvents = filterEventsByDateRange(allEvents, startDate, endDate);

    const uniqueEvents = ConflictDetector.filterDuplicates(filteredEvents);
    const duplicatesFiltered = filteredEvents.length - uniqueEvents.length;

    const detectionContext = {
      lat: latitude,
      lon: longitude,
      venueRadiusKm
    };

    const detectionOptions = {
      context: detectionContext,
      baseThresholdKm: DEFAULT_VENUE_THRESHOLD_KM,
      metroThresholdKm: METRO_VENUE_THRESHOLD_KM,
      dynamicBaseKm: 0.3
    };

    const resolvedThreshold = ConflictDetector.resolveVenueThreshold(uniqueEvents, manualThreshold, detectionOptions);
    const conflicts = ConflictDetector.findConflicts(uniqueEvents, buffer, manualThreshold, true, detectionOptions);

    const conflictRate = uniqueEvents.length > 0 
      ? ((conflicts.length / uniqueEvents.length) * 100).toFixed(1) 
      : '0.0';

    const responsePayload = {
      location: { 
        lat: latitude, 
        lon: longitude, 
        radius: searchRadius 
      },
      conflicts,
      summary: {
        totalEvents: filteredEvents.length,
        uniqueEvents: uniqueEvents.length,
        duplicatesFiltered: duplicatesFiltered,
        conflictCount: conflicts.length,
        conflictRate: `${conflictRate}%`,
        sources: {
          ticketmaster: ticketmasterEvents.length,
          bandsintown: bandsintownEvents.length
        }
      },
      analyzedAt: new Date().toISOString(),
      timeBuffer: buffer,
      venueProximityThreshold: resolvedThreshold,
      thresholdMode: manualThreshold !== undefined && manualThreshold !== null
        ? 'manual'
        : (hasVenueRadiusOverride ? 'user_override' : 'dynamic'),
      filters: {
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
        venueRadiusKm
      }
    };

    recordMetrics(responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Location conflict detection error:', error);
    monitoring.recordPerformanceMetric('conflict_detection_location', {
      durationMs: Number(process.hrtime.bigint() - requestStart) / 1e6,
      error: error.message
    });
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to detect conflicts for location. Please try again later.'
    });
  }
});

module.exports = router;

