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

The GPU guard (gpu.py) makes sure antics only uses your free ZeroGPU time and never your money. On Hugging Face PRO,
ZeroGPU use past the daily free time is billed to pre-paid credits by itself, so before and after every ZeroGPU call
(one at a time) the worker reads your quota (`/api/spaces/zero-gpu/quota`, with your own key). A call goes only if
what is left covers what the Space books for that picture plus 30 s. If paid seconds ever show up, all AI work stops
until you tap Resume in Settings; the stop is kept in `gpu.json` in the same private dataset, with a note of the call
running right now (a worker restarted mid-call waits for it). A call that takes too long, or fails in a way that
may leave it running in the Space (a slow answer, a proxy error page), is cancelled and stays counted for 30 min, so
the next engine never runs next to it uncounted. If your key can't read the quota and your account could be charged
(PRO, Team, Enterprise), the worker makes no AI calls until it can, and Settings says so; a free account goes on with
an estimate.

If one of these files (`guests.json`, `push.json`, `songs.json`, `posting.json`, `gpu.json`, `access.json`, or a video's `job.json`) can't be
read from the Hub when the worker starts, it is never saved over, and the worker reads it again every minute.
Meanwhile the friends, notifications, songs, plan or access requests answer "still loading" (503), and that video doesn't show yet.

Ask for access (access.py): antics is the owner's private tool. A stranger who opens the page can only ask for access
with their name and a short note (`POST /access/request`, only from antics' own page when a browser sends it). Limits:
3 a day from one place (counted by the first and by the last public X-Forwarded-For address, IPv6 by its /48), 10 new
requests a day in all, 20 waiting in all; each refusal says why. The owner gets a notification (at most one every 10
minutes: requests that come meanwhile are sent together) and taps Approve (5, 6 or 10 videos: they become a friend, on
the owner's free AI time only), Deny, or "Say no to all". The same person asking again from the same place with the same
name is the same request; a request named like one of the friends can be let in as that friend again. The requests are
kept in `access.json` in the same private dataset: the name, the note, the time, the answer, the sha256 of the
requester's secret token(s), and a salted hash of where the request came from (never the address; kept only a day, or
until a waiting request is dropped). A waiting request is dropped after 3 days, a decided one after 14 days (an approved
one stays while its friend does). The Space's log never shows a token, a key or a visitor's address.

Together videos (together.py): 2-4 animals in one video. Their pictures are put into one start picture by a free
composer Space (FLUX 3 Image Klein, FLUX Kommunity License: free for creators under US$5M revenue when each picture
is checked before posting and the video is labelled as AI; else FLUX.2 klein 4B, Apache-2.0), then animated as usual.
The composer is a ZeroGPU call like the clips, so it goes through the GPU guard too, booked at what that Space
books for those pictures; when the free time is used up the video waits, and its card offers the free look now.
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
