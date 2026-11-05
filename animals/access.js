// access.js
// antics "Ask for access" (v15, workers that list 'access' in /health). antics is TENDHA2's private tool, so a device
// that isn't connected (no worker saved here, no #join= or #app= link) sees only the locked screen: TENDHA2's picture,
// "antics is TENDHA2's private tool", a big Ask for access button, and two small links: "I have an invite link" (the
// paste-a-link box) and "I'm TENDHA2" (the setup, which refuses every Hugging Face account but TENDHA2's). Ask for
// access sends a name and a short note to TENDHA2's worker, and TENDHA2 gets a notification. While the page is open it
// asks the worker every 30 s; once TENDHA2 said yes (5, 6 or 10 videos) it connects by itself as that friend. TENDHA2
// sees the requests in Settings ("Requests": Approve 5 · 6 · 10 or Deny, "Say no to all" when several wait; a request
// whose name is a friend's can be let in as that friend again), a badge on the gear while someone waits, and the
// notification opens that box (index.html#access). While someone waits the box sits at the top of Settings, above
// everything that loads later, so the notification's tap lands on it; otherwise it is in Friends. Once let in, the new
// friend is asked once to keep their invite link (it is how they come back on another phone or after clearing the
// browser), and "Leave this invite" copies it for them first. When TENDHA2 removes such a friend later, their phone
// is locked again (their key is refused: app.js refreshJobs asks inviteEnded) and they can ask once more.
// It runs after app.js and uses its helpers ($, state, api, load, save, isGuest, canDo, useLink, workerChanged,
// openSettings, loadFriends, toast, note, ...). app.js calls in through window.Access ("(Access)" there); index.html
// marks the locked screen before anything shows (html.locked), so a stranger never sees the app behind it.
//
// The worker's side (worker/access.py), as this page uses it:
//   POST /access/request         public, JSON {name: 1-20 characters, note: 0-120, website: '' (a honeypot)}
//                                -> {id, token} (the token is this phone's secret; the same name from the same place
//                                again is the same request, with a new token); 429 {detail} (3 a day from one place,
//                                10 a day in all, 20 waiting at most), 400 on bad input, 403 from another website
//                                (Origin), 415 when it isn't application/json; a waiting request is dropped after 3 days
//   GET  /access/status?token=   public: {status: pending|approved|denied|unknown, invite: {url, key, name, host}
//                                only when approved}
//   GET  /access/requests        owner only: {requests: [{id, name, note, at, status, known?: {id, name, uses_left,
//                                used} (a friend of that name), again?}]} (waiting first, newest first)
//   POST /access/requests/{id}   owner only, JSON {approve: true, uses: 5|6|10} (a new friend, as POST /guests),
//                                {approve: true, friend: <friend id>} (that friend again: a request's `known`) or
//                                {approve: false}; 404 no such request, 409 already answered
//   POST /access/deny-all        owner only: no to everyone waiting -> {denied}
// 429 answers say why (from one place, a lot today, a lot waiting); this page shows the worker's words.

