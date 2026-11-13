package main

// ComfyUI graphs for friends' videos (DESIGN b.3, c.2): the launcher builds
// them from the web app's own templates (guesttemplates.go, generated from
// glow/local-engine.js) and the plan; nothing a friend sends is copied into a
// graph except bounded numbers. Every graph whose output a friend can download
// composites the "AI-GENERATED" label over the decoded frames (nodes 90-96).

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	placeholderWhole = regexp.MustCompile(`^<<([A-Z_]+)>>$`)
	placeholderPart  = regexp.MustCompile(`<<([A-Z_]+)>>`)
)

// fillTemplate is local-engine.js fill(): a value that is exactly one
// placeholder takes the value itself, other placeholders are text.
func fillTemplate(name string, values map[string]any) map[string]any {
	var g map[string]any
	if err := json.Unmarshal([]byte(comfyTemplates[name]), &g); err != nil {
		panic("template " + name + ": " + err.Error())
	}
	whole, part := placeholderWhole, placeholderPart
	var walk func(m map[string]any)
	walk = func(m map[string]any) {
		for k, v := range m {
			switch t := v.(type) {
			case string:
				if !strings.Contains(t, "<<") {
					continue
				}
				if w := whole.FindStringSubmatch(t); w != nil {
					val, ok := values[w[1]]
					if !ok {
						panic("missing value for " + t)
					}
					m[k] = val
					continue
				}
				m[k] = part.ReplaceAllStringFunc(t, func(s string) string {
					val, ok := values[s[2:len(s)-2]]
					if !ok {
						panic("missing value for " + s)
					}
					return fmt.Sprint(val)
				})
			case map[string]any:
				walk(t)
			}
		}
	}
	walk(g)
	return g
}

func node(g map[string]any, id string) map[string]any {
	return g[id].(map[string]any)["inputs"].(map[string]any)
}

func mult16(v int) int { return min(4096, max(16, int(jsRound(float64(v)/16))*16)) }

func graphStill(selfie, prompt string, seed uint64, job, model string) map[string]any {
	tpl := "stillQwen"
	if model == "klein" {
		tpl = "stillKlein"
	}
	return fillTemplate(tpl, map[string]any{"SELFIE": selfie, "SCENE_PROMPT": prompt, "SEED": seed, "JOB": job})
}

func graphVideo(still, prompt, negative string, seed uint64, job string, w, h int) map[string]any {
	g := fillTemplate("video", map[string]any{"STILL": still, "MOTION_PROMPT": prompt, "SEED": seed, "JOB": job})
	if n := jsTrim(negative); n != "" {
		node(g, "4")["text"] = negWan + "，" + n
	}
	node(g, "6")["width"], node(g, "6")["height"] = mult16(w), mult16(h)
	return g
}

func graphSong(tags, lyrics string, seed uint64, seconds float64, language, job string) map[string]any {
	g := fillTemplate("song", map[string]any{"SONG_TAGS": tags, "LYRICS_ES": lyrics, "SEED": seed, "JOB": job})
	sec := jsRound(float64(math.Min(120, math.Max(5, seconds))*10)) / 10
	node(g, "5")["duration"] = sec
	node(g, "7")["seconds"] = sec
	for _, l := range aceLangs {
		if l == language {
			node(g, "5")["language"] = language
		}
	}
	return g
}

func graphS2V(still, audio string, offset float64, prompt string, seed uint64, job string) map[string]any {
	return fillTemplate("s2v", map[string]any{"STILL": still, "SONG": audio,
		"SONG_OFFSET_S": math.Max(0, jsRound(float64(offset*100))/100), "SING_PROMPT": prompt, "SEED": seed, "JOB": job})
}

func addFrameLabel(g map[string]any, dec, consumer, input string, w, h int) {
	L := labelGeom(w, h)
	g["90"] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": L.File}}
	g["91"] = map[string]any{"class_type": "InvertMask", "inputs": map[string]any{"mask": []any{"90", 1}}}
	g["92"] = map[string]any{"class_type": "ImageCompositeMasked", "inputs": map[string]any{
		"destination": []any{dec, 0}, "source": []any{"90", 0}, "x": L.X, "y": L.Y, "resize_source": false, "mask": []any{"91", 0}}}
	if consumer != "" {
		node(g, consumer)[input] = []any{"92", 0}
	}
}

