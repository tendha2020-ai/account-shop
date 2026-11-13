// sing.js
// antics "Sing" (workers that list 'sing' in /health, v14): one or two animals sing a song. Step 1 gets a third
// mode, Sing: 1-2 singers (your video or photo, a free clip, a link, or "Pick an animal": a painted bear, cat...).
// Step 2 becomes the song (My songs first; Детство is picked when it is the song for every video), its part (the
// meme part, the chorus or the whole song) and the honest time line the worker counts (PRO minutes, days, PC
// nights). Step 3 becomes the stage, the shots, who sings what (a duet) and each singer's voice (every voice for
// every singer, each with ▶). Step 4 says who makes it (online, my PC, both) and what it costs; until one singing
// AI has passed it, the first Sing video is a 5-second test. Also here: the job cards (getting the song ready, the
// picture check, waiting for free time, the PC at night, the test's question, the parts), the player (parts, the
// test), the editor's "Song and stage" box, the Post screen's lines for sung videos, the Singing box in Settings,
// and sing words in what you say. It runs after app.js and together.js and uses app.js's helpers ($, state, api,
// canDo, toast, note, renderOptions, playSong, ...). app.js calls in through window.Sing ("(Sing)" there).
//
// The worker's side (PLAN.md section 10, sing_design.md section 6, worker/sing.py), as this page uses it:
//   GET  /health   features + 'sing'; pc_sing: a PC helper that can sing is on now
//   GET  /gpu      sing.gpu_view(): {base, left, resets_at, alert, readable, sing_share, sing_left, pc_until, default,
//                  engines: {L1|X|K|P: {name, state: good|bad|untested, request, spend_est, spend_med, wall_med,
//                  measured}}}  (base/left: seconds of the day's ZeroGPU time; null without the GPU guard)
//   GET  /sing/test?engine=<id>   sing.test_cost(): {engine, name, minutes: [lo, hi], ready_min, fits, pc, all_tested}
//   POST /settings JSON {sing_share: seconds}  ->  the /gpu answer
//   GET  /songs/{id}/sing?singers=1|2   {state: ready|preparing|queued|none|failed, split, progress, error, duration,
//                  voices, lines: [{n, start, end, kind}], parts: {meme|chorus|whole: {from, to, seconds, sung}},
//                  estimates: {meme|chorus|whole: sing.estimate()}}   (times only: never the words)
//   GET  /songs/{id}/voice?v=<voice>&at=<s>&key=   about 4 s of the song's singing in that voice
//   POST /jobs     mode=sing (sing.build_jobs): singers JSON [{from: upload|library|link|painted, animal, name, look,
//                  url, id, at, real_at}] in stage order (left, right); cast_files p{i}.jpg, v{i}.mp4|mov|webm|m4v or
//                  f{i}_{nnn}.jpg (+ real_fps) as in Together; song_id (or song: a friend's own file); part meme|chorus|
//                  whole; look studio|concert|karaoke|rooftop|own; shots cuts|one; who turns|both|JSON [{line, who:
//                  A|B|both}] (a duet; turns: line by line in turn, both sing the chorus); voices JSON, one per singer
//                  (original|cat|dog|bear|small|bird); engine online|pc|both; sharp sharp|fast; test true + test_engine;
//                  draft; title_on; beat_zooms; opening; outro; badge; endcard
//   a Sing job     (sing.public): kind 'sing', song_id, song_name, part (test: 'test'), part_from, part_to, singers
//                  [{from, animal, name, look}], voices, who, look, engine, sing_wait (song|quota|pc|pc_singing|
//                  unreadable|starting|guard), shots [{k, from,
//                  to, kind, angle, who, done, failed}], shots_done, shots_total, posts [{n, from, to, ready,
//                  sound_start}], picture_check, title_on, beat_zooms, tiktok_sound {name, start}; a test also
//                  test_engine, test_engine_name, test_state (null|good|bad|all_bad), test_clips [{engine, name,
//                  state}], test_next {engine, name, minutes}, test_pc
//   POST /jobs/{id}/test       answer=good|bad|pc (sing.verdict; bad: the same picture and 5 s go to the next AI)
//   POST /jobs/{id}/edit       voices, part, who, look, title_on, beat_zooms, opening, outro, brand, repicture (true or
//                              angle names), redo (shot numbers k: sung again with a new seed; as /shots/{k}/redo)
//   GET  /jobs/{id}/video?part=n | sofar=1 | test=<engine>   one TikTok part | the shots sung so far | a test clip
//   POST /jobs/{id}/finish     a preview, or an approved test (the whole meme part, the test shot first)

