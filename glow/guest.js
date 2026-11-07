/* Glow Studio — a friend's page (guest.js): "Share with friends" on the host's PC.
 *
 * The host's Glow Studio app serves this same web app to friends through a separate guest server (an internet link
 * through Cloudflare, or the home Wi-Fi). That server marks the page with window.GLOW_GUEST; on any other page this
 * script does nothing (window.GlowGuest = null). A friend's video is made on the host's graphics card, from preset
 * scenes only: the page sends a small job request (scene, length, sound, a tempo number…) plus the selfie and, for
 * lip-sync to their own song, a short WAV of that part of the song. The host's app builds the AI steps itself, puts
 * the "AI-generated" label on every picture and clip, and this page polls for progress (no WebSocket), downloads the
 * labelled shots and finishes the video in the browser as usual (music + label), saving it on the friend's device.
 *
 *   GlowGuest = { active, secure, session, start(), setName(name), plan(req), submit({request, photo, audio, ownStart},
 *     onProgress, signal), attach(job, onProgress, signal, opts), current(), cancel(id), done(id), claim(code), leave(),
 *     preparePhoto(blob), wavSegment(audioBuffer, start, seconds), estimateStory(o), uuid(), hostName() }
 *
 * Works without a secure context (plain http on a home Wi-Fi): no crypto.randomUUID, navigator.locks, clipboard or
 * Web Share is needed here.
 */
