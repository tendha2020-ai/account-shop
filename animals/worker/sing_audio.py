# sing_audio.py: the sound side of "Sing" (worker v14): one or two animals singing a song, each in its own voice.
# Everything here runs on the worker's own CPU (2 vCPU, no GPU), free. Optional packages, each in its own Dockerfile
# step (a missing one only switches its part off): pyworld (WORLD voices; else Rubber Band), sherpa-onnx (the quick
# Spleeter split), torch-cpu + audio-separator (the best split: Kim's Mel-Band RoFormer), faster-whisper 'small'
# (the sung lines; the worker already has faster-whisper).
#
#  1. separate()      the song into the singer (vocals) and the music (instrumental), once per song, kept with it
#                     in the owner's private dataset. 'spleeter': Deezer's Spleeter 2-stems (MIT, via sherpa-onnx),
#                     10-14 s a song: the quick split, so a song is ready in minutes. 'roformer': Kim's Mel-Band
#                     RoFormer (MIT weights, torch): the cleanest free split, ~25 min a song on 2 vCPU: the best
#                     split, made afterwards in the background.
#  2. sung_words()    Whisper's words with times, heard on the vocals, one sung region at a time.
#     sung_lines()    the words as sung lines; each line held as long as the voice really holds its last note.
#     song_parts()    intro / verse / chorus / hook / break / outro, from the lines (and chorus.find()).
#     pack_lines()    the lines as they are KEPT: times, word counts, kinds. The words themselves are dropped right
#                     after prepare: no lyrics are ever stored, shown or served (they belong to the songwriters).
#  3. share_lines()   which animal sings what: solo, take turns ('alternate'), verses each / choruses together
#                     ('verse_chorus'), together, or the owner's own choice per line ('custom').
#     part_tracks()   one vocal track per animal, silent where the others sing: the lip-sync inputs (always the
#                     ORIGINAL separated vocal, so a voice change never changes a mouth).
#  4. animal_voice()  each animal its own sound: the same notes (or whole octaves), a smaller or bigger body (WORLD).
#  5. mix()           the animal voices over the instrumental at -14 LUFS (TikTok's loudness); master() the same
#                     loudness for the original song.

import difflib
import importlib
import importlib.util
import json
import math
import os
import re
import subprocess
import tempfile
import time

import numpy as np

SR = 44100
ROFORMER = {  # Kim's Mel-Band RoFormer vocals model (MIT): the checkpoint and its config, pinned
    'repo': 'KimberleyJSN/melbandroformer', 'file': 'MelBandRoformer.ckpt',
    'audio_separator_name': 'vocals_mel_band_roformer.ckpt',  # the same weights under audio-separator's name
}
SPLEETER = {  # Deezer's Spleeter 2-stems (MIT) as ONNX, from sherpa-onnx's releases (Apache-2.0); float32: the int8
    # copy leaves ~20 dB more music in the vocals (-38 vs -58 dB in the song's instrumental break)
    'url': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/'
           'sherpa-onnx-spleeter-2stems.tar.bz2',
    'dir': 'sherpa-onnx-spleeter-2stems',
}


# ---------------------------------------------------------------------------------------------- audio in and out

def load(path, start=0.0, seconds=None, sr=SR, mono=False):
    """Any audio file ffmpeg reads, as float32 (frames, 2) (or (frames,) with mono) at `sr`."""
    cmd = ['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-i', str(path)]
    if seconds:
        cmd += ['-t', f'{seconds:.3f}']
    cmd += ['-ac', '1' if mono else '2', '-ar', str(sr), '-f', 'f32le', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).copy()
    return x if mono else x.reshape(-1, 2)


def save(path, x, sr=SR, codec=None):
    """float32 (frames, ch) or (frames,) to any format by extension (.flac 24-bit, .wav float, .m4a AAC 256k)."""
    x = np.asarray(x, np.float32)
    ch = 1 if x.ndim == 1 else x.shape[1]
    ext = os.path.splitext(str(path))[1].lower()
    args = {'.flac': ['-c:a', 'flac', '-sample_fmt', 's32'], '.wav': ['-c:a', 'pcm_f32le'],
            '.m4a': ['-c:a', 'aac', '-b:a', '256k'], '.mp3': ['-c:a', 'libmp3lame', '-b:a', '256k']}.get(ext, [])
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(sr), '-ac', str(ch), '-i', '-']
                   + (codec or args) + [str(path)], input=x.tobytes(), check=True)


def _ffmpeg_af(x, sr, af):
    """Run an ffmpeg audio filter chain over a float32 array; the result is cut/padded to the same length."""
    ch = 1 if x.ndim == 1 else x.shape[1]
    out = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', str(ch), '-i', '-',
                          '-af', af, '-f', 'f32le', '-ac', str(ch), '-ar', str(sr), '-'],
                         input=np.ascontiguousarray(x, np.float32).tobytes(), capture_output=True, check=True).stdout
    y = np.frombuffer(out, np.float32).copy()
    y = y if ch == 1 else y.reshape(-1, ch)
    if len(y) >= len(x):
        return y[:len(x)]
    return np.pad(y, [(0, len(x) - len(y))] + [(0, 0)] * (y.ndim - 1))


def resample(x, sr_from, sr_to):
    """float32 audio from one rate to another (ffmpeg's soxr-quality resampler)."""
    ch = 1 if x.ndim == 1 else x.shape[1]
    out = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(sr_from), '-ac', str(ch), '-i', '-',
                          '-af', 'aresample=resampler=soxr', '-ar', str(sr_to), '-f', 'f32le', '-'],
                         input=np.ascontiguousarray(x, np.float32).tobytes(), capture_output=True, check=True).stdout
    y = np.frombuffer(out, np.float32).copy()
    return y if ch == 1 else y.reshape(-1, ch)


# ---------------------------------------------------------------------------------------------- 1. separation

def model_file(name, cache_dir):
    """The Spleeter model folder, downloaded once (the RoFormer's file is fetched by audio-separator itself)."""
    os.makedirs(cache_dir, exist_ok=True)
    if name == 'spleeter':
        d = os.path.join(cache_dir, SPLEETER['dir'])
        if not os.path.isdir(d):
            import tarfile
            import urllib.request
            tmp = os.path.join(cache_dir, 'spleeter.tar.bz2')
            urllib.request.urlretrieve(SPLEETER['url'], tmp)
            with tarfile.open(tmp) as t:
                t.extractall(cache_dir, filter='data')
            os.remove(tmp)
        return d
    return cache_dir


