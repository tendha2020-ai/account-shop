// app.js
// antics: paste a link (or upload a clip), tap Make it, and your own free Hugging Face worker
// turns the animal into a human-acting TikTok video in the background.

const HF = 'https://huggingface.co';
const SPACE_NAME = 'antics-worker';
const DATASET_NAME = 'antics-videos';
const WORKER_FILES = ['Dockerfile', 'README.md', 'requirements.txt', 'worker.py', 'ideas.py', 'beats.py', 'meme.py', 'sfx.py',
  'voice.py', 'webpush.py', 'chorus.py', 'posting.py', 'gpu.py',
  'together.py', 'library.json']; // Together (v13): several animals in one video, and the free clips
const WORKER_VERSION = '13'; // bump with VERSION in worker/worker.py
const KEYS = {
  worker: 'antics.worker', clips: 'antics.clips', captions: 'antics.captions', style: 'antics.style', music: 'antics.music',
  track: 'antics.track', part: 'antics.part', seconds: 'antics.seconds', speed: 'antics.speed', animal: 'antics.animal',
  idea: 'antics.idea', brand: 'antics.brand', count: 'antics.count', preview: 'antics.preview', ownerBackup: 'antics.owner',
  extras: 'antics.extras', pingAsked: 'antics.pingAsked', songId: 'antics.songId', planAsked: 'antics.planAsked',
};
// The creator's name and picture, shown in the header and stamped on every video.
const BRAND = { name: 'TENDHA2', avatar: 'brand/tendha2.png' };
// Keys match TEMPLATES in worker/ideas.py.
const STYLES = [
  { key: 'random', label: 'Random' },
  { key: 'dance', label: 'Dance' },
  { key: 'walk', label: 'Walk like a human' },
  { key: 'fight', label: 'Fight' },
  { key: 'fail', label: 'Fail' },
  { key: 'sassy', label: 'Sassy' },
  { key: 'star', label: 'Star moment' },
  { key: 'twerk', label: 'Twerk' },
  { key: 'honest', label: 'Moment of honesty' },
];
const MUSIC = [
  { key: 'funny', label: 'Auto meme song' },
  { key: 'track', label: 'Choose a song' },
  { key: 'upload', label: 'Upload a song' },
  { key: 'mine', label: "Video's own sound" },
  { key: 'none', label: 'No music' },
];
const MUSIC_HINT = {
  funny: 'A meme song that fits the style.',
  track: 'Tap ▶ to listen, tap a name to pick it.',
  none: 'Add a trending TikTok sound when you post. Good for reach.',
};
// Extras the worker makes on its free CPU. Each shows once the worker lists it in /health "features".
const EXTRAS = [
  { key: 'voice', id: 'voiceOpt', line: 'voiceLine', label: 'Pet voice' },
  { key: 'meme', id: 'memeOpt', line: 'memeLine', label: 'Meme effects' },
  { key: 'opening', id: 'openingOpt', line: 'openingLine', label: 'Real start' },
  { key: 'outro', id: 'outroOpt', line: 'outroLine', label: 'Follow me' },
];
// Pet voices the worker knows; 'auto' picks one that suits the animal. Each other one has a short
// sample in voices/ (tap ▶ to hear it).
const VOICES = ['off', 'auto', 'squeaky', 'deep', 'narrator'];
const VOICE_PICKS = VOICES.slice(1);
const VOICE_LABELS = { auto: 'Auto', squeaky: 'Squeaky', deep: 'Deep', narrator: 'Narrator' };
const voiceUrl = (v) => `voices/${v}.mp3`;
// voice: what the next video gets ('off' or a voice); voicePick: the voice the switch turns on.
const EXTRAS_DEFAULT = { voice: 'off', voicePick: 'auto', meme: true, opening: false, outro: true };
// Free meme classics by Kevin MacLeod (CC BY 4.0). Names match MUSIC in worker/ideas.py.
const SONGS = [
  'Monkeys Spinning Monkeys', 'Sneaky Snitch', 'Fluffing a Duck', 'Scheming Weasel faster', 'Pixel Peeker Polka - faster',
  'Investigations', 'Local Forecast - Elevator', 'Run Amok', 'Carefree', 'Wallpaper', 'Hitman', 'Spazzmatica Polka',
  'Hall of the Mountain King', 'Quirky Dog', 'Kool Kats', 'Life of Riley',
];
const songUrl = (name) => `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(name)}.mp3`;
const songLabel = (name) => name.replace(/ - faster$| faster$/, ' (fast)');

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  worker: null, // the owner's { space, url, key }, or a friend's { url, key, guest: true, name, host }
  clips: 3,
  captions: true,
  file: null,
  jobs: [],
  online: false,
  pending: null, // what to make once setup finishes
  playing: null,
  playingBlob: null,
  health: null, // the worker's /health: version and whether the user's PC is connected
  style: 'random',
  music: 'funny',
  track: SONGS[0],
  songFile: null,
  part: 'auto',
  seconds: 5,
  speed: 'normal',
  setupMode: 'setup', // or 'update': send the newest worker files to the Space (made again only if its own key broke)
  brand: true,
  songStart: 0, // seconds into the song, when Song part is "Pick myself"
  songDuration: 0,
  count: 1, // videos made per tap
  preview: true, // a quick preview first: only the first clip is animated until Finish
  me: null, // from the worker: { role: 'owner' }, or a friend's { name, host, uses_left, used, redos }
  guests: null, // the owner's friends
  friendUses: 5,
  watchAfter: null, // { id, rev }: open this video when its new version is ready
  surprise: false, // step 1 is "Surprise me": a painted scene, no video
  extras: { ...EXTRAS_DEFAULT },
  openVideo: null, // a video to open once the list is loaded (from a notification)
  songs: null, // My songs: the owner's saved songs (workers with 'songs'), once loaded
  songId: null, // the saved song new videos get, while music is 'mysong'
  musicPicked: false, // music was picked on this visit (else new videos get the song set for every video)
  plan: null, // the owner's posting plan (workers with 'plan'): the worker's GET /plan answer, once loaded
  planAt: 0, // when it was loaded
  openPost: null, // a plan item to open on the Post screen once the plan is loaded (from a reminder)
  openPlan: false, // open the posting plan in Settings once it is loaded (from "Your posting plan is empty")
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: settings just won't persist
  }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  // Over an open dialog the toast goes inside it: only there does it show on top (a dialog covers the page).
  const host = topDialog() || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function note(el, text, kind = '') {
  el.textContent = text;
  el.className = 'note' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

// host: where the stand-in box goes when the clipboard can't be reached (inside an open dialog: only that one works)
async function copyText(text, done = 'Copied', host = document.body) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    host.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(done);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dialogsUp = []; // dialogs in the order they were opened (the newest is on top)
const topDialog = () => dialogsUp.filter((d) => d.open).pop() || null;

function openDialog(dlg) {
  if (dlg.showModal) dlg.showModal();
  else dlg.setAttribute('open', '');
  if (dialogsUp.includes(dlg)) dialogsUp.splice(dialogsUp.indexOf(dlg), 1);
  dialogsUp.push(dlg);
}

function closeDialog(dlg) {
  if (dlg.close) dlg.close();
  else dlg.removeAttribute('open');
}

// A dialog's "close" event comes a moment after it closed. If it was opened again in between (Save,
// then straight back into Edit), that event belongs to the time before and must not undo the new one.
function onClosed(dlg, fn) {
  dlg.addEventListener('close', () => {
    if (!dlg.open) fn();
  });
}

// ---------- Talking to the worker ----------

async function api(path, opts = {}) {
  const w = state.worker;
  const res = await fetch(w.url + path, { ...opts, headers: { 'X-Antics-Key': w.key, ...(opts.headers || {}) } });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    // A sleeping or rebuilding Space answers with an HTML page instead of the API.
    throw Object.assign(new Error('Your worker is waking up'), { waking: true });
  }
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.detail || `Worker error ${res.status}`), { status: res.status });
  return body;
}

function mediaUrl(job, what) {
  // Each new version of a video (after an edit) gets its own address, so an old one never shows from cache.
  const v = what === 'video' ? job.rev ?? job.status : `${job.rev ?? 0}-${job.has_thumb ? 1 : 0}`;
  return `${state.worker.url}/jobs/${job.id}/${what}?key=${encodeURIComponent(state.worker.key)}&v=${v}`;
}

// ---------- Friends: invite links ----------

const isGuest = () => Boolean(state.worker && state.worker.guest);
const hostName = () => (state.me && state.me.host) || (state.worker && state.worker.host) || BRAND.name;

function toB64url(text) {
  return base64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// The link a friend opens: this page plus #join=<the worker's address, their own key and name>.
function inviteLink(guest) {
  const data = { w: state.worker.url, k: guest.key, n: guest.name, h: BRAND.name };
  return `${location.origin}${location.pathname}#join=${toB64url(JSON.stringify(data))}`;
}

// The owner's own link, for the Home Screen app or another device: this page plus #app=<the worker's
// address, the owner key and the Space's name>. It opens the owner's antics, so it stays private.
function appLink() {
  const w = state.worker;
  return `${location.origin}${location.pathname}#app=${toB64url(JSON.stringify({ w: w.url, k: w.key, s: w.space }))}`;
}

// A friend's own invite link again, for the Home Screen app or another phone.
function myInviteLink() {
  const w = state.worker;
  const data = { w: w.url, k: w.key, n: (state.me && state.me.name) || w.name || '', h: hostName() };
  return `${location.origin}${location.pathname}#join=${toB64url(JSON.stringify(data))}`;
}

// What an antics link holds: { kind: 'join' | 'app', worker }, with worker null when the link is broken.
// null when the text has no antics link in it at all. The link can sit inside other text.
function parseLink(text) {
  const m = String(text || '').match(/#(join|app)=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const kind = m[1];
  let data = null;
  try {
    data = JSON.parse(fromB64url(m[2]));
  } catch {
    // broken link
  }
  const url = data && /^https:\/\/[a-z0-9-]+\.hf\.space$/.test(data.w || '') ? data.w : null;
  if (kind === 'join') {
    const ok = url && /^[a-f0-9]{16,64}$/.test(data.k || '');
    return { kind, worker: ok ? { url, key: data.k, guest: true, name: data.n || '', host: data.h || '' } : null };
  }
  const ok = url && /^[\w-]{6,200}$/.test(data.k || '') && /^[\w.-]+\/[\w.-]+$/.test(data.s || '');
  return { kind, worker: ok ? { space: data.s, url, key: data.k } : null };
}

// Puts a link's worker on this device. Returns true when it changed the worker.
function useLink({ kind, worker }, ask) {
  const now = state.worker;
  if (now && now.url === worker.url && now.key === worker.key) return false; // already this one
  if (kind === 'join' && now && !now.guest) {
    const ok = !ask || confirm(`This is ${worker.name || 'a friend'}'s invite. Open it on this device? Your own worker stays saved: Settings, Leave this invite brings it back.`);
    if (!ok) return false;
    save(KEYS.ownerBackup, now);
  }
  if (kind === 'app') {
    if (now && ask && !confirm('Open this antics link on this device? It takes the place of the one connected here now.')) return false;
    save(KEYS.ownerBackup, null);
  }
  state.worker = worker;
  save(KEYS.worker, worker);
  return true;
}

// A link opened on this device: a friend's invite (#join=...) or the owner's app link (#app=...).
// Returns true when it changed the worker.
function readInvite() {
  const m = location.hash.match(/^#(join|app)=([A-Za-z0-9_-]+)$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const link = parseLink(m[0]);
  if (!link.worker) {
    setTimeout(() => toast(link.kind === 'join' ? 'That invite link is broken. Ask for a new one.' : 'That app link is broken. Copy it again.'), 300);
    return false;
  }
  return useLink(link, true);
}

// A link put another worker on this device: start fresh with it.
function workerChanged() {
  state.jobs = [];
  state.me = null;
  state.health = null;
  state.guests = null;
  state.songs = null;
  resetPlan();
  resetPings();
  renderJobs();
  renderRole();
  renderOptions();
  renderGpu();
  renderWorkerDot(false);
  renderConnect();
  if ($('#settings').open) renderSettings();
  if (state.worker) refreshJobs();
}

// The Home Screen app keeps its own storage, so on an iPhone it starts with no worker. Then one box takes
// the owner's app link or a friend's invite link: no codes, no setup again.
function renderConnect() {
  const show = standalone() && !state.worker;
  $('#connectBox').hidden = !show;
  if (!show) note($('#connectNote'), '');
}

// quiet: typing or pasting into the box connects as soon as a whole link is in; only Connect explains.
function connectWith(text, quiet = false) {
  const link = parseLink(text);
  if (!link || !link.worker) {
    if (!quiet) {
      note($('#connectNote'), link ? 'That link is broken. Copy it again.'
        : "That isn't an antics link. In your browser: open antics, tap ⚙, then Copy app link.", 'bad');
    }
    return;
  }
  if (!useLink(link, Boolean(state.worker))) return;
  $('#connectLink').value = '';
  workerChanged();
  toast(link.kind === 'join' ? `Connected. You're using ${link.worker.host || BRAND.name}'s antics.` : 'Connected. Your videos are here.');
}

// The Home Screen app, no worker yet, Make it: the link comes first.
function askForLink() {
  const box = $('#connectBox');
  note($('#connectNote'), 'First connect this app: paste your antics link here.', 'bad');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.classList.remove('nudge');
  void box.offsetWidth; // restart the shake
  box.classList.add('nudge');
}

function leaveInvite() {
  if (!confirm('Leave this invite? Your videos stay. Open the invite link again to come back.')) return;
  if (pings.on) turnOffPings(state.worker); // this phone stops getting that worker's notifications
  const backup = load(KEYS.ownerBackup, null);
  state.worker = backup;
  save(KEYS.worker, backup);
  save(KEYS.ownerBackup, null);
  state.jobs = [];
  state.me = null;
  state.songs = null;
  resetPlan();
  resetPings();
  renderConnect();
  closeDialog($('#settings'));
  renderJobs();
  renderRole();
  renderOptions();
  renderWorkerDot(false);
  if (state.worker) refreshJobs();
}

// The owner sees the full app; a friend sees how many videos they have left, and no setup.
function renderRole() {
  const guest = isGuest();
  let sub = 'animals doing human stuff';
  if (guest) {
    const me = state.me;
    const name = (me && me.name) || state.worker.name || 'friend';
    sub = me ? `Hi ${name} · ${me.uses_left} video${me.uses_left === 1 ? '' : 's'} left` : `Hi ${name}`;
  }
  $('#subLine').textContent = sub;
  $('#brandLine').hidden = guest;
  renderExtras();
}

// ---------- One-time setup: create the user's worker Space ----------

function step(name, status) {
  const li = $(`#steps [data-step="${name}"]`);
  if (li) li.className = status;
}

async function hf(path, token, opts = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(HF + path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    if (res.status !== 429) return res;
    await sleep(3000 * (attempt + 1));
  }
  throw new Error('Hugging Face is busy right now. Try again in a minute.');
}

async function hfError(res) {
  try {
    const body = await res.json();
    return body.error || `Hugging Face error ${res.status}`;
  } catch {
    return `Hugging Face error ${res.status}`;
  }
}

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setupWorker() {
  const updating = state.setupMode === 'update' && Boolean(state.worker);
  const token = $('#token').value.trim();
  const msg = $('#setupNote');
  if (!/^hf_[A-Za-z0-9]{20,}$/.test(token)) {
    note(msg, "That doesn't look like a Hugging Face key. It starts with hf_", 'bad');
    return;
  }
  // An update restarts the worker: a clip being made right now would be cut off and made again (its AI time used
  // twice), so the first tap asks to wait for it.
  if (updating && !state.updateAnyway && (state.jobs || []).some((j) => j.status === 'working' || j.status === 'queued')) {
    state.updateAnyway = true;
    note(msg, 'A video is being made right now. Update when it is done, or tap Update my worker again to update '
      + 'anyway (it starts that video again).', 'bad');
    return;
  }
  note(msg, '');
  $('#setupBtn').disabled = true;
  $('#steps').hidden = false;
  $('#steps').querySelectorAll('li').forEach((li) => { li.className = ''; });
  try {
    step('key', 'active');
    const whoRes = await hf('/api/whoami-v2', token);
    if (whoRes.status === 401) throw new Error('Hugging Face says this key is not valid. Copy it again.');
    if (!whoRes.ok) throw new Error(await hfError(whoRes));
    const who = await whoRes.json();
    if (who.auth && who.auth.accessToken && who.auth.accessToken.role === 'read') {
      throw new Error('This key can only read. Make a new one and pick Write (step 2).');
    }
    const user = who.name;
    const space = updating ? state.worker.space : `${user}/${SPACE_NAME}`;
    if (updating && space.split('/')[0].toLowerCase() !== user.toLowerCase()) {
      throw new Error(`This key belongs to ${user}, but your worker is ${space}. Use a key from that account.`);
    }
    step('key', 'done');

    step('create', 'active');
    // A web page can set a Space's secrets (its Hugging Face key, its connection key) only while it
    // creates the Space. So an update sends the new files to the worker that is already there: nothing
    // is deleted, and its keys, connections and videos stay. The worker is made again from scratch only
    // when its own Hugging Face key stopped working, or when the page doesn't know its connection key.
    // Videos live in the dataset and are kept either way.
    const existing = await hf(`/api/spaces/${space}`, token);
    const inPlace = existing.ok && updating && !keyBroken();
    const key = updating ? state.worker.key : randomKey();
    if (!inPlace) {
      if (existing.ok) {
        const del = await hf('/api/repos/delete', token, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'space', name: SPACE_NAME }),
        });
        if (!del.ok) throw new Error(await hfError(del));
        await sleep(2000);
      }
      const created = await hf('/api/repos/create', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'space',
          name: SPACE_NAME,
          private: false,
          sdk: 'docker',
          secrets: [
            { key: 'HF_TOKEN', value: token },
            { key: 'ANTICS_KEY', value: key },
            { key: 'ANTICS_DATASET', value: `${user}/${DATASET_NAME}` },
          ],
        }),
      });
      if (!created.ok) throw new Error(await hfError(created));
    }

    const summary = updating ? 'Update the Animal Antics worker' : 'Set up the Animal Antics worker';
    const lines = [{ key: 'header', value: { summary, description: '' } }];
    for (const name of WORKER_FILES) {
      const res = await fetch(`worker/${name}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Could not read worker/${name} (${res.status})`);
      lines.push({ key: 'file', value: { content: base64(await res.text()), path: name, encoding: 'base64' } });
    }
    const commit = await hf(`/api/spaces/${space}/commit/main`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: lines.map((l) => JSON.stringify(l)).join('\n'),
    });
    if (!commit.ok) throw new Error(await hfError(commit));
    step('create', 'done');

    step('build', 'active');
    $('#token').value = '';
    // After an update in place the old worker keeps answering until the new one is built.
    const url = await waitForBuild(space, inPlace ? { version: WORKER_VERSION, token } : {});
    const changed = !state.worker || state.worker.url !== url || state.worker.key !== key;
    state.worker = { space, url, key };
    save(KEYS.worker, state.worker);
    if (changed) resetPings(); // a new worker: its own notifications
    renderConnect();
    await waitForHealth();
    refreshHealth();
    step('build', 'done');
    step('ready', 'done');
    state.setupMode = 'setup';
    renderWorkerDot(true);
    note(msg, updating ? 'Updated. All the new options work now.' : 'All set. You can make videos now.', 'good');
    toast(updating ? 'Worker updated' : 'Worker ready');
    refreshJobs();
    if (updating) setTimeout(() => closeDialog($('#settings')), 1500);
    if (state.pending) {
      const pending = state.pending;
      state.pending = null;
      setTimeout(() => closeDialog($('#settings')), 900);
      submit(pending);
    }
  } catch (e) {
    $('#steps').querySelectorAll('li.active').forEach((li) => { li.className = ''; });
    note(msg, e.message, 'bad');
  } finally {
    $('#setupBtn').disabled = false;
  }
}

// The worker's own Hugging Face key stopped working (it says so in /health).
const keyBroken = () => Boolean(state.worker && state.health && state.health.token_ok === false);

