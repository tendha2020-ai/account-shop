# sing.py: "Sing" videos for the Animal Antics worker (v14): one or two animals sing a song, mouth, head and body
# moving with the singing, in sharp stage shots cut like a music video.
#
# The owner (or a friend) picks 1-2 singers (their own video or photo, a free clip, a link, or "Pick an animal"),
# a song from My songs, a part (the meme part, the chorus, the whole song, or their own range), a stage look and
# each singer's voice. The worker:
#  1. prepares the song once (CPU, sing_audio.py): the voice split from the music, the sung lines (times only: the
#     words are never kept), the parts; cached in the owner's private dataset next to the song (songs/<id>.sing/).
#  2. makes 2-4 stage pictures of the singer(s) (close, medium, wide, the duet's two-shot) with Together's free
#     composer engines, then shows them for a quick check (it carries on by itself after 2 minutes).
#  3. plans the shots (plan_shots): windows of exactly the engine's length that start on line starts (no paid second
#     is padding), close / medium angles, a duet's lines to whoever sings them, the stretches with no singing as
#     free CPU cutaways.
#  4. sings each shot (sing_shot) on the owner's PC when its helper is on and can sing, else with the free lip-sync
#     Space the owner approved in the 5-second test (ENGINES). One shot at a time, each saved at once (every render
#     its own file): out of free GPU time, the job waits for the reset and carries on by itself the next day (or
#     the day after); a shot on the PC is handed over as a task and the job waits outside the worker's AI lane until
#     it is in (pc_hand / pc_watch), so other videos are made meanwhile. A job keeps the song's lines it was planned
#     with (freeze_lines): the shots' mouth tracks and the mix always agree on who sings which line.
#  5. joins them (join_sing) on the song's clock: hard cuts, 720x1280 at 30 fps (frames repeated on timestamps,
#     never a speed change), the title pill, @TENDHA2, Part n/N, the Real -> AI start and the Follow me ending, the
#     original song (or the animals' voices over the music stem) at -14 LUFS; video length = audio length to the
#     frame. Long parts become TikTok parts of 59 s of song or less, cut at line starts, plus the no-song cut.
#
# THE GPU RULE: every ZeroGPU call Sing makes (stage pictures, a painted singer, every lip-sync shot) goes through
# ONE door, gpu_run() (also named gpu_call, so the worker's guard scan sees it): with the v12.1 GPU guard (gpu.py)
# it is gpu.gpu_call() with the call's exact request, and gpu.wait_job() for the Space job; without gpu.py it makes
# NO call at all (QuotaError: fail closed). The guard reads the account's real quota before and after, never lets
# a call run past the free time, and stops everything if Hugging Face ever bills credits. Sing also keeps to its
# own share of the day (default 30 of the 40 PRO minutes; Settings).
#
# Copyright: the song, its stems and its pack live only in the owner's private dataset; no lyrics are stored,
# shown, served or burned in (the video only shows "♪ title · artist" for 3 s); voices move only by whole octaves
# and the music bed stays untouched, so TikTok can still match the song. Every Sing video is AI-made: the caption
# gets #aivideo and the Post screen asks for TikTok's AI label (LTX-2's and FLUX's terms ask for it too).
#
# worker.py calls this module through small hooks marked "(Sing)" and passes itself in as `w`, so this file never
# imports worker.py and can be tested on its own.

import copy
import json
import math
import os
import queue
import random
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import beats
import sing_audio as sa