def _roformer(x, cache_dir, threads=2):
    """Kim's Mel-Band RoFormer through audio-separator (torch, CPU): 8 s windows, the model's own settings.
    Measured here: ~2.5 GB peak, ~7.5 s of CPU per second of song on 2 busy cores. (Its one-graph ONNX export
    needs over 7.9 GB for one 8 s window, its attention is not memory-efficient there: not usable on the worker.)
    x: (frames, 2). Returns the vocals (frames, 2)."""
    import torch
    torch.set_num_threads(threads)
    from audio_separator.separator import Separator
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, 'mix.wav')
        save(src, x)
        sep = Separator(model_file_dir=cache_dir, output_dir=d, output_format='WAV', output_single_stem='Vocals',
                        log_level=40)
        sep.load_model(model_filename=ROFORMER['audio_separator_name'])
        files = sep.separate(src)
        v = load(os.path.join(d, os.path.basename(files[0])))
    return v[:len(x)] if len(v) >= len(x) else np.pad(v, ((0, len(x) - len(v)), (0, 0)))


def _spleeter(x, model_dir, threads=2, block=60.0):
    """Spleeter 2-stems through sherpa-onnx, 60 s at a time (its whole-song pass needs ~3.7 GB), faded together
    over 1 s. sherpa-onnx's inverse STFT spikes in the first/last ~150 samples, so every block gets 0.5 s of
    padding. (Blocks change nothing overall, SDR against the RoFormer 6.06 vs 6.10 dB one-pass; only near-silent
    stretches move with where a block starts.)"""
    import sherpa_onnx
    cfg = sherpa_onnx.OfflineSourceSeparationConfig(model=sherpa_onnx.OfflineSourceSeparationModelConfig(
        spleeter=sherpa_onnx.OfflineSourceSeparationSpleeterModelConfig(
            vocals=os.path.join(model_dir, 'vocals.onnx'),
            accompaniment=os.path.join(model_dir, 'accompaniment.onnx')),
        num_threads=threads, provider='cpu'))
    sp = sherpa_onnx.OfflineSourceSeparation(cfg)
    pad, size, cross = SR // 2, int(block * SR), SR  # 1 s crossfades between blocks
    out = np.zeros_like(x)
    weight = np.zeros(len(x), np.float32)
    for i in range(0, len(x), size - cross):
        part = x[i:i + size]
        r = sp.process(sample_rate=SR, samples=np.ascontiguousarray(np.pad(part, ((pad, pad), (0, 0))).T))
        voc = r.stems[0].data.T[pad:pad + len(part)]
        voc = np.pad(voc, ((0, len(part) - len(voc)), (0, 0)))
        w = np.ones(len(part), np.float32)
        if i > 0:
            w[:cross] = np.linspace(0, 1, cross)[:len(part)]
        if i + size < len(x):
            w[-cross:] = np.linspace(1, 0, cross)
        out[i:i + len(part)] += voc * w[:, None]
        weight[i:i + len(part)] += w
        if i + size >= len(x):
            break
    return out / np.maximum(weight, 1e-6)[:, None]


def separate(song, out_dir, engine='roformer', start=0.0, seconds=None, cache_dir='models', threads=2, lock=None):
    """The singer and the music of `song` (or of `seconds` from `start`), as out_dir/vocals.flac and
    out_dir/instrumental.flac (44.1 kHz stereo). The instrumental is the song minus the vocals, so the music stays
    exactly as it was. Returns {'vocals', 'instrumental', 'engine', 'seconds_audio'}."""
    x = load(song, start, seconds)
    path = model_file(engine, cache_dir)

    def run():
        return _roformer(x, path, threads) if engine == 'roformer' else _spleeter(x, path, threads)
    if lock:
        with lock:
            v = run()
    else:
        v = run()
    os.makedirs(out_dir, exist_ok=True)
    out = {'vocals': os.path.join(out_dir, 'vocals.flac'), 'instrumental': os.path.join(out_dir, 'instrumental.flac'),
           'engine': engine, 'seconds_audio': round(len(x) / SR, 2)}
    save(out['vocals'], v)
    save(out['instrumental'], x - v)
    return out


def split_ready(engine):
    """True when this split can run here: 'spleeter' needs sherpa-onnx (its 75 MB model downloads on first use),
    'roformer' torch + audio-separator (its 913 MB checkpoint downloads on first use)."""
    try:
        if engine == 'spleeter':  # (small: imported to be sure it loads)
            importlib.import_module('sherpa_onnx')
            return True
        if engine != 'roformer':
            return False
        # (big: torch is only looked for here, and imported when a song is split)
        return all(importlib.util.find_spec(name) is not None for name in ('torch', 'audio_separator'))
    except Exception:
        return False


# ---------------------------------------------------------------------------------------------- 2. lines and parts

# Whisper's well-known inventions on music and silence (Russian subtitle credits and the like).
HALLUCINATIONS = re.compile(r'субтитр|продолжение следует|редактор|корректор|спасибо за просмотр|подпишись|'
                            r'динамичная музыка|спокойная музыка|позитивная музыка|бодрая музыка|грустная музыка|'
                            r'музыкальная заставка|thank you for watching|subtitles by|amara\.org', re.I)


def sung_regions(vocals_mono, sr=SR, join=0.6, pad=0.2, longest=24.0):
    """Where the singer sings, as [(start, end)] seconds, each at most `longest` s (long ones are cut at their
    quietest moment), from the vocal stem's own level: Whisper's speech detector (Silero) misses singing over
    music, and one long pass over a song tends to stop transcribing halfway (it did here: 60 s lost)."""
    t, active, level = voice_activity(vocals_mono, sr)
    hop = 0.01
    runs = np.diff(np.r_[0, active.astype(int), 0])
    spans = [[a * hop, b * hop] for a, b in zip(np.where(runs == 1)[0], np.where(runs == -1)[0])]
    merged = []
    for a, b in spans:
        if merged and a - merged[-1][1] < join:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    total = len(vocals_mono) / sr
    out = []
    for a, b in merged:
        a, b = max(0.0, a - pad), min(total, b + pad)
        while b - a > longest:
            lo, hi = int((a + longest * 0.6) / hop), int((a + longest) / hop)
            cut = (lo + int(np.argmin(level[lo:hi]))) * hop if hi > lo else a + longest
            out.append((round(a, 2), round(cut, 2)))
            a = cut
        if b - a >= 0.3:
            out.append((round(a, 2), round(b, 2)))
    return out


