package main

// "Share with friends": the host lets friends make AI Scenes videos from their
// own phone or computer while this PC's GPU does the work (DESIGN.md of the
// share design). This file is the manager: the sharing state machine
// (off -> starting -> on -> closing -> off), the settings, the host's API
// (/__glow/share/*, main listener only, behind Engine.guard) and its status.
//
//	GET  /__glow/share/status                        -> ShareStatus
//	POST /__glow/share/start   {mode, hostName, dailyLimit?, approve?, autoStopHours?} -> 202 ShareStatus
//	POST /__glow/share/stop    {now?}                -> 200 ShareStatus (closing, or off at once)
//	POST /__glow/share/settings {hostName?, dailyLimit?, approve?, autoStopHours?, mode?} -> 200 ShareStatus
//	POST /__glow/share/new-link {}                   -> 200 ShareStatus (the old link stops admitting people)
//	POST /__glow/share/guests/<id>/block {blocked}   -> 200 ShareStatus
//	POST /__glow/share/jobs/<id>/approve|decline|cancel {} -> 200 ShareStatus
//	GET  /__glow/share/jobs/<id>/thumb               -> image/jpeg (only while waiting for approval)
//
// Friends reach a SEPARATE listener (guestserver.go) on 127.0.0.1:<guest
// port> (the Cloudflare tunnel's target, tunnel.go) and, in "Same Wi-Fi only"
// mode, on this PC's private LAN address (lan.go). ComfyUI and the host's own
// API stay on 127.0.0.1 exactly as before; friends never reach them. Their
// videos are made by the launcher itself (guestrun.go) from preset scenes
// (scenes.go, guestplan.go, guestgraphs.go), with the AI label inside the graph.
//
// Test hooks: GLOW_GUEST_PORT, GLOW_CLOUDFLARED_CMD, GLOW_LAN_IP,
// GLOW_SHARE_TEST_HTTP=1, GLOW_GUEST_POLL_MS, GLOW_SHARE_AUTOSTOP (Go duration),
// GLOW_SHARE_CLOSE_GRACE (default 30m), GLOW_SHARE_DAY_OFFSET (hours).

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// shareEngine is what sharing needs from the local AI engine (Engine; a fake in tests).
type shareEngine interface {
	shareComfy() (port int, state string) // state: ready | starting | stopped | error | not-installed
	startEngine() error
	sharePacks() (core, singing, fast bool)
	shareInstallDir() string
	hostBusy() (bool, string)             // the host's own video (a hold renewed in the last 5 min) or an install
	hostEta() (sum [2]float64, noEta int) // the host's own remaining minutes (holds with an estimate) + holds without one
	shareGPUName() string
}

type shareSettings struct {
	HostName      string `json:"hostName"`
	DailyLimit    int    `json:"dailyLimit"`
	Approve       bool   `json:"approve"`
	AutoStopHours int    `json:"autoStopHours"`
	Mode          string `json:"mode"`
}

func defaultShareSettings() shareSettings {
	return shareSettings{DailyLimit: 5, AutoStopHours: 4, Mode: "internet"}
}

const (
	maxGuestSessions = 50
	maxNamedGuests   = 12
	maxQueuedJobs    = 8
	unnamedTTL       = 30 * time.Minute
	sessionTTL       = 12 * time.Hour
	jobKeep          = 24 * time.Hour
	onlineWithin     = 45 * time.Second
)

type Share struct {
	mu           sync.Mutex
	eng          shareEngine
	app          fs.FS
	settingsPath string
	settings     shareSettings

	// knobs (env hooks; tests set them directly)
	guestPort      int // preferred guest port (0: any)
	pollEvery      time.Duration
	hostCheckEvery time.Duration
	engineWait     time.Duration
	closeGrace     time.Duration
	autoStop       time.Duration // replaces autoStopHours when set
	dayOffset      time.Duration
	testHTTP       bool
	stepTimeout    time.Duration
	cancelGrace    time.Duration // cleanup of a cancelled running job waits this long
	tunnelFactory  func(s *Share, gport int) tunnelRunner

	state, lastErr     string
	startedAt, stopsAt time.Time
	closingSince       time.Time
	stopReason         string
	ctx                context.Context
	cancel             context.CancelFunc
	periodDone         chan struct{}
	scenes             *ScenesData
	index              []byte
	csp                string
	token              string
	linkChangedAt      time.Time
	sessions           map[string]*guestSession
	guests             map[string]*guestRec
	jobs               map[string]*guestJob
	order              []*guestJob
	gport              int
	ln, lanLn          net.Listener
	srv, lanSrv        *http.Server
	lan                *lanAddr
	tun                tunnelRunner
	wake               chan struct{}
	ours               map[string]bool
	limits             *guestLimits
	uploads, downloads chan struct{}
	lastFinished       time.Time
	running            *guestJob
	lastLANCheck       time.Time
}

