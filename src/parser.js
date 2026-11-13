// Rule-based extractor: the offline fallback when no ANTHROPIC_API_KEY is set
// or the Claude API call fails. Tuned for Indian school messages (day-first dates).
import { addDays, pad, toYmd, startOfDay } from '../public/shared/reminders.js';

const MONTH_RX =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function monthIndex(s) {
  return MONTHS.indexOf(s.slice(0, 3).toLowerCase());
}

function rollYear(today, m, d, y) {
  let dt = new Date(y || today.getFullYear(), m, d);
  // A date with no year that is well in the past most likely means next year.
  if (!y && dt < addDays(today, -30)) dt = new Date(today.getFullYear() + 1, m, d);
  return dt;
}

export function findDate(s, today) {
  let m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?' + MONTH_RX + '\\.?(?:,?\\s*(\\d{4}))?', 'i'));
  if (m) return { date: rollYear(today, monthIndex(m[2]), +m[1], m[3] ? +m[3] : 0), match: m[0] };
  m = s.match(new RegExp('\\b' + MONTH_RX + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?', 'i'));
  if (m) return { date: rollYear(today, monthIndex(m[1]), +m[2], m[3] ? +m[3] : 0), match: m[0] };
  m = s.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : 0;
    return { date: rollYear(today, +m[2] - 1, +m[1], y), match: m[0] };
  }
  m = s.match(/\bday after tomorrow\b/i);
  if (m) return { date: addDays(today, 2), match: m[0] };
  m = s.match(/\btomorrow\b/i);
  if (m) return { date: addDays(today, 1), match: m[0] };
  m = s.match(/\b(today|tonight|this evening)\b/i);
  if (m) return { date: today, match: m[0] };
  m = s.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\b/i);
  if (m) {
    const w = WEEKDAYS.indexOf(m[2].slice(0, 3).toLowerCase());
    let diff = (w - today.getDay() + 7) % 7;
    if (m[1] && diff === 0) diff = 7;
    return { date: addDays(today, diff), match: m[0] };
  }
  return null;
}

export function findTime(s) {
  let m = s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (m && +m[1] <= 12) {
    let h = +m[1] % 12;
    if (/p/i.test(m[3])) h += 12;
    return { time: pad(h) + ':' + (m[2] || '00'), match: m[0] };
  }
  m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { time: pad(+m[1]) + ':' + m[2], match: m[0] };
  return null;
}

export function findLocation(s) {
  const m = s.match(
    /\b(?:in|at)\s+(?:the\s+)?((?:school\s+)?(?:auditorium|hall|ground|playground|library|classroom|campus|gate|lab|assembly area|room\s*\w+)(?:\s+(?:hall|room|block))?)/i
  );
  if (!m) return null;
  return { location: m[1].charAt(0).toUpperCase() + m[1].slice(1), match: m[0] };
}

export function findType(s) {
  if (/\b(ptm|meeting|parent[- ]teacher|orientation|conference|meet the teacher|open house)\b/i.test(s)) return 'Meeting';
  if (/\b(assignment|homework|project|worksheet|submit|submission|test|exam|revision|chapter|notebook)\b/i.test(s)) return 'Assignment';
  if (/\b(pay|fee|fees|send|bring|carry|sign|form|return|consent|donat\w*)\b/i.test(s)) return 'Task';
  return 'Event';
}

export function findChild(s, children) {
  for (const c of children) {
    if (c.name && new RegExp('\\b' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(s)) return c.id;
  }
  const m = s.match(/\b(?:grade|class|std\.?|standard)\s*(\d{1,2})\b/i) || s.match(/\b(\d{1,2})\s?[A-F]\b/);
  if (m) {
    const hit = children.find((c) => String(c.grade).match(/\d+/)?.[0] === m[1]);
    if (hit) return hit.id;
  }
  return null;
}

export function cleanTitle(line, cuts) {
  let t = line;
  for (const c of cuts) if (c) t = t.replace(c, ' ');
  for (let i = 0; i < 2; i++) {
    t = t.replace(
      /^\s*(dear\s+parents?,?|reminder:?|note:?|kindly\s+note(\s+that)?|please\s+note(\s+that)?|kindly|please|hello|hi|this is to inform (you )?that)\s*/i,
      ''
    );
  }
  t = t.replace(/\b(is|are|will be)?\s*(scheduled|planned|organi[sz]ed|held)\s*(on|for)?\b/gi, ' ');
  t = t.replace(/\b(to be|should be|must be|has to be|needs to be)\s+(submitted|completed|done|returned)\b/gi, ' due');
  for (let j = 0; j < 2; j++) t = t.replace(/\b(on|by|before|at|from|for|in)\s*([,.;:!]+|$)/gi, '$2');
  t = t
    .replace(/\s+([,.;:!])/g, '$1')
    .replace(/^[\s,.;:!\-–]+/, '')
    .replace(/[\s,.;:!\-–]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  t = t.replace(/^ptm\b/i, 'Parent–Teacher Meeting (PTM)');
  if (!t) t = 'School item';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

/**
 * Split a message into items: one per line that carries a date.
 * @returns {Array<{title,type,childId,date,time,location,line}>}
 */
function childForWholeMessage(whole, children) {
  // A class signature ("Grade 4", "Class Teacher 4B") says who the whole message is for.
  const byGrade = findChild(whole, children.map((c) => ({ ...c, name: '' })));
  if (byGrade) return byGrade;
  // Otherwise only trust a name if exactly one child is mentioned.
  const named = children.filter((c) => c.name && findChild(whole, [c]));
  return named.length === 1 ? named[0].id : null;
}

export function parseMessage(text, { children = [], today = startOfDay(new Date()), fallbackChildId = null } = {}) {
  const whole = String(text || '');
  const childAll = childForWholeMessage(whole, children) || fallbackChildId || children[0]?.id || null;
  // One item per line; a line holding several sentences is split so each dated sentence
  // becomes its own item ("Pay fees by 25/11. Annual day on 28th Nov at 5 pm.").
  const lines = whole
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z₹0-9])/))
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const d = findDate(line, today);
    if (!d) continue;
    const tm = findTime(line);
    const lc = findLocation(line);
    // "Meera: ..." — the name prefix picks the child but doesn't belong in the title.
    const prefix = children.find((c) => c.name && line.toLowerCase().startsWith(c.name.toLowerCase() + ':'));
    out.push({
      title: cleanTitle(line, [prefix && line.slice(0, prefix.name.length + 1), d.match, tm && tm.match, lc && lc.match]),
      type: findType(line),
      childId: findChild(line, children) || childAll,
      date: toYmd(d.date),
      time: tm ? tm.time : '',
      location: lc ? lc.location : '',
      line,
    });
  }
  return out;
}
