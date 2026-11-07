package main

// Test doubles for "Share with friends": a fake engine, an in-process mock
// ComfyUI that really runs the queue (files on disk, /history, /queue,
// /interrupt, /view), a sharing harness with a host listener (behind the real
// Engine.guard) and a guest client, and a fake cloudflared (this test binary
// with GLOW_FAKE_CLOUDFLARED=1). The real cloudflared is never run.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"io/fs"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// ---------------------------------------------------------------- fake engine

type fakeEngine struct {
	mu                  sync.Mutex
	port                int
	state               string
	core, singing, fast bool
	dir                 string
	busy                bool
	eta                 [2]float64
	noEta               int
	gpu                 string
	starts              int
	startDelay          time.Duration
}

func (f *fakeEngine) shareComfy() (int, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state == "ready" {
		return f.port, "ready"
	}
	return 0, f.state
}

func (f *fakeEngine) startEngine() error {
	f.mu.Lock()
	f.starts++
	f.state = "starting"
	d := f.startDelay
	f.mu.Unlock()
	go func() {
		time.Sleep(d)
		f.mu.Lock()
		if f.state == "starting" {
			f.state = "ready"
		}
		f.mu.Unlock()
	}()
	return nil
}

func (f *fakeEngine) sharePacks() (bool, bool, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.core, f.singing, f.fast
}
func (f *fakeEngine) shareInstallDir() string { return f.dir }
func (f *fakeEngine) hostBusy() (bool, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.busy, "making a video"
}
func (f *fakeEngine) hostEta() ([2]float64, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.busy {
		return [2]float64{}, 0
	}
	return f.eta, f.noEta
}
func (f *fakeEngine) shareGPUName() string { return f.gpu }
func (f *fakeEngine) set(fn func(f *fakeEngine)) {
	f.mu.Lock()
	fn(f)
	f.mu.Unlock()
}

// ---------------------------------------------------------------- mock ComfyUI

type mockPrompt struct {
	ID       string
	ClientID string
	Graph    map[string]any
	Raw      map[string]any
	done     bool
	intr     bool
	host     bool // a prompt of the host's own page
	outputs  map[string]any
	errMsg   string
}

type mockComfy struct {
	t        testing.TB
	mu       sync.Mutex
	srv      *http.Server
	port     int
	root     string // .../ComfyUI
	queue    []*mockPrompt
	history  map[string]*mockPrompt
	all      []*mockPrompt
	deleted  []string
	intr     []string
	uploads  map[string][]byte
	delay    time.Duration
	failOnce map[string]string // step job-name part -> error text, once ("_s1_clip": "OutOfMemory")
	refuse   bool              // answer /prompt with node_errors
	cond     *sync.Cond
	closed   bool
}

func newMockComfy(t testing.TB, installDir string) *mockComfy {
	m := &mockComfy{t: t, root: filepath.Join(installDir, portableDir, "ComfyUI"), history: map[string]*mockPrompt{},
		uploads: map[string][]byte{}, delay: 40 * time.Millisecond, failOnce: map[string]string{}}
	m.cond = sync.NewCond(&m.mu)
	os.MkdirAll(filepath.Join(m.root, "input", "glow"), 0o755)
	os.MkdirAll(filepath.Join(m.root, "output", "glow"), 0o755)
	mux := http.NewServeMux()
	mux.HandleFunc("/upload/image", m.upload)
	mux.HandleFunc("/prompt", m.prompt)
	mux.HandleFunc("/history/", m.historyOne)
	mux.HandleFunc("/history", m.historyPost)
	mux.HandleFunc("/queue", m.queueH)
	mux.HandleFunc("/interrupt", m.interrupt)
	mux.HandleFunc("/view", m.view)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	m.port = ln.Addr().(*net.TCPAddr).Port
	m.srv = &http.Server{Handler: mux}
	go m.srv.Serve(ln)
	go m.worker()
	t.Cleanup(func() {
		m.mu.Lock()
		m.closed = true
		m.cond.Broadcast()
		m.mu.Unlock()
		m.srv.Close()
	})
	return m
}

