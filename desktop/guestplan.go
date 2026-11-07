package main

// A friend's job request -> the plan of their video (DESIGN a.5). This is the
// web app's planFor + localJob + storyRequest + local-engine.js planStory for a
// story, with the two guest changes (always the story path, every length), so
// the launcher, not the friend's browser, decides every prompt and number.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	i2vSeconds      = 161.0 / 32 // 81 frames, RIFE x2 -> 161 frames at 32 fps
	s2vSeconds      = 77.0 / 16  // one S2V chunk
	s2vAudioSeconds = 5.0
	planDanceSec    = 5.03 // ai.js's planning value for a dance shot (NOT 161/32)
)

// apiError is an error answer of the guest or host API.
type apiError struct {
	Status  int
	Code    string
	Message string
	Field   string
	Extra   map[string]any
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func badField(field string) *apiError {
	return &apiError{Status: 400, Code: "bad-request", Message: "Something in the request was not right. Reload the page and try again.", Field: field}
}

// guestRequest is a checked PlanRequest or JobRequest.
type guestRequest struct {
	SceneID   string
	Duration  int
	Sound     string
	Sync      string
	Quality   string
	Tempo     *Tempo
	Audio     bool       // the friend sends (plan) / sent (job) a WAV for lip-sync
	LipStarts []*float64 // job only, checked against the plan
	Seed      *uint32
	Consent   bool
}

type tempoJSON struct {
	BPM  *float64 `json:"bpm"`
	Feel *string  `json:"feel"`
}

type reqCommonJSON struct {
	V        *float64   `json:"v"`
	SceneID  *string    `json:"sceneId"`
	Duration *float64   `json:"duration"`
	Sound    *string    `json:"sound"`
	Sync     *string    `json:"sync"`
	Quality  *string    `json:"quality"`
	Tempo    *tempoJSON `json:"tempo"`
}

type planReqJSON struct {
	reqCommonJSON
	Audio *bool `json:"audio"`
}

type consentJSON struct {
	Own   *bool `json:"own"`
	Adult *bool `json:"adult"`
}

type jobReqJSON struct {
	reqCommonJSON
	LipStarts *[]*float64  `json:"lipStarts"`
	Seed      *float64     `json:"seed"`
	Consent   *consentJSON `json:"consent"`
}

var unknownFieldRe = regexp.MustCompile(`unknown field "([^"]*)"`)

// decodeStrict decodes exactly one JSON value, refusing unknown fields.
func decodeStrict(data []byte, v any) *apiError {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		field := "body"
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			field = te.Field
		} else if m := unknownFieldRe.FindStringSubmatch(err.Error()); m != nil {
			field = m[1]
		}
		return badField(field)
	}
	if _, err := dec.Token(); err != io.EOF {
		return badField("body")
	}
	return nil
}

func isInt(x float64) bool { return !math.IsInf(x, 0) && !math.IsNaN(x) && x == math.Trunc(x) }

func (c *reqCommonJSON) check(sd *ScenesData, r *guestRequest) *apiError {
	if c.V == nil || *c.V != 1 {
		return badField("v")
	}
	if c.SceneID == nil || sd.scene(*c.SceneID) == nil {
		return badField("sceneId")
	}
	r.SceneID = *c.SceneID
	if c.Duration == nil || (*c.Duration != 5 && *c.Duration != 10 && *c.Duration != 20) {
		return badField("duration")
	}
	r.Duration = int(*c.Duration)
	enum := func(p *string, field string, ok ...string) (string, *apiError) {
		if p != nil {
			for _, o := range ok {
				if *p == o {
					return o, nil
				}
			}
		}
		return "", badField(field)
	}
	var e *apiError
	if r.Sound, e = enum(c.Sound, "sound", "music", "ai", "own"); e != nil {
		return e
	}
	if r.Sync, e = enum(c.Sync, "sync", "beat", "lips"); e != nil {
		return e
	}
	if r.Quality, e = enum(c.Quality, "quality", "best", "fast"); e != nil {
		return e
	}
	if c.Tempo != nil {
		t := c.Tempo
		if t.BPM == nil || !isInt(*t.BPM) || *t.BPM < 40 || *t.BPM > 240 {
			return badField("tempo.bpm")
		}
		feel, e := enum(t.Feel, "tempo.feel", "fast", "upbeat", "slow")
		if e != nil {
			return e
		}
		bpm := int(*t.BPM)
		bpm = max(50, min(200, bpm))
		r.Tempo = &Tempo{BPM: bpm, Feel: feel}
	}
	return nil
}

