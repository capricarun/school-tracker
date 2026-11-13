// Storage adapter with one async API and two backends:
//  - Turso / libSQL (hosted SQLite) when TURSO_DATABASE_URL is set — use this on hosts
//    without a persistent disk, e.g. Render's free plan.
//  - Node's built-in SQLite file (node:sqlite) otherwise — local dev, VMs, Docker with a volume.
// All SQL uses positional "?" parameters so it runs unchanged on both.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL,
    name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    notify INTEGER NOT NULL DEFAULT 1, tell_done INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY, family_id TEXT NOT NULL, created_by TEXT NOT NULL, member_id TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL,
    name TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#0E6B5E',
    created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL, child_id TEXT,
    type TEXT NOT NULL, title TEXT NOT NULL,
    date TEXT NOT NULL, time TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', msg TEXT NOT NULL DEFAULT '', rem TEXT NOT NULL DEFAULT '[]',
    done INTEGER NOT NULL DEFAULT 0, done_by TEXT, done_at TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, no_date INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS items_family ON items(family_id, done, date);
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, member_id TEXT NOT NULL, sub TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS push_subs_member ON push_subs(member_id);
  CREATE TABLE IF NOT EXISTS sent (
    item_id TEXT NOT NULL, rem_key TEXT NOT NULL, member_id TEXT NOT NULL, sent_at TEXT NOT NULL,
    PRIMARY KEY (item_id, rem_key, member_id));
  CREATE TABLE IF NOT EXISTS snoozes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, member_id TEXT NOT NULL,
    at TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, family_id TEXT NOT NULL,
    kind TEXT NOT NULL,            -- 'file' (data in BLOB) or 'note' (pasted text)
    name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
    data BLOB, text TEXT,
    created_by TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS attachments_item ON attachments(item_id);
  CREATE INDEX IF NOT EXISTS attachments_family ON attachments(family_id);
  CREATE TABLE IF NOT EXISTS chat_seen (
    family_id TEXT NOT NULL, msg_id TEXT NOT NULL, chat TEXT NOT NULL DEFAULT '', seen_at TEXT NOT NULL,
    PRIMARY KEY (family_id, msg_id));
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, family_id TEXT NOT NULL, member_id TEXT, text TEXT NOT NULL, at TEXT NOT NULL);
`;

const plain = (row) => (row ? { ...row } : undefined);

async function nodeSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return {
    kind: 'sqlite-file',
    async get(sql, args = []) { return plain(raw.prepare(sql).get(...args)); },
    async all(sql, args = []) { return raw.prepare(sql).all(...args).map(plain); },
    async run(sql, args = []) { const r = raw.prepare(sql).run(...args); return { changes: Number(r.changes) }; },
    async exec(sql) { raw.exec(sql); },
    /** Run [sql, args] pairs atomically. */
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        for (const [sql, args = []] of stmts) raw.prepare(sql).run(...args);
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close() { raw.close(); },
  };
}

async function libsql(url, authToken) {
  // Remote URLs use the pure-HTTP client (no native module); file: URLs (tests) use the full client.
  const mod = /^file:/.test(url) ? await import('@libsql/client') : await import('@libsql/client/web');
  const client = mod.createClient({ url, authToken: authToken || undefined });
  const rows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
  return {
    kind: 'libsql',
    async get(sql, args = []) { return rows(await client.execute({ sql, args }))[0]; },
    async all(sql, args = []) { return rows(await client.execute({ sql, args })); },
    async run(sql, args = []) { const r = await client.execute({ sql, args }); return { changes: r.rowsAffected }; },
    async exec(sql) { await client.executeMultiple(sql); },
    async batch(stmts) { await client.batch(stmts.map(([sql, args = []]) => ({ sql, args })), 'write'); },
    close() { client.close(); },
  };
}

export async function openDb({ url = config.databaseUrl, authToken = config.databaseToken, file } = {}) {
  const db = url ? await libsql(url, authToken) : await nodeSqlite(file || path.join(config.dataDir, 'school-tracker.db'));
  await db.exec(SCHEMA);
  // Migrations for databases created by earlier versions.
  for (const sql of [
    "ALTER TABLE devices ADD COLUMN label TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE items ADD COLUMN no_date INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { await db.exec(sql); } catch { /* column already exists */ }
  }
  return db;
}

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const nowIso = () => new Date().toISOString();

export async function getSetting(db, key) {
  return (await db.get('SELECT value FROM settings WHERE key = ?', [key]))?.value ?? null;
}
export async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

export function rowToItem(r) {
  return {
    id: r.id,
    familyId: r.family_id,
    childId: r.child_id,
    type: r.type,
    title: r.title,
    date: r.date,
    time: r.time,
    location: r.location,
    source: r.source,
    msg: r.msg,
    rem: JSON.parse(r.rem || '[]'),
    noDate: !!r.no_date,
    done: !!r.done,
    doneBy: r.done_by,
    doneAt: r.done_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
