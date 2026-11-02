# worker.py: the Animal Antics background worker. Runs as a free Hugging Face Docker Space.
#
# A job is a link, 1-3 pictures, or "surprise me". The worker gets the video, picks the best
# moments, asks a free Wan 2.2 Space to make each moment act like a human, and joins the clips
# into one 9:16 video for TikTok. Jobs and finished videos are kept in a private HF dataset, so
# nothing is lost when the Space restarts, and jobs that hit the daily free limit finish by
# themselves once it resets.
#
# A quick preview animates only the first clip (the rest show as still pictures). Every made clip
# is kept, so edits to text, music or speed just re-cut the video in seconds, and Finish animates
# only what is missing. Friends get their own invite key with a number of videos to make.
# For browsers that can't turn speech into text themselves, the worker writes it down (Whisper).

import json
import logging
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

import numpy as np
import requests
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from PIL import Image, ImageDraw, ImageFont

import beats
import ideas

VERSION = '8'
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
MUSIC_MODES = ('funny', 'track', 'upload', 'mine', 'none')

# Free Wan image-to-video Spaces, tried in order. They all spend the same daily free GPU time.
ENGINES = [
    {'id': 'zerogpu-aoti/wan2-2-fp8da-aoti-faster', 'name': 'Wan 2.2', 'max_sec': 5, 'extra': {'steps': 6}},
    {'id': 'r3gm/wan2-2-fp8da-aoti-preview', 'name': 'Wan 2.2 backup', 'max_sec': 5,
     'extra': {'steps': 6, 'last_image': None}},
    {'id': 'multimodalart/wan2-1-fast', 'name': 'Wan 2.1 backup', 'max_sec': 3.4, 'extra': {'steps': 4}, 'sized': True},
]
IMAGE_SPACE = 'black-forest-labs/FLUX.1-schnell'

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('antics')


class QuotaError(Exception):
    """The daily free GPU time is used up."""

    def __init__(self, message):
        super().__init__(message)
        wait = re.search(r'try again in (\d+):(\d+):(\d+)', message, re.I)
        self.wait_seconds = (int(wait[1]) * 3600 + int(wait[2]) * 60 + int(wait[3])) if wait else 3600


class BusyError(Exception):
    """Every free GPU is taken right now; worth trying again in a few minutes."""

    wait_seconds = 600


def is_quota(msg):
    return bool(re.search(r'quota|runs limit|gpu limit|exceeded your', msg, re.I))


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
            'batch']
    view = {k: job.get(k) for k in keys}
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


guests = {}  # friend id -> {id, name, key, uses_left, used, created, host}
guests_lock = threading.Lock()
guests_saving = threading.Lock()


def save_guests():
    """Friends and their remaining videos, kept with the videos so they survive restarts."""
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


def load_jobs():
    """Bring back jobs after a restart and put unfinished ones back in line."""
    global hub, token_ok
    if DATASET and HF_TOKEN:
        from huggingface_hub import HfApi, hf_hub_download
        try:
            api = HfApi(token=HF_TOKEN)
            api.create_repo(DATASET, repo_type='dataset', private=True, exist_ok=True)
            names = api.list_repo_files(DATASET, repo_type='dataset')
            hub = api
        except Exception as e:
            # Keep running so the app can tell the user to paste a new key, instead of crashing.
            log.error('the Hugging Face key does not work (%s); saved videos are unavailable', e)
            token_ok, names = False, []
        for name in names:
            if name == 'guests.json':
                try:
                    guests.update(json.loads(Path(hf_hub_download(DATASET, name, repo_type='dataset',
                                                                  token=HF_TOKEN)).read_text()))
                except Exception as e:
                    log.warning('could not load friends: %s', e)
            if name.endswith('/job.json'):
                try:
                    job = json.loads(Path(hf_hub_download(DATASET, name, repo_type='dataset', token=HF_TOKEN)).read_text())
                    jobs[job['id']] = job
                except Exception as e:
                    log.warning('could not load %s: %s', name, e)
    else:
        for path in (DATA / 'jobs').glob('*/job.json'):
            job = json.loads(path.read_text())
            jobs[job['id']] = job
        if (DATA / 'guests.json').exists():
            guests.update(json.loads((DATA / 'guests.json').read_text()))
    for job in sorted(jobs.values(), key=lambda j: (j['created'], j.get('index', 0))):  # oldest first
        if job['status'] in ('queued', 'working'):
            job['status'] = 'queued'
            enqueue(job)
    log.info('loaded %d jobs and %d friends', len(jobs), len(guests))


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
             '-c:a', 'aac', '-b:a', '160k', str(out)])
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


