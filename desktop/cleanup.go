package main

// Privacy: the files ComfyUI keeps for a video (the selfie it was given, the
// part of the user's own song it was given for lip-sync, and the unlabelled
// scene photos, song and clips it made) are removed once the page has them, so
// the only copy left is the labelled video in Glow Studio's own history. See
// glow/local-engine.js (cleanupJob).
//
//	POST /__glow/engine/cleanup {"job":"<id>","prompts":["<prompt id>",...]} -> 200 {"ok":true,"removed":N}
//
// Only Glow Studio's own subfolders are touched (ComfyUI\input\glow and
// ComfyUI\output\glow), and only files named after that job. Whatever a closed
// page could not clean up is swept when the engine starts (files older than a
// day).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	cleanupJobRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	cleanupPromptRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
)

// sweepAge: files in the glow subfolders older than this are removed when the
// engine starts (a page keeps a running video for at most 12 hours).
var sweepAge = 24 * time.Hour

func glowWorkDirs(installDir string) []string {
	root := filepath.Join(installDir, portableDir, "ComfyUI")
	return []string{filepath.Join(root, "input", "glow"), filepath.Join(root, "output", "glow")}
}

// removeJobFiles deletes the selfie (input\glow\selfie_<job>.*), the song
// segment for lip-sync (input\glow\audio_<job>.*) and every output of the job
// (output\glow\<job>_*, including a story's <job>_s<N>_*). It returns how many
// files were removed.
func removeJobFiles(installDir, job string) int {
	n := 0
	dirs := glowWorkDirs(installDir)
	prefixes := [][]string{{"selfie_" + job + ".", "audio_" + job + "."}, {job + "_"}}
	for i, d := range dirs {
		ents, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, ent := range ents {
			name := ent.Name()
			if !ent.Type().IsRegular() || !hasAnyPrefix(name, prefixes[i]) {
				continue
			}
			if removeRetry(filepath.Join(d, name)) == nil {
				n++
			}
		}
	}
	return n
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// sweepOldFiles deletes files in the glow subfolders that are older than age.
func sweepOldFiles(installDir string, age time.Duration) int {
	n := 0
	cut := time.Now().Add(-age)
	for _, d := range glowWorkDirs(installDir) {
		ents, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, ent := range ents {
			if !ent.Type().IsRegular() {
				continue
			}
			info, err := ent.Info()
			if err != nil || info.ModTime().After(cut) {
				continue
			}
			if removeRetry(filepath.Join(d, ent.Name())) == nil {
				n++
			}
		}
	}
	return n
}

// deleteComfyHistory asks a running ComfyUI to forget these prompts (their
// graphs name the selfie and the output files).
func deleteComfyHistory(port int, prompts []string) error {
	if port == 0 || len(prompts) == 0 {
		return nil
	}
	body, _ := json.Marshal(map[string]any{"delete": prompts})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/history", port), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := localClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (e *Engine) handleCleanup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Job     string   `json:"job"`
		Prompts []string `json:"prompts"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || !cleanupJobRe.MatchString(req.Job) {
		errJSON(w, http.StatusBadRequest, "The request was not understood.")
		return
	}
	var prompts []string
	for _, p := range req.Prompts {
		if cleanupPromptRe.MatchString(p) && len(prompts) < 64 { // a story has up to 9 steps, plus retries
			prompts = append(prompts, p)
		}
	}
	e.releaseHold(req.Job)
	e.mu.Lock()
	dir := e.installDir
	port := 0
	if e.proc != nil && e.state == "ready" {
		port = e.comfyPort
	}
	e.mu.Unlock()
	removed := removeJobFiles(dir, req.Job)
	histErr := deleteComfyHistory(port, prompts)
	if removed > 0 || len(prompts) > 0 {
		msg := fmt.Sprintf("[launcher] removed the AI copies of video %s (%d files)", req.Job, removed)
		if histErr != nil {
			msg += "; history: " + histErr.Error()
		}
		e.logs.add(msg)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed, "history": histErr == nil})
}
