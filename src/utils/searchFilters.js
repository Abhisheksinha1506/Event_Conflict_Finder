function normalizeDateInput(value, options = {}) {
  if (!value) {
    return null;
  }

  const trimmed = value.toString().trim();
  if (!trimmed) {
    return null;
  }

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  let isoCandidate = trimmed;

  if (isDateOnly) {
    const timePortion = options.endOfDay ? '23:59:59.999' : '00:00:00.000';
    isoCandidate = `${trimmed}T${timePortion}Z`;
  }

  const date = new Date(isoCandidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateRangeFilters(startValue, endValue) {
  const startDate = normalizeDateInput(startValue, { endOfDay: false });
  let endDate = normalizeDateInput(endValue, { endOfDay: true });

  if (startDate && endDate && endDate < startDate) {
    endDate = new Date(startDate.getTime());
    endDate.setHours(23, 59, 59, 999);
  }

  return { startDate, endDate };
}

function filterEventsByDateRange(events = [], startDate = null, endDate = null) {
  if ((!startDate && !endDate) || !Array.isArray(events)) {
    return events;
  }

  return events.filter(event => {
    if (!event || !event.start) {
      return true;
    }

    const eventDate = new Date(event.start);
    if (Number.isNaN(eventDate.getTime())) {
      return true;
    }

    if (startDate && eventDate < startDate) {
      return false;
    }

    if (endDate && eventDate > endDate) {
      return false;
    }

    return true;
  });
}

function sanitizeVenueRadiusKm(value, fallback = 1) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0.1, Math.min(5, parsed));
}

module.exports = {
  filterEventsByDateRange,
  parseDateRangeFilters,
  sanitizeVenueRadiusKm,
  normalizeDateInput
};