func (m *mockComfy) upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	f, hdr, err := r.FormFile("image")
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	data, _ := io.ReadAll(f)
	sub := r.FormValue("subfolder")
	if r.FormValue("type") != "input" || sub != "glow" || r.FormValue("overwrite") != "true" {
		http.Error(w, "bad upload fields", 400)
		return
	}
	os.WriteFile(filepath.Join(m.root, "input", sub, hdr.Filename), data, 0o644)
	m.mu.Lock()
	m.uploads[hdr.Filename] = data
	m.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]string{"name": hdr.Filename, "subfolder": sub, "type": "input"})
}

// fileFor: where a LoadImage/LoadAudio name points ("glow/x.png" or "glow/x.png [output]").
func (m *mockComfy) fileFor(name string) string {
	if strings.HasSuffix(name, " [output]") {
		return filepath.Join(m.root, "output", filepath.FromSlash(strings.TrimSuffix(name, " [output]")))
	}
	return filepath.Join(m.root, "input", filepath.FromSlash(name))
}

func (m *mockComfy) prompt(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	g, _ := body["prompt"].(map[string]any)
	id, _ := body["prompt_id"].(string)
	cid, _ := body["client_id"].(string)
	m.mu.Lock()
	refuse := m.refuse
	m.mu.Unlock()
	errs := map[string]any{}
	for nid, raw := range g {
		n := raw.(map[string]any)
		in := n["inputs"].(map[string]any)
		ct := n["class_type"].(string)
		if ct == "LoadImage" || ct == "LoadAudio" {
			key := "image"
			if ct == "LoadAudio" {
				key = "audio"
			}
			if _, err := os.Stat(m.fileFor(in[key].(string))); err != nil {
				errs[nid] = map[string]any{"errors": []any{map[string]any{"type": "custom_validation_failed", "message": "Invalid file"}}, "class_type": ct}
			}
		}
	}
	if refuse || len(errs) > 0 {
		if len(errs) == 0 {
			errs["12"] = map[string]any{"errors": []any{map[string]any{"type": "value_not_in_list"}}, "class_type": "KSampler"}
		}
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": "prompt_outputs_failed_validation"}, "node_errors": errs})
		return
	}
	p := &mockPrompt{ID: id, ClientID: cid, Graph: g, Raw: body}
	m.mu.Lock()
	m.queue = append(m.queue, p)
	m.all = append(m.all, p)
	number := len(m.all)
	m.cond.Broadcast()
	m.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{"prompt_id": id, "number": number, "node_errors": map[string]any{}})
}

// addHost puts a prompt of the host's own page in the queue; it runs until finishHost.
func (m *mockComfy) addHost(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := &mockPrompt{ID: id, host: true}
	m.queue = append(m.queue, p)
	m.all = append(m.all, p)
	m.cond.Broadcast()
}

func (m *mockComfy) finishHost(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.queue {
		if p.ID == id {
			p.done = true
		}
	}
	m.cond.Broadcast()
}

func (m *mockComfy) worker() {
	for {
		m.mu.Lock()
		for len(m.queue) == 0 && !m.closed {
			m.cond.Wait()
		}
		if m.closed {
			m.mu.Unlock()
			return
		}
		p := m.queue[0]
		delay := m.delay
		m.mu.Unlock()
		if p.host {
			m.mu.Lock()
			for !p.done && !m.closed {
				m.cond.Wait()
			}
			m.queue = m.queue[1:]
			m.mu.Unlock()
			continue
		}
		deadline := time.Now().Add(delay)
		for time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
			m.mu.Lock()
			intr := p.intr
			m.mu.Unlock()
			if intr {
				break
			}
		}
		m.mu.Lock()
		m.queue = m.queue[1:]
		if !p.intr {
			m.executeLocked(p)
		}
		p.done = true
		m.history[p.ID] = p
		m.mu.Unlock()
	}
}

