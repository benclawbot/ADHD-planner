const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/i;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Pure, zone-explicit calculations shared by the Today and Week planning views.
 * Dates are calendar dates in the supplied IANA zone. Task start times are
 * local wall times; ambiguous fall-back times resolve to the earlier instant
 * unless a caller explicitly asks for the later instant.
 */

export function isValidPlanningDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isValidPlanningTime(value, { allowEndOfDay = false } = {}) {
  if (typeof value !== 'string') return false;
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return (hour < 24 && minute < 60) || (allowEndOfDay && hour === 24 && minute === 0);
}

export function isValidPlanningTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a local date and wall time to an instant. `ambiguous` is true during
 * a fall-back fold. `disambiguation` may be `earlier`, `later`, or `reject`.
 * A time skipped by a spring-forward transition throws instead of being moved.
 */
export function resolveLocalDateTime(date, time, timeZone, { disambiguation = 'earlier' } = {}) {
  assertDate(date, 'date');
  assertTime(time, 'time');
  assertTimeZone(timeZone);
  assertDisambiguation(disambiguation);
  const candidates = localTimeCandidates(date, time, timeZone);
  if (!candidates.length) throw new RangeError(`${date} ${time} does not exist in ${timeZone} because of a time-zone transition.`);
  if (candidates.length > 1 && disambiguation === 'reject') {
    throw new RangeError(`${date} ${time} is ambiguous in ${timeZone}; choose earlier or later.`);
  }
  const instant = disambiguation === 'later' ? candidates.at(-1) : candidates[0];
  return {
    date,
    time,
    timeZone,
    instant: new Date(instant),
    instantIso: new Date(instant).toISOString(),
    ambiguous: candidates.length > 1,
    candidates: candidates.map((candidate) => new Date(candidate).toISOString()),
  };
}

/** Return actual instants at the boundaries of a local calendar day. */
export function getLocalDayRange(date, timeZone) {
  assertDate(date, 'date');
  assertTimeZone(timeZone);
  return makeTimeRange(date, '00:00', addDays(date, 1), '00:00', timeZone, {
    startBoundary: true,
    endBoundary: true,
  });
}

/**
 * Resolve a same-day local time range. `24:00` is accepted only as the end and
 * means midnight at the start of the next local day. The earlier occurrence
 * is used for an ambiguous start; the later occurrence is used for an
 * ambiguous end so the full repeated wall-time range is represented.
 */
export function getLocalTimeRange(date, startTime, endTime, timeZone) {
  assertDate(date, 'date');
  assertTime(startTime, 'startTime');
  if (!isValidPlanningTime(endTime, { allowEndOfDay: true })) {
    throw new TypeError('endTime must be a valid HH:mm time or 24:00.');
  }
  assertTimeZone(timeZone);
  let endDate = date;
  let normalizedEndTime = endTime;
  if (endTime === '24:00') {
    endDate = addDays(date, 1);
    normalizedEndTime = '00:00';
  } else if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    throw new RangeError('endTime must be later than startTime within the selected local day.');
  }
  return makeTimeRange(date, startTime, endDate, normalizedEndTime, timeZone, {
    startBoundary: startTime === '00:00',
    endBoundary: endTime === '24:00',
  });
}

