// together.js
// antics "Together": several animal videos become one funny video (workers that list 'together' in /health).
// Step 1 gets a switch, One animal | Together: 2-4 animals from uploads, links, free clips or a painted
// surprise animal, in order (the first one is the star). Step 2 gets scene cards, step 4 the Look and what it
// costs. Also here: the job card's picture check and its out-of-time offer, the editor's "Scene and look" box,
// scene words in what you say, and "Ideas to try" (tap one and it sets everything; Undo puts it all back).
// It runs after app.js and uses its helpers ($, state, api, canDo, toast, note, renderOptions, ...). app.js
// calls in through window.Together; each of those calls is marked "Together" there.

(() => {
  // ---------- What the worker knows (worker/together.py) ----------

  const MAX_CAST = 4; // MAX_CAST in worker/together.py (2-3 animals work best)
  const VIDEO_MAX = 60 * 1024 * 1024; // a bigger video goes as ~6 s of frames instead (the worker refuses it)
  const FRAME_FPS = 12; // those frames, a second
  const LOOKS = ['ai', 'turns', 'free'];
  const KEY = { mode: 'antics.mode', scene: 'antics.scene', look: 'antics.look' };

  // The cost line: a free Hugging Face account's daily ZeroGPU time (5 min), one composed picture (FLUX 3 Image
  // Klein uses ~10 s), and one Wan 2.2 part of s seconds (9:16, 6 steps, the Space's own formula).
  const FREE_AI_SECONDS = 300;
  const PICTURE_COST = 15;
  const partCost = (s) => 10 + 90 * (((Math.round(16 * s) + 1) * 480) / (81 * 624)) ** 1.5;

  // The scene cards. ids match SCENES in worker/together.py. fits: how many animals it is for; roles: who is
  // who, in slot order; free: its free look ('split' side by side, 'vs' VS screen, 'grid', 'cuts' quick cuts).
  const SCENES = [
    { id: 'drive', emoji: '🚗', name: 'Drive', fits: [2, 4], roles: ['Driver', 'Passenger', 'Back seat', 'Back seat'], free: 'split' },
    { id: 'dance', emoji: '💃', name: 'Dance', fits: [2, 4], roles: ['Lead'], free: 'cuts' },
    { id: 'fight', emoji: '🥊', name: 'Fight', fits: [2, 4], roles: ['Red corner', 'Blue corner', 'Fan', 'Fan'], free: 'vs' },
    { id: 'band', emoji: '🎸', name: 'Band', fits: [2, 4], roles: ['Guitar', 'Drums', 'Vocals', 'Keys'], free: 'grid', grid: 'Band grid' },
    { id: 'dinner', emoji: '🍝', name: 'Dinner', fits: [2, 3], roles: ['Diner', 'Plate thief', 'Third wheel'], free: 'split' },
    { id: 'gym', emoji: '💪', name: 'Gym', fits: [2, 3], roles: ['Lifter', 'Spotter', 'Cardio'], free: 'split' },
    { id: 'office', emoji: '💼', name: 'Office', fits: [2, 4], roles: ['Boss', 'Intern', 'HR', 'IT'], free: 'grid', grid: 'Video call' },
    { id: 'couch', emoji: '📺', name: 'Couch', fits: [2, 4], roles: ['Remote', 'Scaredy'], free: 'split' },
    { id: 'wedding', emoji: '💍', name: 'Wedding', fits: [2, 3], roles: ['Groom', 'Bride', 'Officiant'], free: 'split' },
    { id: 'runway', emoji: '👠', name: 'Runway', fits: [2, 3], roles: ['Star', 'Follower', 'Next model'], free: 'cuts' },
    { id: 'normal', emoji: '🏠', name: 'Just normal', fits: [2, 4], roles: [], free: 'split' },
    { id: 'own', emoji: '🎤', name: 'Your own', fits: [2, 4], roles: [], free: 'split' },
  ];
  const FREE_NAMES = { split: 'Side by side', vs: 'VS screen', grid: 'Grid', cuts: 'Quick cuts' };
  const sceneOf = (id) => SCENES.find((s) => s.id === id) || null;
  const sceneOr = (id) => sceneOf(id) || sceneOf('normal');
  const fitsCast = (sc, n) => n < 2 || (n >= sc.fits[0] && n <= sc.fits[1]);

  // The free look for a scene and a number of animals (free_look() in worker/together.py): side by side and the
  // VS screen are for two, a grid for 3-4.
  function freeLook(sceneId, n) {
    const kind = sceneOr(sceneId).free;
    if ((kind === 'split' || kind === 'vs') && n > 2) return 'grid';
    return kind === 'grid' && n < 3 ? 'split' : kind;
  }
  const freeName = (sceneId, kind) => (kind === 'grid' && sceneOr(sceneId).grid) || FREE_NAMES[kind] || 'Side by side';

  // The animals a slot can be (tap to change), and words in a file name or link that name one.
  const ANIMALS = ['dog', 'cat', 'bird', 'monkey', 'rabbit', 'horse', 'goat', 'pig', 'duck'];
  const ANIMAL_WORDS = [
    ['dog', /\b(?:dogs?|pupp(?:y|ies)|pups?|doggo|doggy|husky|corgi|pug|poodle|labrador|retriever|chihuahua|beagle|terrier|dachshund|bulldog|shiba)\b/i],
    ['cat', /\b(?:cats?|kittens?|kitty|kitties|tabby)\b/i],
    ['bird', /\b(?:birds?|parrots?|budgies?|cockatiels?|pigeons?)\b/i],
    ['monkey', /\b(?:monkeys?|macaques?|chimps?)\b/i],
    ['rabbit', /\b(?:rabbits?|bunn(?:y|ies))\b/i],
    ['horse', /\b(?:horses?|pon(?:y|ies))\b/i],
    ['goat', /\bgoats?\b/i],
    ['pig', /\b(?:pigs?|piglets?)\b/i],
    ['duck', /\b(?:ducks?|ducklings?)\b/i],
    ['chicken', /\b(?:chickens?|hens?|roosters?)\b/i],
    ['cow', /\b(?:cows?|calf|calves)\b/i],
    ['hamster', /\bhamsters?\b/i],
    ['hippo', /\bhippos?\b/i],
    ['bear', /\bbears?\b/i],
    ['panda', /\bpandas?\b/i],
    ['penguin', /\bpenguins?\b/i],
    ['capybara', /\bcapybaras?\b/i],
    ['sheep', /\b(?:sheep|lambs?)\b/i],
    ['turtle', /\b(?:turtles?|tortoises?)\b/i],
  ];
  const guessAnimal = (text) => {
    const words = String(text || '').replace(/[_\-.+/]+/g, ' ');
    const found = ANIMAL_WORDS.find(([, re]) => re.test(words));
    return found ? found[0] : '';
  };
  // SURPRISE_ANIMALS in worker/ideas.py: a painted animal (no video needed)
  const SURPRISE_ANIMALS = ['golden retriever', 'chihuahua', 'pug', 'husky', 'corgi', 'french bulldog', 'dachshund',
    'italian greyhound', 'german shepherd', 'orange tabby cat', 'black and white tuxedo cat', 'fluffy white cat',
    'grumpy grey cat', 'macaque monkey', 'baby hippo', 'small crocodile', 'giant panda', 'brown bear', 'polar bear',
    'capybara', 'goat', 'chicken', 'penguin', 'raccoon', 'sloth', 'goose', 'kangaroo', 'llama', 'pig', 'duck'];
  const cap = (t) => String(t || '').replace(/^./, (c) => c.toUpperCase());
  const cleanName = (t) => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

  // ---------- State ----------

  const T = {
    mode: 'one', // 'one' | 'together'
    modeSaved: false, // the mode is the one from an earlier visit (a worker without Together goes back to One)
    cast: [], // the animals in order: { key, from, file, pic, picUrl, poster, at, animal, name, url, site, id, entry, real, status }
    keys: 0,
    reading: Promise.resolve(), // videos are read one at a time (phones have little memory)
    scene: 'dance',
    scenePicked: false, // tapped, said or set by an idea on this visit: typed words then add to it
    autoOwn: null, // the scene before typing picked "Your own" by itself
    look: 'ai',
    library: null, // the free clips (worker/library.json), once loaded
    libLoading: null,
    libFilter: 'all',
    recipe: null, // the idea tapped last: { id, undo }
    pictureRev: {}, // job id -> new pictures asked for here (so the new one shows, not the old one from cache)
    sigs: {}, // what each part was last drawn from: it is drawn again only when that changes
  };

  const known = () => Boolean(state.health);
  const ready = () => canDo('together');
  // The owner always sees the switch (with "Update needed" on a worker without Together); a friend only when
  // the worker can make Together videos.
  const allowed = () => (isGuest() ? ready() : true);
  const on = () => T.mode === 'together' && allowed();
  const outdated = () => known() && !ready();

  function setMode(mode) {
    T.mode = mode === 'together' ? 'together' : 'one';
    T.modeSaved = false;
    save(KEY.mode, T.mode);
    redraw();
  }

  // Everything on the main screen (renderOptions ends with Together.render), and One animal's step 1.
  function redraw() {
    renderOptions();
    if (!on()) renderSource();
  }

  // ---------- The animals (slots) ----------

  function newSlot(fields) {
    const s = { key: ++T.keys, animal: '', name: '', status: 'ready', real: false, ...fields };
    T.cast.push(s);
    return s;
  }

  function dropSlot(s) {
    const i = T.cast.indexOf(s);
    if (i >= 0) T.cast.splice(i, 1);
    if (s.picUrl) URL.revokeObjectURL(s.picUrl);
    s.picUrl = '';
  }

  const clearCast = () => [...T.cast].forEach(dropSlot);
  const room = () => MAX_CAST - T.cast.length;

  // Uploads: each file fills the next slot. Its sharpest moment is picked on the phone (the slot's picture).
  function addFiles(fileList) {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return;
    if (files.length > room()) toast(room() ? `Up to 4 animals: the first ${room()} are in.` : 'Up to 4 animals. Take one out first.');
    files.slice(0, Math.max(0, room())).forEach((file) => {
      const s = newSlot({ from: 'upload', file, animal: guessAnimal(file.name), real: isVideoFile(file), status: 'busy' });
      queueRead(s);
    });
    redraw();
  }

  function queueRead(s) {
    T.reading = T.reading.then(() => readSlot(s)).catch(() => {});
  }

  // The slot's picture (the sharpest moment; a free clip's within its good part) and that moment's time.
  async function readSlot(s) {
    if (!T.cast.includes(s)) return;
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
      if (!T.cast.includes(s)) return;
      dropSlot(s);
      toast(`${s.from === 'library' ? 'That free clip' : `"${s.file.name || 'That video'}"`} can't be opened here. Try another one.`);
    }
    redraw();
    if ($('#library').open) renderLibrary();
  }

  // Links: the worker downloads them. Pasted text is split before each http(s):// (the box is one line).
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
    if (urls.length > room()) toast('Up to 4 animals');
    urls.slice(0, Math.max(0, room())).forEach((url) => newSlot({ from: 'link', url, site: siteName(url), animal: guessAnimal(url), real: true }));
    redraw();
    return urls.length;
  }

  // A painted animal (the worker paints it, like Surprise me): a random one that isn't in yet.
  function addSurprise() {
    if (!room()) {
      toast('Up to 4 animals. Take one out first.');
      return;
    }
    const used = new Set(T.cast.map((s) => s.animal));
    const pool = SURPRISE_ANIMALS.filter((a) => !used.has(a));
    const list = pool.length ? pool : SURPRISE_ANIMALS;
    newSlot({ from: 'surprise', animal: list[Math.floor(Math.random() * list.length)] });
    redraw();
  }

  // ⇄ Swap places: the next one becomes the star (the first one drives, plays guitar, is the groom...).
  function swap() {
    if (T.cast.length < 2) return;
    T.cast.push(T.cast.shift());
    redraw();
  }

  function rename(s, i) {
    const name = prompt(`A name for animal ${i + 1} (optional), e.g. Milo. It goes in the text on the video.`, s.name || '');
    if (name === null) return;
    s.name = cleanName(name);
    redraw();
  }

  function pickAnimal(s, value) {
    if (value === 'other') {
      const word = cleanAnimal(prompt('Which animal is it? (one word, e.g. hamster)', '') || '');
      if (word) s.animal = word;
    } else if (value) {
      s.animal = value;
    }
    T.sigs.cast = ''; // (the menu shows the choice, or goes back to the old one)
    redraw();
  }

  // ---------- The free clips (worker/library.json, on this page's own site) ----------
  // The page fetches the chosen clip itself (Wikimedia Commons allows it; Hugging Face workers are refused
  // there) and sends it like an upload. The worker takes its label, licence and credit from its own copy.

  const GROUPS = { dogs: 'Dogs', cats: 'Cats', farm: 'Farm', wild: 'Wild', birds: 'Birds' };

  function loadLibrary() {
    if (T.library) return Promise.resolve(T.library);
    if (!T.libLoading) {
      T.libLoading = fetch('worker/library.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`library ${r.status}`))))
        .then((data) => {
          T.library = (Array.isArray(data.clips) ? data.clips : []).filter((c) => c && c.id && c.url);
          return T.library;
        })
        .finally(() => { T.libLoading = null; });
    }
    return T.libLoading;
  }

  async function openLibrary() {
    openDialog($('#library'));
    renderLibrary();
    if (T.library) return;
    note($('#libNote'), 'Getting the free clips…');
    try {
      await loadLibrary();
      note($('#libNote'), T.library.length ? '' : 'No free clips yet.');
    } catch {
      note($('#libNote'), "Couldn't get the free clips. Check your internet and try again.", 'bad');
    }
    renderLibrary();
  }

  const licence = (text) => (/^cc0/i.test(text || '') ? 'CC0' : /public domain|^pd/i.test(text || '') ? 'Public domain'
    : /cc by/i.test(text || '') ? 'CC BY' : String(text || 'Free'));

  function renderLibrary() {
    const clips = T.library || [];
    const order = Object.keys(GROUPS);
    const rank = (g) => (order.includes(g) ? order.indexOf(g) : 99);
    const groups = [...new Set(clips.map((c) => c.group).filter(Boolean))].sort((a, b) => rank(a) - rank(b));
    if (T.libFilter !== 'all' && !groups.includes(T.libFilter)) T.libFilter = 'all';
    chips($('#libFilters'), [{ key: 'all', label: 'All' }, ...groups.map((g) => ({ key: g, label: GROUPS[g] || cap(g) }))],
      T.libFilter, (key) => {
        T.libFilter = key;
        renderLibrary();
      });
    $('#libFilters').hidden = groups.length < 2;
    const grid = $('#libGrid');
    grid.innerHTML = '';
    for (const c of clips.filter((x) => (T.libFilter === 'all' || x.group === T.libFilter) && clipUrl(x))) grid.appendChild(clipCard(c));
    $('#libCount').textContent = `${T.cast.length} of 4 animals`;
  }

  function clipCard(c) {
    const inCast = T.cast.some((s) => s.from === 'library' && s.id === c.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lib-clip';
    b.dataset.id = c.id;
    b.setAttribute('aria-pressed', String(inCast));
    b.innerHTML = '<span class="lib-pic"><span class="lib-tick" aria-hidden="true">✓</span></span>'
      + '<span class="lib-name"></span><span class="lib-meta"><span class="lib-lic"></span><span class="lib-len"></span></span>';
    if (c.poster) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = c.poster;
      img.addEventListener('error', () => img.remove());
      $('.lib-pic', b).prepend(img);
    }
    $('.lib-name', b).textContent = c.label || cap(c.animal || 'Animal');
    $('.lib-lic', b).textContent = licence(c.license);
    $('.lib-len', b).textContent = c.seconds ? `${Math.round(c.seconds)} s` : '';
    b.setAttribute('aria-label', `${c.label || c.animal}${inCast ? ' (added)' : ''}`);
    b.addEventListener('click', () => toggleClip(c));
    return b;
  }

  function toggleClip(c) {
    const s = T.cast.find((x) => x.from === 'library' && x.id === c.id);
    if (s) dropSlot(s);
    else if (!room()) toast('Up to 4 animals. Take one out first.');
    else addLibrary(c);
    renderLibrary();
    redraw();
  }

  // The clip's address for this browser: its WebM, or the H.264 copy (mov) Commons also makes where WebM can't
  // play (iPhones before iOS 17.4). '' when this phone can play neither: that clip isn't offered here.
  let webm = null;
  function clipUrl(c) {
    if (webm === null) webm = document.createElement('video').canPlayType('video/webm; codecs="vp9"') !== '';
    if (webm || !/\.webm$/i.test(c.url)) return c.url;
    return c.mov || '';
  }

  async function addLibrary(c) {
    const s = newSlot({ from: 'library', id: c.id, entry: c, animal: cleanAnimal(c.animal || ''), poster: c.poster || '', real: true, status: 'busy' });
    redraw();
    const url = clipUrl(c);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`clip ${res.status}`);
      const blob = await res.blob();
      if (!T.cast.includes(s)) return; // taken out meanwhile
      const ext = /\.mov$/i.test(url) ? 'mov' : /\.mp4$/i.test(url) ? 'mp4' : 'webm';
      const type = blob.type.startsWith('video/') ? blob.type : { mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm' }[ext];
      s.file = new File([blob], `${c.id}.${ext}`, { type });
    } catch {
      s.status = 'bad';
      if (!T.cast.includes(s)) return;
      dropSlot(s);
      toast("Couldn't get that free clip. Check your internet and try again.");
      redraw();
      if ($('#library').open) renderLibrary();
      return;
    }
    queueRead(s);
  }

  // ---------- Drawing step 1 to 4 ----------

  let origTexts = null; // One animal's own words in step 2

  function render() {
    if (!origTexts) origTexts = { placeholder: $('#idea').placeholder, fine: $('#ideaFine').textContent };
    if (T.modeSaved && T.mode === 'together' && outdated()) {
      T.mode = 'one'; // remembered from an earlier visit, but this worker can't make it: One animal
      T.modeSaved = false;
      redraw();
      return;
    }
    const t = on();
    const seg = $('#modeSeg');
    seg.hidden = !allowed();
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === (t ? 'together' : 'one'))));
    $('#modeNeed').hidden = !outdated();
    $('#oneBox').hidden = t;
    $('#castBox').hidden = !t;
    $('#step1Title').textContent = t ? 'Your animals' : 'Your video';
    $('#sceneBox').hidden = !t;
    $('#styleRow').hidden = t;
    $('#styleLabel').hidden = t;
    $('#step2Opt').hidden = t;
    $('#lookLine').hidden = !t;
    $('#animalOpt').closest('.opt-line').hidden = t; // each animal has its own
    $('#voicePick .fine').textContent = t ? 'Auto: a narrator tells the story. Tap ▶ to listen.' : 'Auto picks one that fits the animal. Tap ▶ to listen.';
    renderIdeas();
    if (!t) {
      $('#idea').placeholder = origTexts.placeholder;
      $('#ideaFine').textContent = origTexts.fine;
      return;
    }
    // Several videos have several sounds: Together videos get a song (or none).
    $('#musicRow [data-key="mine"]').disabled = true;
    if (state.music === 'mine') {
      $('#musicHelp').textContent = 'Together videos get a song. Or pick No music and add a TikTok sound when you post.';
      $('#musicHelp').hidden = false;
    } else if (musicNow() === 'funny') {
      $('#musicHelp').textContent = 'A meme song that fits the scene.';
    }
    $('#castUpdate').hidden = !outdated();
    renderCast();
    renderScenes();
    renderLook();
    $('#step1').classList.toggle('done', T.cast.length >= 2 && !T.cast.some((s) => s.status === 'busy'));
  }

  function renderCast() {
    const sc = sceneOr(T.scene);
    const sig = JSON.stringify([sc.id, T.cast.map((s) => [s.key, s.status, s.animal, s.name, Boolean(s.picUrl)])]);
    const full = !room();
    $('#castFile').disabled = full;
    $('#castFileTile').classList.toggle('off', full);
    for (const id of ['castLinkBtn', 'castLibBtn', 'castSurpriseBtn']) $(`#${id}`).disabled = full;
    $('#castLibBtn').hidden = known() && !canDo('library');
    $('#castTools').hidden = T.cast.length < 2;
    $('#castCount').textContent = T.cast.length < 2 ? '' : `${T.cast.length} animals · the first one is the star`;
    if (sig === T.sigs.cast) return;
    T.sigs.cast = sig;
    const row = $('#castRow');
    row.innerHTML = '';
    T.cast.forEach((s, i) => row.appendChild(slotTile(s, i, sc)));
    if (!full) {
      const add = document.createElement('label');
      add.className = 'slot slot-add';
      add.htmlFor = 'castFile';
      add.innerHTML = '<span class="slot-pic"><span class="slot-plus" aria-hidden="true">+</span><span class="slot-what"></span></span>';
      $('.slot-what', add).textContent = T.cast.length ? 'Add' : 'Add your animals';
      row.appendChild(add);
    }
  }

  function slotTile(s, i, sc) {
    const tile = document.createElement('div');
    tile.className = `slot from-${s.from}${s.status === 'busy' ? ' busy' : ''}`;
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
      icon.textContent = s.from === 'link' ? '🔗' : s.from === 'surprise' ? '🎨' : '🎬';
      const what = document.createElement('span');
      what.className = 'slot-what';
      what.textContent = s.from === 'link' ? s.site : s.from === 'surprise' ? 'Painted by AI' : '';
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
    x.setAttribute('aria-label', `Take out animal ${i + 1}`);
    pic.appendChild(x);
    tile.appendChild(pic);
    const role = document.createElement('span');
    role.className = 'slot-role';
    role.textContent = sc.roles[i] || (i === 0 && sc.id !== 'normal' && sc.id !== 'own' ? 'The star' : '');
    tile.appendChild(role);
    tile.appendChild(animalMenu(s, i));
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'link-btn slot-name';
    name.textContent = s.name ? `✎ ${s.name}` : '✎ Name';
    name.setAttribute('aria-label', s.name ? `Name of animal ${i + 1}: ${s.name}. Change it` : `Give animal ${i + 1} a name`);
    tile.appendChild(name);
    return tile;
  }

  // Tap the animal word to pick another: the usual animals, or (painted) the surprise animals.
  function animalMenu(s, i) {
    const sel = document.createElement('select');
    sel.className = 'slot-animal';
    sel.setAttribute('aria-label', `Animal ${i + 1}`);
    const list = s.from === 'surprise' ? SURPRISE_ANIMALS : ANIMALS;
    const add = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    };
    if (!s.animal) add('', 'Animal?');
    if (s.animal && !list.includes(s.animal)) add(s.animal, cap(s.animal));
    for (const a of list) add(a, cap(a));
    if (s.from !== 'surprise') add('other', 'Other…');
    sel.value = s.animal || '';
    return sel;
  }

  function renderScenes() {
    const n = T.cast.length;
    const sig = JSON.stringify([T.scene, n]);
    if (sig !== T.sigs.scenes) {
      T.sigs.scenes = sig;
      const box = $('#sceneCards');
      box.innerHTML = '';
      for (const sc of SCENES) {
        const fits = fitsCast(sc, n);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scene-card';
        b.dataset.scene = sc.id;
        b.disabled = !fits;
        b.setAttribute('aria-pressed', String(sc.id === T.scene));
        b.innerHTML = '<span class="scene-emoji" aria-hidden="true"></span><span class="scene-name"></span><small></small>';
        $('.scene-emoji', b).textContent = sc.emoji;
        $('.scene-name', b).textContent = sc.name;
        $('small', b).textContent = fits ? '' : nb(`for ${sc.fits[0]}–${sc.fits[1]} animals`);
        box.appendChild(b);
      }
    }
    const sc = sceneOr(T.scene);
    const misfit = !fitsCast(sc, n);
    let line = '';
    if (misfit) line = `${sc.name} is for ${sc.fits[0]}–${sc.fits[1]} animals. Take one out, or pick another scene.`;
    else if (sc.id === 'fight') line = 'Playful only: gloves, misses and fake flops. No real fights.';
    else if (sc.id === 'own') line = 'Tell the whole story in the box below. Say it with 🎤 if you like.';
    const el = $('#sceneNote');
    el.textContent = nb(line);
    el.hidden = !line;
    el.classList.toggle('bad', misfit);
    const own = sc.id === 'own';
    $('#idea').placeholder = own ? 'e.g. They play chess, then the dog flips the board'
      : 'Add your own idea (optional), e.g. the cat steals the steering wheel';
    $('#ideaFine').textContent = own ? 'Say or type what they do together.'
      : 'Optional: your idea becomes the middle of the story. You can also say the scene, song and length.';
  }

  function pickScene(id) {
    T.scene = id;
    T.scenePicked = true;
    T.autoOwn = null;
    save(KEY.scene, id);
    redraw();
  }

  // The Look: all in one AI picture that moves, each animal's own AI moment, or the free look of the real clips.
  function lookButtons(seg, current, sceneId, n) {
    const free = freeName(sceneId, freeLook(sceneId, Math.max(2, n)));
    const items = [['ai', '✨ One scene', 'one AI picture'], ['turns', '✨ One by one', 'each gets a turn'],
      ['free', free, 'your real clips']];
    seg.innerHTML = '';
    for (const [v, name, sub] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = v;
      b.setAttribute('aria-pressed', String(v === current));
      b.innerHTML = '<b></b><small></small>';
      $('b', b).textContent = name;
      if (v === 'free') $('b', b).insertAdjacentHTML('beforeend', ' <span class="nowrap">· free</span>');
      $('small', b).textContent = sub;
      seg.appendChild(b);
    }
  }

  function renderLook() {
    const sig = JSON.stringify([T.look, T.scene, Math.max(2, T.cast.length)]);
    if (sig === T.sigs.look) return;
    T.sigs.look = sig;
    lookButtons($('#lookSeg'), T.look, T.scene, T.cast.length);
  }

  // Step 4 in Together (after app.js drew it): no preview for One by one or a free look, and the cost line.
  function renderStep4() {
    if (!on()) return;
    const ai = T.look === 'ai';
    $('#previewOpt').disabled = !ai || state.clips === 1;
    if (!ai) $('#previewSub').textContent = T.look === 'free' ? 'Not needed: ready in about a minute' : 'Not needed: One by one is made in full';
    $('#exportHelp').textContent = nb(costLine());
  }

  // What the free AI time pays for one video of this look: [seconds, in words].
  function aiCost() {
    const animals = Math.max(2, T.cast.length);
    const length = state.clips * 5;
    if (T.look === 'turns') { // each animal at least once, 2.5-5 s each
      const parts = Math.max(animals, Math.ceil(length / 5));
      const s = Math.min(5, Math.max(2.5, length / parts));
      return [parts * partCost(s), `${parts} short AI clips`];
    }
    const parts = isDraft() ? 1 : state.clips;
    return [PICTURE_COST + parts * partCost(5), `1 AI picture + ${parts} AI clip${parts === 1 ? '' : 's'}`];
  }

  function costLine() {
    const n = makeCount();
    const left = isGuest() && state.me ? ` You have ${state.me.uses_left} video${state.me.uses_left === 1 ? '' : 's'} left.` : '';
    if (T.look === 'free') return `No AI time. Ready in about a minute.${left}`;
    if (state.health && state.health.pc) {
      return (T.look === 'ai' ? 'Animates on your PC (free, no limit). The AI picture uses a few seconds of free online time.'
        : 'Animates on your PC (free, no limit).') + left;
    }
    const [seconds, what] = aiCost();
    const share = (seconds * n) / FREE_AI_SECONDS;
    const each = n > 1 ? `${n} videos, each ` : '';
    if (share > 1) return `More than today's free AI time: some finish tomorrow by themselves (${each}${what}).${left}`;
    const q = Math.min(4, Math.max(1, Math.round(share * 4)));
    return `Uses about ${['', 'a quarter', 'half', 'three quarters', 'all'][q]} of today's free AI time (${each}${what}).${left}`;
  }

  // ---------- Making it ----------

  function nudge(sel) {
    const el = $(sel);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('nudge');
    void el.offsetWidth; // restart the shake
    el.classList.add('nudge');
  }

  // Make it in Together: everything is checked here first, then app.js's submit sends it (with addCast).
  function make() {
    const msg = $('#note');
    if (outdated()) {
      note(msg, 'Your worker needs an update for Together videos: tap Update my worker (2–5 min, once).', 'bad');
      nudge('#step1');
      return;
    }
    if (T.cast.length < 2) {
      note(msg, 'Add one more animal (Together needs 2–4).', 'bad');
      nudge('#step1');
      return;
    }
    const sc = sceneOr(T.scene);
    if (!fitsCast(sc, T.cast.length)) {
      note(msg, nb(`${sc.name} is for ${sc.fits[0]}–${sc.fits[1]} animals. Take one out, or pick another scene.`), 'bad');
      nudge('#step2');
      return;
    }
    if (sc.id === 'own' && !$('#idea').value.trim()) {
      note(msg, 'Describe what they do together (step 2).', 'bad');
      nudge('#step2');
      $('#idea').focus();
      return;
    }
    submit({ kind: 'together' });
  }

  async function settled(s, n) {
    for (let i = 0; i < 600 && s.status === 'busy' && T.cast.includes(s); i++) await sleep(200);
    if (s.status === 'busy' && T.cast.includes(s)) throw new Error(`Animal ${n} is still loading. Try again in a moment.`);
  }

  function videoExt(file) {
    const m = /\.(mp4|mov|webm|m4v)$/i.exec(file.name || '');
    if (m) return m[1].toLowerCase();
    return { 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' }[file.type] || 'mp4';
  }

  // About 6 s of a big video around its picked moment (2 s before, 4 s after), as small JPEGs.
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
        await video.play(); // (iPhones hand out frames only after playing once)
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

  // The Together fields of POST /jobs (worker/together.py): mode, scene, look, cast (JSON, in order) and the
  // cast files p{i}.jpg (the picked picture), v{i}.mp4|mov|webm|m4v (the video, up to 60 MB) or f{i}_{nnn}.jpg
  // frames + real_fps (a bigger video; its cast entry's real_at: the moment's seconds into them), for uploads and
  // free clips (at: the picked moment's seconds into the video). Links and painted animals send no files.
  async function addCast(form, btn) {
    if (!canDo('together')) await refreshHealth(); // (right after setting up or updating the worker)
    if (!state.health) throw Object.assign(new Error('Your worker is waking up'), { waking: true });
    if (!canDo('together')) {
      throw new Error('Your worker needs an update for Together videos: tap ⚙, then Update my worker (2–5 min, once).');
    }
    const waiting = [...T.cast]; // a free clip still on its way, or a video still being read
    for (let i = 0; i < waiting.length; i++) {
      btn.textContent = `Getting animal ${i + 1} of ${waiting.length}…`;
      await settled(waiting[i], i + 1);
    }
    const slots = [...T.cast]; // (one that couldn't be opened is out now)
    if (slots.length < 2) throw new Error('Add one more animal (Together needs 2–4).');
    const cast = [];
    const files = [];
    let fps = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const entry = { from: s.from, animal: s.animal || '' };
      if (s.name) entry.name = s.name;
      if (s.from === 'link') entry.url = s.url;
      if (s.from === 'library') entry.id = s.id;
      if (s.from === 'upload' || s.from === 'library') {
        if (!s.pic) throw new Error(`Animal ${i + 1} isn't ready. Take it out (✕) and add it again.`);
        files.push([s.pic, `p${i}.jpg`]);
        if (s.file && isVideoFile(s.file) && s.at !== null && s.at !== undefined) {
          entry.at = s.at;
          if (s.file.size <= VIDEO_MAX) {
            files.push([s.file, `v${i}.${videoExt(s.file)}`]);
          } else {
            btn.textContent = `Getting animal ${i + 1} of ${slots.length}…`;
            const frames = await framesAround(s.file, s.at);
            frames.forEach((f, k) => files.push([f, `f${i}_${String(k).padStart(3, '0')}.jpg`]));
            entry.real_at = Math.round((s.at - frames.from) * 100) / 100; // (the moment, in seconds into the frames)
            fps = FRAME_FPS;
          }
        }
      }
      cast.push(entry);
    }
    form.append('mode', 'together');
    form.append('scene', T.scene);
    form.append('look', T.look);
    form.append('cast', JSON.stringify(cast));
    files.forEach(([blob, name]) => form.append('cast_files', blob, name));
    if (fps) form.append('real_fps', String(fps));
    btn.textContent = 'Sending…';
  }

  // Sent: the animals stay (another scene with the same pets is one tap away); a tapped idea is done.
  function sent() {
    T.recipe = null;
    $('#recipeLine').hidden = true;
    T.sigs.ideas = '';
    renderIdeas();
  }

  // ---------- The job card ----------

  const clockAt = (job) => (job.retry_at
    ? new Date(job.retry_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'in a moment');
  const madeFree = (job) => ['split', 'vs', 'grid', 'cuts'].includes(job.made_as);

  function freeOf(job) {
    const kind = job.free_look || freeLook(job.scene, (job.cast || []).length || 2);
    return { kind, name: freeName(job.scene, kind) };
  }

  const nowLabel = (free) => (free.kind === 'split' ? 'Make it side by side now · free'
    : `Make the ${free.name.replace(/^(?!VS)./, (c) => c.toLowerCase())} now · free`);

  // The picture check (✓ / ↻ / the free look instead) and the out-of-time card ("Make the VS screen now ·
  // free", which makes a second video of the free look while the AI one waits). null: the usual buttons.
  function actions(job) {
    if (job.status !== 'waiting' || job.look === 'free' || madeFree(job)) return null;
    const free = freeOf(job);
    if (job.picture_check) {
      return [
        ['✓ Animate now', 'open', () => animateNow(job)],
        ['↻ New picture', '', () => newPicture(job)],
        [`${free.name} instead · free`, '', () => freeInstead(job, free)],
        ['Delete', 'del', () => deleteJob(job)],
      ];
    }
    const list = [[nowLabel(free), 'finish', () => freeCopy(job, free)]];
    if (job.has_video) list.push(['▶ Watch so far', 'open', () => openPlayer(job)]);
    list.push(['Try now', '', () => retryJob(job)], ['Delete', 'del', () => deleteJob(job)]);
    return list;
  }

  function stageText(job) {
    if (job.status !== 'waiting') return '';
    if (job.picture_check) return `Here's the picture. It starts moving by itself at ${clockAt(job)}.`;
    if (/out of free/i.test(job.stage || '')) return `Out of free AI time today. It makes itself around ${clockAt(job)}.`;
    if (/busy/i.test(job.stage || '')) return `The free GPUs are all busy right now. It makes itself around ${clockAt(job)}.`;
    return '';
  }

  // The composed picture: the address changes with each new picture (the job's thumb shows it until a video exists).
  const pictureUrl = (job) => `${mediaUrl(job, 'thumb')}&pc=${job.has_picture ? 1 : 0}-${Math.round(job.retry_at || 0)}-${T.pictureRev[job.id] || 0}`;

  function decorate(card, job) {
    const tags = $('.job-tags', card);
    const chip = document.createElement('span');
    chip.className = 'chip together';
    chip.textContent = 'Together';
    tags.prepend(chip);
    tags.hidden = false;
    const stage = stageText(job);
    if (stage) $('.job-stage', card).textContent = nb(stage);
    if (job.status === 'done' && job.note) {
      const hint = $('.job-hint', card);
      hint.textContent = hint.hidden ? job.note : `${job.note} ${hint.textContent}`;
      hint.hidden = false;
    }
    const shown = $('.thumb img', card);
    if (shown && !job.has_video && job.has_picture) shown.src = pictureUrl(job); // (the picture, once it is there)
    if (job.status === 'waiting' && job.picture_check) {
      const thumb = $('.thumb', card);
      thumb.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = pictureUrl(job);
      img.addEventListener('error', () => img.remove());
      const look = document.createElement('span');
      look.className = 'play look';
      look.innerHTML = '<span aria-hidden="true">👀</span>';
      thumb.append(img, look);
      thumb.setAttribute('aria-label', 'See the picture');
      thumb.addEventListener('click', () => openPicture(job));
      card.classList.add('playable', 'checking');
    }
  }

  async function animateNow(job) {
    unlockSound();
    await retryJob(job);
    state.watchAfter = { id: job.id, rev: job.rev || 0 };
    toast(nb(`Animating it now (${clipTime()} a part). It opens when it's ready.`));
  }

  async function editNow(job, fields, done) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    try {
      replaceJob(await api(`/jobs/${job.id}/edit`, { method: 'POST', body: form }));
      toast(done);
      schedulePoll(1500);
      return true;
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message);
      return false;
    }
  }

  async function newPicture(job) {
    if (await editNow(job, { recompose: 'true' }, 'Making a new picture (about 20 s).')) {
      T.pictureRev[job.id] = (T.pictureRev[job.id] || 0) + 1;
    }
  }

  // "... instead · free": this video becomes the free look (made on the worker's CPU, no AI time).
  function freeInstead(job, free) {
    editNow(job, { look: 'free' }, `Making the ${free.name.replace(/^(?!VS)./, (c) => c.toLowerCase())} instead (about a minute). No AI time.`);
  }

  // "Make the VS screen now · free": a second video of the same animals and scene, while the AI one waits.
  async function freeCopy(job, free) {
    unlockSound();
    const form = new FormData();
    form.append('look', 'free');
    try {
      const res = await api(`/jobs/${job.id}/copy`, { method: 'POST', body: form });
      const made = res.jobs || [res];
      if (res.me) state.me = res.me;
      const ids = new Set(made.map((j) => j.id));
      state.jobs = [...made, ...state.jobs.filter((j) => !ids.has(j.id))];
      renderJobs();
      renderRole();
      toast(`Making the ${free.name.replace(/^(?!VS)./, (c) => c.toLowerCase())} now (about a minute). The AI one makes itself later.`);
      schedulePoll(1500);
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a moment.' : e.message);
    }
  }

  // The player shows the picture (not a video) with the same buttons. app.js's openPlayer puts the video back.
  function openPicture(job) {
    if ($('#player').open) closeDialog($('#player'));
    state.playing = job;
    state.playingBlob = null;
    const video = $('#playerVideo');
    video.pause();
    video.removeAttribute('src');
    video.hidden = true;
    const img = $('#playerPicture');
    img.src = pictureUrl(job);
    img.hidden = false;
    const kind = $('#playerKind');
    kind.hidden = false;
    kind.textContent = `Here's the picture. Is every animal in it and looking right? It starts moving by itself at ${clockAt(job)}.`;
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
    li.textContent = 'A new picture uses only a few seconds of free AI time. A video part uses about a minute.';
    tip.appendChild(li);
    openDialog($('#player'));
  }

  function playerReset() {
    $('#playerVideo').hidden = false;
    $('#playerPicture').hidden = true;
    $('#playerPicture').removeAttribute('src');
    $('#playerCheck').hidden = true;
    $('#saveBtn').hidden = false;
    $('#capBox').hidden = false;
  }

  // Before you post: clip credits are in the caption; a free look of real videos needs no AI label.
  // Returns true when it said what the AI label needs (app.js then leaves out its own line).
  function tip(job, line) {
    const cast = job.cast || [];
    if (cast.some((c) => c.credit)) line(['Credit for the clips is already in the caption.']);
    const painted = cast.some((c) => c.from === 'surprise');
    const ai = typeof job.uses_ai === 'boolean' ? job.uses_ai : !madeFree(job) || painted || (job.voice && job.voice !== 'off');
    if (!ai) {
      line(['Real videos only: '], ['no AI label needed', true], ['.']);
      return true;
    }
    return false;
  }

  // ---------- Edit: the "Scene and look" box ----------
  // order: the animals' new order as their numbers now ([1, 0] = swapped); names: one per animal, in the new
  // order. Scene, ↻ New picture and ⇄ Swap make a new picture and animate it again.

  const ed = { on: false, scene: 'normal', look: 'ai', recompose: false, order: [], names: [], len0: 1 };
  let editPlaceholder = null;
  const orderChanged = () => ed.order.some((v, i) => v !== i);
  // The look the video has now (current_look() in worker/together.py): the edit's look is compared with it.
  const lookNow = (job) => (madeFree(job) ? 'free' : LOOKS.includes(job.made_as) ? job.made_as : LOOKS.includes(job.look) ? job.look : 'ai');
  // The video's length in the Length buttons' 5 s steps. (One by one has a part per animal's turn and a free look
  // one part, so the number of parts doesn't say how long it is.)
  const lengthSteps = (job) => Math.max(1, Math.round((job.length || 5 * (job.wanted || 1)) / (job.part_seconds || 5)));
  const ideaChanged = (job) => $('#editIdea').value.trim().replace(/\s+/g, ' ') !== (job.idea || '');

  function editorOpen(job) {
    ed.on = job.kind === 'together';
    if (editPlaceholder === null) editPlaceholder = $('#editIdea').placeholder;
    $('#editTogether').hidden = !ed.on;
    $('#editStyle').hidden = ed.on;
    $('#editStoryTitle').textContent = ed.on ? 'Scene and look' : 'Story and style';
    $('#editIdea').placeholder = ed.on ? 'Your own idea (optional), e.g. the cat steals the steering wheel' : editPlaceholder;
    if (!ed.on) return;
    $('#editAnimalLine').hidden = true; // each animal has its own
    const cast = job.cast || [];
    ed.scene = sceneOr(job.scene).id;
    ed.look = lookNow(job);
    ed.recompose = false;
    ed.order = cast.map((_, i) => i);
    ed.names = cast.map((c) => c.name || '');
    edit.len = lengthSteps(job); // (app.js set it to the number of parts)
    ed.len0 = edit.len;
    buildEditCast();
  }

  function buildEditCast() {
    const cast = (edit.job && edit.job.cast) || [];
    const sc = sceneOr(ed.scene);
    const box = $('#editCast');
    box.innerHTML = '';
    ed.order.forEach((was, i) => {
      const c = cast[was] || {};
      const row = document.createElement('label');
      row.className = 'edit-cast-row';
      const who = document.createElement('span');
      who.className = 'edit-cast-who';
      who.textContent = `${i + 1} · ${cap(c.animal || 'animal')}${sc.roles[i] ? ` (${sc.roles[i]})` : ''}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'small-input';
      input.maxLength = 20;
      input.placeholder = 'Name (optional)';
      input.value = ed.names[was] || '';
      input.setAttribute('aria-label', `Name of animal ${i + 1}`);
      input.addEventListener('input', () => { ed.names[was] = input.value; });
      row.append(who, input);
      box.appendChild(row);
    });
  }

  function editorRender() {
    if (!ed.on || !edit.job) return;
    const job = edit.job;
    const n = (job.cast || []).length;
    chips($('#editScenes'), SCENES.map((s) => ({ key: s.id, label: `${s.emoji} ${s.name}` })), ed.scene, (key) => {
      ed.scene = key;
      buildEditCast(); // (the roles follow the scene)
      renderEditor();
    });
    $('#editScenes').querySelectorAll('button').forEach((b) => {
      b.disabled = !fitsCast(sceneOr(b.dataset.key), n) && b.dataset.key !== ed.scene;
    });
    lookButtons($('#editLookSeg'), ed.look, ed.scene, n);
    $('#editRecompose').setAttribute('aria-pressed', String(ed.recompose));
    $('#editSwap').hidden = n < 2;
    let help = '↻ New picture: the same scene, a new AI picture of them (a few seconds of AI time), then new animation.';
    if (ed.scene !== sceneOr(job.scene).id) help = 'A new scene makes a new picture of them, then new animation.';
    else if (orderChanged()) help = 'New places: a new picture (the first one is the star), then new animation.';
    else if (ed.look === 'free' && lookNow(job) !== 'free') help = 'The free look is made from the real clips in about a minute. No AI time.';
    $('#editTogetherHelp').textContent = help;
    const now = lookNow(job);
    if (now === 'ai') return;
    // One by one: a line (and ↻) per animal's turn. A free look: its one line, and no ↻ (nothing to animate).
    document.querySelectorAll('#editTexts .edit-text').forEach((row) => {
      row.hidden = now === 'free' && Number(row.dataset.i) > 0;
      $('.redo', row).hidden = now === 'free';
    });
    const left = redosLeft(job);
    $('#editRedoHelp').textContent = (now === 'free' ? 'The text on the video. Changing it is quick.'
      : '↻ = a new AI moment for that animal (and the turns after it).')
      + (now !== 'free' && left < Infinity ? ` New animations left for this video: ${left}.` : '');
  }

  // How many of the editor's lines can be made again with ↻ (app.js keeps only those): One scene one per 5 s,
  // One by one one per turn, a free look none.
  function editParts() {
    if (!ed.on || !edit.job) return edit.len;
    const now = lookNow(edit.job);
    return now === 'free' ? 0 : now === 'turns' ? (edit.job.texts || []).length : edit.len;
  }

  // Whether saving animates again (true / false), or null: app.js's usual rules (One scene: a new idea, ↻ on a
  // part, longer than made). A free look is always a cut on the worker's CPU, whatever else changes.
  function editAnimates() {
    if (!ed.on || !edit.job) return null;
    const job = edit.job;
    const now = lookNow(job);
    if (ed.look === 'free') return false;
    if (ed.scene !== sceneOr(job.scene).id || ed.recompose || orderChanged() || ed.look !== now) return true;
    if (now === 'turns') return edit.len !== ed.len0 || edit.redo.size > 0 || ideaChanged(job); // (every turn's length)
    return null;
  }

  // What counts as one of a friend's new animations (together.edit in the worker): a new picture of a video that
  // had one, or animated parts lost to a change; null: app.js's usual rules. Never for a free look (no AI time).
  function editLoses() {
    if (!ed.on || !edit.job) return null;
    const job = edit.job;
    if (ed.look === 'free') return false;
    const now = lookNow(job);
    const made = now !== 'free' && animatedClips(job) > 0;
    if (ed.scene !== sceneOr(job.scene).id || ed.recompose || orderChanged()) return Boolean(job.has_picture) || made;
    if (ed.look !== now) return made;
    if (now === 'turns') return made && (edit.redo.size > 0 || ideaChanged(job));
    return null;
  }

  // The edit fields of POST /jobs/{id}/edit for a Together video (the old template and animal are not sent).
  function editFields(form) {
    form.append('scene', ed.scene);
    form.append('look', ed.look);
    if (ed.recompose) form.append('recompose', 'true');
    if (orderChanged()) form.append('order', JSON.stringify(ed.order));
    form.append('names', JSON.stringify(ed.order.map((was) => cleanName(ed.names[was]))));
    if (ed.recompose || orderChanged() || ed.scene !== sceneOr(edit.job.scene).id) {
      T.pictureRev[edit.job.id] = (T.pictureRev[edit.job.id] || 0) + 1;
    }
  }

  // ---------- Spoken orders: scene and look words (only in Together) ----------

  const WHO = String.raw`(?:them|they|the\s+(?:two|three|four)(?:\s+of\s+them)?|both(?:\s+of\s+them)?|all(?:\s+of\s+them)?|the\s+(?:animals|pets)|my\s+(?:pets|animals))`;
  // [scene, what they do] in orders like "make them dance together" (taken out of the description)
  const SCENE_ORDERS = [
    ['drive', String.raw`drive|go\s+on\s+a\s+road\s+trip|go\s+for\s+a\s+drive`],
    ['dance', String.raw`dance`],
    ['fight', String.raw`fight|box|battle`],
    ['band', String.raw`play\s+in\s+a\s+band|start\s+a\s+band|play\s+music`],
    ['dinner', String.raw`have\s+dinner|eat\s+dinner|go\s+on\s+a\s+date`],
    ['gym', String.raw`work\s?out|go\s+to\s+the\s+gym|lift\s+weights`],
    ['office', String.raw`have\s+a\s+meeting|go\s+to\s+work|work\s+in\s+an\s+office`],
    ['couch', String.raw`watch\s+a\s+(?:scary\s+)?movie|watch\s+tv|sit\s+on\s+the\s+(?:couch|sofa)`],
    ['wedding', String.raw`get\s+married|have\s+a\s+wedding`],
    ['runway', String.raw`walk\s+the\s+runway|do\s+a\s+fashion\s+show`],
    ['normal', String.raw`just\s+(?:be\s+normal|chill|hang\s+out)|hang\s+out|chill`],
  ];
  // Words that name a scene inside a description (it stays in the description); the first one said wins.
  const SCENE_WORDS = [
    ['drive', /\b(?:driv(?:e|es|ing|er)|drove|road\s?trip|steering\s+wheel|car)\b/i],
    ['dance', /\b(?:danc(?:e|es|ed|ing|er|ers)|trend)\b/i],
    ['fight', /\b(?:fight(?:s|ing)?|boxing|boxer|battle)\b/i],
    ['band', /\b(?:band|guitar|drums?|drummer|concert|gig)\b/i],
    ['dinner', /\b(?:dinner|date\s+night|on\s+a\s+date|restaurant|spaghetti)\b/i],
    ['gym', /\b(?:gym|work(?:s|ing)?\s?out|lifting|weights)\b/i],
    ['office', /\b(?:office|meeting|at\s+work|video\s+call)\b/i],
    ['couch', /\b(?:couch|sofa|movie|popcorn)\b/i],
    ['wedding', /\b(?:wedding|marr(?:y|ies|ied|ying)|bride|groom)\b/i],
    ['runway', /\b(?:runway|catwalk|fashion)\b/i],
    ['normal', /\b(?:just\s+normal|chill(?:ing|in)?|hanging\s+out|hang\s+out)\b/i],
  ];
  const STYLE_SCENES = { dance: 'dance', twerk: 'dance', fight: 'fight', walk: 'runway', star: 'band' };

  // Called by app.js's understand() with its take() (which also takes the words out of the description).
  function understandScene(take, orders, said) {
    take(String.raw`(?:(?:as|in|with)\s+)?(?:(?:a|the)\s+)?(?:vs|versus)\s+(?:screen|version|look)`, () => {
      orders.scene = orders.scene || 'fight';
      orders.look = 'free';
    });
    take(String.raw`(?:(?:make\s+it|do\s+it|as|in)\s+)?(?:(?:a|the)\s+)?free\s+(?:version|look|one|video|way)|for\s+free|(?:with\s+)?no\s+a\.?\s?i\.?(?:\s+time)?`,
      () => { orders.look = 'free'; });
    take(String.raw`(?:(?:as|in|on)\s+(?:a\s+)?)?(?:side[\s-]+by[\s-]+side|split[\s-]?screen)`, () => { orders.look = 'free'; });
    take(String.raw`one[\s-]+by[\s-]+one|(?:each|every)\s+one\s+(?:gets\s+)?(?:a|their|its|his|her)\s+(?:own\s+)?(?:turn|moment|part)|(?:each|every)\s+one|(?:in\s+)?turns`,
      () => { orders.look = 'turns'; });
    take(String.raw`(?:all\s+)?(?:in\s+)?one\s+(?:scene|picture)`, () => { orders.look = 'ai'; });
    for (const [scene, does] of SCENE_ORDERS) {
      take(String.raw`(?:(?:make|let|have|get)\s+)?${WHO}\s+(?:${does})(?:\s+together)?|(?:${does})\s+together`, () => {
        orders.scene = orders.scene || scene;
      });
    }
    if (!orders.scene) {
      let first = null;
      for (const [scene, re] of SCENE_WORDS) {
        const m = re.exec(said);
        if (m && (!first || m.index < first.index)) first = { scene, index: m.index };
      }
      if (first) orders.scene = first.scene;
    }
    if (/\b(?:vs|versus)\b/i.test(said)) { // "cat vs dog": a fight, on the VS screen
      orders.scene = orders.scene || 'fight';
      orders.look = orders.look || 'free';
    }
    if (orders.style) { // a style word ("in the dance style") is a scene here
      orders.scene = orders.scene || STYLE_SCENES[orders.style];
      delete orders.style;
    }
    if (!orders.scene) delete orders.scene;
  }

  // "Got it: 💃 Dance · VS screen · free · ..." (the scene the look follows: the one said, else the one picked)
  function labels(o, target) {
    const out = [];
    const sceneId = o.scene || (target === 'edit' ? ed.scene : T.scene);
    if (o.scene) out.push(`${sceneOr(o.scene).emoji} ${sceneOr(o.scene).name}`);
    if (o.look) {
      const n = target === 'edit' ? ((edit.job && edit.job.cast) || []).length : T.cast.length;
      out.push(o.look === 'ai' ? 'One scene' : o.look === 'turns' ? 'One by one' : `${freeName(sceneId, freeLook(sceneId, Math.max(2, n)))} · free`);
    }
    return out;
  }

  // Sets the scene and look that were said; returns a function that puts them back.
  function applySpoken(o, target) {
    if (!o.scene && !o.look) return () => {};
    if (target === 'edit') {
      const before = { scene: ed.scene, look: ed.look };
      if (o.scene) ed.scene = o.scene;
      if (o.look) ed.look = o.look;
      buildEditCast();
      renderEditor();
      return () => {
        Object.assign(ed, before);
        buildEditCast();
        renderEditor();
      };
    }
    const before = { scene: T.scene, look: T.look, scenePicked: T.scenePicked, autoOwn: T.autoOwn };
    if (o.scene) {
      T.scene = o.scene;
      T.scenePicked = true;
      T.autoOwn = null;
      save(KEY.scene, o.scene);
    }
    if (o.look) {
      T.look = o.look;
      save(KEY.look, o.look);
    }
    redraw();
    return () => {
      Object.assign(T, before);
      save(KEY.scene, T.scene);
      save(KEY.look, T.look);
      redraw();
    };
  }

  const spoken = (target) => (target === 'edit' ? Boolean(ed.on && edit.job) : on());

  // Typing (or speaking) a story while no scene was picked makes it "Your own"; emptying the box undoes that.
  function onIdeaInput() {
    if (!on()) return;
    const text = $('#idea').value.trim();
    if (text && !T.scenePicked && T.scene !== 'own') {
      T.autoOwn = T.scene;
      T.scene = 'own';
      redraw();
    } else if (!text && T.autoOwn) {
      T.scene = T.autoOwn;
      T.autoOwn = null;
      redraw();
    }
  }

  // ---------- Ideas to try ----------
  // Ten videos anyone can make with one animal today (design section 12.1) and ten Together ones (12.2, shown
  // once the worker makes Together videos). A tap sets everything the idea names (one video each, as its AI time
  // says, except "Three takes") and says what to pick next.

  const RECIPES = [
    { id: 't-drive', together: true, emoji: '🚗', title: 'POV: you let the cat drive', who: '2 pets',
      set: { scene: 'drive', look: 'ai', idea: '', clips: 2, music: 'funny', opening: true, meme: true, count: 1 },
      next: 'Now pick your cat first, then your dog.' },
    { id: 't-dance', together: true, emoji: '💃', title: "One of them didn't practice", who: '2–3 pets',
      set: { scene: 'dance', look: 'ai', idea: '', clips: 2, music: 'track', track: 'Monkeys Spinning Monkeys', count: 1 },
      next: 'Now pick 2 or 3 pets.' },
    { id: 't-fight', together: true, emoji: '🥊', title: 'The rematch', who: '2 pets',
      set: { scene: 'fight', look: 'ai', idea: '', clips: 3, music: 'track', track: 'Hall of the Mountain King', count: 1 },
      next: 'Now pick 2 pets. The first one is the red corner.' },
    { id: 't-band', together: true, emoji: '🎸', title: 'Our first gig', who: '3–4 pets',
      set: { scene: 'band', look: 'ai', idea: '', clips: 2, music: 'track', track: 'Kool Kats', count: 1 },
      next: 'Now pick 3 or 4 pets in this order: guitar, drums, vocals, keys.' },
    { id: 't-dinner', together: true, emoji: '🍝', title: 'Third wheel', who: '2 pets + 1',
      set: { scene: 'dinner', look: 'ai', idea: '', clips: 3, music: 'track', track: 'Sneaky Snitch', voice: 'narrator', count: 1 },
      next: 'Now add your 2 pets, then tap Surprise animal for the third wheel.' },
    { id: 't-office', together: true, emoji: '💼', title: "This meeting could've been an email", who: '3–4 pets',
      set: { scene: 'office', look: 'free', idea: '', music: 'track', track: 'Local Forecast - Elevator', count: 1 },
      next: 'Now pick 3 or 4 pets, or tap Free clips. It uses no AI time.' },
    { id: 't-couch', together: true, emoji: '📺', title: 'We are not scared (we are)', who: '2–3 pets',
      set: { scene: 'couch', look: 'ai', idea: '', clips: 2, music: 'track', track: 'Investigations', meme: true, count: 1 },
      next: 'Now pick 2 or 3 pets.' },
    { id: 't-wedding', together: true, emoji: '💍', title: 'They said yes', who: '2–3 pets',
      set: { scene: 'wedding', look: 'ai', idea: '', clips: 2, music: 'track', track: 'Carefree', outro: true, count: 1 },
      next: 'Now pick 2 pets (a 3rd one can be the officiant).' },
    { id: 't-runway', together: true, emoji: '👠', title: 'Paris Fashion Week who?', who: '2–3 pets',
      set: { scene: 'runway', look: 'turns', idea: '', clips: 2, music: 'track', track: 'Kool Kats', count: 1 },
      next: 'Now pick 2 or 3 pets.' },
    { id: 't-normal', together: true, emoji: '🏠', title: 'Siblings be like', who: '2 pets',
      set: { scene: 'normal', look: 'ai', idea: '', clips: 1, music: 'none', count: 1 },
      next: 'Now pick 2 pets lying around. Add a trending sound when you post.' },
    { id: 'o-caught', emoji: '📸', title: 'Caught in 4K', who: '1 pet',
      set: { mode: 'one', style: 'honest', idea: '', music: 'track', track: 'Local Forecast - Elevator', opening: true, meme: true, clips: 2, preview: true, count: 1 },
      next: 'Now upload or paste a clip of your pet just sitting.' },
    { id: 'o-legday', emoji: '🏋️', title: 'Leg day', who: '1 dog',
      set: { mode: 'one', style: 'random', idea: 'Does squats at the gym, then flexes like a bodybuilder', music: 'track', track: 'Run Amok', voice: 'deep', clips: 1, count: 1 },
      next: 'Now pick a clip of your dog standing or walking.' },
    { id: 'o-smooth', emoji: '🕺', title: 'Smooth criminal', who: '1 pet',
      set: { mode: 'one', style: 'dance', idea: 'Does the moonwalk, then spins once', music: 'track', track: 'Kool Kats', meme: true, clips: 2, count: 1 },
      next: 'Now pick any clip of your pet.' },
    { id: 'o-fail', emoji: '🤸', title: 'He was doing so well', who: '1 pet',
      set: { mode: 'one', style: 'fail', idea: 'Walks on two legs like a boss, then slips and falls flat on its back', speed: 'slow', music: 'track', track: 'Fluffing a Duck', clips: 2, count: 1 },
      next: 'Now pick any clip of your pet.' },
    { id: 'o-goose', emoji: '🦆', title: 'The office goose', who: 'No video',
      set: { mode: 'one', surprise: true, style: 'random', idea: 'A goose in a tiny suit types furiously at an office desk, then slams the desk', music: 'track', track: 'Hitman', voice: 'narrator', clips: 2, count: 1 },
      next: 'No video needed: just tap Make it.' },
    { id: 'o-takes', emoji: '🎬', title: 'Three takes, keep the best', who: '1 pet',
      set: { mode: 'one', style: 'twerk', idea: '', music: 'track', track: 'Monkeys Spinning Monkeys', voice: 'squeaky', clips: 2, count: 3, preview: true },
      next: 'Now pick any clip of your pet. Then Finish only the funniest preview.' },
    { id: 'o-late', emoji: '🌙', title: 'When you come home late', who: '1 pet',
      set: { mode: 'one', style: 'sassy', idea: '', music: 'track', track: 'Local Forecast - Elevator', voice: 'deep', clips: 1, count: 1 },
      next: 'Now pick a clip of your pet looking at you. When it’s ready, tap Edit and change the text to “When you come home at 3 am”.' },
    { id: 'o-heist', emoji: '🌭', title: 'The sausage heist', who: '1 pet',
      set: { mode: 'one', style: 'random', idea: 'Sneaks into the kitchen, then steals a sausage, then looks at the camera like nothing happened', music: 'track', track: 'Sneaky Snitch', voice: 'narrator', clips: 3, count: 1 },
      next: 'Now pick any clip of your pet.' },
    { id: 'o-say', emoji: '🗣️', title: 'Just say it', who: '1 cat',
      say: 'my cat plays air guitar then jumps off the sofa, to Kool Kats, ten seconds, slow motion, deep voice',
      set: { mode: 'one', style: 'random', count: 1 },
      next: 'Set as if you said “my cat plays air guitar then jumps off the sofa, to Kool Kats, ten seconds, slow motion, deep voice”. Next time just tap 🎤 Speak and say it. Now pick a clip of your cat.' },
    { id: 'o-star', emoji: '⭐', title: 'Star with a trending sound', who: '1 pet',
      set: { mode: 'one', style: 'star', idea: 'Sings into a microphone with its eyes closed', music: 'none', outro: true, count: 1 },
      next: 'Now pick any clip of your pet. Add a trending TikTok sound when you post.' },
  ];

  // The Together ideas show once the worker makes Together videos (or before a worker is set up: it will).
  const recipes = () => RECIPES.filter((r) => !r.together || ready() || !state.worker);

  function renderIdeas() {
    const list = recipes();
    const sig = `${list.map((r) => r.id).join()}|${T.recipe ? T.recipe.id : ''}`;
    $('#ideasBox').hidden = false;
    if (sig === T.sigs.ideas) return;
    T.sigs.ideas = sig;
    const box = $('#ideaCards');
    box.innerHTML = '';
    for (const r of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `idea-card${r.together ? ' together' : ''}`;
      b.dataset.id = r.id;
      b.setAttribute('aria-pressed', String(Boolean(T.recipe && T.recipe.id === r.id)));
      b.innerHTML = '<span class="idea-emoji" aria-hidden="true"></span><span class="idea-name"></span><small></small>';
      $('.idea-emoji', b).textContent = r.emoji;
      $('.idea-name', b).textContent = r.title;
      $('small', b).textContent = nb(r.together ? `Together · ${r.who}` : r.who);
      box.appendChild(b);
    }
  }

  const SAVED = ['style', 'music', 'track', 'songId', 'clips', 'count', 'speed', 'preview'];

  // Everything an idea can change, and a function that puts it all back.
  function snapshot() {
    const k = Object.fromEntries(SAVED.map((key) => [key, state[key]]));
    Object.assign(k, {
      musicPicked: state.musicPicked, extras: { ...state.extras }, surprise: state.surprise, file: state.file, idea: $('#idea').value,
      t: { mode: T.mode, modeSaved: T.modeSaved, scene: T.scene, scenePicked: T.scenePicked, autoOwn: T.autoOwn, look: T.look },
    });
    return () => {
      for (const key of SAVED) {
        state[key] = k[key];
        save(KEYS[key], k[key]);
      }
      state.musicPicked = k.musicPicked;
      state.extras = k.extras;
      save(KEYS.extras, k.extras);
      state.surprise = k.surprise;
      state.file = k.file;
      if (!k.file) $('#file').value = '';
      $('#idea').value = k.idea;
      save(KEYS.idea, k.idea);
      Object.assign(T, k.t);
      save(KEY.mode, T.mode);
      save(KEY.scene, T.scene);
      save(KEY.look, T.look);
      songChanged();
    };
  }

  function applyRecipe(r) {
    if (T.recipe && T.recipe.id === r.id) { // tapped again: undone
      undoRecipe();
      return;
    }
    if (T.recipe) T.recipe.undo(); // another idea: from where things were before the first one
    const undo = snapshot();
    const s = r.set;
    T.mode = r.together ? 'together' : 'one';
    T.modeSaved = false;
    save(KEY.mode, T.mode);
    if (s.scene) {
      T.scene = s.scene;
      T.scenePicked = true;
      T.autoOwn = null;
      save(KEY.scene, s.scene);
    }
    if (s.look) {
      T.look = s.look;
      save(KEY.look, s.look);
    }
    const set = (key, v) => {
      state[key] = v;
      save(KEYS[key], v);
    };
    for (const key of ['style', 'track', 'clips', 'count', 'speed', 'preview']) if (s[key] !== undefined) set(key, s[key]);
    if (s.music) {
      set('music', s.music);
      state.musicPicked = true;
    }
    const extras = { ...state.extras };
    if (s.voice && canDo('voice')) {
      extras.voice = s.voice;
      extras.voicePick = s.voice;
    }
    for (const key of ['meme', 'opening', 'outro']) {
      if (s[key] !== undefined && canDo(key) && !(key === 'outro' && isGuest())) extras[key] = s[key];
    }
    state.extras = extras;
    save(KEYS.extras, extras);
    if (s.idea !== undefined) {
      $('#idea').value = s.idea;
      save(KEYS.idea, s.idea);
    }
    if (s.surprise) {
      state.surprise = true;
      state.file = null;
      $('#file').value = '';
    }
    if (r.say) { // the same as saying it: app.js understands the words and sets the options
      const { text, orders } = understand(r.say, 'random', false);
      applyOrders(orders, 'main');
      $('#idea').value = text;
      save(KEYS.idea, text);
    }
    songChanged();
    T.recipe = { id: r.id, undo };
    redraw();
    renderSource();
    $('#recipeText').textContent = nb(`✓ ${r.title}: ${r.next}`);
    $('#recipeLine').hidden = false;
  }

  function undoRecipe() {
    if (!T.recipe) return;
    const { undo } = T.recipe;
    T.recipe = null;
    undo();
    $('#recipeLine').hidden = true;
    redraw();
    renderSource();
  }

  // ---------- Start ----------

  function init() {
    const mode = load(KEY.mode, 'one');
    T.mode = mode === 'together' ? 'together' : 'one';
    T.modeSaved = T.mode === 'together';
    T.scene = sceneOf(load(KEY.scene, '')) ? load(KEY.scene, '') : 'dance';
    T.look = LOOKS.includes(load(KEY.look, '')) ? load(KEY.look, '') : 'ai';

    $('#modeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) setMode(b.dataset.v);
    });
    // The main Upload tile takes several files: 2-4 make it Together, with them in the slots.
    $('#file').addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      if (files.length < 2) return; // (app.js took the one)
      if (!allowed() || outdated()) {
        toast(isGuest() ? 'Picked the first video.' : 'Picked the first video. For several animals together, update your worker (⚙).');
        return;
      }
      setFile(null);
      clearCast();
      T.mode = 'together';
      T.modeSaved = false;
      save(KEY.mode, 'together');
      toast(files.length > MAX_CAST ? 'Up to 4 animals: Together with the first 4.' : `Together: ${files.length} animals`);
      addFiles(files.slice(0, MAX_CAST));
    });
    // Two or more links pasted into the link box: Together too.
    $('#link').addEventListener('input', () => {
      const urls = splitLinks($('#link').value);
      if (urls.length < 2 || !allowed()) return;
      if (outdated()) {
        toast('Several links: for animals together, update your worker (⚙).');
        return;
      }
      $('#link').value = '';
      clearCast();
      T.mode = 'together';
      T.modeSaved = false;
      save(KEY.mode, 'together');
      addLinks(urls.join(' '));
      renderSource();
      toast(urls.length > MAX_CAST ? 'Up to 4 animals: Together with the first 4.' : `Together: ${urls.length} animals`);
    });
    $('#castFile').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('#castLinkBtn').addEventListener('click', () => {
      $('#castLinkField').hidden = false;
      $('#castLink').focus();
    });
    const addLinkNow = () => {
      if (!addLinks($('#castLink').value)) {
        toast('Paste a video link (TikTok, YouTube, Instagram, X, Facebook, or .mp4).');
        return;
      }
      $('#castLink').value = '';
      $('#castLinkField').hidden = true;
    };
    $('#castLinkAdd').addEventListener('click', addLinkNow);
    $('#castLink').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // (not Make it)
        addLinkNow();
      }
    });
    $('#castLibBtn').addEventListener('click', openLibrary);
    $('#castSurpriseBtn').addEventListener('click', addSurprise);
    $('#castSwap').addEventListener('click', swap);
    $('#castUpdateBtn').addEventListener('click', openUpdate);
    $('#castRow').addEventListener('click', (e) => {
      const tile = e.target.closest('.slot[data-i]');
      if (!tile) return;
      const s = T.cast[Number(tile.dataset.i)];
      if (!s) return;
      if (e.target.closest('.slot-x')) {
        dropSlot(s);
        redraw();
      } else if (e.target.closest('.slot-name')) {
        rename(s, Number(tile.dataset.i));
      }
    });
    $('#castRow').addEventListener('change', (e) => {
      const tile = e.target.closest('.slot[data-i]');
      const s = tile && T.cast[Number(tile.dataset.i)];
      if (s && e.target.matches('.slot-animal')) pickAnimal(s, e.target.value);
    });
    $('#sceneCards').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-scene]');
      if (b && !b.disabled) pickScene(b.dataset.scene);
    });
    $('#lookSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      T.look = b.dataset.v;
      save(KEY.look, T.look);
      redraw();
    });
    $('#idea').addEventListener('input', onIdeaInput);
    $('#libDone').addEventListener('click', () => closeDialog($('#library')));
    $('#ideaCards').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      const r = b && RECIPES.find((x) => x.id === b.dataset.id);
      if (r) applyRecipe(r);
    });
    $('#recipeUndo').addEventListener('click', undoRecipe);
    // The editor's Scene and look box
    $('#editRecompose').addEventListener('click', () => {
      ed.recompose = !ed.recompose;
      renderEditor();
    });
    $('#editSwap').addEventListener('click', () => {
      ed.order.push(ed.order.shift());
      buildEditCast();
      renderEditor();
    });
    $('#editLookSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      ed.look = b.dataset.v;
      renderEditor();
    });
    redraw();
    renderJobs();
  }

  window.Together = {
    on, noRealVideo: () => !T.cast.some((s) => s.real), noPreview: () => on() && T.look !== 'ai',
    render, renderMake: renderStep4, make, addCast, sent,
    actions, decorate, playerReset, tip,
    editorOpen, editorRender, editAnimates, editLoses, editFields, editParts,
    spoken, understand: understandScene, labels, applyOrders: applySpoken,
    // (for tests and the browser console)
    peek: () => ({ mode: T.mode, on: on(), scene: T.scene, look: T.look, scenePicked: T.scenePicked, recipe: T.recipe && T.recipe.id,
      cast: T.cast.map((s) => ({ from: s.from, animal: s.animal, name: s.name, status: s.status, at: s.at, id: s.id, url: s.url, site: s.site,
        hasPic: Boolean(s.pic), size: s.file ? s.file.size : 0 })), edit: { ...ed, order: [...ed.order], names: [...ed.names] } }),
    SCENES, RECIPES,
  };
  init();
})();
