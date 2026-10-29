const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/i;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Build a weekly recurrence whose first window begins on `startsOn`.
 *
 * `weekStartsOn` uses JavaScript's weekday numbering (Sunday = 0 ... Saturday = 6).
 * `timeZone` is an IANA time zone. Date-only arguments elsewhere in this module
 * are calendar dates in that zone; instants must carry an explicit UTC offset.
 */
export function createWeeklyRecurrence({ timeZone, weekStartsOn, startsOn } = {}) {
  const recurrence = { cadence: 'weekly', timeZone, weekStartsOn, startsOn };
  const errors = validateWeeklyRecurrence(recurrence);
  if (errors.length) throw new TypeError(errors.join(' '));
  return recurrence;
}

/** Return validation messages; an empty array means the recurrence is usable. */
export function validateWeeklyRecurrence(recurrence) {
  const errors = [];
  if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)) {
    return ['A weekly recurrence object is required.'];
  }
  if (recurrence.cadence !== 'weekly') errors.push('cadence must be "weekly".');
  if (!isValidTimeZone(recurrence.timeZone)) errors.push('timeZone must be a valid IANA time zone.');
  if (!Number.isInteger(recurrence.weekStartsOn) || recurrence.weekStartsOn < 0 || recurrence.weekStartsOn > 6) {
    errors.push('weekStartsOn must be an integer from 0 (Sunday) through 6 (Saturday).');
  }
  if (!isCalendarDate(recurrence.startsOn)) {
    errors.push('startsOn must be a valid YYYY-MM-DD calendar date.');
  } else if (Number.isInteger(recurrence.weekStartsOn) && recurrence.weekStartsOn >= 0 && recurrence.weekStartsOn <= 6) {
    const startWeekday = weekdayOf(recurrence.startsOn);
    if (startWeekday !== recurrence.weekStartsOn) {
      errors.push('startsOn must be the first day of a weekly window.');
    }
  }
  return errors;
}

/** Return the weekly window containing a date-only calendar date. */
export function getWeeklyWindowForDate(recurrence, date) {
  assertRecurrence(recurrence);
  assertCalendarDate(date, 'date');
  const startDate = startOfWeek(date, recurrence.weekStartsOn);
  return makeWindow(startDate);
}

/**
 * Return the weekly window containing an instant, using the recurrence's zone
 * to find its calendar date. The instant must be a Date or explicit-offset ISO
 * timestamp; a local datetime string is rejected as ambiguous.
 */
export function getWeeklyWindowForInstant(recurrence, instant) {
  assertRecurrence(recurrence);
  const date = getCalendarDateForInstant(instant, recurrence.timeZone);
  return getWeeklyWindowForDate(recurrence, date);
}

