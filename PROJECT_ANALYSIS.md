# Event Conflict Finder - Project Analysis

## 📋 Project Overview

**Event Conflict Finder** is a Node.js/Express application that aggregates event data from multiple ticketing platforms (Ticketmaster and Bandsintown) to identify scheduling conflicts. The system detects overlapping events at the same or nearby venues, helping prevent double-bookings and audience fragmentation.

### Key Technologies
- **Backend**: Node.js with Express.js
- **Caching**: Redis (with in-memory fallback)
- **Database**: Supabase (for user plans/entitlements)
- **Payment**: Polar (for checkout processing)
- **Frontend**: Vanilla JavaScript with Leaflet.js for maps
- **APIs**: Ticketmaster Discovery API, Bandsintown API

---

## 🏗️ Architecture Overview

### Application Structure

```
event-conflict-finder/
├── src/
│   ├── app.js                 # Main Express server & middleware
│   ├── api/                    # API route handlers
│   │   ├── events.js          # Event search endpoints
│   │   ├── conflicts.js       # Conflict detection endpoints
│   │   ├── paywall.js         # Payment & subscription management
│   │   └── monitoring.js       # System health & metrics
│   ├── services/              # External API integrations
│   │   ├── ticketmaster.js    # Ticketmaster service
│   │   └── bandsintown.js     # Bandsintown service
│   ├── utils/                 # Core utilities
│   │   ├── conflictDetector.js    # Conflict detection algorithm
│   │   ├── cacheManager.js        # Redis cache management
│   │   ├── rateLimiter.js         # Rate limiting system
│   │   ├── requestQueue.js        # Request queuing
│   │   ├── paywallService.js      # Subscription management
│   │   ├── freeSearchLimiter.js   # Free tier limiting
│   │   ├── monitoring.js          # Performance monitoring
│   │   └── supabaseClient.js      # Supabase client
│   └── config/
│       └── rateLimits.js      # Rate limit configurations
└── public/                    # Frontend static files
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

---

## 🔑 Core Functions & Components

### 1. Main Application (`src/app.js`)

**Purpose**: Express server setup, middleware configuration, route mounting

**Key Functions**:
- Environment validation on startup
- CORS middleware
- Special webhook body handling (for Polar signature verification)
- Static file serving
- Error handling middleware
- Graceful shutdown handling

**Routes Mounted**:
- `/api/events` → Event search routes
- `/api/conflicts` → Conflict detection routes
- `/api/paywall` → Payment/subscription routes
- `/api/monitoring` → Health check & status routes

---

### 2. Event Search API (`src/api/events.js`)

**Endpoint**: `GET /api/events/search`

**Functionality**:
- Searches events by location (lat/lon) and radius
- Aggregates results from Ticketmaster and Bandsintown
- Implements request deduplication (prevents duplicate API calls)
- Enforces paywall limits (free tier: 3 searches)
- Parallel API calls with error handling
- Performance metrics tracking
- Cache headers for client-side caching

**Key Features**:
- **Request Deduplication**: If multiple users search the same location simultaneously, only one API call is made
- **Paywall Enforcement**: Checks user subscription status before allowing searches
- **Error Resilience**: Continues even if one API service fails
- **Performance Monitoring**: Tracks duration, cache hit rates, event counts

**Response Format**:
```json
{
  "events": [...],
  "total": 42,
  "sources": {
    "ticketmaster": { "enabled": true, "count": 25, "success": true },
    "bandsintown": { "enabled": true, "count": 17, "success": true }
  },
  "searchParams": { "lat": 40.7128, "lon": -74.0060, "radius": 25 },
  "cache": { "hitRate": "45.2%", "connected": true }
}
```

---

### 3. Conflict Detection API (`src/api/conflicts.js`)

**Endpoints**:
- `POST /api/conflicts/detect` - Detect conflicts in provided event list
- `GET /api/conflicts/location` - Get conflicts for a location (fetches events + detects conflicts)

**Functionality**:
- Time-based overlap detection (with configurable buffer)
- Venue proximity detection (dynamic threshold based on venue density)
- Duplicate event filtering
- Conflict severity calculation (high/medium/low)
- Conflict type classification

**Conflict Types**:
- `same_venue_conflict`: Multiple events at the same venue
- `cross_platform_duplicate`: Same event listed on different platforms
- `cross_platform_proximity`: Events from different platforms at nearby venues
- `time_venue_conflict`: General time and location conflict

**Severity Levels**:
- **High**: >50% time overlap
- **Medium**: 25-50% time overlap
- **Low**: <25% time overlap

---

### 4. Conflict Detector (`src/utils/conflictDetector.js`)

**Core Algorithm**: Multi-criteria conflict detection

**Key Functions**:

1. **`findConflicts(events, timeBuffer, venueProximityThreshold, skipDuplicateFilter)`**
   - Main conflict detection function
   - Checks all event pairs for time overlap and venue proximity
   - Uses dynamic threshold calculation for venue proximity

2. **`filterDuplicates(events)`**
   - Removes duplicate events using multiple strategies:
     - Exact ID match
     - Same name, venue, and time (within 5 minutes)
     - Same venue, time, and similar names (fuzzy matching)

3. **`calculateDynamicThreshold(events)`**
   - Calculates venue proximity threshold based on venue density
   - Dense areas (median < 0.2km): 0.15km threshold
   - Medium density (0.2-0.5km): 0.2km threshold
   - Sparse areas (>0.5km): 0.3km threshold

4. **`checkTimeOverlap(event1, event2, bufferMs)`**
   - Checks if two events overlap in time (with buffer)

5. **`calculateVenueDistance(venue1, venue2)`**
   - Haversine formula for distance calculation between coordinates

6. **`calculateNameSimilarity(str1, str2)`**
   - Levenshtein distance algorithm for fuzzy name matching
   - Returns similarity score (0-1)

7. **`determineConflictType(event1, event2)`**
   - Classifies conflict type based on venue similarity and platform

8. **`calculateSeverity(event1, event2, bufferMs)`**
   - Calculates conflict severity based on overlap percentage

**Advanced Features**:
- Venue name normalization (removes location suffixes, parentheses)
- Venue name similarity checking (reduces false positives)
- Dynamic threshold adjustment based on venue density

---

### 5. Ticketmaster Service (`src/services/ticketmaster.js`)

**Class**: `TicketmasterService` (singleton)

**Key Functions**:

1. **`getEventsByLocation(lat, lon, radius, userId)`**
   - Main entry point for event search
   - Checks cache first
   - Enforces rate limits
   - Queues requests if approaching limits
   - Returns transformed events

2. **`makeApiRequest(lat, lon, radius, retryCount)`**
   - Makes API call to Ticketmaster Discovery API
   - Handles 429 (rate limit) responses with retry logic
   - Extracts rate limit headers
   - Transforms API response to standard format

3. **`transformEvent(eventData)`**
   - Converts Ticketmaster API format to standard event format
   - Extracts venue information
   - Calculates end time (defaults to 2 hours if not provided)
   - Validates event URLs

**Rate Limits**:
- Daily quota: 5,000 requests
- Rate limit: 4 requests/second (safety margin)
- Per-user: 100 requests/hour

**Error Handling**:
- Retries on 429 (Too Many Requests)
- Retries on network errors (exponential backoff)
- Returns cached data on errors if available

---

### 6. Bandsintown Service (`src/services/bandsintown.js`)

**Class**: `BandsintownService` (singleton)

**Key Functions**:

1. **`getEventsByLocation(lat, lon, radius, userId)`**
   - Main entry point (Bandsintown doesn't have direct location search)
   - Uses workaround: searches popular artists and filters by location

2. **`searchEventsByLocation(lat, lon, radius)`**
   - Searches events for popular artists in parallel
   - Filters events by location using Haversine formula
   - Removes duplicates

3. **`getArtistEvents(artistName, retryCount)`**
   - Fetches events for a specific artist
   - Handles timeouts (10 seconds default)
   - Retries on 429 errors
   - Handles 403 (authorization) gracefully

**Limitations**:
- Bandsintown API doesn't support direct location-based search
- Workaround: Searches 10 popular artists and filters results
- May miss events from less popular artists

**Rate Limits**:
- Hourly quota: 600 requests
- Rate limit: 8 requests/minute
- Per-user: 30 requests/hour

---

### 7. Cache Manager (`src/utils/cacheManager.js`)

**Class**: `CacheManager` (singleton)

**Purpose**: Redis-based caching with 15-minute TTL

**Key Functions**:

1. **`get(apiName, lat, lon, radius)`**
   - Retrieves cached events
   - Returns null if cache miss or Redis unavailable

2. **`set(apiName, lat, lon, radius, data, ttl)`**
   - Caches event data with TTL
   - Validates data before caching
   - Checks data size limits (512MB max)

3. **`generateKey(apiName, lat, lon, radius)`**
   - Creates cache key with rounded coordinates (4 decimal places)
   - Format: `events:{apiName}:{lat}:{lon}:{radius}`

4. **`getStats()`**
   - Returns cache statistics (hits, misses, hit rate)

**Features**:
- Automatic reconnection on Redis errors
- In-memory fallback if Redis unavailable (no caching)
- Cache hit rate tracking
- Graceful degradation

**Cache Strategy**:
- TTL: 15 minutes (900 seconds)
- Key precision: 4 decimal places (~11 meters)
- Benefits: 80-90% reduction in API calls

---

### 8. Rate Limiter (`src/utils/rateLimiter.js`)

**Class**: `RateLimiter` (singleton)

**Purpose**: Multi-level rate limiting (per-user, global quota, rate limit)

**Key Functions**:

1. **`checkAllLimits(apiName, userId)`**
   - Comprehensive check: user limit + global quota + rate limit
   - Returns: `{ allowed, waitTime, quotaUsed, shouldQueue }`

2. **`checkUserLimit(apiName, userId)`**
   - Per-user hourly limit check
   - Uses Redis sliding window

3. **`checkGlobalQuota(apiName)`**
   - Global quota check (daily/hourly)
   - Tracks quota usage
   - Indicates if queuing needed (at 80% threshold)

4. **`checkRateLimit(apiName)`**
   - Requests per second/minute limit
   - Uses Redis sorted sets (sliding window log)

**Rate Limit Levels**:
1. **Per-User Limit**: Prevents individual users from exceeding quotas
2. **Global Quota**: Prevents total API quota exhaustion
3. **Rate Limit**: Prevents burst traffic (requests/second or /minute)

**Fallback**: In-memory rate limiting if Redis unavailable

---

### 9. Request Queue (`src/utils/requestQueue.js`)

**Purpose**: Queues requests when approaching rate limits

**Functionality**:
- Automatically queues requests at 80% quota usage
- Processes queue in FIFO order
- Prevents quota exceeding
- Handles queue overflow

---

### 10. Paywall Service (`src/utils/paywallService.js`)

**Purpose**: Manages user subscriptions and free tier limits

**Key Functions**:

1. **`recordSearchUsage(email)`**
   - Records search usage for free users
   - Enforces 3-search limit for free tier
   - Returns: `{ allowed, planStatus, searchCount }`

2. **`getPlanStatus(email, autoVerifyPending)`**
   - Gets user's plan status from Supabase
   - Auto-verifies pending payments if enabled
   - Returns: `{ planStatus, allowed, searchCount }`

3. **`activatePlan(email, checkoutId)`**
   - Activates user plan after successful payment
   - Creates/updates Supabase record
   - Sets plan_status to 'active'

4. **`markCheckoutInitiated(email, checkoutId)`**
   - Logs checkout initiation (doesn't create DB record)

5. **`checkCheckoutStatusFromPolar(checkoutId)`**
   - Verifies payment status with Polar API
   - Returns: `{ isPaid, status, email }`

**Plan States**:
- `free`: Free tier user (3 searches max)
- `active`: Paid user (unlimited searches)
- `unknown`: User doesn't exist (payment required)

**Database Schema** (Supabase):
```sql
user_plans (
  email TEXT PRIMARY KEY,
  plan_status TEXT DEFAULT 'free',
  search_count INT DEFAULT 0,
  checkout_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

---

### 11. Paywall API (`src/api/paywall.js`)

**Endpoints**:

1. **`POST /api/paywall/status`**
   - Check user's plan status
   - Auto-verifies pending payments

2. **`POST /api/paywall/checkout`**
   - Creates Polar checkout session
   - Returns checkout URL

3. **`POST /api/paywall/webhook`**
   - Handles Polar webhook events
   - Verifies webhook signatures
   - Processes payment success/failure events
   - Activates plans on successful payment

4. **`POST /api/paywall/activate`** (Admin)
   - Manual plan activation (for testing)

5. **`POST /api/paywall/verify-checkout`**
   - Verifies and activates pending checkout

6. **`GET /api/paywall/pending`**
   - Lists all pending checkouts

7. **`POST /api/paywall/verify-all-pending`**
   - Verifies all pending checkouts

**Webhook Event Handling**:
- `benefit_grant.created` - Payment succeeded (PRIMARY)
- `checkout.succeeded` - Payment succeeded
- `checkout.updated` (status=succeeded) - Payment succeeded
- `checkout.payment_failed` - Payment failed
- `benefit_grant.revoked` - Plan revoked
- `customer.updated` - Customer info updated

---

### 12. Monitoring (`src/utils/monitoring.js` & `src/api/monitoring.js`)

**Endpoints**:
- `GET /api/monitoring/status` - System status and metrics
- `GET /api/monitoring/health` - Health check

**Metrics Tracked**:
- API performance (duration, event counts)
- Cache hit rates
- Rate limit status
- Quota usage
- Error rates

**Health Check**:
- Redis connectivity
- API service availability
- Overall system health

---

## 🔄 Data Flow

### Event Search Flow

```
1. User Request → GET /api/events/search?lat=X&lon=Y&radius=Z
2. Paywall Check → Verify user subscription
3. Request Deduplication → Check if same query in progress
4. Cache Check → Look for cached results
5. Rate Limit Check → Verify API quotas available
6. Parallel API Calls → Ticketmaster + Bandsintown
7. Transform Events → Convert to standard format
8. Cache Results → Store in Redis (15min TTL)
9. Return Response → Events + metadata
```

### Conflict Detection Flow

```
1. User Request → POST /api/conflicts/detect (with events)
2. Filter Duplicates → Remove duplicate events
3. Calculate Dynamic Threshold → Based on venue density
4. Check All Pairs → Time overlap + venue proximity
5. Classify Conflicts → Determine type and severity
6. Return Conflicts → Array of conflict objects
```

### Payment Flow

```
1. User Reaches Limit → 3 free searches exhausted
2. Paywall Modal → User enters email
3. Checkout Creation → POST /api/paywall/checkout
4. Polar Redirect → User completes payment
5. Webhook Received → POST /api/paywall/webhook
6. Signature Verification → Verify webhook authenticity
7. Plan Activation → activatePlan() updates Supabase
8. User Unlocked → Unlimited searches enabled
```

---

## 🎯 Key Features

### 1. **Intelligent Caching**
- 15-minute TTL reduces API calls by 80-90%
- Coordinate rounding for better cache hits
- Graceful degradation if Redis unavailable

### 2. **Multi-Level Rate Limiting**
- Per-user limits (prevents abuse)
- Global quota tracking (prevents exhaustion)
- Rate limiting (prevents burst traffic)
- Automatic queuing at 80% threshold

### 3. **Request Deduplication**
- Prevents duplicate API calls for same location
- Multiple users searching same location share one API call

### 4. **Advanced Conflict Detection**
- Dynamic venue proximity threshold
- Venue name similarity checking
- Time overlap with configurable buffer
- Duplicate event filtering
- Severity classification

### 5. **Freemium Model**
- 3 free searches per user
- Supabase for entitlement storage
- Polar for payment processing
- Automatic plan activation via webhooks

### 6. **Error Resilience**
- Continues if one API service fails
- Returns cached data on errors
- Retry logic with exponential backoff
- Graceful degradation

### 7. **Performance Monitoring**
- Tracks API call duration
- Cache hit rates
- Event counts per source
- Error rates

---

## 🔧 Configuration

### Environment Variables

**Required**:
- `TICKETMASTER_API_KEY` - Ticketmaster API key
- `REDIS_URL` - Redis connection URL (optional, falls back to in-memory)

**Optional**:
- `BANDSINTOWN_APP_ID` - Bandsintown app identifier (default: "EventConflictFinder")
- `BANDSINTOWN_ENABLED` - Enable/disable Bandsintown (default: true)
- `TICKETMASTER_ENABLED` - Enable/disable Ticketmaster (default: true)
- `CACHE_TTL_SECONDS` - Cache TTL (default: 900)
- `PORT` - Server port (default: 3000)

**Paywall** (Optional):
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `SUPABASE_PLAN_TABLE` - Table name (default: "user_plans")
- `FREE_SEARCH_LIMIT` - Free searches limit (default: 3)
- `POLAR_API_KEY` - Polar API key
- `POLAR_PRODUCT_ID` - Polar product ID
- `POLAR_PRODUCT_PRICE_ID` - Polar product price ID
- `POLAR_PAYMENT_PROCESSOR` - Payment processor (default: "stripe")
- `POLAR_WEBHOOK_SECRET` - Webhook signature secret
- `FRONTEND_URL` - Frontend URL for redirects

---

## 📊 Performance Characteristics

### Caching
- **Cache Hit Rate**: Typically 45-60% in production
- **API Call Reduction**: 80-90% reduction
- **Cache TTL**: 15 minutes

### Rate Limiting
- **Ticketmaster**: 5,000 requests/day, 4 req/sec, 100 req/hour/user
- **Bandsintown**: 600 requests/hour, 8 req/min, 30 req/hour/user

### Conflict Detection
- **Algorithm Complexity**: O(n²) for conflict detection
- **Optimization**: Early exit, duplicate filtering, dynamic thresholds
- **Performance**: Handles 1000+ events in <100ms

---

## 🚀 Deployment Considerations

### Redis
- Required for optimal performance (caching + rate limiting)
- Falls back to in-memory if unavailable
- Cloud Redis recommended (Redis Cloud, AWS ElastiCache, etc.)

### Supabase
- Required for paywall functionality
- Falls back to in-memory free tier limiting if unavailable

### Polar
- Required for payment processing
- Webhook endpoint must be publicly accessible
- Signature verification required for security

---

## 🔒 Security Features

1. **Webhook Signature Verification**: Polar webhooks verified with HMAC-SHA256
2. **Rate Limiting**: Prevents API abuse and quota exhaustion
3. **Input Validation**: Coordinates, time buffers, etc. validated
4. **Error Handling**: No sensitive data leaked in error messages
5. **CORS**: Configured for cross-origin requests

---

## 📝 Notes

- **Bandsintown Limitation**: No direct location search, uses artist-based workaround
- **Event End Times**: Defaults to 2 hours if not provided by API
- **Coordinate Precision**: Rounded to 4 decimal places for caching (~11 meters)
- **Duplicate Detection**: Uses fuzzy matching to catch variations
- **Dynamic Thresholds**: Adapts to venue density for better conflict detection

---

## 🎓 Future Enhancements

- Background workers for continuous event processing
- Advanced analytics and reporting
- User authentication and saved searches
- Email notifications for new conflicts
- Additional ticketing platform integrations
- Real-time conflict alerts

---

**Built with ❤️ for event organizers everywhere**

