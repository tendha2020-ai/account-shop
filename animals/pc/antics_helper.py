# antics_helper.py: makes antics clips on this PC's graphics card, for free and without limits.
#
# It starts ComfyUI (installed next to this file by setup-pc.ps1), connects to your antics worker
# with a 6-digit code from the app, then keeps asking the worker for clips to make. It only calls
# out to the worker, so no router or firewall settings are needed. Close the window to stop.
#
# (Sing) With --sing (the desktop shortcut "antics sing tonight") it also makes Sing shots: an animal's picture
# sings a slice of a song with InfiniteTalk (ComfyUI's own WanInfiniteTalkToVideo node on Wan 2.1 image-to-video
# 14B 480p). It only sings while it runs with --sing, stops at the stop time after the part it is making, and
# waits while a game holds the graphics card's memory. Each finished part (about 3 seconds of video) goes to the
# worker at once and also stays on this PC, so a stop or a restart costs at most one part.
#
#   antics_helper.py                       normal clips only (as before)
#   antics_helper.py --sing --until 07:30  normal clips and singing, until 07:30 (the stop time set in the app
#                                          wins when the worker sends one)
#   antics_helper.py --check               is this PC ready to sing? (graphics card, driver, memory, model files)
#   antics_helper.py --pair                connect to your worker, then stop

import argparse
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path

HELPER_VERSION = '14'
HERE = Path(os.environ.get('ANTICS_HOME') or Path(__file__).resolve().parent)  # (ANTICS_HOME: tests)
CONFIG = HERE / 'antics_helper.json'
COMFY_DIR = HERE / 'ComfyUI'
COMFY = os.environ.get('ANTICS_COMFY_URL') or 'http://127.0.0.1:8188'
SPACE_NAME = 'antics-worker'

# The Wan 2.2 14B image-to-video model, squeezed to fit an 8 GB card, plus the 4-step Lightning LoRAs.
MODELS = {
    'high': 'Wan2.2-I2V-A14B-HighNoise-Q3_K_M.gguf',
    'low': 'Wan2.2-I2V-A14B-LowNoise-Q3_K_M.gguf',
    'high_lora': 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
    'low_lora': 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors',
    'text': 'umt5-xxl-encoder-Q4_K_M.gguf',
    'vae': 'wan_2.1_vae.safetensors',
}
# Wan's standard negative prompt (it was trained with Chinese ones).
NEGATIVE = ('色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, '
            'JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, '
            '手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走')


def say(text):
    print(time.strftime('%H:%M:%S'), text, flush=True)


# ---------- HTTP (standard library only) ----------

def request(method, url, data=None, headers=None, timeout=60):
    """Returns (status, body). Status 0 means the server could not be reached."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return 0, b''


def form_data(fields, files=()):
    """A multipart/form-data body. files: (field, filename, bytes, content_type)."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for field, filename, data, ctype in files:
        head = (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
                f'Content-Type: {ctype}\r\n\r\n').encode()
        parts.append(head + data + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def as_json(body):
    try:
        return json.loads(body)
    except ValueError:
        return None


class WorkerAsleep(Exception):
    """The Hugging Face worker is starting up or unreachable for a moment."""


class TaskGone(Exception):
    """(Sing) The worker no longer needs this task (it gave up on it, or it restarted)."""


class Worker:
    def __init__(self, url, key):
        self.url = url.rstrip('/')
        self.key = key
        # (Sing) new for every run of the helper: a worker that checks it hands no task to a /pc/next long poll
        # left open by an earlier run (closed or crashed less than 25 s ago), which would never make it
        self.session = uuid.uuid4().hex[:12]

    def call(self, method, path, fields=None, files=(), timeout=60, binary=False):
        headers = {'X-Antics-Key': self.key}
        data = None
        if fields is not None or files:
            data, headers['Content-Type'] = form_data(fields or {}, files)
        status, body = request(method, self.url + path, data, headers, timeout)
        if status == 401:
            CONFIG.unlink(missing_ok=True)
            raise SystemExit('Your worker no longer knows this PC (it was set up again). '
                             'Start the helper again to reconnect.')
        if status in (0, 502, 503, 504):
            raise WorkerAsleep()
        if status == 200 and not binary and not path.endswith('/image') and as_json(body) is None:
            raise WorkerAsleep()  # a sleeping Space answers with a web page instead
        return status, body

    def hello(self, name, starting=False, extra=None):
        """Says the PC is on. extra (Sing): can, vram, ram_gb, torch, driver, until. Returns the worker's answer."""
        fields = {'name': name, 'starting': 'true' if starting else 'false', 'session': self.session}
        fields.update(extra or {})
        status, body = self.call('POST', '/pc/hello', fields)
        return (as_json(body) or {}) if status == 200 else {}

    def next_task(self):
        status, body = self.call('GET', f'/pc/next?wait=25&session={self.session}', timeout=60)
        if status != 200:
            time.sleep(10)
            return None
        return (as_json(body) or {}).get('task')

    def image(self, task_id):
        status, body = self.call('GET', f'/pc/tasks/{task_id}/image')
        if status != 200:
            raise RuntimeError('The worker no longer needs this clip')
        return body

    def done(self, task_id, video, filename, ctype='video/webm'):
        status, _ = self.call('POST', f'/pc/tasks/{task_id}/done', files=[('video', filename, video, ctype)],
                              timeout=300)
        return status

    def failed(self, task_id, error):
        self.call('POST', f'/pc/tasks/{task_id}/failed', {'error': error[:300]})

    # (Sing) the files of a sing task, its parts, its measurements

    def task_file(self, task_id, what, n=None):
        """A sing task's picture ('image'), vocal track ('audio', n) or mask ('mask', n)."""
        path = f'/pc/tasks/{task_id}/{what}' + ('' if n is None else f'?n={int(n)}')
        status, body = self.call('GET', path, timeout=120, binary=True)
        if status == 404:
            raise TaskGone()
        if status != 200 or not body:
            raise RuntimeError(f'The worker did not send the {what} ({status})')
        return body

    def send_part(self, task_id, n, video, motion):
        """One finished part and its last frames. Returns the worker's parts_done list."""
        status, body = self.call('POST', f'/pc/tasks/{task_id}/part?n={int(n)}', timeout=300, files=[
            ('video', f'part_{n:03d}.webm', video, 'video/webm'), ('motion', f'motion_{n:03d}.png', motion, 'image/png')])
        if status == 404:
            raise TaskGone()
        if status != 200:
            raise RuntimeError(f'The worker did not take part {n + 1} ({status})')
        return (as_json(body) or {}).get('parts_done') or []

    def get_part(self, task_id, n, video=False):
        """A part the worker kept: its last frames (PNG), or with video=True its video. None when it has none."""
        path = f'/pc/tasks/{task_id}/part_video?n={int(n)}' if video else f'/pc/tasks/{task_id}/part?n={int(n)}'
        status, body = self.call('GET', path, timeout=300, binary=True)
        return body if status == 200 and body else None

    def progress(self, task_id, fields):
        try:
            self.call('POST', f'/pc/tasks/{task_id}/progress', {k: v for k, v in fields.items() if v not in (None, '')})
        except WorkerAsleep:
            pass


# ---------- Connecting to the worker ----------

def find_worker(username):
    status, body = request('GET', f'https://huggingface.co/api/spaces/{urllib.parse.quote(username)}/{SPACE_NAME}/runtime')
    runtime = as_json(body) if status == 200 else None
    if not runtime:
        return None
    for domain in runtime.get('domains') or []:
        return 'https://' + domain['domain']
    return f"https://{username.lower().replace('_', '-').replace('.', '-')}-{SPACE_NAME}.hf.space"


def pair():
    print()
    print('Connect this PC to your antics worker')
    print('-------------------------------------')
    print('In the antics app on your phone: Settings > Use my PC > Get connect code.')
    print()
    while True:
        username = input('Your Hugging Face username: ').strip()
        url = find_worker(username) if username else None
        if url:
            break
        print('No antics worker found for that username. Check the spelling (it is shown in the app).')
    while True:
        code = input('The 6-digit code: ').strip().replace(' ', '')
        data, ctype = form_data({'code': code})
        status, body = request('POST', url + '/pc/pair', data, {'Content-Type': ctype})
        reply = as_json(body) or {}
        if status == 200 and reply.get('key'):
            break
        print(reply.get('detail') or 'Your worker is waking up. Wait a minute and type the code again.')
    CONFIG.write_text(json.dumps({'url': url, 'key': reply['key']}))
    print('Connected.')
    return Worker(url, reply['key'])


# ---------- ComfyUI ----------

def comfy_up():
    status, _ = request('GET', COMFY + '/system_stats', timeout=5)
    return status == 200


def comfy_stats():
    status, body = request('GET', COMFY + '/system_stats', timeout=10)
    return (as_json(body) or {}) if status == 200 else {}


def start_comfy(reserve_vram=None):
    """Starts ComfyUI in the background unless it is already running. Returns the process (or None).
    reserve_vram (GB): kept free for Windows and other programs (ComfyUI's --reserve-vram)."""
    if comfy_up():
        if reserve_vram:
            say('ComfyUI was already running, so it keeps its own memory settings.')
        return None
    say('Starting ComfyUI (about a minute)...')
    log = open(HERE / 'comfyui.log', 'w', encoding='utf-8', errors='replace')
    cmd = [sys.executable, 'main.py', '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch']
    if reserve_vram:
        cmd += ['--reserve-vram', f'{float(reserve_vram):g}']
    proc = subprocess.Popen(cmd, cwd=COMFY_DIR, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(600):
        if comfy_up():
            return proc
        if proc.poll() is not None:
            raise SystemExit(f'ComfyUI stopped while starting. See {HERE / "comfyui.log"}')
        time.sleep(1)
    raise SystemExit('ComfyUI took too long to start.')


def gpu_name():
    devices = comfy_stats().get('devices') or []
    if not devices:
        return 'PC'
    # e.g. "cuda:0 NVIDIA GeForce RTX 5060 Ti : cudaMallocAsync"
    name = devices[0].get('name', 'PC').split(' : ')[0]
    return name.split(' ', 1)[1] if name.startswith('cuda:') and ' ' in name else name


def clip_size(image):
    """About 480p with the picture's own shape, in multiples of 16 as Wan needs."""
    from PIL import Image
    w, h = Image.open(io.BytesIO(image)).size
    area, aspect = 480 * 832, w / h
    width = max(256, round((area * aspect) ** 0.5 / 16) * 16)
    height = max(256, round((area / aspect) ** 0.5 / 16) * 16)
    return width, height


def workflow(image_name, prompt, width, height, frames, seed):
    """Wan 2.2 14B image-to-video: high-noise model for steps 0-2, low-noise model for steps 2-4."""
    m = MODELS
    sampler = {'cfg': 1.0, 'sampler_name': 'euler', 'scheduler': 'simple', 'steps': 4, 'noise_seed': seed,
               'positive': ['12', 0], 'negative': ['12', 1]}
    return {
        '1': {'class_type': 'UnetLoaderGGUF', 'inputs': {'unet_name': m['high']}},
        '2': {'class_type': 'UnetLoaderGGUF', 'inputs': {'unet_name': m['low']}},
        '3': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': m['high_lora'], 'strength_model': 1.0}},
        '4': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['2', 0], 'lora_name': m['low_lora'], 'strength_model': 1.0}},
        '5': {'class_type': 'ModelSamplingSD3', 'inputs': {'model': ['3', 0], 'shift': 5.0}},
        '6': {'class_type': 'ModelSamplingSD3', 'inputs': {'model': ['4', 0], 'shift': 5.0}},
        '7': {'class_type': 'CLIPLoaderGGUF', 'inputs': {'clip_name': m['text'], 'type': 'wan'}},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['7', 0], 'text': prompt}},
        '9': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['7', 0], 'text': NEGATIVE}},
        '10': {'class_type': 'VAELoader', 'inputs': {'vae_name': m['vae']}},
        '11': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '12': {'class_type': 'WanImageToVideo', 'inputs': {
            'positive': ['8', 0], 'negative': ['9', 0], 'vae': ['10', 0], 'start_image': ['11', 0],
            'width': width, 'height': height, 'length': frames, 'batch_size': 1}},
        '13': {'class_type': 'KSamplerAdvanced', 'inputs': {
            **sampler, 'model': ['5', 0], 'add_noise': 'enable', 'latent_image': ['12', 2],
            'start_at_step': 0, 'end_at_step': 2, 'return_with_leftover_noise': 'enable'}},
        '14': {'class_type': 'KSamplerAdvanced', 'inputs': {
            **sampler, 'model': ['6', 0], 'add_noise': 'disable', 'latent_image': ['13', 0],
            'start_at_step': 2, 'end_at_step': 4, 'return_with_leftover_noise': 'disable'}},
        '15': {'class_type': 'VAEDecode', 'inputs': {'samples': ['14', 0], 'vae': ['10', 0]}},
        '16': {'class_type': 'SaveWEBM', 'inputs': {
            'images': ['15', 0], 'filename_prefix': 'antics/clip', 'codec': 'vp9', 'fps': 16.0, 'crf': 24.0}},
    }


