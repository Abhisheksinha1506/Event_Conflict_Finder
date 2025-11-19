# Event Conflict Finder - Phase 1

A comprehensive event intelligence platform that identifies scheduling conflicts across multiple ticketing platforms in real-time. This Phase 1 implementation includes a complete backend with mock data services and a functional frontend interface.

## 🎯 Project Overview

**Event Conflict Finder** aggregates data from Ticketmaster and Bandsintown APIs to prevent double-bookings, venue overcrowding, and audience fragmentation. Features Redis caching, rate limiting, and request queuing to handle unlimited concurrent users.

> 📘 Looking for a deep-dive? See [`COMPREHENSIVE_ANALYSIS.md`](./COMPREHENSIVE_ANALYSIS.md) for a detailed architectural walkthrough of Phase 1.

## ✅ Phase 1 Deliverables

- **Full-stack prototype** with Node/Express backend and Leaflet-powered frontend
- **Multi-source aggregation** from Ticketmaster + Bandsintown with standardized event model
- **Conflict intelligence engine** with duplicate filtering, venue proximity, and severity scoring
- **Operational safeguards**: Redis caching, multi-level rate limiting, automatic request queuing
- **Freemium paywall** backed by Supabase + Polar with enhanced modal flow:
  - Users now see the paywall modal immediately after checkout success, cancellation, or failure with the appropriate message, email sign-in form, and “Buy unlimited plan” CTA so they can recover without refreshing.

These deliverables complete Phase 1’s goal of validating the conflict-detection experience end-to-end while collecting product telemetry for future iterations.

## ✨ Features

### Backend
- **Express.js Server**: RESTful API with CORS support
- **API Services**: Ticketmaster and Bandsintown integrations
- **Redis Caching**: 15-minute TTL cache to reduce API calls by 80-90%
- **Rate Limiting**: Per-user and global pool limits to prevent quota exceeding
- **Request Queuing**: Automatic queuing when approaching rate limits
- **Conflict Detection Engine**: Time-based overlap and venue proximity detection
- **API Routes**: 
  - `GET /api/events/search` - Search events by location
  - `POST /api/conflicts/detect` - Detect conflicts in event list
  - `GET /api/conflicts/location` - Get conflicts for a location
  - `GET /api/monitoring/status` - System status and metrics
  - `GET /api/monitoring/health` - Health check endpoint

### Frontend
- **Interactive Map**: Leaflet.js integration with event markers
- **Real-time Search**: Location-based event search
- **Conflict Visualization**: Color-coded conflict severity display
- **Responsive Design**: Mobile and desktop optimized
- **Source Filtering**: Events from Ticketmaster and Bandsintown

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- Redis (for caching and rate limiting)
  - Install: `brew install redis` (Mac) or use Docker
  - Start: `redis-server`
  - Or use cloud Redis service (Redis Cloud, AWS ElastiCache, etc.)

### Installation

1. **Clone or navigate to the project directory:**
   ```bash
   cd event-conflict-finder
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp env.example .env
   ```
   Edit `.env` and add your API keys:
   - `TICKETMASTER_API_KEY` - Required
   - `REDIS_URL` - Optional (defaults to `redis://localhost:6379`)
   
4. **Start Redis (if running locally):**
   ```bash
   redis-server
   ```
   Or use a cloud Redis service and set `REDIS_URL` in `.env`

5. **Start the development server:**
   ```bash
   npm run dev
   ```
   Or for production:
   ```bash
   npm start
   ```

6. **Open your browser:**
   Navigate to `http://localhost:3000`

## 📁 Project Structure

```
event-conflict-finder/
├── src/
│   ├── app.js                 # Main Express server
│   ├── api/
│   │   ├── events.js          # Events API routes
│   │   ├── conflicts.js       # Conflict detection routes
│   │   └── monitoring.js      # Monitoring endpoints
│   ├── services/
│   │   ├── ticketmaster.js    # Ticketmaster service
│   │   └── bandsintown.js     # Bandsintown service
│   ├── utils/
│   │   ├── conflictDetector.js # Conflict detection algorithm
│   │   ├── cacheManager.js    # Redis cache manager
│   │   ├── rateLimiter.js      # Rate limiting with per-user + global pool
│   │   ├── requestQueue.js     # Request queuing system
│   │   └── monitoring.js       # Monitoring and logging
│   └── config/
│       └── rateLimits.js       # Rate limit configuration
├── public/
│   ├── index.html             # Main frontend page
│   ├── css/
│   │   └── style.css          # Frontend styling
│   └── js/
│       └── app.js             # Frontend JavaScript logic
├── env.example                # Environment variables template
├── .gitignore                 # Git ignore rules
├── package.json               # Node.js dependencies and scripts
└── README.md                  # This file
```

## 🔧 Usage

### Searching for Events

1. Enter a city name in the search box (e.g., "New York", "London", "Los Angeles")
2. Adjust the search radius (in miles) if needed
3. Set the time buffer (in minutes) for conflict detection
4. Click "Search Events"

### Viewing Results

- **Map View**: Events are displayed as colored markers on the map
  - Blue markers: Ticketmaster events
  - Green markers: Bandsintown events
  - Color intensity indicates conflict severity (red = high, yellow = low, green = no conflicts)
- **Events List**: All found events are listed with details
- **Conflicts Panel**: Detected conflicts are shown with severity levels:
  - **High**: >50% time overlap
  - **Medium**: 25-50% time overlap
  - **Low**: <25% time overlap

### Conflict Detection

The system detects conflicts when:
- Events have overlapping time slots (within the specified buffer)
- Events are at the same venue or within 0.5km of each other

