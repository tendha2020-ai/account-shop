// app.js
// Animal Antics: pick an animal picture, pick a funny idea, let a free Hugging Face
// video model animate it, then stitch the clips into a 9:16 video for TikTok.

const GRADIO_CLIENT = 'https://cdn.jsdelivr.net/npm/@gradio/client@2.7.1/dist/browser.js';

// Free Wan image-to-video Spaces, tried in order. They all spend the same daily free GPU time.
const ENGINES = [
  { id: 'zerogpu-aoti/wan2-2-fp8da-aoti-faster', name: 'Wan 2.2', maxSec: 5, extra: { steps: 6 } },
  { id: 'r3gm/wan2-2-fp8da-aoti-preview', name: 'Wan 2.2 backup', maxSec: 5, extra: { steps: 6 } },
  { id: 'multimodalart/wan2-1-fast', name: 'Wan 2.1 backup', maxSec: 3.4, extra: { steps: 4 }, sized: true },
];
const IMAGE_SPACE = 'black-forest-labs/FLUX.1-schnell';

const OUT_W = 720;
const OUT_H = 1280;
const FPS = 30;
const KEYS = { token: 'antics.token', pet: 'antics.pet', petOther: 'antics.petOther', sec: 'antics.sec', mode: 'antics.mode' };

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  mode: 'upload',
  token: '',
  pet: 'dog',
  sec: 5,
  upload: { blob: null, video: null },
  surprise: null,
  ideas: [],
  chosen: null,
  promptEdited: false,
  busy: false,
  clips: [],
  exportBlob: null,
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
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: settings just won't persist
  }
}

// ---------- Small helpers ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
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
  toast('Copied!');
}

function showStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function errText(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  return e.message || e.detail || e.title || JSON.stringify(e);
}

function isQuotaError(msg) {
  return /quota|runs limit|gpu limit|exceeded your/i.test(msg);
}

function friendlyError(e) {
  const msg = errText(e);
  if (isQuotaError(msg)) {
    const wait = msg.match(/try again in ([\d:]+)/i);
    return `Today's free video time is used up${wait ? ` (it comes back in ${wait[1]})` : ''}. ` +
      'Meanwhile you can use a free app: open "Out of free tries?" below.';
  }
  if (/\b401\b|unauthori[sz]ed|invalid (user )?token|credentials/i.test(msg)) {
    return 'Your free key did not work. Tap 🔑 Free key at the top and paste it again.';
  }
  if (/nsfw|safety|inappropriate|not allowed/i.test(msg)) {
    return 'The engine refused this idea. Pick another idea and try again.';
  }
  if (/sleep|building|paused|runtime error|could not|failed to fetch|networkerror|load failed|timed? ?out|connection/i.test(msg)) {
    return 'The free engines are busy or offline right now. Try again in a few minutes.';
  }
  return 'Something went wrong: ' + msg;
}

function waitFor(el, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error('Timed out loading media')), ms);
    const ok = () => done(resolve);
    const bad = () => done(reject, new Error('This file could not be opened here'));
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

function timeoutSignal(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not save the picture'))), type, quality);
  });
}

// Draw a video frame or image onto a canvas no bigger than maxSide.
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
  const w = 160;
  const h = Math.max(2, Math.round((canvas.height / canvas.width) * w));
  const small = drawScaled(canvas, canvas.width, canvas.height, Math.max(w, h));
  const { data, width, height } = small.getContext('2d').getImageData(0, 0, small.width, small.height);
  const grey = new Float32Array(width * height);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
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
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

async function imageSize(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file] }).catch(() => {});
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return Promise.resolve();
}

// ---------- Free Hugging Face engines ----------

let gradioModule;
async function gradio() {
  if (!gradioModule) {
    try {
      gradioModule = await import(GRADIO_CLIENT);
    } catch {
      throw new Error('Could not load the free engine. Check your internet connection.');
    }
  }
  return gradioModule;
}

// Runs one Space endpoint and returns its output list.
async function runSpace(spaceId, endpoint, payload, onStatus) {
  const { Client } = await gradio();
  const app = await Client.connect(spaceId, {
    token: state.token || undefined,
    events: ['data', 'status'],
  });
  const job = app.submit(endpoint, payload);
  for await (const msg of job) {
    if (msg.type === 'status') {
      if (msg.stage === 'error') throw new Error(msg.message || 'The free engine returned an error');
      if (onStatus) onStatus(msg);
    } else if (msg.type === 'data') {
      return msg.data;
    }
  }
  throw new Error('The free engine did not send a result');
}

