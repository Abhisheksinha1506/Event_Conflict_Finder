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
    this.themeStorageKey = 'ecf_theme_preference';
    this.currentTheme = this.loadThemePreference();
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
    this.activeTimeouts = new Set(); // Track all active timeouts for cleanup
    this.markerLayerGroup = null; // LayerGroup for batch marker management
    this.markerIconCache = new Map(); // Cache marker icons by color to avoid recreation
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
    // Ensure free search limit is at least 5
    if (!this.paywallState.freeSearchLimit || this.paywallState.freeSearchLimit < 5) {
      this.paywallState.freeSearchLimit = 5;
      this.persistPaywallState({ freeSearchLimit: 5 });
    }
    this.freeSearchLimit = this.paywallState.freeSearchLimit;
    this.freeSearchCount = this.paywallState.freeSearchCount;
    // Normalize email to lowercase and ensure it's set
    this.userEmail = (this.paywallState.email || '').trim().toLowerCase();
    this.hasUnlimitedAccess = this.paywallState.unlimitedAccess;
    
    // Debug log to help troubleshoot
    if (this.userEmail) {
      console.log('📧 Loaded email from localStorage:', this.userEmail);
      console.log('🔓 Unlimited access:', this.hasUnlimitedAccess);
    }
    this.logoutButton = null;
    this.manageSubscriptionButton = null;
    this.subscriptionModal = null;
    this.paywallModal = null;
    this.paywallMessageElement = null;
    this.searchFilters = {
      startDate: null,
      endDate: null,
      venueRadiusKm: null
    };
    
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

  /**
   * Tracked setTimeout - automatically tracks timeout IDs for cleanup
   * Prevents memory leaks from accumulated timers
   */
  trackedSetTimeout(callback, delay) {
    const timeoutId = setTimeout(() => {
      this.activeTimeouts.delete(timeoutId);
      callback();
    }, delay);
    this.activeTimeouts.add(timeoutId);
    return timeoutId;
  }

  /**
   * Clear all active timeouts to prevent memory leaks
   */
  clearAllTimeouts() {
    this.activeTimeouts.forEach(timeoutId => {
      clearTimeout(timeoutId);
    });
    this.activeTimeouts.clear();
    
    // Also clear specific tracked timeouts
    if (this.suggestionTimeout) {
      clearTimeout(this.suggestionTimeout);
      this.suggestionTimeout = null;
    }
    if (this.zoomUpdateTimeout) {
      clearTimeout(this.zoomUpdateTimeout);
      this.zoomUpdateTimeout = null;
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
    await this.checkPostCheckoutStatus();
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

    // Initialize with light theme
    const themeToApply = this.currentTheme || 'light';
    this.switchMapTheme(themeToApply);

    // Invalidate map size after a short delay to ensure container is rendered
    this.trackedSetTimeout(() => {
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
    this.saveThemePreference(theme);
    
    if (!this.map) {
      return;
    }
    
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
      themeToggleInput.checked = this.currentTheme === 'dark';
      themeToggleInput.setAttribute('data-theme', this.currentTheme);
      if (themeToggleTrack) {
        themeToggleTrack.setAttribute('data-theme', this.currentTheme);
      }

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
      if (this.suggestionTimeout) {
        clearTimeout(this.suggestionTimeout);
      }
      this.suggestionTimeout = this.trackedSetTimeout(() => {
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

    // Handle scroll on mobile to reposition dropdown
    let scrollTimeout;
    const handleScroll = () => {
      const suggestionsContainer = document.getElementById('location-suggestions');
      if (suggestionsContainer && !suggestionsContainer.classList.contains('hidden')) {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
          clearTimeout(scrollTimeout);
          scrollTimeout = setTimeout(() => {
            this.positionSuggestionDropdown();
          }, 50);
        }
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true });
    
    // Handle orientation change on mobile
    window.addEventListener('orientationchange', () => {
      const suggestionsContainer = document.getElementById('location-suggestions');
      if (suggestionsContainer && !suggestionsContainer.classList.contains('hidden')) {
        // Wait for orientation change to complete
        this.trackedSetTimeout(() => {
          this.positionSuggestionDropdown();
        }, 100);
      }
    });
  }

  loadThemePreference() {
    try {
      const storedValue = localStorage.getItem(this.themeStorageKey);
      if (storedValue === 'dark' || storedValue === 'light') {
        return storedValue;
      }
    } catch (error) {
      console.warn('Theme preference unavailable:', error.message);
    }
    return 'light';
  }

  saveThemePreference(theme) {
    try {
      localStorage.setItem(this.themeStorageKey, theme);
    } catch (error) {
      console.warn('Unable to persist theme preference:', error.message);
    }
  }

  getFiltersFromInputs() {
    const startInput = document.getElementById('startDate');
    const endInput = document.getElementById('endDate');
    const venueRadiusInput = document.getElementById('venueRadiusKm');

    const startDate = startInput && startInput.value ? startInput.value : null;
    const endDate = endInput && endInput.value ? endInput.value : null;
    const venueRadiusValue = venueRadiusInput && venueRadiusInput.value
      ? parseFloat(venueRadiusInput.value)
      : 1;

    const normalizedRadius = Number.isFinite(venueRadiusValue) ? venueRadiusValue : 1;
    const isDefaultRadius = Math.abs(normalizedRadius - 1) < 0.001;

    return {
      startDate: startDate || null,
      endDate: endDate || null,
      venueRadiusKm: isDefaultRadius ? null : normalizedRadius
    };
  }

  validateDateRangeFilters(filters) {
    if (filters.startDate && filters.endDate) {
      const start = Date.parse(filters.startDate);
      const end = Date.parse(filters.endDate);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end < start) {
        alert('End date must be on or after the start date');
        return false;
      }
    }
    return true;
  }

  buildEventSearchQuery(lat, lon, radius, filters = {}) {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lon: lon.toString(),
      radius: radius.toString()
    });

    if (filters.startDate) {
      params.append('startDate', filters.startDate);
    }
    if (filters.endDate) {
      params.append('endDate', filters.endDate);
    }
    if (filters.venueRadiusKm !== undefined && filters.venueRadiusKm !== null) {
      params.append('venueRadiusKm', filters.venueRadiusKm.toString());
    }

    return params.toString();
  }

  async searchEvents() {
    const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const location = document.getElementById('location').value.trim();
    const radius = parseInt(document.getElementById('radius').value) || 25;
    const timeBuffer = parseInt(document.getElementById('timeBuffer').value) || 30;
    const filters = this.getFiltersFromInputs();

    if (!location) {
      alert('Please enter a location');
      return;
    }

    if (!this.validateDateRangeFilters(filters)) {
      return;
    }

    this.searchFilters = filters;

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

      // Always send email header if we have it stored
      // This ensures the backend can verify plan status even if localStorage was cleared
      const headers = {};
      const emailToSend = this.userEmail || (this.paywallState?.email || '');
      if (emailToSend && emailToSend.trim()) {
        headers['X-User-Email'] = emailToSend.trim().toLowerCase();
        // Update instance variable if it was missing
        if (!this.userEmail) {
          this.userEmail = emailToSend.trim().toLowerCase();
        }
      }

      // Fetch events from API
      const query = this.buildEventSearchQuery(coords.lat, coords.lng, radius, filters);
      const response = await fetch(`/api/events/search?${query}`, {
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
      await this.detectConflicts(timeBuffer, filters);

      if (!this.hasUnlimitedAccess) {
        this.incrementFreeSearchCount();
      }

      // Store search parameters for zoom/pan comparison
      this.lastSearchRadius = radius;
      this.lastZoomLevel = this.map.getZoom();

      // Reset manual search flag after a short delay to allow map to settle
      this.trackedSetTimeout(() => {
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
        timeBuffer,
        venueRadiusKm: filters.venueRadiusKm
      });
    }
  }

  async geocodeLocation(location) {
    try {
      // Normalize common typos and variations
      const normalizedLocation = this.normalizeLocationInput(location);
      
      // Use Photon API for geocoding (replaces Nominatim, works from India/Vercel)
      const encodedLocation = encodeURIComponent(normalizedLocation);
      // Request more results to find the best match from supported countries
      const url = `https://photon.komoot.io/api/?q=${encodedLocation}&limit=20`;
      
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Geocoding API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data && data.features && data.features.length > 0) {
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

        for (const feature of data.features) {
          const props = feature.properties || {};
          const country = props.country || null;
          const countryCode = props.countrycode?.toUpperCase() || null;
          const isSupported = this.isCountrySupported(country, countryCode);
          
          if (isSupported) {
            supportedResults.push(feature);
          } else {
            unsupportedResults.push(feature);
          }
        }

        // Prefer results from supported countries
        const candidates = supportedResults.length > 0 ? supportedResults : data.features;
        
        // Find the most specific result from candidates
        let bestResult = candidates[0];
        let bestPriority = 99;

        for (const feature of candidates) {
          const props = feature.properties || {};
          // Photon uses 'type' field: 'city', 'town', 'village', etc.
          const placeType = props.type || props.osm_type;
          const priority = placeType ? (priorityOrder[placeType] || 99) : 99;
          
          // Prefer results with lower priority (more specific)
          if (priority < bestPriority) {
            bestResult = feature;
            bestPriority = priority;
          }
        }

        // Extract country information from Photon response
        const props = bestResult.properties || {};
        const country = props.country || null;
        const countryCode = props.countrycode?.toUpperCase() || null;
        
        // Photon returns coordinates as [lon, lat] in GeoJSON format
        const coordinates = bestResult.geometry?.coordinates || [];
        const lng = coordinates[0];
        const lat = coordinates[1];
        
        return {
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          country: country,
          countryCode: countryCode,
          address: {
            country: country,
            country_code: countryCode?.toLowerCase(),
            state: props.state || null,
            city: props.city || props.name || null,
            // Map Photon properties to address format
            ...props
          }
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
    if (this.zoomUpdateTimeout) {
      clearTimeout(this.zoomUpdateTimeout);
    }
    this.zoomUpdateTimeout = this.trackedSetTimeout(async () => {
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

        const filters = this.searchFilters || { startDate: null, endDate: null, venueRadiusKm: 1 };
        const query = this.buildEventSearchQuery(center.lat, center.lng, searchRadius, filters);
        const response = await fetch(`/api/events/search?${query}`, {
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
        await this.detectConflicts(timeBuffer, filters);
        // NOTE: Do NOT increment search count here - this is an auto-update from zoom/pan
        // Only manual searches (button click) should increment the count
        
        // Ensure markers are visible after map view update
        this.trackedSetTimeout(() => {
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
    }, 2000); // 2 second debounce delay - prevents excessive auto-updates from zoom/pan
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

    // Clear existing markers using layerGroup for batch removal (performance optimization)
    if (this.markers.length > 0) {
      // Use layerGroup to batch remove all markers at once
      if (!this.markerLayerGroup) {
        this.markerLayerGroup = L.layerGroup().addTo(this.map);
      } else {
        // Clear all layers from the group at once
        this.markerLayerGroup.clearLayers();
      }
      
      // Clear markers array before removing to avoid redundant operations
      this.markers = [];
    } else if (this.markerLayerGroup) {
      // If no markers but layerGroup exists, clear it
      this.markerLayerGroup.clearLayers();
    }
    this.eventConflictsMap = {}; // Reset conflicts map

    if (this.events.length === 0) {
      eventsList.innerHTML = '<div class="empty-state"><p>No events found for this location.</p></div>';
      return;
    }
    
    console.log(`Displaying ${this.events.length} events on map`);

    // Performance optimization: Use DocumentFragment for batch DOM operations
    const fragment = document.createDocumentFragment();

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
        
        // Performance optimization: Cache marker icons by color to avoid recreation
        let markerIcon = this.markerIconCache.get(markerColor);
        if (!markerIcon) {
          markerIcon = L.divIcon({
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
          this.markerIconCache.set(markerColor, markerIcon);
        }
        
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
        
        // Add marker to layerGroup for batch management (performance optimization)
        if (!this.markerLayerGroup) {
          this.markerLayerGroup = L.layerGroup().addTo(this.map);
        }
        marker.addTo(this.markerLayerGroup);
        
        // Verify marker was added (check layerGroup since marker is added to it, not directly to map)
        if (!this.markerLayerGroup.hasLayer(marker)) {
          console.error(`Failed to add marker for event ${event.id} to layerGroup`);
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
            <strong>Start:</strong> ${this.formatDateInVenueTimezone(startDate, event.venue)}<br>
            <strong>End:</strong> ${this.formatDateInVenueTimezone(endDate, event.venue)}<br>
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
      const eventGenresMarkup = this.renderGenrePills(event.genres);
      
      eventItem.innerHTML = `
        <h4>
          ${this.escapeHtml(event.name)}
          ${conflictBadge}
        </h4>
        <p><strong>Venue:</strong> ${event.venue.name || 'N/A'}</p>
        <p><strong>Time:</strong> ${this.formatDateInVenueTimezone(startDate, event.venue)} - ${this.formatTimeInVenueTimezone(endDate, event.venue)}</p>
        ${eventGenresMarkup ? `<div class="genre-pill-row">${eventGenresMarkup}</div>` : ''}
      `;

      if (event.source === 'ticketmaster' && event.url) {
        // Validate URL before showing button
        let isValidUrl = false;
        try {
          const urlObj = new URL(event.url);
          const hostname = urlObj.hostname.toLowerCase();
          isValidUrl = hostname.includes('ticketmaster') || hostname.includes('tm.com');
        } catch (error) {
          isValidUrl = false;
        }

        if (isValidUrl) {
          const actionsContainer = document.createElement('div');
          actionsContainer.className = 'event-actions';
          const ticketmasterButton = document.createElement('button');
          ticketmasterButton.type = 'button';
          ticketmasterButton.className = 'ticketmaster-button';
          ticketmasterButton.textContent = 'Buy on Ticketmaster';
          ticketmasterButton.addEventListener('click', (buttonEvent) => {
            buttonEvent.stopPropagation();
            try {
              const normalizedUrl = new URL(event.url);
              window.open(normalizedUrl.toString(), '_blank', 'noopener,noreferrer');
            } catch (openError) {
              console.error('Unable to open Ticketmaster link:', openError);
              this.showToast('Unable to open Ticketmaster link. The URL may be invalid.', 'error');
            }
          });
          actionsContainer.appendChild(ticketmasterButton);
          eventItem.appendChild(actionsContainer);
        } else {
          // Show fallback link if URL is invalid
          const actionsContainer = document.createElement('div');
          actionsContainer.className = 'event-actions';
          const fallbackLink = document.createElement('a');
          fallbackLink.href = `https://www.ticketmaster.com/search?q=${encodeURIComponent(event.name)}`;
          fallbackLink.target = '_blank';
          fallbackLink.rel = 'noopener noreferrer';
          fallbackLink.className = 'ticketmaster-button';
          fallbackLink.style.textDecoration = 'none';
          fallbackLink.textContent = 'Search on Ticketmaster';
          actionsContainer.appendChild(fallbackLink);
          eventItem.appendChild(actionsContainer);
        }
      }
      
      // Add click handler
      eventItem.addEventListener('click', () => this.selectEvent(event.id));
      eventItem.style.cursor = 'pointer';
      
      // Append to fragment instead of directly to DOM (performance optimization)
      fragment.appendChild(eventItem);
    });
    
    // Batch append all items at once (single DOM reflow)
    eventsList.appendChild(fragment);

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
            this.trackedSetTimeout(() => {
              fitBoundsWhenReady();
            }, 200);
            return;
          }

          // Fit bounds - the map should be ready by now
          // Use a slightly longer delay to ensure everything is rendered
          this.trackedSetTimeout(() => {
            this.fitMapToMarkers();
          }, 200);
        } catch (error) {
          console.error('Error in map bounds fitting:', error);
        }
      };

      // Initial delay to ensure markers are fully rendered and map is ready
      // Use a longer delay to ensure everything is properly initialized
      this.trackedSetTimeout(() => {
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
      this.trackedSetTimeout(() => {
        this.updateMapViewForSelection(this.selectedEventId, conflictingEventIds);
      }, 100);
    }

    // If an event was previously selected, maintain selection and highlight
    if (this.selectedEventId) {
      // Use setTimeout to ensure markers are fully created
      this.trackedSetTimeout(() => {
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
        this.trackedSetTimeout(() => {
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
            this.trackedSetTimeout(() => {
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
            this.trackedSetTimeout(() => {
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
            this.trackedSetTimeout(() => {
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
    this.trackedSetTimeout(() => {
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
      // Show number of conflicts this specific event is involved in
      conflictCount.textContent = eventConflicts.length;
      // Update subtitle to clarify this is conflicts for this event
      const subtitle = conflictCount.parentElement?.querySelector('.conflict-count-subtitle');
      if (subtitle) {
        subtitle.textContent = `conflict${eventConflicts.length !== 1 ? 's' : ''} for this event`;
      } else if (conflictCount.parentElement) {
        const newSubtitle = document.createElement('div');
        newSubtitle.className = 'conflict-count-subtitle';
        newSubtitle.style.fontSize = '0.75rem';
        newSubtitle.style.color = 'rgba(255, 255, 255, 0.6)';
        newSubtitle.style.marginTop = '4px';
        newSubtitle.textContent = `conflict${eventConflicts.length !== 1 ? 's' : ''} for this event`;
        conflictCount.parentElement.appendChild(newSubtitle);
      }
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
      const competitionBadge = conflict.directCompetition ? '<span class="genre-badge">Direct competition</span>' : '';
      const sharedGenresMarkup = conflict.directCompetition ? this.renderGenrePills(conflict.sharedGenres) : '';
      
      conflictItem.innerHTML = `
        <h4>${conflictTypeLabel} ${competitionBadge}</h4>
        <p style="font-size: 0.8rem; color: #6b7280; margin-bottom: 0.75rem; font-style: italic;">${conflictExplanation}</p>
        <p><strong>Time Slot:</strong> ${conflict.timeSlot}</p>
        <p><strong>Severity:</strong> ${severityBadge}</p>
        ${sharedGenresMarkup ? `<div class="genre-callout"><strong>Shared genres:</strong> ${sharedGenresMarkup}</div>` : ''}
        <p style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #e5e7eb;"><strong>Event Times:</strong></p>
        <ul style="margin-top: 0.5rem;">
          <li style="margin-bottom: 0.5rem;">
            <strong>${this.escapeHtml(conflict.events[0].name)}</strong><br>
            <span style="font-size: 0.8rem; color: #6b7280;">
              ${this.formatDateInVenueTimezone(conflict.events[0].start, conflict.events[0].venue)} - ${this.formatTimeInVenueTimezone(conflict.events[0].end, conflict.events[0].venue)}
              ${isSameVenue ? '' : `<br>Venue: ${this.escapeHtml(conflict.events[0].venue?.name || 'Unknown')}`}
            </span>
          </li>
          <li>
            <strong>${this.escapeHtml(conflict.events[1].name)}</strong><br>
            <span style="font-size: 0.8rem; color: #6b7280;">
              ${this.formatDateInVenueTimezone(conflict.events[1].start, conflict.events[1].venue)} - ${this.formatTimeInVenueTimezone(conflict.events[1].end, conflict.events[1].venue)}
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
      this.trackedSetTimeout(() => {
        this.isSelectionUpdate = false;
      }, 600);
    }
  }

  async detectConflicts(timeBuffer, filterOverrides = {}) {
    const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const fallbackFilters = this.searchFilters || { startDate: null, endDate: null, venueRadiusKm: null };
    const appliedFilters = {
      startDate: filterOverrides.startDate !== undefined ? filterOverrides.startDate : fallbackFilters.startDate,
      endDate: filterOverrides.endDate !== undefined ? filterOverrides.endDate : fallbackFilters.endDate,
      venueRadiusKm: filterOverrides.venueRadiusKm !== undefined ? filterOverrides.venueRadiusKm : fallbackFilters.venueRadiusKm
    };
    const radiusForLogging = appliedFilters.venueRadiusKm ?? 1;

    try {
      const payload = {
        events: this.events,
        timeBuffer: timeBuffer,
        context: {
          lat: this.locationCoords?.lat || null,
          lon: this.locationCoords?.lng || null
        }
      };

      if (appliedFilters.venueRadiusKm !== undefined && appliedFilters.venueRadiusKm !== null) {
        payload.venueRadiusKm = appliedFilters.venueRadiusKm;
      }
      if (appliedFilters.startDate) {
        payload.startDate = appliedFilters.startDate;
      }
      if (appliedFilters.endDate) {
        payload.endDate = appliedFilters.endDate;
      }

      const response = await fetch('/api/conflicts/detect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
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
        this.trackedSetTimeout(() => {
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
        timeBuffer,
        venueRadiusKm: radiusForLogging
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
      // Show total conflict pairs - each conflict involves 2 events
      const uniqueEventsInConflicts = new Set();
      this.conflicts.forEach(conflict => {
        conflict.events.forEach(event => {
          uniqueEventsInConflicts.add(String(event.id));
        });
      });
      conflictCount.textContent = `${this.conflicts.length} pairs`;
      // Add subtitle to clarify
      if (conflictCount.parentElement) {
        const subtitle = conflictCount.parentElement.querySelector('.conflict-count-subtitle');
        if (subtitle) {
          subtitle.textContent = `(${uniqueEventsInConflicts.size} events involved)`;
        } else {
          const newSubtitle = document.createElement('div');
          newSubtitle.className = 'conflict-count-subtitle';
          newSubtitle.style.fontSize = '0.75rem';
          newSubtitle.style.color = 'rgba(255, 255, 255, 0.6)';
          newSubtitle.style.marginTop = '4px';
          newSubtitle.textContent = `(${uniqueEventsInConflicts.size} events involved)`;
          conflictCount.parentElement.appendChild(newSubtitle);
        }
      }
    }

    if (!conflictList) return;

    if (this.conflicts.length === 0) {
      conflictList.innerHTML = '<div class="empty-state"><p>✅ No conflicts detected!</p></div>';
      return;
    }

    conflictList.innerHTML = '<div class="empty-state"><p>👆 Click on an event to see its conflicts</p><p style="font-size: 0.8rem; margin-top: 8px; color: rgba(255,255,255,0.6);">Each conflict pair involves 2 events. Click an event to see all conflicts it\'s involved in.</p></div>';
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

    // Get the ul element inside the dropdown
    let suggestionsList = suggestionsContainer.querySelector('ul');
    if (!suggestionsList) {
      console.warn('Suggestions list (ul) not found in dropdown container, creating it...');
      // Create ul if it doesn't exist
      const newUl = document.createElement('ul');
      newUl.className = 'p-2 text-sm text-body font-medium';
      newUl.setAttribute('aria-labelledby', 'location');
      newUl.setAttribute('role', 'listbox');
      suggestionsContainer.appendChild(newUl);
      suggestionsList = newUl;
    }
    
    suggestionsList.innerHTML = '';
    
    this.locationSuggestions.forEach((suggestion, index) => {
      const listItem = document.createElement('li');
      const item = document.createElement('a');
      item.className = 'location-suggestion-item';
      item.href = '#';
      item.dataset.index = index;
      item.setAttribute('role', 'option');
      
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
      item.addEventListener('click', (e) => {
        e.preventDefault();
        this.selectSuggestion(suggestion);
      });
      
      // Handle mouse hover
      item.addEventListener('mouseenter', () => {
        this.selectedSuggestionIndex = index;
        this.updateHighlight();
      });
      
      listItem.appendChild(item);
      suggestionsList.appendChild(listItem);
    });
    
    this.showSuggestions();
  }

  showSuggestions() {
    const suggestionsContainer = document.getElementById('location-suggestions');
    if (!suggestionsContainer) {
      console.warn('Location suggestions container not found');
      return;
    }
    
    // Remove hidden class first
    suggestionsContainer.classList.remove('hidden');
    
    // Ensure it's visible with !important to override CSS
    suggestionsContainer.style.setProperty('display', 'block', 'important');
    
    // Use double requestAnimationFrame to ensure positioning happens after display is set
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.positionSuggestionDropdown();
      });
    });
  }

  hideSuggestions() {
    const suggestionsContainer = document.getElementById('location-suggestions');
    if (suggestionsContainer) {
      suggestionsContainer.classList.add('hidden');
      suggestionsContainer.style.display = 'none';
      // Clear the HTML content to prevent stale suggestions
      const suggestionsList = suggestionsContainer.querySelector('ul');
      if (suggestionsList) {
        suggestionsList.innerHTML = '';
      }
      // Reset all positioning styles (remove inline styles)
      suggestionsContainer.style.removeProperty('inset');
      suggestionsContainer.style.removeProperty('position');
      suggestionsContainer.style.removeProperty('left');
      suggestionsContainer.style.removeProperty('top');
      suggestionsContainer.style.removeProperty('width');
      suggestionsContainer.style.removeProperty('right');
      suggestionsContainer.style.removeProperty('bottom');
      suggestionsContainer.style.removeProperty('margin-top');
      suggestionsContainer.style.removeProperty('margin-bottom');
      suggestionsContainer.style.removeProperty('transform');
      suggestionsContainer.style.removeProperty('z-index');
      suggestionsContainer.classList.remove('mobile');
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

  getConsoleContainerRect() {
    try {
      const consoleCard = document.querySelector('.console-card');
      if (!consoleCard) {
        return null;
      }
      const rect = consoleCard.getBoundingClientRect();
      const style = window.getComputedStyle(consoleCard);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const usableWidth = Math.max(0, rect.width - paddingLeft - paddingRight);
      return {
        left: rect.left + paddingLeft,
        width: usableWidth
      };
    } catch (error) {
      console.error('Error measuring console card:', error);
      return null;
    }
  }

  positionSuggestionDropdown() {
    const suggestionsContainer = document.getElementById('location-suggestions');
    const locationInput = document.getElementById('location');
    if (!suggestionsContainer || !locationInput) {
      return;
    }
    
    // Don't position if dropdown is hidden
    if (suggestionsContainer.classList.contains('hidden')) {
      return;
    }
    
    // Get the input field container (parent of location-suggestions)
    const inputFieldContainer = locationInput.closest('.input-field--location');
    const inputShell = locationInput.closest('.input-shell');
    
    if (!inputFieldContainer || !inputShell) {
      return;
    }
    
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    
    if (isMobile) {
      const containerRect = inputFieldContainer.getBoundingClientRect();
      const inputRect = locationInput.getBoundingClientRect();
      const inputShellRect = inputShell.getBoundingClientRect();
      
      // Use the input shell width and position for perfect alignment
      const inputShellWidth = inputShellRect.width;
      const inputShellLeft = inputShellRect.left;
      
      const viewportWidth = window.innerWidth;
      const horizontalMargin = 16;
      
      // Ensure dropdown doesn't go off-screen on the sides
      let computedLeft = inputShellLeft;
      let desiredWidth = inputShellWidth;
      
      // Adjust if dropdown would go off the right edge
      if (computedLeft + desiredWidth > viewportWidth - horizontalMargin) {
        desiredWidth = viewportWidth - computedLeft - horizontalMargin;
      }
      
      // Adjust if dropdown would go off the left edge
      if (computedLeft < horizontalMargin) {
        computedLeft = horizontalMargin;
        desiredWidth = Math.min(inputShellWidth, viewportWidth - horizontalMargin * 2);
      }
      
      // Ensure minimum width
      const minWidth = Math.min(280, viewportWidth - horizontalMargin * 2);
      desiredWidth = Math.max(desiredWidth, minWidth);

      // Calculate position directly from the bottom of the input shell (the actual input field)
      // This ensures the dropdown appears directly below the input field
      const inputBottom = inputShellRect.bottom;
      const spacing = 6;
      const topPosition = inputBottom + spacing;
      
      // Always position below the input - never above
      // If there's not enough space, just limit the height
      const viewportHeight = window.innerHeight;
      const dropdownMaxHeight = 280; // max-height from CSS
      const spaceBelow = viewportHeight - topPosition;
      
      // Always use topPosition (below input) - never position above
      let finalTop = topPosition;
      
      // If space is limited, we'll just scroll within the dropdown
      // but always keep it below the input field

      // Use !important via setProperty to override CSS
      // CRITICAL: Remove inset property first (it's a shorthand that overrides top/left/right/bottom)
      // The inset property was causing the dropdown to position incorrectly
      suggestionsContainer.style.removeProperty('inset');
      suggestionsContainer.style.setProperty('inset', 'unset', 'important');
      
      // Now set individual positioning properties - these will work once inset is removed
      suggestionsContainer.style.setProperty('position', 'fixed', 'important');
      suggestionsContainer.style.setProperty('left', `${computedLeft}px`, 'important');
      suggestionsContainer.style.setProperty('top', `${finalTop}px`, 'important');
      suggestionsContainer.style.setProperty('width', `${desiredWidth}px`, 'important');
      suggestionsContainer.style.setProperty('right', 'auto', 'important');
      suggestionsContainer.style.setProperty('bottom', 'auto', 'important');
      suggestionsContainer.style.setProperty('transform', 'none', 'important');
      suggestionsContainer.style.setProperty('margin-top', '0', 'important');
      suggestionsContainer.style.setProperty('margin-bottom', 'auto', 'important');
      suggestionsContainer.style.setProperty('z-index', '20001', 'important');
      suggestionsContainer.classList.add('mobile');
      
      // Force a reflow to ensure styles are applied
      void suggestionsContainer.offsetHeight;
    } else {
      // Desktop: Use absolute positioning relative to input field container
      // Clear any mobile-specific inline styles first
      suggestionsContainer.style.removeProperty('position');
      suggestionsContainer.style.removeProperty('left');
      suggestionsContainer.style.removeProperty('top');
      suggestionsContainer.style.removeProperty('width');
      suggestionsContainer.style.removeProperty('right');
      suggestionsContainer.style.removeProperty('bottom');
      suggestionsContainer.style.removeProperty('margin-top');
      suggestionsContainer.style.removeProperty('margin-bottom');
      suggestionsContainer.style.removeProperty('transform');
      suggestionsContainer.style.removeProperty('z-index');
      
      // Position dropdown directly below the input shell
      suggestionsContainer.style.position = 'absolute';
      suggestionsContainer.style.top = '100%';
      suggestionsContainer.style.left = '0';
      suggestionsContainer.style.right = '0';
      suggestionsContainer.style.width = '100%';
      suggestionsContainer.style.marginTop = '6px';
      suggestionsContainer.style.marginBottom = 'auto';
      suggestionsContainer.style.bottom = 'auto';
      suggestionsContainer.style.transform = 'none';
      suggestionsContainer.style.zIndex = '20000';
      suggestionsContainer.classList.remove('mobile');
    }
  }

  async requestLocationSuggestions(query, signal) {
    const encodedQuery = encodeURIComponent(query);
    // Use Photon API (replaces Nominatim, works from India/Vercel)
    const url = `https://photon.komoot.io/api/?q=${encodedQuery}&limit=${this.defaultSuggestionLimit}`;

    const response = await fetch(url, { signal });

    if (!response.ok) {
      throw new Error(`Geocoding API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Transform Photon GeoJSON format to Nominatim-like format for compatibility
    if (data && data.features) {
      return data.features.map(feature => {
        const props = feature.properties || {};
        const coords = feature.geometry?.coordinates || [];
        
        // Build display name from Photon properties
        const nameParts = [
          props.name,
          props.street,
          props.city,
          props.state,
          props.country
        ].filter(Boolean);
        
        const displayName = nameParts.join(', ');
        
        return {
          display_name: displayName,
          name: props.name || props.city || props.street || displayName,
          lat: coords[1]?.toString(),
          lon: coords[0]?.toString(),
          address: {
            country: props.country,
            country_code: props.countrycode?.toLowerCase(),
            state: props.state,
            city: props.city,
            town: props.city,
            village: props.city,
            street: props.street,
            // Map Photon properties
            ...props
          },
          // Preserve original Photon data for reference
          _photon: feature
        };
      });
    }
    
    return [];
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
        // Continue with other cities even if one fails
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
      const filters = this.getFiltersFromInputs();

      if (!this.validateDateRangeFilters(filters)) {
        this.hideLoading();
        return;
      }

      this.searchFilters = filters;
      
      // Fetch events from API
      const query = this.buildEventSearchQuery(lat, lng, radius, filters);
      const response = await fetch(`/api/events/search?${query}`);
      
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
      await this.detectConflicts(timeBuffer, filters);
      
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
      // Use Photon reverse geocoding API (replaces Nominatim, works from India/Vercel)
      const url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`;
      
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      
      // Photon returns GeoJSON format
      if (data && data.features && data.features.length > 0) {
        const feature = data.features[0];
        const props = feature.properties || {};
        
        // Build display name from Photon properties
        const nameParts = [
          props.name,
          props.street,
          props.city,
          props.state,
          props.country
        ].filter(Boolean);
        
        const displayName = nameParts.join(', ');
        
        // Return a formatted location name with country info
        const result = {
          locationName: props.name || props.city || props.street || displayName.split(',')[0] || null,
          country: props.country || null,
          countryCode: props.countrycode?.toUpperCase() || null,
          address: {
            country: props.country,
            country_code: props.countrycode?.toLowerCase(),
            state: props.state,
            city: props.city,
            town: props.city,
            village: props.city,
            street: props.street,
            // Map Photon properties
            ...props
          },
          display_name: displayName
        };
        
        return result;
      }
      
      return null;
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

  formatDateInVenueTimezone(date, venue) {
    if (!date) return '';
    const dateObj = date instanceof Date ? date : new Date(date);
    if (isNaN(dateObj.getTime())) return date.toString();

    const timezone = venue?.timezone;
    if (!timezone) {
      // Fallback to device timezone
      return dateObj.toLocaleString();
    }

    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });
      return formatter.format(dateObj);
    } catch (error) {
      console.error('Error formatting date in timezone:', error);
      return dateObj.toLocaleString();
    }
  }

  formatTimeInVenueTimezone(date, venue) {
    if (!date) return '';
    const dateObj = date instanceof Date ? date : new Date(date);
    if (isNaN(dateObj.getTime())) return date.toString();

    const timezone = venue?.timezone;
    if (!timezone) {
      return dateObj.toLocaleTimeString();
    }

    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });
      return formatter.format(dateObj);
    } catch (error) {
      console.error('Error formatting time in timezone:', error);
      return dateObj.toLocaleTimeString();
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  formatGenreLabel(tag) {
    if (!tag || typeof tag !== 'string') {
      return '';
    }
    return tag
      .split(' ')
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  renderGenrePills(genres = []) {
    if (!Array.isArray(genres) || genres.length === 0) {
      return '';
    }
    return genres
      .map(genre => `<span class="genre-pill">${this.escapeHtml(this.formatGenreLabel(genre))}</span>`)
      .join('');
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
    let storedLimit = 5;
    try {
      const rawLimit = parseInt(localStorage.getItem('ecf_free_search_limit') || '5', 10);
      storedLimit = isNaN(rawLimit) ? 5 : rawLimit;
    } catch (error) {
      storedLimit = 5;
    }
    // Force minimum limit to 5 and update localStorage if it was less
    if (!Number.isFinite(storedLimit) || storedLimit < 5) {
      storedLimit = 5;
      // Immediately update localStorage with the corrected value
      try {
        localStorage.setItem('ecf_free_search_limit', '5');
      } catch (error) {
        console.warn('Unable to update free search limit in localStorage:', error);
      }
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
    if (updates.freeSearchLimit !== undefined) {
      this.paywallState.freeSearchLimit = updates.freeSearchLimit;
    }
    if (typeof this.paywallState.freeSearchLimit !== 'number' || Number.isNaN(this.paywallState.freeSearchLimit)) {
      this.paywallState.freeSearchLimit = this.freeSearchLimit || 5;
    }

    this.freeSearchLimit = this.paywallState.freeSearchLimit || this.freeSearchLimit || 5;
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

    this.updateLogoutVisibility();
  }

  updateLogoutVisibility() {
    if (!this.logoutButton) return;
    const hasUser = !!(this.userEmail && this.userEmail.trim().length > 0);
    if (hasUser) {
      this.logoutButton.classList.remove('hidden');
      if (this.manageSubscriptionButton) {
        this.manageSubscriptionButton.classList.remove('hidden');
      }
    } else {
      this.logoutButton.classList.add('hidden');
      if (this.manageSubscriptionButton) {
        this.manageSubscriptionButton.classList.add('hidden');
      }
    }
  }

  logout() {
    this.persistPaywallState({
      email: '',
      unlimitedAccess: false,
      freeSearchCount: 0
    });
    try {
      localStorage.removeItem('ecf_free_search_count');
      localStorage.removeItem('ecf_user_email');
      localStorage.removeItem('ecf_unlimited_access');
      localStorage.removeItem('ecf_free_search_limit');
    } catch (error) {
      console.warn('Unable to clear paywall state:', error);
    }
    this.userEmail = '';
    this.hasUnlimitedAccess = false;
    this.freeSearchCount = 0;
    this.showToast('You have been logged out.', 'info');
    this.hidePaywallModal();
    this.hideSubscriptionModal();
  }

  async showSubscriptionManagement() {
    if (!this.subscriptionModal) {
      console.error('Subscription modal not found');
      return;
    }

    this.subscriptionModal.classList.remove('hidden');
    const statusElement = document.getElementById('subscription-status');
    if (!statusElement) return;

    // Show loading state
    statusElement.innerHTML = '<p>Loading subscription status...</p>';

    // Fetch current plan status
    try {
      const response = await fetch('/api/paywall/status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email: this.userEmail })
      });

      if (response.ok) {
        const data = await response.json();
        const planStatus = data.planStatus || 'unknown';
        const searchCount = data.searchCount || 0;
        const freeSearchLimit = data.freeSearchLimit || 5;

        let statusHTML = '';
        if (planStatus === 'active') {
          statusHTML = `
            <div style="padding: 16px; background: rgba(74, 222, 128, 0.1); border-radius: 8px; border: 1px solid rgba(74, 222, 128, 0.3);">
              <p style="margin: 0; font-weight: 600; color: #4ade80;">✓ Active Subscription</p>
              <p style="margin: 8px 0 0 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.8);">Email: ${this.escapeHtml(this.userEmail)}</p>
              <p style="margin: 8px 0 0 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.8);">You have unlimited searches.</p>
            </div>
          `;
        } else {
          statusHTML = `
            <div style="padding: 16px; background: rgba(251, 191, 36, 0.1); border-radius: 8px; border: 1px solid rgba(251, 191, 36, 0.3);">
              <p style="margin: 0; font-weight: 600; color: #fbbf24;">Free Plan</p>
              <p style="margin: 8px 0 0 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.8);">Email: ${this.escapeHtml(this.userEmail)}</p>
              <p style="margin: 8px 0 0 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.8);">Searches used: ${searchCount} / ${freeSearchLimit}</p>
            </div>
          `;
        }
        statusElement.innerHTML = statusHTML;
      } else {
        statusElement.innerHTML = `
          <div style="padding: 16px; background: rgba(248, 113, 113, 0.1); border-radius: 8px; border: 1px solid rgba(248, 113, 113, 0.3);">
            <p style="margin: 0; color: #f87171;">Unable to load subscription status</p>
            <p style="margin: 8px 0 0 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.8);">Email: ${this.escapeHtml(this.userEmail || 'Not set')}</p>
          </div>
        `;
      }
    } catch (error) {
      console.error('Error fetching subscription status:', error);
      statusElement.innerHTML = `
        <div style="padding: 16px; background: rgba(248, 113, 113, 0.1); border-radius: 8px; border: 1px solid rgba(248, 113, 113, 0.3);">
          <p style="margin: 0; color: #f87171;">Error loading subscription status</p>
          <p style="margin: 8px 0 0 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.8);">Please try again later.</p>
        </div>
      `;
    }
  }

  hideSubscriptionModal() {
    if (this.subscriptionModal) {
      this.subscriptionModal.classList.add('hidden');
    }
  }

  canProceedWithSearch() {
    // If user has unlimited access (stored or verified), always allow
    if (this.hasUnlimitedAccess) {
      return true;
    }

    // Always allow search attempts - let the server be the source of truth
    // The server will return 402 if the limit is reached, and we'll handle it then
    // This prevents showing paywall on page load based on potentially stale localStorage data
    // The server tracks searches accurately with proper time windows and per-user/IP tracking
    return true;
  }

  incrementFreeSearchCount() {
    if (this.hasUnlimitedAccess) {
      return;
    }

    const effectiveLimit = this.freeSearchLimit || 5;
    this.freeSearchLimit = effectiveLimit;
    const newCount = this.freeSearchCount + 1;
    this.persistPaywallState({ freeSearchCount: newCount });

    if (newCount >= effectiveLimit) {
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

    const signInForm = document.getElementById('paywall-signin-form');
    if (signInForm) {
      signInForm.addEventListener('submit', (event) => this.handleSignInSubmit(event));
    }

    const checkoutBtn = document.getElementById('paywall-checkout-btn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', () => this.startCheckout());
    }

    this.logoutButton = document.getElementById('logout-button');
    if (this.logoutButton) {
      this.logoutButton.addEventListener('click', () => this.logout());
      this.updateLogoutVisibility();
    }

    this.manageSubscriptionButton = document.getElementById('manage-subscription-button');
    if (this.manageSubscriptionButton) {
      this.manageSubscriptionButton.addEventListener('click', () => this.showSubscriptionManagement());
    }

    this.subscriptionModal = document.getElementById('subscription-modal');
    const subscriptionCloseBtn = document.getElementById('subscription-modal-close');
    if (subscriptionCloseBtn) {
      subscriptionCloseBtn.addEventListener('click', () => this.hideSubscriptionModal());
    }
    if (this.subscriptionModal) {
      this.subscriptionModal.addEventListener('click', (e) => {
        if (e.target === this.subscriptionModal) {
          this.hideSubscriptionModal();
        }
      });
    }
  }

  showPaywallModal(reason = 'limit', options = {}) {
    if (!this.paywallModal) return;

    const copyMap = {
      limit: `You've reached your ${this.freeSearchLimit} free searches. To continue, sign in with an email that has an active plan or purchase the unlimited plan.`,
      server: 'Free searches are locked for this account. Sign in with an active plan or purchase unlimited access to continue.',
      'payment-success': 'Payment confirmed! Use the email form below to sync unlimited access on this device or close this panel to keep searching.',
      'payment-failed': 'Your payment did not complete. You can try again with a different email or restart checkout below.',
      'payment-cancelled': 'Your checkout was cancelled. You can re-enter your email or restart checkout at any time.',
      default: 'Sign in with an email that has an active plan or purchase unlimited access to continue.'
    };

    const modalCopy = options.copy || copyMap[reason] || copyMap.default;
    if (this.paywallModalCopy) {
      this.paywallModalCopy.textContent = modalCopy;
    }

    this.paywallModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    const emailInput = document.getElementById('paywall-signin-email');
    if (options.prefillEmail && emailInput) {
      emailInput.value = options.prefillEmail;
    }

    if (options.focusEmail && emailInput) {
      setTimeout(() => emailInput.focus(), 0);
    }

    if (options.message) {
      this.setPaywallMessage(options.message, options.variant || 'info');
    } else {
      this.setPaywallMessage('');
    }
  }

  hidePaywallModal() {
    if (!this.paywallModal) return;
    this.paywallModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  setPaywallMessage(message, type = 'info') {
    if (!this.paywallMessageElement) return;
    if (message && message.trim()) {
      this.paywallMessageElement.textContent = message;
      this.paywallMessageElement.setAttribute('data-variant', type);
      this.paywallMessageElement.style.display = 'block';
    } else {
      this.paywallMessageElement.textContent = '';
      this.paywallMessageElement.style.display = 'none';
    }
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
        
        // Explicitly ensure logout button is visible and user is signed in
        this.updateLogoutVisibility();
        
        this.showToast('You are now signed in with unlimited searches!', 'success');
        this.hidePaywallModal();
        // Refresh the page state to ensure unlimited access is recognized
        this.hasUnlimitedAccess = true;
      } else if (status.planStatus === 'pending') {
        // Payment is pending - server should have checked Polar API automatically
        // If still pending, payment might still be processing
        this.setPaywallMessage('Payment is still being processed. Please wait a moment and try again, or contact support if this persists.', 'warning');
      } else {
        this.setPaywallMessage('No active plan found for this email. Purchase the unlimited plan to continue.', 'error');
      }
    } catch (error) {
      console.error('Sign-in verification failed:', error);
      this.setPaywallMessage('Unable to verify plan. Please try again.', 'error');
    }
  }

  async verifyPlanForEmail(email) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      throw new Error('Email is required');
    }

    const response = await fetch('/api/paywall/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: normalizedEmail })
    });

    if (!response.ok) {
      throw new Error('Failed to verify plan');
    }

    const data = await response.json();
    if (data.freeSearchLimit) {
      this.freeSearchLimit = data.freeSearchLimit;
      const updates = { 
        freeSearchCount: data.searchCount || 0,
        email: normalizedEmail // Always update email when verifying
      };
      if (data.planStatus === 'active') {
        updates.unlimitedAccess = true;
        updates.freeSearchCount = 0; // Reset count for active users
      } else {
        updates.unlimitedAccess = false;
      }
      this.persistPaywallState(updates);
    }
    return data;
  }

  async startCheckout() {
    try {
      const emailInput = document.getElementById('paywall-signin-email');
      const checkoutEmail = (emailInput?.value || this.userEmail || '').trim().toLowerCase();
      const payload = checkoutEmail ? { email: checkoutEmail } : {};

      if (checkoutEmail) {
        this.persistPaywallState({ email: checkoutEmail });
      }

      this.setPaywallMessage('Redirecting to secure checkout...', 'info');
      const response = await fetch('/api/paywall/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Checkout failed');
      }

      const checkout = await response.json();
      if (checkout?.checkoutUrl) {
        window.location.href = checkout.checkoutUrl;
      } else {
        throw new Error('Checkout link missing. Please try again.');
      }
    } catch (error) {
      console.error('Checkout initiation failed:', error);
      this.setPaywallMessage(error.message || 'Unable to start checkout.', 'error');
    }
  }

  handleServerPaywallLimit(payload = {}) {
    const updates = {};
    if (payload.freeSearchLimit) {
      updates.freeSearchLimit = payload.freeSearchLimit;
    }
    if (typeof payload.searchCount === 'number') {
      updates.freeSearchCount = payload.searchCount;
    }
    if (Object.keys(updates).length > 0) {
      this.persistPaywallState(updates);
    }
    this.showPaywallModal('server');
    this.setPaywallMessage('Free searches exhausted. Purchase the unlimited plan to continue.', 'warning');
  }

  syncPlanHeaders(headers) {
    if (!headers?.get) return;
    const limitHeader = headers.get('X-Free-Search-Limit');
    if (limitHeader) {
      const parsedLimit = parseInt(limitHeader, 10);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        this.persistPaywallState({ freeSearchLimit: parsedLimit });
      }
    }
    const plan = headers.get('X-Paywall-Plan');
    if (plan === 'active') {
      // If server confirms active status, ensure localStorage is updated
      // Preserve email if it exists, or use the one from the request
      const updates = {
        unlimitedAccess: true,
        freeSearchCount: 0
      };
      // Preserve email if we have it, otherwise keep current state
      if (this.userEmail) {
        updates.email = this.userEmail;
      }
      this.persistPaywallState(updates);
    }
  }

  async checkPostCheckoutStatus() {
    try {
      const params = new URLSearchParams(window.location.search);
      const paymentStatus = params.get('payment');
      const emailParam = params.get('email');
      const checkoutId = params.get('checkout_id') || params.get('id') || params.get('session_id');
      
      // Try to get email from multiple sources
      let email = (emailParam || this.userEmail || '').trim();
      
      // If no email but we have checkout ID, try to verify checkout to get email
      if (!email && checkoutId && paymentStatus === 'success') {
        try {
          const response = await fetch('/api/paywall/verify-checkout', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ checkoutId })
          });
          
          if (response.ok) {
            const result = await response.json();
            if (result.email) {
              email = result.email.trim().toLowerCase();
            }
          }
        } catch (error) {
          console.warn('Could not verify checkout to get email:', error);
        }
      }
      
      // Fallback: try to get email from localStorage if still missing
      if (!email) {
        try {
          const storedEmail = localStorage.getItem('ecf_user_email');
          if (storedEmail) {
            email = storedEmail.trim().toLowerCase();
          }
        } catch (error) {
          console.warn('Could not read email from localStorage:', error);
        }
      }

      const cleanupUrlParams = () => {
        params.delete('payment');
        params.delete('customer_session_token');
        if (params.has('email')) {
          params.delete('email');
        }

        const polarParams = ['session_id', 'checkout_id', 'payment_intent', 'id'];
        polarParams.forEach(param => {
          if (params.has(param)) {
            params.delete(param);
          }
        });

        const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        window.history.replaceState({}, document.title, newUrl);
      };

      if (paymentStatus === 'success' || paymentStatus === 'cancelled' || paymentStatus === 'failed') {
        // Verify payment status with server (will auto-check Polar API if pending)
        if (!email) {
          const modalReason = paymentStatus === 'failed'
            ? 'payment-failed'
            : paymentStatus === 'cancelled'
              ? 'payment-cancelled'
              : 'payment-success';
          const variant = paymentStatus === 'failed'
            ? 'error'
            : paymentStatus === 'cancelled'
              ? 'info'
              : 'success';
          const modalMessage = paymentStatus === 'failed'
            ? 'Payment failed. Enter your email below to try again or restart checkout.'
            : paymentStatus === 'cancelled'
              ? 'Payment was cancelled. Enter your email to continue or start a new checkout.'
              : 'Payment completed. Enter your email below to unlock unlimited searches on this device.';

          this.showPaywallModal(modalReason, {
            message: modalMessage,
            variant,
            focusEmail: true
          });
          this.showToast(modalMessage, variant);
          cleanupUrlParams();
          return;
        } else {
          try {
            const status = await this.verifyPlanForEmail(email);
          
          if (status.planStatus === 'active') {
            // Payment confirmed - update state and ensure user is signed in
            this.persistPaywallState({
              email,
              unlimitedAccess: true,
              freeSearchCount: 0
            });
            
            // Explicitly ensure logout button is visible and user is signed in
            this.updateLogoutVisibility();
            
            this.showPaywallModal('payment-success', {
              message: 'Payment confirmed! You now have unlimited searches on this device.',
              variant: 'success',
              prefillEmail: email,
              focusEmail: false
            });
            this.showToast('Payment confirmed! You are now signed in with unlimited searches.', 'success');
            cleanupUrlParams();
            return;
          } else if (status.planStatus === 'pending') {
            // Payment is still processing - poll for status update
            this.persistPaywallState({
              email,
              unlimitedAccess: false,
              freeSearchCount: status.searchCount || 0
            });
            this.updateLogoutVisibility();
            this.showToast('Payment is being processed. Checking status...', 'info');
            
            // Poll for payment status (check every 3 seconds, max 10 times)
            this.pollPaymentStatus(email || this.userEmail, 10);
            cleanupUrlParams();
            return;
          } else {
            // Payment failed or not confirmed
            this.persistPaywallState({
              email: email || this.userEmail,
              unlimitedAccess: false,
              freeSearchCount: status.searchCount || 0
            });
            this.updateLogoutVisibility();
            
            if (paymentStatus === 'cancelled') {
              this.showPaywallModal('payment-cancelled', {
                message: 'Payment was cancelled. You can re-enter your email or restart checkout below.',
                variant: 'info',
                prefillEmail: email,
                focusEmail: true
              });
              this.showToast('Payment was cancelled. Your search count remains unchanged. You can try again anytime.', 'info');
            } else if (paymentStatus === 'failed') {
              this.showPaywallModal('payment-failed', {
                message: 'Payment failed. Your search count has not been reset. Try again or contact support.',
                variant: 'error',
                prefillEmail: email,
                focusEmail: true
              });
              this.showToast('Payment failed. Your search count has not been reset. Please try again or contact support.', 'error');
            } else {
              this.showToast('Payment verification in progress. Please wait...', 'info');
              // Poll for status update
              this.pollPaymentStatus(email, 10);
            }
          }
          } catch (error) {
            console.error('Error verifying payment status:', error);
            
            if (paymentStatus === 'success') {
              // If we got success redirect but verification failed, still refresh to let server handle it
              this.showToast('Verifying payment... Refreshing page...', 'info');
              cleanupUrlParams();
              setTimeout(() => {
                window.location.href = window.location.pathname;
              }, 1500);
              return;
            }
          }
        }
      }
      
      cleanupUrlParams();
    } catch (error) {
      console.warn('Unable to process checkout status:', error);
    }
  }

  async pollPaymentStatus(email, maxAttempts = 10) {
    let attempts = 0;
    
    const poll = async () => {
      if (attempts >= maxAttempts) {
        this.showToast('Payment verification is taking longer than expected. Please refresh the page manually.', 'info');
        return;
      }
      
      attempts++;
      
      try {
        const status = await this.verifyPlanForEmail(email);
        
        if (status.planStatus === 'active') {
          // Payment confirmed - update state and ensure user is signed in
          this.persistPaywallState({
            email: email,
            unlimitedAccess: true,
            freeSearchCount: 0
          });
          
          // Explicitly ensure logout button is visible and user is signed in
          this.updateLogoutVisibility();
          
          // Hide paywall modal if open
          this.hidePaywallModal();
          
          this.showToast('Payment confirmed! You are now signed in with unlimited searches.', 'success');
          
          // Don't refresh page - user is already signed in
          return;
        } else if (status.planStatus === 'pending') {
          // Still pending (legacy records only) - continue polling
          setTimeout(poll, 3000); // Check every 3 seconds
        } else {
          // Payment failed or not confirmed - preserve search count
          this.persistPaywallState({
            email: email,
            unlimitedAccess: false,
            freeSearchCount: status.searchCount || 0 // Preserve current count, don't reset
          });
          this.showToast('Payment failed. Your search count has not been reset. Please try again.', 'error');
        }
      } catch (error) {
        console.error('Error polling payment status:', error);
        // Continue polling on error (might be temporary network issue)
        setTimeout(poll, 3000);
      }
    };
    
    // Start polling after initial delay
    setTimeout(poll, 3000);
  }

  async verifyStoredPaymentStatus() {
    // Verify if we have a stored email
    const storedEmail = this.userEmail || this.paywallState?.email || '';
    if (!storedEmail || !storedEmail.trim()) {
      return;
    }

    try {
      // Verify with server - this will auto-check pending payments and update status
      const status = await this.verifyPlanForEmail(storedEmail);
      
      // verifyPlanForEmail already updates localStorage, but ensure consistency
      if (status.planStatus === 'active') {
        // Plan is confirmed active, ensure state is correct
        this.persistPaywallState({
          email: storedEmail.trim().toLowerCase(),
          unlimitedAccess: true,
          freeSearchCount: 0
        });
        console.log('✅ Verified active plan for:', storedEmail);
      } else if (status.planStatus === 'pending') {
        // Status is still pending - server will check Polar API automatically
        // Keep current state but don't grant unlimited access yet
        console.log('⏳ Payment status is pending, waiting for confirmation...');
        this.persistPaywallState({
          email: storedEmail.trim().toLowerCase(),
          unlimitedAccess: false,
          freeSearchCount: status.searchCount || this.freeSearchCount
        });
      } else {
        // Plan is not active, reset state but keep email
        console.warn('⚠️ Stored payment status invalid, resetting paywall state');
        this.persistPaywallState({
          email: storedEmail.trim().toLowerCase(),
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
    this.trackedSetTimeout(() => {
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
        const suggestions = document.getElementById('location-suggestions');
        if (suggestions && !suggestions.classList.contains('hidden') && appInstance) {
          appInstance.positionSuggestionDropdown();
        }
      }, 250);
    });
    
    // Cleanup on page unload to prevent memory leaks
    window.addEventListener('beforeunload', () => {
      if (appInstance) {
        appInstance.clearAllTimeouts();
        // Clean up map resources
        if (appInstance.map) {
          appInstance.map.remove();
          appInstance.map = null;
        }
        // Clear marker references
        if (appInstance.markerLayerGroup) {
          appInstance.markerLayerGroup.clearLayers();
          appInstance.markerLayerGroup = null;
        }
        appInstance.markers = [];
        appInstance.markerIconCache.clear();
      }
    });
  }, 100);
});

// Global function to select event from map popup button
window.selectEventFromMap = function(eventId) {
  if (appInstance) {
    appInstance.selectEvent(eventId);
  }
};