func (m *mockComfy) executeLocked(p *mockPrompt) {
	p.outputs = map[string]any{}
	for key, msg := range m.failOnce {
		for _, raw := range p.Graph {
			n := raw.(map[string]any)
			if pre, ok := n["inputs"].(map[string]any)["filename_prefix"].(string); ok && strings.Contains(pre, key) {
				p.errMsg = msg
				delete(m.failOnce, key)
				return
			}
		}
	}
	for nid, raw := range p.Graph {
		n := raw.(map[string]any)
		in := n["inputs"].(map[string]any)
		pre, ok := in["filename_prefix"].(string)
		if !ok {
			continue
		}
		ext, key := ".png", "images"
		switch n["class_type"] {
		case "SaveVideo":
			ext = ".mp4"
		case "SaveAudioMP3":
			ext, key = ".mp3", "audio"
		}
		dir, base := filepath.Split(filepath.FromSlash(pre))
		name := base + "_00001_" + ext
		os.MkdirAll(filepath.Join(m.root, "output", dir), 0o755)
		os.WriteFile(filepath.Join(m.root, "output", dir, name), []byte("mock "+n["class_type"].(string)+" "+pre), 0o644)
		out := map[string]any{key: []any{map[string]any{"filename": name, "subfolder": strings.TrimSuffix(filepath.ToSlash(dir), "/"), "type": "output"}}}
		if ext == ".mp4" {
			out["animated"] = []any{true}
		}
		p.outputs[nid] = out
	}
}

func (m *mockComfy) historyOne(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/history/")
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.history[id]
	if p == nil {
		w.Write([]byte("{}"))
		return
	}
	status := map[string]any{"status_str": "success", "completed": true, "messages": []any{}}
	switch {
	case p.intr:
		status = map[string]any{"status_str": "error", "completed": false, "messages": []any{[]any{"execution_interrupted", map[string]any{"prompt_id": id}}}}
	case p.errMsg != "":
		status = map[string]any{"status_str": "error", "completed": false, "messages": []any{[]any{"execution_error", map[string]any{"exception_message": p.errMsg, "exception_type": "torch.OutOfMemoryError"}}}}
	}
	json.NewEncoder(w).Encode(map[string]any{id: map[string]any{"outputs": p.outputs, "status": status}})
}

func (m *mockComfy) historyPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Delete []string `json:"delete"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	m.mu.Lock()
	m.deleted = append(m.deleted, body.Delete...)
	for _, id := range body.Delete {
		delete(m.history, id)
	}
	m.mu.Unlock()
	w.Write([]byte("{}"))
}

func (m *mockComfy) queueH(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r.Method == http.MethodPost {
		var body struct {
			Delete []string `json:"delete"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		for _, id := range body.Delete {
			for i, p := range m.queue {
				if p.ID == id && i > 0 {
					m.queue = append(m.queue[:i], m.queue[i+1:]...)
					break
				}
			}
		}
		w.Write([]byte("{}"))
		return
	}
	running, pending := []any{}, []any{}
	for i, p := range m.queue {
		it := []any{i, p.ID, map[string]any{}, map[string]any{}, []any{}}
		if i == 0 {
			running = append(running, it)
		} else {
			pending = append(pending, it)
		}
	}
	json.NewEncoder(w).Encode(map[string]any{"queue_running": running, "queue_pending": pending})
}

