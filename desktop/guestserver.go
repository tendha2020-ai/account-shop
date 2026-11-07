package main

// The friends' page and API (DESIGN d.1-d.3): a SEPARATE http.Server and
// handler, never the host's mux. It serves an allowlist of the web app's files
// in guest mode (index.html with window.GLOW_GUEST, no heartbeat, a strict CSP)
// and /__glow/guest/*. Everything else, including every /__glow/engine,
// /__glow/comfy and /__glow/share path, is a plain 404.
//
//	GET  /__glow/guest/hello                 -> {app, guest, sharing, session}
//	POST /__glow/guest/join      {token}     -> {session} + cookie (X-Glow-Guest: 1, JSON)
//	GET  /__glow/guest/session               -> {session}
//	POST /__glow/guest/name      {name}      -> {name}
//	POST /__glow/guest/plan      PlanRequest -> {plan, queue}
//	POST /__glow/guest/jobs      multipart request + selfie (+ audio) -> 202 {job}
//	GET  /__glow/guest/jobs/current          -> {job}
//	GET  /__glow/guest/jobs/<id>             -> {job}
//	GET  /__glow/guest/jobs/<id>/files/<name> (still-<k>.png, clip-<k>.mp4, song.mp4)
//	POST /__glow/guest/jobs/<id>/cancel | done
//	POST /__glow/guest/claim     {code}      -> {job}
//	POST /__glow/guest/leave                 -> {ok}
//
// Every POST needs the session's X-Glow-CSRF header (join needs X-Glow-Guest:
// 1 instead), a same-origin Origin/Sec-Fetch-Site when the browser sends them,
// and the HttpOnly SameSite=Strict session cookie.

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const guestCookie = "glow_guest"

// ---- the guest index (DESIGN e.1) ----

