// mp4.js
// Reads the sound track out of MP4 / MOV / M4A / 3GP files (iPhone videos,
// TikTok and Instagram saves, screen recordings, voice memos).
//
// Only the index ("moov" box) and the audio bytes are read from the file, so a
// large video never has to fit in memory. The audio is then wrapped in a small
// container that every browser's decoder accepts:
//   AAC  -> audio-only .m4a, then ADTS (.aac) as a second try
//   MP3  -> the raw MP3 frames
//   PCM  -> .wav
//   ALAC, Opus, FLAC, AC-3 -> audio-only .m4a
// Anything else returns null and the caller decodes the original file instead.

(function (root) {
  'use strict';

  const V2M = root.V2M || (root.V2M = {});

  const MAX_MOOV_BYTES = 128 * 1024 * 1024;
  const READ_WINDOW = 8 * 1024 * 1024;
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  // Box types that can start an ISO media file (QuickTime files may start with wide/mdat).
  const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid', 'styp']);

  class NoAudioTrackError extends Error {
    constructor() {
      super('This file has no sound track.');
      this.name = 'NoAudioTrackError';
    }
  }

  // ---------- byte helpers ----------

  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  async function readRange(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  // Child boxes of b[start, end).
  function* boxes(b, start, end) {
    let off = start;
    while (off + 8 <= end) {
      let size = u32(b, off);
      const type = fourcc(b, off + 4);
      let header = 8;
      if (size === 1) {
        if (off + 16 > end) return;
        size = u64(b, off + 8);
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return;
      yield { type, start: off, body: off + header, end: off + size };
      off += size;
    }
  }

  function child(b, box, type) {
    if (!box) return null;
    for (const c of boxes(b, box.body, box.end)) if (c.type === type) return c;
    return null;
  }

  function descend(b, box, ...types) {
    let cur = box;
    for (const t of types) cur = child(b, cur, t);
    return cur;
  }

  // Walks the top level of the file with small reads and returns the moov box position.
  async function findMoov(file) {
    const size = file.size;
    let off = 0;
    let first = true;
    while (off + 8 <= size) {
      const h = await readRange(file, off, Math.min(off + 16, size));
      let boxSize = u32(h, 0);
      const type = fourcc(h, 4);
      if (first && !FIRST_BOXES.has(type)) return null; // not an MP4/MOV family file
      first = false;
      let header = 8;
      if (boxSize === 1) {
        if (h.length < 16) return null;
        boxSize = u64(h, 8);
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - off;
      }
      if (boxSize < header) return null;
      if (type === 'moov') return { start: off, size: boxSize };
      off += boxSize;
    }
    return null;
  }

  // ---------- codec descriptions ----------

  function readDescriptorHeader(b, p, end) {
    if (p >= end) return null;
    const tag = b[p++];
    let len = 0;
    for (let i = 0; i < 4 && p < end; i++) {
      const v = b[p++];
      len = (len << 7) | (v & 0x7f);
      if (!(v & 0x80)) break;
    }
    return { tag, len, start: p };
  }

  // esds -> { oti, asc } (objectTypeIndication and AudioSpecificConfig bytes)
  function parseEsds(b, esds) {
    const end = esds.end;
    let d = readDescriptorHeader(b, esds.body + 4, end);
    if (!d || d.tag !== 0x03) return null;
    let p = d.start + 2; // ES_ID
    const flags = b[p++];
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + b[p];
    if (flags & 0x20) p += 2;
    d = readDescriptorHeader(b, p, end);
    if (!d || d.tag !== 0x04) return null;
    const oti = b[d.start];
    const configEnd = Math.min(d.start + d.len, end);
    p = d.start + 13;
    let asc = null;
    if (p < configEnd) {
      const s = readDescriptorHeader(b, p, configEnd);
      if (s && s.tag === 0x05 && s.len > 0) asc = b.slice(s.start, Math.min(s.start + s.len, configEnd));
    }
    return { oti, asc };
  }

  function parseAudioSpecificConfig(asc) {
    let pos = 0;
    const bits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = asc[pos >> 3] || 0;
        v = v * 2 + ((byte >> (7 - (pos & 7))) & 1);
        pos++;
      }
      return v;
    };
    const objectType = () => {
      const t = bits(5);
      return t === 31 ? 32 + bits(6) : t;
    };
    const aot = objectType();
    const sfi = bits(4);
    const rate = sfi === 15 ? bits(24) : AAC_RATES[sfi] || 0;
    const channels = bits(4);
    let coreAot = aot;
    let outRate = rate;
    if (aot === 5 || aot === 29) {
      const esfi = bits(4);
      outRate = esfi === 15 ? bits(24) : AAC_RATES[esfi] || rate;
      coreAot = objectType();
    }
    return { aot, coreAot, sfi, rate, outRate, channels };
  }

  function findBoxDeep(b, start, end, type, depth) {
    for (const c of boxes(b, start, end)) {
      if (c.type === type) return c;
      if (c.type === 'wave' && depth < 3) {
        const inner = findBoxDeep(b, c.body, c.end, type, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  }

  // Parses an audio sample entry (QuickTime sound description v0/v1/v2 or ISO AudioSampleEntry).
  function parseAudioEntry(b, entry) {
    const body = entry.body;
    const version = u16(b, body + 8);
    const info = {
      type: entry.type,
      version,
      channels: u16(b, body + 16),
      bits: u16(b, body + 18),
      rate: u32(b, body + 24) / 65536,
      bytesPerFrame: 0,
      pcmFlags: 0,
      childStart: body + 28,
    };
    if (version === 1) {
      info.bytesPerFrame = u32(b, body + 36);
      info.childStart = body + 44;
    } else if (version === 2) {
      info.rate = new DataView(b.buffer, b.byteOffset + body + 32, 8).getFloat64(0);
      info.channels = u32(b, body + 40);
      info.bits = u32(b, body + 48);
      info.pcmFlags = u32(b, body + 52);
      info.bytesPerFrame = u32(b, body + 56);
      info.childStart = body + 64;
    }
    // ISO "AudioSampleEntryV1" reuses version 1 without the QuickTime extension; if the
    // children don't start where the version says, fall back to the plain layout.
    if (info.childStart !== body + 28 && !validChildren(b, info.childStart, entry.end)) {
      info.childStart = body + 28;
    }
    return info;
  }

  function validChildren(b, start, end) {
    if (start === end) return true;
    if (start + 8 > end) return false;
    const size = u32(b, start);
    return size >= 8 && start + size <= end;
  }

  // ---------- track table ----------

  function parseTrack(b, trak) {
    const mdia = child(b, trak, 'mdia');
    const hdlr = child(b, mdia, 'hdlr');
    if (!hdlr || fourcc(b, hdlr.body + 8) !== 'soun') return null;

    const tkhd = child(b, trak, 'tkhd');
    const enabled = tkhd ? (b[tkhd.body + 3] & 1) === 1 : true;

    const mdhd = child(b, mdia, 'mdhd');
    let timescale = 0;
    let duration = 0;
    if (mdhd) {
      if (b[mdhd.body] === 1) {
        timescale = u32(b, mdhd.body + 20);
        duration = u64(b, mdhd.body + 24);
      } else {
        timescale = u32(b, mdhd.body + 12);
        duration = u32(b, mdhd.body + 16);
      }
    }

    const stbl = descend(b, mdia, 'minf', 'stbl');
    const stsd = child(b, stbl, 'stsd');
    if (!stsd) return { enabled, codec: null };
    const first = boxes(b, stsd.body + 8, stsd.end).next().value;
    if (!first) return { enabled, codec: null };
    const entry = parseAudioEntry(b, first);

    return { enabled, timescale, duration, stbl, entryBox: first, entry };
  }

  // Returns the chunk list [{ offset, count }] (count = samples in the chunk) and the sample sizes.
  function sampleTable(b, stbl) {
    const stsz = child(b, stbl, 'stsz');
    const stz2 = child(b, stbl, 'stz2');
    let sampleCount = 0;
    let sizes = null;
    let constantSize = 0;
    if (stsz) {
      constantSize = u32(b, stsz.body + 4);
      sampleCount = u32(b, stsz.body + 8);
      if (constantSize === 0) {
        if (stsz.body + 12 + sampleCount * 4 > stsz.end) return null;
        sizes = new Uint32Array(sampleCount);
        for (let i = 0, p = stsz.body + 12; i < sampleCount; i++, p += 4) sizes[i] = u32(b, p);
      }
    } else if (stz2) {
      const field = b[stz2.body + 7];
      sampleCount = u32(b, stz2.body + 8);
      sizes = new Uint32Array(sampleCount);
      const p = stz2.body + 12;
      for (let i = 0; i < sampleCount; i++) {
        if (field === 4) sizes[i] = (b[p + (i >> 1)] >> ((i & 1) ? 0 : 4)) & 15;
        else if (field === 8) sizes[i] = b[p + i];
        else if (field === 16) sizes[i] = u16(b, p + i * 2);
        else return null;
      }
    } else {
      return null;
    }

    const stco = child(b, stbl, 'stco');
    const co64 = child(b, stbl, 'co64');
    let offsets;
    if (stco) {
      const n = u32(b, stco.body + 4);
      if (stco.body + 8 + n * 4 > stco.end) return null;
      offsets = new Array(n);
      for (let i = 0; i < n; i++) offsets[i] = u32(b, stco.body + 8 + i * 4);
    } else if (co64) {
      const n = u32(b, co64.body + 4);
      if (co64.body + 8 + n * 8 > co64.end) return null;
      offsets = new Array(n);
      for (let i = 0; i < n; i++) offsets[i] = u64(b, co64.body + 8 + i * 8);
    } else {
      return null;
    }

    const stsc = child(b, stbl, 'stsc');
    if (!stsc) return null;
    const entries = [];
    const nEntries = u32(b, stsc.body + 4);
    for (let i = 0; i < nEntries; i++) {
      const p = stsc.body + 8 + i * 12;
      if (p + 12 > stsc.end) break;
      entries.push({ firstChunk: u32(b, p), perChunk: u32(b, p + 4) });
    }
    if (!entries.length) return null;

    const chunks = [];
    let e = 0;
    let remaining = sampleCount;
    for (let c = 0; c < offsets.length && remaining > 0; c++) {
      while (e + 1 < entries.length && entries[e + 1].firstChunk <= c + 1) e++;
      const count = Math.min(entries[e].perChunk, remaining);
      chunks.push({ offset: offsets[c], count });
      remaining -= count;
    }

    const stts = child(b, stbl, 'stts');
    const deltas = [];
    if (stts) {
      const n = u32(b, stts.body + 4);
      for (let i = 0; i < n; i++) {
        const p = stts.body + 8 + i * 8;
        if (p + 8 > stts.end) break;
        deltas.push({ count: u32(b, p), delta: u32(b, p + 4) });
      }
    }

    return { sampleCount: sampleCount - remaining, sizes, constantSize, chunks, deltas };
  }

  // ---------- codec classification ----------

  const PCM_TYPES = new Set(['sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32', 'fl64', 'raw ']);
  const M4A_COPY_TYPES = { alac: 'ALAC', Opus: 'Opus', fLaC: 'FLAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3' };

  function classify(b, track) {
    const entry = track.entry;
    const type = entry.type;
    const kids = [entry.childStart, track.entryBox.end];

    if (type === 'mp4a') {
      const esdsBox = findBoxDeep(b, kids[0], kids[1], 'esds', 0);
      const esds = esdsBox && parseEsds(b, esdsBox);
      if (!esds) return { kind: 'unknown', label: 'AAC' };
      if (esds.oti === 0x69 || esds.oti === 0x6b) return { kind: 'mp3', label: 'MP3' };
      if (esds.oti === 0x40 && esds.asc) {
        const asc = parseAudioSpecificConfig(esds.asc);
        const label = asc.aot === 29 ? 'HE-AAC v2' : asc.aot === 5 ? 'HE-AAC' : 'AAC';
        const adts = asc.coreAot >= 1 && asc.coreAot <= 4 && asc.sfi <= 12 && asc.channels >= 1 && asc.channels <= 7
          ? { profile: asc.coreAot - 1, sfi: asc.sfi, channels: asc.channels }
          : null;
        return { kind: 'aac', label, esdsBox, adts, rate: asc.outRate, channels: asc.channels };
      }
      if (esds.oti >= 0x66 && esds.oti <= 0x68) {
        const sfi = AAC_RATES.indexOf(Math.round(entry.rate));
        const adts = sfi >= 0 && entry.channels >= 1 && entry.channels <= 7
          ? { profile: esds.oti - 0x66, sfi, channels: entry.channels }
          : null;
        return { kind: 'aac', label: 'AAC', esdsBox, adts };
      }
      return { kind: 'unknown', label: 'mp4a' };
    }
    if (type === '.mp3' || type === 'ms\u0000U') return { kind: 'mp3', label: 'MP3' };
    if (PCM_TYPES.has(type)) {
      const pcm = pcmLayout(b, track);
      return pcm ? { kind: 'pcm', label: 'PCM', pcm } : { kind: 'unknown', label: 'PCM' };
    }
    if (M4A_COPY_TYPES[type]) return { kind: 'copy', label: M4A_COPY_TYPES[type] };
    return { kind: 'unknown', label: type.trim() };
  }

  function pcmLayout(b, track) {
    const e = track.entry;
    const kids = [e.childStart, track.entryBox.end];
    const enda = findBoxDeep(b, kids[0], kids[1], 'enda', 0);
    const littleEndianFlag = enda ? u16(b, enda.body) === 1 : false;
    let bits = e.bits;
    let float = false;
    let bigEndian = true;
    let signed = true;
    switch (e.type) {
      case 'sowt': bigEndian = false; break;
      case 'twos': break;
      case 'raw ': bits = 8; signed = false; break;
      case 'in24': bits = 24; bigEndian = !littleEndianFlag; break;
      case 'in32': bits = 32; bigEndian = !littleEndianFlag; break;
      case 'fl32': bits = 32; float = true; bigEndian = !littleEndianFlag; break;
      case 'fl64': bits = 64; float = true; bigEndian = !littleEndianFlag; break;
      case 'lpcm':
        float = (e.pcmFlags & 1) !== 0;
        bigEndian = (e.pcmFlags & 2) !== 0;
        signed = float || (e.pcmFlags & 4) !== 0;
        break;
      default: return null;
    }
    if (![8, 16, 24, 32, 64].includes(bits) || (float && bits < 32) || (!float && bits === 64)) return null;
    if (!signed && bits > 8) return null;
    const channels = e.channels;
    if (channels < 1 || channels > 16) return null;
    const bytesPerFrame = channels * (bits / 8);
    if (e.bytesPerFrame && e.bytesPerFrame !== bytesPerFrame) return null; // padded or packed layouts
    const rate = Math.round(e.rate);
    if (!(rate >= 3000 && rate <= 384000)) return null;
    return { bits, float, bigEndian, signed, channels, bytesPerFrame, rate };
  }

  // ---------- reading the audio bytes ----------

  // Reads byte ranges [{ offset, length }] (in file order) into one buffer, a window at a time.
  async function readRanges(file, ranges, total, onProgress) {
    const out = new Uint8Array(total);
    let written = 0;
    let i = 0;
    while (i < ranges.length) {
      const start = ranges[i].offset;
      let j = i;
      let end = start + ranges[i].length;
      while (j + 1 < ranges.length) {
        const next = ranges[j + 1];
        const nextEnd = next.offset + next.length;
        if (next.offset < end || nextEnd - start > READ_WINDOW) break;
        end = nextEnd;
        j++;
      }
      const buf = await readRange(file, start, end);
      for (let k = i; k <= j; k++) {
        const r = ranges[k];
        const from = r.offset - start;
        if (from + r.length > buf.length) throw new Error('Audio data runs past the end of the file.');
        out.set(buf.subarray(from, from + r.length), written);
        written += r.length;
      }
      if (onProgress) onProgress(written / total);
      i = j + 1;
    }
    return out;
  }

  // ---------- containers for the decoder ----------

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function bytesOf(values) {
    // values: array of [bytes, number] pairs or Uint8Arrays / strings
    const parts = values.map((v) => {
      if (v instanceof Uint8Array) return v;
      if (typeof v === 'string') return Uint8Array.from(v, (c) => c.charCodeAt(0));
      const [n, value] = v;
      const out = new Uint8Array(n);
      let x = value;
      for (let i = n - 1; i >= 0; i--) {
        out[i] = x % 256;
        x = Math.floor(x / 256);
      }
      return out;
    });
    return concat(parts);
  }

  function box(type, ...content) {
    const body = bytesOf(content);
    return concat([bytesOf([[4, body.length + 8], type]), body]);
  }

  function fullBox(type, version, flags, ...content) {
    return box(type, [1, version], [3, flags], ...content);
  }

  const MATRIX = bytesOf([[4, 0x10000], [4, 0], [4, 0], [4, 0], [4, 0x10000], [4, 0], [4, 0], [4, 0], [4, 0x40000000]]);

  // Audio-only MP4 (.m4a) holding the given samples. `entryBytes` is the sample entry box.
  function buildM4A(entryBytes, audio) {
    const { payload, sizes, timescale, duration, deltas, sampleCount } = audio;
    const ftyp = box('ftyp', 'M4A ', [4, 0], 'M4A ', 'mp42', 'isom');
    const mdatHeader = bytesOf([[4, payload.length + 8], 'mdat']);
    const dataOffset = ftyp.length + mdatHeader.length;

    // stts limited to the samples we actually carry
    const sttsEntries = [];
    let left = sampleCount;
    for (const d of deltas) {
      if (left <= 0) break;
      const count = Math.min(d.count, left);
      sttsEntries.push([4, count], [4, d.delta]);
      left -= count;
    }
    if (left > 0) sttsEntries.push([4, left], [4, 1024]);
    const stts = fullBox('stts', 0, 0, [4, sttsEntries.length / 2], ...sttsEntries);

    const sizeTable = new Uint8Array(sampleCount * 4);
    for (let i = 0; i < sampleCount; i++) {
      const s = sizes[i];
      sizeTable[i * 4] = s >>> 24;
      sizeTable[i * 4 + 1] = (s >>> 16) & 255;
      sizeTable[i * 4 + 2] = (s >>> 8) & 255;
      sizeTable[i * 4 + 3] = s & 255;
    }

    const stbl = box('stbl',
      fullBox('stsd', 0, 0, [4, 1], entryBytes),
      stts,
      fullBox('stsc', 0, 0, [4, 1], [4, 1], [4, sampleCount], [4, 1]),
      fullBox('stsz', 0, 0, [4, 0], [4, sampleCount], sizeTable),
      fullBox('stco', 0, 0, [4, 1], [4, dataOffset]));
    const minf = box('minf',
      fullBox('smhd', 0, 0, [2, 0], [2, 0]),
      box('dinf', fullBox('dref', 0, 0, [4, 1], fullBox('url ', 0, 1))),
      stbl);
    const mdia = box('mdia',
      fullBox('mdhd', 0, 0, [4, 0], [4, 0], [4, timescale], [4, duration], [2, 0x55c4], [2, 0]),
      fullBox('hdlr', 0, 0, [4, 0], 'soun', [4, 0], [4, 0], [4, 0], 'SoundHandler', [1, 0]),
      minf);
    const trak = box('trak',
      fullBox('tkhd', 0, 7, [4, 0], [4, 0], [4, 1], [4, 0], [4, duration], [8, 0], [2, 0], [2, 0], [2, 0x100], [2, 0], MATRIX, [4, 0], [4, 0]),
      mdia);
    const moov = box('moov',
      fullBox('mvhd', 0, 0, [4, 0], [4, 0], [4, timescale], [4, duration], [4, 0x10000], [2, 0x100], [10, 0], MATRIX, [24, 0], [4, 2]),
      trak);

    const out = new Uint8Array(dataOffset + payload.length + moov.length);
    out.set(ftyp, 0);
    out.set(mdatHeader, ftyp.length);
    out.set(payload, dataOffset);
    out.set(moov, dataOffset + payload.length);
    return out;
  }

  // Plain ISO 'mp4a' entry around an existing esds box (for QuickTime v1/v2 sound descriptions).
  function isoMp4aEntry(b, entry, esdsBox, rate, channels) {
    const sampleRate = rate > 0 && rate < 65536 ? Math.round(rate) * 65536 : 0;
    return box('mp4a', [6, 0], [2, 1], [8, 0], [2, channels || 2], [2, 16], [2, 0], [2, 0], [4, sampleRate],
      b.slice(esdsBox.start, esdsBox.end));
  }

  function buildADTS(adts, audio) {
    const { payload, sizes, sampleCount } = audio;
    const out = new Uint8Array(payload.length + sampleCount * 7);
    let src = 0;
    let dst = 0;
    for (let i = 0; i < sampleCount; i++) {
      const size = sizes[i];
      const len = size + 7;
      if (len > 8191) throw new Error('AAC frame too large for ADTS.');
      out[dst] = 0xff;
      out[dst + 1] = 0xf1;
      out[dst + 2] = (adts.profile << 6) | (adts.sfi << 2) | ((adts.channels >> 2) & 1);
      out[dst + 3] = ((adts.channels & 3) << 6) | ((len >> 11) & 3);
      out[dst + 4] = (len >> 3) & 0xff;
      out[dst + 5] = ((len & 7) << 5) | 0x1f;
      out[dst + 6] = 0xfc;
      out.set(payload.subarray(src, src + size), dst + 7);
      src += size;
      dst += len;
    }
    return out;
  }

  function buildWAV(pcm, data) {
    const outBits = pcm.float ? 32 : pcm.bits;
    const inBytes = pcm.bits / 8;
    const outBytes = outBits / 8;
    const count = Math.floor(data.length / inBytes);
    const header = 44;
    const out = new Uint8Array(header + count * outBytes);
    const dv = new DataView(out.buffer);
    const put = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
    put(0, 'RIFF');
    dv.setUint32(4, out.length - 8, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, pcm.float ? 3 : 1, true);
    dv.setUint16(22, pcm.channels, true);
    dv.setUint32(24, pcm.rate, true);
    dv.setUint32(28, pcm.rate * pcm.channels * outBytes, true);
    dv.setUint16(32, pcm.channels * outBytes, true);
    dv.setUint16(34, outBits, true);
    put(36, 'data');
    dv.setUint32(40, count * outBytes, true);

    if (pcm.float && pcm.bits === 64) {
      const src = new DataView(data.buffer, data.byteOffset, data.length);
      for (let i = 0; i < count; i++) dv.setFloat32(header + i * 4, src.getFloat64(i * 8, !pcm.bigEndian), true);
      return out;
    }
    if (pcm.bits === 8) {
      // WAV 8-bit is unsigned
      for (let i = 0; i < count; i++) out[header + i] = pcm.signed ? data[i] ^ 0x80 : data[i];
      return out;
    }
    if (!pcm.bigEndian) {
      out.set(data.subarray(0, count * inBytes), header);
      return out;
    }
    for (let i = 0; i < count; i++) {
      const s = i * inBytes;
      const d = header + i * inBytes;
      for (let k = 0; k < inBytes; k++) out[d + k] = data[s + inBytes - 1 - k];
    }
    return out;
  }

  // ---------- public entry point ----------

  // Resolves to null when the file isn't an MP4/MOV-family file or its layout isn't handled
  // here (e.g. fragmented MP4), and rejects with NoAudioTrackError when it has no sound track.
  // Otherwise resolves to { info, variants }, where each variant is a function that returns a
  // fresh ArrayBuffer the browser's audio decoder can read.
  async function extractAudio(file, onProgress) {
    const moovPos = await findMoov(file);
    if (!moovPos) return null;
    if (moovPos.size > MAX_MOOV_BYTES) return null;
    const b = await readRange(file, moovPos.start, moovPos.start + moovPos.size);
    const moov = { type: 'moov', start: 0, body: u32(b, 0) === 1 ? 16 : 8, end: b.length };

    const tracks = [];
    for (const c of boxes(b, moov.body, moov.end)) {
      if (c.type !== 'trak') continue;
      const t = parseTrack(b, c);
      if (t) tracks.push(t);
    }
    if (!tracks.length) throw new NoAudioTrackError();

    // Prefer enabled tracks, then AAC (iPhones can add a second spatial-audio track).
    const rank = (t) => (t.enabled ? 2 : 0) + (t.entry && t.entry.type === 'mp4a' ? 1 : 0);
    tracks.sort((x, y) => rank(y) - rank(x));
    const track = tracks.find((t) => t.entry);
    if (!track) return null;

    const codec = classify(b, track);
    if (codec.kind === 'unknown') return null;

    const table = sampleTable(b, track.stbl);
    if (!table || table.sampleCount === 0) return null; // fragmented MP4: let the browser try

    const timescale = track.timescale || Math.round(track.entry.rate) || 44100;
    let duration = track.duration;
    if (!duration || duration === 0xffffffff) {
      duration = 0;
      for (const d of table.deltas) duration += d.count * d.delta;
    }
    const info = {
      codec: codec.label,
      sampleRate: Math.round(codec.rate || (codec.pcm && codec.pcm.rate) || track.entry.rate) || 0,
      channels: codec.channels || (codec.pcm && codec.pcm.channels) || track.entry.channels || 0,
      duration: timescale ? duration / timescale : 0,
    };

    // Byte ranges to read, one per chunk. A cut-off file keeps the chunks that are complete.
    const ranges = [];
    let total = 0;
    let sampleCount = 0;
    const sizes = new Uint32Array(table.sampleCount);
    for (const chunk of table.chunks) {
      let length = 0;
      if (codec.kind === 'pcm') {
        length = chunk.count * codec.pcm.bytesPerFrame;
      } else {
        for (let k = 0; k < chunk.count; k++) {
          const s = table.sizes ? table.sizes[sampleCount + k] : table.constantSize;
          sizes[sampleCount + k] = s;
          length += s;
        }
      }
      if (chunk.offset + length > file.size) break;
      if (length > 0) ranges.push({ offset: chunk.offset, length });
      total += length;
      sampleCount += chunk.count;
    }
    if (total === 0) throw new NoAudioTrackError();

    const payload = await readRanges(file, ranges, total, onProgress);
    const audio = {
      payload,
      sizes,
      sampleCount,
      timescale,
      duration,
      deltas: table.deltas,
    };

    const variants = [];
    if (codec.kind === 'aac') {
      const entryBytes = track.entry.version === 0
        ? b.slice(track.entryBox.start, track.entryBox.end)
        : isoMp4aEntry(b, track.entry, codec.esdsBox, codec.rate || track.entry.rate, codec.channels || track.entry.channels);
      variants.push({ name: 'm4a', build: () => buildM4A(entryBytes, audio).buffer });
      if (codec.adts) variants.push({ name: 'adts', build: () => buildADTS(codec.adts, audio).buffer });
    } else if (codec.kind === 'copy') {
      if (track.entry.version === 0) {
        const entryBytes = b.slice(track.entryBox.start, track.entryBox.end);
        variants.push({ name: 'm4a', build: () => buildM4A(entryBytes, audio).buffer });
      }
    } else if (codec.kind === 'mp3') {
      variants.push({ name: 'mp3', build: () => payload.slice().buffer });
    } else if (codec.kind === 'pcm') {
      variants.push({ name: 'wav', build: () => buildWAV(codec.pcm, payload).buffer });
    }
    if (!variants.length) return null;
    return { info, variants };
  }

  V2M.mp4 = { extractAudio, NoAudioTrackError, parseAudioSpecificConfig };
  if (typeof module !== 'undefined' && module.exports) module.exports = V2M.mp4;
})(typeof globalThis !== 'undefined' ? globalThis : this);
