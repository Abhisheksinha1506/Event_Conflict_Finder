const fetch = require('node-fetch');
const rateLimiter = require('../utils/rateLimiter');
const cacheManager = require('../utils/cacheManager');
const requestQueue = require('../utils/requestQueue');
const monitoring = require('../utils/monitoring');

class BandsintownService {
  constructor() {
    this.baseURL = 'https://rest.bandsintown.com';
    this.appId = process.env.BANDSINTOWN_APP_ID || 'EventConflictFinder'; // App identifier (can be any string)
    this.enabled = process.env.BANDSINTOWN_ENABLED !== 'false'; // Enabled by default
    this.timeout = parseInt(process.env.BANDSINTOWN_TIMEOUT) || 10000; // 10 seconds default
    this._authWarningLogged = false; // Track if we've logged auth warnings
    this.apiName = 'bandsintown';
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  // Transform Bandsintown API response to our standard format
  transformEvent(eventData, artistName = null) {
    const venue = eventData.venue || {};
    
    // Calculate end time (estimate 2 hours if not provided)
    const startTime = eventData.datetime || eventData.date;
    let endTime = startTime;
    if (startTime) {
      const start = new Date(startTime);
      start.setHours(start.getHours() + 2); // Default 2 hour duration
      endTime = start.toISOString();
    }

    // Format event name with artist
    const eventName = eventData.lineup && eventData.lineup.length > 0
      ? eventData.lineup.join(', ')
      : (artistName || eventData.artist?.name || 'Untitled Event');

    return {
      id: `bit_${eventData.id || `${eventData.venue?.name}_${eventData.datetime}`}`,
      name: eventName,
      start: eventData.datetime || eventData.date,
      end: endTime || eventData.datetime || eventData.date,
      venue: {
        name: venue.name || 'Unknown Venue',
        lat: venue.latitude || venue.lat,
        lon: venue.longitude || venue.lng || venue.lon,
        address: venue.location || venue.city || ''
      },
      source: 'bandsintown',
      url: eventData.url || eventData.facebook_rsvp_url || `https://www.bandsintown.com/e/${eventData.id}`
    };
  }

  // Search events by location using Bandsintown API
  // Note: Bandsintown API is primarily artist-based, but we can search popular artists
  // or use their location-based endpoints if available
  async getEventsByLocation(lat, lon, radius = 10, userId = 'default') {
    const requestStart = process.hrtime.bigint();
    const recordMetric = (data = {}) => {
      monitoring.recordPerformanceMetric('bandsintown_service', {
        durationMs: Number(process.hrtime.bigint() - requestStart) / 1e6,
        lat,
        lon,
        radius,
        ...data
      });
    };

    try {
      // Check if service is enabled
      if (!this.enabled) {
        console.log('Bandsintown service is disabled. Skipping Bandsintown events.');
        return [];
      }

      // Check cache first
      const cached = await cacheManager.get(this.apiName, lat, lon, radius);
      if (cached) {
        recordMetric({
          fromCache: true,
          cachedCount: cached.length
        });
        return cached;
      }

      // Check rate limits
      const limitCheck = await rateLimiter.checkAllLimits(this.apiName, userId);
      
      if (!limitCheck.allowed) {
        const staleCache = await cacheManager.get(this.apiName, lat, lon, radius);
        if (staleCache) {
          console.warn(`Bandsintown: Rate limited, returning stale cache. Wait time: ${limitCheck.waitTime}s`);
          return staleCache;
        }
        
        if (limitCheck.shouldQueue) {
          return await requestQueue.enqueue(this.apiName, () => this.getEventsByLocation(lat, lon, radius, userId));
        }
        
        console.warn(`Bandsintown: Rate limit exceeded. Wait time: ${limitCheck.waitTime}s`);
        return [];
      }

      if (limitCheck.shouldQueue) {
        return await requestQueue.enqueue(this.apiName, () => this.searchEventsByLocation(lat, lon, radius));
      }

      // Bandsintown API doesn't have direct location-based search
      // We'll use a workaround: search for popular artists in the area
      const events = await this.searchEventsByLocation(lat, lon, radius);
      
      // Cache the results
      await cacheManager.set(this.apiName, lat, lon, radius, events);
      
      recordMetric({
        fromCache: false,
        eventCount: events.length
      });
      return events;
    } catch (error) {
      console.error('Bandsintown service error:', error.message);
      const cached = await cacheManager.get(this.apiName, lat, lon, radius);
      if (cached) {
        recordMetric({
          fromCache: true,
          cachedCount: cached.length,
          error: error.message
        });
      } else {
        recordMetric({
          fromCache: false,
          eventCount: 0,
          error: error.message
        });
      }
      return cached || [];
    }
  }

  async searchEventsByLocation(lat, lon, radius) {
    const searchStart = process.hrtime.bigint();
    try {
      // Bandsintown API structure:
      // GET /artists/{artist_name}/events?app_id={app_id}&date=upcoming
      // 
      // For location-based search, we need to:
      // 1. Search popular artists or
      // 2. Use a different endpoint if available
      //
      // Since Bandsintown doesn't have direct location search,
      // we'll search for events from popular artists and filter by location
      
      // List of popular artists to search (you can expand this list)
      const popularArtists = [
        'Taylor Swift', 'The Weeknd', 'Bad Bunny', 'Drake', 'Harry Styles',
        'Ed Sheeran', 'Billie Eilish', 'Post Malone', 'Ariana Grande', 'Dua Lipa',
        'The Rolling Stones', 'Coldplay', 'U2', 'Metallica', 'Red Hot Chili Peppers'
      ];

      // Search events for multiple artists in parallel
      const artistPromises = popularArtists.slice(0, 10).map(artist => 
        this.getArtistEvents(artist)
      );

      const results = await Promise.allSettled(artistPromises);
      
      // Flatten all events
      let allEvents = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          allEvents = allEvents.concat(result.value);
        }
      });

