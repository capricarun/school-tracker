import {
  TYPES, REMINDERS, reminderAt, upcomingReminders, daysFromToday, parseYmd, defaultReminders, toYmd,
  isCustom, MAX_CUSTOM, pad,
} from './shared/reminders.js';
import { parseWhatsAppExport, chatNameFromFile } from './shared/whatsapp.js';
import { readChatFile } from './shared/unzip.js';

/* ---------------- helpers ---------------- */
const $app = document.getElementById('app');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SOURCES = ['WhatsApp', 'School app', 'Email / SMS'];
const TOKEN_KEY = 'st_token';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function fmtClock(d) { return fmtTime(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')); }
function dayLabel(d) {
  const n = daysFromToday(toYmd(d));
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return WDL[d.getDay()];
  return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}
const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'hidden'].includes(el.type)));
const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());

const ICON = {
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  bellSm: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  plus: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  people: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5a4.5 4.5 0 0 1 4.5 4.5"/></svg>',
  spark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
  pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  msg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  clip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  file: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  note: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4h8M6 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M8 10h8M8 14h8M8 18h5"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
};

/* ---------------- state ---------------- */
const S = {
  token: store.get(TOKEN_KEY),
  data: null, // server state: me, family, members, children, items, activity, vapidPublicKey, aiEnabled
  loading: true,
  route: 'home',
  param: null,
  filter: 'all',
  showDone: false,
  src: 'WhatsApp',
  text: '',
  drafts: [],
  engine: '',
  extracting: false,
  saving: false,
  toast: '',
  push: 'checking', // unsupported | ios-install | default | denied | on | checking
  invite: null, // { url, expiresAt, linkDevice }
  joinInfo: null,
  onboard: { memberName: '', familyName: '', kids: [{ name: '', grade: '' }], joinName: '' },
  addChild: { name: '', grade: '' },
  confirmDelete: false,
  error: '',
  customRem: '', // datetime-local value for a new custom reminder on the open item
  noteDraft: null, // text being pasted as a note on the open item
  uploading: 0,
  viewer: null, // { att, url, text, confirmDelete }
  diag: null, // result of the reminder check
  importDays: 14, // how far back to look on a first import
  importing: false,
  importInfo: null, // { chatName, ids, newMessages, alreadySeen } while reviewing an import
};
const blobUrls = new Map(); // attachment id -> object URL (thumbnails + viewer)
const blobData = new Map(); // attachment id -> Blob (for Share)

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) {
    setToken(null);
    S.data = null;
    render();
  }
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}
async function fetchBlob(id) {
  if (blobUrls.has(id)) return blobUrls.get(id);
  const res = await fetch('/api/attachments/' + id, { headers: { authorization: 'Bearer ' + S.token } });
  if (!res.ok) throw new Error('Could not open the file');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobUrls.set(id, url);
  blobData.set(id, blob);
  return url;
}
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const isImage = (a) => a.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(a.type);
const isPdf = (a) => a.kind === 'file' && a.type === 'application/pdf';
const toLocalInput = (d) => `${toYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function defaultCustomFor(it) {
  const d = parseYmd(it.date);
  d.setDate(d.getDate() - 1);
  d.setHours(18, 0, 0, 0);
  if (d > new Date()) return toLocalInput(d);
  const n = new Date(Date.now() + 3600e3);
  n.setMinutes(0, 0, 0);
  return toLocalInput(n);
}
const fmtWhen = (d) => `${dayLabel(d)}, ${fmtClock(d)}`;

function setToken(t) {
  S.token = t;
  store.set(TOKEN_KEY, t);
}
let toastTimer;
function toast(msg) {
  S.toast = msg;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = ''; render(); }, 3500);
}
async function refresh() {
  if (!S.token) return;
  try {
    S.data = await api('/api/state');
  } catch (e) {
    if (S.token) S.error = e.message;
  }
  S.loading = false;
  render();
}

const kidOf = (id) => S.data?.children.find((c) => c.id === id) || null;
const itemOf = (id) => S.data?.items.find((i) => i.id === id) || null;

/* ---------------- routing ---------------- */
function go(hash) {
  if (location.hash === hash) onRoute();
  else location.hash = hash;
}
function onRoute() {
  const h = location.hash.replace(/^#/, '');
  const [route, param] = h.split('/');
  S.route = route || 'home';
  S.param = param || null;
  S.confirmDelete = false;
  S.customRem = '';
  S.noteDraft = null;
  S.viewer = null;
  if (S.route === 'join' && S.param) loadInvite(S.param);
  else if (S.token && S.data && (S.route === 'home' || S.route === 'family' || (S.route === 'item' && !itemOf(S.param)))) refresh();
  render();
  window.scrollTo(0, 0);
}
async function loadInvite(code) {
  S.joinInfo = { loading: true };
  render();
  try {
    S.joinInfo = { ...(await api('/api/invites/' + encodeURIComponent(code))), code };
  } catch (e) {
    S.joinInfo = { error: e.message };
  }
  render();
}

/* ---------------- push ---------------- */
let swReg = null;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function checkPush() {
  if (!('serviceWorker' in navigator)) { S.push = 'unsupported'; return; }
  try { swReg = await navigator.serviceWorker.register('/sw.js'); } catch { S.push = 'unsupported'; return; }
  if (!('PushManager' in window) || !('Notification' in window)) {
    S.push = isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
    return;
  }
  if (Notification.permission === 'denied') { S.push = 'denied'; return; }
  const sub = await swReg.pushManager.getSubscription();
  if (sub && Notification.permission === 'granted') {
    S.push = 'on';
    if (S.token) api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {});
  } else S.push = 'default';
}
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { S.push = perm === 'denied' ? 'denied' : 'default'; render(); return; }
    const reg = swReg || (await navigator.serviceWorker.ready);
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.data.vapidPublicKey) }));
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    S.push = 'on';
    toast('Reminders are on for this device');
  } catch (e) {
    toast('Could not turn on notifications: ' + e.message);
  }
}

/* ---------------- view pieces ---------------- */
function itemCard(it) {
  const k = kidOf(it.childId);
  const dd = daysFromToday(it.date);
  const d = parseYmd(it.date);
  if (it.done) {
    return `<div class="item done">
      <button class="check" data-act="toggle-done" data-id="${it.id}" aria-label="Mark not done: ${esc(it.title)}"><span>${ICON.check}</span></button>
      <button class="item-body" data-act="open" data-id="${it.id}">
        <span class="item-title">${esc(it.title)}</span>
        <span class="small">${k ? esc(k.name) + ' · ' : ''}done by ${esc(it.doneBy || 'someone')}</span>
      </button></div>`;
  }
  const up = upcomingReminders(it);
  const whenCls = dd < 0 ? 'overdue' : dd === 0 ? 'today' : '';
  const when = (dd < 0 ? 'Overdue · ' : '') + dayLabel(d) + (it.time ? ' · ' + fmtTime(it.time) : '');
  const next = up.length ? `Next reminder ${dayLabel(up[0])}, ${fmtClock(up[0])}` : dd <= 0 ? 'Due today — no more reminders' : 'No reminders on';
  return `<div class="item">
    <button class="check" data-act="toggle-done" data-id="${it.id}" aria-label="Mark done: ${esc(it.title)}"><span></span></button>
    <button class="item-body" data-act="open" data-id="${it.id}">
      <span class="row wrap" style="gap:8px">
        <span class="tag t-${it.type}">${it.type}</span>
        ${k ? `<span class="kid"><span class="dot" style="background:${esc(k.color)}"></span>${esc(k.name)}</span>` : ''}
      </span>
      <span class="item-title">${esc(it.title)}</span>
      <span class="when ${whenCls}">${esc(when)}</span>
      <span class="next">${ICON.bellSm}${esc(next)}${it.attachments?.length ? `<span class="row" style="gap:4px;margin-left:auto">${ICON.clip}${it.attachments.length}</span>` : ''}</span>
    </button></div>`;
}

function pushBanner() {
  const p = S.push;
  if (p === 'on' || p === 'checking') return '';
  if (p === 'ios-install') {
    return `<div class="hint">${ICON.share}<span><b>Get reminders on iPhone:</b> tap Share in Safari, then <b>Add to Home Screen</b>, and open School Tracker from your home screen.</span></div>`;
  }
  if (p === 'unsupported') return `<div class="hint">${ICON.bellSm}<span>This browser can't show reminders. Open the app in Chrome (Android) or add it to your iPhone home screen.</span></div>`;
  if (p === 'denied') return `<div class="hint">${ICON.bellSm}<span>Notifications are blocked for this site. Turn them on in your browser's site settings to get reminders.</span></div>`;
  return `<div class="card row" style="gap:12px;align-items:center">
    <span class="grow"><b style="display:block;font-size:15px">Turn on reminders</b><span class="small">So you get a nudge before every item — even when the app is closed.</span></span>
    <button class="btn primary small" data-act="enable-push">Turn on</button></div>`;
}

