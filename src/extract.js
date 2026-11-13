// Turn a pasted school message into draft items.
// Uses the Claude API when ANTHROPIC_API_KEY is set; otherwise (or on any failure)
// falls back to the rule-based parser so the app keeps working offline.
import { parseMessage } from './parser.js';
import { TYPES, toYmd } from '../public/shared/reminders.js';
import { config } from './config.js';

const SYSTEM = `You extract actionable items for parents from messages sent by an Indian school (WhatsApp class groups, school apps, SMS, email).
Return ONLY a JSON object: {"items":[{"title","type","childId","date","time","location","line"}]}.
Rules:
- One item per distinct event, assignment, meeting or task that has (or clearly implies) a date. Ignore greetings and sign-offs.
- title: short, plain, starts with a capital, max 80 chars, no date or time in it. Expand PTM to "Parent–Teacher Meeting (PTM)".
- type: one of Event | Assignment | Meeting | Task. Homework/projects/tests = Assignment. Fees, things to bring/send/sign = Task. PTM/orientation = Meeting. Celebrations, trips, holidays, sports day = Event.
- date: YYYY-MM-DD. Dates are day-first (18/11 = 18 November). Resolve weekdays and words like "tomorrow" relative to TODAY. A date with no year is the next occurrence.
- time: HH:MM 24-hour, or "" if none given.
- location: short place name or "".
- childId: the id from CHILDREN that the message is about (match by name or grade/class/section), or null if unclear.
- line: the exact sentence from the message the item came from.
Never invent items, dates or times that are not in the message.`;

function cleanItem(raw, children, fallbackChildId) {
  const ids = new Set(children.map((c) => c.id));
  const type = TYPES.includes(raw.type) ? raw.type : 'Event';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : null;
  if (!date) return null;
  return {
    title: String(raw.title || 'School item').slice(0, 120),
    type,
    childId: ids.has(raw.childId) ? raw.childId : fallbackChildId || children[0]?.id || null,
    date,
    time: /^\d{2}:\d{2}$/.test(raw.time || '') ? raw.time : '',
    location: String(raw.location || '').slice(0, 80),
    line: String(raw.line || '').slice(0, 400),
  };
}

async function extractWithClaude(text, { children, today, fallbackChildId }) {
  const user = `TODAY: ${toYmd(today)} (${today.toLocaleDateString('en-IN', { weekday: 'long' })})
CHILDREN: ${JSON.stringify(children.map((c) => ({ id: c.id, name: c.name, grade: c.grade })))}
MESSAGE:
"""
${text}
"""`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const out = (body.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json);
    return (parsed.items || []).map((r) => cleanItem(r, children, fallbackChildId)).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

export async function extractItems(text, opts) {
  if (config.anthropicKey) {
    try {
      const items = await extractWithClaude(text, opts);
      return { engine: 'claude', items };
    } catch (err) {
      console.warn('[extract] Claude failed, using rules:', err.message);
    }
  }
  return { engine: 'rules', items: parseMessage(text, opts) };
}

// ---------- WhatsApp group import ----------
// Each message carries its own date, so "tomorrow" in a message from last Tuesday means Wednesday.

const CHAT_RULES = `
This input is a WhatsApp group chat. Each message line starts with [MSG n | YYYY-MM-DD HH:MM | sender].
- Resolve relative dates ("tomorrow", "Friday", "next week Monday") against THAT message's date, not TODAY.
- Only extract items the school (teachers, class reps, school accounts) asks parents to act on or attend.
  Ignore chit-chat, thank-yous, parents' questions and replies, and duplicates of the same item.
- For each item add "msg": the n of the message it came from, and set "line" to that message's text.
- Skip items whose date is before TODAY.`;

async function claudeJson(system, user) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.claudeModel, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const out = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.date}|${i.title.toLowerCase().replace(/\W+/g, '')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param {Array<{id,date,time,sender,text}>} messages  new (not yet imported) messages, oldest first
 * @returns {{engine, items: Array<{...draft, msgId, sender}>}}
 */
export async function extractFromChat(messages, { children, today, fallbackChildId, chatName = '' }) {
  const todayYmd = toYmd(today);
  const keep = (list) => dedupe(list.filter((i) => i.date >= todayYmd));
  if (config.anthropicKey && messages.length) {
    try {
      const user = `TODAY: ${todayYmd} (${today.toLocaleDateString('en-IN', { weekday: 'long' })})
GROUP: ${chatName}
CHILDREN: ${JSON.stringify(children.map((c) => ({ id: c.id, name: c.name, grade: c.grade })))}
CHAT:
${messages.map((m, n) => `[MSG ${n} | ${m.date} ${m.time} | ${m.sender}] ${m.text}`).join('\n')}`;
      const parsed = await claudeJson(SYSTEM + CHAT_RULES, user);
      const items = (parsed.items || [])
        .map((r) => {
          const it = cleanItem(r, children, fallbackChildId);
          const m = messages[Number(r.msg)];
          return it && { ...it, line: m ? m.text.slice(0, 400) : it.line, msgId: m?.id || null, sender: m?.sender || '' };
        })
        .filter(Boolean);
      return { engine: 'claude', items: keep(items) };
    } catch (err) {
      console.warn('[extract] Claude failed on chat import, using rules:', err.message);
    }
  }
  const items = [];
  for (const m of messages) {
    const [y, mo, d] = m.date.split('-').map(Number);
    for (const it of parseMessage(m.text, { children, today: new Date(y, mo - 1, d), fallbackChildId })) {
      items.push({ ...it, msgId: m.id, sender: m.sender });
    }
  }
  return { engine: 'rules', items: keep(items) };
}
