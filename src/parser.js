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

const yr = (y) => (y ? (+y < 100 ? 2000 + +y : +y) : 0);

export function findDate(s, today) {
  let m;
  // 15 Nov · 15th November 2026 · 15-Nov-26 · 15th of Nov · 15 Nov'26
  // Year: 4 digits after a space/comma ("15 Nov 2026"), or 2 digits glued on ("15-Nov-26", "Nov'26").
  // Never a time: "21st Nov, 10:30 am" must not read as the year 2010.
  m = s.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-./]*(?:of\\s+)?" + MONTH_RX + "\\b\\.?(?:,?\\s*(\\d{4})\\b(?![:.]\\d)|['’\\-./](\\d{2})\\b(?![:.]\\d))?", 'i'));
  if (m && +m[1] >= 1 && +m[1] <= 31) return { date: rollYear(today, monthIndex(m[2]), +m[1], yr(m[3] || m[4])), match: m[0] };
  // Nov 15 · November 15th, 2026 · Nov-15
  m = s.match(new RegExp('\\b' + MONTH_RX + "\\b\\.?[\\s\\-]*(\\d{1,2})(?:st|nd|rd|th)?\\b(?![:.]\\d)(?:,?\\s*(\\d{4})\\b(?![:.]\\d))?", 'i'));
  if (m && +m[2] >= 1 && +m[2] <= 31) return { date: rollYear(today, monthIndex(m[1]), +m[2], yr(m[3])), match: m[0] };
  // 15/11 · 15-11-2026 · 15.11.26 (day first). Skip things that are really times ("10.30 am").
  for (const x of s.matchAll(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?\b(?!\s*(?:a\.?m|p\.?m|hrs|hours|mins?)\b)(?![.:]\d)/gi)) {
    const d = +x[1], mo = +x[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && (x[3] || x[0].includes('/') || x[0].includes('-'))) {
      return { date: rollYear(today, mo - 1, d, yr(x[3])), match: x[0] };
    }
  }
  // 2026-11-15
  m = s.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3]), match: m[0] };
  m = s.match(/\bday after tomorrow\b/i);
  if (m) return { date: addDays(today, 2), match: m[0] };
  m = s.match(/\b(tomorrow|tmrw|tmr)\b/i);
  if (m) return { date: addDays(today, 1), match: m[0] };
  m = s.match(/\b(today|tonight|this evening|this morning)\b/i);
  if (m) return { date: today, match: m[0] };
  m = s.match(/\b(next\s+|this\s+|coming\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\b/i);
  if (m) {
    const w = WEEKDAYS.indexOf(m[2].slice(0, 3).toLowerCase());
    let diff = (w - today.getDay() + 7) % 7;
    if (/next/i.test(m[1] || '') && diff === 0) diff = 7;
    return { date: addDays(today, diff), match: m[0] };
  }
  // "on the 17th", "by 20th" — day of this month, or next month if it has passed
  m = s.match(/\b(?:on|by|before|till|until|from|dated?)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (m && +m[1] >= 1 && +m[1] <= 31) {
    let dt = new Date(today.getFullYear(), today.getMonth(), +m[1]);
    if (dt < today) dt = new Date(today.getFullYear(), today.getMonth() + 1, +m[1]);
    return { date: dt, match: m[0] };
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
  t = t.replace(/https?:\/\/\S+/gi, ' ').replace(/\b(register|click|visit|link|details)( here)?\s*[:\-]?\s*$/i, '').replace(/[\s,.;:!\-–]+$/, '').trim();
  t = t.replace(/^ptm\b/i, 'Parent–Teacher Meeting (PTM)');
  if (!t) t = 'School item';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

function childForWholeMessage(whole, children) {
  // A class signature ("Grade 4", "Class Teacher 4B") says who the whole message is for.
  const byGrade = findChild(whole, children.map((c) => ({ ...c, name: '' })));
  if (byGrade) return byGrade;
  // Otherwise only trust a name if exactly one child is mentioned.
  const named = children.filter((c) => c.name && findChild(whole, [c]));
  return named.length === 1 ? named[0].id : null;
}

const GREETING = /^(dear\s+(parents?|all|sir|madam|guardians?)|(warm\s+)?greetings?(\s+of\s+the\s+day)?|good\s+(morning|afternoon|evening)|hello|hi|respected\s+parents?)[\s,!.:]*$/i;
const SIGNOFF = /^(thanks?( you)?|thank you|regards|warm regards|best regards|with regards|class teacher|principal|team\b)[\s,!.:]*/i;
const LABEL = /^\s*(date|day|dated|time|timing|timings|venue|place|location|when|where|reporting time)\s*[:\-–]\s*/i;
const WA_HEADER = /^\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?\]?\s*(?:[-–]\s*)?[^:\n]{1,60}:\s+/i;

const meaningful = (l) => l && !GREETING.test(l) && !SIGNOFF.test(l) && !LABEL.test(l);

function itemsFromText(whole, { children, today, childAll }) {
  const out = [];
  for (const block of whole.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // Notice layout: a heading line plus "Date: …", "Time: …", "Venue: …" lines → one item.
    if (lines.some((l) => LABEL.test(l))) {
      const dateLine = lines.find((l) => findDate(l, today));
      if (dateLine) {
        const d = findDate(dateLine, today);
        const tmLine = lines.find((l) => /^\s*(time|timing|timings|reporting time)\s*[:\-–]/i.test(l)) || lines.find((l) => findTime(l));
        const tm = tmLine && findTime(tmLine);
        const venue = lines.find((l) => /^\s*(venue|place|location|where)\s*[:\-–]/i.test(l));
        const heading = lines.find(meaningful) || dateLine;
        out.push({
          title: cleanTitle(heading, [heading === dateLine ? d.match : null]),
          type: findType(block),
          childId: findChild(block, children) || childAll,
          date: toYmd(d.date),
          time: tm ? tm.time : '',
          location: venue ? venue.replace(LABEL, '').trim().slice(0, 80) : findLocation(block)?.location || '',
          line: lines.join(' · ').slice(0, 400),
        });
        continue;
      }
    }
    // Otherwise one item per dated line / sentence.
    const parts = lines.flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z₹0-9])/)).map((x) => x.trim()).filter(Boolean);
    for (const line of parts) {
      const d = findDate(line, today);
      if (!d) continue;
      const tm = findTime(line);
      const lc = findLocation(line);
      // "Meera: ..." — the name prefix picks the child but doesn't belong in the title.
      const prefix = children.find((c) => c.name && line.toLowerCase().startsWith(c.name.toLowerCase() + ':'));
      let title = cleanTitle(line, [prefix && line.slice(0, prefix.name.length + 1), d.match, tm && tm.match, lc && lc.match]);
      // A line that was only a date ("On 15th Nov.") borrows the block's first real line as its title.
      if (title.length < 4 || /^(on|date|dated|day)$/i.test(title)) title = cleanTitle(lines.find(meaningful) || line, [d.match]);
      out.push({
        title,
        type: findType(line),
        childId: findChild(line, children) || childAll,
        date: toYmd(d.date),
        time: tm ? tm.time : '',
        location: lc ? lc.location : '',
        line,
      });
    }
  }
  return out;
}

