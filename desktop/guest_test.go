package main

// "Share with friends": the friends' listener and API, end to end against an
// in-process mock ComfyUI (share_helpers_test.go).

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestGuestJoinCookieAndSession(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.newGuest("198.51.100.1")
	if code, m := g.getJSON("/__glow/guest/hello"); code != 200 || m["sharing"] != "on" || m["session"] != false || m["guest"] != true {
		t.Fatalf("hello %d %v", code, m)
	}
	if code, m := g.getJSON("/__glow/guest/session"); code != 401 || m["error"] != "no-session" {
		t.Fatalf("session without cookie %d %v", code, m)
	}
	// join needs X-Glow-Guest and JSON
	b, _ := json.Marshal(map[string]string{"token": h.token()})
	if resp, _ := g.req("POST", "/__glow/guest/join", bytes.NewReader(b), "application/json"); resp.StatusCode != 403 {
		t.Fatalf("join without X-Glow-Guest: %d", resp.StatusCode)
	}
	if resp, _ := g.req("POST", "/__glow/guest/join", bytes.NewReader(b), "text/plain", "X-Glow-Guest", "1"); resp.StatusCode != 403 {
		t.Fatalf("join as text/plain: %d", resp.StatusCode)
	}
	if resp, m := g.join("not-the-token"); resp.StatusCode != 403 || m["error"] != "bad-token" {
		t.Fatalf("bad token %d %v", resp.StatusCode, m)
	}
	resp, m := g.join(h.token())
	if resp.StatusCode != 200 {
		t.Fatalf("join %d %v", resp.StatusCode, m)
	}
	sc := resp.Header.Get("Set-Cookie")
	for _, want := range []string{"glow_guest=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=43200"} {
		if !strings.Contains(sc, want) {
			t.Errorf("cookie %q lacks %s", sc, want)
		}
	}
	if strings.Contains(sc, "Secure") {
		t.Errorf("cookie over plain http is Secure: %q", sc)
	}
	sess := m["session"].(map[string]any)
	if sess["secureContext"] != false || sess["state"] != "on" || sess["mode"] != "internet" || sess["scenesVersion"] != 1.0 {
		t.Errorf("session %v", sess)
	}
	if host := sess["host"].(map[string]any); host["name"] != "Ana" || host["singing"] != true {
		t.Errorf("host %v", host)
	}
	if lim := sess["limits"].(map[string]any); lim["daily"] != 5.0 || lim["left"] != 5.0 {
		t.Errorf("limits %v", lim)
	}
	if guest := sess["guest"].(map[string]any); guest["name"] != nil || !regexp.MustCompile(`^u[0-9a-f]{12}$`).MatchString(guest["id"].(string)) {
		t.Errorf("guest %v", guest)
	}
	// joining again with the cookie returns the same session (link previews etc.)
	resp2, m2 := g.join(h.token())
	if resp2.StatusCode != 200 || m2["session"].(map[string]any)["guest"].(map[string]any)["id"] != sess["guest"].(map[string]any)["id"] {
		t.Fatalf("second join %d %v", resp2.StatusCode, m2)
	}
	if code, _ := g.getJSON("/__glow/guest/session"); code != 200 {
		t.Fatalf("session %d", code)
	}
	// over the tunnel (https): Secure cookie, secure context
	tg := h.newGuest("198.51.100.2")
	tg.host, tg.hdr["X-Forwarded-Proto"] = fakeTunnelHost, "https"
	resp3, m3 := tg.join(h.token())
	if resp3.StatusCode != 200 || !strings.Contains(resp3.Header.Get("Set-Cookie"), "Secure") || m3["session"].(map[string]any)["secureContext"] != true {
		t.Fatalf("tunnel join %d %v %q", resp3.StatusCode, m3, resp3.Header.Get("Set-Cookie"))
	}
	// plain http to the tunnel's name is sent to https
	hg := h.newGuest("")
	hg.host, hg.hdr["X-Forwarded-Proto"] = fakeTunnelHost, "http"
	if resp, _ := hg.req("GET", "/?join=x", nil, ""); resp.StatusCode != 308 || resp.Header.Get("Location") != "https://"+fakeTunnelHost+"/?join=x" {
		t.Fatalf("http on the tunnel: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	// the host sees one unnamed guest per session until they name themselves
	if st := h.status(); st["unnamed"] != 2.0 || len(st["guests"].([]any)) != 0 {
		t.Errorf("status guests %v unnamed %v", st["guests"], st["unnamed"])
	}
	if code, m := g.postJSON("/__glow/guest/name", map[string]string{"name": "  Bea‮  \x07Lo​pez "}); code != 200 || m["name"] != "Bea Lopez" {
		t.Fatalf("name %d %v", code, m)
	}
	g2 := h.joined("bea lopez", "198.51.100.3")
	_, s2 := g2.getJSON("/__glow/guest/session")
	if n := s2["session"].(map[string]any)["guest"].(map[string]any)["name"]; n != "bea lopez (2)" {
		t.Errorf("same name twice: %v", n)
	}
	if code, m := g.postJSON("/__glow/guest/name", map[string]string{"name": "​‮"}); code != 400 || m["error"] != "bad-name" {
		t.Errorf("empty name %d %v", code, m)
	}
	if code, _ := g.postJSON("/__glow/guest/name", map[string]string{"name": strings.Repeat("x", 25)}); code != 400 {
		t.Errorf("long name %d", code)
	}
	st := h.status()
	if len(st["guests"].([]any)) != 2 || st["guests"].([]any)[0].(map[string]any)["online"] != true {
		t.Errorf("named guests %v", st["guests"])
	}
	// leaving ends the session
	if code, _ := g.postJSON("/__glow/guest/leave", map[string]any{}); code != 200 {
		t.Fatal("leave")
	}
	if code, _ := g.getJSON("/__glow/guest/session"); code != 401 {
		t.Errorf("session after leave %d", code)
	}
}

func TestGuestBadTokenRateLimit(t *testing.T) {
	logPath := captureLog(t)
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.newGuest("198.51.100.9")
	for i := 0; i < 10; i++ {
		if resp, m := g.join(fmt.Sprintf("wrong-%d", i)); resp.StatusCode != 403 || m["error"] != "bad-token" {
			t.Fatalf("try %d: %d %v", i, resp.StatusCode, m)
		}
	}
	resp, m := g.join(h.token())
	if resp.StatusCode != 429 || m["error"] != "too-many-attempts" || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("11th try with the right token: %d %v", resp.StatusCode, m)
	}
	// another address is not affected
	if resp, _ := h.newGuest("198.51.100.10").join(h.token()); resp.StatusCode != 200 {
		t.Fatalf("other ip %d", resp.StatusCode)
	}
	// more than 100 failures from everywhere pause joining for everyone
	for i := 0; i < 95; i++ {
		h.newGuest(fmt.Sprintf("203.0.113.%d", i)).join("wrong")
	}
	if resp, _ := h.newGuest("192.0.2.200").join(h.token()); resp.StatusCode != 429 {
		t.Fatalf("after a flood of wrong links: %d", resp.StatusCode)
	}
	logs, _ := os.ReadFile(logPath)
	if strings.Contains(string(logs), h.token()) || !strings.Contains(string(logs), "bad join token from 198.51.100.9 (10 in 10 min)") ||
		!strings.Contains(string(logs), "joining is paused") {
		t.Errorf("log:\n%s", logs)
	}
}

func TestGuestCSRFAndOrigin(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Cata", "198.51.100.20")
	name := func(hdr ...string) int {
		code, _ := g.postJSON("/__glow/guest/name", map[string]string{"name": "Cata"}, hdr...)
		return code
	}
	if c := name("X-Glow-CSRF", ""); c != 403 {
		t.Errorf("no CSRF header: %d", c)
	}
	if c := name("X-Glow-CSRF", "wrong"); c != 403 {
		t.Errorf("wrong CSRF header: %d", c)
	}
	if c := name("Origin", "http://evil.example"); c != 403 {
		t.Errorf("other origin: %d", c)
	}
	if c := name("Origin", "null"); c != 403 {
		t.Errorf("null origin: %d", c)
	}
	if c := name("Origin", "https://"+strings.TrimPrefix(g.base, "http://")); c != 403 {
		t.Errorf("https origin on http: %d", c)
	}
	if c := name("Sec-Fetch-Site", "cross-site"); c != 403 {
		t.Errorf("cross-site: %d", c)
	}
	if c := name("Sec-Fetch-Site", "same-site"); c != 403 {
		t.Errorf("same-site: %d", c)
	}
	if c := name(); c != 200 {
		t.Errorf("good request: %d", c)
	}
	// a session from another link period is not accepted (cookie of a stranger)
	other := h.newGuest("")
	other.csrf = g.csrf
	if code, _ := other.postJSON("/__glow/guest/name", map[string]string{"name": "X"}); code != 401 {
		t.Errorf("no cookie but the CSRF value: %d", code)
	}
}

// Nothing of the host is reachable from the friends' listener.
func TestGuestListenerOnlyServesFriendsPages(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Dan", "198.51.100.30")
	paths := []string{
		"/__glow/ping", "/__glow/version", "/__glow/quit", "/__glow/share/status", "/__glow/share/start", "/__glow/share/stop",
		"/__glow/share/new-link", "/__glow/share/settings", "/__glow/share/jobs/x/approve",
		"/__glow/comfy/prompt", "/__glow/comfy/queue", "/__glow/comfy/ws?clientId=x", "/__glow/comfy/view?filename=a.png&type=output",
		"/__glow/comfy/upload/image", "/__glow/comfy/history", "/__glow/comfy/interrupt", "/__glow/comfy/system_stats",
		"/engine.html", "/local-engine.js", "/share.js", "/qr.js", "/engine-ui.js", "/engine.css", "/glow/ai.js",
		"/../engine.html", "/%2e%2e/engine.html", "/./engine.html", "//engine.html", "/ai.js/../engine.html", "/AI.JS",
		"/__glow/guest/../engine/status", "/__glow/guest/%2e%2e/engine/status", "/__glow%2fengine/status", "/__glow/guest/jobs/../../engine/status",
		"/scenes.json/../../desktop/main.go", "/.git/config", "/index.html.bak", "/__glow/guest/", "/__glow/guest/session/../../share/status",
	}
	for _, n := range []string{"status", "install", "cancel", "start", "stop", "cleanup", "hold", "open-logs", "version", "quit"} {
		paths = append(paths, "/__glow/engine/"+n)
	}
	for _, p := range paths {
		for _, method := range []string{"GET", "POST"} {
			resp, body := g.req(method, p, strings.NewReader(`{"packs":["core"],"job":"g1"}`), "application/json")
			if resp.StatusCode < 400 || resp.StatusCode == 401 && !strings.HasPrefix(p, "/__glow/guest") {
				t.Errorf("%s %s -> %d %.80s", method, p, resp.StatusCode, body)
			}
			if bytes.Contains(body, []byte("installDir")) || bytes.Contains(body, []byte("queue_running")) || bytes.Contains(body, []byte("glow-studio\"")) && p != "/__glow/guest/hello" {
				t.Errorf("%s %s leaked host data: %.120s", method, p, body)
			}
		}
	}
	// Host header tricks: only the guest port's loopback names and the tunnel name
	for _, host := range []string{"evil.example", "127.0.0.1", "127.0.0.1:47821", strings.TrimPrefix(h.host, "http://"), "localhost.evil.example",
		"fake-share-test.trycloudflare.com.evil.example", "other.trycloudflare.com", fakeTunnelHost + ":8080"} {
		bad := h.newGuest("")
		bad.host = host
		if resp, _ := bad.req("GET", "/", nil, ""); resp.StatusCode != 421 {
			t.Errorf("Host %q -> %d", host, resp.StatusCode)
		}
	}
	// the host's own listener refuses the tunnel's name (DNS rebinding of the host API)
	req, _ := http.NewRequest("GET", h.host+"/__glow/share/status", nil)
	req.Host = fakeTunnelHost
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 403 {
		t.Errorf("host API with the tunnel's Host: %v %v", err, resp)
	}
	// static allowlist with types and headers
	g = h.newGuest("198.51.100.31") // (the requests above used up this address's burst)
	for name, ctype := range map[string]string{"ai.js": "text/javascript", "scenes.json": "application/json", "app.css": "text/css", "manifest.webmanifest": "application/manifest+json"} {
		resp, body := g.req("GET", "/"+name, nil, "")
		if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), ctype) || len(body) == 0 || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: %d %q", name, resp.StatusCode, resp.Header.Get("Content-Type"))
		}
	}
}

