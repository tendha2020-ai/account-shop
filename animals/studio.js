// studio.js
// antics "Studio": the page as an editing studio, one tab at a time: Make video, Together and Sing (the three modes
// of the same steps), My videos, Posting plan, My songs and Settings. On a PC or tablet (900 px and wider) the tabs
// are a sidebar, with the worker at the bottom; on a phone they are a bar at the bottom (the rest under More) and ⚙
// stays at the top. The tab is remembered on this device (Make video, Together, Sing or My videos: antics opens ready
// to make a video, never on Settings, My songs or Posting plan), and the browser's Back button goes back through the
// tabs (?tab=<name>; with a player or editor open, Back closes it first). Links can name a tab: ?tab=songs,
// #tab=songs or #songs.
// Settings is still the <dialog id="settings">, shown in place in its tab (dialog.show(), not over the page), so
// "$('#settings').open" still means "Settings is showing", and closing it (Close, setup done) goes back a tab.
// It runs after app.js, together.js and sing.js and uses their helpers ($, state, load, save, canDo, canPlan,
// isGuest, openSettings, loadPlan, loadSongs, ...). app.js calls in through window.Studio; each of those calls is
// marked "(Studio)" there.
// The mode tabs are calm: 1 Your video, 2 What happens (Sing: the song), the Make button; everything else is folded
// in ONE panel (#makeMore: "Change song, length and extras", or "More options") with a one-line summary of the
// choices, and the recipes behind "Need an idea?". On My videos each card shows its main button or two; the rest
// are under ⋯ (the buttons stay where they are in the card, only folded away).

