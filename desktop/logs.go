package main

// Log files for support, in %LOCALAPPDATA%\GlowStudio\logs (the setup page's
// Details has an "Open log folder" button, POST /__glow/engine/open-logs):
//
//	launcher.log  start-up, port, a summary of requests every 10 minutes, the
//	              installer's and the engine manager's messages, errors, and the
//	              reason for every exit (rotated at about 5 MB to launcher.1.log)
//	crash.log     the Go runtime's trace if the launcher ever crashes
//	              (runtime/debug.SetCrashOutput; a GUI program has no console)
//
// ComfyUI's own output stays in <install folder>\logs\engine.log.

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"
)

const logRotateBytes = 5 << 20

// logsDir is %LOCALAPPDATA%\GlowStudio\logs (next to the default engine folder).
func logsDir() string { return filepath.Join(filepath.Dir(engineDefaultDir()), "logs") }

// fileLog is an append-only, size-rotated log file. Writing never blocks for
// long on its callers' locks: nothing else is held while it writes.
type fileLog struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
	max  int64
}

var launcherLog = &fileLog{}

func (l *fileLog) open(path string, max int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
	l.path, l.max = path, max
	if st, err := os.Stat(path); err == nil && st.Size() > max {
		rotateFile(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	l.f = f
	if st != nil {
		l.size = st.Size()
	}
	return nil
}

// rotateFile keeps one older file: launcher.log -> launcher.1.log.
func rotateFile(path string) {
	ext := filepath.Ext(path)
	old := strings.TrimSuffix(path, ext) + ".1" + ext
	os.Remove(old)
	os.Rename(path, old)
}

func (l *fileLog) printf(format string, a ...any) {
	l.line(fmt.Sprintf(format, a...))
}

func (l *fileLog) line(msg string) { l.lineAt(time.Now(), msg) }

// lineAt writes msg stamped with the time it happened (lines that reach the
// file later through the engine log's writer keep their own time). One call is
// always one log entry: control characters are escaped and the lines after the
// first (a stack trace) are indented, so no text that reaches the log (a
// request, a friend's name, a tool's output) can forge a separate, timestamped
// line. Very long messages are cut, so rotation keeps working.
func (l *fileLog) lineAt(at time.Time, msg string) {
	msg = cleanLogText(strings.TrimRight(msg, "\r\n"))
	if msg == "" {
		return
	}
	stamp := at.Format("2006-01-02 15:04:05.000")
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	if l.max > 0 && l.size > l.max {
		l.f.Close()
		rotateFile(l.path)
		f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			l.f = nil
			return
		}
		l.f, l.size = f, 0
	}
	n, _ := fmt.Fprintf(l.f, "%s %s\n", stamp, msg)
	l.size += int64(n)
}

// maxLogMessage caps one log entry (a request summary, a stack trace).
const maxLogMessage = 64 << 10

// cleanLogText makes msg safe to write as one entry (see lineAt).
func cleanLogText(msg string) string {
	cut := 0
	if len(msg) > maxLogMessage {
		cut = len(msg) - maxLogMessage
		msg = strings.ToValidUTF8(msg[:maxLogMessage], "")
	}
	bad := func(r rune) bool { return r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x2028 || r == 0x2029 }
	if strings.IndexFunc(msg, bad) >= 0 {
		var b strings.Builder
		b.Grow(len(msg) + 16)
		for _, r := range msg {
			switch {
			case r == '\n':
				b.WriteString("\n    ")
			case r == '\t':
				b.WriteByte('\t')
			case r == '\r':
			case bad(r):
				fmt.Fprintf(&b, "\\x%02x", r)
			default:
				b.WriteRune(r)
			}
		}
		msg = b.String()
	}
	if cut > 0 {
		msg += fmt.Sprintf(" … (%d more bytes not logged)", cut)
	}
	return msg
}

// Write lets the log be used by log.Logger (http.Server's ErrorLog).
func (l *fileLog) Write(p []byte) (int, error) {
	l.line(string(p))
	return len(p), nil
}

func (l *fileLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Sync()
		l.f.Close()
		l.f = nil
	}
}

