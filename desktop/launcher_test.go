package main

// Tests for the launcher fixes: the idle exit (30 minutes, never while work is
// in flight), the launcher and crash logs, a status that never waits for a
// slow manifest write, the 7-Zip log, "Open log folder", video holds, and the
// choice of port when an older copy is gone.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// runTestProcess is what the test binary does when started with
// GLOW_TEST_PROCESS (see TestMain).
func runTestProcess(mode string) {
	switch mode {
	case "main":
		main()
	case "crash":
		// as main() does at start-up, then an unrecovered panic in a goroutine
		if _, err := setupCrashLog(os.Getenv("GLOW_TEST_LOGDIR")); err != nil {
			fmt.Println("setup:", err)
			os.Exit(3)
		}
		go func() { panic("test crash in a goroutine") }()
		time.Sleep(5 * time.Second)
		os.Exit(0)
	case "recovered":
		launcherLog.open(filepath.Join(os.Getenv("GLOW_TEST_LOGDIR"), "launcher.log"), logRotateBytes)
		done := make(chan struct{})
		goSafe("test worker", func() { defer close(done); var m map[string]int; m["x"] = 1 })
		<-done
		launcherLog.printf("[launcher] still running after the panic")
		launcherLog.close()
		os.Exit(0)
	}
	os.Exit(2)
}

// childEnv is the environment without the test harness's GLOW_ settings.
func childEnv(extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GLOW_") {
			env = append(env, kv)
		}
	}
	return append(env, extra...)
}

func freeTCPPort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// ---------------------------------------------------------------- idle exit

func TestIdleDecision(t *testing.T) {
	now := time.Now()
	idle := 30 * time.Minute
	cases := []struct {
		name           string
		ping, lastBusy time.Duration // ago
		busy           bool
		exit           bool
	}{
		{"window open (pinged a minute ago)", time.Minute, 2 * time.Hour, false, false},
		{"no ping for 29 min", 29 * time.Minute, 2 * time.Hour, false, false},
		{"no ping for 31 min, nothing running", 31 * time.Minute, 2 * time.Hour, false, true},
		{"window asleep for hours, install still running", 5 * time.Hour, 0, true, false},
		{"window asleep for hours, install finished 1 min ago", 5 * time.Hour, time.Minute, false, false},
		{"window asleep for hours, install finished 29 min ago", 5 * time.Hour, 29 * time.Minute, false, false},
		{"window asleep for hours, install finished 31 min ago", 5 * time.Hour, 31 * time.Minute, false, true},
		{"render or story in flight, no pings for a day", 24 * time.Hour, 24 * time.Hour, true, false},
	}
	for _, c := range cases {
		exit, reason := idleDecision(now, now.Add(-c.ping), now.Add(-c.lastBusy), idle, c.busy)
		if exit != c.exit {
			t.Errorf("%s: exit %v, want %v", c.name, exit, c.exit)
		}
		if exit && (!strings.Contains(reason, "30m0s") || !strings.Contains(reason, "nothing is running")) {
			t.Errorf("%s: reason %q", c.name, reason)
		}
	}
	if idleExit != 30*time.Minute {
		t.Fatalf("idle exit is %s", idleExit)
	}
}

func TestHoldKeepsLauncherBusy(t *testing.T) {
	h := newHarness(t)
	if b, _ := h.e.BusyReason(); b {
		t.Fatal("busy at start")
	}
	if code, _ := h.do("POST", "/__glow/engine/hold", map[string]any{"job": "../x"}); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	if code, _ := h.do("GET", "/__glow/engine/hold", nil); code != 405 {
		t.Fatalf("GET: %d", code)
	}
	if code, _ := h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gstory1"}, "Origin", "https://evil.example"); code != 403 {
		t.Fatalf("cross-origin: %d", code)
	}
	if code, out := h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gstory1"}, "Origin", h.origin); code != 200 || out["ok"] != true {
		t.Fatalf("hold: %d %v", code, out)
	}
	busy, why := h.e.BusyReason()
	if !busy || !strings.Contains(why, "gstory1") || !h.e.Busy() {
		t.Fatalf("held: %v %q", busy, why)
	}
	h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gstory1", "release": true})
	if h.e.Busy() {
		t.Fatal("released hold still busy")
	}
	// cleanup of the job ends its hold too
	h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gstory2"})
	h.do("POST", "/__glow/engine/cleanup", map[string]any{"job": "gstory2"})
	if h.e.Busy() {
		t.Fatal("cleanup must release the hold")
	}
	// (a cancelled story's cleanup can arrive before its own release: the log still says it ended)
	if !strings.Contains(strings.Join(h.status().Engine.Log, "\n"), "video gstory2 is no longer in progress") {
		t.Fatal("a hold released by cleanup should be logged")
	}
	// a page that never comes back: the hold lapses
	h.e.mu.Lock() // holdTTL is read under e.mu
	old := holdTTL
	holdTTL = 150 * time.Millisecond
	h.e.mu.Unlock()
	defer func() { h.e.mu.Lock(); holdTTL = old; h.e.mu.Unlock() }()
	h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gstory3"})
	if !h.e.Busy() {
		t.Fatal("hold not taken")
	}
	waitFor(t, 3*time.Second, func() bool { return !h.e.Busy() })
	// at most 16 jobs at a time
	for i := 0; i < 20; i++ {
		h.do("POST", "/__glow/engine/hold", map[string]any{"job": fmt.Sprintf("gmany%d", i)})
	}
	h.e.mu.Lock()
	n := len(h.e.holds)
	h.e.mu.Unlock()
	if n != 16 {
		t.Fatalf("%d holds", n)
	}
	if !strings.Contains(strings.Join(h.status().Engine.Log, "\n"), "video gstory1 is being made") {
		t.Fatal("hold should be logged")
	}
}

