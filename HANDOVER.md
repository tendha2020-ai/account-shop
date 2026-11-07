# Glow Studio: developer handover

Branch: `claude/glow-studio` · Draft PR: https://github.com/tendha2020-ai/account-shop/pull/16 · Windows app: `downloads/GlowStudio.exe`

Glow Studio has two modes:
- **AI Scenes:** turns one selfie and a preset scene into an AI video of that person.
- **Photo Video:** beat-synced photo templates.

It runs as a static web app in `glow/`. The Windows launcher in `desktop/` (Go, standard library only) adds a free local AI engine (ComfyUI) on the user's NVIDIA GPU.

**Status: confirmed working on real hardware** (RTX 5060 Ti 8 GB, 32 GB RAM). The 20 s Concert and Leaving the Club stories came out as 720×1248 video with sound and the burned-in label.

## Layout
| Path | What it is |
|---|---|
| `glow/index.html`, `ai.js`, `ai.css` | AI Scenes UI, pipelines, finishing (stitch, music, burned-in "AI-generated" label), IndexedDB history, resume |
| `glow/scenes.json`, `scenes.js` | Preset scene data and the deterministic prompt composition, shared with the Go launcher |
| `glow/local-engine.js` | `window.GlowLocalAI`: ComfyUI client and graphs (`generate`, `generateStory`, `resume`, `hold`/`release`, `cleanup`) |
| `glow/engine.html`, `engine-ui.js`, `engine.css` | Setup wizard: checks the GPU, driver and disk; resumable install; repair; logs |
| `glow/beat.js` | `GlowBeat.analyze`: tempo and beat tracking for "Sync to my song" |
| `glow/share.js`, `guest.js`, `qr.js` | Share with friends: host panel, guest page, QR encoder |
| `glow/app.js`, `templates.js`, `music.js` | Photo Video mode and 8 procedurally generated music tracks |
| `desktop/*.go` | Launcher, listed below |

The launcher (`desktop/*.go`):
- Serves `glow/` on 127.0.0.1:47821 and opens an Edge/Chrome app window.
- Installs ComfyUI portable v0.44.0 and its models (`models.go`: pinned Hugging Face URLs and sha256).
- Proxies ComfyUI under `/__glow/comfy/*`, and exposes `/__glow/engine/*` and `/__glow/share/*`.
- Runs the guest server (`guest*.go`), cloudflared tunnel management (`tunnel.go`) and same-Wi-Fi mode (`lan.go`).
- Writes logs to `%LOCALAPPDATA%\GlowStudio\logs`.

## Build and test
- `sh desktop/build.sh` builds `downloads/GlowStudio.exe`. It embeds `glow/`, so rebuild after any web change.
- `sh desktop/test.sh` runs `go vet` (Linux and Windows) and the Go tests. They pass, including with `-race`.
- There's no npm and no build step: the web files are plain classic scripts. The full browser end-to-end suites (Playwright, the real Linux launcher with a mock ComfyUI) lived in the session scratch space and aren't in the repo. Recreating a small version is worthwhile.

## Engines and models
**Local** (all Apache-2.0 or MIT):
- Still image: Qwen-Image-Edit-2511 with the 4-step Lightning LoRA.
- Video: Wan 2.2 I2V A14B fp8 with lightx2v 4-step LoRAs, 480×832, 81 frames at 16 fps, then RIFE ×2.
- Singing add-on: ACE-Step 1.5 song plus Wan2.2-S2V lip-sync, single 4.8 s chunks.
- Fast pack: FLUX.2 klein 4B.
- Install size: core 71 GB, singing 28 GB, fast 12.5 GB.

**Cloud:** fal.ai with the user's own key, kept in localStorage. It uses the queue API with never-pay-twice resume.

**Stories:** 1, 2 or 4 shots of about 5 s each. The model can't make longer clips with good quality or within 8 GB of VRAM. Order of work: all stills, then the song, then the videos, then lip-sync. Finishing stitches the clips on beats with one continuous soundtrack.

## Responsible-use rules (keep them)
- Preset scenes only.
- A consent checkbox for every photo, including that the person is 18 or older.
- The "AI-generated" label is always burned in.
- Moderation refusals are shown to the user, never bypassed.
- Original music and lyrics only.
- For guests, the launcher builds every graph itself from `scenes.json` and composites the label inside the ComfyUI graph.

## Known issues / next steps
1. **Consistency across shots:** the outfit and the face drift between shots, as seen in the real outputs. Fix: generate shots 2–4 from shot 1's still (or pass it as a second reference image to Qwen-Edit), and add "same outfit" to the prompts.
2. **Garbled sign text and unrequested props** (neon letters, headphones): add "blank signs, no readable text, no headphones" to the negative and positive prompts.
3. **Requested but not built:** a "one continuous take" mode. Each 5 s piece starts from the previous piece's last frame, with no cuts.
4. **Not yet run for real:** the cloudflared link, same-Wi-Fi sharing, iPhone Safari, real fal.ai generations, and the Windows firewall and power prompts.
5. **Signing:** the exe is unsigned, so SmartScreen warns on first launch. Code signing is recommended.
6. **Two labels on guest videos:** they come out with two different-looking AI labels (pixel font from the PC, smooth from the browser). Unify them.
7. **Merging:** the PR is still a draft. Merging it to `main` publishes `glow/` on GitHub Pages.
