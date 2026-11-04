# worker.py: the Animal Antics background worker. Runs as a free Hugging Face Docker Space.
#
# A job is a link, 1-3 pictures, or "surprise me". The worker gets the video, picks the best
# moments, asks a free Wan 2.2 Space to make each moment act like a human, and joins the clips
# into one 9:16 video for TikTok. Jobs and finished videos are kept in a private HF dataset, so
# nothing is lost when the Space restarts, and jobs that hit the daily free limit finish by
# themselves once it resets.
#
# A video is one continuous shot: each clip after the first starts from the last frame of the clip
# before. A quick preview is just the first clip; Finish carries it on. Every made clip is kept, so
# edits to text, music or speed just re-cut the video in seconds, and Finish animates only what is
# missing. Friends get their own invite key with a number of videos to make.
# The meme edit (meme.py, sfx.py) adds punch-in zooms and cartoon sound effects at the funny moments.
# The Real -> AI opening plays the real video's last seconds before the start picture, then switches to
# the AI with a soft flash and a whoosh; the Follow me ending holds the last frame, blurred, under the
# owner's follow card (drawn by the page). Both are switched on and off by just re-cutting the video.
# The pet voice (voice.py) has the animal say each caption in a funny voice, over the music; it is offered only
# when its packages and model are installed, and switching it or changing the voice also just re-cuts.
# For browsers that can't turn speech into text themselves, the worker writes it down (Whisper).
# When a video that needed the AI is ready (or couldn't be made), the phones of whoever made it get a
# notification (Web Push, webpush.py), also when antics is closed.
# My songs: the owner keeps up to 10 full songs (the account's own sound). Each is cut to its meme part, found
# by chorus.py when it is added (and adjustable), so every video with that song starts right there.
# The Posting plan (posting.py): the owner queues finished videos and gets a reminder at 1-3 times a day, with the
# caption and its hashtags ready, and posts with Share to TikTok. A video with the owner's own song is shared as
# its TikTok cut (the same video without the song: TikTok mutes songs baked into a file); TikTok's sound is added.
# Together (together.py): 2-4 animals in one video: one AI picture of them all that moves, each one its own AI
# moment cut on the beat, or a free look of the real clips (side by side, VS screen, grid, quick cuts) on the CPU.
# The GPU guard (gpu.py): antics only ever uses the owner's FREE ZeroGPU time. Every ZeroGPU call goes through
# gpu.gpu_call(), which checks the account's real quota before and after, one call at a time, and stops all AI work
# if Hugging Face ever bills credits (PRO accounts go past the free time on pre-paid credits by themselves).
# Sing (sing.py, sing_audio.py): 1-2 animals sing a song from My songs, mouth and body moving with the singing, in
# sharp stage shots cut like a music video, each in its own voice; long songs as TikTok parts of 59 s or less.

import collections
import copy
import json
import logging
import math
import os
import queue
import random
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import numpy as np
import requests
from fastapi import Body, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from PIL import Image, ImageDraw, ImageFont

import beats
import gpu
import ideas
from gpu import QuotaError

try:  # meme edits (zoom punch-ins and sound effects); if their files are missing or broken, it runs without them
    import meme
    import sfx
except Exception as e:
    logging.getLogger('antics').warning('no meme edits: %s', e)
    meme = sfx = None
try:  # the pet voice: its packages are imported only when needed, and pet_voice.ready() says if it works here
    import voice as pet_voice
except Exception as e:
    logging.getLogger('antics').warning('no pet voice: %s', e)
    pet_voice = None
try:  # "your video is ready" notifications: they need the cryptography package (else the page doesn't offer them)
    import webpush
except Exception as e:
    logging.getLogger('antics').warning('no notifications: %s', e)
    webpush = None
try:  # finding a song's meme part (if it is missing or broken, a saved song starts at its liveliest part)
    import chorus
except Exception as e:
    logging.getLogger('antics').warning('no meme-part finder: %s', e)
    chorus = None
try:  # the Posting plan (if its file is missing or broken, the worker runs without it and the page doesn't offer it)
    import posting
except Exception as e:
    logging.getLogger('antics').warning('no posting plan: %s', e)
    posting = None

try:  # Together videos (2-4 animals in one); if its file is missing or broken, the worker runs without them
    import together
except Exception as e:
    logging.getLogger('antics').warning('no Together videos: %s', e)
    together = None
THIS = sys.modules[__name__]  # (Together) this worker, for together.py: its storage, engines and video join
try:  # (Sing) animals singing a song; if its files or their packages are missing or broken, the worker runs without
    import sing  # it, and the page doesn't offer it
except Exception as e:
    logging.getLogger('antics').warning('no Sing videos: %s', e)
    sing = None

VERSION = '14'  # (Sing)
HF_TOKEN = os.environ.get('HF_TOKEN') or None
ANTICS_KEY = os.environ.get('ANTICS_KEY', '')
DATASET = os.environ.get('ANTICS_DATASET', '')
DATA = Path(os.environ.get('ANTICS_DATA', '/tmp/antics'))
FONT = os.environ.get('ANTICS_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')

OUT_W, OUT_H, FPS = 720, 1280, 30
MAX_CLIPS = 3
MAX_VIDEOS = 5  # videos made at once from one link or upload
GUEST_REDOS = 3  # times a friend may animate a video's clips again (each edit that re-animates counts once)
SPEEDS = {'slow': 0.8, 'normal': 1.0, 'fast': 1.25}
MUSIC_MODES = ('funny', 'track', 'upload', 'mine', 'none', 'mysong')  # mysong: one of the owner's saved songs
# The Real -> AI opening: the real video's last seconds before the start picture, then the switch to the AI.
HOOK_MAX = 2.0  # seconds of real video kept before each start picture (hook.mp4, FPS frames a second)
HOOK_MIN = 0.8  # less real video than this: no opening
HOOK_WANT = 1.6  # the opening's length, nudged so the switch lands on a beat of the song
FLASH, FLASH_FADE = 0.2, 0.25  # the soft flash at the switch (added brightness, gone after FLASH_FADE seconds)
AI_LABEL_SECONDS = 1.5  # how long the AI label stays after the switch
DUCK = 0.45  # the music's volume under the real seconds (full from the switch on)
WHOOSH_PEAK = 0.27  # seconds from the start of sfx's whoosh to its loudest moment (put on the switch)
# The Follow me ending: the last frame held, blurred and darkened, under the owner's follow card.
OUTRO_SECONDS = 1.5
# My songs: the owner's saved songs, each starting at its meme part.
MAX_SONGS = 10
SONG_MB = 25  # the biggest song file (audio or video) that can be added
# The pet voice: each caption said once, when it shows.
VOICES = ('off', 'auto', 'squeaky', 'deep', 'narrator')  # auto: a voice that suits the animal
VOICE_AT = 0.25  # the pet starts talking this long after its caption shows
VOICE_AFTER_SWITCH = 0.35  # with the opening: this long after the switch to the AI (the whoosh is over by then)
VOICE_GAP = 0.15  # done talking this long before the next caption, or the end of the animated part
VOICE_DUCK = 0.7  # the music (or the video's own sound) goes down to 30 % while the pet talks
VOICE_FX_DUCK = 0.5  # the sound effects to 50 %, so they don't cover a word

# Free Wan image-to-video Spaces, tried in order. They all spend the same daily free GPU time.
# What one call books of the owner's ZeroGPU time (the GPU guard needs it left, plus gpu.MARGIN) depends on the
# picture: booking() works it out with each Space's own code (its app.py as it was on 2026-11-03) and the spaces
# package's rule: the @spaces.GPU duration in whole seconds, x2 on 'xlarge' (x1.5 on 'large'). A Space that sets no
# size is counted x2 too (Hugging Face moves a Space with a big model to xlarge), and seconds are rounded up.
# Pictures keep their own shape (uploads, link thumbnails, the chained start frames), and both Wan 2.2 Spaces fit
# them into 832x480 (resize_image): w x h = 640x640 if square; else 832 on the long side, the other side by the
# aspect, both rounded to 16 and kept within 480..832 (cropped beyond 832:480). So nearly square ones book the most.
#   frames = 1 + clip(round(seconds * 16), 8, 80 (160 for the backup)); f = (frames * w * h / (81*832*624)) ** 1.5
#   Wan 2.2 (sha 1ff7432a, no size): duration = 10 + steps * 15 * f. At 6 steps, 5 s: 9:16 or 16:9 (480x832) 70.7 s
#     -> 142; square 148; 3:4 or 4:3 (624x832) 200; 4:5 (672x832) 222; nearly square (832x832) 148.6 s -> 298.
#   Wan 2.2 backup (sha 4e6a3327, size='xlarge'): duration = (15 + steps * 5 * f) x 1.3 (safe_mode is on by its API
#     default; guidance 1 and frame_multiplier 16 add nothing). 9:16 45.8 s -> 92; 3:4 118; 4:5 128; worst 160.
#   Wan 2.1 backup (sha d8ad2caa, no size): duration = 90 if steps > 4 and seconds > 2, 75 if one of them, else 60.
#     At 4 steps and 3.4 s: 75 -> 150.
# request: the worst case of any picture (used when the picture can't be read). If a Space ever books more, its
# refusal ("Xs requested") or a measured spend raises it for the day (gpu.need()).
ENGINES = [
    {'id': 'zerogpu-aoti/wan2-2-fp8da-aoti-faster', 'name': 'Wan 2.2', 'max_sec': 5, 'extra': {'steps': 6},
     'booking': 'wan22', 'request': 298},
    {'id': 'r3gm/wan2-2-fp8da-aoti-preview', 'name': 'Wan 2.2 backup', 'max_sec': 5,
     'extra': {'steps': 6, 'last_image': None}, 'booking': 'wan22_backup', 'request': 160},
    {'id': 'multimodalart/wan2-1-fast', 'name': 'Wan 2.1 backup', 'max_sec': 3.4, 'extra': {'steps': 4}, 'sized': True,
     'booking': 'wan21', 'request': 150},
]
IMAGE_SPACE = 'black-forest-labs/FLUX.1-schnell'
IMAGE_REQUEST = 120  # FLUX.1-schnell (sha 2569ee41): @spaces.GPU() = the 60 s default, no size -> x2 = 120
SPACE_TIMEOUT = 900  # seconds a Space call may take (then it is cancelled: gpu.wait_job)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('antics')


# QuotaError (gpu.py): no free GPU time for a call (out of today's free time, or the guard stopped AI work).


class BusyError(Exception):
    """Every free GPU is taken right now; worth trying again in a few minutes."""

    wait_seconds = 600


class Paused(Exception):
    """(Together) The job stopped on purpose and waits (its status is set): the picture check."""


def is_quota(msg):
    return gpu.is_refusal(msg)


def is_busy(msg):
    return bool(re.search(r'no gpu was available|queue is full|too many requests|is busy|temporarily unavailable', msg, re.I))


def is_auth(msg):
    return bool(re.search(r'\b401\b|unauthori[sz]ed|invalid (user )?token|invalid username or password', msg, re.I))


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def probe(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration',
         '-of', 'json', str(path)], check=True, capture_output=True, text=True).stdout
    info = json.loads(out)
    stream = info['streams'][0]
    return stream['width'], stream['height'], float(info['format'].get('duration') or 0)


# ---------- Jobs and storage ----------

jobs = {}
jobs_lock = threading.Lock()
work_queue = queue.Queue()  # jobs that need the AI (new clips)
quick_queue = queue.Queue()  # jobs that only need re-cutting, so edits don't wait behind long animations
hub = None
token_ok = True  # False when the Hugging Face key stored in the Space no longer works


def job_dir(job_id):
    path = DATA / 'jobs' / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def public(job):
    keys = ['id', 'created', 'status', 'stage', 'progress', 'error', 'label', 'kind', 'caption', 'sound',
            'made', 'wanted', 'retry_at', 'seconds_long', 'template', 'music', 'track', 'music_used', 'speed', 'idea',
            'owner_name', 'animal', 'song_part', 'song_start', 'has_sound', 'has_song', 'rev', 'group', 'index',
            'batch', 'opening_s', 'song_id', 'music_start']  # song_id: the saved song of music 'mysong'
    view = {k: job.get(k) for k in keys}  # opening_s: the opening's seconds in the current video (None: none)
    view['has_video'] = bool(job.get('thumb'))  # a finished version exists (also while an edit is being made)
    view['has_thumb'] = bool(job.get('thumb'))
    view['draft'] = bool(job.get('draft'))
    view['captions'] = job.get('captions', True)
    view['has_badge'] = bool(job.get('has_badge'))
    view['brand'] = job.get('brand', True) and bool(job.get('has_badge'))
    view['texts'] = [i.get('caption', '') for i in job.get('ideas') or []]
    view['owner'] = job.get('owner', 'me')
    view['redos'] = job.get('redos', 0)
    view['editable'] = job.get('clips_done') is not None and bool(job.get('ideas'))  # not videos from before v7
    view['chained'] = 'chain' in job  # one continuous shot (v10): a preview is just its first part
    view['meme'] = bool(job.get('meme', False))  # videos from before v10 keep their look until it is switched on
    # The opening needs the real seconds before the start picture (kept from a link, or sent by the page with
    # an upload); the ending needs the owner's follow card. Each is on only when the video can have it.
    view['has_hook'] = bool(job.get('hook_frames'))
    view['opening'] = bool(job.get('opening')) and view['has_hook']
    view['has_endcard'] = bool(job.get('has_endcard'))
    view['outro'] = bool(job.get('outro')) and view['has_endcard']
    view['voice'] = job.get('voice') if job.get('voice') in VOICES else 'off'  # the pet voice ('off' before v10)
    # Waiting for the GPU guard (v12.1): 'quota' (out of free AI time until retry_at), 'stopped' (Hugging Face
    # started charging credits: waits for the owner's Resume) or 'unreadable' (the free AI time can't be checked).
    view['gpu_wait'] = job.get('gpu_wait') if job.get('status') == 'waiting' else None
    if job.get('kind') == 'together' and together:  # (Together) its animals, scene, look and picture check
        view.update(together.public(job))
    if job.get('kind') == 'sing' and sing:  # (Sing) its singers, song, part, shots, parts and the test
        view.update(sing.public(job))
    return view


def save(job, files=()):
    """Write the job locally and, when a dataset is set up, to the Hub."""
    save_many([(job, files)])


def save_many(items):
    """Several jobs (and their files) in one Hub commit."""
    ops = []
    for job, files in items:
        job['updated'] = time.time()
        folder = job_dir(job['id'])
        (folder / 'job.json').write_text(json.dumps(job))
        ops.append((f"jobs/{job['id']}/job.json", folder / 'job.json'))
        ops += [(f"jobs/{job['id']}/{name}", folder / name) for name in files]
    if not hub:
        return
    try:
        from huggingface_hub import CommitOperationAdd
        what = f"{items[0][0]['id']}: {items[0][0]['status']}" if len(items) == 1 else f'{len(items)} videos'
        hub.create_commit(DATASET, [CommitOperationAdd(path, str(local)) for path, local in ops],
                          commit_message=what, repo_type='dataset')
    except Exception as e:  # keep working even if the Hub is briefly down
        log.warning('saving %s to the Hub failed: %s', items[0][0]['id'], e)


def local_file(job, name):
    """A job file, fetched from the Hub if this Space restarted since it was made."""
    path = job_dir(job['id']) / name
    if path.exists() or not hub:
        return path
    from huggingface_hub import hf_hub_download
    got = hf_hub_download(DATASET, f"jobs/{job['id']}/{name}", repo_type='dataset', token=HF_TOKEN)
    shutil.copy(got, path)
    return path


def update(job, **fields):
    with jobs_lock:
        job.update(fields)
    (job_dir(job['id']) / 'job.json').write_text(json.dumps(job))


# Dataset files that are there but couldn't be read when the worker started (the Hub can answer 429 or 503 for a
# moment). Until one is read, it is never saved over (that would wipe what it holds: the friends, the songs, the
# phones, the posting plan), what it holds can't be seen or changed (503: still loading, try again in a minute),
# and the worker tries again every minute (and when it is asked for, at most every READ_AGAIN seconds).
unread = {}  # its path in the dataset -> the function that loads its text
unread_tried = {}  # its path -> when it was last tried
unread_reading = set()  # being read again right now (one read of a file at a time)
unread_maybe = set()  # not known to be in the dataset (it couldn't be listed): read once it is known to be absent
unread_lock = threading.Lock()
HUB_TRIES = 3  # reads of a file when the worker starts
HUB_WAIT = 2.0  # seconds before the 2nd read (twice that before the 3rd)
HUB_WAIT_MAX = 30.0  # waiting at most this long in all, so a Hub that is down doesn't hold up the start
READ_AGAIN = 20
JOBS_AGAIN = 10  # videos (job.json) tried again in one round
hub_waited = [0.0]


def hub_text(name, tries=HUB_TRIES):
    """A dataset file's text. Read again a few times when it fails: the Hub can be busy for a moment."""
    from huggingface_hub import hf_hub_download
    for n in range(tries):
        try:
            return Path(hf_hub_download(DATASET, name, repo_type='dataset', token=HF_TOKEN)).read_text()
        except Exception as e:
            wait = HUB_WAIT * (n + 1)
            if n + 1 >= tries or hub_waited[0] + wait > HUB_WAIT_MAX:
                raise
            log.warning('reading %s from the Hub failed (%s); trying again', name, e)
            hub_waited[0] += wait
            time.sleep(wait)


def not_in_dataset(e):
    """The Hub answered that the file isn't there (404), not that it couldn't answer (offline, 5xx...)."""
    names = [c.__name__ for c in type(e).__mro__]
    return 'LocalEntryNotFoundError' not in names and any(n in ('EntryNotFoundError', 'RemoteEntryNotFoundError')
                                                          for n in names)


def read_hub(name, loader, tries=HUB_TRIES):
    """Loads a dataset file with loader(text). When it can't be read, it waits in `unread` to be tried again.
    True when it was read (a file that was read but is broken counts: reading it again wouldn't help). A file in
    `unread_maybe` (the dataset couldn't be listed, so it isn't known if it is there) counts as read when the Hub
    says it isn't there."""
    try:
        text = hub_text(name, tries)
    except Exception as e:
        if name in unread_maybe and not_in_dataset(e):
            log.info('%s is not in the dataset', name)
            with unread_lock:
                unread.pop(name, None)
                unread_maybe.discard(name)
            return True
        log.warning('could not read %s from the Hub (%s); trying again in a minute', name, e)
        with unread_lock:
            unread[name] = loader
            unread_tried[name] = time.time()
        return False
    try:
        loader(text)
    except Exception as e:
        log.warning('could not load %s: %s', name, e)
    with unread_lock:
        unread.pop(name, None)
        unread_maybe.discard(name)
    return True


def is_unread(name):
    with unread_lock:
        return name in unread


def read_again(names=None, now_anyway=True):
    """Tries the files that couldn't be read once more (each at most every READ_AGAIN seconds unless now_anyway;
    a few videos a round). What was waiting for one runs once it is read."""
    with unread_lock:
        todo = [(name, loader) for name, loader in unread.items() if (names is None or name in names)
                and name not in unread_reading
                and (now_anyway or time.time() - unread_tried.get(name, 0) >= READ_AGAIN)]
        videos = [x for x in todo if x[0].endswith('/job.json')][:JOBS_AGAIN]
        todo = [x for x in todo if not x[0].endswith('/job.json')] + videos
        for name, _ in todo:
            unread_tried[name] = time.time()
            unread_reading.add(name)
    for name, loader in todo:
        try:
            if read_hub(name, loader, tries=1):
                log.info('%s read from the Hub at last', name)
                after_read(name)
        finally:
            with unread_lock:
                unread_reading.discard(name)


def after_read(name):
    """What waited for a file that was read late."""
    if name == 'posting.json':
        plan_cuts()
    with unread_lock:
        videos_all_read = not any(n.endswith('/job.json') for n in unread)
    if videos_all_read and (name.endswith('/job.json') or name == 'posting.json'):
        drop_lost()


def need_read(name, what):
    """503 while that file is still unread (it is tried once more first)."""
    if is_unread(name):
        read_again([name], now_anyway=False)
    if is_unread(name):
        raise HTTPException(503, f'{what} still loading. Try again in a minute.')


guests = {}  # friend id -> {id, name, key, uses_left, used, created, host}
guests_lock = threading.Lock()
guests_saving = threading.Lock()


def save_guests():
    """Friends and their remaining videos, kept with the videos so they survive restarts."""
    if is_unread('guests.json'):  # (it would wipe the friends that couldn't be read)
        return
    with guests_saving:  # one save at a time, each with the newest numbers
        with guests_lock:
            data = json.dumps(guests)
        path = DATA / 'guests.json'
        path.write_text(data)
        if not hub:
            return
        try:
            hub.upload_file(path_or_fileobj=str(path), path_in_repo='guests.json', repo_id=DATASET,
                            repo_type='dataset', commit_message='friends')
        except Exception as e:
            log.warning('saving friends to the Hub failed: %s', e)


# The worker's own push key (VAPID, made once) and the phones to notify: 'me' or a friend id -> [subscriptions].
# Kept in push.json with the videos (the private dataset), so they survive restarts and updates.
push = {'vapid': '', 'subs': {}}
push_lock = threading.Lock()
push_saving = threading.Lock()


def save_push():
    """Who gets a notification when a video is ready, and the key they were set up with."""
    if is_unread('push.json'):  # (it would wipe the phones that couldn't be read)
        return
    with push_saving:  # one save at a time, each with the newest list
        with push_lock:
            data = json.dumps(push)
        path = DATA / 'push.json'
        path.write_text(data)
        if not hub:
            return
        try:
            hub.upload_file(path_or_fileobj=str(path), path_in_repo='push.json', repo_id=DATASET,
                            repo_type='dataset', commit_message='notifications')
        except Exception as e:
            log.warning('saving notifications to the Hub failed: %s', e)


def load_guests(text):
    try:
        got = json.loads(text)
        with guests_lock:
            guests.update({k: v for k, v in got.items() if isinstance(v, dict) and v.get('key')})
    except Exception as e:  # (no friends is better than no worker)
        log.warning('could not load friends: %s', e)


def load_push(text):
    try:
        got = json.loads(text)
        push.update(vapid=str(got.get('vapid') or ''), subs=dict(got.get('subs') or {}))
    except Exception as e:  # (no notifications is better than no worker)
        log.warning('could not load notifications: %s', e)


# My songs: id -> {id, name, start, seconds_hint, default, added, candidates, duration}. The list is songs.json and
# each song songs/<id>.m4a, kept with the videos (the private dataset), so they survive restarts and updates.
songs = {}
songs_lock = threading.Lock()
songs_saving = threading.Lock()


def song_file(song_id):
    """A saved song's sound file, fetched from the Hub if this Space restarted since it was added."""
    path = DATA / 'songs' / f'{song_id}.m4a'
    if path.exists() or not hub:
        return path
    from huggingface_hub import hf_hub_download
    path.parent.mkdir(parents=True, exist_ok=True)
    got = hf_hub_download(DATASET, f'songs/{song_id}.m4a', repo_type='dataset', token=HF_TOKEN)
    shutil.copy(got, path)
    return path


