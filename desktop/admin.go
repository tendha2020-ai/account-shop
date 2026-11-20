package main

// Admin link: the owner opens the FULL Glow Studio (the host's own page and
// API, not the friends' page) from their phone, through the same listener
// friends use while "Share with friends" is on.
//
//   - Off until the host asks for it (POST /__glow/share/admin-link on the
//     127.0.0.1 host API); gone when sharing stops or on "admin-off".
//   - The link carries a 192-bit random token (?admin=...). Opening it sets an
//     HttpOnly, SameSite=Strict session cookie and the token leaves the URL.
//   - A request with a valid admin cookie is handed to the host's own mux with
//     the Host (and a matching Origin) rewritten to the launcher's loopback
//     address, so the host guard (proxy.go) keeps applying unchanged.
//   - Wrong tokens count against the same per-address limiter as wrong join
//     tokens.
//
// Whoever holds the link controls Glow Studio on this PC: the page says so.

import (
	"crypto/subtle"
	"html"
	"net/http"
	"strings"
	"time"
)

const (
	adminCookie     = "glow_admin"
	adminSessionTTL = 12 * time.Hour
	adminMaxSess    = 5
)

type adminState struct {
	tok  string
	sess map[string]time.Time // cookie value -> expiry
}

// adminURLLocked is the admin link for the current friends' link ("" while there is none).
func (s *Share) adminURLLocked() string {
	if s.admin.tok == "" {
		return ""
	}
	link := s.linkLocked()
	i := strings.Index(link, "?join=")
	if i < 0 {
		return ""
	}
	return link[:i] + "?admin=" + s.admin.tok
}

// adminOn makes the admin link (keeps the current one if there is one).
func (s *Share) adminOn() *apiError {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "on" {
		return &apiError{Status: 409, Code: "not-on", Message: "Turn on Share with friends first, and wait until the link is ready."}
	}
	if s.hostMux == nil {
		return &apiError{Status: 500, Code: "unavailable", Message: "The admin link is not available in this build."}
	}
	if s.admin.tok == "" {
		s.admin = adminState{tok: randToken(24), sess: map[string]time.Time{}}
		s.logf("admin link made (token not logged)")
	}
	return nil
}

func (s *Share) adminOff() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.adminOffLocked("turned off")
}

func (s *Share) adminOffLocked(why string) {
	if s.admin.tok != "" {
		s.logf("admin link off (%s); %d phone session(s) ended", why, len(s.admin.sess))
	}
	s.admin = adminState{}
}

func (s *Share) adminSessionOK(r *http.Request, now time.Time) bool {
	c, err := r.Cookie(adminCookie)
	if err != nil || c.Value == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.admin.tok == "" || s.state != "on" {
		return false
	}
	exp, ok := s.admin.sess[c.Value]
	if !ok || now.After(exp) {
		delete(s.admin.sess, c.Value)
		return false
	}
	return true
}

// adminServe handles the request if it is an admin sign-in or carries an admin
// session; false means "not an admin request" (the friends' page handles it).
func (s *Share) adminServe(ri reqInfo, w http.ResponseWriter, r *http.Request) bool {
	now := time.Now()
	if tok := r.URL.Query().Get("admin"); tok != "" && r.URL.Path == "/" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		lim := s.limitsOf()
		if wait := lim.joinBlocked(ri.ip, now); wait > 0 {
			tooMany(w, wait)
			return true
		}
		s.mu.Lock()
		good := s.admin.tok != "" && s.state == "on" && s.hostMux != nil &&
			subtle.ConstantTimeCompare([]byte(tok), []byte(s.admin.tok)) == 1
		var id string
		if good {
			for k, exp := range s.admin.sess {
				if now.After(exp) {
					delete(s.admin.sess, k)
				}
			}
			for len(s.admin.sess) >= adminMaxSess { // the oldest phone session makes room
				oldest, at := "", time.Time{}
				for k, exp := range s.admin.sess {
					if oldest == "" || exp.Before(at) {
						oldest, at = k, exp
					}
				}
				delete(s.admin.sess, oldest)
			}
			id = randToken(32)
			s.admin.sess[id] = now.Add(adminSessionTTL)
		}
		s.mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		if !good {
			lim.fail(ri.ip, now)
			s.logf("admin link refused (wrong or old link) from %s", ri.ip)
			plain(w, http.StatusForbidden, "This admin link is no longer valid. Make a new one in Glow Studio on your PC.")
			return true
		}
		s.logf("admin signed in from %s", ri.ip)
		http.SetCookie(w, &http.Cookie{Name: adminCookie, Value: id, Path: "/", HttpOnly: true, Secure: ri.scheme == "https",
			SameSite: http.SameSiteStrictMode, MaxAge: int(adminSessionTTL.Seconds())})
		// (a marker the page's script can read: "this is the owner's admin page"; it grants nothing by itself)
		http.SetCookie(w, &http.Cookie{Name: adminCookie + "_ui", Value: "1", Path: "/", Secure: ri.scheme == "https",
			SameSite: http.SameSiteStrictMode, MaxAge: int(adminSessionTTL.Seconds())})
		// A small page, not a redirect: a link opened from another app is a cross-site navigation, and a
		// SameSite=Strict cookie would not be sent on a redirect that follows it. It also takes the token out of the URL.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte("<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>" +
			html.EscapeString("Glow Studio") + "</title><body style=\"background:#0b0714;color:#fff;font:16px system-ui;padding:24px\">Opening Glow Studio…" +
			"<script>location.replace('/')</script><noscript><a href=\"/\" style=\"color:#fff\">Continue</a></noscript>"))
		return true
	}
	if !s.adminSessionOK(r, now) {
		return false
	}
	s.mu.Lock()
	mux, hostAddr := s.hostMux, s.hostAddr
	s.mu.Unlock()
	if mux == nil {
		return false
	}
	r2 := r.Clone(r.Context())
	if o := r.Header.Get("Origin"); o != "" {
		if !strings.EqualFold(o, ri.scheme+"://"+ri.host) {
			plain(w, http.StatusForbidden, "forbidden")
			return true
		}
		r2.Header.Set("Origin", "http://"+hostAddr)
	}
	r2.Host = hostAddr
	r2.Header.Del("Cookie")
	r2.Header.Del("Referer")
	mux.ServeHTTP(w, r2)
	return true
}
