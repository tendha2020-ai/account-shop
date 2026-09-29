// songs.js — turns a music file into Neon Pulse charts, and keeps a small
// library of the player's songs in this browser (IndexedDB).
//
// Analysis runs on a fixed 22,050 Hz mono copy of the song so every device
// builds the same chart from the same file (needed for versus matches).
'use strict';

window.NeonSongs = (() => {
  const ANALYSIS_VERSION = 1;
  const RATE = 22050;
  const FFT_SIZE = 1024;
  const HOP = 256;
  const HOP_T = HOP / RATE; // ≈ 11.6 ms per frame
  // Spectral flux peaks about 30 ms before the hit is heard (the window sees
  // it coming); measured on test tracks with known drum times.
  const ONSET_DELAY = 0.03;

  // Low, mid and high bands (in FFT bins of ≈21.5 Hz): kicks and bass land
  // on the left lanes, vocals and synths in the middle, hats and cymbals on
  // the right.
  const BANDS = [
    [1, 10],
    [10, 93],
    [93, FFT_SIZE / 2],
  ];

  const DIFF_RULES = {
    easy: { perSec: 1.2, minGap: 0.33, beatBonus: 1.8, eighthBonus: 1.1, doubles: 0 },
    normal: { perSec: 2.2, minGap: 0.16, beatBonus: 1.4, eighthBonus: 1.25, doubles: 0 },
    hard: { perSec: 3.6, minGap: 0.09, beatBonus: 1.2, eighthBonus: 1.15, doubles: 0.1 },
  };

  // ---------- Decoding ----------
  async function decodeMono(bytes) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Offline(1, RATE, RATE);
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    return { mono, rate: buf.sampleRate, duration: buf.duration };
  }

  // ---------- FFT (in-place radix-2) ----------
  function makeFft(n) {
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      rev[i] = r;
    }
    const cos = new Float32Array(n / 2);
    const sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    return (re, im) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const a = start + k;
            const b = a + half;
            const wr = cos[k * step];
            const wi = sin[k * step];
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    };
  }

  // ---------- Onset features ----------
  function features(mono) {
    const frames = Math.max(0, Math.floor((mono.length - FFT_SIZE) / HOP));
    const fft = makeFft(FFT_SIZE);
    const win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    let prev = new Float32Array(FFT_SIZE / 2);
    let cur = new Float32Array(FFT_SIZE / 2);
    const flux = BANDS.map(() => new Float32Array(frames));
    const energy = new Float32Array(frames);

    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = mono[off + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      let e = 0;
      for (let k = 1; k < FFT_SIZE / 2; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        cur[k] = Math.log1p(10 * mag);
        e += mag;
      }
      energy[f] = e;
      for (let b = 0; b < BANDS.length; b++) {
        let s = 0;
        for (let k = BANDS[b][0]; k < BANDS[b][1]; k++) {
          const d = cur[k] - prev[k];
          if (d > 0) s += d;
        }
        flux[b][f] = s;
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
    return { frames, flux, energy };
  }

  function percentile(arr, q) {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
  }

  // Each band normalized so a loud bass line doesn't drown out the hats.
  function onsetEnvelope(feat) {
    const { frames, flux } = feat;
    const norm = flux.map((band) => percentile(band, 0.95) || 1);
    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let b = 0; b < flux.length; b++) s += flux[b][f] / norm[b];
      env[f] = s / flux.length;
    }
    return { env, norm };
  }

  function pickPeaks(env) {
    const peaks = [];
    const w = 4; // ±46 ms local maximum
    const avgW = Math.round(0.35 / HOP_T);
    // Running mean via prefix sums.
    const pre = new Float64Array(env.length + 1);
    for (let i = 0; i < env.length; i++) pre[i + 1] = pre[i] + env[i];
    for (let i = w; i < env.length - w; i++) {
      const v = env[i];
      let isMax = true;
      for (let j = i - w; j <= i + w; j++) {
        if (env[j] > v || (env[j] === v && j < i)) {
          isMax = false;
          break;
        }
      }
      if (!isMax) continue;
      const a = Math.max(0, i - avgW);
      const b = Math.min(env.length, i + avgW + 1);
      const mean = (pre[b] - pre[a]) / (b - a);
      if (v > mean * 1.25 + 0.08) peaks.push(i);
    }
    return peaks;
  }

  // ---------- Tempo ----------
  function estimateTempo(env) {
    const minLag = Math.round(60 / 180 / HOP_T);
    const maxLag = Math.round(60 / 70 / HOP_T);
    const n = env.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[i];
    mean /= n || 1;
    const x = Float32Array.from(env, (v) => v - mean);
    const scores = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
      const bpm = 60 / (lag * HOP_T);
      // Gentle preference for common tempos around 120 BPM.
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      scores[lag] = s * w;
    }
    let best = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) if (scores[lag] > scores[best]) best = lag;
    // Parabolic refinement for a fractional lag.
    const y0 = scores[best - 1];
    const y1 = scores[best];
    const y2 = scores[best + 1];
    const denom = y0 - 2 * y1 + y2;
    const lag = best + (denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0);

    // Beat phase: the offset whose beat grid lands on the most energy.
    let bestPhase = 0;
    let bestSum = -Infinity;
    for (let ph = 0; ph < Math.ceil(lag); ph++) {
      let s = 0;
      for (let t = ph; t < n; t += lag) s += env[Math.round(t)] || 0;
      if (s > bestSum) {
        bestSum = s;
        bestPhase = ph;
      }
    }
    const beat = lag * HOP_T;
    return { bpm: 60 / beat, beat, firstBeat: bestPhase * HOP_T + ONSET_DELAY };
  }

  // ---------- Charting ----------
  function buildCharts(feat, envInfo, tempo, duration) {
    const { env } = envInfo;
    const peaks = pickPeaks(env);
    const grid = tempo.beat / 4;
    const onsets = peaks.map((f) => {
      let t = f * HOP_T + ONSET_DELAY;
      // Snap to the sixteenth-note grid when close, so charts feel on-beat.
      const k = Math.round((t - tempo.firstBeat) / grid);
      const snapped = tempo.firstBeat + k * grid;
      if (Math.abs(snapped - t) < 0.035) t = snapped;
      const shares = feat.flux.map((band, b) => band[f] / envInfo.norm[b]);
      let dom = 0;
      for (let b = 1; b < shares.length; b++) if (shares[b] > shares[dom]) dom = b;
      const slot = ((k % 4) + 4) % 4; // 0 = on the beat, 2 = eighth
      return { t: Math.max(0, t), f, strength: env[f], dom, slot, snappedOk: Math.abs(snapped - (f * HOP_T + ONSET_DELAY)) < 0.035 };
    });

    const activeSec = Math.max(10, duration - (onsets.length ? onsets[0].t : 0));
    const charts = {};
    for (const [diff, rule] of Object.entries(DIFF_RULES)) {
      const target = Math.round(rule.perSec * activeSec);
      const ranked = onsets
        .map((o) => {
          let bonus = 1;
          if (o.snappedOk && o.slot === 0) bonus = rule.beatBonus;
          else if (o.snappedOk && o.slot === 2) bonus = rule.eighthBonus;
          return { o, score: o.strength * bonus };
        })
        .sort((a, b) => b.score - a.score || a.o.t - b.o.t);
      const chosen = [];
      for (const { o } of ranked) {
        if (chosen.length >= target) break;
        if (o.t < 0.5 || o.t > duration - 0.3) continue;
        if (chosen.some((c) => Math.abs(c.t - o.t) < rule.minGap)) continue;
        chosen.push(o);
      }
      chosen.sort((a, b) => a.t - b.t);
      charts[diff] = laneChart(chosen, feat.energy, rule, duration);
    }
    return charts;
  }

  function laneChart(chosen, energy, rule, duration) {
    const PAIRS = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const notes = [];
    let prevLane = -1;
    const flips = [0, 0, 0]; // one alternation per band, so every band uses both its lanes
    let run = 0;
    let runDom = -1;
    for (const o of chosen) {
      // A long run of one sound (a kick-only intro) drifts toward the
      // neighbouring lanes for a few notes, so no stretch sits on two lanes.
      run = o.dom === runDom ? run + 1 : 0;
      runDom = o.dom;
      let dom = o.dom;
      if (run >= 4 && run % 8 >= 4) dom = dom === 1 ? (run % 16 >= 8 ? 0 : 2) : 1;
      const [a, b] = PAIRS[dom];
      let lane;
      if (a === prevLane) lane = b;
      else if (b === prevLane) lane = a;
      else lane = flips[dom]++ % 2 ? b : a;
      notes.push({ t: +o.t.toFixed(4), lane, end: null, strength: o.strength, frame: o.f, slot: o.slot, snappedOk: o.snappedOk });
      prevLane = lane;
    }

    // Holds: a long gap after a note while the sound keeps ringing.
    for (let i = 0; i < notes.length - 1; i++) {
      const n = notes[i];
      const gap = notes[i + 1].t - n.t;
      if (gap < 0.6) continue;
      const startF = n.frame + Math.round(0.1 / HOP_T);
      const endF = n.frame + Math.round((gap - 0.15) / HOP_T);
      let sum = 0;
      let cnt = 0;
      for (let f = startF; f < endF && f < energy.length; f++) {
        sum += energy[f];
        cnt++;
      }
      if (cnt && sum / cnt >= 0.6 * energy[n.frame]) n.end = +(n.t + Math.min(gap - 0.15, 2.5)).toFixed(4);
    }

    // Doubles on the strongest downbeats (Hard).
    if (rule.doubles > 0) {
      const strong = notes
        .filter((n) => n.snappedOk && n.slot === 0 && n.end === null)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, Math.round(notes.length * rule.doubles));
      for (const n of strong) {
        const lane = 3 - n.lane;
        const busy = notes.some((m) => m.lane === lane && (Math.abs(m.t - n.t) < rule.minGap || (m.end !== null && m.t <= n.t && m.end >= n.t)));
        if (!busy) notes.push({ t: n.t, lane, end: null });
      }
    }

    return notes
      .filter((n) => n.t < duration)
      .map((n) => ({ t: n.t, lane: n.lane, end: n.end }))
      .sort((a, b) => a.t - b.t || a.lane - b.lane);
  }

  const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

  async function analyze(bytes, onStage) {
    onStage && onStage('Decoding');
    await yieldToUi();
    const { mono, duration } = await decodeMono(bytes);
    if (duration < 15) throw new Error('too_short');
    onStage && onStage('Listening for beats');
    await yieldToUi();
    const feat = features(mono);
    const envInfo = onsetEnvelope(feat);
    onStage && onStage('Finding the tempo');
    await yieldToUi();
    const tempo = estimateTempo(envInfo.env);
    onStage && onStage('Building notes');
    await yieldToUi();
    const charts = buildCharts(feat, envInfo, tempo, duration);
    return { version: ANALYSIS_VERSION, duration, bpm: tempo.bpm, beat: tempo.beat, firstBeat: tempo.firstBeat, charts };
  }

  async function fingerprint(bytes) {
    if (window.crypto && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback (non-secure pages): FNV-1a over the bytes plus length.
    const u8 = new Uint8Array(bytes);
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i += 7) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0;
    return 'f' + h.toString(16) + u8.length.toString(16);
  }

  // ---------- Library (IndexedDB) ----------
  // Two stores: small metadata (title, tempo, charts) and the file bytes.
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('neonpulse-songs', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('meta', { keyPath: 'id' });
          req.result.createObjectStore('files');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function tx(db, stores, mode, fn) {
    return new Promise((resolve) => {
      try {
        const t = db.transaction(stores, mode);
        const out = fn(t);
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : true);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  const memory = { meta: new Map(), files: new Map() }; // used when IndexedDB is unavailable

  async function list() {
    const db = await openDb();
    if (!db) return [...memory.meta.values()].sort((a, b) => b.addedAt - a.addedAt);
    const all = await tx(db, ['meta'], 'readonly', (t) => t.objectStore('meta').getAll());
    return (all || []).filter((m) => m.analysis && m.analysis.version === ANALYSIS_VERSION).sort((a, b) => b.addedAt - a.addedAt);
  }

  async function getBytes(id) {
    const db = await openDb();
    if (!db) return memory.files.get(id) || null;
    return (await tx(db, ['files'], 'readonly', (t) => t.objectStore('files').get(id))) || null;
  }

  async function save(meta, bytes) {
    const db = await openDb();
    if (!db) {
      memory.meta.set(meta.id, meta);
      memory.files.set(meta.id, bytes);
      return true;
    }
    return !!(await tx(db, ['meta', 'files'], 'readwrite', (t) => {
      t.objectStore('meta').put(meta);
      t.objectStore('files').put(bytes, meta.id);
    }));
  }

  async function remove(id) {
    const db = await openDb();
    memory.meta.delete(id);
    memory.files.delete(id);
    if (!db) return true;
    return !!(await tx(db, ['meta', 'files'], 'readwrite', (t) => {
      t.objectStore('meta').delete(id);
      t.objectStore('files').delete(id);
    }));
  }

  return { analyze, fingerprint, list, getBytes, save, remove, ANALYSIS_VERSION };
})();
