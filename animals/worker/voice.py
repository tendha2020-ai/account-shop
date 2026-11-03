# voice.py: the talking pet. The animal says the video's captions in a funny voice, over the music.
#
# Kokoro-82M (Apache-2.0; its int8 ONNX file, 92 MB) runs on onnxruntime, about 1 s per caption on the free
# Space's 2 vCPU. Text becomes phonemes with misaki (Apache-2.0, Kokoro's own) and spaCy (MIT); words its
# dictionary doesn't know (pet names, slang) go through g2p_en's tiny letters-to-sounds network (Apache-2.0,
# 3 MB, plain numpy). No GPL code, so the public Space image stays clean.
#
# The worker runs fine without any of this: the packages and the model are installed by Dockerfile steps that
# may fail without failing the build, they are imported only when needed, and check() says whether the voice
# really works here (the page offers it only then). The model loads on first use (~5 s, ~550 MB RAM).
import hashlib
import importlib
import json
import logging
import os
import re
import subprocess
import threading
import wave
from pathlib import Path

import numpy as np

log = logging.getLogger('antics')

REPO, REV = 'onnx-community/Kokoro-82M-v1.0-ONNX', '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
MODEL = 'onnx/model_quantized.onnx'  # int8: fastest on CPU (fp16 gives silent/NaN audio on CPU, q8f16 crashes)
SPACY_MODEL = 'en_core_web_sm'  # misaki's English tagger (installed by the Dockerfile, never downloaded here)
SR, OUT_SR = 24000, 44100  # Kokoro's rate, the video's
# style -> (Kokoro voice, Kokoro speed, pitch x, overall speed x). Pitch moves the formants too: chipmunk / giant.
STYLES = {
    'squeaky': ('bm_george', 0.9, 1.6, 1.1),    # small pets: a posh chipmunk (+8 semitones)
    'deep': ('am_fenrir', 0.95, 0.78, 0.95),    # big animals (-4 semitones)
    'narrator': ('bm_george', 0.9, 0.94, 1.0),  # nature-documentary voice-over
}
VOICES = sorted({s[0] for s in STYLES.values()})
FILES = [MODEL, 'tokenizer.json'] + [f'voices/{v}.bin' for v in VOICES]  # (the Dockerfile bakes these in)
CHOICES = ('off', 'auto', *STYLES)
BIG = {'bear', 'panda', 'hippo', 'elephant', 'cow', 'horse', 'donkey', 'crocodile', 'kangaroo', 'llama', 'sloth',
       'capybara', 'pig', 'goat', 'sheep', 'seal'}
TEXT_OK = set('’‘“”…–—•')

# Fitting a line into its caption's time
MAX_RUSH = 1.35  # a long line may be sped up this much; past that it's cut (with a short fade)
MIN_ROOM = 0.6   # less time than this: no line
LEVEL = 0.71     # each stereo channel (the mono line at -3 dB, like ffmpeg's own mono-to-stereo)

_lock = threading.Lock()  # one line at a time: spaCy isn't thread-safe, and two would fight over the 2 CPUs
_m = {}


def style_for(choice, animal):
    """'auto' picks by animal: big animals get the deep voice, everyone else squeaks."""
    if choice in STYLES:
        return choice
    return 'deep' if set((animal or '').lower().split()) & BIG else 'squeaky'  # 'brown bear', 'baby hippo'


