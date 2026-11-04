---
title: Animal Antics Worker
emoji: 🐾
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

Background worker for Animal Antics. It turns animal videos into funny clips where the
animal acts like a human, using the free Wan 2.2 model, and keeps the results in your
private `antics-videos` dataset. Set up and used from the Animal Antics page.

The pet voice uses Kokoro-82M (Apache-2.0) with misaki (Apache-2.0), spaCy (MIT) and g2p_en's letters-to-sounds
weights (Apache-2.0).

My songs: the owner's own songs are kept in `songs.json` and `songs/` in the same private dataset. When a song is
added, chorus.py finds its meme part (the chorus) on the worker's own CPU, with numpy and the listening half of the
Whisper "base" model the worker already has for speech; every video with that song starts there.

"Your video is ready" notifications use Web Push (webpush.py, with the cryptography package, Apache-2.0/BSD).
The worker's push key and the phones to notify are kept in `push.json` in the same private dataset.

The Posting plan (posting.py) is kept in `posting.json` in the same private dataset: the queue of videos to post,
when to remind (1-3 times a day, in the owner's time zone; the `tzdata` package has the time zones), the hashtags,
and which reminders already went. The owner posts by hand with Share to TikTok. A video made with the owner's own
song is shared as its TikTok cut, `tiktok.mp4` (the same video without the song, cut on the worker's CPU), and
TikTok's own sound is added when posting. If the cut can't be made, the plan offers the video as it was made.
The cut is deleted again once the video is posted, skipped or taken out of the plan.

If one of these files (`guests.json`, `push.json`, `songs.json`, `posting.json`, or a video's `job.json`) can't be
read from the Hub when the worker starts, it is never saved over, and the worker reads it again every minute.
Meanwhile the friends, notifications, songs or plan answer "still loading" (503), and that video doesn't show yet.

Together videos (together.py): 2-4 animals in one video. Their pictures are put into one start picture by a free
composer Space (FLUX 3 Image Klein, FLUX Kommunity License: free for creators under US$5M revenue when each picture
is checked before posting and the video is labelled as AI; else FLUX.2 klein 4B, Apache-2.0), then animated as usual.
The free looks (side by side, VS screen, grid, quick cuts) are made on this Space's CPU from the real clips. The free
clip library (library.json) lists only CC0, public domain and CC BY clips; their credit lines go in the caption
("Clip (edited): ..." for CC BY, as the licence asks).
A Together video in the posting plan carries its clips' credit lines in its caption too (also when the owner
writes their own), and #aivideo only when AI made any of it.

Sing videos (sing.py, sing_audio.py): one or two animals sing a song from My songs. Each song is made ready to sing
once, on this Space's CPU, and kept next to it in the same private dataset (`songs/<id>.sing/`: the voice and the
music split apart, and `sing.json` with the sung lines' times, never their words): the quick split with Spleeter
2-stems (MIT weights, through sherpa-onnx, Apache-2.0), then the best one with Kim's Mel-Band RoFormer (MIT, through
audio-separator on torch-cpu) when it is installed; the lines with faster-whisper `small` (MIT). The animals' voices
are WORLD (pyworld, MIT), or Rubber Band without it. The stage pictures come from Together's free composer engines,
the singing from free lip-sync Spaces (LongCat-Video-Avatar 1.5, MIT; LTX-2 audio-to-video, LTX-2 Community License:
free under US$10M revenue, machine-generated content disclosed; Kandinsky S2V, MIT) or the owner's own PC
(InfiniteTalk, Apache-2.0; with its duet model, the lines both animals sing are one two-shot). Every ZeroGPU call
goes through the GPU guard (gpu.py) inside the free time, and Sing
keeps to its share of the day (`sing_settings.json`, with each engine's 5-second test result). Without the guard,
Sing makes no AI call at all. No song, stem or lyric is ever part of this Space or the app: they stay in the
owner's private dataset.