VERSION = '14'
FPS = 30
OUT_W, OUT_H = 720, 1280
FONT = os.environ.get('ANTICS_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
log = None  # the worker's logger (start())
W = None  # the worker module (start())

# ---------- the lip-sync engines ----------
# Bookings read from each Space's own app.py on 2026-11-03 (wfG/plan_check): `request` is what one call books on the
# account's quota (the @spaces.GPU duration x2 on size='xlarge'); the guard lets a call go only when that much (plus
# its margin) is left. `spend` is the expected real cost (about 2x the real run time on xlarge) until the first
# measured call replaces it. `window`: the seconds of song one call sings (fixed-length engines render exactly
# that much; we never pad a paid second).
ENGINES = {
    'L1': {'id': 'meituan-longcat/LongCat-Video-Avatar-1.5-Demo', 'api': '/generate_avatar', 'name': 'LongCat',
           'model': 'LongCat-Video-Avatar 1.5', 'window': 5.0, 'fps': 25, 'booking': 240, 'size': 'xlarge',
           'request': 480, 'spend': 240, 'license': 'MIT', 'same': 'L2'},
    'L2': {'id': 'victor/LongCat-Video-Avatar-1.5', 'api': '/generate', 'name': 'LongCat',
           'model': 'LongCat-Video-Avatar 1.5', 'window': 5.0, 'fps': 25, 'booking': 240, 'size': 'xlarge',
           'request': 480, 'spend': 240, 'license': 'MIT weights (used through its public API)', 'same': 'L1'},
    'X': {'id': 'multimodalart/ltx2-audio-to-video', 'api': '/generate', 'name': 'LTX-2', 'model': 'LTX-2 audio-to-video',
          'window': 11.5, 'fit': True, 'fps': 24, 'booking': 85, 'size': 'xlarge', 'request': 170, 'spend': 135,
          'license': 'LTX-2 Community License (free under US$10M revenue; disclose machine-generated)'},
    'K': {'id': 'kandinskylab/Kandinsky-S2V-1.0-Demo', 'api': '/generate', 'name': 'Kandinsky', 'model': 'Kandinsky S2V',
          'window': 5.0, 'fps': 24, 'booking': 100, 'size': 'xlarge', 'request': 200, 'spend': 147, 'license': 'MIT'},
    'P': {'id': 'pc', 'api': None, 'name': 'your PC', 'model': 'InfiniteTalk (Wan 2.1, on your PC)', 'window': None,
          'fps': 25, 'booking': 0, 'size': None, 'request': 0, 'spend': 0, 'license': 'Apache-2.0'},
}
TEST_ORDER = ('L1', 'X', 'K', 'P')  # the 5-second test tries them in this order (L2 stands in when L1 is down)
ONLINE = ('L1', 'X', 'K')  # the engines a job can be "Online" with (L2 only ever as L1's same-model fallback)
SPACE_TIMEOUT = 900  # seconds one lip-sync call may take (then the guard's wait_job cancels it)
PICTURE_TIMEOUT = 600
NEG = 'low quality, worst quality, deformed, distorted, closed mouth, static, human mouth, human teeth, text'
# PC (InfiniteTalk on the owner's RTX card): 81-frame chunks at 25 fps, 72 new frames each after the first.
PC_FPS, PC_FIRST, PC_STEP = 25, 81, 72
PC_MINUTES = {'sharp': (6, 12), 'fast': (3, 6)}  # per chunk on an RTX 5060 8 GB (estimate until the PC has sung)
PC_SIZE = {'sharp': (480, 848), 'fast': (368, 656)}
PC_TASK_LIMIT = 30 * 60
PC_FIRST_LIMIT = 45 * 60  # a task's first part also loads ~20 GB of models from disk
PROGRESS_COMMIT = 600  # the PC's measurements go to the dataset at most this often (a whole song is ~69 parts)

# The stage pictures: Together's composer engines (FLUX 3 Image Klein, then FLUX.2 klein 4B), one picture a call.
# FLUX 3 Image Klein books its own get_duration() (720x1280, 16 steps, ~24 s for one reference) and FLUX.2 klein a
# fixed 85 s; neither names a size, and the request is counted x2 here (the worst case), so a picture never runs
# past the free time.
COMPOSE_FALLBACK_REQUEST = 170
IMAGE_SPACE, IMAGE_REQUEST = 'black-forest-labs/FLUX.1-schnell', 120  # a painted singer when Pollinations is down

# ---------- the song side ----------
KNOWN_SONGS = [{'name': 'Rauf & Faik - Детство', 'seconds': 188.41, 'meme': 49.13, 'bpm': 99.4}]  # facts only
KNOWN_ALSO = {'Rauf & Faik - Детство': ('detstvo',)}  # other spellings of a known song's title (in a file name)
PARTS = ('meme', 'chorus', 'whole', 'custom')
MEME_SECONDS, CHORUS_SECONDS = 15.0, 29.0
TEST_SECONDS = 5.0
POST_MAX = 59.0  # seconds of song in one TikTok post (TikTok mutes longer uses of a song)
LEAD = 1.6  # the Real -> AI start: real seconds with the song already playing
LEAD_MIN = 0.8
OUTRO = 1.5  # the Follow me ending (the song keeps going under it, fading out)
TITLE_SECONDS = 3.0
CUTAWAY_BELOW = 0.5  # a stretch with less singing than this is a free CPU cutaway
MERGE_GAP = 0.6  # lines closer than this make one sung stretch
SHOT_MAX = 8.0  # line-by-line shots (the PC): at most this long
SHOT_MIN = 2.0
PRE_ROLL = 0.3  # line-by-line shots get this much vocal before their start, so the mouth is moving at the cut
LOOKS = {
    'studio': 'Dark recording studio, a condenser microphone on a stand, soft key light from the front, warm rim light '
              'behind, shallow depth of field',
    'concert': 'On a concert stage with spotlights and light haze, the crowd only as soft blurred bokeh lights far '
               'behind',
    'karaoke': 'In a neon-lit karaoke bar with warm pink and blue light, a microphone on a stand',
    'rooftop': 'On a city rooftop at night under warm string lights, the skyline softly blurred behind',
    'own': 'In the same place as in the first image, with a microphone on a stand',
}
ANGLE_FRAMING = {
    'close': ("Front-facing portrait, the {animal}'s face large in the upper half of the picture, looking at the "
              'camera, mouth closed and relaxed and fully visible, the microphone on a stand just below its chin (it '
              'does not cover the mouth). Sitting upright like a singer, shoulders and front paws visible.'),
    'medium': ('Waist-up shot of the {animal} singing on its stage, upright like a singer, one front paw raised to the '
               'music, the microphone on a stand below its chin, its face front-facing with the mouth closed and '
               'visible, so its head and body movement show.'),
    'wide': ('Wide shot: the whole {animal} on the stage, standing upright at the microphone stand, lights around it, '
             'its face turned to the camera.'),
}
WHO_RULES = {'turns': 'turns', 'both': 'verse_chorus'}  # (the page's "Take turns" and "Verse by verse"; share())
TOGETHER_KINDS = ('chorus', 'hook')  # the song parts both singers sing on "Take turns" (the owner's default)
CAPTIONS = ("{song} but it's my {animal}", 'My {animal} when {song} comes on', '{Animal} covers {song}',
            'POV: your {animal} found the mic')
DUET_CAPTIONS = ('The duet nobody asked for', '{song}, the {a} and {b} version', 'Our {a} and {b} have a band now')
TAGS = '#singingpets #animalsinging #aivideo #fyp'
TEXT_OK = set('’‘“”…–—•♪')

lock = threading.RLock()  # the settings and the Sing ledger
prep_queue = queue.Queue()
prep_state = {'busy': None}  # the song being prepared now
_started = []


class PcWait(Exception):
    """A job made only on the owner's PC: it waits until the helper is on (it carries on by itself then).
    why: the job's sing_wait ('pc': it waits for the PC to be on; 'pc_singing': the PC is singing one of its shots
    right now, and the job comes back when that shot is in)."""

    def __init__(self, message, why='pc', wait=3600):
        super().__init__(message)
        self.wait_seconds = wait
        self.why = why


class PcBusy(PcWait):
    """The owner's PC is singing a shot of this job now. The job leaves the worker's AI lane meanwhile (a shot on
    the PC takes up to an hour), so other videos are made; the PC watchdog puts it back in line when the shot is in
    (or the PC failed or went quiet)."""

    def __init__(self, message, wait=3600):
        super().__init__(message, why='pc_singing', wait=wait)


class ShotFailed(Exception):
    """An engine gave nothing for this shot."""


# ---------- the ONE door for every ZeroGPU call ----------

def _guard():
    """The v12.1 GPU guard module (gpu.py), or None when this worker doesn't have it."""
    try:
        import gpu
    except Exception:
        return None
    return gpu if hasattr(gpu, 'gpu_call') and hasattr(gpu, 'wait_job') else None


_call = threading.local()  # the Sing call this thread is making in gpu_run (wait_job marks it submitted)


def gpu_run(engine, request, fn):
    """Runs fn() (one ZeroGPU call, its Space job handed to wait_job()) through the GPU guard, booked at `request`
    seconds (what the Space books for this input). Without the guard (gpu.py) it never calls: QuotaError, so the job
    waits instead of spending anything that can't be checked. Sing's own share of the day is checked first."""
    g = _guard()
    if g is None:
        q = W.QuotaError('Singing waits for the GPU guard (this worker has no gpu.py yet), so no AI call is made. '
                         'Try again in 6:00:00')
        q.reason = 'guard'
        raise q
    share_check(engine, request)
    ran, sent, ok = [], [], []

    def call():
        ran.append(time.time())  # (the guard let it go: from here the call may spend)
        _call.sent = sent  # (wait_job marks it: the job reached the Space)
        try:
            out = fn()
        finally:
            _call.sent = None
            mine = getattr(getattr(g, '_local', None), 'call', None)  # (the guard's own mark, for a job waited for
            if isinstance(mine, dict) and mine.get('submitted'):  # with its wait_job directly)
                sent.append(True)
        ok.append(True)
        return out
    def measured():  # the guard keeps the last measured spends per engine (a new list each time it measures one)
        got = (getattr(g, 'state', {}) or {}).get('spent', {}).get(engine)
        return got, list(got or [])
    before_obj, before = measured()
    try:
        return g.gpu_call(engine, request, call)
    except Exception as e:
        own = getattr(g, 'QuotaError', None)
        if own is not None and own is not W.QuotaError and isinstance(e, own):  # (a worker whose QuotaError isn't
            q = W.QuotaError(str(e))  # the guard's yet: the same wait, as the worker's own, so the job waits)
            q.wait_seconds, q.guard, q.reason = e.wait_seconds, getattr(e, 'guard', False), getattr(e, 'reason', 'quota')
            raise q from e
        raise
    finally:
        if ran:
            took = time.time() - ran[0]
            after_obj, after = measured()
            # (measured now: the list changed, or it is a new list with the same numbers, as five equal spends give)
            spend = after[-1] if after and (after != before or after_obj is not before_obj) else None
            record_spend(engine, request, spend, took, submitted=bool(sent), ok=bool(ok))


gpu_call = gpu_run  # (the same function: the guard scan of the worker looks for calls named gpu_call)


def wait_job(job, timeout):
    """Waits for a gradio_client job submitted inside gpu_run: the guard's own wait_job (it cancels a job that runs
    too long and keeps the lock until it is closed)."""
    g = _guard()
    if g is None:  # (never: fn only runs inside gpu_run, which needs the guard)
        raise W.QuotaError('Singing waits for the GPU guard (this worker has no gpu.py yet)')
    sent = getattr(_call, 'sent', None)
    if sent is not None:
        sent.append(True)  # (the Space has the job now: it may spend, so it counts)
    return g.wait_job(job, timeout)


def guard_view():
    """The guard's /health view (free time left today, resets_at, alert), or None without the guard."""
    g = _guard()
    if g is None:
        return None
    try:
        return g.view()
    except Exception as e:
        log.warning('the GPU guard view failed: %s', e)
        return None


# ---------- settings: Sing's share of the day, the engines' test results, the PC (sing_settings.json) ----------

DAY_BASE = 2400  # PRO: 40 min of ZeroGPU a day
SHARE_DEFAULT = 1800  # Sing may use 30 of them by default (the owner's decision); normal videos keep the rest
SETTINGS_FILE = 'sing_settings.json'


def fresh_settings():
    return {'v': 1, 'share': SHARE_DEFAULT, 'mix': True, 'pc_until': '07:30',
            'engines': {e: {'state': 'untested'} for e in TEST_ORDER},
            'ledger': {'window': None, 'spent': 0.0, 'calls': []},  # Sing's spend in the current quota window
            'pc': {'chunk_s': [], 'size': None, 'duet': False}}  # (duet: its helper said sing_duet: two-shot duets)


settings = fresh_settings()


def load_settings(text):
    got = json.loads(text)
    new = fresh_settings()
    if isinstance(got, dict):
        new['share'] = max(0, min(DAY_BASE, int(got.get('share') or SHARE_DEFAULT)))
        new['mix'] = bool(got.get('mix', True))
        new['pc_until'] = str(got.get('pc_until') or '07:30')[:5]
        for e, v in (got.get('engines') or {}).items():
            if e in new['engines'] and isinstance(v, dict):
                new['engines'][e] = {k: v[k] for k in ('state', 'wall', 'spend', 'size', 'animal', 'at', 'job')
                                     if k in v}
                if new['engines'][e].get('state') not in ('good', 'bad', 'untested'):
                    new['engines'][e]['state'] = 'untested'
                if isinstance(new['engines'][e].get('spend'), list):  # (an earlier worker kept 0 s for calls that
                    new['engines'][e]['spend'] = [x for x in new['engines'][e]['spend']  # never ran)
                                                  if isinstance(x, (int, float)) and x >= SPEND_FLOOR]
        if isinstance(got.get('ledger'), dict):
            new['ledger'].update({k: got['ledger'][k] for k in ('window', 'spent', 'calls') if k in got['ledger']})
        if isinstance(got.get('pc'), dict):
            new['pc'].update({k: got['pc'][k] for k in ('chunk_s', 'size', 'duet', 'peak_vram', 'peak_ram',
                                                        'utc_offset') if k in got['pc']})
    with lock:
        settings.clear()
        settings.update(new)


_committed = {'at': float('-inf')}


def save_settings(hub=True):
    """sing_settings.json here and in the private dataset (never over a copy that couldn't be read yet). hub=False:
    only here (the dataset gets it with the next save that commits)."""
    if W.is_unread(SETTINGS_FILE):
        return
    with lock:
        data = json.dumps(settings)
    path = W.DATA / SETTINGS_FILE
    path.write_text(data)
    if not W.hub or not hub:
        return
    _committed['at'] = time.monotonic()
    try:
        W.hub.upload_file(path_or_fileobj=str(path), path_in_repo=SETTINGS_FILE, repo_id=W.DATASET,
                          repo_type='dataset', commit_message='sing settings')
    except Exception as e:
        log.warning('saving the sing settings to the Hub failed: %s', e)


def engine_state(e):
    with lock:
        return (settings['engines'].get('L1' if e == 'L2' else e) or {}).get('state', 'untested')


def median(xs):
    xs = sorted(float(x) for x in xs or [] if x is not None)
    return round(xs[len(xs) // 2], 1) if xs else None


SPEND_FLOOR = 30.0  # quota seconds: a measured spend under this is no render (a call that failed before it ran, or
# a reading that didn't move): it is never an engine's cost, and no engine call is counted at less


def measured_spends(e):
    """The spends measured on the owner's account for this engine's calls that sang (none under SPEND_FLOOR)."""
    with lock:
        info = settings['engines'].get('L1' if e == 'L2' else e) or {}
        return [float(x) for x in info.get('spend') or [] if x is not None and float(x) >= SPEND_FLOOR]


def spend_of(e):
    """Quota seconds one call of this engine costs: the median measured on the owner's account, else the estimate
    (never under SPEND_FLOOR, so a time line always ends)."""
    got = median(measured_spends(e))
    return max(SPEND_FLOOR, got if got is not None else float(ENGINES[e]['spend'] or SPEND_FLOOR))


def _window():
    g = guard_view() or {}
    return g.get('resets_at')


LEDGER_CALLS = 300  # Sing's calls kept with their time and cost (a window holds far fewer: 2400 s at >= 20 s each)
WINDOW = 24 * 3600  # Hugging Face resets the quota 24 h after its first use


def _ledger_now():
    """Sing's ledger for the current quota window: what Sing's calls in it cost. The window is the guard's reading:
    one that ends later (resets_at in the future) began 24 h before it; one whose reset time is over (Hugging Face
    may keep saying the old time until the next use) left only the calls made since; with no reset time, the calls
    of the last 24 h count, none when the account has its whole day again. Calls from before are dropped."""
    led = settings['ledger']
    g = guard_view() or {}
    w = g.get('resets_at')
    now = time.time()
    full = g.get('left') is not None and g.get('base') is not None and float(g['left']) >= float(g['base']) - 1
    if w is not None and float(w) > now:
        start = float(w) - WINDOW
    elif w is not None:
        start = float(w)
    else:
        start = now if full else now - WINDOW
    calls = led.get('calls') or []
    if any(float(c.get('at') or 0) < start - 1 for c in calls):  # (some are from an earlier window)
        keep = [c for c in calls if float(c.get('at') or 0) >= start - 1]
        led.update(spent=round(sum(float(c.get('cost') or 0) for c in keep), 1), calls=keep)
    elif not calls and float(led.get('spent') or 0) and (w is None or float(w) <= now or
                                                         led.get('window') not in (None, w)):
        led['spent'] = 0.0  # (an earlier worker's total without its calls: only when its window is surely over)
    led['window'] = w
    return led


def share_left():
    with lock:
        return max(0.0, float(settings['share']) - float(_ledger_now()['spent']))


def share_check(engine, request):
    """Sing's own share of the day (the guard checks the whole account): a call whose expected spend doesn't fit in
    what is left of the share waits for the reset."""
    if engine in ENGINES:
        cost = spend_of(engine)
    else:  # (a picture: counted at its request)
        cost = float(request)
    with lock:
        left = float(settings['share']) - float(_ledger_now()['spent'])
    if cost > left + 1e-6:
        w = _window()
        wait = max(60.0, float(w) - time.time() + 60) if w else 6 * 3600
        h, m = int(wait // 3600), int(wait % 3600 // 60)
        raise W.QuotaError(f"Singing used its share of today's free GPU time ({settings['share'] // 60} min; "
                           f'{left:.0f}s left, {cost:.0f}s needed). Try again in {h}:{m:02d}:00')


def record_spend(engine, request, spend, took, submitted=True, ok=True):
    """What a call cost Sing's share and the engine's measurements. spend: what the guard measured (None: not
    measured); submitted: the job reached the Space; ok: it sang (returned a result).
    The share: a call that never reached the Space used no GPU (only what was measured, if anything); one that sang
    counts what was measured, but never less than the engine's usual cost when the reading didn't move; one that
    failed in the Space counts what was measured, else its request. The engine's own cost (the time line, the share
    check) only learns from calls that sang and measured at least SPEND_FLOOR."""
    key = 'L1' if engine == 'L2' else engine
    with lock:
        led = _ledger_now()
        measured = float(spend) if spend is not None else None
        if not submitted:
            cost = max(0.0, measured or 0.0)
        elif ok and key in settings['engines']:
            cost = measured if measured is not None and measured >= SPEND_FLOOR else \
                max(measured or 0.0, spend_of(engine)) if measured is not None else float(request)
        else:  # (a picture, or a call that failed in the Space)
            cost = measured if measured is not None else float(request)
        led['spent'] = round(float(led['spent']) + cost, 1)
        if cost:  # (a call that cost nothing isn't kept)
            led['calls'] = (led.get('calls') or [])[-(LEDGER_CALLS - 1):] + [{'engine': engine, 'cost': cost,
                                                                              'at': time.time()}]
        if key in settings['engines'] and ok and submitted and measured is not None and measured >= SPEND_FLOOR:
            info = settings['engines'][key]
            info['spend'] = (info.get('spend') or [])[-9:] + [round(measured, 1)]
            info['wall'] = (info.get('wall') or [])[-9:] + [round(took, 1)]
    if cost:
        threading.Thread(target=save_settings, daemon=True).start()


def gpu_view():
    """GET /gpu: the free time today (from the guard), Sing's share and spend, and every engine's state."""
    g = guard_view()
    with lock:
        led = _ledger_now()
        engines = {e: {'name': ENGINES[e]['name'], 'state': engine_state(e), 'request': ENGINES[e]['request'],
                       'spend_med': median(measured_spends(e)),
                       'wall_med': median((settings['engines'].get(e) or {}).get('wall')),
                       'spend_est': ENGINES[e]['spend'], 'measured': bool(measured_spends(e))}
                   for e in TEST_ORDER}
        out = {'guard': g is not None, 'sing_share': settings['share'], 'sing_spent': led['spent'],
               'sing_left': max(0.0, settings['share'] - led['spent']), 'engines': engines,
               'default': default_engine(), 'mix': settings['mix'], 'pc_until': settings['pc_until'],
               'pc_sing': pc_can_sing(), 'pc_chunk_med': median(settings['pc'].get('chunk_s'))}
    if g:
        out.update(base=g.get('base'), left=g.get('left'), resets_at=g.get('resets_at'), alert=g.get('alert'),
                   overquota_used=None, stopped=g.get('stopped'), readable=g.get('readable'), blind=g.get('blind'))
    else:
        out.update(base=None, left=None, resets_at=None, alert=None, overquota_used=None, stopped=False,
                   readable=False, blind='guard')
    return out


def default_engine():
    """The online engine Sing uses: the first approved one (the test's order), None before any is approved."""
    for e in ONLINE:
        if engine_state(e) == 'good':
            return e
    return None


def next_untested(pc_can=None, skip=()):
    """The engine the next 5-second test tries: the first untested one (the PC only when its helper can sing), not
    one in `skip` (the one being tested, the ones tried)."""
    can = pc_can_sing() if pc_can is None else pc_can
    for e in TEST_ORDER:
        if engine_state(e) == 'untested' and (e != 'P' or can) and e not in skip:
            return e
    return None


def set_engine(e, state, **info):
    key = 'L1' if e == 'L2' else e
    with lock:
        cur = settings['engines'].setdefault(key, {'state': 'untested'})
        cur.update(info, state=state, at=time.time())
    save_settings()


def change_settings(body):
    """POST /settings: sing_share (seconds, or a percentage 25/50/75/100 of the day), sing_engines {id: {state}},
    sing_mix (one video may mix the engines approved), sing_pc_until ('HH:MM')."""
    with lock:
        if body.get('sing_share') is not None:
            v = float(body['sing_share'])
            settings['share'] = int(round(DAY_BASE * v / 100)) if v <= 100 else int(max(0, min(DAY_BASE, v)))
        if isinstance(body.get('sing_engines'), dict):
            for e, v in body['sing_engines'].items():
                key = 'L1' if e == 'L2' else e
                state = v.get('state') if isinstance(v, dict) else v
                if key in settings['engines'] and state in ('good', 'bad', 'untested'):
                    settings['engines'][key]['state'] = state
        if body.get('sing_mix') is not None:
            settings['mix'] = bool(body['sing_mix'])
        if body.get('sing_pc_until'):
            m = re.fullmatch(r'([01]?\d|2[0-3]):([0-5]\d)', str(body['sing_pc_until']).strip())
            if not m:
                raise W.HTTPException(400, "sing_pc_until must be a time like '07:30'")
            settings['pc_until'] = f'{int(m[1]):02d}:{m[2]}'
    save_settings()
    return gpu_view()


# ---------- the song, prepared once (CPU, in the background; songs/<id>.sing/ in the private dataset) ----------
# The quick pass (Spleeter, then whisper-small per sung region) makes a song ready in a few minutes; the best pass
# (Kim's RoFormer, ~25 min on 2 vCPU, at low priority) replaces the stems and the lines afterwards. Shots already
# sung are kept; the mix and later shots use the new stems. The pack has no words: sing_audio drops them.

PACK_FILES = ('sing.json', 'vocals.flac', 'music.flac')
MODELS = os.environ.get('ANTICS_MODELS', os.path.expanduser('~/.cache/antics-models'))  # (the Spleeter model is in
# the image there; the RoFormer checkpoint downloads there on first use)
_words = {'model': None}


def words_model():
    """faster-whisper 'small' (MIT; base loops on songs), loaded once (None when it can't load: then the lines come
    from where the voice sings alone)."""
    if _words['model'] is None:
        try:
            from faster_whisper import WhisperModel
            _words['model'] = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=2)
        except Exception as e:
            log.warning('sing: no whisper-small (%s): lines from the voice alone', e)
            _words['model'] = False
    return _words['model'] or None


class _NoWords:
    """A stand-in Whisper that hears no words (the lines are then the sung stretches of the vocal stem)."""

    def transcribe(self, audio, **kw):
        info = type('Info', (), {'language': kw.get('language') or None})()
        return iter(()), info


_splits = {'at': float('-inf'), 'got': []}


def split_engines():
    """The splits this worker can make: ['spleeter', 'roformer'], the quick one first (looked up again every 10 min:
    /health asks often)."""
    if time.monotonic() - _splits['at'] > 600:
        _splits.update(at=time.monotonic(), got=[e for e in ('spleeter', 'roformer') if sa.split_ready(e)])
    return list(_splits['got'])


def _plain(text):
    return re.sub(r'\W+', '', str(text or '').lower().replace('ё', 'е'))


def known_song(seconds=None, name=None):
    """A song antics knows the facts of (KNOWN_SONGS): its name must match (its title, after ' - ', or another
    spelling of it, is in the name), and its length too (within 1 s) when the length is given. Never by the length
    alone: any other song of that length keeps the meme-part finder's own pick."""
    if not name:
        return None
    said = _plain(name)
    for k in KNOWN_SONGS:
        titles = {_plain(k['name']), _plain(k['name'].split(' - ')[-1])}
        titles |= {_plain(x) for x in KNOWN_ALSO.get(k['name'], ())}
        if not any(t and t in said for t in titles):
            continue
        if seconds is not None and abs(float(seconds) - k['seconds']) > 1.0:
            continue
        return k
    return None


def pack_dir(song_id, job=None):
    """The folder of a song's pack (fetched back from the dataset after a restart), or None when it isn't made.
    job: a friend's own uploaded song lives with that video (its folder's song.sing/)."""
    if job is not None and job.get('song_local'):
        d = W.job_dir(job['id']) / 'song.sing'
        return d if (d / 'sing.json').exists() else None
    d = W.DATA / 'songs' / f'{song_id}.sing'
    if (d / 'sing.json').exists() and all((d / n).exists() for n in PACK_FILES):
        return d
    with W.songs_lock:
        state = ((W.songs.get(song_id) or {}).get('sing') or {}).get('state')
    if state != 'ready' or not W.hub:
        return None
    from huggingface_hub import hf_hub_download
    try:
        d.mkdir(parents=True, exist_ok=True)
        for name in PACK_FILES:
            if not (d / name).exists():
                got = hf_hub_download(W.DATASET, f'songs/{song_id}.sing/{name}', repo_type='dataset', token=W.HF_TOKEN)
                shutil.copy(got, d / f'{name}.part')
                os.replace(d / f'{name}.part', d / name)
        return d
    except Exception as e:
        log.warning('sing: the pack of %s could not be fetched (%s): made again', song_id, e)
        with W.songs_lock:
            if song_id in W.songs:
                W.songs[song_id]['sing'] = {'state': 'none'}
        queue_prepare(song_id)
        return None


def pack_of(job):
    """(the pack, its folder) for a job: the song's stems, with the lines and parts the job was planned with (see
    job_pack), or (None, None) while the song isn't ready."""
    d = pack_dir(job.get('song_id'), job)
    return (job_pack(job, sa.read_pack(d)), d) if d else (None, None)


LINE_KEYS, PART_KEYS = ('n', 'start', 'end', 'kind', 'n_words', 'p'), ('kind', 'start', 'end', 'lines', 'n')


def freeze_lines(job, pack):
    """The song's lines and parts as they are when the job is first planned, kept with the job (times and kinds
    only, never words): the best split replaces a song's lines about half an hour after it is added, with a few
    lines more or less, so who sings which line could change under a duet already planned. Every later step of this
    job (re-plans, each shot's mouth tracks, the mix) uses these."""
    if job.get('plan_lines') or not pack:
        return
    got = {'split': pack.get('split'), 'lines': [{k: ln[k] for k in LINE_KEYS if k in ln} for ln in pack['lines']],
           'parts': [{k: p[k] for k in PART_KEYS if k in p} for p in pack['parts']]}
    sa.assert_no_words(got, 'the lines a job keeps')
    job['plan_lines'] = got


def job_pack(job, pack):
    """The pack as this job was planned with it: its own lines and parts (freeze_lines) over the song's current
    stems."""
    got = job.get('plan_lines') if isinstance(job, dict) else None
    if not pack or not isinstance(got, dict) or not got.get('lines'):
        return pack
    return dict(pack, lines=[dict(ln) for ln in got['lines']], parts=[dict(p) for p in got.get('parts') or []])


def song_state(song_id):
    with W.songs_lock:
        return dict((W.songs.get(song_id) or {}).get('sing') or {'state': 'none'})


def _set_state(song_id, **fields):
    with W.songs_lock:
        song = W.songs.get(song_id)
        if not song:
            return
        cur = dict(song.get('sing') or {})
        cur.update(fields, at=time.time())
        song['sing'] = cur
    W.save_songs()


def queue_prepare(song_id, engine=None, first=False):
    """Asks for a song's pack (quick, then best); repeated asks are harmless."""
    st = song_state(song_id)
    if engine is None and st.get('state') in ('ready', 'queued', 'preparing'):
        if st.get('state') == 'ready' and st.get('split') == 'quick' and 'roformer' in split_engines() \
                and st.get('best') in (None, 'none'):
            _set_state(song_id, best='queued')
            prep_queue.put((1, song_id, 'roformer'))
        return
    if not split_engines():
        _set_state(song_id, state='failed', error="This worker can't split a song's voice from its music yet. Update "
                                                   'your worker in Settings.')
        return
    if engine is None:
        _set_state(song_id, state='queued', error='')
    prep_queue.put((0 if first or engine is None else 1, song_id, engine or split_engines()[0]))


def prep_loop():
    """Prepares the songs one at a time: every quick pass before any best pass (a song first used waits only a few
    minutes); the best pass at low priority on 2 threads."""
    try:  # (a lower priority for this thread only, so the videos come first)
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
    except Exception:
        pass
    waiting = []
    while True:
        try:
            waiting.append(prep_queue.get(timeout=None if not waiting else 0.01))
            while True:
                waiting.append(prep_queue.get_nowait())
        except queue.Empty:
            pass
        waiting.sort(key=lambda x: x[0])
        prio, song_id, engine = waiting.pop(0)
        try:
            prepare_song(song_id, engine)
        except Exception as e:
            log.exception('sing: preparing %s (%s) failed', song_id, engine)
            if engine == 'roformer' and song_state(song_id).get('state') == 'ready':
                _set_state(song_id, best='failed', best_error=str(e)[:200])
            else:
                _set_state(song_id, state='failed', error=f"The song couldn't be made ready for singing: {str(e)[:160]}")
            wake_song(song_id)


def prepare_song(song_id, engine, out=None, song_path=None, chorus_info=None):
    """Makes (or remakes with the best split) a song's pack: songs/<id>.sing/{sing.json, vocals.flac, music.flac},
    here and in the private dataset. out/song_path: a friend's own song kept with one video (no My song)."""
    local = out is not None
    with W.songs_lock:
        song = dict(W.songs.get(song_id) or {})
    if not local and not song:
        return
    if not local and engine == 'roformer' and song_state(song_id).get('state') != 'ready':
        return  # (the quick pass first)
    prep_state['busy'] = song_id
    if not local:
        _set_state(song_id, **({'state': 'preparing'} if engine != 'roformer' else {'best': 'working'}))
    try:
        path = Path(song_path) if song_path else W.song_file(song_id)
        final = Path(out) if local else W.DATA / 'songs' / f'{song_id}.sing'
        work = final.with_name(final.name + '.part')
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        info = beats.analyse(path)
        if chorus_info is None:
            known = known_song(song.get('duration'), song.get('name'))
            start = song.get('start') if song.get('start') is not None else (known or {}).get('meme', 0.0)
            chorus_info = {'start': float(start or 0.0), 'seconds': float(song.get('seconds_hint') or MEME_SECONDS),
                           'bpm': round(float(info['bpm']), 1) if info else None}
        model = words_model() or _NoWords()  # (its own model: "Speak" keeps working meanwhile)
        pack = sa.prepare(str(path), str(work), model, engine=engine, chorus_info=chorus_info,
                          cache_dir=MODELS, lock=None, beats_info=info, log=log)
        os.replace(work / 'instrumental.flac', work / 'music.flac')
        pack['stems'] = {'vocals': 'vocals.flac', 'music': 'music.flac'}
        sa.write_pack(str(work), pack)
        shutil.rmtree(final, ignore_errors=True)
        os.replace(work, final)
        if local:
            return pack
        if W.hub:
            from huggingface_hub import CommitOperationAdd
            ops = [CommitOperationAdd(f'songs/{song_id}.sing/{n}', str(final / n)) for n in PACK_FILES]
            W.hub.create_commit(W.DATASET, ops, commit_message=f'song {song_id}: ready to sing ({pack["split"]})',
                                repo_type='dataset')
        _set_state(song_id, state='ready', split=pack['split'], error='', lines=len(pack['lines']),
                   duration=pack['duration'], **({'best': 'done'} if engine == 'roformer' else {}))
        log.info('sing: %s ready (%s split, %d lines, %.0f s split + %.0f s lines)', song_id, pack['split'],
                 len(pack['lines']), pack['seconds']['split'], pack['seconds']['lines'])
        wake_song(song_id)
        if engine != 'roformer' and 'roformer' in split_engines():
            queue_prepare(song_id)  # (the best pass, after every other song's quick one)
        return pack
    finally:
        prep_state['busy'] = None


def wake_song(song_id):
    """Sing jobs that waited for this song's pack go back in line."""
    for job in list(W.jobs.values()):
        if job.get('kind') == 'sing' and job.get('song_id') == song_id and job.get('status') == 'waiting' \
                and job.get('sing_wait') == 'song':
            W.update(job, status='queued', stage='In line…', sing_wait=None)
            W.enqueue(job)


def prepare_all():
    """At start-up: every My song without a pack is prepared (the known songs, Детство, first)."""
    with W.songs_lock:
        items = [(k, dict(v)) for k, v in W.songs.items()]
    todo = [(not known_song(v.get('duration'), v.get('name')), v.get('added') or 0, k) for k, v in items
            if (v.get('sing') or {}).get('state') not in ('ready',) or
            not ((v.get('sing') or {}).get('best') in ('done', 'failed') or 'roformer' not in split_engines())]
    for _, _, k in sorted(todo):
        st = song_state(k)
        if st.get('state') in ('queued', 'preparing'):  # (a restart in the middle of one)
            _set_state(k, state='none')
        if st.get('best') in ('queued', 'working'):  # (a restart while its best split was in line or being made:
            _set_state(k, best='none')  # it starts again)
        queue_prepare(k, first=True)


def delete_pack(song_id):
    shutil.rmtree(W.DATA / 'songs' / f'{song_id}.sing', ignore_errors=True)
    if W.hub:
        try:
            W.hub.delete_folder(f'songs/{song_id}.sing', repo_id=W.DATASET, repo_type='dataset')
        except Exception as e:
            log.info('sing: no pack of %s to delete in the dataset (%s)', song_id, e)


# ---------- the singers and their stage pictures ----------

SOURCES = ('upload', 'painted', 'link', 'library')
FILE_PIC = re.compile(r'p(\d)\.(?:jpe?g|png|webp)', re.I)


def clean_look(text):
    """The owner's "Its look" words for a prompt: plain lower-case words (<= 60 chars), names dropped (a capitalised
    word inside the text is taken for a name: never a real person's or a brand's name in a prompt)."""
    words = re.sub(r'[^\w ,\'-]+', ' ', str(text or ''), flags=re.U).split()
    keep = [x for i, x in enumerate(words) if not (i and x[:1].isupper() and not x.isupper())]
    out = re.sub(r'[^a-z0-9 ,\'-]+', '', ' '.join(keep).lower())
    return re.sub(r'\s+', ' ', out).strip(' ,')[:60]


def read_singers(text):
    """The singers the page sent (JSON, 1-2 entries, in order: left, right), checked, or a 400 with a plain reason."""
    bad = W.HTTPException
    try:
        raw = json.loads(text or '')
    except ValueError:
        raise bad(400, 'Could not read the singers. Pick them again.')
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list) or not raw or not all(isinstance(e, dict) for e in raw):
        raise bad(400, 'Pick who sings: your video or photo, a free clip, or an animal')
    if len(raw) > 2:
        raise bad(400, 'Up to 2 singers (a duet)')
    library = W.together.load_library() if W.together else {}
    out = []
    for i, e in enumerate(raw):
        src = {'surprise': 'painted', 'pick': 'painted'}.get(e.get('from'), e.get('from'))
        if src not in SOURCES:
            raise bad(400, f'Singer {i + 1}: pick a video or photo, a link, a free clip or an animal')
        s = {'from': src, 'animal': W.clean_animal(str(e.get('animal') or '')),
             'name': W.clean_name(str(e.get('name') or ''))[:20], 'look': clean_look(e.get('look')), 'pic': None,
             'label': '', 'credit': ''}
        W.together.set_real(s, None, i)
        if src == 'link':
            url = str(e.get('url') or '').strip()
            if not re.match(r'^https?://\S+$', url):
                raise bad(400, f"Singer {i + 1}: that link doesn't look right")
            s.update(url=url[:500], label='Link')
        elif src == 'library':
            clip = library.get(str(e.get('id') or ''))
            if not clip:
                raise bad(400, f"Singer {i + 1}: that free clip isn't in the list any more. Pick another one.")
            s.update(id=str(clip['id']), label='Free clip', credit=str(clip.get('credit') or '')[:300],
                     license=str(clip.get('license') or ''), page=str(clip.get('page') or ''),
                     animal=s['animal'] or W.clean_animal(str(clip.get('animal') or '')),
                     at=max(0.0, W.together._number(e.get('at'), W.together._number(clip.get('start'), 0.0))))
        elif src == 'upload':
            s.update(label='Your video', at=max(0.0, W.together._number(e.get('at'), 0.0)))
        else:
            if not s['animal']:
                raise bad(400, f'Singer {i + 1}: pick the animal to paint (a bear, a cat ...)')
            s.update(label='Painted')
        if e.get('real_at') is not None:
            s['sent_at'] = max(0.0, W.together._number(e['real_at'], 0.0))
        out.append(s)
    return out


def keep_singers(singers, uploads, folder, real_fps):
    """The uploaded singers' pictures and real clips (p{i}.jpg, v{i}.mp4 or f{i}_{nnn}.jpg, as Together)."""
    files = W.together.sort_files(uploads, len(singers))
    for i, s in enumerate(singers):
        if s['from'] in ('upload', 'library'):
            if not files[i]['pic']:
                what = 'free clip' if s['from'] == 'library' else 'video or photo'
                raise W.HTTPException(400, f'Singer {i + 1} has no picture. Pick its {what} again.')
            W.together.keep_upload(W, i, s, files[i], folder, real_fps)
        s.pop('sent_at', None)


def paint_prompt(s):
    look = f"{s['look']} " if s.get('look') else ''
    return (f"Photorealistic portrait photo of a {look}{s['animal']}, front-facing, sitting upright like a person, "
            'looking at the camera, mouth closed, sharp detailed fur, plain soft background, vertical, no text')


def pollinations(prompt, seed):
    """Pollinations' free text-to-image (no GPU time): a PIL picture, or None when it didn't answer."""
    try:
        res = W.requests.get(f'https://image.pollinations.ai/prompt/{W.requests.utils.quote(prompt)}',
                             params={'width': 576, 'height': 1024, 'nologo': 'true', 'seed': seed}, timeout=60)
        if res.ok and res.headers.get('content-type', '').startswith('image/'):
            from io import BytesIO
            img = Image.open(BytesIO(res.content))
            return img.crop((0, 0, img.width, int(img.height * 0.95)))  # (its small mark in the corner)
    except Exception as e:
        log.info('sing: Pollinations failed (%s): FLUX through the guard', e)
    return None


def paint_singer(s, path):
    """A painted singer ("Pick an animal"): Pollinations' free text-to-image first (no GPU), else FLUX.1-schnell on
    ZeroGPU, through the guard (gpu_run)."""
    prompt = paint_prompt(s)
    seed = random.randint(1, 10 ** 9)
    img = pollinations(prompt, seed)
    if img is not None:
        W.save_picture(img, path)
        return 'Pollinations'

    def paint():  # one ZeroGPU call: only through the guard (wait_job never leaves it running)
        from gradio_client import Client
        client = Client(IMAGE_SPACE, token=W.HF_TOKEN, verbose=False)
        return wait_job(client.submit(prompt=prompt, seed=seed, randomize_seed=False, width=576, height=1024,
                                      num_inference_steps=4, api_name='/infer'), PICTURE_TIMEOUT)
    try:
        out = gpu_call('FLUX.1-schnell', IMAGE_REQUEST, paint)
    except W.QuotaError:
        raise
    except Exception as e:
        _raise_for(str(e) or type(e).__name__)
        raise
    first = out[0]
    shutil.copy(first['path'] if isinstance(first, dict) else first, path)
    return 'FLUX.1-schnell'


def _raise_for(msg):
    """A Space's error as the worker's: QuotaError (free time), BusyError (no GPU free), a refused key."""
    if W.is_quota(msg):
        raise W.QuotaError(msg)
    if W.is_auth(msg):
        raise RuntimeError('The Hugging Face key was refused. Set up the worker again with a new key.')
    if W.is_busy(msg):
        raise W.BusyError(msg)


def gather(job):
    """The singers that aren't in yet: a link is downloaded (its sharpest moment + 6 s of real clip), a painted one
    painted. The ones got are kept even when a later one fails."""
    folder = W.job_dir(job['id'])
    for i, s in enumerate(job['singers']):
        if s.get('pic'):
            continue
        W.update(job, stage=f'Getting your singers… ({i + 1} of {len(job["singers"])})', progress=0.03)
        if s['from'] == 'link':
            W.together.fetch_link(job, W, folder, i, s)
        elif s['from'] == 'painted':
            paint_singer(s, folder / f'animal_{i}.jpg')
            s.update(pic=f'animal_{i}.jpg', label='Painted', gpu=True)
        else:
            raise RuntimeError(f"Singer {i + 1}'s picture is missing. Make the video again.")
        if not s.get('animal') or s['animal'] == 'animal':
            s['animal'] = 'animal'
        W.update(job, singers=job['singers'])
        W.save(job, [n for n in (s.get('pic'), s.get('real')) if n])


def song_title(name):
    """'Rauf & Faik - Детство' -> ('Детство', 'Rauf & Faik'): the title pill shows "♪ Детство · Rauf & Faik"."""
    name = re.sub(r'\s+', ' ', str(name or '')).strip()
    if ' - ' in name:
        artist, title = name.split(' - ', 1)
        return title.strip(), artist.strip()
    return name or 'My song', ''


def described(s):
    """The singer for a prompt: its look words and its animal ("big brown bear with a gold chain", not "... chain
    bear" when the look already names the animal)."""
    animal, look = s.get('animal') or 'animal', (s.get('look') or '').strip()
    if not look:
        return animal
    words = set(re.findall(r'[a-z]+', look.lower()))
    return look if animal.lower() in words or animal.lower().rstrip('s') in words else f'{look} {animal}'


def stage_prompt(angle, singers, look):
    """What the composer is asked for: the same animal (or both, for the two-shot) in the stage look, at the angle.
    Pet names never go in; the look words are plain words."""
    setting = LOOKS.get(look) or LOOKS['studio']
    keep = "Keep the animal's exact fur, colours, markings and face."
    tail = 'Vertical 9:16 photo, sharp detailed fur, photorealistic, no text, no watermark, no people.'
    if angle == 'two':
        a, b = singers[0], singers[1]
        wa, wb = described(a), described(b)
        return ' '.join([
            f'Put the {wa} from the first image on the left and the {wb} from the second image on the right, side by '
            'side, each fully in its own half of the picture with a small gap between them, each singing at its own '
            'microphone on a stand below its chin, both faces large and front-facing, mouths closed and fully '
            'visible.', f'{setting}.', "Keep each animal's exact fur, colours, markings and face.",
            'Vertical 9:16 photo, both animals large in the frame, sharp detailed fur, photorealistic, no text, no '
            'watermark, no people.'])
    who = singers[{'closeA': 0, 'closeB': 1, 'mediumA': 0, 'mediumB': 1}.get(angle, 0)]
    word = described(who)
    base = angle[:-1] if angle[-1:] in 'AB' and angle not in ANGLE_FRAMING else angle
    framing = ANGLE_FRAMING.get(base, ANGLE_FRAMING['close']).format(animal=who['animal'] or 'animal')
    return ' '.join([f'The {word} from the first image sings at a microphone.', framing, f'{setting}.', keep, tail])


def sing_prompt(animal, look=''):
    """The lip-sync engines' prompt (they all take one)."""
    return (f'A {animal} sings this song to the camera like a pop star: its mouth opens and closes in sync with every '
            f'sung word, jaw moving, head swaying and nodding to the beat, shoulders and body bouncing with the music, '
            f'expressive eyes, sharp detailed fur, {look + ", " if look else ""}static camera.')


def compose_request(engine, refs):
    """What one stage picture books (x2: a Space that names no size may run on a full GPU): Together's own
    compose_booking() when it has one (v13 with the GPU guard), else the same rule here: FLUX 3 Image Klein's
    get_duration() for 720x1280, 16 steps and these references; FLUX.2 klein its fixed 85 s."""
    booking = getattr(W.together, 'compose_booking', None)
    if booking:
        return float(booking(engine, refs))
    if 'flux-3' in engine['id']:
        args = engine['args']
        tokens = int(args['width']) * int(args['height']) / 256 + 512
        for r in refs:
            try:
                w, h = Image.open(r).size
            except Exception:
                w, h = 1024, 1024
            tokens += min(w * h, 1024 * 1024) / 256
        duration = int(min(max(15 + int(args['num_inference_steps']) * 0.5 * (tokens / 4608) ** 1.5, 20), 300))
        return float(2 * duration)
    return float(COMPOSE_FALLBACK_REQUEST)


def compose_stage(refs, prompt, out):
    """One stage picture of 1-2 references with Together's free composer engines (FLUX 3 Image Klein, then FLUX.2
    klein), each call through the guard (gpu_run) at its own request. Returns {'engine', 'seed'}. Raises QuotaError
    / BusyError like the clips, RuntimeError when every engine refused or is offline."""
    from gradio_client import Client, handle_file
    images = [{'image': handle_file(str(r)), 'caption': None} for r in refs]
    last, busy = None, False
    for engine in W.together.COMPOSE_ENGINES:
        def compose(engine=engine):  # one ZeroGPU call: only through the guard
            client = Client(engine['id'], token=W.HF_TOKEN, verbose=False)
            return wait_job(client.submit(prompt=prompt, input_images=images, seed=0, randomize_seed=True,
                                          api_name=engine['api'], **engine['args']), PICTURE_TIMEOUT)
        try:
            result = gpu_call(engine['name'], compose_request(engine, refs), compose)
            picture = result[0]
            W.save_picture(Image.open(picture.get('path') if isinstance(picture, dict) else picture), out)
            seed = result[1] if len(result) > 1 and isinstance(result[1], (int, float)) else None
            return {'engine': engine['name'], 'seed': None if seed is None else int(seed)}
        except W.QuotaError as e:
            if getattr(e, 'guard', False) and getattr(e, 'reason', 'quota') == 'quota' and engine is not \
                    W.together.COMPOSE_ENGINES[-1]:
                last = str(e)  # (not enough left for this one: a cheaper one may fit)
                continue
            raise
        except Exception as e:
            msg = str(e) or type(e).__name__
            if W.is_quota(msg):
                raise W.QuotaError(msg)
            if W.is_auth(msg):
                raise RuntimeError('The Hugging Face key was refused. Set up the worker again with a new key.')
            if type(e).__name__ in ('NoKey', 'KeyRefused'):
                raise
            busy = busy or W.is_busy(msg)
            log.warning('sing: %s failed: %s', engine['id'], msg)
            last = msg
    if busy:
        raise W.BusyError(last)
    raise RuntimeError(f'The free picture engines could not make the stage picture ({last})')


def angles_used(job):
    """The stage pictures the plan uses, in the order they are made (the first one is the job's card picture)."""
    order = ['close', 'closeA', 'closeB', 'medium', 'two', 'wide']
    used = set()
    for s in job.get('shots') or []:  # (a split screen is made of its two close-ups: no picture of its own)
        used |= set(s.get('angles') or []) if s['kind'] == 'split' else {s['angle']}
    return [a for a in order if a in used] + sorted(a for a in used if a not in order)


def ref_of(job, angle):
    """The singer picture(s) a stage angle is made from."""
    singers = job['singers']
    if angle == 'two':
        return [0, 1]
    if angle.endswith('B') and len(singers) > 1:
        return [1]
    return [0]


def stage_pictures(job):
    """Every stage picture the plan uses that isn't made yet (angle_<name>.jpg, 720x1280-ish). True when any was
    made now (then the picture check)."""
    folder = W.job_dir(job['id'])
    made = False
    angles = dict(job.get('angles') or {})
    todo = [a for a in angles_used(job) if a not in angles]
    for n, angle in enumerate(todo):
        W.update(job, stage=f'Making the stage pictures… ({n + 1} of {len(todo)}, about 20 s each)', progress=0.08)
        refs = []
        for i in ref_of(job, angle):
            pic = W.local_file(job, job['singers'][i]['pic'])
            refs.append(W.together.shrink_ref(pic, folder / f'ref_{i}.jpg'))
        prompt = stage_prompt(angle, job['singers'], job.get('look') or 'studio')
        got = compose_stage(refs, prompt, folder / f'angle_{angle}.jpg')
        angles[angle] = f'angle_{angle}.jpg'
        info = dict(job.get('compose') or {})
        info[angle] = dict(got, prompt=prompt)
        W.update(job, angles=angles, compose=info, gpu_spent=True, inputs=[angles[angle_first(angles)]])
        W.save(job, [f'angle_{angle}.jpg'])
        made = True
    return made


def angle_first(angles):
    for a in ('close', 'closeA', 'two', 'medium', 'closeB', 'wide'):
        if a in angles:
            return a
    return next(iter(angles))


# ---------- the part and the music-video edit (plan_shots) ----------

def bar_of(pack):
    bpm = pack.get('bpm') or ((pack.get('chorus') or {}).get('bpm')) or 120.0
    return 4 * 60.0 / float(bpm)


def meme_start(pack, song=None):
    got = (pack.get('chorus') or {}).get('start')
    if got is None and song:
        got = song.get('start')
    return float(got or 0.0)


def part_range(pack, part, part_from=None, part_to=None, song=None):
    """[from, to] of a part on the song's clock. meme: the meme part's 15 s; chorus: the meme part run on to 12 bars
    (about 29 s, ending on a bar); whole: the song; custom: the owner's range, snapped to line starts (2 s)."""
    dur = float(pack['duration'])
    a = meme_start(pack, song)
    if part == 'meme':
        return a, min(dur, round(a + MEME_SECONDS, 2))
    if part == 'chorus':
        bar = bar_of(pack)
        return a, min(dur, round(a + max(1, round(CHORUS_SECONDS / bar)) * bar, 2))
    if part == 'whole':
        return 0.0, dur
    if part == 'test':  # (the meme part's first sung window: so an approved test clip is that window)
        st = stretches(pack, a, min(dur, a + MEME_SECONDS))
        x = st[0][0] if st and st[0][0] - a >= CUTAWAY_BELOW else a
        return round(x, 3), min(dur, round(x + TEST_SECONDS, 3))
    lo = max(0.0, min(dur, float(part_from if part_from is not None else a)))
    hi = max(0.0, min(dur, float(part_to if part_to is not None else lo + MEME_SECONDS)))
    starts = [ln['start'] for ln in pack['lines']]
    near = [s for s in starts if abs(s - lo) <= 2.0]
    lo = min(near, key=lambda s: abs(s - lo)) if near else lo
    ends = [ln['end'] for ln in pack['lines']]
    near = [e for e in ends if abs(e - hi) <= 2.0 and e > lo + 1]
    hi = min(near, key=lambda e: abs(e - hi)) if near else hi
    if hi - lo < 2.0:
        raise W.HTTPException(400, 'That part is too short. Pick at least 2 seconds.')
    return round(lo, 2), round(hi, 2)


def friend_limit(pack, song=None):
    """The longest part a friend's video may sing: the chorus part (about 29 s). A friend never gets the whole song
    (also not as a 'custom' part from its start to its end)."""
    a, b = part_range(pack, 'chorus', song=song)
    return round(b - a, 2)


def friend_part_ok(pack, part, a, b, song=None):
    """True when a friend may sing [a, b] (custom parts are snapped to lines: 2 s of room)."""
    return part != 'whole' and (part != 'custom' or b - a <= friend_limit(pack, song) + 2.0)


def stretches(pack, a, b, gap=MERGE_GAP):
    """The sung stretches inside [a, b]: the lines, merged when the pause between them is under `gap` s."""
    out = []
    for ln in sorted(pack['lines'], key=lambda x: x['start']):
        s, e = max(float(ln['start']), a), min(float(ln['end']), b)
        if e - s <= 0.05:
            continue
        if out and s - out[-1][1] < gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def sung_in(pack, a, b):
    return round(sum(max(0.0, min(float(ln['end']), b) - max(float(ln['start']), a)) for ln in pack['lines']), 2)


def fixed_windows(st, window, line_starts, snap=1.5, shortest=1.5):
    """Calls of a fixed-length engine over the sung stretches: each starts where the last one ended, and ends at
    the latest line start inside its window (within `snap` s of its full length), else at its full length; so
    every call starts on a line or carries straight on, and no second of a call is padding."""
    out = []
    for s, e in st:
        t = s
        while e - t > 0.05:
            if e - t <= window + 1e-6:
                out.append((round(t, 3), round(e, 3)))
                break
            nominal = t + window
            cands = [x for x in line_starts if t + shortest <= x <= nominal + 1e-6]
            cut = max(cands) if cands and nominal - max(cands) <= snap else nominal
            out.append((round(t, 3), round(cut, 3)))
            t = cut
    return out


def line_shots(st, line_starts, part_starts, bar, longest=SHOT_MAX, shortest=SHOT_MIN):
    """Line-by-line shots over the sung stretches (the PC, which can sing any length): each stretch in
    ceil(len / 8 s) shots of about equal length, each cut moved to a line start, a part change or a bar line within
    1 s when both sides stay 2-8 s."""
    out = []
    marks = sorted(set(line_starts) | set(part_starts))
    for s, e in st:
        n = max(1, math.ceil((e - s) / longest - 1e-9))
        cuts = [s + (e - s) * k / n for k in range(1, n)]
        fixed = [s]
        for c in cuts:
            near = [m for m in marks if abs(m - c) <= 1.0 and m - fixed[-1] >= shortest and e - m >= shortest]
            if not near and bar:
                k = round((c - s) / bar)
                m = s + k * bar
                near = [m] if abs(m - c) <= 1.0 and m - fixed[-1] >= shortest and e - m >= shortest else []
            got = min(near, key=lambda m: abs(m - c)) if near else c
            if got - fixed[-1] > longest + 1.0:
                got = c
            fixed.append(got)
        fixed.append(e)
        out += [(round(x, 3), round(y, 3)) for x, y in zip(fixed, fixed[1:])]
    return out


def pc_chunks(seconds):
    """InfiniteTalk chunks for one shot: 81 frames, then +72 new frames each (25 fps)."""
    frames = seconds * PC_FPS
    return 1 + max(0, math.ceil((frames - PC_FIRST) / PC_STEP - 1e-9))


def who_times(spans, a, b):
    """Seconds each of 'A', 'B' and 'both' (a line both sing) sings inside [a, b]."""
    t = {'A': 0.0, 'B': 0.0, 'both': 0.0}
    for s in spans:
        o = max(0.0, min(s['end'], b) - max(s['start'], a))
        if not o:
            continue
        key = 'both' if len(set(s['who'])) > 1 else ('A' if s['who'][0] == 0 else 'B')
        t[key] += o
    return t


def who_sings(spans, a, b, n):
    """'A', 'B' or 'both' for a window: whoever sings most of it (a line both sing counts for 'both')."""
    if n < 2:
        return 'A'
    t = who_times(spans, a, b)
    if t['both'] >= max(t['A'], t['B']) and t['both'] > 0:
        return 'both'
    return 'A' if t['A'] >= t['B'] else 'B'


def both_sing(spans, a, b, least=0.3):
    """True when both singers sing inside [a, b] (a line together, or each at least `least` s of their own)."""
    t = who_times(spans, a, b)
    return t['both'] >= least or (t['A'] >= least and t['B'] >= least)


def share(pack, n, rule='turns', choices=None, a=0.0, b=None):
    """Who sings each line of the song: ONE answer for the plan, every shot's mouth tracks and the mix (and the page
    shows the same): [{'start', 'end', 'who': [0] | [1] | [0, 1], 'line'}], line by line in song order.
    'turns' (the owner's default, "Take turns"): the chorus (and hook) lines both sing; the other lines take turns,
    the first singer first from the part's first one (a line is in the part [a, b] when its middle is, as the page
    counts). 'verse_chorus' ("Verse by verse"): a verse each in turn, every chorus together (sing_audio's rule).
    'custom': the owner's choice per line (choices {line: [singers]}), the other lines as 'turns'."""
    if n < 2:
        return [{'start': ln['start'], 'end': ln['end'], 'who': [0], 'line': ln['n']} for ln in pack['lines']]
    if rule not in ('turns', 'custom'):
        return sa.spans_for(pack, n, rule, choices)
    lines = sorted(pack['lines'], key=lambda ln: ln['start'])
    alone = [ln for ln in lines if ln.get('kind') not in TOGETHER_KINDS]
    first = next((k for k, ln in enumerate(alone) if (ln['start'] + ln['end']) / 2 >= a), 0)
    turn = {ln['n']: (k - first) % n for k, ln in enumerate(alone)}
    out = []
    for ln in lines:
        if choices and ln['n'] in choices:
            who = [k for k in choices[ln['n']] if 0 <= k < n] or list(range(n))
        else:
            who = [turn[ln['n']]] if ln['n'] in turn else list(range(n))
        out.append({'start': ln['start'], 'end': ln['end'], 'who': who, 'line': ln['n']})
    return out


def kind_at(pack, a, b):
    """The kind of song part most of [a, b] is in (chorus, verse, hook ...)."""
    best, kind = 0.0, ''
    for p in pack['parts']:
        o = max(0.0, min(p['end'], b) - max(p['start'], a))
        if o > best:
            best, kind = o, p['kind']
    return kind


def plan_shots(pack, a, b, n_singers=1, engine='L1', rule='turns', choices=None, one_shot=False, both=False,
               keep=None, pc_duet=False):
    """The shot list of [a, b] (the part, on the song's clock), saved before any GPU is used:
    [{'k', 'from', 'to', 'kind': 'sing'|'split'|'cutaway', 'angle', 'angles', 'who', 'sung', 'window', 'pc',
      'done': False, ...}].
    engine: the engine the job sings with: a fixed-window one (L1/L2/K 5 s, X 11.5 s) plans windows that start on
    line starts; the PC ('P') plans line-by-line shots. Stretches with under 0.5 s of singing are free CPU
    cutaways (the wide picture with a push-in, or the duet's two-shot). Solo angles alternate close / medium (the
    first window of a chorus pass is medium); a duet shot goes to whoever sings most of it, and a window both sing
    is a split screen (top A, bottom B, each its own render). one_shot: every shot is the close-up. both: the
    "Both" engine choice: the later shots (by sung time) are marked for the PC. keep: shots already sung (a test
    clip, an earlier version) that are kept where their times still match. pc_duet: the duet is sung on the owner's
    PC with its duet model: a line-by-line shot both singers sing in (together, or one after the other) is one
    'duet' shot of the two-shot picture (InfiniteTalk's two_speakers), not a split screen."""
    window = ENGINES[engine]['window'] if engine in ENGINES else None
    spans = share(pack, n_singers, rule, choices, a, b) if n_singers > 1 else []  # (the same for every shot and the mix)
    st = stretches(pack, a, b)
    starts = [float(ln['start']) for ln in pack['lines'] if a < float(ln['start']) < b]
    pieces = fixed_windows(st, window, starts) if window else \
        line_shots(st, starts, [float(p['start']) for p in pack['parts'] if a < float(p['start']) < b], bar_of(pack))
    shots, t = [], a

    def add(x, y, kind):
        shots.append({'from': round(x, 3), 'to': round(y, 3), 'kind': kind})
    for x, y in pieces:
        if x - t >= CUTAWAY_BELOW:
            add(t, x, 'cutaway')
        elif shots and x > t and (not window or (shots[-1]['kind'] != 'cutaway' and
                                                  x - shots[-1]['from'] <= window + 1e-6)):
            shots[-1]['to'] = round(x, 3)  # (a tiny pause after a shot: that shot holds it)
        else:
            x = t  # (a tiny pause before it: the shot starts there)
        add(x, y, 'sing')
        t = y
    if b - t >= CUTAWAY_BELOW or not shots:
        add(t, b, 'cutaway')
    else:
        shots[-1]['to'] = round(b, 3)
    angle_turn, prev_kind = 0, None
    for k, s in enumerate(shots):
        s.update(k=k, sung=sung_in(pack, s['from'], s['to']), window=window, pc=False, done=False, engine='',
                 seed=None, tries=0, failed=False)
        if s['kind'] == 'sing' and s['sung'] < CUTAWAY_BELOW:
            s['kind'] = 'cutaway'
        part_kind = kind_at(pack, s['from'], s['to'])
        if s['kind'] == 'cutaway':
            s.update(angle='two' if n_singers > 1 else 'wide', who='')
        elif n_singers > 1:
            who = who_sings(spans, s['from'], s['to'], n_singers)
            if pc_duet and not window and both_sing(spans, s['from'], s['to']):
                s.update(kind='duet', angle='two', who='both')  # (one two-shot: each mouth with its own lines)
            elif who == 'both':
                s.update(kind='split', angle='split', angles=['closeA', 'closeB'], who='both')
            else:
                s.update(angle='close' + who, who=who)
        else:
            if one_shot:
                angle = 'close'
            elif part_kind == 'chorus' and prev_kind != 'chorus':
                angle, angle_turn = 'medium', 0  # (the first window of a chorus pass; then close, medium ...)
            else:
                angle = ('close', 'medium')[angle_turn % 2]
                angle_turn += 1
            s.update(angle=angle, who='A')
        if s['kind'] != 'cutaway':
            prev_kind = part_kind
    if both:
        sung = [s for s in shots if s['kind'] != 'cutaway']
        total = sum(s['sung'] for s in sung) or 1.0
        acc = 0.0
        for s in sung:
            s['pc'] = acc >= total / 2
            acc += s['sung']
    for s in shots:  # (each render: the seconds of song it sings; a line-by-line shot starts PRE_ROLL early, so the
        # mouth is already moving at the cut: the join trims it off again)
        s['render_from'] = s['from'] if window or s['kind'] == 'cutaway' else round(max(0.0, s['from'] - PRE_ROLL), 3)
        s['render_to'] = round(s['from'] + window, 3) if window else s['to']
        if window and ENGINES[engine].get('fit') and s['kind'] != 'cutaway':  # (LTX-2 renders the seconds it is
            # asked for, and its GPU time grows with them: the shot's own length, to the next half second)
            s['render_to'] = round(s['from'] + min(window, max(1.0, math.ceil((s['to'] - s['from']) * 2 - 1e-6) / 2)), 3)
    if keep:
        reuse(shots, keep, spans if n_singers > 1 else share(pack, 1))
        if n_singers < 2 and not one_shot:  # (a kept shot keeps its angle: the new ones next to it still alternate)
            prev = None
            for s in shots:
                if s['kind'] != 'sing':
                    continue
                if not s.get('done') and s['angle'] == prev and prev in ('close', 'medium'):
                    s['angle'] = 'medium' if prev == 'close' else 'close'
                prev = s['angle']
    return shots


def reuse(shots, old, spans=None):
    """Shots already sung stay where their times still match: the same start and singer(s), the new shot inside
    what the old render sang, and (spans: who sings what now) each singer's mouth open on the same lines as when it
    was sung (a shot sung for other lines would show a closed mouth under a voice). A kept shot keeps its angle and
    its file (the plan's angle only counts for new shots; an angle the owner changes is redone by the edit)."""
    for s in shots:
        if s['kind'] == 'cutaway':
            continue
        for o in old:
            if o.get('done') and not o.get('failed') and o['kind'] == s['kind'] and \
                    abs(o['render_from'] - s['render_from']) < 0.02 and s['to'] <= o['render_to'] + 0.02 and \
                    o.get('who') == s['who'] and (s['kind'] != 'split' or o.get('angles') == s.get('angles')) and \
                    (spans is None or not o.get('mouths') or mouths_of(o, spans) == o['mouths']):
                s.update({k: o[k] for k in ('done', 'engine', 'seed', 'render_from', 'render_to', 'files', 'made_with',
                                             'wall_s', 'spend_s', 'angle', 'window', 'mouths') if k in o})
                break
    return shots


# ---------- the time line (what the page shows before anything is spent) ----------

def per_day(spend, request, share, base=DAY_BASE):
    """Calls a day: each call needs `request` left on the account, and Sing's share must cover its spend (a spend
    is never counted at less than SPEND_FLOOR: a measured 0 can't make it endless)."""
    spend = max(SPEND_FLOOR, float(spend or 0.0))
    left, used, n = float(base), 0.0, 0
    while left >= request and used + spend <= share and n < 1000:
        left -= spend
        used += spend
        n += 1
    return n


NIGHT_MIN = 480  # one night on the PC: 8 hours


def both_estimate(renders, first, daily, days, pc_minutes):
    """'Both' (online by day, the PC when it is on): never slower than the faster of the two alone, and nights
    only when the PC's share needs them. {'days', 'nights', 'minutes', 'today'}: minutes [lo, hi] when the PC alone
    finishes it in one go (then that is the time); days/nights otherwise."""
    lo, hi = pc_minutes
    if renders <= 0 or days == 1:  # (online alone: ready today)
        return {'days': 1 if renders else 0, 'nights': 0, 'minutes': None, 'today': True}
    if hi <= NIGHT_MIN:  # (the PC alone, in one evening or night)
        return {'days': 0, 'nights': 0, 'minutes': [lo, hi], 'today': False}
    per_night = renders * NIGHT_MIN / float(hi)  # (renders the PC sings in a night, at its slower speed)
    done, d, n = 0.0, 0, 0
    while done < renders and d < 60:  # day by day: online first, then the PC that night
        d += 1
        done += first if d == 1 else daily
        if done >= renders:
            break
        n += 1
        done += per_night
    pc_nights = math.ceil(hi / NIGHT_MIN)
    if days is not None and days <= max(d, n):  # (online alone is as fast)
        return {'days': days, 'nights': 0, 'minutes': None, 'today': False}
    if pc_nights <= max(d, n) and pc_nights < d + (n > 0):  # (the PC alone is faster)
        return {'days': 0, 'nights': pc_nights, 'minutes': None, 'today': False}
    return {'days': d, 'nights': n, 'minutes': None, 'today': False}


def estimate(pack, part, singers=1, rule='turns', song=None, engine=None, pc_size='sharp'):
    """{'from', 'to', 'seconds', 'sung', 'online': {...}, 'pc': {...}, 'both': {...}} for one part: the calls,
    the quota seconds and the days on the approved online engine (LongCat until one is approved), and the chunks and
    minutes on the owner's PC. Measured numbers replace the estimates as soon as there are any."""
    a, b = part_range(pack, part, song=song)
    eng = engine or default_engine() or 'L1'
    shots = plan_shots(pack, a, b, singers, eng, rule)
    renders = sum(2 if s['kind'] == 'split' else 1 for s in shots if s['kind'] != 'cutaway')
    spend, request = spend_of(eng), ENGINES[eng]['request']
    with lock:
        share = float(settings['share'])
        measured = bool(measured_spends(eng))
        pc_measured = median(settings['pc'].get('chunk_s'))
    pictures = len({s['angle'] for s in shots if s['kind'] == 'sing'} | {a_ for s in shots for a_ in s.get('angles') or []}
                   | ({'wide' if singers < 2 else 'two'} if any(s['kind'] == 'cutaway' for s in shots) else set()))
    pic_cost = 48.0 * pictures
    daily = per_day(spend, request, share)
    today_left = share_left()
    first = per_day(spend, request, max(0.0, min(share, today_left) - pic_cost))
    if renders == 0:
        days = 0
    elif renders <= first:
        days = 1
    elif daily <= 0:
        days = None
    else:
        days = 1 + math.ceil((renders - first) / daily)
    quota_s = round(renders * spend + pic_cost)
    st = stretches(pack, a, b)
    chunks = sum(math.ceil((e - s) / SHOT_MAX - 1e-9) * pc_chunks((e - s) / math.ceil((e - s) / SHOT_MAX - 1e-9))
                 for s, e in st)
    chunks = int(round(chunks * (1.3 if singers > 1 else 1.0)))
    lo, hi = PC_MINUTES['fast' if pc_size == 'fast' else 'sharp']
    if pc_measured:
        lo = hi = round(pc_measured / 60, 1)
    pc_min = [round(chunks * lo), round(chunks * hi)]
    return {'from': a, 'to': b, 'seconds': round(b - a, 2), 'sung': round(sum(e - s for s, e in st), 1),
            'shots': len(shots),
            'online': {'engine': eng, 'name': ENGINES[eng]['name'], 'calls': renders, 'quota_s': quota_s,
                       'minutes': round(quota_s / 60), 'days': days, 'today': days == 1, 'per_day': daily,
                       'measured': measured, 'pictures': pictures},
            'pc': {'chunks': chunks, 'minutes': pc_min, 'measured': bool(pc_measured),
                   'nights': max(1, math.ceil(pc_min[1] / NIGHT_MIN))},
            'both': both_estimate(renders, first, daily, days, pc_min)}


# ---------- singing one shot (sing_shot) ----------

def _video_path(result):
    """The video file a Space returned (a path, {'video': ...}, {'path': ...}, or the first of a tuple)."""
    v = result[0] if isinstance(result, (list, tuple)) else result
    if isinstance(v, dict):
        v = v.get('video') or v.get('path') or v.get('value')
        if isinstance(v, dict):
            v = v.get('path')
    return v


def engine_args(eid, picture, audio, prompt, seed, seconds):
    """The keyword arguments of one call (the names from each Space's own API, wfG/free-sing-models/api)."""
    from gradio_client import handle_file
    if eid == 'L1':  # the model authors' demo: fixed 125 frames (5 s at 25 fps), our vocals already isolated
        return {'image_file': handle_file(str(picture)), 'audio_file': handle_file(str(audio)), 'prompt': prompt,
                'resolution': '480p', 'seed': float(seed), 'vocal_mode': 'Clean speech (fast)',
                'acceleration': 'DBCache faster'}
    if eid == 'L2':
        return {'image_path': handle_file(str(picture)), 'audio_path': handle_file(str(audio)), 'prompt': prompt,
                'resolution': '480p', 'seed': int(seed), 'vocal_mode': 'Clean speech (fast)',
                'acceleration': 'DBCache faster'}
    if eid == 'X':
        return {'image_path': handle_file(str(picture)), 'audio_path': handle_file(str(audio)), 'prompt': prompt,
                'negative_prompt': NEG, 'video_duration': min(11.5, math.ceil(float(seconds) * 2 - 1e-6) / 2),
                'seed': -1}
    if eid == 'K':
        return {'image': handle_file(str(picture)), 'audio': handle_file(str(audio)), 'prompt': prompt,
                'seed': int(seed), 'seconds': 5}  # (an int: the Space's gr.Radio choices are [5, 10]; 5 s is
    # what its request of 200 books: 2 x GPU_DURATION[5] on xlarge)
    raise ValueError(eid)


def call_engine(eid, picture, audio, prompt, seed, seconds, out):
    """One lip-sync call, through the guard (gpu_run, at the Space's own booking); LongCat's two Spaces stand in for
    each other when one is down or busy (never as a way around the free time). Returns the engine id that made it.
    Raises QuotaError / BusyError / RuntimeError like make_clip."""
    tries = [eid] + ([ENGINES[eid]['same']] if ENGINES[eid].get('same') else [])
    last, busy = None, False
    for e in tries:
        engine = ENGINES[e]

        def sing(e=e, engine=engine):  # one ZeroGPU call: only through the guard (wait_job never leaves it running)
            from gradio_client import Client
            client = Client(engine['id'], token=W.HF_TOKEN, verbose=False)
            return wait_job(client.submit(api_name=engine['api'], **engine_args(e, picture, audio, prompt, seed,
                                                                                    seconds)), SPACE_TIMEOUT)
        try:
            result = gpu_call(e, engine['request'], sing)
            path = _video_path(result)
            if not path or not os.path.exists(str(path)):
                raise ShotFailed(f'{engine["name"]} gave no video')
            shutil.copy(path, out)
            if isinstance(result, (list, tuple)) and len(result) > 1 and isinstance(result[1], (int, float)):
                seed = int(result[1])
            return e, seed
        except W.QuotaError:
            raise
        except ShotFailed:
            raise
        except Exception as ex:
            msg = str(ex) or type(ex).__name__
            if type(ex).__name__ in ('NoKey', 'KeyRefused'):
                raise
            if W.is_quota(msg):
                raise W.QuotaError(msg)
            if W.is_auth(msg):
                raise RuntimeError('The Hugging Face key was refused. Set up the worker again with a new key.')
            down = W.is_busy(msg) or re.search(r'connect|timed? ?out|not found|404|50[234]|sleeping|building|'
                                                r'runtime error|paused', msg, re.I)
            log.warning('sing: %s failed: %s', engine['id'], msg)
            busy, last = busy or W.is_busy(msg), msg
            if not down:
                break
    if busy:
        raise W.BusyError(last)
    raise ShotFailed(f'{ENGINES[eid]["name"]} could not sing this shot ({last})')


def pc_can_sing():
    # (W is None only before the worker binds this module: /health may be asked then, as by the guard's tests)
    return W is not None and W.pc_online() and 'sing' in (W.pc.get('can') or ())


def pc_share_waits(job, shot):
    """A "Both" job's shot marked for the PC waits for the PC (not online) until the owner's stop time."""
    return job.get('engine_choice') == 'both' and bool(shot.get('pc')) and \
        time.time() < float(job.get('pc_deadline') or 0)


def use_pc(job, shot):
    """The owner's PC sings this shot: its helper is on and can sing, and the job may use it (made on "My PC" or
    "Both", or the PC passed its test and one video may mix the engines approved)."""
    if job.get('test'):  # (the PC's own test sings on the PC whatever its last result was: a new one replaces it)
        return job.get('test_engine') == 'P' and pc_can_sing()
    if not pc_can_sing() or engine_state('P') == 'bad':
        return False
    choice = job.get('engine_choice') or 'online'
    if choice in ('pc', 'both'):
        return True
    with lock:
        mix = settings['mix']
    return mix and engine_state('P') == 'good'


# ---------- the PC's sing tasks: handed over, never waited for in the AI lane ----------
# A render for the PC becomes one 'sing' task (only helpers that said can=sing get it). The job then waits outside
# the worker's one AI lane (PcBusy: status waiting, sing_wait 'pc_singing'), so the owner's other videos and friends'
# are made meanwhile (a shot takes the PC 5-60 min, a whole song a night). pc_watch() puts the job back in line as
# soon as the PC sent the shot, failed it or went quiet; the job then takes the shot in (or sings it online, or
# waits for the PC, as before). A job has one task on the PC at a time, in song order, so the PC gets the owner's
# normal clips in between.

PC_WATCH_EVERY = 5  # seconds between the watchdog's looks


def pc_task_new(job, shot, render, picture, audio, seconds, out, seed, mode='solo', masks=(), turns=None, prompt=None,
                temp=()):
    """One render as a 'sing' task for the PC (not handed over yet: pc_task_add). mode: 'solo', 'split' (one half
    of a split screen, made like solo) or 'duet' (both singers in the two-shot: audio [A's track, B's track, both],
    masks [A's half, B's half], turns [[from, to, 'A'|'B'|'AB']]). temp: the files made for it (its tracks, masks),
    removed with the task."""
    size = PC_SIZE['fast' if job.get('sharp') == 'fast' else 'sharp']
    tracks = audio if isinstance(audio, (list, tuple)) else [audio]
    task = {'id': W.secrets.token_hex(6), 'kind': 'sing', 'mode': mode, 'picture': str(picture),
            'audio': [str(x) for x in tracks], 'masks': [str(m) for m in masks],
            'prompt': prompt or sing_prompt(_animal_of(job, render), ''),
            'seconds': round(seconds, 3), 'size': list(size), 'fps': PC_FPS, 'seed': int(seed),
            'chunks': pc_chunks(seconds), 'out': str(out), 'status': 'waiting', 'error': '', 'parts': {},
            'job': job['id'], 'shot': shot['k'], 'render': render, 'done': threading.Event(), 'started': time.time(),
            'made': time.time(), 'temp': [str(f) for f in temp]}
    if turns:
        task['turns'] = [list(x) for x in turns]
    task['limit'] = max(PC_TASK_LIMIT, 1.5 * task['chunks'] * PC_MINUTES['sharp'][1] * 60)
    return task


def pc_task_add(task):
    with W.pc_cond:
        W.pc_tasks[task['id']] = task
        W.pc_cond.notify_all()


def pc_task_state(task):
    """'done' (the shot is in), 'failed' (the PC couldn't), 'lost' (it went quiet, or took far too long; the time
    limit counts from its newest part, the first part also loads the models) or 'singing'."""
    if task['done'].is_set():
        return 'done' if task['status'] == 'done' and Path(task['out']).exists() else 'failed'
    limit = task['limit'] if task['parts'] else max(task['limit'], PC_FIRST_LIMIT)
    if not W.pc_online() or time.time() - task['started'] > limit:
        return 'lost'
    return 'singing'


def pc_task_drop(task):
    """The task is over (taken in, failed, lost, or not needed any more): out of the PC's list, the parts it sent
    and its own files removed (the shot itself, when it came, stays)."""
    with W.pc_cond:
        W.pc_tasks.pop(task['id'], None)
    for part in task['parts'].values():  # (the chunks it sent along the way: the whole shot is in `out`)
        for f in part.values():
            Path(f).unlink(missing_ok=True)
    for f in task.get('temp') or []:
        Path(f).unlink(missing_ok=True)


def pc_sing(job, shot, render, picture, audio, seconds, out, seed, mode='solo', masks=(), turns=None, prompt=None):
    """Hands one render to the owner's PC and WAITS for it: True when the PC made it, False when it failed or went
    away. (The PC contract's tests; a job's shots go through pc_take() / pc_hand(), which never hold the AI lane.)"""
    task = pc_task_new(job, shot, render, picture, audio, seconds, out, seed, mode, masks, turns, prompt)
    pc_task_add(task)
    try:
        while not task['done'].wait(5):
            if pc_task_state(task) == 'lost':
                log.warning('sing: the PC went quiet during %s shot %d', job['id'], shot['k'])
                return False
        if task['status'] != 'done':
            log.warning('sing: the PC could not sing %s shot %d: %s', job['id'], shot['k'], task['error'])
        return task['status'] == 'done'
    finally:
        pc_task_drop(task)


def sung_number(job, shot):
    """(i, of): this shot's number among the shots that are sung (a cutaway is never sung), as shots_done/total."""
    sung = [s for s in job.get('shots') or [] if s['kind'] != 'cutaway']
    i = next((n for n, s in enumerate(sung) if s is shot or s['k'] == shot['k']), len(sung) - 1)
    return i + 1, len(sung)


def pc_busy_text(job, shot):
    k, total = sung_number(job, shot)
    if shot['kind'] == 'duet':
        return f'Your PC is singing shot {k} of {total}, the duet (10-20 min)…'
    return f'Your PC is singing shot {k} of {total} (5-10 min)…'


def pc_take(job, shot, render):
    """This render's task on the PC, if it has one: 'done' (its file is in: shot['rfiles'][render]), 'failed' (the
    PC couldn't, or went quiet), None (no task). Raises PcBusy while the PC is still singing it."""
    tid = (shot.get('pc_task') or {}).get(render)
    task = W.pc_tasks.get(tid) if tid else None
    if task is None:
        if tid:  # (the worker restarted: the PC keeps the parts it made, and goes on from them for a new task)
            shot['pc_task'].pop(render, None)
        return None
    state = pc_task_state(task)
    if state == 'singing':
        raise PcBusy(pc_busy_text(job, shot), wait=task['limit'] + 300)
    pc_task_drop(task)
    shot['pc_task'].pop(render, None)
    if state == 'done':
        shot.setdefault('rfiles', {})[render] = Path(task['out']).name
        shot['pc_wall'] = round(float(shot.get('pc_wall') or 0) + time.time() - task['made'], 1)
        return 'done'
    log.warning('sing: the PC %s %s shot %d%s', 'went quiet during' if state == 'lost' else 'could not sing',
                job['id'], shot['k'], f": {task['error']}" if task['error'] else '')
    return 'failed'


def pc_hand(job, shot, render, make):
    """Hands a render to the PC (make() gives its task: its inputs are only made now) and raises PcBusy: the job
    waits outside the AI lane while the PC sings it. One task of a job at a time: while another of its shots is on
    the PC, this one waits for it (PcBusy too); a task no shot names any more (the job was re-planned) is dropped."""
    named = {t for s in job.get('shots') or [] for t in (s.get('pc_task') or {}).values()}
    with W.pc_cond:
        mine = [t for t in W.pc_tasks.values() if t.get('handed') and t.get('job') == job['id']]
    for t in mine:
        if t['id'] not in named:
            pc_task_drop(t)
        elif pc_task_state(t) == 'singing':
            raise PcBusy(pc_busy_text(job, next(s for s in job['shots'] if t['id'] in (s.get('pc_task') or {}).values())),
                         wait=t['limit'] + 300)
    task = make()
    task['handed'] = True
    shot.setdefault('pc_task', {})[render] = task['id']  # (first: the watchdog drops a task no shot names)
    W.update(job, shots=job['shots'])
    pc_task_add(task)
    log.info('sing: %s shot %d (%s) handed to the PC as task %s', job['id'], shot['k'], render, task['id'])
    raise PcBusy(pc_busy_text(job, shot), wait=task['limit'] + 300)


def pc_watch():
    """The PC watchdog (one thread, started with the worker)."""
    while True:
        time.sleep(PC_WATCH_EVERY)
        try:
            pc_watch_once()
        except Exception as e:  # (it must never stop)
            log.warning('sing: the PC watchdog: %s', e)


def pc_watch_once():
    """A job whose shot the PC was singing goes back in line once the shot is in, the PC failed it or went quiet;
    a task no job's shot names any more (an edit re-planned the job, or it was deleted) is dropped (the helper then
    hears 404 and moves on; the parts it made stay on the PC for the same shot)."""
    with W.pc_cond:
        tasks = [t for t in W.pc_tasks.values() if t.get('handed')]
    for task in tasks:
        job = W.jobs.get(task.get('job'))
        named = job is not None and any(task['id'] in (s.get('pc_task') or {}).values() for s in job.get('shots') or [])
        if not named:
            if time.time() - task['made'] > 30:  # (not one being handed over right now)
                log.info('sing: the PC task %s is not needed any more', task['id'])
                pc_task_drop(task)
            continue
        if pc_task_state(task) == 'singing':
            continue
        with W.jobs_lock:  # (once: an edit or "Try now" may have put it in line already)
            go = job.get('status') == 'waiting' and job.get('sing_wait') == 'pc_singing'
            if go:
                job.update(status='queued', stage='In line…', retry_at=None)
        if go:
            W.update(job)
            W.enqueue(job)


def _animal_of(job, render):
    s = job['singers'][1 if render == 'B' and len(job['singers']) > 1 else 0]
    return s.get('animal') or 'animal'


def renders_of(shot):
    """The renders a shot needs: one, two for a split screen (A on top, B below), one of both for a PC duet."""
    if shot['kind'] == 'duet':
        return ['AB']
    return ['A', 'B'] if shot['kind'] == 'split' else [shot.get('who') or 'A']


def duet_turns(spans, start, seconds):
    """Who sings when inside a duet task's audio ([start, start + seconds] of the song), for the PC helper's
    two_speakers plan: [[from, to, 'A'|'B'|'AB']] in seconds of the task's audio, in order."""
    out = []
    for s in sorted(spans, key=lambda x: x['start']):
        x, y = max(float(s['start']), start) - start, min(float(s['end']), start + seconds) - start
        if y - x <= 0.02:
            continue
        who = 'AB' if len(set(s['who'])) > 1 else ('A' if s['who'][0] == 0 else 'B')
        if out and out[-1][2] == who and x - out[-1][1] < 0.05:
            out[-1][1] = round(y, 3)
        else:
            out.append([round(x, 3), round(y, 3), who])
    return out


def duet_masks(picture, out_a, out_b, gap=0.04):
    """Each singer's half of the two-shot picture as a mask (white = that singer): A the left half, B the right,
    with `gap` of the width between them (the stage picture puts each animal fully in its own half)."""
    with Image.open(picture) as im:
        w, h = im.size
    half = int(round(w * (0.5 - gap / 2)))
    for path, (x0, x1) in ((out_a, (0, half)), (out_b, (w - half, w))):
        m = Image.new('L', (w, h), 0)
        ImageDraw.Draw(m).rectangle((x0, 0, x1 - 1, h - 1), fill=255)
        m.save(path)


def duet_prompt(job):
    """The PC duet's prompt: both singers, each where the two-shot puts it."""
    a, b = (described(s) for s in job['singers'][:2])
    return (f'A {a} on the left and a {b} on the right sing this song together to the camera like a pop duo: each '
            'mouth opens and closes in sync with its own sung words, jaws moving, heads swaying and nodding to the '
            'beat, shoulders and bodies bouncing with the music, expressive eyes, sharp detailed fur, static camera.')


def pc_duet_ok():
    """The owner's PC can sing a duet in one two-shot: its helper says sing_duet now, or said so last time it was
    on (it is off now: the job waits for it)."""
    if pc_can_sing():
        return 'sing_duet' in (W.pc.get('can') or ())
    with lock:
        return bool(settings['pc'].get('duet'))


def shot_file(shot, render):
    """A new render's file name: its own for every render (never the plan's index: an edit renumbers the shots
    and a kept shot keeps its file, so a new shot must never write over it); _A / _B for a split screen's halves."""
    tail = f'_{render}' if shot['kind'] == 'split' else ''
    return f"shot_{int(round(float(shot['render_from']) * 1000))}_{W.secrets.token_hex(3)}{tail}.mp4"


def reset_shot(s, **more):
    """A shot to be sung again (new lists: never shared between shots)."""
    s.update(done=False, files=[], seed=None, failed=False, tries=0, rfiles={}, pc_task={}, rmade={}, rspend=0.0,
             pc_wall=0.0, **more)


def render_seconds(shot):
    """The seconds of song one render of this shot sings (render_from .. render_to)."""
    return round(float(shot['render_to']) - float(shot['render_from']), 3)


def sing_shot(job, shot, pack, d):
    """Sings one shot (each of its renders): its picture and its slice of the ORIGINAL vocal (that singer's
    lines only, 16 kHz mono), on the PC first when it may, else the job's online engine. Saves the file(s) to the
    dataset at once, with the engine, seed, wall and spend. Raises QuotaError / BusyError / PcWait, and PcBusy
    while the PC sings one of its renders (the job comes back for it: the renders made stay in rfiles)."""
    folder = W.job_dir(job['id'])
    n = len(job['singers'])
    spans = job_spans(job, pack)  # (the same sharing as the plan and the mix: the job's own lines)
    seconds = render_seconds(shot)
    started = time.time()
    if not shot.get('seed'):
        shot['seed'] = random.randint(1, 2 ** 31 - 1)  # (kept: a shot the PC sings is the same shot when it is in)
    seed = shot['seed']
    rfiles = shot.setdefault('rfiles', {})
    made_with = shot.setdefault('rmade', {})
    shot.setdefault('pc_task', {})
    pc_only = job.get('engine_choice') == 'pc' or (job.get('test') and job.get('test_engine') == 'P')
    for r in renders_of(shot):
        if rfiles.get(r) and _have(job, rfiles[r]):
            continue  # (made already: one half of a split screen came in earlier)
        rfiles.pop(r, None)
        out = folder / shot_file(shot, r)
        if shot['kind'] == 'duet':  # (only the PC sings these: both singers in the two-shot, each its own lines)
            sing_duet(job, shot, spans, seconds, d, out, seed)
            shot['rengine'] = 'P'
            made_with['your PC'] = made_with.get('your PC', 0) + 1
            continue
        angle = (shot.get('angles') or [shot['angle']])[0 if r == 'A' else -1] if shot['kind'] == 'split' \
            else shot['angle']
        picture = W.local_file(job, job['angles'][angle])
        who = 0 if r == 'A' else 1
        prompt = sing_prompt(_animal_of(job, r), job['singers'][who if who < n else 0].get('look') or '')

        def track(r=r, who=who):
            audio = folder / f"vocal_{shot['k']}_{r}_{W.secrets.token_hex(2)}.wav"
            sa.save(str(audio), sa.mouth_track(str(d / 'vocals.flac'), spans, who, shot['render_from'], seconds),
                    sr=16000)
            return audio
        got = pc_take(job, shot, r)  # (a render the PC was singing: in now, or it failed)
        if got is None and use_pc(job, shot):
            def make(r=r, out=out, picture=picture, prompt=prompt, track=track):
                audio = track()
                return pc_task_new(job, shot, r, picture, audio, seconds, out, seed,
                                   mode='split' if shot['kind'] == 'split' else 'solo', prompt=prompt, temp=[audio])
            pc_hand(job, shot, r, make)  # (raises PcBusy: the job waits outside the AI lane)
        if got == 'done':
            shot['rengine'] = 'P'
            made_with['your PC'] = made_with.get('your PC', 0) + 1
            continue
        if pc_only:
            raise PcWait('Waiting for your PC to sing (switch the helper on, with singing on)')
        if got == 'failed' and pc_share_waits(job, shot):  # ("Both": the PC's share waits for the PC until the
            raise PcWait(f"Waiting for your PC to sing this shot (until {settings['pc_until']})")  # owner's stop
            # time: a game or Ctrl+C stopped it, its parts stay on the PC)
        eid = job.get('test_engine') if job.get('test') else (job.get('online') or default_engine())
        if eid not in ONLINE + ('L2',):
            raise RuntimeError('No singing engine is approved yet. Make the 5-second test first.')
        i, of = sung_number(job, shot)
        W.update(job, stage=f"Singing shot {i} of {of} ({fmt_t(shot['from'])} → {fmt_t(shot['to'])})… (1-2 min)")
        audio = track()
        with lock:
            spent0 = float(_ledger_now()['spent'])  # (what this render cost Sing's share: measured by the guard)
        try:
            used, seed = call_engine(eid, picture, audio, prompt, seed, seconds, out)
        finally:
            audio.unlink(missing_ok=True)
            with lock:
                shot['rspend'] = round(float(shot.get('rspend') or 0) +
                                       max(0.0, float(_ledger_now()['spent']) - spent0), 1)
        rfiles[r] = out.name
        shot['rengine'] = used
        nm = ENGINES[used]['model']
        made_with[nm] = made_with.get(nm, 0) + 1
        W.update(job, shots=job['shots'])  # (this render is in: the other half of a split may wait for the PC)
    files = [rfiles[r] for r in renders_of(shot)]
    took = time.time() - started + float(shot.get('pc_wall') or 0)
    shot.update(done=True, files=files, engine=shot.get('rengine'), seed=seed, made_with=dict(made_with),
                wall_s=round(took, 1), spend_s=round(float(shot.get('rspend') or 0), 1), failed=False, rfiles={},
                pc_task={}, rmade={}, rspend=0.0, pc_wall=0.0, mouths=mouths_of(shot, spans))
    shot.pop('rengine', None)
    W.update(job, shots=job['shots'])
    W.save(job, files)


def sing_duet(job, shot, spans, seconds, d, out, seed):
    """A PC duet shot: the two-shot picture, A's and B's lines of the original vocal (and both), each singer's half
    of the picture, and who sings when; one task for the helper's duet model. Raises PcWait while the PC isn't
    there (or couldn't make it: it tries again when it is on), PcBusy while it sings it; returns when it is in
    (shot['rfiles']['AB'])."""
    folder = W.job_dir(job['id'])
    got = pc_take(job, shot, 'AB')
    if got == 'done':
        return
    if got == 'failed':
        raise PcWait('Waiting for your PC to sing the duet again (it stopped before the end)')
    if not (use_pc(job, shot) and 'sing_duet' in (W.pc.get('can') or ())):
        raise PcWait('Waiting for your PC to sing the duet (switch the helper on, with singing on)')

    def make():
        picture = W.local_file(job, job['angles']['two'])
        start, k, tag = shot['render_from'], shot['k'], W.secrets.token_hex(2)
        voc = str(d / 'vocals.flac')
        tracks = [folder / f'vocal_{k}_{x}_{tag}.wav' for x in ('A', 'B', 'AB')]
        sa.save(str(tracks[0]), sa.mouth_track(voc, spans, 0, start, seconds), sr=16000)
        sa.save(str(tracks[1]), sa.mouth_track(voc, spans, 1, start, seconds), sr=16000)
        sa.save(str(tracks[2]), sa.mouth_track(voc, [dict(x, who=[0]) for x in spans], 0, start, seconds), sr=16000)
        masks = [folder / f'mask_{k}_{x}_{tag}.png' for x in ('A', 'B')]
        duet_masks(picture, *masks)
        return pc_task_new(job, shot, 'AB', picture, tracks, seconds, out, seed, mode='duet', masks=masks,
                           turns=duet_turns(spans, start, seconds), prompt=duet_prompt(job), temp=tracks + masks)
    pc_hand(job, shot, 'AB', make)


def fmt_t(t):
    t = max(0.0, float(t))
    return f'{int(t // 60)}:{t % 60:04.1f}'


def job_rule(job):
    who = job.get('who')
    if isinstance(who, list):
        return 'custom'
    return WHO_RULES.get(who or 'turns', 'turns')


def job_choices(job):
    who = job.get('who')
    if not isinstance(who, list):
        return None
    out = {}
    for c in who:
        k = {'A': [0], 'B': [1], 'both': [0, 1]}.get(c.get('who'))
        if k is not None:
            out[int(c['line'])] = k
    return out


# ---------- the join (join_sing): shots on the song's clock, the parts, the TikTok cut ----------

ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', str(FPS)]
NINE16 = "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'"


def _run(cmd, timeout=1800):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout)


def frames_between(a, x, y):
    """Frames of [x, y] on a video that starts at song time a: cumulative rounding, so the parts add up exactly."""
    return int(round((y - a) * FPS)) - int(round((x - a) * FPS))


def _fit(offset):
    """fps 30 by repeating frames on their timestamps (never a speed change), then the cut, 9:16, 720x1280, sharp."""
    return (f'fps={FPS},trim=start={max(0.0, offset):.4f},setpts=PTS-STARTPTS,{NINE16},'
            f'scale={OUT_W}:{OUT_H}:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,setsar=1,format=yuv420p,'
            'tpad=stop_mode=clone:stop_duration=30')


def norm_render(src, offset, frames, out):
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-vf', _fit(offset), '-frames:v', str(frames), '-an'] + ENC
         + [str(out)])


