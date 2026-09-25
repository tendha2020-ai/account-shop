// app.js
// Screen logic for Video to MP3: file picking, the conversion queue, the waveform
// display, preview playback and saving (download, share sheet, or the claude.ai
// viewer's save prompt when this page runs as an Artifact).

(function () {
  'use strict';

  const C = window.V2M && window.V2M.convert;
  const $ = (selector, root = document) => root.querySelector(selector);

  const els = {
    picker: $('#picker'),
    pick: $('#pick'),
    input: $('#file-input'),
    list: $('#list'),
    empty: $('#empty'),
    saveAll: $('#save-all'),
    clear: $('#clear-list'),
    hostNote: $('#host-note'),
    installTip: $('#install-tip'),
    toast: $('#toast'),
    audio: $('#player'),
  };

  const ICONS = {
    play: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" fill="currentColor"/></svg>',
    pause: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/><rect x="14" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/></svg>',
    close: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    save: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/></svg>',
    share: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 7.5 12 3.5l4 4M7 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H17"/></svg>',
  };

  const STAGE_TEXT = { reading: 'Reading video', decoding: 'Decoding sound', encoding: 'Encoding MP3' };
  const STAGE_READOUT = { reading: 'Read', decoding: 'Decode', encoding: 'Enc' };

  const items = [];
  let nextId = 1;
  let busy = false;

  // ---------- where the page is running ----------

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  const isAndroid = /Android/i.test(ua);
  const inClaude = !!(window.claude && typeof window.claude.use === 'function');
  let host = null; // the viewer's `downloads` capability when this page is a claude.ai Artifact
  let hostChecked = !inClaude;

  if (inClaude) {
    window.claude.use('downloads').then((downloads) => {
      host = downloads || null;
      hostChecked = true;
      items.forEach(renderActions);
      updateChrome();
    }, () => {
      hostChecked = true;
      updateChrome();
    });
  }

  if (!C || !window.V2M.mp4) {
    showFatal("The converter didn't load. Check your connection and reload the page.");
    return;
  }

  if (isAndroid && els.installTip) {
    const dd = els.installTip.querySelector('dd');
    if (dd) dd.textContent = "In Chrome's menu, tap Add to Home screen (or Install app). After the first visit it also works offline.";
  }

  // ---------- quality ----------

  const QUALITY_KEY = 'video-to-mp3:kbps';
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    const radio = saved && document.getElementById(`kbps-${saved}`);
    if (radio) radio.checked = true;
  } catch (err) {
    // storage unavailable: keep the default
  }
  document.querySelectorAll('input[name="kbps"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try { localStorage.setItem(QUALITY_KEY, radio.value); } catch (err) { /* ignore */ }
    });
  });
  const currentKbps = () => Number((document.querySelector('input[name="kbps"]:checked') || {}).value) || 192;

  // ---------- adding files ----------

  els.pick.addEventListener('click', () => {
    els.input.value = '';
    els.input.click();
  });
  els.input.addEventListener('change', () => {
    addFiles(els.input.files);
    els.input.value = '';
  });

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  ['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    els.picker.classList.add('drag');
  }));
  ['dragleave', 'dragend'].forEach((type) => document.addEventListener(type, (e) => {
    if (type === 'dragleave' && e.relatedTarget) return;
    els.picker.classList.remove('drag');
  }));
  document.addEventListener('drop', (e) => {
    els.picker.classList.remove('drag');
    if (!hasFiles(e)) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let first = null;
    for (const file of files) {
      const item = {
        id: nextId++,
        file,
        sourceName: file.name || 'video',
        sourceSize: file.size,
        filename: `${C.baseName(file.name)}.mp3`,
        state: 'queued',
        stage: null,
        progress: 0,
        kbps: 0,
        peaks: null,
        peakMax: 0,
        duration: 0,
        channels: 0,
        info: null,
        blob: null,
        url: null,
        error: '',
        saved: false,
        controller: null,
        frame: 0,
      };
      item.els = buildItem(item);
      items.push(item);
      els.list.appendChild(item.els.root);
      render(item);
      first = first || item;
    }
    updateChrome();
    if (first) first.els.root.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    pump();
  }

  // ---------- the queue ----------

  async function pump() {
    if (busy) return;
    busy = true;
    keepAwake(true);
    try {
      let item;
      while ((item = items.find((i) => i.state === 'queued'))) await convert(item);
    } finally {
      busy = false;
      keepAwake(false);
      updateChrome();
    }
  }

  async function convert(item) {
    item.state = 'working';
    item.stage = 'reading';
    item.kbps = currentKbps();
    item.controller = typeof AbortController === 'function' ? new AbortController() : null;
    render(item);
    try {
      const result = await C.convertFile(item.file, {
        kbps: item.kbps,
        signal: item.controller && item.controller.signal,
        onProgress: (fraction, stage) => {
          item.progress = fraction;
          item.stage = stage;
          scheduleRender(item);
        },
        onDecoded: (decoded) => {
          item.peaks = decoded.peaks;
          item.peakMax = Math.max(0.02, ...decoded.peaks);
          item.duration = decoded.duration;
          item.channels = decoded.channels;
          item.info = decoded.info;
          scheduleRender(item);
        },
      });
      if (item.removed) return;
      item.blob = result.blob;
      item.filename = result.filename;
      item.url = URL.createObjectURL(result.blob);
      item.state = 'done';
      item.file = null;
    } catch (err) {
      if (item.removed) return;
      item.state = 'error';
      item.error = describeError(err);
      item.errorCode = err && err.code;
    } finally {
      item.controller = null;
    }
    render(item);
    updateChrome();
  }

  function describeError(err) {
    if (err && err.name === 'ConvertError') return err.message;
    if (err && (err.name === 'RangeError' || /memory/i.test(String(err.message)))) {
      return 'This phone ran out of memory for this file. Try a shorter video.';
    }
    return 'Something went wrong while converting this file. Try it again, or try another video.';
  }

  function removeItem(item) {
    item.removed = true;
    if (item.controller) item.controller.abort();
    if (Player.current === item) Player.stop();
    if (item.url) URL.revokeObjectURL(item.url);
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
    item.els.root.remove();
    updateChrome();
  }

  // ---------- item view ----------

  function buildItem(item) {
    const root = document.createElement('li');
    root.className = 'item';
    root.innerHTML = `
      <div class="item-top">
        <button class="play" type="button" disabled>${ICONS.play}</button>
        <div class="item-text">
          <p class="item-name"></p>
          <p class="item-meta"></p>
        </div>
        <button class="remove" type="button">${ICONS.close}</button>
      </div>
      <div class="screen">
        <canvas aria-hidden="true"></canvas>
        <span class="readout" aria-hidden="true"></span>
        <span class="readout right" aria-hidden="true"></span>
      </div>
      <p class="item-status"></p>
      <div class="item-actions" hidden></div>`;
    const parts = {
      root,
      play: $('.play', root),
      name: $('.item-name', root),
      meta: $('.item-meta', root),
      remove: $('.remove', root),
      screen: $('.screen', root),
      canvas: $('canvas', root),
      readout: $('.readout', root),
      readoutRight: $('.readout.right', root),
      status: $('.item-status', root),
      actions: $('.item-actions', root),
    };
    parts.name.textContent = item.filename;
    parts.remove.setAttribute('aria-label', `Remove ${item.filename}`);
    parts.remove.addEventListener('click', () => removeItem(item));
    parts.play.addEventListener('click', () => Player.toggle(item));
    parts.screen.addEventListener('click', (e) => {
      if (item.state !== 'done') return;
      const rect = parts.screen.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      Player.playFrom(item, fraction);
    });
    return parts;
  }

  function scheduleRender(item) {
    if (item.frame) return;
    item.frame = requestAnimationFrame(() => {
      item.frame = 0;
      render(item);
    });
  }

  function render(item) {
    const e = item.els;
    e.root.dataset.state = item.state;
    e.name.textContent = item.filename;
    e.meta.textContent = metaText(item);

    const playing = Player.isPlaying(item);
    e.play.disabled = item.state !== 'done';
    const icon = playing ? 'pause' : 'play';
    if (e.play.dataset.icon !== icon) {
      e.play.dataset.icon = icon;
      e.play.innerHTML = ICONS[icon];
      e.play.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${item.filename}`);
    }

    let left = '';
    let right = '';
    let status = '';
    if (item.state === 'queued') {
      left = 'Queued';
      status = 'Waiting for the file before it.';
    } else if (item.state === 'working') {
      const pct = Math.floor(item.progress * 100);
      left = `${STAGE_READOUT[item.stage] || 'Work'} ${pct}%`;
      status = `${STAGE_TEXT[item.stage] || 'Converting'}… ${pct}%`;
      if (item.duration > 1800) status += ' Long video: this can take a few minutes.';
    } else if (item.state === 'done') {
      const pos = Player.current === item ? Player.position() : 0;
      left = Player.current === item ? `${C.formatTime(pos)} / ${C.formatTime(item.duration)}` : C.formatTime(item.duration);
      right = `${item.kbps}k`;
    } else if (item.state === 'error') {
      left = item.errorCode === 'no-audio' ? 'No sound' : 'Error';
      status = item.error;
    }
    e.readout.textContent = left;
    e.readoutRight.textContent = right;
    e.status.textContent = status;
    e.status.hidden = !status;
    renderActions(item);
    drawScreen(item);
  }

  function metaText(item) {
    const bits = [];
    if (item.state === 'done') {
      bits.push(C.formatTime(item.duration), C.formatBytes(item.blob.size), `${item.kbps} kbps`);
      if (item.channels === 1) bits.push('mono');
    } else if (item.peaks) {
      bits.push(C.formatTime(item.duration));
      if (item.info && item.info.codec) bits.push(item.info.codec);
      bits.push(item.channels === 1 ? 'mono' : item.channels === 2 ? 'stereo' : `${item.channels} ch → stereo`);
    } else {
      bits.push(`from ${item.sourceName}`, C.formatBytes(item.sourceSize));
    }
    return bits.join(' · ');
  }

  function renderActions(item) {
    const box = item.els.actions;
    const show = item.state === 'done';
    box.hidden = !show;
    const mode = saveMode();
    const key = show ? `${mode}:${canShare([fileFor(item)])}` : '';
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.textContent = '';
    if (!show) return;
    if (mode === 'host') {
      box.append(button(`${ICONS.save}<span>Save MP3 (.zip)</span>`, 'btn primary', () => saveItem(item)));
      return;
    }
    box.append(button(`${ICONS.save}<span>Save MP3</span>`, 'btn primary', () => saveItem(item)));
    if (canShare([fileFor(item)])) box.append(button(`${ICONS.share}<span>Share</span>`, 'btn', () => shareItems([item])));
  }

  function button(html, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.innerHTML = html;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- the display ----------

  let palette = null;
  function colors() {
    if (!palette) {
      const s = getComputedStyle(document.documentElement);
      const read = (name, fallback) => (s.getPropertyValue(name) || '').trim() || fallback;
      palette = { lit: read('--vfd', '#ffb020'), dim: read('--vfd-dim', '#4d3b15'), hot: read('--vfd-hot', '#ffe3a3') };
    }
    return palette;
  }

  function drawScreen(item) {
    const canvas = item.els.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    const col = colors();
    ctx.clearRect(0, 0, w, h);

    const padX = 10 * dpr;
    const top = 20 * dpr; // room for the readout
    const bottom = 8 * dpr;
    const mid = top + (h - top - bottom) / 2;
    const maxBar = h - top - bottom;
    const inner = w - padX * 2;

    if (!item.peaks) {
      // flat line; while reading, it fills from the left
      const lineH = Math.max(1, Math.round(dpr));
      ctx.fillStyle = col.dim;
      ctx.fillRect(padX, mid - lineH / 2, inner, lineH);
      if (item.state === 'working') {
        ctx.fillStyle = col.lit;
        ctx.fillRect(padX, mid - lineH / 2, inner * Math.min(1, item.progress / 0.15), lineH);
      }
      return;
    }

    const barW = 2 * dpr;
    const step = 3 * dpr;
    const bars = Math.max(1, Math.floor((inner + dpr) / step));
    const peaks = item.peaks;
    let litTo = 1;
    if (item.state === 'working') litTo = item.stage === 'encoding' ? (item.progress - 0.25) / 0.75 : 0;
    const playing = item.state === 'done' && Player.current === item;
    const playedTo = playing && item.duration ? Player.position() / item.duration : -1;

    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i * peaks.length) / bars);
      const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / bars));
      let m = 0;
      for (let k = a; k < b; k++) if (peaks[k] > m) m = peaks[k];
      const level = Math.sqrt(Math.min(1, m / item.peakMax));
      const barH = Math.max(1.5 * dpr, level * maxBar);
      const at = (i + 0.5) / bars;
      if (playing) ctx.fillStyle = at <= playedTo ? col.hot : col.lit;
      else ctx.fillStyle = at <= litTo ? col.lit : col.dim;
      ctx.globalAlpha = playing && at > playedTo ? 0.55 : 1;
      ctx.fillRect(padX + i * step, mid - barH / 2, barW, barH);
    }
    ctx.globalAlpha = 1;
    if (playing && playedTo >= 0) {
      ctx.fillStyle = col.hot;
      ctx.fillRect(padX + inner * Math.min(1, playedTo) - dpr / 2, top - 4 * dpr, dpr, maxBar + 8 * dpr);
    }
  }

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => items.forEach(drawScreen));
  });
  if (window.matchMedia) {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const refresh = () => { palette = null; items.forEach(drawScreen); };
    if (scheme.addEventListener) scheme.addEventListener('change', refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---------- preview playback ----------

  // Plays through the <audio> element; if this page can't load blob: media (some embedded
  // viewers block it), decodes the MP3 and plays it with Web Audio instead.
  const Player = (() => {
    const audio = els.audio;
    let current = null;
    let viaWebAudio = false;
    let wa = null; // { ctx, buffer, bufferItem, source, startedAt, offset }
    let ticking = 0;

    function position() {
      if (!current) return 0;
      if (!viaWebAudio) return audio.currentTime || 0;
      if (!wa) return 0;
      return wa.source ? Math.min(current.duration, wa.offset + wa.ctx.currentTime - wa.startedAt) : wa.offset;
    }

    function isPlaying(item) {
      if (!current || current !== item) return false;
      return viaWebAudio ? !!(wa && wa.source) : !audio.paused && !audio.ended;
    }

    function tick() {
      ticking = 0;
      if (!current) return;
      render(current);
      if (isPlaying(current)) ticking = requestAnimationFrame(tick);
    }

    function startTicking() {
      if (!ticking) ticking = requestAnimationFrame(tick);
    }

    function stopWebAudioSource() {
      if (wa && wa.source) {
        wa.offset = position();
        const s = wa.source;
        wa.source = null;
        s.onended = null;
        try { s.stop(); } catch (err) { /* already stopped */ }
      }
    }

    function load(item) {
      if (current === item) return;
      stop();
      current = item;
      if (!viaWebAudio) audio.src = item.url;
    }

    async function playWebAudio(item, from) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('No Web Audio');
      if (!wa) wa = { ctx: new Ctx(), buffer: null, bufferItem: null, source: null, startedAt: 0, offset: 0 };
      if (wa.ctx.state === 'suspended') wa.ctx.resume();
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (err) { /* ignore */ }
      }
      if (wa.bufferItem !== item) {
        wa.buffer = null;
        wa.bufferItem = item;
        const data = await item.blob.arrayBuffer();
        const buffer = await new Promise((resolve, reject) => {
          const p = wa.ctx.decodeAudioData(data, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        });
        if (current !== item || wa.bufferItem !== item) return;
        wa.buffer = buffer;
      }
      stopWebAudioSource();
      const source = wa.ctx.createBufferSource();
      source.buffer = wa.buffer;
      source.connect(wa.ctx.destination);
      wa.offset = from != null ? from : wa.offset >= item.duration - 0.05 ? 0 : wa.offset;
      wa.startedAt = wa.ctx.currentTime;
      source.onended = () => {
        if (wa.source !== source) return;
        wa.source = null;
        wa.offset = 0;
        render(item);
      };
      source.start(0, wa.offset);
      wa.source = source;
      startTicking();
      render(item);
    }

    function switchToWebAudio(item, from) {
      viaWebAudio = true;
      audio.removeAttribute('src');
      audio.load();
      playWebAudio(item, from).catch(() => toast("Preview isn't available here, but the MP3 is fine. Save it to listen."));
    }

    function playFrom(item, fraction) {
      load(item);
      const from = fraction != null && item.duration ? fraction * item.duration : null;
      if (viaWebAudio) {
        playWebAudio(item, from).catch(() => toast("Preview isn't available here, but the MP3 is fine. Save it to listen."));
        return;
      }
      if (from != null) {
        try { audio.currentTime = from; } catch (err) { /* not seekable yet */ }
      }
      const started = audio.play();
      if (started && started.catch) {
        started.catch((err) => {
          if (err && err.name === 'NotAllowedError') return; // needs a tap; the button stays on Play
          if (err && err.name === 'AbortError') return;
          switchToWebAudio(item, from);
        });
      }
      startTicking();
      render(item);
    }

    function pause() {
      if (!current) return;
      if (viaWebAudio) stopWebAudioSource();
      else audio.pause();
      render(current);
    }

    function stop() {
      const was = current;
      if (viaWebAudio) {
        stopWebAudioSource();
        if (wa) wa.offset = 0;
      } else {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      current = null;
      if (was && !was.removed) render(was);
    }

    function toggle(item) {
      if (isPlaying(item)) pause();
      else playFrom(item, null);
    }

    audio.addEventListener('play', startTicking);
    audio.addEventListener('pause', () => { if (current) render(current); });
    audio.addEventListener('ended', () => {
      if (!current) return;
      audio.currentTime = 0;
      render(current);
    });
    audio.addEventListener('error', () => {
      if (!current || viaWebAudio || !audio.getAttribute('src')) return;
      switchToWebAudio(current, null);
    });

    return {
      toggle,
      playFrom,
      pause,
      stop,
      isPlaying,
      position,
      get current() { return current; },
    };
  })();

  // ---------- saving ----------

  function saveMode() {
    return host ? 'host' : 'browser';
  }

  function fileFor(item) {
    if (!item.fileObject) {
      try {
        item.fileObject = new File([item.blob], item.filename, { type: 'audio/mpeg' });
      } catch (err) {
        item.fileObject = null;
      }
    }
    return item.fileObject;
  }

  function canShare(files) {
    if (inClaude || !navigator.share || !navigator.canShare || files.some((f) => !f)) return false;
    try {
      return navigator.canShare({ files });
    } catch (err) {
      return false;
    }
  }

  async function saveItem(item) {
    if (host) {
      // The viewer only accepts a fixed list of file types, and .mp3 isn't one; a .zip is.
      const zip = await C.makeZip([{ name: item.filename, blob: item.blob }]);
      if (await hostSave(item.filename.replace(/\.mp3$/i, '.zip'), zip)) item.saved = true;
      return;
    }
    // Home-screen apps on iPhone can't always download; the share sheet has "Save to Files".
    if (isIOS && standalone && canShare([fileFor(item)])) {
      await shareItems([item]);
      return;
    }
    downloadBlob(item.blob, item.filename);
    item.saved = true;
    if (inClaude) toast("If nothing downloaded, this view can't save files. Open the app in Safari or Chrome instead.");
    else if (isIOS) toast('Look for it in the Files app, under Downloads.');
  }

  async function shareItems(list) {
    const files = list.map(fileFor);
    try {
      await navigator.share({ files });
      list.forEach((i) => { i.saved = true; });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // closed the share sheet
      toast("Couldn't open the share sheet. Use Save MP3 instead.");
    }
  }

  async function saveAll() {
    const done = items.filter((i) => i.state === 'done');
    if (!done.length) return;
    if (!host && isIOS && canShare(done.map(fileFor))) {
      await shareItems(done);
      return;
    }
    const used = new Set();
    const entries = done.map((i) => {
      let name = i.filename;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = i.filename.replace(/\.mp3$/i, ` (${n}).mp3`);
      used.add(name.toLowerCase());
      return { name, blob: i.blob };
    });
    const zip = await C.makeZip(entries);
    if (host) {
      if (await hostSave('MP3s.zip', zip)) done.forEach((i) => { i.saved = true; });
      return;
    }
    downloadBlob(zip, 'MP3s.zip');
    done.forEach((i) => { i.saved = true; });
  }

  async function hostSave(filename, blob) {
    try {
      const result = await host.save({ filename, data: blob });
      if (result && result.status === 'saved') toast(isIOS ? 'Saved. Open the .zip in Files to get the MP3.' : 'Saved.');
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') return false;
      if (code === 'rate_limited') toast('A save is already waiting for you to confirm.');
      else toast("This view couldn't save the file.");
      return false;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  els.saveAll.addEventListener('click', saveAll);
  els.clear.addEventListener('click', () => {
    items.filter((i) => i.state === 'done' || i.state === 'error').forEach(removeItem);
  });

  // ---------- page chrome ----------

  function updateChrome() {
    const done = items.filter((i) => i.state === 'done').length;
    els.empty.hidden = items.length > 0;
    els.saveAll.hidden = done < 2;
    els.saveAll.textContent = host ? 'Save all (.zip)' : 'Save all';
    els.clear.hidden = !items.some((i) => i.state === 'done' || i.state === 'error');
    if (host) {
      els.hostNote.textContent = 'In this preview, each MP3 is saved inside a .zip file. Open the .zip in the Files app to get the MP3.';
      els.hostNote.hidden = false;
    } else if (inClaude && hostChecked) {
      els.hostNote.textContent = "This view may not be able to save files. If Save does nothing, open the app in Safari or Chrome.";
      els.hostNote.hidden = false;
    } else {
      els.hostNote.hidden = true;
    }
    if (els.installTip) els.installTip.hidden = inClaude || standalone || !(isIOS || isAndroid);
  }

  let toastTimer = 0;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
  }

  function showFatal(message) {
    const p = document.createElement('p');
    p.className = 'host-note';
    p.textContent = message;
    els.picker.appendChild(p);
    els.pick.disabled = true;
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Keep the screen on while converting (phones pause pages whose screen turns off).
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (err) {
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (busy && document.visibilityState === 'visible') keepAwake(true);
  });

  window.addEventListener('beforeunload', (e) => {
    const pending = items.some((i) => i.state === 'working' || i.state === 'queued' || (i.state === 'done' && !i.saved));
    if (!pending) return;
    e.preventDefault();
    e.returnValue = '';
  });

  updateChrome();
})();