// The real main(): it quits after the idle time with the reason in
// launcher.log, but never while a story is in flight (a hold).
func TestLauncherIdleExitProcess(t *testing.T) {
	dir := t.TempDir()
	port := freeTCPPort(t)
	exe, _ := os.Executable()
	start := func() (*exec.Cmd, chan error) {
		cmd := exec.Command(exe)
		cmd.Env = childEnv("GLOW_TEST_PROCESS=main", fmt.Sprintf("GLOW_PORT=%d", port), "GLOW_IDLE_EXIT=2s", "GLOW_NO_BROWSER=1",
			"GLOW_ENGINE_DIR="+filepath.Join(dir, "GlowStudio", "engine"), "GLOW_NVIDIA_SMI=/nonexistent", "GLOW_FAKE_DISK_FREE_GB=500")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		waitFor(t, 10*time.Second, func() bool { return alreadyRunning(port) })
		return cmd, done
	}
	logPath := filepath.Join(dir, "GlowStudio", "logs", "launcher.log")

	// 1. nobody uses it: it quits about 2 s later and says why
	_, done := start()
	t0 := time.Now()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("exit: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("did not quit when idle")
	}
	if d := time.Since(t0); d < time.Second {
		t.Fatalf("quit too early (%s)", d)
	}
	logText, _ := os.ReadFile(logPath)
	for _, want := range []string{"Glow Studio " + launcherVersion + " starting", fmt.Sprintf("listening on http://127.0.0.1:%d/", port), "exiting: idle exit: no Glow Studio window has been open for 2s and nothing is running", "stopped (exit code 0)"} {
		if !strings.Contains(string(logText), want) {
			t.Fatalf("launcher.log lacks %q:\n%s", want, logText)
		}
	}

	// 2. a story in flight keeps it running without any pings
	cmd, done := start()
	defer cmd.Process.Kill()
	post := func(path, body string) int {
		req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d%s", port, path), strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if c := post("/__glow/engine/hold", `{"job":"gstoryA"}`); c != 200 {
		t.Fatalf("hold %d", c)
	}
	select {
	case <-done:
		t.Fatal("quit while a story was in flight")
	case <-time.After(5 * time.Second):
	}
	post("/__glow/engine/hold", `{"job":"gstoryA","release":true}`)
	t1 := time.Now()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("did not quit after the story")
	}
	if d := time.Since(t1); d < 1500*time.Millisecond {
		t.Fatalf("quit %s after the story ended: the idle time must count from then", d)
	}
	logText, _ = os.ReadFile(logPath)
	for _, want := range []string{"busy: a video is being made (gstoryA)", "nothing running any more", "[http] POST /__glow/engine/hold -> 200"} {
		if !strings.Contains(string(logText), want) {
			t.Fatalf("launcher.log lacks %q:\n%s", want, logText)
		}
	}
	if n := strings.Count(string(logText), "exiting: idle exit"); n != 2 {
		t.Fatalf("%d idle exits logged", n)
	}

	// 3. Ctrl+C / taskkill: logged too
	cmd, done = start()
	cmd.Process.Signal(os.Interrupt)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("did not stop on interrupt")
	}
	logText, _ = os.ReadFile(logPath)
	if !strings.Contains(string(logText), "exiting: asked to stop (interrupt)") {
		t.Fatalf("interrupt not logged:\n%s", logText)
	}
}

// ---------------------------------------------------------------- logs

func TestCrashLogGetsTheTrace(t *testing.T) {
	dir := t.TempDir()
	exe, _ := os.Executable()
	cmd := exec.Command(exe)
	cmd.Env = childEnv("GLOW_TEST_PROCESS=crash", "GLOW_TEST_LOGDIR="+dir)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("the crash test process should have crashed: %s", out)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "crash.log"))
	if !strings.Contains(string(data), "panic: test crash in a goroutine") || !strings.Contains(string(data), "goroutine ") {
		t.Fatalf("crash.log:\n%s", data)
	}
}