// The worker's /health answer, or null while it is asleep, building or starting.
async function healthOf(url) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 10000);
  try {
    const res = await fetch(`${url}/health`, { cache: 'no-store', signal: stop.signal });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Polls the Space until Docker has built it. Returns its web address. With a version (an update in
// place), it also waits until the worker itself answers with that version.
async function waitForBuild(space, { version = null, token = null } = {}) {
  const started = Date.now();
  let errors = 0;
  let building = false;
  let kicked = false;
  while (Date.now() - started < 15 * 60 * 1000) {
    await sleep(6000);
    let rt;
    try {
      const res = await fetch(`${HF}/api/spaces/${space}/runtime`);
      if (!res.ok) continue;
      rt = await res.json();
    } catch {
      continue;
    }
    const stage = rt.stage || '';
    if (stage !== 'RUNNING') building = true;
    const mins = Math.floor((Date.now() - started) / 60000);
    $('#steps [data-step="build"]').textContent = version
      ? `Building the new version (${mins} min so far, 2–5 min)`
      : `Building it (${mins} min so far, 2–5 min, only once)`;
    // Right after a rebuild the old stage can linger, so only a repeated error after a short wait counts.
    errors = /ERROR/.test(stage) && Date.now() - started > 45000 ? errors + 1 : 0;
    if (errors >= 2) {
      throw new Error(`The worker failed to build (${stage}). Open huggingface.co/spaces/${space} to see why, then tap ${version ? 'Update' : 'Set up'} again.`);
    }
    if (stage === 'RUNNING') {
      const domain = (rt.domains || []).find((d) => d.stage === 'READY') || (rt.domains || [])[0];
      const url = domain ? `https://${domain.domain}` : `https://${space.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.hf.space`;
      if (!version) return url;
      const health = await healthOf(url);
      if (health && health.version === version) return url;
      // Still the old worker. Hugging Face starts the new build by itself a few seconds after the files
      // arrive; if it hasn't after 3 minutes, ask it to (once).
      if (!building && !kicked && token && Date.now() - started > 3 * 60 * 1000) {
        kicked = true;
        await hf(`/api/spaces/${space}/restart?factory=true`, token, { method: 'POST' }).catch(() => {});
      }
    }
  }
  throw new Error(`The worker is taking too long to build. Try ${version ? 'Update' : 'Set up'} again later.`);
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${state.worker.url}/health`);
      if (res.ok && (res.headers.get('content-type') || '').includes('json')) return;
    } catch {
      // still starting
    }
    await sleep(4000);
  }
}

// ---------- Making videos ----------

function renderWorkerDot(on) {
  state.online = on;
  $('#workerDot').classList.toggle('on', Boolean(on));
}

// Step 1: a link, a file, or a surprise. A chosen file or the surprise shows as a chip with ✕.
function renderSource() {
  const chip = Boolean(state.file || state.surprise);
  $('#fileChip').hidden = !chip;
  $('#linkField').hidden = chip;
  $('#fileName').textContent = state.file ? state.file.name || 'Your video'
    : state.surprise ? 'Surprise: no video needed' : '';
  $('#step1').classList.toggle('done', chip || /^https?:\/\/\S+$/i.test($('#link').value.trim()));
}

function setFile(file) {
  state.file = file;
  if (file) state.surprise = false;
  if (!file) $('#file').value = '';
  renderSource();
  renderExtras(); // a photo can't have the Real → AI opening
}

// Surprise me picks the surprise; ✕ (on = false) clears a surprise or a chosen file.
function setSurprise(on) {
  state.surprise = on;
  state.file = null;
  $('#file').value = '';
  renderSource();
  renderOptions();
}

async function onMake(e) {
  e.preventDefault();
  if (window.Together && Together.on()) { // Together: several animals (together.js checks them, then calls submit)
    Together.make();
    return;
  }
  if (state.surprise) {
    submit({ kind: 'surprise' });
    return;
  }
  if (state.file) {
    submit({ kind: 'file', file: state.file });
    return;
  }
  const link = $('#link').value.trim();
  if (!/^https?:\/\/\S+$/i.test(link)) {
    note($('#note'), 'Step 1 first: paste a link, upload a video, or tap Surprise me.', 'bad');
    const step1 = $('#step1');
    step1.scrollIntoView({ behavior: 'smooth', block: 'center' });
    step1.classList.remove('nudge');
    void step1.offsetWidth; // restart the shake
    step1.classList.add('nudge');
    return;
  }
  submit({ kind: 'link', url: link });
}

let sending = false; // a video is on its way: the Make button stays busy (a job-list refresh must not free it)

async function submit(what) {
  unlockSound(); // still inside the tap: the "ready" chime can play later
  if (sending) return;
  const msg = $('#note');
  const music = musicNow();
  if (music === 'upload' && !state.songFile) {
    note(msg, 'Choose your song file first (Music, Upload a song), or pick other music.', 'bad');
    return;
  }
  if (!state.worker && standalone()) {
    askForLink();
    return;
  }
  if (!state.worker) {
    state.pending = what;
    openSettings();
    return;
  }
  note(msg, '');
  const btn = $('#makeBtn');
  sending = true;
  btn.disabled = true;
  btn.textContent = what.kind === 'file' ? 'Picking the best moments…' : 'Sending…';
  const count = makeCount();
  const draft = isDraft();
  try {
    const form = new FormData();
    form.append('count', String(count));
    form.append('draft', String(draft));
    form.append('clips', String(state.clips));
    form.append('captions', String(state.captions));
    if (what.kind !== 'together') form.append('template', state.style); // Together: the scene is the style
    // A surprise scene has no sound of its own, so it gets a meme song instead.
    form.append('music', what.kind === 'surprise' && music === 'mine' ? 'funny' : music);
    if (music === 'mysong') form.append('song_id', state.songId); // (from its meme part, whatever the length)
    form.append('track', state.track);
    const canPick = ['track', 'upload'].includes(music);
    form.append('song_part', state.part === 'custom' && !canPick ? 'auto' : state.part);
    form.append('song_start', state.songStart.toFixed(1));
    form.append('seconds', String(state.seconds));
    form.append('speed', state.speed);
    form.append('idea', $('#idea').value.trim());
    if (what.kind !== 'together') form.append('animal', $('#animalOpt').value.trim()); // Together: each has its own
    if (music === 'upload') form.append('song', state.songFile);
    for (const x of EXTRAS) if (canDo(x.key)) form.append(x.key, extraValue(x.key));
    const missing = []; // never let the name tag or the Follow me card stop a video
    if (state.brand && !isGuest()) {
      try {
        form.append('badge', await brandBadge(), 'badge.png');
      } catch {
        missing.push('your name tag');
      }
    }
    // The owner's Follow me card goes with every video, so the ending can also be switched on later in Edit.
    if (canDo('outro') && !isGuest()) {
      try {
        form.append('endcard', await brandEndCard(), 'endcard.png');
      } catch {
        if (extraOn('outro')) missing.push('the Follow me ending');
      }
    }
    if (what.kind === 'together') await Together.addCast(form, btn); // Together: mode, scene, look, cast, cast_files
    if (what.kind === 'link') form.append('url', what.url);
    if (what.kind === 'surprise') form.append('surprise', 'true');
    if (what.kind === 'file') {
      // A one-shot worker starts each video from ONE picture (video k: the sharpest moment in part k of
      // the clip) and carries it on from there; an older worker starts every clip from its own picture.
      // With the Real → AI opening, the real seconds before each picture go along as frames.
      const { pictures, openings } = canDo('chain')
        ? await picturesFromFile(what.file, count, 1, {
          perVideo: true,
          opening: extraOn('opening'),
          onOpening: (k, n) => { btn.textContent = n > 1 ? `Getting the real start ${k + 1} of ${n}…` : 'Getting the real start…'; },
        })
        : await picturesFromFile(what.file, state.clips, count);
      pictures.forEach((blob, i) => form.append('images', blob, `picture_${i}.jpg`));
      // All openings play at one frame rate: the smoothest one's. (A busy phone can miss every other frame
      // of one opening; then that one is left out, not the smooth ones.)
      const fps = Math.max(0, ...openings.map((o) => (o ? o.fps : 0)));
      openings.forEach((o, k) => {
        if (!o || Math.abs(o.fps - fps) > fps * 0.1) return;
        o.frames.forEach((f, i) => form.append('hooks', f, `v${k}_${String(i).padStart(3, '0')}.jpg`));
      });
      if (fps) form.append('hook_fps', fps.toFixed(3));
      if (music === 'mine' && isVideoFile(what.file)) {
        if (what.file.size < 150 * 1024 * 1024) form.append('source', what.file);
        else toast('That video is too big to keep its sound, so it gets funny music.');
      }
      btn.textContent = 'Sending…';
    }
    const res = await sendJob(form);
    const made = res.jobs || [res]; // a worker older than v7 makes one video and answers with it
    if (res.me) state.me = res.me;
    const ids = new Set(made.map((j) => j.id));
    state.jobs = [...made, ...state.jobs.filter((j) => !ids.has(j.id))];
    renderJobs();
    renderRole();
    renderPings(); // offers notifications while it's being made
    $('#link').value = '';
    state.surprise = false;
    setFile(null);
    renderOptions();
    if (what.kind === 'together') Together.sent(); // Together: the animals stay for the next scene
    const kind = draft && made[0].draft ? 'preview' : 'video';
    const got = made.length > 1 ? `${made.length} ${kind}s on the way` : `Your ${kind} is on the way`;
    toast(`${got}${missing.length ? ` (without ${missing.join(' and ')} this time)` : ''}. You can close the app, it keeps working.`);
    // On a phone the list is below the form: show the new card.
    if (!matchMedia('(min-width: 960px)').matches) {
      const card = $('#jobs .job');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    schedulePoll(2000);
  } catch (e) {
    note(msg, e.waking ? 'Your worker is waking up (takes up to a minute). Tap Make it again in a moment.' : e.message, 'bad');
    if (e.waking) wakeWorker();
  } finally {
    sending = false;
    renderMake();
  }
}

// How many videos one tap makes: the Export choice, but never more than a friend has left.
function makeCount() {
  const left = isGuest() && state.me ? state.me.uses_left : Infinity;
  return Math.max(1, Math.min(state.count, left));
}

// A 5 s video is one clip, so its "preview" would already be the whole video: no preview then.
// (Together: One by one and the free looks are made in full.)
const isDraft = () => state.preview && state.clips > 1 && !(window.Together && Together.noPreview());

// Step 4 (length, how many, quick preview) and the Make button.
function renderMake() {
  const left = isGuest() && state.me ? state.me.uses_left : Infinity;
  document.querySelectorAll('#countSeg button').forEach((b) => {
    b.disabled = Number(b.dataset.v) > Math.max(1, left);
  });
  const n = makeCount();
  setSeg('countSeg', n);
  const draft = isDraft();
  $('#previewOpt').checked = draft;
  $('#previewOpt').disabled = state.clips === 1;
  $('#previewSub').textContent = state.clips === 1 ? 'Not needed for 5 s'
    : oneShot() ? `See the first 5 s fast. Finish adds the other ${(state.clips - 1) * 5} s.`
      : 'Only clip 1 moves. Finish the rest later.';
  const ai = n * (draft ? 1 : state.clips);
  const each = clipTime() + (ai === 1 ? '' : ' each') + (state.health && state.health.pc ? ' on your PC' : '');
  let help = `Uses ${ai} AI clip${ai === 1 ? '' : 's'} (${each}).`;
  if (isGuest() && state.me) help += ` You have ${state.me.uses_left} video${state.me.uses_left === 1 ? '' : 's'} left.`;
  else help += ai > 4 ? ' Free time makes about 3–5 a day, so some finish later by themselves.' : ' Free time makes about 3–5 a day.';
  $('#exportHelp').textContent = nb(help);
  const btn = $('#makeBtn');
  const out = isGuest() && state.me && state.me.uses_left <= 0;
  if (!sending) { // while a video is being sent, the button says how that is going
    btn.disabled = Boolean(out);
    if (out) btn.textContent = 'No videos left';
    else if (draft) btn.textContent = n > 1 ? `Make ${n} previews` : 'Make a preview';
    else btn.textContent = n > 1 ? `Make ${n} videos` : 'Make it';
  }
  $('#surpriseBtn').disabled = Boolean(out);
  if (out) note($('#note'), `You've used all your videos. Ask ${hostName()} for more.`);
  else if ($('#note').textContent.startsWith("You've used all")) note($('#note'), '');
  if (window.Together) Together.renderMake(); // Together: the Look and its cost line
}

async function sendJob(form) {
  return api('/jobs', { method: 'POST', body: form });
}

// ---------- The @TENDHA2 badge stamped on videos ----------

let badgeBlob = null;

// A dark pill with the creator's picture and @name, drawn at the size it appears on a 720px-wide video.
async function brandBadge() {
  if (badgeBlob) return badgeBlob;
  const img = new Image();
  // The picture can come from another site (the preview link redirects it to GitHub's file server);
  // loading it in CORS mode keeps the canvas exportable.
  img.crossOrigin = 'anonymous';
  img.src = BRAND.avatar;
  await img.decode();
  const font = '800 28px "Bricolage Grotesque", system-ui, sans-serif';
  try {
    await document.fonts.load(font);
  } catch {
    // the system font is fine too
  }
  const text = `@${BRAND.name}`;
  const h = 64;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const w = Math.ceil(h + 8 + measure.measureText(text).width + 22);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const r = h / 2;
  ctx.fillStyle = 'rgba(22, 19, 16, 0.82)';
  ctx.beginPath();
  ctx.arc(r, r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(w - r, r, r, Math.PI * 1.5, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 5, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, 5, 5, h - 10, h - 10);
  ctx.restore();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#c9f04a';
  ctx.beginPath();
  ctx.arc(r, r, r - 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, h + 8, r + 1);
  badgeBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return badgeBlob;
}

// ---------- The "Follow me" ending card ----------

let endCardBlob = null;

// A see-through 720x1280 card: the creator's picture in a lime ring, @name and a red "Follow for more 🐾"
// button. The worker lays it over the video's last moment. Drawn here like the badge, so the emoji
// comes from the phone's own font.
async function brandEndCard() {
  if (endCardBlob) return endCardBlob;
  const img = new Image();
  img.crossOrigin = 'anonymous'; // keeps the canvas exportable (see brandBadge)
  img.src = BRAND.avatar;
  await img.decode();
  const fam = '"Bricolage Grotesque", system-ui, sans-serif';
  try {
    await document.fonts.load(`800 64px ${fam}`);
  } catch {
    // the system font is fine too
  }
  const W = 720;
  const H = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const cx = W / 2;
  const d = 240; // the picture
  const top = Math.round(H * 0.29);
  const cy = top + d / 2 + 8;
  // a soft shadow, the lime ring, the round picture
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#c9f04a';
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2 + 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, cx - d / 2, cy - d / 2, d, d);
  ctx.restore();
  // @name in white with a dark outline, readable on any video
  let y = top + d + 56;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `800 64px ${fam}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeText(`@${BRAND.name}`, cx, y);
  ctx.fillStyle = '#fff';
  ctx.fillText(`@${BRAND.name}`, cx, y);
  // the button: a pill drawn with arcs, like the badge (roundRect needs Safari 16)
  y += 96;
  const label = 'Follow for more 🐾';
  ctx.font = `800 40px ${fam}`;
  const bw = Math.ceil(ctx.measureText(label).width) + 80;
  const bh = 84;
  ctx.fillStyle = '#fe2c55';
  ctx.beginPath();
  ctx.arc(cx - bw / 2 + bh / 2, y + bh / 2, bh / 2, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(cx + bw / 2 - bh / 2, y + bh / 2, bh / 2, Math.PI * 1.5, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, y + bh / 2 + 2);
  endCardBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the card'))), 'image/png');
  });
  return endCardBlob;
}

// ---------- Pictures from an uploaded video (picked on the phone, so only a few small JPEGs are sent) ----------

function waitFor(el, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error('This video took too long to open')), ms);
    const ok = () => done(resolve);
    const bad = () => done(reject, new Error("This video can't be opened here. Try a photo or a screenshot."));
    function done(fn, arg) {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
      fn(arg);
    }
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

function drawScaled(source, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(w * scale));
  canvas.height = Math.max(2, Math.round(h * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Higher = sharper. Variance of a Laplacian on a small greyscale copy.
function sharpness(canvas) {
  const small = drawScaled(canvas, canvas.width, canvas.height, 160);
  const { data, width, height } = small.getContext('2d').getImageData(0, 0, small.width, small.height);
  const grey = new Float32Array(width * height);
  for (let i = 0; i < grey.length; i++) grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = grey[i - 1] + grey[i + 1] + grey[i - width] + grey[i + width] - 4 * grey[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  return sumSq / n - (sum / n) ** 2;
}

function toJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the picture'))), 'image/jpeg', 0.9);
  });
}

function isVideoFile(file) {
  return file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|3gp)$/i.test(file.name);
}

// The sharpest moment in each of `count` parts of the video, for each of `variants` videos
// ([video 1's, video 2's, ...]). One-shot workers: count = videos, one start picture each (opts.perVideo).
// Older workers: count = clips per video, variants = videos.
// opts.opening: every moment comes after some real video, and each video's opening is kept too.
// opts.onOpening(k, n): called before video k's opening is played (for the Make button).
// Returns { pictures, openings }; openings[k] is video k's opening ({ frames, fps }) or null.
async function picturesFromFile(file, count, variants = 1, opts = {}) {
  const isVideo = isVideoFile(file);
  const url = URL.createObjectURL(file);
  try {
    if (!isVideo) {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { pictures: [await toJpeg(drawScaled(img, img.naturalWidth, img.naturalHeight, 1024))], openings: [] };
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.src = url;
    await waitFor(video, 'loadeddata');
    try {
      // iPhones only hand out frames after playback has started once.
      await video.play();
      video.pause();
    } catch {
      // autoplay refused: seeking still works on most browsers
    }
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    // With the opening, the moments are picked after the first seconds (up to OPENING_LEAD, at most half
    // the clip), so each video has real footage to start with.
    const opening = Boolean(opts.opening && opts.perVideo && canGrabOpening());
    let lead = opening && dur >= 2 * OPENING_MIN ? Math.min(OPENING_LEAD, dur / 2) : 0;
    let span = dur - lead;
    if (opts.range && dur > 1) { // Together: a free clip's good part, [from, to] seconds
      lead = Math.max(0, Math.min(opts.range[0], dur - 0.5));
      span = Math.max(0.5, Math.min(opts.range[1], dur) - lead);
    }
    const samples = dur > 1 ? Math.min(24, Math.max(12, count * variants + 4)) : 1;
    const frames = [];
    for (let i = 0; i < samples; i++) {
      if (samples > 1) {
        video.currentTime = lead + span * (0.04 + (0.92 * i) / (samples - 1));
        await waitFor(video, 'seeked', 8000);
      }
      const canvas = drawScaled(video, video.videoWidth, video.videoHeight, 1024);
      frames.push({ t: video.currentTime, canvas, score: sharpness(canvas) });
    }
    // The sharpest moment in each part of the video, one per clip. Each extra video takes the
    // next-sharpest moments, so they all start differently.
    const picks = [];
    for (let v = 0; v < variants; v++) {
      for (let part = 0; part < count; part++) {
        const lo = lead + (span * part) / count;
        const hi = lead + (span * (part + 1)) / count;
        // parts don't overlap, so two videos never start from the same moment
        const inPart = frames.filter((f) => f.t >= lo && (f.t < hi || part === count - 1));
        const pool = (inPart.length ? inPart : frames).slice().sort((a, b) => b.score - a.score);
        picks.push(pool[v % pool.length]);
      }
    }
    // One-shot workers: picture k is video k's (one picture for all when the clip has just one moment).
    // Older workers: each moment once.
    const chosen = variants > 1 || (opts.perVideo && new Set(picks).size > 1) ? picks : [...new Set(picks)];
    const pictures = await Promise.all(chosen.map((f) => toJpeg(f.canvas)));
    const openings = [];
    if (opening) {
      const played = new Map(); // a moment two videos share is played once
      for (let k = 0; k < chosen.length; k++) {
        const f = chosen[k];
        if (!played.has(f)) {
          if (opts.onOpening && canGrabOpening()) opts.onOpening(k, chosen.length);
          played.set(f, await grabOpening(video, f.t));
        }
        const got = played.get(f);
        openings.push(got && { frames: got.frames, fps: got.fps });
        if (got) pictures[k] = got.picture; // the frame right after the opening's last one
      }
    }
    return { pictures, openings, times: chosen.map((f) => f.t) }; // Together: each picture's moment (s)
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- The "Real → AI" opening for uploads ----------

const OPENING_LEAD = 2; // seconds of real video sent before each start picture (the worker uses up to this)
const OPENING_MIN = 1; // less real video than this before the picture: no opening
let openingOff = false; // playing for the opening failed on this phone: later uploads don't wait for it
const canGrabOpening = () => !openingOff && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// Plays the real video's last OPENING_LEAD seconds before moment X once, at half speed (so a slow phone
// keeps every frame), and keeps the frames. The frame on screen at X becomes the start picture, so the
// real video's last frame and the AI's first frame are neighbours. Needs requestVideoFrameCallback
// (Chrome 83, Safari 15.4, Firefox 132). Without it, or on any trouble, returns null: no opening, the
// video is still made.
async function grabOpening(video, X) {
  if (!canGrabOpening() || X < OPENING_MIN) return null;
  const from = Math.max(0, X - OPENING_LEAD);
  const kept = []; // the opening's frames, at most 30 a second: { t, blob }
  const encoding = [];
  // Two canvases, drawn again for every frame (phones limit how much canvas memory a page may hold):
  // `big` holds the newest frame at full size (the start picture once a later frame shows), `small` the
  // copy sent as an opening frame (toBlob takes its picture straight away).
  const big = drawScaled(video, video.videoWidth, video.videoHeight, 1024);
  const small = drawScaled(big, big.width, big.height, 720);
  let last = -1; // the newest frame's time
  let handle = 0;
  let finished = false;
  let onEnded = null;
  let away = document.hidden; // the page was off screen for a while (the phone was busy with another app)
  const onAway = () => { away = away || document.hidden; };
  document.addEventListener('visibilitychange', onAway);
  // On the page while it plays, tiny and see-through: iPhones may pause a muted video that isn't on screen.
  Object.assign(video.style, { position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(video);
  try {
    video.currentTime = Math.max(0, from - 0.25);
    await waitFor(video, 'seeked', 8000);
    await new Promise((resolve, reject) => {
      let seen = false;
      const stop = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        clearTimeout(firstFrame);
        if (err) reject(err);
        else resolve();
      };
      // At half speed the stretch plays in about twice its length. Frames that don't come (or stop coming)
      // while the page stays on screen mean this browser can't do it: later uploads skip the opening.
      const giveUp = (why) => {
        if (!away && !document.hidden) openingOff = true;
        stop(new Error(why));
      };
      const guard = setTimeout(() => giveUp('too slow'), (X - from + 0.25) * 2000 + 4000);
      const firstFrame = setTimeout(() => {
        if (!seen) giveUp('no frames');
      }, 3000);
      const onFrame = (now, meta) => {
        if (finished) return;
        seen = true;
        const t = meta.mediaTime;
        if (t > X + 0.0005) {
          stop();
          return;
        }
        if (t >= from - 0.02) {
          big.getContext('2d').drawImage(video, 0, 0, big.width, big.height);
          last = t;
          if (!kept.length || t - kept[kept.length - 1].t > 1 / 31) { // the video is made at 30 a second
            const item = { t, blob: null };
            kept.push(item);
            small.getContext('2d').drawImage(big, 0, 0, small.width, small.height);
            encoding.push(new Promise((ok) => small.toBlob(ok, 'image/jpeg', 0.7)).then((b) => { item.blob = b; }));
          }
        }
        handle = video.requestVideoFrameCallback(onFrame);
      };
      onEnded = () => stop();
      video.addEventListener('ended', onEnded);
      handle = video.requestVideoFrameCallback(onFrame);
      video.playbackRate = 0.5;
      video.play().catch((e) => {
        if (finished) return; // stopped on purpose
        if (!away && !document.hidden) openingOff = true;
        stop(e);
      });
    });
    await Promise.all(encoding);
  } catch {
    return null;
  } finally {
    finished = true;
    document.removeEventListener('visibilitychange', onAway);
    if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    if (onEnded) video.removeEventListener('ended', onEnded);
    video.pause();
    video.playbackRate = 1;
    video.remove();
  }
  if (last < 0) return null;
  if (kept.length && kept[kept.length - 1].t === last) kept.pop(); // that one is the picture
  if (kept.length < 2 || kept.some((k) => !k.blob)) return null;
  const gaps = kept.slice(1).map((k, i) => k.t - kept[i].t).sort((a, b) => a - b);
  const fps = Math.min(60, Math.max(10, 1 / gaps[Math.floor(gaps.length / 2)]));
  // Each frame lasts until the next one (the last until the picture). A frame or three a busy phone
  // skipped are filled with the one before, so the opening keeps its real timing; after a longer stall
  // only the smooth part right before the picture is kept.
  const frames = [];
  kept.forEach((k, i) => {
    const slots = Math.max(1, Math.round(((i + 1 < kept.length ? kept[i + 1].t : last) - k.t) * fps));
    if (slots > 4) frames.length = 0;
    else for (let j = 0; j < slots; j++) frames.push(k.blob);
  });
  if (frames.length < 0.8 * fps) return null; // under 0.8 s: too short for an opening
  return { frames, picture: await toJpeg(big), fps };
}

// ---------- Job list ----------

function describe(job) {
  if (job.status === 'queued') return job.stage || 'In line…';
  if (job.status === 'working') return job.stage || 'Working…';
  if (job.status === 'waiting') {
    const at = job.retry_at ? new Date(job.retry_at * 1000) : null;
    const when = at ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later';
    // Waiting for the worker's GPU guard (v12.1): out of today's free AI time, or stopped until the owner's Resume.
    if (job.gpu_wait === 'quota') return `Out of free AI time today. It continues by itself ${at ? `at ${when}` : 'later'}.`;
    if (job.gpu_wait === 'unreadable') return `Waiting to check the free AI time. It tries again by itself around ${when}.`;
    if (job.gpu_wait === 'stopped') {
      return isGuest() ? `Paused for now. It goes on once ${hostName()} checks their worker.`
        : 'AI work is stopped: Hugging Face started charging your credits. Tap Resume to go on.';
    }
    const why = (job.stage || 'Waiting for free time.').replace(/\s*It will finish by itself\.?/, '');
    return `${why} Tries again by itself around ${when}.`;
  }
  if (job.status === 'failed') return job.error || 'Something went wrong.';
  const len = job.seconds_long ? `${Math.round(job.seconds_long)} sec` : '';
  // A one-shot preview is the first 5 s part of the video (said in the lengths the user picks).
  if (job.draft && job.chained && job.wanted > 1) return `Preview ready · first 5 of ${job.wanted * 5} sec`;
  if (job.draft) return ['Preview ready', len].filter(Boolean).join(' · ');
  return ['Ready', len, job.stage].filter(Boolean).join(' · ');
}

// Keeps number ranges such as "1–2 min" or "3–5 a day" on one line.
const nb = (text) => String(text).replace(/(\d)–(\d)/g, '$1\u2060–\u2060$2');

// Clips a preview still has to animate when you tap Finish.
const clipsLeft = (job) => Math.max(0, (job.wanted || 1) - (job.made || 0));

// How long one AI clip takes: the free online GPUs, or the user's own PC.
const clipTime = () => (state.health && state.health.pc ? '3–5 min' : '1–2 min');

// A v10 worker makes every video one continuous shot (each 5 s part carries on from the one before).
// Before /health has answered, the page assumes the current worker.
const oneShot = () => !state.health || canDo('chain');

// About how long Finish takes for `parts` more 5 s parts (one after the other).
function partsTime(parts) {
  const [lo, hi] = state.health && state.health.pc ? [3, 5] : [1, 2];
  return parts === 1 ? `${lo}–${hi} min` : `about ${lo * parts}–${hi * parts} min`;
}

// What a preview is and what Finish does, in one sentence.
function previewLine(job) {
  const rest = clipsLeft(job);
  if (!rest) return 'Like it? Tap Finish to keep it as your video.';
  if (job.chained) return `Finish adds the other ${rest * 5} s (${partsTime(rest)}).`;
  return rest === 1
    ? `Only clip 1 moves. Finish animates clip ${job.wanted} (${clipTime()}).`
    : `Only clip 1 moves. Finish animates the other ${rest} (${clipTime()} each).`;
}

function renderJobs() {
  const box = $('#jobs');
  box.innerHTML = '';
  for (const job of state.jobs) {
    const card = document.createElement('article');
    card.className = `job ${job.status}${job.has_video ? ' playable' : ''}`;
    card.innerHTML = `
      <button type="button" class="thumb" aria-label="Play"></button>
      <div class="job-body">
        <div class="job-title"></div>
        <div class="job-tags" hidden></div>
        <div class="job-stage"></div>
        <div class="meter" hidden><span></span></div>
        <p class="job-hint" hidden></p>
        <div class="job-actions"></div>
      </div>`;
    const thumb = $('.thumb', card);
    if (job.has_thumb || job.status !== 'queued') {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = mediaUrl(job, 'thumb');
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
    }
    const title = (job.label || (job.kind === 'surprise' ? 'Surprise' : 'Video'))
      + (job.batch > 1 ? ` · ${job.index + 1} of ${job.batch}` : '');
    $('.job-title', card).textContent = title;
    const tags = $('.job-tags', card);
    const tag = (text, cls) => {
      const el = document.createElement('span');
      el.className = `chip ${cls}`;
      el.textContent = text;
      tags.appendChild(el);
      tags.hidden = false;
    };
    if (job.draft) tag('Preview', '');
    if (!isGuest() && job.owner && job.owner !== 'me') tag(`by ${job.owner_name || 'a friend'}`, 'by-friend');
    $('.job-stage', card).textContent = nb(describe(job));
    const busy = job.status === 'working' || job.status === 'queued';
    if (busy) {
      $('.meter', card).hidden = false;
      $('.meter span', card).style.width = `${Math.max(4, Math.round((job.progress || 0) * 100))}%`;
    }
    const actions = $('.job-actions', card);
    const add = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `plain ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    if (job.has_video) {
      const play = document.createElement('span');
      play.className = 'play';
      play.innerHTML = '<span><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></span>';
      thumb.appendChild(play);
      thumb.addEventListener('click', () => openPlayer(job));
    }
    if (job.status === 'done' && job.draft) {
      const hint = $('.job-hint', card);
      hint.textContent = nb(previewLine(job));
      hint.hidden = false;
    }
    // Together: the picture check and the out-of-time card have their own buttons (together.js)
    const own = job.kind === 'together' && window.Together ? Together.actions(job) : null;
    if (own) own.forEach(([label, cls, fn]) => add(label, cls, fn));
    else if (job.status === 'done') {
      add(job.draft ? '▶ Watch' : '▶ Watch & save', 'open', () => openPlayer(job));
      if (job.draft) add('Finish video', 'finish', () => finishJob(job));
      else if (job.editable && job.made < job.wanted) add('Make the rest', 'finish', () => finishJob(job));
      if (job.editable) add('Edit', '', () => openEditor(job));
      if (!job.draft) add('Copy caption', '', () => copyText(job.caption || ''));
      // Posting plan: a finished video can wait in line for TikTok; once it does, its chip opens the Post screen.
      if (!job.draft && job.has_video && canPlan() && state.plan) {
        const item = planOf(job.id);
        if (item) add('📅 In plan', 'plan-in', () => openPost(item.id));
        else add('+ Plan', 'plan-add', () => addToPlan(job));
      }
    } else if (job.has_video) {
      add(job.status === 'waiting' ? '▶ Watch so far' : '▶ Last version', 'open', () => openPlayer(job));
    }
    if (!own && job.status === 'failed') add('Try again', '', () => retryJob(job));
    if (!own && job.status === 'waiting' && job.gpu_wait !== 'stopped') add('Try now', '', () => retryJob(job));
    if (!own && job.status !== 'working') add('Delete', 'del', () => deleteJob(job));
    if (job.kind === 'together' && window.Together) Together.decorate(card, job); // Together: tag, picture, note
    box.appendChild(card);
  }
  const drafts = state.jobs.filter(finishable);
  $('#finishAll').hidden = drafts.length < 2;
  $('#finishAll').textContent = `Finish all ${drafts.length} previews`;
  // Phone: a shortcut from the top of the page down to the list
  const ready = state.jobs.filter((j) => j.status === 'done').length;
  const busy = state.jobs.filter((j) => j.status === 'queued' || j.status === 'working').length;
  const parts = [ready && `${ready} ready`, busy && `${busy} making`].filter(Boolean);
  $('#jumpVideos').hidden = !state.jobs.length;
  $('#jumpVideos').textContent = parts.length ? `Your videos: ${parts.join(' · ')}` : `Your videos (${state.jobs.length})`;
  renderPlanStrip();
}

function replaceJob(job) {
  state.jobs = state.jobs.map((j) => (j.id === job.id ? { ...j, ...job } : j));
  renderJobs();
}

const anyDialogOpen = () => [...document.querySelectorAll('dialog')].some((d) => d.open);

let pollTimer;
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshJobs, ms);
}