/** Convert an explicit instant to a YYYY-MM-DD date in an IANA time zone. */
export function getCalendarDateForInstant(instant, timeZone) {
  if (!isValidTimeZone(timeZone)) throw new TypeError('timeZone must be a valid IANA time zone.');
  const date = parseInstant(instant);
  if (!date) throw new TypeError('instant must be a valid Date or ISO timestamp with an explicit UTC offset.');
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${String(fields.year).padStart(4, '0')}-${fields.month}-${fields.day}`;
}

/**
 * Record a completion in its local weekly window. A second completion in the
 * same window is ignored. Results are immutable copies and no streak is kept.
 *
 * Completion records retain both the window start and the original instant so
 * history remains explicit if a caller later changes recurrence settings.
 */
export function recordWeeklyCompletion(recurrence, completions, completedAt) {
  assertRecurrence(recurrence);
  assertCompletionList(completions);
  const instant = parseInstant(completedAt);
  if (!instant) throw new TypeError('completedAt must be a valid Date or ISO timestamp with an explicit UTC offset.');
  const normalizedInstant = instant.toISOString();
  const window = getWeeklyWindowForInstant(recurrence, instant);

  if (window.startDate < recurrence.startsOn) {
    return { added: false, reason: 'before-start', completion: null, completions: [...completions] };
  }

  const existing = completions.find((completion) => completion.windowStart === window.startDate);
  if (existing) {
    return { added: false, reason: 'already-completed', completion: existing, completions: [...completions] };
  }

  const completion = { windowStart: window.startDate, completedAt: normalizedInstant };
  return { added: true, reason: null, completion, completions: [...completions, completion] };
}

/**
 * List every weekly window from startsOn through the supplied calendar date.
 * Past incomplete windows remain in the result with `isPast: true`; there is
 * deliberately no streak or penalty calculation. `throughDate` is required
 * so callers choose the calendar date and zone context explicitly.
 */
export function listWeeklyOccurrences(recurrence, throughDate, completions = []) {
  assertRecurrence(recurrence);
  assertCalendarDate(throughDate, 'throughDate');
  assertCompletionList(completions);
  const throughStart = startOfWeek(throughDate, recurrence.weekStartsOn);
  if (throughStart < recurrence.startsOn) return [];

  const completedByWindow = new Map();
  for (const completion of completions) {
    if (!isCalendarDate(completion.windowStart)) continue;
    if (!completedByWindow.has(completion.windowStart)) completedByWindow.set(completion.windowStart, completion);
  }

  const result = [];
  for (let startDate = recurrence.startsOn; startDate <= throughStart; startDate = addDays(startDate, 7)) {
    const endDate = addDays(startDate, 6);
    const completion = completedByWindow.get(startDate) ?? null;
    result.push({
      startDate,
      endDate,
      completed: completion !== null,
      completedAt: completion?.completedAt ?? null,
      isPast: endDate < throughDate && completion === null,
      isCurrent: startDate <= throughDate && throughDate <= endDate,
    });
  }
  return result;
}

function assertRecurrence(recurrence) {
  const errors = validateWeeklyRecurrence(recurrence);
  if (errors.length) throw new TypeError(errors.join(' '));
}

function assertCompletionList(completions) {
  if (!Array.isArray(completions)) throw new TypeError('completions must be an array.');
  for (const completion of completions) {
    if (!completion || typeof completion !== 'object' || !isCalendarDate(completion.windowStart)) {
      throw new TypeError('Each completion must have a valid windowStart calendar date.');
    }
    if (!parseInstant(completion.completedAt)) {
      throw new TypeError('Each completion must have a completedAt instant with an explicit UTC offset.');
    }
  }
}

function makeWindow(startDate) {
  return { startDate, endDate: addDays(startDate, 6) };
}

function startOfWeek(date, weekStartsOn) {
  const offset = (weekdayOf(date) - weekStartsOn + 7) % 7;
  return addDays(date, -offset);
}

function weekdayOf(date) {
  return new Date(dayNumber(date) * DAY_MILLISECONDS).getUTCDay();
}

function addDays(date, days) {
  return formatDayNumber(dayNumber(date) + days);
}

function dayNumber(date) {
  const match = DATE_PATTERN.exec(date);
  const [, year, month, day] = match;
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return Math.floor(value.getTime() / DAY_MILLISECONDS);
}

function formatDayNumber(number) {
  const date = new Date(number * DAY_MILLISECONDS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const valueDate = new Date(0);
  valueDate.setUTCHours(0, 0, 0, 0);
  valueDate.setUTCFullYear(year, month - 1, day);
  return valueDate.getUTCFullYear() === year
    && valueDate.getUTCMonth() === month - 1
    && valueDate.getUTCDate() === day;
}

function assertCalendarDate(value, name) {
  if (!isCalendarDate(value)) throw new TypeError(`${name} must be a valid YYYY-MM-DD calendar date.`);
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (typeof value !== 'string') return null;
  const match = INSTANT_PATTERN.exec(value);
  if (!match || !isCalendarDate(match[1])) return null;
  const [, , hour, minute, second = '0', , offset] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (offset.toUpperCase() !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}
