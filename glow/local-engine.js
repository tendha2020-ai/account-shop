/* Glow Studio — free local AI engine client (local-engine.js) -> window.GlowLocalAI
 *
 * Talks to the Glow Studio Windows launcher, which installs and runs a private ComfyUI (v0.44.0 portable) on this PC
 * and exposes it under the page's own origin:
 *   /__glow/engine/{status,install,cancel,start,stop}   launcher endpoints (JSON)
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
 * re-attach with GlowLocalAI.resume().
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
    engineStopped: 'The AI engine stopped. Open “Free AI on this PC” and press “Start engine”.',
    readyTimeout: 'The AI engine is taking too long to start. Close other heavy apps and try again.',
    busy: 'A video is already being made on this PC. Please wait for it to finish.',
    installBusy: 'A download is already running.',
    oom: 'Your PC ran out of graphics memory. Close games, video apps and extra browser tabs, then try again — or switch to Fast mode.',
    missingModel: 'Some AI files are missing or damaged. Open “Free AI on this PC” and choose “Repair” to fix them.',
    driver: 'Your NVIDIA driver is too old for the AI engine. Please update it, restart your PC and try again.',
    badPhoto: 'This photo couldn’t be used. Please try another photo (JPEG or PNG).',
    missingStill: 'The picture from the first step is missing. Please start the video again.',
    interrupted: 'The video was stopped before it was finished.',
    lost: 'The AI engine restarted, so this video was lost. Please try again.',
    failed: 'Something went wrong while making the video. Please try again.',
    rejected: 'The AI engine didn’t accept this job. Open “Free AI on this PC” and choose “Repair”.',
    download: 'The finished video couldn’t be loaded from the AI engine. Please try again.'
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
    return request('GET', ENGINE + '/status', undefined, { timeout: (opt && opt.timeout) || 8000, signal: opt && opt.signal }).then(function (res) {
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
    return getStatus({ timeout: 5000 }).catch(function () { return null; });
  }
  function status() { return getStatus(); }

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
  function install(packs, installDir) {
    var body = { packs: normPacks(packs) };
    if (typeof installDir === 'string' && installDir.trim()) body.installDir = installDir.trim();
    return postEngine('/install', body, 'install-failed', 'The download couldn’t start. Please try again.');
  }
  function cancel() { return postEngine('/cancel', {}, 'cancel-failed', 'The download couldn’t be paused.'); }
  function start() { return postEngine('/start', {}, 'engine-failed', MSG.engineFailed); }
  function stop() { return postEngine('/stop', {}, 'stop-failed', 'The AI engine couldn’t be stopped.'); }

  function engineErrorFrom(s) {
    var log = (s && s.engine && s.engine.log) || [];
    var text = log.join('\n') + '\n' + ((s && s.engine && s.engine.error) || '');
    var msg = MSG.engineFailed;
    if (/c10\.dll|vcruntime|msvcp|VC\+\+|WinError 126/i.test(text)) {
      msg = 'The AI engine needs a free Microsoft component (Visual C++ Redistributable). Install it from aka.ms/vc14/vc_redist.x64.exe, then press “Start engine” again.';
    } else if (/driver|CUDA (?:error|driver)|no kernel image|cudaGetDeviceCount/i.test(text)) {
      msg = MSG.driver;
    } else if (/out of memory|not enough memory|MemoryError/i.test(text)) {
      msg = MSG.oom;
    } else if (launcherSentence(s && s.engine && s.engine.error)) {
      msg = s.engine.error.trim(); // the launcher already explains it in plain words (e.g. "Another program was using the AI engine's port…")
    }
    return LocalAIError('engine-failed', msg, text.trim().slice(-4000));
  }

  // A launcher error that reads like a sentence for people (not a raw exit code or Python error).
  function launcherSentence(t) {
    return typeof t === 'string' && t.trim().length > 12 && t.length < 400 && /^[A-Z]/.test(t.trim()) &&
      !/exited with code|Traceback|Exception|Error:|errno|0x[0-9a-f]{6,}/i.test(t);
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
    var ctx = makeCtx(stageList, weights, onProgress, signal);
    var result = { stillBlob: null, stillUrl: null, video: null, audio: undefined };
    var socket = null;

    function stageRun(stage) {
      if (rec.done[stage]) return Promise.resolve();
      var spec = graphFor(rec, stage);
      var t0 = now();
      var resumeId = (rec.stage === stage && rec.promptId) ? rec.promptId : null;
      var promptId = null;
      var check = resumeId ? promptState(resumeId, signal) : Promise.resolve(null);
      return check.then(function (state) {
        var reuse = !!state && state !== 'lost';   // still queued/running/finished in ComfyUI: re-attach to it
        promptId = reuse ? resumeId : uuid();
        rec.stage = stage; rec.promptId = promptId; rec.stageStartedAt = reuse ? (rec.stageStartedAt || t0) : t0;
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
      clearRec(rec.id);
      return result;
    });

    return p.then(function (r) { finish(); return r; }, function (e) {
      finish();
      if (isAbort(e) || (e && /^(failed|oom|missing-model|missing-still|bad-photo|rejected|interrupted|lost|driver)$/.test(e.code))) clearRec(rec.id);
      if (result.stillUrl && !isAbort(e)) e.stillUrl = result.stillUrl; // let the UI keep the still that did work
      throw e;
    });
    function finish() { if (socket) socket.close(); if (active === token) active = null; }
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
      if (!rec.prompts.motion) rec.prompts.motion = 'The person dances happily toward the camera, smiling, natural motion, handheld smartphone video.';
      return runJob(rec, onProgress, signal, { photo: opts.photo });
    });
  }

  // Re-attach to a job that was running when the page was reloaded.
  function resume() {
    var rec = loadRec();
    if (!rec) return Promise.resolve(null);
    if (now() - (rec.updatedAt || 0) > CFG.maxJobAgeMs) { clearRec(rec.id); return Promise.resolve(null); }
    return detect().then(function (s) {
      if (!s) return null;
      var ready = s.engine.state === 'ready';
      var st = rec.promptId && ready ? promptState(rec.promptId).catch(function () { return 'unknown'; }) : Promise.resolve(rec.promptId ? (ready ? 'unknown' : 'lost') : 'not-started');
      return st.then(function (state) {
        return {
          promptId: rec.promptId, job: rec.id, stage: rec.stage, state: state, startedAt: rec.startedAt, quality: rec.quality,
          singing: !!rec.singing, lipSync: !!(rec.singing && rec.singing.lipSync), seed: rec.seed, stillReady: !!rec.done.still,
          canAttach: !!rec.selfie,
          // continue the job: waits for the running prompt, runs what is left, resolves with the same Result as generate()
          attach: function (onProgress, o) {
            var cur = loadRec();
            if (!cur || cur.id !== rec.id) return Promise.reject(LocalAIError('lost', MSG.lost, 'job record gone'));
            if (!cur.selfie) { clearRec(cur.id); return Promise.reject(LocalAIError('lost', MSG.lost, 'photo was never uploaded')); }
            return runJob(cur, onProgress, o && o.signal);
          },
          cancel: function () { var id = rec.promptId; clearRec(rec.id); return id ? interruptPrompt(id).then(function () {}) : Promise.resolve(); },
          discard: function () { clearRec(rec.id); }
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
      var g = graphs.still({ image: name, prompt: 'A realistic photo of the same person from Picture 1 standing in a softly lit room, natural light.', seed: 1, job: 'warmup', model: rec.stillModel, width: 368, height: 640 });
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
        return fetchFile(f, signal);
      });
    }).then(function (b) {
      ctx.stage('download', 1, 'Warm-up finished.');
      return { seconds: Math.round((now() - t0) / 100) / 10, stillBlob: b, stillUrl: URL.createObjectURL(b) };
    });
    function fin() { if (socket) socket.close(); if (active === token) active = null; }
    return p.then(function (r) { fin(); return r; }, function (e) { fin(); throw e; });
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
    waitReady: waitReady,
    estimate: estimate,
    generate: generate,
    resume: resume,
    warmup: warmup,
    graphs: graphs,
    diskNeededGB: diskNeededGB,
    // plain-words reason (+ code, detail) for an engine in state 'error'
    explainEngineError: function (s) { var e = engineErrorFrom(s || lastStatus); return { code: e.code, message: e.message, detail: e.detail || '' }; },
    friendlyFile: friendlyFile,
    isBusy: function () { return !!active; },
    minDriver: '580.00',
    vcRedistUrl: 'https://aka.ms/vc14/vc_redist.x64.exe',
    driverUrl: 'https://www.nvidia.com/Download/index.aspx'
  };
})();