async function refreshJobs() {
  if (!state.worker) return;
  const asked = state.worker;
  try {
    const res = await api('/jobs');
    if (state.worker !== asked) return; // another worker on this device meanwhile: its own list is on the way
    state.jobs = res.jobs;
    if (res.me) state.me = res.me;
    renderJobs();
    renderRole();
    renderMake();
    refreshHealth();
    renderWorkerDot(true);
    $('#wakeNote').hidden = true;
    showWhenReady(res.jobs);
    showLinked(res.jobs);
    announceReady(res.jobs);
    renderPings();
    syncPings();
    if (state.plan && Date.now() - state.planAt > 60000) loadPlan(); // (a reminder may have come meanwhile)
    const busy = res.jobs.some((j) => j.status === 'queued' || j.status === 'working');
    schedulePoll(document.hidden ? 60000 : state.watchAfter ? 2000 : busy ? 4000 : 30000);
  } catch (e) {
    if (state.worker !== asked) return;
    renderWorkerDot(false);
    $('#wakeNote').hidden = false;
    if (isGuest() && e.status === 401) {
      $('#wakeNote').textContent = `This invite doesn't work anymore. Ask ${hostName()} for a new link.`;
      schedulePoll(120000);
      return;
    }
    $('#wakeNote').textContent = e.waking || e instanceof TypeError
      ? 'Waking up your worker… (up to a minute)'
      : `Worker problem: ${e.message}`;
    schedulePoll(6000);
  }
}

// After Edit or Finish: opens the new version as soon as it's ready.
function showWhenReady(jobs) {
  const want = state.watchAfter;
  if (!want) return;
  const job = jobs.find((j) => j.id === want.id);
  if (!job || job.status === 'failed') {
    state.watchAfter = null;
    return;
  }
  if (job.status !== 'done' || (job.rev || 0) <= want.rev) return;
  state.watchAfter = null;
  if (!document.hidden && !anyDialogOpen()) openPlayer(job);
  else toast('Your new version is ready');
}

function wakeWorker() {
  $('#wakeNote').hidden = false;
  schedulePoll(5000);
}

async function retryJob(job) {
  try {
    await api(`/jobs/${job.id}/retry`, { method: 'POST' });
    refreshJobs();
  } catch (e) {
    toast(e.message);
  }
}

// A preview (or a video that came out short) becomes the full video: only missing clips are animated.
async function finishJob(job) {
  unlockSound(); // a tap: the chime can play when it's ready
  try {
    replaceJob(await api(`/jobs/${job.id}/finish`, { method: 'POST' }));
    state.watchAfter = { id: job.id, rev: job.rev || 0 };
    const missing = Math.max(0, (job.wanted || 1) - (job.made || 0));
    let msg = 'Making the full video…';
    if (missing && job.chained) msg = `Adding the other ${missing * 5} s (${partsTime(missing)}). You can close the app.`;
    else if (missing) msg = `Animating ${missing} more clip${missing === 1 ? '' : 's'} (1–2 min each). You can close the app.`;
    toast(nb(msg));
    schedulePoll(1500);
  } catch (e) {
    toast(e.message);
  }
}

// Previews ready to finish: your own (the owner's list also shows friends' videos).
const finishable = (j) => j.draft && j.status === 'done' && (isGuest() || !j.owner || j.owner === 'me');

async function finishAll() {
  unlockSound();
  const drafts = state.jobs.filter(finishable);
  let started = 0;
  for (const job of drafts) {
    try {
      replaceJob(await api(`/jobs/${job.id}/finish`, { method: 'POST' }));
      started++;
    } catch (e) {
      toast(e.message);
      break;
    }
  }
  if (started) toast(`Finishing ${started} videos. They keep going when you close the app.`);
  schedulePoll(1500);
}

async function deleteJob(job) {
  const item = canPlan() ? planOf(job.id) : null;
  if (!confirm(item ? 'Delete this video? It also leaves your posting plan.' : 'Delete this video?')) return;
  try {
    await api(`/jobs/${job.id}`, { method: 'DELETE' });
    state.jobs = state.jobs.filter((j) => j.id !== job.id);
    renderJobs();
    if (item) planCall(`/plan/queue/${item.id}`, { method: 'DELETE' }, true).then((plan) => plan || loadPlan());
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Player + saving ----------

// Before you post: what sound is in it, and TikTok's AI label. [text, bold] pieces per line.
function renderPlayerTip(job) {
  const tip = $('#playerTip');
  tip.textContent = '';
  const line = (...pieces) => {
    const li = document.createElement('li');
    for (const [text, bold] of pieces) {
      const el = bold ? document.createElement('b') : document.createTextNode(text);
      if (bold) el.textContent = text;
      li.appendChild(el);
    }
    tip.appendChild(li);
  };
  if (job.music_used === 'funny') line(['Music: '], [`"${songLabel(job.track || '')}"`, true], [' is already in (credit in the caption).']);
  else if (job.music_used === 'upload') line(['Your song is already in.']);
  else if (job.music_used === 'mysong') {
    const s = mySong(job.song_id);
    line(['Music: '], [s ? `"${s.name}"` : 'your song', true], [' is already in, from its meme part.']);
  }
  else if (job.music_used === 'mine') line(["Your video's sound is already in."]);
  else line(['No music: add '], [job.sound || 'a trending sound', true], [' in TikTok.']);
  // Together: clip credits, and no AI label for a free look of real videos (together.js)
  if (job.kind === 'together' && window.Together && Together.tip(job, line)) return;
  line(['Before posting, turn on '], ['AI-generated content', true], [' in TikTok.']);
}

const preview = new Audio();
let previewing = '';
let previewStop = null;
let songFileUrl = null;

// The song "Pick myself" works on: a chosen meme song or the uploaded file.
function currentSongUrl() {
  if (state.music === 'track') return songUrl(state.track);
  if (state.music === 'upload' && state.songFile) {
    if (!songFileUrl) songFileUrl = URL.createObjectURL(state.songFile);
    return songFileUrl;
  }
  return null;
}

function songChanged() {
  state.songStart = 0;
  state.songDuration = 0;
  if (songFileUrl) URL.revokeObjectURL(songFileUrl);
  songFileUrl = null;
  loadSongDuration();
}

function loadSongDuration() {
  const url = currentSongUrl();
  if (!url) return;
  const probe = new Audio();
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', () => {
    if (currentSongUrl() !== url) return;
    state.songDuration = probe.duration || 0;
    renderOptions();
  }, { once: true });
  probe.src = url;
}

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Plays the chosen part for as long as the video will be.
function hearPart() {
  const url = currentSongUrl();
  if (!url) return;
  clearTimeout(previewStop);
  previewing = '';
  const speed = { slow: 0.8, normal: 1, fast: 1.25 }[state.speed] || 1;
  const seconds = (state.clips * state.seconds) / speed;
  const start = () => {
    preview.currentTime = state.songStart;
    preview.play().catch(() => toast("Couldn't play that part"));
    previewStop = setTimeout(() => preview.pause(), seconds * 1000);
  };
  if (preview.src !== url) {
    preview.src = url;
    preview.addEventListener('loadedmetadata', start, { once: true });
  } else {
    start();
  }
  renderOptions();
}

function togglePreview(name) {
  if (previewing === name) {
    preview.pause();
    previewing = '';
  } else {
    preview.src = songUrl(name);
    preview.play().catch(() => toast("Couldn't play that preview"));
    previewing = name;
  }
  renderOptions();
}

// ---------- My songs ----------
// The owner's saved songs (workers that list 'songs'), each cut to its meme part by the worker. In Music they
// come first, each with ▶ to hear its meme part; the song set for every video is picked for new videos (until
// other music is picked on that visit). Friends see and use them; the owner adds and changes them in Settings
// (or with + Add a song under Music).

const SONG_MAX = 10;
const SONG_MB = 25;
const songsOn = () => canDo('songs') && Array.isArray(state.songs);
const mySong = (id) => (state.songs || []).find((s) => s.id === id) || null;
const defaultSong = () => (state.songs || []).find((s) => s.default) || null;
const songAudioUrl = (id) => `${state.worker.url}/songs/${id}/audio?key=${encodeURIComponent(state.worker.key)}`;
// The music the next video gets: a saved song only while it is there (an older worker: the meme song).
// (Together: several videos have several sounds, so "Video's own sound" becomes the meme song.)
const musicNow = () => (state.music === 'mysong' && !(songsOn() && mySong(state.songId)) ? 'funny'
  : state.music === 'mine' && window.Together && Together.on() ? 'funny' : state.music);
// Seconds of video (and so of song) the next video has.
const videoSeconds = () => (state.clips * state.seconds) / ({ slow: 0.8, normal: 1, fast: 1.25 }[state.speed] || 1);

// A song file's name as a song name: "7e1de5ab-Rauf__Faik_-_Detstvo_(Lyrics).mp3" -> "Rauf Faik - Detstvo".
function songNameFrom(file) {
  return (file.name || '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/[([](?:official\s+)?(?:lyrics?|audio|video|music\s+video|official|hq|hd|mp3)[^)\]]*[)\]]/gi, ' ')
    .replace(/(\S)\s+(?:official\s+)?(?:lyrics?|audio|video|hq|hd)\b.*$/i, '$1')
    .replace(/^[0-9a-f]{6,}[-\s]+/i, '') // a random prefix some apps add
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase()) || 'My song';
}

let songsAsked = 0; // a list fetched before the latest change is out of date
async function loadSongs() {
  if (!state.worker || !canDo('songs')) return;
  const asked = state.worker;
  const n = ++songsAsked;
  try {
    const { songs } = await api('/songs');
    if (state.worker !== asked || n !== songsAsked) return;
    state.songs = songs;
  } catch {
    return; // asleep or offline: the next check tries again
  }
  settleSongChoice();
  renderOptions();
  renderSongsBox();
}

// Once the songs are known: new videos get the song set for every video, unless other music was picked on this
// visit; a saved song that is gone gives way to that one (or to the meme song).
function settleSongChoice() {
  if (!songsOn()) return;
  const def = defaultSong();
  if (!state.musicPicked && def) {
    state.music = 'mysong';
    state.songId = def.id;
  } else if (state.music === 'mysong' && !mySong(state.songId)) {
    state.songId = def ? def.id : null;
    if (!def) state.music = 'funny';
  }
}

function pickSong(id) {
  state.music = 'mysong';
  state.songId = id;
  state.musicPicked = true;
  save(KEYS.music, 'mysong');
  save(KEYS.songId, id);
  songChanged();
  renderOptions();
}

// The Music step's song tiles: tap the name to use it, ▶ to hear its meme part.
function renderMySongs() {
  const songs = songsOn() ? state.songs : [];
  $('#mySongs').hidden = !songs.length;
  $('#addSongLink').hidden = !(songsOn() && !isGuest() && songs.length < SONG_MAX);
  const row = $('#mySongRow');
  row.innerHTML = '';
  for (const s of songs) {
    const on = state.music === 'mysong' && state.songId === s.id;
    const tile = document.createElement('div');
    tile.className = 'voice song-tile';
    tile.classList.toggle('on', on);
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'voice-name';
    pick.textContent = s.name;
    pick.title = s.name;
    pick.setAttribute('aria-pressed', String(on));
    pick.addEventListener('click', () => pickSong(s.id));
    tile.append(pick, songHearButton(s, 'hear'));
    row.appendChild(tile);
  }
}

// ▶ for a saved song (■ while it plays). label: shown next to the sign (e.g. "Hear").
function songHearButton(s, cls, label = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.song = s.id;
  if (label) b.dataset.label = label;
  b.addEventListener('click', () => hearSong(s.id));
  renderSongButton(b);
  return b;
}

function renderSongButton(b) {
  const s = mySong(b.dataset.song);
  const playing = previewing === `song:${b.dataset.song}` && !preview.paused;
  b.textContent = `${playing ? '■' : '▶'}${b.dataset.label ? ` ${playing ? 'Stop' : b.dataset.label}` : ''}`;
  b.setAttribute('aria-label', `${playing ? 'Stop' : 'Hear'} ${s ? s.name : 'the song'}`);
}

const renderSongButtons = () => document.querySelectorAll('[data-song]').forEach(renderSongButton);

// Plays a saved song from `from` (its meme part when not given) for as long as a video is; tap again to stop.
function hearSong(id, from = null) {
  const s = mySong(id);
  if (!s) return;
  const key = `song:${id}`;
  clearTimeout(previewStop);
  if (previewing === key && !preview.paused && from === null) {
    preview.pause();
    previewing = '';
    renderSongButtons();
    return;
  }
  previewing = key;
  const url = songAudioUrl(id);
  const at = from ?? s.start ?? 0;
  const go = () => {
    if (previewing !== key) return;
    preview.currentTime = at;
    preview.play().catch((e) => {
      if (previewing === key && e.name !== 'AbortError') toast("Couldn't play that song");
    });
    previewStop = setTimeout(() => {
      if (previewing === key) preview.pause();
    }, Math.max(5, videoSeconds()) * 1000);
  };
  if (preview.src !== url) {
    preview.src = url;
    preview.addEventListener('loadedmetadata', go, { once: true });
  } else {
    go();
  }
  renderSongButtons();
  renderHear(); // a voice sample's ■ turns back to ▶
}

// ---------- Pet voice: which voice, and ▶ to hear each one ----------

// How a voice is named in the Extras summary and in "Got it".
const voiceName = (v) => (v === 'auto' || v === 'on' ? 'Pet voice' : `${VOICE_LABELS[v]} voice`);

// The voice choice (main screen and editor): tap a name to pick it, ▶ to hear it. Built once.
function buildVoices(box, onPick) {
  box.innerHTML = '';
  for (const v of VOICE_PICKS) {
    const tile = document.createElement('div');
    tile.className = 'voice';
    tile.dataset.v = v;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'voice-name';
    pick.textContent = VOICE_LABELS[v];
    pick.addEventListener('click', () => onPick(v));
    tile.appendChild(pick);
    if (v !== 'auto') { // Auto has no sound of its own: it picks one of the others
      const hear = document.createElement('button');
      hear.type = 'button';
      hear.className = 'hear';
      hear.dataset.v = v;
      hear.addEventListener('click', () => hearVoice(v));
      tile.appendChild(hear);
    }
    box.appendChild(tile);
  }
}

function renderVoices(box, current) {
  box.querySelectorAll('.voice').forEach((tile) => {
    const on = tile.dataset.v === current;
    tile.classList.toggle('on', on);
    $('.voice-name', tile).setAttribute('aria-pressed', String(on));
  });
  renderHear();
}

// ▶ on every voice sample, ■ on the one playing.
function renderHear() {
  document.querySelectorAll('.voices .hear').forEach((b) => {
    const playing = previewing === `voice:${b.dataset.v}` && !preview.paused;
    b.textContent = playing ? '■' : '▶';
    b.setAttribute('aria-label', `${playing ? 'Stop' : 'Hear'} the ${VOICE_LABELS[b.dataset.v].toLowerCase()} voice`);
  });
}

// Plays a voice's sample in the song preview's player, so any other preview stops. Tap again to stop.
function hearVoice(v) {
  const id = `voice:${v}`;
  clearTimeout(previewStop);
  if (previewing === id && !preview.paused) {
    preview.pause();
    previewing = '';
  } else {
    previewing = id;
    preview.src = voiceUrl(v);
    preview.play().catch((e) => {
      if (previewing !== id) return; // another preview took over
      previewing = '';
      renderHear();
      if (e.name !== 'AbortError') toast("Couldn't play that voice");
    });
  }
  renderOptions(); // a song's ■ turns back to ▶
}

// Pet voice was switched off: its sample stops too.
function stopVoiceSample() {
  if (!previewing.startsWith('voice:')) return;
  preview.pause();
  previewing = '';
  renderHear();
}

function setSeg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(value))));
}

function chips(box, items, current, onPick) {
  box.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.key = item.key;
    b.textContent = item.label;
    b.setAttribute('aria-pressed', String(item.key === current));
    b.addEventListener('click', () => onPick(item.key));
    box.appendChild(b);
  }
}

// Draws every option on the main screen from state.
function renderOptions() {
  chips($('#styleRow'), STYLES, state.style, (key) => {
    state.style = key;
    save(KEYS.style, key);
    renderOptions();
  });
  const music = musicNow();
  chips($('#musicRow'), MUSIC, music, (key) => {
    state.music = key;
    state.musicPicked = true;
    save(KEYS.music, key);
    songChanged();
    renderOptions();
  });
  renderMySongs();

  const list = $('#songList');
  list.hidden = music !== 'track';
  list.innerHTML = '';
  for (const name of SONGS) {
    const row = document.createElement('div');
    row.className = 'song';
    row.setAttribute('aria-current', String(name === state.track));
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'play-song';
    play.setAttribute('aria-label', `${previewing === name ? 'Stop' : 'Play'} ${songLabel(name)}`);
    play.textContent = previewing === name ? '■' : '▶';
    play.addEventListener('click', () => togglePreview(name));
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'pick-song';
    pick.textContent = songLabel(name);
    pick.addEventListener('click', () => {
      state.track = name;
      save(KEYS.track, name);
      songChanged();
      renderOptions();
    });
    row.append(play, pick);
    list.appendChild(row);
  }

  $('#songUpload').hidden = music !== 'upload';
  $('#songName').textContent = state.songFile ? state.songFile.name : 'No song chosen yet';
  $('#partLine').hidden = music === 'none' || music === 'mysong'; // a saved song always starts at its meme part
  $('#musicRow [data-key="mine"]').disabled = state.surprise;
  const song = music === 'mysong' ? mySong(state.songId) : null;
  const hint = state.surprise && music === 'mine' ? 'A surprise has no sound of its own, so it gets a meme song.'
    : song ? `Every video starts at its meme part (${clock(song.start)}).${isGuest() ? '' : ' Change it in Settings.'}`
      : MUSIC_HINT[music] || '';
  $('#musicHelp').textContent = hint;
  $('#musicHelp').hidden = !hint;
  $('#musicNote').hidden = !['mine', 'upload', 'mysong'].includes(music);
  const canPick = ['track', 'upload'].includes(music);
  $('#partSeg [data-v="custom"]').hidden = !canPick;
  const picking = canPick && state.part === 'custom';
  $('#partPick').hidden = !picking;
  if (picking) {
    const range = $('#songStart');
    range.max = String(Math.max(1, Math.floor(state.songDuration || 180)));
    range.value = String(state.songStart);
    $('#songStartLabel').textContent = clock(state.songStart);
    $('#songLength').textContent = state.songDuration ? `of ${clock(state.songDuration)}` : '';
  }
  setSeg('partSeg', state.part === 'custom' && !canPick ? 'auto' : state.part);
  setSeg('videoSeg', state.clips * 5);
  setSeg('speedSeg', state.speed);
  $('#captionsOpt').checked = state.captions;
  $('#brandOpt').checked = state.brand;
  setSeg('friendUsesSeg', state.friendUses);
  renderExtras();
  renderMake();
  if (window.Together) Together.render(); // Together: the switch, the animals, scene cards, Look, Ideas to try
}