def pick_frames(sampled, count, folder, variant=0):
    """The sharpest moment in each part of the video, one per clip. Extra videos made from the same
    link (variant 1, 2, ...) take the next-sharpest moments, so each one starts differently."""
    duration, scored = sampled
    names = []
    for part in range(count):
        lo, hi = duration * part / count, duration * (part + 1) / count
        in_part = sorted([s for s in scored if lo <= s[0] <= hi] or scored, key=lambda s: -s[1])
        name = f'input_{part}.jpg'
        shutil.copy(in_part[variant % len(in_part)][2], folder / name)
        names.append(name)
    return names


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
    try:
        client = Client(IMAGE_SPACE, token=HF_TOKEN, verbose=False)
        out = client.predict(prompt=prompt, seed=seed, randomize_seed=False, width=576, height=1024,
                             num_inference_steps=4, api_name='/infer')
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
    (each tried in turn; stops early on quota or key problems)."""
    if pc_online() and pc_make_clip(picture, prompt, seconds, out):
        return 'your PC'
    from gradio_client import Client, handle_file
    last, busy = None, False
    for engine in ENGINES:
        try:
            client = Client(engine['id'], token=HF_TOKEN, verbose=False)
            args = {'input_image': handle_file(str(picture)), 'prompt': prompt,
                    'duration_seconds': min(seconds, engine['max_sec']), 'randomize_seed': True, **engine['extra']}
            if engine.get('sized'):
                args.update(wan21_size(picture))
            result = client.submit(api_name='/generate_video', **args).result(timeout=900)
            video = result[0]
            path = video.get('video') if isinstance(video, dict) else video
            shutil.copy(path, out)
            return engine['name']
        except Exception as e:
            msg = str(e) or type(e).__name__
            if is_quota(msg):
                raise QuotaError(msg)
            if is_auth(msg):
                raise RuntimeError('The Hugging Face key was refused. Set up the worker again with a new key.')
            busy = busy or is_busy(msg)
            log.warning('%s failed: %s', engine['id'], msg)
            last = msg
    if busy:
        raise BusyError(last)
    raise RuntimeError(f'The free video engines are offline right now ({last})')


# ---------- Step 3: join clips into one TikTok video ----------

# Text on the video uses a plain font, so emoji and other symbols would show as empty boxes.
TEXT_OK = set('’‘“”…–—•')


def plain_text(text):
    return ''.join(ch for ch in text if ord(ch) < 0x2000 or ch in TEXT_OK)


def caption_png(text, path, tag=''):
    """White text with a black outline near the top, like a TikTok caption. tag: a small label lower
    down (previews use it on clips that are still pictures)."""
    img = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if tag:
        small = ImageFont.truetype(FONT, 26)
        width = draw.textlength(tag, font=small)
        left, top = (OUT_W - width) / 2 - 22, OUT_H * 0.8
        draw.rounded_rectangle((left, top, left + width + 44, top + 50), radius=25, fill=(22, 19, 16, 215))
        draw.text((OUT_W / 2, top + 25), tag, font=small, fill='white', anchor='mm')
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


def make_still(picture, seconds, out):
    """A slow zoom into a still picture: stands in for a clip a preview hasn't animated yet."""
    w, h = Image.open(picture).size
    scale = min(1.0, 720 / max(w, h))
    w, h = max(2, int(w * scale) // 2 * 2), max(2, int(h * scale) // 2 * 2)
    frames = max(1, int(seconds * FPS))
    zoom = (f"scale={w * 2}:{h * 2},zoompan=z='1+0.06*on/{frames}':d={frames}:x='iw/2-(iw/zoom/2)':"
            f"y='ih/2-(ih/zoom/2)':s={w}x{h}:fps={FPS},format=yuv420p")
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(picture), '-vf', zoom, '-frames:v', str(frames),
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', str(out)])


def join_clips(clips, captions, out, lengths, speed=1.0, audio=None, audio_start=0.0, badge=None):
    """Each clip fills a 720x1280 frame (cropped if close to vertical, else on a blurred copy), plays at
    `speed` and is cut to lengths[i] seconds. audio is laid under the whole video from audio_start
    (looped, faded out), else silence. badge (the creator's name tag) sits on the left, clear of
    TikTok's buttons and caption."""
    cmd = ['ffmpeg', '-v', 'error', '-y']
    parts = []
    n = len(clips)
    for clip in clips:
        cmd += ['-i', str(clip)]
    for cap in captions:
        cmd += ['-i', str(cap)]
    if audio:
        cmd += ['-stream_loop', '-1', '-ss', f'{audio_start:.3f}', '-i', str(audio)]
    else:
        cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']
    if badge:
        cmd += ['-i', str(badge)]
    total = sum(lengths)
    for i, clip in enumerate(clips):
        w, h, _ = probe(clip)
        ratio = (w / h) / (OUT_W / OUT_H)
        if 0.85 < ratio < 1.18:
            parts.append(f'[{i}:v]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},setsar=1[b{i}]')
        else:
            parts.append(f'[{i}:v]split[s{i}][f{i}];'
                         f'[s{i}]scale=72:128:force_original_aspect_ratio=increase,crop=72:128,boxblur=6,'
                         f'scale={OUT_W}:{OUT_H},eq=brightness=-0.08[bg{i}];'
                         f'[f{i}]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease[fg{i}];'
                         f'[bg{i}][fg{i}]overlay=(W-w)/2:(H-h)/2,setsar=1[b{i}]')
        parts.append(f'[b{i}][{n + i}:v]overlay=0:0,setpts=PTS/{speed},trim=duration={lengths[i]:.3f},'
                     f'setpts=PTS-STARTPTS,fps={FPS},format=yuv420p[v{i}]')
    parts.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[joined]')
    if badge:
        parts.append(f'[joined][{2 * n + 1}:v]overlay=24:{int(OUT_H * 0.62)}[out]')
    else:
        parts.append('[joined]null[out]')
    parts.append(f'[{2 * n}:a]aresample=44100,afade=t=in:d=0.1,afade=t=out:st={max(0.0, total - 0.8):.2f}:d=0.8[aout]')
    cmd += ['-filter_complex', ';'.join(parts), '-map', '[out]', '-map', '[aout]', '-t', f'{total:.2f}',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out)]
    run(cmd)


