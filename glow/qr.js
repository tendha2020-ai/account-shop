/* Glow Studio — a small QR code encoder (qr.js), for the "Share with friends" link on the host's page.
 *
 *   GlowQR.encode(text, { minVersion: 1, maxVersion: 10, mask: 0..7 (optional) })
 *     -> { version, mask, size, modules: boolean[][] }   (modules[row][col], true = dark)
 *   GlowQR.draw(canvas, text, { scale, quiet: 4, px })     black on white; px = CSS size to fit (crisp at any DPR)
 *   GlowQR.capacity(version)                               bytes that fit at error correction M
 *
 * ISO/IEC 18004: byte mode (the text as UTF-8), error correction level M only, versions 1–10, Reed–Solomon over
 * GF(256) (polynomial 0x11D), the standard block structure, alignment patterns, version information (7–10),
 * format information, and all 8 masks scored with penalty rules N1–N4 (the lowest score wins, as the standard says).
 * Throws an Error with code 'too-long' above 213 bytes. No external libraries, plain classic script.
 */
(function (root) {
  'use strict';
  // error correction level M, versions 1..10: [ec codewords per block, [blocks, data codewords per block], ...]
  var BLOCKS = [null,
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  var REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
  var FORMAT_M = 0; // the 2 error-correction bits of level M in the format information

  function dataCodewords(v) { var b = BLOCKS[v], n = 0; for (var i = 1; i < b.length; i++) n += b[i][0] * b[i][1]; return n; }
  function countBits(v) { return v < 10 ? 8 : 16; }
  function capacity(v) { return Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8); }

  function utf8(text) {
    text = String(text);
    if (typeof TextEncoder === 'function') return Array.prototype.slice.call(new TextEncoder().encode(text));
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { var d = text.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  // ---- Reed–Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ----
  var EXP = new Array(512), LOG = new Array(256);
  (function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255]; })();
  function mul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  var genCache = {};
  // generator polynomial (x - a^0)(x - a^1)…(x - a^(n-1)), highest coefficient first, the leading 1 left out
  function generator(n) {
    if (genCache[n]) return genCache[n];
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
      g = next;
    }
    return (genCache[n] = g.slice(1));
  }
  function ecc(data, n) {
    var g = generator(n), r = new Array(n);
    for (var i = 0; i < n; i++) r[i] = 0;
    data.forEach(function (b) {
      var f = b ^ r.shift();
      r.push(0);
      for (var k = 0; k < n; k++) r[k] ^= mul(g[k], f);
    });
    return r;
  }

  // ---- data codewords: mode, count, bytes, terminator, padding; then blocks + interleaving ----
  function codewords(bytes, v) {
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, countBits(v));
    bytes.forEach(function (b) { put(b, 8); });
    var cap = dataCodewords(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var k = 0; k < 8; k++) x = (x << 1) | bits[i + k]; data.push(x); }
    for (var p = 0; data.length < dataCodewords(v); p++) data.push(p % 2 ? 0x11 : 0xec);
    var spec = BLOCKS[v], nEc = spec[0], blocks = [], at = 0;
    for (var s = 1; s < spec.length; s++) for (var c = 0; c < spec[s][0]; c++) { var d = data.slice(at, at + spec[s][1]); at += spec[s][1]; blocks.push({ d: d, e: ecc(d, nEc) }); }
    var out = [], maxD = 0;
    blocks.forEach(function (b) { maxD = Math.max(maxD, b.d.length); });
    for (var j = 0; j < maxD; j++) blocks.forEach(function (b) { if (j < b.d.length) out.push(b.d[j]); });
    for (var e = 0; e < nEc; e++) blocks.forEach(function (b) { out.push(b.e[e]); });
    return out;
  }

  // ---- the symbol ----
  function Symbol(v) {
    this.v = v; this.size = v * 4 + 17;
    this.m = []; this.fn = [];
    for (var y = 0; y < this.size; y++) { this.m.push(new Array(this.size).fill(false)); this.fn.push(new Array(this.size).fill(false)); }
  }
  Symbol.prototype.set = function (x, y, dark) { this.m[y][x] = !!dark; this.fn[y][x] = true; };
  Symbol.prototype.functionPatterns = function () {
    var n = this.size, i, self = this;
    for (i = 0; i < n; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    [[3, 3], [n - 4, 3], [3, n - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = c[0] + dx, y = c[1] + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < n && y >= 0 && y < n) self.set(x, y, d !== 2 && d !== 4);
      }
    });
    var a = ALIGN[this.v], last = a.length - 1;
    for (var p = 0; p < a.length; p++) for (var q = 0; q < a.length; q++) {
      if ((p === 0 && q === 0) || (p === 0 && q === last) || (p === last && q === 0)) continue;
      for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) this.set(a[p] + ax, a[q] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
    }
    this.format(0);
    if (this.v >= 7) {
      var rem = this.v;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var bits = (this.v << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (bits >>> i) & 1, aa = n - 11 + (i % 3), bb = Math.floor(i / 3);
        this.set(aa, bb, bit); this.set(bb, aa, bit);
      }
    }
  };
  Symbol.prototype.format = function (mask) {
    var data = (FORMAT_M << 3) | mask, rem = data, i, n = this.size;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var bit = function (k) { return (bits >>> k) & 1; };
    for (i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, 1); // the dark module
  };
  Symbol.prototype.place = function (cw) {
    var n = this.size, i = 0, total = cw.length * 8;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
        if (!this.fn[y][x] && i < total) { this.m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  };
  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }
  Symbol.prototype.mask = function (mask) {
    for (var y = 0; y < this.size; y++) for (var x = 0; x < this.size; x++) if (!this.fn[y][x] && maskBit(mask, x, y)) this.m[y][x] = !this.m[y][x];
  };
  // penalty rules N1 (runs of 5+), N2 (2x2 blocks), N3 (finder-like 1:1:3:1:1 with 4 light modules), N4 (balance)
  Symbol.prototype.penalty = function () {
    var n = this.size, m = this.m, score = 0, x, y;
    function addHistory(len, h) { if (h[0] === 0) len += n; h.pop(); h.unshift(len); }
    function countPatterns(h) {
      var k = h[1], core = k > 0 && h[2] === k && h[3] === k * 3 && h[4] === k && h[5] === k;
      return (core && h[0] >= k * 4 && h[6] >= k ? 1 : 0) + (core && h[6] >= k * 4 && h[0] >= k ? 1 : 0);
    }
    function terminate(color, len, h) { if (color) { addHistory(len, h); len = 0; } len += n; addHistory(len, h); return countPatterns(h); }
    function line(get) {
      for (var a = 0; a < n; a++) {
        var color = false, run = 0, h = [0, 0, 0, 0, 0, 0, 0];
        for (var b = 0; b < n; b++) {
          if (get(a, b) === color) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else { addHistory(run, h); if (!color) score += countPatterns(h) * 40; color = get(a, b); run = 1; }
        }
        score += terminate(color, run, h) * 40;
      }
    }
    line(function (a, b) { return m[a][b]; });
    line(function (a, b) { return m[b][a]; });
    for (y = 0; y < n - 1; y++) for (x = 0; x < n - 1; x++) { var c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3; }
    var dark = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (m[y][x]) dark++;
    var total = n * n, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return score + k * 10;
  };

  function encode(text, opt) {
    opt = opt || {};
    var bytes = utf8(text), lo = Math.max(1, opt.minVersion || 1), hi = Math.min(10, opt.maxVersion || 10), v = 0;
    for (var t = lo; t <= hi; t++) if (bytes.length <= capacity(t)) { v = t; break; }
    if (!v) { var e = new Error('This link is too long for a QR code (' + bytes.length + ' bytes).'); e.code = 'too-long'; throw e; }
    var cw = codewords(bytes, v), s = new Symbol(v);
    s.functionPatterns();
    s.place(cw);
    var mask = opt.mask;
    if (!(mask >= 0 && mask <= 7)) {
      var best = Infinity;
      for (var k = 0; k < 8; k++) { s.mask(k); s.format(k); var p = s.penalty(); if (p < best) { best = p; mask = k; } s.mask(k); }
    }
    s.mask(mask); s.format(mask);
    return { version: v, mask: mask, size: s.size, modules: s.m.map(function (r) { return r.slice(); }) };
  }

  // Black on white with a quiet zone of 4 modules. opt.px: the CSS size the canvas is shown at (sharp on any screen).
  function draw(canvas, text, opt) {
    opt = opt || {};
    var q = encode(text, opt), quiet = opt.quiet == null ? 4 : opt.quiet, cells = q.size + quiet * 2;
    var dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    var scale = opt.scale || Math.max(2, Math.floor(((opt.px || 220) * dpr) / cells));
    canvas.width = canvas.height = cells * scale;
    var g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#000000';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.modules[y][x]) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    return q;
  }

  root.GlowQR = { encode: encode, draw: draw, capacity: capacity };
})(typeof window !== 'undefined' ? window : this);
