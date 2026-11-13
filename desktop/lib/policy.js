'use strict';
// Rules for what the antics window may open, which site permissions it grants and how saved files are named.
// Plain functions with no Electron in them, so test/unit.js can check every rule with plain Node.

const path = require('path');

const LIVE_URL = 'https://tendha2020-ai.github.io/account-shop/animals/';

// Only for tests: ANTICS_URL points the app at a local copy of the site. It is taken only when it is a
// plain http address on this computer (127.0.0.1, localhost or [::1]), so it can never point the app at
// another site.
function siteUrl(env = process.env) {
  const raw = (env.ANTICS_URL || '').trim();
  if (!raw) return LIVE_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return LIVE_URL;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'http:' || !loopback || u.username || u.password) return LIVE_URL;
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return u.href;
}

// The site is one origin plus one folder: https://tendha2020-ai.github.io + /account-shop/animals/.
function makeSite(url) {
  const u = new URL(url);
  return { url: u.href, origin: u.origin, base: u.pathname, host: u.host };
}

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

function isSiteUrl(url, site) {
  const u = parse(url);
  if (!u || u.origin !== site.origin) return false;
  // "/account-shop/animals" (no slash) is the same folder: GitHub Pages sends it on to the slash form.
  return u.pathname.startsWith(site.base) || `${u.pathname}/` === site.base;
}

// The worker runs on a Hugging Face Space (https://<owner>-<name>.hf.space). Its files (a finished video,
// a cut) carry the private key in the address, so they are saved here instead of going to the browser.
function isWorkerUrl(url) {
  const u = parse(url);
  return Boolean(u && u.protocol === 'https:' && u.hostname.endsWith('.hf.space'));
}

// What to do with a window navigation or a new window:
//   'site'     load it in an antics window
//   'download' save it (the worker's files, the page's own blob: files)
//   'external' hand it to the default browser (huggingface.co, tiktok.com, any other web page, mailto:)
//   'block'    do nothing (file:, javascript:, data:, custom schemes, junk)
function classify(url, site) {
  const u = parse(url);
  if (!u) return 'block';
  if (u.protocol === 'blob:') {
    const inner = parse(u.pathname);
    return inner && inner.origin === site.origin ? 'download' : 'block';
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.username || u.password) return 'block';
    if (isSiteUrl(u.href, site)) return 'site';
    if (isWorkerUrl(u.href)) return 'download';
    return 'external';
  }
  if (u.protocol === 'mailto:') return 'external';
  return 'block';
}

// Permissions the site may have. Everything else (screen capture, location, USB, MIDI, …) is refused.
const SITE_PERMISSIONS = new Set([
  'media', // microphone (Speak, voice orders); the camera too, if the site ever asks
  'notifications',
  'clipboard-read', // the Paste buttons
  'clipboard-sanitized-write', // Copy app link, Copy invite link
  'fullscreen', // a video's full-screen button
]);

function originOf(url) {
  const u = parse(url);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
}

// A permission request (getUserMedia, Notification.requestPermission, clipboard.readText, …).
// requestingUrl is the frame that asked; topUrl the page in the window. Both must be the site, so a frame
// from another site inside the page gets nothing.
function allowRequest(permission, { requestingUrl, topUrl, mediaTypes } = {}, site) {
  if (!SITE_PERMISSIONS.has(permission)) return false;
  if (originOf(requestingUrl) !== site.origin) return false;
  if (topUrl !== undefined && topUrl !== null && originOf(topUrl) !== site.origin) return false;
  if (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.some((t) => t !== 'audio' && t !== 'video')) {
    return false;
  }
  return true;
}

// A permission check (Notification.permission, navigator.permissions.query, the service worker's
// notifications). requestingOrigin is the asking frame's origin; embeddingOrigin is set for a frame
// inside another page.
function allowCheck(permission, requestingOrigin, { embeddingOrigin } = {}, site) {
  if (!SITE_PERMISSIONS.has(permission)) return false;
  if (originOf(requestingOrigin) !== site.origin) return false;
  if (embeddingOrigin && originOf(embeddingOrigin) !== site.origin) return false;
  return true;
}

const EXT_BY_TYPE = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/zip': '.zip',
};

// The name offered in the Save dialog. The worker's addresses end in /video or /cut, which would save
// as a file called "video" with no type; this makes it "antics-video.mp4".
function downloadName(name, mime) {
  let base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (!base || base === '.' || base === '..') base = 'antics';
  if (!path.extname(base)) {
    const ext = EXT_BY_TYPE[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
    if (!base.startsWith('antics')) base = `antics-${base}`;
    base += ext;
  }
  return base;
}

// The first command-line argument that is a page of the site (e.g. an app link given to antics.exe).
function siteUrlFromArgs(argv, site) {
  for (const a of argv || []) {
    if (typeof a === 'string' && /^https?:/i.test(a) && classify(a, site) === 'site') return new URL(a).href;
  }
  return null;
}

module.exports = {
  LIVE_URL,
  SITE_PERMISSIONS,
  siteUrl,
  makeSite,
  isSiteUrl,
  isWorkerUrl,
  classify,
  allowRequest,
  allowCheck,
  downloadName,
  siteUrlFromArgs,
};