(() => {
  // TENDHA2's worker. Its Space is public anyway; the page needs no key to ask it for access.
  const OWNER_WORKER = 'https://tendha-antics-worker.hf.space';
  const KEY = 'antics.access'; // this phone's request: {token, id, name, at, status}
  const KEEP_LINK = 'antics.keepLink'; // the key of a friend just let in who hasn't kept their invite link yet
  const POLL = 30000; // ms between checks while the page is open
  const DAY = 24 * 3600 * 1000;
  const USES = [5, 6, 10];
  const NAME_MAX = 20;
  const NOTE_MAX = 120;
  const WORKER_URL = /^https:\/\/[a-z0-9-]+\.hf\.space$/; // (as parseLink in app.js)
  const FRIEND_KEY = /^[a-f0-9]{16,64}$/;

  // The locked screen. access: does TENDHA2's worker take requests? true, false (an older worker: invite links only)
  // or null (it didn't answer: asleep or offline; the button stays and Send says so). gone: the note over Ask for access
  // ('' none; a request that ran out, or an invite TENDHA2 ended).
  const lock = { view: 'start', access: null, checked: false, checking: false, linkOpen: false, timer: 0, sending: false,
    asking: false, gone: '', boxTitle: '', boxFine: null };
  const RAN_OUT = 'Your request ran out. Ask again.';
  // The owner's requests (Settings, Friends): the list once loaded (null: none loaded, or a worker without 'access').
  const asks = { list: null, at: 0, loading: null, again: false, worker: undefined, open: false, busy: new Set(), failed: '',
    allBusy: false };

  const mine = () => load(KEY, null);
  const keep = (rec) => save(KEY, rec);
  const owner = () => Boolean(state.worker) && !isGuest();
  const host = () => BRAND.name;
  const clean = (text) => String(text || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

  // "just now", "5 min ago", "3 h ago", "2 days ago". at: unix seconds (as the worker keeps time) or ms.
  function ago(at) {
    const ms = typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at || '');
    if (!Number.isFinite(ms)) return '';
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  // TENDHA2's worker, without a key. {ok, status, body}; throws {waking} when the Space answers with a page.
  async function call(path, opts = {}) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 15000);
    try {
      const res = await fetch(OWNER_WORKER + path, { cache: 'no-store', ...opts, signal: stop.signal });
      if (!(res.headers.get('content-type') || '').includes('application/json')) {
        throw Object.assign(new Error('waking'), { waking: true });
      }
      return { ok: res.ok, status: res.status, body: await res.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- The locked screen ----------

  // Called by app.js (renderConnect) whenever this device's worker may have changed, and once when this file loads.
  function render() {
    const locked = !state.worker;
    document.documentElement.classList.toggle('locked', locked);
    // (hidden by the stylesheet too; inert: nothing behind the locked screen can be reached with Tab)
    document.querySelectorAll('body > .bar, body > .banner-wrap, body > main').forEach((el) => { el.inert = locked; });
    const box = $('#connectBox');
    const slot = $('#lockLinkSlot');
    const title = $('#connectBox .step-title');
    const fine = $('#connectBox p.fine'); // ("Get it in your browser: ... Copy app link": the owner's words)
    if (!lock.boxTitle) lock.boxTitle = title.textContent; // ("Connect this app": the Home Screen app's own words)
    if (lock.boxFine === null) lock.boxFine = fine.innerHTML;
    if (locked) {
      if (box.parentNode !== slot) slot.appendChild(box);
      box.hidden = !(standalone() || lock.linkOpen);
      box.classList.add('in-lock');
      title.textContent = standalone() ? lock.boxTitle : 'Paste your invite link';
      // (no ⚙ on the locked screen, and a friend's button is "Copy my invite link")
      fine.textContent = standalone()
        ? `In your browser: open antics, tap ⚙, then Copy my invite link (${host()}: Copy app link), and paste it here. New? Paste the invite link ${host()} sent you.`
        : `Paste the whole invite link ${host()} sent you. Already in on another phone? Open antics there, tap ⚙, then Copy my invite link.`;
      if (!lock.checked) checkAccess();
      renderLock();
      startPolling();
    } else {
      if (box.parentNode === slot) $('.banner-wrap').appendChild(box);
      box.classList.remove('in-lock');
      title.textContent = lock.boxTitle;
      fine.innerHTML = lock.boxFine; // (this page's own markup)
      lock.linkOpen = false;
      lock.view = 'start';
      stopPolling();
      if (mine()) keep(null); // (connected: this phone's request isn't needed anymore)
    }
    if (asks.worker !== state.worker) { // another worker here: its own requests
      asks.worker = state.worker;
      asks.list = null;
      asks.at = 0;
      asks.failed = '';
    }
    renderAsks();
    renderBadge();
    renderKeep();
  }

  function renderLock() {
    if (state.worker) return;
    const rec = mine();
    let view = lock.view;
    if (rec) view = rec.status === 'denied' ? 'denied' : 'sent';
    else if (view !== 'form') view = 'start';
    if (!rec && lock.access === false) view = 'only'; // an older worker: no form, just ask for a link
    $('#lockAsk').hidden = view !== 'start';
    $('#lockOnly').hidden = view !== 'only';
    $('#lockForm').hidden = view !== 'form';
    $('#lockSent').hidden = view !== 'sent';
    $('#lockDenied').hidden = view !== 'denied';
    $('#lockGone').hidden = !(lock.gone && view === 'start');
    if (lock.gone) $('#lockGone').textContent = lock.gone;
    if (view === 'sent') {
      const when = ago(rec.at);
      $('#lockSentFine').textContent = `Asked as ${rec.name}${when ? ` ${when}` : ''}. This page opens antics by itself once ${host()} says yes.`;
    }
    if (view === 'denied') {
      const again = Date.now() - (Number(rec.at) || 0) >= DAY;
      $('#lockAgain').hidden = !again;
      $('#lockDeniedFine').textContent = again ? 'You can ask again.' : 'You can ask again tomorrow.';
    }
    $('#lockMoved').hidden = !onTestAddress();
    $('#lockHaveLink').hidden = !$('#connectBox').hidden;
  }

  async function checkAccess() {
    if (lock.checking) return;
    lock.checking = true;
    try {
      const { ok, body } = await call('/health');
      lock.access = ok ? (body.features || []).includes('access') : null;
      lock.checked = ok;
    } catch {
      lock.access = null; // asleep or offline: asked again next time the screen locks
    } finally {
      lock.checking = false;
    }
    renderLock();
  }

  function openForm() {
    lock.view = 'form';
    lock.gone = '';
    note($('#lockFormNote'), '');
    renderLock();
    $('#lockName').focus();
    if (!lock.checked) checkAccess();
  }

  function closeForm() {
    lock.view = 'start';
    renderLock();
    $('#lockAskBtn').focus();
  }

  async function send(e) {
    e.preventDefault();
    if (lock.sending) return;
    const msg = $('#lockFormNote');
    const name = clean($('#lockName').value);
    const text = clean($('#lockNote').value);
    if (!name) {
      note(msg, 'Type your name first.', 'bad');
      $('#lockName').focus();
      return;
    }
    if (name.length > NAME_MAX) {
      note(msg, `Your name can have ${NAME_MAX} letters at most.`, 'bad');
      $('#lockName').focus();
      return;
    }
    if (text.length > NOTE_MAX) {
      note(msg, `The note can have ${NOTE_MAX} letters at most.`, 'bad');
      $('#lockNote').focus();
      return;
    }
    const btn = $('#lockSend');
    lock.sending = true;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    note(msg, '');
    try {
      const res = await call('/access/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note: text, website: $('#lockWebsite').value }),
      });
      if (!res.ok || !res.body.token) {
        const detail = res.body && typeof res.body.detail === 'string' ? res.body.detail : '';
        throw Object.assign(new Error(detail || 'Check your name and note, then try again.'), { status: res.status });
      }
      keep({ token: String(res.body.token), id: String(res.body.id || ''), name, at: Date.now(), status: 'pending' });
      lock.view = 'start';
      $('#lockNote').value = '';
      renderLock();
      startPolling();
    } catch (err) {
      note(msg, err.waking ? `${host()}'s antics is waking up. Try again in a minute.`
        : err.status ? err.message : "Can't reach antics right now. Check your internet and try again.", 'bad');
    } finally {
      lock.sending = false;
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  }

  function askAgain() {
    const rec = mine();
    if (rec && rec.name) $('#lockName').value = rec.name;
    keep(null);
    openForm();
  }

  function startPolling() {
    if (lock.timer || state.worker || !mine()) return;
    lock.timer = setInterval(() => {
      if (!document.hidden) checkStatus();
    }, POLL);
  }

  function stopPolling() {
    clearInterval(lock.timer);
    lock.timer = 0;
  }

  // Has TENDHA2 answered? On load, every 30 s while the page is open, and when it comes back on screen.
  async function checkStatus() {
    if (state.worker || lock.asking) return;
    // Another tab of this browser got in meanwhile (let in, or an invite link): use that.
    const saved = load(KEYS.worker, null);
    if (saved && saved.url && saved.key) {
      state.worker = saved;
      workerChanged();
      return;
    }
    const rec = mine();
    if (!rec || !rec.token) {
      stopPolling();
      return;
    }
    lock.asking = true;
    let res = null;
    try {
      res = await call(`/access/status?token=${encodeURIComponent(rec.token)}`);
    } catch {
      // asleep or offline: next time
    } finally {
      lock.asking = false;
    }
    if (!res || !res.ok || state.worker || (mine() || {}).token !== rec.token) return;
    const status = res.body.status;
    if (status === 'approved') {
      letIn(rec, res.body.invite, res.body.uses);
    } else if (status === 'denied') {
      if (rec.status !== 'denied') keep({ ...rec, status: 'denied' });
      stopPolling();
      renderLock();
    } else if (status === 'unknown') { // (gone: too old, or the worker forgot it)
      keep(null);
      lock.gone = RAN_OUT;
      stopPolling();
      renderLock();
    }
  }

  // TENDHA2 said yes: this phone becomes that friend (as an invite link would).
  function letIn(rec, invite, uses) {
    const inv = invite || {};
    if (!FRIEND_KEY.test(inv.key || '')) return; // (a broken answer: next time)
    // The worker's own address when it names a Space; else TENDHA2's worker, which this page just asked (a worker that
    // doesn't know its address, e.g. without SPACE_HOST, names the address it was reached by, maybe http://...).
    const url = WORKER_URL.test(inv.url || '') ? inv.url : OWNER_WORKER;
    keep(null);
    stopPolling();
    const worker = { url, key: inv.key, guest: true, name: clean(inv.name) || rec.name, host: clean(inv.host) || host() };
    save(KEEP_LINK, worker.key); // ("Keep your invite link", until it is copied or put away)
    useLink({ kind: 'join', worker }, false);
    workerChanged();
    welcome(worker, Number(uses) || 0);
  }

  // A friend just let in has no invite link anywhere: without it, another phone, the Home Screen app or a cleared
  // browser means asking again. Shown until they copy it or tap OK.
  function renderKeep() {
    const el = $('#keepLink');
    if (!el) return;
    const w = state.worker;
    el.hidden = !(w && w.guest && w.key && load(KEEP_LINK, null) === w.key);
  }

  async function keepLink(copy) {
    if (copy) await copyText(myInviteLink(), 'Copied your invite link. Keep it somewhere safe, like Notes.');
    save(KEEP_LINK, null);
    renderKeep();
  }

  // "You're in! TENDHA2 gave you 5 videos." (the friend's own numbers, else the ones the answer said)
  async function welcome(worker, uses) {
    const say = (n) => toast(n ? `You're in! ${hostName()} gave you ${n} video${n === 1 ? '' : 's'}.` : `You're in! ${hostName()} let you in.`);
    for (let i = 0; i < 3; i++) {
      if (state.worker !== worker) return;
      try {
        const me = await api('/me');
        say((Number(me.uses_left) || 0) + (Number(me.used) || 0) || uses);
        return;
      } catch {
        if (uses) break; // (the answer said how many: no need to wait for the worker)
        await sleep(2000);
      }
    }
    if (state.worker === worker) say(uses);
  }

  // (app.js refreshJobs: TENDHA2's worker refused this friend's key, so TENDHA2 removed them.) A phone with nothing to go
  // back to is locked again, with Ask for access. A friend's invite on the owner's own phone keeps "Leave this invite",
  // and so does a friend of another worker. True when it locked.
  function inviteEnded() {
    const w = state.worker;
    if (!w || !w.guest || w.url !== OWNER_WORKER || load(KEYS.ownerBackup, null)) return false;
    state.worker = null;
    save(KEYS.worker, null);
    keep(null);
    lock.view = 'start';
    lock.gone = `${host()} ended your invite. You can ask for access again.`;
    $('#wakeNote').hidden = true;
    if ($('#settings').open) closeDialog($('#settings')); // (a friend's Settings: nothing of it is theirs anymore)
    workerChanged();
    return true;
  }

  function openLinkBox() {
    lock.linkOpen = true;
    render();
    $('#connectLink').focus();
  }

  // ---------- The owner: Requests in Settings, Friends ----------

  async function loadAsks(force = false) {
    if (!owner()) return;
    if (asks.loading) {
      if (force) asks.again = true; // (a newer request may have come in after this load began)
      return;
    }
    if (!force && Date.now() - asks.at < 25000) return;
    const w = state.worker;
    asks.at = Date.now();
    asks.loading = (async () => {
      try {
        const { requests } = await api('/access/requests');
        if (state.worker !== w) return;
        asks.list = Array.isArray(requests) ? requests : [];
        asks.failed = '';
      } catch (e) {
        if (state.worker !== w) return;
        if (e.status === 404 || e.status === 403) asks.list = null; // an older worker: no requests
        else asks.failed = e.waking ? 'Your worker is waking up. Requests show up in a moment.' : e.message;
      }
    })();
    try {
      await asks.loading;
    } finally {
      asks.loading = null;
    }
    renderAsks();
    renderBadge();
    if (asks.again) {
      asks.again = false;
      loadAsks(true);
    }
  }

  function button(label, cls, aria, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  }

  function askRow(r) {
    const row = document.createElement('div');
    row.className = 'friend-row access-row';
    row.dataset.id = r.id;
    const who = document.createElement('div');
    who.className = 'access-who';
    const name = document.createElement('b');
    name.textContent = r.name || 'Someone';
    const when = ago(r.at);
    who.append(name, document.createTextNode(when ? ` · ${when}` : ''));
    if (r.note) {
      const said = document.createElement('p');
      said.className = 'access-said';
      said.textContent = `“${r.note}”`;
      who.append(said);
    }
    const known = r.known && r.known.id ? r.known : null; // (a friend has this name: them on a new phone?)
    if (known) {
      const left = Number(known.uses_left) || 0;
      const was = document.createElement('p');
      was.className = 'access-known';
      was.textContent = `A friend named ${known.name || r.name} is already in (${left} of ${left + (Number(known.used) || 0)} videos left). New phone? Let them in again: same videos, none added.`;
      who.append(was);
    }
    const acts = document.createElement('div');
    acts.className = 'access-acts';
    const label = document.createElement('span');
    label.className = 'access-label';
    label.textContent = 'Approve';
    const seg = document.createElement('div');
    seg.className = 'seg';
    const busy = asks.busy.has(r.id);
    for (const n of USES) {
      const b = button(String(n), '', `Approve ${r.name} with ${n} videos`, () => decide(r, n));
      b.dataset.uses = String(n);
      b.disabled = busy;
      seg.append(b);
    }
    const deny = button('Deny', 'plain danger', `Deny ${r.name}`, () => decide(r, 0));
    deny.disabled = busy;
    acts.append(label, seg, deny);
    row.append(who, acts);
    if (known) {
      const again = button('Let in again', 'plain access-again', `Let ${r.name} in again as your friend ${known.name || r.name}`, () => decide(r, 0, known));
      again.disabled = busy;
      row.append(again);
    }
    return row;
  }

  function doneRow(r) {
    const row = document.createElement('div');
    row.className = 'friend-row access-row done';
    row.dataset.id = r.id;
    const name = document.createElement('b');
    name.textContent = r.name || 'Someone';
    const when = ago(r.at);
    const what = r.status !== 'approved' ? 'said no' : r.removed ? 'let in, then removed' : r.again ? 'let in again' : 'let in';
    row.append(name, document.createTextNode(` · ${what}${when ? ` · asked ${when}` : ''}`));
    return row;
  }

  // While someone waits: at the top of Settings, under its title (nothing above it loads later and pushes it away;
  // the plan, songs and singing boxes all come below). Otherwise in Friends, before Create link.
  function placeBox(box, top) {
    const pane = $('#optionsPane');
    const head = pane.querySelector(':scope > h2');
    if (top && head && box.previousElementSibling !== head) head.after(box);
    if (!top && box.nextElementSibling !== $('#friendAdd')) $('#friendAdd').before(box);
    box.classList.toggle('on-top', Boolean(top && head));
  }

  function renderAsks() {
    const box = $('#accessBox');
    if (!box) return;
    const show = owner() && (canDo('access') || asks.list !== null);
    box.hidden = !show;
    if (!show) {
      placeBox(box, false);
      return;
    }
    const list = asks.list || [];
    const waiting = list.filter((r) => r.status === 'pending');
    placeBox(box, waiting.length > 0);
    const all = $('#accessDenyAll');
    all.hidden = waiting.length < 2;
    all.textContent = `Say no to all ${waiting.length}`;
    all.disabled = asks.allBusy;
    const done = list.filter((r) => r.status === 'approved' || r.status === 'denied').slice(0, 5);
    $('#accessCount').textContent = waiting.length ? `· ${waiting.length} waiting` : '';
    const rows = $('#accessRows');
    rows.innerHTML = '';
    waiting.forEach((r) => rows.append(askRow(r)));
    done.forEach((r) => rows.append(doneRow(r)));
    $('#accessEmpty').hidden = waiting.length > 0 || asks.list === null;
    note($('#accessNote'), asks.failed, asks.failed ? 'bad' : '');
    if (asks.open && asks.list !== null && $('#settings').open) { // (from the notification)
      asks.open = false;
      box.scrollIntoView({ block: 'start' });
      box.classList.remove('flash');
      void box.offsetWidth; // (restart the flash)
      box.classList.add('flash');
    }
  }

  function renderBadge() {
    const n = owner() && asks.list ? asks.list.filter((r) => r.status === 'pending').length : 0;
    const badge = $('#accessBadge');
    if (!badge) return;
    badge.hidden = !n;
    badge.textContent = n > 9 ? '9+' : String(n);
    $('#openSettings').setAttribute('aria-label', n ? `Settings (${n} asked for access)` : 'Settings');
  }

  // uses: 5, 6 or 10 (Approve), 0 (Deny); known: the friend of that name (Let in again: no new friend).
  async function decide(r, uses, known = null) {
    if (asks.busy.has(r.id)) return;
    if (!uses && !known && !confirm(`Say no to ${r.name}? They can ask again tomorrow.`)) return;
    asks.busy.add(r.id);
    renderAsks();
    try {
      const body = known ? { approve: true, friend: known.id } : uses ? { approve: true, uses, host: BRAND.name } : { approve: false };
      const res = await api(`/access/requests/${encodeURIComponent(r.id)}`, jsonPost(body));
      r.status = uses || known ? 'approved' : 'denied';
      const left = res.friend ? Number(res.friend.uses_left) || 0 : 0;
      toast(known ? `${r.name} is in again, with ${left} video${left === 1 ? '' : 's'} left.`
        : uses ? `${r.name} is in, with ${uses} videos.` : `You said no to ${r.name}.`);
      if (uses || known) {
        friendsChanged++;
        loadFriends(); // (the new friend shows up in the list below)
      }
    } catch (e) {
      toast(e.status === 404 ? 'That request is gone.' : e.status === 409 ? 'That request was already answered.'
        : e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message);
    } finally {
      asks.busy.delete(r.id);
    }
    renderAsks();
    renderBadge();
    loadAsks(true);
  }

  // "Say no to all 12": one tap (and one question) for a flood of requests.
  async function denyAll() {
    const n = (asks.list || []).filter((r) => r.status === 'pending').length;
    if (!n || asks.allBusy || !confirm(`Say no to all ${n} people waiting? They can ask again tomorrow.`)) return;
    asks.allBusy = true;
    renderAsks();
    try {
      const res = await api('/access/deny-all', { method: 'POST' });
      const d = Number(res.denied) || 0;
      toast(`You said no to ${d} ${d === 1 ? 'person' : 'people'}.`);
    } catch (e) {
      toast(e.waking ? 'Your worker is waking up. Try again in a minute.' : e.message);
    } finally {
      asks.allBusy = false;
    }
    renderAsks();
    loadAsks(true);
  }

  // The notification (index.html#access): Settings, at the Requests box.
  function openBox() {
    if (!owner()) return;
    asks.open = true;
    if (!$('#settings').open) openSettings(); // (it loads the requests: settingsOpened)
    else loadAsks(true);
  }

  // app.js openFromLink: true when the link was for the Requests box.
  function fromLink(url) {
    if (!/#access$/.test(String(url || ''))) return false;
    if (location.hash === '#access') history.replaceState(null, '', location.pathname + location.search);
    openBox();
    return true;
  }

  function wire() {
    $('#lockAskBtn').addEventListener('click', openForm);
    $('#lockBack').addEventListener('click', closeForm);
    $('#lockForm').addEventListener('submit', send);
    $('#lockAgain').addEventListener('click', askAgain);
    $('#lockHaveLink').addEventListener('click', openLinkBox);
    $('#lockOwner').addEventListener('click', openSettings);
    $('#accessDenyAll').addEventListener('click', denyAll);
    $('#keepLinkCopy').addEventListener('click', () => keepLink(true));
    $('#keepLinkOk').addEventListener('click', () => keepLink(false));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.worker) checkStatus();
    });
    window.addEventListener('online', () => {
      if (!state.worker) checkStatus();
    });
    window.addEventListener('storage', (e) => { // (another tab of this browser was let in)
      if (e.key === KEYS.worker && e.newValue && !state.worker) checkStatus();
    });
  }

  window.Access = {
    render,
    fromLink,
    inviteEnded,
    // (app.js connectWith) the locked screen's words for a wrong link ('' elsewhere: app.js has its own)
    badLinkText: () => ($('#connectBox').classList.contains('in-lock') ? "That isn't an antics link. Copy the whole link and paste it here." : ''),
    // (app.js leaveInvite) A friend on TENDHA2's worker with nothing to go back to: their invite link is copied for
    // them first, and the question says so ('' for anyone else: app.js asks its own question).
    async leaveQuestion() {
      const w = state.worker;
      if (!w || !w.guest || w.url !== OWNER_WORKER || load(KEYS.ownerBackup, null)) return '';
      await copyText(myInviteLink(), 'Copied your invite link', $('#settings').open ? $('#settings') : document.body);
      save(KEEP_LINK, null);
      return 'Your invite link is copied. Keep it (paste it in Notes, for example): you need it to come back.\n\nLeave this invite? Your videos stay.';
    },
    // Settings opened (app.js openSettings): the owner's requests, fresh.
    settingsOpened() {
      renderAsks();
      if (owner()) loadAsks(true);
    },
    // A new /health answer (app.js refreshHealth): the owner's requests now and then, and the gear's badge.
    healthChanged() {
      if (owner() && canDo('access')) loadAsks(false);
      renderAsks();
      renderBadge();
    },
    // A notification came while antics is open (someone may have just asked).
    pinged() {
      if (owner() && canDo('access')) loadAsks(true);
    },
    peek: () => ({ lock: { ...lock, timer: Boolean(lock.timer) }, mine: mine(), asks: { list: asks.list, at: asks.at, failed: asks.failed },
      keep: load(KEEP_LINK, null) }),
  };

  wire();
  render();
  if (!state.worker && mine()) checkStatus(); // (on load: maybe TENDHA2 said yes meanwhile)
  if (location.hash === '#access') fromLink(location.hash); // (app.js read the address before this file loaded)
})();
