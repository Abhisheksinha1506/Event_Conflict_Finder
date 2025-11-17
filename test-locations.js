require('dotenv').config();
const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';

// Test locations
const locations = {
  'New York': { lat: 40.7128, lon: -74.0060, radius: 25 },
  'Delhi': { lat: 28.6139, lon: 77.2090, radius: 25 },
  'Mumbai': { lat: 19.0760, lon: 72.8777, radius: 25 }
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  log(title, 'cyan');
  console.log('='.repeat(70));
}

function logSubSection(title) {
  console.log('\n' + '-'.repeat(70));
  log(title, 'magenta');
  console.log('-'.repeat(70));
}

async function testLocation(locationName, location) {
  logSection(`Testing Location: ${locationName.toUpperCase()}`);
  log(`Coordinates: ${location.lat}, ${location.lon}`, 'blue');
  log(`Radius: ${location.radius} miles\n`, 'blue');

  try {
    // Test 1: Events Search
    logSubSection('1. Events Search');
    const eventsUrl = `${BASE_URL}/api/events/search?lat=${location.lat}&lon=${location.lon}&radius=${location.radius}`;
    const eventsResponse = await fetch(eventsUrl);
    
    if (!eventsResponse.ok) {
      log(`❌ Events Search Failed: ${eventsResponse.status}`, 'red');
      return;
    }

    const eventsData = await eventsResponse.json();
    const totalEvents = eventsData.total || eventsData.events?.length || 0;
    
    log(`✅ Total Events Found: ${totalEvents}`, 'green');
    
    if (eventsData.sources) {
      log('\n   Source Breakdown:', 'yellow');
      Object.entries(eventsData.sources).forEach(([source, info]) => {
        const count = info.count || 0;
        const enabled = info.enabled ? 'enabled' : 'disabled';
        const success = info.success ? '✅' : '❌';
        const statusColor = info.success ? 'green' : 'red';
        log(`   ${success} ${source}: ${count} events (${enabled})`, statusColor);
        if (info.error) {
          log(`      Error: ${info.error}`, 'red');
        }
      });
    }

    if (eventsData.events && eventsData.events.length > 0) {
      log('\n   Sample Events:', 'yellow');
      eventsData.events.slice(0, 5).forEach((event, index) => {
        log(`   ${index + 1}. ${event.name}`, 'blue');
        log(`      Source: ${event.source} | Venue: ${event.venue?.name || 'N/A'}`, 'blue');
        log(`      Time: ${new Date(event.start).toLocaleString()}`, 'blue');
      });
    } else {
      log('   ⚠️  No events found in this location', 'yellow');
    }

    // Test 2: Conflict Detection
    logSubSection('2. Conflict Detection');
    
    if (totalEvents > 0) {
      const conflictsUrl = `${BASE_URL}/api/conflicts/location?lat=${location.lat}&lon=${location.lon}&radius=${location.radius}&timeBuffer=30`;
      const conflictsResponse = await fetch(conflictsUrl);
      
      if (conflictsResponse.ok) {
        const conflictsData = await conflictsResponse.json();
        const summary = conflictsData.summary || {};
        const conflictCount = summary.conflictCount || 0;
        const conflictRate = summary.conflictRate || '0%';
        
        log(`✅ Conflicts Detected: ${conflictCount}`, 'green');
        log(`   Conflict Rate: ${conflictRate}`, 'blue');
        
        if (summary.sources) {
          log('\n   Events by Source:', 'yellow');
          Object.entries(summary.sources).forEach(([source, count]) => {
            log(`   - ${source}: ${count} events`, 'blue');
          });
        }

        if (conflictsData.conflicts && conflictsData.conflicts.length > 0) {
          log('\n   Sample Conflicts:', 'yellow');
          conflictsData.conflicts.slice(0, 3).forEach((conflict, index) => {
            log(`   ${index + 1}. ${conflict.conflictType} (${conflict.severity} severity)`, 'blue');
            log(`      Time: ${conflict.timeSlot}`, 'blue');
            log(`      Events: ${conflict.events.map(e => e.name).join(' vs ')}`, 'blue');
          });
        } else {
          log('   ✅ No conflicts detected - Good!', 'green');
        }
      } else {
        log(`❌ Conflict Detection Failed: ${conflictsResponse.status}`, 'red');
      }
    } else {
      log('   ⚠️  Skipping conflict detection (no events found)', 'yellow');
    }

    // Test 3: Geocoding Test (if location name is provided)
    logSubSection('3. Geocoding Test');
    log('   Testing if frontend can geocode location name...', 'blue');
    log('   (This would be tested in browser - location name geocoding)', 'yellow');

  } catch (error) {
    log(`❌ Error testing location: ${error.message}`, 'red');
  }
}

async function runLocationTests() {
  console.log('\n');
  log('🌍 EVENT CONFLICT FINDER - LOCATION TESTING', 'cyan');
  log('Testing application with different geographic locations...\n', 'blue');

  const results = {};

  for (const [locationName, location] of Object.entries(locations)) {
    await testLocation(locationName, location);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay between tests
  }

  // Summary
  logSection('TEST SUMMARY');
  log('✅ All location tests completed', 'green');
  log('\nLocations tested:', 'yellow');
  Object.keys(locations).forEach(loc => {
    log(`   - ${loc}`, 'blue');
  });
  
  console.log('\n');
  log('💡 Note: Results may vary based on:', 'yellow');
  log('   - API availability in different regions', 'yellow');
  log('   - Event density in each location', 'yellow');
  log('   - API key permissions and access', 'yellow');
  console.log('\n');
}

// Run tests
runLocationTests().catch(error => {
  log(`\n❌ Fatal Error: ${error.message}`, 'red');
  process.exit(1);
});