func TestGuestIndexInjection(t *testing.T) {
	app := testApp(t)
	page, csp, err := buildGuestIndex(app)
	if err != nil {
		t.Fatal(err)
	}
	s := string(page)
	for _, want := range []string{`<html lang="en" data-guest="1">`, `<script>window.GLOW_GUEST={"v":1}</script>`, `<script src="ai.js" defer></script>`} {
		if strings.Count(s, want) != 1 {
			t.Errorf("guest index has %q %d times", want, strings.Count(s, want))
		}
	}
	for _, gone := range []string{`src="local-engine.js"`, `src="share.js"`, `src="qr.js"`, "/__glow/ping"} {
		if strings.Contains(s, gone) {
			t.Errorf("guest index still has %s", gone)
		}
	}
	// the CSP allows exactly the inline scripts of the page
	n := 0
	for _, m := range regexp.MustCompile(`(?s)<script>(.*?)</script>`).FindAllStringSubmatch(s, -1) {
		sum := sha256.Sum256([]byte(m[1]))
		if !strings.Contains(csp, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'") {
			t.Errorf("CSP lacks the hash of %.40s", m[1])
		}
		n++
	}
	if n < 2 || strings.Contains(csp, "unsafe-inline' https://fonts.g") == false || strings.Contains(csp, "script-src 'self' 'unsafe") {
		t.Errorf("csp %q (%d inline scripts)", csp, n)
	}
	// each edit must match exactly once
	bad := testApp(t)
	m := bad.(fstest.MapFS)
	orig := string(m["index.html"].Data)
	m["index.html"].Data = []byte(strings.Replace(orig, "<head>", "<head><head>", 1))
	if _, _, err := buildGuestIndex(bad); err == nil {
		t.Error("two <head> accepted")
	}
	m["index.html"].Data = []byte(strings.Replace(orig, `<html lang="en">`, `<html>`, 1))
	if _, _, err := buildGuestIndex(bad); err == nil {
		t.Error("missing <html lang=en> accepted")
	}
	// served with the security headers
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.newGuest("")
	resp, body := g.req("GET", "/?join="+h.token(), nil, "")
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("GLOW_GUEST")) {
		t.Fatalf("index %d", resp.StatusCode)
	}
	for k, v := range map[string]string{"Content-Security-Policy": csp, "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
		"Cross-Origin-Opener-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "Permissions-Policy": "geolocation=(), microphone=(), camera=()"} {
		if resp.Header.Get(k) != v {
			t.Errorf("%s = %q", k, resp.Header.Get(k))
		}
	}
	// the real bundle (web team's index.html) builds too
	real, _ := fs.Sub(bundle, "glow")
	if _, _, err := buildGuestIndex(real); err != nil {
		t.Errorf("the embedded index.html: %v", err)
	}
}

