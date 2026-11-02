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
COPY --chown=user . .

EXPOSE 7860
CMD ["uvicorn", "worker:app", "--host", "0.0.0.0", "--port", "7860"]