// Gradio file outputs come back as {url} or {video: {url}}.
async function fetchOutput(out) {
  const file = out && out.video ? out.video : out;
  const url = typeof file === 'string' ? file : file && (file.url || file.path);
  if (!url) throw new Error('The free engine sent no file');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the result (${res.status})`);
  return res.blob();
}

function wan21Size({ w, h }) {
  if (h > w * 1.15) return { height: 896, width: 512 };
  if (w > h * 1.15) return { height: 512, width: 896 };
  return { height: 640, width: 640 };
}

async function generateClip(frame, prompt, sec, onText) {
  const { handle_file } = await gradio();
  const dims = await imageSize(frame);
  let lastErr;
  for (const engine of ENGINES) {
    onText(`Connecting to ${engine.name}…`);
    try {
      const payload = {
        input_image: handle_file(frame),
        prompt,
        duration_seconds: Math.min(sec, engine.maxSec),
        randomize_seed: true,
        ...engine.extra,
      };
      if (engine.sized) Object.assign(payload, wan21Size(dims));
      const data = await runSpace(engine.id, '/generate_video', payload, (s) => {
        if (s.stage === 'pending' && s.queue && s.position != null) {
          onText(`In line at ${engine.name}: you are number ${s.position + 1}…`);
        } else if (s.stage === 'pending' || s.stage === 'generating' || s.stage === 'streaming') {
          onText(`${engine.name} is animating your ${animalName()}… (about 1–2 min)`);
        }
      });
      const blob = await fetchOutput(data[0]);
      return { blob, engine };
    } catch (e) {
      const msg = errText(e);
      // Quota and key problems are account-wide, so another engine won't help.
      if (isQuotaError(msg) || /\b401\b|unauthori[sz]ed|invalid (user )?token/i.test(msg)) throw e;
      console.warn(engine.id, msg);
      lastErr = e;
    }
  }
  throw lastErr;
}

// A random picture for Surprise mode: Pollinations first (no GPU time used), then FLUX on Hugging Face.
async function makeSurprisePicture(prompt) {
  const seed = Math.floor(Math.random() * 1e9);
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=576&height=1024&nologo=true&seed=${seed}`;
    const res = await fetch(url, { signal: timeoutSignal(40000) });
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) return await res.blob();
  } catch {
    // busy or offline: fall back to FLUX below
  }
  const data = await runSpace(IMAGE_SPACE, '/infer', {
    prompt, seed, randomize_seed: false, width: 576, height: 1024, num_inference_steps: 4,
  });
  return fetchOutput(data[0]);
}

// ---------- Step 1: starting picture ----------

function animalName() {
  if (state.mode === 'surprise' && state.surprise) return state.surprise.animal;
  if (state.pet === 'other') return $('#petOther').value.trim().toLowerCase() || 'animal';
  const pet = PET_CHOICES.find((p) => p.key === state.pet);
  return pet ? pet.label.toLowerCase() : 'animal';
}

function currentFrame() {
  return state.mode === 'surprise' ? state.surprise && state.surprise.blob : state.upload.blob;
}

let previewUrl;
function showPreview() {
  const blob = currentFrame();
  const wrap = $('#framePreviewWrap');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (!blob) {
    wrap.hidden = true;
    return;
  }
  previewUrl = URL.createObjectURL(blob);
  $('#framePreview').src = previewUrl;
  wrap.hidden = false;
}

function setMode(mode) {
  state.mode = mode;
  save(KEYS.mode, mode);
  document.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('#uploadPane').hidden = mode !== 'upload';
  $('#surprisePane').hidden = mode !== 'surprise';
  showStatus($('#step1Status'), '');
  if (mode === 'surprise' && !state.surprise) newSurprise();
  showPreview();
  refreshIdeas();
}

function renderPetChips() {
  const box = $('#petChips');
  box.innerHTML = '';
  for (const p of [...PET_CHOICES, { key: 'other', label: 'Other', emoji: '✏️' }]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `${p.emoji} ${p.label}`;
    b.setAttribute('aria-pressed', String(state.pet === p.key));
    b.addEventListener('click', () => {
      state.pet = p.key;
      save(KEYS.pet, p.key);
      renderPetChips();
      if (p.key === 'other') $('#petOther').focus();
      refreshIdeas();
    });
    box.appendChild(b);
  }
  $('#petOther').hidden = state.pet !== 'other';
}