def speakable(text):
    """The caption as the pet says it: no emoji or hashtags, meme spellings made sayable."""
    t = ''.join(ch for ch in (text or '') if ord(ch) < 0x2000 or ch in TEXT_OK)  # like worker.plain_text
    t = re.sub(r'#\w+', ' ', t)
    t = re.sub(r'\b(\d+)\s*/\s*(\d+)\b', r'\1 out of \2', t)                    # 10/10 -> 10 out of 10
    t = re.sub(r'\b(\d{1,2})\s*([ap])\.?m\.?\b', lambda m: f'{m[1]} {m[2].upper()}M', t, flags=re.I)  # 3am -> 3 AM
    t = re.sub(r'\b[A-Z]{4,}\b', lambda m: m[0].lower(), t)                     # GOOOAL -> goooal (AI, OK, 4K stay)
    t = re.sub(r'([A-Za-z])\1{2,}', r'\1', t)                                   # Taxiiiii -> Taxi, gooo -> go
    t = re.sub(r'[()\[\]{}*_~^|<>]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


# ---------- Does it work here? ----------

_state = {'ready': None, 'why': 'not checked yet'}
_checked = threading.Event()
_guard = threading.Lock()
_thread = None


def _files(download=False):
    """The model's files on disk, {name: path}. Missing ones are downloaded only when download is True."""
    from huggingface_hub import hf_hub_download
    out = {}
    for name in FILES:
        try:
            out[name] = hf_hub_download(REPO, name, revision=REV, local_files_only=True)
        except Exception:
            if not download:
                raise
            out[name] = hf_hub_download(REPO, name, revision=REV)
    return out


def check(download=True):
    """Whether the pet voice works here: its packages import, spaCy's English model is installed (misaki would
    try to download it otherwise) and the voice model is on disk (baked into the image; fetched now if that
    step failed and downloads are allowed). Never raises; the answer is kept for ready()."""
    try:
        for name in ('onnxruntime', 'misaki.en'):  # (misaki.en brings spaCy and num2words)
            importlib.import_module(name)
        import spacy.util
        if not spacy.util.is_package(SPACY_MODEL):
            raise RuntimeError(f'{SPACY_MODEL} is not installed')
        _files(download)
        ok, why = True, ''
    except Exception as e:  # (also a broken install: ImportError, OSError, ...)
        ok, why = False, f'{type(e).__name__}: {e}'[:300]
    _state.update(ready=ok, why=why)
    _checked.set()
    if ok:
        log.info('pet voice: ready')
    else:
        log.warning('pet voice: not available (%s)', why)
    return ok


def start_check():
    """Runs check() once, in the background, so the worker starts at once whatever is installed."""
    global _thread
    with _guard:
        if _thread is None:
            _thread = threading.Thread(target=check, daemon=True, name='voice-check')
            _thread.start()


def ready(wait=0.0):
    """True when check() found the voice working (waits up to `wait` seconds for it to finish)."""
    start_check()
    _checked.wait(wait)
    return bool(_state['ready'])


def why():
    return _state['why']


def broken(e):
    """Using the voice failed after all (e.g. a broken model file): stop offering it until the next start."""
    _state.update(ready=False, why=f'{type(e).__name__}: {e}'[:300])


# ---------- Words the dictionary doesn't know ----------
# g2p_en's network (encoder/decoder GRU) turns letters into ARPAbet; mapped here to Kokoro's phonemes.

OOV_WEIGHTS = Path(__file__).with_name('oov_g2p.npz')  # put there at build time from the g2p_en 2.1.0 wheel
GRAPHEMES = ['<pad>', '<unk>', '</s>'] + list('abcdefghijklmnopqrstuvwxyz')
ARPABET = ['<pad>', '<unk>', '<s>', '</s>'] + [
    'AA0', 'AA1', 'AA2', 'AE0', 'AE1', 'AE2', 'AH0', 'AH1', 'AH2', 'AO0', 'AO1', 'AO2', 'AW0', 'AW1', 'AW2', 'AY0',
    'AY1', 'AY2', 'B', 'CH', 'D', 'DH', 'EH0', 'EH1', 'EH2', 'ER0', 'ER1', 'ER2', 'EY0', 'EY1', 'EY2', 'F', 'G', 'HH',
    'IH0', 'IH1', 'IH2', 'IY0', 'IY1', 'IY2', 'JH', 'K', 'L', 'M', 'N', 'NG', 'OW0', 'OW1', 'OW2', 'OY0', 'OY1', 'OY2',
    'P', 'R', 'S', 'SH', 'T', 'TH', 'UH0', 'UH1', 'UH2', 'UW', 'UW0', 'UW1', 'UW2', 'V', 'W', 'Y', 'Z', 'ZH']
VOWELS = {'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'W', 'AY': 'I', 'EH': 'ɛ', 'ER': 'ɜɹ', 'EY': 'A',
          'IH': 'ɪ', 'IY': 'i', 'OW': 'O', 'OY': 'Y', 'UH': 'ʊ', 'UW': 'u'}  # A I O W Y: misaki's diphthongs
WEAK = {'AH': 'ə', 'ER': 'əɹ'}
CONSONANTS = {'B': 'b', 'CH': 'ʧ', 'D': 'd', 'DH': 'ð', 'F': 'f', 'G': 'ɡ', 'HH': 'h', 'JH': 'ʤ', 'K': 'k', 'L': 'l',
              'M': 'm', 'N': 'n', 'NG': 'ŋ', 'P': 'p', 'R': 'ɹ', 'S': 's', 'SH': 'ʃ', 'T': 't', 'TH': 'θ', 'V': 'v',
              'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'}


def _gru(x, h, w_ih, w_hh, b_ih, b_hh):
    a, b = x @ w_ih.T + b_ih, h @ w_hh.T + b_hh
    k = a.shape[-1] // 3
    r, z = np.split(1 / (1 + np.exp(-(a[:, :2 * k] + b[:, :2 * k]))), 2, -1)
    return (1 - z) * np.tanh(a[:, 2 * k:] + r * b[:, 2 * k:]) + z * h


def guess_phonemes(word):
    """Kokoro phonemes for a word made of letters, e.g. 'Ronaldo' -> 'ɹOnˈɑldO'. '' if it can't."""
    w = _m.get('oov')
    letters = [GRAPHEMES.index(c) for c in word.lower() if 'a' <= c <= 'z']
    if w is None or not letters:
        return ''
    h = np.zeros((1, w['enc_w_hh'].shape[1]), np.float32)
    for i in letters + [2]:
        h = _gru(w['enc_emb'][[i]], h, w['enc_w_ih'], w['enc_w_hh'], w['enc_b_ih'], w['enc_b_hh'])
    out, prev = [], 2
    for _ in range(20):
        h = _gru(w['dec_emb'][[prev]], h, w['dec_w_ih'], w['dec_w_hh'], w['dec_b_ih'], w['dec_b_hh'])
        prev = int(np.argmax(h @ w['fc_w'].T + w['fc_b']))
        if prev == 3:
            break
        p = ARPABET[prev]
        base, stress = p.rstrip('012'), p[-1] if p[-1] in '012' else ''
        if base in CONSONANTS:
            out.append(CONSONANTS[base])
        elif base in VOWELS:
            out.append({'1': 'ˈ', '2': 'ˌ'}.get(stress, '') + (WEAK.get(base, VOWELS[base]) if stress == '0' else VOWELS[base]))
    return ''.join(out)


def _fallback(token):  # misaki's hook for unknown words: (phonemes, rating)
    ph = guess_phonemes(token.text)
    return (ph, 1) if ph else (None, None)


# ---------- Speaking ----------

def _load():
    if not _m:
        try:
            _m.update(_loaded())
        except Exception as e:  # it can't speak here after all (e.g. a broken model file)
            broken(e)
            raise
    return _m


def _loaded():
    """Everything the voice needs, loaded: the model, its words-to-sounds tables and the voices."""
    import onnxruntime as ort
    import spacy.util
    from misaki import en
    if not spacy.util.is_package(SPACY_MODEL):  # (misaki would start a download)
        raise RuntimeError(f'{SPACY_MODEL} is not installed')
    files = _files()  # baked into the image (check() fetched them if that failed)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2  # the Space's 2 vCPU (unset, onnxruntime sizes and pins threads to the host)
    opts.inter_op_num_threads = 1
    with open(files['tokenizer.json'], encoding='utf-8') as f:
        vocab = json.load(f)['model']['vocab']
    loaded = dict(session=ort.InferenceSession(files[MODEL], opts, providers=['CPUExecutionProvider']), vocab=vocab,
                  g2p={'a': en.G2P(trf=False, british=False, fallback=_fallback, unk=''),
                       'b': en.G2P(trf=False, british=True, fallback=_fallback, unk='')},
                  voices={v: np.fromfile(files[f'voices/{v}.bin'], dtype=np.float32).reshape(-1, 1, 256)
                          for v in VOICES})
    try:
        loaded['oov'] = dict(np.load(OOV_WEIGHTS))
    except OSError:
        log.warning('pet voice: no %s, unknown words will be skipped', OOV_WEIGHTS.name)
    return loaded  # (kept all at once: a failed load leaves nothing half made)


def _speak(text, style, out):
    """Says `text` into `out` (mono 44.1 kHz 16-bit WAV, silence trimmed, levelled to about -15 dBFS).
    Returns False when there was nothing to say."""
    voice, speed, pitch, tempo = STYLES[style]
    with _lock:
        m = _load()
        phonemes, _ = m['g2p'][voice[0]](text)
        pack = m['voices'][voice]
        ids = [m['vocab'][p] for p in phonemes if p in m['vocab']][:min(510, len(pack) - 1)]
        if not ids:
            return False
        audio = m['session'].run(None, {'input_ids': np.array([[0, *ids, 0]], dtype=np.int64),
                                        'style': pack[len(ids)],
                                        'speed': np.array([speed], dtype=np.float32)})[0].reshape(-1)
    audio = np.nan_to_num(np.asarray(audio, np.float32))
    loud = np.flatnonzero(np.abs(audio) > 0.02)
    if not len(loud):
        return False
    audio = audio[max(0, loud[0] - int(0.03 * SR)):loud[-1] + int(0.08 * SR)]  # Kokoro pads ~0.25 s / ~0.5 s
    rms = np.sqrt(np.mean(audio[np.abs(audio) > 0.02] ** 2))
    audio = audio * min(0.18 / max(rms, 1e-6), 0.95 / max(np.abs(audio).max(), 1e-6))  # ~-15 dBFS, peaks < -0.5 dB
    chain = f'asetrate={SR * pitch:.0f},aresample={SR},atempo={tempo / pitch:.4f},' if (pitch, tempo) != (1, 1) else ''
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
                    '-af', chain + f'aresample={OUT_SR}', '-c:a', 'pcm_s16le', str(out)],
                   input=audio.tobytes(), check=True, capture_output=True, timeout=120)
    return True