function nav() {
  if (['review'].includes(S.route)) return '';
  const cur = (r) => (S.route === r || (r === 'home' && S.route === 'item') ? 'aria-current="page"' : '');
  return `<nav class="bottom" aria-label="Main"><div class="inner">
    <button data-act="go" data-to="#home" ${cur('home')}>${ICON.home}Home</button>
    <button data-act="go" data-to="#add" aria-label="Add from a message"><span class="fab">${ICON.plus}</span></button>
    <button data-act="go" data-to="#family" ${cur('family')}>${ICON.people}Family</button>
  </div></nav>`;
}

/* ---------------- screens ---------------- */
function homeScreen() {
  const { items, children } = S.data;
  const pendAll = items.filter((i) => !i.done).sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
  const pend = pendAll.filter((i) => S.filter === 'all' || i.childId === S.filter);
  const done = items.filter((i) => i.done && (S.filter === 'all' || i.childId === S.filter)).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  const todayN = pendAll.filter((i) => daysFromToday(i.date) <= 0).length;
  const weekN = pendAll.filter((i) => daysFromToday(i.date) <= 7).length;
  const remN = pendAll.reduce((n, i) => n + upcomingReminders(i).length, 0);
  const groups = [
    ['Today', (d) => d <= 0],
    ['This week', (d) => d >= 1 && d <= 7],
    ['Later', (d) => d > 7],
  ]
    .map(([title, test]) => ({ title, list: pend.filter((i) => test(daysFromToday(i.date))) }))
    .filter((g) => g.list.length);
  const now = new Date();
  const headline = weekN === 0 ? "You're all caught up" : `${weekN} ${weekN > 1 ? 'things need' : 'thing needs'} you this week`;
  const filters = [{ id: 'all', name: 'All' }, ...children];

  return `<main class="screen">
    <header class="row between" style="align-items:flex-start">
      <div>
        <p class="small" style="margin:0;font-weight:500">${WDL[now.getDay()]}, ${now.getDate()} ${MON[now.getMonth()]}</p>
        <h1 style="margin-top:6px">${esc(headline)}</h1>
      </div>
      ${S.push === 'on' ? `<button class="icon-btn" data-act="test-push" aria-label="Send me a test reminder">${ICON.bell}</button>` : ''}
    </header>
    ${pushBanner()}
    <div class="grid3">
      <div class="card stat"><p>Due today</p><strong class="${todayN ? 'alert' : ''}">${todayN}</strong></div>
      <div class="card stat"><p>Next 7 days</p><strong>${weekN}</strong></div>
      <div class="card stat"><p>Reminders set</p><strong>${remN}</strong></div>
    </div>
    ${children.length > 1 ? `<div class="chips" role="group" aria-label="Filter by child">${filters
      .map((f) => `<button class="chip" data-act="filter" data-id="${f.id}" aria-pressed="${S.filter === f.id}">${esc(f.name)}</button>`)
      .join('')}</div>` : ''}
    ${groups
      .map((g) => `<section class="stack"><h2 class="eyebrow">${g.title} · ${g.list.length}</h2>${g.list.map(itemCard).join('')}</section>`)
      .join('')}
    ${!groups.length ? `<div class="card empty"><b style="font-size:16px">Nothing pending</b>
      <p class="sub" style="font-size:14px">Paste a message from school and we'll track it for you.</p>
      <button class="btn primary" data-act="go" data-to="#add">Add from a message</button></div>` : ''}
    ${done.length ? `<section class="stack">
      <button class="link eyebrow" data-act="toggle-show-done" aria-expanded="${S.showDone}">${S.showDone ? 'Hide' : 'Show'} done · ${done.length}</button>
      ${S.showDone ? done.slice(0, 40).map(itemCard).join('') : ''}</section>` : ''}
  </main>`;
}

function importCard() {
  return `<section class="card stack" style="gap:12px">
    <div><h2>Import a WhatsApp group</h2>
      <p class="small" style="margin:4px 0 0">Reads the school group's new messages, finds every date and task, and notifies your family once you save.</p></div>
    <div class="field"><span class="label">On the first import, read messages from the last</span>
      <div class="chips" role="group" aria-label="How far back">${[7, 14, 30].map(
        (d) => `<button class="chip sm" data-act="import-days" data-id="${d}" aria-pressed="${S.importDays === d}">${d} days</button>`
      ).join('')}</div></div>
    <button class="btn primary block" data-act="import-chat" ${S.importing ? 'disabled' : ''}>
      ${S.importing ? '<span class="spinner" aria-hidden="true"></span> Reading the chat…' : 'Choose exported chat'}</button>
    <input type="file" id="chat-file" accept=".zip,.txt,application/zip,text/plain" hidden>
    <details class="howto">
      <summary>How to export the chat on iPhone</summary>
      <ol>
        <li>In WhatsApp, open the school group and tap the <b>group name</b> at the top.</li>
        <li>Scroll down and tap <b>Export Chat</b> → <b>Without Media</b>.</li>
        <li>Choose <b>Save to Files</b> → <b>On My iPhone</b> → <b>Save</b>.</li>
        <li>Come back here, tap <b>Choose exported chat</b> and pick the file (it ends in .zip).</li>
      </ol>
      <p class="small" style="margin:0">Do this every few days. Messages you already imported are skipped, so you only see what's new.</p>
    </details>
  </section>`;
}