# ---------- The pipeline ----------

def get_link(job, folder):
    """Downloads the link and picks its best moments, also for the other videos made from it at the
    same time (each gets different moments), so the link is fetched only once."""
    wanted = job['wanted']
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
        inputs = pick_frames(sampled, wanted, folder)
        picks = [pick_frames(sampled, o['wanted'], job_dir(o['id']), variant=k + 1) for k, o in enumerate(others)]
        if job.get('music') == 'mine' and extract_sound(source, folder / 'sound.m4a'):
            sound = folder / 'sound.m4a'
        source.unlink(missing_ok=True)
    except Exception as e:
        # Still blocked (YouTube especially): the pictures the site shows publicly still work.
        log.warning('%s: download failed (%s), trying the public pictures', job['id'], e)
        inputs, label, text = link_pictures(job, folder, wanted)
        if not inputs:
            raise
        picks = []
        for o in others:
            for name in inputs:
                shutil.copy(folder / name, job_dir(o['id']) / name)
            picks.append(list(inputs))
    guessed = said_animal(job) or ideas.guess_animal(text)  # the user's own words first, then the video's title
    update(job, label=job.get('label') or label, animal=job.get('animal') or guessed, inputs=inputs,
           has_sound=bool(sound))
    batch = [(job, inputs + (['sound.m4a'] if sound else []))]
    for other, names in zip(others, picks):
        if other['id'] not in jobs:  # deleted meanwhile
            continue
        if sound:
            shutil.copy(sound, job_dir(other['id']) / 'sound.m4a')
        update(other, label=other.get('label') or label, animal=other.get('animal') or guessed, inputs=names,
               has_sound=bool(sound))
        batch.append((other, names + (['sound.m4a'] if sound else [])))
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
        have = have[:wanted] + new_ideas(job, animal, wanted - len(have))
        for i, text in (job.get('keep_texts') or {}).items():  # the user's own words from an edit
            if int(i) < len(have):
                have[int(i)].update(caption=text, typed=True)
        update(job, ideas=have, keep_texts=None)
    if not job.get('track'):
        update(job, track=ideas.pick_music(job.get('template') or 'random'))
    if not job.get('sound'):
        update(job, sound=random.choice(ideas.SOUND_IDEAS))

    # A preview animates only the first clip; the others show as still pictures until Finish.
    # Made clips are kept (also on the Hub), so edits that keep an animation just re-cut the video.
    limit = 1 if job.get('draft') else wanted
    if job.get('clips_done') is None:  # jobs from before clips were kept
        job['clips_done'] = [f'clip_{i}.mp4' for i in range(wanted) if (folder / f'clip_{i}.mp4').exists()]
    parts, failed = [], None  # parts: (clip number, video file, animated?)
    for i, idea in enumerate(job['ideas'][:limit]):
        name = f'clip_{i}.mp4'
        out = folder / name
        if name in job['clips_done']:
            try:
                parts.append((i, local_file(job, name), True))
                continue
            except Exception:  # gone (e.g. an old job after a restart): animate it again
                job['clips_done'].remove(name)
        if failed:  # the engines just failed: don't wait on them again for the next clip
            continue
        where, each = ('Your PC is animating', '3–5 min each') if pc_online() else ('Animating', '1–2 min each')
        what = 'the preview clip' if job.get('draft') else f'clip {i + 1} of {wanted}'
        update(job, stage=f'{where} {what}… ({each})', progress=0.15 + 0.7 * i / limit)
        picture = local_file(job, job['inputs'][i % len(job['inputs'])])
        try:
            make_clip(picture, ideas.video_prompt(idea, animal), job['seconds'], out)
        except Exception as e:
            log.exception('%s: clip %d failed', job['id'], i + 1)
            failed = e
            continue
        parts.append((i, out, True))
        job['clips_done'].append(name)
        update(job, made=sum(1 for p in parts if p[2]))
        save(job, [name])
    if not parts:
        raise failed or RuntimeError('No clips could be made')
    made = len(parts)
    if job.get('draft'):
        for i in range(limit, wanted):
            out = folder / f'still_{i}.mp4'
            make_still(local_file(job, job['inputs'][i % len(job['inputs'])]), job['seconds'], out)
            parts.append((i, out, False))

    update(job, stage='Putting your video together…', progress=0.9)
    clips, captions = [], []
    for n, (i, clip, animated) in enumerate(parts):
        path = folder / f'caption_{n}.png'
        caption_png(job['ideas'][i]['caption'] if job.get('captions', True) else '', path,
                    tag='' if animated else 'PREVIEW · moves when you tap Finish')
        clips.append(clip)
        captions.append(path)
    speed = SPEEDS.get(job.get('speed'), 1.0)
    lengths = [probe(c)[2] / speed for c in clips]
    music, audio, credit, used, natural = job.get('music', 'funny'), None, '', 'none', 'start'
    if music == 'mine' and job.get('has_sound'):
        audio, used = local_file(job, 'sound.m4a'), 'mine'
    elif music == 'upload' and job.get('has_song'):
        audio, used, natural = local_file(job, 'song.m4a'), 'upload', 'drop'
    elif music != 'none':  # a meme track (chosen or matched to the style), or a missing sound/song
        try:
            audio, used = music_file(job['track']), 'funny'
            credit = ideas.MUSIC_CREDIT.format(track=job['track'])
        except requests.RequestException as e:
            log.warning('%s: no music this time (%s)', job['id'], e)
    start = 0.0
    if audio:
        part = job.get('song_part') if job.get('song_part') in ('start', 'drop', 'custom') else natural
        try:
            info = beats.analyse(audio)
            if part == 'custom':  # the user's own start time, nudged onto the nearest beat
                start = beats.nearest_beat(info, max(0.0, float(job.get('song_start') or 0)))
            else:
                start = beats.pick_start(info, sum(lengths), part)
            lengths = beats.snap_cuts(info, start, lengths)  # cuts land on the beat
        except Exception as e:  # the beat finder must never cost a video
            log.warning('%s: beat finder skipped (%s)', job['id'], e)
    badge = local_file(job, 'badge.png') if job.get('has_badge') and job.get('brand', True) else None
    # Written next to the old version and swapped in, so the old one plays until the new one is ready.
    join_clips(clips, captions, folder / 'final.new.mp4', lengths, speed, audio, start, badge)
    os.replace(folder / 'final.new.mp4', folder / 'final.mp4')
    run(['ffmpeg', '-v', 'error', '-y', '-ss', '1', '-i', str(folder / 'final.mp4'), '-frames:v', '1',
         '-vf', 'scale=360:-2', str(folder / 'thumb.new.jpg')])
    os.replace(folder / 'thumb.new.jpg', folder / 'thumb.jpg')
    caption = f"{job['ideas'][0]['caption']} {ideas.HASHTAGS}" + (f'\n{credit}' if credit else '')
    _, _, seconds_long = probe(folder / 'final.mp4')
    if job.get('draft'):
        note = ('Preview: the first clip moves, the rest are still pictures. Edit it, or tap Finish.'
                if wanted > 1 else 'Preview ready. Edit it, or tap Finish when you like it.')
    elif made < wanted:
        note = f'Made {made} of {wanted} clips (the free engines were busy or out of time). Tap Make the rest later.'
    else:
        note = ''
    update(job, status='done', stage=note, progress=1, error='', thumb='thumb.jpg', made=made, caption=caption,
           music_used=used, music_start=round(start, 2), seconds_long=round(seconds_long, 1),
           rev=(job.get('rev') or 0) + 1)
    save(job, ['final.mp4', 'thumb.jpg'])


