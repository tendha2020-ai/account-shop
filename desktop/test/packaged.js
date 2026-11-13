'use strict';
// The BUILT app (asar + fuses, as shipped) on Linux: npm run dist:linux-dir, then
//   xvfb-run -a node test/packaged.js dist/linux-unpacked/antics
// Playwright can't drive it (the fuses turn off --inspect), so this talks to the page over the Chrome DevTools
// port. It serves the repo on 127.0.0.1:8933 and uses :8934 for DevTools (ANTICS_TEST_PORT moves both;
// ANTICS_TEST_OTHER sets the second one).

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'linux-unpacked', 'antics'));
const ROOT = path.resolve(process.env.ANTICS_TEST_ROOT || path.join(__dirname, '..', '..'));
const APP_VERSION = require('../package.json').version;
const PORT = Number(process.env.ANTICS_TEST_PORT || 8933);
const DEVTOOLS = Number(process.env.ANTICS_TEST_OTHER || PORT + 1);
const SITE = `http://127.0.0.1:${PORT}/animals/`;
const TMP = fs.mkdtempSync(path.join(process.env.ANTICS_TEST_TMP || os.tmpdir(), 'antics-packaged-'));
const CFG = path.join(TMP, 'config');
const ROOT_FLAGS = process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []; // Chromium refuses root without it
const ENV = { ...process.env, ANTICS_URL: SITE, XDG_CONFIG_HOME: CFG, NODE_OPTIONS: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const real = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(real, (err, body) => {
      if (err || !real.startsWith(ROOT)) return res.writeHead(404).end();
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' }[path.extname(real)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function start(extra = [], env = ENV) {
  const child = spawn(BIN, [...ROOT_FLAGS, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.out += d; });
  child.done = new Promise((resolve) => child.on('exit', (code, sig) => resolve(code ?? sig)));
  return child;
}
const launch = () => start([`--remote-debugging-port=${DEVTOOLS}`]);
async function quit(child) {
  child.kill('SIGTERM');
  const r = await Promise.race([child.done, sleep(10000).then(() => 'stuck')]);
  if (r === 'stuck') child.kill('SIGKILL');
}

// A tiny DevTools client: the page target, and Runtime.evaluate in it.
const targets = async () => (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json()).filter((t) => t.type === 'page');
async function evaluate(expression) {
  const [t] = await targets();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const reply = new Promise((resolve) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) resolve(msg);
    };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  const msg = await reply;
  ws.close();
  if (msg.result.exceptionDetails) throw new Error(msg.result.exceptionDetails.text);
  return msg.result.result.value;
}
const pageUrl = async () => ((await targets())[0] || {}).url || '';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`ok - ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL - ${name}\n   ${(e && e.stack) || e}`);
  }
}

(async () => {
  assert.ok(fs.existsSync(BIN), `no app at ${BIN}`);
  let server = null;
  let app = launch();

  await test('the site is down: the offline screen (from inside app.asar) shows', async () => {
    await until(async () => (await pageUrl()).includes('app.asar/offline.html'), 'the offline screen');
    const r = await until(() => evaluate(`({ title: document.getElementById('title').textContent,
      icon: document.querySelector('img').complete && document.querySelector('img').naturalWidth, antics: window.antics })`), 'the screen');
    assert.match(r.title, /can't load right now/);
    assert.ok(r.icon >= 96, `icon loaded from the asar (${r.icon})`);
    assert.deepStrictEqual(r.antics, { desktop: true, version: APP_VERSION });
  });

  await test('Retry loads the site once it is up; window.antics is there; no Node in the page', async () => {
    server = await serve();
    await evaluate(`document.getElementById('retry').click()`);
    await until(async () => (await pageUrl()) === SITE, 'the site');
    const r = await until(() => evaluate(`document.readyState === 'complete' && ({ antics: window.antics, require: typeof require, process: typeof process })`), 'the page');
    assert.deepStrictEqual(r, { antics: { desktop: true, version: APP_VERSION }, require: 'undefined', process: 'undefined' });
    await evaluate(`localStorage.setItem('antics-packaged', 'kept')`);
  });

  await test('a second copy quits at once (one antics at a time)', async () => {
    const t0 = Date.now();
    const second = start([`${SITE}#e2e=packaged`]);
    const code = await Promise.race([second.done, sleep(20000).then(() => 'still running')]);
    if (code === 'still running') second.kill('SIGKILL');
    assert.strictEqual(code, 0, `exit ${code}`);
    await until(async () => (await pageUrl()) === `${SITE}#e2e=packaged`, 'the link handed to the first copy');
    console.log(`   (second copy quit after ${Date.now() - t0} ms)`);
  });

  await test('the fuses hold: no run-as-Node, no --inspect', async () => {
    const asNode = start(['-e', 'console.log("RAN_AS_NODE")'], { ...ENV, ELECTRON_RUN_AS_NODE: '1' });
    await Promise.race([asNode.done, sleep(15000)]);
    asNode.kill('SIGKILL');
    assert.ok(!asNode.out.includes('RAN_AS_NODE'), 'ELECTRON_RUN_AS_NODE ran a script');
    const inspect = start(['--inspect=0']);
    await Promise.race([inspect.done, sleep(15000)]);
    inspect.kill('SIGKILL');
    assert.ok(!/Debugger listening/.test(inspect.out), 'the Node inspector started');
  });

  await test('localStorage is kept after a restart', async () => {
    await quit(app);
    app = launch();
    await until(async () => (await pageUrl()) === SITE, 'the site after the restart');
    const v = await until(() => evaluate(`document.readyState === 'complete' && localStorage.getItem('antics-packaged')`), 'the value');
    assert.strictEqual(v, 'kept');
    assert.ok(fs.existsSync(path.join(CFG, 'antics', 'Partitions', 'antics')), 'data in <config>/antics/Partitions/antics');
  });

  await quit(app);
  if (server) server.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed (temp files: ${TMP})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