func TestRecoveredPanicIsLogged(t *testing.T) {
	dir := t.TempDir()
	exe, _ := os.Executable()
	cmd := exec.Command(exe)
	cmd.Env = childEnv("GLOW_TEST_PROCESS=recovered", "GLOW_TEST_LOGDIR="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "launcher.log"))
	s := string(data)
	if !strings.Contains(s, "PANIC in test worker (recovered") || !strings.Contains(s, "assignment to entry in nil map") || !strings.Contains(s, "still running after the panic") {
		t.Fatalf("launcher.log:\n%s", s)
	}
}

func TestLauncherLogRotates(t *testing.T) {
	dir := t.TempDir()
	l := &fileLog{}
	p := filepath.Join(dir, "launcher.log")
	if err := l.open(p, 2000); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		l.printf("[launcher] line %d %s", i, strings.Repeat("x", 40))
	}
	l.close()
	cur, _ := os.ReadFile(p)
	old, err := os.ReadFile(filepath.Join(dir, "launcher.1.log"))
	if err != nil || len(cur) > 2200 || len(old) < 1500 || !strings.Contains(string(cur), "line 99") {
		t.Fatalf("rotation: cur %d old %d %v", len(cur), len(old), err)
	}
	// a big old file is rotated when the launcher starts
	os.WriteFile(p, []byte(strings.Repeat("y", 5000)), 0o644)
	l.open(p, 2000)
	l.printf("fresh")
	l.close()
	if cur, _ := os.ReadFile(p); !strings.HasSuffix(strings.TrimSpace(string(cur)), "fresh") || len(cur) > 100 {
		t.Fatalf("start rotation: %q", cur)
	}
}

func TestRequestSummary(t *testing.T) {
	dir := t.TempDir()
	launcherLog.open(filepath.Join(dir, "launcher.log"), logRotateBytes)
	defer launcherLog.close()
	requests.flush() // earlier tests' requests
	h := logRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "view") {
			w.WriteHeader(502)
			return
		}
		w.Write([]byte("ok"))
	}))
	srv := &http.Server{Handler: h}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(ln)
	defer srv.Close()
	base := "http://" + ln.Addr().String()
	for _, p := range []string{"/__glow/ping", "/__glow/ping", "/__glow/engine/status", "/__glow/comfy/view?filename=selfie_secret.jpg", "/index.html"} {
		resp, err := http.Get(base + p)
		if err == nil {
			resp.Body.Close()
		}
	}
	resp, _ := http.Post(base+"/__glow/engine/cleanup", "application/json", strings.NewReader(`{"job":"gx"}`))
	resp.Body.Close()
	line := requests.flush()
	for _, want := range []string{"ping 2", "engine/status 1", "comfy/view 1 (1 failed)", "page 1", "engine/cleanup 1"} {
		if !strings.Contains(line, want) {
			t.Fatalf("summary %q lacks %q", line, want)
		}
	}
	data, _ := os.ReadFile(filepath.Join(dir, "launcher.log"))
	if strings.Contains(string(data), "secret") || !strings.Contains(string(data), "POST /__glow/engine/cleanup -> 200") || !strings.Contains(string(data), "GET comfy/view -> 502") {
		t.Fatalf("log:\n%s", data)
	}
	if requests.flush() != "" {
		t.Fatal("flush must reset")
	}
}

