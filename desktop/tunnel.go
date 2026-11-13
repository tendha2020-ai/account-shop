package main

// "Anywhere (internet link)" (DESIGN f): Cloudflare's free Quick Tunnel. The
// launcher downloads Cloudflare's official cloudflared for Windows once (an
// exact release, checked by size and sha256 before EVERY start), runs
//
//	cloudflared tunnel --no-autoupdate --config <own yml> --protocol http2 --metrics 127.0.0.1:<m> --url http://127.0.0.1:<guest port>
//
// hidden and inside the kill-on-close Job Object (like ComfyUI), reads the
// https://<random>.trycloudflare.com address from its output, confirms it on
// cloudflared's own metrics endpoint (/quicktunnel, /ready), restarts it when
// it dies (1, 2, 4 … 30 s; more than 8 restarts in 10 minutes: given up) and
// kills it when sharing stops or the launcher exits. Only the friends' page
// (the guest port) is reachable through it. Traffic passes through Cloudflare,
// encrypted; the link is temporary and changes on every start.
//
// Test hook: GLOW_CLOUDFLARED_CMD (a command, split on spaces, run instead of
// the exe with the same arguments; no download). The real cloudflared is never
// run by the tests.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// cloudflaredFile is the pinned release (2026.10.7, Apache-2.0, signed by
// Cloudflare, Inc.); hashed from the official GitHub release asset, never run there.
var cloudflaredFile = FileSpec{
	Label: "Secure link tool (Cloudflare)", Name: "cloudflared-2026.10.7.exe",
	URL:    "https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe",
	Size:   55390512,
	SHA256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343",
	Magic:  "4d5a", License: "Apache-2.0 (cloudflared)",
}

// cloudflaredAnyOS lets tests run a downloaded stand-in outside Windows.
var cloudflaredAnyOS = false

type tunnelStatusJSON struct {
	State    string          `json:"state"` // off | downloading | verifying | starting | ready | restarting | failed
	Download *tunnelDownload `json:"download"`
	Restarts int             `json:"restarts"`
	Error    *string         `json:"error"`
}

type tunnelDownload struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

type tunnelRunner interface {
	run(ctx context.Context)
	stop()
	Host() string
	Status() tunnelStatusJSON
}

type cloudflaredTunnel struct {
	share *Share
	gport int

	mu       sync.Mutex
	state    string
	dl       *tunnelDownload
	restarts int
	err      string
	host     string
	stopCh   chan struct{}
	stopOnce sync.Once

	logMinute time.Time
	logCount  int

	urlTimeout   time.Duration
	readyTimeout time.Duration
	backoff      []time.Duration
	maxRestarts  int
	checkPublic  bool
}

func newCloudflaredTunnel(s *Share, gport int) tunnelRunner {
	t := &cloudflaredTunnel{share: s, gport: gport, state: "starting", stopCh: make(chan struct{}),
		urlTimeout: 45 * time.Second, readyTimeout: 60 * time.Second, maxRestarts: 8,
		backoff:     []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second},
		checkPublic: os.Getenv("GLOW_CLOUDFLARED_CMD") == "",
	}
	return t
}

func (t *cloudflaredTunnel) Host() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.host
}

func (t *cloudflaredTunnel) Status() tunnelStatusJSON {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := tunnelStatusJSON{State: t.state, Restarts: t.restarts, Error: strp(t.err)}
	if t.dl != nil && t.state == "downloading" {
		d := *t.dl
		st.Download = &d
	}
	return st
}

func (t *cloudflaredTunnel) set(state, err string) {
	t.mu.Lock()
	t.state = state
	if err != "" || state == "ready" {
		t.err = err
	}
	t.mu.Unlock()
}

func (t *cloudflaredTunnel) stop() { t.stopOnce.Do(func() { close(t.stopCh) }) }

func toolsDir() string { return filepath.Join(filepath.Dir(engineDefaultDir()), "tools") }

// tunnelEnv: the launcher's environment without TUNNEL_* and CLOUDFLARED_*
// (cloudflared reads flags from such variables).
func tunnelEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k := strings.ToUpper(strings.SplitN(kv, "=", 2)[0])
		if strings.HasPrefix(k, "TUNNEL_") || strings.HasPrefix(k, "CLOUDFLARED_") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

var tunnelHostRe = regexp.MustCompile(`https://([a-z0-9]+(?:-[a-z0-9]+)+)\.trycloudflare\.com\b`)

// parseTunnelHost finds the quick tunnel's address in one output line.
func parseTunnelHost(line string) string {
	m := tunnelHostRe.FindStringSubmatch(strings.ToLower(ansiRe.ReplaceAllString(line, "")))
	if m == nil {
		return ""
	}
	return m[1] + ".trycloudflare.com"
}

// fileMatches: exact size and sha256 of the pinned file (read fresh every time).
func fileMatches(path string, f FileSpec) bool {
	st, err := os.Stat(path)
	if err != nil || st.Size() != f.Size {
		return false
	}
	in, err := os.Open(path)
	if err != nil {
		return false
	}
	defer in.Close()
	h := sha256.New()
	if _, err := io.Copy(h, in); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == f.SHA256
}