// The main friend flow: plan, job, steps on the mock ComfyUI, labelled files, download, cleanup.
func TestGuestJobFlow(t *testing.T) {
	logPath := captureLog(t)
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Eva", "198.51.100.40")
	req := jobReq("club-exit-sing", 20, "ai", "beat", "best")
	req["tempo"] = nil
	plan := map[string]any{"v": 1, "sceneId": "club-exit-sing", "duration": 20, "sound": "ai", "sync": "beat", "quality": "best", "tempo": nil, "audio": false}
	code, pm := g.postJSON("/__glow/guest/plan", plan)
	if code != 200 {
		t.Fatalf("plan %d %v", code, pm)
	}
	p := pm["plan"].(map[string]any)
	if len(p["shots"].([]any)) != 4 || p["song"].(map[string]any)["seconds"] != 22.0 || p["sceneName"] == "" {
		t.Fatalf("plan %v", p)
	}
	if q := pm["queue"].(map[string]any); q["ahead"] != 0.0 {
		t.Errorf("queue %v", q)
	}
	selfie := testJPEG(600, 800, "GPS 12.3456 SECRET-EXIF")
	code, jm := g.submit(req, selfie, nil)
	if code != 202 {
		t.Fatalf("submit %d %v", code, jm)
	}
	job := jobOf(jm)
	id := job["id"].(string)
	if !guestJobRe.MatchString(id) || !regexp.MustCompile(`^[0-9A-Z]{5}-[0-9A-Z]{5}$`).MatchString(job["code"].(string)) {
		t.Fatalf("job %v", job)
	}
	h.waitJob(id, "done", "failed")
	code, jm = g.getJSON("/__glow/guest/jobs/" + id)
	job = jobOf(jm)
	if code != 200 || job["state"] != "done" || job["error"] != nil {
		t.Fatalf("job %d %v", code, jm)
	}
	files := job["files"].([]any)
	names := map[string]map[string]any{}
	for _, f := range files {
		fm := f.(map[string]any)
		names[fm["name"].(string)] = fm
	}
	for _, want := range []string{"still-0.png", "still-1.png", "still-2.png", "still-3.png", "clip-0.mp4", "clip-1.mp4", "clip-2.mp4", "clip-3.mp4", "song.mp4"} {
		if names[want] == nil || names[want]["bytes"].(float64) <= 0 {
			t.Errorf("file %s missing: %v", want, names[want])
		}
	}
	if c := names["clip-2.mp4"]; c["fps"] != 16.0 || c["width"] != 480.0 {
		t.Errorf("lip-sync clip %v", c)
	}
	// every prompt: our client id, never "front", a fresh prompt id, the allowlist, the label
	prompts := h.comfy.guestPrompts()
	if len(prompts) != 9 {
		t.Fatalf("%d prompts", len(prompts))
	}
	seen := map[string]bool{}
	for _, pr := range prompts {
		if pr.ClientID != "glowshare" || pr.Raw["front"] != nil || seen[pr.ID] || !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(pr.ID) {
			t.Errorf("prompt %s client %s %v", pr.ID, pr.ClientID, pr.Raw["front"])
		}
		seen[pr.ID] = true
		out := ""
		for _, nid := range []string{"17", "19", "96", "93"} { // (an I2V graph has a "17" too: FrameInterpolate)
			if _, ok := pr.Graph[nid]; ok {
				out = nid
			}
		}
		if err := assertGuestGraph(pr.Graph, id, out); err != nil {
			t.Errorf("graph refused: %v", err)
		}
		b, _ := json.Marshal(pr.Graph)
		if bytes.Contains(b, []byte("Eva")) {
			t.Error("the friend's name reached ComfyUI")
		}
	}
	// the selfie ComfyUI got was re-encoded by the launcher: no EXIF
	h.comfy.mu.Lock()
	up := h.comfy.uploads["selfie_"+id+".jpg"]
	labels := 0
	for n := range h.comfy.uploads {
		if strings.HasPrefix(n, "glowlabel_") {
			labels++
		}
	}
	h.comfy.mu.Unlock()
	if up == nil || bytes.Contains(up, []byte("SECRET-EXIF")) || bytes.Contains(up, []byte("Exif")) || labels != 4 {
		t.Fatalf("selfie upload %d bytes, %d labels", len(up), labels)
	}
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(up)); err != nil || cfg.Width != 600 {
		t.Errorf("selfie %v %v", cfg, err)
	}
	// download: only the labelled files, streamed
	resp, body := g.req("GET", "/__glow/guest/jobs/"+id+"/files/clip-0.mp4", nil, "")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "video/mp4" || !bytes.Contains(body, []byte("_s0_clip")) {
		t.Fatalf("download %d %q %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	resp, body = g.req("GET", "/__glow/guest/jobs/"+id+"/files/still-1.png", nil, "")
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("_s1_stillL")) {
		t.Fatalf("labelled still %d %q", resp.StatusCode, body)
	}
	resp, body = g.req("GET", "/__glow/guest/jobs/"+id+"/files/song.mp4", nil, "")
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("_songL")) {
		t.Fatalf("song carrier %d %q", resp.StatusCode, body)
	}
	for _, bad := range []string{"still-9.png", "../../x", "raw.png", "song.mp3", "still-0.png/../clip-0.mp4"} {
		if resp, _ := g.req("GET", "/__glow/guest/jobs/"+id+"/files/"+bad, nil, ""); resp.StatusCode != 404 {
			t.Errorf("file %q -> %d", bad, resp.StatusCode)
		}
	}
	// another guest cannot see or fetch it
	other := h.joined("Fede", "198.51.100.41")
	if code, _ := other.getJSON("/__glow/guest/jobs/" + id); code != 404 {
		t.Errorf("other guest sees the job: %d", code)
	}
	if resp, _ := other.req("GET", "/__glow/guest/jobs/"+id+"/files/clip-0.mp4", nil, ""); resp.StatusCode != 404 {
		t.Errorf("other guest downloads: %d", resp.StatusCode)
	}
	if code, cur := g.getJSON("/__glow/guest/jobs/current"); code != 200 || jobOf(cur)["id"] != id {
		t.Errorf("current %v", cur)
	}
	// done: files and history go
	if len(h.comfy.files("output")) == 0 {
		t.Fatal("no outputs on disk")
	}
	if code, _ := g.postJSON("/__glow/guest/jobs/"+id+"/done", map[string]any{}); code != 200 {
		t.Fatal("done")
	}
	waitFor(t, 5*time.Second, func() bool {
		h.comfy.mu.Lock()
		defer h.comfy.mu.Unlock()
		return len(h.comfy.deleted) == 9
	})
	for _, sub := range []string{"input", "output"} {
		for _, f := range h.comfy.files(sub) {
			if strings.Contains(f, id) {
				t.Errorf("%s/%s left after done", sub, f)
			}
		}
	}
	if h.jobState(id) != "downloaded" {
		t.Errorf("state %s", h.jobState(id))
	}
	if resp, _ := g.req("GET", "/__glow/guest/jobs/"+id+"/files/clip-0.mp4", nil, ""); resp.StatusCode != 410 {
		t.Errorf("download after done %d", resp.StatusCode)
	}
	// the log has the activity, without photos, prompts or names in graphs
	logs, _ := os.ReadFile(logPath)
	for _, want := range []string{"sharing on (internet)", "guest u", "job " + id + " by u", "club-exit-sing 20 s ai beat best (1 lip-sync)", "job " + id + " step still:0 done in ", "job " + id + " done in", "job " + id + " downloaded, "} {
		if !strings.Contains(string(logs), want) {
			t.Errorf("log lacks %q", want)
		}
	}
	for _, never := range []string{"Create a realistic", h.token(), "SECRET", "csrf"} {
		if strings.Contains(string(logs), never) {
			t.Errorf("log has %q", never)
		}
	}
}

