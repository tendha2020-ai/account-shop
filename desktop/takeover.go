package main

// Updating Glow Studio: the user downloads a newer GlowStudio.exe and opens it
// while an older copy is still running (its window open, or idle for up to 30
// minutes after the window closed). Without care the new copy would find the
// old one on the port, open a window on it and quit, so the user would keep
// seeing the OLD app. Instead:
//
//   - the running copy says which version it is (GET /__glow/version; older
//     launchers only through their engine status);
//   - a newer copy asks an older one to quit (POST /__glow/quit, loopback and
//     same-origin only, and only for a newer version) or, for launchers older
//     than this mechanism, ends it by the process id it recorded in
//     instance.json (only a "glow" program on that same port). On Windows that
//     also ends its ComfyUI (a kill-on-close job object). The new copy then
//     starts on the same port, so the old window keeps its origin and works;
//   - never while the old copy is busy (downloading the AI files, ComfyUI making
//     a video, or a video in progress): the new copy opens a window on the old
//     one and says to try again in a few minutes.
//
// Models and the AI folder are untouched; the new copy uses the same folder.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// versionInfo is the answer of GET /__glow/version.
type versionInfo struct {
	App     string `json:"app"`
	Version string `json:"version"`
	Busy    bool   `json:"busy"`
	Why     string `json:"why,omitempty"`
	PID     int    `json:"pid"`
}

// newerVersion reports whether version a is newer than b ("1.10.0" > "1.9.2").
// An empty or unreadable version counts as the oldest.
func newerVersion(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func versionParts(v string) [3]int {
	var out [3]int
	for i, p := range strings.SplitN(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".", 3) {
		n, err := strconv.Atoi(strings.TrimFunc(p, func(r rune) bool { return r < '0' || r > '9' }))
		if err != nil {
			return [3]int{}
		}
		out[i] = n
	}
	return out
}

// runningInfo asks the Glow Studio on port what it is and whether it is busy.
// canQuit: it understands POST /__glow/quit.
func runningInfo(port int) (info versionInfo, canQuit bool) {
	c := http.Client{Timeout: 4 * time.Second}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	if resp, err := c.Get(base + "/__glow/version"); err == nil {
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&info) == nil && info.Version != ""
		resp.Body.Close()
		if ok {
			return info, true
		}
	}
	// launchers before 1.3.0: the engine status has the version and the install
	// job; ComfyUI's queue (through the launcher's proxy) shows a video in the making
	info = versionInfo{App: "glow-studio"}
	var st struct {
		Launcher string `json:"launcher"`
		Engine   struct {
			State string `json:"state"`
		} `json:"engine"`
		Job *struct {
			State string `json:"state"`
		} `json:"job"`
	}
	resp, err := c.Get(base + "/__glow/engine/status")
	if err != nil {
		return info, false
	}
	ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&st) == nil
	resp.Body.Close()
	if !ok {
		return info, false // a launcher from before the AI engine: nothing it could be busy with
	}
	info.Version = st.Launcher
	switch {
	case st.Job != nil && st.Job.State == "running":
		info.Busy, info.Why = true, "downloading the AI files"
	case st.Engine.State == "starting":
		info.Busy, info.Why = true, "starting the AI engine"
	case st.Engine.State == "ready":
		var q struct {
			Running []json.RawMessage `json:"queue_running"`
			Pending []json.RawMessage `json:"queue_pending"`
		}
		r2, err := c.Get(base + "/__glow/comfy/queue")
		if err != nil {
			info.Busy, info.Why = true, "the AI engine is not answering"
			return info, false
		}
		qok := json.NewDecoder(io.LimitReader(r2.Body, 8<<20)).Decode(&q) == nil
		r2.Body.Close()
		if !qok || len(q.Running)+len(q.Pending) > 0 {
			info.Busy, info.Why = true, "making a video"
		}
	}
	return info, false
}