func (m *mockComfy) interrupt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PromptID string `json:"prompt_id"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	m.mu.Lock()
	m.intr = append(m.intr, body.PromptID)
	if len(m.queue) > 0 && m.queue[0].ID == body.PromptID {
		m.queue[0].intr = true
	}
	m.mu.Unlock()
	w.Write([]byte("{}"))
}

func (m *mockComfy) view(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("type") != "output" || strings.ContainsAny(q.Get("filename"), `/\`) {
		http.Error(w, "bad", 400)
		return
	}
	http.ServeFile(w, r, filepath.Join(m.root, "output", q.Get("subfolder"), q.Get("filename")))
}

func (m *mockComfy) guestPrompts() []*mockPrompt {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*mockPrompt
	for _, p := range m.all {
		if !p.host {
			out = append(out, p)
		}
	}
	return out
}

func (m *mockComfy) files(sub string) []string {
	ents, _ := os.ReadDir(filepath.Join(m.root, sub, "glow"))
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

// ---------------------------------------------------------------- harness

// captureLog sends launcher.log to a temporary file for this test.
func captureLog(t *testing.T) string {
	p := filepath.Join(t.TempDir(), "launcher.log")
	if err := launcherLog.open(p, logRotateBytes); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { launcherLog.close() })
	return p
}

type shareHarness struct {
	t     *testing.T
	s     *Share
	fe    *fakeEngine
	comfy *mockComfy
	dir   string
	host  string // http://127.0.0.1:<port> of the host listener
	hostE *Engine
}

// testApp is the web app bundle with the test scenes.json.
func testApp(t testing.TB) fs.FS {
	app, err := fs.Sub(bundle, "glow")
	if err != nil {
		t.Fatal(err)
	}
	m := fstest.MapFS{}
	fs.WalkDir(app, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			data, _ := fs.ReadFile(app, p)
			m[p] = &fstest.MapFile{Data: data}
		}
		return nil
	})
	sc, err := os.ReadFile("testdata/scenes.json")
	if err != nil {
		t.Fatal(err)
	}
	m["scenes.json"] = &fstest.MapFile{Data: sc}
	return m
}

type fakeTunnel struct {
	mu    sync.Mutex
	host  string
	state string
	s     *Share
}

func (f *fakeTunnel) run(ctx context.Context) {
	f.mu.Lock()
	f.state = "ready"
	f.mu.Unlock()
	f.s.tunnelChanged(f)
	<-ctx.Done()
}
func (f *fakeTunnel) stop() {}
func (f *fakeTunnel) Host() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.host
}
func (f *fakeTunnel) Status() tunnelStatusJSON {
	f.mu.Lock()
	defer f.mu.Unlock()
	return tunnelStatusJSON{State: f.state}
}

const fakeTunnelHost = "fake-share-test.trycloudflare.com"

func newShareHarness(t *testing.T) *shareHarness {
	t.Helper()
	h := &shareHarness{t: t, dir: t.TempDir()}
	t.Setenv("GLOW_ENGINE_DIR", filepath.Join(h.dir, "GlowStudio", "engine"))
	t.Setenv("GLOW_LAN_IP", "")
	install := filepath.Join(h.dir, "GlowStudio", "engine")
	h.comfy = newMockComfy(t, install)
	h.fe = &fakeEngine{port: h.comfy.port, state: "ready", core: true, singing: true, fast: true, dir: install, gpu: "NVIDIA GeForce RTX 5060 Ti", startDelay: 50 * time.Millisecond}
	s := newShare(h.fe, testApp(t))
	s.guestPort = 0
	s.pollEvery, s.hostCheckEvery = 15*time.Millisecond, 15*time.Millisecond
	s.engineWait = 5 * time.Second
	s.cancelGrace = 30 * time.Millisecond
	s.tunnelFactory = func(s *Share, port int) tunnelRunner {
		return &fakeTunnel{host: fakeTunnelHost, state: "starting", s: s}
	}
	h.s = s
	// the host's listener: the real Engine.guard in front of the share API
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	h.hostE = &Engine{port: port}
	mux := http.NewServeMux()
	mux.HandleFunc("/__glow/share/", func(w http.ResponseWriter, r *http.Request) {
		if !h.hostE.guard(w, r) {
			return
		}
		s.hostAPI(w, r)
	})
	srv := &http.Server{Handler: logRequests(mux)}
	go srv.Serve(ln)
	h.host = fmt.Sprintf("http://127.0.0.1:%d", port)
	t.Cleanup(func() {
		s.Shutdown()
		srv.Close()
	})
	return h
}

// hostDo calls the host API.
func (h *shareHarness) hostDo(method, path string, body any) (int, map[string]any) {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.host+path, rd)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	raw, _ := io.ReadAll(resp.Body)
	json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func (h *shareHarness) start(mode string, extra map[string]any) map[string]any {
	h.t.Helper()
	body := map[string]any{"mode": mode, "hostName": "Ana"}
	for k, v := range extra {
		body[k] = v
	}
	code, st := h.hostDo("POST", "/__glow/share/start", body)
	if code != 202 {
		h.t.Fatalf("start: %d %v", code, st)
	}
	waitFor(h.t, 5*time.Second, func() bool { return h.status()["state"] == "on" })
	return h.status()
}

func (h *shareHarness) status() map[string]any {
	h.t.Helper()
	_, st := h.hostDo("GET", "/__glow/share/status", nil)
	return st
}

func (h *shareHarness) token() string {
	h.s.mu.Lock()
	defer h.s.mu.Unlock()
	return h.s.token
}

func (h *shareHarness) guestURL() string {
	h.s.mu.Lock()
	defer h.s.mu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d", h.s.gport)
}

func (h *shareHarness) job(id string) *guestJob {
	h.s.mu.Lock()
	defer h.s.mu.Unlock()
	return h.s.jobs[id]
}

func (h *shareHarness) jobState(id string) string {
	h.s.mu.Lock()
	defer h.s.mu.Unlock()
	if j := h.s.jobs[id]; j != nil {
		return j.state
	}
	return ""
}

func (h *shareHarness) waitJob(id string, states ...string) {
	h.t.Helper()
	waitFor(h.t, 15*time.Second, func() bool {
		st := h.jobState(id)
		for _, s := range states {
			if st == s {
				return true
			}
		}
		return false
	})
}

// ---------------------------------------------------------------- guest client

type guestClient struct {
	t      *testing.T
	base   string
	c      *http.Client
	csrf   string
	hdr    map[string]string
	host   string // Host header override
	origin bool   // send a same-origin Origin header
}

func (h *shareHarness) newGuest(ip string) *guestClient {
	jar, _ := cookiejar.New(nil)
	g := &guestClient{t: h.t, base: h.guestURL(), c: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		hdr: map[string]string{}, origin: true}
	if ip != "" {
		g.hdr["Cf-Connecting-Ip"] = ip
	}
	return g
}

func (g *guestClient) req(method, path string, body io.Reader, ctype string, hdr ...string) (*http.Response, []byte) {
	g.t.Helper()
	req, _ := http.NewRequest(method, g.base+path, body)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	for k, v := range g.hdr {
		req.Header.Set(k, v)
	}
	if g.host != "" {
		req.Host = g.host
	}
	if method == "POST" {
		if g.origin {
			u, _ := url.Parse(g.base)
			host := u.Host
			if g.host != "" {
				host = g.host
			}
			scheme := "http"
			if g.hdr["X-Forwarded-Proto"] == "https" {
				scheme = "https"
			}
			req.Header.Set("Origin", scheme+"://"+host)
			req.Header.Set("Sec-Fetch-Site", "same-origin")
		}
		if g.csrf != "" {
			req.Header.Set("X-Glow-CSRF", g.csrf)
		}
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		if hdr[i+1] == "" {
			req.Header.Del(hdr[i])
		} else {
			req.Header.Set(hdr[i], hdr[i+1])
		}
	}
	resp, err := g.c.Do(req)
	if err != nil {
		g.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func decodeMap(b []byte) map[string]any {
	m := map[string]any{}
	json.Unmarshal(b, &m)
	return m
}

func (g *guestClient) getJSON(path string) (int, map[string]any) {
	resp, b := g.req("GET", path, nil, "")
	return resp.StatusCode, decodeMap(b)
}

func (g *guestClient) postJSON(path string, body any, hdr ...string) (int, map[string]any) {
	b, _ := json.Marshal(body)
	resp, data := g.req("POST", path, bytes.NewReader(b), "application/json", hdr...)
	return resp.StatusCode, decodeMap(data)
}

func (g *guestClient) join(token string) (*http.Response, map[string]any) {
	b, _ := json.Marshal(map[string]string{"token": token})
	resp, data := g.req("POST", "/__glow/guest/join", bytes.NewReader(b), "application/json", "X-Glow-Guest", "1")
	m := decodeMap(data)
	if resp.StatusCode == 200 {
		g.csrf = m["session"].(map[string]any)["csrf"].(string)
	}
	return resp, m
}

// joined is a named guest, ready to send jobs.
func (h *shareHarness) joined(name, ip string) *guestClient {
	h.t.Helper()
	g := h.newGuest(ip)
	if resp, m := g.join(h.token()); resp.StatusCode != 200 {
		h.t.Fatalf("join: %d %v", resp.StatusCode, m)
	}
	if code, m := g.postJSON("/__glow/guest/name", map[string]string{"name": name}); code != 200 {
		h.t.Fatalf("name: %d %v", code, m)
	}
	return g
}

func jobReq(scene string, dur int, sound, sync, quality string) map[string]any {
	return map[string]any{"v": 1, "sceneId": scene, "duration": dur, "sound": sound, "sync": sync, "quality": quality,
		"tempo": map[string]any{"bpm": 120, "feel": "fast"}, "lipStarts": nil, "seed": 1234, "consent": map[string]any{"own": true, "adult": true}}
}

// submit sends a job (multipart); parts beyond the request are raw bytes.
func (g *guestClient) submit(req any, selfie, audio []byte, extra ...[2]any) (int, map[string]any) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if req != nil {
		var rb []byte
		if s, ok := req.(string); ok {
			rb = []byte(s)
		} else {
			rb, _ = json.Marshal(req)
		}
		w, _ := mw.CreateFormField("request")
		w.Write(rb)
	}
	if selfie != nil {
		w, _ := mw.CreateFormFile("selfie", "me.jpg")
		w.Write(selfie)
	}
	if audio != nil {
		w, _ := mw.CreateFormFile("audio", "song.wav")
		w.Write(audio)
	}
	for _, x := range extra {
		w, _ := mw.CreateFormField(x[0].(string))
		w.Write(x[1].([]byte))
	}
	mw.Close()
	resp, data := g.req("POST", "/__glow/guest/jobs", &body, mw.FormDataContentType())
	return resp.StatusCode, decodeMap(data)
}

func jobOf(m map[string]any) map[string]any {
	j, _ := m["job"].(map[string]any)
	return j
}

// ---------------------------------------------------------------- media

func testJPEG(w, h int, exif string) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), uint8(x + y), 255})
		}
	}
	var b bytes.Buffer
	jpeg.Encode(&b, img, &jpeg.Options{Quality: 85})
	data := b.Bytes()
	if exif == "" {
		return data
	}
	payload := append([]byte("Exif\x00\x00"), []byte(exif)...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	seg = append(seg, payload...)
	return append(append(append([]byte{}, data[:2]...), seg...), data[2:]...)
}

// pngHeaderOnly is a PNG that claims w x h pixels (a decompression bomb's header).
func pngHeaderOnly(w, h int) []byte {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:], uint32(h))
	ihdr[8], ihdr[9] = 8, 0
	chunk := func(typ string, data []byte) {
		binary.Write(&b, binary.BigEndian, uint32(len(data)))
		b.WriteString(typ)
		b.Write(data)
		binary.Write(&b, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(typ), data...)))
	}
	chunk("IHDR", ihdr)
	chunk("IDAT", []byte{0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01})
	chunk("IEND", nil)
	return b.Bytes()
}

func testWAV(rate, channels, bits int, seconds float64) []byte {
	n := int(float64(rate)*seconds) * channels * bits / 8
	if n%2 == 1 {
		n++
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+n+12))
	b.WriteString("WAVE")
	b.WriteString("LIST") // a chunk to skip (tags)
	binary.Write(&b, binary.LittleEndian, uint32(4))
	b.WriteString("INFO")
	b.WriteString("fmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(channels))
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate*channels*bits/8))
	binary.Write(&b, binary.LittleEndian, uint16(channels*bits/8))
	binary.Write(&b, binary.LittleEndian, uint16(bits))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(n))
	b.Write(make([]byte, n))
	return b.Bytes()
}

// ---------------------------------------------------------------- fake cloudflared

// runFakeCloudflared stands in for cloudflared (GLOW_FAKE_CLOUDFLARED=1): it
// prints a quick tunnel box like the real one, serves /ready and /quicktunnel
// on --metrics and, with GLOW_FAKE_CF_PROXY=<addr>, proxies to --url adding
// the tunnel's Host, X-Forwarded-Proto and Cf-Connecting-Ip.
func runFakeCloudflared() {
	var metrics, target, cfg string
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--metrics":
			metrics = args[i+1]
		case "--url":
			target = args[i+1]
		case "--config":
			cfg = args[i+1]
		}
	}
	n := 1
	if f := os.Getenv("GLOW_FAKE_CF_COUNTER"); f != "" {
		b, _ := os.ReadFile(f)
		n, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		n++
		os.WriteFile(f, []byte(strconv.Itoa(n)), 0o644)
	}
	host := fmt.Sprintf("fake-share-test-%d.trycloudflare.com", n)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "TUNNEL_") || strings.HasPrefix(kv, "CLOUDFLARED_") {
			fmt.Println("ENV-LEAK", strings.SplitN(kv, "=", 2)[0])
		}
	}
	if data, err := os.ReadFile(cfg); err != nil || string(data) != "no-autoupdate: true\n" {
		fmt.Println("BAD-CONFIG")
	}
	fmt.Println("2026-11-06T22:00:00Z INF Thank you for trying Cloudflare Tunnel. See https://api.trycloudflare.com for terms")
	if os.Getenv("GLOW_FAKE_CF_SILENT") == "1" {
		time.Sleep(time.Hour)
	}
	if os.Getenv("GLOW_FAKE_CF_FAIL") == "1" {
		fmt.Println("2026-11-06T22:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests")
		os.Exit(1)
	}
	fmt.Println("2026-11-06T22:00:00Z INF +--------------------------------------------------------------------------------------------+")
	fmt.Println("2026-11-06T22:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |")
	fmt.Printf("2026-11-06T22:00:00Z INF |  \x1b[1mhttps://%s\x1b[0m                                              |\n", host)
	fmt.Println("2026-11-06T22:00:00Z INF +--------------------------------------------------------------------------------------------+")
	qt := host
	if os.Getenv("GLOW_FAKE_CF_QT_MISMATCH") == "1" {
		qt = "someone-else.trycloudflare.com"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"status":200,"readyConnections":4}`)) })
	mux.HandleFunc("/quicktunnel", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintf(w, `{"hostname":%q}`, qt) })
	go http.ListenAndServe(metrics, mux)
	if p := os.Getenv("GLOW_FAKE_CF_PROXY"); p != "" {
		u, _ := url.Parse(target)
		rp := httputil.NewSingleHostReverseProxy(u)
		d := rp.Director
		rp.Director = func(r *http.Request) {
			d(r)
			r.Host = host
			r.Header.Set("X-Forwarded-Proto", "https")
			r.Header.Set("Cf-Connecting-Ip", "203.0.113.7")
		}
		go http.ListenAndServe(p, rp)
	}
	if ms, _ := strconv.Atoi(os.Getenv("GLOW_FAKE_CF_EXIT_AFTER_MS")); ms > 0 && n == 1 {
		time.Sleep(time.Duration(ms) * time.Millisecond)
		fmt.Println("ERR connection lost")
		os.Exit(1)
	}
	time.Sleep(time.Hour)
}
