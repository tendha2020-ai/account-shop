// app.js
// antics: paste a link (or upload a clip), tap Make it, and your own free Hugging Face worker
// turns the animal into a human-acting TikTok video in the background.

const HF = 'https://huggingface.co';
const SPACE_NAME = 'antics-worker';
const DATASET_NAME = 'antics-videos';
const WORKER_FILES = ['Dockerfile', 'README.md', 'requirements.txt', 'worker.py', 'ideas.py', 'beats.py'];
const WORKER_VERSION = '5'; // bump with VERSION in worker/worker.py
const KEYS = {
  worker: 'antics.worker', clips: 'antics.clips', captions: 'antics.captions', style: 'antics.style', music: 'antics.music',
  track: 'antics.track', part: 'antics.part', seconds: 'antics.seconds', speed: 'antics.speed', animal: 'antics.animal',
  idea: 'antics.idea', brand: 'antics.brand',
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
  worker: null, // { space, url, key }
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
  setupMode: 'setup', // or 'update': upload the new worker files to the existing Space
  brand: true,
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
  if (!res.ok) throw new Error(body.detail || `Worker error ${res.status}`);
  return body;
}

function mediaUrl(job, what) {
  return `${state.worker.url}/jobs/${job.id}/${what}?key=${encodeURIComponent(state.worker.key)}&v=${job.status}`;
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
    // Updating only uploads new files, so the worker keeps its secrets, its address and your videos.
    // A new setup replaces any old worker, because secrets can only be set when a Space is created.
    const existing = updating ? { ok: false } : await hf(`/api/spaces/${space}`, token);
    if (existing.ok) {
      const del = await hf('/api/repos/delete', token, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'space', name: SPACE_NAME }),
      });
      if (!del.ok) throw new Error(await hfError(del));
      await sleep(2000);
    }
    const key = randomKey();
    const created = updating ? { ok: true } : await hf('/api/repos/create', token, {
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
    if (updating) {
      await waitForVersion(space);
    } else {
      const url = await waitForBuild(space);
      state.worker = { space, url, key };
      save(KEYS.worker, state.worker);
      await waitForHealth();
    }
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

// After an update: waits until the worker answers with the new version.
async function waitForVersion(space) {
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    await sleep(8000);
    const mins = Math.floor((Date.now() - started) / 60000);
    $('#steps [data-step="build"]').textContent = `Restarting with the new version (${mins} min so far, 2–5 min)`;
    try {
      const rt = await (await fetch(`${HF}/api/spaces/${space}/runtime`)).json();
      if (/ERROR/.test(rt.stage || '')) {
        throw new Error(`The new version failed to build (${rt.stage}). Open huggingface.co/spaces/${space} to see why.`);
      }
      const health = await (await fetch(`${state.worker.url}/health`, { cache: 'no-store' })).json();
      if (health.version === WORKER_VERSION) {
        state.health = health;
        return;
      }
    } catch (e) {
      if (/failed to build/.test(e.message)) throw e;
      // still restarting
    }
  }
  throw new Error('The update is taking too long. Check your worker page on Hugging Face, then try again.');
}

// Polls the Space until Docker has built it. Returns its web address.
async function waitForBuild(space) {
  const started = Date.now();
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
    if (/ERROR/.test(stage)) {
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
  try {
    const form = new FormData();
    form.append('clips', String(state.clips));
    form.append('captions', String(state.captions));
    form.append('template', state.style);
    // A surprise scene has no sound of its own, so it gets a meme song instead.
    form.append('music', what.kind === 'surprise' && state.music === 'mine' ? 'funny' : state.music);
    form.append('track', state.track);
    form.append('song_part', state.part);
    form.append('seconds', String(state.seconds));
    form.append('speed', state.speed);
    form.append('idea', $('#idea').value.trim());
    form.append('animal', $('#animalOpt').value.trim());
    if (state.music === 'upload') form.append('song', state.songFile);
    if (state.brand) form.append('badge', await brandBadge(), 'badge.png');
    if (what.kind === 'link') form.append('url', what.url);
    if (what.kind === 'surprise') form.append('surprise', 'true');
    if (what.kind === 'file') {
      const pictures = await picturesFromFile(what.file, state.clips);
      pictures.forEach((blob, i) => form.append('images', blob, `picture_${i}.jpg`));
      if (state.music === 'mine' && isVideoFile(what.file)) {
        if (what.file.size < 150 * 1024 * 1024) form.append('source', what.file);
        else toast('That video is too big to keep its sound, so it gets funny music.');
      }
      btn.textContent = 'Sending…';
    }
    const job = await sendJob(form);
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    renderJobs();
    $('#link').value = '';
    setFile(null);
    toast('Got it. You can close the app, it keeps working.');
    schedulePoll(2000);
  } catch (e) {
    note(msg, e.waking ? 'Your worker is waking up (takes up to a minute). Tap Make it again in a moment.' : e.message, 'bad');
    if (e.waking) wakeWorker();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Make it';
  }
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

async function picturesFromFile(file, count) {
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
    const samples = dur > 1 ? 12 : 1;
    const frames = [];
    for (let i = 0; i < samples; i++) {
      if (samples > 1) {
        video.currentTime = dur * (0.04 + (0.92 * i) / (samples - 1));
        await waitFor(video, 'seeked', 8000);
      }
      const canvas = drawScaled(video, video.videoWidth, video.videoHeight, 1024);
      frames.push({ t: video.currentTime, canvas, score: sharpness(canvas) });
    }
    // The sharpest moment in each part of the video, one per clip.
    const picks = [];
    for (let part = 0; part < count; part++) {
      const lo = (dur * part) / count;
      const hi = (dur * (part + 1)) / count;
      const inPart = frames.filter((f) => f.t >= lo && f.t <= hi);
      const pool = inPart.length ? inPart : frames;
      picks.push(pool.reduce((a, b) => (b.score > a.score ? b : a)));
    }
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
  return ['Ready', len, job.stage].filter(Boolean).join(' · ');
}

function renderJobs() {
  const box = $('#jobs');
  box.innerHTML = '';
  for (const job of state.jobs) {
    const card = document.createElement('article');
    card.className = `job ${job.status}`;
    card.innerHTML = `
      <button type="button" class="thumb" aria-label="Play"></button>
      <div class="job-body">
        <div class="job-title"></div>
        <div class="job-stage"></div>
        <div class="meter" hidden><span></span></div>
        <div class="job-actions"></div>
      </div>`;
    const thumb = $('.thumb', card);
    if (job.has_thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = mediaUrl(job, 'thumb');
      thumb.appendChild(img);
    }
    $('.job-title', card).textContent = job.label || (job.kind === 'surprise' ? 'Surprise' : 'Video');
    $('.job-stage', card).textContent = describe(job);
    if (job.status === 'working' || job.status === 'queued') {
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
    if (job.status === 'done') {
      const play = document.createElement('span');
      play.className = 'play';
      play.innerHTML = '<span><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></span>';
      thumb.appendChild(play);
      thumb.addEventListener('click', () => openPlayer(job));
      add('Watch & save', 'open', () => openPlayer(job));
      add('Copy caption', '', () => copyText(job.caption || ''));
    }
    if (job.status === 'failed' || job.status === 'waiting') add('Try again', '', () => retryJob(job));
    if (job.status !== 'working') add('Delete', 'danger', () => deleteJob(job));
    box.appendChild(card);
  }
}

let pollTimer;
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshJobs, ms);
}

async function refreshJobs() {
  if (!state.worker) return;
  try {
    const { jobs } = await api('/jobs');
    state.jobs = jobs;
    renderJobs();
    refreshHealth();
    renderWorkerDot(true);
    $('#wakeNote').hidden = true;
    const busy = jobs.some((j) => j.status === 'queued' || j.status === 'working');
    schedulePoll(document.hidden ? 60000 : busy ? 4000 : 30000);
  } catch (e) {
    renderWorkerDot(false);
    $('#wakeNote').hidden = false;
    $('#wakeNote').textContent = e.waking || e instanceof TypeError
      ? 'Waking up your worker… (up to a minute)'
      : `Worker problem: ${e.message}`;
    schedulePoll(6000);
  }
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

// Draws every option on the main screen from state.
function renderOptions() {
  const chips = (box, items, current, onPick) => {
    box.innerHTML = '';
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      b.setAttribute('aria-pressed', String(item.key === current));
      b.addEventListener('click', () => onPick(item.key));
      box.appendChild(b);
    }
  };
  chips($('#styleRow'), STYLES, state.style, (key) => {
    state.style = key;
    save(KEYS.style, key);
    renderOptions();
  });
  chips($('#musicRow'), MUSIC, state.music, (key) => {
    state.music = key;
    save(KEYS.music, key);
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
  setSeg('partSeg', state.part);
  setSeg('clipsSeg', state.clips);
  setSeg('lenSeg', state.seconds);
  setSeg('speedSeg', state.speed);
  $('#captionsOpt').checked = state.captions;
  $('#brandOpt').checked = state.brand;
}

function openPlayer(job) {
  state.playing = job;
  state.playingBlob = null;
  const video = $('#playerVideo');
  video.src = mediaUrl(job, 'video');
  $('#playerCaption').textContent = job.caption || '';
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

// ---------- Settings ----------

function openUpdate() {
  state.setupMode = 'update';
  openSettings();
}

function openSettings() {
  renderSettings();
  note($('#setupNote'), state.pending ? 'One quick setup first, then your video starts by itself.' : '');
  openDialog($('#settings'));
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
  const pcOn = Boolean(h && h.pc);
  const pcState = $('#pcState');
  pcState.textContent = pcOn ? `on · ${h.pc_name || 'PC'}` : 'off or not connected';
  pcState.classList.toggle('on', pcOn);
  $('#pcChip').hidden = !pcOn;
  const outdated = Boolean(state.worker && h && h.version !== WORKER_VERSION);
  $('#updateNote').hidden = !outdated;
  $('#updateBanner').hidden = !outdated;
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
  const updating = state.setupMode === 'update' && Boolean(state.worker);
  const ready = Boolean(state.worker) && !updating;
  $('#setupPane').hidden = ready;
  $('#optionsPane').hidden = !ready;
  $('#setupTitle').textContent = updating ? 'Update your worker' : 'One-time setup';
  $('#setupIntro').textContent = updating
    ? 'A new version of antics is ready. Paste your Hugging Face Write key (the one you used before works) and your worker updates itself. Your videos are kept.'
    : 'Your videos are made on your own free Hugging Face worker, so it keeps going when your phone is locked.';
  $('#setupBtn').textContent = updating ? 'Update my worker' : 'Set up my worker';
  $('#steps [data-step="create"]').textContent = updating ? 'Uploading the new version' : 'Creating your worker';
  $('#steps [data-step="build"]').textContent = updating ? 'Restarting with the new version (2–5 min)' : 'Building it (2–5 min, only once)';
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
  state.part = pickSaved(KEYS.part, ['auto', 'start', 'drop'], 'auto');
  state.seconds = pickSaved(KEYS.seconds, [3, 5], 5);
  state.speed = pickSaved(KEYS.speed, ['slow', 'normal', 'fast'], 'normal');
  state.brand = load(KEYS.brand, true) !== false;
  $('#idea').value = load(KEYS.idea, '');
  $('#animalOpt').value = load(KEYS.animal, '');
  renderOptions();

  const onSeg = (id, apply) => document.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
    apply(b.dataset.v);
    renderOptions();
  }));
  onSeg('partSeg', (v) => { state.part = v; save(KEYS.part, v); });
  onSeg('clipsSeg', (v) => { state.clips = Number(v); save(KEYS.clips, state.clips); });
  onSeg('lenSeg', (v) => { state.seconds = Number(v); save(KEYS.seconds, state.seconds); });
  onSeg('speedSeg', (v) => { state.speed = v; save(KEYS.speed, v); });
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
  if (state.worker) refreshJobs();
}

init();
