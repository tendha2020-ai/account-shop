// Catalog of everything the free local AI engine downloads.
//
// Generated from local-ai-spec.json (researched 2026-11-04): exact file names,
// ComfyUI model folders, canonical Hugging Face URLs, byte sizes and sha256
// values (Hugging Face x-linked-size / x-linked-etag). The two engine files have
// no published sha256: the portable .7z is checked by its exact size, its 7z
// signature and 7-Zip's own CRCs while unpacking; 7zr.exe is pinned to the
// sha256 of the 7-Zip 26.05 build served on 2026-11-04 (see sizeFlexible).
//
// Packs: "core" (dance and party scenes, always installed), "singing" (ACE-Step
// 1.5 song + Wan2.2-S2V lip-sync, experimental) and "fast" (FLUX.2 klein 4B
// still). Everything is Apache-2.0 or MIT. The optional "1022" A/B LoRAs and
// the fp8mixed Qwen alternative from the spec are deliberately not shipped.
package main

const (
	launcherVersion = "1.1.0"
	comfyVersion    = "0.44.0"
	catalogVersion  = "2026-11-04"
	portableDir     = "ComfyUI_windows_portable" // top folder inside the portable .7z
	minDriverMajor  = 580                        // CUDA 13 (cu130 PyTorch) needs the R580 driver branch
	minDriverText   = "580.00"
	diskMarginBytes = 10 * 1e9 // keep 10 GB free on top of what the install needs
	// Rough unpacked size of the portable (embedded Python + CUDA PyTorch); only
	// used for the free-space check before unpacking.
	engineUnpackedBytes = 8 * 1e9
)

// FileSpec is one file the installer downloads.
type FileSpec struct {
	Label  string `json:"label"`            // plain words for the progress text
	Name   string `json:"name"`             // file name on disk
	Folder string `json:"folder,omitempty"` // ComfyUI\models\<folder>; empty = <installDir>\downloads
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
	// SizeFlexible: the URL is not versioned (7zr.exe). If the server sends the
	// pinned size the sha256 must match; any other size in [MinSize, MaxSize]
	// is accepted when the file starts with Magic.
	SizeFlexible bool   `json:"sizeFlexible,omitempty"`
	MinSize      int64  `json:"minSize,omitempty"`
	MaxSize      int64  `json:"maxSize,omitempty"`
	Magic        string `json:"magic,omitempty"` // hex prefix the file must start with
	License      string `json:"license,omitempty"`
}

// PackSpec is a group of model files the user can choose.
type PackSpec struct {
	ID    string     `json:"id"`
	Label string     `json:"label"`
	Desc  string     `json:"desc"`
	Files []FileSpec `json:"files"`
}

// Catalog is everything the installer knows how to fetch. GLOW_ENGINE_CATALOG
// can point at a JSON file of the same shape (tests use tiny mock files).
type Catalog struct {
	Tool   FileSpec   `json:"tool"`   // 7zr.exe, used once to unpack the engine
	Engine FileSpec   `json:"engine"` // ComfyUI Windows portable .7z
	Packs  []PackSpec `json:"packs"`
}

func (c *Catalog) pack(id string) *PackSpec {
	for i := range c.Packs {
		if c.Packs[i].ID == id {
			return &c.Packs[i]
		}
	}
	return nil
}

// packBytes is the full download size of a pack; core includes the engine.
func (c *Catalog) packBytes(id string) int64 {
	p := c.pack(id)
	if p == nil {
		return 0
	}
	var n int64
	for _, f := range p.Files {
		n += f.Size
	}
	if id == "core" {
		n += c.Tool.Size + c.Engine.Size
	}
	return n
}

var packText = map[string][2]string{
	"core":    {"Dance & party scenes", "Turns one selfie into a short video of you dancing in a party hall, a club or with friends. Needed for everything else."},
	"singing": {"Singing add-on (experimental)", "Makes a Spanish party song for your video, and a slow lip-sync clip of you singing it."},
	"fast":    {"Fast mode", "A lighter photo model: pictures are about 3 times faster, but look a bit less like you."},
}

