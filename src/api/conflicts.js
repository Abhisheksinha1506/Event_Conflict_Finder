const express = require('express');
const router = express.Router();
const ConflictDetector = require('../utils/conflictDetector');
const TicketmasterService = require('../services/ticketmaster');
const BandsintownService = require('../services/bandsintown');
const rateLimiter = require('../utils/rateLimiter');
const monitoring = require('../utils/monitoring');

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
    const { events, timeBuffer = 30, venueProximityThreshold = 0.3 } = req.body;

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

    // Validate timeBuffer
    const buffer = parseInt(timeBuffer);
    if (isNaN(buffer) || buffer < 0) {
      return res.status(400).json({ 
        error: 'Invalid time buffer',
        message: 'Time buffer must be a non-negative number (in minutes)'
      });
    }

    // Validate venueProximityThreshold (optional - defaults to dynamic calculation)
    let proximityThreshold = undefined;
    if (venueProximityThreshold !== undefined && venueProximityThreshold !== null) {
      proximityThreshold = parseFloat(venueProximityThreshold);
      if (isNaN(proximityThreshold) || proximityThreshold < 0) {
        return res.status(400).json({ 
          error: 'Invalid venue proximity threshold',
          message: 'Venue proximity threshold must be a non-negative number (in kilometers)'
        });
      }
    }

    // Filter duplicates and get unique events count
    const uniqueEvents = ConflictDetector.filterDuplicates(events);
    const duplicatesFiltered = events.length - uniqueEvents.length;

    // Use null for dynamic threshold calculation if not explicitly provided
    const thresholdForDetection = proximityThreshold !== undefined && proximityThreshold !== null 
      ? proximityThreshold 
      : null;

    // Skip duplicate filtering in findConflicts since we already did it
    const conflicts = ConflictDetector.findConflicts(uniqueEvents, buffer, thresholdForDetection, true);
    
    // Calculate the actual threshold used (for reporting)
    const actualThreshold = thresholdForDetection !== null 
      ? thresholdForDetection 
      : ConflictDetector.calculateDynamicThreshold(uniqueEvents);

    const responsePayload = {
      conflicts,
      totalEvents: events.length,
      uniqueEvents: uniqueEvents.length,
      duplicatesFiltered: duplicatesFiltered,
      conflictCount: conflicts.length,
      analyzedAt: new Date().toISOString(),
      timeBuffer: buffer,
      venueProximityThreshold: actualThreshold,
      thresholdMode: proximityThreshold !== undefined && proximityThreshold !== null ? 'manual' : 'dynamic'
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
    const { lat, lon, radius = 10, timeBuffer = 30, venueProximityThreshold } = req.query;

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

    // Validate coordinates
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ 
        error: 'Invalid coordinates',
        message: 'Latitude and longitude must be valid numbers'
      });
    }

    // Validate venueProximityThreshold (optional - defaults to dynamic calculation)
    let proximityThreshold = undefined;
    if (venueProximityThreshold !== undefined && venueProximityThreshold !== null && venueProximityThreshold !== '') {
      proximityThreshold = parseFloat(venueProximityThreshold);
      if (isNaN(proximityThreshold) || proximityThreshold < 0) {
        return res.status(400).json({ 
          error: 'Invalid venue proximity threshold',
          message: 'Venue proximity threshold must be a non-negative number (in kilometers)'
        });
      }
    }

    // Get user identifier for rate limiting
    const userId = rateLimiter.getUserIdentifier(req);

    // Fetch events from all services
    const [ticketmasterResult, bandsintownResult] = await Promise.allSettled([
      TicketmasterService.getEventsByLocation(latitude, longitude, searchRadius, userId),
      BandsintownService.getEventsByLocation(latitude, longitude, searchRadius, userId)
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

    // Filter duplicates
    const uniqueEvents = ConflictDetector.filterDuplicates(allEvents);
    const duplicatesFiltered = allEvents.length - uniqueEvents.length;

    // Use null for dynamic threshold calculation if not explicitly provided
    const thresholdForDetection = proximityThreshold !== undefined && proximityThreshold !== null 
      ? proximityThreshold 
      : null;

    // Detect conflicts (skip duplicate filtering since we already did it)
    const conflicts = ConflictDetector.findConflicts(uniqueEvents, buffer, thresholdForDetection, true);
    
    // Calculate the actual threshold used (for reporting)
    const actualThreshold = thresholdForDetection !== null 
      ? thresholdForDetection 
      : ConflictDetector.calculateDynamicThreshold(uniqueEvents);

    // Calculate conflict rate based on unique events
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
        totalEvents: allEvents.length,
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
      venueProximityThreshold: actualThreshold,
      thresholdMode: proximityThreshold !== undefined && proximityThreshold !== null ? 'manual' : 'dynamic'
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

