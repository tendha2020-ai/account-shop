// Entry point: loads config, runs the bot, serves the dashboard and OBS
// overlay, and relays everything over a WebSocket.
//
//   npm start            connect to the username in config.json
//   npm run demo         simulated events, no TikTok connection

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Bot } from './bot.js';
import { Simulator } from './simulator.js';
import { AiResponder } from './ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const DEMO = args.includes('--demo');

function loadConfig() {
  const own = path.join(ROOT, 'config.json');
  const file = fs.existsSync(own) ? own : path.join(ROOT, 'config.example.json');
  if (file !== own) console.log('Using settings from config.example.json (copy it to config.json to keep private changes out of git).');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const config = loadConfig();
const userArg = args.find((a) => a.startsWith('--user='));
if (userArg) config.tiktokUsername = userArg.slice(7);

const bot = new Bot(config);
const ai = new AiResponder(config);
const link = DEMO ? new Simulator() : new (await import('./tiktok.js')).TikTokLink(config);

// ---- WebSocket hub ----------------------------------------------------------

const clients = new Set();
const recentFeed = [];
const recentSays = [];

function broadcast(msg, role) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1 && (!role || ws.role === role)) ws.send(data);
  }
}

let stateQueued = false;
bot.on('change', () => {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => {
    stateQueued = false;
    broadcast({ type: 'state', state: bot.snapshot() });
  }, 300);
});

bot.on('feed', (item) => {
  recentFeed.push(item);
  if (recentFeed.length > 200) recentFeed.shift();
  broadcast({ type: 'feed', item });
});

bot.on('alert', (alert) => broadcast({ type: 'alert', alert }));

// Bot messages go to the overlay right away; posting to TikTok chat is
// rate-limited through a small queue so the account doesn't get flagged.
const outbox = [];
let sending = false;
bot.on('say', (say) => {
  recentSays.push(say);
  if (recentSays.length > 50) recentSays.shift();
  broadcast({ type: 'say', say });
  if (link.canSend()) {
    outbox.push(say.text);
    if (outbox.length > 10) outbox.shift();
    drainOutbox();
  }
});