def save_songs(added=(), removed=()):
    """The song list (and any song file added or removed) to the Hub in one commit."""
    if is_unread('songs.json'):  # (it would wipe the songs that couldn't be read)
        return
    with songs_saving:  # one save at a time, each with the newest list
        with songs_lock:
            data = json.dumps(songs)
        path = DATA / 'songs.json'
        path.write_text(data)
        if not hub:
            return
        try:
            from huggingface_hub import CommitOperationAdd, CommitOperationDelete
            ops = [CommitOperationAdd('songs.json', str(path))]
            ops += [CommitOperationAdd(f'songs/{i}.m4a', str(DATA / 'songs' / f'{i}.m4a')) for i in added]
            gone = [CommitOperationDelete(f'songs/{i}.m4a') for i in removed]
            try:
                hub.create_commit(DATASET, ops + gone, commit_message='songs', repo_type='dataset')
            except Exception:
                if not gone:
                    raise
                hub.create_commit(DATASET, ops, commit_message='songs', repo_type='dataset')  # (file already gone)
        except Exception as e:
            log.warning('saving songs to the Hub failed: %s', e)


def load_songs(text):
    try:
        got = json.loads(text)
        # (ids become file names: only the ones the worker makes, 8 hex digits)
        songs.update({k: v for k, v in got.items() if re.fullmatch(r'[0-9a-f]{8}', k) and isinstance(v, dict)
                      and v.get('id') == k})
    except Exception as e:  # (no songs is better than no worker)
        log.warning('could not load songs: %s', e)


# The Posting plan (posting.py): the settings, the queue of videos to post, what was posted, which reminder times
# already went. Kept in posting.json with the videos (the private dataset), so it survives restarts and updates.
# There are no secrets in it.
plan_state = posting.fresh() if posting else {}
plan_lock = threading.Lock()
plan_saving = threading.Lock()


def save_plan():
    """The posting plan, here and in the dataset. The scheduler saves before a reminder goes, so a restart never
    sends one twice."""
    if is_unread('posting.json'):  # (it would wipe the plan that couldn't be read)
        return
    with plan_saving:  # one save at a time, each with the newest plan
        with plan_lock:
            data = json.dumps(plan_state)
        path, part = DATA / 'posting.json', DATA / 'posting.json.part'
        part.write_text(data)
        os.replace(part, path)  # (never half a file)
        if not hub:
            return
        try:
            hub.upload_file(path_or_fileobj=str(path), path_in_repo='posting.json', repo_id=DATASET,
                            repo_type='dataset', commit_message='posting plan')
        except Exception as e:
            log.warning('saving the posting plan to the Hub failed: %s', e)


# The GPU guard's state (gpu.py): a stop after Hugging Face billed credits, and the ledger used when the key can't
# read the quota. Kept in gpu.json with the videos (the private dataset), so a restart or an update keeps a stop.
gpu_saving = threading.Lock()


def save_gpu(text, to_hub=True):
    """gpu.json here and (to_hub) in the dataset. False when the Hub save failed (the guard tries again each minute;
    a call whose in-flight note can't be saved doesn't go)."""
    if is_unread('gpu.json'):  # (it would wipe a stop that couldn't be read; no GPU call is made meanwhile)
        return not to_hub
    with gpu_saving:  # one save at a time, each with the newest state
        DATA.mkdir(parents=True, exist_ok=True)
        path, part = DATA / 'gpu.json', DATA / 'gpu.json.part'
        part.write_text(text)
        os.replace(part, path)  # (never half a file)
        store = hub
        if store is None and DATASET and HF_TOKEN:  # (the dataset couldn't be listed at the start: gpu.json still goes)
            from huggingface_hub import HfApi
            store = HfApi(token=HF_TOKEN)
        if not store or not to_hub:
            return True
        try:
            store.upload_file(path_or_fileobj=str(path), path_in_repo='gpu.json', repo_id=DATASET,
                              repo_type='dataset', commit_message='GPU guard')
            return True
        except Exception as e:
            log.warning('saving the GPU guard to the Hub failed: %s', e)
            return False


def gpu_stopped():
    """The owner hears it at once (also with antics closed): the guard stopped all AI work."""
    ping(OWNER['id'], {'title': 'antics stopped all AI work',
                       'body': 'Hugging Face started charging your credits. Open antics to check, then tap Resume.',
                       'tag': 'antics-gpu', 'url': 'index.html'})


gpu.setup(HF_TOKEN, save=save_gpu, pending=lambda: is_unread('gpu.json'), on_stop=lambda: gpu_stopped())


def load_plan(text):
    try:
        got = posting.load(json.loads(text))
        with plan_lock:
            plan_state.clear()
            plan_state.update(got)
    except Exception as e:  # (no plan is better than no worker)
        log.warning('could not load the posting plan: %s', e)


def load_job(text):
    """One video's job.json (a video that was read late: back in line if it wasn't finished)."""
    job = json.loads(text)
    with jobs_lock:
        if job['id'] in jobs:
            return
        jobs[job['id']] = job
    if threads_up.is_set():
        if job['status'] in ('queued', 'working'):
            job['status'] = 'queued'
            enqueue(job)
        want_cut(job)


threads_up = threading.Event()  # the worker's own threads run (a video read late can go in line)


def load_jobs():
    """Bring back jobs after a restart and put unfinished ones back in line."""
    global hub, token_ok
    names = None
    if DATASET and HF_TOKEN:
        from huggingface_hub import HfApi
        try:
            api = HfApi(token=HF_TOKEN)
            api.create_repo(DATASET, repo_type='dataset', private=True, exist_ok=True)
            names = api.list_repo_files(DATASET, repo_type='dataset')
            hub = api
        except Exception as e:
            # Keep running so the app can tell the user to paste a new key, instead of crashing.
            log.error('the Hugging Face key does not work (%s); saved videos are unavailable', e)
            token_ok, names = False, []
            # gpu.json may hold a stop (or a call in flight): no GPU call until it is read, or the Hub says it
            # isn't there (tried again every minute)
            with unread_lock:
                unread_maybe.add('gpu.json')
            read_hub('gpu.json', gpu.load, tries=1)
        loaders = {'guests.json': load_guests, 'push.json': load_push, 'songs.json': load_songs, 'gpu.json': gpu.load}
        if posting:
            loaders['posting.json'] = load_plan
        if sing:  # (Sing) its share of the day, the engines' test results, the PC's measurements
            loaders[sing.SETTINGS_FILE] = sing.load_settings
        for name in names:
            if name in loaders:
                read_hub(name, loaders[name])
            elif name.endswith('/job.json'):
                read_hub(name, load_job)
    else:
        for path in (DATA / 'jobs').glob('*/job.json'):
            job = json.loads(path.read_text())
            jobs[job['id']] = job
        if (DATA / 'guests.json').exists():
            guests.update(json.loads((DATA / 'guests.json').read_text()))
        if (DATA / 'push.json').exists():
            load_push((DATA / 'push.json').read_text())
        if (DATA / 'songs.json').exists():
            load_songs((DATA / 'songs.json').read_text())
        if (DATA / 'posting.json').exists() and posting:
            load_plan((DATA / 'posting.json').read_text())
        if (DATA / 'gpu.json').exists():
            gpu.load((DATA / 'gpu.json').read_text())
    have = set(names) if names is not None else None
    for job in jobs.values():  # (a TikTok cut that is gone, e.g. deleted after it was posted: cut again if needed)
        if job.get('tiktok_rev') is None:
            continue
        name = f"jobs/{job['id']}/tiktok.mp4"
        if not (name in have if have is not None else (DATA / name).exists()):
            job['tiktok_rev'] = None
    for job in sorted(jobs.values(), key=lambda j: (j['created'], j.get('index', 0))):  # oldest first
        if job['status'] in ('queued', 'working'):
            job['status'] = 'queued'
            enqueue(job)
    with unread_lock:
        videos_all_read = not any(n.endswith('/job.json') for n in unread)
    if videos_all_read:
        drop_lost()
    plan_cuts()
    with unread_lock:
        if unread:
            log.warning('not read yet (tried again every minute): %s', ', '.join(sorted(unread)))
    log.info('loaded %d jobs, %d friends, %d songs and %d videos to post', len(jobs), len(guests), len(songs),
             len(plan_state.get('queue') or []))


def plan_cuts():
    """TikTok cuts the posting plan needs that weren't made before the restart."""
    with plan_lock:
        to_cut = {item['job'] for item in plan_state.get('queue') or [] if item['audio'] == 'no_song'}
    for job_id in to_cut:
        want_cut(jobs.get(job_id))


def drop_lost():
    """Videos in the plan whose video is gone (deleted, but the plan's save didn't reach the Hub then) leave the
    plan. Only once every video was read: one that didn't load isn't gone, and comes back when it is read."""
    if not posting or is_unread('posting.json'):
        return
    with plan_lock:
        left = [item for item in plan_state['queue'] if item['job'] in jobs]
        lost = len(plan_state['queue']) - len(left)
        plan_state['queue'] = left
    if lost:
        log.info('%d deleted videos left the posting plan', lost)
        save_plan()


# ---------- Step 1: starting pictures ----------

def sharpness(img):
    grey = np.asarray(img.convert('L').resize((160, max(2, round(160 * img.height / img.width)))), dtype=np.float32)
    lap = grey[1:-1, :-2] + grey[1:-1, 2:] + grey[:-2, 1:-1] + grey[2:, 1:-1] - 4 * grey[1:-1, 1:-1]
    return float(lap.var())


def save_picture(img, path):
    img = img.convert('RGB')
    img.thumbnail((1024, 1024))
    img.save(path, 'JPEG', quality=92)


def download_link(job, folder):
    import yt_dlp
    with_sound = job.get('music') == 'mine'
    opts = {
        'outtmpl': str(folder / 'source.%(ext)s'),
        'format': ('bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b' if with_sound
                   else 'bv*[height<=1080]/b[height<=1080]/bv*/b'),
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'max_filesize': 400 * 1024 * 1024,
        'socket_timeout': 30,
        'retries': 3,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(job['url'], download=True)
    source = next(folder.glob('source.*'))
    site = info.get('extractor_key') or 'Video'
    who = info.get('uploader') or info.get('channel') or ''
    label = f'{site} · {who}' if who else (info.get('title') or site)
    text = ' '.join([info.get('title') or '', info.get('description') or '', ' '.join(info.get('tags') or [])])
    return source, label[:80], text


YOUTUBE_ID = re.compile(r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})')
BROWSER = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
                         '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}


def get_json(url):
    try:
        res = requests.get(url, headers=BROWSER, timeout=20)
        return res.json() if res.ok else {}
    except (requests.RequestException, ValueError):
        return {}


def crop_bars(img):
    """Cut off black bars around a picture (YouTube Shorts frames come pillarboxed)."""
    box = img.convert('L').point(lambda v: 255 if v > 24 else 0).getbbox()
    if box and (box[2] - box[0]) * (box[3] - box[1]) < 0.9 * img.width * img.height:
        return img.crop(box)
    return img


X_STATUS = re.compile(r'(?:twitter\.com|x\.com)/[^/?#]+/status/(\d+)')
VIDEO_FILE = re.compile(r'\.(mp4|mov|m4v|webm|mkv)(\?|$)', re.I)


def fetch_file(url, path):
    with requests.get(url, headers=BROWSER, timeout=120, stream=True) as res:
        res.raise_for_status()
        with open(path, 'wb') as f:
            for chunk in res.iter_content(1 << 20):
                f.write(chunk)
    return path


def fallback_video(job, folder):
    """When yt-dlp is blocked: the real video file via a public route, if the site has one.
    Returns (path, label, text) or None."""
    url = job['url']
    try:
        x = X_STATUS.search(url)
        if x:  # X / Twitter: the public fxtwitter mirror lists the video files
            tweet = get_json(f'https://api.fxtwitter.com/status/{x[1]}').get('tweet') or {}
            videos = (tweet.get('media') or {}).get('videos') or []
            if videos:
                who = (tweet.get('author') or {}).get('screen_name', '')
                return (fetch_file(videos[0]['url'], folder / 'source.mp4'), f'X · @{who}'.strip(' ·@'),
                        tweet.get('text', ''))
        if 'instagram.com' in url:  # Instagram: the public embed page often carries the video file
            code = re.search(r'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)', url)
            if code:
                page = requests.get(f'https://www.instagram.com/p/{code[1]}/embed/captioned/',
                                    headers=BROWSER, timeout=30).text
                found = re.search(r'"video_url"\s*:\s*"([^"]+)"', page)
                if found:
                    video = json.loads(f'"{found[1]}"')  # undo JSON escapes like \u0026
                    return fetch_file(video, folder / 'source.mp4'), 'Instagram', ''
        if VIDEO_FILE.search(url):  # a direct link to a video file
            return fetch_file(url, folder / 'source.mp4'), 'Video file', url.rsplit('/', 1)[-1]
    except (requests.RequestException, ValueError, KeyError, OSError) as e:
        log.warning('%s: fallback download failed: %s', job['id'], e)
    return None


def link_pictures(job, folder, count):
    """When a site blocks the download, use the pictures it shows publicly: preview frames or the cover."""
    url = job['url']
    urls, title, label = [], '', ''
    youtube = YOUTUBE_ID.search(url)
    if youtube:
        vid = youtube[1]
        meta = get_json(f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json')
        title, label = meta.get('title', ''), f"YouTube · {meta.get('author_name', '')}".strip(' ·')
        urls = [f'https://i.ytimg.com/vi/{vid}/{name}.jpg' for name in ('hq1', 'hq2', 'hq3', 'oar2', 'hqdefault')]
    else:
        if 'tiktok.com' in url:
            meta = get_json(f'https://www.tiktok.com/oembed?url={requests.utils.quote(url, safe="")}')
            title, label = meta.get('title', ''), f"TikTok · {meta.get('author_name', '')}".strip(' ·')
            if meta.get('thumbnail_url'):
                urls.append(meta['thumbnail_url'])
        if not urls:
            try:
                page = requests.get(url, headers=BROWSER, timeout=20).text
            except requests.RequestException:
                page = ''
            if 'instagram.com' in url and 'og:image' not in page:
                code = re.search(r'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)', url)
                if code:  # the embed page shows the cover picture without a login
                    try:
                        embed = requests.get(f'https://www.instagram.com/p/{code[1]}/embed/captioned/',
                                             headers=BROWSER, timeout=20).text
                    except requests.RequestException:
                        embed = ''
                    found = (re.search(r'class="EmbeddedMediaImage"[^>]*src="([^"]+)"', embed)
                             or re.search(r'"display_url"\s*:\s*"([^"]+)"', embed))
                    if found:
                        urls.append(json.loads(f'"{found[1]}"').replace('&amp;', '&'))
            for prop in ('og:image', 'twitter:image'):
                found = re.search(rf'<meta[^>]+(?:property|name)=["\']{prop}["\'][^>]+content=["\']([^"\']+)', page)
                if found:
                    urls.append(found[1].replace('&amp;', '&'))
                    break
            found = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', page)
            title = title or (found[1] if found else '')
    pictures = []
    for pic_url in urls:
        try:
            res = requests.get(pic_url, headers=BROWSER, timeout=20)
            if not res.ok or len(res.content) < 3000:
                continue
            img = crop_bars(Image.open(BytesIO(res.content)))
            pictures.append((sharpness(img), img))
        except Exception:
            continue
    if not pictures:
        return [], label, title
    pictures.sort(key=lambda p: p[0], reverse=True)
    names = []
    for i, (_, img) in enumerate(pictures[:count]):
        save_picture(img, folder / f'input_{i}.jpg')
        names.append(f'input_{i}.jpg')
    return names, label, title


def extract_sound(source, out):
    """Keeps the sound of the user's own video (for "my video's sound"). False if it has none."""
    try:
        run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vn', '-ac', '2', '-ar', '44100',
             '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out)])
    except subprocess.CalledProcessError:
        out.unlink(missing_ok=True)
        return False
    return out.exists() and out.stat().st_size > 2000


def music_file(track):
    """A free meme track, downloaded once and kept."""
    path = DATA / 'music' / (re.sub(r'[^A-Za-z0-9]+', '_', track) + '.mp3')
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        res = requests.get(ideas.MUSIC[track], timeout=120)
        res.raise_for_status()
        part = path.with_suffix('.part')
        part.write_bytes(res.content)
        part.rename(path)
    return path


def sample_frames(source, folder):
    """Frames from across the video, each with how sharp it is. Returns (duration, [(time, sharpness, file)])."""
    _, _, duration = probe(source)
    samples = 16 if duration > 2 else 1
    scored = []
    for i in range(samples):
        t = duration * (0.04 + 0.92 * i / max(1, samples - 1)) if samples > 1 else 0
        out = folder / f'sample_{i}.jpg'
        run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', str(source), '-frames:v', '1',
             '-vf', "scale='min(1024,iw)':-2", str(out)])
        if out.exists():
            scored.append((t, sharpness(Image.open(out)), out))
    if not scored:
        raise RuntimeError('Could not read any pictures from this video')
    return duration, scored


def pick_start(sampled, part, parts, path):
    """The picture a video starts from: the sharpest moment in part `part` of `parts` equal parts of the
    source. Videos made from the same link at the same time each take their own part, so each one starts
    differently. Within its part, a moment with real video before it for the opening comes first (at least
    HOOK_MAX seconds in, else HOOK_MIN). Returns the file name and the moment's time."""
    duration, scored = sampled
    lo, hi = duration * part / parts, duration * (part + 1) / parts
    pool = [s for s in scored if lo <= s[0] <= hi] or scored
    pool = [s for s in pool if s[0] >= HOOK_MAX] or [s for s in pool if s[0] >= HOOK_MIN] or pool
    best = max(pool, key=lambda s: s[1])
    shutil.copy(best[2], path)
    return path.name, best[0]


SMALL = "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"


def frame_rate(path):
    """A video's frames per second, from its header."""
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=avg_frame_rate,r_frame_rate', '-of', 'json', str(path)],
                         check=True, capture_output=True, text=True).stdout
    stream = json.loads(out)['streams'][0]
    for key in ('avg_frame_rate', 'r_frame_rate'):
        num, _, den = (stream.get(key) or '0/0').partition('/')
        if float(den or 0) > 0 and float(num or 0) > 0:
            return min(120.0, float(num) / float(den))
    return 30.0


def cut_hook(source, t, folder):
    """The opening of a video made from a link: the real video's last HOOK_MAX seconds before moment t, at
    FPS frames a second (hook.mp4), and the start picture (input_0.jpg) written again from the frame right
    after them in the same decode, so the two meet exactly (two separate seeks can be a frame apart). Kept
    with every link video, so the opening can be switched on later without the link. Returns the opening's
    frames (counted: ffmpeg 7.1 reports such files a frame short) and the picture's time; 0 frames: too close
    to the start of the video, no opening."""
    rate = frame_rate(source)
    start = max(0.0, t - HOOK_MAX)
    before = int(round((t - start) * rate))  # the source's frames before the picture
    if before < HOOK_MIN * rate:
        return 0, t
    hook, picture = folder / 'hook.mp4', folder / 'input_0.new.jpg'
    try:
        run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-i', str(source), '-an', '-filter_complex',
             f'[0:v]split[a][b];[a]trim=end_frame={before},setpts=PTS-STARTPTS,fps={FPS},{SMALL},format=yuv420p[h];'
             f"[b]trim=start_frame={before}:end_frame={before + 1},scale='min(1024,iw)':-2[p]",
             '-map', '[h]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart',
             str(hook), '-map', '[p]', '-frames:v', '1', '-q:v', '2', str(picture)])
        frames = clip_info(hook)[2]
        if frames < HOOK_MIN * FPS or not picture.exists():
            raise RuntimeError(f'only {frames} frames')
        os.replace(picture, folder / 'input_0.jpg')
    except Exception as e:  # the opening must never cost a video
        log.warning('no opening for %s: %s', folder.name, e)
        hook.unlink(missing_ok=True)
        picture.unlink(missing_ok=True)
        return 0, t
    first = float(np.ceil(start * rate - 1e-6)) / rate  # the seek starts at the first frame from `start` on
    return frames, first + before / rate


def hook_from_frames(frames, rate, folder):
    """The opening of an uploaded video: the real frames the page sent (in order; the last one comes right
    before the start picture), made into hook.mp4 at FPS frames a second. Returns its frames (0: none)."""
    frames = frames[-int(round(HOOK_MAX * rate)):]  # the last HOOK_MAX seconds before the picture
    if len(frames) < HOOK_MIN * rate:
        return 0
    work = folder / 'hookframes'
    hook = folder / 'hook.mp4'
    try:
        work.mkdir(exist_ok=True)
        for i, path in enumerate(frames):  # numbered without gaps, for the image sequence reader
            os.replace(path, work / f'f_{i:03d}.jpg')
        run(['ffmpeg', '-v', 'error', '-y', '-framerate', f'{rate:.3f}', '-start_number', '0', '-i',
             str(work / 'f_%03d.jpg'), '-vf', f'fps={FPS},{SMALL},format=yuv420p', '-c:v', 'libx264',
             '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', str(hook)])
        count = clip_info(hook)[2]
        if count < HOOK_MIN * FPS:
            raise RuntimeError(f'only {count} frames')
        return count
    except Exception as e:  # the opening must never cost a video
        log.warning('no opening for %s from the frames sent: %s', folder.name, e)
        hook.unlink(missing_ok=True)
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def surprise_picture(prompt, path):
    """Pollinations first (uses no GPU time), FLUX on Hugging Face if it is busy."""
    seed = random.randint(1, 10**9)
    try:
        res = requests.get(f'https://image.pollinations.ai/prompt/{requests.utils.quote(prompt)}',
                           params={'width': 576, 'height': 1024, 'nologo': 'true', 'seed': seed}, timeout=60)
        if res.ok and res.headers.get('content-type', '').startswith('image/'):
            img = Image.open(BytesIO(res.content))
            # Trim the small pollinations.ai mark in the bottom corner.
            save_picture(img.crop((0, 0, img.width, int(img.height * 0.95))), path)
            return
    except requests.RequestException:
        pass
    from gradio_client import Client

    def paint():  # one ZeroGPU call: only through the GPU guard (wait_job never leaves it running)
        client = Client(IMAGE_SPACE, token=HF_TOKEN, verbose=False)
        job = client.submit(prompt=prompt, seed=seed, randomize_seed=False, width=576, height=1024,
                            num_inference_steps=4, api_name='/infer')
        return gpu.wait_job(job, SPACE_TIMEOUT)
    try:
        out = gpu.gpu_call('FLUX.1-schnell', IMAGE_REQUEST, paint)
    except QuotaError:
        raise
    except Exception as e:
        if is_quota(str(e)):
            raise QuotaError(str(e))
        raise
    first = out[0]
    shutil.copy(first['path'] if isinstance(first, dict) else first, path)


# ---------- Step 2: animate ----------

def wan21_size(picture):
    w, h = Image.open(picture).size
    if h > w * 1.15:
        return {'height': 896, 'width': 512}
    if w > h * 1.15:
        return {'height': 512, 'width': 896}
    return {'height': 640, 'width': 640}


def wan22_size(w, h):
    """The size both Wan 2.2 Spaces make a w x h picture (their resize_image): see ENGINES."""
    if w == h:
        return 640, 640
    aspect = w / h
    if aspect > 832 / 480:
        tw, th = 832, 480
    elif aspect < 480 / 832:
        tw, th = 480, 832
    elif w > h:
        tw, th = 832, int(round(832 / aspect))
    else:
        tw, th = int(round(832 * aspect)), 832
    fw, fh = round(tw / 16) * 16, round(th / 16) * 16
    return max(480, min(832, fw)), max(480, min(832, fh))