// stepInputs are the files earlier steps made, as LoadImage/LoadAudio names
// ("glow/<file> [output]").
type stepInputs struct {
	selfie string         // glow/selfie_<J>.jpg
	stills map[int]string // raw stills (output "14"/"18" of still:k)
	song   string         // raw song (output "10" of song)
	audio  string         // glow/audio_<J>.wav (own song)
}

// stepGraph is one ComfyUI prompt of a friend's job.
type stepGraph struct {
	graph    map[string]any
	rawOut   string // output node of the raw file the next steps use ("" none)
	guestOut string // output node of the labelled file a friend may download
	message  string
}

// stepJobName: <J>_s<k> for shot steps, <J> for the song; retries add _r<n>.
func stepJobName(job, step string, take int) string {
	_, k := stepParts(step)
	name := job
	if k >= 0 {
		name += "_s" + strconv.Itoa(k)
	}
	if take > 0 {
		name += "_r" + strconv.Itoa(take)
	}
	return name
}

func buildStepGraph(p *GuestPlan, job, step string, take int, in stepInputs) (*stepGraph, error) {
	st, k := stepParts(step)
	name := stepJobName(job, step, take)
	n := len(p.Shots)
	of := ""
	if n > 1 && k >= 0 {
		of = fmt.Sprintf(" %d of %d", k+1, n)
	}
	if k >= n {
		return nil, fmt.Errorf("bad step %s", step)
	}
	switch st {
	case "still":
		sh := p.Shots[k]
		g := graphStill(in.selfie, sh.stillPrompt, sh.seed, name, p.StillModel)
		dec, raw := "13", "14"
		if p.StillModel == "klein" {
			dec, raw = "17", "18"
		}
		addFrameLabel(g, dec, "", "", 720, 1248)
		g["93"] = map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"92", 0}, "filename_prefix": "glow/" + name + "_stillL"}}
		msg := "Placing you in the scene…"
		if n > 1 {
			msg = "Placing you in shot" + of + "…"
		}
		return &stepGraph{graph: g, rawOut: raw, guestOut: "93", message: msg}, nil
	case "song":
		if p.Song == nil {
			return nil, fmt.Errorf("no song in this plan")
		}
		s := p.Song
		g := graphSong(s.style, s.lyrics, s.seed, s.Seconds, s.language, name)
		g["90"] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "glow/glowlabel_card.png"}}
		g["94"] = map[string]any{"class_type": "RepeatImageBatch", "inputs": map[string]any{"image": []any{"90", 0}, "amount": int(math.Ceil(s.Seconds))}}
		g["95"] = map[string]any{"class_type": "CreateVideo", "inputs": map[string]any{"images": []any{"94", 0}, "fps": 1.0, "audio": []any{"9", 0}}}
		g["96"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"95", 0}, "filename_prefix": "glow/" + name + "_songL", "format": "mp4", "format.codec": "auto"}}
		msg := "Writing your song…"
		if s.language == "es" {
			msg = "Writing your Spanish song…"
		}
		return &stepGraph{graph: g, rawOut: "10", guestOut: "96", message: msg}, nil
	case "video":
		sh := p.Shots[k]
		if sh.Lip || in.stills[k] == "" {
			return nil, fmt.Errorf("step %s is not ready", step)
		}
		g := graphVideo(in.stills[k], sh.motionPrompt, sh.negative, sh.seed, name, p.Video.Width, p.Video.Height)
		addFrameLabel(g, "17", "18", "images", p.Video.Width, p.Video.Height)
		msg := "Bringing the scene to life… (this is the slow part)"
		if of != "" {
			msg = "Bringing shot" + of + " to life… (this is the slow part)"
		}
		return &stepGraph{graph: g, guestOut: "19", message: msg}, nil
	case "lipsync":
		sh := p.Shots[k]
		if !sh.Lip || in.stills[k] == "" || sh.Offset == nil {
			return nil, fmt.Errorf("step %s is not ready", step)
		}
		audio := in.audio
		if p.Sound == "ai" {
			audio = in.song
		}
		if audio == "" {
			return nil, fmt.Errorf("step %s has no audio", step)
		}
		g := graphS2V(in.stills[k], audio, *sh.Offset, sh.motionPrompt, sh.seed, name)
		addFrameLabel(g, "15", "16", "images", 480, 832)
		msg := "Making you sing… (this is the slow part)"
		if of != "" {
			msg = "Making you sing in shot" + of + "… (this is the slow part)"
		}
		return &stepGraph{graph: g, guestOut: "17", message: msg}, nil
	}
	return nil, fmt.Errorf("unknown step %s", step)
}