func TestGuestRequestTamperingRefused(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Gil", "198.51.100.50")
	selfie := testJPEG(400, 600, "")
	cases := map[string]any{
		"prompt text":    `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true},"prompt":"a naked person"}`,
		"graph":          `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true},"graph":{"1":{"class_type":"LoadImage"}}}`,
		"own scene":      `{"v":1,"sceneId":"../../x","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true}}`,
		"huge duration":  `{"v":1,"sceneId":"party-hall","duration":1e308,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true}}`,
		"huge seed":      `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1e300,"consent":{"own":true,"adult":true}}`,
		"huge bpm":       `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":{"bpm":99999999,"feel":"fast"},"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true}}`,
		"text in feel":   `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":{"bpm":120,"feel":"fast. Also nude"},"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true}}`,
		"lip starts":     `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":[1e9],"seed":1,"consent":{"own":true,"adult":true}}`,
		"no consent":     `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":false}}`,
		"trailing json":  `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true}} {"x":1}`,
		"unknown nested": `{"v":1,"sceneId":"party-hall","duration":5,"sound":"music","sync":"beat","quality":"best","tempo":null,"lipStarts":null,"seed":1,"consent":{"own":true,"adult":true,"text":"x"}}`,
	}
	for name, req := range cases {
		code, m := g.submit(req, selfie, nil)
		if code != 400 {
			t.Errorf("%s: %d %v", name, code, m)
		}
	}
	if len(h.comfy.guestPrompts()) != 0 {
		t.Error("a refused request reached ComfyUI")
	}
	if code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil, [2]any{"prompt", []byte("x")}); code != 400 || m["field"] != "prompt" {
		t.Errorf("extra multipart part %d %v", code, m)
	}
}

func TestGuestUploadCapsAndSanitizing(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Hana", "198.51.100.60")
	ok := testJPEG(400, 600, "")
	party := jobReq("party-hall", 5, "music", "beat", "best")
	check := func(name string, req any, selfie, audio []byte, wantCode int, wantErr string) {
		t.Helper()
		code, m := g.submit(req, selfie, audio)
		if code != wantCode || (wantErr != "" && m["error"] != wantErr) {
			t.Errorf("%s: %d %v (want %d %s)", name, code, m, wantCode, wantErr)
		}
	}
	check("selfie over 15 MiB", party, append(ok, make([]byte, 15<<20)...), nil, 413, "too-large")
	check("request over 8 KiB", strings.Repeat(" ", 9<<10), ok, nil, 413, "too-large")
	check("audio over 20 MiB", jobReq("club", 20, "own", "lips", "best"), ok, make([]byte, 21<<20), 413, "too-large")
	check("not an image", party, []byte("GIF89a......................"), nil, 415, "unsupported-type")
	check("tiny image", party, testJPEG(100, 100, ""), nil, 400, "bad-photo")
	check("too wide", party, pngHeaderOnly(7000, 200), nil, 400, "bad-photo")
	check("decompression bomb", party, pngHeaderOnly(6000, 6000), nil, 400, "bad-photo")
	check("broken jpeg", party, append(ok[:200:200], make([]byte, 100)...), nil, 400, "bad-photo")
	check("no selfie", party, nil, nil, 400, "bad-photo")
	// own song lip-sync: the WAV must be mono 16-bit PCM, 5-30 s, long enough
	own := jobReq("club", 20, "own", "lips", "best")
	own["lipStarts"] = []any{0, 4.813, 9.625, 14.438}
	check("stereo", own, ok, testWAV(44100, 2, 16, 20), 400, "bad-audio")
	check("8-bit", own, ok, testWAV(44100, 1, 8, 20), 400, "bad-audio")
	check("rate", own, ok, testWAV(96000, 1, 16, 20), 400, "bad-audio")
	check("too short for the last shot", own, ok, testWAV(16000, 1, 16, 18), 400, "bad-audio")
	check("too long", own, ok, testWAV(16000, 1, 16, 31), 400, "bad-audio")
	check("not a wav", own, ok, []byte("ID3......"), 400, "bad-audio")
	check("audio for a video without lip-sync", party, ok, testWAV(16000, 1, 16, 20), 400, "unexpected-audio")
	if len(h.comfy.guestPrompts()) != 0 {
		t.Fatal("a refused upload reached ComfyUI")
	}
	// a good one: the WAV is rewritten with a plain header (the LIST chunk is gone)
	code, m := g.submit(own, ok, testWAV(16000, 1, 16, 20))
	if code != 202 {
		t.Fatalf("own song job %d %v", code, m)
	}
	id := jobOf(m)["id"].(string)
	h.waitJob(id, "done", "failed")
	h.comfy.mu.Lock()
	wav := h.comfy.uploads["audio_"+id+".wav"]
	h.comfy.mu.Unlock()
	if len(wav) != 44+16000*2*20 || bytes.Contains(wav, []byte("LIST")) {
		t.Errorf("wav %d bytes", len(wav))
	}
	var trims []any
	for _, p := range h.comfy.guestPrompts() {
		if n, ok := p.Graph["3"].(map[string]any); ok && n["class_type"] == "TrimAudioDuration" {
			trims = append(trims, n["inputs"].(map[string]any)["start_index"])
		}
	}
	if fmt.Sprint(trims) != "[0 4.81 9.63 14.44]" {
		t.Errorf("lip-sync offsets %v", trims)
	}
}