def booking(engine, picture, seconds):
    """The ZeroGPU seconds one call to this engine books for this picture (see ENGINES); the engine's worst case
    when the picture can't be read."""
    try:
        w, h = Image.open(picture).size
    except Exception:
        return engine['request']
    kind = engine.get('booking')
    s = min(seconds, engine['max_sec'])
    steps = int(engine['extra'].get('steps', 4))
    if kind in ('wan22', 'wan22_backup'):
        rw, rh = wan22_size(w, h)
        frames = 1 + min(max(int(round(s * 16)), 8), 80 if kind == 'wan22' else 160)
        f = (frames * rw * rh / (81 * 832 * 624)) ** 1.5
        duration = 10 + steps * 15 * f if kind == 'wan22' else (15 + steps * 5 * f) * 1.3
    elif kind == 'wan21':
        duration = 90 if steps > 4 and s > 2 else 75 if steps > 4 or s > 2 else 60
    else:
        return engine['request']
    return 2 * math.ceil(duration)


# ---------- Your own PC (the antics PC helper) ----------
# The helper on the user's PC asks the worker for work, so it needs no open ports or tunnels.

PC_GONE_AFTER = 90  # seconds without a check-in before the PC counts as switched off
pc = {'seen': 0.0, 'name': ''}
pc_tasks = {}
pc_cond = threading.Condition()
pairing = {'code': '', 'until': 0.0, 'misses': 0}


def pc_online():
    return time.time() - pc['seen'] < PC_GONE_AFTER


def pc_make_clip(picture, prompt, seconds, out):
    """Hands one clip to the user's PC and waits. Returns False if the PC failed or went away."""
    task = {'id': secrets.token_hex(6), 'picture': str(picture), 'prompt': prompt, 'seconds': seconds,
            'out': str(out), 'status': 'waiting', 'error': '', 'done': threading.Event()}
    with pc_cond:
        pc_tasks[task['id']] = task
        pc_cond.notify_all()
    started = time.time()
    try:
        while not task['done'].wait(5):
            if not pc_online() or time.time() - started > 30 * 60:
                log.warning('the PC went quiet during clip %s', task['id'])
                return False
        if task['status'] != 'done':
            log.warning('the PC could not make clip %s: %s', task['id'], task['error'])
        return task['status'] == 'done'
    finally:
        with pc_cond:
            pc_tasks.pop(task['id'], None)


def make_clip(picture, prompt, seconds, out):
    """Animate one picture: on the user's PC when it is on, otherwise with the free online engines
    (each tried in turn; stops early on quota or key problems). Every online call goes through the GPU guard, booked
    at what the Space books for THIS picture: when there isn't enough free time for one engine, a cheaper one is
    tried. A busy Space that fit: BusyError (tried again soon); none fit: QuotaError."""
    if pc_online() and pc_make_clip(picture, prompt, seconds, out):
        return 'your PC'
    from gradio_client import Client, handle_file
    last, busy, short = None, False, None
    for engine in ENGINES:
        def animate(engine=engine):  # one ZeroGPU call: only through the GPU guard (wait_job never leaves it running)
            client = Client(engine['id'], token=HF_TOKEN, verbose=False)
            args = {'input_image': handle_file(str(picture)), 'prompt': prompt,
                    'duration_seconds': min(seconds, engine['max_sec']), 'randomize_seed': True, **engine['extra']}
            if engine.get('sized'):
                args.update(wan21_size(picture))
            return gpu.wait_job(client.submit(api_name='/generate_video', **args), SPACE_TIMEOUT)
        try:
            result = gpu.gpu_call(engine['name'], booking(engine, picture, seconds), animate)
            video = result[0]
            path = video.get('video') if isinstance(video, dict) else video
            shutil.copy(path, out)
            return engine['name']
        except QuotaError as e:
            if e.guard and e.reason == 'quota':  # not enough free time for this one: a cheaper engine may fit
                log.info('%s', e)
                short = short or e
                continue
            raise
        except (gpu.NoKey, gpu.KeyRefused):
            raise
        except Exception as e:
            msg = str(e) or type(e).__name__
            if is_quota(msg):
                raise QuotaError(msg)
            if is_auth(msg):
                raise RuntimeError(gpu.KEY_REFUSED)
            busy = busy or is_busy(msg)
            log.warning('%s failed: %s', engine['id'], msg)
            last = msg
    if busy:  # (an engine that fit was busy: soon, not at the reset)
        raise BusyError(last)
    if short:
        raise short
    raise RuntimeError(f'The free video engines are offline right now ({last})')


# ---------- Step 3: join clips into one TikTok video ----------

# Text on the video uses a plain font, so emoji and other symbols would show as empty boxes.
TEXT_OK = set('’‘“”…–—•')


def plain_text(text):
    return ''.join(ch for ch in text if ord(ch) < 0x2000 or ch in TEXT_OK)


def caption_png(text, path):
    """White text with a black outline near the top, like a TikTok caption."""
    img = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    text = re.sub(r'\s+', ' ', plain_text(text or '')).strip()
    if text:
        font = ImageFont.truetype(FONT, 46)
        words, lines, line = text.split(), [], ''
        for word in words:
            test = f'{line} {word}'.strip()
            if draw.textlength(test, font=font) > OUT_W * 0.84 and line:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
        y = OUT_H * 0.15
        for line in lines[:3]:
            draw.text((OUT_W / 2, y), line, font=font, fill='white', anchor='ma', stroke_width=5, stroke_fill='black')
            y += 58
    img.save(path)


def clip_info(path):
    """(width, height, frames, fps) of a clip. Frames are counted, not taken from the file's header."""
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,avg_frame_rate,r_frame_rate,nb_read_packets', '-of', 'json', str(path)],
                         check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = (s.get('avg_frame_rate') or '0/0').split('/')
    if not float(den or 0) or not float(num):
        num, den = s['r_frame_rate'].split('/')
    return s['width'], s['height'], int(s['nb_read_packets']), float(num) / float(den)


CHAIN_LOOK = 4  # the next clip starts from the sharpest of the last 4 frames (1 = always the very last)


def chain_frame(clip, out, look=CHAIN_LOOK):
    """Saves the picture the next clip starts from (lossless PNG, full size): the sharpest of the clip's
    last `look` frames, so a blurry last frame doesn't start the next clip. Returns its frame number
    (the video then cuts this clip on that frame). One pass: counts the frames, keeps the last few."""
    w, h, _, _ = clip_info(clip)
    size = w * h * 3
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', str(clip), '-map', '0:v:0', '-f', 'rawvideo',
                             '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    last, count = collections.deque(maxlen=look), 0
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        last.append(buf)
        count += 1
    proc.stdout.close()
    if proc.wait() != 0 or not count:
        raise RuntimeError(f'Could not read the end of {Path(clip).name}')
    pictures = [Image.frombuffer('RGB', (w, h), b, 'raw', 'RGB', 0, 1) for b in last]
    best = max(range(len(pictures)), key=lambda k: (sharpness(pictures[k]), k))  # a tie: the later one
    pictures[best].save(out, 'PNG')
    return count - len(pictures) + best


def clip_spans(job, numbers):
    """Which frames of each clip play, as (first, end) with end exclusive (None = to its end). A clip that
    began from a frame of the clip before skips its own frame 0 (the same picture again), and the clip
    before ends on the frame it handed over. Clips from before v10 (no chain) join with a plain cut."""
    chain = job.get('chain') or {}
    spans = []
    for n, i in enumerate(numbers):
        first = 1 if n and numbers[n - 1] == i - 1 and str(i) in chain else 0
        nxt = numbers[n + 1] if n + 1 < len(numbers) else None
        end = chain[str(nxt)] + 1 if nxt == i + 1 and str(nxt) in chain else None
        spans.append((first, end))
    return spans


def span_seconds(clip, span, speed=1.0):
    _, _, frames, fps = clip_info(clip)
    first, end = span
    end = frames if end is None else max(1, min(end, frames))
    first = max(0, min(first, end - 1))
    return first, end, (end - first) / fps / speed


def caption_windows(captions, lengths):
    """[(caption file, start, end)]: clips in a row with the same caption share one window."""
    out, t = [], 0.0
    for cap, length in zip(captions, lengths):
        if out and Path(out[-1][0]).read_bytes() == Path(cap).read_bytes():
            out[-1] = (out[-1][0], out[-1][1], t + length)
        else:
            out.append((cap, t, t + length))
        t += length
    return out


def first_frame_grey(path, width=96):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-frames:v', '1', '-vf', f'scale={width}:-2',
                          '-f', 'image2pipe', '-c:v', 'png', '-'], check=True, capture_output=True).stdout
    return Image.open(BytesIO(raw)).convert('L')


def as_engine(img, w, h, mode):
    """The picture as an engine framed it for a w x h clip: 'crop' = cut to the clip's shape around the
    middle (Wan 2.2 for very tall or wide pictures, the PC helper), 'stretch' = squeezed whole (Wan 2.1,
    Wan 2.2 otherwise)."""
    if mode == 'crop':
        a, (iw, ih) = w / h, img.size
        if iw / ih > a:
            cw = round(ih * a)
            img = img.crop(((iw - cw) // 2, 0, (iw - cw) // 2 + cw, ih))
        else:
            ch = round(iw / a)
            img = img.crop((0, (ih - ch) // 2, iw, (ih - ch) // 2 + ch))
    return img.resize((w, h), Image.LANCZOS)


def clip_framing(picture, clip):
    """How the engine framed the start picture in a clip ('crop' or 'stretch'), found by comparing the clip's
    first frame with both, and how far off the better one is (mean grey difference: about 3 when it matches;
    over 25 the clip did not start from the picture)."""
    w, h, _ = probe(clip)
    first = np.asarray(first_frame_grey(clip), dtype=np.float32)
    pic = Image.open(picture).convert('L')
    best = ('stretch', 999.0)
    for mode in ('crop', 'stretch'):
        guess = as_engine(pic, w, h, mode).resize((first.shape[1], first.shape[0]), Image.BILINEAR)
        err = float(np.abs(np.asarray(guess, dtype=np.float32) - first).mean())
        if err < best[1]:
            best = (mode, err)
    return best


def label_png(name, text, ai=False):
    """The opening's small labels: a red dot and REAL on dark, then a sparkle and AI on lime (drawn shapes:
    the font may not have the symbols). Drawn once and kept."""
    path = DATA / 'labels' / f'{name}.png'
    if path.exists():
        return path
    font = ImageFont.truetype(FONT, 30)
    h, pad, mark = 56, 18, 31
    w = int(pad + mark + ImageDraw.Draw(Image.new('RGBA', (1, 1))).textlength(text, font=font) + pad)
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=(201, 240, 74, 240) if ai else (22, 19, 16, 220))
    cx, cy = pad + 10.5, h / 2
    if ai:  # a four-pointed sparkle
        r, q = 12.5, 3.2
        draw.polygon([(cx, cy - r), (cx + q, cy - q), (cx + r, cy), (cx + q, cy + q), (cx, cy + r), (cx - q, cy + q),
                      (cx - r, cy), (cx - q, cy - q)], fill=(22, 19, 16))
    else:  # the red recording dot
        draw.ellipse((cx - 10.5, cy - 10.5, cx + 10.5, cy + 10.5), fill=(255, 59, 48))
    draw.text((pad + mark, h / 2), text, font=font, fill=(22, 19, 16) if ai else 'white', anchor='lm')
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(f'{name}.{secrets.token_hex(3)}.png')  # two videos can be cut at once
    img.save(part)
    os.replace(part, path)
    return path


def fit(src, w, h, dst, tag, frames):
    """The filters that fill the 720x1280 frame with a w x h video of `frames` frames: cropped if close to
    vertical, else on a blurred copy of itself."""
    ratio = (w / h) / (OUT_W / OUT_H)
    if 0.85 < ratio < 1.18:
        return f'{src}scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},setsar=1{dst}'
    # overlay drops its last frame on ffmpeg 6-7: give it a copy to drop, then cut back to the real frames
    return (f'{src}tpad=stop=1:stop_mode=clone,split[s{tag}][f{tag}];'
            f'[s{tag}]scale=72:128:force_original_aspect_ratio=increase,crop=72:128,boxblur=6,'
            f'scale={OUT_W}:{OUT_H},eq=brightness=-0.08[bg{tag}];'
            f'[f{tag}]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease[fg{tag}];'
            f'[bg{tag}][fg{tag}]overlay=(W-w)/2:(H-h)/2,trim=end_frame={frames},setsar=1{dst}')


def out_frames(seconds):
    """How many frames the fps filter makes of `seconds` of video (it rounds the end to the nearest frame)."""
    return int(seconds * FPS + 0.5)


def join_clips(clips, captions, out, spans=None, speed=1.0, audio=None, audio_start=0.0, badge=None,
               zooms=None, sounds=None, sounds_gain=1.0, opening=None, outro=None, voice=None):
    """Each clip fills a 720x1280 frame (cropped if close to vertical, else on a blurred copy), plays its
    frames spans[i] (see clip_spans) at `speed`, and the clips join into one video. Captions go on after
    the join (an overlay on each clip would drop that clip's last frame, a visible skip at each join).
    audio is laid under the whole video from audio_start (looped, faded out), else silence. badge (the
    creator's name tag) sits on the left, clear of TikTok's buttons and caption. The meme edit: zooms
    (meme.plan) punch in on the joined video, under the captions and the name tag so they stay still,
    without changing a single frame's time; sounds is a WAV of sound effects as long as the video
    (sfx.sfx_track, made at sounds_gain), mixed over the music, which dips a little under each one.
    opening = {'video': hook.mp4, 'frames': its frames, 'keep': how many of its last frames to show,
    'framing': 'crop' or 'stretch' (how the engine framed clip 1's picture), 'size': clip 1's (w, h), 'duck':
    quieter music under it}: the Real -> AI opening. The real video plays first at normal speed, framed exactly
    like clip 1 so its last frame turns into clip 1's first, under clip 1's caption and a REAL label; at the
    switch a soft flash and the AI label (the sound effects bring the whoosh).
    outro = {'card': the follow card, a 720x1280 PNG}: the Follow me ending. The last frame is held for
    OUTRO_SECONDS, blurred and darkened, the card slides in and the name tag goes (the card has the name);
    the music plays on and fades out. Zooms and sounds are on the whole video's timeline.
    voice = {'track': a WAV as long as the video, 'lines': [{'at', 'end'}, ...] (seconds)}: the pet voice
    (pet_voice.track). It is mixed over the music, which goes down to 30 % while the pet talks (the sound
    effects to 50 %). Returns the length."""
    cmd = ['ffmpeg', '-v', 'error', '-y']
    parts, lengths, segs = [], [], []
    n = len(clips)
    spans = spans or [(0, None)] * n
    for clip in clips:
        cmd += ['-i', str(clip)]
    k = n  # the next input's number
    lead, before = 0.0, 0  # the opening's seconds; frames before the ending
    if opening:
        w, h = opening['size']
        keep = opening['keep']
        cmd += ['-i', str(opening['video'])]
        # The real video framed like the engine framed its next frame (clip 1's picture), at twice the clip's
        # size (it is sharper than the AI), then filled into the frame exactly like clip 1.
        crop = f"crop='min(iw,ih*{w}/{h})':'min(ih,iw*{h}/{w})'," if opening['framing'] == 'crop' else ''
        parts.append(f"[{k}:v]trim=start_frame={max(0, opening['frames'] - keep)},setpts=PTS-STARTPTS,"
                     f'{crop}scale={2 * w}:{2 * h},setsar=1[th]')
        parts.append(fit('[th]', 2 * w, 2 * h, '[bh]', 'h', keep))
        parts.append(f'[bh]fps={FPS},format=yuv420p[vh]')
        segs.append('[vh]')
        lead, before, k = keep / FPS, keep, k + 1
    base = None  # the size of the part the current shot began with
    for i, clip in enumerate(clips):
        w, h, _, _ = clip_info(clip)
        first, end, seconds = span_seconds(clip, spans[i], speed)
        lengths.append(seconds)
        before += out_frames(seconds)
        # A part that carries on from the one before shows the same scene, so it gets exactly the same
        # framing: scaled to the size of the part its shot began with (the Wan 2.1 backup stretches
        # pictures to 512x896).
        size = ''
        if base and first:
            if (w, h) != base:
                size = f',scale={base[0]}:{base[1]},setsar=1'
            w, h = base
        else:
            base = (w, h)
        parts.append(f'[{i}:v]trim=start_frame={first}:end_frame={end},setpts=PTS-STARTPTS{size}[t{i}]')
        parts.append(fit(f'[t{i}]', w, h, f'[b{i}]', i, end - first))
        parts.append(f'[b{i}]setpts=PTS/{speed},fps={FPS},format=yuv420p[v{i}]')
        segs.append(f'[v{i}]')
    tail = OUTRO_SECONDS if outro else 0.0
    total = lead + sum(lengths) + tail
    if outro:  # cut on a whole frame: the held ending is exactly its frames, under the card to the very end
        count = before + out_frames(tail)
        total = count / FPS
    # One copied frame at the very end, for the overlays below to use up instead of a real one; the ending
    # holds the last frame (copies of it) for its seconds.
    pad = 1 + (out_frames(tail) if outro else 0)
    parts.append(''.join(segs) + f'concat=n={len(segs)}:v=1:a=0,tpad=stop={pad}:stop_mode=clone[j0]')
    last = 'j0'
    zoom = meme.zoom_filter(zooms, OUT_W, OUT_H) if zooms and meme else ''
    if zoom:  # on the whole shot's own timeline, so a punch can run across a join
        parts.append(f'[j0]{zoom}[jz]')
        last = 'jz'
    if opening:  # the switch: a soft flash (the text and labels stay as they are), REAL before it, AI after
        sw = lead - 0.5 / FPS  # between the last real frame and the first AI frame
        parts.append(f"[{last}]eq=brightness='{FLASH}*(1-(t-{lead:.4f})/{FLASH_FADE})':eval=frame:"
                     f"enable='between(t,{sw:.4f},{lead + FLASH_FADE - 0.5 / FPS:.4f})'[jf]")
        cmd += ['-i', str(label_png('real_v10', 'REAL')), '-i', str(label_png('ai_v10', 'AI', ai=True))]
        y = int(OUT_H * 0.15) - 74  # above the caption, below TikTok's top tabs
        parts.append(f"[jf][{k}:v]overlay=24:{y}:enable='lt(t,{sw:.4f})'[jr];"
                     f"[jr][{k + 1}:v]overlay=24:{y}:enable='between(t,{sw:.4f},{lead + AI_LABEL_SECONDS:.4f})'[ja]")
        last, k = 'ja', k + 2
    windows = caption_windows(captions, lengths)
    for m, (cap, t0, t1) in enumerate(windows):
        # The opening plays under clip 1's caption; the last caption stays on under the ending's blur.
        t0, t1 = (t0 + lead if m else 0.0), t1 + lead + (tail if m == len(windows) - 1 else 0.0)
        cmd += ['-i', str(cap)]
        parts.append(f"[{last}][{k}:v]overlay=0:0:enable='between(t,{t0:.3f},{t1 - 0.001:.3f})'[j{k}]")
        last, k = f'j{k}', k + 1
    if outro:
        s = before / FPS  # the first held frame
        e = s - 0.5 / FPS
        cmd += ['-loop', '1', '-framerate', str(FPS), '-i', str(outro['card'])]  # (until the video ends)
        # The blurred copy fades in over the held frame (blurred only from the ending on: before it, it is
        # see-through anyway); the card fades in while it slides up into place.
        parts.append(f"[{last}]split[om][ob];[ob]boxblur=22:2:enable='gte(t,{e:.4f})',"
                     f"eq=brightness=-0.13:saturation=0.85:enable='gte(t,{e:.4f})',format=yuva420p,"
                     f"fade=t=in:st={s:.4f}:d=0.25:alpha=1[ok];[om][ok]overlay=0:0:enable='gte(t,{e:.4f})'[ov];"
                     f'[{k}:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,setpts=PTS+{s:.4f}/TB[oc];'
                     f"[ov][oc]overlay=0:'60*max(0,1-(t-{s:.4f})/0.3)^2':eof_action=pass[oe]")
        last, k = 'oe', k + 1
    if badge:
        cmd += ['-i', str(badge)]
        hide = f":enable='lt(t,{before / FPS - 0.5 / FPS:.4f})'" if outro else ''  # the card shows the name
        parts.append(f'[{last}][{k}:v]overlay=24:{int(OUT_H * 0.62)}{hide}[out]')
        k += 1
    else:
        parts.append(f'[{last}]null[out]')
    if audio:
        cmd += ['-stream_loop', '-1', '-ss', f'{audio_start:.3f}', '-i', str(audio)]
    else:
        cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']
    fade = 1.2 if outro else 0.8  # with the ending, the music plays on under the card and fades with it
    music = f'[{k}:a]aresample=44100,afade=t=in:d=0.1,afade=t=out:st={max(0.0, total - fade):.2f}:d={fade}'
    if opening and opening.get('duck'):  # quieter under the real video, full from the switch on
        music += f",volume='if(lt(t,{lead:.4f}),{DUCK},1)':eval=frame"
    if voice:  # down while the pet talks
        music += ',' + pet_voice.duck_filter(voice['lines'], VOICE_DUCK)
    k += 1
    over = []  # what is mixed over the music
    if sounds:
        cmd += ['-i', str(sounds)]
        # The music dips 2-6 dB under each effect so it cuts through; the limiter keeps the sum under -1 dBFS
        # without changing the overall level (level=0) or the timing (latency=1). The dip's key is padded
        # with silence: sidechaincompress stops when its key ends, and on ffmpeg 7 that dropped up to 1.3 s
        # of the music still on its way (the sound then ended before the picture). -t ends it all instead.
        parts.append(f'{music},aformat=channel_layouts=stereo[mus]')
        parts.append(f'[{k}:a]aresample=44100,aformat=channel_layouts=stereo,asplit[key0][fx];[key0]apad[key]')
        parts.append(f'[mus][key]sidechaincompress=threshold={0.05 * sounds_gain:.4f}:ratio=2:attack=5:release=250[duck]')
        if voice:  # an effect doesn't cover the pet's words
            parts.append(f"[fx]{pet_voice.duck_filter(voice['lines'], VOICE_FX_DUCK)}[fxv]")
        over.append('[fxv]' if voice else '[fx]')
        k += 1
    elif voice:
        parts.append(f'{music},aformat=channel_layouts=stereo[duck]')
    if voice:
        cmd += ['-i', str(voice['track'])]
        parts.append(f'[{k}:a]aresample=44100,aformat=channel_layouts=stereo[said]')
        over.append('[said]')
        k += 1
    if over:
        parts.append(f"[duck]{''.join(over)}amix=inputs={1 + len(over)}:duration=first:normalize=0,"
                     f'alimiter=limit=0.89:attack=3:release=60:level=0:latency=1,'
                     f'afade=t=out:st={max(0.0, total - 0.15):.2f}:d=0.15[aout]')
    else:
        parts.append(f'{music}[aout]')
    cmd += ['-filter_complex', ';'.join(parts), '-map', '[out]', '-map', '[aout]']
    cmd += ['-frames:v', str(count), '-t', f'{total:.6f}'] if outro else ['-t', f'{total:.3f}']
    cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out)]
    run(cmd)
    return total


# ---------- The pipeline ----------

def get_link(job, folder):
    """Downloads the link and picks the picture the video starts from, also for the other videos made
    from it at the same time (each from its own part of the source), so the link is fetched only once."""
    others = sorted((j for j in list(jobs.values()) if j is not job and job.get('group')
                     and j.get('group') == job['group'] and j['kind'] == 'link' and not j.get('inputs')),
                    key=lambda j: j.get('index', 0))
    update(job, stage='Downloading the video…', progress=0.05)
    sound = None
    try:
        try:
            source, label, text = download_link(job, folder)
        except Exception as e:
            # Some sites block servers; a few have another public route to the video file.
            found = fallback_video(job, folder)
            if not found:
                raise
            log.info('%s: yt-dlp failed (%s), got the video another way', job['id'], e)
            source, label, text = found
        update(job, stage='Finding the best moments…', progress=0.12)
        sampled = sample_frames(source, folder)
        parts = 1 + len(others)
        # Each video keeps the real seconds before its picture (hook.mp4) now, while there is a source: the
        # opening can be switched on later too.
        hooks = []
        for k, one in enumerate([job] + others):
            _, at = pick_start(sampled, k, parts, job_dir(one['id']) / 'input_0.jpg')
            hooks.append(cut_hook(source, at, job_dir(one['id'])))
        inputs, picks = ['input_0.jpg'], [['input_0.jpg'] for _ in others]
        if job.get('music') == 'mine' and extract_sound(source, folder / 'sound.m4a'):
            sound = folder / 'sound.m4a'
        source.unlink(missing_ok=True)
    except Exception as e:
        # Still blocked (YouTube especially): the pictures the site shows publicly still work.
        log.warning('%s: download failed (%s), trying the public pictures', job['id'], e)
        names, label, text = link_pictures(job, folder, 1 + len(others))
        if not names:
            raise
        inputs, picks = names[:1], []
        for k, o in enumerate(others):  # each video its own picture while there are enough
            shutil.copy(folder / names[(k + 1) % len(names)], job_dir(o['id']) / 'input_0.jpg')
            picks.append(['input_0.jpg'])
        hooks = [(0, None)] * (1 + len(others))  # no video, no real seconds for an opening
    guessed = said_animal(job) or ideas.guess_animal(text)  # the user's own words first, then the video's title
    extra = ['sound.m4a'] if sound else []
    batch = []
    for one, names, (frames, at) in zip([job] + others, [inputs] + picks, hooks):
        if one is not job:
            if one['id'] not in jobs:  # deleted meanwhile
                continue
            if sound:
                shutil.copy(sound, job_dir(one['id']) / 'sound.m4a')
        update(one, label=one.get('label') or label, animal=one.get('animal') or guessed, inputs=names,
               has_sound=bool(sound), hook_frames=frames, hook_at=round(at, 3) if frames else None)
        batch.append((one, names + extra + (['hook.mp4'] if frames else [])))
    save_many(batch)


def process(job):
    folder = job_dir(job['id'])
    wanted = job['wanted']

    if not job.get('inputs'):
        if job['kind'] == 'link':
            get_link(job, folder)
        else:  # surprise (also after its description changed: a new picture for it)
            update(job, stage='Painting a random scene…', progress=0.08)
            scene = ideas.described_scene(job['idea']) if job.get('idea') else ideas.random_scene()
            surprise_picture(scene['prompt'], folder / 'input_0.jpg')
            update(job, animal=scene['animal'], label=f"Surprise: {scene['subject']}"[:80], scene=scene,
                   inputs=['input_0.jpg'])
            save(job, ['input_0.jpg'])

    if job.get('animal') in (None, '', 'animal') and said_animal(job):  # e.g. an upload: no title to go by
        update(job, animal=said_animal(job))
    animal = job.get('animal') or 'animal'
    have = job.get('ideas') or []
    if len(have) != wanted:
        have = have[:wanted] + new_ideas(job, animal, wanted)[len(have):]
        for i, text in (job.get('keep_texts') or {}).items():  # the user's own words from an edit
            if int(i) < len(have):
                have[int(i)].update(caption=text, typed=True)
        update(job, ideas=have, keep_texts=None)
    if not job.get('track'):
        update(job, track=ideas.pick_music(job.get('template') or 'random'))
    if not job.get('sound'):
        update(job, sound=random.choice(ideas.SOUND_IDEAS))

    # One continuous shot: clip 1 starts from the chosen picture, every clip after it from the end of the
    # clip before (job['chain'][i] = the frame of clip i-1 that clip i started from). A preview is just
    # clip 1, and Finish carries it on. Made clips are kept (also on the Hub), so edits that keep them just
    # re-cut the video.
    limit = 1 if job.get('draft') else wanted
    if job.get('clips_done') is None:  # jobs from before clips were kept
        job['clips_done'] = [f'clip_{i}.mp4' for i in range(wanted) if (folder / f'clip_{i}.mp4').exists()]
    job.setdefault('chain', {})
    parts, failed = [], None  # parts: (clip number, video file)
    for i, idea in enumerate(job['ideas'][:limit]):
        name = f'clip_{i}.mp4'
        out = folder / name
        if name in job['clips_done']:
            try:
                parts.append((i, local_file(job, name)))
                continue
            except Exception:  # gone (e.g. an old job after a restart): animate it again
                pass
        drop_clips(job, i)  # every clip after this one would start where this one ends: they go too
        if i < wanted - 1:
            idea['twist'] = ''  # the gag comes at the end of the video, not halfway
        where, each = ('Your PC is animating', '3–5 min each') if pc_online() else ('Animating', '1–2 min each')
        what = 'the preview' if job.get('draft') else f'part {i + 1} of {wanted}'
        update(job, stage=f'{where} {what}… ({each})', progress=0.15 + 0.7 * i / limit)
        try:
            if i == 0 or idea.get('picture'):  # (Together, one by one: each part starts from its animal's picture)
                picture = local_file(job, idea.get('picture') or job['inputs'][0])
            else:  # carries straight on from the clip before
                picture = folder / f'start_{i}.png'
                handed = chain_frame(parts[-1][1], picture)
            # (Together parts bring their own prompts)
            prompt = idea.get('prompt_follow' if i else 'prompt') or ideas.video_prompt(idea, animal, follow=i > 0)
            make_clip(picture, prompt, job['seconds'], out)
        except Exception as e:
            log.exception('%s: clip %d failed', job['id'], i + 1)
            failed = e
            break  # the clips after it need its last frame
        if i and not idea.get('picture'):
            job['chain'][str(i)] = handed
        parts.append((i, out))
        job['clips_done'].append(name)
        update(job, made=len(parts))
        save(job, [name])
    if not parts:
        raise failed or RuntimeError('No clips could be made')
    finish_video(job, folder, parts, failed)


def finish_video(job, folder, parts, failed=None):
    """Cuts final.mp4 from the animated parts [(clip number, file)] and finishes the job: thumbnail, TikTok caption,
    note, status done, saved. failed: why the parts stopped early (a QuotaError or BusyError is raised again once
    the shorter video is saved). Keeps what it was made with (made_with: the TikTok cut makes the same) and the
    saved song's name. (Together: its free looks come here too, with their one layout clip.)"""
    wanted = job['wanted']
    made = len(parts)

    update(job, stage='Putting your video together…', progress=0.9)
    cut = cut_video(job, folder, parts, folder / 'final.new.mp4', failed)
    lead, length, used, start, credit = cut['lead'], cut['length'], cut['used'], cut['start'], cut['credit']
    os.replace(folder / 'final.new.mp4', folder / 'final.mp4')
    at = lead + 1  # the thumbnail shows the AI part
    run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{at:.3f}', '-i', str(folder / 'final.mp4'), '-frames:v', '1',
         '-vf', 'scale=360:-2', str(folder / 'thumb.new.jpg')])
    os.replace(folder / 'thumb.new.jpg', folder / 'thumb.jpg')
    first_text = next((i['caption'] for i in job['ideas'] if i.get('caption')), '')
    caption = f"{first_text} {ideas.HASHTAGS}".strip() + (f'\n{credit}' if credit else '')
    # What the posting plan says of this version (its name, its text and the song's credit) is kept with it: while
    # an edit is under way the job's own fields already describe the next version, but the plan still shares this one.
    made_with = dict(cut['made_with'], text=first_text, credit=credit, label=job.get('label') or '')
    if job.get('kind') == 'together' and together:  # (Together) its own tags, and the free clips' credits
        caption = together.tiktok_caption(job, first_text, credit)
        made_with.update(ai=together.uses_ai(job), clips=together.credit_lines(job))  # (the AI label, the credits)
    _, _, seconds_long = probe(folder / 'final.mp4')
    full = round(job['seconds'] * wanted)
    if job.get('draft'):  # (in the animated seconds: the opening and the ending come on top)
        note = (f'Preview: the first {round(length)} seconds. Edit it, or tap Finish to carry it on to '
                f'{full} seconds.' if wanted > 1 else 'Preview ready. Edit it, or tap Finish when you like it.')
    elif made < wanted:
        note = (f'Made {round(length)} of {full} seconds (the free engines were busy or out of time). '
                'Tap Make the rest to carry it on.')
    else:
        note = ''
    update(job, status='done', stage=note, progress=1, error='', thumb='thumb.jpg', made=made, caption=caption,
           music_used=used, music_start=round(start, 2), seconds_long=round(seconds_long, 1),
           ai_seconds=round(length, 3), opening_s=round(lead, 3) if cut['opening'] else None,
           rev=(job.get('rev') or 0) + 1, made_with=made_with, song_name=cut['song_name'])
    save(job, ['final.mp4', 'thumb.jpg'])
    if failed and isinstance(failed, (QuotaError, BusyError)):
        raise failed  # the shorter video is ready to watch; the rest is made by itself when free time is back