def said_animal(job):
    """The animal named in the user's description, if any."""
    animal = ideas.guess_animal(job.get('idea') or '')
    return '' if animal == 'animal' else animal


def new_ideas(job, animal, count):
    """Fresh ideas for `count` more clips, from the user's description or the chosen style."""
    if count <= 0:
        return []
    template = job.get('template') or 'random'
    if job.get('idea'):
        style = job['scene']['scene']['style'] if job.get('scene') else None
        return ideas.custom_ideas(job['idea'], animal, count, template, style)
    if job.get('scene'):
        return ideas.ideas_for_scene(job['scene']['scene'], animal, count, template)
    return ideas.ideas_for_picture(animal, count, template)


def refund(job):
    """A friend's video that never got made (it failed, or was deleted before any clip) gives the use back."""
    with guests_lock:
        guest = guests.get(job.get('owner', 'me'))
        if not guest or job.get('refunded') or job.get('made') or job.get('thumb'):
            return
        guest['uses_left'] += 1
        guest['used'] = max(0, guest['used'] - 1)
        job['refunded'] = True
    save_guests()


def needs_animation(job):
    """True when the job still needs the AI (a picture or a clip), not just a re-cut."""
    if not job.get('inputs') or job.get('clips_done') is None:
        return True
    limit = 1 if job.get('draft') else job['wanted']
    return any(f'clip_{i}.mp4' not in job['clips_done'] for i in range(limit))


