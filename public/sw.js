// Service worker: offline app shell + push notifications with action buttons.
const CACHE = 'st-shell-v2';
const SHELL = ['/', '/app.js', '/app.css', '/shared/reminders.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first for the shell so updates land quickly; never cache the API.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data.json(); } catch { p = { title: 'School Tracker', body: e.data && e.data.text() }; }
  const actionable = p.itemId && p.sig;
  e.waitUntil(
    self.registration
      .showNotification(p.title || 'School Tracker', {
        body: p.body || '',
        tag: p.tag,
        renotify: !!p.tag,
        silent: !!p.silent,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: p,
        actions: actionable
          ? [
              { action: 'done', title: 'Mark done' },
              { action: 'snooze', title: 'Snooze 1 hr' },
            ]
          : [],
      })
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((cs) => cs.forEach((c) => c.postMessage({ type: 'refresh' })))
  );
});

self.addEventListener('notificationclick', (e) => {
  const p = e.notification.data || {};
  e.notification.close();
  if ((e.action === 'done' || e.action === 'snooze') && p.itemId) {
    e.waitUntil(
      fetch('/api/push-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: p.itemId, memberId: p.memberId, sig: p.sig, action: e.action }),
      })
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((cs) => cs.forEach((c) => c.postMessage({ type: 'refresh' })))
        .catch(() => {})
    );
    return;
  }
  const target = p.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ('focus' in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