const msgSafety = "The secure link tool didn't pass its safety check. Check your internet connection and try again, or use Same Wi-Fi only."

// prepare returns the command to run: the verified cloudflared (downloaded on
// first use) or the test hook.
func (t *cloudflaredTunnel) prepare(ctx context.Context) (string, []string, error) {
	dir := toolsDir()
	os.MkdirAll(dir, 0o755)
	cfg := filepath.Join(dir, "cloudflared-glow.yml")
	if err := os.WriteFile(cfg, []byte("no-autoupdate: true\n"), 0o644); err != nil {
		return "", nil, friendly(err, "Glow Studio could not write its link settings. Check that the disk is not full.")
	}
	args := []string{"tunnel", "--no-autoupdate", "--config", cfg}
	if hook := strings.Fields(os.Getenv("GLOW_CLOUDFLARED_CMD")); len(hook) > 0 {
		return hook[0], append(hook[1:], args...), nil
	}
	if runtime.GOOS != "windows" && !cloudflaredAnyOS {
		return "", nil, errors.New("the internet link works on Windows only")
	}
	f := cloudflaredFile
	dest := filepath.Join(dir, f.Name)
	if ents, err := os.ReadDir(dir); err == nil { // other versions
		for _, e := range ents {
			n := e.Name()
			if strings.HasPrefix(n, "cloudflared-") && strings.HasSuffix(n, ".exe") && n != f.Name {
				os.Remove(filepath.Join(dir, n))
			}
		}
	}
	t.set("verifying", "")
	runnable := func() (string, []string, error) {
		if runtime.GOOS != "windows" {
			os.Chmod(dest, 0o755) // (tests: a stand-in script)
		}
		return dest, args, nil
	}
	if fileMatches(dest, f) {
		return runnable()
	}
	for tries := 0; tries < 2; tries++ {
		os.Remove(dest)
		t.mu.Lock()
		t.state, t.dl = "downloading", &tunnelDownload{Total: f.Size}
		t.mu.Unlock()
		t.share.logf("downloading the secure link tool (cloudflared %s, %d MB)", strings.TrimSuffix(strings.TrimPrefix(f.Name, "cloudflared-"), ".exe"), f.Size>>20)
		err := newDownloader().fetch(ctx, f, dest, dlHooks{
			onDisk: func(n int64) { t.mu.Lock(); t.dl.Done = n; t.mu.Unlock() },
			logf:   func(format string, a ...any) { t.share.logf("cloudflared download: "+format, a...) },
		})
		if ctx.Err() != nil {
			return "", nil, ctx.Err()
		}
		t.set("verifying", "")
		if err == nil && fileMatches(dest, f) {
			return runnable()
		}
		var ue *userError
		if err != nil && errors.As(err, &ue) && !strings.Contains(ue.msg, "damaged") {
			return "", nil, err // no connection etc.: its own plain words
		}
		t.share.logf("the downloaded cloudflared did not match its pinned size and sha256 (try %d): %v", tries+1, err)
	}
	os.Remove(dest)
	return "", nil, friendly(nil, msgSafety)
}

func (t *cloudflaredTunnel) run(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	go func() {
		select {
		case <-t.stopCh:
			cancel()
		case <-ctx.Done():
		}
	}()
	exe, args, err := t.prepare(ctx)
	if err != nil {
		if ctx.Err() != nil {
			t.set("off", "")
			return
		}
		msg := userMsg(err)
		t.set("failed", msg)
		t.share.logf("the internet link could not start: %v", err)
		t.share.tunnelFailed(t, msg)
		return
	}
	var restarts []time.Time
	step := 0
	for {
		began := time.Now()
		t.once(ctx, exe, args)
		t.mu.Lock()
		t.host = ""
		t.mu.Unlock()
		if ctx.Err() != nil {
			t.set("off", "")
			return
		}
		now := time.Now()
		if now.Sub(began) > 5*time.Minute {
			step = 0
		}
		keep := restarts[:0]
		for _, r := range restarts {
			if now.Sub(r) < 10*time.Minute {
				keep = append(keep, r)
			}
		}
		restarts = append(keep, now)
		if len(restarts) > t.maxRestarts {
			msg := "The internet link stopped working. Try Same Wi-Fi only, or Stop and start again."
			t.mu.Lock()
			if t.err != "" && strings.Contains(t.err, "busy") {
				msg = t.err
			}
			t.mu.Unlock()
			t.set("failed", msg)
			t.share.logf("the internet link keeps stopping: given up after %d restarts in 10 minutes", len(restarts)-1)
			t.share.tunnelFailed(t, msg)
			return
		}
		wait := t.backoff[min(step, len(t.backoff)-1)]
		step++
		t.mu.Lock()
		t.state = "restarting"
		t.restarts++
		t.mu.Unlock()
		t.share.logf("the internet link stopped; starting it again in %s (the link will change)", wait)
		select {
		case <-ctx.Done():
			t.set("off", "")
			return
		case <-time.After(wait):
		}
	}
}