async function useFrameCanvas(canvas) {
  state.upload.blob = await canvasToBlob(canvas);
  showPreview();
}

async function onSourceFile(file) {
  if (!file) return;
  const status = $('#step1Status');
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|3gp)$/i.test(file.name);
  $('#framePicker').hidden = true;
  if (state.upload.video) {
    URL.revokeObjectURL(state.upload.video.src);
    state.upload.video.remove();
    state.upload.video = null;
  }
  try {
    if (!isVideo) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        await useFrameCanvas(drawScaled(img, img.naturalWidth, img.naturalHeight, 1024));
      } finally {
        URL.revokeObjectURL(url);
      }
      showStatus(status, '');
      return;
    }
    showStatus(status, 'Looking for the best moment in your clip…');
    await loadVideoFrames(file);
    showStatus(status, '');
  } catch (e) {
    showStatus(status, `${errText(e)}. Try another clip, or a screenshot/photo of the animal.`, 'bad');
  }
}

function grabFrame(video) {
  return drawScaled(video, video.videoWidth, video.videoHeight, 1024);
}

async function seekTo(video, t) {
  video.currentTime = t;
  await waitFor(video, 'seeked', 8000);
}

async function loadVideoFrames(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  offstage().appendChild(video);
  state.upload.video = video;
  await waitFor(video, 'loadeddata');
  try {
    // iPhones only hand out frames after playback has started once.
    await video.play();
    video.pause();
  } catch {
    // autoplay refused: seeking still works on most browsers
  }
  const dur = Number.isFinite(video.duration) ? video.duration : 0;
  const count = dur > 1 ? 8 : 1;
  const frames = [];
  for (let i = 0; i < count; i++) {
    if (count > 1) await seekTo(video, (dur * (i + 0.5)) / count);
    const canvas = grabFrame(video);
    frames.push({ t: video.currentTime, canvas, score: sharpness(canvas) });
  }
  const best = frames.reduce((a, b) => (b.score > a.score ? b : a));

  const strip = $('#frameStrip');
  strip.innerHTML = '';
  for (const f of frames) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(f === best));
    b.setAttribute('aria-label', `Moment at ${f.t.toFixed(1)} seconds`);
    const img = document.createElement('img');
    img.src = drawScaled(f.canvas, f.canvas.width, f.canvas.height, 172).toDataURL('image/jpeg', 0.75);
    b.appendChild(img);
    b.addEventListener('click', async () => {
      strip.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('#scrub').value = dur ? Math.round((f.t / dur) * 1000) : 0;
      await useFrameCanvas(f.canvas);
    });
    strip.appendChild(b);
  }
  $('#scrub').value = dur ? Math.round((best.t / dur) * 1000) : 0;
  $('#scrub').disabled = count === 1;
  $('#framePicker').hidden = false;
  await useFrameCanvas(best.canvas);
}

let scrubTimer;
function onScrub() {
  const video = state.upload.video;
  if (!video || !Number.isFinite(video.duration)) return;
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(async () => {
    try {
      await seekTo(video, (Number($('#scrub').value) / 1000) * video.duration);
      $('#frameStrip').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      await useFrameCanvas(grabFrame(video));
    } catch {
      // seek failed: keep the previous frame
    }
  }, 150);
}

let surpriseToken = 0;
async function newSurprise() {
  const scene = randomScene();
  const mine = ++surpriseToken;
  state.surprise = { ...scene, blob: null };
  $('#surpriseDesc').textContent = `${scene.style.t}: ${fillAnimal(scene.scene.s, scene.animal)}`;
  showPreview();
  refreshIdeas();
  const btn = $('#newSurprise');
  btn.disabled = true;
  showStatus($('#step1Status'), '🎨 Painting a random picture… (10–40 sec)');
  try {
    const blob = await makeSurprisePicture(scene.prompt);
    if (mine !== surpriseToken) return;
    state.surprise.blob = blob;
    showStatus($('#step1Status'), '');
    showPreview();
  } catch (e) {
    if (mine !== surpriseToken) return;
    const needKey = !state.token && isQuotaError(errText(e));
    showStatus($('#step1Status'), needKey
      ? 'The free picture maker is busy. Add your free key (🔑 at the top) and tap New random picture again.'
      : friendlyError(e), 'bad');
  } finally {
    if (mine === surpriseToken) btn.disabled = false;
  }
}