// ---- the allowlist every friend's graph must pass before it is queued ----

var guestClassTypes = map[string]bool{}

func init() {
	for _, c := range strings.Fields(`LoadImage UNETLoader CLIPLoader DualCLIPLoader VAELoader ModelSamplingAuraFlow ModelSamplingSD3 CFGNorm
LoraLoaderModelOnly TextEncodeQwenImageEditPlus FluxKontextMultiReferenceLatentMethod ConditioningZeroOut EmptySD3LatentImage KSampler
KSamplerAdvanced VAEDecode VAEEncode SaveImage ImageScaleToTotalPixels CLIPTextEncode ReferenceLatent EmptyFlux2LatentImage
Flux2Scheduler RandomNoise KSamplerSelect CFGGuider SamplerCustomAdvanced WanImageToVideo FrameInterpolationModelLoader FrameInterpolate
CreateVideo SaveVideo TextEncodeAceStepAudio1.5 EmptyAceStep1.5LatentAudio VAEDecodeAudio SaveAudioMP3 LoadAudio TrimAudioDuration
AudioEncoderLoader AudioEncoderEncode WanSoundImageToVideo InvertMask ImageCompositeMasked RepeatImageBatch`) {
		guestClassTypes[c] = true
	}
}

var modelInputs = []string{"unet_name", "clip_name", "clip_name1", "clip_name2", "vae_name", "lora_name", "model_name", "audio_encoder_name"}

var catalogModelNames = func() map[string]bool {
	m := map[string]bool{}
	for _, p := range builtinCatalog().Packs {
		for _, f := range p.Files {
			m[f.Name] = true
		}
	}
	return m
}()

var guestJobRe = regexp.MustCompile(`^gq-[0-9a-f]{16}$`)