func builtinCatalog() *Catalog {
	c := &Catalog{
		Tool: FileSpec{Label: "Unpacking tool (7-Zip)", Name: "7zr.exe", URL: "https://www.7-zip.org/a/7zr.exe",
			Size: 602624, SHA256: "256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282",
			SizeFlexible: true, MinSize: 200 << 10, MaxSize: 8 << 20, Magic: "4d5a", License: "LGPL-2.1 (7-Zip)"},
		Engine: FileSpec{Label: "AI engine (ComfyUI " + comfyVersion + ")", Name: "ComfyUI_windows_portable_nvidia.7z",
			URL:  "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.44.0/ComfyUI_windows_portable_nvidia.7z",
			Size: 2054382457, Magic: "377abcaf271c", License: "GPL-3.0 (ComfyUI)"},
		Packs: []PackSpec{
			{ID: "core", Files: []FileSpec{
				{Label: "Photo model (Qwen Image Edit 2511)", Name: "qwen_image_edit_2511_int8_convrot.safetensors", Folder: "diffusion_models", Size: 20499083824,
					SHA256:  "11b5af5ac601821d73930c84846c9a158e67177356daf927ce1c8d10f3963829",
					URL:     "https://huggingface.co/Comfy-Org/Qwen-Image-Edit/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors",
					License: "Apache-2.0 (Qwen/Qwen-Image-Edit-2511 and Comfy-Org repo)"},
				{Label: "Photo speed-up add-on", Name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", Folder: "loras", Size: 849608296,
					SHA256:  "22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f",
					URL:     "https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
					License: "Apache-2.0"},
				{Label: "Photo model, language part", Name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", Folder: "text_encoders", Size: 9384670680,
					SHA256:  "cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4",
					URL:     "https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
					License: "Apache-2.0"},
				{Label: "Photo model, colour decoder", Name: "qwen_image_vae.safetensors", Folder: "vae", Size: 253806246,
					SHA256:  "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
					URL:     "https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files/vae/qwen_image_vae.safetensors",
					License: "Apache-2.0"},
				{Label: "Video model, part 1 of 2 (Wan 2.2)", Name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", Folder: "diffusion_models", Size: 14294742832,
					SHA256:  "6122e79d55e0f235698d11d657f3b196c5273c830da00b2b013c5a048d5e6a42",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
					License: "Apache-2.0"},
				{Label: "Video model, part 2 of 2 (Wan 2.2)", Name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", Folder: "diffusion_models", Size: 14294742832,
					SHA256:  "5471a457b6ac404202a5fbe6c11595a3d5641fc766b00f38763f72303fffc21e",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
					License: "Apache-2.0"},
				{Label: "Video speed-up add-on, part 1 of 2", Name: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", Folder: "loras", Size: 1226977424,
					SHA256:  "d176c808d6fc461999b68e321efcb7501b20b8c3797523ed0df14f7d1deff11e",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
					License: "Apache-2.0"},
				{Label: "Video speed-up add-on, part 2 of 2", Name: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", Folder: "loras", Size: 1226977424,
					SHA256:  "024f21de095bc8fad9809ded3e9e49a2e170dcf27075da8145ba7d60d8aab7f9",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
					License: "Apache-2.0"},
				{Label: "Video model, language part", Name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", Folder: "text_encoders", Size: 6735906897,
					SHA256:  "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.1/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
					License: "Apache-2.0"},
				{Label: "Video model, decoder", Name: "wan_2.1_vae.safetensors", Folder: "vae", Size: 253815318,
					SHA256:  "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/vae/wan_2.1_vae.safetensors",
					License: "Apache-2.0"},
				{Label: "Smooth-motion add-on (RIFE)", Name: "rife_v4.26.safetensors", Folder: "frame_interpolation", Size: 22674688,
					SHA256:  "151874592c877740e5db11522f4514df569eeafb0a0fcb2696f16e9e8d317c94",
					URL:     "https://huggingface.co/Comfy-Org/Frame-Interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors",
					License: "MIT (RIFE); Comfy-Org repo tagged 'mit-and-apache-2.0'"},
			}},
			{ID: "singing", Files: []FileSpec{
				{Label: "Song maker (ACE-Step 1.5)", Name: "acestep_v1.5_turbo.safetensors", Folder: "diffusion_models", Size: 4787825604,
					SHA256:  "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7",
					URL:     "https://huggingface.co/Comfy-Org/ACE-Step-1.5/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors",
					License: "MIT upstream (ACE-Step/Ace-Step1.5); Comfy-Org repack tagged Apache-2.0"},
				{Label: "Song maker, lyrics reader", Name: "qwen_0.6b_ace15.safetensors", Folder: "text_encoders", Size: 1191588248,
					SHA256:  "fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7",
					URL:     "https://huggingface.co/Comfy-Org/ACE-Step-1.5/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors",
					License: "MIT upstream / Apache-2.0 repack"},
				{Label: "Song maker, melody planner", Name: "qwen_1.7b_ace15.safetensors", Folder: "text_encoders", Size: 3708523360,
					SHA256:  "ed63e9247d1f55f3ace04fa11e95b085fc82d459c82c5626f0b2e37b91ebd710",
					URL:     "https://huggingface.co/Comfy-Org/ACE-Step-1.5/resolve/main/split_files/text_encoders/qwen_1.7b_ace15.safetensors",
					License: "MIT upstream / Apache-2.0 repack"},
				{Label: "Song maker, audio decoder", Name: "ace_1.5_vae.safetensors", Folder: "vae", Size: 337431732,
					SHA256:  "6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb",
					URL:     "https://huggingface.co/Comfy-Org/ACE-Step-1.5/resolve/main/split_files/vae/ace_1.5_vae.safetensors",
					License: "MIT upstream / Apache-2.0 repack"},
				{Label: "Lip-sync video model (Wan 2.2 S2V)", Name: "wan2.2_s2v_14B_fp8_scaled.safetensors", Folder: "diffusion_models", Size: 16394832474,
					SHA256:  "140e75af5534ac3d91e710d9df756f7032addd64b341ba2c1c70e3e6da9aa216",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors",
					License: "Apache-2.0"},
				{Label: "Lip-sync voice listener", Name: "wav2vec2_large_english_fp16.safetensors", Folder: "audio_encoders", Size: 630997322,
					SHA256:  "f0017a43ea57ef6b3d4866be607844bbd8cada6d30966f7d70044ed0d63d3f9e",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/audio_encoders/wav2vec2_large_english_fp16.safetensors",
					License: "Apache-2.0 (Comfy-Org repo)"},
				{Label: "Lip-sync speed-up add-on", Name: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors", Folder: "loras", Size: 1226977424,
					SHA256:  "698321cb86bd30c4af06c9b84e656a1048c8cb54e06d50694536fb5de37fde41",
					URL:     "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
					License: "Apache-2.0"},
			}},
			{ID: "fast", Files: []FileSpec{
				{Label: "Fast photo model (FLUX.2 klein 4B)", Name: "flux-2-klein-4b-fp8.safetensors", Folder: "diffusion_models", Size: 4070624520,
					SHA256:  "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
					URL:     "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors",
					License: "Apache-2.0"},
				{Label: "Fast photo model, language part", Name: "qwen_3_4b.safetensors", Folder: "text_encoders", Size: 8044982048,
					SHA256:  "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
					URL:     "https://huggingface.co/Comfy-Org/Flux-2-Klein-4B/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
					License: "Apache-2.0"},
				{Label: "Fast photo model, decoder", Name: "flux2-vae.safetensors", Folder: "vae", Size: 336211292,
					SHA256:  "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
					URL:     "https://huggingface.co/Comfy-Org/Flux-2-Klein-4B/resolve/main/split_files/vae/flux2-vae.safetensors",
					License: "Apache-2.0 (Comfy-Org/Flux-2-Klein-4B repo)"},
			}},
		},
	}
	for i := range c.Packs {
		t := packText[c.Packs[i].ID]
		c.Packs[i].Label, c.Packs[i].Desc = t[0], t[1]
	}
	return c
}
