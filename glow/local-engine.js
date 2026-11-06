/* Glow Studio — free local AI engine client (local-engine.js) -> window.GlowLocalAI
 *
 * Talks to the Glow Studio Windows launcher, which installs and runs a private ComfyUI (v0.44.0 portable) on this PC
 * and exposes it under the page's own origin:
 *   /__glow/engine/{status,install,cancel,start,stop,cleanup}   launcher endpoints (JSON)
 *   /__glow/comfy/<path>                               reverse proxy to ComfyUI (incl. WebSocket /__glow/comfy/ws)
 * On the public website those paths do not exist, so detect() resolves null ("local engine unavailable").
 *
 * Pipeline per video (all stock ComfyUI nodes, graphs copied from the researched spec):
 *   selfie -> POST /upload/image (input/glow/selfie_<job>.jpg)
 *     -> still: Qwen-Image-Edit-2511 + Lightning 4-step, 720x1248   (or FLUX.2 klein 4B when quality 'fast' + 'fast' pack)
 *     -> song (optional, 'singing' pack): ACE-Step 1.5 turbo, Spanish lyrics -> mp3
 *     -> video: Wan 2.2 I2V A14B fp8 + lightx2v 4-step, 480x832x81 @16 fps + RIFE x2 -> 32 fps mp4   (fast: 384x672)
 *        or, singing with lip-sync: Wan2.2-S2V 14B, one 77-frame chunk with the song muxed in
 *     -> GET /view for every output (file names are always read from /history, never assumed)
 * Progress comes over the ComfyUI WebSocket; GET /history/<id> is polled every 2 s whenever the socket is not open
 * (and every few seconds as a safety net when it is). The running job is kept in localStorage so a reload can
 * re-attach with GlowLocalAI.resume(). With {keep: true} the record (and the engine's files) stay until
 * GlowLocalAI.release(job), so a page can fetch the outputs again if its own finishing step is interrupted.
 * Privacy: once a video is handed over (or cancelled, discarded, failed), the launcher deletes the selfie copy and
 * the unlabelled outputs ComfyUI kept for it, and ComfyUI forgets the prompts (POST /__glow/engine/cleanup).
 *
 * Stories (several shots from ONE selfie, see generateStory below): all stills first (one photo-model load), then the
 * AI song if any, then the dance videos, then every lip-sync shot (each one verified single S2V chunk driven by its own
 * segment of the soundtrack) — so the big models are loaded once each on an 8 GB card with 32 GB of RAM.
 *
 * While a job runs the page asks the launcher to stay up (POST /__glow/engine/hold), so a hidden or sleeping window
 * (no pings) never lets the launcher quit in the middle of a long story; the hold ends with the job.
 *
 * Classic script, no dependencies. Test hooks: window.__GLOW_LOCALAI_TEST__ = { historyPollMs, safetyPollMs,
 * statusPollMs, wsConnectMs, readyTimeoutMs, noWebSocket, forceProbe }.
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var ENGINE = '/__glow/engine';
  var COMFY = '/__glow/comfy';
  var LS_JOB = 'glow.localai.job';
  var T = (window.__GLOW_LOCALAI_TEST__ && typeof window.__GLOW_LOCALAI_TEST__ === 'object') ? window.__GLOW_LOCALAI_TEST__ : {};
  var CFG = {
    historyPollMs: T.historyPollMs || 2000,     // /history polling when the WebSocket is not open
    safetyPollMs: T.safetyPollMs || 6000,       // /history polling while the WebSocket is open (lost-message safety net)
    statusPollMs: T.statusPollMs || 1000,       // /__glow/engine/status polling in waitReady()
    wsConnectMs: T.wsConnectMs || 4000,         // give up on the WebSocket after this and poll instead
    readyTimeoutMs: T.readyTimeoutMs || 6 * 60 * 1000,
    stoppedGraceMs: T.stoppedGraceMs || 15000,  // 'stopped' right after start() is tolerated this long
    maxJobAgeMs: 12 * 3600 * 1000
  };

  /* ------------------------------------------------------------------ *
   * Packs, sizes and timings (from the spec: models[] sizeGB, verdict, timings)
   * ------------------------------------------------------------------ */
  // core = 69.0 GB of models + 2.05 GB portable engine; singing = ACE-Step 1.5 + Wan2.2-S2V (28.3 GB); fast = FLUX.2 klein 4B (12.5 GB)
  var PACKS = [
    { id: 'core', label: 'Dance & party scenes', sizeGB: 71.1, required: true,
      desc: 'Puts you into a party hall, a club or a party with friends and turns it into a 5-second dancing video.' },
    { id: 'singing', label: 'Singing add-on', sizeGB: 28.3, experimental: true,
      desc: 'Writes a short Spanish party song and makes you sing it. Experimental and slow: one singer, lip-sync is approximate.' },
    { id: 'fast', label: 'Fast mode', sizeGB: 12.5,
      desc: 'A lighter photo step and a smaller video for quicker results. The face can look a little less like you.' }
  ];
  var PACK_IDS = PACKS.map(function (p) { return p.id; });

  // Minutes per video, desktop RTX 5060 (warm) and laptop RTX 5060 (+20-40 %). Estimates from the spec, not benchmarks.
  var ESTIMATES = {
    best:          { desktop: [5, 8],   laptop: [7, 10] },  // Qwen still + Wan 480x832x81 + RIFE
    fast:          { desktop: [2.5, 4], laptop: [3, 5.5] }, // FLUX.2 klein still + Wan 384x672x81
    fastNoPack:    { desktop: [3.5, 6], laptop: [4.5, 8] }, // Qwen still + Wan 384x672x81
    sing:          { desktop: [7, 10],  laptop: [9, 14] },  // still + song + one S2V lip-sync chunk
    songBest:      { desktop: [6, 10],  laptop: [8, 13] },  // dance video + song as soundtrack
    songFast:      { desktop: [3, 5.5], laptop: [4, 7.5] }
  };
  // Expected seconds per stage (desktop, middle of the range) — used for the overall bar and when only polling works.
  var STAGE_SEC = { starting: 60, upload: 3, stillQwen: 80, stillKlein: 25, song: 60, video: 270, videoFast: 165, s2v: 345, download: 5 };

  // Every file the launcher may download, with a plain-words name for the setup wizard.
  var FILES = {
    'ComfyUI_windows_portable_nvidia.7z': 'AI engine',
    '7zr.exe': 'Unpacking tool',
    'qwen_image_edit_2511_int8_convrot.safetensors': 'Photo model',
    'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors': 'Photo speed-up',
    'qwen_2.5_vl_7b_fp8_scaled.safetensors': 'Photo understanding',
    'qwen_image_vae.safetensors': 'Photo finisher',
    'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors': 'Video model, part 1',
    'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors': 'Video model, part 2',
    'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors': 'Video speed-up, part 1',
    'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors': 'Video speed-up, part 2',
    'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'Video understanding',
    'wan_2.1_vae.safetensors': 'Video finisher',
    'rife_v4.26.safetensors': 'Smooth motion',
    'flux-2-klein-4b-fp8.safetensors': 'Fast photo model',
    'qwen_3_4b.safetensors': 'Fast photo understanding',
    'flux2-vae.safetensors': 'Fast photo finisher',
    'acestep_v1.5_turbo.safetensors': 'Song model',
    'qwen_0.6b_ace15.safetensors': 'Song lyrics reader',
    'qwen_1.7b_ace15.safetensors': 'Song planner',
    'ace_1.5_vae.safetensors': 'Song finisher',
    'wan2.2_s2v_14B_fp8_scaled.safetensors': 'Singing video model',
    'wav2vec2_large_english_fp16.safetensors': 'Voice listener',
    'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors': 'Singing speed-up'
  };

  /* ------------------------------------------------------------------ *
   * ComfyUI API graphs — copied exactly from the spec (local-ai-spec.json "graphs"), placeholders <<LIKE_THIS>>.
   * Class and input names verified against ComfyUI v0.44.0 source.
   * ------------------------------------------------------------------ */
  var NEG_WAN = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';
  var TEMPLATES = {
    // (1) DEFAULT STILL — Qwen-Image-Edit-2511 int8 + Lightning 4-step -> 720x1248. Output: outputs["14"].images[0]
    stillQwen: {
      "1": {"class_type": "LoadImage", "inputs": {"image": "<<SELFIE>>"}},
      "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2511_int8_convrot.safetensors", "weight_dtype": "default"}},
      "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
      "4": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
      "5": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["2", 0], "shift": 3.1}},
      "6": {"class_type": "CFGNorm", "inputs": {"model": ["5", 0], "strength": 1.0}},
      "7": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["6", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
      "8": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["3", 0], "prompt": "<<SCENE_PROMPT>>", "vae": ["4", 0], "image1": ["1", 0]}},
      "9": {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["8", 0], "reference_latents_method": "index_timestep_zero"}},
      "10": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["9", 0]}},
      "11": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 720, "height": 1248, "batch_size": 1}},
      "12": {"class_type": "KSampler", "inputs": {"model": ["7", 0], "seed": "<<SEED>>", "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["9", 0], "negative": ["10", 0], "latent_image": ["11", 0], "denoise": 1.0}},
      "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["4", 0]}},
      "14": {"class_type": "SaveImage", "inputs": {"images": ["13", 0], "filename_prefix": "glow/<<JOB>>_still"}}
    },
    // (2) FALLBACK STILL — FLUX.2 klein 4B distilled fp8, 4 steps. Output: outputs["18"].images[0]
    stillKlein: {
      "1": {"class_type": "LoadImage", "inputs": {"image": "<<SELFIE>>"}},
      "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-4b-fp8.safetensors", "weight_dtype": "default"}},
      "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "flux2", "device": "default"}},
      "4": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
      "5": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["1", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 1}},
      "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0], "vae": ["4", 0]}},
      "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": "<<SCENE_PROMPT>>"}},
      "8": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["7", 0]}},
      "9": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["7", 0], "latent": ["6", 0]}},
      "10": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["8", 0], "latent": ["6", 0]}},
      "11": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": 720, "height": 1248, "batch_size": 1}},
      "12": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": 720, "height": 1248}},
      "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": "<<SEED>>"}},
      "14": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
      "15": {"class_type": "CFGGuider", "inputs": {"model": ["2", 0], "positive": ["9", 0], "negative": ["10", 0], "cfg": 1.0}},
      "16": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["13", 0], "guider": ["15", 0], "sampler": ["14", 0], "sigmas": ["12", 0], "latent_image": ["11", 0]}},
      "17": {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["4", 0]}},
      "18": {"class_type": "SaveImage", "inputs": {"images": ["17", 0], "filename_prefix": "glow/<<JOB>>_still"}}
    },
    // (3) VIDEO — Wan 2.2 I2V A14B fp8 + lightx2v 4-step (2+2), 480x832x81 @16 fps, RIFE x2 -> 32 fps. Output: outputs["19"].images[0]
    video: {
      "1": {"class_type": "LoadImage", "inputs": {"image": "<<STILL>>"}},
      "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
      "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "<<MOTION_PROMPT>>"}},
      "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG_WAN}},
      "5": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
      "6": {"class_type": "WanImageToVideo", "inputs": {"positive": ["3", 0], "negative": ["4", 0], "vae": ["5", 0], "width": 480, "height": 832, "length": 81, "batch_size": 1, "start_image": ["1", 0]}},
      "7": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "weight_dtype": "default"}},
      "8": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "weight_dtype": "default"}},
      "9": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["7", 0], "lora_name": "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", "strength_model": 1.0}},
      "10": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["8", 0], "lora_name": "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", "strength_model": 1.0}},
      "11": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["9", 0], "shift": 5.0}},
      "12": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["10", 0], "shift": 5.0}},
      "13": {"class_type": "KSamplerAdvanced", "inputs": {"model": ["11", 0], "add_noise": "enable", "noise_seed": "<<SEED>>", "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["6", 0], "negative": ["6", 1], "latent_image": ["6", 2], "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"}},
      "14": {"class_type": "KSamplerAdvanced", "inputs": {"model": ["12", 0], "add_noise": "disable", "noise_seed": 0, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["6", 0], "negative": ["6", 1], "latent_image": ["13", 0], "start_at_step": 2, "end_at_step": 4, "return_with_leftover_noise": "disable"}},
      "15": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["5", 0]}},
      "16": {"class_type": "FrameInterpolationModelLoader", "inputs": {"model_name": "rife_v4.26.safetensors"}},
      "17": {"class_type": "FrameInterpolate", "inputs": {"interp_model": ["16", 0], "images": ["15", 0], "multiplier": 2}},
      "18": {"class_type": "CreateVideo", "inputs": {"images": ["17", 0], "fps": 32.0}},
      "19": {"class_type": "SaveVideo", "inputs": {"video": ["18", 0], "filename_prefix": "glow/<<JOB>>_clip", "format": "mp4", "format.codec": "auto"}}
    },
    // (4) SONG — ACE-Step 1.5 turbo, 8 steps, Spanish lyrics. Output: outputs["10"].audio[0]
    song: {
      "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "acestep_v1.5_turbo.safetensors", "weight_dtype": "default"}},
      "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "qwen_0.6b_ace15.safetensors", "clip_name2": "qwen_1.7b_ace15.safetensors", "type": "ace", "device": "default"}},
      "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ace_1.5_vae.safetensors"}},
      "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.0}},
      "5": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": {"clip": ["2", 0], "tags": "<<SONG_TAGS>>", "lyrics": "<<LYRICS_ES>>", "seed": "<<SEED>>", "bpm": 100, "duration": 20.0, "timesignature": "4", "language": "es", "keyscale": "A minor", "generate_audio_codes": true, "cfg_scale": 2.0, "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0}},
      "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
      "7": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": 20.0, "batch_size": 1}},
      "8": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "seed": "<<SEED>>", "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0], "denoise": 1.0}},
      "9": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
      "10": {"class_type": "SaveAudioMP3", "inputs": {"audio": ["9", 0], "filename_prefix": "glow/<<JOB>>_song", "quality": "V0"}}
    },
    // (5) LIP-SYNC — Wan2.2-S2V 14B fp8 + 4-step LoRA, one 77-frame chunk (4.81 s @16 fps) with the song muxed. Output: outputs["17"].images[0]
    s2v: {
      "1": {"class_type": "LoadImage", "inputs": {"image": "<<STILL>>"}},
      "2": {"class_type": "LoadAudio", "inputs": {"audio": "<<SONG>>"}},
      "3": {"class_type": "TrimAudioDuration", "inputs": {"audio": ["2", 0], "start_index": "<<SONG_OFFSET_S>>", "duration": 5.0}},
      "4": {"class_type": "AudioEncoderLoader", "inputs": {"audio_encoder_name": "wav2vec2_large_english_fp16.safetensors"}},
      "5": {"class_type": "AudioEncoderEncode", "inputs": {"audio_encoder": ["4", 0], "audio": ["3", 0]}},
      "6": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
      "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["6", 0], "text": "<<SING_PROMPT>>"}},
      "8": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["6", 0], "text": NEG_WAN}},
      "9": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
      "10": {"class_type": "WanSoundImageToVideo", "inputs": {"positive": ["7", 0], "negative": ["8", 0], "vae": ["9", 0], "width": 480, "height": 832, "length": 77, "batch_size": 1, "audio_encoder_output": ["5", 0], "ref_image": ["1", 0]}},
      "11": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_s2v_14B_fp8_scaled.safetensors", "weight_dtype": "default"}},
      "12": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["11", 0], "lora_name": "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors", "strength_model": 1.0}},
      "13": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["12", 0], "shift": 8.0}},
      "14": {"class_type": "KSampler", "inputs": {"model": ["13", 0], "seed": "<<SEED>>", "steps": 4, "cfg": 1.0, "sampler_name": "uni_pc", "scheduler": "simple", "positive": ["10", 0], "negative": ["10", 1], "latent_image": ["10", 2], "denoise": 1.0}},
      "15": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["9", 0]}},
      "16": {"class_type": "CreateVideo", "inputs": {"images": ["15", 0], "fps": 16.0, "audio": ["3", 0]}},
      "17": {"class_type": "SaveVideo", "inputs": {"video": ["16", 0], "filename_prefix": "glow/<<JOB>>_sing", "format": "mp4", "format.codec": "auto"}}
    }
  };
  var OUTPUT_NODE = { stillQwen: '14', stillKlein: '18', video: '19', song: '10', s2v: '17' };
  deepFreeze(TEMPLATES);

  // ACE-Step 1.5 combos (comfy_extras/nodes_ace.py, v0.44.0)
  var ACE_LANGS = ['ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh', 'unknown'];
  var ACE_KEYS = (function () {
    var out = [];
    ['major', 'minor'].forEach(function (q) {
      ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].forEach(function (r) { out.push(r + ' ' + q); });
    });
    return out;
  })();
  var DEFAULT_SONG_TAGS = 'latin pop, reggaeton beat, festive party anthem, group chorus, female and male vocals, Spanish';
  var DEFAULT_LYRICS = '[Verse]\nEsta noche brilla la ciudad\nlas luces bailan sin parar\ntodos mis amigos aquí están\nnadie se quiere ir a casa ya\n\n[Chorus]\nBaila, baila, ven aquí\nla fiesta empieza hoy por ti\ncanta fuerte, canta así\nesta noche es para vivir';
  var DEFAULT_SING_PROMPT = 'The person sings passionately to the camera with friends singing and swaying around them at a lively party, fairy lights, realistic.';

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function now() { return Date.now(); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function delay(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      var t = setTimeout(done, ms);
      function done() { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function abortError() {
    try { return new DOMException('The job was cancelled.', 'AbortError'); } catch (e) { var er = new Error('The job was cancelled.'); er.name = 'AbortError'; return er; }
  }
  function isAbort(e) { return !!e && e.name === 'AbortError'; }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randomSeed() {
    // 0 .. 2^53-1 (the spec requires JS-safe seeds)
    var a = new Uint32Array(2);
    window.crypto.getRandomValues(a);
    return (a[0] % 2097152) * 4294967296 + a[1];
  }
  function newJobId() { return 'g' + now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function safeJob(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || newJobId(); }
  function safeCall(fn, arg) { if (typeof fn === 'function') { try { fn(arg); } catch (e) { /* a UI error must never break the job */ } } }

  function LocalAIError(code, message, detail) {
    var e = new Error(message);
    e.name = 'GlowLocalAIError';
    e.code = code;
    if (detail != null) e.detail = detail;
    return e;
  }
  var MSG = {
    unavailable: 'Free AI on this PC needs the Glow Studio app for Windows.',
    network: 'Lost the connection to the AI engine on this PC. Make sure Glow Studio is still open, then try again.',
    notInstalled: 'Free AI isn’t fully set up on this PC. Open “Free AI on this PC” to finish setting it up (only missing files are downloaded).',
    missingPack: 'The Singing add-on isn’t installed yet. Add it in “Free AI on this PC”.',
    engineFailed: 'The AI engine couldn’t start. Open “Free AI on this PC” for details, or restart your PC and try again.',
    engineStopped: 'The AI engine stopped. Try again — Glow Studio starts it again by itself.',
    readyTimeout: 'The AI engine is taking too long to start. Close other heavy apps and try again.',
    busy: 'A video is already being made on this PC. Please wait for it to finish.',
    installBusy: 'A download is already running.',
    oom: 'Your PC ran out of graphics memory. Close games, video apps and extra browser tabs, then try again — or switch to Fast mode.',
    missingModel: 'Some AI files are missing or damaged. Press “Check & repair files” to fix them — only what is damaged is downloaded again.',
    driver: 'Your NVIDIA driver is too old for the AI engine. Press “Update NVIDIA driver”, install the update and restart your PC, then try again.',
    vcredist: 'Windows is missing a free Microsoft component the AI engine needs (Visual C++ Redistributable). Press “Get the Microsoft component”, install it, then try again.',
    outputGone: 'The finished files are no longer on this PC. Please make the video again — it’s free.',
    badPhoto: 'This photo couldn’t be used. Please try another photo (JPEG or PNG).',
    missingStill: 'The picture from the first step is missing. Please start the video again.',
    interrupted: 'The video was stopped before it was finished.',
    lost: 'The AI engine restarted, so this video was lost. Please try again.',
    failed: 'Something went wrong while making the video. Please try again.',
    rejected: 'The AI engine didn’t accept this job. Press “Check & repair files” to check the AI files.',
    download: 'The finished video couldn’t be loaded from the AI engine. Please try again.',
    badAudio: 'This song file couldn’t be read. Please try another file (MP3, M4A, WAV or OGG).',
    audioShort: 'Your song is too short for this video. Pick an earlier start point or a longer song.',
    needSong: 'Lip-sync needs a song: choose the AI song or your own song.',
    twoSongs: 'Choose either the AI song or your own song, not both.',
    shots: 'A story needs 1 to 4 shots, each with a scene description.'
  };

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */
  function request(method, path, body, opt) {
    opt = opt || {};
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null, onAbort = null;
    if (ctl && opt.timeout) timer = setTimeout(function () { ctl.abort(); }, opt.timeout);
    if (ctl && opt.signal) {
      if (opt.signal.aborted) ctl.abort();
      onAbort = function () { ctl.abort(); };
      opt.signal.addEventListener('abort', onAbort, { once: true });
    }
    var init = { method: method, cache: 'no-store', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined, headers: {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      cleanup();
      return res;
    }, function (err) {
      cleanup();
      if (opt.signal && opt.signal.aborted) throw abortError();
      throw LocalAIError('network', MSG.network, String(err && err.message || err));
    });
    function cleanup() { if (timer) clearTimeout(timer); if (onAbort) opt.signal.removeEventListener('abort', onAbort); }
  }
  function readJSON(res) {
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('json') < 0) return res.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } });
    return res.json().catch(function () { return null; });
  }
  function engineError(res, data, fallbackCode, fallbackMsg) {
    var server = data && (typeof data.error === 'string' ? data.error : data.error && data.error.message);
    if (res.status === 404) return LocalAIError('unavailable', MSG.unavailable, 'HTTP 404');
    if (res.status === 409) return LocalAIError('busy', server || MSG.installBusy, 'HTTP 409');
    return LocalAIError(fallbackCode, server || fallbackMsg, 'HTTP ' + res.status);
  }

  /* ------------------------------------------------------------------ *
   * Launcher endpoints
   * ------------------------------------------------------------------ */
  var lastStatus = null;
  function isLoopbackPage() {
    if (T.forceProbe) return true;
    var h = (location.hostname || '').toLowerCase();
    return location.protocol === 'http:' && (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1');
  }
  function isStatus(s) {
    return !!s && typeof s === 'object' && typeof s.launcher === 'string' && !!s.engine && typeof s.engine.state === 'string' && !!s.packs && typeof s.packs === 'object';
  }
  function getStatus(opt) {
    if (!isLoopbackPage()) return Promise.reject(LocalAIError('unavailable', MSG.unavailable, 'not served by the desktop launcher'));
    var refresh = !!(opt && opt.refresh); // "Check again": the launcher asks the graphics driver afresh (waits up to ~6 s)
    return request('GET', ENGINE + '/status' + (refresh ? '?refresh=1' : ''), undefined, { timeout: (opt && opt.timeout) || (refresh ? 15000 : 8000), signal: opt && opt.signal }).then(function (res) {
      if (!res.ok) throw LocalAIError('unavailable', MSG.unavailable, 'HTTP ' + res.status);
      return readJSON(res).then(function (s) {
        if (!isStatus(s)) throw LocalAIError('unavailable', MSG.unavailable, 'not a launcher status');
        lastStatus = s;
        return s;
      });
    });
  }
  // null on the website (no launcher), or when the launcher does not answer
  function detect() {
    // The launcher only ever serves on loopback, so the public website does not even ask (no 404 noise).
    if (!isLoopbackPage()) return Promise.resolve(null);
    // A launcher that is busy for a moment (just started, PC waking up) gets a second chance; a page without the
    // launcher endpoints (404 / not a status) does not.
    return getStatus({ timeout: 5000 }).catch(function (e) {
      if (!e || e.code !== 'network') return null;
      return delay(700).then(function () { return getStatus({ timeout: 5000 }); }).catch(function () { return null; });
    });
  }
  // status({refresh: true}) also re-checks the graphics card (for "Check again" after a driver update);
  // status({timeout: ms}) waits that long for an answer (default 8 s; the setup page uses 15 s while it downloads).
  function status(opt) {
    opt = opt || {};
    var o = {};
    if (opt.refresh) o.refresh = true;
    if (num(opt.timeout, 0) > 0) o.timeout = num(opt.timeout, 0);
    return getStatus(o.refresh || o.timeout ? o : undefined);
  }

  function normPacks(packs) {
    var list = Array.isArray(packs) ? packs : (typeof packs === 'string' ? [packs] : []);
    var out = ['core'];
    list.forEach(function (p) { if (PACK_IDS.indexOf(p) >= 0 && out.indexOf(p) < 0) out.push(p); });
    return out;
  }
  function postEngine(path, body, code, msg) {
    return request('POST', ENGINE + path, body === undefined ? {} : body, { timeout: 15000 }).then(function (res) {
      return readJSON(res).then(function (data) {
        if (!res.ok) throw engineError(res, data, code, msg);
        return data || { ok: true };
      });
    });
  }
  // opt.repair: "Check & repair files" — the launcher re-checks every file (and the unpacked engine) and fetches
  // again what is damaged; it stops the engine first (409 while a video is being made).
  function install(packs, installDir, opt) {
    var body = { packs: normPacks(packs) };
    if (typeof installDir === 'string' && installDir.trim()) body.installDir = installDir.trim();
    if (opt && opt.repair) body.repair = true;
    return postEngine('/install', body, 'install-failed', 'The download couldn’t start. Please try again.');
  }
  function cancel() { return postEngine('/cancel', {}, 'cancel-failed', 'The download couldn’t be paused.'); }
  function start() { return postEngine('/start', {}, 'engine-failed', MSG.engineFailed); }
  function stop() { return postEngine('/stop', {}, 'stop-failed', 'The AI engine couldn’t be stopped.'); }
  // Opens the launcher's log folder in File Explorer. Resolves {ok, opened, dir} (opened is false off Windows).
  function openLogs() { return postEngine('/open-logs', {}, 'open-logs-failed', 'The log folder couldn’t be opened.'); }

  // e.code: 'vcredist' (missing Microsoft component), 'driver' (old NVIDIA driver), 'missing-model' (engine files
  // damaged: "Check & repair files"), else 'engine-failed'. The launcher's own plain sentence wins over the log patterns
  // (it knows, e.g., that a "c10.dll" error means a removed file rather than a missing component).
  function engineErrorFrom(s) {
    var log = (s && s.engine && s.engine.log) || [];
    var err = String((s && s.engine && s.engine.error) || '');
    var text = log.join('\n') + '\n' + err;
    var plain = launcherSentence(err);
    var code = 'engine-failed', msg = MSG.engineFailed;
    if (plain && /Check & repair files/i.test(err)) { code = 'missing-model'; msg = err.trim(); }
    else if (/Visual C\+\+|vc_redist/i.test(err) || (!plain && /c10\.dll|vcruntime|msvcp|VC\+\+|WinError 126/i.test(text))) { code = 'vcredist'; msg = MSG.vcredist; }
    else if (/driver is too old|driver version is insufficient|up-to-date driver/i.test(err) || (!plain && /driver|CUDA (?:error|driver)|no kernel image|cudaGetDeviceCount/i.test(text))) { code = 'driver'; msg = plain && /graphics card was found/i.test(err) ? err.trim() : MSG.driver; }
    else if (plain) msg = err.trim(); // the launcher already explains it in plain words (e.g. "Another program was using the AI engine's port…")
    else if (/out of memory|not enough memory|MemoryError/i.test(text)) msg = MSG.oom;
    var e = LocalAIError(code, msg, text.trim().slice(-4000));
    e.engine = true; // about the engine process, not this video: the job record is kept
    return e;
  }

  // A launcher error that reads like a sentence for people (not a raw exit code or Python error).
  function launcherSentence(t) {
    if (typeof t !== 'string') return false;
    t = t.trim();
    return t.length > 12 && t.length < 400 && /^[“"‘'(]?[A-Z]/.test(t) && /[.!?)”]$/.test(t) && /\s\S+\s\S+\s/.test(t) &&
      !/exited with code|exit status|Traceback|Exception|Error:|errno|0x[0-9a-f]{6,}|\b(?:GET|POST|HEAD|PUT)\s+\S|HTTP\/\d|unexpected EOF|dial tcp|read tcp|x509:|tls:|syscall|\bpanic\b/i.test(t);
  }

  // Resolves with the status once engine.state is 'ready'.
  function waitReady(timeoutMs, opt) {
    opt = opt || {};
    var limit = now() + (num(timeoutMs, 0) > 0 ? num(timeoutMs, 0) : CFG.readyTimeoutMs);
    var firstStopped = 0;
    function tick() {
      if (opt.signal && opt.signal.aborted) return Promise.reject(abortError());
      return getStatus({ signal: opt.signal }).then(function (s) {
        safeCall(opt.onStatus, s);
        var st = s.engine.state;
        if (st === 'ready') return s;
        if (st === 'error') throw engineErrorFrom(s);
        if (st === 'not-installed') throw LocalAIError('not-installed', MSG.notInstalled);
        if (st === 'stopped') {
          if (!firstStopped) firstStopped = now();
          else if (now() - firstStopped > CFG.stoppedGraceMs) throw LocalAIError('engine-stopped', MSG.engineStopped);
        } else firstStopped = 0;
        if (now() > limit) throw LocalAIError('ready-timeout', MSG.readyTimeout);
        return delay(CFG.statusPollMs, opt.signal).then(tick);
      }, function (e) {
        if (isAbort(e)) throw e;
        if (now() > limit) throw e;
        return delay(CFG.statusPollMs, opt.signal).then(tick); // a missed poll is not fatal
      });
    }
    return tick();
  }

  // Make sure the engine runs; starts it when stopped (or after a crash). Reports stage 'starting'.
  function ensureReady(ctx) {
    return getStatus({ signal: ctx.signal }).then(function (s) {
      if (s.engine.state === 'not-installed' || !(s.packs.core && s.packs.core.installed)) throw LocalAIError('not-installed', MSG.notInstalled);
      if (s.engine.state === 'ready') { ctx.skipStage('starting'); return s; }
      ctx.stage('starting', 0, 'Starting the free AI engine… (about a minute)');
      var t0 = now();
      var go = s.engine.state === 'starting' ? Promise.resolve() : start();
      return go.then(function () {
        return waitReady(CFG.readyTimeoutMs, {
          signal: ctx.signal,
          onStatus: function () { ctx.stage('starting', clamp((now() - t0) / 1000 / STAGE_SEC.starting, 0, 0.95), 'Starting the free AI engine… (about a minute)'); }
        });
      }).then(function (ready) { ctx.stage('starting', 1, 'The AI engine is ready.'); return ready; });
    });
  }

  /* ------------------------------------------------------------------ *
   * Graph builders (pure)
   * ------------------------------------------------------------------ */
  function fill(tpl, values) {
    var g = clone(tpl);
    (function walk(o) {
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (typeof v === 'string' && v.indexOf('<<') >= 0) {
          var whole = /^<<([A-Z_]+)>>$/.exec(v);
          if (whole) {
            if (!(whole[1] in values)) throw new Error('Missing value for ' + v);
            o[k] = values[whole[1]];
          } else {
            o[k] = v.replace(/<<([A-Z_]+)>>/g, function (m, name) {
              if (!(name in values)) throw new Error('Missing value for ' + m);
              return String(values[name]);
            });
          }
        } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
      });
    })(g);
    return g;
  }
  function seedOf(v) { v = Math.floor(num(v, NaN)); return isFinite(v) && v >= 0 && v <= 9007199254740991 ? v : randomSeed(); }
  function mult16(v, d) { v = Math.round(num(v, d) / 16) * 16; return clamp(v, 16, 4096); }
  function str(v, d) { return typeof v === 'string' && v.trim() ? v.trim() : d; }

  var graphs = {
    // still({image, prompt, seed, job, model:'qwen'|'klein', width?, height?})
    still: function (o) {
      o = o || {};
      var klein = o.model === 'klein';
      var g = fill(klein ? TEMPLATES.stillKlein : TEMPLATES.stillQwen, {
        SELFIE: String(o.image || ''), SCENE_PROMPT: String(o.prompt || ''), SEED: seedOf(o.seed), JOB: safeJob(o.job)
      });
      if (o.width || o.height) {
        var w = mult16(o.width, 720), h = mult16(o.height, 1248);
        g['11'].inputs.width = w; g['11'].inputs.height = h;
        if (klein) { g['12'].inputs.width = w; g['12'].inputs.height = h; }
      }
      return g;
    },
    // video({image, prompt, negativePrompt?, seed, job, width=480, height=832, length=81, rife=true})
    video: function (o) {
      o = o || {};
      var g = fill(TEMPLATES.video, { STILL: String(o.image || ''), MOTION_PROMPT: String(o.prompt || ''), SEED: seedOf(o.seed), JOB: safeJob(o.job) });
      if (str(o.negativePrompt, '')) g['4'].inputs.text = NEG_WAN + '，' + o.negativePrompt.trim(); // inert at cfg 1, kept for parity
      if (o.width || o.height) { g['6'].inputs.width = mult16(o.width, 480); g['6'].inputs.height = mult16(o.height, 832); }
      if (o.length) g['6'].inputs.length = clamp(Math.round((num(o.length, 81) - 1) / 4) * 4 + 1, 5, 161);
      if (o.rife === false) {
        // spec variant "No RIFE": delete 16 and 17, 18.images = ["15", 0], fps 16
        delete g['16']; delete g['17'];
        g['18'].inputs.images = ['15', 0];
        g['18'].inputs.fps = 16.0;
      }
      return g;
    },
    // song({tags, lyrics, seed, seconds=20, bpm=100, keyscale='A minor', language='es', job})
    song: function (o) {
      o = o || {};
      var seed = seedOf(o.seed);
      var g = fill(TEMPLATES.song, { SONG_TAGS: str(o.tags, DEFAULT_SONG_TAGS), LYRICS_ES: str(o.lyrics, DEFAULT_LYRICS), SEED: seed, JOB: safeJob(o.job) });
      var sec = Math.round(clamp(num(o.seconds, 20), 5, 120) * 10) / 10;
      g['5'].inputs.duration = sec;   // keep "5".duration equal to "7".seconds
      g['7'].inputs.seconds = sec;
      if (o.bpm) g['5'].inputs.bpm = Math.round(clamp(num(o.bpm, 100), 60, 200));
      if (ACE_KEYS.indexOf(o.keyscale) >= 0) g['5'].inputs.keyscale = o.keyscale;
      if (ACE_LANGS.indexOf(o.language) >= 0) g['5'].inputs.language = o.language;
      return g;
    },
    // s2v({image, audio, offset, prompt, seed, job})
    s2v: function (o) {
      o = o || {};
      return fill(TEMPLATES.s2v, {
        STILL: String(o.image || ''), SONG: String(o.audio || ''), SONG_OFFSET_S: Math.max(0, Math.round(num(o.offset, 0) * 100) / 100),
        SING_PROMPT: str(o.prompt, DEFAULT_SING_PROMPT), SEED: seedOf(o.seed), JOB: safeJob(o.job)
      });
    },
    templates: TEMPLATES,
    outputNode: OUTPUT_NODE,
    negativeWan: NEG_WAN
  };

  /* ------------------------------------------------------------------ *
   * Friendly errors from ComfyUI
   * ------------------------------------------------------------------ */
  var MODEL_INPUTS = ['unet_name', 'clip_name', 'clip_name1', 'clip_name2', 'vae_name', 'lora_name', 'model_name', 'audio_encoder_name'];
  var OOM_RE = /out of memory|OutOfMemory|Allocation on device|not enough memory|DefaultCPUAllocator|CUBLAS_STATUS_ALLOC_FAILED/i;
  var DAMAGED_RE = /FileNotFoundError|No such file|HeaderTooLarge|Error while deserializing|SafetensorError|incomplete metadata|invalid load key|could not find .*model|unexpected EOF/i;
  var DRIVER_RE = /CUDA driver version is insufficient|no kernel image is available|cudaErrorInsufficientDriver|NVIDIA driver/i;

  function nodeErrorsToError(data) {
    data = data || {};
    var top = data.error || {};
    var detail = [];
    var code = null;
    if (top.type === 'missing_node_type') code = 'missing-model';
    var ne = data.node_errors || {};
    Object.keys(ne).forEach(function (id) {
      var n = ne[id] || {};
      (n.errors || []).forEach(function (er) {
        var input = er.extra_info && er.extra_info.input_name;
        detail.push('node ' + id + ' (' + (n.class_type || '?') + '): ' + (er.type || '') + ' ' + (er.message || '') + (er.details ? ' — ' + er.details : ''));
        if (er.type === 'value_not_in_list' && MODEL_INPUTS.indexOf(input) >= 0) code = code || 'missing-model';
        else if (er.type === 'custom_validation_failed' && /Invalid image file/i.test((er.message || '') + (er.details || ''))) {
          code = code || (/\[output\]/.test(er.details || er.message || '') ? 'missing-still' : 'bad-photo');
        } else if (er.type === 'custom_validation_failed' && /Invalid audio file/i.test((er.message || '') + (er.details || ''))) code = code || 'failed';
      });
    });
    if (!detail.length && top.message) detail.push((top.type || '') + ': ' + top.message + (top.details ? ' — ' + top.details : ''));
    code = code || 'rejected';
    var msg = { 'missing-model': MSG.missingModel, 'bad-photo': MSG.badPhoto, 'missing-still': MSG.missingStill, failed: MSG.failed, rejected: MSG.rejected }[code];
    var e = LocalAIError(code, msg, detail.join('\n'));
    e.nodeErrors = ne;
    return e;
  }
  function execErrorToError(d) {
    d = d || {};
    var text = String(d.exception_type || '') + ': ' + String(d.exception_message || '');
    var code = 'failed', msg = MSG.failed;
    if (OOM_RE.test(text)) { code = 'oom'; msg = MSG.oom; }
    else if (DRIVER_RE.test(text)) { code = 'driver'; msg = MSG.driver; }
    else if (DAMAGED_RE.test(text)) { code = 'missing-model'; msg = MSG.missingModel; }
    var e = LocalAIError(code, msg, (d.node_type ? d.node_type + ' (node ' + d.node_id + '): ' : '') + text.trim());
    e.nodeType = d.node_type || null;
    return e;
  }

  /* ------------------------------------------------------------------ *
   * ComfyUI WebSocket (via the launcher proxy)
   * ------------------------------------------------------------------ */
  function openSocket(clientId) {
    var s = { open: false, failed: false, listeners: [], closed: false, ws: null, retries: 0 };
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + COMFY + '/ws?clientId=' + encodeURIComponent(clientId);
    function emit(m) { s.listeners.slice().forEach(function (fn) { try { fn(m); } catch (e) { /* ignore */ } }); }
    function connect(first) {
      return new Promise(function (resolve) {
        if (T.noWebSocket || typeof WebSocket !== 'function') { s.failed = true; return resolve(false); }
        var settled = false, ws;
        var timer = setTimeout(function () { finish(false); try { ws && ws.close(); } catch (e) { /* ignore */ } }, CFG.wsConnectMs);
        function finish(ok) { if (settled) return; settled = true; clearTimeout(timer); if (!ok && first) s.failed = true; resolve(ok); }
        try { ws = new WebSocket(url); } catch (e) { return finish(false); }
        s.ws = ws;
        ws.onopen = function () { s.open = true; s.failed = false; s.retries = 0; finish(true); emit({ type: '__open' }); };
        ws.onerror = function () { /* onclose follows */ };
        ws.onclose = function () {
          var was = s.open;
          s.open = false;
          finish(false);
          if (was) emit({ type: '__closed' });
          if (!s.closed && was && s.retries < 5) { s.retries++; setTimeout(function () { if (!s.closed) connect(false); }, 1500 * s.retries); }
        };
        ws.onmessage = function (ev) {
          if (typeof ev.data !== 'string') return; // binary frames are previews (off by default)
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m && typeof m.type === 'string') emit(m);
        };
      });
    }
    s.ready = connect(true);
    s.on = function (fn) { s.listeners.push(fn); return function () { var i = s.listeners.indexOf(fn); if (i >= 0) s.listeners.splice(i, 1); }; };
    s.close = function () { s.closed = true; try { if (s.ws) s.ws.close(); } catch (e) { /* ignore */ } };
    return s;
  }

  /* ------------------------------------------------------------------ *
   * Running one prompt
   * ------------------------------------------------------------------ */
  var NODE_WEIGHT = {
    KSampler: 10, KSamplerAdvanced: 10, SamplerCustomAdvanced: 10, 'TextEncodeAceStepAudio1.5': 6,
    TextEncodeQwenImageEditPlus: 2, CLIPTextEncode: 1, VAEDecode: 2, VAEDecodeAudio: 1, VAEEncode: 1, FrameInterpolate: 2,
    SaveVideo: 1, SaveImage: 0.5, SaveAudioMP3: 0.5, WanImageToVideo: 1, WanSoundImageToVideo: 1, AudioEncoderEncode: 1
  };
  function weightOf(ct) { return NODE_WEIGHT[ct] != null ? NODE_WEIGHT[ct] : (/Loader/.test(ct) ? 0.5 : 0.2); }

  function queuePrompt(graph, promptId, clientId, signal) {
    return request('POST', COMFY + '/prompt', { prompt: graph, client_id: clientId, prompt_id: promptId }, { timeout: 30000, signal: signal }).then(function (res) {
      return readJSON(res).then(function (data) {
        if (res.status === 503) throw LocalAIError('engine-stopped', MSG.engineStopped, 'HTTP 503');
        if (res.status === 404) throw LocalAIError('unavailable', MSG.unavailable, 'HTTP 404');
        if (!res.ok) throw nodeErrorsToError(data);
        if (data && data.node_errors && Object.keys(data.node_errors).length) {
          // accepted, but some outputs were dropped: treat as a rejection of the outputs we need
          var e = nodeErrorsToError(data);
          if (e.code !== 'rejected') throw e;
        }
        return (data && data.prompt_id) || promptId;
      });
    });
  }
  function getHistory(promptId, signal) {
    return request('GET', COMFY + '/history/' + encodeURIComponent(promptId), undefined, { timeout: 15000, signal: signal }).then(function (res) {
      if (res.status === 503) throw LocalAIError('engine-stopped', MSG.engineStopped, 'HTTP 503');
      if (!res.ok) throw LocalAIError('network', MSG.network, 'HTTP ' + res.status);
      return readJSON(res).then(function (d) { return (d && d[promptId]) || null; });
    });
  }
  function getQueue(signal) {
    return request('GET', COMFY + '/queue', undefined, { timeout: 15000, signal: signal }).then(function (res) {
      if (res.status === 503) throw LocalAIError('engine-stopped', MSG.engineStopped, 'HTTP 503');
      if (!res.ok) throw LocalAIError('network', MSG.network, 'HTTP ' + res.status);
      return readJSON(res);
    });
  }
  function queueState(q, promptId) {
    function has(list) { return (list || []).some(function (it) { return it && it[1] === promptId; }); }
    if (!q) return null;
    if (has(q.queue_running)) return 'running';
    if (has(q.queue_pending)) return 'pending';
    return 'absent';
  }
  // 'done' | 'error' | 'running' | 'pending' | 'lost'
  function promptState(promptId, signal) {
    return getHistory(promptId, signal).then(function (h) {
      if (h) return historyOutcome(h).ok ? 'done' : 'error';
      return getQueue(signal).then(function (q) {
        var st = queueState(q, promptId);
        if (st === 'absent') {
          // finished between the two calls?
          return getHistory(promptId, signal).then(function (h2) { return h2 ? (historyOutcome(h2).ok ? 'done' : 'error') : 'lost'; });
        }
        return st;
      });
    });
  }
  function historyOutcome(h) {
    var st = h.status || {};
    var msgs = st.messages || [];
    var err = null, intr = null;
    msgs.forEach(function (m) {
      if (!Array.isArray(m)) return;
      if (m[0] === 'execution_error') err = m[1];
      if (m[0] === 'execution_interrupted') intr = m[1];
    });
    if (st.status_str === 'error' || err || intr) return { ok: false, error: err, interrupted: !!intr && !err };
    if (st.status_str === 'success' || st.completed) return { ok: true };
    return { ok: !!(h.outputs && Object.keys(h.outputs).length) };
  }
  function pickFile(outputs, nodeId) {
    function first(o) {
      if (!o) return null;
      var list = o.images || o.gifs || o.video || o.videos || o.audio || o.files;
      return Array.isArray(list) && list.length && list[0] && list[0].filename ? list[0] : null;
    }
    outputs = outputs || {};
    var f = first(outputs[nodeId]);
    if (f) return f;
    var ids = Object.keys(outputs);
    for (var i = 0; i < ids.length; i++) { f = first(outputs[ids[i]]); if (f) return f; }
    return null;
  }

  // Wait for one queued prompt; resolves with its /history entry. st = {graph, promptId, stage, expectSec, message}
  function track(ctx, st) {
    var promptId = st.promptId;
    var graph = st.graph || {};
    var ids = Object.keys(graph);
    var total = ids.reduce(function (a, id) { return a + weightOf(graph[id].class_type); }, 0) || 1;
    var done = {}, current = null, frac = 0, wsSeen = false, t0 = now(), shown = 0, executedOut = {};
    var finished = false, absentCount = 0, pollN = 0, pending = false;

    return new Promise(function (resolve, reject) {
      var off = ctx.socket ? ctx.socket.on(onMsg) : function () {};
      var pollTimer = null;
      var onAbort = function () {
        if (finished) return;
        cleanupAll();
        ctx.interrupt(promptId).then(function () { reject(abortError()); }, function () { reject(abortError()); });
      };
      if (ctx.signal) {
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      schedulePoll(Math.min(800, CFG.historyPollMs));
      report();

      function cleanupAll() {
        finished = true;
        off();
        if (pollTimer) clearTimeout(pollTimer);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      }
      function succeed(h) { if (finished) return; cleanupAll(); resolve(h); }
      function fail(e) { if (finished) return; cleanupAll(); reject(e); }

      function pct() {
        var w = 0;
        Object.keys(done).forEach(function (id) { if (graph[id]) w += weightOf(graph[id].class_type); });
        if (current && graph[current] && !done[current]) w += weightOf(graph[current].class_type) * frac;
        var p = w / total;
        if (!wsSeen) p = Math.max(p, Math.min(0.95, (now() - t0) / 1000 / (st.expectSec * 1.15)));
        return clamp(p, 0, 0.99);
      }
      function report() {
        if (finished) return;
        var p = Math.max(shown, pct());
        shown = p;
        var msg = pending ? 'Waiting for the engine to finish another job…' : st.message;
        if (!pending && current && graph[current] && /Loader/.test(graph[current].class_type) && st.loadingMessage) msg = st.loadingMessage;
        ctx.stage(st.stage, p, msg);
      }
      function onMsg(m) {
        if (finished) return;
        var d = m.data || {};
        if (m.type === '__closed' || m.type === '__open') { schedulePoll(m.type === '__closed' ? 200 : CFG.safetyPollMs); return; }
        if (d.prompt_id && d.prompt_id !== promptId) return;
        switch (m.type) {
          case 'execution_start': wsSeen = true; pending = false; report(); break;
          case 'execution_cached': wsSeen = true; (d.nodes || []).forEach(function (id) { done[id] = true; }); report(); break;
          case 'executing':
            // (on reconnect ComfyUI replays the current node without a prompt_id; the client id is ours alone)
            wsSeen = true; pending = false;
            if (current && current !== d.node) done[current] = true;
            if (d.node == null) { checkHistory(true); return; }
            current = String(d.node); frac = 0; report(); break;
          case 'progress':
            wsSeen = true;
            if (d.node != null) current = String(d.node);
            frac = d.max ? clamp(d.value / d.max, 0, 1) : 0; report(); break;
          case 'executed':
            wsSeen = true; if (d.node != null) { done[String(d.node)] = true; executedOut[String(d.node)] = d.output; } report(); break;
          case 'execution_success': wsSeen = true; checkHistory(true); break;
          case 'execution_error': fail(execErrorToError(d)); break;
          case 'execution_interrupted': fail(ctx.signal && ctx.signal.aborted ? abortError() : LocalAIError('interrupted', MSG.interrupted)); break;
        }
      }
      function schedulePoll(ms) {
        if (finished) return;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, ms);
      }
      // the socket is trusted only once it has shown our prompt running; until then (queued, or no socket) poll every 2 s
      function nextPollMs() { return ctx.socket && ctx.socket.open && wsSeen ? CFG.safetyPollMs : CFG.historyPollMs; }
      function poll() {
        if (finished) return;
        pollN++;
        checkHistory(false).then(function (h) {
          if (finished || h) return;
          report();
          // every other poll, make sure the prompt still exists (an engine restart drops the queue)
          if (pollN === 1 || pollN % 2 === 0 || !ctx.socket || !ctx.socket.open || !wsSeen) {
            return getQueue(ctx.signal).then(function (q) {
              if (finished) return;
              var s = queueState(q, promptId);
              pending = s === 'pending';
              if (s === 'absent') {
                absentCount++;
                if (absentCount >= 2) return checkHistory(false).then(function (h2) { if (!h2 && !finished) fail(LocalAIError('lost', MSG.lost)); });
              } else absentCount = 0;
            });
          }
        }).catch(function (e) {
          if (finished || isAbort(e)) return;
          if (e && e.code === 'engine-stopped') return ctx.engineGone().then(function (gone) { if (gone && !finished) fail(gone); });
        }).then(function () { if (!finished) schedulePoll(nextPollMs()); report(); });
      }
      // Resolves the history entry when the prompt is finished (and settles the promise), else null.
      function checkHistory(expectDone) {
        var tries = expectDone ? 6 : 1;
        function attempt(n) {
          return getHistory(promptId, ctx.signal).then(function (h) {
            if (finished) return h;
            if (h) {
              var oc = historyOutcome(h);
              if (oc.ok) succeed(h);
              else if (oc.interrupted) fail(ctx.signal && ctx.signal.aborted ? abortError() : LocalAIError('interrupted', MSG.interrupted));
              else fail(execErrorToError(oc.error || { exception_message: 'unknown error' }));
              return h;
            }
            if (n > 1) return delay(400, ctx.signal).then(function () { return attempt(n - 1); });
            if (expectDone && Object.keys(executedOut).length) {
              // history not written yet but the socket already gave us the outputs
              succeed({ outputs: executedOut, status: { status_str: 'success', completed: true, messages: [] } });
              return true;
            }
            return null;
          });
        }
        if (!expectDone) return attempt(tries); // errors go to poll(), which knows about a stopped engine
        return attempt(tries).catch(function (e) { if (!isAbort(e)) schedulePoll(CFG.historyPollMs); return null; });
      }
    });
  }

  function viewUrl(file) {
    return COMFY + '/view?filename=' + encodeURIComponent(file.filename) + '&subfolder=' + encodeURIComponent(file.subfolder || '') + '&type=' + encodeURIComponent(file.type || 'output');
  }
  function fetchFile(file, signal) {
    return request('GET', viewUrl(file), undefined, { timeout: 180000, signal: signal }).then(function (res) {
      if (res.status === 404) throw LocalAIError('lost', MSG.outputGone, 'HTTP 404 for ' + file.filename);
      if (!res.ok) throw LocalAIError('download', MSG.download, 'HTTP ' + res.status + ' for ' + file.filename);
      return res.blob();
    }).then(function (b) {
      if (!b || !b.size) throw LocalAIError('download', MSG.download, 'empty file ' + file.filename);
      var ext = (/\.([a-z0-9]+)$/i.exec(file.filename) || [])[1];
      var type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', opus: 'audio/ogg' }[(ext || '').toLowerCase()];
      return type && b.type !== type ? b.slice(0, b.size, type) : b;
    });
  }
  function annotated(file) {
    // LoadImage / LoadAudio read straight from output/ with "<subfolder>/<name> [output]" (exactly one space)
    return (file.subfolder ? file.subfolder + '/' : '') + file.filename + ' [' + (file.type || 'output') + ']';
  }
  function interruptPrompt(promptId) {
    var a = request('POST', COMFY + '/interrupt', { prompt_id: promptId }, { timeout: 8000 }).catch(function () { /* ignore */ });
    var b = request('POST', COMFY + '/queue', { delete: [promptId] }, { timeout: 8000 }).catch(function () { /* ignore */ });
    return Promise.all([a, b]);
  }

  /* ------------------------------------------------------------------ *
   * Photo + upload
   * ------------------------------------------------------------------ */
  function decodeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).catch(function () { return decodeWithImg(blob); });
    }
    return decodeWithImg(blob);
  }
  function decodeWithImg(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(LocalAIError('bad-photo', MSG.badPhoto, 'decode failed')); };
      img.src = url;
    });
  }
  // Long side <= 1536 px, JPEG or PNG (spec: re-encode in the browser so EXIF rotation is baked in and HEIC is avoided).
  function preparePhoto(blob) {
    if (!blob || typeof blob.size !== 'number' || !blob.size) return Promise.reject(LocalAIError('bad-photo', MSG.badPhoto, 'no photo'));
    return decodeImage(blob).then(function (img) {
      var w = img.width, h = img.height;
      if (!w || !h) throw LocalAIError('bad-photo', MSG.badPhoto, 'empty image');
      var s = Math.min(1, 1536 / Math.max(w, h));
      var okType = /^image\/(jpeg|png)$/.test(blob.type);
      if (s === 1 && okType) { if (img.close) img.close(); return { blob: blob, ext: blob.type === 'image/png' ? 'png' : 'jpg', width: w, height: h }; }
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();
      return new Promise(function (resolve, reject) {
        c.toBlob(function (b) { b ? resolve({ blob: b, ext: 'jpg', width: cw, height: ch }) : reject(LocalAIError('bad-photo', MSG.badPhoto, 'encode failed')); }, 'image/jpeg', 0.95);
      });
    });
  }
  function uploadImage(blob, name, signal) {
    var fd = new FormData();
    fd.append('image', blob, name);
    fd.append('type', 'input');
    fd.append('subfolder', 'glow');
    fd.append('overwrite', 'true');
    return request('POST', COMFY + '/upload/image', fd, { timeout: 120000, signal: signal }).then(function (res) {
      return readJSON(res).then(function (d) {
        if (res.status === 503) throw LocalAIError('engine-stopped', MSG.engineStopped, 'HTTP 503');
        if (!res.ok || !d || !d.name) throw LocalAIError('upload', 'Your photo couldn’t be sent to the AI engine. Please try again.', 'HTTP ' + res.status);
        return (d.subfolder ? d.subfolder + '/' : '') + d.name;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Jobs (persisted so a reload can re-attach)
   * ------------------------------------------------------------------ */
  function saveRec(rec) { rec.updatedAt = now(); lsSet(LS_JOB, JSON.stringify(rec)); }
  function loadRec() {
    var s = lsGet(LS_JOB); if (!s) return null;
    try { var r = JSON.parse(s); return r && r.v === 1 && r.id ? r : null; } catch (e) { return null; }
  }
  function clearRec(id) { var r = loadRec(); if (!r || !id || r.id === id) lsDel(LS_JOB); }
  // Ask the launcher to delete the selfie copy and the unlabelled outputs of this job, and ComfyUI to forget its prompts.
  function cleanupJob(rec, afterMs) {
    if (!rec || !rec.id || !isLoopbackPage()) return Promise.resolve();
    var prompts = (rec.promptIds || []).concat(rec.promptId ? [rec.promptId] : []).filter(function (p, i, a) { return p && a.indexOf(p) === i; }).slice(-64);
    var go = function () { return request('POST', ENGINE + '/cleanup', { job: safeJob(rec.id), prompts: prompts }, { timeout: 15000 }).then(function () {}, function () { /* swept at the next engine start */ }); };
    // after an abort: now, and once more a moment later (the interrupted prompt may still write a file as it stops)
    return go().then(function () { return afterMs ? delay(afterMs).then(go) : undefined; });
  }
  // Ask the launcher not to quit while this job is in flight, even when the window is hidden or asleep and stops
  // pinging (renewed at every step; it lapses by itself after 2 hours). release: the job is over. An older launcher
  // without this endpoint answers 404, which is fine.
  var noHold = false;
  function holdJob(id, release) {
    if (!id || noHold || !isLoopbackPage()) return;
    request('POST', ENGINE + '/hold', { job: safeJob(id), release: !!release }, { timeout: 8000 }).then(function (res) {
      if (res.status === 404) noHold = true; // a launcher from before holds: it never quits while ComfyUI renders anyway
    }, function () { /* best effort */ });
  }
  // Forget a job (and delete the engine's files for it). For a record kept with {keep: true} once the page is done.
  function release(job) {
    var r = loadRec();
    if (!r || (job && r.id !== job)) return Promise.resolve(false);
    clearRec(r.id);
    return cleanupJob(r).then(function () { return true; });
  }

  function videoPlan(rec) {
    var sing = rec.singing && rec.singing.lipSync;
    if (sing) return { kind: 's2v', width: 480, height: 832, length: 77, fps: 16, rife: false };
    var fast = rec.quality === 'fast';
    return { kind: 'video', width: fast ? 384 : 480, height: fast ? 672 : 832, length: 81, fps: 32, rife: true };
  }
  function stagesOf(rec) { return rec.singing ? ['still', 'song', 'video'] : ['still', 'video']; }
  function stageSec(rec, stage) {
    if (stage === 'still') return rec.stillModel === 'klein' ? STAGE_SEC.stillKlein : STAGE_SEC.stillQwen;
    if (stage === 'song') return STAGE_SEC.song;
    if (stage === 'video') { var vp = videoPlan(rec); return vp.kind === 's2v' ? STAGE_SEC.s2v : (rec.quality === 'fast' ? STAGE_SEC.videoFast : STAGE_SEC.video); }
    return STAGE_SEC[stage] || 5;
  }
  function graphFor(rec, stage) {
    if (stage === 'still') {
      return { graph: graphs.still({ image: rec.selfie, prompt: rec.prompts.still, seed: rec.seed, job: rec.id, model: rec.stillModel }), out: OUTPUT_NODE[rec.stillModel === 'klein' ? 'stillKlein' : 'stillQwen'],
        message: 'Placing you in the scene…', loadingMessage: 'Loading the photo model (the first time after starting takes longer)…' };
    }
    if (stage === 'song') {
      var sg = rec.singing;
      return { graph: graphs.song({ tags: sg.style, lyrics: sg.lyrics, seed: rec.seed, seconds: sg.seconds, language: sg.language, bpm: sg.bpm, keyscale: sg.keyscale, job: rec.id }), out: OUTPUT_NODE.song,
        message: 'Writing your Spanish song…', loadingMessage: 'Loading the song model…' };
    }
    var vp = videoPlan(rec);
    var still = annotated(rec.outputs.still);
    if (vp.kind === 's2v') {
      return { graph: graphs.s2v({ image: still, audio: annotated(rec.outputs.song), offset: rec.singing.offset, prompt: rec.singing.prompt || DEFAULT_SING_PROMPT, seed: rec.seed, job: rec.id }), out: OUTPUT_NODE.s2v,
        message: 'Making you sing… (this is the slow part)', loadingMessage: 'Loading the singing model…' };
    }
    return { graph: graphs.video({ image: still, prompt: rec.prompts.motion, negativePrompt: rec.prompts.negative, seed: rec.seed, job: rec.id, width: vp.width, height: vp.height, length: vp.length, rife: vp.rife }), out: OUTPUT_NODE.video,
      message: 'Bringing the scene to life… (this is the slow part)', loadingMessage: 'Loading the video model…' };
  }

  var active = null;

  // stages: ordered stage names; weights: expected seconds per stage (drives the overall bar)
  function makeCtx(stages, weights, onProgress, signal) {
    stages = stages.slice();
    var last = { overall: 0 };
    function totalW() { return stages.reduce(function (a, s) { return a + (weights[s] || 0); }, 0) || 1; }
    var ctx = {
      signal: signal, socket: null,
      skipStage: function (stage) { var i = stages.indexOf(stage); if (i >= 0) stages.splice(i, 1); },
      stage: function (stage, pct, message, extra) {
        var before = 0;
        for (var i = 0; i < stages.length && stages[i] !== stage; i++) before += weights[stages[i]] || 0;
        var overall = stages.indexOf(stage) < 0 ? last.overall : clamp((before + (weights[stage] || 0) * clamp(pct, 0, 1)) / totalW(), 0, 1);
        overall = Math.max(last.overall, overall);
        last = { overall: overall };
        var p = { stage: stage, pct: clamp(pct, 0, 1), overall: overall, message: message || '' };
        if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
        safeCall(onProgress, p);
      },
      interrupt: interruptPrompt,
      engineGone: function () {
        return getStatus().then(function (s) {
          if (s.engine.state === 'error') return engineErrorFrom(s);
          if (s.engine.state === 'stopped' || s.engine.state === 'not-installed') return LocalAIError('engine-stopped', MSG.engineStopped);
          return null;
        }, function () { return null; });
      }
    };
    return ctx;
  }

  function runJob(rec, onProgress, signal, opt) {
    opt = opt || {};
    if (active) return Promise.reject(LocalAIError('busy', MSG.busy));
    var token = {};
    active = token;
    var stageList = ['starting'].concat(rec.selfie ? [] : ['upload'], stagesOf(rec), ['download']);
    var weights = {};
    stageList.forEach(function (s) { weights[s] = stageSec(rec, s); });
    var reached = null; // the last stage reported (an engine that stops after 'starting' stopped in the middle of the video)
    var ctx = makeCtx(stageList, weights, function (p) { reached = p.stage; p.job = rec.id; safeCall(onProgress, p); }, signal);
    var result = { stillBlob: null, stillUrl: null, video: null, audio: undefined };
    var socket = null;

    function stageRun(stage) {
      if (rec.done[stage]) return Promise.resolve();
      var spec = graphFor(rec, stage);
      holdJob(rec.id);
      var t0 = now();
      var resumeId = (rec.stage === stage && rec.promptId) ? rec.promptId : null;
      var promptId = null;
      var check = resumeId ? promptState(resumeId, signal) : Promise.resolve(null);
      return check.then(function (state) {
        var reuse = !!state && state !== 'lost';   // still queued/running/finished in ComfyUI: re-attach to it
        promptId = reuse ? resumeId : uuid();
        rec.stage = stage; rec.promptId = promptId; rec.stageStartedAt = reuse ? (rec.stageStartedAt || t0) : t0;
        rec.promptIds = (rec.promptIds || []).filter(function (x) { return x !== promptId; }).concat([promptId]);
        saveRec(rec);
        ctx.stage(stage, 0, spec.message);
        var queued = reuse ? Promise.resolve(promptId) : queuePrompt(spec.graph, promptId, rec.clientId, signal);
        return queued.then(function () {
          return track(ctx, { graph: spec.graph, promptId: promptId, stage: stage, expectSec: stageSec(rec, stage), message: spec.message, loadingMessage: spec.loadingMessage });
        }, function (e) {
          // cancelled while the prompt was being sent: it may have been queued anyway
          if (isAbort(e)) return interruptPrompt(promptId).then(function () { throw e; });
          throw e;
        });
      }).then(function (h) {
        var file = pickFile(h.outputs, spec.out);
        if (!file) throw LocalAIError('failed', MSG.failed, 'no output file in history for node ' + spec.out);
        rec.outputs[stage] = file;
        rec.done[stage] = true;
        rec.timings[stage] = Math.round((now() - (rec.stageStartedAt || t0)) / 100) / 10;
        saveRec(rec);
        if (stage === 'still') return loadStill();
        ctx.stage(stage, 1, stage === 'song' ? 'Your song is ready.' : 'Video finished.');
      });
    }
    function loadStill() {
      return fetchFile(rec.outputs.still, signal).then(function (b) {
        result.stillBlob = b;
        result.stillUrl = URL.createObjectURL(b);
        ctx.stage('still', 1, 'Your scene photo is ready.', { stillUrl: result.stillUrl });
      });
    }

    holdJob(rec.id);
    var p = ensureReady(ctx).then(function () {
      socket = openSocket(rec.clientId);
      ctx.socket = socket;
      return socket.ready;
    }).then(function () {
      if (rec.selfie) return;
      ctx.stage('upload', 0.1, 'Sending your photo to the AI engine…');
      return preparePhoto(opt.photo).then(function (ph) {
        return uploadImage(ph.blob, 'selfie_' + rec.id + '.' + ph.ext, signal);
      }).then(function (name) {
        rec.selfie = name;
        saveRec(rec);
        ctx.stage('upload', 1, 'Photo sent.');
      });
    }).then(function () {
      var chain = Promise.resolve();
      stagesOf(rec).forEach(function (s) { chain = chain.then(function () { if (signal && signal.aborted) throw abortError(); return stageRun(s); }); });
      return chain;
    }).then(function () {
      if (!result.stillBlob) return loadStill();
    }).then(function () {
      ctx.stage('download', 0.1, 'Saving your video…');
      var jobs = [fetchFile(rec.outputs.video, signal)];
      if (rec.singing && rec.outputs.song) jobs.push(fetchFile(rec.outputs.song, signal));
      return Promise.all(jobs);
    }).then(function (files) {
      var vp = videoPlan(rec);
      var frames = vp.rife ? (vp.length - 1) * 2 + 1 : vp.length;
      result.video = files[0];
      if (files[1]) result.audio = files[1];
      result.width = vp.width; result.height = vp.height; result.fps = vp.fps;
      result.seconds = Math.round(frames / vp.fps * 100) / 100;
      result.seed = rec.seed;
      result.timings = { still: rec.timings.still || 0, song: rec.timings.song || 0, video: rec.timings.video || 0 };
      result.quality = rec.quality;
      result.stillModel = rec.stillModel;
      result.lipSync = !!(rec.singing && rec.singing.lipSync);
      result.job = rec.id;
      if (!result.audio) delete result.audio;
      ctx.stage('download', 1, 'Done!');
      if (opt.keep) { rec.delivered = true; saveRec(rec); } // kept until release(job)
      else { clearRec(rec.id); cleanupJob(rec); }
      return result;
    });

    return p.then(function (r) { finish(); return r; }, function (e) {
      finish();
      if (isAbort(e) || (e && !e.engine && /^(failed|oom|missing-model|missing-still|bad-photo|rejected|interrupted|lost|driver)$/.test(e.code))) {
        clearRec(rec.id);
        cleanupJob(rec, isAbort(e) ? 3000 : 0); // after an abort, give the interrupted prompt a moment to stop writing
      }
      if (e && typeof e === 'object' && !isAbort(e)) {
        if (result.stillUrl) e.stillUrl = result.stillUrl; // let the UI keep the still that did work
        if (!e.stage) e.stage = reached;                     // where it stopped ('starting' = the engine never got going)
      }
      throw e;
    });
    function finish() { if (socket) socket.close(); if (active === token) active = null; holdJob(rec.id, true); }
  }

  function packInstalled(s, id) { return !!(s && s.packs && s.packs[id] && s.packs[id].installed); }

  // generate(opts, onProgress) — see header and the contract in the README of the desktop launcher.
  function generate(opts, onProgress) {
    opts = opts || {};
    var signal = opts.signal || null;
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (!opts.photo || typeof opts.photo.size !== 'number') return Promise.reject(LocalAIError('bad-photo', MSG.badPhoto, 'opts.photo must be a Blob'));
    if (active) return Promise.reject(LocalAIError('busy', MSG.busy));
    var quality = opts.quality === 'fast' ? 'fast' : 'best';
    return getStatus({ signal: signal }).then(function (s) {
      if (!packInstalled(s, 'core')) throw LocalAIError('not-installed', MSG.notInstalled);
      var sg = null;
      if (opts.singing) {
        if (!packInstalled(s, 'singing')) throw LocalAIError('missing-pack', MSG.missingPack);
        var secs = Math.round(clamp(num(opts.singing.seconds, 20), 10, 60) * 10) / 10;
        sg = {
          lyrics: str(opts.singing.lyrics, DEFAULT_LYRICS),
          style: str(opts.singing.style, DEFAULT_SONG_TAGS),
          language: ACE_LANGS.indexOf(opts.singing.language) >= 0 ? opts.singing.language : 'es',
          seconds: secs,
          bpm: opts.singing.bpm || null,
          keyscale: opts.singing.keyscale || null,
          lipSync: opts.singing.lipSync !== false,
          // lip-sync prompt: the caller's own, else the motion prompt when it is about singing, else the spec's S2V prompt
          prompt: str(opts.singing.prompt, /\b(sing|sings|singing|canta|cantando)\b/i.test(String(opts.motionPrompt || '')) ? String(opts.motionPrompt).trim() : DEFAULT_SING_PROMPT),
          offset: opts.singing.offset != null ? clamp(num(opts.singing.offset, 0), 0, Math.max(0, secs - 5)) : Math.max(0, Math.min(secs - 5, Math.round(secs * 0.25)))
        };
      }
      var rec = {
        v: 1, id: newJobId(), clientId: 'glow-' + uuid().replace(/-/g, '').slice(0, 20), startedAt: now(), updatedAt: now(),
        quality: quality, stillModel: quality === 'fast' && packInstalled(s, 'fast') ? 'klein' : 'qwen', seed: seedOf(opts.seed),
        prompts: { still: String(opts.stillPrompt || '').trim(), motion: String(opts.motionPrompt || '').trim(), negative: str(opts.negativePrompt, '') },
        singing: sg, selfie: null, stage: 'upload', promptId: null, outputs: {}, done: {}, timings: {}
      };
      if (!rec.prompts.still) throw LocalAIError('bad-request', 'A scene description is needed.', 'opts.stillPrompt is empty');
      if (!rec.prompts.motion) rec.prompts.motion = DEFAULT_MOTION;
      dropFailedStory();
      return runJob(rec, onProgress, signal, { photo: opts.photo, keep: !!opts.keep });
    });
  }
  var DEFAULT_MOTION = 'The person dances happily toward the camera, smiling, natural motion, handheld smartphone video.';

  /* ------------------------------------------------------------------ *
   * Stories: 1–4 shots (about 5 s each) made from ONE selfie, so the person looks the same in every shot.
   *
   * GlowLocalAI.generateStory(opts, onProgress) -> Promise<StoryResult>
   *   opts = { photo: Blob, quality: 'best'|'fast', seed?, signal?, keep?,
   *            shots: [{ id, stillPrompt, motionPrompt, negativePrompt?, lipSync?, audioStart? }, …]   (1–4)
   *            song?:  { lyrics, style, language: 'es', seconds, bpm?, keyscale? }   AI song (Singing add-on)
   *            audio?: { blob, start }                                             OR the user's own song }
   * Order of work: every still (photo model loaded once) -> the song -> every dance video (video model loaded once)
   * -> every lip-sync shot (one verified 77-frame S2V chunk each, driven by its own 5 s segment of the soundtrack).
   * Soundtrack timeline ("songOffsets"): shot i starts at its audioStart, else where the shot before it ended,
   * counting from 0 in the AI song or from audio.start in the user's file (seconds in THAT file). A dance clip lasts
   * 161/32 = 5.03 s, a lip-sync clip 77/16 = 4.81 s; a lip-sync clip is in sync when it plays at normal speed exactly
   * at songOffsets[id] of the soundtrack. The AI song is made long enough for every segment (never shorter than asked).
   * For the user's own song only the needed part is decoded in the browser, cut into a WAV and sent to the engine.
   *
   * Errors: a failure that a retry can fix (out of graphics memory, the engine stopped or restarted, a lost
   * connection, missing files after a repair …) keeps the job and every finished shot: the error has
   * e.resumable = true and GlowLocalAI.resume() offers the job with state 'failed'; its attach() continues from the
   * shot that failed (finished stills and clips are not made again). Cancelling, a bad photo or song file, a missing
   * add-on or a bad request end the job (its files on this PC are deleted).
   * ------------------------------------------------------------------ */
  var I2V_SECONDS = 161 / 32;     // 81 frames, RIFE x2 -> 161 frames at 32 fps
  var S2V_SECONDS = 77 / 16;      // one S2V chunk, 77 frames at 16 fps
  var S2V_AUDIO_SECONDS = 5.0;    // the S2V graph's TrimAudioDuration "duration"
  var MAX_SHOTS = 4;
  var MAX_AUDIO_BYTES = 50 * 1024 * 1024;
  var NON_RESUMABLE = /^(bad-photo|bad-request|bad-audio|missing-pack|not-installed|unavailable|busy)$/;

  function round2(x) { return Math.round(x * 100) / 100; }
  function round6(x) { return Math.round(x * 1e6) / 1e6; } // drops float noise; 161/32 and 77/16 stay exact
  function shotSeed(seed, i) { return (seed + i * 1000003) % 9007199254740992; }
  function stepParts(key) { var m = /^([a-z]+):(\d+)$/.exec(String(key || '')); return m ? { stage: m[1], shot: +m[2] } : { stage: key || null, shot: null }; }
  function storySteps(rec) {
    var s = [];
    rec.shots.forEach(function (sh, i) { s.push('still:' + i); });
    if (rec.song) s.push('song');
    rec.shots.forEach(function (sh, i) { if (!sh.lipSync) s.push('video:' + i); });
    rec.shots.forEach(function (sh, i) { if (sh.lipSync) s.push('lipsync:' + i); });
    return s;
  }
  function clipStep(rec, i) { return (rec.shots[i].lipSync ? 'lipsync:' : 'video:') + i; }
  function needsAudioFile(rec) { return !!(rec.audioSource === 'user' && rec.audio && rec.audio.needed); }
  function storyStepSec(rec, key) {
    var st = stepParts(key).stage;
    if (st === 'still') return rec.stillModel === 'klein' ? STAGE_SEC.stillKlein : STAGE_SEC.stillQwen;
    if (st === 'video') return rec.quality === 'fast' ? STAGE_SEC.videoFast : STAGE_SEC.video;
    if (st === 'lipsync') return STAGE_SEC.s2v;
    if (st === 'song') return STAGE_SEC.song;
    if (st === 'upload') return needsAudioFile(rec) ? STAGE_SEC.upload * 2 : STAGE_SEC.upload;
    if (st === 'download') return STAGE_SEC.download * rec.shots.length;
    return STAGE_SEC[st] || 5;
  }
  function invalidate(rec, key) {
    var sp = stepParts(key);
    var drop = [key];
    if (sp.stage === 'still') drop.push(clipStep(rec, sp.shot));                  // its clip was made from that still
    if (key === 'song') rec.shots.forEach(function (sh, i) { if (sh.lipSync) drop.push('lipsync:' + i); });
    // a step made again gets a new file name: ComfyUI would otherwise answer the same graph from its cache with
    // the name of the file that is gone (only the save node runs again when the rest is still cached)
    rec.takes = rec.takes || {};
    drop.forEach(function (k) { delete rec.done[k]; delete rec.outputs[k]; rec.takes[k] = (rec.takes[k] || 0) + 1; });
    if (drop.indexOf(rec.stage) >= 0) rec.promptId = null;
  }
  function storyGraph(rec, key) {
    var sp = stepParts(key), i = sp.shot, n = rec.shots.length, sh = i != null ? rec.shots[i] : null;
    var take = rec.takes && rec.takes[key];
    var job = rec.id + (i != null ? '_s' + i : '') + (take ? '_r' + take : '');
    var of = n > 1 && i != null ? ' ' + (i + 1) + ' of ' + n : '';
    if (sp.stage === 'still') {
      return { graph: graphs.still({ image: rec.selfie, prompt: sh.still, seed: shotSeed(rec.seed, i), job: job, model: rec.stillModel }),
        out: OUTPUT_NODE[rec.stillModel === 'klein' ? 'stillKlein' : 'stillQwen'],
        message: n > 1 ? 'Placing you in shot' + of + '…' : 'Placing you in the scene…', loadingMessage: 'Loading the photo model (the first time after starting takes longer)…' };
    }
    if (sp.stage === 'song') {
      var sg = rec.song;
      return { graph: graphs.song({ tags: sg.style, lyrics: sg.lyrics, seed: rec.seed, seconds: sg.seconds, language: sg.language, bpm: sg.bpm, keyscale: sg.keyscale, job: job }),
        out: OUTPUT_NODE.song, message: sg.language === 'es' ? 'Writing your Spanish song…' : 'Writing your song…', loadingMessage: 'Loading the song model…' };
    }
    var still = annotated(rec.outputs['still:' + i]);
    if (sp.stage === 'lipsync') {
      var fromSong = rec.audioSource === 'song';
      return { graph: graphs.s2v({ image: still, audio: fromSong ? annotated(rec.outputs.song) : rec.audio.file, offset: fromSong ? sh.offset : sh.offset - rec.audio.start,
        prompt: sh.motion || DEFAULT_SING_PROMPT, seed: shotSeed(rec.seed, i), job: job }),
        out: OUTPUT_NODE.s2v, message: 'Making you sing' + (of ? ' in shot' + of : '') + '… (this is the slow part)', loadingMessage: 'Loading the singing model…' };
    }
    var fast = rec.quality === 'fast';
    return { graph: graphs.video({ image: still, prompt: sh.motion, negativePrompt: sh.negative, seed: shotSeed(rec.seed, i), job: job, width: fast ? 384 : 480, height: fast ? 672 : 832, length: 81, rife: true }),
      out: OUTPUT_NODE.video, message: (of ? 'Bringing shot' + of + ' to life' : 'Bringing the scene to life') + '… (this is the slow part)', loadingMessage: 'Loading the video model…' };
  }

  // Checks and normalises the story request (throws LocalAIError 'bad-request').
  function planStory(opts) {
    var list = opts.shots;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_SHOTS) throw LocalAIError('bad-request', MSG.shots, 'opts.shots must have 1..' + MAX_SHOTS + ' items');
    var seen = {};
    var shots = list.map(function (s, i) {
      s = s && typeof s === 'object' ? s : {};
      var id = String(s.id != null && s.id !== '' ? s.id : 'shot' + (i + 1)).slice(0, 64);
      if (seen[id]) id = id + '-' + (i + 1);
      seen[id] = true;
      var still = typeof s.stillPrompt === 'string' ? s.stillPrompt.trim() : '';
      if (!still) throw LocalAIError('bad-request', MSG.shots, 'shots[' + i + '].stillPrompt is empty');
      var lip = !!s.lipSync;
      var at = s.audioStart != null && s.audioStart !== '' && isFinite(Number(s.audioStart)) ? Math.max(0, Number(s.audioStart)) : null;
      return { id: id, still: still, motion: str(s.motionPrompt, lip ? DEFAULT_SING_PROMPT : DEFAULT_MOTION), negative: str(s.negativePrompt, ''),
        lipSync: lip, audioStart: at, seconds: lip ? S2V_SECONDS : I2V_SECONDS, offset: null };
    });
    var song = opts.song && typeof opts.song === 'object' ? opts.song : null;
    var audio = null;
    if (opts.audio) {
      if (typeof opts.audio !== 'object' || !opts.audio.blob || typeof opts.audio.blob.size !== 'number') throw LocalAIError('bad-request', MSG.badAudio, 'opts.audio.blob must be a Blob');
      audio = opts.audio;
    }
    if (song && audio) throw LocalAIError('bad-request', MSG.twoSongs, 'opts.song and opts.audio are both set');
    var lips = shots.filter(function (sh) { return sh.lipSync; });
    if (lips.length && !song && !audio) throw LocalAIError('bad-request', MSG.needSong, 'lip-sync shots without opts.song or opts.audio');
    var source = song ? 'song' : audio ? 'user' : null;
    var base = audio ? Math.max(0, num(audio.start, 0)) : 0;
    var total = shots.reduce(function (a, sh) { return a + sh.seconds; }, 0);
    if (source) {
      var cur = base;
      shots.forEach(function (sh) { var at = sh.audioStart != null ? sh.audioStart : cur; sh.offset = round6(at); cur = at + sh.seconds; });
    }
    var sg = null;
    if (song) {
      // long enough for every shot (a lip-sync shot reads 5 s of it); never shorter than asked
      var need = shots.reduce(function (m, sh) { return Math.max(m, sh.offset + (sh.lipSync ? S2V_AUDIO_SECONDS : sh.seconds)); }, 0);
      if (need > 120) throw LocalAIError('bad-request', 'The AI song can be at most 2 minutes long.', 'song needed up to ' + need + ' s');
      var asked = num(song.seconds, 0) > 0 ? num(song.seconds, 0) : total;
      sg = {
        lyrics: str(song.lyrics, DEFAULT_LYRICS), style: str(song.style, str(song.tags, DEFAULT_SONG_TAGS)),
        language: ACE_LANGS.indexOf(song.language) >= 0 ? song.language : 'es',
        seconds: Math.round(clamp(Math.max(asked, Math.ceil(need * 10) / 10), 5, 120) * 10) / 10,
        bpm: song.bpm ? Math.round(clamp(num(song.bpm, 100), 60, 200)) : null, keyscale: ACE_KEYS.indexOf(song.keyscale) >= 0 ? song.keyscale : null
      };
    }
    var wav = null;
    if (audio && lips.length) {
      if (audio.blob.size > MAX_AUDIO_BYTES) throw LocalAIError('bad-audio', MSG.badAudio, 'audio file is ' + audio.blob.size + ' bytes');
      wav = { start: Math.min.apply(null, lips.map(function (sh) { return sh.offset; })), end: Math.max.apply(null, lips.map(function (sh) { return sh.offset + S2V_AUDIO_SECONDS; })) };
    }
    return { shots: shots, song: sg, audio: audio, source: source, base: base, lips: lips.length, total: total, wav: wav };
  }

  // The user's song -> a mono 16-bit WAV of [start, end) seconds (silence past the end of the song).
  function decodeAudio(blob) {
    return (typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : new Response(blob).arrayBuffer()).then(function (buf) {
      var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) throw new Error('no OfflineAudioContext');
      var ac = new AC(1, 2, 44100);
      return new Promise(function (resolve, reject) {
        var p = ac.decodeAudioData(buf, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    }).then(function (ab) {
      if (!ab || !ab.length || !ab.sampleRate) throw new Error('empty audio');
      return ab;
    }).catch(function (e) { throw LocalAIError('bad-audio', MSG.badAudio, 'decode: ' + String(e && e.message || e)); });
  }
  function wavSegment(ab, start, end) {
    var sr = ab.sampleRate, n = Math.max(1, Math.round((end - start) * sr)), s0 = Math.round(start * sr);
    var dv = new DataView(new ArrayBuffer(44 + n * 2));
    function txt(o, t) { for (var k = 0; k < t.length; k++) dv.setUint8(o + k, t.charCodeAt(k)); }
    txt(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); txt(8, 'WAVE'); txt(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); txt(36, 'data'); dv.setUint32(40, n * 2, true);
    var chs = [];
    for (var c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c));
    for (var i = 0; i < n; i++) {
      var j = s0 + i, v = 0;
      if (j >= 0 && j < ab.length) { for (c = 0; c < chs.length; c++) v += chs[c][j]; v /= chs.length; }
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return new Blob([dv.buffer], { type: 'audio/wav' });
  }

  // A failed story the user did not retry is replaced by a new job: delete its files now (not in a day).
  function dropFailedStory() {
    var old = loadRec();
    if (old && old.kind === 'story' && old.failed) { clearRec(old.id); cleanupJob(old); }
  }

  function generateStory(opts, onProgress) {
    opts = opts || {};
    var signal = opts.signal || null;
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (!opts.photo || typeof opts.photo.size !== 'number') return Promise.reject(LocalAIError('bad-photo', MSG.badPhoto, 'opts.photo must be a Blob'));
    if (active) return Promise.reject(LocalAIError('busy', MSG.busy));
    var plan;
    try { plan = planStory(opts); } catch (e) { return Promise.reject(e); }
    var quality = opts.quality === 'fast' ? 'fast' : 'best';
    var st;
    return getStatus({ signal: signal }).then(function (s) {
      st = s;
      if (!packInstalled(s, 'core')) throw LocalAIError('not-installed', MSG.notInstalled);
      // lip-sync needs the Singing add-on's voice listener + singing video model, even for the user's own song
      if ((plan.lips || plan.song) && !packInstalled(s, 'singing')) throw LocalAIError('missing-pack', MSG.missingPack);
      if (!plan.wav) return null;
      return decodeAudio(plan.audio.blob).then(function (ab) {
        if (plan.shots.some(function (sh) { return sh.lipSync && sh.offset >= ab.duration - 0.25; })) throw LocalAIError('bad-audio', MSG.audioShort, 'song is ' + round2(ab.duration) + ' s');
        return wavSegment(ab, plan.wav.start, plan.wav.end);
      });
    }).then(function (wav) {
      if (signal && signal.aborted) throw abortError();
      if (active) throw LocalAIError('busy', MSG.busy);
      dropFailedStory();
      var rec = {
        v: 1, kind: 'story', id: newJobId(), clientId: 'glow-' + uuid().replace(/-/g, '').slice(0, 20), startedAt: now(), updatedAt: now(),
        quality: quality, stillModel: quality === 'fast' && packInstalled(st, 'fast') ? 'klein' : 'qwen', seed: seedOf(opts.seed),
        shots: plan.shots, song: plan.song, audioSource: plan.source,
        audio: plan.source === 'user' ? { base: plan.base, start: plan.wav ? plan.wav.start : plan.base, needed: !!plan.wav, file: null } : null,
        selfie: null, stage: 'upload', promptId: null, promptIds: [], outputs: {}, done: {}, timings: {}, failed: null
      };
      return runStory(rec, onProgress, signal, { photo: opts.photo, wav: wav, keep: !!opts.keep });
    });
  }

  function runStory(rec, onProgress, signal, opt) {
    opt = opt || {};
    if (active) return Promise.reject(LocalAIError('busy', MSG.busy));
    var token = {};
    active = token;
    rec.failed = null;
    var n = rec.shots.length;
    var steps = storySteps(rec);
    var needUpload = !rec.selfie || (needsAudioFile(rec) && !rec.audio.file);
    var stageList = ['starting'].concat(needUpload ? ['upload'] : [], steps, ['download']);
    var weights = {};
    stageList.forEach(function (s) { weights[s] = storyStepSec(rec, s); });
    var reached = null;
    var ctx = makeCtx(stageList, weights, function (p) {
      var sp = stepParts(p.stage);
      reached = p.stage;
      p.stage = sp.stage; p.shot = sp.shot; p.shots = n; p.job = rec.id;
      if (p.stillUrl) p.shotIndex = sp.shot;
      safeCall(onProgress, p);
    }, signal);
    var stills = {};   // shot index -> { blob, url }
    var socket = null;
    holdJob(rec.id);

    function stepRun(key) {
      if (rec.done[key]) return Promise.resolve();
      if (signal && signal.aborted) return Promise.reject(abortError());
      var spec = storyGraph(rec, key);
      var t0 = now();
      var resumeId = (rec.stage === key && rec.promptId) ? rec.promptId : null;
      var promptId = null;
      holdJob(rec.id);
      var check = resumeId ? promptState(resumeId, signal) : Promise.resolve(null);
      return check.then(function (state) {
        // still queued, running or finished in ComfyUI: re-attach to it (a prompt that failed is made again)
        var reuse = state === 'running' || state === 'pending' || state === 'done';
        promptId = reuse ? resumeId : uuid();
        rec.stage = key; rec.promptId = promptId; rec.stageStartedAt = reuse ? (rec.stageStartedAt || t0) : t0;
        rec.promptIds = (rec.promptIds || []).filter(function (x) { return x !== promptId; }).concat([promptId]);
        saveRec(rec);
        ctx.stage(key, 0, spec.message);
        var queued = reuse ? Promise.resolve(promptId) : queuePrompt(spec.graph, promptId, rec.clientId, signal);
        return queued.then(function () {
          return track(ctx, { graph: spec.graph, promptId: promptId, stage: key, expectSec: storyStepSec(rec, key), message: spec.message, loadingMessage: spec.loadingMessage });
        }, function (e) {
          if (isAbort(e)) return interruptPrompt(promptId).then(function () { throw e; });
          throw e;
        });
      }).then(function (h) {
        var file = pickFile(h.outputs, spec.out);
        if (!file) throw LocalAIError('failed', MSG.failed, 'no output file in history for node ' + spec.out);
        rec.outputs[key] = file;
        rec.done[key] = true;
        rec.timings[key] = Math.round((now() - (rec.stageStartedAt || t0)) / 100) / 10;
        saveRec(rec);
        var sp = stepParts(key);
        if (sp.stage === 'still') return loadStill(sp.shot);
        ctx.stage(key, 1, sp.stage === 'song' ? 'Your song is ready.' : n > 1 ? 'Shot ' + (sp.shot + 1) + ' is finished.' : 'Video finished.');
      }).catch(function (e) { if (e && typeof e === 'object' && !isAbort(e) && !e.step) e.step = key; throw e; });
    }
    function inputsReady(key) {
      var sp = stepParts(key);
      if (sp.stage === 'video') return !!rec.done['still:' + sp.shot];
      if (sp.stage === 'lipsync') return !!rec.done['still:' + sp.shot] && (rec.audioSource !== 'song' || !!rec.done.song);
      return true;
    }
    function loadStill(i) {
      return fetchFile(rec.outputs['still:' + i], signal).then(function (b) {
        stills[i] = { blob: b, url: URL.createObjectURL(b) };
        ctx.stage('still:' + i, 1, n > 1 ? 'The photo for shot ' + (i + 1) + ' is ready.' : 'Your scene photo is ready.', { stillUrl: stills[i].url });
      });
    }
    // after a reload: show the stills that are already made (one that is gone from this PC is made again)
    function preloadStills() {
      var chain = Promise.resolve();
      rec.shots.forEach(function (sh, i) {
        chain = chain.then(function () {
          if (!rec.done['still:' + i] || stills[i]) return;
          return loadStill(i).catch(function (e) {
            if (e && e.code === 'lost') { invalidate(rec, 'still:' + i); saveRec(rec); return; }
            throw e;
          });
        });
      });
      return chain;
    }
    function download() {
      var keys = rec.shots.map(function (sh, i) { return clipStep(rec, i); });
      var total = keys.length + (rec.audioSource === 'song' ? 1 : 0), got = 0;
      var blobs = [], song = null;
      ctx.stage('download', 0.05, n > 1 ? 'Saving your clips…' : 'Saving your video…');
      var chain = Promise.resolve();
      keys.forEach(function (k, i) {
        chain = chain.then(function () { return fetchFile(rec.outputs[k], signal); }).then(function (b) {
          blobs[i] = b; got++;
          ctx.stage('download', 0.05 + 0.9 * got / total, n > 1 ? 'Saving your clips…' : 'Saving your video…');
        }, function (e) { if (e && typeof e === 'object' && !e.step) e.step = k; throw e; });
      });
      if (rec.audioSource === 'song') {
        chain = chain.then(function () { return fetchFile(rec.outputs.song, signal); }).then(function (b) { song = b; }, function (e) { if (e && typeof e === 'object' && !e.step) e.step = 'song'; throw e; });
      }
      return chain.then(function () { return { blobs: blobs, song: song }; });
    }

    var p = ensureReady(ctx).then(function () {
      socket = openSocket(rec.clientId);
      ctx.socket = socket;
      return socket.ready;
    }).then(function () {
      if (!needUpload) return;
      ctx.stage('upload', 0.1, 'Sending your photo to the AI engine…');
      var up = rec.selfie ? Promise.resolve() : preparePhoto(opt.photo).then(function (ph) {
        return uploadImage(ph.blob, 'selfie_' + rec.id + '.' + ph.ext, signal);
      }).then(function (name) { rec.selfie = name; saveRec(rec); });
      return up.then(function () {
        if (!needsAudioFile(rec) || rec.audio.file) return;
        if (!opt.wav) throw LocalAIError('lost', MSG.lost, 'the song was never sent to the engine');
        ctx.stage('upload', 0.6, 'Sending your song to the AI engine…');
        return uploadImage(opt.wav, 'audio_' + rec.id + '.wav', signal).then(function (name) { rec.audio.file = name; saveRec(rec); });
      }).then(function () { ctx.stage('upload', 1, 'Sent.'); });
    }).then(preloadStills).then(function () {
      // after a reload the step that was in flight goes first: ComfyUI finishes its prompt before anything new
      // (re-attached, not queued again); only when what it was made from is still there
      var order = steps.slice();
      if (rec.promptId && order.indexOf(rec.stage) > 0 && !rec.done[rec.stage] && inputsReady(rec.stage)) {
        order.splice(order.indexOf(rec.stage), 1);
        order.unshift(rec.stage);
      }
      var chain = Promise.resolve();
      order.forEach(function (k) { chain = chain.then(function () { return stepRun(k); }); });
      return chain;
    }).then(function () {
      var chain = Promise.resolve();
      rec.shots.forEach(function (sh, i) { chain = chain.then(function () { if (!stills[i]) return loadStill(i); }); });
      return chain;
    }).then(download).then(function (d) {
      var fast = rec.quality === 'fast';
      var offsets = rec.audioSource ? {} : null;
      var clips = rec.shots.map(function (sh, i) {
        var lip = !!sh.lipSync;
        var c = { id: sh.id, video: d.blobs[i], width: lip || !fast ? 480 : 384, height: lip || !fast ? 832 : 672, fps: lip ? 16 : 32,
          seconds: sh.seconds, stillUrl: stills[i].url, still: stills[i].blob, lipSync: lip };
        if (offsets) { offsets[sh.id] = sh.offset; c.audioOffset = sh.offset; }
        return c;
      });
      var t = { stills: {}, clips: {}, song: rec.timings.song || 0, total: Math.round((now() - rec.startedAt) / 1000) };
      rec.shots.forEach(function (sh, i) { t.stills[sh.id] = rec.timings['still:' + i] || 0; t.clips[sh.id] = rec.timings[clipStep(rec, i)] || 0; });
      var result = {
        clips: clips, seconds: round6(rec.shots.reduce(function (a, sh) { return a + sh.seconds; }, 0)),
        audioSource: rec.audioSource, seed: rec.seed, timings: t, quality: rec.quality, stillModel: rec.stillModel, job: rec.id
      };
      if (d.song) { result.audio = d.song; result.songSeconds = rec.song.seconds; }
      if (offsets) result.songOffsets = offsets;
      ctx.stage('download', 1, 'Done!');
      if (opt.keep) { rec.delivered = true; saveRec(rec); } // kept until release(job)
      else { clearRec(rec.id); cleanupJob(rec); }
      return result;
    });

    return p.then(function (r) { finish(); return r; }, function (e) {
      finish();
      // the soundtrack file is gone from the engine: the AI song can be made again, the user's song cannot
      var audioGone = !!(e && e.step && /^lipsync:/.test(e.step) && /Invalid audio file/i.test(String(e.detail || '')));
      var keepIt = !isAbort(e) && !!rec.selfie && !(e && NON_RESUMABLE.test(e.code || '')) && !(audioGone && rec.audioSource !== 'song');
      if (keepIt) {
        if (audioGone) invalidate(rec, 'song');
        // a file that is gone from this PC is made again by the retry
        if (e && (e.code === 'missing-still' || e.code === 'lost') && e.step) {
          var sp = stepParts(e.step);
          if (e.code === 'missing-still' && sp.shot != null) invalidate(rec, 'still:' + sp.shot);
          else if (rec.done[e.step]) invalidate(rec, e.step);
        }
        rec.failed = { code: (e && e.code) || 'failed', step: (e && e.step) || rec.stage, message: (e && e.message) || MSG.failed, at: now() };
        saveRec(rec);
      } else {
        clearRec(rec.id);
        cleanupJob(rec, isAbort(e) ? 3000 : 0); // after an abort, give the interrupted prompt a moment to stop writing
      }
      if (e && typeof e === 'object' && !isAbort(e)) {
        var sp2 = stepParts(e.step || reached);
        e.resumable = keepIt;
        e.job = rec.id;
        if (!e.stage) e.stage = sp2.stage;  // where it stopped ('starting' = the engine never got going)
        if (e.shot == null) e.shot = sp2.shot;
        e.shotsDone = rec.shots.filter(function (sh, i) { return rec.done[clipStep(rec, i)]; }).length;
        e.stillUrls = rec.shots.map(function (sh, i) { return stills[i] ? stills[i].url : null; });
        var first = e.stillUrls.filter(Boolean)[0];
        if (first) e.stillUrl = first;
      }
      throw e;
    });
    function finish() { if (socket) socket.close(); if (active === token) active = null; holdJob(rec.id, true); }
  }

  function resumeStory(rec, s) {
    var ready = s.engine.state === 'ready';
    var steps = storySteps(rec);
    var made = steps.every(function (k) { return rec.done[k]; });
    var st = rec.failed ? Promise.resolve('failed') : made ? Promise.resolve('done')
      : rec.promptId && ready ? promptState(rec.promptId).catch(function () { return 'unknown'; }) : Promise.resolve(rec.promptId ? (ready ? 'unknown' : 'lost') : 'not-started');
    return st.then(function (state) {
      var sp = stepParts(rec.stage);
      var canAttach = !!rec.selfie && (!needsAudioFile(rec) || !!rec.audio.file);
      return {
        kind: 'story', promptId: rec.promptId, job: rec.id, stage: sp.stage, shot: sp.shot, shots: rec.shots.length,
        shotIds: rec.shots.map(function (sh) { return sh.id; }), state: state, startedAt: rec.startedAt, quality: rec.quality, seed: rec.seed,
        song: !!rec.song, audioSource: rec.audioSource, lipSync: rec.shots.filter(function (sh) { return sh.lipSync; }).length,
        stillsReady: rec.shots.filter(function (sh, i) { return rec.done['still:' + i]; }).length,
        shotsDone: rec.shots.filter(function (sh, i) { return rec.done[clipStep(rec, i)]; }).length,
        failed: rec.failed ? { code: rec.failed.code, message: rec.failed.message, stage: stepParts(rec.failed.step).stage, shot: stepParts(rec.failed.step).shot } : null,
        made: made, delivered: !!rec.delivered, canAttach: canAttach,
        // continue the story (from the shot that failed, after a failure): resolves with the same StoryResult as generateStory()
        attach: function (onProgress, o) {
          var cur = loadRec();
          if (!cur || cur.id !== rec.id) return Promise.reject(LocalAIError('lost', MSG.lost, 'job record gone'));
          if (!cur.selfie || (needsAudioFile(cur) && !cur.audio.file)) { clearRec(cur.id); cleanupJob(cur); return Promise.reject(LocalAIError('lost', MSG.lost, 'the photo or song was never sent to the engine')); }
          return runStory(cur, onProgress, o && o.signal, { keep: !!(o && o.keep) });
        },
        cancel: function () { var id = rec.promptId; clearRec(rec.id); var live = id && !made && !rec.failed; var c = live ? interruptPrompt(id) : Promise.resolve(); return c.then(function () { cleanupJob(rec, live ? 3000 : 0); }); },
        discard: function () { clearRec(rec.id); cleanupJob(rec); }
      };
    });
  }

  // Honest minutes for a story on this PC (desktop RTX 5060 8 GB, from the spec's timings; laptop +20–40 %).
  // Per shot: photo 1–1.5 min (Fast pack 15–27 s), dance video 3.7–6.5 min (Fast 2.2–4), lip-sync 4.5–7 min;
  // the song 0.5–1.5 min; 0.2–1 min each time another AI model has to be loaded; 0.5–1.5 min to read the first
  // model from disk. A 20 s story (4 shots) is about 20–35 min, with the song and one lip-sync shot about 21–39 min.
  var STORY_MIN = { stillQwen: [1, 1.5], stillKlein: [0.25, 0.45], swap: [0.2, 1], song: [0.5, 1.5], video: [3.7, 6.5], videoFast: [2.2, 4], s2v: [4.5, 7], cold: [0.5, 1.5] };
  function estimateStory(o) {
    o = o || {};
    var shots = o.shots, n, lip = 0;
    if (Array.isArray(shots)) { n = shots.length; lip = shots.filter(function (s) { return s && s.lipSync; }).length; }
    else n = Math.round(num(shots, 4));
    n = clamp(n || 1, 1, MAX_SHOTS);
    if (typeof o.lipSync === 'number') lip = clamp(Math.round(o.lipSync), 0, n);
    else if (o.lipSync === true && !lip) lip = n;                // "Lip-sync to the song": every shot
    else if (o.lipSync === false) lip = 0;
    var fast = o.quality === 'fast';
    var hasFast = typeof o.fastPack === 'boolean' ? o.fastPack : packInstalled(lastStatus, 'fast') || !lastStatus;
    var song = !!o.song;
    var lo = 0, hi = 0;
    function add(r, k) { k = k == null ? 1 : k; lo += r[0] * k; hi += r[1] * k; }
    add(STORY_MIN.cold);
    add(fast && hasFast ? STORY_MIN.stillKlein : STORY_MIN.stillQwen, n);
    add(STORY_MIN.swap, (song ? 1 : 0) + (n - lip > 0 ? 1 : 0) + (lip > 0 ? 1 : 0));
    if (song) add(STORY_MIN.song);
    add(fast ? STORY_MIN.videoFast : STORY_MIN.video, n - lip);
    add(STORY_MIN.s2v, lip);
    var laptop = isLaptop(o);
    if (laptop) { lo *= 1.2; hi *= 1.4; }
    var a = Math.max(1, Math.round(lo)), b = Math.max(a + 1, Math.ceil(hi));
    return {
      minutes: [a, b], shots: n, lipSync: lip, laptop: laptop,
      seconds: round2((n - lip) * I2V_SECONDS + lip * S2V_SECONDS),
      note: 'Estimate for an RTX 5060 with 8 GB. Starting the AI engine first adds about a minute.'
    };
  }

  // Re-attach to a job that was running when the page was reloaded (or one kept with {keep: true}).
  function resume() {
    var rec = loadRec();
    if (!rec) return Promise.resolve(null);
    if (now() - (rec.updatedAt || 0) > CFG.maxJobAgeMs) { clearRec(rec.id); cleanupJob(rec); return Promise.resolve(null); }
    return detect().then(function (s) {
      if (!s) return null;
      if (rec.kind === 'story') return resumeStory(rec, s);
      var ready = s.engine.state === 'ready';
      // every stage is done: only the outputs are fetched again (they are files on disk, whatever ComfyUI remembers)
      var made = !!(rec.done && rec.done.video);
      var st = made ? Promise.resolve('done')
        : rec.promptId && ready ? promptState(rec.promptId).catch(function () { return 'unknown'; }) : Promise.resolve(rec.promptId ? (ready ? 'unknown' : 'lost') : 'not-started');
      return st.then(function (state) {
        return {
          kind: 'video', promptId: rec.promptId, job: rec.id, stage: rec.stage, state: state, startedAt: rec.startedAt, quality: rec.quality,
          singing: !!rec.singing, lipSync: !!(rec.singing && rec.singing.lipSync), seed: rec.seed, stillReady: !!rec.done.still,
          made: made, delivered: !!rec.delivered,
          canAttach: !!rec.selfie,
          // continue the job: waits for the running prompt, runs what is left, resolves with the same Result as generate()
          // (o.keep: keep the record until release(job), as with generate)
          attach: function (onProgress, o) {
            var cur = loadRec();
            if (!cur || cur.id !== rec.id) return Promise.reject(LocalAIError('lost', MSG.lost, 'job record gone'));
            if (!cur.selfie) { clearRec(cur.id); cleanupJob(cur); return Promise.reject(LocalAIError('lost', MSG.lost, 'photo was never uploaded')); }
            return runJob(cur, onProgress, o && o.signal, { keep: !!(o && o.keep) });
          },
          cancel: function () { var id = rec.promptId; clearRec(rec.id); var c = id && !made ? interruptPrompt(id) : Promise.resolve(); return c.then(function () { cleanupJob(rec, id && !made ? 3000 : 0); }); },
          discard: function () { clearRec(rec.id); cleanupJob(rec); }
        };
      });
    });
  }

  // Tiny still to load the photo model into memory and prove the engine works. Resolves {seconds, stillBlob, stillUrl}.
  function warmup(onProgress, opt) {
    opt = opt || {};
    var signal = opt.signal || null;
    if (active) return Promise.reject(LocalAIError('busy', MSG.busy));
    var token = {};
    active = token;
    var rec = { clientId: 'glow-' + uuid().replace(/-/g, '').slice(0, 20), stillModel: 'qwen' };
    var ctx = makeCtx(['starting', 'upload', 'still', 'download'], { starting: STAGE_SEC.starting, upload: 2, still: 90, download: 2 }, onProgress, signal);
    var socket = null, t0 = now();
    var p = getStatus({ signal: signal }).then(function (s) {
      if (opt.quality === 'fast' && packInstalled(s, 'fast')) rec.stillModel = 'klein';
      return ensureReady(ctx);
    }).then(function () {
      socket = openSocket(rec.clientId); ctx.socket = socket; return socket.ready;
    }).then(function () { ctx.stage('upload', 0.2, 'Preparing a quick test…'); return testImage(); }).then(function (b) {
      t0 = now();
      return uploadImage(b, 'warmup.png', signal);
    }).then(function (name) {
      // A new seed and file prefix every time: ComfyUI caches node results, and the same graph twice would be
      // answered from that cache without loading or running anything (and the timing would be meaningless).
      var g = graphs.still({ image: name, prompt: 'A realistic photo of the same person from Picture 1 standing in a softly lit room, natural light.', seed: randomSeed(), job: 'warmup' + newJobId(), model: rec.stillModel, width: 368, height: 640 });
      var promptId = uuid();
      ctx.stage('still', 0, 'Loading the photo model… (1–3 minutes the first time)');
      return queuePrompt(g, promptId, rec.clientId, signal).then(function () {
        return track(ctx, { graph: g, promptId: promptId, stage: 'still', expectSec: 90, message: 'Testing the photo model…', loadingMessage: 'Loading the photo model… (1–3 minutes the first time)' });
      }, function (e) {
        if (isAbort(e)) return interruptPrompt(promptId).then(function () { throw e; });
        throw e;
      }).then(function (h) {
        var f = pickFile(h.outputs, OUTPUT_NODE[rec.stillModel === 'klein' ? 'stillKlein' : 'stillQwen']);
        if (!f) throw LocalAIError('failed', MSG.failed, 'no warm-up output');
        rec.cached = cachedInfo(h, g);
        return fetchFile(f, signal);
      });
    }).then(function (b) {
      ctx.stage('download', 1, 'Warm-up finished.');
      var c = rec.cached || {};
      // modelsWereLoaded: every model loader was answered from ComfyUI's cache (an earlier job had loaded them)
      return { seconds: Math.round((now() - t0) / 100) / 10, stillBlob: b, stillUrl: URL.createObjectURL(b), modelsWereLoaded: !!c.loaders, cached: !!c.all };
    });
    function fin() { if (socket) socket.close(); if (active === token) active = null; }
    return p.then(function (r) { fin(); return r; }, function (e) { fin(); throw e; });
  }
  // Which nodes of graph g ComfyUI answered from its cache ('execution_cached' in the history status messages).
  function cachedInfo(h, g) {
    var cached = {};
    ((h && h.status && h.status.messages) || []).forEach(function (m) {
      if (Array.isArray(m) && m[0] === 'execution_cached' && m[1] && Array.isArray(m[1].nodes)) m[1].nodes.forEach(function (id) { cached[String(id)] = true; });
    });
    var ids = Object.keys(g), loaders = ids.filter(function (id) { return /Loader/.test(g[id].class_type); });
    return {
      all: ids.length > 0 && ids.every(function (id) { return cached[id]; }),
      loaders: loaders.length > 0 && loaders.every(function (id) { return cached[id]; })
    };
  }
  function testImage() {
    // a plain head-and-shoulders silhouette, enough for the encoder to have "a person" to work with
    var c = document.createElement('canvas');
    c.width = 512; c.height = 640;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 640);
    g.addColorStop(0, '#6d5a8f'); g.addColorStop(1, '#2a2140');
    x.fillStyle = g; x.fillRect(0, 0, 512, 640);
    x.fillStyle = '#e0b89a';
    x.beginPath(); x.ellipse(256, 250, 92, 118, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#3b2a22';
    x.beginPath(); x.ellipse(256, 175, 100, 70, 0, Math.PI, 0); x.fill();
    x.fillStyle = '#c0407a';
    x.beginPath(); x.ellipse(256, 640, 220, 200, 0, Math.PI, 0); x.fill();
    return new Promise(function (resolve, reject) { c.toBlob(function (b) { b ? resolve(b) : reject(LocalAIError('failed', MSG.failed, 'canvas')); }, 'image/png'); });
  }

  /* ------------------------------------------------------------------ *
   * Estimates
   * ------------------------------------------------------------------ */
  function isLaptop(o) {
    if (o && typeof o.laptop === 'boolean') return o.laptop;
    var name = (o && o.gpuName) || (lastStatus && lastStatus.gpu && lastStatus.gpu.name) || '';
    return /laptop|mobile|max-q/i.test(name);
  }
  function estimate(o) {
    o = o || {};
    var fast = o.quality === 'fast';
    var hasFast = typeof o.fastPack === 'boolean' ? o.fastPack : packInstalled(lastStatus, 'fast') || !lastStatus;
    var singing = !!o.singing;
    var lip = singing && !(o.singing && typeof o.singing === 'object' && o.singing.lipSync === false);
    var key = singing ? (lip ? 'sing' : (fast ? 'songFast' : 'songBest')) : (fast ? (hasFast ? 'fast' : 'fastNoPack') : 'best');
    var laptop = isLaptop(o);
    var m = ESTIMATES[key][laptop ? 'laptop' : 'desktop'];
    return {
      minutes: [m[0], m[1]], key: key, laptop: laptop,
      note: 'Estimate for an RTX 5060 with 8 GB. The first video after starting the engine takes about a minute longer.'
    };
  }
  // GB of free space a choice of packs needs — the launcher's own rule: what is still to download (partial downloads
  // count as done) + about 8 GB to unpack the engine + the launcher's safety margin (diskMarginGB, 10 GB).
  function diskNeededGB(packIds, s) {
    s = s || lastStatus;
    var total = 0;
    normPacks(packIds).forEach(function (id) {
      if (packInstalled(s, id)) return;
      var sp = s && s.packs && s.packs[id];
      var def = PACKS.filter(function (p) { return p.id === id; })[0];
      var left = sp && typeof sp.remainingGB === 'number' && sp.remainingGB >= 0 ? sp.remainingGB : (sp && num(sp.sizeGB, 0)) || def.sizeGB;
      total += left;
    });
    // the unpacked engine (embedded Python + CUDA PyTorch) next to the models, unless it is unpacked already (comfyVersion is known)
    if (!packInstalled(s, 'core') && !(s && s.engine && s.engine.comfyVersion)) total += 8;
    return Math.ceil(total + (s && typeof s.diskMarginGB === 'number' ? s.diskMarginGB : 10));
  }
  function friendlyFile(name) {
    if (!name) return '';
    var base = String(name).split(/[\\/]/).pop().replace(/\.part$/, '');
    return FILES[base] || 'AI files';
  }

  window.GlowLocalAI = {
    version: VERSION,
    packs: PACKS.map(function (p) { return { id: p.id, label: p.label, sizeGB: p.sizeGB, desc: p.desc, required: !!p.required, experimental: !!p.experimental }; }),
    detect: detect,
    status: status,
    install: install,
    cancel: cancel,
    start: start,
    stop: stop,
    openLogs: openLogs,
    waitReady: waitReady,
    estimate: estimate,
    estimateStory: estimateStory,
    generate: generate,
    generateStory: generateStory,
    // story limits: 1–4 shots; clip lengths in seconds (a dance clip 5.03 s at 32 fps, a lip-sync clip 4.81 s at 16 fps)
    story: { maxShots: MAX_SHOTS, clipSeconds: { video: I2V_SECONDS, lipSync: S2V_SECONDS }, lipSyncAudioSeconds: S2V_AUDIO_SECONDS },
    resume: resume,
    release: release,
    warmup: warmup,
    graphs: graphs,
    diskNeededGB: diskNeededGB,
    // plain-words reason (+ code, detail) for an engine in state 'error'
    explainEngineError: function (s) { var e = engineErrorFrom(s || lastStatus); return { code: e.code, message: e.message, detail: e.detail || '' }; },
    friendlyFile: friendlyFile,
    // true when a launcher message is already a plain sentence for people (show it as is), false for raw errors
    isPlainMessage: launcherSentence,
    isBusy: function () { return !!active; },
    minDriver: '580.00',
    vcRedistUrl: 'https://aka.ms/vc14/vc_redist.x64.exe',
    driverUrl: 'https://www.nvidia.com/Download/index.aspx'
  };
})();
