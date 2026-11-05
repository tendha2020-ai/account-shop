/* Glow Studio — "Free AI on this PC" setup wizard (engine.html). Uses window.GlowLocalAI (local-engine.js).
 *
 * Website (no launcher): explains what is needed + "Download Glow Studio for Windows".
 * In the Windows app: 1 Check this PC -> 2 Choose packs -> 3 Install (progress, cancel/resume, survives reload)
 *                     -> 4 Start engine (+ optional warm-up test) -> 5 Ready -> back to AI Scenes.
 * The view is derived from the launcher's status (polled), plus a few local choices.
 */
(function () {
  'use strict';

  var L = window.GlowLocalAI;
  var T = (window.__GLOW_ENGINE_UI_TEST__ && typeof window.__GLOW_ENGINE_UI_TEST__ === 'object') ? window.__GLOW_ENGINE_UI_TEST__ : {};
  var POLL_FAST = T.pollFastMs || 1000;
  var POLL_SLOW = T.pollSlowMs || 4000;
  var PREF_KEY = 'glow.engine.ui';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var els = { view: $('#egView'), steps: $('#egSteps'), banner: $('#egBanner'), details: $('#egDetails'), facts: $('#egFacts'), log: $('#egLog'), live: $('#egLive') };
  if (!L || !els.view) return;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsJSON(k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  /* ---------------- formatting (plain words) ---------------- */
  function gb1(gb) { gb = Math.max(0, gb || 0); return (gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10) + ' GB'; }
  function bytesGB(b) { return gb1((b || 0) / 1e9); }
  function minRange(m) { function f(x) { return String(x).replace('.5', '½'); } return f(m[0]) + '–' + f(m[1]) + ' min'; }
  function dur(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return 'less than a minute';
    var m = Math.round(sec / 60);
    if (m < 60) return 'about ' + m + ' min';
    var h = Math.floor(m / 60), r = Math.round((m % 60) / 5) * 5;
    if (r === 60) { h++; r = 0; }
    return 'about ' + h + ' h' + (r ? ' ' + r + ' min' : '');
  }
  function clock(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function dlHours(gb) {
    // 100 Mbit/s (fast home internet) .. 30 Mbit/s (slower)
    var lo = gb * 8000 / 100 / 3600, hi = gb * 8000 / 30 / 3600;
    if (hi < 1) return 'under an hour';
    var r = function (x) { return x < 1 ? 1 : Math.round(x); };
    return r(lo) === r(hi) ? 'about ' + r(lo) + ' hour' + (r(lo) > 1 ? 's' : '') : 'about ' + r(lo) + '–' + r(hi) + ' hours';
  }
  function speed(bps) { return bps >= 1e6 ? (Math.round(bps / 1e5) / 10) + ' MB/s' : Math.max(1, Math.round(bps / 1e3)) + ' KB/s'; }

  var ICON = {
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 6.5v7M12 17.5h.01"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    dl: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    pc: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    win: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5l7.5-1v7H3zM12.5 4.2L21 3v8.5h-8.5zM3 13h7.5v7l-7.5-1zM12.5 13H21v8l-8.5-1.2z"/></svg>',
    gpu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="7" width="19" height="10" rx="2"/><circle cx="9" cy="12" r="2.6"/><circle cx="15.5" cy="12" r="2.6"/><path d="M6 17v3M18 17v3"/></svg>',
    disk: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
    ram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="9" rx="1.5"/><path d="M7 16v3M11 16v3M15 16v3M7 10.5h2M11 10.5h2M15 10.5h2"/></svg>'
  };
  function dot(kind, label) { return '<span class="eg-dot ' + kind + '" role="img" aria-label="' + esc(label) + '">' + ICON[kind] + '</span>'; }

  /* ---------------- state ---------------- */
  var S = null;                 // last launcher status (null on the website)
  var prefs = lsJSON(PREF_KEY) || {};
  var ui = {
    view: null, shape: null,
    passedCheck: false,         // pressed Continue on step 1
    force: null,                // 'packs' when adding packs later
    engineStep: false,          // step 4 was shown in this visit (keep it for the warm-up offer)
    finished: false,            // pressed Finish on step 4
    dismissJob: false,          // "Not now" on a paused/failed extra-pack download
    sel: Array.isArray(prefs.packs) ? prefs.packs.slice() : ['core'],
    dirEdit: false, dir: '',
    busy: null, err: null, pendingFocus: false,
    offline: 0, startingSince: 0,
    warm: { state: 'idle' }, warmCtl: null,
    speeds: [], sysRamGB: null
  };
  function installed(id) { return !!(S && S.packs && S.packs[id] && S.packs[id].installed); }
  function packInfo(id) { var p = L.packs.filter(function (x) { return x.id === id; })[0] || {}; var sp = S && S.packs && S.packs[id]; return { id: id, label: (sp && sp.label) || p.label, sizeGB: (sp && sp.sizeGB) || p.sizeGB, desc: p.desc, required: p.required, experimental: p.experimental }; }
  function ramGB() { if (S && typeof S.ramGB === 'number') return S.ramGB; if (S && typeof S.ramMB === 'number') return S.ramMB / 1024; return ui.sysRamGB; }

  function deriveView() {
    if (!S) return 'website';
    var job = S.job;
    if (job && job.state === 'running') return 'install';
    if (ui.force) return ui.force;
    if (job && (job.state === 'cancelled' || job.state === 'error') && !ui.dismissJob) return 'install';
    if (!installed('core')) return ui.passedCheck ? 'packs' : 'check';
    if (S.engine.state === 'ready' && (ui.finished || !ui.engineStep)) return 'ready';
    return 'engine';
  }
  var STEP_OF = { check: 1, packs: 2, install: 3, engine: 4, ready: 5 };

  /* ---------------- views ---------------- */
  function pcChecks() {
    var g = S.gpu, rows = [];
    var need = L.diskNeededGB(['core'], S);
    var blocker = false, driverBad = false, diskLow = false, soft = false;
    if (!g) {
      blocker = true;
      rows.push({ k: 'bad', icon: 'gpu', l: 'Graphics card', v: 'No NVIDIA graphics card found', n: 'Free AI needs an NVIDIA RTX graphics card with 8 GB of video memory.' });
    } else {
      rows.push({ k: 'ok', icon: 'gpu', l: 'Graphics card', v: g.name });
      var vgb = Math.round((g.vramMB || 0) / 1024);
      if (g.vramMB >= 7600) rows.push({ k: 'ok', icon: 'gpu', l: 'Video memory', v: vgb + ' GB' });
      else if (g.vramMB >= 5600) { soft = true; rows.push({ k: 'warn', icon: 'gpu', l: 'Video memory', v: vgb + ' GB', n: 'Less than 8 GB: videos may be very slow or not work.' }); }
      else { blocker = true; rows.push({ k: 'bad', icon: 'gpu', l: 'Video memory', v: vgb + ' GB', n: 'Too little video memory for the AI models (8 GB needed).' }); }
      if (g.driverOk) rows.push({ k: 'ok', icon: 'pc', l: 'Graphics driver', v: 'Version ' + g.driver });
      else {
        driverBad = true;
        rows.push({ k: 'bad', icon: 'pc', l: 'Graphics driver', v: g.driver ? 'Version ' + g.driver + ' — too old' : 'Not found',
          n: 'Version ' + parseInt(g.minDriver || '580', 10) + ' or newer is needed.', link: true });
      }
    }
    var free = Number(S.diskFreeGB) || 0;
    if (free >= need) rows.push({ k: 'ok', icon: 'disk', l: 'Free space', v: gb1(free) + ' free', n: 'Needs about ' + need + ' GB for dance & party scenes.' });
    else { diskLow = true; rows.push({ k: 'warn', icon: 'disk', l: 'Free space', v: gb1(free) + ' free', n: 'Needs about ' + need + ' GB. Free up space, or pick a folder on another drive in the next step.' }); }
    var ram = ramGB();
    if (ram) {
      if (ram >= 30) rows.push({ k: 'ok', icon: 'ram', l: 'Memory', v: Math.round(ram) + ' GB' });
      else { soft = true; rows.push({ k: 'warn', icon: 'ram', l: 'Memory', v: Math.round(ram) + ' GB', n: 'Less than 32 GB: it works, but videos take longer.' }); }
    }
    if (S.os && S.os !== 'windows') { soft = true; rows.push({ k: 'warn', icon: 'win', l: 'System', v: S.os, n: 'The free AI engine is made for Windows 10 and 11.' }); }
    var verdict;
    if (blocker) verdict = { k: 'bad', t: 'This PC can’t run free AI', p: 'It needs an NVIDIA RTX graphics card with 8 GB of video memory. You can still make AI scenes online in Glow Studio.' };
    else if (driverBad) verdict = { k: 'warn', t: 'Almost ready — please update your graphics driver', p: 'You can start the download now and update the driver while it downloads. Restart your PC after updating.' };
    else if (diskLow) verdict = { k: 'warn', t: 'Your PC can do it — it just needs more free space', p: 'Free up space on this drive, or choose a folder on another drive in the next step.' };
    else if (soft) verdict = { k: 'warn', t: 'Your PC can run free AI, a little slower', p: 'Everything needed is there. Videos may take a bit longer than usual.' };
    else verdict = { k: 'ok', t: 'Great — this PC can make free AI videos', p: 'Next, choose what to install.' };
    return { rows: rows, verdict: verdict, blocker: blocker, driverBad: driverBad };
  }

  function driverLink(cls) { return '<a class="eg-btn ' + (cls || 'glass') + '" href="' + esc(L.driverUrl) + '" target="_blank" rel="noopener">Update NVIDIA driver' + ICON.ext + '<span class="eg-live">(opens NVIDIA’s website)</span></a>'; }

  function vWebsite() {
    return {
      shape: 'website', say: '',
      html: '<section class="eg-card eg-website" aria-labelledby="egH">' +
        '<div class="eg-pc">' + ICON.pc + '</div>' +
        '<h2 id="egH">Free AI needs the Glow Studio app</h2>' +
        '<p>Free videos are made by your own computer’s graphics card, so this part only works in the Glow Studio app for Windows.</p>' +
        '<ul class="eg-req" aria-label="What you need">' +
        '<li>' + ICON.win + '<span>Windows 10 or 11</span></li>' +
        '<li>' + ICON.gpu + '<span>An NVIDIA RTX graphics card with 8 GB or more (for example RTX 3060, 4060 or 5060)</span></li>' +
        '<li>' + ICON.disk + '<span>About 120 GB of free space, ideally on an SSD</span></li>' +
        '<li>' + ICON.ram + '<span>32 GB of memory recommended</span></li>' +
        '</ul>' +
        '<a class="eg-btn primary big wide" href="../downloads/GlowStudio.exe" download data-primary>' + ICON.dl + 'Download Glow Studio for Windows</a>' +
        '<p class="eg-note">Free. After installing, open Glow Studio and choose “Free AI on this PC”.</p>' +
        '<div class="eg-alt"><p>No NVIDIA card, or not on Windows? You can still make AI scenes online.</p><a class="eg-btn glass" href="./#ai">' + ICON.back + 'Back to AI Scenes</a></div>' +
        '</section>'
    };
  }

  function vCheck() {
    var c = pcChecks();
    var rows = c.rows.map(function (r) {
      return '<li>' + dot(r.k, r.k === 'ok' ? 'OK' : r.k === 'warn' ? 'Warning' : 'Problem') + '<span class="eg-ct"><span class="eg-cl">' + esc(r.l) + '</span><span class="eg-cv">' + esc(r.v) + '</span>' +
        (r.n ? '<span class="eg-cn">' + esc(r.n) + '</span>' : '') + (r.link ? '<span class="eg-cn">' + driverLink('glass eg-mini') + '</span>' : '') + '</span></li>';
    }).join('');
    var actions = c.blocker
      ? '<a class="eg-btn primary" href="./#ai" data-primary>' + ICON.back + 'Back to AI Scenes</a><button type="button" class="eg-btn glass" data-act="recheck">Check again</button>'
      : '<button type="button" class="eg-btn primary" data-act="continue" data-primary>' + (c.driverBad ? 'Continue anyway' : 'Continue') + '</button>' +
        '<button type="button" class="eg-btn text" data-act="recheck">Check again</button>';
    return {
      shape: 'check:' + c.verdict.k + ':' + JSON.stringify(c.rows), say: c.verdict.t,
      html: '<section class="eg-card" aria-labelledby="egH"><p class="eg-kicker">Step 1 of 5</p><h2 id="egH">Check this PC</h2>' +
        '<div class="eg-verdict ' + c.verdict.k + '">' + dot(c.verdict.k, '') + '<div><b>' + esc(c.verdict.t) + '</b><p>' + esc(c.verdict.p) + '</p></div></div>' +
        '<ul class="eg-checks">' + rows + '</ul>' +
        '<div class="eg-actions">' + actions + '</div></section>'
    };
  }

  function estimateFor(id) {
    if (id === 'singing') return L.estimate({ quality: 'best', singing: true }).minutes;
    if (id === 'fast') return L.estimate({ quality: 'fast', fastPack: true }).minutes;
    return L.estimate({ quality: 'best' }).minutes;
  }
  function selectedPacks() {
    var out = ['core'];
    ui.sel.forEach(function (p) { if (out.indexOf(p) < 0 && L.packs.some(function (x) { return x.id === p; })) out.push(p); });
    return out;
  }
  function vPacks() {
    var sel = selectedPacks();
    var cards = L.packs.map(function (p0) {
      var p = packInfo(p0.id), inst = installed(p.id), on = inst || sel.indexOf(p.id) >= 0, locked = !!p.required || inst;
      var tags = (inst ? '<span class="eg-tag inst">Installed</span>' : p.required ? '<span class="eg-tag req">Required</span>' : '') + (p.experimental ? '<span class="eg-tag exp">Experimental</span>' : '');
      var unit = p.id === 'singing' ? ' per singing video' : ' per video';
      return '<label class="eg-pack' + (on ? ' on' : '') + (locked ? ' locked' : '') + '" data-pack="' + p.id + '">' +
        '<input type="checkbox" value="' + p.id + '"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + ' aria-describedby="egPd-' + p.id + '">' +
        '<span class="eg-check" aria-hidden="true">' + ICON.ok + '</span>' +
        '<span class="eg-pb"><span class="eg-pt">' + esc(p.label) + tags + '</span>' +
        '<span class="eg-pd" id="egPd-' + p.id + '">' + esc(p.desc) + '</span>' +
        '<span class="eg-pm"><span>' + ICON.dl + (inst ? 'Already on this PC' : gb1(p.sizeGB) + ' download') + '</span><span>' + ICON.clock + 'About ' + minRange(estimateFor(p.id)) + unit + '</span></span></span></label>';
    }).join('');
    var folder = ui.dirEdit
      ? '<div class="eg-folder-row"><label class="eg-live" for="egDir">Install folder</label><input class="eg-input" id="egDir" type="text" inputmode="text" autocomplete="off" spellcheck="false" value="' + esc(ui.dir) + '" placeholder="D:\\GlowStudio">' +
        '<button type="button" class="eg-btn text eg-mini" data-act="dirDefault">Use default</button></div>' +
        '<span class="eg-small">Pick a folder on a fast drive (SSD) with lots of free space, for example D:\\GlowStudio. Avoid OneDrive and Program Files.</span><span class="eg-small" data-f="dirWarn"></span>'
      : '<div class="eg-folder-row"><span class="eg-path" data-f="dir">' + esc(S.installDir) + '</span><button type="button" class="eg-btn glass eg-mini" data-act="dirChange">Change</button></div>';
    var back = installed('core') ? 'Back' : 'Back to the PC check';
    return {
      shape: 'packs:' + L.packs.map(function (p) { return installed(p.id) ? 1 : 0; }).join('') + ':' + (ui.dirEdit ? 1 : 0) + ':' + (ui.busy || '') + ':' + (ui.err || ''), say: '',
      html: '<section class="eg-card" aria-labelledby="egH"><p class="eg-kicker">Step 2 of 5</p><h2 id="egH">Choose what to install</h2>' +
        '<p>Start with dance &amp; party scenes. You can add the others now or later.</p>' +
        '<fieldset class="eg-packs"><legend>AI packs</legend>' + cards + '</fieldset>' +
        '<div class="eg-sum" data-f="sum"></div>' +
        '<div class="eg-folder"><span>Install folder</span>' + folder + '</div>' +
        '<p class="eg-err" role="alert">' + esc(ui.err || '') + '</p>' +
        '<div class="eg-actions"><button type="button" class="eg-btn primary" data-act="install" data-primary' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy === 'install' ? '<span class="eg-spin" aria-hidden="true"></span>Starting…' : '<span data-f="installLabel">Download &amp; install</span>') + '</button>' +
        '<button type="button" class="eg-btn text" data-act="back">' + back + '</button></div></section>'
    };
  }
  function updPacks(root) {
    var sel = selectedPacks();
    var todo = sel.filter(function (p) { return !installed(p); });
    var dl = todo.reduce(function (a, p) { return a + packInfo(p).sizeGB; }, 0);
    var need = L.diskNeededGB(sel, S);
    var free = Number(S.diskFreeGB) || 0;
    var custom = ui.dirEdit && ui.dir.trim() && ui.dir.trim() !== S.installDir;
    var sum = $('[data-f="sum"]', root);
    if (sum) {
      if (!todo.length) sum.innerHTML = '<span>Everything you picked is already on this PC.</span>';
      else {
        sum.innerHTML = '<span>Download: <b>' + gb1(dl) + '</b> — ' + dlHours(dl) + ' on a typical home connection. You can pause and continue later.</span>' +
          (custom ? '<span>The free space on that drive is checked when the download starts.</span>'
            : free >= need ? '<span class="ok">Free space on this drive: ' + gb1(free) + ' (needs about ' + need + ' GB).</span>'
              : '<span class="bad">Not enough free space on this drive: ' + gb1(free) + ' free, needs about ' + need + ' GB. Free up space or choose a folder on another drive.</span>');
      }
    }
    var lab = $('[data-f="installLabel"]', root);
    if (lab) lab.textContent = todo.length ? 'Download & install (' + gb1(dl) + ')' : 'Nothing new to install';
    var btn = $('[data-act="install"]', root);
    if (btn && !ui.busy) btn.disabled = !todo.length;
    Array.prototype.forEach.call(root.querySelectorAll('.eg-pack'), function (el) {
      var id = el.getAttribute('data-pack');
      el.classList.toggle('on', installed(id) || sel.indexOf(id) >= 0);
    });
    var dw = $('[data-f="dirWarn"]', root);
    if (dw) dw.textContent = dirProblem(ui.dir, true) || '';
  }
  function dirProblem(d, soft) {
    d = (d || '').trim();
    if (!d) return soft ? '' : 'Please type a folder, for example D:\\GlowStudio.';
    if ((S.os || 'windows') === 'windows' && !/^[A-Za-z]:\\/.test(d)) return 'Please type a full folder path that starts with a drive letter, for example D:\\GlowStudio.';
    if (/onedrive/i.test(d)) return 'OneDrive folders can cause problems. Please choose a folder outside OneDrive.';
    if (/program files/i.test(d)) return 'Program Files needs special permissions. Please choose another folder.';
    return '';
  }

  function friendlyJobError(e) {
    e = String(e || '');
    if (/space|disk full|ENOSPC|not enough/i.test(e)) return 'Your drive ran out of space. Free up some space, then try again.';
    if (/sha|hash|checksum|verif|corrupt|damaged|size mismatch/i.test(e)) return 'A downloaded file was damaged. Press “Try again” to download it again.';
    if (/7z|7zr|extract|unpack/i.test(e)) return 'Unpacking the AI engine didn’t work. Press “Try again”.';
    if (/network|connect|timeout|timed out|interrupt|reset|refused|dns|dial|50[0-9]|429|offline/i.test(e)) return 'The internet connection was interrupted.';
    return 'The download stopped unexpectedly.';
  }
  function vInstall() {
    var j = S.job || {};
    var st = j.state;
    var head = st === 'running' ? 'Installing free AI' : st === 'cancelled' ? 'Download paused' : 'The download stopped';
    var intro = st === 'running'
      ? '<p class="eg-steptext" data-f="step"></p>'
      : st === 'cancelled'
        ? '<p>Your progress is saved — <b data-f="doneTxt"></b> already downloaded. Continue whenever you like.</p>'
        : '<p class="eg-err" role="alert">' + esc(friendlyJobError(j.error)) + ' Your progress is saved.</p>';
    var file = st === 'running'
      ? '<div class="eg-file" data-f="fileBox"><div class="eg-prog-h"><span data-f="fileName"></span><span data-f="fileTxt"></span></div>' +
        '<div class="eg-bar thin" role="progressbar" aria-label="Current file" aria-valuemin="0" aria-valuemax="100" data-f="fileBar"><i></i></div></div>' +
        '<div class="eg-stats"><span>Speed: <b data-f="speed">—</b></span><span>Time left: <b data-f="eta">working it out…</b></span></div>' +
        '<p class="eg-note">You can keep using your PC. If Glow Studio closes or the internet drops, the download continues where it stopped.</p>'
      : '';
    var actions = st === 'running'
      ? '<button type="button" class="eg-btn glass" data-act="cancel" data-primary' + (ui.busy ? ' disabled' : '') + '>Cancel</button><span class="eg-small">Cancelling keeps what is already downloaded.</span>'
      : '<button type="button" class="eg-btn primary" data-act="resume" data-primary' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy === 'resume' ? '<span class="eg-spin" aria-hidden="true"></span>' : '') + (st === 'cancelled' ? 'Resume download' : 'Try again') + '</button>' +
        '<button type="button" class="eg-btn text" data-act="changePacks">Change packs</button>' +
        (installed('core') ? '<button type="button" class="eg-btn text" data-act="notNow">Not now</button>' : '');
    return {
      shape: 'install:' + st + ':' + (ui.busy || '') + ':' + (ui.err || ''),
      say: st === 'running' ? 'Download running' : st === 'cancelled' ? 'Download paused' : 'The download stopped',
      html: '<section class="eg-card" aria-labelledby="egH"><p class="eg-kicker">Step 3 of 5</p><h2 id="egH">' + head + '</h2>' + intro +
        '<div class="eg-prog"><div class="eg-prog-h"><b>Overall</b><span><span data-f="overallTxt"></span> · <span class="eg-pct" data-f="pct"></span></span></div>' +
        '<div class="eg-bar' + (st === 'running' ? '' : ' idle') + '" role="progressbar" aria-label="Overall download" aria-valuemin="0" aria-valuemax="100" data-f="bar"><i></i></div></div>' +
        file + '<p class="eg-err" role="alert">' + esc(ui.err || '') + '</p><div class="eg-actions">' + actions + '</div></section>'
    };
  }
  function setBar(el, frac) {
    if (!el) return;
    var p = Math.max(0, Math.min(100, Math.round(frac * 1000) / 10));
    el.setAttribute('aria-valuenow', String(Math.round(p)));
    el.firstChild.style.width = p + '%';
  }
  function updInstall(root) {
    var j = S.job || {};
    var frac = j.overallTotal ? j.overallDone / j.overallTotal : 0;
    setBar($('[data-f="bar"]', root), frac);
    var t = $('[data-f="overallTxt"]', root); if (t) t.textContent = bytesGB(j.overallDone) + ' of ' + bytesGB(j.overallTotal);
    var pc = $('[data-f="pct"]', root); if (pc) pc.textContent = Math.floor(frac * 100) + '%';
    var dt = $('[data-f="doneTxt"]', root); if (dt) dt.textContent = bytesGB(j.overallDone) + ' of ' + bytesGB(j.overallTotal);
    var step = $('[data-f="step"]', root); if (step) step.textContent = j.step || 'Getting ready…';
    var box = $('[data-f="fileBox"]', root);
    if (box) {
      var hasFile = !!j.file && j.bytesTotal > 0;
      box.hidden = !hasFile;
      if (hasFile) {
        $('[data-f="fileName"]', root).textContent = L.friendlyFile(j.file);
        $('[data-f="fileTxt"]', root).textContent = bytesGB(j.bytesDone) + ' of ' + bytesGB(j.bytesTotal);
        setBar($('[data-f="fileBar"]', root), j.bytesDone / j.bytesTotal);
      }
    }
    if (j.state === 'running' && j.speedBps > 0) { ui.speeds.push(j.speedBps); if (ui.speeds.length > 8) ui.speeds.shift(); }
    var avg = ui.speeds.length ? ui.speeds.reduce(function (a, b) { return a + b; }, 0) / ui.speeds.length : 0;
    var sp = $('[data-f="speed"]', root); if (sp) sp.textContent = j.speedBps > 0 ? speed(j.speedBps) : '—';
    var eta = $('[data-f="eta"]', root);
    if (eta) eta.textContent = avg > 0 && j.overallTotal > j.overallDone ? dur((j.overallTotal - j.overallDone) / avg) : (j.overallTotal && j.overallDone >= j.overallTotal ? 'almost done' : 'working it out…');
  }

  function warmBox(inReady) {
    var w = ui.warm;
    if (w.state === 'running') {
      return '<div class="eg-sub"><h3>Quick test running</h3><p data-f="warmMsg">' + esc(w.msg || 'Starting the test…') + '</p>' +
        '<div class="eg-prog"><div class="eg-bar" role="progressbar" aria-label="Quick test" aria-valuemin="0" aria-valuemax="100" data-f="warmBar"><i></i></div></div>' +
        '<div class="eg-actions"><button type="button" class="eg-btn text" data-act="warmCancel">Stop the test</button></div></div>';
    }
    if (w.state === 'done') {
      return '<div class="eg-sub"><h3>Test passed</h3><div class="eg-thumb"><img src="' + esc(w.url) + '" alt="Test picture made by the AI engine"><p>The AI made a test picture in ' + esc(dur(w.seconds).replace('about ', '') || 'a few seconds') + '. Your first video will start faster now.</p></div></div>';
    }
    if (w.state === 'error') {
      return '<div class="eg-sub"><h3>The test didn’t finish</h3><p class="eg-err" role="alert">' + esc(w.msg) + '</p><div class="eg-actions"><button type="button" class="eg-btn glass" data-act="warm">Try the test again</button></div></div>';
    }
    return '<div class="eg-sub"><h3>Optional: quick test</h3><p>Takes about 1–3 minutes. It loads the AI into memory so your first video starts faster, and checks that everything works.</p>' +
      '<div class="eg-actions"><button type="button" class="eg-btn glass" data-act="warm"' + (inReady ? '' : ' data-primary-alt') + '>' + ICON.play + 'Run quick test</button></div></div>';
  }

  function vEngine() {
    var st = S.engine.state;
    var driverBad = S.gpu && !S.gpu.driverOk;
    var body, actions = '', say = '';
    if (st === 'starting') {
      say = 'Starting the AI engine';
      body = '<div class="eg-hl"><span class="eg-spin" aria-hidden="true"></span><h2 id="egH">Starting the AI engine…</h2></div>' +
        '<p>The first start can take a minute or two. <span data-f="elapsed"></span></p>' +
        '<div class="eg-prog"><div class="eg-bar indet" aria-hidden="true"><i></i></div></div>';
    } else if (st === 'error') {
      say = 'The AI engine couldn’t start';
      var x = L.explainEngineError(S);
      var fix = /Visual C\+\+/.test(x.message) ? '<a class="eg-btn glass" href="' + esc(L.vcRedistUrl) + '" target="_blank" rel="noopener">Get the Microsoft component' + ICON.ext + '</a>' : (/driver/i.test(x.message) ? driverLink() : '');
      body = '<h2 id="egH">The AI engine couldn’t start</h2><p class="eg-err" role="alert">' + esc(x.message) + '</p><p class="eg-note">Open “Details” below to see the engine’s messages.</p>';
      actions = '<button type="button" class="eg-btn primary" data-act="start" data-primary' + (ui.busy ? ' disabled' : '') + '>Try again</button>' + fix +
        '<button type="button" class="eg-btn text" data-act="repair">Check &amp; repair files</button>';
    } else if (st === 'ready') {
      say = 'The AI engine is running';
      body = '<div class="eg-hl"><span class="eg-dot ok" aria-hidden="true">' + ICON.ok + '</span><h2 id="egH">The AI engine is running</h2></div>' +
        '<p>It works quietly in the background while Glow Studio is open.</p>' + warmBox(false);
      actions = '<button type="button" class="eg-btn primary" data-act="finish" data-primary>' + (ui.warm.state === 'done' ? 'Finish' : 'Skip and finish') + '</button>';
    } else {
      say = 'All AI files are installed';
      body = '<h2 id="egH">Start the AI engine</h2><p>All AI files are installed. Start the engine to make videos — it runs quietly in the background while Glow Studio is open.</p>' +
        (driverBad ? '<div class="eg-verdict warn">' + dot('warn', '') + '<div><b>Update your NVIDIA driver first</b><p>The engine needs driver version ' + parseInt(S.gpu.minDriver || '580', 10) + ' or newer. Restart your PC after updating.</p></div></div>' : '');
      actions = '<button type="button" class="eg-btn primary" data-act="start" data-primary' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy === 'start' ? '<span class="eg-spin" aria-hidden="true"></span>' : ICON.play) + 'Start engine</button>' +
        (driverBad ? driverLink() : '');
    }
    return {
      shape: 'engine:' + st + ':' + ui.warm.state + ':' + (ui.busy || '') + ':' + (driverBad ? 1 : 0) + ':' + (ui.err || ''), say: say,
      html: '<section class="eg-card" aria-labelledby="egH"><p class="eg-kicker">Step 4 of 5</p>' + body + '<p class="eg-err" role="alert">' + esc(ui.err || '') + '</p>' + (actions ? '<div class="eg-actions">' + actions + '</div>' : '') + '</section>'
    };
  }
  function updEngine(root) {
    var el = $('[data-f="elapsed"]', root);
    if (el && ui.startingSince) el.textContent = 'Time so far: ' + clock((Date.now() - ui.startingSince) / 1000) + '.';
    updWarm(root);
  }
  function updWarm(root) {
    if (ui.warm.state !== 'running') return;
    setBar($('[data-f="warmBar"]', root), ui.warm.pct || 0);
    var m = $('[data-f="warmMsg"]', root); if (m) m.textContent = ui.warm.msg || '';
  }

  function vReady() {
    var chips = L.packs.map(function (p) { var on = installed(p.id); return '<li class="' + (on ? '' : 'off') + '">' + (on ? ICON.ok : '') + esc(packInfo(p.id).label) + (on ? '' : ' — not installed') + '</li>'; }).join('');
    var missing = L.packs.some(function (p) { return !installed(p.id); });
    var est = L.estimate({ quality: 'best' }).minutes;
    return {
      shape: 'ready:' + L.packs.map(function (p) { return installed(p.id) ? 1 : 0; }).join('') + ':' + ui.warm.state + ':' + (ui.busy || '') + ':' + (ui.err || ''), say: 'Free AI is ready',
      html: '<section class="eg-card" aria-labelledby="egH"><p class="eg-kicker">Step 5 of 5</p>' +
        '<div class="eg-hl"><span class="eg-big-ok" aria-hidden="true">' + ICON.ok + '</span><div><h2 id="egH">Free AI is ready</h2></div></div>' +
        '<p>Make party videos on this PC for free — about ' + minRange(est) + ' per video. Keep Glow Studio open while a video is being made.</p>' +
        '<ul class="eg-chips" aria-label="Installed packs">' + chips + '</ul>' +
        '<div class="eg-actions"><a class="eg-btn primary big" href="./#ai" data-primary>' + ICON.back + 'Back to AI Scenes</a></div>' +
        (ui.warm.state !== 'idle' ? warmBox(true) : '') +
        '<p class="eg-err" role="alert">' + esc(ui.err || '') + '</p>' +
        '<div class="eg-more">' +
        (missing ? '<button type="button" class="eg-btn text" data-act="addPacks">Add more packs</button>' : '') +
        (ui.warm.state === 'idle' ? '<button type="button" class="eg-btn text" data-act="warm">Run quick test</button>' : '') +
        '<button type="button" class="eg-btn text" data-act="stop"' + (ui.busy ? ' disabled' : '') + '>Stop engine (frees memory)</button>' +
        '<button type="button" class="eg-btn text" data-act="repair"' + (ui.busy ? ' disabled' : '') + '>Check &amp; repair files</button>' +
        '</div></section>'
    };
  }

  var VIEWS = { website: vWebsite, check: vCheck, packs: vPacks, install: vInstall, engine: vEngine, ready: vReady };
  var UPDATES = { packs: updPacks, install: updInstall, engine: updEngine, ready: updWarm };

  /* ---------------- render ---------------- */
  var firstRender = true;
  function render() {
    var v = deriveView();
    if (v === 'engine') ui.engineStep = true;
    if (S && S.engine.state === 'starting') { if (!ui.startingSince) ui.startingSince = Date.now(); } else ui.startingSince = 0;
    var b = VIEWS[v]();
    if (b.shape !== ui.shape) {
      var hadFocus = els.view.contains(document.activeElement) || ui.pendingFocus;
      var viewChanged = v !== ui.view;
      els.view.innerHTML = b.html;
      ui.shape = b.shape;
      if (!firstRender) {
        var target = null;
        if (viewChanged) target = $('h2', els.view);
        else if (hadFocus) target = $('[data-primary]', els.view) || $('h2', els.view);
        if (target && target.disabled) target = $('h2', els.view);
        if (target) {
          if (target.tagName === 'H2') target.setAttribute('tabindex', '-1');
          try { target.focus({ preventScroll: !viewChanged }); } catch (e) { target.focus(); }
          ui.pendingFocus = !!ui.busy; // keep handing focus on while an action is still running
        }
        if (b.say) announce(b.say);
      }
    }
    ui.view = v;
    if (UPDATES[v]) UPDATES[v](els.view);
    renderSteps(v);
    renderBanner();
    renderDetails();
    firstRender = false;
  }
  function announce(t) { els.live.textContent = ''; setTimeout(function () { els.live.textContent = t; }, 30); }
  function renderSteps(v) {
    var n = STEP_OF[v];
    els.steps.hidden = !n;
    if (!n) return;
    Array.prototype.forEach.call(els.steps.children, function (li) {
      var k = +li.getAttribute('data-step');
      var done = k < n || (v === 'ready' && k === 5);
      li.className = done ? 'done' : (k === n ? 'now' : '');
      if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      li.querySelector('i').innerHTML = done ? '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span class="eg-live">done</span>' : String(k);
    });
  }
  function renderBanner() {
    var show = S && ui.offline >= 2;
    els.banner.hidden = !show;
    if (show) els.banner.textContent = 'Glow Studio isn’t answering. Make sure the Glow Studio app is still open — this page reconnects by itself.';
  }
  function renderDetails() {
    els.details.hidden = !S;
    if (!S) return;
    var g = S.gpu, j = S.job, e = S.engine;
    var facts = [
      ['App version', S.launcher],
      ['AI engine', e.comfyVersion ? 'ComfyUI ' + e.comfyVersion + ' (' + e.state + ')' : e.state],
      ['Install folder', S.installDir],
      ['Graphics', g ? g.name + ', ' + g.vramMB + ' MB, driver ' + (g.driver || '?') + (g.driverOk ? '' : ' (needs ' + g.minDriver + '+)') : 'none found'],
      ['Free space', gb1(S.diskFreeGB)]
    ];
    if (j) facts.push(['Last download', j.state + ' — ' + (j.step || '') + (j.file ? ' — ' + j.file : '')]);
    if (j && j.error) facts.push(['Download error', j.error]);
    if (e.error) facts.push(['Engine error', e.error]);
    els.facts.innerHTML = facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('');
    var log = (e.log || []).join('\n') || 'No messages yet.';
    if (els.log.textContent !== log) {
      var atEnd = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 8;
      els.log.textContent = log;
      if (atEnd) els.log.scrollTop = els.log.scrollHeight;
    }
  }

  /* ---------------- polling ---------------- */
  var pollTimer = null, inflight = false;
  function needFast() { return !!(S && ((S.job && S.job.state === 'running') || S.engine.state === 'starting' || ui.warm.state === 'running' || ui.offline)); }
  function refresh() {
    if (inflight) return Promise.resolve();
    inflight = true;
    return L.status().then(function (s) {
      var wasReady = S && S.engine.state === 'ready';
      S = s; ui.offline = 0;
      if (s.engine.state === 'ready' && !wasReady) loadSysRam();
    }, function () { ui.offline++; }).then(function () { inflight = false; render(); });
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { refresh().then(schedule); }, needFast() ? POLL_FAST : POLL_SLOW);
  }
  function loadSysRam() {
    if (S && (typeof S.ramGB === 'number' || typeof S.ramMB === 'number')) return;
    fetch('/__glow/comfy/system_stats', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.system && d.system.ram_total) { ui.sysRamGB = d.system.ram_total / 1073741824; render(); }
    }).catch(function () { /* optional */ });
  }
  function heartbeat() {
    // the launcher quits a few minutes after the last open page stops pinging
    function ping() { fetch('/__glow/ping', { cache: 'no-store' }).catch(function () { /* ignore */ }); }
    ping();
    setInterval(ping, 15000);
  }

  /* ---------------- actions ---------------- */
  function act(name, fn) {
    ui.pendingFocus = els.view.contains(document.activeElement);
    ui.busy = name; ui.err = null; render();
    return Promise.resolve().then(fn).then(function () { return refresh(); }, function (e) { ui.err = (e && e.message) || 'Something went wrong. Please try again.'; })
      .then(function () { ui.busy = null; render(); schedule(); });
  }
  var ACTIONS = {
    recheck: function () { return act('recheck', function () { return null; }); },
    'continue': function () { ui.passedCheck = true; render(); },
    back: function () { ui.err = null; if (installed('core')) ui.force = null; else ui.passedCheck = false; render(); },
    dirChange: function () { ui.dirEdit = true; ui.dir = ui.dir || S.installDir || ''; render(); var i = $('#egDir'); if (i) { i.focus(); i.select(); } },
    dirDefault: function () { ui.dirEdit = false; ui.dir = ''; render(); var b = $('[data-act="dirChange"]'); if (b) b.focus(); },
    install: function () {
      var packs = selectedPacks();
      var dir;
      if (ui.dirEdit) {
        var p = dirProblem(ui.dir, false);
        if (p) { ui.err = p; render(); var i = $('#egDir'); if (i) i.focus(); return; }
        if (ui.dir.trim() !== S.installDir) dir = ui.dir.trim();
      }
      return act('install', function () {
        return L.install(packs, dir).then(function () {
          prefs = { packs: packs, dir: dir || '' }; lsSet(PREF_KEY, prefs);
          ui.force = null; ui.dismissJob = false; ui.speeds = []; ui.dirEdit = false;
        });
      });
    },
    cancel: function () { return act('cancel', function () { return L.cancel(); }); },
    resume: function () {
      var packs = (prefs.packs && prefs.packs.length) ? prefs.packs : selectedPacks();
      return act('resume', function () { ui.speeds = []; return L.install(packs, prefs.dir || undefined); });
    },
    changePacks: function () { ui.force = 'packs'; ui.passedCheck = true; ui.dismissJob = true; render(); },
    notNow: function () { ui.dismissJob = true; render(); },
    addPacks: function () { ui.force = 'packs'; ui.err = null; render(); },
    start: function () { return act('start', function () { return L.start(); }); },
    stop: function () { ui.finished = false; return act('stop', function () { return L.stop(); }); },
    repair: function () {
      var packs = L.packs.filter(function (p) { return installed(p.id); }).map(function (p) { return p.id; });
      prefs = { packs: packs, dir: '' }; lsSet(PREF_KEY, prefs);
      return act('repair', function () { return L.install(packs); });
    },
    finish: function () { ui.finished = true; render(); },
    warm: function () {
      if (ui.warm.state === 'running') return;
      ui.warmCtl = typeof AbortController === 'function' ? new AbortController() : null;
      ui.warm = { state: 'running', pct: 0, msg: 'Starting the test…' };
      render(); schedule();
      L.warmup(function (p) { ui.warm.pct = p.overall; ui.warm.msg = p.message; if (ui.view) updWarm(els.view); }, { signal: ui.warmCtl && ui.warmCtl.signal })
        .then(function (r) { ui.warm = { state: 'done', seconds: r.seconds, url: r.stillUrl }; },
          function (e) { ui.warm = e && e.name === 'AbortError' ? { state: 'idle' } : { state: 'error', msg: (e && e.message) || 'The test didn’t work.' }; })
        .then(function () { render(); });
    },
    warmCancel: function () { if (ui.warmCtl) ui.warmCtl.abort(); }
  };

  els.view.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    var fn = ACTIONS[el.getAttribute('data-act')];
    if (fn) { ev.preventDefault(); fn(el); }
  });
  els.view.addEventListener('change', function (ev) {
    var cb = ev.target.closest('.eg-pack input');
    if (!cb) return;
    var id = cb.value;
    var i = ui.sel.indexOf(id);
    if (cb.checked && i < 0) ui.sel.push(id);
    if (!cb.checked && i >= 0) ui.sel.splice(i, 1);
    prefs.packs = selectedPacks(); lsSet(PREF_KEY, prefs);
    updPacks(els.view);
  });
  els.view.addEventListener('input', function (ev) {
    if (ev.target.id === 'egDir') { ui.dir = ev.target.value; updPacks(els.view); }
  });
  els.view.addEventListener('keydown', function (ev) {
    if (ev.target.id === 'egDir' && ev.key === 'Enter') { ev.preventDefault(); ACTIONS.install(); }
  });

  /* ---------------- start ---------------- */
  L.detect().then(function (s) {
    S = s;
    if (s) {
      heartbeat();
      if (s.engine.state === 'ready') loadSysRam();
      // a reload in the middle of a running install comes straight back to step 3 (derived from status.job)
      if (installed('core')) ui.passedCheck = true;
    }
    render();
    if (s) schedule();
  });
})();