func (l *fileLog) filePath() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.path
}

// setupCrashLog sends the Go runtime's crash report (an unrecovered panic or a
// fatal error, with every goroutine's stack) to logs\crash.log. The file is
// kept open for the life of the process.
func setupCrashLog(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	p := filepath.Join(dir, "crash.log")
	if st, err := os.Stat(p); err == nil && st.Size() > logRotateBytes {
		rotateFile(p)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// goSafe runs fn in a goroutine; a panic is written to the launcher log
// (with its stack) instead of ending the launcher.
func goSafe(name string, fn func()) {
	go func() {
		defer recoverLog(name)
		fn()
	}()
}

func recoverLog(name string) {
	if v := recover(); v != nil {
		launcherLog.printf("[launcher] PANIC in %s (recovered, the launcher keeps running): %v\n%s", name, v, debug.Stack())
	}
}

// startupLine describes this launcher for the log.
func startupLine() string {
	exe, _ := os.Executable()
	return fmt.Sprintf("[launcher] Glow Studio %s starting (pid %d, %s/%s, %s, %s)", launcherVersion, os.Getpid(), runtime.GOOS, runtime.GOARCH, runtime.Version(), exe)
}

// ---- requests ----

// reqStats counts requests per kind; a summary goes to the launcher log every
// few minutes (never the content of a request: no prompts, no file names, no
// paths). The kinds are a fixed list (requestGroup), so a stranger sending
// made-up paths to the friends' page can't make the summary grow.
type reqStats struct {
	label  string
	mu     sync.Mutex
	counts map[string]int
	errs   map[string]int
	slow   map[string]int
	since  time.Time
}

var (
	requests      = &reqStats{label: "requests"}
	guestRequests = &reqStats{label: "friends' page requests"} // the guest server (guestserver.go)
)

// flushRequests writes both summaries.
func flushRequests() {
	requests.flush()
	guestRequests.flush()
}

// maxRequestGroups caps the kinds in one summary (the rest are "other").
const maxRequestGroups = 200

var (
	engineGroups = map[string]bool{"status": true, "install": true, "cancel": true, "start": true, "stop": true, "cleanup": true, "hold": true, "open-logs": true}
	guestGroups  = map[string]bool{"hello": true, "join": true, "session": true, "name": true, "plan": true, "jobs": true, "jobs/current": true, "claim": true, "leave": true}
	shareGroups  = map[string]bool{"status": true, "start": true, "stop": true, "settings": true, "new-link": true, "relink": true}
	comfyGroups  = map[string]bool{"prompt": true, "history": true, "view": true, "upload": true, "queue": true, "interrupt": true, "ws": true,
		"object_info": true, "system_stats": true, "free": true, "embeddings": true, "extensions": true, "api": true}
)

// requestGroup maps a request path to one of a fixed set of kinds.
func requestGroup(path string) string {
	switch {
	case path == "/__glow/ping":
		return "ping"
	case path == "/__glow/version" || path == "/__glow/quit":
		return strings.TrimPrefix(path, "/__glow/")
	case strings.HasPrefix(path, "/__glow/engine/"):
		if rest := strings.TrimPrefix(path, "/__glow/engine/"); engineGroups[rest] {
			return "engine/" + rest
		}
		return "engine/other"
	case strings.HasPrefix(path, "/__glow/guest/"):
		rest := strings.TrimPrefix(path, "/__glow/guest/")
		if guestGroups[rest] {
			return "guest/" + rest
		}
		if p := strings.Split(rest, "/"); p[0] == "jobs" && len(p) >= 2 && p[1] != "" {
			switch {
			case len(p) == 2:
				return "guest/jobs/*"
			case len(p) == 3 && (p[2] == "cancel" || p[2] == "done"):
				return "guest/jobs/*/" + p[2]
			case len(p) == 4 && p[2] == "files":
				return "guest/jobs/*/files"
			}
		}
		return "guest/other"
	case strings.HasPrefix(path, "/__glow/share/"):
		rest := strings.TrimPrefix(path, "/__glow/share/")
		if shareGroups[rest] {
			return "share/" + rest
		}
		if p := strings.Split(rest, "/"); len(p) == 3 && p[1] != "" {
			switch {
			case p[0] == "guests" && p[2] == "block":
				return "share/guests/*/block"
			case p[0] == "jobs" && (p[2] == "approve" || p[2] == "decline" || p[2] == "cancel" || p[2] == "thumb"):
				return "share/jobs/*/" + p[2]
			}
		}
		return "share/other"
	case strings.HasPrefix(path, "/__glow/comfy/"):
		rest := strings.TrimPrefix(path, "/__glow/comfy/")
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			rest = rest[:i]
		}
		if comfyGroups[rest] {
			return "comfy/" + rest
		}
		return "comfy/other"
	case strings.HasPrefix(path, "/__glow/"):
		return "other"
	}
	return "page"
}

func (s *reqStats) add(group string, code int, d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.counts == nil {
		s.counts, s.errs, s.slow, s.since = map[string]int{}, map[string]int{}, map[string]int{}, time.Now()
	}
	if _, ok := s.counts[group]; !ok && len(s.counts) >= maxRequestGroups {
		group = "other"
	}
	s.counts[group]++
	if code >= 400 {
		s.errs[group]++
	}
	if d > 2*time.Second && !strings.HasPrefix(group, "comfy/") && !strings.HasSuffix(group, "/files") && group != "guest/jobs" { // downloads and uploads may take long
		s.slow[group]++
	}
}

// flush writes and resets the summary ("" when there were no requests).
func (s *reqStats) flush() string {
	s.mu.Lock()
	counts, errs, slow, since := s.counts, s.errs, s.slow, s.since
	s.counts, s.errs, s.slow = nil, nil, nil
	s.mu.Unlock()
	if len(counts) == 0 {
		return ""
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	label := s.label
	if label == "" {
		label = "requests"
	}
	fmt.Fprintf(&b, "[http] %s in the last %s:", label, time.Since(since).Round(time.Second))
	for _, k := range keys {
		fmt.Fprintf(&b, " %s %d", k, counts[k])
		if errs[k] > 0 {
			fmt.Fprintf(&b, " (%d failed)", errs[k])
		}
		if slow[k] > 0 {
			fmt.Fprintf(&b, " (%d slow)", slow[k])
		}
	}
	line := b.String()
	launcherLog.line(line)
	return line
}

// statusWriter records the status code; Unwrap lets http.ResponseController
// (used by the reverse proxy for WebSocket upgrades and flushing) reach the
// real ResponseWriter.
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		w.code = http.StatusSwitchingProtocols
		return h.Hijack()
	}
	return nil, nil, errors.New("hijack not supported")
}