func newShare(eng shareEngine, app fs.FS) *Share {
	s := &Share{eng: eng, app: app, state: "off", settings: defaultShareSettings(),
		settingsPath:   filepath.Join(filepath.Dir(engineDefaultDir()), "share.json"),
		guestPort:      47831,
		pollEvery:      2 * time.Second,
		hostCheckEvery: 3 * time.Second,
		engineWait:     6 * time.Minute,
		closeGrace:     30 * time.Minute,
		stepTimeout:    45 * time.Minute,
		cancelGrace:    3 * time.Second,
		tunnelFactory:  newCloudflaredTunnel,
	}
	if v, err := strconv.Atoi(os.Getenv("GLOW_GUEST_PORT")); err == nil && v >= 0 {
		s.guestPort = v
	}
	if v, err := strconv.Atoi(os.Getenv("GLOW_GUEST_POLL_MS")); err == nil && v > 0 {
		s.pollEvery = time.Duration(v) * time.Millisecond
		s.hostCheckEvery = s.pollEvery
	}
	if d, err := time.ParseDuration(os.Getenv("GLOW_SHARE_AUTOSTOP")); err == nil && d > 0 {
		s.autoStop = d
	}
	if d, err := time.ParseDuration(os.Getenv("GLOW_SHARE_CLOSE_GRACE")); err == nil && d > 0 {
		s.closeGrace = d
	}
	if v, err := strconv.ParseFloat(os.Getenv("GLOW_SHARE_DAY_OFFSET"), 64); err == nil {
		s.dayOffset = time.Duration(v * float64(time.Hour))
	}
	s.testHTTP = os.Getenv("GLOW_SHARE_TEST_HTTP") == "1"
	if data, err := os.ReadFile(s.settingsPath); err == nil {
		var st shareSettings
		if json.Unmarshal(data, &st) == nil {
			s.settings = cleanSettings(st)
		}
	}
	return s
}

func cleanSettings(st shareSettings) shareSettings {
	d := defaultShareSettings()
	if n, ok := sanitizeName(st.HostName); ok {
		d.HostName = n
	}
	if st.DailyLimit >= 1 && st.DailyLimit <= 20 {
		d.DailyLimit = st.DailyLimit
	}
	d.Approve = st.Approve
	if st.AutoStopHours == 1 || st.AutoStopHours == 4 || st.AutoStopHours == 12 {
		d.AutoStopHours = st.AutoStopHours
	}
	if st.Mode == "wifi" {
		d.Mode = "wifi"
	}
	return d
}