def norm_split(src_a, src_b, offset, frames, out):
    """A split screen: A on top, B below, each its face band (the upper half of a close-up, where the face is)."""
    half = OUT_H // 2
    band = f'crop={OUT_W}:{half}:0:{int(OUT_H * 0.06)}'
    graph = (f'[0:v]{_fit(offset)},{band}[a];[1:v]{_fit(offset)},{band}[b];[a][b]vstack=inputs=2,format=yuv420p[v]')
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(src_a), '-i', str(src_b), '-filter_complex', graph, '-map', '[v]',
          '-frames:v', str(frames), '-an'] + ENC + [str(out)])


def norm_still(picture, frames, out, beat_phase=None, period=None):
    """A free CPU cutaway: the stage picture with a slow push-in (1.0 -> 1.08) and soft light pulses on the beat."""
    n = max(1, frames)
    pulse = ''
    if period:
        ph = (beat_phase or 0.0) % period
        pulse = f",eq=brightness='0.07*lt(mod(t-{ph:.3f}+{period * 100:.3f},{period:.4f}),0.12)':eval=frame"
    vf = (f"{NINE16},scale={OUT_W * 2}:{OUT_H * 2}:flags=lanczos,"
          f"zoompan=z='1+0.08*on/{n}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={OUT_W}x{OUT_H}:fps={FPS}"
          f'{pulse},setsar=1,format=yuv420p')
    _run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-framerate', str(FPS), '-i', str(picture), '-vf', vf,
          '-frames:v', str(n)] + ENC + [str(out)])