def extras_of(now):
    """Which extras a join try has: [the meme edit or sound effects, the pet voice, the opening, the ending]."""
    return [bool(now[0] or now[1]), bool(now[3]), bool(now[4]), bool(now[5])]


def cut_video(job, folder, parts, out, failed=None, song=True):
    """Cuts the video from its animated parts into `out`: the re-cut every edit uses (captions, music, the meme
    edit, the pet voice, the opening and the ending, each dropped if the join fails with it). Returns what it was
    made with. song=False is the TikTok cut: the same plan and the same graph, with silence in place of the song
    (the video's own sound, the voice and the effects stay), and the same song start and extras as final.mp4 (if
    it can't have them now, it fails instead). It never changes the job then (`job` is a copy). (Together
    videos come here too: a free look's one layout clip, or the AI parts.)"""
    clips, captions, text = [], [], ''
    for n, (i, clip) in enumerate(parts):
        if job.get('captions', True):
            text = job['ideas'][i]['caption'] or text  # a part without its own text keeps the text before it
        path = folder / f'caption_{n}.png'
        caption_png(text, path)
        clips.append(clip)
        captions.append(path)
    spans = clip_spans(job, [i for i, _ in parts])
    speed = SPEEDS.get(job.get('speed'), 1.0)
    shown = [span_seconds(c, s, speed)[2] for c, s in zip(clips, spans)]
    length = sum(shown)  # the animated parts' seconds
    if failed and job.get('thumb') and length < (job.get('ai_seconds') or job.get('seconds_long') or 0) - 0.5:
        # Stopped early (e.g. a part made again ran out of free time), and the video so far is shorter than
        # the one the user already has: that one stays until the rest is made.
        raise failed
    hook, outro = opening_for(job, parts), outro_for(job)
    tail = OUTRO_SECONDS if outro else 0.0
    have = hook['frames'] / FPS if hook else 0.0
    lead = min(HOOK_WANT, have)
    music, audio, credit, used, natural = job.get('music', 'funny'), None, '', 'none', 'start'
    saved = None  # a saved song's meme part (music 'mysong'): where it starts, for every video
    made = {} if song else (job.get('made_with') or {})  # the TikTok cut: what final.mp4 was made with
    if music == 'mine' and job.get('has_sound'):
        audio, used = local_file(job, 'sound.m4a'), 'mine'
    elif music == 'upload' and job.get('has_song'):
        audio, used, natural = local_file(job, 'song.m4a'), 'upload', 'drop'
    elif music == 'mysong' and (mine := my_song(job)):
        (audio, saved), used = mine, 'mysong'
        if not song:  # the TikTok cut: where this video's song started (the song's meme part may have moved since)
            saved = float(made.get('start', job['music_start'] if job.get('music_start') is not None else saved))
    elif music != 'none':  # a meme track (chosen or matched to the style), or a missing sound/song
        try:
            audio, used = music_file(job['track']), 'funny'
            credit = ideas.MUSIC_CREDIT.format(track=job['track'])
        except requests.RequestException as e:
            log.warning('%s: no music this time (%s)', job['id'], e)
    if made.get('used', used) != used:  # (e.g. its saved song was deleted since: the plan can't be the same)
        raise RuntimeError(f"the video's song ({made['used']}) can't be had right now")
    start, info = saved or 0.0, None
    synced = bool(hook and used == 'mine' and job.get('hook_at') is not None)
    if synced:  # the video's own sound, in step with its real seconds
        lead = round(lead * FPS) / FPS
        start = max(0.0, job['hook_at'] - lead)
    if audio:
        part = job.get('song_part') if job.get('song_part') in ('start', 'drop', 'custom') else natural
        try:
            info = beats.analyse(audio)
            if synced:
                pass
            elif used == 'mysong':  # always the song's meme part, however long the video (on its beat)
                start = beats.nearest_beat(info, saved)
            elif part == 'custom':  # the user's own start time, nudged onto the nearest beat
                start = beats.nearest_beat(info, max(0.0, float(job.get('song_start') or 0)))
            else:
                start = beats.pick_start(info, lead + length + tail, part)
            if hook and used != 'mine':  # the switch from the real video to the AI lands on a beat
                lead = hook_length(info, start, have)
            if job.get('made_as') == 'turns' and together:  # (Together, one by one) each cut lands on a beat
                spans, shown = together.snap_turns(clips, spans, shown, speed, info, start + lead, clip_info)
                length = sum(shown)
            # No cutting clips onto the beat any more: the parts join without a cut, and trimming one would
            # make the picture jump at the join.
        except Exception as e:  # the beat finder must never cost a video
            log.warning('%s: beat finder skipped (%s)', job['id'], e)
    opening = None
    if hook:  # whole frames of the real video
        keep = max(1, min(hook['frames'], round(lead * FPS)))
        lead = keep / FPS
        opening = dict(hook, keep=keep, duck=used not in ('mine', 'none'))  # (its own sound is the real moment)
    else:
        lead = 0.0
    total = lead + length + tail
    badge = local_file(job, 'badge.png') if job.get('has_badge') and job.get('brand', True) else None
    # The whoosh into the switch, when the video has sound (with no music the user adds a TikTok sound).
    whoosh = [(round(lead - WHOOSH_PEAK, 4), 'whoosh')] if opening and (used != 'none' or job.get('meme')) else []
    zooms, sounds, gain = meme_edit(job, folder, parts, spans, speed, audio, info, start, used, lead, total, whoosh)
    voice = voice_edit(job, folder, parts, shown, lead, total, quiet=not song)
    # Written next to the old version and swapped in, so the old one plays until the new one is ready. The
    # extras must never cost a video: if the join fails, it is made again without the meme edit, then without
    # the pet voice (with the meme edit back), then without both, then without the opening and the ending too.
    full = (zooms, sounds, gain, voice, opening, outro)
    tries = [full]
    if zooms or sounds:
        tries.append((None, None, 1.0, voice, opening, outro))
    if voice:
        tries.append((zooms, sounds, gain, None, opening, outro))
        if zooms or sounds:
            tries.append((None, None, 1.0, None, opening, outro))
    if opening or outro:
        tries.append((None, None, 1.0, None, None, None))
    extras = (('the meme edit' if job.get('meme') else 'the sound effects', lambda t: t[0] or t[1]),
              ('the pet voice', lambda t: t[3]), ('the opening', lambda t: t[4]), ('the ending', lambda t: t[5]))
    try:
        if made.get('extras') is not None:  # the TikTok cut: exactly the extras final.mp4 has, or not at all
            tries = [now for now in tries if extras_of(now) == made['extras']][:1]
            if not tries:
                raise RuntimeError("its effects, voice, opening or ending can't be made the same right now")
        for n, now in enumerate(tries):
            try:
                z, s, g, v, o, e = now
                # (the TikTok cut: silence in place of the song; the video's own sound isn't a song, it stays)
                join_clips(clips, captions, out, spans, speed, audio if song or used == 'mine' else None, start,
                           badge, z, s, g, o, e, v)
                opening, outro = o, e
                break
            except Exception as err:
                if n == len(tries) - 1:
                    raise
                why = getattr(err, 'stderr', None)  # ffmpeg's first line names the filter, its last what failed
                lines = why.decode(errors='replace').strip().splitlines() if isinstance(why, bytes) else []
                why = ' / '.join(dict.fromkeys(line[:200] for line in (lines[:1] + lines[-1:]))) if lines else repr(err)
                had = [name for name, on in extras if on(now)]
                drop = [name for name, on in extras if on(full) and not on(tries[n + 1])]
                log.warning('%s: the video did not join with %s (%s); made again without %s', job['id'],
                            ' and '.join(had), why, ' and '.join(drop))
        if not (now[0] or now[1]):  # (the plans of what isn't in the video)
            (folder / 'meme.json').unlink(missing_ok=True)
        if not now[3]:
            (folder / 'voice.json').unlink(missing_ok=True)
    finally:
        if sounds:
            sounds.unlink(missing_ok=True)
        if voice:
            voice['track'].unlink(missing_ok=True)
    song_name = (songs.get(job.get('song_id') or '') or {}).get('name') if used == 'mysong' else None  # (kept)
    return {'lead': lead if opening else 0.0, 'length': length, 'used': used, 'start': float(start), 'credit': credit,
            'song_name': song_name, 'opening': bool(opening),
            'made_with': {'used': used, 'start': float(start), 'extras': extras_of(now)}}


def my_song(job):
    """The saved song of a 'mysong' video and where its meme part starts: (file, seconds), or None when the song
    was deleted or can't be fetched (the video then gets the meme song for its style)."""
    with songs_lock:
        song = dict(songs.get(job.get('song_id') or '') or {})
    if not song:
        return None
    try:
        return song_file(song['id']), float(song.get('start') or 0)
    except Exception as e:
        log.warning('%s: saved song %s unavailable (%s); the meme song instead', job['id'], song['id'], e)
        return None


def opening_for(job, parts):
    """The Real -> AI opening for this cut, or None: it is switched on, the real seconds before the start
    picture were kept, and clip 1 (where the real video turns into the AI) is in the video (also in a
    preview). Finds how the engine framed clip 1's picture; a clip that did not start from its picture gets
    no opening (the switch would jump)."""
    if job.get('kind') == 'together' and together:  # (Together) the real clips side by side, then the AI scene
        return together.opening(job, parts, THIS)
    if not (job.get('opening') and job.get('hook_frames') and parts and parts[0][0] == 0):
        return None
    try:
        video = local_file(job, 'hook.mp4')
        framing, off = clip_framing(local_file(job, job['inputs'][0]), parts[0][1])
        size = probe(parts[0][1])[:2]
    except Exception as e:  # the opening must never cost a video
        log.warning('%s: no opening this time (%s)', job['id'], e)
        return None
    if off > 25:
        log.warning('%s: clip 1 does not start from its picture (%.1f), no opening', job['id'], off)
        return None
    return {'video': video, 'frames': int(job['hook_frames']), 'framing': framing, 'size': size}


def outro_for(job):
    """The Follow me ending for this cut, or None: it is switched on and the owner's follow card was sent."""
    if not (job.get('outro') and job.get('has_endcard')):
        return None
    try:
        return {'card': local_file(job, 'endcard.png')}
    except Exception as e:  # the ending must never cost a video
        log.warning('%s: no ending this time (%s)', job['id'], e)
        return None


def hook_length(info, start, have):
    """The opening's length: the beat nearest HOOK_WANT seconds after the song's start, so the switch to the
    AI lands on it; at least HOOK_MIN + 0.4 s (when there is that much), at most what was kept."""
    hi = min(have, HOOK_MAX)
    lo = min(hi, HOOK_MIN + 0.4)
    if not info or not len(info.get('beats', [])):
        return min(HOOK_WANT, hi)
    near = np.asarray(info['beats']) - start
    near = near[(near >= lo) & (near <= hi)]
    return float(near[np.argmin(np.abs(near - HOOK_WANT))]) if len(near) else min(HOOK_WANT, hi)


def meme_edit(job, folder, parts, spans, speed, audio, info, start, used, lead=0.0, total=None, extra=()):
    """The meme edit for this cut of the video, when it is on, and other sound effects (extra: [(time, name)],
    the opening's whoosh): (zooms, sound effects WAV, its gain) for join_clips. The edit is planned on the
    animated parts' own timeline and moved `lead` seconds on (the opening plays first); the sound track is
    `total` seconds long (the whole video). (None, None, 1.0) when there is nothing to add, and also when
    anything goes wrong: the effects must never cost a video. The meme plan is also written to meme.json
    (local only), for checking."""
    (folder / 'meme.json').unlink(missing_ok=True)
    on = bool(meme and sfx and job.get('meme', False))
    if not (sfx and (on or extra)):
        return None, None, 1.0
    sounds = folder / 'sfx.wav'
    try:
        layout, at = [], 0.0
        for n, ((i, clip), span) in enumerate(zip(parts, spans)):
            _, _, frames, fps = clip_info(clip)
            first, _, shown = span_seconds(clip, span, speed)
            # cut: a plain cut leads into this part (clips from before v10); a part that carries on from the
            # one before skips its first frame instead.
            layout.append({'idea': job['ideas'][i], 'clip': str(clip), 'at': at, 'shown': shown,
                           'skip': first / fps / speed, 'full': frames / fps / speed, 'cut': n > 0 and not first})
            at += shown
        total = lead + at if total is None else total
        zooms, events = [], []
        if on:  # (the song is at start + lead when the animated parts begin)
            zooms, events = meme.plan(layout, info, start + lead, use_beats=used in ('funny', 'upload', 'mysong'),
                                      speed=speed, motion=True)
            for p in zooms:
                p['t0'] += lead
                if 'end' in p:
                    p['end'] += lead
            events = [(t + lead, name) for t, name in events]
        events = sorted(events + list(extra))
        gain = 1.0
        if events:  # the effects follow the song's loudness (none: as they are)
            gain = sfx.sfx_track(events, total, sounds, sfx.loudness(audio, start, total) if audio else None)
        if on:
            (folder / 'meme.json').write_text(json.dumps({'zooms': zooms, 'sounds': events, 'gain': gain}))
            log.info('%s: meme edit: %d zooms, sounds %s', job['id'], len(zooms), [name for _, name in events])
        return zooms or None, sounds if events else None, gain
    except Exception as e:
        log.warning('%s: meme effects skipped (%s)', job['id'], e)
        sounds.unlink(missing_ok=True)
        return None, None, 1.0


def voice_edit(job, folder, parts, shown, lead, total, quiet=False):
    """The pet voice for this cut, when it is on and works here: {'track', 'lines'} for join_clips, else None.
    Each caption is said once, when it shows (a part without its own text keeps the one before, as on the
    video; also when the captions are hidden), by the voice chosen or one that suits the animal. The first
    line waits for the switch when the video opens with the real seconds. shown: each part's seconds. None
    also when anything goes wrong: the voice must never cost a video. The lines go to voice.json (local only).
    quiet: no "Giving your pet a voice" on the job (the TikTok cut, made from a copy of it)."""
    (folder / 'voice.json').unlink(missing_ok=True)
    choice = job.get('voice') if job.get('voice') in VOICES else 'off'
    if choice == 'off' or not pet_voice:
        return None
    if not pet_voice.ready(wait=60):  # (the check runs when the worker starts: a few seconds)
        log.warning('%s: no pet voice on this worker (%s)', job['id'], pet_voice.why())
        return None
    path = folder / 'voice.wav'
    try:
        windows, said, t = [], '', 0.0  # [spoken words, start, end] on the animated parts' timeline
        for (i, _), seconds in zip(parts, shown):
            said = job['ideas'][i].get('caption') or said
            if windows and pet_voice.speakable(windows[-1][0]) == pet_voice.speakable(said):
                windows[-1][2] = t + seconds
            else:
                windows.append([said, t, t + seconds])
            t += seconds
        lines = [(text, lead + t0 + (VOICE_AFTER_SWITCH if lead and not n else VOICE_AT), lead + t1 - VOICE_GAP)
                 for n, (text, t0, t1) in enumerate(windows)]
        style = pet_voice.style_for('narrator' if choice == 'auto' and job.get('kind') == 'together' else choice,
                                    job.get('animal'))  # (Together: Auto is the narrator, one voice for the story)
        busy = None if quiet else (lambda: update(job, stage='Giving your pet a voice…', progress=0.92))
        placed = pet_voice.track(lines, style, folder, total, path, busy=busy)
        if not placed:
            return None
        (folder / 'voice.json').write_text(json.dumps({'voice': choice, 'style': style, 'lines': placed}))
        log.info('%s: pet voice (%s): %s', job['id'], style, [ln['text'] for ln in placed])
        return {'track': path, 'lines': placed}
    except Exception as e:
        log.warning('%s: no pet voice this time (%s)', job['id'], e)
        path.unlink(missing_ok=True)
        return None
    finally:
        if not quiet and job.get('stage') == 'Giving your pet a voice…':
            update(job, stage='Putting your video together…', progress=0.95)


