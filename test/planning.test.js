import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDayPlan,
  buildWeekPlan,
  getLocalDayRange,
  getLocalTimeRange,
  isValidPlanningDate,
  isValidPlanningTime,
  resolveLocalDateTime,
  selectCurrentTask,
  validatePlanningTask,
} from '../src/planning.js';

const zone = 'America/New_York';
const day = '2026-10-29';

test('local calendar days use zone boundaries and reflect 23- and 25-hour DST days', () => {
  const spring = getLocalDayRange('2026-03-08', zone);
  const fall = getLocalDayRange('2026-11-01', zone);

  assert.equal(spring.startAt, '2026-03-08T05:00:00.000Z');
  assert.equal(spring.endAt, '2026-03-09T04:00:00.000Z');
  assert.equal(spring.durationMinutes, 23 * 60);
  assert.equal(fall.startAt, '2026-11-01T04:00:00.000Z');
  assert.equal(fall.endAt, '2026-11-02T05:00:00.000Z');
  assert.equal(fall.durationMinutes, 25 * 60);

  const midnightShift = getLocalDayRange('2018-11-04', 'America/Sao_Paulo');
  assert.equal(midnightShift.startAt, '2018-11-04T03:00:00.000Z', 'a midnight clock jump begins at the first real local time');
  assert.equal(midnightShift.durationMinutes, 23 * 60);
  assert.equal(getLocalTimeRange('2018-11-04', '00:00', '24:00', 'America/Sao_Paulo').durationMinutes, 23 * 60);
  assert.throws(() => getLocalDayRange('2011-12-30', 'Pacific/Apia'), /no local 00:00 boundary/, 'a skipped civil date has no fabricated interval');
});

test('local range boundaries account for DST gaps and repeated wall times', () => {
  const springRange = getLocalTimeRange('2026-03-08', '01:30', '03:30', zone);
  const fallRange = getLocalTimeRange('2026-11-01', '01:00', '02:00', zone);
  const ambiguous = resolveLocalDateTime('2026-11-01', '01:30', zone);

  assert.equal(springRange.durationMinutes, 60, 'the skipped spring hour is not counted as elapsed time');
  assert.equal(fallRange.durationMinutes, 120, 'the repeated fall hour is counted in the real interval');
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.candidates, ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.equal(resolveLocalDateTime('2026-11-01', '01:30', zone, { disambiguation: 'later' }).instantIso, '2026-11-01T06:30:00.000Z');
  assert.throws(() => resolveLocalDateTime('2026-11-01', '01:30', zone, { disambiguation: 'reject' }), /ambiguous/);
  assert.throws(() => resolveLocalDateTime('2026-03-08', '02:30', zone), /does not exist/);
});

test('timeline geometry follows task instants and returns open gaps and overlaps', () => {
  const tasks = [
    { id: 'first', title: 'First', scheduledDate: day, startTime: '09:00', durationMinutes: 60, status: 'open' },
    { id: 'second', title: 'Second', scheduledDate: day, startTime: '11:00', durationMinutes: 60, status: 'open' },
    { id: 'third', title: 'Third', scheduledDate: day, startTime: '11:30', durationMinutes: 60, status: 'open' },
  ];
  const plan = buildDayPlan(tasks, day, {
    timeZone: zone,
    timelineStart: '09:00',
    timelineEnd: '19:00',
    now: '2026-10-29T15:45:00Z',
  });

  assert.equal(plan.timelineMinutes, 600);
  assert.equal(plan.timedTasks.length, 3);
  assert.equal(plan.timedTasks[0].startAt, '2026-10-29T13:00:00.000Z');
  assert.equal(plan.timedTasks[0].endAt, '2026-10-29T14:00:00.000Z');
  assert.equal(plan.timedTasks[0].topFraction, 0);
  assert.equal(plan.timedTasks[0].heightFraction, 0.1);
  assert.equal(plan.busyMinutes, 150, 'overlap is counted once for occupied time');
  assert.equal(plan.bookedMinutes, 180, 'booked time retains each task duration');
  assert.equal(plan.openMinutes, 450);
  assert.deepEqual(plan.gaps.map(({ startOffsetMinutes, endOffsetMinutes }) => [startOffsetMinutes, endOffsetMinutes]), [[60, 120], [210, 600]]);
  assert.deepEqual(plan.overlaps.map(({ taskIds, startOffsetMinutes, endOffsetMinutes }) => ({ taskIds, startOffsetMinutes, endOffsetMinutes })), [
    { taskIds: ['second', 'third'], startOffsetMinutes: 150, endOffsetMinutes: 180 },
  ]);
});