def _read(path):
    with wave.open(str(path), 'rb') as w:
        if w.getframerate() != OUT_SR or w.getsampwidth() != 2:
            raise RuntimeError(f'{Path(path).name} is not a {OUT_SR} Hz 16-bit WAV')
        data = np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(np.float32) / 32768
        return data.reshape(-1, w.getnchannels()).mean(axis=1)


def _seconds(path):
    with wave.open(str(path), 'rb') as w:
        return w.getnframes() / w.getframerate()


def line(text, style, room, folder, busy=None):
    """The pet's line for one caption, fitted to `room` seconds: (WAV, seconds, rush, the WAV as said), or None
    when there is nothing to say. Lines are kept in the job's folder (voice_<key>.wav), so a re-cut says them again only
    when the words or the voice changed. A line longer than `room` is sped up, at most MAX_RUSH times.
    busy() is called before the model has to speak (the first time takes a few seconds)."""
    text = speakable(text)
    if not re.search(r'[A-Za-z0-9]', text):
        return None
    key = hashlib.sha1(f'{REV}|{style}|{text}'.encode()).hexdigest()[:12]
    natural = Path(folder) / f'voice_{key}.wav'
    if not natural.exists():
        if busy:
            busy()
        part = natural.with_name(f'voice_{key}.part.wav')
        if not _speak(text, style, part):
            part.unlink(missing_ok=True)
            return None
        os.replace(part, natural)
    secs = _seconds(natural)
    rush = min(MAX_RUSH, max(1.0, secs / max(room, 1e-3)))
    if rush < 1.01:
        return natural, secs, 1.0, natural
    rushed = natural.with_name(f'voice_{key}_x{rush:.2f}.wav')
    if not rushed.exists():
        part = rushed.with_name(f'{rushed.stem}.part.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(natural), '-af', f'atempo={rush:.2f}',
                        '-ar', str(OUT_SR), '-c:a', 'pcm_s16le', str(part)], check=True, capture_output=True, timeout=60)
        os.replace(part, rushed)
    return rushed, _seconds(rushed), rush, natural