function addScreen() {
  const empty = !S.text.trim();
  return `<main class="screen">
    <div><h1>Add from school messages</h1>
      <p class="sub" style="margin-top:8px">Import the class WhatsApp group, or paste a single message. We pull out each date, time and to-do, and you check it before saving.</p></div>
    ${importCard()}
    <h2 class="eyebrow" style="margin-top:4px">Or paste one message</h2>
    <div class="chips" role="group" aria-label="Where did it come from?">${SOURCES.map(
      (s) => `<button class="chip" data-act="src" data-id="${esc(s)}" aria-pressed="${S.src === s}">${esc(s)}</button>`
    ).join('')}</div>
    <div class="field">
      <label for="msg">Message</label>
      <textarea id="msg" data-bind="text" placeholder="Paste the WhatsApp or school app message here">${esc(S.text)}</textarea>
      <div class="row">
        <button class="btn small" data-act="paste">Paste from clipboard</button>
        <button class="btn small" data-act="clear-text">Clear</button>
      </div>
    </div>
    <button class="btn primary big block" data-act="extract" ${empty || S.extracting ? 'disabled' : ''} id="extract-btn">
      ${S.extracting ? '<span class="spinner" aria-hidden="true"></span> Reading the message…' : ICON.spark + ' Extract details'}
    </button>
    <button class="link" data-act="manual" style="align-self:center;color:var(--accent);font-weight:600">or add one item by hand</button>
    <div class="hint">${ICON.share}<span>${
      isIos()
        ? 'On iPhone: long-press the message in WhatsApp → Copy, then come back and tap Paste.'
        : 'On Android: long-press the message in WhatsApp → Share → School Tracker. It lands here ready to extract.'
    }</span></div>
    ${S.data.aiEnabled ? '' : '<p class="small" style="margin:0">AI extraction is off on this server, so a built-in date reader is used. Always check the results.</p>'}
  </main>`;
}

function draftRems(d) {
  const r = defaultReminders(d.type, d.time);
  if (d.custom && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.custom)) r.push('c:' + d.custom);
  return r;
}

function attachmentsSection(it) {
  const atts = it.attachments || [];
  return `<section class="card stack" id="attachments" style="gap:12px">
    <div class="row between wrap" style="align-items:baseline;row-gap:2px"><h2>Documents &amp; notes</h2><span class="small">${atts.length ? atts.length + ' saved' : 'Shared with your family'}</span></div>
    ${atts.length ? `<div class="att-list">${atts.map((a) => {
      const thumb = isImage(a) && blobUrls.has(a.id)
        ? `<img src="${blobUrls.get(a.id)}" alt="">`
        : a.kind === 'note' ? ICON.note : ICON.file;
      const sub = a.kind === 'note' ? esc((a.text || '').slice(0, 60)) : `${esc(isPdf(a) ? 'PDF' : (a.type.split('/')[1] || 'file').toUpperCase())} · ${fmtSize(a.size)}`;
      return `<button class="att" data-act="open-att" data-id="${a.id}">
        <span class="att-thumb">${thumb}</span>
        <span class="grow" style="text-align:left;min-width:0"><b class="ellipsis">${esc(a.name)}</b><span class="small ellipsis" style="display:block">${sub}</span></span></button>`;
    }).join('')}</div>` : ''}
    ${S.noteDraft !== null ? `<div class="stack" style="gap:8px">
      <label for="note-text">Paste or type the content</label>
      <textarea id="note-text" data-bind="noteDraft" style="min-height:160px" placeholder="e.g. the full circular, a link, instructions">${esc(S.noteDraft)}</textarea>
      <div class="row"><button class="btn small primary" data-act="note-save">Save note</button><button class="btn small" data-act="note-cancel">Cancel</button></div>
    </div>` : `<div class="row wrap">
      <button class="btn small" data-act="attach">${ICON.clip} Attach file or photo</button>
      <button class="btn small" data-act="note-start">Paste content</button>
    </div>
    <input type="file" id="file-input" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" hidden>
    <p class="small" style="margin:0">${S.uploading ? `<span class="row" style="gap:8px"><span class="spinner" aria-hidden="true"></span>Uploading ${S.uploading}…</span>` : 'Photos, PDFs and documents up to 4 MB each. You can also paste a screenshot here.'}</p>`}
  </section>`;
}

function viewerOverlay() {
  const v = S.viewer;
  if (!v) return '';
  const a = v.att;
  let body;
  if (v.loading) body = '<div class="center" style="min-height:40vh">Opening…</div>';
  else if (v.error) body = `<p class="sub" style="padding:20px">${esc(v.error)}</p>`;
  else if (a.kind === 'note') body = `<pre class="viewer-text">${esc(a.text || '')}</pre>`;
  else if (isImage(a)) body = `<div class="viewer-img"><img src="${v.url}" alt="${esc(a.name)}"></div>`;
  else if (isPdf(a)) body = `<iframe class="viewer-pdf" src="${v.url}" title="${esc(a.name)}"></iframe>`;
  else body = `<div class="center stack" style="min-height:40vh;text-align:center;align-items:center">${ICON.file}<p class="sub">No preview for this file type.<br>Use Download or Open to view it.</p></div>`;
  const canShare = !!(navigator.canShare && v.file && navigator.canShare({ files: [v.file] }));
  return `<div class="viewer" role="dialog" aria-modal="true" aria-label="${esc(a.name)}">
    <header class="viewer-bar">
      <button class="icon-btn" data-act="viewer-close" aria-label="Close">${ICON.close}</button>
      <span class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${esc(a.name)}</b>
        <span class="small">${a.by ? 'Added by ' + esc(a.by) + ' · ' : ''}${esc(dayLabel(new Date(a.createdAt)))}${a.kind === 'file' ? ' · ' + fmtSize(a.size) : ''}</span></span>
    </header>
    <div class="viewer-body">${body}</div>
    <footer class="viewer-bar">
      ${a.kind === 'note'
        ? '<button class="btn small" data-act="viewer-copy">Copy text</button>'
        : v.url ? `<a class="btn small" href="${v.url}" download="${esc(a.name)}">Download</a><a class="btn small" href="${v.url}" target="_blank" rel="noopener">Open</a>` : ''}
      ${canShare || a.kind === 'note' && navigator.share ? '<button class="btn small" data-act="viewer-share">Share…</button>' : ''}
      <button class="btn small danger" data-act="viewer-delete" style="margin-left:auto">${v.confirmDelete ? 'Tap again to delete' : 'Delete'}</button>
    </footer>
  </div>`;
}

function draftCard(d, i) {
  const fr = upcomingReminders({ date: d.date, time: d.time, rem: draftRems(d) });
  const remText = !d.date
    ? 'Pick a date to schedule reminders'
    : fr.length
      ? `${fr.length} reminder${fr.length > 1 ? 's' : ''}: ` + fr.map((x) => `${dayLabel(x)} ${fmtClock(x)}`).join(' · ')
      : daysFromToday(d.date) === 0
        ? 'Due today — the usual reminder times have passed. Add an extra reminder above if you want one.'
        : 'This date has passed — no reminders will be sent';
  return `<div class="card stack" style="gap:14px;${d.inc ? '' : 'opacity:.5'}">
    <div class="row between"><span class="eyebrow" style="font-size:12px">Item ${i + 1}</span>
      <button class="btn small" data-act="draft-inc" data-i="${i}" aria-pressed="${d.inc}">${d.inc ? 'Skip' : 'Include'}</button></div>
    <div class="field"><label for="t${i}">What</label>
      <input type="text" id="t${i}" data-bind="draft.${i}.title" value="${esc(d.title)}" style="font-weight:600"></div>
    <div class="field"><span class="label">Type</span><div class="chips" role="group" aria-label="Type">${TYPES.map(
      (t) => `<button class="chip sm t-${t}" data-act="draft-set" data-i="${i}" data-k="type" data-v="${t}" aria-pressed="${d.type === t}">${t}</button>`
    ).join('')}</div></div>
    ${S.data.children.length ? `<div class="field"><span class="label">For</span><div class="chips" role="group" aria-label="Child">${S.data.children
      .map((c) => `<button class="chip sm" data-act="draft-set" data-i="${i}" data-k="childId" data-v="${c.id}" aria-pressed="${d.childId === c.id}">${esc(c.name)}</button>`)
      .join('')}</div></div>` : ''}
    <div class="grid2 dt">
      <div class="field"><label for="d${i}">Date</label><input type="date" id="d${i}" data-bind="draft.${i}.date" data-rerender value="${esc(d.date)}"></div>
      <div class="field"><label for="h${i}">Time (optional)</label><input type="time" id="h${i}" data-bind="draft.${i}.time" data-rerender value="${esc(d.time)}"></div>
    </div>
    <div class="field"><label for="l${i}">Where (optional)</label><input type="text" id="l${i}" data-bind="draft.${i}.location" value="${esc(d.location)}"></div>
    <div class="field"><label for="c${i}">Extra reminder at (optional)</label><input type="datetime-local" id="c${i}" data-bind="draft.${i}.custom" data-rerender value="${esc(d.custom || '')}"></div>
    <div class="hint" style="font-size:13px">${ICON.bellSm}<span>${esc(remText)}</span></div>
    ${d.line ? `<p class="quote">“${esc(d.line)}”</p>` : ''}
  </div>`;
}