const canDo = (key) => Boolean(state.health && (state.health.features || []).includes(key));

// The Real → AI opening needs real video: a link or an uploaded video, not a surprise or a photo.
// (Together: at least one animal with a real video.)
const noRealVideo = () => (window.Together && Together.on() ? Together.noRealVideo()
  : state.surprise || Boolean(state.file && !isVideoFile(state.file)));

// Whether an extra is on for the next video: the worker makes it, it is switched on, and it fits.
function extraOn(key) {
  if (!canDo(key) || (key === 'outro' && isGuest()) || (key === 'opening' && noRealVideo())) return false;
  return key === 'voice' ? state.extras.voice !== 'off' : Boolean(state.extras[key]);
}

// The form value: voice is 'off' or a voice; the others are 'true' or 'false'.
const extraValue = (key) => (key === 'voice' ? (extraOn('voice') ? state.extras.voice : 'off') : String(extraOn(key)));

// The Extras box: its switches, and the one-line summary shown while it is folded.
function renderExtras() {
  for (const x of EXTRAS) {
    $(`#${x.line}`).hidden = !canDo(x.key) || (x.key === 'outro' && isGuest());
    $(`#${x.id}`).checked = x.key === 'voice' ? state.extras.voice !== 'off' : Boolean(state.extras[x.key]);
  }
  $('#voicePick').hidden = !extraOn('voice'); // which voice: shown while Pet voice is on
  renderVoices($('#voiceSeg'), state.extras.voicePick);
  $('#openingOpt').disabled = noRealVideo(); // nothing real to open with
  $('#openingLine small').textContent = noRealVideo() ? 'Needs a real video' : 'Starts with your real clip';
  const on = EXTRAS.filter((x) => extraOn(x.key)).map((x) => (x.key === 'voice' ? voiceName(state.extras.voice) : x.label));
  if (state.captions) on.push('Text');
  if (state.brand && !isGuest()) on.push(`@${BRAND.name}`);
  if (state.speed !== 'normal') on.push(state.speed === 'slow' ? 'Slow-mo' : 'Fast');
  const animal = $('#animalOpt').value.trim();
  if (animal && !(window.Together && Together.on())) on.push(animal); // Together: each animal has its own
  $('#extrasSum').textContent = on.length ? on.join(' · ') : 'All off';
}

function openPlayer(job) {
  if (window.Together) Together.playerReset(); // Together: the video again (not the picture check's picture)
  state.playing = job;
  state.playingBlob = null;
  const video = $('#playerVideo');
  video.src = mediaUrl(job, 'video');
  $('#playerCaption').textContent = job.caption || '';
  const ready = job.status === 'done';
  const draft = ready && job.draft;
  const rest = clipsLeft(job);
  $('#playerKind').hidden = !draft;
  $('#playerKind').textContent = nb(job.chained && rest
    ? `Quick preview: the first 5 s. ${previewLine(job)}`
    : `Quick preview. ${previewLine(job)}`);
  $('#finishBtn').hidden = !draft;
  $('#finishBtn').textContent = !rest ? 'Finish' : job.chained ? `Finish: make all ${job.wanted * 5} s` : `Finish: animate ${rest} more`;
  $('#editBtn').hidden = !(ready && job.editable);
  $('#saveBtn').className = draft ? 'plain' : 'go small';
  $('#saveBtn').textContent = draft ? 'Save preview' : 'Save video';
  renderPlayerTip(job);
  openDialog($('#player'));
  video.play().catch(() => {});
  // Fetch the file now so Save can open the share sheet straight away.
  fetch(mediaUrl(job, 'video'))
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => {
      if (state.playing === job) state.playingBlob = blob;
    })
    .catch(() => {});
}

async function saveVideo() {
  const job = state.playing;
  if (!job) return;
  const name = `antics-${job.id}.mp4`;
  let blob = state.playingBlob;
  if (!blob) {
    toast('Getting the video…');
    blob = await (await fetch(mediaUrl(job, 'video'))).blob();
    state.playingBlob = blob;
  }
  const file = new File([blob], name, { type: 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      // The share sheet needs a fresh tap after a slow download.
      toast('Ready. Tap Save video again.');
      return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------- Edit a video: change it, see the new version, repeat ----------

const edit = {
  job: null, style: 'random', len: 1, speed: 'normal', part: 'auto', songStart: 0, songDuration: 0,
  songFile: null, songFileUrl: null, redo: new Set(),
  voice: 'auto', // the voice Pet voice gives this video when it is on
};

const EDIT_EXTRAS = [['voice', 'editVoice', 'editVoiceLine'], ['meme', 'editMeme', 'editMemeLine'],
  ['opening', 'editOpening', 'editOpeningLine'], ['outro', 'editOutro', 'editOutroLine']];

const cleanAnimal = (text) => text.replace(/[^a-zA-Z ]/g, '').trim().toLowerCase().slice(0, 30);

function musicValue(job) {
  // (before the song list is in, a video keeps its own song: a text edit never changes its music)
  if (job.music === 'mysong') return mySong(job.song_id) || (job.song_id && !songsOn()) ? `song:${job.song_id}` : 'funny';
  if (job.music === 'track' && SONGS.includes(job.track)) return `track:${job.track}`;
  if (job.music === 'upload') return job.has_song ? 'upload' : 'funny';
  if (job.music === 'mine') return job.has_sound ? 'mine' : 'funny';
  return ['funny', 'none'].includes(job.music) ? job.music : 'funny';
}

function openEditor(job) {
  if ($('#player').open) closeDialog($('#player'));
  edit.job = job;
  edit.style = job.template || 'random';
  edit.len = job.wanted || 1;
  edit.speed = job.speed || 'normal';
  edit.part = job.song_part || 'auto';
  edit.songStart = job.song_start || 0;
  edit.songDuration = 0;
  edit.songFile = null;
  if (edit.songFileUrl) URL.revokeObjectURL(edit.songFileUrl);
  edit.songFileUrl = null;
  edit.redo = new Set();
  $('#editIdea').value = job.idea || '';
  $('#editAnimal').value = job.animal && job.animal !== 'animal' ? job.animal : '';
  $('#editAnimalLine').hidden = job.kind === 'surprise';
  $('#editCaptions').checked = job.captions !== false;
  $('#editBrandLine').hidden = !job.has_badge;
  $('#editBrand').checked = Boolean(job.brand);
  $('#editSongFile').value = '';

  const sel = $('#editMusic');
  sel.innerHTML = '';
  const opt = (value, label, parent = sel) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
  };
  const songs = songsOn() ? state.songs : [];
  const ownSong = job.music === 'mysong' && job.song_id && !songsOn(); // its song, before the list is in
  if (songs.length || ownSong) { // the account's own songs first, each from its meme part
    const mine = document.createElement('optgroup');
    mine.label = 'My songs';
    sel.appendChild(mine);
    for (const s of songs) opt(`song:${s.id}`, s.name, mine);
    if (ownSong) opt(`song:${job.song_id}`, 'My song', mine);
  }
  opt('funny', 'Auto meme song');
  const group = document.createElement('optgroup');
  group.label = 'Meme songs';
  sel.appendChild(group);
  for (const name of SONGS) opt(`track:${name}`, songLabel(name), group);
  if (job.has_song) opt('upload', 'My uploaded song');
  opt('upload-new', job.has_song ? 'Upload a different song…' : 'Upload my song…');
  if (job.has_sound) opt('mine', "My video's sound");
  opt('none', 'No music (add a TikTok sound later)');
  sel.value = musicValue(job);
  // The video's own voice, else the one picked on the main screen.
  edit.voice = VOICE_PICKS.includes(job.voice) ? job.voice : state.extras.voicePick;
  for (const [key, id, line] of EDIT_EXTRAS) {
    // Shown when the worker makes it and this video can have it (real footage for the opening,
    // the owner's Follow me card for the ending).
    const sent = key === 'voice' ? typeof job.voice === 'string' : typeof job[key] === 'boolean';
    const fits = key === 'opening' ? Boolean(job.has_hook)
      : key === 'outro' ? Boolean(job.has_endcard) && !isGuest() : true;
    $(`#${line}`).hidden = !(canDo(key) && sent && fits);
    $(`#${id}`).checked = key === 'voice' ? VOICES.includes(job.voice) && job.voice !== 'off' : Boolean(job[key]);
  }

  const box = $('#editTexts');
  box.innerHTML = '';
  (job.texts || []).forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'edit-text';
    row.dataset.i = String(i);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.value = text;
    // A one-shot video keeps its text going unless a part has its own.
    input.placeholder = job.chained && i > 0 ? 'Same text as before' : 'No text here';
    input.setAttribute('aria-label', `Text on part ${i + 1}`);
    const redo = document.createElement('button');
    redo.type = 'button';
    redo.className = 'redo';
    redo.textContent = '↻';
    redo.title = 'New idea and new animation for this part';
    redo.setAttribute('aria-label', `New idea for part ${i + 1}`);
    redo.addEventListener('click', () => {
      if (edit.redo.has(i)) edit.redo.delete(i);
      else edit.redo.add(i);
      renderEditor();
    });
    row.append(num, input, redo);
    if (job.draft && i > 0) {
      const still = document.createElement('span');
      still.className = 'still';
      still.textContent = job.chained ? 'Not in the preview yet. Finish adds it.'
        : 'A still picture in the preview. It moves when you finish.';
      row.appendChild(still);
    }
    box.appendChild(row);
  });
  note($('#editNote'), '');
  if (window.Together) Together.editorOpen(job); // Together: "Scene and look" in place of style and Animal
  renderEditor();
  openDialog($('#editor'));
  loadEditSongDuration();
}

// Clips that already move (a preview only animates the first one).
const animatedClips = (job) => (job.draft ? Math.min(1, job.made || 0) : job.made || 0);

function redosLeft(job) {
  if (!isGuest() || !state.me || state.me.redos == null) return Infinity;
  return Math.max(0, state.me.redos - (job.redos || 0));
}

// True when saving will animate something again (slower, and it uses free time).
function willAnimate() {
  const job = edit.job;
  const together = window.Together ? Together.editAnimates() : null; // Together: its own rules (null: these)
  if (together !== null) return together;
  if ($('#editIdea').value.trim().replace(/\s+/g, ' ') !== (job.idea || '')) return true;
  if (edit.style !== (job.template || 'random')) return true;
  const animal = cleanAnimal($('#editAnimal').value);
  if (job.kind !== 'surprise' && animal && animal !== job.animal) return true;
  if ([...edit.redo].some((i) => i < animatedClips(job) && i < edit.len)) return true;
  return !job.draft && edit.len > (job.made || 0);
}

// Whether saving throws away a clip that already moves (what a friend's redo limit counts).
function losesAnimation() {
  const job = edit.job;
  const together = window.Together ? Together.editLoses() : null; // Together: its own rules (null: these)
  if (together !== null) return together;
  if ($('#editIdea').value.trim().replace(/\s+/g, ' ') !== (job.idea || '')) return animatedClips(job) > 0;
  if (edit.style !== (job.template || 'random')) return animatedClips(job) > 0;
  const animal = cleanAnimal($('#editAnimal').value);
  if (job.kind !== 'surprise' && animal && animal !== job.animal) return animatedClips(job) > 0;
  return [...edit.redo].some((i) => i < animatedClips(job) && i < edit.len);
}

function editSongUrl() {
  const sel = $('#editMusic').value;
  if (sel.startsWith('song:')) return mySong(sel.slice(5)) ? songAudioUrl(sel.slice(5)) : null;
  if (sel.startsWith('track:')) return songUrl(sel.slice(6));
  if (sel === 'upload-new' && edit.songFile) {
    if (!edit.songFileUrl) edit.songFileUrl = URL.createObjectURL(edit.songFile);
    return edit.songFileUrl;
  }
  return null;
}

function loadEditSongDuration() {
  const url = editSongUrl();
  edit.songDuration = 0;
  if (!url) return;
  const probe = new Audio();
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', () => {
    if (editSongUrl() !== url) return;
    edit.songDuration = probe.duration || 0;
    renderEditor();
  }, { once: true });
  probe.src = url;
}

// Plays the chosen song (from `from` seconds, for `seconds` if given); the same button stops it.
function playSong(url, from = 0, seconds = 0) {
  clearTimeout(previewStop);
  previewing = '';
  if (!url) return;
  const start = () => {
    preview.currentTime = from;
    preview.play().catch(() => toast("Couldn't play that song"));
    if (seconds) previewStop = setTimeout(() => preview.pause(), seconds * 1000);
  };
  if (preview.src !== url) {
    preview.src = url;
    preview.addEventListener('loadedmetadata', start, { once: true });
  } else {
    start();
  }
}

function renderEditor() {
  const job = edit.job;
  if (!job) return;
  const left = redosLeft(job);
  document.querySelectorAll('#editTexts .edit-text').forEach((row) => {
    const i = Number(row.dataset.i);
    row.hidden = i >= edit.len;
    const b = row.querySelector('.redo');
    b.setAttribute('aria-pressed', String(edit.redo.has(i)));
    b.disabled = left <= 0 && i < animatedClips(job) && !edit.redo.has(i);
  });
  const extra = edit.len - (job.texts || []).length;
  const firstRedo = Math.min(...[...edit.redo].filter((i) => i < edit.len));
  const follows = job.chained && Number.isFinite(firstRedo) && firstRedo < Math.min(edit.len, animatedClips(job)) - 1;
  $('#editRedoHelp').textContent = '↻ = a new idea and animation for that part.'
    + (follows ? ' The parts after it are made again too, so the video stays smooth.' : '')
    + (extra > 0 ? ` ${extra} more part${extra === 1 ? '' : 's'} will get new ideas.` : '')
    + (left < Infinity ? ` New animations left for this video: ${left}.` : '');
  chips($('#editStyle'), STYLES, edit.style, (key) => {
    edit.style = key;
    renderEditor();
  });
  const music = $('#editMusic').value;
  $('#editSongUpload').hidden = music !== 'upload-new';
  $('#editSongName').textContent = edit.songFile ? edit.songFile.name : 'No song chosen yet';
  $('#editHear').hidden = !editSongUrl();
  $('#editPartLine').hidden = music === 'none' || music.startsWith('song:'); // a saved song: its meme part
  const canPick = music.startsWith('track:') || music === 'upload-new' || music === 'upload';
  $('#editPartSeg [data-v="custom"]').hidden = !canPick;
  const part = edit.part === 'custom' && !canPick ? 'auto' : edit.part;
  setSeg('editPartSeg', part);
  $('#editPartPick').hidden = part !== 'custom';
  if (part === 'custom') {
    const range = $('#editSongStart');
    range.max = String(Math.max(1, Math.floor(edit.songDuration || 180)));
    range.value = String(edit.songStart);
    $('#editSongStartLabel').textContent = clock(edit.songStart);
    $('#editSongLength').textContent = edit.songDuration ? `of ${clock(edit.songDuration)}` : '';
    $('#editHearPart').hidden = !editSongUrl();
  }
  setSeg('editLenSeg', edit.len);
  setSeg('editSpeedSeg', edit.speed);
  // Which voice: shown while this video's Pet voice is on.
  $('#editVoicePick').hidden = $('#editVoiceLine').hidden || !$('#editVoice').checked;
  renderVoices($('#editVoiceSeg'), edit.voice);
  if (window.Together) Together.editorRender(); // Together: the Scene and look box
  const animate = willAnimate();
  const blocked = left <= 0 && losesAnimation();
  $('#editSave').disabled = blocked;
  $('#editSave').textContent = animate ? 'Animate new version' : 'Show new version';
  if (blocked) {
    note($('#editNote'), 'This video has no new animations left. Change its text, music or speed, or make a new video.', 'bad');
  } else if ($('#editNote').classList.contains('bad') && $('#editNote').textContent.startsWith('This video has no')) {
    note($('#editNote'), '');
  }
}

async function saveEdit() {
  unlockSound();
  const job = edit.job;
  const form = new FormData();
  form.append('texts', JSON.stringify([...document.querySelectorAll('#editTexts input')].map((i) => i.value.trim())));
  form.append('idea', $('#editIdea').value.trim());
  if (job.kind === 'together' && window.Together) Together.editFields(form); // Together: scene, look, names...
  else {
    form.append('template', edit.style);
    if (job.kind !== 'surprise') form.append('animal', $('#editAnimal').value.trim());
  }
  form.append('clips', String(edit.len));
  const sel = $('#editMusic').value;
  if (sel === 'upload-new') {
    if (!edit.songFile) {
      note($('#editNote'), 'Choose your song file first, or pick another song.', 'bad');
      return;
    }
    form.append('music', 'upload');
    form.append('song', edit.songFile);
  } else if (sel.startsWith('track:')) {
    form.append('music', 'track');
    form.append('track', sel.slice(6));
  } else if (sel.startsWith('song:')) {
    form.append('music', 'mysong');
    form.append('song_id', sel.slice(5));
  } else {
    form.append('music', sel);
  }
  const canPick = sel.startsWith('track:') || sel === 'upload-new' || sel === 'upload';
  form.append('song_part', edit.part === 'custom' && !canPick ? 'auto' : edit.part);
  form.append('song_start', edit.songStart.toFixed(1));
  form.append('speed', edit.speed);
  form.append('captions', String($('#editCaptions').checked));
  if (job.has_badge) form.append('brand', String($('#editBrand').checked));
  for (const [key, id, line] of EDIT_EXTRAS) {
    if ($(`#${line}`).hidden) continue;
    const on = $(`#${id}`).checked;
    if (key === 'voice') form.append('voice', on ? edit.voice : 'off');
    else form.append(key, String(on));
  }
  const parts = window.Together ? Together.editParts() : edit.len; // (Together: one by one has a part per turn)
  const redo = [...edit.redo].filter((i) => i < parts);
  if (redo.length) form.append('redo', redo.join(','));
  const animate = willAnimate();
  const btn = $('#editSave');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api(`/jobs/${job.id}/edit`, { method: 'POST', body: form });
    replaceJob(res);
    state.watchAfter = { id: job.id, rev: job.rev || 0 };
    closeDialog($('#editor'));
    toast(res.animating ?? animate
      ? 'Animating your new version (1–2 min a clip). It opens when it is ready.'
      : 'Making your new version. It opens in a few seconds.');
    schedulePoll(1500);
  } catch (e) {
    note($('#editNote'), e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message, 'bad');
  } finally {
    btn.disabled = false;
    renderEditor();
  }
}

// ---------- Speak instead of typing ----------
// Browsers that turn speech into text themselves (Chrome, Edge, Safari) write as you talk.
// Others record, and the worker writes it down (Whisper on its free CPU).

const BrowserSpeech = window.SpeechRecognition || window.webkitSpeechRecognition;
let browserSpeechOff = false; // the browser's speech service failed here: record for the worker instead
let listening = null; // { stop }

function joinText(before, said, max = 160) {
  said = said.trim();
  if (!said) return before;
  if (!before.trim()) return (said[0].toUpperCase() + said.slice(1)).slice(0, max);
  return (before + (/\s$/.test(before) ? '' : ' ') + said).slice(0, max);
}

function setMic(btn, mode) {
  btn.classList.toggle('on', mode === 'on');
  btn.disabled = mode === 'busy';
  btn.textContent = mode === 'on' ? '■ Stop' : mode === 'busy' ? 'Writing it…' : '🎤 Speak';
}

function toggleMic(btn) {
  if (listening) {
    listening.stop();
    return;
  }
  preview.pause();
  const box = document.getElementById(btn.dataset.for);
  if (BrowserSpeech && !browserSpeechOff) speakInBrowser(btn, box);
  else recordForWorker(btn, box);
}

function typed(box, text) {
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

function speakInBrowser(btn, box) {
  const rec = new BrowserSpeech();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false; // one go: it stops by itself when you pause
  const before = box.value;
  let fallback = false;
  let said = '';
  rec.onresult = (e) => {
    said = Array.from(e.results, (r) => r[0].transcript).join(' ');
    typed(box, joinText(before, said, box.maxLength));
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech') toast("Didn't hear anything. Tap 🎤 Speak and talk.");
    else if (e.error === 'not-allowed') toast('Allow the microphone for this page, then tap 🎤 Speak again.');
    else if (e.error !== 'aborted') {
      browserSpeechOff = true; // e.g. no speech service in this browser
      fallback = true;
    }
  };
  rec.onend = () => {
    listening = null;
    setMic(btn, 'idle');
    if (said.trim()) heard(box, before, said);
    if (fallback) {
      toast('Say it again: recording now.');
      recordForWorker(btn, box);
    }
  };
  try {
    rec.start();
  } catch {
    browserSpeechOff = true;
    recordForWorker(btn, box);
    return;
  }
  listening = { stop: () => rec.stop() };
  setMic(btn, 'on');
}

async function recordForWorker(btn, box) {
  if (!state.worker) {
    toast('Set up your worker first (Settings), or type it.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast("This browser can't record. Tap the box and use the 🎤 on your keyboard.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Allow the microphone for this page, then tap 🎤 Speak again.');
    return;
  }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = [];
  const stop = () => {
    if (rec.state !== 'inactive') rec.stop();
  };
  const cap = setTimeout(stop, 30000);
  const quiet = stopWhenQuiet(stream, stop);
  rec.addEventListener('dataavailable', (e) => {
    if (e.data.size) chunks.push(e.data);
  });
  rec.addEventListener('stop', async () => {
    clearTimeout(cap);
    quiet();
    stream.getTracks().forEach((t) => t.stop());
    setMic(btn, 'busy');
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
      const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
      const form = new FormData();
      form.append('audio', blob, `speech.${ext}`);
      const { text } = await api('/listen', { method: 'POST', body: form });
      if (text) heard(box, box.value, text);
      else toast("Didn't catch that. Tap 🎤 Speak and try again.");
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a minute.'
        : e.status === 404 ? 'Update your worker (Settings) to speak in this browser.' : e.message);
    } finally {
      listening = null;
      setMic(btn, 'idle');
    }
  });
  rec.start();
  listening = { stop };
  setMic(btn, 'on');
}

// Stops a recording 2 s after you finish talking (soft speech still counts as talking). Returns a
// function that cleans up.
function stopWhenQuiet(stream, stop) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let spoke = false;
    let quietSince = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const loud = Math.sqrt(sum / buf.length) > 0.01;
      const now = performance.now();
      if (loud) {
        spoke = true;
        quietSince = 0;
      } else if (spoke) {
        quietSince = quietSince || now;
        if (now - quietSince > 2000) stop();
      }
    }, 100);
    return () => {
      clearInterval(timer);
      ctx.close().catch(() => {});
    };
  } catch {
    return () => {}; // no auto-stop: tap Stop
  }
}