test('current selection uses active time windows, respects an explicit overlap selection, and has no arbitrary fallback', () => {
  const tasks = [
    { id: 'earlier', title: 'Earlier', scheduledDate: day, startTime: '11:00', durationMinutes: 90, status: 'open' },
    { id: 'later', title: 'Later', scheduledDate: day, startTime: '11:30', durationMinutes: 60, status: 'open' },
    { id: 'done', title: 'Done', scheduledDate: day, startTime: '11:00', durationMinutes: 120, status: 'done' },
    { id: 'untimed', title: 'Untimed', scheduledDate: day, startTime: '', durationMinutes: 0, status: 'open' },
    { id: 'tomorrow', title: 'Tomorrow', scheduledDate: '2026-10-30', startTime: '11:00', durationMinutes: 60, status: 'open' },
  ];
  const now = '2026-10-29T15:45:00Z';

  assert.equal(selectCurrentTask(tasks, now, { timeZone: zone }).id, 'later', 'the most recently started active task wins by default');
  assert.equal(selectCurrentTask(tasks, now, { timeZone: zone, currentTaskId: 'earlier' }).id, 'earlier');
  assert.equal(selectCurrentTask(tasks, '2026-10-29T18:00:00Z', { timeZone: zone }), null);
  assert.equal(selectCurrentTask(tasks, '2026-10-29T15:45:00Z', { timeZone: 'UTC' }), null, 'zone-local date controls eligibility');
});

test('day-assigned untimed tasks stay separate from timed tasks and Later tasks', () => {
  const tasks = [
    { id: 'timed', title: 'Timed', scheduledDate: '2026-10-28', startTime: '10:00', durationMinutes: 45, status: 'open' },
    { id: 'untimed', title: 'Untimed today', scheduledDate: '2026-10-28', startTime: '', durationMinutes: 0, status: 'open' },
    { id: 'later', title: 'Later', scheduledDate: '', startTime: '', durationMinutes: 0, status: 'open' },
    { id: 'flex', title: 'Flexible this week', scheduledDate: '', startTime: '', durationMinutes: 0, scheduleWindow: 'this-week', status: 'open' },
    { id: 'done', title: 'Finished', scheduledDate: '', startTime: '', durationMinutes: 0, status: 'done' },
  ];
  const week = buildWeekPlan(tasks, '2026-10-28', {
    timeZone: zone,
    weekStartsOn: 1,
    now: '2026-10-28T12:00:00-04:00',
  });
  const wednesday = week.days.find((entry) => entry.date === '2026-10-28');

  assert.equal(week.days.length, 7);
  assert.deepEqual([week.startDate, week.endDate, week.previousStartDate, week.nextStartDate], [
    '2026-10-26', '2026-11-01', '2026-10-19', '2026-11-02',
  ]);
  assert.equal(wednesday.weekday, 'Wednesday');
  assert.equal(wednesday.isToday, true);
  assert.deepEqual(wednesday.scheduledTasks.map((task) => task.id), ['timed', 'untimed']);
  assert.deepEqual(wednesday.timedTasks.map(({ task }) => task.id), ['timed']);
  assert.deepEqual(wednesday.untimedTasks.map((task) => task.id), ['untimed']);
  assert.deepEqual(week.laterTasks.map((task) => task.id), ['later']);
  assert.deepEqual(week.flexibleTasks.map((task) => task.id), ['flex']);
  assert.deepEqual(week.completedTasks.map((task) => task.id), ['done']);
});

test('week reference instants and Sunday starts produce local seven-day navigation windows', () => {
  const week = buildWeekPlan([], '2026-11-02T00:30:00Z', {
    timeZone: zone,
    weekStartsOn: 0,
    now: '2026-11-02T00:30:00Z',
  });
  assert.equal(week.anchorDate, '2026-11-01', 'the instant is converted to the planner zone first');
  assert.equal(week.startDate, '2026-11-01');
  assert.equal(week.endDate, '2026-11-07');
  assert.deepEqual(week.days.map(({ weekdayIndex }) => weekdayIndex), [0, 1, 2, 3, 4, 5, 6]);
});

test('visible timeline clips blocks without losing their actual interval or open time', () => {
  const tasks = [
    { id: 'before', title: 'Before range', scheduledDate: day, startTime: '08:30', durationMinutes: 60, status: 'open' },
    { id: 'late', title: 'Late range', scheduledDate: day, startTime: '18:30', durationMinutes: 120, status: 'open' },
    { id: 'outside', title: 'Outside range', scheduledDate: day, startTime: '20:00', durationMinutes: 30, status: 'open' },
  ];
  const plan = buildDayPlan(tasks, day, { timeZone: zone, now: '2026-10-29T12:00:00Z' });

  assert.deepEqual(plan.timedTasks.map(({ task, clippedStart, clippedEnd, durationMinutes, visibleDurationMinutes, actualEndAt }) => ({
    id: task.id, clippedStart, clippedEnd, durationMinutes, visibleDurationMinutes, actualEndAt,
  })), [
    { id: 'before', clippedStart: true, clippedEnd: false, durationMinutes: 60, visibleDurationMinutes: 30, actualEndAt: '2026-10-29T13:30:00.000Z' },
    { id: 'late', clippedStart: false, clippedEnd: true, durationMinutes: 120, visibleDurationMinutes: 30, actualEndAt: '2026-10-30T00:30:00.000Z' },
  ]);
  assert.equal(plan.openMinutes, 540);
  assert.equal(plan.bookedMinutes, 210, 'day total includes time outside the visible range');
  assert.equal(plan.visibleBookedMinutes, 60, 'visible geometry keeps clipped minutes separate');
});

