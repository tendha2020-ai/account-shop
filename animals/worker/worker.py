# worker.py: the Animal Antics background worker. Runs as a free Hugging Face Docker Space.
#
# A job is a link, 1-3 pictures, or "surprise me". The worker gets the video, picks the best
# moments, asks a free Wan 2.2 Space to make each moment act like a human, and joins the clips
# into one 9:16 video for TikTok. Jobs and finished videos are kept in a private HF dataset, so
# nothing is lost when the Space restarts, and jobs that hit the daily free limit finish by
# themselves once it resets.

import json
import logging
import os
import queue
import random
import re
import secrets
import shutil
import subprocess
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

import ideas

VERSION = '1'
HF_TOKEN = os.environ.get('HF_TOKEN') or None
ANTICS_KEY = os.environ.get('ANTICS_KEY', '')
DATASET = os.environ.get('ANTICS_DATASET', '')
DATA = Path(os.environ.get('ANTICS_DATA', '/tmp/antics'))
FONT = os.environ.get('ANTICS_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')

OUT_W, OUT_H, FPS = 720, 1280, 30
MAX_CLIPS = 3

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
work_queue = queue.Queue()
hub = None


def job_dir(job_id):
    path = DATA / 'jobs' / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def public(job):
    keys = ['id', 'created', 'status', 'stage', 'progress', 'error', 'label', 'kind', 'caption', 'sound',
            'made', 'wanted', 'retry_at', 'seconds_long']
    view = {k: job.get(k) for k in keys}
    view['has_video'] = job.get('status') == 'done'
    view['has_thumb'] = bool(job.get('thumb'))
    return view


def save(job, files=()):
    """Write the job locally and, when a dataset is set up, to the Hub."""
    job['updated'] = time.time()
    folder = job_dir(job['id'])
    (folder / 'job.json').write_text(json.dumps(job))
    if not hub:
        return
    try:
        from huggingface_hub import CommitOperationAdd
        ops = [CommitOperationAdd(f"jobs/{job['id']}/job.json", str(folder / 'job.json'))]
        ops += [CommitOperationAdd(f"jobs/{job['id']}/{name}", str(folder / name)) for name in files]
        hub.create_commit(DATASET, ops, commit_message=f"{job['id']}: {job['status']}", repo_type='dataset')
    except Exception as e:  # keep working even if the Hub is briefly down
        log.warning('saving %s to the Hub failed: %s', job['id'], e)


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