func (s *Share) saveSettingsLocked() {
	data, _ := json.MarshalIndent(s.settings, "", "  ")
	path := s.settingsPath
	goSafe("save share.json", func() {
		os.MkdirAll(filepath.Dir(path), 0o755)
		tmp := path + ".tmp"
		if os.WriteFile(tmp, data, 0o644) == nil {
			renameRetry(tmp, path)
		}
	})
}

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// sanitizeName keeps a display name safe to show and log: letters, marks,
// digits, symbols (emoji), spaces and .'-_!?&(); no control, format (bidi,
// zero-width) or other characters; 1-24 characters.
func sanitizeName(in string) (string, bool) {
	var b strings.Builder
	space := false
	for _, r := range in {
		switch {
		case unicode.IsSpace(r):
			space = b.Len() > 0
			continue
		case unicode.In(r, unicode.Cc, unicode.Cf, unicode.Co, unicode.Cs) || r == unicode.ReplacementChar:
			continue
		case unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.S) || strings.ContainsRune(".'-_!?&()", r):
		default:
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	out := b.String()
	n := len([]rune(out))
	if n < 1 || n > 24 {
		return "", false
	}
	return out, true
}

func (s *Share) dayKey(t time.Time) string { return t.Add(s.dayOffset).Local().Format("2006-01-02") }

// resetAt is the next local midnight (the daily limit starts again).
func (s *Share) resetAt(t time.Time) time.Time {
	l := t.Add(s.dayOffset).Local()
	next := time.Date(l.Year(), l.Month(), l.Day()+1, 0, 0, 0, 0, time.Local)
	return next.Add(-s.dayOffset)
}

func (s *Share) logf(format string, a ...any) {
	launcherLog.printf("[share] "+format, a...)
}

// BusyReason keeps the launcher running while sharing is on (no idle exit,
// no update takeover); closing the host's window changes nothing for friends.
func (s *Share) BusyReason() (bool, string) {
	if s == nil {
		return false, ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.state {
	case "off":
		return false, ""
	case "closing":
		return true, "finishing a friend's video"
	case "starting":
		return true, "sharing with friends is starting"
	}
	return true, "sharing with friends is on (stops at " + s.stopsAt.Local().Format("15:04") + ")"
}

// ---- start / stop ----

type startRequest struct {
	Mode          *string `json:"mode"`
	HostName      *string `json:"hostName"`
	DailyLimit    *int    `json:"dailyLimit"`
	Approve       *bool   `json:"approve"`
	AutoStopHours *int    `json:"autoStopHours"`
}

// applySettingsLocked checks and applies a settings change (s.mu held).
func (s *Share) applySettingsLocked(r startRequest) (modeChanged bool, e *apiError) {
	st := s.settings
	if r.HostName != nil {
		n, ok := sanitizeName(*r.HostName)
		if !ok {
			return false, &apiError{Status: 400, Code: "bad-name", Message: "Type your name as friends should see it (1 to 24 letters)."}
		}
		st.HostName = n
	}
	if r.DailyLimit != nil {
		if *r.DailyLimit < 1 || *r.DailyLimit > 20 {
			return false, &apiError{Status: 400, Code: "bad-request", Message: "Videos per friend per day must be 1 to 20.", Field: "dailyLimit"}
		}
		st.DailyLimit = *r.DailyLimit
	}
	if r.Approve != nil {
		st.Approve = *r.Approve
	}
	if r.AutoStopHours != nil {
		h := *r.AutoStopHours
		if h != 1 && h != 4 && h != 12 {
			return false, &apiError{Status: 400, Code: "bad-request", Message: "Sharing can stop after 1, 4 or 12 hours.", Field: "autoStopHours"}
		}
		st.AutoStopHours = h
	}
	if r.Mode != nil {
		if *r.Mode != "internet" && *r.Mode != "wifi" {
			return false, &apiError{Status: 400, Code: "bad-request", Message: "Unknown connection mode.", Field: "mode"}
		}
		modeChanged = *r.Mode != st.Mode
		st.Mode = *r.Mode
	}
	s.settings = st
	return modeChanged, nil
}

func (s *Share) autoStopAfter() time.Duration {
	if s.autoStop > 0 {
		return s.autoStop
	}
	return time.Duration(s.settings.AutoStopHours) * time.Hour
}

// Start turns sharing on.
func (s *Share) Start(r startRequest) *apiError {
	if core, _, _ := s.eng.sharePacks(); !core {
		return &apiError{Status: 409, Code: "not-installed", Message: "Install the free AI engine first: friends' videos are made by it."}
	}
	if r.HostName == nil {
		r.HostName = new(string)
		s.mu.Lock()
		*r.HostName = s.settings.HostName
		s.mu.Unlock()
	}
	s.mu.Lock()
	if s.state != "off" {
		s.mu.Unlock()
		return &apiError{Status: 409, Code: "already-on", Message: "Sharing is already on."}
	}
	if _, e := s.applySettingsLocked(r); e != nil {
		s.mu.Unlock()
		return e
	}
	s.saveSettingsLocked()
	mode := s.settings.Mode
	s.mu.Unlock()

	fail := func(code, msg string, err error) *apiError {
		s.logf("sharing could not start: %s (%v)", msg, err)
		s.mu.Lock()
		s.lastErr = msg
		s.mu.Unlock()
		return &apiError{Status: 409, Code: code, Message: msg}
	}
	sd, err := loadScenesFS(s.app)
	if err != nil {
		return fail("unavailable", "This version of Glow Studio can't share: its scene list is missing or damaged. Download Glow Studio again.", err)
	}
	index, csp, err := buildGuestIndex(s.app)
	if err != nil {
		return fail("unavailable", "This version of Glow Studio can't share: its friend page is damaged. Download Glow Studio again.", err)
	}
	var lan *lanAddr
	if mode == "wifi" {
		if lan, err = detectLAN(); err != nil {
			return fail("no-lan", "This PC doesn't seem to be on a home network. Use Anywhere instead.", err)
		}
	}
	ln, lanLn, port, err := listenGuest(s.guestPort, lan)
	if err != nil {
		return fail("listen", "Glow Studio could not open the friends' page on this PC. Restart Glow Studio and try again.", err)
	}

	s.mu.Lock()
	if s.state != "off" { // started twice at once
		s.mu.Unlock()
		ln.Close()
		if lanLn != nil {
			lanLn.Close()
		}
		return &apiError{Status: 409, Code: "already-on", Message: "Sharing is already on."}
	}
	now := time.Now()
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.periodDone = make(chan struct{})
	s.state, s.lastErr, s.stopReason = "starting", "", ""
	s.startedAt, s.stopsAt, s.closingSince = now, now.Add(s.autoStopAfter()), time.Time{}
	s.scenes, s.index, s.csp = sd, index, csp
	s.token, s.linkChangedAt = randToken(16), now
	s.sessions, s.guests, s.jobs, s.order = map[string]*guestSession{}, map[string]*guestRec{}, map[string]*guestJob{}, nil
	s.ours, s.limits = map[string]bool{}, newGuestLimits()
	s.uploads, s.downloads = make(chan struct{}, 2), make(chan struct{}, 4)
	s.wake = make(chan struct{}, 1)
	s.gport, s.ln, s.lanLn, s.lan = port, ln, lanLn, lan
	s.srv = s.newGuestServer("local")
	if lanLn != nil {
		s.lanSrv = s.newGuestServer("lan")
	}
	s.running, s.lastFinished, s.lastLANCheck = nil, time.Time{}, now
	ctx, srv, lanSrv, done := s.ctx, s.srv, s.lanSrv, s.periodDone
	stopsAt := s.stopsAt
	if mode == "internet" {
		s.tun = s.tunnelFactory(s, port)
	} else {
		s.tun = nil
		s.state = "on"
	}
	tun := s.tun
	s.mu.Unlock()

	goSafe("guest server", func() { srv.Serve(ln) })
	if lanSrv != nil {
		goSafe("guest server (wifi)", func() { lanSrv.Serve(lanLn) })
		s.logf("sharing on (Same Wi-Fi only, %s:%d) until %s", lan.IP, port, stopsAt.Local().Format("15:04"))
	} else {
		s.logf("sharing on (internet) until %s; friends' page on 127.0.0.1:%d", stopsAt.Local().Format("15:04"), port)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	goSafe("share runner", func() { defer wg.Done(); s.runLoop(ctx) })
	goSafe("share ticker", func() { defer wg.Done(); s.tickLoop(ctx) })
	if tun != nil {
		wg.Add(1)
		goSafe("tunnel", func() { defer wg.Done(); tun.run(ctx) })
	}
	go func() { wg.Wait(); close(done) }()
	return nil
}

// tunnelReady is called by the tunnel when it has a (new) public hostname.
func (s *Share) tunnelChanged(t tunnelRunner) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tun != t {
		return
	}
	if s.state == "starting" && t.Host() != "" {
		s.state = "on"
	}
	if t.Host() != "" {
		s.linkChangedAt = time.Now()
	}
}

// tunnelFailed: the tunnel could not start (download, safety check) or gave up.
func (s *Share) tunnelFailed(t tunnelRunner, msg string) {
	s.mu.Lock()
	starting := s.tun == t && s.state == "starting"
	if starting {
		s.lastErr = msg
	}
	s.mu.Unlock()
	if starting { // (not from the tunnel's goroutine: stopNow waits for it)
		goSafe("stop sharing", func() { s.stopNow("the internet link could not start") })
	}
}

// Stop: closing (running jobs finish, the link stays until their owners have
// them) or, with now, off at once.
func (s *Share) Stop(now bool, reason string) {
	if now {
		s.stopNow(reason)
		return
	}
	s.beginClosing(reason)
}

func (s *Share) beginClosing(reason string) {
	s.mu.Lock()
	if s.state != "on" && s.state != "starting" {
		s.mu.Unlock()
		return
	}
	if s.state == "starting" {
		s.mu.Unlock()
		s.stopNow(reason)
		return
	}
	s.state, s.closingSince, s.stopReason = "closing", time.Now(), reason
	n := 0
	for _, j := range s.order {
		switch j.state {
		case "waiting-approval", "queued":
			s.finishJobLocked(j, "cancelled", "sharing-stopped", "Sharing has stopped, so this video wasn't made. It didn't count toward your limit.")
		case "running":
			n++
		}
	}
	s.mu.Unlock()
	s.logf("closing (%s): %d video(s) finishing", reason, n)
	s.kick()
}

// stopNow ends sharing at once: the running job is interrupted, the tunnel
// and the friends' page close, sessions end and every friend's file is deleted.
func (s *Share) stopNow(reason string) {
	s.mu.Lock()
	if s.state == "off" {
		s.mu.Unlock()
		return
	}
	s.state, s.stopReason = "off", reason
	cancel, done := s.cancel, s.periodDone
	srv, lanSrv := s.srv, s.lanSrv
	var ids []string
	var prompts []string
	for _, j := range s.order {
		switch j.state {
		case "waiting-approval", "queued", "running":
			s.finishJobLocked(j, "cancelled", "sharing-stopped", "Sharing has stopped, so this video wasn't finished.")
		}
		if !j.cleaned {
			ids = append(ids, j.id)
			prompts = append(prompts, j.prompts...)
			j.cleaned = true
		}
	}
	curPrompt := ""
	if s.running != nil {
		curPrompt = s.running.curPrompt
	}
	s.sessions, s.guests = map[string]*guestSession{}, map[string]*guestRec{}
	s.srv, s.lanSrv, s.ln, s.lanLn, s.tun = nil, nil, nil, nil, nil
	s.mu.Unlock()

	port, state := s.eng.shareComfy()
	if curPrompt != "" && state == "ready" {
		interruptPrompt(port, curPrompt)
	}
	if cancel != nil {
		cancel()
	}
	for _, sv := range []*http.Server{srv, lanSrv} {
		if sv != nil {
			ctx, c := context.WithTimeout(context.Background(), 5*time.Second)
			sv.Shutdown(ctx)
			c()
			sv.Close()
		}
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
		}
	}
	dir := s.eng.shareInstallDir()
	removed := 0
	for _, id := range ids {
		removed += removeJobFiles(dir, id)
	}
	if state == "ready" {
		deleteComfyHistory(port, prompts)
	}
	s.mu.Lock()
	for _, j := range s.order {
		j.selfie, j.wav, j.thumb = nil, nil, nil
	}
	s.mu.Unlock()
	s.logf("sharing off (%s); %d friends' file(s) removed", reason, removed)
}

// Shutdown is called when the launcher exits.
func (s *Share) Shutdown() { s.stopNow("Glow Studio is closing") }

// kick wakes the runner.
func (s *Share) kick() {
	s.mu.Lock()
	w := s.wake
	s.mu.Unlock()
	if w != nil {
		select {
		case w <- struct{}{}:
		default:
		}
	}
}

// tickLoop: auto-stop, closing, expiry of jobs and sessions, LAN address changes.
func (s *Share) tickLoop(ctx context.Context) {
	every := time.Second
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s.tick()
	}
}