def enqueue(job):
    (work_queue if needs_animation(job) else quick_queue).put(job['id'])


def worker_loop(lane):
    while True:
        job_id = lane.get()
        job = jobs.get(job_id)
        with jobs_lock:  # a job can sit in both lanes after edits: only one may take it
            if not job or job['status'] != 'queued':
                continue
            job['status'] = 'working'
        update(job, error='')
        try:
            process(job)
            log.info('%s done', job_id)
        except (QuotaError, BusyError) as e:
            why = ('Out of free video time for today.' if isinstance(e, QuotaError)
                   else 'The free GPUs are all busy right now.')
            update(job, status='waiting', stage=f'{why} It will finish by itself.',
                   retry_at=time.time() + e.wait_seconds + 60, progress=0)
            save(job)
        except Exception as e:
            log.exception('%s failed', job_id)
            update(job, status='failed', error=friendly(e), stage='')
            refund(job)
            save(job)


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
    """Put waiting jobs back in line once their wait is over (or right away when the PC is on)."""
    now = time.time()
    for job in list(jobs.values()):
        if job['status'] == 'waiting' and (now_anyway or (job.get('retry_at') or 0) <= now):
            update(job, status='queued', stage='In line…')
            enqueue(job)


def scheduler_loop():
    """Wake jobs that were waiting for the free GPU time to come back."""
    while True:
        time.sleep(60)
        wake_waiting()


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
    load_jobs()
    threading.Thread(target=worker_loop, args=(work_queue,), daemon=True).start()
    threading.Thread(target=worker_loop, args=(quick_queue,), daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
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


@app.get('/health')
def health():
    return {'ok': True, 'version': VERSION, 'storage': bool(hub), 'token': bool(HF_TOKEN), 'token_ok': token_ok,
            'pc': pc_online(), 'pc_name': pc['name']}


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
    images: list[UploadFile] = File(None),
    source: UploadFile = File(None),
    song: UploadFile = File(None),
    badge: UploadFile = File(None),
):
    who = caller(x_antics_key)
    url = url.strip()
    if not (images or surprise or re.match(r'^https?://\S+$', url)):
        raise HTTPException(400, 'Paste a video link, upload a video, or tap Surprise me')
    count = max(1, min(MAX_VIDEOS, count))
    if who is not OWNER:  # a friend's videos are counted, and given back if they can't be made
        with guests_lock:
            count = min(count, who['uses_left'])
            if count <= 0:
                raise HTTPException(403, f'No videos left. Ask {host_of(who)} for more.')
            who['uses_left'] -= count
            who['used'] += count
    settings = {
        'captions': captions, 'seconds': max(2, min(5, seconds)), 'animal': clean_animal(animal),
        'template': template if template in ideas.TEMPLATES else 'random',
        'music': music if music in MUSIC_MODES else 'funny',
        'track': track if music == 'track' and track in ideas.MUSIC else '',
        'song_part': song_part if song_part in ('auto', 'start', 'drop', 'custom') else 'auto',
        'song_start': max(0.0, min(3600.0, song_start)),
        'speed': speed if speed in SPEEDS else 'normal',
        'idea': clean_idea(idea), 'draft': draft, 'brand': True,
    }
    try:
        made = build_jobs(who, count, max(1, min(MAX_CLIPS, clips)), settings, url, surprise, images, source,
                          song, badge)
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