func TestGuestLimits(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", map[string]any{"dailyLimit": 2, "approve": true})
	g := h.joined("Ida", "198.51.100.70")
	selfie := testJPEG(300, 400, "")
	code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
	if code != 202 || jobOf(m)["state"] != "waiting-approval" {
		t.Fatalf("first %d %v", code, m)
	}
	first := jobOf(m)["id"].(string)
	if code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil); code != 409 || m["error"] != "active-job" {
		t.Fatalf("second while active %d %v", code, m)
	}
	// declined: refunded
	if code, _ := h.hostDo("POST", "/__glow/share/jobs/"+first+"/decline", map[string]any{}); code != 200 {
		t.Fatal("decline")
	}
	_, s := g.getJSON("/__glow/guest/session")
	if lim := s["session"].(map[string]any)["limits"].(map[string]any); lim["usedToday"] != 0.0 {
		t.Fatalf("after decline %v", lim)
	}
	for i := 0; i < 2; i++ {
		code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
		if code != 202 {
			t.Fatalf("job %d: %d %v", i, code, m)
		}
		id := jobOf(m)["id"].(string)
		h.hostDo("POST", "/__glow/share/jobs/"+id+"/approve", map[string]any{})
		h.waitJob(id, "done")
		g.postJSON("/__glow/guest/jobs/"+id+"/done", map[string]any{})
	}
	code, m = g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
	if code != 429 || m["error"] != "daily-limit" || m["resetAt"] == nil {
		t.Fatalf("over the limit %d %v", code, m)
	}
	// a new day
	h.s.mu.Lock()
	h.s.dayOffset += 24 * time.Hour
	h.s.mu.Unlock()
	code, m = g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
	if code != 202 {
		t.Fatalf("next day %d %v", code, m)
	}
	id := jobOf(m)["id"].(string)
	// host cancel: refunded; guest cancel before start: refunded
	h.hostDo("POST", "/__glow/share/jobs/"+id+"/cancel", map[string]any{})
	if h.jobState(id) != "cancelled" {
		t.Fatalf("host cancel: %s", h.jobState(id))
	}
	code, m = g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
	id = jobOf(m)["id"].(string)
	if code, _ := g.postJSON("/__glow/guest/jobs/"+id+"/cancel", map[string]any{}); code != 200 || h.jobState(id) != "cancelled" {
		t.Fatalf("guest cancel %s", h.jobState(id))
	}
	_, s = g.getJSON("/__glow/guest/session")
	if lim := s["session"].(map[string]any)["limits"].(map[string]any); lim["usedToday"] != 0.0 || lim["left"] != 2.0 {
		t.Errorf("after cancels %v", lim)
	}
	// queue cap: 8 waiting at most
	var guests []*guestClient
	for i := 0; i < 9; i++ {
		guests = append(guests, h.joined(fmt.Sprintf("Q%d", i), fmt.Sprintf("192.0.2.%d", i+1)))
	}
	for i, gg := range guests {
		code, m := gg.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
		if i < 8 && code != 202 {
			t.Fatalf("queued %d: %d %v", i, code, m)
		}
		if i == 8 && (code != 503 || m["error"] != "queue-full") {
			t.Fatalf("9th waiting job %d %v", code, m)
		}
	}
	// 12 named guests at most
	for i := 0; ; i++ {
		gg := h.newGuest(fmt.Sprintf("192.0.2.%d", 100+i))
		gg.join(h.token())
		code, m := gg.postJSON("/__glow/guest/name", map[string]string{"name": fmt.Sprintf("N%d", i)})
		if code == 409 {
			if m["error"] != "full" {
				t.Fatal(m)
			}
			break
		}
		if i > 12 {
			t.Fatal("more than 12 named guests")
		}
	}
	if n := len(h.status()["guests"].([]any)); n != 12 {
		t.Errorf("%d named guests", n)
	}
}

func TestGuestQueueOrderApprovalAndThumb(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", map[string]any{"approve": true})
	selfie := testJPEG(900, 1200, "")
	var ids []string
	var gs []*guestClient
	for i := 0; i < 3; i++ {
		g := h.joined(fmt.Sprintf("P%d", i), fmt.Sprintf("192.0.2.%d", 50+i))
		code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), selfie, nil)
		if code != 202 {
			t.Fatal(code, m)
		}
		j := jobOf(m)
		if q := j["queue"].(map[string]any); q["ahead"] != float64(i) {
			t.Errorf("job %d ahead %v", i, q["ahead"])
		}
		ids = append(ids, j["id"].(string))
		gs = append(gs, g)
	}
	_, m := gs[2].getJSON("/__glow/guest/jobs/" + ids[2])
	q := jobOf(m)["queue"].(map[string]any)
	start, done := q["startMin"].([]any), q["doneMin"].([]any)
	if start[0].(float64) < 2 || done[0].(float64) <= start[0].(float64) {
		t.Errorf("waits %v %v", start, done)
	}
	st := h.status()
	jobs := st["jobs"].([]any)
	if len(jobs) != 3 || jobs[0].(map[string]any)["thumb"] != true || jobs[1].(map[string]any)["position"] != 2.0 {
		t.Fatalf("host jobs %v", jobs)
	}
	// the thumbnail: 160 px JPEG, only while waiting
	resp, err := http.Get(h.host + "/__glow/share/jobs/" + ids[0] + "/thumb")
	if err != nil || resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("thumb %v %v", err, resp)
	}
	tb, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(tb)); err != nil || cfg.Height != 160 || cfg.Width != 120 {
		t.Errorf("thumb %v %v", cfg, err)
	}
	// nothing runs before approval; approving the second one first runs it first
	time.Sleep(100 * time.Millisecond)
	if len(h.comfy.guestPrompts()) != 0 {
		t.Fatal("a job ran without approval")
	}
	h.hostDo("POST", "/__glow/share/jobs/"+ids[1]+"/approve", map[string]any{})
	h.waitJob(ids[1], "done")
	if h.jobState(ids[0]) != "waiting-approval" {
		t.Fatalf("first job %s", h.jobState(ids[0]))
	}
	// both approved while the host makes a video: when it is done, FIFO by acceptance
	h.fe.set(func(f *fakeEngine) { f.busy = true })
	h.hostDo("POST", "/__glow/share/jobs/"+ids[2]+"/approve", map[string]any{})
	h.hostDo("POST", "/__glow/share/jobs/"+ids[0]+"/approve", map[string]any{})
	time.Sleep(60 * time.Millisecond)
	h.fe.set(func(f *fakeEngine) { f.busy = false })
	h.waitJob(ids[0], "done")
	h.waitJob(ids[2], "done")
	// FIFO by acceptance among approved jobs: job 0 (accepted first) before job 2
	order := []string{}
	for _, p := range h.comfy.guestPrompts() {
		for _, id := range ids {
			b, _ := json.Marshal(p.Graph)
			if bytes.Contains(b, []byte(id)) && (len(order) == 0 || order[len(order)-1] != id) {
				order = append(order, id)
			}
		}
	}
	if fmt.Sprint(order) != fmt.Sprint([]string{ids[1], ids[0], ids[2]}) {
		t.Errorf("run order %v, want %v", order, []string{ids[1], ids[0], ids[2]})
	}
	if resp, _ := http.Get(h.host + "/__glow/share/jobs/" + ids[0] + "/thumb"); resp.StatusCode != 404 {
		t.Errorf("thumb after approval %d", resp.StatusCode)
	}
}

