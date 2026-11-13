import { test, before, after } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { initPush } from '../src/push.js';
import { createApp } from '../src/app.js';
import { dueReminders, runTick } from '../src/scheduler.js';

let server, base, db;
before(async () => {
  // TEST_DB=libsql runs the same suite against the Turso/libSQL backend (local file).
  db = process.env.TEST_DB === 'libsql'
    ? await openDb({ url: 'file:' + path.join(os.tmpdir(), `st-test-${process.pid}.db`) })
    : await openDb({ url: '', file: ':memory:' });
  await initPush(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('family flow: create, invite partner, extract, save, done, reminders', async () => {
  const a = await call('/api/family', {
    method: 'POST',
    body: { memberName: 'Arun', familyName: 'Test', children: [{ name: 'Aarav', grade: 'Grade 4 · 4B' }] },
  });
  assert.equal(a.status, 200);
  const tokA = a.body.token;
  assert.equal(a.body.children.length, 1);

  assert.equal((await call('/api/state')).status, 401);

  const inv = await call('/api/invites', { method: 'POST', token: tokA, body: {} });
  const code = inv.body.code;
  assert.equal((await call('/api/invites/' + code)).body.familyName, 'Test');
  const b = await call('/api/join', { method: 'POST', body: { code, name: 'Partner' } });
  assert.equal(b.status, 200);
  const tokB = b.body.token;
  assert.equal(b.body.members.length, 2);
  assert.equal((await call('/api/join', { method: 'POST', body: { code, name: 'X' } })).status, 404, 'invite is single-use');

  const ex = await call('/api/extract', { method: 'POST', token: tokA, body: { text: 'PTM on 21st Nov, 10:30 am in the hall' } });
  assert.equal(ex.body.engine, 'rules');
  assert.equal(ex.body.items[0].type, 'Meeting');

  const child = a.body.children[0].id;
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const saved = await call('/api/items', {
    method: 'POST',
    token: tokB,
    body: { items: [{ title: 'Bring crayons', type: 'Task', childId: child, date: tomorrow }] },
  });
  assert.equal(saved.body.ids.length, 1);
  const id = saved.body.ids[0];

  // Partner's item is visible to the other parent
  const stA = await call('/api/state', { token: tokA });
  const it = stA.body.items.find((i) => i.id === id);
  assert.deepEqual(it.rem, ['1d', 'am']);

  // Bad input is rejected
  assert.equal((await call('/api/items', { method: 'POST', token: tokA, body: { title: 'x', date: 'soon' } })).status, 400);

  // The evening-before reminder becomes due at 19:00 today for both parents
  const [y, m, d] = tomorrow.split('-').map(Number);
  const eve = new Date(y, m - 1, d - 1, 19, 1);
  await db.run('UPDATE items SET created_at = ? WHERE id = ?', [new Date(eve.getTime() - 3 * 3600e3).toISOString(), id]);
  const due = (await dueReminders(db, eve)).filter((x) => x.item.id === id);
  assert.equal(due.length, 2);
  await runTick(db, eve);
  assert.equal((await dueReminders(db, eve)).filter((x) => x.item.id === id).length, 0, 'not sent twice');

  // Done stops reminders
  await call(`/api/items/${id}/done`, { method: 'POST', token: tokA, body: { done: true } });
  const morning = new Date(y, m - 1, d, 7, 5);
  assert.equal((await dueReminders(db, morning)).filter((x) => x.item.id === id).length, 0);

  // Other families can't touch it
  const c = await call('/api/family', { method: 'POST', body: { memberName: 'Eve' } });
  assert.equal((await call('/api/items/' + id, { method: 'PATCH', token: c.body.token, body: { title: 'hacked' } })).status, 404);
});

test('custom reminders and attachments', async () => {
  const a = await call('/api/family', { method: 'POST', body: { memberName: 'A', children: [{ name: 'K' }] } });
  const tok = a.body.token;
  const date = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const { body: { ids: [id] } } = await call('/api/items', { method: 'POST', token: tok, body: { title: 'Trip', type: 'Event', date } });

  // custom reminder: valid key accepted, junk rejected silently, fires at its time
  const at = new Date(Date.now() + 3600e3);
  const pad = (n) => String(n).padStart(2, '0');
  const key = `c:${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  assert.equal((await call('/api/items/' + id, { method: 'PATCH', token: tok, body: { rem: ['1d', key, 'c:bad', 'x'] } })).status, 200);
  let st = await call('/api/state', { token: tok });
  assert.deepEqual(st.body.items.find((i) => i.id === id).rem, ['1d', key]);
  const fire = new Date(at.getTime() + 60e3);
  assert.ok((await dueReminders(db, fire)).some((d) => d.item.id === id && d.key === key));

  // binary upload round-trip
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 255, 254]);
  const up = await fetch(`${base}/api/items/${id}/attachments`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('Circular – Nov.pdf') },
    body: bytes,
  });
  assert.equal(up.status, 200);
  const attId = (await up.json()).id;
  const note = await call(`/api/items/${id}/notes`, { method: 'POST', token: tok, body: { text: 'Bring water bottle\nand cap' } });
  assert.equal(note.status, 200);
  st = await call('/api/state', { token: tok });
  const atts = st.body.items.find((i) => i.id === id).attachments;
  assert.deepEqual(atts.map((x) => [x.kind, x.name, x.size]), [['file', 'Circular – Nov.pdf', 9], ['note', 'Pasted note', 26]]);
  assert.equal(atts[1].text, 'Bring water bottle\nand cap');

  const got = await fetch(`${base}/api/attachments/${attId}`, { headers: { authorization: 'Bearer ' + tok } });
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);

  // another family cannot read or delete it
  const b = await call('/api/family', { method: 'POST', body: { memberName: 'B' } });
  assert.equal((await fetch(`${base}/api/attachments/${attId}`, { headers: { authorization: 'Bearer ' + b.body.token } })).status, 404);
  assert.equal((await call('/api/attachments/' + attId, { method: 'DELETE', token: b.body.token })).status, 404);

  assert.equal((await call('/api/attachments/' + attId, { method: 'DELETE', token: tok })).status, 200);
  st = await call('/api/state', { token: tok });
  assert.equal(st.body.items.find((i) => i.id === id).attachments.length, 1);
});

test('WhatsApp import: per-message dates, skips seen messages, past items dropped', async () => {
  const { parseWhatsAppExport } = await import('../public/shared/whatsapp.js');
  const a = await call('/api/family', { method: 'POST', body: { memberName: 'A', children: [{ name: 'Aarav', grade: 'Grade 4 · 4B' }] } });
  const tok = a.body.token;
  const p = (n) => String(n).padStart(2, '0');
  const dmy = (d) => `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
  const day = (n) => new Date(Date.now() + n * 864e5);
  const chat = [
    `[${dmy(day(-3))}, 7:45 PM] Class Teacher 4B: Old circular: sports day was on ${dmy(day(-1))}.`,
    `[${dmy(day(-1))}, 6:30 PM] Class Teacher 4B: Science project to be submitted tomorrow.`,
    `[${dmy(day(-1))}, 6:31 PM] Parent: Thank you ma'am`,
    `[${dmy(day(0))}, 7:05 AM] Class Teacher 4B: PTM on ${day(5).getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][day(5).getMonth()]} at 10:30 am in the auditorium.`,
  ].join('\n');
  const { messages } = parseWhatsAppExport(chat);
  assert.equal(messages.length, 4);

  const r1 = await call('/api/import/chat', { method: 'POST', token: tok, body: { chatName: 'Class 4B', messages } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.newMessages, 4);
  // "tomorrow" in yesterday's message = today; the old sports day is in the past and dropped
  const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  assert.deepEqual(r1.body.items.map((i) => [i.type, i.date]).sort(), [['Assignment', ymd(day(0))], ['Meeting', ymd(day(5))]].sort());
  assert.ok(r1.body.items.every((i) => i.msgId && i.sender === 'Class Teacher 4B'));

  await call('/api/import/seen', { method: 'POST', token: tok, body: { ids: r1.body.newIds, chatName: 'Class 4B' } });
  const r2 = await call('/api/import/chat', { method: 'POST', token: tok, body: { chatName: 'Class 4B', messages } });
  assert.equal(r2.body.newMessages, 0);
  assert.equal(r2.body.alreadySeen, 4);
  assert.equal(r2.body.items.length, 0);
});
