import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { initPush } from '../src/push.js';
import { createApp } from '../src/app.js';
import { dueReminders, runTick } from '../src/scheduler.js';

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  initPush(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

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
  db.prepare('UPDATE items SET created_at = ? WHERE id = ?').run(new Date(eve.getTime() - 3 * 3600e3).toISOString(), id);
  const due = dueReminders(db, eve).filter((x) => x.item.id === id);
  assert.equal(due.length, 2);
  await runTick(db, eve);
  assert.equal(dueReminders(db, eve).filter((x) => x.item.id === id).length, 0, 'not sent twice');

  // Done stops reminders
  await call(`/api/items/${id}/done`, { method: 'POST', token: tokA, body: { done: true } });
  const morning = new Date(y, m - 1, d, 7, 5);
  assert.equal(dueReminders(db, morning).filter((x) => x.item.id === id).length, 0);

  // Other families can't touch it
  const c = await call('/api/family', { method: 'POST', body: { memberName: 'Eve' } });
  assert.equal((await call('/api/items/' + id, { method: 'PATCH', token: c.body.token, body: { title: 'hacked' } })).status, 404);
});
