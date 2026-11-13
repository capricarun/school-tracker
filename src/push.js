import webpush from 'web-push';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';

let publicKey = '';
let actionSecret = '';

/** Load VAPID keys from env, or generate once and keep them in the database. */
export async function initPush(db) {
  let pub = config.vapidPublic;
  let priv = config.vapidPrivate;
  if (!pub || !priv) {
    pub = await getSetting(db, 'vapid_public');
    priv = await getSetting(db, 'vapid_private');
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      await setSetting(db, 'vapid_public', pub);
      await setSetting(db, 'vapid_private', priv);
      console.log('[push] generated VAPID keys (stored in the database)');
    }
  }
  webpush.setVapidDetails(config.vapidSubject, pub, priv);
  publicKey = pub;

  actionSecret = await getSetting(db, 'action_secret');
  if (!actionSecret) {
    actionSecret = crypto.randomBytes(32).toString('hex');
    await setSetting(db, 'action_secret', actionSecret);
  }
}

export const vapidPublicKey = () => publicKey;

/** Signature that lets the service worker act on a notification without the login token. */
export function signAction(itemId, memberId) {
  return crypto.createHmac('sha256', actionSecret).update(`${itemId}:${memberId}`).digest('base64url');
}
export function verifyAction(itemId, memberId, sig) {
  const want = Buffer.from(signAction(itemId, memberId));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Send a payload to every device a member has subscribed. Removes dead subscriptions. */
export async function pushToMember(db, memberId, payload) {
  const subs = await db.all('SELECT endpoint, sub FROM push_subs WHERE member_id = ?', [memberId]);
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' });
      delivered++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.run('DELETE FROM push_subs WHERE endpoint = ?', [s.endpoint]);
      } else {
        console.warn('[push] send failed', err.statusCode || '', err.message);
      }
    }
  }
  return delivered;
}