var inlineScriptRe = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// buildGuestIndex makes index.html for friends: data-guest, window.GLOW_GUEST,
// without the local engine (and the host-only share card scripts). Each edit
// must match exactly once, else sharing does not start.
func buildGuestIndex(app fs.FS) ([]byte, string, error) {
	page, err := fs.ReadFile(app, "index.html")
	if err != nil {
		return nil, "", err
	}
	edit := func(from, to string, required bool) error {
		n := bytes.Count(page, []byte(from))
		if n > 1 || (required && n != 1) {
			return fmt.Errorf("index.html: %q appears %d times", from, n)
		}
		page = bytes.Replace(page, []byte(from), []byte(to), 1)
		return nil
	}
	if err := edit(`<html lang="en">`, `<html lang="en" data-guest="1">`, true); err != nil {
		return nil, "", err
	}
	if err := edit("<head>", `<head>`+"\n"+`<script>window.GLOW_GUEST={"v":1}</script>`, true); err != nil {
		return nil, "", err
	}
	if err := edit(`<script src="local-engine.js" defer></script>`+"\n", "", false); err != nil {
		return nil, "", err
	}
	if err := edit(`<script src="local-engine.js" defer></script>`, "", false); err != nil {
		return nil, "", err
	}
	for _, f := range []string{"share.js", "qr.js"} {
		tag := `<script src="` + f + `" defer></script>`
		if err := edit(tag+"\n", "", false); err != nil {
			return nil, "", err
		}
		if err := edit(tag, "", false); err != nil {
			return nil, "", err
		}
	}
	if bytes.Contains(page, []byte("local-engine.js")) || bytes.Contains(page, []byte("/__glow/ping")) {
		return nil, "", errors.New("index.html: host-only scripts are left in the guest page")
	}
	if !bytes.Contains(page, []byte(`<script src="ai.js" defer></script>`)) {
		return nil, "", errors.New("index.html: ai.js is missing")
	}
	var hashes []string
	for _, m := range inlineScriptRe.FindAllSubmatch(page, -1) {
		sum := sha256.Sum256(m[1])
		hashes = append(hashes, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	csp := "default-src 'self'; script-src 'self' " + strings.Join(hashes, " ") +
		"; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:;" +
		" media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'none'; object-src 'none'; base-uri 'none';" +
		" form-action 'none'; frame-ancestors 'none'"
	return page, csp, nil
}

// The web app files a friend's browser may load.
var guestFiles = map[string]string{
	"app.css": "text/css; charset=utf-8", "ai.css": "text/css; charset=utf-8",
	"app.js": "text/javascript; charset=utf-8", "ai.js": "text/javascript; charset=utf-8", "beat.js": "text/javascript; charset=utf-8",
	"music.js": "text/javascript; charset=utf-8", "templates.js": "text/javascript; charset=utf-8", "scenes.js": "text/javascript; charset=utf-8",
	"guest.js": "text/javascript; charset=utf-8", "scenes.json": "application/json; charset=utf-8", "icon.svg": "image/svg+xml",
	"manifest.webmanifest": "application/manifest+json",
}

// ---- rate limits ----

type bucket struct {
	tokens float64
	last   time.Time
}

func (b *bucket) allow(now time.Time, rate, burst float64) bool {
	if b.last.IsZero() {
		b.tokens = burst
	} else {
		b.tokens = min(burst, b.tokens+now.Sub(b.last).Seconds()*rate)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type guestLimits struct {
	mu          sync.Mutex
	static      map[string]*bucket
	fails       map[string][]time.Time
	blocked     map[string]time.Time
	allFails    []time.Time
	pausedUntil time.Time
}

func newGuestLimits() *guestLimits {
	return &guestLimits{static: map[string]*bucket{}, fails: map[string][]time.Time{}, blocked: map[string]time.Time{}}
}

func (l *guestLimits) staticOK(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.static) > 4096 {
		l.static = map[string]*bucket{}
	}
	b := l.static[ip]
	if b == nil {
		b = &bucket{}
		l.static[ip] = b
	}
	return b.allow(now, 30, 90)
}

// joinBlocked: 0 when ip may try a token or code now, else how long to wait.
func (l *guestLimits) joinBlocked(ip string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Before(l.pausedUntil) {
		return l.pausedUntil.Sub(now)
	}
	if until, ok := l.blocked[ip]; ok && now.Before(until) {
		return until.Sub(now)
	}
	return 0
}

// fail records a wrong token or code; it returns how many this ip had in 10 min.
func (l *guestLimits) fail(ip string, now time.Time) (n int, paused bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now.Add(-10 * time.Minute)
	keep := func(ts []time.Time) []time.Time {
		out := ts[:0]
		for _, t := range ts {
			if t.After(cut) {
				out = append(out, t)
			}
		}
		return out
	}
	if len(l.fails) > 4096 {
		l.fails = map[string][]time.Time{}
	}
	l.fails[ip] = append(keep(l.fails[ip]), now)
	l.allFails = append(keep(l.allFails), now)
	n = len(l.fails[ip])
	if n >= 10 {
		l.blocked[ip] = now.Add(15 * time.Minute)
	}
	if len(l.allFails) > 100 && !now.Before(l.pausedUntil) {
		l.pausedUntil = now.Add(10 * time.Minute)
		paused = true
	}
	return n, paused
}

// ---- sessions ----

type guestSession struct {
	sid, guestID, csrf string
	created, lastSeen  time.Time
	blocked            bool
	api                bucket
}

type guestRec struct {
	id, name           string
	joinedAt, lastSeen time.Time
	blocked            bool
	used               map[string]int // day -> videos accepted
	ip                 string
}

// reqInfo is what the gate learnt about a request.
type reqInfo struct {
	kind   string // "local" (tunnel target) or "lan"
	scheme string
	ip     string
	host   string
}

func setGuestHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
}

func plain(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	io.WriteString(w, msg)
}

func (s *Share) newGuestServer(kind string) *http.Server {
	return &http.Server{
		Handler:           logRequests(s.guestHandler(kind)),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(io.Discard, "", 0), // TLS/probe noise from the internet; requests are summarised by logRequests
	}
}

// guestHandler is the whole friends' site for one listener.
func (s *Share) guestHandler(kind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setGuestHeaders(w)
		ri, ok := s.gate(kind, w, r)
		if !ok {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/__glow/guest/") {
			s.guestAPI(ri, w, r)
			return
		}
		s.guestStatic(ri, w, r)
	})
}

// gate: Host header, scheme, client address (DESIGN d.1 steps 1-3).
func (s *Share) gate(kind string, w http.ResponseWriter, r *http.Request) (reqInfo, bool) {
	s.mu.Lock()
	port, lan, tun, test := s.gport, s.lan, s.tun, s.testHTTP
	s.mu.Unlock()
	tunHost := ""
	if tun != nil {
		tunHost = tun.Host()
	}
	host := strings.ToLower(r.Host)
	ri := reqInfo{kind: kind, host: host, scheme: "http"}
	p := strconv.Itoa(port)
	if kind == "lan" {
		if lan == nil || host != net.JoinHostPort(lan.IP.String(), p) {
			plain(w, http.StatusMisdirectedRequest, "Misdirected request")
			return ri, false
		}
		ip := net.ParseIP(hostOnly(r.RemoteAddr))
		if ip == nil || !lan.Net.Contains(ip) {
			plain(w, http.StatusForbidden, "forbidden")
			return ri, false
		}
		ri.ip = ip.String()
		return ri, true
	}
	isTun := tunHost != "" && host == strings.ToLower(tunHost)
	if !isTun && host != "127.0.0.1:"+p && host != "localhost:"+p {
		plain(w, http.StatusMisdirectedRequest, "Misdirected request")
		return ri, false
	}
	switch xf := strings.ToLower(r.Header.Get("X-Forwarded-Proto")); {
	case xf == "http" || xf == "https":
		ri.scheme = xf
	case isTun:
		ri.scheme = "https"
	}
	if isTun && ri.scheme == "http" && !test {
		http.Redirect(w, r, "https://"+tunHost+r.URL.RequestURI(), http.StatusPermanentRedirect)
		return ri, false
	}
	ri.ip = "tunnel"
	if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("Cf-Connecting-Ip"))); ip != nil {
		ri.ip = ip.String()
	} else if !isTun {
		ri.ip = hostOnly(r.RemoteAddr)
	}
	return ri, true
}