func parsePlanRequest(sd *ScenesData, body []byte) (*guestRequest, *apiError) {
	var j planReqJSON
	if e := decodeStrict(body, &j); e != nil {
		return nil, e
	}
	r := &guestRequest{}
	if e := j.check(sd, r); e != nil {
		return nil, e
	}
	r.Audio = j.Audio != nil && *j.Audio
	return r, nil
}

// parseJobRequest checks a JobRequest; audio says whether an audio part came with it.
func parseJobRequest(sd *ScenesData, body []byte, audio bool) (*guestRequest, *apiError) {
	var j jobReqJSON
	if e := decodeStrict(body, &j); e != nil {
		return nil, e
	}
	r := &guestRequest{Audio: audio}
	if e := j.check(sd, r); e != nil {
		return nil, e
	}
	if j.Consent == nil || j.Consent.Own == nil || j.Consent.Adult == nil || !*j.Consent.Own || !*j.Consent.Adult {
		return nil, &apiError{Status: 400, Code: "consent", Message: "Tick the box: it's you or you have permission, and they're 18 or older.", Field: "consent"}
	}
	r.Consent = true
	if j.Seed != nil {
		if !isInt(*j.Seed) || *j.Seed < 0 || *j.Seed > math.MaxUint32 {
			return nil, badField("seed")
		}
		s := uint32(*j.Seed)
		r.Seed = &s
	}
	if j.LipStarts != nil {
		r.LipStarts = *j.LipStarts
		if r.LipStarts == nil {
			r.LipStarts = []*float64{} // [] given (not null): still checked against the plan
		}
	}
	return r, nil
}

// planShot is one shot of a plan with everything the graphs need.
type planShot struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Lip     bool     `json:"lip"`
	Seconds float64  `json:"seconds"`
	Offset  *float64 `json:"offset"`

	stillPrompt, motionPrompt, negative string
	seed                                uint64
}

type planSong struct {
	Seconds float64 `json:"seconds"`

	style, lyrics, language string
	seed                    uint64
}

type videoSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// GuestPlan is the "plan" object of the guest API (plus what the runner needs).
type GuestPlan struct {
	SceneID         string     `json:"sceneId"`
	SceneName       string     `json:"sceneName"`
	Duration        int        `json:"duration"`
	Sound           string     `json:"sound"`
	Sync            string     `json:"sync"`
	Quality         string     `json:"quality"`
	StillModel      string     `json:"stillModel"`
	Video           videoSize  `json:"video"`
	NeedsAudio      bool       `json:"needsAudio"`
	AudioMinSeconds *float64   `json:"audioMinSeconds"`
	Shots           []planShot `json:"shots"`
	Song            *planSong  `json:"song"`
	EstimateMin     [2]int     `json:"estimateMin"`

	hint  string
	seed  uint64
	steps []string
}

type hostPacks struct {
	Singing, Fast bool
	Laptop        bool
	Cold          bool // the engine is not running: its start counts in the estimate
}

// jsRound is ECMAScript Math.round for x >= 0.
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		return r + 1
	}
	return r
}

func round3(x float64) float64 { return jsRound(float64(x*1000)) / 1000 }

func fptr(x float64) *float64 { return &x }

var errMissingPack = &apiError{Status: 409, Code: "missing-pack", Message: "This needs the Singing add-on, which isn't installed on your friend's PC."}

