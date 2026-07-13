const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTimeToMinutes, calculateDurationFromTimeRange } = require('../activity');

test('parseTimeToMinutes parses HH:MM correctly', () => {
  assert.equal(parseTimeToMinutes('07:30'), 450);
  assert.equal(parseTimeToMinutes('9:05'), 545);
  assert.equal(parseTimeToMinutes('24:00'), null);
});

test('calculateDurationFromTimeRange returns positive duration', () => {
  assert.equal(calculateDurationFromTimeRange('07:30', '08:10'), 40);
  assert.equal(calculateDurationFromTimeRange('20:00', '21:30'), 90);
  assert.equal(calculateDurationFromTimeRange('09:00', '08:30'), 0);
});