def pill_png(text, path, size=34, colour=(22, 19, 16, 225), max_w=OUT_W - 60):
    """A rounded label (white text) as an RGBA PNG; text keeps only what the font draws (no emoji)."""
    text = ''.join(ch for ch in str(text) if ord(ch) < 0x2000 or ch in TEXT_OK).strip()
    font = ImageFont.truetype(FONT, size)
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    while probe.textlength(text, font=font) > max_w - 40 and len(text) > 4:
        text = text[:-2].rstrip() + '…'
    w = int(probe.textlength(text, font=font)) + 40
    h = size + 26
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=colour)
    d.text((w / 2, h / 2), text, font=font, fill='white', anchor='mm')
    img.save(path)
    return path


def _last_frame(src, out):
    _run(['ffmpeg', '-v', 'error', '-y', '-sseof', '-0.2', '-i', str(src), '-frames:v', '1', '-update', '1', str(out)])


def outro_clip(last_video, endcard, frames, out, next_part=None):
    """The Follow me ending: the last frame held, blurred and darkened, under the owner's follow card (and "Part n
    next" on a series part)."""
    folder = Path(out).parent
    still = folder / 'outro_still.png'
    _last_frame(last_video, folder / 'outro_last.png')
    base = Image.open(folder / 'outro_last.png').convert('RGB').resize((OUT_W, OUT_H))
    base = Image.eval(base.filter(ImageFilter.GaussianBlur(18)), lambda v: int(v * 0.55)).convert('RGBA')
    if endcard and Path(endcard).exists():
        card = Image.open(endcard).convert('RGBA').resize((OUT_W, OUT_H))
        base.alpha_composite(card)
    if next_part:
        pill_png(f'Part {next_part} next', folder / 'outro_pill.png', size=36)
        p = Image.open(folder / 'outro_pill.png')
        base.alpha_composite(p, ((OUT_W - p.width) // 2, int(OUT_H * 0.12)))
    base.convert('RGB').save(still)
    _run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-framerate', str(FPS), '-i', str(still), '-vf',
          'format=yuv420p', '-frames:v', str(frames)] + ENC + [str(out)])


