package main

// Friends' videos are planned and built by the launcher: these tests check that
// it produces exactly what the web app would (testdata/share-vectors.json was
// generated from glow/ai.js and glow/local-engine.js themselves), that every
// graph passes the allowlist, that tampered graphs do not, and the label pixels.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"io/fs"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type vectorFile struct {
	Job    string `json:"job"`
	Seed   uint32 `json:"seed"`
	Labels []struct {
		Frame  []int  `json:"frame"`
		File   string `json:"file"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Scale  int    `json:"scale"`
		X, Y   int
		Sha    string `json:"rgbaSha256"`
	} `json:"labels"`
	Cases []struct {
		Name    string          `json:"name"`
		Host    hostPacks       `json:"host"`
		Request json.RawMessage `json:"request"`
		Expect  struct {
			Sound      string    `json:"sound"`
			Sync       string    `json:"sync"`
			Quality    string    `json:"quality"`
			StillModel string    `json:"stillModel"`
			Video      videoSize `json:"video"`
			Hint       string    `json:"hint"`
			Shots      []struct {
				ID, Title                 string
				Lip                       bool
				Seconds                   float64
				Offset                    *float64
				StillPrompt, MotionPrompt string
				NegativePrompt            string `json:"negativePrompt"`
				Seed                      uint64
			} `json:"shots"`
			Song *struct {
				Seconds  float64
				Style    string
				Language string
				Lyrics   string
				Seed     uint64
			} `json:"song"`
			Steps       []string                   `json:"steps"`
			Graphs      map[string]json.RawMessage `json:"graphs"`
			GuestGraphs map[string]json.RawMessage `json:"guestGraphs"`
		} `json:"expect"`
	} `json:"cases"`
}

func loadVectors(t *testing.T) *vectorFile {
	t.Helper()
	data, err := os.ReadFile("testdata/share-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	v := &vectorFile{}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
	return v
}

func testScenes(t testing.TB) *ScenesData {
	t.Helper()
	data, err := os.ReadFile("testdata/scenes.json")
	if err != nil {
		t.Fatal(err)
	}
	sd, err := loadScenes(data)
	if err != nil {
		t.Fatal(err)
	}
	return sd
}

func asAny(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	json.Unmarshal(b, &out)
	return out
}

// vectorPlan builds the plan of a vector case like the guest API does.
func vectorPlan(t *testing.T, sd *ScenesData, body json.RawMessage, host hostPacks) *GuestPlan {
	t.Helper()
	var probe struct {
		LipStarts []any `json:"lipStarts"`
	}
	json.Unmarshal(body, &probe)
	req, e := parseJobRequest(sd, body, probe.LipStarts != nil)
	if e != nil {
		t.Fatalf("request refused: %v (field %s)", e, e.Field)
	}
	p, e := guestPlan(sd, req, host, *req.Seed)
	if e != nil {
		t.Fatalf("plan refused: %v", e)
	}
	if e := p.applyLipStarts(req.LipStarts, 60); e != nil {
		t.Fatalf("lipStarts refused: %v", e)
	}
	return p
}

func vectorInputs(v *vectorFile, p *GuestPlan) stepInputs {
	J := v.Job
	in := stepInputs{selfie: "glow/selfie_" + J + ".jpg", stills: map[int]string{}, song: "glow/" + J + "_song_00001_.mp3 [output]", audio: "glow/audio_" + J + ".wav"}
	for k := range p.Shots {
		in.stills[k] = "glow/" + J + "_s" + itoa(k) + "_still_00001_.png [output]"
	}
	return in
}

func itoa(i int) string { return strconv.Itoa(i) }

func TestScenesLoadAndValidate(t *testing.T) {
	sd := testScenes(t)
	if len(sd.Scenes) < 10 || sd.scene("club-exit-sing") == nil || sd.scene(sd.DefaultScene) == nil {
		t.Fatalf("scenes: %d", len(sd.Scenes))
	}
	data, _ := os.ReadFile("testdata/scenes.json")
	bad := []struct{ name, from, to string }{
		{"bad format", `"format": "glow-scenes"`, `"format": "x"`},
		{"tempo hint without bpm", `" Everyone moves in time with a fast {bpm} BPM`, `" Everyone moves in time with a fast BPM`},
		{"unknown default", `"defaultScene": "party-hall"`, `"defaultScene": "nope"`},
	}
	for _, b := range bad {
		if !strings.Contains(string(data), b.from) {
			t.Fatalf("%s: fixture text not found", b.name)
		}
		if _, err := loadScenes([]byte(strings.Replace(string(data), b.from, b.to, 1))); err == nil {
			t.Errorf("%s: accepted", b.name)
		}
	}
	long := strings.Replace(string(data), `"defaultScene": "party-hall"`, `"defaultScene": "party-hall", "x": "`+strings.Repeat("a", 5000)+`"`, 1)
	if _, err := loadScenes([]byte(long)); err == nil {
		t.Error("a 5000-byte text was accepted")
	}
}

// The launcher reads the web app's own glow/scenes.json at run time: it must
// load and give exactly the vectors' prompts too.
func TestEmbeddedScenesMatchVectors(t *testing.T) {
	app, _ := fs.Sub(bundle, "glow")
	sd, err := loadScenesFS(app)
	if err != nil {
		t.Fatalf("glow/scenes.json: %v", err)
	}
	checkVectors(t, sd)
}

// The plan, every prompt and every graph equal the web app's (share-vectors.json).
func TestGuestVectors(t *testing.T) { checkVectors(t, testScenes(t)) }

func checkVectors(t *testing.T, sd *ScenesData) {
	v := loadVectors(t)
	if len(v.Cases) < 16 {
		t.Fatalf("only %d cases", len(v.Cases))
	}
	steps := 0
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			p := vectorPlan(t, sd, c.Request, c.Host)
			x := c.Expect
			if p.Sound != x.Sound || p.Sync != x.Sync || p.Quality != x.Quality || p.StillModel != x.StillModel || p.Video != x.Video {
				t.Fatalf("plan %s/%s/%s/%s/%v, want %s/%s/%s/%s/%v", p.Sound, p.Sync, p.Quality, p.StillModel, p.Video, x.Sound, x.Sync, x.Quality, x.StillModel, x.Video)
			}
			if p.hint != x.Hint {
				t.Errorf("hint %q, want %q", p.hint, x.Hint)
			}
			if len(p.Shots) != len(x.Shots) {
				t.Fatalf("%d shots, want %d", len(p.Shots), len(x.Shots))
			}
			for k, s := range x.Shots {
				g := p.Shots[k]
				if g.ID != s.ID || g.Title != s.Title || g.Lip != s.Lip || g.Seconds != s.Seconds || g.seed != s.Seed {
					t.Errorf("shot %d: %s %q %v %v %d, want %s %q %v %v %d", k, g.ID, g.Title, g.Lip, g.Seconds, g.seed, s.ID, s.Title, s.Lip, s.Seconds, s.Seed)
				}
				if (g.Offset == nil) != (s.Offset == nil) || (g.Offset != nil && *g.Offset != *s.Offset) {
					t.Errorf("shot %d offset %v, want %v", k, deref(g.Offset), deref(s.Offset))
				}
				if g.stillPrompt != s.StillPrompt {
					t.Errorf("shot %d still prompt:\n got %q\nwant %q", k, g.stillPrompt, s.StillPrompt)
				}
				if g.motionPrompt != s.MotionPrompt {
					t.Errorf("shot %d motion prompt:\n got %q\nwant %q", k, g.motionPrompt, s.MotionPrompt)
				}
				if g.negative != s.NegativePrompt {
					t.Errorf("shot %d negative %q", k, g.negative)
				}
			}
			if (p.Song == nil) != (x.Song == nil) {
				t.Fatalf("song %v, want %v", p.Song, x.Song)
			}
			if p.Song != nil && (p.Song.Seconds != x.Song.Seconds || p.Song.style != x.Song.Style || p.Song.lyrics != x.Song.Lyrics || p.Song.language != x.Song.Language || p.Song.seed != x.Song.Seed) {
				t.Errorf("song %+v, want %+v", *p.Song, *x.Song)
			}
			if !reflect.DeepEqual(p.steps, x.Steps) {
				t.Fatalf("steps %v, want %v", p.steps, x.Steps)
			}
			in := vectorInputs(v, p)
			for _, step := range p.steps {
				sg, err := buildStepGraph(p, v.Job, step, 0, in)
				if err != nil {
					t.Fatalf("%s: %v", step, err)
				}
				var want any
				json.Unmarshal(x.GuestGraphs[step], &want)
				if got := asAny(t, sg.graph); !reflect.DeepEqual(got, want) {
					gb, _ := json.Marshal(got)
					t.Fatalf("%s guest graph differs:\n got %s\nwant %s", step, gb, x.GuestGraphs[step])
				}
				// the same graph without the label is the web app's own graph
				var base any
				json.Unmarshal(x.Graphs[step], &base)
				if got := asAny(t, stripLabel(sg.graph)); !reflect.DeepEqual(got, base) {
					t.Fatalf("%s base graph differs", step)
				}
				if err := assertGuestGraph(sg.graph, v.Job, sg.guestOut); err != nil {
					t.Fatalf("%s: allowlist: %v", step, err)
				}
				if err := assertGuestTexts(sg.graph, p); err != nil {
					t.Fatalf("%s: texts: %v", step, err)
				}
				steps++
			}
		})
	}
	if steps < 98 {
		t.Errorf("only %d steps checked", steps)
	}
}

func deref(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

// stripLabel undoes the label insertion (c.2) of a graph.
func stripLabel(g map[string]any) map[string]any {
	b, _ := json.Marshal(g)
	var c map[string]any
	json.Unmarshal(b, &c)
	for _, id := range []string{"90", "91", "92", "93", "94", "95", "96"} {
		delete(c, id)
	}
	for _, fix := range [][3]string{{"18", "images", "17"}, {"16", "images", "15"}} {
		if n, ok := c[fix[0]].(map[string]any); ok {
			in := n["inputs"].(map[string]any)
			if l, ok := in[fix[1]].([]any); ok && l[0] == "92" {
				in[fix[1]] = []any{fix[2], 0.0}
			}
		}
	}
	return c
}

func TestLabelPixels(t *testing.T) {
	v := loadVectors(t)
	files := labelFiles()
	if len(files) != 4 {
		t.Fatalf("%d label files", len(files))
	}
	for _, l := range v.Labels {
		name := strings.TrimPrefix(l.File, "glow/")
		data := files[name]
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		b := img.Bounds()
		if b.Dx() != l.Width || b.Dy() != l.Height {
			t.Fatalf("%s is %dx%d, want %dx%d", name, b.Dx(), b.Dy(), l.Width, l.Height)
		}
		rgba := image.NewNRGBA(b)
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				rgba.Set(x, y, img.At(x, y))
			}
		}
		sum := sha256.Sum256(rgba.Pix)
		if hex.EncodeToString(sum[:]) != l.Sha {
			t.Errorf("%s pixels differ from the reference", name)
		}
		if len(l.Frame) == 2 {
			g := labelGeom(l.Frame[0], l.Frame[1])
			if g.X != l.X || g.Y != l.Y || g.Scale != l.Scale || g.File != l.File {
				t.Errorf("%s geometry %+v", name, g)
			}
		}
	}
	// the frame labels are RGBA (they have see-through pixels), the card is opaque RGB
	if files["glowlabel_480x832.png"][25] != 6 || files["glowlabel_card.png"][25] != 2 {
		t.Errorf("PNG colour types %d %d", files["glowlabel_480x832.png"][25], files["glowlabel_card.png"][25])
	}
}

// A graph that was changed in any way a friend might want is refused.
func TestAssertGuestGraphRejectsTampering(t *testing.T) {
	v := loadVectors(t)
	sd := testScenes(t)
	var c = v.Cases[5] // club-exit-sing 20 s AI song: stills, song, videos and a lip-sync
	p := vectorPlan(t, sd, c.Request, c.Host)
	in := vectorInputs(v, p)
	build := func(step string) (*stepGraph, map[string]any) {
		sg, err := buildStepGraph(p, v.Job, step, 0, in)
		if err != nil {
			t.Fatal(err)
		}
		return sg, sg.graph
	}
	type tamper struct {
		name string
		step string
		fn   func(g map[string]any)
	}
	set := func(id, key string, val any) func(g map[string]any) {
		return func(g map[string]any) { node(g, id)[key] = val }
	}
	cases := []tamper{
		{"other class_type", "still:0", func(g map[string]any) { g["12"].(map[string]any)["class_type"] = "PythonEval" }},
		{"extra node", "still:0", func(g map[string]any) {
			g["50"] = map[string]any{"class_type": "LoadImageFromUrl", "inputs": map[string]any{"url": "http://x"}}
		}},
		{"extra allowed node with foreign file", "video:0", func(g map[string]any) {
			g["50"] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "../../secret.png"}}
		}},
		{"other model file", "video:0", set("7", "unet_name", "evil.safetensors")},
		{"other prefix", "video:0", set("19", "filename_prefix", "glow/g12345_clip")},
		{"prefix escapes", "video:0", set("19", "filename_prefix", "glow/"+v.Job+"_../../x")},
		{"other selfie", "still:0", set("1", "image", "glow/selfie_g123.jpg")},
		{"host output as input", "video:0", set("1", "image", "glow/g123_still_00001_.png [output]")},
		{"huge number", "still:0", set("12", "steps", 1e300)},
		{"link to missing node", "still:0", set("12", "model", []any{"77", 0})},
		{"label removed from clip", "video:0", set("18", "images", []any{"17", 0})},
		{"label removed from still", "still:0", set("93", "images", []any{"13", 0})},
		{"label image swapped", "video:0", set("90", "image", "glow/selfie_"+v.Job+".jpg")},
		{"song card unlabelled", "song", set("96", "video", []any{"9", 0})},
		{"lip-sync unlabelled", "lipsync:2", set("16", "images", []any{"15", 0})},
		{"text node becomes link to nothing", "still:0", set("8", "prompt", []any{"99", 0})},
	}
	cases = append(cases,
		tamper{"changed still prompt", "still:0", func(g map[string]any) { node(g, "8")["prompt"] = node(g, "8")["prompt"].(string) + " Topless." }},
		tamper{"other scene's prompt", "video:0", func(g map[string]any) { node(g, "3")["text"] = "A person dances in a bedroom." }},
		tamper{"changed negative", "video:1", func(g map[string]any) { node(g, "4")["text"] = "" }},
		tamper{"changed lyrics", "song", func(g map[string]any) { node(g, "5")["lyrics"] = "[Verse]\nla la" }},
		tamper{"changed sing line", "lipsync:2", func(g map[string]any) { node(g, "7")["text"] = 42.0 }},
	)
	check := func(g map[string]any, out string) error {
		if err := assertGuestGraph(g, v.Job, out); err != nil {
			return err
		}
		return assertGuestTexts(g, p)
	}
	for _, tc := range cases {
		sg, g := build(tc.step)
		if err := check(g, sg.guestOut); err != nil {
			t.Fatalf("%s: untouched graph refused: %v", tc.name, err)
		}
		tc.fn(g)
		if err := check(g, sg.guestOut); err == nil {
			t.Errorf("%s: accepted", tc.name)
		}
	}
	if err := assertGuestGraph(map[string]any{}, "g123", ""); err == nil {
		t.Error("a host job id was accepted")
	}
}

// Changed texts can never come from a friend: the prompts are only built from
// scenes.json, so a request carrying prompt fields is refused outright.
func TestJobRequestValidation(t *testing.T) {
	sd := testScenes(t)
	good := `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":{"bpm":120,"feel":"fast"},"lipStarts":null,"seed":7,"consent":{"own":true,"adult":true}}`
	if _, e := parseJobRequest(sd, []byte(good), false); e != nil {
		t.Fatalf("good request refused: %v", e)
	}
	bad := map[string]string{
		"prompt field":     strings.Replace(good, `"v":1`, `"v":1,"prompt":"anything"`, 1),
		"stillPrompt":      strings.Replace(good, `"v":1`, `"v":1,"stillPrompt":"x"`, 1),
		"graph":            strings.Replace(good, `"v":1`, `"v":1,"graph":{}`, 1),
		"version":          strings.Replace(good, `"v":1`, `"v":2`, 1),
		"unknown scene":    strings.Replace(good, `party-hall`, `my-own-scene`, 1),
		"duration 7":       strings.Replace(good, `"duration":5`, `"duration":7`, 1),
		"duration string":  strings.Replace(good, `"duration":5`, `"duration":"5"`, 1),
		"sound":            strings.Replace(good, `"sound":"music"`, `"sound":"MUSIC"`, 1),
		"sync":             strings.Replace(good, `"sync":"beat"`, `"sync":"x"`, 1),
		"quality":          strings.Replace(good, `"quality":"best"`, `"quality":"ultra"`, 1),
		"bpm huge":         strings.Replace(good, `"bpm":120`, `"bpm":1e9`, 1),
		"bpm fraction":     strings.Replace(good, `"bpm":120`, `"bpm":120.5`, 1),
		"feel":             strings.Replace(good, `"feel":"fast"`, `"feel":"wild"`, 1),
		"tempo extra":      strings.Replace(good, `"feel":"fast"`, `"feel":"fast","text":"x"`, 1),
		"seed negative":    strings.Replace(good, `"seed":7`, `"seed":-1`, 1),
		"seed huge":        strings.Replace(good, `"seed":7`, `"seed":99999999999`, 1),
		"seed fraction":    strings.Replace(good, `"seed":7`, `"seed":1.5`, 1),
		"no consent":       strings.Replace(good, `,"consent":{"own":true,"adult":true}`, ``, 1),
		"not adult":        strings.Replace(good, `"adult":true`, `"adult":false`, 1),
		"two values":       good + `{}`,
		"not json":         `v=1`,
		"audio flag (job)": strings.Replace(good, `"v":1`, `"v":1,"audio":true`, 1),
	}
	for name, body := range bad {
		if _, e := parseJobRequest(sd, []byte(body), false); e == nil {
			t.Errorf("%s: accepted", name)
		} else if e.Status != 400 {
			t.Errorf("%s: status %d", name, e.Status)
		}
	}
	if _, e := parseJobRequest(sd, []byte(strings.Replace(good, `"adult":true`, `"adult":false`, 1)), false); e == nil || e.Code != "consent" {
		t.Errorf("consent error %v", e)
	}
	// bpm is clamped to 50..200
	r, _ := parseJobRequest(sd, []byte(strings.Replace(good, `"bpm":120`, `"bpm":240`, 1)), false)
	if r.Tempo.BPM != 200 {
		t.Errorf("bpm %d", r.Tempo.BPM)
	}
	// own-song lip starts: number exactly for lip shots, in range, apart, covered by the WAV
	ownLips := `{"v":1,"sceneId":"club","duration":20,"sound":"own","sync":"lips","quality":"best","tempo":null,"lipStarts":[0,4.813,9.625,14.438],"seed":1,"consent":{"own":true,"adult":true}}`
	req, e := parseJobRequest(sd, []byte(ownLips), true)
	if e != nil {
		t.Fatal(e)
	}
	p, e := guestPlan(sd, req, hostPacks{Singing: true}, 1)
	if e != nil {
		t.Fatal(e)
	}
	if e := p.applyLipStarts(req.LipStarts, 19.5); e != nil {
		t.Fatalf("good starts refused: %v", e)
	}
	f := func(x float64) *float64 { return &x }
	for name, starts := range map[string][]*float64{
		"missing":   nil,
		"short":     {f(0), f(5), f(10)},
		"null lip":  {f(0), nil, f(10), f(15)},
		"too close": {f(0), f(4), f(9), f(14)},
		"backwards": {f(10), f(5), f(15), f(20)},
		"too late":  {f(0), f(5), f(10), f(26)},
		"negative":  {f(-1), f(5), f(10), f(15)},
	} {
		p, _ := guestPlan(sd, req, hostPacks{Singing: true}, 1)
		if e := p.applyLipStarts(starts, 40); e == nil {
			t.Errorf("lipStarts %s: accepted", name)
		}
	}
	p, _ = guestPlan(sd, req, hostPacks{Singing: true}, 1)
	if e := p.applyLipStarts(req.LipStarts, 18); e == nil || e.Code != "bad-audio" {
		t.Errorf("a WAV too short for the last lip shot: %v", e)
	}
	// AI song without the Singing add-on; audio sent for a video that has no lip-sync
	ai, _ := parseJobRequest(sd, []byte(strings.Replace(strings.Replace(good, `"sound":"music"`, `"sound":"ai"`, 1), "party-hall", "spanish", 1)), false)
	if _, e := guestPlan(sd, ai, hostPacks{}, 1); e == nil || e.Code != "missing-pack" {
		t.Errorf("missing pack: %v", e)
	}
	m, _ := parseJobRequest(sd, []byte(good), true)
	if _, e := guestPlan(sd, m, hostPacks{Singing: true}, 1); e == nil || e.Code != "unexpected-audio" {
		t.Errorf("unexpected audio: %v", e)
	}
	p, _ = guestPlan(sd, m2(t, sd, good), hostPacks{Singing: true}, 1)
	if e := p.applyLipStarts([]*float64{f(0)}, 40); e == nil {
		t.Error("lipStarts for a video without lip-sync accepted")
	}
}

func m2(t *testing.T, sd *ScenesData, body string) *guestRequest {
	r, e := parseJobRequest(sd, []byte(body), false)
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func TestEstimateStory(t *testing.T) {
	// local-engine.js estimateStory: a 20 s story is about 20-35 min (cold start included)
	if got := estimateStory(4, 0, false, false, false, false, true); got != [2]int{20, 35} {
		t.Errorf("20 s story %v", got)
	}
	if got := estimateStory(1, 0, false, false, false, false, false); got != [2]int{5, 9} {
		t.Errorf("5 s warm %v", got)
	}
	if got := estimateStory(4, 1, false, false, true, true, true); got[0] <= 21 {
		t.Errorf("laptop with song %v", got)
	}
}
