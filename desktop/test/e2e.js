'use strict';
// The desktop app end to end on Linux (the same main.js as on Windows), pointed at a local copy of the site.
//
//   npm install && npm i --no-save playwright      (or set PLAYWRIGHT=/path/to/playwright)
//   xvfb-run -a node test/e2e.js                  (needs a display; xvfb-run gives one)
//
// It serves the folder above desktop/ (the repo, with animals/ in it) on 127.0.0.1:8933 (the site) and :8934
// (another site, and the "server down" case). Nothing outside this computer is called: huggingface.co and
// tiktok.com links are caught before the browser opens, and the worker's address is answered locally.
// Env: ANTICS_TEST_PORT (8933), ANTICS_TEST_OTHER (the second port, default ANTICS_TEST_PORT + 1), ANTICS_TEST_ROOT
// (the repo), ANTICS_TEST_TMP (a temp folder).

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const electronPath = require('electron');

const APP_DIR = path.resolve(__dirname, '..');
const APP_VERSION = require('../package.json').version;
const ROOT = path.resolve(process.env.ANTICS_TEST_ROOT || path.join(APP_DIR, '..'));
const PORT = Number(process.env.ANTICS_TEST_PORT || 8933);
const OTHER = Number(process.env.ANTICS_TEST_OTHER || PORT + 1);
const SITE = `http://127.0.0.1:${PORT}/animals/`;
const DOWN_SITE = `http://127.0.0.1:${OTHER}/animals/`;
const TMP = fs.mkdtempSync(path.join(process.env.ANTICS_TEST_TMP || os.tmpdir(), 'antics-e2e-'));

// ---------- a small static server we can stop and start ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json',
};
function serve(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // /moved/...: the site's address now forwards to another one (as GitHub Pages does after a custom domain)
    if (u.pathname.startsWith('/moved/')) {
      res.writeHead(301, { Location: `http://localhost:${port}${u.pathname.replace(/^\/moved\//, '/animals/')}` }).end();
      return;
    }
    let file = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
const stop = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

// ---------- helpers ----------

const xdo = (...args) => {
  try {
    return execFileSync('xdotool', args, { encoding: 'utf8' });
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

function env(cfg, url) {
  // On Linux the app keeps its data in $XDG_CONFIG_HOME/antics: a folder per test = a fresh install.
  return { ...process.env, ANTICS_URL: url, XDG_CONFIG_HOME: cfg };
}

async function launch(cfg, url = SITE, extra = []) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: ['--use-fake-device-for-media-stream', APP_DIR, ...extra],
    env: env(cfg, url),
  });
  const page = await app.firstWindow();
  // The main window is the first one; children opened later come first in getAllWindows().
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.mainWin = BrowserWindow.getAllWindows().reduce((a, b) => (a.id < b.id ? a : b));
  });
  return { app, page };
}

// Runs in the main process: swap shell.openExternal and dialog.showMessageBox for recorders.
async function recordOutside(app) {
  await app.evaluate(({ shell, dialog }) => {
    globalThis.opened = [];
    globalThis.boxes = [];
    shell.openExternal = async (url) => {
      globalThis.opened.push(url);
    };
    dialog.showMessageBox = async (...args) => {
      globalThis.boxes.push(args.find((a) => a && a.message));
      return { response: 0, checkboxChecked: false };
    };
  });
}
const opened = (app) => app.evaluate(() => globalThis.opened);
const windows = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const mainUrl = (app) => app.evaluate(() => globalThis.mainWin.webContents.getURL());

async function clickLink(page, href, { target = '', download = false } = {}) {
  await page.evaluate(({ href: h, target: t, download: d }) => {
    const a = document.createElement('a');
    a.href = h;
    a.textContent = 'test link';
    a.id = 'e2e-link';
    if (t) a.target = t;
    if (d) a.download = '';
    a.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;padding:20px;background:#fff';
    document.body.appendChild(a);
  }, { href, target, download });
  // A DOM click: page.click() would wait for a navigation that the app cancels on purpose.
  await page.evaluate(() => {
    const a = document.getElementById('e2e-link');
    a.click();
    a.remove();
  });
}

// ---------- the tests ----------

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok - ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`FAIL - ${name}\n   ${(e && e.stack) || e}`);
  }
}