func hostOnly(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr
}

func (s *Share) guestStatic(ri reqInfo, w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	lim, index, csp := s.limits, s.index, s.csp
	s.mu.Unlock()
	if lim != nil && !lim.staticOK(ri.ip, time.Now()) {
		w.Header().Set("Retry-After", "2")
		plain(w, http.StatusTooManyRequests, "Too many requests")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		plain(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	var data []byte
	var ctype string
	if name == "" || name == "index.html" {
		data, ctype = index, "text/html; charset=utf-8"
		w.Header().Set("Content-Security-Policy", csp)
	} else if t, ok := guestFiles[name]; ok {
		b, err := fs.ReadFile(s.app, name)
		if err != nil {
			plain(w, http.StatusNotFound, "Not found")
			return
		}
		data, ctype = b, t
	} else {
		plain(w, http.StatusNotFound, "Not found")
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(data)
}

// sameOrigin: Origin (when sent) is this site, Sec-Fetch-Site (when sent) is same-origin.
func sameOrigin(ri reqInfo, r *http.Request) bool {
	if o := r.Header.Get("Origin"); o != "" {
		u, err := url.Parse(o)
		if err != nil || u.User != nil || (u.Path != "" && u.Path != "/") || !strings.EqualFold(u.Scheme, ri.scheme) || !strings.EqualFold(u.Host, ri.host) {
			return false
		}
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		return false
	}
	return true
}

func guestErr(w http.ResponseWriter, status int, code, msg string) {
	writeAPIError(w, &apiError{Status: status, Code: code, Message: msg})
}

var errForbidden = &apiError{Status: 403, Code: "forbidden", Message: "This request isn't allowed. Reload the page and try again."}

func (s *Share) guestAPI(ri reqInfo, w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/__glow/guest/")
	now := time.Now()
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		switch {
		case name == "hello":
			s.mu.Lock()
			state := s.state
			_, has := s.sessionLocked(r, now, false)
			s.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"app": "glow-studio", "guest": true, "sharing": state, "session": has})
			return
		case name == "session", name == "jobs/current", strings.HasPrefix(name, "jobs/"):
		default:
			guestErr(w, http.StatusNotFound, "not-found", "Not found.")
			return
		}
	} else if r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		guestErr(w, http.StatusMethodNotAllowed, "method", "Use GET or POST.")
		return
	} else if !sameOrigin(ri, r) {
		writeAPIError(w, errForbidden)
		return
	}
	if r.Method == http.MethodPost && name == "join" {
		s.guestJoin(ri, w, r)
		return
	}
	if r.Method == http.MethodPost && name == "claim" {
		if wait := s.limitsOf().joinBlocked(ri.ip, now); wait > 0 {
			tooMany(w, wait)
			return
		}
	}
	// a session for everything else
	s.mu.Lock()
	ss, ok := s.sessionLocked(r, now, true)
	if !ok {
		s.mu.Unlock()
		guestErr(w, http.StatusUnauthorized, "no-session", "Ask your friend for a new link.")
		return
	}
	if ss.blocked {
		s.mu.Unlock()
		guestErr(w, http.StatusForbidden, "blocked", "Your friend has stopped sharing with you.")
		return
	}
	if r.Method == http.MethodPost && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Glow-CSRF")), []byte(ss.csrf)) != 1 {
		s.mu.Unlock()
		writeAPIError(w, errForbidden)
		return
	}
	// (file downloads have their own limit: at most 4 at a time)
	isFile := r.Method != http.MethodPost && strings.Contains(name, "/files/")
	if !isFile && !ss.api.allow(now, 5, 20) {
		s.mu.Unlock()
		w.Header().Set("Retry-After", "2")
		guestErr(w, http.StatusTooManyRequests, "slow-down", "Too many requests. Wait a moment.")
		return
	}
	g := s.guests[ss.guestID]
	ss.lastSeen = now
	if g != nil {
		g.lastSeen = now
	}
	s.mu.Unlock()
	if g == nil {
		guestErr(w, http.StatusUnauthorized, "no-session", "Ask your friend for a new link.")
		return
	}
	if r.Method != http.MethodPost {
		switch {
		case name == "session":
			writeJSON(w, http.StatusOK, map[string]any{"session": s.sessionJSON(ss, ri)})
		case name == "jobs/current":
			s.mu.Lock()
			j := s.currentJobLocked(g.id)
			var out any
			if j != nil {
				out = s.jobJSONLocked(j, s.queueViewNow())
			}
			s.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"job": out})
		default:
			parts := strings.Split(strings.TrimPrefix(name, "jobs/"), "/")
			if len(parts) == 1 {
				s.mu.Lock()
				j := s.jobs[parts[0]]
				if j == nil || j.guestID != g.id {
					s.mu.Unlock()
					guestErr(w, http.StatusNotFound, "not-found", "This video isn't here any more.")
					return
				}
				out := s.jobJSONLocked(j, s.queueViewNow())
				s.mu.Unlock()
				writeJSON(w, http.StatusOK, map[string]any{"job": out})
				return
			}
			if len(parts) == 3 && parts[1] == "files" {
				s.guestFile(g, parts[0], parts[2], w, r)
				return
			}
			guestErr(w, http.StatusNotFound, "not-found", "Not found.")
		}
		return
	}
	switch {
	case name == "name":
		s.guestName(g, w, r)
	case name == "plan":
		s.guestPlanAPI(g, w, r)
	case name == "jobs":
		s.guestSubmit(g, ri, w, r)
	case name == "claim":
		s.guestClaim(g, ri, w, r)
	case name == "leave":
		s.guestLeave(ss, w)
	case strings.HasPrefix(name, "jobs/") && (strings.HasSuffix(name, "/cancel") || strings.HasSuffix(name, "/done")):
		parts := strings.Split(strings.TrimPrefix(name, "jobs/"), "/")
		if len(parts) != 2 {
			guestErr(w, http.StatusNotFound, "not-found", "Not found.")
			return
		}
		s.guestJobAction(g, parts[0], parts[1], w)
	default:
		guestErr(w, http.StatusNotFound, "not-found", "Not found.")
	}
}

