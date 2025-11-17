require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const eventRoutes = require('./api/events');
const conflictRoutes = require('./api/conflicts');

// Validate environment variables on startup
function validateEnvironment() {
  const warnings = [];
  const errors = [];

  // Check Ticketmaster
  if (!process.env.TICKETMASTER_API_KEY || process.env.TICKETMASTER_API_KEY === 'your_ticketmaster_api_key_here') {
    warnings.push('⚠️  Ticketmaster API key not configured (will be skipped)');
  } else {
    console.log('✅ Ticketmaster API key configured');
  }

  // Check Bandsintown
  // Note: Bandsintown doesn't require an API key, but uses an app_id (optional)
  if (process.env.BANDSINTOWN_ENABLED !== 'false') {
    const appId = process.env.BANDSINTOWN_APP_ID || 'EventConflictFinder';
    console.log(`✅ Bandsintown service enabled (app_id: ${appId})`);
  } else {
    console.log('ℹ️  Bandsintown service is disabled');
  }

  // Display warnings
  if (warnings.length > 0) {
    console.log('\n📋 Configuration Warnings:');
    warnings.forEach(warning => console.log(warning));
  }

  // Check if at least one API is configured
  const hasTicketmaster = process.env.TICKETMASTER_API_KEY && 
    process.env.TICKETMASTER_API_KEY !== 'your_ticketmaster_api_key_here';
  const hasBandsintown = process.env.BANDSINTOWN_ENABLED !== 'false'; // Bandsintown doesn't require API key

  if (!hasTicketmaster && !hasBandsintown) {
    errors.push('❌ No services enabled! Please enable at least one service in .env file');
  }

  if (errors.length > 0) {
    console.log('\n❌ Configuration Errors:');
    errors.forEach(error => console.log(error));
    console.log('\n💡 Tip: Copy .env.example to .env and add your API keys');
  }

  return { warnings, errors };
}

const app = express();

// Trust proxy for accurate IP addresses (important for rate limiting)
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/events', eventRoutes);
app.use('/api/conflicts', conflictRoutes);
app.use('/api/monitoring', require('./api/monitoring'));

// Root route - serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3000;

// Validate environment on startup
console.log('🔍 Validating environment configuration...\n');
const validation = validateEnvironment();

// Start server
app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 Event Conflict Finder server running on port ${PORT}`);
  console.log(`📱 Open http://localhost:${PORT} in your browser`);
  console.log('='.repeat(60));
  
  if (validation.errors.length === 0) {
    console.log('\n✅ Server started successfully!');
  } else {
    console.log('\n⚠️  Server started but some APIs may not work. Check configuration above.');
  }

  // Start monitoring if enabled
  if (process.env.ENABLE_MONITORING !== 'false') {
    const monitoring = require('./utils/monitoring');
    monitoring.startPeriodicLogging();
    console.log('📊 Monitoring enabled (periodic status logging)');
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM received, shutting down gracefully...');
    const cacheManager = require('./utils/cacheManager');
    const rateLimiter = require('./utils/rateLimiter');
    const monitoring = require('./utils/monitoring');
    
    monitoring.stopPeriodicLogging();
    await cacheManager.close();
    await rateLimiter.close();
    
    process.exit(0);
  });
});

