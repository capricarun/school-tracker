// Parse a WhatsApp "Export chat" text file (iPhone or Android format) into messages.
//   iPhone:  [13/11/26, 3:45:12 PM] Class Teacher: PTM on Saturday…
//   Android: 13/11/26, 15:45 - Class Teacher: PTM on Saturday…
// Lines that don't start a new message continue the previous one.

const IOS = /^\[(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?\s?m\.?)?\]\s+(.*)$/i;
const ANDROID = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?\s?m\.?)?\s+[-–]\s+(.*)$/i;

// Things that are not real school messages.
const SKIP = [
  /messages and calls are end-to-end encrypted/i,
  /^(‎)?(image|video|audio|sticker|gif|document|contact card) omitted$/i,
  /^<media omitted>$/i,
  /^‎?<attached: [^>]+>$/i,
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^(waiting for this message|null)$/i,
  /\b(joined using this group's invite link|added you|left|was added|changed the group description|changed this group's icon|changed the subject|created group|is now an admin)\b/i,
];

const clean = (s) => s.replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/[  ]/g, ' ');

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * @param {string} raw  contents of _chat.txt / "WhatsApp Chat with X.txt"
 * @returns {{messages: Array<{id, at, date, time, sender, text}>, order: 'dmy'|'mdy'}}
 *   `at` is local 'YYYY-MM-DDTHH:MM'; `id` is stable across re-exports (used to skip seen messages).
 */
export function parseWhatsAppExport(raw) {
  const lines = clean(String(raw || '')).split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const m = IOS.exec(line) || ANDROID.exec(line);
    if (m) rows.push({ a: +m[1], b: +m[2], c: +m[3], h: +m[4], min: +m[5], ap: m[6] || '', rest: m[7] });
    else if (rows.length) rows[rows.length - 1].rest += '\n' + line;
  }
  // Day/month order: anything > 12 in the first slot means day-first; in the second, month-first.
  // Default to day-first (India, UK, most of the world).
  const yFirst = rows.some((r) => r.a > 31);
  let order = 'dmy';
  if (!yFirst && rows.some((r) => r.b > 12) && !rows.some((r) => r.a > 12)) order = 'mdy';

  const messages = [];
  for (const r of rows) {
    let d, mo, y;
    if (yFirst) [y, mo, d] = [r.a, r.b, r.c];
    else if (order === 'mdy') [mo, d, y] = [r.a, r.b, r.c];
    else [d, mo, y] = [r.a, r.b, r.c];
    if (y < 100) y += 2000;
    let h = r.h;
    if (r.ap) {
      const pm = /p/i.test(r.ap);
      h = (h % 12) + (pm ? 12 : 0);
    }
    const colon = r.rest.indexOf(': ');
    if (colon < 0) continue; // system line ("X added Y") has no "Name: "
    const sender = r.rest.slice(0, colon).trim();
    const text = r.rest.slice(colon + 2).trim();
    if (!text || SKIP.some((rx) => rx.test(text))) continue;
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${y}-${pad(mo)}-${pad(d)}`;
    const time = `${pad(h)}:${pad(r.min)}`;
    messages.push({ id: fnv(`${date}T${time}|${sender}|${text}`), at: `${date}T${time}`, date, time, sender, text });
  }
  return { messages, order };
}

/** Group name from an export file name: "WhatsApp Chat - Class 4B Parents.zip" → "Class 4B Parents". */
export function chatNameFromFile(name) {
  return (
    String(name || '')
      .replace(/\.(zip|txt)$/i, '')
      .replace(/^WhatsApp Chat( -| with)\s*/i, '')
      .replace(/^_chat$/i, '')
      .trim() || 'WhatsApp group'
  );
}