func (s *Share) tick() {
	now := time.Now()
	var cleanup []*guestJob
	s.mu.Lock()
	if s.state == "off" {
		s.mu.Unlock()
		return
	}
	autoStop := s.state == "on" && !now.Before(s.stopsAt)
	for _, j := range s.order {
		switch j.state {
		case "done":
			if now.After(j.expiresAt) {
				s.finishJobLocked(j, "expired", "", "")
				cleanup = append(cleanup, j)
			}
		case "waiting-approval", "queued":
			if now.Sub(j.createdAt) > jobKeep {
				s.finishJobLocked(j, "expired", "expired", "This video waited too long and wasn't made. It didn't count toward your limit.")
			}
		}
	}
	// forget finished jobs after a day
	keep := s.order[:0]
	for _, j := range s.order {
		if terminalJob(j.state) && j.cleaned && now.Sub(j.finishedAt) > jobKeep {
			delete(s.jobs, j.id)
			continue
		}
		keep = append(keep, j)
	}
	s.order = keep
	for sid, ss := range s.sessions {
		g := s.guests[ss.guestID]
		if now.Sub(ss.created) > sessionTTL || (g != nil && g.name == "" && now.Sub(ss.lastSeen) > unnamedTTL) {
			delete(s.sessions, sid)
		}
	}
	finishClosing := false
	if s.state == "closing" {
		running, waiting := false, false
		for _, j := range s.order {
			running = running || j.state == "running"
			waiting = waiting || j.state == "done"
		}
		since := s.lastFinished
		if since.Before(s.closingSince) {
			since = s.closingSince
		}
		finishClosing = !running && (!waiting || now.Sub(since) >= s.closeGrace)
	}
	checkLAN := s.state == "on" && s.lan != nil && now.Sub(s.lastLANCheck) >= 10*time.Second
	if checkLAN {
		s.lastLANCheck = now
	}
	s.mu.Unlock()
	for _, j := range cleanup {
		s.cleanupJob(j, "expired")
	}
	if autoStop {
		s.beginClosing("auto-stop")
	}
	if finishClosing {
		s.stopNow("stopped; every friend has their video")
	}
	if checkLAN {
		s.recheckLAN()
	}
}