/** Validate a task against this planner's date, time, and duration rules. */
export function validatePlanningTask(task, { timeZone } = {}) {
  const errors = [];
  const warnings = [];
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { valid: false, errors: ['task must be an object.'], warnings };
  }
  if (task.scheduledDate != null && task.scheduledDate !== '' && !isValidPlanningDate(task.scheduledDate)) {
    errors.push('scheduledDate must be empty or a valid YYYY-MM-DD calendar date.');
  }
  if (task.startTime != null && task.startTime !== '' && !isValidPlanningTime(task.startTime)) {
    errors.push('startTime must be empty or a valid HH:mm local time.');
  }
  if (task.durationMinutes != null
    && (!Number.isInteger(task.durationMinutes) || task.durationMinutes < 0 || task.durationMinutes > 1440)) {
    errors.push('durationMinutes must be an integer from 0 through 1440.');
  }
  if (task.startTime && !task.scheduledDate) errors.push('startTime requires a scheduledDate.');

  if (!errors.length && task.scheduledDate && task.startTime && Number(task.durationMinutes ?? 0) > 0 && timeZone) {
    if (!isValidPlanningTimeZone(timeZone)) errors.push('timeZone must be a valid IANA time zone.');
    else {
      try {
        const resolved = resolveLocalDateTime(task.scheduledDate, task.startTime, timeZone);
        if (resolved.ambiguous) warnings.push('startTime occurs twice during a fall-back transition; the earlier instant is used.');
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Calculate one day's schedule. Geometry uses elapsed instants, not guessed
 * wall-clock minutes, so DST days scale to 23 or 25 actual hours. By default
 * the visible timeline follows the approved reference's 09:00–19:00 range.
 */
export function buildDayPlan(tasks, date, {
  timeZone,
  timelineStart = '09:00',
  timelineEnd = '19:00',
  now = new Date(),
  currentTaskId = null,
} = {}) {
  assertTasks(tasks);
  assertDate(date, 'date');
  assertTimeZone(timeZone);
  const instantNow = parseInstant(now, 'now');
  const dayRange = getLocalDayRange(date, timeZone);
  const timelineRange = getLocalTimeRange(date, timelineStart, timelineEnd, timeZone);
  const scheduledTasks = [];
  const untimedTasks = [];
  const invalidTasks = [];
  const timed = [];
  const allTimed = [];

  for (const task of tasks) {
    if (!task || task.status === 'removed' || task.scheduledDate !== date) continue;
    const validation = validatePlanningTask(task, { timeZone });
    if (!validation.valid) {
      invalidTasks.push({ task, errors: validation.errors, warnings: validation.warnings });
      continue;
    }
    scheduledTasks.push(task);
    if (!task.startTime || Number(task.durationMinutes ?? 0) === 0) {
      untimedTasks.push(task);
      continue;
    }
    const resolvedStart = resolveLocalDateTime(date, task.startTime, timeZone);
    const rawStart = resolvedStart.instant.getTime();
    const rawEnd = rawStart + Number(task.durationMinutes) * MINUTE_MS;
    const rawEntry = {
      task,
      startAt: new Date(rawStart).toISOString(),
      endAt: new Date(rawEnd).toISOString(),
      startInstant: rawStart,
      endInstant: rawEnd,
      ambiguousStartTime: resolvedStart.ambiguous,
    };
    allTimed.push(rawEntry);
    const visibleStart = Math.max(rawStart, timelineRange.start.getTime());
    const visibleEnd = Math.min(rawEnd, timelineRange.end.getTime());
    if (visibleEnd <= visibleStart) continue;
    timed.push({
      ...rawEntry,
      visibleStart,
      visibleEnd,
      clippedStart: visibleStart > rawStart,
      clippedEnd: visibleEnd < rawEnd,
    });
  }

  const durationMs = timelineRange.end.getTime() - timelineRange.start.getTime();
  const toGeometry = (start, end) => ({
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    startOffsetMinutes: (start - timelineRange.start.getTime()) / MINUTE_MS,
    endOffsetMinutes: (end - timelineRange.start.getTime()) / MINUTE_MS,
    durationMinutes: (end - start) / MINUTE_MS,
    topFraction: (start - timelineRange.start.getTime()) / durationMs,
    heightFraction: (end - start) / durationMs,
  });
  const items = timed
    .sort((a, b) => a.visibleStart - b.visibleStart || a.visibleEnd - b.visibleEnd || compareId(a.task, b.task))
    .map((entry) => {
      const geometry = toGeometry(entry.visibleStart, entry.visibleEnd);
      return {
        task: entry.task,
        title: String(entry.task.title ?? ''),
        actualStartAt: entry.startAt,
        actualEndAt: entry.endAt,
        ambiguousStartTime: entry.ambiguousStartTime,
        clippedStart: entry.clippedStart,
        clippedEnd: entry.clippedEnd,
        ...geometry,
        durationMinutes: Number(entry.task.durationMinutes),
        visibleDurationMinutes: geometry.durationMinutes,
      };
    });
  const busyRanges = mergeIntervals(timed.map(({ visibleStart, visibleEnd }) => [visibleStart, visibleEnd]));
  const gaps = complementIntervals(busyRanges, timelineRange.start.getTime(), timelineRange.end.getTime())
    .map(([start, end]) => toGeometry(start, end));
  const overlaps = overlapSegments(timed, toGeometry);
  const currentTask = selectCurrentTask(tasks, instantNow, { timeZone, currentTaskId });
  const upcomingTasks = allTimed
    .filter((entry) => entry.task.status === 'open' && entry.startInstant > instantNow.getTime())
    .sort((a, b) => a.startInstant - b.startInstant || compareId(a.task, b.task))
    .map((entry) => entry.task);
  const visibleIds = new Set(timed.map(({ task }) => task.id));
  const offTimelineTasks = allTimed
    .filter(({ task }) => !visibleIds.has(task.id))
    .map(({ task, startAt, endAt, ambiguousStartTime }) => ({ task, startAt, endAt, ambiguousStartTime }));

  return {
    date,
    timeZone,
    isToday: getCalendarDate(instantNow, timeZone) === date,
    dayRange,
    timelineRange,
    scheduledTasks,
    untimedTasks,
    invalidTasks,
    timedTasks: items,
    offTimelineTasks,
    gaps,
    overlaps,
    currentTask,
    upcomingTasks,
    busyMinutes: busyRanges.reduce((sum, [start, end]) => sum + (end - start) / MINUTE_MS, 0),
    bookedMinutes: allTimed.reduce((sum, entry) => sum + (entry.endInstant - entry.startInstant) / MINUTE_MS, 0),
    visibleBookedMinutes: items.reduce((sum, item) => sum + item.visibleDurationMinutes, 0),
    openMinutes: gaps.reduce((sum, gap) => sum + gap.durationMinutes, 0),
    timelineMinutes: durationMs / MINUTE_MS,
  };
}

/**
 * Choose a task whose real scheduled interval contains `now`. If multiple open
 * tasks overlap, an explicitly selected currentTaskId wins; otherwise the
 * latest-starting task wins, with ID as a stable final tie-breaker. There is
 * no fallback to an arbitrary task scheduled later in the day.
 */
export function selectCurrentTask(tasks, now, { timeZone, currentTaskId = null } = {}) {
  assertTasks(tasks);
  assertTimeZone(timeZone);
  const instantNow = parseInstant(now, 'now').getTime();
  const date = getCalendarDate(new Date(instantNow), timeZone);
  const active = [];
  for (const task of tasks) {
    if (!task || task.status !== 'open' || !task.startTime
      || (task.scheduledDate !== date && task.scheduledDate !== addDays(date, -1))) continue;
    const validation = validatePlanningTask(task, { timeZone });
    if (!validation.valid || Number(task.durationMinutes ?? 0) <= 0) continue;
    const start = resolveLocalDateTime(task.scheduledDate, task.startTime, timeZone).instant.getTime();
    const end = start + Number(task.durationMinutes) * MINUTE_MS;
    if (start <= instantNow && instantNow < end) active.push({ task, start });
  }
  if (!active.length) return null;
  const selected = active.find(({ task }) => task.id === currentTaskId);
  if (selected) return selected.task;
  active.sort((a, b) => b.start - a.start || compareId(a.task, b.task));
  return active[0].task;
}

/** Return seven local calendar days plus separate day-assigned and Later lists. */
export function buildWeekPlan(tasks, reference, {
  timeZone,
  weekStartsOn = 1,
  timelineStart = '09:00',
  timelineEnd = '19:00',
  now = new Date(),
} = {}) {
  assertTasks(tasks);
  assertTimeZone(timeZone);
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new TypeError('weekStartsOn must be an integer from 0 (Sunday) through 6 (Saturday).');
  }
  const anchorDate = parseCalendarReference(reference, timeZone);
  const instantNow = parseInstant(now, 'now');
  const todayDate = getCalendarDate(instantNow, timeZone);
  const startDate = startOfWeek(anchorDate, weekStartsOn);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(startDate, index));
  const days = dates.map((date, index) => ({
    ...buildDayPlan(tasks, date, { timeZone, timelineStart, timelineEnd, now: instantNow }),
    weekday: weekdayName(date),
    weekdayIndex: weekdayOf(date),
    dayIndex: index,
    isToday: date === todayDate,
  }));
  const visibleTasks = tasks.filter((task) => task && task.status !== 'removed');
  const flexibleTasks = visibleTasks.filter((task) => task.status === 'open'
    && !task.scheduledDate && (task.scheduleWindow === 'this-week' || task.recurrence));
  const laterTasks = visibleTasks.filter((task) => task.status === 'open'
    && !task.scheduledDate && !task.scheduleWindow && !task.recurrence);
  const completedTasks = visibleTasks.filter((task) => task.status === 'done');
  const invalidTasks = visibleTasks
    .map((task) => ({ task, validation: validatePlanningTask(task, { timeZone }) }))
    .filter(({ validation }) => !validation.valid)
    .map(({ task, validation }) => ({ task, errors: validation.errors, warnings: validation.warnings }));

  return {
    timeZone,
    weekStartsOn,
    anchorDate,
    todayDate,
    startDate,
    endDate: dates.at(-1),
    previousStartDate: addDays(startDate, -7),
    nextStartDate: addDays(startDate, 7),
    days,
    flexibleTasks,
    laterTasks,
    completedTasks,
    invalidTasks,
  };
}

function makeTimeRange(startDate, startTime, endDate, endTime, timeZone, { startBoundary = false, endBoundary = false } = {}) {
  const start = startBoundary
    ? resolveLocalDayBoundary(startDate, startTime, timeZone, 'earlier')
    : resolveLocalDateTime(startDate, startTime, timeZone, { disambiguation: 'earlier' }).instant;
  const end = endBoundary
    ? resolveLocalDayBoundary(endDate, endTime, timeZone, 'later')
    : resolveLocalDateTime(endDate, endTime, timeZone, { disambiguation: 'later' }).instant;
  if (end <= start) throw new RangeError('The resolved local time range must have positive duration.');
  const durationMinutes = (end.getTime() - start.getTime()) / MINUTE_MS;
  return {
    startDate,
    startTime,
    endDate,
    endTime,
    timeZone,
    start,
    end,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    durationMinutes,
  };
}

function localTimeCandidates(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = makeUtc(year, month, day, hour, minute);
  const offsets = sampleOffsets(target, timeZone);
  const candidates = [];
  for (const offset of offsets) {
    const instant = target - offset;
    const parts = zonedParts(instant, timeZone);
    if (parts.year === year && parts.month === month && parts.day === day
      && parts.hour === hour && parts.minute === minute) candidates.push(instant);
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}

function sampleOffsets(target, timeZone) {
  const offsets = new Set();
  // Sampling both sides of the target discovers the two offsets at a DST fold.
  for (let hours = -48; hours <= 48; hours += 6) offsets.add(offsetAt(target + hours * 60 * MINUTE_MS, timeZone));
  return offsets;
}

function resolveLocalDayBoundary(date, time, timeZone, disambiguation) {
  const exact = localTimeCandidates(date, time, timeZone);
  if (exact.length) return new Date(disambiguation === 'later' ? exact.at(-1) : exact[0]);

  // Some zones advance their clocks at midnight. A civil day still begins at
  // its first real local minute, so use the transition's forward boundary.
  const [year, month, day] = date.split('-').map(Number);
  const targetMinute = timeToMinutes(time);
  const target = makeUtc(year, month, day, ...time.split(':').map(Number));
  const forward = [];
  for (const offset of sampleOffsets(target, timeZone)) {
    const instant = target - offset;
    const parts = zonedParts(instant, timeZone);
    if (parts.year === year && parts.month === month && parts.day === day) {
      const localMinute = parts.hour * 60 + parts.minute;
      if (localMinute > targetMinute) forward.push({ instant, localMinute });
    }
  }
  forward.sort((a, b) => a.localMinute - b.localMinute || a.instant - b.instant);
  if (forward.length) return new Date(forward[0].instant);
  throw new RangeError(`${date} has no local ${time} boundary in ${timeZone}.`);
}

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute, second: fields.second };
}

