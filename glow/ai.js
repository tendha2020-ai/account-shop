/* Glow Studio — AI Scenes (ai.js)
 *
 * One selfie + one preset scene -> a short, realistic AI video of that same person. Two engines:
 *   - "Free on this PC" (only inside the Glow Studio Windows app): window.GlowLocalAI (local-engine.js) runs ComfyUI on
 *     the user's own NVIDIA card (Qwen-Image-Edit still -> Wan 2.2 clip, optional ACE-Step song + lip-sync); see the
 *     "AI engine" section and runLocal(). No key, nothing uploaded.
 *   - "fal.ai cloud" (website and app), made with the user's own fal.ai key:
 *
 *   selfie (downscaled, EXIF stripped) -> fal CDN upload
 *     -> fal-ai/nano-banana-pro/edit          scene still, 9:16, 2K (same person placed in the scene)
 *     -> fal-ai/kling-video/v3/standard/...   silent video (built-in music is added here)      OR
 *        alibaba/happy-horse/v1.1/...         video with native sound (crowd, singing in Spanish, ...)
 *     -> local finishing: frames drawn to a canvas with a small burned-in "AI-generated" label, audio mixed,
 *        recorded with MediaRecorder -> saved to IndexedDB ("My AI videos")
 *
 * Responsible use: preset scenes only (no free-text prompts), a consent checkbox for every new photo, an always-on
 * AI label, fal's moderation is respected (refusals are explained, never worked around). The API key is kept only in
 * this browser (localStorage) and is only ever sent to fal.ai hosts.
 * In-flight jobs are saved in localStorage so a reload resumes polling instead of paying again; connection trouble
 * while collecting a finished result is waited out (the result is never paid for twice), and only one page (Web Locks,
 * with a per-page claim as the fallback) runs a job. Only files with the burned-in label are ever offered for download.
 */
(function () {
  'use strict';
  // The scene texts come from scenes.json (scenes.js loads it); everything below starts once they are here.
  function boot(SD) {
  var GS = window.GlowScenes;

  /* ------------------------------------------------------------------ *
   * Basics
   * ------------------------------------------------------------------ */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); };
  var MU = window.GlowMusic || null;
  var TEST = (window.__GLOW_AI_TEST__ && typeof window.__GLOW_AI_TEST__ === 'object') ? window.__GLOW_AI_TEST__ : {};
  var CFG = {
    pollMs: TEST.pollMs || 3000,               // status poll interval
    slowAfterMs: TEST.slowAfterMs || 15 * 60 * 1000, // after this, say "still working" and poll a little slower
    slowPollMs: TEST.slowPollMs || 8000,
    backoffMs: TEST.backoffMs || 2000,         // first retry delay for 429 / 5xx / network
    maxBackoffMs: TEST.maxBackoffMs || 20000,
    // Reading a finished result is free and safe to repeat, so connection trouble there is retried this long
    // (fal keeps results much longer) before we pause and ask the user to try again.
    resultRetryMs: TEST.resultRetryMs || 60 * 60 * 1000,
    staleBeatMs: TEST.staleBeatMs || 12000     // a running page refreshes its claim on the job every few seconds
  };
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // One id per page instance (new on every load). It marks which page is running a job. A per-tab id kept in
  // sessionStorage would not do: "Duplicate tab" and window.open copy sessionStorage, so two live pages would share it.
  var INST = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // Web Locks (where supported) make sure only one Glow Studio page runs a job, even when a background tab is throttled.
  var LOCKS = !!(navigator.locks && typeof navigator.locks.request === 'function');

  var LS = { key: 'glow.ai.falKey', job: 'glow.ai.job', prefs: 'glow.ai.prefs', prices: 'glow.ai.prices.v2', mode: 'glow.mode', engine: 'glow.ai.engine', localJob: 'glow.ai.localjob' };
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function lsJSON(k) { var s = lsGet(k); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }

  function fmt(sec) { sec = Math.max(0, Math.round(sec || 0)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function money(v) { return '$' + (Math.round(v * 100) / 100).toFixed(2); }

  /* ------------------------------------------------------------------ *
   * fal.ai models & pricing (from fal's model pages; only the photo price is refreshed from the pricing API)
   * ------------------------------------------------------------------ */
  var EP = {
    still: 'fal-ai/nano-banana-pro/edit',                     // Gemini 3 Pro Image: keeps the person's identity
    stillAlt: 'google/nano-banana-2.1/edit',                  // fallback only if the primary fails on fal's side
    std: 'fal-ai/kling-video/v3/standard/image-to-video',     // silent, realistic human motion
    ai: 'alibaba/happy-horse/v1.1/image-to-video'             // native audio, multilingual lip-sync
  };
  var MODEL_NAME = {};
  MODEL_NAME[EP.still] = 'Nano Banana Pro';
  MODEL_NAME[EP.stillAlt] = 'Nano Banana 2.1';
  MODEL_NAME[EP.std] = 'Kling 3.0';
  MODEL_NAME[EP.ai] = 'Happy Horse 1.1';
  // USD. still: per image (2K costs the same as 1K); std: per second with audio off; ai: per second at 720p.
  var PRICE = { still: 0.15, stillAlt: 0.063, std: 0.084, ai: 0.14 };
  var LENGTHS = [5, 10];        // fal.ai cloud, one scene = one clip (Kling 3.0 / Happy Horse make 5 or 10 s)
  var ALL_LENGTHS = [5, 10, 20]; // stories (and every scene on this PC): 1, 2 or 4 shots of about 5 s

  var QUEUE = 'https://queue.fal.run/';
  var UPLOAD_INIT = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
  var PRICING_URL = 'https://api.fal.ai/v1/models/pricing?endpoint_id=' + [EP.still, EP.std, EP.ai].join(',');
  var LIFECYCLE = JSON.stringify({ expiration_duration_seconds: 86400 }); // files on fal's CDN expire after a day
  var BILLING_URL = 'https://fal.ai/dashboard/billing';
  var KEYS_URL = 'https://fal.ai/dashboard/keys';

  // The key may only ever travel to fal.ai's own hosts.
  function isFalHost(u) {
    try {
      var url = new URL(u);
      if (url.protocol !== 'https:') return false;
      var h = url.hostname;
      return h === 'fal.ai' || /\.fal\.ai$/.test(h) || h === 'fal.run' || /\.fal\.run$/.test(h) || /(^|\.)falrun\.com$/.test(h);
    } catch (e) { return false; }
  }

  // fal's pricing API gives each model's *base* unit price, with no idea of the tier we ask for (Kling with audio off
  // costs 0.6x its base; Happy Horse defaults to 1080p). So the per-second video prices always come from the model
  // pages above, and only the per-image price of the scene photo (same at 1K and 2K) is refreshed.
  lsDel('glow.ai.prices'); // old cache that could hold the base video prices
  (function loadPrices() {
    var p = lsJSON(LS.prices);
    if (p && p.at && Date.now() - p.at < 14 * 864e5) applyPrices(p.prices, true);
  })();
  function applyPrices(list, fromCache) {
    if (!Array.isArray(list)) return;
    var changed = false;
    list.forEach(function (p) {
      if (!p || p.endpoint_id !== EP.still || typeof p.unit_price !== 'number') return;
      if (!(p.unit_price >= 0.02 && p.unit_price <= 1) || !/image/.test(String(p.unit || '').toLowerCase())) return;
      PRICE.still = p.unit_price; changed = true;
    });
    if (changed && !fromCache) lsSet(LS.prices, JSON.stringify({ at: Date.now(), prices: list.filter(function (p) { return p && p.endpoint_id === EP.still; }) }));
  }
  function estimate(sound, dur) { return PRICE.still + (sound === 'ai' ? PRICE.ai : PRICE.std) * dur; }

  /* ------------------------------------------------------------------ *
   * Scenes (preset prompts only — there is deliberately no free-text prompt)
   * ------------------------------------------------------------------ */
  // All preset texts live in scenes.json (cloud: the fal.ai photo/video rules; local: this PC's wording), in display order.
  var STILL_RULES = SD.cloud.stillRules;
  var MOTION_RULES = SD.cloud.motionRules;
  var NEGATIVE = SD.cloud.negative;
  var SCENES = SD.scenes;
  var DEFAULT_SCENE = SD.defaultScene;
  function sceneById(id) {
    for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i];
    for (var j = 0; j < SCENES.length; j++) if (SCENES[j].id === DEFAULT_SCENE) return SCENES[j];
    return SCENES[0];
  }

  function stillPrompt(sc) { return sc.stillPrompt + STILL_RULES; }
  // tier: 'std' (silent Kling) or 'ai' (Happy Horse with native sound). Spoken/sung lines go in double quotes with
  // timecodes, which is how Happy Horse 1.1 voices and lip-syncs them.
  function motionPrompt(sc, tier, dur, hint) {
    var p = tier === 'ai' ? sc.motion : (sc.motionStd || sc.motion) + (hint || '');
    if (tier === 'ai') {
      if (sc.lyrics) {
        var lines = sc.lyrics.filter(function (l) { return l.to <= dur; });
        if (lines.length) p += ' ' + lines.map(function (l) { return l.from + '-' + l.to + 's: ' + l.who + ': "' + l.line + '"'; }).join(' ');
        if (sc.tail) p += ' ' + sc.tail;
      }
      p += MOTION_RULES + ' ' + sc.soundPrompt;
    } else {
      p += MOTION_RULES;
    }
    return p;
  }
  function stillInput(sc, imageUrl) {
    return { prompt: stillPrompt(sc), image_urls: [imageUrl], aspect_ratio: '9:16', resolution: '2K', output_format: 'jpeg', num_images: 1 };
  }
  function videoInput(sc, tier, dur, stillUrl, hint) {
    if (tier === 'ai') {
      return { image_url: stillUrl, prompt: motionPrompt(sc, 'ai', dur), duration: dur, resolution: '720p', enable_safety_checker: true };
    }
    return { start_image_url: stillUrl, prompt: motionPrompt(sc, 'std', dur, hint), duration: String(dur), generate_audio: false, negative_prompt: NEGATIVE, enable_safety_checker: true };
  }

  /* Free AI on this PC (window.GlowLocalAI, local-engine.js). The local models need their own wording:
   *  - Qwen-Image-Edit-2511 refers to the selfie as "Picture 1" (FLUX.2 klein, the Fast photo model, as "image 1") and
   *    keeps a face best when it is told plainly what to keep and when the face is large: knees-up framing.
   *  - Wan 2.2 follows a short motion + camera sentence better than a long paragraph; the negative prompt is added to
   *    the official Chinese Wan negative by the engine. */
  var LOCAL_NEGATIVE = SD.local.negative;
  var SONG_SECONDS = 20, SONG_OFFSET = 5; // a 20 s song; the 5 s lip-sync chunk starts 5 s in (the chorus)
  // the photo prompt: who (Picture 1 / image 1) + the scene + the rules, with the framing of the shot
  function localStillText(model, text, framing) { return GS.stillText(model, text, framing); }
  function localStillPrompt(sc, model) { return localStillText(model, sc.local.still); }
  // The request for GlowLocalAI.generate() (without photo and signal). sound 'ai' locally = the Singing add-on's song.
  // shot: one shot of a story scene (a 5 s story video made the single-clip way); hint: the tempo line ("Dance to the beat").
  function localRequest(sc, sound, quality, fastPack, shot, hint) {
    var loc = shot ? shot.local : sc.local;
    var r = {
      stillPrompt: localStillText(quality === 'fast' && fastPack ? 'klein' : 'qwen', loc.still, loc.framing),
      motionPrompt: loc.motion + (hint || ''), negativePrompt: LOCAL_NEGATIVE, quality: quality === 'fast' ? 'fast' : 'best', singing: null
    };
    if (sound === 'ai' && sc.song) r.singing = { lyrics: sc.song.lyrics, style: sc.song.style, language: SD.local.songLanguage, seconds: SONG_SECONDS, offset: SONG_OFFSET, prompt: loc.sing };
    return r;
  }

  /* ------------------------------------------------------------------ *
   * Stories: 1–4 shots of about 5 s, each made from the same selfie, cut together on the beat under one soundtrack
   * ------------------------------------------------------------------ */
  var SHOT_SEC = 5;
  var LIP_SEC = 77 / 16;   // Wan2.2-S2V on this PC: one verified 77-frame chunk at 16 fps per lip-synced shot (4.8 s)
  // A scene that is not a story gets the same scene in a few framings when it is longer than one shot.
  var VARIANTS = SD.variants;
  function shotCount(dur) { return dur >= 20 ? 4 : dur >= 10 ? 2 : 1; }
  function shotById(sc, id) { for (var i = 0; i < sc.shots.length; i++) if (sc.shots[i].id === id) return sc.shots[i]; return sc.shots[0]; }
  function variantShot(sc, v, i) {
    var lyr = sc.lyrics && sc.lyrics.length ? sc.lyrics[i % sc.lyrics.length] : null;
    return {
      id: v.id, title: v.title, still: sc.stillPrompt + v.still, motion: sc.motion + v.motion, motionStd: (sc.motionStd || sc.motion) + v.motion,
      lyric: lyr ? { who: lyr.who, line: lyr.line } : null, lipSync: !!sc.song,
      local: GS.variantLocal(sc, v)
    };
  }
  // The shots of a video of this length (story scenes: their own shots; others: the scene in different framings).
  function shotsFor(sc, dur) {
    var n = shotCount(dur);
    if (sc.story) {
      var ids = (sc.pick && sc.pick[n * SHOT_SEC]) || sc.shots.slice(0, n).map(function (s) { return s.id; });
      return ids.map(function (id) { return shotById(sc, id); });
    }
    return VARIANTS.slice(0, n).map(function (v, i) { return variantShot(sc, v, i); });
  }
  // The shot a story scene shows when it is made as one 5 s clip
  function keyShot(sc) { return sc.story ? shotsFor(sc, 5)[0] : null; }
  // "Dance to the beat": one line about the tempo for the motion prompts.
  function beatHint(t) {
    if (!t || !(t.bpm > 0)) return '';
    return GS.tempoHint(GS.tempoFeel(t.bpm, t.energy), Math.round(t.bpm));
  }
  // fal: the scene photo and the clip of one shot (cloud)
  function shotStillInput(shot, imageUrl) {
    return { prompt: shot.still + STILL_RULES, image_urls: [imageUrl], aspect_ratio: '9:16', resolution: '2K', output_format: 'jpeg', num_images: 1 };
  }
  function shotVideoInput(sc, shot, tier, stillUrl, hint) {
    if (tier === 'ai') {
      var p = shot.motion;
      if (shot.lyric) p += ' 0-5s: ' + shot.lyric.who + ': "' + shot.lyric.line + '" Lips matched to the words, natural happy expressions.';
      return { image_url: stillUrl, prompt: p + MOTION_RULES + ' ' + sc.soundPrompt, duration: SHOT_SEC, resolution: '720p', enable_safety_checker: true };
    }
    return { start_image_url: stillUrl, prompt: (shot.motionStd || shot.motion) + (hint || '') + MOTION_RULES, duration: String(SHOT_SEC), generate_audio: false, negative_prompt: NEGATIVE, enable_safety_checker: true };
  }

  /* ------------------------------------------------------------------ *
   * State & elements
   * ------------------------------------------------------------------ */
  var tracks = (MU && Array.isArray(MU.tracks)) ? MU.tracks.filter(function (t) { return t && t.id; }) : [];
  function trackById(id) { for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i]; return null; }

  var prefs = lsJSON(LS.prefs) || {};
  var S = {
    sceneId: sceneById(prefs.sceneId).id,
    sound: prefs.sound === 'ai' || prefs.sound === 'own' ? prefs.sound : 'music', // 'music' (built-in), 'ai' (AI sound / AI song) or 'own' (my song)
    userSound: prefs.userSound || null,     // the sound mode the user picked themselves (kept across scenes)
    userLen: ALL_LENGTHS.indexOf(prefs.userLen) >= 0 ? prefs.userLen : null, // likewise the length
    sync: prefs.sync === 'lips' ? 'lips' : 'beat', // "Sync to the song": dance to the beat, or lip-sync every shot (this PC)
    own: null,                               // my song: { id, name, size, blob, buffer, duration, start, beat, peaks } (see "My song")
    trackId: '', duration: 5,
    retryJob: null,                          // { resume: job } (paid request to pick up again) or a "reuse the scene photo" stub
    photo: null,                             // { blob, url, thumb (data URL), small (data URL), w, h, seq, uploaded: {url, at} }
    consent: false,
    memKey: '',                              // used only if localStorage is blocked
    engine: 'fal',                           // 'local' (free, on this PC) or 'fal' (cloud); see decideEngine()
    quality: prefs.quality === 'fast' ? 'fast' : 'best' // free AI on this PC: Best or Fast
  };
  var el = {
    tabs: Array.prototype.slice.call(document.querySelectorAll('.mode-tab')),
    top: $('.top'), modes: $('.modes'), ai: $('#ai'), app: $('#app'),
    keyChip: $('#aiKeyChip'), keyChipT: $('#aiKeyChipT'), footKey: $('#aiFootKey'),
    photoCard: $('#aiPhotoCard'), drop: $('#aiDrop'), pick: $('#aiPick'), selfie: $('#aiSelfie'), selfieImg: $('#aiSelfieImg'),
    change: $('#aiChange'), file: $('#aiFile'), consentRow: $('#aiConsentRow'), consent: $('#aiConsent'), photoStatus: $('#aiPhotoStatus'),
    target: $('#aiTargetArt'), targetName: $('#aiTargetName'),
    make: $('#aiMake'), makeT: $('#aiMakeT'), cost: $('#aiCost'), stage: $('.ai-stage'), myVids: $('#aiMyVids'), myVidsN: $('#aiMyVidsN'),
    tips: $('#aiTips'), connT: $('#aiConnT'), announce: $('#aiAnnounce'),
    sceneCard: $('#aiSceneCard'), scenes: $('#aiScenes'),
    sound: $('#aiSound'), soundHint: $('#aiSoundHint'), soundLock: $('#aiSoundLock'), music: $('#aiMusic'), tracks: $('#aiTracks'),
    aiNote: $('#aiAiNote'), len: $('#aiLen'), tier: $('#aiTier'),
    hist: $('#aiHist'), histEmpty: $('#aiHistEmpty'), histCount: $('#aiHistCount'), histCard: $('#aiHistCard'),
    conn: $('#aiConnect'), connClose: $('#aiConnClose'), connRange: $('#aiConnRange'), key: $('#aiKey'), keyEye: $('#aiKeyEye'),
    keyMsg: $('#aiKeyMsg'), keySave: $('#aiKeySave'), keyRemove: $('#aiKeyRemove'),
    prog: $('#aiProgress'), progTt: $('#aiProgTt'), min: $('#aiMin'), pv: $('#aiPv'), pvSelfie: $('#aiPvSelfie'), pvStill: $('#aiPvStill'),
    pvCanvas: $('#aiPvCanvas'), pct: $('#aiPct'), ringBar: $('#aiRingBar'), mon: $('#aiMon'), steps: $('#aiSteps'),
    subStill: $('#aiSubStill'), subVideo: $('#aiSubVideo'), subFinish: $('#aiSubFinish'), finishName: $('#aiFinishName'),
    msg: $('#aiProgMsg'), elapsed: $('#aiElapsed'), eta: $('#aiEta'), shareNote: $('#aiShareNote'), shareAsk: $('#aiShareAsk'), shareAskT: $('#aiShareAskT'), shareAskB: $('#aiShareAskB'),
    err: $('#aiErr'), errT: $('#aiErrT'), errP: $('#aiErrP'), errActions: $('#aiErrActions'),
    tapFinish: $('#aiTapFinish'), cancel: $('#aiCancel'), keepOpen: $('#aiKeepOpen'),
    res: $('#aiResult'), resTt: $('#aiResTt'), resClose: $('#aiResClose'), resVideo: $('#aiResVideo'), labelOv: $('#aiLabelOv'),
    resMeta: $('#aiResMeta'), resNote: $('#aiResNote'), dl: $('#aiDownload'), share: $('#aiShare'), again: $('#aiAgain'), againT: $('#aiAgainT'),
    other: $('#aiOther'), del: $('#aiDelete'), pill: $('#aiPill'), pillT: $('#aiPillT'), toasts: $('#toasts'),
    engCard: $('#aiEngineCard'), engSeg: $('#aiEngSeg'), engSt: $('#aiEngSt'), engNote: $('#aiEngNote'), engLocalS: $('#aiEngLocalS'), engWeb: $('#aiEngWeb'), engCmp: $('#aiEngCmp'),
    engResume: $('#aiEngResume'), engResT: $('#aiEngResT'), engResS: $('#aiEngResS'), engContinue: $('#aiEngContinue'), engDiscard: $('#aiEngDiscard'),
    lenGroup: $('#aiLenGroup'), qualGroup: $('#aiQualGroup'), qual: $('#aiQual'), qualBest: $('#aiQualBest'), qualFast: $('#aiQualFast'), qualNote: $('#aiQualNote'),
    footNote: $('#aiFootNote'), errDet: $('#aiErrDet'), errDetP: $('#aiErrDetP'), videoName: $('#aiVideoName'), stillName: $('#aiStillName'),
    soundCard: $('#aiSoundCard'), sceneHint: $('#aiSceneHint'), shots: $('#aiShots'),
    own: $('#aiOwn'), ownEmpty: $('#aiOwnEmpty'), ownBox: $('#aiOwnBox'), ownName: $('#aiOwnName'), ownMeta: $('#aiOwnMeta'), ownChange: $('#aiOwnChange'),
    ownRemove: $('#aiOwnRemove'), wave: $('#aiWave'), waveCv: $('#aiWaveCv'), ownPlay: $('#aiOwnPlay'), ownStart: $('#aiOwnStart'), ownShort: $('#aiOwnShort'),
    ownSt: $('#aiOwnSt'), ownFile: $('#aiOwnFile'),
    syncGroup: $('#aiSyncGroup'), syncSeg: $('#aiSync'), syncNote: $('#aiSyncNote'), syncL: $('#aiSyncL'),
    pvSheet: $('#aiPreview'), pvsT: $('#aiPvsT'), pvsClose: $('#aiPvsClose'), pvsCanvas: $('#aiPvsCanvas'), pvsVideo: $('#aiPvsVideo'), pvsChip: $('#aiPvsChip'),
    pvsMute: $('#aiPvsMute'), pvsCap: $('#aiPvsCap'), pvsLine: $('#aiPvsLine'), pvsInfo: $('#aiPvsInfo'), pvsShots: $('#aiPvsShots'), pvsNote: $('#aiPvsNote'),
    pvsUse: $('#aiPvsUse'), pvsBack: $('#aiPvsBack'),
    see: $('#aiSee'), seeList: $('#aiSeeList'), seeTime: $('#aiSeeTime'), seeGo: $('#aiSeeGo'), seeStop: $('#aiSeeStop'), seeClear: $('#aiSeeClear'), seeSt: $('#aiSeeSt'),
    seeTop: $('#aiSeeTop'), seeTopT: $('#aiSeeTopT'), seeTopGo: $('#aiSeeTopGo'), seeTopMore: $('#aiSeeTopMore'),
    seeKept: $('#aiSeeKept'), seeKeptT: $('#aiSeeKeptT'), seeRemove: $('#aiSeeRemove'), pvsDel: $('#aiPvsDel')
  };
  if (!el.ai) return; // page without the AI section

  /* ------------------------------------------------------------------ *
   * Toasts
   * ------------------------------------------------------------------ */
  var lastToast = { msg: '', at: 0 };
  function toast(msg, kind, ms) {
    if (!el.toasts) return;
    var now = Date.now();
    if (msg === lastToast.msg && now - lastToast.at < 1500) return;
    lastToast = { msg: msg, at: now };
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || 'info');
    t.textContent = msg;
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 3) el.toasts.removeChild(el.toasts.firstChild);
    requestAnimationFrame(function () { requestAnimationFrame(function () { t.classList.add('in'); }); });
    setTimeout(function () { t.classList.remove('in'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400); }, ms || 3600);
  }
  function attention(node) {
    if (!node) return;
    node.classList.remove('attention'); void node.offsetWidth; node.classList.add('attention');
    try { node.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Mode switch (AI Scenes | Photo Video)
   * ------------------------------------------------------------------ */
  function mode() { return document.body.getAttribute('data-mode') === 'photo' ? 'photo' : 'ai'; }
  function setMode(m, opts) {
    m = m === 'photo' ? 'photo' : 'ai';
    var changed = m !== mode();
    document.body.setAttribute('data-mode', m);
    el.tabs.forEach(function (t) {
      var on = t.getAttribute('data-mode') === m;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    lsSet(LS.mode, m);
    if (location.hash === '#ai' || location.hash === '#photo') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } }
    if (m !== 'ai') { stopTrackPreview(); stopOwnPreview(); }
    if (changed) {
      document.dispatchEvent(new CustomEvent('glow:mode', { detail: { mode: m } }));
      if (opts && opts.user && window.scrollY > 120) { try { window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' }); } catch (e) { window.scrollTo(0, 0); } }
    }
  }
  el.tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { setMode(t.getAttribute('data-mode'), { user: true }); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      var j = e.key === 'Home' ? 0 : e.key === 'End' ? el.tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + el.tabs.length) % el.tabs.length;
      el.tabs[j].focus();
      setMode(el.tabs[j].getAttribute('data-mode'), { user: true });
    });
  });
  window.addEventListener('hashchange', function () { if (location.hash === '#photo' || location.hash === '#ai') setMode(location.hash.slice(1)); });

  /* ------------------------------------------------------------------ *
   * Audio (own context: previews + finishing)
   * ------------------------------------------------------------------ */
  var actx = null, master = null;
  function ensureAudio() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { actx = new AC(); } catch (e) { return null; }
      master = actx.createGain(); master.gain.value = 0.85; master.connect(actx.destination);
    }
    if (actx.state !== 'running' && actx.state !== 'closed' && actx.resume) { try { actx.resume().catch(function () {}); } catch (e) { /* ignore */ } }
    return actx;
  }
  var musicCache = new Map();
  function getMusic(id, dur) {
    var key = id + '|' + dur.toFixed(2);
    if (!musicCache.has(key)) {
      var p = Promise.resolve().then(function () {
        if (!MU || typeof MU.render !== 'function') throw new Error('Music engine unavailable');
        return MU.render(id, dur);
      });
      p.catch(function () { musicCache.delete(key); });
      musicCache.set(key, p);
      if (musicCache.size > 10) musicCache.delete(musicCache.keys().next().value);
    }
    return musicCache.get(key);
  }

  /* ------------------------------------------------------------------ *
   * Scene art — procedural posters (no external images)
   * ------------------------------------------------------------------ */
  function hexA(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    var n = parseInt(h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function seedOf(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  var TAU = Math.PI * 2;

  function vgrad(p, stops) {
    var g = p.x.createLinearGradient(0, 0, 0, p.H);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    p.x.fillStyle = g; p.x.fillRect(0, 0, p.W, p.H);
  }
  function glow(p, cx, cy, r, col, a) {
    if (!(r > 0)) return;
    var x = p.x, g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, hexA(col, a)); g.addColorStop(0.45, hexA(col, a * 0.4)); g.addColorStop(1, hexA(col, 0));
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
  }
  function lighter(p, fn) { p.x.save(); p.x.globalCompositeOperation = 'lighter'; fn(); p.x.restore(); }
  function bokeh(p, n, cols, r0, r1, y0, y1, a, x0, x1) {
    lighter(p, function () {
      for (var i = 0; i < n; i++) {
        var cx = ((x0 == null ? 0 : x0) + p.R() * ((x1 == null ? 1 : x1) - (x0 == null ? 0 : x0))) * p.W;
        var cy = (y0 + p.R() * (y1 - y0)) * p.H, r = (r0 + p.R() * (r1 - r0)) * p.W;
        glow(p, cx, cy, r, cols[i % cols.length], a * (0.45 + p.R() * 0.55));
      }
    });
  }
  function sparks(p, n, cols, y0, y1, size, x0, x1) {
    lighter(p, function () {
      for (var i = 0; i < n; i++) {
        var cx = ((x0 == null ? 0 : x0) + p.R() * ((x1 == null ? 1 : x1) - (x0 == null ? 0 : x0))) * p.W, cy = (y0 + p.R() * (y1 - y0)) * p.H;
        var s = p.W * size * (0.5 + p.R());
        glow(p, cx, cy, s * 3.2, cols[i % cols.length], 0.4);
        glow(p, cx, cy, s, '#ffffff', 0.95);
      }
    });
  }
  function bulbs(p, x0, y0, x1, y1, sag, n, col) {
    var x = p.x, mx = (x0 + x1) / 2, my = (y0 + y1) / 2 + sag;
    x.save(); x.strokeStyle = 'rgba(10,6,16,.55)'; x.lineWidth = Math.max(1, p.W * 0.004);
    x.beginPath(); x.moveTo(x0, y0); x.quadraticCurveTo(mx, my, x1, y1); x.stroke(); x.restore();
    lighter(p, function () {
      for (var k = 0; k <= n; k++) {
        var t = k / n, it = 1 - t;
        var bx = it * it * x0 + 2 * it * t * mx + t * t * x1, by = it * it * y0 + 2 * it * t * my + t * t * y1;
        glow(p, bx, by + p.W * 0.006, p.W * 0.034, col, 0.42);
        glow(p, bx, by + p.W * 0.006, p.W * 0.009, '#fffaf0', 1);
      }
    });
  }
  // Pose = [left arm, right arm]; each [elbow dx, elbow dy, hand dx, hand dy] from the shoulder, in figure heights.
  var POSES = {
    up: [[-0.13, -0.15, -0.12, -0.33], [0.13, -0.15, 0.12, -0.33]],
    cheer: [[-0.16, -0.12, -0.26, -0.27], [0.16, -0.12, 0.26, -0.27]],
    dance: [[-0.17, -0.1, -0.09, -0.3], [0.15, 0.11, 0.03, 0.19]],
    wave: [[-0.05, 0.16, -0.08, 0.31], [0.17, -0.08, 0.2, -0.3]],
    down: [[-0.06, 0.16, -0.08, 0.31], [0.06, 0.16, 0.08, 0.31]],
    mic: [[-0.17, -0.02, -0.29, -0.13], [0.09, 0.12, -0.07, -0.07]],
    pose: [[-0.1, 0.14, -0.02, 0.22], [0.15, 0.06, 0.27, -0.12]],
    clap: [[-0.11, 0.1, -0.01, -0.03], [0.11, 0.1, 0.01, -0.03]],
    sway: [[-0.15, 0.06, -0.28, -0.08], [0.15, 0.06, 0.28, -0.08]]
  };
  function person(p, cx, by, h, o) {
    var x = p.x;
    o = o || {};
    var lean = (o.lean || 0) * h, headR = h * 0.07, headY = by - h * 0.885, shY = by - h * 0.765, hipY = by - h * 0.45;
    var shW = h * 0.115, hipW = h * 0.085, ux = cx + lean, st = (o.step || 0) * h;
    x.save();
    x.fillStyle = o.fill; x.strokeStyle = o.fill; x.lineCap = 'round'; x.lineJoin = 'round';
    if (o.glow) { x.shadowColor = o.glow; x.shadowBlur = h * (o.glowR || 0.06); }
    x.lineWidth = h * 0.078;
    x.beginPath(); x.moveTo(cx - hipW * 0.45, hipY); x.lineTo(cx - hipW * 0.8 - st, by); x.stroke();
    x.beginPath(); x.moveTo(cx + hipW * 0.45, hipY); x.lineTo(cx + hipW * 0.7 + st * 0.4, by); x.stroke();
    x.beginPath();
    x.moveTo(ux - shW, shY + h * 0.02);
    x.quadraticCurveTo(ux, shY - h * 0.03, ux + shW, shY + h * 0.02);
    x.quadraticCurveTo(ux + shW * 0.9, (shY + hipY) / 2, cx + hipW, hipY + h * 0.012);
    x.quadraticCurveTo(cx, hipY + h * 0.05, cx - hipW, hipY + h * 0.012);
    x.quadraticCurveTo(ux - shW * 0.9, (shY + hipY) / 2, ux - shW, shY + h * 0.02);
    x.fill();
    x.lineWidth = h * 0.05;
    x.beginPath(); x.moveTo(ux, shY + h * 0.01); x.lineTo(ux + lean * 0.15, headY + headR * 0.6); x.stroke();
    var hx = ux + lean * 0.2;
    x.beginPath(); x.ellipse(hx, headY, headR * 0.92, headR * 1.05, 0, 0, TAU); x.fill();
    if (o.hair) { x.beginPath(); x.ellipse(hx + o.hair * headR * 0.25, headY + headR * 0.35, headR * 1.08, headR * 1.35, o.hair * 0.15, Math.PI * 0.95, Math.PI * 2.05); x.fill(); }
    var pose = POSES[o.pose] || POSES.down;
    x.lineWidth = h * 0.05;
    [[-1, pose[0]], [1, pose[1]]].forEach(function (a) {
      var sx = ux + a[0] * shW * 0.86, sy = shY + h * 0.035, q = a[1];
      x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + q[0] * h, sy + q[1] * h); x.lineTo(sx + q[2] * h, sy + q[3] * h); x.stroke();
      x.beginPath(); x.arc(sx + q[2] * h, sy + q[3] * h, h * 0.028, 0, TAU); x.fill();
    });
    x.restore();
    return { hx: hx, hy: headY, hr: headR, handR: [ux + shW * 0.86 + pose[1][2] * h, shY + h * 0.035 + pose[1][3] * h] };
  }
  function crowd(p, n, y, h0, h1, fill, glowCol, poses, opts) {
    opts = opts || {};
    var skip = opts.skip || 0, spread = opts.spread || 1.1;
    for (var i = 0; i < n; i++) {
      var f = (i + 0.5 + (p.R() - 0.5) * 0.7) / n;
      if (skip && Math.abs(f - 0.5) < skip) f = f < 0.5 ? 0.5 - skip - p.R() * 0.06 : 0.5 + skip + p.R() * 0.06;
      var cx = (f * spread - (spread - 1) / 2) * p.W;
      var h = (h0 + p.R() * (h1 - h0)) * p.H;
      person(p, cx, (y + p.R() * 0.035) * p.H, h, {
        fill: fill, glow: glowCol, glowR: 0.045, pose: poses[Math.floor(p.R() * poses.length)],
        lean: (p.R() - 0.5) * 0.08, step: (p.R() - 0.5) * 0.06, hair: p.R() < 0.45 ? (p.R() < 0.5 ? -1 : 1) : 0
      });
    }
  }
  function hero(p, cx, by, h, pose, cols, glowCol) {
    glow(p, cx, by - h * 0.55, h * 0.62, glowCol, 0.32);
    var g = p.x.createLinearGradient(0, by - h, 0, by);
    g.addColorStop(0, cols[0]); g.addColorStop(0.5, cols[1]); g.addColorStop(1, cols[2]);
    var r = person(p, cx, by, h, { fill: g, glow: glowCol, glowR: 0.1, pose: pose, lean: 0.025, step: 0.035, hair: 1 });
    // sparkle by the head: "this one is you"
    var sx = r.hx + r.hr * 2.1, sy = r.hy - r.hr * 1.6, s = r.hr * 0.75;
    lighter(p, function () { glow(p, sx, sy, s * 3, '#ffffff', 0.35); });
    star(p, sx, sy, s, '#ffffff');
    return r;
  }
  function star(p, cx, cy, s, col) {
    var x = p.x;
    x.save(); x.fillStyle = col; x.beginPath();
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4 - Math.PI / 2, r = i % 2 ? s * 0.28 : s;
      x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    x.closePath(); x.fill(); x.restore();
  }
  function confetti(p, n, cols, y0, y1) {
    var x = p.x;
    for (var i = 0; i < n; i++) {
      x.save();
      x.translate(p.R() * p.W, (y0 + p.R() * (y1 - y0)) * p.H);
      x.rotate(p.R() * TAU);
      x.fillStyle = cols[i % cols.length]; x.globalAlpha = 0.65 + p.R() * 0.35;
      var s = p.W * (0.007 + p.R() * 0.011);
      x.fillRect(-s, -s * 0.42, s * 2, s * 0.84);
      x.restore();
    }
  }
  function lasers(p, ox, oy, n, cols, spread, len) {
    var x = p.x;
    lighter(p, function () {
      x.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var a = (90 + (i / (n - 1) - 0.5) * spread) * Math.PI / 180;
        var ex = ox + Math.cos(a) * len, ey = oy + Math.sin(a) * len, c = cols[i % cols.length];
        x.strokeStyle = hexA(c, 0.14); x.lineWidth = p.W * 0.03; x.beginPath(); x.moveTo(ox, oy); x.lineTo(ex, ey); x.stroke();
        x.strokeStyle = hexA(c, 0.85); x.lineWidth = Math.max(1, p.W * 0.0045); x.beginPath(); x.moveTo(ox, oy); x.lineTo(ex, ey); x.stroke();
      }
    });
  }
  function beam(p, tx, ty, bx, by, w0, w1, col, a) {
    var x = p.x;
    lighter(p, function () {
      var g = x.createLinearGradient(tx, ty, bx, by);
      g.addColorStop(0, hexA(col, a)); g.addColorStop(1, hexA(col, 0));
      x.fillStyle = g; x.beginPath();
      x.moveTo(tx - w0 / 2, ty); x.lineTo(tx + w0 / 2, ty); x.lineTo(bx + w1 / 2, by); x.lineTo(bx - w1 / 2, by);
      x.closePath(); x.fill();
    });
  }
  function balloon(p, cx, cy, r, col) {
    var x = p.x;
    x.save();
    x.strokeStyle = 'rgba(255,255,255,.3)'; x.lineWidth = Math.max(1, p.W * 0.003);
    x.beginPath(); x.moveTo(cx, cy + r * 1.1); x.quadraticCurveTo(cx - r * 0.5, cy + r * 2, cx + r * 0.15, cy + r * 3.2); x.stroke();
    var g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.45, r * 0.05, cx, cy, r * 1.15);
    g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(0.22, col); g.addColorStop(1, hexA(col, 0.55));
    x.fillStyle = g; x.beginPath(); x.ellipse(cx, cy, r * 0.9, r * 1.08, 0, 0, TAU); x.fill();
    x.beginPath(); x.moveTo(cx - r * 0.12, cy + r * 1.16); x.lineTo(cx + r * 0.12, cy + r * 1.16); x.lineTo(cx, cy + r * 1.02); x.fill();
    x.restore();
  }
  function note(p, cx, cy, s, col) {
    var x = p.x;
    x.save(); x.fillStyle = col; x.strokeStyle = col; x.lineWidth = s * 0.13; x.lineCap = 'round';
    x.shadowColor = col; x.shadowBlur = s * 0.6;
    x.beginPath(); x.ellipse(cx, cy, s * 0.3, s * 0.22, -0.45, 0, TAU); x.fill();
    x.beginPath(); x.moveTo(cx + s * 0.26, cy - s * 0.05); x.lineTo(cx + s * 0.26, cy - s * 0.95);
    x.quadraticCurveTo(cx + s * 0.55, cy - s * 0.78, cx + s * 0.62, cy - s * 0.5); x.stroke();
    x.restore();
  }
  function flash(p, cx, cy, r) {
    var x = p.x;
    lighter(p, function () {
      glow(p, cx, cy, r * 2.4, '#cfe3ff', 0.35);
      glow(p, cx, cy, r, '#ffffff', 0.95);
      x.strokeStyle = 'rgba(255,255,255,.75)'; x.lineWidth = Math.max(1, p.W * 0.003);
      x.beginPath(); x.moveTo(cx - r * 2.6, cy); x.lineTo(cx + r * 2.6, cy); x.moveTo(cx, cy - r * 2.6); x.lineTo(cx, cy + r * 2.6); x.stroke();
    });
  }
  function rr(x, X, Y, w, h, r) {
    x.beginPath(); x.moveTo(X + r, Y); x.lineTo(X + w - r, Y); x.quadraticCurveTo(X + w, Y, X + w, Y + r);
    x.lineTo(X + w, Y + h - r); x.quadraticCurveTo(X + w, Y + h, X + w - r, Y + h); x.lineTo(X + r, Y + h);
    x.quadraticCurveTo(X, Y + h, X, Y + h - r); x.lineTo(X, Y + r); x.quadraticCurveTo(X, Y, X + r, Y); x.closePath();
  }
  function skyline(p, base, col, win) {
    var x = p.x, w = -p.W * 0.02;
    while (w < p.W) {
      var bw = p.W * (0.07 + p.R() * 0.1), bh = p.H * (0.08 + p.R() * 0.26);
      x.fillStyle = col; x.fillRect(w, base - bh, bw - p.W * 0.006, bh + p.H);
      if (p.R() < 0.35) x.fillRect(w + bw * 0.4, base - bh - p.H * 0.04, bw * 0.08, p.H * 0.04);
      var cs = Math.max(2, p.W * 0.011);
      for (var yy = base - bh + cs * 2; yy < base - cs; yy += cs * 2.3) {
        for (var xx = w + cs; xx < w + bw - cs * 2; xx += cs * 2) {
          if (p.R() < 0.32) { x.fillStyle = hexA(win, 0.5 + p.R() * 0.5); x.fillRect(xx, yy, cs, cs * 1.2); }
        }
      }
      w += bw;
    }
  }
  function palm(p, bx, by, h, lean, col) {
    var x = p.x, tx = bx + lean * h, ty = by - h;
    x.save(); x.strokeStyle = col; x.fillStyle = col; x.lineCap = 'round';
    x.lineWidth = h * 0.045; x.beginPath(); x.moveTo(bx, by); x.quadraticCurveTo(bx + lean * h * 0.15, by - h * 0.55, tx, ty); x.stroke();
    for (var i = 0; i < 7; i++) {
      var a = -Math.PI / 2 + (i - 3) * 0.5, len = h * (0.34 + (i % 2) * 0.06);
      var ex = tx + Math.cos(a) * len, ey = ty + Math.sin(a) * len * 0.55 + len * 0.35;
      var mx = tx + Math.cos(a) * len * 0.5, my = ty + Math.sin(a) * len * 0.5 - len * 0.12;
      x.lineWidth = h * 0.05; x.beginPath(); x.moveTo(tx, ty); x.quadraticCurveTo(mx, my, ex, ey); x.stroke();
    }
    x.restore();
  }
  function cake(p, cx, by, w) {
    var x = p.x, h1 = w * 0.3, w2 = w * 0.7, h2 = w * 0.25;
    x.save();
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = w * 0.12;
    x.fillStyle = '#fbe3ee'; rr(x, cx - w / 2, by - h1, w, h1, w * 0.05); x.fill();
    x.shadowBlur = 0;
    x.fillStyle = '#ff7eb9'; rr(x, cx - w / 2, by - h1, w, h1 * 0.22, w * 0.05); x.fill();
    x.fillStyle = '#fff4f8'; rr(x, cx - w2 / 2, by - h1 - h2, w2, h2, w * 0.04); x.fill();
    x.fillStyle = '#ff9fcf'; rr(x, cx - w2 / 2, by - h1 - h2, w2, h2 * 0.25, w * 0.04); x.fill();
    for (var i = 0; i < 5; i++) {
      var kx = cx - w2 * 0.36 + i * w2 * 0.18, ky = by - h1 - h2;
      x.fillStyle = ['#7ad7ff', '#ffd45e', '#ff8fd0', '#9cf5c0', '#c7a6ff'][i]; x.fillRect(kx - w * 0.012, ky - w * 0.13, w * 0.024, w * 0.13);
      lighter(p, function () { glow(p, kx, ky - w * 0.17, w * 0.1, '#ffb347', 0.6); glow(p, kx, ky - w * 0.165, w * 0.025, '#fff6d0', 1); });
    }
    x.restore();
  }
  function flags(p, y0, y1, sag, n, cols, shape) {
    var x = p.x, mx = (p.W) / 2, my = (y0 + y1) / 2 + sag, x0 = -p.W * 0.04, x1 = p.W * 1.04;
    x.save(); x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = Math.max(1, p.W * 0.003);
    x.beginPath(); x.moveTo(x0, y0); x.quadraticCurveTo(mx, my, x1, y1); x.stroke();
    for (var k = 0; k < n; k++) {
      var t = (k + 0.5) / n, it = 1 - t;
      var bx = it * it * x0 + 2 * it * t * mx + t * t * x1, by = it * it * y0 + 2 * it * t * my + t * t * y1;
      var fw = p.W / n * 0.86, fh = fw * (shape === 'tri' ? 1.1 : 1.25);
      x.fillStyle = cols[k % cols.length]; x.globalAlpha = 0.92;
      x.beginPath();
      if (shape === 'tri') { x.moveTo(bx - fw / 2, by); x.lineTo(bx + fw / 2, by); x.lineTo(bx, by + fh); }
      else {
        x.moveTo(bx - fw / 2, by); x.lineTo(bx + fw / 2, by); x.lineTo(bx + fw / 2, by + fh);
        for (var s = 4; s >= 0; s--) x.lineTo(bx - fw / 2 + fw * s / 4, by + fh - (s % 2 ? fw * 0.12 : 0));
      }
      x.closePath(); x.fill();
    }
    x.restore();
  }
  function floorGlow(p, col, a) { glow(p, p.W * 0.5, p.H * 1.02, p.W * 0.75, col, a); }
  function vignette(p) {
    var x = p.x, g = x.createRadialGradient(p.W / 2, p.H * 0.45, p.W * 0.25, p.W / 2, p.H * 0.5, p.H * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.55)');
    x.fillStyle = g; x.fillRect(0, 0, p.W, p.H);
  }
  var HERO_PINK = ['#fff4fb', '#ff8fd0', '#a457ff'], HERO_WARM = ['#fff6e6', '#ffb070', '#ff4f8b'], HERO_COOL = ['#f2fbff', '#7fdcff', '#a457ff'];

  var PAINT = {
    'party-hall': function (p) {
      var W = p.W, H = p.H;
      vgrad(p, [[0, '#1c0a2a'], [0.42, '#47194a'], [0.72, '#2c1031'], [1, '#13081a']]);
      for (var r = 0; r < 4; r++) sparks(p, 8 + r * 4, ['#ffd98a', '#ffc4e6'], 0.02 + r * 0.035, 0.05 + r * 0.035, 0.0045 + r * 0.0012);
      bulbs(p, -W * 0.05, H * 0.17, W * 1.05, H * 0.15, H * 0.1, 13, '#ffd98a');
      bokeh(p, 22, ['#ffd27a', '#ffb3e1', '#fff0c4'], 0.012, 0.045, 0.24, 0.52, 0.6, 0, 0.3);
      bokeh(p, 22, ['#ffd27a', '#ffb3e1', '#fff0c4'], 0.012, 0.045, 0.24, 0.52, 0.6, 0.7, 1);
      glow(p, W * 0.15, H * 0.38, W * 0.24, '#ffcf7a', 0.22); glow(p, W * 0.86, H * 0.36, W * 0.24, '#ffcf7a', 0.22);
      balloon(p, W * 0.11, H * 0.24, W * 0.065, '#ffc2df'); balloon(p, W * 0.22, H * 0.15, W * 0.055, '#fff3fa');
      balloon(p, W * 0.88, H * 0.22, W * 0.065, '#e7c2ff'); balloon(p, W * 0.77, H * 0.13, W * 0.05, '#ffd6ea');
      crowd(p, 7, 0.9, 0.36, 0.43, '#2a1234', '#ff8fd0', ['dance', 'cheer', 'down', 'wave', 'clap', 'sway'], { skip: 0.08 });
      floorGlow(p, '#ff6fb8', 0.28);
      hero(p, W * 0.5, H * 1.02, H * 0.64, 'dance', HERO_PINK, '#ff6fb8');
      crowd(p, 3, 1.16, 0.52, 0.6, '#14091b', '#ff8fd0', ['cheer', 'dance', 'up'], { skip: 0.3, spread: 1.4 });
    },
    club: function (p) {
      var W = p.W, H = p.H;
      vgrad(p, [[0, '#05030f'], [0.5, '#150a33'], [1, '#07040e']]);
      glow(p, W * 0.5, H * 0.2, W * 0.7, '#7c3aed', 0.35);
      lasers(p, W * 0.5, -H * 0.02, 9, ['#22d3ee', '#ff3fd0', '#a457ff'], 120, H * 1.3);
      lasers(p, W * 0.08, H * 0.05, 4, ['#22d3ee', '#ff3fd0'], 60, H * 1.1);
      lasers(p, W * 0.92, H * 0.05, 4, ['#ff3fd0', '#22d3ee'], 60, H * 1.1);
      bokeh(p, 10, ['#ff3fd0', '#22d3ee', '#a457ff'], 0.08, 0.18, 0.3, 0.7, 0.18);
      p.x.fillStyle = 'rgba(20,10,40,.9)'; rr(p.x, W * 0.3, H * 0.44, W * 0.4, H * 0.06, W * 0.02); p.x.fill();
      lighter(p, function () { glow(p, W * 0.5, H * 0.45, W * 0.25, '#22d3ee', 0.4); });
      crowd(p, 9, 0.92, 0.34, 0.42, '#0d0820', '#22d3ee', ['up', 'cheer', 'up', 'dance', 'sway'], { skip: 0.07 });
      floorGlow(p, '#a457ff', 0.3);
      hero(p, W * 0.5, H * 1.03, H * 0.64, 'up', HERO_COOL, '#ff3fd0');
      crowd(p, 3, 1.15, 0.52, 0.62, '#06040f', '#ff3fd0', ['up', 'cheer'], { skip: 0.3, spread: 1.4 });
    },
    spanish: function (p) {
      var W = p.W, H = p.H;
      vgrad(p, [[0, '#240b12'], [0.45, '#5f2316'], [0.78, '#2c0f0c'], [1, '#160807']]);
      glow(p, W * 0.5, H * 0.45, W * 0.75, '#ff9a3d', 0.28);
      flags(p, H * 0.05, H * 0.07, H * 0.06, 7, ['#ff4f8b', '#ffb020', '#2ec4b6', '#a457ff', '#ff7a2f', '#22a6ee', '#ffd23f']);
      flags(p, H * 0.19, H * 0.17, H * 0.05, 6, ['#22a6ee', '#ff4f8b', '#ffd23f', '#2ec4b6', '#ff7a2f', '#a457ff']);
      bulbs(p, -W * 0.05, H * 0.31, W * 1.05, H * 0.3, H * 0.06, 11, '#ffcf70');
      bokeh(p, 18, ['#ffcf70', '#ff9a3d'], 0.012, 0.04, 0.34, 0.6, 0.5);
      crowd(p, 6, 0.92, 0.38, 0.45, '#2b110c', '#ffb347', ['clap', 'cheer', 'sway', 'wave'], { skip: 0.1 });
      // guitar
      var x = p.x, gx = W * 0.2, gy = H * 0.8;
      x.save(); x.translate(gx, gy); x.rotate(-0.6);
      x.fillStyle = '#c9773a'; x.beginPath(); x.ellipse(0, 0, W * 0.07, W * 0.09, 0, 0, TAU); x.fill();
      x.beginPath(); x.ellipse(0, -W * 0.1, W * 0.055, W * 0.065, 0, 0, TAU); x.fill();
      x.fillStyle = '#2b110c'; x.beginPath(); x.arc(0, -W * 0.02, W * 0.022, 0, TAU); x.fill();
      x.fillStyle = '#6b3a1a'; x.fillRect(-W * 0.012, -W * 0.36, W * 0.024, W * 0.24);
      x.restore();
      floorGlow(p, '#ff9a3d', 0.25);
      hero(p, W * 0.52, H * 1.02, H * 0.62, 'sway', HERO_WARM, '#ff9a3d');
      note(p, W * 0.74, H * 0.4, W * 0.07, '#ffe1a0'); note(p, W * 0.84, H * 0.3, W * 0.05, '#ffd0e6'); note(p, W * 0.3, H * 0.36, W * 0.055, '#ffe1a0');
    },
    karaoke: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#0f0726'], [0.5, '#2a1157'], [1, '#0a0518']]);
      x.save(); x.shadowColor = '#4fb4ff'; x.shadowBlur = W * 0.08;
      x.fillStyle = '#123a7a'; rr(x, W * 0.14, H * 0.1, W * 0.72, H * 0.27, W * 0.03); x.fill(); x.restore();
      x.fillStyle = 'rgba(255,255,255,.85)'; rr(x, W * 0.24, H * 0.18, W * 0.52, H * 0.03, H * 0.015); x.fill();
      x.fillStyle = 'rgba(255,120,210,.9)'; rr(x, W * 0.24, H * 0.18, W * 0.3, H * 0.03, H * 0.015); x.fill();
      x.fillStyle = 'rgba(255,255,255,.45)'; rr(x, W * 0.3, H * 0.25, W * 0.4, H * 0.025, H * 0.012); x.fill();
      beam(p, W * 0.1, 0, W * 0.4, H * 0.95, W * 0.04, W * 0.5, '#ff5cc8', 0.28);
      beam(p, W * 0.9, 0, W * 0.6, H * 0.95, W * 0.04, W * 0.5, '#6aa8ff', 0.28);
      var bx = W * 0.5, by = H * 0.055; glow(p, bx, by, W * 0.09, '#ffffff', 0.5);
      x.fillStyle = '#d8d8f0'; x.beginPath(); x.arc(bx, by, W * 0.04, 0, TAU); x.fill();
      sparks(p, 16, ['#ffffff', '#ffb3ec', '#9fd0ff'], 0.05, 0.6, 0.004);
      floorGlow(p, '#c04fff', 0.3);
      var r = hero(p, W * 0.5, H * 1.03, H * 0.64, 'mic', HERO_PINK, '#c04fff');
      x.save(); x.fillStyle = '#2b2440'; x.strokeStyle = '#2b2440'; x.lineWidth = W * 0.014; x.lineCap = 'round';
      x.beginPath(); x.moveTo(r.handR[0], r.handR[1]); x.lineTo(r.handR[0] + W * 0.02, r.handR[1] + W * 0.06); x.stroke();
      x.fillStyle = '#c9c4dd'; x.beginPath(); x.arc(r.handR[0] - W * 0.005, r.handR[1] - W * 0.012, W * 0.02, 0, TAU); x.fill(); x.restore();
      crowd(p, 4, 1.14, 0.46, 0.56, '#100821', '#ff5cc8', ['cheer', 'up', 'clap'], { skip: 0.28, spread: 1.35 });
      note(p, W * 0.78, H * 0.48, W * 0.06, '#ffd0f2'); note(p, W * 0.22, H * 0.52, W * 0.05, '#c9e2ff');
    },
    concert: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#030512'], [0.5, '#0c1740'], [1, '#04030c']]);
      x.fillStyle = '#0a0a18'; x.fillRect(0, H * 0.035, W, H * 0.025);
      for (var i = 0; i < 6; i++) { var lx = W * (0.1 + i * 0.16); lighter(p, function () { glow(p, lx, H * 0.05, W * 0.04, '#ffffff', 0.9); }); }
      beam(p, W * 0.1, H * 0.05, W * 0.38, H * 0.7, W * 0.02, W * 0.4, '#9fb7ff', 0.3);
      beam(p, W * 0.42, H * 0.05, W * 0.5, H * 0.7, W * 0.02, W * 0.36, '#ffffff', 0.32);
      beam(p, W * 0.74, H * 0.05, W * 0.55, H * 0.7, W * 0.02, W * 0.4, '#c58bff', 0.3);
      beam(p, W * 0.9, H * 0.05, W * 0.95, H * 0.8, W * 0.02, W * 0.3, '#6aa8ff', 0.22);
      x.fillStyle = '#05060f'; x.fillRect(0, H * 0.64, W, H * 0.4);
      lighter(p, function () { x.fillStyle = 'rgba(120,150,255,.35)'; x.fillRect(0, H * 0.64, W, H * 0.006); });
      hero(p, W * 0.5, H * 0.645, H * 0.4, 'mic', HERO_COOL, '#7f9bff');
      crowd(p, 12, 1.0, 0.26, 0.32, '#090a16', '#6a7dff', ['up', 'cheer', 'up', 'wave'], { spread: 1.15 });
      crowd(p, 7, 1.12, 0.36, 0.44, '#04040b', '#6a7dff', ['up', 'cheer'], { spread: 1.25 });
      sparks(p, 22, ['#ffffff', '#cfe0ff'], 0.66, 0.86, 0.0035);
    },
    wedding: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#24171b'], [0.45, '#5a3b3c'], [0.78, '#2e1f22'], [1, '#160e10']]);
      glow(p, W * 0.5, H * 0.35, W * 0.7, '#ffd9b0', 0.22);
      bulbs(p, -W * 0.05, H * 0.02, W * 0.6, H * 0.26, H * 0.06, 9, '#ffe2b0');
      bulbs(p, W * 1.05, H * 0.02, W * 0.4, H * 0.26, H * 0.06, 9, '#ffe2b0');
      bulbs(p, -W * 0.05, H * 0.12, W * 1.05, H * 0.12, H * 0.12, 13, '#fff0d0');
      bokeh(p, 26, ['#ffe2b0', '#ffd0d6', '#fff6e6'], 0.012, 0.04, 0.28, 0.6, 0.55);
      for (var t = 0; t < 2; t++) {
        var tx = t ? W * 0.88 : W * 0.12;
        x.fillStyle = 'rgba(255,245,240,.85)'; x.beginPath(); x.ellipse(tx, H * 0.66, W * 0.13, H * 0.025, 0, 0, TAU); x.fill();
        x.fillRect(tx - W * 0.13, H * 0.66, W * 0.26, H * 0.08);
        for (var f = 0; f < 5; f++) { x.fillStyle = ['#ffc6d2', '#ffffff', '#f5a9bc'][f % 3]; x.beginPath(); x.arc(tx - W * 0.04 + f * W * 0.02, H * 0.635 - (f % 2) * H * 0.01, W * 0.018, 0, TAU); x.fill(); }
        lighter(p, function () { glow(p, tx + W * 0.05, H * 0.64, W * 0.05, '#ffcf7a', 0.7); });
      }
      crowd(p, 6, 0.92, 0.37, 0.43, '#2a1b1e', '#ffd6b0', ['clap', 'sway', 'dance', 'clap'], { skip: 0.1 });
      floorGlow(p, '#ffcfa0', 0.25);
      hero(p, W * 0.5, H * 1.02, H * 0.63, 'sway', ['#fffaf2', '#ffc9b8', '#e0779a'], '#ffc9a0');
      sparks(p, 10, ['#fff3d6'], 0.05, 0.7, 0.004);
    },
    birthday: function (p) {
      var W = p.W, H = p.H;
      vgrad(p, [[0, '#28103a'], [0.5, '#6a2a62'], [1, '#1f0d26']]);
      glow(p, W * 0.5, H * 0.55, W * 0.7, '#ffb36b', 0.24);
      balloon(p, W * 0.12, H * 0.16, W * 0.075, '#ff6fae'); balloon(p, W * 0.27, H * 0.09, W * 0.065, '#ffd23f');
      balloon(p, W * 0.72, H * 0.1, W * 0.065, '#5ad1ff'); balloon(p, W * 0.88, H * 0.18, W * 0.075, '#b98bff');
      balloon(p, W * 0.06, H * 0.36, W * 0.055, '#7ff0c0'); balloon(p, W * 0.95, H * 0.38, W * 0.055, '#ff9a5a');
      confetti(p, 70, ['#ff4fa3', '#ffd23f', '#22d3ee', '#a457ff', '#7ff0c0', '#ff9a5a'], 0, 0.75);
      crowd(p, 6, 0.95, 0.38, 0.46, '#2b1232', '#ffb36b', ['cheer', 'up', 'clap', 'wave'], { skip: 0.12 });
      hero(p, W * 0.5, H * 1.04, H * 0.62, 'cheer', HERO_WARM, '#ff8fb0');
      cake(p, W * 0.5, H * 1.0, W * 0.42);
    },
    beach: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#2a1b4d'], [0.3, '#8a3d7d'], [0.5, '#ff7a59'], [0.56, '#ffb35c'], [0.6, '#6b3a6e'], [0.78, '#3a2346'], [1, '#22142a']]);
      lighter(p, function () { glow(p, W * 0.5, H * 0.55, W * 0.55, '#ffb347', 0.55); });
      x.fillStyle = '#ffe1a0'; x.beginPath(); x.arc(W * 0.5, H * 0.555, W * 0.1, Math.PI, 0); x.fill();
      x.fillStyle = 'rgba(255,200,140,.5)';
      for (var i = 0; i < 9; i++) { var ly = H * (0.575 + i * 0.012), lw = W * (0.3 - i * 0.025); x.fillRect(W * 0.5 - lw / 2, ly, lw, Math.max(1, H * 0.004)); }
      palm(p, W * 0.04, H * 0.8, H * 0.5, 0.18, '#1a0d1e'); palm(p, W * 0.97, H * 0.82, H * 0.44, -0.16, '#1a0d1e');
      bulbs(p, W * 0.13, H * 0.36, W * 0.88, H * 0.42, H * 0.06, 10, '#ffd98a');
      lighter(p, function () { glow(p, W * 0.16, H * 0.86, W * 0.2, '#ff8a3d', 0.55); });
      crowd(p, 6, 0.95, 0.36, 0.44, '#24112b', '#ff9a5a', ['dance', 'up', 'sway', 'cheer'], { skip: 0.1 });
      hero(p, W * 0.5, H * 1.02, H * 0.62, 'cheer', HERO_WARM, '#ff9a5a');
    },
    rooftop: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#040a1f'], [0.55, '#10224d'], [1, '#070c1c']]);
      lighter(p, function () { glow(p, W * 0.8, H * 0.12, W * 0.16, '#e8f0ff', 0.5); });
      x.fillStyle = '#eef3ff'; x.beginPath(); x.arc(W * 0.8, H * 0.12, W * 0.045, 0, TAU); x.fill();
      sparks(p, 14, ['#ffffff'], 0.02, 0.3, 0.0022);
      skyline(p, H * 0.62, '#0a1230', '#ffd27a');
      lighter(p, function () { glow(p, W * 0.5, H * 0.6, W * 0.8, '#ffb347', 0.12); });
      x.fillStyle = 'rgba(8,12,28,.95)'; x.fillRect(0, H * 0.62, W, H * 0.4);
      x.strokeStyle = 'rgba(180,200,255,.25)'; x.lineWidth = Math.max(1, W * 0.004);
      x.beginPath(); x.moveTo(0, H * 0.66); x.lineTo(W, H * 0.66); x.stroke();
      bulbs(p, -W * 0.05, H * 0.24, W * 1.05, H * 0.22, H * 0.1, 12, '#ffd98a');
      crowd(p, 6, 0.95, 0.37, 0.44, '#0a0f22', '#7fb2ff', ['dance', 'sway', 'clap', 'wave'], { skip: 0.1 });
      hero(p, W * 0.5, H * 1.02, H * 0.62, 'dance', ['#f6fbff', '#ffc48a', '#ff5f9e'], '#ffb36b');
    },
    street: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#3a2649'], [0.45, '#b4583a'], [0.62, '#4a2a2e'], [1, '#1c1216']]);
      lighter(p, function () { glow(p, W * 0.2, H * 0.12, W * 0.6, '#ffc46b', 0.45); });
      var murals = [['#18b6a4', 0, 0.2, 0.22, 0.38], ['#ff4f8b', 0.06, 0.32, 0.16, 0.2], ['#ffd23f', 0.78, 0.22, 0.24, 0.3], ['#6a5cff', 0.82, 0.4, 0.18, 0.2]];
      murals.forEach(function (m) { x.fillStyle = hexA(m[0], 0.75); rr(x, W * m[1], H * m[2], W * m[3], H * m[4], W * 0.04); x.fill(); });
      x.fillStyle = 'rgba(30,18,24,.75)'; x.fillRect(0, H * 0.6, W, H * 0.4);
      x.strokeStyle = 'rgba(255,220,180,.18)'; x.lineWidth = Math.max(1, W * 0.004);
      for (var i = 1; i < 5; i++) { x.beginPath(); x.moveTo(W * 0.5, H * 0.6); x.lineTo(W * (0.5 + (i - 2.5) * 0.6), H); x.stroke(); }
      x.fillStyle = '#1a1014'; x.fillRect(W * 0.66, H * 0.12, W * 0.012, H * 0.5);
      lighter(p, function () { glow(p, W * 0.67, H * 0.12, W * 0.08, '#ffd27a', 0.8); });
      crowd(p, 5, 0.9, 0.38, 0.45, '#1c1014', '#ffb36b', ['dance', 'pose', 'up', 'sway'], { skip: 0.12 });
      hero(p, W * 0.5, H * 0.99, H * 0.62, 'pose', ['#fff6e8', '#5fe0d0', '#5b5cff'], '#ffb36b');
    },
    festival: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#ff7eb3'], [0.32, '#ffb36b'], [0.58, '#a4508b'], [1, '#2a1240']]);
      lighter(p, function () { glow(p, W * 0.5, H * 0.16, W * 0.5, '#fff3c4', 0.5); });
      x.fillStyle = 'rgba(40,16,60,.85)'; x.fillRect(W * 0.26, H * 0.38, W * 0.48, H * 0.12);
      x.fillRect(W * 0.24, H * 0.36, W * 0.52, H * 0.025);
      for (var i = 0; i < 5; i++) { var sx = W * (0.3 + i * 0.1); lighter(p, function () { glow(p, sx, H * 0.39, W * 0.03, '#ffffff', 0.8); }); }
      flags(p, H * 0.08, H * 0.14, H * 0.05, 9, ['#ff3f7f', '#ffd23f', '#22d3ee', '#7ff0c0', '#a457ff'], 'tri');
      flags(p, H * 0.2, H * 0.16, H * 0.05, 8, ['#22d3ee', '#ff7a2f', '#a457ff', '#ffd23f'], 'tri');
      crowd(p, 11, 0.96, 0.3, 0.36, '#3a1650', '#ffd6a0', ['up', 'cheer', 'up', 'wave'], { skip: 0.07, spread: 1.15 });
      hero(p, W * 0.5, H * 1.03, H * 0.62, 'cheer', ['#ffffff', '#ffd36b', '#ff4f8b'], '#fff0b0');
      crowd(p, 3, 1.15, 0.5, 0.6, '#2a0f3c', '#ffd6a0', ['up', 'cheer'], { skip: 0.3, spread: 1.4 });
      confetti(p, 90, ['#ff3f7f', '#ffd23f', '#22d3ee', '#7ff0c0', '#ffffff', '#a457ff'], 0, 0.95);
    },
    redcarpet: function (p) {
      var W = p.W, H = p.H, x = p.x;
      vgrad(p, [[0, '#12060a'], [0.5, '#350c16'], [1, '#0b0305']]);
      glow(p, W * 0.5, H * 0.35, W * 0.6, '#ffcf8a', 0.18);
      var g = x.createLinearGradient(0, H * 0.5, 0, H);
      g.addColorStop(0, '#7a0f1f'); g.addColorStop(1, '#c2182f');
      x.fillStyle = g; x.beginPath(); x.moveTo(W * 0.4, H * 0.5); x.lineTo(W * 0.6, H * 0.5); x.lineTo(W * 1.05, H); x.lineTo(-W * 0.05, H); x.closePath(); x.fill();
      for (var s = 0; s < 2; s++) {
        var side = s ? 1 : -1;
        for (var k = 0; k < 3; k++) {
          var t = k / 2, px = W * (0.5 + side * (0.12 + t * 0.4)), py = H * (0.52 + t * 0.42), ph = H * (0.06 + t * 0.07);
          x.fillStyle = '#d9a640'; x.fillRect(px - W * 0.008, py - ph, W * 0.016, ph);
          x.beginPath(); x.arc(px, py - ph, W * 0.016, 0, TAU); x.fill();
          if (k < 2) {
            var nx = W * (0.5 + side * (0.12 + (t + 0.5) * 0.4)), ny = H * (0.52 + (t + 0.5) * 0.42), nh = H * (0.06 + (t + 0.5) * 0.07);
            x.strokeStyle = '#8a1424'; x.lineWidth = W * 0.012; x.beginPath(); x.moveTo(px, py - ph * 0.85);
            x.quadraticCurveTo((px + nx) / 2, (py - ph * 0.85 + ny - nh * 0.85) / 2 + H * 0.04, nx, ny - nh * 0.85); x.stroke();
          }
        }
      }
      crowd(p, 3, 0.74, 0.26, 0.3, '#160509', '#ffffff', ['mic', 'pose'], { spread: 0.36 });
      p.x.save(); p.x.translate(W * 0.64, 0); crowd(p, 3, 0.74, 0.26, 0.3, '#160509', '#ffffff', ['mic', 'pose'], { spread: 0.36 }); p.x.restore();
      [[0.08, 0.5], [0.22, 0.44], [0.8, 0.46], [0.93, 0.52], [0.15, 0.62], [0.86, 0.6], [0.3, 0.38], [0.7, 0.4]].forEach(function (f) { flash(p, W * f[0], H * f[1], W * (0.012 + p.R() * 0.01)); });
      hero(p, W * 0.5, H * 1.0, H * 0.6, 'wave', ['#fffaf0', '#ffd28a', '#e0466b'], '#ffd28a');
    },
    'famous-street': function (p) {
      var W = p.W, H = p.H, x = p.x, i;
      vgrad(p, [[0, '#1a0206'], [0.45, '#4a0710'], [0.8, '#22030a'], [1, '#0e0104']]);
      // red-lit stairs coming down toward the camera
      for (i = 0; i < 11; i++) {
        var t = i / 10, y = H * (0.3 + t * t * 0.62), hw = W * (0.16 + t * 0.42), th = H * (0.012 + t * 0.03);
        var g = x.createLinearGradient(0, y, 0, y + th);
        g.addColorStop(0, hexA('#ff3a4f', 0.55 + t * 0.35)); g.addColorStop(1, hexA('#5a0612', 0.9));
        x.fillStyle = g; x.fillRect(W * 0.5 - hw, y, hw * 2, th);
      }
      // red neon light bars on the walls
      [[0.06, 0.12], [0.94, 0.12], [0.18, 0.2], [0.82, 0.2]].forEach(function (b, k) {
        lighter(p, function () { beam(p, W * b[0], H * b[1], W * b[0], H * 0.95, W * 0.018, W * 0.05, '#ff2a40', 0.5 - k * 0.06); glow(p, W * b[0], H * b[1], W * 0.08, '#ff4057', 0.6); });
      });
      glow(p, W * 0.5, H * 0.22, W * 0.55, '#ff2f55', 0.3);
      bokeh(p, 14, ['#ff5a6e', '#ff9aa8'], 0.01, 0.03, 0.05, 0.4, 0.45);
      // fans on both sides, phones up
      for (var sd = 0; sd < 2; sd++) {
        x.save();
        if (sd) { x.translate(W, 0); x.scale(-1, 1); }
        crowd(p, 4, 0.86, 0.34, 0.42, '#1c0207', '#ff5068', ['up', 'cheer', 'wave', 'up'], { spread: 0.5 });
        for (i = 0; i < 5; i++) {
          var px = W * (0.04 + i * 0.075), py = H * (0.42 + (i % 2) * 0.06 + p.R() * 0.04);
          x.save(); x.fillStyle = '#f2f6ff'; x.shadowColor = '#bfe0ff'; x.shadowBlur = W * 0.05;
          rr(x, px, py, W * 0.034, W * 0.058, W * 0.007); x.fill(); x.restore();
        }
        x.restore();
      }
      [[0.12, 0.36], [0.86, 0.4], [0.25, 0.48], [0.76, 0.52], [0.09, 0.58]].forEach(function (f) { flash(p, W * f[0], H * f[1], W * (0.01 + p.R() * 0.01)); });
      floorGlow(p, '#ff2f55', 0.3);
      hero(p, W * 0.5, H * 1.0, H * 0.6, 'wave', ['#ffffff', '#ffe3ea', '#ff6b8a'], '#ff5a78');
    },
    'club-exit-sing': function (p) {
      var W = p.W, H = p.H, x = p.x, i;
      vgrad(p, [[0, '#060818'], [0.5, '#151a3e'], [0.75, '#1c1230'], [1, '#09060f']]);
      // the club front: a lit doorway under a neon sign
      x.fillStyle = '#0c0b1c'; x.fillRect(W * 0.18, H * 0.12, W * 0.64, H * 0.5);
      var dg = x.createLinearGradient(0, H * 0.24, 0, H * 0.6);
      dg.addColorStop(0, '#ffcf7a'); dg.addColorStop(1, '#ff7a45');
      x.fillStyle = dg; x.fillRect(W * 0.38, H * 0.25, W * 0.24, H * 0.36);
      lighter(p, function () { glow(p, W * 0.5, H * 0.45, W * 0.38, '#ffb04a', 0.45); });
      // the neon sign over the door: a word in pink neon script in a thin cyan frame
      x.save(); x.lineJoin = 'round'; x.lineWidth = Math.max(1, W * 0.008); x.shadowBlur = W * 0.05;
      x.strokeStyle = '#4fd8ff'; x.shadowColor = '#4fd8ff';
      rr(x, W * 0.27, H * 0.125, W * 0.46, H * 0.09, W * 0.03); x.stroke();
      x.fillStyle = '#ffd6f3'; x.shadowColor = '#ff5ccf'; x.shadowBlur = W * 0.06;
      x.font = 'italic 700 ' + Math.round(H * 0.064) + 'px "Segoe Script", "Brush Script MT", "Trebuchet MS", cursive';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('noche', W * 0.5, H * 0.172);
      x.restore();
      // bouncer by the door
      person(p, W * 0.3, H * 0.63, H * 0.36, { fill: '#05050c', glow: '#ffb04a', glowR: 0.05, pose: 'down', step: 0.01 });
      // wet street with neon reflections
      x.fillStyle = 'rgba(10,10,26,.92)'; x.fillRect(0, H * 0.62, W, H * 0.4);
      lighter(p, function () {
        for (i = 0; i < 9; i++) { var ry = H * (0.66 + i * 0.035), c = i % 2 ? '#ff5ccf' : '#4fd8ff'; x.fillStyle = hexA(c, 0.16 - i * 0.012); x.fillRect(W * (0.25 + (i % 3) * 0.05), ry, W * (0.5 - (i % 3) * 0.08), Math.max(1, H * 0.006)); }
        glow(p, W * 0.08, H * 0.1, W * 0.12, '#ffe0a0', 0.5); glow(p, W * 0.92, H * 0.1, W * 0.12, '#ffe0a0', 0.5);
      });
      // friends arm in arm, singing
      crowd(p, 5, 0.97, 0.4, 0.47, '#140f24', '#ff8fd0', ['cheer', 'sway', 'up', 'sway', 'cheer'], { skip: 0.11 });
      hero(p, W * 0.5, H * 1.02, H * 0.62, 'cheer', HERO_WARM, '#ff9a3d');
      note(p, W * 0.74, H * 0.42, W * 0.07, '#ffe1a0'); note(p, W * 0.86, H * 0.32, W * 0.05, '#ffd0e6'); note(p, W * 0.24, H * 0.38, W * 0.055, '#c9e2ff');
    }
  };
  function paintScene(canvas, id) {
    var x = canvas.getContext('2d');
    if (!x) return;
    var p = { x: x, W: canvas.width, H: canvas.height, R: rng(seedOf(id)) };
    x.save();
    try { (PAINT[id] || (id === 'vip-exit' && PAINT['famous-street']) || PAINT['party-hall'])(p); } catch (e) { console.warn('[glow-ai] art failed', id, e); }
    x.restore();
    vignette(p);
  }

  /* ------------------------------------------------------------------ *
   * Scene grid
   * ------------------------------------------------------------------ */
  var sceneBtns = {};
  var DPR = Math.min(2, window.devicePixelRatio || 1);
  var ICON_PV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8c0 .8.9 1.3 1.5.8l10-6.4c.6-.4.6-1.2 0-1.6l-10-6.4C8.9 4.3 8 4.8 8 5.6z"/></svg>';
  function renderScenes() {
    el.scenes.textContent = '';
    SCENES.forEach(function (sc, i) {
      var wrap = document.createElement('div'); wrap.className = 'ai-scene-w';
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ai-scene'; b.setAttribute('role', 'radio'); b.dataset.scene = sc.id;
      var art = document.createElement('span'); art.className = 'ai-scene-art';
      var cv = document.createElement('canvas'); cv.width = Math.round(180 * DPR); cv.height = Math.round(225 * DPR); cv.setAttribute('aria-hidden', 'true');
      art.appendChild(cv);
      var badges = document.createElement('span'); badges.className = 'ai-badges';
      (sc.badges || []).forEach(function (t) {
        var tag = document.createElement('span');
        tag.className = 'ai-badge ai-badge-' + t.toLowerCase().replace(/[^a-z]+/g, '-');
        if (t === 'With singing') tag.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
        tag.appendChild(document.createTextNode(t));
        badges.appendChild(tag);
      });
      art.appendChild(badges);
      var ck = document.createElement('span'); ck.className = 'ai-check'; ck.setAttribute('aria-hidden', 'true');
      ck.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4 4 9-9"/></svg>';
      art.appendChild(ck);
      // on a card that plays the user's own AI video (or quick preview): who it is, and the AI label (always shown
      // there: the label burned into the video can be cropped off by the card's shape)
      var you = document.createElement('span'); you.className = 'ai-you'; you.hidden = true; you.setAttribute('aria-hidden', 'true');
      var youT = document.createElement('b'); var youL = document.createElement('i'); youL.textContent = 'AI-generated';
      you.appendChild(youT); you.appendChild(youL); art.appendChild(you);
      var txt = document.createElement('span'); txt.className = 'ai-scene-txt';
      var nm = document.createElement('b'); nm.textContent = sc.name; txt.appendChild(nm);
      if (sc.alt) { var al = document.createElement('i'); al.textContent = sc.alt; txt.appendChild(al); }
      var ln = document.createElement('small'); ln.textContent = sc.line; txt.appendChild(ln);
      art.appendChild(txt);
      var ring = document.createElement('span'); ring.className = 'ai-ring'; ring.setAttribute('aria-hidden', 'true'); art.appendChild(ring);
      b.appendChild(art);
      var label = sc.name + (sc.alt ? ' (' + sc.alt + ')' : '') + '. ' + sc.line + '.' + (sc.story ? ' A story of up to 4 shots.' : '') + (sc.badges && sc.badges.length ? ' ' + sc.badges.join(', ') + '.' : '') +
        (sc.audio === 'required' ? ' Uses AI sound or your own song.' : '');
      b.setAttribute('aria-label', label);
      b.addEventListener('click', function () { selectScene(sc.id, { user: true }); });
      b.addEventListener('keydown', function (e) { sceneKeys(e, i); });
      // "▶ Preview": a bigger example with the scene's sound, before picking it
      var pv = document.createElement('button');
      pv.type = 'button'; pv.className = 'ai-scene-pv'; pv.dataset.preview = sc.id; pv.tabIndex = -1;
      pv.innerHTML = ICON_PV + '<span>Preview</span>';
      pv.setAttribute('aria-label', 'Preview ' + sc.name + ' with sound');
      pv.addEventListener('click', function (e) { e.stopPropagation(); openScenePreview(sc.id, pv); });
      wrap.appendChild(b); wrap.appendChild(pv);
      el.scenes.appendChild(wrap);
      sceneBtns[sc.id] = { btn: b, canvas: cv, art: art, pv: pv, you: you, youT: youT, wrap: wrap };
    });
    var paintAll = function () {
      SCENES.forEach(function (sc, k) {
        setTimeout(function () { cardInit(sc.id); sceneBtns[sc.id].btn.classList.add('ready'); if (k === SCENES.length - 1) { cardsWatch(); updateCardPreviews(); } }, k * 16);
      });
    };
    if ('requestIdleCallback' in window) requestIdleCallback(paintAll, { timeout: 500 }); else setTimeout(paintAll, 60);
  }

  /* ------------------------------------------------------------------ *
   * Scene cards in motion: each card's poster is painted once, then a light layer moves on top of it to the scene's
   * beat (crowd bobbing, phone flashes, sweeping lights, confetti, notes). Only cards on screen move, at 15–24 fps,
   * never while the page is hidden or in Photo Video, and not at all with reduced motion. A scene the user has made
   * a video in shows the first seconds of their latest one instead (muted loop, with its burned-in AI label).
   * ------------------------------------------------------------------ */
  var CARD_FX = {
    'party-hall': ['bob', 'bokeh', 'crowd'], 'famous-street': ['bob', 'phones', 'flashes', 'crowd'], 'club-exit-sing': ['bob', 'neon', 'notes', 'crowd'], 'vip-exit': ['bob', 'phones', 'flashes', 'notes', 'crowd'],
    club: ['bob', 'lasers', 'crowd'], spanish: ['bob', 'notes', 'bokeh', 'crowd'], karaoke: ['bob', 'beams', 'notes'], concert: ['bob', 'beams', 'phones', 'crowd'],
    wedding: ['bob', 'bokeh', 'crowd'], birthday: ['bob', 'confetti'], beach: ['bob', 'bokeh', 'crowd'], rooftop: ['bob', 'bokeh', 'crowd'],
    street: ['bob', 'crowd'], festival: ['bob', 'confetti', 'crowd'], redcarpet: ['bob', 'flashes']
  };
  var CARD_COL = {
    'party-hall': '#ff8fd0', 'famous-street': '#ff5068', 'club-exit-sing': '#ff8fd0', 'vip-exit': '#ff5068', club: '#22d3ee', spanish: '#ffb347', karaoke: '#ff5cc8', concert: '#7f9bff',
    wedding: '#ffd6b0', birthday: '#ffb36b', beach: '#ff9a5a', rooftop: '#7fb2ff', street: '#ffb36b', festival: '#ffd6a0', redcarpet: '#ffd28a'
  };
  var CARD = { list: {}, vis: {}, raf: 0, last: 0, draws: {}, io: null, fps: 24, t0: performance.now() };
  function sceneBpm(sc) { var t = trackById(sc.defaultTrack); return t ? t.bpm : 110; }
  function cardInit(id) {
    var c = sceneBtns[id];
    if (!c) return;
    var base = document.createElement('canvas'); base.width = c.canvas.width; base.height = c.canvas.height;
    paintScene(base, id);
    CARD.list[id] = { id: id, cv: c.canvas, base: base, fx: CARD_FX[id] || ['bob'], col: CARD_COL[id] || '#ff8fd0', bpm: sceneBpm(sceneById(id)), seed: seedOf(id) };
    drawCard(CARD.list[id], 0);
  }
  function cardsWatch() {
    CARD.fps = COARSE() ? 15 : 24;
    if (CARD.io || !('IntersectionObserver' in window)) { Object.keys(CARD.list).forEach(function (id) { CARD.vis[id] = true; }); cardsLoop(); return; }
    CARD.io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) {
        var id = e.target.getAttribute('data-card');
        CARD.vis[id] = e.isIntersecting;
        cardVideoPlay(id);
      });
      cardsLoop();
    }, { rootMargin: '40px 0px', threshold: 0.01 });
    Object.keys(sceneBtns).forEach(function (id) { sceneBtns[id].art.setAttribute('data-card', id); CARD.io.observe(sceneBtns[id].art); });
  }
  // Cards move only when someone can see them and nothing heavier needs the PC: never behind an open sheet (the
  // progress of a 30-minute video, a preview), and not while this PC's AI is making a video or the quick previews.
  function cardsActive() {
    return !REDUCED && !document.hidden && mode() === 'ai' && !document.documentElement.classList.contains('glow-rec') &&
      !document.querySelector('.modal:not([hidden])') && !localBusyHere();
  }
  function localBusyHere() { return (running() && !!RUN.job && RUN.job.engine === 'local') || SEE.running; }
  // (called when a sheet opens or closes, and when a video or the previews start or end)
  function cardsWake() { cardsLoop(); Object.keys(sceneBtns).forEach(cardVideoPlay); }
  function cardsLoop() {
    if (CARD.raf || !cardsActive()) return;
    var tickC = function (now) {
      CARD.raf = 0;
      if (!cardsActive()) return;
      var any = false;
      if (now - CARD.last >= 1000 / CARD.fps - 2) {
        CARD.last = now;
        var t = (now - CARD.t0) / 1000;
        Object.keys(CARD.list).forEach(function (id) {
          if (!CARD.vis[id]) return;
          any = true;
          if (sceneBtns[id].vid && !sceneBtns[id].vid.paused) return; // their own video plays instead
          drawCard(CARD.list[id], t);
          CARD.draws[id] = (CARD.draws[id] || 0) + 1;
        });
      } else any = Object.keys(CARD.vis).some(function (id) { return CARD.vis[id]; });
      if (any) CARD.raf = requestAnimationFrame(tickC);
    };
    CARD.raf = requestAnimationFrame(tickC);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) cardsLoop(); Object.keys(sceneBtns).forEach(cardVideoPlay); });
  document.addEventListener('glow:mode', function () { cardsLoop(); Object.keys(sceneBtns).forEach(cardVideoPlay); });
  // the moving layer: t in seconds; everything is a pure function of t (and the card's seed)
  function drawCard(c, t, target) {
    var cv = target || c.cv, x = cv.getContext('2d');
    if (!x) return;
    var W = cv.width, H = cv.height, beat = 60 / c.bpm, ph = (t / beat) % 1, pulse = Math.exp(-ph * 5), bar = Math.floor(t / beat);
    var bob = c.fx.indexOf('bob') >= 0 && !REDUCED ? pulse : 0;
    x.save();
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    var s = 1 + 0.014 * bob;
    x.translate(W / 2, H / 2); x.scale(s, s); x.translate(-W / 2, -H / 2 - H * 0.004 * bob);
    x.drawImage(c.base, 0, 0, W, H);
    x.restore();
    var p = { x: x, W: W, H: H, R: rng(c.seed) };
    c.fx.forEach(function (fx) { if (FXL[fx]) FXL[fx](p, t, c, beat, pulse, bar); });
  }
  function hash01(a, b) { var h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13; return (h >>> 0) / 4294967296; }
  var FXL = {
    bokeh: function (p, t, c) {
      lighter(p, function () {
        for (var i = 0; i < 7; i++) {
          var a = 0.5 + 0.5 * Math.sin(t * (0.8 + hash01(i, c.seed) * 1.4) + i * 2.1);
          glow(p, p.W * hash01(i, c.seed + 1), p.H * (0.12 + 0.5 * hash01(i, c.seed + 2)), p.W * (0.02 + 0.03 * hash01(i, 7)), c.col, 0.35 * a);
        }
      });
    },
    crowd: function (p, t, c, beat) {
      // a front row of silhouettes (heads, shoulders, raised arms) bobbing to the beat, partly out of frame
      var x = p.x, n = 6, W = p.W, H = p.H;
      x.save();
      x.fillStyle = '#07040d'; x.strokeStyle = '#07040d'; x.lineCap = 'round';
      x.shadowColor = c.col; x.shadowBlur = W * 0.025;
      for (var i = 0; i < n; i++) {
        if (i === 2 || i === 3) continue; // leave the middle (the hero) free
        var off = hash01(i, c.seed) * 0.5, b = Math.abs(Math.sin(Math.PI * ((t / beat) + off)));
        var cx = W * (i + 0.5) / n + W * 0.03 * Math.sin(t * 0.7 + i), by = H * (1.06 - 0.025 * b), r = W * 0.05;
        x.beginPath(); x.ellipse(cx, by - r * 3.1, r * 0.82, r, 0, 0, TAU); x.fill();
        x.beginPath(); x.ellipse(cx, by, r * 2.1, r * 1.7, 0, Math.PI, 0); x.fill();
        if (hash01(i, c.seed + 9) > 0.45) {
          var up = 0.6 + 0.4 * b, side = i < n / 2 ? -1 : 1;
          x.lineWidth = r * 0.55;
          x.beginPath(); x.moveTo(cx + side * r * 1.3, by - r * 1.1); x.lineTo(cx + side * r * 1.9, by - r * (2.6 + 1.6 * up)); x.lineTo(cx + side * r * 1.5, by - r * (3.8 + 2 * up)); x.stroke();
        }
      }
      x.restore();
    },
    phones: function (p, t, c, beat) {
      var x = p.x;
      for (var i = 0; i < 6; i++) {
        var px = p.W * (0.06 + 0.88 * hash01(i, c.seed + 3)), py = p.H * (0.5 + 0.3 * hash01(i, c.seed + 4)) + p.H * 0.008 * Math.sin(t * 3 + i);
        if (Math.abs(px - p.W / 2) < p.W * 0.16) px += px < p.W / 2 ? -p.W * 0.18 : p.W * 0.18;
        x.save(); x.fillStyle = 'rgba(235,244,255,.95)'; x.shadowColor = '#bfe0ff'; x.shadowBlur = p.W * 0.04;
        rr(x, px, py, p.W * 0.03, p.W * 0.052, p.W * 0.006); x.fill(); x.restore();
      }
    },
    flashes: function (p, t, c) {
      // camera flashes: each spot fires for a tenth of a second at its own random moments
      for (var i = 0; i < 9; i++) {
        var per = 0.9 + hash01(i, c.seed + 5) * 1.8, k = Math.floor(t / per + hash01(i, 11)), f = (t / per + hash01(i, 11)) - k;
        if (f > 0.09) continue;
        var px = p.W * (0.05 + 0.9 * hash01(i * 31 + k, c.seed)), py = p.H * (0.25 + 0.45 * hash01(i * 17 + k, c.seed + 1));
        flash(p, px, py, p.W * (0.016 + 0.012 * hash01(i, 3)) * (1 - f * 8));
      }
    },
    lasers: function (p, t, c) {
      var a = Math.sin(t * 0.9) * 40;
      p.x.save(); p.x.translate(p.W / 2, -p.H * 0.02); p.x.rotate(a * Math.PI / 180); p.x.translate(-p.W / 2, p.H * 0.02);
      lasers(p, p.W * 0.5, -p.H * 0.02, 5, ['#22d3ee', '#ff3fd0', '#a457ff'], 70, p.H * 1.2);
      p.x.restore();
    },
    beams: function (p, t, c) {
      var sw = Math.sin(t * 0.8) * p.W * 0.25;
      beam(p, p.W * 0.15, 0, p.W * 0.4 + sw, p.H * 0.95, p.W * 0.04, p.W * 0.45, c.col, 0.22);
      beam(p, p.W * 0.85, 0, p.W * 0.6 - sw, p.H * 0.95, p.W * 0.04, p.W * 0.45, '#9fb7ff', 0.2);
    },
    confetti: function (p, t, c) {
      var x = p.x, cols = ['#ff4fa3', '#ffd23f', '#22d3ee', '#a457ff', '#7ff0c0', '#ffffff'];
      for (var i = 0; i < 22; i++) {
        var sp = 0.12 + 0.14 * hash01(i, c.seed + 6), y = ((hash01(i, c.seed + 7) + t * sp) % 1.1) - 0.05;
        var px = p.W * (hash01(i, c.seed + 8) + 0.03 * Math.sin(t * 2 + i));
        x.save(); x.translate(px, y * p.H); x.rotate(t * (1 + hash01(i, 2) * 3) + i);
        x.fillStyle = cols[i % cols.length]; x.globalAlpha = 0.85;
        var s = p.W * (0.008 + 0.008 * hash01(i, 4)); x.fillRect(-s, -s * 0.42, s * 2, s * 0.84); x.restore();
      }
    },
    notes: function (p, t, c) {
      for (var i = 0; i < 3; i++) {
        var k = (t * 0.25 + i / 3) % 1, px = p.W * (0.2 + 0.6 * hash01(i, c.seed + Math.floor(t * 0.25 + i / 3))), py = p.H * (0.6 - 0.4 * k);
        p.x.save(); p.x.globalAlpha = Math.sin(Math.PI * k); note(p, px, py, p.W * 0.055, i % 2 ? '#ffd0e6' : '#ffe1a0'); p.x.restore();
      }
    },
    neon: function (p, t, c) {
      var on = (Math.sin(t * 7) > -0.85 || Math.sin(t * 2.3) > 0.2) ? 1 : 0.35;
      lighter(p, function () { glow(p, p.W * 0.5, p.H * 0.17, p.W * 0.32, '#ff5ccf', 0.18 * on); });
    }
  };
  // The first seconds of the user's latest video in this scene (or their quick "See yourself" preview) on the card.
  var CARDV = { src: {} };
  function cardMedia(id) {
    for (var i = 0; i < H.list.length; i++) { var it = H.list[i]; if (it.sceneId === id && isLabelled(it)) return { kind: 'video', blob: it.blob, key: 'h' + it.id }; }
    var pv = SEE.saved[id];
    if (pv && pv.labelled && pv.blob instanceof Blob) return { kind: 'preview', blob: pv.blob, key: 'p' + pv.at };
    return null;
  }
  function updateCardPreviews() {
    Object.keys(sceneBtns).forEach(function (id) {
      var c = sceneBtns[id], m = cardMedia(id), key = m ? m.key : '';
      if (CARDV.src[id] && CARDV.src[id].key === key) return;
      if (c.vid) { try { c.vid.pause(); } catch (e) { /* ignore */ } c.vid.removeAttribute('src'); try { c.vid.load(); } catch (e) { /* ignore */ } c.vid.remove(); c.vid = null; }
      if (CARDV.src[id]) { URL.revokeObjectURL(CARDV.src[id].url); delete CARDV.src[id]; }
      c.you.hidden = !m;
      c.btn.classList.toggle('has-you', !!m);
      if (!m) return;
      var url = URL.createObjectURL(m.blob), v = document.createElement('video');
      v.className = 'ai-scene-vid'; v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'metadata'; v.setAttribute('aria-hidden', 'true');
      v.addEventListener('timeupdate', function () { if (v.currentTime > 3.2) { try { v.currentTime = 0.05; } catch (e) { /* ignore */ } } });
      v.src = url;
      c.art.insertBefore(v, c.art.children[1]);
      c.vid = v;
      c.youT.textContent = m.kind === 'video' ? 'Your video' : 'You · preview';
      CARDV.src[id] = { key: key, url: url };
      cardVideoPlay(id);
    });
  }
  function cardVideoPlay(id) {
    var c = sceneBtns[id]; if (!c || !c.vid) return;
    var want = CARD.vis[id] && cardsActive();
    if (want && c.vid.paused) { var pr = c.vid.play(); if (pr && pr.catch) pr.catch(function () { /* autoplay blocked: the poster stays */ }); }
    else if (!want && !c.vid.paused) { try { c.vid.pause(); } catch (e) { /* ignore */ } }
  }

  /* ------------------------------------------------------------------ *
   * Preview sheet: a bigger example of a scene with its sound (built-in track via GlowMusic), before picking it.
   * Story scenes show their shots one after another on the beat. With the user's own video in that scene, the
   * sheet plays that instead (with its own sound).
   * ------------------------------------------------------------------ */
  var PV = { id: null, raf: 0, src: null, gain: null, startAt: 0, muted: false, base: null, video: null, url: null, opener: null, token: 0 };
  function openScenePreview(id, opener) {
    var sc = sceneById(id);
    if (!el.pvSheet) return;
    stopTrackPreview(); stopOwnPreview(); stopScenePreview();
    PV.id = sc.id; PV.opener = opener || null;
    var tok = ++PV.token;
    var m = cardMedia(sc.id);
    el.pvsT.textContent = sc.name + (sc.alt ? ' · ' + sc.alt : '');
    el.pvsLine.textContent = sc.line;
    var tr = trackById(sc.defaultTrack), n = shotCount(sc.length || 5);
    var bits = [];
    if (sc.story) bits.push((sc.length || 20) + ' s · ' + n + ' shots');
    bits.push(sc.audio === 'required' ? (isLocal() ? 'AI song or your own song' : 'AI sound or your own song') : 'Built-in music: ' + (tr ? tr.name + ' (' + tr.bpm + ' BPM)' : 'original'));
    // a singing scene's example plays a built-in track: say it is only a stand-in for the song the video gets
    var sings = sc.audio === 'required' || !!sc.song;
    if (sings && !m && tr) bits.push('Music in this example: ' + tr.name + ', a stand-in — your video gets its own ' + (sc.id === 'club-exit-sing' || sc.id === 'vip-exit' || sc.id === 'spanish' ? 'Spanish party song' : 'song') + ', or your song');
    el.pvsInfo.textContent = bits.join(' · ');
    el.pvsChip.textContent = m ? (m.kind === 'video' ? 'Your latest video' : 'Quick preview of you') : 'Example';
    el.pvsChip.classList.toggle('you', !!m);
    el.pvsNote.textContent = m ? (m.kind === 'video' ? 'This is the last video you made in this scene.' : 'A quick 5-second preview made on this PC — the real video is sharper.') : 'An illustrated example of the scene. Your video shows you, made from your selfie.';
    // shot list (story scenes)
    el.pvsShots.textContent = '';
    var shots = sc.story ? shotsFor(sc, sc.length || 20) : [];
    el.pvsShots.hidden = !shots.length;
    shots.forEach(function (sh, i) {
      var li = document.createElement('li'); li.textContent = sh.title; li.dataset.i = i;
      if (sh.lipSync) { var b = document.createElement('b'); b.textContent = 'sings'; li.appendChild(b); }
      el.pvsShots.appendChild(li);
    });
    PV.muted = false; syncPvMute();
    if (el.pvsDel) el.pvsDel.hidden = !(m && m.kind === 'preview');
    el.pvsUse.textContent = S.sceneId === sc.id ? 'Use this scene ✓' : 'Use this scene';
    openSheet(el.pvSheet, el.pvsUse);
    if (m) {
      el.pvsCanvas.hidden = true;
      var v = el.pvsVideo; v.hidden = false;
      PV.url = URL.createObjectURL(m.blob); v.src = PV.url; v.muted = m.kind !== 'video' || PV.muted; v.loop = true;
      var pr = v.play(); if (pr && pr.catch) pr.catch(function () { /* the user can press play */ });
      PV.video = v;
      if (m.kind !== 'video' && tr) playPvMusic(tr.id, tok); // a silent quick preview: with the scene's track
    } else {
      el.pvsVideo.hidden = true; el.pvsCanvas.hidden = false;
      var cv = el.pvsCanvas, w = Math.round(cv.clientWidth * DPR) || Math.round(300 * DPR), h = Math.round(w * 16 / 9);
      cv.width = w; cv.height = h;
      var base = document.createElement('canvas'); base.width = w; base.height = h; paintScene(base, sc.id);
      PV.base = { id: sc.id, cv: cv, base: base, fx: CARD_FX[sc.id] || ['bob'], col: CARD_COL[sc.id] || '#ff8fd0', bpm: tr ? tr.bpm : 110, seed: seedOf(sc.id) };
      PV.startAt = performance.now();
      if (tr) playPvMusic(tr.id, tok);
      pvLoop(shots);
    }
  }
  function playPvMusic(trackId, tok) {
    var ctx = ensureAudio(); if (!ctx) return;
    getMusic(trackId, 16).then(function (buf) {
      if (tok !== PV.token || el.pvSheet.hidden) return;
      var src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf; src.loop = true; src.connect(g); g.connect(master);
      g.gain.value = PV.muted ? 0 : 0.9;
      var at = ctx.currentTime + 0.05;
      src.start(at);
      PV.src = src; PV.gain = g; PV.audioAt = at;
    }, function () { /* silent example */ });
  }
  function pvClock() {
    // in time with the music when it plays (the shot changes land on its bars), else the page clock
    if (PV.src && actx) return Math.max(0, actx.currentTime - PV.audioAt);
    return (performance.now() - PV.startAt) / 1000;
  }
  function pvLoop(shots) {
    cancelAnimationFrame(PV.raf);
    var c = PV.base, last = -1;
    // story scenes: a different framing of the poster per shot, 2 bars each, with the scene's transition
    var frames = [[1, 0.5, 0.5], [1.28, 0.36, 0.62], [1.55, 0.5, 0.52], [1.2, 0.62, 0.6]];
    var frame = function () {
      if (!PV.base || el.pvSheet.hidden) return;
      var t = REDUCED ? 0 : pvClock(), beat = 60 / c.bpm, x = c.cv.getContext('2d'), W = c.cv.width, H = c.cv.height;
      if (shots.length) {
        var per = beat * 8, k = Math.floor(t / per) % shots.length, lt = t - Math.floor(t / per) * per, f = frames[k % frames.length];
        var tmp = PV.tmp || (PV.tmp = document.createElement('canvas'));
        if (tmp.width !== W) { tmp.width = W; tmp.height = H; }
        drawCard(c, t, tmp);
        x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
        var z = f[0] * (1 + 0.04 * lt / per), sw = W / z, sh = H / z;
        x.drawImage(tmp, clamp(f[1] * W - sw / 2, 0, W - sw), clamp(f[2] * H - sh / 2, 0, H - sh), sw, sh, 0, 0, W, H);
        if (lt < 0.22 && !REDUCED) { x.save(); x.globalCompositeOperation = 'lighter'; x.fillStyle = 'rgba(255,255,255,' + (0.7 * Math.pow(1 - lt / 0.22, 2)) + ')'; x.fillRect(0, 0, W, H); x.restore(); }
        if (k !== last) {
          last = k;
          Array.prototype.forEach.call(el.pvsShots.children, function (li, i) { li.classList.toggle('on', i === k); });
          el.pvsCap.textContent = (k + 1) + ' / ' + shots.length + ' · ' + shots[k].title + (shots[k].lyric ? '\n♪ ' + shots[k].lyric.line : '');
        }
      } else { drawCard(c, t); el.pvsCap.textContent = ''; }
      el.pvsCap.hidden = !shots.length;
      if (!REDUCED) PV.raf = requestAnimationFrame(frame);
    };
    frame();
  }
  function syncPvMute() {
    el.pvsMute.setAttribute('aria-pressed', PV.muted ? 'true' : 'false');
    el.pvsMute.setAttribute('aria-label', PV.muted ? 'Turn the sound on' : 'Mute');
    if (PV.gain && actx) { try { PV.gain.gain.setTargetAtTime(PV.muted ? 0 : 0.9, actx.currentTime, 0.02); } catch (e) { PV.gain.gain.value = PV.muted ? 0 : 0.9; } }
    if (PV.video && !PV.src) PV.video.muted = PV.muted;
  }
  function stopScenePreview() {
    cancelAnimationFrame(PV.raf); PV.raf = 0;
    if (PV.src) { try { PV.src.stop(); } catch (e) { /* ignore */ } try { PV.src.disconnect(); } catch (e) { /* ignore */ } }
    PV.src = null; PV.gain = null; PV.base = null;
    if (PV.video) { try { PV.video.pause(); } catch (e) { /* ignore */ } PV.video.removeAttribute('src'); try { PV.video.load(); } catch (e) { /* ignore */ } PV.video = null; }
    if (PV.url) { URL.revokeObjectURL(PV.url); PV.url = null; }
  }
  function closeScenePreview() {
    PV.token++;
    stopScenePreview();
    if (el.pvSheet && !el.pvSheet.hidden) closeSheet(el.pvSheet);
  }
  function sceneCols() {
    var a = el.scenes.children[0], b = el.scenes.children[1];
    if (!a || !b) return 1;
    var n = 1, top = a.offsetTop;
    for (var i = 1; i < el.scenes.children.length && el.scenes.children[i].offsetTop === top; i++) n++;
    return n;
  }
  function sceneKeys(e, i) {
    var cols = sceneCols(), n = SCENES.length, j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'ArrowDown') j = Math.min(n - 1, i + cols);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - cols);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j < 0) return;
    e.preventDefault();
    selectScene(SCENES[j].id, { user: true });
    sceneBtns[SCENES[j].id].btn.focus();
  }
  function selectScene(id, opts) {
    var sc = sceneById(id);
    S.sceneId = sc.id;
    if (trackById(sc.defaultTrack)) S.trackId = sc.defaultTrack;
    S.duration = fitLen(sc); // a length the user picked stays picked (where this scene and engine have it)
    if (S.userSound === 'own') S.sound = 'own'; // my song works for every scene
    else if (sc.audio === 'required') S.sound = 'ai';
    else if (S.userSound) S.sound = S.userSound;
    else S.sound = sc.audio === 'recommended' ? 'ai' : 'music';
    if (opts && opts.user) stopTrackPreview();
    savePrefs();
    updateAll();
    if (opts && opts.user && mode() === 'ai') {
      el.targetName.classList.remove('flip'); void el.targetName.offsetWidth; el.targetName.classList.add('flip');
    }
  }
  function updateSceneUI() {
    var needHost = GUEST && LOC.s && !singingOk();
    SCENES.forEach(function (sc) {
      var on = sc.id === S.sceneId, b = sceneBtns[sc.id].btn;
      // a friend's page: the singing scenes need the host's Singing add-on
      var off = !!needHost && sc.audio === 'required', w = sceneBtns[sc.id];
      if (w.wrap.classList.contains('needs') !== off) {
        w.wrap.classList.toggle('needs', off);
        // (in the card's text, in place of the scene's one-liner: it never covers the scene's name)
        if (off && !w.need) { w.need = document.createElement('span'); w.need.className = 'ai-scene-need'; (w.art.querySelector('.ai-scene-txt') || w.art).appendChild(w.need); }
        if (w.need) {
          w.need.hidden = !off; w.need.textContent = '';
          if (off) { w.need.appendChild(document.createTextNode('Needs ' + guestHostName() + '’s Singing ')); var ao = document.createElement('span'); ao.className = 'nowrap'; ao.textContent = 'add-on'; w.need.appendChild(ao); }
        }
      }
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      sceneBtns[sc.id].pv.tabIndex = on ? 0 : -1; // Tab goes from the chosen scene to its Preview
    });
    var sc = sceneById(S.sceneId);
    el.targetName.textContent = sc.name;
    paintTarget();
  }
  var targetPainted = '';
  function paintTarget() {
    if (targetPainted === S.sceneId) return;
    targetPainted = S.sceneId;
    var c = el.target;
    var w = Math.round(240 * DPR), h = Math.round(320 * DPR);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    paintScene(c, S.sceneId);
  }

  /* ------------------------------------------------------------------ *
   * Sound, tracks, length, cost
   * ------------------------------------------------------------------ */
  var ICON_PLAY = '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8c0 .8.9 1.3 1.5.8l10-6.4c.6-.4.6-1.2 0-1.6l-10-6.4C8.9 4.3 8 4.8 8 5.6z"/></svg>';
  var ICON_STOP = '<svg class="i-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
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
      playB.type = 'button'; playB.className = 'track-play'; playB.innerHTML = ICON_PLAY + ICON_STOP;
      playB.setAttribute('aria-label', 'Preview ' + tr.name);
      playB.addEventListener('click', function (e) { e.stopPropagation(); toggleTrackPreview(tr.id); });
      var pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'track-pick';
      var nm = document.createElement('span'); nm.className = 'track-name'; nm.textContent = tr.name;
      var meta = document.createElement('span'); meta.className = 'track-meta'; meta.textContent = tr.genre || 'Original';
      var bpm = document.createElement('span'); bpm.className = 'track-bpm'; bpm.innerHTML = '<i></i>'; bpm.appendChild(document.createTextNode(tr.bpm + ' BPM'));
      pick.appendChild(nm); pick.appendChild(meta); pick.appendChild(bpm);
      pick.setAttribute('aria-label', 'Use ' + tr.name + ', ' + (tr.genre || '') + ', ' + tr.bpm + ' BPM');
      pick.addEventListener('click', function () { S.trackId = tr.id; savePrefs(); updateSoundUI(); });
      var eq = document.createElement('span'); eq.className = 'eq'; eq.setAttribute('aria-hidden', 'true'); eq.innerHTML = '<i></i><i></i><i></i>';
      var best = document.createElement('span'); best.className = 'best'; best.textContent = 'Best match'; best.hidden = true; best.setAttribute('aria-hidden', 'true');
      wrap.appendChild(playB); wrap.appendChild(pick); wrap.appendChild(eq); wrap.appendChild(best);
      el.tracks.appendChild(wrap);
      trackCards[tr.id] = { wrap: wrap, play: playB, pick: pick, best: best };
    });
  }
  var tp = { id: null, src: null, token: 0 };
  function stopTrackPreview() {
    if (!tp.id) return;
    var c = trackCards[tp.id];
    tp.token++;
    if (tp.src) { try { tp.src.onended = null; tp.src.stop(); } catch (e) { /* ignore */ } try { tp.src.disconnect(); } catch (e) { /* ignore */ } }
    if (c) { c.play.classList.remove('on', 'busy'); c.play.setAttribute('aria-label', 'Preview ' + (trackById(tp.id) || {}).name); c.wrap.classList.remove('previewing'); }
    tp.src = null; tp.id = null;
  }
  async function toggleTrackPreview(id) {
    if (tp.id === id) { stopTrackPreview(); return; }
    stopTrackPreview();
    var ctx = ensureAudio();
    if (!ctx) { toast('Audio isn’t supported in this browser.', 'error'); return; }
    var token = ++tp.token, c = trackCards[id];
    tp.id = id;
    if (c) c.play.classList.add('busy');
    try {
      var buf = await getMusic(id, 8);
      if (token !== tp.token) return;
      var src = ctx.createBufferSource();
      src.buffer = buf; src.connect(master); src.start();
      src.onended = function () { if (tp.src === src) stopTrackPreview(); };
      tp.src = src;
      if (c) { c.play.classList.remove('busy'); c.play.classList.add('on'); c.wrap.classList.add('previewing'); c.play.setAttribute('aria-label', 'Stop preview of ' + (trackById(id) || {}).name); }
    } catch (e) {
      console.warn('[glow-ai] track preview failed', e);
      if (token === tp.token) { stopTrackPreview(); toast('Couldn’t play that track preview.', 'error'); }
    }
  }

  function renderLengths() {
    el.len.textContent = '';
    ALL_LENGTHS.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.dataset.len = d;
      var bb = document.createElement('b'); bb.textContent = d + ' s';
      var sm = document.createElement('small'); sm.className = 'ai-len-cost';
      b.appendChild(bb); b.appendChild(sm);
      b.addEventListener('click', function () { S.duration = d; S.userLen = d; savePrefs(); fitOwnStart(); updateAll(); });
      el.len.appendChild(b);
    });
  }
  /* Lengths. fal.ai cloud: one scene = one clip of 5 or 10 s; a story scene = 1, 2 or 4 shots (5, 10 or 20 s), one
   * scene photo + one clip each. This PC: every scene can be 1, 2 or 4 shots once the engine can make stories. */
  function storyOk() { return !!(LOC.api && typeof LOC.api.generateStory === 'function'); }
  function lengthsFor(sc, engine) {
    if ((engine || S.engine) === 'local') return storyOk() ? ALL_LENGTHS : [5];
    return sc.story ? ALL_LENGTHS : LENGTHS;
  }
  // The length a scene starts at: a story its 20 s; any other scene its usual length in the cloud, and one quick 5 s
  // shot on this PC as before (a longer video there is the user's own choice, since every extra shot adds minutes).
  function defaultLen(sc, engine) { return sc.story || (engine || S.engine) !== 'local' ? (sc.length || 5) : 5; }
  function fitLen(sc, want) {
    var L = lengthsFor(sc), d = defaultLen(sc), w = want || S.userLen || d;
    if (L.indexOf(w) >= 0) return w;
    if (!want && !S.userLen && L.indexOf(d) >= 0) return d;
    var best = L[0];
    L.forEach(function (x) { if (Math.abs(x - w) < Math.abs(best - w)) best = x; });
    return best;
  }
  // Lip-sync to the chosen song: this PC with the Singing add-on (Wan2.2-S2V), the AI song or the user's own song.
  // fal.ai cloud has no verified audio-driven lip-sync model in this app, so it never offers it.
  function lipsAvailable(sc, sound, engine, dur) {
    if ((engine || S.engine) !== 'local' || !singingOk() || !storyOk()) return false;
    return (sound === 'own' && ownLipsFit(dur || S.duration, true)) || (sound === 'ai' && !!sc.song);
  }
  // My song must last as long as what is lip-synced to it: every shot (4.8 s each, back to back), or a video in
  // which one shot sings (the chorus) — otherwise that shot would have no song under its lips.
  function ownLipsFit(dur, all) {
    var own = S.own; if (!own) return false;
    return own.duration + 1e-3 >= (all ? shotCount(dur) * LIP_SEC + 0.1 : dur - 0.2);
  }
  // The longest length whose every shot can be lip-synced to my song (0 when none)
  function ownLipsLen() { var best = 0; ALL_LENGTHS.forEach(function (d) { if (ownLipsFit(d, true) && d > best) best = d; }); return best; }
  function effSync(sc, sound, engine) { return S.sync === 'lips' && lipsAvailable(sc, sound, engine) ? 'lips' : 'beat'; }
  /* What the next video is, in one place: engine, sound, length, the shots (each with lip-sync or not) and, on this
   * PC, whether it is one clip made the single-clip way (GlowLocalAI.generate) or a story (generateStory). */
  function planFor(sc, o) {
    o = o || {};
    var engine = o.engine || S.engine, sound = o.sound || effSound(sc), dur = o.duration || S.duration;
    var sync = o.sync || effSync(sc, sound, engine), n = shotCount(dur);
    var plan = { sc: sc, engine: engine, sound: sound, duration: dur, sync: sync, n: n, shots: null, lips: 0, local: '' };
    // (a friend's video on the host's PC is always made the story way, 1, 2 or 4 shots: DESIGN a.5)
    var many = GUEST ? true : engine === 'local' ? (sc.story || n > 1 || sync === 'lips') : sc.story;
    if (many) {
      var src = engine === 'local' && singingOk() && ((sound === 'ai' && !!sc.song) || (sound === 'own' && ownLipsFit(dur, sync === 'lips')));
      plan.shots = shotsFor(sc, dur).map(function (sh) {
        var lip = !!src && (sync === 'lips' || (!!sh.lipSync && (sc.story || sound === 'ai')));
        if (lip) plan.lips++;
        return { shot: sh, lip: lip };
      });
    }
    if (engine === 'local' && plan.shots && !storyOk()) {
      // an engine without stories: one shot, made the single-clip way (the AI song can still be lip-synced there)
      plan.shots = plan.shots.slice(0, 1);
      if (plan.shots[0].lip && sound !== 'ai') { plan.shots[0] = { shot: plan.shots[0].shot, lip: false }; }
      plan.lips = plan.shots[0].lip ? 1 : 0;
    }
    if (engine === 'local') {
      // one clip without the user's song under its lips is made the proven single-clip way (works without stories)
      var one = !GUEST && (!plan.shots || (plan.shots.length === 1 && !(plan.shots[0].lip && sound === 'own')));
      plan.local = one ? 'single' : 'story';
      if (one && plan.shots) plan.single = plan.shots[0];
    }
    plan.quality = engine === 'local' && (sound === 'ai' || plan.lips) ? 'best' : S.quality;
    return plan;
  }
  // Minutes on this PC for a plan: the engine's own estimate (stories: estimateStory), else the spec's numbers.
  function localRange(plan) {
    var m = null;
    if (plan.local === 'story') {
      var shots = plan.shots.map(function (x) { return { id: x.shot.id, lipSync: x.lip }; });
      var o = { shots: shots, quality: plan.quality, song: plan.sound === 'ai', lipSync: plan.lips };
      try { m = LOC.api.estimateStory(o).minutes; } catch (e) { m = null; }
      if (!validRange(m)) { try { m = LOC.api.estimateStory({ shots: shots.length, quality: plan.quality, song: plan.sound === 'ai', lipSync: plan.lips }).minutes; } catch (e) { m = null; } }
      if (!validRange(m)) {
        // still + clip: Best about 6–9½ min, Fast 3–5; a lip-synced shot 6–9; the song 1–2 (RTX 5060, from the spec)
        var lo = 0, hi = 0;
        plan.shots.forEach(function (x) { var r = x.lip ? [6, 9] : plan.quality === 'fast' ? [3, 5] : [6, 9.5]; lo += r[0]; hi += r[1]; });
        if (plan.sound === 'ai') { lo += 1; hi += 2; }
        m = [Math.round(lo), Math.round(hi)];
      }
      return m;
    }
    m = [5, 8];
    try { m = LOC.api.estimate({ quality: plan.quality, singing: plan.sound === 'ai' && !!plan.sc.song }).minutes; } catch (e) { /* defaults */ }
    return m;
  }
  function validRange(m) { return Array.isArray(m) && m.length === 2 && m[0] > 0 && m[1] >= m[0] && m[1] < 600; }
  function rangeText(m) { return 'about ' + half(m[0]) + '–' + half(m[1]) + ' min'; }
  function falCost(sc, sound, dur) {
    if (sc.story) return shotCount(dur) * (PRICE.still + (sound === 'ai' ? PRICE.ai : PRICE.std) * SHOT_SEC);
    return estimate(sound, dur);
  }
  function setSound(s, user) {
    var sc = sceneById(S.sceneId);
    if (s === 'own') {
      S.sound = 'own';
      if (user) S.userSound = 'own';
      stopTrackPreview();
      savePrefs(); updateAll();
      if (!S.own && user) openOwnPicker();
      return;
    }
    if (sc.audio === 'required' && s !== 'ai') {
      toast(sc.name + ' needs AI sound for the singing (or your own song).', 'warn');
      return;
    }
    if (isLocal() && s === 'ai' && !sc.song) {
      toast('On ' + PCN + ', AI sound is the Singing add-on’s song, so it’s only for the singing scenes. This scene uses built-in music or your own song.', 'info', 5500);
      return;
    }
    S.sound = s === 'ai' ? 'ai' : 'music';
    if (user) S.userSound = S.sound;
    if (S.sound === 'ai') stopTrackPreview();
    stopOwnPreview();
    savePrefs();
    updateAll();
  }
  function updateSoundUI() {
    var sc = sceneById(S.sceneId), req = sc.audio === 'required', local = isLocal();
    var sound = effSound(sc);
    // On this PC "AI sound" is the Singing add-on's song (and the lip-sync), so only the singing scenes have it.
    var aiOff = local && !sc.song;
    Array.prototype.forEach.call(el.sound.querySelectorAll('.ai-snd'), function (b) {
      var kind = b.getAttribute('data-sound'), on = kind === sound;
      var off = kind === 'music' ? req : kind === 'ai' ? aiOff : false;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('locked', off);
      b.setAttribute('aria-disabled', off ? 'true' : 'false');
      if (kind === 'ai') {
        var t = b.querySelector('.ai-snd-t b'), sm = b.querySelector('.ai-snd-t small'), tag = b.querySelector('.ai-snd-tag');
        if (t) t.textContent = local ? 'AI song' : 'AI sound';
        if (sm) sm.textContent = local ? (sc.song ? 'Sing in Spanish' : 'Singing scenes') : 'Crowd & singing';
        if (tag) tag.textContent = local ? (singingOk() ? 'Free' : 'Add-on') : 'Premium';
      } else if (kind === 'own') {
        var sm2 = b.querySelector('.ai-snd-t small');
        if (sm2) sm2.textContent = S.own ? S.own.name : 'Upload a song';
      }
    });
    el.soundLock.hidden = !aiOff || sound === 'own';
    el.soundLock.className = 'ai-lock soft';
    if (aiOff) el.soundLock.textContent = 'On ' + PCN + ', AI sound means an AI-made song, so it’s only for the singing scenes. Built-in music and your own song work for every scene.';
    var music = sound === 'music';
    el.music.hidden = !music;
    el.aiNote.hidden = sound !== 'ai';
    if (el.own) el.own.hidden = sound !== 'own';
    if (sound === 'own') renderOwn();
    el.aiNote.classList.toggle('req', req || (local && !singingOk()));
    // (rebuilt only when it changes, so a button in it keeps its focus while the engine status refreshes)
    var noteKey = [local, singingOk(), sc.id, sound, req, S.duration].join('|');
    if (sound === 'ai' && el.aiNote.dataset.k !== noteKey) {
      el.aiNote.dataset.k = noteKey;
      el.aiNote.innerHTML = '';
      var b = document.createElement('b');
      if (GUEST && !singingOk()) {
        b.textContent = 'Needs ' + guestHostName() + '’s Singing add-on.';
        el.aiNote.appendChild(b);
        el.aiNote.appendChild(document.createTextNode(' The AI song is made by an add-on that isn’t installed on ' + PCN + '. Pick “My song” to use your own music, or another scene.'));
      } else if (local && !singingOk()) {
        b.textContent = 'Needs the Singing add-on (free).';
        el.aiNote.appendChild(b);
        el.aiNote.appendChild(document.createTextNode(' It writes a short Spanish party song and makes you sing it, all on this PC: a one-time download of ' + singingSize() + ', then ' + localMinutes('ai', 'best') + ' per singing video. Or use your own song, or fal.ai cloud for this scene.'));
        var acts = document.createElement('span'); acts.className = 'ai-note-acts';
        var go = document.createElement('a'); go.className = 'btn glass ai-note-btn'; go.href = SETUP_URL.singing; go.textContent = 'Set up the Singing add-on';
        var alt = document.createElement('button'); alt.type = 'button'; alt.className = 'btn text ai-note-btn'; alt.textContent = 'Use fal.ai cloud';
        alt.addEventListener('click', function () { chooseEngine('fal', true); });
        acts.appendChild(go); acts.appendChild(alt);
        el.aiNote.appendChild(acts);
      } else if (local) {
        b.textContent = 'AI song, made on ' + PCN + '.';
        el.aiNote.appendChild(b);
        el.aiNote.appendChild(document.createTextNode(sc.story
          ? ' The free AI writes an original Spanish song for this scene; you sing the chorus in sync, and the song plays under the whole video. It takes a few minutes longer.'
          : ' The free AI writes a short Spanish party song and makes you sing it. Lip-sync is approximate (one singer), and it takes a few minutes longer.'));
      } else {
        var what = sc.lyrics || (sc.shots && sc.shots.some(function (x) { return x.lyric; })) ? 'singing' + (sc.id === 'spanish' || sc.id === 'club-exit-sing' || sc.id === 'vip-exit' ? ' in Spanish' : '') + ', friends and the room' : 'music, the crowd and the room';
        var spanish = sc.id === 'spanish' || sc.id === 'club-exit-sing' || sc.id === 'vip-exit';
        b.textContent = req ? (sc.alt || sc.name) + ' needs AI sound.' : 'Real sound, made with the video.';
        el.aiNote.appendChild(b);
        el.aiNote.appendChild(document.createTextNode((req ? ' So the video can really sing' + (spanish ? ' in Spanish' : '') + ', the' : ' The') +
          ' video model creates the ' + what + ' together with the picture' + (/singing/.test(what) ? ', with lips matched to the singing.' : '.') +
          (req ? ' Or pick “My song” to use your own music.' : '')));
        // a cloud story is several clips made one by one: each brings its own sound
        if (sc.story && shotCount(S.duration) > 1) {
          var each = document.createElement('span'); each.className = 'ai-note-each';
          each.textContent = ' Each 5 s shot gets its own AI ' + (/singing/.test(what) ? 'singing' : 'sound') + ', so the ' + (/singing/.test(what) ? 'song changes' : 'sound changes') + ' from shot to shot. For one song across all ' + S.duration + ' s, pick “My song”' + (LOC.inApp ? ', or make it free on this PC' : '') + '.';
          el.aiNote.appendChild(each);
        }
      }
    }
    if (sound !== 'ai') el.aiNote.dataset.k = '';
    if (local) el.soundHint.textContent = sound === 'own' ? 'Your own song' : music ? 'Music is free' : (singingOk() ? 'Free on ' + PCN : GUEST ? 'Needs an add-on' : 'Needs a free add-on');
    else el.soundHint.textContent = sound === 'own' ? 'Your own song' : music ? 'Music is free' : (sc.audio === 'required' ? 'Required for this scene' : (sc.audio === 'recommended' ? 'Recommended' : 'Premium'));
    Object.keys(trackCards).forEach(function (id) {
      var c = trackCards[id], sel = id === S.trackId;
      c.wrap.classList.toggle('sel', sel);
      c.pick.setAttribute('aria-pressed', sel ? 'true' : 'false');
      c.best.hidden = id !== sc.defaultTrack;
    });
    renderSync(sc, sound);
    // Length (1, 2 or 4 shots) with the price (cloud) or the time (this PC) under each choice
    var L = lengthsFor(sc);
    if (L.indexOf(S.duration) < 0) S.duration = fitLen(sc);
    fitOwnStart();
    if (el.lenGroup) el.lenGroup.hidden = L.length < 2;
    Array.prototype.forEach.call(el.len.children, function (b) {
      var d = +b.dataset.len, avail = L.indexOf(d) >= 0;
      b.hidden = !avail;
      b.setAttribute('aria-pressed', d === S.duration ? 'true' : 'false');
      if (!avail) return;
      var n = shotCount(d), multi = local ? n > 1 || sc.story : sc.story;
      var t = local ? rangeText(localRange(planFor(sc, { duration: d, sound: sound }))) : 'about ' + money(falCost(sc, sound, d));
      b.querySelector('.ai-len-cost').textContent = t;
      b.setAttribute('aria-label', d + ' seconds' + (multi && n > 1 ? ', ' + n + ' shots' : '') + ', ' + t + (local ? ' on ' + PCN : ''));
    });
    el.len.className = 'seg ' + (L.length === 3 ? 'seg-3' : 'seg-2');
    // Quality (this PC). A singing or lip-synced video has one speed: the lip-sync step decides, so Best/Fast would read the same.
    var plan = planFor(sc, { sound: sound });
    if (el.qualGroup) el.qualGroup.hidden = !local || sound === 'ai' || plan.lips > 0;
    if (local) {
      var fastPack = localPack('fast');
      Array.prototype.forEach.call(el.qual.querySelectorAll('.opt'), function (b) {
        var q = b.getAttribute('data-quality'), saved = S.quality;
        S.quality = q; var m = rangeText(localRange(planFor(sc, { sound: sound }))); S.quality = saved;
        b.setAttribute('aria-pressed', q === S.quality ? 'true' : 'false');
        b.querySelector('.ai-len-cost').textContent = m;
        b.setAttribute('aria-label', (q === 'fast' ? 'Fast' : 'Best') + ' quality, ' + m);
      });
      el.qualNote.textContent = S.quality === 'fast'
        ? (fastPack ? 'Fast uses a lighter photo step and a smaller video. Your face can look a little less like you.' : GUEST ? 'Fast makes a smaller video.' : 'Fast makes a smaller video. Add “Fast mode” (free) in Free AI on this PC for a quicker photo step too.')
        : 'Best keeps your face most like you. Every shot is about 5 seconds.';
    }
    var k1, k2, k3, n2 = plan.shots ? plan.shots.length : 1, shotsTxt = n2 > 1 ? n2 + ' shots, each from your selfie · ' : '';
    if (local) {
      k1 = 'Made on ' + PCN;
      k2 = sound === 'ai' ? 'Free · song by ACE-Step, singing by Wan 2.2' : plan.lips ? 'Free · video & lip-sync by Wan 2.2 + your song' : 'Free · video by Wan 2.2 + ' + (sound === 'own' ? 'your song' : 'your music');
      k3 = shotsTxt + 'Scene photo by ' + (plan.quality === 'fast' && localPack('fast') ? 'FLUX.2 klein' : 'Qwen Image Edit') + ' · finished at 720×1248';
    } else {
      k1 = 'Video model';
      k2 = sound === 'ai' ? 'Premium · ' + MODEL_NAME[EP.ai] + ' with native sound' : 'Standard · ' + MODEL_NAME[EP.std] + ' (silent) + ' + (sound === 'own' ? 'your song' : 'your music');
      k3 = shotsTxt + 'Scene photo by ' + MODEL_NAME[EP.still];
    }
    el.tier.innerHTML = '';
    var t1 = document.createElement('span'); t1.className = 'ai-tier-k'; t1.textContent = k1;
    var t2 = document.createElement('span'); t2.textContent = k2;
    var t3 = document.createElement('span'); t3.className = 'ai-tier-s'; t3.textContent = k3;
    el.tier.appendChild(t1); el.tier.appendChild(t2); el.tier.appendChild(t3);
  }
  function soundName(sound) { return sound === 'ai' ? (isLocal() ? 'AI song' : 'AI sound') : sound === 'own' ? 'Your song' : 'Built-in music'; }
  // "10 s · AI sound · about $1.55" / "20 s · 4 shots · Built-in music · about $2.28": what the next run makes and costs.
  function costLine(sound, dur, sc) {
    sc = sc || sceneById(S.sceneId);
    var n = sc.story ? shotCount(dur) : 1;
    return dur + ' s · ' + (n > 1 ? n + ' shots · ' : '') + soundName(sound) + ' · about ' + money(falCost(sc, sound, dur));
  }
  function pausedJob() { return S.retryJob && S.retryJob.resume ? S.retryJob.resume : null; }
  function updateCost() {
    var sc = sceneById(S.sceneId), sound = effSound(sc);
    var main = 'Make my video', sub;
    if (running()) { main = 'See progress'; sub = 'Making your video · ' + (UI.pct || 0) + '%'; }
    else if (isLocal()) { var c = localCta(sound); main = c.main; sub = c.sub; }
    else if (pausedJob()) { main = 'Finish my video'; sub = pausedJob().story ? storyRetryLine(pausedJob()) : 'Already paid for — no extra cost'; }
    else sub = costLine(sound, S.duration, sc) + ' from your fal.ai credit';
    if (sound === 'own' && !S.own && !running() && !pausedJob() && !(isLocal() && (LOC.retry || LOC.resume))) { main = 'Choose your song'; sub = 'Pick a song file first — or another sound'; }
    if (el.makeT) el.makeT.textContent = main;
    el.cost.textContent = sub;
    el.make.classList.toggle('idle', !S.photo && !running() && !pausedJob() && !(isLocal() && (LOC.retry || LOC.resume)));
    el.make.setAttribute('aria-describedby', 'aiCost');
    if (el.connRange) el.connRange.textContent = money(estimate('music', LENGTHS[0])) + '–' + money(falMax()) + ' (5–20 s)';
    if (el.conn && !el.conn.hidden && connectThen === 'make') el.keySave.textContent = 'Save & make my video · ' + money(falCost(sc, sound, S.duration));
  }
  function updateAll() { updateSceneUI(); updateSoundUI(); updateCost(); renderSee(); }
  function savePrefs() { lsSet(LS.prefs, JSON.stringify({ sceneId: S.sceneId, sound: S.sound, userSound: S.userSound, userLen: S.userLen, trackId: S.trackId, duration: S.duration, quality: S.quality, sync: S.sync })); }

  /* ------------------------------------------------------------------ *
   * My song: the user's own audio file as the soundtrack (both engines, every scene)
   *
   * MP3, M4A, WAV or OGG up to 20 MB, decoded with decodeAudioData and analysed with GlowBeat. A waveform shows the
   * part that plays (as long as the video); drag it or use the arrow keys to choose where it starts (it snaps to a
   * downbeat). The file stays on this device (IndexedDB, so a video finishing after a reload still has it) and is only
   * ever sent to this PC's own AI engine when a shot is lip-synced to it. Only music the user has the rights to.
   * ------------------------------------------------------------------ */
  var OWN_MAX = 20 * 1024 * 1024, OWN_TYPES = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|wav|x-wav|wave|vnd\.wave|ogg|webm|flac|x-flac)$/i, OWN_EXT = /\.(mp3|m4a|aac|mp4|wav|wave|ogg|oga|opus|webm|flac)$/i;
  var OWN = { loading: false, src: null, raf: 0, playAt: 0, playFrom: 0, drag: null, seq: 0 };
  var xdbP = null;
  // a second, small database for the user's song and the scene previews (separate from "My AI videos")
  function xdb() {
    if (xdbP) return xdbP;
    xdbP = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
      var r;
      try { r = window.indexedDB.open('glow-ai-extra', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () { var d = r.result; ['sounds', 'previews'].forEach(function (n) { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); }); };
      r.onsuccess = function () { var d = r.result; d.onversionchange = function () { try { d.close(); } catch (e) { /* ignore */ } xdbP = null; }; res(d); };
      r.onerror = function () { rej(r.error || new Error('indexedDB error')); };
      r.onblocked = function () { rej(new Error('indexedDB blocked')); };
    });
    xdbP.catch(function () { xdbP = null; });
    return xdbP;
  }
  function xidb(store, mode, fn) {
    return xdb().then(function (d) {
      return new Promise(function (res, rej) {
        var tx, out;
        try { tx = d.transaction(store, mode); } catch (e) { rej(e); return; }
        var req = fn(tx.objectStore(store));
        if (req) req.onsuccess = function () { out = req.result; };
        tx.oncomplete = function () { res(out); };
        tx.onerror = function () { rej(tx.error || new Error('tx error')); };
        tx.onabort = function () { rej(tx.error || new Error('tx aborted')); };
      });
    });
  }
  function openOwnPicker() { if (!el.ownFile) return; try { el.ownFile.value = ''; } catch (e) { /* ignore */ } el.ownFile.click(); }
  function ownId(f) { return [f.name || 'song', f.size || 0, f.lastModified || 0].join('|'); }
  function looksLikeAudio(f) { return OWN_TYPES.test(f.type || '') || OWN_EXT.test(f.name || ''); }
  async function loadOwnFile(file, restore) {
    if (!file) return;
    if (!restore) {
      if (!looksLikeAudio(file)) { toast('That file doesn’t look like a song. Use an MP3, M4A, WAV or OGG file.', 'warn', 5000); return; }
      if (file.size > OWN_MAX) { toast('That song file is ' + fmtBytes(file.size) + ' — please use one up to 20 MB (an MP3 or M4A is much smaller than a WAV).', 'warn', 6500); return; }
      if (running() && RUN.job && RUN.job.sound === 'own') { toast('Your video is being made with the current song — change it when it’s done.', 'warn'); return; }
    }
    var ctx = ensureAudio();
    if (!ctx) { toast('Audio isn’t supported in this browser.', 'error'); return; }
    var seq = ++OWN.seq;
    OWN.loading = true; stopOwnPreview();
    if (!restore) setOwnStatus('Opening your song…');
    renderOwn();
    try {
      var buf = await decodeAudio(ctx, file);
      if (seq !== OWN.seq) return;
      if (!(buf.duration > 1.5)) { var se = new Error('too short'); se.code = 'short'; se.seconds = buf.duration; throw se; }
      var id = restore ? restore.id : ownId(file);
      var own = { id: id, name: restore ? restore.name : (file.name || 'My song').replace(/\.[a-z0-9]+$/i, ''), size: file.size, type: file.type, blob: file, buffer: buf, duration: buf.duration, start: 0, beat: null, peaks: peaksOf(buf, 720) };
      if (!restore) setOwnStatus('Finding the beat…');
      try { own.beat = window.GlowBeat ? await window.GlowBeat.analyze(buf) : null; } catch (e) { own.beat = null; }
      if (seq !== OWN.seq) return;
      own.start = restore && restore.start != null ? clamp(restore.start, 0, Math.max(0, buf.duration - 1)) : snapStart(liveliest(own, S.duration), own);
      ownPartBeat(own, Math.min(own.start, ownMaxStart(own)));
      S.own = own;
      OWN.loading = false;
      if (!restore) {
        S.sound = 'own'; S.userSound = 'own'; savePrefs();
        setOwnStatus('');
        var pb = ownPartBeat(own, own.start, null, true);
        announce('Your song is ready' + (pb && pb.bpm ? ', about ' + Math.round(pb.bpm) + ' beats per minute' : ''));
        var rec = { id: 'own', key: own.id, name: own.name, size: own.size, type: own.type, start: own.start, blob: file, at: Date.now() };
        xidb('sounds', 'readwrite', function (st) { return st.put(rec); }).catch(function (e) { console.warn('[glow-ai] song not kept on this device', e); });
      }
      updateAll();
    } catch (e) {
      if (seq !== OWN.seq) return;
      console.warn('[glow-ai] song decode failed', e);
      OWN.loading = false;
      setOwnStatus('');
      if (!restore) {
        if (e && e.code === 'short') toast('That song is only ' + Math.max(0.1, Math.round((e.seconds || 0) * 10) / 10) + ' s long — pick a song of at least a few seconds.', 'warn', 6000);
        else toast('That song couldn’t be opened in this browser. Try an MP3 or M4A file.', 'warn', 6000);
      }
      renderOwn();
    }
  }
  function saveOwnStart() {
    if (!S.own) return;
    xidb('sounds', 'readwrite', function (st) {
      var g = st.get('own');
      g.onsuccess = function () { var r = g.result; if (r && r.key === S.own.id) { r.start = S.own.start; st.put(r); } };
      return null;
    }).catch(function () { /* in memory only */ });
  }
  function removeOwn() {
    stopOwnPreview();
    S.own = null; OWN.seq++;
    if (S.sound === 'own') { S.sound = 'music'; S.userSound = null; }
    savePrefs();
    xidb('sounds', 'readwrite', function (st) { return st.delete('own'); }).catch(function () { /* ignore */ });
    updateAll();
    toast('Your song was removed from this device.', 'ok', 2500);
  }
  // Restore the song kept on this device (for "My song" as the chosen sound, or a video still to be finished with it)
  function restoreOwn() {
    return xidb('sounds', 'readonly', function (st) { return st.get('own'); }).then(function (r) {
      if (!r || !(r.blob instanceof Blob) || S.own) return;
      return loadOwnFile(r.blob, { id: r.key, name: r.name, start: r.start });
    }).catch(function () { /* nothing kept */ });
  }
  function peaksOf(buf, n) {
    var chs = buf.numberOfChannels, len = buf.length, step = Math.max(1, Math.floor(len / n)), out = new Float32Array(n), data = [];
    for (var c = 0; c < chs; c++) data.push(buf.getChannelData(c));
    var mx = 0;
    for (var i = 0; i < n; i++) {
      var a = i * step, b = Math.min(len, a + step), p = 0;
      for (var k = 0; k < data.length; k++) { var d = data[k]; for (var j = a; j < b; j += 4) { var v = d[j] < 0 ? -d[j] : d[j]; if (v > p) p = v; } }
      out[i] = p; if (p > mx) mx = p;
    }
    if (mx > 0) for (var q = 0; q < n; q++) out[q] /= mx;
    return out;
  }
  // The liveliest part of the song as long as the video (where its beats are loudest), starting on a downbeat.
  function liveliest(own, len) {
    var b = own.beat, dur = own.duration;
    if (dur <= len + 0.5) return 0;
    if (!b || !b.downbeats || !b.downbeats.length) return 0;
    var best = null, bs = -1;
    b.downbeats.forEach(function (d) {
      if (d + len > dur) return;
      var e = 0, c = 0;
      b.beats.forEach(function (t, k) { if (t >= d && t < d + len) { e += b.energy[k] || 0; c++; } });
      var sc = c ? e / c : 0;
      if (sc > bs + 0.02) { bs = sc; best = d; }
    });
    return best == null ? 0 : best;
  }
  // The latest start that still fits the video (the whole song when it is shorter than the video).
  function ownMaxStart(own, dur) { own = own || S.own; return own ? Math.max(0, own.duration - Math.min(dur || S.duration, own.duration)) : 0; }
  /* The beat of the part of my song that plays, analysed on its own (plus a little around it): a song that changes
   * tempo gets that part's tempo, beats and downbeats, not the whole song's (and a start after the first 6 minutes
   * still has beats). About 0.1 s for a 20 s part; cached until the part moves out of the analysed window. Falls back
   * to the whole-song analysis when the part has no steady beat. */
  function ownPartBeat(own, start, len, cachedOnly) {
    own = own || S.own;
    if (!own) return null;
    start = start == null ? own.start : start;
    len = Math.min(len == null ? S.duration : len, own.duration);
    var end = Math.min(own.duration, start + len), p = own.part;
    if (p && p.from <= start + 1e-6 && p.from >= start - 3.5 && p.to >= end - 1e-6 && p.to <= end + 12) return p.beat;
    if (cachedOnly || !own.buffer || !window.GlowBeat || typeof window.GlowBeat.analyzeSync !== 'function') return own.beat;
    var from = Math.max(0, start - 2), to = Math.min(own.duration, Math.max(end + 4, from + 16)), b = null;
    try { b = window.GlowBeat.analyzeSync(own.buffer, { start: from, seconds: to - from }); } catch (e) { b = null; }
    if (!b || !(b.bpm > 0) || !b.beats || b.beats.length < 4) b = own.beat;
    own.part = { from: from, to: to, beat: b };
    return b;
  }
  // A start point on a downbeat of that part (the nearest one; a plain beat only when no downbeat is near), never so
  // late that the song ends before the video does.
  function snapStart(t, own, dur) {
    own = own || S.own; if (!own) return t;
    var maxStart = ownMaxStart(own, dur);
    t = clamp(t, 0, maxStart);
    var b = ownPartBeat(own, t, dur);
    if (b && b.beats && b.beats.length) {
      var near = function (list) { var best = null; (list || []).forEach(function (x) { if (x <= maxStart + 1e-6 && x >= -1e-6 && (best === null || Math.abs(x - t) < Math.abs(best - t))) best = x; }); return best; };
      var d = near(b.downbeats), bt = near(b.beats), beatSec = b.bpm > 0 ? 60 / b.bpm : 0.5;
      // (at the very end: the last bar that still fits, even when a plain beat would be a little later)
      var lim = t >= maxStart - 0.01 ? Math.max(1.2, beatSec * 4.2) : Math.max(1.2, beatSec * 2.2);
      if (d !== null && Math.abs(d - t) <= lim) t = d;
      else if (bt !== null && Math.abs(bt - t) < 1.2) t = bt;
    }
    return Math.round(t * 1000) / 1000;
  }
  function setOwnStart(t, snap) {
    if (!S.own) return;
    S.own.start = snap ? snapStart(t) : clamp(t, 0, ownMaxStart());
    drawWave(); renderOwnText();
    if (OWN.src) playOwnPart(); // keep hearing it from the new start
  }
  // After the video length changed: the chosen part must still fit in the song (it keeps its place when it does).
  function fitOwnStart() {
    if (!S.own || OWN.drag) return;
    if (S.own.start > ownMaxStart() + 1e-3) { setOwnStart(S.own.start, true); saveOwnStart(); }
  }
  // The part of my song a new video uses: where it starts (clamped to fit the video) and that part's beat.
  function ownForJob(dur) {
    var own = S.own; if (!own) return null;
    var st = Math.min(own.start, ownMaxStart(own, dur));
    return { id: own.id, name: own.name, start: Math.round(st * 1000) / 1000 };
  }
  // The next/previous downbeat (the arrow keys move the start by whole bars): from the analysis of the part that plays
  // now while the target is inside it (so the bars stay the ones shown), else from an analysis around the target.
  function stepOwnStart(dir, bars) {
    var own = S.own; if (!own) return 0;
    var t = own.start, max = ownMaxStart(), b = ownPartBeat(own, t), step = b && b.bpm > 0 ? 60 / b.bpm : 0.5;
    var target = clamp(t + dir * bars * 4 * step, 0, max);
    var covers = function (x) { return x && x.downbeats && x.downbeats.length && target >= (x.start || 0) - 1e-6 && target <= (x.start || 0) + (x.seconds || 0) - 0.5; };
    var bb = covers(b) ? b : ownPartBeat(own, target);
    var best = null;
    if (bb && bb.downbeats) bb.downbeats.forEach(function (x) { if ((dir > 0 ? x > t + 0.05 : x < t - 0.05) && x <= max + 1e-6 && x >= -1e-6 && (best === null || Math.abs(x - target) < Math.abs(best - target))) best = x; });
    return best !== null ? best : target;
  }
  function setOwnStatus(t) { if (el.ownSt) el.ownSt.textContent = t || ''; }
  function renderOwn() {
    if (!el.own) return;
    var has = !!S.own;
    el.ownEmpty.hidden = has || OWN.loading;
    el.ownBox.hidden = !has;
    if (OWN.loading && !has) setOwnStatus('Opening your song…');
    if (!has) return;
    el.ownName.textContent = S.own.name;
    renderOwnText();
    drawWave();
  }
  function renderOwnText() {
    var own = S.own; if (!own) return;
    var len = Math.min(S.duration, own.duration), b = ownPartBeat(own, own.start, null, true);
    el.ownMeta.textContent = fmt(own.duration) + (b && b.bpm ? ' · about ' + Math.round(b.bpm) + ' BPM' : '');
    el.ownStart.textContent = 'Plays ' + fmtP(own.start) + '–' + fmtP(own.start + len);
    el.wave.setAttribute('aria-valuemin', '0');
    el.wave.setAttribute('aria-valuemax', String(Math.round(Math.max(0, own.duration - len))));
    el.wave.setAttribute('aria-valuenow', String(Math.round(own.start)));
    el.wave.setAttribute('aria-valuetext', 'Starts at ' + fmtP(own.start) + ', plays ' + Math.round(len) + ' seconds');
    el.ownShort.hidden = own.duration >= S.duration - 0.2;
  }
  function fmtP(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s2 = t - m * 60; return m + ':' + (s2 < 10 ? '0' : '') + s2.toFixed(1); }
  function drawWave(playT) {
    var own = S.own, cv = el.waveCv;
    if (!own || !cv || el.own.hidden) return;
    var w = Math.max(10, Math.round(cv.clientWidth * DPR)), h = Math.max(10, Math.round(cv.clientHeight * DPR));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    var x = cv.getContext('2d'); if (!x) return;
    x.clearRect(0, 0, w, h);
    var dur = own.duration, len = Math.min(S.duration, dur), x0 = own.start / dur * w, x1 = (own.start + len) / dur * w;
    // the chosen part
    var g = x.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, 'rgba(255,79,163,.28)'); g.addColorStop(0.55, 'rgba(164,87,255,.28)'); g.addColorStop(1, 'rgba(34,211,238,.24)');
    x.fillStyle = g; rr(x, x0, 0, Math.max(2, x1 - x0), h, Math.min(10 * DPR, (x1 - x0) / 2)); x.fill();
    // waveform bars
    var n = own.peaks.length, bw = w / n, mid = h / 2;
    for (var i = 0; i < n; i++) {
      var px = i * bw, inSel = px >= x0 && px <= x1, v = Math.max(0.04, own.peaks[i]) * (h * 0.42);
      x.fillStyle = inSel ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.3)';
      x.fillRect(px, mid - v, Math.max(1, bw - (bw > 2 ? 0.6 : 0)), v * 2);
    }
    // bars (downbeats) inside the chosen part
    var wb = ownPartBeat(own, own.start, null, true);
    if (wb && wb.downbeats) {
      x.fillStyle = 'rgba(255,214,107,.85)';
      wb.downbeats.forEach(function (d) { if (d >= own.start - 0.01 && d <= own.start + len) { var bx = d / dur * w; x.fillRect(bx - DPR * 0.75, h - 5 * DPR, 1.5 * DPR, 5 * DPR); } });
    }
    // edges + playhead
    x.fillStyle = '#fff';
    x.fillRect(x0, 0, 2 * DPR, h); x.fillRect(x1 - 2 * DPR, 0, 2 * DPR, h);
    if (playT != null) { var pxh = playT / dur * w; x.fillStyle = '#ffd66b'; x.fillRect(pxh - DPR, 0, 2 * DPR, h); }
  }
  function waveTime(ev) {
    var r = el.waveCv.getBoundingClientRect();
    return clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1) * (S.own ? S.own.duration : 0);
  }
  function stopOwnPreview() {
    cancelAnimationFrame(OWN.raf);
    if (OWN.src) { try { OWN.src.onended = null; OWN.src.stop(); } catch (e) { /* ignore */ } try { OWN.src.disconnect(); } catch (e) { /* ignore */ } }
    OWN.src = null;
    if (el.ownPlay) { el.ownPlay.classList.remove('on'); el.ownPlay.setAttribute('aria-label', 'Play the part of your song that the video uses'); var t = el.ownPlay.querySelector('span'); if (t) t.textContent = 'Play this part'; }
    drawWave();
  }
  function playOwnPart() {
    var own = S.own, ctx = ensureAudio();
    if (!own || !ctx) return;
    if (OWN.src) { try { OWN.src.onended = null; OWN.src.stop(); } catch (e) { /* ignore */ } try { OWN.src.disconnect(); } catch (e) { /* ignore */ } }
    stopTrackPreview(); stopScenePreview();
    var len = Math.min(S.duration, own.duration - own.start), src = ctx.createBufferSource(), g = ctx.createGain(), now = ctx.currentTime;
    src.buffer = own.buffer; src.connect(g); g.connect(master);
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + 0.02);
    g.gain.setValueAtTime(1, now + Math.max(0.05, len - 0.8)); g.gain.linearRampToValueAtTime(0, now + len);
    src.start(now, own.start, len + 0.05);
    src.onended = function () { if (OWN.src === src) stopOwnPreview(); };
    OWN.src = src; OWN.playAt = now; OWN.playFrom = own.start;
    el.ownPlay.classList.add('on'); el.ownPlay.setAttribute('aria-label', 'Stop playing your song'); var t = el.ownPlay.querySelector('span'); if (t) t.textContent = 'Stop';
    cancelAnimationFrame(OWN.raf);
    (function frame() { if (OWN.src !== src) return; drawWave(OWN.playFrom + (ctx.currentTime - OWN.playAt)); OWN.raf = requestAnimationFrame(frame); })();
  }
  /* "Sync to the song": Dance to the beat (every scene, both engines) | Lip-sync to the song (this PC + Singing add-on) */
  function renderSync(sc, sound) {
    if (!el.syncGroup) return;
    var local = isLocal();
    if (sound === 'ai' && !local) { el.syncGroup.hidden = true; return; }
    el.syncGroup.hidden = false;
    var lipsOk = lipsAvailable(sc, sound), allLip = local && sound === 'ai' && !!sc.song && !sc.story;
    // my song is too short to lip-sync every shot of this length: the choice stays, greyed out, with the reason
    var lipsShort = local && sound === 'own' && !!S.own && singingOk() && storyOk() && !lipsOk;
    var sync = effSync(sc, sound);
    var showSeg = (lipsOk || lipsShort) && !allLip;
    el.syncSeg.hidden = !showSeg;
    // (with nothing to choose, the line below is just a hint: no heading over an empty space)
    if (el.syncL) el.syncL.hidden = !showSeg;
    el.syncGroup.classList.toggle('ai-sync-hint', !showSeg);
    // singing scenes say what you get: one shot sings the chorus, or every shot sings
    var chorus = showSeg && planFor(sc, { sound: sound, sync: 'beat' }).lips > 0;
    Array.prototype.forEach.call(el.syncSeg.querySelectorAll('.opt'), function (b) {
      var k = b.getAttribute('data-sync'), off = k === 'lips' && lipsShort;
      b.setAttribute('aria-pressed', k === sync ? 'true' : 'false');
      b.setAttribute('aria-disabled', off ? 'true' : 'false');
      b.classList.toggle('locked', off);
      var bb = b.querySelector('b');
      if (bb) bb.textContent = k === 'lips' ? (chorus ? 'Sing every shot' : 'Lip-sync to the song') : (chorus ? 'Sing the chorus' : 'Dance to the beat');
      var sm = b.querySelector('small');
      if (!sm) return;
      if (off) sm.textContent = 'Song too short';
      else if (lipsOk) sm.textContent = rangeText(localRange(planFor(sc, { sound: sound, sync: k === 'lips' ? 'lips' : 'beat' })));
      else sm.textContent = '';
    });
    var t = '', tr = trackById(S.trackId), b2 = S.own ? ownPartBeat(S.own, Math.min(S.own.start, ownMaxStart()), S.duration) : null;
    if (sync === 'lips') {
      // the time per shot, from the engine's own estimate for this plan (about 5½–8½ min on an RTX 5060)
      var lp = planFor(sc, { sound: sound, sync: 'lips' }), lm = localRange(lp), k = Math.max(1, lp.shots ? lp.shots.length : 1);
      var per0 = Math.max(0.5, Math.round(lm[0] / k * 2) / 2), per1 = Math.max(per0 + 0.5, Math.round(lm[1] / k * 2) / 2);
      t = 'Every shot is lip-synced to the song, one after another from ' + (sound === 'own' && S.own ? fmtP(Math.min(S.own.start, ownMaxStart())) : 'its start') + ' — slow but fun: each 5 s shot takes about ' + half(per0) + '–' + half(per1) + ' min on ' + PCN + '.';
    }
    else if (allLip) t = 'Every shot sings the song in sync (lip-sync), and the cuts follow its beat.';
    else if (sound === 'music') t = tr ? 'Moves and cuts follow the beat of ' + tr.name + ' (' + tr.bpm + ' BPM).' : 'Moves and cuts follow the beat.';
    else if (sound === 'own') t = !S.own ? 'Moves and cuts will follow your song’s beat.' : b2 && b2.bpm ? 'Moves and cuts follow your song’s beat (about ' + Math.round(b2.bpm) + ' BPM).' : 'No steady beat found in your song — the shots are simply cut one after another.';
    else if (sound === 'ai') t = sc.story ? 'Cuts follow the song’s beat, and you sing the chorus in sync.' : 'Cuts follow the song’s beat.';
    if (chorus && sync !== 'lips') t = (sound === 'own' ? 'One shot sings the chorus of your song in sync; the others dance to its beat.' : 'One shot sings the chorus in sync; the others dance to the song’s beat.');
    if (lipsShort) t += ' ' + ownShortText();
    if (local && sync !== 'lips' && !allLip && !lipsShort && (sound === 'own' || (sound === 'ai' && sc.song)) && !lipsOk) {
      t += !singingOk() ? ' Lip-sync to the song needs the free Singing add-on.' : !storyOk() ? ' Lip-sync to your song needs the latest Glow Studio app.' : '';
    }
    el.syncNote.textContent = t;
  }
  // Why "every shot sings" is greyed out for my song, and what works instead
  function ownShortText() {
    var own = S.own; if (!own) return '';
    var fit = ownLipsLen(), secs = Math.max(1, Math.floor(own.duration));
    return 'Your song is ' + secs + ' s, too short to lip-sync every shot of a ' + S.duration + ' s video' + (fit ? ' — pick ' + fit + ' s for that.' : ' — use a longer song for that.');
  }

  /* ------------------------------------------------------------------ *
   * AI engine: free on this PC (GlowLocalAI, only inside the Glow Studio app) or fal.ai cloud
   * ------------------------------------------------------------------ */
  /* A friend's page ("Share with friends"): the host's Glow Studio app serves this page from its guest server and the
   * video is made on the HOST's PC (guest.js talks to it). The engine is fixed to that PC: no fal.ai, no setup, no
   * engine controls, no "See yourself in every scene", no share card. See the "Friend's page" section below. */
  var GUEST = !!(window.GlowGuest && window.GlowGuest.active);
  var GG = GUEST ? window.GlowGuest : null;
  var PCN = 'this PC'; // where the free AI runs, in words ("Ana’s PC" on a friend's page)
  var LOC = {
    api: GUEST ? guestApi() : (window.GlowLocalAI || null),
    // The Windows launcher injects a keep-alive ping into the pages it serves; the website has none (and is never asked).
    inApp: !GUEST && Array.prototype.some.call(document.scripts, function (sc) { return /__glow\/ping/.test(sc.textContent || ''); }),
    s: null, checked: false, // last launcher status from detect() (null: no answer)
    resume: null,            // GlowLocalAI.resume() handle of a video that was being made when the page closed
    retry: null,             // a finished clip whose finishing (label + sound) failed: kept in memory, finishing again is free
    ctl: null,               // AbortController of the running local video
    release: null,           // releases this page's hold on the local-job lock (one free video at a time, across windows)
    elsewhere: false,        // another Glow Studio window is making a free video right now
    lastState: null, pollTimer: 0, pollSince: 0, pollKind: '',
    urls: [], gone: false, lastFail: null
  };
  // Where the setup page opens straight into what the user came for.
  var SETUP_URL = { setup: './engine.html', singing: './engine.html?add=singing', repair: './engine.html?repair=1' };
  function isLocal() { return S.engine === 'local'; }
  function localPack(id) { var s = LOC.s; return !!(s && s.packs && s.packs[id] && s.packs[id].installed); }
  function singingOk() { return localPack('singing'); }
  // The sound the next video really gets with the chosen engine.
  function effSound(sc) {
    sc = sc || sceneById(S.sceneId);
    if (S.sound === 'own') return 'own'; // the user's own song works for every scene, with both engines
    if (sc.audio === 'required') return 'ai';
    if (!isLocal()) return S.sound;
    if (!sc.song) return 'music';
    // a scene where AI sound is only recommended falls back to music while the add-on is missing (unless picked)
    if (S.sound === 'ai' && !singingOk() && S.userSound !== 'ai') return 'music';
    return S.sound;
  }
  // A singing video on this PC always uses Best: the Quality row is hidden for it, so a Fast choice made earlier for a
  // dance scene must not apply unseen (Fast's photo step keeps the face less well).
  function effQuality(sound) { return isLocal() && sound === 'ai' ? 'best' : S.quality; }
  function half(x) { return String(x).replace(/\.5$/, '½'); }
  // exact: the quality given as is (the Best/Fast buttons), else the one the video would really get
  function localMinutes(sound, quality, exact) {
    var m = [5, 8], q = exact ? quality : (sound === 'ai' ? 'best' : (quality || S.quality));
    try { m = LOC.api.estimate({ quality: q, singing: sound === 'ai' }).minutes; } catch (e) { /* defaults */ }
    return 'about ' + half(m[0]) + '–' + half(m[1]) + ' min';
  }
  // While the engine is not running yet, the first video also waits for it to start and load the models.
  function startExtra() { var s = LOC.s; return s && s.engine && s.engine.state !== 'ready' ? ' (+1–2 min to start)' : ''; }
  function gbText(gb) { return gb >= 10 ? Math.round(gb) + ' GB' : gb >= 1 ? Math.round(gb * 10) / 10 + ' GB' : Math.max(1, Math.round(gb * 1000)) + ' MB'; }
  // what a pack still has to download (the launcher counts partial downloads as done)
  function packLeft(id, def) {
    var sp = LOC.s && LOC.s.packs && LOC.s.packs[id], gb = def;
    try { gb = LOC.api.packs.filter(function (p) { return p.id === id; })[0].sizeGB; } catch (e) { /* default */ }
    if (sp && typeof sp.remainingGB === 'number' && sp.remainingGB >= 0) gb = sp.remainingGB; else if (sp && sp.sizeGB) gb = sp.sizeGB;
    return gbText(gb);
  }
  function singingSize() { return packLeft('singing', 28.3); }
  function diskNeed(packs) { try { return LOC.api.diskNeededGB(packs, LOC.s); } catch (e) { return 90; } }
  function coreDownload() { return packLeft('core', 71.1); }
  function gbOf(bytes) { return gbText((bytes || 0) / 1e9); }
  // What stands between this PC and a free video: graphics card first.
  function gpuProblem(s) {
    if (!s) return null;
    var g = s.gpu;
    if (!g) return s.gpuPending ? 'pending' : 'nogpu';
    if (g.vramMB && g.vramMB < 5600) return 'vram';
    if (g.driverOk === false) return 'driver';
    return null;
  }
  function localState() {
    if (!LOC.checked) return 'checking';
    var s = LOC.s;
    if (!s) return 'offline';
    var j = s.job;
    if (j && j.state === 'running' && j.repair) return 'repairing'; // the engine can't run while its files are checked
    if (!localPack('core') || s.engine.state === 'not-installed') {
      if (j && j.state === 'running') return 'installing';
      var gp = gpuProblem(s);
      if (gp === 'nogpu' || gp === 'vram') return 'nogpu';
      // a setup that was started before: paused (Cancel, or the app/PC was closed) or stopped by an error
      if (j && j.state === 'cancelled' && j.overallDone > 0) return 'paused';
      if (j && j.state === 'error') return 'install-error';
      return 'setup';
    }
    if (s.engine.state === 'error') return 'error';
    return 'ready';
  }
  function jobDoneText(j) { return gbOf(j.overallDone) + ' of ' + gbOf(j.overallTotal); }
  // The launcher's sentences name its own buttons ("press Resume", "press Start"); say what to press here instead.
  function setupText(t) {
    return String(t || '').replace(/\b(press) (?:“|")?Resume(?: download)?(?:”|")?(?: to (?:try again|continue))?/gi, function (m, p) { return p + ' “Try again”'; });
  }
  function engineText(t, where) {
    // where: 'panel' (the error panel has "Try again · free") or 'card' (the engine card: making a video restarts it)
    var said = where === 'panel' ? 'press “Try again · free” and Glow Studio starts it again' : 'making a video starts it again';
    t = String(t || '');
    t = t.replace(/,? then press Start again\./gi, where === 'panel' ? ', then press “Try again · free”.' : ', then make your video again.');
    t = t.replace(/\bPress Start(?: again)?(?: to (?:run it again|try again))?/g, said.charAt(0).toUpperCase() + said.slice(1));
    if (where !== 'panel') t = t.replace(/\bopen Details\b/g, 'open Free AI on this PC for details');
    return t;
  }
  // The main button while the free engine is chosen: what tapping it does next, in plain words.
  function localCta(sound) {
    if (GUEST && !LOC.retry) return guestCta(sound);
    if (LOC.gone) return { main: 'Open Glow Studio again', sub: 'Its helper has closed — use your desktop icon' };
    if (LOC.retry) return { main: 'Finish my video', sub: 'Your video is made — finishing it is free' };
    if (LOC.resume) return LOC.resume.made ? { main: 'Finish my video', sub: 'Your video is made — finishing it is free' } : { main: 'Continue your video', sub: 'Free · picks up where it left off on this PC' };
    var st = localState();
    if (LOC.elsewhere && st !== 'checking' && st !== 'offline') return { main: 'Make my video', sub: 'Another Glow Studio window is making a video' };
    if (st === 'checking') return { main: 'Make my video', sub: 'Checking free AI on this PC…' };
    if (st === 'setup') return { main: 'Set up free AI', sub: 'Free · a one-time setup on this PC' };
    if (st === 'paused' || st === 'install-error') return { main: 'Resume setup', sub: 'Free · ' + jobDoneText(LOC.s.job) + ' downloaded' };
    if (st === 'installing') return { main: 'Free AI is downloading', sub: 'Tap to see how far it is' };
    if (st === 'repairing') return { main: 'Checking the AI files', sub: 'Tap to see how far it is' };
    if (st === 'nogpu') return { main: 'Use fal.ai cloud', sub: 'Free AI can’t run on this PC' };
    if (st === 'offline') return { main: 'Make my video', sub: 'Free AI on this PC isn’t answering' };
    if (sound === 'ai' && !singingOk()) return { main: 'Get the Singing add-on', sub: 'Free · ' + singingSize() + ' one-time download, then sing' };
    var sc = sceneById(S.sceneId), plan = planFor(sc, { sound: sound }), m = localRange(plan);
    // (phones: the short form, so the line doesn't break with one word left over)
    if (NARROW()) return { main: 'Make my video', sub: S.duration + ' s · Free · ~' + half(m[0]) + '–' + half(m[1]) + ' min' + (startExtra() ? ' +1–2 to start' : '') };
    return { main: 'Make my video', sub: S.duration + ' s · Free · ' + rangeText(m) + ' on this PC' + startExtra() };
  }
  function NARROW() { return !!(window.matchMedia && window.matchMedia('(max-width: 480px)').matches); }
  function decideEngine() {
    if (GUEST) return 'local';
    if (!LOC.inApp || !LOC.api) return 'fal';
    var pref = lsGet(LS.engine);
    if (pref === 'local' || pref === 'fal') return pref;
    if (LOC.s && localState() === 'nogpu') return 'fal';
    return 'local';
  }
  function chooseEngine(e, user) {
    S.engine = GUEST || (e === 'local' && LOC.inApp && LOC.api) ? 'local' : 'fal';
    if (user) lsSet(LS.engine, S.engine);
    S.duration = fitLen(sceneById(S.sceneId)); // each engine has its own lengths; the user's pick comes back where it can
    if (S.engine === 'fal') stopTrackPreview();
    renderEngine(); updateAll();
  }
  function goSetup(what) { location.href = SETUP_URL[what] || SETUP_URL.setup; }
  var STATE_SAY = { ready: 'Free AI on this PC is ready', installing: 'Free AI is downloading', paused: 'The free AI download is paused', 'install-error': 'The free AI download stopped',
    error: 'The free AI engine needs attention', nogpu: 'This PC can’t run free AI', setup: 'Free AI isn’t set up on this PC yet', repairing: 'Glow Studio is checking the AI files', offline: 'Free AI on this PC isn’t answering' };
  var detecting = null;
  // Ask the launcher how free AI is doing: when the page opens, whenever the window gets focus again, and every few
  // seconds only while something is changing by itself (graphics card check, download, engine start).
  function refreshLocal() {
    if (GUEST) return guestRefresh();
    if (!LOC.inApp || !LOC.api) return Promise.resolve(null);
    if (detecting) return detecting;
    detecting = LOC.api.detect().catch(function () { return null; }).then(function (s) {
      detecting = null;
      LOC.s = s || null; LOC.checked = true;
      if (!running()) S.engine = decideEngine();
      var st = localState();
      if (LOC.lastState && LOC.lastState !== st && STATE_SAY[st] && isLocal() && !running()) announce(STATE_SAY[st]);
      LOC.lastState = st;
      renderEngine(); updateAll();
      scheduleLocalPoll();
      return s;
    });
    return detecting;
  }
  function scheduleLocalPoll() {
    clearTimeout(LOC.pollTimer);
    var s = LOC.s, st = localState(), kind = '';
    if (s && s.gpuPending) kind = 'gpu';
    else if (s && s.engine && s.engine.state === 'starting' && !running()) kind = 'start';
    else if (st === 'installing' || st === 'repairing' || (s && s.job && s.job.state === 'running')) kind = 'install';
    if (!kind) { LOC.pollKind = ''; LOC.pollSince = 0; return; }
    if (LOC.pollKind !== kind) { LOC.pollKind = kind; LOC.pollSince = Date.now(); }
    // a download takes hours (checked every 8 s); the other two settle within a few minutes
    var limit = kind === 'install' ? 12 * 3600e3 : 4 * 60e3;
    if (Date.now() - LOC.pollSince > limit) return;
    LOC.pollTimer = setTimeout(function () {
      if (document.hidden) { scheduleLocalPoll(); return; } // the focus event asks again when the window is back
      refreshLocal();
    }, TEST.localPollMs || (kind === 'install' ? 8000 : 4000));
  }

  /* One free video at a time on this PC, across Glow Studio windows (double-clicking GlowStudio.exe again opens a
   * second window on the same address): the page that makes it holds the Web Lock 'glow-local-job' until its finishing
   * is done. Without Web Locks, a heartbeat in localStorage stands in for it. */
  var LLOCK = 'glow-local-job', LBEAT = 'glow.ai.localbeat';
  function localBeatElsewhere() { var b = lsJSON(LBEAT); return !!(b && b.inst !== INST && Date.now() - (b.at || 0) < CFG.staleBeatMs); }
  function localLockFree() {
    if (LOC.release) return Promise.resolve(true);
    if (!LOCKS) return Promise.resolve(!localBeatElsewhere());
    if (typeof navigator.locks.query === 'function') {
      return navigator.locks.query().then(function (q) { return !((q && q.held) || []).some(function (l) { return l.name === LLOCK; }); }, function () { return true; });
    }
    return new Promise(function (res) {
      try { navigator.locks.request(LLOCK, { ifAvailable: true }, function (l) { res(!!l); return null; }).catch(function () { res(true); }); } catch (e) { res(true); }
    });
  }
  function acquireLocalLock(retried) {
    if (LOC.release) return Promise.resolve(true);
    if (!LOCKS) {
      if (localBeatElsewhere()) return Promise.resolve(false);
      lsSet(LBEAT, JSON.stringify({ inst: INST, at: Date.now() }));
      var iv = setInterval(function () { lsSet(LBEAT, JSON.stringify({ inst: INST, at: Date.now() })); }, 3000);
      LOC.release = function () { clearInterval(iv); var b = lsJSON(LBEAT); if (b && b.inst === INST) lsDel(LBEAT); };
      return Promise.resolve(true);
    }
    return new Promise(function (res) {
      var p;
      try {
        p = navigator.locks.request(LLOCK, { ifAvailable: true }, function (lock) {
          if (!lock) { res(false); return null; }
          return new Promise(function (release) { LOC.release = release; res(true); });
        });
      } catch (e) { res(true); return; }
      if (p && p.catch) p.catch(function () { res(true); });
    }).then(function (ok) {
      // a window that is waiting for the lock holds it for a moment when it gets it: ask once more
      if (ok || retried) return ok;
      return wait(250).then(function () { return acquireLocalLock(true); });
    });
  }
  function releaseLocalLock() { var r = LOC.release; LOC.release = null; if (r) r(); }
  // Another window is making a free video: say so (no "Continue" for it here), and look again once it is done.
  var watchingLocal = false;
  function otherWindowBusy() {
    var was = LOC.elsewhere;
    LOC.elsewhere = true; LOC.resume = null;
    renderEngine(); updateCost();
    if (!was) announce('A video is being made in another Glow Studio window');
    if (watchingLocal) return;
    watchingLocal = true;
    var done = function () { watchingLocal = false; LOC.elsewhere = false; setTimeout(function () { loadHistory(); refreshLocal().then(checkLocalResume); }, 0); };
    if (LOCKS) {
      var p = null;
      try { p = navigator.locks.request(LLOCK, function () { done(); }); } catch (e) { p = null; }
      if (p && p.catch) p.catch(function () { watchingLocal = false; });
      if (p) return;
    }
    var iv = setInterval(function () { if (!localBeatElsewhere()) { clearInterval(iv); done(); } }, 4000);
  }
  // A video that was being made on this PC when the page was closed or reloaded (or whose finishing was cut short).
  // Right after the page opens, the first "Continue your video" offer is brought into view (after a reload the browser
  // puts the page back where it was scrolled to, often far below it). Never later, and never once the user has started
  // using the page.
  var revealUntil = Date.now() + 15000, revealOk = true;
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (t) { window.addEventListener(t, function () { revealUntil = 0; revealOk = false; }, { once: true, passive: true }); });
  function revealResume() {
    // after the browser has put the scroll position back (it may do so more than once while the page settles)
    var tries = 0, moved = false;
    var go = function () {
      setTimeout(function () {
        if (!revealOk || !el.engResume || el.engResume.hidden) return;
        var rb = el.engResume.getBoundingClientRect();
        if (rb.top < 0 || rb.bottom > (window.innerHeight || 0)) {
          if (!moved) { moved = true; attention(el.engCard); }
          else { try { el.engCard.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } }
        }
        if (++tries < 3) go();
      }, tries ? 900 : 120);
    };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
  }
  function checkLocalResume() {
    if (!LOC.inApp || !LOC.api || !LOC.s) return Promise.resolve();
    if (running() || RUN.starting) return Promise.resolve();
    return localLockFree().then(function (free) {
      if (running() || RUN.starting) return;
      // never touch what another window is making (its record and notes stay as they are)
      if (!free) { otherWindowBusy(); return; }
      LOC.elsewhere = false;
      return LOC.api.resume().then(function (r) {
        if (running() || RUN.starting) return;
        if (!r) { clearLocalMeta(); dropResume(); return; }  // no window is making a video: old notes are stale
        if (!r.canAttach) { r.discard(); clearLocalMeta(); dropResume(); return; } // the photo never reached the engine: nothing to continue
        var mm = metaFor(r);
        if (mm && mm.kind === 'preview') {
          // a quick "See yourself" preview that was cut off: it is made again from the queue (Resume), never offered as a video
          try { if (r.made || r.state === 'done') r.discard(); else r.cancel(); } catch (e) { /* ignore */ }
          clearLocalMeta(); dropResume(); seeInterrupted();
          return;
        }
        if (LOC.retry && LOC.retry.engineJob === r.job) { dropResume(); return; } // already offered as "Finish my video"
        LOC.resume = r;
        renderEngine(); updateCost();
        if (Date.now() < revealUntil && el.engResume && !el.engResume.hidden) { revealUntil = 0; revealResume(); }
      }, function () { /* engine not answering: nothing to offer */ });
    });
  }
  function dropResume() { if (LOC.resume) { LOC.resume = null; } renderEngine(); updateCost(); }
  function localMeta() { var m = lsJSON(LS.localJob); return m && m.v === 1 ? m : null; }
  function saveLocalMeta(job) {
    lsSet(LS.localJob, JSON.stringify({ v: 1, kind: job.kind || 'video', sceneId: job.sceneId, sound: job.sound, trackId: job.trackId, quality: job.quality, thumb: job.thumb || '', createdAt: job.createdAt, offset: job.offset, engineJob: job.engineJob || null, at: Date.now(),
      duration: job.duration, story: !!job.story, shots: job.shots || null, sync: job.sync || 'beat', own: job.own || null, songStart: job.songStart || 0, songSeconds: job.songSeconds || null, shotId: job.shotId || null, hint: job.hint || '', minutes: job.minutes || null }));
  }
  function clearLocalMeta() { lsDel(LS.localJob); }
  // The notes kept for this engine job (never another job's: they could name another scene or track).
  function metaFor(r) { var m = localMeta(); return m && (!m.engineJob || !r || m.engineJob === r.job) ? m : null; }
  function ago(ts) {
    var m = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function noteHTML(kind, title, text, actions) {
    var h = '<span class="ai-eng-dot ' + kind + '" aria-hidden="true"></span><div class="ai-eng-nt">' + (title ? '<b>' + esc(title) + '</b>' : '') + (text ? '<p>' + text + '</p>' : '');
    if (actions) h += '<div class="ai-eng-acts">' + actions + '</div>';
    return h + '</div>';
  }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var A_SETUP = function (label, cls, what) { return '<a class="btn ' + (cls || 'primary') + '" href="' + (SETUP_URL[what] || SETUP_URL.setup) + '">' + esc(label) + '</a>'; };
  var A_FAL = function (label, cls) { return '<button type="button" class="btn ' + (cls || 'text') + '" data-engine-go="fal">' + esc(label) + '</button>'; };
  function driverLinkHTML(label, cls) { return '<a class="' + (cls || 'ai-eng-link') + '" href="' + esc(LOC.api ? LOC.api.driverUrl : 'https://www.nvidia.com/Download/index.aspx') + '" target="_blank" rel="noopener">' + esc(label) + '</a>'; }
  function vcLinkHTML(label, cls) { return '<a class="' + (cls || 'ai-eng-link') + '" href="' + esc(LOC.api && LOC.api.vcRedistUrl || 'https://aka.ms/vc14/vc_redist.x64.exe') + '" target="_blank" rel="noopener">' + esc(label) + '</a>'; }
  // One plain line under the switch: what each engine gives (time, length, sharpness, cost).
  function compareLine() {
    var m = [5, 8];
    try { m = LOC.api.estimate({ quality: 'best' }).minutes; } catch (e) { /* defaults */ }
    return '<b>Free:</b> about ' + half(m[0]) + '–' + half(m[1]) + ' min per 5-second shot on your PC, a little softer. ' +
      '<b>Cloud:</b> usually 1–3 min, sharper, ' + falRangeText() + '.';
  }
  // what a cloud video costs, from the cheapest 5 s clip to a 20 s story with AI sound
  function falMax() { var mx = 0; SCENES.forEach(function (sc) { lengthsFor(sc, 'fal').forEach(function (d) { mx = Math.max(mx, falCost(sc, 'ai', d)); }); }); return mx; }
  function falRangeText() { return '5–20 s, about ' + money(estimate('music', LENGTHS[0])) + '–' + money(falMax()) + ' each'; }
  function setNote(html, cls) {
    el.engNote.className = 'ai-eng-note' + (cls ? ' ' + cls : '');
    // only when it changes: a status refresh must not take the focus from a button in it
    if (el.engNote.dataset.h !== html) { el.engNote.innerHTML = html; el.engNote.dataset.h = html; }
    el.engNote.hidden = !html;
  }
  function renderEngine() {
    var app = !!(LOC.inApp && LOC.api), local = isLocal();
    if (el.engCard) el.engCard.hidden = !app;
    el.ai.classList.toggle('in-app', app);
    if (el.engWeb) el.engWeb.hidden = app || GUEST;
    el.keyChip.hidden = local; // no key is needed on this PC
    if (GUEST) { renderGuest(); return; }
    renderShareCard(app);
    if (el.footNote) {
      el.footNote.innerHTML = local
        ? 'Your selfie stays on this PC: the free AI runs on your own graphics card and nothing is uploaded. The working copies the AI makes are deleted after each video. Use only your own photo, or one you have permission to use, of an adult. Every video gets a small &ldquo;AI-generated&rdquo; label.'
        : 'Your selfie goes straight from this browser to <a href="https://fal.ai" target="_blank" rel="noopener">fal.ai</a>, using your own key, and nowhere else. Use only your own photo, or one you have permission to use, of an adult. Every video gets a small &ldquo;AI-generated&rdquo; label.';
    }
    if (!app || !el.engCard) return;
    if (el.engCmp) { var cmp = compareLine(); if (el.engCmp.dataset.h !== cmp) { el.engCmp.innerHTML = cmp; el.engCmp.dataset.h = cmp; } }
    Array.prototype.forEach.call(el.engSeg.querySelectorAll('.ai-eng-opt'), function (b) {
      var on = b.getAttribute('data-engine') === S.engine;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    var st = localState(), s = LOC.s, gp = gpuProblem(s), j = s && s.job;
    var pill = { checking: ['wait', 'Checking…'], offline: ['warn', 'Not answering'], setup: ['warn', 'Not set up yet'], installing: ['wait', 'Downloading…'],
      paused: ['warn', 'Download paused'], 'install-error': ['bad', 'Download stopped'], repairing: ['wait', 'Checking files…'],
      nogpu: ['bad', 'Not available'], error: ['bad', 'Needs attention'], ready: ['ok', 'Ready · photos stay on this PC'] }[st];
    if (local && LOC.gone) pill = ['bad', 'Glow Studio’s helper has closed'];
    if (!local) pill = getKey() ? ['ok', 'fal.ai connected'] : ['warn', 'Needs your fal.ai key'];
    el.engSt.className = 'ai-eng-st ' + pill[0]; el.engSt.textContent = pill[1];
    el.engLocalS.textContent = st === 'setup' || st === 'installing' || st === 'paused' || st === 'install-error' ? 'One-time setup' : st === 'nogpu' ? 'Needs NVIDIA' : 'No sign-up';
    var html = '', cls = '';
    var pct = j && j.overallTotal ? Math.floor(j.overallDone / j.overallTotal * 100) : 0;
    if (local) {
      if (LOC.gone) {
        cls = 'big';
        html = noteHTML('bad', 'Glow Studio’s helper has closed', 'The part of Glow Studio that runs the free AI isn’t running any more (it was closed, or your PC went to sleep). Open Glow Studio again from your desktop icon or the Start menu — a video you were making picks up where it left off. This window notices by itself when it’s back.');
      } else if (st === 'checking') html = noteHTML('wait', '', 'Checking free AI on this PC…');
      else if (st === 'offline') {
        html = noteHTML('warn', 'Free AI on this PC isn’t answering', 'Glow Studio may still be starting. Wait a moment and try again, or use fal.ai cloud for now.',
          '<button type="button" class="btn glass" data-act="recheck">Try again</button>' + A_FAL('Use fal.ai cloud'));
      } else if (LOC.elsewhere && !running()) {
        html = noteHTML('wait', 'A video is being made in another Glow Studio window', 'Free AI makes one video at a time on this PC. You can watch it in that window — this one is ready for your next video as soon as it’s done.');
      } else if (st === 'installing') {
        html = noteHTML('wait', 'Free AI is downloading · ' + pct + '%', esc(jobDoneText(j)) + ' so far. You can make videos as soon as it’s done.', A_SETUP('See the setup', 'glass'));
      } else if (st === 'repairing') {
        html = noteHTML('wait', 'Checking & repairing the AI files · ' + pct + '%', 'Videos can be made again as soon as the check is done.', A_SETUP('See the check', 'glass'));
      } else if (st === 'paused') {
        cls = 'big';
        html = noteHTML('setup', 'Download paused — ' + jobDoneText(j) + ' done',
          'Nothing already downloaded is lost. Resume whenever you like; after that every video is free and your photos never leave this PC.',
          '<button type="button" class="btn primary" data-act="resume-install">Resume download</button>' + A_SETUP('See the setup', 'text') + A_FAL('Use fal.ai cloud instead'));
      } else if (st === 'install-error') {
        cls = 'big';
        var je = String(j.error || '').trim();
        var jt = je && LOC.api.isPlainMessage && LOC.api.isPlainMessage(je) ? setupText(je) : 'The download stopped unexpectedly.';
        if (!/lost|saved|kept/i.test(jt)) jt += ' Your progress (' + jobDoneText(j) + ') is saved.';
        html = noteHTML('bad', 'The free AI download stopped', esc(jt),
          '<button type="button" class="btn primary" data-act="resume-install">Try again</button>' + A_SETUP('Open the setup', 'text') + A_FAL('Use fal.ai cloud instead'));
      } else if (st === 'setup') {
        cls = 'big';
        html = noteHTML('setup', 'Set up free AI on this PC',
          'A one-time download of about ' + coreDownload() + ' (needs about ' + diskNeed(['core']) + ' GB of free space; a few hours). After that every video is free, and your photos never leave this PC.' +
          (gp === 'driver' ? ' <span class="ai-eng-warn">Your NVIDIA driver (version ' + esc(s.gpu.driver || '?') + ') is too old: ' + driverLinkHTML('update it') + ', then restart your PC.</span>' : '') +
          (gp === 'pending' ? ' <span class="ai-eng-wait">Checking your graphics card…</span>' : ''),
          A_SETUP('Set up free AI') + A_FAL('Use fal.ai cloud instead'));
      } else if (st === 'nogpu') {
        html = noteHTML('bad', 'This PC can’t run free AI',
          (gp === 'vram' ? 'Its graphics card (' + esc(s.gpu.name) + ') has ' + Math.round(s.gpu.vramMB / 1024) + ' GB of video memory, and free AI needs an NVIDIA RTX card with 8 GB.'
            : 'Free AI needs an NVIDIA RTX graphics card with 8 GB of video memory, and none was found on this PC. If it has one, ' + driverLinkHTML('install the NVIDIA driver') + ' and restart.') +
          ' You can still make AI scenes with fal.ai cloud.', A_FAL('Use fal.ai cloud', 'primary'));
      } else if (st === 'error' && LOC.resume && !running()) {
        // "Continue your video" below starts the engine again: one next step, not two
        html = noteHTML('warn', '', 'The free AI engine stopped. “' + (LOC.resume.made ? 'Finish my video' : 'Continue your video') + '” starts it again.');
        cls = 'line';
      } else if (st === 'error') {
        var ex = LOC.api.explainEngineError(s);
        var act = ex.code === 'driver' ? driverLinkHTML('Update NVIDIA driver', 'btn glass') : ex.code === 'vcredist' ? vcLinkHTML('Get the Microsoft component', 'btn glass')
          : ex.code === 'missing-model' ? A_SETUP('Check & repair files', 'glass', 'repair') : A_SETUP('Open Free AI on this PC', 'glass');
        html = noteHTML('bad', 'The free AI engine needs attention', esc(engineText(ex.message, 'card')), act);
      } else {
        var bits = s.engine.state !== 'ready' ? 'The free AI starts by itself when you make a video (about a minute).' : '';
        if (gp === 'driver') bits += ' <span class="ai-eng-warn">Your NVIDIA driver (version ' + esc(s.gpu.driver || '?') + ') is too old for free AI: ' + driverLinkHTML('update it') + ', then restart your PC.</span>';
        else if (gp === 'pending') bits += ' <span class="ai-eng-wait">Checking your graphics card…</span>';
        else if (gp === 'nogpu') bits += ' <span class="ai-eng-warn">No NVIDIA graphics card was found just now. If videos fail, ' + driverLinkHTML('update the NVIDIA driver') + '.</span>';
        if (j && j.state === 'running') bits += ' <span class="ai-eng-wait">An add-on is downloading · ' + pct + '%. You can make videos meanwhile.</span>';
        if (bits) html = noteHTML(gp === 'driver' || gp === 'nogpu' ? 'warn' : 'ok', '', bits.replace(/^ /, ''));
        cls = 'line';
      }
    }
    setNote(html, cls);
    // "Continue your video" / "Finish my video"
    var r = LOC.resume;
    el.engResume.hidden = !r || running() || !local;
    if (r) {
      var m = metaFor(r), sc = sceneById(m && m.sceneId);
      var where = r.made ? 'made — only the label and sound are left'
        : r.kind === 'story' ? storyWhere(r, m)
        : { running: 'still being made on this PC', queued: 'waiting its turn on this PC', done: 'almost done', lost: 'the AI engine restarted, so the last step is redone' }[r.state] || 'it picks up where it left off';
      el.engResT.textContent = r.made ? 'Your video is ready to finish' : 'You were making a video';
      el.engResS.textContent = (m ? sc.name + ' · ' : '') + 'started ' + ago((m && m.createdAt) || r.startedAt) + ' · ' + where + ' · free';
      if (el.engContinue) el.engContinue.textContent = r.made ? 'Finish my video' : 'Continue your video';
    }
  }

  // "Share with friends" (share.js): the host's card, in the Windows app once free AI is set up
  var SHARE = null;
  function renderShareCard(app) {
    var card = document.getElementById('aiShareCard');
    if (!card) return;
    var show = !!(app && window.GlowShare && localPack('core') && window.GlowShare.supported(LOC.s));
    if (show && !SHARE) {
      // (the card and the chip near the top appear once the launcher answers; the window title says when a friend waits)
      window.GlowShare.onTitle = function () { setRunTitle(UI.runTitle || ''); };
      SHARE = window.GlowShare.mount(card, { where: 'ai', onChange: shareAsk, top: document.getElementById('aiShareTop'), onShow: function () { if (!el.prog.hidden) minimize(); } });
    }
    if (!show) { card.hidden = true; if (SHARE) { SHARE.unmount(); SHARE = null; } }
  }
  // A friend waits for the host's OK ("Approve each video") while the host's own progress sheet covers the card: the
  // sheet says so, and "Show me" hides the sheet (the video keeps going) and brings the card's Approve button up.
  function shareAsk(s) {
    if (!el.shareAsk || GUEST) return;
    if (document.getElementById('gsAsk')) { el.shareAsk.hidden = true; return; } // (share.js shows its banner at the top of the window)
    var w = s && s.state !== 'off' && Array.isArray(s.jobs) ? s.jobs.filter(function (j) { return j && j.state === 'waiting-approval'; }) : [];
    var t = !w.length ? '' : w.length === 1 ? (w[0].guestName || 'A friend') + ' is waiting for you to approve a video.' : w.length + ' friends are waiting for you to approve their videos.';
    if (t === (el.shareAsk.hidden ? '' : el.shareAskT.textContent)) return;
    el.shareAskT.textContent = t; el.shareAsk.hidden = !t;
    if (t && !el.prog.hidden) announce(t);
  }
  function showShareAsk() {
    if (!el.prog.hidden) minimize();
    var card = document.getElementById('aiShareCard');
    if (!card) return;
    var b = card.querySelector('[data-key^="ap-"]') || card;
    try { b.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
    setTimeout(function () { try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 350);
  }
  // the host's own video goes first; while a friend's step finishes, the share status says so
  function hostShareNote() { var s = window.GlowShare && window.GlowShare.status; return s && s.state !== 'off' && s.hostPriorityNote ? String(s.hostPriorityNote).replace(/'/g, '’') : ''; }
  // Sharing: while this PC's own video waits behind the step of a friend's video that is being made right now, the
  // line under the progress bar says so ("A friend’s video is on step 3 of 8 — yours starts after this step").
  function shareNoteLine(job) {
    if (!el.shareNote) return;
    var sn = !GUEST && job && job.engine === 'local' && UI.stage !== 'finish' && UI.localWaiting ? hostShareNote() : '';
    if (sn === (el.shareNote.hidden ? '' : el.shareNote.textContent)) return;
    el.shareNote.textContent = sn; el.shareNote.hidden = !sn;
    if (sn && sn !== UI.shareNote) announce(sn);
    UI.shareNote = sn || UI.shareNote;
  }
  // Where a story stands after the window was closed: the PC finishes only the step it was on, then the story
  // pauses until it is continued. r.state is that one step's state, so the line is built from the shots done.
  function storyWhere(r, m) {
    var n = r.shots || 1, done = r.shotsDone || 0, stills = r.stillsReady || 0;
    var sofar = done ? done + ' of ' + n + ' shot' + (n > 1 ? 's' : '') + ' done' : stills ? stills + ' of ' + n + ' scene photo' + (n > 1 ? 's' : '') + ' done' : '';
    if (r.state === 'running' || r.state === 'queued') return 'still being made on this PC' + (sofar ? ' · ' + sofar : '');
    var left = '';
    if (m && validRange(m.minutes)) {
      var f = Math.max(0.15, 1 - (done + 0.2 * Math.max(0, stills - done)) / n);
      left = ' (about ' + Math.max(1, Math.round(m.minutes[0] * f)) + '–' + Math.max(2, Math.round(m.minutes[1] * f)) + ' min left)';
    }
    return 'paused' + (sofar ? ' after ' + sofar.replace(/ done$/, '') : '') + ' — press Continue' + left;
  }

  /* ------------------------------------------------------------------ *
   * Friend's page ("Share with friends"): the video is made on the HOST's PC
   *
   * guest.js (window.GlowGuest) joins with the link's token, keeps the session and talks to the host's guest server.
   * Here it stands in for GlowLocalAI (LOC.api), so the usual free-AI flow runs: the same plan (planFor, always the
   * story path), the same progress sheet, the same finishing in this browser (music + "AI-generated" label) and
   * "My AI videos" on this device. What goes to the host is only a job request (preset scene + choices), the selfie
   * (re-encoded here) and, for lip-sync to the friend's own song, a short WAV of that part of it. The host's app builds
   * the AI steps from scenes.json itself and labels every picture and clip before this page can download it.
   * ------------------------------------------------------------------ */
  function guestApi() {
    return {
      packs: [], driverUrl: '', vcRedistUrl: '',
      detect: function () { return Promise.resolve(guestStatus()); },
      estimateStory: function (o) { return GG.estimateStory(o); },
      estimate: function (o) {
        o = o || {};
        var m = GG.estimateStory({ shots: 1, quality: o.quality, song: !!o.singing, lipSync: o.singing ? 1 : 0 }).minutes;
        return { minutes: m };
      },
      generateStory: function (req, onP) { return GG.submit({ request: req.request, photo: req.photo, audio: req.audio, ownStart: req.ownStart }, onP, req.signal); },
      generate: function () { return Promise.reject(new Error('not on a friend’s page')); },
      // "Try finishing again" after the shots were dropped: fetch them again from the host while it still has them
      resume: function () {
        return GG.current().then(function (sj) {
          if (!sj || (sj.state !== 'done' && sj.state !== 'running' && sj.state !== 'queued' && sj.state !== 'waiting-approval')) return null;
          return guestHandle(sj);
        });
      },
      release: function (id) { if (id) GG.done(id).then(refreshGuestSession); },
      isBusy: function () { return false; },
      diskNeededGB: function () { return 0; },
      explainEngineError: function () { return { code: '', message: '', detail: '' }; },
      isPlainMessage: function () { return true; }
    };
  }
  function guestHandle(sj) {
    var m = localMeta();
    var own = m && m.engineJob === sj.id && m.own ? m.own : null;
    return {
      kind: 'story', job: sj.id, state: sj.state, made: sj.state === 'done', canAttach: true, shots: sj.plan && sj.plan.shots ? sj.plan.shots.length : 1,
      attach: function (onP, o) { return GG.attach(sj, onP, o && o.signal, { ownStart: own ? own.start : 0 }); },
      cancel: function () { return GG.cancel(sj.id); }, discard: function () { return GG.done(sj.id); }
    };
  }
  // the host's PC, as the rest of the page sees an engine: ready, with the add-ons the host has
  function guestStatus() {
    var ses = GG.session, h = (ses && ses.host) || {};
    if (!ses) return null;
    return { engine: { state: 'ready' }, gpu: { name: h.laptop ? 'Laptop GPU' : 'GPU', vramMB: 8192, driverOk: true },
      packs: { core: { installed: true }, singing: { installed: !!h.singing }, fast: { installed: !!h.fast } }, job: null };
  }
  function guestHostName() { return GG.hostName(); }
  function guestRefresh() {
    LOC.s = guestStatus(); LOC.checked = true;
    PCN = (GG.session ? guestHostName() : 'your friend') + '’s PC';
    S.engine = 'local';
    renderEngine(); updateAll();
    return Promise.resolve(LOC.s);
  }
  function guestLeftText(ses) {
    var L = ses && ses.limits;
    if (!L) return '';
    if (L.left <= 0) return 'No videos left today — you can make more after ' + guestResetText(L.resetAt) + '.';
    return L.left + ' of ' + L.daily + ' video' + (L.daily === 1 ? '' : 's') + ' left today';
  }
  function guestResetText(at) {
    var d = at ? new Date(at) : null;
    if (!d || isNaN(d)) return 'midnight';
    var hh = d.getHours(), mm = d.getMinutes();
    return hh === 0 && mm === 0 ? 'midnight' : (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  // The card at the top of a friend's page: whose PC, how many videos are left today, who you are.
  var GV = { gate: 'connecting', tried: false, codeOpen: false, nameOpen: false };
  function renderGuest() {
    var ses = GG.session, host = guestHostName();
    if (el.footNote) {
      el.footNote.textContent = 'Your selfie goes to ' + host + '’s PC only to make your video, and is deleted afterwards' +
        (ses && ses.mode === 'wifi' ? ' (over the Wi-Fi you share).' : ' (through an encrypted link via Cloudflare).') +
        ' Use only your own photo, or one you have permission to use, of an adult. Every video gets a small “AI-generated” label.';
    }
    if (el.gPrivacy) {
      el.gPrivacy.textContent = ses ? 'Your photo goes to ' + host + '’s PC only to make this video and is deleted afterwards.' + (ses.approve ? ' ' + host + ' approves each video and sees your photo.' : '') : '';
      el.gPrivacy.hidden = !ses;
    }
    if (!el.gCard) return;
    var named = !!(ses && ses.guest && ses.guest.name);
    el.gCard.hidden = !named;
    renderGate();
    if (!named) return;
    el.gBadgeT.textContent = 'Made on ' + host + '’s PC · free';
    el.gLeft.textContent = guestLeftText(ses);
    el.gLeft.classList.toggle('none', !!(ses.limits && ses.limits.left <= 0));
    var notes = [];
    if (ses.state === 'closing') notes.push(host + ' has stopped sharing. Videos already being made still finish, but no new ones can start.');
    else if (ses.approve) notes.push(host + ' approves each video before it starts.');
    if (ses.mode === 'wifi' && !GG.secure) notes.push('You’re on ' + host + '’s Wi-Fi link.');
    el.gNote.textContent = notes.join(' ');
    el.gNote.hidden = !notes.length;
    el.gMe.textContent = 'You: ' + ses.guest.name;
    el.gCodeBox.hidden = !GV.codeOpen;
    el.gNameBox.hidden = !GV.nameOpen;
  }
  // Connecting / no link / your name: shown instead of the scene controls until the friend is in.
  function renderGate() {
    var ses = GG.session, g = !ses ? (GV.tried ? 'nolink' : 'connecting') : !ses.guest.name ? 'name' : '';
    if (GV.gate === g && el.gate.dataset.k === g + (ses ? ses.host.name : '') + (GG.error ? GG.error.code : '')) return;
    GV.gate = g;
    el.gate.dataset.k = g + (ses ? ses.host.name : '') + (GG.error ? GG.error.code : '');
    el.ai.classList.toggle('guest-gate', !!g);
    el.gate.hidden = !g;
    el.gate.textContent = '';
    if (!g) return;
    var h = document.createElement('h2'), p = document.createElement('p'), host = guestHostName();
    var Host = host.charAt(0).toUpperCase() + host.slice(1);
    h.id = 'aiGateH'; h.tabIndex = -1;
    el.gate.setAttribute('aria-labelledby', 'aiGateH');
    var ico = document.createElement('span'); ico.className = 'ai-gate-ico'; ico.setAttribute('aria-hidden', 'true');
    el.gate.appendChild(ico);
    if (g === 'connecting') {
      ico.classList.add('wait');
      h.textContent = 'Connecting to your friend’s PC…';
      p.textContent = 'One moment.';
      el.gate.appendChild(h); el.gate.appendChild(p);
      return;
    }
    if (g === 'nolink') {
      var code = GG.error && GG.error.code;
      ico.classList.add('link');
      h.textContent = code === 'blocked' ? Host + ' stopped sharing with you' : code === 'not-accepting' || code === 'sharing-stopped' ? (host === 'your friend' ? 'Sharing has stopped' : Host + ' stopped sharing') : code === 'full' ? 'This share is full' : code === 'too-many-attempts' ? 'Too many tries' : code === 'network' ? 'Can’t reach your friend’s PC' : 'Ask your friend for a new link';
      p.textContent = code === 'blocked' ? 'You can’t make AI videos with this link any more. Photo Video still works on this device, and the videos you made are in My AI videos.'
        : code === 'not-accepting' || code === 'sharing-stopped' ? Host + ' has stopped sharing their PC for now. Ask them to share again and send you the new link.'
        : code === 'network' ? 'Check your connection, then try again. If it still doesn’t work, ask your friend whether sharing is still on.'
        : code === 'full' ? 'Too many people are using this link right now. Ask your friend to send you a new link later.'
        : code === 'too-many-attempts' ? 'Wait a few minutes, then open the link your friend sent you again.'
        : 'This link has expired or was replaced. Ask the friend who sent it for a new one — links only work while they are sharing.';
      el.gate.appendChild(h); el.gate.appendChild(p);
      var tip = document.createElement('p'); tip.className = 'ai-gate-tip';
      tip.textContent = 'Were you making a video? Open the new link, then tap “I have a code” and enter the code from your video.';
      if (code !== 'blocked') el.gate.appendChild(tip);
      var acts = document.createElement('div'); acts.className = 'ai-gate-acts';
      var pv = document.createElement('button'); pv.type = 'button'; pv.className = 'btn primary'; pv.textContent = 'Make a photo video instead';
      pv.addEventListener('click', function () { setMode('photo', { user: true }); });
      var again = document.createElement('button'); again.type = 'button'; again.className = 'btn glass'; again.textContent = 'Try again';
      again.addEventListener('click', function () { GG.refresh().then(function (s) { if (!s) toast('This link still doesn’t work — ask your friend for a new one.', 'warn', 5000); afterSession(); }, function () { toast('Can’t reach your friend’s PC right now.', 'warn'); }); });
      acts.appendChild(pv); if (code !== 'blocked') acts.appendChild(again);
      el.gate.appendChild(acts);
      return;
    }
    // the friend's name (the host sees it, and can block anyone they don't know)
    ico.classList.add('hi');
    h.textContent = 'Hi! What should ' + host + ' call you?';
    p.textContent = host + ' shared their PC’s free AI with you. Your name shows up on ' + host + '’s screen, so they know who’s making a video.';
    el.gate.appendChild(h); el.gate.appendChild(p);
    var form = document.createElement('form'); form.className = 'ai-gate-form'; form.noValidate = true;
    var lab = document.createElement('label'); lab.htmlFor = 'aiGuestName'; lab.className = 'sr-only'; lab.textContent = 'Your name';
    var inp = document.createElement('input'); inp.id = 'aiGuestName'; inp.type = 'text'; inp.maxLength = 24; inp.autocomplete = 'given-name'; inp.placeholder = 'Your name'; inp.enterKeyHint = 'go';
    var go = document.createElement('button'); go.type = 'submit'; go.className = 'btn primary'; go.textContent = 'Continue';
    var msg = document.createElement('p'); msg.className = 'ai-gate-msg'; msg.setAttribute('role', 'status');
    form.appendChild(lab); form.appendChild(inp); form.appendChild(go); form.appendChild(msg);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = inp.value.trim();
      if (!v) { msg.textContent = 'Type your name first.'; inp.focus(); return; }
      go.disabled = true; msg.textContent = '';
      GG.setName(v).then(function () { go.disabled = false; afterSession(); announce('Welcome, ' + ((GG.session && GG.session.guest.name) || v)); }, function (er) {
        go.disabled = false;
        var dead = er && (er.code === 'no-session' || er.code === 'bad-token' || er.code === 'not-accepting' || er.code === 'sharing-stopped');
        msg.textContent = er && er.code === 'bad-name' ? 'Please use letters, numbers and simple punctuation (up to 24 characters).' : er && er.code === 'full' ? 'Lots of friends are here right now — try again in a few minutes.' : dead ? 'This link stopped working — ask your friend for a new one.' : 'That didn’t work — try again.';
        if (dead) afterSession();
      });
    });
    el.gate.appendChild(form);
    var note = document.createElement('p'); note.className = 'ai-gate-tip';
    note.textContent = 'Your photo goes to ' + host + '’s PC only to make your video and is deleted afterwards. Your finished videos are saved on this device.';
    el.gate.appendChild(note);
    setTimeout(function () { try { inp.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }, 50);
  }
  // A new session (joined, named, renamed, blocked, sharing stopped …): redraw, and pick up a video already on the way.
  function afterSession() {
    GV.tried = true;
    guestRefresh();
    var ses = GG.session;
    if (!ses || !ses.guest.name || running() || RUN.starting) return;
    GG.current().then(function (sj) { if (sj) guestAttachJob(sj, {}); }, function () { /* nothing to pick up */ });
  }
  // A video this friend already has on the host's PC (a reload, another tab closed, or a claimed code): follow it here.
  function guestAttachJob(sj, opts) {
    opts = opts || {};
    if (!sj || !sj.plan || running() || RUN.starting) return false;
    if (['waiting-approval', 'queued', 'running', 'done'].indexOf(sj.state) < 0) return false;
    var m = localMeta(); if (m && m.engineJob !== sj.id) m = null;
    var p = sj.plan, sc = sceneById(p.sceneId);
    var track = m && trackById(m.trackId) ? m.trackId : (trackById(sc.defaultTrack) ? sc.defaultTrack : S.trackId);
    var job = localJob(sc, p.sound, track, p.quality, (m && m.thumb) || '');
    job.engineJob = sj.id; job.story = true; job.duration = p.duration; job.sync = p.sync || 'beat';
    job.minutes = Array.isArray(p.estimateMin) ? p.estimateMin : null;
    job.shots = (p.shots || []).map(function (x) { return { id: x.id, title: x.title, lip: !!x.lip, audioStart: null }; });
    job.guest = true; job.host = guestHostName(); job.guestCode = sj.code || '';
    job.createdAt = Date.parse(sj.createdAt) || (m && m.createdAt) || Date.now();
    if (m && m.own) job.own = m.own;
    if (p.sound === 'own' && !job.own && S.own) job.own = { id: S.own.id, name: S.own.name, start: S.own.start };
    startLocalRun(job, { attach: guestHandle(sj), resumed: true, background: !!opts.background });
    return true;
  }
  // What the main button says on a friend's page
  function guestCta(sound) {
    var ses = GG.session, host = guestHostName();
    if (!ses) return { main: 'Make my video', sub: GV.tried ? 'Ask your friend for a new link' : 'Connecting to your friend’s PC…' };
    if (!ses.guest.name) return { main: 'Make my video', sub: 'Tell ' + host + ' your name first' };
    if (ses.state === 'closing') return { main: 'Make my video', sub: host + ' has stopped sharing' };
    if (ses.limits && ses.limits.left <= 0) return { main: 'Make my video', sub: 'No videos left today · more after ' + guestResetText(ses.limits.resetAt) };
    if (sound === 'ai' && !singingOk()) return { main: 'Make my video', sub: 'This scene needs ' + host + '’s Singing add-on' };
    var sc = sceneById(S.sceneId), m = localRange(planFor(sc, { sound: sound }));
    if (NARROW()) return { main: 'Make my video', sub: S.duration + ' s · Free · ~' + half(m[0]) + '–' + half(m[1]) + ' min on ' + host + '’s PC' };
    return { main: 'Make my video', sub: S.duration + ' s · Free · ' + rangeText(m) + ' on ' + host + '’s PC' };
  }
  function guestTempo(job) {
    if (job.sound === 'ai') return null;
    var t = tempoOf(job.sound, job.trackId);
    if (!t || !(t.bpm > 0)) return null;
    return { bpm: clamp(Math.round(t.bpm), 40, 240), feel: GS.tempoFeel(t.bpm, t.energy) };
  }
  function guestPlanRequest(job) {
    return { v: 1, sceneId: job.sceneId, duration: job.duration, sound: job.sound, sync: job.sync || 'beat', quality: job.quality, tempo: guestTempo(job),
      audio: job.sound === 'own' && !!job.lipStarts && job.lipStarts.some(function (x) { return x != null; }) };
  }
  // the host's plan must be the one this page planned (same scenes.json, same rules); anything else is a bug
  function guestSamePlan(job, sp) {
    if (!sp || !Array.isArray(sp.shots) || sp.shots.length !== job.shots.length || sp.sound !== job.sound) return false;
    for (var i = 0; i < sp.shots.length; i++) {
      var a = sp.shots[i], b = job.shots[i];
      if (a.id !== b.id || !!a.lip !== !!b.lip) return false;
      // (my song's lip starts are only in the job request, so the plan answers them with null)
      if (job.lipStarts && b.lip && typeof a.offset === 'number' && Math.abs(a.offset - job.lipStarts[i]) > 0.0015) return false;
    }
    return true;
  }
  async function onMakeGuest(opts) {
    var ses = GG.session, host = guestHostName();
    if (!ses && !GV.tried) { toast('Connecting to your friend’s PC — one moment.', 'info', 3000); return; }
    if (!ses) { afterSession(); attention(el.gate); toast('This link doesn’t work any more — ask your friend for a new one.', 'warn', 5000); return; }
    if (!ses.guest.name) { attention(el.gate); return; }
    if (ses.state === 'closing') { toast(host + ' has stopped sharing, so no new videos can start.', 'warn', 6000); return; }
    if (ses.limits && ses.limits.left <= 0) { toast((ses.limits.usedToday >= ses.limits.daily ? (ses.limits.daily === 1 ? 'You’ve made your 1 video for today' : 'You’ve made all ' + ses.limits.daily + ' videos for today') : 'No more videos today') + ' on ' + host + '’s PC. You can make more after ' + guestResetText(ses.limits.resetAt) + '.', 'warn', 7000); return; }
    var sc = sceneById(S.sceneId), sound = effSound(sc);
    if (sound === 'ai' && !singingOk()) { toast(sc.name + ' needs ' + host + '’s Singing add-on, which isn’t installed on their PC. Pick another scene, or use your own song.', 'warn', 7000); attention(el.sceneCard); return; }
    if (sound === 'own' && !S.own) { toast('Choose your song first.', 'warn'); attention(el.soundCard); openOwnPicker(); return; }
    if (!photoReady()) return;
    if (!canRecord()) { refuseUnsupported(); return; }
    RUN.starting = true;
    var sj = null, sp = null, plan, job;
    try {
      // a video already on its way (another tab, or the page was closed): follow that one instead of a new one
      try { sj = await GG.current(); } catch (e) { sj = null; }
      if (!sj || ['waiting-approval', 'queued', 'running', 'done'].indexOf(sj.state) < 0) {
        sj = null;
        plan = planFor(sc, { sound: sound });
        job = localJob(sc, sound, S.trackId, plan.quality, S.photo.thumb, plan);
        sp = await GG.plan(guestPlanRequest(job));
      }
    } catch (e) {
      RUN.starting = false;
      var v = guestErrorView(e, null);
      toast(v.t + (v.p ? ' — ' + v.p : ''), 'warn', 7000);
      if (e && (e.code === 'no-session' || e.code === 'blocked')) afterSession();
      return;
    }
    RUN.starting = false;
    if (sj) { toast('You already have a video on ' + host + '’s PC — here it is.', 'info', 4500); guestAttachJob(sj, {}); return; }
    if (!guestSamePlan(job, sp.plan)) {
      console.warn('[glow-ai] the host planned this video differently', job.shots, sp.plan);
      toast('Something went wrong — reload the page and try again.', 'error', 8000);
      return;
    }
    if (Array.isArray(sp.plan.estimateMin)) job.minutes = sp.plan.estimateMin;
    job.guestQueue = sp.queue || null;
    startLocalRun(job, {});
  }
  // the request for the host (GlowGuest.submit): the choices, the re-encoded selfie, the WAV part of my song
  async function guestRequest(sc, job) {
    if (!S.photo || !S.consent) throw Object.assign(new Error('Add your selfie and tick the box first.'), { name: 'GlowGuestError', code: 'consent' });
    var r = { v: 1, sceneId: job.sceneId, duration: job.duration, sound: job.sound, sync: job.sync || 'beat', quality: job.quality, tempo: guestTempo(job),
      lipStarts: job.lipStarts && job.lipStarts.some(function (x) { return x != null; }) ? job.lipStarts : null, seed: null, consent: { own: true, adult: true } };
    setStep('still', null, 'Preparing your photo…');
    var photo = await GG.preparePhoto(S.photo.blob);
    var audio = null, start = job.own ? job.own.start : (S.own ? S.own.start : 0);
    if (r.lipStarts) {
      if (!S.own || !S.own.buffer) throw Object.assign(new Error('Your song isn’t loaded any more.'), { name: 'GlowGuestError', code: 'own-missing' });
      var maxLip = Math.max.apply(null, r.lipStarts.filter(function (x) { return x != null; }));
      audio = GG.wavSegment(S.own.buffer, start, Math.max(job.videoSeconds || 0, maxLip + 5) + 0.1);
    }
    return { request: r, photo: photo.blob, audio: audio, ownStart: start };
  }
  function guestMade(job, res) { if (res && res.code) job.guestCode = res.code; }
  // queue, approval and connection news from the host (the usual stages go to localProgress)
  function guestProgress(job, p) {
    var host = guestHostName();
    if (p.code && p.code !== job.guestCode) { job.guestCode = p.code; guestKeepOpen(job); }
    if (p.sharing && p.sharing !== UI.guestSharing) {
      UI.guestSharing = p.sharing; guestKeepOpen(job);
      if (p.sharing === 'closing') announce(host + ' has stopped sharing. Keep this page open until your video is saved.');
    }
    if (p.stage === 'accepted') { refreshGuestSession(); return true; }
    if (p.stage === 'made') return true;
    if (p.reconnecting) {
      // can't reach the PC: the wait is not counted down meanwhile (nothing is known)
      if (p.lost) UI.guestLost = true;
      holdMsg(p.message || 'Reconnecting…', p.lost ? 600000 : 8000);
      tick();
      return true;
    }
    if (UI.guestLost) { UI.guestLost = false; UI.hold = 0; }
    if (p.stage === 'queue' || p.stage === 'approval') {
      // nothing is being made yet: no spinner, no countdown — where it stands and how long it takes once it starts
      if (UI.stage !== 'still') enterStage('still');
      UI.guestWait = { kind: p.stage, ahead: p.ahead || 0, hostBusy: !!p.hostBusy, startMin: Array.isArray(p.startMin) ? p.startMin : null,
        est: Array.isArray(p.estimateMin) ? p.estimateMin : validRange(job.minutes) ? job.minutes : null };
      el.pv.dataset.wait = p.stage;
      el.progTt.textContent = p.stage === 'approval' ? 'Waiting for ' + host : 'In line on ' + host + '’s PC';
      setStep('still', 'wait', p.stage === 'approval' ? 'Waiting for ' + host + '’s OK' : p.hostBusy && !p.ahead ? host + ' is making a video' : p.ahead ? p.ahead + ' video' + (p.ahead > 1 ? 's' : '') + ' ahead of you' : 'You’re next');
      if (p.message && !(UI.hold > Date.now())) setMsg(p.message);
      if (UI.guestStage !== p.stage) announce(p.message || '');
      UI.guestStage = p.stage;
      tick();
      return true;
    }
    if (p.stage !== 'upload') {
      if (!UI.guestRunAt) {
        UI.guestRunAt = Math.min(Date.now(), Date.parse(p.startedAt) || Date.now());
        if (UI.guestStage === 'queue' || UI.guestStage === 'approval') announce('Your video is being made on ' + host + '’s PC');
      }
      if (UI.guestWait) {
        UI.guestWait = null; delete el.pv.dataset.wait;
        el.progTt.textContent = 'Making your video';
        if (UI.stage === 'still') setStep('still', 'active');
      }
      UI.guestStage = p.stage;
    }
    return false;
  }
  // the line under the steps on a friend's page while the video waits, or the PC can't be reached
  function guestEta(job) {
    var host = guestHostName(), w = UI.guestWait;
    if (UI.guestLost) return ' · waiting to reach ' + host + '’s PC';
    if (!w) return null;
    var then = w.est ? 'about ' + half(w.est[0]) + '–' + half(w.est[1]) + ' min' : '';
    if (w.kind === 'approval') return ' · starts when ' + host + ' says OK' + (then ? ', then ' + then : '');
    return then ? ' · then ' + then + ' to make' : '';
  }
  function refreshGuestSession() { GG.refresh().then(function () { renderGuest(); updateCost(); }, function () { /* next time */ }); }
  function guestKeepOpen(job) {
    var host = job.host || guestHostName();
    el.keepOpen.textContent = '';
    el.keepOpen.appendChild(document.createTextNode(UI.guestSharing === 'closing'
      ? host + ' has stopped sharing — keep this page open until your video is saved; the link closes soon after it’s ready.'
      : 'It’s made on ' + host + '’s PC, so it’s free. You can leave this page — come back on this device and it picks up where it is. Keep the page on screen for the last minute so the music and the label can be added.'));
    if (job.guestCode) {
      var c = document.createElement('span'); c.className = 'ai-guest-code';
      c.appendChild(document.createTextNode(' Lost the link? Ask ' + host + ' for the new one and enter this code: '));
      var b = document.createElement('b'); b.textContent = job.guestCode; c.appendChild(b);
      el.keepOpen.appendChild(c);
    }
  }
  function guestErrorView(e, job) {
    var host = guestHostName(), code = (e && e.code) || 'failed', srv = e && e.message && e.name === 'GlowGuestError' ? String(e.message) : '';
    var refunded = ' It didn’t count toward your videos for today.';
    if (e && e.kind === 'finish') return null;
    setTimeout(refreshGuestSession, 0);
    switch (code) {
      case 'daily-limit': return { tt: 'Video not made', t: 'No videos left today', p: 'You’ve made all your videos for today on ' + host + '’s PC. You can make more after ' + guestResetText(e.resetAt) + '.', a: [] };
      case 'active-job': return { t: 'You already have a video on its way', p: 'Close this and tap “Make my video” to follow it.', a: [] };
      case 'blocked': return { tt: 'Video not made', t: host + ' stopped sharing with you', p: 'You can’t make more videos with this link.', a: [] };
      case 'no-session': return { t: 'This link stopped working', p: 'Ask ' + host + ' for a new link. If you were making a video, open the new link and enter your code.', a: [] };
      case 'not-accepting': return { tt: 'Video not made', t: host + ' has stopped sharing', p: 'No new videos can start right now. Ask ' + host + ' to share again.', a: [] };
      case 'queue-full': case 'busy': return { t: host + '’s PC is busy', p: 'Lots of videos are waiting. Try again in a few minutes.', a: ['retry'] };
      case 'missing-pack': return { t: 'This needs ' + host + '’s Singing add-on', p: 'It isn’t installed on their PC. Pick another scene, or use your own song.', a: ['scene'] };
      case 'consent': return { t: 'Please confirm your photo', p: 'Tick the box under your selfie: it’s you, or you have permission, and they are 18 or older.', a: ['photo'] };
      case 'no-name': return { t: 'Tell ' + host + ' your name first', p: '', a: [] };
      case 'bad-photo': case 'too-large': case 'unsupported-type': return { t: 'This photo didn’t work', p: srv || 'Try another photo — a clear photo of one person.', a: ['photo', 'retry'] };
      case 'bad-audio': case 'unexpected-audio': case 'own-missing': return { t: 'Your song didn’t work for this video', p: srv || 'Choose your song again, or try another part of it.', a: ['sound', 'retry'] };
      case 'declined': return { tt: 'Video not made', t: host + ' didn’t approve this video', p: refunded.trim() + ' You can try another scene or photo.', a: ['scene'] };
      case 'cancelled': {
        var why = e.reason === 'guest-cancelled' ? 'You cancelled this video.' : e.reason === 'sharing-stopped' ? host + ' stopped sharing, so this video wasn’t made.'
          : e.reason === 'blocked' ? host + ' cancelled this video.' : host + ' cancelled this video on their PC.';
        var stopped = e.reason === 'sharing-stopped' || e.reason === 'blocked';
        return { tt: 'Video cancelled', t: stopped ? host + ' stopped sharing' : 'This video was cancelled', p: why + (e.reason === 'blocked' ? '' : refunded), a: stopped ? [] : ['retry'] };
      }
      case 'sharing-stopped': return { tt: 'Video not made', t: host + ' stopped sharing', p: e.made ? 'Your video was made, but ' + host + ' stopped sharing before it reached this phone. Ask ' + host + ' to share again.' : 'This video wasn’t made.' + refunded, a: [] };
      case 'expired': return { tt: 'Video expired', t: 'This video expired', p: 'It wasn’t picked up within a day, so ' + host + '’s PC deleted it.', a: ['retry'] };
      case 'engine': case 'host-stopped': return { t: host + '’s PC couldn’t make this video', p: host + '’s PC had a problem making this video. Try again later —' + refunded.replace(/^ It/, ' it'), a: ['retry'] };
      case 'gone': return { t: 'This video is no longer on ' + host + '’s PC', p: srv || 'It may have been saved in another tab already.', a: ['retry'] };
      case 'network': return { t: 'Can’t reach ' + host + '’s PC', p: 'Check your connection. ' + host + ' may have stopped sharing — if so, ask for a new link.', a: ['retry'] };
      case 'slow-down': case 'too-many-attempts': return { t: 'One moment, please', p: 'Too many tries in a short time. Wait a minute, then try again.', a: ['retry'] };
      case 'bad-request': return { t: 'Something went wrong', p: 'Reload the page and try again.', a: [] };
      default: return { t: 'The video couldn’t be made', p: srv || 'Something went wrong on ' + host + '’s PC. Please try again.', a: ['retry'] };
    }
  }
  // "I have a code" (a new link after the old one stopped working) and "Change name", in the friend's card
  function guestCodeSubmit(e) {
    e.preventDefault();
    var v = el.gCodeIn.value.trim();
    if (!/^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$/.test(v)) { el.gCodeMsg.textContent = 'The code looks like ABCDE-12345.'; return; }
    if (running()) { el.gCodeMsg.textContent = 'Wait until the video on screen is done.'; return; }
    el.gCodeGo.disabled = true; el.gCodeMsg.textContent = '';
    GG.claim(v).then(function (sj) {
      el.gCodeGo.disabled = false; GV.codeOpen = false; el.gCodeIn.value = ''; renderGuest();
      if (sj && guestAttachJob(sj, {})) toast('Found your video — picking it up.', 'ok', 3500);
      else toast('That video is already done or gone.', 'info', 4000);
    }, function (er) {
      el.gCodeGo.disabled = false;
      el.gCodeMsg.textContent = er && (er.code === 'bad-code' || er.status === 404) ? 'That code didn’t match a video. Check it and try again.' : er && er.code === 'too-many-attempts' ? 'Too many tries — wait a few minutes.' : 'That didn’t work — try again.';
    });
  }
  function guestNameSubmit(e) {
    e.preventDefault();
    var v = el.gNameIn.value.trim();
    if (!v) { el.gNameMsg.textContent = 'Type your name first.'; return; }
    el.gNameGo.disabled = true;
    GG.setName(v).then(function () { el.gNameGo.disabled = false; GV.nameOpen = false; el.gNameMsg.textContent = ''; renderGuest(); }, function (er) {
      el.gNameGo.disabled = false;
      el.gNameMsg.textContent = er && er.code === 'bad-name' ? 'Please use letters, numbers and simple punctuation (up to 24 characters).' : 'That didn’t work — try again.';
    });
  }
  function guestBoot() {
    el.gCard = $('#aiGuestCard'); el.gBadgeT = $('#aiGuestBadgeT'); el.gLeft = $('#aiGuestLeft'); el.gNote = $('#aiGuestNote'); el.gMe = $('#aiGuestMe');
    el.gCodeBtn = $('#aiGuestCodeBtn'); el.gNameBtn = $('#aiGuestNameBtn'); el.gCodeBox = $('#aiGuestCodeBox'); el.gCodeIn = $('#aiGuestCodeIn'); el.gCodeGo = $('#aiGuestCodeGo'); el.gCodeMsg = $('#aiGuestCodeMsg');
    el.gNameBox = $('#aiGuestNameBox'); el.gNameIn = $('#aiGuestNameIn'); el.gNameGo = $('#aiGuestNameGo'); el.gNameMsg = $('#aiGuestNameMsg');
    el.gate = $('#aiGate'); el.gPrivacy = $('#aiGuestPrivacy');
    document.documentElement.setAttribute('data-guest', '1');
    if (el.gCodeBtn) el.gCodeBtn.addEventListener('click', function () { GV.codeOpen = !GV.codeOpen; GV.nameOpen = false; renderGuest(); if (GV.codeOpen) el.gCodeIn.focus(); });
    if (el.gNameBtn) el.gNameBtn.addEventListener('click', function () { GV.nameOpen = !GV.nameOpen; GV.codeOpen = false; if (GV.nameOpen && GG.session) el.gNameIn.value = GG.session.guest.name || ''; renderGuest(); if (GV.nameOpen) el.gNameIn.focus(); });
    if (el.gCodeBox) el.gCodeBox.addEventListener('submit', guestCodeSubmit);
    if (el.gNameBox) el.gNameBox.addEventListener('submit', guestNameSubmit);
    GG.onSession = function () { if (!running()) { guestRefresh(); } else renderGuest(); };
    renderGuest();
    GG.start().then(afterSession, afterSession);
    // after a while in the background (phone locked), look again: blocked, sharing stopped, a new day's videos
    document.addEventListener('visibilitychange', function () { if (!document.hidden && GG.session && !running()) GG.refresh().then(afterSession, function () { /* offline */ }); });
  }

  /* ------------------------------------------------------------------ *
   * See yourself in every scene (free AI on this PC): quick 5 s Fast previews of the ticked scenes, one at a time,
   * made from the selfie after the consent box is ticked. Each one gets the burned-in "AI-generated" label before it
   * is kept (IndexedDB, "previews") and shown on its scene card. A real video always comes first: making one pauses
   * the queue (Resume continues it). A preview cut off by closing the window is made again, never offered as a video.
   * ------------------------------------------------------------------ */
  var SEE_DEFAULT = ['vip-exit', 'party-hall', 'famous-street', 'club-exit-sing'];
  var SEE = { running: false, queue: [], done: [], failed: [], cur: null, pct: 0, ctl: null, photoSeq: 0, saved: {}, ticked: null, open: false, wait: 0, resumeAfter: false };
  (function () { var t = lsJSON('glow.ai.see'); SEE.ticked = t && Array.isArray(t.ticked) ? t.ticked : SEE_DEFAULT.slice(); if (t && Array.isArray(t.queue)) SEE.queue = t.queue; })();
  function seeSave() { lsSet('glow.ai.see', JSON.stringify({ ticked: SEE.ticked, queue: SEE.queue })); }
  function seeAvailable() { return !GUEST && isLocal() && !!LOC.api && !LOC.gone && localState() === 'ready'; }
  // a preview already made from this same selfie (making it again would only cost the user time)
  function seeFresh(id) { var r = SEE.saved[id]; return !!(r && S.photo && r.photoKey && r.photoKey === S.photo.key); }
  // the ticked scenes that still need a preview of this selfie, in the order of the scene list
  function seeTodo() { return SCENES.map(function (sc) { return sc.id; }).filter(function (id) { return SEE.ticked.indexOf(id) >= 0 && !seeFresh(id); }); }
  function seeMinutes(n) {
    var m = [2.5, 4];
    try { m = LOC.api.estimate({ quality: 'fast' }).minutes; } catch (e) { /* defaults */ }
    return [Math.round(m[0] * n * 10) / 10, Math.round(m[1] * n * 10) / 10];
  }
  function renderSee() {
    if (!el.see) return;
    var show = seeAvailable() && !!S.photo && S.consent;
    el.see.hidden = !show && !SEE.running;
    renderSeeTop(show);
    if (el.see.hidden) return;
    // the scene chips (rebuilt only when needed, so focus stays put)
    if (!el.seeList.children.length) {
      SCENES.forEach(function (sc) {
        var lab = document.createElement('label'); lab.className = 'ai-see-chip'; lab.dataset.scene = sc.id;
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = sc.id;
        cb.addEventListener('change', function () {
          var i = SEE.ticked.indexOf(sc.id);
          if (cb.checked && i < 0) SEE.ticked.push(sc.id); else if (!cb.checked && i >= 0) SEE.ticked.splice(i, 1);
          seeSave(); renderSee();
        });
        var sp = document.createElement('span'); sp.textContent = sc.name;
        var st = document.createElement('i'); st.className = 'ai-see-st'; st.setAttribute('aria-hidden', 'true');
        lab.appendChild(cb); lab.appendChild(sp); lab.appendChild(st);
        el.seeList.appendChild(lab);
      });
    }
    // a short list first (the ticked scenes stay visible); "+ more" shows every scene
    if (!el.seeMore) {
      el.seeMore = document.createElement('button'); el.seeMore.type = 'button'; el.seeMore.className = 'ai-see-more';
      el.seeMore.addEventListener('click', function () { SEE.open = !SEE.open; renderSee(); if (SEE.open) { var f = el.seeList.querySelector('.ai-see-chip:nth-child(7) input'); if (f) try { f.focus(); } catch (e) { /* ignore */ } } });
      el.seeList.appendChild(el.seeMore);
    }
    var shown = 0, extra = 0;
    Array.prototype.forEach.call(el.seeList.querySelectorAll('.ai-see-chip'), function (lab, i) {
      var vis = SEE.open || i < 6 || SEE.ticked.indexOf(lab.dataset.scene) >= 0;
      lab.hidden = !vis; if (vis) shown++; else extra++;
    });
    el.seeMore.hidden = !SEE.open && !extra;
    el.seeMore.textContent = SEE.open ? 'Fewer' : '+ ' + extra + ' more';
    el.seeMore.setAttribute('aria-expanded', SEE.open ? 'true' : 'false');
    Array.prototype.forEach.call(el.seeList.querySelectorAll('.ai-see-chip'), function (lab) {
      var id = lab.dataset.scene, cb = lab.querySelector('input');
      cb.checked = SEE.ticked.indexOf(id) >= 0;
      cb.disabled = SEE.running;
      var state = SEE.cur === id ? 'making' : seeFresh(id) ? 'done' : SEE.queue.indexOf(id) >= 0 ? 'queued' : SEE.failed.indexOf(id) >= 0 ? 'failed' : '';
      lab.dataset.state = state;
      lab.querySelector('.ai-see-st').textContent = state === 'making' ? Math.round(SEE.pct * 100) + '%' : state === 'done' ? '✓' : state === 'queued' ? '·' : '';
    });
    var todo = SEE.running || SEE.queue.length ? SEE.queue.length : seeTodo().length;
    var m = seeMinutes(Math.max(1, todo));
    el.seeTime.textContent = todo ? todo + ' preview' + (todo > 1 ? 's' : '') + ' · ' + rangeText(m) + ' in all on this PC' + (SEE.running ? '' : ' · 5 s each, Fast quality') + ' · keep this window open on screen (they pause while it is minimized)' :
      SEE.ticked.length ? 'Your previews are on the scene cards. Tick more scenes to add them.' : 'Tick the scenes you want to see yourself in.';
    el.seeGo.hidden = SEE.running;
    el.seeGo.disabled = !todo;
    el.seeGo.textContent = !SEE.running && SEE.queue.length ? 'Resume previews (' + SEE.queue.length + ' left)' : 'Make my previews';
    el.seeStop.hidden = !SEE.running;
    el.seeClear.hidden = SEE.running || !SEE.queue.length;
    var cur = SEE.cur ? sceneById(SEE.cur).name : '';
    el.seeSt.textContent = SEE.running ? (cur ? 'Making ' + cur + ' · ' + Math.round(SEE.pct * 100) + '% · ' + (SEE.done.length + 1) + ' of ' + (SEE.done.length + SEE.queue.length) : 'Waiting for the free AI…') : '';
  }
  // Above the scene cards (where "show me an example first" is answered): a one-line way to start the previews,
  // or how they are getting on; and, whenever previews are kept on this PC, a way to remove them.
  function renderSeeTop(show) {
    var saved = Object.keys(SEE.saved).length;
    if (el.seeKept) {
      el.seeKept.hidden = !saved || SEE.running;
      if (saved) el.seeKeptT.textContent = 'Your ' + (saved === 1 ? 'quick preview is' : saved + ' quick previews are') + ' kept on this PC so the cards can show ' + (saved === 1 ? 'it' : 'them') + '.';
    }
    if (!el.seeTop) return;
    var todo = SEE.running || SEE.queue.length ? SEE.queue.length : seeTodo().length;
    el.seeTop.hidden = !(SEE.running || (show && todo > 0 && !running()));
    if (el.seeTop.hidden) return;
    var cur = SEE.cur ? sceneById(SEE.cur).name : '';
    if (SEE.running) {
      el.seeTopT.textContent = cur ? 'Making your preview of ' + cur + ' · ' + Math.round(SEE.pct * 100) + '% · ' + (SEE.done.length + 1) + ' of ' + (SEE.done.length + SEE.queue.length) : 'Your previews are waiting for the free AI…';
      el.seeTopGo.hidden = true;
    } else {
      el.seeTopT.textContent = 'See yourself in ' + todo + ' scene' + (todo > 1 ? 's' : '') + ' first · ' + rangeText(seeMinutes(todo)) + ', free';
      el.seeTopGo.hidden = false;
      el.seeTopGo.textContent = SEE.queue.length ? 'Resume' : 'Start';
    }
    el.seeTopMore.textContent = SEE.running ? 'Details' : 'Choose scenes';
  }
  // Remove every kept preview (or one scene's): from this PC and from the cards.
  function removePreviews(id) {
    var ids = id ? [id] : Object.keys(SEE.saved);
    ids.forEach(function (k) { delete SEE.saved[k]; });
    xidb('previews', 'readwrite', function (st) { if (id) return st.delete(id); return st.clear(); }).catch(function () { /* in memory only */ });
    updateCardPreviews(); renderSee();
    toast(id ? 'That preview was removed from this PC.' : 'Your previews were removed from this PC.', 'ok', 3000);
  }
  // A real video interrupted the previews: they go on by themselves once it is done.
  function seeAutoResume() {
    if (!SEE.resumeAfter || SEE.running || running() || RUN.starting) return;
    SEE.resumeAfter = false;
    if (!SEE.queue.length || !S.photo || !S.consent || !seeAvailable()) { renderSee(); return; }
    toast('Your previews go on now.', 'info', 3500);
    seeStart();
  }
  function seeStart() {
    if (SEE.running) return;
    if (!photoReady()) return;
    if (!canRecord()) { refuseUnsupported(); return; }
    if (running() || RUN.starting) { toast('Your video is being made — the previews can start when it’s done.', 'info', 4000); return; }
    ensureAudio();
    if (!SEE.queue.length || SEE.photoSeq !== S.photo.seq) SEE.queue = seeTodo();
    if (!SEE.queue.length) { renderSee(); return; }
    SEE.photoSeq = S.photo.seq; SEE.running = true; SEE.done = []; SEE.failed = [];
    seeSave(); renderSee(); cardsWake();
    announce('Making ' + SEE.queue.length + ' previews');
    seeNext();
  }
  function seePause(msg) {
    if (!SEE.running) return;
    SEE.running = false;
    try { if (SEE.ctl) SEE.ctl.abort(); } catch (e) { /* ignore */ }
    SEE.cur = null; clearTimeout(SEE.wait);
    seeSave(); renderSee(); cardsWake();
    if (msg) toast(msg, 'info', 4500);
  }
  function seeInterrupted() { SEE.running = false; SEE.cur = null; renderSee(); cardsWake(); }
  async function seeNext() {
    if (!SEE.running) return;
    clearTimeout(SEE.wait);
    var id = SEE.queue[0];
    if (!id) { SEE.running = false; SEE.cur = null; seeSave(); renderSee(); cardsWake(); toast('Your previews are ready — see them on the scene cards.', 'ok', 4500); announce('Your previews are ready'); return; }
    // a real video, another window, the setup, or a hidden window: wait a moment and look again
    if (running() || RUN.starting || LOC.api.isBusy() || !seeAvailable()) { SEE.wait = setTimeout(seeNext, 2500); return; }
    if (!S.photo || S.photo.seq !== SEE.photoSeq || !S.consent) { seePause(); return; }
    if (!(await acquireLocalLock())) { SEE.wait = setTimeout(seeNext, 4000); return; }
    var sc = sceneById(id), photoSeq = SEE.photoSeq, photoKey = S.photo.key;
    SEE.cur = id; SEE.pct = 0; renderSee();
    var ctl = SEE.ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var pjob = { kind: 'preview', engine: 'local', sceneId: id, sound: 'none', createdAt: Date.now(), engineJob: null };
    saveLocalMeta(pjob);
    var alive = function () { if (!SEE.running || SEE.cur !== id || SEE.photoSeq !== photoSeq) throw CANCELLED; };
    try {
      var shot = sc.story ? keyShot(sc) : null;
      var req = localRequest(sc, 'music', 'fast', localPack('fast'), shot, '');
      req.photo = S.photo.blob;
      if (ctl) req.signal = ctl.signal;
      var res = await LOC.api.generate(req, function (p) {
        if (SEE.cur !== id) return;
        if (p.job && !pjob.engineJob) { pjob.engineJob = p.job; saveLocalMeta(pjob); }
        SEE.pct = clamp(+p.overall || 0, 0, 1) * 0.9; renderSee();
      });
      if (res && res.stillUrl) { try { URL.revokeObjectURL(res.stillUrl); } catch (x) { /* ignore */ } }
      alive();
      // the label is burned in before the preview is kept anywhere
      while (document.hidden) { await wait(500); alive(); }
      var fin = await finishClips({ engine: 'local', sound: 'none', sceneId: id }, [{ blob: res.video, id: 'p', lipSync: false }], sc,
        { silent: true, size: { w: 360, h: 624 }, canvas: document.createElement('canvas'), host: seeHost(), check: alive, transitions: false, punches: false,
          onFrac: function (f) { SEE.pct = 0.9 + 0.1 * f; renderSee(); } });
      alive();
      var rec = { id: id, sceneId: id, blob: fin.blob, type: fin.type, at: Date.now(), labelled: true, photoKey: photoKey };
      SEE.saved[id] = rec;
      xidb('previews', 'readwrite', function (st) { return st.put(rec); }).catch(function (e) { console.warn('[glow-ai] preview not kept', e); });
      SEE.queue.shift(); SEE.done.push(id);
      updateCardPreviews();
    } catch (e) {
      if (e === CANCELLED || (e && e.name === 'AbortError') || !SEE.running) { /* paused or cancelled */ }
      else {
        console.warn('[glow-ai] preview failed', id, e);
        if (e && (e.code === 'busy')) { /* try again in a moment */ }
        else { SEE.queue.shift(); SEE.failed.push(id); if (SEE.failed.length === 1) toast('The preview of ' + sc.name + ' didn’t work — going on with the next one.', 'warn', 4500); }
        if (e && /not-installed|missing-model|driver|vcredist|oom/.test(e.code || '')) { seePause(); toast((e && e.message) || 'Free AI on this PC stopped.', 'warn', 6000); }
      }
    } finally {
      var m = localMeta(); if (m && m.kind === 'preview') clearLocalMeta();
      if (!running() && !RUN.starting) releaseLocalLock(); // (a video that started meanwhile holds the lock now)
      if (SEE.cur === id) SEE.cur = null;
      seeSave(); renderSee();
    }
    if (SEE.running) SEE.wait = setTimeout(seeNext, 300);
  }
  function seeHost() { var h = document.getElementById('aiSeeHost'); if (!h) { h = document.createElement('div'); h.id = 'aiSeeHost'; h.className = 'ai-see-host'; h.setAttribute('aria-hidden', 'true'); document.body.appendChild(h); } return h; }
  function loadSeePreviews() {
    return xidb('previews', 'readonly', function (st) { return st.getAll(); }).then(function (all) {
      (all || []).forEach(function (r) { if (r && r.labelled && r.blob instanceof Blob) SEE.saved[r.sceneId] = r; });
      updateCardPreviews(); renderSee();
    }).catch(function () { /* none kept */ });
  }

  /* ------------------------------------------------------------------ *
   * Selfie
   * ------------------------------------------------------------------ */
  var photoSeq = 0, decoding = false;
  function looksLikeImage(f) { return (f.type && f.type.indexOf('image/') === 0) || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif|tiff?)$/i.test(f.name || ''); }
  function isHeic(f) { return /hei[cf]$/i.test(f.type || '') || /\.(heic|heif)$/i.test(f.name || ''); }
  async function decodeImage(file) {
    var bmp = null;
    if (typeof window.createImageBitmap === 'function') {
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = null; }
    }
    if (bmp && bmp.width && bmp.height) return { src: bmp, w: bmp.width, h: bmp.height, close: function () { if (bmp.close) bmp.close(); } };
    var url = URL.createObjectURL(file);
    try {
      var img = new Image();
      img.decoding = 'async';
      await new Promise(function (res, rej) { img.onload = res; img.onerror = function () { rej(new Error('decode failed')); }; img.src = url; });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: function () { URL.revokeObjectURL(url); } };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }
  function drawScaled(src, w, h, maxSide) {
    var s = Math.min(1, maxSide / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = true; try { x.imageSmoothingQuality = 'high'; } catch (e) { /* older */ }
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); // flatten transparency for JPEG
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function toBlob(c, type, q) {
    return new Promise(function (res, rej) {
      if (c.toBlob) c.toBlob(function (b) { if (b) res(b); else rej(new Error('encode failed')); }, type, q);
      else { try { var d = c.toDataURL(type, q), bin = atob(d.split(',')[1]), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); res(new Blob([a], { type: type })); } catch (e) { rej(e); } }
    });
  }
  async function setPhotoFile(file) {
    if (!file) return;
    if (!looksLikeImage(file)) { toast('That file doesn’t look like a photo. Try a JPG, PNG or HEIC.', 'warn'); return; }
    if (decoding) return;
    if (running()) { toast('A video is being made right now — you can change the photo when it’s done.', 'warn'); return; }
    decoding = true;
    el.photoStatus.textContent = 'Opening your photo…';
    try {
      var d = await decodeImage(file);
      try {
        if (Math.min(d.w, d.h) < 300) { toast('This photo is very small. Please use a photo at least 300 px on each side.', 'warn', 5000); return; }
        var r = d.w / d.h;
        if (r < 0.4 || r > 2.5) { toast('This photo is very long and thin. Please use a normal portrait or square photo.', 'warn', 5000); return; }
        // Re-encoding through a canvas also strips EXIF (location, device) before anything is uploaded.
        var full = drawScaled(d.src, d.w, d.h, 1536);
        var blob = await toBlob(full, 'image/jpeg', 0.9);
        var small = drawScaled(full, full.width, full.height, 1024).toDataURL('image/jpeg', 0.86);
        var thumb = drawScaled(full, full.width, full.height, 200).toDataURL('image/jpeg', 0.8);
        full.width = 1; full.height = 1;
        if (S.photo && S.photo.url) URL.revokeObjectURL(S.photo.url);
        // key: the same photo file picked again (also after a reload) is recognised, so its previews are not made twice
        var key = 'p' + seedOf([file.name || '', file.size || 0, file.lastModified || 0, d.w, d.h].join('|')).toString(36);
        S.photo = { blob: blob, url: URL.createObjectURL(blob), small: small, thumb: thumb, w: d.w, h: d.h, seq: ++photoSeq, uploaded: null, key: key };
        S.consent = false; // consent is per photo
        if (SEE.running) seePause('Previews stopped — they were for your previous photo.');
        SEE.queue = []; seeSave();
        renderPhoto(); renderSee();
        el.photoStatus.textContent = 'Photo ready — tick the box above to continue.';
        setTimeout(function () { if (el.photoStatus.textContent.indexOf('Photo ready') === 0) el.photoStatus.textContent = ''; }, 4000);
      } finally { d.close(); }
    } catch (e) {
      console.warn('[glow-ai] decode failed', e);
      toast(isHeic(file) ? 'This browser can’t open HEIC photos. On iPhone use Safari, or export the photo as JPG.' : 'That photo couldn’t be opened. Try another one.', 'warn', 6000);
      el.photoStatus.textContent = '';
    } finally {
      decoding = false;
      if (el.photoStatus.textContent === 'Opening your photo…') el.photoStatus.textContent = '';
    }
  }
  function renderPhoto() {
    var has = !!S.photo;
    el.drop.dataset.state = has ? 'photo' : 'empty';
    el.photoCard.classList.toggle('has-photo', has);
    el.selfie.hidden = !has;
    el.pick.hidden = has;
    el.change.hidden = !has;
    el.consentRow.hidden = !has;
    el.consent.checked = !!S.consent;
    el.consentRow.classList.toggle('on', !!S.consent);
    if (has) el.selfieImg.src = S.photo.url; else el.selfieImg.removeAttribute('src');
    updateCost();
  }
  function openPicker() { try { el.file.value = ''; } catch (e) { /* ignore */ } el.file.click(); }

  /* ------------------------------------------------------------------ *
   * Key (stored only on this device)
   * ------------------------------------------------------------------ */
  function getKey() { return lsGet(LS.key) || S.memKey || ''; }
  function normalizeKey(k) { k = String(k || '').trim(); if (/^key\s+/i.test(k)) k = k.replace(/^key\s+/i, '').trim(); return k; }
  function validKey(k) { return /^[\w-]+:[\w-]+$/.test(k); }
  function updateKeyUI() {
    var has = !!getKey();
    el.keyChip.classList.toggle('on', has);
    el.keyChipT.textContent = has ? 'fal.ai' : 'Connect fal.ai';
    el.keyChip.setAttribute('aria-label', has ? 'fal.ai key settings (connected)' : 'Connect your fal.ai account');
    el.keyRemove.hidden = !has;
    renderEngine();
    updateCost();
  }
  var connectThen = null;
  function openConnect(then) {
    connectThen = then || null;
    updateKeyUI();
    el.key.value = '';
    el.key.type = 'password'; el.keyEye.setAttribute('aria-pressed', 'false'); el.keyEye.setAttribute('aria-label', 'Show key');
    var has = !!getKey();
    el.key.placeholder = has ? 'Saved ••••' + getKey().slice(-4) + ' — paste a new key to replace it' : 'key-id:key-secret';
    setKeyMsg(has ? 'A key is saved on this device.' : '', has ? 'ok' : '');
    el.keySave.textContent = then === 'make' ? 'Save & make my video' : 'Save key';
    el.keySave.disabled = false;
    // On phones (and for first-timers who still need to read the steps) don't pop up the keyboard over the steps.
    openSheet(el.conn, has && !COARSE() ? el.key : (el.connT || el.connClose));
    updateCost();
  }
  function COARSE() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  // Coming back from fal.ai with a fresh key copied: put the cursor in the box, ready to paste.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || el.conn.hidden || el.key.value) return;
    setTimeout(function () { if (!el.conn.hidden && !el.key.value) { try { el.key.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, 120);
  });
  function setKeyMsg(t, kind) { el.keyMsg.textContent = t || ''; el.keyMsg.className = 'ai-keymsg' + (kind ? ' ' + kind : ''); }
  async function checkKey(k) {
    try {
      var r = await fetch(PRICING_URL, { method: 'GET', headers: { 'Authorization': 'Key ' + k }, credentials: 'omit', cache: 'no-store' });
      var b = null; try { b = await r.json(); } catch (e) { b = null; }
      if (r.ok) { applyPrices(b && b.prices); return 'ok'; }
      if (r.status === 401 || r.status === 403) return 'bad';
      return 'unknown';
    } catch (e) { return 'offline'; }
  }
  async function saveKey() {
    var k = normalizeKey(el.key.value);
    if (!k && getKey()) { closeSheet(el.conn); afterConnect(); return; }
    if (!k) { setKeyMsg('Paste your fal.ai key first.', 'err'); el.key.focus(); return; }
    if (!validKey(k)) { setKeyMsg('That doesn’t look like a fal.ai key. It has two parts joined by a colon, like “1a2b3c…:9f8e7d…”.', 'err'); el.key.focus(); return; }
    el.keySave.disabled = true;
    setKeyMsg('Checking your key with fal.ai…', '');
    var res = await checkKey(k);
    el.keySave.disabled = false;
    if (res === 'bad') { setKeyMsg('fal.ai didn’t accept this key. Check that you copied all of it, or create a new one.', 'err'); el.key.focus(); return; }
    if (!lsSet(LS.key, k)) { S.memKey = k; toast('This browser blocks saving — your key will be forgotten when you close this tab.', 'warn', 6000); }
    else S.memKey = '';
    updateKeyUI(); updateSoundUI();
    if (res === 'ok') toast('Connected to fal.ai', 'ok');
    else toast('Key saved. We couldn’t reach fal.ai to check it just now.', 'warn', 5000);
    closeSheet(el.conn);
    afterConnect();
  }
  function afterConnect() {
    var then = connectThen; connectThen = null;
    if (resumeWaitingForKey) { resumeWaitingForKey = false; resumeIfAny(); return; }
    if (then === 'make') onMake({ engine: 'fal' });
    else if (then === 'resume' && pausedJob()) onMake({ retry: true, engine: 'fal' });
  }
  function removeKey() {
    lsDel(LS.key); S.memKey = '';
    updateKeyUI();
    setKeyMsg('Key removed from this device.', '');
    toast('Your fal.ai key was removed from this device. To fully revoke it, delete it on fal.ai.', 'ok', 5000);
  }

  /* ------------------------------------------------------------------ *
   * Sheets (modal handling)
   * ------------------------------------------------------------------ */
  var openStack = [], lastFocus = null;
  function bgNodes() { return [el.top, el.modes, el.ai, el.app, document.querySelector('.aurora')].filter(Boolean); }
  function setInert(on) { bgNodes().forEach(function (n) { if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert'); }); el.pill.toggleAttribute('inert', on); }
  // A sensible place for keyboard focus to come back to: the element itself if it is still on screen, else the CTA.
  function usable(n) { return !!(n && n !== document.body && n.focus && document.contains(n) && !n.closest('[hidden]') && n.getClientRects().length); }
  function focusHome() { var n = mode() === 'ai' ? el.make : null; if (n) { try { n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
  function openSheet(m, focusEl) {
    if (!openStack.length) lastFocus = usable(document.activeElement) ? document.activeElement : null;
    if (openStack.indexOf(m) < 0) openStack.push(m);
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    setInert(true);
    cardsWake(); // (the cards rest behind a sheet)
    if (focusEl) setTimeout(function () { try { focusEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
  }
  function closeSheet(m) {
    if (m.hidden) return;
    m.hidden = true;
    openStack = openStack.filter(function (x) { return x !== m; });
    setTimeout(cardsWake, 0);
    if (openStack.length) return;
    // Photo Video's own sheets (export, result) manage the page while they are open.
    if (document.querySelector('.modal:not([hidden])')) return;
    document.body.style.overflow = '';
    setInert(false);
    if (usable(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    else focusHome();
  }

  /* ------------------------------------------------------------------ *
   * fal.ai client
   * ------------------------------------------------------------------ */
  function FalErr(kind, msg, extra) {
    var e = new Error(msg || kind);
    e.name = 'FalError'; e.kind = kind;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  var CANCELLED = { cancelled: true };
  async function falFetch(url, init, withKey) {
    if (withKey && !isFalHost(url)) throw FalErr('server', 'Refused to send the key to a non-fal.ai address');
    init = init || {};
    init.credentials = 'omit';
    init.cache = 'no-store';
    if (withKey) { init.headers = init.headers || {}; init.headers['Authorization'] = 'Key ' + getKey(); }
    var r;
    try { r = await fetch(url, init); }
    catch (e) { throw FalErr('network', 'Couldn’t reach fal.ai', { cause: e }); }
    var text = '', body = null;
    try { text = await r.text(); } catch (e) { text = ''; }
    if (text) { try { body = JSON.parse(text); } catch (e) { body = { detail: text.slice(0, 300) }; } }
    return { ok: r.ok, status: r.status, body: body, headers: r.headers };
  }
  function detailText(body) {
    if (!body) return '';
    var d = body.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map(function (x) { return x && (x.msg || x.type) || ''; }).filter(Boolean).join(' ');
    if (typeof body.error === 'string') return body.error;
    if (body.error && body.error.message) return body.error.message;
    if (typeof body.message === 'string') return body.message;
    return '';
  }
  function classify(status, body, headers) {
    var d = body && body.detail, types = [], cats = [], ctx = null;
    if (Array.isArray(d)) d.forEach(function (x) { if (!x) return; if (x.type) types.push(x.type); if (Array.isArray(x.categories)) cats = cats.concat(x.categories); if (x.ctx) ctx = x.ctx; });
    var msg = detailText(body);
    var etype = '';
    try { etype = (headers && headers.get && headers.get('x-fal-error-type')) || ''; } catch (e) { etype = ''; }
    etype = etype || (body && (body.error_type || (typeof body.type === 'string' ? body.type : ''))) || '';
    var low = (msg + ' ' + etype).toLowerCase();
    var extra = { status: status, detail: msg, types: types, categories: cats, errorType: etype, ctx: ctx };
    function has(t) { return types.indexOf(t) >= 0; }
    if (has('content_policy_violation') || /content[_ ]policy|flagged by a content|content checker|moderation|nsfw|safety (filter|check)/.test(low)) return FalErr('moderation', msg, extra);
    if (status === 401) return FalErr('auth', msg, extra);
    if (status === 402) return FalErr('credit', msg, extra);
    if (status === 403) {
      if (/balance|credit|locked|spend|billing|exhaust|insufficient|payment|funds|top ?up/.test(low)) return FalErr('credit', msg, extra);
      if (etype === 'rejected_key') return FalErr('auth', msg, extra);
      return FalErr('permission', msg, extra);
    }
    if (status === 404) return FalErr('notfound', msg, extra);
    if (status === 413) return FalErr('photo', msg || 'The photo is too large', extra);
    if (status === 429) return FalErr('rate', msg, extra);
    if (status === 499) return FalErr('cancelled', msg, extra);
    if (has('face_detection_error')) return FalErr('face', msg, extra);
    if (has('image_too_small') || has('image_too_large') || has('image_load_error') || has('file_download_error') || has('file_too_large')) return FalErr('photo', msg, extra);
    if (has('no_media_generated')) return FalErr('nomedia', msg, extra);
    if (has('generation_timeout') || has('downstream_service_error') || has('downstream_service_unavailable') || has('internal_server_error')) return FalErr('server', msg, extra);
    if (status === 422 || status === 400) return FalErr('validation', msg, extra);
    if (status >= 500) return FalErr('server', msg, extra);
    return FalErr('server', msg || ('fal.ai replied ' + status), extra);
  }
  function backoff(n) { return Math.min(CFG.maxBackoffMs, CFG.backoffMs * Math.pow(1.6, Math.max(0, n - 1))); }
  function ownerApp(endpoint) { return endpoint.split('/').slice(0, 2).join('/'); }
  function handleOf(endpoint, b) {
    var base = QUEUE + ownerApp(endpoint) + '/requests/' + encodeURIComponent(b.request_id);
    var ok = function (u) { return typeof u === 'string' && isFalHost(u) ? u : null; };
    return {
      endpoint: endpoint, request_id: b.request_id,
      status_url: ok(b.status_url) || base + '/status', response_url: ok(b.response_url) || base, cancel_url: ok(b.cancel_url) || base + '/cancel',
      at: Date.now()
    };
  }

  // Cancellable sleep: cancel and the browser's 'online' event wake it early.
  var RUN = { job: null, cancelled: false, wakers: [], persisted: false, release: null, starting: false };
  function nap(ms) {
    return new Promise(function (res) {
      var done = false, t = 0;
      var fin = function () { if (done) return; done = true; clearTimeout(t); RUN.wakers = RUN.wakers.filter(function (f) { return f !== fin; }); res(); };
      t = setTimeout(fin, ms);
      RUN.wakers.push(fin);
    });
  }
  function wakeAll() { RUN.wakers.slice().forEach(function (f) { f(); }); }
  window.addEventListener('online', function () { wakeAll(); if (running() && RUN.job.engine !== 'local') setMsg('Back online — checking on your video…'); });
  function check(job) { if (RUN.cancelled || RUN.job !== job) throw CANCELLED; }

  async function uploadSelfie(job) {
    var p = S.photo;
    if (!p) throw FalErr('nophoto', 'Your photo is no longer here');
    if (p.uploaded && Date.now() - p.uploaded.at < 20 * 3600e3) return p.uploaded.url;
    var r = await falFetch(UPLOAD_INIT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Fal-Object-Lifecycle': LIFECYCLE },
      body: JSON.stringify({ content_type: 'image/jpeg', file_name: 'selfie.jpg' })
    }, true);
    check(job);
    if (!r.ok) throw classify(r.status, r.body, r.headers);
    var up = r.body || {};
    if (typeof up.upload_url !== 'string' || !/^https:\/\//.test(up.upload_url) || typeof up.file_url !== 'string' || !/^https:\/\//.test(up.file_url)) throw FalErr('upload', 'fal.ai didn’t return an upload address');
    var put;
    try { put = await fetch(up.upload_url, { method: 'PUT', body: p.blob, headers: { 'Content-Type': 'image/jpeg' }, credentials: 'omit' }); }
    catch (e) { throw FalErr('upload', 'The photo upload didn’t go through', { network: true }); }
    check(job);
    if (!put.ok) throw FalErr('upload', 'The photo upload failed (' + put.status + ')');
    p.uploaded = { url: up.file_url, at: Date.now() };
    return up.file_url;
  }
  async function submit(job, endpoint, input) {
    var tries = 0;
    for (;;) {
      check(job);
      claim(job); // a paid request: make sure no other Glow Studio page has taken this job over meanwhile
      var r;
      try {
        // No "X-Fal-Store-IO: 0": with payload storage off fal keeps a result for only an hour, and a user who
        // comes back later would pay again. The request stays in the user's own fal.ai history instead.
        r = await falFetch(QUEUE + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Fal-Object-Lifecycle-Preference': LIFECYCLE },
          body: JSON.stringify(input)
        }, true);
      } catch (e) {
        // Only retry on our own when the browser knows it was offline (so the request never left this device);
        // otherwise a retry could start a second, paid request.
        if (e.kind === 'network' && navigator.onLine === false && tries < 40) { tries++; setMsg('You’re offline — waiting for the connection…'); await nap(8000); continue; }
        throw e;
      }
      if (r.ok && r.body && r.body.request_id) return handleOf(endpoint, r.body);
      var err = r.ok ? FalErr('server', 'Unexpected reply from fal.ai') : classify(r.status, r.body, r.headers);
      if ((err.kind === 'rate' || (r.status >= 500 && err.kind === 'server')) && tries < 4) {
        tries++;
        setMsg(err.kind === 'rate' ? 'fal.ai is busy — trying again in a moment…' : 'fal.ai had a hiccup — trying again…');
        await nap(backoff(tries));
        continue;
      }
      throw err;
    }
  }
  // Errors that say nothing about the generation itself: the request at fal is still good (and may be finished and
  // paid for), so the job keeps its handle and can be picked up again instead of being submitted a second time.
  var LIVE_KINDS = ['auth', 'permission', 'credit', 'rate', 'network'];
  function liveErr(e) { if (e && LIVE_KINDS.indexOf(e.kind) >= 0) e.live = true; return e; }
  // A gateway hiccup (502/503/504 with no structured error from fal) is not a failed generation.
  function gatewayHiccup(r) {
    if (r.status !== 502 && r.status !== 503 && r.status !== 504) return false;
    var b = r.body || {}, et = '';
    try { et = (r.headers && r.headers.get && r.headers.get('x-fal-error-type')) || ''; } catch (e) { et = ''; }
    return !Array.isArray(b.detail) && !b.error_type && !et;
  }
  async function poll(job, h, onStatus) {
    var fails = 0;
    for (;;) {
      check(job);
      var r = null, net = false;
      try { r = await falFetch(h.status_url, { method: 'GET' }, true); } catch (e) { net = true; }
      check(job);
      if (net || r.status === 429 || r.status >= 500) {
        fails++;
        onStatus({ retry: true, offline: net });
        await nap(backoff(fails));
        continue;
      }
      if (!r.ok && r.status !== 202) throw liveErr(classify(r.status, r.body, r.headers));
      fails = 0;
      heartbeat(job);
      var st = r.body && r.body.status;
      if (st === 'COMPLETED') {
        var out = await fetchResult(job, h, onStatus);
        if (out !== NOT_READY) return out;
        continue;
      }
      onStatus({ status: st, position: r.body && r.body.queue_position });
      var slow = Date.now() - (h.at || Date.now()) > CFG.slowAfterMs;
      await nap(slow ? CFG.slowPollMs : CFG.pollMs);
    }
  }
  // GET response_url is read-only and free, so it is repeated on connection trouble (like @fal-ai/client does for
  // 429/502/503/504) until it works. Only a real failure (500, a structured model error, 422, 404, 499) ends it.
  var NOT_READY = { notReady: true };
  async function fetchResult(job, h, onStatus) {
    var fails = 0, firstFail = 0, early = 0;
    for (;;) {
      check(job);
      var r = null, net = false;
      try { r = await falFetch(h.response_url, { method: 'GET' }, true); } catch (e) { net = true; }
      check(job);
      if (!net && r.ok) { if (fails && onStatus) onStatus({ reconnected: true }); return r.body || {}; }
      if (!net && r.status === 400 && /in progress/i.test(detailText(r.body))) {
        if (++early > 20) return NOT_READY; // go back to watching the status
        await nap(1500); continue;
      }
      if (net || r.status === 429 || gatewayHiccup(r)) {
        fails++;
        if (!firstFail) firstFail = Date.now();
        if (Date.now() - firstFail > CFG.resultRetryMs) throw FalErr('network', 'Couldn’t reach fal.ai to collect the result', { live: true });
        if (onStatus) onStatus({ retry: true, offline: net, reconnecting: true });
        heartbeat(job);
        await nap(backoff(fails));
        continue;
      }
      throw liveErr(classify(r.status, r.body, r.headers));
    }
  }
  // PUT cancel_url. Resolves { status, state } where state is fal's answer: OK (left the queue),
  // CANCELLATION_REQUESTED (already running), ALREADY_COMPLETED, NOT_FOUND — or '' if fal couldn't be reached.
  function cancelRemote(h) {
    if (!h || !h.cancel_url || !getKey()) return Promise.resolve({ status: 0, state: '' });
    return falFetch(h.cancel_url, { method: 'PUT' }, true).then(function (r) {
      return { status: r.status, state: (r.body && typeof r.body.status === 'string') ? r.body.status : '' };
    }, function () { return { status: 0, state: '' }; });
  }

  /* ------------------------------------------------------------------ *
   * Job persistence (resume after reload without paying again)
   * ------------------------------------------------------------------ */
  var MEM_ONLY = ['inlineRef', 'localBlob']; // never written to localStorage
  function jobCopy(job) { var copy = {}; Object.keys(job).forEach(function (k) { if (MEM_ONLY.indexOf(k) < 0) copy[k] = job[k]; }); return copy; }
  function saveJob(job) {
    if (RUN.job !== job) return; // cancelled or replaced: never bring it back
    job.beat = Date.now(); job.owner = INST;
    if (lsSet(LS.job, JSON.stringify(jobCopy(job)))) RUN.persisted = true;
  }
  // A job that stopped but still holds something paid for (a live request at fal, or a finished video that still
  // needs finishing). Kept so "Try again" or a reload picks it up instead of paying again.
  function savePaused(job) {
    job.paused = true; job.beat = 0; job.owner = INST;
    lsSet(LS.job, JSON.stringify(jobCopy(job)));
  }
  function clearJob() { lsDel(LS.job); }
  function storedJob() { var j = lsJSON(LS.job); return j && j.v === 1 ? j : null; }
  // Another live page is running the stored job (fallback for browsers without Web Locks).
  function liveElsewhere(j) { return !!(j && !j.paused && j.owner && j.owner !== INST && Date.now() - (j.beat || 0) < CFG.staleBeatMs); }
  // Has another Glow Studio page taken this job over (it claimed the job after our claim looked stale)?
  function lostOwnership(job) {
    var s = storedJob();
    if (!s) return RUN.persisted && lsWorks(); // finished or cancelled by the page that took over
    return s.id !== job.id || (!!s.owner && s.owner !== INST);
  }
  function lsWorks() { var k = 'glow.ai.t'; if (!lsSet(k, '1')) return false; lsDel(k); return true; }
  var lastBeat = 0;
  function heartbeat(job) {
    if (RUN.job !== job) return;
    if (lostOwnership(job)) { standDown(job); throw CANCELLED; }
    if (Date.now() - lastBeat > 2500) { lastBeat = Date.now(); saveJob(job); }
  }
  function claim(job) {
    if (RUN.job !== job) throw CANCELLED;
    if (RUN.persisted && lostOwnership(job)) { standDown(job); throw CANCELLED; }
    lastBeat = Date.now(); saveJob(job);
  }
  // Stop working on a job locally because another page runs it now. Nothing is cancelled at fal.
  function standDown(job) {
    if (RUN.job !== job) return;
    console.warn('[glow-ai] another Glow Studio page is running this video now');
    RUN.job = null; RUN.persisted = false;
    wakeAll(); releaseLock();
    UI.state = 'idle';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer); clearInterval(UI.beatTimer);
    closeProgressSheet(); setPill(null);
    updateCost();
    watchOtherTab();
  }
  function running() { return !!RUN.job; }

  // Web Locks: held for as long as this page runs a job, so a second page (duplicate tab, new window) waits.
  function acquireLock(retried) {
    if (!LOCKS || RUN.release) return Promise.resolve(true);
    return new Promise(function (res) {
      var p;
      try {
        p = navigator.locks.request('glow-ai-job', { ifAvailable: true }, function (lock) {
          if (!lock) { res(false); return null; }
          return new Promise(function (release) { RUN.release = release; res(true); });
        });
      } catch (e) { res(true); return; }
      if (p && p.catch) p.catch(function () { res(true); });
    }).then(function (ok) {
      // a watching page holds the lock for a moment when it checks: ask once more
      if (ok || retried) return ok;
      return wait(200).then(function () { return acquireLock(true); });
    });
  }
  function releaseLock() { var r = RUN.release; RUN.release = null; if (r) r(); }

  /* ------------------------------------------------------------------ *
   * Progress UI
   * ------------------------------------------------------------------ */
  var UI = { stage: 'still', stageAt: {}, startAt: 0, timer: 0, msgTimer: 0, msgIdx: 0, sub: {}, minimized: false, monitorOn: true, state: 'idle',
    pct: 0, pill: null, beatTimer: 0, lastStatus: {}, lastPos: {} };
  var STEP_NAME = { still: 'Placing you in the scene', video: 'Bringing it to life', finish: 'Finishing your video' };
  // what the step list on screen says for this job (a singing video's step 2 is "Making your song & video")
  function stepName(stage) {
    var n = stage === 'video' ? el.videoName : stage === 'finish' ? el.finishName : stage === 'still' ? el.stillName : null;
    return (n && n.textContent.trim()) || STEP_NAME[stage];
  }
  // Screen readers hear real changes (step, place in line, done) from a separate live region, not the rotating fun text.
  function announce(t) {
    if (!el.announce) return;
    el.announce.textContent = '';
    setTimeout(function () { el.announce.textContent = t; }, 60);
  }
  var EXPECT = { still: 30, video: 140, videoAi: 200, finish: 12 };
  var MSGS = {
    still: ['Finding your best angle…', 'Setting up the lights…', 'Inviting the guests…', 'Matching your look exactly…'],
    video: ['Teaching you the moves…', 'Rolling camera…', 'The crowd is warming up…', 'Real motion takes a little while — hang tight.', 'Almost showtime…'],
    finish: ['Adding the finishing touches…']
  };
  function setMsg(t) { el.msg.textContent = t; }
  var KEEP_OPEN_FAL = el.keepOpen ? el.keepOpen.innerHTML : '';
  function setStep(step, state, sub) {
    var li = el.steps.querySelector('[data-step="' + step + '"]');
    if (!li) return;
    if (state) li.dataset.state = state;
    if (sub != null) { var s = $('small', li); if (s) s.textContent = sub; }
  }
  function enterStage(stage, at) {
    var changed = UI.stage !== stage || !UI.stageAt[stage];
    UI.stage = stage;
    UI.stageAt[stage] = UI.stageAt[stage] || Math.min(Date.now(), at || Date.now());
    el.pv.dataset.stage = stage;
    var order = ['still', 'video', 'finish'], k = order.indexOf(stage);
    order.forEach(function (s, i) { setStep(s, i < k ? 'done' : i === k ? 'active' : 'todo'); });
    UI.msgIdx = 0; rotateMsg(true);
    if (changed) announce('Step ' + (k + 1) + ' of 3: ' + stepName(stage));
  }
  function rotateMsg(now) {
    clearTimeout(UI.msgTimer);
    if (UI.state !== 'running') return;
    // free AI on this PC: the engine's own plain-words messages are shown as they come (see localProgress)
    if (RUN.job && RUN.job.engine === 'local' && UI.stage !== 'finish') return;
    var list = MSGS[UI.stage] || MSGS.video;
    if (!now) UI.msgIdx = (UI.msgIdx + 1) % list.length;
    if (!UI.hold || Date.now() > UI.hold) setMsg(list[UI.msgIdx]);
    UI.msgTimer = setTimeout(function () { rotateMsg(false); }, 6500);
  }
  function holdMsg(t, ms) { UI.hold = Date.now() + (ms || 6000); setMsg(t); }
  function stageFrac(stage, job) {
    var at = UI.stageAt[stage];
    if (!at) return 0;
    var T = stage === 'still' ? EXPECT.still : stage === 'video' ? (job && job.sound === 'ai' ? EXPECT.videoAi : EXPECT.video) : EXPECT.finish;
    return Math.min(0.96, 1 - Math.exp(-(Date.now() - at) / 1000 / T));
  }
  function tick() {
    var job = RUN.job;
    if (!job) return;
    var el2 = (Date.now() - UI.startAt) / 1000;
    if (GUEST) {
      // a friend's page counts from when the host's PC really started on it (not while it waits for its turn)
      if (!UI.guestRunAt && (UI.stage === 'finish' || job.made === true)) UI.guestRunAt = Date.now();
      el2 = UI.guestRunAt ? (Date.now() - UI.guestRunAt) / 1000 : 0;
      el.elapsed.textContent = UI.guestRunAt ? fmt(el2) + ' elapsed' : 'Not started yet';
    } else el.elapsed.textContent = fmt(el2) + ' elapsed';
    var order = ['still', 'video', 'finish'], W = { still: 0.18, video: 0.7, finish: 0.12 }, k = order.indexOf(UI.stage), f = 0;
    if (job.engine === 'local') f = UI.stage === 'finish' ? 0.9 + 0.1 * (UI.finishFrac || 0) : 0.9 * (UI.localOverall || 0);
    else if (job.story) f = UI.stage === 'finish' ? 0.88 + 0.12 * (UI.finishFrac || 0) : 0.88 * storyFrac(job);
    else order.forEach(function (s, i) { f += W[s] * (i < k ? 1 : i === k ? (s === 'finish' && UI.finishFrac != null ? UI.finishFrac : stageFrac(s, job)) : 0); });
    var pct = Math.floor(clamp(f, 0, 0.99) * 100);
    UI.pct = pct;
    el.pct.textContent = pct + '%';
    el.cost.textContent = 'Making your video · ' + pct + '%';
    el.ringBar.style.strokeDashoffset = String(100 - pct);
    var h = UI.stage === 'still' ? job.still : job.video;
    if (job.story && job.shots) h = { at: Math.min.apply(null, job.shots.map(function (x) { var y = x.video || x.still; return y && y.at && !x.videoUrl ? y.at : Date.now(); })) };
    var slow = h && h.at && Date.now() - h.at > CFG.slowAfterMs;
    if (UI.stage === 'finish') el.eta.textContent = '';
    else if (GUEST && guestEta(job) != null) el.eta.textContent = guestEta(job);
    else if (job.engine === 'local') { var lft = localLeft(job, el2), all = job.minutes ? rangeText(job.minutes) : localMinutes(job.sound, job.quality, true); el.eta.textContent = ' · ' + lft + (lft ? all.replace(/^about /, '') : all) + ' in all on ' + PCN; }
    else if (slow) el.eta.textContent = ' · taking longer than usual';
    else if (job.story) el.eta.textContent = ' · usually ' + (job.sound === 'ai' ? '3–7' : '2–5') + ' min for all ' + job.shots.length + ' shots';
    else el.eta.textContent = UI.stage === 'still' ? ' · usually under a minute' : (job.sound === 'ai' ? ' · usually 2–5 min' : ' · usually 1–3 min');
    if (slow && !UI.slowSaid) { UI.slowSaid = true; holdMsg('Still working — fal.ai is busier than usual. We’ll keep checking.', 20000); }
    shareNoteLine(job);
    if (UI.pill === 'run') el.pillT.textContent = (UI.stage === 'finish' ? 'Finishing your video' : 'Making your video') + ' · ' + pct + '%';
    // the window's title (the taskbar shows it while the window is minimized)
    setRunTitle(UI.waitVisible ? '✓ Your video is ready to finish' : (UI.stage === 'finish' ? '● Finishing your video ' : '● Making your video ') + pct + '%');
  }
  var BASE_TITLE = document.title;
  // (a friend waiting for the host's OK wins: "(1) Ben wants to make a video — Glow Studio", share.js)
  function setRunTitle(t) { UI.runTitle = t || ''; var v = (window.GlowShare && window.GlowShare.waitTitle) || (t ? t + ' — Glow Studio' : BASE_TITLE); if (document.title !== v) { try { document.title = v; } catch (e) { /* ignore */ } } }
  // "about 12–20 min left": the planned minutes minus the time so far, steered by the engine's own progress
  function localLeft(job, el2) {
    var m = validRange(job.minutes) ? job.minutes : null, ov = UI.localOverall || 0, done = (Date.now() - (UI.guestRunAt || UI.runAt || UI.startAt)) / 60000;
    if (!m || UI.stage === 'finish') return '';
    var lo = m[0] - done, hi = m[1] - done;
    if (ov >= 0.12 && done > 1) { var proj = done / ov * (1 - ov); lo = Math.min(Math.max(lo, proj * 0.8), proj); hi = Math.max(proj * 1.25, Math.min(hi, proj * 1.6)); }
    lo = Math.max(1, Math.round(lo)); hi = Math.max(lo + 1, Math.round(hi));
    return 'about ' + lo + '–' + hi + ' min left · ';
  }
  // fal story: how far the shots are (they run side by side), time-based inside each request like stageFrac()
  function storyFrac(job) {
    var n = job.shots.length, sum = 0, now = Date.now();
    job.shots.forEach(function (x) {
      var st = x.stillUrl || x.videoUrl ? 1 : x.still && x.still.at ? Math.min(0.95, 1 - Math.exp(-(now - x.still.at) / 1000 / EXPECT.still)) : 0;
      var vd = x.videoUrl ? 1 : x.video && x.video.at ? Math.min(0.95, 1 - Math.exp(-(now - x.video.at) / 1000 / (job.sound === 'ai' ? EXPECT.videoAi : EXPECT.video))) : 0;
      sum += 0.22 * st + 0.78 * vd;
    });
    return n ? sum / n : 0;
  }
  function statusSub(stage, s) {
    var t;
    if (s.reconnected) { t = 'Generating…'; UI.hold = 0; }
    else if (s.retry && s.reconnecting) t = s.offline ? 'Connection lost — reconnecting…' : 'fal.ai is busy — reconnecting…';
    else if (s.retry) t = s.offline ? 'Connection lost — retrying…' : 'fal.ai is busy — retrying…';
    else if (s.status === 'IN_QUEUE') t = (s.position > 0 ? 'In line at fal.ai · ' + s.position + ' ahead' : 'Starting…');
    else if (s.status === 'IN_PROGRESS') t = 'Generating…';
    else t = '';
    setStep(stage, null, t);
    if (s.status) {
      UI.lastStatus[stage] = s.status;
      if (s.status === 'IN_QUEUE' && s.position > 0 && UI.lastPos[stage] !== s.position) announce(s.position + ' ahead of you in line at fal.ai');
      UI.lastPos[stage] = s.status === 'IN_QUEUE' ? s.position : null;
    }
    if (s.retry && s.reconnecting) holdMsg(s.offline ? 'Connection lost — reconnecting. Your video is safe at fal.ai and won’t be charged twice.' : 'fal.ai is slow to answer — reconnecting. Your video is safe and won’t be charged twice.', 8000);
    else if (s.retry && s.offline) holdMsg('Connection lost — we’ll keep trying. Your video is safe at fal.ai.', 8000);
  }
  function setPill(state) { UI.pill = state || null; renderPill(); }
  function renderPill() {
    var s = UI.pill;
    // On phones the AI page's own button (fixed at the bottom) already shows the progress, so the bar would repeat it.
    var phone = !(window.matchMedia && window.matchMedia('(min-width: 980px)').matches);
    el.pill.hidden = !s || (s === 'run' && mode() === 'ai' && phone);
    el.pill.classList.toggle('ready', s === 'ready');
    el.pill.classList.toggle('error', s === 'error');
    el.pill.classList.toggle('tap', s === 'tap');
    if (s === 'ready') el.pillT.textContent = 'Your AI video is ready · tap to watch';
    else if (s === 'tap') el.pillT.textContent = 'Tap to finish your AI video';
    else if (s === 'error') el.pillT.textContent = 'Your AI video hit a snag · tap to see';
    else if (s === 'run') el.pillT.textContent = (UI.stage === 'finish' ? 'Finishing your video' : 'Making your video') + ' · ' + (UI.pct || 0) + '%';
  }
  window.addEventListener('resize', function () { if (UI.pill) renderPill(); });
  function openProgress() { UI.minimized = false; setPill(null); openSheet(el.prog, el.min); syncMonitor(); }
  function minimize() {
    if (UI.state === 'running') { UI.minimized = true; closeSheet(el.prog); setPill('run'); syncMonitor(); toast(el.pill.hidden ? 'We’ll keep working — tap “See progress” to check in.' : 'We’ll keep working — tap the bar at the bottom to check in.', 'info', 3000); }
    else closeProgressSheet();
  }
  function closeProgressSheet() { closeSheet(el.prog); if (UI.pill !== 'ready') setPill(null); }
  function resetProgressUI(job, resumed) {
    UI.state = 'running'; UI.stageAt = {}; UI.startAt = job.createdAt || Date.now(); UI.slowSaid = false; UI.finishFrac = null; UI.hold = 0;
    UI.pct = 0; UI.lastStatus = {}; UI.lastPos = {}; UI.stage = '';
    el.min.setAttribute('aria-label', 'Hide this and keep working in the background'); el.min.title = 'Keep working in the background';
    el.err.hidden = true; el.errActions.textContent = '';
    el.cancel.hidden = false; el.cancel.textContent = 'Cancel'; el.cancel.dataset.armed = ''; el.tapFinish.hidden = true; el.keepOpen.hidden = false;
    UI.runAt = Date.now(); // this page's own work on it (a resumed video's createdAt can be much older)
    UI.guestWait = null; UI.guestRunAt = 0; UI.guestStage = ''; UI.guestLost = false; UI.guestSharing = (GUEST && GG.session && GG.session.state) || '';
    if (el.pv) delete el.pv.dataset.wait;
    el.steps.hidden = false; el.mon.hidden = true; el.elapsed.parentNode.hidden = false; el.elapsed.textContent = '0:00 elapsed';
    el.progTt.textContent = 'Making your video';
    var local = job.engine === 'local';
    UI.localOverall = 0; UI.localWaiting = false; UI.shareNote = '';
    if (el.shareNote) { el.shareNote.hidden = true; el.shareNote.textContent = ''; }
    var nShots = job.story && job.shots ? job.shots.length : 1;
    el.finishName.textContent = nShots > 1 ? 'Cutting it to the beat & finishing' : job.sound === 'ai' ? (local ? 'Adding your song & the label' : 'Adding the label & finishing') : job.sound === 'own' ? 'Adding your song & finishing' : 'Adding music & finishing';
    if (el.videoName) el.videoName.textContent = nShots > 1 ? (local && job.sound === 'ai' ? 'Making your song & ' + nShots + ' clips' : 'Bringing ' + nShots + ' shots to life') : local && job.sound === 'ai' ? 'Making your song & video' : 'Bringing it to life';
    if (el.stillName) el.stillName.textContent = nShots > 1 ? 'Placing you in ' + nShots + ' shots' : 'Placing you in the scene';
    UI.shotQ = {}; UI.shotAt = {}; UI.shotSeen = {};
    renderShots(job);
    if (GUEST) guestKeepOpen(job);
    else if (local) el.keepOpen.textContent = 'It’s made on this PC, so it’s free. You can minimize this window — bring it back for the last minute so the music and the label can be added. If you close this window, your video pauses: open Glow Studio again and press Continue — nothing is lost.';
    else el.keepOpen.innerHTML = KEEP_OPEN_FAL;
    ['still', 'video', 'finish'].forEach(function (s) { setStep(s, 'todo', ''); });
    var thumb = (S.photo && S.photo.url) || job.thumb || '';
    if (thumb) el.pvSelfie.src = thumb; else el.pvSelfie.removeAttribute('src');
    el.pvStill.classList.remove('in'); el.pvStill.removeAttribute('src');
    el.pv.classList.remove('has-still', 'has-video', 'error');
    if (job.stillUrl) showStill(job.stillUrl, true);
    if (resumed) holdMsg('Welcome back — picking up where we left off.', 6000);
    clearInterval(UI.timer); UI.timer = setInterval(tick, 500);
  }
  function showStill(url, instant) {
    var img = el.pvStill;
    img.onload = function () {
      el.pv.classList.add('has-still');
      if (instant || REDUCED) img.classList.add('in');
      else requestAnimationFrame(function () { requestAnimationFrame(function () { img.classList.add('in'); }); });
    };
    img.onerror = function () { /* the still is only a preview; ignore */ };
    img.src = url;
  }

  /* ------------------------------------------------------------------ *
   * The pipeline
   * ------------------------------------------------------------------ */
  function newJob() {
    var sc = sceneById(S.sceneId);
    var sound = effSound(sc);
    var job = {
      v: 1, id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now(),
      sceneId: sc.id, sound: sound, trackId: S.trackId, duration: S.duration,
      stage: 'upload', thumb: S.photo ? S.photo.thumb : '', photoSeq: S.photo ? S.photo.seq : 0,
      still: null, stillUrl: null, video: null, videoUrl: null, tries: {}
    };
    if (sound === 'own' && S.own) job.own = ownForJob(S.duration);
    job.hint = sound === 'ai' ? '' : beatHint(tempoOf(sound, S.trackId));
    if (sc.story) {
      // a story: one scene photo + one 5 s clip per shot, all from the same selfie
      job.story = true;
      job.shots = shotsFor(sc, S.duration).map(function (sh) { return { id: sh.id, still: null, stillUrl: null, video: null, videoUrl: null, tries: {} }; });
    }
    return job;
  }
  // The tempo the clips should move to ("Dance to the beat"): the built-in track's, or the analysed part of my song.
  function tempoOf(sound, trackId) {
    if (sound === 'own') {
      var b = S.own && ownPartBeat(S.own, Math.min(S.own.start, ownMaxStart()), S.duration);
      if (!b || !(b.bpm > 0)) return null;
      var st = Math.min(S.own.start, ownMaxStart()), en = st + S.duration, e = 0, c = 0;
      b.beats.forEach(function (t, k) { if (t >= st && t <= en) { e += b.energy[k] || 0; c++; } });
      return { bpm: b.bpm, energy: c ? e / c : 0.7 };
    }
    if (sound === 'music') { var tr = trackById(trackId); return tr ? { bpm: tr.bpm, energy: /lo-fi|dream/i.test(tr.genre || '') ? 0.4 : 0.75 } : null; }
    return null;
  }
  // Resolves true when the job now runs in this page, false when another Glow Studio page is running one.
  function startRun(job, opts) {
    opts = opts || {};
    if (RUN.starting || running()) return Promise.resolve(false);
    RUN.starting = true;
    return acquireLock().then(function (ok) {
      RUN.starting = false;
      if (running()) return false;
      if (!ok || (!LOCKS && liveElsewhere(storedJob()))) { releaseLock(); watchOtherTab(); return false; }
      clearInterval(otherTabTimer);
      job.paused = false;
      S.retryJob = null; // in use now (failJob sets it again if needed)
      RUN.job = job; RUN.cancelled = false; RUN.persisted = false;
      readyItem = null;
      saveJob(job);
      resetProgressUI(job, opts.resumed);
      if (opts.background) { UI.minimized = true; setPill('run'); } else openProgress();
      updateCost();
      clearInterval(UI.beatTimer);
      UI.beatTimer = setInterval(function () { var j = RUN.job; if (j) { try { heartbeat(j); } catch (e) { /* stood down */ } } }, 3000);
      runJob(job).catch(function (e) { console.warn('[glow-ai] run', e); });
      return true;
    });
  }
  function endRun() { RUN.job = null; RUN.persisted = false; releaseLock(); releaseLocalLock(); clearInterval(UI.beatTimer); UI.waitVisible = false; setRunTitle(''); setTimeout(cardsWake, 0); if (SEE.resumeAfter) setTimeout(seeAutoResume, 2500); }
  async function runJob(job) {
    if (job.story) return runStory(job);
    var sc = sceneById(job.sceneId);
    try {
      var haveVideo = !!(job.videoUrl || job.localBlob);
      // 1 — the scene still
      if (!job.stillUrl && !haveVideo) {
        enterStage('still', job.still && job.still.at);
        if (!job.still) {
          var ref = job.ref || job.inlineRef;
          if (!ref) {
            setStep('still', null, 'Uploading your photo…');
            try { ref = await uploadSelfie(job); job.ref = ref; }
            catch (e) {
              var unreachable = (e.kind === 'upload' && e.network) || (e.kind === 'network' && navigator.onLine !== false);
              if (e === CANCELLED || !unreachable || !S.photo) throw e;
              // Upload host unreachable from this browser: the Gemini-based edit model also accepts a small data URI.
              console.warn('[glow-ai] CDN upload failed, sending a small inline copy instead');
              ref = job.inlineRef = S.photo.small;
            }
          }
          check(job);
          job.stage = 'still'; saveJob(job);
          var stillEps = [EP.still, EP.stillAlt];
          var k = job.tries.stillEp || 0;
          setStep('still', null, 'Sending to ' + MODEL_NAME[stillEps[k]] + '…');
          var sh = await submit(job, stillEps[k], stillInput(sc, ref));
          if (RUN.cancelled || RUN.job !== job) { cancelRemote(sh); throw CANCELLED; }
          job.still = sh;
          saveJob(job);
          enterStage('still', sh.at);
        }
        var out;
        try {
          out = await poll(job, job.still, function (s) { statusSub('still', s); });
        } catch (e) {
          if (e !== CANCELLED && retryable(e) && (job.tries.still || 0) < 2) return retryStill(job, e);
          throw e;
        }
        var img = out && Array.isArray(out.images) ? out.images[0] : null;
        if (!img || typeof img.url !== 'string') {
          var why = out && typeof out.description === 'string' ? out.description : '';
          throw FalErr(/safety|policy|cannot|can't|unable|not able/i.test(why) ? 'moderation' : 'nomedia', why || 'No image came back');
        }
        job.stillUrl = img.url; job.stillW = img.width || null; job.stillH = img.height || null;
        job.stage = 'video'; saveJob(job);
        setStep('still', 'done', 'Done');
        showStill(job.stillUrl, false);
      }
      // 2 — the video
      if (!haveVideo) {
        enterStage('video', job.video && job.video.at);
        var ep = job.sound === 'ai' ? EP.ai : EP.std;
        if (!job.video) {
          setStep('video', null, 'Sending to ' + MODEL_NAME[ep] + '…');
          var vh = await submit(job, ep, videoInput(sc, job.sound === 'ai' ? 'ai' : 'std', job.duration, job.stillUrl, job.hint));
          if (RUN.cancelled || RUN.job !== job) { cancelRemote(vh); throw CANCELLED; }
          job.video = vh;
          saveJob(job);
        }
        var vout;
        try {
          vout = await poll(job, job.video, function (s) { statusSub('video', s); });
        } catch (e) {
          if (e !== CANCELLED && retryable(e) && (job.tries.video || 0) < 1) return retryVideo(job, e);
          throw e;
        }
        var v = vout && vout.video;
        if (!v || typeof v.url !== 'string') throw FalErr('nomedia', 'No video came back');
        job.videoUrl = v.url; job.videoMeta = { w: v.width || null, h: v.height || null, type: v.content_type || null };
        job.stage = 'finish'; saveJob(job);
        setStep('video', 'done', 'Done');
      }
      // 3 — finishing on this device
      await finishStage(job);
    } catch (e) {
      if (e === CANCELLED) return;
      if (RUN.job !== job) return;
      failJob(job, e);
    }
  }
  // A generation that failed on fal's side (500, model error) isn't charged and may be submitted again. Connection
  // trouble never lands here: the request is still good, so it is picked up again instead (see liveErr).
  function retryable(e) { return !!e && e.kind === 'server' && !e.live; }
  function retryStill(job, e) {
    console.warn('[glow-ai] still failed on fal’s side, retrying', e);
    job.tries.still = (job.tries.still || 0) + 1;
    if (job.tries.still >= 2) job.tries.stillEp = 1; // second retry: the alternate edit model
    job.still = null; job.stage = 'still'; saveJob(job);
    holdMsg('fal.ai had a hiccup — trying again (you’re only charged for results).', 8000);
    return runJob(job);
  }
  function retryVideo(job, e) {
    console.warn('[glow-ai] video failed on fal’s side, retrying', e);
    job.tries.video = (job.tries.video || 0) + 1;
    job.video = null; saveJob(job);
    holdMsg('fal.ai had a hiccup — trying again (you’re only charged for results).', 8000);
    return runJob(job);
  }

  /* fal.ai cloud stories: one scene photo + one 5 s clip per shot, all from the same uploaded selfie. The shots run
   * side by side. Every paid request is saved the moment fal accepts it and every finished result the moment it is
   * read, so a reload, "Try again" or a lost connection picks each shot up where it was: a finished shot is never made
   * (or paid for) again, and only a shot that failed on fal's side (not charged) is sent again. */
  async function runStory(job) {
    var sc = sceneById(job.sceneId), tier = job.sound === 'ai' ? 'ai' : 'std';
    try {
      renderShots(job);
      if (!job.shots.every(function (s) { return s.videoUrl; })) {
        var needStill = job.shots.some(function (s) { return !s.stillUrl && !s.still && !s.videoUrl; });
        enterStage(job.shots.every(function (s) { return s.stillUrl || s.videoUrl; }) ? 'video' : 'still', job.createdAt);
        if (needStill && !job.ref && !job.inlineRef) {
          setStep('still', null, 'Uploading your photo…');
          try { job.ref = await uploadSelfie(job); }
          catch (e) {
            var unreachable = (e.kind === 'upload' && e.network) || (e.kind === 'network' && navigator.onLine !== false);
            if (e === CANCELLED || !unreachable || !S.photo) throw e;
            console.warn('[glow-ai] CDN upload failed, sending a small inline copy instead');
            job.inlineRef = S.photo.small;
          }
          check(job);
          job.stage = 'still'; saveJob(job);
        }
        storySubs(job);
        await Promise.all(job.shots.map(function (s, i) { return runShot(job, sc, s, i, tier); }));
        check(job);
      }
      job.stage = 'finish'; saveJob(job);
      setStep('still', 'done', 'Done'); setStep('video', 'done', 'Done');
      await finishStage(job);
    } catch (e) {
      if (e === CANCELLED || RUN.job !== job) return;
      failStory(job, e);
    }
  }
  async function runShot(job, sc, s, i, tier) {
    var shot = shotById(sc, s.id);
    s.tries = s.tries || {};
    try {
      if (!s.stillUrl && !s.videoUrl) {
        if (!s.still) {
          var ref = job.ref || job.inlineRef;
          if (!ref) throw FalErr('nophoto', 'Your photo is no longer here');
          var eps = [EP.still, EP.stillAlt], k = s.tries.stillEp || 0;
          setShot(i, 'active');
          var sh = await submit(job, eps[k], shotStillInput(shot, ref));
          if (RUN.cancelled || RUN.job !== job) { cancelRemote(sh); throw CANCELLED; }
          s.still = sh; saveJob(job);
        }
        setShot(i, 'active');
        var out;
        try { out = await poll(job, s.still, function (st) { shotStatus(job, i, 'still', st); }); }
        catch (e) {
          if (e !== CANCELLED && retryable(e) && (s.tries.still || 0) < 2) {
            console.warn('[glow-ai] shot still failed on fal’s side, retrying', e);
            s.tries.still = (s.tries.still || 0) + 1;
            if (s.tries.still >= 2) s.tries.stillEp = 1;
            s.still = null; saveJob(job);
            holdMsg('fal.ai had a hiccup — trying that shot again (you’re only charged for results).', 8000);
            return runShot(job, sc, s, i, tier);
          }
          throw e;
        }
        var img = out && Array.isArray(out.images) ? out.images[0] : null;
        if (!img || typeof img.url !== 'string') {
          var why = out && typeof out.description === 'string' ? out.description : '';
          throw FalErr(/safety|policy|cannot|can't|unable|not able/i.test(why) ? 'moderation' : 'nomedia', why || 'No image came back');
        }
        s.stillUrl = img.url; saveJob(job);
        shotStill(job, i, img.url);
        storySubs(job);
      }
      if (!s.videoUrl) {
        var ep = tier === 'ai' ? EP.ai : EP.std;
        if (!s.video) {
          var vh = await submit(job, ep, shotVideoInput(sc, shot, tier, s.stillUrl, job.hint));
          if (RUN.cancelled || RUN.job !== job) { cancelRemote(vh); throw CANCELLED; }
          s.video = vh; saveJob(job);
        }
        if (job.shots.every(function (x) { return x.stillUrl || x.videoUrl; })) enterStage('video');
        var vout;
        try { vout = await poll(job, s.video, function (st) { shotStatus(job, i, 'video', st); }); }
        catch (e) {
          if (e !== CANCELLED && retryable(e) && (s.tries.video || 0) < 1) {
            console.warn('[glow-ai] shot video failed on fal’s side, retrying', e);
            s.tries.video = (s.tries.video || 0) + 1;
            s.video = null; saveJob(job);
            holdMsg('fal.ai had a hiccup — trying that shot again (you’re only charged for results).', 8000);
            return runShot(job, sc, s, i, tier);
          }
          throw e;
        }
        var v = vout && vout.video;
        if (!v || typeof v.url !== 'string') throw FalErr('nomedia', 'No video came back');
        s.videoUrl = v.url; s.videoMeta = { w: v.width || null, h: v.height || null };
        saveJob(job);
        setShot(i, 'done');
        storySubs(job);
      } else setShot(i, 'done');
    } catch (e) {
      if (e && e !== CANCELLED && typeof e === 'object' && e.shot == null) e.shot = i;
      throw e;
    }
  }
  // "2 of 4 ready" lines under the steps, and the place in line at fal.ai when there is one
  function storySubs(job) {
    var n = job.shots.length, st = 0, vd = 0;
    job.shots.forEach(function (s) { if (s.stillUrl || s.videoUrl) st++; if (s.videoUrl) vd++; });
    var q = UI.shotQ || {}, ahead = 0;
    Object.keys(q).forEach(function (k) { if (q[k] > ahead) ahead = q[k]; });
    setStep('still', st === n ? 'done' : null, st === n ? 'Done' : st + ' of ' + n + ' ready' + (UI.stage === 'still' && ahead ? ' · in line at fal.ai' : ''));
    if (UI.stage === 'video') setStep('video', null, vd + ' of ' + n + ' ready' + (ahead ? ' · ' + ahead + ' ahead at fal.ai' : ''));
  }
  function shotStatus(job, i, kind, st) {
    UI.shotQ = UI.shotQ || {};
    UI.shotQ[kind + i] = st.status === 'IN_QUEUE' && st.position > 0 ? st.position : 0;
    UI.shotAt = UI.shotAt || {};
    if (st.status === 'IN_PROGRESS' && !UI.shotAt[kind + i]) UI.shotAt[kind + i] = Date.now();
    if (st.retry && st.reconnecting) holdMsg(st.offline ? 'Connection lost — reconnecting. Your shots are safe at fal.ai and won’t be charged twice.' : 'fal.ai is slow to answer — reconnecting. Your shots are safe and won’t be charged twice.', 8000);
    else if (st.retry && st.offline) holdMsg('Connection lost — we’ll keep trying. Your shots are safe at fal.ai.', 8000);
    if (st.reconnected) UI.hold = 0;
    storySubs(job);
  }
  // What "Try again" still has to pay for (only what isn't made yet, or a request fal no longer holds).
  function storyMissingCost(job) {
    var c = 0, vp = (job.sound === 'ai' ? PRICE.ai : PRICE.std) * SHOT_SEC;
    (job.shots || []).forEach(function (s) {
      if (s.videoUrl || s.video) return;
      c += vp;
      if (!s.stillUrl && !s.still) c += PRICE.still;
    });
    return c;
  }
  function storyRetryLine(job) {
    var c = storyMissingCost(job);
    return c > 0.004 ? 'Only the missing shots · about ' + money(c) + ' more' : 'Already paid for — no extra cost';
  }
  // The paid parts of a stopped story, to reuse when the same photo + scene is made again (cancel, moderation of
  // another shot, …): scene photos always (they only depend on the photo and the shot), clips for the same sound tier.
  function storyStub(job) {
    var made = (job.shots || []).filter(function (s) { return s.stillUrl || s.videoUrl; });
    if (!made.length) return null;
    return { story: true, sceneId: job.sceneId, sound: job.sound, photoSeq: job.photoSeq, thumb: job.thumb, ref: job.ref || null,
      shots: (job.shots || []).map(function (s) { return { id: s.id, stillUrl: s.stillUrl || null, videoUrl: s.videoUrl || null }; }) };
  }
  function failStory(job, e) {
    console.warn('[glow-ai] story failed', e);
    endRun();
    UI.state = 'error';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    var v = errorView(e, job);
    var hard = e && (e.kind === 'moderation' || e.kind === 'face' || e.kind === 'photo' || e.kind === 'nophoto');
    var paid = job.shots.some(function (s) { return s.stillUrl || s.still || s.video || s.videoUrl; });
    if (hard || !paid) {
      // nothing more can come of this one: stop what is still queued at fal so it isn't charged
      job.shots.forEach(function (s) { if (s.video && !s.videoUrl) cancelRemote(s.video); else if (s.still && !s.stillUrl) cancelRemote(s.still); });
      clearJob();
      S.retryJob = e && e.kind !== 'moderation' && e.kind !== 'auth' ? storyStub(job) : null;
    } else {
      // a shot failed on fal's side (not charged) or the connection dropped: every paid shot is kept, and "Try again"
      // or a reload makes only what is missing
      var s = e && e.shot != null ? job.shots[e.shot] : null;
      if (s && !e.live) { if (!s.videoUrl) s.video = null; if (!s.stillUrl) s.still = null; }
      if (s) setShot(e.shot, 'error');
      savePaused(job);
      S.retryJob = { resume: job };
    }
    renderJobError(v, job);
  }
  function cancelStory(job) {
    RUN.cancelled = true;
    endRun(); wakeAll();
    clearJob();
    UI.state = 'idle';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    closeProgressSheet(); setPill(null);
    var stub = storyStub(job);
    var pend = [];
    job.shots.forEach(function (s, i) {
      if (s.video && !s.videoUrl) pend.push({ i: i, kind: 'video', h: s.video });
      else if (s.still && !s.stillUrl) pend.push({ i: i, kind: 'still', h: s.still });
    });
    S.retryJob = stub;
    updateCost();
    if (!pend.length) {
      toast(stub ? 'Cancelled. The shots already made are kept — we’ll reuse them if you make this scene again.' : 'Cancelled — nothing was charged.', 'info', 5000);
      return;
    }
    Promise.all(pend.map(function (p) {
      return cancelRemote(p.h).then(function (res) {
        if (res.state !== 'ALREADY_COMPLETED') return res.state === 'CANCELLATION_REQUESTED' || !res.status ? 'maybe' : 'ok';
        // it finished just as Cancel was tapped and is paid for: keep it for next time
        return falFetch(p.h.response_url, { method: 'GET' }, true).then(function (r) {
          var b = r.ok && r.body, url = p.kind === 'video' ? b && b.video && b.video.url : b && Array.isArray(b.images) && b.images[0] && b.images[0].url;
          if (typeof url === 'string' && !running()) {
            if (!S.retryJob || !S.retryJob.story) S.retryJob = storyStub(job) || { story: true, sceneId: job.sceneId, sound: job.sound, photoSeq: job.photoSeq, thumb: job.thumb, ref: job.ref || null, shots: job.shots.map(function (x) { return { id: x.id, stillUrl: x.stillUrl || null, videoUrl: x.videoUrl || null }; }) };
            var st = S.retryJob.shots[p.i];
            if (st) { if (p.kind === 'video') st.videoUrl = url; else st.stillUrl = url; }
          }
          return 'kept';
        }, function () { return 'maybe'; });
      });
    })).then(function (r) {
      var maybe = r.indexOf('maybe') >= 0, kept = r.indexOf('kept') >= 0 || !!stub;
      toast((maybe ? 'Cancelled. Some shots were already being made, so fal.ai may still charge for them.' : 'Cancelled — the unfinished shots weren’t charged.') +
        (kept ? ' The shots already made are kept for next time.' : ''), 'info', 7000);
      updateCost();
    });
  }
  // Shot strip in the progress sheet: one tile per shot, with its scene photo as soon as it is made
  function renderShots(job) {
    if (!el.shots) return;
    var n = job.story && job.shots ? job.shots.length : 0;
    el.shots.textContent = '';
    el.shots.hidden = n < 2;
    el.pv.classList.toggle('has-shots', n >= 2);
    if (n < 2) return;
    var sc = sceneById(job.sceneId);
    job.shots.forEach(function (s, i) {
      var li = document.createElement('li'); li.className = 'ai-shot'; li.dataset.state = s.videoUrl ? 'done' : 'todo';
      var fig = document.createElement('span'); fig.className = 'ai-shot-img';
      var num = document.createElement('i'); num.textContent = String(i + 1); fig.appendChild(num);
      var still = s.stillUrl || null;
      if (still) { var img = document.createElement('img'); img.alt = ''; img.src = still; fig.appendChild(img); li.classList.add('has-still'); }
      var sh = sc.story ? shotById(sc, s.id) : null;
      var t = document.createElement('small'); t.textContent = (sh && sh.title) || s.title || ('Shot ' + (i + 1));
      if (s.lip) { var lp = document.createElement('b'); lp.className = 'ai-shot-lip'; lp.textContent = 'Lip-sync'; fig.appendChild(lp); }
      li.appendChild(fig); li.appendChild(t);
      li.setAttribute('aria-label', 'Shot ' + (i + 1) + ': ' + t.textContent);
      el.shots.appendChild(li);
    });
  }
  function setShot(i, state) {
    if (!el.shots || el.shots.hidden) return;
    var li = el.shots.children[i];
    if (!li || li.dataset.state === 'done' && state === 'active') return;
    // only one shot is "being worked on" at a time
    if (state === 'active') clearActiveShots(i);
    li.dataset.state = state;
  }
  function clearActiveShots(except) {
    if (!el.shots) return;
    Array.prototype.forEach.call(el.shots.children, function (li, k) { if (k !== except && li.dataset.state === 'active') li.dataset.state = 'todo'; });
  }
  function shotStill(job, i, url) {
    // kept with the shot, so the strip still shows it when it is drawn again (finishing, after a reload)
    if (job.shots && job.shots[i] && !job.shots[i].stillUrl) job.shots[i].stillUrl = url;
    if (el.shots && !el.shots.hidden) {
      var li = el.shots.children[i];
      if (li && !li.classList.contains('has-still')) {
        var img = document.createElement('img'); img.alt = ''; img.src = url;
        li.querySelector('.ai-shot-img').appendChild(img); li.classList.add('has-still');
      }
    }
    // the first scene photo is the big reveal
    if (!job.stillUrl) { job.stillUrl = url; showStill(url, false); }
    announce('Scene photo ' + (i + 1) + ' is ready');
  }

  /* Free AI on this PC: GlowLocalAI makes the scene photo and the clip (and the song), then the same finishing as
   * the cloud adds the label and the sound. The engine keeps its own record of the video (and, with {keep: true}, its
   * files) until the labelled video is saved here (GlowLocalAI.release), so a reload continues it, or finishes a clip
   * that was already made, without making it again. This page keeps only which scene, sound and track it was for
   * (LS.localJob). One window at a time makes a free video (the 'glow-local-job' lock). Nothing here is written to the
   * cloud job slot (LS.job). */
  function localJob(sc, sound, trackId, quality, thumb, plan) {
    var job = {
      v: 1, id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), engine: 'local', createdAt: Date.now(),
      sceneId: sc.id, sound: sound === 'ai' || sound === 'own' ? sound : 'music', trackId: trackId, duration: 5, quality: quality === 'fast' ? 'fast' : 'best', offset: SONG_OFFSET,
      thumb: thumb || '', photoSeq: S.photo ? S.photo.seq : 0, stage: 'still', still: null, stillUrl: null, video: null, videoUrl: null, tries: {},
      engineJob: null // GlowLocalAI's job id (its record and files are kept until this page has finished the video)
    };
    if (!plan) return job;
    job.duration = plan.duration; job.sync = plan.sync; job.minutes = localRange(plan);
    if (job.sound === 'own' && S.own) job.own = ownForJob(plan.duration);
    job.hint = job.sound === 'ai' ? (sc.story ? SD.local.songHint : '') : beatHint(tempoOf(job.sound, trackId));
    if (plan.local === 'story') {
      // where each shot's part of the soundtrack starts: shots back to back (lip-synced ones exactly 4.8 s), the
      // others ending on the song's beats where it has known beats (my song); the finishing step uses the same plan
      job.story = true;
      var soundStart = job.sound === 'own' && job.own ? job.own.start : 0;
      var grid = job.sound === 'own' && S.own ? gridShift(ownPartBeat(S.own, soundStart, plan.duration), soundStart, 90) : null;
      var tl = planTimeline(plan.shots.map(function (x) { return x.lip ? LIP_SEC : 5.03; }), plan.shots.map(function (x) { return x.lip; }), null, grid);
      job.shots = plan.shots.map(function (x, i) { return { id: x.shot.id, title: x.shot.title, lip: x.lip, audioStart: x.lip ? Math.round((soundStart + tl.B[i]) * 1000) / 1000 : null }; });
      if (GUEST) {
        job.guest = true; job.host = GG.hostName(); job.videoSeconds = tl.total;
        if (job.sound === 'own') job.lipStarts = plan.lips ? plan.shots.map(function (x, i) { return x.lip ? Math.round(tl.B[i] * 1000) / 1000 : null; }) : null;
      }
      job.songStart = 0;
      if (job.sound === 'ai') job.songSeconds = Math.max(10, Math.min(60, Math.ceil(tl.total + 2)));
    } else if (plan.single) job.shotId = plan.single.shot.id;
    return job;
  }
  // The shot spec (prompts) of a job's shot id
  function jobShot(sc, job, id) {
    if (sc.story) return shotById(sc, id);
    var list = shotsFor(sc, job.duration || 20);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }
  // The request for GlowLocalAI.generateStory() (without photo and signal): see the contract in local-engine.js.
  function storyRequest(sc, job, fastPack) {
    var model = job.quality === 'fast' && fastPack ? 'klein' : 'qwen', anyLip = false;
    var shots = job.shots.map(function (x) {
      var sh = jobShot(sc, job, x.id);
      if (x.lip) anyLip = true;
      var o = { id: x.id, stillPrompt: localStillText(model, sh.local.still, sh.local.framing), motionPrompt: x.lip ? sh.local.sing : sh.local.motion + (job.hint || ''), negativePrompt: LOCAL_NEGATIVE, lipSync: !!x.lip };
      if (x.lip && x.audioStart != null) o.audioStart = x.audioStart;
      return o;
    });
    return {
      quality: job.quality, shots: shots,
      song: job.sound === 'ai' && sc.song ? { lyrics: sc.song.lyrics, style: sc.song.style, language: SD.local.songLanguage, seconds: job.songSeconds || 22 } : null,
      audio: job.sound === 'own' && anyLip && S.own ? { blob: S.own.blob, start: job.own ? job.own.start : Math.min(S.own.start, ownMaxStart()) } : null
    };
  }
  // Resolves true when the video now runs in this page, false when another window is making one (or this page is busy).
  function startLocalRun(job, opts) {
    opts = opts || {};
    if (running() || RUN.starting) return Promise.resolve(false);
    RUN.starting = true;
    return acquireLocalLock().then(function (ok) {
      RUN.starting = false;
      if (running()) { releaseLocalLock(); return false; }
      if (!ok) {
        otherWindowBusy();
        toast('A video is being made in another Glow Studio window. Free AI makes one at a time — please wait until it’s done.', 'warn', 6000);
        return false;
      }
      LOC.elsewhere = false;
      RUN.job = job; RUN.cancelled = false; RUN.persisted = false;
      readyItem = null; LOC.resume = null;
      if (LOC.retry && LOC.retry !== job) {
        // a new video replaces a made-but-unfinished one: let the engine delete that one's files
        if (LOC.retry.engineJob) LOC.api.release(LOC.retry.engineJob);
      }
      LOC.retry = null;
      var ctl = LOC.ctl = typeof AbortController === 'function' ? new AbortController() : null;
      saveLocalMeta(job);
      resetProgressUI(job, opts.resumed);
      if (opts.background) { UI.minimized = true; setPill('run'); } else openProgress();
      updateCost(); renderEngine();
      runLocal(job, opts, ctl).catch(function (e) { console.warn('[glow-ai] local run', e); });
      return true;
    });
  }
  // The engine runs one video at a time per page; a cancelled one lets go a moment after the abort.
  function localNotBusy() {
    var t0 = Date.now();
    return (function wait1() {
      if (!LOC.api.isBusy() || Date.now() - t0 > 5000) return Promise.resolve();
      return wait(150).then(wait1);
    })();
  }
  function lostErr(detail) { var e = new Error('The AI engine restarted, so this video was lost. Please try again.'); e.name = 'GlowLocalAIError'; e.code = 'lost'; e.detail = detail; return e; }
  async function runLocal(job, opts, ctl) {
    var sc = sceneById(job.sceneId);
    try {
      if (!job.localBlob && !(job.story && job.clips)) {
        var att = opts.attach || null;
        // "Try finishing again" after the clip had to be dropped: fetch it again from the engine's kept record
        if (!att && job.engineJob) {
          try { att = await LOC.api.resume(); } catch (e) { att = null; }
          check(job);
          if (!att || att.job !== job.engineJob) throw lostErr('the engine no longer has job ' + job.engineJob);
        }
        job.made = !!(att && att.made);
        enterStage(job.made ? 'finish' : 'still');
        if (job.made) { setStep('still', 'done', 'Done'); setStep('video', 'done', 'Done'); setStep('finish', null, 'Getting your clip…'); el.cancel.hidden = true; }
        else setStep('still', null, 'Getting ready…');
        setMsg(att ? 'Reconnecting to the free AI on ' + PCN + '…' : GUEST ? 'Getting your video ready for ' + PCN + '…' : 'Getting the free AI on this PC ready…');
        var onP = function (p) { if (RUN.job === job && !RUN.cancelled) localProgress(job, p); };
        var res;
        // keep: the engine keeps the record and the files until this page has saved the labelled video (release)
        if (att) res = await att.attach(onP, { signal: ctl ? ctl.signal : undefined, keep: true });
        else {
          await localNotBusy();
          check(job);
          var req;
          if (GUEST) req = await guestRequest(sc, job);
          else if (job.story) {
            if (job.sound === 'own' && !S.own) throw finErr('own-missing');
            req = storyRequest(sc, job, localPack('fast'));
          } else req = localRequest(sc, job.sound, job.quality, localPack('fast'), job.shotId && sc.story ? shotById(sc, job.shotId) : null, job.hint);
          if (!GUEST) req.photo = S.photo.blob;
          req.keep = true;
          if (ctl) req.signal = ctl.signal;
          res = job.story ? await LOC.api.generateStory(req, onP) : await LOC.api.generate(req, onP);
        }
        check(job);
        if (res && Array.isArray(res.clips)) {
          // a story: every shot's clip, in order (and the whole song, with where each shot's part of it starts)
          job.clips = res.clips.map(function (c) { trackUrl(c.stillUrl); return { id: c.id, blob: c.video, lipSync: !!c.lipSync, seconds: c.seconds, width: c.width, height: c.height, fps: c.fps, stillUrl: c.stillUrl || null }; });
          if (!job.clips.length || job.clips.some(function (c) { return !(c.blob && c.blob.size); })) throw lostErr('the story came back without its clips');
          job.localAudio = res.audio || null;
          job.songOffsets = res.songOffsets || null;
          job.story = true;
          if (!job.shots || job.shots.length !== job.clips.length) job.shots = job.clips.map(function (c) { return { id: c.id, lip: c.lipSync, audioStart: null }; });
          job.local = { stillModel: res.stillModel, quality: res.quality || job.quality, timings: res.timings, seed: res.seed };
          if (res.job && res.job !== job.engineJob) { job.engineJob = res.job; saveLocalMeta(job); }
          if (GUEST) guestMade(job, res);
          var first = job.clips.filter(function (c) { return c.stillUrl; })[0];
          if (first && !job.stillUrl) { job.stillUrl = first.stillUrl; showStill(first.stillUrl, true); }
          job.clips.forEach(function (c, i) { if (c.stillUrl) shotStill(job, i, c.stillUrl); setShot(i, 'done'); });
          setStep('still', 'done', 'Done'); setStep('video', 'done', 'Done');
        } else {
          job.localBlob = res.video;
          job.localAudio = res.audio || null;
          job.local = { width: res.width, height: res.height, fps: res.fps, seconds: res.seconds, lipSync: !!res.lipSync, stillModel: res.stillModel, quality: res.quality, timings: res.timings };
          if (res.job && res.job !== job.engineJob) { job.engineJob = res.job; saveLocalMeta(job); }
          trackUrl(res.stillUrl);
          if (res.stillUrl && !job.stillUrl) { job.stillUrl = res.stillUrl; showStill(res.stillUrl, true); }
          setStep('still', 'done', 'Done'); setStep('video', 'done', 'Done');
        }
      }
      await finishStage(job);
    } catch (e) {
      if (e === CANCELLED || RUN.job !== job || (e && e.name === 'AbortError')) return;
      failLocal(job, e);
    }
  }
  // GlowLocalAI stages -> the three steps on screen: starting/upload/still = 1, song/video/download = 2.
  var LOCAL_STEP = { starting: 'still', upload: 'still', still: 'still', song: 'video', video: 'video', lipsync: 'video', download: 'video', queue: 'still', approval: 'still', accepted: 'still' };
  function localProgress(job, p) {
    if (p.job && p.job !== job.engineJob) { job.engineJob = p.job; saveLocalMeta(job); }
    if (GUEST && guestProgress(job, p)) return;
    if (job.made) {
      // only the made clip is fetched again (the engine may have to start first)
      setStep('finish', null, p.stage === 'starting' ? 'Starting the free AI…' : 'Getting your clip…');
      if (p.message) setMsg(p.message);
      return;
    }
    var step = LOCAL_STEP[p.stage] || 'still';
    if (UI.stage !== step) enterStage(step);
    UI.localStage = p.stage;
    UI.localWaiting = !!p.waiting; // our step waits in the engine's queue behind another one (a friend's video)
    UI.localOverall = Math.max(UI.localOverall || 0, clamp(+p.overall || 0, 0, 1));
    var pct = Math.round(clamp(+p.pct || 0, 0, 1) * 100), sub;
    var n = job.story && job.shots ? job.shots.length : 1, si = p.shot != null ? +p.shot : null, of = si != null && n > 1 ? ' ' + (si + 1) + ' of ' + n : '';
    var pc = GUEST ? '' : ' · ' + pct + '%'; // (a friend's page: the ring is the one number, for the whole video)
    if (p.stage === 'starting') sub = 'Starting the free AI…';
    else if (p.stage === 'upload') sub = GUEST ? 'Sending your photo…' : 'Sending your photo to the AI…';
    else if (p.stage === 'song') sub = 'Writing your song' + pc;
    else if (p.stage === 'download') sub = n > 1 ? 'Saving the clips…' : 'Saving the clip…';
    else if (n > 1 && p.stage === 'still') sub = 'Scene photo' + of + pc;
    else if (n > 1 && p.stage === 'lipsync') sub = 'Lip-sync, shot' + of + pc;
    else if (n > 1 && p.stage === 'video') sub = 'Shot' + of + pc;
    else sub = GUEST ? 'Working on it…' : pct + '%';
    setStep(step, null, sub);
    // the engine's own plain words, as they are (not its final "Done!": the finishing step comes after it)
    if (p.message && !(p.stage === 'download' && /^done!?$/i.test(String(p.message).trim()))) setMsg(p.message);
    if (n > 1 && (si == null || p.stage === 'song' || p.stage === 'download')) clearActiveShots(-1);
    if (n > 1 && si != null && si >= 0 && si < n && p.stage !== 'song' && p.stage !== 'download') {
      // the shot strip: the shot being worked on is lit; a clip is done once the engine moves on to the next one
      UI.shotSeen = UI.shotSeen || {};
      var key = (p.stage === 'lipsync' ? 'video' : p.stage), prev = UI.shotSeen[key];
      if ((key === 'video') && prev != null && prev !== si) setShot(prev, 'done');
      UI.shotSeen[key] = si;
      setShot(si, 'active');
    }
    var su = p.stillUrl, sIdx = p.shotIndex != null ? +p.shotIndex : si;
    trackUrl(su);
    if (su && n > 1 && sIdx != null) shotStill(job, sIdx, su);
    else if (su && !job.stillUrl) {
      job.stillUrl = su;
      setStep('still', 'done', 'Done');
      showStill(su, false); // the scene photo is the first reveal
    }
    tick();
  }
  function cancelLocal(job) {
    if (UI.stage === 'finish') return; // the clip is made: always finish it
    RUN.cancelled = true;
    try { if (LOC.ctl) LOC.ctl.abort(); } catch (e) { /* ignore */ }
    endRun(); wakeAll();
    clearLocalMeta();
    UI.state = 'idle';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    closeProgressSheet(); setPill(null);
    updateCost(); renderEngine();
    toast(GUEST ? 'Cancelled — ' + PCN + ' stopped your video.' : 'Cancelled — the free AI on this PC stopped this video.', 'info', 4000);
    if (GUEST) setTimeout(refreshGuestSession, 1200);
  }
  // Errors from GlowLocalAI, routed by e.code; the engine's message is shown as it is (with the launcher's "press
  // Start" put in this panel's words), its detail under "Details".
  function localErrorView(e, job) {
    if (LOC.gone && !(e && e.kind === 'finish')) return goneView();
    if (GUEST) { var gv = guestErrorView(e, job); if (gv) return gv; }
    var code = (e && (e.code || e.kind)) || 'failed';
    var msg = e && e.name === 'GlowLocalAIError' && e.message ? engineText(e.message, 'panel') : '';
    var det = e && e.detail ? String(e.detail) : '';
    if (e && e.kind === 'finish') {
      if (e.code === 'own-missing') return { t: 'Add your song again', p: 'Your video is made, but your song isn’t loaded any more. Choose the same song file again and we’ll finish it — it’s free.', a: ['sound', 'finish'] };
      if (e.code === 'unsupported') return { t: 'This window can’t finish AI videos', p: 'Adding the AI label and the sound needs video recording. Update Microsoft Edge or Google Chrome, then try again. Your clip is kept until you close Glow Studio.', a: ['finish'] };
      if (e.code === 'decode') return { t: 'The finished clip couldn’t be opened', p: 'Your video was made, but it couldn’t be played to add the AI label. Try finishing again (the clip is fetched from the AI again); if that keeps failing, make it again — it’s free.', a: ['finish', 'retry'] };
      return { t: 'Finishing didn’t complete', p: 'Adding the AI label and the sound stopped halfway. Keep this window open and in front while it finishes, then try again — it’s free. If you close Glow Studio now, it is offered again the next time.', a: ['finish'] };
    }
    // the engine had started and was working on this video (not just starting) when it stopped
    var midJob = code === 'engine-stopped' || (!!e && !!e.stage && e.stage !== 'starting');
    switch (code) {
      case 'not-installed': case 'missing-model': case 'rejected':
        return { t: 'Free AI on this PC needs a repair', p: msg, a: ['repair', 'retry'], detail: det };
      case 'missing-pack':
        return { t: 'The Singing add-on isn’t installed', p: msg, a: ['singing', 'fal'], detail: det };
      case 'vcredist':
        return { t: 'A free Microsoft component is missing', p: msg, a: ['vcredist', 'retry'], detail: det };
      case 'engine-failed': case 'engine-stopped':
        if (midJob) return { t: 'The free AI engine stopped', p: msg || 'The AI engine stopped. Press “Try again · free” and Glow Studio starts it again.', a: ['retry', 'setup'], detail: det };
        return { t: 'The free AI engine didn’t start', p: msg, a: ['retry', 'setup'], detail: det };
      case 'ready-timeout':
        return { t: 'The free AI engine is taking too long to start', p: msg, a: ['retry', 'setup'], detail: det };
      case 'oom':
        return { t: 'Not enough graphics memory', p: msg, a: job && job.quality !== 'fast' && job.sound !== 'ai' ? ['fast', 'retry'] : ['retry'], detail: det };
      case 'driver':
        return { t: 'Your NVIDIA driver needs an update', p: msg, a: ['driver', 'retry'], detail: det };
      case 'busy':
        return { t: 'Another video is being made on this PC', p: msg, a: ['retry'], detail: det };
      case 'bad-photo': case 'upload':
        return { t: 'This photo didn’t work', p: msg, a: ['photo', 'retry'], detail: det };
      case 'bad-audio':
        return { t: 'Your song didn’t work for this video', p: msg || 'The song file couldn’t be used. Try another start point, or an MP3 or M4A file.', a: ['sound', 'retry'], detail: det };
      default: // interrupted, lost, failed, download, network, missing-still, bad-request, unavailable
        return { t: 'The free AI couldn’t finish this video', p: msg || 'Something went wrong while making the video. Please try again.', a: ['retry'], detail: det };
    }
  }
  // The scene photos the engine hands over (object URLs) belong to this page: let them go once their video is saved.
  function trackUrl(u) { if (u && /^blob:/.test(u) && LOC.urls.indexOf(u) < 0) LOC.urls.push(u); }
  function revokeUrls() {
    if (running()) return;
    LOC.urls.splice(0).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
  }
  function failLocal(job, e) {
    console.warn('[glow-ai] local job failed', e);
    endRun();
    UI.state = 'error';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    // A clip that is made but not finished: finishing again is free and quick (the clip stays in memory, and the engine
    // keeps its record and files, so it is offered again after a reload too).
    LOC.retry = e && e.kind === 'finish' && (job.localBlob || job.engineJob) ? job : null;
    if (!LOC.retry && e && e.code === 'lost' && job.engineJob) clearLocalMeta();
    if (e && e.stillUrl && !job.stillUrl) { job.stillUrl = e.stillUrl; showStill(e.stillUrl, true); }
    LOC.lastFail = { e: e, job: job };
    renderJobError(localErrorView(e, job), job);
    renderEngine();
    // lost the connection: is Glow Studio's helper (the launcher) still there at all?
    if (e && /network|interrupted|failed|download|unavailable/.test(e.code || '') && !LOC.gone) checkLauncher(true);
  }

  /* Glow Studio's helper (the launcher that serves this window) can be gone: closed, crashed, or quit while this
   * window slept. Nothing answers then, and "Try again" could never work, so the page says what to do instead:
   * open Glow Studio again. Checked every 30 s while the window is on screen, and at once after a lost connection;
   * when the helper answers again, everything carries on (the video's engine record waits on the PC). */
  function pingLauncher() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, t = setTimeout(function () { if (ctl) ctl.abort(); }, 5000);
    return fetch('/__glow/ping', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok; }, function () { return false; })
      .then(function (ok) { clearTimeout(t); return ok; });
  }
  var goneMisses = 0;
  function checkLauncher(now) {
    if (!LOC.inApp) return Promise.resolve(true);
    return pingLauncher().then(function (ok) {
      if (ok) {
        goneMisses = 0;
        if (LOC.gone) {
          LOC.gone = false;
          announce('Glow Studio is back');
          var f = LOC.lastFail;
          if (f && UI.state === 'error' && !running() && !el.err.hidden && !el.prog.hidden) renderJobError(localErrorView(f.e, f.job), f.job);
          refreshLocal().then(function () { checkLocalResume(); });
        }
        return true;
      }
      if (++goneMisses < (now ? 1 : 2)) return false; // (one missed ping in the background can be a hiccup)
      if (!LOC.gone) {
        LOC.gone = true;
        announce('Glow Studio’s helper has closed. Open Glow Studio again from your desktop icon.');
        var f2 = LOC.lastFail;
        if (f2 && UI.state === 'error' && !running() && !el.err.hidden && !el.prog.hidden) renderJobError(localErrorView(f2.e, f2.job), f2.job);
        renderEngine(); updateCost();
      }
      return false;
    });
  }
  function goneView() {
    return { t: 'Glow Studio’s helper has closed', p: 'The part of Glow Studio that runs the free AI isn’t running any more (it was closed, or your PC went to sleep). Open Glow Studio again from your desktop icon or the Start menu — your video picks up where it left off. This window notices by itself when it’s back.', a: [] };
  }
  if (LOC.inApp) {
    setInterval(function () { if (!document.hidden && (mode() === 'ai' || LOC.gone)) checkLauncher(false); }, TEST.goneMs || 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkLauncher(false); });
  }

  // Downloads fal's finished clip. A 4xx means the file is gone; connection trouble is waited out (the video is
  // paid for and safe at fal), and only after a long run of failures do we pause and let the user try again.
  async function downloadVideo(job, url) {
    var fails = 0, t0 = Date.now();
    for (;;) {
      check(job);
      var r = null, blob = null;
      try {
        r = await fetch(url || job.videoUrl, { credentials: 'omit' });
        if (r.ok) blob = await r.blob();
      } catch (e) { blob = null; }
      check(job);
      if (blob && blob.size) return blob;
      if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw FalErr('gone', 'The video file is no longer available (' + r.status + ')', { status: r.status });
      fails++;
      if (navigator.onLine === false) {
        setStep('finish', null, 'Waiting for the connection…');
        holdMsg('You’re offline. Your video is ready at fal.ai — we’ll download it as soon as you’re back online.', 30000);
        await nap(30000); // the 'online' event wakes this early
        continue;
      }
      if (fails >= 8 && Date.now() - t0 > 30000) throw FalErr('download', 'Couldn’t download the finished video', { live: true });
      setStep('finish', null, 'Download interrupted — retrying…');
      await nap(backoff(fails));
    }
  }
  // The shots of a job as clips for finishClips(): fal stories are downloaded (kept in memory, so "Try finishing again"
  // doesn't download them again), this PC's clips are already here.
  async function jobClips(job) {
    if (job.story && job.engine === 'local') {
      return (job.clips || []).map(function (c, i) { var p = job.shots && job.shots[i]; return { blob: c.blob, id: c.id, lipSync: !!c.lipSync, seconds: c.seconds, audioStart: p && p.audioStart != null ? p.audioStart : null }; });
    }
    if (job.story) {
      job.clipBlobs = job.clipBlobs || [];
      var out = [];
      for (var i = 0; i < job.shots.length; i++) {
        if (!job.clipBlobs[i]) {
          setStep('finish', null, 'Downloading shot ' + (i + 1) + ' of ' + job.shots.length + '…');
          job.clipBlobs[i] = await downloadVideo(job, job.shots[i].videoUrl);
        }
        out.push({ blob: job.clipBlobs[i], id: job.shots[i].id, lipSync: false });
      }
      return out;
    }
    var raw = job.localBlob || null;
    if (!raw) { raw = await downloadVideo(job); job.localBlob = raw; }
    return [{ blob: raw, id: 'main', lipSync: false }];
  }
  // The new finisher (beat-locked cuts, punches, my song) for stories, built-in music and my song; the original one for
  // a single clip with AI sound (the clip's own sound, or this PC's song under a lip-synced clip).
  function usesClips(job) { return !!job.story || job.sound === 'music' || job.sound === 'own'; }
  async function finishStage(job) {
    enterStage('finish');
    var sc = sceneById(job.sceneId);
    el.cancel.hidden = true;
    setStep('finish', null, job.story ? 'Getting your shots…' : 'Downloading your video…');
    if (job.story) { renderShots(job); job.shots.forEach(function (x, i) { setShot(i, 'done'); }); }
    var clips = await jobClips(job), raw = clips[0] && clips[0].blob;
    check(job);
    var fin = null, lastErr = null;
    for (var attempt = 0; attempt < 3 && !fin; attempt++) {
      try {
        UI.finishFrac = 0;
        setStep('finish', null, job.story ? 'Cutting your shots to the beat…' : job.sound === 'ai' ? (job.engine === 'local' ? 'Adding your song & the AI label…' : 'Adding the AI label…') : 'Mixing ' + (job.sound === 'own' ? 'your song' : ((trackById(job.trackId) || {}).name || 'music')) + '…');
        fin = usesClips(job) ? await finishClips(job, clips, sc) : await finishVideo(job, raw, sc);
      } catch (e) {
        if (e === CANCELLED) throw e;
        lastErr = e;
        if (e && e.code === 'gesture') {
          await needTap(job);
          continue;
        }
        if (e && e.code === 'hidden') {
          // the clips are made, the finishing needs the window on screen: say so in the taskbar
          UI.waitVisible = true; tick();
          holdMsg('Your clips are made — keep this window on screen for the last minute (music and label).', 60000);
          await whenVisible(); UI.waitVisible = false; UI.hold = 0; tick();
          continue;
        }
        break;
      }
    }
    check(job);
    // A clip this browser couldn't play is downloaded afresh next time (it may have been damaged on the way).
    if (!fin && lastErr && lastErr.code === 'decode') { job.localBlob = null; job.clipBlobs = null; if (job.engine === 'local' && job.story) job.clips = null; }
    // Never hand out fal's original, unlabelled file: stop here and let the user try finishing again (no cost).
    if (!fin) throw FalErr('finish', (lastErr && lastErr.message) || 'Finishing failed', { code: (lastErr && lastErr.code) || 'record', live: true });
    return completeJob(job, fin);
  }
  function needTap(job) {
    return new Promise(function (res) {
      setStep('finish', null, 'Waiting for you…');
      holdMsg('Your video is ready to finish — tap the button to add the sound.', 60000);
      el.tapFinish.hidden = false;
      var iv = 0;
      var go = function () { clearInterval(iv); UI.tapWaiter = null; ensureAudio(); el.tapFinish.hidden = true; el.tapFinish.onclick = null; UI.hold = 0; res(); };
      el.tapFinish.onclick = go;
      UI.tapWaiter = go; // a tap on the bottom bar counts too (it is a user gesture)
      if (UI.minimized || el.prog.hidden || mode() !== 'ai') { UI.minimized = true; setPill('tap'); toast('Your AI video is ready to finish — tap the bar at the bottom.', 'info', 5000); }
      else { try { el.tapFinish.focus(); } catch (e) { /* ignore */ } }
      iv = setInterval(function () { if (RUN.job !== job) { clearInterval(iv); UI.tapWaiter = null; res(); } }, 500);
    });
  }
  function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise(function (res) {
      var f = function () { if (!document.hidden) { document.removeEventListener('visibilitychange', f); res(); } };
      document.addEventListener('visibilitychange', f);
    });
  }

  /* ------------------------------------------------------------------ *
   * Finishing: AI label burned in + music or AI audio, recorded in real time
   * ------------------------------------------------------------------ */
  function canRecord() {
    var AC = window.AudioContext || window.webkitAudioContext;
    return !!(window.MediaRecorder && window.MediaStream && typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
      AC && typeof AC.prototype.createMediaStreamDestination === 'function');
  }
  function monitorWanted() { return UI.monitorOn && !UI.minimized && mode() === 'ai' && el.res.hidden && !el.prog.hidden && !document.hidden; }
  function syncMonitor() {
    if (!UI.mon || !actx) return;
    var g = monitorWanted() ? 0.9 : 0;
    try { UI.mon.gain.setTargetAtTime(g, actx.currentTime, 0.02); } catch (e) { UI.mon.gain.value = g; }
  }
  function pickMime() {
    var u = window.GlowApp && window.GlowApp.util;
    if (u && typeof u.pickMime === 'function') return u.pickMime();
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    var list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < list.length; i++) { try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) { /* ignore */ } }
    return '';
  }
  function fixDuration(blob, ms) {
    var u = window.GlowApp && window.GlowApp.util;
    if (u && typeof u.fixWebmDuration === 'function') return u.fixWebmDuration(blob, ms);
    return Promise.resolve(blob);
  }
  function finErr(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  var LOCAL_OUT = { w: 720, h: 1248 };
  function decodeAudio(ctx, blob) {
    return blob.arrayBuffer().then(function (ab) {
      return new Promise(function (res, rej) {
        var p = ctx.decodeAudioData(ab, res, rej);
        if (p && p.then) p.then(res, rej);
      });
    });
  }
  var labelFontReady = null;
  function loadLabelFont() {
    if (!labelFontReady) labelFontReady = (document.fonts && document.fonts.load) ? Promise.race([document.fonts.load('600 24px Outfit').catch(function () {}), wait(1500)]) : Promise.resolve();
    return labelFontReady;
  }
  // Small, low-key, always-on label in the bottom-right corner.
  function drawLabel(x, W, H) {
    var base = Math.min(W, H);
    var fs = Math.max(12, Math.round(base * 0.026));
    var padX = Math.round(fs * 0.62), padY = Math.round(fs * 0.36), gap = Math.round(fs * 0.38), ic = Math.round(fs * 0.78);
    x.save();
    x.font = '600 ' + fs + 'px Outfit, "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
    x.textBaseline = 'middle';
    var text = 'AI-generated';
    var tw = Math.ceil(x.measureText(text).width);
    var bw = padX * 2 + ic + gap + tw, bh = fs + padY * 2;
    var mx = Math.round(base * 0.04), X = W - mx - bw, Y = H - Math.round(base * 0.05) - bh;
    x.fillStyle = 'rgba(10, 8, 20, .42)';
    rr(x, X, Y, bw, bh, bh / 2); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = Math.max(1, fs * 0.06); x.stroke();
    var cx = X + padX + ic / 2, cy = Y + bh / 2;
    x.fillStyle = 'rgba(255,255,255,.86)';
    x.beginPath();
    for (var i = 0; i < 8; i++) { var a = i * Math.PI / 4 - Math.PI / 2, r = i % 2 ? ic * 0.16 : ic * 0.5; x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    x.closePath(); x.fill();
    x.fillText(text, X + padX + ic + gap, cy + fs * 0.04);
    x.restore();
  }
  function mediaReady(v, ms) {
    return new Promise(function (res, rej) {
      if (v.readyState >= 2) { res(); return; }
      var t = setTimeout(function () { done(); rej(finErr('decode', 'timeout')); }, ms);
      function ok() { done(); res(); }
      function bad() { done(); rej(finErr('decode', 'This browser can’t play this video file')); }
      function done() { clearTimeout(t); v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); }
      v.addEventListener('loadeddata', ok); v.addEventListener('error', bad);
    });
  }
  async function finishVideo(job, blob, sc) {
    if (!canRecord()) throw finErr('unsupported');
    if (document.hidden) throw finErr('hidden');
    var ctx = ensureAudio();
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') throw finErr('unsupported', 'No audio recording');
    if (ctx.state !== 'running') { try { await Promise.race([ctx.resume(), wait(900)]); } catch (e) { /* ignore */ } }
    if (ctx.state !== 'running') throw finErr('gesture');
    await loadLabelFont();
    var useAI = job.sound === 'ai';
    var local = job.engine === 'local';
    // Free AI on this PC: the song comes as its own file (Result.audio); the lip-synced clip was made from the part
    // that starts at job.offset. Only if it can't be decoded is the clip's own (muxed) sound used instead.
    var songBuf = null;
    if (local && useAI && job.localAudio) {
      try { songBuf = await decodeAudio(ctx, job.localAudio); } catch (e) { console.warn('[glow-ai] song decode failed, using the clip sound', e); songBuf = null; }
      check(job);
    }
    var clipAudio = useAI && !songBuf;
    var url = URL.createObjectURL(blob);
    var v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.muted = !clipAudio;
    v.className = 'ai-pv-src'; v.setAttribute('aria-hidden', 'true');
    el.pv.appendChild(v); // in the page (invisible) so every browser keeps decoding frames
    v.src = url;
    var cleanup = [];
    cleanup.push(function () { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } if (v.parentNode) v.parentNode.removeChild(v); URL.revokeObjectURL(url); });
    function clean() { cleanup.splice(0).forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); }
    try {
      await mediaReady(v, 20000);
      check(job);
      var vw = v.videoWidth, vh = v.videoHeight, dur = v.duration;
      if (!vw || !vh) throw finErr('decode', 'No picture');
      if (!(dur > 0) || !isFinite(dur)) dur = job.duration;
      var W, H, dx = 0, dy = 0, dw, dh;
      if (local) {
        // The local clip is about 480x832 (Fast: 384x672): finished at 720x1248, scaled up smoothly so it looks crisp
        // on a phone (cover-fit, so the Fast size's slightly different shape is not stretched).
        W = LOCAL_OUT.w; H = LOCAL_OUT.h;
        var cs = Math.max(W / vw, H / vh);
        dw = vw * cs; dh = vh * cs; dx = (W - dw) / 2; dy = (H - dh) / 2;
      } else {
        var sc2 = Math.min(1, 1920 / Math.max(vw, vh));
        W = Math.max(2, Math.round(vw * sc2 / 2) * 2); H = Math.max(2, Math.round(vh * sc2 / 2) * 2);
        dw = W; dh = H;
      }
      var cv = el.pvCanvas.cloneNode(false);
      el.pvCanvas.parentNode.replaceChild(cv, el.pvCanvas); el.pvCanvas = cv;
      cv.width = W; cv.height = H;
      var cx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      cx.imageSmoothingEnabled = true;
      try { cx.imageSmoothingQuality = 'high'; } catch (e) { /* older browsers */ }
      var draw = function () { try { cx.drawImage(v, dx, dy, dw, dh); } catch (e) { /* frame not ready */ } drawLabel(cx, W, H); };
      draw();
      el.pv.classList.add('has-video');

      // audio graph: source -> mix -> (recorder, optional speakers). The speakers only get it while the user is
      // watching the finishing preview, never in the background or over another video.
      var dest = ctx.createMediaStreamDestination(), mix = ctx.createGain(), mon = ctx.createGain();
      mix.gain.value = 1; mon.gain.value = monitorWanted() ? 0.9 : 0;
      mix.connect(dest); mix.connect(mon); mon.connect(ctx.destination);
      UI.mon = mon; el.mon.hidden = false;
      cleanup.push(function () { try { mix.disconnect(); } catch (e) { /* ignore */ } try { mon.disconnect(); } catch (e) { /* ignore */ } UI.mon = null; el.mon.hidden = true; });
      var music = null, env = null, musicAt = 0;
      if (clipAudio) {
        var es = ctx.createMediaElementSource(v);
        es.connect(mix);
        cleanup.push(function () { try { es.disconnect(); } catch (e) { /* ignore */ } });
      } else if (songBuf) {
        music = ctx.createBufferSource(); music.buffer = songBuf;
        musicAt = job.local && job.local.lipSync === false ? 0 : Math.max(0, Math.min(job.offset || 0, songBuf.duration - dur));
        env = ctx.createGain(); env.gain.value = 0;
        music.connect(env); env.connect(mix);
        cleanup.push(function () { try { music.stop(); } catch (e) { /* ignore */ } try { music.disconnect(); env.disconnect(); } catch (e) { /* ignore */ } });
      } else {
        var buf = null;
        try { buf = await getMusic(job.trackId || sc.defaultTrack, Math.max(1, dur + 0.3)); } catch (e) { console.warn('[glow-ai] music failed', e); }
        check(job);
        if (buf) {
          music = ctx.createBufferSource(); music.buffer = buf;
          env = ctx.createGain(); env.gain.value = 0;
          music.connect(env); env.connect(mix);
          cleanup.push(function () { try { music.stop(); } catch (e) { /* ignore */ } try { music.disconnect(); env.disconnect(); } catch (e) { /* ignore */ } });
        } else toast('The music couldn’t be made — your video will be silent.', 'warn');
      }

      // Free AI clips are 32 fps: a fixed-rate canvas capture (30) would drop source frames unevenly (a judder about twice a
      // second). There, one frame is captured per decoded video frame (requestVideoFrameCallback + requestFrame) —
      // Edge/Chrome, which the Windows app runs in; the cloud path keeps the fixed rate that every browser supports.
      var vStream = null, vTrack = null, perFrame = false;
      if (local && typeof v.requestVideoFrameCallback === 'function') {
        try { vStream = cv.captureStream(0); vTrack = vStream.getVideoTracks()[0]; perFrame = !!(vTrack && typeof vTrack.requestFrame === 'function'); } catch (e) { perFrame = false; }
        if (!perFrame && vStream) { vStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); vStream = null; }
      }
      if (!vStream) vStream = cv.captureStream(30);
      var stream = new MediaStream(vStream.getVideoTracks().concat(dest.stream.getAudioTracks()));
      cleanup.push(function () { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); });
      var mime = pickMime();
      var opts = { videoBitsPerSecond: Math.min(W, H) >= 1080 ? 12e6 : local ? 10e6 : 8e6, audioBitsPerSecond: 192000 };
      if (mime) opts.mimeType = mime;
      var rec;
      try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      // Recording runs in real time: while it does, the page drops its frosted-glass blurs (costly to redraw on every
      // frame on a busy or software-rendered screen), so no clip frames are skipped.
      document.documentElement.classList.add('glow-rec');
      cleanup.push(function () { document.documentElement.classList.remove('glow-rec'); });

      var thumbBlob = null, t0 = 0;
      var result = await new Promise(function (resolve, reject) {
        var settled = false, raf = 0, watchdog = 0, lastT = -1, lastMove = performance.now(), started = false, stopping = false;
        var vfc = 0, vfcSeen = false, playAt = 0, drawnT = -1, grabs = 0, lastPct = -1;
        function grab() { grabs++; try { vTrack.requestFrame(); } catch (e) { /* ignore */ } }
        function onFrame() {
          if (settled || stopping) return;
          vfcSeen = true;
          draw(); grab();
          vfc = v.requestVideoFrameCallback(onFrame);
        }
        function fail(e) {
          if (settled) return; settled = true; stopLoop();
          try { rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); } catch (x) { /* ignore */ }
          reject(e);
        }
        function stopLoop() {
          cancelAnimationFrame(raf); clearInterval(watchdog);
          if (vfc && v.cancelVideoFrameCallback) { try { v.cancelVideoFrameCallback(vfc); } catch (e) { /* ignore */ } }
          document.removeEventListener('visibilitychange', onVis);
        }
        function onVis() { if (document.hidden && !stopping) fail(finErr('hidden')); }
        document.addEventListener('visibilitychange', onVis);
        function frame() {
          if (settled || stopping) return;
          var t = v.currentTime || 0;
          // per-frame capture draws in the video-frame callback (no second draw here); without frame callbacks (should
          // not happen) it captures each new video frame from here instead
          if (!perFrame) draw();
          else if (!vfcSeen && playAt && performance.now() - playAt > 800 && t !== drawnT) { drawnT = t; draw(); grab(); }
          UI.finishFrac = clamp(t / dur, 0, 1);
          var pc = Math.round(UI.finishFrac * 100);
          if (pc !== lastPct) { lastPct = pc; setStep('finish', null, pc + '%'); }
          if (!thumbBlob && t >= Math.min(1, dur * 0.3)) {
            thumbBlob = 'pending';
            var tc = drawScaled(cv, W, H, 480);
            toBlob(tc, 'image/jpeg', 0.82).then(function (b) { thumbBlob = b; }, function () { thumbBlob = null; });
          }
          schedule();
        }
        // Draw on every display frame (the canvas stream samples at 30 fps); this works in every browser.
        function schedule() { raf = requestAnimationFrame(frame); }
        function finish() {
          if (settled || stopping) return;
          stopping = true;
          draw();
          if (perFrame) grab();
          UI.capture = perFrame ? (vfcSeen ? 'per-frame' : 'per-frame (fallback)') : 'fixed 30 fps';
          UI.captureFrames = perFrame ? grabs : null;
          var recMs = (performance.now() - t0);
          setTimeout(function () {
            rec.onstop = function () {
              if (settled) return; settled = true; stopLoop();
              var type = (rec.mimeType || opts.mimeType || 'video/webm').split(';')[0] || 'video/webm';
              var out = new Blob(chunks, { type: type });
              if (!out.size) { reject(finErr('record', 'empty recording')); return; }
              if (/webm/i.test(type)) fixDuration(out, recMs + 140).then(function (b) { resolve({ blob: b, type: type }); }, function () { resolve({ blob: out, type: type }); });
              else resolve({ blob: out, type: type });
            };
            try { rec.stop(); } catch (e) { fail(e); }
          }, 140);
        }
        rec.onerror = function (e) { fail((e && e.error) || finErr('record', 'recorder error')); };
        v.addEventListener('ended', finish);
        v.addEventListener('error', function () { fail(finErr('decode', 'Playback error')); });
        v.addEventListener('playing', function () {
          if (started) return;
          started = true;
          playAt = performance.now();
          if (music && env) {
            var now = ctx.currentTime;
            env.gain.setValueAtTime(0, now);
            env.gain.linearRampToValueAtTime(0.92, now + 0.08);
            var fadeAt = Math.max(now + 0.2, now + dur - 1.4);
            env.gain.setValueAtTime(0.92, fadeAt);
            env.gain.linearRampToValueAtTime(0, now + dur + 0.05);
            try { music.start(now, musicAt); } catch (e) { /* ignore */ }
          }
        });
        watchdog = setInterval(function () {
          if (settled || stopping) return;
          var t = v.currentTime;
          if (t !== lastT) { lastT = t; lastMove = performance.now(); return; }
          if (v.ended) { finish(); return; }
          if (performance.now() - lastMove > 7000) fail(finErr('stalled', 'Playback stalled'));
        }, 400);
        try { v.currentTime = 0; } catch (e) { /* ignore */ }
        try { rec.start(250); } catch (e) { fail(e); return; }
        t0 = performance.now();
        if (perFrame) { draw(); grab(); vfc = v.requestVideoFrameCallback(onFrame); }
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function (e) { fail(finErr(e && e.name === 'NotAllowedError' ? 'gesture' : 'decode', String(e && e.message || e))); });
        schedule();
      });
      if (thumbBlob === 'pending') await wait(150);
      if (!(thumbBlob instanceof Blob)) { try { thumbBlob = await toBlob(drawScaled(cv, W, H, 480), 'image/jpeg', 0.82); } catch (e) { thumbBlob = null; } }
      return { blob: result.blob, type: result.type, width: W, height: H, duration: dur, thumb: thumbBlob, labelled: true };
    } finally {
      clean();
    }
  }

  /* ------------------------------------------------------------------ *
   * Finishing, part 2: shots cut together on the beat (stories, built-in music, my song)
   *
   * One continuous soundtrack (built-in track, the AI song or the user's song from the chosen start point) is the
   * clock. Every shot gets a segment of the finished video: lip-synced shots play at normal speed exactly where their
   * part of the song is; the other shots are retimed gently (0.85–1.15x) so the cuts land on downbeats (or beats).
   * On strong beats there is a small zoom punch and light pulse; between shots a hard cut, a quick white flash or a
   * whip pan (the scene decides). The last half second fades to black while the music fades out. The "AI-generated"
   * label is drawn on every frame, after everything else. Recorded in real time like finishVideo().
   * ------------------------------------------------------------------ */
  var RATE_LO = 0.85, RATE_HI = 1.15, FADE_V = 0.5, FADE_A = 1.2, TRANS_SEC = 0.18, BURST_MS = 16;
  // durs: clip lengths; lips: shots that must play at normal speed; anchors[i]: where a lip-synced shot must start
  // (video time) or null; grid: { beats, downbeats } in video time, or null (shots back to back, no retiming).
  function planTimeline(durs, lips, anchors, grid) {
    var n = durs.length, B = [0], rate = [], i, ref = 0, acc = 0;
    function near(list, want, lo, hi) {
      var b = null;
      (list || []).forEach(function (t) { if (t >= lo - 1e-6 && t <= hi + 1e-6 && (b === null || Math.abs(t - want) < Math.abs(b - want))) b = t; });
      return b;
    }
    // the downbeat closest to where the cut would naturally be, unless a plain beat is clearly closer
    function snap(want, lo, hi, last) {
      if (!grid) return want;
      var d = near(grid.downbeats, want, lo, hi), b = near(grid.beats, want, lo, hi);
      if (d != null && (b == null || Math.abs(d - want) <= Math.abs(b - want) + (last ? 0.12 : 0.2))) return d;
      return b != null ? b : want;
    }
    for (i = 0; i < n; i++) {
      // a lip-synced shot starts exactly where its part of the song plays (the shot before it is stretched or cut)
      if (lips[i] && anchors && anchors[i] != null && i > 0) B[i] = Math.max(B[i - 1] + 0.3, anchors[i]);
      var start = B[i];
      if (lips[i] || !grid) { B[i + 1] = start + durs[i]; ref = B[i + 1]; acc = 0; continue; }
      if (i + 1 < n && lips[i + 1] && anchors && anchors[i + 1] != null) { B[i + 1] = Math.max(start + 0.3, anchors[i + 1]); ref = B[i + 1]; acc = 0; continue; }
      // where this cut would be with no retiming at all since the last fixed point (so small shifts never add up)
      acc += durs[i];
      B[i + 1] = snap(ref + acc, start + durs[i] / RATE_HI, start + durs[i] / RATE_LO, i === n - 1);
    }
    for (i = 0; i < n; i++) {
      var len = Math.max(0.05, B[i + 1] - B[i]);
      rate.push(lips[i] || !grid ? 1 : clamp(durs[i] / len, RATE_LO, RATE_HI));
    }
    return { B: B, rate: rate, total: B[n] };
  }
  // Strong beats (video time) for the zoom punches: downbeats and loud beats, not right at a cut or in the fade.
  function strongBeats(grid, B, total) {
    if (!grid || !grid.beats) return [];
    var downs = {}, out = [], last = -9;
    (grid.downbeats || []).forEach(function (t) { downs[t.toFixed(3)] = 1; });
    grid.beats.forEach(function (t, k) {
      var e = grid.energy ? grid.energy[k] : 0.7, strong = downs[t.toFixed(3)] ? e >= 0.45 : e >= 0.9;
      if (!strong || t < 0.3 || t > total - FADE_V - 0.2 || t - last < 0.8) return;
      if (B.some(function (b) { return Math.abs(b - t) < 0.22; })) return;
      out.push({ t: t, a: downs[t.toFixed(3)] ? 1 : 0.6 });
      last = t;
    });
    return out;
  }
  function gridShift(beat, offset, until) {
    if (!beat || !beat.beats || !beat.beats.length) return null;
    var g = { beats: [], downbeats: [], energy: [] };
    beat.beats.forEach(function (t, k) { var v = t - offset; if (v >= -0.02 && v <= until) { g.beats.push(Math.max(0, v)); g.energy.push(beat.energy ? beat.energy[k] : 0.7); } });
    (beat.downbeats || []).forEach(function (t) { var v = t - offset; if (v >= -0.02 && v <= until) g.downbeats.push(Math.max(0, v)); });
    return g.beats.length >= 2 ? g : null;
  }
  // opts: { size: {w,h}, canvas, host, silent, check(), onFrac(f), transitions: false, punches: false }
  async function finishClips(job, clips, sc, opts) {
    opts = opts || {};
    var chk = opts.check || function () { check(job); };
    if (!canRecord()) throw finErr('unsupported');
    if (document.hidden) throw finErr('hidden');
    var ctx = ensureAudio();
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') throw finErr('unsupported', 'No audio recording');
    if (ctx.state !== 'running') { try { await Promise.race([ctx.resume(), wait(900)]); } catch (e) { /* ignore */ } }
    if (ctx.state !== 'running' && !opts.silent) throw finErr('gesture');
    await loadLabelFont();
    var local = job.engine === 'local', story = !!job.story;
    var sound = opts.silent ? 'none' : job.sound;
    var host = opts.host || el.pv, cleanup = [];
    function clean() { cleanup.splice(0).forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); }
    try {
      // the clips, as hidden <video> elements in the page (so every browser keeps decoding frames)
      var vids = clips.map(function (c) {
        var url = URL.createObjectURL(c.blob), v = document.createElement('video');
        v.crossOrigin = 'anonymous'; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
        v.muted = true; v.className = 'ai-pv-src'; v.setAttribute('aria-hidden', 'true');
        host.appendChild(v); v.src = url;
        cleanup.push(function () { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } if (v.parentNode) v.parentNode.removeChild(v); URL.revokeObjectURL(url); });
        return v;
      });
      for (var w = 0; w < vids.length; w++) { await mediaReady(vids[w], 20000); chk(); }
      var durs = vids.map(function (v, k) { var d = v.duration; return d > 0 && isFinite(d) ? d : (clips[k].seconds || SHOT_SEC); });
      var lips = clips.map(function (c) { return !!c.lipSync; });
      var v0 = vids[0];
      if (!v0.videoWidth || !v0.videoHeight) throw finErr('decode', 'No picture');
      var W, H;
      if (opts.size) { W = opts.size.w; H = opts.size.h; }
      else if (local || story) { W = LOCAL_OUT.w; H = LOCAL_OUT.h; }
      else { var s2 = Math.min(1, 1920 / Math.max(v0.videoWidth, v0.videoHeight)); W = Math.max(2, Math.round(v0.videoWidth * s2 / 2) * 2); H = Math.max(2, Math.round(v0.videoHeight * s2 / 2) * 2); }

      // the soundtrack and its beat grid
      var trackBuf = null, soundStart = 0, beat = null, clipAudio = false, songOffsets = job.songOffsets || null;
      if (sound === 'own') {
        var own = S.own;
        if (!own || !own.buffer || (job.own && job.own.id && own.id !== job.own.id)) throw finErr('own-missing', 'Your song is no longer loaded');
        trackBuf = own.buffer; soundStart = job.own ? job.own.start : own.start; beat = ownPartBeat(own, soundStart, job.duration || S.duration);
      } else if (sound === 'ai' && local) {
        if (job.localAudio) { try { trackBuf = await decodeAudio(ctx, job.localAudio); } catch (e) { console.warn('[glow-ai] song decode failed', e); trackBuf = null; } }
        chk();
        if (trackBuf && window.GlowBeat) { try { beat = await window.GlowBeat.analyze(trackBuf); } catch (e) { beat = null; } }
        soundStart = job.songStart || 0;
        if (!trackBuf) clipAudio = true; // the lip-synced clips have the song muxed in
      } else if (sound === 'ai') {
        clipAudio = true; // fal Happy Horse: every clip brings its own sound
      } else if (sound === 'music') {
        var tr = trackById(job.trackId) || trackById(sc.defaultTrack);
        if (tr && window.GlowBeat) beat = window.GlowBeat.grid(tr.bpm, 60, 0);
      }
      // a story that starts with a lip-synced shot: the soundtrack starts at that shot's part of the song
      if (lips[0] && songOffsets && clips[0].id && songOffsets[clips[0].id] != null) soundStart = songOffsets[clips[0].id];
      var anchors = clips.map(function (c, k) {
        if (!lips[k]) return null;
        var at = songOffsets && c.id && songOffsets[c.id] != null ? songOffsets[c.id] : (c.audioStart != null ? c.audioStart : null);
        return at == null ? null : at - soundStart;
      });
      var grid = clipAudio || sound === 'none' ? null : gridShift(beat, soundStart, 90);
      var tl = planTimeline(durs, lips, anchors, grid);
      var B = tl.B, rate = tl.rate, total = tl.total, n = clips.length;
      var pulses = opts.punches === false ? [] : strongBeats(grid, B, total);
      var trans = opts.transitions === false ? 'cut' : (sc && sc.transition) || (n > 1 ? 'flash' : 'cut');
      UI.timeline = { B: B.map(r3), rate: rate.map(function (r) { return Math.round(r * 1000) / 1000; }), total: r3(total), soundStart: r3(soundStart), anchors: anchors, pulses: pulses.length, trans: trans, grid: !!grid };
      if (sound === 'music') {
        try { trackBuf = await getMusic(job.trackId || sc.defaultTrack, Math.max(1, total + 0.5)); } catch (e) { console.warn('[glow-ai] music failed', e); trackBuf = null; }
        chk();
        if (!trackBuf) toast('The music couldn’t be made — your video will be silent.', 'warn');
      }

      // the canvas the finished video is drawn on (in the progress sheet, so the user watches it being finished)
      var cv;
      if (opts.canvas) cv = opts.canvas;
      else { cv = el.pvCanvas.cloneNode(false); el.pvCanvas.parentNode.replaceChild(cv, el.pvCanvas); el.pvCanvas = cv; }
      cv.width = W; cv.height = H;
      var cx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      cx.imageSmoothingEnabled = true;
      try { cx.imageSmoothingQuality = 'high'; } catch (e) { /* older browsers */ }
      function drawClip(k, T, dx, alpha) {
        var v = vids[k], vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return;
        var segT = clamp((T - B[k]) / Math.max(0.1, B[k + 1] - B[k]), 0, 1);
        var kb = n > 1 ? 1 + 0.035 * (k % 2 ? 1 - segT : segT) : 1, punch = 0; // stories: slow push in / pull out, alternating
        pulses.forEach(function (p) { var d = T - p.t; if (d >= 0 && d < 0.45) punch += 0.04 * p.a * Math.exp(-d / 0.11); });
        if (lips[k]) punch *= 0.5;
        var cs = Math.max(W / vw, H / vh) * (kb + punch), dw = vw * cs, dh = vh * cs;
        cx.globalAlpha = alpha == null ? 1 : alpha;
        try { cx.drawImage(v, (W - dw) / 2 + (dx || 0), (H - dh) / 2, dw, dh); } catch (e) { /* frame not ready */ }
        cx.globalAlpha = 1;
      }
      function segAt(T) { var k = 0; while (k < n - 1 && T >= B[k + 1]) k++; return k; }
      function draw(T) {
        var k = segAt(T), lt = T - B[k];
        cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
        if (trans === 'whip' && k > 0 && lt < TRANS_SEC) {
          var p = lt / TRANS_SEC, e = 1 - Math.pow(1 - p, 3), blur = (1 - p) * W * 0.035;
          drawClip(k - 1, T, -e * W); drawClip(k, T, (1 - e) * W);
          if (blur > 1) { drawClip(k, T, (1 - e) * W + blur, 0.35); drawClip(k - 1, T, -e * W - blur, 0.35); }
        } else drawClip(k, T, 0);
        var light = 0;
        if (trans === 'flash' && k > 0 && lt < 0.24) light = 0.8 * Math.pow(1 - lt / 0.24, 2);
        pulses.forEach(function (p2) { var d = T - p2.t; if (d >= 0 && d < 0.3) light += 0.11 * p2.a * Math.exp(-d / 0.08); });
        if (light > 0.005) { cx.save(); cx.globalCompositeOperation = 'lighter'; cx.fillStyle = 'rgba(255,255,255,' + Math.min(0.9, light) + ')'; cx.fillRect(0, 0, W, H); cx.restore(); }
        if (T > total - FADE_V) { cx.fillStyle = 'rgba(0,0,0,' + clamp((T - (total - FADE_V)) / FADE_V, 0, 1) + ')'; cx.fillRect(0, 0, W, H); }
        drawLabel(cx, W, H); // always, on top of everything (also over the fade)
      }
      draw(0);
      if (!opts.canvas) el.pv.classList.add('has-video');

      // audio graph: soundtrack (or the clips' own sound) -> mix -> recorder (+ speakers while the user watches)
      var dest = ctx.createMediaStreamDestination(), mix = ctx.createGain(), mon = ctx.createGain(), late = ctx.createDelay(0.5);
      mix.gain.value = 1; mon.gain.value = opts.canvas ? 0 : (monitorWanted() ? 0.9 : 0);
      // the recorded sound goes through a short delay when this browser's recorder would put it ahead of the picture
      mix.connect(late); late.connect(dest); mix.connect(mon); mon.connect(ctx.destination);
      if (!opts.canvas) { UI.mon = mon; el.mon.hidden = false; }
      cleanup.push(function () { try { mix.disconnect(); late.disconnect(); } catch (e) { /* ignore */ } try { mon.disconnect(); } catch (e) { /* ignore */ } if (UI.mon === mon) { UI.mon = null; el.mon.hidden = true; } });
      var music = null, env = null, clipGains = [];
      if (trackBuf) {
        music = ctx.createBufferSource(); music.buffer = trackBuf;
        env = ctx.createGain(); env.gain.value = 0;
        music.connect(env); env.connect(mix);
        cleanup.push(function () { try { music.stop(); } catch (e) { /* ignore */ } try { music.disconnect(); env.disconnect(); } catch (e) { /* ignore */ } });
      } else if (clipAudio) {
        vids.forEach(function (v, k) {
          v.muted = false;
          var es = ctx.createMediaElementSource(v), g = ctx.createGain();
          g.gain.value = 0; es.connect(g); g.connect(mix); clipGains[k] = g;
          cleanup.push(function () { try { es.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } });
        });
      }

      // one frame per new clip frame where the browser can (no judder from a fixed 30 fps sampling of 32 fps clips)
      var vStream = null, vTrack = null, perFrame = false;
      if (typeof v0.requestVideoFrameCallback === 'function') {
        try { vStream = cv.captureStream(0); vTrack = vStream.getVideoTracks()[0]; perFrame = !!(vTrack && typeof vTrack.requestFrame === 'function'); } catch (e) { perFrame = false; }
        if (!perFrame && vStream) { vStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); vStream = null; }
      }
      if (!vStream) vStream = cv.captureStream(30);
      var tracksOut = vStream.getVideoTracks().concat(sound === 'none' ? [] : dest.stream.getAudioTracks());
      var stream = new MediaStream(tracksOut);
      cleanup.push(function () { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); });
      var mime = TEST.mime || pickMime();
      if (sound === 'none' && mime) mime = mime.replace(/,\s*(mp4a\.40\.2|opus)/, '').replace(/;codecs=$/, '');
      var ropts = { videoBitsPerSecond: Math.min(W, H) >= 1080 ? 12e6 : W >= 700 ? 10e6 : 3e6, audioBitsPerSecond: 192000 };
      if (mime) ropts.mimeType = mime;
      var rec;
      try { rec = new MediaRecorder(stream, ropts); } catch (e) { try { delete ropts.mimeType; rec = new MediaRecorder(stream, ropts); } catch (e2) { rec = new MediaRecorder(stream); } }
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      if (!opts.canvas) { document.documentElement.classList.add('glow-rec'); cleanup.push(function () { document.documentElement.classList.remove('glow-rec'); }); }

      var thumbBlob = null, skew = 0;
      if (sound !== 'none') {
        setStep('finish', null, 'Getting the recorder ready…');
        skew = await avSkew(ctx, ropts.mimeType);
        chk();
        if (skew < 0) late.delayTime.value = Math.min(0.45, -skew);
      }
      UI.timeline.skew = Math.round(skew * 1000) / 1000;
      var result = await new Promise(function (resolve, reject) {
        var settled = false, stopping = false, raf = 0, watchdog = 0, t0 = 0, started = [], released = [], newFrame = false, lastGrab = 0, grabs = 0, lastPct = -1;
        var useCtx = true, lastCt = -1, lastCtAt = 0, base = 0, baseAt = 0, lastVT = -1, lastVMove = 0;
        function clock() {
          var now = performance.now();
          if (useCtx) {
            var ct = ctx.currentTime;
            if (ct !== lastCt) { lastCt = ct; lastCtAt = now; return ct - t0; }
            if (now - lastCtAt < 800) return ct - t0;
            useCtx = false; base = ct - t0; baseAt = lastCtAt; // the audio clock stopped: carry on with the wall clock
          }
          return base + (now - baseAt) / 1000;
        }
        function grab() { grabs++; try { vTrack.requestFrame(); } catch (e) { /* ignore */ } }
        vids.forEach(function (v, k) {
          if (!perFrame) return;
          var cb = function () { if (settled) return; newFrame = true; v.requestVideoFrameCallback(cb); };
          v.requestVideoFrameCallback(cb);
        });
        function stopAll() { cancelAnimationFrame(raf); clearInterval(watchdog); document.removeEventListener('visibilitychange', onVis); vids.forEach(function (v) { try { v.pause(); } catch (e) { /* ignore */ } }); }
        function fail(e) { if (settled) return; settled = true; stopAll(); try { rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); } catch (x) { /* ignore */ } reject(e); }
        function onVis() { if (document.hidden && !stopping) fail(finErr('hidden')); }
        document.addEventListener('visibilitychange', onVis);
        function control(T) {
          for (var k = 0; k < n; k++) {
            if (!started[k] && T >= B[k] - 0.004) {
              started[k] = true;
              var v = vids[k];
              try { v.playbackRate = rate[k]; } catch (e) { /* ignore */ }
              var pr = v.play();
              if (pr && pr.catch) pr.catch(function (e) { if (!settled) fail(finErr(e && e.name === 'NotAllowedError' ? 'gesture' : 'decode', String(e && e.message || e))); });
              if (clipGains[k]) { var at = ctx.currentTime; clipGains[k].gain.setValueAtTime(0, at); clipGains[k].gain.linearRampToValueAtTime(1, at + 0.03); }
              if (k > 0) {
                var prev = vids[k - 1], pg = clipGains[k - 1];
                if (pg) { var at2 = ctx.currentTime; pg.gain.setValueAtTime(pg.gain.value, at2); pg.gain.linearRampToValueAtTime(0, at2 + 0.04); }
                // the shot before is never drawn again after its transition: free its decoder (phones have few)
                setTimeout(function () { try { prev.pause(); } catch (e) { /* ignore */ } released[k - 1] = true; try { prev.removeAttribute('src'); prev.load(); } catch (e) { /* ignore */ } }, (TRANS_SEC + 0.05) * 1000);
              }
            }
          }
          var a = segAt(T), va = vids[a];
          if (!started[a]) return;
          var want = (T - B[a]) * rate[a];
          if (want < durs[a] - 0.06 && !va.ended) {
            var err = va.currentTime - want;
            if (Math.abs(err) > 0.3) { try { va.currentTime = Math.max(0, want); } catch (e) { /* ignore */ } }
            else if (!clipAudio) {
              var r = clamp(rate[a] * (1 - err * 1.5), rate[a] * 0.9, rate[a] * 1.1);
              if (Math.abs(va.playbackRate - r) > 0.004) { try { va.playbackRate = r; } catch (e) { /* ignore */ } }
            }
            if (va.currentTime !== lastVT) { lastVT = va.currentTime; lastVMove = performance.now(); }
          } else lastVMove = performance.now();
        }
        function loop() {
          if (settled || stopping) return;
          var T = Math.max(0, clock());
          control(T);
          var now = performance.now();
          if (!perFrame) draw(Math.min(T, total));
          else if (newFrame || now - lastGrab > 34) { newFrame = false; lastGrab = now; draw(Math.min(T, total)); grab(); }
          var f = clamp(T / total, 0, 1);
          if (opts.onFrac) opts.onFrac(f);
          else {
            UI.finishFrac = f;
            var pc = Math.round(f * 100);
            if (pc !== lastPct) { lastPct = pc; setStep('finish', null, pc + '%'); }
          }
          if (!thumbBlob && T >= Math.min(1.2, total * 0.3)) {
            thumbBlob = 'pending';
            toBlob(drawScaled(cv, W, H, 480), 'image/jpeg', 0.82).then(function (b) { thumbBlob = b; }, function () { thumbBlob = null; });
          }
          if (T >= total) { finish(); return; }
          raf = requestAnimationFrame(loop);
        }
        function finish() {
          if (settled || stopping) return;
          stopping = true;
          draw(total); if (perFrame) grab();
          UI.capture = perFrame ? 'per-frame' : 'fixed 30 fps';
          UI.captureFrames = perFrame ? grabs : null;
          var recMs = (performance.now() - t0w);
          setTimeout(function () {
            rec.onstop = function () {
              if (settled) return; settled = true; stopAll();
              var type = (rec.mimeType || ropts.mimeType || 'video/webm').split(';')[0] || 'video/webm';
              var out = new Blob(chunks, { type: type });
              if (!out.size) { reject(finErr('record', 'empty recording')); return; }
              if (/webm/i.test(type)) fixDuration(out, recMs + 140).then(function (b) { resolve({ blob: b, type: type }); }, function () { resolve({ blob: out, type: type }); });
              else resolve({ blob: out, type: type });
            };
            try { rec.stop(); } catch (e) { fail(e); }
          }, 140);
        }
        rec.onerror = function (e) { fail((e && e.error) || finErr('record', 'recorder error')); };
        vids.forEach(function (v, k) { v.addEventListener('error', function () { if (!released[k]) fail(finErr('decode', 'Playback error')); }); });
        watchdog = setInterval(function () {
          if (settled || stopping) return;
          if (performance.now() - lastVMove > 7000) fail(finErr('stalled', 'Playback stalled'));
          // rAF stops in a background window: the clock check keeps the recording ending on time
          if (clock() >= total + 0.4) finish();
        }, 400);
        vids.forEach(function (v) { try { v.currentTime = 0; } catch (e) { /* ignore */ } });
        // The soundtrack, the first clip and the clock start together at the moment the recorder really begins to
        // capture (measured just before, see captureLag), so the finished file begins exactly at the chosen start
        // point of the song. Until then the first frame (with the label) is shown.
        var t0w = performance.now(), began = false;
        function begin() {
          if (began || settled) return;
          began = true;
          t0w = performance.now();
          t0 = ctx.currentTime; lastCt = t0; lastCtAt = t0w; lastVMove = t0w;
          if (music && env) {
            env.gain.setValueAtTime(0, t0);
            env.gain.linearRampToValueAtTime(0.92, t0 + 0.02);
            var fadeAt = Math.max(t0 + 0.2, t0 + total - FADE_A);
            env.gain.setValueAtTime(0.92, fadeAt);
            env.gain.linearRampToValueAtTime(0, t0 + total + 0.02);
            // (a recorder that puts the sound behind the picture: the song starts that much further in)
            try { music.start(t0, clamp(soundStart + Math.max(0, skew), 0, Math.max(0, trackBuf.duration - 0.05))); } catch (e) { /* ignore */ }
          }
          raf = requestAnimationFrame(loop);
        }
        // The picture, the soundtrack and the clock start together with the recorder. Its sound track only begins
        // a little later (see avSkew): the delay node above holds the sound back by exactly that much, so the file
        // begins at the chosen start point of the song with the picture in sync.
        if (perFrame) { draw(0); grab(); lastGrab = performance.now(); }
        try { rec.start(250); } catch (e) { fail(e); return; }
        begin();
        // frames at display rate while the recorder attaches, so its first picture comes as early as its first sound
        if (perFrame) {
          var burst = setInterval(function () { if (settled || stopping) { clearInterval(burst); return; } draw(Math.max(0, clock())); grab(); lastGrab = performance.now(); }, BURST_MS);
          setTimeout(function () { clearInterval(burst); }, 150);
        }
      });
      if (thumbBlob === 'pending') await wait(150);
      if (!(thumbBlob instanceof Blob)) { try { thumbBlob = await toBlob(drawScaled(cv, W, H, 480), 'image/jpeg', 0.82); } catch (e) { thumbBlob = null; } }
      return { blob: result.blob, type: result.type, width: W, height: H, duration: total, thumb: thumbBlob, labelled: true, timeline: UI.timeline };
    } finally {
      clean();
    }
  }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  /* How far this browser's MediaRecorder puts the sound ahead of (negative) or behind (positive) the picture. Chrome's
   * MP4 recorder starts each track at its own first frame, and the first sound frame comes a few tens of
   * milliseconds after the first picture, so the sound would lead the picture (lips moving after the singing). It
   * is measured once per page and container: a one-second silent test recording (never played on the speakers) with
   * a click and a white flash at the same moment, started the same way as the real one; the click is found in the
   * decoded sound, the flash by playing the test file back. */
  var AVSKEW = {};
  function avSkew(ctx, mime) {
    var key = mime || 'default';
    if (AVSKEW[key] != null) return Promise.resolve(AVSKEW[key]);
    if (TEST.avSkew != null) return Promise.resolve(TEST.avSkew);
    var got = [];
    var one = function () { return skewOnce(ctx, mime).then(function (v) { if (v != null) got.push(v); }); };
    return one().then(one).then(one).then(function () {
      if (!got.length) return 0;
      got.sort(function (a, b) { return a - b; });
      var v = got[got.length >> 1];
      AVSKEW[key] = v;
      return v;
    });
  }
  function skewOnce(ctx, mime) {
    return new Promise(function (resolve) {
      var done = false, parts = [];
      function fin(v) { if (done) return; done = true; parts.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); resolve(v); }
      setTimeout(function () { fin(null); }, 8000);
      try {
        var dest = ctx.createMediaStreamDestination(), g = ctx.createGain(), mute = ctx.createGain(); mute.gain.value = 0;
        g.connect(dest); g.connect(mute); mute.connect(ctx.destination);
        parts.push(function () { g.disconnect(); mute.disconnect(); });
        var cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
        var cx = cv.getContext('2d'), vs = cv.captureStream(0), vt = vs.getVideoTracks()[0];
        var st = new MediaStream(vs.getVideoTracks().concat(dest.stream.getAudioTracks()));
        parts.push(function () { st.getTracks().forEach(function (t) { t.stop(); }); });
        var rec; try { rec = new MediaRecorder(st, mime ? { mimeType: mime } : {}); } catch (e) { rec = new MediaRecorder(st); }
        var chunks = [], AT = 0.45, n = Math.round(ctx.sampleRate * 0.03), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 2000 * i / ctx.sampleRate) * 0.9;
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          var type = (rec.mimeType || mime || 'video/webm').split(';')[0], blob = new Blob(chunks, { type: type });
          Promise.all([clickAt(ctx, blob), flashAt(blob)]).then(function (r) {
            fin(r[0] == null || r[1] == null ? null : clamp(r[0] - r[1], -0.25, 0.25));
          }, function () { fin(null); });
        };
        cx.fillStyle = '#000'; cx.fillRect(0, 0, 32, 32);
        try { vt.requestFrame(); } catch (e) { /* ignore */ }
        // the same start as the real recording (picture + sound + clock together, frames in quick succession)
        rec.start(250);
        var t0 = ctx.currentTime, src = ctx.createBufferSource();
        src.buffer = buf; src.connect(g); src.start(t0 + AT);
        var iv = setInterval(function () {
          if (done) { clearInterval(iv); return; }
          var T = ctx.currentTime - t0;
          cx.fillStyle = T >= AT && T < AT + 0.15 ? '#fff' : '#000'; cx.fillRect(0, 0, 32, 32);
          try { vt.requestFrame(); } catch (e) { /* ignore */ }
          if (T > AT + 0.5) { clearInterval(iv); try { rec.stop(); } catch (e) { fin(null); } }
        }, BURST_MS);
        parts.push(function () { clearInterval(iv); });
      } catch (e) { fin(null); }
    });
  }
  function clickAt(ctx, blob) {
    return decodeAudio(ctx, blob).then(function (ab) {
      var x = ab.getChannelData(0), mx = 0, k;
      for (k = 0; k < x.length; k++) if (Math.abs(x[k]) > mx) mx = Math.abs(x[k]);
      if (!(mx > 0.05)) return null;
      for (k = 0; k < x.length && Math.abs(x[k]) < mx * 0.3; k++) { /* the click */ }
      return k / ab.sampleRate;
    }, function () { return null; });
  }
  function flashAt(blob) {
    return new Promise(function (resolve) {
      var v = document.createElement('video'), url = URL.createObjectURL(blob), c = document.createElement('canvas'), x;
      c.width = 4; c.height = 4; x = c.getContext('2d', { willReadFrequently: true });
      var done = false, fin = function (t) { if (done) return; done = true; try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); v.remove(); URL.revokeObjectURL(url); resolve(t); };
      v.muted = true; v.playsInline = true; v.className = 'ai-pv-src'; v.setAttribute('aria-hidden', 'true');
      (document.getElementById('aiSeeHost') ? seeHost() : seeHost()).appendChild(v);
      if (typeof v.requestVideoFrameCallback !== 'function') { fin(null); return; }
      var cb = function (now, meta) {
        if (done) return;
        try { x.drawImage(v, 0, 0, 4, 4); var px = x.getImageData(1, 1, 1, 1).data; if (px[0] > 128) { fin(meta.mediaTime); return; } } catch (e) { fin(null); return; }
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.onended = function () { fin(null); };
      v.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 7000);
      v.src = url;
      v.playbackRate = 0.25; // every frame is presented (and seen by the frame callback)
      var pr = v.play(); if (pr && pr.catch) pr.catch(function () { fin(null); });
    });
  }

  /* ------------------------------------------------------------------ *
   * Completion, errors, cancel
   * ------------------------------------------------------------------ */
  function otherModalOpen() { return !!document.querySelector('.modal:not(.ai-modal):not([hidden])'); }
  async function completeJob(job, fin) {
    var sc = sceneById(job.sceneId);
    setStep('finish', 'done', 'Done');
    UI.finishFrac = 1; tick();
    // Only ever a labelled file from finishVideo() lands here.
    var item = {
      id: job.id, createdAt: Date.now(), sceneId: sc.id, sceneName: sc.name, sound: job.sound, trackId: job.sound === 'music' ? job.trackId : null,
      duration: fin.duration || job.duration, width: fin.width || null, height: fin.height || null,
      type: fin.type || (fin.blob && fin.blob.type) || 'video/webm',
      size: fin.blob ? fin.blob.size : 0, blob: fin.blob, thumb: fin.thumb || null,
      rawUrl: job.story ? null : job.videoUrl, stillUrl: job.engine === 'local' ? null : job.stillUrl, labelled: true, note: '', engine: job.engine === 'local' ? 'local' : 'fal',
      story: !!job.story, shots: job.shots ? job.shots.length : 1, sync: job.sync || 'beat', ownName: job.own ? job.own.name : null
    };
    if (job.engine === 'local') { item.quality = job.quality; item.localJob = job.engineJob || null; }
    if (GUEST) item.host = job.host || GG.hostName();
    if (!item.thumb && job.stillUrl && job.engine !== 'local') item.thumbUrl = job.stillUrl;
    // the same engine video saved by another window already (it finished it first): keep that one, never two
    var dup = job.engine === 'local' && job.engineJob ? await findLocalItem(job.engineJob) : null;
    if (dup) { item = dup; if (!H.list.some(function (x) { return x.id === dup.id; })) await loadHistory(); }
    else await historyAdd(item);
    endRun();
    if (job.engine === 'local') {
      // the labelled video is saved: the engine may forget the job and delete its copies (selfie + raw outputs)
      if (job.engineJob) LOC.api.release(job.engineJob);
      LOC.retry = null; LOC.resume = null; clearLocalMeta(); renderEngine();
      setTimeout(revokeUrls, 1500); // (the scene photos of this video, once its progress sheet is closed)
    }
    else { clearJob(); S.retryJob = null; }
    UI.state = 'done';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    var quiet = UI.minimized || mode() !== 'ai' || !el.conn.hidden || !el.res.hidden || otherModalOpen();
    closeSheet(el.prog);
    UI.minimized = false;
    updateCost();
    announce('Your AI video is ready');
    if (quiet) {
      readyItem = item;
      setPill('ready');
      toast('Your AI video is ready!', 'ok', 4000);
    } else {
      setPill(null);
      showResult(item, { fresh: true });
    }
  }
  var readyItem = null;
  function videoPrice(job) { return (job.sound === 'ai' ? PRICE.ai : PRICE.std) * (job.duration || 5); }
  function errorView(e, job) {
    var kind = e && e.kind || (e && e.code) || 'server';
    var detail = e && e.detail ? String(e.detail) : (e && e.message ? String(e.message) : '');
    var paid = job && job.story ? (job.shots.some(function (x) { return x.stillUrl || x.videoUrl; }) ? ' The shots that are already made are kept, so trying again only makes what is missing.' : '')
      : job && job.stillUrl ? ' Your scene photo is saved, so trying again only makes the video.' : '';
    var safe = ' Your video is safe at fal.ai and already paid for, so trying again costs nothing extra.';
    var live = !!(e && e.live);
    switch (kind) {
      case 'auth': return { t: 'fal.ai didn’t accept your key', p: 'Check that you pasted the whole key (two parts joined by a colon), or create a new one on fal.ai.' + (live ? ' Then we’ll pick up your video again without paying twice.' : ''), a: ['key', 'keys'] };
      case 'credit': return { t: 'Your fal.ai balance needs a top-up', p: 'fal.ai says this account is out of credit or locked. Add credit on fal.ai, then try again' + (live ? '.' : ' — nothing was charged for this attempt.') + paid, a: ['billing', 'retry'] };
      case 'permission': return { t: 'This key can’t use the AI models', p: 'When you create the key on fal.ai, choose the “API” preset (or allow these models). Then paste the new key here.', a: ['keys', 'key'] };
      case 'moderation': return { t: 'This one didn’t pass fal.ai’s safety check', p: 'Their content filter stopped this photo or scene, and we respect that. Try a different photo — one person, face clearly visible, everyday clothes — or pick another scene. ' + (job && job.story ? 'Shots that were already made were charged; the blocked one wasn’t, and the rest were stopped.' : job && job.stillUrl ? 'The scene photo was charged; the blocked video wasn’t.' : 'Blocked results aren’t charged.'), a: ['photo', 'scene'] };
      case 'face': return { t: 'We couldn’t find a clear face', p: 'Use a photo where your face is clearly visible, in good light, with just you in it.', a: ['photo'] };
      case 'photo': return { t: 'fal.ai couldn’t use this photo', p: (detail ? detail + ' ' : '') + 'Try another photo, at least 300 px on each side.', a: ['photo', 'retry'] };
      case 'validation': return { t: 'fal.ai couldn’t start this one', p: (detail || 'The request was rejected.') + paid, a: ['retry', 'scene'] };
      case 'nomedia': return { t: 'The AI didn’t make anything this time', p: 'That can happen with some photos. Try again, or use a different photo or scene.' + (detail && detail.length < 200 ? ' (' + detail + ')' : ''), a: ['retry', 'photo'] };
      case 'notfound': return { t: 'This request has expired', p: 'fal.ai no longer has this result. Please start again.', a: ['retry'] };
      case 'network': return { t: 'Couldn’t reach fal.ai', p: 'Check your internet connection and try again.' + (live ? safe : paid), a: live ? ['retry', 'discard'] : ['retry'] };
      case 'download': return { t: 'Your video is made, but it didn’t download', p: 'We couldn’t download the finished video from fal.ai. Check your connection and try again.' + safe, a: ['finish', 'discard'] };
      case 'gone': return { t: 'fal.ai’s file for this video is no longer available', p: 'The finished video was removed from fal.ai before it could be downloaded. Making it again costs about ' + money(job && job.story ? falCost(sceneById(job.sceneId), job.sound, job.duration) : videoPrice(job)) + '.' + paid, a: ['retry'] };
      case 'own-missing': return { t: 'Add your song again', p: 'Your video is made, but your song isn’t loaded any more (the page was reloaded). Choose the same song file again and we’ll finish it — no extra cost.', a: ['sound', 'finish'] };
      case 'finish':
        if (e.code === 'own-missing') return errorView({ kind: 'own-missing' }, job);
        if (e.code === 'unsupported') return { t: 'This browser can’t finish AI videos', p: 'Adding the AI label and the sound needs a browser that can record video. Open Glow Studio in Chrome, Edge or Safari.' + safe, a: ['finish', 'discard'] };
        if (e.code === 'decode') return { t: 'This browser couldn’t open the video', p: 'Your video is made, but this browser can’t play fal.ai’s file to add the AI label. Try again, or use Chrome, Edge or Safari.' + safe, a: ['finish', 'discard'] };
        return { t: 'Finishing didn’t complete', p: 'Adding the AI label and the sound stopped halfway. Keep this tab open and in front while it finishes, then try again.' + safe, a: ['finish', 'discard'] };
      case 'upload': return { t: 'Your photo didn’t upload', p: 'Check your connection and try again.', a: ['retry'] };
      case 'nophoto': return { t: 'Add your photo again', p: 'The page was reloaded before your photo was sent. Please choose it again — nothing was charged.', a: ['photo'] };
      case 'rate': return { t: 'fal.ai is very busy', p: 'Please try again in a minute.' + (live ? safe : ''), a: ['retry'] };
      case 'cancelled': return { t: 'This request was cancelled', p: 'Start again whenever you like.', a: ['retry'] };
      default: return { t: 'fal.ai had a problem making this video', p: 'Their servers couldn’t finish it. fal.ai only charges for successful results. Try again in a moment.' + paid + (detail && detail.length < 160 ? ' (' + detail + ')' : ''), a: ['retry'] };
    }
  }
  // What "Try again" may reuse when nothing at fal can be picked up again: the scene photo (paid for, and it depends
  // only on the photo and the scene, so the sound and length can still change).
  function stillStub(job) {
    return { sceneId: job.sceneId, sound: job.sound, trackId: job.trackId, duration: job.duration, stillUrl: job.stillUrl, thumb: job.thumb, photoSeq: job.photoSeq, ref: job.ref || null };
  }
  function resumable(job, e) {
    if (!e || !e.live) return false;
    return !!(job.videoUrl || job.video || job.still);
  }
  function failJob(job, e) {
    console.warn('[glow-ai] job failed', e);
    endRun();
    UI.state = 'error';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    var v = errorView(e, job);
    if (resumable(job, e)) {
      // Something paid for is still at fal (or already here): keep it so "Try again" or a reload picks it up.
      savePaused(job);
      S.retryJob = { resume: job };
    } else {
      clearJob();
      var keepStill = job.stillUrl && e.kind !== 'moderation' && e.kind !== 'auth';
      S.retryJob = keepStill ? stillStub(job) : null;
    }
    renderJobError(v, job);
  }
  // The error panel in the progress sheet (cloud and this PC). v: { t: title, p: text, a: [actions], detail?, tt?: the sheet's heading }
  function renderJobError(v, job) {
    var local = job && job.engine === 'local';
    UI.errEngine = local ? 'local' : 'fal'; // the panel's actions belong to the engine that made this video
    el.pv.classList.add('error');
    el.err.hidden = false;
    el.errT.textContent = v.t; el.errP.textContent = v.p;
    if (el.errDet) { el.errDet.hidden = !v.detail; el.errDet.open = false; el.errDetP.textContent = v.detail || ''; }
    el.errActions.textContent = '';
    v.a.forEach(function (a, i) {
      var link = a === 'billing' || a === 'keys' || a === 'driver' || a === 'vcredist';
      var b = document.createElement(link ? 'a' : 'button');
      b.className = 'btn ' + (a === 'discard' ? 'text ai-danger' : i === 0 ? 'primary' : 'glass');
      if (link) {
        b.href = a === 'billing' ? BILLING_URL : a === 'keys' ? KEYS_URL : a === 'vcredist' ? ((LOC.api && LOC.api.vcRedistUrl) || 'https://aka.ms/vc14/vc_redist.x64.exe') : (LOC.api ? LOC.api.driverUrl : 'https://www.nvidia.com/Download/index.aspx');
        b.target = '_blank'; b.rel = 'noopener';
      }
      else b.type = 'button';
      var retryLabel = local ? 'Try again · free'
        : S.retryJob && S.retryJob.resume ? (job && job.story && storyMissingCost(S.retryJob.resume) > 0.004 ? 'Try again · about ' + money(storyMissingCost(S.retryJob.resume)) + ' for the missing shots' : 'Try again — no extra cost')
        : job && job.story ? 'Try again · about ' + money(falCost(sceneById(job.sceneId), job.sound, job.duration)) : 'Try again · about ' + money(S.retryJob && S.retryJob.stillUrl ? videoPrice(job) : estimate(job.sound, job.duration));
      b.textContent = { key: 'Fix my key', keys: 'Open fal.ai keys', billing: 'Add credit on fal.ai', retry: retryLabel, finish: 'Try finishing again', photo: 'Choose another photo', scene: 'Pick another scene', discard: 'Discard this video',
        repair: 'Check & repair files', setup: 'Open Free AI on this PC', driver: 'Update NVIDIA driver', vcredist: 'Get the Microsoft component', singing: 'Get the Singing add-on',
        fast: 'Switch to Fast & try again', fal: 'Use fal.ai cloud instead', sound: 'Choose my song again' }[a];
      if (a === 'discard') b.dataset.armed = '';
      b.addEventListener('click', function () {
        if (a === 'discard' && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to discard it (it was paid for)'; return; }
        errAction(a);
      });
      el.errActions.appendChild(b);
    });
    el.cancel.hidden = false; el.cancel.textContent = 'Close';
    el.min.setAttribute('aria-label', 'Close'); el.min.title = 'Close';
    el.tapFinish.hidden = true; el.keepOpen.hidden = true; el.mon.hidden = true;
    if (el.shareNote) el.shareNote.hidden = true;
    el.progTt.textContent = v.tt || 'Something went wrong';
    setMsg('');
    el.eta.textContent = '';
    ['still', 'video', 'finish'].forEach(function (s) { var li = el.steps.querySelector('[data-step="' + s + '"]'); if (li && li.dataset.state === 'active') { li.dataset.state = 'error'; setStep(s, null, 'Stopped'); } });
    el.elapsed.parentNode.hidden = true;
    updateCost();
    // Working in the background (minimized, in Photo Video, or another sheet is open): don't pop up over it.
    var background = UI.minimized || el.prog.hidden || mode() !== 'ai' || otherModalOpen() || !el.res.hidden || !el.conn.hidden;
    if (background) {
      UI.minimized = true;
      setPill('error');
      toast('Your AI video hit a snag — tap the bar at the bottom to see what happened.', 'warn', 5000);
      return;
    }
    setPill(null);
    setTimeout(function () { var f = el.errActions.querySelector('.btn'); if (f) try { f.focus(); } catch (x) { /* ignore */ } }, 60);
  }
  function errAction(a) {
    if (a === 'billing' || a === 'keys' || a === 'driver' || a === 'vcredist') return; // links open in a new tab
    if (mode() !== 'ai') setMode('ai');
    closeProgressSheet();
    if (a === 'repair' || a === 'setup' || a === 'singing') { goSetup(a === 'repair' ? 'repair' : a === 'singing' ? 'singing' : 'setup'); return; }
    if (a === 'fal') { chooseEngine('fal', true); toast('Switched to fal.ai cloud.', 'info', 2500); return; }
    if (a === 'fast') { S.quality = 'fast'; savePrefs(); updateAll(); onMake({ retry: true, engine: 'local' }); return; }
    if (a === 'key') openConnect(pausedJob() ? 'resume' : null);
    else if (a === 'photo') { attention(el.photoCard); openPicker(); }
    else if (a === 'sound') { if (el.soundCard) attention(el.soundCard); S.sound = 'own'; S.userSound = 'own'; updateAll(); openOwnPicker(); }
    else if (a === 'scene') { attention(el.sceneCard); var b = sceneBtns[S.sceneId]; if (b) try { b.btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    else if (a === 'retry' || a === 'finish') onMake({ retry: true, engine: UI.errEngine });
    else if (a === 'discard') discardPaused();
  }
  function discardPaused() {
    var j = pausedJob();
    S.retryJob = null;
    if (j) {
      var s = storedJob();
      if (s && s.id === j.id && s.paused) clearJob();
      if (j.video && !j.videoUrl) cancelRemote(j.video);
      else if (j.still && !j.stillUrl) cancelRemote(j.still);
    }
    updateCost();
    toast('Discarded. You can make a new video any time.', 'info', 3000);
  }
  // The scene photo had already finished when Cancel was tapped: keep it for next time.
  function collectStill(job, h) {
    return falFetch(h.response_url, { method: 'GET' }, true).then(function (r) {
      var img = r.ok && r.body && Array.isArray(r.body.images) ? r.body.images[0] : null;
      if (!img || typeof img.url !== 'string') return false;
      if (!running() && !S.retryJob) { job.stillUrl = img.url; S.retryJob = stillStub(job); updateCost(); }
      return true;
    }, function () { return false; });
  }
  function cancelJob() {
    var job = RUN.job;
    if (!job) { closeProgressSheet(); return; }
    if (job.engine === 'local') { cancelLocal(job); return; }
    if (UI.stage === 'finish') return; // already paid for: always finish
    if (job.story) { cancelStory(job); return; }
    RUN.cancelled = true;
    var stage = job.video ? 'video' : job.still ? 'still' : '', h = job.video || job.still;
    var wasRunning = UI.lastStatus[stage] === 'IN_PROGRESS';
    endRun(); wakeAll();
    clearJob();
    UI.state = 'idle';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    closeProgressSheet(); setPill(null);
    // The scene photo is paid for once it exists: the next "Make my video" (same photo and scene) only makes the video.
    S.retryJob = job.stillUrl ? stillStub(job) : null;
    updateCost();
    if (!h) { toast('Cancelled — nothing was charged.', 'info', 4000); return; }
    var still = money(PRICE.still);
    cancelRemote(h).then(function (res) {
      if (res.state === 'ALREADY_COMPLETED') {
        if (stage === 'video' && !running()) {
          // It finished just as Cancel was tapped and is paid for: keep it.
          toast('Your video had just finished, so we’re keeping it — no extra cost.', 'ok', 5000);
          job.tries = job.tries || {};
          startRun(job, { resumed: true });
          return;
        }
        collectStill(job, h).then(function (ok) {
          toast(ok ? 'Cancelled. Your scene photo (about ' + still + ') had just been made — we’ll reuse it if you try this scene again.' : 'Cancelled. The scene photo had just been made, so fal.ai charges for it (about ' + still + ').', 'info', 7000);
        });
        return;
      }
      var maybe = res.state === 'CANCELLATION_REQUESTED' || (res.state !== 'OK' && wasRunning);
      var t;
      if (!res.status) t = 'Cancelled here, but fal.ai couldn’t be reached to stop it, so it may still be charged.';
      else if (stage === 'still') t = maybe ? 'Cancelled. The scene photo was already being made, so fal.ai may still charge for it (about ' + still + ').' : 'Cancelled — nothing was charged.';
      else t = (maybe ? 'Cancelled. The video was already being made, so fal.ai may still charge for it. ' : 'Cancelled — the video wasn’t charged. ') +
        'Your scene photo (about ' + still + ') was already made — we’ll reuse it if you try this scene again.';
      toast(t, 'info', 7000);
    });
  }

  /* ------------------------------------------------------------------ *
   * Make
   * ------------------------------------------------------------------ */
  var MAX_JOB_AGE = 24 * 3600e3; // fal keeps results (payload storage on) and the CDN keeps files for a day
  function paidStarted(j) { return !!(j && (j.stillUrl || j.still || j.video || j.videoUrl)); }
  function refuseUnsupported() {
    toast('This browser can’t finish AI videos (adding the AI label needs video recording). Open Glow Studio in Chrome, Edge or Safari.', 'warn', 8000);
  }
  // Photo + consent are needed for every new video (the consent is per photo, including the 18+ part).
  function photoReady() {
    if (!S.photo) {
      toast('Add your selfie first.', 'warn');
      attention(el.photoCard);
      setTimeout(function () { try { el.pick.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 300);
      return false;
    }
    if (!S.consent) {
      toast('Tick the box: it’s you or you have permission, and they’re 18 or older.', 'warn', 4800);
      attention(el.consentRow);
      el.consentRow.classList.add('need');
      setTimeout(function () { try { el.consent.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 300);
      return false;
    }
    return true;
  }
  // Free AI on this PC
  async function onMakeLocal(opts) {
    if (GUEST && !LOC.retry) return onMakeGuest(opts);
    if (LOC.retry) { if (!canRecord()) { refuseUnsupported(); return; } startLocalRun(LOC.retry, { resumed: true }); return; }
    if (LOC.resume) {
      // the offer may be out of date (finished or discarded in another window): then make a new video normally
      var went = await continueLocal();
      if (went !== 'stale' || !S.photo) return;
    }
    var sc = sceneById(S.sceneId), sound = effSound(sc), st = localState();
    if (st === 'checking' || st === 'offline' || (opts && opts.retry)) {
      RUN.starting = true;
      try { await refreshLocal(); } finally { RUN.starting = false; }
      if (running()) return;
      st = localState(); sound = effSound(sc);
      if (st === 'offline') { toast('Free AI on this PC isn’t answering. Wait a moment and try again, or use fal.ai cloud.', 'warn', 6000); return; }
    }
    if (st === 'setup' || st === 'installing' || st === 'paused' || st === 'install-error' || st === 'repairing') { goSetup(); return; }
    if (st === 'nogpu') { chooseEngine('fal', true); toast('Free AI can’t run on this PC (it needs an NVIDIA RTX graphics card with 8 GB), so fal.ai cloud is chosen.', 'info', 6000); attention(el.engCard); return; }
    if (sound === 'ai' && !singingOk()) { goSetup('singing'); return; }
    // "Try again" after a hiccup the engine kept its record of (connection, engine restart, …): continue that video
    if (opts && opts.retry) {
      var r = null;
      try { r = await LOC.api.resume(); } catch (e) { r = null; }
      if (running()) return;
      if (r && r.canAttach) {
        if (!(await localLockFree())) { otherWindowBusy(); toast('That video is being made in another Glow Studio window.', 'info', 5000); return; }
        LOC.resume = r; continueLocal(); return;
      }
      if (r && (await localLockFree())) r.discard();
    }
    if (sound === 'own' && !S.own) { toast('Choose your song first.', 'warn'); attention(el.soundCard); openOwnPicker(); return; }
    if (!photoReady()) return;
    if (!canRecord()) { refuseUnsupported(); return; }
    if (SEE.running) { seePause('Your video comes first — the previews go on by themselves when it’s done.'); SEE.resumeAfter = true; }
    var plan = planFor(sc, { sound: sound });
    startLocalRun(localJob(sc, sound, S.trackId, plan.quality, S.photo.thumb, plan), {});
  }
  // "Continue your video" / "Finish my video". Resolves 'started', 'busy' (another window has it), 'stale' (the offer
  // was out of date) or '' (nothing done).
  async function continueLocal() {
    var old = LOC.resume;
    if (!old) return '';
    ensureAudio();
    if (running() || RUN.starting) { toast('Please wait until the current video is done.', 'warn', 3500); return ''; }
    if (!canRecord()) { refuseUnsupported(); return ''; }
    RUN.starting = true;
    var free = true, r = null;
    try {
      free = await localLockFree();
      if (free) { try { r = await LOC.api.resume(); } catch (e) { r = null; } }
    } finally { RUN.starting = false; }
    if (running()) return '';
    if (!free) {
      otherWindowBusy();
      toast('This video is being made in another Glow Studio window — you can watch it there.', 'info', 5000);
      return 'busy';
    }
    if (!r || r.job !== old.job || !r.canAttach) {
      // finished (or discarded) meanwhile, e.g. in another window
      if (r && !r.canAttach) r.discard();
      LOC.resume = null;
      if (!r || r.job !== old.job) clearLocalMetaFor(old.job);
      renderEngine(); updateCost();
      var item = await findLocalItem(old.job);
      await loadHistory();
      toast(item ? 'That video was already finished — it’s in My AI videos.' : 'That video was stopped in another window.' + (S.photo ? ' Making a new one…' : ''), 'info', 5000);
      return 'stale';
    }
    LOC.resume = r;
    var m = metaFor(r) || {};
    var sc = sceneById(m.sceneId || S.sceneId);
    var sound = m.sound || (r.singing ? 'ai' : 'music');
    var job = localJob(sc, sound, trackById(m.trackId) ? m.trackId : S.trackId, m.quality || r.quality, m.thumb || '');
    job.createdAt = m.createdAt || r.startedAt || Date.now();
    job.engineJob = r.job;
    if (m.offset != null) job.offset = m.offset;
    // a story (or a single clip made with this release's plan): the same shots, song and start point as before
    ['duration', 'sync', 'own', 'songStart', 'songSeconds', 'shotId', 'hint', 'minutes'].forEach(function (k) { if (m[k] != null) job[k] = m[k]; });
    if (m.story || r.kind === 'story') { job.story = true; job.shots = m.shots || null; }
    if (job.story && !job.shots) job.shots = [];
    if (!isLocal()) { S.engine = 'local'; renderEngine(); updateAll(); } // this one is made on this PC either way
    var ok = await startLocalRun(job, { attach: r, resumed: true });
    return ok ? 'started' : 'busy';
  }
  function clearLocalMetaFor(engineJob) { var m = localMeta(); if (m && (!m.engineJob || m.engineJob === engineJob)) clearLocalMeta(); }
  async function discardLocal() {
    var r = LOC.resume;
    if (!r) return;
    // never stop a video another window has picked up meanwhile
    if (!(await localLockFree())) { otherWindowBusy(); toast('This video is being made in another Glow Studio window, so it was kept.', 'info', 5000); return; }
    LOC.resume = null;
    clearLocalMetaFor(r.job);
    if (!r.made && (r.state === 'queued' || r.state === 'running')) r.cancel(); else r.discard();
    renderEngine(); updateCost();
    toast('Discarded. You can make a new video any time — it’s free.', 'info', 3000);
  }

  function onMake(opts) {
    ensureAudio(); // unlock audio with this tap so finishing can record sound
    if (running()) { openProgress(); return; }
    if (RUN.starting) return;
    // "Try again" in an error panel goes to the engine that made that video, whatever is chosen now
    if (opts && opts.engine ? opts.engine === 'local' && (GUEST || (LOC.inApp && LOC.api)) : isLocal()) {
      if (LOC.gone) { toast('Glow Studio’s helper has closed — open Glow Studio again from your desktop icon. Your video waits on this PC.', 'warn', 6500); attention(el.engCard); checkLauncher(true); return; }
      onMakeLocal(opts); return;
    }
    // Something already paid for comes first: a paused job, or one a closed page left behind.
    var pj = pausedJob();
    if (!pj) {
      var s = storedJob();
      if (s && paidStarted(s) && (LOCKS || !liveElsewhere(s)) && Date.now() - (s.createdAt || 0) < MAX_JOB_AGE) pj = s;
    }
    if (pj) {
      if (!getKey()) { S.retryJob = { resume: pj }; openConnect('resume'); return; }
      if (!canRecord()) { refuseUnsupported(); return; }
      if (navigator.onLine === false) { toast('You’re offline. Connect to the internet to finish your video.', 'warn', 4500); return; }
      pj.tries = pj.tries || {};
      startRun(pj, { resumed: true }).then(function (ok) {
        if (ok && !(opts && opts.retry)) toast('First, let’s finish the video you already paid for.', 'info', 4000);
      });
      return;
    }
    if (effSound() === 'own' && !S.own) { toast('Choose your song first.', 'warn'); attention(el.soundCard); openOwnPicker(); return; }
    var rj = S.retryJob && S.retryJob.stillUrl && S.retryJob.sceneId === S.sceneId && (!S.photo || S.retryJob.photoSeq === S.photo.seq) ? S.retryJob : null;
    // a stopped story of this scene and photo: its paid shots are reused
    var rs = S.retryJob && S.retryJob.story && !S.retryJob.resume && S.retryJob.sceneId === S.sceneId && (!S.photo || S.retryJob.photoSeq === S.photo.seq) ? S.retryJob : null;
    if (rs && !S.photo && !shotsFor(sceneById(S.sceneId), S.duration).every(function (sh) { return rs.shots.some(function (x) { return x.id === sh.id && (x.stillUrl || x.videoUrl); }); })) rs = null;
    if (!S.photo && !rj && !rs) {
      toast('Add your selfie first.', 'warn');
      attention(el.photoCard);
      setTimeout(function () { try { el.pick.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 300);
      return;
    }
    if (S.photo && !S.consent) {
      toast('Tick the box: it’s you or you have permission, and they’re 18 or older.', 'warn', 4800);
      attention(el.consentRow);
      el.consentRow.classList.add('need');
      setTimeout(function () { try { el.consent.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 300);
      return;
    }
    // Refuse before anything is paid for: the AI label can only be burned in where the browser can record video.
    if (!canRecord()) { refuseUnsupported(); return; }
    if (!getKey()) { openConnect('make'); return; }
    if (navigator.onLine === false) { toast('You’re offline. Connect to the internet to make a video.', 'warn', 4500); return; }
    var job = newJob();
    if (rs && job.story) {
      var sameTier = (rs.sound === 'ai') === (job.sound === 'ai');
      job.shots.forEach(function (x) {
        var o = rs.shots.filter(function (y) { return y.id === x.id; })[0];
        if (!o) return;
        if (o.stillUrl) x.stillUrl = o.stillUrl;
        if (o.videoUrl && sameTier) x.videoUrl = o.videoUrl;
      });
      if (rs.ref) job.ref = rs.ref;
      if (!job.thumb) job.thumb = rs.thumb;
      job.photoSeq = rs.photoSeq;
      job.stillUrl = (job.shots.filter(function (x) { return x.stillUrl; })[0] || {}).stillUrl || null;
    }
    // After a failure or a cancel, trying again reuses the scene photo that was already made (and paid for).
    else if (rj && !job.story) {
      job.stillUrl = rj.stillUrl; job.stage = 'video';
      if (!job.thumb) job.thumb = rj.thumb;
      job.photoSeq = rj.photoSeq;
      if (rj.ref) job.ref = rj.ref;
    }
    startRun(job, {});
  }

  var resumeWaitingForKey = false;
  function resumeIfAny(opts) {
    var job = storedJob();
    if (!job || running() || RUN.starting) return;
    if (Date.now() - (job.createdAt || 0) > MAX_JOB_AGE) { clearJob(); return; }
    // With Web Locks, startRun() finds out for sure whether another page runs it; the claim's age is only a fallback.
    if (!LOCKS && liveElsewhere(job)) { watchOtherTab(); return; }
    if (!paidStarted(job)) { if (!LOCKS) clearJob(); return; } // nothing was sent to the paid models yet
    // A paused job (it stopped on an error) waits for the user, unless this page was just loaded.
    if (job.paused && opts && opts.fromWatch) { S.retryJob = { resume: job }; updateCost(); loadHistory(); return; }
    job.tries = job.tries || {};
    if (!getKey()) {
      resumeWaitingForKey = true;
      S.retryJob = { resume: job }; updateCost();
      toast('Connect fal.ai again to finish the video you started.', 'warn', 6000);
      return;
    }
    startRun(job, { resumed: true });
  }
  // Another page runs the job: wait until it is done (or closed), then show the result here / take over.
  var otherTabTimer = 0, watching = false;
  function watchOtherTab() {
    if (watching) return;
    watching = true;
    toast('Your video is being made in another Glow Studio tab.', 'info', 5000);
    if (LOCKS) {
      var p = null;
      try { p = navigator.locks.request('glow-ai-job', function () { watching = false; setTimeout(afterOtherTab, 0); }); } catch (e) { p = null; }
      if (p && p.catch) p.catch(function () { watching = false; });
      if (p) return;
    }
    clearInterval(otherTabTimer);
    otherTabTimer = setInterval(function () {
      var j = storedJob();
      if (!j || j.paused || !liveElsewhere(j)) { clearInterval(otherTabTimer); watching = false; afterOtherTab(); }
    }, 4000);
  }
  function afterOtherTab() {
    if (running()) return;
    var j = storedJob();
    if (!j) { loadHistory(); return; }
    resumeIfAny({ fromWatch: true });
  }
  window.addEventListener('storage', function (e) {
    if (e.key === LS.job) {
      if (RUN.job) {
        // Another page claimed (or finished) the job this page was running: stop here, without cancelling at fal.
        var n = null;
        try { n = e.newValue ? JSON.parse(e.newValue) : null; } catch (x) { n = null; }
        if (n ? (n.id !== RUN.job.id || (!!n.owner && n.owner !== INST)) : RUN.persisted) standDown(RUN.job);
      } else if (!e.newValue) {
        // another page finished (or discarded) the job: nothing is left here to pick up
        if (pausedJob()) { S.retryJob = null; updateCost(); }
        loadHistory();
      }
    }
    if (e.key === LS.key) updateKeyUI();
  });

  /* ------------------------------------------------------------------ *
   * Result
   * ------------------------------------------------------------------ */
  var resUrl = null, resItem = null;
  function extOf(type) { return /mp4/i.test(type || '') ? 'mp4' : /webm/i.test(type || '') ? 'webm' : /quicktime|mov/i.test(type || '') ? 'mov' : 'mp4'; }
  function fileName(item) { return 'glow-ai-' + item.sceneId + '.' + extOf(item.type); }
  function isLabelled(item) { return !!(item && item.labelled && item.blob instanceof Blob); }
  // Only labelled files are ever shown for download. Items saved by an older version without the burned-in label
  // (or only as a link to fal's file) are finished now instead: download, label, save — no extra cost.
  function finishLegacy(item) {
    if (running() || RUN.starting) { toast('Please wait until the current video is done.', 'warn', 3500); return; }
    var other = storedJob();
    if (pausedJob() || (other && paidStarted(other) && other.id !== item.id)) { toast('First finish the video you already started — tap “Finish my video”.', 'warn', 4500); return; }
    if (!canRecord()) { refuseUnsupported(); return; }
    if (!item.rawUrl && !(item.blob instanceof Blob)) { toast('This older video can’t be finished any more — you can delete it.', 'warn', 5000); return; }
    var sc = sceneById(item.sceneId);
    var job = {
      v: 1, id: item.id, createdAt: Date.now(), sceneId: sc.id, sound: item.sound === 'ai' ? 'ai' : 'music',
      trackId: trackById(item.trackId) ? item.trackId : (trackById(sc.defaultTrack) ? sc.defaultTrack : S.trackId),
      duration: item.duration || sc.length || 5, stage: 'finish', thumb: '', photoSeq: 0,
      still: null, stillUrl: item.stillUrl || null, video: null, videoUrl: item.rawUrl || null, tries: {}
    };
    if (item.blob instanceof Blob) job.localBlob = item.blob;
    toast('Adding the AI label to this video — no extra cost.', 'info', 3500);
    startRun(job, {});
  }
  function showResult(item, opts) {
    if (!isLabelled(item)) { finishLegacy(item); return; }
    resItem = item;
    if (resUrl) { try { URL.revokeObjectURL(resUrl); } catch (e) { /* ignore */ } resUrl = null; }
    var src = resUrl = URL.createObjectURL(item.blob);
    var w = item.width || 9, h = item.height || 16;
    el.res.querySelector('.res-video').style.setProperty('--resar', (w / h).toFixed(5));
    el.resVideo.src = src;
    el.labelOv.hidden = true;
    el.dl.href = src;
    el.dl.setAttribute('download', fileName(item));
    var bits = [item.sceneName || sceneById(item.sceneId).name, fmt(item.duration)];
    if (item.width && item.height) bits.push(item.width + '×' + item.height);
    if (item.size) bits.push(fmtBytes(item.size));
    bits.push(extOf(item.type).toUpperCase());
    if (item.story && item.shots > 1) bits.push(item.shots + ' shots');
    bits.push(item.sound === 'ai' ? (item.engine === 'local' ? 'AI song' : 'AI sound') : item.sound === 'own' ? 'Your song' : ((trackById(item.trackId) || {}).name || 'Music'));
    if (item.sync === 'lips') bits.push('Lip-sync');
    if (item.engine === 'local') bits.push(item.host ? 'Made on ' + item.host + '’s PC' : 'Made on this PC');
    el.resMeta.textContent = bits.join(' · ');
    el.resNote.hidden = true; el.resNote.textContent = '';
    var fresh = !!(opts && opts.fresh);
    el.resTt.textContent = fresh ? 'Your AI video is ready' : (item.sceneName || 'Your AI video');
    el.again.hidden = !fresh || !S.photo; el.other.hidden = !fresh; el.del.hidden = fresh;
    if (el.againT) el.againT.textContent = isLocal() ? 'Make again · free' : 'Make again · ' + money(falCost(sceneById(item.sceneId), item.sound === 'own' ? 'music' : item.sound, lengthsFor(sceneById(item.sceneId)).indexOf(Math.round(item.duration / 5) * 5) >= 0 ? Math.round(item.duration / 5) * 5 : (item.duration || 5)));
    el.del.textContent = 'Delete from this device'; el.del.dataset.armed = '';
    var file = null;
    try { file = item.blob ? new File([item.blob], fileName(item), { type: item.blob.type || item.type }) : null; } catch (e) { file = null; }
    var canShare = false;
    try { canShare = !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) { canShare = false; }
    el.share.hidden = !canShare;
    if (GUEST) {
      var gs = GG.session, ended = !gs || gs.state === 'closing' || UI.guestSharing === 'closing';
      if (ended) { el.again.hidden = true; el.other.hidden = true; }
      // a new link from the host is a new address, and this browser keeps "My AI videos" per address
      var hn = item.host || GG.hostName();
      el.resNote.textContent = (ended ? hn + ' has stopped sharing — download your video to keep it. It’s in My AI videos on this device for now, but a new link from ' + hn + ' opens an empty list.'
        : 'It’s saved in My AI videos on this device. Download it to keep it — a new link from ' + hn + ' opens an empty list.') +
        (!canShare && !GG.secure && /iPhone|iPad|iPod/.test(navigator.userAgent || '') ? ' On iPhone, Download saves it to Files; for “Save to Photos”, ask for the internet link.' : '');
      el.resNote.hidden = false;
    }
    el.share.onclick = function () {
      navigator.share({ files: [file], title: 'My AI video', text: 'Made with Glow Studio AI Scenes' }).catch(function (e) {
        if (e && e.name !== 'AbortError') toast('Sharing didn’t work — try Download instead.', 'warn');
      });
    };
    el.res.classList.toggle('one-row', el.share.hidden);
    window.GlowAI.lastResult = { id: item.id, size: item.size, type: item.type, name: fileName(item), width: item.width, height: item.height, duration: item.duration, labelled: item.labelled, blob: item.blob };
    openSheet(el.res, el.dl);
    syncMonitor(); // a video still finishing in the background stays silent while this one plays
    var pr = el.resVideo.play && el.resVideo.play();
    if (pr && pr.catch) pr.catch(function () { /* autoplay blocked or unsupported codec */ });
  }
  function closeResult() {
    try { el.resVideo.pause(); } catch (e) { /* ignore */ }
    closeSheet(el.res);
    syncMonitor();
  }

  /* ------------------------------------------------------------------ *
   * History (IndexedDB, with an in-memory fallback)
   * ------------------------------------------------------------------ */
  var H = { list: [], mem: false, urls: [] };
  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
      var r;
      try { r = window.indexedDB.open('glow-ai', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('indexedDB error')); };
      r.onblocked = function () { rej(new Error('indexedDB blocked')); };
    });
    dbP.catch(function () { H.mem = true; });
    return dbP;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx, out;
        try { tx = d.transaction('videos', mode); } catch (e) { rej(e); return; }
        var st = tx.objectStore('videos');
        var req = fn(st);
        if (req) req.onsuccess = function () { out = req.result; };
        tx.oncomplete = function () { res(out); };
        tx.onerror = function () { rej(tx.error || new Error('tx error')); };
        tx.onabort = function () { rej(tx.error || new Error('tx aborted')); };
      });
    });
  }
  async function loadHistory() {
    try {
      var all = await idb('readonly', function (st) { return st.getAll(); });
      H.list = (all || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
      H.mem = false;
    } catch (e) {
      H.mem = true;
    }
    renderHistory();
  }
  async function historyAdd(item) {
    H.list = H.list.filter(function (x) { return x.id !== item.id; });
    H.list.unshift(item);
    try { await idb('readwrite', function (st) { return st.put(item); }); }
    catch (e) {
      console.warn('[glow-ai] history not saved', e);
      if (!H.mem) toast('Couldn’t save to My AI videos on this device — download your video to keep it.', 'warn', 6000);
      H.mem = true;
    }
    renderHistory();
  }
  // A video another window may have saved for this engine job (read from the database, not this page's list).
  async function findLocalItem(engineJob) {
    var all = null;
    try { all = await idb('readonly', function (st) { return st.getAll(); }); } catch (e) { all = H.list; }
    return (all || []).filter(function (x) { return x && x.engine === 'local' && x.localJob === engineJob && isLabelled(x); })[0] || null;
  }
  async function historyDel(id) {
    H.list = H.list.filter(function (x) { return x.id !== id; });
    try { await idb('readwrite', function (st) { return st.delete(id); }); } catch (e) { /* in-memory only */ }
    renderHistory();
  }
  function dayLabel(ts) {
    var d = new Date(ts), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today ' + time;
    if (d.toDateString() === y.toDateString()) return 'Yesterday ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function renderHistory() {
    H.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    H.urls = [];
    el.hist.textContent = '';
    var n = H.list.length;
    el.histCount.textContent = n ? n + ' saved' + (H.mem ? ' (this visit only)' : '') : '';
    if (el.myVids) { el.myVids.hidden = !n; el.myVidsN.textContent = String(n); }
    el.histEmpty.hidden = n > 0;
    el.histEmpty.textContent = H.mem ? 'This browser isn’t saving history right now (private mode?). Download your videos to keep them.' : 'Your finished videos are saved here, on this device.';
    H.list.forEach(function (item) {
      var li = document.createElement('li'); li.className = 'ai-h'; li.dataset.id = item.id;
      var play = document.createElement('button'); play.type = 'button'; play.className = 'ai-h-play';
      var sc = sceneById(item.sceneId);
      play.setAttribute('aria-label', 'Play ' + (item.sceneName || sc.name) + ', ' + dayLabel(item.createdAt));
      var src = null;
      if (item.thumb instanceof Blob) { src = URL.createObjectURL(item.thumb); H.urls.push(src); } else if (item.thumbUrl) src = item.thumbUrl;
      if (src) {
        var img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
        img.onerror = function () { var c2 = document.createElement('canvas'); c2.width = 180; c2.height = 320; paintScene(c2, item.sceneId); if (img.parentNode) img.parentNode.replaceChild(c2, img); };
        img.src = src; play.appendChild(img);
      }
      else { var cv = document.createElement('canvas'); cv.width = 180; cv.height = 320; paintScene(cv, item.sceneId); play.appendChild(cv); }
      var dur = document.createElement('span'); dur.className = 'ai-h-dur'; dur.textContent = fmt(item.duration); play.appendChild(dur);
      var ic = document.createElement('span'); ic.className = 'ai-h-ico'; ic.setAttribute('aria-hidden', 'true'); ic.innerHTML = ICON_PLAY; play.appendChild(ic);
      var done = isLabelled(item);
      if (!done) { var nb = document.createElement('span'); nb.className = 'ai-h-snd ai-h-fin'; nb.textContent = 'Needs label'; play.appendChild(nb); play.setAttribute('aria-label', 'Add the AI label to ' + (item.sceneName || sc.name) + ', ' + dayLabel(item.createdAt) + ' (no extra cost)'); }
      else if (item.sound === 'ai') { var sb = document.createElement('span'); sb.className = 'ai-h-snd'; sb.textContent = item.engine === 'local' ? 'AI song' : 'AI sound'; play.appendChild(sb); }
      play.addEventListener('click', function () { showResult(item, { fresh: false }); });
      li.appendChild(play);
      var meta = document.createElement('div'); meta.className = 'ai-h-meta';
      var nm = document.createElement('b'); nm.textContent = item.sceneName || sc.name; meta.appendChild(nm);
      var dt = document.createElement('small'); dt.textContent = dayLabel(item.createdAt) + (item.engine === 'local' ? (item.host ? ' · ' + item.host + '’s PC' : ' · this PC') : ''); meta.appendChild(dt);
      li.appendChild(meta);
      var acts = document.createElement('div'); acts.className = 'ai-h-acts';
      var dl;
      if (done) {
        dl = document.createElement('a'); dl.className = 'ai-h-btn'; dl.setAttribute('aria-label', 'Download ' + (item.sceneName || sc.name));
        dl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/></svg>';
        dl.href = '#'; dl.addEventListener('click', function (e) { e.preventDefault(); downloadItem(item); });
      } else {
        dl = document.createElement('button'); dl.type = 'button'; dl.className = 'ai-h-btn'; dl.setAttribute('aria-label', 'Add the AI label to ' + (item.sceneName || sc.name) + ' (no extra cost)');
        dl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.9 5.2 5.2 1.9-5.2 1.9-1.9 5.2-1.9-5.2-5.2-1.9 5.2-1.9z"/></svg>';
        dl.addEventListener('click', function () { finishLegacy(item); });
      }
      var del = document.createElement('button'); del.type = 'button'; del.className = 'ai-h-btn ai-h-del'; del.setAttribute('aria-label', 'Delete ' + (item.sceneName || sc.name));
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/></svg>';
      del.addEventListener('click', function () {
        if (del.dataset.armed) { historyDel(item.id); toast('Deleted', 'ok', 1800); return; }
        del.dataset.armed = '1'; del.classList.add('armed'); del.setAttribute('aria-label', 'Tap again to delete');
        setTimeout(function () { del.dataset.armed = ''; del.classList.remove('armed'); del.setAttribute('aria-label', 'Delete ' + (item.sceneName || sc.name)); }, 3000);
      });
      acts.appendChild(dl); acts.appendChild(del);
      li.appendChild(acts);
      el.hist.appendChild(li);
    });
    updateCardPreviews(); // a scene the user made a video in shows it on its card
  }
  function downloadItem(item) {
    if (!isLabelled(item)) return;
    var u = URL.createObjectURL(item.blob);
    var a = document.createElement('a'); a.href = u; a.download = fileName(item);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
    toast('Saving your video…', 'ok', 2000);
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  el.pick.addEventListener('click', openPicker);
  el.change.addEventListener('click', openPicker);
  el.selfie.addEventListener('click', openPicker);
  el.file.addEventListener('change', function () { var f = el.file.files; if (f && f.length) setPhotoFile(f[0]); });
  el.consent.addEventListener('change', function () {
    S.consent = !!el.consent.checked;
    el.consentRow.classList.toggle('on', S.consent);
    el.consentRow.classList.remove('need');
    if (S.consent && el.photoStatus.textContent.indexOf('Photo ready') === 0) el.photoStatus.textContent = '';
    if (!S.consent && SEE.running) seePause();
    renderSee();
    // the next step is the button: make sure it is on screen
    if (S.consent) { try { el.make.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'nearest' }); } catch (e) { /* ignore */ } }
  });
  el.make.addEventListener('click', function () { onMake(); });
  Array.prototype.forEach.call(el.sound.querySelectorAll('.ai-snd'), function (b, i, all) {
    b.addEventListener('click', function () { setSound(b.getAttribute('data-sound'), true); });
    b.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      e.preventDefault();
      // the next option that can be chosen for this scene (a locked one is skipped)
      var dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      for (var k = 1; k < all.length; k++) {
        var nb = all[(i + dir * k + all.length * 2) % all.length];
        if (nb.classList.contains('locked')) continue;
        var kind = nb.getAttribute('data-sound');
        if (kind === 'own' && !S.own) { S.sound = 'own'; S.userSound = 'own'; savePrefs(); updateAll(); }
        else setSound(kind, true);
        nb.focus();
        return;
      }
    });
  });
  // My song
  if (el.ownEmpty) el.ownEmpty.addEventListener('click', openOwnPicker);
  if (el.ownChange) el.ownChange.addEventListener('click', openOwnPicker);
  if (el.ownFile) el.ownFile.addEventListener('change', function () { var f = el.ownFile.files; if (f && f.length) loadOwnFile(f[0]); });
  if (el.ownPlay) el.ownPlay.addEventListener('click', function () { if (OWN.src) stopOwnPreview(); else playOwnPart(); });
  if (el.ownRemove) el.ownRemove.addEventListener('click', function () {
    if (!el.ownRemove.dataset.armed) {
      el.ownRemove.dataset.armed = '1'; el.ownRemove.textContent = 'Tap again to remove';
      setTimeout(function () { el.ownRemove.dataset.armed = ''; el.ownRemove.textContent = 'Remove'; }, 3500);
      return;
    }
    el.ownRemove.dataset.armed = ''; el.ownRemove.textContent = 'Remove';
    removeOwn();
  });
  if (el.wave) {
    // drag the bright part (or tap where it should start); it snaps to the nearest downbeat when let go
    el.wave.addEventListener('pointerdown', function (e) {
      if (!S.own) return;
      e.preventDefault();
      try { el.wave.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      var t = waveTime(e), len = Math.min(S.duration, S.own.duration), inside = t >= S.own.start && t <= S.own.start + len;
      OWN.drag = { off: inside ? t - S.own.start : len / 2, id: e.pointerId };
      setOwnStart(t - OWN.drag.off, false);
      el.wave.classList.add('dragging');
    });
    el.wave.addEventListener('pointermove', function (e) { if (OWN.drag && S.own) setOwnStart(waveTime(e) - OWN.drag.off, false); });
    var dragEnd = function () { if (!OWN.drag) return; OWN.drag = null; el.wave.classList.remove('dragging'); setOwnStart(S.own ? S.own.start : 0, true); saveOwnStart(); updateAll(); };
    el.wave.addEventListener('pointerup', dragEnd);
    el.wave.addEventListener('pointercancel', dragEnd);
    el.wave.addEventListener('keydown', function (e) {
      var own = S.own; if (!own) return;
      // a bar at a time (the start stays on a downbeat), 4 bars with Page Up/Down
      var t, snap = false;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = stepOwnStart(1, 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = stepOwnStart(-1, 1);
      else if (e.key === 'PageUp') t = stepOwnStart(1, 4);
      else if (e.key === 'PageDown') t = stepOwnStart(-1, 4);
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') { t = own.duration; snap = true; }
      else return;
      e.preventDefault();
      setOwnStart(t, snap);
      saveOwnStart(); updateAll();
    });
  }
  window.addEventListener('resize', function () { drawWave(); });
  if (window.matchMedia) { var nq = window.matchMedia('(max-width: 480px)'); var onNq = function () { updateCost(); }; if (nq.addEventListener) nq.addEventListener('change', onNq); else if (nq.addListener) nq.addListener(onNq); }
  // Sync to the song
  if (el.syncSeg) Array.prototype.forEach.call(el.syncSeg.querySelectorAll('.opt'), function (b) {
    b.addEventListener('click', function () {
      if (b.getAttribute('aria-disabled') === 'true') { toast(ownShortText(), 'warn', 5500); return; }
      S.sync = b.getAttribute('data-sync') === 'lips' ? 'lips' : 'beat'; savePrefs(); updateAll();
    });
  });
  // Preview sheet
  if (el.pvSheet) {
    el.pvsClose.addEventListener('click', closeScenePreview);
    el.pvsBack.addEventListener('click', closeScenePreview);
    el.pvSheet.addEventListener('click', function (e) { if (e.target === el.pvSheet) closeScenePreview(); });
    el.pvsMute.addEventListener('click', function () { PV.muted = !PV.muted; syncPvMute(); });
    el.pvsUse.addEventListener('click', function () {
      var id = PV.id;
      closeScenePreview();
      if (id) { selectScene(id, { user: true }); var c = sceneBtns[id]; if (c) { try { c.btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
    });
  }
  // See yourself in every scene
  if (el.seeGo) el.seeGo.addEventListener('click', seeStart);
  if (el.seeStop) el.seeStop.addEventListener('click', function () { seePause('Previews paused — tap “Resume previews” to go on.'); });
  if (el.seeClear) el.seeClear.addEventListener('click', function () { SEE.queue = []; SEE.resumeAfter = false; seeSave(); renderSee(); });
  if (el.seeTopGo) el.seeTopGo.addEventListener('click', seeStart);
  if (el.seeTopMore) el.seeTopMore.addEventListener('click', function () { attention(el.see); try { el.see.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ } });
  if (el.seeRemove) el.seeRemove.addEventListener('click', function () {
    if (!el.seeRemove.dataset.armed) {
      el.seeRemove.dataset.armed = '1'; el.seeRemove.textContent = 'Tap again to remove them';
      setTimeout(function () { el.seeRemove.dataset.armed = ''; el.seeRemove.textContent = 'Remove my previews'; }, 3500);
      return;
    }
    el.seeRemove.dataset.armed = ''; el.seeRemove.textContent = 'Remove my previews';
    removePreviews();
  });
  if (el.pvsDel) el.pvsDel.addEventListener('click', function () { var id = PV.id; closeScenePreview(); if (id) removePreviews(id); });
  // AI engine: free on this PC | fal.ai cloud (a radio group: arrows move the choice)
  if (el.engSeg) Array.prototype.forEach.call(el.engSeg.querySelectorAll('.ai-eng-opt'), function (b, i, all) {
    b.addEventListener('click', function () { chooseEngine(b.getAttribute('data-engine'), true); });
    b.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      e.preventDefault();
      var nb = all[(i + 1) % all.length];
      chooseEngine(nb.getAttribute('data-engine'), true);
      nb.focus();
    });
  });
  if (el.engNote) el.engNote.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-engine-go], [data-act]') : null;
    if (!t) return;
    if (t.hasAttribute('data-engine-go')) chooseEngine(t.getAttribute('data-engine-go'), true);
    else if (t.getAttribute('data-act') === 'recheck') { t.disabled = true; refreshLocal(); }
    else if (t.getAttribute('data-act') === 'resume-install') resumeInstall(t);
  });
  // "Resume download" / "Try again" for a paused or stopped setup: continue exactly that job (its packs; the folder
  // only when it changed), as the setup page does.
  function resumeInstall(btn) {
    var s = LOC.s, j = (s && s.job) || {};
    if (!s) return;
    var packs = Array.isArray(j.packs) && j.packs.length ? j.packs : ['core'];
    var dir = j.installDir && j.installDir !== s.installDir ? j.installDir : undefined;
    btn.disabled = true;
    LOC.api.install(packs, dir, j.repair ? { repair: true } : undefined).then(function () {
      toast('The download continues — you can follow it here or on the setup page.', 'ok', 4000);
    }, function (e) {
      toast(setupText((e && e.message) || 'The download couldn’t start. Open the setup page to try again.'), 'warn', 8000);
    }).then(function () { el.engNote.dataset.h = ''; return refreshLocal(); });
  }
  if (el.engContinue) el.engContinue.addEventListener('click', continueLocal);
  if (el.engDiscard) el.engDiscard.addEventListener('click', function () {
    if (!el.engDiscard.dataset.armed) {
      el.engDiscard.dataset.armed = '1'; el.engDiscard.textContent = 'Tap again to discard';
      setTimeout(function () { el.engDiscard.dataset.armed = ''; el.engDiscard.textContent = 'Discard'; }, 3500);
      return;
    }
    el.engDiscard.dataset.armed = ''; el.engDiscard.textContent = 'Discard';
    discardLocal();
  });
  if (el.qual) Array.prototype.forEach.call(el.qual.querySelectorAll('.opt'), function (b) {
    b.addEventListener('click', function () { S.quality = b.getAttribute('data-quality') === 'fast' ? 'fast' : 'best'; savePrefs(); updateAll(); });
  });
  // Coming back to the window (e.g. after updating the driver, finishing the setup, or a video made in another window):
  // ask again, and look again for a video to continue.
  window.addEventListener('focus', function () { refreshLocal().then(checkLocalResume); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) refreshLocal().then(checkLocalResume); });
  // Another window started, finished or dropped a free video (GlowLocalAI's record or this page's notes changed).
  var localStorageTimer = 0;
  window.addEventListener('storage', function (e) {
    if (e.key !== 'glow.localai.job' && e.key !== LS.localJob && e.key !== null) return;
    if (!LOC.inApp || !LOC.api || running()) return;
    clearTimeout(localStorageTimer);
    localStorageTimer = setTimeout(function () { if (!running()) { checkLocalResume(); if (!e.newValue) loadHistory(); } }, 400);
  });
  el.keyChip.addEventListener('click', function () { openConnect(); });
  el.footKey.addEventListener('click', function () { openConnect(); });
  el.connClose.addEventListener('click', function () { connectThen = null; closeSheet(el.conn); });
  el.conn.addEventListener('click', function (e) { if (e.target === el.conn) { connectThen = null; closeSheet(el.conn); } });
  el.keySave.addEventListener('click', saveKey);
  el.key.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } });
  el.key.addEventListener('input', function () { if (el.keyMsg.classList.contains('err')) setKeyMsg('', ''); });
  el.keyRemove.addEventListener('click', removeKey);
  el.keyEye.addEventListener('click', function () {
    var show = el.key.type === 'password';
    el.key.type = show ? 'text' : 'password';
    el.keyEye.setAttribute('aria-pressed', show ? 'true' : 'false');
    el.keyEye.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
  });
  el.min.addEventListener('click', minimize);
  if (el.shareAskB) el.shareAskB.addEventListener('click', showShareAsk);
  el.prog.addEventListener('click', function (e) { if (e.target === el.prog) minimize(); });
  el.pill.addEventListener('click', function () {
    ensureAudio();
    if (mode() !== 'ai') setMode('ai');
    if (readyItem) { var it = readyItem; readyItem = null; setPill(null); showResult(it, { fresh: true }); return; }
    var tap = UI.tapWaiter;
    openProgress();
    if (tap) tap(); // this tap unlocks the sound, so finishing can go on at once
  });
  el.cancel.addEventListener('click', function () {
    if (UI.state !== 'running') { closeProgressSheet(); return; }
    // Free AI: after half a minute of work, stopping takes a second tap (minutes of graphics-card work would be lost)
    var job = RUN.job, secs = job ? (Date.now() - (UI.startAt || Date.now())) / 1000 : 0;
    if (job && job.engine === 'local' && secs > 30 && !el.cancel.dataset.armed) {
      var mins = Math.max(1, Math.round(secs / 60));
      el.cancel.dataset.armed = '1';
      el.cancel.textContent = 'Tap again to stop — ' + (mins === 1 ? 'about a minute' : 'about ' + mins + ' minutes') + ' of work is lost';
      clearTimeout(UI.cancelTimer);
      UI.cancelTimer = setTimeout(function () { el.cancel.dataset.armed = ''; if (UI.state === 'running') el.cancel.textContent = 'Cancel'; }, 4500);
      return;
    }
    el.cancel.dataset.armed = ''; clearTimeout(UI.cancelTimer);
    cancelJob();
  });
  el.mon.addEventListener('click', function () {
    UI.monitorOn = !UI.monitorOn;
    el.mon.setAttribute('aria-pressed', UI.monitorOn ? 'true' : 'false');
    el.mon.setAttribute('aria-label', UI.monitorOn ? 'Mute sound while finishing' : 'Play sound while finishing');
    syncMonitor();
  });
  el.resClose.addEventListener('click', closeResult);
  el.res.addEventListener('click', function (e) { if (e.target === el.res) closeResult(); });
  el.dl.addEventListener('click', function (e) {
    if (!isLabelled(resItem)) { e.preventDefault(); return; }
    toast('Saving your video…', 'ok', 2000);
  });
  // "Make again": the same scene, sound and length as the video on screen (a new take, at the price on the button).
  el.again.addEventListener('click', function () {
    var it = resItem;
    closeResult();
    if (it) {
      var sc = sceneById(it.sceneId);
      S.sceneId = sc.id;
      if (it.sound === 'own' && S.own) S.sound = 'own';
      else if (sc.audio !== 'required') S.sound = it.sound === 'ai' ? 'ai' : 'music';
      var d5 = Math.round((it.duration || 5) / 5) * 5;
      if (lengthsFor(sc).indexOf(d5) >= 0) S.duration = d5;
      if (it.trackId && trackById(it.trackId)) S.trackId = it.trackId;
      savePrefs(); updateAll();
    }
    onMake();
  });
  el.other.addEventListener('click', function () {
    closeResult();
    attention(el.sceneCard);
    toast('Pick another scene — your photo is still here.', 'ok', 2600);
  });
  el.del.addEventListener('click', function () {
    if (!resItem) return;
    if (!el.del.dataset.armed) { el.del.dataset.armed = '1'; el.del.textContent = 'Tap again to delete'; return; }
    var id = resItem.id;
    closeResult();
    historyDel(id);
    toast('Deleted', 'ok', 1800);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (el.pvSheet && !el.pvSheet.hidden) closeScenePreview();
    else if (!el.res.hidden) closeResult();
    else if (!el.conn.hidden) { connectThen = null; closeSheet(el.conn); }
    else if (!el.prog.hidden) minimize();
  });
  document.addEventListener('glow:mode', function (e) {
    if (e.detail && e.detail.mode !== 'ai') stopTrackPreview();
    syncMonitor(); renderPill(); fitStage();
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { stopTrackPreview(); stopOwnPreview(); if (PV.gain && actx) { try { PV.gain.gain.value = 0; } catch (e) { /* ignore */ } } } else if (PV.gain) syncPvMute(); syncMonitor(); });
  // Leaving the page releases the job at once, so a reload or another tab can pick it up without waiting.
  window.addEventListener('pagehide', function () {
    if (!RUN.job) return;
    var j = storedJob();
    if (j && j.id === RUN.job.id && j.owner === INST) { j.beat = 0; lsSet(LS.job, JSON.stringify(j)); }
  });
  // Back from the back/forward cache: someone else may have picked the job up meanwhile.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted || !RUN.job) return;
    var job = RUN.job;
    if (lostOwnership(job)) standDown(job); else saveJob(job);
  });
  if (el.myVids) el.myVids.addEventListener('click', function () {
    try { el.histCard.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.histCard.scrollIntoView(); }
    var first = el.hist.querySelector('.ai-h-play');
    setTimeout(function () { if (first) { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, REDUCED ? 0 : 450);
  });
  // Desktop: the selfie column stays in view while scenes are picked, unless it is taller than the window
  // (then it scrolls normally, and the button sticks to the bottom of the window instead).
  function fitStage() {
    if (!el.stage) return;
    var wide = window.matchMedia && window.matchMedia('(min-width: 980px)').matches;
    var free = !!wide && el.stage.offsetHeight > window.innerHeight - 32;
    el.ai.classList.toggle('stage-free', free);
    // (sticky with a negative top: the column scrolls until its bottom, with "Make my video", is in the window)
    el.ai.style.setProperty('--stage-top', free ? Math.min(16, window.innerHeight - el.stage.offsetHeight - 16) + 'px' : '16px');
  }
  window.addEventListener('resize', fitStage);
  if (window.ResizeObserver && el.stage) { try { new ResizeObserver(function () { fitStage(); }).observe(el.stage); } catch (e) { /* ignore */ } }
  window.addEventListener('beforeunload', function (e) {
    if (running() && UI.stage === 'finish') { e.preventDefault(); e.returnValue = ''; }
  });

  // drag & drop (AI mode only; Photo Video handles its own)
  var dragDepth = 0;
  function dragFiles(e) { if (mode() !== 'ai') return false; var dt = e.dataTransfer; return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) { if (!dragFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragover', function (e) { if (!dragFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) { /* ignore */ } });
  document.addEventListener('dragleave', function (e) { if (!dragFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', function (e) {
    if (!dragFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    var f = e.dataTransfer.files;
    if (f && f.length) { if (looksLikeAudio(f[0]) && !looksLikeImage(f[0])) loadOwnFile(f[0]); else setPhotoFile(f[0]); }
  });
  // paste a photo (desktop)
  document.addEventListener('paste', function (e) {
    if (mode() !== 'ai' || openStack.length) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    var items = (e.clipboardData && e.clipboardData.files) || [];
    for (var i = 0; i < items.length; i++) if (looksLikeImage(items[i])) { e.preventDefault(); setPhotoFile(items[i]); return; }
  });

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  window.GlowAI = {
    lastResult: null,
    scenes: SCENES.map(function (s) { return { id: s.id, name: s.name, alt: s.alt || null, audio: s.audio, defaultTrack: s.defaultTrack, badges: s.badges.slice(), length: s.length }; }),
    endpoints: EP,
    price: PRICE,
    // Exactly what would be sent to fal for a scene (used by tests and handy for debugging).
    requests: function (sceneId, sound, dur, refUrl, stillUrl) {
      var sc = sceneById(sceneId), tier = (sc.audio === 'required' || sound === 'ai') ? 'ai' : 'std';
      if (sc.story) { // a story scene: the requests of its 5 s shot (see storyRequests for every shot)
        var k = keyShot(sc);
        return { still: { endpoint: EP.still, input: shotStillInput(k, refUrl || 'https://example.invalid/selfie.jpg') }, video: { endpoint: tier === 'ai' ? EP.ai : EP.std, input: shotVideoInput(sc, k, tier, stillUrl || 'https://example.invalid/still.jpg', '') } };
      }
      return { still: { endpoint: EP.still, input: stillInput(sc, refUrl || 'https://example.invalid/selfie.jpg') }, video: { endpoint: tier === 'ai' ? EP.ai : EP.std, input: videoInput(sc, tier, dur || sc.length, stillUrl || 'https://example.invalid/still.jpg') } };
    },
    // Exactly what would be passed to GlowLocalAI.generate() for a scene (without the photo).
    localRequest: function (sceneId, sound, quality, fastPack) { var sc = sceneById(sceneId); return localRequest(sc, sc.audio === 'required' ? 'ai' : sound, quality, !!fastPack); },
    // fal story: the scene photo + clip requests of every shot (sound 'music'/'own' = silent Kling, 'ai' = Happy Horse)
    storyRequests: function (sceneId, sound, dur, refUrl, stillUrl) {
      var sc = sceneById(sceneId), tier = sound === 'ai' ? 'ai' : 'std', hint = tier === 'ai' ? '' : beatHint(tempoOf(sound, sc.defaultTrack));
      return shotsFor(sc, dur || sc.length).map(function (sh) {
        return { id: sh.id, still: { endpoint: EP.still, input: shotStillInput(sh, refUrl || 'https://example.invalid/selfie.jpg') }, video: { endpoint: tier === 'ai' ? EP.ai : EP.std, input: shotVideoInput(sc, sh, tier, stillUrl || 'https://example.invalid/still.jpg', hint) } };
      });
    },
    // this PC: the plan and the generateStory() request the current choices would make (without the photo)
    localPlan: function () {
      var sc = sceneById(S.sceneId), plan = planFor(sc, { engine: 'local' }), job = localJob(sc, plan.sound, S.trackId, plan.quality, '', plan);
      return { local: plan.local, shots: job.shots, duration: job.duration, sync: job.sync, minutes: job.minutes, request: job.story ? storyRequest(sc, job, localPack('fast')) : null };
    },
    planTimeline: planTimeline,
    beatHint: function (bpm, energy) { return beatHint({ bpm: bpm, energy: energy }); },
    openPreview: function (id) { openScenePreview(id); },
    get state() {
      return {
        engine: S.engine, quality: S.quality, effSound: effSound(),
        local: { inApp: LOC.inApp, available: !!LOC.api, checked: LOC.checked, state: localState(), resume: LOC.resume ? LOC.resume.state : null, retry: !!LOC.retry, status: LOC.s },
        mode: mode(), sceneId: S.sceneId, sound: S.sound, trackId: S.trackId, duration: S.duration, hasPhoto: !!S.photo, consent: S.consent,
        hasKey: !!getKey(), running: running(), stage: running() ? UI.stage : null, ui: UI.state, estimate: estimate(S.sound, S.duration),
        history: H.list.length, historyPersistent: !H.mem, job: lsJSON(LS.job), inst: INST, locks: LOCKS,
        retry: S.retryJob ? (S.retryJob.resume ? 'resume' : 'still') : null, pill: el.pill.hidden ? null : UI.pill,
        monitor: UI.mon ? UI.mon.gain.value : null, capture: UI.capture || null, captureFrames: UI.captureFrames == null ? null : UI.captureFrames, localElsewhere: LOC.elsewhere,
        sync: S.sync, effSync: effSync(sceneById(S.sceneId), effSound()), storyOk: storyOk(), lengths: lengthsFor(sceneById(S.sceneId)),
        own: S.own ? (function () {
          var pb = ownPartBeat(S.own, Math.min(S.own.start, ownMaxStart()), S.duration, true) || {};
          return { id: S.own.id, name: S.own.name, duration: S.own.duration, start: S.own.start, bpm: S.own.beat ? S.own.beat.bpm : 0, firstDownbeat: S.own.beat ? S.own.beat.firstDownbeat : null,
            partBpm: pb.bpm || 0, partDownbeats: (pb.downbeats || []).slice(0, 64), partBeats: (pb.beats || []).slice(0, 128), maxStart: ownMaxStart() };
        })() : null,
        gone: LOC.gone, title: document.title, seeTop: el.seeTop ? !el.seeTop.hidden : false, seeKept: el.seeKept ? !el.seeKept.hidden : false,
        timeline: UI.timeline || null, cardDraws: CARD.draws, cardVisible: Object.keys(CARD.vis).filter(function (k) { return CARD.vis[k]; }),
        cardMedia: Object.keys(sceneBtns).filter(function (k) { return !!sceneBtns[k].vid; }), preview: el.pvSheet && !el.pvSheet.hidden ? { id: PV.id, muted: PV.muted, music: !!PV.src, video: !!PV.video } : null,
        see: { running: SEE.running, queue: SEE.queue.slice(), done: SEE.done.slice(), failed: SEE.failed.slice(), cur: SEE.cur, saved: Object.keys(SEE.saved) },
        shots: running() && RUN.job && RUN.job.shots ? RUN.job.shots.map(function (x) { return { id: x.id, still: !!(x.stillUrl || x.still), stillUrl: !!x.stillUrl, video: !!x.video, videoUrl: !!x.videoUrl, lip: !!x.lip }; }) : null
      };
    }
  };

  renderScenes();
  renderTracks();
  renderLengths();
  if (el.sceneHint) el.sceneHint.textContent = SCENES.length + ' scenes';
  (function initSelection() {
    var sc = sceneById(S.sceneId);
    S.trackId = trackById(prefs.trackId) ? prefs.trackId : (trackById(sc.defaultTrack) ? sc.defaultTrack : (tracks[0] ? tracks[0].id : ''));
    if (!S.trackId) S.sound = 'ai';
    S.duration = fitLen(sc);
    if (S.sound === 'own') { /* my song works for every scene */ }
    else if (sc.audio === 'required') S.sound = 'ai';
    else if (!prefs.sound) S.sound = sc.audio === 'recommended' ? 'ai' : 'music';
  })();
  var startHash = location.hash;
  setMode(mode());
  // "./#ai" (e.g. "Back to AI Scenes" on the setup page) opens AI Scenes at the top, not scrolled to the section
  if (startHash === '#ai' || startHash === '#photo') {
    var top0 = function () { requestAnimationFrame(function () { if (window.scrollY > 0) window.scrollTo(0, 0); }); };
    if (document.readyState === 'complete') top0(); else window.addEventListener('load', top0, { once: true });
  }
  S.engine = decideEngine();
  if (GUEST) guestBoot();
  renderPhoto();
  updateKeyUI();
  renderEngine();
  updateAll();
  loadHistory();
  loadSeePreviews();
  // my song, kept on this device: when it is the chosen sound, or a video still has to be finished with it
  (function () { var lj = localMeta(), cj = storedJob(); if (S.sound === 'own' || (lj && lj.own) || (cj && cj.own)) restoreOwn(); })();
  setTimeout(resumeIfAny, 60);
  fitStage();
  if (LOC.inApp && LOC.api) refreshLocal().then(checkLocalResume);
  // Desktop app (served from this computer): "More apps" points at the website, and a launcher that had to use
  // another port than usual says why the saved key and videos (kept per address) seem to be missing.
  (function desktopApp() {
    // The Windows launcher injects a keep-alive ping into the page it serves.
    if (!LOC.inApp) return;
    Array.prototype.forEach.call(document.querySelectorAll('a.more-apps'), function (a) { a.href = 'https://tendha2020-ai.github.io/account-shop/'; a.target = '_blank'; a.rel = 'noopener'; });
    if (location.port && location.port !== String(TEST.appPort || 47821)) {
      setTimeout(function () { toast('Glow Studio opened on a different address than usual, so your saved fal.ai key and videos may not show. Close other copies of Glow Studio and start it again.', 'warn', 9000); }, 900);
    }
  })();
  if (!MU) setTimeout(function () { if (mode() === 'ai') toast('Music didn’t load — choose AI sound, or refresh the page.', 'warn', 6000); }, 400);
  } // boot

  // scenes.json couldn't be loaded (offline, a broken file): say so in plain words in AI Scenes, keep Photo Video working.
  function bootFailed(e) {
    console.warn('[glow-ai] AI Scenes could not start', e);
    var ai = document.getElementById('ai');
    if (ai && !document.getElementById('aiBootErr')) {
      var box = document.createElement('div'); box.className = 'ai-boot-err'; box.id = 'aiBootErr'; box.setAttribute('role', 'alert');
      var b = document.createElement('b'); b.textContent = 'AI Scenes couldn’t load.';
      var p = document.createElement('p'); p.textContent = 'Check your connection and reload the page. Photo Video still works.';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn primary'; btn.textContent = 'Reload';
      btn.addEventListener('click', function () { location.reload(); });
      box.appendChild(b); box.appendChild(p); box.appendChild(btn);
      ai.insertBefore(box, ai.firstChild);
      ai.classList.add('boot-failed');
    }
    // the mode tabs normally belong to AI Scenes: keep them working for Photo Video
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.mode-tab'));
    function setMode(m) {
      m = m === 'photo' ? 'photo' : 'ai';
      if (document.body.getAttribute('data-mode') === m) return;
      document.body.setAttribute('data-mode', m);
      tabs.forEach(function (t) { var on = t.getAttribute('data-mode') === m; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; });
      try { localStorage.setItem('glow.mode', m); } catch (x) { /* ignore */ }
      document.dispatchEvent(new CustomEvent('glow:mode', { detail: { mode: m } }));
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { setMode(t.getAttribute('data-mode')); }); });
  }
  var GS0 = window.GlowScenes;
  (GS0 && GS0.ready ? GS0.ready : Promise.reject(new Error('scenes.js is missing'))).then(function (SD) {
    try { boot(SD); } catch (e) { bootFailed(e); throw e; }
  }, bootFailed);
})();