// assertGuestGraph checks a friend's graph against the allowlist of DESIGN
// b.3: known node types only, links only to nodes of the graph, every saved
// file inside glow/<J>_, every loaded file one of the job's own, model files
// from the catalog, and the label wired into every output a friend can get.
func assertGuestGraph(g map[string]any, job, guestOut string) error {
	if !guestJobRe.MatchString(job) {
		return fmt.Errorf("bad job id")
	}
	labels := map[string]bool{"glow/glowlabel_720x1248.png": true, "glow/glowlabel_480x832.png": true, "glow/glowlabel_384x672.png": true, "glow/glowlabel_card.png": true}
	for id, raw := range g {
		n, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("node %s is not an object", id)
		}
		ct, _ := n["class_type"].(string)
		if !guestClassTypes[ct] {
			return fmt.Errorf("node %s: class %q is not allowed", id, ct)
		}
		in, ok := n["inputs"].(map[string]any)
		if !ok {
			return fmt.Errorf("node %s has no inputs", id)
		}
		for key, v := range in {
			if l, ok := v.([]any); ok {
				if len(l) != 2 {
					return fmt.Errorf("node %s input %s: bad link", id, key)
				}
				src, ok := l[0].(string)
				if _, exists := g[src]; !ok || !exists {
					return fmt.Errorf("node %s input %s links to a missing node", id, key)
				}
				continue
			}
			s, isStr := v.(string)
			switch {
			case key == "filename_prefix":
				if !isStr || !strings.HasPrefix(s, "glow/"+job+"_") || strings.ContainsAny(s[len("glow/"):], `/\.:`) {
					return fmt.Errorf("node %s saves outside the job's files", id)
				}
			case (ct == "LoadImage" && key == "image") || (ct == "LoadAudio" && key == "audio"):
				ok := isStr && (s == "glow/selfie_"+job+".jpg" || s == "glow/audio_"+job+".wav" || labels[s] ||
					(strings.HasPrefix(s, "glow/"+job+"_") && strings.HasSuffix(s, " [output]") && !strings.ContainsAny(strings.TrimSuffix(s[len("glow/"):], " [output]"), `/\:`)))
				if !ok {
					return fmt.Errorf("node %s loads a file that is not the job's own", id)
				}
			default:
				for _, mk := range modelInputs {
					if key == mk && (!isStr || !catalogModelNames[s]) {
						return fmt.Errorf("node %s: model %q is not in the catalog", id, s)
					}
				}
				if f, ok := v.(float64); ok && (math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > 1<<53) {
					return fmt.Errorf("node %s input %s: number out of range", id, key)
				}
			}
		}
	}
	if guestOut != "" {
		out, ok := g[guestOut].(map[string]any)
		if !ok {
			return fmt.Errorf("output node %s is missing", guestOut)
		}
		ct := out["class_type"]
		in := out["inputs"].(map[string]any)
		switch guestOut {
		case "93":
			if ct != "SaveImage" || !linksTo(in["images"], "92") {
				return fmt.Errorf("the labelled still is not labelled")
			}
		case "96":
			v, _ := g["95"].(map[string]any)
			if ct != "SaveVideo" || !linksTo(in["video"], "95") || v == nil || !linksTo(v["inputs"].(map[string]any)["images"], "94") {
				return fmt.Errorf("the song card is not labelled")
			}
		default: // "19" (I2V) and "17" (S2V): SaveVideo <- CreateVideo <- 92
			src := ""
			if l, ok := in["video"].([]any); ok && len(l) == 2 {
				src, _ = l[0].(string)
			}
			cv, _ := g[src].(map[string]any)
			if ct != "SaveVideo" || cv == nil || cv["class_type"] != "CreateVideo" || !linksTo(cv["inputs"].(map[string]any)["images"], "92") {
				return fmt.Errorf("the clip is not labelled")
			}
		}
		if lab, ok := g["90"].(map[string]any); !ok || lab["class_type"] != "LoadImage" || !labels[fmt.Sprint(lab["inputs"].(map[string]any)["image"])] {
			return fmt.Errorf("the label image is missing")
		}
		if guestOut != "96" {
			c, ok := g["92"].(map[string]any)
			if !ok || c["class_type"] != "ImageCompositeMasked" {
				return fmt.Errorf("the label compositing node is missing")
			}
			ci := c["inputs"].(map[string]any)
			if !linksTo(ci["source"], "90") || !linksTo(ci["mask"], "91") {
				return fmt.Errorf("the label is not wired")
			}
		}
	}
	return nil
}

// textInputs are the free-text inputs of the allowed node classes.
var textInputs = map[string]bool{"prompt": true, "text": true, "tags": true, "lyrics": true}

// assertGuestTexts: every text input of a friend's graph is one of the texts
// the launcher composed for this plan from scenes.json (DESIGN b.3).
func assertGuestTexts(g map[string]any, p *GuestPlan) error {
	ok := map[string]bool{negWan: true}
	for _, sh := range p.Shots {
		ok[sh.stillPrompt], ok[sh.motionPrompt] = true, true
		if sh.negative != "" {
			ok[negWan+"，"+sh.negative] = true
		}
	}
	if p.Song != nil {
		ok[p.Song.style], ok[p.Song.lyrics] = true, true
	}
	for id, raw := range g {
		n, _ := raw.(map[string]any)
		in, _ := n["inputs"].(map[string]any)
		for k, v := range in {
			if !textInputs[k] {
				continue
			}
			if s, isStr := v.(string); !isStr || !ok[s] {
				return fmt.Errorf("node %s input %s is not a preset text", id, k)
			}
		}
	}
	return nil
}

func linksTo(v any, id string) bool {
	l, ok := v.([]any)
	return ok && len(l) == 2 && l[0] == id
}
