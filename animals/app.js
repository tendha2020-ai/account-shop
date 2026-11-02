// app.js
// antics: paste a link (or upload a clip), tap Make it, and your own free Hugging Face worker
// turns the animal into a human-acting TikTok video in the background.

const HF = 'https://huggingface.co';
const SPACE_NAME = 'antics-worker';
const DATASET_NAME = 'antics-videos';
const WORKER_FILES = ['Dockerfile', 'README.md', 'requirements.txt', 'worker.py', 'ideas.py', 'beats.py'];
const WORKER_VERSION = '8'; // bump with VERSION in worker/worker.py
const KEYS = {
  worker: 'antics.worker', clips: 'antics.clips', captions: 'antics.captions', style: 'antics.style', music: 'antics.music',
  track: 'antics.track', part: 'antics.part', seconds: 'antics.seconds', speed: 'antics.speed', animal: 'antics.animal',
  idea: 'antics.idea', brand: 'antics.brand', count: 'antics.count', preview: 'antics.preview', ownerBackup: 'antics.owner',
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
  { key: 'funny', label: 'Meme song for the style' },
  { key: 'track', label: 'Pick a song' },
  { key: 'upload', label: 'Upload my song' },
  { key: 'mine', label: "My video's sound" },
  { key: 'none', label: "None (I'll add a TikTok sound)" },
];
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
  setupMode: 'setup', // or 'update': rebuild the worker with a new key
  brand: true,
  songStart: 0, // seconds into the song, when Song part is "Pick myself"
  songDuration: 0,
  count: 1, // videos made per tap
  preview: true, // a quick preview first: only the first clip is animated until Finish
  me: null, // from the worker: { role: 'owner' }, or a friend's { name, host, uses_left, used, redos }
  guests: null, // the owner's friends
  friendUses: 5,
  watchAfter: null, // { id, rev }: open this video when its new version is ready
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openDialog(dlg) {
  if (dlg.showModal) dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeDialog(dlg) {
  if (dlg.close) dlg.close();
  else dlg.removeAttribute('open');
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

function readInvite() {
  const m = location.hash.match(/^#join=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let data = null;
  try {
    data = JSON.parse(fromB64url(m[1]));
  } catch {
    // broken link
  }
  if (!data || !/^https:\/\/[a-z0-9-]+\.hf\.space$/.test(data.w || '') || !/^[a-f0-9]{16,64}$/.test(data.k || '')) {
    setTimeout(() => toast('That invite link is broken. Ask for a new one.'), 300);
    return;
  }
  if (state.worker && !state.worker.guest) {
    if (state.worker.key === data.k) return;
    const ok = confirm(`This is ${data.n || 'a friend'}'s invite. Open it on this device? Your own worker stays saved: Settings, Leave this invite brings it back.`);
    if (!ok) return;
    save(KEYS.ownerBackup, state.worker);
  }
  state.worker = { url: data.w, key: data.k, guest: true, name: data.n || '', host: data.h || '' };
  save(KEYS.worker, state.worker);
}

function leaveInvite() {
  if (!confirm('Leave this invite? Your videos stay. Open the invite link again to come back.')) return;
  const backup = load(KEYS.ownerBackup, null);
  state.worker = backup;
  save(KEYS.worker, backup);
  save(KEYS.ownerBackup, null);
  state.jobs = [];
  state.me = null;
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
    // Secrets (like the Hugging Face key) can only be set when a Space is created, so both a new setup
    // and an update rebuild the Space. An update keeps the worker's connection key, so every device and
    // the PC helper stay connected; videos live in the dataset and are kept either way.
    const existing = await hf(`/api/spaces/${space}`, token);
    if (existing.ok) {
      const del = await hf('/api/repos/delete', token, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'space', name: SPACE_NAME }),
      });
      if (!del.ok) throw new Error(await hfError(del));
      await sleep(2000);
    }
    const key = updating ? state.worker.key : randomKey();
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
    const url = await waitForBuild(space);
    state.worker = { space, url, key };
    save(KEYS.worker, state.worker);
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

// Polls the Space until Docker has built it. Returns its web address.
async function waitForBuild(space) {
  const started = Date.now();
  let errors = 0;
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
    const mins = Math.floor((Date.now() - started) / 60000);
    $('#steps [data-step="build"]').textContent = `Building it (${mins} min so far, 2–5 min, only once)`;
    // Right after a rebuild the old stage can linger, so only a repeated error after a short wait counts.
    errors = /ERROR/.test(stage) && Date.now() - started > 45000 ? errors + 1 : 0;
    if (errors >= 2) {
      throw new Error(`The worker failed to build (${stage}). Open huggingface.co/spaces/${space} to see why, then tap Set up again.`);
    }
    if (stage === 'RUNNING') {
      const domain = (rt.domains || []).find((d) => d.stage === 'READY') || (rt.domains || [])[0];
      if (domain) return `https://${domain.domain}`;
      return `https://${space.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.hf.space`;
    }
  }
  throw new Error('The worker is taking too long to build. Try Set up again later.');
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

function setFile(file) {
  state.file = file;
  $('#fileChip').hidden = !file;
  $('#linkField').hidden = Boolean(file);
  $('#fileName').textContent = file ? file.name || 'Your video' : '';
  if (!file) $('#file').value = '';
}

async function onMake(e) {
  e.preventDefault();
  const note1 = $('#note');
  if (state.file) {
    submit({ kind: 'file', file: state.file });
    return;
  }
  const link = $('#link').value.trim();
  if (!/^https?:\/\/\S+$/i.test(link)) {
    note(note1, 'Paste a video link first (or upload a video, or tap surprise me).', 'bad');
    return;
  }
  submit({ kind: 'link', url: link });
}

async function submit(what) {
  const msg = $('#note');
  if (state.music === 'upload' && !state.songFile) {
    note(msg, 'Choose your song file first (Music, Upload my song), or pick another music option.', 'bad');
    return;
  }
  if (!state.worker) {
    state.pending = what;
    openSettings();
    return;
  }
  note(msg, '');
  const btn = $('#makeBtn');
  btn.disabled = true;
  btn.textContent = what.kind === 'file' ? 'Picking the best moments…' : 'Sending…';
  const count = makeCount();
  try {
    const form = new FormData();
    form.append('count', String(count));
    form.append('draft', String(state.preview));
    form.append('clips', String(state.clips));
    form.append('captions', String(state.captions));
    form.append('template', state.style);
    // A surprise scene has no sound of its own, so it gets a meme song instead.
    form.append('music', what.kind === 'surprise' && state.music === 'mine' ? 'funny' : state.music);
    form.append('track', state.track);
    const canPick = ['track', 'upload'].includes(state.music);
    form.append('song_part', state.part === 'custom' && !canPick ? 'auto' : state.part);
    form.append('song_start', state.songStart.toFixed(1));
    form.append('seconds', String(state.seconds));
    form.append('speed', state.speed);
    form.append('idea', $('#idea').value.trim());
    form.append('animal', $('#animalOpt').value.trim());
    if (state.music === 'upload') form.append('song', state.songFile);
    let tagMissing = false;
    if (state.brand && !isGuest()) {
      try {
        form.append('badge', await brandBadge(), 'badge.png');
      } catch {
        tagMissing = true; // never let the name tag stop a video
      }
    }
    if (what.kind === 'link') form.append('url', what.url);
    if (what.kind === 'surprise') form.append('surprise', 'true');
    if (what.kind === 'file') {
      const pictures = await picturesFromFile(what.file, state.clips, count);
      pictures.forEach((blob, i) => form.append('images', blob, `picture_${i}.jpg`));
      if (state.music === 'mine' && isVideoFile(what.file)) {
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
    $('#link').value = '';
    setFile(null);
    const kind = state.preview && made[0].draft ? 'preview' : 'video';
    const got = made.length > 1 ? `${made.length} ${kind}s on the way` : `Your ${kind} is on the way`;
    toast(`${got}${tagMissing ? ' (without your name tag this time)' : ''}. You can close the app, it keeps working.`);
    schedulePoll(2000);
  } catch (e) {
    note(msg, e.waking ? 'Your worker is waking up (takes up to a minute). Tap Make it again in a moment.' : e.message, 'bad');
    if (e.waking) wakeWorker();
  } finally {
    renderMake();
  }
}

// How many videos one tap makes: the Export choice, but never more than a friend has left.
function makeCount() {
  const left = isGuest() && state.me ? state.me.uses_left : Infinity;
  return Math.max(1, Math.min(state.count, left));
}

// The Export block (how many videos, quick preview) and the Make button.
function renderMake() {
  const left = isGuest() && state.me ? state.me.uses_left : Infinity;
  document.querySelectorAll('#countSeg button').forEach((b) => {
    b.disabled = Number(b.dataset.v) > Math.max(1, left);
  });
  const n = makeCount();
  setSeg('countSeg', n);
  $('#previewOpt').checked = state.preview;
  const clips = n * (state.preview ? 1 : state.clips);
  let help = state.preview
    ? 'Only the first clip of each video is animated, so previews come fast. Edit them as often as you like, then tap Finish for the full video.'
    : 'Each video is made in full straight away.';
  if (n > 1) help += ` Each of the ${n} videos gets its own ideas${state.file || $('#link').value ? ' and its own moments' : ''}.`;
  if (clips > 4) help += ` That's ${clips} AI clips: free time makes about 3–5 a day, so some finish later by themselves.`;
  $('#exportHelp').textContent = help;
  const btn = $('#makeBtn');
  const out = isGuest() && state.me && state.me.uses_left <= 0;
  btn.disabled = Boolean(out);
  if (out) btn.textContent = 'No videos left';
  else if (state.preview) btn.textContent = n > 1 ? `Make ${n} previews` : 'Make a preview';
  else btn.textContent = n > 1 ? `Make ${n} videos` : 'Make it';
  $('#surpriseBtn').disabled = Boolean(out);
  if (out) note($('#note'), `You've used all your videos. Ask ${hostName()} for more.`);
  else if ($('#note').textContent.startsWith("You've used all")) note($('#note'), '');
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

// count pictures (one per clip) for each of `variants` videos: [video 1's, video 2's, ...].
async function picturesFromFile(file, count, variants = 1) {
  const isVideo = isVideoFile(file);
  const url = URL.createObjectURL(file);
  try {
    if (!isVideo) {
      const img = new Image();
      img.src = url;
      await img.decode();
      return [await toJpeg(drawScaled(img, img.naturalWidth, img.naturalHeight, 1024))];
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
    const samples = dur > 1 ? Math.min(24, Math.max(12, count * variants + 4)) : 1;
    const frames = [];
    for (let i = 0; i < samples; i++) {
      if (samples > 1) {
        video.currentTime = dur * (0.04 + (0.92 * i) / (samples - 1));
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
        const lo = (dur * part) / count;
        const hi = (dur * (part + 1)) / count;
        const inPart = frames.filter((f) => f.t >= lo && f.t <= hi);
        const pool = (inPart.length ? inPart : frames).slice().sort((a, b) => b.score - a.score);
        picks.push(pool[v % pool.length]);
      }
    }
    if (variants > 1) return Promise.all(picks.map((f) => toJpeg(f.canvas)));
    return Promise.all([...new Set(picks)].map((f) => toJpeg(f.canvas)));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- Job list ----------

function describe(job) {
  if (job.status === 'queued') return job.stage || 'In line…';
  if (job.status === 'working') return job.stage || 'Working…';
  if (job.status === 'waiting') {
    const at = job.retry_at ? new Date(job.retry_at * 1000) : null;
    const when = at ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later';
    return `${job.stage || 'Waiting for free time.'} Next try around ${when}.`;
  }
  if (job.status === 'failed') return job.error || 'Something went wrong.';
  const len = job.seconds_long ? `${Math.round(job.seconds_long)} sec` : '';
  if (job.draft) {
    return ['Preview ready', len, job.wanted > 1 ? 'clip 1 moves, the rest are pictures until you finish' : '']
      .filter(Boolean).join(' · ');
  }
  return ['Ready', len, job.stage].filter(Boolean).join(' · ');
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
    $('.job-stage', card).textContent = describe(job);
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
    if (job.status === 'done') {
      add(job.draft ? 'Watch' : 'Watch & save', 'open', () => openPlayer(job));
      if (job.editable) add('Edit', '', () => openEditor(job));
      if (job.draft) add('Finish', 'finish', () => finishJob(job));
      else if (job.editable && job.made < job.wanted) add('Make the rest', 'finish', () => finishJob(job));
      if (!job.draft) add('Copy caption', '', () => copyText(job.caption || ''));
    } else if (job.has_video) {
      add('Watch last version', 'open', () => openPlayer(job));
    }
    if (job.status === 'failed' || job.status === 'waiting') add('Try again', '', () => retryJob(job));
    if (job.status !== 'working') add('Delete', 'danger', () => deleteJob(job));
    box.appendChild(card);
  }
  const drafts = state.jobs.filter(finishable);
  $('#finishAll').hidden = drafts.length < 2;
  $('#finishAll').textContent = `Finish all ${drafts.length} previews`;
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
  try {
    const res = await api('/jobs');
    state.jobs = res.jobs;
    if (res.me) state.me = res.me;
    renderJobs();
    renderRole();
    renderMake();
    refreshHealth();
    renderWorkerDot(true);
    $('#wakeNote').hidden = true;
    showWhenReady(res.jobs);
    const busy = res.jobs.some((j) => j.status === 'queued' || j.status === 'working');
    schedulePoll(document.hidden ? 60000 : state.watchAfter ? 2000 : busy ? 4000 : 30000);
  } catch (e) {
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
  try {
    replaceJob(await api(`/jobs/${job.id}/finish`, { method: 'POST' }));
    state.watchAfter = { id: job.id, rev: job.rev || 0 };
    const missing = Math.max(0, (job.wanted || 1) - (job.made || 0));
    toast(missing
      ? `Animating ${missing} more clip${missing === 1 ? '' : 's'} (1–2 min each). You can close the app.`
      : 'Making the full video…');
    schedulePoll(1500);
  } catch (e) {
    toast(e.message);
  }
}

// Previews ready to finish: your own (the owner's list also shows friends' videos).
const finishable = (j) => j.draft && j.status === 'done' && (isGuest() || !j.owner || j.owner === 'me');

async function finishAll() {
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
  if (!confirm('Delete this video?')) return;
  try {
    await api(`/jobs/${job.id}`, { method: 'DELETE' });
    state.jobs = state.jobs.filter((j) => j.id !== job.id);
    renderJobs();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Player + saving ----------

function renderPlayerTip(job) {
  const tip = $('#playerTip');
  tip.textContent = '';
  const add = (text, bold) => {
    const el = bold ? document.createElement('b') : document.createTextNode(text);
    if (bold) el.textContent = text;
    tip.appendChild(el);
  };
  if (job.draft) {
    add('Quick preview: ');
    add(job.wanted > 1 ? 'clip 1 moves, the others are still pictures' : 'this is how it will look', true);
    add('. Tap Edit to change anything, or Finish for the full video. ');
  }
  if (job.music_used === 'funny') add(`"${songLabel(job.track || '')}" is already in the video (its credit is in the caption). `);
  else if (job.music_used === 'upload') add('Your song is already in the video. ');
  else if (job.music_used === 'mine') add("Your video's sound is already in it. ");
  else {
    add('Sound idea: ');
    add(job.sound || 'any trending sound', true);
    add('. Add it in TikTok. ');
  }
  add('Before posting, switch on ');
  add('AI-generated content', true);
  add('.');
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

function setSeg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(value))));
}

function chips(box, items, current, onPick) {
  box.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
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
  chips($('#musicRow'), MUSIC, state.music, (key) => {
    state.music = key;
    save(KEYS.music, key);
    songChanged();
    renderOptions();
  });

  const list = $('#songList');
  list.hidden = state.music !== 'track';
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

  $('#songUpload').hidden = state.music !== 'upload';
  $('#songName').textContent = state.songFile ? state.songFile.name : 'No song chosen yet';
  $('#partLine').hidden = state.music === 'none';
  $('#musicHelp').hidden = state.music === 'none';
  $('#musicNote').hidden = !['mine', 'upload'].includes(state.music);
  const canPick = ['track', 'upload'].includes(state.music);
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
  renderMake();
}

function openPlayer(job) {
  state.playing = job;
  state.playingBlob = null;
  const video = $('#playerVideo');
  video.src = mediaUrl(job, 'video');
  $('#playerCaption').textContent = job.caption || '';
  const ready = job.status === 'done';
  $('#finishBtn').hidden = !(ready && job.draft);
  $('#editBtn').hidden = !(ready && job.editable);
  $('#saveBtn').className = ready && job.draft ? 'plain' : 'go small';
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
};

const cleanAnimal = (text) => text.replace(/[^a-zA-Z ]/g, '').trim().toLowerCase().slice(0, 30);

function musicValue(job) {
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
  opt('funny', 'Meme song for the style');
  const group = document.createElement('optgroup');
  group.label = 'Meme songs';
  sel.appendChild(group);
  for (const name of SONGS) opt(`track:${name}`, songLabel(name), group);
  if (job.has_song) opt('upload', 'My uploaded song');
  opt('upload-new', job.has_song ? 'Upload a different song…' : 'Upload my song…');
  if (job.has_sound) opt('mine', "My video's sound");
  opt('none', "None (I'll add a TikTok sound)");
  sel.value = musicValue(job);

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
    input.placeholder = 'No text on this clip';
    input.setAttribute('aria-label', `Text on clip ${i + 1}`);
    const redo = document.createElement('button');
    redo.type = 'button';
    redo.className = 'redo';
    redo.textContent = '↻';
    redo.title = 'New idea and new animation for this clip';
    redo.setAttribute('aria-label', `New idea for clip ${i + 1}`);
    redo.addEventListener('click', () => {
      if (edit.redo.has(i)) edit.redo.delete(i);
      else edit.redo.add(i);
      renderEditor();
    });
    row.append(num, input, redo);
    if (job.draft && i > 0) {
      const still = document.createElement('span');
      still.className = 'still';
      still.textContent = 'A still picture in the preview. It moves when you finish.';
      row.appendChild(still);
    }
    box.appendChild(row);
  });
  note($('#editNote'), '');
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
  if ($('#editIdea').value.trim().replace(/\s+/g, ' ') !== (job.idea || '')) return animatedClips(job) > 0;
  if (edit.style !== (job.template || 'random')) return animatedClips(job) > 0;
  const animal = cleanAnimal($('#editAnimal').value);
  if (job.kind !== 'surprise' && animal && animal !== job.animal) return animatedClips(job) > 0;
  return [...edit.redo].some((i) => i < animatedClips(job) && i < edit.len);
}

function editSongUrl() {
  const sel = $('#editMusic').value;
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
  $('#editRedoHelp').textContent = '↻ gives that clip a new idea and a new animation.'
    + (extra > 0 ? ` ${extra} more clip${extra === 1 ? '' : 's'} will get new ideas.` : '')
    + (left < Infinity ? ` New animations left for this video: ${left}.` : '');
  chips($('#editStyle'), STYLES, edit.style, (key) => {
    edit.style = key;
    renderEditor();
  });
  const music = $('#editMusic').value;
  $('#editSongUpload').hidden = music !== 'upload-new';
  $('#editSongName').textContent = edit.songFile ? edit.songFile.name : 'No song chosen yet';
  $('#editHear').hidden = !editSongUrl();
  $('#editPartLine').hidden = music === 'none';
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
  const job = edit.job;
  const form = new FormData();
  form.append('texts', JSON.stringify([...document.querySelectorAll('#editTexts input')].map((i) => i.value.trim())));
  form.append('idea', $('#editIdea').value.trim());
  form.append('template', edit.style);
  if (job.kind !== 'surprise') form.append('animal', $('#editAnimal').value.trim());
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
  } else {
    form.append('music', sel);
  }
  const canPick = sel.startsWith('track:') || sel === 'upload-new' || sel === 'upload';
  form.append('song_part', edit.part === 'custom' && !canPick ? 'auto' : edit.part);
  form.append('song_start', edit.songStart.toFixed(1));
  form.append('speed', edit.speed);
  form.append('captions', String($('#editCaptions').checked));
  if (job.has_badge) form.append('brand', String($('#editBrand').checked));
  const redo = [...edit.redo].filter((i) => i < edit.len);
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
  rec.onresult = (e) => typed(box, joinText(before, Array.from(e.results, (r) => r[0].transcript).join(' '), box.maxLength));
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
      if (text) typed(box, joinText(box.value, text, box.maxLength));
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

// ---------- Settings ----------

function openUpdate() {
  state.setupMode = 'update';
  openSettings();
}

function openSettings() {
  renderSettings();
  note($('#setupNote'), state.pending ? 'One quick setup first, then your video starts by itself.' : '');
  openDialog($('#settings'));
  if (state.worker && !isGuest()) loadFriends();
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
  const outdated = Boolean(state.health && state.health.version !== WORKER_VERSION);
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

async function refreshHealth() {
  try {
    const res = await fetch(`${state.worker.url}/health`);
    state.health = await res.json();
  } catch {
    return; // asleep or offline: keep the last known state
  }
  renderPc();
}

function renderPc() {
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
  const keyBroken = Boolean(state.worker && h && h.token_ok === false);
  const outdated = Boolean(state.worker && h && h.version !== WORKER_VERSION);
  $('#updateNote').hidden = !(outdated || keyBroken);
  $('#updateBanner').hidden = !(outdated || keyBroken);
  $('#updateText').textContent = keyBroken
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
  if (guest) {
    $('#setupPane').hidden = true;
    $('#optionsPane').hidden = true;
    const me = state.me;
    const host = hostName();
    $('#guestInfo').textContent = me
      ? `${host} gave you ${me.uses_left + me.used} videos. ${me.uses_left} left.`
      : `You're using ${host}'s antics.`;
    $('#guestFine').textContent = `Your videos are made on ${host}'s free worker, and only you and ${host} can see them. Ask ${host} if you need more.`;
    return;
  }
  const updating = state.setupMode === 'update' && Boolean(state.worker);
  const ready = Boolean(state.worker) && !updating;
  $('#setupPane').hidden = ready;
  $('#optionsPane').hidden = !ready;
  $('#setupTitle').textContent = updating ? 'Update your worker' : 'One-time setup';
  $('#setupIntro').textContent = updating
    ? 'Paste a Hugging Face Write key. Your worker is rebuilt with the newest version and this key (2–5 min). Your videos and connections are kept.'
    : 'Your videos are made on your own free Hugging Face worker, so it keeps going when your phone is locked.';
  $('#setupBtn').textContent = updating ? 'Update my worker' : 'Set up my worker';
  $('#steps [data-step="create"]').textContent = updating ? 'Rebuilding your worker' : 'Creating your worker';
  $('#steps [data-step="build"]').textContent = 'Building it (2–5 min)';
  if (ready) {
    const link = $('#workerLink');
    link.href = `${HF}/spaces/${state.worker.space}`;
    link.textContent = state.worker.space;
    $('#workerState').textContent = state.online ? '(running)' : '(asleep or starting)';
  }
  renderPc();
}

function init() {
  state.worker = load(KEYS.worker, null);
  state.clips = load(KEYS.clips, 3);
  state.captions = load(KEYS.captions, true);
  const pickSaved = (key, allowed, fallback) => (allowed.includes(load(key, null)) ? load(key, null) : fallback);
  state.style = pickSaved(KEYS.style, STYLES.map((x) => x.key), 'random');
  state.music = pickSaved(KEYS.music, MUSIC.map((x) => x.key), 'funny');
  state.track = pickSaved(KEYS.track, SONGS, SONGS[0]);
  state.part = pickSaved(KEYS.part, ['auto', 'start', 'drop', 'custom'], 'auto');
  state.clips = pickSaved(KEYS.clips, [1, 2, 3], 3);
  state.seconds = 5; // each clip; Video length picks how many
  state.speed = pickSaved(KEYS.speed, ['slow', 'normal', 'fast'], 'normal');
  state.brand = load(KEYS.brand, true) !== false;
  state.count = pickSaved(KEYS.count, [1, 2, 3, 5], 1);
  state.preview = load(KEYS.preview, true) !== false;
  readInvite();
  $('#idea').value = load(KEYS.idea, '');
  $('#animalOpt').value = load(KEYS.animal, '');
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
    if (!preview.paused) preview.pause();
    else playSong(editSongUrl(), 0);
  });
  $('#editHearPart').addEventListener('click', () => {
    const speed = { slow: 0.8, normal: 1, fast: 1.25 }[edit.speed] || 1;
    playSong(editSongUrl(), edit.songStart, (edit.len * state.seconds) / speed);
  });
  $('#editIdea').addEventListener('input', renderEditor);
  $('#editAnimal').addEventListener('input', renderEditor);
  $('#editSave').addEventListener('click', saveEdit);
  $('#editCancel').addEventListener('click', () => closeDialog($('#editor')));
  $('#editor').addEventListener('close', () => {
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
  });
  $('#idea').addEventListener('input', (e) => save(KEYS.idea, e.target.value));
  $('#brandOpt').addEventListener('change', (e) => {
    state.brand = e.target.checked;
    save(KEYS.brand, state.brand);
  });
  $('#animalOpt').addEventListener('input', (e) => save(KEYS.animal, e.target.value));
  $('#songFile').addEventListener('change', (e) => {
    state.songFile = e.target.files[0] || null;
    songChanged();
    renderOptions();
  });
  preview.addEventListener('ended', () => {
    previewing = '';
    renderOptions();
  });

  $('#makeForm').addEventListener('submit', onMake);
  $('#pasteBtn').addEventListener('click', async () => {
    try {
      $('#link').value = (await navigator.clipboard.readText()).trim();
    } catch {
      $('#link').focus();
      toast('Long-press the box and tap Paste');
    }
  });
  $('#file').addEventListener('change', (e) => setFile(e.target.files[0] || null));
  $('#clearFile').addEventListener('click', () => setFile(null));
  $('#surpriseBtn').addEventListener('click', () => submit({ kind: 'surprise' }));

  $('#openSettings').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', () => closeDialog($('#settings')));
  $('#setupBtn').addEventListener('click', setupWorker);
  $('#pairBtn').addEventListener('click', getPairCode);
  $('#updateBtn').addEventListener('click', openUpdate);
  $('#updateBtnMain').addEventListener('click', openUpdate);
  $('#settings').addEventListener('close', () => {
    state.setupMode = 'setup';
    $('#steps').hidden = true;
  });
  $('#redoSetup').addEventListener('click', () => {
    $('#setupPane').hidden = false;
    $('#optionsPane').hidden = true;
  });
  $('#disconnect').addEventListener('click', () => {
    if (!confirm('Disconnect this phone from your worker? Your videos stay in your Hugging Face account.')) return;
    state.worker = null;
    save(KEYS.worker, null);
    state.jobs = [];
    renderJobs();
    renderWorkerDot(false);
    renderSettings();
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
  $('#player').addEventListener('close', () => {
    $('#playerVideo').pause();
    state.playing = null;
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshJobs();
  });

  renderWorkerDot(false);
  renderRole();
  if (state.worker) refreshJobs();
}

init();