func (t *cloudflaredTunnel) logLine(line string) {
	line = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, ansiRe.ReplaceAllString(line, ""))
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	if rs := []rune(line); len(rs) > 300 {
		line = string(rs[:300]) + "…"
	}
	t.mu.Lock()
	now := time.Now()
	if now.Sub(t.logMinute) >= time.Minute {
		t.logMinute, t.logCount = now, 0
	}
	t.logCount++
	ok := t.logCount <= 50
	if l := strings.ToLower(line); strings.Contains(l, "failed to request quick tunnel") || strings.Contains(l, "429") {
		t.err = "Cloudflare's free link service is busy or this PC is offline. Try again in a minute, or use Same Wi-Fi only."
	}
	t.mu.Unlock()
	if ok {
		launcherLog.printf("[tunnel] %s", line)
	}
}

// once runs cloudflared until it exits or ctx ends.
func (t *cloudflaredTunnel) once(ctx context.Context, exe string, args []string) {
	mport, err := freePort(0)
	if err != nil {
		return
	}
	full := append(append([]string(nil), args...), "--protocol", "http2", "--metrics", fmt.Sprintf("127.0.0.1:%d", mport), "--url", fmt.Sprintf("http://127.0.0.1:%d", t.gport))
	cmd := exec.Command(exe, full...)
	cmd.Env = tunnelEnv()
	cmd.Dir = toolsDir()
	hideWindow(cmd)
	pr, pw, err := os.Pipe()
	if err != nil {
		return
	}
	cmd.Stdout, cmd.Stderr = pw, pw
	t.mu.Lock()
	if t.state != "restarting" {
		t.state = "starting"
	}
	t.mu.Unlock()
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		t.share.logf("cloudflared could not be started: %v", err)
		return
	}
	pw.Close()
	afterStart(cmd)
	hostCh := make(chan string, 1)
	go func() {
		defer pr.Close()
		defer recoverLog("tunnel output")
		sent := false
		(&ringLog{}).pump(pr, func(line string) {
			t.logLine(line)
			if !sent {
				if h := parseTunnelHost(line); h != "" {
					sent = true
					hostCh <- h
				}
			}
		})
	}()
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	kill := func() {
		killTree(cmd)
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
		}
	}
	select {
	case h := <-hostCh:
		if !t.confirm(ctx, mport, h, exited) {
			kill()
			return
		}
		t.mu.Lock()
		t.host, t.state = h, "starting"
		t.mu.Unlock()
		t.share.logf("link ready https://%s/ (token not logged)", h)
		t.share.tunnelChanged(t)
		go t.waitReady(ctx, mport, h, exited)
	case <-time.After(t.urlTimeout):
		t.share.logf("cloudflared gave no link within %s: restarting it", t.urlTimeout)
		kill()
		return
	case <-exited:
		return
	case <-ctx.Done():
		kill()
		return
	}
	select {
	case <-exited:
	case <-ctx.Done():
		kill()
	}
}

// confirm checks the address on cloudflared's own metrics endpoint
// (GET /quicktunnel), so a stray address in its output is never used.
func (t *cloudflaredTunnel) confirm(ctx context.Context, mport int, host string, exited chan struct{}) bool {
	c := http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/quicktunnel", mport))
		if err == nil {
			var qt struct {
				Hostname string `json:"hostname"`
			}
			ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&qt) == nil
			resp.Body.Close()
			if ok {
				if strings.EqualFold(qt.Hostname, host) {
					return true
				}
				t.share.logf("cloudflared's address (%s) does not match its output (%s): restarting it", qt.Hostname, host)
				return false
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-exited:
			return false
		case <-time.After(300 * time.Millisecond):
		}
	}
	t.share.logf("cloudflared's metrics did not answer: using the address from its output")
	return true
}

// waitReady polls /ready (connected to Cloudflare's edge) for up to 60 s.
func (t *cloudflaredTunnel) waitReady(ctx context.Context, mport int, host string, exited chan struct{}) {
	defer recoverLog("tunnel ready")
	c := http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	deadline := time.Now().Add(t.readyTimeout)
	for time.Now().Before(deadline) {
		resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/ready", mport))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				t.mu.Lock()
				if t.host == host {
					t.state, t.err = "ready", ""
				}
				t.mu.Unlock()
				if t.checkPublic {
					t.checkHello(ctx, host)
				}
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-exited:
			return
		case <-time.After(time.Second):
		}
	}
	t.share.logf("the internet link is not connected yet; it may take a minute to work")
}

// checkHello opens the friends' page through the internet once (best effort).
func (t *cloudflaredTunnel) checkHello(ctx context.Context, host string) {
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodGet, "https://"+host+"/__glow/guest/hello", nil)
	resp, err := (&http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}).Do(req)
	if err != nil {
		t.share.logf("the internet link may take a minute to work (%v)", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.share.logf("the internet link answered %d; it may take a minute to work", resp.StatusCode)
	}
}
