/* Glow Studio - templates.js
 * window.GlowFX: built-in visual templates, the frame renderer and procedural demo photos.
 * All work happens on-device with Canvas 2D. Expensive work (pixel grading, bloom, halftone,
 * cards, textures) is done once in createScene(); render(ctx, t, text) only uses drawImage,
 * gradients, composite modes and the cached canvases, and is a pure function of t.
 */
(function () {
  'use strict';

  /* ======================================================================
   * 1. Small helper library
   * ==================================================================== */
  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sat(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(a, b, x) { var t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function fract(x) { return x - Math.floor(x); }

  var E = {
    inQuad: function (t) { return t * t; },
    outQuad: function (t) { return t * (2 - t); },
    inCubic: function (t) { return t * t * t; },
    outCubic: function (t) { var u = 1 - t; return 1 - u * u * u; },
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outQuart: function (t) { var u = 1 - t; return 1 - u * u * u * u; },
    inOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    outExpo: function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    outBack: function (t) { var c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; }
  };

  // integer hash -> [0,1). Deterministic "random" as a pure function of (index, salt).
  function hash(a, b) {
    var h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function hs(a, b) { return hash(a, b) * 2 - 1; } // [-1,1)
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function vnoise(x, seed) { // smooth 1D value noise [-1,1]
    var i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return lerp(hash(i, seed), hash(i + 1, seed), u) * 2 - 1;
  }
  function fbm(x, seed, oct) {
    var s = 0, a = 0.5, f = 1, n = 0;
    for (var i = 0; i < (oct || 4); i++) { s += a * vnoise(x * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }

  function hexRGB(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var RGBA_CACHE = {};
  function rgba(hex, a) {
    var c = RGBA_CACHE[hex] || (RGBA_CACHE[hex] = hexRGB(hex));
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a < 0 ? 0 : a > 1 ? 1 : +a.toFixed(4)) + ')';
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------- canvases ---------- */
  function mk(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }
  function cx(c) { return c.getContext('2d'); }
  function free(c) { if (c && c.width > 1) { c.width = 1; c.height = 1; } }
  function dims(img) { return [img.naturalWidth || img.videoWidth || img.width || 1, img.naturalHeight || img.videoHeight || img.height || 1]; }

  // high quality resize with stepwise halving for large reductions
  function resize(src, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    var d = dims(src), cur = src, cw = d[0], ch = d[1];
    while (cw > w * 2.2 && ch > h * 2.2) {
      var nw = Math.round(cw / 2), nh = Math.round(ch / 2), t = mk(nw, nh), tx = cx(t);
      tx.imageSmoothingQuality = 'high'; tx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      if (cur !== src) free(cur);
      cur = t; cw = nw; ch = nh;
    }
    var out = mk(w, h), o = cx(out);
    o.imageSmoothingQuality = 'high'; o.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
    if (cur !== src) free(cur);
    return out;
  }

  // cover-fit crop of any image to w x h, focus point fx/fy (0.5/0.42 = slightly above center)
  function coverCrop(img, w, h, fx, fy) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    var d = dims(img), iw = d[0], ih = d[1];
    var s = Math.max(w / iw, h / ih), sw = Math.min(iw, w / s), sh = Math.min(ih, h / s);
    var sx = (iw - sw) * (fx == null ? 0.5 : fx), sy = (ih - sh) * (fy == null ? 0.42 : fy);
    var cur = img;
    while (sw > w * 2.2 && sh > h * 2.2) {
      var nw = Math.round(sw / 2), nh = Math.round(sh / 2), t = mk(nw, nh), tx = cx(t);
      tx.imageSmoothingQuality = 'high'; tx.drawImage(cur, sx, sy, sw, sh, 0, 0, nw, nh);
      if (cur !== img) free(cur);
      cur = t; sx = 0; sy = 0; sw = nw; sh = nh;
    }
    var out = mk(w, h), o = cx(out);
    o.fillStyle = '#000'; o.fillRect(0, 0, w, h);
    o.imageSmoothingQuality = 'high'; o.drawImage(cur, sx, sy, sw, sh, 0, 0, w, h);
    if (cur !== img) free(cur);
    return out;
  }

  /* ---------- pixel grading (prepare time only) ---------- */
  function lumaOf(hex) { var c = hexRGB(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function chroma(hex, amt) { var c = hexRGB(hex), l = lumaOf(hex); return [(c[0] - l) * amt, (c[1] - l) * amt, (c[2] - l) * amt]; }
  function mapLUT(stops) { // gradient map: [[pos, hex], ...] -> Float32Array(256*3)
    var lut = new Float32Array(768), cs = stops.map(function (s) { return [s[0], hexRGB(s[1])]; });
    for (var i = 0; i < 256; i++) {
      var v = i / 255, j = 0;
      while (j < cs.length - 2 && v > cs[j + 1][0]) j++;
      var a = cs[j], b = cs[j + 1], f = sat((v - a[0]) / Math.max(1e-6, b[0] - a[0]));
      f = f * f * (3 - 2 * f);
      for (var k = 0; k < 3; k++) lut[i * 3 + k] = lerp(a[1][k], b[1][k], f);
    }
    return lut;
  }
  function toneLUT(o, mul) {
    var lut = new Float32Array(256);
    var con = o.contrast == null ? 1 : o.contrast, lift = o.lift || 0, gain = o.gain == null ? 1 : o.gain;
    var gam = o.gamma || 1, curve = o.curve || 0, fade = o.fade || 0;
    for (var i = 0; i < 256; i++) {
      var v = i / 255 * mul;
      if (v > 0.78) v = 0.78 + 0.22 * Math.tanh((v - 0.78) / 0.22); // soft highlight shoulder
      v = Math.pow(sat(v), 1 / gam);
      v = (v - 0.5) * con + 0.5;
      if (curve) { var s = sat(v); v = lerp(v, s * s * (3 - 2 * s), curve); }
      v = lift + v * (gain - lift);
      if (fade) v = fade * 0.75 + v * (1 - fade * 1.25);
      lut[i] = sat(v) * 255;
    }
    return lut;
  }
  // in-place grade of an opaque canvas
  function grade(c, o, after) {
    var w = c.width, h = c.height, x = cx(c), id = x.getImageData(0, 0, w, h), d = id.data;
    var ex = o.exposure == null ? 1 : o.exposure, temp = o.temp || 0, tint = o.tint || 0;
    if (o.auto !== false) { // gentle auto-exposure so bright daylight photos don't blow out and dark ones lift
      var sum = 0, cnt = 0;
      for (var j = 0; j < d.length; j += 64) { sum += 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]; cnt++; }
      var avg = sum / Math.max(1, cnt) / 255;
      if (avg > 0.48) ex *= 1 - (avg - 0.48) * (o.autoK || 0.5); else if (avg < 0.2) ex *= 1 + (0.2 - avg) * 1.1;
    }
    var LR = toneLUT(o, ex * (1 + temp * 0.13 + tint * 0.05));
    var LG = toneLUT(o, ex * (1 + temp * 0.02 - tint * 0.09));
    var LB = toneLUT(o, ex * (1 - temp * 0.16 + tint * 0.05));
    var sa = o.sat == null ? 1 : o.sat, vib = o.vib || 0, doSat = sa !== 1 || vib, skin = o.skin || 0;
    var sh = o.shadows ? chroma(o.shadows, o.shAmt == null ? 0.5 : o.shAmt) : null;
    var hi = o.highlights ? chroma(o.highlights, o.hiAmt == null ? 0.4 : o.hiAmt) : null;
    var map = o.map ? mapLUT(o.map) : null, mA = o.mapAmt == null ? 1 : o.mapAmt;
    var post = o.posterize || 0, pq = post ? (post - 1) / 255 : 0;
    var pastel = o.pastel || 0;
    // clarity (local midtone contrast): coarse blurred luma grid, bilinearly sampled per pixel
    var cl = o.clarity || 0, CG = null, cgw = 0, cgh = 0, cf = 1, gyA = 0, gyB = 0, gyF = 0;
    if (cl) {
      cf = Math.max(3, Math.round(Math.min(w, h) / 40));
      cgw = Math.ceil(w / cf); cgh = Math.ceil(h / cf);
      var acc = new Float32Array(cgw * cgh), cnt2 = new Float32Array(cgw * cgh), yy2, xx2;
      for (yy2 = 0; yy2 < h; yy2 += 2) for (xx2 = 0; xx2 < w; xx2 += 2) {
        var q0 = (yy2 * w + xx2) * 4, gi = ((yy2 / cf) | 0) * cgw + ((xx2 / cf) | 0);
        acc[gi] += 0.2126 * d[q0] + 0.7152 * d[q0 + 1] + 0.0722 * d[q0 + 2]; cnt2[gi]++;
      }
      for (var q1 = 0; q1 < acc.length; q1++) acc[q1] /= Math.max(1, cnt2[q1]);
      var tmpG = new Float32Array(acc.length);
      for (var ps = 0; ps < 3; ps++) { // 3x3 box blur passes on the grid
        for (yy2 = 0; yy2 < cgh; yy2++) for (xx2 = 0; xx2 < cgw; xx2++) {
          var sA = 0, nA = 0;
          for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
            var X2 = xx2 + ox, Y2 = yy2 + oy;
            if (X2 >= 0 && Y2 >= 0 && X2 < cgw && Y2 < cgh) { sA += acc[Y2 * cgw + X2]; nA++; }
          }
          tmpG[yy2 * cgw + xx2] = sA / nA;
        }
        var sw0 = acc; acc = tmpG; tmpG = sw0;
      }
      CG = acc;
      var CXA = new Int32Array(w), CXB = new Int32Array(w), CXF = new Float32Array(w);
      for (var c0 = 0; c0 < w; c0++) { var gv = clamp(c0 / cf - 0.5, 0, cgw - 1); CXA[c0] = gv | 0; CXB[c0] = Math.min(cgw - 1, (gv | 0) + 1); CXF[c0] = gv - (gv | 0); }
      var rowA = 0, rowB = 0, px0 = 0;
    }
    for (var i = 0, n = d.length; i < n; i += 4) {
      var r = LR[d[i]], g = LG[d[i + 1]], b = LB[d[i + 2]];
      if (CG) {
        if (px0 === 0) { var gyv = clamp(((i >> 2) / w) / cf - 0.5, 0, cgh - 1); gyA = gyv | 0; gyB = Math.min(cgh - 1, gyA + 1); gyF = gyv - gyA; rowA = gyA * cgw; rowB = gyB * cgw; }
        var gxA = CXA[px0], gxB = CXB[px0], gxF = CXF[px0];
        if (++px0 === w) px0 = 0;
        var t0 = CG[rowA + gxA] + (CG[rowA + gxB] - CG[rowA + gxA]) * gxF, t1 = CG[rowB + gxA] + (CG[rowB + gxB] - CG[rowB + gxA]) * gxF;
        var bl = t0 + (t1 - t0) * gyF;
        var l0 = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2], mw = l0 / 127.5 - 1;
        var dl = (l0 - bl) * cl * (1 - mw * mw * 0.85);
        r += dl; g += dl; b += dl;
      }
      var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (doSat) {
        var s = sa;
        if (vib) { var mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b); var un = 1 - (mx - mn) / 255; s *= 1 + vib * un * un; }
        if (skin && r > g && g > b) { // keep skin tones natural: fade the saturation change out around orange hues
          var hu = (g - b) / (r - b + 1e-3), sw2 = sat(1 - Math.abs(hu - 0.42) / 0.3) * sat((r - b) / 60);
          s = 1 + (s - 1) * (1 - skin * sw2);
        }
        r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
      }
      if (sh || hi) {
        var ln = l / 255;
        if (sh) { var sw = (1 - ln) * (1 - ln); r += sh[0] * sw; g += sh[1] * sw; b += sh[2] * sw; }
        if (hi) { var hw = ln * ln; r += hi[0] * hw; g += hi[1] * hw; b += hi[2] * hw; }
      }
      if (map) {
        var li = l < 0 ? 0 : l > 255 ? 255 : l | 0, mi = li * 3;
        r += (map[mi] - r) * mA; g += (map[mi + 1] - g) * mA; b += (map[mi + 2] - b) * mA;
      }
      if (pastel) { r += (255 - r) * pastel; g += (255 - g) * pastel; b += (255 - b) * pastel; }
      if (post) {
        r = Math.round(sat(r / 255) * (post - 1)) / pq; g = Math.round(sat(g / 255) * (post - 1)) / pq; b = Math.round(sat(b / 255) * (post - 1)) / pq;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    if (typeof after === 'function') after(d, w, h);
    x.putImageData(id, 0, 0);
    return c;
  }

  // separable box blur on RGBA data (small images only)
  function boxBlur(d, w, h, r, passes) {
    if (r < 1) return;
    var n = w * h, ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], tmp = new Float32Array(Math.max(w, h));
    for (var i = 0; i < n; i++) { ch[0][i] = d[i * 4]; ch[1][i] = d[i * 4 + 1]; ch[2][i] = d[i * 4 + 2]; }
    function pass(a, off, stride, len) {
      var inv = 1 / (2 * r + 1), acc = 0, k;
      for (k = -r; k <= r; k++) acc += a[off + clamp(k, 0, len - 1) * stride];
      for (k = 0; k < len; k++) {
        tmp[k] = acc * inv;
        acc += a[off + Math.min(len - 1, k + r + 1) * stride] - a[off + Math.max(0, k - r) * stride];
      }
      for (k = 0; k < len; k++) a[off + k * stride] = tmp[k];
    }
    for (var p = 0; p < (passes || 3); p++) {
      for (var c = 0; c < 3; c++) {
        var a = ch[c], y, x;
        for (y = 0; y < h; y++) pass(a, y * w, 1, w);
        for (x = 0; x < w; x++) pass(a, x, w, h);
      }
    }
    for (i = 0; i < n; i++) { d[i * 4] = ch[0][i]; d[i * 4 + 1] = ch[1][i]; d[i * 4 + 2] = ch[2][i]; }
  }

  // baked bloom / soft glow: threshold -> blur at low res -> upscale composite
  function bloom(c, o) {
    var w = c.width, h = c.height, f = o.scale || 10;
    var sw = Math.max(6, Math.round(w / f)), sh = Math.max(6, Math.round(h / f));
    var s = resize(c, sw, sh), sx = cx(s), id = sx.getImageData(0, 0, sw, sh), d = id.data;
    var thr = o.thr == null ? 0.6 : o.thr, amt = o.amt == null ? 0.5 : o.amt, i, sum = 0;
    for (i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    var avg = sum / (d.length / 4) / 255; // adapt to bright photos: higher threshold, less glow
    thr = Math.max(thr, Math.min(0.86, avg + 0.24)); amt *= 1 - 0.5 * smooth(0.38, 0.7, avg);
    var k = 1 / Math.max(0.02, 1 - thr);
    var tint = o.tint ? hexRGB(o.tint) : null, ta = o.tintAmt || 0;
    for (i = 0; i < d.length; i += 4) {
      var l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      var m = sat((l - thr) * k); m = m * m * (3 - 2 * m);
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (tint) { r = lerp(r, tint[0], ta); g = lerp(g, tint[1], ta); b = lerp(b, tint[2], ta); }
      d[i] = r * m; d[i + 1] = g * m; d[i + 2] = b * m;
    }
    boxBlur(d, sw, sh, o.rad || 2, 3);
    sx.putImageData(id, 0, 0);
    var up = resize(s, w / 2, h / 2), x = cx(c);
    x.save(); x.globalCompositeOperation = o.mode || 'screen'; x.globalAlpha = amt;
    x.imageSmoothingQuality = 'high'; x.drawImage(up, 0, 0, w, h); x.restore();
    free(s); free(up);
    return c;
  }

  function vignette(c, amt, color, inner) {
    var w = c.width, h = c.height, x = cx(c);
    x.save(); x.translate(w / 2, h / 2); x.scale(w / 2, h / 2);
    var g = x.createRadialGradient(0, 0, inner == null ? 0.5 : inner, 0, 0, 1.45);
    g.addColorStop(0, rgba(color || '#000000', 0)); g.addColorStop(1, rgba(color || '#000000', amt));
    x.fillStyle = g; x.fillRect(-1, -1, 2, 2); x.restore();
    return c;
  }
  function edgeGrad(c, top, bottom, color) { // darken top/bottom for text legibility
    var w = c.width, h = c.height, x = cx(c), g;
    if (top) { g = x.createLinearGradient(0, 0, 0, h * 0.42); g.addColorStop(0, rgba(color || '#000000', top)); g.addColorStop(1, rgba(color || '#000000', 0)); x.fillStyle = g; x.fillRect(0, 0, w, h * 0.42); }
    if (bottom) { g = x.createLinearGradient(0, h, 0, h * 0.55); g.addColorStop(0, rgba(color || '#000000', bottom)); g.addColorStop(1, rgba(color || '#000000', 0)); x.fillStyle = g; x.fillRect(0, h * 0.55, w, h * 0.45); }
  }

  // split into red-only and cyan(g+b)-only copies for cheap RGB split: R + GB ('lighter') = image
  function rgbSplit(c, scale) {
    var r = resize(c, c.width * scale, c.height * scale), gb = mk(r.width, r.height), gx = cx(gb), rx = cx(r);
    gx.drawImage(r, 0, 0);
    rx.globalCompositeOperation = 'multiply'; rx.fillStyle = '#ff0000'; rx.fillRect(0, 0, r.width, r.height); rx.globalCompositeOperation = 'source-over';
    gx.globalCompositeOperation = 'multiply'; gx.fillStyle = '#00ffff'; gx.fillRect(0, 0, r.width, r.height); gx.globalCompositeOperation = 'source-over';
    return { r: r, gb: gb };
  }

  // bright spots of an image (normalized coords) for sparkles that sit on highlights
  function glints(c, k, seed) {
    var gw = 40, gh = Math.max(8, Math.round(40 * c.height / c.width));
    var s = resize(c, gw, gh), d = cx(s).getImageData(0, 0, gw, gh).data; free(s);
    var L = new Float32Array(gw * gh), i, x, y;
    for (i = 0; i < gw * gh; i++) L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    var cand = [];
    for (y = 1; y < gh - 1; y++) for (x = 1; x < gw - 1; x++) {
      var v = L[y * gw + x];
      if (v < 150) continue;
      var ok = true;
      for (var dy = -1; dy <= 1 && ok; dy++) for (var dx = -1; dx <= 1; dx++) if ((dx || dy) && L[(y + dy) * gw + x + dx] > v) { ok = false; break; }
      if (ok) cand.push([v, x, y]);
    }
    cand.sort(function (a, b) { return b[0] - a[0]; });
    var out = [];
    for (i = 0; i < cand.length && out.length < k; i++) {
      var u = (cand[i][1] + 0.5) / gw, w = (cand[i][2] + 0.5) / gh, far = true;
      for (var j = 0; j < out.length; j++) if (Math.abs(out[j].u - u) + Math.abs(out[j].v - w) < 0.09) { far = false; break; }
      if (far) out.push({ u: u, v: w, s: 0.65 + 0.35 * (cand[i][0] - 150) / 105 });
    }
    var R = mulberry32(seed * 131 + 7);
    while (out.length < k) out.push({ u: 0.08 + 0.84 * R(), v: 0.06 + 0.8 * R(), s: 0.35 + 0.35 * R() });
    return out;
  }

  /* ---------- per-frame drawing primitives ---------- */
  var MAP = { x: 0, y: 0, w: 1, h: 1, dx: 0, dy: 0, dw: 1, dh: 1 };
  // draw img (already cropped to the destination aspect) zoomed by z >= 1, panned by px,py in [-1,1]
  // compute the zoom/pan source rect (and remember it in MAP so particles can sit on image points)
  function mapZoom(img, dx, dy, dw, dh, z, px, py) {
    var iw = img.width, ih = img.height;
    if (!(z >= 1)) z = 1;
    var sw = iw / z, sh = ih / z, mx = (iw - sw) * 0.5, my = (ih - sh) * 0.5;
    var sx = mx * (1 + clamp(px || 0, -1, 1)), sy = my * (1 + clamp(py || 0, -1, 1));
    MAP.x = sx / iw; MAP.y = sy / ih; MAP.w = sw / iw; MAP.h = sh / ih; MAP.dx = dx; MAP.dy = dy; MAP.dw = dw; MAP.dh = dh;
    MAP.sx = sx; MAP.sy = sy; MAP.sw = sw; MAP.sh = sh;
  }
  function drawZoom(ctx, img, dx, dy, dw, dh, z, px, py) {
    mapZoom(img, dx, dy, dw, dh, z, px, py);
    ctx.drawImage(img, MAP.sx, MAP.sy, MAP.sw, MAP.sh, dx, dy, dw, dh);
  }
  function mapX(u) { return MAP.dx + (u - MAP.x) / MAP.w * MAP.dw; }
  function mapY(v) { return MAP.dy + (v - MAP.y) / MAP.h * MAP.dh; }
  // horizontal strips of a zoomed image with per-strip x offsets (slice glitch / tracking tear)
  function drawSlices(ctx, img, dx, dy, dw, dh, z, px, py, slices, xoff) {
    var iw = img.width, ih = img.height;
    if (!(z >= 1)) z = 1;
    var sw = iw / z, sh = ih / z, mx = (iw - sw) * 0.5, my = (ih - sh) * 0.5;
    var sx = mx * (1 + clamp(px || 0, -1, 1)), sy = my * (1 + clamp(py || 0, -1, 1));
    for (var i = 0; i < slices.length; i++) {
      var s = slices[i], y0 = s[0], y1 = s[1];
      if (y1 <= y0) continue;
      ctx.drawImage(img, sx, sy + (y0 - dy) / dh * sh, sw, (y1 - y0) / dh * sh, dx + s[2] + (xoff || 0), y0, dw, y1 - y0);
    }
  }
  function fill(ctx, W, H, color, a, op) {
    if (a <= 0.012) return;
    ctx.globalAlpha = Math.min(1, a); if (op) ctx.globalCompositeOperation = op;
    ctx.fillStyle = color; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1; if (op) ctx.globalCompositeOperation = 'source-over';
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function star4(ctx, x, y, r, inner) {
    var k = inner || 0.28;
    ctx.beginPath();
    for (var i = 0; i < 8; i++) { var a = i * Math.PI / 4 - Math.PI / 2, rr = i % 2 ? r * k : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    ctx.closePath();
  }

  /* ---------- sprites, patterns, textures ---------- */
  var SPR = {};
  function sparkSprite(col) {
    var key = 'sp' + col; if (SPR[key]) return SPR[key];
    var S = 128, h = 64, c = mk(S, S), x = cx(c);
    var g = x.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.07, rgba(col, 0.95)); g.addColorStop(0.22, rgba(col, 0.32)); g.addColorStop(0.5, rgba(col, 0.08)); g.addColorStop(1, rgba(col, 0));
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    x.globalCompositeOperation = 'lighter';
    function ray(ang, len, wid, a) {
      x.save(); x.translate(h, h); x.rotate(ang);
      var lg = x.createLinearGradient(-len, 0, len, 0);
      lg.addColorStop(0, rgba(col, 0)); lg.addColorStop(0.5, 'rgba(255,255,255,' + a + ')'); lg.addColorStop(1, rgba(col, 0));
      x.fillStyle = lg; x.beginPath(); x.moveTo(-len, 0); x.quadraticCurveTo(0, -wid, len, 0); x.quadraticCurveTo(0, wid, -len, 0); x.fill(); x.restore();
    }
    ray(0, h, S * 0.045, 1); ray(Math.PI / 2, h, S * 0.045, 1);
    ray(Math.PI / 4, h * 0.5, S * 0.025, 0.55); ray(-Math.PI / 4, h * 0.5, S * 0.025, 0.55);
    SPR[key] = c; return c;
  }
  function bokehSprite(col) {
    var key = 'bk' + col; if (SPR[key]) return SPR[key];
    var S = 128, h = 64, c = mk(S, S), x = cx(c), g = x.createRadialGradient(h, h, 0, h, h, h - 1);
    g.addColorStop(0, rgba(col, 0.38)); g.addColorStop(0.7, rgba(col, 0.48)); g.addColorStop(0.88, rgba(col, 0.72));
    g.addColorStop(0.95, rgba(col, 0.35)); g.addColorStop(1, rgba(col, 0));
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    SPR[key] = c; return c;
  }
  // large soft glow as a clipped radial-gradient fill (same falloff as glowSprite)
  function glowAt(ctx, x, y, size, col, a) {
    var r = size / 2; if (r < 1 || a <= 0.01) return;
    var cw = ctx.canvas.width, ch = ctx.canvas.height;
    var x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(cw, x + r), y1 = Math.min(ch, y + r);
    if (x1 <= x0 || y1 <= y0) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a)); g.addColorStop(0.2, rgba(col, a * 0.6)); g.addColorStop(0.5, rgba(col, a * 0.18)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  function glowSprite(col) {
    var key = 'gl' + col; if (SPR[key]) return SPR[key];
    var S = 128, h = 64, c = mk(S, S), x = cx(c), g = x.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, rgba(col, 1)); g.addColorStop(0.2, rgba(col, 0.6)); g.addColorStop(0.5, rgba(col, 0.18)); g.addColorStop(1, rgba(col, 0));
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    SPR[key] = c; return c;
  }
  function streakSprite() {
    if (SPR.streak) return SPR.streak;
    var c = mk(256, 32), x = cx(c), g = x.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, 'rgba(70,140,255,0)'); g.addColorStop(0.35, 'rgba(90,165,255,0.35)'); g.addColorStop(0.5, 'rgba(200,230,255,1)');
    g.addColorStop(0.65, 'rgba(90,165,255,0.35)'); g.addColorStop(1, 'rgba(70,140,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 32);
    var v = x.createLinearGradient(0, 0, 0, 32); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(0.5, 'rgba(0,0,0,1)'); v.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalCompositeOperation = 'destination-in'; x.fillStyle = v; x.fillRect(0, 0, 256, 32);
    return (SPR.streak = c);
  }
  // soft elliptical dark backing behind text (cached sprite, stretched)
  function scrim(ctx, x, y, rw, rh, a, col) {
    if (a <= 0.01) return;
    var key = 'sc' + (col || '#000000'), c = SPR[key];
    if (!c) {
      c = mk(128, 128); var sx = cx(c), g = sx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, rgba(col || '#000000', 1)); g.addColorStop(0.45, rgba(col || '#000000', 0.78)); g.addColorStop(0.75, rgba(col || '#000000', 0.3)); g.addColorStop(1, rgba(col || '#000000', 0));
      sx.fillStyle = g; sx.fillRect(0, 0, 128, 128); SPR[key] = c;
    }
    ctx.globalAlpha = Math.min(1, a); ctx.drawImage(c, x - rw, y - rh, rw * 2, rh * 2); ctx.globalAlpha = 1;
  }
  var NOISE = null;
  function noiseTiles() { // 3 grain tiles: black/white specks with alpha, cheap 'source-over' grain
    if (NOISE) return NOISE;
    NOISE = [];
    for (var k = 0; k < 3; k++) {
      var S = 192, c = mk(S, S), x = cx(c), id = x.createImageData(S, S), d = id.data, R = mulberry32(99 + k * 1013);
      for (var i = 0; i < d.length; i += 4) {
        var v = (R() + R() + R() - 1.5) / 1.5;
        var on = v > 0 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = on; d[i + 3] = Math.min(255, Math.abs(v) * 330);
      }
      x.putImageData(id, 0, 0);
      NOISE.push(c);
    }
    return NOISE;
  }
  var SNOW = null;
  function snowTile() { // bright TV static
    if (SNOW) return SNOW;
    var S = 160, c = mk(S, S), x = cx(c), id = x.createImageData(S, S), d = id.data, R = mulberry32(4242);
    for (var i = 0; i < d.length; i += 4) { var v = R(); v = v * v * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    x.putImageData(id, 0, 0);
    return (SNOW = c);
  }
  var PATS = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function pattern(ctx, c) {
    var m = PATS && PATS.get(ctx);
    if (!m) { m = new Map(); if (PATS) PATS.set(ctx, m); }
    var p = m.get(c);
    if (!p) { p = ctx.createPattern(c, 'repeat'); m.set(c, p); }
    return p;
  }
  function patFill(ctx, c, x, y, w, h, ox, oy) {
    ctx.save(); ctx.translate(-ox, -oy); ctx.fillStyle = pattern(ctx, c); ctx.fillRect(x + ox, y + oy, w, h); ctx.restore();
  }
  var GRAIN = [];
  function grainTex(W, H) {
    for (var i = 0; i < GRAIN.length; i++) if (GRAIN[i].W === W && GRAIN[i].H === H) return GRAIN[i].c;
    var tiles = noiseTiles(), T = 192, c = mk(W + T, H + T), x = cx(c);
    for (var y = 0, r = 0; y < c.height; y += T, r++) for (var xx = 0, q = 0; xx < c.width; xx += T, q++) {
      var k = Math.floor(hash(q * 31 + r, 77) * 3), fx = hash(q, r + 78) < 0.5, fy = hash(q + 5, r) < 0.5;
      x.setTransform(fx ? -1 : 1, 0, 0, fy ? -1 : 1, fx ? xx + T : xx, fy ? y + T : y); x.drawImage(tiles[k], 0, 0);
    }
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (GRAIN.length >= 3) free(GRAIN.shift().c);
    GRAIN.push({ W: W, H: H, c: c });
    return c;
  }
  function grain(ctx, W, H, t, amt) {
    amt *= clamp(Math.pow(Math.min(W, H) / 1080, 0.75), 0.25, 1); // grain is 1px: keep it subtle on small previews
    if (amt <= 0.005) return;
    W = Math.round(W); H = Math.round(H);
    var tex = grainTex(W, H), k = Math.floor(t * 24);
    ctx.globalAlpha = amt;
    ctx.drawImage(tex, Math.floor(hash(k, 71) * 192), Math.floor(hash(k, 72) * 192), W, H, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  var SCAN = {};
  function scanTile(sp, a) {
    var key = sp + '_' + a; if (SCAN[key]) return SCAN[key];
    var c = mk(4, sp), x = cx(c);
    x.fillStyle = 'rgba(0,0,0,' + a + ')'; x.fillRect(0, 0, 4, Math.max(1, Math.round(sp * 0.45)));
    return (SCAN[key] = c);
  }
  function scanlines(ctx, W, H, M, a, off) {
    var sp = Math.max(2, Math.round(M / 300));
    patFill(ctx, scanTile(sp, a), 0, 0, W, H, 0, Math.round(off || 0) % sp);
  }

  /* ---------- particles (pure functions of t) ---------- */
  function sprite(ctx, img, x, y, size, rot) {
    if (size < 0.5) return;
    if (rot) {
      var c = Math.cos(rot) * size, s = Math.sin(rot) * size;
      ctx.setTransform(c, s, -s, c, x, y); ctx.drawImage(img, -0.5, -0.5, 1, 1); ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
  }
  // drifting bokeh discs
  function bokeh(ctx, W, H, t, o) {
    var M = Math.min(W, H), cols = o.colors, seed = o.seed || 1;
    ctx.globalCompositeOperation = o.op || 'lighter';
    for (var i = 0; i < o.n; i++) {
      var r = M * lerp(o.min, o.max, Math.pow(hash(i, seed), 1.7));
      var sp = (o.speed || 0.03) * lerp(0.5, 1.4, hash(i, seed + 1));
      var yy = fract(hash(i, seed + 2) - t * sp) * (H + 4 * r) - 2 * r;
      var xx = hash(i, seed + 3) * W + Math.sin(t * 0.45 + i * 1.7) * M * (o.drift || 0.03);
      var a = (o.alpha || 0.5) * (0.45 + 0.55 * hash(i, seed + 4)) * (0.75 + 0.25 * Math.sin(t * 1.1 + i * 2.3)) * (o.pulse == null ? 1 : o.pulse);
      if (a <= 0.01) continue;
      ctx.globalAlpha = Math.min(1, a);
      sprite(ctx, (o.sprite || bokehSprite)(cols[i % cols.length]), xx, yy, r * 2, 0);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  // twinkling star sparkles scattered (or at given points)
  function sparkles(ctx, W, H, t, o) {
    var M = Math.min(W, H), seed = o.seed || 3, cols = o.colors || ['#ffffff'];
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < o.n; i++) {
      var per = lerp(0.9, 2.2, hash(i, seed)), ph = hash(i, seed + 1);
      var tw = Math.sin((t / per + ph) * TAU); tw = tw > 0 ? Math.pow(tw, 3) : 0;
      var a = tw * (o.alpha == null ? 1 : o.alpha);
      if (a < 0.02) continue;
      var x, y;
      if (o.pts) { var p = o.pts[i % o.pts.length]; x = mapX(p.u) + hs(i, seed + 5) * M * 0.01; y = mapY(p.v) + hs(i, seed + 6) * M * 0.01; a *= p.s; }
      else { x = hash(i, seed + 2) * W; y = (o.y0 || 0) * H + hash(i, seed + 3) * (o.y1 == null ? 1 : o.y1 - (o.y0 || 0)) * H; }
      var size = M * lerp(o.min || 0.03, o.max || 0.08, hash(i, seed + 4)) * (0.55 + 0.45 * tw);
      ctx.globalAlpha = Math.min(1, a);
      sprite(ctx, sparkSprite(cols[i % cols.length]), x, y, size, t * 0.6 + i);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  // tiny glitter specks
  function glitter(ctx, W, H, t, o) {
    var M = Math.min(W, H), seed = o.seed || 5, cols = o.colors || ['#ffffff'];
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < o.n; i++) {
      var tw = Math.sin((t * lerp(1.5, 4, hash(i, seed)) + hash(i, seed + 1)) * TAU); tw = tw > 0 ? tw * tw : 0;
      var a = tw * (o.alpha || 0.9); if (a < 0.03) continue;
      var yy = (hash(i, seed + 3) - t * (o.rise || 0)) ; yy = fract(yy) * H;
      var xx = hash(i, seed + 2) * W + Math.sin(t * 0.8 + i) * M * 0.01, s = Math.max(1, M * lerp(0.002, 0.006, hash(i, seed + 4)));
      ctx.globalAlpha = a; ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(xx - s / 2, yy - s / 2, s, s);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  // continuous falling confetti
  function confetti(ctx, W, H, t, o) {
    var M = Math.min(W, H), seed = o.seed || 9, cols = o.colors;
    for (var i = 0; i < o.n; i++) {
      var v = lerp(0.07, 0.16, hash(i, seed)) * (o.speed || 1);
      var y = (fract(hash(i, seed + 1) + t * v) * 1.2 - 0.1) * H;
      var x = hash(i, seed + 2) * W + Math.sin(t * lerp(0.8, 2, hash(i, seed + 3)) + i) * M * 0.04;
      var w = M * lerp(0.009, 0.02, hash(i, seed + 4)) * (o.scale || 1), h = w * lerp(0.4, 0.7, hash(i, seed + 5));
      var rot = t * lerp(-3, 3, hash(i, seed + 6)) + i, fl = Math.cos(t * lerp(3, 8, hash(i, seed + 7)) + i);
      var c = Math.cos(rot), s = Math.sin(rot);
      ctx.setTransform(c, s, -s * fl, c * fl, x, y);
      ctx.globalAlpha = o.alpha || 1; ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  }
  // a burst of confetti launched at a moment (tau = seconds since launch)
  function confettiBurst(ctx, W, H, tau, o) {
    if (tau < 0 || tau > 2.6) return;
    var M = Math.min(W, H), seed = o.seed || 13, cols = o.colors, k = 2.2, g = H * 0.9;
    var fade = 1 - smooth(1.6, 2.6, tau);
    for (var i = 0; i < o.n; i++) {
      var side = o.center ? 0 : (i % 2 ? 1 : -1);
      var x0 = o.center ? o.x : (side < 0 ? -M * 0.02 : W + M * 0.02), y0 = o.center ? o.y : H * 1.02;
      var ang = o.center ? hash(i, seed) * TAU : (-Math.PI / 2 - side * lerp(0.15, 0.75, hash(i, seed)));
      var sp = M * lerp(1.2, 3.2, hash(i, seed + 1)) * (o.power || 1);
      var vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp, dr = (1 - Math.exp(-k * tau)) / k;
      var x = x0 + vx * dr + Math.sin(tau * 3 + i) * M * 0.02, y = y0 + vy * dr + g * 0.5 * tau * tau * 0.35;
      var w = M * lerp(0.01, 0.022, hash(i, seed + 2)), h = w * 0.5;
      var rot = tau * lerp(-8, 8, hash(i, seed + 3)) + i, fl = Math.cos(tau * lerp(4, 10, hash(i, seed + 4)) + i);
      var c = Math.cos(rot), s = Math.sin(rot);
      ctx.setTransform(c, s, -s * fl, c * fl, x, y);
      ctx.globalAlpha = fade; ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  }
  // big drifting light leaks
  function leaks(ctx, W, H, t, o) {
    var Mx = Math.max(W, H), cols = o.colors, seed = o.seed || 21;
    ctx.globalCompositeOperation = o.op || 'screen';
    for (var i = 0; i < cols.length; i++) {
      var ph = hash(i, seed) * TAU, sp = 0.05 + 0.05 * hash(i, seed + 1);
      var ex = 0.5 + 0.6 * Math.sin(t * sp * TAU + ph), ey = 0.5 + 0.58 * Math.cos(t * sp * TAU * 0.71 + ph * 1.3);
      var x = ex * W, y = ey * H, r = Mx * (o.size || 0.5) * (0.85 + 0.2 * Math.sin(t * 0.6 + ph));
      var a = (o.alpha || 0.4) * (0.75 + 0.25 * Math.sin(t * 0.37 + ph * 2)) * (o.pulse == null ? 1 : o.pulse);
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(cols[i], a)); g.addColorStop(0.4, rgba(cols[i], a * 0.45)); g.addColorStop(1, rgba(cols[i], 0));
      ctx.fillStyle = g;
      var x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r), y1 = Math.min(H, y + r);
      if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------- text ---------- */
  var FAM = {
    outfit: '"Outfit", "Avenir Next", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    play: '"Playfair Display", Didot, "Bodoni 72", Georgia, "Times New Roman", serif',
    caveat: '"Caveat", "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
    anton: '"Anton", Impact, Haettenschweiler, "Arial Narrow", sans-serif',
    vt: '"VT323", "Courier New", Courier, monospace',
    bangers: '"Bangers", Impact, "Comic Sans MS", sans-serif'
  };
  function font(ctx, w, size, fam, style) {
    ctx.font = (style ? style + ' ' : '') + w + ' ' + Math.max(1, Math.round(size)) + 'px ' + FAM[fam];
  }
  function textW(ctx, s, sp) {
    if (!sp) return ctx.measureText(s).width;
    var w = 0, ch = Array.from(s);
    for (var i = 0; i < ch.length; i++) w += ctx.measureText(ch[i]).width;
    return w + sp * Math.max(0, ch.length - 1);
  }
  function txt(ctx, s, x, y, sp, stroke) {
    if (!sp) { if (stroke) ctx.strokeText(s, x, y); else ctx.fillText(s, x, y); return; }
    var al = ctx.textAlign, w = textW(ctx, s, sp), ch = Array.from(s);
    var px = al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x;
    ctx.textAlign = 'left';
    for (var i = 0; i < ch.length; i++) {
      if (stroke) ctx.strokeText(ch[i], px, y); else ctx.fillText(ch[i], px, y);
      px += ctx.measureText(ch[i]).width + sp;
    }
    ctx.textAlign = al;
  }
  var LC = new Map();
  // when a web font finishes loading, cached measurements / title sprites must be rebuilt
  var FONT_GEN = 0;
  try {
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () { FONT_GEN++; LC.clear(); });
  } catch (e) { /* ignore */ }
  // fit text into maxW (optionally on 2 lines). returns {size, lines}
  function fitText(ctx, s, w, fam, style, maxSize, maxW, spEm, allow2) {
    var key = s + '|' + w + fam + style + '|' + Math.round(maxSize) + '|' + Math.round(maxW) + '|' + spEm + '|' + (allow2 ? 1 : 0);
    var hit = LC.get(key); if (hit) return hit;
    font(ctx, w, 100, fam, style);
    var sp = (spEm || 0) * 100, w1 = textW(ctx, s, sp);
    var size = Math.min(maxSize, 100 * maxW / Math.max(1, w1)), lines = [s];
    if (allow2 && size < maxSize * 0.72 && /\s/.test(s.trim())) {
      var words = s.trim().split(/\s+/), best = null;
      for (var i = 1; i < words.length; i++) {
        var a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
        var wm = Math.max(textW(ctx, a, sp), textW(ctx, b, sp));
        if (!best || wm < best.w) best = { w: wm, l: [a, b] };
      }
      var s2 = Math.min(maxSize * 0.86, 100 * maxW / Math.max(1, best.w));
      if (s2 > size * 1.12) { size = s2; lines = best.l; }
    }
    var res = { size: size, lines: lines };
    if (LC.size > 500) LC.clear();
    LC.set(key, res);
    return res;
  }

  /* ---------- timeline ---------- */
  // duration = whole bars; shots cover it. fill 'stretch' = one shot per photo, 'repeat' = cycle photos.
  function makePlan(n, bpm, cfg) {
    var beat = 60 / bpm, bar = beat * 4;
    var maxBeats = Math.max(4, Math.floor(60 / bar + 1e-9) * 4);
    var minBeats = Math.min(maxBeats, Math.max(4, Math.ceil((cfg.minSec || 8) / bar - 1e-9) * 4));
    var per = cfg.perPhoto || cfg.shotBeats, i;
    var ladder = [32, 24, 16, 12, 8, 6, 4, 3, 2, 1].filter(function (v) { return v <= per; });
    var p = ladder[ladder.length - 1];
    for (i = 0; i < ladder.length; i++) if (n * ladder[i] <= maxBeats) { p = ladder[i]; break; }
    var total = clamp(Math.ceil(n * p / 4) * 4, minBeats, maxBeats);
    var lens = [], photos = [];
    if (cfg.fill === 'repeat') {
      var sb = Math.min(cfg.shotBeats, p), count = Math.max(n, Math.floor(total / sb));
      if (count * sb > total) sb = total / count;
      for (i = 0; i < count; i++) { lens.push(sb); photos.push(i % n); }
      lens[count - 1] += total - sb * count;
    } else {
      var unit = (p >= 4 && total / 4 >= n) ? 4 : 1, units = total / unit;
      if (units >= n) {
        var base = Math.floor(units / n), rem = units - base * n;
        for (i = 0; i < n; i++) { lens.push((base + (i >= n - rem ? 1 : 0)) * unit); photos.push(i); }
      } else for (i = 0; i < n; i++) { lens.push(total / n); photos.push(i); }
    }
    var shots = [], b = 0;
    for (i = 0; i < lens.length; i++) { shots.push({ k: i, p: photos[i], b0: b, b1: b + lens[i], v: Math.floor(i / n) }); b += lens[i]; }
    shots[shots.length - 1].b1 = total;
    return { beat: beat, bar: bar, beats: total, bars: total / 4, duration: total * beat, shots: shots };
  }
  function shotAt(S, b) {
    var sh = S.plan.shots, i = S._si || 0;
    if (i >= sh.length) i = 0;
    while (i > 0 && b < sh[i].b0) i--;
    while (i < sh.length - 1 && b >= sh[i].b1) i++;
    S._si = i;
    return sh[i];
  }
  // Ken Burns for a shot at beat position b (continues smoothly outside the shot for crossfades)
  function kb(sh, b, amt, seed, base) {
    var u = (b - sh.b0) / Math.max(0.001, sh.b1 - sh.b0), k = sh.k;
    var zin = hash(k, seed) < 0.62;
    var z = (base == null ? 1.03 : base) + amt * (zin ? u : 1 - u);
    return {
      z: Math.max(1, z),
      px: lerp(hs(k, seed + 1), hs(k, seed + 2), u) * 0.7,
      py: lerp(hs(k, seed + 3), hs(k, seed + 4), u) * 0.5 - 0.08
    };
  }
  function introA(S, t) {
    var end = Math.min(S.bar * 2, S.duration * 0.4);
    return smooth(0.08, 0.5, t) * (1 - smooth(end - 0.45, end, t));
  }
  function outroA(S, t, lead) {
    var st = S.duration - (lead || Math.max(1.7, S.bar));
    return smooth(st, st + 0.5, t);
  }
  function endP(S, t, len) { return sat((t - (S.duration - len)) / len); }
  function titleA(S, t) { return Math.max(introA(S, t), outroA(S, t)); }
  // crossfade helper: draws shot(s) with a transition of width w beats centred on each cut
  function xfade(S, b, w, draw) {
    var sh = shotAt(S, b), shots = S.plan.shots, into = b - sh.b0, left = sh.b1 - b;
    if (sh.k > 0 && into < w / 2) { draw(shots[sh.k - 1], 1); draw(sh, E.inOutSine(0.5 + into / w)); return sh; }
    if (sh.k < shots.length - 1 && left < w / 2) { draw(sh, 1); draw(shots[sh.k + 1], E.inOutSine(0.5 - left / w)); return sh; }
    draw(sh, 1);
    return sh;
  }
  function budgetScale(S, units) {
    var px = S.W * S.H * units * S.n, B = 30e6;
    return px > B ? Math.max(0.45, Math.sqrt(B / px)) : 1;
  }
  async function prepEach(S, photos, fn) {
    var out = [];
    for (var i = 0; i < photos.length; i++) { await tick(); out.push(fn(photos[i], i)); }
    return out;
  }
  function monthStamp() {
    var d = new Date();
    return { m: d.getMonth(), d: d.getDate(), y: d.getFullYear() };
  }
  var MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

  // shared title helpers -------------------------------------------------
  function shadowOn(ctx, color, blur, ox, oy) { ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.shadowOffsetX = ox || 0; ctx.shadowOffsetY = oy || 0; }
  function shadowOff(ctx) { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
  // cached offscreen canvas (titles with glows/shadows are rendered once, then blitted)
  function cached(S, key, w, h, draw) {
    key += '#' + FONT_GEN;
    var m = S.tc || (S.tc = new Map()), c = m.get(key);
    if (!c) {
      c = mk(w, h); draw(cx(c), c.width, c.height);
      if (m.size >= 8) { var k0 = m.keys().next().value; free(m.get(k0)); m.delete(k0); }
      m.set(key, c);
    }
    return c;
  }
  function bottomShade(ctx, W, H, a, from, S) {
    if (a <= 0.01) return;
    var y0 = Math.round(H * (from || 0.55));
    if (S) {
      var c = cached(S, 'shade' + y0, W, H - y0, function (x, w, h) {
        var g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
        x.fillStyle = g; x.fillRect(0, 0, w, h);
      });
      ctx.globalAlpha = Math.min(1, a); ctx.drawImage(c, 0, y0); ctx.globalAlpha = 1;
      return;
    }
    var g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,' + a + ')');
    ctx.fillStyle = g; ctx.fillRect(0, y0, W, H - y0);
  }
  function pill(ctx, label, x, y, M, st, a) {
    if (a <= 0.01) return;
    var fs = M * 0.034, sp = fs * 0.26;
    font(ctx, 700, fs, 'outfit');
    var tw = textW(ctx, label, sp), ph = fs * 2.15, pw = tw + fs * (st.icon ? 3.5 : 2.4);
    ctx.globalAlpha = a;
    if (st.glow) shadowOn(ctx, st.glow, M * 0.03);
    roundRect(ctx, x - pw / 2, y - ph / 2, pw, ph, ph / 2);
    var bg = st.bg;
    if (st.grad) { bg = ctx.createLinearGradient(x - pw / 2, 0, x + pw / 2, 0); bg.addColorStop(0, st.grad[0]); bg.addColorStop(1, st.grad[1]); }
    ctx.fillStyle = bg; ctx.fill(); shadowOff(ctx);
    if (st.border) { ctx.lineWidth = Math.max(1, M * 0.0025); ctx.strokeStyle = st.border; ctx.stroke(); }
    ctx.fillStyle = st.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var x0 = x - pw / 2 + fs * 1.2;
    if (st.icon) { star4(ctx, x0 + fs * 0.42, y, fs * 0.62, 0.3); ctx.fill(); x0 += fs * 1.15; }
    txt(ctx, label, x0, y + fs * 0.05, sp);
    ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
  }

  /* ======================================================================
   * 2. Templates
   * ==================================================================== */
  var TEMPLATES = [
    { id: 'glowup', name: 'Glow Up', desc: 'Dull-to-dazzling before & after reveal', tag: 'Trending', track: 'glow', colors: ['#ff4fd8', '#ffb86b'] },
    { id: 'neon', name: 'Neon Night', desc: 'Purple-teal neon glow & beat punches', tag: 'Hot', track: 'neon', colors: ['#b44dff', '#28e7ff'] },
    { id: 'golden', name: 'Golden Hour', desc: 'Warm sun, light leaks & film grain', tag: '', track: 'golden', colors: ['#ff9f43', '#ffd56b'] },
    { id: 'cinema', name: 'Cinematic', desc: 'Movie bars, teal-orange, slow push-ins', tag: '', track: 'epic', colors: ['#1fa2b8', '#ff8a3d'] },
    { id: 'vhs', name: 'Retro VHS', desc: 'Camcorder tape look with date stamp', tag: '', track: 'golden', colors: ['#ff3b6b', '#3bd6ff'] },
    { id: 'beat', name: 'Beat Drop', desc: 'Hard cuts, flashes & shake on the beat', tag: 'Hot', track: 'hype', colors: ['#ff2d55', '#ffffff'] },
    { id: 'polaroid', name: 'Memories', desc: 'Polaroids dropping into a keepsake pile', tag: '', track: 'dream', colors: ['#f3d9c4', '#c98b6b'] },
    { id: 'dreamy', name: 'Dreamy', desc: 'Soft bloom, pastel haze & bokeh', tag: '', track: 'dream', colors: ['#ffc6ec', '#b9a8ff'] },
    { id: 'cover', name: 'Cover Star', desc: 'Star on your own magazine cover', tag: 'New', track: 'disco', colors: ['#ff2e63', '#ffd400'] },
    { id: 'comic', name: 'Comic Pop', desc: 'Pop-art halftones & POW! bursts', tag: 'New', track: 'sun', colors: ['#ffd400', '#ff2e88'] },
    { id: 'glitch', name: 'Glitch', desc: 'Digital RGB glitches synced to the beat', tag: '', track: 'hype', colors: ['#00f0ff', '#ff00a8'] },
    { id: 'party', name: 'Party Sparkle', desc: 'Confetti, glitter & bouncy beat zooms', tag: '', track: 'disco', colors: ['#ffcf4d', '#ff4fa3'] }
  ];
  var TRACK_BPM = { neon: 108, glow: 122, golden: 84, hype: 140, dream: 92, sun: 104, epic: 96, disco: 116 };
  var IMPL = {};

  /* ---------------- GLOW UP: before -> sparkle wipe -> after ---------------- */
  // 'after' = crisp, vibrant, glowing (vibrance protects skin); 'before' = soft, flat, cold and washed out
  var GU_AFTER = { sat: 1.1, vib: 0.6, skin: 0.85, contrast: 1.08, curve: 0.2, exposure: 1.0, temp: 0.0, tint: 0.03, gamma: 1.07, clarity: 0.55,
    shadows: '#2a1660', shAmt: 0.26, highlights: '#ffe6f0', hiAmt: 0.08 };
  var GU_BEFORE = { sat: 0.46, contrast: 0.74, exposure: 0.9, lift: 0.1, gain: 0.86, temp: -0.14, tint: -0.08, gamma: 0.94, shadows: '#3a4a48', shAmt: 0.25 };
  IMPL.glowup = {
    cfg: { shotBeats: 8, fill: 'stretch' },
    units: 1.3,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p, i) {
        var a = coverCrop(p, S.PW, S.PH);
        var b = resize(a, S.PW * 0.42, S.PH * 0.42); // lower res = visibly softer 'before'
        grade(b, GU_BEFORE);
        grade(a, GU_AFTER);
        bloom(a, { thr: 0.7, amt: 0.27, rad: 3, tint: '#ffc6dc', tintAmt: 0.3 });
        vignette(a, 0.3);
        return { a: a, b: b, pts: glints(a, 18, i + 1) };
      });
    },
    titleA: function (S, t) {
      var sh0 = S.plan.shots[0], rb0 = this.reveal(sh0.b1 - sh0.b0);
      var a0 = (sh0.b0 + rb0 + 0.6) * S.beat, a1 = Math.min((sh0.b0 + rb0 + 8.6) * S.beat, (sh0.b1 - 0.55) * S.beat);
      var intro = a1 > a0 + 0.6 ? smooth(a0, a0 + 0.45, t) * (1 - smooth(a1 - 0.4, a1, t)) : 0;
      return Math.max(intro, outroA(S, t));
    },
    reveal: function (L) { return L >= 12 ? 8 : Math.max(1, Math.floor(L / 2)); },
    poster: function (S) { var sh = S.plan.shots[0], rb = this.reveal(sh.b1 - sh.b0); return (rb - 0.1) * S.beat; },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6;
      var sh = shotAt(S, bt), L = sh.b1 - sh.b0, lb = bt - sh.b0, rb = this.reveal(L), P = S.ph[sh.p];
      var px = hs(sh.k, 11) * 0.7, py = hs(sh.k, 12) * 0.5 - 0.1, z, aft = lb - rb;
      if (lb < rb) z = 1.035 + 0.065 * E.inCubic(sat(lb / rb));
      else z = 1.03 + 0.07 * Math.exp(-aft * 1.4) + 0.035 * sat(aft / Math.max(1, L - rb));
      var w0 = rb - 0.55, w1 = rb + 0.3, pr = E.inOutCubic(sat((lb - w0) / (w1 - w0)));
      var nx = Math.cos(-0.32), ny = Math.sin(-0.32);
      var sv = [0, W * nx, H * ny, W * nx + H * ny], smin = Math.min.apply(null, sv), smax = Math.max.apply(null, sv);
      var tv = [0, -W * ny, H * nx, -W * ny + H * nx], vmin = Math.min.apply(null, tv), vmax = Math.max.apply(null, tv);
      var bw = M * 0.13, sPos = lerp(smin - bw * 0.4, smax + bw, pr), BIG = W + H;
      // slider comparison for long shots
      var sl = 0;
      if (L - rb >= 8) {
        var s0 = rb + 3, s1 = L - 2.6;
        sl = E.inOutCubic(sat((lb - s0) / 1)) * (1 - E.inOutCubic(sat((lb - s1) / 1)));
      }
      // ---- picture ----
      if (lb < w0) {
        drawZoom(ctx, P.b, 0, 0, W, H, z, px, py);
        // anticipation: light gathering at the wipe edge
        var ant = E.inQuad(sat((lb - (rb - 1.6)) / 1.1));
        if (ant > 0.01) {
          ctx.globalCompositeOperation = 'lighter';
          var gx0 = ctx.createLinearGradient(0, 0, M * 0.35, 0);
          gx0.addColorStop(0, 'rgba(255,210,240,' + (0.35 * ant) + ')'); gx0.addColorStop(1, 'rgba(255,210,240,0)');
          ctx.fillStyle = gx0; ctx.fillRect(0, 0, M * 0.35, H);
          ctx.globalCompositeOperation = 'source-over';
        }
      } else if (lb < w1) {
        drawZoom(ctx, P.b, 0, 0, W, H, z, px, py);
        ctx.save();
        ctx.setTransform(nx, ny, -ny, nx, 0, 0);
        ctx.beginPath(); ctx.rect(-BIG * 2, -BIG * 2, BIG * 2 + sPos, BIG * 4); ctx.clip();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawZoom(ctx, P.a, 0, 0, W, H, z, px, py);
        ctx.restore();
      } else if (sl > 0.001) {
        drawZoom(ctx, P.a, 0, 0, W, H, z, px, py);
        var sxp = W * 0.5 * sl;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sxp, H); ctx.clip();
        drawZoom(ctx, P.b, 0, 0, W, H, z, px, py);
        ctx.restore();
      } else drawZoom(ctx, P.a, 0, 0, W, H, z, px, py);

      // ---- glow band + sparkles on the wipe ----
      if (lb >= w0 - 0.05 && lb < w1 + 0.1) {
        var bandA = Math.sin(Math.PI * sat((lb - w0 + 0.05) / (w1 - w0 + 0.15)));
        ctx.save();
        ctx.setTransform(nx, ny, -ny, nx, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        var g = ctx.createLinearGradient(sPos - bw, 0, sPos + bw * 0.35, 0);
        g.addColorStop(0, 'rgba(255,120,200,0)'); g.addColorStop(0.55, 'rgba(255,170,220,' + 0.45 * bandA + ')');
        g.addColorStop(0.84, 'rgba(255,248,240,' + 0.78 * bandA + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(sPos - bw, vmin - 10, bw * 1.35, vmax - vmin + 20);
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
        for (var i = 0; i < 26; i++) {
          var vv = lerp(vmin, vmax, hash(i, 31 + sh.k)), uu = sPos - bw * 0.1 + hs(i, 32) * bw * 0.5;
          var X = uu * nx - vv * ny, Y = uu * ny + vv * nx;
          var tw = 0.5 + 0.5 * Math.sin(t * 18 + i * 2.1), size = M * lerp(0.035, 0.11, hash(i, 33)) * (0.5 + 0.5 * tw) * bandA;
          ctx.globalAlpha = Math.min(1, bandA * (0.6 + 0.4 * tw));
          sprite(ctx, sparkSprite(i % 3 ? '#ffd7f2' : '#fff1c9'), X, Y, size, t * 2 + i);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
      // ---- after: glints, glitter, flash ----
      if (aft > 0) {
        mapZoom(P.a, 0, 0, W, H, z, px, py);
        var inten = 0.45 + 0.55 * Math.exp(-aft * 0.9) + 0.25 * Math.exp(-fract(bt) * 4);
        sparkles(ctx, W, H, t, { n: P.pts.length, pts: P.pts, seed: 40 + sh.k, alpha: inten, min: 0.04, max: 0.1, colors: ['#ffffff', '#ffe3a3', '#ffc7ef'] });
        glitter(ctx, W, H, t, { n: 40, seed: 50 + sh.k, alpha: 0.7 * inten, rise: 0.04, colors: ['#fff6d8', '#ffd1f1'] });
        fill(ctx, W, H, '#ffffff', 0.45 * Math.exp(-aft * 5), 'lighter');
        // reveal burst: soft bloom flash + a ring of sparkles flying outwards
        if (aft < 1.4) {
          var bq = sat(aft / 1.4), cxb = W / 2, cyb = H * 0.46;
          ctx.globalCompositeOperation = 'lighter';
          glowAt(ctx, cxb, cyb, M * (0.7 + 1.6 * E.outCubic(bq)), '#ffc2ea', 0.55 * Math.exp(-aft * 2.6));
          var ringR = M * (0.08 + 0.62 * E.outCubic(bq)), ra = (1 - E.inQuad(bq));
          for (var ri = 0; ri < 16; ri++) {
            var ang = ri / 16 * TAU + sh.k * 0.7 + hs(ri, 61) * 0.18, rr2 = ringR * (0.82 + 0.3 * hash(ri, 62));
            ctx.globalAlpha = ra * (0.6 + 0.4 * hash(ri, 63));
            sprite(ctx, sparkSprite(ri % 3 ? '#ffd7f2' : '#fff1c9'), cxb + Math.cos(ang) * rr2 * (W > H ? 1.25 : 1), cyb + Math.sin(ang) * rr2, M * lerp(0.05, 0.1, hash(ri, 64)) * (1 - 0.5 * bq), aft * 3 + ri);
          }
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      } else if (lb > rb - 0.15) fill(ctx, W, H, '#ffffff', 0.2, 'lighter');
      if (sh.k > 0 && lb < 0.3) fill(ctx, W, H, '#ffffff', 0.35 * (1 - lb / 0.3));

      // ---- labels ----
      var top = H * 0.075 + M * 0.02;
      if (sl > 0.02) {
        pill(ctx, 'BEFORE', W * 0.25 * sl + 0.001, top, M, { bg: 'rgba(18,18,26,0.55)', fg: 'rgba(255,255,255,0.9)', border: 'rgba(255,255,255,0.25)' }, sat(sl * 2));
        pill(ctx, 'AFTER', W * (0.5 + 0.25 * sl) + W * 0.25 * (1 - sl), top, M, { grad: ['#ff4fd8', '#8b5cff'], fg: '#fff', icon: true, glow: 'rgba(255,79,216,0.6)' }, sat(sl * 2));
        // divider + handle
        var sxp2 = W * 0.5 * sl;
        ctx.globalAlpha = sat(sl * 3);
        shadowOn(ctx, 'rgba(255,120,220,0.9)', M * 0.03);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(sxp2 - Math.max(1, M * 0.003), 0, Math.max(2, M * 0.006), H);
        ctx.beginPath(); ctx.arc(sxp2, H * 0.5, M * 0.045, 0, TAU); ctx.fill(); shadowOff(ctx);
        ctx.fillStyle = '#8b5cff'; var ar = M * 0.016;
        ctx.beginPath(); ctx.moveTo(sxp2 - ar * 0.4, H * 0.5 - ar); ctx.lineTo(sxp2 - ar * 1.5, H * 0.5); ctx.lineTo(sxp2 - ar * 0.4, H * 0.5 + ar); ctx.fill();
        ctx.beginPath(); ctx.moveTo(sxp2 + ar * 0.4, H * 0.5 - ar); ctx.lineTo(sxp2 + ar * 1.5, H * 0.5); ctx.lineTo(sxp2 + ar * 0.4, H * 0.5 + ar); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        var la = 1 - smooth(w0, w0 + 0.3, lb), lA = smooth(rb, rb + 0.35, lb);
        if (la > 0.01) {
          pill(ctx, 'BEFORE', W / 2, top, M, { bg: 'rgba(18,18,26,0.5)', fg: 'rgba(255,255,255,0.88)', border: 'rgba(255,255,255,0.22)' }, la);
          var nd = Math.min(3, rb);
          for (var d = 0; d < nd; d++) {
            var on = sat((lb - (rb - nd + d)) * 6), r = M * 0.008 * (1 + 0.5 * on * Math.exp(-(lb - (rb - nd + d)) * 3));
            ctx.globalAlpha = la * (0.35 + 0.65 * on);
            ctx.fillStyle = on > 0.5 ? '#ff7ad9' : '#ffffff';
            ctx.beginPath(); ctx.arc(W / 2 + (d - (nd - 1) / 2) * M * 0.04, top + M * 0.055, r, 0, TAU); ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        if (lA > 0.01) {
          var pop = 1 + 0.25 * Math.exp(-(lb - rb) * 5);
          ctx.save(); ctx.translate(W / 2, top); ctx.scale(pop, pop);
          pill(ctx, 'AFTER', 0, 0, M, { grad: ['#ff4fd8', '#8b5cff'], fg: '#fff', icon: true, glow: 'rgba(255,79,216,0.6)' }, lA);
          ctx.restore();
        }
      }
      // ---- ending: dim the picture (title stays bright on top) ----
      var e = endP(S, t, 0.8);
      if (e > 0) {
        fill(ctx, W, H, '#0b0612', 0.62 * E.inQuad(e));
        sparkles(ctx, W, H, t, { n: 14, seed: 77, alpha: e, min: 0.03, max: 0.07, colors: ['#ffd7f2', '#fff1c9'] });
      }
      // ---- title (appears with the first reveal, returns for the outro) ----
      var ta = this.titleA(S, t);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        bottomShade(ctx, W, H, 0.55 * ta * (1 - e), 0.52, S);
        var ys0 = Math.round(H * 0.42);
        var spr = cached(S, 'gu|' + tx.title + '|' + tx.subtitle, W, H - ys0, function (x) {
          var lay = fitText(x, tx.title || ' ', 800, 'outfit', '', M * 0.13, W * 0.86, 0.01, true);
          var lh = lay.size * 1.02, yB = H * (W > H ? 0.84 : 0.86) - (lay.lines.length - 1) * lh - ys0;
          x.textAlign = 'center';
          if (tx.subtitle) {
            var gs = fitText(x, tx.subtitle.toUpperCase(), 600, 'outfit', '', M * 0.034, W * 0.84, 0.26, false).size;
            font(x, 600, gs, 'outfit'); x.fillStyle = '#ffd1f3'; shadowOn(x, 'rgba(0,0,0,0.5)', M * 0.012);
            txt(x, tx.subtitle.toUpperCase(), W / 2, yB - lay.size * (tx.title ? 1.05 : 0), gs * 0.26); shadowOff(x);
          }
          if (tx.title) {
            font(x, 800, lay.size, 'outfit');
            var gg = x.createLinearGradient(0, yB - lay.size, 0, yB + lh * (lay.lines.length - 1));
            gg.addColorStop(0, '#ffffff'); gg.addColorStop(1, '#ffd0f0');
            shadowOn(x, 'rgba(255,60,200,0.75)', M * 0.045);
            x.fillStyle = gg;
            for (var li = 0; li < lay.lines.length; li++) txt(x, lay.lines[li], W / 2, yB + li * lh, lay.size * 0.01);
            shadowOff(x);
          }
        });
        ctx.globalAlpha = ta; ctx.drawImage(spr, 0, ys0 + Math.round((1 - ta) * M * 0.03)); ctx.globalAlpha = 1;
      }
    }
  };

  /* ---------------- NEON NIGHT ---------------- */
  IMPL.neon = {
    cfg: { shotBeats: 4, fill: 'repeat' },
    units: 1.05,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, S.PH);
        grade(a, { contrast: 1.25, curve: 0.25, sat: 1.25, exposure: 0.92, gamma: 0.92, autoK: 1.2, shadows: '#5a12b8', shAmt: 0.55, highlights: '#29e6ff', hiAmt: 0.3,
          map: [[0, '#05011a'], [0.32, '#33107a'], [0.58, '#b0189a'], [0.8, '#ff5fd2'], [1, '#a8f4ff']], mapAmt: 0.5 });
        bloom(a, { thr: 0.5, amt: 0.55, rad: 3, tint: '#ff4fd8', tintAmt: 0.3 });
        vignette(a, 0.6, '#0a0220', 0.45);
        return a;
      });
      // glowing neon frame (drawn later as 4 cheap 1:1 strips)
      var W = S.W, H = S.H, M = S.M, f = mk(W, H), x = cx(f);
      var ins = M * 0.05, rad = M * 0.06, lw = Math.max(1.2, M * 0.006);
      var g = x.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#ff3fd2'); g.addColorStop(0.5, '#8b5cff'); g.addColorStop(1, '#2ef2ff');
      x.strokeStyle = g; x.lineJoin = 'round';
      [[lw * 9, 0.07], [lw * 5, 0.12], [lw * 2.8, 0.3]].forEach(function (q) { x.lineWidth = q[0]; x.globalAlpha = q[1]; roundRect(x, ins, ins, W - ins * 2, H - ins * 2, rad); x.stroke(); });
      x.globalAlpha = 1; x.lineWidth = lw * 1.5; shadowOn(x, '#ff3fd2', M * 0.035); roundRect(x, ins, ins, W - ins * 2, H - ins * 2, rad); x.stroke();
      shadowOff(x); x.lineWidth = Math.max(1, lw * 0.5); x.strokeStyle = 'rgba(255,255,255,0.85)'; roundRect(x, ins, ins, W - ins * 2, H - ins * 2, rad); x.stroke();
      S.frame = f; S.band = Math.min(Math.ceil(ins + lw * 6 + M * 0.04), Math.floor(Math.min(W, H) / 2) - 1);
    },
    strips: function (S, ctx) {
      var W = S.W, H = S.H, b = S.band, f = S.frame;
      ctx.drawImage(f, 0, 0, W, b, 0, 0, W, b);
      ctx.drawImage(f, 0, H - b, W, b, 0, H - b, W, b);
      ctx.drawImage(f, 0, b, b, H - 2 * b, 0, b, b, H - 2 * b);
      ctx.drawImage(f, W - b, b, b, H - 2 * b, W - b, b, b, H - 2 * b);
    },
    poster: function (S) { return S.beat * 1.15; },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, f = fract(bt), bi = Math.floor(bt);
      var e = endP(S, t, 0.7), off = e > 0 ? (hash(Math.floor(t * 30), 3) < e * 1.2 ? 1 : 0) : 0;
      var sh = shotAt(S, bt), lb = bt - sh.b0, P = S.ph[sh.p], k = kb(sh, bt, 0.07, 61, 1.05);
      var punch = Math.exp(-f * 5) * (lb < 1 ? 0.09 : 0.045) * (1 - e);
      var z = k.z + punch;
      drawZoom(ctx, P, 0, 0, W, H, z, k.px, k.py);
      if (lb < 0.25 && sh.k > 0) { // zoom-ghost transition
        var ga = 0.35 * (1 - lb / 0.25);
        ctx.globalAlpha = ga; drawZoom(ctx, P, 0, 0, W, H, z * 1.07, k.px, k.py);
        ctx.globalAlpha = ga * 0.6; drawZoom(ctx, P, 0, 0, W, H, z * 1.15, k.px, k.py); ctx.globalAlpha = 1;
      }
      // beat flash, alternating magenta / cyan
      fill(ctx, W, H, bi % 2 ? '#25e8ff' : '#ff3fd2', (lb < 1 ? 0.3 : 0.16) * Math.exp(-f * 7) * (1 - e), 'lighter');
      // neon dust
      bokeh(ctx, W, H, t, { n: 14, seed: 7, colors: ['#ff4fd8', '#33e6ff', '#9b6bff'], min: 0.008, max: 0.035, speed: 0.025, alpha: 0.55 });
      // light streak sweep every 2 bars
      var sp = fract(bt / 8), sa = Math.sin(Math.PI * sat(sp * 2.2)) * (sp < 0.46 ? 1 : 0);
      if (sa > 0.01) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.translate(lerp(-0.3, 1.3, sp * 2.2) * W, H * 0.5); ctx.rotate(0.5);
        var lg = ctx.createLinearGradient(-M * 0.08, 0, M * 0.08, 0);
        lg.addColorStop(0, 'rgba(120,240,255,0)'); lg.addColorStop(0.5, 'rgba(160,245,255,' + 0.22 * sa + ')'); lg.addColorStop(1, 'rgba(120,240,255,0)');
        ctx.fillStyle = lg; ctx.fillRect(-M * 0.08, -H, M * 0.16, H * 2); ctx.restore();
      }
      // frame + pulse
      var fl = e > 0 ? (off ? 0.15 : 1 - e * 0.6) : 1;
      ctx.globalAlpha = fl; this.strips(S, ctx);
      var pulse = Math.exp(-f * 4) * 0.8 * fl;
      if (pulse > 0.03) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = pulse; this.strips(S, ctx); ctx.globalCompositeOperation = 'source-over'; }
      ctx.globalAlpha = 1;
      // neon sign title
      var ta = titleA(S, t);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        var flick = 1;
        if (t < 1.1) { var q = Math.floor(t * 22); flick = t < 0.15 ? 0 : (hash(q, 5) < 0.3 + t * 0.6 ? 1 : 0.15); }
        if (e > 0) flick *= off ? 0.1 : 1;
        var hum = 0.93 + 0.07 * Math.sin(t * 40) * Math.sin(t * 7.3);
        var I = ta * flick * hum, cy0 = H * (W > H ? 0.5 : 0.52);
        var ny0 = Math.max(0, Math.round(cy0 - M * 0.48)), nh = Math.min(H - ny0, Math.round(M * 1.02));
        var sign = cached(S, 'neon|' + tx.title + '|' + tx.subtitle, W, nh, function (x) {
          var cy = cy0 - ny0, lay = null;
          x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
          if (tx.title) {
            lay = fitText(x, tx.title, 700, 'outfit', '', M * 0.15, W - M * 0.3, 0.04, true);
            var lh = lay.size * 1.08, y0 = cy - (lay.lines.length - 1) * lh / 2;
            font(x, 700, lay.size, 'outfit');
            for (var li = 0; li < lay.lines.length; li++) {
              var yy = y0 + li * lh;
              x.globalAlpha = 0.9; shadowOn(x, '#ff2fd0', M * 0.06); x.lineWidth = lay.size * 0.07; x.strokeStyle = '#ff5fe0';
              txt(x, lay.lines[li], W / 2, yy, lay.size * 0.04, true);
              shadowOn(x, '#ff8ff0', M * 0.018); x.lineWidth = lay.size * 0.035; x.strokeStyle = '#ffc2f6';
              txt(x, lay.lines[li], W / 2, yy, lay.size * 0.04, true);
              shadowOff(x); x.lineWidth = Math.max(1, lay.size * 0.012); x.strokeStyle = '#ffffff'; x.globalAlpha = 1;
              txt(x, lay.lines[li], W / 2, yy, lay.size * 0.04, true);
            }
          }
          if (tx.subtitle) {
            var ss = fitText(x, tx.subtitle.toUpperCase(), 600, 'outfit', '', M * 0.045, W - M * 0.35, 0.3, false).size;
            var ys = lay ? cy + (lay.lines.length * 0.55 + 0.35) * lay.size + ss : cy;
            font(x, 600, ss, 'outfit'); x.globalAlpha = 1; shadowOn(x, '#18e0ff', M * 0.035); x.fillStyle = '#c8fbff';
            txt(x, tx.subtitle.toUpperCase(), W / 2, Math.min(ys, nh - ss * 1.2), ss * 0.3);
            shadowOff(x);
          }
        });
        scrim(ctx, W / 2, cy0, Math.min(W * 0.62, M * 1.0), M * 0.3, 0.5 * ta, '#0a0220');
        ctx.globalAlpha = Math.min(1, I); ctx.drawImage(sign, 0, ny0); ctx.globalAlpha = 1;
      }
      if (e > 0) fill(ctx, W, H, '#07021a', E.inQuad(e) * 0.75 + (off ? 0.15 : 0));
    }
  };

  /* ---------------- GOLDEN HOUR ---------------- */
  IMPL.golden = {
    cfg: { shotBeats: 4, fill: 'stretch' },
    units: 1,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, S.PH);
        grade(a, { temp: 0.42, tint: 0.04, contrast: 1.12, curve: 0.28, lift: 0.03, gain: 0.99, sat: 1.14, vib: 0.25, exposure: 1.02,
          shadows: '#3f1d2c', shAmt: 0.32, highlights: '#ffb347', hiAmt: 0.4 });
        bloom(a, { thr: 0.5, amt: 0.45, rad: 3, tint: '#ffb05c', tintAmt: 0.45 });
        vignette(a, 0.5, '#2a1004', 0.45);
        return a;
      });
      // leak texture is larger than the frame so the moving window never reaches its edges
      var W = S.W, H = S.H, M = S.M, mx = Math.ceil(W * 0.17), my = Math.ceil(H * 0.1), lt = mk(W + 2 * mx, H + 2 * my), lx = cx(lt);
      S.lmx = mx; S.lmy = my;
      lx.globalCompositeOperation = 'lighter';
      [[-0.05, 0.18, 0.62, '#ff6a2a', 0.6], [1.05, 0.72, 0.58, '#ff4060', 0.48], [0.9, 0.03, 0.42, '#ffc35a', 0.62], [0.15, 1.02, 0.4, '#ff9a3c', 0.35]].forEach(function (b) {
        var X = mx + b[0] * W, Y = my + b[1] * H, r = M * b[2] * 1.25, g = lx.createRadialGradient(X, Y, 0, X, Y, r);
        g.addColorStop(0, rgba(b[3], b[4])); g.addColorStop(0.35, rgba(b[3], b[4] * 0.5)); g.addColorStop(1, rgba(b[3], 0));
        lx.fillStyle = g; lx.fillRect(X - r, Y - r, r * 2, r * 2);
      });
      S.leak = lt;
    },
    poster: function (S) { return Math.min(S.duration * 0.3, 2.4); },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, f = fract(bt);
      xfade(S, bt, 1, function (sh, a) {
        var k = kb(sh, bt, 0.1, 81, 1.04);
        ctx.globalAlpha = a; drawZoom(ctx, S.ph[sh.p], 0, 0, W, H, k.z, k.px, k.py); ctx.globalAlpha = 1;
      });
      // drifting light leaks (pre-rendered texture, integer offsets = fast 1:1 blit)
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = (0.72 + 0.18 * Math.sin(t * 0.55)) * (0.85 + 0.15 * Math.exp(-f * 3));
      var lox = S.lmx - Math.round(Math.sin(t * 0.23) * S.lmx * 0.95), loy = S.lmy - Math.round(Math.sin(t * 0.17 + 1) * S.lmy * 0.95);
      ctx.drawImage(S.leak, lox, loy, W, H, 0, 0, W, H);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      bokeh(ctx, W, H, t, { n: 8, seed: 27, colors: ['#ffd38a', '#ff9e5e'], min: 0.02, max: 0.06, speed: 0.012, alpha: 0.3, op: 'screen' });
      grain(ctx, W, H, t, 0.14);
      var ta = titleA(S, t), e = endP(S, t, 0.9);
      if (e > 0) fill(ctx, W, H, '#1a0a03', E.inQuad(e) * 0.8);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        bottomShade(ctx, W, H, 0.45 * ta, 0.5, S);
        var yb = H * (W > H ? 0.8 : 0.82);
        var lay = fitText(ctx, tx.title || ' ', 400, 'play', 'italic', M * 0.13, W * 0.84, 0, true), lh = lay.size * 1.1;
        var y0 = yb - (lay.lines.length - 1) * lh, gy0 = Math.max(0, Math.round(y0 - lay.size * 1.6)), gh = Math.min(H - gy0, Math.round((lay.lines.length - 1) * lh + lay.size * 2.2));
        // block sprite + per-word boxes (words fade/rise in one by one during the intro)
        var spr = cached(S, 'gold|' + tx.title + '|' + tx.subtitle, W, gh, function (x, cw, ch) {
          var boxes = [];
          x.textAlign = 'center';
          if (tx.subtitle) {
            var gs2 = fitText(x, tx.subtitle.toUpperCase(), 500, 'outfit', '', M * 0.033, W * 0.84, 0.36, false).size;
            font(x, 500, gs2, 'outfit'); x.fillStyle = '#ffeed6'; shadowOn(x, 'rgba(60,20,0,0.75)', M * 0.014);
            txt(x, tx.subtitle.toUpperCase(), W / 2, (tx.title ? y0 - lay.size * 0.95 : yb) - gy0, gs2 * 0.36); shadowOff(x);
          }
          if (tx.title) {
            font(x, 400, lay.size, 'play', 'italic');
            shadowOn(x, 'rgba(80,30,0,0.6)', M * 0.035, 0, M * 0.004);
            x.fillStyle = '#fff4e0'; x.textAlign = 'left';
            for (var li = 0; li < lay.lines.length; li++) {
              var lw = lay.lines[li].split(/\s+/), total = textW(x, lay.lines[li], 0), xx = W / 2 - total / 2, sw = textW(x, ' ', 0);
              var ly = y0 + li * lh - gy0;
              for (var j = 0; j < lw.length; j++) {
                var ww = textW(x, lw[j], 0);
                x.fillText(lw[j], xx, ly);
                boxes.push([j === 0 ? 0 : Math.round(xx - sw / 2), Math.round(ly - lay.size * 0.86), j === lw.length - 1 ? cw : Math.round(xx + ww + sw / 2), Math.round(lay.size * 1.3)]);
                xx += ww + sw;
              }
            }
            shadowOff(x);
          }
          x.canvas._boxes = boxes;
        });
        var intro = introA(S, t) > 0 && t < S.duration * 0.5, bx = spr._boxes || [];
        if (!intro || !bx.length) { ctx.globalAlpha = ta; ctx.drawImage(spr, 0, gy0); }
        else {
          if (tx.subtitle) { // subtitle strip (outside the word boxes)
            var top = bx.length ? Math.max(0, bx[0][1]) : gh;
            ctx.globalAlpha = ta; if (top > 0) ctx.drawImage(spr, 0, 0, W, top, 0, gy0, W, top);
          }
          for (var wi = 0; wi < bx.length; wi++) {
            var q = bx[wi], wa = ta * smooth(0, 1, (t - 0.15 - wi * 0.12) / 0.5);
            if (wa <= 0.01) continue;
            var bw = Math.max(1, q[2] - q[0]), bh = Math.min(q[3], gh - Math.max(0, q[1])), by = Math.max(0, q[1]);
            ctx.globalAlpha = wa; ctx.drawImage(spr, q[0], by, bw, bh, q[0], gy0 + by + Math.round((1 - wa) * M * 0.03), bw, bh);
          }
        }
        ctx.globalAlpha = 1;
      }
    }
  };

  /* ---------------- CINEMATIC ---------------- */
  IMPL.cinema = {
    cfg: { shotBeats: 8, fill: 'stretch' },
    units: 0.8,
    geo: function (W, H) { var bar = W / H >= 1.5 ? Math.max(0, (H - W / 2.39) / 2) : H * 0.11; return Math.round(bar); },
    prep: async function (S, photos) {
      S.barH = this.geo(S.W, S.H);
      var pH = S.H - S.barH * 2;
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, pH * S.ps, 0.5, 0.45);
        grade(a, { contrast: 1.16, curve: 0.3, sat: 0.92, temp: 0.08, lift: 0.02, gain: 0.97, shadows: '#08707f', shAmt: 0.8, highlights: '#ff9a45', hiAmt: 0.45,
          map: [[0, '#031418'], [0.35, '#1d4c55'], [0.65, '#c08a62'], [1, '#ffe7c8']], mapAmt: 0.22 });
        bloom(a, { thr: 0.6, amt: 0.3, rad: 3, tint: '#ffb070', tintAmt: 0.3 });
        vignette(a, 0.45, '#000000', 0.5);
        return a;
      });
    },
    poster: function (S) { return Math.min(S.duration * 0.25, 2.5); },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, bh = S.barH, pH = H - bh * 2;
      var sh = shotAt(S, bt), L = sh.b1 - sh.b0, lb = bt - sh.b0, P = S.ph[sh.p];
      var u = lb / L, zin = sh.k % 2 === 0;
      var z = zin ? 1.0 + 0.13 * E.inOutSine(sat(u)) : 1.13 - 0.11 * E.inOutSine(sat(u));
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      drawZoom(ctx, P, 0, bh, W, pH, z, hs(sh.k, 91) * 0.8 * (u - 0.5) * 2, hs(sh.k, 92) * 0.4 - 0.1);
      // anamorphic lens flare drifting across
      var sy = bh + pH * (0.3 + 0.25 * hash(sh.k, 93)), sx = lerp(-0.2, 1.2, fract(t * 0.05 + hash(sh.k, 94))) * W;
      var fa = 0.75 + 0.25 * Math.sin(t * 1.3 + sh.k);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * fa; ctx.drawImage(streakSprite(), sx - W * 0.7, sy - M * 0.018, W * 1.4, M * 0.036);
      ctx.globalAlpha = 0.28 * fa; sprite(ctx, glowSprite('#8fc6ff'), sx, sy, M * 0.14, 0); ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      grain(ctx, W, H, t, 0.1);
      // dips to black
      var dip = 0;
      if (sh.k > 0) dip = Math.max(dip, 1 - sat(lb / 0.75));
      if (sh.k < S.plan.shots.length - 1) dip = Math.max(dip, 1 - sat((L - lb) / 0.75));
      dip = Math.max(dip, 1 - sat((t - 0.04) / 0.9));
      var e = endP(S, t, 1.6);
      dip = Math.max(dip, E.inOutSine(sat(e * 1.35)));
      fill(ctx, W, H, '#000', E.inOutSine(dip));
      // bars
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
      // title card
      var ia = introA(S, t) * smooth(0.5, 1.2, t), oa = smooth(S.duration - 1.2, S.duration - 0.7, t);
      var ta = Math.max(ia, oa);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        // opening title sits in the lower third (keeps faces clear); the end card is centred on black
        var cy0 = oa >= ia ? bh + pH / 2 : bh + pH * (W > H ? 0.64 : 0.74);
        var spread = 0.26 + 0.08 * sat(t / (S.bar * 2)) + (oa > 0 ? 0.05 * sat((t - (S.duration - 1.4)) / 1.4) : 0);
        scrim(ctx, W / 2, cy0 + (tx.title && tx.subtitle ? M * 0.03 : 0), Math.min(W * 0.7, M * 1.15), M * 0.22, 0.72 * ta);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.globalAlpha = ta;
        var tsz = 0;
        var tl2 = null, tlh = 0, half = 0;
        if (tx.title) {
          tl2 = fitText(ctx, tx.title.toUpperCase(), 700, 'play', '', M * 0.085, W * 0.82, 0.3, true); // layout at a fixed spread (stable line breaks)
          tsz = Math.min(tl2.size, fitText(ctx, tl2.lines.reduce(function (a, b) { return a.length > b.length ? a : b; }), 700, 'play', '', M * 0.085, W * 0.82, spread, false).size);
          tlh = tsz * 1.45; half = (tl2.lines.length - 1) * tlh / 2;
          font(ctx, 700, tsz, 'play'); shadowOn(ctx, 'rgba(0,0,0,0.6)', M * 0.03);
          ctx.fillStyle = '#f4efe6';
          for (var cl = 0; cl < tl2.lines.length; cl++) txt(ctx, tl2.lines[cl], W / 2, cy0 - half + cl * tlh, tsz * spread);
          shadowOff(ctx);
          var lw2 = Math.min(W * 0.5, M * 0.5) * ta;
          ctx.fillStyle = 'rgba(244,239,230,0.7)';
          ctx.fillRect(W / 2 - lw2 / 2, cy0 - half - tsz * 0.95, lw2, Math.max(1, M * 0.0018));
          ctx.fillRect(W / 2 - lw2 / 2, cy0 + half + tsz * 0.95, lw2, Math.max(1, M * 0.0018));
        }
        if (tx.subtitle) {
          var ss = fitText(ctx, tx.subtitle.toUpperCase(), 500, 'outfit', '', M * 0.034, W * 0.8, 0.42, false).size;
          font(ctx, 500, ss, 'outfit'); ctx.fillStyle = 'rgba(248,244,236,0.95)'; shadowOn(ctx, 'rgba(0,0,0,0.75)', M * 0.02);
          txt(ctx, tx.subtitle.toUpperCase(), W / 2, tx.title ? cy0 + half + tsz * 0.95 + ss * 2.2 : cy0, ss * 0.42); shadowOff(ctx);
        }
        ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
      }
    }
  };

  /* ---------------- RETRO VHS ---------------- */
  IMPL.vhs = {
    cfg: { shotBeats: 4, fill: 'repeat' },
    units: 0.3,
    prep: async function (S, photos) {
      var hw = Math.max(32, S.PW * 0.5), hh = Math.max(32, S.PH * 0.5);
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, hw, hh);
        grade(a, { contrast: 0.9, curve: 0.15, sat: 1.22, lift: 0.07, gain: 0.95, temp: 0.12, tint: 0.04, shadows: '#1b2a7b', shAmt: 0.4, highlights: '#fff0c8', hiAmt: 0.15 },
          function (d, w, h) { // chroma bleed: red smeared right, blue left
            var src = new Uint8ClampedArray(d), o = Math.max(1, Math.round(w / 220));
            for (var y = 0; y < h; y++) for (var xx = 0; xx < w; xx++) {
              var i = (y * w + xx) * 4, ir = (y * w + Math.max(0, xx - o * 2)) * 4, ib = (y * w + Math.min(w - 1, xx + o)) * 4, il = (y * w + Math.max(0, xx - o)) * 4;
              d[i] = src[ir] * 0.6 + src[il] * 0.4; d[i + 2] = src[ib] * 0.7 + src[i + 2] * 0.3;
            }
          });
        bloom(a, { thr: 0.55, amt: 0.4, rad: 2, scale: 6 });
        vignette(a, 0.55, '#050510', 0.4);
        return a;
      });
      var ms = monthStamp(), MON = ['JAN.', 'FEB.', 'MAR.', 'APR.', 'MAY', 'JUN.', 'JUL.', 'AUG.', 'SEP.', 'OCT.', 'NOV.', 'DEC.'];
      S.date = MON[ms.m] + ' ' + (ms.d < 10 ? '0' : '') + ms.d + ' 1998';
    },
    poster: function (S) { return Math.min(S.duration * 0.3, 2.6); },
    hud: function (ctx, s, x, y, size) {
      ctx.globalAlpha = 0.55; ctx.fillStyle = '#ff2a6a'; ctx.fillText(s, x - size * 0.05, y);
      ctx.fillStyle = '#28d8ff'; ctx.fillText(s, x + size * 0.05, y);
      ctx.globalAlpha = 1; ctx.fillStyle = '#f4f4f4'; ctx.fillText(s, x, y);
    },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, e = endP(S, t, 0.8), tp = Math.min(t, S.duration - 0.8);
      var bt = tp / S.beat + 1e-6, sh = shotAt(S, bt), lb = bt - sh.b0, P = S.ph[sh.p], bi = Math.floor(bt);
      var k = kb(sh, bt, 0.05, 101, 1.06);
      var px = k.px + Math.sin(t * 1.7 + sh.k) * 0.12, py = k.py + Math.cos(t * 1.3 + sh.k) * 0.12;
      var fr = Math.floor(t * 30);
      drawZoom(ctx, P, 0, 0, W, H, k.z, px, py);
      // tracking tear events
      var ev = 0, evy = 0;
      if (sh.k > 0 && lb < 0.45) { ev = 1 - lb / 0.45; evy = lb / 0.45; }
      else { var eb = fract(bt); if (hash(bi, 21) > 0.7 && eb < 0.35) { ev = Math.sin(Math.PI * eb / 0.35) * 0.6; evy = hash(bi, 22) * 0.7 + eb; } }
      if (e > 0) { ev = Math.max(ev, e); evy = fract(t * 1.7); }
      if (ev > 0.02) {
        var by = (evy % 1) * H, bhh = H * (0.05 + 0.1 * ev), sl = [];
        for (var s = 0; s < 8; s++) {
          var y0 = by + s * bhh / 8, y1 = y0 + bhh / 8 + 1;
          sl.push([y0, y1, Math.sin(s * 1.3 + fr * 0.9) * M * 0.05 * ev]);
        }
        drawSlices(ctx, P, 0, 0, W, H, k.z, px, py, sl, 0);
        ctx.globalAlpha = 0.45 * ev;
        patFill(ctx, snowTile(), 0, by + bhh * 0.3, W, Math.max(2, bhh * 0.25), Math.floor(hash(fr, 1) * 160), Math.floor(hash(fr, 2) * 160));
        ctx.globalAlpha = 1;
      }
      // head-switching noise at the bottom edge
      var hb = Math.max(3, H * 0.018);
      drawSlices(ctx, P, 0, 0, W, H, k.z, px, py, [[H - hb, H, M * 0.025 * (0.5 + hash(fr, 7))]], 0);
      ctx.globalAlpha = 0.5; patFill(ctx, snowTile(), 0, H - hb * 0.6, W, hb * 0.6, Math.floor(hash(fr, 3) * 160), 0); ctx.globalAlpha = 1;
      // cut snow burst
      if (sh.k > 0 && lb < 0.2) { ctx.globalAlpha = 0.5 * (1 - lb / 0.2); patFill(ctx, snowTile(), 0, 0, W, H, Math.floor(hash(fr, 4) * 160), Math.floor(hash(fr, 5) * 160)); ctx.globalAlpha = 1; }
      scanlines(ctx, W, H, M, 0.22, fr % 2);
      ctx.globalCompositeOperation = 'lighter'; grain(ctx, W, H, t, 0.07); ctx.globalCompositeOperation = 'source-over';
      if (e > 0) fill(ctx, W, H, '#03030c', E.inQuad(e) * 0.85);
      // HUD
      var fs = M * 0.06, m = M * 0.065;
      font(ctx, 400, fs, 'vt'); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      shadowOn(ctx, 'rgba(0,0,0,0.6)', 0, Math.max(1, fs * 0.04), Math.max(1, fs * 0.04));
      var label = e > 0.35 ? 'STOP' : 'PLAY';
      if (e > 0.35 || Math.floor(t * 1.6) % 2 === 0 || t > 3) {
        this.hud(ctx, label, m, m + fs * 0.7, fs);
        var tw = textW(ctx, label + ' ', 0), ts = fs * 0.55, tx0 = m + tw;
        ctx.fillStyle = '#f4f4f4'; ctx.beginPath();
        if (label === 'PLAY') { ctx.moveTo(tx0, m + fs * 0.7 - ts); ctx.lineTo(tx0 + ts * 0.9, m + fs * 0.7 - ts / 2); ctx.lineTo(tx0, m + fs * 0.7); }
        else ctx.rect(tx0, m + fs * 0.7 - ts, ts * 0.85, ts * 0.85);
        ctx.fill();
      }
      var secs = Math.floor(t), tc = 'SP  0:' + (secs < 600 ? '0' : '') + Math.floor(secs / 60) + ':' + (secs % 60 < 10 ? '0' : '') + (secs % 60);
      font(ctx, 400, fs * 0.8, 'vt');
      this.hud(ctx, tc, m, H - m * 1.15, fs);
      ctx.textAlign = 'right';
      this.hud(ctx, 'PM 7:42', W - m, H - m * 1.15 - fs * 0.85, fs);
      this.hud(ctx, S.date, W - m, H - m * 1.15, fs);
      shadowOff(ctx);
      // camcorder title (typewriter)
      var ta = titleA(S, t);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        ctx.textAlign = 'center';
        shadowOn(ctx, 'rgba(0,0,0,0.6)', 0, Math.max(1, M * 0.004), Math.max(1, M * 0.004));
        var it = introA(S, t) > 0 && t < S.duration / 2 ? t - 0.3 : 99;
        if (tx.title) {
          var lay = fitText(ctx, tx.title.toUpperCase(), 400, 'vt', '', M * 0.16, W - m * 2.5, 0.05, true), lh = lay.size * 0.95, cnt = 0;
          font(ctx, 400, lay.size, 'vt'); ctx.globalAlpha = ta;
          for (var li = 0; li < lay.lines.length; li++) {
            var line = lay.lines[li], show = Math.max(0, Math.min(line.length, Math.floor(it * 14) - cnt));
            cnt += line.length;
            var full = textW(ctx, line, lay.size * 0.05), part = Array.from(line).slice(0, show).join('');
            ctx.textAlign = 'left';
            this.hud(ctx, part, W / 2 - full / 2, H * 0.5 + (li - (lay.lines.length - 1) / 2) * lh + lay.size * 0.3, lay.size);
          }
          ctx.textAlign = 'center';
        }
        if (tx.subtitle) {
          var ssz = fitText(ctx, tx.subtitle.toUpperCase(), 400, 'vt', '', M * 0.065, W - m * 3, 0.05, false).size;
          font(ctx, 400, ssz, 'vt'); ctx.globalAlpha = ta * (it > 0.8 || it === 99 ? 1 : 0);
          var tl = tx.title ? fitText(ctx, tx.title.toUpperCase(), 400, 'vt', '', M * 0.16, W - m * 2.5, 0.05, true) : null;
          var sy0 = tl ? H * 0.5 + ((tl.lines.length - 1) / 2) * tl.size * 0.95 + tl.size * 0.3 + ssz * 1.25 : H * 0.5;
          this.hud(ctx, tx.subtitle.toUpperCase(), W / 2, sy0, ssz);
        }
        ctx.globalAlpha = 1; shadowOff(ctx);
      }
    }
  };

  /* ---------------- BEAT DROP ---------------- */
  IMPL.beat = {
    cfg: { shotBeats: 1, perPhoto: 4, fill: 'repeat' },
    units: 1.3,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, S.PH);
        grade(a, { contrast: 1.22, curve: 0.3, sat: 1.25, vib: 0.2, skin: 0.6, exposure: 1.02, shadows: '#1a2b6b', shAmt: 0.35, highlights: '#ffe0b0', hiAmt: 0.15 });
        bloom(a, { thr: 0.55, amt: 0.35, rad: 2 });
        vignette(a, 0.45);
        var sp = rgbSplit(a, 0.5);
        return { a: a, r: sp.r, gb: sp.gb };
      });
    },
    cut: function (S, bt) {
      var tot = S.plan.beats, last = tot - 4, n = S.n, c, cs, sub = 0;
      if (bt < 4) { c = Math.floor(bt / 2); cs = c * 2; }
      else if (bt >= last && last >= 4) { c = 2 + (last - 4); cs = last; }
      else { var bi = Math.floor(bt); c = 2 + (bi - 4); cs = bi; if (bi % 8 === 7 && bt - bi >= 0.5) { sub = 1; cs = bi + 0.5; } }
      return { c: c, cs: cs, p: c % n, v: Math.floor(c / n) + sub * 3, sub: sub };
    },
    poster: function (S) { return S.beat * 5.4; },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, tot = S.plan.beats;
      var C = this.cut(S, bt), f = bt - C.cs, P = S.ph[C.p], build = bt < 4, drop = C.c === 2 || (C.cs >= tot - 4 && bt >= 4);
      var ZS = [1.04, 1.24, 1.12, 1.38, 1.18];
      var z = ZS[C.v % ZS.length] + (build ? 0.06 : 0.15) * Math.exp(-f * 7);
      if (bt >= tot - 4) z += 0.05 * sat((bt - (tot - 4)) / 4);
      var px = hs(C.c * 7 + C.sub, 3) * 0.9, py = hs(C.c * 7 + C.sub, 4) * 0.7;
      var amp = M * (drop ? 0.035 : build ? 0.006 : 0.016) * Math.exp(-f * 7), fq = Math.floor(t * 30);
      var dx = hs(fq, 5) * amp, dy = hs(fq, 6) * amp;
      var rgbOn = !build && (drop || (Math.floor(bt) % 16 === 4)) ? M * 0.03 * Math.exp(-f * 3.2) : 0;
      if (rgbOn > M * 0.012) { // split copies are half-res: only use them while the flash/shake hides it
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        var ov = M * 0.04; // overscan (same in both paths) so shifted channels never leave coloured strips at the edges
        drawZoom(ctx, P.r, -amp - ov + dx + rgbOn, -amp - ov + dy, W + (amp + ov) * 2, H + (amp + ov) * 2, z, px, py);
        ctx.globalCompositeOperation = 'lighter';
        drawZoom(ctx, P.gb, -amp - ov + dx - rgbOn, -amp - ov + dy, W + (amp + ov) * 2, H + (amp + ov) * 2, z, px, py);
        ctx.globalCompositeOperation = 'source-over';
      } else drawZoom(ctx, P.a, -amp - M * 0.04 + dx, -amp - M * 0.04 + dy, W + (amp + M * 0.04) * 2, H + (amp + M * 0.04) * 2, z, px, py);
      if (build) { // moody monochrome build-up
        ctx.globalAlpha = 0.9; ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        fill(ctx, W, H, '#000', 0.25 * (1 - fract(bt / 2)));
      }
      fill(ctx, W, H, '#ffffff', (drop ? 0.85 : build ? 0.35 : C.sub ? 0.4 : 0.5) * Math.exp(-f * 9));
      // text
      var words = (tx.title || '').toUpperCase().split(/\s+/).filter(Boolean);
      if (build && words.length) {
        var wd = words[Math.floor(bt) % words.length], wf = fract(bt);
        var sz = fitText(ctx, wd, 400, 'anton', '', M * 0.3, W * 0.86, 0.01, false).size * (1.15 - 0.15 * E.outCubic(sat(wf * 3)));
        font(ctx, 400, sz, 'anton'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        shadowOn(ctx, 'rgba(0,0,0,0.5)', M * 0.03); ctx.fillStyle = '#fff'; ctx.globalAlpha = smooth(0.0, 0.1, bt) * (1 - smooth(3.7, 4, bt));
        ctx.fillText(wd, W / 2, H / 2); shadowOff(ctx); ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
      }
      var oa = outroA(S, t, S.bar - 0.05);
      if (oa > 0.01 && (tx.title || tx.subtitle)) {
        var pop = 1 + 0.18 * Math.exp(-(bt - (tot - 4)) * 5);
        scrim(ctx, W / 2, H / 2, Math.min(W * 0.62, M * 1.05), M * 0.32, 0.55 * oa);
        ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(pop, pop); ctx.globalAlpha = oa;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (tx.title) {
          var lay = fitText(ctx, tx.title.toUpperCase(), 400, 'anton', '', M * 0.22, W * 0.88, 0.01, true), lh = lay.size * 0.98;
          font(ctx, 400, lay.size, 'anton'); shadowOn(ctx, 'rgba(0,0,0,0.55)', M * 0.035);
          for (var li = 0; li < lay.lines.length; li++) {
            var yy = (li - (lay.lines.length - 1) / 2) * lh;
            ctx.fillStyle = '#ff2d55'; ctx.fillText(lay.lines[li], M * 0.008, yy + M * 0.008);
            ctx.fillStyle = '#ffffff'; ctx.fillText(lay.lines[li], 0, yy);
          }
          shadowOff(ctx);
        }
        if (tx.subtitle) {
          var ss = fitText(ctx, tx.subtitle.toUpperCase(), 700, 'outfit', '', M * 0.04, W * 0.8, 0.3, false).size;
          font(ctx, 700, ss, 'outfit'); ctx.fillStyle = '#fff';
          var ly = tx.title ? fitText(ctx, tx.title.toUpperCase(), 400, 'anton', '', M * 0.22, W * 0.88, 0.01, true) : null;
          txt(ctx, tx.subtitle.toUpperCase(), 0, ly ? (ly.lines.length * ly.size * 0.5 + ss * 1.6) : 0, ss * 0.3);
        }
        ctx.restore(); ctx.textBaseline = 'alphabetic';
      }
      var e = endP(S, t, 0.6);
      if (e > 0) fill(ctx, W, H, '#000', E.inQuad(e) * 0.9);
    }
  };

  /* ---------------- MEMORIES (polaroids) ---------------- */
  var POLA = { contrast: 1.02, curve: 0.15, sat: 0.96, temp: 0.16, lift: 0.05, gain: 0.97, fade: 0.04, shadows: '#3b2a4a', shAmt: 0.25, highlights: '#fff0d6', hiAmt: 0.2 };
  IMPL.polaroid = {
    cfg: { shotBeats: 4, fill: 'stretch' },
    units: 0.45,
    prep: async function (S, photos) {
      var W = S.W, H = S.H, M = S.M;
      S.cw = Math.min(W * 0.68, H * 0.74 / 1.2); S.chh = S.cw * 1.2; S.pad = S.cw * 0.09;
      var sc = S.ps, self = this;
      S.cards = await prepEach(S, photos, function (p, i) { return self.card(S, p, i, sc); });
      // surface: soft warm linen
      var sf = mk(W, H), x = cx(sf), g = x.createLinearGradient(0, 0, W * 0.4, H);
      g.addColorStop(0, '#f1e6db'); g.addColorStop(1, '#d9c6b5'); x.fillStyle = g; x.fillRect(0, 0, W, H);
      var lt = x.createRadialGradient(W * 0.25, H * 0.15, 0, W * 0.25, H * 0.15, Math.max(W, H) * 0.8);
      lt.addColorStop(0, 'rgba(255,250,240,0.7)'); lt.addColorStop(1, 'rgba(255,250,240,0)'); x.fillStyle = lt; x.fillRect(0, 0, W, H);
      var R = mulberry32(5), st = Math.max(2, Math.round(M / 260));
      x.globalAlpha = 0.05; x.fillStyle = '#6b5442';
      for (var yy = 0; yy < H; yy += st) if (R() < 0.55) x.fillRect(0, yy, W, Math.max(1, st * 0.4));
      for (var xx = 0; xx < W; xx += st) if (R() < 0.45) x.fillRect(xx, 0, Math.max(1, st * 0.4), H);
      x.globalAlpha = 0.06; x.fillStyle = pattern(x, noiseTiles()[0]); x.fillRect(0, 0, W, H); x.globalAlpha = 1;
      vignette(sf, 0.28, '#5a4030', 0.55);
      S.surface = sf;
      // soft shadow sprite
      var sw = 100, shh = 120, ss = mk(sw, shh), sx = cx(ss);
      sx.fillStyle = '#000'; sx.fillRect(0, 0, sw, shh);
      var id = sx.getImageData(0, 0, sw, shh), d = id.data;
      for (var i = 0; i < d.length; i += 4) { var px = (i / 4) % sw, py = Math.floor(i / 4 / sw), inside = px >= 15 && px < 85 && py >= 15 && py < 105; d[i] = d[i + 1] = d[i + 2] = inside ? 255 : 0; }
      boxBlur(d, sw, shh, 5, 3);
      for (i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = 40; d[i + 1] = 25; d[i + 2] = 15; }
      sx.putImageData(id, 0, 0); S.shadow = ss;
      // placements
      S.place = S.plan.shots.map(function (shot, k) {
        var spreadX = (W - S.cw) * (W > H ? 0.36 : 0.26), spreadY = (H - S.chh) * 0.28;
        var f = k === 0 ? 0.3 : 1, sx = (k % 2 ? 1 : -1) * (0.35 + 0.65 * hash(k, 201)), sy = ((k >> 1) % 2 ? 1 : -1) * (0.3 + 0.7 * hash(k, 202));
        return { x: W / 2 + sx * spreadX * f, y: H * 0.5 + sy * spreadY * f, r: (k % 2 ? 1 : -1) * (0.035 + 0.09 * hash(k, 203)) * (k === 0 ? 0.6 : 1) };
      });
      S.pile = mk(W, H); S.pileL = -1; S.pileKey = null;
    },
    card: function (S, photo, i, sc) {
      var cw = S.cw * sc, chh = S.chh * sc, pad = S.pad * sc;
      var c = mk(cw + pad * 2, chh + pad * 2), x = cx(c);
      var side = cw * 0.055, top = cw * 0.055, bottom = cw * 0.25, phw = cw - side * 2, phh = chh - top - bottom;
      var g = x.createLinearGradient(pad, pad, pad + cw, pad + chh);
      g.addColorStop(0, '#fffefa'); g.addColorStop(1, '#f1ece2');
      x.fillStyle = g; x.fillRect(pad, pad, cw, chh);
      var p = coverCrop(photo, phw, phh, 0.5, 0.42);
      grade(p, POLA); bloom(p, { thr: 0.6, amt: 0.3, rad: 2 }); vignette(p, 0.28, '#20140a', 0.5);
      x.drawImage(p, pad + side, pad + top); free(p);
      x.strokeStyle = 'rgba(0,0,0,0.12)'; x.lineWidth = Math.max(1, cw * 0.002); x.strokeRect(pad + side, pad + top, phw, phh);
      x.globalAlpha = 0.05; x.fillStyle = pattern(x, noiseTiles()[1]); x.fillRect(pad, pad, cw, chh); x.globalAlpha = 1;
      x.strokeStyle = 'rgba(0,0,0,0.08)'; x.strokeRect(pad + 0.5, pad + 0.5, cw - 1, chh - 1);
      if (hash(i, 211) > 0.35) { // washi tape
        var tw = cw * 0.34, th = cw * 0.085, cols = ['rgba(255,190,200,0.72)', 'rgba(180,220,255,0.7)', 'rgba(255,235,160,0.75)', 'rgba(200,240,210,0.7)'];
        x.save(); x.translate(pad + cw * (0.5 + hs(i, 212) * 0.15), pad + th * 0.15); x.rotate(hs(i, 213) * 0.12);
        x.fillStyle = cols[i % cols.length]; x.fillRect(-tw / 2, -th / 2, tw, th);
        x.fillStyle = 'rgba(255,255,255,0.25)'; for (var s = -tw / 2; s < tw / 2; s += th * 0.6) x.fillRect(s, -th / 2, th * 0.25, th);
        x.restore();
      }
      return { c: c, side: side, top: top, bottom: bottom, pad: pad, cw: cw, chh: chh, phw: phw, phh: phh, sc: sc };
    },
    caption: function (S, i, tx) {
      var n = S.n;
      if (i === 0) return tx.title || (n === 1 ? tx.subtitle : '');
      if (i === n - 1) return tx.subtitle || '';
      return '';
    },
    doodle: function (ctx, kind, x, y, s) {
      ctx.strokeStyle = 'rgba(200,70,90,0.85)'; ctx.lineWidth = Math.max(1, s * 0.12); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (kind === 0) { ctx.moveTo(x, y + s * 0.35); ctx.bezierCurveTo(x - s * 0.9, y - s * 0.2, x - s * 0.35, y - s * 0.85, x, y - s * 0.35); ctx.bezierCurveTo(x + s * 0.35, y - s * 0.85, x + s * 0.9, y - s * 0.2, x, y + s * 0.35); }
      else { ctx.strokeStyle = 'rgba(230,160,40,0.9)'; for (var k = 0; k < 6; k++) { var a = -Math.PI / 2 + k * 4 * Math.PI / 5; ctx.lineTo(x + Math.cos(a) * s * 0.55, y + Math.sin(a) * s * 0.55); } }
      ctx.stroke(); ctx.lineCap = 'butt';
    },
    drawCard: function (S, ctx, i, sc, lift, alpha, tx, write, mode) {
      var C = S.cards[S.plan.shots[i].p], pl = S.place[i], M = S.M, k = 1 / C.sc;
      ctx.save(); ctx.translate(pl.x, pl.y - lift * S.chh * 0.22); ctx.rotate(pl.r + lift * 0.25 * (i % 2 ? -1 : 1)); ctx.scale(sc, sc);
      if (mode !== 'cap') {
        ctx.globalAlpha = alpha * (0.5 - lift * 0.2);
        var sx = S.cw / 70, sy = S.chh / 90, so = M * (0.012 + lift * 0.06);
        ctx.drawImage(S.shadow, -50 * sx + so * 0.6, -60 * sy + so, 100 * sx * (1 + lift * 0.1), 120 * sy * (1 + lift * 0.1));
        ctx.globalAlpha = alpha;
        ctx.drawImage(C.c, -S.cw / 2 - S.pad, -S.chh / 2 - S.pad, C.c.width * k, C.c.height * k);
      }
      if (mode === 'card') { ctx.restore(); return; }
      ctx.globalAlpha = alpha;
      // caption
      var cap = this.caption(S, i, tx), cy0 = -S.chh / 2 + (C.top + C.phh + C.bottom * 0.55) * k, cwid = C.phw * k;
      if (write > 0) {
        ctx.save(); ctx.beginPath(); ctx.rect(-S.cw / 2, cy0 - S.cw * 0.15, S.cw * (0.04 + 0.96 * write), S.cw * 0.3); ctx.clip();
        if (cap) {
          var lay = fitText(ctx, cap, 700, 'caveat', '', S.cw * 0.105, cwid * 0.94, 0, false);
          font(ctx, 700, lay.size, 'caveat'); ctx.fillStyle = 'rgba(40,36,52,0.92)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(cap, 0, cy0); ctx.textBaseline = 'alphabetic';
        } else this.doodle(ctx, i % 2, S.cw * 0.28, cy0 + S.cw * 0.02, S.cw * 0.07);
        ctx.restore();
      }
      ctx.restore();
    },
    land: function (S, i) { return S.plan.shots[i].b0 + (i === 0 ? 1 : 0); },
    poster: function (S) { return Math.min(S.duration - 0.5, (this.land(S, 0) + 2) * S.beat); },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, bt = t / S.beat + 1e-6, D = 0.8, WR = 1.6, ST = 0.4, n = S.plan.shots.length, key = tx.title + '\u0001' + tx.subtitle + '\u0001' + FONT_GEN;
      // pile cache levels: card j baked at level 2j+1, its caption at 2j+2
      var landed = 0, done = 0;
      while (landed < n && bt >= this.land(S, landed) + ST) landed++;
      while (done < landed && bt >= this.land(S, done) + WR) done++;
      var lvl = landed + done, pc = cx(S.pile);
      if (S.pileKey !== key || lvl < S.pileL) {
        pc.setTransform(1, 0, 0, 1, 0, 0); pc.globalAlpha = 1; pc.globalCompositeOperation = 'source-over';
        pc.drawImage(S.surface, 0, 0); S.pileL = 0; S.pileKey = key;
      }
      while (S.pileL < lvl) {
        var j = S.pileL >> 1;
        this.drawCard(S, pc, j, 1, 0, 1, tx, 1, S.pileL % 2 ? 'cap' : 'card');
        S.pileL++;
      }
      // a single photo gets a slow camera push-in over the table so the piece never feels static
      if (S.n === 1) {
        var cs = 1 + 0.09 * E.inOutSine(sat(t / S.duration));
        ctx.setTransform(cs, 0, 0, cs, W / 2 * (1 - cs) + Math.sin(t * 0.21) * S.M * 0.008, H / 2 * (1 - cs) + Math.cos(t * 0.17) * S.M * 0.006);
      }
      ctx.drawImage(S.pile, 0, 0);
      if (landed > done) this.drawCard(S, ctx, done, 1, 0, 1, tx, sat((bt - this.land(S, done) - 0.15) / (WR - 0.3)), 'cap');
      for (var i = landed; i < n; i++) {
        var L0 = this.land(S, i);
        if (bt < L0 - D) break;
        var q = sat((bt - (L0 - D)) / D), eq = E.outCubic(q);
        var settle = bt >= L0 ? 1 + 0.025 * Math.exp(-(bt - L0) * 9) * Math.cos((bt - L0) * 30) : 1;
        var sc = lerp(1.4, 1, eq) * settle, lift = 1 - eq;
        this.drawCard(S, ctx, i, sc, lift, sat(q * 9), tx, sat((bt - L0 - 0.15) / (WR - 0.3)), 'full');
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // floating dust in the window light
      bokeh(ctx, W, H, t, { n: 9, seed: 205, colors: ['#fff3dc', '#ffe2b8'], min: 0.004, max: 0.012, speed: 0.012, drift: 0.05, alpha: 0.5, op: 'screen' });
      grain(ctx, W, H, t, 0.06);
      var e = endP(S, t, 0.85);
      if (e > 0) fill(ctx, W, H, '#f6eee4', E.inQuad(e) * 0.8);
    }
  };

  /* ---------------- DREAMY ---------------- */
  IMPL.dreamy = {
    cfg: { shotBeats: 8, fill: 'stretch' },
    units: 1,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, S.PH);
        grade(a, { contrast: 0.94, curve: 0.1, lift: 0.07, gain: 1.0, sat: 1.06, vib: 0.25, temp: 0.05, tint: 0.07, shadows: '#7a5cc4', shAmt: 0.4, highlights: '#ffc9e6', hiAmt: 0.34, pastel: 0.035, exposure: 1.05 });
        bloom(a, { thr: 0.38, amt: 0.5, rad: 3, tint: '#ffd0ee', tintAmt: 0.3 });
        var x = cx(a), g = x.createLinearGradient(0, 0, 0, a.height * 0.5);
        g.addColorStop(0, 'rgba(255,236,250,0.35)'); g.addColorStop(1, 'rgba(255,236,250,0)');
        x.fillStyle = g; x.fillRect(0, 0, a.width, a.height * 0.5);
        vignette(a, 0.26, '#fff0fa', 0.55);
        return a;
      });
    },
    poster: function (S) { return Math.min(S.duration * 0.3, 2.2); },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, f = fract(bt);
      xfade(S, bt, 2.4, function (sh, a) {
        var k = kb(sh, bt, 0.08, 131, 1.03);
        ctx.globalAlpha = a; drawZoom(ctx, S.ph[sh.p], 0, 0, W, H, k.z, k.px, k.py); ctx.globalAlpha = 1;
      });
      bokeh(ctx, W, H, t, { n: 20, seed: 33, colors: ['#ffd1f0', '#c9b6ff', '#bfefff', '#fff1c1'], min: 0.02, max: 0.11, speed: 0.018, alpha: 0.45, pulse: 0.85 + 0.15 * Math.exp(-f * 3), op: 'screen' });
      sparkles(ctx, W, H, t, { n: 10, seed: 34, alpha: 0.7, min: 0.025, max: 0.05, colors: ['#ffffff', '#ffe6fb'] });
      var e = endP(S, t, 1.0);
      if (e > 0) fill(ctx, W, H, '#fff4fb', E.inQuad(e) * 0.65);
      var ta = titleA(S, t);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        var cy0 = H * 0.5, tsz = 0, lay = null;
        scrim(ctx, W / 2, cy0 + (tx.subtitle ? M * 0.03 : 0), Math.min(W * 0.6, M * 0.95), M * 0.26, 0.3 * ta, '#5b2b72');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (tx.title) {
          lay = fitText(ctx, tx.title, 400, 'play', 'italic', M * 0.14, W * 0.84, 0, true); tsz = lay.size;
          font(ctx, 400, tsz, 'play', 'italic');
          shadowOn(ctx, 'rgba(190,90,170,0.65)', M * 0.05); ctx.fillStyle = '#ffffff';
          var ci = 0, intro = introA(S, t) > 0 && t < S.duration / 2;
          for (var li = 0; li < lay.lines.length; li++) {
            var line = lay.lines[li], chars = Array.from(line), lw = textW(ctx, line, 0), xx = W / 2 - lw / 2, yy = cy0 + (li - (lay.lines.length - 1) / 2) * tsz * 1.1;
            ctx.textAlign = 'left';
            for (var c = 0; c < chars.length; c++) {
              var ca = intro ? smooth(0, 1, (t - 0.2 - ci * 0.05) / 0.6) : 1;
              ctx.globalAlpha = ta * ca; ctx.fillText(chars[c], xx, yy - (1 - ca) * M * 0.015);
              xx += ctx.measureText(chars[c]).width; ci++;
            }
          }
          ctx.textAlign = 'center'; shadowOff(ctx);
        }
        if (tx.subtitle) {
          var ss = fitText(ctx, tx.subtitle.toLowerCase(), 500, 'outfit', '', M * 0.042, W * 0.8, 0.26, false).size;
          font(ctx, 500, ss, 'outfit'); ctx.globalAlpha = ta; shadowOn(ctx, 'rgba(100,30,120,0.95)', M * 0.018); ctx.fillStyle = '#fff';
          txt(ctx, tx.subtitle.toLowerCase(), W / 2, lay ? cy0 + lay.lines.length * tsz * 0.55 + ss * 1.8 : cy0, ss * 0.26);
          shadowOff(ctx);
        }
        ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
      }
    }
  };

  /* ---------------- COVER STAR (magazine) ---------------- */
  var COVER_PAL = [
    { mast: '#ffffff', acc: '#ff2e63', acc2: '#ffd400' },
    { mast: '#ff2e63', acc: '#ffffff', acc2: '#ffd400' },
    { mast: '#ffd400', acc: '#ffffff', acc2: '#ff2e63' },
    { mast: '#7df9ff', acc: '#ffd400', acc2: '#ff2e63' }
  ];
  IMPL.cover = {
    cfg: { shotBeats: 2, perPhoto: 4, fill: 'repeat' },
    units: 1,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, S.PH, 0.5, 0.4);
        grade(a, { contrast: 1.12, curve: 0.22, sat: 1.12, vib: 0.2, skin: 0.6, temp: 0.06, exposure: 1.03, highlights: '#fff1e0', hiAmt: 0.1, shadows: '#3a1f4a', shAmt: 0.25 });
        bloom(a, { thr: 0.6, amt: 0.28, rad: 2 });
        edgeGrad(a, 0.45, 0.6);
        if (S.W > S.H * 1.2) { var lx2 = cx(a), lg2 = lx2.createLinearGradient(0, 0, a.width * 0.6, 0); lg2.addColorStop(0, 'rgba(0,0,0,0.5)'); lg2.addColorStop(1, 'rgba(0,0,0,0)'); lx2.fillStyle = lg2; lx2.fillRect(0, 0, a.width * 0.6, a.height); }
        return a;
      });
      var ms = monthStamp(); S.issue = MONTHS[ms.m] + ' ' + ms.y;
      var R = mulberry32(77); S.bars = [];
      for (var i = 0; i < 34; i++) S.bars.push(R() < 0.5 ? 1 : R() < 0.6 ? 2 : 3);
    },
    poster: function (S) { return Math.min(S.duration - 0.4, S.beat * 5.2); },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, land = W > H;
      var sh = shotAt(S, bt), lb = bt - sh.b0, P = S.ph[sh.p], pal = COVER_PAL[sh.k % COVER_PAL.length];
      var z = 1.0 + 0.07 * (1 - E.outCubic(sat(lb / 0.8))) + 0.025 * sat(lb / 2);
      drawZoom(ctx, P, 0, 0, W, H, z, hs(sh.k, 141) * 0.5, -0.1);
      var m = M * 0.055, ip = bt; // intro progress in beats
      ctx.textBaseline = 'alphabetic';
      // masthead
      var mast = (tx.title || 'GLOW').toUpperCase();
      var mw = land ? W * 0.5 : W - m * 2, maxS = Math.min(M * 0.42, H * 0.25);
      var ms = fitText(ctx, mast, 400, 'anton', '', maxS, mw, -0.005, false).size, mLines = [mast];
      if (ms < M * 0.13 && /\s/.test(mast)) { // long titles: a two-line masthead reads better than a tiny one
        var l2 = fitText(ctx, mast, 400, 'anton', '', Math.min(maxS, M * 0.17), mw, -0.005, true);
        if (l2.lines.length === 2 && l2.size > ms * 1.15) { mLines = l2.lines; ms = l2.size; }
      }
      font(ctx, 400, ms, 'anton');
      var capH = ms * 0.76, mY = m * 1.75 + capH, sp = -ms * 0.005, ci = 0, cstep = Math.min(0.22, 2.6 / Math.max(1, Array.from(mast).length));
      shadowOn(ctx, 'rgba(0,0,0,0.35)', M * 0.02, 0, M * 0.006);
      ctx.textAlign = 'left'; ctx.fillStyle = pal.mast;
      for (var ml = 0; ml < mLines.length; ml++) {
        if (ml) mY += ms * 0.92;
        var chars = Array.from(mLines[ml]), mx = land ? m : W / 2 - textW(ctx, mLines[ml], sp) / 2;
        for (var i = 0; i < chars.length; i++, ci++) {
          var a = E.outCubic(sat((ip - ci * cstep) / 0.5));
          if (a > 0.01) { ctx.globalAlpha = a; ctx.fillText(chars[i], mx, mY - (1 - a) * ms * 0.25); }
          mx += ctx.measureText(chars[i]).width + sp;
        }
      }
      ctx.globalAlpha = 1; shadowOff(ctx);
      // kicker above masthead
      var ks = M * 0.024;
      font(ctx, 700, ks, 'outfit'); ctx.fillStyle = '#ffffff'; ctx.globalAlpha = smooth(0.3, 1.0, ip);
      shadowOn(ctx, 'rgba(0,0,0,0.4)', M * 0.01);
      ctx.textAlign = 'left'; txt(ctx, 'THE ICONS ISSUE', m, m * 1.0, ks * 0.25);
      ctx.textAlign = 'right'; txt(ctx, S.issue, W - m, m * 1.0, ks * 0.25);
      ctx.globalAlpha = 1;
      // cover lines (left column)
      var cy0 = mY + M * 0.09, colW = land ? W * 0.3 : W * 0.42;
      var main = (tx.subtitle || 'Main Character Energy').toUpperCase();
      var lay = fitText(ctx, main, 800, 'outfit', '', M * 0.075, land ? W * 0.45 : W * 0.6, 0, true);
      var lh = lay.size * 1.02, yb = H - m * 1.2 - (lay.lines.length - 1) * lh, mainTop = yb - lay.size - M * 0.07;
      var room = mainTop - cy0; // drop cover lines that would collide with the main line (square / landscape)
      var a1 = E.outCubic(sat((ip - 1) / 0.5)), a2 = E.outCubic(sat((ip - 1.5) / 0.5)), a3 = E.outCubic(sat((ip - 2) / 0.5));
      ctx.textAlign = 'left';
      if (a1 > 0.01) {
        var off1 = (1 - a1) * -M * 0.08; ctx.globalAlpha = a1;
        font(ctx, 400, M * 0.13, 'anton'); ctx.fillStyle = pal.acc2; ctx.fillText('10', m + off1, cy0 + M * 0.1);
        var nw = ctx.measureText('10').width + M * 0.02;
        font(ctx, 800, M * 0.036, 'outfit'); ctx.fillStyle = '#fff';
        ctx.fillText('WAYS TO', m + nw + off1, cy0 + M * 0.045); ctx.fillText('SHINE BRIGHTER', m + nw + off1, cy0 + M * 0.092);
      }
      if (room < M * 0.33) a2 = 0;
      if (room < M * 0.5) a3 = 0;
      if (a2 > 0.01) {
        var off2 = (1 - a2) * -M * 0.08, y2 = cy0 + M * 0.21; ctx.globalAlpha = a2;
        font(ctx, 600, M * 0.028, 'outfit'); ctx.fillStyle = '#fff'; txt(ctx, 'THE NEW', m + off2, y2, M * 0.008);
        font(ctx, 400, Math.min(M * 0.085, colW / 3.2), 'anton'); ctx.fillStyle = pal.acc; ctx.fillText('ICONS', m + off2, y2 + M * 0.09);
      }
      if (a3 > 0.01) {
        var off3 = (1 - a3) * -M * 0.08, y3 = cy0 + M * 0.4; ctx.globalAlpha = a3;
        font(ctx, 400, M * 0.042, 'play', 'italic'); ctx.fillStyle = '#fff';
        ctx.fillText('Bold looks,', m + off3, y3); ctx.fillText('big energy', m + off3, y3 + M * 0.05);
      }
      ctx.globalAlpha = 1;
      // badge
      var ba = E.outBack(sat((ip - 2.5) / 0.45));
      if (ba > 0.01) {
        var br = M * 0.085, bx = W - m - br * 1.05, by = land ? H * 0.42 : mY + M * 0.2;
        ctx.save(); ctx.translate(bx, by); ctx.rotate(0.22); ctx.scale(ba, ba);
        ctx.beginPath(); for (var j = 0; j < 40; j++) { var ang = j / 40 * TAU, rr = j % 2 ? br * 0.9 : br; ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr); }
        ctx.closePath(); ctx.fillStyle = pal.acc === '#ffffff' ? '#ff2e63' : pal.acc; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        font(ctx, 400, br * 0.62, 'anton'); ctx.fillText('NEW', 0, -br * 0.1);
        font(ctx, 700, br * 0.2, 'outfit'); txt(ctx, 'EXCLUSIVE', 0, br * 0.42, br * 0.03);
        ctx.restore(); ctx.textBaseline = 'alphabetic';
      }
      // main cover line (bottom-left)
      var a4 = E.outCubic(sat((ip - 3) / 0.5));
      if (a4 > 0.01) {
        ctx.globalAlpha = a4; ctx.textAlign = 'left';
        // kicker pill
        font(ctx, 800, M * 0.022, 'outfit'); var kt = 'EXCLUSIVE', kw = textW(ctx, kt, M * 0.006) + M * 0.03;
        ctx.fillStyle = pal.acc === '#ffffff' ? '#ff2e63' : pal.acc;
        ctx.fillRect(m, yb - lay.size - M * 0.06, kw, M * 0.04);
        ctx.fillStyle = pal.acc === '#ffd400' || pal.acc === '#ffffff' && false ? '#111' : '#fff';
        txt(ctx, kt, m + M * 0.015, yb - lay.size - M * 0.031, M * 0.006);
        font(ctx, 800, lay.size, 'outfit'); shadowOn(ctx, 'rgba(0,0,0,0.4)', M * 0.015);
        for (var li = 0; li < lay.lines.length; li++) { ctx.fillStyle = li === 0 ? '#ffffff' : pal.acc2; ctx.fillText(lay.lines[li], m - (1 - a4) * M * 0.05, yb + li * lh); }
        shadowOff(ctx);
      }
      // barcode
      var a5 = smooth(3.4, 3.9, ip);
      if (a5 > 0.01) {
        var bw2 = M * 0.15, bh2 = M * 0.095, bx2 = W - m - bw2, by2 = H - m - bh2;
        ctx.globalAlpha = a5; ctx.fillStyle = '#fff'; ctx.fillRect(bx2, by2, bw2, bh2);
        ctx.fillStyle = '#111'; var u = (bw2 - M * 0.02) / 68, xx2 = bx2 + M * 0.01;
        for (var b = 0; b < S.bars.length && xx2 < bx2 + bw2 - M * 0.01; b++) { if (b % 2 === 0) ctx.fillRect(xx2, by2 + M * 0.008, S.bars[b] * u, bh2 - M * 0.03); xx2 += S.bars[b] * u; }
        font(ctx, 600, M * 0.014, 'outfit'); ctx.textAlign = 'center'; ctx.fillText('0 74470 11262 6', bx2 + bw2 / 2, by2 + bh2 - M * 0.006);
        ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; font(ctx, 700, M * 0.02, 'outfit'); txt(ctx, 'ISSUE 11 · $9.99', W - m, by2 - M * 0.012, M * 0.003);
      }
      ctx.globalAlpha = 1;
      // camera flash on swaps & final hit
      var fl = sh.k > 0 ? 0.45 * Math.exp(-lb * 8) : 0.5 * Math.exp(-bt * 6);
      if (bt >= S.plan.beats - 4) fl = Math.max(fl, 0.8 * Math.exp(-(bt - (S.plan.beats - 4)) * 4));
      fill(ctx, W, H, '#ffffff', fl);
      var e = endP(S, t, 0.5);
      if (e > 0) fill(ctx, W, H, '#000', E.inQuad(e) * 0.35);
    }
  };

  /* ---------------- COMIC POP ---------------- */
  var COMIC_BG = ['#ffd400', '#00c2ff', '#ff3d8b', '#ff7a00', '#7b2cff'];
  var COMIC_DUO = [
    ['#1b1464', '#ff2e88', '#ffd400', '#fff6d6'],
    ['#3a0ca3', '#ff6b00', '#22e1ff', '#ffffff'],
    ['#b5001b', '#ff8a00', '#ffe14d', '#fffbe6'],
    ['#003049', '#00b4d8', '#ff4d6d', '#ffe5ec']
  ];
  var COMIC_WORDS = ['POW!', 'ZAP!', 'WOW!', 'BAM!', 'BOOM!', 'POP!', 'WHAM!', 'YES!'];
  IMPL.comic = {
    cfg: { shotBeats: 8, fill: 'stretch' },
    units: 1.7,
    geo: function (S) {
      var W = S.W, H = S.H, M = S.M, m = Math.round(M * 0.065), g = Math.round(M * 0.03);
      var tw = Math.floor((W - 2 * m - g) / 2), th = Math.floor((H - 2 * m - g) / 2);
      return { m: m, g: g, pw: W - 2 * m, ph: H - 2 * m, tw: tw, th: th };
    },
    prep: async function (S, photos) {
      var G = this.geo(S), self = this; S.G = G;
      S.ph = await prepEach(S, photos, function (p, i) { return self.pop(S, p, i, G); });
      // halftone dot tile for backgrounds
      var cell = Math.max(4, Math.round(S.M * 0.022)), d = mk(cell, cell), x = cx(d);
      x.fillStyle = 'rgba(0,0,0,0.16)';
      x.beginPath(); x.arc(cell / 2, cell / 2, cell * 0.22, 0, TAU); x.fill();
      x.beginPath(); [[0, 0], [cell, 0], [0, cell], [cell, cell]].forEach(function (q) { x.moveTo(q[0] + cell * 0.12, q[1]); x.arc(q[0], q[1], cell * 0.12, 0, TAU); }); x.fill();
      S.dots = d;
    },
    pop: function (S, photo, i, G) {
      var ps = S.ps, pw = G.pw * ps, ph = G.ph * ps;
      var a = coverCrop(photo, pw, ph, 0.5, 0.42);
      // ink edges from a half-res luma
      var ew = Math.max(8, Math.round(pw / 2)), eh = Math.max(8, Math.round(ph / 2)), sm = resize(a, ew, eh), sd = cx(sm).getImageData(0, 0, ew, eh).data;
      var Lm = new Float32Array(ew * eh), k;
      for (k = 0; k < ew * eh; k++) Lm[k] = 0.2126 * sd[k * 4] + 0.7152 * sd[k * 4 + 1] + 0.0722 * sd[k * 4 + 2];
      var ink = cx(sm).createImageData(ew, eh), id = ink.data;
      for (var y = 1; y < eh - 1; y++) for (var xx = 1; xx < ew - 1; xx++) {
        var q = y * ew + xx;
        var gx = -Lm[q - ew - 1] - 2 * Lm[q - 1] - Lm[q + ew - 1] + Lm[q - ew + 1] + 2 * Lm[q + 1] + Lm[q + ew + 1];
        var gy = -Lm[q - ew - 1] - 2 * Lm[q - ew] - Lm[q - ew + 1] + Lm[q + ew - 1] + 2 * Lm[q + ew] + Lm[q + ew + 1];
        var mag = Math.sqrt(gx * gx + gy * gy);
        id[q * 4 + 3] = mag > 120 ? Math.min(255, (mag - 120) * 1.6) : 0;
      }
      cx(sm).putImageData(ink, 0, 0);
      grade(a, { sat: 1.7, vib: 0.3, contrast: 1.3, curve: 0.2, exposure: 1.06, posterize: 5 });
      var x = cx(a);
      // halftone dots in shadows/mids
      var cell = Math.max(3, Math.round(S.M * 0.013 * ps)), gw = Math.ceil(pw / cell), gh = Math.ceil(ph / cell);
      var hs2 = resize(a, gw, gh), hd = cx(hs2).getImageData(0, 0, gw, gh).data; free(hs2);
      x.fillStyle = 'rgba(10,10,30,0.42)'; x.beginPath();
      for (var gy2 = 0; gy2 < gh; gy2++) for (var gx2 = 0; gx2 < gw; gx2++) {
        var hi = (gy2 * gw + gx2) * 4, l = (0.2126 * hd[hi] + 0.7152 * hd[hi + 1] + 0.0722 * hd[hi + 2]) / 255, dk = 1 - l;
        if (dk < 0.3) continue;
        var r = cell * 0.55 * Math.sqrt((dk - 0.3) / 0.7), cx0 = (gx2 + 0.5 + (gy2 % 2) * 0.5) * cell, cy0 = (gy2 + 0.5) * cell;
        x.moveTo(cx0 + r, cy0); x.arc(cx0, cy0, r, 0, TAU);
      }
      x.fill();
      x.imageSmoothingQuality = 'high'; x.drawImage(sm, 0, 0, pw, ph); free(sm);
      // duotone warhol tiles
      var tiles = [];
      for (var j = 0; j < 4; j++) {
        var tc = coverCrop(photo, G.tw * ps, G.th * ps, 0.5, 0.42), tx2 = cx(tc), td = tx2.getImageData(0, 0, tc.width, tc.height), dd = td.data, pal = COMIC_DUO[j].map(hexRGB);
        for (k = 0; k < dd.length; k += 4) {
          var lv = (0.2126 * dd[k] + 0.7152 * dd[k + 1] + 0.0722 * dd[k + 2]) / 255;
          lv = sat((lv - 0.5) * 1.35 + 0.5);
          var lvl = Math.min(3, Math.floor(lv * 4)), c = pal[lvl];
          dd[k] = c[0]; dd[k + 1] = c[1]; dd[k + 2] = c[2];
        }
        tx2.putImageData(td, 0, 0);
        tiles.push(tc);
      }
      return { a: a, tiles: tiles };
    },
    burst: function (ctx, x, y, r, rot, word, fillC, textC, sc, seed) {
      if (sc <= 0.01) return;
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sc, sc);
      var n = 13, i;
      function path(k) { ctx.beginPath(); for (i = 0; i < n * 2; i++) { var a = i / (n * 2) * TAU, rr = i % 2 ? r * (0.6 + 0.08 * hash(i, seed)) * k : r * (0.9 + 0.16 * hash(i, seed + 1)) * k; ctx.lineTo(Math.cos(a) * rr * 1.12, Math.sin(a) * rr * 0.9); } ctx.closePath(); }
      ctx.translate(r * 0.05, r * 0.06); path(1); ctx.fillStyle = '#111'; ctx.fill(); ctx.translate(-r * 0.05, -r * 0.06);
      path(1); ctx.fillStyle = fillC; ctx.fill(); ctx.lineJoin = 'miter'; ctx.lineWidth = r * 0.05; ctx.strokeStyle = '#111'; ctx.stroke();
      path(0.7); ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
      var lay = fitText(ctx, word, 400, 'bangers', '', r * 0.62, r * 1.5, 0.02, false);
      font(ctx, 400, lay.size, 'bangers'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = lay.size * 0.16; ctx.strokeStyle = '#111';
      txt(ctx, word, 0, lay.size * 0.04, lay.size * 0.02, true); ctx.fillStyle = textC; txt(ctx, word, 0, lay.size * 0.04, lay.size * 0.02);
      ctx.restore(); ctx.textBaseline = 'alphabetic';
    },
    poster: function (S) { return S.beat * 0.55; },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, G = S.G, bt = t / S.beat + 1e-6, f = fract(bt);
      var sh = shotAt(S, bt), lb = bt - sh.b0, wi = Math.floor(lb / 4), ws = sh.b0 + wi * 4, wl = bt - ws, win = sh.k * 7 + wi;
      var lay = (sh.k + wi) % 2, P = S.ph[sh.p];
      // background: color + rays + halftone
      ctx.fillStyle = COMIC_BG[(sh.k * 2 + wi) % COMIC_BG.length]; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.beginPath();
      var rot = t * 0.15, D = W + H;
      for (var k = 0; k < 16; k++) { var a = rot + k / 16 * TAU; ctx.moveTo(W / 2, H / 2); ctx.arc(W / 2, H / 2, D, a, a + TAU / 32); ctx.closePath(); }
      ctx.fill();
      patFill(ctx, S.dots, 0, 0, W, H, 0, 0);
      var bump = 1 + 0.012 * Math.exp(-f * 6);
      var lw = Math.max(2, M * 0.012);
      if (lay === 0) {
        var s = (0.86 + 0.14 * E.outBack(sat(wl / 0.35))) * bump;
        var pw = G.pw * s, ph = G.ph * s, x0 = (W - pw) / 2, y0 = (H - ph) / 2;
        ctx.fillStyle = '#111'; ctx.fillRect(x0 - lw * 1.6 + M * 0.012, y0 - lw * 1.6 + M * 0.014, pw + lw * 3.2, ph + lw * 3.2);
        ctx.fillStyle = '#fff'; ctx.fillRect(x0 - lw * 1.6, y0 - lw * 1.6, pw + lw * 3.2, ph + lw * 3.2);
        ctx.fillStyle = '#111'; ctx.fillRect(x0 - lw * 0.6, y0 - lw * 0.6, pw + lw * 1.2, ph + lw * 1.2);
        drawZoom(ctx, P.a, x0, y0, pw, ph, 1.02 + 0.04 * sat(wl / 4), hs(win, 3) * 0.6, -0.1);
      } else {
        for (var j = 0; j < 4; j++) {
          var ts = j === 0 ? lerp(0.82, 1, E.outBack(sat(wl / 0.3))) : E.outBack(sat((wl - j * 0.5) / 0.4));
          if (ts <= 0.01) continue;
          var tx0 = G.m + (j % 2) * (G.tw + G.g), ty0 = G.m + Math.floor(j / 2) * (G.th + G.g), cxx = tx0 + G.tw / 2, cyy = ty0 + G.th / 2;
          var sc = ts * (j === Math.floor(bt) % 4 ? bump : 1);
          ctx.save(); ctx.translate(cxx, cyy); ctx.scale(sc, sc);
          ctx.fillStyle = '#111'; ctx.fillRect(-G.tw / 2 - lw + M * 0.01, -G.th / 2 - lw + M * 0.012, G.tw + lw * 2, G.th + lw * 2);
          ctx.fillRect(-G.tw / 2 - lw, -G.th / 2 - lw, G.tw + lw * 2, G.th + lw * 2);
          ctx.drawImage(P.tiles[j], -G.tw / 2, -G.th / 2, G.tw, G.th);
          ctx.restore();
        }
      }
      // bursts
      var bursts = [[0, 1.6], [2, 3.4]];
      for (var bI = 0; bI < bursts.length; bI++) {
        var b0 = bursts[bI][0], b1 = Math.min(bursts[bI][1], Math.min(4, sh.b1 - ws));
        if (wl < b0 || wl > b1) continue;
        var bl = wl - b0, life = b1 - b0, bsc = E.outBack(sat(bl / 0.3)) * (1 - E.inCubic(sat((bl - (life - 0.25)) / 0.25)));
        var id = win * 2 + bI, corner = (id + sh.k) % 4;
        var bx = W * (corner % 2 ? 0.72 : 0.28) + hs(id, 9) * M * 0.05, by = H * (corner < 2 ? 0.26 : 0.7) + hs(id, 10) * M * 0.05;
        var word = COMIC_WORDS[Math.floor(hash(id, 11) * COMIC_WORDS.length)];
        var fc = ['#fff200', '#ffffff', '#ff2e88', '#22e1ff'][id % 4], tc = fc === '#ff2e88' ? '#fff200' : '#ff2e2e';
        this.burst(ctx, bx, by, M * 0.17, hs(id, 12) * 0.3, word, fc, tc, bsc, id);
      }
      // title caption box + subtitle bubble
      var ta = titleA(S, t);
      if (ta > 0.01 && tx.title) {
        var cl = fitText(ctx, tx.title.toUpperCase(), 400, 'bangers', '', M * 0.085, W * 0.72, 0.03, true), lh = cl.size * 1.0;
        font(ctx, 400, cl.size, 'bangers');
        var wmax = 0; for (var q = 0; q < cl.lines.length; q++) wmax = Math.max(wmax, textW(ctx, cl.lines[q], cl.size * 0.03));
        var bwid = wmax + M * 0.06, bht = cl.lines.length * lh + M * 0.04;
        ctx.save(); ctx.translate(G.m + M * 0.01, G.m + M * 0.01 - (1 - ta) * M * 0.2); ctx.rotate(-0.035); ctx.globalAlpha = sat(ta * 1.5);
        ctx.fillStyle = '#111'; ctx.fillRect(M * 0.012, M * 0.014, bwid, bht);
        ctx.fillStyle = '#fff36b'; ctx.fillRect(0, 0, bwid, bht); ctx.lineWidth = lw; ctx.strokeStyle = '#111'; ctx.strokeRect(0, 0, bwid, bht);
        ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (q = 0; q < cl.lines.length; q++) txt(ctx, cl.lines[q], M * 0.03, M * 0.02 + lh * (q + 0.5) + cl.size * 0.05, cl.size * 0.03);
        ctx.restore(); ctx.textBaseline = 'alphabetic';
      }
      if (ta > 0.01 && tx.subtitle) {
        var sl = fitText(ctx, tx.subtitle, 400, 'bangers', '', M * 0.055, W * 0.55, 0.02, true), slh = sl.size * 1.05;
        font(ctx, 400, sl.size, 'bangers');
        var sw = 0; for (var q2 = 0; q2 < sl.lines.length; q2++) sw = Math.max(sw, textW(ctx, sl.lines[q2], sl.size * 0.02));
        var ew = sw / 2 + M * 0.06, eh = sl.lines.length * slh / 2 + M * 0.045, ex = W - G.m - ew - M * 0.02, ey = H - G.m - eh - M * 0.06;
        ctx.save(); ctx.globalAlpha = sat(ta * 1.5); ctx.translate(ex, ey); ctx.scale(0.6 + 0.4 * E.outBack(ta), 0.6 + 0.4 * E.outBack(ta));
        ctx.beginPath(); ctx.ellipse(0, 0, ew, eh, 0, 0, TAU); ctx.moveTo(-ew * 0.35, eh * 0.7); ctx.lineTo(-ew * 0.6, eh * 1.55); ctx.lineTo(-ew * 0.05, eh * 0.9);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = '#111'; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(0, 0, ew - lw * 0.6, eh - lw * 0.6, 0, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (q2 = 0; q2 < sl.lines.length; q2++) txt(ctx, sl.lines[q2], 0, (q2 - (sl.lines.length - 1) / 2) * slh + sl.size * 0.05, sl.size * 0.02);
        ctx.restore(); ctx.textBaseline = 'alphabetic';
      }
      // THE END
      var eb = S.plan.beats - bt, ea = E.outBack(sat((S.beat * 2.2 - eb * S.beat) / (S.beat * 0.45)));
      if (eb < 2.2) this.burst(ctx, W / 2, H / 2, M * 0.3, -0.08, 'THE END!', '#fff200', '#ff2e2e', ea, 999);
      var e = endP(S, t, 0.5);
      if (e > 0) fill(ctx, W, H, '#fff6d6', E.inQuad(e) * 0.3);
    }
  };

  /* ---------------- GLITCH ---------------- */
  IMPL.glitch = {
    cfg: { shotBeats: 4, fill: 'repeat' },
    units: 1.3,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p) {
        var a = coverCrop(p, S.PW, S.PH);
        grade(a, { contrast: 1.2, curve: 0.25, sat: 0.88, temp: -0.18, tint: 0.06, autoK: 0.9, shadows: '#1a1060', shAmt: 0.5, highlights: '#c9fbff', hiAmt: 0.25 });
        bloom(a, { thr: 0.55, amt: 0.3, rad: 2, tint: '#7fe8ff', tintAmt: 0.3 });
        vignette(a, 0.5, '#02010a', 0.45);
        var sp = rgbSplit(a, 0.5);
        return { a: a, r: sp.r, gb: sp.gb };
      });
    },
    poster: function (S) { return S.beat * 0.22; },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, f = fract(bt), bi = Math.floor(bt);
      var e = endP(S, t, 0.75);
      var sh = shotAt(S, bt), lb = bt - sh.b0, P = S.ph[sh.p], k = kb(sh, bt, 0.05, 151, 1.04);
      var g = Math.exp(-f * 11) * (bi % 4 === 0 ? 1 : 0.55);
      if (hash(bi, 9) > 0.55) { var f2 = bt - bi - 0.5; if (f2 >= 0) g = Math.max(g, 0.5 * Math.exp(-f2 * 12)); }
      if (lb < 0.35 && sh.k > 0) g = Math.max(g, 1 - lb / 0.35);
      g = Math.max(g, e * 1.3);
      var tq = Math.floor(t * 20), gq = g;
      if (e > 0.55) {
        // signal lost: collapse to a line
        var c = 1 - E.inCubic(sat((e - 0.55) / 0.4));
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        var hh = Math.max(2, H * c * c);
        drawZoom(ctx, P.a, -W * (1 - c) * 0.1, H / 2 - hh / 2, W * (1 + (1 - c) * 0.2), hh, k.z, k.px, k.py);
        ctx.globalCompositeOperation = 'lighter';
        fill(ctx, W, H, '#ffffff', 0);
        ctx.fillStyle = 'rgba(200,250,255,' + (0.8 * (1 - c)) + ')'; ctx.fillRect(0, H / 2 - Math.max(1, M * 0.003), W, Math.max(2, M * 0.006));
        glowAt(ctx, W / 2, H / 2, M * 0.5, '#9ff3ff', 0.5 * (1 - c));
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
      if (gq < 0.08) drawZoom(ctx, P.a, 0, 0, W, H, k.z, k.px, k.py);
      else {
        var n = 14, sl = [], y = 0, d = M * 0.03 * gq;
        for (var s = 0; s < n && y < H; s++) {
          var h = H * lerp(0.02, 0.16, hash(s, tq * 3 + 1)), y1 = s === n - 1 ? H : Math.min(H, y + h);
          var dx = hash(s, tq * 3 + 2) < 0.45 ? hs(s, tq * 3 + 3) * M * 0.22 * gq : 0;
          sl.push([y, y1, dx]); y = y1;
        }
        if (y < H) sl.push([y, H, 0]);
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        drawSlices(ctx, P.r, 0, 0, W, H, k.z, k.px, k.py, sl, d);
        ctx.globalCompositeOperation = 'lighter';
        drawSlices(ctx, P.gb, 0, 0, W, H, k.z, k.px, k.py, sl, -d);
        ctx.globalCompositeOperation = 'source-over';
        // blocks
        var nb = Math.floor(3 + gq * 7);
        for (var b = 0; b < nb; b++) {
          var bw = M * lerp(0.05, 0.45, hash(b, tq + 50)), bh = M * lerp(0.01, 0.06, hash(b, tq + 51));
          var bx = hash(b, tq + 52) * W - bw / 2, by = hash(b, tq + 53) * H, kind = hash(b, tq + 54);
          if (kind < 0.35) { ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#ffffff'; ctx.fillRect(bx, by, bw, bh); }
          else if (kind < 0.6) { ctx.globalAlpha = 0.8; patFill(ctx, snowTile(), bx, by, bw, bh, Math.floor(hash(b, tq) * 160), 0); ctx.globalAlpha = 1; }
          else { ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = kind < 0.8 ? 'rgba(0,240,255,0.55)' : 'rgba(255,0,170,0.55)'; ctx.fillRect(bx, by, bw, bh); }
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      scanlines(ctx, W, H, M, 0.16, 0);
      // title: RGB split text with slice jitter
      var ta = titleA(S, t);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        var cy0 = H * 0.5, d2 = M * (0.006 + 0.02 * gq);
        scrim(ctx, W / 2, cy0 + (tx.subtitle ? M * 0.04 : 0), Math.min(W * 0.62, M * 1.05), M * 0.3, 0.55 * ta, '#02010a');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.globalAlpha = ta;
        if (tx.title) {
          var lay = fitText(ctx, tx.title.toUpperCase(), 800, 'outfit', '', M * 0.14, W * 0.86, 0.02, true), lh = lay.size * 1.0;
          font(ctx, 800, lay.size, 'outfit');
          for (var li = 0; li < lay.lines.length; li++) {
            var yy = cy0 + (li - (lay.lines.length - 1) / 2) * lh, jit = gq > 0.3 ? hs(li, tq) * M * 0.03 * gq : 0;
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = '#00f0ff'; txt(ctx, lay.lines[li], W / 2 - d2 + jit, yy, lay.size * 0.02);
            ctx.fillStyle = '#ff00a8'; txt(ctx, lay.lines[li], W / 2 + d2 + jit, yy, lay.size * 0.02);
            ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#ffffff'; txt(ctx, lay.lines[li], W / 2 + jit * 0.5, yy, lay.size * 0.02);
            if (gq > 0.25) { // sliced chunk
              var sy = yy + hs(li, tq + 7) * lay.size * 0.3, shh = lay.size * 0.12;
              ctx.save(); ctx.beginPath(); ctx.rect(0, sy, W, shh); ctx.clip(); ctx.fillStyle = '#ff00a8';
              txt(ctx, lay.lines[li], W / 2 + hs(li, tq + 8) * M * 0.08, yy, lay.size * 0.02); ctx.restore();
            }
          }
        }
        if (tx.subtitle) {
          var ss = fitText(ctx, tx.subtitle.toUpperCase(), 400, 'vt', '', M * 0.05, W * 0.8, 0.12, false).size;
          font(ctx, 400, ss, 'vt'); ctx.fillStyle = '#9ff3ff';
          var lay2 = tx.title ? fitText(ctx, tx.title.toUpperCase(), 800, 'outfit', '', M * 0.14, W * 0.86, 0.02, true) : null;
          txt(ctx, '> ' + tx.subtitle.toUpperCase() + (Math.floor(t * 3) % 2 ? '_' : ' '), W / 2, lay2 ? cy0 + lay2.lines.length * lay2.size * 0.5 + ss * 1.2 : cy0, ss * 0.12);
        }
        ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
      }
    }
  };

  /* ---------------- PARTY SPARKLE ---------------- */
  var PARTY_COLS = ['#ffd34d', '#ff4fa3', '#4fe3ff', '#ffffff', '#b77bff', '#ff8a3d'];
  IMPL.party = {
    cfg: { shotBeats: 4, fill: 'repeat' },
    units: 1.05,
    prep: async function (S, photos) {
      S.ph = await prepEach(S, photos, function (p, i) {
        var a = coverCrop(p, S.PW, S.PH);
        grade(a, { contrast: 1.08, curve: 0.2, sat: 1.12, vib: 0.4, skin: 0.8, temp: 0.05, exposure: 1.03, shadows: '#5a1060', shAmt: 0.42, highlights: '#ffe2b0', hiAmt: 0.16 });
        bloom(a, { thr: 0.6, amt: 0.42, rad: 3, tint: '#ffb3d9', tintAmt: 0.45 });
        vignette(a, 0.5, '#1a0010', 0.45);
        return { a: a, pts: glints(a, 12, i + 9) };
      });
    },
    poster: function (S) { return S.beat * 1.1; },
    render: function (S, ctx, t, tx) {
      var W = S.W, H = S.H, M = S.M, bt = t / S.beat + 1e-6, f = fract(bt), bi = Math.floor(bt);
      var sh = shotAt(S, bt), lb = bt - sh.b0, P = S.ph[sh.p], k = kb(sh, bt, 0.06, 171, 1.06);
      var spring = Math.exp(-f * 4.5) * Math.cos(f * 10);
      var z = k.z + 0.045 * spring + 0.1 * Math.exp(-lb * 6) * (sh.k > 0 ? 1 : 0.4);
      var px = k.px + Math.sin(bt * Math.PI) * 0.25, RV = 0.45;
      if (sh.k > 0 && lb < RV) { // radial reveal of the next photo with a golden ring
        var pv = S.plan.shots[sh.k - 1], kp = kb(pv, bt, 0.06, 171, 1.06), rr = E.outCubic(lb / RV) * Math.hypot(W, H) * 0.52;
        drawZoom(ctx, S.ph[pv.p].a, 0, 0, W, H, kp.z + 0.045 * spring, kp.px + Math.sin(bt * Math.PI) * 0.25, kp.py);
        ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H * 0.48, Math.max(1, rr), 0, TAU); ctx.clip();
        drawZoom(ctx, P.a, 0, 0, W, H, z, px, k.py);
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - lb / RV;
        ctx.lineWidth = M * 0.03; ctx.strokeStyle = 'rgba(255,210,120,0.55)'; ctx.beginPath(); ctx.arc(W / 2, H * 0.48, Math.max(1, rr), 0, TAU); ctx.stroke();
        ctx.lineWidth = M * 0.008; ctx.strokeStyle = 'rgba(255,255,240,0.9)'; ctx.stroke();
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        mapZoom(P.a, 0, 0, W, H, z, px, k.py); // keep glint mapping on the new photo
      } else drawZoom(ctx, P.a, 0, 0, W, H, z, px, k.py);
      // party glows
      var pulse = 0.7 + 0.3 * Math.exp(-f * 3);
      ctx.globalCompositeOperation = 'lighter';
      glowAt(ctx, W * (0.02 + 0.04 * Math.sin(t * 0.7)), H * 0.1, M * 0.9, '#ff3fa8', 0.4 * pulse);
      glowAt(ctx, W * (0.98 - 0.04 * Math.sin(t * 0.6)), H * 0.9, M * 0.9, '#ffc04d', 0.35 * pulse);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      bokeh(ctx, W, H, t, { n: 8, seed: 71, colors: ['#ff4fa3', '#ffd34d', '#b77bff'], min: 0.02, max: 0.06, speed: 0.02, alpha: 0.35 });
      sparkles(ctx, W, H, t, { n: P.pts.length, pts: P.pts, seed: 72 + sh.k, alpha: 0.6 + 0.4 * Math.exp(-f * 3), min: 0.04, max: 0.09, colors: ['#ffffff', '#ffe08a'] });
      glitter(ctx, W, H, t, { n: 55, seed: 73, alpha: 0.9, rise: 0.015, colors: ['#ffffff', '#ffe08a', '#ffb3e6'] });
      // downbeat sparkle bursts
      var bar = Math.floor(bt / 4), bf = bt - bar * 4;
      if (bf < 1.2) {
        ctx.globalCompositeOperation = 'lighter';
        for (var i = 0; i < 9; i++) {
          var a = Math.sin(Math.PI * sat((bf - i * 0.03) / 1.1)), sx = hash(i, bar * 13 + 1) * W, sy = hash(i, bar * 13 + 2) * H * 0.85;
          if (a <= 0.01) continue;
          ctx.globalAlpha = a; sprite(ctx, sparkSprite(PARTY_COLS[i % 3]), sx, sy, M * lerp(0.06, 0.16, hash(i, bar * 13 + 3)) * a, bf * 2 + i);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
      confetti(ctx, W, H, t, { n: 42, seed: 74, colors: PARTY_COLS, alpha: 0.95, scale: 1.35 });
      if (sh.k > 0) confettiBurst(ctx, W, H, (bt - sh.b0) * S.beat, { n: 46, seed: 75 + sh.k, colors: PARTY_COLS });
      var fb = S.plan.beats - 4;
      if (bt >= fb) confettiBurst(ctx, W, H, (bt - fb) * S.beat, { n: 80, seed: 99, colors: PARTY_COLS, center: true, x: W / 2, y: H * 0.45, power: 0.9 });
      fill(ctx, W, H, '#fff3e0', (sh.k > 0 ? 0.4 : 0.2) * Math.exp(-lb * 9), 'lighter');
      // title
      var ta = titleA(S, t);
      if (ta > 0.01 && (tx.title || tx.subtitle)) {
        var bp = f < 0.4 ? 1 + 0.04 * Math.exp(-f * 6) : 1, cy0 = Math.round(H * (W > H ? 0.78 : 0.8)), RH = Math.round(Math.min(H, M * 0.62));
        bottomShade(ctx, W, H, 0.5 * ta, 0.55, S);
        var lay = tx.title ? fitText(ctx, tx.title, 800, 'outfit', '', M * 0.13, W * 0.86, 0.01, true) : null;
        var spr = cached(S, 'party|' + tx.title + '|' + tx.subtitle, W, RH, function (x) {
          x.translate(W / 2, RH / 2); x.textAlign = 'center'; x.textBaseline = 'middle';
          if (lay) {
            var lh = lay.size * 1.02, y0 = -(lay.lines.length - 1) * lh / 2;
            font(x, 800, lay.size, 'outfit');
            var gg = x.createLinearGradient(0, y0 - lay.size / 2, 0, y0 + (lay.lines.length - 0.5) * lh);
            gg.addColorStop(0, '#fff7d6'); gg.addColorStop(0.5, '#ffd34d'); gg.addColorStop(1, '#ff9a3d');
            shadowOn(x, 'rgba(255,80,170,0.8)', M * 0.04); x.fillStyle = gg;
            for (var li = 0; li < lay.lines.length; li++) txt(x, lay.lines[li], 0, y0 + li * lh, lay.size * 0.01);
            shadowOff(x);
          }
          if (tx.subtitle) {
            var ss = fitText(x, tx.subtitle.toUpperCase(), 600, 'outfit', '', M * 0.034, W * 0.8, 0.3, false).size;
            font(x, 600, ss, 'outfit'); x.fillStyle = '#ffffff'; shadowOn(x, 'rgba(0,0,0,0.5)', M * 0.02);
            txt(x, tx.subtitle.toUpperCase(), 0, lay ? -(lay.lines.length - 1) * lay.size * 0.51 - lay.size * 0.85 : 0, ss * 0.3);
            shadowOff(x);
          }
        });
        ctx.save(); ctx.translate(Math.round(W / 2), cy0); if (bp !== 1) ctx.scale(bp, bp); ctx.globalAlpha = ta;
        ctx.drawImage(spr, -Math.round(W / 2), -Math.round(RH / 2));
        if (lay) {
          ctx.globalCompositeOperation = 'lighter';
          font(ctx, 800, lay.size, 'outfit');
          var tw = textW(ctx, lay.lines[0], lay.size * 0.01), y00 = -(lay.lines.length - 1) * lay.size * 0.51;
          for (var sI = 0; sI < 3; sI++) {
            var tw2 = Math.sin((t * 1.3 + sI * 0.33) * TAU); tw2 = tw2 > 0 ? tw2 * tw2 : 0;
            sprite(ctx, sparkSprite('#fff2c2'), (hash(sI, 5) - 0.5) * tw, y00 + (hash(sI, 6) - 0.5) * lay.size * 0.8, lay.size * 0.9 * tw2, t + sI);
          }
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore(); ctx.textBaseline = 'alphabetic';
      }
      var e = endP(S, t, 0.7);
      if (e > 0) fill(ctx, W, H, '#14040f', E.inQuad(e) * 0.7);
      void bi;
    }
  };

  /* ======================================================================
   * 3. createScene
   * ==================================================================== */
  var BY_ID = {};
  TEMPLATES.forEach(function (t) { BY_ID[t.id] = t; });

  function trackBpm(id) {
    try {
      var GM = window.GlowMusic;
      if (GM && GM.tracks) for (var i = 0; i < GM.tracks.length; i++) if (GM.tracks[i].id === id) return GM.tracks[i].bpm;
    } catch (e) { /* ignore */ }
    return TRACK_BPM[id] || 120;
  }

  async function createScene(o) {
    o = o || {};
    var meta = BY_ID[o.templateId] || TEMPLATES[0], impl = IMPL[meta.id];
    var W = Math.max(16, Math.round(+o.width || 1080)), H = Math.max(16, Math.round(+o.height || 1920));
    var bpm = +o.bpm > 0 ? +o.bpm : trackBpm(meta.track);
    bpm = clamp(bpm, 40, 220);
    var photos = (o.photos || []).filter(function (p) { return p && dims(p)[0] > 1 && dims(p)[1] > 1; });
    if (!photos.length) photos = demoPhotos(1);
    var S = { id: meta.id, W: W, H: H, M: Math.min(W, H), bpm: bpm, n: photos.length };
    S.plan = makePlan(S.n, bpm, impl.cfg);
    S.beat = S.plan.beat; S.bar = S.plan.bar; S.duration = S.plan.duration;
    S.ps = budgetScale(S, impl.units || 1);
    S.PW = Math.max(8, Math.round(W * S.ps)); S.PH = Math.max(8, Math.round(H * S.ps));
    await impl.prep(S, photos);
    var errLogged = false;
    var scene = {
      duration: S.duration,
      bpm: bpm,
      bars: S.plan.bars,
      width: W,
      height: H,
      templateId: meta.id,
      posterTime: clamp(impl.poster ? impl.poster(S) : S.duration * 0.3, 0, S.duration),
      render: function (ctx, t, text) {
        t = +t; if (!(t >= 0)) t = 0; if (t > S.duration) t = S.duration;
        text = text || {};
        var tx = { title: String(text.title == null ? '' : text.title).trim(), subtitle: String(text.subtitle == null ? '' : text.subtitle).trim() };
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        shadowOff(ctx); ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = 'low'; } catch (e) { /* ignore */ }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 1;
        try { impl.render(S, ctx, t, tx); }
        catch (err) {
          if (!errLogged) { errLogged = true; if (window.console) console.error('[GlowFX] render error', meta.id, err); }
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#0b0712'; ctx.fillRect(0, 0, W, H);
        }
        ctx.restore();
      },
      dispose: function () {
        function walk(v, depth) {
          if (!v || depth > 3) return;
          if (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) { free(v); return; }
          if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
          if (typeof v === 'object') for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) walk(v[k], depth + 1);
        }
        walk(S.ph, 0); walk(S.cards, 0); free(S.frame); free(S.pile); free(S.surface); free(S.leak); free(S.shadow);
        if (S.tc) { S.tc.forEach(function (c) { free(c); }); S.tc.clear(); }
      }
    };
    // warm-up: build lazily created sprites / noise / grain textures now, so the first exported frames don't hitch
    try {
      noiseTiles(); snowTile();
      var wc = mk(16, 16), wx = cx(wc);
      [0, scene.posterTime, S.duration * 0.5, S.duration - 0.3].forEach(function (wt) { scene.render(wx, wt, { title: '', subtitle: '' }); });
      free(wc);
    } catch (e) { /* ignore */ }
    return scene;
  }

  /* ======================================================================
   * 4. Demo photos (procedural, deterministic, no people)
   * ==================================================================== */
  function vgrad(x, W, y0, y1, stops) {
    var g = x.createLinearGradient(0, y0, 0, y1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    x.fillStyle = g; x.fillRect(0, y0, W, y1 - y0);
  }
  function radial(x, X, Y, r, stops, op) {
    x.save(); if (op) x.globalCompositeOperation = op;
    var g = x.createRadialGradient(X, Y, 0, X, Y, r);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    x.fillStyle = g; x.fillRect(X - r, Y - r, r * 2, r * 2); x.restore();
  }
  function starsField(x, W, R, n, maxY, a) {
    for (var i = 0; i < n; i++) {
      var sx = R() * W, sy = Math.pow(R(), 1.4) * maxY, s = R() < 0.92 ? 1 + R() * 1.4 : 2.4 + R() * 1.6, al = a * (0.35 + 0.65 * R()) * (1 - sy / maxY * 0.6);
      x.fillStyle = 'rgba(255,255,255,' + al + ')'; x.beginPath(); x.arc(sx, sy, s * 0.6, 0, TAU); x.fill();
      if (s > 2.4) radial(x, sx, sy, s * 5, [[0, 'rgba(200,220,255,' + al * 0.5 + ')'], [1, 'rgba(200,220,255,0)']], 'lighter');
    }
  }
  function disc(x, X, Y, r, col, a) {
    var g = x.createRadialGradient(X, Y, 0, X, Y, r);
    g.addColorStop(0, rgba(col, a * 0.5)); g.addColorStop(0.75, rgba(col, a * 0.62)); g.addColorStop(0.9, rgba(col, a * 0.9)); g.addColorStop(1, rgba(col, 0));
    x.fillStyle = g; x.beginPath(); x.arc(X, Y, r, 0, TAU); x.fill();
  }
  function birds(x, R, n, cx0, cy0, spread, size, col) {
    x.strokeStyle = col; x.lineCap = 'round';
    for (var i = 0; i < n; i++) {
      var bx = cx0 + (R() - 0.5) * spread, by = cy0 + (R() - 0.5) * spread * 0.4, s = size * (0.6 + R() * 0.6);
      x.lineWidth = Math.max(1.5, s * 0.14); x.beginPath();
      x.moveTo(bx - s, by - s * 0.2); x.quadraticCurveTo(bx - s * 0.45, by - s * 0.55, bx, by); x.quadraticCurveTo(bx + s * 0.45, by - s * 0.55, bx + s, by - s * 0.2); x.stroke();
    }
    x.lineCap = 'butt';
  }
  function palm(x, R, bx, by, h, lean, col) {
    var tx = bx + lean * h, ty = by - h, c1x = bx + lean * h * 0.1, c1y = by - h * 0.55, N = 28, Lp = [], Rp = [], i;
    for (i = 0; i <= N; i++) {
      var u = i / N, px = (1 - u) * (1 - u) * bx + 2 * (1 - u) * u * c1x + u * u * tx, py = (1 - u) * (1 - u) * by + 2 * (1 - u) * u * c1y + u * u * ty;
      var dx = 2 * (1 - u) * (c1x - bx) + 2 * u * (tx - c1x), dy = 2 * (1 - u) * (c1y - by) + 2 * u * (ty - c1y), len = Math.hypot(dx, dy) || 1;
      var w = h * (0.03 - 0.015 * u);
      Lp.push([px - dy / len * w, py + dx / len * w]); Rp.push([px + dy / len * w, py - dx / len * w]);
    }
    x.fillStyle = col; x.beginPath(); x.moveTo(Lp[0][0], Lp[0][1]);
    for (i = 1; i < Lp.length; i++) x.lineTo(Lp[i][0], Lp[i][1]);
    for (i = Rp.length - 1; i >= 0; i--) x.lineTo(Rp[i][0], Rp[i][1]);
    x.closePath(); x.fill();
    x.strokeStyle = col; x.lineCap = 'round';
    var nF = 10;
    for (var f = 0; f < nF; f++) {
      var ang = -Math.PI / 2 + (f / (nF - 1) - 0.5) * Math.PI * 1.75 + (R() - 0.5) * 0.25, len2 = h * (0.3 + R() * 0.12);
      var ex = tx + Math.cos(ang) * len2, ey = ty + Math.sin(ang) * len2 * 0.55 + len2 * 0.38;
      var mx = tx + Math.cos(ang) * len2 * 0.55, my = ty + Math.sin(ang) * len2 * 0.55 - len2 * 0.12;
      x.lineWidth = Math.max(1.5, h * 0.008); x.beginPath(); x.moveTo(tx, ty); x.quadraticCurveTo(mx, my, ex, ey); x.stroke();
      for (var s = 0.07; s < 1; s += 0.05) {
        var qx = (1 - s) * (1 - s) * tx + 2 * (1 - s) * s * mx + s * s * ex, qy = (1 - s) * (1 - s) * ty + 2 * (1 - s) * s * my + s * s * ey;
        var tdx = 2 * (1 - s) * (mx - tx) + 2 * s * (ex - mx), tdy = 2 * (1 - s) * (my - ty) + 2 * s * (ey - my), tl = Math.hypot(tdx, tdy) || 1;
        tdx /= tl; tdy /= tl;
        var ll = len2 * 0.26 * Math.sin(Math.PI * Math.min(1, s * 0.95 + 0.08));
        x.lineWidth = Math.max(1, h * 0.0055 * (1 - s * 0.5));
        for (var side = -1; side <= 1; side += 2) {
          var a2 = Math.atan2(tdy, tdx) + side * 0.75, lx = Math.cos(a2) * ll, ly = Math.sin(a2) * ll + ll * 0.75;
          x.beginPath(); x.moveTo(qx, qy); x.quadraticCurveTo(qx + lx * 0.5, qy + ly * 0.3, qx + lx, qy + ly); x.stroke();
        }
      }
    }
    x.fillStyle = col; for (i = 0; i < 3; i++) { x.beginPath(); x.arc(tx + (i - 1) * h * 0.018, ty + h * 0.02, h * 0.014, 0, TAU); x.fill(); }
    x.lineCap = 'butt';
  }
  function ridge(x, W, H, R, base, amp, freq, seed, col, sharp) {
    x.fillStyle = col; x.beginPath(); x.moveTo(0, H);
    for (var px = 0; px <= W + 8; px += 6) {
      var u = px / W, n = fbm(u * freq + seed, seed * 7 + 3, 5), r = 1 - Math.abs(vnoise(u * freq * 0.6 + seed * 3, seed + 99));
      var y = base - amp * (0.55 * n + (sharp ? 0.65 * r * r : 0.2 * r));
      x.lineTo(px, y);
    }
    x.lineTo(W, H); x.closePath(); x.fill();
  }

  var DEMO_PAINT = [
    function beach(x, W, H, R) {
      var hz = H * 0.6, sx = W * 0.56, sy = hz - W * 0.025, sr = W * 0.075, i;
      vgrad(x, W, 0, hz + 2, [[0, '#131a52'], [0.3, '#47307f'], [0.56, '#b84a86'], [0.8, '#ff7e5f'], [1, '#ffc57a']]);
      starsField(x, W, R, 60, hz * 0.35, 0.7);
      radial(x, sx, sy, W * 1.05, [[0, 'rgba(255,190,120,0.6)'], [0.35, 'rgba(255,120,110,0.2)'], [1, 'rgba(255,100,100,0)']], 'screen');
      radial(x, sx, sy, W * 0.32, [[0, 'rgba(255,240,200,0.95)'], [0.4, 'rgba(255,200,130,0.4)'], [1, 'rgba(255,180,120,0)']], 'screen');
      var g = x.createRadialGradient(sx, sy, 0, sx, sy, sr); g.addColorStop(0, '#fffdf0'); g.addColorStop(0.7, '#fff2c4'); g.addColorStop(1, '#ffd58e');
      x.fillStyle = g; x.beginPath(); x.arc(sx, sy, sr, 0, TAU); x.fill();
      for (i = 0; i < 11; i++) {
        var cy0 = hz * (0.42 + R() * 0.5), cx0 = W * R(), cw0 = W * (0.22 + R() * 0.45), ch0 = H * (0.006 + R() * 0.012);
        x.fillStyle = 'rgba(110,40,110,' + (0.2 + R() * 0.2) + ')'; x.beginPath(); x.ellipse(cx0, cy0 - ch0 * 0.5, cw0 / 2, ch0, 0, 0, TAU); x.fill();
        x.fillStyle = 'rgba(255,' + (140 + R() * 70 | 0) + ',130,' + (0.25 + R() * 0.3) + ')'; x.beginPath(); x.ellipse(cx0, cy0 + ch0 * 0.4, cw0 / 2.2, ch0 * 0.6, 0, 0, TAU); x.fill();
      }
      vgrad(x, W, hz, H, [[0, '#ffb27a'], [0.025, '#d0688a'], [0.25, '#5a3478'], [0.7, '#22194a'], [1, '#100c26']]);
      x.globalCompositeOperation = 'lighter';
      for (i = 0; i < 120; i++) {
        var k = i / 120, yy = hz + Math.pow(k, 1.7) * H * 0.33 + 2, ww = (W * 0.04 + W * 0.36 * k) * (0.3 + 0.7 * R());
        var xx = sx + (R() - 0.5) * W * 0.05 * (1 + k * 3) - ww / 2;
        x.fillStyle = 'rgba(255,' + (200 + 40 * (1 - k) | 0) + ',140,' + (0.5 * (1 - k * 0.7) * (0.4 + 0.6 * R())) + ')'; x.fillRect(xx, yy, ww, 1.5 + k * 4);
      }
      for (i = 0; i < 70; i++) { x.fillStyle = 'rgba(255,200,220,' + (0.06 + R() * 0.1) + ')'; x.fillRect(R() * W, hz + R() * H * 0.3, W * (0.05 + R() * 0.2), 1.5); }
      x.globalCompositeOperation = 'source-over';
      x.fillStyle = 'rgba(255,230,190,0.8)'; x.fillRect(0, hz - 1, W, 2);
      var sg = x.createLinearGradient(0, H * 0.84, 0, H); sg.addColorStop(0, '#2a1630'); sg.addColorStop(1, '#0a0610'); x.fillStyle = sg;
      x.beginPath(); x.moveTo(0, H * 0.87); x.bezierCurveTo(W * 0.3, H * 0.84, W * 0.62, H * 0.92, W, H * 0.885); x.lineTo(W, H); x.lineTo(0, H); x.closePath(); x.fill();
      x.strokeStyle = 'rgba(255,170,160,0.35)'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, H * 0.868); x.bezierCurveTo(W * 0.3, H * 0.838, W * 0.62, H * 0.918, W, H * 0.883); x.stroke();
      palm(x, R, W * 0.1, H * 1.0, H * 0.62, 0.2, '#0c0614');
      palm(x, R, W * 0.92, H * 0.99, H * 0.42, -0.16, '#0c0614');
      palm(x, R, W * 0.8, H * 1.0, H * 0.3, -0.05, '#0c0614');
      birds(x, R, 5, W * 0.38, H * 0.3, W * 0.22, W * 0.018, 'rgba(30,15,45,0.8)');
    },
    function city(x, W, H, R) {
      var hz = H * 0.67, i;
      vgrad(x, W, 0, hz + 2, [[0, '#05061c'], [0.45, '#1b0f45'], [0.8, '#4d1a66'], [1, '#a53c7a']]);
      starsField(x, W, R, 80, hz * 0.5, 0.8);
      radial(x, W * 0.5, hz, W * 0.95, [[0, 'rgba(255,80,170,0.45)'], [0.5, 'rgba(140,60,200,0.15)'], [1, 'rgba(0,0,0,0)']], 'screen');
      radial(x, W * 0.8, H * 0.12, W * 0.15, [[0, 'rgba(255,240,230,0.9)'], [0.25, 'rgba(255,220,240,0.35)'], [1, 'rgba(255,220,240,0)']], 'screen');
      x.fillStyle = '#fff4ef'; x.beginPath(); x.arc(W * 0.8, H * 0.12, W * 0.035, 0, TAU); x.fill();
      var layers = [{ c: '#2b1d58', h0: 0.14, h1: 0.4, w0: 0.05, w1: 0.1, win: 0.12 }, { c: '#1a1140', h0: 0.08, h1: 0.3, w0: 0.06, w1: 0.12, win: 0.32 }, { c: '#0c0822', h0: 0.03, h1: 0.16, w0: 0.08, w1: 0.16, win: 0.22 }];
      var lit = [];
      layers.forEach(function (L, li) {
        var x0 = -R() * W * 0.05;
        while (x0 < W) {
          var bw = W * (L.w0 + R() * (L.w1 - L.w0)), bh = H * (L.h0 + R() * (L.h1 - L.h0)), top = hz - bh;
          x.fillStyle = L.c; x.fillRect(x0, top, bw - W * 0.004, bh + 2);
          if (R() < 0.3) x.fillRect(x0 + bw * 0.4, top - H * 0.04, Math.max(2, W * 0.004), H * 0.04);
          if (R() < 0.3) x.fillRect(x0 + bw * 0.15, top - H * 0.015, bw * 0.6, H * 0.016);
          var cs = W * 0.013, rs = H * 0.016;
          for (var yy = top + rs; yy < hz - rs; yy += rs) for (var xx = x0 + cs * 0.6; xx < x0 + bw - cs; xx += cs) {
            if (R() < L.win) {
              var cc = R(), col = cc < 0.6 ? '255,210,140' : cc < 0.85 ? '140,240,255' : '255,140,220', a = 0.5 + R() * 0.5;
              x.fillStyle = 'rgba(' + col + ',' + a * (li === 0 ? 0.5 : 1) + ')'; x.fillRect(xx, yy, cs * 0.5, rs * 0.45);
              if (li > 0 && lit.length < 400 && R() < 0.5) lit.push([xx, yy, col]);
            }
          }
          x0 += bw;
        }
      });
      vgrad(x, W, hz, H, [[0, '#2a1448'], [0.3, '#140a2c'], [1, '#05030f']]);
      x.globalCompositeOperation = 'lighter';
      lit.forEach(function (p) {
        var ry = hz + (hz - p[1]) * 0.55;
        for (var k = 0; k < 6; k++) { x.fillStyle = 'rgba(' + p[2] + ',' + (0.12 * (1 - k / 6)) + ')'; x.fillRect(p[0] + (R() - 0.5) * 6, ry + k * H * 0.012, W * 0.008 + R() * W * 0.01, 2); }
      });
      x.fillStyle = 'rgba(255,120,200,0.5)'; x.fillRect(0, hz, W, 2);
      var bcols = ['#ff4fa3', '#46e6ff', '#ffb347', '#a974ff', '#ff7b54'];
      for (i = 0; i < 34; i++) {
        var side = R(), bx = side < 0.5 ? R() * W * 0.45 : W * 0.55 + R() * W * 0.45, by = H * (0.5 + R() * 0.5), br = W * (0.025 + Math.pow(R(), 2) * 0.1);
        disc(x, bx, by, br, bcols[i % bcols.length], 0.2 + R() * 0.3);
      }
      x.globalCompositeOperation = 'source-over';
    },
    function flowers(x, W, H, R) {
      var hz = H * 0.46, i;
      vgrad(x, W, 0, hz + 2, [[0, '#2f74c9'], [0.45, '#7fb3e6'], [0.85, '#d9e6f0'], [1, '#ffe1c2']]);
      radial(x, W * 0.78, H * 0.16, W * 0.7, [[0, 'rgba(255,244,214,0.95)'], [0.18, 'rgba(255,230,190,0.45)'], [1, 'rgba(255,220,170,0)']], 'screen');
      for (i = 0; i < 9; i++) { // soft cumulus: many faint puffs
        var cx0 = W * (R() * 1.1 - 0.05), cy0 = H * (0.06 + R() * 0.26), cs = W * (0.05 + R() * 0.06);
        for (var j = 0; j < 14; j++) {
          var px0 = cx0 + (R() - 0.5) * cs * 4, py0 = cy0 + (R() - 0.6) * cs * 0.9, pr = cs * (0.5 + R() * 0.7);
          radial(x, px0, py0, pr, [[0, 'rgba(255,255,255,0.38)'], [0.6, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)']]);
        }
      }
      ridge(x, W, H, R, hz + H * 0.005, H * 0.07, 1.6, 3, '#8fb3c4', false);
      var hm = x.createLinearGradient(0, hz - H * 0.05, 0, hz + H * 0.03); hm.addColorStop(0, 'rgba(230,240,250,0)'); hm.addColorStop(1, 'rgba(230,240,250,0.5)');
      x.fillStyle = hm; x.fillRect(0, hz - H * 0.05, W, H * 0.08);
      ridge(x, W, H, R, hz + H * 0.035, H * 0.045, 2.4, 5, '#6d9c62', false);
      vgrad(x, W, hz + H * 0.03, H, [[0, '#7fa85a'], [0.4, '#4a7d34'], [1, '#203f18']]);
      var cols = ['#ff5fa2', '#ff8fb8', '#ffd23f', '#ffffff', '#ff7a59', '#c77dff', '#ff3f7f', '#ffb3d1'];
      var fl = [];
      for (i = 0; i < 2600; i++) { var d = R(); fl.push([R() * W, d]); }
      fl.sort(function (a, b) { return a[1] - b[1]; });
      fl.forEach(function (p, k) {
        var d = p[1], y = hz + H * 0.04 + (H - hz) * Math.pow(d, 1.6), s = (1.5 + 26 * d * d) * W / 1080, col = cols[k % cols.length];
        if (s < 4) { x.fillStyle = col; x.globalAlpha = 0.85; x.fillRect(p[0], y, s, s * 0.8); x.globalAlpha = 1; return; }
        if (s > 10) { x.strokeStyle = '#2f5e22'; x.lineWidth = s * 0.12; x.beginPath(); x.moveTo(p[0], y); x.lineTo(p[0] + s * 0.2, y + s * 3); x.stroke(); }
        x.fillStyle = col;
        for (var q = 0; q < 5; q++) { var a = q / 5 * TAU + k; x.beginPath(); x.ellipse(p[0] + Math.cos(a) * s * 0.42, y + Math.sin(a) * s * 0.3, s * 0.36, s * 0.26, a, 0, TAU); x.fill(); }
        x.fillStyle = k % 3 ? '#ffcf3a' : '#7a4a12'; x.beginPath(); x.arc(p[0], y, s * 0.18, 0, TAU); x.fill();
      });
      x.globalCompositeOperation = 'lighter';
      disc(x, W * 0.05, H * 0.92, W * 0.16, '#ff6fae', 0.45); disc(x, W * 0.95, H * 0.86, W * 0.13, '#ffd23f', 0.4); disc(x, W * 0.86, H * 0.98, W * 0.1, '#ffffff', 0.3);
      for (i = 0; i < 40; i++) { var px2 = R() * W, py2 = hz + R() * (H - hz) * 0.7; radial(x, px2, py2, W * 0.006 + R() * W * 0.006, [[0, 'rgba(255,250,220,0.9)'], [1, 'rgba(255,250,220,0)']]); }
      x.globalCompositeOperation = 'source-over';
      radial(x, W * 0.78, H * 0.16, W * 1.3, [[0, 'rgba(255,200,140,0.25)'], [1, 'rgba(255,200,140,0)']], 'screen');
    },
    function mountains(x, W, H, R) {
      var i;
      vgrad(x, W, 0, H, [[0, '#26345e'], [0.28, '#6a68a0'], [0.5, '#e3a4a0'], [0.62, '#ffdcb0'], [1, '#ffe8c8']]);
      starsField(x, W, R, 45, H * 0.22, 0.6);
      radial(x, W * 0.62, H * 0.5, W * 0.9, [[0, 'rgba(255,240,210,0.8)'], [0.25, 'rgba(255,200,160,0.35)'], [1, 'rgba(255,200,160,0)']], 'screen');
      x.fillStyle = '#fff6e2'; x.beginPath(); x.arc(W * 0.62, H * 0.5, W * 0.04, 0, TAU); x.fill();
      var cols = ['#c9b0cf', '#a993bf', '#7f74a6', '#565a8a', '#343b68', '#1a1f3c'];
      for (var L = 0; L < 6; L++) {
        var base = H * (0.52 + L * 0.075), amp = H * (0.1 + L * 0.018);
        ridge(x, W, H, R, base, amp, 2.2 + L * 0.5, 11 + L * 5, cols[L], L < 4);
        var mg = x.createLinearGradient(0, base - amp * 0.3, 0, base + H * 0.07);
        mg.addColorStop(0, 'rgba(255,236,228,0)'); mg.addColorStop(0.6, 'rgba(255,236,228,' + (0.42 - L * 0.05) + ')'); mg.addColorStop(1, 'rgba(255,236,228,0)');
        x.fillStyle = mg; x.fillRect(0, base - amp * 0.3, W, amp * 0.3 + H * 0.07);
      }
      x.fillStyle = '#10142a';
      for (i = 0; i < 26; i++) {
        var tx = R() * W, th = H * (0.05 + R() * 0.08), ty = H * (0.97 + R() * 0.04), tw = th * 0.32;
        for (var s = 0; s < 4; s++) { var yy = ty - th * (s / 4), ww = tw * (1 - s / 5); x.beginPath(); x.moveTo(tx - ww, yy); x.lineTo(tx, yy - th * 0.45); x.lineTo(tx + ww, yy); x.closePath(); x.fill(); }
      }
      birds(x, R, 4, W * 0.48, H * 0.4, W * 0.18, W * 0.014, 'rgba(60,40,80,0.7)');
    },
    function party(x, W, H, R) {
      var i;
      var g = x.createRadialGradient(W * 0.5, H * 0.3, 0, W * 0.5, H * 0.3, H * 0.9);
      g.addColorStop(0, '#5a1a52'); g.addColorStop(0.45, '#2a0c33'); g.addColorStop(1, '#0a0510'); x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = 'lighter';
      var bc = ['#ff3fa8', '#ffc04d', '#a45bff', '#40d9ff', '#ff7a3d'];
      for (i = 0; i < 38; i++) disc(x, R() * W, R() * H, W * (0.02 + Math.pow(R(), 2) * 0.11), bc[i % bc.length], 0.15 + R() * 0.3);
      // light beams from the ball
      var bx = W * 0.5, by = H * 0.2, br = W * 0.13;
      for (i = 0; i < 9; i++) {
        var a = Math.PI * 0.15 + R() * Math.PI * 0.7, len = H * (0.6 + R() * 0.5), wa = 0.05 + R() * 0.06, col = bc[i % bc.length];
        var lg = x.createRadialGradient(bx, by, br, bx, by, len); lg.addColorStop(0, rgba(col, 0.25)); lg.addColorStop(1, rgba(col, 0));
        x.fillStyle = lg; x.beginPath(); x.moveTo(bx, by); x.arc(bx, by, len, a - wa, a + wa); x.closePath(); x.fill();
      }
      x.globalCompositeOperation = 'source-over';
      x.strokeStyle = 'rgba(200,200,220,0.6)'; x.lineWidth = 2; x.beginPath(); x.moveTo(bx, 0); x.lineTo(bx, by - br); x.stroke();
      x.save(); x.beginPath(); x.arc(bx, by, br, 0, TAU); x.clip();
      var sg = x.createRadialGradient(bx - br * 0.35, by - br * 0.35, br * 0.1, bx, by, br); sg.addColorStop(0, '#f4f4ff'); sg.addColorStop(0.6, '#8c8aa8'); sg.addColorStop(1, '#2a2840');
      x.fillStyle = sg; x.fillRect(bx - br, by - br, br * 2, br * 2);
      var fs = br / 6;
      for (var yy = by - br; yy < by + br; yy += fs) for (var xx = bx - br; xx < bx + br; xx += fs) {
        var v = R(); if (v > 0.82) { x.fillStyle = 'rgba(255,255,255,' + (0.5 + R() * 0.5) + ')'; x.fillRect(xx + 1, yy + 1, fs - 2, fs - 2); }
        else if (v < 0.15) { x.fillStyle = 'rgba(20,10,40,0.35)'; x.fillRect(xx + 1, yy + 1, fs - 2, fs - 2); }
        else if (v < 0.3) { x.fillStyle = rgba(bc[(v * 100 | 0) % bc.length], 0.35); x.fillRect(xx + 1, yy + 1, fs - 2, fs - 2); }
      }
      x.strokeStyle = 'rgba(20,10,30,0.5)'; x.lineWidth = 1.5;
      for (yy = by - br; yy < by + br; yy += fs) { x.beginPath(); x.moveTo(bx - br, yy); x.lineTo(bx + br, yy); x.stroke(); }
      for (xx = bx - br; xx < bx + br; xx += fs) { x.beginPath(); x.moveTo(xx, by - br); x.lineTo(xx, by + br); x.stroke(); }
      x.restore();
      x.globalCompositeOperation = 'lighter';
      radial(x, bx - br * 0.4, by - br * 0.4, br * 0.5, [[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]);
      // string lights
      for (var s = 0; s < 4; s++) {
        var y0 = H * (0.42 + s * 0.12), sag = H * (0.05 + R() * 0.04), x0 = -W * 0.05, x1 = W * 1.05;
        x.strokeStyle = 'rgba(40,20,40,0.9)'; x.lineWidth = 2; x.beginPath();
        for (var k = 0; k <= 40; k++) { var u = k / 40, px = lerp(x0, x1, u), py = y0 + sag * (1 - Math.pow(u * 2 - 1, 2)) + Math.sin(u * 9 + s) * 4; if (k) x.lineTo(px, py); else x.moveTo(px, py); }
        x.globalCompositeOperation = 'source-over'; x.stroke(); x.globalCompositeOperation = 'lighter';
        for (k = 0; k <= 16; k++) {
          var u2 = k / 16, qx = lerp(x0, x1, u2), qy = y0 + sag * (1 - Math.pow(u2 * 2 - 1, 2)) + Math.sin(u2 * 9 + s) * 4 + W * 0.012, warm = R() < 0.75 ? '#ffcf7a' : bc[k % bc.length];
          radial(x, qx, qy, W * 0.05, [[0, rgba(warm, 0.55)], [0.3, rgba(warm, 0.2)], [1, rgba(warm, 0)]]);
          radial(x, qx, qy, W * 0.012, [[0, 'rgba(255,255,240,1)'], [1, rgba(warm, 0)]]);
        }
      }
      x.globalCompositeOperation = 'source-over';
      for (i = 0; i < 140; i++) {
        var cx0 = R() * W, cy0 = R() * H, cw = W * (0.008 + R() * 0.012);
        x.save(); x.translate(cx0, cy0); x.rotate(R() * TAU); x.fillStyle = ['#ffd34d', '#ff4fa3', '#4fe3ff', '#ffffff', '#b77bff'][i % 5]; x.globalAlpha = 0.6 + R() * 0.4;
        x.fillRect(-cw / 2, -cw * 0.25, cw, cw * 0.5 * (0.3 + R())); x.restore();
      }
      x.globalAlpha = 1;
      var fg = x.createLinearGradient(0, H * 0.75, 0, H); fg.addColorStop(0, 'rgba(255,120,80,0)'); fg.addColorStop(1, 'rgba(255,120,80,0.25)'); x.fillStyle = fg; x.fillRect(0, H * 0.75, W, H * 0.25);
    },
    function aurora(x, W, H, R) {
      var i, sh = H * 0.66;
      vgrad(x, W, 0, sh + 2, [[0, '#030616'], [0.55, '#0a1a3a'], [1, '#173a60']]);
      starsField(x, W, R, 260, sh, 0.9);
      x.globalCompositeOperation = 'lighter';
      for (var r = 0; r < 3; r++) {
        var ph = R() * 10, base = H * (0.24 + r * 0.06), hh = H * (0.2 + R() * 0.1), cA = r === 2 ? '#ff6bd5' : '#4dffb0', cB = r === 1 ? '#7a5cff' : '#3dd6ff';
        for (var px = 0; px < W; px += 3) {
          var u = px / W, yc = base + Math.sin(u * 3.2 + ph) * H * 0.07 + Math.sin(u * 9 + ph * 2) * H * 0.012;
          var h2 = hh * (0.75 + 0.25 * Math.sin(u * 5 + ph * 3)) * (0.7 + 0.3 * vnoise(u * 40 + r * 9, 5));
          var a = (0.22 + 0.12 * Math.sin(u * 4 + ph)) * (0.7 + 0.6 * Math.pow(Math.max(0, vnoise(u * 60 + r * 3, 8)), 2)) * (r === 2 ? 0.6 : 1);
          var lg = x.createLinearGradient(0, yc - h2, 0, yc + h2 * 0.15);
          lg.addColorStop(0, rgba(cB, 0)); lg.addColorStop(0.7, rgba(cA, a)); lg.addColorStop(0.92, rgba('#e8fff4', a * 1.2)); lg.addColorStop(1, rgba(cA, 0));
          x.fillStyle = lg; x.fillRect(px, yc - h2, 3, h2 * 1.15);
        }
      }
      x.globalCompositeOperation = 'source-over';
      ridge(x, W, H, R, sh - H * 0.01, H * 0.08, 2.5, 41, '#0d1830', true);
      var rg = x.createLinearGradient(0, sh - H * 0.14, 0, sh); rg.addColorStop(0, 'rgba(150,200,255,0.22)'); rg.addColorStop(1, 'rgba(150,200,255,0)');
      x.save(); x.globalCompositeOperation = 'source-atop'; x.fillStyle = rg; x.fillRect(0, sh - H * 0.16, W, H * 0.16); x.restore();
      // lake reflection
      x.save(); x.beginPath(); x.rect(0, sh, W, H - sh); x.clip();
      x.translate(0, sh * 2); x.scale(1, -1); x.globalAlpha = 0.45; x.drawImage(x.canvas, 0, 0, W, sh, 0, 0, W, sh); x.restore();
      vgrad(x, W, sh, H, [[0, 'rgba(5,10,25,0.35)'], [1, 'rgba(2,4,12,0.9)']]);
      x.fillStyle = 'rgba(180,255,230,0.12)'; for (i = 0; i < 60; i++) x.fillRect(R() * W, sh + R() * (H - sh), W * (0.04 + R() * 0.2), 1.5);
      x.fillStyle = '#050a16';
      for (i = 0; i < 40; i++) { var tx2 = R() * W, th2 = H * (0.03 + R() * 0.05); x.beginPath(); x.moveTo(tx2 - th2 * 0.25, sh + 2); x.lineTo(tx2, sh - th2); x.lineTo(tx2 + th2 * 0.25, sh + 2); x.closePath(); x.fill(); }
      x.fillRect(0, sh - 2, W, 4);
    }
  ];
  var DEMO = [];
  function demoPhoto(i) {
    if (DEMO[i]) return DEMO[i];
    var W = 1080, H = 1350, kind = i % DEMO_PAINT.length, variant = Math.floor(i / DEMO_PAINT.length);
    var c = mk(W, H), x = cx(c), R = mulberry32(1234 + i * 7919);
    DEMO_PAINT[kind](x, W, H, R);
    x.globalAlpha = 0.05; x.fillStyle = pattern(x, noiseTiles()[2]); x.fillRect(0, 0, W, H); x.globalAlpha = 1;
    vignette(c, 0.3, '#000000', 0.55);
    if (variant % 2 === 1) { // mirrored variant for long demo sets
      var m = mk(W, H), mx = cx(m); mx.translate(W, 0); mx.scale(-1, 1); mx.drawImage(c, 0, 0); free(c); c = m;
    }
    DEMO[i] = c;
    return c;
  }
  function demoPhotos(n) {
    n = n == null ? 4 : Math.max(0, Math.min(60, n | 0));
    var out = [];
    for (var i = 0; i < n; i++) out.push(demoPhoto(i));
    return out;
  }

  /* ======================================================================
   * 5. Public API
   * ==================================================================== */
  window.GlowFX = {
    version: '1.0.0',
    templates: TEMPLATES.map(function (t) { return { id: t.id, name: t.name, desc: t.desc, tag: t.tag, track: t.track, colors: t.colors.slice() }; }),
    fonts: [
      '800 64px "Outfit"', '700 64px "Outfit"', '600 64px "Outfit"', '400 64px "Outfit"', '300 64px "Outfit"',
      '700 64px "Playfair Display"', 'italic 400 64px "Playfair Display"',
      '700 64px "Caveat"', '400 64px "Anton"', '400 64px "VT323"', '400 64px "Bangers"'
    ],
    demoPhotos: demoPhotos,
    createScene: createScene,
    _plan: function (n, bpm, id) { var t = IMPL[id] || IMPL.glowup; return makePlan(n, bpm, t.cfg); }
  };
})();