// ---------- Understanding what you said ----------
// Orders in what you say set the options ("to Sneaky Snitch", "15 seconds", "two videos", "slow motion",
// "no text"); the rest, tidied up, becomes the description. Plain rules: free and instant.

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20 };
const toNumber = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBERS[w.toLowerCase()]);
const LEAD = String.raw`(?:(?:,|\band\b|\bwith\b|\bto\b|\bon\b|\bin\b|\bfor\b|\busing\b|\buse\b|\bplay(?:ing)?\b|\badd\b|\bput\b|\bmake(?:\s+it)?\b|\bset\b|\bat\b|\bthe\b)\s*)*`;
const CUE = /\b(?:to|with|using|use|play(?:ing)?|add|put|song|music|track|tune|sound)\b/i;
// [song, how it may be heard, needs a cue like "to" or "song" (the name is also an everyday phrase)]
const SONG_WORDS = [
  ['Monkeys Spinning Monkeys', String.raw`monkeys?\s+spinning\s+monkeys?|spinning\s+monkeys?`, false],
  ['Sneaky Snitch', String.raw`sneaky\s+(?:snitch(?:es)?|snatch|switch)`, false],
  ['Fluffing a Duck', String.raw`fluff(?:ing|in)?\s+(?:a|the)\s+duck`, false],
  ['Scheming Weasel faster', String.raw`scheming\s+weasel`, false],
  ['Pixel Peeker Polka - faster', String.raw`pixel\s+peek(?:er|a)(?:\s+polka)?`, false],
  ['Investigations', String.raw`investigations?`, true],
  ['Local Forecast - Elevator', String.raw`local\s+forecast|elevator\s+(?:music|song)`, false],
  ['Run Amok', String.raw`run(?:ning)?\s+amok`, false],
  ['Carefree', String.raw`care\s?free`, true],
  ['Wallpaper', String.raw`wall\s?paper`, true],
  ['Hitman', String.raw`hit\s?man`, true],
  ['Spazzmatica Polka', String.raw`spaz+\s?matica(?:\s+polka)?`, false],
  ['Hall of the Mountain King', String.raw`(?:hall\s+of\s+the\s+)?mountain\s+king`, false],
  ['Quirky Dog', String.raw`quirky\s+dog`, true],
  ['Kool Kats', String.raw`(?:kool|cool)\s+(?:kats|cats)`, true],
  ['Life of Riley', String.raw`life\s+of\s+(?:riley|reilly|rily)`, false],
];
// The style a description sounds like, most specific first (used only while Style is still Random).
const STYLE_WORDS = [
  ['twerk', /\btwerk/i],
  ['honest', /\bmoment of honesty\b|\bhonest(?:y|ly)?\b|\bguilty\b|\bcaught (?:him|her|it|red[- ]handed)\b|\bside[- ]?eye/i],
  ['walk', /\bwalk(?:s|ing|ed)?\s+(?:like\s+a\s+(?:human|person|man|woman|boss|model)|upright|on\s+(?:its|his|her|two)\s+(?:hind\s+)?legs)\b|\bcatwalk\b|\brunway\b/i],
  ['fight', /\b(?:fight\w*|boxing|boxer|karate|kung[- ]?fu|punch\w*|kicks?|kicking|wrestl\w*|ninja)\b/i],
  ['sassy', /\b(?:sassy|sass|attitude|diva|drama queen|unbothered|hair flip)\b/i],
  ['star', /\b(?:rock ?star|superstar|famous|celebrity|red carpet|on stage|concert|sing(?:s|ing|er)?|rap(?:s|ping|per)?|guitar|drums?|microphone)\b/i],
  ['dance', /\b(?:danc\w*|moonwalk\w*|groov\w*|hip[- ]?hop|salsa|ballet)\b/i],
  ['fail', /\b(?:fail\w*|falls?|falling|fell|slips?|slipping|slipped|trips?|tripping|tripped|faceplant\w*)\b/i],
];
const STYLE_NAMES = String.raw`twerk(?:ing)?|danc(?:e|ing)|walk(?:ing)?|fight(?:ing)?|fail|sassy|star|honest(?:y)?|moment\s+of\s+honesty|random`;

// My songs by name: "with Detstvo", "to the song Детство", "play my song". A name is matched as said, and in
// Latin letters (speech in English writes "Detstvo" for Детство); the title after " - " (no artist) works too.
const CYRILLIC = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const toLatin = (t) => t.toLowerCase().replace(/[а-яё]/g, (c) => CYRILLIC[c] ?? c);
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function songNames(name) {
  const words = (t) => t.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const forms = new Set();
  for (const t of [name, toLatin(name)]) {
    for (const part of [t, t.split(/\s[-–—]\s/).pop()]) {
      const w = words(part || '');
      if (w.length >= 3) forms.add(w);
    }
  }
  return [...forms].sort((a, b) => b.length - a.length).map((f) => f.split(' ').map(escapeRe).join(String.raw`\s+`));
}

// The saved song an order names, with where it was said: { id, index, length }, or null.
function songOrder(text) {
  if (!songsOn() || !state.songs.length) return null;
  const B = String.raw`(?<![\p{L}\p{N}])`;
  const E = String.raw`(?![\p{L}\p{N}])`;
  const cue = String.raw`(?:to|with|using|use|play(?:ing)?|put|add)\s+`;
  const kind = String.raw`(?:song|music|track|tune)`;
  for (const s of state.songs) {
    for (const name of songNames(s.name)) {
      const re = new RegExp(String.raw`${B}(?:${cue}(?:(?:the|my)\s+)?(?:${kind}\s+(?:called\s+)?)?|(?:(?:the|my)\s+)?${kind}\s+(?:called\s+)?)(?:${name})${E}(?:\s+${kind}${E})?`, 'iu');
      const m = re.exec(text);
      if (m) return { id: s.id, index: m.index, length: m[0].length };
    }
  }
  const mine = new RegExp(String.raw`${B}(?:${cue})?my\s+(?:own\s+|saved\s+)?${kind}${E}`, 'iu').exec(text);
  if (!mine) return null;
  const pick = defaultSong() || state.songs[0];
  return { id: pick.id, index: mine.index, length: mine[0].length };
}

function styleFromName(name) {
  const n = name.toLowerCase();
  if (n.startsWith('twerk')) return 'twerk';
  if (n.startsWith('danc')) return 'dance';
  if (n.startsWith('walk')) return 'walk';
  if (n.startsWith('fight')) return 'fight';
  if (n.startsWith('honest') || n.startsWith('moment')) return 'honest';
  return ['fail', 'sassy', 'star', 'random'].includes(n) ? n : null;
}

// Reads orders out of what was said. Returns { text: the tidied description, orders, labels }.
// together: Together is on there, so scene and look words count too (together.js).
function understand(said, currentStyle, together = false) {
  let text = ` ${said} `;
  const orders = {};
  const take = (pattern, fn) => {
    // a "please" right after an order goes with it ("no ending please")
    const re = new RegExp(`${LEAD}\\b(?:${pattern})\\b(?:[\\s,]+please\\b)?`, 'gi');
    text = text.replace(re, (whole, ...groups) => (fn(whole, ...groups) === false ? whole : ' '));
  };
  for (const [song, heardAs, needsCue] of SONG_WORDS) {
    if (orders.track) break;
    take(String.raw`(?:(?:the\s+)?(?:song|music|track|tune)\s+(?:called\s+)?)?(?:the\s+)?(?:${heardAs})(?:\s+(?:song|music|track|tune))?`, (whole) => {
      if (needsCue && !CUE.test(whole)) return false;
      orders.music = 'track';
      orders.track = song;
      return true;
    });
  }
  if (!orders.track) { // one of My songs ("with my song", "with Detstvo")
    const said = songOrder(text);
    if (said) {
      orders.music = 'mysong';
      orders.songId = said.id;
      text = `${text.slice(0, said.index)} ${text.slice(said.index + said.length)}`;
    }
  }
  // The extras (before the music: "no sound effects" is not "no sound").
  const no = String.raw`(?:no|without(?:\s+(?:any|a|an|the))?|skip(?:\s+the)?)\s+`;
  const effects = String.raw`(?:(?:meme|sound|funny)\s+)?(?:effects|fx)`;
  take(String.raw`${no}${effects}|${no}zoom(?:s|ing)?|turn\s+off\s+(?:the\s+)?${effects}`, () => { orders.meme = false; });
  // ("the cat makes sound effects" is a description: only "meme effects" counts without "with")
  take(String.raw`(?:with|add|turn\s+on)\s+(?:the\s+|some\s+)?${effects}|meme\s+effects`, () => { orders.meme = true; });
  const ending = String.raw`(?:ending|outro|end\s*card|end\s+screen)`;
  take(String.raw`${no}(?:follow(?:[\s-]+me)?\s+)?${ending}`, () => { orders.outro = false; });
  take(String.raw`(?:(?:a|an|the)\s+)?follow(?:[\s-]+me)?\s+${ending}|(?:with|add)\s+(?:a\s+|an\s+|the\s+)?${ending}`, () => { orders.outro = true; });
  const opening = String.raw`real(?:[\s-]+(?:to|2)[\s-]+a\.?\s?i\.?)?\s+(?:start|opening|intro)`;
  take(`${no}${opening}`, () => { orders.opening = false; });
  take(String.raw`(?:(?:a|an|the)\s+)?${opening}|real[\s-]+(?:to|2)[\s-]+a\.?\s?i\b\.?|start\s+with\s+the\s+real\s+(?:video|clip|one)`, () => { orders.opening = true; });
  // The pet voice: "no voice", "in a deep voice", "squeaky voice", "with a narrator", "with a pet voice".
  // ("the cat raises its voice" is a description: a voice word alone isn't an order)
  const kinds = String.raw`squeaky|squeaking|chipmunk|high[\s-]?pitched|deep|low|narrator|documentary`;
  const voiceKind = (w) => (/^(?:deep|low)/i.test(w) ? 'deep' : /^(?:narrator|documentary)/i.test(w) ? 'narrator' : 'squeaky');
  take(String.raw`${no}(?:(?:pet|funny|talking|${kinds})\s+)?voices?(?:[\s-]?over)?|(?:turn\s+off|mute)\s+(?:the\s+)?(?:pet\s+)?voice|voice\s+off`, () => { orders.voice = 'off'; });
  take(String.raw`(?:(?:a|an|the)\s+)?(${kinds})\s+(?:pet\s+|talking\s+)?voice|(?:the\s+)?(?:pet\s+)?voice\s+(?:is\s+|to\s+)?(${kinds})`, (whole, a, b) => { orders.voice = voiceKind(a || b); });
  take(String.raw`(?:with|add|use|using)\s+(?:a\s+|the\s+)?narrator`, () => { orders.voice = 'narrator'; });
  take(String.raw`(?:with|add|turn\s+on|give\s+(?:it|him|her|them|(?:the|my)\s+[a-z]+))\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:(?:pet|funny|talking)\s+)?voice(?:[\s-]?over)?|(?:(?:a|the)\s+)?(?:pet|funny|talking)\s+voice|voice\s+on`, () => { orders.voice = 'on'; });
  take(String.raw`(?:no|without(?:\s+any)?)\s+(?:music|song|sound)`, () => { orders.music = 'none'; });
  take(String.raw`(?:keep|use|with)\s+(?:the\s+|my\s+|its\s+)?(?:own|original)\s+sound|original\s+sound`, () => { orders.music = 'mine'; });
  take(String.raw`(?:make|give\s+me|create|do)?\s*(\d|one|two|three|four|five)\s+(?:different\s+)?(?:videos?|versions?|variations?|takes)`, (whole, n) => {
    const v = toNumber(n);
    orders.count = v >= 5 ? 5 : v === 4 ? 3 : v;
  });
  take(String.raw`(\d{1,2}|five|ten|fifteen|twenty)[\s-]*(?:sec(?:ond)?s?|s)(?:\s+long)?`, (whole, n) => {
    const v = toNumber(n);
    orders.clips = v <= 7 ? 1 : v <= 12 ? 2 : 3;
  });
  take(String.raw`(?:in\s+)?slow[\s-]?mo(?:tion)?`, () => { orders.speed = 'slow'; });
  take(String.raw`sped\s+up|speed\s+(?:it\s+)?up|(?:in\s+)?fast[\s-]?(?:motion|forward)|double\s+speed`, () => { orders.speed = 'fast'; });
  take(String.raw`(?:normal|regular)\s+speed`, () => { orders.speed = 'normal'; });
  take(String.raw`(?:no|without(?:\s+any)?)\s+(?:text|captions?|words|subtitles|writing)`, () => { orders.captions = false; });
  take(String.raw`with\s+(?:text|captions?|subtitles)`, () => { orders.captions = true; });
  take(String.raw`(?:full|final|finished)\s+(?:video|version)s?|(?:no|skip(?:\s+the)?|without(?:\s+a)?)\s+preview`, () => { orders.preview = false; });
  take(String.raw`(?:a\s+)?(?:quick\s+)?previews?(?:\s+first)?`, () => { orders.preview = true; });
  take(String.raw`(?:in\s+)?(?:the\s+)?(${STYLE_NAMES})\s+style|style\s+(?:is\s+|to\s+)?(${STYLE_NAMES})`, (whole, a, b) => {
    const style = styleFromName(a || b || '');
    if (!style) return false;
    orders.style = style;
    return true;
  });
  // Together: "make them dance together", "VS screen", "free version", "one by one" (scene and look)
  if (together && window.Together) Together.understand(take, orders, said);

  // Tidy what's left: chit-chat and filler words go, the description stays.
  text = text
    .replace(/\b(?:um+|uh+|erm+|hmm+)\b[,.]?/gi, ' ')
    .replace(/\b(?:you know|i mean|basically|literally)\b,?/gi, ' ')
    .replace(/\b(is|was|and|so|just)\s+like,?\s+/gi, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|so|hey|hi|alright|all right|right|well|yeah|yes|now|please)\b[,.!]?\s*)+/i, '')
    .replace(/^(?:i\s+(?:want|need|would\s+like|wanna\s+see)|i'?d\s+like)\s+((?:the|my|a|an|this|our|his|her)\s+[\w-]+(?:\s+[\w-]+)?)\s+to\s+/i, '$1 ')
    .replace(/^(?:(?:i\s+(?:want|need)(?:\s+you)?\s+to|i'?d\s+like(?:\s+you)?\s+to|(?:can|could|would|will)\s+you(?:\s+please)?|please|let'?s|we'?ll|we\s+will|i'?ll|i\s+will)\s+)?(?:make|create|do|generate|show|give)\s+(?:me\s+)?(?:(?:a|an|some|one)\s+)?(?:(?:funny|cute|cool|new|short)\s+)*(?:(?:videos?|clips?|tiktoks?|memes?)\b\s*)?/i, '')
    .replace(/^(?:(?:of|where|with|about|showing|that\s+shows|in\s+which|and|then|also)\s+)+/i, '');
  for (let i = 0; i < 3; i++) {
    text = text
      .replace(/\s+([,.!?;:])/g, '$1')
      .replace(/([,;:])\s*([,.;:])/g, '$2')
      .replace(/([.!?])[\s.!?,;:]*[.!?,;:]/g, '$1')
      .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '')
      .replace(/(?:^|\s)(?:and|with|to|then|also|for|in|on|at|use|using|make|it)$/i, '')
      .replace(/^(?:and|with|then|also)\s+/i, '')
      .trim();
  }
  if (text) text = text[0].toUpperCase() + text.slice(1);

  if (!together && !orders.style && (currentStyle || 'random') === 'random') { // (Together: no styles)
    const found = STYLE_WORDS.find(([, re]) => re.test(text));
    if (found) orders.style = found[0];
  }
  return { text, orders };
}

function orderLabels(o, target) {
  const labels = [];
  if (o.style) labels.push(STYLES.find((x) => x.key === o.style).label);
  if (o.music === 'track') labels.push(songLabel(o.track));
  if (o.music === 'mysong') labels.push((mySong(o.songId) || { name: 'My song' }).name);
  if (o.music === 'none') labels.push('No music');
  if (o.music === 'mine') labels.push("Your video's sound");
  if (o.clips) labels.push(`${o.clips * 5} sec`);
  if (target === 'main' && o.count) labels.push(o.count === 1 ? '1 video' : `${o.count} videos`);
  if (o.speed) labels.push({ slow: 'Slow-mo', fast: 'Fast', normal: 'Normal speed' }[o.speed]);
  if (o.captions === false) labels.push('No text');
  if (o.captions === true) labels.push('Text on');
  if (target === 'main' && o.preview === false) labels.push('Full video');
  if (target === 'main' && o.preview === true) labels.push('Quick preview');
  if (o.voice && extraOrderFits('voice', target)) labels.push(o.voice === 'off' ? 'No voice' : voiceName(o.voice));
  for (const [key, on, off] of EXTRA_ORDERS) {
    if (o[key] !== undefined && extraOrderFits(key, target)) labels.push(o[key] ? on : off);
  }
  return labels;
}

// Spoken extras: [key, label when on, label when off, its switch in the editor]. (The pet voice is a
// word, not on/off: orders.voice is 'off', 'on' (the voice picked last) or a voice.)
const EXTRA_ORDERS = [['meme', 'Meme effects', 'No effects', 'editMeme'], ['opening', 'Real start', 'No real start', 'editOpening'],
  ['outro', 'Follow me ending', 'No ending', 'editOutro']];

// A spoken extra counts only where its switch shows (the worker makes it; the ending is the owner's;
// in the editor, this video can have it).
function extraOrderFits(key, target) {
  if (target === 'edit') return !$(`#${EDIT_EXTRAS.find((x) => x[0] === key)[2]}`).hidden;
  return canDo(key) && !(key === 'outro' && isGuest());
}

// Sets the options; returns a function that puts them back.
function applyOrders(o, target) {
  const extras = EXTRA_ORDERS.filter(([key]) => o[key] !== undefined && extraOrderFits(key, target));
  const voice = o.voice && extraOrderFits('voice', target) ? o.voice : null;
  if (target === 'edit') {
    const sel = $('#editMusic');
    const before = { style: edit.style, len: edit.len, speed: edit.speed, music: sel.value, captions: $('#editCaptions').checked,
      voice: edit.voice, voiceOn: $('#editVoice').checked };
    const switchesBefore = extras.map(([, , , id]) => [id, $(`#${id}`).checked]);
    if (o.style) edit.style = o.style;
    if (o.clips) edit.len = o.clips;
    if (o.speed) edit.speed = o.speed;
    if (o.captions !== undefined) $('#editCaptions').checked = o.captions;
    for (const [key, , , id] of extras) $(`#${id}`).checked = o[key];
    if (voice) {
      $('#editVoice').checked = voice !== 'off';
      if (VOICE_PICKS.includes(voice)) edit.voice = voice;
    }
    const want = o.music === 'track' ? `track:${o.track}` : o.music === 'mysong' ? `song:${o.songId}` : o.music;
    if (want && [...sel.options].some((x) => x.value === want)) sel.value = want;
    loadEditSongDuration();
    renderEditor();
    return () => {
      Object.assign(edit, { style: before.style, len: before.len, speed: before.speed });
      sel.value = before.music;
      $('#editCaptions').checked = before.captions;
      for (const [id, checked] of switchesBefore) $(`#${id}`).checked = checked;
      if (voice) {
        edit.voice = before.voice;
        $('#editVoice').checked = before.voiceOn;
      }
      renderEditor();
    };
  }
  const keys = ['style', 'music', 'track', 'clips', 'count', 'speed', 'captions', 'preview', 'songId'];
  const before = Object.fromEntries(keys.map((k) => [k, state[k]]));
  const pickedBefore = state.musicPicked;
  const extrasBefore = { ...state.extras };
  const set = (k, v) => {
    state[k] = v;
    save(KEYS[k], v);
  };
  if (o.style) set('style', o.style);
  if (o.music) {
    set('music', o.music);
    state.musicPicked = true;
  }
  if (o.songId) set('songId', o.songId);
  if (o.track) set('track', o.track);
  if (o.clips) set('clips', o.clips);
  if (o.count) set('count', o.count);
  if (o.speed) set('speed', o.speed);
  if (o.captions !== undefined) set('captions', o.captions);
  if (o.preview !== undefined) set('preview', o.preview);
  if (extras.length || voice) {
    for (const [key] of extras) state.extras[key] = o[key];
    if (VOICE_PICKS.includes(voice)) state.extras.voicePick = voice;
    if (voice) state.extras.voice = voice === 'off' ? 'off' : state.extras.voicePick;
    save(KEYS.extras, state.extras);
  }
  if (o.music || o.track) songChanged();
  renderOptions();
  return () => {
    keys.forEach((k) => set(k, before[k]));
    state.musicPicked = pickedBefore;
    if (extras.length || voice) {
      state.extras = extrasBefore;
      save(KEYS.extras, state.extras);
    }
    songChanged();
    renderOptions();
  };
}

// After speaking: apply the orders, tidy the words, and say what was understood (with Undo).
function heard(box, before, said) {
  const target = box.id === 'editIdea' ? 'edit' : 'main';
  const together = Boolean(window.Together && Together.spoken(target)); // Together: scene and look words
  const { text, orders } = understand(said, target === 'edit' ? edit.style : state.style, together);
  const labels = [...(together ? Together.labels(orders, target) : []), ...orderLabels(orders, target)];
  const undoOptions = applyOrders(orders, target);
  const undoTogether = together ? Together.applyOrders(orders, target) : () => {};
  const piece = before.trim() && text ? text[0].toLowerCase() + text.slice(1) : text; // adding to what's there
  typed(box, piece ? joinText(before, piece, box.maxLength) : before);
  const line = document.getElementById(`${box.id}Heard`);
  if (!line) return;
  line.hidden = !labels.length;
  $('.heard-text', line).textContent = `Got it: ${labels.join(' · ')}`;
  $('.heard-undo', line).onclick = () => {
    undoOptions();
    undoTogether();
    typed(box, joinText(before, said, box.maxLength));
    line.hidden = true;
  };
}

// ---------- Home Screen app + "your video is ready" ----------
// antics can live on the Home Screen (manifest.json + sw.js). When a video is ready, an open app chimes,
// buzzes and counts it in the title and on the icon. With notifications on, the phone also gets one when
// antics is closed (Web Push: the worker sends it through the browser's own free push service). Only
// workers that list 'push' in /health "features" can send them.

const APP_TITLE = document.title;
const pings = {
  reg: null, // the service worker
  started: false, // registering the service worker has finished (or failed)
  key: null, // the worker's push key, fetched ahead so a tap goes straight to the permission prompt
  keyAsked: false,
  on: false, // this phone gets notifications from the current worker
  synced: '', // which worker this phone's notifications were last checked with
  syncing: false,
  seen: null, // ready videos already announced (null until the first list arrives)
  unseen: 0, // got ready while antics was in the background
  install: null, // Chrome's own "Add to Home Screen" prompt, when it offers one
  audio: null,
};

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const workerPings = () => canDo('push');
// iPhone Safari in a tab: notifications only work in the Home Screen app.
const iosTab = () => isIOS() && !standalone() && !pushReady();
const pingTarget = () => (state.worker ? `${state.worker.url} ${state.worker.key} ${workerPings()}` : '');
const bytesB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
const subKey = (sub) => {
  try {
    return bytesB64url(sub.options.applicationServerKey);
  } catch {
    return ''; // this browser doesn't say which key: assume it's ours
  }
};
const jsonPost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function startApp() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // offered as a button in Settings instead
    pings.install = e;
    renderPings();
  });
  window.addEventListener('appinstalled', () => {
    pings.install = null;
    renderPings();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'antics-ready') { // (a video is ready, or it's time to post one)
        refreshJobs();
        loadPlan();
      }
      if (msg.type === 'antics-open') openFromLink(msg.url);
    });
    try {
      pings.reg = await navigator.serviceWorker.register('sw.js');
    } catch {
      // no offline copy and no notifications; everything else still works
    }
  }
  pings.started = true;
  syncPings();
}

