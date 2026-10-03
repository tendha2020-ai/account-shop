// game.js — Neon Pulse, a 4-lane falling-note rhythm game.
// The soundtrack is synthesized with Web Audio and the note chart is generated
// from the same melody, so every note lines up with something you can hear.
'use strict';

(() => {
  // ---------- Constants ----------
  const BPM = 132;
  const BEAT = 60 / BPM;
  const SIX = BEAT / 4; // one sixteenth note
  const BAR = BEAT * 4;
  const TOTAL_BARS = 49;
  const LEAD_IN = 2; // seconds of silence before the song starts

  const KEYS = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
  const KEY_LABELS = ['D', 'F', 'J', 'K'];
  const WIN = { PERFECT: 0.045, GREAT: 0.09, GOOD: 0.135 };
  const HOLD_RELEASE_GRACE = 0.12;
  const WEIGHT = { PERFECT: 1, GREAT: 0.7, GOOD: 0.4, MISS: 0 };
  const JUDGE_COLORS = { GREAT: '#ff8ad8', GOOD: '#8dff9a', MISS: '#9aa4b5' };

  const DIFFS = {
    easy: { name: 'EASY', lv: 5, step: 4, doubles: false },
    normal: { name: 'NORMAL', lv: 12, step: 2, doubles: false },
    hard: { name: 'HARD', lv: 22, step: 1, doubles: true },
  };

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('neonpulse.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('neonpulse.' + key, JSON.stringify(value));
      } catch (e) {
        // Storage unavailable (private mode etc.) — settings just won't persist.
      }
    },
  };

  // ---------- Song + chart generation ----------
  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Am – F – C – G, one chord per bar. Lead tones are ordered low→high so the
  // lane a note sits in matches its pitch.
  const CHORDS = [
    { lead: [69, 72, 76, 81], pad: [57, 60, 64], bass: 45 },
    { lead: [65, 69, 72, 77], pad: [53, 57, 60], bass: 41 },
    { lead: [67, 72, 76, 79], pad: [55, 60, 64], bass: 48 },
    { lead: [67, 71, 74, 79], pad: [55, 59, 62], bass: 43 },
  ];

  // 16 sixteenth slots per bar: x = note, - = sustain, . = rest.
  const RHYTHMS = {
    intro: ['x.......x.......'],
    verse: ['x...x.x.x...x.x.', 'x.x...x.x.x.x...', 'x...x.x.x...x.x.', 'x...x...x.x.x---'],
    build: ['x.x.x.x.x.x.x.x.', 'x.x.x.x.x.x.x.x.', 'x.x.x.x.x.x.x.x.', 'x.x.x.x.xxxxxxxx'],
    chorus: ['x.x.xx.xx.x.xx.x', 'x---x.x.x---x.x.', 'x.xxx.x.x.xxx.x.', 'x.x.x.x.x-------'],
    breakdown: ['x-------x-------', 'x---------------'],
    outro: ['x---------------'],
  };

  function sectionOf(bar) {
    if (bar < 4) return 'intro';
    if (bar < 12) return 'verse';
    if (bar < 16) return 'build';
    if (bar < 32) return 'chorus';
    if (bar < 36) return 'breakdown';
    if (bar < 48) return 'chorus2';
    return 'outro';
  }

  function buildSong() {
    const rng = mulberry32(20260928);
    const audio = [];
    const melody = [];
    let lane = 1;

    for (let bar = 0; bar < TOTAL_BARS; bar++) {
      const sec = sectionOf(bar);
      const chord = CHORDS[bar % 4];
      const t0 = bar * BAR;
      const full = sec === 'chorus' || sec === 'chorus2';
      const groove = sec === 'verse' || sec === 'build' || full;

      audio.push({ t: t0, type: 'pad', notes: chord.pad, dur: sec === 'outro' ? BAR * 2 : BAR });
      if (bar === 16 || bar === 36 || bar === 48) audio.push({ t: t0, type: 'crash' });

      for (let b = 0; b < 4; b++) {
        const tb = t0 + b * BEAT;
        if (groove || (sec === 'breakdown' && bar >= 34) || (sec === 'outro' && b === 0)) {
          audio.push({ t: tb, type: 'kick' });
        }
        if ((sec === 'build' || full) && (b === 1 || b === 3)) audio.push({ t: tb, type: 'snare', vol: 1 });
        if (sec !== 'outro') audio.push({ t: tb + BEAT / 2, type: 'hat', open: full });
        if (sec === 'chorus2') {
          audio.push({ t: tb + SIX, type: 'hat' });
          audio.push({ t: tb + 3 * SIX, type: 'hat' });
        }
        if (groove) {
          if (full) audio.push({ t: tb, type: 'bass', pitch: chord.bass, dur: BEAT / 2 * 0.9 });
          audio.push({ t: tb + BEAT / 2, type: 'bass', pitch: chord.bass + (full ? 12 : 0), dur: BEAT / 2 * 0.9 });
        }
      }
      if (bar === 15) {
        for (let s = 0; s < 16; s++) audio.push({ t: t0 + s * SIX, type: 'snare', vol: 0.25 + s / 20 });
      }

      const list = RHYTHMS[sec === 'chorus2' ? 'chorus' : sec];
      const rhythm = list[bar % list.length];
      for (let s = 0; s < 16; s++) {
        if (rhythm[s] !== 'x') continue;
        let len = 1;
        while (s + len < 16 && rhythm[s + len] === '-') len++;

        const steps = [-2, -1, 1, 2];
        let next = lane + steps[Math.floor(rng() * steps.length)];
        if (next < 0) next = -next;
        if (next > 3) next = 6 - next;
        if (next === lane) next = (lane + 1) % 4;
        lane = next;

        const t = t0 + s * SIX;
        const dur = len * SIX;
        melody.push({ t, dur, lane, slot: s, hold: len >= 4, double: false });
        audio.push({ t, type: 'lead', pitch: chord.lead[lane], dur: dur * 0.92 });

        // Chorus downbeats get a harmony note in the opposite lane (charted on Hard).
        if (full && (s === 0 || s === 8)) {
          const lane2 = (lane + 2) % 4;
          melody.push({ t, dur: SIX, lane: lane2, slot: s, hold: false, double: true });
          audio.push({ t, type: 'lead', pitch: chord.lead[lane2], dur: SIX * 0.9, soft: true });
        }
      }
    }

    audio.sort((a, b) => a.t - b.t);
    return { audio, melody, length: TOTAL_BARS * BAR };
  }

  const song = buildSong();

  function buildChart(diffKey) {
    const d = DIFFS[diffKey];
    const notes = song.melody
      .filter((n) => n.slot % d.step === 0 && (!n.double || d.doubles))
      .map((n) => ({
        t: n.t,
        end: n.hold ? n.t + n.dur : null,
        lane: n.lane,
        judged: false,
        holding: false,
        done: false,
        pair: false,
      }));
    notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
    for (let i = 1; i < notes.length; i++) {
      if (Math.abs(notes[i].t - notes[i - 1].t) < 1e-6) {
        notes[i].pair = true;
        notes[i - 1].pair = true;
      }
    }
    return notes;
  }

  // ---------- Audio ----------
  let actx = null;
  let comp = null;
  let bus = null;
  let noiseBuf = null;

  function initAudio() {
    if (actx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    actx = new Ctx();
    comp = actx.createDynamicsCompressor();
    comp.connect(actx.destination);
    noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    resetBus();
  }

  // Swapping the bus silences anything already scheduled (used on restart/quit).
  function resetBus() {
    if (bus) bus.disconnect();
    bus = actx.createGain();
    bus.gain.value = 0.55;
    bus.connect(comp);
  }

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function envelope(param, at, attack, peak, hold, release) {
    param.setValueAtTime(0.0001, at);
    param.exponentialRampToValueAtTime(peak, at + attack);
    param.setValueAtTime(peak, at + Math.max(attack, hold));
    param.exponentialRampToValueAtTime(0.0001, at + Math.max(attack, hold) + release);
    return at + Math.max(attack, hold) + release;
  }

  function noise(at, filterType, freq, q, peak, decay) {
    const src = actx.createBufferSource();
    src.buffer = noiseBuf;
    const f = actx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = actx.createGain();
    const end = envelope(g.gain, at, 0.002, peak, 0, decay);
    src.connect(f).connect(g).connect(bus);
    src.start(at);
    src.stop(end + 0.02);
  }

  function tone(at, type, freq, peak, attack, hold, release, filterFreq, detune) {
    const o = actx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    const g = actx.createGain();
    const end = envelope(g.gain, at, attack, peak, hold, release);
    if (filterFreq) {
      const f = actx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filterFreq;
      o.connect(f).connect(g);
    } else {
      o.connect(g);
    }
    g.connect(bus);
    o.start(at);
    o.stop(end + 0.02);
  }

  function playEvent(ev, at) {
    switch (ev.type) {
      case 'kick': {
        const o = actx.createOscillator();
        o.frequency.setValueAtTime(160, at);
        o.frequency.exponentialRampToValueAtTime(42, at + 0.12);
        const g = actx.createGain();
        const end = envelope(g.gain, at, 0.002, 0.9, 0.02, 0.3);
        o.connect(g).connect(bus);
        o.start(at);
        o.stop(end + 0.02);
        break;
      }
      case 'snare':
        noise(at, 'bandpass', 1800, 0.8, 0.35 * ev.vol, 0.16);
        tone(at, 'triangle', 190, 0.2 * ev.vol, 0.002, 0, 0.09);
        break;
      case 'hat':
        noise(at, 'highpass', 7500, 0.7, 0.1, ev.open ? 0.12 : 0.035);
        break;
      case 'crash':
        noise(at, 'highpass', 4000, 0.5, 0.22, 1.4);
        break;
      case 'bass':
        tone(at, 'sawtooth', mtof(ev.pitch - 12), 0.2, 0.005, ev.dur, 0.05, 520);
        break;
      case 'pad':
        for (const n of ev.notes) {
          tone(at, 'sawtooth', mtof(n), 0.035, 0.25, ev.dur - 0.25, 0.4, 1100, -8);
          tone(at, 'sawtooth', mtof(n), 0.035, 0.25, ev.dur - 0.25, 0.4, 1100, 8);
        }
        break;
      case 'lead': {
        const peak = ev.soft ? 0.05 : 0.09;
        tone(at, 'square', mtof(ev.pitch), peak, 0.005, ev.dur, 0.08, 3200);
        tone(at, 'sawtooth', mtof(ev.pitch), peak * 0.6, 0.005, ev.dur, 0.08, 3200, 6);
        break;
      }
    }
  }

  function playTick() {
    if (!actx || !settings.hitsound) return;
    tone(actx.currentTime, 'sine', 1760, 0.08, 0.001, 0, 0.04);
  }

  // ---------- Settings ----------
  const settings = {
    speed: store.get('speed', 5),
    offset: store.get('offset', 0),
    hitsound: store.get('hitsound', true),
    crosshair: store.get('crosshair', 'cross'),
    diff: store.get('diff', 'normal'),
  };
  if (!DIFFS[settings.diff]) settings.diff = 'normal';
  if (!['off', 'cross', 'dot', 'circle'].includes(settings.crosshair)) settings.crosshair = 'cross';
  const approach = () => 3 / (0.5 + settings.speed * 0.25);

  // ---------- Game state ----------
  let game = null;

  function newGame(diffKey, versus) {
    const chart = buildChart(diffKey);
    const holds = chart.filter((n) => n.end !== null).length;
    const lastEnd = chart.reduce((m, n) => Math.max(m, n.end ?? n.t), 0);
    return {
      diff: diffKey,
      chart,
      totalUnits: chart.length + holds,
      endTime: Math.max(lastEnd, song.length) + 1.5,
      firstLive: 0,
      schedIdx: 0,
      t0: 0,
      counts: { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 },
      weightSum: 0,
      judgedUnits: 0,
      combo: 0,
      maxCombo: 0,
      score: 0,
      judgement: null,
      paused: false,
      finished: false,
      versus: !!versus,
    };
  }

  function songNow() {
    const latency = actx.outputLatency || 0;
    return actx.currentTime - game.t0 - settings.offset / 1000 - latency;
  }

  function startGame(diffKey, versus) {
    initAudio();
    actx.resume();
    resetBus();
    game = newGame(diffKey, versus);
    game.t0 = actx.currentTime + LEAD_IN;
    effects.length = 0;
    particles.length = 0;
    laneHeld.fill(0);
    pointerLanes.clear();
    mode = 'play';
    showOnly(null);
    pauseBtn.classList.remove('hidden');
  }

  function pauseGame() {
    if (mode !== 'play' || game.paused) return;
    game.paused = true;
    actx.suspend();
    laneHeld.fill(0);
    pointerLanes.clear();
    showOnly(pauseEl);
  }

  function resumeGame() {
    if (!game || !game.paused) return;
    game.paused = false;
    actx.resume();
    showOnly(null);
  }

  function quitToMenu() {
    if (actx) {
      resetBus();
      actx.resume();
    }
    game = null;
    mode = 'menu';
    pauseBtn.classList.add('hidden');
    leaveVersus();
    refreshMenu();
    showOnly(menuEl);
  }

  function applyJudgement(grade, lane, dt, silent) {
    game.counts[grade]++;
    game.judgedUnits++;
    game.weightSum += WEIGHT[grade];
    if (grade === 'MISS') {
      game.combo = 0;
    } else {
      game.combo++;
      game.maxCombo = Math.max(game.maxCombo, game.combo);
      spawnHit(lane, grade);
    }
    game.score = Math.round((1e6 * game.weightSum) / game.totalUnits);
    if (!silent) {
      const timing = grade === 'GREAT' || grade === 'GOOD' ? (dt < 0 ? 'FAST' : 'SLOW') : '';
      game.judgement = { grade, timing, at: performance.now() };
    }
  }

  function gradeFor(dt) {
    const a = Math.abs(dt);
    if (a <= WIN.PERFECT) return 'PERFECT';
    if (a <= WIN.GREAT) return 'GREAT';
    return 'GOOD';
  }

  function pressLane(lane) {
    laneHeld[lane]++;
    laneFlash[lane] = performance.now();
    if (mode !== 'play' || game.paused) return;
    const now = songNow();
    const chart = game.chart;
    for (let i = game.firstLive; i < chart.length; i++) {
      const n = chart[i];
      if (n.t - now > WIN.GOOD) break;
      if (n.judged || n.lane !== lane || now - n.t > WIN.GOOD) continue;
      const dt = now - n.t;
      const grade = gradeFor(dt);
      n.judged = true;
      if (n.end !== null) n.holding = true;
      else n.done = true;
      applyJudgement(grade, lane, dt);
      playTick();
      return;
    }
  }

  function releaseLane(lane) {
    laneHeld[lane] = Math.max(0, laneHeld[lane] - 1);
    if (laneHeld[lane] > 0 || mode !== 'play' || game.paused) return;
    const now = songNow();
    for (let i = game.firstLive; i < game.chart.length; i++) {
      const n = game.chart[i];
      if (n.t > now) break;
      if (!n.holding || n.lane !== lane) continue;
      n.holding = false;
      n.done = true;
      if (now >= n.end - HOLD_RELEASE_GRACE) applyJudgement('PERFECT', lane, 0);
      else applyJudgement('MISS', lane, 0);
    }
  }

  function updateGame() {
    if (game.paused || game.finished) return;
    const now = songNow();

    // Schedule audio slightly ahead of the playhead.
    const horizon = actx.currentTime + 0.25;
    while (game.schedIdx < song.audio.length) {
      const ev = song.audio[game.schedIdx];
      const at = game.t0 + ev.t;
      if (at > horizon) break;
      if (at >= actx.currentTime - 0.05) playEvent(ev, Math.max(at, actx.currentTime));
      game.schedIdx++;
    }

    const chart = game.chart;
    for (let i = game.firstLive; i < chart.length; i++) {
      const n = chart[i];
      if (n.t - now > WIN.GOOD) break;
      if (!n.judged && now - n.t > WIN.GOOD) {
        n.judged = true;
        n.done = true;
        applyJudgement('MISS', n.lane, 0);
        if (n.end !== null) applyJudgement('MISS', n.lane, 0, true);
      } else if (n.holding) {
        if (now >= n.end) {
          n.holding = false;
          n.done = true;
          applyJudgement('PERFECT', n.lane, 0);
        } else if (Math.random() < 0.35) {
          spawnSparks(n.lane, 1);
        }
      }
    }
    while (game.firstLive < chart.length && chart[game.firstLive].done) game.firstLive++;

    if (game.versus && performance.now() - vs.lastSent > 250) {
      vs.lastSent = performance.now();
      setPresence({ mode: 'playing', score: game.score, combo: game.combo, progress: Math.min(1, Math.max(0, now / song.length)) });
    }

    if (now > game.endTime) finishGame();
  }

  function rankFor(score) {
    if (score >= 1e6) return 'SSS';
    if (score >= 980000) return 'SS';
    if (score >= 950000) return 'S';
    if (score >= 900000) return 'A';
    if (score >= 800000) return 'B';
    if (score >= 700000) return 'C';
    return 'D';
  }

  function finishGame() {
    game.finished = true;
    mode = 'results';
    pauseBtn.classList.add('hidden');
    const c = game.counts;
    const rank = rankFor(game.score);
    const allPerfect = c.PERFECT === game.totalUnits;
    const fullCombo = c.MISS === 0;
    const bests = store.get('best', {});
    const prev = bests[game.diff];
    const isNewBest = !prev || game.score > prev.score;
    if (isNewBest) {
      bests[game.diff] = { score: game.score, rank, fc: fullCombo, ap: allPerfect };
      store.set('best', bests);
    }

    const d = DIFFS[game.diff];
    $('resDiff').textContent = `${d.name}  Lv.${d.lv}`;
    $('resRank').textContent = rank;
    $('resBadge').textContent = allPerfect ? 'ALL PERFECT' : fullCombo ? 'FULL COMBO' : '';
    $('resScore').textContent = String(game.score).padStart(7, '0');
    $('resBest').classList.toggle('hidden', !isNewBest);
    $('cPerfect').textContent = c.PERFECT;
    $('cGreat').textContent = c.GREAT;
    $('cGood').textContent = c.GOOD;
    $('cMiss').textContent = c.MISS;
    $('cCombo').textContent = game.maxCombo;
    $('cAcc').textContent = ((100 * game.weightSum) / game.totalUnits).toFixed(2) + '%';
    $('resVs').classList.toggle('hidden', !game.versus);
    $('retryBtn').textContent = game.versus ? 'REMATCH' : 'RETRY';
    if (game.versus) {
      setPresence({ mode: 'done', score: game.score, combo: 0, progress: 1, fc: fullCombo });
      renderVersusResults();
    }
    showOnly(resultsEl);
  }

  // ---------- Rendering ----------
  const canvas = document.getElementById('board');
  const g = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let geo = null;
  let mode = 'menu';
  const laneHeld = [0, 0, 0, 0];
  const laneFlash = [0, 0, 0, 0];
  const pointerLanes = new Map();
  const effects = [];
  const particles = [];

  const DEPTH = 2.6;
  const S_MIN = 1 / (1 + DEPTH);
  const SLOPE_AT_LINE = DEPTH / (1 - S_MIN);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    geo = { topY: H * 0.14, judgeY: H * 0.8, cx: W / 2, topW: W * 0.3, botW: W * 0.94 };
  }

  // p: 0 = far end of the highway, 1 = judgement line. n: perspective-corrected 0..1.
  function depthToN(p) {
    if (p > 1) return 1 + (p - 1) * SLOPE_AT_LINE;
    const s = 1 / (1 + (1 - p) * DEPTH);
    return (s - S_MIN) / (1 - S_MIN);
  }
  const yAt = (n) => geo.topY + n * (geo.judgeY - geo.topY);
  const wAt = (n) => geo.topW + n * (geo.botW - geo.topW);
  const laneX = (lane, n, frac) => geo.cx - wAt(n) / 2 + ((lane + frac) * wAt(n)) / 4;

  function lanePath(lane, nTop, nBot, inset) {
    const a = inset;
    const b = 1 - inset;
    g.beginPath();
    g.moveTo(laneX(lane, nTop, a), yAt(nTop));
    g.lineTo(laneX(lane, nTop, b), yAt(nTop));
    g.lineTo(laneX(lane, nBot, b), yAt(nBot));
    g.lineTo(laneX(lane, nBot, a), yAt(nBot));
    g.closePath();
  }

  function spawnHit(lane, grade) {
    effects.push({ lane, grade, at: performance.now() });
    spawnSparks(lane, grade === 'PERFECT' ? 10 : 6);
  }

  function spawnSparks(lane, count) {
    const x = laneX(lane, 1, 0.5);
    const lw = geo.botW / 4;
    for (let i = 0; i < count; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * lw * 0.6,
        y: geo.judgeY,
        vx: (Math.random() - 0.5) * 220,
        vy: -120 - Math.random() * 320,
        life: 0.35 + Math.random() * 0.35,
        age: 0,
        size: 2 + Math.random() * 3,
      });
    }
  }

  function drawBackground(now) {
    const pulse = Math.exp(-((((now % BEAT) + BEAT) % BEAT) / BEAT) * 5);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0520');
    bg.addColorStop(0.55, '#1a0b45');
    bg.addColorStop(1, '#120630');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    const glow = g.createRadialGradient(geo.cx, geo.topY, 0, geo.cx, geo.topY, W * 0.9);
    glow.addColorStop(0, `rgba(90, 220, 255, ${0.22 + pulse * 0.18})`);
    glow.addColorStop(0.4, 'rgba(120, 80, 255, 0.10)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);

    // Slow diagonal light beams.
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const phase = now * 0.08 + i * 2.1;
      const x = geo.cx + Math.sin(phase) * W * 0.5;
      g.save();
      g.translate(x, geo.topY);
      g.rotate(-0.5 + Math.sin(phase * 0.7) * 0.25);
      const beam = g.createLinearGradient(-30, 0, 30, 0);
      beam.addColorStop(0, 'rgba(120, 240, 255, 0)');
      beam.addColorStop(0.5, 'rgba(120, 240, 255, 0.07)');
      beam.addColorStop(1, 'rgba(120, 240, 255, 0)');
      g.fillStyle = beam;
      g.fillRect(-30, -H, 60, H * 2.5);
      g.restore();
    }
    g.restore();
  }

  function drawHighway(now) {
    const nBottom = depthToN(1) + (H - geo.judgeY) / (geo.judgeY - geo.topY);
    g.beginPath();
    g.moveTo(geo.cx - wAt(0) / 2, yAt(0));
    g.lineTo(geo.cx + wAt(0) / 2, yAt(0));
    g.lineTo(geo.cx + wAt(nBottom) / 2, yAt(nBottom));
    g.lineTo(geo.cx - wAt(nBottom) / 2, yAt(nBottom));
    g.closePath();
    const hw = g.createLinearGradient(0, geo.topY, 0, H);
    hw.addColorStop(0, 'rgba(40, 30, 110, 0.35)');
    hw.addColorStop(0.75, 'rgba(50, 70, 170, 0.6)');
    hw.addColorStop(1, 'rgba(25, 12, 70, 0.9)');
    g.fillStyle = hw;
    g.fill();

    // Lane press glow.
    const t = performance.now();
    for (let lane = 0; lane < 4; lane++) {
      const fade = laneHeld[lane] > 0 ? 1 : Math.max(0, 1 - (t - laneFlash[lane]) / 150);
      if (fade <= 0) continue;
      lanePath(lane, 0.35, 1, 0.02);
      const lg = g.createLinearGradient(0, yAt(0.35), 0, geo.judgeY);
      lg.addColorStop(0, 'rgba(120, 240, 255, 0)');
      lg.addColorStop(1, `rgba(120, 240, 255, ${0.35 * fade})`);
      g.fillStyle = lg;
      g.fill();
    }

    // Bar lines scrolling toward the player.
    if (mode === 'play' || mode === 'results') {
      const A = approach();
      const firstBar = Math.max(0, Math.floor(now / BAR));
      for (let b = firstBar; b <= firstBar + Math.ceil(A / BAR) + 1; b++) {
        const p = 1 - (b * BAR - now) / A;
        if (p < 0 || p > 1) continue;
        const n = depthToN(p);
        g.strokeStyle = 'rgba(170, 200, 255, 0.18)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(geo.cx - wAt(n) / 2, yAt(n));
        g.lineTo(geo.cx + wAt(n) / 2, yAt(n));
        g.stroke();
      }
    }

    // Lane dividers and glowing edges.
    for (let i = 0; i <= 4; i++) {
      const edge = i === 0 || i === 4;
      g.strokeStyle = edge ? 'rgba(130, 235, 255, 0.8)' : 'rgba(160, 200, 255, 0.22)';
      g.lineWidth = edge ? 2 : 1;
      g.shadowColor = edge ? '#5ff3ff' : 'transparent';
      g.shadowBlur = edge ? 10 : 0;
      g.beginPath();
      g.moveTo(geo.cx - wAt(0) / 2 + (i * wAt(0)) / 4, yAt(0));
      g.lineTo(geo.cx - wAt(nBottom) / 2 + (i * wAt(nBottom)) / 4, yAt(nBottom));
      g.stroke();
    }
    g.shadowBlur = 0;

    // Key hints below the line.
    g.fillStyle = 'rgba(200, 230, 255, 0.35)';
    g.font = `600 ${Math.round(W * 0.04)}px "Segoe UI", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const hintN = 1 + ((H - geo.judgeY) * 0.5) / (geo.judgeY - geo.topY);
    for (let lane = 0; lane < 4; lane++) g.fillText(KEY_LABELS[lane], laneX(lane, hintN, 0.5), yAt(hintN));
  }

  function drawNotes(now) {
    const A = approach();
    const chart = game.chart;
    const half = 0.0065;
    const minPx = 4;

    // Hold bodies first so tap heads draw on top.
    for (let i = game.firstLive; i < chart.length; i++) {
      const n = chart[i];
      if (n.t - now > A) break;
      if (n.end === null || n.done) continue;
      const pHead = n.holding ? 1 : 1 - (n.t - now) / A;
      const pTail = Math.max(0, 1 - (n.end - now) / A);
      if (pHead < 0) continue;
      const nTop = depthToN(pTail);
      const nBot = depthToN(Math.min(pHead, 1.1));
      lanePath(n.lane, nTop, nBot, 0.16);
      const body = g.createLinearGradient(0, yAt(nTop), 0, yAt(nBot));
      const a = n.holding ? 0.75 : 0.45;
      body.addColorStop(0, `rgba(180, 130, 255, ${a})`);
      body.addColorStop(1, `rgba(110, 235, 255, ${a})`);
      g.fillStyle = body;
      g.fill();
      // Tail cap.
      if (pTail > 0) drawCap(n.lane, pTail, half * 0.6, 'rgba(220, 200, 255, 0.9)');
    }

    let prevPair = null;
    for (let i = game.firstLive; i < chart.length; i++) {
      const n = chart[i];
      if (n.t - now > A) break;
      if (n.judged) continue;
      const p = 1 - (n.t - now) / A;
      if (p < 0) continue;
      drawCap(n.lane, p, half, null);
      if (n.pair) {
        if (prevPair && prevPair.t === n.t) {
          const y = yAt(depthToN(p));
          g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(laneX(prevPair.lane, depthToN(p), 0.85), y);
          g.lineTo(laneX(n.lane, depthToN(p), 0.15), y);
          g.stroke();
        }
        prevPair = n;
      }
    }

    function drawCap(lane, p, h, flat) {
      let nTop = depthToN(p - h);
      let nBot = depthToN(p + h);
      const px = yAt(nBot) - yAt(nTop);
      if (px < minPx) {
        const mid = (nTop + nBot) / 2;
        const dn = minPx / 2 / (geo.judgeY - geo.topY);
        nTop = mid - dn;
        nBot = mid + dn;
      }
      lanePath(lane, nTop, nBot, 0.06);
      if (flat) {
        g.fillStyle = flat;
      } else {
        const grad = g.createLinearGradient(0, yAt(nTop), 0, yAt(nBot));
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.5, '#9ff7ff');
        grad.addColorStop(1, '#3fb8ff');
        g.fillStyle = grad;
      }
      g.shadowColor = '#5ff3ff';
      g.shadowBlur = 12;
      g.fill();
      g.shadowBlur = 0;
    }
  }

  function drawJudgeLine() {
    const w = wAt(1);
    g.save();
    g.shadowColor = '#7ff6ff';
    g.shadowBlur = 16;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(geo.cx - w / 2, geo.judgeY);
    g.lineTo(geo.cx + w / 2, geo.judgeY);
    g.stroke();
    g.strokeStyle = 'rgba(160, 240, 255, 0.6)';
    g.lineWidth = 1;
    const y2 = geo.judgeY + H * 0.012;
    g.beginPath();
    g.moveTo(geo.cx - w / 2, y2);
    g.lineTo(geo.cx + w / 2, y2);
    g.stroke();
    g.restore();
  }

  function drawEffects(dt) {
    const t = performance.now();
    const lw = geo.botW / 4;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const age = (t - e.at) / 1000;
      if (age > 0.4) {
        effects.splice(i, 1);
        continue;
      }
      const k = 1 - age / 0.4;
      const x = laneX(e.lane, 1, 0.5);
      // Light pillar.
      lanePath(e.lane, 0.55, 1, 0.04);
      const pg = g.createLinearGradient(0, yAt(0.55), 0, geo.judgeY);
      pg.addColorStop(0, 'rgba(120, 240, 255, 0)');
      pg.addColorStop(1, `rgba(200, 250, 255, ${0.5 * k})`);
      g.fillStyle = pg;
      g.fill();
      // Burst.
      const r = lw * (0.5 + age * 3);
      const burst = g.createRadialGradient(x, geo.judgeY, 0, x, geo.judgeY, r);
      const tint = e.grade === 'PERFECT' ? '160, 250, 255' : e.grade === 'GREAT' ? '255, 150, 220' : '150, 255, 170';
      burst.addColorStop(0, `rgba(255, 255, 255, ${0.9 * k})`);
      burst.addColorStop(0.35, `rgba(${tint}, ${0.6 * k})`);
      burst.addColorStop(1, `rgba(${tint}, 0)`);
      g.fillStyle = burst;
      g.beginPath();
      g.ellipse(x, geo.judgeY, r, r * 0.55, 0, 0, Math.PI * 2);
      g.fill();
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age > p.life) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt;
      g.fillStyle = `rgba(200, 250, 255, ${1 - p.age / p.life})`;
      g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    g.restore();
  }

  function drawHud(now) {
    const pad = 14;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = 'rgba(200, 230, 255, 0.7)';
    g.font = `700 ${Math.round(W * 0.028)}px "Segoe UI", Arial, sans-serif`;
    g.fillText('SCORE', pad, pad + W * 0.03);
    g.fillStyle = '#ffffff';
    g.shadowColor = '#5ff3ff';
    g.shadowBlur = 8;
    g.font = `italic 800 ${Math.round(W * 0.075)}px "Segoe UI", Arial, sans-serif`;
    g.fillText(String(game.score).padStart(7, '0'), pad, pad + W * 0.1);
    g.shadowBlur = 0;

    // Song progress.
    const barW = W * 0.42;
    const prog = Math.min(1, Math.max(0, now / song.length));
    g.fillStyle = 'rgba(255, 255, 255, 0.15)';
    g.fillRect(pad, pad + W * 0.12, barW, 4);
    g.fillStyle = '#7ff6ff';
    g.fillRect(pad, pad + W * 0.12, barW * prog, 4);

    const acc = game.judgedUnits ? (100 * game.weightSum) / game.judgedUnits : 100;
    g.fillStyle = 'rgba(200, 230, 255, 0.75)';
    g.font = `600 ${Math.round(W * 0.03)}px "Segoe UI", Arial, sans-serif`;
    g.fillText(acc.toFixed(2) + '%', pad, pad + W * 0.17);

    const d = DIFFS[game.diff];
    g.textAlign = 'right';
    g.fillText(`${d.name}  Lv.${d.lv}`, W - pad, 72);

    if (game.versus) {
      let y = 72 + W * 0.06;
      g.font = `700 ${Math.round(W * 0.032)}px "Segoe UI", Arial, sans-serif`;
      for (const o of matchPlayers().filter((p) => !p.me).slice(0, 3)) {
        g.fillStyle = o.score > game.score ? '#ff9ae6' : '#7ff6ff';
        g.fillText(`${o.nick}  ${String(o.score).padStart(7, '0')}`, W - pad, y);
        g.fillStyle = 'rgba(255, 255, 255, 0.15)';
        g.fillRect(W - pad - W * 0.3, y + 5, W * 0.3, 3);
        g.fillStyle = '#ff9ae6';
        g.fillRect(W - pad - W * 0.3, y + 5, W * 0.3 * o.progress, 3);
        y += W * 0.065;
      }
    }

    g.textAlign = 'center';
    if (game.combo >= 2) {
      g.fillStyle = 'rgba(255, 255, 255, 0.92)';
      g.shadowColor = '#b36bff';
      g.shadowBlur = 14;
      g.font = `italic 800 ${Math.round(W * 0.12)}px "Segoe UI", Arial, sans-serif`;
      g.fillText(String(game.combo), geo.cx, H * 0.36);
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(200, 230, 255, 0.7)';
      g.font = `700 ${Math.round(W * 0.03)}px "Segoe UI", Arial, sans-serif`;
      g.fillText('COMBO', geo.cx, H * 0.36 + W * 0.05);
    }

    const j = game.judgement;
    if (j) {
      const age = (performance.now() - j.at) / 1000;
      if (age < 0.6) {
        const scale = 1 + 0.35 * Math.max(0, 1 - age / 0.08);
        const alpha = age < 0.4 ? 1 : 1 - (age - 0.4) / 0.2;
        const y = geo.judgeY - H * 0.14;
        g.save();
        g.globalAlpha = alpha;
        g.translate(geo.cx, y);
        g.scale(scale, scale);
        g.font = `italic 900 ${Math.round(W * 0.085)}px "Segoe UI", Arial, sans-serif`;
        if (j.grade === 'PERFECT') {
          const tw = g.measureText('PERFECT').width;
          const pg = g.createLinearGradient(-tw / 2, 0, tw / 2, 0);
          pg.addColorStop(0, '#7ff6ff');
          pg.addColorStop(0.5, '#ffffff');
          pg.addColorStop(1, '#ff9ae6');
          g.fillStyle = pg;
          g.shadowColor = '#5ff3ff';
        } else {
          g.fillStyle = JUDGE_COLORS[j.grade];
          g.shadowColor = JUDGE_COLORS[j.grade];
        }
        g.shadowBlur = 16;
        g.fillText(j.grade, 0, 0);
        if (j.timing) {
          g.shadowBlur = 0;
          g.font = `700 ${Math.round(W * 0.032)}px "Segoe UI", Arial, sans-serif`;
          g.fillStyle = j.timing === 'FAST' ? '#7fb8ff' : '#ff8f8f';
          g.fillText(j.timing, 0, W * 0.05);
        }
        g.restore();
      }
    }

    if (now < 0) {
      g.fillStyle = '#ffffff';
      g.shadowColor = '#5ff3ff';
      g.shadowBlur = 20;
      g.font = `italic 900 ${Math.round(W * 0.1)}px "Segoe UI", Arial, sans-serif`;
      g.fillText(now < -0.6 ? 'READY?' : 'GO!', geo.cx, H * 0.5);
      g.shadowBlur = 0;
    }
  }

  let lastFrame = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - lastFrame) / 1000);
    lastFrame = t;
    if (mode === 'play' && game) updateGame();

    const now = game && actx ? songNow() : t / 1000;
    drawBackground(now);
    drawHighway(now);
    if (game) drawNotes(now);
    drawJudgeLine();
    drawEffects(game && game.paused ? 0 : dt);
    if (game) drawHud(now);
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  function laneFromX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const left = geo.cx - geo.botW / 2;
    const lane = Math.floor((x - left) / (geo.botW / 4));
    return Math.max(0, Math.min(3, lane));
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (mode !== 'play') return;
    const lane = laneFromX(e.clientX);
    pointerLanes.set(e.pointerId, lane);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // Some browsers refuse capture for synthetic pointers; input still works.
    }
    pressLane(lane);
  });

  const endPointer = (e) => {
    if (!pointerLanes.has(e.pointerId)) return;
    const lane = pointerLanes.get(e.pointerId);
    pointerLanes.delete(e.pointerId);
    releaseLane(lane);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (mode === 'play' && game && !game.paused) pauseGame();
      else if (game && game.paused) resumeGame();
      return;
    }
    if (e.code in KEYS && mode === 'play') {
      e.preventDefault();
      if (!e.repeat) pressLane(KEYS[e.code]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code in KEYS && mode === 'play') releaseLane(KEYS[e.code]);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
  });
  window.addEventListener('blur', () => pauseGame());

  // ---------- Menus ----------
  const $ = (id) => document.getElementById(id);
  const menuEl = $('menu');
  const pauseEl = $('pause');
  const resultsEl = $('results');
  const pauseBtn = $('pauseBtn');
  const versusEl = $('versus');

  function showOnly(el) {
    for (const o of [menuEl, versusEl, pauseEl, resultsEl]) o.classList.toggle('hidden', o !== el);
  }

  function refreshMenu() {
    for (const b of document.querySelectorAll('[data-diff]')) {
      const active = b.dataset.diff === settings.diff;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
      b.setAttribute('role', 'radio');
    }
    const best = store.get('best', {})[settings.diff];
    $('best').textContent = best
      ? `Best: ${String(best.score).padStart(7, '0')}  ${best.rank}${best.ap ? '  · ALL PERFECT' : best.fc ? '  · FULL COMBO' : ''}`
      : 'No score yet';
  }

  for (const b of document.querySelectorAll('[data-diff]')) {
    b.addEventListener('click', () => {
      settings.diff = b.dataset.diff;
      store.set('diff', settings.diff);
      refreshMenu();
    });
  }

  const speedEl = $('speed');
  const offsetEl = $('offset');
  const hitEl = $('hitsound');
  speedEl.value = settings.speed;
  offsetEl.value = settings.offset;
  hitEl.checked = settings.hitsound;
  const showSettings = () => {
    $('speedOut').textContent = Number(settings.speed).toFixed(1);
    $('offsetOut').textContent = `${settings.offset > 0 ? '+' : ''}${settings.offset} ms`;
  };
  speedEl.addEventListener('input', () => {
    settings.speed = Number(speedEl.value);
    store.set('speed', settings.speed);
    showSettings();
  });
  offsetEl.addEventListener('input', () => {
    settings.offset = Number(offsetEl.value);
    store.set('offset', settings.offset);
    showSettings();
  });
  hitEl.addEventListener('change', () => {
    settings.hitsound = hitEl.checked;
    store.set('hitsound', settings.hitsound);
  });

  const crosshairEl = $('crosshair');
  const crosshairSel = $('crosshairSel');
  const showCrosshair = () => {
    crosshairEl.dataset.style = settings.crosshair;
    crosshairEl.classList.toggle('hidden', settings.crosshair === 'off');
  };
  crosshairSel.value = settings.crosshair;
  showCrosshair();
  crosshairSel.addEventListener('change', () => {
    settings.crosshair = crosshairSel.value;
    store.set('crosshair', settings.crosshair);
    showCrosshair();
  });

  $('startBtn').addEventListener('click', () => startGame(settings.diff));
  $('resumeBtn').addEventListener('click', resumeGame);
  $('restartBtn').addEventListener('click', () => startGame(game.diff));
  $('quitBtn').addEventListener('click', quitToMenu);
  $('retryBtn').addEventListener('click', () => {
    if (game && game.versus) openVersus();
    else startGame(game.diff);
  });
  $('menuBtn').addEventListener('click', quitToMenu);
  pauseBtn.addEventListener('click', pauseGame);

  // ---------- Versus (online, via the viewer's room) ----------
  // Only presence is used: every player publishes their own state, and a
  // match starts when someone in the lobby sets a fresh `start` on theirs.
  const COUNTDOWN_MS = 4000;
  const vs = {
    room: null,
    unavailable: false,
    codeMode: false,
    code: null,
    inLobby: false,
    matchId: null,
    handled: new Set(),
    lastSent: 0,
    timer: null,
    seen: new Map(),
    nick: String(store.get('nick', '') || 'Player ' + Math.floor(100 + Math.random() * 900)).slice(0, 16),
  };
  const nickEl = $('nick');
  nickEl.value = vs.nick;

  function setPresence(patch) {
    if (!vs.room) return;
    vs.room.presence(patch).catch(() => {});
  }

  const cleanNick = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : 'Player');
  const cleanScore = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e6, Math.round(v))) : 0);

  function peerList() {
    if (!vs.room) return [];
    return vs.room.peers().filter((p) => p.kind === 'viewer' && p.presence && typeof p.presence.nick === 'string');
  }

  function matchPlayers() {
    return peerList()
      .filter((p) => vs.matchId && p.presence.match === vs.matchId)
      .map((p) => ({
        peer: p.peer,
        me: p.sameTab,
        nick: cleanNick(p.presence.nick),
        score: p.sameTab && game ? game.score : cleanScore(p.presence.score),
        progress: Math.max(0, Math.min(1, Number(p.presence.progress) || 0)),
        done: p.presence.mode === 'done',
        fc: !!p.presence.fc,
      }))
      .sort((a, b) => b.score - a.score);
  }

  const STATE_LABELS = { menu: 'In menu', lobby: 'Ready', countdown: 'Starting', playing: 'Playing', done: 'Finished' };

  function renderLobby() {
    const list = $('vsPlayers');
    list.textContent = '';
    const peers = peerList();
    for (const p of peers) {
      const li = document.createElement('li');
      if (p.sameTab) li.className = 'me';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = cleanNick(p.presence.nick) + (p.sameTab ? ' (you)' : '');
      const st = document.createElement('span');
      st.className = 'state';
      st.textContent = STATE_LABELS[p.presence.mode] || 'Here';
      li.append(who, st);
      list.append(li);
    }
    const others = peers.filter((p) => !p.sameTab && p.presence.mode === 'lobby');
    const startBtn = $('vsStartBtn');
    const needRoom = vs.codeMode && !vs.room;
    $('vsCode').classList.toggle('hidden', !needRoom);
    $('vsRoom').classList.toggle('hidden', !(vs.codeMode && vs.room));
    list.classList.toggle('hidden', needRoom);
    startBtn.classList.toggle('hidden', needRoom);
    if (vs.codeMode) {
      $('roomCode').textContent = vs.code || '';
      $('vsHelp').textContent = vs.room
        ? 'Send your friend this code or the invite link. When they join, either of you can start the match.'
        : 'Create a room and send your friend the code, or type the code they sent you. No account needed.';
    }
    if (needRoom) {
      $('vsStatus').textContent = 'Play online with a room code';
    } else if (vs.unavailable) {
      $('vsStatus').textContent = 'Online play is not available in this view.';
      $('vsHelp').textContent = 'Open this page on claude.ai while signed in. Your friend needs access too: share it with them from the Share menu.';
      startBtn.disabled = true;
    } else if (!vs.room || !vs.room.connected()) {
      $('vsStatus').textContent = 'Connecting\u2026';
      startBtn.disabled = true;
    } else if (vs.timer) {
      startBtn.disabled = true;
    } else {
      $('vsStatus').textContent = others.length ? `${others.length} friend${others.length > 1 ? 's' : ''} ready` : 'Waiting for a friend\u2026';
      startBtn.disabled = others.length === 0;
    }
  }

  function renderVersusResults() {
    if (!game || !game.versus) return;
    // Remember everyone seen in this match so a player who heads back to the
    // lobby for a rematch keeps their final score here.
    for (const p of matchPlayers()) vs.seen.set(p.peer, p);
    const current = new Set(matchPlayers().map((p) => p.peer));
    const players = [...vs.seen.values()]
      .filter((p) => current.has(p.peer) || p.done)
      .map((p) => (p.me ? { ...p, score: game.score, done: true } : p))
      .sort((a, b) => b.score - a.score);
    const list = $('resPlayers');
    list.textContent = '';
    players.forEach((p, i) => {
      const li = document.createElement('li');
      if (p.me) li.className = 'me';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${i + 1}. ${p.nick}${p.me ? ' (you)' : ''}`;
      const st = document.createElement('span');
      st.className = 'state';
      st.textContent = p.me || p.done ? String(p.score).padStart(7, '0') : `playing ${Math.round(p.progress * 100)}%`;
      li.append(who, st);
      list.append(li);
    });
    const others = players.filter((p) => !p.me);
    let verdict;
    if (!others.length) verdict = 'YOUR FRIEND LEFT';
    else if (others.some((p) => !p.done)) verdict = 'WAITING FOR RESULTS';
    else {
      const best = Math.max(...others.map((p) => p.score));
      verdict = game.score > best ? 'YOU WIN!' : game.score === best ? 'DRAW' : 'YOU LOSE';
    }
    $('vsVerdict').textContent = verdict;
  }

  function onPeers() {
    if (vs.inLobby && !vs.timer) {
      for (const p of peerList()) {
        const st = p.presence.start;
        if (p.sameTab || p.presence.mode !== 'countdown' || !st || typeof st.id !== 'string') continue;
        if (vs.handled.has(st.id) || !DIFFS[st.diff]) continue;
        // updatedAt is on our own clock, so no cross-device clock sync is needed.
        const left = Math.max(0, Math.min(COUNTDOWN_MS, COUNTDOWN_MS - (Date.now() - p.updatedAt)));
        scheduleMatch(st.id, st.diff, left, false);
        break;
      }
    }
    if (mode === 'menu' && !versusEl.classList.contains('hidden')) renderLobby();
    if (mode === 'results') renderVersusResults();
  }

  function scheduleMatch(id, diff, delay, isStarter) {
    vs.handled.add(id);
    vs.matchId = id;
    vs.seen.clear();
    settings.diff = diff;
    refreshMenu();
    const patch = { mode: 'countdown', match: id, diff, score: 0, combo: 0, progress: 0, fc: null };
    patch.start = isStarter ? { id, diff } : null;
    setPresence(patch);
    const startAt = performance.now() + delay;
    const tick = () => {
      const left = startAt - performance.now();
      if (left <= 0) {
        vs.timer = null;
        vs.inLobby = false;
        setPresence({ mode: 'playing', start: null });
        startGame(diff, true);
        return;
      }
      $('vsStatus').textContent = `${DIFFS[diff].name} match starts in ${Math.ceil(left / 1000)}\u2026`;
      vs.timer = setTimeout(tick, Math.min(250, left));
    };
    vs.timer = setTimeout(tick, 0);
    renderLobby();
  }

  function openVersus() {
    initAudio();
    actx.resume();
    if (game) resetBus();
    game = null;
    mode = 'menu';
    pauseBtn.classList.add('hidden');
    vs.inLobby = true;
    vs.matchId = null;
    setPresence({ nick: vs.nick, mode: 'lobby', match: null, start: null, score: 0, combo: 0, progress: 0, fc: null });
    refreshMenu();
    showOnly(versusEl);
    renderLobby();
  }

  function leaveVersus() {
    if (vs.timer) clearTimeout(vs.timer);
    vs.timer = null;
    vs.inLobby = false;
    vs.matchId = null;
    setPresence({ mode: 'menu', match: null, start: null });
  }

  $('versusBtn').addEventListener('click', openVersus);
  $('vsBackBtn').addEventListener('click', () => {
    leaveVersus();
    refreshMenu();
    showOnly(menuEl);
  });
  $('vsStartBtn').addEventListener('click', () => {
    if (vs.timer || !vs.room) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    scheduleMatch(id, settings.diff, COUNTDOWN_MS, true);
  });
  nickEl.addEventListener('input', () => {
    vs.nick = nickEl.value.trim().slice(0, 16) || 'Player';
    store.set('nick', vs.nick);
    setPresence({ nick: vs.nick });
  });

  // ---------- Room codes (outside claude.ai) ----------
  // Players who share a code meet on public MQTT relays. We connect to two
  // relays at once and merge what arrives, so one relay being down (or two
  // players reaching different ones) doesn't split the room. Each player
  // publishes their presence; others drop anyone silent for a few seconds.
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const BROKERS = window.__NP_BROKERS || ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
  const HEARTBEAT_MS = 2000;
  const PEER_TIMEOUT_MS = 7000;

  function createCodeRoom(code) {
    const me = Math.random().toString(36).slice(2, 12);
    const topicBase = `neonpulse/v1/${code}/p/`;
    const others = new Map();
    const peerHandlers = [];
    const connHandlers = [];
    let mine = {};
    let mineAt = Date.now();
    let snapshot = Object.freeze([]);
    let publishTimer = null;
    let wasConnected = false;
    let closed = false;

    const clients = BROKERS.map((url) =>
      window.mqtt.connect(url, {
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 3000,
        will: { topic: topicBase + me, payload: JSON.stringify({ id: me, bye: true }), qos: 0, retain: false },
      }),
    );

    const connected = () => clients.some((c) => c.connected);
    const rebuild = () => {
      const list = [{ peer: me, presence: mine, updatedAt: mineAt }, ...others.values()].map((p) =>
        Object.freeze({ peer: p.peer, by: null, isMe: p.peer === me, sameTab: p.peer === me, kind: 'viewer', guest: false, presence: Object.freeze({ ...p.presence }), updatedAt: p.updatedAt }),
      );
      snapshot = Object.freeze(list);
      const change = { peers: snapshot, joined: [], left: [], updated: [] };
      for (const h of peerHandlers) h(change);
    };
    const connChanged = () => {
      const now = connected();
      if (now === wasConnected) return;
      wasConnected = now;
      if (now) publish();
      for (const h of connHandlers) h(now);
    };
    const publish = () => {
      publishTimer = null;
      if (closed) return;
      const payload = JSON.stringify({ id: me, p: mine });
      for (const c of clients) if (c.connected) c.publish(topicBase + me, payload, { qos: 0 });
    };
    const schedulePublish = () => {
      if (!publishTimer) publishTimer = setTimeout(publish, 60);
    };

    for (const c of clients) {
      c.on('connect', () => {
        c.subscribe(topicBase + '+', { qos: 0 });
        connChanged();
      });
      c.on('close', connChanged);
      c.on('offline', connChanged);
      c.on('error', () => {});
      c.on('message', (topic, buf) => {
        if (buf.length > 4096) return;
        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch (e) {
          return;
        }
        if (!msg || typeof msg.id !== 'string' || msg.id === me || topic !== topicBase + msg.id) return;
        if (msg.bye) {
          if (others.delete(msg.id)) rebuild();
          return;
        }
        if (!msg.p || typeof msg.p !== 'object' || Array.isArray(msg.p)) return;
        const prev = others.get(msg.id);
        const text = JSON.stringify(msg.p);
        if (prev && prev.text === text) {
          prev.seen = Date.now();
          return;
        }
        const isNew = !prev;
        others.set(msg.id, { peer: msg.id, presence: msg.p, text, updatedAt: Date.now(), seen: Date.now() });
        if (isNew) publish(); // let a newcomer see us right away
        rebuild();
      });
    }

    const beat = setInterval(() => {
      publish();
      let dropped = false;
      for (const [id, p] of others) {
        if (Date.now() - p.seen > PEER_TIMEOUT_MS) {
          others.delete(id);
          dropped = true;
        }
      }
      if (dropped) rebuild();
    }, HEARTBEAT_MS);

    rebuild();
    return {
      presence(patch) {
        for (const k of Object.keys(patch)) {
          if (patch[k] === null) delete mine[k];
          else mine[k] = patch[k];
        }
        mine = { ...mine };
        mineAt = Date.now();
        rebuild();
        schedulePublish();
        return Promise.resolve();
      },
      peers: () => snapshot,
      onPeers(h) {
        peerHandlers.push(h);
        return () => peerHandlers.splice(peerHandlers.indexOf(h), 1);
      },
      connected,
      onConnection(h) {
        connHandlers.push(h);
        setTimeout(() => h(connected()), 0);
        return () => connHandlers.splice(connHandlers.indexOf(h), 1);
      },
      leave() {
        closed = true;
        clearInterval(beat);
        const bye = JSON.stringify({ id: me, bye: true });
        for (const c of clients) {
          if (c.connected) c.publish(topicBase + me, bye, { qos: 0 });
          c.end(false);
        }
      },
    };
  }

  function newCode() {
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
    return code;
  }

  const normalizeCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

  function enterCodeRoom(code) {
    initAudio();
    actx.resume();
    if (vs.room) vs.room.leave();
    vs.code = code;
    vs.room = createCodeRoom(code);
    vs.room.onPeers(onPeers);
    vs.room.onConnection(() => renderLobby());
    setPresence({ nick: vs.nick, mode: 'lobby', match: null, start: null, score: 0, combo: 0, progress: 0, fc: null });
    try {
      history.replaceState(null, '', '#' + code);
    } catch (e) {
      // Some embeds refuse history changes; the code is still on screen.
    }
    renderLobby();
  }

  function leaveCodeRoom() {
    leaveVersus();
    if (vs.room) vs.room.leave();
    vs.room = null;
    vs.code = null;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      // Ignore; nothing depends on the address bar.
    }
    renderLobby();
  }

  function setupCodeMode() {
    vs.codeMode = true;
    $('versusBtn').classList.remove('hidden');
    const codeInput = $('codeInput');
    codeInput.addEventListener('input', () => {
      codeInput.value = normalizeCode(codeInput.value);
    });
    const join = () => {
      const code = normalizeCode(codeInput.value);
      if (code.length !== 5) {
        $('vsStatus').textContent = 'Room codes have 5 letters or numbers.';
        codeInput.focus();
        return;
      }
      enterCodeRoom(code);
    };
    $('joinRoomBtn').addEventListener('click', join);
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    $('createRoomBtn').addEventListener('click', () => enterCodeRoom(newCode()));
    $('leaveRoomBtn').addEventListener('click', leaveCodeRoom);
    $('copyInviteBtn').addEventListener('click', () => {
      const link = location.origin + location.pathname + '#' + vs.code;
      const btn = $('copyInviteBtn');
      const done = (ok) => {
        btn.textContent = ok ? 'LINK COPIED' : link;
        setTimeout(() => (btn.textContent = 'COPY INVITE LINK'), 2500);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => done(true), () => done(false));
      else done(false);
    });

    // Opening an invite link (game.html#CODE) goes straight to the join screen.
    const fromLink = normalizeCode(location.hash.slice(1));
    if (fromLink.length === 5) {
      codeInput.value = fromLink;
      mode = 'menu';
      vs.inLobby = true;
      refreshMenu();
      showOnly(versusEl);
      renderLobby();
      $('vsStatus').textContent = `Tap JOIN to enter room ${fromLink}`;
    }
  }

  function versusUnavailable() {
    vs.room = null;
    vs.unavailable = true;
    renderLobby();
  }

  if (window.claude && typeof window.claude.use === 'function') {
    $('versusBtn').classList.remove('hidden');
    window.claude
      .use('room')
      .then((room) => {
        if (!room) return versusUnavailable();
        vs.room = room;
        room.onPeers(onPeers, versusUnavailable);
        room.onConnection(() => renderLobby(), versusUnavailable);
        setPresence({ nick: vs.nick, mode: vs.inLobby ? 'lobby' : 'menu' });
      })
      .catch(versusUnavailable);
  } else if (window.mqtt && typeof window.mqtt.connect === 'function') {
    setupCodeMode();
  }

  window.addEventListener('resize', resize);
  resize();
  showSettings();
  refreshMenu();
  requestAnimationFrame(frame);

  // Exposed for automated checks.
  window.__neonPulse = {
    buildChart,
    song,
    now: () => (game && actx ? songNow() : 0),
    get game() { return game; },
    get mode() { return mode; },
  };
})();