func (s *Share) limitsOf() *guestLimits {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limits == nil {
		s.limits = newGuestLimits()
	}
	return s.limits
}

func tooMany(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
	guestErr(w, http.StatusTooManyRequests, "too-many-attempts", "Too many wrong tries. Wait 15 minutes, or ask your friend for a new link.")
}

// sessionLocked finds the request's session (s.mu held).
func (s *Share) sessionLocked(r *http.Request, now time.Time, touch bool) (*guestSession, bool) {
	c, err := r.Cookie(guestCookie)
	if err != nil || c.Value == "" || s.sessions == nil {
		return nil, false
	}
	ss := s.sessions[c.Value]
	if ss == nil || now.Sub(ss.created) > sessionTTL {
		return nil, false
	}
	return ss, true
}

func readSmallJSON(w http.ResponseWriter, r *http.Request, limit int64, v any) *apiError {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var mb *http.MaxBytesError
		if errors.As(err, &mb) {
			return &apiError{Status: 413, Code: "too-large", Message: "The request is too large."}
		}
		return badField("body")
	}
	return decodeStrict(body, v)
}

func (s *Share) guestJoin(ri reqInfo, w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if r.Header.Get("X-Glow-Guest") != "1" || mt != "application/json" {
		writeAPIError(w, errForbidden)
		return
	}
	lim := s.limitsOf()
	if wait := lim.joinBlocked(ri.ip, now); wait > 0 {
		tooMany(w, wait)
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if e := readSmallJSON(w, r, 1<<10, &req); e != nil {
		writeAPIError(w, e)
		return
	}
	s.mu.Lock()
	if s.state != "on" {
		s.mu.Unlock()
		guestErr(w, http.StatusServiceUnavailable, "not-accepting", "Your friend isn't sharing right now.")
		return
	}
	if ss, ok := s.sessionLocked(r, now, true); ok {
		if ss.blocked {
			s.mu.Unlock()
			guestErr(w, http.StatusForbidden, "blocked", "Your friend has stopped sharing with you.")
			return
		}
		ss.lastSeen = now
		s.mu.Unlock()
		s.setCookie(w, ri, ss)
		writeJSON(w, http.StatusOK, map[string]any{"session": s.sessionJSON(ss, ri)})
		return
	}
	if subtle.ConstantTimeCompare([]byte(req.Token), []byte(s.token)) != 1 || req.Token == "" {
		s.mu.Unlock()
		n, paused := lim.fail(ri.ip, now)
		s.logf("bad join token from %s (%d in 10 min)", ri.ip, n)
		if paused {
			s.logf("too many wrong links tried: joining is paused for 10 minutes")
		}
		guestErr(w, http.StatusForbidden, "bad-token", "This link doesn't work any more. Ask your friend for a new link.")
		return
	}
	if len(s.sessions) >= maxGuestSessions {
		s.mu.Unlock()
		guestErr(w, http.StatusConflict, "full", "Too many people are connected right now. Try again later.")
		return
	}
	g := &guestRec{id: "u" + randHex(6), joinedAt: now, lastSeen: now, used: map[string]int{}, ip: ri.ip}
	ss := &guestSession{sid: randToken(32), guestID: g.id, csrf: randToken(16), created: now, lastSeen: now}
	s.guests[g.id], s.sessions[ss.sid] = g, ss
	s.mu.Unlock()
	s.logf("guest %s joined from %s", g.id, ri.ip)
	s.setCookie(w, ri, ss)
	writeJSON(w, http.StatusOK, map[string]any{"session": s.sessionJSON(ss, ri)})
}

func (s *Share) setCookie(w http.ResponseWriter, ri reqInfo, ss *guestSession) {
	http.SetCookie(w, &http.Cookie{Name: guestCookie, Value: ss.sid, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode,
		MaxAge: int(sessionTTL / time.Second), Secure: ri.scheme == "https"})
}

// sessionJSON is the guest's view of the sharing session.
func (s *Share) sessionJSON(ss *guestSession, ri reqInfo) map[string]any {
	_, singing, fast := s.eng.sharePacks()
	laptop := laptopRe.MatchString(s.eng.shareGPUName())
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.guests[ss.guestID]
	var name any
	used := 0
	if g != nil {
		if g.name != "" {
			name = g.name
		}
		used = g.used[s.dayKey(now)]
	}
	var job any
	if j := s.currentJobLocked(ss.guestID); j != nil {
		job = s.jobJSONLocked(j, s.queueViewNow())
	}
	daily := s.settings.DailyLimit
	return map[string]any{
		"guest": map[string]any{"id": ss.guestID, "name": name}, "csrf": ss.csrf,
		"host":    map[string]any{"name": s.settings.HostName, "singing": singing, "fast": fast, "laptop": laptop},
		"limits":  map[string]any{"daily": daily, "usedToday": used, "left": max(0, daily-used), "resetAt": ts(s.resetAt(now))},
		"approve": s.settings.Approve, "mode": s.settings.Mode, "secureContext": ri.scheme == "https",
		"stopsAt": ts(s.stopsAt), "state": s.state, "scenesVersion": 1, "job": job,
	}
}

func (s *Share) guestName(g *guestRec, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if e := readSmallJSON(w, r, 1<<10, &req); e != nil {
		writeAPIError(w, e)
		return
	}
	name, ok := sanitizeName(req.Name)
	if !ok {
		writeAPIError(w, &apiError{Status: 400, Code: "bad-name", Message: "Type your name (1 to 24 letters).", Field: "name"})
		return
	}
	s.mu.Lock()
	named := 0
	for _, o := range s.guests {
		if o.name != "" && o.id != g.id {
			named++
		}
	}
	if g.name == "" && named >= maxNamedGuests {
		s.mu.Unlock()
		guestErr(w, http.StatusConflict, "full", "Too many friends are connected right now. Try again later.")
		return
	}
	taken := func(n string) bool {
		if strings.EqualFold(n, s.settings.HostName) {
			return true
		}
		for _, o := range s.guests {
			if o.id != g.id && strings.EqualFold(o.name, n) {
				return true
			}
		}
		return false
	}
	final := name
	for i := 2; taken(final) && i < 100; i++ {
		final = fmt.Sprintf("%s (%d)", name, i)
	}
	first := g.name == ""
	g.name = final
	s.mu.Unlock()
	if first {
		s.logf("guest %s is %q", g.id, final)
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": final})
}

// packsNow: what the host's engine can do, for plans.
func (s *Share) packsNow() hostPacks {
	_, singing, fast := s.eng.sharePacks()
	_, state := s.eng.shareComfy()
	return hostPacks{Singing: singing, Fast: fast, Laptop: laptopRe.MatchString(s.eng.shareGPUName()), Cold: state != "ready"}
}

func (s *Share) guestPlanAPI(g *guestRec, w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<10))
	if err != nil {
		writeAPIError(w, &apiError{Status: 413, Code: "too-large", Message: "The request is too large."})
		return
	}
	s.mu.Lock()
	sd, named := s.scenes, g.name != ""
	s.mu.Unlock()
	if !named {
		guestErr(w, http.StatusConflict, "no-name", "Type your name first.")
		return
	}
	req, e := parsePlanRequest(sd, body)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	p, e := guestPlan(sd, req, s.packsNow(), 0)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	s.mu.Lock()
	q := s.queuePreviewLocked(p)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"plan": p, "queue": q})
}