def drop_clips(job, start):
    """Forget clip `start` and every clip after it: each of them began where the one before it ended."""
    job['clips_done'] = [n for n in job.get('clips_done') or [] if clip_number(n) < start]
    if 'chain' in job:
        job['chain'] = {k: v for k, v in job['chain'].items() if int(k) < start}


def said_animal(job):
    """The animal named in the user's description, if any."""
    animal = ideas.guess_animal(job.get('idea') or '')
    return '' if animal == 'animal' else animal


def new_ideas(job, animal, count):
    """Fresh ideas for a whole video of `count` parts, from the user's description or the chosen style.
    Callers that need only some parts (a longer video, a part made again) take those from it, so a story
    keeps its parts in order. The video is one shot, so its text stays from part 1 on: later parts get no
    text of their own, except the parts of a story, which each get their own line."""
    if count <= 0:
        return []
    template = job.get('template') or 'random'
    if job.get('idea'):
        style = job['scene']['scene']['style'] if job.get('scene') else None
        made = ideas.custom_ideas(job['idea'], animal, count, template, style)
    elif job.get('scene'):
        made = ideas.ideas_for_scene(job['scene']['scene'], animal, count, template)
    else:
        made = ideas.ideas_for_picture(animal, count, template)
    for k, idea in enumerate(made):
        if k and not idea.get('story'):
            idea['caption'] = ''
    return made


def refund(job):
    """A friend's video that never got made (it failed, or was deleted before any clip or AI picture) gives the use
    back."""
    with guests_lock:
        guest = guests.get(job.get('owner', 'me'))
        if not guest or job.get('refunded') or job.get('made') or job.get('thumb') or job.get('unpaid') \
                or job.get('gpu_spent'):
            return  # (Together: unpaid: a free copy used no video; gpu_spent: the AI made its picture)
        guest['uses_left'] += 1
        guest['used'] = max(0, guest['used'] - 1)
        job['refunded'] = True
    save_guests()


def needs_animation(job):
    """True when the job still needs the AI (a picture or a clip), not just a re-cut."""
    if job.get('kind') == 'together' and together:  # (Together) a free look is a cut on the CPU
        return together.needs_animation(job)
    if job.get('kind') == 'sing' and sing:  # (Sing) a voice or title change is a re-cut on the CPU
        return sing.needs_animation(job)
    if not job.get('inputs') or job.get('clips_done') is None:
        return True
    limit = 1 if job.get('draft') else job['wanted']
    return any(f'clip_{i}.mp4' not in job['clips_done'] for i in range(limit))


# ---------- The TikTok cut (Posting plan) ----------
# TikTok mutes (or takes down) a video when a song is baked into its file. So a video made with the owner's own
# song is posted as its TikTok cut: the same video without the song (the pet voice, the sound effects, the video's
# own sound, the opening and the ending stay), and the owner adds TikTok's own sound when posting. It is cut in the
# background when such a video goes in the posting plan, and again after each edit: never with the AI, one at a
# time, and kept with the video's files (tiktok.mp4; tiktok_rev = the version it was cut from).

cut_queue = queue.Queue()
cut_failed = {}  # job id -> the version whose TikTok cut failed (the plan offers the video as made; asked again: retried)
render_locks = {}  # job id -> held while that video is being made or cut, so the two never share its files
render_locks_lock = threading.Lock()


def render_lock(job_id):
    with render_locks_lock:
        return render_locks.setdefault(job_id, threading.Lock())


def has_song(job):
    """True when the video's file has a song in it to take out for TikTok (its own sound isn't one)."""
    return job.get('music_used') in ('funny', 'upload', 'mysong')


def cut_ready(job):
    """The TikTok cut is there for the video as it is now (a video without a song is its own TikTok cut)."""
    return not has_song(job) or (job.get('tiktok_rev') is not None and job.get('tiktok_rev') == job.get('rev'))


def cut_wanted(job_id):
    """The posting plan has this video, to be posted without its song."""
    with plan_lock:
        return any(item['job'] == job_id and item['audio'] == 'no_song' for item in plan_state.get('queue') or [])


def want_cut(job, retry=False):
    """Asks for the video's TikTok cut when the posting plan needs one and it isn't there for this version. When
    it failed for this version, it is tried again only on retry (the video went in the plan again, or was switched
    back to TikTok's sound): a caption change doesn't start it over."""
    if not (posting and job and cut_wanted(job['id']) and not cut_ready(job)):
        return
    if cut_failed.get(job['id']) == job.get('rev') and not retry:
        return
    cut_failed.pop(job['id'], None)  # (asked again: the plan waits for this try)
    cut_queue.put(job['id'])


def drop_cut(job_id):
    """A video that left the plan (posted, skipped or taken out): its TikTok cut is deleted here and in the
    dataset, so it doesn't keep taking room. It is cut again if the video goes back in the plan. In the background:
    it waits while the video is being made or cut. (job.json isn't saved for it: at the start, a cut that isn't
    in the dataset counts as not made.)"""
    with render_lock(job_id):
        job = jobs.get(job_id)
        gone = bool(job) and not cut_wanted(job_id) and job.get('tiktok_rev') is not None
        if gone:
            with jobs_lock:
                job['tiktok_rev'] = None
            (DATA / 'jobs' / job_id / 'tiktok.mp4').unlink(missing_ok=True)
    if gone and hub:
        try:
            hub.delete_file(f'jobs/{job_id}/tiktok.mp4', repo_id=DATASET, repo_type='dataset',
                            commit_message=f'{job_id}: TikTok cut no longer needed')
        except Exception as e:  # (not there, or the video was deleted meanwhile)
            log.info('%s: the TikTok cut was not deleted from the Hub (%s)', job_id, e)
    want_cut(jobs.get(job_id))  # (it went back in the plan meanwhile: it is cut again)


def left_plan(job_id):
    if job_id and posting:
        threading.Thread(target=drop_cut, args=(job_id,), daemon=True).start()


def cut_loop():
    while True:
        job_id = cut_queue.get()
        try:
            make_cut(job_id)
        except Exception as e:  # (the plan then shares the video as it was made)
            log.warning('%s: no TikTok cut this time (%s)', job_id, e)


def made_parts(job):
    """The animated parts the video has now, from the clips kept (the first ones, in order, as in final.mp4).
    Raises when one can't be had: the TikTok cut never asks the AI for anything. (Together: a free look's one
    layout clip, or its AI parts, from together.made_parts.)"""
    if job.get('kind') == 'together' and together:
        return together.made_parts(job, THIS)
    parts = []
    for i in range(1 if job.get('draft') else job['wanted']):
        name = f'clip_{i}.mp4'
        if name not in (job.get('clips_done') or []):
            break
        parts.append((i, local_file(job, name)))
    if not parts:
        raise RuntimeError('no animated parts kept')
    return parts


def make_cut(job_id):
    """Cuts the video's TikTok version (tiktok.mp4) for the version it has now, if the plan still wants it. It
    must come out exactly as long and as big as final.mp4, else it isn't used."""
    job = jobs.get(job_id)
    if not job or not cut_wanted(job_id) or cut_ready(job):
        return
    lock = render_lock(job_id)
    if not lock.acquire(blocking=False):
        return  # being made again right now: when that is done, it asks for its cut again
    folder = job_dir(job_id)
    out = folder / 'tiktok.new.mp4'
    try:
        with jobs_lock:
            if job_id not in jobs or job['status'] in ('queued', 'working') or not job.get('thumb'):
                return  # (an edit is on its way: the same)
            snap = copy.deepcopy(job)
        rev, started = snap.get('rev'), time.time()
        try:
            if snap.get('kind') == 'sing' and sing:  # (Sing) the same video stream without the song
                sing.cut_silent(snap, out)
            else:
                cut_video(snap, folder, made_parts(snap), out, song=False)
            want, got = clip_info(local_file(snap, 'final.mp4')), clip_info(out)
            if got != want:  # (size, frames, frame rate)
                raise RuntimeError(f'it came out different from the video: {got} instead of {want}')
        except Exception:
            cut_failed[job_id] = rev  # (GET /plan says so: the page offers the video as it was made)
            raise
        if not cut_wanted(job_id):  # (it left the plan while it was being cut)
            return
        os.replace(out, folder / 'tiktok.mp4')
        with jobs_lock:
            current = jobs.get(job_id) is job and job.get('rev') == rev
            if current:
                job['tiktok_rev'] = rev
        if not current:
            return
        save(job, ['tiktok.mp4'])
        with plan_lock:
            for item in plan_state['queue']:
                if item['job'] == job_id:
                    item['cut_rev'] = rev
        save_plan()
        log.info('%s: TikTok cut of version %s ready (%.1f s)', job_id, rev, time.time() - started)
    finally:
        out.unlink(missing_ok=True)
        lock.release()


# ---------- "Your video is ready" notifications ----------
# The page subscribes a phone (Web Push). When a video that needed the AI is done (or fails), the worker
# sends an end-to-end encrypted message to the push service of each phone of whoever made it.

PUSH_HOSTS = ('fcm.googleapis.com', 'jmt17.google.com', 'android.googleapis.com', 'updates.push.services.mozilla.com',
              'web.push.apple.com', '.push.apple.com', '.notify.windows.com')  # Chrome, Firefox, Safari, Edge
# A plain https address: no user@ part, no other port, no backslash (requests reads 'https://a\@b' as host a).
PUSH_URL = re.compile(r'https://([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::443)?/[!-\[\]-~]*', re.I)
PUSH_SUBJECT = 'https://huggingface.co/spaces/' + os.environ.get('SPACE_ID', 'antics')  # contact, no email
MAX_PHONES = 5  # per person; the oldest is dropped


def push_ok(endpoint):
    """Only real browser push services: the worker never POSTs to an address someone made up."""
    url = urlsplit(endpoint)
    if f'{url.scheme}://{url.netloc}' in os.environ.get('ANTICS_PUSH_TEST', '').split(','):  # local tests only
        return True
    plain = PUSH_URL.fullmatch(endpoint)
    host = plain[1].lower() if plain else ''
    return any(host == h or (h[0] == '.' and host.endswith(h)) for h in PUSH_HOSTS)


def vapid():
    """The worker's own push key: made once, kept with the videos."""
    with push_lock:
        made = not push['vapid']
        if made:
            push['vapid'] = webpush.new_vapid_key()
    if made:
        save_push()
    return push['vapid']


def ping(who_id, message, wait=False):
    """Notify every phone of 'me' or a friend, once each. Phones that turned notifications off are forgotten.
    Returns how many took it (wait=True) or how many it is sent to (in the background)."""
    with push_lock:
        phones, key = list(push['subs'].get(who_id) or []), push['vapid']
    if not webpush or not phones or not key:
        return 0

    def run():
        sent, gone = 0, []
        for phone in phones:
            try:
                res = webpush.send(phone, message, key, PUSH_SUBJECT, topic=message.get('job', ''))
                if res.status_code in (404, 410):
                    gone.append(phone['endpoint'])
                elif 200 <= res.status_code < 300:
                    sent += 1
                else:
                    log.warning('notification to %s: %s %s', urlsplit(phone['endpoint']).hostname, res.status_code,
                                res.text[:200])
            except Exception as e:  # a notification must never cost a video
                log.warning('notification failed: %s', e)
        if gone:
            with push_lock:
                if who_id in push['subs']:  # (not a friend who was removed meanwhile)
                    push['subs'][who_id] = [p for p in push['subs'][who_id] or [] if p['endpoint'] not in gone]
            save_push()
        return sent

    if wait:
        return run()
    threading.Thread(target=run, daemon=True).start()
    return len(phones)


def ping_done(job, failed=False):
    """'Your video is ready' (or 'couldn't be made') on the phones of whoever made it. Never raises."""
    try:
        label = (job.get('label') or ('Surprise' if job.get('kind') == 'surprise' else 'Your video')).strip()
        part = f" ({job.get('index', 0) + 1} of {job['batch']})" if (job.get('batch') or 1) > 1 else ''
        if failed:
            title, body = f"A video couldn't be made{part}", job.get('error') or 'Open antics to try again.'
        elif job.get('draft'):
            title, body = f'Your preview is ready{part}', f'{label}. Watch it, then tap Finish.'
        else:
            secs = f" · {round(job['seconds_long'])} sec" if job.get('seconds_long') else ''
            title, body = f'Your video is ready{part}', f'{label}{secs}. Tap to watch and save.'
        message = {'title': title, 'body': body[:180], 'tag': f"antics-{job.get('group') or job['id']}",
                   'url': f"index.html#video={job['id']}", 'job': job['id']}
        ping(job.get('owner', 'me'), message)
    except Exception as e:
        log.warning('%s: no notification (%s)', job.get('id'), e)


def enqueue(job):
    (work_queue if needs_animation(job) else quick_queue).put(job['id'])


def make_video(job):
    """(Together) Makes the video: a Together video by together.process (it gets the animals and the picture first,
    then calls process() for its AI parts, or cuts a free look), any other by process(). worker_loop calls this
    inside the video's render_lock, so its TikTok cut is never made at the same time.)"""
    if job.get('kind') == 'together' and together:
        return together.process(job, THIS)
    if job.get('kind') == 'sing' and sing:  # (Sing)
        return sing.process(job, THIS)
    return process(job)


def worker_loop(lane):
    while True:
        job_id = lane.get()
        job = jobs.get(job_id)
        with jobs_lock:  # a job can sit in both lanes after edits: only one may take it
            if not job or job['status'] != 'queued':
                continue
            job['status'] = 'working'
        update(job, error='', gpu_wait=None)
        slow = needs_animation(job)  # new AI clips take minutes: a notification when it's done (re-cuts are watched)
        try:
            with render_lock(job_id):  # (its TikTok cut, if one is being cut right now, finishes first)
                make_video(job)  # (Together: a Together video goes to together.process)
            log.info('%s done', job_id)
        except Paused:  # (Together) the picture check: it carries on by itself, no notification
            continue
        except (QuotaError, BusyError) as e:
            reason = e.reason if isinstance(e, QuotaError) else 'busy'
            stage = {'quota': 'Out of free AI time today. It will finish by itself.',
                     'stopped': 'AI work is stopped: Hugging Face started charging credits. The owner can tap Resume '
                                'in Settings.',
                     'unreadable': "Your free AI time can't be checked right now, so no AI work is done. It will "
                                   'finish by itself.',
                     'loading': 'Your worker is still starting. It will finish by itself.',
                     'saving': 'Hugging Face is busy right now. It will finish by itself.'}.get(
                reason, 'The free GPUs are all busy right now. It will finish by itself.')
            extra = {}
            if job.get('kind') == 'sing' and sing and isinstance(e, QuotaError):  # (Sing) "Singing 4 of 7 done ...",
                extra['sing_wait'] = sing.wait_reason(e)  # or why no AI call can be made now (the key can't read the
                stage = sing.wait_text(job, extra['sing_wait'])  # free time, the worker is starting ...): the guard's
                # texts above stay for every other video (and gpu_wait for all), a Sing job takes this one, which
                # words every reason (wait_text)
            # (a QuotaError's wait already has its minute after the reset; the GPU guard's clock is the one to use)
            update(job, status='waiting', stage=stage,
                   gpu_wait=reason if reason in ('quota', 'stopped', 'unreadable') else None,
                   retry_at=gpu.now() + e.wait_seconds + (0 if isinstance(e, QuotaError) else 60), progress=0, **extra)
            save(job)
            continue  # (no notification: it finishes by itself, and that one sends it)
        except Exception as e:
            if sing and isinstance(e, sing.PcWait):  # (Sing) made on the owner's PC: it waits for it (and wakes then)
                update(job, status='waiting', stage=str(e), retry_at=time.time() + e.wait_seconds,
                       sing_wait=getattr(e, 'why', 'pc'))  # ('pc_singing': the PC is singing one of its shots now)
                save(job)
                continue
            log.exception('%s failed', job_id)
            update(job, status='failed', error=friendly(e), stage='')
            refund(job)
            save(job)
            if slow:
                ping_done(job, failed=True)
            continue
        finally:
            want_cut(job)  # a new version needs its TikTok cut again (when the posting plan has it)
        if slow:
            ping_done(job)


def friendly(e):
    msg = str(e)
    if 'Unsupported URL' in msg or 'is not a valid URL' in msg:
        return "This link isn't supported. Try a TikTok, YouTube, Instagram, X or Facebook video link."
    if re.search(r'sign in to confirm|not a bot|login required|private video|cookies|empty media response|'
                 r'rate-limit|not available|forbidden|\b403\b', msg, re.I):
        return 'That site blocked the download (it wants a login). Save the video to your phone and upload it instead.'
    if 'max_filesize' in msg or 'larger than max-filesize' in msg:
        return 'That video is too big. Try a shorter clip.'
    return msg[:300]


def wake_waiting(now_anyway=False):
    """Put waiting jobs back in line once their wait is over (or right away when the PC is on, or on Resume)."""
    now = gpu.now()
    for job in list(jobs.values()):
        if now_anyway and job.get('picture_check') and (job.get('retry_at') or 0) > now:
            continue  # (Together: the user is still looking at the picture)
        if job['status'] == 'waiting' and (now_anyway or (job.get('retry_at') or 0) <= now):
            update(job, status='queued', stage='In line…')
            enqueue(job)


SCHEDULER_EVERY = 60  # seconds between the scheduler's rounds


def scheduler_loop():
    """Every minute: read the dataset files that couldn't be read at the start, wake jobs that were waiting for
    the free GPU time to come back, send the posting plan's reminders, and save the GPU guard's state again if that
    failed. None can stop the others, or the loop."""
    while True:
        time.sleep(SCHEDULER_EVERY)
        for step in (read_again, wake_waiting, posting_tick, gpu.flush):
            try:
                step()
            except Exception as e:
                log.warning('scheduler: %s failed (%s)', step.__name__, e)


def posting_tick():
    """The posting plan's reminders. Each time that came is marked fired and saved before its notification goes,
    so a restart never sends one twice. One that came while the worker slept still reminds up to 3 hours late,
    else it is counted as missed. One notification a round (when two times came at once, it is about both videos),
    for the next waiting video (it is then 'reminded'); with none waiting, the one ready to post the longest is
    reminded again; with none at all, the owner hears once a day that the plan is empty. Nothing while the plan
    is still loading."""
    if not posting or is_unread('posting.json'):
        return
    t = posting.now()
    with plan_lock:
        fire, changed = posting.tick(plan_state, t)
    if not changed:
        return
    save_plan()  # (before anything is sent)
    with plan_lock:
        kind, items = posting.remind(plan_state, len(fire), t, known=lambda job_id: job_id in jobs)
        labels = [short_label(jobs.get(item['job']) or {}) for item in items]
        link = f"index.html#post={items[0]['id']}" if items else 'index.html#plan'
    if not kind:
        return
    if kind == 'empty':
        message = {'title': 'Your posting plan is empty', 'body': 'Add videos with + Plan'}
    elif kind == 'again':
        message = {'title': 'Still ready to post 🎬', 'body': f'{labels[0]} · caption ready'}
    elif len(items) > 1:
        message = {'title': 'Time to post on TikTok 🎬',
                   'body': f'{len(items)} videos ready to post · captions ready'}
    else:
        message = {'title': 'Time to post on TikTok 🎬', 'body': f'{labels[0]} · caption ready'}
    ping(OWNER['id'], dict(message, tag='antics-post', url=link))
    save_plan()


# ---------- API ----------

def update_downloader():
    """Sites change often, so get the newest yt-dlp each time the worker starts."""
    try:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--user', '-q', '-U', 'yt-dlp'],
                       check=True, capture_output=True, timeout=300)
    except (subprocess.SubprocessError, OSError) as e:
        log.warning('could not update yt-dlp: %s', e)


@asynccontextmanager
async def lifespan(_app):
    DATA.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=update_downloader, daemon=True).start()
    if pet_voice:
        pet_voice.start_check()  # (in the background: the worker doesn't wait for it)
    if sing:
        sing.attach(THIS)  # (Sing)
    load_jobs()
    threading.Thread(target=worker_loop, args=(work_queue,), daemon=True).start()
    threading.Thread(target=worker_loop, args=(quick_queue,), daemon=True).start()
    threading.Thread(target=cut_loop, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    threads_up.set()
    gpu.view()  # (reads the quota in the background, so /health has it)
    if sing:  # (Sing) every My song without its singing pack is prepared in the background (Детство first)
        sing.start(THIS)
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])


OWNER = {'id': 'me'}


def same(a, b):
    return bool(a) and bool(b) and secrets.compare_digest(str(a).encode(), str(b).encode())


def caller(header_key, query_key=None):
    """Who is asking: the owner (the worker key) or a friend (their invite key)."""
    key = header_key or query_key or ''
    if same(key, ANTICS_KEY):
        return OWNER
    with guests_lock:
        for guest in guests.values():
            if same(key, guest['key']):
                return guest
    if key and is_unread('guests.json'):
        need_read('guests.json', 'Your worker is')  # (a friend's key isn't wrong while the friends list loads)
        return caller(header_key, query_key)
    raise HTTPException(401, 'Wrong or missing worker key')


def check(header_key, query_key=None):
    """Owner only: friends, settings and the PC helper."""
    if caller(header_key, query_key) is not OWNER:
        raise HTTPException(403, 'Only the owner can do that')


def me_view(who):
    if who is OWNER:
        return {'role': 'owner'}
    return {'role': 'guest', 'name': who['name'], 'host': who.get('host') or '', 'uses_left': who['uses_left'],
            'used': who['used'], 'redos': GUEST_REDOS}


def host_of(who):
    return who.get('host') or 'your friend'


def own_job(who, job_id):
    """A job the caller may see: the owner sees every job, a friend only their own."""
    job = jobs.get(job_id)
    if not job or (who is not OWNER and job.get('owner') != who['id']):
        raise HTTPException(404, 'No such video')
    return job


def clean_animal(text):
    return re.sub(r'[^a-zA-Z ]', '', text or '').strip().lower()[:30]


def clean_idea(text):
    return re.sub(r'\s+', ' ', text or '').strip()[:160]


def clean_name(text):
    return re.sub(r'\s+', ' ', plain_text(text or '')).strip()[:30]


def clip_number(name):
    return int(re.search(r'\d+', name)[0])


@app.get('/', response_class=PlainTextResponse)
def home():
    return 'Animal Antics worker is running.'