func TestStatusAnswersWhileManifestWriteIsStuck(t *testing.T) {
	h := newHarness(t)
	h.status() // the first status may wait up to 1 s for nvidia-smi
	var stuck atomic.Int32
	release := make(chan struct{})
	hook := func() {
		if stuck.Add(1) == 1 { // the first write (the new install's record) hangs for 10 s
			select {
			case <-release:
			case <-time.After(10 * time.Second):
			}
		}
	}
	manifestWriteHook.Store(&hook)
	defer manifestWriteHook.Store(nil)
	t0 := time.Now()
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}}); code != 202 {
		t.Fatalf("install %d %v", code, out)
	}
	if d := time.Since(t0); d > time.Second {
		t.Fatalf("install answered after %s", d)
	}
	var worst time.Duration
	n := 0
	for time.Since(t0) < 9*time.Second {
		t1 := time.Now()
		s := h.status()
		d := time.Since(t1)
		if d > worst {
			worst = d
		}
		n++
		if s.Job == nil || s.Job.State != "running" {
			t.Fatalf("job %+v", s.Job)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if worst > 200*time.Millisecond || stuck.Load() != 1 {
		t.Fatalf("worst status %s over %d calls (writes %d)", worst, n, stuck.Load())
	}
	close(release)
	if s := h.waitJob("done", "error"); s.Job.State != "done" || !s.Packs["core"].Installed {
		t.Fatalf("after the slow write: %+v", s.Job)
	}
	man := loadManifest(h.status().InstallDir)
	if !man.Packs["core"].Installed || len(man.Pending) != 0 {
		t.Fatalf("an older snapshot overwrote a newer one: %+v", man)
	}
}

func TestManifestSnapshotsKeepOrder(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{man: loadManifest(dir)}
	e.man.Pending = []string{"first"}
	w1 := e.manifestWriterLocked(dir)
	e.man.Pending = []string{"second"}
	w2 := e.manifestWriterLocked(dir)
	if err := w2(); err != nil {
		t.Fatal(err)
	}
	if err := w1(); err != nil { // late, older: must not win
		t.Fatal(err)
	}
	if got := loadManifest(dir).Pending; len(got) != 1 || got[0] != "second" {
		t.Fatalf("%v", got)
	}
}

func TestRingLogLastNeverWaitsForTheFile(t *testing.T) {
	r := &ringLog{max: 10}
	r.add("[launcher] one")
	r.fileMu.Lock() // the disk is busy
	done := make(chan []string, 1)
	go func() { done <- r.last(5) }()
	select {
	case l := <-done:
		if len(l) != 1 {
			t.Fatal(l)
		}
	case <-time.After(time.Second):
		t.Fatal("last() waited for the file")
	}
	r.fileMu.Unlock()
}

// ---------------------------------------------------------------- 7-Zip

func TestSevenZipLines(t *testing.T) {
	cases := map[string]struct {
		msg string
		pct int
	}{
		"    ": {"", -1},
		"":     {"", -1},
		"  0%": {"", 0},
		" 45% 10 - ComfyUI_windows_portable\\python_embeded\\python.exe": {"", 45},
		"100%":     {"", 100},
		" 12% 345": {"", 12},
		"ERROR: Data Error : ComfyUI_windows_portable\\x": {"ERROR: Data Error : ComfyUI_windows_portable\\x", -1},
		"Everything is Ok":                 {"Everything is Ok", -1},
		"Can not open the file as archive": {"Can not open the file as archive", -1},
	}
	for in, want := range cases {
		if msg, pct := sevenZipLine(in); msg != want.msg || pct != want.pct {
			t.Errorf("%q -> %q %d, want %q %d", in, msg, pct, want.msg, want.pct)
		}
	}
}

func TestSevenZipLogHasNoBlankLines(t *testing.T) {
	h := newHarness(t)
	t.Setenv("GLOW_SKIP_7Z", "")
	// 7zr.exe -bsp1 redraws its progress with backspaces and spaces
	var b strings.Builder
	b.WriteString(`[ "$1" = x ] || exit 7
out=""; for a in "$@"; do case "$a" in -o*) out="${a#-o}";; esac; done
printf '  0%%'
`)
	for p := 1; p <= 100; p += 3 {
		fmt.Fprintf(&b, "printf '\\b\\b\\b\\b    \\b\\b\\b\\b%3d%%%% %d - ComfyUI_windows_portable\\\\file%d.py'\n", p, p*10, p)
	}
	b.WriteString(`printf '\b\b\b\b    \b\b\b\b100%%\n'
echo "WARNING: Cannot set the file time : ComfyUI_windows_portable\\x.txt"
mkdir -p "$out/ComfyUI_windows_portable/ComfyUI" "$out/ComfyUI_windows_portable/python_embeded"
echo "# main" > "$out/ComfyUI_windows_portable/ComfyUI/main.py"
`)
	t.Setenv("GLOW_7Z_CMD", "/bin/sh "+writeScript(t, h.dir, "fake7z-progress", b.String()))
	h.installCore()
	s := h.status()
	var sevenZip []string
	for _, l := range s.Engine.Log {
		if strings.HasPrefix(l, "[7-zip]") {
			sevenZip = append(sevenZip, l)
		}
	}
	want := []string{"[7-zip] unpacking… 100%", "[7-zip] WARNING: Cannot set the file time : ComfyUI_windows_portable\\x.txt"}
	if strings.Join(sevenZip, "|") != strings.Join(want, "|") {
		t.Fatalf("7-zip lines in Details: %q", sevenZip)
	}
	h.e.logs.sync() // (the log files are written in the background)
	data, _ := os.ReadFile(filepath.Join(s.InstallDir, "logs", "engine.log"))
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	n := 0
	for sc.Scan() {
		line := sc.Text()
		if strings.HasSuffix(strings.TrimSpace(line), "[7-zip]") {
			t.Fatalf("blank 7-zip line in engine.log: %q", line)
		}
		if strings.Contains(line, "[7-zip] unpacking…") {
			n++
		}
	}
	if n < 5 || n > 13 {
		t.Fatalf("%d progress lines in engine.log (want about one per 10 %%)", n)
	}
}

// ---------------------------------------------------------------- open log folder, status paths

func TestOpenLogsEndpoint(t *testing.T) {
	h := newHarness(t)
	code, out := h.do("POST", "/__glow/engine/open-logs", map[string]any{}, "Origin", h.origin, "Sec-Fetch-Site", "same-origin")
	want := filepath.Join(h.dir, "GlowStudio", "logs")
	if code != 200 || out["ok"] != true || out["opened"] != false || out["dir"] != want {
		t.Fatalf("%d %v", code, out)
	}
	if st, err := os.Stat(want); err != nil || !st.IsDir() {
		t.Fatal("the log folder should exist")
	}
	if code, _ := h.do("GET", "/__glow/engine/open-logs", nil); code != 405 {
		t.Fatalf("GET %d", code)
	}
	if code, _ := h.do("POST", "/__glow/engine/open-logs", map[string]any{}, "Sec-Fetch-Site", "cross-site"); code != 403 {
		t.Fatalf("cross-site %d", code)
	}
	s := h.status()
	if s.Logs.Dir != want || s.Logs.Launcher != filepath.Join(want, "launcher.log") || s.Logs.Crash != filepath.Join(want, "crash.log") ||
		s.Logs.Engine != filepath.Join(s.InstallDir, "logs", "engine.log") {
		t.Fatalf("%+v", s.Logs)
	}
}

// ---------------------------------------------------------------- start-up

func TestListenStartsFreshOrOpensTheRunningCopy(t *testing.T) {
	t.Setenv("GLOW_ENGINE_DIR", filepath.Join(t.TempDir(), "GlowStudio", "engine"))
	// a running Glow Studio on the first port: open a window on it
	glow, _ := net.Listen("tcp", "127.0.0.1:0")
	gsrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "glow-studio") })}
	go gsrv.Serve(glow)
	defer gsrv.Close()
	gp := glow.Addr().(*net.TCPAddr).Port
	ln, running, _, err := listen([]int{gp})
	if err != nil || ln != nil || running != fmt.Sprintf("http://127.0.0.1:%d/", gp) {
		t.Fatalf("running copy: %v %q %v", ln, running, err)
	}
	// another program on the first port: the next one is used
	other, _ := net.Listen("tcp", "127.0.0.1:0")
	osrv := &http.Server{Handler: http.NotFoundHandler()}
	go osrv.Serve(other)
	defer osrv.Close()
	free := freeTCPPort(t)
	ln, running, _, err = listen([]int{other.Addr().(*net.TCPAddr).Port, free})
	if err != nil || running != "" || ln.Addr().(*net.TCPAddr).Port != free {
		t.Fatalf("next port: %v %q %v", ln, running, err)
	}
	ln.Close()
	// the old copy is gone: its port is free again and a stale instance.json is ignored
	writeInstancePort(free)
	ln, running, _, err = listen([]int{free})
	if err != nil || running != "" || ln.Addr().(*net.TCPAddr).Port != free {
		t.Fatalf("fresh start: %v %q %v", ln, running, err)
	}
	ln.Close()
	// every fixed port taken by others, instance.json names a dead port: a random port
	ln, running, _, err = listen([]int{other.Addr().(*net.TCPAddr).Port})
	if err != nil || running != "" || ln == nil {
		t.Fatalf("random port: %v %q %v", ln, running, err)
	}
	ln.Close()
	// … but a copy recorded in instance.json that answers is opened
	writeInstancePort(gp)
	if _, running, _, _ = listen([]int{other.Addr().(*net.TCPAddr).Port}); running != fmt.Sprintf("http://127.0.0.1:%d/", gp) {
		t.Fatalf("instance.json copy: %q", running)
	}
}