def lead_clip(job, frames, out):
    """The Real -> AI start: the first singer's real clip, up to its picked moment, as 720x1280 frames."""
    s = job['singers'][0]
    src = W.local_file(job, s['real'])
    at = float(s.get('real_at') or s.get('real_s') or 0)
    start = max(0.0, at - frames / FPS)
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-vf', _fit(start), '-frames:v', str(frames), '-an'] + ENC
         + [str(out)])


def outro_seconds(job):
    """The Follow me ending's seconds (0 without it: off, a friend's video, or no follow card)."""
    has_card = (W.job_dir(job['id']) / 'endcard.png').exists() and job.get('owner', 'me') == 'me'
    return OUTRO if job.get('outro') and has_card else 0.0


def lead_seconds(job):
    """The opening's real seconds (0 without a real clip or with the opening off)."""
    if not job.get('opening'):
        return 0.0
    s = (job.get('singers') or [{}])[0]
    if not s.get('real') or float(s.get('real_s') or 0) < LEAD_MIN:
        return 0.0
    return round(min(LEAD, float(s.get('real_at') or s.get('real_s') or 0) or LEAD), 3)


def segments(job, a, b, work, pack):
    """The stage part of [a, b]: one normalized 720x1280 file per shot (or the piece of it inside [a, b]).
    Returns [(file, frames)]; a shot not sung (or that failed twice) shows its stage picture there."""
    out = []
    period = bar_of(pack) / 4
    beat0 = (pack.get('beats') or [0.0])[0] if pack.get('beats') else 0.0
    for s in job['shots']:
        x, y = max(s['from'], a), min(s['to'], b)
        if y - x <= 1e-6:
            continue
        frames = frames_between(a, x, y)
        if frames <= 0:
            continue
        seg = work / f"seg_{s['k']}_{int(round(x * 1000))}_{frames}.mp4"
        files = s.get('files') or []
        if s['kind'] != 'cutaway' and s.get('done') and files:
            offset = x - s['render_from']
            srcs = [W.local_file(job, f) for f in files]
            if s['kind'] == 'split' and len(srcs) == 2:
                norm_split(srcs[0], srcs[1], offset, frames, seg)
            else:
                norm_render(srcs[0], offset, frames, seg)
        else:
            angle = s['angle'] if s['angle'] in (job.get('angles') or {}) else None
            if angle is None:
                angle = next((a_ for a_ in (s.get('angles') or []) if a_ in job['angles']), None) or \
                    angle_first(job['angles'])
            norm_still(W.local_file(job, job['angles'][angle]), frames, seg, beat0 - x, period)
        out.append((seg, frames))
    return out


def concat(files, out):
    lst = Path(out).with_suffix('.txt')
    lst.write_text(''.join(f"file '{Path(f).resolve()}'\n" for f in files))
    _run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(out)])
    lst.unlink(missing_ok=True)


