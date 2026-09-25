// convert.js
// Video/audio file -> MP3, entirely in the browser:
//   1. mp4.js pulls the sound track out of MP4/MOV files (other formats go to the browser as-is)
//   2. the browser's own decoder turns it into PCM at 44.1 kHz
//   3. lamejs (LAME) encodes the PCM to a constant-bitrate MP3
// Also builds the ID3 title tag and the .zip used for "Save all".

(function (root) {
  'use strict';

  const V2M = root.V2M || (root.V2M = {});
  const OUTPUT_RATE = 44100;
  const ENCODE_BLOCK = 1152 * 8; // samples per channel handed to LAME at a time
  const SLICE_MS = 24; // encode this long, then let the page repaint

  class ConvertError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'ConvertError';
      this.code = code;
    }
  }

  const cancelled = () => new ConvertError('cancelled', 'Stopped.');
  const now = () => (root.performance ? root.performance.now() : Date.now());
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // ---------- decoding ----------

  let decodeContext = null;
  function getDecodeContext() {
    if (!decodeContext) {
      const Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      if (!Ctx) throw new ConvertError('unsupported', "This browser can't decode audio. Update it and try again.");
      decodeContext = new Ctx(2, 1, OUTPUT_RATE);
    }
    return decodeContext;
  }

  // decodeAudioData, promise or callback style (older Safari only has callbacks).
  function decodeAudio(arrayBuffer) {
    const ctx = getDecodeContext();
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = (buffer) => {
        if (done) return;
        done = true;
        if (buffer && buffer.length > 0) resolve(buffer);
        else reject(new Error('Decoded audio is empty.'));
      };
      const fail = (err) => {
        if (done) return;
        done = true;
        reject(err || new Error('Decoding failed.'));
      };
      try {
        const p = ctx.decodeAudioData(arrayBuffer, ok, fail);
        if (p && typeof p.then === 'function') p.then(ok, fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  async function decodeFile(file, report, signal) {
    let info = null;
    let variants = [];
    report('reading', 0);
    try {
      const res = await V2M.mp4.extractAudio(file, (f) => report('reading', f));
      if (res) {
        info = res.info;
        variants = res.variants;
      }
    } catch (err) {
      if (err instanceof V2M.mp4.NoAudioTrackError) throw new ConvertError('no-audio', 'This video has no sound.');
      // Anything else: let the browser try the whole file below.
    }
    if (signal && signal.aborted) throw cancelled();

    report('decoding', 0);
    for (const variant of variants) {
      try {
        const buffer = await decodeAudio(variant.build());
        return { buffer, info, via: variant.name };
      } catch (err) {
        // try the next container
      }
      if (signal && signal.aborted) throw cancelled();
    }

    let whole;
    try {
      whole = await file.arrayBuffer();
    } catch (err) {
      throw new ConvertError('too-big', `This file is too big to open on this device (${formatBytes(file.size)}). Try a shorter video.`);
    }
    if (signal && signal.aborted) throw cancelled();
    try {
      const buffer = await decodeAudio(whole);
      return { buffer, info, via: 'file' };
    } catch (err) {
      const what = info && info.codec ? `${info.codec} sound` : 'the sound in this file';
      throw new ConvertError('unsupported', `This browser can't read ${what}. Try another video, or update the browser.`);
    }
  }

  // ---------- waveform ----------

  // Loudest sample in each of `count` equal slices, 0..1.
  function peaks(buffer, count) {
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const len = buffer.length;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.floor((i * len) / count);
      const b = Math.max(a + 1, Math.floor(((i + 1) * len) / count));
      const stride = Math.max(1, Math.floor((b - a) / 4096));
      let m = 0;
      for (const ch of chans) {
        for (let k = a; k < b && k < len; k += stride) {
          const v = ch[k] < 0 ? -ch[k] : ch[k];
          if (v > m) m = v;
        }
      }
      out[i] = m > 1 ? 1 : m;
    }
    return out;
  }

  // ---------- encoding ----------

  const toS16 = (x) => (x <= -1 ? -32768 : x >= 1 ? 32767 : x < 0 ? x * 32768 : x * 32767);

  // Fills left/right (Int16) with n frames starting at `start`, folding extra channels into stereo.
  function mixBlock(chans, start, n, left, right) {
    const c = chans.length;
    const [c0, c1, c2, c3, c4, c5] = chans;
    const h = Math.SQRT1_2;
    if (c === 1) {
      for (let k = 0; k < n; k++) left[k] = toS16(c0[start + k]);
    } else if (c === 4) { // quad: L R SL SR
      for (let k = 0, i = start; k < n; k++, i++) {
        left[k] = toS16(0.5 * (c0[i] + c2[i]));
        right[k] = toS16(0.5 * (c1[i] + c3[i]));
      }
    } else if (c === 5) { // 5.0: L R C SL SR
      for (let k = 0, i = start; k < n; k++, i++) {
        left[k] = toS16(c0[i] + h * (c2[i] + c3[i]));
        right[k] = toS16(c1[i] + h * (c2[i] + c4[i]));
      }
    } else if (c === 6) { // 5.1: L R C LFE SL SR
      for (let k = 0, i = start; k < n; k++, i++) {
        left[k] = toS16(c0[i] + h * (c2[i] + c4[i]));
        right[k] = toS16(c1[i] + h * (c2[i] + c5[i]));
      }
    } else { // stereo, or the front pair of anything else
      for (let k = 0, i = start; k < n; k++, i++) {
        left[k] = toS16(c0[i]);
        right[k] = toS16(c1[i]);
      }
    }
  }

  async function encodeMp3(buffer, kbps, title, onProgress, signal) {
    const lame = root.lamejs;
    if (!lame || !lame.Mp3Encoder) throw new ConvertError('encoder-missing', "The MP3 encoder didn't load. Reload the page and try again.");
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const outChannels = chans.length === 1 ? 1 : 2;
    const encoder = new lame.Mp3Encoder(outChannels, buffer.sampleRate, kbps);
    const left = new Int16Array(ENCODE_BLOCK);
    const right = new Int16Array(ENCODE_BLOCK);
    const parts = [];
    const tag = id3Tag(title);
    if (tag) parts.push(tag);

    const total = buffer.length;
    let sliceStart = now();
    for (let i = 0; i < total; i += ENCODE_BLOCK) {
      const n = Math.min(ENCODE_BLOCK, total - i);
      mixBlock(chans, i, n, left, right);
      const l = n === ENCODE_BLOCK ? left : left.subarray(0, n);
      const out = outChannels === 1 ? encoder.encodeBuffer(l) : encoder.encodeBuffer(l, n === ENCODE_BLOCK ? right : right.subarray(0, n));
      if (out.length) parts.push(out);
      if (now() - sliceStart > SLICE_MS) {
        onProgress((i + n) / total);
        await nextTick();
        if (signal && signal.aborted) throw cancelled();
        sliceStart = now();
      }
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(tail);
    onProgress(1);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  // ---------- ID3 title ----------

  // ID3v2.3 tag with a TIT2 (title) frame in UTF-16, so music apps show the video's name.
  function id3Tag(title) {
    if (!title) return null;
    const text = String(title).slice(0, 200);
    const frameData = new Uint8Array(3 + text.length * 2);
    frameData[0] = 1; // UTF-16 with BOM
    frameData[1] = 0xff;
    frameData[2] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      frameData[3 + i * 2] = c & 0xff;
      frameData[4 + i * 2] = c >> 8;
    }
    const frameSize = 10 + frameData.length;
    const tag = new Uint8Array(10 + frameSize);
    tag.set([0x49, 0x44, 0x33, 3, 0, 0]); // "ID3" v2.3, no flags
    tag[6] = (frameSize >> 21) & 0x7f;
    tag[7] = (frameSize >> 14) & 0x7f;
    tag[8] = (frameSize >> 7) & 0x7f;
    tag[9] = frameSize & 0x7f;
    tag.set([0x54, 0x49, 0x54, 0x32], 10); // "TIT2"
    const n = frameData.length;
    tag.set([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, 0, 0], 14);
    tag.set(frameData, 20);
    return tag;
  }

  // ---------- zip (stored, no compression: MP3 doesn't shrink anyway) ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function makeZip(entries) {
    const encoder = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const data = new Uint8Array(await entry.blob.arrayBuffer());
      const name = encoder.encode(entry.name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, time, true);
      dir.setUint16(14, date, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, name.length, true);
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), name);
      offset += 30 + name.length + data.length;
    }
    let dirSize = 0;
    for (const p of central) dirSize += p.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // ---------- helpers ----------

  function baseName(name) {
    const b = String(name || '')
      .replace(/\.[^./\\]{1,5}$/, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return b || 'audio';
  }

  function formatBytes(n) {
    if (n < 1000) return `${n} B`;
    if (n < 1e6) return `${Math.round(n / 1000)} KB`;
    if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
    return `${(n / 1e9).toFixed(1)} GB`;
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  // ---------- the whole job ----------

  // Share of the progress bar each stage gets.
  const STAGES = { reading: [0, 0.15], decoding: [0.15, 0.25], encoding: [0.25, 1] };

  // opts: { kbps, signal, onProgress(fraction, stage), onDecoded({ duration, channels, sampleRate, peaks, info }) }
  async function convertFile(file, opts) {
    const report = (stage, f) => {
      const [a, b] = STAGES[stage];
      if (opts.onProgress) opts.onProgress(a + (b - a) * Math.min(1, Math.max(0, f)), stage);
    };
    const { buffer, info, via } = await decodeFile(file, report, opts.signal);
    if (opts.signal && opts.signal.aborted) throw cancelled();
    const decoded = {
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      peaks: peaks(buffer, 240),
      info,
      via,
    };
    if (opts.onDecoded) opts.onDecoded(decoded);
    report('encoding', 0);
    const name = baseName(file.name);
    const blob = await encodeMp3(buffer, opts.kbps, name, (f) => report('encoding', f), opts.signal);
    return { blob, filename: `${name}.mp3`, ...decoded };
  }

  V2M.convert = { convertFile, makeZip, id3Tag, crc32, baseName, formatBytes, formatTime, ConvertError, OUTPUT_RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = V2M.convert;
})(typeof globalThis !== 'undefined' ? globalThis : this);