// ---------------------------------------------------------------- cleanup of a story

func TestCleanupRemovesStoryFiles(t *testing.T) {
	h := newHarness(t)
	dir := h.status().InstallDir
	dirs := glowWorkDirs(dir)
	for _, d := range dirs {
		os.MkdirAll(d, 0o755)
	}
	put := func(d, name string) string {
		p := filepath.Join(d, name)
		os.WriteFile(p, []byte("x"), 0o644)
		return p
	}
	in, out := dirs[0], dirs[1]
	mine := []string{put(in, "selfie_gst1.jpg"), put(in, "audio_gst1.wav"), put(out, "gst1_s0_still_00001_.png"), put(out, "gst1_s3_sing_00001_.mp4"), put(out, "gst1_song_00001_.mp3")}
	keep := []string{put(in, "audio_gst12.wav"), put(out, "gst12_s0_still_00001_.png")}
	h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gst1"})
	prompts := make([]string, 40)
	for i := range prompts {
		prompts[i] = fmt.Sprintf("p-%d", i)
	}
	code, res := h.do("POST", "/__glow/engine/cleanup", map[string]any{"job": "gst1", "prompts": prompts})
	if code != 200 || res["removed"] != float64(5) {
		t.Fatalf("%d %v", code, res)
	}
	for _, p := range mine {
		if fileExists(p) {
			t.Fatalf("%s should be deleted", p)
		}
	}
	for _, p := range keep {
		if !fileExists(p) {
			t.Fatalf("%s must be kept", p)
		}
	}
	if h.e.Busy() {
		t.Fatal("cleanup must end the hold")
	}
}