def render(job, a, b, out, pack, d, part=None, opening=True, outro=True, audio=True, test_label=None):
    """One finished video of [a, b] (song clock): [Real -> AI start] + the shots + [Follow me ending], the pills,
    the name tag, and the song (or the animals' voices) at -14 LUFS, exactly as long as the video. part: (n, N)
    on a series part. Returns {'frames', 'lead', 'seconds', 'outro', 'sound_start'}."""
    folder = W.job_dir(job['id'])
    work = folder / f'join_{os.getpid()}_{threading.get_ident()}_{random.randint(0, 10 ** 9)}'  # (its own: Watch so
    work.mkdir(parents=True)  # far may be cut while the job is being joined)
    try:
        return _render(job, a, b, out, pack, d, part, opening, outro, audio, test_label, folder, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _render(job, a, b, out, pack, d, part, opening, outro, audio, test_label, folder, work):
    segs = segments(job, a, b, work, pack)
    body = sum(f for _, f in segs)
    lead = lead_seconds(job) if opening else 0.0
    lead_f = int(round(lead * FPS))
    pieces = []
    if lead_f:
        try:
            lead_clip(job, lead_f, work / 'lead.mp4')
            pieces.append(work / 'lead.mp4')
        except Exception as e:  # (the opening must never cost a video)
            log.warning('sing: no opening for %s (%s)', job['id'], e)
            lead_f, lead = 0, 0.0
    pieces += [f for f, _ in segs]
    has_card = (folder / 'endcard.png').exists() and job.get('owner', 'me') == 'me'
    outro_f = int(round(OUTRO * FPS)) if outro and job.get('outro') and has_card else 0
    if outro_f:
        nxt = part[0] + 1 if part and part[0] < part[1] else None
        try:
            outro_clip(segs[-1][0], folder / 'endcard.png', outro_f, work / 'outro.mp4', nxt)
            pieces.append(work / 'outro.mp4')
        except Exception as e:
            log.warning('sing: no ending for %s (%s)', job['id'], e)
            outro_f = 0
    concat(pieces, work / 'body.mp4')
    total = lead_f + body + outro_f
    # the overlays: title pill (3 s after the start of the stage), Part n/N, the name tag, the TEST badge
    inputs, chain, k = [], '[0:v]', 1
    graph = []
    zoom = beat_zooms(job, pack, a, b, lead_f / FPS) if job.get('beat_zooms', True) and not test_label else ''
    if zoom:  # a small punch-in on the chorus's downbeats (every 2 bars), no sound effects over a song
        graph.append(f'{chain}{zoom}[z]')
        chain = '[z]'
    if lead_f:  # the soft flash at the switch to the stage
        graph.append(f"{chain}eq=brightness='0.35*max(0,1-(t-{lead:.3f})/0.25)*gte(t,{lead:.3f})':eval=frame[f]")
        chain = '[f]'
    over = []
    title, artist = song_title(job.get('song_name'))
    if job.get('title_on', True) and not test_label:
        over.append((pill_png(f"♪ {title}" + (f' · {artist}' if artist else ''), work / 'title.png'), '(W-w)/2', 60,
                     lead, lead + TITLE_SECONDS))
    if part and part[1] > 1:
        over.append((pill_png(f'Part {part[0]}/{part[1]}', work / 'part.png', size=30), 'W-w-24', 60 + 72, 0,
                     total / FPS))
    if test_label:
        over.append((pill_png(test_label, work / 'test.png', size=30, colour=(214, 40, 40, 235)), 'W-w-24', 24, 0,
                     total / FPS))
    badge = folder / 'badge.png'
    if job.get('brand', True) and job.get('has_badge') and badge.exists():
        over.append((badge, '24', int(OUT_H * 0.62), 0, (lead_f + body) / FPS))
    for png, x, y, t0, t1 in over:
        inputs += ['-i', str(png)]
        graph.append(f"{chain}[{k}:v]overlay=x={x}:y={y}:enable='between(t,{t0:.3f},{t1:.3f})'[o{k}]")
        chain = f'[o{k}]'
        k += 1
    graph.append(f'{chain}format=yuv420p[v]')
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', str(work / 'body.mp4')] + inputs
    sound_start = round(a - lead_f / FPS, 2)
    if audio:
        wav = work / 'audio.wav'
        x = sa.render_song(str(song_path(job)), str(d) if d else None, a, body / FPS, voices_of(job), animals_of(job),
                           job_spans(job, pack), lead=lead_f / FPS, tail=outro_f / FPS)
        x = x[:int(round(total * sa.SR / FPS))]
        x = np.pad(x, ((0, max(0, int(round(total * sa.SR / FPS)) - len(x))), (0, 0)))
        sa.save(str(wav), x)
        cmd += ['-i', str(wav)]
        amap = ['-map', f'{k}:a', '-c:a', 'aac', '-b:a', '192k']
    else:
        amap = ['-an']
    cmd += ['-filter_complex', ';'.join(graph), '-map', '[v]'] + amap + \
        ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', str(FPS),
         '-frames:v', str(total), '-movflags', '+faststart', str(out)]
    _run(cmd)
    return {'frames': total, 'lead': lead_f / FPS, 'seconds': body / FPS, 'outro': outro_f / FPS,
            'sound_start': sound_start}


def beat_zooms(job, pack, a, b, lead):
    """meme.py's beat punch on every second bar line of the chorus inside [a, b] (video time = lead + song time - a),
    as a scale+crop filter ('' when there are none, or without meme.py). The frames stay exactly the same."""
    meme = getattr(W, 'meme', None)
    beats_ = pack.get('beats') or []
    if not meme or len(beats_) < 8:
        return ''
    bar0 = min(range(4), key=lambda i: -sum(1 for x in beats_[i::4] if kind_at(pack, x, x + 0.01) == 'chorus'))
    hits = [x for x in beats_[bar0::8] if a + 0.5 <= x <= b - 0.5 and kind_at(pack, x, x + 0.01) == 'chorus']
    punches = [dict(meme.BEAT_PUNCH, t0=round(lead + x - a - meme.LEAD, 3)) for x in hits[:40]]
    return meme.zoom_filter(punches, OUT_W, OUT_H)


def song_path(job):
    if job.get('song_local'):
        return W.local_file(job, 'song.m4a')
    return W.song_file(job['song_id'])


def voices_of(job):
    v = list(job.get('voices') or [])
    return (v + ['original'] * len(job['singers']))[:len(job['singers'])]


def animals_of(job):
    return [s.get('animal') or 'animal' for s in job['singers']]


def job_spans(job, pack):
    """Who sings what in this job (share(): the plan, every shot and the mix agree), on the lines the job was
    planned with (job_pack)."""
    return share(job_pack(job, pack), len(job['singers']), job_rule(job), job_choices(job),
                 job.get('part_from') or 0.0, job.get('part_to'))


def mouth_sig(spans, who, start, seconds):
    """Where one singer's mouth track is open inside a render ([[from, to]] on the song's clock, 0.01 s): a sung
    shot keeps it, so a re-plan keeps the shot only where the mix gives that singer the same lines."""
    out = []
    for s in sorted(spans, key=lambda x: x['start']):
        if who not in s['who']:
            continue
        x, y = max(float(s['start']), start), min(float(s['end']), start + seconds)
        if y - x > 0.02:
            out.append([round(x, 2), round(y, 2)])
    return out


def mouths_of(shot, spans):
    """The mouth signatures of a shot's renders ('A', 'B'; a PC duet keeps both singers')."""
    start, seconds = float(shot['render_from']), render_seconds(shot)
    keys = ['A', 'B'] if shot['kind'] in ('duet', 'split') else [shot.get('who') if shot.get('who') in ('A', 'B')
                                                                  else 'A']
    return {r: mouth_sig(spans, 0 if r == 'A' else 1, start, seconds) for r in keys}


def split_posts(pack, a, b, lead=LEAD, outro=OUTRO):
    """The TikTok parts of [a, b]: one when it fits in POST_MAX seconds of song (the opening and the ending count:
    the song plays under them), else N parts of about equal length, each cut at the line start nearest its share."""
    room = POST_MAX - lead - outro
    if b - a <= room + 1e-6:
        return [(a, b)]
    n = math.ceil((b - a) / room - 1e-9)
    starts = sorted(float(ln['start']) for ln in pack['lines'] if a < float(ln['start']) < b)
    cuts, t = [a], a
    for k in range(1, n):
        want = a + (b - a) * k / n
        near = [s for s in starts if t + 5 <= s <= t + room and abs(s - want) <= 6]
        cut = min(near, key=lambda s: abs(s - want)) if near else min(want, t + room)
        cuts.append(cut)
        t = cut
    cuts.append(b)
    out = list(zip(cuts, cuts[1:]))
    if out[-1][1] - out[-1][0] > room + 1e-6:  # (the line starts didn't fall well: plain shares)
        return split_posts({'lines': []}, a, b, lead, outro)
    return out


def caption(job):
    """The TikTok caption's first line (the same for the video every time it is re-cut) and the song credit."""
    title, artist = song_title(job.get('song_name'))
    singers = job['singers']
    pick = random.Random(job['id'])
    if len(singers) > 1:
        line = pick.choice(DUET_CAPTIONS).format(song=title, a=singers[0]['animal'] or 'cat',
                                                  b=singers[1]['animal'] or 'dog')
    else:
        animal = singers[0]['animal'] or 'pet'
        line = pick.choice(CAPTIONS).format(song=title, animal=animal, Animal=animal.capitalize())
    credit = f'♪ {artist} – {title}' if artist else f'♪ {title}'
    return line, credit


def join_sing(job, pack, d):
    """final.mp4 (the master), part_<n>.mp4 (59 s of song or less each, on a series), tiktok.mp4 (the no-song cut,
    with the sound start to add in TikTok), thumb.jpg, the caption. The job is done."""
    folder = W.job_dir(job['id'])
    a, b = job['part_from'], job['part_to']
    draft = job.get('draft')
    if draft:  # (Preview first: the first sung shot, with the song)
        first = next((s for s in job['shots'] if s.get('done')), job['shots'][0])
        b = min(b, first['to'])
    W.update(job, stage='Putting your music video together…', progress=0.95)
    test_label = f"TEST · {title_name(job['test_engine'])}" if job.get('test') else None
    got = render(job, a, b, folder / 'final.new.mp4', pack, d, test_label=test_label,
                 outro=not job.get('test'), opening=not job.get('test'))
    os.replace(folder / 'final.new.mp4', folder / 'final.mp4')
    files = ['final.mp4']
    posts = []
    if not draft and not job.get('test'):
        lead = got['lead']
        planned = [(float(p['from']), float(p['to'])) for p in job.get('posts') or []]
        room = POST_MAX - max(lead, 0.0) - got['outro']
        if len(planned) > 1 and abs(planned[0][0] - a) < 0.02 and abs(planned[-1][1] - b) < 0.02 and \
                all(y - x <= room + 0.02 for x, y in planned):  # (an edit since may have added the opening)
            ranges = planned  # (the parts planned with the shots: one made while the rest was sung stays the same)
        else:
            ranges = split_posts(pack, a, b, lead=max(lead, 0.0), outro=got['outro'])
        if len(ranges) == 1:
            posts = [{'n': 1, 'from': a, 'to': b, 'file': 'final.mp4', 'ready': True, 'sound_start': got['sound_start']}]
        else:
            for n, (x, y) in enumerate(ranges, 1):
                name = f'part_{n}.mp4'
                r = render(job, x, y, folder / name, pack, d, part=(n, len(ranges)), opening=n == 1)
                posts.append({'n': n, 'from': round(x, 2), 'to': round(y, 2), 'file': name, 'ready': True,
                              'sound_start': r['sound_start']})
                files.append(name)
        for p in posts:  # the no-song cuts (TikTok's own sound added at sound_start)
            src = folder / p['file']
            cut = 'tiktok.mp4' if p['file'] == 'final.mp4' else f"tiktok_{p['n']}.mp4"
            _run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-map', '0:v', '-c', 'copy', '-an',
                  '-movflags', '+faststart', str(folder / cut)])
            p['cut'] = cut
            files.append(cut)
        if len(posts) > 1:
            _run(['ffmpeg', '-v', 'error', '-y', '-i', str(folder / 'final.mp4'), '-map', '0:v', '-c', 'copy', '-an',
                  '-movflags', '+faststart', str(folder / 'tiktok.mp4')])
            files.append('tiktok.mp4')
    if job.get('test'):
        shutil.copy(folder / 'final.mp4', folder / f"test_{job['test_engine']}.mp4")
        files.append(f"test_{job['test_engine']}.mp4")
    at = got['lead'] + min(1.0, got['seconds'] / 2)
    _run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{at:.3f}', '-i', str(folder / 'final.mp4'), '-frames:v', '1',
          '-vf', 'scale=360:-2', str(folder / 'thumb.new.jpg')])
    os.replace(folder / 'thumb.new.jpg', folder / 'thumb.jpg')
    files.append('thumb.jpg')
    line, credit = caption(job)
    tags = ' '.join(dict.fromkeys(['#tendha2', f"#singing{(job['singers'][0]['animal'] or 'pet').split()[-1]}"] +
                                  TAGS.split()))
    made = {}
    for s in job['shots']:
        for k_, v in (s.get('made_with') or {}).items():
            made[k_] = made.get(k_, 0) + v
    rev = (job.get('rev') or 0) + 1
    _, _, seconds_long = W.probe(folder / 'final.mp4')
    sung = round(sum(s['sung'] for s in job['shots'] if s.get('done')), 1)
    note = ''
    if draft:
        note = 'Preview: the first shot. Tap Finish to sing the rest.'
    elif job.get('test'):
        note = 'Does the mouth sing with the words?'
    failed = [s['k'] + 1 for s in job['shots'] if s.get('failed')]
    if failed and not job.get('test'):
        note = f"Shot {', '.join(map(str, failed))} didn't come out, so it shows the stage there. ↻ to try again."
    W.update(job, status='done', stage=note, progress=1, error='', thumb='thumb.jpg', rev=rev, posts=posts,
             caption=f'{line}\n{credit}\n{tags}', made_with={'text': line, 'credit': credit, 'ai': True, 'engines': made},
             music_used='mysong', music_start=got['sound_start'], seconds_long=round(seconds_long, 1),
             tiktok_rev=rev if posts else None, sung_s=sung, made=len([s for s in job['shots'] if s.get('done')]),
             opening_s=round(got['lead'], 3) if got['lead'] else None, sing_wait=None,
             test_state='asking' if job.get('test') else job.get('test_state'))
    W.save(job, files)
    return posts


def ready_parts(job, pack, d):
    """A series' parts whose shots are all sung (or given up on) are joined now, each with its no-song cut, and the
    owner is told: "Part 1 of 4 is ready to post" while the rest is still being sung. The final join makes them
    again with the rest (the same ranges)."""
    posts = job.get('posts') or []
    if len(posts) < 2 or job.get('draft') or job.get('test'):
        return
    folder = W.job_dir(job['id'])
    for p in posts:
        if p.get('ready'):
            continue
        inside = [s for s in job['shots'] if s['kind'] != 'cutaway' and s['to'] > p['from'] + 1e-3
                  and s['from'] < p['to'] - 1e-3]
        if not all(s.get('done') or s.get('failed') for s in inside):
            break  # (in order: part 2 is never ready before part 1)
        n, total = p['n'], len(posts)
        name, cut = f'part_{n}.mp4', f'tiktok_{n}.mp4'
        W.update(job, stage=f'Putting part {n} of {total} together…')
        try:
            got = render(job, p['from'], p['to'], folder / f'part_{n}.new.mp4', pack, d, part=(n, total),
                         opening=n == 1)
            os.replace(folder / f'part_{n}.new.mp4', folder / name)
            _run(['ffmpeg', '-v', 'error', '-y', '-i', str(folder / name), '-map', '0:v', '-c', 'copy', '-an',
                  '-movflags', '+faststart', str(folder / cut)])
        except Exception as e:  # (a part made early must never cost the video: the final join makes it)
            log.warning('sing: %s part %d could not be made early (%s)', job['id'], n, e)
            return
        p.update(file=name, cut=cut, ready=True, sound_start=got['sound_start'])
        W.update(job, posts=posts)
        W.save(job, [name, cut])
        log.info('sing: %s part %d of %d is ready', job['id'], n, total)
        title, _ = song_title(job.get('song_name'))
        W.ping(job.get('owner', 'me'), {'title': f'Part {n} of {total} is ready to post',
                                        'body': f"{job.get('label') or title}. Tap to watch and post it."[:180],
                                        'tag': f"antics-{job['id']}-part{n}", 'url': f"index.html#video={job['id']}",
                                        'job': job['id']})


# ---------- a long song's TikTok parts in the posting plan ----------

def plan_parts(job):
    """The part numbers a finished series goes into the posting plan as (each its own post, in order); [] for a
    video of one post."""
    posts = job.get('posts') or []
    return [p['n'] for p in posts if p.get('ready')] if len(posts) > 1 else []


def _post(job, n):
    return next((p for p in job.get('posts') or [] if p.get('n') == n), None)


def part_ready(job, n):
    """The part's no-song cut is there (made with the part)."""
    p = _post(job, n)
    return bool(p and p.get('ready') and p.get('cut'))


def part_label(job, n, label):
    total = len(job.get('posts') or [])
    tail = f' · Part {n}/{total}'
    return (label if len(label) + len(tail) <= 60 else label[:59 - len(tail)].rstrip() + '…') + tail


def part_start(job, n, default):
    p = _post(job, n)
    return p.get('sound_start') if p and p.get('sound_start') is not None else default


def part_caption(job, n, text):
    total = len(job.get('posts') or [])
    return f'{text} · Part {n}/{total}' if text else f'Part {n}/{total}'


_sofar_locks = {}


def sofar(job):
    """Watch so far: the shots sung from the start (no gaps), joined with the song (a quick re-cut, cached; one at a
    time per video, also while the video is being sung)."""
    with lock:
        one = _sofar_locks.setdefault(job['id'], threading.Lock())
    with one:
        return _sofar(job)


def _sofar(job):
    folder = W.job_dir(job['id'])
    pack, d = pack_of(job)
    done = 0
    for s in job['shots']:
        if s['kind'] != 'cutaway' and not s.get('done'):
            break
        done += 1
    if not pack or not done:
        return None
    end = job['shots'][done - 1]['to']
    key = f"{job.get('rev') or 0}-{done}-{end}"
    out = folder / 'sofar.mp4'
    if job.get('sofar_key') == key and out.exists():
        return out
    tmp = folder / f'sofar.{threading.get_ident()}.mp4'
    render(job, job['part_from'], end, tmp, pack, d, outro=False)
    os.replace(tmp, out)
    W.update(job, sofar_key=key)
    return out


# ---------- the job: process, the 5-second test, waits across days ----------

CHECK_SECONDS = 120  # the picture check: singing starts by itself after this long


def needed(job):
    """The shots that need singing (not cutaways, not given up on), in song order; a preview needs only the first."""
    todo = [s for s in job.get('shots') or [] if s['kind'] != 'cutaway' and not s.get('failed')]
    return todo[:1] if job.get('draft') else todo


def needs_animation(job):
    """True while the job still needs the AI (its song's pack, a singer, a stage picture or a shot), False when
    it is only a re-cut (a voice change, the title, the ending ...)."""
    if not job.get('shots') or any(not s.get('pic') for s in job.get('singers') or []):
        return True
    if any(a not in (job.get('angles') or {}) for a in angles_used(job)):
        return True
    return any(not s.get('done') for s in needed(job))


def wait_reason(e):
    """A QuotaError's reason as the job's sing_wait: 'quota' (out of free time, or of Sing's share), 'stopped'
    (Hugging Face started charging: Resume), 'unreadable' (the free time can't be read, so no call is made),
    'starting' (the guard is loading, or couldn't save its note), 'guard' (this worker has no GPU guard yet)."""
    why = getattr(e, 'reason', None) or 'quota'
    return {'loading': 'starting', 'saving': 'starting'}.get(why, why if why in (
        'quota', 'stopped', 'unreadable', 'guard') else 'quota')


def wait_text(job, why=None):
    """The job card while it waits for free GPU time: "Singing 4 of 7 done · next 3 tomorrow after 14:12", or why
    no AI call can be made now (why: wait_reason(), or the guard's own reason)."""
    need = [s for s in job.get('shots') or [] if s['kind'] != 'cutaway']
    done = sum(1 for s in need if s.get('done'))
    left = len(need) - done
    g = guard_view() or {}
    at = g.get('resets_at')
    when = ''
    if at:
        lt = time.localtime(float(at))
        day = 'today' if time.localtime().tm_yday == lt.tm_yday else 'tomorrow'
        when = f' {day} after {lt.tm_hour:02d}:{lt.tm_min:02d}'
    why = {'loading': 'starting', 'saving': 'starting'}.get(why, why)
    if why == 'stopped':
        return 'AI work is stopped: Hugging Face started charging credits. Tap Resume in Settings to go on.'
    if _guard() is None or why == 'guard':
        return ("Singing waits for the GPU guard, which keeps it inside your free time: update your worker "
                '(Settings, Update my worker). Nothing was spent.')
    if why == 'unreadable':
        if g.get('blind') == 'down':
            return ("Your free AI time can't be checked right now (Hugging Face didn't answer), so singing waits. "
                    'It goes on by itself. Nothing was spent.')
        return ("Your Hugging Face key can't read your free AI time, so no AI work is done (it never risks your "
                'credits). Make a new key with Write, then Update my worker with it (Settings). Nothing was spent.')
    if why == 'starting':
        return 'Your worker is still starting. Singing goes on by itself in a few minutes.'
    if not done:
        return f'Out of free singing time for today. It sings {left} shot{"s" * (left != 1)}{when or " tomorrow"}.'
    return f'Singing {done} of {len(need)} done · next {left}{when or " tomorrow"}. Turn on your PC to finish now.'


