// Glow Studio desktop launcher: serves the bundled web app on 127.0.0.1
// and opens it in an app window (Edge/Chrome) or the default browser.
//
// It quits by itself only when no app window has pinged it for 30 minutes AND
// nothing is in flight: no install, no ComfyUI render, no video or story the
// page is making (POST /__glow/engine/hold), and "Share with friends" is off
// (while sharing is on, its auto-stop timer is the limit; see share.go). After an install or a render ends,
// the 30 minutes count from that moment, so a window that slept through a long
// download still finds the launcher running. Every exit is logged with its
// reason in %LOCALAPPDATA%\GlowStudio\logs\launcher.log (see logs.go).
package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed glow
var bundle embed.FS

const preferredPort = 47821
const idleExit = 30 * time.Minute

// Each open app page pings every 15 s; background tabs may slow this to once a minute.
const heartbeat = `<script>(function(){function p(){fetch('/__glow/ping',{cache:'no-store'}).catch(function(){})}p();setInterval(p,15000)})();</script>`

var lastPing atomic.Int64

// onExit is run before the launcher quits (stops the local AI engine).
var onExit = func() {}

func main() {
	logDir := logsDir()
	if err := launcherLog.open(filepath.Join(logDir, "launcher.log"), logRotateBytes); err != nil {
		fmt.Fprintln(os.Stderr, "launcher log:", err)
	}
	if _, err := setupCrashLog(logDir); err != nil {
		launcherLog.printf("[launcher] crash log not available: %v", err)
	}
	launcherLog.line(startupLine())

	app, err := fs.Sub(bundle, "glow")
	if err != nil {
		fatal("The app files are missing from this program.", err)
	}

	// The same port every time keeps the page's origin (and so its saved
	// settings and a running video's id) the same. If 47821 is taken or blocked
	// (Hyper-V/WSL/Docker reserve port ranges), a few fixed alternatives come
	// before a random port.
	ports := []int{preferredPort, 47921, 48821, 41821}
	if v, err := strconv.Atoi(os.Getenv("GLOW_PORT")); err == nil && v > 0 {
		ports = []int{v}
	}
	ln, running, note, err := listen(ports)
	if err != nil {
		fatal("Glow Studio could not start its local server.", err)
	}
	if running != "" {
		// Already running (as new as this copy, or busy): open another window on it.
		launcherLog.printf("[launcher] Glow Studio is already running at %s: opening a window on it; this copy exits", running)
		openApp(running)
		if note != "" {
			showInfo(note)
		}
		launcherLog.close()
		return
	}
	myPort := ln.Addr().(*net.TCPAddr).Port
	writeInstancePort(myPort)
	url := fmt.Sprintf("http://%s/", ln.Addr().String())
	launcherLog.printf("[launcher] listening on %s", url)

	index, err := fs.ReadFile(app, "index.html")
	if err != nil {
		fatal("The app files are missing from this program.", err)
	}
	index = withHeartbeat(index)

	engine := newEngine(myPort)
	// Share with friends (share.go): while it is on, the launcher stays up.
	share := newShare(engine, app)
	engine.shareBusy = share.BusyReason
	onExit = func() {
		share.Shutdown()
		engine.Shutdown()
		removeInstancePort(myPort)
	}

	files := http.FileServer(http.FS(app))
	mux := http.NewServeMux()
	mux.HandleFunc("/__glow/ping", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().UnixNano())
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Glow-Version", launcherVersion)
		w.Write([]byte("glow-studio")) // (exactly this: older copies look for it)
	})
	// Updates (takeover.go): which version runs, and "quit, a newer one takes over".
	mux.HandleFunc("/__glow/version", handleVersion(engine))
	mux.HandleFunc("/__glow/quit", handleQuit(engine))
	// Free local AI engine (see engine.go and proxy.go). A page using it counts as alive.
	api, comfy := engine.apiHandler(), engine.proxyHandler()
	mux.HandleFunc("/__glow/engine/", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().UnixNano())
		api.ServeHTTP(w, r)
	})
	mux.HandleFunc("/__glow/comfy/", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().UnixNano())
		comfy.ServeHTTP(w, r)
	})
	// The host's "Share with friends" card. Friends never reach this listener:
	// they use the separate one in guestserver.go.
	mux.HandleFunc("/__glow/share/", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().UnixNano())
		if !engine.guard(w, r) {
			return
		}
		share.hostAPI(w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(index)
			return
		}
		// Other pages (e.g. engine.html, the AI setup page) get the heartbeat too.
		if name := strings.TrimPrefix(r.URL.Path, "/"); strings.HasSuffix(name, ".html") && !strings.Contains(name, "/") {
			if page, err := fs.ReadFile(app, name); err == nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.Write(withHeartbeat(page))
				return
			}
		}
		if strings.HasSuffix(r.URL.Path, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		files.ServeHTTP(w, r)
	})

	idle := idleExit
	if d, err := time.ParseDuration(os.Getenv("GLOW_IDLE_EXIT")); err == nil && d > 0 {
		idle = d // tests
	}
	tick := 10 * time.Second
	if idle < 30*time.Second {
		tick = time.Second
	}
	lastPing.Store(time.Now().UnixNano())
	goSafe("idle exit", func() {
		lastBusy := time.Now()
		wasBusy := ""
		summary := time.Now()
		for range time.Tick(tick) {
			now := time.Now()
			busy, why := engine.BusyReason()
			if busy || wasBusy != "" {
				// (the tick that sees the work has ended counts too, so the
				// idle time is always counted from after the end)
				lastBusy = now
			}
			if why != wasBusy {
				if why != "" {
					launcherLog.printf("[launcher] busy: %s", why)
				} else {
					launcherLog.printf("[launcher] nothing running any more")
				}
				wasBusy = why
			}
			if now.Sub(summary) >= 10*time.Minute {
				requests.flush()
				summary = now
			}
			if exit, reason := idleDecision(now, time.Unix(0, lastPing.Load()), lastBusy, idle, busy); exit {
				exitApp(0, reason)
			}
		}
	})
	goSafe("signals", func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		s := <-sig
		exitApp(0, "asked to stop ("+s.String()+")")
	})

	goSafe("open window", func() { openApp(url) })
	srv := &http.Server{Handler: logRequests(mux), ErrorLog: log.New(launcherLog, "[http] ", 0)}
	if err := srv.Serve(ln); err != nil {
		fatal("Glow Studio's local server stopped.", err)
	}
}