      // Filter events by location (within radius)
      const radiusKm = radius * 1.60934; // Convert miles to km
      const filteredEvents = allEvents
        .map(event => this.transformEvent(event, event._artistName))
        .filter(event => {
          // Check if event has valid coordinates
          if (!event.venue || !event.venue.lat || !event.venue.lon || !event.start) {
            return false;
          }

          // Calculate distance using Haversine formula
          const distance = this.calculateDistance(
            lat, lon,
            parseFloat(event.venue.lat),
            parseFloat(event.venue.lon)
          );

          return distance <= radiusKm;
        });

      // Remove duplicates based on event ID
      const uniqueEvents = filteredEvents.filter((event, index, self) =>
        index === self.findIndex(e => e.id === event.id)
      );

      // Cache the results (use lat/lon from method parameters)
      await cacheManager.set(this.apiName, lat, lon, radius, uniqueEvents);

      monitoring.recordPerformanceMetric('bandsintown_fanout', {
        durationMs: Number(process.hrtime.bigint() - searchStart) / 1e6,
        artistBatchSize: artistPromises.length,
        rawEvents: allEvents.length,
        filteredEvents: filteredEvents.length,
        uniqueEvents: uniqueEvents.length,
        radius,
        lat,
        lon
      });

      return uniqueEvents;
    } catch (error) {
      console.error('Bandsintown location search error:', error.message);
      // Try to return cached data on error
      const cached = await cacheManager.get(this.apiName, lat, lon, radius);
      monitoring.recordPerformanceMetric('bandsintown_fanout', {
        durationMs: Number(process.hrtime.bigint() - searchStart) / 1e6,
        error: error.message,
        radius,
        lat,
        lon
      });
      return cached || [];
    }
  }

  async getArtistEvents(artistName, retryCount = 0) {
    try {
      // Encode artist name for URL
      const encodedArtist = encodeURIComponent(artistName);
      const url = `${this.baseURL}/artists/${encodedArtist}/events?app_id=${this.appId}&date=upcoming`;

      // Make API request with timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), this.timeout);
      });

      const fetchPromise = fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      let response;
      try {
        response = await Promise.race([fetchPromise, timeoutPromise]);
      } catch (error) {
        if (error.message === 'Request timeout') {
          console.error(`Bandsintown API request timed out for artist: ${artistName}`);
          return [];
        }
        throw error;
      }

      // Handle 429 Too Many Requests
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || this.retryDelay;
        const waitTime = parseInt(retryAfter) * 1000;

        if (retryCount < this.maxRetries) {
          console.warn(`Bandsintown: 429 received for ${artistName}, retrying after ${waitTime}ms (attempt ${retryCount + 1}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return await this.getArtistEvents(artistName, retryCount + 1);
        } else {
          console.error(`Bandsintown: Max retries reached for ${artistName}`);
          return [];
        }
      }

      if (!response.ok) {
        // 404 is normal for artists with no events
        if (response.status === 404) {
          return [];
        }
        
        // Suppress logging for 403 errors (authorization issues)
        if (response.status === 403) {
          if (!this._authWarningLogged) {
            console.warn('⚠️  Bandsintown: 403 Forbidden - Authorization issue');
            console.warn('   The API may have changed or requires different authentication');
            this._authWarningLogged = true;
          }
          return [];
        }
        
        // Log other errors normally
        const errorText = await response.text();
        console.error(`Bandsintown API error (${response.status}) for ${artistName}:`, errorText);
        return [];
      }

      const data = await response.json();
      
      // Add artist name to each event for reference
      if (Array.isArray(data)) {
        return data.map(event => ({
          ...event,
          _artistName: artistName
        }));
      }

      return [];
    } catch (error) {
      console.error(`Bandsintown artist search error for ${artistName}:`, error.message);
      
      // Retry on network errors
      if (retryCount < this.maxRetries && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
        const waitTime = this.retryDelay * Math.pow(2, retryCount);
        console.warn(`Bandsintown: Network error for ${artistName}, retrying after ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return await this.getArtistEvents(artistName, retryCount + 1);
      }
      
      return [];
    }
  }

  // Calculate distance between two coordinates (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return distance;
  }

  toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }
}

module.exports = new BandsintownService();