def comfy_error(entry):
    for kind, info in (entry.get('status') or {}).get('messages') or []:
        if kind == 'execution_error':
            msg = info.get('exception_message', '').strip()
            if 'out of memory' in msg.lower() or 'allocation' in msg.lower():
                return 'The graphics card ran out of memory. Close games and other big programs, then try again.'
            return f"{info.get('node_type', 'ComfyUI')}: {msg}"[:300]
    return 'ComfyUI could not make the clip'


def upload_to_comfy(name, data, ctype):
    """Puts a file in ComfyUI's input folder (its /upload/image takes any file). Returns the name to use."""
    body, ct = form_data({'overwrite': 'true'}, [('image', name, data, ctype)])
    status, res = request('POST', COMFY + '/upload/image', body, {'Content-Type': ct}, timeout=120)
    info = as_json(res) if status == 200 else None
    if not info or not info.get('name'):
        raise RuntimeError(f'Could not hand {name} to ComfyUI ({status})')
    return f"{info['subfolder']}/{info['name']}" if info.get('subfolder') else info['name']


def make_clip(worker, task):
    """Runs one clip through ComfyUI and returns (video bytes, filename)."""
    image = worker.image(task['id'])
    data, ctype = form_data({'overwrite': 'true'}, [('image', f"antics_{task['id']}.jpg", image, 'image/jpeg')])
    status, body = request('POST', COMFY + '/upload/image', data, {'Content-Type': ctype})
    uploaded = as_json(body) if status == 200 else None
    if not uploaded:
        raise RuntimeError('Could not hand the picture to ComfyUI')
    name = f"{uploaded['subfolder']}/{uploaded['name']}" if uploaded.get('subfolder') else uploaded['name']

    width, height = clip_size(image)
    frames = 4 * round(float(task['seconds']) * 16 / 4) + 1  # Wan wants 4n+1 frames at 16 fps
    graph = workflow(name, task['prompt'], width, height, frames, random.randint(1, 2 ** 48))
    status, body = request('POST', COMFY + '/prompt', json.dumps({'prompt': graph, 'client_id': 'antics'}).encode(),
                           {'Content-Type': 'application/json'})
    queued = as_json(body) or {}
    if status != 200 or 'prompt_id' not in queued:
        raise RuntimeError(f"ComfyUI refused the job: {json.dumps(queued.get('node_errors') or queued.get('error'))[:250]}")

    started = time.time()
    while time.time() - started < 25 * 60:
        time.sleep(3)
        status, body = request('GET', f"{COMFY}/history/{queued['prompt_id']}")
        entry = (as_json(body) or {}).get(queued['prompt_id']) if status == 200 else None
        if not entry:
            continue
        if (entry.get('status') or {}).get('status_str') == 'error':
            raise RuntimeError(comfy_error(entry))
        for output in (entry.get('outputs') or {}).values():
            for item in output.get('images', []) + output.get('gifs', []) + output.get('videos', []):
                if item.get('filename', '').endswith(('.webm', '.mp4')):
                    query = urllib.parse.urlencode({k: item.get(k, '') for k in ('filename', 'subfolder', 'type')})
                    status, video = request('GET', f'{COMFY}/view?{query}', timeout=120)
                    if status == 200 and video:
                        return video, item['filename']
        if (entry.get('status') or {}).get('completed'):
            raise RuntimeError('ComfyUI finished but made no video')
    raise RuntimeError('The clip took too long')


# ======================================================================================================
# (Sing) Animals singing on this PC: InfiniteTalk in ComfyUI v0.41.0 (core node WanInfiniteTalkToVideo).
# A shot is made in parts ("chunks") of 81 frames at 25 fps; each part after the first starts on the last 9
# frames of the one before (handed over as an animated PNG), so it adds 72 new frames (2.88 s).
# ======================================================================================================

