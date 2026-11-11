import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export function openDb(file = path.join(config.dataDir, 'school-tracker.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      notify INTEGER NOT NULL DEFAULT 1, tell_done INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL, member_id TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      name TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#0E6B5E',
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      child_id TEXT REFERENCES children(id) ON DELETE SET NULL,
      type TEXT NOT NULL, title TEXT NOT NULL,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', msg TEXT NOT NULL DEFAULT '',
      rem TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0, done_by TEXT, done_at TEXT,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS items_family ON items(family_id, done, date);
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      sub TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sent (
      item_id TEXT NOT NULL, rem_key TEXT NOT NULL, member_id TEXT NOT NULL, sent_at TEXT NOT NULL,
      PRIMARY KEY (item_id, rem_key, member_id));
    CREATE TABLE IF NOT EXISTS snoozes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      at TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      member_id TEXT, text TEXT NOT NULL, at TEXT NOT NULL);
  `);
  return db;
}

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const nowIso = () => new Date().toISOString();

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function rowToItem(r) {
  return {
    id: r.id,
    childId: r.child_id,
    type: r.type,
    title: r.title,
    date: r.date,
    time: r.time,
    location: r.location,
    source: r.source,
    msg: r.msg,
    rem: JSON.parse(r.rem || '[]'),
    done: !!r.done,
    doneBy: r.done_by,
    doneAt: r.done_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