function reviewScreen() {
  const n = S.drafts.filter((d) => d.inc).length;
  const imp = S.importInfo;
  const title = S.drafts.length ? `Found ${S.drafts.length} item${S.drafts.length > 1 ? 's' : ''}` : 'No dates found';
  const fromLine = imp ? `<p class="small" style="margin:6px 0 0">From ${imp.newMessages} new message${imp.newMessages === 1 ? '' : 's'} in <b>${esc(imp.chatName)}</b>${imp.alreadySeen ? ` · ${imp.alreadySeen} already imported earlier were skipped` : ''}</p>` : '';
  return `<main class="screen no-nav">
    <button class="link" data-act="go" data-to="#add">${ICON.back} ${S.importInfo ? 'Back' : 'Edit message'}</button>
    <div><h1 style="font-size:26px">${title}</h1>${fromLine}
      <p class="sub" style="margin-top:8px;font-size:14px">${S.drafts.length ? 'Check each one. Fix anything that is wrong, skip what you don\'t need.' : ''}
      ${S.engine === 'claude' ? 'Read by Claude.' : S.engine === 'rules' ? 'Read by the built-in date reader.' : ''}</p></div>
    ${S.drafts.map(draftCard).join('')}
    ${!S.drafts.length ? `<div class="card empty"><p class="sub" style="font-size:14px">We couldn't find a date in that message. Go back and check it, or add the item by hand.</p>
      <button class="btn" data-act="manual">Add by hand</button></div>` : ''}
  </main>
  <div class="savebar"><div class="inner">
    <button class="btn primary big block" data-act="save-drafts" ${n === 0 || S.saving ? 'disabled' : ''}>${S.saving ? 'Saving…' : n ? `Save ${n} to tracker` : 'Nothing selected'}</button>
  </div></div>`;
}

function itemScreen() {
  const it = itemOf(S.param);
  if (!it) return `<main class="screen"><button class="link" data-act="go" data-to="#home">${ICON.back} All items</button><p class="sub">This item was deleted.</p></main>`;
  const k = kidOf(it.childId);
  const d = parseYmd(it.date);
  const dd = daysFromToday(it.date);
  const now = new Date();
  const others = S.data.members.filter((m) => m.id !== S.data.me.id && m.notify).map((m) => m.name);
  const customs = it.rem.filter(isCustom).map((key) => ({ key, at: reminderAt(it, key) })).sort((a, b) => a.at - b.at);
  if (!S.customRem) S.customRem = defaultCustomFor(it);
  const rems = REMINDERS.map((r) => {
    const at = reminderAt(it, r.key);
    const on = it.rem.includes(r.key);
    const sub = !at ? 'Add a time to use this' : (at <= now ? 'Already passed · ' : '') + dayLabel(at) + ', ' + fmtClock(at);
    return `<button class="toggle" data-act="toggle-rem" data-k="${r.key}" aria-pressed="${on && !!at}" ${at ? '' : 'disabled'}>
      <span class="t-label"><b>${r.label}</b><small>${esc(sub)}</small></span><span class="switch" aria-hidden="true"></span></button>`;
  }).join('');
  return `<main class="screen">
    <button class="link" data-act="go" data-to="#home">${ICON.back} All items</button>
    <div class="stack">
      <div class="chips" role="group" aria-label="Type">${TYPES.map(
        (t) => `<button class="chip sm t-${t}" data-act="item-set" data-k="type" data-v="${t}" aria-pressed="${it.type === t}">${t}</button>`
      ).join('')}</div>
      <label for="it-title" class="label">What</label>
      <input type="text" id="it-title" data-save="title" value="${esc(it.title)}" style="font-family:'Space Grotesk',Inter,sans-serif;font-size:20px;font-weight:600;min-height:52px">
      <p class="when ${dd < 0 && !it.done ? 'overdue' : ''}" style="margin:0;font-size:15px">${dd < 0 && !it.done ? 'Overdue · ' : ''}${WDL[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}${it.time ? ' · ' + fmtTime(it.time) : ''}${dd >= 0 && dd <= 1 ? ' (' + dayLabel(d) + ')' : ''}</p>
    </div>
    ${S.data.children.length ? `<div class="field"><span class="label">For</span><div class="chips" role="group" aria-label="Child">${S.data.children
      .map((c) => `<button class="chip sm" data-act="item-set" data-k="childId" data-v="${c.id}" aria-pressed="${it.childId === c.id}">${esc(c.name)}</button>`)
      .join('')}</div></div>` : ''}
    <div class="grid2 dt">
      <div class="field"><label for="it-date">Date</label><input type="date" id="it-date" data-save="date" value="${esc(it.date)}"></div>
      <div class="field"><label for="it-time">Time</label><input type="time" id="it-time" data-save="time" value="${esc(it.time)}"></div>
    </div>
    <div class="field"><label for="it-loc">Where</label><input type="text" id="it-loc" data-save="location" value="${esc(it.location)}" placeholder="Optional"></div>
    <section class="card list">
      <div class="row between" style="padding:12px 0 6px;align-items:baseline"><h2>Reminders</h2>
        <span class="small">${others.length ? 'to you &amp; ' + esc(others.join(', ')) : 'to you'}</span></div>
      ${rems}
      ${customs.map((c) => `<div class="toggle" style="cursor:default">
        <span class="t-label"><b>Custom</b><small>${c.at <= now ? 'Already passed · ' : ''}${esc(fmtWhen(c.at))}</small></span>
        <button class="btn small danger" data-act="del-custom" data-k="${esc(c.key)}" aria-label="Remove custom reminder ${esc(fmtWhen(c.at))}">Remove</button></div>`).join('')}
      ${customs.length < MAX_CUSTOM ? `<div class="stack" style="padding:12px 0 14px;gap:8px">
        <label for="custom-rem">Add a reminder at a date and time you choose</label>
        <div class="rem-add"><input type="datetime-local" id="custom-rem" data-bind="customRem" value="${esc(S.customRem)}">
        <button class="btn small primary" data-act="add-custom">Add reminder</button></div></div>` : ''}
    </section>
    ${attachmentsSection(it)}
    <div class="row wrap actions">
      <button class="btn grow" data-act="snooze">Remind me in 1 hr</button>
      ${it.done
        ? `<button class="btn grow" data-act="toggle-done" data-id="${it.id}">Done by ${esc(it.doneBy || '')} · Undo</button>`
        : `<button class="btn primary grow" data-act="toggle-done" data-id="${it.id}">Mark as done</button>`}
    </div>
    ${it.msg ? `<section class="card sunk stack" style="gap:8px"><span class="eyebrow row" style="font-size:12px;gap:6px">${ICON.msg} Original${it.source ? ' · ' + esc(it.source) : ''}</span><p class="pre">${esc(it.msg)}</p></section>` : ''}
    <button class="btn danger" data-act="delete">${S.confirmDelete ? 'Tap again to delete for everyone' : 'Delete item'}</button>
  </main>`;
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return s + ' seconds ago';
  if (s < 5400) return Math.round(s / 60) + ' minutes ago';
  return Math.round(s / 3600) + ' hours ago';
}