(async () => {
  const site = await serve(PORT);
  let other = await serve(OTHER);
  const cfg = path.join(TMP, 'profile-main');
  let app;
  let page;

  await test('the window opens the site, titled antics, with the safe settings', async () => {
    ({ app, page } = await launch(cfg));
    await page.waitForLoadState('load');
    assert.strictEqual(page.url(), SITE);
    const info = await app.evaluate(({ BrowserWindow, app: a }) => {
      const w = globalThis.mainWin;
      const p = w.webContents.getLastWebPreferences();
      return {
        count: BrowserWindow.getAllWindows().length, title: w.getTitle(), visible: w.isVisible(), name: a.getName(),
        prefs: { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webviewTag: p.webviewTag, webSecurity: p.webSecurity },
        persistent: w.webContents.session.isPersistent(),
        storage: w.webContents.session.getStoragePath(),
      };
    });
    assert.strictEqual(info.count, 1);
    assert.strictEqual(info.title, 'antics');
    assert.strictEqual(info.visible, true);
    assert.strictEqual(info.name, 'antics');
    assert.deepStrictEqual(info.prefs, { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, webSecurity: true });
    assert.strictEqual(info.persistent, true);
    assert.ok(info.storage.endsWith(path.join('Partitions', 'antics')), info.storage);
    await page.waitForTimeout(500);
    assert.strictEqual(await app.evaluate(() => globalThis.mainWin.getTitle()), 'antics'); // the page's own title doesn't replace it
    await page.screenshot({ path: path.join(TMP, 'window.png') });
  });

  await test('window.antics is { desktop: true, version } and nothing of Node reaches the page', async () => {
    const r = await page.evaluate(() => ({
      antics: window.antics, keys: Object.keys(window.antics), require: typeof require, process: typeof process,
      module: typeof module, electron: typeof window.electron, ipc: typeof window.ipcRenderer,
    }));
    assert.deepStrictEqual(r.antics, { desktop: true, version: APP_VERSION });
    assert.deepStrictEqual(r.keys.sort(), ['desktop', 'version']);
    assert.deepStrictEqual([r.require, r.process, r.module, r.electron, r.ipc], Array(5).fill('undefined'));
    const after = await page.evaluate(() => {
      try {
        window.antics.desktop = false;
      } catch { /* frozen */ }
      return window.antics.desktop;
    });
    assert.strictEqual(after, true);
  });

  await test('the menu: Reload, Zoom in/out/reset, Toggle full screen, About', async () => {
    await recordOutside(app);
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((m) => [m.label, m.submenu.items.filter((i) => i.visible && i.type !== 'separator').map((i) => i.label)]));
    const flat = labels.flatMap(([, items]) => items);
    for (const l of ['Reload', 'Zoom in', 'Zoom out', 'Actual size', 'Toggle full screen', 'About antics', 'Quit antics', 'Open my app link (copied)']) {
      assert.ok(flat.includes(l), `menu has ${l}: ${JSON.stringify(labels)}`);
    }
    const click = (id) => app.evaluate(({ Menu }, i) => {
      globalThis.mainWin.focus();
      Menu.getApplicationMenu().getMenuItemById(i).click();
    }, id);
    const level = () => app.evaluate(() => globalThis.mainWin.webContents.getZoomLevel());
    await click('zoom-in');
    await click('zoom-in');
    assert.strictEqual(await level(), 1);
    await click('zoom-out');
    assert.strictEqual(await level(), 0.5);
    await click('zoom-reset');
    assert.strictEqual(await level(), 0);
    // Ctrl + mouse wheel: Electron emits zoom-changed and the app zooms.
    await app.evaluate(() => globalThis.mainWin.webContents.emit('zoom-changed', {}, 'in'));
    assert.strictEqual(await level(), 0.5);
    await app.evaluate(() => globalThis.mainWin.webContents.emit('zoom-changed', {}, 'out'));
    assert.strictEqual(await level(), 0);
    await page.evaluate(() => {
      window.e2eMark = 'before-reload';
    });
    await click('reload');
    await page.waitForLoadState('load');
    await until(async () => (await page.evaluate(() => window.e2eMark)) === undefined, 'the page to reload');
    await click('about');
    const boxes = await app.evaluate(() => globalThis.boxes);
    assert.ok(boxes.length === 1 && /^antics 1\.0\.0$/.test(boxes[0].message), JSON.stringify(boxes));
    assert.ok(boxes[0].detail.includes(SITE));
    await click('fullscreen');
    const full = await until(() => app.evaluate(() => globalThis.mainWin.isFullScreen()), 'full screen', 5000).catch(() => false);
    await click('fullscreen');
    const back = await until(() => app.evaluate(() => !globalThis.mainWin.isFullScreen()), 'leave full screen', 5000).catch(() => false);
    console.log(`   (full screen under Xvfb: on=${full} off=${back})`);
  });

  await test('links to other sites open in the default browser, not in the window', async () => {
    await recordOutside(app);
    await clickLink(page, 'https://huggingface.co/settings/tokens/new?tokenType=write', { target: '_blank' });
    await clickLink(page, 'https://www.tiktok.com/@tendha2');
    await page.evaluate(() => window.open('https://huggingface.co/spaces/x/y'));
    await clickLink(page, 'mailto:someone@example.com');
    await until(async () => (await opened(app)).length >= 4, 'four external opens');
    assert.deepStrictEqual(await opened(app), [
      'https://huggingface.co/settings/tokens/new?tokenType=write', 'https://www.tiktok.com/@tendha2',
      'https://huggingface.co/spaces/x/y', 'mailto:someone@example.com',
    ]);
    await sleep(300);
    assert.strictEqual(await windows(app), 1);
    assert.strictEqual(await mainUrl(app), SITE);
  });

  await test('file:, javascript: and other schemes do nothing', async () => {
    await recordOutside(app);
    await page.evaluate(() => {
      window.open('file:///etc/passwd');
      window.open('tiktok://open');
    });
    await page.evaluate(() => {
      try {
        location.href = 'ms-settings:privacy';
      } catch { /* blocked */ }
    });
    await sleep(800);
    assert.deepStrictEqual(await opened(app), []);
    assert.strictEqual(await windows(app), 1);
    assert.strictEqual(await mainUrl(app), SITE);
  });

  await test('a page of the site asked for in a new tab opens in another antics window (same session, same rules)', async () => {
    await recordOutside(app);
    const child = app.waitForEvent('window');
    await clickLink(page, `${SITE}pc.html`, { target: '_blank' });
    const p2 = await child;
    await p2.waitForLoadState('load');
    assert.strictEqual(p2.url(), `${SITE}pc.html`);
    const r = await p2.evaluate(() => ({ antics: window.antics, require: typeof require }));
    assert.deepStrictEqual(r, { antics: { desktop: true, version: APP_VERSION }, require: 'undefined' });
    const same = await app.evaluate(({ BrowserWindow }) => {
      const a = globalThis.mainWin;
      const b = BrowserWindow.getAllWindows().find((w) => w !== a);
      const p = b.webContents.getLastWebPreferences();
      return a.webContents.session === b.webContents.session && p.sandbox && p.contextIsolation && !p.nodeIntegration;
    });
    assert.strictEqual(same, true);
    // The new window follows the same rules: another site from it goes to the browser.
    await p2.evaluate(() => window.open('https://huggingface.co/from-child'));
    await until(async () => (await opened(app)).includes('https://huggingface.co/from-child'), 'external from child');
    await p2.close();
    await until(async () => (await windows(app)) === 1, 'child window closed');
  });

  await test("the worker's files and the page's own files are saved, starting in Downloads (save dialog)", async () => {
    await recordOutside(app);
    const dl = path.join(TMP, 'Downloads');
    fs.mkdirSync(dl, { recursive: true });
    const saved = path.join(TMP, 'saved');
    fs.mkdirSync(saved, { recursive: true });
    await app.evaluate(({ app: a }, { dl: d, saved: s, port }) => {
      a.setPath('downloads', d);
      globalThis.downloads = [];
      const ses = globalThis.mainWin.webContents.session;
      // The worker's address answered by the local server (never the real Hugging Face).
      ses.webRequest.onBeforeRequest({ urls: ['https://*.hf.space/*'] }, (details, cb) => {
        globalThis.downloads.push({ asked: details.url });
        cb({ redirectURL: `http://127.0.0.1:${port}/animals/brand/icon-192.png` });
      });
      // Runs after the app's own will-download: record what the Save dialog would show, then answer it.
      ses.on('will-download', (e, item) => {
        const o = item.getSaveDialogOptions();
        const rec = { preset: item.getSavePath(), defaultPath: o.defaultPath, url: item.getURL(), state: 'started' };
        globalThis.downloads.push(rec);
        item.setSavePath(`${s}/${(o.defaultPath || 'x').split(/[\\/]/).pop()}`);
        item.once('done', (ev, st) => {
          rec.state = st;
          rec.savedTo = item.getSavePath();
        });
      });
    }, { dl, saved, port: PORT });
    // 1. "Save video" when the video is still on the worker (a link to <worker>.hf.space with the key in it).
    await clickLink(page, 'https://antics-e2e-fake.hf.space/jobs/abc123/video?key=secret&v=2', { target: '_blank', download: true });
    // 2. the same without target (a plain navigation of the window).
    await clickLink(page, 'https://antics-e2e-fake.hf.space/jobs/abc123/cut?key=secret');
    // 3. the page's own blob: file with a download name (how app.js saves a finished video).
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([new Uint8Array(4096).fill(7)], { type: 'video/mp4' }));
      a.download = 'antics-e2etest.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    const recs = await until(async () => {
      const d = (await app.evaluate(() => globalThis.downloads)).filter((x) => x.state);
      return d.length >= 3 && d.every((x) => x.state === 'completed') && d;
    }, 'three finished downloads');
    for (const r of recs) {
      assert.strictEqual(r.preset, '', 'the app sets no save path, so the Save dialog is shown');
      assert.strictEqual(path.dirname(r.defaultPath), dl, `the dialog starts in Downloads: ${r.defaultPath}`);
      assert.ok(fs.existsSync(r.savedTo) && fs.statSync(r.savedTo).size > 0, r.savedTo);
    }
    const names = recs.map((r) => path.basename(r.defaultPath)).sort();
    assert.ok(names.includes('antics-e2etest.mp4'), names.join(','));
    assert.strictEqual(fs.statSync(path.join(saved, 'antics-e2etest.mp4')).size, 4096);
    assert.deepStrictEqual(await opened(app), [], 'nothing went to the browser (the key stays in the app)');
    assert.strictEqual(await windows(app), 1);
    assert.strictEqual(await mainUrl(app), SITE);
    const asked = (await app.evaluate(() => globalThis.downloads)).filter((x) => x.asked).map((x) => x.asked);
    assert.ok(asked.some((u) => u.includes('/jobs/abc123/video')) && asked.some((u) => u.includes('/jobs/abc123/cut')), asked.join(' '));
  });

  await test('file pickers (uploads) work: the real file dialog opens and the page gets the file', async () => {
    // Driven like a person would, with xdotool (apt install xdotool): click the input, the system's
    // "Open File" dialog opens, type the file's path, click Open.
    const file = path.join(TMP, 'pet.mp4');
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'file';
      i.id = 'e2e-file';
      i.accept = 'video/*,image/*';
      i.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647';
      document.body.appendChild(i);
    });
    // A real mouse click (page.click() would first wait for the navigations the app cancelled earlier).
    const box = await page.evaluate(() => {
      const r = document.getElementById('e2e-file').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    const dlg = await until(() => xdo('search', '--onlyvisible', '--name', '^Open File$').trim().split('\n').pop(), 'the Open File dialog');
    xdo('windowfocus', '--sync', dlg);
    await sleep(400);
    xdo('key', 'ctrl+l');
    await sleep(300);
    xdo('type', '--delay', '5', file);
    await sleep(400);
    const geo = xdo('getwindowgeometry', '--shell', dlg);
    const g = Object.fromEntries(geo.trim().split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
    xdo('mousemove', String(g.X + g.WIDTH - 49), String(g.Y + g.HEIGHT - 24)); // the Open button
    await sleep(200);
    xdo('click', '1');
    const picked = await until(() => page.evaluate(() => {
      const f = document.getElementById('e2e-file').files;
      return f.length && [...f].map((x) => `${x.name}:${x.size}`);
    }), 'the picked file');
    assert.deepStrictEqual(picked, ['pet.mp4:2048']);
    await page.evaluate(() => document.getElementById('e2e-file').remove());
  });

  await test('the site gets the microphone, notifications and clipboard; another site and other permissions do not', async () => {
    const mine = await page.evaluate(async () => {
      const out = {};
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        out.mic = `granted:${s.getAudioTracks().length}`;
        s.getTracks().forEach((t) => t.stop());
      } catch (e) {
        out.mic = `error:${e.name}`;
      }
      out.notify = await Notification.requestPermission();
      out.notifyNow = Notification.permission;
      try {
        await navigator.clipboard.writeText('antics-clip-test');
        out.clip = await navigator.clipboard.readText();
      } catch (e) {
        out.clip = `error:${e.name}`;
      }
      out.geo = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r(`error:${e.code}`), { timeout: 5000 }));
      try {
        await navigator.mediaDevices.getDisplayMedia({ video: true });
        out.screen = 'granted';
      } catch (e) {
        out.screen = `error:${e.name}`;
      }
      return out;
    });
    assert.strictEqual(mine.mic, 'granted:1');
    assert.strictEqual(mine.notify, 'granted');
    assert.strictEqual(mine.notifyNow, 'granted');
    assert.strictEqual(mine.clip, 'antics-clip-test');
    assert.strictEqual(mine.geo, 'error:1'); // PERMISSION_DENIED
    assert.ok(/^error:/.test(mine.screen), mine.screen);

    // A frame from another origin (127.0.0.1:<other port>) inside the site, even with allow="microphone".
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.src = src;
      f.id = 'e2e-frame';
      f.allow = 'microphone; camera; clipboard-read; clipboard-write; fullscreen';
      document.body.appendChild(f);
    }, `http://127.0.0.1:${OTHER}/animals/pc.html`);
    const frame = await until(() => page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${OTHER}/`)), 'the other-site frame');
    await frame.waitForLoadState('load');
    const theirs = await frame.evaluate(async () => {
      const out = {};
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        out.mic = `granted:${s.getAudioTracks().length}`;
      } catch (e) {
        out.mic = `error:${e.name}`;
      }
      try {
        out.clip = await navigator.clipboard.readText();
      } catch (e) {
        out.clip = `error:${e.name}`;
      }
      return out;
    });
    assert.strictEqual(theirs.mic, 'error:NotAllowedError');
    assert.ok(/^error:/.test(theirs.clip), theirs.clip);
    await page.evaluate(() => document.getElementById('e2e-frame').remove());
  });

  await test('an app link given to a second antics.exe goes to the open window; the second copy quits', async () => {
    await app.evaluate(({ app: a }) => {
      globalThis.seconds = [];
      a.on('second-instance', (e, argv) => globalThis.seconds.push(argv));
    });
    await page.evaluate(() => {
      window.e2eMark = 'still-here';
    });
    const t0 = Date.now();
    // As root (CI containers) Chromium needs --no-sandbox; Playwright adds it to the first copy itself.
    const rootFlags = process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];
    const second = spawn(electronPath, [...rootFlags, APP_DIR, `${SITE}#e2e=second`], { env: { ...env(cfg, SITE), NODE_OPTIONS: '' }, stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      second.on('exit', (c) => resolve(c));
      setTimeout(() => {
        second.kill('SIGKILL');
        resolve('still running after 20 s');
      }, 20000);
    });
    assert.strictEqual(code, 0, `second copy exit: ${code}`);
    console.log(`   (second copy quit after ${Date.now() - t0} ms)`);
    const seen = await until(async () => (await app.evaluate(() => globalThis.seconds)).length, 'second-instance');
    assert.strictEqual(seen, 1);
    assert.strictEqual(await windows(app), 1);
    await until(async () => (await page.evaluate(() => location.hash)) === '#e2e=second', 'the link in the window');
    assert.strictEqual(await page.evaluate(() => window.e2eMark), 'still-here', 'the page was not reloaded (the site reads #app= on hashchange)');
  });

  await test('Open my app link (copied) loads a copied site link; anything else gets a hint', async () => {
    await recordOutside(app);
    await app.evaluate(({ clipboard }) => clipboard.writeText('https://evil.example/#app=x'));
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-link').click());
    await until(async () => (await app.evaluate(() => globalThis.boxes)).length === 1, 'the hint');
    assert.ok(!(await mainUrl(app)).includes('evil'));
    await app.evaluate(({ clipboard }, u) => clipboard.writeText(`  ${u}#e2e=copied  `), SITE);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-link').click());
    await until(async () => (await page.evaluate(() => location.hash)) === '#e2e=copied', 'the copied link in the window');
  });

  // The page "inMain" helpers are defined below; these use the main process directly.
  const mainJs = (code) => app.evaluate((_, c) => globalThis.mainWin.webContents.executeJavaScript(c), code);
  // (as if after a click: Chromium skips history steps a page added without one, like the browser's Back button does)
  const mainTap = (code) => app.evaluate((_, c) => globalThis.mainWin.webContents.executeJavaScript(c, true), code);

  await test('about:blank (which gets past will-navigate) sends the window back to the site; Back never goes there', async () => {
    await recordOutside(app);
    await app.evaluate((_, u) => globalThis.mainWin.webContents.loadURL(u), SITE);
    await until(async () => (await mainUrl(app)) === SITE && (await mainJs('Boolean(window.Studio)')), 'the site');
    await mainTap(`location.href = 'about:blank'`).catch(() => {});
    await until(async () => (await mainUrl(app)) === SITE && (await mainJs('Boolean(window.Studio)')), 'back on the site after about:blank');
    assert.strictEqual(await mainJs('origin'), new URL(SITE).origin);
    // the entry before is about:blank: Back (the mouse button, Alt+Left) refuses to go there
    const before = await app.evaluate(() => {
      const nav = globalThis.mainWin.webContents.navigationHistory;
      return { url: nav.getEntryAtIndex(nav.getActiveIndex() - 1).url, can: nav.canGoBack() };
    });
    assert.deepStrictEqual(before, { url: 'about:blank', can: true }, `the entry before: ${JSON.stringify(before)}`);
    await mainJs('window.e2eMark = "after-blank"');
    await app.evaluate(() => globalThis.mainWin.emit('app-command', {}, 'browser-backward'));
    await sleep(700);
    assert.strictEqual(await mainUrl(app), SITE);
    assert.strictEqual(await mainJs('window.e2eMark'), 'after-blank', 'no navigation to about:blank');
    // Reload from a window that is empty or off the site loads the site (here: the problem screen's file page)
    await app.evaluate((_, f) => globalThis.mainWin.webContents.loadFile(f), path.join(APP_DIR, 'offline.html'));
    await until(async () => (await mainUrl(app)).startsWith('file:'), 'the file page');
    await app.evaluate(({ Menu }) => {
      globalThis.mainWin.focus();
      Menu.getApplicationMenu().getMenuItemById('reload').click();
    });
    await until(async () => (await mainUrl(app)).startsWith(SITE), 'Reload -> the site');
    assert.deepStrictEqual(await opened(app), []);
    assert.strictEqual(await windows(app), 1);
  });

  await test("another site's frame: a window it opens and sends to about:blank closes; top.location = about:blank goes back to the site", async () => {
    await recordOutside(app);
    await app.evaluate((_, u) => globalThis.mainWin.webContents.loadURL(u), SITE);
    await until(async () => (await mainJs('Boolean(window.Studio)')), 'the site');
    const p = (await app.windows()).find((w) => w.url().startsWith(SITE)) || page;
    await p.evaluate((src) => {
      const f = document.createElement('iframe');
      f.src = src;
      f.id = 'e2e-frame2';
      f.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:240px;z-index:2147483647;background:#fff';
      document.body.appendChild(f);
    }, `http://127.0.0.1:${OTHER}/animals/pc.html`);
    const frame = await until(() => p.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${OTHER}/`)), 'the other-site frame');
    await frame.waitForLoadState('load');
    // 1. open a page of the site, then send that window to about:blank and write into it
    await frame.evaluate((u) => { window.w = window.open(u); }, `${SITE}pc.html`);
    await until(async () => (await windows(app)) === 2, 'the second window');
    const r = await frame.evaluate(async () => {
      try {
        window.w.location = 'about:blank';
      } catch (e) {
        return `throw:${e.name}`;
      }
      for (let i = 0; i < 40 && !window.w.closed; i++) await new Promise((res) => setTimeout(res, 150));
      return window.w.closed ? 'closed' : 'open';
    });
    assert.strictEqual(r, 'closed', `the retargeted window: ${r}`);
    assert.strictEqual(await windows(app), 1);
    // 2. the frame sends the whole window to about:blank (with a click: that's allowed for a frame)
    await frame.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'e2e-go';
      b.textContent = 'go';
      b.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:80px;z-index:9';
      b.onclick = () => { top.location = 'about:blank'; };
      document.body.appendChild(b);
    });
    await mainJs('window.e2eMark = "before-top-blank"');
    await frame.click('#e2e-go', { timeout: 5000 }).catch(() => {});
    await until(async () => (await mainUrl(app)) === SITE && (await mainJs('Boolean(window.Studio) && !window.e2eMark')), 'back on the site, a new page');
    assert.strictEqual(await mainJs('origin'), new URL(SITE).origin);
    assert.strictEqual(await mainJs('document.getElementById("e2e-frame2")'), null, 'a fresh copy of the site');
    assert.deepStrictEqual(await opened(app), []);
  });

  await test("Back and Forward: the mouse's side buttons, Alt+Left / Alt+Right and the View menu go through the site's tabs", async () => {
    await app.evaluate((_, u) => globalThis.mainWin.webContents.loadURL(u), SITE);
    await until(async () => (await mainJs('Boolean(window.Studio) && Studio.current()')) === 'make', 'the site on Make video');
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((m) => m.label === 'View').submenu.items.map((i) => i.label));
    assert.ok(labels.includes('Back') && labels.includes('Forward'), labels.join(','));
    await mainTap(`Studio.go('videos')`);
    await until(async () => (await mainUrl(app)).endsWith('?tab=videos'), '?tab=videos');
    const tab = () => mainJs('Studio.current()');
    // the mouse's Back side button (Windows sends it as an app command)
    await app.evaluate(() => globalThis.mainWin.emit('app-command', {}, 'browser-backward'));
    await until(async () => (await tab()) === 'make', 'Back (mouse) -> Make video');
    await app.evaluate(() => globalThis.mainWin.emit('app-command', {}, 'browser-forward'));
    await until(async () => (await tab()) === 'videos', 'Forward (mouse) -> My videos');
    // Alt+Left / Alt+Right, typed into the window
    await app.evaluate(() => {
      globalThis.mainWin.focus();
      globalThis.mainWin.webContents.focus();
      globalThis.mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] });
      globalThis.mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left', modifiers: ['alt'] });
    });
    await until(async () => (await tab()) === 'make', 'Alt+Left -> Make video');
    await app.evaluate(() => {
      globalThis.mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['alt'] });
      globalThis.mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['alt'] });
    });
    await until(async () => (await tab()) === 'videos', 'Alt+Right -> My videos');
    // the View menu's Back
    await app.evaluate(({ Menu }) => {
      globalThis.mainWin.focus();
      Menu.getApplicationMenu().getMenuItemById('back').click();
    });
    await until(async () => (await tab()) === 'make', 'View > Back -> Make video');
    assert.strictEqual(await windows(app), 1);
  });

  await test('localStorage, size, place and zoom are kept after a restart', async () => {
    const value = `kept-${Date.now()}`;
    await page.evaluate((v) => localStorage.setItem('antics-e2e', v), value);
    await app.evaluate(({ Menu }) => {
      const w = globalThis.mainWin;
      w.setBounds({ x: 140, y: 90, width: 1100, height: 760 });
      w.focus();
      Menu.getApplicationMenu().getMenuItemById('zoom-in').click();
    });
    await sleep(800);
    await app.close();
    const state = JSON.parse(fs.readFileSync(path.join(cfg, 'antics', 'window-state.json'), 'utf8'));
    assert.deepStrictEqual([state.x, state.y, state.width, state.height, state.zoom], [140, 90, 1100, 760, 0.5]);
    ({ app, page } = await launch(cfg));
    await page.waitForLoadState('load');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('antics-e2e')), value);
    const b = await app.evaluate(() => globalThis.mainWin.getBounds());
    assert.deepStrictEqual([b.x, b.y, b.width, b.height], [140, 90, 1100, 760]);
    await until(async () => (await app.evaluate(() => globalThis.mainWin.webContents.getZoomLevel())) === 0.5, 'zoom kept');
    await app.evaluate(({ Menu }) => {
      globalThis.mainWin.focus();
      Menu.getApplicationMenu().getMenuItemById('zoom-reset').click();
    });
  });

  // The problem screen is driven through the main process (executeJavaScript), because Playwright gives up on a page
  // object once its renderer has crashed or been swapped for the file:// screen.
  const inMain = (code) => app.evaluate((_, c) => globalThis.mainWin.webContents.executeJavaScript(c), code);
  const screenText = () => inMain(`[document.getElementById('title')?.textContent, document.getElementById('detail')?.textContent].join(' | ')`);
  const clickRetry = () => inMain(`document.getElementById('retry').click()`);

  await test('a crashed page shows the problem screen; Retry opens antics again', async () => {
    await app.evaluate(() => globalThis.mainWin.webContents.forcefullyCrashRenderer());
    await until(async () => (await mainUrl(app)).startsWith('file:') && /stopped unexpectedly/.test(await screenText()), 'the problem screen');
    await clickRetry();
    await until(async () => (await mainUrl(app)) === SITE, 'the site again');
    await until(async () => (await inMain('window.antics && window.antics.desktop')) === true, 'the site loaded');
    await app.close();
  });

  await test('the server is down: the offline screen shows; Retry recovers once it is back', async () => {
    await stop(other);
    const cfg2 = path.join(TMP, 'profile-offline');
    ({ app, page } = await launch(cfg2, DOWN_SITE));
    await until(async () => (await mainUrl(app)).startsWith('file:') && /can't load right now/.test(await screenText()), 'the offline screen');
    assert.strictEqual(await app.evaluate(() => globalThis.mainWin.isVisible()), true);
    assert.strictEqual(await app.evaluate(() => globalThis.mainWin.getTitle()), 'antics');
    const shot = await app.evaluate(async () => (await globalThis.mainWin.webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(TMP, 'offline.png'), Buffer.from(shot, 'base64'));
    // Retry while it is still down: the same screen, counting the tries.
    await clickRetry();
    await until(async () => /Tried 2 times/.test(await screenText()), 'the second try');
    other = await serve(OTHER);
    await clickRetry();
    await until(async () => (await mainUrl(app)) === DOWN_SITE, 'the site after Retry');
    await until(async () => (await inMain('window.antics && window.antics.desktop')) === true, 'the site loaded');
    await app.close();
  });

  await test('the site moved (its address forwards elsewhere): "antics has moved", not a blank window or a silent browser', async () => {
    const cfg3 = path.join(TMP, 'profile-moved');
    const MOVED = `http://127.0.0.1:${OTHER}/moved/`;
    ({ app, page } = await launch(cfg3, MOVED));
    const NEW = `http://localhost:${OTHER}/animals/`;
    await until(async () => (await mainUrl(app)).startsWith('file:') && /has moved/.test(await screenText()), 'the moved screen');
    const why = await inMain(`document.getElementById('why').textContent`);
    assert.ok(why.includes(`localhost:${OTHER}`), why);
    assert.strictEqual(await app.evaluate(() => globalThis.mainWin.isVisible()), true);
    // From here the browser is recorded: Reload shows the same screen again, still without opening the browser.
    await recordOutside(app);
    await app.evaluate(({ Menu }) => {
      globalThis.mainWin.focus();
      Menu.getApplicationMenu().getMenuItemById('reload').click();
    });
    await until(async () => /Tried 2 times/.test(await screenText()), 'the moved screen after Reload');
    assert.deepStrictEqual(await opened(app), []);
    // Open it in my browser: the new address goes to the default browser
    await inMain(`document.getElementById('browser').click()`);
    await until(async () => (await opened(app)).length === 1, 'the browser');
    assert.deepStrictEqual(await opened(app), [NEW]);
    assert.ok((await mainUrl(app)).startsWith('file:'), 'the window stays on the moved screen');
    await app.close();
  });

  await stop(site);
  await stop(other);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  console.log(`(screenshots and temp files: ${TMP})`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
