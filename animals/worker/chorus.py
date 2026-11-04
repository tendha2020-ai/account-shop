# chorus.py: finds a song's meme part, the bit everyone knows (almost always its chorus), so every video with that
# song can start right there. Free and quick on the worker's own CPU (about 10 s a song), no AI service.
#
# The song is cut into beats (beats.py) and each beat gets what it sounds like: its chords (chroma), its sound
# (timbre), and, when the worker has the Whisper speech model, the words being sung: Whisper's listening half (its
# encoder, no writing down) hears the same words alike even under music. That tells a chorus, sung with the same
# words every time, from a verse, sung to the same tune with new words. The ~15 s that come back most often and
# most clearly, among the song's liveliest parts, are the chorus; where its returns start agreeing (a section
# boundary, on a beat) is where the meme part starts, the first time it comes.
# Without Whisper it works on chords and sound alone (good on most songs, a little less sure).

import math
import subprocess

import numpy as np

import beats

WANT = 15.0  # seconds a meme part runs (the videos are 5-15 s)
NF, HOP = 4096, 512  # the second look at the song: finer pitch for the chords (at beats.SR)
EMBED = 4  # each beat is compared together with the 3 beats after it (one bar)
WORDS_SR, WORDS_WINDOW, WORDS_FPS = 16000, 30, 50  # Whisper hears 30 s at a time, 50 states a second
WORDS_MIN_WINDOWS = 3  # Whisper's states carry where they are in their 30 s; that is taken out over 3+ windows


def _spectral_features(y, sr):
    """Per analysis frame: chroma (12), log band energies (24), and the power in total, A-weighted (how loud it
    sounds) and in the 1-4 kHz presence band (voices and choruses push it). Returns them with the frame times."""
    frames = 1 + (len(y) - NF) // HOP
    window = np.hanning(NF).astype(np.float32)
    f = np.fft.rfftfreq(NF, 1 / sr)
    tonal = (f >= 60) & (f <= 4000)
    to_chroma = np.zeros((len(f), 12), np.float32)
    to_chroma[np.where(tonal)[0], np.round(69 + 12 * np.log2(f[tonal] / 440.0)).astype(int) % 12] = 1
    edges = np.geomspace(80, 5000, 25)
    to_bands = np.zeros((len(f), 24), np.float32)
    for k in range(24):
        sel = (f >= edges[k]) & (f < edges[k + 1])
        to_bands[sel, k] = 1 / max(1, sel.sum())
    f2 = f ** 2
    a = (12194 ** 2 * f2 ** 2) / ((f2 + 20.6 ** 2) * np.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
    weights = np.stack([np.ones_like(f), (a / a.max()) ** 2, ((f >= 1000) & (f <= 4000)).astype(float)], 1).astype(np.float32)
    chroma = np.zeros((frames, 12), np.float32)
    bands = np.zeros((frames, 24), np.float32)
    power = np.zeros((frames, 3), np.float32)
    for start in range(0, frames, 1024):  # in blocks, to keep memory small
        stop = min(frames, start + 1024)
        block = y[HOP * np.arange(start, stop)[:, None] + np.arange(NF)[None, :]] * window
        p = np.abs(np.fft.rfft(block, axis=1)) ** 2
        chroma[start:stop] = p @ to_chroma
        bands[start:stop] = np.log(1e-9 + p @ to_bands)
        power[start:stop] = p @ weights
    times = (np.arange(frames) * HOP + NF / 2) / sr
    return times, chroma, bands, power


def _per_beat(values, idx):
    """The mean of each beat's frames (idx: the first frame of each beat, and the end)."""
    out = np.empty((len(idx) - 1,) + values.shape[1:], np.float32)
    for k, (a, b) in enumerate(zip(idx[:-1], idx[1:])):
        out[k] = values[a:b].mean(0) if b > a else values[min(a, len(values) - 1)]
    return out


def _unit(x):
    x = x - x.mean(1, keepdims=True)
    return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)


def _similarity(x):
    """How alike every two beats are (cosine), each beat taken with the next EMBED-1 beats."""
    n = len(x) - EMBED + 1
    e = np.hstack([x[k:k + n] for k in range(EMBED)]) / math.sqrt(EMBED)
    return e @ e.T


