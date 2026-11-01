# beats.py: picks where a song should start under a video, and nudges clip cuts onto the beat.
# Plain numpy (no extra audio libraries): onset strength from spectral flux, tempo from its
# autocorrelation, and a steady beat grid, which suits the steady tempo of meme songs.

import subprocess

import numpy as np

SR = 11025
HOP = 256
N_FFT = 1024
FPS = SR / HOP  # analysis frames per second


def load_mono(path, max_seconds=300):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-t', str(max_seconds), '-ac', '1',
                          '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def analyse(path):
    """Beat times (seconds), loudness per frame and duration. None if the audio is too short or silent."""
    y = load_mono(path)
    frames = 1 + (len(y) - N_FFT) // HOP
    if frames < FPS * 2:
        return None
    window = np.hanning(N_FFT).astype(np.float32)
    prev, flux, rms = None, np.zeros(frames), np.zeros(frames)
    for start in range(0, frames, 2048):  # in blocks, to keep memory small
        stop = min(frames, start + 2048)
        block = y[HOP * np.arange(start, stop)[:, None] + np.arange(N_FFT)[None, :]]
        rms[start:stop] = np.sqrt((block ** 2).mean(axis=1))
        spec = np.log1p(10 * np.abs(np.fft.rfft(block * window, axis=1)))
        rising = np.maximum(0, np.diff(spec if prev is None else np.vstack([prev, spec]), axis=0)).sum(axis=1)
        flux[stop - len(rising):stop] = rising
        prev = spec[-1:]
    if rms.max() < 1e-4:
        return None
    onset = flux - flux.mean()

    # Tempo: the beat period (60-180 BPM) whose lag correlates best, nudged towards ~120 BPM.
    lags = np.arange(int(FPS * 60 / 180), int(FPS * 60 / 60) + 1)
    corr = np.array([np.dot(onset[:-lag], onset[lag:]) / (len(onset) - lag) for lag in lags])
    bpm = 60 * FPS / lags
    corr = corr * np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)
    lag = int(lags[np.argmax(corr)])

    # Phase: where on that grid the onsets are strongest.
    phase = max(range(lag), key=lambda p: flux[p::lag].mean())
    beats = (phase + lag * np.arange((frames - phase) // lag)) / FPS
    return {'beats': beats, 'rms': rms, 'duration': len(y) / SR, 'bpm': 60 * FPS / lag}


def pick_start(info, length, part='start'):
    """Where to start the song under a video of `length` seconds, always on a beat.
    part='start': the famous opening, skipping only a quiet intro.
    part='drop': the liveliest stretch of the song (its chorus or drop)."""
    if not info or info['duration'] < length + 1:
        return 0.0
    window = int(length * FPS)
    total = np.concatenate([[0.0], np.cumsum(info['rms'])])
    starts = [b for b in info['beats'] if int(b * FPS) + window < len(total) - 1]
    if not starts:
        return 0.0
    energy = np.array([(total[int(b * FPS) + window] - total[int(b * FPS)]) / window for b in starts])
    # A quiet intro is quiet next to the song's usual loudness; the drop is close to its loudest.
    enough = 0.92 * energy.max() if part == 'drop' else 0.8 * np.median(energy)
    return float(next(b for b, e in zip(starts, energy) if e >= enough))


def snap_cuts(info, start, durations, max_trim=0.6):
    """Shortens clips (by at most max_trim seconds) so each cut lands on a beat of the song."""
    if not info:
        return list(durations)
    beats = np.asarray(info['beats']) - start
    out, t = [], 0.0
    for i, d in enumerate(durations):
        end = t + d
        if i < len(durations) - 1:
            near = beats[(beats <= end) & (beats >= end - max_trim) & (beats > t + 1.0)]
            if len(near):
                end = float(near.max())
        out.append(end - t)
        t = end
    return out
