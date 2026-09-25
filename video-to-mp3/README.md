# Video to MP3 (phone edition)

Turns videos on your phone into MP3 audio, right in the browser. Your videos are never uploaded.

**Open it:** <https://tendha2020-ai.github.io/account-shop/video-to-mp3/>
(served by GitHub Pages from the `main` branch, so it goes live once this folder is on `main`)

## Put it on your home screen

- **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, open the menu, then **Add to Home screen** (or **Install app**).

After the first visit it works offline.

## Use it

1. Tap **Choose videos** and pick one or more videos from Photos or Files.
2. Pick a quality: **128**, **192** (default) or **320 kbps**.
3. When a file is done, tap ▶ to preview it (tap the waveform to jump), then **Save MP3** or **Share**.

On iPhone, **Save MP3** puts the file in the Files app under Downloads. **Share** opens the share sheet, where
you can send it to an app or pick **Save to Files**. **Save all** saves every finished MP3 at once.

TikTok, Instagram or WhatsApp videos: save the video to your phone first (Share, then Save video), then
choose it here. A web page can't download straight from a TikTok link.

## What it converts

| Input | How it's read |
|---|---|
| iPhone videos (`.MOV`), TikTok/Instagram saves and screen recordings (`.MP4`), voice memos (`.M4A`), `.3GP` | Only the sound track is read from the file, so big videos don't have to fit in memory |
| WebM, MKV, MP3, WAV, OGG, FLAC and anything else the browser can play | Decoded by the browser |

Output is a constant-bitrate MP3 at 44.1 kHz, named after the video, with the video's name as the title tag.
Stereo stays stereo, mono stays mono, and surround sound is folded down to stereo.

## How it works

Everything runs in the page; there is no server.

| File | Job |
|---|---|
| `mp4.js` | Reads the MP4/MOV index and only the audio bytes (`File.slice`), then rewraps the sound for the browser's decoder: AAC as an audio-only `.m4a` (with `.aac`/ADTS as a second try), MP3 frames as-is, PCM as `.wav` |
| `convert.js` | Decodes with the Web Audio API at 44.1 kHz, encodes with LAME in short slices so the page stays responsive, adds the ID3 title, builds the `.zip` for Save all |
| `app.js` | The screen: queue, waveform display, preview playback, saving |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and the home-screen app |
| `lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) 1.2.1, a JavaScript port of [LAME](https://lame.sourceforge.io/), the MP3 encoder (LGPL-3.0, see `lame.LICENSE.txt`) |

When you change any file, bump `VERSION` in `sw.js` so installed copies pick up the new version.

## Limits

- Very long videos (over about half an hour) need a lot of memory and may not finish on older phones.
- The browser has to support the video's sound format. AAC, which almost every phone video uses, works on
  iPhone and Android. Rare formats may not.