def word_states(model, path, seconds=300):
    """What Whisper hears at each moment (its encoder states, WORDS_FPS a second), with the trace of where each
    moment sat in its 30 s window taken out. None when the song is too short for that (under 3 windows)."""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-t', str(seconds), '-ac', '1', '-ar',
                          str(WORDS_SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    size = WORDS_SR * WORDS_WINDOW
    windows = math.ceil(len(audio) / size)
    if len(audio) < size * (WORDS_MIN_WINDOWS - 0.5):
        return None
    mel = model.feature_extractor(np.pad(audio, (0, windows * size - len(audio))))
    per = WORDS_WINDOW * 100  # mel frames in a window
    real = len(audio) // 320  # states that are the song (not the silence after it)
    states = []
    if mel.shape[1] < windows * per:
        mel = np.pad(mel, ((0, 0), (0, windows * per - mel.shape[1])), mode='edge')
    for w in range(windows):
        states.append(np.array(model.encode(np.ascontiguousarray(mel[:, w * per:(w + 1) * per])))[0])
    states = np.vstack(states)[:real].astype(np.float32)
    pos = np.arange(len(states)) % (per // 2)
    bias = np.zeros((per // 2, states.shape[1]), np.float32)
    np.add.at(bias, pos, states)
    bias /= np.maximum(1, np.bincount(pos, minlength=per // 2))[:, None]
    return states - bias[pos]


def _gauss(m, sigma, axis):
    r = int(3 * sigma) + 1
    g = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    g /= g.sum()
    return np.apply_along_axis(lambda v: np.convolve(v, g, 'same'), axis, m)


def _boundaries(s, top=24):
    """Where one section of the song ends and the next begins (beat numbers, sorted), with a 0-1 strength for every
    beat: the beats each beat sounds like, as a pattern of lags, changes there (Serra et al.'s structure features)."""
    n = len(s)
    k = max(3, int(0.04 * n))
    near = np.argsort(-s, axis=1)[:, 1:k + 1]
    rec = np.zeros((n, n), bool)
    rec[np.repeat(np.arange(n), k), near.ravel()] = True
    rec &= rec.T  # each one among the other's closest
    lag = np.array([np.roll(rec[i], -i) for i in range(n)], np.float32)
    lag = _gauss(_gauss(lag, 2.0, 0), 0.6, 1)
    strength = np.r_[0, np.sum(np.diff(lag, axis=0) ** 2, axis=1)]
    strength /= strength.max() + 1e-9
    peaks = [i for i in range(1, n - 1) if strength[i] >= strength[i - 1] and strength[i] > strength[i + 1]
             and strength[i] > 0.03]
    found = []
    for i in sorted(peaks, key=lambda i: -strength[i]):
        if all(abs(i - q) >= 4 for q in found):
            found.append(i)
    return sorted(found[:top]), strength


def _segment_similarity(s, length):
    """p[i, j]: how alike the `length` beats from beat i are to the `length` beats from beat j (NaN past the end)."""
    n = len(s)
    p = np.full((n, n), np.nan, np.float32)
    for off in range(-(n - length), n - length + 1):
        c = np.concatenate([[0], np.cumsum(np.diagonal(s, off))])
        mean = (c[length:] - c[:-length]) / length
        r = np.arange(len(mean))
        if off >= 0:
            p[r, r + off] = mean
        else:
            p[r - off, r] = mean
    return p


def _clean(cands):
    """Candidates a few seconds apart at least, rounded, the best first."""
    out = []
    for c in cands:
        if c['start'] is not None and all(abs(c['start'] - o['start']) >= 4 for o in out):
            out.append({'start': round(float(c['start']), 2), 'why': c['why']})
    return out[:4]


def find(path, model=None, lock=None):
    """The meme part of the song at `path`: {'start': seconds (on a beat), 'seconds': about how long it runs,
    'candidates': [{'start', 'why'}] (the pick first, then other good places), 'bpm', 'duration', 'how'}.
    model: a faster-whisper WhisperModel to hear the words with (optional; lock: held while it listens).
    Never raises for a song that ffmpeg can read: a short or silent one starts at 0."""
    info = beats.analyse(path)
    if not info:
        return {'start': 0.0, 'seconds': WANT, 'candidates': [{'start': 0.0, 'why': 'start of the song'}],
                'bpm': None, 'duration': None, 'how': 'too short or too quiet to look into'}
    dur, grid = info['duration'], np.asarray(info['beats'])
    result = {'bpm': round(info['bpm'], 1), 'duration': round(dur, 2)}
    loudest = {'start': beats.pick_start(info, min(WANT, dur * 0.6), 'drop'), 'why': 'loudest part'}
    opening = {'start': beats.pick_start(info, min(WANT, dur * 0.6), 'start'), 'why': 'start of the song'}
    period = float(np.median(np.diff(grid))) if len(grid) > 1 else 0.5
    length = max(8, int(round(WANT / period)))  # the meme part, in beats
    if dur < 2 * WANT or len(grid) < 2 * length + EMBED:  # a short song: it is all the meme part
        return dict(result, start=round(opening['start'], 2), seconds=round(min(WANT, dur), 2),
                    candidates=_clean([opening, loudest]), how='short song')
    try:
        return dict(result, **_structure(path, info, grid, dur, length, model, lock, loudest, opening))
    except Exception as e:  # the finder must never cost a song: the liveliest part then
        return dict(result, start=round(loudest['start'], 2), seconds=WANT, candidates=_clean([loudest, opening]),
                    how=f'loudest part ({type(e).__name__})')


def _structure(path, info, grid, dur, length, model, lock, loudest, opening):
    y = beats.load_mono(path)
    times, chroma, bands, power = _spectral_features(y, beats.SR)
    idx = np.searchsorted(times, grid)
    chroma, bands, power = _per_beat(chroma, idx), _per_beat(bands, idx), _per_beat(power, idx)
    level = 10 * np.log10(power + 1e-12)  # total, A-weighted, presence (dB)

    chords = np.log1p(10 * chroma / (chroma.mean() + 1e-12))
    dct = np.cos(np.pi / 24 * (np.arange(24) + 0.5)[None, :] * np.arange(1, 13)[:, None])
    timbre = bands @ dct.T
    timbre = (timbre - timbre.mean(0)) / (timbre.std(0) + 1e-9)
    parts = [(_unit(chords - chords.mean(0)), 1.0), (_unit(timbre), 1.0)]
    how = 'chords and sound'
    if model is not None:
        try:
            if lock:
                with lock:
                    states = word_states(model, path)
            else:
                states = word_states(model, path)
            if states is not None:
                at = np.clip((grid * WORDS_FPS).astype(int), 0, len(states))
                words = _per_beat(states, at)
                parts.append((_unit(words - words.mean(0)), 2.0))
                how = 'chords, sound and words'
        except Exception:  # (chords and sound alone then)
            pass
    s = sum(w * _similarity(x) for x, w in parts) / sum(w for _, w in parts)
    n = len(s)

    cuts, strength = _boundaries(s)
    if len(cuts) < 3:  # no clear sections: every bar is a place to start
        cuts = list(range(0, n, 4))
    p = _segment_similarity(s, length)
    base, top = float(np.nanmedian(p)), float(np.nanpercentile(p, 99.5))
    span = max(top - base, 1e-6)
    gap = int(0.6 * length)

    def returns(i):
        """The other places the `length` beats from beat i come back clearly (at least gap beats apart)."""
        row = p[i].copy()
        row[max(0, i - gap):i + gap] = np.nan
        found = []
        for j in np.argsort(-np.nan_to_num(row, nan=-9)):
            if np.isnan(row[j]) or row[j] <= base + 0.5 * span:
                break
            if all(abs(j - q) >= gap for q in found):
                found.append(int(j))
        return found

    # How lively each beat is next to the song's usual (its quiet intro and outro left out of that): how loud it
    # sounds and how much presence it has, both counted in the song's own spread.
    on = level[:, 0] > np.percentile(level[:, 0], 90) - 20
    def z(v):
        ref = v[on] if on.sum() > 4 else v
        return (v - np.median(ref)) / (np.std(ref) + 1e-9)
    lively = (z(level[:, 1]) + z(level[:, 2] - level[:, 0])) / 2
    sums = np.concatenate([[0], np.cumsum(lively)])
    def liveliness(i, k=length):
        j = min(len(lively), i + k)
        return float((sums[j] - sums[i]) / max(1, j - i))

    # A meme part is never one of the song's quiet stretches: a window more than 0.75 dB under the song's usual
    # (median) loudness is passed over while there is anything else.
    total = np.concatenate([[0.0], np.cumsum(power[:, 0])])
    def level_db(i):
        j = min(n, i + length)
        return float(10 * np.log10((total[j] - total[i]) / max(1, j - i) + 1e-12))
    usual = float(np.median([level_db(i) for i in range(0, max(1, n - length))]))
    def quiet(i):
        return level_db(i) < usual - 0.75

    ranked = []
    usable = [c for c in cuts if c + length <= n and not quiet(c)] or [c for c in cuts if c + length <= n]
    for c in usable:
        back = returns(c)
        rep = sum((p[c, j] - base) / span for j in back[:3])
        best = max([p[c, j] for j in back], default=base)
        group = sorted([c] + [j for j in back if p[c, j] >= base + 0.75 * (best - base)])
        loop = bool(back) and all(abs(j - c) < 1.6 * length for j in back)  # only repeats itself right away
        score = (rep + 0.5 * liveliness(c) + 0.3 * strength[c] - 1.5 * max(0.0, grid[group[0]] / dur - 0.45)
                 - (0.8 if loop else 0.0))
        ranked.append((score, c, group))
    if not ranked:
        raise ValueError('no sections')
    ranked.sort(key=lambda r: -r[0])
    _, pick, group = ranked[0]
    # The first time the part comes, unless that is a softer go at it (an instrumental's quiet first run of its
    # theme): then the first time it comes about as loud as its loudest.
    loud = [level_db(g) for g in group]
    first = next((g for g, db in zip(group, loud) if db >= max(loud) - 1.5 and not quiet(g)), group[int(np.argmax(loud))])
    pairs = [(g, h) for k, g in enumerate(group) for h in group[k + 1:]]

    def agree(d):
        """How alike the returns are d beats before their aligned starts (negative d: after)."""
        vals = [s[g - d, h - d] for g, h in pairs if 0 <= g - d < n and 0 <= h - d < n]
        return float(np.mean(vals)) if vals else -1.0

    def start_score(q):
        """A section boundary q where the returns start agreeing, the music lifts and the structure changes."""
        d = first - q
        after = np.mean([agree(d - x) for x in range(8)])
        before = np.mean([agree(d + 1 + x) for x in range(4)])
        lift = liveliness(q, 8) - (liveliness(max(0, q - 4), 4) if q >= 4 else liveliness(q, 8))
        return after - before + 0.5 * strength[q] + 0.15 * lift

    options = [q for q in cuts if first - length // 2 <= q <= first + length // 3]
    options = [q for q in options if not quiet(q)] or options
    start = max(options, key=start_score) if options else first
    shift = start - first
    beat = float(np.median(np.diff(grid)))
    later = [b for b in cuts if b >= start + int(round(8 / beat))]
    seconds = float(np.clip(grid[later[0]] - grid[start], 8, 20)) if later else WANT
    cands = [{'start': float(grid[start]), 'why': 'chorus' if len(group) > 1 else 'catchy part'}]
    for g in group:  # the same part at its other times (on a section boundary when there is one close by)
        if g == first:
            continue
        at = min(max(0, g + shift), n - 1)
        close = [q for q in cuts if abs(q - at) <= 2]
        cands.append({'start': float(grid[min(close, key=lambda q: abs(q - at)) if close else at]),
                      'why': 'chorus again' if g > first else 'same part, softer'})
    # The best part that is something else (none of its returns near the pick's), the first time it comes.
    other = next((gr for _, _, gr in ranked[1:] if all(abs(a - b) >= length // 2 for a in gr for b in group)), None)
    if other is not None:
        cands.insert(2, {'start': float(grid[other[0]]), 'why': 'another catchy part'})
    cands += [loudest, opening]
    return {'start': round(float(grid[start]), 2), 'seconds': round(seconds, 2), 'candidates': _clean(cands),
            'how': how}
