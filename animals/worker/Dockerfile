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
COPY --chown=user . .

EXPOSE 7860
CMD ["uvicorn", "worker:app", "--host", "0.0.0.0", "--port", "7860"]