// ---------- Step 2: ideas ----------

function refreshIdeas() {
  const animal = animalName();
  state.ideas = state.mode === 'surprise' && state.surprise
    ? ideasForScene(state.surprise.scene, state.surprise.animal)
    : ideasForPicture(animal);
  const grid = $('#ideaGrid');
  grid.innerHTML = '';
  state.ideas.forEach((idea, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'idea';
    b.innerHTML = '<span class="emoji"></span><strong></strong><small></small>';
    b.querySelector('.emoji').textContent = idea.emoji;
    b.querySelector('strong').textContent = idea.title;
    b.querySelector('small').textContent = `The ${animal} ${idea.action}`;
    b.addEventListener('click', () => chooseIdea(i));
    grid.appendChild(b);
  });
  chooseIdea(0);
}

function chooseIdea(i) {
  state.chosen = state.ideas[i];
  document.querySelectorAll('#ideaGrid .idea').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  state.promptEdited = false;
  updatePrompt();
}

function updatePrompt() {
  if (!state.chosen || state.promptEdited) return;
  $('#prompt').value = videoPrompt(state.chosen, animalName(), $('#twist').checked);
  updateKit();
}

// ---------- Step 3: make ----------

function setBusy(on, text = '') {
  state.busy = on;
  $('#makeVideo').disabled = on;
  $('#progress').hidden = !on;
  $('#progressText').textContent = text;
}

