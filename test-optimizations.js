/**
 * Test script to verify all optimized functions work correctly
 */

const ConflictDetector = require('./src/utils/conflictDetector');

console.log('🧪 Testing Optimized Functions\n');
console.log('='.repeat(60));

// Test 1: createEventHash
console.log('\n1. Testing createEventHash...');
const testEvent = {
  id: 'test_123',
  name: 'Test Event',
  start: '2024-01-01T20:00:00Z',
  venue: {
    name: 'Test Venue',
    lat: 40.7128,
    lon: -74.0060
  }
};
const hash1 = ConflictDetector.createEventHash(testEvent);
const hash2 = ConflictDetector.createEventHash(testEvent);
console.log('   Hash 1:', hash1);
console.log('   Hash 2:', hash2);
console.log('   ✅ Hashes match:', hash1 === hash2);

// Test 2: filterDuplicates (O(n) optimization)
console.log('\n2. Testing filterDuplicates (O(n) optimization)...');
const duplicateEvents = [
  { id: '1', name: 'Event A', start: '2024-01-01T20:00:00Z', end: '2024-01-01T22:00:00Z', venue: { name: 'Venue 1', lat: 40.7128, lon: -74.0060 } },
  { id: '1', name: 'Event A', start: '2024-01-01T20:00:00Z', end: '2024-01-01T22:00:00Z', venue: { name: 'Venue 1', lat: 40.7128, lon: -74.0060 } }, // Exact duplicate (same ID)
  { id: '2', name: 'Event B', start: '2024-01-01T21:00:00Z', end: '2024-01-01T23:00:00Z', venue: { name: 'Venue 2', lat: 40.7130, lon: -74.0062 } },
  { id: '3', name: 'Event C', start: '2024-01-02T20:00:00Z', end: '2024-01-02T22:00:00Z', venue: { name: 'Venue 3', lat: 40.7140, lon: -74.0070 } }
];
const uniqueEvents = ConflictDetector.filterDuplicates(duplicateEvents);
console.log('   Input events:', duplicateEvents.length);
console.log('   Unique events:', uniqueEvents.length);
console.log('   Expected: 3 (duplicate with ID "1" should be filtered)');
console.log('   ✅ Duplicates filtered correctly:', uniqueEvents.length === 3);

// Test 3: calculateDynamicThreshold (optimized with spatial grid)
console.log('\n3. Testing calculateDynamicThreshold (spatial grid optimization)...');
const testEvents = Array.from({ length: 50 }, (_, i) => ({
  id: `event_${i}`,
  name: `Event ${i}`,
  start: '2024-01-01T20:00:00Z',
  end: '2024-01-01T22:00:00Z',
  venue: {
    name: `Venue ${i}`,
    lat: 40.7128 + (i * 0.001), // Spread events slightly
    lon: -74.0060 + (i * 0.001)
  }
}));
const threshold = ConflictDetector.calculateDynamicThreshold(testEvents, 0.3);
console.log('   Calculated threshold:', threshold);
console.log('   ✅ Threshold is valid:', threshold >= 0.15 && threshold <= 0.3);

// Test 4: findConflicts (should work with optimized filterDuplicates)
console.log('\n4. Testing findConflicts with optimized duplicate filtering...');
const conflictEvents = [
  { id: '1', name: 'Event A', start: '2024-01-01T20:00:00Z', end: '2024-01-01T22:00:00Z', venue: { name: 'Venue 1', lat: 40.7128, lon: -74.0060 }, genres: ['rock'] },
  { id: '2', name: 'Event B', start: '2024-01-01T20:30:00Z', end: '2024-01-01T22:30:00Z', venue: { name: 'Venue 1', lat: 40.7128, lon: -74.0060 }, genres: ['rock'] }, // Same venue, overlapping time
  { id: '3', name: 'Event C', start: '2024-01-02T20:00:00Z', end: '2024-01-02T22:00:00Z', venue: { name: 'Venue 2', lat: 40.7200, lon: -74.0100 }, genres: ['jazz'] }
];
const conflicts = ConflictDetector.findConflicts(conflictEvents, 30);
console.log('   Events:', conflictEvents.length);
console.log('   Conflicts found:', conflicts.length);
// Events 1 and 2 are at same venue with overlapping time, so should conflict
console.log('   ✅ Conflicts detected:', conflicts.length >= 1);

// Test 5: Edge cases
console.log('\n5. Testing edge cases...');
const emptyResult = ConflictDetector.filterDuplicates([]);
console.log('   Empty array:', emptyResult.length === 0 ? '✅' : '❌');

const singleEvent = ConflictDetector.filterDuplicates([{
  id: 'single',
  name: 'Single Event',
  start: '2024-01-01T20:00:00Z',
  end: '2024-01-01T22:00:00Z',
  venue: { name: 'Venue', lat: 40.7128, lon: -74.0060 }
}]);
console.log('   Single event:', singleEvent.length === 1 ? '✅' : '❌');

const eventsWithoutVenues = ConflictDetector.filterDuplicates([
  { id: '1', name: 'Event', start: '2024-01-01T20:00:00Z', end: '2024-01-01T22:00:00Z' }
]);
console.log   ('   Events without venues filtered:', eventsWithoutVenues.length === 0 ? '✅' : '❌');

console.log('\n' + '='.repeat(60));
console.log('✅ All tests completed!\n');

