/* Glow Studio — UI (app.js)
 * Relies only on the public contracts of window.GlowFX (templates.js) and window.GlowMusic (music.js).
 * Everything runs on-device: photos are decoded into canvases, the video is recorded with MediaRecorder.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Basics
   * ------------------------------------------------------------------ */
  var FX = window.GlowFX || null;
  var MU = window.GlowMusic || null;
  var BEAT = window.GlowBeat || null;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); };
  var nextTick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var MAX_PHOTOS = 20;
  var PREVIEW_SHORT = 540;
  var PREVIEW_PHOTO_MAX = 1280;
  var POSTER_PHOTO_MAX = 480;
  var DPR = window.devicePixelRatio || 1;
  var POSTER_W = DPR >= 1.5 ? 240 : 200;
  var POSTER_H = Math.round(POSTER_W * 16 / 9);

  var ICON = {
    play: '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8c0 .8.9 1.3 1.5.8l10-6.4c.6-.4.6-1.2 0-1.6l-10-6.4C8.9 4.3 8 4.8 8 5.6z"/></svg>',
    stop: '<svg class="i-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4 4 9-9"/></svg>'
  };

  var ASPECTS = [
    { id: '9:16', w: 9, h: 16, sub: 'Reels · TikTok', out: { '1080': [1080, 1920], '720': [720, 1280] } },
    { id: '4:5', w: 4, h: 5, sub: 'Feed', out: { '1080': [1080, 1350], '720': [720, 900] } },
    { id: '1:1', w: 1, h: 1, sub: 'Square', out: { '1080': [1080, 1080], '720': [720, 720] } },
    { id: '16:9', w: 16, h: 9, sub: 'YouTube', out: { '1080': [1920, 1080], '720': [1280, 720] } }
  ];
  var QUALITIES = [
    { id: '720', label: '720p', sub: 'HD · faster' },
    { id: '1080', label: '1080p', sub: 'Full HD' }
  ];

  var templates = (FX && Array.isArray(FX.templates)) ? FX.templates.filter(function (t) { return t && t.id; }) : [];
  var tracks = (MU && Array.isArray(MU.tracks)) ? MU.tracks.filter(function (t) { return t && t.id; }) : [];

  function tplById(id) { for (var i = 0; i < templates.length; i++) if (templates[i].id === id) return templates[i]; return templates[0] || null; }
  function trackById(id) { if (id === 'own') return null; for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i]; return tracks[0] || null; }
  function ownOn() { return S.trackId === 'own' && !!S.own; }
  // The beat the template cuts on: the built-in track's tempo, or the one found in the user's song.
  function sceneBpm() { if (ownOn()) return S.own.bpm; var t = trackById(S.trackId); return t ? t.bpm : 120; }
  // The music for a video of `dur` seconds: the built-in track, or the user's song from its downbeat (so the
  // template's beat 0 lands on the song's downbeat at t = 0), looped by whole bars if it is short, faded at the end.
  function musicFor(dur) {
    if (ownOn()) return Promise.resolve(ownSlice(dur));
    var t = trackById(S.trackId);
    return t ? getMusic(t.id, dur) : Promise.resolve(null);
  }
  function ownSlice(dur) {
    var own = S.own, src = own.buffer, ctx = ensureAudio();
    var sr = src.sampleRate, n = Math.max(1, Math.round(dur * sr)), chs = Math.max(2, src.numberOfChannels);
    var out = ctx ? ctx.createBuffer(chs, n, sr) : new AudioBuffer({ numberOfChannels: chs, length: n, sampleRate: sr });
    var from = Math.round(own.offset * sr), avail = src.length - from, bar = Math.round(4 * 60 / own.bpm * sr);
    var loop = avail >= n ? n : Math.max(bar, Math.floor(avail / bar) * bar);
    for (var c = 0; c < chs; c++) {
      var d = src.getChannelData(Math.min(c, src.numberOfChannels - 1)), o = out.getChannelData(c);
      for (var i = 0; i < n; i++) { var k = from + (i % loop); o[i] = k < src.length ? d[k] : 0; }
      var fi = Math.min(n, Math.round(0.01 * sr)), fo = Math.min(n, Math.round(1.0 * sr));
      for (var a = 0; a < fi; a++) o[a] *= a / fi;
      for (var b = 0; b < fo; b++) o[n - 1 - b] *= b / fo;
    }
    return out;
  }
  function aspectById(id) { for (var i = 0; i < ASPECTS.length; i++) if (ASPECTS[i].id === id) return ASPECTS[i]; return ASPECTS[0]; }

  var S = {
    photos: [],              // { id, name, demo, file, src (<=1280 canvas), thumb, small }
    templateId: templates[0] ? templates[0].id : '',
    trackId: '',
    volume: 0.85,
    title: '', subtitle: '',
    aspect: '9:16', quality: '1080',
    scene: null, buffer: null,
    playing: false, offset: 0, startAt: 0, perfStart: 0, src: null,
    gen: 0, building: false, exporting: false, renderErr: false,
    own: null                // "My song": { name, buffer, beat, start, offset (downbeat at/after start), bpm }, trackId 'own'
  };
  var firstTpl = tplById(S.templateId);
  S.trackId = (firstTpl && trackById(firstTpl.track) && firstTpl.track) || (tracks[0] ? tracks[0].id : '');

  var el = {
    screen: $('#screen'), pv: $('#pv'), bigPlay: $('#bigPlay'), btnPlay: $('#btnPlay'), scrub: $('#scrub'),
    tCur: $('#tCur'), tDur: $('#tDur'), nowTpl: $('#nowTpl'), nowTrack: $('#nowTrack'),
    create: $('#btnCreate'), ctaSub: $('#ctaSub'),
    file: $('#fileInput'), tray: $('#tray'), trayWrap: $('#trayWrap'), photoCount: $('#photoCount'), photoStatus: $('#photoStatus'),
    btnAdd: $('#btnAdd'), btnDemo: $('#btnDemo'), btnClear: $('#btnClear'), emptyAdd: $('#emptyAdd'), emptyDemo: $('#emptyDemo'),
    cardPhotos: $('#cardPhotos'), tpls: $('#tpls'), surprise: $('#btnSurprise'), tracks: $('#tracks'),
    volume: $('#volume'), volOut: $('#volOut'), title: $('#title'), subtitle: $('#subtitle'),
    aspects: $('#aspects'), qualities: $('#qualities'), toasts: $('#toasts'),
    exModal: $('#exportModal'), exView: $('#exView'), exCanvas: $('#exCanvas'), exBar: $('#exBar'), exPct: $('#exPct'),
    exLeft: $('#exLeft'), exWarn: $('#exWarn'), exPrepT: $('#exPrepT'), exMonitor: $('#exMonitor'), cancel: $('#btnCancel'),
    resModal: $('#resultModal'), video: $('#resultVideo'), resMeta: $('#resMeta'), dl: $('#btnDownload'), share: $('#btnShare'),
    another: $('#btnAnother'), resClose: $('#resClose'),
    infoModal: $('#infoModal'), infoTitle: $('#infoTitle'), infoText: $('#infoText'), infoOk: $('#infoOk'),
    own: $('#pvOwn'), ownName: $('#pvOwnName'), ownMeta: $('#pvOwnMeta'), ownAt: $('#pvOwnAt'), ownPrev: $('#pvOwnPrev'), ownNext: $('#pvOwnNext'),
    ownChange: $('#pvOwnChange'), ownNote: $('#pvOwnNote'), ownFile: $('#pvOwnFile')
  };
  var pvCtx = el.pv.getContext('2d');

  /* ------------------------------------------------------------------ *
   * Toasts & status
   * ------------------------------------------------------------------ */
  var lastToast = { msg: '', at: 0 };
  function toast(msg, kind, ms) {
    var now = Date.now();
    if (msg === lastToast.msg && now - lastToast.at < 1500) return;
    lastToast = { msg: msg, at: now };
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || 'info');
    t.textContent = msg;
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 3) el.toasts.removeChild(el.toasts.firstChild);
    requestAnimationFrame(function () { requestAnimationFrame(function () { t.classList.add('in'); }); });
    setTimeout(function () {
      t.classList.remove('in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, ms || 3400);
  }
  function fmt(sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  /* ------------------------------------------------------------------ *
   * Audio
   * ------------------------------------------------------------------ */
  var actx = null, master = null;
  function ensureAudio() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { actx = new AC(); } catch (e) { return null; }
      master = actx.createGain();
      master.gain.value = S.volume;
      master.connect(actx.destination);
    }
    // 'suspended' (autoplay policy) or iOS 'interrupted' (call, app switch): resume on the next gesture
    if (actx.state !== 'running' && actx.state !== 'closed' && actx.resume) { try { actx.resume().catch(function () {}); } catch (e) { /* ignore */ } }
    return actx;
  }
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, function () { ensureAudio(); }, { capture: true, passive: true });
  });

  var musicCache = new Map();
  function getMusic(id, dur) {
    var key = id + '|' + dur.toFixed(3);
    if (!musicCache.has(key)) {
      var p = Promise.resolve().then(function () {
        if (!MU || typeof MU.render !== 'function') throw new Error('Music engine unavailable');
        return MU.render(id, dur);
      });
      p.catch(function () { musicCache.delete(key); });
      musicCache.set(key, p);
      if (musicCache.size > 14) musicCache.delete(musicCache.keys().next().value);
    }
    return musicCache.get(key);
  }

  /* ------------------------------------------------------------------ *
   * Fonts
   * ------------------------------------------------------------------ */
  var fontsP = null;
  function fontsReady() {
    if (fontsP) return fontsP;
    var link = document.getElementById('gfonts');
    var sheet = new Promise(function (res) {
      if (!link) return res();
      try { if (link.sheet) return res(); } catch (e) { /* cross-origin */ }
      link.addEventListener('load', res, { once: true });
      link.addEventListener('error', res, { once: true });
    });
    var list = (FX && Array.isArray(FX.fonts)) ? FX.fonts : [];
    var all = sheet.then(function () {
      if (!document.fonts || !document.fonts.load) return null;
      return Promise.all(list.map(function (f) { return document.fonts.load(f).catch(function () { return null; }); }));
    });
    fontsP = Promise.race([all, wait(3500)]).catch(function () { return null; });
    return fontsP;
  }
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', function () { if (!S.playing) drawPreview(); });
  }

  /* ------------------------------------------------------------------ *
   * Photos
   * ------------------------------------------------------------------ */
  var photoSeq = 0;
  function makeCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
  function scaledCopy(src, sw, sh, maxSide) {
    var s = Math.min(1, maxSide / Math.max(sw, sh));
    var c = makeCanvas(Math.round(sw * s), Math.round(sh * s));
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    try { x.imageSmoothingQuality = 'high'; } catch (e) { /* older */ }
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function releaseCanvas(c) { if (c && c.width) { c.width = 1; c.height = 1; } }
  // Free a scene's cached canvases right away (iOS Safari has a hard cap on total canvas memory and
  // reclaims it lazily). dispose() is optional on scenes; templates never keep the source photos.
  function disposeScene(sc) { if (sc && sc !== S.scene && typeof sc.dispose === 'function') { try { sc.dispose(); } catch (e) { /* ignore */ } } }

  function decodeFile(file, maxSide) {
    return (async function () {
      var bmp = null;
      if (typeof window.createImageBitmap === 'function') {
        try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = null; }
      }
      if (bmp) {
        try {
          if (!bmp.width || !bmp.height) throw new Error('empty image');
          return scaledCopy(bmp, bmp.width, bmp.height, maxSide);
        } finally { if (bmp.close) bmp.close(); }
      }
      var url = URL.createObjectURL(file);
      try {
        var img = new Image();
        img.decoding = 'async';
        await new Promise(function (res, rej) { img.onload = res; img.onerror = function () { rej(new Error('decode failed')); }; img.src = url; });
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
        return scaledCopy(img, img.naturalWidth, img.naturalHeight, maxSide);
      } finally { URL.revokeObjectURL(url); }
    })();
  }
  function thumbOf(src) { return scaledCopy(src, src.width, src.height, 220); }
  function smallOf(p) { if (!p.small) p.small = p.src.width > POSTER_PHOTO_MAX || p.src.height > POSTER_PHOTO_MAX ? scaledCopy(p.src, p.src.width, p.src.height, POSTER_PHOTO_MAX) : p.src; return p.small; }

  async function makePhoto(file) {
    var full = await decodeFile(file, PREVIEW_PHOTO_MAX);
    return { id: ++photoSeq, name: file.name || 'photo', demo: false, file: file, src: full, thumb: thumbOf(full), small: null };
  }
  function isHeic(f) { return /hei[cf]$/i.test(f.type || '') || /\.(heic|heif)$/i.test(f.name || ''); }
  function looksLikeImage(f) { return (f.type && f.type.indexOf('image/') === 0) || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif|tiff?)$/i.test(f.name || ''); }

  var adding = false;
  async function addFiles(list) {
    var files = Array.prototype.slice.call(list || []).filter(looksLikeImage);
    if (!files.length) { if (list && list.length) toast('Those files don’t look like photos. Try JPG, PNG or HEIC.', 'warn'); return; }
    if (adding) { toast('Still adding your last photos…'); return; }
    adding = true;
    var hadDemo = S.photos.some(function (p) { return p.demo; });
    if (hadDemo) S.photos = S.photos.filter(function (p) { return !p.demo; });
    var room = MAX_PHOTOS - S.photos.length;
    if (room <= 0) { adding = false; toast('You’ve reached 20 photos — remove one to add more.', 'warn'); renderTray(); return; }
    var want = Math.min(room, files.length);
    var heicFail = 0, otherFail = 0, added = 0, i = 0;
    setPhotoStatus('Adding ' + want + ' photo' + (want > 1 ? 's' : '') + '…');
    for (; i < files.length && S.photos.length < MAX_PHOTOS; i++) {
      try {
        var p = await makePhoto(files[i]);
        S.photos.push(p); added++;
        renderTray();
        setPhotoStatus('Adding photos… ' + added + ' / ' + want);
      } catch (e) {
        console.warn('[glow] could not decode', files[i] && files[i].name, e);
        if (isHeic(files[i])) heicFail++; else otherFail++;
      }
      await nextTick();
    }
    var skipped = files.length - i;
    adding = false;
    setPhotoStatus('');
    if (heicFail) toast('This browser can’t open HEIC photos (' + heicFail + ' skipped). On iPhone use Safari, or export them as JPG.', 'warn', 6000);
    if (otherFail) toast(otherFail + ' file' + (otherFail > 1 ? 's' : '') + ' couldn’t be opened and were skipped.', 'warn');
    if (skipped > 0) toast('The limit is 20 photos — ' + skipped + ' extra ' + (skipped > 1 ? 'were' : 'was') + ' left out.', 'warn');
    if (added && hadDemo) toast('Swapped the demo for your photos', 'ok');
    if (added || hadDemo) photosChanged({ autoplay: true });
    else renderTray();
  }

  function loadDemo() {
    if (!FX || typeof FX.demoPhotos !== 'function') { toast('Demo photos aren’t available right now.', 'error'); return; }
    var list;
    try { list = FX.demoPhotos(5) || []; } catch (e) { console.warn(e); toast('Couldn’t create the demo photos.', 'error'); return; }
    S.photos = list.filter(function (c) { return c && c.width; }).slice(0, MAX_PHOTOS).map(function (c, i) {
      return { id: ++photoSeq, name: 'Demo ' + (i + 1), demo: true, file: null, src: c, thumb: thumbOf(c), small: null };
    });
    photosChanged({ autoplay: true });
  }

  function setPhotoStatus(t) { el.photoStatus.textContent = t || ''; }

  function photosChanged(opts) {
    renderTray();
    updateCta();
    schedulePosters(900);
    scheduleRebuild({ autoplay: opts && opts.autoplay, delay: 120 });
  }

  function renderTray() {
    var n = S.photos.length;
    el.tray.textContent = '';
    S.photos.forEach(function (p, i) {
      var li = document.createElement('li');
      li.className = 'ph' + (p.demo ? ' demo-badge' : '');
      li.dataset.id = p.id;
      p.thumb.setAttribute('aria-hidden', 'true');
      li.appendChild(p.thumb);
      var num = document.createElement('span'); num.className = 'ph-n'; num.textContent = i + 1; li.appendChild(num);
      var x = document.createElement('button'); x.type = 'button'; x.className = 'ph-x'; x.innerHTML = ICON.x;
      x.setAttribute('aria-label', 'Remove photo ' + (i + 1));
      x.addEventListener('click', function () { removePhoto(p.id); });
      li.appendChild(x);
      var mv = document.createElement('div'); mv.className = 'ph-mv';
      var l = document.createElement('button'); l.type = 'button'; l.innerHTML = ICON.left; l.setAttribute('aria-label', 'Move photo ' + (i + 1) + ' left'); l.disabled = i === 0;
      l.addEventListener('click', function () { movePhoto(p.id, -1); });
      var r = document.createElement('button'); r.type = 'button'; r.innerHTML = ICON.right; r.setAttribute('aria-label', 'Move photo ' + (i + 1) + ' right'); r.disabled = i === n - 1;
      r.addEventListener('click', function () { movePhoto(p.id, 1); });
      mv.appendChild(l); mv.appendChild(r); li.appendChild(mv);
      el.tray.appendChild(li);
    });
    if (n && n < MAX_PHOTOS) {
      var addLi = document.createElement('li');
      var add = document.createElement('button'); add.type = 'button'; add.className = 'ph-add';
      add.innerHTML = ICON.plus + '<span>Add</span>';
      add.setAttribute('aria-label', 'Add more photos');
      add.addEventListener('click', openPicker);
      addLi.appendChild(add); addLi.style.display = 'contents';
      el.tray.appendChild(addLi);
    }
    el.photoCount.textContent = n + ' / ' + MAX_PHOTOS;
    el.trayWrap.classList.toggle('has-photos', n > 0);
    el.btnClear.hidden = n === 0;
    var hasUser = S.photos.some(function (p) { return !p.demo; });
    el.btnDemo.hidden = hasUser;
  }
  function removePhoto(id) {
    var i = S.photos.findIndex(function (p) { return p.id === id; });
    if (i < 0) return;
    var p = S.photos.splice(i, 1)[0];
    if (!p.demo) { releaseCanvas(p.src); if (p.small && p.small !== p.src) releaseCanvas(p.small); }
    photosChanged({ autoplay: S.playing });
    // keep keyboard / screen-reader focus in the tray instead of dropping it on <body>
    var next = el.tray.querySelectorAll('.ph .ph-x')[Math.min(i, S.photos.length - 1)];
    try { (next || el.btnAdd).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    if (!S.photos.length) toast('All photos removed');
  }
  function movePhoto(id, dir) {
    var i = S.photos.findIndex(function (p) { return p.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= S.photos.length) return;
    var t = S.photos[i]; S.photos[i] = S.photos[j]; S.photos[j] = t;
    photosChanged({ autoplay: S.playing });
    var btn = el.tray.querySelector('[data-id="' + id + '"] .ph-mv button:' + (dir < 0 ? 'first-child' : 'last-child'));
    if (btn && !btn.disabled) btn.focus(); else { var any = el.tray.querySelector('[data-id="' + id + '"] .ph-x'); if (any) any.focus(); }
  }
  function clearPhotos() {
    S.photos.forEach(function (p) { if (!p.demo) releaseCanvas(p.src); });
    S.photos = [];
    photosChanged({});
  }
  function openPicker() { try { el.file.value = ''; } catch (e) { /* ignore */ } el.file.click(); }

  /* ------------------------------------------------------------------ *
   * Preview (scene + playback)
   * ------------------------------------------------------------------ */
  function previewSize(aspectId) {
    var a = aspectById(aspectId);
    return a.w <= a.h ? [PREVIEW_SHORT, Math.round(PREVIEW_SHORT * a.h / a.w)] : [Math.round(PREVIEW_SHORT * a.w / a.h), PREVIEW_SHORT];
  }
  function textObj() { return { title: S.title.trim(), subtitle: S.subtitle.trim() }; }

  function nowT() {
    if (!S.scene) return 0;
    var d = S.scene.duration;
    if (!S.playing) return clamp(S.offset, 0, d);
    var el2;
    if (S.src && actx) el2 = actx.currentTime - S.startAt - (actx.outputLatency || 0);
    else el2 = (performance.now() - S.perfStart) / 1000;
    var t = S.offset + Math.max(0, el2);
    return d > 0 ? t % d : 0;
  }

  function drawPreview(t) {
    if (!S.scene) return;
    if (t == null) t = nowT();
    try {
      S.scene.render(pvCtx, clamp(t, 0, S.scene.duration), textObj());
    } catch (e) {
      if (!S.renderErr) { S.renderErr = true; console.warn('[glow] render error', e); toast('This template had trouble drawing a frame. Try another one.', 'error'); }
    }
  }

  function stopSource() {
    if (S.src) { try { S.src.onended = null; S.src.stop(); } catch (e) { /* already stopped */ } try { S.src.disconnect(); } catch (e) { /* ignore */ } S.src = null; }
  }

  var raf = 0;
  function loop() {
    cancelAnimationFrame(raf);
    var tick = function () {
      if (!S.playing) return;
      drawPreview();
      updateTimeUI();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!S.scene || S.building || S.exporting) return;
    stopTrackPreview();
    var ctx = ensureAudio();
    if (S.offset >= S.scene.duration - 0.05) S.offset = 0;
    stopSource();
    if (ctx && S.buffer) {
      try {
        var src = ctx.createBufferSource();
        src.buffer = S.buffer;
        src.loop = true;
        src.connect(master);
        S.startAt = ctx.currentTime + 0.04;
        src.start(S.startAt, clamp(S.offset, 0, S.buffer.duration - 0.01));
        S.src = src;
      } catch (e) { console.warn('[glow] audio start failed', e); S.src = null; }
    }
    S.perfStart = performance.now();
    S.playing = true;
    updatePlayUI();
    loop();
  }
  function pause() {
    if (!S.playing) return;
    S.offset = nowT();
    S.playing = false;
    stopSource();
    cancelAnimationFrame(raf);
    updatePlayUI();
    drawPreview(S.offset);
    updateTimeUI();
  }
  function togglePlay() { if (S.playing) pause(); else play(); }

  function updatePlayUI() {
    var on = S.playing;
    el.btnPlay.classList.toggle('playing', on);
    el.btnPlay.setAttribute('aria-label', on ? 'Pause' : 'Play');
    el.screen.classList.toggle('playing', on);
    document.body.classList.toggle('is-playing', on);
  }
  function updateTimeUI() {
    var d = S.scene ? S.scene.duration : 0, t = nowT();
    el.tCur.textContent = fmt(t);
    el.tDur.textContent = fmt(d);
    if (!scrubbing) {
      var v = d ? Math.round(t / d * 1000) : 0;
      el.scrub.value = v;
    }
    el.scrub.style.setProperty('--p', (el.scrub.value / 10) + '%');
  }
  function setStage() {
    var state = !S.photos.length ? 'empty' : (S.building || !S.scene) ? 'loading' : 'ready';
    el.screen.dataset.state = state;
    el.screen.classList.toggle('has-scene', !!S.scene);
    var ready = state === 'ready';
    el.btnPlay.disabled = !ready;
    el.scrub.disabled = !ready;
    el.pv.setAttribute('aria-label', ready ? 'Video preview — tap to play or pause' : 'Video preview');
  }
  function setScreenAspect() {
    var a = aspectById(S.aspect);
    el.screen.style.setProperty('--arw', a.w);
    el.screen.style.setProperty('--arh', a.h);
    el.screen.style.setProperty('--ar', (a.w / a.h).toFixed(5));
  }
  function updateNowLine() {
    var t = tplById(S.templateId), tr = trackById(S.trackId);
    el.nowTpl.textContent = t ? t.name : '—';
    el.nowTrack.textContent = ownOn() ? 'My song: ' + S.own.name : tr ? tr.name : '—';
  }
  function updateCta() {
    if (!S.photos.length) { el.ctaSub.textContent = 'Add photos to start'; el.create.classList.add('idle'); return; }
    el.create.classList.remove('idle');
    var parts = [];
    if (S.scene) parts.push(fmt(S.scene.duration));
    parts.push(S.quality + 'p', S.aspect, 'no watermark');
    el.ctaSub.textContent = parts.join(' · ');
  }

  var rebuildTimer = 0, autoplayNext = false;
  function scheduleRebuild(opts) {
    opts = opts || {};
    if (opts.autoplay || S.playing) autoplayNext = true;
    S.gen++;
    clearTimeout(rebuildTimer);
    if (S.playing) { S.offset = nowT(); S.playing = false; stopSource(); cancelAnimationFrame(raf); updatePlayUI(); }
    if (!S.photos.length) { rebuild(); return; }
    S.building = true;
    setStage();
    rebuildTimer = setTimeout(rebuild, opts.delay != null ? opts.delay : 200);
  }

  async function rebuild() {
    var g = ++S.gen;
    if (!S.photos.length) {
      autoplayNext = false;
      S.playing = false; stopSource(); cancelAnimationFrame(raf);
      var gone = S.scene;
      S.scene = null; S.buffer = null; S.building = false; S.offset = 0;
      disposeScene(gone);
      try { pvCtx.clearRect(0, 0, el.pv.width, el.pv.height); } catch (e) { /* ignore */ }
      updatePlayUI(); setStage(); updateTimeUI(); updateCta();
      return;
    }
    if (!FX || typeof FX.createScene !== 'function') {
      S.building = false; setStage();
      toast('Templates didn’t load. Check your connection and refresh.', 'error');
      return;
    }
    var playAfter = autoplayNext;
    S.building = true; setStage();
    var track = ownOn() ? null : trackById(S.trackId), size = previewSize(S.aspect), scene = null, own = ownOn();
    try {
      await fontsReady();
      if (g !== S.gen) return;
      scene = await FX.createScene({
        templateId: S.templateId,
        photos: S.photos.map(function (p) { return p.src; }),
        width: size[0], height: size[1],
        bpm: sceneBpm()
      });
      if (g !== S.gen) { disposeScene(scene); return; }
      if (!scene || typeof scene.render !== 'function' || !(scene.duration > 0)) throw new Error('Template returned an invalid scene');
      var buffer = null;
      if (track || own) {
        try { buffer = await musicFor(scene.duration); }
        catch (e) { console.warn('[glow] music failed', e); if (g === S.gen) toast('Couldn’t make the music — the preview will play silently.', 'warn'); }
      }
      if (g !== S.gen) { disposeScene(scene); return; }
      var prev = S.scene;
      S.scene = scene; S.buffer = buffer; S.renderErr = false;
      disposeScene(prev);
      S.offset = 0;
      if (el.pv.width !== size[0] || el.pv.height !== size[1]) { el.pv.width = size[0]; el.pv.height = size[1]; }
      S.building = false; autoplayNext = false;
      drawPreview(0);
      setStage(); updateTimeUI(); updateCta();
      if (playAfter && !S.exporting && !otherMode()) play(); // never start playing behind AI Scenes
    } catch (e) {
      disposeScene(scene);
      if (g !== S.gen) return;
      console.warn('[glow] scene build failed', e);
      S.building = false; autoplayNext = false;
      setStage(); updateCta();
      toast('That template hit a snag. Try another one?', 'error');
    }
  }

  /* scrubbing */
  var scrubbing = false, scrubResume = false;
  function scrubStart() {
    if (!S.scene) return;
    if (!scrubbing) { scrubbing = true; scrubResume = S.playing; if (S.playing) pause(); }
  }
  el.scrub.addEventListener('pointerdown', scrubStart);
  el.scrub.addEventListener('touchstart', scrubStart, { passive: true });
  el.scrub.addEventListener('input', function () {
    if (!S.scene) return;
    if (!scrubbing) scrubStart();
    S.offset = el.scrub.value / 1000 * S.scene.duration;
    drawPreview(S.offset);
    el.tCur.textContent = fmt(S.offset);
    el.scrub.style.setProperty('--p', (el.scrub.value / 10) + '%');
  });
  function scrubEnd() {
    if (!scrubbing) return;
    var resume = scrubResume;
    scrubbing = false; scrubResume = false;
    if (resume) play();
    updateTimeUI();
  }
  el.scrub.addEventListener('change', scrubEnd);
  ['pointerup', 'pointercancel', 'touchend', 'blur'].forEach(function (ev) {
    el.scrub.addEventListener(ev, function () { setTimeout(scrubEnd, 30); });
  });

  el.btnPlay.addEventListener('click', togglePlay);
  el.bigPlay.addEventListener('click', play);
  el.pv.addEventListener('click', function () { if (el.screen.dataset.state === 'ready') togglePlay(); });
  // AI Scenes (ai.js) shares this page; Photo Video stays quiet while the other mode is on screen.
  function otherMode() { return document.body.getAttribute('data-mode') === 'ai'; }
  document.addEventListener('glow:mode', function (e) {
    if (e.detail && e.detail.mode !== 'photo') { autoplayNext = false; pause(); stopTrackPreview(); }
    else if (e.detail && e.detail.mode === 'photo') startPosters();
  });
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (otherMode()) return;
    var a = document.activeElement;
    if (a && a !== document.body) return;
    if (!el.exModal.hidden || !el.resModal.hidden) return;
    if (el.screen.dataset.state === 'ready') { e.preventDefault(); togglePlay(); }
  });

  /* ------------------------------------------------------------------ *
   * Templates
   * ------------------------------------------------------------------ */
  var tplCards = {};
  function renderTemplates() {
    el.tpls.textContent = '';
    if (!templates.length) {
      el.tpls.innerHTML = '<p class="hint">Templates couldn’t load. Refresh to try again.</p>';
      return;
    }
    templates.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'tpl'; b.dataset.template = t.id;
      var c = (t.colors && t.colors.length) ? t.colors : ['#3b2b6b', '#1a1430'];
      var poster = document.createElement('span'); poster.className = 'tpl-poster';
      poster.style.setProperty('--c1', c[0]); poster.style.setProperty('--c2', c[1] || c[0]);
      var cv = makeCanvas(POSTER_W, POSTER_H); cv.setAttribute('aria-hidden', 'true');
      poster.appendChild(cv);
      if (t.tag) { var tag = document.createElement('span'); tag.className = 'tag tag-' + String(t.tag).toLowerCase(); tag.textContent = t.tag; poster.appendChild(tag); }
      var ck = document.createElement('span'); ck.className = 'check'; ck.innerHTML = ICON.check; poster.appendChild(ck);
      var ring = document.createElement('span'); ring.className = 'ring'; poster.appendChild(ring);
      b.appendChild(poster);
      var name = document.createElement('span'); name.className = 'tpl-name'; name.textContent = t.name || t.id; b.appendChild(name);
      var desc = document.createElement('span'); desc.className = 'tpl-desc'; desc.textContent = t.desc || ''; b.appendChild(desc);
      b.setAttribute('aria-label', (t.name || t.id) + (t.tag ? ', ' + t.tag : '') + (t.desc ? '. ' + t.desc : ''));
      b.addEventListener('click', function () { selectTemplate(t.id); });
      el.tpls.appendChild(b);
      tplCards[t.id] = { btn: b, canvas: cv };
    });
    updateTemplateUI();
  }
  function updateTemplateUI(scroll) {
    Object.keys(tplCards).forEach(function (id) { tplCards[id].btn.setAttribute('aria-pressed', id === S.templateId ? 'true' : 'false'); });
    updateNowLine();
    if (scroll) {
      var c = tplCards[S.templateId];
      if (c) scrollIntoRow(el.tpls, c.btn);
    }
  }
  function scrollIntoRow(row, item) {
    if (row.scrollWidth <= row.clientWidth + 2) return;
    var left = item.offsetLeft - (row.clientWidth - item.offsetWidth) / 2;
    try { row.scrollTo({ left: left, behavior: 'smooth' }); } catch (e) { row.scrollLeft = left; }
  }
  function selectTemplate(id) {
    var t = tplById(id);
    if (!t) return;
    var tr = t.track && !ownOn() ? trackById(t.track) : null; // the user's own song stays chosen
    var changed = t.id !== S.templateId || (tr && tr.id === t.track && tr.id !== S.trackId);
    S.templateId = t.id;
    if (tr && tr.id === t.track) S.trackId = tr.id;
    updateTemplateUI(); updateTrackUI();
    if (!S.photos.length) return;
    if (changed || !S.scene) scheduleRebuild({ autoplay: true });
    else if (!S.playing && !S.building) play();
  }

  /* posters — sequential background generation with small yields */
  var posterGen = 0, posterTimer = 0, demoSmall = null, posterKey = '';
  var POSTER_MAX = 5;
  function posterSetKey() {
    var user = S.photos.filter(function (p) { return !p.demo; }).slice(0, POSTER_MAX);
    return user.length ? user.map(function (p) { return p.id; }).join(',') : 'demo';
  }
  async function posterPhotos() {
    var user = S.photos.filter(function (p) { return !p.demo; });
    if (user.length) return user.slice(0, POSTER_MAX).map(smallOf);
    if (!demoSmall) {
      var d = [];
      // GlowFX caches demo paintings, so asking for one more each time paints a single photo per task
      // (~30-90 ms) instead of blocking the page for all of them at once.
      try { for (var k = 1; k <= POSTER_MAX && FX && FX.demoPhotos; k++) { d = FX.demoPhotos(k) || []; await nextTick(); } } catch (e) { console.warn(e); d = []; }
      demoSmall = d.filter(function (c) { return c && c.width; }).map(function (c) { return scaledCopy(c, c.width, c.height, POSTER_PHOTO_MAX); });
    }
    return demoSmall;
  }
  // Each poster leads with a different photo so the cards don't all show the same picture (demo order:
  // 0 sunset beach, 1 neon city, 2 flower field, 3 misty mountains, 4 party lights). Neighbours in the
  // mobile scroll row and in the desktop 4-column grid never share a photo. Card-pile templates get a few.
  var POSTER_LEAD = { glowup: 0, neon: 1, golden: 2, cinema: 3, vhs: 4, beat: 0, polaroid: 3, dreamy: 1, cover: 0, comic: 2, glitch: 1, party: 4 };
  var POSTER_COUNT = { polaroid: 3, comic: 3 };
  function posterSet(photos, t, i) {
    var n = photos.length, k = (POSTER_LEAD[t.id] != null ? POSTER_LEAD[t.id] : i) % n;
    return photos.slice(k).concat(photos.slice(0, k)).slice(0, POSTER_COUNT[t.id] || 1);
  }
  function posterTimes(sc) {
    var beat = 60 / (sc.bpm || 120), d = sc.duration;
    return [0.62, 0.18, 0.3, 0.42, 0.5, 0.7, 0.78, 0.88].map(function (f) {
      return clamp(Math.floor(d * f / beat) * beat + beat * 0.55, 0, Math.max(0, d - 0.8));
    });
  }
  // One-time heuristic (posters only): prefer a vivid, contrasty frame over flashes / fades / 'before' looks.
  var scoreCv = null;
  function frameScore(c) {
    try {
      if (!scoreCv) scoreCv = makeCanvas(18, 32);
      var x = scoreCv.getContext('2d', { willReadFrequently: true });
      x.clearRect(0, 0, 18, 32); x.drawImage(c, 0, 0, 18, 32);
      var d = x.getImageData(0, 0, 18, 32).data, n = d.length / 4, sat = 0, lum = 0, lum2 = 0;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (r + g + b) / 3;
        sat += mx - mn; lum += l; lum2 += l * l;
      }
      sat /= n; lum /= n;
      var sd = Math.sqrt(Math.max(0, lum2 / n - lum * lum));
      var pen = lum < 45 ? (45 - lum) * 2 : lum > 215 ? (lum - 215) * 2 : 0;
      return sat + sd * 0.6 - pen;
    } catch (e) { return 0; }
  }
  function schedulePosters(delay) {
    var key = posterSetKey();
    if (key === posterKey) return;
    clearTimeout(posterTimer);
    var g = ++posterGen;
    posterTimer = setTimeout(function () { posterKey = key; runPosters(g); }, delay || 0);
  }
  async function runPosters(g) {
    if (!FX || typeof FX.createScene !== 'function') return;
    await fontsReady();
    var photos = await posterPhotos();
    if (!photos.length || g !== posterGen) return;
    var order = templates.slice();
    var sel = order.findIndex(function (t) { return t.id === S.templateId; });
    if (sel > 0) order.unshift(order.splice(sel, 1)[0]);
    for (var i = 0; i < order.length; i++) {
      while ((S.building || S.exporting || adding) && g === posterGen) await wait(150);
      if (g !== posterGen) return;
      var t = order[i], card = tplCards[t.id];
      if (!card) continue;
      try {
        var tr = trackById(t.track);
        var sc = await FX.createScene({ templateId: t.id, photos: posterSet(photos, t, i), width: POSTER_W, height: POSTER_H, bpm: ownOn() ? S.own.bpm : tr ? tr.bpm : 120 });
        if (g !== posterGen) { disposeScene(sc); return; }
        var off = makeCanvas(POSTER_W, POSTER_H), offCx = off.getContext('2d');
        var best = null, bestScore = -1e9, times = posterTimes(sc);
        for (var k = 0; k < times.length; k++) {
          sc.render(offCx, times[k], { title: '', subtitle: '' });
          var sco = frameScore(off) + (k === 0 ? 4 : 0);
          if (sco > bestScore) { bestScore = sco; best = times[k]; }
        }
        sc.render(offCx, best, { title: '', subtitle: '' });
        var cx = card.canvas.getContext('2d');
        cx.clearRect(0, 0, POSTER_W, POSTER_H);
        cx.drawImage(off, 0, 0);
        releaseCanvas(off);
        disposeScene(sc);
        card.btn.classList.add('ready');
      } catch (e) {
        console.warn('[glow] poster failed for', t.id, e);
        card.btn.classList.add('ready', 'poster-failed');
      }
      await wait(30);
    }
  }

  /* ------------------------------------------------------------------ *
   * Music UI
   * ------------------------------------------------------------------ */
  var trackCards = {};
  function renderTracks() {
    el.tracks.textContent = '';
    if (!tracks.length) { el.tracks.innerHTML = '<p class="hint">Music couldn’t load. Refresh to try again.</p>'; return; }
    tracks.forEach(function (tr) {
      var c = (tr.colors && tr.colors.length) ? tr.colors : ['#a457ff', '#22d3ee'];
      var wrap = document.createElement('div');
      wrap.className = 'track'; wrap.dataset.track = tr.id;
      wrap.style.setProperty('--c1', c[0]); wrap.style.setProperty('--c2', c[1] || c[0]);
      var playB = document.createElement('button');
      playB.type = 'button'; playB.className = 'track-play';
      playB.innerHTML = ICON.play + ICON.stop;
      playB.setAttribute('aria-label', 'Preview ' + tr.name);
      playB.addEventListener('click', function (e) { e.stopPropagation(); toggleTrackPreview(tr.id); });
      var pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'track-pick';
      var nm = document.createElement('span'); nm.className = 'track-name'; nm.textContent = tr.name;
      var meta = document.createElement('span'); meta.className = 'track-meta'; meta.textContent = tr.genre || 'Original';
      var bpm = document.createElement('span'); bpm.className = 'track-bpm'; bpm.innerHTML = '<i></i>'; bpm.appendChild(document.createTextNode(tr.bpm + ' BPM'));
      pick.appendChild(nm); pick.appendChild(meta); pick.appendChild(bpm);
      pick.setAttribute('aria-label', 'Use ' + tr.name + ', ' + (tr.genre || '') + ', ' + tr.bpm + ' BPM');
      pick.addEventListener('click', function () { selectTrack(tr.id); });
      var eq = document.createElement('span'); eq.className = 'eq'; eq.setAttribute('aria-hidden', 'true'); eq.innerHTML = '<i></i><i></i><i></i>';
      var best = document.createElement('span'); best.className = 'best'; best.textContent = 'Best match'; best.hidden = true; best.setAttribute('aria-hidden', 'true');
      wrap.appendChild(playB); wrap.appendChild(pick); wrap.appendChild(eq); wrap.appendChild(best);
      el.tracks.appendChild(wrap);
      trackCards[tr.id] = { wrap: wrap, play: playB, pick: pick, best: best };
    });
    // "My song": the user's own audio file; the template cuts on its beat
    var ow = document.createElement('div');
    ow.className = 'track track-own'; ow.dataset.track = 'own';
    ow.style.setProperty('--c1', '#22d3ee'); ow.style.setProperty('--c2', '#a457ff');
    var oPlay = document.createElement('button');
    oPlay.type = 'button'; oPlay.className = 'track-play'; oPlay.innerHTML = ICON.play + ICON.stop;
    oPlay.setAttribute('aria-label', 'Preview your song');
    oPlay.addEventListener('click', function (e) { e.stopPropagation(); if (!S.own) { openOwnPicker(); return; } toggleTrackPreview('own'); });
    var oPick = document.createElement('button');
    oPick.type = 'button'; oPick.className = 'track-pick';
    var on = document.createElement('span'); on.className = 'track-name'; on.textContent = 'My song';
    var om = document.createElement('span'); om.className = 'track-meta'; om.textContent = 'Upload a song';
    var ob = document.createElement('span'); ob.className = 'track-bpm'; ob.innerHTML = '<i></i>'; ob.appendChild(document.createTextNode('Your beat'));
    oPick.appendChild(on); oPick.appendChild(om); oPick.appendChild(ob);
    oPick.setAttribute('aria-label', 'Use my own song');
    oPick.addEventListener('click', function () { if (!S.own) openOwnPicker(); else selectTrack('own'); });
    var oeq = document.createElement('span'); oeq.className = 'eq'; oeq.setAttribute('aria-hidden', 'true'); oeq.innerHTML = '<i></i><i></i><i></i>';
    var obest = document.createElement('span'); obest.className = 'best'; obest.hidden = true;
    ow.appendChild(oPlay); ow.appendChild(oPick); ow.appendChild(oeq); ow.appendChild(obest);
    el.tracks.appendChild(ow);
    trackCards.own = { wrap: ow, play: oPlay, pick: oPick, best: obest, meta: om, bpm: ob };
    updateTrackUI();
  }
  function updateTrackUI() {
    var t = tplById(S.templateId);
    Object.keys(trackCards).forEach(function (id) {
      var c = trackCards[id], sel = id === S.trackId;
      c.wrap.classList.toggle('sel', sel);
      c.pick.setAttribute('aria-pressed', sel ? 'true' : 'false');
      c.best.hidden = id === 'own' || !(t && t.track === id);
    });
    var oc = trackCards.own;
    if (oc) {
      oc.meta.textContent = S.own ? S.own.name : 'Upload a song';
      oc.bpm.lastChild.textContent = S.own ? Math.round(S.own.bpm) + ' BPM' : 'Your beat';
      oc.pick.setAttribute('aria-label', S.own ? 'Use my song, ' + S.own.name + ', about ' + Math.round(S.own.bpm) + ' BPM' : 'Use my own song (choose a file)');
    }
    renderOwnBar();
    updateNowLine();
  }
  function selectTrack(id) {
    var tr = id === 'own' ? (S.own ? { id: 'own' } : null) : trackById(id);
    if (!tr) return;
    var changed = tr.id !== S.trackId;
    S.trackId = tr.id;
    stopTrackPreview();
    updateTrackUI();
    if (!S.photos.length) return;
    if (changed || !S.scene) scheduleRebuild({ autoplay: true });
    else if (!S.playing && !S.building) play();
  }

  var tp = { id: null, src: null, token: 0 };
  function setTrackPlayState(id, cls, on) { var c = trackCards[id]; if (c) c.play.classList.toggle(cls, on); }
  /* My song: decode, find the beat (GlowBeat), start on a downbeat. Kept in memory for this visit only. */
  var ownSeq = 0;
  function openOwnPicker() { if (!el.ownFile) return; try { el.ownFile.value = ''; } catch (e) { /* ignore */ } el.ownFile.click(); }
  async function loadOwn(file) {
    if (!file) return;
    if (!(/^audio\//i.test(file.type || '') || /\.(mp3|m4a|aac|mp4|wav|wave|ogg|oga|opus|webm|flac)$/i.test(file.name || ''))) { toast('That file doesn’t look like a song. Use an MP3, M4A, WAV or OGG file.', 'warn', 5000); return; }
    if (file.size > 20 * 1024 * 1024) { toast('Please use a song file up to 20 MB (an MP3 or M4A is much smaller than a WAV).', 'warn', 6000); return; }
    if (S.exporting) return;
    var ctx = ensureAudio();
    if (!ctx) { toast('Audio isn’t supported in this browser.', 'error'); return; }
    var seq = ++ownSeq;
    toast('Opening your song…', 'info', 1800);
    try {
      var ab = await file.arrayBuffer();
      var buf = await new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
      if (seq !== ownSeq) return;
      var beat = null;
      try { beat = BEAT ? await BEAT.analyze(buf) : null; } catch (e) { beat = null; }
      if (seq !== ownSeq) return;
      var own = { name: (file.name || 'My song').replace(/\.[a-z0-9]+$/i, ''), buffer: buf, beat: beat, bpm: beat && beat.bpm > 0 ? beat.bpm : 120, start: 0, offset: 0 };
      own.start = liveliestStart(own);
      own.offset = downbeatAt(own, own.start);
      S.own = own;
      stopTrackPreview();
      selectTrack('own');
      toast(beat && beat.bpm ? 'Your song: about ' + Math.round(beat.bpm) + ' BPM — the template cuts on its beat.' : 'Your song is ready. No steady beat was found, so cuts follow 120 BPM.', 'ok', 4000);
    } catch (e) {
      console.warn('[glow] song decode failed', e);
      if (seq === ownSeq) toast('That song couldn’t be opened in this browser. Try an MP3 or M4A file.', 'warn', 6000);
    }
  }
  // the first downbeat at or after t (beat 0 of the template lands on it)
  function downbeatAt(own, t) {
    var d = own.beat && own.beat.downbeats ? own.beat.downbeats : [];
    for (var i = 0; i < d.length; i++) if (d[i] >= t - 0.02) return d[i];
    return Math.max(0, t);
  }
  // the liveliest 20 seconds (loudest beats) — usually the chorus — as the default start
  function liveliestStart(own) {
    var b = own.beat, len = 20;
    if (!b || !b.downbeats || !b.downbeats.length || own.buffer.duration <= len + 1) return b && b.firstDownbeat != null ? b.firstDownbeat : 0;
    var best = b.downbeats[0], bs = -1;
    b.downbeats.forEach(function (d) {
      if (d + len > own.buffer.duration) return;
      var e = 0, c = 0;
      b.beats.forEach(function (t, k) { if (t >= d && t < d + len) { e += b.energy[k] || 0; c++; } });
      if (c && e / c > bs + 0.02) { bs = e / c; best = d; }
    });
    return best;
  }
  function moveOwn(bars) {
    var own = S.own; if (!own) return;
    var d = own.beat && own.beat.downbeats && own.beat.downbeats.length ? own.beat.downbeats : null, at = own.offset;
    if (d) {
      var i = d.indexOf(at); if (i < 0) i = 0;
      i = Math.max(0, Math.min(d.length - 1, i + bars));
      at = d[i];
    } else at = Math.max(0, Math.min(own.buffer.duration - 4, at + bars * 4 * 60 / own.bpm));
    own.start = own.offset = at;
    stopTrackPreview();
    renderOwnBar();
    if (S.photos.length) scheduleRebuild({ autoplay: S.playing });
  }
  function renderOwnBar() {
    if (!el.own) return;
    var on = ownOn();
    el.own.hidden = !on; if (el.ownNote) el.ownNote.hidden = !on;
    if (!on) return;
    var t = S.own.offset, m = Math.floor(t / 60), sec = Math.floor(t - m * 60);
    el.ownName.textContent = S.own.name;
    el.ownMeta.textContent = (S.own.beat && S.own.beat.bpm ? 'about ' + Math.round(S.own.bpm) + ' BPM' : 'no steady beat found') + ' · starts on a downbeat';
    el.ownAt.textContent = 'Starts at ' + m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function stopTrackPreview() {
    if (!tp.id) return;
    var id = tp.id;
    tp.token++;
    if (tp.src) { try { tp.src.onended = null; tp.src.stop(); } catch (e) { /* ignore */ } try { tp.src.disconnect(); } catch (e) { /* ignore */ } }
    tp.src = null; tp.id = null;
    setTrackPlayState(id, 'on', false); setTrackPlayState(id, 'busy', false);
    var c = trackCards[id]; if (c) c.play.setAttribute('aria-label', 'Preview ' + (trackById(id) || {}).name);
  }
  async function toggleTrackPreview(id) {
    if (tp.id === id) { stopTrackPreview(); return; }
    stopTrackPreview();
    if (S.playing) pause();
    var ctx = ensureAudio();
    if (!ctx) { toast('Audio isn’t supported in this browser.', 'error'); return; }
    var token = ++tp.token;
    tp.id = id;
    setTrackPlayState(id, 'busy', true);
    try {
      var buf = id === 'own' ? ownSlice(Math.min(8, S.own.buffer.duration - S.own.offset)) : await getMusic(id, 8);
      if (token !== tp.token) return;
      var src = ctx.createBufferSource();
      src.buffer = buf; src.connect(master); src.start();
      src.onended = function () { if (tp.src === src) stopTrackPreview(); };
      tp.src = src;
      setTrackPlayState(id, 'busy', false); setTrackPlayState(id, 'on', true);
      var c = trackCards[id]; if (c) c.play.setAttribute('aria-label', 'Stop preview of ' + (trackById(id) || {}).name);
    } catch (e) {
      console.warn('[glow] track preview failed', e);
      if (token === tp.token) { stopTrackPreview(); toast('Couldn’t play that track preview.', 'error'); }
    }
  }

  function setVolume(v) {
    S.volume = clamp(v, 0, 1);
    el.volOut.textContent = Math.round(S.volume * 100) + '%';
    el.volume.style.setProperty('--p', Math.round(S.volume * 100) + '%');
    if (master && actx) { try { master.gain.setTargetAtTime(S.volume, actx.currentTime, 0.015); } catch (e) { master.gain.value = S.volume; } }
    if (EX.gain && actx) { try { EX.gain.gain.setTargetAtTime(S.volume, actx.currentTime, 0.015); } catch (e) { /* ignore */ } }
  }

  /* ------------------------------------------------------------------ *
   * Style controls
   * ------------------------------------------------------------------ */
  function renderOptions() {
    el.aspects.textContent = '';
    ASPECTS.forEach(function (a) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.dataset.aspect = a.id;
      var k = 22 / Math.max(a.w, a.h);
      var shape = document.createElement('span'); shape.className = 'shape';
      shape.style.setProperty('--sw', Math.round(a.w * k)); shape.style.setProperty('--sh', Math.round(a.h * k));
      var bb = document.createElement('b'); bb.textContent = a.id;
      var sm = document.createElement('small'); sm.textContent = a.sub;
      b.appendChild(shape); b.appendChild(bb); b.appendChild(sm);
      b.setAttribute('aria-label', a.id + ' ' + a.sub);
      b.addEventListener('click', function () { setAspect(a.id); });
      el.aspects.appendChild(b);
    });
    el.qualities.textContent = '';
    QUALITIES.forEach(function (q) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.dataset.quality = q.id;
      var bb = document.createElement('b'); bb.textContent = q.label;
      var sm = document.createElement('small'); sm.textContent = q.sub;
      b.appendChild(bb); b.appendChild(sm);
      b.addEventListener('click', function () { S.quality = q.id; updateOptionsUI(); updateCta(); });
      el.qualities.appendChild(b);
    });
    updateOptionsUI();
  }
  function updateOptionsUI() {
    Array.prototype.forEach.call(el.aspects.children, function (b) { b.setAttribute('aria-pressed', b.dataset.aspect === S.aspect ? 'true' : 'false'); });
    Array.prototype.forEach.call(el.qualities.children, function (b) { b.setAttribute('aria-pressed', b.dataset.quality === S.quality ? 'true' : 'false'); });
  }
  function setAspect(id) {
    if (id === S.aspect) return;
    S.aspect = aspectById(id).id;
    updateOptionsUI(); setScreenAspect(); updateCta();
    if (S.photos.length) scheduleRebuild({});
  }

  function surprise() {
    if (!templates.length) return;
    var pool = templates.filter(function (t) { return t.id !== S.templateId; });
    var t = pool[Math.floor(Math.random() * pool.length)] || templates[0];
    var trPool = tracks.filter(function (x) { return x.id !== S.trackId; });
    var tr = trPool[Math.floor(Math.random() * trPool.length)] || tracks[0];
    S.templateId = t.id;
    if (tr) S.trackId = tr.id;
    el.surprise.classList.remove('rolling'); void el.surprise.offsetWidth; el.surprise.classList.add('rolling');
    updateTemplateUI(true); updateTrackUI();
    toast('Surprise! ' + t.name + (tr ? ' × ' + tr.name : ''), 'ok', 2200);
    if (!S.photos.length) loadDemo();
    else scheduleRebuild({ autoplay: true });
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */
  var EX = { cancelled: false, rec: null, raf: 0, gain: null, monitor: null, monitorOn: true, hiddenWarned: false, cleanup: null };
  var resultUrl = null, lastFocus = null;

  function pickMime() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    var list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < list.length; i++) { try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) { /* ignore */ } }
    return '';
  }
  function canRecord() {
    return !!(window.MediaRecorder && window.MediaStream && typeof HTMLCanvasElement.prototype.captureStream === 'function');
  }

  // Everything behind a sheet, including the mode switch and the AI Scenes page that share this document.
  var bgParts = [document.querySelector('.top'), document.querySelector('.modes'), document.getElementById('app'), document.getElementById('ai'), document.getElementById('aiPill')];
  function setInert(on) { bgParts.forEach(function (n) { if (!n) return; if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert'); }); }
  function openModal(m) {
    if (el.exModal.hidden && el.resModal.hidden && el.infoModal.hidden) lastFocus = document.activeElement;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    setInert(true);
  }
  function closeModal(m) {
    m.hidden = true;
    if (!(el.exModal.hidden && el.resModal.hidden && el.infoModal.hidden)) return;
    document.body.style.overflow = '';
    setInert(false);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function showInfo(title, text) {
    el.infoTitle.textContent = title; el.infoText.textContent = text;
    openModal(el.infoModal); el.infoOk.focus();
  }

  function setExport(state, label, frac, left) {
    el.exView.dataset.state = state;
    if (state === 'prep') el.exPrepT.textContent = label || 'Preparing full-quality frames…';
    var bar = el.exBar.parentNode;
    bar.classList.toggle('indet', state === 'prep');
    if (frac != null) el.exBar.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    el.exPct.textContent = state === 'prep' ? 'Getting ready…' : Math.round(clamp(frac || 0, 0, 1) * 100) + '% recorded';
    el.exLeft.textContent = left || '';
  }

  async function exportPhotos(maxSide) {
    // Re-decode user photos at full quality (long side <= 2048) for the export; demo photos are used as-is.
    var out = [], made = [];
    for (var i = 0; i < S.photos.length; i++) {
      var p = S.photos[i];
      if (EX.cancelled) break;
      if (p.demo || !p.file) { out.push(p.src); continue; }
      try { var c = await decodeFile(p.file, maxSide || 2048); out.push(c); made.push(c); }
      catch (e) { out.push(p.src); }
      el.exPrepT.textContent = 'Preparing photos… ' + (i + 1) + ' / ' + S.photos.length;
      await nextTick();
    }
    return { list: out, made: made };
  }

  var exportRun = null, exportQueued = false;
  function startExport() {
    if (S.exporting) {
      // A cancelled export can still be finishing its preparation (building the full-size scene). Don't drop
      // the tap: start the new export as soon as the old one has wound down.
      if (EX.cancelled && exportRun && !exportQueued) {
        exportQueued = true;
        setExport('prep', 'Getting ready…', 0, '');
        openModal(el.exModal);
        el.cancel.focus();
        exportRun.then(function () {
          if (!exportQueued) return; // cancelled again while waiting
          exportQueued = false;
          startExport();
        });
      }
      return;
    }
    exportRun = runExport().catch(function (e) { console.warn('[glow] export', e); });
  }
  async function runExport() {
    if (!S.photos.length) {
      toast('Add a few photos first — or tap “Try demo photos”.', 'warn');
      el.cardPhotos.classList.remove('attention'); void el.cardPhotos.offsetWidth; el.cardPhotos.classList.add('attention');
      try { el.cardPhotos.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
      return;
    }
    if (!FX || typeof FX.createScene !== 'function') { toast('Templates didn’t load. Refresh and try again.', 'error'); return; }
    if (!canRecord()) {
      showInfo('Recording isn’t available', 'This browser can’t record video from a web page yet. Please open Glow Studio in the latest Safari, Chrome, Edge or Firefox to create your video.');
      return;
    }
    var ctx = ensureAudio();
    pause(); stopTrackPreview();
    S.exporting = true;
    EX.cancelled = false; EX.hiddenWarned = false; EX.stalled = false;
    el.exWarn.hidden = true;
    var aspect = aspectById(S.aspect), size = aspect.out[S.quality] || aspect.out['1080'];
    var fresh = el.exCanvas.cloneNode(false);
    el.exCanvas.parentNode.replaceChild(fresh, el.exCanvas);
    el.exCanvas = fresh;
    el.exCanvas.width = size[0]; el.exCanvas.height = size[1];
    el.exView.style.setProperty('--exar', (size[0] / size[1]).toFixed(5));
    setExport('prep', 'Preparing full-quality frames…', 0, '');
    openModal(el.exModal);
    el.cancel.focus();
    var made = [], scene = null;
    try {
      await fontsReady();
      // 1080p needs ~2048 px sources (cover crop + zooms); 720p looks identical from 1536 px and uses ~45% less memory
      var ph = await exportPhotos(Math.max(size[0], size[1]) > 1500 ? 2048 : 1536);
      made = ph.made;
      if (EX.cancelled) return;
      el.exPrepT.textContent = 'Preparing full-quality frames…';
      var track = ownOn() ? null : trackById(S.trackId), own = ownOn();
      scene = await FX.createScene({ templateId: S.templateId, photos: ph.list, width: size[0], height: size[1], bpm: sceneBpm() });
      // The scene keeps its own graded copies, so the big decoded sources can go before recording starts.
      made.forEach(releaseCanvas); made = [];
      if (EX.cancelled) return;
      if (!scene || typeof scene.render !== 'function' || !(scene.duration > 0)) throw new Error('invalid scene');
      el.exPrepT.textContent = 'Mixing the music…';
      var buffer = null;
      if (track || own) { try { buffer = await musicFor(scene.duration); } catch (e) { console.warn('[glow] export music failed', e); } }
      if (EX.cancelled) return;
      if (!buffer && ctx) {
        toast('Music couldn’t be created — your video will be silent.', 'warn');
        buffer = ctx.createBuffer(2, Math.max(1, Math.round(scene.duration * ctx.sampleRate)), ctx.sampleRate);
      }
      if (ctx && ctx.state !== 'running' && ctx.resume) { try { await Promise.race([ctx.resume(), wait(1200)]); } catch (e) { /* ignore */ } }
      if (EX.cancelled) return;
      var res = await record(scene, buffer, size[0], size[1]);
      if (!res) return; // cancelled
      closeModal(el.exModal);
      showResult(res, scene.duration, size);
      if (EX.stalled) toast('The sound was interrupted while recording, so part of the video may be silent. Keep Glow Studio on screen and try again.', 'warn', 7000);
    } catch (e) {
      console.warn('[glow] export failed', e);
      if (!EX.cancelled) {
        closeModal(el.exModal);
        toast('Sorry — the video couldn’t be created' + (e && e.message ? ' (' + e.message + ')' : '') + '. Try 720p or fewer photos.', 'error', 6000);
      }
    } finally {
      S.exporting = false;
      made.forEach(releaseCanvas);
      disposeScene(scene);
      if (!el.exModal.hidden && !exportQueued) closeModal(el.exModal);
      drawPreview();
      setStage();
    }
  }

  function record(scene, buffer, W, H) {
    return new Promise(function (resolve, reject) {
      var cx = el.exCanvas.getContext('2d', { alpha: false }) || el.exCanvas.getContext('2d');
      var text = textObj(), dur = scene.duration, ctx = actx;
      var LEAD = 0.05, TAIL = 0.1;
      var settled = false, stopping = false, src = null, vStream = null, dest = null, rec = null, t0 = 0, watchdog = 0;
      try { scene.render(cx, 0, text); } catch (e) { reject(e); return; }

      // Recording clock: the audio clock (so picture and music stay locked). If it freezes (context suspended or
      // interrupted by the OS), carry on with the wall clock from that point so the export always completes.
      var useCtx = !!ctx, lastCt = -1, lastCtAt = 0, base = -LEAD, baseAt = 0;
      function clock() {
        var now = performance.now();
        if (useCtx) {
          var ct = ctx.currentTime;
          if (ct !== lastCt) { lastCt = ct; lastCtAt = now; return ct - t0; }
          if (now - lastCtAt < 800) return ct - t0;
          useCtx = false; base = ct - t0; baseAt = lastCtAt; EX.stalled = true;
          console.warn('[glow] audio clock stalled during export; continuing on the wall clock');
        }
        return base + (now - baseAt) / 1000;
      }

      function cleanup() {
        cancelAnimationFrame(EX.raf);
        clearInterval(watchdog);
        if (src) { try { src.stop(); } catch (e) { /* ignore */ } try { src.disconnect(); } catch (e) { /* ignore */ } }
        if (EX.gain) { try { EX.gain.disconnect(); } catch (e) { /* ignore */ } }
        if (EX.monitor) { try { EX.monitor.disconnect(); } catch (e) { /* ignore */ } }
        EX.gain = null; EX.monitor = null;
        if (vStream) vStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
        if (dest) dest.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
        EX.rec = null; EX.cleanup = null;
      }
      function fail(e) { if (settled) return; settled = true; cleanup(); reject(e); }

      try {
        vStream = el.exCanvas.captureStream(30);
        var tracksOut = vStream.getVideoTracks().slice();
        if (ctx && buffer && typeof ctx.createMediaStreamDestination === 'function') {
          dest = ctx.createMediaStreamDestination();
          EX.gain = ctx.createGain(); EX.gain.gain.value = S.volume;
          EX.monitor = ctx.createGain(); EX.monitor.gain.value = EX.monitorOn ? 1 : 0;
          src = ctx.createBufferSource(); src.buffer = buffer;
          src.connect(EX.gain); EX.gain.connect(dest); EX.gain.connect(EX.monitor); EX.monitor.connect(ctx.destination);
          tracksOut = tracksOut.concat(dest.stream.getAudioTracks());
        } else {
          toast('Audio recording isn’t supported here — the video will be silent.', 'warn');
        }
        var stream = new MediaStream(tracksOut);
        var mime = pickMime();
        var opts = { videoBitsPerSecond: Math.min(W, H) >= 1080 ? 12e6 : 6e6, audioBitsPerSecond: 192000 };
        if (mime) opts.mimeType = mime;
        try { rec = new MediaRecorder(stream, opts); }
        catch (e) { rec = new MediaRecorder(stream); }
        EX.rec = rec;
      } catch (e) { fail(e); return; }

      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = function (e) { fail((e && e.error) || new Error('recorder error')); };

      function finish() {
        if (settled || stopping) return;
        stopping = true;
        var recDur = clock() + LEAD; // the recorder started LEAD seconds before scene time 0
        rec.onstop = function () {
          if (settled) return;
          settled = true;
          var type = (rec.mimeType || opts.mimeType || 'video/webm').split(';')[0] || 'video/webm';
          var blob = new Blob(chunks, { type: type });
          cleanup();
          if (!blob.size) { reject(new Error('empty recording')); return; }
          if (/webm/i.test(type)) {
            fixWebmDuration(blob, recDur * 1000).then(function (b) { resolve({ blob: b, type: type }); }, function () { resolve({ blob: blob, type: type }); });
          } else resolve({ blob: blob, type: type });
        };
        try { rec.stop(); } catch (e) { fail(e); }
      }
      EX.cleanup = function () {
        // cancel
        if (settled) return;
        settled = true;
        rec.onstop = null; rec.ondataavailable = null;
        try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* ignore */ }
        cleanup();
        resolve(null);
      };

      var started = false;
      function begin() {
        if (started || settled) return;
        started = true;
        baseAt = lastCtAt = performance.now();
        t0 = ctx ? ctx.currentTime + LEAD : 0;
        if (ctx) lastCt = ctx.currentTime;
        if (src) { try { src.start(t0); } catch (e) { fail(e); return; } }
        setExport('rec', '', 0, fmt(dur) + ' left');
        // rAF pauses in background tabs; this keeps the clock checked so the recording still ends on time
        watchdog = setInterval(function () { if (!settled && clock() >= dur + TAIL) finish(); }, 250);
        var tick = function () {
          if (settled || stopping) return;
          var t = clock();
          var tc = clamp(t, 0, dur);
          try { scene.render(cx, tc, text); } catch (e) { fail(e); return; }
          setExport('rec', '', tc / dur, Math.max(0, Math.ceil(dur - tc)) + ' s left');
          if (t >= dur + TAIL) { finish(); return; }
          EX.raf = requestAnimationFrame(tick);
        };
        EX.raf = requestAnimationFrame(tick);
      }
      // Start drawing right away: some recorders only fire onstart once the canvas produces frames.
      try { rec.start(250); } catch (e) { fail(e); return; }
      begin();
    });
  }

  function cancelExport() {
    if (exportQueued) { exportQueued = false; closeModal(el.exModal); toast('Export cancelled'); return; }
    if (!S.exporting) { closeModal(el.exModal); return; }
    EX.cancelled = true;
    if (EX.cleanup) EX.cleanup();
    closeModal(el.exModal);
    toast('Export cancelled');
  }

  function showResult(res, dur, size) {
    if (resultUrl) { try { URL.revokeObjectURL(resultUrl); } catch (e) { /* ignore */ } }
    resultUrl = URL.createObjectURL(res.blob);
    var ext = /mp4/i.test(res.type) ? 'mp4' : 'webm';
    var name = 'glow-' + S.templateId + '-' + S.aspect.replace(':', 'x') + '.' + ext;
    el.resModal.querySelector('.res-video').style.setProperty('--resar', (size[0] / size[1]).toFixed(5));
    el.video.src = resultUrl;
    el.dl.href = resultUrl;
    el.dl.setAttribute('download', name);
    el.resMeta.textContent = size[0] + '×' + size[1] + ' · ' + fmt(dur) + ' · ' + fmtBytes(res.blob.size) + ' · ' + ext.toUpperCase() + ' · no watermark';
    var file = null;
    try { file = new File([res.blob], name, { type: res.blob.type || res.type }); } catch (e) { file = null; }
    var canShare = false;
    try { canShare = !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) { canShare = false; }
    el.share.hidden = !canShare;
    el.share.onclick = function () {
      navigator.share({ files: [file], title: 'My Glow Studio video', text: 'Made with Glow Studio' }).catch(function (e) {
        if (e && e.name !== 'AbortError') toast('Sharing didn’t work — try Download instead.', 'warn');
      });
    };
    window.GlowApp.lastResult = { blob: res.blob, size: res.blob.size, type: res.type, name: name, duration: dur, width: size[0], height: size[1] };
    openModal(el.resModal);
    el.dl.focus();
    var pr = el.video.play && el.video.play();
    if (pr && pr.catch) pr.catch(function () { /* autoplay blocked — user can press play */ });
  }
  function closeResult() {
    try { el.video.pause(); } catch (e) { /* ignore */ }
    closeModal(el.resModal);
  }

  /* Patch the missing Duration into MediaRecorder WebM output so players can seek. */
  function fixWebmDuration(blob, ms) {
    return blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer().then(function (ab) {
      var b = new Uint8Array(ab);
      function vint(pos, keep) {
        var first = b[pos]; if (first === undefined) return null;
        var len = 1, mask = 0x80;
        while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
        if (len > 8 || pos + len > b.length) return null;
        var val = keep ? first : (first & (mask - 1)), ones = (first & (mask - 1)) === mask - 1;
        for (var i = 1; i < len; i++) { val = val * 256 + b[pos + i]; if (b[pos + i] !== 0xff) ones = false; }
        return { len: len, val: val, unknown: !keep && ones };
      }
      var pos = 0, id = vint(0, true);
      if (!id || id.val !== 0x1A45DFA3) return blob;
      var sz = vint(id.len); if (!sz) return blob;
      pos = id.len + sz.len + sz.val;
      id = vint(pos, true); if (!id || id.val !== 0x18538067) return blob;
      sz = vint(pos + id.len); if (!sz) return blob;
      pos += id.len + sz.len;
      while (pos < b.length) {
        id = vint(pos, true); if (!id) return blob;
        sz = vint(pos + id.len); if (!sz) return blob;
        var start = pos + id.len + sz.len;
        if (id.val === 0x1549A966) {
          if (sz.unknown) return blob;
          var end = start + sz.val; if (end > b.length) return blob;
          var p = start, scale = 1000000, keep = [];
          while (p < end) {
            var cid = vint(p, true); if (!cid) return blob;
            var cs = vint(p + cid.len); if (!cs) return blob;
            var ds = p + cid.len + cs.len, de = ds + cs.val;
            if (cid.val === 0x2AD7B1) { var v = 0; for (var i = ds; i < de; i++) v = v * 256 + b[i]; if (v) scale = v; }
            if (cid.val === 0x4489) {
              var dv = new DataView(ab, ds, cs.val), d = cs.val === 8 ? dv.getFloat64(0) : cs.val === 4 ? dv.getFloat32(0) : 0;
              if (d > 0) return blob;
            } else keep.push(b.subarray(p, de));
            p = de;
          }
          var durEl = new Uint8Array(11); durEl[0] = 0x44; durEl[1] = 0x89; durEl[2] = 0x88;
          new DataView(durEl.buffer).setFloat64(3, ms * 1e6 / scale);
          var bodyLen = 11; keep.forEach(function (k) { bodyLen += k.length; });
          var head = new Uint8Array(12); head.set([0x15, 0x49, 0xA9, 0x66, 0x01]);
          var rem = bodyLen; for (var j = 11; j >= 5; j--) { head[j] = rem & 0xff; rem = Math.floor(rem / 256); }
          return new Blob([b.subarray(0, pos), head].concat(keep, [durEl, blob.slice(end)]), { type: blob.type });
        }
        if (id.val === 0x1F43B675 || sz.unknown) return blob;
        pos = start + sz.val;
      }
      return blob;
    }).catch(function () { return blob; });
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  el.btnAdd.addEventListener('click', openPicker);
  el.emptyAdd.addEventListener('click', openPicker);
  el.btnDemo.addEventListener('click', loadDemo);
  el.emptyDemo.addEventListener('click', loadDemo);
  el.btnClear.addEventListener('click', clearPhotos);
  if (el.ownFile) el.ownFile.addEventListener('change', function () { var f = el.ownFile.files; if (f && f.length) loadOwn(f[0]); });
  if (el.ownChange) el.ownChange.addEventListener('click', openOwnPicker);
  if (el.ownPrev) el.ownPrev.addEventListener('click', function () { moveOwn(-4); });
  if (el.ownNext) el.ownNext.addEventListener('click', function () { moveOwn(4); });
  el.file.addEventListener('change', function () { var f = el.file.files; if (f && f.length) addFiles(f); });
  el.surprise.addEventListener('click', surprise);
  el.create.addEventListener('click', startExport);
  el.cancel.addEventListener('click', cancelExport);
  el.exMonitor.addEventListener('click', function () {
    EX.monitorOn = !EX.monitorOn;
    el.exMonitor.setAttribute('aria-pressed', EX.monitorOn ? 'true' : 'false');
    el.exMonitor.setAttribute('aria-label', EX.monitorOn ? 'Mute sound while recording' : 'Play sound while recording');
    if (EX.monitor && actx) { try { EX.monitor.gain.setTargetAtTime(EX.monitorOn ? 1 : 0, actx.currentTime, 0.02); } catch (e) { EX.monitor.gain.value = EX.monitorOn ? 1 : 0; } }
  });
  el.resClose.addEventListener('click', closeResult);
  el.another.addEventListener('click', function () {
    closeResult();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  });
  el.dl.addEventListener('click', function () { toast('Saving your video…', 'ok', 2000); });
  el.infoOk.addEventListener('click', function () { closeModal(el.infoModal); });
  el.resModal.addEventListener('click', function (e) { if (e.target === el.resModal) closeResult(); });
  el.infoModal.addEventListener('click', function (e) { if (e.target === el.infoModal) closeModal(el.infoModal); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!el.resModal.hidden) closeResult();
    else if (!el.infoModal.hidden) closeModal(el.infoModal);
  });

  el.volume.addEventListener('input', function () { setVolume(el.volume.value / 100); });
  el.title.addEventListener('input', function () { S.title = el.title.value; if (!S.playing) drawPreview(); });
  el.subtitle.addEventListener('input', function () { S.subtitle = el.subtitle.value; if (!S.playing) drawPreview(); });
  [el.title, el.subtitle].forEach(function (inp) {
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
  });

  // drag & drop (desktop)
  var dragDepth = 0;
  function hasFiles(e) { if (otherMode()) return false; var dt = e.dataTransfer; return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e) || S.exporting) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) { /* ignore */ } });
  document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (S.exporting) return;
    addFiles(e.dataTransfer.files);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (S.exporting) {
        EX.hiddenWarned = true;
        el.exWarn.textContent = 'Heads up: this tab was in the background, so some frames may stutter. Keep Glow Studio on screen until it finishes — or cancel and try again.';
        el.exWarn.hidden = false;
      } else if (S.playing) pause();
      stopTrackPreview();
    }
  });
  window.addEventListener('beforeunload', function (e) { if (S.exporting) { e.preventDefault(); e.returnValue = ''; } });

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  window.GlowApp = {
    lastResult: null,
    util: { pickMime: pickMime, fixWebmDuration: fixWebmDuration },
    get state() {
      return {
        photos: S.photos.length, templateId: S.templateId, trackId: S.trackId, aspect: S.aspect, quality: S.quality,
        playing: S.playing, building: S.building, exporting: S.exporting, duration: S.scene ? S.scene.duration : 0,
        time: nowT(), hasMusic: !!S.buffer, stage: el.screen.dataset.state,
        own: S.own ? { name: S.own.name, bpm: S.own.bpm, offset: S.own.offset, duration: S.own.buffer.duration } : null, bpm: sceneBpm(), bufferDuration: S.buffer ? S.buffer.duration : 0
      };
    }
  };

  renderTemplates();
  renderTracks();
  renderOptions();
  renderTray();
  setScreenAspect();
  setVolume(el.volume.value / 100);
  setStage();
  updateTimeUI();
  updateCta();
  if (!FX) toast('Templates didn’t load — please refresh the page.', 'error', 6000);
  else if (!MU) toast('Music didn’t load — videos will be silent.', 'warn', 6000);
  // Posters start after first paint so the page appears instantly — and only once Photo Video is on screen
  // (AI Scenes is the default mode, and rendering 12 posters behind it would only slow phones down).
  var postersStarted = false;
  function startPosters() {
    if (postersStarted) return;
    postersStarted = true;
    if ('requestIdleCallback' in window) requestIdleCallback(function () { schedulePosters(0); }, { timeout: 900 });
    else schedulePosters(250);
  }
  if (!otherMode()) startPosters();
})();
