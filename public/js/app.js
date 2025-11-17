// Suppress expected third-party analytics errors blocked by ad blockers
(function() {
  const blockedDomains = [
    'polar.sh',
    'r.stripe.com',
    'play.google.com'
  ];
  
  const originalError = console.error;
  const originalWarn = console.warn;
  
  console.error = function(...args) {
    const message = args.join(' ');
    if (blockedDomains.some(domain => message.includes(domain) && message.includes('ERR_BLOCKED_BY_CLIENT'))) {
      return; // Suppress blocked third-party analytics errors
    }
    originalError.apply(console, args);
  };
  
  // Also catch unhandled promise rejections from blocked requests
  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason?.message || event.reason?.toString() || '';
    if (blockedDomains.some(domain => reason.includes(domain) && (reason.includes('Failed to fetch') || reason.includes('ERR_BLOCKED_BY_CLIENT')))) {
      event.preventDefault(); // Suppress console error
      return;
    }
  });
})();

class EventConflictFinder {
  constructor() {
    this.map = null;
    this.events = [];
    this.conflicts = [];
    this.markers = [];
    this.locationCoords = null;
    this.selectedEventId = null; // Track selected event
    this.eventConflictsMap = {}; // Map event ID to its conflicts
    this.locationSuggestions = []; // Store current suggestions
    this.selectedSuggestionIndex = -1; // Track keyboard navigation
    this.suggestionTimeout = null; // Debounce timeout
    this.currentFetchController = null; // AbortController for cancelling API requests
    this.clickMarker = null; // Marker for map click location
    this.zoomUpdateTimeout = null; // Timeout for debouncing zoom updates
    this.isManualSearch = false; // Flag to prevent zoom updates during manual search
    this.isFittingBounds = false; // Flag to prevent zoom updates during bounds fitting
    this.lastZoomLevel = null; // Track last zoom level to detect significant changes
    this.lastSearchRadius = null; // Track last search radius to detect significant changes
    this.isSelectionUpdate = false; // Prevent map events triggered by selection from refetching
    this.performanceLoggingEnabled = this.shouldLogPerformance();
    this.suggestionCache = new Map();
    this.popularSuggestionPool = [];
    this.defaultSuggestionLimit = 5;
    this.typingSpeedThresholdMs = 180;
    this.fastTypingDebounceMs = 120;
    this.normalSuggestionDebounceMs = 300;
    this.lastSuggestionInputTime = 0;
    this.paywallState = this.loadPaywallState();
    this.freeSearchLimit = this.paywallState.freeSearchLimit;
    this.freeSearchCount = this.paywallState.freeSearchCount;
    this.userEmail = this.paywallState.email;
    this.hasUnlimitedAccess = this.paywallState.unlimitedAccess;
    this.paywallModal = null;
    this.paywallMessageElement = null;
    this.paywallActiveTab = 'signin';
    
    // Supported countries with strong/variable coverage
    this.supportedCountries = [
      'United States', 'USA', 'US',
      'Canada', 'CA',
      'United Kingdom', 'UK', 'GB',
      'Australia', 'AU',
      'New Zealand', 'NZ',
      'Ireland', 'IE',
      'Germany', 'DE',
      'France', 'FR',
      'Spain', 'ES',
      'Italy', 'IT',
      'Netherlands', 'NL',
      'Belgium', 'BE',
      'Switzerland', 'CH',
      'Austria', 'AT',
      'Sweden', 'SE',
      'Norway', 'NO',
      'Denmark', 'DK',
      'Finland', 'FI',
      'Portugal', 'PT',
      'Poland', 'PL',
      'Czech Republic', 'CZ',
      'Greece', 'GR'
    ];
  }

  shouldLogPerformance() {
    try {
      const flag = localStorage.getItem('ecf_perf_logs');
      return flag === 'true';
    } catch (error) {
      return false;
    }
  }

  logPerformance(label, startTime, extra = {}) {
    if (!this.performanceLoggingEnabled || typeof performance === 'undefined') {
      return;
    }

    const durationMs = performance.now() - startTime;
    const summary = {
      ...extra,
      durationMs: Number(durationMs.toFixed(2))
    };
    console.log(`[Perf] ${label}`, summary);
  }

  async init() {
    this.initMap();
    this.setupEventListeners();
    this.setupPaywallModal();
    await this.prefetchPopularLocations();
    this.checkPostCheckoutStatus();
    // Verify stored payment status with server on page load
    await this.verifyStoredPaymentStatus();
  }

  initMap() {
    // Ensure map container exists and is visible
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
      console.error('Map container not found');
      return;
    }

    // Initialize map with better options
    this.map = L.map('map', {
      center: [40.7128, -74.0060],
      zoom: 12,
      zoomControl: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      dragging: true,
      touchZoom: true
    });

    // Store current tile layer
    this.currentTileLayer = null;
    this.currentTheme = 'light'; // Default theme

    // Initialize with light theme
    this.switchMapTheme('light');

    // Invalidate map size after a short delay to ensure container is rendered
    setTimeout(() => {
      if (this.map) {
        this.map.invalidateSize();
      }
    }, 100);

    // Add scale control
    L.control.scale({
      imperial: true,
      metric: true,
      position: 'bottomleft'
    }).addTo(this.map);

    // Position zoom controls
    this.map.zoomControl.setPosition('topright');

    // Add smooth zoom animation
    this.map.on('zoomstart', () => {
      this.map.getContainer().style.transition = 'opacity 0.2s';
      this.map.getContainer().style.opacity = '0.95';
    });

    this.map.on('zoomend', () => {
      this.map.getContainer().style.opacity = '1';
      // Update events based on new zoom level
      this.handleMapViewChange();
    });

    // Handle map panning (moving)
    this.map.on('moveend', () => {
      // Update events based on new visible area
      this.handleMapViewChange();
    });

