/* Glow Studio — AI Scenes (ai.js)
 *
 * One selfie + one preset scene -> a short, realistic AI video of that same person, made with the user's own fal.ai key.
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
 * In-flight jobs are saved in localStorage so a reload resumes polling instead of paying again.
 */
(function () {
  'use strict';

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
    maxBackoffMs: TEST.maxBackoffMs || 20000
  };
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // One id per browser tab (kept across reloads) so a reload resumes its own job, while a second tab does not.
  var TAB = (function () {
    var t = null;
    try { t = window.sessionStorage.getItem('glow.ai.tab'); } catch (e) { t = null; }
    if (!t) { t = 't' + Math.random().toString(36).slice(2, 10); try { window.sessionStorage.setItem('glow.ai.tab', t); } catch (e) { /* ignore */ } }
    return t;
  })();

  var LS = { key: 'glow.ai.falKey', job: 'glow.ai.job', prefs: 'glow.ai.prefs', prices: 'glow.ai.prices', mode: 'glow.mode' };
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function lsJSON(k) { var s = lsGet(k); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }

  function fmt(sec) { sec = Math.max(0, Math.round(sec || 0)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function money(v) { return '$' + (Math.round(v * 100) / 100).toFixed(2); }

  /* ------------------------------------------------------------------ *
   * fal.ai models & pricing (from fal's model pages; refreshed from the pricing API when the key is checked)
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
  var LENGTHS = [5, 10];

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

  (function loadPrices() {
    var p = lsJSON(LS.prices);
    if (p && p.at && Date.now() - p.at < 14 * 864e5) applyPrices(p.prices, true);
  })();
  function applyPrices(list, fromCache) {
    if (!Array.isArray(list)) return;
    var map = { still: EP.still, std: EP.std, ai: EP.ai }, changed = false;
    list.forEach(function (p) {
      if (!p || typeof p.unit_price !== 'number' || !(p.unit_price > 0) || p.unit_price > 5) return;
      var unit = String(p.unit || '').toLowerCase();
      Object.keys(map).forEach(function (k) {
        if (map[k] !== p.endpoint_id) return;
        if (k === 'still' && /image/.test(unit)) { PRICE.still = p.unit_price; changed = true; }
        if (k !== 'still' && /sec/.test(unit)) { PRICE[k] = p.unit_price; changed = true; }
      });
    });
    if (changed && !fromCache) lsSet(LS.prices, JSON.stringify({ at: Date.now(), prices: list }));
  }
  function estimate(sound, dur) { return PRICE.still + (sound === 'ai' ? PRICE.ai : PRICE.std) * dur; }

  /* ------------------------------------------------------------------ *
   * Scenes (preset prompts only — there is deliberately no free-text prompt)
   * ------------------------------------------------------------------ */
  var STILL_RULES =
    ' Keep the exact same person from the reference photo: the same face and facial features, eye shape, nose, lips,' +
    ' skin tone, hairstyle, hair color, body type and apparent age, so it is clearly them and not a look-alike.' +
    ' Do not beautify, slim or restyle their face. Keep their outfit from the photo if it is visible and suits the scene;' +
    ' otherwise dress them in a tasteful, casual party outfit that fits the scene. Everyone in the image is fully and' +
    ' appropriately dressed. Photorealistic candid vertical smartphone photo (9:16), natural skin texture, realistic hands' +
    ' and proportions, natural depth of field, no text, no captions, no logos, no watermark, no borders.';
  var MOTION_RULES =
    ' Natural, realistic human motion. The main person keeps exactly the same face, hairstyle and outfit as in the first' +
    ' frame for the whole video.';
  var NEGATIVE = 'blur, distortion, low quality, warped face, face morphing, different person, identity change, extra limbs,' +
    ' extra fingers, deformed hands, flicker, text, subtitles, watermark, logo';

  var SCENES = [
    {
      id: 'party-hall', name: 'Party Hall Dance', line: 'Dance toward the camera at a glam party', badges: ['Trending'],
      audio: 'optional', defaultTrack: 'glow', length: 5,
      stillPrompt: 'Place this person in the middle of a big, elegant party hall at night, dancing toward the camera with a big joyful smile. Full-body to three-quarter shot from a phone held at chest height a few steps away, the person centered. Round tables with white cloths, glowing fairy-light trees, warm string lights across the ceiling, pastel balloons and a shiny dance floor. Other guests in nice party clothes dance and laugh all around them, slightly out of focus. Warm pink, violet and golden party lighting with a soft glow.',
      motion: 'Handheld smartphone video at an elegant party hall. The person in the center dances toward the camera with a big happy smile, moving their shoulders, hips and arms to the beat with playful, confident dance moves, hair swinging, stepping closer to the lens. Guests around them dance, laugh and clap. Fairy lights and balloons twinkle in the background. The camera moves slowly backward with a gentle handheld sway.',
      soundPrompt: 'Audio: upbeat dance-pop music filling the hall, guests cheering and laughing, the warm buzz of a big party, no dialogue.'
    },
    {
      id: 'club', name: 'Club Night', line: 'Center of a packed dance floor', badges: ['Trending'],
      audio: 'optional', defaultTrack: 'hype', length: 5,
      stillPrompt: 'Place this person in the middle of a packed dance floor in a stylish nightclub, dancing with both hands in the air and a huge smile. Three-quarter shot from a phone at head height, the person centered and sharp. A big crowd of people dancing around them, a DJ booth glowing in the background, neon lights and colorful laser beams cutting through light haze. Vivid magenta, cyan and violet club lighting with bright highlights on their face.',
      motion: 'Handheld smartphone video in a packed nightclub. The person in the center dances energetically to the beat, hands up, bouncing and turning toward the camera with a big smile, while the crowd around them jumps and cheers. Laser beams sweep through the haze and the lights pulse with the music. The camera bobs gently with the crowd and pushes in slightly.',
      soundPrompt: 'Audio: pounding upbeat club music with a heavy bass beat, the crowd cheering and whistling, no dialogue.'
    },
    {
      id: 'spanish', name: 'Canta en Español', alt: 'Singing in Spanish', line: 'Sing a fiesta song with friends', badges: ['With singing', 'New'],
      audio: 'required', defaultTrack: 'sun', length: 10,
      stillPrompt: 'Place this person in the middle of a joyful backyard fiesta at night, singing happily with a group of friends around them; one friend plays an acoustic guitar. Three-quarter shot from a phone at chest height, the person centered, mouth open mid-song, eyes bright. Warm string lights, colorful papel picado banners overhead and a long table with food and flowers. Warm golden and orange festive lighting.',
      motion: 'Handheld smartphone video at a warm backyard fiesta at night. The person in the center sings joyfully toward the camera while their friends around them sing along, clap and sway; one friend strums an acoustic guitar.',
      lyrics: [
        { from: 0, to: 5, who: 'The person in the center smiles and sings in Spanish', line: '¡Esta noche brilla, ven y canta conmigo!' },
        { from: 5, to: 10, who: 'The friends join in and everyone sings together in Spanish', line: '¡Con mis amigos, la vida es una fiesta!' }
      ],
      tail: 'Lips matched to the Spanish words, natural happy expressions. The camera slowly circles with a gentle handheld sway.',
      soundPrompt: 'Audio: a cheerful Latin acoustic song sung in Spanish by the person and their friends, acoustic guitar strumming, hand claps and happy laughter, no other music.'
    },
    {
      id: 'karaoke', name: 'Karaoke Night', line: 'Take the mic, friends cheer you on', badges: ['With singing'],
      audio: 'required', defaultTrack: 'disco', length: 10,
      stillPrompt: 'Place this person on a small karaoke stage in a cozy karaoke bar, singing into a microphone with a big smile while friends cheer right in front of them. Three-quarter shot from a phone at chest height, the person centered. A lyrics screen glowing behind them, colorful stage lights and disco-ball sparkles. Purple, pink and blue lighting.',
      motion: 'Handheld smartphone video in a fun karaoke bar. The person in the center sings into the microphone with confidence, swaying and pointing at their friends, who cheer, wave their arms and sing along.',
      lyrics: [
        { from: 0, to: 5, who: 'The person sings into the microphone', line: 'Tonight we’re shining, turn the music up!' },
        { from: 5, to: 10, who: 'Their friends cheer and sing along with them', line: 'Sing it louder, we’re the stars tonight!' }
      ],
      tail: 'Lips matched to the words. The camera moves with a gentle handheld sway.',
      soundPrompt: 'Audio: the person singing an upbeat pop melody through the karaoke speakers over a backing track with drums and synths, friends cheering and clapping.'
    },
    {
      id: 'concert', name: 'Concert Star', line: 'Perform for a huge crowd', badges: ['New'],
      audio: 'recommended', defaultTrack: 'epic', length: 5,
      stillPrompt: 'Place this person performing on a big concert stage, holding a microphone and reaching toward a huge cheering crowd with a joyful, confident expression. Three-quarter shot from the front of the stage, the person centered and lit by bright spotlights. Thousands of fans with raised hands and phone lights, a giant light rig with beams overhead, light haze. Deep blue and violet stage lighting with warm white spotlights.',
      motion: 'Smartphone video from the front of a huge concert. The person on stage performs with energy, singing into the microphone, raising one arm to the crowd and walking toward the edge of the stage, while thousands of fans jump and wave their hands and phone lights. Spotlights sweep across the stage.',
      lyrics: [
        { from: 0, to: 5, who: 'The person sings into the microphone', line: 'Hands up high, this is our night!' },
        { from: 5, to: 10, who: 'The crowd sings back as the person smiles and points at them', line: 'This is our night!' }
      ],
      tail: 'Lips matched to the words. The camera slowly pushes in.',
      soundPrompt: 'Audio: a live pop-rock performance with drums, bass and guitar, the person singing, a huge crowd roaring and singing along.'
    },
    {
      id: 'wedding', name: 'Wedding Dance', line: 'Own the reception dance floor', badges: [],
      audio: 'optional', defaultTrack: 'dream', length: 5,
      stillPrompt: 'Place this person on the dance floor of a beautiful wedding reception, dancing happily with a radiant smile. Three-quarter shot from a phone at chest height, the person centered. Guests around them clap and dance, round tables with flowers and candles, hanging string lights and soft drapery. Warm champagne, blush and golden lighting with soft bokeh.',
      motion: 'Handheld smartphone video at a wedding reception. The person in the center dances joyfully toward the camera with graceful, happy moves and one twirl, while guests around them clap, cheer and dance. String lights twinkle overhead.',
      soundPrompt: 'Audio: a joyful upbeat wedding dance song, guests clapping along and cheering, no dialogue.'
    },
    {
      id: 'birthday', name: 'Birthday Party', line: 'Cake, confetti & your crew', badges: [],
      audio: 'optional', defaultTrack: 'glow', length: 5,
      stillPrompt: 'Place this person at a fun birthday party at home, standing behind a birthday cake with lit candles and laughing, with friends around them cheering and throwing confetti. Three-quarter shot from a phone at chest height, the person centered. Colorful balloons and streamers, confetti in the air. Warm, bright party lighting.',
      motion: 'Handheld smartphone video at a birthday party. The person in the center laughs, leans in and blows out the candles on the cake, then throws their arms up as their friends cheer, clap and toss confetti.',
      soundPrompt: 'Audio: friends shouting "Make a wish!", then cheering, clapping and laughing, party poppers popping, light happy background music.'
    },
    {
      id: 'beach', name: 'Beach Party', line: 'Sunset dancing by the sea', badges: [],
      audio: 'optional', defaultTrack: 'sun', length: 5,
      stillPrompt: 'Place this person at a beach party at sunset, dancing barefoot on the sand with a carefree smile while friends dance around them. Three-quarter shot from a phone at chest height, the person centered. A golden sun low over the sea, gentle waves, a small bonfire and string lights between palm trees. Warm orange, pink and gold sunset light with a soft rim light on their hair.',
      motion: 'Handheld smartphone video at a sunset beach party. The person in the center dances happily on the sand, swaying and spinning toward the camera, while friends dance around them and waves roll in behind. Their hair moves in the sea breeze.',
      soundPrompt: 'Audio: summery upbeat tropical house music, waves on the shore, friends laughing and cheering, no dialogue.'
    },
    {
      id: 'rooftop', name: 'Rooftop Party', line: 'City lights, night vibes', badges: [],
      audio: 'optional', defaultTrack: 'neon', length: 5,
      stillPrompt: 'Place this person at a stylish rooftop party at night, dancing with a big smile with friends around them. Three-quarter shot from a phone at chest height, the person centered. A glittering city skyline behind them, warm string lights, lounge seating and plants. Deep blue night sky with warm golden lights and city bokeh.',
      motion: 'Handheld smartphone video at a rooftop party at night. The person in the center dances with smooth, happy moves and turns toward the camera, while friends dance and laugh around them and the city skyline glitters behind.',
      soundPrompt: 'Audio: smooth upbeat house music, friends laughing and chatting, a light city breeze, no dialogue.'
    },
    {
      id: 'street', name: 'Street Dance', line: 'Dance with a crew downtown', badges: [],
      audio: 'optional', defaultTrack: 'hype', length: 5,
      stillPrompt: 'Place this person in the middle of a city street at golden hour, dancing with a crew of street dancers around them, mid-move in a confident pose. Full-body shot from a phone at waist height, the person centered. Colorful murals, shop fronts and a few passers-by watching and filming. Warm golden-hour sunlight with long shadows.',
      motion: 'Handheld smartphone video on a city street. The person in the center dances a confident, energetic street-dance routine with sharp, rhythmic moves while the crew behind them dances in sync and passers-by cheer. The camera moves slightly backward, low and steady.',
      soundPrompt: 'Audio: a punchy hip-hop beat from a portable speaker, the crew cheering and clapping, city ambience, no dialogue.'
    },
    {
      id: 'festival', name: 'Festival', line: 'Colors, confetti, big crowd', badges: ['New'],
      audio: 'optional', defaultTrack: 'disco', length: 5,
      stillPrompt: 'Place this person in a big outdoor music festival crowd in the afternoon, dancing with arms up and a huge smile while colorful confetti falls. Three-quarter shot from a phone at head height, the person centered. Happy festival-goers around them, colorful flags and a big stage in the distance. Bright, warm sunlight with vivid colors.',
      motion: 'Handheld smartphone video in a sunny festival crowd. The person in the center dances and jumps with arms raised, laughing as colorful confetti rains down, while the crowd around them dances and cheers.',
      soundPrompt: 'Audio: an energetic festival dance track from the main stage, the crowd cheering, confetti cannons popping, no dialogue.'
    },
    {
      id: 'redcarpet', name: 'Red Carpet', line: 'Pose for the cameras', badges: [],
      audio: 'optional', defaultTrack: 'golden', length: 5,
      stillPrompt: 'Place this person on a red carpet at a glamorous premiere at night, posing confidently with a warm smile while photographers take pictures. Full-body to three-quarter shot, the person centered on the red carpet. Velvet ropes, a softly lit backdrop and a row of photographers with bright camera flashes. Glamorous warm lighting with flash highlights.',
      motion: 'Smartphone video at a red carpet premiere. The person in the center walks forward along the red carpet with confident style, stops, turns to pose and waves at the photographers, smiling as camera flashes pop all around.',
      soundPrompt: 'Audio: rapid camera shutter clicks, an excited crowd cheering, soft glamorous background music, no dialogue.'
    }
  ];
  function sceneById(id) { for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i]; return SCENES[0]; }

  function stillPrompt(sc) { return sc.stillPrompt + STILL_RULES; }
  // tier: 'std' (silent Kling) or 'ai' (Happy Horse with native sound). Spoken/sung lines go in double quotes with
  // timecodes, which is how Happy Horse 1.1 voices and lip-syncs them.
  function motionPrompt(sc, tier, dur) {
    var p = sc.motion;
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
  function videoInput(sc, tier, dur, stillUrl) {
    if (tier === 'ai') {
      return { image_url: stillUrl, prompt: motionPrompt(sc, 'ai', dur), duration: dur, resolution: '720p', enable_safety_checker: true };
    }
    return { start_image_url: stillUrl, prompt: motionPrompt(sc, 'std', dur), duration: String(dur), generate_audio: false, negative_prompt: NEGATIVE, enable_safety_checker: true };
  }

  /* ------------------------------------------------------------------ *
   * State & elements
   * ------------------------------------------------------------------ */
  var tracks = (MU && Array.isArray(MU.tracks)) ? MU.tracks.filter(function (t) { return t && t.id; }) : [];
  function trackById(id) { for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i]; return null; }

  var prefs = lsJSON(LS.prefs) || {};
  var S = {
    sceneId: sceneById(prefs.sceneId).id,
    sound: prefs.sound === 'ai' ? 'ai' : 'music',
    userSound: prefs.userSound || null,     // the sound mode the user picked themselves (kept across scenes)
    trackId: '', duration: 5,
    photo: null,                             // { blob, url, thumb (data URL), small (data URL), w, h, seq, uploaded: {url, at} }
    consent: false,
    memKey: ''                               // used only if localStorage is blocked
  };
  var el = {
    tabs: Array.prototype.slice.call(document.querySelectorAll('.mode-tab')),
    top: $('.top'), modes: $('.modes'), ai: $('#ai'), app: $('#app'),
    keyChip: $('#aiKeyChip'), keyChipT: $('#aiKeyChipT'), footKey: $('#aiFootKey'),
    photoCard: $('#aiPhotoCard'), drop: $('#aiDrop'), pick: $('#aiPick'), selfie: $('#aiSelfie'), selfieImg: $('#aiSelfieImg'),
    change: $('#aiChange'), file: $('#aiFile'), consentRow: $('#aiConsentRow'), consent: $('#aiConsent'), photoStatus: $('#aiPhotoStatus'),
    target: $('#aiTargetArt'), targetName: $('#aiTargetName'),
    make: $('#aiMake'), cost: $('#aiCost'),
    sceneCard: $('#aiSceneCard'), scenes: $('#aiScenes'),
    sound: $('#aiSound'), soundHint: $('#aiSoundHint'), soundLock: $('#aiSoundLock'), music: $('#aiMusic'), tracks: $('#aiTracks'),
    aiNote: $('#aiAiNote'), len: $('#aiLen'), tier: $('#aiTier'),
    hist: $('#aiHist'), histEmpty: $('#aiHistEmpty'), histCount: $('#aiHistCount'), histCard: $('#aiHistCard'),
    conn: $('#aiConnect'), connClose: $('#aiConnClose'), connRange: $('#aiConnRange'), key: $('#aiKey'), keyEye: $('#aiKeyEye'),
    keyMsg: $('#aiKeyMsg'), keySave: $('#aiKeySave'), keyRemove: $('#aiKeyRemove'),
    prog: $('#aiProgress'), progTt: $('#aiProgTt'), min: $('#aiMin'), pv: $('#aiPv'), pvSelfie: $('#aiPvSelfie'), pvStill: $('#aiPvStill'),
    pvCanvas: $('#aiPvCanvas'), pct: $('#aiPct'), ringBar: $('#aiRingBar'), mon: $('#aiMon'), steps: $('#aiSteps'),
    subStill: $('#aiSubStill'), subVideo: $('#aiSubVideo'), subFinish: $('#aiSubFinish'), finishName: $('#aiFinishName'),
    msg: $('#aiProgMsg'), elapsed: $('#aiElapsed'), eta: $('#aiEta'),
    err: $('#aiErr'), errT: $('#aiErrT'), errP: $('#aiErrP'), errActions: $('#aiErrActions'),
    tapFinish: $('#aiTapFinish'), cancel: $('#aiCancel'), keepOpen: $('#aiKeepOpen'),
    res: $('#aiResult'), resTt: $('#aiResTt'), resClose: $('#aiResClose'), resVideo: $('#aiResVideo'), labelOv: $('#aiLabelOv'),
    resMeta: $('#aiResMeta'), resNote: $('#aiResNote'), dl: $('#aiDownload'), share: $('#aiShare'), again: $('#aiAgain'),
    other: $('#aiOther'), del: $('#aiDelete'), pill: $('#aiPill'), pillT: $('#aiPillT'), toasts: $('#toasts')
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
    if (m !== 'ai') stopTrackPreview();
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
    }
  };
  function paintScene(canvas, id) {
    var x = canvas.getContext('2d');
    if (!x) return;
    var p = { x: x, W: canvas.width, H: canvas.height, R: rng(seedOf(id)) };
    x.save();
    try { (PAINT[id] || PAINT['party-hall'])(p); } catch (e) { console.warn('[glow-ai] art failed', id, e); }
    x.restore();
    vignette(p);
  }

  /* ------------------------------------------------------------------ *
   * Scene grid
   * ------------------------------------------------------------------ */
  var sceneBtns = {};
  var DPR = Math.min(2, window.devicePixelRatio || 1);
  function renderScenes() {
    el.scenes.textContent = '';
    SCENES.forEach(function (sc, i) {
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
      var txt = document.createElement('span'); txt.className = 'ai-scene-txt';
      var nm = document.createElement('b'); nm.textContent = sc.name; txt.appendChild(nm);
      if (sc.alt) { var al = document.createElement('i'); al.textContent = sc.alt; txt.appendChild(al); }
      var ln = document.createElement('small'); ln.textContent = sc.line; txt.appendChild(ln);
      art.appendChild(txt);
      var ring = document.createElement('span'); ring.className = 'ai-ring'; ring.setAttribute('aria-hidden', 'true'); art.appendChild(ring);
      b.appendChild(art);
      var label = sc.name + (sc.alt ? ' (' + sc.alt + ')' : '') + '. ' + sc.line + '.' + (sc.badges && sc.badges.length ? ' ' + sc.badges.join(', ') + '.' : '') +
        (sc.audio === 'required' ? ' Uses AI sound.' : '');
      b.setAttribute('aria-label', label);
      b.addEventListener('click', function () { selectScene(sc.id, { user: true }); });
      b.addEventListener('keydown', function (e) { sceneKeys(e, i); });
      el.scenes.appendChild(b);
      sceneBtns[sc.id] = { btn: b, canvas: cv };
    });
    var paintAll = function () { SCENES.forEach(function (sc, k) { setTimeout(function () { paintScene(sceneBtns[sc.id].canvas, sc.id); sceneBtns[sc.id].btn.classList.add('ready'); }, k * 16); }); };
    if ('requestIdleCallback' in window) requestIdleCallback(paintAll, { timeout: 500 }); else setTimeout(paintAll, 60);
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
    S.duration = sc.length || 5;
    if (sc.audio === 'required') S.sound = 'ai';
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
    SCENES.forEach(function (sc) {
      var on = sc.id === S.sceneId, b = sceneBtns[sc.id].btn;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
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
    LENGTHS.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.dataset.len = d;
      var bb = document.createElement('b'); bb.textContent = d + ' s';
      var sm = document.createElement('small'); sm.className = 'ai-len-cost';
      b.appendChild(bb); b.appendChild(sm);
      b.addEventListener('click', function () { S.duration = d; savePrefs(); updateAll(); });
      el.len.appendChild(b);
    });
  }
  function setSound(s, user) {
    var sc = sceneById(S.sceneId);
    if (sc.audio === 'required' && s !== 'ai') {
      toast(sc.name + ' needs AI sound for the singing.', 'warn');
      return;
    }
    S.sound = s === 'ai' ? 'ai' : 'music';
    if (user) S.userSound = S.sound;
    if (S.sound === 'ai') stopTrackPreview();
    savePrefs();
    updateAll();
  }
  function updateSoundUI() {
    var sc = sceneById(S.sceneId), req = sc.audio === 'required';
    Array.prototype.forEach.call(el.sound.querySelectorAll('.ai-snd'), function (b) {
      var on = b.getAttribute('data-sound') === S.sound;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('locked', req && b.getAttribute('data-sound') === 'music');
      if (b.getAttribute('data-sound') === 'music') b.setAttribute('aria-disabled', req ? 'true' : 'false');
    });
    el.soundLock.hidden = !req;
    if (req) el.soundLock.textContent = (sc.alt || sc.name) + ' needs AI sound so the video can really sing' + (sc.id === 'spanish' ? ' in Spanish.' : '.');
    var music = S.sound === 'music';
    el.music.hidden = !music;
    el.aiNote.hidden = music;
    if (!music) {
      var what = sc.lyrics ? 'singing' + (sc.id === 'spanish' ? ' in Spanish' : '') + ', friends and the room' : 'music, the crowd and the room';
      el.aiNote.innerHTML = '';
      var b = document.createElement('b'); b.textContent = 'Real sound, made with the video.';
      el.aiNote.appendChild(b);
      el.aiNote.appendChild(document.createTextNode(' The video model creates the ' + what + ' together with the picture' + (sc.lyrics ? ', with lips matched to the song.' : '.')));
    }
    el.soundHint.textContent = music ? 'Music is free' : (sc.audio === 'required' ? 'Required for this scene' : (sc.audio === 'recommended' ? 'Recommended' : 'Premium'));
    Object.keys(trackCards).forEach(function (id) {
      var c = trackCards[id], sel = id === S.trackId;
      c.wrap.classList.toggle('sel', sel);
      c.pick.setAttribute('aria-pressed', sel ? 'true' : 'false');
      c.best.hidden = id !== sc.defaultTrack;
    });
    Array.prototype.forEach.call(el.len.children, function (b) {
      var d = +b.dataset.len;
      b.setAttribute('aria-pressed', d === S.duration ? 'true' : 'false');
      b.querySelector('.ai-len-cost').textContent = 'about ' + money(estimate(S.sound, d));
      b.setAttribute('aria-label', d + ' seconds, about ' + money(estimate(S.sound, d)));
    });
    var tierName = S.sound === 'ai' ? 'Premium · ' + MODEL_NAME[EP.ai] + ' with native sound' : 'Standard · ' + MODEL_NAME[EP.std] + ' (silent) + your music';
    el.tier.innerHTML = '';
    var t1 = document.createElement('span'); t1.className = 'ai-tier-k'; t1.textContent = 'Video model';
    var t2 = document.createElement('span'); t2.textContent = tierName;
    var t3 = document.createElement('span'); t3.className = 'ai-tier-s'; t3.textContent = 'Scene photo by ' + MODEL_NAME[EP.still];
    el.tier.appendChild(t1); el.tier.appendChild(t2); el.tier.appendChild(t3);
  }
  function updateCost() {
    var c = estimate(S.sound, S.duration);
    el.cost.textContent = running() ? 'Making your video · tap to see progress' : 'about ' + money(c) + ', charged by fal.ai to your account';
    el.make.classList.toggle('idle', !S.photo);
    el.make.setAttribute('aria-describedby', 'aiCost');
    if (el.connRange) el.connRange.textContent = money(estimate('music', LENGTHS[0])) + '–' + money(estimate('ai', LENGTHS[LENGTHS.length - 1]));
  }
  function updateAll() { updateSceneUI(); updateSoundUI(); updateCost(); }
  function savePrefs() { lsSet(LS.prefs, JSON.stringify({ sceneId: S.sceneId, sound: S.sound, userSound: S.userSound, trackId: S.trackId, duration: S.duration })); }

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
        S.photo = { blob: blob, url: URL.createObjectURL(blob), small: small, thumb: thumb, w: d.w, h: d.h, seq: ++photoSeq, uploaded: null };
        S.consent = false; // consent is per photo
        renderPhoto();
        el.photoStatus.textContent = 'Photo ready. Please confirm the checkbox below.';
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
    openSheet(el.conn, el.key);
  }
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
    if (then === 'make') onMake();
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
  function openSheet(m, focusEl) {
    if (!openStack.length) lastFocus = document.activeElement;
    if (openStack.indexOf(m) < 0) openStack.push(m);
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    setInert(true);
    if (focusEl) setTimeout(function () { try { focusEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
  }
  function closeSheet(m) {
    if (m.hidden) return;
    m.hidden = true;
    openStack = openStack.filter(function (x) { return x !== m; });
    if (openStack.length) return;
    document.body.style.overflow = '';
    setInert(false);
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
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
  var RUN = { job: null, cancelled: false, wakers: [] };
  function nap(ms) {
    return new Promise(function (res) {
      var done = false, t = 0;
      var fin = function () { if (done) return; done = true; clearTimeout(t); RUN.wakers = RUN.wakers.filter(function (f) { return f !== fin; }); res(); };
      t = setTimeout(fin, ms);
      RUN.wakers.push(fin);
    });
  }
  function wakeAll() { RUN.wakers.slice().forEach(function (f) { f(); }); }
  window.addEventListener('online', function () { wakeAll(); if (running()) setMsg('Back online — checking on your video…'); });
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
      var r;
      try {
        r = await falFetch(QUEUE + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Fal-Store-IO': '0', 'X-Fal-Object-Lifecycle-Preference': LIFECYCLE },
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
      if (!r.ok && r.status !== 202) throw classify(r.status, r.body, r.headers);
      fails = 0;
      heartbeat(job);
      var st = r.body && r.body.status;
      if (st === 'COMPLETED') return fetchResult(job, h);
      onStatus({ status: st, position: r.body && r.body.queue_position });
      var slow = Date.now() - (h.at || Date.now()) > CFG.slowAfterMs;
      await nap(slow ? CFG.slowPollMs : CFG.pollMs);
    }
  }
  async function fetchResult(job, h) {
    var tries = 0;
    for (;;) {
      check(job);
      var r = null;
      try { r = await falFetch(h.response_url, { method: 'GET' }, true); }
      catch (e) { if (tries++ < 8) { await nap(backoff(tries)); continue; } throw e; }
      check(job);
      if (r.ok) return r.body || {};
      if (r.status === 400 && /in progress/i.test(detailText(r.body)) && tries++ < 30) { await nap(1500); continue; }
      if (r.status === 429 && tries++ < 8) { await nap(backoff(tries)); continue; }
      throw classify(r.status, r.body, r.headers);
    }
  }
  function cancelRemote(h) {
    if (!h || !h.cancel_url || !getKey()) return Promise.resolve();
    return falFetch(h.cancel_url, { method: 'PUT' }, true).catch(function () { /* best effort */ });
  }

  /* ------------------------------------------------------------------ *
   * Job persistence (resume after reload without paying again)
   * ------------------------------------------------------------------ */
  function saveJob(job) {
    if (RUN.job !== job) return; // cancelled or replaced: never bring it back
    job.beat = Date.now(); job.owner = TAB;
    var copy = {}; Object.keys(job).forEach(function (k) { if (k !== 'inlineRef') copy[k] = job[k]; });
    lsSet(LS.job, JSON.stringify(copy));
  }
  function clearJob() { lsDel(LS.job); }
  var lastBeat = 0;
  function heartbeat(job) { if (Date.now() - lastBeat > 2500) { lastBeat = Date.now(); if (RUN.job === job) saveJob(job); } }
  function running() { return !!RUN.job; }

  /* ------------------------------------------------------------------ *
   * Progress UI
   * ------------------------------------------------------------------ */
  var UI = { stage: 'still', stageAt: {}, startAt: 0, timer: 0, msgTimer: 0, msgIdx: 0, sub: {}, minimized: false, monitorOn: true, state: 'idle' };
  var EXPECT = { still: 30, video: 140, videoAi: 200, finish: 12 };
  var MSGS = {
    still: ['Finding your best angle…', 'Setting up the lights…', 'Inviting the guests…', 'Matching your look exactly…'],
    video: ['Teaching you the moves…', 'Rolling camera…', 'The crowd is warming up…', 'Real motion takes a little while — hang tight.', 'Almost showtime…'],
    finish: ['Adding the finishing touches…']
  };
  function setMsg(t) { el.msg.textContent = t; }
  function setStep(step, state, sub) {
    var li = el.steps.querySelector('[data-step="' + step + '"]');
    if (!li) return;
    if (state) li.dataset.state = state;
    if (sub != null) { var s = $('small', li); if (s) s.textContent = sub; }
  }
  function enterStage(stage, at) {
    UI.stage = stage;
    UI.stageAt[stage] = UI.stageAt[stage] || Math.min(Date.now(), at || Date.now());
    el.pv.dataset.stage = stage;
    var order = ['still', 'video', 'finish'], k = order.indexOf(stage);
    order.forEach(function (s, i) { setStep(s, i < k ? 'done' : i === k ? 'active' : 'todo'); });
    UI.msgIdx = 0; rotateMsg(true);
  }
  function rotateMsg(now) {
    clearTimeout(UI.msgTimer);
    if (UI.state !== 'running') return;
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
    el.elapsed.textContent = fmt(el2) + ' elapsed';
    var order = ['still', 'video', 'finish'], W = { still: 0.18, video: 0.7, finish: 0.12 }, k = order.indexOf(UI.stage), f = 0;
    order.forEach(function (s, i) { f += W[s] * (i < k ? 1 : i === k ? (s === 'finish' && UI.finishFrac != null ? UI.finishFrac : stageFrac(s, job)) : 0); });
    var pct = Math.floor(clamp(f, 0, 0.99) * 100);
    el.pct.textContent = pct + '%';
    el.ringBar.style.strokeDashoffset = String(100 - pct);
    var h = UI.stage === 'still' ? job.still : job.video;
    var slow = h && h.at && Date.now() - h.at > CFG.slowAfterMs;
    if (UI.stage === 'finish') el.eta.textContent = '';
    else if (slow) el.eta.textContent = ' · taking longer than usual';
    else el.eta.textContent = UI.stage === 'still' ? ' · usually under a minute' : (job.sound === 'ai' ? ' · usually 2–5 min' : ' · usually 1–3 min');
    if (slow && !UI.slowSaid) { UI.slowSaid = true; holdMsg('Still working — fal.ai is busier than usual. We’ll keep checking.', 20000); }
    el.pillT.textContent = (UI.stage === 'finish' ? 'Finishing your video' : 'Making your video') + ' · ' + pct + '%';
  }
  function statusSub(stage, s) {
    var t;
    if (s.retry) t = s.offline ? 'Connection lost — retrying…' : 'fal.ai is busy — retrying…';
    else if (s.status === 'IN_QUEUE') t = (s.position > 0 ? 'In line at fal.ai · ' + s.position + ' ahead' : 'Starting…');
    else if (s.status === 'IN_PROGRESS') t = 'Generating…';
    else t = '';
    setStep(stage, null, t);
    if (s.retry && s.offline) holdMsg('Connection lost — we’ll keep trying. Your video is safe at fal.ai.', 8000);
  }
  function openProgress() { UI.minimized = false; el.pill.hidden = true; openSheet(el.prog, el.min); }
  function minimize() {
    if (UI.state === 'running') { UI.minimized = true; closeSheet(el.prog); el.pill.hidden = false; toast('We’ll keep working — tap the bar at the bottom to check in.', 'info', 3000); }
    else closeProgressSheet();
  }
  function closeProgressSheet() { closeSheet(el.prog); el.pill.hidden = true; }
  function resetProgressUI(job, resumed) {
    UI.state = 'running'; UI.stageAt = {}; UI.startAt = job.createdAt || Date.now(); UI.slowSaid = false; UI.finishFrac = null; UI.hold = 0;
    el.err.hidden = true; el.errActions.textContent = '';
    el.cancel.hidden = false; el.cancel.textContent = 'Cancel'; el.tapFinish.hidden = true; el.keepOpen.hidden = false;
    el.steps.hidden = false; el.mon.hidden = true; el.elapsed.parentNode.hidden = false; el.elapsed.textContent = '0:00 elapsed';
    el.progTt.textContent = 'Making your video';
    el.finishName.textContent = job.sound === 'ai' ? 'Adding the label & finishing' : 'Adding music & finishing';
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
    var sound = sc.audio === 'required' ? 'ai' : S.sound;
    return {
      v: 1, id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now(),
      sceneId: sc.id, sound: sound, trackId: S.trackId, duration: S.duration,
      stage: 'upload', thumb: S.photo ? S.photo.thumb : '', photoSeq: S.photo ? S.photo.seq : 0,
      still: null, stillUrl: null, video: null, videoUrl: null, tries: {}
    };
  }
  function startRun(job, opts) {
    RUN.job = job; RUN.cancelled = false;
    readyItem = null; el.pill.classList.remove('ready');
    saveJob(job);
    resetProgressUI(job, opts && opts.resumed);
    if (opts && opts.background) { UI.minimized = true; el.pill.hidden = false; } else openProgress();
    updateCost();
    runJob(job).catch(function (e) { console.warn('[glow-ai] run', e); });
  }
  async function runJob(job) {
    var sc = sceneById(job.sceneId);
    try {
      // 1 — the scene still
      if (!job.stillUrl) {
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
      if (!job.videoUrl) {
        enterStage('video', job.video && job.video.at);
        var ep = job.sound === 'ai' ? EP.ai : EP.std;
        if (!job.video) {
          setStep('video', null, 'Sending to ' + MODEL_NAME[ep] + '…');
          var vh = await submit(job, ep, videoInput(sc, job.sound === 'ai' ? 'ai' : 'std', job.duration, job.stillUrl));
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
  function retryable(e) { return !!e && e.kind === 'server'; } // fal-side failures are free; anything else is final
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

  async function finishStage(job) {
    enterStage('finish');
    var sc = sceneById(job.sceneId);
    el.cancel.hidden = true;
    setStep('finish', null, 'Downloading your video…');
    var raw = null;
    for (var i = 0; i < 4 && !raw; i++) {
      try {
        var r = await fetch(job.videoUrl, { credentials: 'omit' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        raw = await r.blob();
      } catch (e) {
        check(job);
        if (i === 3) break;
        await nap(backoff(i + 1));
      }
    }
    check(job);
    if (!raw) {
      // Couldn't download the file (e.g. the host doesn't allow it). Show fal's file with the label on top.
      return completeJob(job, { raw: true, remote: job.videoUrl, note: 'We couldn’t download the video into Glow Studio, so the AI label is shown on top of the player instead of inside the file.' });
    }
    var fin = null, lastErr = null;
    for (var attempt = 0; attempt < 3 && !fin; attempt++) {
      try {
        UI.finishFrac = 0;
        setStep('finish', null, job.sound === 'ai' ? 'Adding the AI label…' : 'Mixing ' + ((trackById(job.trackId) || {}).name || 'music') + '…');
        fin = await finishVideo(job, raw, sc);
      } catch (e) {
        if (e === CANCELLED) throw e;
        lastErr = e;
        if (e && e.code === 'gesture') {
          await needTap(job);
          continue;
        }
        if (e && e.code === 'hidden') { await whenVisible(); continue; }
        break;
      }
    }
    check(job);
    if (!fin) {
      console.warn('[glow-ai] finishing failed', lastErr);
      return completeJob(job, { raw: true, blob: raw, note: 'This browser couldn’t add the AI label inside the file, so here is the original video from fal.ai. Please keep it labelled as AI when you share it.' });
    }
    return completeJob(job, fin);
  }
  function needTap(job) {
    return new Promise(function (res) {
      setStep('finish', null, 'Waiting for you…');
      holdMsg('Your video is ready to finish — tap the button to add the sound.', 60000);
      el.tapFinish.hidden = false;
      if (UI.minimized) { openProgress(); }
      el.tapFinish.onclick = function () { ensureAudio(); el.tapFinish.hidden = true; el.tapFinish.onclick = null; UI.hold = 0; res(); };
      try { el.tapFinish.focus(); } catch (e) { /* ignore */ }
      var iv = setInterval(function () { if (RUN.job !== job) { clearInterval(iv); res(); } }, 500);
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
  function canRecord() { return !!(window.MediaRecorder && window.MediaStream && typeof HTMLCanvasElement.prototype.captureStream === 'function'); }
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
    var url = URL.createObjectURL(blob);
    var v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.muted = !useAI;
    v.src = url;
    var cleanup = [];
    cleanup.push(function () { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } URL.revokeObjectURL(url); });
    function clean() { cleanup.splice(0).forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); }
    try {
      await mediaReady(v, 20000);
      check(job);
      var vw = v.videoWidth, vh = v.videoHeight, dur = v.duration;
      if (!vw || !vh) throw finErr('decode', 'No picture');
      if (!(dur > 0) || !isFinite(dur)) dur = job.duration;
      var sc2 = Math.min(1, 1920 / Math.max(vw, vh));
      var W = Math.max(2, Math.round(vw * sc2 / 2) * 2), H = Math.max(2, Math.round(vh * sc2 / 2) * 2);
      var cv = el.pvCanvas.cloneNode(false);
      el.pvCanvas.parentNode.replaceChild(cv, el.pvCanvas); el.pvCanvas = cv;
      cv.width = W; cv.height = H;
      var cx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      var draw = function () { try { cx.drawImage(v, 0, 0, W, H); } catch (e) { /* frame not ready */ } drawLabel(cx, W, H); };
      draw();
      el.pv.classList.add('has-video');

      // audio graph: source -> mix -> (recorder, optional speakers)
      var dest = ctx.createMediaStreamDestination(), mix = ctx.createGain(), mon = ctx.createGain();
      mix.gain.value = 1; mon.gain.value = UI.monitorOn ? 0.9 : 0;
      mix.connect(dest); mix.connect(mon); mon.connect(ctx.destination);
      UI.mon = mon; el.mon.hidden = false;
      cleanup.push(function () { try { mix.disconnect(); } catch (e) { /* ignore */ } try { mon.disconnect(); } catch (e) { /* ignore */ } UI.mon = null; el.mon.hidden = true; });
      var music = null, env = null;
      if (useAI) {
        var es = ctx.createMediaElementSource(v);
        es.connect(mix);
        cleanup.push(function () { try { es.disconnect(); } catch (e) { /* ignore */ } });
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

      var vStream = cv.captureStream(30);
      var stream = new MediaStream(vStream.getVideoTracks().concat(dest.stream.getAudioTracks()));
      cleanup.push(function () { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); });
      var mime = pickMime();
      var opts = { videoBitsPerSecond: Math.min(W, H) >= 1080 ? 12e6 : 8e6, audioBitsPerSecond: 192000 };
      if (mime) opts.mimeType = mime;
      var rec;
      try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

      var thumbBlob = null, t0 = 0;
      var result = await new Promise(function (resolve, reject) {
        var settled = false, raf = 0, vfc = 0, watchdog = 0, lastT = -1, lastMove = performance.now(), started = false, stopping = false;
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
          draw();
          var t = v.currentTime || 0;
          UI.finishFrac = clamp(t / dur, 0, 1);
          setStep('finish', null, Math.round(UI.finishFrac * 100) + '%');
          if (!thumbBlob && t >= Math.min(1, dur * 0.3)) {
            thumbBlob = 'pending';
            var tc = drawScaled(cv, W, H, 480);
            toBlob(tc, 'image/jpeg', 0.82).then(function (b) { thumbBlob = b; }, function () { thumbBlob = null; });
          }
          schedule();
        }
        function schedule() {
          if (v.requestVideoFrameCallback) vfc = v.requestVideoFrameCallback(frame);
          else raf = requestAnimationFrame(frame);
        }
        function finish() {
          if (settled || stopping) return;
          stopping = true;
          draw();
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
          if (music && env) {
            var now = ctx.currentTime;
            env.gain.setValueAtTime(0, now);
            env.gain.linearRampToValueAtTime(0.92, now + 0.08);
            var fadeAt = Math.max(now + 0.2, now + dur - 1.4);
            env.gain.setValueAtTime(0.92, fadeAt);
            env.gain.linearRampToValueAtTime(0, now + dur + 0.05);
            try { music.start(now); } catch (e) { /* ignore */ }
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
   * Completion, errors, cancel
   * ------------------------------------------------------------------ */
  async function completeJob(job, fin) {
    var sc = sceneById(job.sceneId);
    setStep('finish', 'done', 'Done');
    UI.finishFrac = 1; tick();
    var item = {
      id: job.id, createdAt: Date.now(), sceneId: sc.id, sceneName: sc.name, sound: job.sound, trackId: job.sound === 'music' ? job.trackId : null,
      duration: fin.duration || job.duration, width: fin.width || (job.videoMeta && job.videoMeta.w) || null, height: fin.height || (job.videoMeta && job.videoMeta.h) || null,
      type: fin.type || (fin.blob && fin.blob.type) || (job.videoMeta && job.videoMeta.type) || 'video/mp4',
      size: fin.blob ? fin.blob.size : 0, blob: fin.blob || null, thumb: fin.thumb || null,
      rawUrl: job.videoUrl, stillUrl: job.stillUrl, remote: fin.remote || null, labelled: !!fin.labelled, note: fin.note || ''
    };
    if (!item.thumb && job.stillUrl) item.thumbUrl = job.stillUrl;
    await historyAdd(item);
    clearJob();
    RUN.job = null;
    UI.state = 'done';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    var quiet = UI.minimized || mode() !== 'ai' || !el.conn.hidden || !el.res.hidden;
    closeSheet(el.prog);
    updateCost();
    UI.minimized = false;
    if (quiet) {
      readyItem = item;
      el.pill.classList.add('ready'); el.pill.hidden = false;
      el.pillT.textContent = 'Your AI video is ready · tap to watch';
      toast('Your AI video is ready!', 'ok', 4000);
    } else {
      el.pill.hidden = true;
      showResult(item, { fresh: true });
    }
  }
  var readyItem = null;
  function errorView(e, job) {
    var sc = sceneById(job && job.sceneId), kind = e && e.kind || (e && e.code) || 'server';
    var detail = e && e.detail ? String(e.detail) : (e && e.message ? String(e.message) : '');
    var paid = job && job.stillUrl ? ' Your scene photo is saved, so trying again only makes the video.' : '';
    switch (kind) {
      case 'auth': return { t: 'fal.ai didn’t accept your key', p: 'Check that you pasted the whole key (two parts joined by a colon), or create a new one on fal.ai.', a: ['key', 'keys'] };
      case 'credit': return { t: 'Your fal.ai balance needs a top-up', p: 'fal.ai says this account is out of credit or locked. Add credit on fal.ai, then try again — nothing was charged for this attempt.' + paid, a: ['billing', 'retry'] };
      case 'permission': return { t: 'This key can’t use the AI models', p: 'When you create the key on fal.ai, choose the “API” preset (or allow these models). Then paste the new key here.', a: ['keys', 'key'] };
      case 'moderation': return { t: 'This one didn’t pass fal.ai’s safety check', p: 'Their content filter stopped this photo or scene, and we respect that. Try a different photo — one person, face clearly visible, everyday clothes — or pick another scene. Blocked results aren’t charged.', a: ['photo', 'scene'] };
      case 'face': return { t: 'We couldn’t find a clear face', p: 'Use a photo where your face is clearly visible, in good light, with just you in it.', a: ['photo'] };
      case 'photo': return { t: 'fal.ai couldn’t use this photo', p: (detail ? detail + ' ' : '') + 'Try another photo, at least 300 px on each side.', a: ['photo', 'retry'] };
      case 'validation': return { t: 'fal.ai couldn’t start this one', p: (detail || 'The request was rejected.') + paid, a: ['retry', 'scene'] };
      case 'nomedia': return { t: 'The AI didn’t make anything this time', p: 'That can happen with some photos. Try again, or use a different photo or scene.' + (detail && detail.length < 200 ? ' (' + detail + ')' : ''), a: ['retry', 'photo'] };
      case 'notfound': return { t: 'This request has expired', p: 'fal.ai no longer has this result (results are kept for about an hour). Please start again.', a: ['retry'] };
      case 'network': return { t: 'Couldn’t reach fal.ai', p: 'Check your internet connection and try again.' + paid, a: ['retry'] };
      case 'upload': return { t: 'Your photo didn’t upload', p: 'Check your connection and try again.', a: ['retry'] };
      case 'nophoto': return { t: 'Add your photo again', p: 'The page was reloaded before your photo was sent. Please choose it again — nothing was charged.', a: ['photo'] };
      case 'rate': return { t: 'fal.ai is very busy', p: 'Please try again in a minute.', a: ['retry'] };
      case 'cancelled': return { t: 'This request was cancelled', p: 'Start again whenever you like.', a: ['retry'] };
      default: return { t: 'fal.ai had a problem making this video', p: 'Their servers couldn’t finish it. fal.ai only charges for successful results. Try again in a moment.' + paid + (detail && detail.length < 160 ? ' (' + detail + ')' : ''), a: ['retry'] };
    }
  }
  function failJob(job, e) {
    console.warn('[glow-ai] job failed', e);
    RUN.job = null;
    UI.state = 'error';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    clearJob();
    var v = errorView(e, job);
    var keepStill = job.stillUrl && e.kind !== 'moderation' && e.kind !== 'auth';
    S.retryJob = keepStill ? { sceneId: job.sceneId, sound: job.sound, trackId: job.trackId, duration: job.duration, stillUrl: job.stillUrl, thumb: job.thumb, photoSeq: job.photoSeq } : null;
    el.pv.classList.add('error');
    el.err.hidden = false;
    el.errT.textContent = v.t; el.errP.textContent = v.p;
    el.errActions.textContent = '';
    v.a.forEach(function (a, i) {
      var b = document.createElement(a === 'billing' || a === 'keys' ? 'a' : 'button');
      b.className = 'btn ' + (i === 0 ? 'primary' : 'glass');
      if (b.tagName === 'A') { b.href = a === 'billing' ? BILLING_URL : KEYS_URL; b.target = '_blank'; b.rel = 'noopener'; }
      else b.type = 'button';
      b.textContent = { key: 'Fix my key', keys: 'Open fal.ai keys', billing: 'Add credit on fal.ai', retry: 'Try again', photo: 'Choose another photo', scene: 'Pick another scene' }[a];
      b.addEventListener('click', function () { errAction(a); });
      el.errActions.appendChild(b);
    });
    el.cancel.hidden = false; el.cancel.textContent = 'Close';
    el.tapFinish.hidden = true; el.keepOpen.hidden = true; el.mon.hidden = true;
    el.progTt.textContent = 'Something went wrong';
    setMsg('');
    el.eta.textContent = '';
    ['still', 'video', 'finish'].forEach(function (s) { var li = el.steps.querySelector('[data-step="' + s + '"]'); if (li && li.dataset.state === 'active') { li.dataset.state = 'error'; setStep(s, null, 'Stopped'); } });
    el.elapsed.parentNode.hidden = true;
    if (UI.minimized || el.prog.hidden) openProgress();
    el.pill.hidden = true;
    updateCost();
    setTimeout(function () { var f = el.errActions.querySelector('.btn'); if (f) try { f.focus(); } catch (x) { /* ignore */ } }, 60);
  }
  function errAction(a) {
    if (a === 'billing' || a === 'keys') return; // links open fal.ai in a new tab
    closeProgressSheet();
    if (a === 'key') openConnect();
    else if (a === 'photo') { attention(el.photoCard); openPicker(); }
    else if (a === 'scene') { attention(el.sceneCard); var b = sceneBtns[S.sceneId]; if (b) try { b.btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    else if (a === 'retry') onMake({ retry: true });
  }
  function cancelJob() {
    var job = RUN.job;
    if (!job) { closeProgressSheet(); return; }
    if (UI.stage === 'finish') return; // already paid for: always finish
    RUN.cancelled = true;
    var h = job.video || job.still;
    RUN.job = null;
    wakeAll();
    clearJob();
    UI.state = 'idle';
    clearInterval(UI.timer); clearTimeout(UI.msgTimer);
    closeProgressSheet();
    updateCost();
    if (h) cancelRemote(h);
    toast('Cancelled — fal.ai only charges for finished results.', 'info', 4000);
  }

  /* ------------------------------------------------------------------ *
   * Make
   * ------------------------------------------------------------------ */
  function onMake(opts) {
    ensureAudio(); // unlock audio with this tap so finishing can record sound
    if (running()) { openProgress(); return; }
    var rj = S.retryJob && S.retryJob.stillUrl && S.retryJob.sceneId === S.sceneId && (!S.photo || S.retryJob.photoSeq === S.photo.seq) ? S.retryJob : null;
    if (!S.photo && !rj) {
      toast('Add your selfie first.', 'warn');
      attention(el.photoCard);
      setTimeout(function () { try { el.pick.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 300);
      return;
    }
    if (S.photo && !S.consent) {
      toast('Please confirm you have permission to use this photo.', 'warn', 4200);
      attention(el.consentRow);
      el.consentRow.classList.add('need');
      setTimeout(function () { try { el.consent.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 300);
      return;
    }
    if (!getKey()) { openConnect('make'); return; }
    if (navigator.onLine === false) { toast('You’re offline. Connect to the internet to make a video.', 'warn', 4500); return; }
    if (!canRecord()) toast('This browser can’t add the label and music itself — you’ll get the original video from fal.ai.', 'warn', 6000);
    var job = newJob();
    // After a failure, trying again reuses the scene photo that was already made (and paid for): it depends only on
    // the photo and the scene, so the sound and length can still change.
    if (rj) {
      job.stillUrl = rj.stillUrl; job.stage = 'video';
      if (!job.thumb) job.thumb = rj.thumb;
      job.photoSeq = rj.photoSeq;
    }
    S.retryJob = null;
    startRun(job, {});
  }

  var resumeWaitingForKey = false;
  function resumeIfAny() {
    var job = lsJSON(LS.job);
    if (!job || job.v !== 1 || running()) return;
    if (Date.now() - (job.createdAt || 0) > 24 * 3600e3) { clearJob(); return; }
    if (job.owner && job.owner !== TAB && Date.now() - (job.beat || 0) < 12000) { watchOtherTab(); return; }
    var paidStarted = job.stillUrl || job.still || job.video || job.videoUrl;
    if (!paidStarted) { clearJob(); return; } // nothing was sent to the paid models yet
    if (!getKey()) {
      resumeWaitingForKey = true;
      toast('Connect fal.ai again to finish the video you started.', 'warn', 6000);
      return;
    }
    job.tries = job.tries || {};
    startRun(job, { resumed: true });
  }
  var otherTabTimer = 0;
  function watchOtherTab() {
    toast('Your video is being made in another Glow Studio tab.', 'info', 5000);
    clearInterval(otherTabTimer);
    otherTabTimer = setInterval(function () {
      var job = lsJSON(LS.job);
      if (!job) { clearInterval(otherTabTimer); loadHistory(); return; }
      if (Date.now() - (job.beat || 0) > 15000) { clearInterval(otherTabTimer); resumeIfAny(); }
    }, 5000);
  }
  window.addEventListener('storage', function (e) {
    if (e.key === LS.job && !e.newValue && !running()) loadHistory();
    if (e.key === LS.key) updateKeyUI();
  });

  /* ------------------------------------------------------------------ *
   * Result
   * ------------------------------------------------------------------ */
  var resUrl = null, resItem = null;
  function extOf(type) { return /mp4/i.test(type || '') ? 'mp4' : /webm/i.test(type || '') ? 'webm' : /quicktime|mov/i.test(type || '') ? 'mov' : 'mp4'; }
  function fileName(item) { return 'glow-ai-' + item.sceneId + (item.labelled ? '' : '-original') + '.' + extOf(item.type); }
  function showResult(item, opts) {
    resItem = item;
    if (resUrl) { try { URL.revokeObjectURL(resUrl); } catch (e) { /* ignore */ } resUrl = null; }
    var src = item.blob ? (resUrl = URL.createObjectURL(item.blob)) : (item.remote || item.rawUrl || '');
    var w = item.width || 9, h = item.height || 16;
    el.res.querySelector('.res-video').style.setProperty('--resar', (w / h).toFixed(5));
    el.resVideo.src = src;
    el.labelOv.hidden = !!item.labelled;
    el.dl.href = src || '#';
    el.dl.setAttribute('download', fileName(item));
    el.dl.toggleAttribute('data-remote', !item.blob);
    var bits = [item.sceneName || sceneById(item.sceneId).name, fmt(item.duration)];
    if (item.width && item.height) bits.push(item.width + '×' + item.height);
    if (item.size) bits.push(fmtBytes(item.size));
    bits.push(extOf(item.type).toUpperCase());
    bits.push(item.sound === 'ai' ? 'AI sound' : ((trackById(item.trackId) || {}).name || 'Music'));
    el.resMeta.textContent = bits.join(' · ');
    el.resNote.hidden = !item.note; el.resNote.textContent = item.note || '';
    var fresh = !!(opts && opts.fresh);
    el.resTt.textContent = fresh ? 'Your AI video is ready' : (item.sceneName || 'Your AI video');
    el.again.hidden = !fresh; el.other.hidden = !fresh; el.del.hidden = fresh;
    el.del.textContent = 'Delete from this device'; el.del.dataset.armed = '';
    var file = null;
    try { file = item.blob ? new File([item.blob], fileName(item), { type: item.blob.type || item.type }) : null; } catch (e) { file = null; }
    var canShare = false;
    try { canShare = !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) { canShare = false; }
    el.share.hidden = !canShare;
    el.share.onclick = function () {
      navigator.share({ files: [file], title: 'My AI video', text: 'Made with Glow Studio AI Scenes' }).catch(function (e) {
        if (e && e.name !== 'AbortError') toast('Sharing didn’t work — try Download instead.', 'warn');
      });
    };
    el.res.classList.toggle('one-row', el.share.hidden);
    window.GlowAI.lastResult = { id: item.id, size: item.size, type: item.type, name: fileName(item), width: item.width, height: item.height, duration: item.duration, labelled: item.labelled, blob: item.blob };
    openSheet(el.res, el.dl);
    var pr = el.resVideo.play && el.resVideo.play();
    if (pr && pr.catch) pr.catch(function () { /* autoplay blocked or unsupported codec */ });
  }
  function closeResult() {
    try { el.resVideo.pause(); } catch (e) { /* ignore */ }
    closeSheet(el.res);
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
      if (item.sound === 'ai') { var sb = document.createElement('span'); sb.className = 'ai-h-snd'; sb.textContent = 'AI sound'; play.appendChild(sb); }
      play.addEventListener('click', function () { showResult(item, { fresh: false }); });
      li.appendChild(play);
      var meta = document.createElement('div'); meta.className = 'ai-h-meta';
      var nm = document.createElement('b'); nm.textContent = item.sceneName || sc.name; meta.appendChild(nm);
      var dt = document.createElement('small'); dt.textContent = dayLabel(item.createdAt); meta.appendChild(dt);
      li.appendChild(meta);
      var acts = document.createElement('div'); acts.className = 'ai-h-acts';
      var dl = document.createElement('a'); dl.className = 'ai-h-btn'; dl.setAttribute('aria-label', 'Download ' + (item.sceneName || sc.name));
      dl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/></svg>';
      if (item.blob) { dl.href = '#'; dl.addEventListener('click', function (e) { e.preventDefault(); downloadItem(item); }); }
      else { dl.href = item.remote || item.rawUrl || '#'; dl.target = '_blank'; dl.rel = 'noopener'; }
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
  }
  function downloadItem(item) {
    if (!item.blob) return;
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
  });
  el.make.addEventListener('click', function () { onMake(); });
  Array.prototype.forEach.call(el.sound.querySelectorAll('.ai-snd'), function (b, i, all) {
    b.addEventListener('click', function () { setSound(b.getAttribute('data-sound'), true); });
    b.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      e.preventDefault();
      var nb = all[(i + 1) % all.length];
      setSound(nb.getAttribute('data-sound'), true);
      all[S.sound === 'ai' ? 1 : 0].focus();
    });
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
  el.prog.addEventListener('click', function (e) { if (e.target === el.prog) minimize(); });
  el.pill.addEventListener('click', function () {
    if (mode() !== 'ai') setMode('ai');
    if (readyItem) { var it = readyItem; readyItem = null; el.pill.hidden = true; el.pill.classList.remove('ready'); showResult(it, { fresh: true }); return; }
    openProgress();
  });
  el.cancel.addEventListener('click', function () { if (UI.state === 'running') cancelJob(); else closeProgressSheet(); });
  el.mon.addEventListener('click', function () {
    UI.monitorOn = !UI.monitorOn;
    el.mon.setAttribute('aria-pressed', UI.monitorOn ? 'true' : 'false');
    el.mon.setAttribute('aria-label', UI.monitorOn ? 'Mute sound while finishing' : 'Play sound while finishing');
    if (UI.mon && actx) { try { UI.mon.gain.setTargetAtTime(UI.monitorOn ? 0.9 : 0, actx.currentTime, 0.02); } catch (e) { UI.mon.gain.value = UI.monitorOn ? 0.9 : 0; } }
  });
  el.resClose.addEventListener('click', closeResult);
  el.res.addEventListener('click', function (e) { if (e.target === el.res) closeResult(); });
  el.dl.addEventListener('click', function (e) {
    if (!resItem) { e.preventDefault(); return; }
    if (resItem.blob) toast('Saving your video…', 'ok', 2000);
    else { e.preventDefault(); window.open(resItem.remote || resItem.rawUrl, '_blank', 'noopener'); }
  });
  el.again.addEventListener('click', function () { closeResult(); onMake(); });
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
    if (!el.res.hidden) closeResult();
    else if (!el.conn.hidden) { connectThen = null; closeSheet(el.conn); }
    else if (!el.prog.hidden) minimize();
  });
  document.addEventListener('glow:mode', function (e) { if (e.detail && e.detail.mode !== 'ai') stopTrackPreview(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopTrackPreview(); });
  // Leaving the page releases the job at once, so a reload or another tab can pick it up without waiting.
  window.addEventListener('pagehide', function () {
    if (!RUN.job) return;
    var j = lsJSON(LS.job);
    if (j && j.id === RUN.job.id) { j.beat = 0; lsSet(LS.job, JSON.stringify(j)); }
  });
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
    if (f && f.length) setPhotoFile(f[0]);
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
      return { still: { endpoint: EP.still, input: stillInput(sc, refUrl || 'https://example.invalid/selfie.jpg') }, video: { endpoint: tier === 'ai' ? EP.ai : EP.std, input: videoInput(sc, tier, dur || sc.length, stillUrl || 'https://example.invalid/still.jpg') } };
    },
    get state() {
      return {
        mode: mode(), sceneId: S.sceneId, sound: S.sound, trackId: S.trackId, duration: S.duration, hasPhoto: !!S.photo, consent: S.consent,
        hasKey: !!getKey(), running: running(), stage: running() ? UI.stage : null, ui: UI.state, estimate: estimate(S.sound, S.duration),
        history: H.list.length, historyPersistent: !H.mem, job: lsJSON(LS.job)
      };
    }
  };

  renderScenes();
  renderTracks();
  renderLengths();
  (function initSelection() {
    var sc = sceneById(S.sceneId);
    S.trackId = trackById(prefs.trackId) ? prefs.trackId : (trackById(sc.defaultTrack) ? sc.defaultTrack : (tracks[0] ? tracks[0].id : ''));
    if (!S.trackId) S.sound = 'ai';
    S.duration = LENGTHS.indexOf(prefs.duration) >= 0 ? prefs.duration : (sc.length || 5);
    if (sc.audio === 'required') S.sound = 'ai';
    else if (!prefs.sound) S.sound = sc.audio === 'recommended' ? 'ai' : 'music';
  })();
  setMode(mode());
  renderPhoto();
  updateKeyUI();
  updateAll();
  loadHistory();
  setTimeout(resumeIfAny, 60);
  if (!MU) setTimeout(function () { if (mode() === 'ai') toast('Music didn’t load — choose AI sound, or refresh the page.', 'warn', 6000); }, 400);
})();
