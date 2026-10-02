// Dashboard client: renders bot state and sends control actions.

const $ = (id) => document.getElementById(id);

// Tiny element builder; text always goes through textContent so chat
// messages can never inject HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
function duration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh ? `${hh}h ${mm}m` : `${mm}m ${String(s % 60).padStart(2, '0')}s`;
}

let ws;
let state = null;
let status = {};
let filter = 'all';
const feedItems = [];

function send(action, data = {}) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ action, ...data }));
  else toast('Not connected to the bot server');
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function connectSocket() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=dashboard`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'hello':
        state = msg.state;
        status = msg.status;
        feedItems.length = 0;
        feedItems.push(...msg.feed);
        $('says').replaceChildren();
        msg.says.forEach(addSay);
        renderAll();
        if (!$('username').value && status.username && status.username !== 'your_tiktok_username') $('username').value = status.username;
        break;
      case 'state': state = msg.state; renderState(); break;
      case 'status': status = msg.status; renderStatus(); break;
      case 'feed': addFeed(msg.item); break;
      case 'say': addSay(msg.say); break;
      case 'hide': {
        const it = feedItems.find((f) => f.id === msg.id);
        if (it) { it.hidden = true; it.reason = it.reason || 'hidden'; renderFeed(); }
        break;
      }
      case 'error': toast(msg.message); break;
      default: break;
    }
  };
  ws.onclose = () => {
    status = { status: 'error', detail: 'Lost connection to bot server — retrying…' };
    renderStatus();
    setTimeout(connectSocket, 2000);
  };
}

// ---- rendering --------------------------------------------------------------

function renderAll() {
  renderStatus();
  renderState();
  renderFeed();
}

function renderStatus() {
  const pill = $('status');
  pill.textContent = status.demo && status.status === 'connected' ? 'demo' : (status.status || 'offline');
  pill.className = `pill ${status.status || ''}`;
  $('status-detail').textContent = [status.username && `@${status.username}`, status.detail].filter(Boolean).join(' · ');
  const aiHint = $('ai-hint');
  if (aiHint) aiHint.textContent = status.ai === 'no-key'
    ? 'AI replies need an Anthropic API key — see README.'
    : 'AI answers !ask and questions ending in "?".';
  $('say-hint').textContent = status.canSend
    ? 'Bot messages are shown on the overlay and posted to your TikTok chat.'
    : 'Bot messages are shown on the overlay (and read aloud if TTS is on). Posting into TikTok chat is optional — see README.';
}

function renderState() {
  if (!state) return;
  const s = state.stats;
  const tiles = [
    ['Viewers', fmt(s.viewers)], ['Peak', fmt(s.peakViewers)], ['Likes', fmt(s.likes)], ['Diamonds', fmt(s.diamonds)],
    ['Follows', fmt(s.follows)], ['Shares', fmt(s.shares)], ['Chats', fmt(s.chats)], ['Uptime', duration(Date.now() - state.startedAt)],
  ];
  $('stats').replaceChildren(...tiles.map(([label, value]) =>
    h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value', id: label === 'Uptime' ? 'uptime' : null }, value))));

  // Sections are rebuilt only when their data changes, so buttons aren't
  // swapped out from under the mouse while chat is busy.
  section('goals', state.goals, renderGoals);
  section('toggles', state.settings, renderToggles);
  section('poll', state.poll, renderPoll);
  section('queue', state.queue, renderQueue);
  section('gifters', state.topGifters, renderGifters);
  section('questions', state.questions, renderQuestions);
  section('muted', state.muted, renderMuted);
}

const lastRendered = {};
function section(key, data, fn) {
  const json = JSON.stringify(data);
  if (lastRendered[key] === json) return;
  lastRendered[key] = json;
  fn();
}

function renderQueue() {
  $('queue-count').textContent = state.queue.length ? `(${state.queue.length})` : '';
  $('queue').replaceChildren(...state.queue.map((u) => h('li', {},
    h('div', { class: 'line' }, h('span', {}, u.nickname),
      h('button', { class: 'btn tiny', onclick: () => send('queueRemove', { username: u.username }) }, 'Remove')))));
}

function renderGifters() {
  $('gifters').replaceChildren(...state.topGifters.map((g) => h('li', {},
    h('div', { class: 'line' }, h('span', {}, g.user.nickname), h('span', { class: 'muted' }, `${fmt(g.diamonds)} 💎`)))));
}

function renderQuestions() {
  $('questions').replaceChildren(...state.questions.map((q) => h('li', {},
    h('div', { class: 'line' }, h('span', {}, h('b', {}, q.user.nickname), ': ', q.text),
      h('button', { class: 'btn tiny', onclick: () => send('questionDone', { id: q.id }) }, 'Done')))));
}

function renderMuted() {
  $('muted').replaceChildren(...state.muted.map((m) => h('li', {},
    h('div', { class: 'line' }, h('span', {}, m.username, ' ', h('span', { class: 'muted small' }, `until ${new Date(m.until).toLocaleTimeString()}`)),
      h('button', { class: 'btn tiny', onclick: () => send('unmute', { username: m.username }) }, 'Unmute')))));
}

function renderGoals() {
  const box = $('goals');
  if (box.contains(document.activeElement)) { delete lastRendered.goals; return; } // don't clobber an input being edited
  box.replaceChildren(...Object.entries(state.goals).map(([kind, g]) => {
    const pct = g.target ? Math.min(100, (g.current / g.target) * 100) : 0;
    const input = h('input', { type: 'number', min: '0', value: g.target, 'aria-label': `${kind} goal` });
    input.addEventListener('change', () => send('setGoal', { kind, target: Number(input.value) }));
    return h('div', { class: 'goal' },
      h('div', { class: 'row' },
        h('span', {}, kind[0].toUpperCase() + kind.slice(1), ' ', h('span', { class: 'muted' }, `${fmt(g.current)} / ${fmt(g.target)}`)),
        input),
      h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })));
  }));
}

const TOGGLES = {
  autoThanks: 'Thank gifts, follows & shares',
  welcome: 'Welcome new chatters',
  commands: 'Chat commands (!commands, !join…)',
  moderation: 'Auto-moderation',
  timers: 'Timed announcements',
  ai: 'AI replies to questions',
};
function renderToggles() {
  $('toggles').replaceChildren(...Object.entries(TOGGLES).map(([key, label]) => {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!state.settings[key];
    input.addEventListener('change', () => send('toggle', { key, value: input.checked }));
    return h('label', { class: 'toggle' }, h('span', {}, label), h('span', { class: 'switch' }, input, h('span')));
  }));
}

const pollLeft = () => `${Math.max(0, Math.round((state.poll.endsAt - Date.now()) / 1000))}s left`;

function renderPoll() {
  const p = state.poll;
  $('poll-form').hidden = !!p;
  if (!p) { $('poll-view').replaceChildren(); return; }
  $('poll-view').replaceChildren(
    h('p', {}, h('b', {}, p.question), ' ', h('span', { class: 'muted small' }, `${p.total} votes · `, h('span', { id: 'poll-left' }, pollLeft()))),
    ...p.options.map((o, i) => {
      const pct = p.total ? (o.votes / p.total) * 100 : 0;
      return h('div', { class: 'poll-opt' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, `${i + 1}. ${o.option}`), h('span', { class: 'muted' }, `${o.votes}`)),
        h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })));
    }),
    h('button', { class: 'btn', onclick: () => send('pollEnd') }, 'End poll now'));
}

const ICONS = { chat: '💬', gift: '🎁', follow: '➕', share: '↗', question: '❓' };
function feedRow(it) {
  const tools = it.kind === 'chat' ? h('span', { class: 'tools' },
    !it.hidden && h('button', { class: 'btn tiny', title: 'Hide from overlay', onclick: () => send('hide', { id: it.id }) }, 'Hide'),
    h('button', { class: 'btn tiny', title: 'Ignore this user for 10 minutes', onclick: () => send('mute', { username: it.user.username }) }, 'Mute')) : null;
  return h('li', { class: `${it.kind}${it.hidden ? ' hidden' : ''}` },
    h('span', { class: 'icon' }, ICONS[it.kind] || '•'),
    h('span', { class: 'who', title: `@${it.user.username}` }, it.user.nickname),
    h('span', { class: 'msg' }, it.text),
    it.hidden && h('span', { class: 'flag' }, it.reason || 'hidden'),
    tools);
}

function visible(it) {
  if (filter === 'all') return true;
  if (filter === 'flagged') return it.hidden;
  if (filter === 'social') return it.kind === 'follow' || it.kind === 'share';
  return it.kind === filter;
}

function renderFeed() {
  const list = $('feed');
  list.replaceChildren(...feedItems.filter(visible).slice(-150).map(feedRow));
  list.scrollTop = list.scrollHeight;
}

function addFeed(item) {
  feedItems.push(item);
  if (feedItems.length > 300) feedItems.shift();
  if (!visible(item)) return;
  const list = $('feed');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(feedRow(item));
  while (list.children.length > 150) list.firstChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function addSay(say) {
  const list = $('says');
  list.prepend(h('li', {}, `${new Date(say.ts).toLocaleTimeString()} · ${say.text}`));
  while (list.children.length > 30) list.lastChild.remove();
}

// ---- controls ---------------------------------------------------------------

$('connect-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send('connect', { username: $('username').value.trim() });
});
$('disconnect-btn').addEventListener('click', () => send('disconnect'));

$('say-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('say-text').value.trim();
  if (!text) return;
  send('say', { text });
  $('say-text').value = '';
});

$('feed-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  filter = btn.dataset.filter;
  [...$('feed-tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
  renderFeed();
});

$('poll-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const options = $('poll-opts').value.split(',').map((s) => s.trim()).filter(Boolean);
  send('pollStart', { question: $('poll-q').value.trim(), options, seconds: Number($('poll-secs').value) });
});

document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => send('testAlert', { kind: b.dataset.test })));
$('queue-next').addEventListener('click', () => send('queueNext'));
$('queue-clear').addEventListener('click', () => confirm('Clear the whole queue?') && send('queueClear'));
$('save-session').addEventListener('click', () => { send('saveSession'); toast('Session summary saved to the data/ folder'); });
$('reset-session').addEventListener('click', () => confirm('Reset all stats, leaderboards and the queue?') && send('resetSession'));

const overlayUrl = `${location.origin}/overlay`;
$('overlay-link').href = overlayUrl;
$('overlay-link').textContent = overlayUrl;
$('copy-overlay').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(overlayUrl); toast('Overlay URL copied'); } catch { toast(overlayUrl); }
});

// Keep uptime and poll countdown moving between state pushes.
setInterval(() => {
  if (!state) return;
  $('uptime').textContent = duration(Date.now() - state.startedAt);
  if (state.poll && $('poll-left')) $('poll-left').textContent = pollLeft();
}, 1000);

connectSocket();
