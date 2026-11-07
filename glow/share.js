/* Glow Studio — "Share with friends" (share.js), the host's card in the Windows app (AI Scenes and the setup page).
 *
 * The host lets friends make AI Scenes videos from their own phone or computer while the video is made on THIS PC's
 * graphics card, for free. The launcher does the work (a separate guest server, Cloudflare's free quick tunnel or the
 * home Wi-Fi, the queue, the "AI-generated" label inside every picture and clip); this card only talks to the
 * launcher's host API, /__glow/share/* (127.0.0.1 only, never reachable by friends):
 *   GET status · POST start / stop / settings / new-link · POST guests/<id>/block · POST jobs/<id>/approve|decline|cancel
 *   GET jobs/<id>/thumb (the selfie thumbnail, only while a video waits for approval)
 *
 *   GlowShare.mount(element, { where: 'ai'|'setup', onChange(status) }) -> { refresh(), unmount() }
 *   GlowShare.status   the last status (null before the first answer)
 *   GlowShare.active() true while sharing is starting, on or closing (friends may be using the AI)
 *
 * Everything a friend typed (their name) is shown with textContent only. Plain classic script, no libraries
 * (the QR code comes from qr.js).
 */
(function () {
  'use strict';
  var API = '/__glow/share/';
  var T = (window.__GLOW_SHARE_TEST__ && typeof window.__GLOW_SHARE_TEST__ === 'object') ? window.__GLOW_SHARE_TEST__ : {};
  var POLL = T.pollMs || 2000, POLL_HIDDEN = T.hiddenPollMs || 10000;
  var LIMITS = [1, 2, 3, 5, 10, 20], HOURS = [1, 4, 12];
  var PREF = 'glow.share.prefs';

  function lsGet() { try { return JSON.parse(localStorage.getItem(PREF) || 'null') || {}; } catch (e) { return {}; } }
  function lsSet(v) { try { localStorage.setItem(PREF, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function svg(path) { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = path; return s; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(t) { var d = new Date(t); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function left(t) {
    var ms = new Date(t) - Date.now(); if (!(ms > 0)) return 'any moment';
    var m = Math.round(ms / 60000), hh = Math.floor(m / 60), mm = m % 60;
    return hh ? hh + ' h' + (mm ? ' ' + mm + ' min' : '') : Math.max(1, mm) + ' min';
  }
  function ago(t) {
    var m = Math.round((Date.now() - new Date(t)) / 60000);
    return !(m >= 1) ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function req(method, path, body) {
    var init = { method: method, cache: 'no-store', credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
    return fetch(API + path, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (r.ok) return d;
        var e = new Error((d && d.message) || 'HTTP ' + r.status); e.code = (d && d.error) || 'http-' + r.status; e.status = r.status; throw e;
      });
    });
  }
  var SOUND = { music: 'Built-in music', ai: 'AI song', own: 'their own song' };

  var CSS = [
    '.gs{--gs-line:var(--line-2,rgba(255,255,255,.16));--gs-mut:var(--muted,#aca6c7);--gs-surf:var(--surface,rgba(255,255,255,.045));color:var(--text,#f7f4ff);min-width:0}',
    '.gs-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}',
    '.gs-h h2{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em;flex:1 1 auto;min-width:0}',
    '.gs-ico{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(255,79,163,.28),rgba(34,211,238,.24));flex:0 0 auto}',
    '.gs-ico svg,.gs svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.gs-pill{font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:var(--gs-surf);border:1px solid var(--gs-line);color:var(--gs-mut);white-space:nowrap}',
    '.gs-pill.on{color:#0b2a1c;background:#5eead4;border-color:transparent}.gs-pill.wait{color:#fde68a}.gs-pill.bad{color:#fecaca;border-color:rgba(248,113,113,.5)}',
    '.gs p{margin:6px 0;font-size:13.5px;line-height:1.5;color:var(--gs-mut)}.gs b{color:var(--text,#f7f4ff)}',
    '.gs-f{display:grid;gap:12px;margin:12px 0 0}.gs-field{display:grid;gap:6px;min-width:0}',
    '.gs-lab{font-size:13px;font-weight:600;color:var(--text,#f7f4ff)}',
    '.gs input[type=text]{width:100%;min-width:0;padding:11px 12px;border-radius:12px;border:1px solid var(--gs-line);background:rgba(0,0,0,.25);color:inherit;font:inherit;font-size:15px}',
    '.gs select{padding:9px 10px;border-radius:12px;border:1px solid var(--gs-line);background:#151125;color:inherit;font:inherit;font-size:14px;max-width:100%}',
    '.gs-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px}@media (max-width:420px){.gs-modes{grid-template-columns:1fr}}',
    '.gs-mode{display:flex;gap:10px;align-items:flex-start;text-align:left;padding:11px 12px;border-radius:14px;border:1px solid var(--gs-line);background:var(--gs-surf);color:inherit;font:inherit;cursor:pointer;min-width:0}',
    '.gs-mode[aria-checked=true]{border-color:#a457ff;background:rgba(164,87,255,.16);box-shadow:0 0 0 1px #a457ff inset}',
    '.gs-mode b{display:block;font-size:14px}.gs-mode small{display:block;font-size:12px;color:var(--gs-mut);margin-top:2px}',
    '.gs-explain{font-size:12.5px!important;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid var(--line,rgba(255,255,255,.085))}',
    '.gs-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.gs-row>*{min-width:0}',
    '.gs-switch{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.gs-switch input{width:20px;height:20px;margin:1px 0 0;accent-color:#a457ff;flex:0 0 auto}',
    '.gs-switch span{font-size:13.5px}.gs-switch small{display:block;color:var(--gs-mut);font-size:12px}',
    '.gs-seg{display:inline-flex;border:1px solid var(--gs-line);border-radius:12px;overflow:hidden}.gs-seg button{border:0;background:transparent;color:inherit;font:inherit;font-size:13.5px;padding:8px 14px;cursor:pointer}',
    '.gs-seg button[aria-pressed=true]{background:rgba(164,87,255,.3);font-weight:600}',
    '.gs-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.gs-btns .btn,.gs-btns .eg-btn{flex:0 1 auto}',
    '.gs-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:9px 16px;border-radius:999px;border:1px solid var(--gs-line);background:var(--gs-surf);color:inherit;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}',
    '.gs-b.primary{border:0;background:var(--grad,linear-gradient(115deg,#ff4fa3,#a457ff 50%,#22d3ee));color:#fff;box-shadow:0 8px 22px -10px rgba(164,87,255,.9)}',
    '.gs-b.text{background:transparent;border-color:transparent;color:var(--gs-mut)}.gs-b.danger{color:#fda4af}.gs-b.small{min-height:34px;padding:6px 12px;font-size:13px}',
    '.gs-b[disabled]{opacity:.55;cursor:default}.gs-b.armed{background:rgba(244,63,94,.18);border-color:rgba(244,63,94,.6);color:#fecdd3}',
    '.gs-err{color:#fecaca!important;font-weight:500}.gs-err:empty{display:none}',
    '.gs-bar{height:6px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;margin:8px 0 2px}.gs-bar i{display:block;height:100%;width:0;background:var(--grad,#a457ff);transition:width .4s}',
    '.gs-link{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:center;margin:12px 0 4px;padding:12px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid var(--gs-line)}',
    '@media (max-width:560px){.gs-link{grid-template-columns:1fr;justify-items:center;text-align:center}}',
    '.gs-qr{background:#fff;border-radius:12px;padding:6px;width:212px;height:212px;display:grid;place-items:center}.gs-qr canvas{width:200px;height:200px;image-rendering:pixelated;display:block}',
    '.gs-url{font:500 13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;color:var(--text,#f7f4ff);user-select:all;-webkit-user-select:all;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.3);margin:6px 0}',
    '.gs-banner{padding:10px 12px;border-radius:12px;background:rgba(250,204,21,.12);border:1px solid rgba(250,204,21,.4);color:#fef3c7;font-size:13.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}',
    '.gs-banner.bad{background:rgba(244,63,94,.12);border-color:rgba(244,63,94,.45);color:#fecdd3}',
    '.gs-sec{margin-top:16px}.gs-sec h3{margin:0 0 8px;font-size:14px;font-weight:700;display:flex;gap:8px;align-items:center}.gs-sec h3 small{font-weight:500;color:var(--gs-mut)}',
    '.gs-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}',
    '.gs-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px;border-radius:14px;background:rgba(255,255,255,.035);border:1px solid var(--line,rgba(255,255,255,.085))}',
    '@media (max-width:480px){.gs-item{grid-template-columns:auto minmax(0,1fr)}.gs-item .gs-acts{grid-column:1/-1;justify-content:flex-end}}',
    '.gs-av{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:700;background:linear-gradient(135deg,#ff4fa3,#a457ff);color:#fff;position:relative;flex:0 0 auto}',
    '.gs-av i{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#6b7280;border:2px solid #151125}.gs-av i.on{background:#34d399}',
    '.gs-who{min-width:0}.gs-who b{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gs-who small{display:block;font-size:12px;color:var(--gs-mut)}',
    '.gs-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '.gs-thumb{width:52px;height:52px;border-radius:12px;object-fit:cover;background:#222;flex:0 0 auto}',
    '.gs-st{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.08);white-space:nowrap}',
    '.gs-st.run{color:#a5f3fc}.gs-st.wait{color:#fde68a}.gs-st.done{color:#86efac}.gs-st.bad{color:#fca5a5}',
    '.gs-mini{height:4px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:6px}.gs-mini i{display:block;height:100%;background:#22d3ee}',
    '.gs details{margin-top:12px}.gs summary{cursor:pointer;font-size:13.5px;font-weight:600;color:var(--gs-mut);padding:6px 0}',
    '.gs-help ol{margin:6px 0 0;padding-left:20px;font-size:12.5px;color:var(--gs-mut);line-height:1.5}',
    '.gs-empty{font-size:13px;color:var(--gs-mut);margin:0}',
    '.gs .sr-only{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('glowShareCss')) return;
    var st = document.createElement('style'); st.id = 'glowShareCss'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  var G = { status: null, mount: mount, active: function () { var s = G.status; return !!(s && s.state && s.state !== 'off'); } };
  var ICON_SHARE = '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>';

  function mount(root, opts) {
    opts = opts || {};
    injectCss();
    var where = opts.where === 'setup' ? 'setup' : 'ai';
    var BTN = where === 'setup' ? 'eg-btn' : 'btn';
    var st = { status: null, view: '', timer: 0, dead: false, busy: '', armed: {}, err: '', known: lsGet().known || null, unsupported: false, copied: 0 };
    var prefs = lsGet();
    var form = { name: prefs.hostName || '', mode: prefs.mode === 'wifi' ? 'wifi' : 'internet', approve: !!prefs.approve, daily: LIMITS.indexOf(prefs.dailyLimit) >= 0 ? prefs.dailyLimit : 5, hours: HOURS.indexOf(prefs.autoStopHours) >= 0 ? prefs.autoStopHours : 4 };
    root.textContent = '';
    var box = h('div', 'gs'); box.setAttribute('aria-labelledby', 'gsH');
    root.appendChild(box);
    var head = h('div', 'gs-h');
    var ico = h('span', 'gs-ico'); ico.appendChild(svg(ICON_SHARE)); head.appendChild(ico);
    var h2 = h('h2', '', 'Share with friends'); h2.id = 'gsH'; head.appendChild(h2);
    var pill = h('span', 'gs-pill', 'Off'); head.appendChild(pill);
    box.appendChild(head);
    var body = h('div', 'gs-body'); box.appendChild(body);
    var live = h('p', 'sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); box.appendChild(live);
    function say(t) { live.textContent = ''; setTimeout(function () { live.textContent = t; }, 30); }

    function b(label, cls, fn, key) {
      var x = h('button', BTN + ' gs-b ' + (cls || ''), label); x.type = 'button';
      if (key) x.dataset.key = key;
      x.addEventListener('click', fn);
      return x;
    }
    // a second tap for anything that stops a friend's video
    function armed(key, label, again, fn) {
      var x = b(st.armed[key] ? again : label, 'small' + (st.armed[key] ? ' armed' : '') + (/Block|Cancel|Stop|Decline/.test(label) ? ' danger' : ''), function () {
        if (!st.armed[key]) {
          st.armed[key] = Date.now(); x.textContent = again; x.classList.add('armed');
          setTimeout(function () {
            if (!st.armed[key] || Date.now() - st.armed[key] < 4000) return;
            delete st.armed[key];
            var cur = box.querySelector('[data-key="' + key + '"]'); // (the card may have been redrawn meanwhile)
            if (cur) { cur.textContent = label; cur.classList.remove('armed'); }
          }, 4100);
          return;
        }
        delete st.armed[key]; fn(x);
      }, key);
      return x;
    }
    function act(path, body, then) {
      st.err = '';
      return req('POST', path, body).then(function (s) { if (then) then(s); if (s && s.state) apply(s); return s; }, function (e) {
        st.err = errText(e);
        render(true);
        throw e;
      });
    }
    function errText(e) {
      var c = e && e.code;
      if (c === 'not-installed') return 'Free AI isn’t set up on this PC yet — set it up first, then share it.';
      if (c === 'already-on') return 'Sharing is already on.';
      if (c === 'bad-name') return 'Please enter your name (1–24 letters, numbers or simple punctuation).';
      if (c === 'no-lan') return 'This PC doesn’t seem to be on a home network. Use “Anywhere” instead.';
      return (e && e.message && !/^HTTP \d+$/.test(e.message)) ? e.message : 'That didn’t work. Please try again.';
    }

    /* ---------- off: the setup form ---------- */
    function viewOff(s) {
      body.textContent = '';
      body.appendChild(h('p', '', 'Let friends make AI videos with this PC’s free AI, from their own phone or computer. Their videos are made here on your graphics card from the same preset scenes, and every video gets the “AI-generated” label. Glow Studio stays open while you share.'));
      if (s && s.lastError) { var le = h('p', 'gs-err', s.lastError); le.setAttribute('role', 'alert'); body.appendChild(le); }
      var f = h('form', 'gs-f'); f.noValidate = true;
      // your name
      var fn = h('div', 'gs-field');
      var lab = h('label', 'gs-lab', 'Your name, as friends see it'); lab.htmlFor = 'gsName';
      var inp = h('input'); inp.type = 'text'; inp.id = 'gsName'; inp.maxLength = 24; inp.required = true; inp.autocomplete = 'given-name'; inp.value = form.name; inp.placeholder = 'e.g. Ana';
      inp.addEventListener('input', function () { form.name = inp.value; });
      fn.appendChild(lab); fn.appendChild(inp); f.appendChild(fn);
      // where friends are
      var fm = h('div', 'gs-field');
      var ml = h('span', 'gs-lab', 'Where are your friends?'); ml.id = 'gsModeL'; fm.appendChild(ml);
      var modes = h('div', 'gs-modes'); modes.setAttribute('role', 'radiogroup'); modes.setAttribute('aria-labelledby', 'gsModeL');
      var explain = h('p', 'gs-explain');
      [['internet', 'Anywhere (internet link)', 'Friends can be anywhere'], ['wifi', 'Same Wi-Fi only', 'Friends on this PC’s Wi-Fi']].forEach(function (m) {
        var x = h('button', 'gs-mode'); x.type = 'button'; x.setAttribute('role', 'radio'); x.dataset.mode = m[0];
        x.appendChild(svg(m[0] === 'internet' ? '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>' : '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 16a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.2" r="1.2"/>'));
        var t = h('span'); t.appendChild(h('b', '', m[1])); t.appendChild(h('small', '', m[2])); x.appendChild(t);
        x.addEventListener('click', function () { form.mode = m[0]; sync(); });
        x.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); form.mode = form.mode === 'wifi' ? 'internet' : 'wifi'; sync(); modes.querySelector('[data-mode="' + form.mode + '"]').focus(); } });
        modes.appendChild(x);
      });
      fm.appendChild(modes); fm.appendChild(explain); f.appendChild(fm);
      // approve each video
      var ap = h('label', 'gs-switch');
      var cb = h('input'); cb.type = 'checkbox'; cb.id = 'gsApprove'; cb.checked = form.approve;
      cb.addEventListener('change', function () { form.approve = cb.checked; });
      var apt = h('span'); apt.appendChild(document.createTextNode('Approve each video')); apt.appendChild(h('small', '', 'You see each friend’s selfie and scene first, then tap Approve or Decline.'));
      ap.appendChild(cb); ap.appendChild(apt); f.appendChild(ap);
      // limits
      var lim = h('div', 'gs-row');
      var ll = h('label', 'gs-lab', 'Videos per friend per day'); ll.htmlFor = 'gsDaily';
      var sel = h('select'); sel.id = 'gsDaily';
      LIMITS.forEach(function (n) { var o = h('option', '', String(n)); o.value = String(n); if (n === form.daily) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () { form.daily = +sel.value; });
      lim.appendChild(ll); lim.appendChild(sel); f.appendChild(lim);
      var hrs = h('div', 'gs-row');
      var hl = h('span', 'gs-lab', 'Stop sharing after'); hl.id = 'gsHoursL';
      var seg = h('div', 'gs-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-labelledby', 'gsHoursL');
      HOURS.forEach(function (n) {
        var x = h('button', '', n + ' h'); x.type = 'button'; x.dataset.hours = n;
        x.addEventListener('click', function () { form.hours = n; sync(); });
        seg.appendChild(x);
      });
      hrs.appendChild(hl); hrs.appendChild(seg); f.appendChild(hrs);
      var err = h('p', 'gs-err', st.err); err.setAttribute('role', 'alert'); f.appendChild(err);
      var btns = h('div', 'gs-btns');
      var go = h('button', BTN + ' gs-b primary', 'Start sharing'); go.type = 'submit'; go.id = 'gsStart';
      go.insertBefore(svg(ICON_SHARE), go.firstChild);
      btns.appendChild(go); f.appendChild(btns);
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = inp.value.trim();
        if (!name || name.length > 24) { st.err = 'Please enter your name — friends see it on their screen.'; err.textContent = st.err; inp.focus(); return; }
        form.name = name;
        lsSet({ hostName: name, mode: form.mode, approve: form.approve, dailyLimit: form.daily, autoStopHours: form.hours, known: st.known });
        go.disabled = true; err.textContent = '';
        act('start', { mode: form.mode, hostName: name, dailyLimit: form.daily, approve: form.approve, autoStopHours: form.hours }).then(function () { say('Sharing is starting'); }, function () { go.disabled = false; err.textContent = st.err; });
      });
      body.appendChild(f);
      function sync() {
        Array.prototype.forEach.call(modes.children, function (x) { var on = x.dataset.mode === form.mode; x.setAttribute('aria-checked', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1; });
        Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', +x.dataset.hours === form.hours ? 'true' : 'false'); });
        explain.textContent = form.mode === 'wifi'
          ? 'Only people on the same Wi-Fi as this PC can open the link (not on mobile data or a guest Wi-Fi). The first time, Windows asks whether Glow Studio may use networks: tick “Private networks” and press Allow. On Wi-Fi the link is plain http inside your home network.'
          : 'Your friends open a private link from anywhere. The link runs through Cloudflare’s free tunnel service: your PC makes an encrypted connection out to Cloudflare, so traffic is encrypted, but it passes through Cloudflare. The link is temporary — it changes every time sharing starts and stops working when sharing stops. Only Glow Studio’s friend page is reachable through it.';
      }
      sync();
    }

    /* ---------- starting ---------- */
    function viewStarting(s) {
      body.textContent = '';
      var t = s.tunnel, msg = 'Starting…', pct = null;
      if (s.mode === 'wifi') msg = 'Opening the Wi-Fi link… If Windows asks whether Glow Studio may use networks, tick “Private networks” and press Allow.';
      else if (t && t.state === 'downloading') { pct = t.download && t.download.total ? Math.floor(t.download.done / t.download.total * 100) : 0; msg = 'Getting the secure link tool from Cloudflare (' + (t.download && t.download.total ? Math.round(t.download.total / 1e6) : 55) + ' MB, only once)… ' + pct + '%'; }
      else if (t && t.state === 'verifying') msg = 'Checking the secure link tool…';
      else if (t && (t.state === 'starting' || t.state === 'restarting')) msg = 'Starting the link…';
      var p = h('p', '', msg); p.id = 'gsStartMsg'; body.appendChild(p);
      var bar = h('div', 'gs-bar'); var i = h('i'); i.style.width = (pct == null ? 35 : Math.max(3, pct)) + '%'; bar.appendChild(i); body.appendChild(bar);
      var btns = h('div', 'gs-btns');
      btns.appendChild(b('Cancel', 'text', function () { act('stop', { now: true }); }));
      body.appendChild(btns);
    }

    /* The link the host has already seen in this sharing period (kept across reloads): a link that changed by itself
     * (the tunnel restarted) gets the banner; a link the host just made ("New link", a mode change) does not. */
    function knowLink(s) {
      st.known = s && s.link ? { startedAt: s.startedAt || '', link: s.link } : null;
      var p = lsGet(); p.known = st.known; lsSet(p);
    }
    function linkChanged(s) {
      if (!s || !s.link || s.state === 'off') return false;
      var k = st.known;
      if (!k || k.startedAt !== (s.startedAt || '')) { knowLink(s); return false; } // first sight of this period's link
      return k.link !== s.link;
    }

    /* ---------- on / closing: four parts, each redrawn only when its own data changed ---------- */
    var parts = null;
    function viewOn(s) {
      if (!parts) {
        body.textContent = '';
        parts = { top: h('div', 'gs-top'), jobs: h('div'), guests: h('div'), settings: h('div'), keys: {} };
        body.appendChild(parts.top); body.appendChild(parts.jobs); body.appendChild(parts.guests); body.appendChild(parts.settings);
      }
      var closing = s.state === 'closing';
      var busy = (s.jobs || []).some(function (j) { return j.state === 'running' || j.state === 'queued' || j.state === 'waiting-approval'; });
      part('top', [s.state, s.mode, s.link, s.linkReady, s.linkChangedAt, s.tunnel && s.tunnel.state, s.tunnel && s.tunnel.error, s.stopsAt, s.stopsAt && left(s.stopsAt), s.closing, linkChanged(s), st.err, busy,
        closing && (s.jobs || []).map(function (j) { return j.state + j.guestName; }).join()], function (el) { viewTop(el, s, closing, busy); });
      part('jobs', [s.jobs, s.state], function (el) { el.appendChild(viewJobs(s)); });
      part('guests', [s.guests, s.unnamed, s.settings && s.settings.dailyLimit, Math.floor(Date.now() / 60000)], function (el) { el.appendChild(viewGuests(s)); });
      part('settings', [s.settings, s.mode, closing], function (el) { if (!closing) { el.appendChild(viewSettings(s)); if (s.mode === 'wifi') el.appendChild(wifiHelp()); } });
    }
    function part(name, keyParts, draw) {
      var key = JSON.stringify(keyParts);
      if (parts.keys[name] === key) return;
      parts.keys[name] = key;
      var el = parts[name], fk = document.activeElement && el.contains(document.activeElement) ? (document.activeElement.dataset.key || document.activeElement.id || '') : '';
      el.textContent = '';
      draw(el);
      if (fk) { var n = el.querySelector('[data-key="' + fk + '"]') || document.getElementById(fk); if (n && n.focus) { try { n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
    }
    function viewTop(top, s, closing, busy) {
      if (closing) {
        var cl = h('div', 'gs-banner');
        var waiting = (s.closing && s.closing.waitingFor) || 0;
        var names = (s.jobs || []).filter(function (j) { return j.state === 'running' || j.state === 'done'; }).map(function (j) { return j.guestName || 'a friend'; });
        cl.appendChild(h('span', '', (waiting && names.length ? 'Finishing ' + names[0] + '’s video… ' : 'Closing… ') + 'The link closes when friends have their videos.'));
        cl.appendChild(armed('stopnow', 'Stop now', 'Tap again — friends’ videos stop', function () { act('stop', { now: true }).then(function () { say('Sharing is off'); }); }));
        top.appendChild(cl);
      }
      var tun = s.tunnel;
      if (tun && tun.state === 'failed') {
        var fb = h('div', 'gs-banner bad'); fb.setAttribute('role', 'alert');
        fb.appendChild(h('span', '', (tun.error ? tun.error + ' ' : '') + 'The internet link stopped working. Try “Same Wi-Fi only”, or stop and start sharing again.'));
        top.appendChild(fb);
      }
      if (linkChanged(s) && !closing) {
        var ch = h('div', 'gs-banner'); ch.setAttribute('role', 'status'); ch.id = 'gsChanged';
        ch.appendChild(h('span', '', 'The link changed — send the new link to your friends.'));
        ch.appendChild(b('OK', 'small', function () { knowLink(s); render(true); }));
        top.appendChild(ch);
      }
      if (s.link && !closing) {
        var lk = h('div', 'gs-link');
        var qrw = h('div', 'gs-qr'); var cv = h('canvas'); cv.id = 'gsQr'; cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'QR code of the link for your friends');
        qrw.appendChild(cv); lk.appendChild(qrw);
        var lt = h('div');
        lt.appendChild(h('p', '', s.mode === 'wifi' ? 'Friends on your Wi-Fi scan the code with their phone camera, or open this link:' : 'Friends scan the code with their phone camera, or you send them this link:'));
        var url = h('div', 'gs-url', s.link); url.id = 'gsLink'; lt.appendChild(url);
        var row = h('div', 'gs-btns');
        var copy = b(Date.now() - st.copied < 2500 ? 'Copied' : 'Copy link', 'primary small', function () { copyLink(s.link, copy); }, 'copy');
        copy.id = 'gsCopy'; row.appendChild(copy);
        row.appendChild(armed('newlink', 'New link', 'Tap again — the old link stops letting people in', function () { act('new-link', {}, knowLink).then(function () { say('A new link is ready. The old link no longer lets new people in.'); }); }));
        lt.appendChild(row);
        if (!s.linkReady) lt.appendChild(h('p', '', 'The link is starting — it may take a minute before it works.'));
        lk.appendChild(lt);
        top.appendChild(lk);
        try { if (window.GlowQR) window.GlowQR.draw(cv, s.link, { px: 200 }); } catch (e) { qrw.replaceWith(h('p', 'gs-err', 'This link is too long for a QR code — copy it instead.')); }
      }
      var tl = h('div', 'gs-row');
      if (s.stopsAt && !closing) tl.appendChild(h('p', '', 'Sharing stops at ' + clock(s.stopsAt) + ' (in ' + left(s.stopsAt) + ').'));
      if (!closing) tl.appendChild(armed('stop', 'Stop sharing', busy ? 'Tap again — waiting videos are cancelled, the one being made finishes' : 'Tap again to stop sharing', function () { act('stop', {}).then(function () { say('Sharing is stopping'); }); }));
      top.appendChild(tl);
      var err = h('p', 'gs-err', st.err); err.setAttribute('role', 'alert'); top.appendChild(err);
    }
    function copyLink(link, btn) {
      function done() { st.copied = Date.now(); btn.textContent = 'Copied'; say('Link copied'); setTimeout(function () { if (btn.isConnected) btn.textContent = 'Copy link'; }, 2500); }
      function fallback() {
        var u = document.getElementById('gsLink');
        try {
          var r = document.createRange(); r.selectNodeContents(u); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          if (document.execCommand && document.execCommand('copy')) { done(); return; }
        } catch (e) { /* ignore */ }
        window.prompt('Copy this link:', link);
      }
      try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(link).then(done, fallback); return; } } catch (e) { /* fall back */ }
      fallback();
    }
    function viewJobs(s) {
      var sec = h('section', 'gs-sec'); sec.setAttribute('aria-labelledby', 'gsJobsH');
      var jobs = (s.jobs || []).filter(function (j) { return ['waiting-approval', 'queued', 'running', 'done'].indexOf(j.state) >= 0; });
      var hh = h('h3'); hh.id = 'gsJobsH'; hh.appendChild(document.createTextNode('Friends’ videos')); hh.appendChild(h('small', '', jobs.length ? String(jobs.length) : ''));
      sec.appendChild(hh);
      if (!jobs.length) { sec.appendChild(h('p', 'gs-empty', 'No videos yet. Your own videos always go first — a friend’s video waits while you make one.')); return sec; }
      var ul = h('ul', 'gs-list');
      jobs.forEach(function (j) {
        var li = h('li', 'gs-item'); li.dataset.job = j.id;
        var what = (j.sceneName || j.sceneId) + ' · ' + j.duration + ' s · ' + (SOUND[j.sound] || 'music') + (j.lipShots ? ' · lip-sync' : '');
        if (j.state === 'waiting-approval') {
          var img = h('img', 'gs-thumb'); img.alt = 'Selfie from ' + (j.guestName || 'a friend'); img.src = API + 'jobs/' + encodeURIComponent(j.id) + '/thumb'; img.decoding = 'async';
          img.onerror = function () { img.removeAttribute('src'); };
          li.appendChild(img);
        } else {
          var av = h('span', 'gs-av', (j.guestName || '?').charAt(0).toUpperCase()); av.setAttribute('aria-hidden', 'true'); li.appendChild(av);
        }
        var who = h('div', 'gs-who');
        who.appendChild(h('b', '', (j.guestName || 'A friend') + (j.state === 'waiting-approval' ? ' wants to make a video' : '')));
        who.appendChild(h('small', '', what));
        var stt = j.state === 'waiting-approval' ? ['wait', 'Waiting for you'] : j.state === 'queued' ? ['wait', 'In line' + (j.position ? ' · #' + j.position : '') + (j.startMin ? ' · starts in ~' + j.startMin[0] + '–' + j.startMin[1] + ' min' : '')]
          : j.state === 'running' ? ['run', 'Making · ' + Math.round(((j.progress && j.progress.overall) || 0) * 100) + '%' + (j.doneMin ? ' · ~' + j.doneMin[0] + '–' + j.doneMin[1] + ' min left' : '')] : ['done', 'Made · waiting for them to download'];
        var chip = h('span', 'gs-st ' + stt[0], stt[1]); who.appendChild(chip);
        if (j.state === 'running') { var mb = h('div', 'gs-mini'); var mi = h('i'); mi.style.width = Math.round(((j.progress && j.progress.overall) || 0) * 100) + '%'; mb.appendChild(mi); who.appendChild(mb); }
        li.appendChild(who);
        var acts = h('div', 'gs-acts');
        if (j.state === 'waiting-approval') {
          acts.appendChild(b('Approve', 'primary small', function () { act('jobs/' + encodeURIComponent(j.id) + '/approve', {}).then(function () { say('Approved ' + (j.guestName || '') + '’s video'); }); }, 'ap-' + j.id));
          acts.appendChild(armed('de-' + j.id, 'Decline', 'Tap again to decline', function () { act('jobs/' + encodeURIComponent(j.id) + '/decline', {}).then(function () { say('Declined'); }); }));
        } else if (j.state !== 'done') {
          acts.appendChild(armed('ca-' + j.id, 'Cancel', 'Tap again to cancel', function () { act('jobs/' + encodeURIComponent(j.id) + '/cancel', {}).then(function () { say('Cancelled'); }); }));
        }
        li.appendChild(acts);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      return sec;
    }
    function viewGuests(s) {
      var sec = h('section', 'gs-sec'); sec.setAttribute('aria-labelledby', 'gsGuestsH');
      var gs = s.guests || [];
      var hh = h('h3'); hh.id = 'gsGuestsH'; hh.appendChild(document.createTextNode('Who’s connected')); hh.appendChild(h('small', '', gs.length ? String(gs.filter(function (g) { return g.online && !g.blocked; }).length) + ' online' : ''));
      sec.appendChild(hh);
      if (!gs.length) sec.appendChild(h('p', 'gs-empty', 'Nobody yet. Friends show up here with their name once they open the link.'));
      var ul = h('ul', 'gs-list');
      gs.forEach(function (g) {
        var li = h('li', 'gs-item'); li.dataset.guest = g.id;
        var av = h('span', 'gs-av', (g.name || '?').charAt(0).toUpperCase()); av.setAttribute('aria-hidden', 'true');
        var dot = h('i', g.online && !g.blocked ? 'on' : ''); av.appendChild(dot); li.appendChild(av);
        var who = h('div', 'gs-who');
        who.appendChild(h('b', '', g.name || 'Someone'));
        var lim = (s.settings && s.settings.dailyLimit) || 5;
        who.appendChild(h('small', '', g.blocked ? 'Blocked' : (g.online ? 'Online' : 'Last seen ' + ago(g.lastSeenAt)) + ' · ' + (g.usedToday || 0) + ' of ' + lim + ' videos today'));
        li.appendChild(who);
        var acts = h('div', 'gs-acts');
        if (g.blocked) acts.appendChild(b('Unblock', 'small text', function () { act('guests/' + encodeURIComponent(g.id) + '/block', { blocked: false }); }, 'ub-' + g.id));
        else acts.appendChild(armed('bl-' + g.id, 'Block', 'Tap again to block ' + (g.name || 'them'), function () { act('guests/' + encodeURIComponent(g.id) + '/block', { blocked: true }).then(function () { say((g.name || 'They') + ' can’t use your PC any more'); }); }));
        li.appendChild(acts);
        ul.appendChild(li);
      });
      if (gs.length) sec.appendChild(ul);
      if (s.unnamed) sec.appendChild(h('p', 'gs-empty', s.unnamed + (s.unnamed === 1 ? ' more person has' : ' more people have') + ' opened the link but not entered a name yet.'));
      sec.appendChild(h('p', 'gs-empty', 'Someone you don’t know? Block them, then press “New link” and send it only to your friends.'));
      return sec;
    }
    function viewSettings(s) {
      var d = h('details', 'gs-set'); if (st.setOpen) d.open = true;
      d.addEventListener('toggle', function () { st.setOpen = d.open; });
      d.appendChild(h('summary', '', 'Sharing settings'));
      var f = h('div', 'gs-f');
      var set = s.settings || {};
      var ap = h('label', 'gs-switch');
      var cb = h('input'); cb.type = 'checkbox'; cb.id = 'gsApproveOn'; cb.checked = !!set.approve;
      cb.addEventListener('change', function () { act('settings', { approve: cb.checked }); });
      var apt = h('span'); apt.appendChild(document.createTextNode('Approve each video')); apt.appendChild(h('small', '', 'You see each friend’s selfie and scene first.'));
      ap.appendChild(cb); ap.appendChild(apt); f.appendChild(ap);
      var lim = h('div', 'gs-row');
      var ll = h('label', 'gs-lab', 'Videos per friend per day'); ll.htmlFor = 'gsDailyOn';
      var sel = h('select'); sel.id = 'gsDailyOn';
      LIMITS.forEach(function (n) { var o = h('option', '', String(n)); o.value = String(n); if (n === set.dailyLimit) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () { act('settings', { dailyLimit: +sel.value }); });
      lim.appendChild(ll); lim.appendChild(sel); f.appendChild(lim);
      var hrs = h('div', 'gs-row');
      hrs.appendChild(h('span', 'gs-lab', 'Stop sharing'));
      HOURS.forEach(function (n) { hrs.appendChild(b(n + ' h from now', 'small', function () { act('settings', { autoStopHours: n }).then(function () { say('Sharing now stops in ' + n + ' hours'); }); })); });
      f.appendChild(hrs);
      var mrow = h('div', 'gs-row');
      var other = s.mode === 'wifi' ? 'internet' : 'wifi';
      mrow.appendChild(h('span', 'gs-lab', s.mode === 'wifi' ? 'Same Wi-Fi only' : 'Anywhere (internet link)'));
      mrow.appendChild(armed('mode', other === 'wifi' ? 'Switch to Same Wi-Fi only' : 'Switch to Anywhere', 'Tap again — this makes a new link', function () { act('settings', { mode: other }, knowLink); }));
      f.appendChild(mrow);
      d.appendChild(f);
      return d;
    }
    function wifiHelp() {
      var d = h('details', 'gs-help');
      d.appendChild(h('summary', '', 'Friends can’t connect?'));
      var ol = h('ol');
      ['Their phone must be on the same Wi-Fi as this PC — not on mobile data, and not on a “guest” Wi-Fi.',
        'On this PC: Windows Settings → Network & internet → Wi-Fi → your network → Network profile type: Private.',
        'If you pressed Cancel when Windows asked: Windows Security → Firewall & network protection → Allow an app through firewall → tick Glow Studio for Private.',
        'Still nothing? Switch to “Anywhere (internet link)” in Sharing settings.'].forEach(function (t) { ol.appendChild(h('li', '', t)); });
      d.appendChild(ol);
      return d;
    }

    /* ---------- loop ---------- */
    function apply(s) {
      st.status = G.status = s;
      render(false);
      if (typeof opts.onChange === 'function') { try { opts.onChange(s); } catch (e) { /* ignore */ } }
    }
    function render(force) {
      var s = st.status;
      if (st.unsupported) { root.hidden = true; return; }
      var state = s ? s.state : 'off';
      var failed = !!(s && s.tunnel && s.tunnel.state === 'failed' && state !== 'off');
      pill.className = 'gs-pill' + (failed ? ' bad' : state === 'on' ? ' on' : state === 'starting' || state === 'closing' ? ' wait' : '');
      pill.textContent = failed ? 'Link stopped' : state === 'on' ? (s.stopsAt ? 'On · ' + left(s.stopsAt) + ' left' : 'On') : state === 'starting' ? 'Starting…' : state === 'closing' ? 'Closing…' : 'Off';
      var was = st.view, view = state === 'closing' ? 'on' : state;
      if (view !== 'on') parts = null;
      if (view === 'off') {
        // the setup form keeps what is being typed: drawn only when it appears (or after an error)
        if (was !== 'off' || force) viewOff(s);
      } else if (view === 'starting') {
        var k = JSON.stringify([s.mode, s.tunnel]);
        if (was !== 'starting' || force || k !== st.startKey) { st.startKey = k; viewStarting(s); }
      } else {
        if (force && parts) parts.keys = {};
        viewOn(s);
      }
      st.view = view;
      if (was && was !== view) {
        say(view === 'on' ? (state === 'closing' ? 'Sharing is closing' : 'Sharing is on. Send the link to your friends.') : view === 'off' ? 'Sharing is off' : '');
        if (view === 'on' && was === 'starting') { var c = document.getElementById('gsCopy'); if (c && box.contains(document.activeElement || null)) try { c.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }
    }
    function poll() {
      if (st.dead) return;
      clearTimeout(st.timer);
      req('GET', 'status').then(function (s) { st.unsupported = false; root.hidden = false; apply(s); }, function (e) {
        // an older Glow Studio without sharing: no card at all
        if (e && e.status === 404) { st.unsupported = true; root.hidden = true; return; }
      }).then(function () {
        if (st.dead || st.unsupported) return;
        // (every 2 s while sharing; while it is off only now and then, in case it was started on the other page)
        var on = st.status && st.status.state && st.status.state !== 'off';
        st.timer = setTimeout(poll, on ? (document.hidden ? POLL_HIDDEN : POLL) : (document.hidden ? POLL_HIDDEN * 3 : POLL_HIDDEN));
      });
    }
    function onVis() { if (!document.hidden) poll(); }
    document.addEventListener('visibilitychange', onVis);
    render(true);
    poll();
    return {
      refresh: poll,
      unmount: function () { st.dead = true; clearTimeout(st.timer); document.removeEventListener('visibilitychange', onVis); root.textContent = ''; }
    };
  }

  window.GlowShare = G;
})();
