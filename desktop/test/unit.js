'use strict';
// Plain-Node checks of lib/policy.js and lib/window-state.js: node test/unit.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../lib/policy');
const ws = require('../lib/window-state');

let n = 0;
const t = (name, fn) => {
  fn();
  n += 1;
  console.log(`ok - ${name}`);
};

const LIVE = policy.makeSite(policy.LIVE_URL);

t('site URL: live by default, ANTICS_URL only for a local http address', () => {
  assert.strictEqual(policy.siteUrl({}), 'https://tendha2020-ai.github.io/account-shop/animals/');
  assert.strictEqual(policy.siteUrl({ ANTICS_URL: 'http://127.0.0.1:8933/animals/' }), 'http://127.0.0.1:8933/animals/');
  assert.strictEqual(policy.siteUrl({ ANTICS_URL: 'http://localhost:8933/animals' }), 'http://localhost:8933/animals/');
  assert.strictEqual(policy.siteUrl({ ANTICS_URL: 'http://[::1]:8933/x/?a=1#b' }), 'http://[::1]:8933/x/');
  for (const bad of ['https://evil.example/', 'http://192.168.1.5/animals/', 'http://127.0.0.1.evil.example/',
    'file:///etc/', 'javascript:alert(1)', 'not a url', 'http://user:pw@127.0.0.1:8933/']) {
    assert.strictEqual(policy.siteUrl({ ANTICS_URL: bad }), policy.LIVE_URL, bad);
  }
});

t('classify: the site stays in the window', () => {
  for (const u of ['https://tendha2020-ai.github.io/account-shop/animals/',
    'https://tendha2020-ai.github.io/account-shop/animals/#app=eyJ3Ijo',
    'https://tendha2020-ai.github.io/account-shop/animals/pc.html',
    'https://tendha2020-ai.github.io/account-shop/animals']) {
    assert.strictEqual(policy.classify(u, LIVE), 'site', u);
  }
});

t('classify: other sites go to the browser', () => {
  for (const u of ['https://huggingface.co/settings/tokens/new?tokenType=write', 'https://www.tiktok.com/@tendha2',
    'https://huggingface.co/spaces/tendha2/antics-worker', 'http://example.com/',
    'https://tendha2020-ai.github.io/account-shop/', 'https://tendha2020-ai.github.io/account-shop/animalsX/',
    'https://tendha2020-ai.github.io.evil.example/account-shop/animals/', 'http://tendha2020-ai.github.io/account-shop/animals/',
    'mailto:someone@example.com']) {
    assert.strictEqual(policy.classify(u, LIVE), 'external', u);
  }
});

t("classify: the worker's files and the page's own blob: files are saved", () => {
  assert.strictEqual(policy.classify('https://tendha2-antics-worker.hf.space/jobs/abc/video?key=k&v=3', LIVE), 'download');
  assert.strictEqual(policy.classify('blob:https://tendha2020-ai.github.io/0b6f6b2a-1111-2222-3333-444455556666', LIVE), 'download');
  assert.strictEqual(policy.classify('http://x.hf.space/jobs/abc/video', LIVE), 'external'); // not https: not the worker
});

t('classify: everything else does nothing', () => {
  for (const u of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank',
    'ms-settings:privacy', 'tiktok://open', 'blob:https://evil.example/123', 'https://user:pw@huggingface.co/', '', 'junk']) {
    assert.strictEqual(policy.classify(u, LIVE), 'block', u);
  }
});

t('permission requests: only the site, only the listed permissions', () => {
  const top = 'https://tendha2020-ai.github.io/account-shop/animals/';
  for (const p of ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']) {
    assert.strictEqual(policy.allowRequest(p, { requestingUrl: top, topUrl: top, mediaTypes: ['audio'] }, LIVE), true, p);
  }
  for (const p of ['geolocation', 'display-capture', 'midi', 'midiSysex', 'hid', 'usb', 'serial', 'openExternal',
    'pointerLock', 'keyboardLock', 'idle-detection', 'window-management', 'unknown']) {
    assert.strictEqual(policy.allowRequest(p, { requestingUrl: top, topUrl: top }, LIVE), false, p);
  }
  // A frame from another site inside the page, or the site inside another page: no.
  assert.strictEqual(policy.allowRequest('media', { requestingUrl: 'https://evil.example/', topUrl: top, mediaTypes: ['audio'] }, LIVE), false);
  assert.strictEqual(policy.allowRequest('media', { requestingUrl: top, topUrl: 'https://evil.example/' }, LIVE), false);
  assert.strictEqual(policy.allowRequest('notifications', { requestingUrl: 'https://huggingface.co/', topUrl: 'https://huggingface.co/' }, LIVE), false);
  assert.strictEqual(policy.allowRequest('media', { requestingUrl: 'file:///x/offline.html', topUrl: 'file:///x/offline.html' }, LIVE), false);
  assert.strictEqual(policy.allowRequest('media', { requestingUrl: top, topUrl: '' }, LIVE), false);
  // The site's origin for the whole origin (permissions are per origin in browsers too).
  assert.strictEqual(policy.allowRequest('notifications', { requestingUrl: 'https://tendha2020-ai.github.io/account-shop/' }, LIVE), true);
});