def load_jobs():
    """Bring back jobs after a restart and put unfinished ones back in line."""
    global hub
    if DATASET and HF_TOKEN:
        from huggingface_hub import HfApi, hf_hub_download
        hub = HfApi(token=HF_TOKEN)
        hub.create_repo(DATASET, repo_type='dataset', private=True, exist_ok=True)
        for name in hub.list_repo_files(DATASET, repo_type='dataset'):
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
    for job in jobs.values():
        if job['status'] in ('queued', 'working'):
            job['status'] = 'queued'
            work_queue.put(job['id'])
    log.info('loaded %d jobs', len(jobs))


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
    opts = {
        'outtmpl': str(folder / 'source.%(ext)s'),
        'format': 'bv*[height<=1080]/b[height<=1080]/bv*/b',
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


def pick_frames(source, count, folder):
    """The sharpest moment in each part of the video, one per clip."""
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
    picks = []
    for part in range(count):
        lo, hi = duration * part / count, duration * (part + 1) / count
        in_part = [s for s in scored if lo <= s[0] <= hi] or scored
        picks.append(max(in_part, key=lambda s: s[1])[2])
    names = []
    for i, src in enumerate(picks):
        name = f'input_{i}.jpg'
        shutil.copy(src, folder / name)
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


def make_clip(picture, prompt, seconds, out):
    """Animate one picture. Tries each free engine; stops early on quota or key problems."""
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

EMOJI = re.compile('[\U0001F000-\U0001FFFF☀-➿️‍]')


def caption_png(text, path):
    """White text with a black outline near the top, like a TikTok caption."""
    img = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
    text = EMOJI.sub('', text or '').strip()
    if text:
        draw = ImageDraw.Draw(img)
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


def join_clips(clips, captions, out):
    """Each clip fills a 720x1280 frame (cropped if close to vertical, else on a blurred copy)."""
    cmd = ['ffmpeg', '-v', 'error', '-y']
    parts = []
    n = len(clips)
    for clip in clips:
        cmd += ['-i', str(clip)]
    for cap in captions:
        cmd += ['-i', str(cap)]
    cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']
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
        parts.append(f'[b{i}][{n + i}:v]overlay=0:0,fps={FPS},format=yuv420p[v{i}]')
    parts.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[out]')
    cmd += ['-filter_complex', ';'.join(parts), '-map', '[out]', '-map', f'{2 * n}:a', '-shortest',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', str(out)]
    run(cmd)


# ---------- The pipeline ----------

def process(job):
    folder = job_dir(job['id'])
    wanted = job['wanted']

    if not job.get('inputs'):
        if job['kind'] == 'link':
            update(job, stage='Downloading the video…', progress=0.05)
            try:
                source, label, text = download_link(job, folder)
                update(job, stage='Finding the best moments…', progress=0.12)
                inputs = pick_frames(source, wanted, folder)
                source.unlink(missing_ok=True)
            except Exception as e:
                # Some sites (YouTube especially) block servers. Their public pictures still work.
                log.warning('%s: download failed (%s), trying the public pictures', job['id'], e)
                inputs, label, text = link_pictures(job, folder, wanted)
                if not inputs:
                    raise
            update(job, label=job.get('label') or label, animal=job.get('animal') or ideas.guess_animal(text))
        else:  # surprise
            update(job, stage='Painting a random scene…', progress=0.08)
            scene = ideas.random_scene()
            surprise_picture(scene['prompt'], folder / 'input_0.jpg')
            update(job, animal=scene['animal'], label=f"Surprise: {scene['subject']}"[:80], scene=scene)
            inputs = ['input_0.jpg']
        update(job, inputs=inputs)
        save(job, inputs)

    animal = job.get('animal') or 'animal'
    if not job.get('ideas'):
        if job.get('scene'):
            picked = ideas.ideas_for_scene(job['scene']['scene'], animal, wanted)
        else:
            picked = ideas.ideas_for_picture(animal, wanted)
        caption = f"{picked[0]['caption']} {ideas.HASHTAGS}"
        update(job, ideas=picked, caption=caption, sound=random.choice(ideas.SOUND_IDEAS))

    clips = []
    for i, idea in enumerate(job['ideas']):
        out = folder / f'clip_{i}.mp4'
        if out.exists():
            clips.append(out)
            continue
        update(job, stage=f'Animating clip {i + 1} of {wanted}… (1–2 min each)', progress=0.15 + 0.7 * i / wanted)
        picture = local_file(job, job['inputs'][i % len(job['inputs'])])
        try:
            make_clip(picture, ideas.video_prompt(idea, animal), job['seconds'], out)
        except Exception:
            if clips:
                log.exception('%s: clip %d failed, finishing with %d', job['id'], i + 1, len(clips))
                break  # finish now with the clips we have
            raise
        clips.append(out)
        update(job, made=len(clips))

    update(job, stage='Putting your video together…', progress=0.9)
    captions = []
    for i in range(len(clips)):
        path = folder / f'caption_{i}.png'
        caption_png(job['ideas'][i]['caption'] if job['captions'] else '', path)
        captions.append(path)
    join_clips(clips, captions, folder / 'final.mp4')
    run(['ffmpeg', '-v', 'error', '-y', '-ss', '1', '-i', str(folder / 'final.mp4'), '-frames:v', '1',
         '-vf', 'scale=360:-2', str(folder / 'thumb.jpg')])
    _, _, seconds_long = probe(folder / 'final.mp4')
    note = '' if len(clips) == wanted else f'Made {len(clips)} of {wanted} clips (the free engines were busy or out of time).'
    update(job, status='done', stage=note, progress=1, error='', thumb='thumb.jpg', made=len(clips),
           seconds_long=round(seconds_long, 1))
    save(job, ['final.mp4', 'thumb.jpg'])


def worker_loop():
    while True:
        job_id = work_queue.get()
        job = jobs.get(job_id)
        if not job or job['status'] not in ('queued',):
            continue
        update(job, status='working', error='')
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
            save(job)


def friendly(e):
    msg = str(e)
    if 'Unsupported URL' in msg or 'is not a valid URL' in msg:
        return "This link isn't supported. Try a TikTok, YouTube, Instagram, X or Facebook video link."
    if re.search(r'sign in to confirm|not a bot|login required|private video|cookies', msg, re.I):
        return 'That site blocked the download (it wants a login). Save the video to your phone and upload it instead.'
    if 'max_filesize' in msg or 'larger than max-filesize' in msg:
        return 'That video is too big. Try a shorter clip.'
    return msg[:300]


def scheduler_loop():
    """Wake jobs that were waiting for the free GPU time to come back."""
    while True:
        time.sleep(60)
        now = time.time()
        for job in list(jobs.values()):
            if job['status'] == 'waiting' and (job.get('retry_at') or 0) <= now:
                update(job, status='queued', stage='In line…')
                work_queue.put(job['id'])


# ---------- API ----------

@asynccontextmanager
async def lifespan(_app):
    DATA.mkdir(parents=True, exist_ok=True)
    load_jobs()
    threading.Thread(target=worker_loop, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])


def check(header_key, query_key=None):
    if not ANTICS_KEY or not secrets.compare_digest(header_key or query_key or '', ANTICS_KEY):
        raise HTTPException(401, 'Wrong or missing worker key')


@app.get('/', response_class=PlainTextResponse)
def home():
    return 'Animal Antics worker is running.'


@app.get('/health')
def health():
    return {'ok': True, 'version': VERSION, 'storage': bool(hub), 'token': bool(HF_TOKEN)}


@app.get('/jobs')
def list_jobs(x_antics_key: str = Header(None)):
    check(x_antics_key)
    with jobs_lock:
        items = sorted(jobs.values(), key=lambda j: j['created'], reverse=True)
        return {'jobs': [public(j) for j in items], 'version': VERSION}


@app.post('/jobs')
async def create_job(
    x_antics_key: str = Header(None),
    url: str = Form(''),
    surprise: bool = Form(False),
    clips: int = Form(3),
    captions: bool = Form(True),
    animal: str = Form(''),
    seconds: float = Form(5),
    images: list[UploadFile] = File(None),
):
    check(x_antics_key)
    wanted = max(1, min(MAX_CLIPS, clips))
    job = {
        'id': f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}",
        'created': time.time(), 'status': 'queued', 'stage': 'In line…', 'progress': 0, 'error': '',
        'wanted': wanted, 'made': 0, 'captions': captions, 'seconds': max(2, min(5, seconds)),
        'animal': re.sub(r'[^a-zA-Z ]', '', animal).strip().lower()[:30],
    }
    url = url.strip()
    if images:
        folder = job_dir(job['id'])
        names = []
        for i, upload in enumerate(images[:MAX_CLIPS]):
            try:
                img = Image.open(upload.file)
                img.load()
            except Exception:
                raise HTTPException(400, 'That picture could not be opened')
            save_picture(img, folder / f'input_{i}.jpg')
            names.append(f'input_{i}.jpg')
        job.update(kind='images', inputs=names, label='Your video')
    elif surprise:
        job.update(kind='surprise', label='Surprise me')
    elif re.match(r'^https?://\S+$', url):
        job.update(kind='link', url=url, label='')
    else:
        raise HTTPException(400, 'Paste a video link, upload a video, or tap Surprise me')
    with jobs_lock:
        jobs[job['id']] = job
    save(job, job.get('inputs', []))
    work_queue.put(job['id'])
    return public(job)