    // Store initial zoom level
    this.lastZoomLevel = this.map.getZoom();
  }

  switchMapTheme(theme) {
    this.currentTheme = theme;
    
    // Remove existing tile layer
    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
    }

    // Add loading effect
    const mapContainer = this.map.getContainer();
    mapContainer.classList.add('map-loading');

    // Determine tile URL based on theme
    let tileUrl, attribution;
    
    if (theme === 'dark') {
      tileUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      attribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>';
    } else {
      // Light theme (CartoDB Positron)
      tileUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
      attribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>';
    }

    // Create and add new tile layer
    this.currentTileLayer = L.tileLayer(tileUrl, {
      attribution: attribution,
      subdomains: 'abcd',
      maxZoom: 19,
      minZoom: 2
    }).addTo(this.map);

    // Remove loading effect after tiles load
    this.currentTileLayer.on('load', () => {
      mapContainer.classList.remove('map-loading');
    });

    // Update theme button states
    this.updateThemeButtons(theme);
  }

  updateThemeButtons(activeTheme) {
    const themeToggleInput = document.getElementById('theme-toggle');
    const themeToggleTrack = document.getElementById('theme-toggle-track');
    
    if (themeToggleInput) {
      themeToggleInput.checked = activeTheme === 'dark';
      themeToggleInput.setAttribute('data-theme', activeTheme);
    }
    
    if (themeToggleTrack) {
      themeToggleTrack.setAttribute('data-theme', activeTheme);
    }
  }

  darkenColor(color, percent = 15) {
    // Simple color darkening for gradients
    const num = parseInt(color.replace("#", ""), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, Math.min(255, (num >> 16) + amt));
    const G = Math.max(0, Math.min(255, (num >> 8 & 0x00FF) + amt));
    const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
    return "#" + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
  }

  setupEventListeners() {
    const searchBtn = document.getElementById('search-btn');
    searchBtn.addEventListener('click', () => this.searchEvents());

    // Theme toggle button
    const themeToggleInput = document.getElementById('theme-toggle');
    const themeToggleTrack = document.getElementById('theme-toggle-track');
    
    if (themeToggleInput) {
      themeToggleInput.addEventListener('change', () => {
        const newTheme = themeToggleInput.checked ? 'dark' : 'light';
        this.switchMapTheme(newTheme);
        themeToggleInput.setAttribute('data-theme', newTheme);
        if (themeToggleTrack) {
          themeToggleTrack.setAttribute('data-theme', newTheme);
        }
      });
    }

    // Modal close buttons
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalOkBtn = document.getElementById('modal-ok-btn');
    
    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', () => {
        this.hideUnsupportedCountryModal();
      });
    }
    
    if (modalOkBtn) {
      modalOkBtn.addEventListener('click', () => {
        this.hideUnsupportedCountryModal();
      });
    }

    // Close modal when clicking outside of it
    const modal = document.getElementById('unsupported-country-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.hideUnsupportedCountryModal();
        }
      });
    }

    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideUnsupportedCountryModal();
      }
    });

    // Location input with autocomplete
    const locationInput = document.getElementById('location');
    const suggestionsContainer = document.getElementById('location-suggestions');
    
    // Handle input changes with adaptive debouncing
    locationInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      
      const now = Date.now();
      const delta = now - (this.lastSuggestionInputTime || 0);
      this.lastSuggestionInputTime = now;
      const debounceDelay = delta > 0 && delta < this.typingSpeedThresholdMs
        ? this.fastTypingDebounceMs
        : this.normalSuggestionDebounceMs;
      
      // Cancel any pending API request
      if (this.currentFetchController) {
        this.currentFetchController.abort();
        this.currentFetchController = null;
      }
      
      // Clear any pending timeout
      clearTimeout(this.suggestionTimeout);
      
      // If input is empty or too short, rely on prefetched suggestions
      if (query.length < 2) {
        this.showPrefetchedSuggestions(query);
        return;
      }
      
      // Only fetch suggestions if we have at least 2 characters
      this.suggestionTimeout = setTimeout(() => {
        // Double-check the input hasn't been cleared while waiting
        const currentQuery = locationInput.value.trim();
        if (currentQuery.length >= 2 && currentQuery === query) {
          this.fetchLocationSuggestions(currentQuery);
        } else {
          this.showPrefetchedSuggestions(currentQuery);
        }
      }, debounceDelay);
    });

    // Handle keyboard navigation
    locationInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.navigateSuggestions(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.navigateSuggestions(-1);
      } else if (e.key === 'Enter') {
        if (this.selectedSuggestionIndex >= 0 && this.locationSuggestions[this.selectedSuggestionIndex]) {
          e.preventDefault();
          this.selectSuggestion(this.locationSuggestions[this.selectedSuggestionIndex]);
        } else {
          this.searchEvents();
        }
      } else if (e.key === 'Escape') {
        this.hideSuggestions();
      }
    });

    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
      if (!locationInput.contains(e.target) && !suggestionsContainer.contains(e.target)) {
        this.hideSuggestions();
      }
    });

    // Handle focus to show suggestions if there's text
    locationInput.addEventListener('focus', () => {
      if (locationInput.value.trim().length >= 2 && this.locationSuggestions.length > 0) {
        this.showSuggestions();
      }
    });
  }

  async searchEvents() {
    const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const location = document.getElementById('location').value.trim();
    const radius = parseInt(document.getElementById('radius').value) || 25;
    const timeBuffer = parseInt(document.getElementById('timeBuffer').value) || 30;

    if (!location) {
      alert('Please enter a location');
      return;
    }

    // Hide suggestions when searching
    this.hideSuggestions();

    if (!this.canProceedWithSearch()) {
      this.showPaywallModal('limit');
      return;
    }

    try {
      this.showLoading();
      this.isManualSearch = true; // Prevent zoom updates during manual search
      this.selectedEventId = null; // Reset selection on new search

      // Get coordinates for location
      const coords = await this.geocodeLocation(location);
      this.locationCoords = coords;

      // Check if country is supported
      if (!this.isCountrySupported(coords.country, coords.countryCode)) {
        this.hideLoading();
        this.displayUnsupportedCountryMessage(coords.country || location);
        // Clear any existing markers
        this.markers.forEach(marker => this.map.removeLayer(marker));
        this.markers = [];
        this.conflicts = [];
        this.eventConflictsMap = {};
        // Still center map on location for reference
        this.map.setView([coords.lat, coords.lng], 12);
        return;
      }

      // Remove click marker when using text search
      if (this.clickMarker) {
        this.map.removeLayer(this.clickMarker);
        this.clickMarker = null;
      }

      const headers = {};
      if (this.userEmail) {
        headers['X-User-Email'] = this.userEmail;
      }

      // Fetch events from API
      const response = await fetch(`/api/events/search?lat=${coords.lat}&lon=${coords.lng}&radius=${radius}`, {
        headers
      });

      if (response.status === 402) {
        const payload = await response.json().catch(() => ({}));
        this.handleServerPaywallLimit(payload);
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      this.events = data.events || [];
      this.syncPlanHeaders(response.headers);

      // Only center map on location if no events found (so user can see where they searched)
      // Otherwise, let displayEvents() handle the map view based on actual event locations
      if (this.events.length === 0) {
        this.map.setView([coords.lat, coords.lng], 12);
      }

      // Update events display (this will handle map zoom/bounds for events)
      this.displayEvents();

      // Detect conflicts
      await this.detectConflicts(timeBuffer);

      if (!this.hasUnlimitedAccess) {
        this.incrementFreeSearchCount();
      }

      // Store search parameters for zoom/pan comparison
      this.lastSearchRadius = radius;
      this.lastZoomLevel = this.map.getZoom();

      // Reset manual search flag after a short delay to allow map to settle
      setTimeout(() => {
        this.isManualSearch = false;
      }, 500);

    } catch (error) {
      console.error('Search error:', error);
      alert('Error searching events. Please try again.');
      this.displayError('Failed to search events. Please check your connection and try again.');
      this.isManualSearch = false; // Reset flag on error
    } finally {
      this.hideLoading();
      this.logPerformance('searchEvents', perfStart, {
        eventsReturned: this.events.length,
        radius,
        timeBuffer
      });
    }
  }

  async geocodeLocation(location) {
    try {
      // Normalize common typos and variations
      const normalizedLocation = this.normalizeLocationInput(location);
      
      // Use OpenStreetMap Nominatim API for geocoding (free, no API key required)
      const encodedLocation = encodeURIComponent(normalizedLocation);
      // Request more results to find the best match from supported countries
      const url = `https://nominatim.openstreetmap.org/search?q=${encodedLocation}&format=json&limit=20&addressdetails=1`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'EventConflictFinder/1.0' // Required by Nominatim
        }
      });

      if (!response.ok) {
        throw new Error(`Geocoding API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data && data.length > 0) {
        // Prefer more specific results (city > town > village > state > country)
        // Priority order: city > town > village > municipality > county > state > country
        const priorityOrder = {
          'city': 1,
          'town': 2,
          'village': 3,
          'municipality': 4,
          'county': 5,
          'state': 6,
          'country': 7
        };

        // First, try to find results from supported countries
        const supportedResults = [];
        const unsupportedResults = [];

        for (const result of data) {
          const country = result.address?.country;
          const countryCode = result.address?.country_code?.toUpperCase();
          const isSupported = this.isCountrySupported(country, countryCode);
          
          if (isSupported) {
            supportedResults.push(result);
          } else {
            unsupportedResults.push(result);
          }
        }

        // Prefer results from supported countries
        const candidates = supportedResults.length > 0 ? supportedResults : data;
        
        // Find the most specific result from candidates
        let bestResult = candidates[0];
        let bestPriority = 99;

        for (const result of candidates) {
          // Use addresstype to determine location specificity (city, state, etc.)
          const placeType = result.addresstype;
          const priority = placeType ? (priorityOrder[placeType] || 99) : 99;
          
          // Prefer results with higher importance and lower priority (more specific)
          if (priority < bestPriority || 
              (priority === bestPriority && result.importance > bestResult.importance)) {
            bestResult = result;
            bestPriority = priority;
          }
        }

        // Extract country information
        const country = bestResult.address?.country || null;
        const countryCode = bestResult.address?.country_code?.toUpperCase() || null;
        
        return {
          lat: parseFloat(bestResult.lat),
          lng: parseFloat(bestResult.lon),
          country: country,
          countryCode: countryCode,
          address: bestResult.address
        };
      } else {
        throw new Error('Location not found');
      }
    } catch (error) {
      console.error('Geocoding error:', error);
      // Fallback to default location (New York) if geocoding fails
      console.warn(`Failed to geocode "${location}", defaulting to New York`);
      return { lat: 40.7128, lng: -74.0060, country: 'United States', countryCode: 'US' };
    }
  }

  normalizeLocationInput(location) {
    if (!location) return location;
    
    let normalized = location.trim();
    
    // Common typos and variations for major cities
    // Order matters - more specific patterns first
    const cityCorrections = [
      { pattern: /new\s+yourk\s+market/gi, replacement: 'new york' },
      { pattern: /new\s+yourk/gi, replacement: 'new york' },
      { pattern: /new\s+york\s+market/gi, replacement: 'new york' },
      { pattern: /new\s+york\s+city/gi, replacement: 'new york' },
      { pattern: /\bnyc\b/gi, replacement: 'new york' },
      { pattern: /\bla\b/gi, replacement: 'los angeles' },
      { pattern: /\bsf\b/gi, replacement: 'san francisco' }
    ];
    
    // Apply corrections
    for (const correction of cityCorrections) {
      normalized = normalized.replace(correction.pattern, correction.replacement);
    }
    
    // Remove common non-location words that might confuse geocoding
    const wordsToRemove = ['market', 'mall', 'store', 'shop', 'center', 'centre'];
    const lowerNormalized = normalized.toLowerCase();
    for (const word of wordsToRemove) {
      // Remove word if it appears at the end after a space
      const regex = new RegExp(`\\s+${word}\\s*$`, 'gi');
      if (lowerNormalized.includes(` ${word}`) && lowerNormalized.endsWith(word)) {
        normalized = normalized.replace(regex, '').trim();
      }
    }
    
    return normalized.trim();
  }

  isCountrySupported(country, countryCode) {
    if (!country && !countryCode) {
      return true; // If we can't determine country, allow search (graceful degradation)
    }
    
    // Check by country name
    if (country) {
      const countryUpper = country.toUpperCase();
      if (this.supportedCountries.some(c => c.toUpperCase() === countryUpper)) {
        return true;
      }
    }
    
    // Check by country code
    if (countryCode) {
      const codeUpper = countryCode.toUpperCase();
      if (this.supportedCountries.some(c => c.toUpperCase() === codeUpper)) {
        return true;
      }
    }
    
    return false;
  }

  handleMapViewChange() {
    // Skip if manual search is in progress
    if (this.isManualSearch) {
      return;
    }

    // Skip if bounds are being fitted (to prevent infinite loops)
    if (this.isFittingBounds) {
      return;
    }

    // Skip if map movement was initiated by selecting/highlighting an event
    if (this.isSelectionUpdate) {
      return;
    }

    // Skip auto-refresh while a marker is selected so zooming doesn't reset highlights
    if (this.selectedEventId) {
      return;
    }

    // Skip if no location has been set (initial map load)
    if (!this.locationCoords) {
      return;
    }

    // Clear any pending update
    if (this.zoomUpdateTimeout) {
      clearTimeout(this.zoomUpdateTimeout);
    }

    // Debounce the update to avoid too many API calls
    this.zoomUpdateTimeout = setTimeout(async () => {
      const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
      try {
        const currentZoom = this.map.getZoom();
        
        // Only update if zoom changed significantly (at least 1 level) or if it's the first time
        if (this.lastZoomLevel !== null && Math.abs(currentZoom - this.lastZoomLevel) < 1) {
          // Check if map was panned significantly instead
          const bounds = this.map.getBounds();
          const center = this.map.getCenter();
          
          // Calculate radius based on visible bounds
          const ne = bounds.getNorthEast();
          const sw = bounds.getSouthWest();
          const centerLat = center.lat;
          const centerLng = center.lng;
          
          // Calculate distance from center to corner (approximate radius)
          const distanceNE = this.calculateDistance(centerLat, centerLng, ne.lat, ne.lng);
          const distanceSW = this.calculateDistance(centerLat, centerLng, sw.lat, sw.lng);
          const radius = Math.max(distanceNE, distanceSW) * 0.000621371; // Convert meters to miles
          
          // Only update if the visible area changed significantly (more than 20% difference)
          const previousRadius = this.lastSearchRadius || 25;
          if (Math.abs(radius - previousRadius) / previousRadius < 0.2) {
            return; // Not significant enough change
          }
        }

        // Get current map bounds and center
        const bounds = this.map.getBounds();
        const center = this.map.getCenter();
        
        // Calculate radius based on visible bounds
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        
        // Calculate distance from center to corner (approximate radius in miles)
        const distanceNE = this.calculateDistance(center.lat, center.lng, ne.lat, ne.lng);
        const distanceSW = this.calculateDistance(center.lat, center.lng, sw.lat, sw.lng);
        const radius = Math.max(distanceNE, distanceSW) * 0.000621371; // Convert meters to miles
        
        // Ensure minimum radius of 1 mile and maximum of 100 miles
        const searchRadius = Math.max(1, Math.min(100, Math.ceil(radius)));
        
        // Get time buffer from UI
        const timeBuffer = parseInt(document.getElementById('timeBuffer')?.value) || 30;
        
        // Update location coordinates to current center
        this.locationCoords = {
          lat: center.lat,
          lng: center.lng,
          country: this.locationCoords?.country || null,
          countryCode: this.locationCoords?.countryCode || null
        };
        
        // Store for next comparison
        this.lastSearchRadius = searchRadius;
        this.lastZoomLevel = currentZoom;
        
        // Fetch events for the visible area
        if (!this.canProceedWithSearch()) {
          this.showPaywallModal('limit');
          return;
        }

        const headers = {};
        if (this.userEmail) {
          headers['X-User-Email'] = this.userEmail;
        }

        const response = await fetch(`/api/events/search?lat=${center.lat}&lon=${center.lng}&radius=${searchRadius}`, {
          headers
        });

        if (response.status === 402) {
          const payload = await response.json().catch(() => ({}));
          this.handleServerPaywallLimit(payload);
          return;
        }
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        this.events = data.events || [];
        this.syncPlanHeaders(response.headers);
        
        // Update events display
        this.displayEvents();
        
        // Detect conflicts
        await this.detectConflicts(timeBuffer);
        if (!this.hasUnlimitedAccess) {
          this.incrementFreeSearchCount();
        }
        
        // Ensure markers are visible after map view update
        setTimeout(() => {
          this.ensureMarkersVisible();
        }, 100);
        
        console.log(`Updated events based on map view: ${this.events.length} events in ${searchRadius.toFixed(1)} mile radius`);
        
      } catch (error) {
        console.error('Error updating events based on map view:', error);
        // Don't show alert to user, just log the error
      } finally {
        this.logPerformance('mapViewUpdate', perfStart, {
          eventsFetched: this.events.length,
          radius: this.lastSearchRadius,
          zoomLevel: this.lastZoomLevel
        });
      }
    }, 500); // 500ms debounce delay
  }

  // Helper method to calculate distance between two coordinates (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c; // Distance in meters
    
    return distance;
  }

  toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  displayUnsupportedCountryMessage(country) {
    const modal = document.getElementById('unsupported-country-modal');
    const countryNameElement = document.getElementById('modal-country-name');
    const eventsList = document.getElementById('events-list');
    const eventsCount = document.getElementById('events-count');
    
    // Update events count
    eventsCount.textContent = '0';
    
    // Clear events list
    eventsList.innerHTML = '<div class="empty-state"><p>No events found for this location.</p></div>';
    
    // Set country name in modal
    const countryName = country || 'this location';
    if (countryNameElement) {
      countryNameElement.textContent = countryName;
    }
    
    // Show modal (Tailwind: change hidden to flex)
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }
  }

  hideUnsupportedCountryModal() {
    const modal = document.getElementById('unsupported-country-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      // Restore body scroll
      document.body.style.overflow = '';
    }
  }

  displayEvents() {
    const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const eventsList = document.getElementById('events-list');
    const eventsCount = document.getElementById('events-count');

    eventsCount.textContent = this.events.length;

    // Ensure map is initialized
    if (!this.map) {
      console.error('Map is not initialized. Cannot display markers.');
      return;
    }
    
    // Ensure map is ready - invalidate size and wait a bit
    this.map.invalidateSize();
    
    // Debug: Check if marker pane exists
    const markerPane = this.map.getPane('markerPane');
    if (!markerPane) {
      console.error('Marker pane does not exist!');
    } else {
      console.log('Marker pane found:', markerPane);
      console.log('Marker pane styles:', window.getComputedStyle(markerPane));
    }

    // Clear existing markers
    if (this.markers.length > 0) {
      this.markers.forEach(marker => {
        try {
          this.map.removeLayer(marker);
        } catch (error) {
          console.warn('Error removing marker:', error);
        }
      });
    }
    this.markers = [];
    this.eventConflictsMap = {}; // Reset conflicts map

    if (this.events.length === 0) {
      eventsList.innerHTML = '<div class="empty-state"><p>No events found for this location.</p></div>';
      return;
    }
    
    console.log(`Displaying ${this.events.length} events on map`);

    eventsList.innerHTML = '';

    // Build conflicts map for quick lookup
    this.buildConflictsMap();

    // Add markers and list items
    this.events.forEach(event => {
      if (!event.venue || !event.venue.lat || !event.venue.lon) {
        return;
      }

      // Parse coordinates to ensure they are numbers
      const lat = parseFloat(event.venue.lat);
      const lon = parseFloat(event.venue.lon);
      
      // Validate coordinates
      if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        console.warn(`Invalid coordinates for event ${event.id}:`, { lat: event.venue.lat, lon: event.venue.lon });
        return;
      }

      // Ensure map is initialized and ready
      if (!this.map) {
        console.error('Map is not initialized');
        return;
      }
      
      // Ensure map container is ready
      const mapContainer = this.map.getContainer();
      if (!mapContainer || mapContainer.offsetWidth === 0 || mapContainer.offsetHeight === 0) {
        console.warn(`Map container not ready for event ${event.id}, invalidating size`);
        this.map.invalidateSize();
      }

      // Create map marker with conflict-based color
      const markerColor = this.getMarkerColorByConflicts(event.id);
      
      try {
        // Ensure marker pane exists and is visible before creating markers
        const markerPane = this.map.getPane('markerPane');
        if (markerPane) {
          markerPane.style.zIndex = '650';
          markerPane.style.display = 'block';
          markerPane.style.visibility = 'visible';
          markerPane.style.opacity = '1';
          markerPane.style.pointerEvents = 'auto';
        }
        
        // Create a custom pin-style marker icon
        const markerIcon = L.divIcon({
          className: 'custom-pin-marker',
          html: `
            <div class="pin-container" style="position: relative; width: 30px; height: 40px;">
              <div class="pin-shadow" style="
                position: absolute;
                width: 20px;
                height: 20px;
                background: ${markerColor};
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                left: 5px;
                top: 5px;
                border: 2px solid white;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
              "></div>
              <div class="pin-dot" style="
                position: absolute;
                width: 8px;
                height: 8px;
                background: white;
                border-radius: 50%;
                left: 11px;
                top: 11px;
                z-index: 1;
              "></div>
            </div>
          `,
          iconSize: [30, 40],
          iconAnchor: [15, 40],
          popupAnchor: [0, -40]
        });
        
        const marker = L.marker([lat, lon], {
          icon: markerIcon,
          zIndexOffset: 1000,
          keyboard: true,
          title: event.name,
          riseOnHover: true,
          bubblingMouseEvents: true
        });
        
        // Store color for later use
        marker._markerColor = markerColor;
        
        // Add marker to map
        marker.addTo(this.map);
        
        // Verify marker was added
        if (!this.map.hasLayer(marker)) {
          console.error(`Failed to add marker for event ${event.id} to map`);
        } else {
          const markerElement = marker.getElement();
          if (!markerElement) {
            console.warn(`Marker element not found in DOM for event ${event.id}`);
          } else {
            // Additional debug info
            const rect = markerElement.getBoundingClientRect();
            console.log(`Marker element for ${event.name}:`, {
              display: window.getComputedStyle(markerElement).display,
              visibility: window.getComputedStyle(markerElement).visibility,
              opacity: window.getComputedStyle(markerElement).opacity,
              zIndex: window.getComputedStyle(markerElement).zIndex,
              position: window.getComputedStyle(markerElement).position,
              boundingRect: rect,
              inViewport: rect.width > 0 && rect.height > 0
            });
          }
        }

        const startDate = new Date(event.start);
        const endDate = new Date(event.end);

        // Bind popup to circleMarker
        const popupContent = `
          <div style="min-width: 200px;">
            <strong>${this.escapeHtml(event.name)}</strong><br>
            <strong>Source:</strong> ${event.source}<br>
            <strong>Venue:</strong> ${event.venue.name || 'N/A'}<br>
            <strong>Start:</strong> ${startDate.toLocaleString()}<br>
            <strong>End:</strong> ${endDate.toLocaleString()}<br>
            ${event.url ? `<a href="${event.url}" target="_blank">View Event</a>` : ''}
            <br><br>
            <button onclick="window.selectEventFromMap('${event.id}')" style="background: #667eea; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; width: 100%; margin-top: 8px;">
              View Conflicts
            </button>
          </div>
        `;
        
        marker.bindPopup(popupContent);

        // Store marker reference with event
        marker.eventId = event.id;
        
        // Add click handler to marker
        marker.on('click', () => {
          this.selectEvent(event.id);
        });

        this.markers.push(marker);
        console.log(`Marker created and added for event: ${event.name} at [${lat}, ${lon}]`);
      } catch (error) {
        console.error(`Error creating marker for event ${event.id}:`, error, { lat, lon, event });
        // Continue with next event even if this one fails
        return; // Skip creating list item if marker creation failed
      }

      // Create list item with click handler (only if marker was created successfully)
      const startDate = new Date(event.start);
      const endDate = new Date(event.end);
      const eventItem = document.createElement('div');
      eventItem.className = 'event-item';
      eventItem.dataset.eventId = event.id;
      
      // Check if this event has conflicts
      const hasConflicts = this.eventConflictsMap[event.id] && this.eventConflictsMap[event.id].length > 0;
      const conflictBadge = hasConflicts 
        ? `<span class="conflict-badge" title="${this.eventConflictsMap[event.id].length} conflict(s)">⚠️ ${this.eventConflictsMap[event.id].length}</span>`
        : '';
      
      eventItem.innerHTML = `
        <h4>
          ${this.escapeHtml(event.name)}
          ${conflictBadge}
        </h4>
        <p><strong>Venue:</strong> ${event.venue.name || 'N/A'}</p>
        <p><strong>Time:</strong> ${startDate.toLocaleString()} - ${endDate.toLocaleTimeString()}</p>
        <span class="source-badge ${event.source}">${event.source}</span>
      `;
      
      // Add click handler
      eventItem.addEventListener('click', () => this.selectEvent(event.id));
      eventItem.style.cursor = 'pointer';
      
      eventsList.appendChild(eventItem);
    });

    // Log summary of markers created
    const markersOnMap = this.markers.filter(m => {
      try {
        return this.map.hasLayer(m);
      } catch (e) {
        return false;
      }
    });
    console.log(`Total markers created: ${this.markers.length}, markers on map: ${markersOnMap.length}`);
    
    // Check if marker elements are in DOM
    let markersInDOM = 0;
    markersOnMap.forEach(marker => {
      try {
        const element = marker.getElement();
        if (element && element.offsetParent !== null) {
          markersInDOM++;
        }
      } catch (e) {
        // Ignore errors
      }
    });
    console.log(`Markers visible in DOM: ${markersInDOM} of ${markersOnMap.length}`);
    
    // Always ensure markers are visible
    this.ensureMarkersVisible();
    
    if (markersOnMap.length === 0 && this.markers.length > 0) {
      console.error('WARNING: No markers are visible on the map! This may indicate a problem with marker creation or map initialization.');
    } else if (markersInDOM === 0 && markersOnMap.length > 0) {
      console.error('WARNING: Markers are on the map but not visible in DOM! This may indicate a CSS or rendering issue.');
      // Try to force visibility of all markers
      this.ensureMarkersVisible();
    }

    // Fit map to show all markers (only if no event is selected)
    // Use setTimeout to ensure all markers are fully added to the map before fitting bounds
    if (this.markers.length > 0 && this.map && !this.selectedEventId) {
      // Wait for map to be ready and tiles to load
      const fitBoundsWhenReady = () => {
        try {
          // Ensure map is still valid
          if (!this.map || this.markers.length === 0) {
            return;
          }

          // Ensure map container is properly sized
          const mapContainer = this.map.getContainer();
          if (!mapContainer) {
            console.warn('Map container not found');
            return;
          }

          // Check if container has dimensions
          if (mapContainer.offsetWidth === 0 || mapContainer.offsetHeight === 0) {
            console.warn('Map container not properly sized, invalidating size');
            // Force map to recalculate size
            this.map.invalidateSize();
            // Try again after a short delay
            setTimeout(() => {
              fitBoundsWhenReady();
            }, 200);
            return;
          }

          // Fit bounds - the map should be ready by now
          // Use a slightly longer delay to ensure everything is rendered
          setTimeout(() => {
            this.fitMapToMarkers();
          }, 200);
        } catch (error) {
          console.error('Error in map bounds fitting:', error);
        }
      };

      // Initial delay to ensure markers are fully rendered and map is ready
      // Use a longer delay to ensure everything is properly initialized
      setTimeout(() => {
        fitBoundsWhenReady();
      }, 300);
    } else if (this.selectedEventId && this.markers.length > 0) {
      // If an event is selected, update view for that selection
      const conflictingEventIds = new Set();
      const eventConflicts = this.eventConflictsMap[this.selectedEventId] || [];
      eventConflicts.forEach(conflict => {
        conflict.events.forEach(event => {
          if (String(event.id) !== String(this.selectedEventId)) {
            conflictingEventIds.add(String(event.id));
          }
        });
      });
      // Use setTimeout to ensure markers are ready
      setTimeout(() => {
        this.updateMapViewForSelection(this.selectedEventId, conflictingEventIds);
      }, 100);
    }

    // If an event was previously selected, maintain selection and highlight
    if (this.selectedEventId) {
      // Use setTimeout to ensure markers are fully created
      setTimeout(() => {
        this.selectEvent(this.selectedEventId);
      }, 50);
    }

    this.logPerformance('displayEvents', perfStart, {
      eventsRendered: this.events.length,
      markersRendered: this.markers.length
    });
  }

  fitMapToMarkers() {
    if (!this.map || this.markers.length === 0) {
      return;
    }

    // Ensure map size is valid before fitting bounds
    this.map.invalidateSize();

    // Set flag to prevent zoom updates during bounds fitting
    this.isFittingBounds = true;

    try {
      // Create feature group from all valid markers
      const validMarkers = this.markers.filter(marker => {
        try {
          const latLng = marker.getLatLng();
          if (!latLng) return false;
          const lat = parseFloat(latLng.lat);
          const lon = parseFloat(latLng.lng);
          return !isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
        } catch (e) {
          return false;
        }
      });

      if (validMarkers.length === 0) {
        console.warn('No valid markers to fit bounds');
        this.isFittingBounds = false;
        return;
      }

      // Ensure all markers are actually on the map
      const markersOnMap = validMarkers.filter(marker => {
        try {
          return this.map.hasLayer(marker);
        } catch (e) {
          return false;
        }
      });

      if (markersOnMap.length === 0) {
        console.warn('No markers are on the map');
        this.isFittingBounds = false;
        return;
      }

      const group = new L.featureGroup(markersOnMap);
      const bounds = group.getBounds();
      
      if (bounds.isValid()) {
        // Calculate appropriate zoom based on number of events and spread
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const boundsSize = ne.distanceTo(sw);
        
        // Determine min and max zoom based on event count and spread
        let minZoom = 10; // Default minimum zoom
        let maxZoom = 18; // Default maximum zoom
        
        // If few events close together, allow higher zoom
        if (markersOnMap.length <= 5 && boundsSize < 5000) {
          minZoom = 13;
          maxZoom = 18;
        }
        // If many events spread out, allow lower zoom
        else if (markersOnMap.length > 20 || boundsSize > 50000) {
          minZoom = 8;
          maxZoom = 14;
        }
        // Medium spread
        else {
          minZoom = 10;
          maxZoom = 16;
        }

        // Use a larger padding to ensure all markers are visible
        const padding = [50, 50]; // Top/bottom and left/right padding in pixels

        // Store bounds and zoom limits for later use
        const markerBounds = bounds;
        const fitMinZoom = minZoom;
        const fitMaxZoom = maxZoom;
        
        // Fit bounds with appropriate padding and zoom limits
        this.map.fitBounds(markerBounds, { 
          padding: padding,
          minZoom: fitMinZoom,
          maxZoom: fitMaxZoom,
          animate: true,
          duration: 0.8,
          easeLinearity: 0.25
        });
        
        console.log(`Fitted map to show all ${markersOnMap.length} markers (zoom range: ${fitMinZoom}-${fitMaxZoom}, bounds size: ${boundsSize.toFixed(0)}m)`);
        
        // Reset flag after a delay to allow zoom animation to complete
        setTimeout(() => {
          this.isFittingBounds = false;
          this.lastZoomLevel = this.map.getZoom();
          // Invalidate size one more time to ensure everything is correct
          this.map.invalidateSize();
          
          // Final check: verify markers are visible
          const currentMapBounds = this.map.getBounds();
          const visibleMarkers = markersOnMap.filter(marker => {
            try {
              const latLng = marker.getLatLng();
              return currentMapBounds.contains(latLng);
            } catch (e) {
              return false;
            }
          });
          
          if (visibleMarkers.length < markersOnMap.length) {
            console.warn(`Only ${visibleMarkers.length} of ${markersOnMap.length} markers are visible in current view. Re-fitting bounds...`);
            // Try fitting bounds again
            setTimeout(() => {
              this.map.fitBounds(markerBounds, { 
                padding: [50, 50],
                minZoom: fitMinZoom,
                maxZoom: fitMaxZoom,
                animate: false // No animation on retry
              });
            }, 100);
          } else {
            console.log(`All ${markersOnMap.length} markers are visible in current view.`);
          }
          // Ensure markers are visible after bounds fitting
          this.ensureMarkersVisible();
        }, 1000);
      } else {
        console.warn('Invalid bounds, centering on markers');
        // Fallback: calculate center of all markers and set appropriate zoom
        if (validMarkers.length > 0) {
          let totalLat = 0;
          let totalLon = 0;
          let validCount = 0;
          
          validMarkers.forEach(marker => {
            try {
              const latLng = marker.getLatLng();
              if (latLng) {
                totalLat += latLng.lat;
                totalLon += latLng.lng;
                validCount++;
              }
            } catch (e) {
              // Skip invalid markers
            }
          });
          
          if (validCount > 0) {
            const centerLat = totalLat / validCount;
            const centerLon = totalLon / validCount;
            
            // Determine zoom based on number of events
            const zoomLevel = validMarkers.length <= 3 ? 14 : validMarkers.length <= 10 ? 12 : 10;
            
            this.map.setView([centerLat, centerLon], zoomLevel, {
              animate: true,
              duration: 0.5
            });
            
            console.log(`Centered map on marker center: [${centerLat.toFixed(4)}, ${centerLon.toFixed(4)}] at zoom ${zoomLevel}`);
            
            // Reset flag after animation
            setTimeout(() => {
              this.isFittingBounds = false;
              this.lastZoomLevel = this.map.getZoom();
              this.map.invalidateSize();
            }, 600);
          } else {
            this.isFittingBounds = false;
          }
        } else {
          this.isFittingBounds = false;
        }
      }
    } catch (error) {
      console.error('Error fitting map bounds:', error);
      this.isFittingBounds = false;
      // Fallback: center on first marker if bounds fail
      if (this.markers.length > 0 && this.markers[0]) {
        try {
          const firstMarkerLatLng = this.markers[0].getLatLng();
          if (firstMarkerLatLng) {
            const zoomLevel = this.markers.length <= 3 ? 14 : this.markers.length <= 10 ? 12 : 10;
            this.map.setView([firstMarkerLatLng.lat, firstMarkerLatLng.lng], zoomLevel, {
              animate: true,
              duration: 0.5
            });
            setTimeout(() => {
              this.isFittingBounds = false;
              this.lastZoomLevel = this.map.getZoom();
            }, 600);
          }
        } catch (fallbackError) {
          console.error('Fallback centering also failed:', fallbackError);
          this.isFittingBounds = false;
        }
      }
    }
  }

  buildConflictsMap() {
    // Build a map of event ID to conflicts involving that event
    this.eventConflictsMap = {};
    
    this.conflicts.forEach(conflict => {
      // Ensure conflict has at least 2 different events
      const uniqueEventIds = [...new Set(conflict.events.map(e => String(e.id)))];
      if (uniqueEventIds.length < 2) {
        console.warn('Conflict has less than 2 unique events:', conflict);
        return; // Skip invalid conflicts
      }
      
      conflict.events.forEach(event => {
        const eventId = String(event.id); // Normalize to string
        if (!this.eventConflictsMap[eventId]) {
          this.eventConflictsMap[eventId] = [];
        }
        // Only add if not already present (avoid duplicates)
        const conflictExists = this.eventConflictsMap[eventId].some(c => 
          c.timeSlot === conflict.timeSlot && 
          c.conflictType === conflict.conflictType
        );
        if (!conflictExists) {
          this.eventConflictsMap[eventId].push(conflict);
        }
      });
    });
  }

  selectEvent(eventId) {
    // Update selected event (normalize to string for consistency)
    this.selectedEventId = String(eventId);
    
    // Update UI first
    this.updateEventSelection();
    this.displayEventConflicts(String(eventId));
    
    // Ensure markers are ready before highlighting
    if (this.markers.length === 0) {
      console.warn('No markers available for selection');
      return;
    }
    
    // Open popup for the selected marker
    const selectedMarker = this.markers.find(m => String(m.eventId) === String(eventId));
    if (selectedMarker) {
      selectedMarker.openPopup();
    } else {
      console.warn(`Marker not found for event ID: ${eventId}`);
    }
    
    // Highlight markers and update map view
    // Use a small delay to ensure DOM is ready
    setTimeout(() => {
      this.highlightConflictingEvents(String(eventId));
    }, 10);
    
    // Scroll to event in list if it exists
    const eventItem = document.querySelector(`[data-event-id="${eventId}"]`);
    if (eventItem) {
      eventItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  updateEventSelection() {
      // Update event items styling - use class instead of inline styles
    const eventItems = document.querySelectorAll('.event-item');
    eventItems.forEach(item => {
      if (item.dataset.eventId === this.selectedEventId) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }

  displayEventConflicts(eventId) {
    const conflictList = document.getElementById('conflict-list');
    const conflictCount = document.getElementById('conflict-count');
    const conflictPanel = document.getElementById('conflict-panel-title');
    
    // Normalize eventId to string for comparison
    const normalizedEventId = String(eventId);
    
    const event = this.events.find(e => String(e.id) === normalizedEventId);
    const eventConflicts = this.eventConflictsMap[normalizedEventId] || [];

    if (conflictPanel) {
      if (event) {
        conflictPanel.textContent = `🚨 Conflicts for: ${this.escapeHtml(event.name)}`;
      } else {
        conflictPanel.textContent = '🚨 Conflicts Detected';
      }
    }

    if (conflictCount) {
      conflictCount.textContent = eventConflicts.length;
    }

    if (!conflictList) return;

    if (eventConflicts.length === 0) {
      conflictList.innerHTML = '<div class="empty-state"><p>✅ No conflicts detected for this event!</p></div>';
      return;
    }

    conflictList.innerHTML = '';

    eventConflicts.forEach((conflict, index) => {
      const conflictItem = document.createElement('div');
      conflictItem.className = `conflict-item ${conflict.severity}-severity`;
      
      const conflictTypeLabel = conflict.conflictType
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());

      // Find the other event(s) in this conflict (excluding the selected one)
      // Use strict comparison and also check by name to avoid duplicates
      const otherEvents = conflict.events.filter(e => {
        // Convert both to strings for comparison to handle type mismatches
        return String(e.id) !== String(eventId);
      });

      // Skip if no other events (shouldn't happen, but safety check)
      if (otherEvents.length === 0) {
        console.warn('Conflict has no other events after filtering:', conflict);
        return;
      }

      const severityBadge = `<span class="severity-badge">${conflict.severity}</span>`;
      
      // Get event times for better explanation
      const event1Start = new Date(conflict.events[0].start);
      const event1End = new Date(conflict.events[0].end);
      const event2Start = new Date(conflict.events[1].start);
      const event2End = new Date(conflict.events[1].end);
      
      // Check if same venue
      const isSameVenue = conflict.events[0].venue?.name === conflict.events[1].venue?.name;
      const conflictExplanation = isSameVenue 
        ? 'Both events are scheduled at the same venue with overlapping times.'
        : 'Events are at nearby venues with overlapping times.';
      
      conflictItem.innerHTML = `
        <h4>${conflictTypeLabel}</h4>
        <p style="font-size: 0.8rem; color: #6b7280; margin-bottom: 0.75rem; font-style: italic;">${conflictExplanation}</p>
        <p><strong>Time Slot:</strong> ${conflict.timeSlot}</p>
        <p><strong>Severity:</strong> ${severityBadge}</p>
        <p style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #e5e7eb;"><strong>Event Times:</strong></p>
        <ul style="margin-top: 0.5rem;">
          <li style="margin-bottom: 0.5rem;">
            <strong>${this.escapeHtml(conflict.events[0].name)}</strong><br>
            <span style="font-size: 0.8rem; color: #6b7280;">
              ${event1Start.toLocaleString()} - ${event1End.toLocaleTimeString()}
              ${isSameVenue ? '' : `<br>Venue: ${this.escapeHtml(conflict.events[0].venue?.name || 'Unknown')}`}
            </span>
          </li>
          <li>
            <strong>${this.escapeHtml(conflict.events[1].name)}</strong><br>
            <span style="font-size: 0.8rem; color: #6b7280;">
              ${event2Start.toLocaleString()} - ${event2End.toLocaleTimeString()}
              ${isSameVenue ? '' : `<br>Venue: ${this.escapeHtml(conflict.events[1].venue?.name || 'Unknown')}`}
            </span>
          </li>
        </ul>
        ${!isSameVenue ? `<p style="margin-top: 0.75rem;"><strong>Conflicting Event${otherEvents.length > 1 ? 's' : ''}:</strong></p>
        <ul>
          ${otherEvents.map(event => `
            <li>
              <strong>${this.escapeHtml(event.name)}</strong> 
              <span class="source-badge ${event.source}">${event.source}</span>
              ${event.venue ? `at ${this.escapeHtml(event.venue.name)}` : 'at Unknown venue'}
            </li>
          `).join('')}
        </ul>` : ''}
      `;

      conflictList.appendChild(conflictItem);
    });
  }

  highlightConflictingEvents(eventId) {
    // Normalize eventId to string
    const normalizedEventId = String(eventId);
    
    // Reset all markers to their original conflict-based state
    this.markers.forEach(marker => {
      try {
        const event = this.events.find(e => String(e.id) === String(marker.eventId));
        if (!event) return;
        
        // Use conflict-based color instead of source color
        const originalColor = this.getMarkerColorByConflicts(event.id);
        // Reset marker icon to original
        const originalIcon = L.divIcon({
          className: 'custom-pin-marker',
          html: `
            <div class="pin-container" style="position: relative; width: 30px; height: 40px;">
              <div class="pin-shadow" style="
                position: absolute;
                width: 20px;
                height: 20px;
                background: ${originalColor};
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                left: 5px;
                top: 5px;
                border: 2px solid white;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
              "></div>
              <div class="pin-dot" style="
                position: absolute;
                width: 8px;
                height: 8px;
                background: white;
                border-radius: 50%;
                left: 11px;
                top: 11px;
                z-index: 1;
              "></div>
            </div>
          `,
          iconSize: [30, 40],
          iconAnchor: [15, 40],
          popupAnchor: [0, -40]
        });
        marker.setIcon(originalIcon);
      } catch (error) {
        console.error('Error resetting marker icon:', error);
      }
    });

    // Get conflicting events
    const eventConflicts = this.eventConflictsMap[normalizedEventId] || [];
    const conflictingEventIds = new Set();
    
    eventConflicts.forEach(conflict => {
      conflict.events.forEach(event => {
        // Use string comparison to ensure we exclude the selected event
        if (String(event.id) !== normalizedEventId) {
          conflictingEventIds.add(String(event.id));
        }
      });
    });

    // Highlight selected event with gold/yellow pin
    const selectedMarker = this.markers.find(m => String(m.eventId) === normalizedEventId);
    if (selectedMarker) {
      const selectedIcon = L.divIcon({
        className: 'custom-pin-marker selected',
        html: `
          <div class="pin-container" style="position: relative; width: 36px; height: 48px;">
            <div class="pin-shadow" style="
              position: absolute;
              width: 24px;
              height: 24px;
              background: #FFD700;
              border-radius: 50% 50% 50% 0;
              transform: rotate(-45deg);
              left: 6px;
              top: 6px;
              border: 3px solid white;
              box-shadow: 0 3px 12px rgba(255, 215, 0, 0.6);
            "></div>
            <div class="pin-dot" style="
              position: absolute;
              width: 10px;
              height: 10px;
              background: white;
              border-radius: 50%;
              left: 13px;
              top: 13px;
              z-index: 1;
            "></div>
          </div>
        `,
        iconSize: [36, 48],
        iconAnchor: [18, 48],
        popupAnchor: [0, -48]
      });
      selectedMarker.setIcon(selectedIcon);
    }

    // Highlight conflicting events with red pins
    const conflictMarkers = [];
    conflictingEventIds.forEach(conflictEventId => {
      const conflictMarker = this.markers.find(m => String(m.eventId) === conflictEventId);
      if (conflictMarker) {
        try {
          const conflictIcon = L.divIcon({
            className: 'custom-pin-marker conflict',
            html: `
              <div class="pin-container" style="position: relative; width: 32px; height: 44px;">
                <div class="pin-shadow" style="
                  position: absolute;
                  width: 22px;
                  height: 22px;
                  background: #FF6B6B;
                  border-radius: 50% 50% 50% 0;
                  transform: rotate(-45deg);
                  left: 5px;
                  top: 5px;
                  border: 3px solid white;
                  box-shadow: 0 3px 10px rgba(255, 0, 0, 0.5);
                "></div>
                <div class="pin-dot" style="
                  position: absolute;
                  width: 9px;
                  height: 9px;
                  background: white;
                  border-radius: 50%;
                  left: 11.5px;
                  top: 11.5px;
                  z-index: 1;
                "></div>
              </div>
            `,
            iconSize: [32, 44],
            iconAnchor: [16, 44],
            popupAnchor: [0, -44]
          });
          conflictMarker.setIcon(conflictIcon);
          conflictMarkers.push(conflictMarker);
        } catch (error) {
          console.error('Error highlighting conflict marker:', error);
        }
      } else {
        console.warn(`Conflict marker not found for event ID: ${conflictEventId}`);
      }
    });
    
    // Update map view to show selected event and all conflicting events
    this.updateMapViewForSelection(normalizedEventId, conflictingEventIds);
    
    console.log(`Highlighted ${conflictingEventIds.size} conflicting events for selected event ${normalizedEventId}`);
  }

  updateMapViewForSelection(eventId, conflictingEventIds) {
    if (!this.map) {
      console.error('Map is not initialized');
      return;
    }

    // Set flag to prevent selection-driven map moves from triggering new searches
    this.isSelectionUpdate = true;

    try {
      const selectedMarker = this.markers.find(m => String(m.eventId) === String(eventId));
      const conflictMarkers = Array.from(conflictingEventIds)
        .map(id => this.markers.find(m => String(m.eventId) === String(id)))
        .filter(m => m !== undefined);

      // Collect all relevant markers (selected + conflicting)
      const relevantMarkers = [selectedMarker, ...conflictMarkers].filter(m => m !== undefined);
      const currentZoom = this.map.getZoom();

      if (relevantMarkers.length === 0) {
        console.warn('No markers found for selection');
        return;
      }

      // If only one marker (just the selected event), center on it with appropriate zoom
      if (relevantMarkers.length === 1 && selectedMarker) {
        const latLng = selectedMarker.getLatLng();
        if (latLng) {
          this.map.panTo([latLng.lat, latLng.lng], {
            animate: true,
            duration: 0.5,
            easeLinearity: 0.25
          });
          console.log(`Panned map to selected event at [${latLng.lat}, ${latLng.lng}] without changing zoom`);
        }
      } else if (relevantMarkers.length > 1) {
        // Multiple markers: fit bounds to show all relevant events
        const group = new L.featureGroup(relevantMarkers);
        const bounds = group.getBounds();
        
        if (bounds.isValid()) {
          // Merge current map bounds to ensure other markers remain visible
          const combinedBounds = bounds.pad(0);
          const currentBounds = this.map.getBounds();
          combinedBounds.extend(currentBounds.getNorthEast());
          combinedBounds.extend(currentBounds.getSouthWest());

          this.map.flyToBounds(combinedBounds, {
            padding: [50, 50],
            maxZoom: currentZoom,
            animate: true,
            duration: 0.5,
            easeLinearity: 0.25
          });
          console.log(`Adjusted map bounds to include selection and existing view (${relevantMarkers.length} relevant events)`);
        } else {
          // Fallback: center on selected event
          if (selectedMarker) {
            const latLng = selectedMarker.getLatLng();
            if (latLng) {
              this.map.panTo([latLng.lat, latLng.lng], {
                animate: true,
                duration: 0.5
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Error updating map view for selection:', error);
      // Fallback: try to center on selected event
      const selectedMarker = this.markers.find(m => String(m.eventId) === String(eventId));
      if (selectedMarker) {
        try {
          const latLng = selectedMarker.getLatLng();
          if (latLng) {
            this.map.panTo([latLng.lat, latLng.lng], {
              animate: true,
              duration: 0.5
            });
          }
        } catch (fallbackError) {
          console.error('Fallback map centering also failed:', fallbackError);
        }
      }
    } finally {
      // Allow map-driven updates again after animation completes
      setTimeout(() => {
        this.isSelectionUpdate = false;
      }, 600);
    }
  }

  async detectConflicts(timeBuffer) {
    const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    try {
      const response = await fetch('/api/conflicts/detect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          events: this.events,
          timeBuffer: timeBuffer
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      this.conflicts = data.conflicts || [];
      
      // Rebuild conflicts map
      this.buildConflictsMap();
      
      // Update marker colors based on conflicts
      this.updateMarkerColors();
      
      // Refresh events display to show conflict badges
      // Store current selection before refreshing
      const previouslySelectedId = this.selectedEventId;
      this.displayEvents();
      
      // Restore selection and highlight after markers are recreated
      if (previouslySelectedId) {
        // Use setTimeout to ensure markers are created before highlighting
        setTimeout(() => {
          this.selectEvent(previouslySelectedId);
        }, 100);
      } else {
        // If no event is selected, show all conflicts message
        this.displayConflicts();
      }

    } catch (error) {
      console.error('Conflict detection error:', error);
      this.displayError('Failed to detect conflicts. Please try again.');
    } finally {
      this.logPerformance('detectConflicts', perfStart, {
        eventsAnalyzed: this.events.length,
        conflictsFound: Array.isArray(this.conflicts) ? this.conflicts.length : 0,
        timeBuffer
      });
    }
  }

  displayConflicts() {
    // Original method - show all conflicts when no event is selected
    const conflictList = document.getElementById('conflict-list');
    const conflictCount = document.getElementById('conflict-count');
    const conflictPanel = document.getElementById('conflict-panel-title');

    if (conflictPanel) {
      conflictPanel.textContent = '🚨 Conflicts Detected';
    }
    if (conflictCount) {
      conflictCount.textContent = this.conflicts.length;
    }

    if (!conflictList) return;

    if (this.conflicts.length === 0) {
      conflictList.innerHTML = '<div class="empty-state"><p>✅ No conflicts detected!</p></div>';
      return;
    }

    conflictList.innerHTML = '<div class="empty-state"><p>👆 Click on an event to see its conflicts</p></div>';
  }

  getMarkerColor(source) {
    const colors = {
      'ticketmaster': '#026cdf',
      'bandsintown': '#1DB954' // Spotify green (music-focused platform)
    };
    return colors[source] || '#666';
  }

  getMarkerColorByConflicts(eventId) {
    const eventConflicts = this.eventConflictsMap[String(eventId)] || [];
    
    if (eventConflicts.length === 0) {
      // No conflicts - green
      return '#10b981'; // Green
    }
    
    // Check for high severity conflicts
    const highSeverityCount = eventConflicts.filter(c => c.severity === 'high').length;
    const mediumSeverityCount = eventConflicts.filter(c => c.severity === 'medium').length;
    
    // If any high severity conflicts, use red
    if (highSeverityCount > 0) {
      return '#ef4444'; // Red
    }
    
    // If medium severity conflicts or many conflicts, use orange
    if (mediumSeverityCount > 0 || eventConflicts.length >= 3) {
      return '#f59e0b'; // Orange/Amber
    }
    
    // Low severity or few conflicts - yellow
    if (eventConflicts.length >= 2) {
      return '#eab308'; // Yellow
    }
    
    // Single low severity conflict - light orange
    return '#fb923c'; // Light orange
  }

  showLoading() {
    const btn = document.getElementById('search-btn');
    btn.textContent = 'Searching...';
    btn.disabled = true;
  }

  hideLoading() {
    const btn = document.getElementById('search-btn');
    btn.textContent = 'Search Events';
    btn.disabled = false;
  }

  displayError(message) {
    const eventsList = document.getElementById('events-list');
    eventsList.innerHTML = `<div class="empty-state"><p style="color: #dc3545;">${message}</p></div>`;
  }

  async fetchLocationSuggestions(query) {
    // Validate query before making API call
    const trimmedQuery = query.trim();
    if (!trimmedQuery || trimmedQuery.length < 2) {
      this.hideSuggestions();
      this.locationSuggestions = [];
      const suggestionsContainer = document.getElementById('location-suggestions');
      if (suggestionsContainer) {
        suggestionsContainer.innerHTML = '';
      }
      return;
    }
    
    // Normalize the query to handle typos
    const normalizedQuery = this.normalizeLocationInput(trimmedQuery);
    const cacheKey = normalizedQuery.toLowerCase();

    if (this.suggestionCache.has(cacheKey)) {
      this.locationSuggestions = this.suggestionCache.get(cacheKey);
      this.selectedSuggestionIndex = -1;
      this.displaySuggestions();
      return;
    }
    
    // Cancel any previous request
    if (this.currentFetchController) {
      this.currentFetchController.abort();
    }
    
    // Create new AbortController for this request
    this.currentFetchController = new AbortController();
    const signal = this.currentFetchController.signal;
    
    try {
      const data = await this.requestLocationSuggestions(normalizedQuery, signal);
      
      // Check if request was aborted
      if (signal.aborted) {
        return;
      }
      
      // Triple-check the input hasn't changed while fetching
      const locationInput = document.getElementById('location');
      const currentInput = locationInput ? locationInput.value.trim() : '';
      
      // Only proceed if input is still valid and matches our query
      if (!currentInput || currentInput.length < 2 || currentInput !== trimmedQuery) {
        this.hideSuggestions();
        this.locationSuggestions = [];
        const suggestionsContainer = document.getElementById('location-suggestions');
        if (suggestionsContainer) {
          suggestionsContainer.innerHTML = '';
        }
        return;
      }
      
      // Only update if we got valid results
      if (Array.isArray(data) && data.length > 0) {
        this.suggestionCache.set(cacheKey, data);
        this.locationSuggestions = data;
        this.selectedSuggestionIndex = -1;
        this.displaySuggestions();
      } else {
        this.hideSuggestions();
        this.locationSuggestions = [];
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error fetching location suggestions:', error);
      }
      this.hideSuggestions();
      this.locationSuggestions = [];
      const suggestionsContainer = document.getElementById('location-suggestions');
      if (suggestionsContainer) {
        suggestionsContainer.innerHTML = '';
      }
    } finally {
      this.currentFetchController = null;
    }
  }

  displaySuggestions(allowShortInput = false) {
    const suggestionsContainer = document.getElementById('location-suggestions');
    const locationInput = document.getElementById('location');
    const currentInput = locationInput.value.trim();
    
    // Don't show suggestions if input is empty or too short
    if (!currentInput && !allowShortInput) {
      this.hideSuggestions();
      return;
    }

    if (currentInput.length < 2 && !allowShortInput) {
      this.hideSuggestions();
      return;
    }
    
    if (this.locationSuggestions.length === 0) {
      this.hideSuggestions();
      return;
    }

    suggestionsContainer.innerHTML = '';
    
    this.locationSuggestions.forEach((suggestion, index) => {
      const item = document.createElement('div');
      item.className = 'location-suggestion-item';
      item.dataset.index = index;
      
      // Format the display name
      const displayName = suggestion.display_name || suggestion.name || 'Unknown Location';
      const nameParts = displayName.split(',');
      const primaryName = nameParts[0].trim();
      
      // Format address from address object
      let addressParts = [];
      if (suggestion.address) {
        const addr = suggestion.address;
        // Build address in order: street, city/town, state, country
        if (addr.road || addr.street) {
          addressParts.push(addr.road || addr.street);
        }
        if (addr.city || addr.town || addr.village || addr.municipality) {
          addressParts.push(addr.city || addr.town || addr.village || addr.municipality);
        }
        if (addr.state || addr.region) {
          addressParts.push(addr.state || addr.region);
        }
        if (addr.country) {
          addressParts.push(addr.country);
        }
      }
      
      // Fallback to display_name parts if address object is not available
      if (addressParts.length === 0) {
        addressParts = nameParts.slice(1).map(part => part.trim()).filter(part => part.length > 0);
      }
      
      const formattedAddress = addressParts.join(', ');
      
      item.innerHTML = `
        <div class="suggestion-name">${this.escapeHtml(primaryName)}</div>
        ${formattedAddress ? `<div class="suggestion-details">${this.escapeHtml(formattedAddress)}</div>` : ''}
      `;
      
      // Handle click
      item.addEventListener('click', () => {
        this.selectSuggestion(suggestion);
      });
      
      // Handle mouse hover
      item.addEventListener('mouseenter', () => {
        this.selectedSuggestionIndex = index;
        this.updateHighlight();
      });
      
      suggestionsContainer.appendChild(item);
    });
    
    this.showSuggestions();
  }

  showSuggestions() {
    const suggestionsContainer = document.getElementById('location-suggestions');
    suggestionsContainer.classList.add('show');
  }

  hideSuggestions() {
    const suggestionsContainer = document.getElementById('location-suggestions');
    if (suggestionsContainer) {
      suggestionsContainer.classList.remove('show');
      // Clear the HTML content to prevent stale suggestions
      suggestionsContainer.innerHTML = '';
    }
    this.selectedSuggestionIndex = -1;
    // Also clear stored suggestions
    this.locationSuggestions = [];
  }

  navigateSuggestions(direction) {
    if (this.locationSuggestions.length === 0) return;
    
    this.selectedSuggestionIndex += direction;
    
    if (this.selectedSuggestionIndex < 0) {
      this.selectedSuggestionIndex = this.locationSuggestions.length - 1;
    } else if (this.selectedSuggestionIndex >= this.locationSuggestions.length) {
      this.selectedSuggestionIndex = 0;
    }
    
    this.updateHighlight();
    
    // Scroll into view
    const items = document.querySelectorAll('.location-suggestion-item');
    if (items[this.selectedSuggestionIndex]) {
      items[this.selectedSuggestionIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  updateHighlight() {
    const items = document.querySelectorAll('.location-suggestion-item');
    items.forEach((item, index) => {
      if (index === this.selectedSuggestionIndex) {
        item.classList.add('highlighted');
      } else {
        item.classList.remove('highlighted');
      }
    });
  }

  selectSuggestion(suggestion) {
    const locationInput = document.getElementById('location');
    
    // Use the complete display name to show full location
    const displayName = suggestion.display_name || suggestion.name || '';
    
    // Show the complete location string in the input field
    locationInput.value = displayName;
    
    this.hideSuggestions();
    this.locationSuggestions = [];
    
    // Optionally trigger search automatically
    // this.searchEvents();
    
    // Focus back on input
    locationInput.focus();
  }

  async requestLocationSuggestions(query, signal) {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodedQuery}&format=json&limit=${this.defaultSuggestionLimit}&addressdetails=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'EventConflictFinder/1.0'
      },
      signal
    });

    if (!response.ok) {
      throw new Error(`Geocoding API error: ${response.status}`);
    }

    return await response.json();
  }

  async prefetchPopularLocations() {
    const popularQueries = [
      'New York',
      'Los Angeles',
      'London',
      'Toronto',
      'Sydney',
      'Chicago',
      'Paris',
      'Berlin'
    ];

    const aggregated = [];
    await Promise.all(popularQueries.map(async city => {
      const cacheKey = city.toLowerCase();
      if (this.suggestionCache.has(cacheKey)) {
        aggregated.push(...this.suggestionCache.get(cacheKey).slice(0, 1));
        return;
      }

      try {
        const data = await this.requestLocationSuggestions(city);
        if (Array.isArray(data) && data.length > 0) {
          this.suggestionCache.set(cacheKey, data);
          aggregated.push(data[0]);
        }
      } catch (error) {
        console.warn(`Prefetch failed for ${city}:`, error.message);
      }
    }));

    if (aggregated.length > 0) {
      const unique = [];
      const seen = new Set();
      aggregated.forEach(item => {
        const label = item.display_name || item.name;
        if (label && !seen.has(label)) {
          seen.add(label);
          unique.push(item);
        }
      });
      this.popularSuggestionPool = unique.slice(0, this.defaultSuggestionLimit);
    }
  }

  showPrefetchedSuggestions(partial = '') {
    const normalized = (partial || '').toLowerCase();
    let pool = this.popularSuggestionPool || [];

    if (pool.length === 0) {
      this.hideSuggestions();
      this.locationSuggestions = [];
      this.selectedSuggestionIndex = -1;
      return;
    }

    if (normalized.length > 0) {
      pool = pool.filter(item => (item.display_name || item.name || '')
        .toLowerCase()
        .startsWith(normalized));
    }

    this.locationSuggestions = pool.slice(0, this.defaultSuggestionLimit);
    if (this.locationSuggestions.length > 0) {
      this.selectedSuggestionIndex = -1;
      this.displaySuggestions(true);
    } else {
      this.hideSuggestions();
    }
  }

  async handleMapClick(latlng) {
    const lat = latlng.lat;
    const lng = latlng.lng;
    
    try {
      this.showLoading();
      this.selectedEventId = null;
      
      // Optionally reverse geocode to get location name and country
      const locationInfo = await this.reverseGeocode(lat, lng);
      if (locationInfo && locationInfo.locationName) {
        document.getElementById('location').value = locationInfo.locationName;
      }
      
      // Update location coordinates with country info
      this.locationCoords = { 
        lat, 
        lng,
        country: locationInfo?.country || null,
        countryCode: locationInfo?.countryCode || null
      };
      
      // Check if country is supported
      if (!this.isCountrySupported(locationInfo?.country, locationInfo?.countryCode)) {
        this.hideLoading();
        this.displayUnsupportedCountryMessage(locationInfo?.country || 'this location');
        // Clear any existing markers
        this.markers.forEach(marker => this.map.removeLayer(marker));
        this.markers = [];
        this.conflicts = [];
        this.eventConflictsMap = {};
        // Still center map on location for reference
        this.map.setView([lat, lng], 13);
        // Add a marker at clicked location
        this.addClickMarker(lat, lng);
        return;
      }
      
      // Add a marker at clicked location
      this.addClickMarker(lat, lng);
      
      // Get search parameters
      const radius = parseInt(document.getElementById('radius').value) || 25;
      const timeBuffer = parseInt(document.getElementById('timeBuffer').value) || 30;
      
      // Fetch events from API
      const response = await fetch(`/api/events/search?lat=${lat}&lon=${lng}&radius=${radius}`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      this.events = data.events || [];

      // Only center map on clicked location if no events found
      // Otherwise, let displayEvents() handle the map view based on actual event locations
      if (this.events.length === 0) {
        this.map.setView([lat, lng], 13);
      }

      // Update events display (this will handle map zoom/bounds for events)
      this.displayEvents();

      // Detect conflicts
      await this.detectConflicts(timeBuffer);
      
    } catch (error) {
      console.error('Map click search error:', error);
      alert('Error searching events for this location. Please try again.');
      this.displayError('Failed to search events. Please check your connection and try again.');
    } finally {
      this.hideLoading();
    }
  }

  async reverseGeocode(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'EventConflictFinder/1.0'
        }
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      // Return a formatted location name with country info
      const result = {
        locationName: null,
        country: data.address?.country || null,
        countryCode: data.address?.country_code?.toUpperCase() || null,
        address: data.address
      };
      
      if (data.address) {
        const addr = data.address;
        // Try to get city, town, or village name
        result.locationName = addr.city || addr.town || addr.village || addr.county || (data.display_name ? data.display_name.split(',')[0] : null);
      } else {
        result.locationName = data.display_name ? data.display_name.split(',')[0] : null;
      }
      
      return result;
    } catch (error) {
      console.error('Reverse geocoding error:', error);
      return null;
    }
  }

  addClickMarker(lat, lng) {
    // Remove previous click marker if exists
    if (this.clickMarker) {
      this.map.removeLayer(this.clickMarker);
    }
    
    // Add new marker at clicked location with enhanced styling
    this.clickMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'click-marker',
        html: `
          <div style="
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            width: 26px;
            height: 26px;
            border-radius: 50%;
            border: 3px solid white;
            box-shadow: 0 3px 12px rgba(102, 126, 234, 0.6), 0 0 0 2px rgba(118, 75, 162, 0.3);
          "></div>
        `,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -13]
      })
    }).addTo(this.map);
    
    // Add popup with coordinates
    this.clickMarker.bindPopup(`
      <div style="text-align: center;">
        <strong>Search Location</strong><br>
        ${lat.toFixed(4)}, ${lng.toFixed(4)}
      </div>
    `).openPopup();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  updateMarkerColors() {
    // Update existing marker colors based on conflicts without recreating them
    this.markers.forEach(marker => {
      try {
        const event = this.events.find(e => String(e.id) === String(marker.eventId));
        if (!event) return;
        
        const conflictColor = this.getMarkerColorByConflicts(event.id);
        const markerElement = marker.getElement();
        
        if (markerElement) {
          const pinShadow = markerElement.querySelector('.pin-shadow');
          if (pinShadow) {
            pinShadow.style.setProperty('background', conflictColor, 'important');
          }
        }
      } catch (error) {
        console.error('Error updating marker color:', error);
      }
    });
  }

  ensureMarkersVisible() {
    // Ensure marker pane has proper z-index and visibility
    if (this.map) {
      const markerPane = this.map.getPane('markerPane');
      
      if (markerPane) {
        markerPane.style.setProperty('z-index', '650', 'important');
        markerPane.style.setProperty('display', 'block', 'important');
        markerPane.style.setProperty('visibility', 'visible', 'important');
        markerPane.style.setProperty('opacity', '1', 'important');
        markerPane.style.setProperty('pointer-events', 'none', 'important');
      }
    }

    // Force visibility on all markers
    this.markers.forEach(marker => {
      try {
        const element = marker.getElement();
        if (element) {
          // For divIcon markers
          element.style.setProperty('display', 'block', 'important');
          element.style.setProperty('visibility', 'visible', 'important');
          element.style.setProperty('opacity', '1', 'important');
          element.style.setProperty('pointer-events', 'auto', 'important');
          element.style.setProperty('cursor', 'pointer', 'important');
          
          // Ensure inner elements are visible
          const pinContainer = element.querySelector('.pin-container');
          if (pinContainer) {
            pinContainer.style.setProperty('display', 'block', 'important');
            pinContainer.style.setProperty('visibility', 'visible', 'important');
            pinContainer.style.setProperty('opacity', '1', 'important');
          }
          
          // Ensure parent containers are visible (up to 3 levels)
          let parent = element.parentElement;
          let depth = 0;
          while (parent && depth < 3) {
            parent.style.setProperty('display', 'block', 'important');
            parent.style.setProperty('visibility', 'visible', 'important');
            parent.style.setProperty('opacity', '1', 'important');
            parent = parent.parentElement;
            depth++;
          }
        }
      } catch (e) {
        console.error('Error ensuring marker visibility:', e);
      }
    });
  }

  loadPaywallState() {
    let storedLimit = 3;
    try {
      const rawLimit = parseInt(localStorage.getItem('ecf_free_search_limit') || '3', 10);
      storedLimit = isNaN(rawLimit) ? 3 : rawLimit;
    } catch (error) {
      storedLimit = 3;
    }

    const defaults = {
      freeSearchLimit: storedLimit,
      freeSearchCount: 0,
      email: '',
      unlimitedAccess: false
    };

    try {
      const storedCount = parseInt(localStorage.getItem('ecf_free_search_count') || '0', 10);
      const storedEmail = localStorage.getItem('ecf_user_email') || '';
      const unlimited = localStorage.getItem('ecf_unlimited_access') === 'true';
      return {
        ...defaults,
        freeSearchCount: isNaN(storedCount) ? 0 : storedCount,
        email: storedEmail,
        unlimitedAccess: unlimited
      };
    } catch (error) {
      console.warn('Unable to load paywall state:', error);
      return defaults;
    }
  }

  persistPaywallState(updates = {}) {
    this.paywallState = {
      ...this.paywallState,
      ...updates
    };

    this.freeSearchCount = this.paywallState.freeSearchCount;
    this.userEmail = this.paywallState.email;
    this.hasUnlimitedAccess = this.paywallState.unlimitedAccess;

    try {
      localStorage.setItem('ecf_free_search_count', String(this.paywallState.freeSearchCount || 0));
      localStorage.setItem('ecf_user_email', this.paywallState.email || '');
      localStorage.setItem('ecf_unlimited_access', this.paywallState.unlimitedAccess ? 'true' : 'false');
      localStorage.setItem('ecf_free_search_limit', String(this.freeSearchLimit));
    } catch (error) {
      console.warn('Unable to persist paywall state:', error);
    }
  }

  canProceedWithSearch() {
    // If user has unlimited access (stored or verified), always allow
    if (this.hasUnlimitedAccess) {
      return true;
    }

    // Otherwise check free search limit
    return this.freeSearchCount < this.freeSearchLimit;
  }

  incrementFreeSearchCount() {
    if (this.hasUnlimitedAccess) {
      return;
    }

    const newCount = this.freeSearchCount + 1;
    this.persistPaywallState({ freeSearchCount: newCount });

    if (newCount >= this.freeSearchLimit) {
      this.showPaywallModal('limit');
    }
  }

  setupPaywallModal() {
    this.paywallModal = document.getElementById('paywall-modal');
    if (!this.paywallModal) {
      return;
    }

    this.paywallMessageElement = document.getElementById('paywall-message');
    this.paywallModalCopy = document.getElementById('paywall-modal-copy');
    this.globalToastElement = document.getElementById('global-toast');

    const closeBtn = document.getElementById('paywall-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hidePaywallModal());
    }

    const tabSignIn = document.getElementById('paywall-tab-signin');
    const tabSignUp = document.getElementById('paywall-tab-signup');
    if (tabSignIn && tabSignUp) {
      tabSignIn.addEventListener('click', () => this.switchPaywallTab('signin'));
      tabSignUp.addEventListener('click', () => this.switchPaywallTab('signup'));
    }

    const signInForm = document.getElementById('paywall-signin-form');
    if (signInForm) {
      signInForm.addEventListener('submit', (event) => this.handleSignInSubmit(event));
    }

    const signupForm = document.getElementById('paywall-signup-form');
    if (signupForm) {
      signupForm.addEventListener('submit', (event) => this.handleSignupSubmit(event));
    }

    this.switchPaywallTab(this.paywallActiveTab);
  }

  showPaywallModal(reason = 'limit') {
    if (!this.paywallModal) return;

    const message = reason === 'limit'
      ? `You've reached your ${this.freeSearchLimit} free searches.`
      : 'Free searches are locked for this account.';
    if (this.paywallModalCopy) {
      this.paywallModalCopy.textContent = `${message} To continue, sign in with an email that has an active plan or purchase the unlimited plan.`;
    }

    this.switchPaywallTab('signin');
    this.paywallModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    this.setPaywallMessage('');
  }

  hidePaywallModal() {
    if (!this.paywallModal) return;
    this.paywallModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  setPaywallMessage(message, type = 'info') {
    if (!this.paywallMessageElement) return;
    this.paywallMessageElement.textContent = message || '';
    this.paywallMessageElement.setAttribute('data-variant', type);
  }

  switchPaywallTab(tab) {
    this.paywallActiveTab = tab;
    const signinPanel = document.getElementById('paywall-signin-panel');
    const signupPanel = document.getElementById('paywall-signup-panel');
    const tabSignIn = document.getElementById('paywall-tab-signin');
    const tabSignUp = document.getElementById('paywall-tab-signup');

    if (signinPanel && signupPanel && tabSignIn && tabSignUp) {
      if (tab === 'signin') {
        signinPanel.classList.remove('hidden');
        signupPanel.classList.add('hidden');
        tabSignIn.classList.add('active');
        tabSignUp.classList.remove('active');
      } else {
        signinPanel.classList.add('hidden');
        signupPanel.classList.remove('hidden');
        tabSignIn.classList.remove('active');
        tabSignUp.classList.add('active');
      }
    }

    this.setPaywallMessage('');
  }

  async handleSignInSubmit(event) {
    event.preventDefault();
    const emailInput = document.getElementById('paywall-signin-email');
    if (!emailInput) return;

    const email = emailInput.value.trim();
    if (!email) {
      this.setPaywallMessage('Please enter your email address.', 'warning');
      return;
    }

    try {
      this.setPaywallMessage('Checking your plan...', 'info');
      const status = await this.verifyPlanForEmail(email);
      if (status.planStatus === 'active') {
        this.persistPaywallState({
          email,
          unlimitedAccess: true,
          freeSearchCount: 0
        });
        this.showToast('Now you can continue searching. Next time, just enter your email to continue.', 'success');
        this.hidePaywallModal();
        // Refresh the page state to ensure unlimited access is recognized
        this.hasUnlimitedAccess = true;
      } else {
        this.setPaywallMessage('No active plan found for this email. Purchase the unlimited plan to continue.', 'error');
      }
    } catch (error) {
      console.error('Sign-in verification failed:', error);
      this.setPaywallMessage('Unable to verify plan. Please try again.', 'error');
    }
  }

  async handleSignupSubmit(event) {
    event.preventDefault();
    const emailInput = document.getElementById('paywall-signup-email');
    if (!emailInput) return;

    const email = emailInput.value.trim();
    if (!email) {
      this.setPaywallMessage('Please enter your email address.', 'warning');
      return;
    }

    try {
      this.setPaywallMessage('Creating checkout session...', 'info');
      const checkout = await this.startCheckoutForEmail(email);
      if (checkout?.checkoutUrl) {
        this.persistPaywallState({ email });
        window.location.href = checkout.checkoutUrl;
      } else {
        this.setPaywallMessage('Unable to start checkout. Please try again.', 'error');
      }
    } catch (error) {
      console.error('Checkout initiation failed:', error);
      this.setPaywallMessage(error.message || 'Unable to start checkout.', 'error');
    }
  }

  async verifyPlanForEmail(email) {
    const response = await fetch('/api/paywall/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    if (!response.ok) {
      throw new Error('Failed to verify plan');
    }

    const data = await response.json();
    if (data.freeSearchLimit) {
      this.freeSearchLimit = data.freeSearchLimit;
      this.persistPaywallState({ freeSearchCount: data.searchCount || 0 });
    }
    return data;
  }

  async startCheckoutForEmail(email) {
    const response = await fetch('/api/paywall/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Checkout failed');
    }

    return await response.json();
  }

  handleServerPaywallLimit(payload = {}) {
    if (payload.freeSearchLimit) {
      this.freeSearchLimit = payload.freeSearchLimit;
    }
    if (typeof payload.searchCount === 'number') {
      this.persistPaywallState({ freeSearchCount: payload.searchCount });
    }
    this.showPaywallModal('server');
    this.setPaywallMessage('Free searches exhausted. Purchase the unlimited plan to continue.', 'warning');
  }

  syncPlanHeaders(headers) {
    if (!headers?.get) return;
    const plan = headers.get('X-Paywall-Plan');
    if (plan === 'active' && !this.hasUnlimitedAccess) {
      this.persistPaywallState({
        unlimitedAccess: true,
        freeSearchCount: 0
      });
    }
  }

  checkPostCheckoutStatus() {
    try {
      const params = new URLSearchParams(window.location.search);
      const paymentStatus = params.get('payment');

      if (paymentStatus === 'success') {
        const email = params.get('email') || this.userEmail;
        this.persistPaywallState({
          email: email || this.userEmail,
          unlimitedAccess: true,
          freeSearchCount: 0
        });
        this.showToast('Payment received. Now you can continue searching! Next time, just enter your email to continue.', 'success');
        
        // Clean up URL parameters - remove payment-related params
        params.delete('payment');
        params.delete('customer_session_token'); // Remove Polar session token
        if (params.has('email')) {
          params.delete('email');
        }
        
        // Remove any other Polar-related parameters that might be present
        const polarParams = ['session_id', 'checkout_id', 'payment_intent'];
        polarParams.forEach(param => {
          if (params.has(param)) {
            params.delete(param);
          }
        });
        
        const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        window.history.replaceState({}, document.title, newUrl);
      } else {
        // Even if payment status is not 'success', clean up any Polar tokens that might be present
        let cleaned = false;
        
        if (params.has('customer_session_token')) {
          params.delete('customer_session_token');
          cleaned = true;
        }
        
        const polarParams = ['session_id', 'checkout_id', 'payment_intent'];
        polarParams.forEach(param => {
          if (params.has(param)) {
            params.delete(param);
            cleaned = true;
          }
        });
        
        if (cleaned) {
          const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
          window.history.replaceState({}, document.title, newUrl);
        }
      }
    } catch (error) {
      console.warn('Unable to process checkout status:', error);
    }
  }

  async verifyStoredPaymentStatus() {
    // Only verify if we have a stored email and unlimited access flag
    if (!this.userEmail || !this.hasUnlimitedAccess) {
      return;
    }

    try {
      // Silently verify with server that the plan is still active
      const status = await this.verifyPlanForEmail(this.userEmail);
      
      if (status.planStatus === 'active') {
        // Plan is confirmed active, ensure state is correct
        this.persistPaywallState({
          email: this.userEmail,
          unlimitedAccess: true,
          freeSearchCount: 0
        });
      } else {
        // Plan is not active, reset state
        console.warn('Stored payment status invalid, resetting paywall state');
        this.persistPaywallState({
          email: this.userEmail,
          unlimitedAccess: false,
          freeSearchCount: status.searchCount || this.freeSearchCount
        });
      }
    } catch (error) {
      // If verification fails, don't reset state (might be network issue)
      // Keep unlimited access if it was previously verified
      // This prevents blocking users due to temporary network issues
      console.warn('Unable to verify stored payment status (network issue?), keeping current state:', error);
    }
  }

  showToast(message, variant = 'info') {
    if (!this.globalToastElement) return;
    this.globalToastElement.textContent = message;
    this.globalToastElement.setAttribute('data-variant', variant);
    this.globalToastElement.classList.remove('hidden');
    setTimeout(() => {
      this.globalToastElement.classList.add('hidden');
    }, 6000);
  }
}

// Initialize the application when DOM is loaded
let appInstance;

document.addEventListener('DOMContentLoaded', () => {
  // Wait a bit to ensure the map container is fully rendered
  setTimeout(() => {
    appInstance = new EventConflictFinder();
    appInstance.init();
    
    // Handle window resize to invalidate map size
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (appInstance && appInstance.map) {
          appInstance.map.invalidateSize();
        }
      }, 250);
    });
  }, 100);
});

// Global function to select event from map popup button
window.selectEventFromMap = function(eventId) {
  if (appInstance) {
    appInstance.selectEvent(eventId);
  }
};
