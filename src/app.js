import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, newToken, hashToken, nowIso, rowToItem } from './db.js';
import { TYPES, REMINDERS, defaultReminders, startOfDay } from '../public/shared/reminders.js';
import { extractItems } from './extract.js';
import { pushToMember, vapidPublicKey, verifyAction } from './push.js';
import { buildNotification } from './scheduler.js';
import { config } from './config.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COLORS = ['#0E6B5E', '#B4561A', '#1D4E89', '#7A3E9D', '#8A6D00'];
const REM_KEYS = new Set(REMINDERS.map((r) => r.key));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

const str = (v, max, def = '') => (typeof v === 'string' ? v.trim().slice(0, max) : def);
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHm = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    next();
  });

  const SQL = {
    deviceByToken: 'SELECT m.* FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token_hash = ?',
    item: 'SELECT * FROM items WHERE id = ? AND family_id = ?',
    activity: 'INSERT INTO activity(family_id, member_id, text, at) VALUES (?, ?, ?, ?)',
  };
  const logStmt = (familyId, memberId, text) => [SQL.activity, [familyId, memberId, text, nowIso()]];
  const log = (familyId, memberId, text) => db.run(...logStmt(familyId, memberId, text));
  const memberByToken = (token) => db.get(SQL.deviceByToken, [hashToken(token)]);
  const getItem = (id, familyId) => db.get(SQL.item, [id, familyId]);

  async function issueToken(memberId) {
    const token = newToken();
    await db.run('INSERT INTO devices(token_hash, member_id, created_at) VALUES (?, ?, ?)', [hashToken(token), memberId, nowIso()]);
    return token;
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const auth = wrap(async (req, res, next) => {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const member = token && (await memberByToken(token));
    if (!member) throw new HttpError(401, 'Not signed in');
    req.member = member;
    req.familyId = member.family_id;
    next();
  });

  // Tiny in-memory limiter for the AI endpoint and sign-up.
  const hits = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) throw new HttpError(429, 'Too many requests, try again in a bit');
    arr.push(now);
    hits.set(key, arr);
  }

  function itemFromBody(body, base = {}) {
    const type = TYPES.includes(body.type) ? body.type : base.type || 'Event';
    const date = body.date !== undefined ? body.date : base.date;
    if (!isYmd(date)) throw bad('date must be YYYY-MM-DD');
    const time = body.time !== undefined ? body.time || '' : base.time || '';
    if (time && !isHm(time)) throw bad('time must be HH:MM');
    const title = body.title !== undefined ? str(body.title, 120) : base.title;
    if (!title) throw bad('title is required');
    let rem = body.rem !== undefined ? body.rem : base.rem;
    if (!Array.isArray(rem)) rem = defaultReminders(type, time);
    rem = [...new Set(rem.filter((k) => REM_KEYS.has(k)))];
    return {
      type,
      title,
      date,
      time,
      childId: body.childId !== undefined ? (typeof body.childId === 'string' && body.childId) || null : base.childId ?? null,
      location: body.location !== undefined ? str(body.location, 80) : base.location || '',
      source: body.source !== undefined ? str(body.source, 40) : base.source || '',
      msg: body.msg !== undefined ? str(body.msg, 2000) : base.msg || '',
      rem,
    };
  }

  async function assertChildren(familyId, ids) {
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return;
    const have = new Set((await db.all('SELECT id FROM children WHERE family_id = ?', [familyId])).map((c) => c.id));
    if (want.some((id) => !have.has(id))) throw bad('unknown child');
  }

  async function familyState(member) {
    const fid = member.family_id;
    const [family, members, children, items, activity] = await Promise.all([
      db.get('SELECT * FROM families WHERE id = ?', [fid]),
      db.all('SELECT id, name, role, notify, tell_done, created_at FROM members WHERE family_id = ? ORDER BY created_at', [fid]),
      db.all('SELECT id, name, grade, color FROM children WHERE family_id = ? ORDER BY created_at', [fid]),
      db.all('SELECT * FROM items WHERE family_id = ? ORDER BY date, time', [fid]),
      db.all(
        `SELECT a.text, a.at, m.name AS who FROM activity a LEFT JOIN members m ON m.id = a.member_id
         WHERE a.family_id = ? ORDER BY a.id DESC LIMIT 20`,
        [fid]
      ),
    ]);
    return {
      me: { id: member.id, name: member.name, role: member.role, notify: !!member.notify, tellDone: !!member.tell_done },
      family: { id: family.id, name: family.name },
      members: members.map((m) => ({ id: m.id, name: m.name, role: m.role, notify: !!m.notify })),
      children,
      items: items.map(rowToItem),
      activity,
      vapidPublicKey: vapidPublicKey(),
      aiEnabled: !!config.anthropicKey,
    };
  }

  // ---------- public ----------
  app.get(
    '/healthz',
    wrap(async (req, res) => {
      await db.get('SELECT 1 AS ok');
      res.json({ ok: true, time: new Date().toString() });
    })
  );

  app.post(
    '/api/family',
    wrap(async (req, res) => {
      if (!config.allowSignup) throw new HttpError(403, 'New families are disabled on this server');
      limit('signup:' + req.ip, 5, 3600e3);
      const familyName = str(req.body.familyName, 60) || 'Our family';
      const memberName = str(req.body.memberName, 40);
      if (!memberName) throw bad('Your name is required');
      const kids = Array.isArray(req.body.children) ? req.body.children.slice(0, 8) : [];
      const fid = newId();
      const mid = newId();
      const t = nowIso();
      const stmts = [
        ['INSERT INTO families(id, name, created_at) VALUES (?, ?, ?)', [fid, familyName, t]],
        ['INSERT INTO members(id, family_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)', [mid, fid, memberName, 'admin', t]],
      ];
      kids.forEach((k, i) => {
        const name = str(k?.name, 40);
        if (name) {
          stmts.push([
            'INSERT INTO children(id, family_id, name, grade, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [newId(), fid, name, str(k.grade, 30), COLORS[i % COLORS.length], t],
          ]);
        }
      });
      stmts.push(logStmt(fid, mid, 'created the family space'));
      await db.batch(stmts);
      const token = await issueToken(mid);
      res.json({ token, ...(await familyState(await memberByToken(token))) });
    })
  );

  app.get(
    '/api/invites/:code',
    wrap(async (req, res) => {
      const inv = await db.get(
        `SELECT i.*, f.name AS family_name, m.name AS inviter, t.name AS target_name FROM invites i
         JOIN families f ON f.id = i.family_id JOIN members m ON m.id = i.created_by
         LEFT JOIN members t ON t.id = i.member_id WHERE i.code = ?`,
        [req.params.code]
      );
      if (!inv || inv.used_at || inv.expires_at < nowIso()) throw new HttpError(404, 'This invite link has expired or was already used');
      res.json({ familyName: inv.family_name, inviter: inv.inviter, linkDevice: !!inv.member_id, targetName: inv.target_name });
    })
  );

  app.post(
    '/api/join',
    wrap(async (req, res) => {
      limit('join:' + req.ip, 10, 3600e3);
      const code = str(req.body.code, 64);
      const inv = await db.get('SELECT * FROM invites WHERE code = ?', [code]);
      if (!inv || inv.used_at || inv.expires_at < nowIso()) throw new HttpError(404, 'This invite link has expired or was already used');
      // Claim the invite first so two people can't use the same link at once.
      const claimed = await db.run('UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL', [nowIso(), code]);
      if (!claimed.changes) throw new HttpError(404, 'This invite link has expired or was already used');
      let memberId = inv.member_id;
      if (!memberId) {
        const name = str(req.body.name, 40);
        if (!name) {
          await db.run('UPDATE invites SET used_at = NULL WHERE code = ?', [code]);
          throw bad('Your name is required');
        }
        memberId = newId();
        await db.batch([
          ['INSERT INTO members(id, family_id, name, created_at) VALUES (?, ?, ?, ?)', [memberId, inv.family_id, name, nowIso()]],
          logStmt(inv.family_id, memberId, 'joined the family space'),
        ]);
      }
      const token = await issueToken(memberId);
      res.json({ token, ...(await familyState(await memberByToken(token))) });
    })
  );

  // Notification buttons (Mark done / Snooze) come from the service worker, which has
  // no login token, so they are authorised with a per-item, per-member HMAC instead.
  app.post(
    '/api/push-action',
    wrap(async (req, res) => {
      const { itemId, memberId, sig, action } = req.body || {};
      if (!verifyAction(itemId, memberId, sig)) throw new HttpError(403, 'Bad signature');
      const member = await db.get('SELECT * FROM members WHERE id = ?', [memberId]);
      const row = member && (await getItem(itemId, member.family_id));
      if (!row) throw new HttpError(404, 'Not found');
      if (action === 'done') await markDone(member, row, true);
      else if (action === 'snooze') await snooze(member, row, 60);
      else throw bad('unknown action');
      res.json({ ok: true });
    })
  );

  // ---------- signed in ----------
  app.get('/api/state', auth, wrap(async (req, res) => res.json(await familyState(req.member))));

  app.patch(
    '/api/me',
    auth,
    wrap(async (req, res) => {
      const m = req.member;
      const name = req.body.name !== undefined ? str(req.body.name, 40) || m.name : m.name;
      const notify = req.body.notify !== undefined ? (req.body.notify ? 1 : 0) : m.notify;
      const tell = req.body.tellDone !== undefined ? (req.body.tellDone ? 1 : 0) : m.tell_done;
      await db.run('UPDATE members SET name = ?, notify = ?, tell_done = ? WHERE id = ?', [name, notify, tell, m.id]);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/invites',
    auth,
    wrap(async (req, res) => {
      const code = newId(12);
      const linkDevice = !!req.body.linkDevice;
      const t = new Date();
      const exp = new Date(t.getTime() + (linkDevice ? 1 : 7 * 24) * 3600e3);
      await db.run('INSERT INTO invites(code, family_id, created_by, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
        code, req.familyId, req.member.id, linkDevice ? req.member.id : null, t.toISOString(), exp.toISOString(),
      ]);
      const origin = process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.get('host')}`;
      res.json({ code, url: `${origin}/#join/${code}`, expiresAt: exp.toISOString() });
    })
  );

  app.post(
    '/api/children',
    auth,
    wrap(async (req, res) => {
      const name = str(req.body.name, 40);
      if (!name) throw bad('name is required');
      const { n } = await db.get('SELECT COUNT(*) AS n FROM children WHERE family_id = ?', [req.familyId]);
      const id = newId();
      await db.run('INSERT INTO children(id, family_id, name, grade, color, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id, req.familyId, name, str(req.body.grade, 30), COLORS[Number(n) % COLORS.length], nowIso(),
      ]);
      res.json({ id });
    })
  );

  app.patch(
    '/api/children/:id',
    auth,
    wrap(async (req, res) => {
      const c = await db.get('SELECT * FROM children WHERE id = ? AND family_id = ?', [req.params.id, req.familyId]);
      if (!c) throw new HttpError(404, 'Not found');
      await db.run('UPDATE children SET name = ?, grade = ? WHERE id = ?', [
        str(req.body.name, 40) || c.name, req.body.grade !== undefined ? str(req.body.grade, 30) : c.grade, c.id,
      ]);
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/children/:id',
    auth,
    wrap(async (req, res) => {
      await db.batch([
        ['UPDATE items SET child_id = NULL WHERE child_id = ? AND family_id = ?', [req.params.id, req.familyId]],
        ['DELETE FROM children WHERE id = ? AND family_id = ?', [req.params.id, req.familyId]],
      ]);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/extract',
    auth,
    wrap(async (req, res) => {
      const text = str(req.body.text, 6000);
      if (!text) throw bad('Paste a message first');
      limit('extract:' + req.member.id, 30, 3600e3);
      const children = await db.all('SELECT id, name, grade, color FROM children WHERE family_id = ? ORDER BY created_at', [req.familyId]);
      const result = await extractItems(text, {
        children,
        today: startOfDay(new Date()),
        fallbackChildId: req.body.childId || null,
      });
      res.json(result);
    })
  );

  const INSERT_ITEM = `INSERT INTO items(id, family_id, child_id, type, title, date, time, location, source, msg, rem, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  app.post(
    '/api/items',
    auth,
    wrap(async (req, res) => {
      const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [req.body];
      const t = nowIso();
      const items = list.map((body) => itemFromBody(body));
      await assertChildren(req.familyId, items.map((i) => i.childId));
      const ids = items.map(() => newId());
      await db.batch([
        ...items.map((it, k) => [
          INSERT_ITEM,
          [ids[k], req.familyId, it.childId, it.type, it.title, it.date, it.time, it.location, it.source, it.msg, JSON.stringify(it.rem), req.member.id, t, t],
        ]),
        logStmt(req.familyId, req.member.id, `added ${ids.length} item${ids.length > 1 ? 's' : ''}`),
      ]);
      res.json({ ids });
    })
  );

  app.patch(
    '/api/items/:id',
    auth,
    wrap(async (req, res) => {
      const row = await getItem(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      const it = itemFromBody(req.body, rowToItem(row));
      await assertChildren(req.familyId, [it.childId]);
      const stmts = [
        [
          `UPDATE items SET child_id = ?, type = ?, title = ?, date = ?, time = ?, location = ?, source = ?, msg = ?, rem = ?, updated_at = ? WHERE id = ?`,
          [it.childId, it.type, it.title, it.date, it.time, it.location, it.source, it.msg, JSON.stringify(it.rem), nowIso(), row.id],
        ],
      ];
      // If the date or time moved, reminders should fire again for the new schedule.
      if (it.date !== row.date || it.time !== row.time) stmts.push(['DELETE FROM sent WHERE item_id = ?', [row.id]]);
      await db.batch(stmts);
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/items/:id',
    auth,
    wrap(async (req, res) => {
      const row = await getItem(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      await db.batch([
        ['DELETE FROM items WHERE id = ?', [row.id]],
        ['DELETE FROM sent WHERE item_id = ?', [row.id]],
        ['DELETE FROM snoozes WHERE item_id = ?', [row.id]],
        logStmt(req.familyId, req.member.id, `deleted “${row.title}”`),
      ]);
      res.json({ ok: true });
    })
  );

  async function markDone(member, row, done) {
    await db.batch([
      ['UPDATE items SET done = ?, done_by = ?, done_at = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, done ? member.name : null, done ? nowIso() : null, nowIso(), row.id]],
      logStmt(member.family_id, member.id, `${done ? 'marked' : 'reopened'} “${row.title}”${done ? ' done' : ''}`),
    ]);
    if (!done) return;
    const others = await db.all('SELECT id FROM members WHERE family_id = ? AND id != ? AND tell_done = 1', [member.family_id, member.id]);
    for (const o of others) {
      pushToMember(db, o.id, {
        title: `${member.name} marked it done`,
        body: row.title,
        tag: `done-${row.id}`,
        url: `/#item/${row.id}`,
        silent: true,
      }).catch(() => {});
    }
  }

  async function snooze(member, row, minutes) {
    const at = new Date(Date.now() + minutes * 60000).toISOString();
    await db.run('INSERT INTO snoozes(item_id, member_id, at) VALUES (?, ?, ?)', [row.id, member.id, at]);
    return at;
  }

  app.post(
    '/api/items/:id/done',
    auth,
    wrap(async (req, res) => {
      const row = await getItem(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      await markDone(req.member, row, req.body.done !== false);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/items/:id/snooze',
    auth,
    wrap(async (req, res) => {
      const row = await getItem(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      const minutes = Math.min(Math.max(Number(req.body.minutes) || 60, 5), 24 * 60);
      res.json({ at: await snooze(req.member, row, minutes) });
    })
  );

  app.post(
    '/api/push/subscribe',
    auth,
    wrap(async (req, res) => {
      const sub = req.body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) throw bad('bad subscription');
      await db.run(
        `INSERT INTO push_subs(endpoint, member_id, sub, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, sub = excluded.sub`,
        [sub.endpoint, req.member.id, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), nowIso()]
      );
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/push/unsubscribe',
    auth,
    wrap(async (req, res) => {
      await db.run('DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?', [str(req.body.endpoint, 2000), req.member.id]);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/push/test',
    auth,
    wrap(async (req, res) => {
      limit('test:' + req.member.id, 10, 3600e3);
      const row = await db.get('SELECT * FROM items WHERE family_id = ? AND done = 0 ORDER BY date, time LIMIT 1', [req.familyId]);
      const child = row?.child_id ? await db.get('SELECT * FROM children WHERE id = ?', [row.child_id]) : null;
      const payload = row
        ? buildNotification(rowToItem(row), child, req.member.id)
        : { title: 'School Tracker', body: 'Notifications are working on this device.', tag: 'test', url: '/' };
      const delivered = await pushToMember(db, req.member.id, payload);
      res.json({ delivered });
    })
  );

  app.post(
    '/api/logout',
    auth,
    wrap(async (req, res) => {
      const token = (req.get('authorization') || '').slice(7);
      await db.run('DELETE FROM devices WHERE token_hash = ?', [hashToken(token)]);
      res.json({ ok: true });
    })
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- static PWA ----------
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, file) {
        if (file.endsWith('sw.js') || file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  // Android share target lands here (?text=...). The SPA reads the query string.
  app.get(['/share', '/'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}