def sung_words(vocals, model, language=None, lock=None):
    """Whisper (faster-whisper) on the separated vocals: {'language', 'words': [{'w', 'start', 'end', 'p'}],
    'regions'}. Each sung region is heard on its own (no text carried over, no speech detector), so a missed or
    invented line can't spread; credits-style inventions are dropped."""
    voc = load(vocals, sr=SR, mono=True)
    audio = load(vocals, sr=16000, mono=True)
    regions = sung_regions(voc)
    kw = dict(beam_size=5, word_timestamps=True, vad_filter=False, condition_on_previous_text=False,
              temperature=(0.0, 0.2, 0.4), compression_ratio_threshold=2.2, no_speech_threshold=0.7)

    def run():
        lang, words = language, []
        if lang is None and regions:  # the language from the longest sung stretch
            a, b = max(regions, key=lambda r: r[1] - r[0])
            _, info = model.transcribe(audio[int(a * 16000):int(b * 16000)], **kw)
            lang = info.language
        for a, b in regions:
            segs, _ = model.transcribe(audio[int(a * 16000):int(b * 16000)], language=lang, **kw)
            for s in segs:
                if HALLUCINATIONS.search(s.text) or (s.no_speech_prob > 0.7 and s.avg_logprob < -1.0):
                    continue
                for w in s.words or []:
                    if w.word.strip():
                        words.append({'w': w.word.strip(), 'start': round(a + float(w.start), 2),
                                      'end': round(a + float(w.end), 2), 'p': round(float(w.probability), 3)})
        return lang, words
    if lock:
        with lock:
            lang, words = run()
    else:
        lang, words = run()
    return {'language': lang, 'words': words, 'regions': regions}


def voice_activity(vocals_mono, sr=SR, hop=0.01):
    """Per 10 ms: is the singer singing? (the vocal stem's level against its own loud parts and noise floor).
    Returns (times, active bool array, level dB)."""
    h = int(sr * hop)
    n = len(vocals_mono) // h
    frames = vocals_mono[:n * h].reshape(n, h)
    level = 10 * np.log10((frames ** 2).mean(1) + 1e-10)
    loud, floor = np.percentile(level, 95), np.percentile(level, 10)
    threshold = max(loud - 30, floor + 0.35 * (loud - floor))
    active = level > threshold
    # hold through very short dips (consonants, vibrato) and drop blips shorter than 60 ms
    k = 8
    active = np.convolve(active, np.ones(k), 'same') > 0
    runs = np.diff(np.r_[0, active.astype(int), 0])
    for a, b in zip(np.where(runs == 1)[0], np.where(runs == -1)[0]):
        if b - a < 6:
            active[a:b] = False
    return np.arange(n) * hop, active, level


def sung_lines(words, vocals_mono, sr=SR, max_gap=0.45, max_len=7.0, hold_max=2.5):
    """The words as sung lines [{'start', 'end', 'text', 'words': [(w, start, end)], 'p'}], plus sung stretches no
    words were heard in (ooh / la-la / ad-libs) as lines with text ''. A line starts where the voice starts (up to
    0.25 s before Whisper's first word) and ends where the voice stops, held notes included (up to `hold_max` s
    after the last word, never into the next line)."""
    t, active, _ = voice_activity(vocals_mono, sr)
    hop = t[1] - t[0] if len(t) > 1 else 0.01

    def new_line(prev, w, cur):
        gap = w['start'] - prev['end']
        if gap > max_gap or prev['w'][-1:] in '.!?…':
            return True
        # Whisper writes lyrics a line at a time, each starting with a capital ("I" aside)
        capital = w['w'][:1].isupper() and w['w'] not in ('I', "I'm", "I'll", "I've", "I'd")
        return capital and (gap > 0.05 or prev['w'][-1:] in ',;:' or w['end'] - cur[0]['start'] > 2.0)
    words = [w for w in words if w['p'] >= 0.1]  # guesses (mostly on wordless singing) don't make lines
    lines, cur = [], []
    for w in words:
        if cur and new_line(cur[-1], w, cur):
            lines.append(cur)
            cur = []
        cur.append(w)
    if cur:
        lines.append(cur)
    # too long: cut at the biggest pause inside; a lone short word joins the line it leans on
    done = []
    while lines:
        ws = lines.pop(0)
        if ws[-1]['end'] - ws[0]['start'] > max_len and len(ws) > 1:
            k = 1 + int(np.argmax([b['start'] - a['end'] for a, b in zip(ws[:-1], ws[1:])]))
            lines[:0] = [ws[:k], ws[k:]]
            continue
        if done and ws[-1]['end'] - ws[0]['start'] < 0.7 and ws[0]['start'] - done[-1][-1]['end'] < 0.25:
            done[-1] = done[-1] + ws
            continue
        done.append(ws)
    lines = done

    def frame(s):
        return int(np.clip(round(s / hop), 0, len(active) - 1))
    out = []
    for k, ws in enumerate(lines):
        start, end = ws[0]['start'], ws[-1]['end']
        f = frame(start)
        back = frame(max(start - 0.25, out[-1]['end'] + 0.02 if out else 0.0))
        while f > back and active[f - 1]:
            f -= 1
        start = min(start, f * hop)
        nxt = lines[k + 1][0]['start'] - 0.05 if k + 1 < len(lines) else len(active) * hop
        g, limit = frame(end), frame(min(nxt, end + hold_max))
        while g < limit and active[g]:
            g += 1
        end = max(end, g * hop)
        out.append({'start': round(start, 2), 'end': round(end, 2),
                    'text': ' '.join(w['w'] for w in ws).strip(),
                    'words': [(w['w'], w['start'], w['end']) for w in ws],
                    'p': round(float(np.mean([w['p'] for w in ws])), 2)})
    # sung stretches with no words in them (0.6 s or longer)
    covered = np.zeros(len(active), bool)
    for ln in out:
        covered[frame(ln['start']):frame(ln['end']) + 1] = True
    extra = active & ~covered
    runs = np.diff(np.r_[0, extra.astype(int), 0])
    for a, b in zip(np.where(runs == 1)[0], np.where(runs == -1)[0]):
        if (b - a) * hop >= 0.6:
            out.append({'start': round(a * hop, 2), 'end': round(b * hop, 2), 'text': '', 'words': [], 'p': None})
    return sorted(out, key=lambda ln: ln['start'])


