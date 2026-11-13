package main

// Scene prompt data for friends' videos ("Share with friends"): glow/scenes.json,
// the same file the web app (glow/scenes.js, ai.js) reads. The launcher builds
// every prompt a friend's video uses from these strings, with exactly the same
// rules as the web app (DESIGN a.3), so a friend can only pick presets: no text
// a friend sends ever reaches ComfyUI.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type ScenesData struct {
	Format       string     `json:"format"`
	Version      int        `json:"version"`
	DefaultScene string     `json:"defaultScene"`
	Local        LocalRules `json:"local"`
	Variants     []Variant  `json:"variants"`
	Scenes       []Scene    `json:"scenes"`

	byID map[string]*Scene
}

type LocalRules struct {
	Who            map[string]string `json:"who"`
	RulesBefore    string            `json:"rulesBefore"`
	DefaultFraming string            `json:"defaultFraming"`
	RulesAfter     string            `json:"rulesAfter"`
	Negative       string            `json:"negative"`
	MotionEnd      string            `json:"motionEnd"`
	SongHint       string            `json:"songHint"`
	TempoHints     map[string]string `json:"tempoHints"`
	SongLanguage   string            `json:"songLanguage"`
}

type Variant struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	LStill  string `json:"lstill"`
	LMotion string `json:"lmotion"`
	Framing string `json:"framing"`
}

type SceneLocal struct {
	Still   string `json:"still"`
	Motion  string `json:"motion"`
	Sing    string `json:"sing"`
	Framing string `json:"framing"`
}

type SceneShot struct {
	ID      string     `json:"id"`
	Title   string     `json:"title"`
	LipSync bool       `json:"lipSync"`
	Local   SceneLocal `json:"local"`
}

type SceneSong struct {
	Style  string `json:"style"`
	Lyrics string `json:"lyrics"`
}

type Scene struct {
	ID     string              `json:"id"`
	Name   string              `json:"name"`
	Audio  string              `json:"audio"`
	Length int                 `json:"length"`
	Story  bool                `json:"story"`
	Local  *SceneLocal         `json:"local"`
	Shots  []SceneShot         `json:"shots"`
	Pick   map[string][]string `json:"pick"`
	Song   *SceneSong          `json:"song"`
}

var sceneIDRe = regexp.MustCompile(`^[a-z0-9-]{2,32}$`)

// loadScenesFS reads scenes.json from the web app bundle.
func loadScenesFS(app fs.FS) (*ScenesData, error) {
	data, err := fs.ReadFile(app, "scenes.json")
	if err != nil {
		return nil, fmt.Errorf("scenes.json: %w", err)
	}
	return loadScenes(data)
}

func loadScenes(data []byte) (*ScenesData, error) {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("scenes.json: %w", err)
	}
	if err := checkStringLengths(raw, 4096); err != nil {
		return nil, err
	}
	d := &ScenesData{}
	if err := json.Unmarshal(data, d); err != nil {
		return nil, fmt.Errorf("scenes.json: %w", err)
	}
	if err := d.validate(); err != nil {
		return nil, fmt.Errorf("scenes.json: %w", err)
	}
	return d, nil
}

func checkStringLengths(v any, max int) error {
	switch t := v.(type) {
	case string:
		if len(t) > max {
			return fmt.Errorf("scenes.json: a text is longer than %d bytes", max)
		}
	case []any:
		for _, x := range t {
			if err := checkStringLengths(x, max); err != nil {
				return err
			}
		}
	case map[string]any:
		for _, x := range t {
			if err := checkStringLengths(x, max); err != nil {
				return err
			}
		}
	}
	return nil
}