/**
 * Split a message into items: one per dated line, sentence or notice block.
 * Text shared from WhatsApp may start with "[13/11/26, 3:45 PM] Name: " — that date is used
 * as "today" for words like "tomorrow", and the header is removed.
 * @returns {Array<{title,type,childId,date,time,location,line}>}
 */
export function parseMessage(text, { children = [], today = startOfDay(new Date()), fallbackChildId = null } = {}) {
  let whole = String(text || '').replace(/[‎‏‪-‮]/g, '').replace(/\r/g, '');
  const childAll = childForWholeMessage(whole, children) || fallbackChildId || children[0]?.id || null;
  // Split into separately dated chunks if WhatsApp headers are present.
  const chunks = [];
  let cur = { today, lines: [] };
  for (const line of whole.split('\n')) {
    const h = WA_HEADER.exec(line);
    if (h) {
      if (cur.lines.length) chunks.push(cur);
      const sent = new Date(yr(h[3]), +h[2] - 1, +h[1]);
      cur = { today: isNaN(sent) ? today : sent, lines: [line.slice(h[0].length)] };
    } else cur.lines.push(line);
  }
  if (cur.lines.length) chunks.push(cur);
  return chunks.flatMap((c) => itemsFromText(c.lines.join('\n'), { children, today: c.today, childAll }));
}

/** When a message has no date at all: one undated item so it's still tracked and notified. */
export function undatedItem(text, { children = [], fallbackChildId = null } = {}) {
  const whole = String(text || '').replace(/[‎‏‪-‮]/g, '').replace(WA_HEADER, '');
  const lines = whole.split('\n').map((l) => l.trim()).filter(Boolean);
  let first = lines.find((l) => meaningful(l) && !/^https?:\/\/\S+$/i.test(l)) || lines[0] || 'School message';
  // A message that is only a link: name it after the site.
  const onlyUrl = /^(https?:\/\/\S+)$/i.exec(first);
  if (onlyUrl) {
    try { first = 'Link: ' + new URL(onlyUrl[1]).hostname.replace(/^www\./, ''); } catch { first = 'Link from WhatsApp'; }
    return { title: first, type: 'Event', childId: childForWholeMessage(whole, children) || fallbackChildId || children[0]?.id || null, time: '', location: '', line: whole.trim().slice(0, 400) };
  }
  const tm = findTime(whole);
  return {
    title: cleanTitle(first, [tm && tm.match]),
    type: findType(whole),
    childId: childForWholeMessage(whole, children) || fallbackChildId || children[0]?.id || null,
    time: '',
    location: findLocation(whole)?.location || '',
    line: whole.trim().slice(0, 400),
  };
}