// takeOver is called when a Glow Studio already answers on port. It returns a
// listener on that port when this (newer) copy may start in its place, or a
// note for the user when the running copy has to be used for now (nil, "":
// the running copy is as new as this one: simply use it).
func takeOver(port int) (net.Listener, string) {
	info, canQuit := runningInfo(port)
	if !newerVersion(launcherVersion, info.Version) {
		return nil, ""
	}
	old := info.Version
	if old == "" {
		old = "an older version"
	}
	launcherLog.printf("[launcher] Glow Studio %s is running on port %d; this copy is %s", old, port, launcherVersion)
	if info.Busy {
		launcherLog.printf("[launcher] the older copy is busy (%s): opening a window on it; update later", info.Why)
		return nil, "The older Glow Studio that is still open is busy (" + info.Why + "). Its window opens now so nothing is lost.\n\nWhen it is done, close all Glow Studio windows, wait a minute, and open the new Glow Studio again. Your AI models are kept."
	}
	asked := false
	if canQuit {
		asked = askQuit(port)
	}
	if !asked {
		asked = stopRecordedInstance(port)
	}
	if !asked {
		launcherLog.printf("[launcher] could not close the older copy: opening a window on it")
		return nil, "An older Glow Studio is still open. Close all Glow Studio windows, wait a minute, then open the new Glow Studio again. Your AI models are kept."
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			launcherLog.printf("[launcher] the older Glow Studio (%s) has closed: this copy (%s) takes over port %d", old, launcherVersion, port)
			return l, ""
		}
		time.Sleep(200 * time.Millisecond)
	}
	launcherLog.printf("[launcher] the older copy did not close in time")
	return nil, "An older Glow Studio is still closing. Wait a minute, then open Glow Studio again."
}

// askQuit: POST /__glow/quit to a launcher that knows it (1.3.0 and later).
func askQuit(port int) bool {
	c := http.Client{Timeout: 4 * time.Second}
	body := strings.NewReader(fmt.Sprintf(`{"version":%q}`, launcherVersion))
	resp, err := c.Post(fmt.Sprintf("http://127.0.0.1:%d/__glow/quit", port), "application/json", body)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// stopRecordedInstance ends the launcher recorded in instance.json, but only
// when it serves this port and its program is a Glow Studio.
func stopRecordedInstance(port int) bool {
	var in instanceInfo
	data, err := os.ReadFile(instancePath())
	if err != nil || json.Unmarshal(data, &in) != nil || in.Port != port || in.PID <= 0 || in.PID == os.Getpid() {
		return false
	}
	name := processName(in.PID)
	if !strings.Contains(strings.ToLower(filepath.Base(name)), "glow") {
		launcherLog.printf("[launcher] process %d is not a Glow Studio (%q): left alone", in.PID, name)
		return false
	}
	if err := stopProcess(in.PID); err != nil {
		launcherLog.printf("[launcher] could not close the older copy (process %d): %v", in.PID, err)
		return false
	}
	launcherLog.printf("[launcher] closed the older copy (process %d)", in.PID)
	return true
}

// handleVersion: GET /__glow/version (what this launcher is, and whether it is busy).
func handleVersion(e *Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !e.guard(w, r) {
			return
		}
		busy, why := e.BusyReason()
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, versionInfo{App: "glow-studio", Version: launcherVersion, Busy: busy, Why: why, PID: os.Getpid()})
	}
}

// handleQuit: POST /__glow/quit {"version": "<newer version>"} from a newer
// copy that takes over. Refused while busy, or for a version that is not newer.
func handleQuit(e *Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !e.guard(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			errJSON(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var req struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || !newerVersion(req.Version, launcherVersion) {
			errJSON(w, http.StatusBadRequest, "only a newer Glow Studio can ask this one to quit")
			return
		}
		if busy, why := e.BusyReason(); busy {
			writeJSON(w, http.StatusConflict, map[string]any{"busy": true, "why": why})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		goSafe("quit", func() {
			time.Sleep(150 * time.Millisecond) // let the answer go out
			quitApp("Glow Studio " + req.Version + " is taking over (update)")
		})
	}
}

// quitApp ends the launcher for an update (tests replace it).
var quitApp = func(reason string) { exitApp(0, reason) }