def features():
    """What this worker can do right now. The page shows a feature's controls only when it is listed.
    chain: a video is one continuous shot, and a preview is just its first part.
    meme: zoom punch-ins and sound effects at the funny moments (the meme field of a video).
    opening: the Real -> AI opening (the opening field; the hooks + hook_fps an upload sends).
    outro: the Follow me ending (the outro field; the owner's endcard).
    voice: the pet voice (the voice field), only when its packages import and its model is on disk (checked
    in the background when the worker starts, so it shows up a few seconds after).
    push: "your video is ready" notifications (/push/...), only when the cryptography package imports.
    songs: My songs (/songs: the owner's saved songs, each starting at its meme part; music 'mysong' + song_id).
    plan: the Posting plan (/plan: the owner's queue of videos to post, reminders, hashtags; the TikTok cut of a
    video with a song: /jobs/{id}/video?cut=tiktok).
    gpu: the GPU guard (/health "gpu": the free AI time left today and its reset, alert 'billed' when it stopped all
    AI work because Hugging Face charged credits; POST /gpu/resume; a waiting video's gpu_wait).
    together: Together videos (mode 'together' of POST /jobs, /jobs/{id}/copy, the edit's scene/look/recompose/
    order/names). library: the free clip library (library.json, by id in a Together video's cast).
    (Sing) sing: Sing videos (mode 'sing' of POST /jobs, /songs/{id}/sing, /songs/{id}/voice, /gpu, /settings,
    /jobs/{id}/test, /jobs/{id}/shots/{k}/redo), only when sing.py, sing_audio.py and a voice/music split import
    here; sing_duet: two singers; sing_best: the best split (RoFormer); gpu_guard: the free-for-sure GPU guard."""
    return (['chain'] + (['meme'] if meme and sfx else []) + ['opening', 'outro']
            + (['voice'] if pet_voice and pet_voice.ready() else []) + (['push'] if webpush else []) + ['songs']
            + (['plan'] if posting else []) + ['gpu']
            + (['together'] if together else []) + (['library'] if together and together.load_library() else [])
            + (sing.features() if sing else []))


@app.get('/health')
def health():
    # gpu: {readable, left, base (seconds), resets_at (unix or None), alert ('billed' or None), stopped, blind (why
    # the quota can't be read: 'key' or 'down', else None), estimated (a free account's ledger), key_refused}; it
    # never waits for Hugging Face (the quota is read in the background, at most every gpu.CACHE seconds).
    g = gpu.view()  # (token_ok: also false once Hugging Face refuses the key for the quota and whoami: revoked)
    out = {'ok': True, 'version': VERSION, 'storage': bool(hub), 'token': bool(HF_TOKEN),
           'token_ok': token_ok and not g['key_refused'], 'pc': pc_online(), 'pc_name': pc['name'],
           'features': features(), 'gpu': g}
    if sing:  # (Sing) the guard, the splits, the engines' test results, whether the PC can sing
        out['sing'] = sing.health()
        out['pc_sing'] = out['sing']['pc']
    return out


@app.post('/gpu/resume')
def gpu_resume(x_antics_key: str = Header(None)):
    """Owner only: AI work goes on after the GPU guard stopped it (still only within the free time). The videos
    that waited for it go back in line."""
    check(x_antics_key)
    view = gpu.resume()
    for job in list(jobs.values()):
        if job['status'] == 'waiting' and job.get('gpu_wait') == 'stopped':
            update(job, status='queued', stage='In line…', gpu_wait=None, retry_at=None)
            enqueue(job)
    return {'ok': True, 'gpu': view}


@app.get('/me')
def whoami(x_antics_key: str = Header(None)):
    return {**me_view(caller(x_antics_key)), 'version': VERSION}


@app.get('/jobs')
def list_jobs(x_antics_key: str = Header(None)):
    who = caller(x_antics_key)
    with jobs_lock:
        items = sorted((j for j in jobs.values() if who is OWNER or j.get('owner') == who['id']),
                       key=lambda j: (-j['created'], j.get('index', 0)))
        return {'jobs': [public(j) for j in items], 'version': VERSION, 'me': me_view(who)}


@app.post('/jobs')
def create_job(
    x_antics_key: str = Header(None),
    url: str = Form(''),
    surprise: bool = Form(False),
    clips: int = Form(3),
    captions: bool = Form(True),
    animal: str = Form(''),
    seconds: float = Form(5),
    template: str = Form('random'),
    music: str = Form('funny'),
    track: str = Form(''),
    song_part: str = Form('auto'),
    song_start: float = Form(0),
    speed: str = Form('normal'),
    idea: str = Form(''),
    count: int = Form(1),
    draft: bool = Form(False),
    meme_on: bool = Form(True, alias='meme'),  # (not named meme: that is the module)
    opening: bool = Form(False),
    outro: bool = Form(False),
    voice: str = Form('off'),
    hook_fps: float = Form(30),
    song_id: str = Form(''),
    images: list[UploadFile] = File(None),
    source: UploadFile = File(None),
    song: UploadFile = File(None),
    badge: UploadFile = File(None),
    endcard: UploadFile = File(None),
    hooks: list[UploadFile] = File(None),
    mode: str = Form(''),  # (Together) 'together': 2-4 animals in one video (see together.build_jobs)
    scene: str = Form(''),
    look: str = Form('ai'),
    cast: str = Form(''),
    real_fps: float = Form(30),
    cast_files: list[UploadFile] = File(None),
    singers: str = Form(''),  # (Sing) 'sing': 1-2 singers sing a song (see sing.build_jobs)
    part: str = Form('meme'),
    part_from: float = Form(None),
    part_to: float = Form(None),
    shots: str = Form('cuts'),
    who: str = Form('turns'),
    voices: str = Form('original'),
    sharp: str = Form('sharp'),
    engine: str = Form('online'),
    test: bool = Form(False),
    test_engine: str = Form(''),
    title_on: bool = Form(True),
    beat_zooms: bool = Form(True),
    song_name: str = Form(''),
    singer_files: list[UploadFile] = File(None),
):
    caller_ = caller(x_antics_key)
    if mode == 'sing':  # (Sing) its own form: the singers, the song and its part, the stage, the voices
        if not (sing and sing.ready()):
            raise HTTPException(400, "This worker can't make Sing videos. Update it in Settings.")
        return sing_job(caller_, {
            'singers': singers, 'cast_files': (cast_files or []) + (singer_files or []) + (images or []),
            'real_fps': real_fps, 'song_id': song_id, 'song': song, 'song_name': song_name, 'part': part,
            'part_from': part_from, 'part_to': part_to, 'look': look, 'shots': shots, 'who': who, 'voices': voices,
            'sharp': sharp, 'engine': engine, 'test': test, 'test_engine': test_engine, 'draft': draft,
            'opening': opening, 'outro': outro, 'title_on': title_on, 'beat_zooms': beat_zooms, 'badge': badge,
            'endcard': endcard})
    who = caller_
    if music == 'mysong':
        need_read('songs.json', 'Your songs are')
    url = url.strip()
    pack = mode == 'together' and together  # (Together)
    if mode == 'together' and not together:
        raise HTTPException(400, "This worker can't make Together videos. Update it in Settings.")
    if not (pack or images or surprise or re.match(r'^https?://\S+$', url)):
        raise HTTPException(400, 'Paste a video link, upload a video, or tap Surprise me')
    count = max(1, min(MAX_VIDEOS, count))
    if who is not OWNER:  # a friend's videos are counted, and given back if they can't be made
        with guests_lock:
            count = min(count, who['uses_left'])
            if count <= 0:
                raise HTTPException(403, f'No videos left. Ask {host_of(who)} for more.')
            who['uses_left'] -= count
            who['used'] += count
    wanted = max(1, min(MAX_CLIPS, clips))
    music = music if music in MUSIC_MODES else 'funny'
    song_id = chosen_song(song_id) if music == 'mysong' else ''  # (friends may use the owner's songs too)
    if music == 'mysong' and not song_id:
        music = 'funny'  # no saved song (any more): the meme song for the style
    settings = {
        'captions': captions, 'seconds': max(2, min(5, seconds)), 'animal': clean_animal(animal),
        'template': template if template in ideas.TEMPLATES else 'random',
        'music': music, 'song_id': song_id,
        'track': track if music == 'track' and track in ideas.MUSIC else '',
        'song_part': song_part if song_part in ('auto', 'start', 'drop', 'custom') else 'auto',
        'song_start': max(0.0, min(3600.0, song_start)),
        'speed': speed if speed in SPEEDS else 'normal',
        # A preview is the first part of a longer video: a one-part (5 s) video is made in full at once.
        'idea': clean_idea(idea), 'draft': draft and wanted > 1, 'brand': True,
        'meme': meme_on,  # zoom punch-ins and sound effects (CPU only)
        # The Real -> AI opening (needs real video: a link or the frames the page sends with an upload) and the
        # Follow me ending (needs the owner's follow card). Both can be switched on and off later.
        'opening': opening, 'outro': outro,
        'voice': voice if voice in VOICES else 'off',  # the pet voice (CPU only; used when this worker has it)
    }
    try:
        if pack:  # (Together) the animals, their files, the scene and the look
            made = together.build_jobs(THIS, who, count, settings, {
                'scene': scene, 'look': look, 'cast': cast, 'cast_files': cast_files, 'real_fps': real_fps,
                'clips': clips, 'song': song, 'badge': badge, 'endcard': endcard})
        else:
            made = build_jobs(who, count, wanted, settings, url, surprise, images, source, song, badge, endcard, hooks,
                              max(10.0, min(60.0, hook_fps)))
    except Exception:
        if who is not OWNER:
            with guests_lock:
                who['uses_left'] += count
                who['used'] = max(0, who['used'] - count)
        raise
    if who is not OWNER:
        save_guests()
    for job in made:
        enqueue(job)
    return {'jobs': [public(j) for j in made], 'me': me_view(who)}


def sing_job(who, form):
    """(Sing) One Sing video (a friend's counts as one of their videos, given back if it can't be made)."""
    if who is not OWNER:
        with guests_lock:
            if who['uses_left'] <= 0:
                raise HTTPException(403, f'No videos left. Ask {host_of(who)} for more.')
            who['uses_left'] -= 1
            who['used'] += 1
    try:
        made = sing.build_jobs(THIS, who, form)
    except BaseException:
        if who is not OWNER:
            with guests_lock:
                who['uses_left'] += 1
                who['used'] = max(0, who['used'] - 1)
        raise
    if who is not OWNER:
        save_guests()
    for job in made:
        enqueue(job)
    return {'jobs': [public(j) for j in made], 'me': me_view(who)}


def shared_files(who, folder, settings, song, badge, endcard):
    """The files every video of a batch gets a copy of: the creator's name tag, the owner's follow card and an
    uploaded song, kept in `folder`. Returns their names and the flags they set (Together videos use it too)."""
    shared, flags = [], {}
    if badge:  # the creator's name tag, drawn by the page
        try:
            tag = Image.open(badge.file).convert('RGBA')
            tag.thumbnail((OUT_W - 48, 200))
            tag.save(folder / 'badge.png')
            shared.append('badge.png')
            flags['has_badge'] = True
        except Exception:
            log.warning('%s: the name tag could not be read', folder.name)
    if endcard and who is OWNER:  # the owner's follow card for the ending, drawn by the page (720x1280)
        try:
            card = Image.open(endcard.file).convert('RGBA')
            if card.size != (OUT_W, OUT_H):
                card = card.resize((OUT_W, OUT_H), Image.LANCZOS)
            card.save(folder / 'endcard.png')
            shared.append('endcard.png')
            flags['has_endcard'] = True
        except Exception:
            log.warning('%s: the follow card could not be read', folder.name)
    if song and settings['music'] == 'upload':
        original = folder / 'song_original'
        with open(original, 'wb') as f:
            shutil.copyfileobj(song.file, f)
        if extract_sound(original, folder / 'song.m4a'):
            shared.append('song.m4a')
            flags.update(has_song=True, upload_name=upload_name(song))
        original.unlink(missing_ok=True)
    return shared, flags


def build_jobs(who, count, wanted, settings, url, surprise, images, source, song, badge, endcard=None, hooks=None,
               hook_fps=30.0):
    """`count` new videos from the same input. Files the user sent are read once and copied to each."""
    now, group = time.time(), (secrets.token_hex(4) if count > 1 else None)
    made = [dict(settings, id=f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}", created=now, index=k,
                 batch=count, group=group, status='queued', stage='In line…', progress=0, error='', wanted=wanted,
                 made=0, clips_done=[], chain={}, redos=0, owner=who['id'],
                 owner_name='' if who is OWNER else who['name'])
            for k in range(count)]
    folder = job_dir(made[0]['id'])
    shared, flags = shared_files(who, folder, settings, song, badge, endcard)
    if images:
        pictures = []
        for upload in images[:MAX_CLIPS * MAX_VIDEOS]:
            try:
                img = Image.open(upload.file)
                img.load()
            except Exception:
                raise HTTPException(400, 'That picture could not be opened')
            pictures.append(img)
        for k, job in enumerate(made):
            # One starting picture per video: the page sends a different moment for each when it can.
            save_picture(pictures[k % len(pictures)], job_dir(job['id']) / 'input_0.jpg')
            job.update(kind='images', inputs=['input_0.jpg'], label='Your video')
        # The opening's frames, picked on the phone: v{k}_{i}.jpg are the real frames right before picture k.
        frames = {}  # picture number -> {frame number: file}
        for upload in (hooks or [])[:MAX_VIDEOS * int(HOOK_MAX * 60)]:
            found = re.fullmatch(r'v(\d+)_(\d+)\.jpe?g', upload.filename or '', re.I)
            if found and int(found[1]) < len(pictures):
                path = folder / f'hookframe_{int(found[1])}_{int(found[2]):04d}.jpg'
                with open(path, 'wb') as f:
                    shutil.copyfileobj(upload.file, f)
                frames.setdefault(int(found[1]), {})[int(found[2])] = path
        built = {}  # picture number -> the job folder holding its hook.mp4 (videos sharing a picture share it)
        for k, job in enumerate(made):
            p = k % len(pictures)
            if p in built:
                if built[p][1]:
                    shutil.copy(built[p][0] / 'hook.mp4', job_dir(job['id']) / 'hook.mp4')
                    job['hook_frames'] = built[p][1]
                continue
            got = 0
            if frames.get(p):
                got = hook_from_frames([frames[p][i] for i in sorted(frames[p])], hook_fps, job_dir(job['id']))
            built[p] = (job_dir(job['id']), got)
            if got:
                job['hook_frames'] = got
        for path in folder.glob('hookframe_*.jpg'):  # (any left over)
            path.unlink(missing_ok=True)
        if source and settings['music'] == 'mine':
            original = folder / 'original'
            with open(original, 'wb') as f:
                shutil.copyfileobj(source.file, f)
            if extract_sound(original, folder / 'sound.m4a'):
                shared.append('sound.m4a')
                flags['has_sound'] = True
            original.unlink(missing_ok=True)
    elif surprise:
        for job in made:
            job.update(kind='surprise', label='Surprise me')
    else:
        for job in made:
            job.update(kind='link', url=url, label='')
    for job in made:
        job.update(flags)
        if job is not made[0]:
            for name in shared:
                shutil.copy(folder / name, job_dir(job['id']) / name)
    with jobs_lock:
        for job in made:
            jobs[job['id']] = job
    save_many([(job, (job.get('inputs') or []) + shared + (['hook.mp4'] if job.get('hook_frames') else []))
               for job in made])
    return made


@app.post('/jobs/{job_id}/edit')
def edit_job(
    job_id: str,
    x_antics_key: str = Header(None),
    texts: str = Form(None),
    idea: str = Form(None),
    template: str = Form(None),
    animal: str = Form(None),
    clips: int = Form(None),
    music: str = Form(None),
    track: str = Form(None),
    song_part: str = Form(None),
    song_start: float = Form(None),
    speed: str = Form(None),
    captions: bool = Form(None),
    brand: bool = Form(None),
    meme_on: bool = Form(None, alias='meme'),
    opening: bool = Form(None),
    outro: bool = Form(None),
    voice: str = Form(None),
    redo: str = Form(''),
    song: UploadFile = File(None),
    song_id: str = Form(None),
    scene: str = Form(None),  # (Together) another scene card, look, ↻ New picture, ⇄ Swap places, names
    look: str = Form(None),
    recompose: bool = Form(None),
    order: str = Form(None),
    names: str = Form(None),
    voices: str = Form(None),  # (Sing) the voices (a re-mix), who sings what, the part, shots, angles, ↻ pictures
    who: str = Form(None),
    part: str = Form(None),
    part_from: float = Form(None),
    part_to: float = Form(None),
    shots: str = Form(None),
    angles: str = Form(None),
    repicture: str = Form(None),
    title_on: bool = Form(None),
    beat_zooms: bool = Form(None),
):
    """Change a video. Text, music, speed, length, meme effects, the pet voice, the opening and the ending re-cut
    it in seconds. A new description, style or animal, or redo (clip numbers), animates the clips concerned again."""
    sing_form = {'voices': voices, 'who': who, 'part': part, 'part_from': part_from, 'part_to': part_to,
                 'shots': shots, 'angles': angles, 'repicture': repicture, 'title_on': title_on,
                 'beat_zooms': beat_zooms, 'look': look, 'redo': redo, 'opening': opening, 'outro': outro,
                 'brand': brand}  # (Sing)
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    if job.get('kind') == 'sing' and sing:  # (Sing) its own edit: voices, who sings, part, shots, pictures, look
        return sing.edit(THIS, job, who, sing_form)
    if music == 'mysong':
        need_read('songs.json', 'Your songs are')
    try:
        texts = [str(t)[:120] for t in json.loads(texts)] if texts else []
    except (ValueError, TypeError):
        raise HTTPException(400, 'Could not read the new texts')
    new_song_id = chosen_song(song_id or job.get('song_id')) if music == 'mysong' else None
    if music == 'mysong' and not new_song_id:
        raise HTTPException(400, "That song isn't saved any more. Pick another one.")
    folder = job_dir(job['id'])
    new_song = None
    if song is not None and music == 'upload':
        original, new_song = folder / 'song_original', folder / 'song.new.m4a'
        with open(original, 'wb') as f:
            shutil.copyfileobj(song.file, f)
        ok = extract_sound(original, new_song)
        original.unlink(missing_ok=True)
        if not ok:
            raise HTTPException(400, "That song file couldn't be read. Try an MP3 or M4A.")
    if job.get('kind') == 'together' and together:  # (Together) its own edit: scene, look, picture, order, names
        return together.edit(THIS, job, who, {
            'texts': texts, 'idea': idea, 'clips': clips, 'music': music, 'track': track, 'song_part': song_part,
            'song_start': song_start, 'speed': speed, 'captions': captions, 'brand': brand, 'meme': meme_on,
            'opening': opening, 'outro': outro, 'voice': voice, 'redo': redo, 'new_song': new_song,
            'new_song_id': new_song_id, 'scene': scene, 'look': look, 'recompose': recompose, 'order': order,
            'names': names, 'upload_name': upload_name(song) if new_song else None})
    with jobs_lock:
        if job['status'] == 'working':
            raise HTTPException(409, 'Still working on this one. Edit it when it is ready.')
        if job.get('clips_done') is None:
            raise HTTPException(409, 'This video was made before editing existed. Make it again to edit it.')
        if not job.get('ideas') or not job.get('inputs'):
            raise HTTPException(409, 'Wait for the first version, then edit it.')
        wanted = job['wanted'] if clips is None else max(1, min(MAX_CLIPS, clips))
        old_idea, old_template = job.get('idea') or '', job.get('template') or 'random'
        new_idea = old_idea if idea is None else clean_idea(idea)
        new_template = template if template in ideas.TEMPLATES else old_template
        new_animal = job.get('animal')
        if animal is not None and job['kind'] != 'surprise' and clean_animal(animal):
            new_animal = clean_animal(animal)
        redo_set = {int(n) for n in re.findall(r'\d+', redo or '') if int(n) < wanted}
        replan = new_idea != old_idea or new_template != old_template or new_animal != job.get('animal')
        repaint = job['kind'] == 'surprise' and new_idea != old_idea
        done = list(job.get('clips_done') or [])
        # Each clip carries on from the one before, so a clip made again takes every later clip with it.
        keep = min(redo_set | {wanted})
        lost = done if replan else [n for n in done if keep <= clip_number(n) < wanted]
        if who is not OWNER and lost and job.get('redos', 0) >= GUEST_REDOS:
            raise HTTPException(403, f'This video used its {GUEST_REDOS} new animations. Change its text or '
                                     'music, or make a new video.')
        # Text the user typed (now or in an earlier edit) stays, even when its clip gets a new idea.
        typed = {i: idea['caption'] for i, idea in enumerate(job['ideas']) if idea.get('typed')}
        typed.update({i: t for i, t in enumerate(texts) if i < len(job['ideas']) and t != job['ideas'][i]['caption']})
        if lost:
            job['redos'] = job.get('redos', 0) + 1
        old_music = job.get('music')
        job.update(idea=new_idea, template=new_template, animal=new_animal, wanted=wanted)
        if wanted == 1:  # a preview of a one-part video is the whole video
            job['draft'] = False
        if music in MUSIC_MODES and not (music == 'mine' and not job.get('has_sound')):
            job['music'] = music
        if new_song_id:  # a saved song (or another one): just a re-cut
            job['song_id'] = new_song_id
        if job['music'] == 'track' and track in ideas.MUSIC:
            job['track'] = track
        elif job['music'] == 'funny' and (old_music != 'funny' or new_template != old_template):
            job['track'] = ideas.pick_music(new_template)  # a meme song that suits the style
        if new_song:
            os.replace(new_song, folder / 'song.m4a')
            job.update(has_song=True, upload_name=upload_name(song))
        if song_part in ('auto', 'start', 'drop', 'custom'):
            job['song_part'] = song_part
        if song_start is not None:
            job['song_start'] = max(0.0, min(3600.0, song_start))
        if speed in SPEEDS:
            job['speed'] = speed
        if captions is not None:
            job['captions'] = captions
        if brand is not None:
            job['brand'] = brand
        if meme_on is not None:  # effects on or off: just a re-cut, no new animation
            job['meme'] = meme_on
        if opening is not None:  # the Real -> AI opening and the Follow me ending: also just a re-cut
            job['opening'] = opening
        if outro is not None:
            job['outro'] = outro
        if voice in VOICES:  # the pet voice on, off or another voice: just a re-cut too
            job['voice'] = voice
        word = job.get('animal') or 'animal'
        if repaint:  # a surprise with a new description gets a new picture first, then new ideas
            job.update(inputs=None, scene=None, ideas=[], clips_done=[], chain={},
                       keep_texts={str(i): t for i, t in typed.items()})
        else:
            if replan:
                plan = new_ideas(job, word, wanted)
                drop_clips(job, 0)
            else:
                plan = job['ideas'][:wanted]
                if len(plan) < wanted or redo_set:  # new parts come from a plan for the whole video
                    fresh = new_ideas(job, word, wanted)
                    plan += fresh[len(plan):]
                    for i in redo_set:
                        plan[i] = fresh[i]
                drop_clips(job, keep)
            for i, t in typed.items():
                if i < len(plan):
                    plan[i].update(caption=t, typed=True)
            job['ideas'] = plan
        job.update(status='queued', stage='In line…', error='', retry_at=None, progress=0)
    save(job, ['song.m4a'] if new_song else [])
    enqueue(job)
    return {**public(job), 'animating': needs_animation(job)}


@app.post('/jobs/{job_id}/copy')
def copy_job(job_id: str, look: str = Form('free'), x_antics_key: str = Header(None)):
    """(Together) The same animals and scene in another look, as a new video right away: "Make the VS screen now ·
    free" while the AI one waits for free time. look: 'free' | 'turns' | 'ai'."""
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    if job.get('kind') != 'together' or not together:
        raise HTTPException(400, 'Only Together videos can be made in another look')
    made = together.copy(THIS, job, who, look)
    enqueue(made)
    return {'jobs': [public(made)], 'me': me_view(who)}