def build_jobs(who, count, wanted, settings, url, surprise, images, source, song, badge):
    """`count` new videos from the same input. Files the user sent are read once and copied to each."""
    now, group = time.time(), (secrets.token_hex(4) if count > 1 else None)
    made = [dict(settings, id=f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}", created=now, index=k,
                 batch=count, group=group, status='queued', stage='In line…', progress=0, error='', wanted=wanted,
                 made=0, clips_done=[], redos=0, owner=who['id'],
                 owner_name='' if who is OWNER else who['name'])
            for k in range(count)]
    folder = job_dir(made[0]['id'])
    shared, flags = [], {}
    if badge:  # the creator's name tag, drawn by the page
        try:
            tag = Image.open(badge.file).convert('RGBA')
            tag.thumbnail((OUT_W - 48, 200))
            tag.save(folder / 'badge.png')
            shared.append('badge.png')
            flags['has_badge'] = True
        except Exception:
            log.warning('%s: the name tag could not be read', made[0]['id'])
    if song and settings['music'] == 'upload':
        original = folder / 'song_original'
        with open(original, 'wb') as f:
            shutil.copyfileobj(song.file, f)
        if extract_sound(original, folder / 'song.m4a'):
            shared.append('song.m4a')
            flags['has_song'] = True
        original.unlink(missing_ok=True)
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
            # The page sends different moments for each video when the clip has enough; else they share.
            own = pictures[k * wanted:(k + 1) * wanted] if len(pictures) >= wanted * count else pictures[:wanted]
            names = []
            for i, img in enumerate(own):
                save_picture(img, job_dir(job['id']) / f'input_{i}.jpg')
                names.append(f'input_{i}.jpg')
            job.update(kind='images', inputs=names, label='Your video')
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
    save_many([(job, (job.get('inputs') or []) + shared) for job in made])
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
    redo: str = Form(''),
    song: UploadFile = File(None),
):
    """Change a video. Text, music, speed and length changes re-cut it in seconds. A new description,
    style or animal, or redo (clip numbers), animates the clips concerned again."""
    who = caller(x_antics_key)
    job = own_job(who, job_id)
    try:
        texts = [str(t)[:120] for t in json.loads(texts)] if texts else []
    except (ValueError, TypeError):
        raise HTTPException(400, 'Could not read the new texts')
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
        lost = done if replan else [n for n in done if clip_number(n) in redo_set]
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
        if music in MUSIC_MODES and not (music == 'mine' and not job.get('has_sound')):
            job['music'] = music
        if job['music'] == 'track' and track in ideas.MUSIC:
            job['track'] = track
        elif job['music'] == 'funny' and (old_music != 'funny' or new_template != old_template):
            job['track'] = ideas.pick_music(new_template)  # a meme song that suits the style
        if new_song:
            os.replace(new_song, folder / 'song.m4a')
            job['has_song'] = True
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
        word = job.get('animal') or 'animal'
        if repaint:  # a surprise with a new description gets a new picture first, then new ideas
            job.update(inputs=None, scene=None, ideas=[], clips_done=[],
                       keep_texts={str(i): t for i, t in typed.items()})
        else:
            if replan:
                plan = new_ideas(job, word, wanted)
                job['clips_done'] = []
            else:
                plan = job['ideas'][:wanted]
                plan += new_ideas(job, word, wanted - len(plan))
                for i in redo_set:
                    plan[i] = new_ideas(job, word, 1)[0]
                job['clips_done'] = [n for n in done if clip_number(n) < wanted and clip_number(n) not in redo_set]
            for i, t in typed.items():
                if i < len(plan):
                    plan[i].update(caption=t, typed=True)
            job['ideas'] = plan
        job.update(status='queued', stage='In line…', error='', retry_at=None, progress=0)
    save(job, ['song.m4a'] if new_song else [])
    enqueue(job)
    return {**public(job), 'animating': needs_animation(job)}