async function pushKey() {
  if (pings.key) return pings.key;
  const asked = state.worker;
  const { key } = await api('/push/key');
  if (state.worker === asked) pings.key = key;
  return key;
}

// Keeps this phone's notifications pointed at the current worker (after an update, an invite, a new key).
// Checked once per worker, after /health; tried again on the next refresh while the worker sleeps.
async function syncPings() {
  const target = pingTarget();
  if (pings.syncing || !pings.started || !state.health || !target || pings.synced === target) return;
  pings.syncing = true;
  try {
    let on = false;
    if (workerPings() && pings.reg && pushReady() && Notification.permission === 'granted') {
      const sub = await pings.reg.pushManager.getSubscription();
      if (sub && [await pushKey(), ''].includes(subKey(sub))) {
        await api('/push/subscribe', jsonPost(sub));
        on = true;
      }
    }
    if (pingTarget() === target) {
      pings.on = on;
      pings.synced = target;
    }
  } catch {
    // an older or sleeping worker: tried again on the next refresh
  } finally {
    pings.syncing = false;
    renderPings();
  }
}

// Another worker or invite on this phone: its notifications are set up again.
function resetPings() {
  pings.key = null;
  pings.keyAsked = false;
  pings.on = false;
  pings.synced = '';
  pings.seen = null;
}

async function turnOnPings() {
  save(KEYS.pingAsked, true);
  if (!pushReady()) {
    toast(iosTab() ? 'On iPhone, notifications work in the Home Screen app. Settings shows how.'
      : "This browser can't show notifications. Try Chrome.");
    renderPings();
    return;
  }
  if (!workerPings()) {
    toast(isGuest() ? `Ask ${hostName()} to update antics first.` : 'Update your worker first (Settings), then turn notifications on.');
    return;
  }
  try {
    // Safari only asks for permission when subscribe() comes straight from the tap, so the key and the
    // service worker are ready ahead (renderPings, startApp) and nothing else is awaited before it then.
    const key = pings.key || (await pushKey());
    const reg = pings.reg || (await navigator.serviceWorker.ready);
    let sub = null;
    if (Notification.permission === 'granted') { // allowed before: there may be a subscription already
      sub = await reg.pushManager.getSubscription();
      if (sub && ![key, ''].includes(subKey(sub))) {
        await sub.unsubscribe(); // made for another worker
        sub = null;
      }
    }
    // This asks for permission (the browser's own prompt) when it wasn't given yet.
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(key) });
    await api('/push/subscribe', jsonPost(sub));
    pings.on = true;
    pings.synced = pingTarget();
    loadPlan(); // (the posting plan stops asking for notifications)
    toast("Done. You'll get a notification when a video is ready.");
  } catch (e) {
    toast(Notification.permission === 'denied'
      ? 'Notifications are blocked for antics. Allow them in the browser settings, then try again.'
      : e.waking ? 'Your worker is waking up. Try again in a minute.' : `Couldn't turn notifications on: ${e.message}`);
  }
  renderPings();
}

// worker: the one to tell (Leave and Disconnect pass the one this phone is leaving).
async function turnOffPings(worker = state.worker) {
  try {
    const sub = pings.reg && (await pings.reg.pushManager.getSubscription());
    if (sub) {
      if (worker) {
        await fetch(`${worker.url}/push/unsubscribe`, {
          ...jsonPost({ endpoint: sub.endpoint }),
          headers: { 'Content-Type': 'application/json', 'X-Antics-Key': worker.key },
        }).catch(() => {});
      }
      await sub.unsubscribe();
    }
  } catch {
    // already off
  }
  if (state.worker === worker) {
    pings.on = false;
    loadPlan();
  }
  renderPings();
}

async function testPing() {
  try {
    const res = await api('/push/test', { method: 'POST' });
    toast(res.sent ? 'Test sent. It shows up in a few seconds.' : 'It didn’t arrive. Turn notifications off and on again.');
  } catch (e) {
    toast(e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message);
  }
}

async function installApp() {
  const ask = pings.install;
  if (!ask) return;
  ask.prompt();
  await ask.userChoice.catch(() => {});
  pings.install = null;
  renderPings();
}

// iPhone Safari: the nudge's "Show me how" opens the Home Screen steps in Settings.
function showAppSteps() {
  save(KEYS.pingAsked, true);
  openSettings();
  $('#appBox').scrollIntoView({ block: 'center' });
}

// Settings (notifications, the Home Screen app and its link) and the nudge under Your videos.
function renderPings() {
  const blocked = pushReady() && Notification.permission === 'denied';
  const can = pushReady() && workerPings();
  const ios = iosTab();
  const owner = Boolean(state.worker) && !isGuest();
  const inSettings = Boolean(state.worker) && $('#setupPane').hidden; // not while setting up or updating
  const touch = matchMedia('(pointer: coarse)').matches; // a phone or tablet, not a computer
  // Notifications: only with a worker that can send them
  $('#pingBox').hidden = !(inSettings && workerPings());
  const chip = $('#pingState');
  chip.textContent = pings.on ? 'on' : blocked ? 'blocked' : 'off';
  chip.classList.toggle('on', pings.on);
  $('#pingBtn').textContent = pings.on ? 'Turn off' : 'Turn on';
  $('#pingBtn').hidden = !can || (blocked && !pings.on);
  $('#pingTest').hidden = !pings.on;
  $('#pingRow').hidden = $('#pingBtn').hidden && $('#pingTest').hidden;
  $('#pingHelp').textContent = ios ? 'On iPhone, notifications work in the Home Screen app. The steps are below.'
    : blocked ? 'Notifications are blocked for antics. Allow them in the browser settings.'
      : !pushReady() ? "This browser can't show notifications."
        : `A notification on this ${touch ? 'phone' : 'computer'} when a video is ready, even when antics is closed.`;
  // The Home Screen app: how to add it, and the link that connects it (in the browser, not in the app)
  const tab = !standalone();
  $('#appSteps').hidden = !(tab && isIOS());
  $('#appStepCopy').textContent = owner ? 'Copy app link' : 'Copy my invite link';
  $('#installBtn').hidden = !pings.install;
  $('#installBtn').textContent = touch ? '📲 Add to Home Screen' : 'Install the app';
  $('#installHelp').hidden = !tab || isIOS() || Boolean(pings.install);
  $('#installHelp').textContent = touch ? 'Put antics on your Home Screen: open the browser menu, then Add to Home screen or Install app.'
    : 'Install antics as an app: open the browser menu, then Install app.';
  $('#copyAppLink').hidden = !(tab && owner && state.worker.space);
  $('#copyInvite').hidden = !(tab && isGuest());
  $('#appLinkHelp').hidden = $('#copyAppLink').hidden && $('#copyInvite').hidden;
  $('#appLinkHelp').textContent = owner ? 'Keep it private: anyone with this link can use your antics.'
    : 'Paste it in the Home Screen app, or open it on another phone.';
  $('#appBox').hidden = !inSettings || (!tab && !pings.install);
  // The nudge, while one of your videos is being made: once, until you answer it
  const mine = (j) => isGuest() || !j.owner || j.owner === 'me';
  const busy = state.jobs.some((j) => ['queued', 'working', 'waiting'].includes(j.status) && mine(j));
  const offer = workerPings() && !pings.on && !blocked && (can || ios);
  $('#pingNudge').hidden = !(busy && offer && !load(KEYS.pingAsked, false));
  $('#pingNudgeText').textContent = ios
    ? "🔔 Want a notification when it's ready? On iPhone, that needs antics on your Home Screen."
    : "🔔 Get a notification when it's ready? Then you can close antics.";
  $('#pingNudgeBtn').textContent = ios ? 'Show me how' : 'Yes, notify me';
  if (can && !blocked && state.worker && !pings.key && !pings.keyAsked) { // ahead of the tap
    pings.keyAsked = true;
    pushKey().catch(() => { pings.keyAsked = false; });
  }
}

// A video that just got ready: a chime, a buzz, and a count in the title and on the app icon.
function announceReady(jobs) {
  const mine = jobs.filter((j) => j.status === 'done' && (isGuest() || !j.owner || j.owner === 'me'));
  const keys = mine.map((j) => `${j.id}:${j.rev || 0}`);
  if (!pings.seen) {
    pings.seen = new Set(keys); // ready before antics opened: nothing to announce
    return;
  }
  const fresh = mine.filter((j, i) => !pings.seen.has(keys[i]));
  keys.forEach((k) => pings.seen.add(k));
  if (!fresh.length) return;
  chime();
  // Phones only allow a buzz after a tap on the page.
  if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([90, 60, 90]);
  if (document.hidden) {
    pings.unseen += fresh.length;
    document.title = `(${pings.unseen}) Ready · ${APP_TITLE}`;
    if (navigator.setAppBadge) navigator.setAppBadge(pings.unseen).catch(() => {});
  } else if (!anyDialogOpen()) {
    toast(fresh.length > 1 ? `${fresh.length} videos are ready` : `${fresh[0].draft ? 'Your preview' : 'Your video'} is ready. Tap it to watch.`);
  }
}

function clearReady() {
  pings.unseen = 0;
  document.title = APP_TITLE;
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
}

// Sound needs a tap first on phones: Make it, Finish and Show new version unlock it for the chime later.
function unlockSound() {
  try {
    pings.audio = pings.audio || new (window.AudioContext || window.webkitAudioContext)();
    if (pings.audio.state === 'suspended') pings.audio.resume().catch(() => {});
  } catch {
    // no sound: the toast and the badge still show
  }
}

function chime() {
  const ctx = pings.audio;
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  [[880, 0], [1320, 0.14]].forEach(([freq, at]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + at);
    gain.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + at);
    osc.stop(t + at + 0.4);
  });
}

