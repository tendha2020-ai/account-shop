// sw.js: antics as a home-screen app. It opens even with no signal, and shows "your video is ready".
// Only the app's own page files are kept on the phone. Worker calls, videos, songs, voice samples and the
// worker files the setup reads always go straight to the network and are never stored.
// If this ever misbehaves: publish a sw.js that deletes the caches and calls self.registration.unregister()
// on activate. Browsers check sw.js again on every open.

const CACHE = 'antics-shell-4'; // change it only when SHELL changes
const SHELL = ['index.html', 'app.js', 'style.css', 'manifest.json', 'brand/tendha2.png', 'brand/favicon-64.png',
  'brand/icon-192.png', 'brand/badge-96.png',
  'together.js', // Together (v13): several animals in one video
  'sing.js', // (Sing) v14: animals sing a song
  'studio.js']; // (Studio) v17: the tabs
const BASE = new URL('./', self.location).pathname; // this folder, e.g. /account-shop/animals/

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // One file at a time, so one that fails (offline right now) doesn't stop the others; it's kept on the next visit.
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map((file) => cache.add(file).catch(() => {})))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('antics-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Anything else (the worker on hf.space, videos, songs, fonts, uploads, voices/*, worker/*.py, pc/*) is untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const file = url.pathname.slice(BASE.length) || 'index.html';
  if (req.mode === 'navigate') {
    if (file === 'index.html') event.respondWith(fresh(req, file, 5000));
    return; // pc.html and other pages load normally
  }
  if (!SHELL.includes(file)) return;
  event.respondWith(file.startsWith('brand/') ? kept(req, file) : fresh(req, file, 0));
});

// The newest copy from the network, so an update shows right away. The kept copy when offline, or when
// the page itself takes longer than `wait` ms. Answers marked no-store (like a host's one-time notice
// page) are shown but never kept.
async function fresh(req, file, wait) {
  const cache = await caches.open(CACHE);
  const net = fetch(req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' })).then((res) => {
    if (res.ok && !/no-store/i.test(res.headers.get('Cache-Control') || '')) cache.put(file, res.clone());
    return res;
  });
  net.catch(() => {}); // a late failure after the kept copy was shown is fine
  try {
    return await (wait ? Promise.race([net, new Promise((_, late) => setTimeout(late, wait))]) : net);
  } catch {
    return (await cache.match(file)) || net;
  }
}

// Icons and the avatar: from the phone, refreshed in the background.
async function kept(req, file) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(file);
  const net = fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(file, res.clone());
    return res;
  });
  if (!hit) return net;
  net.catch(() => {});
  return hit;
}

// ---------- "Your video is ready" ----------

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const looking = wins.some((w) => w.visibilityState === 'visible' && w.focused);
    wins.forEach((w) => w.postMessage({ type: 'antics-ready', job: msg.job })); // an open app refreshes now
    if (self.navigator.setAppBadge && !looking) self.navigator.setAppBadge().catch(() => {});
    // Phones require a notification for every push; it's a quiet one when antics is on screen.
    await self.registration.showNotification(msg.title || 'Your video is ready', {
      body: msg.body || 'Tap to watch it.',
      tag: msg.tag || 'antics',
      renotify: !looking,
      silent: looking,
      icon: 'brand/icon-192.png',
      badge: 'brand/badge-96.png',
      data: { url: msg.url || 'index.html' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || 'index.html', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (!win) return self.clients.openWindow(url);
    win.postMessage({ type: 'antics-open', url });
    return win.focus().catch(() => {});
  })());
});