// The reverse proxy's WebSocket goes through the request logger (main.go).
func TestWebSocketThroughRequestLogger(t *testing.T) {
	h := newHarness(t)
	h.installCore()
	h.do("POST", "/__glow/engine/start", nil)
	h.waitEngine("ready")
	addr := strings.TrimPrefix(h.srv.URL, "http://")
	ws := dialWS(t, addr, "/__glow/comfy/ws?clientId=logtest", h.origin)
	defer ws.conn.Close()
	var m struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(ws.read(t)), &m); err != nil || m.Type != "status" {
		t.Fatalf("%v %q", err, m.Type)
	}
}

// The user's report: the window slept through a long download (no pings), the
// install finished, and the launcher quit at once ("127.0.0.1 refused to
// connect"). Now it stays up while installing and for the idle time after.
func TestLauncherStaysUpAfterAnInstallWithoutPings(t *testing.T) {
	h := newHarness(t) // mock download server + catalog
	gate := make(chan struct{})
	h.files.mu.Lock()
	h.files.gate["video.safetensors"] = gate
	h.files.mu.Unlock()
	dir := t.TempDir()
	port := freeTCPPort(t)
	exe, _ := os.Executable()
	cmd := exec.Command(exe)
	cmd.Env = childEnv("GLOW_TEST_PROCESS=main", fmt.Sprintf("GLOW_PORT=%d", port), "GLOW_IDLE_EXIT=2s", "GLOW_NO_BROWSER=1",
		"GLOW_ENGINE_DIR="+filepath.Join(dir, "GlowStudio", "engine"), "GLOW_NVIDIA_SMI=/nonexistent", "GLOW_FAKE_DISK_FREE_GB=500",
		"GLOW_ENGINE_CATALOG="+filepath.Join(h.dir, "catalog.json"), "GLOW_ENGINE_URL_REWRITE=https://example.invalid/="+h.fsrv.URL+"/",
		"GLOW_SKIP_7Z=1", "GLOW_DL_BACKOFF_MS=20")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer cmd.Process.Kill()
	waitFor(t, 10*time.Second, func() bool { return alreadyRunning(port) })
	resp, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/__glow/engine/install", port), "application/json", strings.NewReader(`{"packs":["core"]}`))
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("install: %v %v", err, resp)
	}
	resp.Body.Close()
	// no page pings from here on (the window is asleep)
	select {
	case <-done:
		t.Fatal("quit in the middle of the install")
	case <-time.After(4500 * time.Millisecond):
	}
	close(gate)
	logPath := filepath.Join(dir, "GlowStudio", "logs", "launcher.log")
	var finished time.Time
	waitFor(t, 15*time.Second, func() bool {
		data, _ := os.ReadFile(logPath)
		if strings.Contains(string(data), "[install] finished") {
			finished = time.Now()
			return true
		}
		return false
	})
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("did not quit after the install")
	}
	// (counted from the tick that saw the install end, so never less than the idle time)
	if d := time.Since(finished); d < 1900*time.Millisecond {
		t.Fatalf("quit %s after the install finished: it must wait the idle time from then", d)
	}
	data, _ := os.ReadFile(logPath)
	for _, want := range []string{"busy: the AI files are being downloaded or checked", "[install] starting: core", "[install] finished", "exiting: idle exit"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("launcher.log lacks %q:\n%s", want, data)
		}
	}
}

