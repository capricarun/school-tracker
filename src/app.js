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

  const q = {
    deviceByToken: db.prepare(
      `SELECT m.* FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token_hash = ?`
    ),
    family: db.prepare('SELECT * FROM families WHERE id = ?'),
    members: db.prepare('SELECT id, name, role, notify, tell_done, created_at FROM members WHERE family_id = ? ORDER BY created_at'),
    children: db.prepare('SELECT id, name, grade, color FROM children WHERE family_id = ? ORDER BY created_at'),
    item: db.prepare('SELECT * FROM items WHERE id = ? AND family_id = ?'),
    items: db.prepare('SELECT * FROM items WHERE family_id = ? ORDER BY date, time'),
    addActivity: db.prepare('INSERT INTO activity(family_id, member_id, text, at) VALUES (?, ?, ?, ?)'),
    addDevice: db.prepare('INSERT INTO devices(token_hash, member_id, created_at) VALUES (?, ?, ?)'),
  };

  const log = (familyId, memberId, text) => q.addActivity.run(familyId, memberId, text, nowIso());

  function issueToken(memberId) {
    const token = newToken();
    q.addDevice.run(hashToken(token), memberId, nowIso());
    return token;
  }

  function auth(req, res, next) {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const member = token && q.deviceByToken.get(hashToken(token));
    if (!member) return next(new HttpError(401, 'Not signed in'));
    req.member = member;
    req.familyId = member.family_id;
    next();
  }

  // Tiny in-memory limiter for the AI endpoint and sign-up.
  const hits = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) throw new HttpError(429, 'Too many requests, try again in a bit');
    arr.push(now);
    hits.set(key, arr);
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
      childId: body.childId !== undefined ? body.childId || null : base.childId ?? null,
      location: body.location !== undefined ? str(body.location, 80) : base.location || '',
      source: body.source !== undefined ? str(body.source, 40) : base.source || '',
      msg: body.msg !== undefined ? str(body.msg, 2000) : base.msg || '',
      rem,
    };
  }

  function assertChild(familyId, childId) {
    if (!childId) return;
    const ok = db.prepare('SELECT 1 FROM children WHERE id = ? AND family_id = ?').get(childId, familyId);
    if (!ok) throw bad('unknown child');
  }

  function familyState(member) {
    const family = q.family.get(member.family_id);
    return {
      me: { id: member.id, name: member.name, role: member.role, notify: !!member.notify, tellDone: !!member.tell_done },
      family: { id: family.id, name: family.name },
      members: q.members.all(member.family_id).map((m) => ({ id: m.id, name: m.name, role: m.role, notify: !!m.notify })),
      children: q.children.all(member.family_id),
      items: q.items.all(member.family_id).map(rowToItem),
      activity: db
        .prepare(
          `SELECT a.text, a.at, m.name AS who FROM activity a LEFT JOIN members m ON m.id = a.member_id
           WHERE a.family_id = ? ORDER BY a.id DESC LIMIT 20`
        )
        .all(member.family_id),
      vapidPublicKey: vapidPublicKey(),
      aiEnabled: !!config.anthropicKey,
    };
  }

  // ---------- public ----------
  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: new Date().toString() });
  });

  app.post(
    '/api/family',
    wrap((req, res) => {
      if (!config.allowSignup) throw new HttpError(403, 'New families are disabled on this server');
      limit('signup:' + req.ip, 5, 3600e3);
      const familyName = str(req.body.familyName, 60) || 'Our family';
      const memberName = str(req.body.memberName, 40);
      if (!memberName) throw bad('Your name is required');
      const kids = Array.isArray(req.body.children) ? req.body.children.slice(0, 8) : [];
      const fid = newId();
      const mid = newId();
      const t = nowIso();
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO families(id, name, created_at) VALUES (?, ?, ?)').run(fid, familyName, t);
        db.prepare('INSERT INTO members(id, family_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(mid, fid, memberName, 'admin', t);
        kids.forEach((k, i) => {
          const name = str(k.name, 40);
          if (name) {
            db.prepare('INSERT INTO children(id, family_id, name, grade, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
              newId(), fid, name, str(k.grade, 30), COLORS[i % COLORS.length], t
            );
          }
        });
        log(fid, mid, 'created the family space');
      });
      tx();
      const token = issueToken(mid);
      res.json({ token, ...familyState(q.deviceByToken.get(hashToken(token))) });
    })
  );

  app.get(
    '/api/invites/:code',
    wrap((req, res) => {
      const inv = db
        .prepare(
          `SELECT i.*, f.name AS family_name, m.name AS inviter, t.name AS target_name FROM invites i
           JOIN families f ON f.id = i.family_id JOIN members m ON m.id = i.created_by
           LEFT JOIN members t ON t.id = i.member_id WHERE i.code = ?`
        )
        .get(req.params.code);
      if (!inv || inv.used_at || inv.expires_at < nowIso()) throw new HttpError(404, 'This invite link has expired or was already used');
      res.json({ familyName: inv.family_name, inviter: inv.inviter, linkDevice: !!inv.member_id, targetName: inv.target_name });
    })
  );

  app.post(
    '/api/join',
    wrap((req, res) => {
      limit('join:' + req.ip, 10, 3600e3);
      const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(str(req.body.code, 64));
      if (!inv || inv.used_at || inv.expires_at < nowIso()) throw new HttpError(404, 'This invite link has expired or was already used');
      let memberId = inv.member_id;
      const tx = db.transaction(() => {
        if (!memberId) {
          const name = str(req.body.name, 40);
          if (!name) throw bad('Your name is required');
          memberId = newId();
          db.prepare('INSERT INTO members(id, family_id, name, created_at) VALUES (?, ?, ?, ?)').run(memberId, inv.family_id, name, nowIso());
          log(inv.family_id, memberId, 'joined the family space');
        }
        db.prepare('UPDATE invites SET used_at = ? WHERE code = ?').run(nowIso(), inv.code);
      });
      tx();
      const token = issueToken(memberId);
      res.json({ token, ...familyState(q.deviceByToken.get(hashToken(token))) });
    })
  );

  // Notification buttons (Mark done / Snooze) come from the service worker, which has
  // no login token, so they are authorised with a per-item, per-member HMAC instead.
  app.post(
    '/api/push-action',
    wrap((req, res) => {
      const { itemId, memberId, sig, action } = req.body || {};
      if (!verifyAction(itemId, memberId, sig)) throw new HttpError(403, 'Bad signature');
      const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
      const row = member && q.item.get(itemId, member.family_id);
      if (!row) throw new HttpError(404, 'Not found');
      if (action === 'done') markDone(member, row, true);
      else if (action === 'snooze') snooze(member, row, 60);
      else throw bad('unknown action');
      res.json({ ok: true });
    })
  );

  // ---------- signed in ----------
  app.get('/api/state', auth, (req, res) => res.json(familyState(req.member)));

  app.patch(
    '/api/me',
    auth,
    wrap((req, res) => {
      const m = req.member;
      const name = req.body.name !== undefined ? str(req.body.name, 40) || m.name : m.name;
      const notify = req.body.notify !== undefined ? (req.body.notify ? 1 : 0) : m.notify;
      const tell = req.body.tellDone !== undefined ? (req.body.tellDone ? 1 : 0) : m.tell_done;
      db.prepare('UPDATE members SET name = ?, notify = ?, tell_done = ? WHERE id = ?').run(name, notify, tell, m.id);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/invites',
    auth,
    wrap((req, res) => {
      const code = newId(12);
      const linkDevice = !!req.body.linkDevice;
      const t = new Date();
      const exp = new Date(t.getTime() + (linkDevice ? 1 : 7 * 24) * 3600e3);
      db.prepare('INSERT INTO invites(code, family_id, created_by, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        code, req.familyId, req.member.id, linkDevice ? req.member.id : null, t.toISOString(), exp.toISOString()
      );
      const origin = process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.get('host')}`;
      res.json({ code, url: `${origin}/#join/${code}`, expiresAt: exp.toISOString() });
    })
  );

  app.post(
    '/api/children',
    auth,
    wrap((req, res) => {
      const name = str(req.body.name, 40);
      if (!name) throw bad('name is required');
      const count = db.prepare('SELECT COUNT(*) AS n FROM children WHERE family_id = ?').get(req.familyId).n;
      const id = newId();
      db.prepare('INSERT INTO children(id, family_id, name, grade, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, req.familyId, name, str(req.body.grade, 30), COLORS[count % COLORS.length], nowIso()
      );
      res.json({ id });
    })
  );

  app.patch(
    '/api/children/:id',
    auth,
    wrap((req, res) => {
      const c = db.prepare('SELECT * FROM children WHERE id = ? AND family_id = ?').get(req.params.id, req.familyId);
      if (!c) throw new HttpError(404, 'Not found');
      db.prepare('UPDATE children SET name = ?, grade = ? WHERE id = ?').run(
        str(req.body.name, 40) || c.name, req.body.grade !== undefined ? str(req.body.grade, 30) : c.grade, c.id
      );
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/children/:id',
    auth,
    wrap((req, res) => {
      db.prepare('DELETE FROM children WHERE id = ? AND family_id = ?').run(req.params.id, req.familyId);
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
      const children = q.children.all(req.familyId);
      const result = await extractItems(text, {
        children,
        today: startOfDay(new Date()),
        fallbackChildId: req.body.childId || null,
      });
      res.json(result);
    })
  );

  app.post(
    '/api/items',
    auth,
    wrap((req, res) => {
      const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [req.body];
      const t = nowIso();
      const ins = db.prepare(
        `INSERT INTO items(id, family_id, child_id, type, title, date, time, location, source, msg, rem, created_by, created_at, updated_at)
         VALUES (@id, @family_id, @childId, @type, @title, @date, @time, @location, @source, @msg, @rem, @created_by, @t, @t)`
      );
      const ids = [];
      db.transaction(() => {
        for (const body of list) {
          const it = itemFromBody(body);
          assertChild(req.familyId, it.childId);
          const id = newId();
          ins.run({ ...it, rem: JSON.stringify(it.rem), id, family_id: req.familyId, created_by: req.member.id, t });
          ids.push(id);
        }
        log(req.familyId, req.member.id, `added ${ids.length} item${ids.length > 1 ? 's' : ''}`);
      })();
      res.json({ ids });
    })
  );

  app.patch(
    '/api/items/:id',
    auth,
    wrap((req, res) => {
      const row = q.item.get(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      const it = itemFromBody(req.body, rowToItem(row));
      assertChild(req.familyId, it.childId);
      db.prepare(
        `UPDATE items SET child_id=@childId, type=@type, title=@title, date=@date, time=@time, location=@location,
         source=@source, msg=@msg, rem=@rem, updated_at=@t WHERE id=@id`
      ).run({ ...it, rem: JSON.stringify(it.rem), id: row.id, t: nowIso() });
      // If the date or time moved, reminders should fire again for the new schedule.
      if (it.date !== row.date || it.time !== row.time) db.prepare('DELETE FROM sent WHERE item_id = ?').run(row.id);
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/items/:id',
    auth,
    wrap((req, res) => {
      const row = q.item.get(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      db.prepare('DELETE FROM items WHERE id = ?').run(row.id);
      log(req.familyId, req.member.id, `deleted “${row.title}”`);
      res.json({ ok: true });
    })
  );

  function markDone(member, row, done) {
    db.prepare('UPDATE items SET done = ?, done_by = ?, done_at = ?, updated_at = ? WHERE id = ?').run(
      done ? 1 : 0, done ? member.name : null, done ? nowIso() : null, nowIso(), row.id
    );
    log(member.family_id, member.id, `${done ? 'marked' : 'reopened'} “${row.title}”${done ? ' done' : ''}`);
    if (!done) return;
    const others = db.prepare('SELECT id FROM members WHERE family_id = ? AND id != ? AND tell_done = 1').all(member.family_id, member.id);
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

  function snooze(member, row, minutes) {
    const at = new Date(Date.now() + minutes * 60000).toISOString();
    db.prepare('INSERT INTO snoozes(item_id, member_id, at) VALUES (?, ?, ?)').run(row.id, member.id, at);
    return at;
  }

  app.post(
    '/api/items/:id/done',
    auth,
    wrap((req, res) => {
      const row = q.item.get(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      markDone(req.member, row, req.body.done !== false);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/items/:id/snooze',
    auth,
    wrap((req, res) => {
      const row = q.item.get(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      const minutes = Math.min(Math.max(Number(req.body.minutes) || 60, 5), 24 * 60);
      res.json({ at: snooze(req.member, row, minutes) });
    })
  );

  app.post(
    '/api/push/subscribe',
    auth,
    wrap((req, res) => {
      const sub = req.body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) throw bad('bad subscription');
      db.prepare(
        `INSERT INTO push_subs(endpoint, member_id, sub, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, sub = excluded.sub`
      ).run(sub.endpoint, req.member.id, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), nowIso());
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/push/unsubscribe',
    auth,
    wrap((req, res) => {
      db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?').run(str(req.body.endpoint, 2000), req.member.id);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/push/test',
    auth,
    wrap(async (req, res) => {
      limit('test:' + req.member.id, 10, 3600e3);
      const row = db.prepare('SELECT * FROM items WHERE family_id = ? AND done = 0 ORDER BY date, time LIMIT 1').get(req.familyId);
      const payload = row
        ? buildNotification(rowToItem(row), row.child_id ? db.prepare('SELECT * FROM children WHERE id = ?').get(row.child_id) : null, req.member.id)
        : { title: 'School Tracker', body: 'Notifications are working on this device.', tag: 'test', url: '/' };
      const delivered = await pushToMember(db, req.member.id, payload);
      res.json({ delivered });
    })
  );

  app.post('/api/logout', auth, (req, res) => {
    const token = (req.get('authorization') || '').slice(7);
    db.prepare('DELETE FROM devices WHERE token_hash = ?').run(hashToken(token));
    res.json({ ok: true });
  });

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
