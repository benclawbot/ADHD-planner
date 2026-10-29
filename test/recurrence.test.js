import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeeklyRecurrence,
  getCalendarDateForInstant,
  getWeeklyWindowForDate,
  getWeeklyWindowForInstant,
  listWeeklyOccurrences,
  recordWeeklyCompletion,
  validateWeeklyRecurrence,
} from '../src/recurrence.js';

const mondayRecurrence = () => createWeeklyRecurrence({
  timeZone: 'America/New_York',
  weekStartsOn: 1,
  startsOn: '2026-10-26',
});

test('weekly recurrence requires explicit zone, first window date, and weekday', () => {
  const recurrence = mondayRecurrence();
  assert.deepEqual(recurrence, {
    cadence: 'weekly',
    timeZone: 'America/New_York',
    weekStartsOn: 1,
    startsOn: '2026-10-26',
  });
  assert.deepEqual(validateWeeklyRecurrence(recurrence), []);
  assert.throws(() => createWeeklyRecurrence({ timeZone: 'Mars/Olympus', weekStartsOn: 1, startsOn: '2026-10-26' }), /IANA time zone/);
  assert.throws(() => createWeeklyRecurrence({ timeZone: 'UTC', weekStartsOn: 1, startsOn: '2026-10-27' }), /first day/);
  assert.throws(() => createWeeklyRecurrence({ timeZone: 'UTC', weekStartsOn: 1 }), /startsOn/);
});

test('calendar-date windows honor a configurable week start without using host-local dates', () => {
  const sundayRecurrence = createWeeklyRecurrence({
    timeZone: 'Pacific/Auckland',
    weekStartsOn: 0,
    startsOn: '2026-11-01',
  });
  assert.deepEqual(getWeeklyWindowForDate(sundayRecurrence, '2026-11-04'), {
    startDate: '2026-11-01',
    endDate: '2026-11-07',
  });
  assert.throws(() => getWeeklyWindowForDate(sundayRecurrence, '2026-02-30'), /valid YYYY-MM-DD/);
  assert.throws(() => getWeeklyWindowForDate(sundayRecurrence, '2026-11-04T00:00:00'), /valid YYYY-MM-DD/);
});

test('instants are assigned to windows using the named zone across midnight and DST', () => {
  const recurrence = mondayRecurrence();
  assert.equal(getCalendarDateForInstant('2026-11-02T00:30:00Z', recurrence.timeZone), '2026-11-01');
  assert.deepEqual(getWeeklyWindowForInstant(recurrence, '2026-11-02T00:30:00Z'), {
    startDate: '2026-10-26',
    endDate: '2026-11-01',
  });
  assert.deepEqual(getWeeklyWindowForInstant(recurrence, '2026-11-02T05:30:00Z'), {
    startDate: '2026-11-02',
    endDate: '2026-11-08',
  });
  assert.equal(getCalendarDateForInstant('2026-03-08T07:30:00Z', 'America/New_York'), '2026-03-08');
  assert.throws(() => getCalendarDateForInstant('2026-11-02T00:30:00', recurrence.timeZone), /explicit UTC offset/);
});

test('one completion is accepted per weekly window and caller data is not mutated', () => {
  const recurrence = mondayRecurrence();
  const prior = [{ windowStart: '2026-10-26', completedAt: '2026-10-27T13:00:00Z' }];
  const second = recordWeeklyCompletion(recurrence, prior, '2026-11-03T15:00:00-05:00');
  assert.equal(second.added, true);
  assert.equal(second.completion.windowStart, '2026-11-02');
  assert.equal(second.completion.completedAt, '2026-11-03T20:00:00.000Z');
  assert.equal(prior.length, 1);

  const duplicate = recordWeeklyCompletion(recurrence, second.completions, '2026-11-08T23:00:00-05:00');
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, 'already-completed');
  assert.equal(duplicate.completion.completedAt, second.completion.completedAt);
  assert.equal(duplicate.completions.length, 2);

  const beforeStart = recordWeeklyCompletion(recurrence, [], '2026-10-26T03:00:00Z');
  assert.equal(beforeStart.added, false);
  assert.equal(beforeStart.reason, 'before-start');
  assert.deepEqual(beforeStart.completions, []);
});

test('past incomplete windows remain in history without a streak or penalty field', () => {
  const recurrence = mondayRecurrence();
  const recorded = recordWeeklyCompletion(recurrence, [], '2026-11-03T15:00:00-05:00');
  const occurrences = listWeeklyOccurrences(recurrence, '2026-11-16', recorded.completions);
  assert.deepEqual(occurrences.map(({ startDate, endDate, completed, isPast, isCurrent }) => ({
    startDate, endDate, completed, isPast, isCurrent,
  })), [
    { startDate: '2026-10-26', endDate: '2026-11-01', completed: false, isPast: true, isCurrent: false },
    { startDate: '2026-11-02', endDate: '2026-11-08', completed: true, isPast: false, isCurrent: false },
    { startDate: '2026-11-09', endDate: '2026-11-15', completed: false, isPast: true, isCurrent: false },
    { startDate: '2026-11-16', endDate: '2026-11-22', completed: false, isPast: false, isCurrent: true },
  ]);
  assert.equal(occurrences[1].completedAt, '2026-11-03T20:00:00.000Z');
  assert.ok(occurrences.every((occurrence) => !('streak' in occurrence) && !('penalty' in occurrence)));
  assert.deepEqual(listWeeklyOccurrences(recurrence, '2026-10-25'), []);
  assert.throws(() => listWeeklyOccurrences(recurrence), /throughDate/);
});

test('completion records require an explicit valid window and instant', () => {
  const recurrence = mondayRecurrence();
  assert.throws(() => recordWeeklyCompletion(recurrence, {}, '2026-11-03T15:00:00Z'), /array/);
  assert.throws(() => recordWeeklyCompletion(recurrence, [], '2026-11-03T15:00:00'), /explicit UTC offset/);
  assert.throws(() => listWeeklyOccurrences(recurrence, '2026-11-16', [{ windowStart: 'bad', completedAt: '2026-11-03T15:00:00Z' }]), /windowStart/);
});
