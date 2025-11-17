class ConflictDetector {
  /**
   * Calculate dynamic proximity threshold based on venue density and context
   */
  static calculateDynamicThreshold(events, baseThreshold = 0.3) {
    if (!events || events.length < 2) {
      return baseThreshold;
    }

    // Calculate venue density (average distance between nearby venues)
    const distances = [];
    // Sample more events for better density calculation, but cap at 200 for performance
    const sampleSize = Math.min(200, events.length);
    
    for (let i = 0; i < sampleSize; i++) {
      const event1 = events[i];
      if (!event1.venue || !event1.venue.lat || !event1.venue.lon) continue;
      
      for (let j = i + 1; j < sampleSize; j++) {
        const event2 = events[j];
        if (!event2.venue || !event2.venue.lat || !event2.venue.lon) continue;
        
        const distance = this.calculateVenueDistance(event1.venue, event2.venue);
        if (distance < 1.0) { // Only consider venues within 1km
          distances.push(distance);
        }
      }
    }

    if (distances.length === 0) {
      return baseThreshold;
    }

    // Calculate median distance
    distances.sort((a, b) => a - b);
    const medianDistance = distances[Math.floor(distances.length / 2)];

    // Adjust threshold based on density:
    // - Dense areas (median < 0.2km): Use tighter threshold (0.15km)
    // - Medium density (0.2-0.5km): Use moderate threshold (0.2km)
    // - Sparse areas (>0.5km): Use base threshold (0.3km)
    if (medianDistance < 0.2) {
      return 0.15; // Very dense (e.g., Broadway district)
    } else if (medianDistance < 0.5) {
      return 0.2; // Medium density
    } else {
      return baseThreshold; // Sparse area
    }
  }

  /**
   * Calculate venue name similarity to reduce false positives
   */
  static calculateVenueNameSimilarity(venue1, venue2) {
    if (!venue1 || !venue2 || !venue1.name || !venue2.name) {
      return 0;
    }

    const name1 = venue1.name.toLowerCase().trim();
    const name2 = venue2.name.toLowerCase().trim();

    if (name1 === name2) return 1;

    // Normalize venue names (remove common suffixes)
    const normalizeVenueName = (name) => {
      return name
        .replace(/\s*-\s*(ny|new york|nyc|theater|theatre|hall|center|centre)\s*$/i, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim();
    };

    const norm1 = normalizeVenueName(name1);
    const norm2 = normalizeVenueName(name2);

    if (norm1 === norm2) return 1;

    return this.calculateNameSimilarity(norm1, norm2);
  }

  static findConflicts(events, timeBuffer = 30, venueProximityThreshold = null, skipDuplicateFilter = false) {
    // First, filter out duplicate events (unless already filtered)
    const uniqueEvents = skipDuplicateFilter ? events : this.filterDuplicates(events);
    
    // Calculate dynamic threshold if not provided
    const dynamicThreshold = venueProximityThreshold !== null 
      ? venueProximityThreshold 
      : this.calculateDynamicThreshold(uniqueEvents);
    
    const conflicts = [];
    const processedPairs = new Set();

    // Convert timeBuffer from minutes to milliseconds
    const bufferMs = timeBuffer * 60 * 1000;

    // Check each pair of events for conflicts
    for (let i = 0; i < uniqueEvents.length; i++) {
      const event1 = uniqueEvents[i];
      
      // Skip events without required data
      if (!event1.start || !event1.end || !event1.venue || !event1.venue.lat || !event1.venue.lon) {
        continue;
      }

      for (let j = i + 1; j < uniqueEvents.length; j++) {
        const event2 = uniqueEvents[j];
        
        // Skip events without required data
        if (!event2.start || !event2.end || !event2.venue || !event2.venue.lat || !event2.venue.lon) {
          continue;
        }

        // Skip if same event (shouldn't happen with i < j, but safety check)
        if (event1.id === event2.id) {
          continue;
        }

        // Create a unique key for this pair to avoid duplicates
        const pairKey = [event1.id, event2.id].sort().join('_');
        if (processedPairs.has(pairKey)) {
          continue;
        }

        // Check for time overlap with buffer
        const timeOverlap = this.checkTimeOverlap(event1, event2, bufferMs);
        
        // Calculate venue distance
        const venueDistance = this.calculateVenueDistance(event1.venue, event2.venue);
        
        // Check for venue proximity with dynamic threshold
        const venueProximity = venueDistance < dynamicThreshold;

        // Additional check: If venues are close but have very different names,
        // require closer proximity to reduce false positives
        const venueNameSimilarity = this.calculateVenueNameSimilarity(event1.venue, event2.venue);
        
        // If venue names are very different (< 30% similar), require closer proximity
        // This prevents false positives like "Actor's Temple Theater" vs "Richard Rodgers Theatre"
        let effectiveThreshold = dynamicThreshold;
        if (venueNameSimilarity < 0.3 && venueDistance > 0.1) {
          // For very different venue names, require much closer proximity (0.1km = 100m)
          effectiveThreshold = 0.1;
        }

        const meetsProximityRequirement = venueDistance < effectiveThreshold;

        if (timeOverlap && meetsProximityRequirement) {
          const conflictType = this.determineConflictType(event1, event2);
          
          conflicts.push({
            events: [event1, event2],
            conflictType: conflictType,
            timeSlot: this.getTimeSlotString(event1, event2),
            severity: this.calculateSeverity(event1, event2, bufferMs)
          });

          processedPairs.add(pairKey);
        }
      }
    }

    return conflicts;
  }

  /**
   * Filter duplicate events from the array
   * Duplicates are identified by:
   * 1. Same event ID
   * 2. Same name, venue, and overlapping time (within 5 minutes)
   * 3. Same venue, same time, and very similar names (fuzzy match)
   */
  static filterDuplicates(events) {
    const uniqueEvents = [];
    const seenIds = new Set();
    const seenEventSignatures = new Set();

    for (const event of events) {
      // Skip events without required data
      if (!event.start || !event.end || !event.venue || !event.venue.lat || !event.venue.lon) {
        continue;
      }

      // Check 1: Same event ID (exact duplicate)
      if (seenIds.has(event.id)) {
        continue;
      }

      // Create a signature for fuzzy duplicate detection
      const eventSignature = this.createEventSignature(event);
      
      // Check 2 & 3: Check if we've seen a similar event
      let isDuplicate = false;
      for (const signature of seenEventSignatures) {
        if (this.isDuplicateEvent(event, signature)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        uniqueEvents.push(event);
        seenIds.add(event.id);
        seenEventSignatures.add(eventSignature);
      }
    }

    return uniqueEvents;
  }

  /**
   * Create a signature for an event to help detect duplicates
   */
  static createEventSignature(event) {
    const name = (event.name || '').toLowerCase().trim();
    const normalizedName = this.normalizeEventName(event.name);
    const venueName = (event.venue?.name || '').toLowerCase().trim();
    const venueLat = parseFloat(event.venue?.lat);
    const venueLon = parseFloat(event.venue?.lon);
    const startTime = new Date(event.start).getTime();
    
    return {
      name,
      normalizedName,
      venueName,
      venueLat,
      venueLon,
      startTime
    };
  }

  /**
   * Normalize event name by removing common suffixes and variations
   */
  static normalizeEventName(name) {
    if (!name) return '';
    
    let normalized = name.toLowerCase().trim();
    
    // Remove common location suffixes in parentheses: (NY), (New York), etc.
    normalized = normalized.replace(/\s*\([^)]*\)\s*$/, '');
    
    // Remove common location suffixes: - NY, - New York, etc.
    normalized = normalized.replace(/\s*-\s*(ny|new york|nyc|manhattan|brooklyn|queens|bronx)\s*$/i, '');
    
    // Remove extra whitespace
    normalized = normalized.trim();
    
    return normalized;
  }

  /**
   * Check if two events are duplicates based on multiple criteria
   */
  static isDuplicateEvent(event, signature) {
    const eventName = (event.name || '').toLowerCase().trim();
    const normalizedEventName = this.normalizeEventName(event.name);
    const normalizedSignatureName = this.normalizeEventName(signature.name);
    
    const eventVenueName = (event.venue?.name || '').toLowerCase().trim();
    const eventVenueLat = parseFloat(event.venue?.lat);
    const eventVenueLon = parseFloat(event.venue?.lon);
    const eventStartTime = new Date(event.start).getTime();

    // Check 1: Exact match on name, venue name, and time (within 5 minutes)
    const timeDifference = Math.abs(eventStartTime - signature.startTime);
    const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

    if (eventName === signature.name && 
        eventVenueName === signature.venueName && 
        timeDifference <= fiveMinutes) {
      return true;
    }

    // Check 1.5: Normalized name match (catches "Hamilton" vs "Hamilton (NY)")
    if (normalizedEventName === normalizedSignatureName && 
        normalizedEventName.length > 0 &&
        eventVenueName === signature.venueName && 
        timeDifference <= fiveMinutes) {
      return true;
    }

    // Check 2: Same venue (very close proximity < 0.05km = 50m) and same time
    const venueDistance = this.calculateVenueDistance(
      { lat: eventVenueLat, lon: eventVenueLon },
      { lat: signature.venueLat, lon: signature.venueLon }
    );

    if (venueDistance < 0.05 && timeDifference <= fiveMinutes) {
      // Check if names are similar (fuzzy match) - use normalized names
      const nameSimilarity = this.calculateNameSimilarity(normalizedEventName, normalizedSignatureName);
      if (nameSimilarity > 0.85) { // 85% similarity threshold
        return true;
      }
    }

    // Check 3: Same venue, overlapping time, and very similar names
    if (venueDistance < 0.1) { // Within 100m
      const start1 = eventStartTime;
      const end1 = new Date(event.end).getTime();
      const start2 = signature.startTime;
      // Estimate end time (assume 2 hours if not available)
      const end2 = signature.startTime + (2 * 60 * 60 * 1000);

      // Check time overlap
      if ((start1 <= end2) && (end1 >= start2)) {
        // Use normalized names for better matching
        const nameSimilarity = this.calculateNameSimilarity(normalizedEventName, normalizedSignatureName);
        if (nameSimilarity > 0.8) { // 80% similarity for overlapping events
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Calculate similarity between two strings using Levenshtein distance
   * Returns a value between 0 and 1 (1 = identical, 0 = completely different)
   */
  static calculateNameSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;

    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    // If one string is much longer, similarity is low
    if (longer.length === 0) return 1;
    if (longer.length / shorter.length > 2) return 0;

    // Calculate Levenshtein distance
    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    
    return 1 - (distance / maxLength);
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  static levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1       // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  static checkTimeOverlap(event1, event2, bufferMs) {
    const start1 = new Date(event1.start).getTime();
    const end1 = new Date(event1.end).getTime();
    const start2 = new Date(event2.start).getTime();
    const end2 = new Date(event2.end).getTime();

    // Check if events overlap with buffer
    // Event1 starts before Event2 ends (with buffer) AND Event1 ends after Event2 starts (with buffer)
    return (start1 <= end2 + bufferMs) && (end1 >= start2 - bufferMs);
  }

  static calculateVenueDistance(venue1, venue2) {
    if (!venue1 || !venue2 || !venue1.lat || !venue2.lat || !venue1.lon || !venue2.lon) {
      return Infinity;
    }

    // Parse coordinates to numbers (they may come as strings from API)
    const lat1 = parseFloat(venue1.lat);
    const lon1 = parseFloat(venue1.lon);
    const lat2 = parseFloat(venue2.lat);
    const lon2 = parseFloat(venue2.lon);

    // Validate parsed coordinates
    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
      return Infinity;
    }

    // Haversine formula to calculate distance between two coordinates
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

  static toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  static determineConflictType(event1, event2) {
    // Calculate distance and venue name similarity
    const distance = this.calculateVenueDistance(event1.venue, event2.venue);
    const venueNameSimilarity = this.calculateVenueNameSimilarity(event1.venue, event2.venue);
    
    // Venues are considered the same if:
    // 1. Exact name match, OR
    // 2. Very close proximity (< 0.05km = 50m) AND high name similarity (> 70%)
    // This prevents false positives when different venues share coordinates
    const sameVenue = event1.venue.name === event2.venue.name ||
      (distance < 0.05 && venueNameSimilarity > 0.7);

    // Check if different platforms
    const differentPlatforms = event1.source !== event2.source;

    if (sameVenue && differentPlatforms) {
      return 'cross_platform_duplicate';
    } else if (sameVenue) {
      return 'same_venue_conflict';
    } else if (differentPlatforms) {
      return 'cross_platform_proximity';
    } else {
      return 'time_venue_conflict';
    }
  }

  static getTimeSlotString(event1, event2) {
    const start1 = new Date(event1.start);
    const start2 = new Date(event2.start);
    const earlierStart = start1 < start2 ? start1 : start2;
    
    return earlierStart.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  static calculateSeverity(event1, event2, bufferMs) {
    const start1 = new Date(event1.start).getTime();
    const end1 = new Date(event1.end).getTime();
    const start2 = new Date(event2.start).getTime();
    const end2 = new Date(event2.end).getTime();

    // Calculate overlap duration
    const overlapStart = Math.max(start1, start2);
    const overlapEnd = Math.min(end1, end2);
    const overlapDuration = Math.max(0, overlapEnd - overlapStart);

    // Calculate total duration of both events
    const totalDuration = (end1 - start1) + (end2 - start2);

    // Severity is based on overlap percentage
    const overlapPercentage = (overlapDuration / totalDuration) * 100;

    if (overlapPercentage > 50) {
      return 'high';
    } else if (overlapPercentage > 25) {
      return 'medium';
    } else {
      return 'low';
    }
  }
}

module.exports = ConflictDetector;