function diagCard() {
  const d = S.diag;
  let rows = '';
  if (d?.loading) rows = '<p class="small" style="margin:0">Checking…</p>';
  else if (d?.error) rows = `<p class="small" style="margin:0;color:var(--danger)">${esc(d.error)}</p>`;
  else if (d) {
    const line = (ok, title, hint) => `<div class="row" style="align-items:flex-start;gap:10px">
      <span class="diag-dot ${ok ? 'ok' : 'bad'}" aria-hidden="true">${ok ? '✓' : '!'}</span>
      <span class="grow"><b style="display:block;font-size:14px">${title}</b>${hint ? `<span class="small">${hint}</span>` : ''}</span></div>`;
    const phoneOffset = -new Date().getTimezoneOffset();
    const tzOk = d.offsetMinutes === phoneOffset;
    const tickAge = d.lastTickAt ? (Date.now() - new Date(d.lastTickAt)) / 1000 : Infinity;
    const upMin = (Date.now() - new Date(d.startedAt)) / 60000;
    const push = S.push;
    rows = [
      line(push === 'on', 'This device can show notifications',
        push === 'on' ? '' : push === 'ios-install' ? 'On iPhone, open the app from the Home Screen icon (not Safari), then turn reminders on.'
          : push === 'denied' ? 'Notifications are blocked. Allow them for this site in your phone/browser settings.'
          : push === 'default' ? 'Tap "Turn on" above.' : 'This browser does not support notifications. Use Chrome on Android or the Home Screen app on iPhone.'),
      line(d.subscriptions > 0, `Server knows ${d.subscriptions} device${d.subscriptions === 1 ? '' : 's'} for you`,
        d.subscriptions > 0 ? '' : 'The server has nowhere to send your reminders. Turn reminders on again on this device.'),
      line(d.notify, 'Reminders are switched on for you', d.notify ? '' : 'Turn on "Send me reminders" above.'),
      line(tzOk, `Server time zone: ${esc(d.timeZone)}`,
        tzOk ? '' : `Your phone is ${phoneOffset / 60 >= 0 ? '+' : ''}${phoneOffset / 60}h from UTC but the server is ${d.offsetMinutes / 60 >= 0 ? '+' : ''}${d.offsetMinutes / 60}h, so custom reminders fire at the wrong time. Set TZ=Asia/Kolkata on the server.`),
      line(tickAge < 180, `Reminder checker last ran ${ago(d.lastTickAt)}`,
        tickAge < 180 ? (upMin < 20 ? `Server started ${ago(d.startedAt)} — if it was asleep before that, reminders due then were sent late or skipped.` : '')
          : 'The server is not checking reminders. On Render free it falls asleep: set up the uptime monitor (every 10 min).'),
      d.lastError ? line(false, 'Last check failed', esc(d.lastError)) : '',
      d.recentDeliveries.length
        ? line(d.recentDeliveries.every((r) => r.delivered > 0), 'Latest reminders sent to you',
            d.recentDeliveries.map((r) => `${esc(r.title)} — ${ago(r.at)} — ${r.delivered ? r.delivered + ' device(s)' : 'no device received it'}`).join('<br>'))
        : d.recentSent.length
          ? line(true, 'Latest reminders sent to you', d.recentSent.map((r) => `${esc(r.title)} — ${ago(r.at)}`).join('<br>'))
          : line(true, 'No reminders have been sent to you yet', ''),
    ].join('');
  }
  return `<section class="card stack" style="gap:12px">
    <div class="row between"><h2>Reminder check</h2>
      <button class="btn small" data-act="run-diag">${d ? 'Check again' : 'Run check'}</button></div>
    ${rows || '<p class="small" style="margin:0">Not getting reminders? This checks your phone, the server clock and when reminders were last sent.</p>'}
    ${S.push === 'on' ? '<button class="btn small" data-act="test-push" style="align-self:flex-start">Send a test notification now</button>' : ''}
  </section>`;
}

function familyScreen() {
  const { me, members, children, activity, family } = S.data;
  const inv = S.invite;
  const pushLine = { on: 'On for this device', default: 'Off for this device', denied: 'Blocked in browser settings', 'ios-install': 'Add to Home Screen first', unsupported: 'Not supported in this browser', checking: '…' }[S.push];
  return `<main class="screen">
    <div><h1>${esc(family.name)}</h1>
      <p class="sub" style="margin-top:8px">Everyone here sees the same list. When one of you marks something done, the others stop getting reminders for it.</p></div>

    <section class="card list">
      ${members.map((m) => `<div class="member"><span class="avatar">${initial(m.name)}</span>
        <span class="grow"><b style="display:block">${esc(m.name)}${m.id === me.id ? ' (you)' : ''}</b>
        <span class="small">${m.role === 'admin' ? 'Admin · ' : ''}${m.notify ? 'gets reminders' : 'reminders off'}</span></span></div>`).join('')}
      <button class="toggle" data-act="invite" style="color:var(--accent);font-weight:600;min-height:52px">+ Invite your partner or a caregiver</button>
    </section>
    ${inv ? `<section class="card stack">
      <b>${inv.linkDevice ? 'Open this link on your other device' : 'Send this link to them'}</b>
      <input type="text" readonly value="${esc(inv.url)}" aria-label="Invite link" data-select>
      <div class="row wrap">
        <button class="btn small" data-act="copy-invite">Copy</button>
        ${navigator.share ? '<button class="btn small" data-act="share-invite">Share…</button>' : ''}
        ${inv.linkDevice ? '' : `<a class="btn small" href="https://wa.me/?text=${encodeURIComponent('Join our School Tracker so we both get reminders: ' + inv.url)}" target="_blank" rel="noopener">WhatsApp</a>`}
      </div>
      <span class="small">Works once. Expires ${inv.linkDevice ? 'in 1 hour' : 'in 7 days'}.</span>
    </section>` : ''}

    <section class="card list">
      <h2 style="padding:12px 0 6px">Your notifications</h2>
      <div class="toggle" style="cursor:default"><span class="t-label"><b>This device</b><small>${pushLine}</small></span>
        ${S.push === 'default' ? '<button class="btn small primary" data-act="enable-push">Turn on</button>' : S.push === 'on' ? '<button class="btn small" data-act="test-push">Test</button>' : ''}</div>
      <button class="toggle" data-act="me-toggle" data-k="notify" aria-pressed="${me.notify}"><span class="t-label"><b>Send me reminders</b><small>Turn off if only the other parent should get them</small></span><span class="switch" aria-hidden="true"></span></button>
      <button class="toggle" data-act="me-toggle" data-k="tellDone" aria-pressed="${me.tellDone}"><span class="t-label"><b>Tell me when it's handled</b><small>A quiet note when someone else marks done</small></span><span class="switch" aria-hidden="true"></span></button>
    </section>

    ${diagCard()}

    <section class="stack">
      <h2 class="eyebrow">Children</h2>
      ${children.map((c) => `<div class="card row" style="padding:12px 16px">
        <span class="dot" style="width:12px;height:12px;border-radius:6px;background:${esc(c.color)}"></span>
        <span class="grow"><b>${esc(c.name)}</b>${c.grade ? ` <span class="small">· ${esc(c.grade)}</span>` : ''}
        <span class="small" style="display:block">${S.data.items.filter((i) => i.childId === c.id && !i.done).length} open</span></span>
        <button class="btn small danger" data-act="del-child" data-id="${c.id}" aria-label="Remove ${esc(c.name)}">Remove</button></div>`).join('')}
      <div class="card stack">
        <div class="grid2 pair">
          <div class="field"><label for="ac-name">Child's name</label><input type="text" id="ac-name" data-bind="addChild.name" value="${esc(S.addChild.name)}"></div>
          <div class="field"><label for="ac-grade">Class</label><input type="text" id="ac-grade" data-bind="addChild.grade" value="${esc(S.addChild.grade)}" placeholder="e.g. Grade 4 · 4B"></div>
        </div>
        <button class="btn small" data-act="add-child">Add child</button>
      </div>
    </section>

    ${activity.length ? `<section class="stack"><h2 class="eyebrow">Recent activity</h2>${activity
      .slice(0, 10)
      .map((a) => `<p style="margin:0;font-size:14px;line-height:1.45;color:var(--ink-2)"><b>${esc(a.who || 'Someone')}</b> ${esc(a.text)} <span class="small">· ${esc(dayLabel(new Date(a.at)))}</span></p>`)
      .join('')}</section>` : ''}

    <section class="row wrap">
      <button class="btn small" data-act="link-device">Sign in on another device</button>
      <button class="btn small danger" data-act="logout">Sign out</button>
    </section>
  </main>`;
}

