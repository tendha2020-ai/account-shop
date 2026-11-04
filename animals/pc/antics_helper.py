# antics_helper.py: makes antics clips on this PC's graphics card, for free and without limits.
#
# It starts ComfyUI (installed next to this file by setup-pc.ps1), connects to your antics worker
# with a 6-digit code from the app, then keeps asking the worker for clips to make. It only calls
# out to the worker, so no router or firewall settings are needed. Close the window to stop.

import io
import json
import random
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / 'antics_helper.json'
COMFY_DIR = HERE / 'ComfyUI'
COMFY = 'http://127.0.0.1:8188'
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


class Worker:
    def __init__(self, url, key):
        self.url = url.rstrip('/')
        self.key = key

    def call(self, method, path, fields=None, files=(), timeout=60):
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
        if status == 200 and not path.endswith('/image') and as_json(body) is None:
            raise WorkerAsleep()  # a sleeping Space answers with a web page instead
        return status, body

    def hello(self, name, starting=False):
        self.call('POST', '/pc/hello', {'name': name, 'starting': 'true' if starting else 'false'})

    def next_task(self):
        status, body = self.call('GET', '/pc/next?wait=25', timeout=60)
        if status != 200:
            time.sleep(10)
            return None
        return (as_json(body) or {}).get('task')

    def image(self, task_id):
        status, body = self.call('GET', f'/pc/tasks/{task_id}/image')
        if status != 200:
            raise RuntimeError('The worker no longer needs this clip')
        return body

    def done(self, task_id, video, filename):
        self.call('POST', f'/pc/tasks/{task_id}/done', files=[('video', filename, video, 'video/webm')], timeout=300)

    def failed(self, task_id, error):
        self.call('POST', f'/pc/tasks/{task_id}/failed', {'error': error[:300]})


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


def start_comfy():
    """Starts ComfyUI in the background unless it is already running. Returns the process (or None)."""
    if comfy_up():
        return None
    say('Starting ComfyUI (about a minute)...')
    log = open(HERE / 'comfyui.log', 'w', encoding='utf-8', errors='replace')
    proc = subprocess.Popen([sys.executable, 'main.py', '--listen', '127.0.0.1', '--port', '8188',
                             '--disable-auto-launch'], cwd=COMFY_DIR, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(600):
        if comfy_up():
            return proc
        if proc.poll() is not None:
            raise SystemExit(f'ComfyUI stopped while starting. See {HERE / "comfyui.log"}')
        time.sleep(1)
    raise SystemExit('ComfyUI took too long to start.')


def gpu_name():
    status, body = request('GET', COMFY + '/system_stats', timeout=10)
    devices = (as_json(body) or {}).get('devices') or []
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


# ---------- Main loop ----------

def keep_saying_hello(worker, name, stop):
    while not stop.wait(30):
        try:
            worker.hello(name)
        except WorkerAsleep:
            pass


def main():
    config = json.loads(CONFIG.read_text()) if CONFIG.exists() else None
    if config and '--pair' in sys.argv:
        print('This PC is already connected to your antics worker.')
        return
    worker = Worker(config['url'], config['key']) if config else pair()
    if '--pair' in sys.argv:
        return

    comfy = start_comfy()
    name = gpu_name()
    stop = threading.Event()
    threading.Thread(target=keep_saying_hello, args=(worker, name, stop), daemon=True).start()
    print()
    say(f'Ready on {name}. Your antics videos will now be made on this PC.')
    say('Keep this window open (you can minimise it). Close it to stop.')
    first = True
    try:
        while True:
            try:
                if first:
                    worker.hello(name, starting=True)
                    first = False
                task = worker.next_task()
            except WorkerAsleep:
                say('Your worker is waking up, trying again in 20 seconds...')
                time.sleep(20)
                continue
            if not task:
                continue
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
        if comfy:
            comfy.terminate()


if __name__ == '__main__':
    main()
