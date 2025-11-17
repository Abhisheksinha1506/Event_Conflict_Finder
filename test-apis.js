require('dotenv').config();
const TicketmasterService = require('./src/services/ticketmaster');
const BandsintownService = require('./src/services/bandsintown');

async function testAllAPIs() {
  console.log('\n' + '='.repeat(70));
  console.log('🔍 TESTING ALL APIs');
  console.log('='.repeat(70));
  console.log('Location: New York (40.7128, -74.0060)');
  console.log('Radius: 25 miles\n');

  const testLocation = { lat: 40.7128, lon: -74.0060, radius: 25 };

  // Test Ticketmaster
  console.log('📊 Testing Ticketmaster API...');
  try {
    const ticketmasterEvents = await TicketmasterService.getEventsByLocation(
      testLocation.lat,
      testLocation.lon,
      testLocation.radius
    );
    if (ticketmasterEvents.length > 0) {
      console.log(`   ✅ Ticketmaster: WORKING - ${ticketmasterEvents.length} events found`);
      console.log(`   Sample: ${ticketmasterEvents[0].name}`);
    } else {
      console.log('   ⚠️  Ticketmaster: No events found');
    }
  } catch (error) {
    console.log(`   ❌ Ticketmaster: ERROR - ${error.message}`);
  }

  // Test Bandsintown
  console.log('📊 Testing Bandsintown API...');
  try {
    const bandsintownEvents = await BandsintownService.getEventsByLocation(
      testLocation.lat,
      testLocation.lon,
      testLocation.radius
    );
    if (bandsintownEvents.length > 0) {
      console.log(`   ✅ Bandsintown: WORKING - ${bandsintownEvents.length} events found`);
      console.log(`   Sample: ${bandsintownEvents[0].name}`);
    } else {
      console.log('   ⚠️  Bandsintown: No events found');
    }
  } catch (error) {
    console.log(`   ❌ Bandsintown: ERROR - ${error.message}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('📋 API CONFIGURATION STATUS');
  console.log('='.repeat(70));
  console.log(`Ticketmaster API Key: ${process.env.TICKETMASTER_API_KEY ? '✅ SET (' + process.env.TICKETMASTER_API_KEY.length + ' chars)' : '❌ NOT SET'}`);
  console.log(`Bandsintown App ID: ${process.env.BANDSINTOWN_APP_ID || 'EventConflictFinder (default)'}`);
  console.log(`Bandsintown Enabled: ${process.env.BANDSINTOWN_ENABLED !== 'false' ? '✅ YES' : '❌ NO'}`);
  console.log('='.repeat(70) + '\n');
}

testAllAPIs().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