// ---- host API ----

func (s *Share) hostAPI(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/__glow/share/")
	if path == "status" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			errJSON(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		writeJSON(w, http.StatusOK, s.Status())
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) == 3 && parts[0] == "jobs" && parts[2] == "thumb" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			errJSON(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		s.mu.Lock()
		j := s.jobs[parts[1]]
		var thumb []byte
		if j != nil && j.state == "waiting-approval" {
			thumb = j.thumb
		}
		s.mu.Unlock()
		if thumb == nil {
			errJSON(w, http.StatusNotFound, "not found")
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", strconv.Itoa(len(thumb)))
		w.Write(thumb)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		errJSON(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<10))
	if err != nil {
		writeAPIError(w, &apiError{Status: 413, Code: "too-large", Message: "The request is too large."})
		return
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		body = []byte("{}")
	}
	reply := func(e *apiError, code int) {
		if e != nil {
			writeAPIError(w, e)
			return
		}
		writeJSON(w, code, s.Status())
	}
	switch {
	case path == "start":
		var req startRequest
		if e := decodeStrict(body, &req); e != nil {
			reply(e, 0)
			return
		}
		reply(s.Start(req), http.StatusAccepted)
	case path == "stop":
		var req struct {
			Now bool `json:"now"`
		}
		if e := decodeStrict(body, &req); e != nil {
			reply(e, 0)
			return
		}
		why := "stopped by the host"
		if req.Now {
			why = "stopped at once by the host"
		}
		s.Stop(req.Now, why)
		reply(nil, http.StatusOK)
	case path == "settings":
		var req startRequest
		if e := decodeStrict(body, &req); e != nil {
			reply(e, 0)
			return
		}
		reply(s.UpdateSettings(req), http.StatusOK)
	case path == "new-link":
		reply(s.NewLink(), http.StatusOK)
	case len(parts) == 3 && parts[0] == "guests" && parts[2] == "block":
		var req struct {
			Blocked *bool `json:"blocked"`
		}
		if e := decodeStrict(body, &req); e != nil {
			reply(e, 0)
			return
		}
		blocked := req.Blocked == nil || *req.Blocked
		reply(s.Block(parts[1], blocked), http.StatusOK)
	case len(parts) == 3 && parts[0] == "jobs" && (parts[2] == "approve" || parts[2] == "decline" || parts[2] == "cancel"):
		reply(s.HostJobAction(parts[1], parts[2]), http.StatusOK)
	default:
		errJSON(w, http.StatusNotFound, "not found")
	}
}

func writeAPIError(w http.ResponseWriter, e *apiError) {
	out := map[string]any{"error": e.Code, "message": e.Message}
	if e.Field != "" {
		out["field"] = e.Field
	}
	for k, v := range e.Extra {
		out[k] = v
	}
	writeJSON(w, e.Status, out)
}

// UpdateSettings changes settings, also while sharing is on.
func (s *Share) UpdateSettings(r startRequest) *apiError {
	s.mu.Lock()
	modeChanged, e := s.applySettingsLocked(r)
	if e != nil {
		s.mu.Unlock()
		return e
	}
	s.saveSettingsLocked()
	on := s.state == "on" || s.state == "starting"
	if r.AutoStopHours != nil && s.state == "on" {
		s.stopsAt = time.Now().Add(s.autoStopAfter())
	}
	mode := s.settings.Mode
	s.mu.Unlock()
	if modeChanged && on {
		return s.switchMode(mode)
	}
	return nil
}

// NewLink replaces the join token: the old link stops admitting new people.
func (s *Share) NewLink() *apiError {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "on" && s.state != "starting" {
		return &apiError{Status: 409, Code: "not-on", Message: "Sharing is off."}
	}
	s.token, s.linkChangedAt = randToken(16), time.Now()
	s.logf("new link made; the old link no longer lets people in")
	return nil
}

// Block ends a guest's session, cancels their videos and deletes their files.
func (s *Share) Block(id string, blocked bool) *apiError {
	var cancelled []*guestJob
	s.mu.Lock()
	g := s.guests[id]
	if g == nil {
		s.mu.Unlock()
		return &apiError{Status: 404, Code: "not-found", Message: "That friend isn't connected any more."}
	}
	g.blocked = blocked
	if blocked {
		for _, ss := range s.sessions {
			if ss.guestID == id {
				ss.blocked = true
			}
		}
		for _, j := range s.order {
			if j.guestID != id {
				continue
			}
			switch j.state {
			case "waiting-approval", "queued", "running":
				s.finishJobLocked(j, "cancelled", "blocked", "This video was cancelled.")
				cancelled = append(cancelled, j)
			case "done":
				s.finishJobLocked(j, "expired", "", "")
				cancelled = append(cancelled, j)
			}
		}
	}
	name := g.name
	s.mu.Unlock()
	if blocked {
		s.logf("guest %s %q blocked by the host", id, name)
	} else {
		s.logf("guest %s %q unblocked by the host", id, name)
	}
	for _, j := range cancelled {
		j := j
		goSafe("cleanup", func() { s.cleanupJob(j, "blocked") })
	}
	s.kick()
	return nil
}

// HostJobAction: approve, decline or cancel a friend's video.
func (s *Share) HostJobAction(id, action string) *apiError {
	var cleanup *guestJob
	s.mu.Lock()
	j := s.jobs[id]
	if j == nil {
		s.mu.Unlock()
		return &apiError{Status: 404, Code: "not-found", Message: "That video isn't in the list any more."}
	}
	switch action {
	case "approve":
		if j.state != "waiting-approval" {
			s.mu.Unlock()
			return &apiError{Status: 409, Code: "not-waiting", Message: "That video isn't waiting for approval."}
		}
		if s.state != "on" {
			s.mu.Unlock()
			return &apiError{Status: 409, Code: "not-on", Message: "Sharing is stopping."}
		}
		j.state, j.thumb = "queued", nil
		s.logf("job %s approved by the host", j.id)
	case "decline":
		if j.state != "waiting-approval" {
			s.mu.Unlock()
			return &apiError{Status: 409, Code: "not-waiting", Message: "That video isn't waiting for approval."}
		}
		s.finishJobLocked(j, "declined", "declined", "Your friend didn't approve this video. It didn't count toward your limit.")
		s.logf("job %s declined by the host", j.id)
	case "cancel":
		switch j.state {
		case "waiting-approval", "queued", "running":
			s.finishJobLocked(j, "cancelled", "host-cancelled", "Your friend cancelled this video. It didn't count toward your limit.")
			cleanup = j
			s.logf("job %s cancelled by the host", j.id)
		default:
			s.mu.Unlock()
			return &apiError{Status: 409, Code: "finished", Message: "That video is already finished."}
		}
	}
	s.mu.Unlock()
	if cleanup != nil {
		goSafe("cleanup", func() { s.cleanupJob(cleanup, "cancelled") })
	}
	s.kick()
	return nil
}

// ---- status ----

type shareStatusJSON struct {
	State         string            `json:"state"`
	LastError     *string           `json:"lastError"`
	Mode          string            `json:"mode"`
	HostName      string            `json:"hostName"`
	Settings      map[string]any    `json:"settings"`
	StartedAt     *string           `json:"startedAt"`
	StopsAt       *string           `json:"stopsAt"`
	Closing       map[string]any    `json:"closing"`
	Link          *string           `json:"link"`
	LinkReady     bool              `json:"linkReady"`
	LinkChangedAt *string           `json:"linkChangedAt"`
	Tunnel        *tunnelStatusJSON `json:"tunnel"`
	LAN           map[string]any    `json:"lan"`
	Engine        map[string]any    `json:"engine"`
	Guests        []map[string]any  `json:"guests"`
	Unnamed       int               `json:"unnamed"`
	Jobs          []map[string]any  `json:"jobs"`
	HostNote      *string           `json:"hostPriorityNote"`
}

func ts(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	v := t.UTC().Format(time.RFC3339)
	return &v
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Status is the host's view (ShareStatus).
func (s *Share) Status() shareStatusJSON {
	port, estate := s.eng.shareComfy()
	_ = port
	_, singing, fast := s.eng.sharePacks()
	hostEta, hostNoEta := s.eng.hostEta()
	hostBusy, _ := s.eng.hostBusy()
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := shareStatusJSON{State: s.state, LastError: strp(s.lastErr), Mode: s.settings.Mode, HostName: s.settings.HostName,
		Settings: map[string]any{"dailyLimit": s.settings.DailyLimit, "approve": s.settings.Approve, "autoStopHours": s.settings.AutoStopHours},
		Engine:   map[string]any{"state": estate, "singing": singing, "fast": fast},
		Guests:   []map[string]any{}, Jobs: []map[string]any{}}
	if s.state == "off" {
		return st
	}
	st.StartedAt, st.StopsAt, st.LinkChangedAt = ts(s.startedAt), ts(s.stopsAt), ts(s.linkChangedAt)
	if s.state == "closing" {
		waiting := 0
		for _, j := range s.order {
			if j.state == "running" || j.state == "done" {
				waiting++
			}
		}
		st.Closing = map[string]any{"since": ts(s.closingSince), "waitingFor": waiting}
	}
	if link := s.linkLocked(); link != "" {
		st.Link = &link
	}
	if s.tun != nil {
		tst := s.tun.Status()
		st.Tunnel = &tst
		st.LinkReady = tst.State == "ready"
	} else if s.lan != nil {
		st.LinkReady = true
	}
	if s.lan != nil {
		st.LAN = map[string]any{"ip": s.lan.IP.String(), "port": s.gport, "subnet": s.lan.Net.String()}
	}
	today := s.dayKey(now)
	ids := make([]string, 0, len(s.guests))
	for id := range s.guests {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return s.guests[ids[a]].joinedAt.Before(s.guests[ids[b]].joinedAt) })
	for _, id := range ids {
		g := s.guests[id]
		if g.name == "" {
			if !g.blocked {
				st.Unnamed++
			}
			continue
		}
		st.Guests = append(st.Guests, map[string]any{"id": g.id, "name": g.name, "online": now.Sub(g.lastSeen) < onlineWithin,
			"lastSeenAt": ts(g.lastSeen), "joinedAt": ts(g.joinedAt), "usedToday": g.used[today], "blocked": g.blocked})
	}
	q := s.queueViewLocked(hostEta, hostNoEta, hostBusy)
	for _, j := range s.order {
		g := s.guests[j.guestID]
		name := ""
		if g != nil {
			name = g.name
		}
		lips := 0
		for _, sh := range j.plan.Shots {
			if sh.Lip {
				lips++
			}
		}
		m := map[string]any{"id": j.id, "guestId": j.guestID, "guestName": name, "state": j.state, "sceneId": j.plan.SceneID,
			"sceneName": j.plan.SceneName, "duration": j.plan.Duration, "sound": j.plan.Sound, "lipShots": lips,
			"createdAt": ts(j.createdAt), "position": nil, "progress": nil, "startMin": nil, "doneMin": nil,
			"thumb": j.state == "waiting-approval" && j.thumb != nil, "error": nil}
		if v, ok := q[j.id]; ok {
			m["position"], m["startMin"], m["doneMin"] = v.ahead+1, v.startJSON(), v.doneMin
		}
		if j.progress != nil && j.state == "running" {
			m["progress"] = j.progress
		}
		if j.err != nil {
			m["error"] = j.err
		}
		st.Jobs = append(st.Jobs, m)
	}
	if r := s.running; r != nil && r.state == "running" {
		note := fmt.Sprintf("A friend's video is on step %d of %d — yours starts after this step", max(1, r.stepIdx), max(1, r.stepTotal))
		st.HostNote = &note
	}
	return st
}

// linkLocked is the link friends open.
func (s *Share) linkLocked() string {
	switch {
	case s.lan != nil:
		return fmt.Sprintf("http://%s/?join=%s", net.JoinHostPort(s.lan.IP.String(), strconv.Itoa(s.gport)), s.token)
	case s.tun != nil && s.tun.Host() != "":
		return "https://" + s.tun.Host() + "/?join=" + s.token
	}
	return ""
}

// ---- mode switch, LAN address changes ----

func (s *Share) switchMode(mode string) *apiError {
	var lan *lanAddr
	var err error
	if mode == "wifi" {
		if lan, err = detectLAN(); err != nil {
			return &apiError{Status: 409, Code: "no-lan", Message: "This PC doesn't seem to be on a home network. Use Anywhere instead."}
		}
	}
	s.mu.Lock()
	if s.state != "on" && s.state != "starting" {
		s.mu.Unlock()
		return nil
	}
	oldTun, oldLanSrv := s.tun, s.lanSrv
	s.tun, s.lanSrv, s.lanLn, s.lan = nil, nil, nil, nil
	port, ctx := s.gport, s.ctx
	s.mu.Unlock()
	if oldTun != nil {
		oldTun.stop()
	}
	if oldLanSrv != nil {
		oldLanSrv.Close()
	}
	if mode == "wifi" {
		ln, err := net.Listen("tcp4", net.JoinHostPort(lan.IP.String(), strconv.Itoa(port)))
		if err != nil {
			s.logf("could not open the friends' page on %s: %v", lan.IP, err)
			return &apiError{Status: 409, Code: "listen", Message: "Glow Studio could not open the friends' page on this network. Stop sharing and start again."}
		}
		s.mu.Lock()
		s.lan, s.lanLn = lan, ln
		s.lanSrv = s.newGuestServer("lan")
		srv := s.lanSrv
		s.state, s.linkChangedAt = "on", time.Now()
		s.mu.Unlock()
		goSafe("guest server (wifi)", func() { srv.Serve(ln) })
		s.logf("now Same Wi-Fi only (%s:%d)", lan.IP, port)
		return nil
	}
	s.mu.Lock()
	t := s.tunnelFactory(s, port)
	s.tun, s.linkChangedAt = t, time.Now()
	s.mu.Unlock()
	goSafe("tunnel", func() { t.run(ctx) })
	s.logf("now Anywhere (internet link)")
	return nil
}

func (s *Share) recheckLAN() {
	lan, err := detectLAN()
	s.mu.Lock()
	cur := s.lan
	port := s.gport
	s.mu.Unlock()
	if cur == nil || (err == nil && lan.IP.Equal(cur.IP)) {
		return
	}
	if err != nil {
		return // keep the old address until a new one shows up
	}
	ln, lerr := net.Listen("tcp4", net.JoinHostPort(lan.IP.String(), strconv.Itoa(port)))
	if lerr != nil {
		s.logf("the PC's network address changed to %s but the friends' page could not move there: %v", lan.IP, lerr)
		return
	}
	s.mu.Lock()
	if s.lan == nil || s.state == "off" {
		s.mu.Unlock()
		ln.Close()
		return
	}
	old := s.lanSrv
	s.lan, s.lanLn = lan, ln
	s.lanSrv = s.newGuestServer("lan")
	srv := s.lanSrv
	s.linkChangedAt = time.Now()
	s.mu.Unlock()
	if old != nil {
		old.Close()
	}
	goSafe("guest server (wifi)", func() { srv.Serve(ln) })
	s.logf("the PC's network address changed: the friends' link is now on %s", lan.IP)
}

// ---- Engine side of sharing ----

func (e *Engine) shareComfy() (int, string) {
	e.mu.Lock()
	state, port, proc := e.state, e.comfyPort, e.proc
	dir, man := e.installDir, e.man.clone()
	e.mu.Unlock()
	if state == "ready" && proc != nil {
		return port, "ready"
	}
	if state == "starting" || state == "error" {
		return 0, state
	}
	if !packInstalledIn(e.cat, dir, man, "core") {
		return 0, "not-installed"
	}
	return 0, "stopped"
}

// sharePacks: which packs are installed (the disk is checked outside e.mu).
func (e *Engine) sharePacks() (core, singing, fast bool) {
	e.mu.Lock()
	dir, man := e.installDir, e.man.clone()
	e.mu.Unlock()
	return packInstalledIn(e.cat, dir, man, "core"), packInstalledIn(e.cat, dir, man, "singing"), packInstalledIn(e.cat, dir, man, "fast")
}

func (e *Engine) shareInstallDir() string { return e.currentDir() }

// hostRecent: a host hold renewed this recently keeps friends' steps waiting.
var hostRecent = 5 * time.Minute

func (e *Engine) hostBusy() (bool, string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.job != nil && e.job.state() == "running" {
		return true, "installing"
	}
	now := time.Now()
	for _, h := range e.holds {
		if now.Before(h.until) && now.Sub(h.renewedAt) < hostRecent {
			return true, "making a video"
		}
	}
	return false, ""
}

func (e *Engine) hostEta() (sum [2]float64, noEta int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	for _, h := range e.holds {
		if !now.Before(h.until) || now.Sub(h.renewedAt) >= hostRecent {
			continue
		}
		if h.eta != nil {
			sum[0] += h.eta[0]
			sum[1] += h.eta[1]
		} else {
			noEta++
		}
	}
	return sum, noEta
}

func (e *Engine) shareGPUName() string {
	g, _ := e.gpuInfo(false, 0)
	if g == nil {
		return ""
	}
	return g.Name
}