@app.post('/jobs/{job_id}/finish')
def finish_job(job_id: str, x_antics_key: str = Header(None)):
    """From a preview (or a video that came out short) to the full video: animates only what is missing."""
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    if job.get('kind') == 'sing' and sing:  # (Sing) a preview -> every shot; an approved test -> the meme part
        return public(sing.finish(THIS, job, who))
    with jobs_lock:
        if job['status'] == 'working':
            raise HTTPException(409, 'Still working on this one. Finish it when it is ready.')
        if job['status'] == 'failed' and not job.get('thumb'):
            raise HTTPException(409, "This one didn't work. Tap Try again.")
        if not job.get('draft') and job['status'] == 'done' and (job.get('made') or 0) >= job['wanted']:
            return public(job)
        job.update(draft=False, status='queued', stage='In line…', error='', retry_at=None, progress=0)
    save(job)
    enqueue(job)
    return public(job)


@app.get('/jobs/{job_id}/video')
def job_video(job_id: str, key: str = Query(None), cut: str = Query(None), x_antics_key: str = Header(None),
              part: int = Query(None), sofar: str = Query(None), test: str = Query(None)):
    """The video. cut=tiktok: its TikTok cut, for the owner's posting plan (the video without its song; a video
    without a song is its own TikTok cut). 404 while that isn't ready for the video as it is now.
    (Sing) part=n: that TikTok part (cut=tiktok&part=n: its no-song cut); sofar=1: Watch so far (the shots sung
    from the start, with the song); test=L1: that engine's test clip (Compare)."""
    who = caller(x_antics_key, key)
    job = own_job(who, job_id)
    if job.get('kind') == 'sing' and sing and (part is not None or sofar or test):  # (Sing)
        if cut == 'tiktok' and who is not OWNER:  # (the posting plan is the owner's)
            raise HTTPException(403, 'Only the owner can do that')
        return sing_video(job, part, sofar, test, cut)
    if not job.get('thumb'):  # the newest finished version (an edit swaps it in when it is ready)
        raise HTTPException(409, 'Not ready yet')
    if cut == 'tiktok' and who is not OWNER:  # (the posting plan is the owner's)
        raise HTTPException(403, 'Only the owner can do that')
    if cut == 'tiktok' and has_song(job):
        if not cut_ready(job):
            raise HTTPException(404, 'The TikTok version is not ready yet')
        try:
            path = local_file(job, 'tiktok.mp4')
        except Exception as e:  # (gone from the dataset: it is cut again)
            log.warning('%s: the TikTok cut is missing (%s)', job_id, e)
            job['tiktok_rev'] = None
            want_cut(job)
            raise HTTPException(404, 'The TikTok version is not ready yet')
        return FileResponse(path, media_type='video/mp4', filename=f'antics-{job_id}-tiktok.mp4')
    return FileResponse(local_file(job, 'final.mp4'), media_type='video/mp4', filename=f'antics-{job_id}.mp4')


def sing_video(job, part, sofar, test, cut):
    """(Sing) A part, its no-song cut, Watch so far, or a test clip."""
    if sofar:  # (its own lock: it is watched while the video is still being sung)
        path = sing.sofar(job)
        if not path:
            raise HTTPException(409, 'Nothing sung yet')
        return FileResponse(path, media_type='video/mp4', filename=f"antics-{job['id']}-so-far.mp4")
    if test:
        if test not in sing.ENGINES:
            raise HTTPException(404, 'No such test clip')
        try:
            path = local_file(job, f'test_{test}.mp4')
        except Exception:
            raise HTTPException(404, 'No such test clip')
        if not path.exists():
            raise HTTPException(404, 'No such test clip')
        return FileResponse(path, media_type='video/mp4', filename=f"antics-{job['id']}-test-{test}.mp4")
    post = next((p for p in job.get('posts') or [] if p.get('n') == part), None)
    if not post or not post.get('ready'):  # (a part is ready as soon as its shots are sung)
        raise HTTPException(404, 'That part is not ready yet')
    name = post.get('cut') if cut == 'tiktok' else post.get('file')
    if not name:
        raise HTTPException(404, 'That part is not ready yet')
    return FileResponse(local_file(job, name), media_type='video/mp4', filename=f"antics-{job['id']}-part{part}.mp4")


@app.get('/jobs/{job_id}/picture')
def job_picture(job_id: str, name: str = Query('close'), key: str = Query(None), x_antics_key: str = Header(None)):
    """(Sing) A stage picture (close, medium, wide, closeA, closeB, two) for the picture check, or a singer's own
    picture (singer0, singer1)."""
    job = own_job(caller(x_antics_key, key), job_id)
    if job.get('kind') != 'sing':
        raise HTTPException(404, 'No such picture')
    m = re.fullmatch(r'singer([01])', name or '')
    if m and int(m[1]) < len(job.get('singers') or []):
        file = job['singers'][int(m[1])].get('pic')
    else:
        file = (job.get('angles') or {}).get(name)
    if not file:
        raise HTTPException(404, 'No such picture yet')
    return FileResponse(local_file(job, file), media_type='image/jpeg')


@app.post('/jobs/{job_id}/test')
def sing_test_answer(job_id: str, answer: str = Form(None), verdict: str = Form(None),
                     next_: str = Form(None, alias='next'), x_antics_key: str = Header(None)):
    """(Sing) The 5-second test's answer (answer, or verdict): 'good' (Yes, use this one), 'bad' (No, try another
    engine: the same picture and seconds go to the next engine, or the one next names; next=false only marks it),
    'pc' (Try my PC tonight). Returns {'job', 'gpu'}."""
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    if not sing or job.get('kind') != 'sing':
        raise HTTPException(400, "That isn't a singing test")
    nxt = (next_ or '').strip()
    go = nxt.lower() not in ('false', '0', 'no')
    done = sing.verdict(THIS, job, who, answer or verdict, go_next=go, next_engine=nxt if nxt in sing.ENGINES else None)
    return {'job': public(done), 'gpu': sing.gpu_view()}


@app.post('/jobs/{job_id}/shots/{k}/redo')
def sing_redo(job_id: str, k: int, x_antics_key: str = Header(None)):
    """(Sing) ↻ one shot: sung again with a new seed (a friend's redo counts)."""
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    if not sing or job.get('kind') != 'sing':
        raise HTTPException(400, 'Only Sing videos have shots')
    if not any(s['k'] == k and s['kind'] != 'cutaway' for s in job.get('shots') or []):
        raise HTTPException(404, 'No such shot')
    return sing.redo_shot(THIS, job, who, k)


@app.get('/jobs/{job_id}/thumb')
def job_thumb(job_id: str, key: str = Query(None), pc: str = Query(None), x_antics_key: str = Header(None)):
    job = own_job(caller(x_antics_key, key), job_id)
    name = 'thumb.jpg' if job.get('thumb') else (job.get('inputs') or [None])[0]
    if pc is not None and job.get('picture_check') and job.get('inputs'):
        # (Together) the new picture while it is being checked, when the page's card asks for it (&pc=): the plan
        # and the Post screen keep the video's own picture, the version they share
        name = job['inputs'][0]
    if not name:
        raise HTTPException(404, 'No picture yet')
    return FileResponse(local_file(job, name), media_type='image/jpeg')


@app.post('/jobs/{job_id}/retry')
def retry_job(job_id: str, x_antics_key: str = Header(None)):
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    if job['status'] in ('failed', 'waiting'):
        if who is not OWNER and job.get('refunded'):  # its use was given back when it failed
            with guests_lock:
                if who['uses_left'] <= 0:
                    raise HTTPException(403, f'No videos left. Ask {host_of(who)} for more.')
                who['uses_left'] -= 1
                who['used'] += 1
                job['refunded'] = False
            save_guests()
        update(job, status='queued', stage='In line…', error='', retry_at=None)
        enqueue(job)
    return public(job)


@app.delete('/jobs/{job_id}')
def delete_job(job_id: str, x_antics_key: str = Header(None)):
    job = own_job(caller(x_antics_key), job_id)
    if job['status'] == 'working':
        raise HTTPException(409, 'This one is being made right now. Delete it when it is done.')
    with jobs_lock:
        jobs.pop(job_id, None)
    refund(job)  # a friend's video deleted before it was made
    with plan_lock:  # (and out of the posting plan)
        left = [item for item in plan_state.get('queue') or [] if item['job'] != job_id]
        dropped = len(left) < len(plan_state.get('queue') or [])
        if dropped:
            plan_state['queue'] = left
    if dropped:
        save_plan()
    shutil.rmtree(DATA / 'jobs' / job_id, ignore_errors=True)
    if hub:
        try:
            hub.delete_folder(f'jobs/{job_id}', repo_id=DATASET, repo_type='dataset')
        except Exception as e:
            log.warning('could not delete %s from the Hub: %s', job_id, e)
    return {'ok': True}


# ---------- Speaking instead of typing ----------
# Chrome, Edge and Safari turn speech into text themselves. Other browsers record and send it here:
# Whisper (base) on this free CPU writes it down in about 2 s for 10 s of speech.

whisper_model = None
whisper_lock = threading.Lock()


def whisper():
    global whisper_model
    if whisper_model is None:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise HTTPException(503, "This worker can't listen yet. Update it in Settings.")
        whisper_model = WhisperModel('base', device='cpu', compute_type='int8', cpu_threads=2)
    return whisper_model


@app.post('/listen')
def listen(audio: UploadFile = File(...), x_antics_key: str = Header(None)):
    caller(x_antics_key)
    folder = DATA / 'listen'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / secrets.token_hex(6)
    try:
        with open(path, 'wb') as f:
            shutil.copyfileobj(audio.file, f)
        if path.stat().st_size > 20 * 1024 * 1024:
            raise HTTPException(413, 'That recording is too long. Keep it under a minute.')
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-t', '60', '-ac', '1', '-ar', '16000',
                              '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    except subprocess.CalledProcessError:
        raise HTTPException(400, "That recording couldn't be read. Try again.")
    finally:
        path.unlink(missing_ok=True)
    samples = np.frombuffer(raw, dtype=np.float32)
    if len(samples) < 16000 * 0.3:
        return {'text': ''}
    with whisper_lock:  # one at a time: the CPU also makes the videos
        # No vocabulary prompt: tried with the song and style names, it misheard more than it helped.
        # The page matches song names loosely instead ("cool cats" -> Kool Kats).
        segments, info = whisper().transcribe(samples, beam_size=1, vad_filter=True,
                                              condition_on_previous_text=False)
        text = re.sub(r'\s+', ' ', ' '.join(s.text for s in segments)).strip()
    return {'text': text[:300], 'language': info.language}


# ---------- Friends ----------
# A friend gets an invite key with a number of videos. They see and edit only their own videos,
# which use this worker's free time like the owner's.

def guest_view(guest):
    return {k: guest.get(k) for k in ('id', 'name', 'key', 'uses_left', 'used', 'created')}


@app.get('/guests')
def list_guests(x_antics_key: str = Header(None)):
    check(x_antics_key)
    need_read('guests.json', 'Your friends list is')
    with guests_lock:
        return {'guests': sorted((guest_view(g) for g in guests.values()), key=lambda g: g['created'])}


@app.post('/guests')
def add_guest(name: str = Form(''), uses: int = Form(5), host: str = Form(''), x_antics_key: str = Header(None)):
    check(x_antics_key)
    need_read('guests.json', 'Your friends list is')
    guest = {'id': secrets.token_hex(4), 'name': clean_name(name) or 'Friend', 'key': secrets.token_hex(16),
             'uses_left': max(1, min(100, uses)), 'used': 0, 'created': time.time(), 'host': clean_name(host)}
    with guests_lock:
        guests[guest['id']] = guest
    save_guests()
    return guest_view(guest)


@app.post('/guests/{guest_id}')
def change_guest(guest_id: str, add: int = Form(0), x_antics_key: str = Header(None)):
    check(x_antics_key)
    need_read('guests.json', 'Your friends list is')
    with guests_lock:
        guest = guests.get(guest_id)
        if not guest:
            raise HTTPException(404, 'No such friend')
        guest['uses_left'] = max(0, min(1000, guest['uses_left'] + add))
    save_guests()
    return guest_view(guest)


@app.delete('/guests/{guest_id}')
def remove_guest(guest_id: str, x_antics_key: str = Header(None)):
    check(x_antics_key)
    need_read('guests.json', 'Your friends list is')
    with guests_lock:
        guests.pop(guest_id, None)
    save_guests()
    with push_lock:  # their phones get no more notifications
        dropped = push['subs'].pop(guest_id, None)
    if dropped is not None:
        save_push()
    return {'ok': True}


# ---------- My songs ----------
# The owner adds full songs (any audio or video file, up to SONG_MB). Each is kept as m4a and cut to its meme part,
# found by chorus.py (on a beat, adjustable), and every video with music 'mysong' starts it right there. Friends see
# and use them too (they are the account's own sound), but only the owner adds, changes or deletes them.

def song_view(song):
    return {k: song.get(k) for k in ('id', 'name', 'start', 'seconds_hint', 'default', 'added', 'candidates',
                                     'duration')}


def chosen_song(song_id):
    """The saved song to use: the one asked for while it is there, else the default one ('' when none)."""
    with songs_lock:
        if song_id and song_id in songs:
            return song_id
        return next((k for k, v in songs.items() if v.get('default')), '')


def clean_song_name(text):
    return re.sub(r'\s+', ' ', plain_text(text or '')).strip()[:60]


def upload_name(upload):
    """An uploaded song's name, from its file name ('' when that says nothing, like audio.mp3 or IMG_1234)."""
    name = clean_song_name(Path(getattr(upload, 'filename', '') or '').stem.replace('_', ' '))
    plain = re.sub(r'[\W\d_]+', ' ', name).strip().lower()
    return '' if plain in ('', 'song', 'audio', 'sound', 'music', 'track', 'file', 'blob', 'recording', 'voice',
                           'new recording', 'img', 'vid', 'video', 'rec', 'untitled') else name


def audio_seconds(path):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                             capture_output=True, text=True, check=True).stdout
        return round(float(out.strip()), 2)
    except (subprocess.CalledProcessError, ValueError):
        return None


def words_model():
    """Whisper (the model /listen uses), for the meme-part finder to hear the words with; None when it's missing."""
    try:
        return whisper()
    except Exception as e:
        log.info('the meme-part finder works without words here: %s', getattr(e, 'detail', e))
        return None


def meme_part(path):
    """Where a song's meme part starts (chorus.find), or its liveliest part when the finder can't say."""
    if chorus:
        try:
            return chorus.find(path, words_model(), whisper_lock)
        except Exception as e:  # (it doesn't raise for a readable song; this is in case)
            log.warning('the meme-part finder failed: %s', e)
    info = beats.analyse(path)
    start = round(beats.pick_start(info, 15, 'drop'), 2) if info else 0.0
    return {'start': start, 'seconds': 15.0, 'candidates': [{'start': start, 'why': 'loudest part'}], 'how': 'loudest'}


@app.get('/songs')
def list_songs(x_antics_key: str = Header(None)):
    caller(x_antics_key)  # the owner and friends
    need_read('songs.json', 'Your songs are')
    with songs_lock:
        items = sorted(songs.values(), key=lambda v: v.get('added') or 0)
        return {'songs': [song_view(v) for v in items], 'max': MAX_SONGS}


@app.post('/songs')
def add_song(file: UploadFile = File(...), name: str = Form(''), x_antics_key: str = Header(None)):
    """Adds a song: kept as m4a, its meme part found (about 10 s). Returns it."""
    check(x_antics_key)
    need_read('songs.json', 'Your songs are')
    with songs_lock:
        if len(songs) >= MAX_SONGS:
            raise HTTPException(409, f'You can keep {MAX_SONGS} songs. Delete one to add another.')
    folder = DATA / 'songs'
    folder.mkdir(parents=True, exist_ok=True)
    song_id = secrets.token_hex(4)
    original, path = folder / f'{song_id}.original', folder / f'{song_id}.m4a'
    try:
        size = 0
        with open(original, 'wb') as f:
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > SONG_MB * 1024 * 1024:
                    raise HTTPException(413, f'That file is over {SONG_MB} MB. Try a shorter one, or an MP3.')
                f.write(chunk)
        if not extract_sound(original, path):
            raise HTTPException(400, "That file has no sound we can use. Try an MP3, an M4A or a video with sound.")
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        original.unlink(missing_ok=True)
    found = meme_part(path)
    known = sing.known_song(audio_seconds(path)) if sing else None  # (Sing) a song antics knows: its meme part
    if known:  # (first, before the finder's other picks)
        others = [c for c in found.get('candidates') or [] if abs(float(c.get('start') or 0) - known['meme']) > 1.0]
        found = dict(found, start=known['meme'], how='known song',
                     candidates=[{'start': known['meme'], 'why': 'chorus'}] + others)
    title = (clean_song_name(name) or clean_song_name(Path(file.filename or '').stem.replace('_', ' '))
             or (known or {}).get('name') or 'My song')
    song = {'id': song_id, 'name': title, 'start': float(found['start']), 'seconds_hint': found.get('seconds') or 15.0,
            'default': False, 'added': time.time(), 'candidates': found.get('candidates') or [],
            'duration': audio_seconds(path)}
    with songs_lock:
        if len(songs) >= MAX_SONGS:  # (two added at the same time)
            path.unlink(missing_ok=True)
            raise HTTPException(409, f'You can keep {MAX_SONGS} songs. Delete one to add another.')
        song['default'] = not any(v.get('default') for v in songs.values())  # the first song is for every video
        songs[song_id] = song
        view = song_view(song)
    save_songs(added=[song_id])
    log.info('song %s "%s": meme part at %.2f s (%s)', song_id, title, song['start'], found.get('how', ''))
    if sing and sing.ready():  # (Sing) its singing pack (voice, music, lines) is made in the background now
        sing.queue_prepare(song_id)
    return view


@app.post('/songs/{song_id}')
def change_song(song_id: str, name: str = Form(None), start: float = Form(None), default: bool = Form(None),
                x_antics_key: str = Header(None)):
    """Rename a song, move its meme part (start, put on the nearest beat) or make it the default (the one every
    new video gets; default=false: none)."""
    check(x_antics_key)
    need_read('songs.json', 'Your songs are')
    with songs_lock:
        if song_id not in songs:
            raise HTTPException(404, 'No such song')
        known = songs[song_id].get('duration')
    if start is not None:
        try:
            path = song_file(song_id)
            info = beats.analyse(path)
        except Exception:
            raise HTTPException(404, "That song's file is missing. Delete it and add it again.")
        end = info['duration'] if info else (known or 0)
        start = max(0.0, min(float(start), max(0.0, end - 1)))
        start = round(beats.nearest_beat(info, start, within=1.0), 2)  # on the beat
    with songs_lock:
        song = songs.get(song_id)
        if not song:
            raise HTTPException(404, 'No such song')
        if name is not None and clean_song_name(name):
            song['name'] = clean_song_name(name)
        if start is not None:
            song['start'] = start
        if default:
            for other in songs.values():
                other['default'] = other is song
        elif default is False:
            song['default'] = False
        view = song_view(song)
    save_songs()
    return view


@app.delete('/songs/{song_id}')
def delete_song(song_id: str, x_antics_key: str = Header(None)):
    """Videos that had this song keep their sound; when one is changed later, it gets the meme song instead."""
    check(x_antics_key)
    need_read('songs.json', 'Your songs are')
    with songs_lock:
        song = songs.pop(song_id, None)
    if not song:
        raise HTTPException(404, 'No such song')
    (DATA / 'songs' / f'{song_id}.m4a').unlink(missing_ok=True)
    save_songs(removed=[song_id])
    if sing:  # (Sing) its singing pack goes too
        sing.delete_pack(song_id)
    return {'ok': True}


@app.get('/songs/{song_id}/audio')
def song_audio(song_id: str, key: str = Query(None), x_antics_key: str = Header(None)):
    """The song itself, to hear its meme part (the owner and friends)."""
    caller(x_antics_key, key)
    need_read('songs.json', 'Your songs are')
    with songs_lock:
        if song_id not in songs:
            raise HTTPException(404, 'No such song')
    try:
        path = song_file(song_id)
    except Exception:
        raise HTTPException(404, "That song's file is missing")
    return FileResponse(path, media_type='audio/mp4')


@app.get('/songs/{song_id}/sing')
def song_sing(song_id: str, singers: int = Query(1), x_antics_key: str = Header(None)):
    """(Sing) A song made ready to sing: its state ('queued' / 'preparing' / 'ready' / 'failed'), the split,
    duration, bpm, the lines (times and kinds only, never words), the parts and the time line of each part
    (online / your PC / both). Asks for the pack when it isn't made."""
    caller(x_antics_key)
    need_read('songs.json', 'Your songs are')
    if not sing:
        raise HTTPException(503, "This worker can't make Sing videos yet. Update it in Settings.")
    return sing.song_view(song_id, singers)


@app.get('/songs/{song_id}/voice')
def song_voice(song_id: str, v: str = Query('original'), at: float = Query(None), animal: str = Query('cat'),
               key: str = Query(None), x_antics_key: str = Header(None)):
    """(Sing) 4 s of the song's singer in that voice (original, animal, cat, bear, dog, small, bird), over the music."""
    caller(x_antics_key, key)
    need_read('songs.json', 'Your songs are')
    if not sing:
        raise HTTPException(503, "This worker can't make Sing videos yet. Update it in Settings.")
    with songs_lock:
        if song_id not in songs:
            raise HTTPException(404, 'No such song')
    return FileResponse(sing.voice_sample(song_id, v, at, clean_animal(animal) or 'cat'), media_type='audio/mp4')


@app.get('/gpu')
def gpu_view(x_antics_key: str = Header(None)):
    """(Sing) The free GPU time today (from the GPU guard), Sing's share of it, and each singing engine's state
    (friends too: it holds no secrets)."""
    caller(x_antics_key)
    if not sing:
        raise HTTPException(503, "This worker can't make Sing videos yet. Update it in Settings.")
    return sing.gpu_view()


@app.post('/settings')
def change_settings(body: Any = Body(None), x_antics_key: str = Header(None)):
    """(Sing) sing_share (seconds, or 25/50/75/100 % of the day), sing_engines {id: {state}}, sing_mix,
    sing_pc_until."""
    check(x_antics_key)
    if not sing:
        raise HTTPException(503, "This worker can't make Sing videos yet. Update it in Settings.")
    need_read(sing.SETTINGS_FILE, 'Your singing settings are')
    return sing.change_settings(plan_body(body))


@app.get('/sing/test')
def sing_test_cost(engine: str = Query(None), x_antics_key: str = Header(None)):
    """(Sing) What the next 5-second test costs, before anything is spent."""
    check(x_antics_key)
    if not sing:
        raise HTTPException(503, "This worker can't make Sing videos yet. Update it in Settings.")
    return sing.test_cost(engine)


@app.get('/sing/space')
def sing_space(x_antics_key: str = Header(None)):
    """(Sing) The owner's own singing Space (v14.1, not in this version)."""
    check(x_antics_key)
    return {'state': 'none', 'available': False, 'version': '14.1'}


@app.post('/sing/space/setup')
def sing_space_setup(x_antics_key: str = Header(None)):
    check(x_antics_key)
    raise HTTPException(501, 'Your own singing GPU comes in a later version.')


# ---------- Notifications ----------
# The owner and each friend turn them on for their own phones (at most MAX_PHONES each) and get them for
# their own videos only.