FPS = 25            # InfiniteTalk works at 25 fps (audio features are resampled from 50 Hz to 25 fps)
LENGTH = 81         # frames per part (the official default; 4n+1)
MOTION = 9          # previous frames used as motion context (the official default)
STEP = LENGTH - MOTION  # 72 new frames (2.88 s) per part after the first
SR = 16000          # wav2vec2 sample rate
TAIL = 0.5          # extra seconds of audio after a part, so its last frames hear what comes next
MIN_LEN = 17        # the shortest part: 9 motion frames + 8 new frames (4n+1)
AUDIO_PAD = 1.0     # seconds of silence added after each vocal track (every part's window then has sound)
STEPS = 6           # with the lightx2v step-distill LoRA at cfg 1 (as in ComfyUI's InfiniteTalk template)
CHUNK_TIMEOUT = 75 * 60
POLL = 3.0
FREE_WAIT = 2.0     # seconds ComfyUI gets to act on /free before the next prompt
MIN_FREE_VRAM = 6.5     # GB (GiB) of graphics memory that games and other programs must leave free
RESERVE_VRAM = 0.8      # GB ComfyUI keeps free for Windows (its --reserve-vram)
COMFY_CONTEXT_MIB = 500  # ComfyUI's own CUDA context (counted as ours when checking for a game)
MIN_DRIVER = 580        # CUDA 13 PyTorch (Blackwell RTX 50 cards) needs an NVIDIA driver from the 580 series
MIN_RAM_GB = 31         # 32 GB of RAM (Windows shows about 31.9)
KEEP_DAYS = 7           # unfinished shots kept on this PC this long
GRAPH_VERSION = 'it1'   # part of every shot's fingerprint: parts made by another graph are never mixed in

# The model files (setup-pc.ps1 downloads them; sizes are exact, so half-finished downloads don't count).
BASES = [  # Wan 2.1 I2V 14B 480p (InfiniteTalk is trained on it), city96's GGUF, picked by the PC's RAM
    ('wan2.1-i2v-14b-480p-Q5_K_M.gguf', 12743654784, 47),   # 48 GB of RAM or more
    ('wan2.1-i2v-14b-480p-Q4_K_M.gguf', 11341184384, 31),   # 32 GB of RAM
]
IT_SINGLE = 'wan2.1_infiniteTalk_single_fp16.safetensors'   # one singer
IT_MULTI = 'wan2.1_infiniteTalk_multi_fp16.safetensors'     # duets (two singers taking turns)
LORA = 'Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors'  # lightx2v's own release (Apache-2.0)
TEXT = MODELS['text']
VAE = MODELS['vae']
WAV2VEC = 'wav2vec2-chinese-base_fp16.safetensors'
SING_FILES = {
    BASES[0][0]: ('unet', BASES[0][1]),
    BASES[1][0]: ('unet', BASES[1][1]),
    IT_SINGLE: ('model_patches', 5125258232),
    IT_MULTI: ('model_patches', 5124439112),
    LORA: ('loras', 739472104),
    WAV2VEC: ('audio_encoders', 190115368),
    TEXT: ('text_encoders', 3655145312),
    VAE: ('vae', 253815318),
}
SING_NODES = ('WanInfiniteTalkToVideo', 'ModelPatchLoader', 'AudioEncoderLoader', 'AudioEncoderEncode', 'LoadAudio',
              'TrimAudioDuration', 'LoadImageMask', 'ImageFromBatch', 'SaveAnimatedPNG', 'SaveWEBM',
              'UnetLoaderGGUF', 'CLIPLoaderGGUF', 'LoraLoaderModelOnly', 'CFGGuider', 'SamplerCustomAdvanced')


# ---------- wav2vec frame maths (so a duet's turn changes land on the right frame) ----------

def wav2vec_frames(seconds):
    """Frames wav2vec2 makes from `seconds` of 16 kHz audio (receptive field 400, stride 320)."""
    n = int(round(seconds * SR))
    return 0 if n < 400 else (n - 400) // 320 + 1


def video_frames_from_audio(seconds):
    """Frames InfiniteTalk gets after its 50 Hz -> 25 fps resampling: int(T / 50 * 25)."""
    return int(wav2vec_frames(seconds) / 50.0 * FPS)


def audio_seconds_for(frames):
    """The shortest audio length (to 1 ms) that gives exactly `frames` InfiniteTalk frames."""
    s = frames / FPS
    for extra_ms in range(0, 200):
        d = round(s + extra_ms / 1000.0, 3)
        if video_frames_from_audio(d) >= frames:
            return d
    raise ValueError(frames)


# ---------- the part planner ----------

def _up(n):
    return 4 * math.ceil((n - 1) / 4) + 1


def _down(n):
    return 4 * ((n - 1) // 4) + 1


def frame_labels(total, turns, fps=FPS):
    """Who sings on each frame: 'A', 'B', 'AB' (both) or '' (nobody)."""
    labels = [''] * total
    for a, b, who in turns:
        for i in range(max(0, int(a * fps)), min(total, int(math.ceil(b * fps)))):
            labels[i] = who
    return labels


def _runs(labels, lo, hi, start):
    """Runs of singers in frames [lo, hi), as (label, index from the part's start).
    Silence belongs to whoever sang before it (their mouth is closed anyway)."""
    runs, cur = [], ''
    for i in range(lo, hi):
        w = labels[i] or cur
        if w and w != cur:
            runs.append((w, i - start))
            cur = w
    if runs:
        runs[0] = (runs[0][0], 0)
    return runs or [('A', 0)]


def plan_chunks(duration, turns=None, length=LENGTH, motion=MOTION, fps=FPS):
    """Splits `duration` seconds into InfiniteTalk parts.

    turns: for a duet, (start_s, end_s, singer) with singer 'A', 'B' or 'AB' (both).
    Core two_speakers mode puts speaker 2's audio after speaker 1's (MultiTalk "add" = taking turns), so a part
    holds at most one A<->B hand-over and 'both sing' stretches get parts of their own; parts are shortened
    (4n+1 frames, at least 17) to land on turn changes.
    Each part: index, first_frame (with the motion frames), length, new_from/new_to (the frames it adds), its audio
    window(s) in seconds and, for duets, speaker_1 / speaker_2 / switch_frame.
    """
    total = max(1, math.ceil(round(duration * fps, 6)))
    labels = frame_labels(total, turns, fps) if turns else None
    chunks, start, k = [], 0, 0
    while True:
        first_new = start + (motion if k else 0)
        if k and first_new >= total:
            break
        n = length
        if total - start < n:                              # the last part: just long enough
            n = max(MIN_LEN, _up(total - start))
        c = {'index': k, 'first_frame': start, 'audio_start': round(start / fps, 3)}
        if labels:
            runs = _runs(labels, first_new, min(total, start + n), start)
            cut = None
            if len(runs) >= 2 and 'AB' in (runs[0][0], runs[1][0]):
                cut = runs[1][1]                           # 'both' starts or ends: a new part there
            elif len(runs) >= 3:
                cut = runs[2][1]                           # a second hand-over: a new part there
            if cut is not None and _down(cut) >= MIN_LEN and _down(cut) > (motion if k else 0):
                n = _down(cut)
                runs = [r for r in runs if r[1] < n]
            s1 = runs[0][0]
            if len(runs) >= 2 and 'AB' not in (s1, runs[1][0]):
                s2, switch = runs[1][0], runs[1][1]
            else:
                s2, switch = {'A': 'B', 'B': 'A', 'AB': 'BG'}[s1], n
            c.update({'speaker_1': s1, 'speaker_2': s2, 'switch_frame': switch})
            if switch < n:   # speaker 1's audio must end exactly on the switch frame
                c['audio_1'] = (c['audio_start'], audio_seconds_for(switch))
                c['audio_2'] = (round(c['audio_start'] + switch / fps, 3), round((n - switch) / fps + TAIL, 3))
            else:            # speaker 2's audio lands after the part, so it never plays in it
                c['audio_1'] = (c['audio_start'], round(n / fps + TAIL, 3))
                c['audio_2'] = (c['audio_start'], 0.2)
        else:
            c['audio_duration'] = round(n / fps + TAIL, 3)
        c.update({'length': n, 'new_from': first_new, 'new_to': min(total, start + n)})
        chunks.append(c)
        if start + n >= total:
            break
        start += n - motion
        k += 1
    return chunks


# ---------- the ComfyUI graph of one part ----------

def _models(base, patch):
    return {
        '1': {'class_type': 'UnetLoaderGGUF', 'inputs': {'unet_name': base}},
        '2': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': LORA, 'strength_model': 1.0}},
        '3': {'class_type': 'ModelPatchLoader', 'inputs': {'name': patch}},
        '4': {'class_type': 'CLIPLoaderGGUF', 'inputs': {'clip_name': TEXT, 'type': 'wan'}},
        '7': {'class_type': 'VAELoader', 'inputs': {'vae_name': VAE}},
        '8': {'class_type': 'AudioEncoderLoader', 'inputs': {'audio_encoder_name': WAV2VEC}},
    }


def _audio(nid, file, start, duration):
    """LoadAudio -> TrimAudioDuration -> AudioEncoderEncode, as nodes nid, nid+1, nid+2."""
    return {
        str(nid): {'class_type': 'LoadAudio', 'inputs': {'audio': file}},
        str(nid + 1): {'class_type': 'TrimAudioDuration', 'inputs': {'audio': [str(nid), 0], 'start_index': float(start), 'duration': float(duration)}},
        str(nid + 2): {'class_type': 'AudioEncoderEncode', 'inputs': {'audio_encoder': ['8', 0], 'audio': [str(nid + 1), 0]}},
    }


def chunk_graph(tag, chunk, prompt, picture, voices, width, height, base, motion_image=None, seed=1,
                steps=STEPS, masks=None):
    """One InfiniteTalk part as a ComfyUI API prompt.

    picture: the uploaded picture; voices: uploaded vocal tracks by singer, {'A': ...} for one singer, plus 'B',
    'AB' (both voices) and 'BG' (any track; never heard) for a duet; masks: None, or uploaded mask PNGs by singer
    ('A', 'B', 'AB', 'BG' = the rest of the picture; white = that region). motion_image: the uploaded animated PNG
    with the previous part's last 9 frames (None for the first part).
    Outputs: node 24 saves the new frames (antics/sing/<tag>/part_###.webm), node 23 the last 9 frames
    (motion_###.png) for the next part.
    """
    k = chunk['index']
    duet = masks is not None
    g = _models(base, IT_MULTI if duet else IT_SINGLE)
    g['5'] = {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['4', 0], 'text': prompt}}
    g['6'] = {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['5', 0]}}
    g['12'] = {'class_type': 'LoadImage', 'inputs': {'image': picture}}
    talk = {'model': ['2', 0], 'model_patch': ['3', 0], 'positive': ['5', 0], 'negative': ['6', 0],
            'vae': ['7', 0], 'width': width, 'height': height, 'length': chunk['length'],
            'start_image': ['12', 0], 'motion_frame_count': MOTION, 'audio_scale': 1.0}
    if duet:
        s1, s2 = chunk['speaker_1'], chunk['speaker_2']
        g.update(_audio(30, voices[s1], *chunk['audio_1']))
        g.update(_audio(40, voices[s2], *chunk['audio_2']))
        g['50'] = {'class_type': 'LoadImageMask', 'inputs': {'image': masks[s1], 'channel': 'red'}}
        g['51'] = {'class_type': 'LoadImageMask', 'inputs': {'image': masks[s2], 'channel': 'red'}}
        talk.update({'mode': 'two_speakers', 'audio_encoder_output_1': ['32', 0],
                     'mode.audio_encoder_output_2': ['42', 0], 'mode.mask_1': ['50', 0], 'mode.mask_2': ['51', 0]})
    else:
        g.update(_audio(30, voices['A'], chunk['audio_start'], chunk['audio_duration']))
        talk.update({'mode': 'single_speaker', 'audio_encoder_output_1': ['32', 0]})
    if motion_image:
        g['13'] = {'class_type': 'LoadImage', 'inputs': {'image': motion_image}}
        talk['previous_frames'] = ['13', 0]
    g['14'] = {'class_type': 'WanInfiniteTalkToVideo', 'inputs': talk}
    g['15'] = {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'euler'}}
    g['16'] = {'class_type': 'BasicScheduler', 'inputs': {'model': ['14', 0], 'scheduler': 'normal', 'steps': steps, 'denoise': 1.0}}
    g['17'] = {'class_type': 'RandomNoise', 'inputs': {'noise_seed': int(seed) % (2 ** 63)}}
    g['18'] = {'class_type': 'CFGGuider', 'inputs': {'model': ['14', 0], 'positive': ['14', 1], 'negative': ['14', 2], 'cfg': 1.0}}
    g['19'] = {'class_type': 'SamplerCustomAdvanced', 'inputs': {
        'noise': ['17', 0], 'guider': ['18', 0], 'sampler': ['15', 0], 'sigmas': ['16', 0], 'latent_image': ['14', 3]}}
    g['20'] = {'class_type': 'VAEDecode', 'inputs': {'samples': ['19', 0], 'vae': ['7', 0]}}
    # the new frames only: trim_image (output 4) is 0 for the first part and 9 after that
    g['21'] = {'class_type': 'ImageFromBatch', 'inputs': {'image': ['20', 0], 'batch_index': ['14', 4], 'length': 4096}}
    g['22'] = {'class_type': 'ImageFromBatch', 'inputs': {'image': ['20', 0], 'batch_index': -MOTION, 'length': MOTION}}
    g['23'] = {'class_type': 'SaveAnimatedPNG', 'inputs': {
        'images': ['22', 0], 'filename_prefix': f'antics/sing/{tag}/motion_{k:03d}', 'fps': float(FPS), 'compress_level': 1}}
    g['24'] = {'class_type': 'SaveWEBM', 'inputs': {
        'images': ['21', 0], 'filename_prefix': f'antics/sing/{tag}/part_{k:03d}', 'codec': 'vp9', 'fps': float(FPS), 'crf': 16.0}}
    return g