test('off-timeline scheduled tasks remain available for upcoming selection', () => {
  const tasks = [
    { id: 'late', title: 'Late task', scheduledDate: day, startTime: '20:00', durationMinutes: 30, status: 'open' },
  ];
  const plan = buildDayPlan(tasks, day, { timeZone: zone, now: '2026-10-29T20:00:00Z' });
  assert.deepEqual(plan.timedTasks, []);
  assert.deepEqual(plan.offTimelineTasks.map(({ task }) => task.id), ['late']);
  assert.deepEqual(plan.upcomingTasks.map(({ id }) => id), ['late']);
});

test('a task started late on the previous day remains current while its real interval continues', () => {
  const task = { id: 'overnight', title: 'Overnight', scheduledDate: '2026-10-28', startTime: '23:30', durationMinutes: 120, status: 'open' };
  const now = '2026-10-29T04:00:00Z';
  assert.equal(selectCurrentTask([task], now, { timeZone: zone })?.id, 'overnight');
});

test('DST timeline uses actual elapsed instants and flags a repeated task start', () => {
  const springTask = { id: 'spring', title: 'Spring', scheduledDate: '2026-03-08', startTime: '01:30', durationMinutes: 60, status: 'open' };
  const spring = buildDayPlan([springTask], '2026-03-08', {
    timeZone: zone, timelineStart: '00:00', timelineEnd: '24:00', now: '2026-03-08T07:00:00Z',
  });
  assert.equal(spring.timelineMinutes, 1380);
  assert.equal(spring.timedTasks[0].actualStartAt, '2026-03-08T06:30:00.000Z');
  assert.equal(spring.timedTasks[0].actualEndAt, '2026-03-08T07:30:00.000Z');
  assert.equal(spring.timedTasks[0].startOffsetMinutes, 90);
  assert.equal(spring.timedTasks[0].durationMinutes, 60);

  const fallTask = { id: 'fall', title: 'Fall', scheduledDate: '2026-11-01', startTime: '01:30', durationMinutes: 60, status: 'open' };
  const fall = buildDayPlan([fallTask], '2026-11-01', {
    timeZone: zone, timelineStart: '00:00', timelineEnd: '24:00', now: '2026-11-01T08:00:00Z',
  });
  assert.equal(fall.timelineMinutes, 1500);
  assert.equal(fall.timedTasks[0].ambiguousStartTime, true);
  assert.equal(fall.timedTasks[0].actualStartAt, '2026-11-01T05:30:00.000Z');
});

test('task and range input validation rejects malformed, impossible, and out-of-range values', () => {
  assert.equal(isValidPlanningDate('2026-02-28'), true);
  assert.equal(isValidPlanningDate('2026-02-30'), false);
  assert.equal(isValidPlanningTime('23:59'), true);
  assert.equal(isValidPlanningTime('24:00'), false);
  assert.equal(validatePlanningTask({ scheduledDate: '2026-03-08', startTime: '02:30', durationMinutes: 30 }, { timeZone: zone }).valid, false);
  assert.match(validatePlanningTask({ scheduledDate: '2026-03-08', startTime: '02:30', durationMinutes: 30 }, { timeZone: zone }).errors[0], /does not exist/);
  assert.match(validatePlanningTask({ scheduledDate: '', startTime: '09:00' }).errors[0], /requires a scheduledDate/);
  assert.match(validatePlanningTask({ scheduledDate: day, startTime: '', durationMinutes: 1445 }).errors[0], /0 through 1440/);
  assert.throws(() => getLocalDayRange('2026-02-30', zone), /valid YYYY-MM-DD/);
  assert.throws(() => getLocalDayRange(day, 'Mars/Olympus'), /IANA time zone/);
  assert.throws(() => getLocalTimeRange(day, '19:00', '09:00', zone), /later than startTime/);
  assert.throws(() => getLocalTimeRange(day, '09:00', '24:30', zone), /24:00/);
  assert.throws(() => buildWeekPlan([], day, { timeZone: zone, weekStartsOn: 7 }), /weekStartsOn/);
  assert.throws(() => buildDayPlan({}, day, { timeZone: zone }), /tasks must be an array/);
});
