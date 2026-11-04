FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt
# The speech model, so the first "Speak" doesn't wait for a download (if this fails, it downloads on first use).
RUN python -c "from faster_whisper.utils import download_model; download_model('base')" || true
# The pet voice, in steps of its own: if one fails, the videos are made without the voice (the page then
# doesn't offer it), and the build still works. Its packages are held to the versions installed above
# (-c), so they can never change what the worker itself needs.
# Kokoro's words-to-sounds: misaki (Apache-2.0) with spaCy and its small English model (MIT), no espeak.
RUN pip freeze > /tmp/worker-packages.txt \
    && pip install --no-cache-dir --user -c /tmp/worker-packages.txt onnxruntime misaki==0.9.4 "spacy>=3.8,<3.9" \
       num2words "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" \
    || true
# The voice model (Kokoro-82M, Apache-2.0, int8) and its two voices. If this fails, the worker tries once at start.
RUN python -c "from huggingface_hub import hf_hub_download as get; [get('onnx-community/Kokoro-82M-v1.0-ONNX', f, revision='1939ad2a8e416c0acfeecc08a694d14ef25f2231') for f in ('onnx/model_quantized.onnx', 'tokenizer.json', 'voices/am_fenrir.bin', 'voices/bm_george.bin')]" || true
# For names and slang: the 3 MB letters-to-sounds weights from the g2p_en wheel (Apache-2.0); g2p_en itself isn't installed.
RUN pip download --no-deps --no-cache-dir -d /tmp/g2p g2p_en==2.1.0 \
    && python -c "import glob, zipfile; z = zipfile.ZipFile(glob.glob('/tmp/g2p/*.whl')[0]); open('oov_g2p.npz', 'wb').write(z.read('g2p_en/checkpoint20.npz')); open('oov_g2p.LICENSE', 'wb').write(z.read('g2p_en-2.1.0.dist-info/LICENSE.txt'))" \
    && rm -rf /tmp/g2p || true
# (Sing) The singing side, each step on its own: if one fails, Sing runs without that piece (or isn't offered: the
# page then says "Update needed"), and the build still works. Held to the versions installed above (-c).
# Singing voices: WORLD (pyworld 0.3.5, MIT) has no Linux wheel: built with g++, which goes again in the same step
# (pyworld imports pkg_resources at run time, hence setuptools<81). Without it: Rubber Band (ffmpeg) voices.
USER root
RUN (apt-get update && apt-get install -y --no-install-recommends g++ \
     && su user -c 'pip install --no-cache-dir --user -c /tmp/worker-packages.txt "setuptools<81" pyworld==0.3.5'; \
     apt-get purge -y g++ && apt-get autoremove -y; rm -rf /var/lib/apt/lists/*) || true
USER user
# The sung lines: whisper-small (MIT, 463 MB; the base model loops on songs). If this fails, it downloads on first use.
RUN python -c "from faster_whisper.utils import download_model; download_model('small')" || true
# The quick voice/music split: Spleeter 2-stems (MIT weights) through sherpa-onnx (Apache-2.0), 43 MB + its 75 MB
# float32 model (downloaded here, or on first use).
RUN pip install --no-cache-dir --user -c /tmp/worker-packages.txt sherpa-onnx==2.0.1 || true
RUN mkdir -p /home/user/.cache/antics-models && cd /home/user/.cache/antics-models \
    && python -c "import urllib.request as u; u.urlretrieve('https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems.tar.bz2', 's.tar.bz2')" \
    && python -c "import tarfile; tarfile.open('s.tar.bz2').extractall('.', filter='data')" && rm s.tar.bz2 || true
# The best split (optional, about 1.1 GB): Kim's Mel-Band RoFormer (MIT) through audio-separator on torch-cpu; its
# 913 MB checkpoint downloads on first use. Without it, songs keep the quick split. audio-separator needs diffq,
# which has no wheel: built with g++, which goes again in the same step (as for pyworld). torch and torchvision are
# the CPU builds, pinned to each other (no resolver backtracking).
USER root
RUN (apt-get update && apt-get install -y --no-install-recommends g++ \
     && su user -c 'pip install --no-cache-dir --user -c /tmp/worker-packages.txt --extra-index-url https://download.pytorch.org/whl/cpu "torch==2.5.1+cpu" "torchvision==0.20.1+cpu" audio-separator==0.48.0'; \
     apt-get purge -y g++ && apt-get autoremove -y; rm -rf /var/lib/apt/lists/*) || true
USER user
COPY --chown=user . .

EXPOSE 7860
CMD ["uvicorn", "worker:app", "--host", "0.0.0.0", "--port", "7860"]