(() => {
  const TABS = ['make', 'together', 'sing', 'videos', 'plan', 'songs', 'settings'];
  const MODE = { make: 'one', together: 'together', sing: 'sing' }; // each mode tab's button in the old switch (#modeSeg)
  const PANEL = { make: 'panelMake', together: 'panelMake', sing: 'panelMake', videos: 'videos', plan: 'panelPlan',
    songs: 'panelSongs', settings: 'panelSettings' };
  const HEAD = {
    make: ['Make video', 'One animal, one funny video.'],
    together: ['Together', '2 to 4 animals in one funny video.'],
    sing: ['Sing', 'Your animal sings a song, alone or as a duet.'],
  };
  // The names a link may use for a tab (#access: the owner's friends and invites, in Settings).
  const NAMES = { make: 'make', together: 'together', sing: 'sing', videos: 'videos', plan: 'plan', songs: 'songs',
    settings: 'settings', access: 'settings' };
  const nameOf = (x) => (Object.prototype.hasOwnProperty.call(NAMES, x || '') ? NAMES[x] : '');
  const KEY = 'antics.tab';
  const REMEMBER = ['make', 'together', 'sing', 'videos']; // the tabs antics opens on again (the others: Make video)
  const STALE = "This device's connection to your worker is out of date: open your app link here (see the note at the top).";
  const PLAN_RETRY_MS = 10000; // the Posting plan tab tries again this often while the plan didn't load
  const MORE_TITLE = { make: 'Change song, length and extras', together: 'More options', sing: 'More options' };
  const MUSIC_WORDS = { funny: 'Auto meme song', mine: "Video's own sound", none: 'No music' };
  const SING_PART = { meme: 'Meme part', chorus: 'Chorus', whole: 'Whole song' };
  const SING_SHOTS = { cuts: 'Music video', one: 'One shot' };
  // A card's buttons that only ever go under ⋯ (Delete too: its class is "del")
  const MENU_ONLY = /^(Edit|Copy caption|Compare|Try my PC tonight)$/;
  const FRESH_MS = 12000; // how long a video just sent stays picked out in My videos

  const S = {
    tab: 'make', // the tab showing
    back: 'make', // the tab before Settings (where closing Settings goes)
    ready: false,
    switching: false, // show() is changing the mode: renderOptions' sync waits for it
    pending: null, // go()'s options for the show() that openSettings makes
    songsFrom: '', // a song added from a video's Music step: the tab to go back to once it is saved
    fresh: new Map(), // job id -> until when its card is picked out
    freshTimer: 0,
    menu: null, // the job whose ⋯ is open (cards are drawn again on every refresh)
    morePending: false,
    unseen: 0, // videos that got ready while My videos wasn't showing: a "ready" count on its tab until it is opened
    planRetry: 0, // the Posting plan tab's next try, while the plan didn't load
  };

  const isMode = (t) => ['make', 'together', 'sing'].includes(t);
  const owner = () => Boolean(state.worker) && !isGuest();
  // The mode tab of the mode now (Sing first: it sits on top of the other two).
  const modeTab = () => (window.Sing && Sing.on() ? 'sing' : window.Together && Together.on() ? 'together' : 'make');

  // What this device and its worker can use. Before the worker answers, the owner's tabs show (they fill in then).
  function usable(t) {
    if (t === 'together') return Boolean(window.Together && Together.allowed());
    if (t === 'sing') return Boolean(window.Sing && Sing.allowed());
    if (t === 'plan') return owner() && (!state.health || canPlan());
    if (t === 'songs') return owner() && (!state.health || canDo('songs'));
    return TABS.includes(t);
  }

  // A mode tab sets the mode with the old switch's button (together.js and sing.js listen to it).
  function setMode(t) {
    if (modeTab() === t) return;
    const b = document.querySelector(`#modeSeg button[data-v="${MODE[t]}"]`);
    if (b) b.click();
  }

  function tabUrl(t) {
    const q = new URLSearchParams(location.search);
    q.set('tab', t);
    return `${location.pathname}?${q}`;
  }

  // A tab from the address: ?tab=<name>, #tab=<name> or #<name>.
  function linkedTab() {
    const q = new URLSearchParams(location.search).get('tab');
    const h = location.hash.match(/^#(?:tab=)?([a-z]+)$/);
    const name = (h && nameOf(h[1])) || nameOf(q);
    return { name, fromHash: Boolean(h && nameOf(h[1])) };
  }

  // ---------- Showing a tab ----------

  // The user goes to a tab (a tab button, Back). Settings opens through app.js: openSettings() draws it and loads
  // the friends first, then calls show('settings', { drawn: true }).
  function go(t, opts = {}) {
    if (t === 'settings') {
      S.pending = opts;
      try {
        openSettings();
      } finally {
        S.pending = null;
      }
      return;
    }
    show(t, opts);
  }

  // opts.how: 'push' (a new step for Back, the default), 'replace' (the same step), 'none' (Back/Forward did it),
  // 'init' (the first one). opts.focus: the tab's heading takes the focus (a tap on a tab). opts.adding: a song is
  // being added (from a video's Music step: back there once it is saved). opts.drawn: app.js drew Settings.
  function show(tab, opts = {}) {
    if (tab === 'settings' && !opts.drawn) {
      go('settings', opts);
      return;
    }
    opts = { ...(S.pending || {}), ...opts };
    const how = opts.how || 'push';
    let t = TABS.includes(tab) && usable(tab) ? tab : 'make';
    const from = S.tab;
    if (isMode(t)) {
      S.switching = true;
      try {
        setMode(t);
      } finally {
        S.switching = false;
      }
      t = modeTab(); // (what the mode really is now)
    }
    if (opts.adding) S.songsFrom = isMode(from) ? from : '';
    else if (t === 'songs' && from !== 'songs') S.songsFrom = '';
    if (from === 'songs' && t !== 'songs' && previewing.startsWith('song:')) preview.pause();
    if (t === 'settings' && from !== 'settings') S.back = from;
    S.tab = t; // (before Settings closes: its close then knows it was left on purpose)
    document.body.dataset.studio = t; // (the CSS: in Settings, the banners that Settings says itself don't show twice)
    const dlg = $('#settings');
    if (t !== 'settings' && dlg.open) closeDialog(dlg);
    if (t === 'settings' && !dlg.open) dlg.show(); // in place, not over the page
    for (const p of document.querySelectorAll('#studio > .panel')) p.hidden = p.id !== PANEL[t];
    toggleMore(false);
    render();
    if (t !== from) {
      if (t === 'plan' && canPlan()) {
        syncPlanTz(); // (the times are for where this device is)
        loadPlan();
      }
      if (t === 'songs' && owner() && canDo('songs')) loadSongs();
    }
    if (REMEMBER.includes(t)) save(KEY, t);
    if (how === 'push' && t !== from) history.pushState({ ...(history.state || {}), studioTab: t }, '', tabUrl(t));
    else if (how === 'replace' || how === 'push') history.replaceState({ ...(history.state || {}), studioTab: t }, '', tabUrl(t));
    else if (how === 'init') history.replaceState({ ...(history.state || {}), studioTab: t }, '', location.href);
    if (PANEL[t] !== PANEL[from] || opts.focus) {
      window.scrollTo(0, 0);
      if (opts.focus) {
        const head = document.querySelector(`#${PANEL[t]} .panel-title`);
        if (head) head.focus({ preventScroll: true });
      }
    }
  }

  // The tab follows the page: a mode tab follows the mode (two videos picked, an idea tapped, "make my cat sing"),
  // and a tab this worker or this friend can't use goes to Make video.
  function sync() {
    if (!S.ready || S.switching) return;
    let t = S.tab;
    if (isMode(t)) t = modeTab();
    if (!usable(t)) t = 'make';
    if (t !== S.tab) show(t, { how: 'replace' });
    else render();
  }

  // ---------- Drawing the tabs ----------

  function count(el, n, label) {
    if (!el) return;
    el.hidden = !n;
    el.textContent = n ? String(n) : '';
    if (label) el.setAttribute('aria-label', label);
  }

  function render() {
    const cur = S.tab;
    document.querySelectorAll('#tabs [data-tab]').forEach((b) => {
      b.hidden = !usable(b.dataset.tab);
      if (b.dataset.tab === cur) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (cur === 'settings') $('#openSettings').setAttribute('aria-current', 'page');
    else $('#openSettings').removeAttribute('aria-current');
    // Phone: Posting plan and My songs are under More (Settings is ⚙ at the top, and under More too)
    const more = $('#tabMore');
    more.hidden = !['plan', 'songs'].some(usable);
    more.classList.toggle('on', ['plan', 'songs', 'settings'].includes(cur));
    // "Update needed": the owner's worker can't make it yet (the tab still opens, with the update button)
    const togetherOld = Boolean(window.Together && Together.outdated());
    const singOld = Boolean(window.Sing && Sing.outdated());
    $('#togetherNeedTab').hidden = !togetherOld;
    $('#singNeedTab').hidden = !singOld;
    $('#singNeedTab').textContent = singOld && Sing.rebuildNeeded() ? 'Rebuild needed' : 'Update needed';
    // The numbers: videos being made (or, lime with ✓, videos that got ready meanwhile), and videos ready to post
    if (cur === 'videos' && !document.hidden) S.unseen = 0;
    const making = (state.jobs || []).filter((j) => j.status === 'queued' || j.status === 'working').length;
    const vc = $('#videosCount');
    vc.classList.toggle('ready', S.unseen > 0);
    if (S.unseen) count(vc, S.unseen, `${S.unseen} ready to watch`);
    else count(vc, making, `${making} being made`);
    if (S.unseen) vc.textContent = S.unseen > 1 ? `✓${S.unseen}` : '✓';
    const toPost = canPlan() && state.plan ? state.plan.queue.filter((i) => i.status === 'reminded').length : 0;
    count($('#planCount'), toPost, `${toPost} ready to post`);
    count($('#planCountMore'), toPost, `${toPost} ready to post`);
    count($('#moreCount'), toPost, `${toPost} ready to post`);
    // The heading of the mode tabs
    const [title, sub] = HEAD[isMode(cur) ? cur : modeTab()];
    $('#makeTitle').textContent = title;
    $('#makeSub').textContent = sub;
    // Posting plan and My songs before the worker has answered
    const waking = owner() && !state.health;
    const planMissing = canPlan() && !state.plan;
    const planWait = !owner() ? '' : state.keyRefused && (waking || planMissing) ? STALE
      : waking ? 'Waking up your worker… (up to a minute)'
        : planMissing ? (state.planFailed ? "Couldn't get your posting plan. Trying again…" : 'Getting your posting plan…') : '';
    $('#planPanelWait').textContent = planWait;
    $('#planPanelWait').hidden = !planWait || !$('#planBox').hidden;
    $('#planPanelWait').classList.toggle('bad', Boolean(state.keyRefused && planWait));
    // (a plan that didn't load: tried again while its tab shows, not with an out-of-date key)
    if (cur === 'plan' && planMissing && state.planFailed && !state.keyRefused && !S.planRetry) {
      S.planRetry = setTimeout(() => {
        S.planRetry = 0;
        if (S.tab === 'plan' && canPlan() && !state.plan) loadPlan();
      }, PLAN_RETRY_MS);
    }
    $('#songsPanelWait').textContent = waking ? 'Waking up your worker… (up to a minute)' : '';
    $('#songsPanelWait').hidden = !waking || !$('#songsBox').hidden;
    renderFoot();
    renderMore();
  }

  // The bottom of the sidebar: the worker, and today's free AI time (the owner's GPU line from Settings).
  function renderFoot() {
    const w = state.worker;
    const on = Boolean(w && state.online);
    $('#sideDot').classList.toggle('on', on);
    $('#sideWorker').textContent = setupRunning ? $('#setupBusyText').textContent // (an update or setup is running)
      : !w ? 'Not set up yet'
        : isGuest() ? `${hostName()}'s antics${on ? '' : ' · waking up'}`
          : on ? 'Worker running' : 'Worker asleep or starting';
    const line = $('#gpuLine');
    const gpu = $('#sideGpu');
    gpu.hidden = line.hidden || !line.textContent || isGuest() || !w;
    gpu.textContent = gpu.hidden ? '' : line.textContent;
    gpu.classList.toggle('bad', line.classList.contains('bad'));
  }

  function toggleMore(open) {
    const menu = $('#moreMenu');
    if (!menu) return;
    menu.hidden = !open;
    $('#tabMore').setAttribute('aria-expanded', String(open));
  }

  // ---------- The calm steps: one folded panel, its summary, Need an idea? ----------

  // A part of the panel with nothing showing in it (all hidden or empty) is left out, and so is the panel itself.
  function blank(el) {
    if (el.hidden) return true;
    if (el.matches('input, select, textarea, button, img, svg, video, label')) return false;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
    const kids = [...el.children].filter((k) => !k.classList.contains('group-title'));
    return kids.every(blank);
  }

  // "Детство" from "Rauf & Faik - Детство"
  const shortName = (name) => String(name || '').split(/\s[-–—]\s/).pop().trim() || String(name || '');

  function songWords() {
    const music = musicNow();
    if (music === 'mysong') {
      const song = mySong(state.songId);
      return song ? `Song: ${shortName(song.name)} from ${clock(song.start)}` : MUSIC_WORDS.funny;
    }
    if (music === 'track') return `Song: ${songLabel(state.track)}`;
    if (music === 'upload') return state.songFile ? `Song: ${shortName(songNameFrom(state.songFile))}` : 'Song: pick a file';
    return MUSIC_WORDS[music] || '';
  }

  const pressed = (sel) => {
    const b = document.querySelector(`${sel} [aria-pressed="true"]`);
    return b ? ((b.querySelector('b') || b).textContent || '').replace(/\s+/g, ' ').trim() : '';
  };

  // The one line next to the panel's name: what the video gets if nothing is changed.
  function summary(mode) {
    if (mode === 'sing') {
      const p = Sing.peek();
      const look = (Sing.LOOKS.find((l) => l.id === p.look) || {}).name;
      return [SING_PART[p.part], look, SING_SHOTS[p.shots], p.draft && !p.test && 'preview first'].filter(Boolean).join(' · ');
    }
    const n = makeCount();
    const style = mode === 'make' && state.style !== 'random' ? (STYLES.find((x) => x.key === state.style) || {}).label : '';
    const look = mode === 'together' ? pressed('#lookSeg').replace(/^✨\s*/, '') : '';
    return [style, look, songWords(), `${state.clips * 5} s`, n > 1 && `${n} videos`, isDraft() && 'preview first']
      .filter(Boolean).join(' · ');
  }

  // (only what changed is written: the panel is watched for changes, so writing the same again would loop)
  const setHidden = (el, v) => {
    if (el.hidden !== v) el.hidden = v;
  };
  const setText = (el, v) => {
    if (el.textContent !== v) el.textContent = v;
  };

  function renderMore() {
    const mode = isMode(S.tab) ? S.tab : modeTab();
    const sing = mode === 'sing' && Boolean(window.Sing) && !Sing.outdated();
    setHidden($('#singLead'), !sing);
    setHidden($('#singMore'), !sing);
    setHidden($('#styleGroup'), mode === 'sing'); // (Sing has no style: it sings; the old step 2 that held it was hidden)
    setHidden($('#ideasMore'), $('#ideasBox').hidden);
    const panel = $('#makeMore');
    let any = false;
    for (const g of panel.querySelectorAll('.more-group')) {
      const empty = blank(g);
      if (g.classList.contains('blank') !== empty) g.classList.toggle('blank', empty);
      any = any || !empty;
    }
    setHidden(panel, !any);
    setText($('#makeMoreTitle'), MORE_TITLE[mode]);
    let sum = '';
    try {
      sum = any ? summary(mode) : '';
    } catch {
      sum = ''; // (a helper not there yet: the line fills in on the next draw)
    }
    setText($('#makeMoreSum'), sum);
    setHidden($('#makeMoreSum'), !sum);
  }

  // Anything shown or hidden inside the panel (a chip pressed, a line hidden by Sing): its parts and summary again.
  function watchMore() {
    const again = () => {
      if (S.morePending) return;
      S.morePending = true;
      queueMicrotask(() => {
        S.morePending = false;
        renderMore();
      });
    };
    new MutationObserver(again).observe($('#makeMore .more-body'), {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed'],
    });
    new MutationObserver(again).observe($('#ideasBox'), { attributes: true, attributeFilter: ['hidden'] });
  }

  // What a person taps to see `el`, when it is folded away: the panel's heading ("Change song, length and extras",
  // "Need an idea?") or the ⋯ of its card. (null: nothing folds it away)
  function opener(el) {
    if (!el || !el.closest) return null;
    const d = el.closest('details:not([open])');
    const summaryOf = d && d.querySelector(':scope > summary');
    if (d && d !== el && summaryOf && !summaryOf.contains(el)) return summaryOf;
    const item = el.closest('.in-menu');
    const card = item && item.closest('.job');
    if (card && !card.classList.contains('menu-open')) return card.querySelector('.job-more-btn');
    return null;
  }

  // The page shows something folded away (a nudge, a note about it): its panel opens.
  function reveal(el) {
    if (typeof el === 'string') el = document.querySelector(el);
    for (let d = el && el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) {
      d.open = true;
    }
  }

  // ---------- My videos: one or two main buttons a card, the rest under ⋯ ----------

  // The main buttons: Finish (or Make the rest, Animate now, ...), Watch, then Post (+ Plan / In plan) or a retry.
  // A Sing test asks a question: Watch, Yes and No all stay.
  function mainActs(btns, job) {
    const has = (b, c) => b.classList.contains(c);
    const free = (b) => !has(b, 'del') && !MENU_ONLY.test(b.textContent.trim());
    const finish = btns.find((b) => has(b, 'finish'));
    const open = btns.find((b) => has(b, 'open'));
    if (job.kind === 'sing' && job.test && finish) {
      const no = btns.find((b) => /^No\b/.test(b.textContent.trim()));
      return [finish, open, no].filter(Boolean);
    }
    const main = finish || open || btns.find(free);
    if (!main) return [];
    const plan = btns.find((b) => has(b, 'plan-add') || has(b, 'plan-in'));
    const second = main === finish ? open || btns.find((b) => b !== main && free(b))
      : plan || btns.find((b) => b !== main && free(b));
    return [main, second].filter(Boolean);
  }

  function card(c, job) {
    const acts = c.querySelector('.job-actions');
    if (!acts) return;
    const btns = [...acts.children].filter((b) => b.tagName === 'BUTTON');
    const keep = mainActs(btns, job);
    btns.forEach((b) => {
      b.classList.toggle('main-act', b === keep[0]);
      b.classList.toggle('side-act', keep.includes(b) && b !== keep[0]);
      b.classList.toggle('in-menu', !keep.includes(b));
    });
    const rest = btns.filter((b) => !keep.includes(b));
    c.classList.toggle('has-main', keep.length > 0);
    if (!rest.length) return;
    const open = S.menu === job.id;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'job-more-btn';
    more.setAttribute('aria-label', `More: ${rest.map((b) => b.textContent.trim()).join(', ')}`);
    more.setAttribute('aria-expanded', String(open));
    more.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="2.2" fill="currentColor"/>'
      + '<circle cx="12" cy="12" r="2.2" fill="currentColor"/><circle cx="19" cy="12" r="2.2" fill="currentColor"/></svg>';
    more.dataset.job = job.id;
    acts.after(more);
    c.classList.toggle('menu-open', open);
  }

  function setMenu(id) {
    S.menu = id;
    document.querySelectorAll('#jobs .job').forEach((c) => {
      const on = Boolean(id) && c.dataset.id === id;
      c.classList.toggle('menu-open', on);
      const b = c.querySelector('.job-more-btn');
      if (b) b.setAttribute('aria-expanded', String(on));
    });
  }

  // ---------- What app.js calls ----------

  // Videos were just sent: My videos opens with their cards picked out (they are at the top).
  function made(ids) {
    const until = Date.now() + FRESH_MS;
    S.fresh.clear();
    ids.forEach((id) => S.fresh.set(id, until));
    show('videos');
    renderJobs();
    clearTimeout(S.freshTimer);
    S.freshTimer = setTimeout(() => {
      S.fresh.clear();
      document.querySelectorAll('#jobs .job.fresh').forEach((c) => c.classList.remove('fresh'));
    }, FRESH_MS);
  }

  const fresh = (id) => (S.fresh.get(id) || 0) > Date.now();

  // Videos got ready while My videos wasn't showing (app.js announceReady): a ✓ on its tab until it is opened.
  function readyCue(n) {
    S.unseen += n;
    render();
  }

  // A song added from a video's Music step (+ Add a song) is saved: back to that video, with the song in step 3.
  function songSaved() {
    const back = S.songsFrom;
    S.songsFrom = '';
    if (back && S.tab === 'songs') show(back);
  }

  // ---------- Start ----------

  function init() {
    // Which tab: one a link names, the plan or a video from a notification, or the one from last time (a mode tab
    // is the mode from last time: together.js and sing.js remember that).
    const link = linkedTab();
    let t = link.name;
    const named = link.fromHash || new URLSearchParams(location.search).has('tab'); // (the address then says ?tab=)
    if (!t && (state.openPost || state.openPlan)) t = 'plan';
    if (!t && state.openVideo) t = 'videos';
    if (!t) {
      t = load(KEY, 'make');
      if (!REMEMBER.includes(t)) t = 'make'; // (an older version remembered Settings, My songs and Posting plan too)
      if (isMode(t)) t = modeTab();
    }

    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) {
        if (b.dataset.tab === S.tab) window.scrollTo({ top: 0, behavior: 'smooth' }); // (tapping the tab you're on)
        else go(b.dataset.tab, { focus: true });
        toggleMore(false);
      }
    });
    $('#tabMore').addEventListener('click', () => toggleMore($('#moreMenu').hidden));
    document.addEventListener('click', (e) => {
      if (!$('#moreMenu').hidden && !e.target.closest('#moreMenu, #tabMore')) toggleMore(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleMore(false);
    });
    $('#jumpVideos').addEventListener('click', (e) => {
      e.preventDefault();
      show('videos', { focus: true });
    });
    $('#emptyMake').addEventListener('click', () => show(modeTab(), { focus: true }));
    // Under the Make button: "Only the first 5 s… Change" opens the panel at Quick preview first
    $('#makeHintChange').addEventListener('click', () => {
      reveal('#previewLine');
      $('#previewLine').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#previewOpt').focus({ preventScroll: true });
    });
    // An update or setup running while another tab shows: its steps are in Settings
    $('#setupBusyBtn').addEventListener('click', () => go('settings', { focus: true }));
    // A card's ⋯: opens its menu (one at a time); a tap on one of its buttons, anywhere else or Escape closes it.
    document.addEventListener('click', (e) => {
      const more = e.target.closest('.job-more-btn');
      if (more) setMenu(S.menu === more.dataset.job ? null : more.dataset.job);
      else if (S.menu) setMenu(null);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.menu) setMenu(null);
    });
    watchMore();
    // Settings closed by itself (setup done, Close, Leave this invite): back to the tab before it. (A mode tab is the
    // mode now: Settings' "Test again" turns Sing on.)
    $('#settings').addEventListener('close', () => {
      if (S.tab !== 'settings' || $('#settings').open) return;
      const back = S.back && S.back !== 'settings' ? S.back : 'make';
      show(isMode(back) ? modeTab() : back);
    });
    window.addEventListener('popstate', (e) => {
      // Back with a player, editor or Post screen open over the page: it closes, and the tab stays (like a phone's back
      // gesture). (Only for the tabs' own steps: a link's #app= or #video= is a step of its own.)
      const over = topDialog();
      if (over && e.state && e.state.studioTab) {
        closeDialog(over);
        history.pushState({ ...(history.state || {}), studioTab: S.tab }, '', tabUrl(S.tab));
        return;
      }
      const want = (e.state && e.state.studioTab) || nameOf(new URLSearchParams(location.search).get('tab'));
      if (want && want !== S.tab) go(want, { how: 'none' });
    });

    S.ready = true;
    S.tab = 'make'; // (the page starts on Make video: index.html shows only that panel)
    go(t, { how: named ? 'replace' : 'init' }); // (#songs and ?tab=nonsense are done with: the address says ?tab=<the tab>)
  }

  window.Studio = {
    show, go, sync, made, fresh, readyCue, songSaved, card, reveal, opener,
    current: () => S.tab,
    previous: () => S.back,
    // (for tests and the browser console)
    peek: () => ({ tab: S.tab, back: S.back, mode: modeTab(), songsFrom: S.songsFrom, usable: TABS.filter(usable), menu: S.menu, unseen: S.unseen,
      more: $('#makeMore').open, summary: $('#makeMoreSum').textContent }),
  };
  init();
})();