(() => {
  // ---------- What the worker knows (worker/sing.py, worker/sing_audio.py) ----------

  const MAX_SINGERS = 2; // a duet at most: left and right on the stage
  const VIDEO_MAX = 60 * 1024 * 1024; // a bigger video goes as ~6 s of frames (as in Together)
  const FRAME_FPS = 12;
  const KEY = { mode: 'antics.mode', sing: 'antics.sing' };
  // Facts only (no audio): the song TENDHA2 sent. The worker uses its meme part when a copy's length matches.
  const KNOWN_SONGS = [{ name: 'Rauf & Faik - Детство', title: 'Детство', artist: 'Rauf & Faik', seconds: 188.41, meme: 49.13 }];
  const PARTS = [
    { id: 'meme', name: 'Meme part', guess: 'about 15 s' },
    { id: 'chorus', name: 'Chorus', guess: 'about 30 s' },
    { id: 'whole', name: 'Whole song', guess: 'the whole song', owner: true },
  ];
  const PART_RANK = { meme: 0, chorus: 1, whole: 2 };
  const LOOKS = [
    { id: 'studio', emoji: '🎤', name: 'Studio' },
    { id: 'concert', emoji: '🎆', name: 'Concert' },
    { id: 'karaoke', emoji: '🎙️', name: 'Karaoke bar' },
    { id: 'rooftop', emoji: '🌃', name: 'Rooftop' },
    { id: 'own', emoji: '🏠', name: 'Its own place' },
  ];
  // VOICES in worker/sing_audio.py: whole octaves or none (the song stays in its key), and the singer's size.
  const VOICES = [
    { id: 'original', name: 'Original', sub: 'the real singer' },
    { id: 'cat', name: 'Cat', sub: 'an octave up' },
    { id: 'dog', name: 'Dog', sub: 'a bit darker' },
    { id: 'bear', name: 'Bear', sub: 'an octave down' },
    { id: 'small', name: 'Small', sub: 'chipmunk' },
    { id: 'bird', name: 'Bird', sub: 'high and bright' },
  ];
  const VOICE_IDS = VOICES.map((v) => v.id);
  // voice_for() in worker/sing_audio.py: an animal's own voice (unknown animals sing as a dog, the middle)
  const ANIMAL_VOICE = { cat: 'cat', kitten: 'cat', hamster: 'bird', parrot: 'bird', bird: 'bird', chick: 'bird', mouse: 'bird',
    owl: 'bird', duck: 'bird', rabbit: 'small', bunny: 'small', puppy: 'small', fox: 'small', frog: 'small', koala: 'small',
    dog: 'dog', goat: 'dog', pig: 'dog', monkey: 'dog', horse: 'dog', sheep: 'dog', penguin: 'dog', capybara: 'dog',
    bear: 'bear', panda: 'bear', cow: 'bear', lion: 'bear', gorilla: 'bear', hippo: 'bear', elephant: 'bear' };
  function voiceFor(animal) {
    const words = String(animal || '').toLowerCase().split(/\s+/).reverse();
    for (const w of words) if (ANIMAL_VOICE[w.replace(/s$/, '')] || ANIMAL_VOICE[w]) return ANIMAL_VOICE[w] || ANIMAL_VOICE[w.replace(/s$/, '')];
    return 'dog';
  }
  // "Pick an animal": a photoreal painted singer of that type (the first 12 show, More… the rest)
  const ANIMALS = [['bear', '🐻'], ['cat', '🐱'], ['dog', '🐶'], ['parrot', '🦜'], ['monkey', '🐒'], ['panda', '🐼'],
    ['fox', '🦊'], ['hamster', '🐹'], ['penguin', '🐧'], ['capybara', '🦫'], ['frog', '🐸'], ['pig', '🐷'], ['rabbit', '🐰'],
    ['lion', '🦁'], ['koala', '🐨'], ['owl', '🦉'], ['goat', '🐐'], ['duck', '🦆'], ['horse', '🐴'], ['cow', '🐮'],
    ['sheep', '🐑'], ['chicken', '🐔'], ['raccoon', '🦝'], ['sloth', '🦥']];
  const FIRST_ANIMALS = 12;
  const EMOJI = Object.fromEntries(ANIMALS);
  const ANIMAL_IDS = ANIMALS.map(([a]) => a);
  // The singing AIs (ENGINES in worker/sing.py). L2 is L1's same model on another Space: never tested on its own.
  const ENGINE_NAMES = { L1: 'LongCat', L2: 'LongCat (copy)', X: 'LTX-2', K: 'Kandinsky', O: 'Your singing GPU', P: 'Your PC' };
  const TEST_ORDER = ['L1', 'X', 'K', 'O', 'P'];
  const SHARE_STEPS = [25, 50, 75, 100];

  const cap = (t) => String(t || '').replace(/^./, (c) => c.toUpperCase());
  const cleanName = (t) => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  // Look words: plain words only (the worker checks them again, and never puts real people or brands in a prompt)
  const cleanLook = (t) => String(t || '').replace(/[^\p{L}\p{N} ,'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const span = ([lo, hi], unit) => (Math.round(lo) === Math.round(hi) ? `${Math.round(lo)}` : `${Math.round(lo)}–${Math.round(hi)}`) + (unit ? ` ${unit}` : '');
  const tenth = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const timeOf = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const animalWord = (s) => cap(s.animal || 'singer');

  // Animal words in a file name, a link or what you say
  const ANIMAL_WORDS = [
    ['dog', /\b(?:dogs?|pupp(?:y|ies)|pups?|doggo|doggy|husky|corgi|pug|poodle|labrador|retriever|chihuahua|beagle|terrier|dachshund|bulldog|shiba)\b/i],
    ['cat', /\b(?:cats?|kittens?|kitty|kitties|tabby)\b/i],
    ['parrot', /\b(?:parrots?|budgies?|cockatiels?|birds?)\b/i],
    ...ANIMALS.filter(([a]) => !['dog', 'cat', 'parrot'].includes(a)).map(([a]) => [a, new RegExp(String.raw`\b${a}s?\b`, 'i')]),
  ];
  const guessAnimal = (text) => {
    const words = String(text || '').replace(/[_\-.+/]+/g, ' ');
    const found = ANIMAL_WORDS.find(([, re]) => re.test(words));
    return found ? found[0] : '';
  };

  // ---------- State ----------

  const S = {
    on: false,
    saved: false, // Sing is on from an earlier visit (a worker without Sing goes back to One animal)
    singers: [], // in stage order: { key, from, file, pic, picUrl, poster, at, animal, name, look, url, site, id, entry, real, status }
    keys: 0,
    reading: Promise.resolve(),
    picking: false, // the "Pick an animal" panel is open
    more: false, // ... with all the animals
    songId: null,
    songPicked: false, // a song was tapped on this visit
    ownSong: null, // a friend's own song file (kept with that video only)
    adding: '', // the known song being added ("Add your copy")
    part: 'meme',
    look: 'studio',
    shots: 'cuts',
    who: 'turns',
    lines: null, // "Choose lines": { [line n]: 'A' | 'B' | 'both' }
    voices: ['original', 'original'],
    voicePicked: [false, false],
    engine: 'online',
    enginePicked: false,
    sharp: 'sharp',
    draft: null, // null: on for the chorus and the whole song, off for the meme part
    title: true,
    zooms: true,
    test: null, // the singing AI picked for the 5-second test (null: the next untested one)
    retest: false, // "Test singing again" from Settings
    packs: {}, // `${worker}|${song}|${singers}` -> { data, at, loading }
    packTimer: null,
    gpu: null,
    gpuFor: '',
    gpuAt: 0,
    gpuLoading: null,
    library: null,
    libLoading: null,
    libFilter: 'all',
    hearing: '', // the ▶ playing now (a part, or a voice sample)
    hearingUrl: '',
    pictureRev: {},
    sigs: {},
    view: { job: null, part: 0 }, // the player: which part of a series is showing (0: the whole video)
  };

  const known = () => Boolean(state.health);
  const ready = () => canDo('sing');
  // The owner always sees Sing (with "Update needed" on an older worker); a friend only when the worker sings.
  const allowed = () => Boolean(isGuest() ? ready() : true);
  const on = () => S.on && allowed();
  const outdated = () => known() && !ready();
  // The worker is on the newest version, but its singing part didn't install (an optional build step failed):
  // the same update can't fix that, a rebuild from scratch can.
  const rebuildNeeded = () => outdated() && state.health.version === WORKER_VERSION;
  const UPDATE_SING = 'Your worker needs an update for Sing videos: tap Update my worker (about 10–20 min, once).';
  const REBUILD_SING = "Your worker is up to date, but its singing part didn't install. Tap Rebuild my worker: Hugging Face builds it again (about 10–20 min). Your videos stay.";
  const needText = () => (rebuildNeeded() ? REBUILD_SING : UPDATE_SING);
  const workerTag = () => (state.worker ? `${state.worker.url}|${state.worker.key}` : '');
  const owner = () => Boolean(state.worker) && !isGuest();

  function setOn(v) {
    S.on = Boolean(v);
    S.saved = false;
    save(KEY.mode, S.on ? 'sing' : 'one');
    if (S.on && ready()) {
      loadGpu();
      settleSong();
      loadPack();
    }
    redraw();
  }

  function redraw() {
    renderOptions(); // (ends with Sing.render)
    if (!on()) renderSource();
  }

  let soon = 0;
  function redrawSoon() {
    if (soon) return;
    soon = requestAnimationFrame(() => {
      soon = 0;
      redraw();
      renderJobs();
      if ($('#settings').open) renderSettings();
    });
  }

  function remember() {
    save(KEY.sing, { part: S.part, look: S.look, shots: S.shots, who: S.who, sharp: S.sharp, title: S.title, zooms: S.zooms,
      draft: S.draft });
  }

  // ---------- The worker's GPU time and its singing AIs (GET /gpu) ----------

  function loadGpu(force = false) {
    if (!state.worker || !ready()) return Promise.resolve(null);
    const tag = workerTag();
    if (!force && S.gpuFor === tag && Date.now() - S.gpuAt < (S.gpu ? 30000 : 10000)) return Promise.resolve(S.gpu);
    if (S.gpuLoading) return S.gpuLoading;
    S.gpuLoading = api('/gpu')
      .then((g) => {
        if (workerTag() === tag) setGpu(g, tag);
        return g;
      })
      .catch(() => {
        if (workerTag() === tag) { // (tried: asked again in a little while)
          if (S.gpuFor !== tag) S.gpu = null;
          Object.assign(S, { gpuFor: tag, gpuAt: Date.now() });
        }
        return null;
      })
      .finally(() => {
        S.gpuLoading = null;
        redrawSoon();
      });
    return S.gpuLoading;
  }

  function setGpu(g, tag = workerTag()) {
    if (!g || typeof g !== 'object') return;
    S.gpu = g;
    S.gpuFor = tag;
    S.gpuAt = Date.now();
  }

  const gpu = () => (S.gpuFor === workerTag() ? S.gpu : null);
  // The singing AIs' states: /gpu (the owner), else /health's sing block (a friend can't read /gpu).
  function engines() {
    if (gpu() && gpu().engines) return gpu().engines;
    const h = state.health && state.health.sing;
    if (h && h.engines) return Object.fromEntries(Object.entries(h.engines).map(([id, st]) => [id, { state: st }]));
    return {};
  }
  const enginesKnown = () => Boolean((gpu() && gpu().engines) || (state.health && state.health.sing && state.health.sing.engines));
  const engineName = (id) => ENGINE_NAMES[id] || (engines()[id] && engines()[id].name) || id;
  const baseMin = () => {
    const g = gpu();
    return g && Number.isFinite(g.base) && g.base > 0 ? Math.round(g.base / 60) : 40;
  };
  // No GPU guard on the worker (gpu.py): Sing makes no online call at all (it never risks paid credits).
  const noGuard = () => Boolean(gpu() && gpu().guard === false);
  const NO_GUARD = "Your worker can't check your free GPU time yet, so it makes no online singing (it never risks your credits). "
    + 'Update your worker when a new version is ready. Your PC can still sing.';
  const anyGood = () => Object.entries(engines()).some(([id, e]) => id !== 'P' && e && e.state === 'good');
  const pcEngine = () => engines().P || null;
  // A PC helper that can sing is on (it said can=sing): /health pc_sing, or the /gpu answer's.
  const pcCan = () => Boolean((state.health && state.health.pc_sing) || (gpu() && gpu().pc_sing) || (pcEngine() && pcEngine().can));
  const pcGood = () => Boolean(pcEngine() && pcEngine().state === 'good');
  const testable = () => TEST_ORDER.filter((id) => engines()[id]);
  // Every singing AI there is was tried and none sang: no Sing video is offered as working.
  const allBad = () => Boolean(enginesKnown() && !anyGood() && !pcGood() && testable().length
    && testable().every((id) => engines()[id].state === 'bad'));
  // The 5-second test comes first until a singing AI is marked good (or when Settings asked for a new test).
  const testMode = () => owner() && ready() && enginesKnown() && !allBad() && (S.retest || !(anyGood() || pcGood()));
  // A friend can't sing until the owner's test passed.
  const friendBlocked = () => isGuest() && enginesKnown() && !anyGood();
  const testCosts = {}; // engine -> { at, data } (GET /sing/test)

  function testEngine() {
    const list = testable();
    if (S.test && list.includes(S.test)) return S.test;
    return list.find((id) => engines()[id].state === 'untested' && (id !== 'P' || pcCan()))
      || list.find((id) => engines()[id].state === 'good') || list[0] || 'L1';
  }

  // What one test call costs, from the worker (GET /sing/test), else from the /gpu engine table.
  function loadTestCost(id) {
    const have = testCosts[id];
    if (!state.worker || (have && (have.loading || Date.now() - have.at < 30000))) return;
    testCosts[id] = { ...(have || {}), loading: true };
    const tag = workerTag();
    api(`/sing/test?engine=${encodeURIComponent(id)}`)
      .then((data) => { testCosts[id] = { data: workerTag() === tag ? data : null, at: Date.now() }; })
      .catch(() => { testCosts[id] = { data: null, at: Date.now() }; })
      .finally(redrawSoon);
  }

  // "about 4–8 of your 40 min" for one call of an engine (+ one stage picture, unless it is reused)
  function callMinutes(id, picture = true) {
    const got = testCosts[id] && testCosts[id].data;
    if (picture && got && Array.isArray(got.minutes) && got.minutes.length === 2) return got.minutes.map((m) => Math.max(1, Math.round(m)));
    const e = engines()[id] || {};
    const pic = picture ? 48 : 0; // (one stage picture, counted at its worst)
    const lo = Number(e.spend_med) || Number(e.spend_est) || 240;
    const hi = Number(e.request) || lo * 2;
    return [Math.max(1, Math.round((lo + pic / 2) / 60)), Math.max(1, Math.round((hi + pic) / 60))];
  }

  function testCost(id) {
    loadTestCost(id);
    if (id === 'P') {
      return 'Your PC sings it when you switch the helper on (no online time except one picture, a few seconds). It renders one 3 s piece and one more after it, and measures your PC.';
    }
    if (noGuard()) return NO_GUARD;
    const got = testCosts[id] && testCosts[id].data;
    const e = engines()[id] || {};
    const wall = got && got.ready_min ? got.ready_min : e.wall_med ? Math.max(1, Math.round((e.wall_med + 60) / 60)) : 5;
    const full = got && got.fits === false ? ' Not enough GPU time is left today: it runs by itself after the reset.' : '';
    return `Uses about ${span(callMinutes(id))} of your ${baseMin()} min today (one ${engineName(id)} clip plus one picture). Ready in about ${wall} min.${full}`;
  }

  // ---------- The song: My songs first, and its singing pack (GET /songs/{id}/sing) ----------

  const songList = () => (songsOn() ? state.songs : []);
  const sameName = (a, b) => toLatin(String(a)).replace(/[^a-z0-9]+/g, ' ').trim() === toLatin(String(b)).replace(/[^a-z0-9]+/g, ' ').trim();
  const knownOf = (s) => KNOWN_SONGS.find((k) => sameName(k.name, s.name) || sameName(k.title, s.name)
    || (Math.abs((s.duration || 0) - k.seconds) < 1 && toLatin(s.name).includes(toLatin(k.title)))) || null;
  const song = () => songList().find((s) => s.id === S.songId) || null;
  const songTitle = (name) => {
    const n = String(name || '');
    const k = KNOWN_SONGS.find((x) => sameName(x.name, n) || sameName(x.title, n));
    return k ? k.title : n.split(/\s[-–—]\s/).pop() || n || 'the song';
  };
  const titleNow = () => (S.ownSong ? 'your song' : song() ? songTitle(song().name) : 'the song');

  // My songs first: the song for every video, else Детство, else the first. A song tapped on this visit stays.
  function settleSong() {
    const list = songList();
    if (S.ownSong) return;
    if (S.songId && list.some((s) => s.id === S.songId)) return;
    const pick = list.find((s) => s.default) || list.find((s) => knownOf(s)) || list[0] || null;
    S.songId = pick ? pick.id : null;
    S.songPicked = false;
  }

  const packKey = () => `${workerTag()}|${S.songId}|${S.singers.length >= 2 ? 2 : 1}`;
  const pack = () => {
    const p = S.packs[packKey()];
    return p && p.data ? p.data : null;
  };
  const packReady = () => Boolean(pack() && pack().state === 'ready');
  const GETTING = ['preparing', 'queued', 'none'];
  const preparing = () => Boolean(pack() && GETTING.includes(pack().state));

  async function loadPack(force = false) {
    if (!state.worker || !ready() || !on() || !S.songId || S.ownSong) return;
    const key = packKey();
    const have = S.packs[key];
    if (have && have.loading) return;
    const fresh = have && have.data && !GETTING.includes(have.data.state) ? 120000 : 5000; // (getting ready, or not there: soon again)
    if (!force && have && Date.now() - have.at < fresh) return;
    S.packs[key] = { ...(have || {}), loading: true };
    const n = S.singers.length >= 2 ? 2 : 1;
    let data;
    try {
      data = await api(`/songs/${encodeURIComponent(S.songId)}/sing?singers=${n}`);
    } catch (e) {
      data = e.waking ? (have && have.data) || null : { state: 'failed', error: e.message };
    }
    S.packs[key] = { data, at: Date.now(), loading: false };
    clearTimeout(S.packTimer);
    if (data && GETTING.includes(data.state)) S.packTimer = setTimeout(() => loadPack(true), 5000);
    redrawSoon();
  }

  // A part's {from, to, seconds, sung}: the pack's parts, else its estimate's (sing.estimate has them too).
  const partInfo = (id = S.part) => (packReady() && ((pack().parts && pack().parts[id]) || (pack().estimates && pack().estimates[id]))) || null;
  const partSeconds = (id = S.part) => (partInfo(id) ? Number(partInfo(id).seconds) || 0 : 0);
  const partsShown = () => PARTS.filter((p) => !(p.owner && isGuest()));
  const partName = (id) => (PARTS.find((p) => p.id === id) || PARTS[0]).name;
  const linesIn = (id = S.part) => {
    const p = partInfo(id);
    if (!p || !packReady()) return [];
    return (pack().lines || []).filter((l) => (l.start + l.end) / 2 >= p.from && (l.start + l.end) / 2 < p.to); // (a line's middle in the part)
  };
  const voicesOk = () => !packReady() || pack().voices !== false;

  // ---------- Who makes it, what it takes ----------

  const pcOk = () => owner() && pcGood();
  // Meme part and chorus: online; the whole song: both when the PC can sing (else online, with the honest days).
  const engineDefault = () => (S.part === 'whole' && pcOk() ? 'both' : 'online');
  const engineNow = () => {
    if (isGuest() || !pcOk()) return 'online';
    return S.enginePicked ? S.engine : engineDefault();
  };
  // One shot (no cuts) needs a PC (it continues a take); online engines restart from the picture.
  const oneShotOk = () => engineNow() === 'pc' && (!partSeconds() || partSeconds() <= 60);
  const shotsNow = () => (S.shots === 'one' && oneShotOk() ? 'one' : 'cuts');
  const draftNow = () => !testMode() && !isGuest() && (S.draft === null ? S.part !== 'meme' : S.draft);
  const duet = () => S.singers.length >= 2;

  function estimate() {
    const p = pack();
    return (p && p.state === 'ready' && p.estimates && p.estimates[S.part]) || null;
  }

  function pcText(pc) {
    const mins = Array.isArray(pc.minutes) ? pc.minutes : null;
    if (mins && mins[1] <= 90) return `about ${span(mins, 'min')}`;
    if (mins && mins[1] <= 360) {
      const h = (m) => (Math.round((m / 60) * 10) / 10).toString();
      return `about ${h(mins[0]) === h(mins[1]) ? h(mins[0]) : `${h(mins[0])}–${h(mins[1])}`} h`;
    }
    // nights of 8 h: from the minutes when there are any (1–2 nights), else the worker's count
    const night = (m) => Math.max(1, Math.ceil(m / 480));
    const n = mins ? [night(mins[0]), night(mins[1])] : Array.isArray(pc.nights) ? pc.nights : [Number(pc.nights) || 1, Number(pc.nights) || 1];
    return `about ${span(n)} night${n[1] > 1 ? 's' : ''}`;
  }

  const daysText = (d) => (d <= 0 ? '' : `${plural(Math.round(d), 'day')}`);
  // "today", "tomorrow", "in about 3 days": the same words in step 2's time line and step 4's cost line
  const readyWhen = (d) => (d <= 1 ? 'today' : d === 2 ? 'tomorrow' : `in about ${daysText(d)}`);
  // Both (online by day, the PC when it is on): the worker counts it from the two (never slower than either)
  function bothText(b) {
    if (b.today) return 'ready today';
    if (Array.isArray(b.minutes)) return pcText({ minutes: b.minutes });
    const d = Number(b.days) || 0;
    const n = Number(b.nights) || 0;
    return `about ${[d ? plural(d, 'day') : '', n ? plural(n, 'night') : ''].filter(Boolean).join(' + ') || 'a day'}`;
  }

  // The time line in step 2: the worker's own count for this song, part, singers and PC.
  function timeLines() {
    const est = estimate();
    if (!est) return [];
    const out = [];
    const o = est.online;
    if (o) {
      const used = Math.max(1, Math.round((Number(o.quota_s) || 0) / 60));
      const days = Number(o.days) || 0;
      let line = o.days === null ? 'Online: not with the singing time you have now (give singing more in Settings)'
        : o.today || days <= 1 ? `Online: ready today (uses about ${used} of ${isGuest() ? `${hostName()}'s` : 'your'} ${baseMin()} min)`
          : days === 2 ? 'Online: ready tomorrow' : `Online: about ${daysText(days)}`;
      if (!o.measured && !isGuest() && days > 1) line += ' (an estimate until your test measures it)';
      out.push(line);
    }
    if (!isGuest()) {
      if (est.pc) out.push(`Your PC: ${pcText(est.pc)}${est.pc.measured ? '' : ' (estimate until it has sung once)'}`);
      if (est.both) out.push(`Both: ${bothText(est.both)}`);
      if (S.part === 'whole' && (est.pc || est.both)) out.push('Best on your PC or with Both');
    }
    return out;
  }

  // The line under step 4: what the GPU time pays for this video.
  function costLine() {
    if (isGuest()) {
      const left = state.me ? ` You have ${plural(state.me.uses_left, 'video')} left; this uses one.` : '';
      return `Made on ${hostName()}'s free GPU time.${left}`;
    }
    const est = estimate();
    const engine = engineNow();
    if (engine === 'pc') return 'Your PC sings it when you switch the helper on (no online time except the stage pictures, a few seconds each).';
    if (noGuard()) return NO_GUARD;
    if (engine === 'both' && est && est.both) {
      return `Online by day, your PC at night: ${bothText(est.both)}. It goes on by itself.`;
    }
    if (!est || !est.online) return 'Singing uses your daily GPU time. When it runs out, the video waits and goes on by itself the next day.';
    const o = est.online;
    const used = Math.max(1, Math.round((Number(o.quota_s) || 0) / 60));
    if (draftNow()) return `The preview sings the first shot (a few of your ${baseMin()} min). Finish sings the rest.`;
    if (o.today || (Number(o.days) || 0) <= 1) return `Uses about ${used} of your ${baseMin()} min of GPU today (${plural(o.calls || 1, 'singing clip')} + the stage pictures).`;
    const per = o.per_day ? ` It sings about ${plural(o.per_day, 'clip')} a day,` : '';
    return `More than one day of your singing time.${per} so it's ready ${readyWhen(Number(o.days) || 0)}. It goes on by itself; you can close antics.`;
  }

  // ---------- The singers ----------

  function newSinger(fields) {
    const s = { key: ++S.keys, animal: '', name: '', look: '', status: 'ready', real: false, ...fields };
    S.singers.push(s);
    S.lines = null; // (a new duet: the lines go back to taking turns)
    singersChanged();
    return s;
  }

  function dropSinger(s) {
    const i = S.singers.indexOf(s);
    if (i < 0) return;
    S.singers.splice(i, 1);
    S.voices.splice(i, 1);
    S.voicePicked.splice(i, 1);
    while (S.voices.length < MAX_SINGERS) {
      S.voices.push('original');
      S.voicePicked.push(false);
    }
    if (s.picUrl) URL.revokeObjectURL(s.picUrl);
    s.picUrl = '';
    S.lines = null;
    singersChanged();
  }

  // The voices follow the singers until one is picked: solo the original singer; a duet each animal's own voice,
  // so the two sound different ("two different sounds").
  function singersChanged() {
    const n = S.singers.length;
    S.singers.forEach((s, i) => {
      if (S.voicePicked[i]) return;
      S.voices[i] = n >= 2 ? voiceFor(s.animal) : 'original';
    });
    if (n >= 2 && !S.voicePicked[0] && !S.voicePicked[1] && S.voices[0] === S.voices[1]) S.voices[1] = 'original';
    if (on() && ready()) loadPack();
  }

  const room = () => MAX_SINGERS - S.singers.length;

  function addFiles(fileList) {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return;
    if (files.length > room()) toast(room() ? `Up to 2 singers: the first ${room() === 1 ? 'one is' : 'two are'} in.` : 'Up to 2 singers. Take one out first.');
    files.slice(0, Math.max(0, room())).forEach((file) => {
      const s = newSinger({ from: 'upload', file, animal: guessAnimal(file.name), real: isVideoFile(file), status: 'busy' });
      queueRead(s);
    });
    redraw();
  }

  function queueRead(s) {
    S.reading = S.reading.then(() => readSinger(s)).catch(() => {});
  }

  // The singer's picture: the sharpest moment (a free clip's within its good part), and that moment's time.
  async function readSinger(s) {
    if (!S.singers.includes(s)) return;
    const start = s.entry ? Number(s.entry.start) || 0 : 0;
    const range = s.entry ? [start, start + (Number(s.entry.seconds) || 10)] : null;
    try {
      const got = await picturesFromFile(s.file, 1, 1, range ? { range } : {});
      s.pic = got.pictures[0];
      s.at = isVideoFile(s.file) && got.times ? Math.round(got.times[0] * 100) / 100 : null;
      if (s.picUrl) URL.revokeObjectURL(s.picUrl);
      s.picUrl = URL.createObjectURL(s.pic);
      s.status = 'ready';
    } catch {
      s.status = 'bad';
      if (!S.singers.includes(s)) return;
      dropSinger(s);
      toast(`${s.from === 'library' ? 'That free clip' : `"${(s.file && s.file.name) || 'That video'}"`} can't be opened here. Try another one.`);
    }
    redraw();
    if ($('#singLibrary').open) renderLibrary();
  }

  const LINK = /^https?:\/\/\S+$/i;
  const splitLinks = (text) => String(text || '').split(/(?=https?:\/\/)/i)
    .map((t) => t.trim().split(/\s+/)[0].replace(/[),.;]+$/, ''))
    .filter((t) => LINK.test(t));

  function siteName(url) {
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^(?:www|m|vm|vt)\./, '');
    } catch {
      return 'Link';
    }
    const sites = [[/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'], [/(^|\.)instagram\.com$/, 'Instagram'],
      [/(^|\.)(x\.com|twitter\.com)$/, 'X'], [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook']];
    const hit = sites.find(([re]) => re.test(host));
    return hit ? hit[1] : host;
  }

  function addLinks(text) {
    const urls = splitLinks(text);
    if (urls.length > room()) toast('Up to 2 singers');
    urls.slice(0, Math.max(0, room())).forEach((url) => newSinger({ from: 'link', url, site: siteName(url), animal: guessAnimal(url), real: true }));
    redraw();
    return urls.length;
  }

  function addPainted(animal) {
    if (!room()) {
      toast('Up to 2 singers. Take one out first.');
      return;
    }
    newSinger({ from: 'painted', animal, look: cleanLook($('#singLookIn').value) });
    $('#singLookIn').value = '';
    if (!room()) S.picking = false;
    redraw();
  }

  function swap() {
    if (S.singers.length < 2) return;
    S.singers.push(S.singers.shift());
    S.voices = [S.voices[1], S.voices[0]];
    S.voicePicked = [S.voicePicked[1], S.voicePicked[0]];
    if (S.lines) {
      const flip = { A: 'B', B: 'A', both: 'both' };
      S.lines = Object.fromEntries(Object.entries(S.lines).map(([n, w]) => [n, flip[w] || w]));
    }
    redraw();
  }

  function rename(s, i) {
    const name = prompt(`A name for singer ${i + 1} (optional), e.g. Milo. It goes in the video's title.`, s.name || '');
    if (name === null) return;
    s.name = cleanName(name);
    redraw();
  }

  function relook(s, i) {
    const look = prompt(`How singer ${i + 1} looks (optional), e.g. big brown bear with a gold chain`, s.look || '');
    if (look === null) return;
    s.look = cleanLook(look);
    redraw();
  }

  function pickAnimal(s, value) {
    if (value === 'other') {
      const word = cleanAnimal(prompt('Which animal is it? (one word, e.g. hamster)', '') || '');
      if (word) s.animal = word;
    } else if (value) {
      s.animal = value;
    }
    S.sigs.singers = '';
    singersChanged();
    redraw();
  }

  // ---------- The free clips (worker/library.json, as in Together; the page fetches the clip itself) ----------

  const GROUPS = { dogs: 'Dogs', cats: 'Cats', farm: 'Farm', wild: 'Wild', birds: 'Birds' };

  function loadLibrary() {
    if (S.library) return Promise.resolve(S.library);
    if (!S.libLoading) {
      S.libLoading = fetch('worker/library.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`library ${r.status}`))))
        .then((data) => {
          S.library = (Array.isArray(data.clips) ? data.clips : []).filter((c) => c && c.id && c.url);
          return S.library;
        })
        .finally(() => { S.libLoading = null; });
    }
    return S.libLoading;
  }

  async function openLibrary() {
    openDialog($('#singLibrary'));
    renderLibrary();
    if (S.library) return;
    note($('#singLibNote'), 'Getting the free clips…');
    try {
      await loadLibrary();
      note($('#singLibNote'), S.library.length ? '' : 'No free clips yet.');
    } catch {
      note($('#singLibNote'), "Couldn't get the free clips. Check your internet and try again.", 'bad');
    }
    renderLibrary();
  }

  let webm = null;
  function clipUrl(c) {
    if (webm === null) webm = document.createElement('video').canPlayType('video/webm; codecs="vp9"') !== '';
    if (webm || !/\.webm$/i.test(c.url)) return c.url;
    return c.mov || '';
  }

  function renderLibrary() {
    const clips = S.library || [];
    const order = Object.keys(GROUPS);
    const rank = (g) => (order.includes(g) ? order.indexOf(g) : 99);
    const groups = [...new Set(clips.map((c) => c.group).filter(Boolean))].sort((a, b) => rank(a) - rank(b));
    if (S.libFilter !== 'all' && !groups.includes(S.libFilter)) S.libFilter = 'all';
    chips($('#singLibFilters'), [{ key: 'all', label: 'All' }, ...groups.map((g) => ({ key: g, label: GROUPS[g] || cap(g) }))],
      S.libFilter, (key) => {
        S.libFilter = key;
        renderLibrary();
      });
    $('#singLibFilters').hidden = groups.length < 2;
    const grid = $('#singLibGrid');
    grid.innerHTML = '';
    for (const c of clips.filter((x) => (S.libFilter === 'all' || x.group === S.libFilter) && clipUrl(x))) grid.appendChild(clipCard(c));
    $('#singLibCount').textContent = `${S.singers.length} of 2 singers`;
  }

  function clipCard(c) {
    const picked = S.singers.some((s) => s.from === 'library' && s.id === c.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lib-clip';
    b.dataset.id = c.id;
    b.setAttribute('aria-pressed', String(picked));
    b.innerHTML = '<span class="lib-pic"><span class="lib-tick" aria-hidden="true">✓</span></span>'
      + '<span class="lib-name"></span><span class="lib-meta"><span class="lib-len"></span></span>';
    if (c.poster) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = c.poster;
      img.addEventListener('error', () => img.remove());
      $('.lib-pic', b).prepend(img);
    }
    $('.lib-name', b).textContent = c.label || cap(c.animal || 'Animal');
    $('.lib-len', b).textContent = c.seconds ? `${Math.round(c.seconds)} s` : '';
    b.setAttribute('aria-label', `${c.label || c.animal}${picked ? ' (a singer)' : ''}`);
    b.addEventListener('click', () => toggleClip(c));
    return b;
  }

  function toggleClip(c) {
    const s = S.singers.find((x) => x.from === 'library' && x.id === c.id);
    if (s) dropSinger(s);
    else if (!room()) toast('Up to 2 singers. Take one out first.');
    else addLibrary(c);
    renderLibrary();
    redraw();
  }

  async function addLibrary(c) {
    const s = newSinger({ from: 'library', id: c.id, entry: c, animal: cleanAnimal(c.animal || ''), poster: c.poster || '', real: true, status: 'busy' });
    redraw();
    const url = clipUrl(c);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`clip ${res.status}`);
      const blob = await res.blob();
      if (!S.singers.includes(s)) return;
      const ext = /\.mov$/i.test(url) ? 'mov' : /\.mp4$/i.test(url) ? 'mp4' : 'webm';
      const type = blob.type.startsWith('video/') ? blob.type : { mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm' }[ext];
      s.file = new File([blob], `${c.id}.${ext}`, { type });
    } catch {
      s.status = 'bad';
      if (!S.singers.includes(s)) return;
      dropSinger(s);
      toast("Couldn't get that free clip. Check your internet and try again.");
      redraw();
      if ($('#singLibrary').open) renderLibrary();
      return;
    }
    queueRead(s);
  }

  // ---------- Drawing it (renderOptions ends with Sing.render) ----------

  // Things only Sing hides: shown again when Sing is off (only those it hid).
  const ONLY_SING_HIDES = () => [$('#step2'), $('#step3'), $('#videoSeg').closest('.opt-line'), $('#countSeg').closest('.opt-line'),
    $('#previewLine'), $('#exportHelp'), $('#captionsOpt').closest('.opt-line'), $('#speedSeg').closest('.opt-line'), $('#extras'),
    $('#step4')];
  const OUTDATED_ONLY = ['extras', 'step4']; // (hidden only while the worker can't sing: the update note says why)
  function hideForSing(el) {
    if (!el) return;
    if (!el.hidden) el.dataset.singHid = '1';
    el.hidden = true;
  }
  function showAgain(el) {
    if (el && el.dataset.singHid) {
      el.hidden = false;
      delete el.dataset.singHid;
    }
  }

  function render() {
    if (S.saved && S.on && outdated()) { // remembered from an earlier visit, but this worker can't sing: One animal
      S.on = false;
      S.saved = false;
    }
    const s = on();
    const btn = $('#singModeBtn');
    btn.hidden = !allowed();
    $('#singNeed').hidden = !outdated();
    $('#singNeed').textContent = rebuildNeeded() ? 'Rebuild needed' : 'Update needed';
    if (btn.hidden === false && $('#modeSeg').hidden && allowed()) $('#modeSeg').hidden = false;
    if (s) $('#modeSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === 'sing')));
    else btn.setAttribute('aria-pressed', 'false');
    $('#singBox').hidden = !s;
    $('#singSongStep').hidden = !s || outdated();
    $('#singStageStep').hidden = !s || outdated();
    if (!s) {
      ONLY_SING_HIDES().forEach(showAgain);
      return;
    }
    ONLY_SING_HIDES().forEach((el) => (el && OUTDATED_ONLY.includes(el.id) && !outdated() ? showAgain(el) : hideForSing(el)));
    $('#oneBox').hidden = true;
    $('#castBox').hidden = true;
    $('#ideasBox').hidden = true;
    $('#lookLine').hidden = true;
    $('#step1Title').textContent = 'Who sings';
    $('#singUpdate').hidden = !outdated();
    if (outdated()) {
      $('#singUpdate span').textContent = rebuildNeeded()
        ? "Your worker is up to date, but its singing part didn't install. Rebuild it (about 10–20 min): your videos stay."
        : 'Your worker needs an update for Sing videos (about 10–20 min, once).';
      $('#singUpdateBtn').textContent = rebuildNeeded() ? 'Rebuild my worker' : 'Update my worker';
    }
    $('#singWho').hidden = outdated();
    if (outdated()) return;
    if (ready()) {
      if (!gpu() && !S.gpuLoading) loadGpu();
      settleSong();
      if (S.songId) loadPack();
    }
    renderSingers();
    renderSong();
    renderStage();
    renderExtras(); // (together.js shows the Animal line again on each draw)
    $('#step1').classList.toggle('done', S.singers.length > 0 && !S.singers.some((x) => x.status === 'busy'));
  }

  function renderSingers() {
    const sig = JSON.stringify([S.singers.map((s) => [s.key, s.status, s.animal, s.name, s.look, Boolean(s.picUrl)]), S.picking, S.more]);
    const full = !room();
    $('#singFile').disabled = full;
    $('#singFileTile').classList.toggle('off', full);
    for (const id of ['singLinkBtn', 'singLibBtn', 'singPickBtn']) $(`#${id}`).disabled = full;
    $('#singLibBtn').hidden = known() && !canDo('library');
    $('#singPickBtn').setAttribute('aria-expanded', String(S.picking && !full));
    $('#singPick').hidden = !S.picking || full;
    $('#singTools').hidden = S.singers.length < 2;
    $('#singCount').textContent = S.singers.length === 2 ? 'A duet: 1 is on the left, 2 on the right' : '';
    if (sig === S.sigs.singers) return;
    S.sigs.singers = sig;
    const row = $('#singRow');
    row.innerHTML = '';
    S.singers.forEach((s, i) => row.appendChild(singerTile(s, i)));
    if (!full) {
      const add = document.createElement('label');
      add.className = 'slot slot-add';
      add.htmlFor = 'singFile';
      add.innerHTML = '<span class="slot-pic"><span class="slot-plus" aria-hidden="true">+</span><span class="slot-what"></span></span>';
      $('.slot-what', add).textContent = S.singers.length ? 'Add a 2nd singer (a duet)' : 'Add the singer';
      row.appendChild(add);
    }
    const box = $('#singAnimals');
    box.innerHTML = '';
    const list = S.more ? ANIMALS : ANIMALS.slice(0, FIRST_ANIMALS);
    for (const [a, emoji] of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.animal = a;
      b.innerHTML = '<span aria-hidden="true"></span>';
      $('span', b).textContent = emoji;
      b.append(` ${cap(a)}`);
      box.appendChild(b);
    }
    if (!S.more) {
      const more = document.createElement('button');
      more.type = 'button';
      more.dataset.more = '1';
      more.textContent = 'More…';
      box.appendChild(more);
    }
  }

  function singerTile(s, i) {
    const tile = document.createElement('div');
    tile.className = `slot from-${s.from === 'painted' ? 'surprise' : s.from}${s.status === 'busy' ? ' busy' : ''}`;
    tile.dataset.i = String(i);
    const pic = document.createElement('div');
    pic.className = 'slot-pic';
    const src = s.picUrl || s.poster;
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      pic.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'slot-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = s.from === 'link' ? '🔗' : s.from === 'painted' ? EMOJI[s.animal] || '🎨' : '🎬';
      const what = document.createElement('span');
      what.className = 'slot-what';
      what.textContent = s.from === 'link' ? s.site : s.from === 'painted' ? (s.look ? `Painted: ${s.look}` : 'Painted by AI') : '';
      pic.append(icon, what);
    }
    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = String(i + 1);
    num.setAttribute('aria-hidden', 'true');
    pic.appendChild(num);
    if (s.status === 'busy') {
      const busy = document.createElement('span');
      busy.className = 'slot-busy';
      busy.textContent = s.from === 'library' && !s.file ? 'Getting it…' : 'Reading…';
      pic.appendChild(busy);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'slot-x';
    x.textContent = '✕';
    x.setAttribute('aria-label', `Take out singer ${i + 1}`);
    pic.appendChild(x);
    tile.appendChild(pic);
    const role = document.createElement('span');
    role.className = 'slot-role';
    role.textContent = S.singers.length >= 2 ? (i === 0 ? 'Left' : 'Right') : 'The singer';
    tile.appendChild(role);
    tile.appendChild(animalMenu(s, i));
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'link-btn slot-name';
    name.textContent = s.name ? `✎ ${s.name}` : '✎ Name';
    name.setAttribute('aria-label', s.name ? `Name of singer ${i + 1}: ${s.name}. Change it` : `Give singer ${i + 1} a name`);
    tile.appendChild(name);
    if (s.from === 'painted') {
      const look = document.createElement('button');
      look.type = 'button';
      look.className = 'link-btn slot-name slot-look';
      look.textContent = s.look ? '✎ Its look' : '✎ Add a look';
      look.setAttribute('aria-label', `How singer ${i + 1} looks`);
      tile.appendChild(look);
    }
    return tile;
  }

  function animalMenu(s, i) {
    const sel = document.createElement('select');
    sel.className = 'slot-animal';
    sel.setAttribute('aria-label', `Animal of singer ${i + 1}`);
    const add = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    };
    if (!s.animal) add('', 'Animal?');
    if (s.animal && !ANIMAL_IDS.includes(s.animal)) add(s.animal, cap(s.animal));
    for (const a of ANIMAL_IDS) add(a, cap(a));
    if (s.from !== 'painted') add('other', 'Other…');
    sel.value = s.animal || '';
    return sel;
  }

  // ---------- Step 2: the song ----------

  function renderSong() {
    const list = songList();
    const row = $('#singSongs');
    const sig = JSON.stringify([list.map((s) => [s.id, s.name, s.default]), S.songId, S.ownSong && S.ownSong.name, S.adding,
      isGuest(), S.hearing, preview.paused]);
    if (sig !== S.sigs.songs) {
      S.sigs.songs = sig;
      row.innerHTML = '';
      // The known song, when it isn't in My songs: one tap adds the owner's own copy.
      if (owner() && songsOn()) {
        for (const k of KNOWN_SONGS) {
          if (list.some((s) => knownOf(s) === k)) continue;
          const tile = document.createElement('div');
          tile.className = 'voice song-tile sing-known';
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'voice-name';
          b.dataset.known = k.name;
          b.textContent = S.adding === k.name ? `♪ ${k.title} · adding…` : `♪ ${k.title} · ${k.artist} · Add your copy`;
          b.disabled = Boolean(S.adding);
          tile.appendChild(b);
          row.appendChild(tile);
        }
      }
      for (const s of list) {
        const picked = !S.ownSong && s.id === S.songId;
        const tile = document.createElement('div');
        tile.className = 'voice song-tile';
        tile.classList.toggle('on', picked);
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'voice-name';
        pick.dataset.songPick = s.id;
        pick.textContent = `♪ ${s.name}`;
        pick.title = s.name;
        pick.setAttribute('aria-pressed', String(picked));
        const hear = document.createElement('button');
        hear.type = 'button';
        hear.className = 'hear sing-hear';
        hear.dataset.songHear = s.id;
        const key = `song:${s.id}`;
        hear.textContent = hearingNow(key) ? '■' : '▶';
        hear.setAttribute('aria-label', `${hearingNow(key) ? 'Stop' : 'Hear'} ${s.name}`);
        tile.append(pick, hear);
        row.appendChild(tile);
      }
      if (S.ownSong) {
        const tile = document.createElement('div');
        tile.className = 'voice song-tile on';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'voice-name';
        b.dataset.own = '1';
        b.textContent = `♪ ${S.ownSong.name}`;
        b.setAttribute('aria-pressed', 'true');
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'hear sing-hear';
        x.dataset.ownClear = '1';
        x.textContent = '✕';
        x.setAttribute('aria-label', 'Take out your song');
        tile.append(b, x);
        row.appendChild(tile);
      }
    }
    // (the button works before the list arrives: adding doesn't need it)
    $('#singAddSong').hidden = !(owner() && canDo('songs') && !state.keyRefused && list.length < SONG_MAX);
    $('#singOwnSong').hidden = !isGuest();
    const p = pack();
    const songNote = $('#singSongNote');
    let text = '';
    let bad = false;
    if (!state.worker) {
      text = 'Your songs show here once your worker is set up: tap Make it to set it up.';
    } else if (state.keyRefused) {
      text = "This device's connection to your worker is out of date: open your app link here (see the note at the top).";
      bad = true;
    } else if (canDo('songs') && !Array.isArray(state.songs) && !S.ownSong) {
      text = songsWaitText(); // (on its way, or why not; it keeps trying)
      bad = Boolean(state.songsError);
    } else if (!songsOn() && !S.ownSong) {
      text = known() ? 'Your worker needs an update for songs.' : 'Getting your songs…';
    } else if (!list.length && !S.ownSong) {
      text = isGuest() ? `${hostName()} has no songs yet. Pick your own song file.` : 'Add a song: any song file of yours. antics finds its singing by itself.';
    } else if (S.ownSong) {
      text = 'Your song gets ready for singing first (about 3 min). It stays with this video only.';
    } else if (p && GETTING.includes(p.state)) {
      const pct = Number.isFinite(p.progress) ? ` ${Math.round(p.progress * 100)}%` : '';
      text = `Getting ${titleNow()} ready for singing (voice, music and lines, about 3 min, once)…${pct}`;
    } else if (p && p.state === 'failed') {
      text = `Couldn't get ${titleNow()} ready for singing${p.error ? `: ${p.error}` : ''}. Try another song.`;
      bad = true;
    } else if (p && p.state === 'ready' && p.split === 'quick' && canDo('sing_best') && ['queued', 'working'].includes(p.best)) {
      text = 'Ready to sing. A sharper split of the voice is still being made in the background (about 30 min, once).';
    }
    note(songNote, nb(text), bad ? 'bad' : '');
    songNote.classList.add('fine');
    // The part, with the real seconds of this song
    const seg = $('#singPartSeg');
    if (!partsShown().some((x) => x.id === S.part)) S.part = 'meme';
    seg.innerHTML = '';
    for (const x of partsShown()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = x.id;
      b.setAttribute('aria-pressed', String(x.id === S.part));
      b.innerHTML = '<b></b><small></small>';
      $('b', b).textContent = x.name;
      const info = partInfo(x.id);
      $('small', b).textContent = info ? (x.id === 'whole' ? clock(info.seconds) : `${Math.round(info.seconds)} s`) : x.guess;
      seg.appendChild(b);
    }
    const info = partInfo();
    $('#singHearPart').hidden = !info || !S.songId || Boolean(S.ownSong);
    $('#singHearPart').textContent = hearingNow(`part:${S.songId}`) ? '■ Stop' : '▶ Hear this part';
    $('#singPartTimes').textContent = info ? `${clock(info.from)} → ${clock(info.to)}${testMode() ? ' · the test sings its first 5 s' : ''}` : '';
    $('#singNoSinging').hidden = !(info && Number(info.sung) < 0.5);
    const lines = timeLines();
    $('#singTime').hidden = !lines.length;
    const ul = $('#singTimeLines');
    ul.textContent = '';
    for (const l of lines) {
      const li = document.createElement('li');
      li.textContent = nb(l);
      ul.appendChild(li);
    }
  }

  async function addKnown(file) {
    const k = KNOWN_SONGS.find((x) => x.name === S.adding) || KNOWN_SONGS[0];
    if (!file || !state.worker) {
      S.adding = '';
      redraw();
      return;
    }
    if (file.size > SONG_MB * 1024 * 1024) {
      S.adding = '';
      toast(`That file is over ${SONG_MB} MB. Try the MP3.`);
      redraw();
      return;
    }
    redraw();
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', k.name);
      const saved = await api('/songs', { method: 'POST', body: form });
      state.songs = [...(state.songs || []).filter((x) => x.id !== saved.id), saved];
      S.songId = saved.id;
      S.songPicked = true;
      toast(nb(`Added. Getting ${k.title} ready for singing (about 3 min, once).`));
      loadSongs();
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message);
    } finally {
      S.adding = '';
      $('#singKnownFile').value = '';
      loadPack(true);
      redraw();
    }
  }

  function pickSongTile(id) {
    S.songId = id;
    S.songPicked = true;
    S.ownSong = null;
    S.lines = null;
    stopHearing();
    loadPack();
    redraw();
  }

  // ▶ for the part (and a song tile's ▶): the song from the part's start to its end.
  function hearingNow(key) {
    return S.hearing === key && !preview.paused && preview.src === S.hearingUrl;
  }

  function stopHearing() {
    if (S.hearing && preview.src === S.hearingUrl) preview.pause();
    S.hearing = '';
  }

  function hearPart(id, key) {
    if (hearingNow(key)) {
      stopHearing();
      redraw();
      return;
    }
    const s = songList().find((x) => x.id === id);
    if (!s) return;
    const info = id === S.songId ? partInfo() : null;
    const from = info ? info.from : s.start || 0;
    const seconds = info ? Math.min(60, info.seconds) : 15;
    const url = songAudioUrl(id);
    playSong(url, from, seconds);
    S.hearing = key;
    S.hearingUrl = preview.src;
    redraw();
  }

  // ▶ for a voice: about 4 s of this singer's first line in that voice, made by the worker.
  function hearVoice(i, v) {
    const key = `voice:${i}:${v}`;
    if (hearingNow(key)) {
      stopHearing();
      redraw();
      return;
    }
    if (!S.songId || S.ownSong || !state.worker) return;
    const lines = linesIn();
    const info = partInfo();
    const mine = duet() ? lines.filter((l, k) => whoOfLine(l, k) === (i === 0 ? 'A' : 'B') || whoOfLine(l, k) === 'both') : lines;
    const at = mine.length ? Math.max(mine[0].start, info ? info.from : 0) : info ? info.from : (song() && song().start) || 0;
    const url = `${state.worker.url}/songs/${encodeURIComponent(S.songId)}/voice?v=${v}&at=${at.toFixed(1)}&key=${encodeURIComponent(state.worker.key)}`;
    playSong(url, 0, 5);
    S.hearing = key;
    S.hearingUrl = preview.src;
    preview.addEventListener('error', () => {
      if (S.hearing === key) {
        S.hearing = '';
        toast("Couldn't play that voice. Try again in a moment.");
        redraw();
      }
    }, { once: true });
    redraw();
  }

  // ---------- Step 3: the stage, who sings what, the voices ----------

  // Who sings a line, by the rule: 'turns' (line by line in turn, both on the chorus: the owner's default),
  // 'both' (sing_audio's verse_chorus: a verse each, in turn, both on every chorus), or the chosen lines.
  function whoOfLine(line, index) {
    if (!duet()) return 'A';
    if (S.lines && S.lines[line.n]) return S.lines[line.n];
    return (S.who === 'both' ? versesOf(linesIn()) : turnsOf(linesIn()))[index] || 'A';
  }

  const together = (l) => /^(?:chorus|hook)$/.test(l.kind || '');

  function turnsOf(lines) {
    let turn = 0;
    return lines.map((l) => {
      if (together(l)) return 'both';
      const who = turn % 2 ? 'B' : 'A';
      turn++;
      return who;
    });
  }

  // A verse each: the pack's sections say which verse a line is in (their n, else their order); without sections,
  // line by line.
  function versesOf(lines) {
    const sections = (pack() && pack().sections) || [];
    const verses = sections.filter((s) => !/^(?:chorus|hook)$/.test(s.kind || ''));
    return lines.map((l, k) => {
      if (together(l)) return 'both';
      const sec = verses.find((s) => l.start >= s.start - 0.05 && l.start < s.end);
      if (!sec) return k % 2 ? 'B' : 'A';
      const n = Number.isFinite(sec.n) ? sec.n - 1 : verses.indexOf(sec);
      return n % 2 ? 'B' : 'A';
    });
  }

  function renderStage() {
    const looks = $('#singLooks');
    const sig = JSON.stringify([S.look]);
    if (sig !== S.sigs.looks) {
      S.sigs.looks = sig;
      looks.innerHTML = '';
      for (const l of LOOKS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scene-card';
        b.dataset.look = l.id;
        b.setAttribute('aria-pressed', String(l.id === S.look));
        b.innerHTML = '<span class="scene-emoji" aria-hidden="true"></span><span class="scene-name"></span>';
        $('.scene-emoji', b).textContent = l.emoji;
        $('.scene-name', b).textContent = l.name;
        looks.appendChild(b);
      }
    }
    setSeg('singShotsSeg', shotsNow());
    $('#singShotsSeg [data-v="one"]').disabled = !oneShotOk();
    $('#singShotsSub').textContent = oneShotOk() ? 'One shot: one long take on your PC' : 'New angles on the lines, cut on the beat';
    // Who sings what (a duet)
    $('#singWhoBox').hidden = !duet();
    if (duet()) {
      const seg = $('#singWhoSeg');
      const now = S.lines ? 'lines' : S.who;
      const items = [['turns', 'Take turns', 'line by line · both on the chorus'], ['both', 'Verse by verse', 'a verse each · both on the chorus'],
        ['lines', 'Choose lines…', 'you pick each one']];
      seg.innerHTML = '';
      for (const [v, name, sub] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.v = v;
        b.setAttribute('aria-pressed', String(v === now));
        b.innerHTML = '<b></b><small></small>';
        $('b', b).textContent = name;
        $('small', b).textContent = sub;
        if (v === 'lines') b.disabled = !packReady();
        seg.appendChild(b);
      }
      const n = S.lines ? Object.values(S.lines).filter((w) => w === 'both').length : 0;
      $('#singWhoHelp').textContent = nb(S.lines ? `Your own split${n ? ` (${plural(n, 'line')} together)` : ''}. Lines they sing together show both of them.`
        : 'Lines they sing together show both of them on the stage.');
    }
    renderVoices();
  }

  function renderVoices() {
    const box = $('#singVoices');
    const list = S.singers.length ? S.singers : [{ animal: '', from: '' }];
    const canHear = Boolean(S.songId && !S.ownSong && packReady() && pack().voices !== false);
    const sig = JSON.stringify([list.map((s) => [s.animal, s.name]), S.voices, S.hearing, preview.paused, canHear, voicesOk()]);
    if (sig !== S.sigs.voices) {
      S.sigs.voices = sig;
      box.innerHTML = '';
      list.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'sing-voice-row';
        const who = document.createElement('p');
        who.className = 'sing-voice-who';
        who.textContent = list.length > 1 ? `${i + 1} · ${s.name || animalWord(s)}` : s.animal ? `${s.name || animalWord(s)} sings with` : 'The singer sings with';
        row.appendChild(who);
        const tiles = document.createElement('div');
        tiles.className = 'sing-voice-tiles';
        for (const v of VOICES) {
          const tile = document.createElement('div');
          tile.className = 'voice sing-voice';
          tile.classList.toggle('on', S.voices[i] === v.id);
          tile.dataset.i = String(i);
          tile.dataset.voice = v.id;
          const pick = document.createElement('button');
          pick.type = 'button';
          pick.className = 'voice-name';
          pick.dataset.pickVoice = v.id;
          pick.setAttribute('aria-pressed', String(S.voices[i] === v.id));
          pick.disabled = v.id !== 'original' && !voicesOk();
          pick.innerHTML = '<span></span><small></small>';
          $('span', pick).textContent = v.name;
          $('small', pick).textContent = v.sub;
          const hear = document.createElement('button');
          hear.type = 'button';
          hear.className = 'hear sing-hear';
          hear.dataset.hearVoice = v.id;
          const key = `voice:${i}:${v.id}`;
          hear.textContent = hearingNow(key) ? '■' : '▶';
          hear.disabled = !canHear;
          hear.setAttribute('aria-label', `${hearingNow(key) ? 'Stop' : 'Hear'} the ${v.name.toLowerCase()} voice${list.length > 1 ? ` for singer ${i + 1}` : ''}`);
          tile.append(pick, hear);
          tiles.appendChild(tile);
        }
        row.appendChild(tiles);
        box.appendChild(row);
      });
    }
    const changed = S.voices.slice(0, list.length).some((v) => v !== 'original');
    $('#singVoiceHelp').textContent = !voicesOk() ? 'Other voices need the song\'s voice split: your worker makes it with the update.'
      : !canHear && S.songId && !S.ownSong ? 'Tap ▶ to hear a voice once the song is ready for singing.'
        : changed ? 'Changed voices stay only when you post with the song inside.' : 'Tap ▶ to hear 4 s of each voice.';
  }

  // ---------- Extras (renderExtras ends with Sing.renderExtras) ----------

  let openingText = null;
  function renderExtras() {
    const s = on() && !outdated();
    $('#singTitleLine').hidden = !s;
    $('#singZoomLine').hidden = !s;
    if (openingText === null) openingText = $('#openingLine > span').firstChild.textContent;
    $('#openingLine > span').firstChild.textContent = s ? 'Real → AI start' : openingText;
    if (!s) return;
    for (const id of ['voiceLine', 'voicePick', 'memeLine']) $(`#${id}`).hidden = true;
    $('#animalOpt').closest('.opt-line').hidden = true;
    $('#singTitleOpt').checked = S.title;
    $('#singZoomOpt').checked = S.zooms;
    $('#openingLine small').textContent = noRealVideo() ? 'Needs a singer from a video' : 'Your real clip first, the song already playing';
    const list = [];
    if (extraOn('opening')) list.push('Real start');
    if (extraOn('outro')) list.push('Follow me');
    if (S.title) list.push('Song title');
    if (S.zooms) list.push('Beat zooms');
    if (state.brand && !isGuest()) list.push(`@${BRAND.name}`);
    $('#extrasSum').textContent = list.length ? list.join(' · ') : 'All off';
  }

  // ---------- Step 4 (renderMake ends with Sing.renderMake) ----------

  function renderMake() {
    const s = on();
    $('#singMake').hidden = !s || outdated();
    if (!s) return;
    hideForSing($('#previewLine'));
    hideForSing($('#exportHelp'));
    const btn = $('#makeBtn');
    const test = testMode();
    const bad = owner() && allBad();
    $('#singTest').hidden = !test;
    $('#singAllBad').hidden = !bad;
    if (test) {
      const id = testEngine();
      $('#singTestWhy').textContent = nb((S.retest && (anyGood() || pcGood()) ? 'A new 5-second test: its result replaces the old one for that AI.'
        : "Nobody knows yet how well each AI sings with your animal, so your first Sing video is a 5-second test. If the mouth doesn't sing, one tap tries the next one.")
        + (duet() ? ' The test sings with singer 1 only.' : ''));
      chips($('#singTestEngines'), testable().map((x) => ({ key: x, label: `${engineName(x)}${stateMark(x)}` })), id, (key) => {
        S.test = key;
        renderMake();
      });
      $('#singTestEngines').querySelectorAll('button').forEach((b) => {
        b.disabled = b.dataset.key === 'P' && !pcCan();
      });
      $('#singTestCost').textContent = nb(testCost(id));
    }
    // Who makes it: online, my PC, both (the PC only when the helper can sing)
    const pc = pcOk() && !test;
    $('#singEngineLine').hidden = !pc;
    if (pc) {
      const seg = $('#singEngineSeg');
      const now = engineNow();
      const items = [['online', 'Online', 'your GPU time'], ['pc', 'My PC', 'at night'], ['both', 'Both', 'fastest']];
      seg.innerHTML = '';
      for (const [v, name, sub] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.v = v;
        b.setAttribute('aria-pressed', String(v === now));
        b.innerHTML = '<b></b><small></small>';
        $('b', b).textContent = name;
        $('small', b).textContent = sub;
        seg.appendChild(b);
      }
    }
    $('#singSharpLine').hidden = !(pc && engineNow() !== 'online');
    setSeg('singSharpSeg', S.sharp);
    $('#singDraftLine').hidden = test || isGuest();
    $('#singDraftOpt').checked = draftNow();
    $('#singCost').textContent = nb(test ? '' : costLine());
    $('#singCost').hidden = test;
    if (sending) return; // (while it's being sent, the button says how that is going)
    const out = isGuest() && state.me && state.me.uses_left <= 0;
    if (out) return; // (app.js: "No videos left")
    btn.disabled = false;
    if (outdated()) btn.textContent = rebuildNeeded() ? 'Rebuild my worker first' : 'Update my worker first';
    else if (preparing()) {
      btn.textContent = `Getting ${titleNow()} ready…`;
      btn.disabled = true;
    } else if (bad || friendBlocked()) {
      btn.textContent = 'Not ready to sing yet';
      btn.disabled = true;
    } else if (test) btn.textContent = 'Make the 5-second test';
    else if (draftNow()) btn.textContent = 'Make a preview';
    else btn.textContent = 'Make the music video';
    if (friendBlocked()) note($('#note'), `Singing isn't ready yet: ${hostName()} makes the first test video first.`);
    else if ($('#note').textContent.startsWith("Singing isn't ready yet")) note($('#note'), '');
  }

  const stateMark = (id) => {
    const st = (engines()[id] || {}).state;
    return st === 'good' ? ' ✓' : st === 'bad' ? ' ✕' : '';
  };

  // ---------- Making it ----------

  function nudge(sel) {
    const el = $(sel);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('nudge');
    void el.offsetWidth;
    el.classList.add('nudge');
  }

  async function make() {
    const msg = $('#note');
    if (outdated()) {
      note(msg, needText(), 'bad');
      nudge('#step1');
      return;
    }
    if (!state.worker) { // (set up first, then it is sent)
      submit({ kind: 'sing' });
      return;
    }
    if (!S.singers.length) {
      note(msg, 'Pick who sings first (step 1): your video or photo, a free clip, or Pick an animal.', 'bad');
      nudge('#step1');
      return;
    }
    if (!S.songId && !S.ownSong) {
      note(msg, isGuest() ? 'Pick a song first (step 2).' : 'Add a song first (step 2, + Add a song).', 'bad');
      nudge('#singSongStep');
      return;
    }
    if (ready() && !gpu()) await loadGpu();
    const p = pack();
    if (p && p.state === 'preparing') {
      note(msg, nb(`${cap(titleNow())} is still getting ready for singing (about 3 min, once). Try again then.`));
      return;
    }
    if (p && p.state === 'failed') {
      note(msg, `Couldn't get ${titleNow()} ready for singing. Pick another song.`, 'bad');
      nudge('#singSongStep');
      return;
    }
    const info = partInfo(testMode() ? 'meme' : S.part);
    if (info && Number(info.sung) < 0.5) {
      note(msg, 'No singing found in this part. Pick another part.', 'bad');
      nudge('#singSongStep');
      return;
    }
    if (friendBlocked()) {
      note(msg, `Singing isn't ready yet: ${hostName()} makes the first test video first.`, 'bad');
      return;
    }
    if (owner() && allBad()) {
      note(msg, "The AI can't make this animal sing well yet. Tap Dance to the song instead.", 'bad');
      return;
    }
    submit({ kind: 'sing' });
  }

  async function settled(s, n) {
    for (let i = 0; i < 600 && s.status === 'busy' && S.singers.includes(s); i++) await sleep(200);
    if (s.status === 'busy' && S.singers.includes(s)) throw new Error(`Singer ${n} is still loading. Try again in a moment.`);
  }

  function videoExt(file) {
    const m = /\.(mp4|mov|webm|m4v)$/i.exec(file.name || '');
    if (m) return m[1].toLowerCase();
    return { 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' }[file.type] || 'mp4';
  }

  // About 6 s of a big video around its picked moment (2 s before, 4 s after), as small JPEGs (as in Together).
  async function framesAround(file, at) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.src = url;
    try {
      await waitFor(video, 'loadeddata');
      try {
        await video.play();
        video.pause();
      } catch {
        // seeking still works
      }
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const from = Math.max(0, Math.min(at - 2, dur - 6));
      const to = Math.min(dur, from + 6);
      const frames = [];
      frames.from = from;
      for (let t = from; t < to - 0.001; t += 1 / FRAME_FPS) {
        video.currentTime = t;
        await waitFor(video, 'seeked', 8000);
        const canvas = drawScaled(video, video.videoWidth, video.videoHeight, 720);
        frames.push(await new Promise((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error('frame'))), 'image/jpeg', 0.8)));
      }
      return frames;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // The who field: 'turns', 'both', or the lines chosen one by one.
  function whoField() {
    if (!S.lines) return S.who;
    return JSON.stringify(linesIn().map((l, k) => ({ line: l.n, who: whoOfLine(l, k) })));
  }

  // The Sing fields of POST /jobs (see the top of this file). Called by app.js's submit.
  async function addSing(form, btn) {
    if (!ready()) await refreshHealth();
    if (!state.health) throw Object.assign(new Error('Your worker is waking up'), { waking: true });
    if (!ready()) throw new Error(rebuildNeeded() ? REBUILD_SING : 'Your worker needs an update for Sing videos: tap ⚙, then Update my worker (about 10–20 min, once).');
    const waiting = [...S.singers];
    for (let i = 0; i < waiting.length; i++) {
      btn.textContent = `Getting singer ${i + 1} of ${waiting.length}…`;
      await settled(waiting[i], i + 1);
    }
    const list = [...S.singers];
    if (!list.length) throw new Error('Pick who sings first (step 1).');
    const singers = [];
    const files = [];
    let fps = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const entry = { from: s.from, animal: s.animal || '' };
      if (s.name) entry.name = s.name;
      if (s.from === 'painted') {
        entry.animal = s.animal || 'bear';
        if (s.look) entry.look = s.look;
      }
      if (s.from === 'link') entry.url = s.url;
      if (s.from === 'library') entry.id = s.id;
      if (s.from === 'upload' || s.from === 'library') {
        if (!s.pic) throw new Error(`Singer ${i + 1} isn't ready. Take it out (✕) and add it again.`);
        files.push([s.pic, `p${i}.jpg`]);
        if (s.file && isVideoFile(s.file) && s.at !== null && s.at !== undefined) {
          entry.at = s.at;
          if (s.file.size <= VIDEO_MAX) {
            files.push([s.file, `v${i}.${videoExt(s.file)}`]);
          } else {
            btn.textContent = `Getting singer ${i + 1} of ${list.length}…`;
            const frames = await framesAround(s.file, s.at);
            frames.forEach((f, k) => files.push([f, `f${i}_${String(k).padStart(3, '0')}.jpg`]));
            entry.real_at = Math.round((s.at - frames.from) * 100) / 100;
            fps = FRAME_FPS;
          }
        }
      }
      singers.push(entry);
    }
    const test = testMode();
    const engine = test ? (testEngine() === 'P' ? 'pc' : 'online') : engineNow();
    form.set('count', '1'); // (one Sing video a tap)
    form.set('draft', String(draftNow()));
    form.set('captions', 'false'); // (no text on a sung video: never the lyrics)
    form.set('meme', 'false'); // (no sound effects over a song: beat zooms instead)
    if (form.has('voice')) form.set('voice', 'off'); // (the song is the voice)
    form.delete('song');
    if (S.ownSong) {
      form.set('music', 'upload');
      form.append('song', S.ownSong);
    } else {
      form.set('music', 'mysong');
      form.set('song_id', S.songId);
    }
    form.append('mode', 'sing');
    form.append('singers', JSON.stringify(singers));
    files.forEach(([blob, name]) => form.append('cast_files', blob, name));
    if (fps) form.append('real_fps', String(fps));
    form.append('part', test ? 'meme' : S.part);
    form.append('look', S.look);
    form.append('shots', shotsNow());
    if (duet()) form.append('who', whoField());
    form.append('voices', JSON.stringify(S.voices.slice(0, list.length)));
    form.append('engine', engine);
    if (engine !== 'online') form.append('sharp', S.sharp);
    form.append('test', String(test));
    if (test) form.append('test_engine', testEngine());
    form.append('title_on', String(S.title));
    form.append('beat_zooms', String(S.zooms));
    btn.textContent = 'Sending…';
  }

  // Sent: the singers stay (the same pets with another song is one tap away); a test says what comes next.
  function sent(made, missing = []) {
    const job = made && made[0];
    if (job && job.test) {
      S.retest = false;
      S.test = null;
      toast(`Your 5-second test is on the way (about 5 min${job.engine === 'pc' ? ' once your PC is on' : ''}). It asks you one question when it's ready.${missing.length ? ` (without ${missing.join(' and ')})` : ''}`);
    }
    loadGpu(true);
  }

  // ---------- The job card ----------

  const clockAt = (job) => (job.retry_at ? timeOf(job.retry_at) : 'in a moment');
  const doneShots = (job) => (Number.isFinite(job.shots_done) ? job.shots_done : (job.shots || []).filter((x) => x.done).length);
  const totalShots = (job) => (Number.isFinite(job.shots_total) ? job.shots_total : (job.shots || []).length);
  const readyParts = (job) => (job.posts || []).filter((p) => p.ready);
  const series = (job) => (job.posts || []).length > 1;
  // Watch so far: the worker joins the shots sung from the start with no gap (cutaways cost nothing: they are always
  // there), also while the first version is still being sung (it has no finished video yet: has_video is false).
  const soFarShots = (job) => {
    let n = 0;
    for (const x of job.shots || []) {
      if (x.kind === 'cutaway') continue;
      if (!x.done) break;
      n++;
    }
    return n;
  };
  const canWatchSoFar = (job) => !job.test && job.status !== 'done' && job.status !== 'failed' && (soFarShots(job) > 0 || Boolean(job.has_video));

  function dayWord(sec) {
    if (!sec) return 'later';
    const at = new Date(sec * 1000);
    const now = new Date();
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(at) - day(now)) / 86400000);
    return diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : at.toLocaleDateString([], { weekday: 'long' });
  }

  // Why a job waits (the worker's sing_wait): 'quota' (out of free time, or of Sing's share), 'pc' (for the PC to be
  // on), 'pc_singing' (the PC is singing one of its shots now), 'unreadable' (the free time can't be read, so no AI
  // call is made), 'starting' (the worker is starting), 'guard' (no GPU guard yet), 'song', 'owner', 'busy'.
  const NOT_QUOTA = ['pc', 'pc_singing', 'unreadable', 'starting', 'guard', 'song', 'owner', 'busy', 'stopped'];
  const quotaWait = (job) => !NOT_QUOTA.includes(job.sing_wait) && !['unreadable', 'stopped'].includes(job.gpu_wait)
    && (job.sing_wait === 'quota' || job.gpu_wait === 'quota' || /out of (?:free |today'?s )?(?:ai |gpu )?time|quota/i.test(job.stage || ''));
  const noCheckWait = (job) => ['unreadable', 'starting', 'guard'].includes(job.sing_wait) || job.gpu_wait === 'unreadable';
  const testName = (job) => job.test_engine_name || engineName(job.test_engine || 'L1');
  // The test's answer: 'good', 'bad', 'all_bad'; null while it waits for one (the worker says 'asking' once the clip
  // is ready).
  const testState = (job) => (job.test_state && job.test_state !== 'asking' ? job.test_state : null);
  // The AI "No, try another" goes to: the worker's test_next, never the one just tested or one tried already
  // (until its verdict, the AI being tested still counts as untested in the worker's table).
  function testNext(job) {
    const tried = new Set([job.test_engine, ...testClips(job).map((c) => c.engine)]);
    const next = job.test_next || null;
    if (next && !tried.has(next.engine || next.id)) return next;
    if (!next && job.test_next === null && testState(job)) return null;
    const id = TEST_ORDER.find((x) => !tried.has(x) && engines()[x] && engines()[x].state === 'untested' && (x !== 'P' || job.test_pc || pcCan()));
    return id ? { engine: id, name: engineName(id) } : null;
  }
  const testClips = (job) => job.test_clips || [];

  function stageText(job) {
    const title = songTitle(job.song_name);
    const done = doneShots(job);
    const total = totalShots(job);
    if (job.sing_wait === 'song' || ((job.status === 'queued' || job.status === 'working') && GETTING.includes(job.pack))) {
      return `Getting ${title} ready for singing (voice, music and lines, about 3 min, once)…`;
    }
    if (job.status === 'waiting') {
      if (job.picture_check) return `Here are the stage pictures. Singing starts by itself at ${clockAt(job)}.`;
      if (job.gpu_wait === 'stopped') {
        return isGuest() ? `Paused for now. It goes on once ${hostName()} checks their worker.`
          : 'AI work is stopped: Hugging Face started charging your credits. Tap Resume in Settings to go on.';
      }
      if (job.sing_wait === 'pc_singing') { // (the worker says which shot: "Your PC is singing shot 3 of 7 …")
        if (isGuest()) return `${hostName()}'s PC is singing it now. It goes on by itself.`;
        return job.stage || `Your PC is singing shot ${done + 1} of ${total}…`;
      }
      if (job.sing_wait === 'pc') {
        return `${done} of ${plural(total, 'shot')} sung. The rest waits for your PC: switch on the helper with singing (“antics sing tonight”).`;
      }
      if (noCheckWait(job)) { // (no AI call can be made right now; the worker says why: the key, or it is starting)
        if (isGuest()) return `Paused for now. It goes on once ${hostName()}'s worker is ready.`;
        return job.stage || "Your free AI time can't be checked right now, so singing waits. It goes on by itself.";
      }
      if (quotaWait(job)) {
        const rest = Math.max(0, total - done);
        const when = job.retry_at ? `${dayWord(job.retry_at)} after ${timeOf(job.retry_at)}` : 'tomorrow';
        if (job.test) return `Out of GPU time for now: the 5-second test runs by itself ${when}.`;
        const pc = owner() && pcCan() ? ' Turn on your PC to finish sooner.' : '';
        return total ? `Singing ${done} of ${total} done · next ${rest} ${when}.${pc}` : `Out of singing time today. It goes on by itself ${when}.${pc}`;
      }
      if (/busy/i.test(job.stage || '')) return `The singing AI is busy right now. It goes on by itself around ${clockAt(job)}.`;
    }
    if (job.test && testState(job) === 'all_bad') return "The AI can't make this animal sing well yet.";
    if (job.status === 'done' && job.test) {
      if (testState(job) === 'good') return `${testName(job)} sings with your animal. It makes your Sing videos now.`;
      if (testState(job) === 'bad') return testNext(job) ? `${testName(job)} didn't sing. Try another one.` : "The AI can't make this animal sing well yet.";
      return `TEST · ${testName(job)}: does the mouth sing with the words?`;
    }
    if (job.status === 'done' && job.draft) return `Preview ready · the first shot. Finish sings the rest (${plural(Math.max(0, total - done), 'shot')}).`;
    if ((job.status === 'working' || job.status === 'waiting') && readyParts(job).length && series(job)) {
      const next = (job.posts || []).find((p) => !p.ready);
      return `Part ${readyParts(job).length} of ${job.posts.length} is ready to post.${next ? ` Part ${next.n} is being sung.` : ''}`;
    }
    return '';
  }

  // The card's own buttons; null: app.js's usual ones (a finished video, a failed one).
  function actions(job) {
    if (job.test && (job.status === 'done' || testState(job) === 'all_bad')) return testActions(job);
    const list = [];
    if (job.status === 'waiting' && job.picture_check) {
      return [['✓ Sing now', 'open', () => singNow(job)], ['↻ New pictures', '', () => newPictures(job)], ['Delete', 'del', () => deleteJob(job)]];
    }
    if (job.status === 'done') return null;
    if (canWatchSoFar(job)) list.push(['▶ Watch so far', 'open', () => openPart(job, 0)]);
    for (const p of readyParts(job)) if (series(job)) list.push([`▶ Part ${p.n}`, '', () => openPart(job, p.n)]);
    if (job.status === 'failed') return list.length ? [...list, ['Try again', '', () => retryJob(job)], ['Delete', 'del', () => deleteJob(job)]] : null;
    if (job.status === 'waiting' && !quotaWait(job) && job.gpu_wait !== 'stopped' && job.sing_wait !== 'pc_singing') list.push(['Try now', '', () => retryJob(job)]);
    if (job.status !== 'working') list.push(['Delete', 'del', () => deleteJob(job)]);
    return list.length ? list : null;
  }

  function testActions(job) {
    const del = ['Delete', 'del', () => deleteJob(job)];
    const watch = ['▶ Watch the test', 'open', () => openPlayer(job)];
    if (testState(job) === 'good') {
      return [['Make the whole meme part', 'finish', () => finishTest(job)], ['▶ Watch', 'open', () => openPlayer(job)], del];
    }
    if (testState(job) === 'all_bad' || (testState(job) === 'bad' && !testNext(job))) {
      return [['Dance to the song instead', 'finish', () => danceInstead(job)], del];
    }
    const list = [watch];
    if (isGuest()) return [...list, del];
    list.push(['Yes, use this one', 'finish', () => verdict(job, 'good')]);
    list.push([nextLabel(job), '', () => verdict(job, 'bad')]);
    if ((job.test_pc || pcCan()) && job.test_engine !== 'P') list.push(['Try my PC tonight', '', () => verdict(job, 'pc')]);
    if (testClips(job).length > 1) list.push(['Compare', '', () => compare(job)]);
    list.push(del);
    return list;
  }

  // "No, try LTX-2 · about 2–3 min": the cost shows before the tap.
  function nextLabel(job) {
    const next = testNext(job);
    if (!next) return "No, it doesn't sing";
    const id = next.engine || next.id;
    if (id === 'P') return 'No, try my PC';
    // (the same picture goes along: only the singing call costs)
    const mins = Array.isArray(next.minutes) ? next.minutes.map((m) => Math.max(1, Math.round(m))) : callMinutes(id, false);
    return nb(`No, try ${next.name || engineName(id)} · about ${span(mins, 'min')}`);
  }

  async function verdict(job, v) {
    const form = new FormData();
    const next = testNext(job);
    form.append('answer', v);
    if (v === 'bad' && next) form.append('next', next.engine || next.id);
    if (v === 'pc') form.append('next', 'P');
    try {
      const res = await api(`/jobs/${job.id}/test`, { method: 'POST', body: form });
      const updated = res.job || res;
      if (res.gpu) setGpu(res.gpu);
      replaceJob(updated);
      if (state.playing && state.playing.id === job.id && $('#player').open) closeDialog($('#player'));
      if (v === 'good') {
        S.retest = false;
        toast(`${testName(job)} is your singing AI now. Tap Make the whole meme part, or make a new Sing video.`);
      } else if (v === 'pc') {
        toast('Your PC sings the same 5 s when you switch the helper on tonight.');
      } else if (next) {
        toast(`Trying ${next.name || engineName(next.engine || next.id)} with the same picture and the same 5 s.`);
      } else {
        toast('Marked. None of the singing AIs sang this one.');
      }
      loadGpu(true);
      schedulePoll(1500);
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message);
    }
  }

  async function finishTest(job) {
    unlockSound();
    try {
      replaceJob(await api(`/jobs/${job.id}/finish`, { method: 'POST' }));
      state.watchAfter = { id: job.id, rev: job.rev || 0 };
      // (a 5-second engine's test clip is the meme part's first window; LTX-2 sings longer windows, so it starts over)
      toast(['L1', 'L2', 'K'].includes(job.test_engine) ? 'Making the whole meme part: the test shot is its first 5 s. It opens when it is ready.'
        : 'Making the whole meme part. It opens when it is ready.');
      schedulePoll(1500);
    } catch (e) {
      toast(e.message);
    }
  }

  // Every singing AI said no: a normal AI video of the animal dancing to the same song.
  function danceInstead(job) {
    S.on = false;
    save(KEY.mode, 'one');
    const btn = $('#modeSeg [data-v="one"]');
    if (btn) btn.click();
    if (job.song_id && mySong(job.song_id)) pickSong(job.song_id);
    state.style = 'dance';
    save(KEYS.style, 'dance');
    redraw();
    $('#step1').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(`Pick your animal's video: it dances to ${songTitle(job.song_name)} (a normal AI video).`);
  }

  async function singNow(job) {
    unlockSound();
    await retryJob(job);
    toast('Singing starts now. The card shows each shot as it is sung.');
  }

  // ↻ New pictures (all of them), or ↻ just one (its angle's name).
  async function newPictures(job, angle = '') {
    const form = new FormData();
    form.append('repicture', angle || 'true');
    try {
      replaceJob(await api(`/jobs/${job.id}/edit`, { method: 'POST', body: form }));
      S.pictureRev[job.id] = (S.pictureRev[job.id] || 0) + 1;
      toast(angle ? `Making a new ${(ANGLE_NAMES[angle] || 'stage').toLowerCase()} picture (about 20 s).` : 'Making new stage pictures (about a minute).');
      schedulePoll(1500);
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message);
    }
  }

  const ANGLE_NAMES = { close: 'Close-up', medium: 'Half body', wide: 'Wide', two: 'Both', closeA: 'Close-up 1', closeB: 'Close-up 2' };
  const anglesOf = (job) => (Array.isArray(job.angles) ? job.angles : []);
  const mainAngle = (job) => ['close', 'two', 'closeA'].find((a) => anglesOf(job).includes(a)) || anglesOf(job)[0] || '';
  const pictureRev = (job) => `${Math.round(job.retry_at || 0)}-${S.pictureRev[job.id] || 0}`;
  const pictureUrl = (job, angle = mainAngle(job)) => (angle
    ? `${state.worker.url}/jobs/${job.id}/picture?name=${encodeURIComponent(angle)}&key=${encodeURIComponent(state.worker.key)}&pc=${pictureRev(job)}`
    : `${mediaUrl(job, 'thumb')}&pc=${pictureRev(job)}`);
  const thumbFallback = (img, job) => img.addEventListener('error', () => {
    const alt = `${mediaUrl(job, 'thumb')}&pc=${pictureRev(job)}`;
    if (img.src !== alt && !img.dataset.fell) {
      img.dataset.fell = '1';
      img.src = alt;
    } else img.remove();
  });

  function decorate(card, job) {
    const tags = $('.job-tags', card);
    const add = (text, cls) => {
      const chip = document.createElement('span');
      chip.className = `chip ${cls}`;
      chip.textContent = text;
      return chip;
    };
    if (job.test) tags.prepend(add(nb(`TEST · ${testName(job)}`), 'sing test'));
    tags.prepend(add('Sing', 'sing'));
    if (series(job) && readyParts(job).length) {
      tags.appendChild(add(readyParts(job).length === job.posts.length ? `${job.posts.length} parts` : `Part ${readyParts(job).length}/${job.posts.length} ready`, 'sing-part'));
    }
    tags.hidden = false;
    const stage = stageText(job);
    if (stage) $('.job-stage', card).textContent = nb(stage);
    const hint = $('.job-hint', card);
    const failed = (job.shots || []).filter((x) => x.failed);
    if (job.status === 'done' && job.draft) hint.hidden = true;
    if (failed.length && job.status !== 'failed') {
      hint.textContent = nb(`Shot ${failed.map((x) => x.k + 1).join(', ')} didn't come out, so ${failed.length === 1 ? 'it shows' : 'they show'} the stage there. ↻ it in Edit to try again.`);
      hint.hidden = false;
    } else if (job.test && job.status === 'done' && !testState(job) && job.pc_report) {
      const r = job.pc_report;
      hint.textContent = [r.chunk_s && `${(r.chunk_s / 60).toFixed(1)} min a piece`, r.vram_gb && `${r.vram_gb} GB of graphics memory`,
        r.ram_gb && `${r.ram_gb} GB of RAM`, r.torch && `torch ${r.torch}`, r.driver && `driver ${r.driver}`].filter(Boolean).join(' · ');
      hint.hidden = !hint.textContent;
    }
    const plan = $('.plan-add', card);
    if (plan && series(job)) plan.textContent = `+ Plan all ${job.posts.length} parts`;
    // (app.js's "Make the rest" counts 5 s clips; a sung video's shots are the worker's: Finish is for a preview)
    if (job.status === 'done' && !job.draft) {
      card.querySelectorAll('.job-actions .finish').forEach((b) => { if (b.textContent === 'Make the rest') b.remove(); });
    }
    if (job.status === 'waiting' && job.picture_check) {
      const thumb = $('.thumb', card);
      thumb.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = pictureUrl(job);
      thumbFallback(img, job);
      const look = document.createElement('span');
      look.className = 'play look';
      look.innerHTML = '<span aria-hidden="true">👀</span>';
      thumb.append(img, look);
      thumb.setAttribute('aria-label', 'See the stage pictures');
      thumb.addEventListener('click', () => openPicture(job));
      card.classList.add('playable', 'checking');
    }
  }

  // ---------- The player ----------

  // The video for the player: a part of a series, the shots sung so far, or the video (null: app.js's own address).
  function playerSrc(job) {
    if (job.kind !== 'sing') return null;
    const base = mediaUrl(job, 'video');
    if (S.view.job === job.id && S.view.part) return `${base}&part=${S.view.part}`;
    if (canWatchSoFar(job)) return `${base}&sofar=1`;
    return null;
  }

  function openPart(job, n) {
    S.view = { job: job.id, part: n };
    openPlayer(job);
  }

  function playerOpen(job) {
    const box = $('#singPlayer');
    box.innerHTML = '';
    box.hidden = true;
    if (job.kind !== 'sing') {
      S.view = { job: null, part: 0 };
      return;
    }
    if (S.view.job !== job.id) S.view = { job: job.id, part: 0 };
    const kind = $('#playerKind');
    if (job.test) {
      kind.hidden = false;
      kind.textContent = nb(testState(job) ? `TEST · ${testName(job)}` : `TEST · ${testName(job)}: does the mouth sing with the words? Watch it with the sound on.`);
    } else if (job.status !== 'done') {
      kind.hidden = false;
      kind.textContent = `Watch so far: the ${plural(soFarShots(job) || doneShots(job), 'shot')} sung until now, with the song.`;
    }
    $('#editBtn').hidden = job.test ? true : $('#editBtn').hidden;
    if (job.test && job.status === 'done' && !testState(job) && !isGuest()) {
      const q = document.createElement('p');
      q.className = 'sing-question';
      q.textContent = 'Does the mouth sing with the words?';
      box.appendChild(q);
      const row = document.createElement('div');
      row.className = 'row';
      for (const [label, cls, fn] of testActions(job)) {
        if (cls === 'del' || cls === 'open') continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls === 'finish' ? 'go small' : 'plain';
        b.textContent = label;
        b.addEventListener('click', fn);
        row.appendChild(b);
      }
      box.appendChild(row);
      box.hidden = false;
      return;
    }
    const parts = readyParts(job);
    if (!series(job) || !parts.length) return;
    const row = document.createElement('div');
    row.className = 'chips-wrap sing-part-chips';
    const choices = [...(job.status === 'done' ? [{ n: 0, label: 'Whole video' }] : []),
      ...parts.map((p) => ({ n: p.n, label: `Part ${p.n}/${job.posts.length} · ${clock(p.from - (job.part_from || 0))}–${clock(p.to - (job.part_from || 0))}` }))];
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.setAttribute('aria-pressed', String(c.n === S.view.part || (!S.view.part && c.n === 0)));
      b.addEventListener('click', () => {
        S.view = { job: job.id, part: c.n };
        openPlayer(job);
      });
      row.appendChild(b);
    }
    box.appendChild(row);
    const fine = document.createElement('p');
    fine.className = 'fine';
    fine.textContent = 'TikTok takes up to 60 s of a song, so a long one is posted in parts. Save video saves the one showing.';
    box.appendChild(fine);
    box.hidden = false;
  }

  // The stage pictures (the job's thumb while there is no video), with the same buttons as the card.
  function openPicture(job) {
    if ($('#player').open) closeDialog($('#player'));
    state.playing = job;
    state.playingBlob = null;
    const video = $('#playerVideo');
    video.pause();
    video.removeAttribute('src');
    video.hidden = true;
    const img = $('#playerPicture');
    let shown = mainAngle(job);
    img.src = pictureUrl(job, shown);
    img.alt = 'The stage pictures';
    img.hidden = false;
    // every stage picture: tap one to see it, ↻ to make just that one again
    const strip = $('#singPlayer');
    strip.innerHTML = '';
    strip.hidden = anglesOf(job).length < 2;
    const angleRow = document.createElement('div');
    angleRow.className = 'sing-angles';
    for (const a of anglesOf(job)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sing-angle';
      b.dataset.angle = a;
      b.setAttribute('aria-pressed', String(a === shown));
      b.setAttribute('aria-label', ANGLE_NAMES[a] || a);
      const pic = document.createElement('img');
      pic.alt = '';
      pic.src = pictureUrl(job, a);
      const name = document.createElement('span');
      name.textContent = ANGLE_NAMES[a] || a;
      b.append(pic, name);
      b.addEventListener('click', () => {
        shown = a;
        img.src = pictureUrl(job, a);
        angleRow.querySelectorAll('.sing-angle').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.angle === a)));
      });
      angleRow.appendChild(b);
    }
    const one = document.createElement('button');
    one.type = 'button';
    one.className = 'plain';
    one.textContent = '↻ Just this one';
    one.addEventListener('click', () => {
      closeDialog($('#player'));
      newPictures(job, shown);
    });
    strip.append(angleRow, one);
    const kind = $('#playerKind');
    kind.hidden = false;
    kind.textContent = `Here are the stage pictures. Is it your animal, sharp, mouth closed and visible? Singing starts by itself at ${clockAt(job)}.`;
    for (const id of ['finishBtn', 'saveBtn', 'editBtn', 'capBox']) $(`#${id}`).hidden = true;
    const row = $('#playerCheck');
    row.innerHTML = '';
    row.hidden = false;
    for (const [label, cls, fn] of actions(job) || []) {
      if (cls === 'del') continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls === 'open' ? 'go small' : 'plain';
      b.textContent = label;
      b.addEventListener('click', () => {
        closeDialog($('#player'));
        fn();
      });
      row.appendChild(b);
    }
    const tip = $('#playerTip');
    tip.textContent = '';
    const li = document.createElement('li');
    li.textContent = 'New pictures use only a few seconds of GPU time. Singing uses minutes, so check them first.';
    tip.appendChild(li);
    openDialog($('#player'));
  }

  // The player's tips for a sung video (in place of app.js's music line).
  function tip(job, line) {
    if (job.test) line(['This is a test clip: the TEST badge is only on this one.']);
    line(['The song is inside, in sync with the mouths.']);
    if ((job.voices || []).some((v) => v && v !== 'original')) line(['Changed voices stay only when you post with the song inside.']);
    if (series(job)) line(['Post the parts in order: '], ['+ Plan', true], [' puts them all in your posting plan.']);
    line(['Post it from your '], ['personal TikTok account', true], [": business accounts can't use most music."]);
    line(['Before posting, turn on '], ['AI-generated content', true], [' in TikTok.']);
  }

  // ---------- The Post screen (Posting plan) ----------

  let postTexts = null;
  function renderPost(item, job) {
    const lineEl = $('#postSongLine');
    const label = $('#postSongLine > span');
    if (!postTexts) postTexts = { title: label.firstChild.textContent, sub: $('small', label).textContent };
    const sung = Boolean(job && job.kind === 'sing');
    const noteEl = $('#postSingNote');
    if (!sung) {
      label.firstChild.textContent = postTexts.title;
      $('small', label).textContent = postTexts.sub;
      noteEl.hidden = true;
      return;
    }
    label.firstChild.textContent = 'Song inside (in sync)';
    $('small', label).textContent = 'The mouths match the song. TikTok muted it? Turn this off and add the sound in TikTok.';
    if (!cutFailed(item)) lineEl.hidden = false;
    const title = songTitle(job.song_name);
    noteEl.textContent = item.audio === 'as_made'
      ? `♪ ${title} is inside, in sync with the mouths. Post it from your personal account: business accounts can't use most music.`
      : `🔇 No song in this version: add ${title} in TikTok and line it up by ear (the mouths may be a little off).`;
    noteEl.hidden = false;
    $('#postCutNote').hidden = true;
  }

  function postLines(item, job, line) {
    const sound = (item.song && Number.isFinite(item.song.start) && item.song) || job.tiktok_sound;
    if (item.audio === 'no_song' && sound && Number.isFinite(sound.start)) {
      line(['Start the sound at exactly '], [tenth(sound.start), true], [', then line it up by ear (the mouths may be a little off)']);
      if ((job.voices || []).some((v) => v && v !== 'original')) line(['Changed voices are only in the version with the song inside']);
    }
    if (item.part && series(job)) line(['This is '], [`part ${item.part} of ${job.posts.length}`, true], [': post the parts in order']);
  }

  // ---------- Edit: the "Song and stage" box ----------

  const ed = { on: false, part: 'meme', voices: [], who: 'turns', look: 'studio', redo: new Set(), title: true, zooms: true };
  // Things only Sing hides in the editor: shown again for other videos.
  const EDIT_ONLY_SING = () => [$('#editTextsLabel'), $('#editTexts'), $('#editRedoHelp'), $('#editMusicLabel'), $('#editMusicPick'),
    $('#editLenLabel'), $('#editLenSeg').closest('.opt-line'), $('#editSpeedSeg').closest('.opt-line'), $('#editCaptions').closest('.opt-line'),
    $('#editStoryTitle').closest('h3'), $('#editIdea').closest('.idea-wrap')];
  // Things others show or hide too (app.js, together.js): hidden here for a Sing video on every draw.
  const EDIT_ALSO = () => [$('#editSongUpload'), $('#editPartLine'), $('#editPartPick'), $('#editVoiceLine'), $('#editVoicePick'),
    $('#editMemeLine'), $('#editIdeaHeard'), $('#editStyle'), $('#editTogether'), $('#editAnimalLine')];
  const sameWho = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const jobWho = (job) => (Array.isArray(job.who) ? job.who : job.who || 'turns');

  function editorOpen(job) {
    ed.on = job.kind === 'sing';
    $('#editSing').hidden = !ed.on;
    $('#editSingTitleLine').hidden = !ed.on;
    $('#editSingZoomLine').hidden = !ed.on;
    if (!ed.on) {
      EDIT_ONLY_SING().forEach((el) => { if (el) el.hidden = false; });
      return;
    }
    ed.part = PARTS.some((p) => p.id === job.part) ? job.part : 'meme';
    ed.voices = (job.singers || [{}]).map((s, i) => (VOICE_IDS.includes((job.voices || [])[i]) ? job.voices[i] : 'original'));
    ed.who = jobWho(job);
    ed.look = LOOKS.some((l) => l.id === job.look) ? job.look : 'studio';
    ed.redo = new Set();
    ed.title = job.title_on !== false;
    ed.zooms = job.beat_zooms !== false;
    $('#editSingTitle').checked = ed.title;
    $('#editSingZoom').checked = ed.zooms;
    buildEditBox(job);
  }

  function buildEditBox(job) {
    const box = $('#editSing');
    box.innerHTML = '';
    const head = document.createElement('h3');
    head.className = 'edit-label';
    head.innerHTML = 'Song and stage <span class="kind fast">fast</span>';
    box.appendChild(head);
    const what = document.createElement('p');
    what.className = 'fine';
    what.textContent = `♪ ${songTitle(job.song_name)} · ${partName(job.part)}${Number.isFinite(job.part_from) ? ` (${clock(job.part_from)} → ${clock(job.part_to || 0)})` : ''}`;
    box.appendChild(what);
    const sub = (text, kind) => {
      const p = document.createElement('p');
      p.className = 'sub-label';
      p.textContent = `${text} `;
      if (kind) {
        const k = document.createElement('span');
        k.className = `kind ${kind}`;
        k.textContent = kind === 'fast' ? 'fast' : 'new singing';
        p.appendChild(k);
      }
      box.appendChild(p);
      return p;
    };
    // Voices (a quick re-mix: the mouths don't change)
    sub('Voices', 'fast');
    (job.singers || [{}]).forEach((s, i) => {
      const row = document.createElement('label');
      row.className = 'opt-line edit-sing-voice';
      const who = document.createElement('span');
      who.textContent = (job.singers || []).length > 1 ? `${i + 1} · ${s.name || animalWord(s)}` : s.name || animalWord(s);
      const sel = document.createElement('select');
      sel.className = 'small-input';
      sel.dataset.editVoice = String(i);
      sel.setAttribute('aria-label', `Voice of singer ${i + 1}`);
      for (const v of VOICES) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = `${v.name} (${v.sub})`;
        sel.appendChild(o);
      }
      sel.value = ed.voices[i] || 'original';
      row.append(who, sel);
      box.appendChild(row);
    });
    // The part (shorter: a re-cut; longer: new shots)
    sub('Part');
    const parts = document.createElement('div');
    parts.className = 'seg edit-sing-parts';
    parts.id = 'editSingParts';
    for (const p of PARTS.filter((x) => !(x.owner && isGuest()))) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = p.id;
      b.textContent = p.name;
      parts.appendChild(b);
    }
    box.appendChild(parts);
    if ((job.singers || []).length > 1) {
      sub('Who sings what', 'slow');
      const seg = document.createElement('div');
      seg.className = 'seg edit-sing-who';
      seg.id = 'editSingWho';
      for (const [v, name] of [['turns', 'Take turns'], ['both', 'Verse by verse']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.v = v;
        b.textContent = name;
        seg.appendChild(b);
      }
      box.appendChild(seg);
    }
    sub('Stage', 'slow');
    const looks = document.createElement('div');
    looks.className = 'chips-wrap edit-sing-looks';
    looks.id = 'editSingLooks';
    box.appendChild(looks);
    const shots = (job.shots || []).filter((x) => x.done || x.failed);
    if (shots.length) {
      sub('Shots: ↻ sings one again', 'slow');
      const strip = document.createElement('div');
      strip.className = 'edit-sing-shots';
      strip.id = 'editSingShots';
      for (const x of shots) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'edit-sing-shot';
        b.dataset.k = String(x.k);
        const whoTxt = x.who === 'both' ? 'both' : x.who === 'B' ? '2' : (job.singers || []).length > 1 ? '1' : '';
        b.textContent = `↻ ${x.k + 1} · ${clock(x.from)}–${clock(x.to)}${x.angle ? ` · ${x.angle}` : ''}${whoTxt ? ` · ${whoTxt}` : ''}${x.failed ? ' · didn\'t come out' : ''}`;
        b.setAttribute('aria-label', `Sing shot ${x.k + 1} again`);
        strip.appendChild(b);
      }
      box.appendChild(strip);
    }
    const help = document.createElement('p');
    help.className = 'fine';
    help.id = 'editSingHelp';
    box.appendChild(help);
  }

  function editorRender() {
    if (!ed.on || !edit.job) return;
    const job = edit.job;
    EDIT_ONLY_SING().forEach((el) => { if (el) el.hidden = true; });
    EDIT_ALSO().forEach((el) => { if (el) el.hidden = true; });
    setSeg('editSingParts', ed.part);
    if ($('#editSingWho')) setSeg('editSingWho', Array.isArray(ed.who) ? '' : ed.who);
    chips($('#editSingLooks'), LOOKS.map((l) => ({ key: l.id, label: `${l.emoji} ${l.name}` })), ed.look, (key) => {
      ed.look = key;
      renderEditor();
    });
    document.querySelectorAll('#editSingShots .edit-sing-shot').forEach((b) => b.setAttribute('aria-pressed', String(ed.redo.has(Number(b.dataset.k)))));
    const left = redosLeft(job);
    const slow = editAnimates();
    const help = [];
    if (ed.look !== (job.look || 'studio')) help.push('A new stage makes new pictures and sings every shot again.');
    else if (!sameWho(ed.who, jobWho(job))) help.push('Only the shots whose lines change hands are sung again.');
    if (PART_RANK[ed.part] > PART_RANK[job.part || 'meme']) help.push('A longer part sings the new shots; the ones made stay.');
    else if (PART_RANK[ed.part] < PART_RANK[job.part || 'meme']) help.push('A shorter part is a quick re-cut of the shots made.');
    if (ed.redo.size) help.push(`${plural(ed.redo.size, 'shot')} sung again with a new take.`);
    if (!slow) help.push('Voices, the title and the ending are a quick re-mix: the mouths stay as they are.');
    if (left < Infinity) help.push(`New singing left for this video: ${left}.`);
    $('#editSingHelp').textContent = nb(help.join(' '));
    document.querySelectorAll('#editSingShots .edit-sing-shot').forEach((b) => {
      b.disabled = left <= 0 && !ed.redo.has(Number(b.dataset.k));
    });
  }

  function editAnimates() {
    if (!ed.on || !edit.job) return null;
    const job = edit.job;
    return ed.look !== (job.look || 'studio') || !sameWho(ed.who, jobWho(job)) || ed.redo.size > 0
      || PART_RANK[ed.part] > PART_RANK[job.part || 'meme'];
  }

  // What counts as one of a friend's new singings: shots sung again (a new stage, other lines, ↻).
  function editLoses() {
    if (!ed.on || !edit.job) return null;
    const job = edit.job;
    const made = doneShots(job) > 0;
    return made && (ed.look !== (job.look || 'studio') || !sameWho(ed.who, jobWho(job)) || ed.redo.size > 0);
  }

  async function saveEdit(job) {
    const form = new FormData();
    form.append('voices', JSON.stringify(ed.voices));
    form.append('title_on', String($('#editSingTitle').checked));
    form.append('beat_zooms', String($('#editSingZoom').checked));
    if (ed.part !== job.part) form.append('part', ed.part);
    if (!sameWho(ed.who, jobWho(job))) form.append('who', Array.isArray(ed.who) ? JSON.stringify(ed.who) : ed.who);
    if (ed.look !== (job.look || 'studio')) form.append('look', ed.look);
    if (ed.redo.size) form.append('redo', [...ed.redo].sort((a, b) => a - b).join(',')); // (↻ shots: k, in the same edit)
    if (job.has_badge) form.append('brand', String($('#editBrand').checked));
    for (const [key, id, line] of EDIT_EXTRAS) {
      if (key === 'voice' || key === 'meme' || $(`#${line}`).hidden) continue;
      form.append(key, String($(`#${id}`).checked));
    }
    const animate = editAnimates();
    const btn = $('#editSave');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api(`/jobs/${job.id}/edit`, { method: 'POST', body: form });
      replaceJob(res.job || res);
      state.watchAfter = { id: job.id, rev: job.rev || 0 };
      closeDialog($('#editor'));
      toast(animate ? 'Singing the changed shots again (minutes online, or on your PC). It opens when it is ready.'
        : 'Mixing your new version (a few seconds). It opens when it is ready.');
      schedulePoll(1500);
    } catch (e) {
      note($('#editNote'), e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message, 'bad');
    } finally {
      btn.disabled = false;
      renderEditor();
    }
  }

  // ---------- "Choose lines" (a duet): who sings each line, by time only (never the words) ----------

  function openLines() {
    if (!packReady()) return;
    const lines = linesIn();
    if (!lines.length) {
      toast('No sung lines in this part.');
      return;
    }
    if (!S.lines) {
      const turns = turnsOf(lines);
      const verses = versesOf(lines);
      S.lines = Object.fromEntries(lines.map((l, k) => [l.n, S.who === 'both' ? verses[k] : turns[k]]));
    }
    renderLines();
    openDialog($('#singLines'));
  }

  function renderLines() {
    const box = $('#singLineRows');
    box.innerHTML = '';
    const lines = linesIn();
    const names = S.singers.map((s, i) => s.name || `${i + 1} · ${animalWord(s)}`);
    lines.forEach((l, k) => {
      const row = document.createElement('div');
      row.className = 'sing-line-row';
      row.dataset.n = String(l.n);
      const hear = document.createElement('button');
      hear.type = 'button';
      hear.className = 'mini';
      hear.dataset.lineHear = String(l.n);
      hear.textContent = '▶';
      hear.setAttribute('aria-label', `Hear line ${k + 1}`);
      const what = document.createElement('span');
      what.className = 'sing-line-what';
      what.textContent = `Line ${k + 1} · ${clock(l.start)}${/^(?:chorus|hook)$/.test(l.kind || '') ? ' · chorus' : ''}`;
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [v, label] of [['A', names[0] || '1'], ['B', names[1] || '2'], ['both', 'Both']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.v = v;
        b.textContent = label;
        b.setAttribute('aria-pressed', String(whoOfLine(l, k) === v));
        seg.appendChild(b);
      }
      row.append(hear, what, seg);
      box.appendChild(row);
    });
  }

  // ---------- The tests side by side ----------

  function compare(job) {
    const grid = $('#singCompareGrid');
    grid.innerHTML = '';
    for (const t of testClips(job)) {
      const cell = document.createElement('div');
      cell.className = 'sing-compare-cell';
      const v = document.createElement('video');
      v.src = `${mediaUrl(job, 'video')}&test=${encodeURIComponent(t.engine)}`;
      v.controls = true;
      v.playsInline = true;
      v.loop = true;
      v.preload = 'metadata';
      const name = document.createElement('p');
      name.className = 'sing-compare-name';
      name.textContent = `${t.name || engineName(t.engine)}${t.state === 'good' ? ' ✓' : t.state === 'bad' ? ' ✕' : ''}`;
      cell.append(v, name);
      grid.appendChild(cell);
    }
    openDialog($('#singCompare'));
  }

  // ---------- Settings: the Singing box ----------

  function renderSettings() {
    const show = owner() && ready();
    $('#singSet').hidden = !show;
    if (!show) return;
    // (app.js draws Settings just before it opens: then the GPU time is read fresh; while open, every 30 s at most)
    if (!$('#settings').open) loadGpu(true);
    else if (!gpu() || Date.now() - S.gpuAt > 30000) loadGpu();
    const g = gpu();
    const guardLine = document.getElementById('gpuLine'); // (the v12.1 GPU guard's own line, once it is merged in)
    const line = $('#singGpuLine');
    const numbers = Boolean(g && Number.isFinite(g.left) && Number.isFinite(g.base) && g.base > 0);
    line.hidden = Boolean(guardLine) || !numbers;
    if (numbers) {
      const left = Math.max(0, Math.min(Math.floor(g.left / 60), Math.round(g.base / 60)));
      line.textContent = nb(`GPU today: ${left} of ${Math.round(g.base / 60)} min left${g.resets_at ? ` · resets ${timeOf(g.resets_at)}` : ''}`);
    }
    const alertEl = $('#singGpuAlert');
    const billed = Boolean(g && g.alert === 'billed') && !document.getElementById('gpuAlert');
    note(alertEl, billed ? 'AI work is stopped: Hugging Face started charging your credits. Check huggingface.co/settings/billing.'
      : noGuard() ? NO_GUARD : '', 'bad');
    const share = g && Number.isFinite(g.sing_share) && g.base ? g.sing_share / g.base : 0.75;
    const pct = SHARE_STEPS.reduce((best, x) => (Math.abs(x / 100 - share) < Math.abs(best / 100 - share) ? x : best), 75);
    setSeg('singShareSeg', pct);
    const shareMin = Math.round((share * (g && g.base ? g.base : 2400)) / 60);
    const rest = Math.max(0, baseMin() - shareMin);
    $('#singShareSub').textContent = nb(`${shareMin} min a day · other videos keep ${rest} min`);
    $('#singSetState').textContent = anyGood() ? `sings with ${Object.entries(engines()).filter(([, e]) => e.state === 'good').map(([id]) => engineName(id)).join(', ')}`
      : g && g.engines ? 'needs its 5-second test' : '';
    const list = $('#singEngines');
    list.innerHTML = '';
    for (const id of TEST_ORDER) {
      const e = engines()[id];
      if (!e) continue;
      const row = document.createElement('div');
      row.className = 'friend-row sing-engine-row';
      row.dataset.engine = id;
      const who = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = engineName(id);
      const st = e.state === 'good' ? '✓ sings well' : e.state === 'bad' ? "✕ the mouth didn't sing" : 'not tested yet';
      let measured = '';
      const clip = id === 'X' ? 11.5 : 5;
      if (id === 'P' && e.wall_med) measured = ` · ${(e.wall_med / 60).toFixed(1)} min per 3 s piece (measured on your PC)`;
      else if (id !== 'P' && e.spend_med && e.measured) measured = ` · ${(e.spend_med / 60).toFixed(1)} min of GPU per ${clip} s clip (measured)`;
      else if (id !== 'P' && (e.spend_est || e.request)) measured = ` · about ${span(callMinutes(id))} min per ${clip} s clip`;
      who.append(name, document.createTextNode(` · ${st}${measured}`));
      const acts = document.createElement('div');
      acts.className = 'acts';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'plain';
      b.dataset.testEngine = id;
      b.textContent = e.state === 'untested' ? 'Test' : 'Test again';
      b.disabled = id === 'P' && !pcCan();
      acts.appendChild(b);
      row.append(who, acts);
      list.appendChild(row);
    }
    const P = pcEngine();
    const until = (g && g.pc_until) || (P && P.until) || '';
    $('#singPcTest').hidden = !P;
    $('#singPcTest').disabled = !pcCan();
    $('#singPcLine').textContent = nb(pcCan() || pcGood()
      ? `Sing on my PC: only when you switch the helper on (“antics sing tonight”)${until ? `, and it stops at ${until}` : ''}. Your games come first.`
      : 'Your PC can sing too (NVIDIA 8 GB, 32 GB of RAM): run the PC setup again, then switch on the helper with singing (“antics sing tonight”). Test singing on my PC works while it is on.');
  }

  async function setShare(pct) {
    const g = gpu();
    const base = g && g.base ? g.base : 2400;
    try {
      const res = await api('/settings', jsonPost({ sing_share: Math.round((base * pct) / 100) }));
      setGpu(res.gpu || res);
      toast(nb(`Singing may use ${Math.round((base * pct) / 6000)} min a day.`));
    } catch (e) {
      note($('#singSetNote'), e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message, 'bad');
    }
    renderSettings();
  }

  // "Test again" / "Test singing on my PC": Sing with the test card, that AI picked.
  function startTest(id) {
    closeDialog($('#settings'));
    S.retest = true;
    S.test = id || null;
    if (!S.on) setOn(true);
    else redraw();
    const target = S.singers.length ? '#step4' : '#step1';
    $(target).scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(S.singers.length ? 'Tap Make the 5-second test.' : 'Pick who sings, then tap Make the 5-second test.');
  }

  // ---------- Spoken orders: "make my cat sing", "karaoke", "the whole song", "a bear voice" ----------

  const ANIMAL_RE = String.raw`(?:${ANIMAL_IDS.join('|')}|dogs?|cats?|kitten|kitty|puppy|doggy|birds?)`;
  const animalOf = (w) => {
    const word = String(w || '').toLowerCase();
    if (/^(?:dogs?|puppy|doggy)$/.test(word)) return 'dog';
    if (/^(?:cats?|kitten|kitty)$/.test(word)) return 'cat';
    if (/^birds?$/.test(word)) return 'parrot';
    return word.replace(/s$/, '');
  };
  const listens = (target = 'main') => target === 'main' && Boolean(state.worker) && ready();

  function understandSing(take, orders, said) {
    const push = (a) => {
      orders.singAnimals = orders.singAnimals || [];
      const animal = animalOf(a);
      if (animal && orders.singAnimals.length < MAX_SINGERS) orders.singAnimals.push(animal);
    };
    const det = String.raw`(?:(?:my|the|a|an|our|his|her)\s+)?`;
    take(String.raw`(?:make|let|have|get|watch)\s+${det}(${ANIMAL_RE})\s+(?:and\s+${det}(${ANIMAL_RE})\s+)?(?:both\s+)?sing(?:ing)?`, (whole, a, b) => {
      orders.sing = true;
      push(a);
      if (b) push(b);
    });
    take(String.raw`(?:make|let|have|get)\s+(?:him|her|it|them|both(?:\s+of\s+them)?|the\s+two\s+of\s+them)\s+sing(?:ing)?`, () => { orders.sing = true; });
    // "sing Детство", "sings Detstvo": one of My songs right after sing (Cyrillic needs Unicode word edges)
    for (const s of songList()) {
      if (orders.songId && orders.sing) break;
      for (const name of songNames(s.name)) {
        const re = new RegExp(String.raw`(?<![\p{L}\p{N}])sing(?:s|ing)?\s+(?:(?:the\s+)?song\s+)?(?:${name})(?![\p{L}\p{N}])`, 'iu');
        if (re.test(said)) {
          orders.sing = true;
          orders.music = 'mysong';
          orders.songId = s.id;
          break;
        }
      }
    }
    // Words that only describe singing ("my cat singing karaoke", "a dog starring in a music video", "a duet") are
    // Sing orders only once Sing is on (or was asked for above): in One animal mode they stay the video's idea.
    if (!orders.sing && !on()) return;
    take(String.raw`sing(?:s|ing)?\s+(?:a\s+|the\s+|my\s+)?(?:song|duet)|sing(?:s|ing)?\s+along|(?:a\s+)?(?:karaoke|duet)(?:\s+(?:video|version|song))?|(?:a\s+)?music\s+video|lip[\s-]?sync(?:ing|ed)?|(?:a\s+)?singing\s+video`,
      (whole) => {
        orders.sing = true;
        if (/duet/i.test(whole)) orders.singDuet = true;
      });
    if (orders.sing) {
      orders.sing = true;
      if (!orders.singAnimals) { // "my cat and my dog ... sing": the animals said, in order
        const re = new RegExp(String.raw`\b(${ANIMAL_RE})\b`, 'gi');
        let m;
        while ((m = re.exec(said)) && (!orders.singAnimals || orders.singAnimals.length < MAX_SINGERS)) push(m[1]);
      }
    }
    take(String.raw`(?:the\s+)?(?:whole|full|entire|complete)\s+song`, () => { if (!isGuest()) orders.singPart = 'whole'; });
    take(String.raw`(?:the\s+)?chorus`, () => { orders.singPart = 'chorus'; });
    take(String.raw`(?:the\s+)?meme\s+part`, () => { orders.singPart = 'meme'; });
    take(String.raw`(?:in\s+)?(?:a\s+|an\s+|the\s+)?(cat|dog|bear|bird|small|chipmunk|original)\s+voices?`, (whole, v) => {
      orders.singVoice = v.toLowerCase() === 'chipmunk' ? 'small' : v.toLowerCase();
    });
    take(String.raw`(?:in\s+)?(?:a\s+)?high(?:er)?\s+voices?`, () => { orders.singVoice = 'cat'; });
    take(String.raw`(?:in\s+)?(?:a\s+)?deeper\s+voices?`, () => { orders.singVoice = 'bear'; });
    // The pet voice's words mean a singing voice here
    if (orders.voice) {
      const map = { deep: 'bear', squeaky: 'small', narrator: 'original', off: 'original' };
      if (map[orders.voice]) orders.singVoice = orders.singVoice || map[orders.voice];
      delete orders.voice;
    }
  }

  function labels(o) {
    if (!o.sing && !on()) return [];
    const out = [];
    if (o.sing) out.push('🎤 Sing');
    for (const a of o.singAnimals || []) out.push(`${EMOJI[a] || ''} ${cap(a)}`.trim());
    if (o.singPart) out.push(partName(o.singPart));
    if (o.singVoice) out.push(`${(VOICES.find((v) => v.id === o.singVoice) || { name: cap(o.singVoice) }).name} voice`);
    return out;
  }

  // Sets what was said; returns a function that puts it back.
  function applyOrders(o) {
    if (!o.sing && !(on() && (o.singPart || o.singVoice || o.singAnimals))) return () => {};
    const before = { on: S.on, part: S.part, voices: [...S.voices], voicePicked: [...S.voicePicked], songId: S.songId, songPicked: S.songPicked };
    const added = [];
    if (o.sing) S.on = true;
    if (o.singPart) S.part = o.singPart;
    if (o.songId) {
      S.songId = o.songId;
      S.songPicked = true;
      S.ownSong = null;
    }
    for (const a of o.singAnimals || []) {
      const blank = S.singers.find((s) => !s.animal);
      if (blank) blank.animal = a;
      else if (room() && !S.singers.some((s) => s.animal === a && !added.includes(s))) added.push(newSinger({ from: 'painted', animal: a }));
    }
    if (o.singVoice) {
      S.voices = S.voices.map(() => o.singVoice);
      S.voicePicked = S.voicePicked.map(() => true);
    }
    save(KEY.mode, S.on ? 'sing' : load(KEY.mode, 'one'));
    remember();
    if (S.on && ready()) {
      loadGpu();
      loadPack();
    }
    redraw();
    return () => {
      added.forEach(dropSinger);
      Object.assign(S, before);
      save(KEY.mode, S.on ? 'sing' : 'one');
      remember();
      redraw();
    };
  }

  // ---------- The worker changed state ----------

  function healthChanged() {
    if (!ready()) return;
    if (on() || $('#settings').open) loadGpu();
    if (on()) {
      settleSong();
      loadPack();
    }
  }

  // ---------- Start ----------

  function init() {
    const saved = load(KEY.sing, {}) || {};
    if (PARTS.some((p) => p.id === saved.part)) S.part = saved.part;
    if (LOOKS.some((l) => l.id === saved.look)) S.look = saved.look;
    if (['cuts', 'one'].includes(saved.shots)) S.shots = saved.shots;
    if (['turns', 'both'].includes(saved.who)) S.who = saved.who;
    if (['sharp', 'fast'].includes(saved.sharp)) S.sharp = saved.sharp;
    if (typeof saved.title === 'boolean') S.title = saved.title;
    if (typeof saved.zooms === 'boolean') S.zooms = saved.zooms;
    if (typeof saved.draft === 'boolean') S.draft = saved.draft;
    S.on = load(KEY.mode, 'one') === 'sing';
    S.saved = S.on;

    // The mode switch: Sing is handled here, before together.js sees the tap (it knows One animal and Together).
    $('#step1').addEventListener('click', (e) => {
      const b = e.target.closest('#modeSeg button[data-v]');
      if (!b) return;
      if (b.dataset.v === 'sing') {
        e.stopPropagation();
        setOn(true);
      } else if (S.on) {
        S.on = false; // (together.js saves the mode and draws everything again)
        S.saved = false;
        stopHearing();
      }
    }, true);
    $('#singUpdateBtn').addEventListener('click', () => openUpdate(rebuildNeeded() ? 'rebuild' : 'update'));
    $('#singFile').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('#singPickBtn').addEventListener('click', () => {
      S.picking = !S.picking;
      redraw();
      if (S.picking) $('#singPick').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#singAnimals').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.more) {
        S.more = true;
        S.sigs.singers = '';
        redraw();
      } else if (b.dataset.animal) {
        addPainted(b.dataset.animal);
      }
    });
    $('#singLinkBtn').addEventListener('click', () => {
      $('#singLinkField').hidden = false;
      $('#singLink').focus();
    });
    const addLinkNow = () => {
      if (!addLinks($('#singLink').value)) {
        toast('Paste a video link (TikTok, YouTube, Instagram, X, Facebook, or .mp4).');
        return;
      }
      $('#singLink').value = '';
      $('#singLinkField').hidden = true;
    };
    $('#singLinkAdd').addEventListener('click', addLinkNow);
    $('#singLink').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addLinkNow();
      }
    });
    $('#singLibBtn').addEventListener('click', openLibrary);
    $('#singLibDone').addEventListener('click', () => closeDialog($('#singLibrary')));
    $('#singSwap').addEventListener('click', swap);
    $('#singRow').addEventListener('click', (e) => {
      const tile = e.target.closest('.slot[data-i]');
      const s = tile && S.singers[Number(tile.dataset.i)];
      if (!s) return;
      if (e.target.closest('.slot-x')) {
        dropSinger(s);
        redraw();
      } else if (e.target.closest('.slot-look')) {
        relook(s, Number(tile.dataset.i));
      } else if (e.target.closest('.slot-name')) {
        rename(s, Number(tile.dataset.i));
      }
    });
    $('#singRow').addEventListener('change', (e) => {
      const tile = e.target.closest('.slot[data-i]');
      const s = tile && S.singers[Number(tile.dataset.i)];
      if (s && e.target.matches('.slot-animal')) pickAnimal(s, e.target.value);
    });
    // The song
    $('#singSongs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.known) {
        S.adding = b.dataset.known;
        $('#singKnownFile').click();
        redraw();
      } else if (b.dataset.songPick) {
        pickSongTile(b.dataset.songPick);
      } else if (b.dataset.songHear) {
        if (b.dataset.songHear !== S.songId) pickSongTile(b.dataset.songHear);
        hearPart(b.dataset.songHear, `song:${b.dataset.songHear}`);
      } else if (b.dataset.ownClear) {
        S.ownSong = null;
        settleSong();
        redraw();
      }
    });
    $('#singKnownFile').addEventListener('change', (e) => addKnown(e.target.files[0] || null));
    $('#singKnownFile').addEventListener('cancel', () => {
      S.adding = '';
      redraw();
    });
    window.addEventListener('focus', () => { // (a file picker closed without a file: the tile is back)
      setTimeout(() => {
        if (S.adding && !$('#singKnownFile').files.length) {
          S.adding = '';
          redraw();
        }
      }, 1500);
    });
    $('#singAddSongFile').addEventListener('change', (e) => {
      const file = e.target.files[0] || null;
      e.target.value = '';
      addSong(file); // (app.js: Settings opens with the meme part; the new song is in My songs then)
    });
    $('#singOwnSongFile').addEventListener('change', (e) => {
      const file = e.target.files[0] || null;
      e.target.value = '';
      if (!file) return;
      if (file.size > SONG_MB * 1024 * 1024) {
        toast(`That file is over ${SONG_MB} MB. Try a shorter one, or an MP3.`);
        return;
      }
      S.ownSong = file;
      redraw();
    });
    $('#singPartSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.part = b.dataset.v;
      S.lines = null;
      remember();
      redraw();
    });
    $('#singHearPart').addEventListener('click', () => hearPart(S.songId, `part:${S.songId}`));
    // The stage
    $('#singLooks').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-look]');
      if (!b) return;
      S.look = b.dataset.look;
      remember();
      redraw();
    });
    $('#singShotsSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      S.shots = b.dataset.v;
      remember();
      redraw();
    });
    $('#singWhoSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      if (b.dataset.v === 'lines') {
        openLines();
        return;
      }
      S.who = b.dataset.v;
      S.lines = null;
      remember();
      redraw();
    });
    $('#singVoices').addEventListener('click', (e) => {
      const tile = e.target.closest('.sing-voice[data-i]');
      if (!tile) return;
      const i = Number(tile.dataset.i);
      if (e.target.closest('[data-pick-voice]')) {
        S.voices[i] = tile.dataset.voice;
        S.voicePicked[i] = true;
        redraw();
      } else if (e.target.closest('[data-hear-voice]')) {
        hearVoice(i, tile.dataset.voice);
      }
    });
    for (const ev of ['play', 'pause', 'ended']) {
      preview.addEventListener(ev, () => {
        if (S.hearing && on()) {
          S.sigs.voices = '';
          S.sigs.songs = '';
          redrawSoon();
        }
      });
    }
    // The lines sheet
    $('#singLineRows').addEventListener('click', (e) => {
      const row = e.target.closest('.sing-line-row');
      if (!row) return;
      const n = Number(row.dataset.n);
      const hear = e.target.closest('[data-line-hear]');
      if (hear) {
        const l = linesIn().find((x) => x.n === n);
        if (l && S.songId) playSong(songAudioUrl(S.songId), Math.max(0, l.start - 0.2), l.end - l.start + 0.4);
        return;
      }
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.lines = { ...(S.lines || {}), [n]: b.dataset.v };
      renderLines();
    });
    $('#singLinesReset').addEventListener('click', () => {
      S.lines = null;
      closeDialog($('#singLines'));
      redraw();
    });
    $('#singLinesDone').addEventListener('click', () => {
      closeDialog($('#singLines'));
      redraw(); // (now, not on the dialog's close event a moment later)
    });
    onClosed($('#singLines'), () => {
      preview.pause();
      redraw();
    });
    $('#singCompareClose').addEventListener('click', () => closeDialog($('#singCompare')));
    onClosed($('#singCompare'), () => $('#singCompareGrid').querySelectorAll('video').forEach((v) => v.pause()));
    // Step 4
    $('#singEngineSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.engine = b.dataset.v;
      S.enginePicked = true;
      redraw();
    });
    $('#singSharpSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.sharp = b.dataset.v;
      remember();
      redraw();
    });
    $('#singDraftOpt').addEventListener('change', (e) => {
      S.draft = e.target.checked;
      remember();
      redraw();
    });
    $('#singDance').addEventListener('click', () => danceInstead({ song_id: S.songId, song_name: song() ? song().name : '' }));
    $('#singTitleOpt').addEventListener('change', (e) => {
      S.title = e.target.checked;
      remember();
      renderExtras();
    });
    $('#singZoomOpt').addEventListener('change', (e) => {
      S.zooms = e.target.checked;
      remember();
      renderExtras();
    });
    // Settings
    $('#singShareSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) setShare(Number(b.dataset.v));
    });
    $('#singEngines').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-test-engine]');
      if (b && !b.disabled) startTest(b.dataset.testEngine);
    });
    $('#singRetest').addEventListener('click', () => startTest(null));
    $('#singPcTest').addEventListener('click', () => startTest('P'));
    // The editor's Song and stage box
    $('#editSing').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-edit-voice]');
      if (!sel) return;
      ed.voices[Number(sel.dataset.editVoice)] = sel.value;
      renderEditor();
    });
    $('#editSing').addEventListener('click', (e) => {
      const part = e.target.closest('#editSingParts button[data-v]');
      if (part) ed.part = part.dataset.v;
      const who = e.target.closest('#editSingWho button[data-v]');
      if (who) ed.who = who.dataset.v;
      const shot = e.target.closest('.edit-sing-shot');
      if (shot && !shot.disabled) {
        const k = Number(shot.dataset.k);
        if (ed.redo.has(k)) ed.redo.delete(k);
        else ed.redo.add(k);
      }
      if (part || who || shot) renderEditor();
    });
    for (const id of ['editSingTitle', 'editSingZoom']) $(`#${id}`).addEventListener('change', renderEditor);
    onClosed($('#player'), () => { S.view = { job: null, part: 0 }; });
    redraw();
    renderJobs();
  }

  window.Sing = {
    on, noRealVideo: () => !S.singers.some((s) => s.real),
    render, renderExtras, renderMake, make, addSing, sent,
    actions, decorate, tip, playerSrc, playerOpen,
    renderPost, postLines,
    editorOpen, editorRender, editAnimates, editLoses, saveEdit,
    listens, understand: understandSing, labels, applyOrders,
    healthChanged, renderSettings,
    // (for tests and the browser console)
    peek: () => ({ on: on(), mode: S.on, part: S.part, look: S.look, shots: shotsNow(), who: S.who, lines: S.lines, voices: [...S.voices],
      engine: engineNow(), draft: draftNow(), test: testMode(), testEngine: testMode() ? testEngine() : null, songId: S.songId,
      ownSong: S.ownSong ? S.ownSong.name : null, title: S.title, zooms: S.zooms, retest: S.retest, allBad: allBad(),
      singers: S.singers.map((s) => ({ from: s.from, animal: s.animal, name: s.name, look: s.look, status: s.status, at: s.at, id: s.id,
        url: s.url, hasPic: Boolean(s.pic), real: s.real })),
      pack: pack(), gpu: gpu(), edit: { ...ed, redo: [...ed.redo] } }),
    KNOWN_SONGS, VOICES, LOOKS,
  };
  init();
})();