function offsetAt(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  const localAsUtc = makeUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - Math.floor(instant / 1000) * 1000;
}

function parseInstant(value, name) {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return new Date(value.getTime());
    throw new TypeError(`${name} must be a valid Date or ISO timestamp with an explicit UTC offset.`);
  }
  if (typeof value !== 'string') throw new TypeError(`${name} must be a valid Date or ISO timestamp with an explicit UTC offset.`);
  const match = INSTANT_PATTERN.exec(value);
  if (!match || !isValidPlanningDate(match[1])) throw new TypeError(`${name} must be a valid Date or ISO timestamp with an explicit UTC offset.`);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  const offset = match[6];
  if (hour > 23 || minute > 59 || second > 59
    || (offset.toUpperCase() !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))) {
    throw new TypeError(`${name} must be a valid Date or ISO timestamp with an explicit UTC offset.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be a valid Date or ISO timestamp with an explicit UTC offset.`);
  return new Date(milliseconds);
}

function getCalendarDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${String(fields.year).padStart(4, '0')}-${fields.month}-${fields.day}`;
}

function parseCalendarReference(reference, timeZone) {
  if (isValidPlanningDate(reference)) return reference;
  return getCalendarDate(parseInstant(reference, 'reference'), timeZone);
}

function mergeIntervals(intervals) {
  const sorted = intervals.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || interval[0] > last[1]) merged.push(interval);
    else last[1] = Math.max(last[1], interval[1]);
  }
  return merged;
}

function complementIntervals(intervals, start, end) {
  const result = [];
  let cursor = start;
  for (const [busyStart, busyEnd] of intervals) {
    if (busyStart > cursor) result.push([cursor, busyStart]);
    cursor = Math.max(cursor, busyEnd);
  }
  if (cursor < end) result.push([cursor, end]);
  return result;
}

function overlapSegments(entries, toGeometry) {
  const points = [...new Set(entries.flatMap(({ visibleStart, visibleEnd }) => [visibleStart, visibleEnd]))].sort((a, b) => a - b);
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const taskIds = entries
      .filter((entry) => entry.visibleStart < end && entry.visibleEnd > start)
      .map((entry) => String(entry.task.id ?? entry.task.title ?? ''))
      .sort();
    if (taskIds.length < 2) continue;
    const previous = segments.at(-1);
    if (previous && previous.end === start && previous.taskIds.join('\0') === taskIds.join('\0')) previous.end = end;
    else segments.push({ start, end, taskIds });
  }
  return segments.map((segment) => ({ taskIds: segment.taskIds, ...toGeometry(segment.start, segment.end) }));
}

function assertTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array.');
}

function assertDate(date, name) {
  if (!isValidPlanningDate(date)) throw new TypeError(`${name} must be a valid YYYY-MM-DD calendar date.`);
}

function assertTime(time, name) {
  if (!isValidPlanningTime(time)) throw new TypeError(`${name} must be a valid HH:mm local time.`);
}

function assertTimeZone(timeZone) {
  if (!isValidPlanningTimeZone(timeZone)) throw new TypeError('timeZone must be a valid IANA time zone.');
}

function assertDisambiguation(disambiguation) {
  if (!['earlier', 'later', 'reject'].includes(disambiguation)) {
    throw new TypeError('disambiguation must be earlier, later, or reject.');
  }
}

function timeToMinutes(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function makeUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const value = new Date(0);
  value.setUTCHours(hour, minute, second, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value.getTime();
}

function dayNumber(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(makeUtc(year, month, day) / DAY_MS);
}

function dateFromDayNumber(number) {
  const date = new Date(number * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(date, delta) {
  return dateFromDayNumber(dayNumber(date) + delta);
}

function weekdayOf(date) {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

function startOfWeek(date, weekStartsOn) {
  return addDays(date, -((weekdayOf(date) - weekStartsOn + 7) % 7));
}

function weekdayName(date) {
  return new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(new Date(makeUtc(...date.split('-').map(Number), 12)));
}

function compareId(left, right) {
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}