Conflict types include:
- `same_venue_conflict`: Multiple events at the same venue
- `cross_platform_duplicate`: Same event listed on different platforms
- `cross_platform_proximity`: Events from different platforms at nearby venues
- `time_venue_conflict`: General time and location conflict

## 🧪 Testing

### Manual Testing

1. **Test Event Search:**
   ```bash
   curl "http://localhost:3000/api/events/search?lat=40.7128&lon=-74.0060&radius=25"
   ```

2. **Test Conflict Detection:**
   ```bash
   curl -X POST http://localhost:3000/api/conflicts/detect \
     -H "Content-Type: application/json" \
     -d '{"events": [...], "timeBuffer": 30}'
   ```

3. **Test Location Conflicts:**
   ```bash
   curl "http://localhost:3000/api/conflicts/location?lat=40.7128&lon=-74.0060&radius=25&timeBuffer=30"
   ```

4. **Check System Status:**
   ```bash
   curl "http://localhost:3000/api/monitoring/status"
   ```

5. **Health Check:**
   ```bash
   curl "http://localhost:3000/api/monitoring/health"
   ```

## 🚦 Rate Limiting & Caching

### Rate Limits

- **Ticketmaster**: 5,000 requests/day, 4 req/sec (safety margin)
- **Bandsintown**: 600 requests/hour, 8 req/min (conservative)

### Per-User Limits

- **Ticketmaster**: 100 requests/hour per user
- **Bandsintown**: 30 requests/hour per user

### Caching

- **TTL**: 15 minutes (900 seconds)
- **Storage**: Redis
- **Benefits**: 
  - Identical queries return instantly
  - Multiple users searching same location share one API call
  - Reduces API calls by 80-90%

### Request Queuing

- Automatically queues requests when quota usage reaches 80%
- Processes queue in FIFO order
- Prevents quota exceeding

See [RATE_LIMITING_IMPLEMENTATION.md](./RATE_LIMITING_IMPLEMENTATION.md) for detailed documentation.

## 🛠️ Development

### Available Scripts

- `npm start` - Start the production server
- `npm run dev` - Start the development server with nodemon (auto-reload)

### Adding New Features

1. **New Service**: Add a new service class in `src/services/`
2. **New Route**: Add routes in `src/api/`
3. **Frontend Updates**: Modify files in `public/`

## 🔮 Next Steps (Future Phases)

- ✅ Redis caching layer (IMPLEMENTED)
- ✅ Rate limiting and quota management (IMPLEMENTED)
- ✅ Request queuing system (IMPLEMENTED)
- Background workers for continuous event processing
- Advanced analytics and reporting
- User authentication and saved searches
- Email notifications for new conflicts

## 📝 Notes

- **API Keys Required**: Ticketmaster API key is required. Bandsintown can run without an API key.
- **Redis Required**: For optimal performance, Redis should be running (falls back to in-memory if unavailable)
- **Rate Limits**: System automatically prevents exceeding API quotas
- **Caching**: Results cached for 15 minutes to reduce API calls
- **Conflict Detection**: Uses Haversine formula for distance calculation
- **Time Buffer**: Configurable (default: 30 minutes)
- **Premium Searches**: Users get 3 free searches before being prompted to sign in or purchase the unlimited plan

## 💸 Premium Access & Payments

The application now supports a freemium flow with Supabase for entitlement storage and Polar for checkout.

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only) |
| `SUPABASE_PLAN_TABLE` | Optional. Defaults to `user_plans` |
| `FREE_SEARCH_LIMIT` | Optional. Defaults to `3` |
| `POLAR_API_KEY` | Polar API key for checkout creation |
| `POLAR_PRODUCT_ID` | Polar product identifier for the unlimited plan (optional if `POLAR_PRODUCT_PRICE_ID` is set) |
| `POLAR_PRODUCT_PRICE_ID` | Polar product price ID (preferred when using product pricing) |
| `POLAR_PAYMENT_PROCESSOR` | Payment processor label (e.g. `stripe`) required by Polar |
| `POLAR_SUCCESS_URL` / `POLAR_CANCEL_URL` | Optional overrides for redirect URLs |
| `POLAR_WEBHOOK_SECRET` | Secret used to validate Polar webhook payloads |
| `FRONTEND_URL` | Public URL for success redirect fallbacks |

### Supabase Table

Create (or update) a table such as `user_plans`:

```sql
create table if not exists user_plans (
  email text primary key,
  plan_status text default 'free',
  search_count int default 0,
  checkout_id text,
  updated_at timestamptz default now()
);
```

The backend uses the Supabase service role key to insert/update plan records server-side.

### Polar Checkout

1. Create a Polar product (and price) representing the unlimited plan and capture its `POLAR_PRODUCT_ID` / `POLAR_PRODUCT_PRICE_ID`.
2. Configure a hosted checkout link with success/cancel URLs pointing back to your deployment (e.g. `https://example.com?payment=success`).
3. Create a webhook in Polar pointing to `/api/paywall/webhook` and reuse the `POLAR_WEBHOOK_SECRET`.

### User Flow

1. Visitors can run up to three searches anonymously.
2. On the third search, a modal prompts them to sign in (existing plan) or create a new user and buy the plan.
3. Existing users enter their email, which is validated against Supabase. Active plans unlock unlimited searches immediately.
4. New users start a Polar checkout. After payment Polar redirects back with a success flag and the backend marks the plan as `active`.
5. Returning users only need to re-enter their email next time this paywall appears.

## 🤝 Contributing

This is Phase 1 of the Event Conflict Finder project. Future phases will include real API integrations and additional features.

## 📄 License

MIT

---

**Built with ❤️ for event organizers everywhere**

