const fetch = require('node-fetch');
const rateLimiter = require('../utils/rateLimiter');
const cacheManager = require('../utils/cacheManager');
const requestQueue = require('../utils/requestQueue');

class TicketmasterService {
  constructor() {
    this.baseURL = 'https://app.ticketmaster.com/discovery/v2';
    this.apiKey = process.env.TICKETMASTER_API_KEY;
    this.enabled = process.env.TICKETMASTER_ENABLED !== 'false'; // Enabled by default
    this.apiName = 'ticketmaster';
    this.maxRetries = 3;
    this.retryDelay = 1000; // Initial retry delay in ms
  }

  // Transform Ticketmaster API response to our standard format
  transformEvent(eventData) {
    const venue = eventData._embedded?.venues?.[0] || {};
    const dates = eventData.dates || {};
    const startDate = dates.start || {};
    const eventUrl = this.getPublicEventUrl(eventData);

    if (!eventUrl) {
      return null;
    }
    
    // Calculate end time (estimate 2 hours if not provided)
    let endTime = dates.end?.dateTime || dates.end?.localDate;
    if (!endTime && startDate.dateTime) {
      const start = new Date(startDate.dateTime);
      start.setHours(start.getHours() + 2); // Default 2 hour duration
      endTime = start.toISOString();
    }

    return {
      id: `tm_${eventData.id}`,
      name: eventData.name || 'Untitled Event',
      start: startDate.dateTime || startDate.localDate || dates.start,
      end: endTime || startDate.dateTime || startDate.localDate,
      venue: {
        name: venue.name || 'Unknown Venue',
        lat: venue.location?.latitude || venue.latitude,
        lon: venue.location?.longitude || venue.longitude,
        address: venue.address?.line1 || venue.address || ''
      },
      source: 'ticketmaster',
      url: eventUrl
    };
  }

  getPublicEventUrl(eventData) {
    const candidateUrls = [];

    if (typeof eventData.url === 'string') {
      candidateUrls.push(eventData.url.trim());
    }

    if (typeof eventData._links?.web?.href === 'string') {
      candidateUrls.push(eventData._links.web.href.trim());
    }

    for (const url of candidateUrls) {
      if (this.isValidTicketmasterUrl(url)) {
        return url;
      }
    }

    return null;
  }

  isValidTicketmasterUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }

    const trimmed = url.trim();

    if (!/^https?:\/\//i.test(trimmed)) {
      return false;
    }

    return trimmed.includes('ticketmaster');
  }

  async getEventsByLocation(lat, lon, radius = 10, userId = 'default') {
    try {
      // Check if service is enabled
      if (!this.enabled) {
        console.log('Ticketmaster service is disabled. Skipping Ticketmaster events.');
        return [];
      }

      // If no API key, return empty array
      if (!this.apiKey || this.apiKey === 'your_ticketmaster_api_key_here') {
        console.warn('Ticketmaster API key not configured. Skipping Ticketmaster events.');
        return [];
      }

      // Check cache first
      const cached = await cacheManager.get(this.apiName, lat, lon, radius);
      if (cached) {
        return cached;
      }

      // Check rate limits
      const limitCheck = await rateLimiter.checkAllLimits(this.apiName, userId);
      
      if (!limitCheck.allowed) {
        // Try to return cached data even if expired
        const staleCache = await cacheManager.get(this.apiName, lat, lon, radius);
        if (staleCache) {
          console.warn(`Ticketmaster: Rate limited, returning stale cache. Wait time: ${limitCheck.waitTime}s`);
          return staleCache;
        }
        
        // If should queue, add to queue
        if (limitCheck.shouldQueue) {
          return await requestQueue.enqueue(this.apiName, () => this.getEventsByLocation(lat, lon, radius, userId));
        }
        
        // Otherwise, return empty with wait time info
        console.warn(`Ticketmaster: Rate limit exceeded. Wait time: ${limitCheck.waitTime}s`);
        return [];
      }

      // If approaching limit, queue the request
      if (limitCheck.shouldQueue) {
        return await requestQueue.enqueue(this.apiName, () => this.makeApiRequest(lat, lon, radius));
      }

      // Make API request
      return await this.makeApiRequest(lat, lon, radius);
    } catch (error) {
      console.error('Ticketmaster service error:', error.message);
      // Try to return cached data on error
      const cached = await cacheManager.get(this.apiName, lat, lon, radius);
      return cached || [];
    }
  }

  async makeApiRequest(lat, lon, radius, retryCount = 0) {
    // Build the API URL
    const maxSize = Math.min(200, Math.max(50, Math.round(radius * 2)));
    
    const url = new URL(`${this.baseURL}/events.json`);
    url.searchParams.append('apikey', this.apiKey);
    url.searchParams.append('latlong', `${lat},${lon}`);
    url.searchParams.append('radius', radius.toString());
    url.searchParams.append('size', maxSize.toString());
    url.searchParams.append('sort', 'date,asc');
    url.searchParams.append('classificationName', 'music,sports,arts,theater,comedy,family');

    try {
      // Make API request
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      // Handle 429 Too Many Requests
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || this.retryDelay;
        const waitTime = parseInt(retryAfter) * 1000; // Convert to milliseconds

        if (retryCount < this.maxRetries) {
          console.warn(`Ticketmaster: 429 received, retrying after ${waitTime}ms (attempt ${retryCount + 1}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return await this.makeApiRequest(lat, lon, radius, retryCount + 1);
        } else {
          console.error('Ticketmaster: Max retries reached for 429 error');
          return [];
        }
      }

      // Extract rate limit headers (Ticketmaster provides these)
      const rateLimit = response.headers.get('Rate-Limit');
      const rateLimitAvailable = response.headers.get('Rate-Limit-Available');
      const rateLimitOver = response.headers.get('Rate-Limit-Over');
      const rateLimitReset = response.headers.get('Rate-Limit-Reset');

      if (rateLimitAvailable) {
        const available = parseInt(rateLimitAvailable);
        const total = parseInt(rateLimit) || 5000;
        const quotaUsed = (total - available) / total;
        
        if (quotaUsed >= 0.8) {
          console.warn(`Ticketmaster: Quota usage at ${(quotaUsed * 100).toFixed(1)}%`);
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Ticketmaster API error (${response.status}):`, errorText);
        return [];
      }

      const data = await response.json();
      const events = data._embedded?.events || [];

      // Transform events to our standard format
      const transformedEvents = events
        .map(event => this.transformEvent(event))
        .filter(event => {
          if (!event) {
            return false;
          }

          // Filter out events without valid venue coordinates
          return event.venue && event.venue.lat && event.venue.lon && event.start && event.end;
        });

      // Cache the results
      await cacheManager.set(this.apiName, lat, lon, radius, transformedEvents);

      return transformedEvents;
    } catch (error) {
      console.error('Ticketmaster API request error:', error.message);
      
      // Retry on network errors
      if (retryCount < this.maxRetries && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
        const waitTime = this.retryDelay * Math.pow(2, retryCount); // Exponential backoff
        console.warn(`Ticketmaster: Network error, retrying after ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return await this.makeApiRequest(lat, lon, radius, retryCount + 1);
      }
      
      return [];
    }
  }
}

module.exports = new TicketmasterService();