def track(windows, style, folder, seconds, path, busy=None):
    """The voice track of a cut: one WAV as long as the video (`seconds`, 44.1 kHz stereo) with each window's
    line in it. windows: [(text, start, end)] in video seconds; the line starts at `start` and is over by `end`
    (sped up if it must be, else cut with a short fade). Returns the lines placed, [{'text', 'at', 'end',
    'rush', 'cut'}]; the WAV is written only when there is something to say. Lines no longer used are deleted."""
    folder = Path(folder)
    placed, pieces, keep = [], [], set()
    for text, start, end in windows:
        room = min(end, seconds) - start
        if room < MIN_ROOM:
            continue
        got = line(text, style, room, folder, busy)
        if not got:
            continue
        wav, _, rush, said = got
        keep |= {wav.name, said.name}
        data = _read(wav)
        n = min(len(data), int(room * OUT_SR))
        cut = n < len(data)
        data = data[:n].copy()
        if cut:  # a short fade instead of a click
            f = min(n, int(0.1 * OUT_SR))
            data[n - f:] *= np.linspace(1, 0, f, dtype=np.float32)
        at = int(round(start * OUT_SR))
        pieces.append((at, data))
        placed.append({'text': speakable(text), 'at': round(at / OUT_SR, 3), 'end': round((at + n) / OUT_SR, 3),
                       'rush': round(rush, 3), 'cut': cut})
    for old in folder.glob('voice_*.wav'):  # earlier words or voices
        if old.name not in keep:
            old.unlink(missing_ok=True)
    if not placed:
        return []
    mono = np.zeros(int(np.ceil(seconds * OUT_SR)), np.float32)
    for at, data in pieces:
        b = min(len(mono), at + len(data))
        mono[at:b] += data[:b - at]
    pcm = (np.clip(mono * LEVEL, -1, 1) * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(OUT_SR)
        w.writeframes(np.repeat(pcm, 2).tobytes())  # the same in left and right
    return placed


def duck_filter(lines, depth, down=0.12, up=0.3):
    """ffmpeg filters that lower a sound by `depth` (0.7: to 30 %) while the pet talks: down over `down` seconds
    before each line, back up over `up` seconds after it. Small audio frames, so the gain moves in fine steps
    (no zipper noise on the ramps)."""
    terms = [f"clip((t-{ln['at'] - down:.3f})/{down},0,1)*clip(({ln['end'] + up:.3f}-t)/{up},0,1)" for ln in lines]
    inside = terms[0]
    for term in terms[1:]:
        inside = f'max({inside},{term})'
    return f"asetnsamples=n=256:p=0,volume='1-{depth:.2f}*{inside}':eval=frame"
