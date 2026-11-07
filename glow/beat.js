/* Glow Studio — beat analysis (beat.js) -> window.GlowBeat
 *
 * GlowBeat.analyze(audioBuffer, { start, seconds }) -> Promise<{
 *   bpm,            // tempo of the analysed part (quarter notes per minute, 0 when no beat was found)
 *   beats: [sec],   // beat times
 *   downbeats: [sec], // the first beat of every bar (4/4)
 *   energy: [0..1], // loudness at each beat (same length as beats), 1 = the loud parts of this song
 *   firstDownbeat,  // the first downbeat at or after `start` (null when no beat was found)
 *   confidence      // 0..1, how clearly the song has a steady beat
 * }>
 * All times are seconds from the start of the buffer. `start`/`seconds` limit the analysis to a part of the song
 * (default: all of it, at most 6 minutes).
 *
 * How it works (plain JS, no dependencies, about a quarter of a second for a 3-minute song):
 *  1. mono mix, decimated to about 11 kHz;
 *  2. onset envelope: log-magnitude spectral flux (256-point FFT, 5.8 ms hop) in three bands, weighted the way a
 *     beat is felt: kick/bass most, snare/claps next, hats least;
 *  3. tempo: autocorrelation of the envelope scored with a 4-tap comb (k * period), a broad log-normal tempo prior
 *     around 120 BPM, then folded into 76–170 BPM choosing the octave the data supports best ("tempo octave traps":
 *     a half-time trap groove is still 140, a lo-fi track with eighth-note hats is still 84);
 *  4. beats: dynamic-programming beat tracking (Ellis 2007), refined to sub-frame precision, then two checks:
 *     - phase: the kick is felt on the beat, so when the low band (linear magnitude) hits clearly harder 1/4, 1/2 or
 *       3/4 of a beat later, every beat moves there (four-on-the-floor with an off-beat bass or off-beat open hats:
 *       trance, techno, house, EDM pop would otherwise be tracked on the off-beats);
 *     - slow songs: a 60–75 BPM song is first tracked at double speed (the fold above); when every other tracked beat
 *       is clearly weaker and nothing happens halfway between them, it is halved back (ballads say "about 72", not 144);
 *     the BPM is then fitted to the tracked beats by least squares;
 *  5. downbeats: the bar phase (of 4) with the loudest bass, the most energy and the biggest harmonic change;
 *  6. energy: RMS around each beat, normalised by the song's loud level.
 * Songs that change tempo: analyse the part that is used (start/seconds), not the whole song, to get that part's tempo.
 * Known limits: very busy slow grooves (a 70 BPM rumba with off-beat strums and kicks) stay at double speed, and a
 * sparse half-time groove (kick on 1, snare on 3, nothing in between) reads as half speed; both keep every beat on the
 * song's grid, so cuts stay in time.
 * GlowBeat.grid(bpm, seconds, offset) gives the exact grid of a song whose tempo is known (the built-in tracks).
 */