def _norm_text(s, language=None):
    """Lower-case words without punctuation; digits spelled out when num2words knows the language (Whisper writes
    the same sung number once in words and once in digits)."""
    s = s.lower().replace('ё', 'е')
    if language and re.search(r'\d', s):
        try:
            from num2words import num2words
            s = re.sub(r'\d+', lambda m: ' ' + num2words(int(m.group()), lang=language) + ' ', s)
        except Exception:  # (no num2words, or not that language)
            pass
    return re.sub(r'[^\w ]+', ' ', s).split()


def song_parts(lines, duration, chorus_start=None, min_break=4.0, repeat=0.72, language=None):
    """The song's parts [{'kind', 'start', 'end', 'lines': [line indexes]}], kind in intro / verse / chorus / hook /
    break / outro, verses numbered ('n'). Each line is one of: wordless or a vocalise (ooh, ай-ай, la-la: under two
    different real words) -> hook; said again elsewhere (4 s or more away) -> chorus; else verse (with one odd
    line evened out by its neighbours). Runs of one kind make a part; a pause of `min_break` s ends one too; a short
    vocalise inside a part stays in it. The part holding chorus.find()'s start (when given) is a chorus."""
    words = [_norm_text(ln['text'], language) for ln in lines]
    texts = [' '.join(w) for w in words]
    bags = [{w for w in ws if len(w) >= 3} for ws in words]
    informative = [len(b) >= 2 for b in bags]

    def alike(i, j):
        shared = len(bags[i] & bags[j])
        held = shared / len(bags[i]) + 0.06 if shared >= 2 else 0.0  # its words inside that line (cut differently)
        return max(difflib.SequenceMatcher(None, texts[i], texts[j]).ratio(), held)
    # Whisper hears the same words a little differently each time, and cuts the lines differently: the better of
    # letters-in-order and words-held-in-the-other-line
    raw = [informative[i] and max([alike(i, j) for j in range(len(lines)) if j != i and informative[j]
                                   and abs(lines[j]['start'] - lines[i]['start']) >= 4] or [0.0]) >= repeat
           for i in range(len(lines))]
    told = [i for i in range(len(lines)) if informative[i]]
    kind = ['H'] * len(lines)
    for k, i in enumerate(told):  # majority of each worded line and its worded neighbours
        near = [raw[j] for j in told[max(0, k - 1):k + 2]]
        kind[i] = 'C' if sum(near) * 2 > len(near) else 'V'
    groups = []
    for i, ln in enumerate(lines):
        if groups:
            g = groups[-1]
            gap = ln['start'] - lines[g['lines'][-1]]['end']
            if gap < min_break and kind[i] == g['kind']:
                g['lines'].append(i)
                continue
            if gap < min_break and kind[i] == 'H' and ln['end'] - ln['start'] < 2.5:
                g['lines'].append(i)  # a short vocalise inside a sung part
                continue
        groups.append({'kind': kind[i], 'lines': [i]})
    # a short vocalise part that the next part continues joins it (no one-line "hooks" between a verse and chorus)
    merged = []
    for g in groups:
        span = lines[g['lines'][-1]]['end'] - lines[g['lines'][0]]['start']
        if merged and g['kind'] == 'H' and span < 2.5 and \
                lines[g['lines'][0]]['start'] - lines[merged[-1]['lines'][-1]]['end'] < min_break:
            merged[-1]['lines'] += g['lines']
        else:
            merged.append(g)
    parts, verse_no, t = [], 0, 0.0
    for g in merged:
        idx = g['lines']
        start, end = lines[idx[0]]['start'], max(lines[i]['end'] for i in idx)
        if start - t >= 1.0:
            parts.append({'kind': 'intro' if not parts else 'break', 'start': round(t, 2), 'end': round(start, 2),
                          'lines': []})
        anchored = chorus_start is not None and start - 2 <= chorus_start <= end
        k = {'H': 'hook', 'C': 'chorus', 'V': 'verse'}[g['kind']]
        if anchored and k != 'chorus':
            k = 'chorus'
        part = {'kind': k, 'start': round(start, 2), 'end': round(end, 2), 'lines': idx}
        if k == 'verse':
            verse_no += 1
            part['n'] = verse_no
        parts.append(part)
        t = end
    if duration - t >= 1.0:
        parts.append({'kind': 'outro', 'start': round(t, 2), 'end': round(duration, 2), 'lines': []})
    return parts


# ---------------------------------------------------------------------------------------------- 3. who sings what

RULES = ('solo', 'alternate', 'verse_chorus', 'call_response', 'together', 'custom')


def share_lines(lines, parts, animals, rule='verse_chorus', choices=None):
    """Who sings each moment: [{'start', 'end', 'who': [animal indexes], 'line': i}] (spans in time order).
    animals: 1-3 names. choices ('custom'): {line index: [animal indexes]}, the owner's pick per line by ear (the
    lines not picked take turns). Rules:
      solo           the first animal sings everything
      together       everyone sings everything
      alternate      line by line in turn (A, B, A, B / A, B, C), everyone on each chorus's last line
      verse_chorus   each verse goes to the next animal in turn, every chorus is sung together
      call_response  verses: line by line in turn, and the others echo each line's last word;
                     choruses: the first animal calls the first half of each line, the others answer the second
                     half, everyone on the chorus's last line"""
    n = max(1, len(animals))
    everyone = list(range(n))
    kind_of, verse_of = {}, {}
    for p in parts:
        for i in p['lines']:
            kind_of[i], verse_of[i] = p['kind'], p.get('n', 0)
    last_of_chorus = {p['lines'][-1] for p in parts if p['kind'] == 'chorus' and p['lines']}
    spans, turn = [], 0
    for i, ln in enumerate(lines):
        kind = kind_of.get(i, 'verse')
        if n == 1 or rule == 'solo':
            who = [0]
        elif rule == 'together':
            who = everyone
        elif rule == 'custom' and choices and i in choices:
            who = [k for k in choices[i] if 0 <= k < n] or everyone
        elif rule == 'custom':
            who = everyone if i in last_of_chorus else [turn % n]
            turn += 0 if i in last_of_chorus else 1
        elif rule == 'verse_chorus':
            who = everyone if kind in ('chorus', 'hook') else [(verse_of.get(i, 1) - 1) % n]
        elif rule == 'alternate':
            who = everyone if i in last_of_chorus else [turn % n]
            turn += 0 if i in last_of_chorus else 1
        elif rule == 'call_response':
            ws = ln.get('words') or []  # (kept lines have no words: everyone sings them)
            if i in last_of_chorus or not ws:
                who = everyone
            elif kind == 'chorus' and len(ws) >= 2:
                half = len(ws) // 2
                cut = ws[half][1]
                spans.append({'start': ln['start'], 'end': cut, 'who': [0], 'line': i})
                spans.append({'start': cut, 'end': ln['end'], 'who': everyone[1:], 'line': i})
                continue
            else:
                singer = turn % n
                turn += 1
                if len(ws) >= 3:
                    cut = ws[-1][1]
                    spans.append({'start': ln['start'], 'end': cut, 'who': [singer], 'line': i})
                    spans.append({'start': cut, 'end': ln['end'], 'who': everyone, 'line': i})
                    continue
                who = [singer]
        else:
            raise ValueError(f'rule {rule!r}')
        spans.append({'start': ln['start'], 'end': ln['end'], 'who': who, 'line': i})
    return spans