def sing_size(size):
    """The task's [width, height], in multiples of 16 (InfiniteTalk's 480p bucket is 480x848 for 9:16)."""
    try:
        w, h = (int(round(float(x) / 16)) * 16 for x in size)
    except (TypeError, ValueError):
        w, h = 480, 848
    return min(1280, max(256, w)), min(1280, max(256, h))


# ---------- vocal tracks (RIFF WAVE, standard library only: the worker sends 16 kHz mono float32) ----------

def _wav_chunks(data):
    """((format tag, channels, rate, bits), [(chunk id, body), ...]) of a WAV file. Tag 1 = PCM, 3 = float
    (WAVE_FORMAT_EXTENSIBLE resolved to its sub-format)."""
    if len(data) < 12 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('not a WAV file')
    pos, fmt, chunks = 12, None, []
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack('<I', data[pos + 4:pos + 8])[0]
        size = min(size, len(data) - pos - 8)
        body = data[pos + 8:pos + 8 + size]
        if cid == b'fmt ' and len(body) >= 16:
            tag, ch, rate, _, _, bits = struct.unpack('<HHIIHH', body[:16])
            if tag == 0xFFFE and len(body) >= 26:
                tag = struct.unpack('<H', body[24:26])[0]
            fmt = (tag, ch, rate, bits)
        chunks.append((cid, body))
        pos += 8 + size + (size & 1)
    if not fmt or not any(cid == b'data' for cid, _ in chunks):
        raise ValueError('a WAV file without sound')
    return fmt, chunks


def _wav_join(chunks):
    out = b''.join(cid + struct.pack('<I', len(body)) + body + (b'\0' if len(body) & 1 else b'') for cid, body in chunks)
    return b'RIFF' + struct.pack('<I', 4 + len(out)) + b'WAVE' + out


