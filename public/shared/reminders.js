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

// Custom reminders are stored as 'c:YYYY-MM-DDTHH:MM' (local time).
export const CUSTOM_RX = /^c:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export const MAX_CUSTOM = 10;
export const isCustom = (key) => CUSTOM_RX.test(key);
export const customKey = (ymd, hm) => `c:${ymd}T${hm}`;
export const isValidKey = (key) => REMINDERS.some((r) => r.key === key) || isCustom(key) || RECUR_RX.test(key);

/** When reminder `key` fires for an item, or null if it can't (e.g. 1h with no time). */
export function reminderAt(item, key) {
  const c = CUSTOM_RX.exec(key);
  if (c) return new Date(+c[1], +c[2] - 1, +c[3], +c[4], +c[5], 0, 0);
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
    .map((k) => (RECUR_RX.test(k) ? nextOccurrence(k, now) : reminderAt(item, k)))
    .filter((t) => t && t > now)
    .sort((a, b) => a - b);
}

export function daysFromToday(ymd, now = new Date()) {
  return Math.round((parseYmd(ymd) - startOfDay(now)) / 864e5);
}

// ---------- Recurring reminders ----------
// Stored in item.rem as 'r:<freq>@HH:MM[~days][|until]'
//   r:daily@19:00              every day at 7 PM, until the item is done
//   r:weekdays@07:30           Monday–Friday at 7:30 AM
//   r:weekly@19:00~1,3         every Monday and Wednesday at 7 PM
//   r:daily@19:00|2026-12-01   …until 1 Dec 2026 (inclusive)
export const RECUR_RX = /^r:(daily|weekdays|weekly)@([01]\d|2[0-3]):([0-5]\d)(?:~([0-6](?:,[0-6]){0,6}))?(?:\|(\d{4}-\d{2}-\d{2}))?$/;
export const MAX_RECURRING = 5;
export const isRecurring = (key) => RECUR_RX.test(key);
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseRecurring(key) {
  const m = RECUR_RX.exec(key);
  if (!m) return null;
  const days = m[4] ? [...new Set(m[4].split(',').map(Number))].sort() : null;
  return { freq: m[1], h: +m[2], min: +m[3], days, until: m[5] || null };
}

export function recurringKey({ freq, time, days = [], until = '' }) {
  let k = `r:${freq}@${time}`;
  if (freq === 'weekly') k += '~' + [...new Set(days)].sort().join(',');
  if (until) k += '|' + until;
  return k;
}

function occursOn(r, d) {
  const wd = d.getDay();
  if (r.freq === 'daily') return true;
  if (r.freq === 'weekdays') return wd >= 1 && wd <= 5;
  return !!r.days && r.days.includes(wd);
}

/** First occurrence strictly after `after`, or null when the rule has ended. */
export function nextOccurrence(key, after = new Date()) {
  const r = parseRecurring(key);
  if (!r) return null;
  const base = startOfDay(after);
  for (let i = 0; i < 15; i++) {
    const day = addDays(base, i);
    if (r.until && toYmd(day) > r.until) return null;
    if (!occursOn(r, day)) continue;
    const t = new Date(day);
    t.setHours(r.h, r.min, 0, 0);
    if (t > after) return t;
  }
  return null;
}

/** Latest occurrence at or before `at` (looking back up to a week), or null. */
export function lastOccurrence(key, at = new Date()) {
  const r = parseRecurring(key);
  if (!r) return null;
  const base = startOfDay(at);
  for (let i = 0; i < 8; i++) {
    const day = addDays(base, -i);
    if (!occursOn(r, day)) continue;
    if (r.until && toYmd(day) > r.until) continue;
    const t = new Date(day);
    t.setHours(r.h, r.min, 0, 0);
    if (t <= at) return t;
  }
  return null;
}

export function describeRecurring(key) {
  const r = parseRecurring(key);
  if (!r) return '';
  const time = `${(r.h % 12) || 12}:${pad(r.min)} ${r.h >= 12 ? 'PM' : 'AM'}`;
  const what = r.freq === 'daily' ? 'Every day' : r.freq === 'weekdays' ? 'Weekdays (Mon–Fri)' : 'Every ' + (r.days || []).map((d) => DAY_SHORT[d]).join(', ');
  let until = 'until done';
  if (r.until) {
    const u = parseYmd(r.until);
    until = `until ${u.getDate()} ${MON_SHORT[u.getMonth()]}`;
  }
  return `${what} at ${time}, ${until}`;
}