// currentJobLocked: the guest's latest job that is still of use to them.
func (s *Share) currentJobLocked(guestID string) *guestJob {
	for i := len(s.order) - 1; i >= 0; i-- {
		j := s.order[i]
		if j.guestID == guestID && j.state != "expired" && j.state != "downloaded" {
			return j
		}
	}
	return nil
}

func activeJob(state string) bool {
	return state == "waiting-approval" || state == "queued" || state == "running"
}

func terminalJob(state string) bool {
	switch state {
	case "downloaded", "failed", "cancelled", "declined", "expired":
		return true
	}
	return false
}

// admitLocked: may this guest send a new job now? (s.mu held)
func (s *Share) admitLocked(g *guestRec, now time.Time) *apiError {
	if s.state != "on" {
		return &apiError{Status: 503, Code: "not-accepting", Message: "Your friend isn't taking new videos right now."}
	}
	if g.blocked {
		return &apiError{Status: 403, Code: "blocked", Message: "Your friend has stopped sharing with you."}
	}
	if g.name == "" {
		return &apiError{Status: 409, Code: "no-name", Message: "Type your name first."}
	}
	queued := 0
	for _, j := range s.order {
		if j.guestID == g.id && activeJob(j.state) {
			return &apiError{Status: 409, Code: "active-job", Message: "You already have a video on the way. Wait until it's done."}
		}
		if j.state == "waiting-approval" || j.state == "queued" {
			queued++
		}
	}
	if g.used[s.dayKey(now)] >= s.settings.DailyLimit {
		return &apiError{Status: 429, Code: "daily-limit", Message: "You've made all your videos for today. Try again tomorrow.",
			Extra: map[string]any{"resetAt": ts(s.resetAt(now))}}
	}
	if queued >= maxQueuedJobs {
		return &apiError{Status: 503, Code: "queue-full", Message: "Lots of videos are waiting already. Try again in a little while."}
	}
	return nil
}