async function drainOutbox() {
  if (sending) return;
  sending = true;
  const gap = (config.sendToTikTokChat?.minSecondsBetweenMessages ?? 4) * 1000;
  while (outbox.length) {
    const text = outbox.shift();
    try {
      await link.sendMessage(text.slice(0, 150));
    } catch (err) {
      log(`could not post to TikTok chat: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, gap));
  }
  sending = false;
}

link.on('event', (ev) => bot.handle(ev));

bot.on('aiQuestion', async (q) => {
  const reply = await ai.answer(q, bot.aiContext());
  if (reply) bot.say(reply, 'ai');
});
ai.on('warn', (msg) => log(msg));
ai.on('status', () => broadcast({ type: 'status', status: statusPayload() }));

function statusPayload(extra = {}) {
  return {
    status: link.status,
    detail: link.detail,
    username: link.username || config.tiktokUsername,
    ...extra,
    canSend: link.canSend(),
    demo: DEMO,
    ai: ai.status,
  };
}
link.on('status', (status) => {
  log(`status: ${status.status}${status.detail ? ` (${status.detail})` : ''}`);
  broadcast({ type: 'status', status: statusPayload(status) });
});
// A reconnect to the same room keeps the stats; a new stream starts fresh.
let lastRoomId = null;
link.on('connected', (state) => {
  if (state?.roomId !== lastRoomId) {
    bot.resetSession();
    ai.resetStream();
  }
  lastRoomId = state?.roomId;
});
link.on('warn', (msg) => log(`warning: ${msg}`));
link.on('streamEnd', () => {
  log('stream ended');
  saveSession();
});

setInterval(() => bot.tick(), 5000);

function saveSession() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const snap = bot.snapshot();
    const file = path.join(DATA, `session-${new Date(snap.startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ username: link.username, endedAt: new Date().toISOString(), ...snap }, null, 2));
    log(`session summary saved to ${path.relative(ROOT, file)}`);
  } catch (err) {
    log(`could not save session: ${err.message}`);
  }
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ---- dashboard actions ------------------------------------------------------

const actions = {
  connect: ({ username }) => {
    if (username) config.tiktokUsername = String(username).replace(/^@/, '').trim();
    return link.start(config.tiktokUsername);
  },
  disconnect: () => link.stop(),
  say: ({ text }) => bot.say(String(text || '').slice(0, 300), 'manual'),
  toggle: ({ key, value }) => {
    if (key in bot.settings) { bot.settings[key] = !!value; bot.changed(); }
  },
  mute: ({ username, minutes }) => bot.mute(username, Number(minutes) || config.moderation?.muteMinutes || 10),
  unmute: ({ username }) => bot.unmute(username),
  hide: ({ id }) => broadcast({ type: 'hide', id }),
  queueNext: () => bot.queueNext(),
  queueRemove: ({ username }) => bot.queueRemove(username),
  queueClear: () => bot.queueClear(),
  pollStart: ({ question, options, seconds }) => bot.startPoll(question, options || [], Number(seconds) || 60),
  pollEnd: () => bot.endPoll(),
  setGoal: ({ kind, target }) => bot.setGoal(kind, target),
  questionDone: ({ id }) => {
    bot.questions = bot.questions.filter((q) => q.id !== id);
    bot.changed();
  },
  resetSession: () => bot.resetSession(),
  saveSession: () => saveSession(),
  testAlert: ({ kind }) => {
    const user = { id: 'test', username: 'test_user', nickname: 'Test User', avatar: '' };
    const fakes = {
      follow: { type: 'follow', user },
      share: { type: 'share', user },
      gift: { type: 'gift', user, giftId: '0', giftName: 'Rose', diamonds: 1, count: 5, image: '', streaking: false },
      bigGift: { type: 'gift', user, giftId: '0', giftName: 'Galaxy', diamonds: 1000, count: 1, image: '', streaking: false },
    };
    if (fakes[kind]) bot.handle(fakes[kind]);
  },
};

// ---- HTTP server ------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname === '/' ? '/dashboard.html' : url.pathname;
  if (p === '/overlay') p = '/overlay.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  // A page from another site could open this socket from your browser, so
  // only same-origin pages get control.
  const origin = req.headers.origin;
  const sameOrigin = !origin || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
  const wantsOverlay = new URL(req.url, 'http://localhost').searchParams.get('role') === 'overlay';
  const role = wantsOverlay || !sameOrigin ? 'overlay' : 'dashboard';
  ws.role = role;
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({
    type: 'hello',
    role,
    state: bot.snapshot(),
    status: statusPayload(),
    feed: recentFeed.slice(-100),
    says: recentSays.slice(-20),
    overlay: config.overlay || {},
  }));
  // Only the dashboard may control the bot; overlays are read-only.
  if (role !== 'dashboard') return;
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const fn = actions[msg.action];
    if (!fn) return;
    try {
      await fn(msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });
});

const { host = '127.0.0.1', port = 3000 } = config.server || {};
server.listen(port, host, () => {
  const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  log(`TikTok LIVE bot running${DEMO ? ' in DEMO mode' : ''}`);
  log(`Dashboard: ${base}/`);
  log(`OBS overlay (Browser Source): ${base}/overlay`);
  if (DEMO || (config.tiktokUsername && config.tiktokUsername !== 'your_tiktok_username')) {
    actions.connect({ username: DEMO ? 'demo' : config.tiktokUsername });
  } else {
    log('Set "tiktokUsername" in config.json or enter it in the dashboard to connect.');
  }
});

process.on('SIGINT', async () => {
  log('shutting down…');
  if (link.status === 'connected') saveSession();
  await link.stop();
  process.exit(0);
});
