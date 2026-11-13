import { reminderAt, parseYmd, daysFromToday, MORNING_HOUR } from '../public/shared/reminders.js';
import { rowToItem, nowIso } from './db.js';
import { pushToMember, signAction } from './push.js';
import { config } from './config.js';

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}

export function dayWord(ymd, now = new Date()) {
  const n = daysFromToday(ymd, now);
  const d = parseYmd(ymd);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n > 1 && n < 7) return WD[d.getDay()];
  return `${WD[d.getDay()].slice(0, 3)} ${d.getDate()} ${MON[d.getMonth()]}`;
}

export function buildNotification(item, child, memberId, now = new Date()) {
  const when = dayWord(item.date, now) + (item.time ? ' at ' + fmtTime(item.time) : '');
  const bits = [child ? `${child.name}${child.grade ? ' · ' + child.grade : ''}` : null, item.location || null];
  if (item.type === 'Assignment') bits.push('Check it is in the school bag');
  if (item.type === 'Task') bits.push('Needs doing');
  return {
    title: `${when}: ${item.title}`,
    body: bits.filter(Boolean).join(' · '),
    tag: `item-${item.id}`,
    url: `/#item/${item.id}`,
    itemId: item.id,
    memberId,
    sig: signAction(item.id, memberId),
  };
}

/**
 * Work out which reminders are due right now. Pure apart from db reads, so it is easy to test.
 * @returns {Array<{item, child, memberId, key}>}
 */
export async function dueReminders(db, now = new Date()) {
  const graceMs = config.graceMinutes * 60000;
  // Nothing older than a week can still have a reminder due.
  const since = new Date(now.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const [rows, members, sentRows, children] = await Promise.all([
    // Custom reminders can be set after the item's date, so keep those items too.
    db.all(`SELECT * FROM items WHERE done = 0 AND (date >= ? OR rem LIKE '%"c:%')`, [since]),
    db.all('SELECT id, family_id FROM members WHERE notify = 1'),
    db.all(`SELECT s.item_id, s.rem_key, s.member_id FROM sent s JOIN items i ON i.id = s.item_id
             WHERE i.done = 0 AND (i.date >= ? OR i.rem LIKE '%"c:%')`, [since]),
    db.all('SELECT * FROM children'),
  ]);
  const byFamily = new Map();
  for (const m of members) {
    if (!byFamily.has(m.family_id)) byFamily.set(m.family_id, []);
    byFamily.get(m.family_id).push(m.id);
  }
  const sentSet = new Set(sentRows.map((r) => `${r.item_id}|${r.rem_key}|${r.member_id}`));
  const childById = new Map(children.map((c) => [c.id, c]));
  const due = [];
  for (const row of rows) {
    const item = rowToItem(row);
    const created = new Date(item.createdAt);
    for (const key of item.rem) {
      const at = reminderAt(item, key);
      if (!at || at > now || now - at > graceMs) continue;
      // Don't fire reminders whose time had already passed when the item was added,
      // except the morning-of one for an item added on the day itself.
      if (at < created && !(key === 'am' && daysFromToday(item.date, now) === 0 && now.getHours() >= MORNING_HOUR)) continue;
      for (const memberId of byFamily.get(row.family_id) || []) {
        if (sentSet.has(`${item.id}|${key}|${memberId}`)) continue;
        due.push({ item, child: childById.get(item.childId) || null, memberId, key });
      }
    }
  }
  // Snoozed reminders
  const snoozes = await db.all(
    `SELECT s.id AS sid, s.member_id AS snooze_member, i.* FROM snoozes s JOIN items i ON i.id = s.item_id
     WHERE s.sent = 0 AND s.at <= ? AND i.done = 0`,
    [now.toISOString()]
  );
  for (const s of snoozes) {
    const item = rowToItem(s);
    due.push({ item, child: childById.get(item.childId) || null, memberId: s.snooze_member, key: `snooze:${s.sid}` });
  }
  return due;
}

export async function runTick(db, now = new Date()) {
  const due = await dueReminders(db, now);
  for (const d of due) {
    // Mark first so a slow push service can't cause duplicates on the next tick.
    if (d.key.startsWith('snooze:')) await db.run('UPDATE snoozes SET sent = 1 WHERE id = ?', [Number(d.key.slice(7))]);
    else await db.run('INSERT OR IGNORE INTO sent(item_id, rem_key, member_id, sent_at) VALUES (?, ?, ?, ?)', [d.item.id, d.key, d.memberId, nowIso()]);
    await pushToMember(db, d.memberId, buildNotification(d.item, d.child, d.memberId, now));
  }
  return due.length;
}

export function startScheduler(db) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await runTick(db);
      if (n) console.log(`[scheduler] sent ${n} reminder(s)`);
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, config.tickSeconds * 1000);
}