// ---------------------------------------------------------------- updates (takeover.go)

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.3.0", "1.2.0", true}, {"1.2.0", "1.3.0", false}, {"1.3.0", "1.3.0", false},
		{"1.10.0", "1.9.9", true}, {"2.0.0", "1.99.99", true}, {"1.3.0", "", true}, {"", "1.0.0", false},
		{"1.3", "1.2.9", true}, {"v1.3.1", "1.3.0", true}, {"garbage", "0.0.1", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

// fakeLauncher serves a running Glow Studio of version v on a free port: a 1.3+
// one (modern: /__glow/version and /__glow/quit) or an older one (engine status
// + ComfyUI queue). busy: it is making a video. A quit closes it.
func fakeLauncher(t *testing.T, v string, busy, modern bool) (int, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	quits := &atomic.Int32{}
	srv := &http.Server{}
	mux := http.NewServeMux()
	mux.HandleFunc("/__glow/ping", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "glow-studio") })
	if modern {
		mux.HandleFunc("/__glow/version", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"app": "glow-studio", "version": v, "busy": busy, "why": "a video is being made (gst1)"})
		})
		mux.HandleFunc("/__glow/quit", func(w http.ResponseWriter, r *http.Request) {
			quits.Add(1)
			if busy {
				writeJSON(w, 409, map[string]any{"busy": true})
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true})
			go func() { time.Sleep(100 * time.Millisecond); srv.Close() }()
		})
	} else {
		mux.HandleFunc("/__glow/engine/status", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"launcher": v, "engine": map[string]any{"state": "ready"}, "job": nil})
		})
		mux.HandleFunc("/__glow/comfy/queue", func(w http.ResponseWriter, r *http.Request) {
			running := []any{}
			if busy {
				running = append(running, []any{1, "p1"})
			}
			writeJSON(w, 200, map[string]any{"queue_running": running, "queue_pending": []any{}})
		})
	}
	srv.Handler = mux
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port, quits
}

func TestUpdateTakesOverFromAnOlderIdleCopy(t *testing.T) {
	t.Setenv("GLOW_ENGINE_DIR", filepath.Join(t.TempDir(), "GlowStudio", "engine"))
	url := func(p int) string { return fmt.Sprintf("http://127.0.0.1:%d/", p) }

	// an idle older copy (1.3+) is asked to quit, and this copy starts on its port
	p, quits := fakeLauncher(t, "1.2.9", false, true)
	ln, running, note, err := listen([]int{p})
	if err != nil || ln == nil || running != "" || note != "" || ln.Addr().(*net.TCPAddr).Port != p || quits.Load() != 1 {
		t.Fatalf("idle older copy: %v %q %q %v quits=%d", ln, running, note, err, quits.Load())
	}
	ln.Close()

	// a busy older copy is left alone: a window opens on it, with a note to try later
	p, quits = fakeLauncher(t, "1.2.0", true, true)
	ln, running, note, err = listen([]int{p})
	if err != nil || ln != nil || running != url(p) || !strings.Contains(note, "busy") || quits.Load() != 0 {
		t.Fatalf("busy older copy: %v %q %q %v quits=%d", ln, running, note, err, quits.Load())
	}

	// the same version, or a newer one: simply open it
	for _, v := range []string{launcherVersion, "9.0.0"} {
		p, quits = fakeLauncher(t, v, false, true)
		ln, running, note, err = listen([]int{p})
		if err != nil || ln != nil || running != url(p) || note != "" || quits.Load() != 0 {
			t.Fatalf("version %s: %v %q %q %v", v, ln, running, note, err)
		}
	}

	// a launcher from before 1.3 (no /__glow/version) making a video: left alone
	p, _ = fakeLauncher(t, "1.1.0", true, false)
	ln, running, note, err = listen([]int{p})
	if err != nil || ln != nil || running != url(p) || !strings.Contains(note, "making a video") {
		t.Fatalf("old busy copy: %v %q %q %v", ln, running, note, err)
	}
}

func TestUpdateClosesAnOldIdleLauncherByItsProcessID(t *testing.T) {
	if _, err := os.Stat("/proc/self/cmdline"); err != nil {
		t.Skip("needs /proc")
	}
	t.Setenv("GLOW_ENGINE_DIR", filepath.Join(t.TempDir(), "GlowStudio", "engine"))
	sleepBin, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep")
	}
	run := func(name string) *exec.Cmd {
		p := filepath.Join(t.TempDir(), name)
		data, _ := os.ReadFile(sleepBin)
		os.WriteFile(p, data, 0o755)
		cmd := exec.Command(p, "60")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
		return cmd
	}
	record := func(port, pid int) {
		os.MkdirAll(filepath.Dir(instancePath()), 0o755)
		data, _ := json.Marshal(instanceInfo{Port: port, PID: pid})
		os.WriteFile(instancePath(), data, 0o644)
	}

	// a program that is not a Glow Studio is never ended, even when instance.json names it
	p, _ := fakeLauncher(t, "1.1.0", false, false)
	other := run("sleep-other")
	record(p, other.Process.Pid)
	ln, running, note, err := listen([]int{p})
	if err != nil || ln != nil || running == "" || !strings.Contains(note, "Close all Glow Studio windows") {
		t.Fatalf("not a glow program: %v %q %q %v", ln, running, note, err)
	}
	if other.ProcessState != nil || other.Process.Signal(syscall.Signal(0)) != nil {
		t.Fatal("another program was ended")
	}

	// the old idle Glow Studio recorded there is ended (SIGTERM here, TerminateProcess on Windows)
	old := run("glow-studio-old")
	p2 := 0
	{
		ln2, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p2 = ln2.Addr().(*net.TCPAddr).Port
		mux := http.NewServeMux()
		mux.HandleFunc("/__glow/ping", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "glow-studio") })
		mux.HandleFunc("/__glow/engine/status", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"launcher": "1.1.0", "engine": map[string]any{"state": "stopped"}, "job": nil})
		})
		srv := &http.Server{Handler: mux}
		go srv.Serve(ln2)
		go func() { old.Wait(); srv.Close() }() // the "old launcher" stops serving when its process ends
		t.Cleanup(func() { srv.Close() })
	}
	record(p2, old.Process.Pid)
	ln, running, note, err = listen([]int{p2})
	if err != nil || ln == nil || running != "" || ln.Addr().(*net.TCPAddr).Port != p2 {
		t.Fatalf("old idle launcher: %v %q %q %v", ln, running, note, err)
	}
	ln.Close()
}