t('permission checks: only the site origin, not when embedded elsewhere', () => {
  const o = 'https://tendha2020-ai.github.io';
  assert.strictEqual(policy.allowCheck('notifications', o, {}, LIVE), true);
  assert.strictEqual(policy.allowCheck('media', o, { securityOrigin: o }, LIVE), true);
  assert.strictEqual(policy.allowCheck('notifications', 'https://evil.example', {}, LIVE), false);
  assert.strictEqual(policy.allowCheck('notifications', o, { embeddingOrigin: 'https://evil.example' }, LIVE), false);
  assert.strictEqual(policy.allowCheck('geolocation', o, {}, LIVE), false);
});

t('download names', () => {
  assert.strictEqual(policy.downloadName('video', 'video/mp4'), 'antics-video.mp4');
  assert.strictEqual(policy.downloadName('cut', 'video/mp4; codecs=avc1'), 'antics-cut.mp4');
  assert.strictEqual(policy.downloadName('antics-abc123.mp4', 'video/mp4'), 'antics-abc123.mp4');
  assert.strictEqual(policy.downloadName('antics', 'video/mp4'), 'antics.mp4');
  assert.strictEqual(policy.downloadName('', ''), 'antics');
  assert.strictEqual(policy.downloadName('..\\..\\evil.exe', ''), 'evil.exe');
  assert.strictEqual(policy.downloadName('a:b*c?.mp4', ''), 'a_b_c_.mp4');
  assert.strictEqual(policy.downloadName('song', 'audio/mpeg'), 'antics-song.mp3');
});

t('app link given on the command line', () => {
  const link = 'https://tendha2020-ai.github.io/account-shop/animals/#app=eyJ3Ijoi';
  assert.strictEqual(policy.siteUrlFromArgs(['C:\\antics\\antics.exe', '--allow-file-access-from-files', link], LIVE), link);
  assert.strictEqual(policy.siteUrlFromArgs(['antics.exe', 'https://evil.example/'], LIVE), null);
  assert.strictEqual(policy.siteUrlFromArgs(['antics.exe', '.'], LIVE), null);
  assert.strictEqual(policy.siteUrlFromArgs(undefined, LIVE), null);
});

t('window state: defaults, limits, off-screen positions dropped', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepStrictEqual(ws.sanitize(null, screens), { width: 1280, height: 860, maximized: false, zoom: 0 });
  assert.deepStrictEqual(ws.sanitize({ x: 100, y: 50, width: 900, height: 700, maximized: true, zoom: 1 }, screens),
    { x: 100, y: 50, width: 900, height: 700, maximized: true, zoom: 1 });
  const off = ws.sanitize({ x: 3000, y: 50, width: 900, height: 700 }, screens); // second monitor unplugged
  assert.strictEqual(off.x, undefined);
  assert.strictEqual(off.width, 900);
  const tiny = ws.sanitize({ width: 10, height: 10, zoom: 99 }, screens);
  assert.deepStrictEqual([tiny.width, tiny.height, tiny.zoom], [380, 560, 5]);
  assert.deepStrictEqual(ws.sanitize({ width: 'x', x: NaN, maximized: 'yes' }, screens), ws.sanitize(null, screens));
});

t('window state: load/save round trip, damaged file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antics-ws-'));
  const file = path.join(dir, 'window-state.json');
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepStrictEqual(ws.load(file, screens), ws.sanitize(null, screens));
  ws.save(file, { x: 10, y: 20, width: 1000, height: 800, maximized: false, zoom: -0.5 });
  assert.deepStrictEqual(ws.load(file, screens), { x: 10, y: 20, width: 1000, height: 800, maximized: false, zoom: -0.5 });
  fs.writeFileSync(file, '{oops');
  assert.deepStrictEqual(ws.load(file, screens), ws.sanitize(null, screens));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${n} passed`);