// index.html#video=<id>, from a notification: open that video once the list is loaded. A posting reminder links to
// index.html#post=<plan item> (the Post screen) or index.html#plan (the posting plan): they open once the plan is in.
function openFromLink(url, refresh = true) {
  const text = String(url || '');
  const toPost = text.match(/#post=([\w-]+)/);
  if (toPost || /#plan$/.test(text)) {
    if (toPost) state.openPost = toPost[1];
    else state.openPlan = true;
    if (/^#(?:post=|plan$)/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    if (refresh) loadPlan();
    return;
  }
  const m = text.match(/#video=([\w-]+)/);
  if (!m) return;
  state.openVideo = m[1];
  if (location.hash.startsWith('#video=')) history.replaceState(null, '', location.pathname + location.search);
  if (refresh && state.worker) refreshJobs();
}

function showLinked(jobs) {
  const id = state.openVideo;
  if (!id) return;
  state.openVideo = null;
  const job = jobs.find((j) => j.id === id);
  if (!job) toast('That video is gone.');
  else if (job.has_video) {
    [...document.querySelectorAll('dialog')].forEach((d) => d.open && closeDialog(d));
    openPlayer(job);
  }
}

// ---------- Settings ----------

function openUpdate() {
  state.setupMode = 'update';
  state.updateAnyway = false;
  openSettings();
}

function openSettings() {
  renderSettings();
  note($('#setupNote'), state.pending ? 'One quick setup first, then your video starts by itself.' : '');
  openDialog($('#settings'));
  if (state.worker && !isGuest()) loadFriends();
  if (state.worker && !isGuest() && canDo('songs')) loadSongs();
  if (canPlan()) {
    syncPlanTz(); // (the times are for where this phone is)
    loadPlan();
  }
}

let friendsChanged = 0; // a list fetched before the latest change is out of date

async function loadFriends() {
  const asked = friendsChanged;
  try {
    const { guests } = await api('/guests');
    if (asked !== friendsChanged) return;
    state.guests = guests;
    note($('#friendNote'), '');
  } catch (e) {
    state.guests = state.guests || [];
    if (e.waking) note($('#friendNote'), 'Your worker is waking up. Your friends show up in a moment.');
  }
  renderFriends();
}

function renderFriends() {
  const list = $('#friendList');
  list.innerHTML = '';
  const outdated = Boolean(state.health && !(Number(state.health.version) >= 7)); // friends came with v7
  $('#friendAdd').hidden = outdated;
  if (outdated) {
    note($('#friendNote'), 'Update your worker first (the button above) to invite friends.');
    return;
  }
  const guests = state.guests || [];
  $('#friendsCount').textContent = guests.length ? `${guests.length} invited` : '';
  for (const g of guests) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const who = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = g.name;
    who.append(name, document.createTextNode(` · ${g.uses_left} of ${g.uses_left + g.used} left`));
    const acts = document.createElement('div');
    acts.className = 'acts';
    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `plain ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    acts.append(
      btn(navigator.share ? 'Send link' : 'Copy link', '', () => sendInvite(g)),
      btn('+5 videos', '', () => addUses(g, 5)),
      btn('Remove', 'danger', () => removeFriend(g)),
    );
    row.append(who, acts);
    list.appendChild(row);
  }
}

async function sendInvite(g) {
  const url = inviteLink(g);
  if (navigator.share) {
    try {
      await navigator.share({ title: `${BRAND.name} antics`, text: `Make funny animal videos with my antics app. ${g.uses_left} videos are yours:`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyText(url);
}

async function addFriend() {
  const name = $('#friendName').value.trim();
  if (!name) {
    note($('#friendNote'), "Type your friend's name first.", 'bad');
    $('#friendName').focus();
    return;
  }
  const btn = $('#addFriend');
  btn.disabled = true;
  try {
    const form = new FormData();
    form.append('name', name);
    form.append('uses', String(state.friendUses));
    form.append('host', BRAND.name);
    const g = await api('/guests', { method: 'POST', body: form });
    friendsChanged++;
    state.guests = [...(state.guests || []), g];
    $('#friendName').value = '';
    renderFriends();
    note($('#friendNote'), `${g.name}'s link is ready with ${g.uses_left} videos. Tap ${navigator.share ? 'Send link' : 'Copy link'} next to their name.`, 'good');
  } catch (e) {
    note($('#friendNote'), e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function addUses(g, n) {
  try {
    const form = new FormData();
    form.append('add', String(n));
    const updated = await api(`/guests/${g.id}`, { method: 'POST', body: form });
    friendsChanged++;
    state.guests = (state.guests || []).map((x) => (x.id === g.id ? updated : x));
    renderFriends();
    toast(`${g.name} now has ${updated.uses_left} videos left`);
  } catch (e) {
    toast(e.message);
  }
}

async function removeFriend(g) {
  if (!confirm(`Remove ${g.name}? Their link stops working. Videos they made stay in your list.`)) return;
  try {
    await api(`/guests/${g.id}`, { method: 'DELETE' });
    friendsChanged++;
    state.guests = (state.guests || []).filter((x) => x.id !== g.id);
    renderFriends();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Settings: My songs ----------
// Add a song: pick a file, it uploads and the worker finds its meme part (about 10-20 s). Then hear it, move it
// (the worker puts it on the beat when saved), name it, and choose whether every new video gets it.

const songAdd = { busy: false, song: null }; // the song being added (saved already, with the part found)
// The worker's reasons for each good place to start, as short chip labels.
const WHY = { chorus: 'chorus', 'catchy part': 'catchy', 'chorus again': 'again', 'same part, softer': 'softer',
  'another catchy part': 'other part', 'loudest part': 'loudest', 'start of the song': 'start' };

function renderSongsBox() {
  const show = Boolean(state.worker) && !isGuest() && canDo('songs');
  $('#songsBox').hidden = !show;
  if (!show) return;
  const songs = state.songs || [];
  $('#songsCount').textContent = songs.length ? `${songs.length} of ${SONG_MAX}` : '';
  $('#songAddBtn').hidden = songAdd.busy || songs.length >= SONG_MAX;
  const list = $('#songRows');
  list.innerHTML = '';
  for (const s of songs) {
    const row = document.createElement('div');
    row.className = 'friend-row song-row';
    const who = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = s.name;
    who.append(name, document.createTextNode(` · from ${clock(s.start || 0)}`));
    if (s.default) {
      const tag = document.createElement('span');
      tag.className = 'song-tag';
      tag.textContent = 'every video';
      who.append(' ', tag);
    }
    const acts = document.createElement('div');
    acts.className = 'acts';
    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `plain ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    acts.append(songHearButton(s, 'plain'), btn('Rename', '', () => renameSong(s)));
    if (!s.default) acts.append(btn('Set default', '', () => setDefaultSong(s)));
    acts.append(btn('Delete', 'danger', () => deleteSong(s)));
    row.append(who, acts);
    list.appendChild(row);
  }
}

async function addSong(file) {
  if (!file || !state.worker || isGuest()) return;
  if (!$('#settings').open) openSettings();
  const noteEl = $('#songsNote');
  if ((state.songs || []).length >= SONG_MAX) {
    note(noteEl, `You can keep ${SONG_MAX} songs. Delete one to add another.`, 'bad');
    return;
  }
  if (file.size > SONG_MB * 1024 * 1024) {
    note(noteEl, `That file is over ${SONG_MB} MB. Try a shorter one, or an MP3.`, 'bad');
    return;
  }
  note(noteEl, '');
  songAdd.busy = true;
  songAdd.song = null;
  $('#songAdd').hidden = false;
  $('#songAddBody').hidden = true;
  $('#songAddHead').textContent = 'Finding the meme part… (about 20 s)';
  renderSongsBox();
  $('#songAdd').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('name', songNameFrom(file));
    const song = await api('/songs', { method: 'POST', body: form });
    songsAsked++; // (a list fetched meanwhile is out of date)
    state.songs = [...(state.songs || []).filter((x) => x.id !== song.id), song];
    songAdd.song = song;
    showSongPanel(song);
  } catch (e) {
    $('#songAdd').hidden = true;
    note(noteEl, e.waking ? 'Your worker is waking up (up to a minute). Try again then.' : e.message, 'bad');
  } finally {
    songAdd.busy = false;
    $('#songAddFile').value = '';
    $('#addSongFile').value = '';
    renderSongsBox();
    renderOptions();
  }
}

// The song just added: where its meme part was found, ▶ Hear, a slider and a few other good places to start.
function showSongPanel(song) {
  $('#songAddHead').textContent = `Meme part found at ${clock(song.start)}`;
  $('#songAddBody').hidden = false;
  const range = $('#songAddStart');
  range.max = String(Math.max(1, Math.floor((song.duration || 180) - 1)));
  setSongAddStart(song.start);
  $('#songAddLength').textContent = song.duration ? `of ${clock(song.duration)}` : '';
  $('#songAddName').value = song.name;
  $('#songAddDefault').checked = true;
  const hear = $('#songAddHear');
  hear.dataset.song = song.id;
  hear.dataset.label = 'Hear';
  renderSongButton(hear);
  const cands = $('#songAddCands');
  cands.innerHTML = '';
  for (const c of (song.candidates || []).slice(0, 4)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${clock(c.start)} ${WHY[c.why] || c.why}`;
    b.dataset.start = String(c.start);
    b.addEventListener('click', () => {
      setSongAddStart(c.start);
      hearSong(song.id, c.start);
    });
    cands.appendChild(b);
  }
  cands.hidden = cands.children.length < 2;
}

function setSongAddStart(t) {
  $('#songAddStart').value = String(t);
  $('#songAddStartLabel').textContent = clock(Number($('#songAddStart').value));
  document.querySelectorAll('#songAddCands button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.start) - Number($('#songAddStart').value)) < 0.05));
  });
}

async function saveSongPanel() {
  const song = songAdd.song;
  if (!song) return;
  const btn = $('#songAddSave');
  btn.disabled = true;
  try {
    const form = new FormData();
    form.append('name', $('#songAddName').value.trim() || song.name);
    form.append('start', $('#songAddStart').value);
    form.append('default', String($('#songAddDefault').checked));
    const saved = await api(`/songs/${song.id}`, { method: 'POST', body: form });
    preview.pause();
    songAdd.song = null;
    $('#songAdd').hidden = true;
    if (saved.default) pickSong(saved.id); // new videos get it
    await loadSongs();
    toast(`Saved. Videos with ${saved.name} start at ${clock(saved.start)}.`);
  } catch (e) {
    note($('#songsNote'), e.waking ? 'Your worker is waking up. Try Save again in a moment.' : e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function changeSong(s, fields, done) {
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    const saved = await api(`/songs/${s.id}`, { method: 'POST', body: form });
    await loadSongs();
    if (done) toast(done(saved));
    return saved;
  } catch (e) {
    toast(e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message);
    return null;
  }
}

async function renameSong(s) {
  const name = (prompt('Song name', s.name) || '').trim();
  if (!name || name === s.name) return;
  await changeSong(s, { name }, (saved) => `Renamed to ${saved.name}`);
}

async function setDefaultSong(s) {
  const saved = await changeSong(s, { default: true }, (x) => `New videos get ${x.name}`);
  if (saved) pickSong(saved.id);
}

async function deleteSong(s) {
  if (!confirm(`Delete ${s.name}? Videos already made keep their sound.`)) return;
  try {
    await api(`/songs/${s.id}`, { method: 'DELETE' });
    if (previewing === `song:${s.id}`) preview.pause();
    if (songAdd.song && songAdd.song.id === s.id) {
      songAdd.song = null;
      $('#songAdd').hidden = true;
    }
    songsAsked++;
    state.songs = (state.songs || []).filter((x) => x.id !== s.id);
    settleSongChoice();
    renderSongsBox();
    renderOptions();
    loadSongs();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Posting plan ----------
// The owner's plan for TikTok (workers that list 'plan'). Finished videos wait in line; at 1–3 times a day (in the
// owner's time zone) the worker sends a reminder for the next one. The Post screen has its caption with hashtags
// ready and shares the video to TikTok in one tap. A video with one of the owner's own songs goes as its "TikTok
// cut": the same video without the song (TikTok mutes songs it has no rights to), and the screen says which
// TikTok sound to add. Friends and older workers see none of it.

const DEFAULT_TIMES = ['12:30', '18:30', '21:00'];
const MAX_TAGS = 15;
const canPlan = () => Boolean(state.worker) && !isGuest() && canDo('plan');
const planItem = (pid) => (state.plan && state.plan.queue.find((i) => i.id === pid)) || null;
const planOf = (jobId) => (state.plan && state.plan.queue.find((i) => i.job === jobId)) || null;

function deviceTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

let planSeq = 0; // every plan call gets a number: only the newest answer is shown
let planChain = Promise.resolve(); // plan calls go one after the other, in the order they were made

// Sends a plan call once the ones before it are done, and shows the plan it answers with. Returns that plan, or
// null on trouble (said in a toast unless quiet; then the page loads what the worker has).
function planCall(path, opts = {}, quiet = false) {
  const asked = state.worker;
  const n = ++planSeq;
  const run = planChain.then(async () => {
    if (state.worker !== asked) return null;
    const stop = new AbortController(); // (a call stuck on a bad connection doesn't hold up the ones after it)
    const timer = setTimeout(() => stop.abort(), 25000);
    try {
      const body = await api(path, { ...opts, signal: stop.signal });
      if (state.worker === asked && n === planSeq) setPlan(body);
      return body;
    } catch (e) {
      if (quiet) return null;
      toast(e.waking ? 'Your worker is waking up. Try again in a minute.'
        : e.name === 'AbortError' || e instanceof TypeError ? "Couldn't reach your worker. Check the internet and try again." : e.message);
      if (state.worker === asked && n === planSeq) loadPlan();
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  planChain = run;
  return run;
}

// The plan as the worker has it (quietly: when it sleeps, the next check tries again).
const loadPlan = () => (canPlan() ? planCall('/plan', {}, true) : Promise.resolve(null));

function setPlan(body) {
  if (!body || !body.plan || !Array.isArray(body.queue)) return;
  state.plan = body;
  state.planAt = Date.now();
  renderJobs(); // (+ Plan or 📅 In plan on the cards, and the strip)
  renderPlanBox();
  renderPost();
  showLinkedPost();
  if (state.openPlan) {
    state.openPlan = false;
    openPlanBox();
  }
  syncPlanTz();
}

// Another worker (or one without the plan): nothing of the plan shows.
function resetPlan() {
  const had = Boolean(state.plan);
  state.plan = null;
  state.planAt = 0;
  state.openPost = null;
  state.openPlan = false;
  planSeq++; // (an answer still on its way belongs to the worker before)
  planTzSent = '';
  if ($('#postDialog').open) closeDialog($('#postDialog'));
  renderPlanBox();
  if (had) renderJobs();
  else renderPlanStrip();
}

// ---------- Posting plan: times ----------

// Times as this phone shows them (12 or 24 hours, like the time boxes), in English words and digits.
const clock12 = (() => {
  try {
    return ['h11', 'h12'].includes(new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hourCycle);
  } catch {
    return false;
  }
})();
const localTime = (date, tz) => new Intl.DateTimeFormat(clock12 ? 'en-US' : 'en-GB',
  { timeZone: tz, hour: clock12 ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: clock12 ? 'h12' : 'h23' })
  .format(date).replace(/\s(?=[AP]M$)/, '\u00a0'); // ("7:15 PM" stays on one line)

function tzUsable(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

// The plan's time zone for showing times (the phone's own when it is unknown here).
const planTz = () => {
  const tz = state.plan && state.plan.plan.tz;
  return tz && tzUsable(tz) ? tz : undefined;
};

// Days since 1970 of a moment, on the calendar of a time zone.
function localDay(seconds, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(seconds * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000);
}

// A slot as the plan shows it: "Today 18:30", "Tomorrow 12:30", "Thu 12:30" (lower: "today 18:30").
function whenLabel(seconds, lower = false) {
  const tz = planTz();
  const date = new Date(seconds * 1000);
  const days = localDay(seconds, tz) - localDay(Date.now() / 1000, tz);
  const near = { '-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow' }[days];
  const day = near || new Intl.DateTimeFormat('en-GB', days > 1 && days < 7 ? { timeZone: tz, weekday: 'short' }
    : { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  return `${near && lower ? day.toLowerCase() : day} ${localTime(date, tz)}`;
}

// "Asia/Riyadh" -> "Riyadh"
const tzName = (tz) => (!tz || tz === 'UTC' ? 'UTC' : tz.split('/').pop().replace(/_/g, ' '));

// ---------- Posting plan: the strip above Your videos ----------

function renderPlanStrip() {
  const strip = $('#planStrip');
  const body = canPlan() ? state.plan : null;
  const queue = body ? body.queue : [];
  strip.hidden = !body || (!body.plan.on && !queue.length);
  if (strip.hidden) return;
  const ready = queue.filter((i) => i.status === 'reminded');
  const waiting = queue.filter((i) => i.status === 'waiting');
  let text;
  let act = '';
  if (ready.length) {
    text = `📅 ${ready.length} video${ready.length === 1 ? '' : 's'} ready to post`;
    act = 'post';
  } else if (!body.plan.on) {
    text = '📅 Posting plan is off';
    act = 'on';
  } else if (waiting.length) {
    const at = waiting[0].at || (body.next || [])[0];
    text = `📅 Next post: ${at ? whenLabel(at, true) : 'soon'} · ${waiting.length} waiting`;
  } else {
    text = '📅 Your posting plan is empty · Add videos with + Plan';
  }
  $('#planStripMain').textContent = text;
  const btn = $('#planStripAct');
  btn.hidden = !act;
  btn.dataset.act = act;
  btn.textContent = { post: 'Post now', on: 'Turn on' }[act] || '';
  strip.classList.toggle('ready', ready.length > 0);
}

function planStripAct() {
  const ready = state.plan && state.plan.queue.find((i) => i.status === 'reminded');
  if ($('#planStripAct').dataset.act === 'post' && ready) openPost(ready.id);
  else setPlanOn(true);
}

// ---------- Posting plan: the box in Settings ----------

function openPlanBox() {
  if (!canPlan()) return;
  if (!$('#settings').open) openSettings();
  const box = $('#planBox');
  if (!box.hidden) box.scrollIntoView({ block: 'start' });
}

function renderPlanBox() {
  const box = $('#planBox');
  const body = canPlan() ? state.plan : null;
  box.hidden = !body;
  if (!body) return;
  const plan = body.plan;
  const first = body.queue.find((i) => i.status === 'waiting');
  $('#planOn').checked = Boolean(plan.on);
  $('#planState').textContent = !plan.on ? 'Off' : first && first.at ? `On · next reminder ${whenLabel(first.at, true)}` : 'On';
  // The reminders come as notifications: without them, the plan can't remind anyone.
  $('#planNotify').hidden = Boolean(body.notify) || pings.on || !(plan.on || body.queue.length);
  setSeg('planPerDay', plan.per_day);
  renderPlanTimes(plan);
  const tz = planTz();
  $('#planTz').textContent = body.tz_ok === false
    ? "Your worker can't read time zones yet, so the times are in UTC."
    : `Times are for ${tzName(tz || deviceTz())} time (now ${localTime(new Date(), tz)}).`;
  renderPlanTags(plan);
  renderPlanQueue(body);
}

// One time input for each post of the day ("Post 1 [12:30]").
function renderPlanTimes(plan, force = false) {
  const box = $('#planTimes');
  const times = planTimesShown(plan);
  if (box.children.length !== times.length) {
    box.innerHTML = '';
    times.forEach((t, i) => {
      const row = document.createElement('label');
      row.className = 'opt-line';
      const name = document.createElement('span');
      name.textContent = `Post ${i + 1}`;
      const input = document.createElement('input');
      input.type = 'time';
      input.className = 'small-input plan-time';
      input.addEventListener('change', savePlanTimes);
      row.append(name, input);
      box.appendChild(row);
    });
  }
  box.querySelectorAll('input').forEach((input, i) => {
    if (force || document.activeElement !== input) input.value = times[i];
  });
}

// The times in use: the first per_day of the plan's times (a missing one gets a free usual time).
function planTimesShown(plan) {
  const times = (plan.times || []).slice(0, plan.per_day);
  for (const t of DEFAULT_TIMES) if (times.length < plan.per_day && !times.includes(t)) times.push(t);
  return times;
}

function savePlanTimes() {
  const plan = state.plan && state.plan.plan;
  if (!plan) return;
  const times = [...document.querySelectorAll('#planTimes input')].map((i) => i.value.slice(0, 5));
  const fine = times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  if (!fine || new Set(times).size < times.length) {
    if (fine) toast('Pick a different time for each post');
    renderPlanTimes(plan, true); // (back to the times saved)
    return;
  }
  planCall('/plan', jsonPost({ times }));
}

function setPerDay(n) {
  const plan = state.plan && state.plan.plan;
  if (!plan || plan.per_day === n) return;
  setSeg('planPerDay', n);
  const times = (plan.times || []).slice(0, 3);
  for (const t of [...DEFAULT_TIMES, '09:00', '15:00']) if (times.length < n && !times.includes(t)) times.push(t);
  planCall('/plan', jsonPost({ per_day: n, times }));
}

async function setPlanOn(on) {
  const tz = deviceTz();
  const sendTz = Boolean(on && tz);
  if (sendTz) planTzSent = tz;
  // (the times are for where this phone is: its time zone goes along. A worker that can't read that time zone
  // keeps its own, and the plan still goes on.)
  const body = (sendTz && await planCall('/plan', jsonPost({ on: true, tz }), true)) || await planCall('/plan', jsonPost({ on }));
  if (!body) {
    renderPlanBox(); // (the switch goes back)
    return;
  }
  if (!on) {
    toast('Posting plan off. Your videos stay in it.');
    return;
  }
  const first = body.queue.find((i) => i.status === 'waiting');
  toast(first && first.at ? `Posting plan on. First reminder ${whenLabel(first.at, true)}.`
    : 'Posting plan on. Add videos with + Plan.');
}

let planTzSent = ''; // the time zone this page sent (once a visit: a worker that can't use it isn't asked again)

// When the plan box is open and the worker's time zone isn't this phone's, the phone's goes to the worker.
function syncPlanTz() {
  const tz = deviceTz();
  const plan = state.plan && state.plan.plan;
  if (!plan || !tz || plan.tz === tz || planTzSent === tz || !$('#settings').open || $('#planBox').hidden) return;
  planTzSent = tz;
  planCall('/plan', jsonPost({ tz }), true);
}

function renderPlanTags(plan) {
  const box = $('#planTags');
  const tags = plan.tags || [];
  box.innerHTML = '';
  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const name = document.createElement('span');
    name.textContent = tag;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', `Remove ${tag}`);
    x.addEventListener('click', () => {
      const now = state.plan ? state.plan.plan.tags || [] : []; // (as it is now: an earlier ✕ may still be on its way)
      if (now.includes(tag)) setPlanTags(now.filter((t) => t !== tag));
    });
    chip.append(name, x);
    box.appendChild(chip);
  }
  const fixed = tags.slice(0, plan.fixed || 0);
  const always = fixed.length ? ` ${fixed.join(' ')} ${fixed.length === 1 ? 'is' : 'are'} always there, the rest change each time.`
    : ' They change each time.';
  $('#planTagHelp').textContent = `Up to ${plan.per_post} per video.${always}`;
  $('#planTagAdd').disabled = tags.length >= MAX_TAGS;
}

// The hashtags change here at once, then on the worker (its answer is shown once the calls before it are back).
function setPlanTags(tags) {
  state.plan.plan.tags = tags;
  renderPlanTags(state.plan.plan);
  planCall('/plan', jsonPost({ tags }));
}

// The typed hashtags (one or more, with or without #) join the list.
function addPlanTags() {
  const plan = state.plan && state.plan.plan;
  const input = $('#planTagInput');
  if (!plan) return;
  const tags = [...(plan.tags || [])];
  const have = new Set(tags.map((t) => t.toLowerCase()));
  let added = 0;
  let twice = 0;
  for (const word of input.value.split(/[\s,]+/)) {
    const tag = `#${word.replace(/[^\p{L}\p{N}\p{M}_]/gu, '')}`; // (like TikTok: letters, numbers and _ only)
    if (tag.length < 2 || [...tag].length > 50) continue;
    if (have.has(tag.toLowerCase())) {
      twice++;
      continue;
    }
    have.add(tag.toLowerCase());
    tags.push(tag);
    added++;
  }
  if (!added) {
    toast(!input.value.trim() ? 'Type a hashtag first, like #catsoftiktok'
      : twice ? 'That hashtag is already there' : 'A hashtag has letters, numbers and _ only (up to 50)');
    return;
  }
  if (tags.length > MAX_TAGS) {
    toast(`You can keep up to ${MAX_TAGS} hashtags. Remove one first.`);
    return;
  }
  input.value = '';
  setPlanTags(tags);
}

function renderPlanQueue(body) {
  const list = $('#planQueue');
  const queue = body.queue;
  list.innerHTML = '';
  $('#planQueueHead').textContent = queue.length ? `Up next (${queue.length})` : 'Up next';
  $('#planEmpty').hidden = queue.length > 0;
  queue.forEach((item, i) => {
    // [picture] Its name (tap: the Post screen)
    //           Today 18:30            ▲ ▼ ✕
    const row = document.createElement('div');
    row.className = `plan-item${item.status === 'reminded' ? ' ready' : ''}`;
    row.dataset.pid = item.id;
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'plan-thumb';
    thumb.setAttribute('aria-label', `Post ${item.label || 'this video'}`);
    if (item.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = workerFile(item.thumb);
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
    }
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'plan-name';
    name.textContent = item.label || 'Video';
    const when = document.createElement('span');
    when.className = 'plan-when';
    when.textContent = itemWhen(item);
    for (const b of [thumb, name]) b.addEventListener('click', () => openPost(item.id));
    const acts = document.createElement('div');
    acts.className = 'plan-acts';
    const btn = (label, aria, fn, off, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.setAttribute('aria-label', aria);
      b.disabled = off;
      b.addEventListener('click', fn);
      return b;
    };
    acts.append(
      btn('▲', 'Move up', () => movePlanItem(item.id, -1), i === 0),
      btn('▼', 'Move down', () => movePlanItem(item.id, 1), i === queue.length - 1),
      btn('✕', 'Take out of the plan', () => removePlanItem(item.id), false, 'del'),
    );
    row.append(thumb, name, when, acts);
    list.appendChild(row);
  });
  const until = body.plan.on && body.lasts_until && queue.length;
  $('#planUntil').hidden = !until;
  if (until) $('#planUntil').textContent = `Enough videos until ${whenLabel(body.lasts_until, true)}.`;
  const missed = (body.missed || []).length;
  $('#planMissed').hidden = !missed;
  $('#planMissed').textContent = `Missed while your worker slept: ${missed}`;
  // The last few done: ✓ posted / skipped
  const done = [...(body.history || [])].sort((a, b) => (b.done_at || 0) - (a.done_at || 0)).slice(0, 3);
  const box = $('#planDone');
  box.hidden = !done.length;
  box.innerHTML = '';
  for (const h of done) {
    const line = document.createElement('p');
    line.className = `plan-done-item ${h.status}`;
    line.textContent = `${h.status === 'posted' ? '✓ Posted' : 'Skipped'} · ${h.label || 'Video'}`;
    box.appendChild(line);
  }
}

function itemWhen(item) {
  const by = item.by ? ` · by ${item.by}` : '';
  if (item.status === 'reminded') return `Ready to post${by}`;
  return `${item.at ? whenLabel(item.at) : 'Waiting (the plan is off)'}${by}`;
}

// A file of the worker by its path ("/jobs/<id>/thumb"), with the key.
function workerFile(path) {
  const w = state.worker;
  const url = /^https?:\/\//.test(path) ? path : `${w.url}${path.startsWith('/') ? '' : '/'}${path}`;
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(w.key)}`;
}

// ▲ ▼: the line changes here at once (each place keeps its time), then on the worker.
function movePlanItem(pid, step) {
  const queue = state.plan ? state.plan.queue : [];
  const i = queue.findIndex((x) => x.id === pid);
  const j = i + step;
  if (i < 0 || j < 0 || j >= queue.length) return;
  [queue[i], queue[j]] = [queue[j], queue[i]];
  if (queue[i].status === 'waiting' && queue[j].status === 'waiting') [queue[i].at, queue[j].at] = [queue[j].at, queue[i].at];
  renderJobs();
  renderPlanBox();
  planCall('/plan/queue/order', jsonPost({ ids: queue.map((x) => x.id) }));
}

async function removePlanItem(pid) {
  if (await planCall(`/plan/queue/${pid}`, { method: 'DELETE' })) toast('Taken out of your posting plan');
}

const adding = new Set(); // videos + Plan is being sent for (a second tap is one too many)

async function addToPlan(job) {
  if (adding.has(job.id)) return;
  adding.add(job.id);
  let body = null;
  try {
    body = await planCall('/plan/queue', jsonPost({ jobs: [job.id], where: 'end' }));
  } finally {
    adding.delete(job.id);
  }
  if (!body) return;
  if (!body.plan.on && !load(KEYS.planAsked, false)) { // the first time: where to turn it on
    save(KEYS.planAsked, true);
    openPlanBox();
  }
  toast('Added to your posting plan');
}

// ---------- Posting plan: the Post screen ----------
// The video (its TikTok cut when that is the choice), the caption, and three big numbered steps. The video file is
// fetched when the screen opens, so "Share to TikTok" opens the share sheet straight from the tap.

const post = { pid: null, src: '', blob: null, blobUrl: '', tries: 0, failed: false, save: false, shared: false, timer: null, shown: null };

function openPost(pid) {
  if (!planItem(pid)) {
    toast('That video is no longer in your posting plan.');
    return;
  }
  const dlg = $('#postDialog');
  if (post.pid !== pid) clearPost();
  post.pid = pid;
  post.save = !canShareFiles();
  if (!dlg.open) openDialog(dlg);
  dlg.scrollTop = 0;
  renderPost();
  $('#postVideo').play().catch(() => {});
}

// A reminder's #post=<item>, once the plan is in.
function showLinkedPost() {
  const pid = state.openPost;
  if (!pid || !state.plan) return;
  state.openPost = null;
  if (planItem(pid)) {
    [...document.querySelectorAll('dialog')].forEach((d) => d.open && d.id !== 'postDialog' && closeDialog(d));
    openPost(pid);
    return;
  }
  const done = (state.plan.history || []).find((h) => h.id === pid);
  toast(!done ? 'That video is no longer in your posting plan.'
    : done.status === 'posted' ? 'You posted that one already.' : 'You skipped that one.');
}

function clearPost() {
  clearTimeout(post.timer);
  if (post.blobUrl) URL.revokeObjectURL(post.blobUrl);
  Object.assign(post, { pid: null, src: '', blob: null, blobUrl: '', tries: 0, failed: false, shared: false, timer: null, shown: null });
  const video = $('#postVideo');
  video.pause();
  video.removeAttribute('src');
  delete video.dataset.src;
  video.load();
}

function canShareFiles() {
  try {
    return Boolean(navigator.share && navigator.canShare
      && navigator.canShare({ files: [new File([new Uint8Array(8)], 'antics.mp4', { type: 'video/mp4' })] }));
  } catch {
    return false;
  }
}

// The worker couldn't make the TikTok cut of this version (it tries again after an edit or a restart): the Post
// screen then has the video as it was made, so it can still be posted.
const cutFailed = (item) => item.audio === 'no_song' && !item.cut_ready && Boolean(item.cut_failed);

// The video for TikTok: the cut without the song (audio 'no_song'), or the video as it was made.
function postVideoUrl(item, cut) {
  const w = state.worker;
  const job = state.jobs.find((j) => j.id === item.job);
  const v = cut ? `cut${item.cut_rev ?? ''}` : job ? job.rev ?? 0 : `plan${item.cut_rev ?? ''}`;
  return `${w.url}/jobs/${item.job}/video?key=${encodeURIComponent(w.key)}${cut ? '&cut=tiktok' : ''}&v=${v}`;
}

function renderPost() {
  if (!post.pid) return;
  const dlg = $('#postDialog');
  const item = planItem(post.pid);
  if (!item) { // posted, skipped or taken out (maybe on another phone)
    if (dlg.open) closeDialog(dlg);
    return;
  }
  const job = state.jobs.find((j) => j.id === item.job);
  $('#postSub').textContent = [item.label, item.by && `by ${item.by}`].filter(Boolean).join(' · ');
  const cut = item.audio === 'no_song' && Boolean(item.cut_ready); // (shared without the song)
  const failed = cutFailed(item); // (the cut couldn't be made: the video as it was made instead)
  const ready = item.audio !== 'no_song' || cut || failed;
  $('#postWait').hidden = ready;
  $('#postVideo').hidden = !ready;
  $('#postCutNote').hidden = !(cut && item.song); // (so a missing song doesn't look like a mistake)
  $('#postCutFail').hidden = !failed;
  setPostVideo(ready ? postVideoUrl(item, cut) : '');
  const poster = item.thumb ? workerFile(item.thumb) : '';
  if ($('#postVideo').getAttribute('poster') !== poster) $('#postVideo').setAttribute('poster', poster);
  $('#postSongLine').hidden = failed || !(item.song || (job && ['mysong', 'upload'].includes(job.music)));
  $('#postSongOpt').checked = item.audio === 'as_made';
  // The caption: the worker's, unless it is being changed here and not saved yet.
  const ta = $('#postCaption');
  if (post.shown === null || ta.value === post.shown) {
    ta.value = item.caption || '';
    post.shown = ta.value;
  }
  $('#postReset').hidden = !item.custom;
  renderPostSteps(item, ready);
  pollCut(item);
}

// The video is downloaded once: the file fetched for the share sheet is also the one that plays (data-src: the
// worker address it came from). Until it is in, the video's picture shows.
function setPostVideo(src) {
  if (src === post.src) return;
  if (post.blobUrl) URL.revokeObjectURL(post.blobUrl);
  Object.assign(post, { src, blob: null, blobUrl: '', tries: 0, failed: false });
  const video = $('#postVideo');
  video.dataset.src = src;
  video.removeAttribute('src');
  video.load();
  if (src) fetchPostVideo(src);
}

// The fetched file plays (or, when it couldn't be fetched or played here, the video from the worker).
function playPostVideo(fromWorker = false) {
  const video = $('#postVideo');
  const src = fromWorker || !post.blob ? post.src : postBlobUrl();
  if (!src || video.getAttribute('src') === src) return;
  video.src = src;
  if ($('#postDialog').open) video.play().catch(() => {});
}

// The file for the share sheet. A miss is tried again a few times (4 s apart), then "Save video" opens it instead.
function fetchPostVideo(src) {
  fetch(src)
    .then((r) => (r.ok ? r.blob() : null))
    .catch(() => null)
    .then((blob) => {
      if (post.src !== src) return;
      if (blob) {
        post.blob = blob.type ? blob : blob.slice(0, blob.size, 'video/mp4');
        post.tries = 0;
        playPostVideo();
      } else if (++post.tries < 4) {
        setTimeout(() => {
          if (post.src === src && $('#postDialog').open) fetchPostVideo(src);
        }, 4000);
      } else {
        post.failed = true;
        playPostVideo(true);
      }
      const item = planItem(post.pid);
      if (item) renderPostSteps(item, true);
    });
}

const postBlobUrl = () => {
  if (!post.blobUrl && post.blob) post.blobUrl = URL.createObjectURL(post.blob);
  return post.blobUrl;
};

// Step 2 (Share to TikTok, or Save video where sharing a file can't work) and the checklist for TikTok.
function renderPostSteps(item, ready) {
  const save = post.save || post.failed;
  const share = $('#postShare');
  share.hidden = save;
  share.disabled = !ready || !post.blob;
  share.textContent = ready && !post.blob ? '2 · Getting the video…' : '2 · Share to TikTok';
  const link = $('#postSave');
  link.hidden = !save;
  const href = ready ? (post.blob ? postBlobUrl() : post.src) : '';
  if (href) link.href = href;
  else link.removeAttribute('href');
  link.classList.toggle('off', !href);
  $('#postAltLine').hidden = save || !post.blob;
  $('#postDone').classList.toggle('next', post.shared);
  const list = $('#postList');
  list.textContent = '';
  const line = (...pieces) => {
    const li = document.createElement('li');
    for (const [text, bold] of pieces) {
      const el = bold ? document.createElement('b') : document.createTextNode(text);
      if (bold) el.textContent = text;
      li.appendChild(el);
    }
    list.appendChild(li);
  };
  if (save) line(['Open TikTok, tap '], ['+', true], [', then '], ['Upload', true], [' and pick the video']);
  line(['Paste the caption']);
  const song = item.song && !cutFailed(item) ? item.song : null;
  const named = song && song.name && song.name !== 'your song'; // (an uploaded song without a name: the same one)
  if (named) line(['Add sound: '], [song.name, true], [` — start at ${clock(song.start || 0)}`]);
  else if (song) line(['Add sound: '], ['the same song', true], [` from TikTok's sounds — start at ${clock(song.start || 0)}`]);
  // Together: the clips' credits are in the caption, and a free look of real videos needs no AI label (together.js)
  const job = state.jobs.find((j) => j.id === item.job);
  if (!(job && job.kind === 'together' && window.Together && Together.tip(job, line))) {
    line(['More options → '], ['AI-generated content: ON', true]);
  }
  line(['Post']);
}

// While the TikTok cut is being made: look again every 4 s.
function pollCut(item) {
  clearTimeout(post.timer);
  if (!$('#postDialog').open || item.audio !== 'no_song' || item.cut_ready || cutFailed(item)) return;
  post.timer = setTimeout(() => loadPlan().then(() => {
    const now = planItem(post.pid);
    if (now) pollCut(now);
  }), 4000);
}

async function sharePost() {
  const blob = post.blob;
  if (!blob) return;
  const file = new File([blob], 'antics.mp4', { type: 'video/mp4' });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
    post.save = true;
  } else {
    try {
      await navigator.share({ files: [file] });
      post.shared = true; // step 3 next
    } catch (e) {
      if (e.name === 'AbortError') return;
      post.save = true;
      toast("Sharing didn't work here. Save the video, then post it in TikTok.");
    }
  }
  const item = planItem(post.pid);
  if (item) renderPostSteps(item, true);
}

function savePostVideo() {
  const href = post.blob ? postBlobUrl() : post.src;
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = 'antics.mp4';
  $('#postDialog').appendChild(a);
  a.click();
  a.remove();
}

// The caption box: a change is saved when you leave the box. Both of the item's choices go along every time, as
// this screen has them, so the worker ends up with exactly what is shown.
function savePostCaption() {
  const item = planItem(post.pid);
  const ta = $('#postCaption');
  if (!item) return;
  const text = ta.value.trim();
  post.shown = ta.value;
  if (text === (item.caption || '').trim()) return;
  if (text) Object.assign(item, { caption: text, custom: true });
  else item.custom = false; // (empty: the automatic caption again)
  $('#postReset').hidden = !item.custom;
  planCall(`/plan/queue/${item.id}`, jsonPost({ caption: text || null, audio: item.audio }));
}

function resetPostCaption() {
  const item = planItem(post.pid);
  if (!item) return;
  item.custom = false;
  post.shown = $('#postCaption').value; // (the automatic caption takes its place when the worker answers)
  $('#postReset').hidden = true;
  planCall(`/plan/queue/${item.id}`, jsonPost({ caption: null, audio: item.audio }));
}

function setPostAudio(withSong) {
  const item = planItem(post.pid);
  if (!item) return;
  item.audio = withSong ? 'as_made' : 'no_song';
  planCall(`/plan/queue/${item.id}`, jsonPost({ caption: item.custom ? item.caption : null, audio: item.audio }));
}

let finishing = ''; // the video "I posted it" or "Skip this one" is being sent for (a second tap waits for it)

async function finishPost(result) {
  const item = planItem(post.pid);
  if (!item || finishing) return;
  finishing = item.id;
  const buttons = [$('#postDone'), $('#postSkip')];
  buttons.forEach((b) => { b.disabled = true; });
  let body = null;
  try {
    body = await planCall(`/plan/queue/${item.id}/done`, jsonPost({ result }));
  } finally {
    finishing = '';
    buttons.forEach((b) => { b.disabled = false; });
  }
  if (!body) return;
  if (post.pid === item.id) closeDialog($('#postDialog'));
  toast(result === 'posted' ? 'Nice! Marked as posted.' : 'Skipped. The next video is up.');
}

async function refreshHealth() {
  const asked = state.worker;
  let health;
  try {
    const res = await fetch(`${asked.url}/health`);
    health = await res.json();
  } catch {
    return; // asleep or offline: keep the last known state
  }
  if (state.worker !== asked) return; // a link put another worker here meanwhile: its own answer is on the way
  state.health = health;
  if (!canDo('songs')) state.songs = null;
  else if (!state.songs) loadSongs();
  if (!canPlan()) resetPlan();
  else if (!state.plan) loadPlan();
  renderPc();
  renderOptions(); // (the song tiles show or go with the worker's 'songs')
  renderSongsBox();
  renderExtras();
  renderMake();
  renderPings();
  syncPings();
}

// The GPU guard (workers with 'gpu', owner only): the free AI time left today in Settings, and a red banner with
// Resume when the worker stopped all AI work because Hugging Face started charging credits.
const gpuInfo = () => (state.worker && !isGuest() && canDo('gpu') && state.health.gpu) || null;

// The quota can't be read: the worker makes no AI calls on an account that could be charged ('key': the key can't
// read it; 'down': Hugging Face didn't answer); a free account goes on, estimated.
const GPU_BLIND = {
  key: "Your Hugging Face key can't read your free AI time, so antics makes no AI clips (it never risks your credits). "
    + 'Make a new key with Write (step 2), then Update my worker with it.',
  down: "Your free AI time can't be checked right now, so AI clips wait. They go on by themselves.",
  estimated: "Your key can't read your free AI time, so antics only estimates it.",
};

function renderGpu() {
  const g = gpuInfo();
  const billed = Boolean(g && g.alert === 'billed');
  $('#gpuBanner').hidden = !billed;
  $('#gpuAlert').hidden = !billed;
  const line = $('#gpuLine');
  const numbers = Boolean(g && g.readable && Number.isFinite(g.left) && Number.isFinite(g.base) && g.base > 0);
  const blind = Boolean(g && !g.readable && g.blind && !g.key_refused) ? (g.estimated ? 'estimated' : g.blind) : '';
  line.classList.toggle('bad', Boolean(blind) && blind !== 'estimated');
  line.hidden = !numbers && !GPU_BLIND[blind];
  if (!numbers) {
    line.textContent = GPU_BLIND[blind] || '';
    return;
  }
  const left = Math.max(0, Math.floor(g.left / 60));
  const base = Math.round(g.base / 60);
  const resets = g.resets_at
    ? `\u00a0· resets ${new Date(g.resets_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  line.textContent = `Free AI time today: ${Math.min(left, base)} of ${base} min left${resets}`;
}

let resuming = false;
async function resumeGpu() {
  if (resuming) return;
  resuming = true;
  const buttons = [$('#gpuResume'), $('#gpuResumeMain')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const body = await api('/gpu/resume', { method: 'POST' });
    if (state.health && body.gpu) state.health.gpu = body.gpu;
    renderGpu();
    toast('AI work is back on (only within your free time).');
    refreshJobs();
  } catch (e) {
    toast(e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message);
  } finally {
    resuming = false;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function renderPc() {
  renderGpu();
  const h = state.health;
  if (isGuest()) {
    $('#pcChip').hidden = true;
    $('#updateBanner').hidden = true;
    return;
  }
  const pcOn = Boolean(h && h.pc);
  const pcState = $('#pcState');
  pcState.textContent = pcOn ? `on · ${h.pc_name || 'PC'}` : 'off or not connected';
  pcState.classList.toggle('on', pcOn);
  $('#pcChip').hidden = !pcOn;
  const broken = keyBroken();
  const outdated = Boolean(state.worker && h && h.version !== WORKER_VERSION);
  $('#updateNote').hidden = !(outdated || broken);
  $('#updateBanner').hidden = !(outdated || broken);
  $('#updateText').textContent = broken
    ? "Your worker's Hugging Face key stopped working, so videos can't be made. Paste a new Write key to fix it."
    : 'A new version of antics is ready, with more options.';
}

async function getPairCode() {
  const btn = $('#pairBtn');
  btn.disabled = true;
  try {
    const { code } = await api('/pc/pair-code', { method: 'POST' });
    $('#pairUser').textContent = state.worker.space.split('/')[0];
    $('#pairCode').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    $('#pairBox').hidden = false;
  } catch (e) {
    toast(e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderSettings() {
  const guest = isGuest();
  $('#guestPane').hidden = !guest;
  $('#setupLinkLine').hidden = !(standalone() && !state.worker); // the Home Screen app: the link is quicker
  // Notifications and the Home Screen app sit near the top: the owner's after the worker line, a friend's
  // before Leave this invite.
  if (guest) $('#guestPane').insertBefore($('#appBoxes'), $('#guestPane > .row'));
  else $('#optionsPane').insertBefore($('#appBoxes'), $('#optionsPane > .friends-box'));
  if (guest) {
    $('#setupPane').hidden = true;
    $('#optionsPane').hidden = true;
    const me = state.me;
    const host = hostName();
    $('#guestInfo').textContent = me
      ? `${host} gave you ${me.uses_left + me.used} videos. ${me.uses_left} left.`
      : `You're using ${host}'s antics.`;
    $('#guestFine').textContent = `Your videos are made on ${host}'s free worker, and only you and ${host} can see them. Ask ${host} if you need more.`;
    renderPings();
    return;
  }
  const updating = state.setupMode === 'update' && Boolean(state.worker);
  const ready = Boolean(state.worker) && !updating;
  $('#setupPane').hidden = ready;
  $('#optionsPane').hidden = !ready;
  $('#setupTitle').textContent = updating ? 'Update your worker' : 'One-time setup';
  const rebuild = updating && keyBroken();
  $('#setupIntro').textContent = rebuild
    ? 'Paste a new Hugging Face Write key. Your worker is made again with this key and the newest version (2–5 min). Your videos and connections are kept.'
    : updating
      ? 'Paste a Hugging Face Write key. Your worker gets the newest version (2–5 min). Nothing is deleted: your videos and connections stay.'
      : 'Your videos are made on your own free Hugging Face worker, so it keeps going when your phone is locked.';
  $('#setupBtn').textContent = updating ? 'Update my worker' : 'Set up my worker';
  $('#steps [data-step="create"]').textContent = rebuild ? 'Making your worker again'
    : updating ? 'Sending the new version' : 'Creating your worker';
  $('#steps [data-step="build"]').textContent = 'Building it (2–5 min)';
  if (ready) {
    const link = $('#workerLink');
    link.href = `${HF}/spaces/${state.worker.space}`;
    link.textContent = state.worker.space;
    $('#workerState').textContent = state.online ? '(running)' : '(asleep or starting)';
  }
  renderPc();
  renderSongsBox();
  renderPlanBox();
  renderPings();
}

function init() {
  state.worker = load(KEYS.worker, null);
  state.clips = load(KEYS.clips, 3);
  state.captions = load(KEYS.captions, true);
  const pickSaved = (key, allowed, fallback) => (allowed.includes(load(key, null)) ? load(key, null) : fallback);
  state.style = pickSaved(KEYS.style, STYLES.map((x) => x.key), 'random');
  state.music = pickSaved(KEYS.music, [...MUSIC.map((x) => x.key), 'mysong'], 'funny');
  state.songId = load(KEYS.songId, null);
  state.track = pickSaved(KEYS.track, SONGS, SONGS[0]);
  state.part = pickSaved(KEYS.part, ['auto', 'start', 'drop', 'custom'], 'auto');
  state.clips = pickSaved(KEYS.clips, [1, 2, 3], 3);
  state.seconds = 5; // each clip; Video length picks how many
  state.speed = pickSaved(KEYS.speed, ['slow', 'normal', 'fast'], 'normal');
  state.brand = load(KEYS.brand, true) !== false;
  state.count = pickSaved(KEYS.count, [1, 2, 3, 5], 1);
  state.preview = load(KEYS.preview, true) !== false;
  const savedExtras = load(KEYS.extras, null) || {};
  state.extras = { ...EXTRAS_DEFAULT };
  for (const k of ['meme', 'opening', 'outro']) if (typeof savedExtras[k] === 'boolean') state.extras[k] = savedExtras[k];
  if (VOICES.includes(savedExtras.voice)) state.extras.voice = savedExtras.voice;
  if (VOICE_PICKS.includes(savedExtras.voicePick)) state.extras.voicePick = savedExtras.voicePick;
  if (state.extras.voice !== 'off') state.extras.voicePick = state.extras.voice; // the voice in use is the pick
  readInvite();
  openFromLink(location.hash, false);
  $('#idea').value = load(KEYS.idea, '');
  $('#animalOpt').value = load(KEYS.animal, '');
  buildVoices($('#voiceSeg'), (v) => {
    state.extras.voicePick = v;
    state.extras.voice = v;
    save(KEYS.extras, state.extras);
    renderExtras();
  });
  buildVoices($('#editVoiceSeg'), (v) => {
    edit.voice = v;
    renderEditor();
  });
  renderOptions();

  const onSeg = (id, apply) => document.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
    apply(b.dataset.v);
    renderOptions();
  }));
  onSeg('partSeg', (v) => {
    state.part = v;
    save(KEYS.part, v);
    if (v === 'custom' && !state.songDuration) loadSongDuration();
  });
  onSeg('videoSeg', (v) => { state.clips = Number(v) / 5; save(KEYS.clips, state.clips); });
  $('#songStart').addEventListener('input', (e) => {
    state.songStart = Number(e.target.value);
    $('#songStartLabel').textContent = clock(state.songStart);
  });
  $('#hearPart').addEventListener('click', hearPart);
  onSeg('speedSeg', (v) => { state.speed = v; save(KEYS.speed, v); });
  onSeg('countSeg', (v) => { state.count = Number(v); save(KEYS.count, state.count); });
  onSeg('friendUsesSeg', (v) => { state.friendUses = Number(v); });
  $('#previewOpt').addEventListener('change', (e) => {
    state.preview = e.target.checked;
    save(KEYS.preview, state.preview);
    renderOptions();
  });
  $('#link').addEventListener('change', renderOptions);
  $('#link').addEventListener('input', renderSource);
  for (const x of EXTRAS) {
    $(`#${x.id}`).addEventListener('change', (e) => {
      // Pet voice comes back on with the voice picked last.
      state.extras[x.key] = x.key === 'voice' ? (e.target.checked ? state.extras.voicePick : 'off') : e.target.checked;
      if (x.key === 'voice' && !e.target.checked) stopVoiceSample();
      save(KEYS.extras, state.extras);
      renderExtras();
    });
  }
  for (const ev of ['play', 'pause', 'ended']) preview.addEventListener(ev, renderHear);
  // Extras are open on a PC (every option in sight) and folded on a phone.
  if (matchMedia('(min-width: 960px)').matches) $('#extras').open = true;

  // The edit window
  const onEditSeg = (id, apply) => document.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
    apply(b.dataset.v);
    renderEditor();
  }));
  onEditSeg('editPartSeg', (v) => { edit.part = v; });
  onEditSeg('editLenSeg', (v) => { edit.len = Number(v); });
  onEditSeg('editSpeedSeg', (v) => { edit.speed = v; });
  $('#editMusic').addEventListener('change', () => {
    preview.pause();
    edit.songStart = 0;
    loadEditSongDuration();
    renderEditor();
  });
  $('#editSongFile').addEventListener('change', (e) => {
    edit.songFile = e.target.files[0] || null;
    if (edit.songFileUrl) URL.revokeObjectURL(edit.songFileUrl);
    edit.songFileUrl = null;
    edit.songStart = 0;
    loadEditSongDuration();
    renderEditor();
  });
  $('#editSongStart').addEventListener('input', (e) => {
    edit.songStart = Number(e.target.value);
    $('#editSongStartLabel').textContent = clock(edit.songStart);
  });
  $('#editHear').addEventListener('click', () => {
    const v = $('#editMusic').value;
    if (!preview.paused && !previewing.startsWith('voice:')) preview.pause(); // a voice sample just gives way
    else if (v.startsWith('song:')) playSong(editSongUrl(), (mySong(v.slice(5)) || {}).start || 0, 15); // its meme part
    else playSong(editSongUrl(), 0);
  });
  $('#editHearPart').addEventListener('click', () => {
    const speed = { slow: 0.8, normal: 1, fast: 1.25 }[edit.speed] || 1;
    playSong(editSongUrl(), edit.songStart, (edit.len * state.seconds) / speed);
  });
  $('#editIdea').addEventListener('input', renderEditor);
  $('#editAnimal').addEventListener('input', renderEditor);
  $('#editVoice').addEventListener('change', (e) => {
    if (!e.target.checked) stopVoiceSample();
    renderEditor();
  });
  $('#editSave').addEventListener('click', saveEdit);
  $('#editCancel').addEventListener('click', () => closeDialog($('#editor')));
  onClosed($('#editor'), () => {
    preview.pause();
    if (listening) listening.stop();
    edit.job = null;
  });
  document.querySelectorAll('.mic').forEach((btn) => btn.addEventListener('click', () => toggleMic(btn)));
  $('#finishAll').addEventListener('click', finishAll);
  $('#addFriend').addEventListener('click', addFriend);
  $('#leaveInvite').addEventListener('click', leaveInvite);
  $('#captionsOpt').addEventListener('change', (e) => {
    state.captions = e.target.checked;
    save(KEYS.captions, state.captions);
    renderExtras();
  });
  $('#idea').addEventListener('input', (e) => save(KEYS.idea, e.target.value));
  $('#brandOpt').addEventListener('change', (e) => {
    state.brand = e.target.checked;
    save(KEYS.brand, state.brand);
    renderExtras();
  });
  $('#animalOpt').addEventListener('input', (e) => {
    save(KEYS.animal, e.target.value);
    renderExtras();
  });
  $('#songFile').addEventListener('change', (e) => {
    state.songFile = e.target.files[0] || null;
    songChanged();
    renderOptions();
  });
  preview.addEventListener('ended', () => {
    previewing = '';
    renderOptions();
  });
  for (const ev of ['play', 'pause', 'ended']) preview.addEventListener(ev, renderSongButtons);
  // My songs: add one (Settings, or + Add a song under Music), hear and move its meme part, save it
  $('#addSongFile').addEventListener('change', (e) => addSong(e.target.files[0] || null));
  $('#songAddFile').addEventListener('change', (e) => addSong(e.target.files[0] || null));
  $('#songAddStart').addEventListener('input', (e) => setSongAddStart(Number(e.target.value)));
  $('#songAddStart').addEventListener('change', (e) => {
    if (songAdd.song && previewing === `song:${songAdd.song.id}` && !preview.paused) hearSong(songAdd.song.id, Number(e.target.value));
  });
  $('#songAddHear').addEventListener('click', () => {
    const id = songAdd.song && songAdd.song.id;
    if (!id) return;
    if (previewing === `song:${id}` && !preview.paused) hearSong(id); // (stops it)
    else hearSong(id, Number($('#songAddStart').value));
  });
  $('#songAddSave').addEventListener('click', saveSongPanel);

  $('#makeForm').addEventListener('submit', onMake);
  $('#pasteBtn').addEventListener('click', async () => {
    try {
      $('#link').value = (await navigator.clipboard.readText()).trim();
      $('#link').dispatchEvent(new Event('input')); // (Together: 2 or more links switch to Together)
    } catch {
      $('#link').focus();
      toast('Long-press the box and tap Paste');
    }
  });
  $('#file').addEventListener('change', (e) => setFile(e.target.files[0] || null));
  $('#clearFile').addEventListener('click', () => setSurprise(false));
  $('#surpriseBtn').addEventListener('click', () => setSurprise(true));

  $('#openSettings').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', () => closeDialog($('#settings')));
  $('#setupBtn').addEventListener('click', setupWorker);
  $('#pairBtn').addEventListener('click', getPairCode);
  $('#updateBtn').addEventListener('click', openUpdate);
  $('#updateBtnMain').addEventListener('click', openUpdate);
  $('#gpuResumeMain').addEventListener('click', resumeGpu);
  $('#gpuResume').addEventListener('click', resumeGpu);
  onClosed($('#settings'), () => {
    state.setupMode = 'setup';
    $('#steps').hidden = true;
    if (previewing.startsWith('song:')) preview.pause();
  });
  $('#redoSetup').addEventListener('click', () => {
    $('#setupPane').hidden = false;
    $('#optionsPane').hidden = true;
    renderPings();
  });
  $('#disconnect').addEventListener('click', () => {
    if (!confirm('Disconnect this phone from your worker? Your videos stay in your Hugging Face account.')) return;
    if (pings.on) turnOffPings(state.worker); // no more notifications from it on this phone
    state.worker = null;
    save(KEYS.worker, null);
    state.jobs = [];
    state.songs = null;
    resetPlan();
    resetPings();
    renderJobs();
    renderWorkerDot(false);
    renderSettings();
    renderConnect();
  });

  $('#saveBtn').addEventListener('click', saveVideo);
  $('#finishBtn').addEventListener('click', () => {
    const job = state.playing;
    closeDialog($('#player'));
    if (job) finishJob(job);
  });
  $('#editBtn').addEventListener('click', () => {
    if (state.playing) openEditor(state.playing);
  });
  $('#copyBtn').addEventListener('click', () => copyText(state.playing ? state.playing.caption || '' : ''));
  $('#closePlayer').addEventListener('click', () => closeDialog($('#player')));
  onClosed($('#player'), () => {
    $('#playerVideo').pause();
    state.playing = null;
  });

  // Posting plan: the strip, the box in Settings, and the Post screen
  $('#planStripMain').addEventListener('click', openPlanBox);
  $('#planStripAct').addEventListener('click', planStripAct);
  $('#planOn').addEventListener('change', (e) => setPlanOn(e.target.checked));
  document.querySelectorAll('#planPerDay button').forEach((b) => b.addEventListener('click', () => setPerDay(Number(b.dataset.v))));
  $('#planTagAdd').addEventListener('click', addPlanTags);
  $('#planTagInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addPlanTags();
  });
  $('#planNotifyBtn').addEventListener('click', () => {
    if (iosTab()) $('#appBox').scrollIntoView({ behavior: 'smooth', block: 'center' }); // (the Home Screen steps)
    turnOnPings();
  });
  $('#postCopy').addEventListener('click', () => copyText($('#postCaption').value, 'Caption copied', $('#postDialog')));
  $('#postShare').addEventListener('click', sharePost);
  $('#postSaveAlt').addEventListener('click', savePostVideo);
  $('#postVideo').addEventListener('error', () => { // (a phone that can't play the fetched file: from the worker then)
    if (/^blob:/.test($('#postVideo').getAttribute('src') || '')) playPostVideo(true);
  });
  $('#postCaption').addEventListener('change', savePostCaption);
  $('#postReset').addEventListener('click', resetPostCaption);
  $('#postSongOpt').addEventListener('change', (e) => setPostAudio(e.target.checked));
  $('#postDone').addEventListener('click', () => finishPost('posted'));
  $('#postSkip').addEventListener('click', () => finishPost('skipped'));
  $('#postLater').addEventListener('click', () => closeDialog($('#postDialog')));
  onClosed($('#postDialog'), clearPost);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      clearReady();
      refreshJobs();
      if (state.plan) loadPlan(); // (back from TikTok, or a reminder came)
    }
  });

  // Notifications, the Home Screen app, and the link that connects it
  $('#pingBtn').addEventListener('click', () => (pings.on ? turnOffPings() : turnOnPings()));
  $('#pingNudgeBtn').addEventListener('click', () => (iosTab() ? showAppSteps() : turnOnPings()));
  $('#pingNudgeNo').addEventListener('click', () => {
    save(KEYS.pingAsked, true);
    renderPings();
  });
  $('#pingTest').addEventListener('click', testPing);
  $('#installBtn').addEventListener('click', installApp);
  $('#copyAppLink').addEventListener('click', () => copyText(appLink(), 'Copied. Keep it private.'));
  $('#copyInvite').addEventListener('click', () => copyText(myInviteLink(), 'Copied your invite link'));
  $('#connectBtn').addEventListener('click', () => connectWith($('#connectLink').value));
  $('#connectLink').addEventListener('input', (e) => connectWith(e.target.value, true));
  $('#connectLink').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectWith(e.target.value);
  });
  $('#connectPaste').addEventListener('click', async () => {
    try {
      $('#connectLink').value = (await navigator.clipboard.readText()).trim();
    } catch {
      $('#connectLink').focus();
      toast('Long-press the box and tap Paste');
      return;
    }
    connectWith($('#connectLink').value);
  });
  $('#connectSetup').addEventListener('click', openSettings);
  $('#toConnect').addEventListener('click', () => {
    closeDialog($('#settings'));
    $('#connectLink').focus();
  });
  // A link opened while antics is already open: an invite, an app link, or a video from a notification.
  window.addEventListener('hashchange', () => {
    if (readInvite()) workerChanged();
    openFromLink(location.hash);
  });
  startApp();

  renderWorkerDot(false);
  renderRole();
  renderSource();
  renderConnect();
  if (state.worker) refreshJobs();
}

init();
