// Reminder schedule shared by the server (scheduler) and the browser (display).
// Dates are 'YYYY-MM-DD' and times 'HH:MM' in the family's local time zone.

export const TYPES = ['Event', 'Assignment', 'Meeting', 'Task'];

export const REMINDERS = [
  { key: '3d', label: '3 days before' },
  { key: '1d', label: 'Evening before' },
  { key: 'am', label: 'Morning of' },
  { key: '1h', label: '1 hour before' },
];

const DEFAULTS = {
  Event: ['1d', 'am'],
  Assignment: ['3d', '1d', 'am'],
  Meeting: ['1d', '1h'],
  Task: ['1d', 'am'],
};

export const EVENING_HOUR = 19; // 7:00 PM
export const MORNING_HOUR = 7; //  7:00 AM

export function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

export function toYmd(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function defaultReminders(type, time) {
  let r = (DEFAULTS[type] || DEFAULTS.Event).slice();
  if (!time) {
    r = r.filter((k) => k !== '1h');
    if (!r.includes('am')) r.push('am');
  }
  return r;
}

/** When reminder `key` fires for an item, or null if it can't (e.g. 1h with no time). */
export function reminderAt(item, key) {
  if (!item.date) return null;
  let b = parseYmd(item.date);
  switch (key) {
    case '3d':
      b = addDays(b, -3);
      b.setHours(EVENING_HOUR, 0, 0, 0);
      return b;
    case '1d':
      b = addDays(b, -1);
      b.setHours(EVENING_HOUR, 0, 0, 0);
      return b;
    case 'am':
      b.setHours(MORNING_HOUR, 0, 0, 0);
      return b;
    case '1h': {
      if (!item.time) return null;
      const [h, m] = item.time.split(':').map(Number);
      b.setHours(h - 1, m, 0, 0);
      return b;
    }
    default:
      return null;
  }
}

/** Upcoming reminder times for an item, soonest first. */
export function upcomingReminders(item, now = new Date()) {
  if (item.done) return [];
  return (item.rem || [])
    .map((k) => reminderAt(item, k))
    .filter((t) => t && t > now)
    .sort((a, b) => a - b);
}

export function daysFromToday(ymd, now = new Date()) {
  return Math.round((parseYmd(ymd) - startOfDay(now)) / 864e5);
}