def process(job, w):
    """Makes a Sing video (the worker's lanes call this for kind 'sing'): the song's pack (waits for it), the singers,
    the plan, the stage pictures (then the picture check: w.Paused, it carries on by itself after 2 minutes), every
    shot (QuotaError / BusyError: the job waits and carries on by itself; PcWait: it waits for the PC), the join."""
    recut = not needs_animation(job)  # (the quick lane: a re-cut on the CPU, which never sings)
    if job.get('picture_check'):  # (✓ Sing now, or 2 minutes passed)
        w.update(job, picture_check=False, checked=True)
    if job.get('sing_wait'):  # (it goes on now: what it waited for is set again if it still has to wait)
        w.update(job, sing_wait=None)
    pack, d = pack_of(job)
    if not pack:
        st = song_state(job['song_id']) if not job.get('song_local') else {'state': 'local'}
        if st.get('state') == 'failed':
            raise RuntimeError(st.get('error') or "The song couldn't be made ready for singing")
        if job.get('song_local'):
            prepare_local(job)
            pack, d = pack_of(job)
        else:
            queue_prepare(job['song_id'])
            title, _ = song_title(job.get('song_name'))
            w.update(job, status='waiting', sing_wait='song', retry_at=time.time() + 3600, progress=0.02,
                     stage=f'Getting {title} ready for singing (voice, music and lines, about 3 min, once)…')
            w.save(job)
            raise w.Paused()
    if job.get('part_from') is None:  # (the song wasn't ready when the job was made: its part now)
        with W.songs_lock:
            song = dict(W.songs.get(job.get('song_id')) or {})
        a, b = part_range(pack, 'test' if job.get('test') else job['part'], job.get('ask_from'), job.get('ask_to'),
                          song)
        if job.get('owner', 'me') != 'me' and not friend_part_ok(pack, job['part'], a, b, song):
            host = w.host_of(w.guests.get(job.get('owner')) or {})
            raise RuntimeError(f'Ask {host} for a part longer than {friend_limit(pack, song):.0f} s')
        if sung_in(pack, a, b) < CUTAWAY_BELOW:
            raise RuntimeError('No singing found in this part. Pick another part.')
        w.update(job, part_from=a, part_to=b)
    if owner_first(job):  # (a friend's video goes after the owner's songs waiting for the GPU)
        w.update(job, status='waiting', retry_at=time.time() + 60, sing_wait='owner', progress=0.02,
                 stage="In line after the owner's songs. It starts by itself.")
        w.save(job)
        raise w.Paused()
    gather(job)
    if not job.get('shots'):
        plan_job(job, pack)
    made = stage_pictures(job)
    if made and not job.get('test') and not job.get('checked'):
        at = time.localtime(time.time() + CHECK_SECONDS)
        w.update(job, status='waiting', picture_check=True, retry_at=time.time() + CHECK_SECONDS, progress=0.2,
                 stage=f'Here are the stage pictures. Singing starts by itself at {at.tm_hour:02d}:{at.tm_min:02d}.')
        w.save(job)
        raise w.Paused()
    todo = needed(job)
    deferred = []
    deadline = float(job.get('pc_deadline') or 0)
    for n, shot in enumerate(todo):
        if shot.get('done'):
            try:
                if all(_have(job, f) for f in shot.get('files') or []):
                    continue
            except w.BusyError:  # (the Hub didn't answer for a moment: the job waits, nothing is sung again)
                w.update(job, sing_wait='busy')
                raise
            if recut:  # (gone from the dataset: sung again, but in the AI lane, never from the quick one)
                log.warning('%s: shot %d is gone from the dataset: sung again in the AI lane', job['id'], shot['k'])
                reset_shot(shot)
                w.update(job, shots=job['shots'], status='queued', stage='In line…', progress=0)
                w.save(job)
                w.enqueue(job)
                raise w.Paused()
        shot['done'] = False
        on_pc = any((shot.get('pc_task') or {}).values())  # (a render the PC is singing, or sent meanwhile)
        if shot['kind'] == 'duet' and not on_pc and pc_can_sing() and 'sing_duet' not in (W.pc.get('can') or ()):
            shot.update(kind='split', angle='split', angles=['closeA', 'closeB'])  # (this PC has no duet model now:
            stage_pictures(job)  # a split screen of the two close-ups, made one by one)
        if pc_share_waits(job, shot) and not pc_can_sing() and not on_pc:
            deferred.append(shot)  # (the PC's share waits for the PC, until the owner's stop time)
            continue
        w.update(job, progress=round(0.25 + 0.65 * n / max(1, len(todo)), 3))
        for attempt in (1, 2):
            try:
                sing_shot(job, shot, pack, d)
                break
            except PcBusy as e:  # (the PC is singing it: the job leaves the AI lane until it is in)
                w.update(job, sing_wait=e.why, shots=job['shots'])
                raise
            except (w.QuotaError, w.BusyError, PcWait) as e:
                if isinstance(e, PcWait) and pc_share_waits(job, shot):  # ("Both": the online shots go on meanwhile)
                    deferred.append(shot)
                    break
                w.update(job, sing_wait=e.why if isinstance(e, PcWait) else 'busy' if isinstance(e, w.BusyError)
                         else wait_reason(e), shots=job['shots'])
                raise
            except ShotFailed as e:
                shot['tries'] = int(shot.get('tries') or 0) + 1
                shot['seed'] = None  # (the next try gets a new seed; the renders already in stay)
                log.warning('%s: shot %d: %s (try %d)', job['id'], shot['k'], e, attempt)
                if attempt == 2 or job.get('test'):
                    shot['failed'] = not job.get('test')
                    if job.get('test'):
                        raise RuntimeError(str(e))
        w.update(job, shots=job['shots'], sung_s=round(sum(s['sung'] for s in job['shots'] if s.get('done')), 1))
        if not deferred and any(not x.get('done') for x in needed(job)):  # (all sung: the join makes them all)
            ready_parts(job, pack, d)  # (a long song: Part 1 can be posted while the rest is still being sung)
    if deferred:
        w.update(job, sing_wait='pc')
        wait = PcWait(f'{len(deferred)} shot{"s" * (len(deferred) != 1)} wait for your PC (until {settings["pc_until"]})')
        wait.wait_seconds = max(60.0, min(wait.wait_seconds, deadline - time.time() + 5))  # (then they go online)
        raise wait
    join_sing(job, pack, d)


def owner_first(job):
    """True when this is a friend's Sing video that still needs the GPU while one of the owner's is in line for it
    (friends' songs go after the owner's, within the owner's share)."""
    if job.get('owner', 'me') == 'me' or not needs_animation(job):
        return False
    return any(o is not job and o.get('kind') == 'sing' and o.get('owner', 'me') == 'me' and o.get('status') == 'queued'
               and needs_animation(o) for o in list(W.jobs.values()))


HUB_RETRY = 180  # seconds before a job tries again when a saved file couldn't be fetched from the dataset


def _have(job, name):
    """True when the job's file is here (fetched back from the dataset after a restart), False only when the
    dataset really doesn't have it (then it is made again). Any other error (a 429 or 5xx from the Hub, no network)
    raises BusyError: the job tries again in a few minutes, and a shot that is already sung is never sung again for
    it."""
    try:
        return W.local_file(job, name).exists()
    except Exception as e:
        if W.not_in_dataset(e):
            return False
        log.warning('%s: %s could not be fetched from the Hub (%s): trying again later', job.get('id'), name, e)
        err = W.BusyError(f"{name} couldn't be fetched from your dataset right now ({str(e)[:120]})")
        err.wait_seconds = HUB_RETRY
        err.stage = "Hugging Face is busy right now (a saved part couldn't be fetched). It goes on by itself."
        raise err


def plan_job(job, pack, keep=None):
    """The job's shot plan (saved before any GPU is used), its sung seconds and its TikTok parts. The first plan
    keeps the song's lines with the job (freeze_lines): a re-plan uses those."""
    W.update(job, **plan_fields(job, pack, keep))
    W.save(job)


def plan_fields(job, pack, keep=None):
    """plan_job's fields for this job (nothing is saved: edit() works them out on a copy of the job first)."""
    freeze_lines(job, pack)
    pack = job_pack(job, pack)
    a, b = job['part_from'], job['part_to']
    n = len(job['singers'])
    eng = 'P' if job.get('engine_choice') == 'pc' or (job.get('test') and job.get('test_engine') == 'P') else \
        (job.get('test_engine') if job.get('test') else (job.get('online') or default_engine() or 'L1'))
    if job.get('test'):  # one 5-second window from the meme part's start: the same seconds on every engine
        eng_window = TEST_SECONDS
        shots = [{'k': 0, 'from': a, 'to': b, 'kind': 'sing', 'angle': 'close', 'who': 'A', 'sung': sung_in(pack, a, b),
                  'window': eng_window, 'pc': False, 'done': False, 'engine': '', 'seed': None, 'tries': 0,
                  'failed': False, 'render_from': a, 'render_to': round(a + eng_window, 3), 'test': True}]
        if keep:
            reuse(shots, keep, share(pack, 1))
    else:
        shots = plan_shots(pack, a, b, n, eng, job_rule(job), job_choices(job), one_shot=job.get('shots_mode') == 'one',
                           both=job.get('engine_choice') == 'both', keep=keep,
                           pc_duet=eng == 'P' and n > 1 and pc_duet_ok())
    ranges = split_posts(pack, a, b, lead=lead_seconds(job), outro=outro_seconds(job))  # (the join's own rule)
    return {'shots': shots, 'sung_total': sung_in(pack, a, b), 'plan_engine': eng,
            'posts': [{'n': i + 1, 'from': round(x, 2), 'to': round(y, 2), 'ready': False}
                      for i, (x, y) in enumerate(ranges)] if not job.get('test') else []}


def prepare_local(job):
    """A friend's own song (kept with that video only): its pack in the video's folder (the quick split)."""
    folder = W.job_dir(job['id'])
    W.update(job, stage='Getting your song ready for singing (about 3 min)…', progress=0.02)
    split = split_engines()
    if not split:
        raise RuntimeError("This worker can't split a song's voice from its music yet. Ask the owner to update it.")
    path = W.local_file(job, 'song.m4a')
    found = W.meme_part(path)
    prepare_song(None, split[0], out=folder / 'song.sing', song_path=path,
                 chorus_info={'start': float(found['start']), 'seconds': MEME_SECONDS, 'bpm': None})
    W.save(job, [f'song.sing/{n}' for n in PACK_FILES])


# ---------- making a Sing job (POST /jobs mode='sing') ----------

def _bool(v, default=False):
    if v is None or v == '':
        return default
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on')


def read_voices(text, n):
    """One voice per singer: a JSON list, a comma list or one word for all (every preset; VOICE_CHOICES)."""
    raw = text
    if isinstance(text, str):
        try:
            raw = json.loads(text) if text.strip()[:1] in '["' else text
        except ValueError:
            raw = text
    if isinstance(raw, str):
        raw = [x for x in re.split(r'[,\s]+', raw) if x] or ['original']
    if not isinstance(raw, list):
        raw = ['original']
    raw = [sa.clean_voice(x) for x in raw] or ['original']
    return (raw + [raw[-1]] * n)[:n]


def read_who(text, pack=None):
    """'turns' (default: each line to one singer, both on each chorus's last line), 'both' (verses each, choruses
    together) or the owner's own choice per line: [{'line': n, 'who': 'A'|'B'|'both'}] (times only, never words)."""
    t = (text or '').strip() if isinstance(text, str) else text
    if not t or t in ('turns', 'alternate'):
        return 'turns'
    if t in ('both', 'together', 'verse_chorus'):
        return 'both'
    try:
        got = json.loads(t) if isinstance(t, str) else t
    except ValueError:
        raise W.HTTPException(400, "Couldn't read who sings which line. Pick them again.")
    if not isinstance(got, list):
        raise W.HTTPException(400, "Couldn't read who sings which line. Pick them again.")
    out = []
    n_lines = len(pack['lines']) if pack else None
    for c in got:
        if not isinstance(c, dict) or c.get('who') not in ('A', 'B', 'both'):
            raise W.HTTPException(400, "Couldn't read who sings which line. Pick them again.")
        line = int(c.get('line', -1))
        if line < 0 or (n_lines is not None and line >= n_lines):
            raise W.HTTPException(400, "That line isn't in the song. Pick the lines again.")
        out.append({'line': line, 'who': c['who']})
    return out


def pc_deadline():
    """The next time the owner's PC stops (settings 'pc_until'): a PC shot still waiting then goes online. On the
    PC's own clock (the helper reads "stop at" on it and says its UTC offset in every hello), else in the posting
    plan's time zone."""
    hh, mm = (int(x) for x in settings['pc_until'].split(':'))
    from datetime import datetime, timedelta, timezone
    tz = None
    with lock:
        offset = settings['pc'].get('utc_offset')
    if isinstance(offset, (int, float)) and not isinstance(offset, bool):
        tz = timezone(timedelta(minutes=int(offset)))
    else:
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo((W.plan_state.get('plan') or {}).get('tz') or 'UTC')
        except Exception:
            tz = None
    now = datetime.fromtimestamp(time.time(), tz or timezone.utc)
    at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if at <= now:
        at += timedelta(days=1)
    return at.timestamp()


def build_jobs(w, who, f):
    """One new Sing video. f: the form (singers, cast_files, real_fps, song_id | song, part, part_from, part_to,
    look, shots, who, voices, sharp, engine, test, test_engine, draft, opening, outro, title_on, badge, endcard).
    A 400/403/409 with a plain reason when something is missing or not allowed."""
    bad = w.HTTPException
    owner = who is w.OWNER
    test = _bool(f.get('test'))
    if test and not owner:
        raise bad(403, f'Only {w.host_of(who)} can run the singing test')
    singers = read_singers(f.get('singers'))
    if test:
        singers = singers[:1]
    w.need_read('songs.json', 'Your songs are')
    song_id = str(f.get('song_id') or '')
    with w.songs_lock:
        known = song_id in w.songs
    upload = f.get('song')
    if not known and upload is None:
        raise bad(400, 'Pick a song for them to sing (My songs, or add one)')
    part = f.get('part') or 'meme'
    if part not in PARTS:
        part = 'meme'
    if test:
        part = 'test'
    if part == 'whole' and not owner:
        raise bad(403, f'Ask {w.host_of(who)} for a whole song')
    engine = f.get('engine') if f.get('engine') in ('online', 'pc', 'both') else 'online'
    if not owner:
        engine = 'online'
    test_engine = None
    if test:
        want = f.get('test_engine') or ''
        test_engine = want if want in TEST_ORDER else next_untested()
        if test_engine is None:
            raise bad(409, 'Every engine was tested. Change one back to untested in Settings to test it again.')
        if engine_state(test_engine) == 'bad':  # ("Test again": the new result replaces the old one)
            set_engine(test_engine, 'untested')
        if test_engine == 'P' and not pc_can_sing():
            engine = 'pc'
    else:
        if engine == 'pc' and engine_state('P') != 'good':
            raise bad(409, 'First, a 5-second test on your PC (Settings, Test singing on my PC)')
        if engine in ('online', 'both') and not default_engine():
            if owner:
                raise bad(409, 'First, a 5-second test: it shows which singing AI works for your animal')
            raise bad(409, f"Singing isn't set up yet. Ask {w.host_of(who)} to run the singing test first.")
    voices = read_voices(f.get('voices') or 'original', len(singers))
    created = time.time()
    job = {'id': f"{time.strftime('%Y%m%d-%H%M%S')}-{w.secrets.token_hex(3)}", 'created': created, 'index': 0,
           'batch': 1, 'group': None, 'status': 'queued', 'stage': 'In line…', 'progress': 0, 'error': '',
           'kind': 'sing', 'owner': who['id'], 'owner_name': '' if owner else who['name'], 'redos': 0,
           'singers': singers, 'song_id': song_id if known else '', 'song_local': False, 'part': part,
           'part_from': None, 'part_to': None, 'ask_from': _num(f.get('part_from')), 'ask_to': _num(f.get('part_to')),
           'look': f.get('look') if f.get('look') in LOOKS else 'studio',
           'shots_mode': 'one' if f.get('shots') == 'one' else 'cuts', 'who': 'turns', 'voices': voices,
           'sharp': 'fast' if f.get('sharp') == 'fast' else 'sharp', 'engine_choice': engine,
           'online': default_engine(), 'test': test, 'test_engine': test_engine, 'test_state': None, 'test_tried': [],
           'draft': _bool(f.get('draft')) and not test, 'opening': _bool(f.get('opening'), True),
           'outro': _bool(f.get('outro'), True), 'brand': True, 'title_on': _bool(f.get('title_on'), True),
           'beat_zooms': _bool(f.get('beat_zooms'), True), 'angles': {}, 'shots': [], 'posts': [],
           'picture_check': False, 'checked': False, 'sung_s': 0.0, 'sung_total': None, 'made': 0, 'wanted': 1,
           'music': 'sing', 'captions': False, 'ideas': [], 'clips_done': [], 'inputs': None,
           'pc_deadline': pc_deadline() if engine == 'both' else None, 'animal': singers[0]['animal'] or 'animal'}
    folder = w.job_dir(job['id'])
    try:
        shared, flags = w.shared_files(who, folder, {'music': 'none'}, None, f.get('badge'), f.get('endcard'))
        keep_singers(singers, f.get('cast_files'), folder, max(10.0, min(60.0, float(_num(f.get('real_fps')) or 30))))
        if not known:  # a new song: the owner's goes to My songs (and gets its pack), a friend's stays with this video
            if owner:
                view = w.add_song(file=upload, name=str(f.get('song_name') or ''), x_antics_key=w.ANTICS_KEY)
                job['song_id'] = view['id']
            else:
                original = folder / 'song_original'
                with open(original, 'wb') as fh:
                    shutil.copyfileobj(upload.file, fh)
                ok = w.extract_sound(original, folder / 'song.m4a')
                original.unlink(missing_ok=True)
                if not ok:
                    raise bad(400, "That song file couldn't be read. Try an MP3 or M4A.")
                job.update(song_local=True, song_name=w.upload_name(upload) or 'Your song')
                shared.append('song.m4a')
        if not job['song_local']:
            with w.songs_lock:
                job['song_name'] = (w.songs.get(job['song_id']) or {}).get('name') or 'My song'
            queue_prepare(job['song_id'])
            pack, _ = pack_of(job)
            if pack is not None:  # (ready: the part and the lines are checked now)
                with w.songs_lock:
                    song = dict(w.songs.get(job['song_id']) or {})
                a, b = part_range(pack, part, job['ask_from'], job['ask_to'], song)
                if not owner and not friend_part_ok(pack, part, a, b, song):
                    raise bad(403, f'Ask {w.host_of(who)} for a part longer than {friend_limit(pack, song):.0f} s')
                if sung_in(pack, a, b) < CUTAWAY_BELOW:
                    raise bad(400, 'No singing found in this part. Pick another part.')
                job.update(part_from=a, part_to=b)
                job['who'] = read_who(f.get('who'), pack) if len(singers) > 1 else 'turns'
            elif len(singers) > 1:
                job['who'] = read_who(f.get('who'))
        elif len(singers) > 1:
            job['who'] = read_who(f.get('who'))
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    job.update(flags)
    job['label'] = job_label(job)
    with w.jobs_lock:
        w.jobs[job['id']] = job
    names = shared + [n for s in singers for n in (s.get('pic'), s.get('real')) if n]
    w.save(job, names)
    return [job]


def _num(v):
    try:
        return None if v is None or v == '' else float(v)
    except (TypeError, ValueError):
        return None


def job_label(job):
    title, _ = song_title(job.get('song_name'))
    names = [s.get('name') or (s.get('animal') or 'animal').capitalize() for s in job['singers']]
    pre = 'Sing test' if job.get('test') else 'Sing'
    return f"{pre}: {title} · {' & '.join(names)}"[:80]


# ---------- what the page sees ----------

def public(job):
    """The Sing fields of a job, next to every video's."""
    shots = [{'k': s['k'], 'from': s['from'], 'to': s['to'], 'kind': s['kind'], 'angle': s.get('angle'),
              'who': s.get('who'), 'sung': s.get('sung'), 'done': bool(s.get('done')), 'failed': bool(s.get('failed')),
              'engine': s.get('engine') or '', 'pc': bool(s.get('pc'))} for s in job.get('shots') or []]
    need = [s for s in shots if s['kind'] != 'cutaway']
    eid = job.get('test_engine')
    out = {'singers': [{'from': s.get('from'), 'animal': s.get('animal') or 'animal', 'name': s.get('name') or '',
                        'look': s.get('look') or '', 'label': s.get('label') or '', 'has_real': bool(s.get('real'))}
                       for s in job.get('singers') or []],
           'song_name': job.get('song_name'), 'part': job.get('part'), 'part_from': job.get('part_from'),
           'part_to': job.get('part_to'), 'look': job.get('look'), 'shots_mode': job.get('shots_mode'),
           'who': job.get('who'), 'voices': voices_of(job) if job.get('singers') else [], 'sharp': job.get('sharp'),
           'engine': job.get('engine_choice'), 'shots': shots, 'shots_done': sum(1 for s in need if s['done']),
           'shots_total': len(need), 'posts': [{k: p.get(k) for k in ('n', 'from', 'to', 'ready', 'sound_start')}
                                               for p in job.get('posts') or []],
           'sung_s': job.get('sung_s') or 0.0, 'sung_total': job.get('sung_total'),
           'picture_check': bool(job.get('picture_check')), 'angles': sorted((job.get('angles') or {}).keys()),
           'title_on': job.get('title_on', True), 'beat_zooms': job.get('beat_zooms', True),
           # (the Real -> AI start needs the first singer's real clip; the ending the owner's follow card)
           'has_hook': bool((job.get('singers') or [{}])[0].get('real')),
           'opening': bool(job.get('opening')) and bool((job.get('singers') or [{}])[0].get('real')),
           'outro': bool(job.get('outro')) and bool(job.get('has_endcard')),
           'sing_wait': job.get('sing_wait'), 'test': bool(job.get('test')), 'editable': not job.get('test'),
           'uses_ai': True, 'pack': song_state(job['song_id']).get('state') if job.get('song_id') else 'local',
           'tiktok_sound': ({'name': song_title(job.get('song_name'))[0], 'start': job.get('music_start')}
                            if job.get('music_start') is not None else None)}
    if job.get('test'):
        tried = list(job.get('test_tried') or [])
        nxt = next_untested(skip=tried + [eid])
        out.update(test_engine=eid, test_engine_name=title_name(eid) if eid else '',
                   test_state=job.get('test_state'),
                   test_clips=[{'engine': e, 'name': title_name(e), 'state': engine_state(e)} for e in tried + (
                       [eid] if eid and eid not in tried and job.get('thumb') else [])],
                   test_next=({'engine': nxt, 'name': ENGINES[nxt]['name'], 'quota_s': ENGINES[nxt]['request'],
                               'spend_s': spend_of(nxt), 'minutes': [round(spend_of(nxt) / 60), round(
                                   ENGINES[nxt]['request'] / 60)]} if nxt else None),
                   test_pc=pc_can_sing())
        if eid == 'P':  # (the PC test's measurements: the card shows them under the clip)
            with lock:
                pcs = dict(settings['pc'])
            out['pc_report'] = {'chunk_s': median(pcs.get('chunk_s')), 'vram_gb': _gb(pcs.get('peak_vram')),
                                'ram_gb': _gb(pcs.get('peak_ram')), 'torch': W.pc.get('torch'),
                                'driver': W.pc.get('driver'), 'size': pcs.get('size')}
    return out