def get_job(job_id):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'No such video')
    return job


@app.get('/jobs/{job_id}/video')
def job_video(job_id: str, key: str = Query(None), x_antics_key: str = Header(None)):
    check(x_antics_key, key)
    job = get_job(job_id)
    if job['status'] != 'done':
        raise HTTPException(409, 'Not ready yet')
    return FileResponse(local_file(job, 'final.mp4'), media_type='video/mp4', filename=f'antics-{job_id}.mp4')


@app.get('/jobs/{job_id}/thumb')
def job_thumb(job_id: str, key: str = Query(None), x_antics_key: str = Header(None)):
    check(x_antics_key, key)
    job = get_job(job_id)
    name = 'thumb.jpg' if job.get('thumb') else (job.get('inputs') or [None])[0]
    if not name:
        raise HTTPException(404, 'No picture yet')
    return FileResponse(local_file(job, name), media_type='image/jpeg')


@app.post('/jobs/{job_id}/retry')
def retry_job(job_id: str, x_antics_key: str = Header(None)):
    check(x_antics_key)
    job = get_job(job_id)
    if job['status'] in ('failed', 'waiting'):
        update(job, status='queued', stage='In line…', error='', retry_at=None)
        work_queue.put(job_id)
    return public(job)


@app.delete('/jobs/{job_id}')
def delete_job(job_id: str, x_antics_key: str = Header(None)):
    check(x_antics_key)
    job = get_job(job_id)
    if job['status'] == 'working':
        raise HTTPException(409, 'This one is being made right now. Delete it when it is done.')
    with jobs_lock:
        jobs.pop(job_id, None)
    shutil.rmtree(DATA / 'jobs' / job_id, ignore_errors=True)
    if hub:
        try:
            hub.delete_folder(f'jobs/{job_id}', repo_id=DATASET, repo_type='dataset')
        except Exception as e:
            log.warning('could not delete %s from the Hub: %s', job_id, e)
    return {'ok': True}
