# sfx.py: meme sound effects made from scratch with numpy (no downloads, nothing copyrighted, free to use).
# Every sound is synthesised in a few milliseconds and kept as a 44.1 kHz stereo float array, so the worker
# can place them sample-exactly on a track as long as the video (sfx_track) and mix that over the music.

import re
import struct
import subprocess
import threading
import wave
import zlib
from pathlib import Path

import numpy as np

SR = 44100
_rng = np.random.default_rng(7)  # reseeded per sound in sound(): the same sounds every time, in any order
_lock = threading.Lock()  # two videos can be cut at once (the quick lane and the AI lane)


def _t(seconds):
    return np.arange(int(seconds * SR)) / SR


def _phase(freq):
    """Phase from an instantaneous frequency curve (Hz per sample)."""
    return 2 * np.pi * np.cumsum(freq) / SR


def _fade(x, fin=0.002, fout=0.02):
    n_in, n_out = max(1, int(fin * SR)), max(1, int(fout * SR))
    x = x.copy()
    x[:n_in] *= np.linspace(0, 1, n_in)
    x[-n_out:] *= np.linspace(1, 0, n_out) ** 2
    return x


def _fft_filter(x, gain_of_freq):
    """Static filter in the frequency domain: gain_of_freq(f) -> gain (zero-phase, no loops)."""
    n = len(x)
    size = 1 << int(np.ceil(np.log2(n + SR // 2)))
    spec = np.fft.rfft(x, size)
    spec *= gain_of_freq(np.fft.rfftfreq(size, 1 / SR))
    return np.fft.irfft(spec, size)[:n]


def _bandpass(lo, hi, slope=2.0):
    return lambda f: 1 / np.sqrt(1 + (lo / np.maximum(f, 1)) ** (2 * slope)) / np.sqrt(1 + (f / hi) ** (2 * slope))


def _lowpass(hi, slope=2.0):
    return lambda f: 1 / np.sqrt(1 + (f / hi) ** (2 * slope))


def _highpass(lo, slope=2.0):
    return lambda f: 1 / np.sqrt(1 + (lo / np.maximum(f, 1)) ** (2 * slope))


def _sweep_filter(x, centre, width_oct=0.7, n_fft=1024, hop=256):
    """Time-varying band-pass (Gaussian on a log-frequency axis) by short-time Fourier transform.
    centre: centre frequency (Hz) for every sample of x."""
    win = np.hanning(n_fft)
    pad = np.concatenate([np.zeros(n_fft), x, np.zeros(n_fft)])
    starts = np.arange(0, len(pad) - n_fft, hop)
    frames = pad[starts[:, None] + np.arange(n_fft)] * win
    spec = np.fft.rfft(frames, axis=1)
    freqs = np.maximum(np.fft.rfftfreq(n_fft, 1 / SR), 1)
    mid = np.clip(starts + n_fft // 2 - n_fft, 0, len(x) - 1)
    fc = centre[mid][:, None]
    spec *= np.exp(-0.5 * (np.log2(freqs[None, :] / fc) / width_oct) ** 2)
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    for k, s in enumerate(starts):  # overlap-add (a few hundred frames)
        out[s:s + n_fft] += np.fft.irfft(spec[k], n_fft) * win
        norm[s:s + n_fft] += win ** 2
    return (out / np.maximum(norm, 1e-3))[n_fft:n_fft + len(x)]


def _reverb(x, seconds=0.9, wet=0.25, tone=3000):
    """A small room: convolution with exponentially decaying, low-passed noise."""
    ir = _rng.standard_normal(int(seconds * SR)) * np.exp(-_t(seconds) / (seconds / 6.9))
    ir = _fft_filter(ir, _lowpass(tone))
    ir /= np.sqrt((ir ** 2).sum())
    size = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    tail = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:len(x) + len(ir)]
    dry = np.concatenate([x, np.zeros(len(ir))])
    return dry + wet * tail * (np.abs(x).max() / max(1e-9, np.abs(tail).max()))


def _finish(mono, peak_db=-1.0, pan=None):
    """Remove DC, normalise the peak, make stereo. pan: None (centre) or an array -1..1 per sample."""
    mono = mono - mono.mean()
    mono = _fade(mono, 0.001, 0.03)
    mono *= 10 ** (peak_db / 20) / max(1e-9, np.abs(mono).max())
    if pan is None:
        return np.stack([mono, mono], axis=1).astype(np.float32)
    angle = (np.clip(pan, -1, 1) + 1) * np.pi / 4  # equal-power pan
    return np.stack([mono * np.cos(angle), mono * np.sin(angle)], axis=1).astype(np.float32)


# ---------- the sounds ----------

def vine_boom():
    """Deep boom: a kick-like sine whose pitch drops from ~160 Hz to ~48 Hz, driven into soft clipping so its
    harmonics (100-400 Hz) carry on phone speakers, a short knock on top, and a dark room tail."""
    t = _t(1.3)
    freq = 46 + 115 * np.exp(-t / 0.05) + 6 * np.exp(-t / 0.4)
    body = np.tanh(2.8 * np.sin(_phase(freq))) / np.tanh(2.8)  # soft clip: odd harmonics for small speakers
    env = np.minimum(1, t / 0.004) * (0.7 * np.exp(-t / 0.22) + 0.3 * np.exp(-t / 0.55))
    knock = _fft_filter(_rng.standard_normal(len(t)), _bandpass(120, 1800)) * np.exp(-t / 0.012)
    knock *= 0.6 / max(1e-9, np.abs(knock).max())
    x = 0.9 * body * env + knock * 0.5
    x = _fft_filter(x, lambda f: _highpass(32)(f) * _lowpass(2400, 1.5)(f))
    x = _fade(x, 0.001, 0.2)
    x = _reverb(x, seconds=0.9, wet=0.2, tone=900)[:int(1.5 * SR)]
    return _finish(x, -1.0)


def boing():
    """Cartoon spring 'boiiing': a twangy FM tone that wobbles at ~12 Hz, the wobble and brightness dying away."""
    t = _t(0.85)
    wobble = 0.2 * np.exp(-t / 0.3) * np.sin(2 * np.pi * 12.5 * t)
    f0 = 235 * (1 - 0.18 * np.exp(-t / 0.03)) * (1 + wobble)
    index = 2.4 * np.exp(-t / 0.22) + 0.7  # FM depth: twangy at first, rounder at the end
    carrier = _phase(f0)
    x = np.sin(carrier + index * np.sin(carrier))
    x += 0.35 * np.sin(2 * carrier + 0.5 * index * np.sin(carrier))
    env = np.minimum(1, t / 0.003) * np.exp(-t / 0.26)
    x *= env
    x = _fft_filter(x, _highpass(120))
    return _finish(x, -1.5)


def whoosh(seconds=0.6, rising=True):
    """Air rushing past: noise through a band-pass that sweeps up and back down, swelling in and out and
    passing from left to right."""
    t = _t(seconds)
    u = t / seconds
    peak = 0.45
    shape = np.where(u < peak, np.sin(np.pi / 2 * u / peak) ** 2, np.cos(np.pi / 2 * (u - peak) / (1 - peak)) ** 1.5)
    lo, hi = (350, 2600) if rising else (2600, 350)
    centre = lo * (hi / lo) ** shape if rising else 350 + 2250 * shape
    noise = _rng.standard_normal(len(t))
    x = _sweep_filter(noise, centre, width_oct=0.75) + 0.35 * _sweep_filter(noise, centre * 2.2, width_oct=0.5)
    x *= shape ** 1.2
    return _finish(x, -2.0, pan=np.linspace(-0.7, 0.7, len(t)))


def record_scratch():
    """Vinyl scratch: a busy music-like loop played back by a hand pushing the record forward, back and
    forward again; the playback speed sets the pitch and the loudness, so it 'wicks' through zero."""
    src_len = 2.0
    ts = _t(src_len)
    chord = sum(np.sin(_phase(np.full(len(ts), f))) * a for f, a in ((196, 1), (247, 0.7), (294, 0.6), (392, 0.4)))
    saw = sum(np.sin(_phase(np.full(len(ts), 98 * k))) / k for k in range(1, 30))
    hats = _fft_filter(_rng.standard_normal(len(ts)), _highpass(5000)) * (np.sin(2 * np.pi * 8 * ts) > 0.6)
    src = 0.5 * chord + 0.35 * saw + 0.25 * hats
    src = _fft_filter(src, _bandpass(150, 7000))
    # The hand: velocity in 'times normal speed' over time: forward, back, short forward.
    strokes = [(0.11, 3.2), (0.14, -2.6), (0.09, 2.4)]
    vel = np.concatenate([amp * np.sin(np.pi * _t(d) / d) ** 1.5 for d, amp in strokes])
    vel = np.concatenate([vel, np.zeros(int(0.03 * SR))])
    pos = 0.6 * SR + np.cumsum(vel)  # start 0.6 s into the loop
    x = np.interp(pos, np.arange(len(src)), src)
    speed = np.abs(vel)
    x *= np.minimum(1, speed / 1.2) ** 1.2  # a magnetic pickup is louder the faster the groove moves
    hiss = _fft_filter(_rng.standard_normal(len(x)), _bandpass(1500, 9000)) * 0.12 * np.minimum(1, speed / 2)
    x = _fft_filter(x + hiss, _bandpass(180, 6500))
    return _finish(x, -1.5)


def slide_whistle(seconds=0.8, down=True):
    """Cartoon slide whistle: an almost pure tone gliding (down for a fall, up for a jump), a little vibrato
    and breath noise around it."""
    t = _t(seconds)
    u = t / seconds
    ease = u * u * (3 - 2 * u)  # smoothstep: slow, fast, slow
    f_hi, f_lo = 1900.0, 380.0
    logf = np.log(f_hi) + (np.log(f_lo) - np.log(f_hi)) * ease if down else np.log(f_lo) + (np.log(f_hi) - np.log(f_lo)) * ease
    freq = np.exp(logf) * (1 + 0.012 * np.sin(2 * np.pi * 6 * t))
    ph = _phase(freq)
    tone = np.sin(ph) + 0.08 * np.sin(2 * ph) + 0.03 * np.sin(3 * ph)
    breath = _sweep_filter(_rng.standard_normal(len(t)), freq, width_oct=0.15) * 0.25
    breath += _fft_filter(_rng.standard_normal(len(t)), _bandpass(2000, 8000)) * 0.02
    env = np.minimum(1, t / 0.035) * np.minimum(1, (seconds - t) / 0.08)
    return _finish((tone + breath) * env, -3.0)


def ding():
    """A small struck bell: a few inharmonic partials, the high ones dying first, with a light strike click."""
    t = _t(1.6)
    f0 = 1568.0  # G6
    partials = [(1.0, 1.0, 1.1), (2.01, 0.38, 0.55), (2.76, 0.42, 0.38), (4.07, 0.16, 0.22), (5.40, 0.10, 0.12)]
    x = np.zeros(len(t))
    for ratio, amp, decay in partials:
        f = f0 * ratio
        x += amp * np.exp(-t / decay) * (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * (f + 1.7) * t))
    click = _fft_filter(_rng.standard_normal(len(t)), _highpass(3000)) * np.exp(-t / 0.0015) * 0.4
    x = x * np.minimum(1, t / 0.0008) + click
    return _finish(x, -3.0)


SOUNDS = {
    'boom': vine_boom,
    'boing': boing,
    'whoosh': whoosh,
    'scratch': record_scratch,
    'slide_down': lambda: slide_whistle(0.8, down=True),
    'slide_up': lambda: slide_whistle(0.6, down=False),
    'ding': ding,
}
# How loud each one sits over music at -18 LUFS (measured: boom peaks ~6 LU above the music, boing/scratch
# ~3 LU, the piercing whistle/ding ~1 LU, whoosh level with it). sfx_track scales them all with the music.
GAIN = {'boom': 0.59, 'boing': 0.47, 'scratch': 0.55, 'slide_down': 0.19, 'slide_up': 0.21, 'whoosh': 0.64,
        'ding': 0.44}
NOMINAL_LUFS = -18.0
_cache = {}


def sound(name):
    """One effect as a 44.1 kHz stereo float array, made once and kept."""
    global _rng
    with _lock:
        if name not in _cache:
            _rng = np.random.default_rng(zlib.crc32(name.encode()))
            _cache[name] = SOUNDS[name]()
        return _cache[name]


def write_wav(path, stereo, float32=False):
    """16-bit WAV, or 32-bit float (no clipping however loud the sum is: the mix's limiter handles it)."""
    if not float32:
        data = (np.clip(stereo, -1, 1) * 32767).astype('<i2').tobytes()
        with wave.open(str(path), 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(data)
        return
    data = np.asarray(stereo, '<f4').tobytes()
    head = (b'RIFF' + struct.pack('<I', 4 + 26 + 12 + 8 + len(data)) + b'WAVE'
            + b'fmt ' + struct.pack('<IHHIIHHH', 18, 3, 2, SR, SR * 8, 8, 32, 0)
            + b'fact' + struct.pack('<II', 4, len(stereo))
            + b'data' + struct.pack('<I', len(data)))
    Path(path).write_bytes(head + data)


def loudness(path, start=0.0, seconds=None):
    """Integrated loudness (LUFS) of a stretch of a song, or None (ffmpeg's EBU R128 meter, ~0.3 s)."""
    cmd = ['ffmpeg', '-hide_banner', '-nostats', '-ss', f'{start:.3f}']
    if seconds:
        cmd += ['-t', f'{seconds:.3f}']
    cmd += ['-i', str(path), '-af', 'ebur128', '-f', 'null', '-']
    try:
        err = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stderr
        found = re.findall(r'I:\s+(-?[\d.]+) LUFS', err)
        return float(found[-1]) if found and float(found[-1]) > -60 else None
    except (subprocess.SubprocessError, OSError, ValueError):
        return None


def sfx_track(events, seconds, path, music_lufs=None):
    """One WAV as long as the video with every effect at its exact sample. events: [(time_s, name), ...]
    (an effect that starts before 0 is cut, e.g. a slide whistle that must END on the fall). The effects
    follow the music's loudness (louder song, louder effects), between -10 and +6 dB. Returns the gain used."""
    scale = 1.0 if music_lufs is None else float(np.clip(10 ** ((music_lufs - NOMINAL_LUFS) / 20), 0.32, 2.0))
    track = np.zeros((int(np.ceil(seconds * SR)), 2), np.float32)
    for at, name in events:
        snd = sound(name) * (GAIN.get(name, 0.5) * scale)
        start = int(round(at * SR))
        a, b = max(0, start), min(len(track), start + len(snd))
        if b > a:
            track[a:b] += snd[a - start:b - start]
    write_wav(path, track, float32=True)
    return scale


if __name__ == '__main__':
    import sys
    import time
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'sfx')
    out.mkdir(parents=True, exist_ok=True)
    for name in SOUNDS:
        t = time.perf_counter()
        snd = sound(name)
        ms = (time.perf_counter() - t) * 1000
        write_wav(out / f'{name}.wav', snd)
        print(f'{name:11s} {len(snd) / SR:.2f}s peak={20 * np.log10(np.abs(snd).max()):.1f}dBFS made in {ms:.0f} ms')