func (s *Share) guestSubmit(g *guestRec, ri reqInfo, w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	s.mu.Lock()
	if e := s.admitLocked(g, now); e != nil {
		s.mu.Unlock()
		if e.Status == 503 {
			w.Header().Set("Retry-After", "60")
		}
		writeAPIError(w, e)
		return
	}
	sem, sd, approve := s.uploads, s.scenes, s.settings.Approve
	s.mu.Unlock()
	select {
	case sem <- struct{}{}:
		defer func() { <-sem }()
	default:
		w.Header().Set("Retry-After", "5")
		guestErr(w, http.StatusServiceUnavailable, "busy", "Your friend's PC is busy receiving another photo. Try again in a few seconds.")
		return
	}
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mt != "multipart/form-data" {
		guestErr(w, http.StatusUnsupportedMediaType, "unsupported-type", "Please send the photo again.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 36<<20)
	parts, e := readJobParts(r)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	req, e := parseJobRequest(sd, parts["request"], parts["audio"] != nil)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	if parts["selfie"] == nil {
		writeAPIError(w, &apiError{Status: 400, Code: "bad-photo", Message: "Please choose a photo of yourself.", Field: "selfie"})
		return
	}
	seed := randSeed()
	if req.Seed != nil {
		seed = *req.Seed
	}
	p, e := guestPlan(sd, req, s.packsNow(), seed)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	var wav []byte
	wavSec := 0.0
	if parts["audio"] != nil {
		if wav, wavSec, e = sanitizeWAV(parts["audio"]); e != nil {
			writeAPIError(w, e)
			return
		}
	}
	if e := p.applyLipStarts(req.LipStarts, wavSec); e != nil {
		writeAPIError(w, e)
		return
	}
	selfie, thumb, e := sanitizeSelfie(parts["selfie"], approve)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	s.mu.Lock()
	if e := s.admitLocked(g, now); e != nil {
		s.mu.Unlock()
		writeAPIError(w, e)
		return
	}
	j := &guestJob{id: "gq-" + randHex(8), code: newResumeCode(), guestID: g.id, state: "queued", createdAt: time.Now(), plan: p,
		selfie: selfie, wav: wav, day: s.dayKey(now)}
	j.expiresAt = j.createdAt.Add(jobKeep)
	if s.settings.Approve {
		j.state, j.thumb = "waiting-approval", thumb
	}
	g.used[j.day]++
	s.jobs[j.id] = j
	s.order = append(s.order, j)
	q := s.queueViewNow()
	out := s.jobJSONLocked(j, q)
	ahead := q[j.id].ahead
	s.mu.Unlock()
	s.logf("job %s by %s: %s, %s (%d ahead)", j.id, g.id, p, j.state, ahead)
	s.kick()
	writeJSON(w, http.StatusAccepted, map[string]any{"job": out})
}

// readJobParts reads the multipart body: request (<= 8 KiB), selfie (<= 15 MiB), audio (<= 20 MiB).
func readJobParts(r *http.Request) (map[string][]byte, *apiError) {
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, &apiError{Status: 415, Code: "unsupported-type", Message: "Please send the photo again."}
	}
	limits := map[string]int64{"request": 8 << 10, "selfie": 15 << 20, "audio": 20 << 20}
	out := map[string][]byte{}
	tooLarge := &apiError{Status: 413, Code: "too-large", Message: "The photo or song part is too large."}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			var mb *http.MaxBytesError
			if errors.As(err, &mb) {
				return nil, tooLarge
			}
			return nil, badField("body")
		}
		name := part.FormName()
		limit, ok := limits[name]
		if !ok || out[name] != nil {
			return nil, badField(name)
		}
		data, err := io.ReadAll(io.LimitReader(part, limit+1))
		if err != nil {
			var mb *http.MaxBytesError
			if errors.As(err, &mb) {
				return nil, tooLarge
			}
			return nil, badField(name)
		}
		if int64(len(data)) > limit {
			return nil, tooLarge
		}
		out[name] = data
	}
	if out["request"] == nil {
		return nil, badField("request")
	}
	return out, nil
}