function onboardScreen() {
  const o = S.onboard;
  if (S.route === 'join' && S.joinInfo) {
    const j = S.joinInfo;
    if (j.loading) return '<div class="center">Checking invite…</div>';
    if (j.error) return `<main class="screen no-nav"><h1>Invite not valid</h1><p class="sub">${esc(j.error)}</p><a class="btn" href="#">Start a new family instead</a></main>`;
    return `<main class="screen no-nav">
      <h1>${j.linkDevice ? `Sign in as ${esc(j.targetName)}` : `Join ${esc(j.familyName)}`}</h1>
      <p class="sub">${j.linkDevice ? 'This adds this device to your account.' : `${esc(j.inviter)} invited you to share the school tracker. You'll see the same list and get the same reminders.`}</p>
      ${j.linkDevice ? '' : `<div class="field"><label for="jn">Your name</label><input type="text" id="jn" data-bind="onboard.joinName" value="${esc(o.joinName)}" autocomplete="given-name"></div>`}
      <button class="btn primary big block" data-act="join">${j.linkDevice ? 'Sign in' : 'Join'}</button>
      ${S.error ? `<p class="small" style="color:var(--danger)">${esc(S.error)}</p>` : ''}
    </main>`;
  }
  return `<main class="screen no-nav">
    <div><h1>School Tracker</h1>
      <p class="sub" style="margin-top:8px">Paste what the school sends on WhatsApp or the school app. We turn it into a list and remind both parents before each event, assignment, meeting and task.</p></div>
    <div class="field"><label for="ob-me">Your name</label><input type="text" id="ob-me" data-bind="onboard.memberName" value="${esc(o.memberName)}" autocomplete="given-name"></div>
    <div class="field"><label for="ob-fam">Family name</label><input type="text" id="ob-fam" data-bind="onboard.familyName" value="${esc(o.familyName)}" placeholder="e.g. The Sharmas"></div>
    <section class="stack"><span class="label">Children</span>
      ${o.kids.map((k, i) => `<div class="grid2 pair">
        <input type="text" aria-label="Child ${i + 1} name" placeholder="Name" data-bind="onboard.kids.${i}.name" value="${esc(k.name)}">
        <input type="text" aria-label="Child ${i + 1} class" placeholder="Class, e.g. Grade 4 · 4B" data-bind="onboard.kids.${i}.grade" value="${esc(k.grade)}">
      </div>`).join('')}
      <button class="link" data-act="ob-add-kid" style="color:var(--accent);font-weight:600">+ Another child</button>
    </section>
    <button class="btn primary big block" data-act="create-family">Create family space</button>
    ${S.error ? `<p class="small" style="color:var(--danger)">${esc(S.error)}</p>` : ''}
    <p class="small">Already set up by your partner? Ask them for an invite link from the Family tab.</p>
  </main>`;
}

/* ---------------- render ---------------- */
function render() {
  const active = document.activeElement;
  const focusId = active && active.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  let html;
  if (!S.token || S.route === 'join') html = onboardScreen();
  else if (!S.data) html = `<div class="center">${S.error ? esc(S.error) : 'Loading…'}</div>`;
  else {
    const screen = { home: homeScreen, add: addScreen, review: reviewScreen, item: itemScreen, family: familyScreen }[S.route] || homeScreen;
    html = screen() + nav();
  }
  if (S.data && S.token) html += viewerOverlay();
  if (S.toast) html += `<div class="toast" role="status">${esc(S.toast)}</div>`;
  $app.innerHTML = html;
  document.body.style.overflow = S.viewer ? 'hidden' : '';
  // Re-rendering can remove the focused field without a focusout event; resync the keyboard state.
  document.body.classList.toggle('typing', isTextField(document.activeElement) && matchMedia('(pointer: coarse)').matches);
  loadThumbs();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* date inputs */ }
    }
  }
}

/* ---------------- attachments ---------------- */
let thumbBusy = false;
async function loadThumbs() {
  if (thumbBusy || S.route !== 'item') return;
  const it = itemOf(S.param);
  const todo = (it?.attachments || []).filter((a) => isImage(a) && !blobUrls.has(a.id));
  if (!todo.length) return;
  thumbBusy = true;
  for (const a of todo) await fetchBlob(a.id).catch(() => {});
  thumbBusy = false;
  render();
}

const MAX_BYTES = 4 * 1048576;
async function shrinkImage(file) {
  // Phone photos are often 3-8 MB; 1600px JPEG keeps them readable and well under the limit.
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1048576 && /jpeg|png|webp/.test(file.type)) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return blob ? new File([blob], base + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

async function uploadFiles(itemId, files) {
  const list = [...files];
  if (!list.length) return;
  S.uploading = list.length;
  render();
  let ok = 0;
  for (const f of list) {
    const file = await shrinkImage(f);
    if (file.size > MAX_BYTES) { toast(`${f.name} is larger than 4 MB`); S.uploading--; continue; }
    try {
      const res = await fetch(`/api/items/${itemId}/attachments`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + S.token,
          'content-type': file.type && file.type !== 'application/json' ? file.type : 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name || 'file'),
        },
        body: file,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Upload failed');
      ok++;
    } catch (e) {
      toast(e.message);
    }
    S.uploading--;
    render();
  }
  S.uploading = 0;
  await refresh();
  if (ok) toast(`${ok} file${ok > 1 ? 's' : ''} attached · your family can see ${ok > 1 ? 'them' : 'it'}`);
}

async function openViewer(att) {
  S.viewer = { att, loading: att.kind === 'file' };
  render();
  if (att.kind !== 'file') return;
  try {
    const url = await fetchBlob(att.id);
    const blob = blobData.get(att.id);
    if (S.viewer?.att.id !== att.id) return;
    S.viewer = { att, url, file: new File([blob], att.name, { type: att.type }) };
  } catch (e) {
    S.viewer = { att, error: e.message };
  }
  render();
}

/* ---------------- WhatsApp import ---------------- */
async function importChat(file) {
  S.importing = true;
  render();
  try {
    const { messages } = parseWhatsAppExport(await readChatFile(file));
    if (!messages.length) throw new Error("That file doesn't look like a WhatsApp chat export");
    const since = toYmd(new Date(Date.now() - S.importDays * 864e5));
    const recent = messages.filter((m) => m.date >= since);
    const chatName = chatNameFromFile(file.name);
    const r = await api('/api/import/chat', { method: 'POST', body: { chatName, messages: recent } });
    S.engine = r.engine;
    S.src = 'WhatsApp';
    if (!r.items.length) {
      if (r.newIds.length) await api('/api/import/seen', { method: 'POST', body: { ids: r.newIds, chatName } });
      toast(r.newMessages
        ? `Read ${r.newMessages} new message${r.newMessages === 1 ? '' : 's'} from ${chatName}: no upcoming dates or tasks`
        : `No new messages in ${chatName} since your last import`);
      return;
    }
    S.importInfo = { chatName, ids: r.newIds, newMessages: r.newMessages, alreadySeen: r.alreadySeen };
    S.drafts = r.items.map((x) => ({ ...x, inc: true, line: x.sender ? `${x.sender}: ${x.line}` : x.line }));
    go('#review');
  } catch (e) {
    toast(e.message || 'Could not read that file');
  } finally {
    S.importing = false;
    render();
  }
}

/* ---------------- actions ---------------- */
function setPath(path, value) {
  const parts = path.split('.');
  let o = parts[0] === 'draft' ? S.drafts : S;
  if (parts[0] === 'draft') parts.shift();
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = value;
}

async function patchItem(id, patch) {
  const it = itemOf(id);
  if (!it) return;
  Object.assign(it, patch);
  render();
  try {
    await api('/api/items/' + id, { method: 'PATCH', body: patch });
  } catch (e) {
    toast(e.message);
  }
  refresh();
}

const actions = {
  go: (el) => go(el.dataset.to),
  open: (el) => go('#item/' + el.dataset.id),
  filter: (el) => { S.filter = el.dataset.id; render(); },
  'toggle-show-done': () => { S.showDone = !S.showDone; render(); },
  'enable-push': enablePush,
  'import-days': (el) => { S.importDays = Number(el.dataset.id); render(); },
  'import-chat': () => document.getElementById('chat-file')?.click(),
  async 'run-diag'() {
    S.diag = { loading: true };
    render();
    await checkPush().catch(() => {});
    try { S.diag = await api('/api/diag'); } catch (e) { S.diag = { error: e.message }; }
    render();
  },
  async 'test-push'() {
    try {
      const r = await api('/api/push/test', { method: 'POST' });
      toast(r.delivered ? 'Test reminder sent — check your notifications' : 'No device subscribed yet');
    } catch (e) { toast(e.message); }
  },
  async 'toggle-done'(el) {
    const it = itemOf(el.dataset.id);
    if (!it) return;
    const done = !it.done;
    it.done = done;
    it.doneBy = done ? S.data.me.name : null;
    it.doneAt = new Date().toISOString();
    render();
    try {
      await api(`/api/items/${it.id}/done`, { method: 'POST', body: { done } });
      toast(done ? 'Marked done · others stop getting reminders for it' : 'Moved back to the list');
    } catch (e) { toast(e.message); }
    refresh();
  },
  src: (el) => { S.src = el.dataset.id; render(); },
  async paste() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { S.text = t; render(); }
      else toast('Clipboard is empty');
    } catch { toast('Allow clipboard access, or long-press the box and choose Paste'); }
  },
  'clear-text': () => { S.text = ''; render(); },
  async extract() {
    if (!S.text.trim()) return;
    S.importInfo = null;
    S.extracting = true;
    render();
    try {
      const r = await api('/api/extract', { method: 'POST', body: { text: S.text, childId: S.filter !== 'all' ? S.filter : null } });
      S.engine = r.engine;
      S.drafts = r.items.map((x) => ({ ...x, inc: true }));
      S.extracting = false;
      go('#review');
    } catch (e) {
      S.extracting = false;
      toast(e.message);
    }
  },
  manual() {
    S.engine = '';
    S.importInfo = null;
    S.drafts = [{ title: '', type: 'Event', childId: S.data.children[0]?.id || null, date: toYmd(new Date(Date.now() + 864e5)), time: '', location: '', line: '', inc: true }];
    go('#review');
  },
  'draft-inc': (el) => { const d = S.drafts[el.dataset.i]; d.inc = !d.inc; render(); },
  'draft-set': (el) => { S.drafts[el.dataset.i][el.dataset.k] = el.dataset.v; render(); },
  async 'save-drafts'() {
    const list = S.drafts.filter((d) => d.inc);
    const missing = list.find((d) => !d.title.trim() || !d.date);
    if (missing) { toast('Each item needs a title and a date'); return; }
    S.saving = true;
    render();
    try {
      await api('/api/items', {
        method: 'POST',
        body: {
          items: list.map((d) => ({
            title: d.title.trim(), type: d.type, childId: d.childId, date: d.date, time: d.time, location: d.location,
            source: S.importInfo ? `WhatsApp · ${S.importInfo.chatName}`.slice(0, 40) : S.src,
            msg: d.line || S.text.slice(0, 2000), rem: draftRems(d),
          })),
        },
      });
      if (S.importInfo) {
        await api('/api/import/seen', { method: 'POST', body: { ids: S.importInfo.ids, chatName: S.importInfo.chatName } }).catch(() => {});
        S.importInfo = null;
      }
      const n = list.reduce((c, d) => c + upcomingReminders({ date: d.date, time: d.time, rem: draftRems(d) }).length, 0);
      S.drafts = [];
      S.text = '';
      S.filter = 'all';
      await refresh();
      go('#home');
      const others = S.data.members.length - 1;
      toast(`${list.length} saved · ${n} reminders scheduled${others ? ' · your family has been notified' : ''}`);
    } catch (e) {
      toast(e.message);
    } finally {
      S.saving = false;
      render();
    }
  },
  'item-set': (el) => patchItem(S.param, { [el.dataset.k]: el.dataset.v }),
  'add-custom'() {
    const it = itemOf(S.param);
    const v = (document.getElementById('custom-rem')?.value || S.customRem || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) { toast('Pick a date and time'); return; }
    const [dd, tt] = v.split('T');
    const at = new Date(...dd.split('-').map((x, i) => (i === 1 ? x - 1 : +x)), ...tt.split(':').map(Number));
    if (at <= new Date()) { toast('Pick a time in the future'); return; }
    const key = 'c:' + v;
    if (it.rem.includes(key)) { toast('That reminder is already set'); return; }
    S.customRem = '';
    patchItem(it.id, { rem: [...it.rem, key] });
    toast(`Reminder set for ${fmtWhen(at)}`);
  },
  'del-custom': (el) => {
    const it = itemOf(S.param);
    patchItem(it.id, { rem: it.rem.filter((k) => k !== el.dataset.k) });
  },
  attach: () => document.getElementById('file-input')?.click(),
  'note-start'() {
    S.noteDraft = '';
    render();
    document.getElementById('note-text')?.focus();
    navigator.clipboard?.readText?.().then((t) => {
      if (t && S.noteDraft === '') { S.noteDraft = t; render(); }
    }).catch(() => {});
  },
  'note-cancel': () => { S.noteDraft = null; render(); },
  async 'note-save'() {
    const text = (document.getElementById('note-text')?.value ?? S.noteDraft ?? '').trim();
    if (!text) { toast('Paste or type something first'); return; }
    const first = text.split('\n')[0].trim();
    try {
      await api(`/api/items/${S.param}/notes`, { method: 'POST', body: { text, name: first.length > 3 ? first.slice(0, 60) : 'Pasted note' } });
      S.noteDraft = null;
      await refresh();
      toast('Note saved');
    } catch (e) { toast(e.message); }
  },
  'open-att'(el) {
    const att = itemOf(S.param)?.attachments.find((a) => a.id === el.dataset.id);
    if (att) openViewer(att);
  },
  'viewer-close': () => { S.viewer = null; render(); },
  async 'viewer-copy'() {
    try { await navigator.clipboard.writeText(S.viewer.att.text || ''); toast('Copied'); } catch { toast('Select the text and copy it'); }
  },
  async 'viewer-share'() {
    const v = S.viewer;
    try {
      if (v.att.kind === 'note') await navigator.share({ title: v.att.name, text: v.att.text });
      else await navigator.share({ files: [v.file], title: v.att.name });
    } catch { /* cancelled */ }
  },
  async 'viewer-delete'() {
    const v = S.viewer;
    if (!v.confirmDelete) { v.confirmDelete = true; render(); return; }
    try {
      await api('/api/attachments/' + v.att.id, { method: 'DELETE' });
      const url = blobUrls.get(v.att.id);
      if (url) { URL.revokeObjectURL(url); blobUrls.delete(v.att.id); blobData.delete(v.att.id); }
      S.viewer = null;
      await refresh();
      toast('Deleted');
    } catch (e) { toast(e.message); }
  },
  'toggle-rem'(el) {
    const it = itemOf(S.param);
    const k = el.dataset.k;
    patchItem(it.id, { rem: it.rem.includes(k) ? it.rem.filter((x) => x !== k) : [...it.rem, k] });
  },
  async snooze() {
    try {
      await api(`/api/items/${S.param}/snooze`, { method: 'POST', body: { minutes: 60 } });
      toast(S.push === 'on' ? "OK — we'll remind you in an hour" : 'Snoozed, but turn on notifications to get it');
    } catch (e) { toast(e.message); }
  },
  async delete() {
    if (!S.confirmDelete) { S.confirmDelete = true; render(); return; }
    try {
      await api('/api/items/' + S.param, { method: 'DELETE' });
      await refresh();
      go('#home');
      toast('Deleted');
    } catch (e) { toast(e.message); }
  },
  async invite() {
    try {
      const r = await api('/api/invites', { method: 'POST', body: {} });
      S.invite = { ...r, linkDevice: false };
      render();
    } catch (e) { toast(e.message); }
  },
  async 'link-device'() {
    try {
      const r = await api('/api/invites', { method: 'POST', body: { linkDevice: true } });
      S.invite = { ...r, linkDevice: true };
      render();
    } catch (e) { toast(e.message); }
  },
  async 'copy-invite'() {
    try { await navigator.clipboard.writeText(S.invite.url); toast('Link copied'); } catch { toast('Select the link and copy it'); }
  },
  async 'share-invite'() {
    try { await navigator.share({ title: 'School Tracker', text: 'Join our School Tracker so we both get reminders', url: S.invite.url }); } catch { /* cancelled */ }
  },
  async 'me-toggle'(el) {
    const k = el.dataset.k;
    S.data.me[k] = !S.data.me[k];
    render();
    try { await api('/api/me', { method: 'PATCH', body: { [k]: S.data.me[k] } }); } catch (e) { toast(e.message); }
    refresh();
  },
  async 'add-child'() {
    if (!S.addChild.name.trim()) { toast("Enter the child's name"); return; }
    try {
      await api('/api/children', { method: 'POST', body: S.addChild });
      S.addChild = { name: '', grade: '' };
      refresh();
    } catch (e) { toast(e.message); }
  },
  async 'del-child'(el) {
    const c = kidOf(el.dataset.id);
    if (!confirm(`Remove ${c.name}? Their items stay but won't be linked to a child.`)) return;
    try { await api('/api/children/' + c.id, { method: 'DELETE' }); refresh(); } catch (e) { toast(e.message); }
  },
  async logout() {
    if (!confirm('Sign out on this device?')) return;
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    const sub = swReg && (await swReg.pushManager.getSubscription().catch(() => null));
    if (sub) await sub.unsubscribe().catch(() => {});
    setToken(null);
    S.data = null;
    go('#');
  },
  'ob-add-kid': () => { S.onboard.kids.push({ name: '', grade: '' }); render(); },
  async 'create-family'() {
    const o = S.onboard;
    if (!o.memberName.trim()) { S.error = 'Enter your name'; render(); return; }
    S.error = '';
    try {
      const r = await api('/api/family', { method: 'POST', body: { memberName: o.memberName, familyName: o.familyName, children: o.kids.filter((k) => k.name.trim()) } });
      setToken(r.token);
      delete r.token;
      S.data = r;
      await checkPush();
      go('#home');
    } catch (e) { S.error = e.message; render(); }
  },
  async join() {
    const j = S.joinInfo;
    if (!j.linkDevice && !S.onboard.joinName.trim()) { S.error = 'Enter your name'; render(); return; }
    S.error = '';
    try {
      const r = await api('/api/join', { method: 'POST', body: { code: j.code, name: S.onboard.joinName } });
      setToken(r.token);
      delete r.token;
      S.data = r;
      S.joinInfo = null;
      await checkPush();
      go('#home');
    } catch (e) { S.error = e.message; render(); }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    setPath(el.dataset.bind, el.value);
    if (el.dataset.bind === 'text') {
      const b = document.getElementById('extract-btn');
      if (b) b.disabled = !el.value.trim() || S.extracting;
    }
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.bind && el.dataset.rerender !== undefined) render();
  if (el.dataset.save && S.route === 'item') {
    const k = el.dataset.save;
    if (k === 'date' && !el.value) return;
    if (k === 'title' && !el.value.trim()) return;
    patchItem(S.param, { [k]: el.value });
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'chat-file' && e.target.files[0]) {
    importChat(e.target.files[0]);
    e.target.value = '';
  }
  if (e.target.id === 'file-input' && S.route === 'item') {
    uploadFiles(S.param, e.target.files);
    e.target.value = '';
  }
});
// Paste a screenshot or file anywhere on an item's screen to attach it.
document.addEventListener('paste', (e) => {
  if (S.route !== 'item' || !S.token) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    uploadFiles(S.param, files);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.viewer) { S.viewer = null; render(); }
});
// On phones the keyboard pushes fixed bars up over the field being typed in, so hide them while typing.
document.addEventListener('focusin', (e) => { if (isTextField(e.target) && matchMedia('(pointer: coarse)').matches) document.body.classList.add('typing'); });
document.addEventListener('focusout', () => setTimeout(() => { if (!isTextField(document.activeElement)) document.body.classList.remove('typing'); }, 50));
document.addEventListener('focusin', (e) => { if (e.target.dataset.select !== undefined) e.target.select(); });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'refresh') refresh(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
window.addEventListener('hashchange', onRoute);

/* ---------------- boot ---------------- */
(async function boot() {
  // Android share target: /share?text=...
  if (location.pathname === '/share') {
    const p = new URLSearchParams(location.search);
    S.text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join('\n');
    history.replaceState(null, '', '/#add');
  }
  onRoute();
  await Promise.all([refresh(), checkPush()]);
  S.loading = false;
  render();
})();