def wav_seconds(data):
    (tag, ch, rate, bits), chunks = _wav_chunks(data)
    n = sum(len(body) for cid, body in chunks if cid == b'data')
    return n / float(rate * ch * (bits // 8))


def wav_pad(data, seconds):
    """The same WAV with `seconds` of silence after it (zero is silence for PCM and float alike)."""
    (tag, ch, rate, bits), chunks = _wav_chunks(data)
    add = bytes(int(round(seconds * rate)) * ch * (bits // 8))
    return _wav_join([(cid, body + add) if cid == b'data' else (cid, body) for cid, body in chunks])


def wav_mix(a, b):
    """Two WAVs of the same format added together sample by sample (the longer length), kept in range."""
    import array
    fa, ca = _wav_chunks(a)
    fb, cb = _wav_chunks(b)
    if fa != fb:
        raise ValueError(f'the two voices are in different formats ({fa} / {fb})')
    code, lo, hi = {(3, 32): ('f', -1.0, 1.0), (1, 16): ('h', -32768, 32767), (1, 32): ('i', -2 ** 31, 2 ** 31 - 1)}.get(
        (fa[0], fa[3]), (None, 0, 0))
    if not code:
        raise ValueError(f'this WAV format cannot be mixed here ({fa})')
    xa = array.array(code, b''.join(body for cid, body in ca if cid == b'data'))
    xb = array.array(code, b''.join(body for cid, body in cb if cid == b'data'))
    if len(xa) < len(xb):
        xa, xb = xb, xa
    out = array.array(code, xa)
    for i, v in enumerate(xb):
        s = out[i] + v
        out[i] = hi if s > hi else lo if s < lo else s
    return _wav_join([(cid, out.tobytes()) if cid == b'data' else (cid, body) for cid, body in ca])


# ---------- the last 9 frames between parts (animated PNG) ----------

def png_frames(data):
    """Frames in a PNG: the count of an animated PNG, 1 for a still one, 0 when it is not a PNG."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return 0
    pos = 8
    while pos + 8 <= len(data):
        size, cid = struct.unpack('>I4s', data[pos:pos + 8])
        if cid == b'acTL':
            return struct.unpack('>I', data[pos + 8:pos + 12])[0]
        if cid == b'IDAT':
            return 1
        pos += 12 + size
    return 0


def motion_png(data, need=MOTION, fps=FPS):
    """An animated PNG of exactly `need` frames. ComfyUI's SaveAnimatedPNG (Pillow) merges identical neighbouring
    frames into one longer frame; the next part would then get too few previous frames ("Not enough previous
    frames provided"). Merged frames are spread out again, and a one-bit change in one corner pixel keeps them
    apart (invisible, and the part only uses these frames as motion context)."""
    if png_frames(data) == need:
        return data
    from PIL import Image, ImageSequence
    im = Image.open(io.BytesIO(data))
    frames = []
    for f in ImageSequence.Iterator(im):
        d = f.info.get('duration') or (1000.0 / fps)
        rgb = f.convert('RGB')
        frames += [rgb.copy() for _ in range(max(1, int(round(d * fps / 1000.0))))]
    if not frames:
        raise RuntimeError('ComfyUI sent an empty picture of the last frames')
    frames = ([frames[0]] * need + frames)[-need:]
    out = []
    for f in frames:
        f = f.copy()
        if out and f.tobytes() == out[-1].tobytes():
            r, g, b = f.getpixel((0, 0))
            f.putpixel((0, 0), (r ^ 1, g, b))
        out.append(f)
    buf = io.BytesIO()
    out[0].save(buf, 'PNG', save_all=True, append_images=out[1:], duration=int(1000 / fps), loop=0, compress_level=1)
    if png_frames(buf.getvalue()) != need:
        raise RuntimeError('Could not hand the last frames on to the next part')
    return buf.getvalue()


# ---------- joining the parts into the shot (PyAV: ComfyUI's own video library, in the same Python) ----------

ENCODERS = (  # (encoder, container, file type, content type, options)
    ('libx264', 'mp4', 'mp4', 'video/mp4', {'crf': '16', 'preset': 'medium'}),
    ('libopenh264', 'mp4', 'mp4', 'video/mp4', {}),
    ('libvpx-vp9', 'webm', 'webm', 'video/webm', {'crf': '18', 'deadline': 'good', 'row-mt': '1'}),
)


def join_parts(parts, out_dir, fps=FPS):
    """One video from the parts' new frames. parts: [(path, frames to keep), ...] in order. Every frame is decoded
    and encoded once more (the parts are near-lossless VP9). Returns (path, content type)."""
    import av
    from fractions import Fraction
    for codec, fmt, ext, ctype, opts in ENCODERS:
        try:
            av.codec.Codec(codec, 'w')
        except Exception:
            continue
        break
    else:
        raise RuntimeError("This PC's Python has no video encoder (PyAV). Run the setup again.")
    out_path = Path(out_dir) / f'shot.{ext}'
    tmp = out_path.with_suffix(f'.part.{ext}')
    written = 0
    with av.open(str(tmp), 'w', format=fmt, options={'movflags': '+faststart'} if fmt == 'mp4' else {}) as out:
        stream = None
        for path, keep in parts:
            got = 0
            with av.open(str(path)) as inp:
                for frame in inp.decode(video=0):
                    if got >= keep:
                        break
                    if stream is None:
                        stream = out.add_stream(codec, rate=fps)
                        stream.width, stream.height = frame.width - frame.width % 2, frame.height - frame.height % 2
                        stream.pix_fmt = 'yuv420p'
                        if codec == 'libvpx-vp9':
                            stream.bit_rate = 0
                        elif codec == 'libopenh264':
                            stream.bit_rate = 8_000_000
                        stream.options = dict(opts)
                    f = frame.reformat(width=stream.width, height=stream.height, format='yuv420p')
                    f.pts, f.time_base = written, Fraction(1, fps)
                    for packet in stream.encode(f):
                        out.mux(packet)
                    got += 1
                    written += 1
            if got < keep:
                raise RuntimeError(f'A part came back with {got} frames instead of {keep}')
        if stream is None:
            raise RuntimeError('No frames to join')
        for packet in stream.encode():
            out.mux(packet)
    os.replace(tmp, out_path)
    return out_path, ctype


# ---------- gaming-safe: the graphics card, the memory, the stop time ----------

def nvidia_smi():
    """The graphics card as nvidia-smi sees it: {'name', 'total', 'used', 'free' (MiB), 'driver'}, or None."""
    try:
        res = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.used,memory.free,driver_version',
                              '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=20,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError):
        return None
    lines = (res.stdout or '').strip().splitlines()
    if res.returncode != 0 or not lines:
        return None
    parts = [p.strip() for p in lines[0].split(',')]
    try:
        return {'name': parts[0], 'total': float(parts[1]), 'used': float(parts[2]), 'free': float(parts[3]),
                'driver': parts[4]}
    except (IndexError, ValueError):
        return None


def driver_major(driver):
    try:
        return int(str(driver).split('.')[0])
    except ValueError:
        return 0


def vram_for_singing(smi, stats=None):
    """GB (GiB) of graphics memory singing can have now: what games and other programs leave. ComfyUI's own memory
    (models it keeps loaded between parts) counts as ours. None when it can't be read."""
    if not smi:
        return None
    used = smi['used']
    devices = (stats or {}).get('devices') or []
    if devices:  # ComfyUI runs: its PyTorch memory and its CUDA context are ours
        used -= devices[0].get('torch_vram_total', 0) / 2 ** 20 + COMFY_CONTEXT_MIB
    return (smi['total'] - max(0.0, used)) / 1024.0


def total_ram_gb():
    """This PC's memory in GB (GiB)."""
    if os.name == 'nt':
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong), ('total', ctypes.c_ulonglong),
                        ('avail', ctypes.c_ulonglong), ('total_page', ctypes.c_ulonglong),
                        ('avail_page', ctypes.c_ulonglong), ('total_virtual', ctypes.c_ulonglong),
                        ('avail_virtual', ctypes.c_ulonglong), ('avail_extended', ctypes.c_ulonglong)]
        m = MemoryStatus()
        m.length = ctypes.sizeof(MemoryStatus)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.total / 2 ** 30
    try:
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 2 ** 30
    except (ValueError, OSError, AttributeError):
        return 0.0


def keep_awake(on):
    """While a part renders, Windows must not go to sleep (the display may still turn off)."""
    if os.name != 'nt':
        return
    import ctypes
    es_continuous, es_system_required = 0x80000000, 0x00000001
    ctypes.windll.kernel32.SetThreadExecutionState(es_continuous | (es_system_required if on else 0))


def torch_version():
    try:
        from importlib.metadata import version
        return version('torch')
    except Exception:
        return ''


def next_stop(hhmm, now=None):
    """The next time it is hh:mm (today, or tomorrow when that has passed). None for '' or 'none'."""
    text = str(hhmm or '').strip().lower()
    if text in ('', 'none', 'off'):
        return None
    m = re.fullmatch(r'([01]?\d|2[0-3]):([0-5]\d)', text)
    if not m:
        raise ValueError(f'"{hhmm}" is not a time like 07:30')
    now = now or datetime.now()
    t = now.replace(hour=int(m[1]), minute=int(m[2]), second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


def model_ok(name):
    folder, size = SING_FILES[name]
    path = COMFY_DIR / 'models' / folder / name
    try:
        return path.stat().st_size == size
    except OSError:
        return False


def sing_base(ram_gb):
    """The Wan 2.1 base this PC uses: by RAM (32 GB -> Q4_K_M, 48 GB or more -> Q5_K_M), of the files it has."""
    for name, _, need in BASES:
        if ram_gb >= need and model_ok(name):
            return name
    return None


class Singing:
    """What this PC may sing right now: switched on (--sing), the files, the nodes, the driver, the RAM, room on the
    graphics card (no game), and the stop time."""

    def __init__(self, on=False, until=None, min_free=MIN_FREE_VRAM, reserve=RESERVE_VRAM):
        self.on = bool(on)
        self.until_text = until or ''
        self.stop_at = next_stop(until)
        self.min_free = float(min_free)
        self.reserve = reserve
        self.base, self.duet, self.files_ok, self.nodes_ok = None, False, False, False
        self.problem = ''
        self.room = True
        self.free_gb = None
        self.info = {'vram': '', 'ram_gb': '', 'torch': torch_version(), 'driver': ''}
        self.soft = self.hard = False   # Ctrl+C once: stop after this part; twice: stop now
        self.warm = False               # the sing models are loaded (the last ComfyUI prompt was a part)

    # --- the checks ---
    def check_pc(self, smi=None):
        """Driver, RAM and files. Sets self.problem ('' when this PC can sing)."""
        smi = smi if smi is not None else nvidia_smi()
        ram = total_ram_gb()
        self.info['ram_gb'] = f'{ram:.0f}' if ram else ''
        if smi:
            self.info['vram'] = f"{smi['total'] / 1024:.1f}"
            self.info['driver'] = smi['driver']
        self.base = sing_base(ram)
        self.duet = model_ok(IT_MULTI)
        missing = [n for n in (IT_SINGLE, LORA, WAV2VEC, TEXT, VAE) if not model_ok(n)]
        self.files_ok = bool(self.base) and not missing
        if smi and driver_major(smi['driver']) < MIN_DRIVER:
            self.problem = (f"Your NVIDIA driver ({smi['driver']}) is too old for singing. Update it (NVIDIA app > "
                            f"Drivers, {MIN_DRIVER} or newer), then run the setup again.")
        elif ram and ram < MIN_RAM_GB:
            self.problem = (f'Singing on this PC needs 32 GB of RAM; this PC has {ram:.0f} GB. Online singing still '
                            f'works.')
        elif not self.files_ok:
            self.problem = 'The singing model files are missing or unfinished. Run the setup again (it continues).'
        else:
            self.problem = ''
        return self.problem

    def check_nodes(self):
        """ComfyUI has every node a part needs (the pinned v0.41.0 and ComfyUI-GGUF have them)."""
        missing = []
        for cls in SING_NODES:
            status, body = request('GET', f'{COMFY}/object_info/{cls}', timeout=30)
            if status != 200 or cls not in (as_json(body) or {}):
                missing.append(cls)
        self.nodes_ok = not missing
        if missing and not self.problem:
            self.problem = f"This ComfyUI can't sing (no {', '.join(missing[:3])}). Run the setup again."
        return missing

    def check_room(self, smi=None, stats=None):
        """True when games and other programs leave at least min_free GB of graphics memory."""
        smi = smi if smi is not None else nvidia_smi()
        self.free_gb = vram_for_singing(smi, stats)
        self.room = self.free_gb is None or self.free_gb >= self.min_free
        return self.room

    # --- what the worker hears ---
    def ready(self):
        return self.on and not self.problem and self.files_ok and self.nodes_ok

    def can(self):
        if not (self.ready() and self.room) or self.stopping():
            return ''
        return 'sing,sing_duet' if self.duet else 'sing'

    def why_not(self):
        """Why this PC can't take a sing task right now (the worker keeps it as the task's error)."""
        if self.on and self.problem:
            return self.problem
        if self.on and not self.room:
            return 'The PC stopped singing (a game is using the graphics card)'
        return 'Singing is switched off on this PC right now'

    def hello_fields(self):
        """The /pc/hello fields. can='none' (not ''): the worker's FastAPI reads an empty form value as "not sent"
        and would keep the old answer."""
        offset = datetime.now().astimezone().utcoffset()   # (the stop time is on this PC's clock: the worker's
        minutes = int(offset.total_seconds() // 60) if offset is not None else 0   # deadline can use the same one)
        return {'can': self.can() or 'none', 'until': self.until_text if self.stop_at else '',
                'utc_offset': str(minutes), **self.info}

    def worker_said(self, reply):
        """The worker's /pc/hello answer: 'sing_until' (the stop time set in the app) wins over --until."""
        text = str((reply or {}).get('sing_until') or '').strip()
        if text and text != self.until_text:
            try:
                self.stop_at, self.until_text = next_stop(text), text
                if self.on:
                    say(f'Singing stops at {text} (set in the app).')
            except ValueError:
                pass

    # --- stopping ---
    def stopping(self):
        """Why singing must stop now ('' when it may go on)."""
        if self.hard or self.soft:
            return 'you pressed Ctrl+C'
        if self.stop_at and datetime.now() >= self.stop_at:
            return f'it is {self.until_text}'
        return ''

    def on_ctrl_c(self, signum, frame):
        if self.soft:
            self.hard = True
            raise KeyboardInterrupt
        self.soft = True
        say('Stopping after this part, so nothing made is lost. Press Ctrl+C again to stop at once.')


class SingStopped(Exception):
    """Singing stopped between two parts (the stop time, Ctrl+C, or a game took the graphics card)."""


def task_signature(mode, seconds, size, prompt, turns, picture, audio, masks):
    """A fingerprint of everything a shot's frames depend on (not the seed): parts made earlier for the same
    shot are used again, even when the worker hands it over as a new task (it restarted, or the PC stopped)."""
    h = hashlib.sha256()
    for part in (GRAPH_VERSION, mode, f'{float(seconds):.3f}', f'{size[0]}x{size[1]}', prompt,
                 json.dumps(turns or [])):
        h.update(str(part).encode('utf-8') + b'\0')
    for blob in [picture] + list(audio) + list(masks):
        h.update(hashlib.sha256(blob).digest())
    return h.hexdigest()


class SingWork:
    """The parts of one shot kept on this PC (sing_work/<fingerprint>/): part_###.webm + motion_###.png, and
    state.json. Kept until the worker has the whole shot, then removed (or after KEEP_DAYS)."""

    def __init__(self, sig, root=None):
        self.sig = sig
        self.dir = Path(root or HERE / 'sing_work') / sig[:20]
        self.dir.mkdir(parents=True, exist_ok=True)
        self.file = self.dir / 'state.json'
        try:
            state = json.loads(self.file.read_text())
        except (OSError, ValueError):
            state = {}
        self.state = state if state.get('sig') == sig else {'sig': sig, 'parts': {}}

    def video(self, k):
        return self.dir / f'part_{k:03d}.webm'

    def motion_file(self, k):
        return self.dir / f'motion_{k:03d}.png'

    def has(self, k):
        return str(k) in self.state['parts'] and all(
            p.is_file() and p.stat().st_size > 0 for p in (self.video(k), self.motion_file(k)))

    def motion(self, k):
        return self.motion_file(k).read_bytes()

    def save(self, k, video, motion, seconds=None):
        for path, data in ((self.video(k), video), (self.motion_file(k), motion)):
            tmp = path.with_name(path.name + '.tmp')
            tmp.write_bytes(data)
            os.replace(tmp, path)
        self.state['parts'][str(k)] = {'s': round(seconds, 1) if seconds else None, 'at': round(time.time())}
        tmp = self.file.with_name('state.json.tmp')
        tmp.write_text(json.dumps(self.state))
        os.replace(tmp, self.file)

    def remove(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def prune_work(root=None, days=KEEP_DAYS):
    """Unfinished shots older than `days` are not needed any more."""
    root = Path(root or HERE / 'sing_work')
    if not root.is_dir():
        return
    for d in root.iterdir():
        try:
            if d.is_dir() and time.time() - (d / 'state.json').stat().st_mtime > days * 86400:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            shutil.rmtree(d, ignore_errors=True)


def clean_comfy_files(tag):
    """This shot's files in ComfyUI's input and output folders (only ours: they carry the shot's tag)."""
    for f in (COMFY_DIR / 'input').glob(f'antics_sing_{tag}_*'):
        try:
            f.unlink()
        except OSError:
            pass
    shutil.rmtree(COMFY_DIR / 'output' / 'antics' / 'sing' / tag, ignore_errors=True)


def run_part(graph, singing, peaks, timeout=CHUNK_TIMEOUT):
    """Queues one part, waits for it (sampling the memory in use), returns {node id: [file bytes, ...]}."""
    status, body = request('POST', COMFY + '/prompt', json.dumps({'prompt': graph, 'client_id': 'antics'}).encode(),
                           {'Content-Type': 'application/json'})
    queued = as_json(body) or {}
    if status != 200 or 'prompt_id' not in queued:
        raise RuntimeError(f"ComfyUI refused this part: {json.dumps(queued.get('node_errors') or queued.get('error'))[:250]}")
    pid, started, sampled = queued['prompt_id'], time.time(), 0.0
    try:
        while time.time() - started < timeout:
            time.sleep(POLL)
            if time.time() - sampled >= 10 * POLL:
                sample_memory(peaks)
                sampled = time.time()
            status, body = request('GET', f'{COMFY}/history/{pid}')
            entry = (as_json(body) or {}).get(pid) if status == 200 else None
            if not entry:
                continue
            if (entry.get('status') or {}).get('status_str') == 'error':
                raise RuntimeError(comfy_error(entry))
            out = {}
            for nid, o in (entry.get('outputs') or {}).items():
                for item in o.get('images', []) + o.get('gifs', []) + o.get('videos', []):
                    q = urllib.parse.urlencode({k: item.get(k, '') for k in ('filename', 'subfolder', 'type')})
                    st, data = request('GET', f'{COMFY}/view?{q}', timeout=300)
                    if st == 200 and data:
                        out.setdefault(nid, []).append(data)
            if out or (entry.get('status') or {}).get('completed'):
                sample_memory(peaks)
                return out
        raise RuntimeError('This part took too long')
    except KeyboardInterrupt:
        request('POST', COMFY + '/interrupt', b'{}', {'Content-Type': 'application/json'}, timeout=5)
        raise


def sample_memory(peaks):
    """The most graphics memory and RAM in use so far (GB), from ComfyUI."""
    stats = comfy_stats()
    dev = (stats.get('devices') or [{}])[0]
    system = stats.get('system') or {}
    if dev.get('vram_total'):
        peaks['vram'] = max(peaks.get('vram', 0.0), (dev['vram_total'] - dev.get('vram_free', 0)) / 2 ** 30)
    if system.get('ram_total'):
        peaks['ram'] = max(peaks.get('ram', 0.0), (system['ram_total'] - system.get('ram_free', 0)) / 2 ** 30)


def free_comfy_memory():
    """Unloads ComfyUI's models (switching between normal clips and singing: both don't fit in 32 GB of RAM).
    ComfyUI acts on /free in its prompt loop, after the prompt it runs, so it is given a moment before the next
    part is queued (else it would unload the models that part has just loaded)."""
    request('POST', COMFY + '/free', json.dumps({'unload_models': True, 'free_memory': True}).encode(),
            {'Content-Type': 'application/json'}, timeout=60)
    time.sleep(FREE_WAIT)


def task_turns(task, seconds):
    """A duet's turns: [[start, end, 'A'|'B'|'AB'], ...] in seconds of the task's audio, in order."""
    out = []
    for t in task.get('turns') or []:
        try:
            a, b, who = float(t[0]), float(t[1]), str(t[2]).upper()
        except (TypeError, ValueError, IndexError):
            continue
        a, b = max(0.0, a), min(float(seconds), b)
        if who in ('A', 'B', 'AB') and b > a:
            out.append([round(a, 3), round(b, 3), who])
    return sorted(out)


def mask_union(a, b):
    from PIL import Image, ImageChops
    x = ImageChops.lighter(Image.open(io.BytesIO(a)).convert('L'), Image.open(io.BytesIO(b)).convert('L'))
    buf = io.BytesIO()
    x.save(buf, 'PNG')
    return buf.getvalue()


def mask_invert(m):
    from PIL import Image, ImageOps
    buf = io.BytesIO()
    ImageOps.invert(Image.open(io.BytesIO(m)).convert('L')).save(buf, 'PNG')
    return buf.getvalue()


def sing_task(worker, task, singing):
    """Makes one sing task (one shot, or one half of a split screen) part by part and hands the shot to the worker.
    Parts already made (on this PC or on the worker) are not made again. Raises SingStopped, TaskGone,
    WorkerAsleep (the parts stay), or another error (the task failed)."""
    tid = task['id']
    mode = task.get('mode') or 'solo'
    duet = mode == 'duet'
    if mode not in ('solo', 'split', 'duet'):
        raise RuntimeError(f'This helper does not know sing tasks of kind "{mode}". Run the setup again.')
    if duet and not singing.duet:
        raise RuntimeError('Duets need the duet model on this PC. Run the setup again.')
    seconds = float(task.get('seconds') or 0)
    if not 0 < seconds <= 120:
        raise RuntimeError(f'A shot of {seconds:g} s cannot be sung here')
    if int(task.get('fps') or FPS) != FPS:
        say(f"The worker asked for {task.get('fps')} fps; InfiniteTalk sings at {FPS}.")
    w, h = sing_size(task.get('size') or (480, 848))
    picture = worker.task_file(tid, 'image')
    audio = [worker.task_file(tid, 'audio', n) for n in range(int(task.get('audio') or 0))]
    masks = [worker.task_file(tid, 'mask', n) for n in range(int(task.get('masks') or 0))]
    if not audio:
        raise RuntimeError('The worker sent no vocals for this shot')
    turns = task_turns(task, seconds) if duet else None
    if duet and (len(audio) < 2 or len(masks) < 2 or not turns):
        raise RuntimeError('The worker sent a duet without both voices, both masks and who sings when')
    plan = plan_chunks(seconds, turns=turns)
    if task.get('chunks') and int(task['chunks']) != len(plan):
        say(f"(The worker counted {task['chunks']} parts; this PC makes {len(plan)}.)")
    prompt = str(task.get('prompt') or 'An animal sings to the camera')
    sig = task_signature(mode, seconds, (w, h), prompt, turns, picture, audio, masks)
    tag = sig[:12]
    work = SingWork(sig)
    remote = {int(n) for n in task.get('parts_done') or []}
    seed = int(task.get('seed') or random.randint(1, 2 ** 31 - 1))
    done_before = sum(work.has(c['index']) for c in plan)
    say(f"Singing a {seconds:.1f} s shot in {len(plan)} part{'s' * (len(plan) != 1)} at {w}x{h}"
        + (f' ({done_before} already made on this PC)' if done_before else '') + '...')

    uploaded = {}

    def comfy_inputs():
        """The picture, the vocals (with a second of silence after them) and the masks, in ComfyUI (once)."""
        if uploaded:
            return uploaded
        ext, ctype = ('png', 'image/png') if picture[:8] == b'\x89PNG\r\n\x1a\n' else ('jpg', 'image/jpeg')
        uploaded['picture'] = upload_to_comfy(f'antics_sing_{tag}_picture.{ext}', picture, ctype)
        tracks = {'A': audio[0]}
        if duet:
            tracks.update({'B': audio[1], 'AB': audio[2] if len(audio) > 2 else wav_mix(audio[0], audio[1])})
        voices = {who: upload_to_comfy(f'antics_sing_{tag}_voice{who}.wav', wav_pad(data, AUDIO_PAD), 'audio/wav')
                  for who, data in tracks.items()}
        if duet:
            voices['BG'] = voices['A']   # (the rest of the picture never sings: its track lands after the part)
            both = masks[2] if len(masks) > 2 else mask_union(masks[0], masks[1])
            rest = masks[3] if len(masks) > 3 else mask_invert(both)
            uploaded['masks'] = {who: upload_to_comfy(f'antics_sing_{tag}_mask{who}.png', data, 'image/png')
                                 for who, data in (('A', masks[0]), ('B', masks[1]), ('AB', both), ('BG', rest))}
        uploaded['voices'] = voices
        return uploaded

    try:
        made = sing_parts(worker, task, singing, plan, work, remote, comfy_inputs, prompt, w, h, seed, tag)
    finally:
        keep_awake(False)
        clean_comfy_files(tag)   # (a later try uploads them again; the parts themselves stay in sing_work)
    return made


def sing_parts(worker, task, singing, plan, work, remote, comfy_inputs, prompt, w, h, seed, tag):
    """The part loop of sing_task, then the join and the hand-over."""
    tid = task['id']
    for chunk in plan:
        k = chunk['index']
        if work.has(k):
            if k not in remote:
                remote.update(send_part_safely(worker, tid, k, work))
            continue
        if k in remote:  # the worker kept it: take it back instead of making it again (when the worker can)
            video, motion = worker.get_part(tid, k, video=True), worker.get_part(tid, k)
            if video and motion and png_frames(motion) >= MOTION:
                work.save(k, video, motion)
                continue
        why = singing.stopping()
        if why:
            raise SingStopped(why)
        if not singing.check_room(stats=comfy_stats()):
            singing.room = False
            raise SingStopped('a game is using the graphics card')
        files = comfy_inputs()
        motion_name = None
        if k:
            motion_name = upload_to_comfy(f'antics_sing_{tag}_motion_{k - 1:03d}.png', work.motion(k - 1), 'image/png')
        graph = chunk_graph(tag, chunk, prompt, files['picture'], files['voices'], w, h, singing.base,
                            motion_image=motion_name, seed=seed + k, masks=files.get('masks'))
        if not singing.warm:
            free_comfy_memory()
        cold = not singing.warm
        peaks, started = {}, time.time()
        keep_awake(True)
        old = signal.signal(signal.SIGINT, singing.on_ctrl_c) if threading.current_thread() is threading.main_thread() else None
        try:
            out = run_part(graph, singing, peaks)
        finally:
            if old is not None:
                signal.signal(signal.SIGINT, old)
        took = time.time() - started
        singing.warm = True
        if not out.get('24') or not out.get('23'):
            raise RuntimeError(f'Part {k + 1} came back without its video')
        work.save(k, out['24'][0], motion_png(out['23'][0]), took)
        remote.update(send_part_safely(worker, tid, k, work))
        fields = {'size': f'{w}x{h}', 'peak_vram': f"{peaks['vram']:.1f} GB" if peaks.get('vram') else '',
                  'peak_ram': f"{peaks['ram']:.1f} GB" if peaks.get('ram') else ''}
        fields['cold_s' if cold else 'chunk_s'] = f'{took:.1f}'   # (the first part also loads the models)
        worker.progress(tid, fields)
        say(f'Part {k + 1} of {len(plan)} done in {took / 60:.1f} min'
            + (' (including loading the models)' if cold else '') + '.')
    keep_awake(False)

    for c in plan:  # the worker gets every part (some may have missed it while it was asleep)
        if c['index'] not in remote:
            remote.update(send_part_safely(worker, tid, c['index'], work, tries=3))
    path, ctype = join_parts([(work.video(c['index']), c['new_to'] - c['new_from']) for c in plan], work.dir)
    status = None
    for attempt in range(15):
        try:
            status = worker.done(tid, path.read_bytes(), path.name, ctype)
            break
        except WorkerAsleep:
            if attempt == 14:
                raise
            say('Your worker is waking up; handing the shot over again in 20 seconds...')
            time.sleep(20)
    if status == 404:
        raise TaskGone()
    if status != 200:
        raise RuntimeError(f'The worker could not take the finished shot ({status})')
    work.remove()
    return len(plan)


def send_part_safely(worker, task_id, k, work, tries=1):
    """Hands part k to the worker; a sleeping worker gets it later (it stays on this PC). Returns the parts the
    worker has."""
    for attempt in range(tries):
        try:
            return set(worker.send_part(task_id, k, work.video(k).read_bytes(), work.motion(k))) | {k}
        except WorkerAsleep:
            if attempt + 1 < tries:
                time.sleep(20)
    return set()


def check_pc_report(args):
    """--check: is this PC ready to sing? Prints what it found; returns 0 when it is."""
    s = Singing(on=True, until=args.until, min_free=args.min_free_vram)
    smi = nvidia_smi()
    print()
    print('antics: can this PC sing?')
    print('-------------------------')
    if smi:
        print(f"Graphics card: {smi['name']}, {smi['total'] / 1024:.1f} GB, {smi['free'] / 1024:.1f} GB free, "
              f"driver {smi['driver']}" + ('' if driver_major(smi['driver']) >= MIN_DRIVER else
                                           f' (too old: {MIN_DRIVER} or newer needed)'))
    else:
        print('Graphics card: nvidia-smi did not answer (no NVIDIA card or driver?)')
    print(f'RAM: {total_ram_gb():.1f} GB (singing needs 32 GB)')
    print(f"PyTorch: {s.info['torch'] or 'not found in this Python'}")
    for name, (folder, size) in SING_FILES.items():
        print(f"  {'ok     ' if model_ok(name) else 'missing'} {folder}/{name} ({size / 1e9:.2f} GB)")
    problem = s.check_pc(smi)
    if comfy_up():
        missing = s.check_nodes()
        print('ComfyUI nodes: ' + ('all there' if not missing else 'missing ' + ', '.join(missing)))
        problem = s.problem
    else:
        s.nodes_ok = True
        print('ComfyUI is not running, so its nodes were not checked.')
    s.check_room(smi)
    if s.free_gb is not None and not s.room:
        print(f'Close your game first: singing needs {s.min_free:g} GB of free graphics memory and '
              f'{s.free_gb:.1f} GB are free.')
    print()
    print(('Ready to sing' + (' (and duets)' if s.duet else '') + f', with {s.base}.') if not problem else problem)
    return 0 if not problem else 1


# ---------- Main loop ----------

def keep_saying_hello(worker, name, stop, singing=None):
    while not stop.wait(30):
        try:
            reply = worker.hello(name, extra=singing.hello_fields() if singing else None)
            if singing:
                singing.worker_said(reply)
        except WorkerAsleep:
            pass


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='The antics PC helper: makes your antics videos on this PC.')
    p.add_argument('--pair', action='store_true', help='connect this PC to your worker, then stop')
    p.add_argument('--sing', action='store_true', help='also make Sing shots (animals singing)')
    p.add_argument('--until', default='', help='stop singing at this time, like 07:30 (the time set in the app wins)')
    p.add_argument('--reserve-vram', type=float, default=RESERVE_VRAM,
                   help='GB of graphics memory ComfyUI leaves for Windows (default 0.8)')
    p.add_argument('--min-free-vram', type=float, default=MIN_FREE_VRAM,
                   help='sing only while games and other programs leave this many GB free (default 6.5)')
    p.add_argument('--check', action='store_true', help='check whether this PC can sing, then stop')
    args, _ = p.parse_known_args(argv)
    try:
        next_stop(args.until)
    except ValueError as e:
        p.error(str(e))
    return args


def wait_for_room(singing):
    """At the start: while a game holds the graphics card, nothing starts ("Close your game first")."""
    told = False
    while not singing.check_room(stats=comfy_stats() if comfy_up() else None):
        why = singing.stopping()
        if why:
            return False
        if not told:
            say(f'Close your game first: singing needs {singing.min_free:g} GB of free graphics memory and only '
                f'{singing.free_gb:.1f} GB are free. Waiting for it (Ctrl+C to stop)...')
            told = True
        time.sleep(30 if POLL >= 1 else POLL)
    return True


def main(argv=None):
    args = parse_args(argv)
    if args.check:
        sys.exit(check_pc_report(args))
    config = json.loads(CONFIG.read_text()) if CONFIG.exists() else None
    if config and args.pair:
        print('This PC is already connected to your antics worker.')
        return
    worker = Worker(config['url'], config['key']) if config else pair()
    if args.pair:
        return

    singing = Singing(on=args.sing, until=args.until, min_free=args.min_free_vram, reserve=args.reserve_vram)
    if singing.on:
        prune_work()
        if singing.check_pc():
            say(singing.problem)
            say('This PC makes normal clips only.')
        elif not wait_for_room(singing):
            say(f'Singing stopped before it started ({singing.stopping()}).')
            return
    comfy = start_comfy(args.reserve_vram)
    name = gpu_name()
    if singing.on and not singing.problem:
        singing.check_nodes()
        if singing.problem:
            say(singing.problem)
    stop = threading.Event()
    threading.Thread(target=keep_saying_hello, args=(worker, name, stop, singing), daemon=True).start()
    print()
    say(f'Ready on {name}. Your antics videos will now be made on this PC.')
    if singing.ready():
        when = f" until {singing.stop_at:%H:%M}{' tomorrow' if singing.stop_at.date() > datetime.now().date() else ''}" \
            if singing.stop_at else ''
        say(f"Singing is on{when} ({'solo and duets' if singing.duet else 'solo'}, {singing.base}).")
    say('Keep this window open (you can minimise it). Close it to stop.')
    first, said_can = True, None
    try:
        while True:
            if singing.on:
                why = singing.stopping()
                if why and singing.ready():
                    say(f'Singing stops: {why}. Everything made so far is kept.')
                    break
                if singing.ready():
                    had = singing.room
                    singing.check_room(stats=comfy_stats())
                    if had and not singing.room:
                        say(f'A game is using the graphics card ({singing.free_gb:.1f} GB free): singing waits '
                            f'until it closes.')
                    elif singing.room and not had:
                        say('The graphics card is free again: singing goes on.')
            try:
                fields = singing.hello_fields()
                if first or fields['can'] != said_can:
                    singing.worker_said(worker.hello(name, starting=first, extra=fields))
                    first, said_can = False, fields['can']
                task = worker.next_task()
            except WorkerAsleep:
                say('Your worker is waking up, trying again in 20 seconds...')
                time.sleep(20)
                continue
            if not task:
                continue
            if task.get('kind') == 'sing':
                if not handle_sing(worker, task, singing):
                    break
                continue
            singing.warm = False
            say(f"Making a clip: {task['prompt'][:90]}...")
            started = time.time()
            try:
                video, filename = make_clip(worker, task)
                worker.done(task['id'], video, filename)
                say(f'Done in {round(time.time() - started)} seconds.')
            except WorkerAsleep:
                say('Lost the worker for a moment; it will make that clip online instead.')
            except Exception as e:
                say(f'Could not make it: {e}')
                try:
                    worker.failed(task['id'], str(e))
                except WorkerAsleep:
                    pass
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        keep_awake(False)
        if singing.on:
            try:
                worker.hello(name, extra=dict(singing.hello_fields(), can='none'))
            except (WorkerAsleep, SystemExit):
                pass
        if comfy:
            comfy.terminate()


def handle_sing(worker, task, singing):
    """One sing task from the main loop. Returns False when the helper should stop (stop time or Ctrl+C)."""
    why = singing.stopping() if singing.ready() else ''
    if why:  # (the stop time passed while the worker was handing this task over)
        try:
            worker.failed(task['id'], f'The PC stopped singing ({why})')
        except WorkerAsleep:
            pass
        return False
    if not singing.can():  # (the worker offered it before it heard can=none: a game started, or singing is off)
        try:
            worker.failed(task['id'], singing.why_not())
        except WorkerAsleep:
            pass
        return True
    started = time.time()
    try:
        parts = sing_task(worker, task, singing)
        say(f'Shot sung in {(time.time() - started) / 60:.1f} min ({parts} parts).')
    except SingStopped as e:
        say(f'Singing paused: {e}. The parts made are kept; it carries on next time.')
        try:
            worker.failed(task['id'], f'The PC stopped singing ({e}); its parts are kept for next time')
        except WorkerAsleep:
            pass
        return not singing.stopping()
    except TaskGone:
        say('The worker no longer needs that shot.')
    except WorkerAsleep:
        say('Lost the worker for a moment; the parts made are kept on this PC.')
    except KeyboardInterrupt:
        try:
            worker.failed(task['id'], 'The PC was stopped; its parts are kept for next time')
        except (WorkerAsleep, Exception):
            pass
        raise
    except Exception as e:
        say(f'Could not sing it: {e}')
        try:
            worker.failed(task['id'], str(e))
        except WorkerAsleep:
            pass
    finally:
        keep_awake(False)
    return True


if __name__ == '__main__':
    main()