// guestPlan computes the plan (seed: the job's seed; 0 for a plan preview).
func guestPlan(sd *ScenesData, req *guestRequest, packs hostPacks, seed uint32) (*GuestPlan, *apiError) {
	sc := sd.scene(req.SceneID)
	if sc == nil {
		return nil, badField("sceneId")
	}
	sound := req.Sound
	switch {
	case req.Sound == "own":
		sound = "own"
	case sc.Audio == "required":
		sound = "ai"
	case req.Sound == "ai" && sc.Song == nil:
		sound = "music"
	}
	if sound == "ai" && !packs.Singing {
		return nil, errMissingPack
	}
	lipsAvailable := packs.Singing && ((sound == "own" && req.Audio) || (sound == "ai" && sc.Song != nil))
	sync := "beat"
	if req.Sync == "lips" && lipsAvailable {
		sync = "lips"
	}
	shots := sd.shots(sc, req.Duration)
	n := len(shots)
	lip := make([]bool, n)
	lips := 0
	for k, sh := range shots {
		lip[k] = lipsAvailable && (sync == "lips" || (sh.LipSync && (sc.Story || sound == "ai")))
		if lip[k] {
			lips++
		}
	}
	if (sound == "own" && req.Audio && lips == 0) || (sound != "own" && req.Audio) {
		return nil, &apiError{Status: 400, Code: "unexpected-audio", Message: "This video doesn't use your song's voice part. Reload the page and try again."}
	}
	quality := req.Quality
	if sound == "ai" || lips > 0 {
		quality = "best"
	}
	p := &GuestPlan{SceneID: sc.ID, SceneName: sc.Name, Duration: req.Duration, Sound: sound, Sync: sync, Quality: quality,
		StillModel: "qwen", Video: videoSize{480, 832}, seed: uint64(seed)}
	if quality == "fast" {
		p.Video = videoSize{384, 672}
		if packs.Fast {
			p.StillModel = "klein"
		}
	}
	p.hint = sd.hint(sc, sound, req.Tempo)
	for k, sh := range shots {
		ps := planShot{ID: sh.ID, Title: sh.Title, Lip: lip[k], Seconds: i2vSeconds, seed: uint64(seed) + uint64(k)*1000003}
		if lip[k] {
			ps.Seconds = s2vSeconds
			ps.motionPrompt = jsTrim(sh.Sing)
		} else {
			ps.motionPrompt = jsTrim(sh.Motion + p.hint)
		}
		ps.stillPrompt = jsTrim(sd.stillPrompt(p.StillModel, sh))
		ps.negative = jsTrim(sd.Local.Negative)
		p.Shots = append(p.Shots, ps)
	}
	// Planning timeline (ai.js localJob/planTimeline, no beat grid).
	B := make([]float64, n+1)
	for k := 0; k < n; k++ {
		step := planDanceSec
		if lip[k] {
			step = s2vSeconds
		}
		B[k+1] = B[k] + step
	}
	switch {
	case sound == "ai":
		asked := math.Max(10, math.Min(60, math.Ceil(float64(B[n]+2))))
		cur, need := 0.0, 0.0
		for k := range p.Shots {
			at := cur
			if lip[k] {
				at = jsRound(float64(B[k]*1000)) / 1000
			}
			off := jsRound(float64(at*1e6)) / 1e6
			p.Shots[k].Offset = fptr(off)
			cur = at + p.Shots[k].Seconds
			reach := p.Shots[k].Seconds
			if lip[k] {
				reach = s2vAudioSeconds
			}
			need = math.Max(need, float64(off+reach))
		}
		sec := math.Max(asked, math.Ceil(float64(need*10))/10)
		sec = jsRound(float64(math.Min(120, math.Max(5, sec))*10)) / 10
		lang := sd.Local.SongLanguage
		known := false
		for _, l := range aceLangs {
			known = known || l == lang
		}
		if !known {
			lang = "es"
		}
		p.Song = &planSong{Seconds: sec, style: jsTrim(sc.Song.Style), lyrics: jsTrim(sc.Song.Lyrics), language: lang, seed: uint64(seed)}
	case sound == "own" && lips > 0:
		p.NeedsAudio = true
		last := 0.0
		for k := range p.Shots {
			if lip[k] {
				last = B[k]
			}
		}
		p.AudioMinSeconds = fptr(round3(float64(last + s2vAudioSeconds)))
	}
	for k := range p.Shots {
		p.steps = append(p.steps, "still:"+strconv.Itoa(k))
	}
	if p.Song != nil {
		p.steps = append(p.steps, "song")
	}
	for k := range p.Shots {
		if !lip[k] {
			p.steps = append(p.steps, "video:"+strconv.Itoa(k))
		}
	}
	for k := range p.Shots {
		if lip[k] {
			p.steps = append(p.steps, "lipsync:"+strconv.Itoa(k))
		}
	}
	p.EstimateMin = estimateStory(n, lips, quality == "fast", packs.Fast, p.Song != nil, packs.Laptop, packs.Cold)
	return p, nil
}