func (s *Share) guestJobAction(g *guestRec, id, action string, w http.ResponseWriter) {
	var cleanup *guestJob
	s.mu.Lock()
	j := s.jobs[id]
	if j == nil || j.guestID != g.id {
		s.mu.Unlock()
		guestErr(w, http.StatusNotFound, "not-found", "This video isn't here any more.")
		return
	}
	switch action {
	case "cancel":
		if activeJob(j.state) {
			s.finishJobLocked(j, "cancelled", "guest-cancelled", "You cancelled this video.")
			cleanup = j
			s.logf("job %s cancelled by its guest", j.id)
		}
	case "done":
		switch j.state {
		case "done":
			s.finishJobLocked(j, "downloaded", "", "")
			cleanup = j
		case "failed", "cancelled", "declined":
			cleanup = j
		}
	}
	out := s.jobJSONLocked(j, s.queueViewNow())
	s.mu.Unlock()
	if cleanup != nil {
		why := "cancelled"
		if action == "done" {
			why = "downloaded"
		}
		goSafe("cleanup", func() { s.cleanupJob(cleanup, why) })
	}
	s.kick()
	writeJSON(w, http.StatusOK, map[string]any{"job": out})
}

func (s *Share) guestLeave(ss *guestSession, w http.ResponseWriter) {
	s.mu.Lock()
	delete(s.sessions, ss.sid)
	for _, j := range s.order {
		if j.guestID == ss.guestID && (j.state == "waiting-approval" || j.state == "queued") {
			s.finishJobLocked(j, "cancelled", "guest-cancelled", "You left, so this video wasn't made.")
		}
	}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: guestCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	s.kick()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- resume codes ----

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func newResumeCode() string {
	b := randToken(16) // plenty of random bits
	raw, _ := base64.RawURLEncoding.DecodeString(b)
	var v uint64
	for _, c := range raw[:7] {
		v = v<<8 | uint64(c)
	}
	out := make([]byte, 10)
	for i := 9; i >= 0; i-- {
		out[i] = crockford[v&31]
		v >>= 5
	}
	return string(out)
}

func normalizeCode(in string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(in) {
		switch {
		case r == '-' || r == ' ':
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func formatCode(c string) string {
	if len(c) != 10 {
		return c
	}
	return c[:5] + "-" + c[5:]
}

func (s *Share) guestClaim(g *guestRec, ri reqInfo, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if e := readSmallJSON(w, r, 1<<10, &req); e != nil {
		writeAPIError(w, e)
		return
	}
	code := normalizeCode(req.Code)
	now := time.Now()
	s.mu.Lock()
	var found *guestJob
	for _, j := range s.order {
		ok := subtle.ConstantTimeCompare([]byte(code), []byte(j.code)) == 1
		if ok && len(code) == 10 && (activeJob(j.state) || j.state == "done") {
			found = j
		}
	}
	if found == nil {
		s.mu.Unlock()
		n, _ := s.limitsOf().fail(ri.ip, now)
		s.logf("wrong resume code from %s (%d in 10 min)", ri.ip, n)
		guestErr(w, http.StatusNotFound, "bad-code", "That code doesn't match a video. Check it and try again.")
		return
	}
	if found.guestID != g.id {
		for _, j := range s.order {
			if j.guestID == g.id && activeJob(j.state) {
				s.mu.Unlock()
				guestErr(w, http.StatusConflict, "active-job", "You already have a video on the way.")
				return
			}
		}
		old := s.guests[found.guestID]
		if old != nil {
			for day, n := range old.used { // the same person: their limit comes along
				g.used[day] += n
				old.used[day] = 0
			}
			if g.name == "" && old.name != "" {
				g.name, old.name = old.name, ""
			}
		}
		found.guestID = g.id
	}
	found.code = newResumeCode() // one-time
	out := s.jobJSONLocked(found, s.queueViewNow())
	s.mu.Unlock()
	s.logf("job %s claimed by %s with its resume code", found.id, g.id)
	writeJSON(w, http.StatusOK, map[string]any{"job": out})
}

// ---- job JSON for friends ----

func (s *Share) jobJSONLocked(j *guestJob, q map[string]queueView) map[string]any {
	m := map[string]any{"id": j.id, "code": nil, "state": j.state, "createdAt": ts(j.createdAt), "startedAt": ts(j.startedAt),
		"finishedAt": ts(j.finishedAt), "expiresAt": ts(j.expiresAt), "plan": j.plan, "queue": nil, "progress": nil,
		"files": j.files, "error": nil}
	if j.files == nil {
		m["files"] = []jobFile{}
	}
	if activeJob(j.state) || j.state == "done" {
		m["code"] = formatCode(j.code)
	}
	if v, ok := q[j.id]; ok && (j.state == "waiting-approval" || j.state == "queued") {
		m["queue"] = v.jsonFull()
	}
	if j.state == "running" && j.progress != nil {
		m["progress"] = j.progress
	}
	if j.err != nil {
		m["error"] = j.err
	}
	return m
}

func (s *Share) guestFile(g *guestRec, id, name string, w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.jobs[id]
	if j == nil || j.guestID != g.id {
		s.mu.Unlock()
		guestErr(w, http.StatusNotFound, "not-found", "This video isn't here any more.")
		return
	}
	var f *jobFile
	for i := range j.files {
		if j.files[i].Name == name {
			f = &j.files[i]
		}
	}
	state, sem, cleaned := j.state, s.downloads, j.cleaned
	var cf comfyFile
	if f != nil {
		cf = f.comfy
	}
	s.mu.Unlock()
	switch {
	case terminalJob(state) || cleaned:
		guestErr(w, http.StatusGone, "gone", "This video's files were deleted.")
		return
	case f == nil && !guestFileNameRe.MatchString(name):
		guestErr(w, http.StatusNotFound, "not-found", "Not found.")
		return
	case f == nil:
		guestErr(w, http.StatusConflict, "not-ready", "This part isn't ready yet.")
		return
	}
	select {
	case sem <- struct{}{}:
		defer func() { <-sem }()
	default:
		w.Header().Set("Retry-After", "5")
		guestErr(w, http.StatusServiceUnavailable, "busy", "Busy. Trying again in a few seconds.")
		return
	}
	rc, size, err := s.openOutput(cf)
	if err != nil {
		guestErr(w, http.StatusServiceUnavailable, "engine", "Your friend's PC couldn't send this file right now. Try again in a minute.")
		return
	}
	defer rc.Close()
	http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute))
	ctype := "video/mp4"
	if strings.HasSuffix(name, ".png") {
		ctype = "image/png"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-store")
	if size >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	if r.Method == http.MethodHead {
		return
	}
	io.Copy(w, rc)
}

var guestFileNameRe = regexp.MustCompile(`^(still-[0-3]\.png|clip-[0-3]\.mp4|song\.mp4)$`)

// queueViewNow: queue positions and waits (s.mu held; the engine is asked
// without locks of its own being held by us for long).
func (s *Share) queueViewNow() map[string]queueView {
	sum, noEta := s.eng.hostEta()
	busy, _ := s.eng.hostBusy()
	return s.queueViewLocked(sum, noEta, busy)
}