def part_envelopes(spans, n_animals, frames, sr=SR, attack=0.03, release=0.08, fade=0.02):
    """Per animal, a 0..1 gain per sample: 1 while it sings (a little before and after, for breaths and tails),
    0 elsewhere, with 20 ms raised-cosine fades so nothing clicks."""
    env = np.zeros((n_animals, frames), np.float32)
    for s in spans:
        a = max(0, int((s['start'] - attack) * sr))
        b = min(frames, int((s['end'] + release) * sr))
        for who in s['who']:
            env[who, a:b] = 1.0
    f = max(1, int(fade * sr))
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, f))).astype(np.float32)
    out = np.empty_like(env)
    for k in range(n_animals):
        e = env[k]
        edges = np.diff(np.r_[0.0, e, 0.0])
        sm = e.copy()
        for a in np.where(edges > 0)[0]:
            m = min(f, frames - a)
            sm[a:a + m] = np.minimum(sm[a:a + m], ramp[:m])
        for b in np.where(edges < 0)[0]:
            m = min(f, b)
            sm[b - m:b] = np.minimum(sm[b - m:b], ramp[::-1][-m:])
        out[k] = sm
    return out


def part_gains(spans, n_animals, frames, sr=SR, support_db=-4.5, smooth=0.04):
    """Per animal, its level per sample on the lines sung together: the line's first animal leads (1.0), the
    others back it up `support_db` lower, so the line stays one clear melody with a second voice under it (two
    voices octaves apart at the same level were the hardest for Whisper: 0.70 vs 0.20-0.32 per-line error)."""
    g = np.ones((n_animals, frames), np.float32)
    low = 10 ** (support_db / 20)
    for s in spans:
        a, b = max(0, int(s['start'] * sr)), min(frames, int(s['end'] * sr))
        for who in s['who'][1:]:
            g[who, a:b] = low
    k = max(1, int(smooth * sr))
    for i in range(n_animals):  # 40 ms moving average: the level glides, never steps
        c = np.concatenate([[0.0], np.cumsum(np.pad(g[i], (k // 2, k - k // 2 - 1), mode='edge'), dtype=np.float64)])
        g[i] = ((c[k:] - c[:-k]) / k).astype(np.float32)
    return g


def part_tracks(vocals, spans, n_animals, sr=SR):
    """One vocal track per animal (same length as the song), silent where the others sing. For lip-sync models
    that take one audio per person (MultiTalk / InfiniteTalk style), feed these, before any voice effect: the
    original singer's sound gives the cleanest mouth shapes."""
    env = part_envelopes(spans, n_animals, len(vocals), sr)
    return [vocals * (e[:, None] if vocals.ndim == 2 else e) for e in env]


# ---------------------------------------------------------------------------------------------- 4. animal voices

# pitch: the notes, by whole octaves only (2.0 up, 0.5 down) or not at all: anything else leaves the song's key.
# formant: the singer's size (above 1 smaller and brighter, below 1 bigger and darker).
# Chosen on the Detstvo chorus (README): WORLD kept 94-96% of voiced frames within half a semitone of the asked
# octave and Whisper still heard the words (per-line character error 0.08-0.30 against 0.13 for the original).
VOICES = {
    'cat':      {'pitch': 2.0, 'formant': 1.25, 'eq': 'highpass=f=180,equalizer=f=4000:t=q:w=1:g=2'},
    'dog':      {'pitch': 1.0, 'formant': 0.88, 'eq': 'highpass=f=90,equalizer=f=250:t=q:w=1:g=1.5'},
    'bear':     {'pitch': 0.5, 'formant': 0.80, 'eq': 'highpass=f=45,equalizer=f=160:t=q:w=1:g=1.5,'
                                                     'equalizer=f=2500:t=q:w=1:g=2'},
    'small':    {'pitch': 1.0, 'formant': 1.30, 'eq': 'highpass=f=150,equalizer=f=3500:t=q:w=1:g=2'},
    'bird':     {'pitch': 2.0, 'formant': 1.40, 'eq': 'highpass=f=300,equalizer=f=5000:t=q:w=1:g=2'},
    'original': {'pitch': 1.0, 'formant': 1.00, 'eq': 'highpass=f=80'},
}
ANIMAL_VOICE = {'cat': 'cat', 'kitten': 'cat', 'hamster': 'bird', 'parrot': 'bird', 'bird': 'bird', 'chick': 'bird',
                'mouse': 'bird', 'rabbit': 'small', 'bunny': 'small', 'puppy': 'small', 'fox': 'small',
                'dog': 'dog', 'goat': 'dog', 'pig': 'dog', 'monkey': 'dog', 'horse': 'dog', 'sheep': 'dog',
                'bear': 'bear', 'cow': 'bear', 'lion': 'bear', 'gorilla': 'bear', 'hippo': 'bear', 'elephant': 'bear'}


def voice_for(animal):
    """The voice preset for an animal name ('brown bear' -> bear; unknown animals sing as 'dog', the middle)."""
    if animal in VOICES:
        return animal
    for word in reversed(str(animal).lower().split()):
        if word in ANIMAL_VOICE:
            return ANIMAL_VOICE[word]
    return 'dog'


# What the page offers per singer (every preset, the owner's choice): the original singer, the singer's own animal
# voice, or any preset; 'higher' / 'deeper' / 'chipmunk' are the older names of cat / bear / small.
VOICE_CHOICES = ('original', 'animal', 'cat', 'bear', 'dog', 'small', 'bird')
VOICE_ALIASES = {'higher': 'cat', 'deeper': 'bear', 'chipmunk': 'small', 'auto': 'animal', 'own': 'animal'}


def clean_voice(choice):
    """A voice choice from the page as one of VOICE_CHOICES ('original' for anything else)."""
    c = VOICE_ALIASES.get(str(choice or '').strip().lower(), str(choice or '').strip().lower())
    return c if c in VOICE_CHOICES else 'original'


def voice_preset(choice, animal):
    """The VOICES preset a singer's choice means ('animal': the one that suits its animal)."""
    c = clean_voice(choice)
    return voice_for(animal) if c == 'animal' else c


def world_shift(y, sr, pitch=1.0, formant=1.0, f0_floor=65.0, f0_ceil=1100.0, frame_ms=5.0):
    """WORLD vocoder (pyworld, MIT, 3 MB): the singer's pitch track (Harvest), spectral envelope (CheapTrick) and
    breathiness (D4C); the pitch is multiplied by `pitch`, the envelope and breathiness are stretched along the
    frequency axis by `formant`, and the voice is synthesized again. Mono in, mono out, same length."""
    import pyworld as pw
    x = np.ascontiguousarray(y, np.float64)
    f0, t = pw.harvest(x, sr, f0_floor=f0_floor, f0_ceil=f0_ceil, frame_period=frame_ms)
    f0 = pw.stonemask(x, f0, t, sr)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    if abs(formant - 1) > 1e-6:
        bins = np.arange(sp.shape[1], dtype=np.float64)
        src = np.clip(bins / formant, 0, sp.shape[1] - 1)
        lo = np.floor(src).astype(int)
        hi = np.minimum(lo + 1, sp.shape[1] - 1)
        w = src - lo
        sp = sp[:, lo] * (1 - w) + sp[:, hi] * w
        ap = ap[:, lo] * (1 - w) + ap[:, hi] * w
    out = pw.synthesize(f0 * pitch, np.ascontiguousarray(sp), np.ascontiguousarray(ap), sr, frame_ms)
    out = out[:len(x)] if len(out) >= len(x) else np.pad(out, (0, len(x) - len(out)))
    return out.astype(np.float32)


def rubberband_shift(y, sr, pitch=1.0):
    """Fallback without pyworld: ffmpeg's Rubber Band, notes by `pitch` with the formants kept (no size change;
    measured rougher than WORLD: more smearing, Whisper lost 2-3x more words)."""
    if abs(pitch - 1) < 1e-6:
        return np.asarray(y, np.float32).copy()
    return _ffmpeg_af(np.asarray(y, np.float32), sr, f'rubberband=pitch={pitch}:formant=preserved')


_ENGINE = []


def voice_engine():
    """'world' when pyworld imports (it needs setuptools<81 at run time: pyworld 0.3.5 imports pkg_resources),
    else 'rubberband' (no size change, rougher), said once in the log."""
    if not _ENGINE:
        try:
            importlib.import_module('pyworld')
            _ENGINE.append('world')
        except Exception as e:  # ImportError, or pkg_resources missing inside pyworld
            import logging
            logging.getLogger('antics').warning('sing voices: no WORLD (%s: %s), using Rubber Band', type(e).__name__, e)
            _ENGINE.append('rubberband')
    return _ENGINE[0]


def shift(y, sr, pitch=1.0, formant=1.0, active=None, pad=0.3):
    """`y` (mono) in another voice; only the stretches where `active` (a 0..1 envelope, e.g. the animal's part)
    is on are worked on (WORLD is ~0.5 s of CPU per second of singing), the rest stays silent."""
    y = np.asarray(y, np.float32)
    if abs(pitch - 1) < 1e-6 and abs(formant - 1) < 1e-6:
        return y.copy()
    if voice_engine() == 'world':
        fn = lambda seg: world_shift(seg, sr, pitch, formant)  # noqa: E731
    else:
        fn = lambda seg: rubberband_shift(seg, sr, pitch)  # noqa: E731
    if active is None:
        return fn(y)
    on = np.asarray(active) > 1e-3
    runs = np.diff(np.r_[0, on.astype(int), 0])
    out = np.zeros_like(y)
    p = int(pad * sr)
    spans = []
    for a, b in zip(np.where(runs == 1)[0], np.where(runs == -1)[0]):
        a, b = max(0, a - p), min(len(y), b + p)
        if spans and a <= spans[-1][1]:
            spans[-1][1] = b
        else:
            spans.append([a, b])
    for a, b in spans:
        out[a:b] = fn(y[a:b])
    return out


def animal_voice(x, animal, sr=SR, active=None):
    """The vocal (or one animal's part track) in that animal's voice, finished like a studio vocal: the shift,
    a colour EQ, gentle de-essing and compression. x: (frames, 2) or (frames,); returns the same shape."""
    v = VOICES[voice_for(animal)]
    mono = x.mean(1) if x.ndim == 2 else x
    y = shift(mono, sr, v['pitch'], v['formant'], active=active)
    y = _ffmpeg_af(y, sr, f"{v['eq']},deesser=i=0.4:m=0.5:f=0.5,"
                          'acompressor=threshold=0.1:ratio=3:attack=5:release=120:makeup=1.5')
    if active is not None:
        y = y * np.asarray(active, np.float32)  # clean edges: exactly silent where the animal doesn't sing
    return np.stack([y, y], 1) if x.ndim == 2 else y


# ---------------------------------------------------------------------------------------------- 5. the mix

def loudness(x, sr=SR):
    """Integrated loudness (LUFS) and true peak (dBTP) by ffmpeg's EBU R128 meter."""
    ch = 1 if x.ndim == 1 else x.shape[1]
    r = subprocess.run(['ffmpeg', '-v', 'info', '-nostats', '-f', 'f32le', '-ar', str(sr), '-ac', str(ch), '-i', '-',
                        '-af', 'ebur128=peak=true', '-f', 'null', '-'], input=np.ascontiguousarray(x, np.float32).tobytes(),
                       capture_output=True)
    text = r.stderr.decode(errors='replace').split('Summary:')[-1]
    lufs = float(re.search(r'I:\s+(-?[\d.]+|-inf) LUFS', text).group(1).replace('-inf', '-70'))
    tp = re.search(r'Peak:\s+(-?[\d.]+|-inf) dBFS', text)
    return lufs, float(tp.group(1).replace('-inf', '-70')) if tp else None


def master(x, sr=SR, target_lufs=-14.0, true_peak=-1.0, fade_in=0.02, fade_out=0.02):
    """Any stereo float32 (the original song cut to a part) at `target_lufs` with its true peak under `true_peak`
    dBTP: measured, one linear gain, a limiter as a guard; short fades so a cut never clicks. Same length."""
    x = np.asarray(x, np.float32)
    lufs, _ = loudness(x, sr)
    if lufs > -69:
        x = x * 10 ** ((target_lufs - lufs) / 20)
    x = true_peak_limit(x, sr, true_peak)
    return fades(x, sr, fade_in, fade_out)


def true_peak_limit(x, sr=SR, true_peak=-1.0):
    """A limiter on the 4x oversampled signal (so the peaks between the samples count too, as in a true-peak
    meter), 0.5 dB under `true_peak` to leave room for the AAC encoder."""
    limit = 10 ** ((true_peak - 0.5) / 20)
    return _ffmpeg_af(np.asarray(x, np.float32), sr, f'aresample={sr * 4}:resampler=soxr,alimiter=limit={limit:.4f}:'
                                                     f'attack=5:release=50:level=disabled:asc=1,aresample={sr}:resampler=soxr')


def fades(x, sr=SR, fade_in=0.02, fade_out=0.02):
    """Raised-cosine fades at both ends (fade_out may be long: the song fading out under the ending)."""
    x = np.array(x, np.float32)
    for seconds, at_end in ((fade_in, False), (fade_out, True)):
        n = min(len(x), int(seconds * sr))
        if n <= 1:
            continue
        ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))).astype(np.float32)
        ramp = ramp[::-1] if at_end else ramp
        sl = slice(len(x) - n, len(x)) if at_end else slice(0, n)
        x[sl] = x[sl] * (ramp[:, None] if x.ndim == 2 else ramp)
    return x


def mix(instrumental, voices, sr=SR, pans=None, vocal_lift_db=1.0, original_vocals=None, target_lufs=-14.0,
        true_peak=-1.0, reverb=True):
    """The animal voices over the instrumental, as one stereo float32 array at `target_lufs` (true peak under
    `true_peak` dBTP). voices: list of (frames, 2) arrays (each animal's part in its voice). The voices sit as far
    above the music as the original singer did (measured on `original_vocals` when given) plus `vocal_lift_db`;
    duet voices are spread a little left/right (pans), and share a short room so they sound sung together."""
    n = len(instrumental)
    voices = [np.pad(v, ((0, max(0, n - len(v))), (0, 0)))[:n] for v in voices]
    pans = pans or ([0.0] if len(voices) == 1 else list(np.linspace(-0.25, 0.25, len(voices))))
    bus = np.zeros_like(instrumental)
    for v, p in zip(voices, pans):
        m = v.mean(1)
        left, right = math.cos((p + 1) * math.pi / 4), math.sin((p + 1) * math.pi / 4)
        bus += np.stack([m * left, m * right], 1) * math.sqrt(2)
    if reverb:  # a small, dark room (two short early reflections + a soft tail), mixed low
        wet = _ffmpeg_af(bus, sr, 'aecho=0.8:0.5:23|41|67:0.25|0.18|0.12,lowpass=f=6000')
        bus = bus + 0.25 * (wet - bus)
    inst_lufs, _ = loudness(instrumental, sr)
    if original_vocals is not None:
        gap = loudness(original_vocals, sr)[0] - inst_lufs
    else:
        gap = -4.0  # pop vocals usually sit ~4 LU under their music's loudness
    voc_lufs, _ = loudness(bus, sr)
    bus *= 10 ** ((inst_lufs + gap + vocal_lift_db - voc_lufs) / 20)
    out = instrumental + bus
    # loudness to target in two passes (measure, then apply linearly), then a true-peak limiter as a guard
    lufs, _ = loudness(out, sr)
    out = out * 10 ** ((target_lufs - lufs) / 20)
    out = true_peak_limit(out, sr, true_peak)
    return out.astype(np.float32)


# ---------------------------------------------------------------------------------------------- the whole song

PACK_VERSION = 2
KEPT_LINE = ('n', 'start', 'end', 'n_words', 'kind', 'p')  # all a pack keeps of a line: never its words


def pack_lines(lines, parts):
    """The lines as a pack keeps them: [{'n', 'start', 'end', 'n_words', 'kind', 'p'}] (n from 0, in time order),
    and nothing else: the words Whisper heard are dropped here."""
    kind = {i: p['kind'] for p in parts for i in p['lines']}
    out = []
    for i, ln in enumerate(lines):
        out.append({'n': i, 'start': float(ln['start']), 'end': float(ln['end']),
                    'n_words': len(ln.get('words') or []), 'kind': kind.get(i, 'verse'), 'p': ln.get('p')})
    return out


def lines_of(pack):
    """The pack's lines in the shape share_lines() reads (no words: they were never kept)."""
    return [dict(ln, words=[]) for ln in pack['lines']]


def prepare(song, out_dir, model, engine='spleeter', chorus_info=None, cache_dir='models', lock=None,
            language=None, stems=None, beats_info=None, log=None):
    """A song made ready to sing (once; kept in the private dataset next to the song): its stems
    (vocals.flac, instrumental.flac), and sing.json with the song's lines (times, word counts and kinds only),
    parts, sung regions, beats and chorus. The words Whisper hears are used to find the lines and the choruses,
    then dropped: none is written anywhere. stems: {'vocals', 'instrumental'} already made (to reuse).
    engine: 'spleeter' (quick) or 'roformer' (best). Returns the pack."""
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    if stems:
        for k in ('vocals', 'instrumental'):
            dst = os.path.join(out_dir, k + '.flac')
            if os.path.abspath(stems[k]) != os.path.abspath(dst):
                save(dst + '.part.flac', load(stems[k]))
                os.replace(dst + '.part.flac', dst)
    else:
        separate(song, out_dir, engine=engine, cache_dir=cache_dir, lock=lock)
    t1 = time.time()
    vpath = os.path.join(out_dir, 'vocals.flac')
    voc = load(vpath, mono=True)
    heard = sung_words(vpath, model, language=language, lock=lock)
    raw = sung_lines(heard['words'], voc)
    duration = len(voc) / SR
    parts = song_parts(raw, duration, chorus_start=(chorus_info or {}).get('start'), language=heard['language'])
    lines = pack_lines(raw, parts)
    language = heard['language']
    del heard, raw  # (the words go here: they are never stored)
    info = beats_info or {}
    beat_times = [round(float(b), 3) for b in (info.get('beats') if info else [])]
    pack = {'version': PACK_VERSION, 'engine': engine, 'split': 'best' if engine == 'roformer' else 'quick',
            'duration': round(duration, 2), 'language': language, 'chorus': chorus_info or None,
            'regions': [[a, b] for a, b in sung_regions(voc)], 'lines': lines,
            'parts': [dict({'kind': p['kind'], 'start': round(float(p['start']), 2), 'end': round(float(p['end']), 2),
                            'lines': [int(i) for i in p['lines']]}, **({'n': int(p['n'])} if 'n' in p else {}))
                      for p in parts],
            'bpm': round(float(info['bpm']), 1) if info.get('bpm') else None, 'beats': beat_times,
            'stems': {'vocals': 'vocals.flac', 'music': 'instrumental.flac'},
            'seconds': {'split': round(t1 - t0, 1), 'lines': round(time.time() - t1, 1)}}
    write_pack(out_dir, pack)
    return pack


def write_pack(out_dir, pack):
    """sing.json, written whole (never half a file), checked to hold no words."""
    assert_no_words(pack)
    path = os.path.join(out_dir, 'sing.json')
    with open(path + '.part', 'w') as f:
        json.dump(pack, f, ensure_ascii=False)
    os.replace(path + '.part', path)
    return path


WORDY = {'text', 'words', 'word', 'w', 'lyrics', 'transcript'}


def assert_no_words(obj, where='pack'):
    """Raises if anything that could hold the song's words is in obj (a key named like it, at any depth)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in WORDY:
                raise ValueError(f'{where} holds {k!r}: the words of a song are never kept')
            assert_no_words(v, f'{where}.{k}')
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            assert_no_words(v, f'{where}[{i}]')


def read_pack(pack_dir):
    with open(os.path.join(pack_dir, 'sing.json')) as f:
        return json.load(f)


def spans_for(pack, n_animals, rule='alternate', choices=None, start=0.0, end=None):
    """Who sings what, on the song's clock: share_lines over the pack's lines between start and end."""
    end = pack['duration'] if end is None else end
    lines = lines_of(pack)
    inside = [i for i, ln in enumerate(lines) if ln['end'] > start and ln['start'] < end]
    index = {i: k for k, i in enumerate(inside)}
    sub = [dict(lines[i], start=max(lines[i]['start'], start), end=min(lines[i]['end'], end)) for i in inside]
    parts = [dict(p, lines=[index[i] for i in p['lines'] if i in index]) for p in pack['parts']]
    picks = {index[i]: v for i, v in (choices or {}).items() if i in index}
    names = ['a'] * max(1, n_animals)
    spans = share_lines(sub, parts, names, rule if n_animals > 1 else 'solo', choices=picks)
    for s in spans:
        s['line'] = inside[s['line']]
    return spans


def mouth_track(vocals_path, spans, who, start, seconds, sr=16000):
    """One animal's lip-sync input for [start, start + seconds] of the song: the ORIGINAL separated vocal, silent
    where that animal doesn't sing (its 0..1 envelope), as 16 kHz mono float32 (for wav2vec / Whisper engines)."""
    voc = load(vocals_path, max(0.0, start), seconds, sr=SR, mono=True)
    pad = int(round(max(0.0, -start) * SR))
    voc = np.pad(voc, (pad, 0))[:int(round(seconds * SR))]
    voc = np.pad(voc, (0, max(0, int(round(seconds * SR)) - len(voc))))
    local = [dict(s, start=s['start'] - start, end=s['end'] - start) for s in spans
             if who in s['who'] and s['end'] > start and s['start'] < start + seconds]
    for s in local:
        s['who'] = [0]
    env = part_envelopes(local, 1, len(voc))[0]
    return resample(voc * env, SR, sr) if sr != SR else voc * env


def render_song(song_path, pack_dir, start, seconds, voices, animals, spans, lead=0.0, tail=0.0, target_lufs=-14.0):
    """The finished audio of one video: the song from `start - lead` for `lead + seconds + tail` seconds (the
    Real -> AI start plays the song before the stage; the ending keeps it going under the follow card, fading),
    stereo float32 at -14 LUFS. voices: one choice per singer (VOICE_CHOICES); all 'original' -> the original
    recording itself (best quality), else each singer's lines in its voice over the music stem (the music bed stays
    untouched; voices move only by whole octaves, so the song stays the song)."""
    t0 = start - lead
    total = lead + seconds + tail
    presets = [voice_preset(v, a) for v, a in zip(voices, animals)]

    def cut(path):
        x = load(path, max(0.0, t0), total + (min(0.0, t0)))
        x = np.pad(x, ((int(round(max(0.0, -t0) * SR)), 0), (0, 0)))
        n = int(round(total * SR))
        return np.pad(x, ((0, max(0, n - len(x))), (0, 0)))[:n]
    if all(p == 'original' for p in presets) or pack_dir is None:
        out = master(cut(song_path), target_lufs=target_lufs, fade_out=max(0.02, tail))
        return out
    pack = read_pack(pack_dir)
    voc = cut(os.path.join(pack_dir, pack['stems']['vocals']))
    inst = cut(os.path.join(pack_dir, pack['stems']['music']))
    local = [dict(s, start=s['start'] - t0, end=s['end'] - t0) for s in spans if s['end'] > t0 and s['start'] < t0 + total]
    n = len(animals)
    env = part_envelopes(local, n, len(voc))
    gain = part_gains(local, n, len(voc))
    voiced = []
    for k in range(n):
        track = voc * env[k][:, None]
        if presets[k] == 'original':
            voiced.append(track * gain[k][:, None])
        else:
            voiced.append(animal_voice(track, presets[k], active=env[k]) * gain[k][:, None])
    out = mix(inst, voiced, original_vocals=voc, target_lufs=target_lufs)
    return fades(out, SR, 0.02, max(0.02, tail))