func TestGuestBlockAndNewLink(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	h.comfy.delay = 300 * time.Millisecond
	g := h.joined("Jo", "198.51.100.80")
	code, m := g.submit(jobReq("party-hall", 20, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	if code != 202 {
		t.Fatal(code, m)
	}
	id := jobOf(m)["id"].(string)
	h.waitJob(id, "running")
	waitFor(t, 5*time.Second, func() bool { return len(h.comfy.guestPrompts()) > 0 })
	_, sm := g.getJSON("/__glow/guest/session")
	gid := sm["session"].(map[string]any)["guest"].(map[string]any)["id"].(string)
	if code, _ := h.hostDo("POST", "/__glow/share/guests/"+gid+"/block", map[string]any{"blocked": true}); code != 200 {
		t.Fatal("block")
	}
	if h.jobState(id) != "cancelled" {
		t.Fatalf("job after block: %s", h.jobState(id))
	}
	if code, m := g.getJSON("/__glow/guest/session"); code != 403 || m["error"] != "blocked" {
		t.Fatalf("blocked session %d %v", code, m)
	}
	if resp, m := g.join(h.token()); resp.StatusCode != 403 || m["error"] != "blocked" {
		t.Fatalf("blocked re-join %d %v", resp.StatusCode, m)
	}
	waitFor(t, 5*time.Second, func() bool {
		h.comfy.mu.Lock()
		defer h.comfy.mu.Unlock()
		return len(h.comfy.intr) > 0
	})
	waitFor(t, 5*time.Second, func() bool {
		for _, sub := range []string{"input", "output"} {
			for _, f := range h.comfy.files(sub) {
				if strings.Contains(f, id) {
					return false
				}
			}
		}
		return true
	})
	if st := h.status(); st["guests"].([]any)[0].(map[string]any)["blocked"] != true {
		t.Errorf("status %v", st["guests"])
	}
	// new link: the old token stops working, connected guests keep their session
	other := h.joined("Kim", "198.51.100.81")
	old := h.token()
	if code, _ := h.hostDo("POST", "/__glow/share/new-link", map[string]any{}); code != 200 {
		t.Fatal("new link")
	}
	if h.token() == old {
		t.Fatal("same token")
	}
	if resp, m := h.newGuest("198.51.100.82").join(old); resp.StatusCode != 403 || m["error"] != "bad-token" {
		t.Errorf("old link %d %v", resp.StatusCode, m)
	}
	if resp, _ := h.newGuest("198.51.100.83").join(h.token()); resp.StatusCode != 200 {
		t.Errorf("new link %d", resp.StatusCode)
	}
	if code, _ := other.getJSON("/__glow/guest/session"); code != 200 {
		t.Errorf("connected guest after new link %d", code)
	}
	if link, _ := h.status()["link"].(string); link != "https://"+fakeTunnelHost+"/?join="+h.token() {
		t.Errorf("link %q", link)
	}
}

// Resume code: after the link changed (new origin, new session) a friend claims their job.
func TestGuestClaimWithResumeCode(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Lu", "198.51.100.90")
	code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	if code != 202 {
		t.Fatal(code, m)
	}
	id, rc := jobOf(m)["id"].(string), jobOf(m)["code"].(string)
	h.waitJob(id, "done")
	h.hostDo("POST", "/__glow/share/new-link", map[string]any{})
	n := h.newGuest("198.51.100.91")
	n.join(h.token())
	if code, m := n.postJSON("/__glow/guest/claim", map[string]string{"code": "AAAAA-AAAAA"}); code != 404 || m["error"] != "bad-code" {
		t.Fatalf("bad code %d %v", code, m)
	}
	code, m = n.postJSON("/__glow/guest/claim", map[string]string{"code": strings.ToLower(rc)})
	if code != 200 || jobOf(m)["id"] != id || jobOf(m)["code"] == rc {
		t.Fatalf("claim %d %v", code, m)
	}
	if code, _ := n.getJSON("/__glow/guest/jobs/" + id); code != 200 {
		t.Error("claimed job not visible")
	}
	if code, _ := g.getJSON("/__glow/guest/jobs/" + id); code != 404 {
		t.Error("the old session still owns it")
	}
	// one-time
	if code, _ := h.newGuest("198.51.100.92").postJSON("/__glow/guest/claim", map[string]string{"code": rc}); code != 401 && code != 404 {
		t.Errorf("reuse %d", code)
	}
	_, s := n.getJSON("/__glow/guest/session")
	if s["session"].(map[string]any)["guest"].(map[string]any)["name"] != "Lu" {
		t.Errorf("the name came along: %v", s)
	}
	// wrong codes count as failures
	for i := 0; i < 10; i++ {
		n.postJSON("/__glow/guest/claim", map[string]string{"code": fmt.Sprintf("ZZZZZ-ZZZZ%d", i)})
	}
	if code, _ := n.postJSON("/__glow/guest/claim", map[string]string{"code": "ZZZZZ-ZZZZZ"}); code != 429 {
		t.Errorf("after 10 wrong codes %d", code)
	}
}

// Host first, at step granularity.
func TestShareHostPriority(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Mo", "198.51.100.100")
	// the host's page holds a fresh video: friends wait
	h.fe.set(func(f *fakeEngine) { f.busy, f.eta = true, [2]float64{3, 6} })
	code, m := g.submit(jobReq("party-hall", 10, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	if code != 202 {
		t.Fatal(code, m)
	}
	id := jobOf(m)["id"].(string)
	if q := jobOf(m)["queue"].(map[string]any); q["hostBusy"] != true || q["startMin"].([]any)[0].(float64) < 3 {
		t.Errorf("queue while the host makes a video %v", q)
	}
	time.Sleep(150 * time.Millisecond)
	if h.jobState(id) != "queued" {
		t.Fatalf("ran while the host was busy: %s", h.jobState(id))
	}
	// a host prompt in ComfyUI's queue: friends wait too
	h.fe.set(func(f *fakeEngine) { f.busy = false })
	h.comfy.addHost("host-1")
	time.Sleep(150 * time.Millisecond)
	if h.jobState(id) != "queued" {
		t.Fatalf("ran while a host prompt was queued: %s", h.jobState(id))
	}
	h.comfy.finishHost("host-1")
	h.waitJob(id, "running")
	// while a friend's step runs, the host posts a prompt: the friend's step
	// finishes, the next waits for the host's
	waitFor(t, 5*time.Second, func() bool { return len(h.comfy.guestPrompts()) == 1 })
	h.comfy.mu.Lock()
	h.comfy.delay = 200 * time.Millisecond
	h.comfy.mu.Unlock()
	h.comfy.addHost("host-2")
	time.Sleep(400 * time.Millisecond)
	if n := len(h.comfy.guestPrompts()); n != 1 {
		t.Fatalf("%d friend steps while the host prompt waits", n)
	}
	if j := h.job(id); j.progress == nil || !j.progress.HostBusy {
		t.Errorf("progress %+v", h.job(id).progress)
	}
	if note := h.status()["hostPriorityNote"]; note == nil || !strings.Contains(note.(string), "step") {
		t.Errorf("host note %v", note)
	}
	h.comfy.finishHost("host-2")
	h.waitJob(id, "done")
	h.comfy.mu.Lock()
	h.comfy.delay = 40 * time.Millisecond
	h.comfy.mu.Unlock()
}

// The engine starts for a friend's job; a step that runs out of memory gets one retry.
func TestShareEngineStartAndRetry(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	h.fe.set(func(f *fakeEngine) { f.state = "stopped" })
	h.comfy.mu.Lock()
	h.comfy.failOnce["_s0_clip"] = "CUDA out of memory"
	h.comfy.mu.Unlock()
	g := h.joined("Nia", "198.51.100.110")
	code, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	if code != 202 {
		t.Fatal(code, m)
	}
	id := jobOf(m)["id"].(string)
	h.waitJob(id, "done", "failed")
	if h.jobState(id) != "done" || h.fe.starts != 1 {
		t.Fatalf("state %s, starts %d", h.jobState(id), h.fe.starts)
	}
	var prefixes []string
	for _, p := range h.comfy.guestPrompts() {
		if n, ok := p.Graph["19"].(map[string]any); ok {
			prefixes = append(prefixes, n["inputs"].(map[string]any)["filename_prefix"].(string))
		}
	}
	if len(prefixes) != 2 || !strings.HasSuffix(prefixes[1], "_s0_r1_clip") {
		t.Errorf("retry prefixes %v", prefixes)
	}
	// a refused graph or an engine in error fails the job, refunded
	h.comfy.mu.Lock()
	h.comfy.refuse = true
	h.comfy.mu.Unlock()
	g.postJSON("/__glow/guest/jobs/"+id+"/done", map[string]any{})
	code, m = g.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	id2 := jobOf(m)["id"].(string)
	h.waitJob(id2, "failed")
	_, jm := g.getJSON("/__glow/guest/jobs/" + id2)
	if e := jobOf(jm)["error"].(map[string]any); e["code"] != "engine" || !strings.Contains(e["message"].(string), "Ana's PC") {
		t.Errorf("error %v", e)
	}
	_, s := g.getJSON("/__glow/guest/session")
	if s["session"].(map[string]any)["limits"].(map[string]any)["usedToday"] != 1.0 {
		t.Errorf("a failed job counted: %v", s["session"].(map[string]any)["limits"])
	}
}

func TestShareClosingAndStop(t *testing.T) {
	h := newShareHarness(t)
	h.s.autoStop = 400 * time.Millisecond
	h.s.closeGrace = 300 * time.Millisecond
	h.start("internet", nil)
	h.comfy.mu.Lock()
	h.comfy.delay = 250 * time.Millisecond // job a: 4 steps, longer than the auto-stop
	h.comfy.mu.Unlock()
	a := h.joined("Ola", "198.51.100.120")
	b := h.joined("Pia", "198.51.100.121")
	_, ma := a.submit(jobReq("party-hall", 10, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	_, mb := b.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	ia, ib := jobOf(ma)["id"].(string), jobOf(mb)["id"].(string)
	h.waitJob(ia, "running")
	if busy, why := h.s.BusyReason(); !busy || !strings.Contains(why, "sharing with friends is on") {
		t.Errorf("busy %v %q", busy, why)
	}
	// auto-stop: closing; the waiting job is cancelled (refunded), the running one finishes
	waitFor(t, 5*time.Second, func() bool { return h.status()["state"] == "closing" })
	if h.jobState(ib) != "cancelled" {
		t.Fatalf("queued job at closing: %s", h.jobState(ib))
	}
	if busy, why := h.s.BusyReason(); !busy || why != "finishing a friend's video" {
		t.Errorf("busy while closing %v %q", busy, why)
	}
	if resp, m := h.newGuest("198.51.100.122").join(h.token()); resp.StatusCode != 503 || m["error"] != "not-accepting" {
		t.Errorf("join while closing %d %v", resp.StatusCode, m)
	}
	if code, m := b.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 503 || m["error"] != "not-accepting" {
		t.Errorf("job while closing %d %v", code, m)
	}
	h.waitJob(ia, "done")
	// the link stays until the friend has the video
	time.Sleep(100 * time.Millisecond)
	if h.status()["state"] != "closing" {
		t.Fatal("closed before the friend downloaded")
	}
	if resp, _ := a.req("GET", "/__glow/guest/jobs/"+ia+"/files/clip-0.mp4", nil, ""); resp.StatusCode != 200 {
		t.Fatalf("download while closing %d", resp.StatusCode)
	}
	a.postJSON("/__glow/guest/jobs/"+ia+"/done", map[string]any{})
	waitFor(t, 5*time.Second, func() bool { return h.status()["state"] == "off" })
	if busy, _ := h.s.BusyReason(); busy {
		t.Error("busy after off")
	}
	if _, err := http.Get(a.base + "/"); err == nil {
		t.Error("the friends' page still answers after off")
	}
	// started again: a fresh period; Stop now ends everything at once
	h.s.autoStop = time.Hour
	h.start("internet", nil)
	c := h.joined("Quin", "198.51.100.123")
	h.comfy.mu.Lock()
	h.comfy.delay = time.Second
	h.comfy.mu.Unlock()
	_, mc := c.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	ic := jobOf(mc)["id"].(string)
	before := len(h.comfy.guestPrompts())
	h.waitJob(ic, "running")
	waitFor(t, 5*time.Second, func() bool { return len(h.comfy.guestPrompts()) > before })
	if code, st := h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true}); code != 200 || st["state"] != "off" {
		t.Fatalf("stop now %d %v", code, st["state"])
	}
	for _, sub := range []string{"input", "output"} {
		for _, f := range h.comfy.files(sub) {
			if strings.HasPrefix(f, "gq-") || strings.HasPrefix(f, "selfie_gq-") {
				t.Errorf("%s/%s left after stop", sub, f)
			}
		}
	}
	h.comfy.mu.Lock()
	intr := len(h.comfy.intr)
	h.comfy.mu.Unlock()
	if intr == 0 {
		t.Error("the running step was not interrupted")
	}
	// grace: a done job nobody downloads closes after closeGrace
	h.comfy.mu.Lock()
	h.comfy.delay = 20 * time.Millisecond
	h.comfy.mu.Unlock()
	h.start("internet", nil)
	d := h.joined("Rui", "198.51.100.124")
	_, md := d.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	h.waitJob(jobOf(md)["id"].(string), "done")
	h.hostDo("POST", "/__glow/share/stop", map[string]any{})
	if h.status()["state"] != "closing" {
		t.Fatal("not closing")
	}
	waitFor(t, 5*time.Second, func() bool { return h.status()["state"] == "off" })
}

// While sharing is on, the launcher neither idles out nor lets an update replace it.
func TestShareKeepsLauncherRunning(t *testing.T) {
	sh := newShareHarness(t)
	h := newHarness(t)
	h.e.shareBusy = sh.s.BusyReason
	if busy, _ := h.e.BusyReason(); busy {
		t.Fatal("busy before sharing")
	}
	sh.start("internet", nil)
	busy, why := h.e.BusyReason()
	if !busy || !strings.Contains(why, "sharing with friends") {
		t.Fatalf("BusyReason %v %q", busy, why)
	}
	if exit, _ := idleDecision(time.Now(), time.Now().Add(-2*time.Hour), time.Now().Add(-2*time.Hour), 30*time.Minute, busy); exit {
		t.Error("idle exit while sharing")
	}
	old := quitApp
	quitApp = func(string) { t.Error("quit while sharing") }
	defer func() { quitApp = old }()
	if code, out := h.do("POST", "/__glow/quit", map[string]string{"version": "9.0.0"}); code != 409 || out["busy"] != true {
		t.Errorf("quit while sharing: %d %v", code, out)
	}
	if code, out := h.do("GET", "/__glow/version", nil); code != 200 || out["busy"] != true || out["version"] != "1.4.0" {
		t.Errorf("version %v", out)
	}
	sh.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	if busy, _ := h.e.BusyReason(); busy {
		t.Error("busy after stop")
	}
}

func TestShareHostAPIAndSettings(t *testing.T) {
	h := newShareHarness(t)
	if code, st := h.hostDo("GET", "/__glow/share/status", nil); code != 200 || st["state"] != "off" || st["link"] != nil {
		t.Fatalf("status %v", st)
	}
	if code, m := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "‮"}); code != 400 || m["error"] != "bad-name" {
		t.Errorf("bad host name %d %v", code, m)
	}
	if code, m := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "Ana", "autoStopHours": 5}); code != 400 {
		t.Errorf("5 hours %d %v", code, m)
	}
	if code, m := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "Ana", "dailyLimit": 50}); code != 400 {
		t.Errorf("daily 50 %d %v", code, m)
	}
	h.fe.set(func(f *fakeEngine) { f.core = false })
	if code, m := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "Ana"}); code != 409 || m["error"] != "not-installed" {
		t.Errorf("without the engine %d %v", code, m)
	}
	h.fe.set(func(f *fakeEngine) { f.core = true })
	st := h.start("internet", map[string]any{"dailyLimit": 3, "approve": true, "autoStopHours": 1})
	if code, m := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "Ana"}); code != 409 || m["error"] != "already-on" {
		t.Errorf("start twice %d %v", code, m)
	}
	stops, _ := time.Parse(time.RFC3339, st["stopsAt"].(string))
	if d := time.Until(stops); d < 55*time.Minute || d > 61*time.Minute {
		t.Errorf("stops in %s", d)
	}
	if st["linkReady"] != true || st["tunnel"].(map[string]any)["state"] != "ready" || st["settings"].(map[string]any)["dailyLimit"] != 3.0 {
		t.Errorf("status %v", st)
	}
	if code, st := h.hostDo("POST", "/__glow/share/settings", map[string]any{"autoStopHours": 12, "approve": false}); code != 200 || st["settings"].(map[string]any)["approve"] != false {
		t.Errorf("settings %d %v", code, st)
	}
	if code, m := h.hostDo("POST", "/__glow/share/settings", map[string]any{"token": "x"}); code != 400 {
		t.Errorf("unknown setting %d %v", code, m)
	}
	// persisted without secrets
	waitFor(t, 3*time.Second, func() bool {
		b, err := os.ReadFile(h.s.settingsPath)
		return err == nil && strings.Contains(string(b), `"autoStopHours": 12`)
	})
	b, _ := os.ReadFile(h.s.settingsPath)
	if strings.Contains(string(b), h.token()) || !strings.Contains(string(b), `"hostName": "Ana"`) {
		t.Errorf("share.json %s", b)
	}
	if filepath.Base(h.s.settingsPath) != "share.json" {
		t.Error(h.s.settingsPath)
	}
	s2 := newShare(h.fe, testApp(t))
	if s2.settings.AutoStopHours != 12 || s2.settings.HostName != "Ana" || s2.state != "off" {
		t.Errorf("reloaded %+v", s2.settings)
	}
	// the host API only on the host's listener, behind the guard
	req, _ := http.NewRequest("POST", h.host+"/__glow/share/stop", strings.NewReader(`{}`))
	req.Header.Set("Origin", "http://evil.example")
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 403 {
		t.Errorf("cross-origin stop %d", resp.StatusCode)
	}
	if code, _ := h.hostDo("GET", "/__glow/share/stop", nil); code != 405 {
		t.Errorf("GET stop %d", code)
	}
}

func TestShareJobExpiry(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	g := h.joined("Sol", "198.51.100.130")
	_, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	id := jobOf(m)["id"].(string)
	h.waitJob(id, "done")
	h.s.mu.Lock()
	h.s.jobs[id].expiresAt = time.Now().Add(-time.Second)
	h.s.mu.Unlock()
	h.waitJob(id, "expired")
	waitFor(t, 5*time.Second, func() bool {
		for _, f := range h.comfy.files("output") {
			if strings.Contains(f, id) {
				return false
			}
		}
		return true
	})
	if resp, _ := g.req("GET", "/__glow/guest/jobs/"+id+"/files/clip-0.mp4", nil, ""); resp.StatusCode != 410 {
		t.Errorf("expired download %d", resp.StatusCode)
	}
}

func TestShareRequestGroups(t *testing.T) {
	for p, want := range map[string]string{"/__glow/guest/jobs/gq-1/files/clip-0.mp4": "guest/jobs", "/__glow/guest/join": "guest/join",
		"/__glow/share/jobs/x/approve": "share/jobs", "/__glow/share/status": "share/status"} {
		if g := requestGroup(p); g != want {
			t.Errorf("%s -> %s", p, g)
		}
	}
}
