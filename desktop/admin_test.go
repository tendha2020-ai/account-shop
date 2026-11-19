package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// The admin link: the owner's full host page and API through the friends' listener.
func TestAdminLink(t *testing.T) {
	h := newShareHarness(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/__glow/share/", func(w http.ResponseWriter, r *http.Request) {
		if !h.hostE.guard(w, r) {
			return
		}
		h.s.hostAPI(w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("HOST PAGE")) })
	h.s.mu.Lock()
	h.s.hostMux, h.s.hostAddr = mux, strings.TrimPrefix(h.host, "http://")
	h.s.mu.Unlock()

	do := func(method, path, cookie, origin string) (int, string, http.Header) {
		t.Helper()
		req, _ := http.NewRequest(method, h.guestURL()+path, nil)
		req.Host = fakeTunnelHost
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("Cf-Connecting-Ip", "203.0.113.9")
		if cookie != "" {
			req.Header.Set("Cookie", adminCookie+"="+cookie)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
			req.Header.Set("Sec-Fetch-Site", "same-origin")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), resp.Header
	}

	// before sharing is on there is no admin link
	if code, _ := h.hostDo("POST", "/__glow/share/admin-link", nil); code != 409 {
		t.Fatalf("admin-link while off: %d", code)
	}
	h.start("internet", nil)
	if code, _, _ := do("GET", "/?admin=nope", "", ""); code != 403 {
		t.Fatalf("admin token with no admin link: %d", code)
	}
	code, st := h.hostDo("POST", "/__glow/share/admin-link", nil)
	link, _ := st["adminLink"].(string)
	if code != 200 || !strings.HasPrefix(link, "https://"+fakeTunnelHost+"/?admin=") {
		t.Fatalf("admin-link: %d %q", code, link)
	}
	tok := link[strings.Index(link, "?admin=")+7:]
	if len(tok) < 30 {
		t.Fatalf("short token %q", tok)
	}
	if code, _, _ := do("GET", "/?admin="+tok+"x", "", ""); code != 403 {
		t.Fatalf("wrong token: %d", code)
	}
	code, body, hd := do("GET", "/?admin="+tok, "", "")
	sc := hd.Get("Set-Cookie")
	if code != 200 || !strings.Contains(sc, adminCookie+"=") || !strings.Contains(sc, "HttpOnly") || !strings.Contains(sc, "SameSite=Strict") || !strings.Contains(sc, "Secure") {
		t.Fatalf("sign-in: %d cookie %q", code, sc)
	}
	if strings.Contains(body, tok) || !strings.Contains(body, "location.replace('/')") {
		t.Fatalf("sign-in page: %q", body)
	}
	cookie := strings.SplitN(strings.SplitN(sc, ";", 2)[0], "=", 2)[1]

	// with the cookie: the host's page and API; without it: the friends' page, and no host API
	if code, body, _ := do("GET", "/", cookie, ""); code != 200 || body != "HOST PAGE" {
		t.Fatalf("admin page: %d %q", code, body)
	}
	if _, body, _ := do("GET", "/", "", ""); body == "HOST PAGE" {
		t.Fatal("the host page was served without the admin cookie")
	}
	if _, body, _ := do("GET", "/", "not-a-session", ""); body == "HOST PAGE" {
		t.Fatal("the host page was served with a made-up cookie")
	}
	if code, body, _ := do("GET", "/__glow/share/status", cookie, ""); code != 200 || !strings.Contains(body, `"state":"on"`) {
		t.Fatalf("admin status: %d %q", code, body)
	}
	if code, body, _ := do("GET", "/__glow/share/status", "", ""); code == 200 && strings.Contains(body, `"state"`) {
		t.Fatalf("host API reachable without the cookie: %d %q", code, body)
	}
	// a POST from another site's origin is refused; from the page's own origin it works
	if code, _, _ := do("POST", "/__glow/share/admin-link", cookie, "https://evil.example"); code != 403 {
		t.Fatalf("cross-origin POST: %d", code)
	}
	if code, _, _ := do("POST", "/__glow/share/admin-link", cookie, "https://"+fakeTunnelHost); code != 200 {
		t.Fatalf("same-origin POST: %d", code)
	}
	// turning it off ends the phone's session
	if code, _ := h.hostDo("POST", "/__glow/share/admin-off", nil); code != 200 {
		t.Fatalf("admin-off: %d", code)
	}
	if _, body, _ := do("GET", "/", cookie, ""); body == "HOST PAGE" {
		t.Fatal("the session survived admin-off")
	}
	if code, _, _ := do("GET", "/?admin="+tok, "", ""); code != 403 {
		t.Fatalf("old token after admin-off: %d", code)
	}
	// a new link, then stopping sharing, ends it too
	_, st = h.hostDo("POST", "/__glow/share/admin-link", nil)
	link2, _ := st["adminLink"].(string)
	if link2 == "" || link2 == link {
		t.Fatalf("second admin link %q", link2)
	}
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	h.s.mu.Lock()
	gone := h.s.admin.tok == ""
	h.s.mu.Unlock()
	if !gone {
		t.Fatal("the admin link survived Stop sharing")
	}
}
