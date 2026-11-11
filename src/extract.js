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
