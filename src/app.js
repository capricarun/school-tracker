import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newId, newToken, hashToken, nowIso, rowToItem } from './db.js';
import { TYPES, defaultReminders, startOfDay, isValidKey, isCustom, MAX_CUSTOM, toYmd, reminderAt } from '../public/shared/reminders.js';
import { extractItems, extractFromChat } from './extract.js';
import { undatedItem } from './parser.js';
import { pushToMember, vapidPublicKey, verifyAction } from './push.js';
import { buildNotification, status as schedulerStatus, dayWord, fmtTime } from './scheduler.js';
import { config } from './config.js';

const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COLORS = ['#0E6B5E', '#B4561A', '#1D4E89', '#7A3E9D', '#8A6D00'];

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
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    next();
  });

  const SQL = {
    deviceByToken: 'SELECT m.*, d.label AS device_label FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token_hash = ?',
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
    // A Shortcut key can only add items; it can't read the family's data.
    if (member.device_label === 'shortcut' && req.originalUrl.split('?')[0] !== '/api/quick-add') throw new HttpError(403, 'This key can only add items');
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
    rem = [...new Set(rem.filter((k) => typeof k === 'string' && isValidKey(k)))];
    if (rem.filter(isCustom).length > MAX_CUSTOM) throw bad(`At most ${MAX_CUSTOM} custom reminders per item`);
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
      // An undated item stays "no date" until someone picks a real date for it.
      noDate: body.noDate !== undefined ? !!body.noDate : body.date !== undefined && body.date !== base.date ? false : !!base.noDate,
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
    const [family, members, children, items, activity, atts] = await Promise.all([
      db.get('SELECT * FROM families WHERE id = ?', [fid]),
      db.all('SELECT id, name, role, notify, tell_done, created_at FROM members WHERE family_id = ? ORDER BY created_at', [fid]),
      db.all('SELECT id, name, grade, color FROM children WHERE family_id = ? ORDER BY created_at', [fid]),
      db.all('SELECT * FROM items WHERE family_id = ? ORDER BY date, time', [fid]),
      db.all(
        `SELECT a.text, a.at, m.name AS who FROM activity a LEFT JOIN members m ON m.id = a.member_id
         WHERE a.family_id = ? ORDER BY a.id DESC LIMIT 20`,
        [fid]
      ),
      db.all(
        `SELECT a.id, a.item_id, a.kind, a.name, a.type, a.size, a.text, a.created_at, m.name AS by
         FROM attachments a LEFT JOIN members m ON m.id = a.created_by WHERE a.family_id = ? ORDER BY a.created_at`,
        [fid]
      ),
    ]);
    const attByItem = new Map();
    for (const a of atts) {
      if (!attByItem.has(a.item_id)) attByItem.set(a.item_id, []);
      attByItem.get(a.item_id).push({
        id: a.id, kind: a.kind, name: a.name, type: a.type, size: Number(a.size), text: a.kind === 'note' ? a.text : undefined,
        createdAt: a.created_at, by: a.by || null,
      });
    }
    return {
      me: { id: member.id, name: member.name, role: member.role, notify: !!member.notify, tellDone: !!member.tell_done },
      family: { id: family.id, name: family.name },
      members: members.map((m) => ({ id: m.id, name: m.name, role: m.role, notify: !!m.notify })),
      children,
      items: items.map((r) => ({ ...rowToItem(r), attachments: attByItem.get(r.id) || [] })),
      activity,
      vapidPublicKey: vapidPublicKey(),
      aiEnabled: !!config.anthropicKey,
      hasShortcutKey: !!(await db.get("SELECT 1 AS x FROM devices WHERE member_id = ? AND label = 'shortcut'", [member.id])),
    };
  }

  // ---------- public ----------
  app.get(
    '/healthz',
    wrap(async (req, res) => {
      await db.get('SELECT 1 AS ok');
      res.json({
        ok: true,
        version: APP_VERSION,
        commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || undefined,
        features: ['quick-add-form', 'photos', 'links', 'undated'],
        time: new Date().toString(),
      });
    })
  );

  app.post(
    '/api/family',
    wrap(async (req, res) => {
      if (!config.allowSignup) throw new HttpError(403, 'New families are disabled on this server');
      limit('signup:' + req.ip, config.signupsPerHour, 3600e3);
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

  const INSERT_ITEM = `INSERT INTO items(id, family_id, child_id, type, title, date, time, location, source, msg, rem, created_by, created_at, updated_at, no_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
          [ids[k], req.familyId, it.childId, it.type, it.title, it.date, it.time, it.location, it.source, it.msg, JSON.stringify(it.rem), req.member.id, t, t, it.noDate ? 1 : 0],
        ]),
        logStmt(req.familyId, req.member.id, `added ${ids.length} item${ids.length > 1 ? 's' : ''}`),
      ]);
      res.json({ ids });
      notifyNewItems(req.member, items, ids).catch((err) => console.warn('[push] new-item notice failed', err.message));
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
          `UPDATE items SET child_id = ?, type = ?, title = ?, date = ?, time = ?, location = ?, source = ?, msg = ?, rem = ?, no_date = ?, updated_at = ? WHERE id = ?`,
          [it.childId, it.type, it.title, it.date, it.time, it.location, it.source, it.msg, JSON.stringify(it.rem), it.noDate ? 1 : 0, nowIso(), row.id],
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
        ['DELETE FROM attachments WHERE item_id = ?', [row.id]],
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

  // Tell everyone else in the family (with reminders on) that new school items arrived.
  async function notifyNewItems(member, items, ids) {
    const others = await db.all('SELECT id FROM members WHERE family_id = ? AND id != ? AND notify = 1', [member.family_id, member.id]);
    if (!others.length || !items.length) return;
    const first = items[0];
    const payload =
      items.length === 1
        ? { title: `New: ${first.title}`, body: `${first.noDate ? 'No date given' : dayWord(first.date) + (first.time ? ' at ' + fmtTime(first.time) : '')} · added by ${member.name}`, tag: `new-${ids[0]}`, url: `/#item/${ids[0]}` }
        : { title: `${items.length} new school items`, body: items.slice(0, 3).map((i) => i.title).join(' · ') + ` · added by ${member.name}`, tag: `new-${ids[0]}`, url: '/#home' };
    for (const o of others) await pushToMember(db, o.id, payload);
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

  // ---------- attachments ----------
  const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp|heic|heif)|application\/pdf|text\/plain)$/;
  async function assertRoom(familyId, adding) {
    const { used } = await db.get('SELECT COALESCE(SUM(size), 0) AS used FROM attachments WHERE family_id = ?', [familyId]);
    if (Number(used) + adding > config.maxFamilyStorageMb * 1048576) {
      throw new HttpError(413, `Storage is full (${config.maxFamilyStorageMb} MB). Delete old attachments first.`);
    }
  }

  app.post(
    '/api/items/:id/attachments',
    auth,
    express.raw({ type: () => true, limit: `${config.maxFileMb + 1}mb` }),
    wrap(async (req, res) => {
      const row = await getItem(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!data.length) throw bad('Empty file');
      if (data.length > config.maxFileMb * 1048576) throw new HttpError(413, `Files can be up to ${config.maxFileMb} MB`);
      await assertRoom(req.familyId, data.length);
      let name = 'file';
      try { name = decodeURIComponent(req.get('x-filename') || 'file'); } catch { /* keep default */ }
      name = name.replace(/[\\/\r\n"]/g, '_').slice(0, 120) || 'file';
      const type = String(req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
      const id = newId();
      await db.batch([
        [
          'INSERT INTO attachments(id, item_id, family_id, kind, name, type, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, row.id, req.familyId, 'file', name, type, data.length, data, req.member.id, nowIso()],
        ],
        logStmt(req.familyId, req.member.id, `attached “${name}” to “${row.title}”`),
      ]);
      res.json({ id });
    })
  );

  app.post(
    '/api/items/:id/notes',
    auth,
    wrap(async (req, res) => {
      const row = await getItem(req.params.id, req.familyId);
      if (!row) throw new HttpError(404, 'Not found');
      const text = typeof req.body.text === 'string' ? req.body.text.slice(0, 20000) : '';
      if (!text.trim()) throw bad('Nothing to save');
      const name = str(req.body.name, 80) || 'Pasted note';
      const size = Buffer.byteLength(text);
      await assertRoom(req.familyId, size);
      const id = newId();
      await db.batch([
        [
          'INSERT INTO attachments(id, item_id, family_id, kind, name, type, size, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, row.id, req.familyId, 'note', name, 'text/plain', size, text, req.member.id, nowIso()],
        ],
        logStmt(req.familyId, req.member.id, `added a note to “${row.title}”`),
      ]);
      res.json({ id });
    })
  );

  app.get(
    '/api/attachments/:id',
    auth,
    wrap(async (req, res) => {
      const a = await db.get('SELECT * FROM attachments WHERE id = ? AND family_id = ?', [req.params.id, req.familyId]);
      if (!a) throw new HttpError(404, 'Not found');
      const body = a.kind === 'note' ? Buffer.from(a.text || '', 'utf8') : Buffer.from(a.data);
      const inline = SAFE_INLINE.test(a.type);
      res.setHeader('Content-Type', inline ? (a.kind === 'note' ? 'text/plain; charset=utf-8' : a.type) : 'application/octet-stream');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.end(body);
    })
  );

  app.delete(
    '/api/attachments/:id',
    auth,
    wrap(async (req, res) => {
      const a = await db.get('SELECT id, name FROM attachments WHERE id = ? AND family_id = ?', [req.params.id, req.familyId]);
      if (!a) throw new HttpError(404, 'Not found');
      await db.batch([
        ['DELETE FROM attachments WHERE id = ?', [a.id]],
        logStmt(req.familyId, req.member.id, `removed attachment “${a.name}”`),
      ]);
      res.json({ ok: true });
    })
  );

  // ---------- reminder diagnostics ----------
  app.get(
    '/api/diag',
    auth,
    wrap(async (req, res) => {
      const now = new Date();
      const [{ n: subs }, sent] = await Promise.all([
        db.get('SELECT COUNT(*) AS n FROM push_subs WHERE member_id = ?', [req.member.id]),
        db.all(
          `SELECT s.rem_key, s.sent_at, i.title FROM sent s JOIN items i ON i.id = s.item_id
           WHERE s.member_id = ? ORDER BY s.sent_at DESC LIMIT 5`,
          [req.member.id]
        ),
      ]);
      res.json({
        serverTime: now.toISOString(),
        serverLocal: now.toString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMinutes: -now.getTimezoneOffset(),
        startedAt: schedulerStatus.startedAt,
        lastTickAt: schedulerStatus.lastTickAt,
        lastError: schedulerStatus.lastError,
        subscriptions: Number(subs),
        notify: !!req.member.notify,
        recentSent: sent.map((r) => ({ key: r.rem_key, at: r.sent_at, title: r.title })),
        recentDeliveries: schedulerStatus.recent.filter((r) => r.memberId === req.member.id).slice(0, 5),
      });
    })
  );

  // ---------- WhatsApp group import ----------
  // The phone parses the exported chat and sends only recent messages; the server skips any it
  // has already seen for this family, extracts items, and returns them as drafts for review.
  app.post(
    '/api/import/chat',
    auth,
    wrap(async (req, res) => {
      limit('import:' + req.member.id, 20, 3600e3);
      const chatName = str(req.body.chatName, 80) || 'WhatsApp group';
      const raw = Array.isArray(req.body.messages) ? req.body.messages.slice(-400) : [];
      const messages = raw
        .filter((m) => m && typeof m.id === 'string' && isYmd(m.date) && isHm(m.time) && typeof m.text === 'string')
        .map((m) => ({ id: m.id.slice(0, 40), date: m.date, time: m.time, sender: str(m.sender, 60), text: m.text.slice(0, 4000) }));
      const seen = new Set();
      for (let i = 0; i < messages.length; i += 200) {
        const chunk = messages.slice(i, i + 200);
        const rows = await db.all(
          `SELECT msg_id FROM chat_seen WHERE family_id = ? AND msg_id IN (${chunk.map(() => '?').join(',')})`,
          [req.familyId, ...chunk.map((m) => m.id)]
        );
        rows.forEach((r) => seen.add(r.msg_id));
      }
      const fresh = messages.filter((m) => !seen.has(m.id));
      const children = await db.all('SELECT id, name, grade, color FROM children WHERE family_id = ? ORDER BY created_at', [req.familyId]);
      const result = fresh.length
        ? await extractFromChat(fresh, { children, today: startOfDay(new Date()), chatName })
        : { engine: config.anthropicKey ? 'claude' : 'rules', items: [] };
      res.json({ ...result, chatName, total: messages.length, alreadySeen: seen.size, newMessages: fresh.length, newIds: fresh.map((m) => m.id) });
    })
  );

  app.post(
    '/api/import/seen',
    auth,
    wrap(async (req, res) => {
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((x) => typeof x === 'string').slice(0, 1000);
      const chat = str(req.body.chatName, 80);
      const t = nowIso();
      for (let i = 0; i < ids.length; i += 100) {
        await db.batch(ids.slice(i, i + 100).map((id) => ['INSERT OR IGNORE INTO chat_seen(family_id, msg_id, chat, seen_at) VALUES (?, ?, ?, ?)', [req.familyId, id.slice(0, 40), chat, t]]));
      }
      if (ids.length) await log(req.familyId, req.member.id, `imported ${ids.length} message${ids.length > 1 ? 's' : ''} from ${chat || 'WhatsApp'}`);
      res.json({ ok: true });
    })
  );

  // ---------- iPhone Shortcut / quick add ----------
  // iOS doesn't let web apps appear in the Share menu, so an iPhone Shortcut posts shared text here
  // with a personal key. Items are extracted and saved straight away, and the family is notified.
  app.post(
    '/api/shortcut-key',
    auth,
    wrap(async (req, res) => {
      const key = newToken();
      await db.batch([
        ["DELETE FROM devices WHERE member_id = ? AND label = 'shortcut'", [req.member.id]],
        ["INSERT INTO devices(token_hash, member_id, created_at, label) VALUES (?, ?, ?, 'shortcut')", [hashToken(key), req.member.id, nowIso()]],
      ]);
      const origin = process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.get('host')}`;
      res.json({ key, url: `${origin}/api/quick-add` });
    })
  );

  app.delete(
    '/api/shortcut-key',
    auth,
    wrap(async (req, res) => {
      await db.run("DELETE FROM devices WHERE member_id = ? AND label = 'shortcut'", [req.member.id]);
      res.json({ ok: true });
    })
  );

  // Reminder for an undated item: 7 PM today, or 8 AM tomorrow if it's already evening.
  function undatedReminders(now = new Date()) {
    const at = new Date(now);
    if (now.getHours() < 18 || (now.getHours() === 18 && now.getMinutes() < 45)) at.setHours(19, 0, 0, 0);
    else { at.setDate(at.getDate() + 1); at.setHours(8, 0, 0, 0); }
    const p = (n) => String(n).padStart(2, '0');
    return [`c:${toYmd(at)}T${p(at.getHours())}:${p(at.getMinutes())}`];
  }

  // Compare titles by their letters and digits in any script (Tamil, Hindi… not just English).
  const normTitle = (t) => String(t).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

  app.post(
    '/api/quick-add',
    express.text({ type: 'text/*', limit: '64kb' }),
    express.urlencoded({ extended: false, limit: '64kb' }),
    auth,
    // The iPhone Shortcut sends a form with the text and any shared photos/PDFs.
    multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxFileMb * 1048576 * 2, files: 6, fieldSize: 64 * 1024 } }).any(),
    wrap(async (req, res) => {
      limit('quick:' + req.member.id, 60, 3600e3);
      const files = (req.files || [])
        .filter((f) => f.size > 0 && f.size <= config.maxFileMb * 1048576 * 2 && !/^text\//.test(f.mimetype))
        .map((f) => ({
          name: (f.originalname || 'whatsapp-photo').replace(/[\\/\r\n"]/g, '_').slice(0, 120),
          type: f.mimetype === 'application/octet-stream' && /\.(jpe?g)$/i.test(f.originalname || '') ? 'image/jpeg' : f.mimetype,
          data: f.buffer,
        }));
      // A Shortcut may also send the text as a .txt file part.
      const textPart = (req.files || []).find((f) => /^text\//.test(f.mimetype));
      if (textPart && !req.body?.text) req.body = { ...(req.body || {}), text: textPart.buffer.toString('utf8') };
      const b = req.body;
      // Prefer "text", but accept any field name a Shortcut might have used (e.g. "Text", "message").
      const raw = typeof b === 'string' ? b
        : typeof b?.text === 'string' ? b.text
          : Object.values(b || {}).find((v) => typeof v === 'string' && v.trim().length > 3);
      const text = typeof raw === 'string' ? raw.trim().slice(0, 6000) : '';
      if (!text && !files.length) {
        const parts = Object.keys(req.body || {}).concat((req.files || []).map((f) => f.fieldname));
        console.warn(`[quick-add] empty share from ${req.member.name}: content-type=${req.get('content-type')}, fields=[${parts.join(',')}]`);
        if (req.is('multipart/form-data') && parts.length) {
          return res.json({
            ok: false, added: 0,
            message: `School Tracker got the share but no text or photo in it (fields: ${parts.join(', ') || 'none'}). In the Shortcut's Form, set text = Text and photo = Images.`,
          });
        }
        // Running the Shortcut from the Shortcuts app (no shared text) is a handy connection test.
        return res.json({ ok: true, added: 0, message: `Connected to School Tracker as ${req.member.name}. Now share a WhatsApp message to it.` });
      }
      const children = await db.all('SELECT id, name, grade, color FROM children WHERE family_id = ? ORDER BY created_at', [req.familyId]);
      const today = startOfDay(new Date());
      const { engine, items: found } = await extractItems(text, { children, today, images: files });
      const todayYmd = toYmd(today);
      // Only open (not done) items count as duplicates; deleted items are gone from the table.
      const existingRows = await db.all('SELECT id, title, date, no_date FROM items WHERE family_id = ? AND date >= ? AND done = 0', [req.familyId, todayYmd]);
      const existingId = new Map(
        existingRows.filter((r) => normTitle(r.title)).map((r) => [`${r.date}|${normTitle(r.title)}`, r.id])
      );
      const existing = new Set(existingId.keys());
      const fresh = [];
      const dupIds = [];
      for (const f of found) {
        const k = normTitle(f.title) ? `${f.date}|${normTitle(f.title)}` : `${f.date}|#${Math.random()}`;
        if (f.date < todayYmd) continue;
        if (existing.has(k)) { if (existingId.get(k)) dupIds.push(existingId.get(k)); continue; }
        existing.add(k);
        fresh.push(f);
      }
      const source = str(req.get('x-source') || req.body?.source, 40) || 'WhatsApp';
      const t = nowIso();
      const items = fresh.map((f) => ({
        ...itemFromBody({ title: f.title, type: f.type, childId: f.childId, date: f.date, time: f.time, location: f.location, source, msg: text }),
      }));
      // No date anywhere in the message: still track it, for today, with a nudge this evening.
      let undated = false;
      if (!found.length) {
        const u = text ? undatedItem(text, { children }) : { title: files.some((f) => f.type === 'application/pdf') ? 'Document from WhatsApp' : 'Photo from WhatsApp', type: 'Event', childId: children[0]?.id || null, time: '', location: '', line: '' };
        const uk = normTitle(u.title) ? `${todayYmd}|${normTitle(u.title)}` : `${todayYmd}|#${Date.now()}`;
        if (existingId.get(uk)) dupIds.push(existingId.get(uk));
        if (!existing.has(uk) || (!text && files.length)) {
          undated = true;
          items.push(itemFromBody({ ...u, date: todayYmd, source, msg: text, noDate: true, rem: undatedReminders() }));
        }
      }
      const ids = items.map(() => newId());
      if (items.length) {
        await db.batch([
          ...items.map((it, k) => [
            INSERT_ITEM,
            [ids[k], req.familyId, it.childId, it.type, it.title, it.date, it.time, it.location, it.source, it.msg, JSON.stringify(it.rem), req.member.id, t, t, it.noDate ? 1 : 0],
          ]),
          logStmt(req.familyId, req.member.id, `shared ${items.length} item${items.length > 1 ? 's' : ''} from ${source}`),
        ]);
        notifyNewItems(req.member, items, ids).catch(() => {});
      }
      // Keep shared photos/PDFs with the items they came from (or the matching existing item).
      const attachTo = ids.length ? ids : [...new Set(dupIds)].slice(0, 1);
      let attached = 0;
      if (files.length && attachTo.length) {
        const total = files.reduce((n, f) => n + f.data.length, 0) * attachTo.length;
        await assertRoom(req.familyId, total);
        const stmts = [];
        for (const itemId of attachTo) {
          for (const f of files) {
            // Skip a photo already attached to this item (same name and size): re-sharing shouldn't duplicate it.
            const dup = await db.get('SELECT 1 AS x FROM attachments WHERE item_id = ? AND name = ? AND size = ?', [itemId, f.name, f.data.length]);
            if (dup) continue;
            stmts.push([
              'INSERT INTO attachments(id, item_id, family_id, kind, name, type, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [newId(), itemId, req.familyId, 'file', f.name, f.type, f.data.length, f.data, req.member.id, nowIso()],
            ]);
            attached++;
          }
        }
        if (stmts.length) await db.batch(stmts);
      }
      const when = (it) => `${dayWord(it.date)}${it.time ? ' ' + fmtTime(it.time) : ''}`;
      const nudge = undated && reminderAt({}, items[0].rem[0]);
      const photoNote = attached ? ` (+ ${attached} ${files.every((f) => f.type.startsWith('image/')) ? 'photo' : 'file'}${attached > 1 ? 's' : ''})` : '';
      const message = (!items.length && attached)
        ? `Photo added to the existing item: ${existingRows.find((r) => r.id === attachTo[0])?.title || 'school item'}`
        : undated
        ? `No date in the message${photoNote}, so it's saved for today with a reminder ${nudge ? (nudge.getDate() === new Date().getDate() ? 'at ' : 'tomorrow at ') + fmtTime(String(nudge.getHours()).padStart(2, '0') + ':' + String(nudge.getMinutes()).padStart(2, '0')) : 'later'}: ${items[0].title}`
        : items.length
        ? `Added ${items.length}${photoNote}: ${items.map((it) => `${it.title} (${when(it)})`).join(' · ')}`
        : (() => {
            const m = existingRows.find((r) => r.id === dupIds[0]);
            if (m) return `Already in School Tracker: "${m.title}" (${m.no_date ? 'today, no date' : dayWord(m.date)}). Nothing new added. Delete or finish it in the app to share it again.`;
            return found.length ? 'That date has already passed, so nothing was added.' : 'Nothing new to add from that message.';
          })();
      if (!items.length) console.log(`[quick-add] nothing added; duplicate of [${dupIds.join(',')}] for "${(text || '').slice(0, 60).replace(/\s+/g, ' ')}"`);
      console.log(`[quick-add] ${req.member.name}: found ${found.length}, added ${items.length}, files ${files.length}/${attached} attached (${engine})`);
      res.json({ ok: true, engine, added: items.length, message, ids });
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
    const error = status >= 500 ? 'Something went wrong' : err.message;
    // The iPhone Shortcut shows the "message" field in its banner, so explain failures there too.
    const forShortcut =
      status === 401 ? 'School Tracker did not accept the key. In the app go to Family → Share from WhatsApp → Set up again, and paste the new key into the Shortcut header.'
        : status === 403 ? 'This key can only add items.'
          : status === 429 ? 'Too many shares in the last hour. Try again later.'
            : `School Tracker: ${error}`;
    if (req.originalUrl.startsWith('/api/quick-add')) console.warn(`[quick-add] ${status} ${error}`);
    res.status(status).json({ error, message: forShortcut });
  });

  return app;
}
