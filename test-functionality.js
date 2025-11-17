require('dotenv').config();
const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';
const TEST_LOCATION = { lat: 40.7128, lon: -74.0060, radius: 25 };

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

async function testEndpoint(name, url, options = {}, expectJson = true) {
  try {
    const response = await fetch(url, options);
    
    if (response.ok) {
      if (expectJson) {
        const data = await response.json();
        log(`✅ ${name}: SUCCESS`, 'green');
        return { success: true, data, status: response.status };
      } else {
        const text = await response.text();
        log(`✅ ${name}: SUCCESS`, 'green');
        return { success: true, data: text, status: response.status };
      }
    } else {
      const data = expectJson ? await response.json().catch(() => ({})) : {};
      log(`❌ ${name}: FAILED (Status: ${response.status})`, 'red');
      return { success: false, data, status: response.status };
    }
  } catch (error) {
    log(`❌ ${name}: ERROR - ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

async function testServerHealth() {
  logSection('1. Testing Server Health');
  
  const result = await testEndpoint('Server Root', `${BASE_URL}/`, {}, false);
  if (result.success) {
    const isHtml = result.data && result.data.includes('<!DOCTYPE html>');
    if (isHtml) {
      log('   Server is running and serving HTML', 'green');
    } else {
      log('   Server responded but content may be incorrect', 'yellow');
    }
  }
  return result.success;
}

async function testEventsSearch() {
  logSection('2. Testing Events Search API');
  
  const url = `${BASE_URL}/api/events/search?lat=${TEST_LOCATION.lat}&lon=${TEST_LOCATION.lon}&radius=${TEST_LOCATION.radius}`;
  const result = await testEndpoint('GET /api/events/search', url);
  
  if (result.success && result.data) {
    log(`   Total Events: ${result.data.total || result.data.events?.length || 0}`, 'blue');
    
    if (result.data.sources) {
      log('\n   Source Status:', 'yellow');
      Object.entries(result.data.sources).forEach(([source, info]) => {
        const status = info.success ? '✅' : '❌';
        const count = info.count || 0;
        const enabled = info.enabled ? 'enabled' : 'disabled';
        log(`   ${status} ${source}: ${count} events (${enabled})`, info.success ? 'green' : 'yellow');
        if (info.error) {
          log(`      Error: ${info.error}`, 'red');
        }
      });
    }
    
    if (result.data.events && result.data.events.length > 0) {
      log(`\n   Sample Event:`, 'blue');
      const sample = result.data.events[0];
      log(`   - Name: ${sample.name}`, 'blue');
      log(`   - Source: ${sample.source}`, 'blue');
      log(`   - Venue: ${sample.venue?.name || 'N/A'}`, 'blue');
      log(`   - Start: ${sample.start}`, 'blue');
    }
  }
  
  return result;
}

async function testConflictDetection() {
  logSection('3. Testing Conflict Detection API');
  
  // Create test events with conflicts
  const testEvents = [
    {
      id: 'test_1',
      name: 'Jazz Concert',
      start: '2025-11-16T20:00:00Z',
      end: '2025-11-16T22:00:00Z',
      venue: {
        name: 'Blue Note Jazz Club',
        lat: 40.730940,
        lon: -74.000650
      },
      source: 'ticketmaster'
    },
    {
      id: 'test_2',
      name: 'Jazz Night',
      start: '2025-11-16T20:30:00Z',
      end: '2025-11-16T22:30:00Z',
      venue: {
        name: 'Blue Note Jazz Club',
        lat: 40.730940,
        lon: -74.000650
      },
      source: 'bandsintown'
    },
    {
      id: 'test_3',
      name: 'Rock Show',
      start: '2025-11-16T23:00:00Z',
      end: '2025-11-17T01:00:00Z',
      venue: {
        name: 'Madison Square Garden',
        lat: 40.74970620,
        lon: -73.99160060
      },
      source: 'ticketmaster'
    }
  ];
  
  const url = `${BASE_URL}/api/conflicts/detect`;
  const result = await testEndpoint(
    'POST /api/conflicts/detect',
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: testEvents, timeBuffer: 30 })
    }
  );
  
  if (result.success && result.data) {
    log(`   Conflicts Detected: ${result.data.conflictCount || 0}`, 'blue');
    log(`   Total Events Analyzed: ${result.data.totalEvents || 0}`, 'blue');
    
    if (result.data.conflicts && result.data.conflicts.length > 0) {
      log('\n   Conflict Details:', 'yellow');
      result.data.conflicts.forEach((conflict, index) => {
        log(`   ${index + 1}. ${conflict.conflictType} (${conflict.severity} severity)`, 'blue');
        log(`      Time: ${conflict.timeSlot}`, 'blue');
        log(`      Events: ${conflict.events.map(e => e.name).join(' vs ')}`, 'blue');
      });
    } else {
      log('   No conflicts detected in test data', 'yellow');
    }
  }
  
  return result;
}

async function testLocationConflicts() {
  logSection('4. Testing Location-Based Conflict Detection');
  
  const url = `${BASE_URL}/api/conflicts/location?lat=${TEST_LOCATION.lat}&lon=${TEST_LOCATION.lon}&radius=${TEST_LOCATION.radius}&timeBuffer=30`;
  const result = await testEndpoint('GET /api/conflicts/location', url);
  
  if (result.success && result.data) {
    const summary = result.data.summary || {};
    log(`   Total Events: ${summary.totalEvents || 0}`, 'blue');
    log(`   Conflicts Found: ${summary.conflictCount || 0}`, 'blue');
    log(`   Conflict Rate: ${summary.conflictRate || '0%'}`, 'blue');
    
    if (summary.sources) {
      log('\n   Events by Source:', 'yellow');
      Object.entries(summary.sources).forEach(([source, count]) => {
        log(`   - ${source}: ${count} events`, 'blue');
      });
    }
    
    if (result.data.conflicts && result.data.conflicts.length > 0) {
      log(`\n   Sample Conflict:`, 'yellow');
      const sample = result.data.conflicts[0];
      log(`   - Type: ${sample.conflictType}`, 'blue');
      log(`   - Severity: ${sample.severity}`, 'blue');
      log(`   - Events: ${sample.events.map(e => e.name).join(' vs ')}`, 'blue');
    }
  }
  
  return result;
}

async function testStaticFiles() {
  logSection('5. Testing Static File Serving');
  
  const files = [
    { name: 'CSS', path: '/css/style.css' },
    { name: 'JavaScript', path: '/js/app.js' }
  ];
  
  let allPassed = true;
  for (const file of files) {
    try {
      const response = await fetch(`${BASE_URL}${file.path}`);
      if (response.ok) {
        log(`✅ ${file.name} file: SERVED`, 'green');
      } else {
        log(`❌ ${file.name} file: NOT FOUND (${response.status})`, 'red');
        allPassed = false;
      }
    } catch (error) {
      log(`❌ ${file.name} file: ERROR - ${error.message}`, 'red');
      allPassed = false;
    }
  }
  
  return allPassed;
}

async function testServices() {
  logSection('6. Testing Service Configuration');
  
  const services = [
    { name: 'Ticketmaster', key: 'TICKETMASTER_API_KEY', enabled: 'TICKETMASTER_ENABLED' },
    { name: 'Bandsintown', key: 'BANDSINTOWN_APP_ID', enabled: 'BANDSINTOWN_ENABLED', optional: true }
  ];
  
  services.forEach(service => {
    // Check primary key (or optional alt key if provided)
    const apiKey = process.env[service.key] || (service.altKey ? process.env[service.altKey] : null);
    const enabled = process.env[service.enabled] !== 'false';
    const hasKey = apiKey && apiKey !== `your_${service.key.toLowerCase()}_here` && 
                   !apiKey.includes('your_') && !apiKey.includes('_here');
    
    if (hasKey || service.optional) {
      log(`✅ ${service.name}: ${hasKey ? 'API key configured' : 'Optional (no key required)'}`, 'green');
    } else {
      log(`⚠️  ${service.name}: API key not configured`, 'yellow');
    }
    
    if (!enabled) {
      log(`   ${service.name} is disabled`, 'yellow');
    }
  });
}

async function runAllTests() {
  console.log('\n');
  log('🧪 EVENT CONFLICT FINDER - FUNCTIONALITY TEST', 'cyan');
  log('Testing all application features...\n', 'blue');
  
  const results = {
    serverHealth: false,
    eventsSearch: false,
    conflictDetection: false,
    locationConflicts: false,
    staticFiles: false
  };
  
  // Test server health
  results.serverHealth = await testServerHealth();
  
  if (!results.serverHealth) {
    log('\n❌ Server is not running. Please start the server first:', 'red');
    log('   npm start', 'yellow');
    return;
  }
  
  // Test static files
  results.staticFiles = await testStaticFiles();
  
  // Test events search
  const eventsResult = await testEventsSearch();
  results.eventsSearch = eventsResult.success;
  
  // Test conflict detection
  const conflictResult = await testConflictDetection();
  results.conflictDetection = conflictResult.success;
  
  // Test location conflicts
  const locationResult = await testLocationConflicts();
  results.locationConflicts = locationResult.success;
  
  // Test service configuration
  await testServices();
  
  // Summary
  logSection('TEST SUMMARY');
  
  const totalTests = Object.keys(results).length;
  const passedTests = Object.values(results).filter(r => r).length;
  
  Object.entries(results).forEach(([test, passed]) => {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    const color = passed ? 'green' : 'red';
    log(`${status}: ${test}`, color);
  });
  
  console.log('\n');
  log(`Tests Passed: ${passedTests}/${totalTests}`, passedTests === totalTests ? 'green' : 'yellow');
  
  if (passedTests === totalTests) {
    log('\n🎉 All functionality tests passed!', 'green');
  } else {
    log('\n⚠️  Some tests failed. Please review the output above.', 'yellow');
  }
  
  console.log('\n');
}

// Run tests
runAllTests().catch(error => {
  log(`\n❌ Fatal Error: ${error.message}`, 'red');
  process.exit(1);
});

