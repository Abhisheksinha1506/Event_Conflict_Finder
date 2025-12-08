const { find } = require('geo-tz');

/**
 * Get timezone for a given latitude and longitude
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {string|null} - IANA timezone identifier (e.g., 'America/New_York') or null if not found
 */
function getTimezoneForCoordinates(lat, lon) {
  try {
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return null;
    }
    if (isNaN(lat) || isNaN(lon)) {
      return null;
    }
    const timezones = find(lat, lon);
    if (Array.isArray(timezones) && timezones.length > 0) {
      return timezones[0]; // Return first timezone if multiple
    }
    return null;
  } catch (error) {
    console.error('Error getting timezone for coordinates:', error);
    return null;
  }
}

/**
 * Format date in a specific timezone
 * @param {Date|string} date - Date to format
 * @param {string} timezone - IANA timezone identifier
 * @param {object} options - Intl.DateTimeFormat options
 * @returns {string} - Formatted date string
 */
function formatDateInTimezone(date, timezone, options = {}) {
  try {
    const dateObj = date instanceof Date ? date : new Date(date);
    if (isNaN(dateObj.getTime())) {
      return date.toString(); // Fallback to string if invalid date
    }

    const defaultOptions = {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...options
    };

    return new Intl.DateTimeFormat('en-US', defaultOptions).format(dateObj);
  } catch (error) {
    console.error('Error formatting date in timezone:', error);
    // Fallback to local timezone
    return date instanceof Date ? date.toLocaleString() : new Date(date).toLocaleString();
  }
}

/**
 * Get timezone abbreviation (e.g., EST, PST)
 * @param {Date|string} date - Date to get abbreviation for
 * @param {string} timezone - IANA timezone identifier
 * @returns {string} - Timezone abbreviation
 */
function getTimezoneAbbreviation(date, timezone) {
  try {
    const dateObj = date instanceof Date ? date : new Date(date);
    if (isNaN(dateObj.getTime())) {
      return '';
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short'
    });

    const parts = formatter.formatToParts(dateObj);
    const tzPart = parts.find(part => part.type === 'timeZoneName');
    return tzPart ? tzPart.value : '';
  } catch (error) {
    console.error('Error getting timezone abbreviation:', error);
    return '';
  }
}

module.exports = {
  getTimezoneForCoordinates,
  formatDateInTimezone,
  getTimezoneAbbreviation
};

