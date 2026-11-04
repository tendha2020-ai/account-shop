/* Glow Studio - music engine (window.GlowMusic)
 * Eight original, fully synthesized tracks rendered offline with the Web Audio API.
 * No samples, no downloads: every drum, bass, pad and melody is generated on-device.
 * All compositions are original and royalty-free.
 *
 * How it works: each track is a list of bars (intro -> groove -> build -> drop -> ending).
 * Notes are synthesized in JS (PolyBLEP oscillators, state-variable filters, FM, noise drums),
 * cached per distinct note, and mixed into a few stereo stems per bar. An OfflineAudioContext
 * then plays those stems through the mix bus: kick sidechain, convolution reverb, tempo-synced
 * delay, DJ filter intro, compressor + soft clip, end fade; finally the buffer is peak-normalized.
 * Bars are scheduled just ahead of the render position (OfflineAudioContext.suspend) to keep
 * the audio graph and memory small, so a 60 s track renders in about a second.
 *
 * GlowMusic.tracks                         -> [{ id, name, genre, bpm, colors }]
 * GlowMusic.render(id, seconds, {sampleRate}) -> Promise<AudioBuffer>
 */
(function (global) {
  'use strict';

  var TRACKS = [
    { id: 'neon',   name: 'Neon Nights', genre: 'Synthwave',        bpm: 108, colors: ['#ff2bd6', '#5b5cff'] },
    { id: 'glow',   name: 'Glow Up',     genre: 'Dance-pop house',  bpm: 122, colors: ['#ff4fa0', '#ffb36b'] },
    { id: 'golden', name: 'Golden Hour', genre: 'Lo-fi chill hop',  bpm: 84,  colors: ['#ffb347', '#d9703f'] },
    { id: 'hype',   name: 'Hype Mode',   genre: 'Trap',             bpm: 140, colors: ['#ff3b5c', '#7a1cff'] },
    { id: 'dream',  name: 'Daydream',    genre: 'Dreamy pop',       bpm: 92,  colors: ['#9ec5ff', '#f3a6ff'] },
    { id: 'sun',    name: 'Sun Dance',   genre: 'Afro-pop groove',  bpm: 104, colors: ['#ffd23f', '#ff6b35'] },
    { id: 'epic',   name: 'Rise Up',     genre: 'Cinematic build',  bpm: 96,  colors: ['#4facfe', '#2b2f8f'] },
    { id: 'disco',  name: 'Disco Ball',  genre: 'Nu-disco funk',    bpm: 116, colors: ['#f9d423', '#e14fad'] }
  ];

  /* ---------- small utilities ---------- */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function fold(n, lo, hi) { while (n > hi) n -= 12; while (n < lo) n += 12; return n; }

  var CHORDS = {
    M: [0, 4, 7], m: [0, 3, 7], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10],
    M9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '9': [0, 4, 7, 10, 14], add9: [0, 4, 7, 14],
    madd9: [0, 3, 7, 14], sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], '6': [0, 4, 7, 9],
    m11: [0, 3, 7, 10, 14, 17], '69': [0, 4, 7, 9, 14]
  };
  function voicing(root, type, lo, hi) {
    var iv = CHORDS[type] || CHORDS.M, out = [];
    for (var i = 0; i < iv.length; i++) {
      var n = fold(root + iv[i], lo, hi);
      if (out.indexOf(n) < 0) out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  }
  function satCurve(k, n) {
    var c = new Float32Array(n), norm = Math.tanh(k);
    for (var i = 0; i < n; i++) { var x = i * 2 / (n - 1) - 1; c[i] = Math.tanh(k * x) / norm; }
    return c;
  }
  // Stereo convolution impulse: decaying noise that darkens over time, with a short pre-delay.
  function makeIR(ctx, seconds, r) {
    var sr = ctx.sampleRate, len = Math.floor(sr * seconds), pre = Math.floor(sr * 0.012);
    var buf = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch), y = 0;
      for (var i = pre; i < len; i++) {
        var x = (i - pre) / (len - pre);
        var a = 0.85 - 0.75 * x;                      // one-pole lowpass coefficient: brighter early
        y += a * ((r() * 2 - 1) - y);
        d[i] = y * Math.pow(1 - x, 2.2) * Math.exp(-3.2 * x);
      }
    }
    return buf;
  }

  /* ---------- DSP primitives (notes are synthesized in JS, then mixed per bar) ---------- */
  var TB = 4096, SINT = new Float32Array(TB + 1);
  for (var si = 0; si <= TB; si++) SINT[si] = Math.sin(2 * Math.PI * si / TB);
  function fsin(ph) { ph -= Math.floor(ph); var x = ph * TB, i = x | 0; return SINT[i] + (SINT[i + 1] - SINT[i]) * (x - i); }
  function blep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }
  // Band-limited (PolyBLEP) oscillator sample at phase ph in [0,1) with phase increment dt.
  function osc(type, ph, dt) {
    if (type === 'sawtooth') return 2 * ph - 1 - blep(ph, dt);
    if (type === 'square') { var q = ph + 0.5; if (q >= 1) q -= 1; return (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep(q, dt); }
    if (type === 'triangle') { var tp = ph + 0.25; if (tp >= 1) tp -= 1; return 1 - 4 * Math.abs(tp - 0.5); }
    return fsin(ph);
  }
  // Zero-delay-feedback state variable filter (stable under fast modulation).
  function SVF(sr) { this.sr = sr; this.s1 = 0; this.s2 = 0; this.k = 1.4; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.bp = 0; }
  SVF.prototype.set = function (fc, q) {
    var g = Math.tan(Math.PI * Math.min(Math.max(fc, 20), this.sr * 0.45) / this.sr);
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  };
  SVF.prototype.run = function (x) {
    var v3 = x - this.s2, v1 = this.a1 * this.s1 + this.a2 * v3, v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
    this.s1 = 2 * v1 - this.s1; this.s2 = 2 * v2 - this.s2; this.bp = v1;
    return v2;
  };
  function qdb(q) { return Math.max(0.5, Math.pow(10, (q || 0) / 20)); }
  // Static filter applied to a rendered note (replaces per-channel BiquadFilters).
  function filt(d, sr, f) {
    var s = new SVF(sr), type = f.type, i, x, lp;
    s.set(f.freq, type === 'bandpass' ? Math.max(0.3, f.q || 1) : qdb(f.q));
    for (i = 0; i < d.length; i++) {
      x = d[i]; lp = s.run(x);
      d[i] = type === 'lowpass' ? lp : type === 'highpass' ? x - s.k * s.bp - lp : s.k * s.bp;
    }
  }
  function saturate(d, k) { var n = Math.tanh(k); for (var i = 0; i < d.length; i++) d[i] = Math.tanh(k * d[i]) / n; }

  /* ---------- engine: buses, mixer, instruments ---------- */
  function Engine(ctx, tr, duration, seed) {
    var E = this, c = ctx, sr = c.sampleRate, i;
    E.ctx = c; E.tr = tr; E.dur = duration; E.r = rng(seed); E.sr = sr;
    E.beat = 60 / tr.bpm; E.s16 = E.beat / 4; E.barLen = E.beat * 4;
    E.swing = tr.swing || 0; E.lim = Infinity; E.kicks = []; E.hasPan = !!c.createStereoPanner;
    E.nyq = Math.min(20000, sr * 0.45); E.cache = {}; E.total = Math.max(1, Math.round(duration * sr));
    E.noise = new Float32Array(sr * 4);
    for (i = 0; i < E.noise.length; i++) E.noise[i] = E.r() * 2 - 1;

    // master: sum -> DJ filter -> compressor -> soft clip -> fade -> out
    E.master = E.g(tr.master || 0.62);
    E.dj = E.f('lowpass', E.nyq, 0.9);
    var comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3;
    comp.attack.value = 0.008; comp.release.value = 0.16;
    var pre = E.g(0.5), clip = c.createWaveShaper(); clip.curve = satCurve(1.4, 2048);
    E.fade = E.g(1);
    E.master.connect(E.dj); E.dj.connect(comp); comp.connect(pre); pre.connect(clip);
    clip.connect(E.fade); E.fade.connect(c.destination);

    E.dbus = E.g(1); E.dbus.connect(E.master);   // drums
    E.duck = E.g(1); E.duck.connect(E.master);   // bass + pads (sidechained to the kick)
    E.mus = E.g(1); E.mus.connect(E.master);     // leads, keys, plucks

    // reverb send
    E.revIn = E.g(1);
    var conv = c.createConvolver(); conv.buffer = makeIR(c, tr.rev || 2.0, E.r);
    var rr = E.g(tr.revGain || 0.55);
    E.revIn.connect(conv); conv.connect(rr); rr.connect(E.master);

    // stereo tempo-synced delay send (main tap left, short tap right)
    E.dlyIn = E.g(1);
    var hp = E.f('highpass', 380, 0.7); E.dlyIn.connect(hp);
    var d1 = c.createDelay(2), d2 = c.createDelay(2), fb = E.g(tr.fb || 0.36), lp = E.f('lowpass', 2800, 0.7);
    d1.delayTime.value = E.beat * (tr.dly || 0.75); d2.delayTime.value = E.beat * 0.5;
    hp.connect(d1); d1.connect(lp); lp.connect(fb); fb.connect(d1);
    var p1 = E.pan(-0.55), p2 = E.pan(0.55), g2 = E.g(0.45);
    lp.connect(p1); p1.connect(E.master);
    hp.connect(d2); d2.connect(g2); g2.connect(p2); p2.connect(E.master);

    // stereo stems, mixed in JS and played as one buffer per bar
    E.stems = [E.dbus, E.duck, E.mus, E.revIn, E.dlyIn].map(function (n) { return { node: n, q: [] }; });
    E.kit(tr.kit || {});
  }
  var P = Engine.prototype;

  P.g = function (v) { var n = this.ctx.createGain(); n.gain.value = v; return n; };
  P.f = function (type, freq, q) {
    var n = this.ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq;
    if (q != null) n.Q.value = q;
    return n;
  };
  P.pan = function (p) {
    if (!this.hasPan || !p) return this.g(1);
    var n = this.ctx.createStereoPanner(); n.pan.value = p; return n;
  };
  P.stemOf = function (node) {
    for (var i = 0; i < this.stems.length; i++) if (this.stems[i].node === node) return this.stems[i];
    return this.stems[2];
  };
  // Channel strip (gain, balance pan, reverb/delay sends, optional static filter) -> a stem.
  P.chan = function (o) {
    var g = o.gain == null ? 1 : o.gain, p = Math.max(-1, Math.min(1, o.pan || 0));
    return { gl: g * Math.min(1, 1 - p), gr: g * Math.min(1, 1 + p), rev: o.rev || 0, dly: o.dly || 0,
             stem: this.stemOf(o.dest || this.mus), filt: o.filt || null, id: 'c' + (this.nid = (this.nid || 0) + 1) };
  };
  P.fchan = function (type, freq, q, o) { return this.chan(mix(o, { filt: { type: type, freq: freq, q: q } })); };
  // Queue a rendered mono note on a strip (dry stem + reverb/delay send stems).
  P.out = function (st, t, d, v) {
    if (!d || !v || t < 0) return;
    st.stem.q.push(t, d, v * st.gl, v * st.gr);
    if (st.rev) this.stems[3].q.push(t, d, v * st.gl * st.rev, v * st.gr * st.rev);
    if (st.dly) this.stems[4].q.push(t, d, v * st.gl * st.dly, v * st.gr * st.dly);
  };
  // Mix everything queued so far into one stereo buffer per stem and schedule it.
  P.flush = function () {
    var sr = this.sr, c = this.ctx, total = this.total;
    for (var k = 0; k < this.stems.length; k++) {
      var S = this.stems[k], q = S.q, j, i;
      if (!q.length) continue;
      var s0 = Infinity, s1 = 0;
      for (j = 0; j < q.length; j += 4) {
        var a = Math.round(q[j] * sr);
        if (a < s0) s0 = a;
        if (a + q[j + 1].length > s1) s1 = a + q[j + 1].length;
      }
      s1 = Math.min(s1, total);
      S.q = [];
      if (s1 <= s0) continue;
      var buf = c.createBuffer(2, s1 - s0, sr), L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (j = 0; j < q.length; j += 4) {
        var d = q[j + 1], gl = q[j + 2], gr = q[j + 3], o = Math.round(q[j] * sr) - s0, n = Math.min(d.length, s1 - s0 - o);
        for (i = 0; i < n; i++) { var x = d[i]; L[o + i] += x * gl; R[o + i] += x * gr; }
      }
      var src = c.createBufferSource(); src.buffer = buf; src.connect(S.node); src.start(s0 / sr);
    }
  };
  P.memo = function (key, fn) {
    var c = this.cache[key];
    if (!c) c = this.cache[key] = fn.call(this);
    return c;
  };
  // Clamp a note to the current scheduling limit; -1 means "do not play".
  P.cl = function (t, d) {
    if (t < 0 || t >= this.lim - 1e-4 || t >= this.dur) return -1;
    return Math.min(d, this.lim - t);
  };
  P.hum = function (v) { return v * (0.94 + this.r() * 0.12); };
  P.lfo = function (rate, depth) { return { rate: rate, depth: depth }; };

  // Amplitude envelope state (attack, decay to sustain, release after the held time).
  function Env(sr, a, dec, sus, dur, rel) {
    this.A = Math.max(1, a * sr); this.TE = Math.max(dur, a + 0.005) * sr;
    this.sus = sus; this.cD = dec > 0 && sus < 1 ? 1 - Math.exp(-3 / (dec * sr)) : 0;
    this.cR = 1 - Math.exp(-5 / (Math.max(0.005, rel) * sr)); this.l = 0;
    this.n = Math.ceil(this.TE + 1.5 * Math.max(0.005, rel) * sr) + 1;
  }
  Env.prototype.at = function (i) {
    if (i < this.A) this.l = i / this.A;
    else if (i < this.TE) this.l += (this.sus - this.l) * this.cD;
    else this.l -= this.l * this.cR;
    return this.l;
  };

  // Subtractive voice render: oscillators -> resonant lowpass with envelope -> amp envelope.
  P.rsyn = function (notes, dur, vb, p, from) {
    var sr = this.sr, types = p.osc || ['sawtooth'], nT = types.length, nn = notes.length, i, k, j;
    var env = new Env(sr, p.a || 0.004, p.d || 0.2, p.s == null ? 0.7 : p.s, dur, p.rel || 0.08), n = env.n;
    var out = new Float32Array(n), fl = new SVF(sr), q = qdb(p.q == null ? 0.7 : p.q);
    var f = mtof(notes[0]), cut = p.cut * (p.kt ? Math.pow(f / 261.6, p.kt) : 1);
    var fe = p.fenv ? Math.min(this.nyq, cut + p.fenv * vb) - cut : 0, tauF = Math.max(0.005, (p.fd || 0.15) / 3) * sr;
    var vib = p.lfo, vr = vib ? vib.rate / sr : 0, vd = vib ? vib.depth / 1200 * 0.6931 : 0;
    var GL = (p.glide || 0.06) * sr, ratio = from != null ? Math.pow(2, (notes[0] - from) / 12) : 1;
    var ph = [], inc = [];
    for (j = 0; j < nn; j++) for (k = 0; k < nT; k++) {
      var det = p.det && nT > 1 ? (k === 0 ? -p.det : k === 1 ? p.det : 0) : 0, off = p.oct ? (p.oct[k] || 0) : 0;
      inc.push(mtof(notes[j] + off) * Math.pow(2, det / 1200) / sr); ph.push((j * 0.31 + k * 0.17) % 1);
    }
    var amp = (p.v || 0.3) / Math.sqrt(nn), m = 1, nv = inc.length;
    for (i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        fl.set(cut + fe * Math.exp(-i / tauF), q);
        m = from != null && i < GL ? Math.pow(ratio, i / GL - 1) : 1;
        if (vd) m *= 1 + vd * fsin(i * vr);
      }
      var s = 0;
      for (k = 0; k < nv; k++) {
        var dt = inc[k] * m;
        s += osc(types[k % nT], ph[k], dt);
        ph[k] += dt; if (ph[k] >= 1) ph[k] -= 1;
      }
      out[i] = fl.run(s) * env.at(i) * amp;
    }
    if (p.sat) { for (i = 0; i < n; i++) out[i] *= vb; saturate(out, p.sat); }
    if (p.dst && p.dst.filt) filt(out, sr, p.dst.filt);
    return out;
  };
  // Two-operator FM render (electric piano, bells, marimba).
  P.rfm = function (note, dur, vb, p) {
    var sr = this.sr, f = mtof(note), env = new Env(sr, p.a || 0.002, p.d || 0.8, p.s == null ? 0.2 : p.s, dur, p.rel || 0.3);
    var n = env.n, out = new Float32Array(n), idx = p.idx || 1.2, ratio = p.ratio || 1, i;
    var dev0 = f * idx * (0.6 + 0.4 * vb), devS = f * idx * (p.idxS || 0.15), tauI = Math.max(0.005, (p.idxD || 0.3) / 3) * sr;
    var vib = p.lfo, vr = vib ? vib.rate / sr : 0, vd = vib ? vib.depth / 1200 * 0.6931 : 0, vph = (note * 0.137) % 1;
    var pc = 0, pm = 0, fm = f * ratio / sr, amp = p.v || 0.3, dev = dev0, m = 1;
    for (i = 0; i < n; i++) {
      if ((i & 15) === 0) { dev = devS + (dev0 - devS) * Math.exp(-i / tauI); if (vd) m = 1 + vd * fsin(vph + i * vr); }
      var mod = fsin(pm) * dev;
      pm += fm; if (pm >= 1) pm -= 1;
      pc += (f * m + mod) / sr; pc -= Math.floor(pc);
      out[i] = fsin(pc) * env.at(i) * amp;
    }
    if (p.dst && p.dst.filt) filt(out, sr, p.dst.filt);
    return out;
  };
  // Wide pad render: detuned saws split left/right with a slow filter swell. Returns [L, R].
  P.rpad = function (notes, dur, p) {
    var sr = this.sr, a = Math.min(p.a || 0.4, dur * 0.6), env, res = [], nn = notes.length, sd, i, k;
    var amp = 1.4 * (p.v || 0.1) / Math.sqrt(nn), q = qdb(p.q == null ? 0.6 : p.q), type = p.osc || 'sawtooth';
    for (sd = 0; sd < 2; sd++) {
      env = new Env(sr, a, 0, 1, dur, p.rel || 0.8);
      var n = env.n, out = new Float32Array(n), fl = new SVF(sr), ph = [], inc = [], SW = a * 1.5 * sr;
      for (k = 0; k < nn; k++) {
        inc.push(mtof(notes[k]) * Math.pow(2, ((sd ? 1 : -1) * (p.det || 9) + (k % 2 ? 2 : -2)) / 1200) / sr);
        ph.push((k * 0.618 + sd * 0.29) % 1);
      }
      for (i = 0; i < n; i++) {
        if ((i & 15) === 0) fl.set(i < SW ? p.cut * (0.45 + 0.55 * i / SW) : p.cut, q);
        var s = 0;
        for (k = 0; k < nn; k++) { s += osc(type, ph[k], inc[k]); ph[k] += inc[k]; if (ph[k] >= 1) ph[k] -= 1; }
        out[i] = fl.run(s) * env.at(i) * amp;
      }
      res.push(out);
    }
    return res;
  };

  /* ---------- drums ---------- */
  P.kit = function (k) {
    var E = this;
    E.K = {
      f0: k.f0 || 150, f1: k.f1 || 46, pt: k.pt || 0.075, kdec: k.kdec || 0.38, click: k.click == null ? 0.5 : k.click,
      snHz: k.snHz || 190, snDec: k.snDec || 0.17, snBody: k.snBody == null ? 0.45 : k.snBody,
      hatDec: k.hatDec || 0.045
    };
    E.kC = E.chan({ gain: k.kick || 1, dest: E.dbus });
    E.clickF = E.fchan('highpass', 2600, 0.7, { gain: 0.5, dest: E.dbus });
    E.snF = E.fchan('bandpass', k.snF || 2400, 0.7, { gain: (k.snare || 0.55) * 2.6, dest: E.dbus, rev: k.snRev || 0.25 });
    E.snB = E.chan({ gain: (k.snare || 0.55) * 2.2, dest: E.dbus, rev: (k.snRev || 0.25) * 0.5 });
    E.clF = E.fchan('bandpass', k.clF || 1250, 1.1, { gain: (k.clap || 0.6) * 4, dest: E.dbus, rev: k.clRev || 0.3, pan: 0.04 });
    E.hhF = E.fchan('highpass', k.hhF || 7600, 0.8, { gain: (k.hat || 0.22) * 2.2, dest: E.dbus, pan: 0.18 });
    E.ohF = E.fchan('highpass', k.ohF || 6800, 0.7, { gain: (k.ohat || 0.18) * 1.6, dest: E.dbus, pan: -0.12, rev: 0.08 });
    E.shF = E.fchan('bandpass', k.shF || 6200, 1.3, { gain: (k.shaker || 0.2) * 2.6, dest: E.dbus, pan: -0.28 });
    E.crF = E.fchan('highpass', 3600, 0.6, { gain: (k.crash || 0.22) * 1.3, dest: E.dbus, rev: 0.35 });
    E.rimF = E.fchan('bandpass', k.rimF || 2300, 3, { gain: (k.rim || 0.45) * 2.5, dest: E.dbus, pan: 0.22, rev: 0.15 });
    E.tomC = E.chan({ gain: k.tom || 0.6, dest: E.dbus, rev: k.tomRev || 0.22 });
    E.riserC = E.chan({ gain: 0.5, dest: E.dbus, rev: 0.4 });
  };
  // Noise hit through the strip's filter (4 cached variations per sound).
  P.nz = function (t, dur, v, st, atk) {
    atk = atk || 0.001;
    var vr = Math.floor(this.r() * 4);
    this.out(st, t, this.memo('n' + st.id + '|' + dur + '|' + atk + '|' + vr, function () {
      var sr = this.sr, A = Math.max(1, atk * sr), n = Math.ceil((atk + dur + 0.01) * sr), d = new Float32Array(n);
      var tau = dur / 5 * sr, nz = this.noise, o = Math.floor(vr * 0.73 * sr), L = nz.length;
      for (var i = 0; i < n; i++) d[i] = nz[(o + i) % L] * (i < A ? i / A : Math.exp(-(i - A) / tau));
      if (st.filt) filt(d, sr, st.filt);
      return d;
    }), v);
  };
  P.tone = function (t, type, f0, f1, pt, dur, v, st) {
    this.out(st, t, this.memo(['t', st.id, type, f0, f1, pt, dur].join('|'), function () {
      var sr = this.sr, n = Math.ceil((dur + 0.03) * sr), d = new Float32Array(n), PT = pt * sr, ph = 0;
      var A = 0.002 * sr, H = 0.012 * sr, tau = dur / 5 * sr, r = f1 && f1 !== f0 ? f1 / f0 : 1;
      for (var i = 0; i < n; i++) {
        var f = i < PT ? f0 * Math.pow(r, i / PT) : f0 * r, dt = f / sr;
        d[i] = osc(type, ph, dt) * (i < A ? i / A : i < H ? 1 : Math.exp(-(i - H) / tau));
        ph += dt; if (ph >= 1) ph -= 1;
      }
      if (st.filt) filt(d, sr, st.filt);
      return d;
    }), v);
  };
  P.kick = function (t, v, soft) {
    if (this.cl(t, 1) < 0) return;
    var K = this.K; v = v == null ? 1 : v;
    this.tone(t, 'sine', K.f0, K.f1, K.pt, K.kdec, v, this.kC);
    if (K.click) this.nz(t, 0.012, v * K.click, this.clickF);
    if (!soft) this.kicks.push(t);
  };
  P.snare = function (t, v) {
    if (this.cl(t, 1) < 0) return;
    var K = this.K;
    this.nz(t, K.snDec, v * 0.9, this.snF);
    if (K.snBody) this.tone(t, 'triangle', K.snHz * 1.6, K.snHz, 0.025, 0.09, v * K.snBody, this.snB);
  };
  P.clap = function (t, v) {
    if (this.cl(t, 1) < 0) return;
    var st = this.clF;
    this.out(st, t, this.memo('clap' + st.id, function () {
      var sr = this.sr, n = Math.ceil(0.3 * sr), d = new Float32Array(n), nz = this.noise, i, b;
      for (i = 0; i < n; i++) {
        var ts = i / sr, e = 0;
        for (b = 0; b < 3; b++) {
          var tb = ts - b * 0.0105;
          if (tb >= 0) e = Math.max(e, tb < 0.0012 ? tb / 0.0012 : Math.exp(-(tb - 0.0012) / 0.003));
        }
        var tt = ts - 0.032;
        if (tt >= 0) e = Math.max(e, 0.9 * (tt < 0.002 ? tt / 0.002 : Math.exp(-(tt - 0.002) / 0.045)));
        d[i] = nz[i + 9000] * e;
      }
      filt(d, sr, st.filt);
      return d;
    }), v);
  };
  P.hat = function (t, v, open) {
    if (this.cl(t, 1) < 0) return;
    if (open) this.nz(t, 0.32, v * 0.9, this.ohF, 0.002);
    else this.nz(t, this.K.hatDec, v, this.hhF);
  };
  P.shaker = function (t, v) { if (this.cl(t, 1) >= 0) this.nz(t, 0.05, v, this.shF, 0.012); };
  P.crash = function (t, v) { if (this.cl(t, 1) >= 0) this.nz(t, 1.7, v, this.crF, 0.002); };
  P.rim = function (t, v) {
    if (this.cl(t, 1) < 0) return;
    this.tone(t, 'triangle', 1750, 1650, 0.01, 0.035, v * 0.5, this.rimF);
    this.nz(t, 0.025, v * 0.7, this.rimF);
  };
  P.tom = function (t, note, v, dec) {
    if (this.cl(t, 1) < 0) return;
    var f = mtof(note);
    this.tone(t, 'sine', f * 1.5, f, 0.05, dec || 0.45, v, this.tomC);
    this.nz(t, 0.04, v * 0.25, this.rimF);
  };
  // Big cinematic low hit.
  P.boom = function (t, v) {
    if (this.cl(t, 1) < 0) return;
    this.tone(t, 'sine', 120, 36, 0.3, 1.6, v, this.kC);
    this.tone(t, 'triangle', 70, 40, 0.2, 0.6, v * 0.35, this.tomC);
    this.nz(t, 0.25, v * 0.5, this.snF);
    this.kicks.push(t);
  };
  // Noise riser: band-pass sweep that swells into the drop.
  P.riser = function (t0, t1, v) {
    if (t1 - t0 < 0.2 || this.cl(t0, 1) < 0) return;
    var sr = this.sr, N = (t1 - t0) * sr, n = Math.ceil(N + 0.03 * sr), d = new Float32Array(n), fl = new SVF(sr);
    var nz = this.noise, L = nz.length, o = Math.floor(this.r() * sr), H = N * 0.5, E1 = N - 0.01 * sr;
    for (var i = 0; i < n; i++) {
      if ((i & 15) === 0) fl.set(350 * Math.pow(9000 / 350, Math.min(1, i / N)), 2.2);
      fl.run(nz[(o + i) % L]);
      var g = i < H ? 0.25 * i / H : i < E1 ? 0.25 + 0.75 * (i - H) / (E1 - H) : Math.max(0, 1 - (i - E1) / (0.03 * sr));
      d[i] = fl.k * fl.bp * g;
    }
    this.out(this.riserC, t0, d, v);
  };
  // Accelerating snare roll over [t0, t1].
  P.roll = function (t0, t1, v, clapToo) {
    var s16 = this.s16, n = Math.round((t1 - t0) / s16), half = Math.floor(n / 2);
    for (var i = 0; i < n; i++) {
      var t = t0 + i * s16, vv = v * (0.35 + 0.65 * i / n);
      if (i < half) { if (i % 2 === 0) this.snare(t, vv); }
      else if (i < n - 4 || n < 8) this.snare(t, vv);
      else { this.snare(t, vv); this.snare(t + s16 / 2, vv * 0.9); }
      if (clapToo && i >= n - 4) this.clap(t, vv * 0.6);
    }
  };
  // Drum fill in the last 8 sixteenths before the scheduling limit (or end of bar).
  P.fill = function (T, kind) {
    var s16 = this.s16, avail = Math.min(16, Math.round((Math.min(this.lim, T + this.barLen) - T) / s16));
    var st = Math.max(0, avail - 8), toms = [52, 52, 48, 48, 45, 45, 41, 41];
    for (var i = st; i < avail; i++) {
      var t = T + i * s16, k = i - st, v = 0.45 + k * 0.07;
      if (kind === 'tom') { if (k % 2 === 0 || k > 5) this.tom(t, toms[k], v * 0.9, 0.35); }
      else if (kind === 'trap') { this.snare(t, v * 0.7); if (k > 3) this.hat(t + s16 / 2, 0.5); }
      else if (k % 2 === 0 || k > 3) this.snare(t, v * 0.8);
    }
  };
  // Run fn(t, vel, char, step) for each hit of a 16-step pattern string.
  P.pat = function (T, p, fn, jit) {
    for (var i = 0; i < p.length; i++) {
      var ch = p.charAt(i);
      if (ch === '.' || ch === '-' || ch === ' ') continue;
      var t = T + i * this.s16 + ((i & 1) ? this.swing * this.s16 : 0);
      if (jit && t > 0.01) t += (this.r() - 0.5) * 0.005;
      var v = ch === 'o' ? 0.55 : ch === 'X' ? 1.18 : ch === 'q' ? 0.32 : 1;
      fn.call(this, t, this.hum(v), ch, i);
    }
  };
  // Drum pattern: { k, s, c, h, oh, sh, rim } strings, vm = overall velocity.
  P.dp = function (T, d, vm) {
    vm = vm || 1;
    if (d.k) this.pat(T, d.k, function (t, v) { this.kick(t, v * vm); });
    if (d.s) this.pat(T, d.s, function (t, v) { this.snare(t, v * vm); });
    if (d.c) this.pat(T, d.c, function (t, v) { this.clap(t, v * vm); });
    if (d.h) this.pat(T, d.h, function (t, v, ch) {
      if (ch === 'r') { this.hat(t, v * 0.8 * vm); this.hat(t + this.s16 / 2, v * 0.6 * vm); }
      else if (ch === 't') { for (var j = 0; j < 3; j++) this.hat(t + j * this.s16 / 3, v * (0.5 + j * 0.15) * vm); }
      else this.hat(t, v * vm, ch === 'O');
    }, true);
    if (d.oh) this.pat(T, d.oh, function (t, v) { this.hat(t, v * vm, true); }, true);
    if (d.sh) this.pat(T, d.sh, function (t, v) { this.shaker(t, v * vm); }, true);
    if (d.rim) this.pat(T, d.rim, function (t, v) { this.rim(t, v * vm); }, true);
  };

  /* ---------- melodic instruments (rendered once per distinct note, then reused) ---------- */
  function vbk(v) { return Math.max(0.2, Math.round(v * 5) / 5); }
  function ms(d) { return Math.round(d * 1000); }
  // p: { dst, osc:[types], det, oct:[semis], cut, fenv, fd, q, kt, v, a, d, s, rel, glide, lfo, sat }
  P.syn = function (t, note, dur, v, p, from) {
    dur = this.cl(t, dur); if (dur < 0) return;
    var vb = vbk(v), key = 's' + (p.pid || (p.pid = 'p' + (this.nid = (this.nid || 0) + 1))) + '|' + note + '|' + ms(dur) + '|' + vb + '|' + (from == null ? '' : from);
    this.out(p.dst, t, this.memo(key, function () { return this.rsyn([note], dur, vb, p, from); }), p.sat ? v / vb : v);
  };
  // Chord through one shared filter + envelope (stabs, guitar chops).
  P.csyn = function (t, notes, dur, v, p) {
    dur = this.cl(t, dur); if (dur < 0) return;
    var vb = vbk(v), key = 'c' + (p.pid || (p.pid = 'p' + (this.nid = (this.nid || 0) + 1))) + '|' + notes.join(',') + '|' + ms(dur) + '|' + vb;
    this.out(p.dst, t, this.memo(key, function () { return this.rsyn(notes, dur, vb, mix(p, { v: (p.v || 0.1) })); }), v);
  };
  // Wide pad. p: { L, R, osc, det, cut, a, rel, v }
  P.pad = function (t, notes, dur, v, p) {
    dur = this.cl(t, dur); if (dur < 0) return;
    var key = 'd' + (p.pid || (p.pid = 'p' + (this.nid = (this.nid || 0) + 1))) + '|' + notes.join(',') + '|' + ms(dur);
    var lr = this.memo(key, function () { return this.rpad(notes, dur, p); });
    this.out(p.L, t, lr[0], v); this.out(p.R, t, lr[1], v);
  };
  // FM voice. p: { dst, ratio, idx, idxS, idxD, v, a, d, s, rel, lfo }
  P.fm = function (t, note, dur, v, p) {
    dur = this.cl(t, dur); if (dur < 0) return;
    var vb = vbk(v), key = 'f' + (p.pid || (p.pid = 'p' + (this.nid = (this.nid || 0) + 1))) + '|' + note + '|' + ms(dur) + '|' + vb;
    this.out(p.dst, t, this.memo(key, function () { return this.rfm(note, dur, vb, p); }), v);
  };
  // Strum a chord with any voice function.
  P.strum = function (fn, t, notes, dur, v, p, gap) {
    for (var i = 0; i < notes.length; i++) fn.call(this, t + i * (gap || 0), notes[i], dur, v * (i === notes.length - 1 ? 1 : 0.85), p);
  };
  // Melody phrase: [[step, note, lenSteps, vel?], ...] starting at T.
  P.mel = function (T, ph, v, fn, p, glide) {
    var prev = null;
    for (var i = 0; i < ph.length; i++) {
      var n = ph[i], t = T + n[0] * this.s16 + ((n[0] & 1) ? this.swing * this.s16 : 0);
      var from = glide && prev != null && Math.abs(prev - n[1]) <= 5 && this.r() < 0.5 ? prev : null;
      if (fn === this.syn) this.syn(t, n[1], n[2] * this.s16 * 0.92, this.hum(v * (n[3] || 1)), p, from);
      else fn.call(this, t, n[1], n[2] * this.s16 * 0.92, this.hum(v * (n[3] || 1)), p);
      prev = n[1];
    }
  };
  // Arpeggio over chord tones: order = indices into the voicing (+ octave if >= len), -1 = rest.
  P.arp = function (T, notes, order, steps, stepLen, v, fn, p, transpose) {
    var n = notes.length;
    for (var i = 0; i < steps; i++) {
      var idx = order[i % order.length]; if (idx < 0) continue;
      var note = notes[idx % n] + 12 * Math.floor(idx / n) + (transpose || 0);
      var t = T + i * this.s16 * stepLen;
      fn.call(this, t, note, this.s16 * stepLen * 0.9, this.hum(v * (i % 4 === 0 ? 1 : 0.8)), p);
    }
  };
  // Play the part of a 2-bar phrase that falls in bar b (phrases chosen by bar pair).
  P.phr = function (T, b, list, v, fn, p, glide) {
    var ph = list[Math.floor(b / 2) % list.length], h = (b % 2) * 16, part = [];
    for (var i = 0; i < ph.length; i++) {
      var n = ph[i];
      if (n[0] >= h && n[0] < h + 16) part.push([n[0] - h, n[1], n[2], n[3]]);
    }
    this.mel(T, part, v, fn, p, glide);
  };
  P.padLR = function (gain, rev, dest) {
    return { L: this.chan({ gain: gain, pan: -0.75, rev: rev, dest: dest || this.duck }),
             R: this.chan({ gain: gain, pan: 0.75, rev: rev, dest: dest || this.duck }) };
  };
  // Vinyl crackle + hiss bed (lo-fi).
  P.vinyl = function (v) {
    var c = this.ctx, sr = c.sampleRate, len = Math.floor(sr * 3), b = c.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch), y = 0;
      for (var i = 0; i < len; i++) {
        y += 0.08 * ((this.r() * 2 - 1) - y);
        var s = y * 0.05;
        if (this.r() < 0.00045) s += (this.r() * 2 - 1) * 0.9;
        d[i] = s;
      }
    }
    var src = c.createBufferSource(); src.buffer = b; src.loop = true;
    var fl = this.f('bandpass', 2200, 0.5), g = this.g(v);
    src.connect(fl); fl.connect(g); g.connect(this.master);
    src.start(0); src.stop(this.dur);
  };

  function mix(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  /* ---------- the tracks (original compositions) ---------- */
  var DEFS = {};

  // NEON NIGHTS - synthwave, A minor, 108 bpm
  DEFS.neon = {
    master: 0.85, rev: 2.2, revGain: 0.6, dly: 0.75, fb: 0.42, duck: 0.5, fillKind: 'snare',
    kit: { f0: 140, f1: 44, kdec: 0.42, click: 0.35, snHz: 180, snDec: 0.28, snF: 1900, snRev: 0.55, snare: 0.6, hat: 0.17 },
    prog: [[45, 'madd9'], [41, 'M7'], [48, 'add9'], [43, 'M'], [45, 'madd9'], [41, 'M7'], [48, 'add9'], [40, 'M']],
    bassR: [28, 40], padR: [57, 74], endChord: [45, 'madd9'],
    setup: function (E) {
      var lr = E.padLR(1, 0.45);
      E.padP = { L: lr.L, R: lr.R, osc: 'sawtooth', det: 11, cut: 2300, a: 0.35, rel: 0.9, v: 0.14 };
      E.bassP = { dst: E.chan({ gain: 0.55, dest: E.duck }), osc: ['sawtooth', 'square'], det: 5, cut: 260, fenv: 1500, fd: 0.13, q: 2.5, v: 0.5, a: 0.003, d: 0.15, s: 0.55, rel: 0.05 };
      E.arpP = { dst: E.chan({ gain: 0.85, pan: 0.25, rev: 0.25, dly: 0.5 }), osc: ['square'], cut: 800, fenv: 3600, fd: 0.1, q: 3, v: 0.24, a: 0.002, d: 0.12, s: 0.12, rel: 0.06, kt: 0.3 };
      E.leadP = { dst: E.chan({ gain: 1, rev: 0.35, dly: 0.32 }), osc: ['sawtooth', 'square'], det: 10, cut: 2300, fenv: 2200, fd: 0.25, q: 1, v: 0.13, a: 0.012, d: 0.3, s: 0.75, rel: 0.18, lfo: E.lfo(5.2, 9), glide: 0.05 };
    },
    lead: [
      [[0, 76, 3], [3, 74, 1], [4, 72, 2], [6, 74, 2], [8, 76, 6], [14, 79, 2], [16, 81, 4], [20, 79, 2], [22, 76, 2], [24, 72, 4], [28, 74, 4]],
      [[0, 76, 3], [3, 74, 1], [4, 72, 2], [6, 74, 2], [8, 76, 4], [12, 79, 2], [14, 81, 2], [16, 83, 4], [20, 81, 2], [22, 79, 2], [24, 74, 8]],
      [[0, 76, 3], [3, 74, 1], [4, 72, 2], [6, 74, 2], [8, 76, 6], [14, 79, 2], [16, 81, 4], [20, 79, 2], [22, 76, 2], [24, 72, 2], [26, 74, 2], [28, 76, 4]],
      [[0, 76, 3], [3, 74, 1], [4, 72, 2], [6, 74, 2], [8, 76, 4], [12, 79, 2], [14, 81, 2], [16, 83, 4], [20, 81, 2], [22, 80, 2], [24, 76, 8]]
    ],
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, s16 = E.s16, i;
      E.pad(T, ch.v, E.barLen, s === 'drop' ? 1 : 0.85, E.padP);
      E.arp(T, ch.v, s === 'drop' ? [0, 1, 2, 3, 4, 3, 2, 1] : [0, 1, 2, 3, 0, 1, 2, 3], 16, 1, s === 'intro' ? 0.6 : 0.85, E.syn, E.arpP);
      if (s === 'intro') { E.dp(T, { k: 'x.......x.......' }, 0.8); return; }
      if (s === 'break') { E.phr(T, x.b, this.lead, 0.6, E.syn, E.leadP, true); return; }
      var oct = s === 'drop' ? [0, 0, 12, 0, 0, 0, 12, 0] : [0, 0, 0, 0, 0, 0, 0, 0];
      for (i = 0; i < 8; i++) E.syn(T + i * 2 * s16, ch.bass + oct[i], 2 * s16 * 0.75, i % 2 ? 0.75 : 1, E.bassP);
      if (s === 'verse') E.dp(T, { k: 'x.......x.......', s: '....x.......x...', h: 'x.o.x.o.x.o.x.o.' });
      else if (s === 'build') E.dp(T, { k: 'x...x...x...x...', h: 'xoxoxoxoxoxoxoxo' }, 0.9);
      else {
        E.dp(T, { k: 'x...x...x...x...', s: '....x.......x...', h: 'xoxoxoxoxoxoxoxo', oh: x.b % 2 ? '..............O.' : '' });
        E.phr(T, x.b, this.lead, 1, E.syn, E.leadP, true);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 1); E.snare(T, 0.8);
      E.pad(T, ch.v, d, 1.1, E.padP);
      E.syn(T, ch.bass, Math.min(d, 1.4), 1, mix(E.bassP, { s: 0.8, rel: 0.6 }));
      E.syn(T, 81, d, 0.8, mix(E.leadP, { rel: 0.8 }));
      E.arp(T, ch.v, [0, 1, 2, 3, 4, 5, 6, 7], 8, 1, 0.6, E.syn, E.arpP, 12);
    }
  };

  // GLOW UP - dance-pop house, F minor / Ab major, 122 bpm
  DEFS.glow = {
    master: 0.95, swing: 0.06, rev: 1.8, revGain: 0.5, dly: 0.75, fb: 0.35, duck: 0.4, fillKind: 'snare',
    kit: { f0: 155, f1: 48, kdec: 0.32, click: 0.5, clap: 0.85, hat: 0.18, ohat: 0.2, shaker: 0.16, snare: 0.4 },
    prog: [[41, 'm9'], [37, 'M9'], [44, 'add9'], [39, 'add9'], [41, 'm9'], [37, 'M9'], [44, 'add9'], [39, 'M']],
    bassR: [31, 42], padR: [56, 72], endChord: [44, 'add9'],
    setup: function (E) {
      var lr = E.padLR(1, 0.4);
      E.padP = { L: lr.L, R: lr.R, osc: 'sawtooth', det: 12, cut: 1700, a: 0.5, rel: 1, v: 0.12 };
      E.bassP = { dst: E.chan({ gain: 0.6, dest: E.duck }), osc: ['sawtooth', 'sine'], cut: 240, fenv: 1300, fd: 0.09, q: 4, v: 0.5, a: 0.003, d: 0.12, s: 0.5, rel: 0.04 };
      E.stabP = { dst: E.chan({ gain: 0.9, rev: 0.3, dly: 0.22, pan: -0.1 }), osc: ['sawtooth', 'square'], det: 8, cut: 650, fenv: 4200, fd: 0.12, q: 2, v: 0.2, a: 0.002, d: 0.14, s: 0.18, rel: 0.12 };
      E.keysP = { dst: E.chan({ gain: 0.6, rev: 0.3, pan: 0.15 }), ratio: 1, idx: 1.5, idxS: 0.12, idxD: 0.5, v: 0.26, d: 1, s: 0.25, rel: 0.4 };
      E.hookP = { dst: E.chan({ gain: 1, rev: 0.3, dly: 0.42 }), osc: ['square', 'sawtooth'], det: 6, cut: 1100, fenv: 5200, fd: 0.15, q: 2.5, v: 0.17, a: 0.002, d: 0.2, s: 0.3, rel: 0.1, kt: 0.4 };
    },
    hook: [
      [[0, 72, 2], [2, 75, 2], [4, 77, 2], [7, 80, 3], [10, 79, 2], [12, 77, 2], [14, 75, 2], [16, 77, 3], [19, 75, 1], [20, 73, 2], [22, 72, 2], [24, 73, 2], [26, 75, 2], [28, 77, 4]],
      [[0, 72, 2], [2, 75, 2], [4, 80, 2], [7, 79, 3], [10, 77, 2], [12, 75, 2], [14, 72, 2], [16, 70, 4], [20, 75, 2], [22, 79, 2], [24, 82, 4], [28, 79, 4]]
    ],
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, s16 = E.s16, i, stab = 'x..x..x...x..x..';
      if (s === 'intro' || s === 'break') {
        E.pad(T, ch.v, E.barLen, 1, E.padP);
        E.strum(E.fm, T, ch.v, E.barLen * 0.5, 0.7, E.keysP, 0.01);
        if (s === 'intro') E.dp(T, { k: 'x...x...x...x...', h: '..x...x...x...x.' }, 0.85);
        else E.phr(T, x.b, this.hook, 0.55, E.syn, E.hookP);
        return;
      }
      var bl = s === 'drop' ? [[2, 0], [6, 0], [10, 0], [13, 12], [14, 0]] : [[2, 0], [6, 0], [10, 0], [14, 0]];
      for (i = 0; i < bl.length; i++) E.syn(T + bl[i][0] * s16, ch.bass + bl[i][1], s16 * 1.6, i % 2 ? 0.8 : 1, E.bassP);
      if (s === 'verse') {
        E.dp(T, { k: 'x...x...x...x...', c: '....x.......x...', h: '..x...x...x...x.', sh: 'x.o.x.o.x.o.x.o.' });
        E.pat(T, stab, function (t, v) { E.strum(E.fm, t, ch.v, s16 * 2.5, v * 0.8, E.keysP, 0.004); });
      } else if (s === 'build') {
        E.dp(T, { k: x.i === x.n - 1 ? 'x.x.x.x.x.x.xxxx' : 'x...x...x...x...', h: 'xoxoxoxoxoxoxoxo' }, 0.9);
        E.pad(T, ch.v, E.barLen, 0.9, E.padP);
        E.arp(T, ch.v, [0, 1, 2, 3], 8, 2, 0.7, E.syn, E.hookP, 12);
      } else {
        E.dp(T, { k: 'x...x...x...x...', c: '....x.......x...', oh: '..O...O...O...O.', h: 'x.xxx.xxx.xxx.xx', sh: 'oxoooxoooxoooxoo' });
        E.pat(T, stab, function (t, v) { E.csyn(t, ch.v, s16 * 1.2, v, E.stabP); });
        E.phr(T, x.b, this.hook, 1, E.syn, E.hookP);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 1); E.clap(T, 0.9);
      E.pad(T, ch.v, d, 1.2, E.padP);
      E.csyn(T, ch.v, 0.5, 1, mix(E.stabP, { rel: 0.6 }));
      E.strum(E.fm, T, ch.v, d, 0.9, mix(E.keysP, { d: 2.5 }), 0.015);
      E.syn(T, ch.bass, Math.min(d, 1.2), 1, mix(E.bassP, { s: 0.8, rel: 0.5 }));
      E.syn(T, 80, 0.8, 0.8, E.hookP);
    }
  };

  // GOLDEN HOUR - lo-fi chill hop, F major, 84 bpm, swung
  DEFS.golden = {
    swing: 0.18, rev: 1.8, revGain: 0.5, dly: 0.75, fb: 0.3, duck: 0.72, fillKind: 'snare', riser: 0.45,
    kit: { f0: 118, f1: 47, kdec: 0.45, click: 0.18, snHz: 175, snDec: 0.22, snF: 1650, snRev: 0.35, snare: 0.5, hhF: 6200, hat: 0.15, hatDec: 0.035, rim: 0.4 },
    prog: [[46, 'M9'], [45, 'm7'], [43, 'm9'], [48, '9']],
    bassR: [31, 43], padR: [57, 72], endChord: [41, 'M9'],
    setup: function (E) {
      E.keysP = { dst: E.fchan('lowpass', 3000, 0.5, { gain: 0.8, rev: 0.32, dly: 0.08, pan: -0.1 }), ratio: 1, idx: 1.15, idxS: 0.08, idxD: 0.6, v: 0.3, d: 1.6, s: 0.35, rel: 0.5, lfo: E.lfo(0.5, 7) };
      E.bassP = { dst: E.chan({ gain: 0.7, dest: E.duck }), osc: ['triangle', 'sine'], cut: 650, fenv: 250, fd: 0.2, q: 0.8, v: 0.55, a: 0.006, d: 0.3, s: 0.7, rel: 0.08 };
      E.vibeP = { dst: E.fchan('lowpass', 4200, 0.5, { gain: 0.9, rev: 0.4, dly: 0.3, pan: 0.2 }), ratio: 4, idx: 0.45, idxS: 0.04, idxD: 0.12, v: 0.26, d: 1.3, s: 0, rel: 0.6, lfo: E.lfo(4.8, 5) };
      E.vinyl(0.32);
    },
    mel: [
      [[2, 69, 2], [4, 72, 2], [6, 74, 4], [11, 72, 2], [13, 69, 3], [16, 76, 3], [19, 74, 1], [20, 72, 4], [26, 69, 2], [28, 67, 4]],
      [[2, 70, 2], [4, 74, 2], [6, 77, 4], [11, 76, 2], [13, 74, 3], [16, 72, 6], [23, 69, 2], [25, 67, 2], [27, 65, 5]]
    ],
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, s16 = E.s16, nb = x.nx.bass, b = ch.bass;
      E.strum(E.fm, T, ch.v, E.barLen * 0.55, 0.8, E.keysP, 0.016);
      E.strum(E.fm, T + 10 * s16, ch.v, E.barLen * 0.3, 0.5, E.keysP, 0.012);
      if (s === 'intro') { E.dp(T, { h: 'x...x...x...x...' }, 0.6); return; }
      if (s === 'break') { E.phr(T, x.b, this.mel, 0.7, E.fm, E.vibeP); return; }
      E.mel(T, [[0, b, 5], [7, b, 2], [10, b + 7, 3], [14, nb + (nb > b ? -1 : 1), 2]], 1, E.syn, E.bassP);
      if (s === 'verse') E.dp(T, { k: 'x......x..x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.xo' }, 0.9);
      else if (s === 'build') E.dp(T, { k: 'x......x..x.....', h: 'x.xox.xox.xox.xo' }, 0.85);
      else {
        E.dp(T, { k: x.b % 2 ? 'x......x.xx.....' : 'x......x..x.....', s: '....x.......x..q', h: 'x.xox.xox.xox.xo', rim: '..............o.' });
        E.phr(T, x.b, this.mel, 1, E.fm, E.vibeP);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 0.9);
      E.strum(E.fm, T, ch.v, d, 1, mix(E.keysP, { d: 3, s: 0.4 }), 0.03);
      E.syn(T, ch.bass, d, 1, mix(E.bassP, { s: 0.6, rel: 0.6 }));
      E.fm(T + 2 * E.s16, 77, d, 0.7, E.vibeP);
    }
  };

  // HYPE MODE - half-time trap, C minor, 140 bpm
  DEFS.hype = {
    rev: 1.6, revGain: 0.45, dly: 0.75, fb: 0.32, duck: 0.8, fillKind: 'trap',
    kit: { f0: 185, f1: 50, pt: 0.05, kdec: 0.26, click: 0.6, snHz: 210, snDec: 0.15, snF: 2900, snare: 0.45, clap: 0.65, clRev: 0.25, hhF: 8600, hat: 0.24, hatDec: 0.03, ohat: 0.15 },
    prog: [[36, 'm'], [44, 'M'], [41, 'm'], [43, 'M']],
    bassR: [31, 42], padR: [55, 70], endChord: [36, 'm'],
    setup: function (E) {
      E.p808 = { dst: E.chan({ gain: 0.62, dest: E.duck }), osc: ['sine'], cut: 5000, v: 0.95, a: 0.003, d: 0.9, s: 0.55, rel: 0.1, glide: 0.07, sat: 2.4 };
      var lr = E.padLR(1, 0.5);
      E.padP = { L: lr.L, R: lr.R, osc: 'sawtooth', det: 14, cut: 950, a: 0.6, rel: 1.2, v: 0.13 };
      E.bellP = { dst: E.chan({ gain: 0.9, rev: 0.35, dly: 0.3, pan: 0.1 }), ratio: 3.5, idx: 0.9, idxS: 0.08, idxD: 0.22, v: 0.3, d: 0.9, s: 0, rel: 0.4 };
    },
    bells: [
      [[0, 79, 2], [2, 75, 2], [4, 72, 2], [6, 75, 2], [8, 79, 2], [10, 80, 3], [13, 79, 3], [16, 75, 2], [18, 72, 2], [20, 68, 2], [22, 72, 2], [24, 75, 4], [28, 74, 4]],
      [[0, 77, 2], [2, 72, 2], [4, 68, 2], [6, 72, 2], [8, 77, 2], [10, 80, 3], [13, 79, 3], [16, 74, 2], [18, 71, 2], [20, 67, 2], [22, 71, 2], [24, 74, 4], [28, 79, 4]]
    ],
    hats: ['x.x.x.x.x.x.xrx.', 'x.x.x.xtx.x.x.r.', 'xxx.x.x.xrx.x.x.', 'x.x.x.x.ttttx.xr'],
    kicks: [['x......x..x.....', [[0, 0, 7], [7, 0, 3], [10, 12, 4], [14, 0, 2]]],
            ['x.....x...x..x..', [[0, 0, 6], [6, 0, 4], [10, 0, 3], [13, 7, 3]]]],
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, s16 = E.s16, i;
      E.pad(T, ch.v, E.barLen, s === 'drop' ? 0.75 : 1, E.padP);
      E.phr(T, x.b, this.bells, s === 'intro' ? 0.75 : 1, E.fm, E.bellP);
      if (s === 'intro') { if (x.i === x.n - 1) E.dp(T, { h: 'x.x.x.x.x.x.x.x.' }, 0.6); return; }
      if (s === 'break') return;
      if (s === 'verse') {
        E.dp(T, { k: 'x.........x.....', c: '........x.......', h: 'x.x.x.x.x.x.x.x.' }, 0.9);
        E.mel(T, [[0, ch.bass, 9], [10, ch.bass, 5]], 0.8, E.syn, E.p808);
      } else if (s === 'build') {
        E.dp(T, { h: x.i === x.n - 1 ? 'xxxxxxxxttttrrrr' : 'x.x.x.x.x.x.x.x.' }, 0.8);
      } else {
        var kp = this.kicks[x.b % 2], prev = null;
        E.dp(T, { k: kp[0], c: '........x.......', s: '........x.......', h: this.hats[x.b % 4], oh: x.b % 4 === 3 ? '..........O.....' : '' });
        for (i = 0; i < kp[1].length; i++) {
          var n = kp[1][i], note = ch.bass + n[1];
          E.syn(T + n[0] * s16, note, n[2] * s16 * 0.95, 1, E.p808, prev != null && prev !== note ? prev : null);
          prev = note;
        }
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 1); E.clap(T, 0.9);
      E.syn(T, ch.bass, d, 1, mix(E.p808, { s: 0.7, d: 1.5, rel: 0.5 }));
      E.pad(T, ch.v, d, 1, E.padP);
      E.arp(T, ch.v, [0, 1, 2, 3, 4, 5], 6, 1, 0.8, E.fm, E.bellP, 12);
    }
  };

  // DAYDREAM - dreamy pop, E major, 92 bpm
  DEFS.dream = {
    rev: 2.4, revGain: 0.65, dly: 0.75, fb: 0.45, duck: 0.6, fillKind: 'snare', riser: 0.6,
    kit: { f0: 125, f1: 45, kdec: 0.4, click: 0.15, clap: 0.42, clF: 1800, clRev: 0.5, snare: 0.32, snRev: 0.5, hat: 0.13, shaker: 0.17 },
    prog: [[40, 'M9'], [37, 'm9'], [45, 'M9'], [47, 'sus4'], [40, 'M9'], [37, 'm9'], [45, 'M9'], [47, 'add9']],
    bassR: [31, 43], padR: [56, 73], endChord: [40, 'M9'],
    setup: function (E) {
      var lr = E.padLR(1, 0.6);
      E.padP = { L: lr.L, R: lr.R, osc: 'sawtooth', det: 14, cut: 2000, a: 0.7, rel: 1.6, v: 0.13 };
      E.bellP = { dst: E.chan({ gain: 0.85, rev: 0.5, dly: 0.45, pan: 0.3 }), ratio: 3, idx: 0.6, idxS: 0.02, idxD: 0.1, v: 0.22, d: 1.4, s: 0, rel: 0.8 };
      E.leadP = { dst: E.chan({ gain: 1, rev: 0.5, dly: 0.35, pan: -0.05 }), osc: ['triangle', 'sine'], det: 4, cut: 2600, fenv: 700, fd: 0.3, a: 0.04, d: 0.4, s: 0.8, rel: 0.3, v: 0.27, lfo: E.lfo(5, 8), glide: 0.08 };
      E.bassP = { dst: E.chan({ gain: 0.65, dest: E.duck }), osc: ['sine', 'triangle'], cut: 520, fenv: 200, fd: 0.2, v: 0.55, a: 0.01, d: 0.4, s: 0.8, rel: 0.15 };
    },
    lead: [
      [[0, 80, 3], [3, 78, 1], [4, 76, 4], [8, 78, 2], [10, 80, 2], [12, 83, 4], [16, 85, 3], [19, 83, 1], [20, 80, 4], [24, 78, 4], [28, 76, 4]],
      [[0, 76, 2], [2, 78, 2], [4, 80, 4], [8, 81, 2], [10, 80, 2], [12, 78, 4], [16, 78, 3], [19, 80, 1], [20, 83, 6], [26, 80, 2], [28, 78, 4]]
    ],
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, b = ch.bass;
      E.pad(T, ch.v, E.barLen, 1, E.padP);
      E.arp(T, ch.v, [0, 2, 1, 3, 2, 4, 3, 5], 8, 2, s === 'drop' ? 0.65 : 0.85, E.fm, E.bellP, 12);
      if (s === 'intro') return;
      if (s === 'break') { E.phr(T, x.b, this.lead, 0.6, E.syn, E.leadP, true); return; }
      if (s === 'verse') {
        E.dp(T, { k: 'x.......x.x.....', c: '....x.......x...', sh: 'x.x.x.x.x.x.x.x.' }, 0.8);
        E.mel(T, [[0, b, 7], [8, b, 4], [12, b + 12, 4]], 1, E.syn, E.bassP);
      } else if (s === 'build') {
        E.dp(T, { k: 'x...x...x...x...', sh: 'xoxoxoxoxoxoxoxo' }, 0.7);
      } else {
        E.dp(T, { k: 'x.....x.x.......', c: '....x.......x...', h: '..x...x...x...x.', sh: 'xoxoxoxoxoxoxoxo' }, 0.9);
        E.mel(T, [[0, b, 3], [3, b, 3], [6, b, 2], [8, b, 3], [11, b, 3], [14, b + 12, 2]], 1, E.syn, E.bassP);
        E.phr(T, x.b, this.lead, 1, E.syn, E.leadP, true);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 0.8);
      E.pad(T, ch.v, d, 1.2, E.padP);
      E.syn(T, ch.bass, d, 1, E.bassP);
      E.syn(T, 76, d, 0.8, E.leadP);
      E.arp(T, ch.v, [0, 1, 2, 3, 4, 5, 6, 7], 8, 1, 0.7, E.fm, E.bellP, 12);
    }
  };

  // SUN DANCE - afro-pop groove, D major, 104 bpm
  DEFS.sun = {
    master: 0.72, swing: 0.12, rev: 1.6, revGain: 0.45, dly: 0.75, fb: 0.32, duck: 0.6, fillKind: 'tom',
    kit: { f0: 140, f1: 50, kdec: 0.3, click: 0.3, rim: 0.5, rimF: 2600, shaker: 0.24, shF: 7000, clap: 0.42, tom: 0.5, hat: 0.13 },
    prog: [[38, 'M7'], [35, 'm7'], [43, 'M7'], [45, 'sus4'], [38, 'M7'], [42, 'm7'], [43, 'M7'], [45, 'M']],
    bassR: [31, 43], padR: [57, 74], endChord: [38, 'M7'],
    setup: function (E) {
      E.logP = { dst: E.chan({ gain: 0.6, dest: E.duck }), osc: ['sine', 'triangle'], cut: 1600, fenv: 1600, fd: 0.08, q: 1, v: 0.75, a: 0.002, d: 0.25, s: 0.25, rel: 0.08, glide: 0.035, sat: 1.6 };
      E.bassP = { dst: E.chan({ gain: 0.65, dest: E.duck }), osc: ['triangle', 'sine'], cut: 700, fenv: 400, fd: 0.15, v: 0.55, a: 0.004, d: 0.25, s: 0.6, rel: 0.06 };
      E.gtrP = { dst: E.chan({ gain: 0.9, pan: 0.35, rev: 0.2, dly: 0.28 }), osc: ['triangle', 'sawtooth'], det: 3, cut: 1500, fenv: 2600, fd: 0.06, q: 1.5, a: 0.002, d: 0.12, s: 0.15, rel: 0.08, v: 0.27 };
      E.marP = { dst: E.chan({ gain: 0.9, pan: -0.2, rev: 0.3, dly: 0.2 }), ratio: 4, idx: 0.8, idxS: 0.02, idxD: 0.06, v: 0.34, d: 0.45, s: 0, rel: 0.25 };
      var lr = E.padLR(1, 0.35);
      E.padP = { L: lr.L, R: lr.R, osc: 'sawtooth', det: 9, cut: 1400, a: 0.4, rel: 0.8, v: 0.09 };
    },
    mar: [
      [[0, 78, 2], [2, 81, 2], [4, 83, 1], [6, 81, 2], [8, 78, 2], [11, 76, 2], [13, 74, 3], [16, 76, 2], [18, 78, 2], [20, 74, 2], [22, 71, 2], [24, 74, 4], [28, 71, 4]],
      [[0, 74, 2], [2, 76, 2], [4, 78, 2], [6, 81, 2], [8, 83, 3], [11, 81, 1], [12, 78, 4], [16, 76, 2], [18, 78, 2], [20, 76, 2], [22, 74, 2], [24, 76, 4], [28, 69, 4]],
      [[0, 78, 2], [2, 81, 2], [4, 83, 1], [6, 81, 2], [8, 78, 2], [11, 76, 2], [13, 74, 3], [16, 76, 2], [18, 78, 2], [20, 81, 2], [22, 78, 2], [24, 76, 4], [28, 73, 4]],
      [[0, 74, 2], [2, 76, 2], [4, 78, 2], [6, 81, 2], [8, 83, 3], [11, 81, 1], [12, 78, 4], [16, 76, 2], [18, 78, 2], [20, 76, 2], [22, 73, 2], [24, 76, 4], [28, 69, 4]]
    ],
    gtr: [2, -1, -1, 1, -1, -1, 3, -1, 2, -1, 0, -1, -1, 1, 3, -1],
    conga: function (E, T, v) {
      E.pat(T, '..x.x...x.x.x..o', function (t, vv, c2, st) { E.tom(t, st % 4 === 0 ? 64 : 69, vv * v, 0.2); });
    },
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, b = ch.bass, i;
      E.pad(T, ch.v, E.barLen, 0.9, E.padP);
      E.arp(T, ch.v, this.gtr, 16, 1, s === 'intro' ? 0.7 : 0.9, E.syn, E.gtrP);
      if (s === 'intro') { E.dp(T, { sh: 'xoxoxoxoxoxoxoxo' }, 0.8); return; }
      if (s === 'break') { E.phr(T, x.b, this.mar, 0.6, E.fm, E.marP); this.conga(E, T, 0.5); return; }
      if (s === 'verse') {
        E.dp(T, { k: 'x.....x.x.......', rim: '...x..x....x..x.', sh: 'xoxoxoxoxoxoxoxo', c: '....o.......o...' });
        this.conga(E, T, 0.7);
        E.mel(T, [[0, b, 3], [6, b, 2], [8, b + 7, 3], [11, b + 12, 2], [14, b, 2]], 1, E.syn, E.bassP);
      } else if (s === 'build') {
        E.dp(T, { k: 'x...x...x...x...', sh: 'xxxxxxxxxxxxxxxx' }, 0.75);
        this.conga(E, T, 0.6 + 0.4 * x.i / x.n);
      } else {
        E.dp(T, { k: 'x.....x.x.....x.', rim: '...x..x....x..x.', sh: 'xoxoxoxoxoxoxoxo', c: '....x.......x...', h: '..x...x...x...x.' });
        this.conga(E, T, 0.8);
        var lg = [[0, 0, 3], [3, 12, 3], [6, 0, 2], [8, 7, 3], [11, 12, 2], [14, 10, 2]];
        for (i = 0; i < lg.length; i++) E.syn(T + lg[i][0] * E.s16, b + lg[i][1], lg[i][2] * E.s16, i ? 0.85 : 1, E.logP, b + lg[i][1] + 5);
        E.phr(T, x.b, this.mar, 1, E.fm, E.marP);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 1); E.clap(T, 0.6);
      E.syn(T, ch.bass, Math.min(d, 1.2), 1, mix(E.logP, { s: 0.6, rel: 0.5 }), ch.bass + 5);
      E.pad(T, ch.v, d, 1.2, E.padP);
      E.arp(T, ch.v, [0, 1, 2, 3, 4, 5, 6, 7], 8, 1, 0.8, E.fm, E.marP, 12);
    }
  };

  function shift(list, semis) {
    return list.map(function (ph) { return ph.map(function (n) { return [n[0], n[1] + semis, n[2], n[3]]; }); });
  }

  // RISE UP - cinematic build, D minor, 96 bpm
  var EPIC_THEME = [
    [[0, 69, 4], [4, 74, 6], [10, 76, 2], [12, 77, 4], [16, 77, 6], [22, 76, 2], [24, 74, 8]],
    [[0, 72, 4], [4, 77, 6], [10, 79, 2], [12, 81, 4], [16, 79, 6], [22, 77, 2], [24, 76, 8]],
    [[0, 69, 4], [4, 74, 6], [10, 76, 2], [12, 77, 4], [16, 77, 6], [22, 79, 2], [24, 74, 8]],
    [[0, 74, 4], [4, 79, 6], [10, 77, 2], [12, 74, 4], [16, 73, 6], [22, 76, 2], [24, 81, 8]]
  ];
  DEFS.epic = {
    master: 0.7, rev: 2.5, revGain: 0.7, dly: 0.5, fb: 0.25, duck: 0.75, fillKind: 'tom', riser: 1,
    kit: { f0: 110, f1: 38, kdec: 0.7, click: 0.2, snHz: 200, snDec: 0.25, snF: 2200, snRev: 0.6, snare: 0.5, tom: 0.75, tomRev: 0.4, crash: 0.26 },
    prog: [[38, 'm'], [34, 'M'], [41, 'M'], [36, 'M'], [38, 'm'], [34, 'M'], [31, 'm'], [33, 'M']],
    bassR: [26, 38], padR: [55, 72], endChord: [38, 'M'],
    theme: EPIC_THEME, themeLo: shift(EPIC_THEME, -12),
    setup: function (E) {
      E.strP = { dst: E.chan({ gain: 0.9, rev: 0.35, pan: 0.25 }), osc: ['sawtooth', 'sawtooth'], det: 8, cut: 1300, fenv: 1900, fd: 0.08, q: 0.8, a: 0.004, d: 0.1, s: 0.4, rel: 0.07, v: 0.24, kt: 0.3 };
      var lo = E.padLR(1, 0.4), hi = E.padLR(1, 0.65, E.mus);
      E.brassP = { L: lo.L, R: lo.R, osc: 'sawtooth', det: 8, cut: 1250, a: 0.12, rel: 0.6, v: 0.15 };
      E.choirP = { L: hi.L, R: hi.R, osc: 'sawtooth', det: 16, cut: 2500, a: 0.8, rel: 1.2, v: 0.11 };
      E.pianoP = { dst: E.chan({ gain: 0.8, rev: 0.5, dly: 0.15, pan: -0.15 }), ratio: 1, idx: 1.8, idxS: 0.1, idxD: 0.25, v: 0.3, d: 1.6, s: 0.15, rel: 0.6 };
      E.hornP = { dst: E.chan({ gain: 1, rev: 0.5, dly: 0.1 }), osc: ['sawtooth', 'sawtooth'], det: 7, cut: 1400, fenv: 1700, fd: 0.35, q: 0.7, a: 0.06, d: 0.4, s: 0.85, rel: 0.3, v: 0.17, lfo: E.lfo(4.5, 6) };
      E.bassP = { dst: E.chan({ gain: 0.6, dest: E.duck }), osc: ['sawtooth', 'sine'], cut: 380, fenv: 300, fd: 0.3, a: 0.02, d: 0.3, s: 0.9, rel: 0.2, v: 0.45 };
    },
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, i, rs = fold(ch.r, 50, 61), lowV = voicing(ch.r, ch.t, 50, 65);
      var ost = [0, 0, 12, 0, 7, 0, 12, 0, 0, 0, 12, 0, 7, 0, 12, 7];
      if (s === 'intro' || s === 'break') {
        E.arp(T, ch.v, [0, 2, 1, 3, 0, 2, 1, 3], 8, 2, 0.85, E.fm, E.pianoP);
        E.pad(T, ch.v, E.barLen, 0.8, E.choirP);
        if (x.b === 0) E.boom(T, 0.55);
        if (s === 'break') E.phr(T, x.b, this.theme, 0.6, E.syn, E.hornP);
        return;
      }
      var sv = s === 'build' ? 0.6 + 0.4 * (x.i + 1) / x.n : s === 'drop' ? 1 : 0.75;
      for (i = 0; i < 16; i++) E.syn(T + i * E.s16, rs + ost[i], E.s16 * 0.8, sv * (i % 4 === 0 ? 1 : 0.7), E.strP);
      E.syn(T, ch.bass, E.barLen * 0.95, 1, E.bassP);
      E.pad(T, ch.v, E.barLen, s === 'drop' ? 1 : 0.7, E.choirP);
      if (s === 'verse') { E.tom(T, 45, 0.6); E.tom(T + 8 * E.s16, 45, 0.5); E.tom(T + 14 * E.s16, 48, 0.35); }
      else if (s === 'build') { for (i = 0; i < 16; i += 2) E.tom(T + i * E.s16, i % 4 ? 48 : 43, 0.3 + 0.5 * (x.i * 16 + i) / (x.n * 16)); }
      else {
        E.boom(T, 0.9);
        E.pat(T, 'x..x..x.x...x.x.', function (t, v, c2, st) { E.tom(t, st % 3 ? 48 : 43, v * 0.8); });
        E.dp(T, { s: '....x.......x...' });
        E.pad(T, lowV, E.barLen, 1, E.brassP);
        E.phr(T, x.b, this.theme, 1, E.syn, E.hornP);
        E.phr(T, x.b, this.themeLo, 0.8, E.syn, E.hornP);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.boom(T, 1); E.tom(T, 43, 0.9); E.snare(T, 0.9);
      E.pad(T, voicing(ch.r, ch.t, 50, 65), d, 1.2, E.brassP);
      E.pad(T, ch.v, d, 1.2, E.choirP);
      E.syn(T, ch.bass, d, 1, E.bassP);
      E.syn(T, 74, d, 0.9, E.hornP); E.syn(T, 62, d, 0.8, E.hornP);
      E.fm(T, 74, d, 0.8, E.pianoP);
    }
  };

  // DISCO BALL - nu-disco funk, A minor (dorian), 116 bpm
  DEFS.disco = {
    master: 0.85, swing: 0.04, rev: 1.8, revGain: 0.5, dly: 0.75, fb: 0.36, duck: 0.45, fillKind: 'snare',
    kit: { f0: 150, f1: 50, kdec: 0.3, click: 0.45, clap: 0.85, hat: 0.2, ohat: 0.22, shaker: 0.15, shF: 8500, snare: 0.35 },
    prog: [[33, 'm9'], [38, '9'], [43, 'M9'], [36, 'M7'], [33, 'm9'], [38, '9'], [41, 'M7'], [40, '7']],
    bassR: [28, 40], padR: [57, 74], hiR: [62, 76], endChord: [33, 'm9'],
    setup: function (E) {
      E.bassP = { dst: E.chan({ gain: 0.6, dest: E.duck }), osc: ['sawtooth', 'square'], det: 4, cut: 420, fenv: 1600, fd: 0.1, q: 3, v: 0.5, a: 0.003, d: 0.12, s: 0.6, rel: 0.04 };
      E.gtrP = { dst: E.chan({ gain: 0.9, pan: 0.4, rev: 0.15 }), osc: ['square'], cut: 1700, fenv: 2400, fd: 0.05, q: 2, v: 0.34, a: 0.001, d: 0.06, s: 0.1, rel: 0.04 };
      var lr = E.padLR(1, 0.45);
      E.strP = { L: lr.L, R: lr.R, osc: 'sawtooth', det: 10, cut: 3200, a: 0.15, rel: 0.5, v: 0.1 };
      E.keysP = { dst: E.chan({ gain: 0.7, pan: -0.25, rev: 0.25 }), ratio: 1, idx: 1.3, idxS: 0.12, idxD: 0.4, v: 0.24, d: 1.2, s: 0.3, rel: 0.3 };
      E.leadP = { dst: E.chan({ gain: 1, rev: 0.3, dly: 0.38 }), osc: ['sawtooth', 'square'], det: 7, cut: 2400, fenv: 2400, fd: 0.2, q: 1.2, a: 0.006, d: 0.25, s: 0.6, rel: 0.12, v: 0.15, glide: 0.04, lfo: E.lfo(5.5, 7) };
    },
    lead: [
      [[0, 76, 2], [2, 79, 2], [4, 81, 3], [7, 79, 1], [8, 76, 2], [10, 74, 2], [12, 72, 2], [14, 74, 2], [16, 76, 4], [20, 74, 2], [22, 72, 2], [24, 69, 4], [28, 66, 2], [30, 69, 2]],
      [[0, 74, 2], [2, 76, 2], [4, 79, 3], [7, 81, 1], [8, 79, 2], [10, 76, 2], [12, 74, 4], [16, 72, 4], [20, 71, 2], [22, 72, 2], [24, 76, 6], [30, 74, 2]],
      [[0, 76, 2], [2, 79, 2], [4, 81, 3], [7, 79, 1], [8, 76, 2], [10, 74, 2], [12, 72, 2], [14, 74, 2], [16, 76, 4], [20, 74, 2], [22, 72, 2], [24, 69, 4], [28, 66, 2], [30, 69, 2]],
      [[0, 72, 2], [2, 76, 2], [4, 77, 3], [7, 76, 1], [8, 72, 2], [10, 69, 2], [12, 72, 4], [16, 71, 4], [20, 68, 2], [22, 71, 2], [24, 74, 4], [28, 76, 4]]
    ],
    bar: function (E, T, x) {
      var ch = x.ch, s = x.sec, s16 = E.s16, i, b = ch.bass;
      if (s === 'intro' || s === 'break') {
        E.strum(E.fm, T, ch.v, E.barLen * 0.45, 0.8, E.keysP, 0.008);
        E.strum(E.fm, T + 10 * s16, ch.v, E.barLen * 0.25, 0.55, E.keysP, 0.006);
        E.pad(T, ch.v, E.barLen, 0.7, E.strP);
        if (s === 'intro') E.dp(T, { k: 'x...x...x...x...', h: '..x...x...x...x.' }, 0.85);
        else E.phr(T, x.b, this.lead, 0.55, E.syn, E.leadP, true);
        return;
      }
      var bl = s === 'drop' ? [[0, 0], [2, 12], [4, 0], [6, 12], [8, 0], [10, 12], [11, 10], [12, 0], [14, 12], [15, 7]]
                            : [[0, 0], [2, 12], [4, 0], [6, 12], [8, 0], [10, 12], [12, 0], [14, 12]];
      for (i = 0; i < bl.length; i++) E.syn(T + bl[i][0] * s16, b + bl[i][1], s16 * 1.4, bl[i][1] ? 0.8 : 1, E.bassP);
      if (s === 'verse') {
        E.dp(T, { k: 'x...x...x...x...', c: '....x.......x...', h: '..x...x...x...x.', sh: 'x.x.x.x.x.x.x.x.' });
        E.strum(E.fm, T, ch.v, E.barLen * 0.45, 0.8, E.keysP, 0.008);
        E.pat(T, '..x...x...x...x.', function (t, v) { E.csyn(t, ch.hi, s16 * 0.8, v * 0.8, E.gtrP); });
      } else if (s === 'build') {
        E.dp(T, { k: 'x...x...x...x...', h: 'xoxoxoxoxoxoxoxo' }, 0.9);
        E.pad(T, ch.v, E.barLen, 0.9, E.strP);
      } else {
        E.dp(T, { k: 'x...x...x...x...', c: '....x.......x...', oh: '..O...O...O...O.', h: 'x.xxx.xxx.xxx.xx', sh: 'oxoooxoooxoooxoo' });
        E.pad(T, ch.v, E.barLen, 1, E.strP);
        E.pat(T, 'x.xx..x.x.xx..x.', function (t, v) { E.csyn(t, ch.hi, s16 * 0.7, v, E.gtrP); });
        E.phr(T, x.b, this.lead, 1, E.syn, E.leadP, true);
      }
    },
    end: function (E, T, ch) {
      var d = E.dur - T;
      E.kick(T, 1); E.clap(T, 0.9);
      E.pad(T, ch.v, d, 1.2, E.strP);
      E.csyn(T, ch.hi, 0.4, 1, E.gtrP);
      E.strum(E.fm, T, ch.v, d, 0.9, mix(E.keysP, { d: 2.5 }), 0.012);
      E.syn(T, ch.bass, Math.min(d, 1.2), 1, mix(E.bassP, { s: 0.8, rel: 0.5 }));
      E.syn(T, ch.bass + 12, Math.min(d, 1.2), 0.7, mix(E.bassP, { s: 0.8, rel: 0.5 }));
      E.syn(T, 81, d, 0.8, mix(E.leadP, { rel: 0.6 }));
    }
  };

  /* ---------- arrangement ---------- */
  P.chord = function (b, spec) {
    var d = this.def, n = d.prog.length, pr = spec || d.prog[((b % n) + n) % n];
    var hiR = d.hiR || [d.padR[0] + 7, d.padR[1] + 7];
    return {
      r: pr[0], t: pr[1], bass: fold(pr[0], d.bassR[0], d.bassR[1]),
      v: voicing(pr[0], pr[1], d.padR[0], d.padR[1]), hi: voicing(pr[0], pr[1], hiR[0], hiR[1])
    };
  };

  // Sections by bar count. The closing hit lands on the latest downbeat that leaves >= 1 s to ring out.
  function plan(dur, barLen) {
    var hb = Math.max(0, Math.floor((dur - 1.0) / barLen + 1e-6)), hitT = hb * barLen;
    if (dur - hitT > barLen + 0.2 && dur - (hitT + barLen / 2) >= 1.0) hitT += barLen / 2;
    var nb = Math.ceil(hitT / barLen - 1e-6), secs = [];
    function add(name, n) { for (var i = 0; i < n; i++) secs.push({ s: name, i: i, n: n }); }
    if (nb <= 0) { /* only the closing hit */ }
    else if (nb < 4) { if (nb >= 2) { add('intro', 1); add('drop', nb - 1); } else add('drop', 1); }
    else if (nb < 10) {
      var v = Math.max(1, Math.floor((nb - 1) / 2));
      add('intro', 1); add('verse', v); add('drop', nb - 1 - v);
    } else {
      var I = nb >= 24 ? 4 : 2, B = nb >= 20 ? 2 : 1;
      if (nb >= 28) {
        var K = nb >= 36 ? 4 : 2, R = nb - I - 2 * B - K, V = Math.round(R * 0.15) * 2, D1 = Math.round(R * 0.15) * 2;
        add('intro', I); add('verse', V); add('build', B); add('drop', D1);
        add('break', K); add('build', B); add('drop', R - V - D1);
      } else {
        var R2 = nb - I - B, V2 = Math.max(2, Math.round(R2 * 0.2) * 2);
        add('intro', I); add('verse', V2); add('build', B); add('drop', R2 - V2);
      }
    }
    return { hitT: hitT, nb: nb, secs: secs };
  }

  // Sidechain-style ducking of bass + pads for the kicks scheduled in one bar (ending before `until`).
  P.duckBar = function (until) {
    var g = this.duck.gain, k = this.kicks.sort(function (a, b) { return a - b; });
    var depth = this.tr.duck || 0.6, rel = this.beat * 0.6, last = -1, i;
    for (i = 0; i < k.length; i++) {
      var t = k[i];
      if (t - last < 0.06 || t >= this.dur) continue;
      var nx = i + 1 < k.length ? k[i + 1] : until, r = Math.max(0.03, Math.min(rel, nx - t - 0.004));
      g.setValueAtTime(1, t); g.linearRampToValueAtTime(depth, t + 0.006); g.linearRampToValueAtTime(1, t + r);
      last = t;
    }
    this.kicks = [];
  };

  P.finish = function (pl) {
    var E = this, dur = E.dur, i;
    E.duck.gain.setValueAtTime(1, 0);
    // filtered intro that opens up into the groove
    var nI = 0;
    while (nI < pl.secs.length && pl.secs[nI].s === 'intro') nI++;
    if (nI) {
      E.dj.frequency.setValueAtTime(E.tr.introF || (nI === 1 ? 900 : 450), 0);
      E.dj.frequency.exponentialRampToValueAtTime(E.nyq, nI * E.barLen);
    }
    // smooth fade to silence over the last ~1 s
    var fd = Math.min(1.0, dur * 0.35), st = dur - fd, n = 64, curve = new Float32Array(n);
    for (i = 0; i < n; i++) curve[i] = 0.5 * (1 + Math.cos(Math.PI * i / (n - 1)));
    E.fade.gain.setValueAtTime(1, 0);
    E.fade.gain.setValueCurveAtTime(curve, st, Math.max(0.005, fd - 0.004));
  };

  // Builds the arrangement as a list of per-bar jobs; each job creates that bar's audio nodes.
  // Jobs are run just ahead of the render position (OfflineAudioContext.suspend), which keeps
  // the live audio graph small so long renders stay fast.
  function compose(ctx, tk, def, dur) {
    def.bpm = tk.bpm;
    var E = new Engine(ctx, def, dur, hashStr(tk.id) ^ 0x5bd1e995);
    E.def = def;
    def.setup(E);
    var pl = plan(dur, E.barLen), secs = pl.secs, jobs = [];
    function barJob(b) {
      return function () {
        var T = b * E.barLen, s = secs[b], nx = secs[b + 1];
        var x = { b: b, sec: s.s, i: s.i, n: s.n, ch: E.chord(b), nx: E.chord(b + 1), last: b === secs.length - 1 };
        E.lim = pl.hitT;
        def.bar(E, T, x);
        if (s.s === 'build') {
          if (s.i === 0) E.riser(T, Math.min(T + s.n * E.barLen, pl.hitT), def.riser || 0.8);
          if (s.i === s.n - 1) E.roll(T, Math.min(T + E.barLen, pl.hitT), 0.85, true);
        }
        if (s.s === 'drop' && s.i === 0 && b > 0) E.crash(T, 0.9);
        if (s.s === 'verse' && s.i === 0 && b > 0) E.crash(T, 0.45);
        if (b > 0 && s.s !== 'build' && (x.last || (s.s === 'verse' && nx && nx.s === 'drop'))) E.fill(T, def.fillKind);
        E.duckBar(Math.min(T + E.barLen, pl.hitT));
        E.flush();
      };
    }
    for (var b = 0; b < secs.length; b++) jobs.push({ t: b * E.barLen, fn: barJob(b) });
    // the ending: closing chord + hit, left to ring into the fade
    jobs.push({ t: pl.hitT, fn: function () {
      E.lim = dur;
      def.end(E, pl.hitT, E.chord(0, def.endChord));
      E.crash(pl.hitT, 1);
      E.duckBar(dur);
      E.flush();
    } });
    E.finish(pl);
    E.jobs = jobs;
    return E;
  }
  function normalize(buf, target) {
    var peak = 0, ch, d, i, a;
    for (ch = 0; ch < buf.numberOfChannels; ch++) {
      d = buf.getChannelData(ch);
      for (i = 0; i < d.length; i++) {
        a = d[i];
        if (a !== a) { d[i] = 0; continue; }
        if (a < 0) a = -a;
        if (a > peak) peak = a;
      }
    }
    if (peak > 1e-6) {
      var k = target / peak;
      for (ch = 0; ch < buf.numberOfChannels; ch++) {
        d = buf.getChannelData(ch);
        for (i = 0; i < d.length; i++) d[i] *= k;
      }
    }
    return buf;
  }

  function byId(id) {
    for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i];
    return TRACKS[0];
  }

  function render(id, duration, opts) {
    opts = opts || {};
    var tk = byId(id), def = DEFS[tk.id], sr = opts.sampleRate || 48000;
    duration = +duration;
    if (!(duration > 0)) duration = 8;
    return new Promise(function (resolve, reject) {
      var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      if (!OAC) { reject(new Error('Web Audio is not supported in this browser')); return; }
      var ctx, E, settled = false, ji = 0, AHEAD = 0.6;
      function fail(e) { if (!settled) { settled = true; reject(e); } }
      function done(buf) {
        if (settled) return;
        settled = true;
        resolve(normalize(buf, 0.891));   // about -1 dBFS
      }
      function pump(until) { while (ji < E.jobs.length && E.jobs[ji].t < until) E.jobs[ji++].fn(); }
      // Register the next suspend point just before the next unscheduled bar.
      function arm() {
        if (ji >= E.jobs.length) return;
        var at = Math.floor(Math.max(0, E.jobs[ji].t - AHEAD) * sr / 128) * 128 / sr;
        ctx.suspend(at).then(function () {
          try { pump(at + AHEAD + 0.05); arm(); } catch (e) { fail(e); }
          ctx.resume();
        }, fail);
      }
      try {
        ctx = new OAC(2, Math.max(1, Math.round(duration * sr)), sr);
        E = compose(ctx, tk, def, duration);
        if (typeof ctx.suspend === 'function' && typeof ctx.resume === 'function') { pump(AHEAD + 0.05); arm(); }
        else pump(Infinity);
      } catch (e) { fail(e); return; }
      ctx.oncomplete = function (ev) { done(ev.renderedBuffer); };
      var p = ctx.startRendering();
      if (p && typeof p.then === 'function') p.then(done, fail);
    });
  }

  global.GlowMusic = { tracks: TRACKS, render: render, getTrack: byId };
})(typeof window !== 'undefined' ? window : this);