// validate applies the load-time rules of DESIGN a.4.
func (d *ScenesData) validate() error {
	if d.Format != "glow-scenes" || d.Version != 1 {
		return fmt.Errorf("unknown format %q version %d", d.Format, d.Version)
	}
	L := d.Local
	if L.Who["qwen"] == "" || L.Who["klein"] == "" || L.RulesBefore == "" || L.RulesAfter == "" || L.DefaultFraming == "" {
		return errors.New("local rules are incomplete")
	}
	if L.MotionEnd == "" || L.Negative == "" || L.SongHint == "" || L.SongLanguage == "" {
		return errors.New("local texts are incomplete")
	}
	for _, f := range []string{"fast", "upbeat", "slow"} {
		if strings.Count(L.TempoHints[f], "{bpm}") != 1 {
			return fmt.Errorf("tempo hint %q must contain {bpm} once", f)
		}
	}
	want := []string{"main", "closer", "angle", "closeup"}
	if len(d.Variants) < len(want) {
		return errors.New("at least 4 variants are needed")
	}
	for i, id := range want {
		if d.Variants[i].ID != id {
			return fmt.Errorf("variant %d must be %q", i, id)
		}
	}
	d.byID = map[string]*Scene{}
	for i := range d.Scenes {
		sc := &d.Scenes[i]
		if !sceneIDRe.MatchString(sc.ID) {
			return fmt.Errorf("bad scene id %q", sc.ID)
		}
		if d.byID[sc.ID] != nil {
			return fmt.Errorf("scene %q appears twice", sc.ID)
		}
		d.byID[sc.ID] = sc
		switch sc.Audio {
		case "optional", "recommended", "required":
		default:
			return fmt.Errorf("scene %q: bad audio %q", sc.ID, sc.Audio)
		}
		if sc.Song != nil && (sc.Song.Style == "" || sc.Song.Lyrics == "") {
			return fmt.Errorf("scene %q: song without style or lyrics", sc.ID)
		}
		if sc.Audio == "required" && sc.Song == nil {
			return fmt.Errorf("scene %q needs a song", sc.ID)
		}
		if sc.Story {
			if len(sc.Shots) == 0 {
				return fmt.Errorf("story %q has no shots", sc.ID)
			}
			ids := map[string]bool{}
			for _, s := range sc.Shots {
				if s.ID == "" || ids[s.ID] {
					return fmt.Errorf("story %q: bad or repeated shot id %q", sc.ID, s.ID)
				}
				ids[s.ID] = true
				if s.Local.Still == "" || s.Local.Motion == "" || s.Local.Sing == "" {
					return fmt.Errorf("story %q shot %q: local texts are incomplete", sc.ID, s.ID)
				}
			}
			for k, list := range sc.Pick {
				for _, id := range list {
					if !ids[id] {
						return fmt.Errorf("story %q: pick %s names unknown shot %q", sc.ID, k, id)
					}
				}
			}
		} else {
			if sc.Local == nil || sc.Local.Still == "" || sc.Local.Sing == "" || !strings.HasSuffix(sc.Local.Motion, L.MotionEnd) {
				return fmt.Errorf("scene %q: local texts are incomplete", sc.ID)
			}
		}
	}
	if d.byID[d.DefaultScene] == nil {
		return fmt.Errorf("default scene %q does not exist", d.DefaultScene)
	}
	return nil
}

func (d *ScenesData) scene(id string) *Scene { return d.byID[id] }

// composedShot is one shot of a friend's video (DESIGN a.3 shots()).
type composedShot struct {
	ID, Title, Still, Motion, Framing, Sing string
	LipSync                                 bool
}

func shotCount(d int) int {
	switch {
	case d >= 20:
		return 4
	case d >= 10:
		return 2
	}
	return 1
}

func (d *ScenesData) shots(sc *Scene, dur int) []composedShot {
	n := shotCount(dur)
	var out []composedShot
	if sc.Story {
		ids := sc.Pick[strconv.Itoa(n*5)]
		if ids == nil {
			for i := 0; i < n && i < len(sc.Shots); i++ {
				ids = append(ids, sc.Shots[i].ID)
			}
		}
		for _, id := range ids {
			s := sc.Shots[0]
			for _, x := range sc.Shots {
				if x.ID == id {
					s = x
					break
				}
			}
			out = append(out, composedShot{ID: s.ID, Title: s.Title, Still: s.Local.Still, Motion: s.Local.Motion,
				Framing: s.Local.Framing, Sing: s.Local.Sing, LipSync: s.LipSync})
		}
		return out
	}
	base := sc.Local.Motion
	if strings.HasSuffix(base, d.Local.MotionEnd) {
		base = base[:len(base)-len(d.Local.MotionEnd)]
	}
	for i := 0; i < n && i < len(d.Variants); i++ {
		v := d.Variants[i]
		out = append(out, composedShot{ID: v.ID, Title: v.Title, Still: sc.Local.Still + v.LStill,
			Motion: base + v.LMotion + d.Local.MotionEnd, Framing: v.Framing, Sing: sc.Local.Sing, LipSync: sc.Song != nil})
	}
	return out
}

func (d *ScenesData) stillPrompt(model string, sh composedShot) string {
	framing := sh.Framing
	if framing == "" {
		framing = d.Local.DefaultFraming
	}
	return d.Local.Who[model] + sh.Still + "." + d.Local.RulesBefore + framing + d.Local.RulesAfter
}

// Tempo is the beat of the friend's music, measured by their browser.
type Tempo struct {
	BPM  int    `json:"bpm"`
	Feel string `json:"feel"`
}

func (d *ScenesData) hint(sc *Scene, sound string, t *Tempo) string {
	switch sound {
	case "ai":
		if sc.Story {
			return d.Local.SongHint
		}
		return ""
	case "music", "own":
		if t == nil || t.BPM <= 0 {
			return ""
		}
		return strings.Replace(d.Local.TempoHints[t.Feel], "{bpm}", strconv.Itoa(t.BPM), 1)
	}
	return ""
}

// jsTrim is ECMAScript String.prototype.trim (the web app trims every prompt).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0xFEFF, 0x2028, 0x2029:
			return true
		}
		return unicode.Is(unicode.Zs, r)
	})
}