func TestVersionAndQuitEndpoints(t *testing.T) {
	h := newHarness(t)
	code, res := h.do("GET", "/__glow/version", nil)
	if code != 200 || res["version"] != launcherVersion || res["app"] != "glow-studio" || res["busy"] != false {
		t.Fatalf("version: %d %v", code, res)
	}
	quit := make(chan string, 1)
	old := quitApp
	quitApp = func(reason string) { quit <- reason }
	defer func() { quitApp = old }()
	// a page on another site cannot make it quit
	if code, _ := h.do("POST", "/__glow/quit", map[string]any{"version": "9.0.0"}, "Origin", "https://evil.example"); code != 403 {
		t.Fatalf("cross-site quit: %d", code)
	}
	// only for a newer version
	if code, _ := h.do("POST", "/__glow/quit", map[string]any{"version": launcherVersion}); code != 400 {
		t.Fatalf("same-version quit: %d", code)
	}
	// never while a video is being made
	h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gst9"})
	if code, res := h.do("POST", "/__glow/quit", map[string]any{"version": "9.0.0"}); code != 409 || res["busy"] != true {
		t.Fatalf("busy quit: %d %v", code, res)
	}
	if code, res := h.do("GET", "/__glow/version", nil); code != 200 || res["busy"] != true {
		t.Fatalf("busy version: %d %v", code, res)
	}
	h.do("POST", "/__glow/engine/hold", map[string]any{"job": "gst9", "done": true})
	h.e.releaseHold("gst9")
	if code, _ := h.do("POST", "/__glow/quit", map[string]any{"version": "9.0.0"}); code != 200 {
		t.Fatalf("idle quit: %d", code)
	}
	select {
	case r := <-quit:
		if !strings.Contains(r, "9.0.0") {
			t.Fatalf("reason %q", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("did not quit")
	}
}

func TestCancelAnswersAtOnceWhileManifestWriteIsStuck(t *testing.T) {
	h := newHarness(t)
	h.status()
	var stuck atomic.Int32
	release := make(chan struct{})
	hook := func() {
		if stuck.Add(1) == 1 {
			select {
			case <-release:
			case <-time.After(10 * time.Second):
			}
		}
	}
	manifestWriteHook.Store(&hook)
	defer manifestWriteHook.Store(nil)
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}}); code != 202 {
		t.Fatalf("install %d %v", code, out)
	}
	time.Sleep(200 * time.Millisecond)
	t0 := time.Now()
	if code, _ := h.do("POST", "/__glow/engine/cancel", nil); code != 200 {
		t.Fatalf("cancel %d", code)
	}
	if d := time.Since(t0); d > 2500*time.Millisecond {
		t.Fatalf("Pause answered after %s", d)
	}
	t1 := time.Now()
	s := h.status()
	if d := time.Since(t1); d > 200*time.Millisecond {
		t.Fatalf("status took %s", d)
	}
	if s.Job == nil || (s.Job.State == "running" && (!s.Job.Pausing || !strings.HasPrefix(s.Job.Step, "Pausing"))) {
		t.Fatalf("while pausing: %+v", s.Job)
	}
	close(release)
	if s := h.waitJob("cancelled", "done", "error"); s.Job.State != "cancelled" || s.Job.Pausing {
		t.Fatalf("after the pause: %+v", s.Job)
	}
}

func TestRingLogAddNeverWaitsForTheFile(t *testing.T) {
	r := &ringLog{max: 10}
	r.fileMu.Lock() // the disk is stuck
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			r.addf("[launcher] line %d", i)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("add waited for the log file")
	}
	r.fileMu.Unlock()
	r.sync()
	if l := r.last(3); len(l) != 3 || l[2] != "[launcher] line 49" {
		t.Fatal(l)
	}
}
