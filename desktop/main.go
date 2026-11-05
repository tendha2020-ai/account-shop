// Glow Studio desktop launcher: serves the bundled web app on 127.0.0.1
// and opens it in an app window (Edge/Chrome) or the default browser.
// It quits by itself a few minutes after the app window is closed, unless the
// free local AI engine is still busy (install running or ComfyUI rendering).
package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed glow
var bundle embed.FS

const preferredPort = 47821
const idleExit = 3 * time.Minute

// Each open app page pings every 15 s; background tabs may slow this to once a minute.
const heartbeat = `<script>(function(){function p(){fetch('/__glow/ping',{cache:'no-store'}).catch(function(){})}p();setInterval(p,15000)})();</script>`

var lastPing atomic.Int64

// onExit is run before the launcher quits (stops the local AI engine).
var onExit = func() {}

func main() {
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
	var ln net.Listener
	for _, p := range ports {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			ln = l
			break
		}
		// Already running? Then just open another window on it.
		if alreadyRunning(p) {
			openApp(fmt.Sprintf("http://127.0.0.1:%d/", p))
			return
		}
	}
	if ln == nil {
		// A copy that had to take a random port records it in instance.json.
		if p := readInstancePort(); p > 0 && alreadyRunning(p) {
			openApp(fmt.Sprintf("http://127.0.0.1:%d/", p))
			return
		}
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("Glow Studio could not start its local server.", err)
		}
		ln = l
	}
	myPort := ln.Addr().(*net.TCPAddr).Port
	writeInstancePort(myPort)
	url := fmt.Sprintf("http://%s/", ln.Addr().String())

	index, err := fs.ReadFile(app, "index.html")
	if err != nil {
		fatal("The app files are missing from this program.", err)
	}
	index = withHeartbeat(index)

	engine := newEngine(myPort)
	onExit = func() {
		engine.Shutdown()
		removeInstancePort(myPort)
	}

	files := http.FileServer(http.FS(app))
	mux := http.NewServeMux()
	mux.HandleFunc("/__glow/ping", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().UnixNano())
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("glow-studio"))
	})
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
	go func() {
		for range time.Tick(tick) {
			// Keep running while an install or a render is in progress, even if
			// the window was closed; quit once it is done.
			if time.Since(time.Unix(0, lastPing.Load())) > idle && !engine.Busy() {
				onExit()
				os.Exit(0)
			}
		}
	}()
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		onExit()
		os.Exit(0)
	}()

	go openApp(url)
	if err := http.Serve(ln, mux); err != nil {
		fatal("Glow Studio's local server stopped.", err)
	}
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
	onExit()
	showError(msg + "\n\n" + err.Error())
	os.Exit(1)
}