async function makeVideo() {
  if (state.busy) return;
  const status = $('#makeStatus');
  const frame = currentFrame();
  if (!frame) {
    showStatus(status, state.mode === 'surprise'
      ? 'Wait for the random picture to finish (step 1).'
      : 'First choose a video or photo of your animal in step 1.', 'bad');
    $('#step1').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const prompt = $('#prompt').value.trim();
  if (!prompt) {
    showStatus(status, 'Pick an idea or write a prompt in step 2.', 'bad');
    return;
  }
  if (!state.token) {
    showStatus(status, 'One-time setup: add your free key, then tap Make video again.', 'bad');
    openSettings();
    return;
  }

  showStatus(status, '');
  const started = Date.now();
  let lastText = 'Starting…';
  setBusy(true, lastText);
  const ticker = setInterval(() => {
    $('#progressText').textContent = `${lastText} ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  try {
    const { blob, engine } = await generateClip(frame, prompt, state.sec, (t) => {
      lastText = t;
      $('#progressText').textContent = t;
    });
    const idea = state.chosen;
    await addClip({
      blob,
      title: idea ? `${idea.emoji} ${idea.title}` : '✍️ My idea',
      caption: idea ? idea.caption : '',
      source: engine.name,
    });
    showStatus(status, '✅ Done! Your clip is in step 4. Make more, then export.', 'good');
    toast('New clip ready 🎉');
  } catch (e) {
    showStatus(status, friendlyError(e), 'bad');
  } finally {
    clearInterval(ticker);
    setBusy(false);
  }
}

// ---------- Step 4: clips (kept in IndexedDB so they survive a refresh) ----------

const DB_NAME = 'animal-antics';
const STORE = 'clips';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbRun(mode, fn) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return null; // storage blocked: clips live in memory for this visit only
  }
}

function clipRecord(c) {
  const { url, ...rest } = c;
  return rest;
}

function persistClip(c) {
  return dbRun('readwrite', (s) => s.put(clipRecord(c)));
}

function persistOrder() {
  state.clips.forEach((c, i) => { c.order = i; });
  return dbRun('readwrite', (s) => {
    state.clips.forEach((c) => s.put(clipRecord(c)));
  });
}

async function loadClips() {
  const rows = (await dbRun('readonly', (s) => s.getAll())) || [];
  rows.sort((a, b) => a.order - b.order);
  state.clips = rows.map((r) => ({ ...r, url: URL.createObjectURL(r.blob) }));
  renderClips();
  updateKit();
}

async function addClip({ blob, title, caption, source }) {
  const clip = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    blob, title, caption, source,
    include: true,
    order: state.clips.length,
    url: URL.createObjectURL(blob),
  };
  state.clips.push(clip);
  await persistClip(clip);
  renderClips();
  updateKit();
  return clip;
}

function moveClip(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.clips.length) return;
  [state.clips[i], state.clips[j]] = [state.clips[j], state.clips[i]];
  persistOrder();
  renderClips();
  updateKit();
}

async function deleteClip(i) {
  const [clip] = state.clips.splice(i, 1);
  URL.revokeObjectURL(clip.url);
  await dbRun('readwrite', (s) => s.delete(clip.id));
  persistOrder();
  renderClips();
  updateKit();
}

function renderClips() {
  const list = $('#clipList');
  list.innerHTML = '';
  $('#clipCount').textContent = String(state.clips.length);
  state.clips.forEach((clip, i) => {
    const row = document.createElement('div');
    row.className = 'clip' + (clip.include ? '' : ' off');
    row.innerHTML = `
      <video muted playsinline loop preload="metadata"></video>
      <div class="clip-body">
        <div class="clip-title"></div>
        <input class="input" type="text" maxlength="80" placeholder="Text on video (optional)">
        <div class="clip-actions">
          <label class="toggle"><input type="checkbox"> Use</label>
          <button type="button" class="btn ghost" data-act="up" aria-label="Move up">⬆️</button>
          <button type="button" class="btn ghost" data-act="down" aria-label="Move down">⬇️</button>
          <button type="button" class="btn ghost" data-act="save" aria-label="Save clip">💾</button>
          <button type="button" class="btn ghost" data-act="del" aria-label="Delete clip">🗑️</button>
        </div>
      </div>`;
    const video = $('video', row);
    video.src = clip.url + '#t=0.1';
    video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
    $('.clip-title', row).textContent = `${i + 1}. ${clip.title}`;
    const cap = $('input[type="text"]', row);
    cap.value = clip.caption || '';
    cap.addEventListener('change', () => {
      clip.caption = cap.value.trim();
      persistClip(clip);
      updateKit();
    });
    const use = $('input[type="checkbox"]', row);
    use.checked = clip.include;
    use.addEventListener('change', () => {
      clip.include = use.checked;
      row.classList.toggle('off', !clip.include);
      persistClip(clip);
      updateKit();
    });
    $('[data-act="up"]', row).addEventListener('click', () => moveClip(i, -1));
    $('[data-act="down"]', row).addEventListener('click', () => moveClip(i, 1));
    $('[data-act="save"]', row).addEventListener('click', () => saveFile(clip.blob, `antics-clip-${i + 1}.${extFor(clip.blob.type)}`));
    $('[data-act="del"]', row).addEventListener('click', () => {
      if (confirm('Delete this clip?')) deleteClip(i);
    });
    list.appendChild(row);
  });
}

async function onAddClips(files) {
  for (const file of files) {
    await addClip({ blob: file, title: `📱 ${file.name}`, caption: '', source: 'phone' });
  }
  if (files.length) toast(`Added ${files.length} clip${files.length > 1 ? 's' : ''}`);
}

// ---------- Step 5: export (canvas + MediaRecorder, all on the phone) ----------

function offstage() {
  let box = $('#offstage');
  if (!box) {
    box = document.createElement('div');
    box.id = 'offstage';
    box.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;';
    document.body.appendChild(box);
  }
  return box;
}

function extFor(type) {
  if (/mp4/.test(type)) return 'mp4';
  if (/quicktime/.test(type)) return 'mov';
  return 'webm';
}

function pickMime() {
  if (!window.MediaRecorder) return null;
  const options = [
    'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
  ];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function coverRect(sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const w = dw / scale;
  const h = dh / scale;
  return [(sw - w) / 2, (sh - h) / 2, w, h];
}

const blurCanvas = document.createElement('canvas');
blurCanvas.width = 27;
blurCanvas.height = 48;

function drawFrame(ctx, video, caption, fill) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const ratio = (vw / vh) / (OUT_W / OUT_H);
  if (fill || (ratio > 0.88 && ratio < 1.14)) {
    ctx.drawImage(video, ...coverRect(vw, vh, OUT_W, OUT_H), 0, 0, OUT_W, OUT_H);
  } else {
    // Soft blurred copy behind, whole clip on top: works on every browser, no canvas filters needed.
    const b = blurCanvas.getContext('2d');
    b.drawImage(video, ...coverRect(vw, vh, blurCanvas.width, blurCanvas.height), 0, 0, blurCanvas.width, blurCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, 0, 0, OUT_W, OUT_H);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    const s = Math.min(OUT_W / vw, OUT_H / vh);
    ctx.drawImage(video, (OUT_W - vw * s) / 2, (OUT_H - vh * s) / 2, vw * s, vh * s);
  }
  if (caption) drawCaption(ctx, caption);
}

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawCaption(ctx, text) {
  const size = 50;
  ctx.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const lines = wrapLines(ctx, text, OUT_W * 0.84);
  let y = OUT_H * 0.15;
  for (const line of lines) {
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#000';
    ctx.strokeText(line, OUT_W / 2, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(line, OUT_W / 2, y);
    y += size * 1.2;
  }
}

async function loadPlayer(url) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.src = url;
  offstage().appendChild(video);
  await waitFor(video, 'loadeddata', 20000);
  return video;
}

function playInto(video, ctx, caption, fill, onTick) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      drawFrame(ctx, video, caption, fill);
      resolve();
    };
    const tick = () => {
      if (finished) return;
      drawFrame(ctx, video, caption, fill);
      onTick(video.currentTime);
      if (video.ended) finish();
      else requestAnimationFrame(tick);
    };
    video.addEventListener('ended', finish, { once: true });
    video.addEventListener('error', () => reject(new Error('A clip could not be played')), { once: true });
    // Safety net in case "ended" never fires.
    setTimeout(finish, ((video.duration || 10) + 4) * 1000);
    video.currentTime = 0;
    video.play().then(() => requestAnimationFrame(tick), reject);
  });
}

async function exportVideo() {
  const status = $('#exportStatus');
  const chosen = state.clips.filter((c) => c.include);
  if (!chosen.length) {
    showStatus(status, 'Tick at least one clip in step 4.', 'bad');
    return;
  }
  const mime = pickMime();
  const canvas = document.createElement('canvas');
  if (mime === null || !canvas.captureStream) {
    showStatus(status, "This browser can't export video. Open the page in Safari or Chrome.", 'bad');
    return;
  }
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  const withCaptions = $('#optCaptions').checked;
  const fill = $('#optFill').checked;
  $('#exportVideo').disabled = true;
  $('#exportProgress').hidden = false;
  $('#exportResult').hidden = true;
  $('#exportBar').style.width = '0%';
  $('#exportText').textContent = 'Getting clips ready… keep this screen open.';
  showStatus(status, '');

  const players = [];
  try {
    for (const clip of chosen) players.push(await loadPlayer(clip.url));
    const total = players.reduce((sum, v) => sum + (Number.isFinite(v.duration) ? v.duration : 5), 0);

    const stream = canvas.captureStream(FPS);
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

    drawFrame(ctx, players[0], withCaptions ? chosen[0].caption : '', fill);
    recorder.start(500);
    let done = 0;
    for (let i = 0; i < players.length; i++) {
      $('#exportText').textContent = `Recording clip ${i + 1} of ${players.length}… keep this screen open.`;
      await playInto(players[i], ctx, withCaptions ? chosen[i].caption : '', fill, (t) => {
        $('#exportBar').style.width = `${Math.min(100, ((done + t) / total) * 100)}%`;
      });
      done += Number.isFinite(players[i].duration) ? players[i].duration : 5;
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const type = (recorder.mimeType || mime || 'video/webm').split(';')[0];
    state.exportBlob = new Blob(chunks, { type });
    const url = URL.createObjectURL(state.exportBlob);
    const el = $('#exportVideoEl');
    if (el.src) URL.revokeObjectURL(el.src);
    el.src = url;
    const link = $('#downloadVideo');
    link.href = url;
    link.download = `animal-antics-${Date.now()}.${extFor(type)}`;
    $('#exportBar').style.width = '100%';
    $('#exportResult').hidden = false;
    showStatus(status, '✅ Your TikTok video is ready. Save it, then add a sound in TikTok.', 'good');
  } catch (e) {
    showStatus(status, `Export failed: ${errText(e)}`, 'bad');
  } finally {
    players.forEach((v) => v.remove());
    $('#exportVideo').disabled = false;
    $('#exportProgress').hidden = true;
  }
}

// ---------- Posting kit ----------

function updateKit() {
  const first = state.clips.find((c) => c.include && c.caption);
  const caption = first ? first.caption : state.chosen ? state.chosen.caption : 'Okay...';
  $('#kitCaption').textContent = `${caption} ${HASHTAGS}`;
}

function renderSounds() {
  const box = $('#soundChips');
  for (const name of SOUND_IDEAS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `🎵 ${name}`;
    b.addEventListener('click', () => copyText(name));
    box.appendChild(b);
  }
}

// ---------- Free key settings ----------

function renderKeyState() {
  $('#keyState').classList.toggle('on', Boolean(state.token));
}

function openSettings() {
  $('#tokenInput').value = state.token;
  showStatus($('#tokenStatus'), '');
  const dlg = $('#settings');
  if (dlg.showModal) dlg.showModal();
  else dlg.setAttribute('open', '');
}

async function saveToken() {
  const tok = $('#tokenInput').value.trim();
  const status = $('#tokenStatus');
  if (!/^hf_[A-Za-z0-9]{20,}$/.test(tok)) {
    showStatus(status, 'That doesn\'t look like a key. It should start with hf_', 'bad');
    return;
  }
  showStatus(status, 'Checking…');
  try {
    const res = await fetch('https://huggingface.co/api/whoami-v2', { headers: { Authorization: `Bearer ${tok}` } });
    if (res.status === 401) {
      showStatus(status, 'Hugging Face says this key is not valid. Copy it again.', 'bad');
      return;
    }
    const who = res.ok ? await res.json() : null;
    state.token = tok;
    save(KEYS.token, tok);
    renderKeyState();
    showStatus(status, who && who.name ? `✅ Saved. Hi ${who.name}! You can make videos now.` : '✅ Saved.', 'good');
  } catch {
    state.token = tok;
    save(KEYS.token, tok);
    renderKeyState();
    showStatus(status, 'Saved, but I could not check it right now (no connection?).', 'good');
  }
}

function clearToken() {
  state.token = '';
  save(KEYS.token, '');
  $('#tokenInput').value = '';
  renderKeyState();
  showStatus($('#tokenStatus'), 'Key removed from this phone.');
}

// ---------- Wire up ----------

function init() {
  state.token = load(KEYS.token, '');
  state.pet = load(KEYS.pet, 'dog');
  state.sec = load(KEYS.sec, 5);
  $('#petOther').value = load(KEYS.petOther, '');

  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#sourceFile').addEventListener('change', (e) => onSourceFile(e.target.files[0]));
  $('#scrub').addEventListener('input', onScrub);
  $('#petOther').addEventListener('input', () => {
    save(KEYS.petOther, $('#petOther').value);
    updatePrompt();
  });
  $('#petOther').addEventListener('change', refreshIdeas);
  $('#newSurprise').addEventListener('click', newSurprise);
  $('#saveFrame').addEventListener('click', () => {
    const blob = currentFrame();
    if (blob) saveFile(blob, `antics-picture-${Date.now()}.jpg`);
  });

  $('#shuffleIdeas').addEventListener('click', refreshIdeas);
  $('#twist').addEventListener('change', updatePrompt);
  $('#prompt').addEventListener('input', () => { state.promptEdited = true; });

  document.querySelectorAll('#lenChips .chip').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.sec) === state.sec));
    b.addEventListener('click', () => {
      state.sec = Number(b.dataset.sec);
      save(KEYS.sec, state.sec);
      document.querySelectorAll('#lenChips .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });
  $('#makeVideo').addEventListener('click', makeVideo);
  $('#copyPrompt').addEventListener('click', () => copyText($('#prompt').value));

  $('#addClip').addEventListener('change', async (e) => {
    await onAddClips([...e.target.files]);
    e.target.value = '';
  });

  $('#exportVideo').addEventListener('click', exportVideo);
  $('#shareVideo').addEventListener('click', () => {
    if (state.exportBlob) saveFile(state.exportBlob, $('#downloadVideo').download);
  });
  $('#copyCaption').addEventListener('click', () => copyText($('#kitCaption').textContent));

  $('#openSettings').addEventListener('click', openSettings);
  $('#saveToken').addEventListener('click', saveToken);
  $('#clearToken').addEventListener('click', clearToken);

  renderPetChips();
  renderSounds();
  renderKeyState();
  setMode(load(KEYS.mode, 'upload') === 'surprise' ? 'surprise' : 'upload');
  loadClips();
}

init();