// applyLipStarts checks the own-song lip-sync starts of a job (seconds from the
// start of the uploaded WAV) and puts them in the plan (DESIGN d.3). starts
// is nil when the request had none (null).
func (p *GuestPlan) applyLipStarts(starts []*float64, wavSeconds float64) *apiError {
	if !(p.Sound == "own" && p.NeedsAudio) {
		if starts != nil {
			return badField("lipStarts")
		}
		return nil
	}
	if len(starts) != len(p.Shots) {
		return badField("lipStarts")
	}
	prev := -1.0
	maxStart := 0.0
	for k, sh := range p.Shots {
		v := starts[k]
		if (v != nil) != sh.Lip {
			return badField("lipStarts")
		}
		if v == nil {
			continue
		}
		x := *v
		if math.IsNaN(x) || math.IsInf(x, 0) || x < 0 || x > 25 {
			return badField("lipStarts")
		}
		if prev >= 0 && (x < prev || x-prev < 4.5) {
			return badField("lipStarts")
		}
		prev, maxStart = x, math.Max(maxStart, x)
	}
	if maxStart+s2vAudioSeconds > wavSeconds+0.05 {
		return &apiError{Status: 400, Code: "bad-audio", Message: "The part of your song that was sent is too short for this video. Pick another part of the song and try again.", Field: "audio"}
	}
	for k := range p.Shots {
		if starts[k] != nil {
			p.Shots[k].Offset = fptr(round3(*starts[k]))
		}
	}
	return nil
}

// STORY_MIN of local-engine.js estimateStory (minutes on an RTX 5060 8 GB).
var storyMin = map[string][2]float64{"stillQwen": {1, 1.5}, "stillKlein": {0.25, 0.45}, "swap": {0.2, 1}, "song": {0.5, 1.5},
	"video": {3.7, 6.5}, "videoFast": {2.2, 4}, "s2v": {4.5, 7}, "cold": {0.5, 1.5}}

func estimateStory(n, lip int, fast, hasFast, song, laptop, cold bool) [2]int {
	lo, hi := 0.0, 0.0
	add := func(k string, times int) {
		r := storyMin[k]
		lo += r[0] * float64(times)
		hi += r[1] * float64(times)
	}
	if cold {
		add("cold", 1)
	}
	if fast && hasFast {
		add("stillKlein", n)
	} else {
		add("stillQwen", n)
	}
	swaps := 0
	if song {
		swaps++
	}
	if n-lip > 0 {
		swaps++
	}
	if lip > 0 {
		swaps++
	}
	add("swap", swaps)
	if song {
		add("song", 1)
	}
	if fast {
		add("videoFast", n-lip)
	} else {
		add("video", n-lip)
	}
	add("s2v", lip)
	if laptop {
		lo *= 1.2
		hi *= 1.4
	}
	return roundRange(lo, hi)
}

func roundRange(lo, hi float64) [2]int {
	a := int(math.Max(1, jsRound(lo)))
	b := int(math.Max(float64(a+1), math.Ceil(hi)))
	return [2]int{a, b}
}

var laptopRe = regexp.MustCompile(`(?i)laptop|mobile|max-q`)

// stepParts splits "video:2" into ("video", 2); "song" -> ("song", -1).
func stepParts(step string) (string, int) {
	if i := strings.IndexByte(step, ':'); i > 0 {
		k, err := strconv.Atoi(step[i+1:])
		if err == nil {
			return step[:i], k
		}
	}
	return step, -1
}

// stepSeconds weighs a step for progress (local-engine.js STAGE_SEC).
func (p *GuestPlan) stepSeconds(step string) float64 {
	st, _ := stepParts(step)
	switch st {
	case "still":
		if p.StillModel == "klein" {
			return 25
		}
		return 80
	case "song":
		return 60
	case "video":
		if p.Quality == "fast" {
			return 165
		}
		return 270
	case "lipsync":
		return 345
	}
	return 5
}

func (p *GuestPlan) String() string {
	lips := 0
	for _, s := range p.Shots {
		if s.Lip {
			lips++
		}
	}
	return fmt.Sprintf("%s %d s %s %s %s (%d lip-sync)", p.SceneID, p.Duration, p.Sound, p.Sync, p.Quality, lips)
}