(function () {
  'use strict';
  var CFG = window.GLOW_GUEST;
  if (!CFG || typeof CFG !== 'object') { window.GlowGuest = null; return; }
  var T = (window.__GLOW_GUEST_TEST__ && typeof window.__GLOW_GUEST_TEST__ === 'object') ? window.__GLOW_GUEST_TEST__ : {};
  var BASE = '/__glow/guest/';
  var POLL_MS = T.pollMs || 3000, HIDDEN_MS = T.hiddenPollMs || 15000, SESSION_MS = T.sessionPollMs || 30000;
  var secure = window.isSecureContext === true;
  try { document.documentElement.setAttribute('data-secure', secure ? '1' : '0'); } catch (e) { /* ignore */ }

  function GuestError(code, message, extra) {
    var e = new Error(message || code);
    e.name = 'GlowGuestError'; e.code = code || 'failed';
    if (extra) Object.keys(extra).forEach(function (k) { if (k !== 'message' && k !== 'error') e[k] = extra[k]; });
    return e;
  }
  function abortError() { var e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function wait(ms, signal) {
    return new Promise(function (res, rej) {
      var t = setTimeout(done, ms);
      function done() { if (signal) signal.removeEventListener('abort', ab); res(); }
      function ab() { clearTimeout(t); rej(abortError()); }
      if (signal) { if (signal.aborted) { clearTimeout(t); rej(abortError()); return; } signal.addEventListener('abort', ab); }
    });
  }
  // random ids without crypto.randomUUID (missing in plain-http pages)
  function uuid() {
    var b = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') window.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  var G = {
    active: true, secure: secure, session: null, error: null, ready: null,
    start: start, refresh: refresh, setName: setName, plan: plan, submit: submit, attach: attach, current: current,
    cancel: cancel, done: done, claim: claim, leave: leave, preparePhoto: preparePhoto, wavSegment: wavSegment,
    estimateStory: estimateStory, uuid: uuid, hostName: hostName, onSession: null
  };
  function hostName() { var s = G.session; return (s && s.host && s.host.name) || 'your friend'; }

  /* ---------------- HTTP ---------------- */
  function api(method, path, body, opt) {
    opt = opt || {};
    var init = { method: method, cache: 'no-store', credentials: 'same-origin', headers: {}, signal: opt.signal };
    if (method !== 'GET') {
      if (opt.join) init.headers['X-Glow-Guest'] = '1';
      else if (G.session && G.session.csrf) init.headers['X-Glow-CSRF'] = G.session.csrf;
      if (body instanceof FormData) init.body = body;
      else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
    }
    return fetch(BASE + path, init).then(function (r) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      var p = ct.indexOf('json') >= 0 ? r.json().catch(function () { return null; }) : r.text().then(function () { return null; });
      return p.then(function (data) {
        if (r.ok) return data || {};
        var code = (data && data.error) || (r.status === 401 ? 'no-session' : r.status === 404 ? 'not-found' : r.status === 413 ? 'too-large' : r.status === 429 ? 'too-many-attempts' : 'http-' + r.status);
        var e = GuestError(code, (data && data.message) || '', data || {});
        e.status = r.status;
        e.retryAfter = +(r.headers.get('Retry-After') || 0) || 0;
        if (r.status === 401) { G.session = null; notify(); }
        throw e;
      });
    }, function (err) {
      if (opt.signal && opt.signal.aborted) throw abortError();
      throw GuestError('network', 'Can’t reach ' + hostName() + '’s PC right now.', { detail: String(err && err.message || err) });
    });
  }
  function notify() { if (typeof G.onSession === 'function') { try { G.onSession(G.session); } catch (e) { /* the page's problem */ } } }
  function setSession(s) { if (s && s.session) s = s.session; G.session = s || null; notify(); return G.session; }

  /* ---------------- joining ---------------- */
  // ?join=<token> -> a session cookie (HttpOnly, set by the host's app); the token leaves the address bar at once.
  function start() {
    if (G.ready) return G.ready;
    var token = null;
    try { token = new URLSearchParams(location.search).get('join'); } catch (e) { var m = /[?&]join=([^&#]+)/.exec(location.search); token = m ? decodeURIComponent(m[1]) : null; }
    if (token) {
      try {
        var q = location.search.replace(/([?&])join=[^&#]*&?/, '$1').replace(/[?&]$/, '');
        history.replaceState(null, '', location.pathname + q + location.hash);
      } catch (e) { /* ignore */ }
    }
    // (hello first: a page opened without a session asks nothing that would only answer "no session")
    var known = function () { return api('GET', 'hello').then(function (h) { G.sharing = h.sharing; return h.session ? refresh() : null; }); };
    var joined = token ? api('POST', 'join', { token: String(token).slice(0, 200) }, { join: true }).then(setSession, function (e) {
      // an old link: still fine when this browser already has a session from the current link
      return known().then(function (s) { if (!s) G.error = e; return s; }, function () { G.error = e; return null; });
    }) : known().then(function (s) { if (!s && G.sharing !== 'on') G.error = GuestError('not-accepting', ''); return s; }, function (e) { G.error = e; return null; });
    G.ready = joined.then(function (s) { if (s) G.error = null; keepAlive(); return s; });
    return G.ready;
  }
  function refresh() {
    return api('GET', 'session').then(setSession, function (e) {
      if (e && (e.code === 'no-session' || e.status === 401)) { setSession(null); return null; }
      throw e;
    });
  }
  // "online" for the host: a light session check now and then while the page is open and nothing is being made
  var aliveTimer = 0, polling = 0;
  function keepAlive() {
    clearTimeout(aliveTimer);
    aliveTimer = setTimeout(function () {
      if (!document.hidden && G.session && !polling) refresh().catch(function () { /* next time */ });
      keepAlive();
    }, SESSION_MS);
  }
  function setName(name) { return api('POST', 'name', { name: String(name || '') }).then(function (r) { return refresh().then(function () { return r; }); }); }
  function plan(req) { return api('POST', 'plan', req); }
  function current() { return api('GET', 'jobs/current').then(function (r) { return r.job || null; }); }
  function cancel(id) { return api('POST', 'jobs/' + encodeURIComponent(id) + '/cancel', {}); }
  function done(id) { return api('POST', 'jobs/' + encodeURIComponent(id) + '/done', {}).catch(function () { /* the host deletes it within a day anyway */ }); }
  function claim(code) { return api('POST', 'claim', { code: String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^(.{5})(.{5})$/, '$1-$2') }).then(function (r) { return refresh().then(function () { return r.job || null; }); }); }
  function leave() { return api('POST', 'leave', {}).then(function () { setSession(null); }); }

  /* ---------------- a video ---------------- */
  // photo: the canvas re-encode already made by preparePhoto(); audio: the WAV part of the friend's song (lip-sync)
  function submit(o, onProgress, signal) {
    o = o || {};
    if (signal && signal.aborted) return Promise.reject(abortError());
    var fd = new FormData();
    fd.append('request', new Blob([JSON.stringify(o.request)], { type: 'application/json' }), 'request.json');
    fd.append('selfie', o.photo, 'selfie.jpg');
    if (o.audio) fd.append('audio', o.audio, 'audio.wav');
    emit(onProgress, { stage: 'upload', shot: null, shots: (o.request && o.request.duration >= 20) ? 4 : (o.request && o.request.duration >= 10) ? 2 : 1, pct: 0, overall: 0, message: 'Sending your photo to ' + hostName() + '’s PC…' });
    return api('POST', 'jobs', fd, { signal: signal }).then(function (r) {
      var job = r.job;
      if (!job || !job.id) throw GuestError('failed', 'The host’s PC didn’t accept the video.');
      emit(onProgress, { stage: 'accepted', job: job.id, code: job.code, serverJob: job });
      return attach(job, onProgress, signal, { ownStart: o.ownStart });
    });
  }
  function emit(fn, p) { if (typeof fn === 'function') { try { fn(p); } catch (e) { /* a UI error must never break the job */ } } }
  function rangeOf(m) { return Array.isArray(m) && m.length === 2 ? m[0] + '–' + m[1] + ' min' : ''; }
  function queueText(q) {
    if (!q) return 'Your video is in line.';
    var who = hostName();
    if (!q.ahead && q.hostBusy) return who + ' is making a video too — yours continues right after.';
    if (!q.ahead) return 'You’re next — yours starts in a moment.';
    var t = q.ahead + ' video' + (q.ahead > 1 ? 's' : '') + ' ahead of you';
    if (q.startMin && q.startMin[1] > 0) t += ' · yours starts in about ' + rangeOf(q.startMin);
    return t;
  }

  // Follows a job on the host's PC until it is made, then fetches the labelled shots: the same result as
  // GlowLocalAI.generateStory(), so the page finishes it the usual way.
  function attach(job, onProgress, signal, opts) {
    opts = opts || {};
    var id = job.id, stills = {}, fails = 0, last = job, lastState = '', stillsBusy = false;
    var abortSent = false;
    function onAbort() { if (!abortSent) { abortSent = true; cancel(id).catch(function () { /* the host cancels it when it notices */ }); } }
    if (signal) { if (signal.aborted) { onAbort(); return Promise.reject(abortError()); } signal.addEventListener('abort', onAbort); }
    polling++;
    var wake = null;
    function onVis() { if (!document.hidden && wake) wake(); }
    document.addEventListener('visibilitychange', onVis);
    function nap(ms) {
      return new Promise(function (res, rej) {
        var t = setTimeout(go, ms);
        function go() { wake = null; if (signal) signal.removeEventListener('abort', ab); res(); }
        function ab() { clearTimeout(t); wake = null; rej(abortError()); }
        wake = function () { clearTimeout(t); go(); };
        if (signal) signal.addEventListener('abort', ab);
      });
    }
    function report(j) {
      last = j;
      var st = j.state;
      if (st === 'waiting-approval') emit(onProgress, { stage: 'approval', job: id, code: j.code, shot: null, shots: shotsOf(j), pct: 0, overall: 0, message: 'Waiting for ' + hostName() + ' to approve your video.', queue: j.queue || null });
      else if (st === 'queued') emit(onProgress, { stage: 'queue', job: id, code: j.code, shot: null, shots: shotsOf(j), pct: 0, overall: 0, ahead: j.queue ? j.queue.ahead : 0, hostBusy: !!(j.queue && j.queue.hostBusy), startMin: j.queue ? j.queue.startMin : null, doneMin: j.queue ? j.queue.doneMin : null, message: queueText(j.queue) });
      else if (st === 'running' && j.progress) {
        var p = j.progress, ev = { stage: p.stage || 'still', job: id, code: j.code, shot: p.shot != null ? p.shot : null, shots: p.shots || shotsOf(j), pct: +p.pct || 0, overall: +p.overall || 0, message: p.message || '', step: p.step || '', doneMin: j.queue ? j.queue.doneMin : null };
        emit(onProgress, ev);
      }
      lastState = st;
    }
    function shotsOf(j) { return j.plan && j.plan.shots ? j.plan.shots.length : 1; }
    // labelled scene photos, as soon as each one is made (the shot strip)
    function fetchStills(j) {
      if (stillsBusy) return Promise.resolve();
      var todo = (j.files || []).filter(function (f) { return f.kind === 'still' && f.shot != null && !stills[f.shot]; });
      if (!todo.length) return Promise.resolve();
      stillsBusy = true;
      var chain = Promise.resolve();
      todo.forEach(function (f) {
        chain = chain.then(function () {
          return getFile(id, f.name, signal, 1).then(function (b) {
            stills[f.shot] = { blob: b, url: URL.createObjectURL(b) };
            emit(onProgress, { stage: 'still', job: id, shot: f.shot, shots: shotsOf(j), pct: 1, overall: (j.progress && +j.progress.overall) || 0, message: '', stillUrl: stills[f.shot].url, shotIndex: f.shot });
          }, function (e) { if (e && e.name === 'AbortError') throw e; /* fetched again with the rest */ });
        });
      });
      return chain.then(function () { stillsBusy = false; }, function (e) { stillsBusy = false; throw e; });
    }
    function loop() {
      if (signal && signal.aborted) return Promise.reject(abortError());
      return api('GET', 'jobs/' + encodeURIComponent(id), undefined, { signal: signal }).then(function (r) {
        fails = 0;
        var j = r.job || r;
        report(j);
        if (j.state === 'done') return finish(j);
        if (j.state === 'downloaded') throw GuestError('gone', 'This video was already saved on another device or tab.');
        if (j.state === 'failed') throw GuestError((j.error && j.error.code) || 'failed', (j.error && j.error.message) || '', { serverJob: j });
        if (j.state === 'cancelled' || j.state === 'declined' || j.state === 'expired') throw GuestError(j.state, (j.error && j.error.message) || '', { serverJob: j });
        return fetchStills(j).then(function () { return nap(document.hidden ? HIDDEN_MS : POLL_MS); }).then(loop);
      }, function (e) {
        if (e && e.name === 'AbortError') throw e;
        // connection trouble, or the host asking to slow down for a moment (429 / 503 with Retry-After): wait it out
        if (e && (e.code === 'network' || e.status >= 500 || e.status === 429)) {
          fails++;
          emit(onProgress, { stage: lastState === 'running' && last.progress ? last.progress.stage : 'queue', job: id, reconnecting: true, shots: shotsOf(last), pct: 0, overall: (last.progress && +last.progress.overall) || 0, message: 'Can’t reach ' + hostName() + '’s PC right now — trying again…' });
          return nap(Math.max((e.retryAfter || 0) * 1000, Math.min(20000, POLL_MS * Math.pow(1.5, Math.min(fails, 8))))).then(loop);
        }
        if (e && (e.code === 'not-found' || e.status === 404)) throw GuestError('gone', 'This video is no longer on ' + hostName() + '’s PC.');
        throw e;
      });
    }
    function finish(j) {
      var shots = (j.plan && j.plan.shots) || [], files = j.files || [], n = shots.length;
      emit(onProgress, { stage: 'download', job: id, shot: null, shots: n, pct: 0, overall: 0.99, message: 'Getting your shots from ' + hostName() + '’s PC…' });
      var out = { clips: [], stills: [] }, chain = Promise.resolve();
      // stills first (the strip), then the clips, then the song (sequential: a phone on a slow line)
      shots.forEach(function (s, k) {
        chain = chain.then(function () {
          if (stills[k]) return;
          var f = fileFor(files, 'still', k);
          if (!f) return;
          return getFile(id, f.name, signal, 3).then(function (b) { stills[k] = { blob: b, url: URL.createObjectURL(b) }; emit(onProgress, { stage: 'still', job: id, shot: k, shots: n, pct: 1, overall: 0.99, message: '', stillUrl: stills[k].url, shotIndex: k }); });
        });
      });
      shots.forEach(function (s, k) {
        chain = chain.then(function () {
          var f = fileFor(files, 'clip', k);
          if (!f) throw GuestError('gone', 'A shot of this video is missing on ' + hostName() + '’s PC.');
          emit(onProgress, { stage: 'download', job: id, shot: k, shots: n, pct: k / n, overall: 0.99, message: 'Getting shot ' + (k + 1) + ' of ' + n + '…' });
          return getFile(id, f.name, signal, 3).then(function (b) { out.clips[k] = { blob: b, file: f }; });
        });
      });
      var song = null;
      chain = chain.then(function () {
        var f = files.filter(function (x) { return x.kind === 'song'; })[0];
        if (!f) return;
        return getFile(id, f.name, signal, 3).then(function (b) { song = { blob: b, file: f }; });
      });
      return chain.then(function () {
        var p = j.plan || {}, own = p.sound === 'own', ai = p.sound === 'ai';
        var offsets = ai || (own && shots.some(function (s) { return s.lip; })) ? {} : null;
        var base = typeof opts.ownStart === 'number' ? opts.ownStart : 0;
        var clips = shots.map(function (s, k) {
          var f = out.clips[k].file, lip = !!s.lip, fast = p.quality === 'fast';
          var c = { id: s.id, video: out.clips[k].blob, width: f.width || (lip || !fast ? 480 : 384), height: f.height || (lip || !fast ? 832 : 672),
            fps: f.fps || (lip ? 16 : 32), seconds: f.seconds || s.seconds, stillUrl: stills[k] ? stills[k].url : null, still: stills[k] ? stills[k].blob : null, lipSync: lip };
          if (offsets && s.offset != null && (ai || lip)) { offsets[s.id] = ai ? s.offset : Math.round((base + s.offset) * 1e6) / 1e6; c.audioOffset = offsets[s.id]; }
          return c;
        });
        var result = {
          clips: clips, seconds: Math.round(shots.reduce(function (a, s) { return a + (s.seconds || 0); }, 0) * 1e6) / 1e6,
          audioSource: ai ? 'song' : own && offsets ? 'user' : null, seed: null, quality: p.quality || 'best', stillModel: p.stillModel || 'qwen',
          job: id, code: j.code, timings: null
        };
        if (song) { result.audio = song.blob; result.songSeconds = p.song ? p.song.seconds : null; }
        if (offsets) result.songOffsets = offsets;
        emit(onProgress, { stage: 'download', job: id, shot: null, shots: n, pct: 1, overall: 1, message: 'Done!' });
        return result;
      });
    }
    return loop().then(function (r) { cleanupAttach(); return r; }, function (e) {
      cleanupAttach();
      if (e && e.name === 'AbortError') onAbort();
      throw e;
    });
    function cleanupAttach() { polling = Math.max(0, polling - 1); document.removeEventListener('visibilitychange', onVis); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  function fileFor(files, kind, k) { return files.filter(function (f) { return f.kind === kind && f.shot === k; })[0] || null; }
  // a labelled file of the job, retried a few times on a flaky connection
  function getFile(id, name, signal, tries) {
    var n = 0;
    function go() {
      n++;
      return fetch(BASE + 'jobs/' + encodeURIComponent(id) + '/files/' + encodeURIComponent(name), { cache: 'no-store', credentials: 'same-origin', signal: signal }).then(function (r) {
        if (r.ok) return r.blob().then(function (b) { if (!b.size) throw GuestError('download', 'empty file'); return b; });
        if (r.status === 409 && n < 20) return wait(1500, signal).then(go);
        // the host's PC is sending other files right now (it limits how many at once): wait and ask again
        if ((r.status === 503 || r.status === 429) && n < 40) return wait(Math.max(1, +(r.headers.get('Retry-After') || 5)) * 1000, signal).then(go);
        if (r.status === 410 || r.status === 404) throw GuestError('gone', 'This video is no longer on ' + hostName() + '’s PC.');
        if (r.status === 401) throw GuestError('no-session', '');
        throw GuestError('download', 'HTTP ' + r.status);
      }, function (e) {
        if (signal && signal.aborted) throw abortError();
        if (n < (tries || 3)) return wait(800 * n, signal).then(go);
        throw GuestError('network', 'Can’t reach ' + hostName() + '’s PC right now.', { detail: String(e && e.message || e) });
      }).catch(function (e) {
        if (e && e.code === 'download' && n < (tries || 3)) return wait(800 * n, signal).then(go);
        throw e;
      });
    }
    return go();
  }

  /* ---------------- files ---------------- */
  function decodeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(blob); }).catch(function () { return decodeWithImg(blob); });
    }
    return decodeWithImg(blob);
  }
  function decodeWithImg(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(GuestError('bad-photo', 'This photo couldn’t be opened. Try a JPEG or PNG photo.')); };
      img.src = url;
    });
  }
  // ALWAYS a fresh JPEG from a canvas (rotation baked in, no EXIF/location data), long side <= 1536 px
  function preparePhoto(blob) {
    if (!blob || !blob.size) return Promise.reject(GuestError('bad-photo', 'No photo.'));
    return decodeImage(blob).then(function (img) {
      var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
      if (!w || !h) throw GuestError('bad-photo', 'This photo couldn’t be opened.');
      var s = Math.min(1, 1536 / Math.max(w, h)), cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      var c = document.createElement('canvas'); c.width = cw; c.height = ch;
      var cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
      try { cx.imageSmoothingQuality = 'high'; } catch (e) { /* ignore */ }
      cx.drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();
      return new Promise(function (resolve, reject) {
        c.toBlob(function (b) { b ? resolve({ blob: b, width: cw, height: ch }) : reject(GuestError('bad-photo', 'This photo couldn’t be prepared.')); }, 'image/jpeg', 0.92);
      });
    });
  }
  // The part of the friend's song a lip-sync shot needs, as a mono 16-bit WAV (8–48 kHz: resampled when higher).
  function wavSegment(ab, start, seconds) {
    var sr0 = ab.sampleRate, sr = sr0 > 48000 ? 48000 : sr0 < 8000 ? 8000 : sr0, ratio = sr0 / sr;
    var n = Math.max(1, Math.round(seconds * sr)), s0 = start * sr0;
    var dv = new DataView(new ArrayBuffer(44 + n * 2));
    function txt(o, t) { for (var k = 0; k < t.length; k++) dv.setUint8(o + k, t.charCodeAt(k)); }
    txt(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); txt(8, 'WAVE'); txt(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); txt(36, 'data'); dv.setUint32(40, n * 2, true);
    var chs = [], c;
    for (c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c));
    for (var i = 0; i < n; i++) {
      var x = ratio === 1 ? Math.round(s0) + i : s0 + i * ratio, j = Math.floor(x), f = x - j, v = 0;
      for (c = 0; c < chs.length; c++) {
        var a = j >= 0 && j < ab.length ? chs[c][j] : 0, b = f && j + 1 >= 0 && j + 1 < ab.length ? chs[c][j + 1] : 0;
        v += f ? a + (b - a) * f : a;
      }
      v /= chs.length || 1;
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return new Blob([dv.buffer], { type: 'audio/wav' });
  }

  /* ---------------- estimates (the host's PC; same table as local-engine.js estimateStory) ---------------- */
  var STORY_MIN = { stillQwen: [1, 1.5], stillKlein: [0.25, 0.45], swap: [0.2, 1], song: [0.5, 1.5], video: [3.7, 6.5], videoFast: [2.2, 4], s2v: [4.5, 7], cold: [0.5, 1.5] };
  function estimateStory(o) {
    o = o || {};
    var shots = o.shots, n, lip = 0, host = (G.session && G.session.host) || {};
    if (Array.isArray(shots)) { n = shots.length; lip = shots.filter(function (s) { return s && s.lipSync; }).length; }
    else n = Math.round(+shots || 4);
    n = Math.max(1, Math.min(4, n || 1));
    if (typeof o.lipSync === 'number') lip = Math.max(0, Math.min(n, Math.round(o.lipSync)));
    else if (o.lipSync === true && !lip) lip = n;
    else if (o.lipSync === false) lip = 0;
    var fast = o.quality === 'fast', hasFast = typeof o.fastPack === 'boolean' ? o.fastPack : !!host.fast, song = !!o.song, lo = 0, hi = 0;
    function add(r, k) { k = k == null ? 1 : k; lo += r[0] * k; hi += r[1] * k; }
    add(STORY_MIN.cold);
    add(fast && hasFast ? STORY_MIN.stillKlein : STORY_MIN.stillQwen, n);
    add(STORY_MIN.swap, (song ? 1 : 0) + (n - lip > 0 ? 1 : 0) + (lip > 0 ? 1 : 0));
    if (song) add(STORY_MIN.song);
    add(fast ? STORY_MIN.videoFast : STORY_MIN.video, n - lip);
    add(STORY_MIN.s2v, lip);
    var laptop = typeof o.laptop === 'boolean' ? o.laptop : !!host.laptop;
    if (laptop) { lo *= 1.2; hi *= 1.4; }
    var a = Math.max(1, Math.round(lo)), b = Math.max(a + 1, Math.ceil(hi));
    return { minutes: [a, b], shots: n, lipSync: lip, laptop: laptop };
  }

  window.GlowGuest = G;
  start();
})();