@app.post('/jobs/{job_id}/finish')
def finish_job(job_id: str, x_antics_key: str = Header(None)):
    """From a preview (or a video that came out short) to the full video: animates only what is missing."""
    job = own_job(caller(x_antics_key), job_id)
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
def job_video(job_id: str, key: str = Query(None), x_antics_key: str = Header(None)):
    job = own_job(caller(x_antics_key, key), job_id)
    if not job.get('thumb'):  # the newest finished version (an edit swaps it in when it is ready)
        raise HTTPException(409, 'Not ready yet')
    return FileResponse(local_file(job, 'final.mp4'), media_type='video/mp4', filename=f'antics-{job_id}.mp4')


@app.get('/jobs/{job_id}/thumb')
def job_thumb(job_id: str, key: str = Query(None), x_antics_key: str = Header(None)):
    job = own_job(caller(x_antics_key, key), job_id)
    name = 'thumb.jpg' if job.get('thumb') else (job.get('inputs') or [None])[0]
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
    with guests_lock:
        return {'guests': sorted((guest_view(g) for g in guests.values()), key=lambda g: g['created'])}


@app.post('/guests')
def add_guest(name: str = Form(''), uses: int = Form(5), host: str = Form(''), x_antics_key: str = Header(None)):
    check(x_antics_key)
    guest = {'id': secrets.token_hex(4), 'name': clean_name(name) or 'Friend', 'key': secrets.token_hex(16),
             'uses_left': max(1, min(100, uses)), 'used': 0, 'created': time.time(), 'host': clean_name(host)}
    with guests_lock:
        guests[guest['id']] = guest
    save_guests()
    return guest_view(guest)


@app.post('/guests/{guest_id}')
def change_guest(guest_id: str, add: int = Form(0), x_antics_key: str = Header(None)):
    check(x_antics_key)
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
    with guests_lock:
        guests.pop(guest_id, None)
    save_guests()
    return {'ok': True}


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
def pc_hello(name: str = Form(''), starting: bool = Form(False), x_antics_key: str = Header(None)):
    check(x_antics_key)
    pc_seen(name)
    if starting:  # a restarted helper won't finish what it was making before
        with pc_cond:
            for task in pc_tasks.values():
                if task['status'] == 'claimed':
                    task['status'] = 'waiting'
            pc_cond.notify_all()
        wake_waiting(now_anyway=True)
    return {'ok': True}


@app.get('/pc/next')
def pc_next(wait: float = Query(25), x_antics_key: str = Header(None)):
    """Long poll: the next clip for the PC to make, or nothing after `wait` seconds."""
    check(x_antics_key)
    pc_seen()
    deadline = time.time() + max(0.0, min(wait, 50.0))
    with pc_cond:
        while True:
            task = next((t for t in pc_tasks.values() if t['status'] == 'waiting'), None)
            if task:
                task['status'] = 'claimed'
                break
            left = deadline - time.time()
            if left <= 0:
                return {'task': None}
            pc_cond.wait(left)
    pc_seen()
    return {'task': {'id': task['id'], 'prompt': task['prompt'], 'seconds': task['seconds']}}


@app.get('/pc/tasks/{task_id}/image')
def pc_task_image(task_id: str, x_antics_key: str = Header(None)):
    check(x_antics_key)
    return FileResponse(pc_task(task_id)['picture'], media_type='image/jpeg')


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