// logRequests counts every request, and writes the launcher's own actions
// (install, start, stop, cleanup, …) and slow status answers to the log. Only
// the request's kind is written, never its path (the path is the sender's text).
func logRequests(next http.Handler) http.Handler { return countRequests(requests, true, next) }

// countRequests is logRequests with its own summary; host is false for the
// friends' page (its actions are logged by share.go as [share] lines).
func countRequests(stats *reqStats, host bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		d := time.Since(t0)
		g := requestGroup(r.URL.Path)
		code := sw.code
		if code == 0 {
			code = http.StatusOK
		}
		stats.add(g, code, d)
		if !host {
			return
		}
		switch {
		case (strings.HasPrefix(g, "engine/") || strings.HasPrefix(g, "share/")) && r.Method == http.MethodPost:
			launcherLog.printf("[http] POST /__glow/%s -> %d (%s)", g, code, d.Round(time.Millisecond))
		case g == "engine/status" && d > time.Second:
			launcherLog.printf("[http] status took %s", d.Round(time.Millisecond))
		case strings.HasPrefix(g, "comfy/") && code >= 500:
			launcherLog.printf("[http] %s %s -> %d", sanitizeMethod(r.Method), g, code)
		}
	})
}

// sanitizeMethod: the method as sent, if it is a plain token.
func sanitizeMethod(m string) string {
	if len(m) > 12 || strings.IndexFunc(m, func(r rune) bool { return r < 'A' || r > 'Z' }) >= 0 {
		return "OTHER"
	}
	return m
}
