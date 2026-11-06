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

func (l *fileLog) line(msg string) {
	msg = strings.TrimRight(msg, "\r\n")
	if msg == "" {
		return
	}
	stamp := time.Now().Format("2006-01-02 15:04:05.000")
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
// few minutes (never the content of a request: no prompts, no file names).
type reqStats struct {
	mu     sync.Mutex
	counts map[string]int
	errs   map[string]int
	slow   map[string]int
	since  time.Time
}

var requests = &reqStats{}

func requestGroup(path string) string {
	switch {
	case path == "/__glow/ping":
		return "ping"
	case strings.HasPrefix(path, "/__glow/engine/"):
		return "engine/" + strings.TrimPrefix(path, "/__glow/engine/")
	case strings.HasPrefix(path, "/__glow/comfy/"):
		rest := strings.TrimPrefix(path, "/__glow/comfy/")
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			rest = rest[:i]
		}
		return "comfy/" + rest
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
	s.counts[group]++
	if code >= 400 {
		s.errs[group]++
	}
	if d > 2*time.Second && !strings.HasPrefix(group, "comfy/") { // ComfyUI downloads and uploads may take long
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
	fmt.Fprintf(&b, "[http] requests in the last %s:", time.Since(since).Round(time.Second))
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
// (install, start, stop, cleanup, …) and slow status answers to the log.
func logRequests(next http.Handler) http.Handler {
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
		requests.add(g, code, d)
		switch {
		case strings.HasPrefix(g, "engine/") && r.Method == http.MethodPost:
			launcherLog.printf("[http] POST %s -> %d (%s)", r.URL.Path, code, d.Round(time.Millisecond))
		case g == "engine/status" && d > time.Second:
			launcherLog.printf("[http] status took %s", d.Round(time.Millisecond))
		case strings.HasPrefix(g, "comfy/") && code >= 500:
			launcherLog.printf("[http] %s %s -> %d", r.Method, g, code)
		}
	})
}