def can_push():
    if not webpush:
        raise HTTPException(503, "This worker can't send notifications yet. Update it in Settings.")
    need_read('push.json', 'Notifications are')


@app.get('/push/key')
def push_key(x_antics_key: str = Header(None)):
    """The key the page subscribes the phone with (the public half of the worker's push key)."""
    caller(x_antics_key)
    can_push()
    return {'key': webpush.public_key(vapid())}


def clean_phone(body):
    """The parts of a browser's PushSubscription the worker keeps, or 400 when it doesn't look right."""
    try:
        phone = {'endpoint': str(body['endpoint']),
                 'keys': {'p256dh': str(body['keys']['p256dh']), 'auth': str(body['keys']['auth'])}}
        ok = len(phone['endpoint']) <= 1024 and push_ok(phone['endpoint'])
        if ok:
            webpush.check_keys(phone['keys']['p256dh'], phone['keys']['auth'])
    except (KeyError, TypeError, ValueError):
        ok = False
    if not ok:
        raise HTTPException(400, "This browser's notification address doesn't look right")
    return phone


@app.post('/push/subscribe')
def push_subscribe(body: dict = Body(...), x_antics_key: str = Header(None)):
    who = caller(x_antics_key)
    can_push()
    phone = clean_phone(body)
    with push_lock:
        subs = push['subs']
        kept = [(whose, p['keys']) for whose, mine in subs.items() for p in mine or []
                if p['endpoint'] == phone['endpoint']]
        known = kept == [(who['id'], phone['keys'])]  # the page checks in with every visit: then nothing changes
        if not known:
            # A browser has one subscription, used by one person here at a time: it moves to whoever set it up last.
            for whose in list(subs):
                subs[whose] = [p for p in subs[whose] or [] if p['endpoint'] != phone['endpoint']]
            subs[who['id']] = ((subs.get(who['id']) or []) + [dict(phone, added=time.time())])[-MAX_PHONES:]
        phones = len(subs.get(who['id']) or [])
    if not known:  # (saved with the videos only when something changed)
        save_push()
    return {'ok': True, 'phones': phones}


@app.post('/push/unsubscribe')
def push_unsubscribe(body: dict = Body(...), x_antics_key: str = Header(None)):
    who = caller(x_antics_key)
    need_read('push.json', 'Notifications are')
    endpoint = str(body.get('endpoint', ''))
    with push_lock:
        mine = push['subs'].get(who['id']) or []
        left = [p for p in mine if p['endpoint'] != endpoint]
        if len(left) < len(mine):
            push['subs'][who['id']] = left
    if len(left) < len(mine):
        save_push()
    return {'ok': True}


@app.post('/push/test')
def push_test(x_antics_key: str = Header(None)):
    who = caller(x_antics_key)
    can_push()
    sent = ping(who['id'], {'title': 'Notifications are on', 'body': "You'll get one like this when a video is ready.",
                            'tag': 'antics-test', 'url': 'index.html'}, wait=True)
    return {'sent': sent}


# ---------- The Posting plan ----------
# The owner's only (friends get 403): a queue of finished videos, 1-3 times a day in the owner's time zone, a
# notification at each time, and the caption with its hashtags ready. The owner posts by hand, with Share to
# TikTok on the page (TikTok's posting API isn't open to personal tools). posting.py has the rules.

def plan_owner(header_key):
    check(header_key)
    if not posting:
        raise HTTPException(503, "This worker can't plan posts yet. Update it in Settings.")
    need_read('posting.json', 'Your posting plan is')


def plan_body(body):
    if not isinstance(body, dict):
        raise HTTPException(400, 'Send a JSON object')
    return body


def short_label(job):
    """A video's name in the plan, its reminder and its history: the name of the version the plan shares (final.mp4,
    as finish_video kept it in made_with), also while an edit is under way (another scene, new names) and the job's
    own label already names the next one. Videos made before kept none: their label as it is now."""
    made = job.get('made_with') or {}
    label = ((made.get('label') if job.get('thumb') else None) or job.get('label')
             or ('Surprise' if job.get('kind') == 'surprise' else 'Your video'))
    label = re.sub(r'\s+', ' ', str(label)).strip()
    return label if len(label) <= 60 else label[:59].rstrip() + '…'


def first_caption(job):
    return next((i['caption'] for i in job.get('ideas') or [] if i.get('caption')), '')


def plan_song(item, job):
    """The song to add in TikTok when the video is posted without its own (the TikTok cut), and where it starts in
    this video; None when there is none to add."""
    if item['audio'] != 'no_song':
        return None
    used = job.get('music_used')
    if used == 'mysong':
        with songs_lock:
            song = dict(songs.get(job.get('song_id') or '') or {})
        start = job.get('music_start') if job.get('music_start') is not None else song.get('start')
        if item.get('part') and sing:  # (Sing) that part's own start in the song
            start = sing.part_start(job, item['part'], start)
        return {'name': song.get('name') or job.get('song_name') or 'your song', 'start': round(float(start or 0), 2)}
    if used == 'upload':  # ('your song': the page says "the same song" then)
        return {'name': job.get('upload_name') or 'your song', 'start': round(float(job.get('music_start') or 0), 2)}
    return None


def plan_caption(item, job, state):
    """(the caption, whether it is the owner's own, its hashtags). Automatic: the video's first caption, the
    hashtags for this post and, for a Kevin MacLeod song left in the video, its CC BY credit (an own caption
    gets that credit too). A Together video also credits each free library clip in it (on its own line, also in
    the TikTok cut: the clips are still in it), gets each of its animals' own tags, and #aivideo only when AI made
    any of it. All of it about the version the plan shares (final.mp4): while an edit is under way (a new picture,
    another scene or look, new words) the job's own fields already describe the next one, so its text, the song's
    credit, the clips' credits and whether AI made it come from what finish_video kept (made_with)."""
    made = job.get('made_with') or {}  # (videos from before version 13 kept none of it: as they are now)
    music = made['credit'] if 'credit' in made else (
        ideas.MUSIC_CREDIT.format(track=job['track']) if job.get('music_used') == 'funny' and job.get('track') else '')
    credit = music if item['audio'] == 'as_made' else ''
    animals, ai = None, True
    if job.get('kind') == 'together' and together:
        credit = together.caption_credit(job, credit, made.get('clips'))
        animals, ai = [c.get('animal') for c in job.get('cast') or []], together.shared_uses_ai(job)
    if item.get('caption'):  # (the owner's own words; each credit line is added when they left it out)
        text = item['caption']
        for line in credit.split('\n') if credit else []:
            text = posting.with_credit(text, line)
        return text, True, posting.tags_in(item['caption'])
    tags = posting.pick_tags(state['plan'], job, state['posted_count'], animals=animals, ai=ai)
    text = made['text'] if 'text' in made else first_caption(job)
    if item.get('part') and sing:  # (Sing) "... · Part 2/4"
        text = sing.part_caption(job, item['part'], text)
    return posting.compose(text, tags, credit), False, tags


def plan_view():
    """GET /plan: the settings, the queue in order (each with its caption, hashtags, the song to add, whether its
    TikTok cut is ready, or couldn't be made this time, and the time it is planned for), the last ones done (newest
    first), the next times, the times missed while the worker slept, and whether reminders can reach the owner's
    phone."""
    t = posting.now()
    with plan_lock:
        state = copy.deepcopy(plan_state)
    plan = state['plan']
    rows = [(item, jobs.get(item['job'])) for item in state['queue']]
    rows = [(item, job) for item, job in rows if job]  # (a video deleted meanwhile)
    times = posting.upcoming(state, t, max(plan['per_day'], len(rows)))
    planned, queue_view, last = iter(times), [], None
    for item, job in rows:
        caption, own, tags = plan_caption(item, job, state)
        at = None
        if plan['on']:
            at = next(planned, None) if item['status'] == 'waiting' else item['reminded_at']
            last = at if item['status'] == 'waiting' and at is not None else last
        ready = item['audio'] == 'as_made' or cut_ready(job)
        label = short_label(job)
        if item.get('part') and sing:  # (Sing) one part of a long sung video: its own cut, made with the parts
            ready = item['audio'] == 'as_made' or sing.part_ready(job, item['part'])
            label = sing.part_label(job, item['part'], label)
        queue_view.append(dict(item, label=label, thumb=f"/jobs/{job['id']}/thumb", caption=caption,
                               custom=own, tags=tags, song=plan_song(item, job), cut_ready=ready, at=at,
                               cut_rev=job.get('tiktok_rev'),
                               cut_failed=not ready and cut_failed.get(job['id']) == job.get('rev')))
    history = [{k: h.get(k) for k in ('id', 'job', 'label', 'status', 'done_at')} for h in state['history'][-20:]]
    with push_lock:
        notify = bool(webpush) and bool(push['subs'].get(OWNER['id']))
    return {'plan': plan, 'queue': queue_view, 'history': history[::-1], 'next': times, 'lasts_until': last,
            'missed': [m for m in state['missed'] if m['at'] >= t - posting.MISSED_SECONDS],
            'notify': notify, 'tz_ok': posting.tz_ok(plan['tz'])}


def plan_item(pid):
    item = posting.find(plan_state, pid)
    if not item:
        raise HTTPException(404, "That video isn't in your posting plan any more")
    return item


def postable(job):
    """Why a video can't go in the plan ('' when it can)."""
    if job.get('test'):  # (Sing)
        return "That's the singing test. Make the real video, then add it."
    if job.get('draft'):
        return "That's a preview. Tap Finish first, then add the whole video."
    if job.get('picture_check'):  # (Together: its new picture is being checked, the video isn't made yet)
        return "Check its picture first. Add the video when it's made."
    if job.get('status') != 'done':
        return "That video isn't finished yet. Add it when it's ready."
    if not job.get('thumb'):
        return "That video has no finished version yet."
    return ''


@app.get('/plan')
def get_plan(x_antics_key: str = Header(None)):
    plan_owner(x_antics_key)
    return plan_view()


@app.post('/plan')
def set_plan(body: Any = Body(None), x_antics_key: str = Header(None)):
    """Change the settings (any of on, per_day, times, tz, tags, fixed, per_post). Turning it on or moving its
    times counts every time before now as done, so nothing old reminds."""
    plan_owner(x_antics_key)
    with plan_lock:
        try:
            new, moved = posting.settings(plan_state['plan'], plan_body(body))
        except ValueError as e:
            raise HTTPException(400, str(e))
        plan_state['plan'] = new
        if moved:
            posting.mark_past(plan_state, posting.now())
    save_plan()
    return plan_view()


@app.post('/plan/queue')
def plan_add(body: Any = Body(None), x_antics_key: str = Header(None)):
    """Put finished videos in the plan, at the end (or the start). One made with the owner's own song is posted
    without it: its TikTok cut is made now, in the background."""
    plan_owner(x_antics_key)
    body = plan_body(body)
    ids, where = body.get('jobs'), body.get('where', 'end')
    if (not isinstance(ids, list) or not ids or len(ids) > posting.MAX_QUEUE or not all(isinstance(i, str) for i in ids)
            or where not in ('end', 'start')):
        raise HTTPException(400, "Send jobs: [the videos' ids] and where: 'end' or 'start'")
    ids = list(dict.fromkeys(ids))
    t = posting.now()
    with plan_lock:
        queued = {item['job'] for item in plan_state['queue']}
        parts_in = {(item['job'], item.get('part')) for item in plan_state['queue']}  # (Sing: a series' parts)
        items = []
        for job_id in ids:
            job = jobs.get(job_id)
            if not job:
                raise HTTPException(404, 'No such video')
            parts = sing.plan_parts(job) if sing and job.get('kind') == 'sing' else []  # (Sing) Part 1/N ... N/N
            if parts:
                parts = [n for n in parts if (job_id, n) not in parts_in]
            why = postable(job) or ('That video is already in your posting plan.' if job_id in queued and not parts
                                    else '')
            if why:
                raise HTTPException(409, why)
            audio = 'no_song' if job.get('music') in ('mysong', 'upload') else 'as_made'
            by = (job.get('owner_name') or 'A friend') if job.get('owner', 'me') != OWNER['id'] else None
            for n in parts or [None]:
                item = posting.new_item(job_id, audio, by, t)
                if n is not None:
                    item['part'] = n
                items.append(item)
        if len(plan_state['queue']) + len(items) > posting.MAX_QUEUE:
            raise HTTPException(409, f'Your posting plan holds {posting.MAX_QUEUE} videos. Post or remove some first.')
        plan_state['queue'] = items + plan_state['queue'] if where == 'start' else plan_state['queue'] + items
    save_plan()
    for item in items:
        want_cut(jobs.get(item['job']), retry=True)
    return plan_view()


@app.post('/plan/queue/order')
def plan_order(body: Any = Body(None), x_antics_key: str = Header(None)):
    """The queue in a new order: ids must be exactly the videos in it now (those GET /plan shows: one whose video
    is missing for now keeps its place)."""
    plan_owner(x_antics_key)
    with plan_lock:
        hidden = {item['id'] for item in plan_state['queue'] if item['job'] not in jobs}  # (not on the page)
        try:
            posting.reorder(plan_state, plan_body(body).get('ids'), hidden)
        except ValueError as e:
            raise HTTPException(400, str(e))
    save_plan()
    return plan_view()


@app.post('/plan/queue/{pid}')
def plan_change(pid: str, body: Any = Body(None), x_antics_key: str = Header(None)):
    """A video's caption (the owner's own; null: automatic again) and its sound ('no_song': the TikTok cut, for
    TikTok's own sound; 'as_made': the video as it was made, with its song)."""
    plan_owner(x_antics_key)
    body = plan_body(body)
    if 'caption' in body and body['caption'] is not None and not isinstance(body['caption'], str):
        raise HTTPException(400, 'caption must be text, or null for the automatic one')
    if 'audio' in body and body['audio'] not in posting.AUDIO:
        raise HTTPException(400, "audio must be 'no_song' or 'as_made'")
    with plan_lock:
        item = plan_item(pid)
        if 'caption' in body:  # ('' or only spaces: automatic again too)
            item['caption'] = posting.custom(body['caption'] or '') or None
        switched = 'audio' in body and body['audio'] != item['audio']
        if 'audio' in body:
            item['audio'] = body['audio']
        job_id = item['job']
    save_plan()
    if switched and body['audio'] == 'no_song':  # (a caption change doesn't start a cut that failed over)
        want_cut(jobs.get(job_id), retry=True)
    return plan_view()


@app.delete('/plan/queue/{pid}')
def plan_remove(pid: str, x_antics_key: str = Header(None)):
    """Out of the plan (not counted as posted or skipped)."""
    plan_owner(x_antics_key)
    with plan_lock:
        item = plan_item(pid)
        plan_state['queue'].remove(item)
    save_plan()
    left_plan(item['job'])
    return plan_view()


@app.post('/plan/queue/{pid}/done')
def plan_done(pid: str, body: Any = Body(None), x_antics_key: str = Header(None)):
    """'posted' (the hashtags move on one step) or 'skipped': it goes to the history."""
    plan_owner(x_antics_key)
    result = plan_body(body).get('result')
    if result not in ('posted', 'skipped'):
        raise HTTPException(400, "result must be 'posted' or 'skipped'")
    with plan_lock:
        job_id = plan_item(pid)['job']
        job = jobs.get(job_id)
        posting.finish(plan_state, pid, result, short_label(job) if job else 'A video', posting.now())
    save_plan()
    left_plan(job_id)
    return plan_view()


# ---------- PC helper API ----------

def pc_seen(name=''):
    was_on = pc_online()
    pc['seen'] = time.time()
    if name:
        pc['name'] = name[:80]
    if not was_on:
        wake_waiting(now_anyway=True)


def pc_task(task_id):
    task = pc_tasks.get(task_id)
    if not task:
        raise HTTPException(404, 'That clip is no longer needed')
    return task


@app.post('/pc/pair-code')
def pc_pair_code(x_antics_key: str = Header(None)):
    """A 6-digit code the phone shows, so the PC helper can connect without typing the long key."""
    check(x_antics_key)
    pairing.update(code=f'{secrets.randbelow(10 ** 6):06d}', until=time.time() + 600, misses=0)
    return {'code': pairing['code'], 'minutes': 10}


@app.post('/pc/pair')
def pc_pair(code: str = Form(...)):
    if not pairing['code'] or time.time() > pairing['until'] or pairing['misses'] >= 8:
        raise HTTPException(403, 'That code has expired. Get a new one in the antics app: Settings, Use my PC, Get connect code.')
    if not secrets.compare_digest(code.strip(), pairing['code']):
        pairing['misses'] += 1
        raise HTTPException(403, 'Wrong code. Check the 6 digits in the antics app.')
    pairing.update(code='', until=0.0)
    return {'key': ANTICS_KEY}


@app.post('/pc/hello')
def pc_hello(name: str = Form(''), starting: bool = Form(False), x_antics_key: str = Header(None),
             can: str = Form(None), vram: str = Form(None), ram_gb: str = Form(None), torch: str = Form(None),
             driver: str = Form(None), until: str = Form(None), utc_offset: str = Form(None),
             session: str = Form(None)):
    check(x_antics_key)
    if session:  # (Sing: helper v14) this run of the helper: a long poll an earlier run left open takes nothing
        with pc_cond:
            pc['session'] = str(session)[:40]
    extra = {}
    if sing and can is not None:  # (Sing) what the helper can do (can=sing: it takes sing tasks), its GPU and RAM
        pc_seen(name)
        extra = sing.pc_hello({'can': can, 'vram': vram, 'ram_gb': ram_gb, 'torch': torch, 'driver': driver,
                               'until': until, 'utc_offset': utc_offset}) or {}
    elif starting:
        pc['can'] = []  # (a helper that doesn't say what it can: an older one, which never gets sing tasks)
    pc_seen(name)
    if starting:  # a restarted helper won't finish what it was making before
        with pc_cond:
            for task in pc_tasks.values():
                if task['status'] == 'claimed':
                    task['status'] = 'waiting'
            pc_cond.notify_all()
        wake_waiting(now_anyway=True)
    return {'ok': True, **extra}  # (Sing: sing_until, the owner's stop time for the PC)


@app.get('/pc/next')
def pc_next(wait: float = Query(25), x_antics_key: str = Header(None), session: str = Query(None)):
    """Long poll: the next clip for the PC to make, or nothing after `wait` seconds. session (helper v14): a poll
    from an earlier run of the helper (closed while its poll was open) gets nothing."""
    check(x_antics_key)
    pc_seen()
    deadline = time.time() + max(0.0, min(wait, 50.0))
    with pc_cond:
        while True:
            if session and pc.get('session') and str(session)[:40] != pc['session']:  # (Sing: helper v14)
                return {'task': None}
            task = next((t for t in pc_tasks.values() if t['status'] == 'waiting'
                         and (not sing or sing.pc_offer(t))), None)  # (Sing: sing tasks only to can=sing helpers)
            if task:
                task['status'] = 'claimed'
                break
            left = deadline - time.time()
            if left <= 0:
                return {'task': None}
            pc_cond.wait(left)
    pc_seen()
    if task.get('kind') == 'sing' and sing:  # (Sing)
        return {'task': sing.pc_task_view(task)}
    return {'task': {'id': task['id'], 'prompt': task['prompt'], 'seconds': task['seconds']}}


@app.get('/pc/tasks/{task_id}/image')
def pc_task_image(task_id: str, x_antics_key: str = Header(None)):
    check(x_antics_key)
    picture = pc_task(task_id)['picture']
    return FileResponse(picture, media_type='image/png' if picture.endswith('.png') else 'image/jpeg')


@app.get('/pc/tasks/{task_id}/audio')
def pc_task_audio(task_id: str, n: int = Query(0), x_antics_key: str = Header(None)):
    """(Sing) A sing task's vocal track n (16 kHz mono wav: that singer's lines of the original vocal)."""
    check(x_antics_key)
    task = pc_task(task_id)
    files = task.get('audio') or []
    if not 0 <= n < len(files):
        raise HTTPException(404, 'No such track')
    return FileResponse(files[n], media_type='audio/wav')


@app.get('/pc/tasks/{task_id}/mask')
def pc_task_mask(task_id: str, n: int = Query(0), x_antics_key: str = Header(None)):
    """(Sing) A duet task's mask n (which half of the picture each singer is in)."""
    check(x_antics_key)
    task = pc_task(task_id)
    files = task.get('masks') or []
    if not 0 <= n < len(files):
        raise HTTPException(404, 'No such mask')
    return FileResponse(files[n], media_type='image/png')


@app.post('/pc/tasks/{task_id}/part')
def pc_task_part(task_id: str, n: int = Query(...), video: UploadFile = File(...), motion: UploadFile = File(None),
                 x_antics_key: str = Header(None)):
    """(Sing) One finished chunk of a sing task (and its last frames), kept so a restarted helper goes on from there."""
    check(x_antics_key)
    pc_seen()
    task = pc_task(task_id)
    if task.get('kind') != 'sing' or not sing:
        raise HTTPException(400, 'Only sing tasks come in parts')
    return sing.pc_part(task, n, video, motion)


@app.get('/pc/tasks/{task_id}/part')
def pc_task_part_get(task_id: str, n: int = Query(...), x_antics_key: str = Header(None)):
    """(Sing) A chunk's last frames back (the helper restarted: it carries on from chunk n + 1)."""
    check(x_antics_key)
    task = pc_task(task_id)
    got = (task.get('parts') or {}).get(str(n)) or {}
    if not got.get('motion'):
        raise HTTPException(404, 'No such part')
    return FileResponse(got['motion'], media_type='image/png')


@app.get('/pc/tasks/{task_id}/part_video')
def pc_task_part_video(task_id: str, n: int = Query(...), x_antics_key: str = Header(None)):
    """(Sing) A chunk's video back (the helper lost its own copy: it takes the worker's instead of making it again)."""
    check(x_antics_key)
    task = pc_task(task_id)
    got = (task.get('parts') or {}).get(str(n)) or {}
    if not got.get('video'):
        raise HTTPException(404, 'No such part')
    return FileResponse(got['video'], media_type='video/webm')


@app.post('/pc/tasks/{task_id}/progress')
def pc_task_progress(task_id: str, chunk_s: float = Form(None), peak_vram: str = Form(None),
                     peak_ram: str = Form(None), size: str = Form(None), x_antics_key: str = Header(None)):
    """(Sing) The helper's measurements: seconds per chunk, peak VRAM and RAM (the time line uses the median)."""
    check(x_antics_key)
    pc_seen()
    pc_task(task_id)
    if not sing:
        raise HTTPException(400, 'Only sing tasks report progress')
    return sing.pc_progress({'chunk_s': chunk_s, 'peak_vram': peak_vram, 'peak_ram': peak_ram, 'size': size})


@app.post('/pc/tasks/{task_id}/done')
def pc_task_done(task_id: str, video: UploadFile = File(...), x_antics_key: str = Header(None)):
    check(x_antics_key)
    pc_seen()
    task = pc_task(task_id)
    out = Path(task['out'])
    with open(out, 'wb') as f:
        shutil.copyfileobj(video.file, f)
    try:
        probe(out)
    except Exception:
        out.unlink(missing_ok=True)
        task.update(status='failed', error='The PC sent a video that could not be read')
        task['done'].set()
        raise HTTPException(400, 'That video could not be read')
    task['status'] = 'done'
    task['done'].set()
    return {'ok': True}


@app.post('/pc/tasks/{task_id}/failed')
def pc_task_failed(task_id: str, error: str = Form(''), x_antics_key: str = Header(None)):
    check(x_antics_key)
    pc_seen()
    task = pc_task(task_id)
    task.update(status='failed', error=error[:300])
    task['done'].set()
    return {'ok': True}