// idleDecision: quit only when nothing is in flight and neither a page ping nor
// any work happened for idle (30 minutes). reason explains the exit for the log.
func idleDecision(now, lastPing, lastBusy time.Time, idle time.Duration, busy bool) (exit bool, reason string) {
	if busy {
		return false, ""
	}
	last := lastPing
	if lastBusy.After(last) {
		last = lastBusy
	}
	if now.Sub(last) < idle {
		return false, ""
	}
	return true, fmt.Sprintf("idle exit: no Glow Studio window has been open for %s and nothing is running (last ping %s ago, last work %s ago)",
		idle, now.Sub(lastPing).Round(time.Second), now.Sub(lastBusy).Round(time.Second))
}

var exitOnce sync.Once

// exitApp logs why the launcher quits, stops the engine and exits.
func exitApp(code int, reason string) {
	exitOnce.Do(func() {
		requests.flush()
		launcherLog.printf("[launcher] exiting: %s", reason)
		onExit()
		launcherLog.printf("[launcher] stopped (exit code %d)", code)
		launcherLog.close()
		os.Exit(code)
	})
	select {} // another goroutine is already exiting
}

// listen picks the launcher's port: the first of ports that is free, unless a
// Glow Studio is already answering on one of them (running is then its URL).
// An older Glow Studio there is replaced by this one when it is idle
// (takeover.go); note is then set when the user has to wait for it. When every
// fixed port is taken by other programs, the port recorded in instance.json is
// checked (a copy that had to use a random port), and a random port is used
// otherwise. A copy that is gone (crashed, killed) leaves nothing that blocks
// a fresh start: its port is free again, and a stale instance.json is ignored
// because nothing answers the ping there.
func listen(ports []int) (ln net.Listener, running, note string, err error) {
	found := func(p int) (net.Listener, string, string, bool) {
		if !alreadyRunning(p) {
			return nil, "", "", false
		}
		if l, why := takeOver(p); l != nil {
			return l, "", "", true
		} else if alreadyRunning(p) {
			return nil, fmt.Sprintf("http://127.0.0.1:%d/", p), why, true
		}
		return nil, "", "", false // it closed after all: try the next port
	}
	for _, p := range ports {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return l, "", "", nil
		}
		if l, url, why, ok := found(p); ok {
			return l, url, why, nil
		}
		launcherLog.printf("[launcher] port %d is used by another program", p)
	}
	if p := readInstancePort(); p > 0 {
		if l, url, why, ok := found(p); ok {
			return l, url, why, nil
		}
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, "", "", err
	}
	return l, "", "", nil
}

func withHeartbeat(page []byte) []byte {
	return bytes.Replace(page, []byte("</body>"), []byte(heartbeat+"</body>"), 1)
}

type instanceInfo struct {
	Port int `json:"port"`
	PID  int `json:"pid"`
}

func readInstancePort() int {
	var in instanceInfo
	if data, err := os.ReadFile(instancePath()); err == nil && json.Unmarshal(data, &in) == nil {
		return in.Port
	}
	return 0
}

func writeInstancePort(port int) {
	p := instancePath()
	os.MkdirAll(filepath.Dir(p), 0o755)
	data, _ := json.Marshal(instanceInfo{Port: port, PID: os.Getpid()})
	os.WriteFile(p, data, 0o644)
}

func removeInstancePort(port int) {
	if readInstancePort() == port {
		os.Remove(instancePath())
	}
}

func alreadyRunning(port int) bool {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/__glow/ping", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	buf := make([]byte, 32)
	n, _ := resp.Body.Read(buf)
	return string(buf[:n]) == "glow-studio"
}

func fatal(msg string, err error) {
	if err == nil {
		err = errors.New("unknown error")
	}
	launcherLog.printf("[launcher] fatal: %s %v", msg, err)
	requests.flush()
	onExit()
	launcherLog.printf("[launcher] exiting: fatal error (exit code 1)")
	launcherLog.close()
	showError(msg + "\n\n" + err.Error())
	os.Exit(1)
}