def _gb(text):
    """'7.6 GB' (the helper's peak) -> 7.6."""
    m = re.search(r'\d+(?:\.\d+)?', str(text or ''))
    return float(m[0]) if m else None


def title_name(e):
    """An engine's name at the start of a label ("TEST · Your PC")."""
    name = ENGINES[e]['name']
    return name[:1].upper() + name[1:]


def test_cost(engine=None):
    """GET /sing/test: what the next 5-second test costs, from the engine table and what was measured."""
    e = engine if engine in TEST_ORDER else next_untested()
    g = guard_view() or {}
    if not e:
        return {'engine': None, 'all_tested': True, 'states': {x: engine_state(x) for x in TEST_ORDER}}
    req, spend = ENGINES[e]['request'], spend_of(e)
    pic = 48
    left = g.get('left')
    return {'engine': e, 'name': ENGINES[e]['name'], 'model': ENGINES[e]['model'], 'quota_s': req, 'spend_s': spend,
            'minutes': [max(1, round((spend + pic / 2) / 60)), round((req + pic) / 60)], 'pictures': 1,
            'ready_min': 5 if e != 'P' else 25, 'left': left, 'fits': (left is None or left >= req + pic + 30) and
            share_left() >= spend, 'guard': g != {} or _guard() is not None, 'pc': pc_can_sing(),
            'states': {x: engine_state(x) for x in TEST_ORDER}}


def verdict(w, job, who, answer, go_next=True, next_engine=None):
    """The test card's answer: 'good' (Yes, use this one: that engine becomes the Sing default), 'bad' (No, try
    another engine: the same picture and the same 5 s go to the next untested engine), 'pc' (Try my PC tonight)."""
    if who is not w.OWNER:
        raise w.HTTPException(403, 'Only the owner can do that')
    if not job.get('test'):
        raise w.HTTPException(400, "That isn't a singing test")
    if job['status'] == 'working':
        raise w.HTTPException(409, 'Still singing the test. Answer when it is ready.')
    eid = job['test_engine']
    shot = (job.get('shots') or [{}])[0]
    if answer == 'good':
        if job['status'] != 'done':
            raise w.HTTPException(409, 'Watch the test clip first')
        set_engine(eid, 'good', wall=[shot.get('wall_s')] if shot.get('wall_s') else
                   (settings['engines'].get(eid) or {}).get('wall'), animal=job['singers'][0].get('animal'),
                   job=job['id'], size=ENGINES[eid].get('size'))
        w.update(job, test_state='good', stage='This engine sings for your animal. Make the whole meme part now.')
        w.save(job)
        return job
    if answer not in ('bad', 'pc'):
        raise w.HTTPException(400, "Answer 'good', 'bad' or 'pc'")
    if answer == 'bad' and job['status'] == 'done':
        set_engine(eid, 'bad', job=job['id'], animal=job['singers'][0].get('animal'))
    tried = list(dict.fromkeys(list(job.get('test_tried') or []) + ([eid] if job.get('thumb') else [])))
    nxt = 'P' if answer == 'pc' else (next_engine if next_engine in TEST_ORDER and next_engine != eid and
                                      engine_state(next_engine) == 'untested' else next_untested(skip=tried + [eid]))
    if not go_next and answer == 'bad':
        w.update(job, test_state='bad', test_tried=tried)
        w.save(job)
        return job
    if nxt is None:
        w.update(job, test_state='all_bad', test_tried=tried,
                 stage="The AI can't make this animal sing well yet. Try another animal, or Dance to the song.")
        w.save(job)
        return job
    if engine_state(nxt) == 'bad':  # ("Try my PC tonight" after the PC once failed: a new result replaces it)
        set_engine(nxt, 'untested')
    reset_shot(shot, engine='')
    w.update(job, test_engine=nxt, test_state=None, test_tried=tried, status='queued', stage='In line…',
             engine_choice='pc' if nxt == 'P' else 'online', thumb=job.get('thumb'), error='', retry_at=None,
             label=job_label(job), shots=job['shots'])
    w.save(job)
    w.enqueue(job)
    return job


def finish(w, job, who):
    """POST /jobs/{id}/finish: a preview -> every shot; an approved test -> the whole meme part (its test clip is
    the first window when the times match, so it needs only 2-3 more calls)."""
    with w.jobs_lock:
        if job['status'] == 'working':
            raise w.HTTPException(409, 'Still working on this one. Finish it when it is ready.')
    if job.get('test'):
        if job.get('test_state') != 'good':
            raise w.HTTPException(409, 'Tap "Yes, use this one" first (or try another engine)')
        pack, _ = pack_of(job)
        old = [dict(s) for s in job['shots']]
        eid = job['test_engine']
        with w.songs_lock:
            song = dict(w.songs.get(job.get('song_id')) or {})
        a, b = part_range(pack, 'meme', song=song)
        job.update(test=False, part='meme', part_from=a, part_to=b, online=eid if eid != 'P' else default_engine(),
                   engine_choice='pc' if eid == 'P' else 'online', draft=False, checked=True)
        job['label'] = job_label(job)
        plan_job(job, pack, keep=old)
    else:
        job['draft'] = False
    w.update(job, status='queued', stage='In line…', error='', retry_at=None, progress=0)
    w.save(job)
    w.enqueue(job)
    return job


# ---------- edits ----------

def edit(w, job, who, f):
    """POST /jobs/{id}/edit for a Sing video. Re-cuts only (seconds, no AI): voices (a re-mix: the mouths were
    sung from the original vocal), title, ending, opening, name tag, beat zooms, a part inside the one sung.
    New singing: who sings a line, a part that needs new shots, ↻ one shot (redo), a shot's angle, ↻ the pictures,
    the look, one shot / music video. Shots already sung stay wherever their times still match. A friend's edit
    that goes back to the AI (a sung shot thrown away, new stage pictures) counts toward their redos. The edit is
    worked out on a copy of the job: one that is refused (400/403) leaves the video exactly as it was."""
    with w.jobs_lock:
        if job['status'] == 'working':
            raise w.HTTPException(409, 'Still working on this one. Edit it when it is ready.')
    if job.get('test'):
        raise w.HTTPException(409, 'This is the singing test. Answer it, then make the real video.')
    pack, _ = pack_of(job)
    if pack is None or not job.get('shots'):
        raise w.HTTPException(409, 'Wait for the first version, then edit it.')
    with w.jobs_lock:
        new = copy.deepcopy(job)  # (the edit itself: only copied into the job once it is allowed)
    old = copy.deepcopy(new['shots'])
    old_angles = dict(new.get('angles') or {})
    changed = {}
    if f.get('voices') is not None:
        changed['voices'] = read_voices(f['voices'], len(new['singers']))
    for key in ('opening', 'outro', 'brand', 'title_on', 'beat_zooms'):
        if f.get(key) is not None:
            changed[key] = _bool(f[key])
    replan = False
    if f.get('who') is not None and len(new['singers']) > 1:
        new_who = read_who(f['who'], pack)
        if new_who != new.get('who'):
            changed['who'], replan = new_who, True
    if f.get('shots') in ('cuts', 'one') and f['shots'] != new.get('shots_mode'):
        changed['shots_mode'], replan = f['shots'], True
    if f.get('part') in PARTS or f.get('part_from') is not None:
        part = f.get('part') if f.get('part') in PARTS else 'custom'
        if part == 'whole' and who is not w.OWNER:
            raise w.HTTPException(403, f'Ask {w.host_of(who)} for a whole song')
        with w.songs_lock:
            song = dict(w.songs.get(new.get('song_id')) or {})
        a, b = part_range(pack, part, _num(f.get('part_from')), _num(f.get('part_to')), song)
        if who is not w.OWNER and not friend_part_ok(pack, part, a, b, song):
            raise w.HTTPException(403, f'Ask {w.host_of(who)} for a part longer than {friend_limit(pack, song):.0f} s')
        if sung_in(pack, a, b) < CUTAWAY_BELOW:
            raise w.HTTPException(400, 'No singing found in this part. Pick another part.')
        if (a, b) != (new['part_from'], new['part_to']):
            changed.update(part=part, part_from=a, part_to=b)
            replan = True
    redo = {int(n) for n in re.findall(r'\d+', str(f.get('redo') or ''))}
    angles_in = {}
    if f.get('angles'):
        try:
            angles_in = {int(k): v for k, v in json.loads(f['angles']).items() if v in ('close', 'medium', 'wide')}
        except (ValueError, AttributeError):
            raise w.HTTPException(400, "Couldn't read the new angles")
    repicture = f.get('repicture')
    new_look = f.get('look') if f.get('look') in LOOKS and f.get('look') != new.get('look') else None
    new.update(changed)
    angles = dict(old_angles)
    if new_look:
        new['look'] = new_look
        angles = {}
    elif repicture:
        names = [x for x in re.split(r'[,\s]+', str(repicture)) if x in angles] if repicture not in (True, 'true', '1',
                                                                                                      'all') else []
        for name in names or list(angles):
            angles.pop(name, None)
    new['angles'] = angles
    if replan:
        new.update(plan_fields(new, pack, keep=old))
    for s in new['shots']:
        k = s['k']
        if k in angles_in and s['kind'] == 'sing' and len(new['singers']) == 1 and angles_in[k] != s['angle']:
            reset_shot(s, angle=angles_in[k])
        if k in redo and s['kind'] != 'cutaway':
            reset_shot(s)
        if s['kind'] != 'cutaway' and any(a_ not in angles for a_ in (s.get('angles') or [] if s['kind'] == 'split'
                                                                        else [s['angle']])):
            reset_shot(s)
    # What goes back to the AI: a sung render thrown away, a stage picture dropped, or one the new plan needs that
    # the video didn't need before. (Compared with the job as it was, never with the edit's own copy.)
    sung = {x for s in job['shots'] if s.get('done') for x in s.get('files') or []}
    lost = sung - {x for s in new['shots'] if s.get('done') for x in s.get('files') or []}
    dropped = [a_ for a_ in old_angles if a_ not in angles]
    wanted_before = set(angles_used(job)) - set(old_angles)
    pictures = set(angles_used(new)) - set(angles) - wanted_before
    ai_again = bool(lost or dropped or pictures)
    if who is not w.OWNER and ai_again and job.get('redos', 0) >= w.GUEST_REDOS:
        raise w.HTTPException(403, f'This video used its {w.GUEST_REDOS} new singings. Change its voices or title, '
                                   'or make a new video.')
    if ai_again:
        new['redos'] = job.get('redos', 0) + 1
    if dropped or pictures:  # (new stage pictures get their own 2-minute check)
        new.update(checked=False, picture_check=False)
    new['label'] = job_label(new)
    new.update(status='queued', stage='In line…', error='', retry_at=None, progress=0)
    with w.jobs_lock:
        if job['status'] == 'working':
            raise w.HTTPException(409, 'Still working on this one. Edit it when it is ready.')
        job.update(new)
    w.update(job)
    w.save(job)
    w.enqueue(job)
    return {**w.public(job), 'animating': needs_animation(job)}


def redo_shot(w, job, who, k):
    """POST /jobs/{id}/shots/{k}/redo: that shot is sung again (a new seed); the others stay."""
    with w.jobs_lock:
        if job['status'] == 'working':
            raise w.HTTPException(409, 'Still working on this one. Try again when it is ready.')
    return edit(w, job, who, {'redo': str(k)})


# ---------- the song view (GET /songs/{id}/sing) and voice samples ----------

def song_view(song_id, singers=1):
    """{'state', 'split', 'duration', 'bpm', 'lines': [{n, start, end, kind}], 'parts', 'known', 'estimates'} (never
    words). Asks for the pack when it isn't made."""
    with W.songs_lock:
        song = dict(W.songs.get(song_id) or {})
    if not song:
        raise W.HTTPException(404, 'No such song')
    st = song_state(song_id)
    if st.get('state') not in ('ready', 'queued', 'preparing'):
        if st.get('state') != 'failed':
            queue_prepare(song_id)
            st = song_state(song_id)
    busy = prep_state['busy'] == song_id
    known = known_song(song.get('duration'), song.get('name'))
    out = {'id': song_id, 'name': song.get('name'), 'state': st.get('state') or 'queued', 'error': st.get('error') or '',
           'split': st.get('split'), 'best': st.get('best'), 'known': bool(known),
           'duration': song.get('duration'), 'busy': busy, 'voices': True,
           'progress': round(min(0.95, (time.time() - float(st.get('at') or time.time())) / 180), 2) if busy and
           st.get('state') == 'preparing' else None}
    pack, _ = pack_of({'song_id': song_id})
    if pack:
        out.update(state='ready', split=pack.get('split'), duration=pack['duration'], bpm=pack.get('bpm'),
                   meme_start=meme_start(pack, song), progress=None,
                   lines=[{k: ln[k] for k in ('n', 'start', 'end', 'kind')} for ln in pack['lines']],
                   sections=[{k: p.get(k) for k in ('kind', 'start', 'end', 'n')} for p in pack['parts']],
                   parts={}, estimates={})
        for part in ('meme', 'chorus', 'whole'):
            try:
                a, b = part_range(pack, part, song=song)
                out['parts'][part] = {'from': a, 'to': b, 'seconds': round(b - a, 2), 'sung': sung_in(pack, a, b)}
                out['estimates'][part] = estimate(pack, part, max(1, min(2, int(singers))), song=song)
            except Exception as e:
                log.warning('sing: no estimate for %s %s (%s)', song_id, part, e)
    sa.assert_no_words(out, 'song view')
    return out


def voice_sample(song_id, voice, at=None, animal='cat', seconds=4.0):
    """GET /songs/{id}/voice?v=cat&at=49.1: 4 s of the song's singer in that voice over the music (cached m4a)."""
    pack, d = pack_of({'song_id': song_id})
    if not pack:
        raise W.HTTPException(409, 'The song is still being made ready for singing. Try again in a minute.')
    v = sa.clean_voice(voice)
    start = float(at) if at is not None else meme_start(pack)
    start = max(0.0, min(float(pack['duration']) - seconds, start))
    cache = d / f"voice_{v}_{re.sub(r'[^a-z]', '', animal or '')}_{int(round(start * 10))}.m4a"
    if not cache.exists():
        spans = [{'start': ln['start'], 'end': ln['end'], 'who': [0]} for ln in pack['lines']]
        x = sa.render_song(str(W.song_file(song_id)), str(d), start, seconds, [v], [animal or 'cat'], spans,
                           tail=0.3)
        sa.save(str(cache.with_suffix('.part.m4a')), x)
        os.replace(cache.with_suffix('.part.m4a'), cache)
    return cache


# ---------- the PC helper's sing tasks (worker side) ----------

def pc_hello(form):
    """/pc/hello fields: can (comma list: 'sing', 'sing_duet'), vram, ram_gb, torch, driver, until."""
    can = {x.strip() for x in str(form.get('can') or '').split(',') if x.strip()}
    was = 'sing' in (W.pc.get('can') or ())
    W.pc['can'] = sorted(can)
    for k in ('vram', 'ram_gb', 'torch', 'driver', 'until'):
        if form.get(k) not in (None, ''):
            W.pc[k] = str(form[k])[:40]
    changed = False
    if 'sing' in can and bool(settings['pc'].get('duet')) != ('sing_duet' in can):  # (kept: duets are planned
        with lock:  # as one two-shot while the PC is off too)
            settings['pc']['duet'] = 'sing_duet' in can
        changed = True
    offset = _num(form.get('utc_offset'))  # (minutes east of UTC on the PC's clock: "stop at 07:30" is on it)
    if offset is not None and -900 <= offset <= 900 and settings['pc'].get('utc_offset') != int(offset):
        with lock:
            settings['pc']['utc_offset'] = int(offset)
        changed = True
    if changed:
        threading.Thread(target=save_settings, daemon=True).start()
    if 'sing' in can and not was and W.pc_online():  # (e.g. a game closed: the jobs waiting for the PC go on)
        W.wake_waiting(now_anyway=True)
    return {'sing_until': settings['pc_until']}  # (the owner's "stop at": it wins over the helper's --until)


def pc_offer(task):
    """True when the PC asking may take this task: sing tasks only go to helpers that said can=sing."""
    return task.get('kind') != 'sing' or 'sing' in (W.pc.get('can') or ())


def pc_task_view(task):
    """What /pc/next hands the helper for a sing task (the files come from /pc/tasks/{id}/image, /audio?n=,
    /mask?n=; each finished chunk goes back to /pc/tasks/{id}/part?n=k, so a restart costs at most one chunk)."""
    return {'id': task['id'], 'kind': 'sing', 'mode': task['mode'], 'prompt': task['prompt'],
            'seconds': task['seconds'], 'size': task['size'], 'fps': task['fps'], 'seed': task['seed'],
            'chunks': task['chunks'], 'audio': len(task['audio']), 'masks': len(task['masks']),
            'parts_done': sorted(int(k) for k in task['parts']),
            **({'turns': task['turns']} if task.get('turns') else {})}


def pc_part(task, n, video, motion=None):
    """One finished chunk (its video, and its last frames for the next chunk): kept so a restarted helper goes on
    from there."""
    folder = Path(task['out']).parent
    path = folder / f"pcpart_{task['id']}_{int(n)}.mp4"
    with open(path, 'wb') as fh:
        shutil.copyfileobj(video.file, fh)
    entry = {'video': str(path)}
    if motion is not None:
        mpath = folder / f"pcmotion_{task['id']}_{int(n)}.png"
        with open(mpath, 'wb') as fh:
            shutil.copyfileobj(motion.file, fh)
        entry['motion'] = str(mpath)
    task['parts'][str(int(n))] = entry
    task['started'] = time.time()  # (alive: the time limit counts from the newest chunk)
    return {'ok': True, 'parts_done': sorted(int(k) for k in task['parts'])}


def pc_progress(form):
    """The helper's measurements: seconds per chunk, peak VRAM / RAM; the time line uses the median."""
    try:
        sec = float(form.get('chunk_s') or 0)
    except (TypeError, ValueError):
        sec = 0
    with lock:
        if sec > 0:
            settings['pc']['chunk_s'] = (settings['pc'].get('chunk_s') or [])[-19:] + [round(sec, 1)]
        for k in ('peak_vram', 'peak_ram', 'size'):
            if form.get(k):
                settings['pc'][k] = str(form[k])[:20]
    save_settings(hub=time.monotonic() - _committed['at'] >= PROGRESS_COMMIT)  # (not a Hub commit per part)
    return {'ok': True, 'chunk_med': median(settings['pc'].get('chunk_s'))}


# ---------- start-up, health, and the worker's TikTok cut ----------

def ready():
    """'sing' is offered when its pieces import (this file, sing_audio, Together's composer and gather code) and
    the worker can split a song's voice from its music."""
    return W is not None and W.together is not None and bool(split_engines())


def features():
    if not ready():
        return []
    out = ['sing', 'sing_duet']
    if 'roformer' in split_engines():
        out.append('sing_best')
    if _guard() is not None:
        out.append('gpu_guard')
    return out


def health():
    return {'ready': ready(), 'guard': _guard() is not None, 'split': split_engines(), 'pc': pc_can_sing(),
            'default': default_engine(), 'engines': {e: engine_state(e) for e in TEST_ORDER},
            'preparing': prep_state['busy'], 'voices': list(sa.VOICE_CHOICES), 'voice_engine': sa.voice_engine()}


def cut_silent(job, out):
    """The TikTok cut of a Sing video (the posting plan's no-song cut, TikTok's own sound added at its start): the
    same video without its song, the video stream copied (no AI, no re-render)."""
    src = W.local_file(job, 'final.mp4')
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-map', '0:v', '-c', 'copy', '-an', '-movflags', '+faststart',
          str(out)])


def start(w):
    """Called by the worker once its jobs are loaded: the background song preparer, and every My song without a
    pack queued (Детство first)."""
    global W, log
    W, log = w, w.log
    if _started:
        return
    _started.append(True)
    if not W.is_unread(SETTINGS_FILE) and not W.hub and (W.DATA / SETTINGS_FILE).exists():
        try:
            load_settings((W.DATA / SETTINGS_FILE).read_text())
        except Exception as e:
            log.warning('sing: the settings could not be read (%s)', e)
    if not ready():
        log.warning('sing: not offered here (split: %s, together: %s)', split_engines(), bool(W.together))
        return
    threading.Thread(target=prep_loop, daemon=True).start()
    threading.Thread(target=pc_watch, daemon=True).start()  # (jobs whose shot the PC sings: back in line when in)
    for job in list(W.jobs.values()):  # (a shot the PC was singing when the worker restarted: its task is gone, so
        if job.get('kind') == 'sing' and job.get('status') == 'waiting' and job.get('sing_wait') == 'pc_singing':
            W.update(job, status='queued', stage='In line…', retry_at=None)  # it is handed over again; the PC goes
            W.enqueue(job)  # on from the parts it kept)
    try:
        prepare_all()
    except Exception as e:
        log.warning('sing: the songs could not be queued for singing (%s)', e)


def attach(w):
    """Binds this module to the worker before its jobs load (start() runs the threads later)."""
    global W, log
    W, log = w, w.log
