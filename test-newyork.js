require('dotenv').config();
const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';

async function testNewYork() {
  console.log('\n' + '='.repeat(70));
  console.log('🌍 TESTING NEW YORK LOCATION');
  console.log('='.repeat(70));
  console.log('Coordinates: 40.7128, -74.0060');
  console.log('Radius: 25 miles\n');

  try {
    // Check API Keys
    console.log('📋 API Key Status:');
    console.log(`   Ticketmaster: ${process.env.TICKETMASTER_API_KEY ? '✅ SET (' + process.env.TICKETMASTER_API_KEY.length + ' chars)' : '❌ NOT SET'}`);
    console.log(`   Bandsintown: ${process.env.BANDSINTOWN_APP_ID || 'EventConflictFinder (default, no key required)'}`);
    console.log('');

    // Test Events Search
    console.log('🔍 Testing Events Search...');
    const eventsUrl = `${BASE_URL}/api/events/search?lat=40.7128&lon=-74.0060&radius=25`;
    const eventsResponse = await fetch(eventsUrl);
    
    if (!eventsResponse.ok) {
      console.log(`❌ Events Search Failed: ${eventsResponse.status}`);
      const errorText = await eventsResponse.text();
      console.log('Error:', errorText);
      return;
    }

    const eventsData = await eventsResponse.json();
    const totalEvents = eventsData.total || eventsData.events?.length || 0;
    
    console.log(`✅ Total Events Found: ${totalEvents}`);
    
    if (eventsData.sources) {
      console.log('\n   Source Breakdown:');
      Object.entries(eventsData.sources).forEach(([source, info]) => {
        const count = info.count || 0;
        const enabled = info.enabled ? 'enabled' : 'disabled';
        const success = info.success ? '✅' : '❌';
        console.log(`   ${success} ${source}: ${count} events (${enabled})`);
        if (info.error) {
          console.log(`      Error: ${info.error}`);
        }
      });
    }

    if (eventsData.events && eventsData.events.length > 0) {
      console.log('\n   Sample Events (first 5):');
      eventsData.events.slice(0, 5).forEach((event, index) => {
        console.log(`   ${index + 1}. ${event.name}`);
        console.log(`      Source: ${event.source} | Venue: ${event.venue?.name || 'N/A'}`);
        console.log(`      Time: ${new Date(event.start).toLocaleString()}`);
      });
    }

    // Test Conflict Detection
    console.log('\n' + '-'.repeat(70));
    console.log('🚨 Testing Conflict Detection...');
    
    if (totalEvents > 0) {
      const conflictsUrl = `${BASE_URL}/api/conflicts/location?lat=40.7128&lon=-74.0060&radius=25&timeBuffer=30`;
      const conflictsResponse = await fetch(conflictsUrl);
      
      if (conflictsResponse.ok) {
        const conflictsData = await conflictsResponse.json();
        const summary = conflictsData.summary || {};
        const conflictCount = summary.conflictCount || 0;
        const conflictRate = summary.conflictRate || '0%';
        
        console.log(`✅ Conflicts Detected: ${conflictCount}`);
        console.log(`   Conflict Rate: ${conflictRate}`);
        
        if (summary.sources) {
          console.log('\n   Events by Source:');
          Object.entries(summary.sources).forEach(([source, count]) => {
            console.log(`   - ${source}: ${count} events`);
          });
        }

        if (conflictsData.conflicts && conflictsData.conflicts.length > 0) {
          console.log('\n   Sample Conflicts (first 3):');
          conflictsData.conflicts.slice(0, 3).forEach((conflict, index) => {
            console.log(`   ${index + 1}. ${conflict.conflictType} (${conflict.severity} severity)`);
            console.log(`      Time: ${conflict.timeSlot}`);
            if (conflict.events && conflict.events.length >= 2) {
              console.log(`      Events: ${conflict.events[0].name} vs ${conflict.events[1].name}`);
            }
          });
        } else {
          console.log('   ✅ No conflicts detected');
        }
      } else {
        console.log(`❌ Conflict Detection Failed: ${conflictsResponse.status}`);
      }
    } else {
      console.log('   ⚠️  Skipping conflict detection (no events found)');
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ Test Complete!');
    console.log('='.repeat(70) + '\n');

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run test
testNewYork();

