// app.js
// antics: paste a link (or upload a clip), tap Make it, and your own free Hugging Face worker
// turns the animal into a human-acting TikTok video in the background.

const HF = 'https://huggingface.co';
const SPACE_NAME = 'antics-worker';
const DATASET_NAME = 'antics-videos';
const WORKER_FILES = ['Dockerfile', 'README.md', 'requirements.txt', 'worker.py', 'ideas.py'];
const KEYS = { worker: 'antics.worker', clips: 'antics.clips', captions: 'antics.captions' };

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
    const space = `${user}/${SPACE_NAME}`;
    step('key', 'done');

    step('create', 'active');
    // Secrets can only be set when a Space is created, so an old worker is replaced.
    // Finished videos live in the dataset and are kept.
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
    const key = randomKey();
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

    const lines = [{ key: 'header', value: { summary: 'Set up the Animal Antics worker', description: '' } }];
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
    step('build', 'done');
    step('ready', 'done');
    renderSettings();
    renderWorkerDot(true);
    note(msg, 'All set. You can make videos now.', 'good');
    toast('Worker ready');
    refreshJobs();
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
    if (what.kind === 'link') form.append('url', what.url);
    if (what.kind === 'surprise') form.append('surprise', 'true');
    if (what.kind === 'file') {
      const pictures = await picturesFromFile(what.file, state.clips);
      pictures.forEach((blob, i) => form.append('images', blob, `picture_${i}.jpg`));
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

async function picturesFromFile(file, count) {
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|3gp)$/i.test(file.name);
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
    return `Out of free time for today. Finishes by itself around ${when}.`;
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

function openPlayer(job) {
  state.playing = job;
  state.playingBlob = null;
  const video = $('#playerVideo');
  video.src = mediaUrl(job, 'video');
  $('#playerCaption').textContent = job.caption || '';
  $('#playerSound').textContent = job.sound || 'any trending sound';
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

function openSettings() {
  renderSettings();
  note($('#setupNote'), state.pending ? 'One quick setup first, then your video starts by itself.' : '');
  openDialog($('#settings'));
}

function renderSettings() {
  const ready = Boolean(state.worker);
  $('#setupPane').hidden = ready;
  $('#optionsPane').hidden = !ready;
  if (ready) {
    const link = $('#workerLink');
    link.href = `${HF}/spaces/${state.worker.space}`;
    link.textContent = state.worker.space;
    $('#workerState').textContent = state.online ? '(running)' : '(asleep or starting)';
  }
  document.querySelectorAll('#clipsSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.clips) === state.clips)));
  $('#captionsOpt').checked = state.captions;
}

function init() {
  state.worker = load(KEYS.worker, null);
  state.clips = load(KEYS.clips, 3);
  state.captions = load(KEYS.captions, true);

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
  document.querySelectorAll('#clipsSeg button').forEach((b) => b.addEventListener('click', () => {
    state.clips = Number(b.dataset.clips);
    save(KEYS.clips, state.clips);
    renderSettings();
  }));
  $('#captionsOpt').addEventListener('change', (e) => {
    state.captions = e.target.checked;
    save(KEYS.captions, state.captions);
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