(function (global) {
  'use strict';

  var N = 256, HALF = N / 2, HOP = 64, TARGET_SR = 11025, MAX_SECONDS = 360;
  var MIN_BPM = 50, MAX_BPM = 220, FOLD_LO = 76, FOLD_HI = 170;

  /* ---------- FFT (radix-2, in place) ---------- */
  var REV = new Uint16Array(N), COS = new Float64Array(HALF), SIN = new Float64Array(HALF), WIN = new Float64Array(N);
  (function () {
    var bits = Math.round(Math.log(N) / Math.LN2);
    for (var i = 0; i < N; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      REV[i] = r;
      WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    }
    for (var k = 0; k < HALF; k++) { COS[k] = Math.cos(2 * Math.PI * k / N); SIN[k] = Math.sin(2 * Math.PI * k / N); }
  })();
  function fft(re, im) {
    for (var i = 0; i < N; i++) {
      var j = REV[i];
      if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var size = 2; size <= N; size <<= 1) {
      var h = size >> 1, step = N / size;
      for (var s = 0; s < N; s += size) {
        for (var q = 0, k = 0; q < h; q++, k += step) {
          var a = s + q, b2 = a + h;
          var tr = re[b2] * COS[k] + im[b2] * SIN[k], ti = im[b2] * COS[k] - re[b2] * SIN[k];
          re[b2] = re[a] - tr; im[b2] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  /* ---------- helpers ---------- */
  function mean(a, from, to) { var s = 0; from = from || 0; to = to == null ? a.length : to; for (var i = from; i < to; i++) s += a[i]; return to > from ? s / (to - from) : 0; }
  function std(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / Math.max(1, a.length)); }
  function median(a) { if (!a.length) return 0; var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); var m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
  function percentile(a, p) { if (!a.length) return 0; var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function interp(a, x) { var i = Math.floor(x), f = x - i; if (i < 0 || i + 1 >= a.length) return i >= 0 && i < a.length ? a[i] : 0; return a[i] * (1 - f) + a[i + 1] * f; }

  // Mono mix of [from, to) samples, decimated by f (box average: crude but enough for onsets below ~5 kHz).
  function monoDecimated(buf, from, to, f) {
    var chs = buf.numberOfChannels || 1, data = [];
    for (var c = 0; c < chs; c++) data.push(buf.getChannelData(c));
    var n = Math.max(0, Math.floor((to - from) / f)), out = new Float32Array(n), k = 1 / (f * chs);
    for (var i = 0, p = from; i < n; i++, p += f) {
      var s = 0;
      for (var c2 = 0; c2 < chs; c2++) { var d = data[c2]; for (var j = 0; j < f; j++) s += d[p + j]; }
      out[i] = s * k;
    }
    return out;
  }

  /* ---------- 1–2: onset envelopes ---------- */
  var BANDS = 16;
  function onsets(x, sr) {
    var T = x.length >= N ? Math.floor((x.length - N) / HOP) + 1 : 0;
    var flux = new Float32Array(T), low = new Float32Array(T), mid = new Float32Array(T), rms = new Float32Array(T), bass = new Float32Array(T);
    var bands = new Float32Array(T * BANDS); // coarse log-spaced spectrum per frame (for harmonic change at downbeats)
    var re = new Float64Array(N), im = new Float64Array(N), prev = new Float64Array(HALF + 1), cur = new Float64Array(HALF + 1);
    var binHz = sr / N, lowTop = Math.max(2, Math.round(180 / binHz)), midTop = Math.round(1800 / binHz); // ~180 Hz: kick and bass; ~1.8 kHz: snare body, claps, chords
    var edges = [];
    for (var q = 0; q <= BANDS; q++) edges.push(Math.min(HALF, Math.max(2, Math.round(Math.exp(Math.log(100 / binHz) + q / BANDS * Math.log((4500 / binHz) / (100 / binHz)))))));
    for (var t = 0; t < T; t++) {
      var o = t * HOP, e = 0;
      for (var n = 0; n < N; n++) { var v = x[o + n]; re[n] = v * WIN[n]; im[n] = 0; e += v * v; }
      rms[t] = Math.sqrt(e / N);
      fft(re, im);
      var fl = 0, lf = 0, mf = 0, be = 0;
      for (var k = 1; k <= HALF; k++) {
        var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]), m = Math.log(1 + 20 * mag);
        cur[k] = m;
        if (k <= lowTop) be += mag * mag;
        var d = m - prev[k];
        if (d > 0) { fl += d; if (k <= lowTop) lf += d; else if (k <= midTop) mf += d; }
      }
      for (var bq = 0; bq < BANDS; bq++) { var sb = 0; for (var kk = edges[bq]; kk < Math.max(edges[bq] + 1, edges[bq + 1]); kk++) sb += cur[kk]; bands[t * BANDS + bq] = sb / Math.max(1, edges[bq + 1] - edges[bq]); }
      flux[t] = t ? fl - lf - mf : 0; low[t] = t ? lf : 0; mid[t] = t ? mf : 0; bass[t] = Math.sqrt(be);
      var sw = prev; prev = cur; cur = sw;
    }
    return { flux: flux, low: low, mid: mid, rms: rms, bass: bass, bands: bands, T: T, fps: sr / HOP };
  }
  // remove the slowly varying part (sustained notes, crescendos) and keep the attacks
  function detrend(a, w) {
    var n = a.length, out = new Float32Array(n), acc = 0, h = Math.max(1, Math.round(w / 2));
    var lo = 0, hi = -1;
    for (var i = 0; i < n; i++) {
      var L = Math.max(0, i - h), R = Math.min(n - 1, i + h);
      while (hi < R) acc += a[++hi];
      while (lo < L) acc -= a[lo++];
      var v = a[i] - acc / (hi - lo + 1);
      out[i] = v > 0 ? v : 0;
    }
    return out;
  }
  function smoothGauss(a, sigma) {
    if (!(sigma > 0.5)) return Float32Array.from(a);
    var r = Math.ceil(sigma * 3), w = new Float64Array(2 * r + 1), s = 0;
    for (var i = -r; i <= r; i++) { w[i + r] = Math.exp(-0.5 * i * i / (sigma * sigma)); s += w[i + r]; }
    for (var j = 0; j < w.length; j++) w[j] /= s;
    var n = a.length, out = new Float32Array(n);
    for (var t = 0; t < n; t++) {
      var v = 0;
      for (var q = -r; q <= r; q++) { var u = t + q; if (u >= 0 && u < n) v += a[u] * w[q + r]; }
      out[t] = v;
    }
    return out;
  }

  /* ---------- 3: tempo ---------- */
  function autocorr(o, maxLag) {
    var n = o.length, m = mean(o), x = new Float64Array(n);
    for (var i = 0; i < n; i++) x[i] = o[i] - m;
    var ac = new Float64Array(maxLag + 1);
    for (var L = 0; L <= maxLag && L < n; L++) {
      var s = 0, lim = n - L;
      for (var t = 0; t < lim; t++) s += x[t] * x[t + L];
      ac[L] = s / lim;
    }
    if (ac[0] > 0) for (var j = maxLag; j >= 0; j--) ac[j] /= ac[0];
    return ac;
  }
  var COMB = [1, 0.75, 0.55, 0.4];
  function combScore(ac, lag) {
    var s = 0;
    for (var k = 1; k <= COMB.length; k++) { var x = k * lag; if (x >= ac.length - 1) break; s += COMB[k - 1] * Math.max(0, interp(ac, x)); }
    return s;
  }
  function prior(bpm) { var l = Math.log(bpm / 120) / Math.LN2; return Math.exp(-0.5 * l * l / (1.1 * 1.1)); }
  function bestNear(ac, fps, bpm, span) {
    var best = bpm, bs = -1;
    for (var b = bpm * (1 - span); b <= bpm * (1 + span); b += 0.25) {
      var s = combScore(ac, 60 * fps / b);
      if (s > bs) { bs = s; best = b; }
    }
    return { bpm: best, score: bs };
  }
  function tempo(o, fps) {
    var maxLag = Math.min(o.length - 2, Math.ceil(60 * fps / MIN_BPM * COMB.length) + 2);
    if (maxLag < 8) return { bpm: 0, conf: 0 };
    var ac = autocorr(o, maxLag);
    var best = 0, bs = -1, scores = [];
    for (var b = MIN_BPM; b <= MAX_BPM; b += 0.5) {
      var s = combScore(ac, 60 * fps / b);
      scores.push(s);
      var w = s * prior(b);
      if (w > bs) { bs = w; best = b; }
    }
    if (!(bs > 0)) return { bpm: 0, conf: 0 };
    // octave choice inside the folding range: the candidate the comb (data) supports best, the prior only breaks ties
    var cands = [];
    for (var k = -3; k <= 3; k++) { var c = best * Math.pow(2, k); if (c >= FOLD_LO && c < FOLD_HI) cands.push(c); }
    if (!cands.length) cands.push(best);
    var pick = null;
    cands.forEach(function (c) {
      var r = bestNear(ac, fps, c, 0.03);
      r.w = r.score * Math.pow(prior(r.bpm), 0.35);
      if (!pick || r.w > pick.w) pick = r;
    });
    var mx = 0; scores.forEach(function (s) { if (s > mx) mx = s; });
    var conf = Math.max(0, Math.min(1, (pick.score / (mean(scores) || 1) - 1) / 3));
    return { bpm: pick.bpm, conf: conf, ac: ac };
  }

  /* ---------- 4: beat tracking ---------- */
  function track(o, period) {
    var n = o.length;
    if (!(period > 2) || n < period * 2) return [];
    var sd = std(o) || 1;
    var local = smoothGauss(o, period / 32);
    for (var i = 0; i < n; i++) local[i] /= sd;
    var cum = new Float64Array(n), back = new Int32Array(n), tight = 100;
    var pMin = Math.round(period / 2), pMax = Math.round(period * 2);
    for (var t = 0; t < n; t++) {
      var best = -Infinity, arg = -1;
      for (var p = t - pMax; p <= t - pMin; p++) {
        if (p < 0) continue;
        var l = Math.log((t - p) / period), sc = cum[p] - tight * l * l;
        if (sc > best) { best = sc; arg = p; }
      }
      cum[t] = local[t] + (arg >= 0 && best > 0 ? best : 0);
      back[t] = arg >= 0 && best > 0 ? arg : -1;
    }
    // the last beat: the best total score in the final period
    var end = -1, es = -Infinity;
    for (var e = Math.max(0, n - Math.round(period * 1.2)); e < n; e++) if (cum[e] > es) { es = cum[e]; end = e; }
    var beats = [];
    for (var b = end; b >= 0; b = back[b]) beats.push(b);
    beats.reverse();
    // drop weak beats at the edges (silence before the song starts / after it ends)
    var thr = 0.3 * (median(beats.map(function (x) { return local[x]; })) || 0);
    while (beats.length && local[beats[0]] < thr) beats.shift();
    while (beats.length && local[beats[beats.length - 1]] < thr) beats.pop();
    // sub-frame position: parabola through the smoothed envelope around each beat
    return beats.map(function (f) {
      var a = local[f - 1], c = local[f], d = local[f + 1];
      if (a == null || d == null) return f;
      var den = a - 2 * c + d;
      var off = den < 0 ? 0.5 * (a - d) / den : 0;
      return f + Math.max(-0.5, Math.min(0.5, off));
    });
  }
  /* ---------- 4b: beat phase check ---------- */
  // The tracker follows the strongest onsets. In four-on-the-floor dance music with an off-beat bass or off-beat open
  // hats (trance, techno, house, EDM pop) those sit between the kicks, so every beat would land half (or a quarter) of a
  // beat late. The kick is felt on the beat: compare how hard the low band rises (linear magnitude, so a loud kick
  // outweighs a quieter bass's many harmonics) at the tracked beats and at the same beats moved by 1/4, 1/2 and 3/4 of a
  // beat, and move them only when a moved set clearly hits harder, beat after beat.
  function lowRise(bass) {
    var n = bass.length, r = new Float32Array(n);
    for (var t = 3; t < n; t++) { var d = bass[t] - Math.min(bass[t - 1], bass[t - 2], bass[t - 3]); r[t] = d > 0 ? d : 0; }
    return r;
  }
  function peakIn(a, from, to) { var m = 0; for (var q = Math.max(0, Math.floor(from)); q <= Math.min(a.length - 1, Math.ceil(to)); q++) if (a[q] > m) m = a[q]; return m; }
  function phaseCheck(frames, o, bass, period, fps) {
    var n = frames.length;
    if (n < 8) return { frames: frames, shift: 0 };
    var rise = lowRise(bass), w = Math.max(2, Math.round(0.03 * fps));
    var iv = frames.map(function (f, k) { return k + 1 < n ? frames[k + 1] - f : (k ? f - frames[k - 1] : period); });
    var SH = [0, 0.25, 0.5, 0.75], at = [], S = [];
    SH.forEach(function (s) {
      var v = frames.map(function (f, k) { var g = f + s * iv[k]; return peakIn(rise, g - w, g + w); });
      at.push(v); S.push(mean(v));
    });
    var best = 0;
    for (var j = 1; j < SH.length; j++) {
      var wins = 0;
      for (var k = 0; k < n; k++) if (at[j][k] > 1.2 * at[0][k] + 1e-9) wins++;
      if (S[j] > 1.5 * S[0] && wins >= 0.6 * n && (!best || S[j] > S[best])) best = j;
    }
    if (!best) return { frames: frames, shift: 0 };
    // move every beat, then put it on the nearest onset peak (sub-frame, like the tracker does)
    var sm = smoothGauss(o, period / 32), s0 = SH[best], out = [];
    var first = frames[0] + s0 * iv[0] - iv[0];
    if (first >= w && peakIn(rise, first - w, first + w) >= 0.5 * median(at[best])) out.push(first);
    frames.forEach(function (f, k) { out.push(f + s0 * iv[k]); });
    return {
      shift: s0,
      frames: out.filter(function (g) { return g >= 1 && g < sm.length - 2; }).map(function (g) {
        var a = Math.max(1, Math.round(g - w)), b = Math.min(sm.length - 2, Math.round(g + w)), arg = -1, mx = 0;
        for (var q = a; q <= b; q++) if (sm[q] > mx && sm[q] >= sm[q - 1] && sm[q] >= sm[q + 1]) { mx = sm[q]; arg = q; }
        if (arg < 0) return g;
        var p0 = sm[arg - 1], c = sm[arg], p1 = sm[arg + 1], den = p0 - 2 * c + p1;
        return arg + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (p0 - p1) / den)) : 0);
      })
    };
  }
  // Slow songs: the tempo is folded into 76–170 BPM (above), so a 60–75 BPM ballad is first tracked at double speed,
  // every other "beat" being the "and" between two real beats. Halve it when the tracked beats clearly alternate
  // strong/weak AND nothing happens halfway between them: a real fast song keeps its in-between busy (8th/16th hats in
  // a half-time trap groove) or its weak beats strong (kick/snare). Returns the beats to keep, or null.
  function slowCheck(frames, o, period, fps, bpm) {
    var n = frames.length;
    if (!(bpm >= 112 && bpm < 2 * FOLD_LO) || n < 16) return null;
    var sm = smoothGauss(o, period / 32), w = Math.max(2, Math.round(0.03 * fps));
    var at = frames.map(function (f) { return peakIn(sm, f - w, f + w); });
    var mid = frames.map(function (f, k) { var iv = k + 1 < n ? frames[k + 1] - f : f - frames[k - 1]; return peakIn(sm, f + iv / 2 - w, f + iv / 2 + w); });
    var e = [0, 0], c = [0, 0];
    for (var k = 0; k < n; k++) { e[k % 2] += at[k]; c[k % 2]++; }
    var ph = e[0] / c[0] >= e[1] / c[1] ? 0 : 1, strong = e[ph] / c[ph], weak = e[1 - ph] / c[1 - ph];
    var wins = 0, pairs = 0;
    for (var j = ph; j < n; j += 2) {
      var nb = Math.max(j > 0 ? at[j - 1] : 0, j + 1 < n ? at[j + 1] : 0);
      pairs++; if (at[j] > 1.25 * nb) wins++;
    }
    if (!(strong >= 1.6 * weak && wins >= 0.6 * pairs && mean(mid) <= 1.2 * weak)) return null;
    return frames.filter(function (f, k) { return k % 2 === ph; });
  }
  // tempo from the tracked beats (least squares over the longest steady run)
  function fitBpm(times, fallback) {
    if (times.length < 4) return fallback;
    var iois = [];
    for (var i = 1; i < times.length; i++) iois.push(times[i] - times[i - 1]);
    var m = median(iois);
    var run = [0];
    var runs = [];
    for (var j = 1; j < times.length; j++) {
      if (Math.abs(iois[j - 1] - m) < 0.12 * m) run.push(j);
      else { runs.push(run); run = [j]; }
    }
    runs.push(run);
    runs.sort(function (a, b) { return b.length - a.length; });
    var r = runs[0];
    if (r.length < 4) return 60 / m;
    var n = r.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    r.forEach(function (idx, k) { var y = times[idx]; sx += k; sy += y; sxx += k * k; sxy += k * y; });
    var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return slope > 0 ? 60 / slope : 60 / m;
  }

  /* ---------- analyze ---------- */
  function analyzeSync(buf, opts) {
    opts = opts || {};
    var sr = buf.sampleRate, dur = buf.length / sr;
    var start = Math.max(0, Math.min(dur, +opts.start || 0));
    var seconds = opts.seconds > 0 ? +opts.seconds : dur - start;
    seconds = Math.max(0, Math.min(seconds, dur - start, MAX_SECONDS));
    var f = Math.max(1, Math.round(sr / TARGET_SR)), srD = sr / f;
    var from = Math.floor(start * sr), to = Math.min(buf.length, Math.floor((start + seconds) * sr));
    var empty = { bpm: 0, beats: [], downbeats: [], energy: [], firstDownbeat: null, confidence: 0, start: r3(start), seconds: r3(seconds) };
    if (to - from < sr * 2) return empty;
    var x = monoDecimated(buf, from, to, f);
    var on = onsets(x, srD), fps = on.fps;
    var peak = 0; for (var i = 0; i < on.rms.length; i++) if (on.rms[i] > peak) peak = on.rms[i];
    if (!(peak > 1e-4)) return empty;
    var W = Math.round(fps * 0.3);
    var hiO = detrend(on.flux, W), lowO = detrend(on.low, W), midO = detrend(on.mid, W);
    // the beat is felt in the kick/bass and the snare/claps more than in the hats: weight the bands accordingly
    var hs = std(hiO) || 1, ls = std(lowO) || 1, ms = std(midO) || 1, o = new Float32Array(hiO.length);
    for (var oi = 0; oi < o.length; oi++) o[oi] = 1.3 * lowO[oi] / ls + 1.0 * midO[oi] / ms + 0.45 * hiO[oi] / hs;
    var tp = tempo(o, fps);
    if (!(tp.bpm > 0)) return empty;
    var period = 60 * fps / tp.bpm;
    var frames = track(o, period);
    if (frames.length < 2) return empty;
    frames = phaseCheck(frames, o, on.bass, period, fps).frames;
    var tempoBpm = tp.bpm, slow = slowCheck(frames, o, period, fps, tempoBpm);
    if (slow) { frames = slow; tempoBpm /= 2; period *= 2; }
    // frame t covers samples [t*HOP, t*HOP+N): an attack shows in the flux about when it reaches the window's middle
    var LAT = (N / 2 - HOP * 0.25) / srD;
    var times = frames.map(function (fr) { return start + fr * HOP / srD + LAT; });
    var bpm = fitBpm(times, tempoBpm);
    if (!(bpm > 0) || Math.abs(bpm / tempoBpm - 1) > 0.08) bpm = tempoBpm;
    // energy at each beat
    var en = frames.map(function (fr) {
      var a = Math.max(0, Math.round(fr - 0.03 * fps)), b = Math.min(on.rms.length, Math.round(fr + 0.12 * fps));
      var s = 0, c = 0;
      for (var q = a; q < b; q++) { s += on.rms[q] * on.rms[q]; c++; }
      return c ? Math.sqrt(s / c) : 0;
    });
    var loud = percentile(en, 0.9) || 1;
    var energy = en.map(function (v) { return Math.max(0, Math.min(1, v / loud)); });
    // downbeat phase: where the bass is loud and the harmony changes (bar starts), plus loudness
    var bassAt = frames.map(function (fr) {
      var a = Math.max(0, Math.round(fr)), b = Math.min(on.bass.length, Math.round(fr + 0.1 * fps)), mx = 0;
      for (var q = a; q < b; q++) if (on.bass[q] > mx) mx = on.bass[q];
      return mx;
    });
    var bassRef = percentile(bassAt, 0.9) || 1;
    var spec = frames.map(function (fr, k) { // mean coarse spectrum from this beat to the next
      var a = Math.max(0, Math.round(fr)), b = Math.min(on.T, Math.round(k + 1 < frames.length ? frames[k + 1] : fr + period));
      var v = new Float64Array(BANDS), c = 0;
      for (var q = a; q < b; q++, c++) for (var z = 0; z < BANDS; z++) v[z] += on.bands[q * BANDS + z];
      if (c) for (var z2 = 0; z2 < BANDS; z2++) v[z2] /= c;
      return v;
    });
    var nov = spec.map(function (v, k) {
      if (!k) return 0;
      var s = 0, p = spec[k - 1];
      for (var z = 0; z < BANDS; z++) s += Math.abs(v[z] - p[z]);
      return s;
    });
    var novRef = percentile(nov, 0.9) || 1;
    var feat = frames.map(function (fr, k) {
      var f2 = Math.min(1.5, bassAt[k] / bassRef) + 0.7 * energy[k] + 0.9 * Math.min(1.5, nov[k] / novRef);
      return f2;
    });
    var phase = 0, ps = -Infinity;
    for (var ph = 0; ph < 4; ph++) {
      var s2 = 0, c2 = 0;
      for (var w = ph; w < feat.length; w += 4) { s2 += feat[w]; c2++; }
      s2 = c2 ? s2 / c2 : 0;
      if (s2 > ps) { ps = s2; phase = ph; }
    }
    var beats = times.map(r3), downbeats = [];
    for (var d = phase; d < beats.length; d += 4) downbeats.push(beats[d]);
    var firstDown = null;
    for (var y = 0; y < downbeats.length; y++) if (downbeats[y] >= start - 1e-6) { firstDown = downbeats[y]; break; }
    return {
      bpm: Math.round(bpm * 10) / 10, beats: beats, downbeats: downbeats, energy: energy.map(function (v) { return Math.round(v * 100) / 100; }),
      firstDownbeat: firstDown, confidence: Math.round(tp.conf * 100) / 100, start: r3(start), seconds: r3(seconds)
    };
  }
  function analyze(buf, opts) {
    return new Promise(function (resolve, reject) {
      if (!buf || typeof buf.getChannelData !== 'function' || !(buf.sampleRate > 0)) { reject(new TypeError('GlowBeat.analyze needs an AudioBuffer')); return; }
      setTimeout(function () { try { resolve(analyzeSync(buf, opts)); } catch (e) { reject(e); } }, 0);
    });
  }
  // A beat grid for a song whose tempo is known (built-in tracks: beat k lands exactly on k * 60 / bpm).
  function grid(bpm, seconds, offset) {
    var b = 60 / bpm, beats = [], downbeats = [], energy = [];
    offset = offset || 0;
    for (var t = offset, k = 0; t < offset + seconds - 1e-6; t += b, k++) { beats.push(r3(t)); energy.push(k % 4 === 0 ? 1 : k % 2 === 0 ? 0.8 : 0.65); if (k % 4 === 0) downbeats.push(r3(t)); }
    return { bpm: bpm, beats: beats, downbeats: downbeats, energy: energy, firstDownbeat: beats.length ? beats[0] : null, confidence: 1, start: offset, seconds: seconds };
  }

  global.GlowBeat = { version: '1.1.0', analyze: analyze, analyzeSync: analyzeSync, grid: grid };
})(window);
