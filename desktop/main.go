// Glow Studio desktop launcher: serves the bundled web app on 127.0.0.1
// and opens it in an app window (Edge/Chrome) or the default browser.
// It quits by itself a few minutes after the app window is closed.
package main

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed glow
var bundle embed.FS

const preferredPort = 47821
const idleExit = 3 * time.Minute

// Each open app page pings every 15 s; background tabs may slow this to once a minute.
const heartbeat = `<script>(function(){function p(){fetch('/__glow/ping',{cache:'no-store'}).catch(function(){})}p();setInterval(p,15000)})();</script>`

var lastPing atomic.Int64

func main() {
	app, err := fs.Sub(bundle, "glow")
	if err != nil {
		fatal("The app files are missing from this program.", err)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferredPort))
	if err != nil {
		// Already running? Then just open another window on it.
		if alreadyRunning(preferredPort) {
			openApp(fmt.Sprintf("http://127.0.0.1:%d/", preferredPort))
			return
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("Glow Studio could not start its local server.", err)
		}
	}
	url := fmt.Sprintf("http://%s/", ln.Addr().String())

	index, err := fs.ReadFile(app, "index.html")
	if err != nil {
		fatal("The app files are missing from this program.", err)
	}
	index = bytes.Replace(index, []byte("</body>"), []byte(heartbeat+"</body>"), 1)

	files := http.FileServer(http.FS(app))
	mux := http.NewServeMux()
	mux.HandleFunc("/__glow/ping", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().UnixNano())
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("glow-studio"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(index)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		files.ServeHTTP(w, r)
	})

	lastPing.Store(time.Now().UnixNano())
	go func() {
		for range time.Tick(10 * time.Second) {
			if time.Since(time.Unix(0, lastPing.Load())) > idleExit {
				os.Exit(0)
			}
		}
	}()

	go openApp(url)
	if err := http.Serve(ln, mux); err != nil {
		fatal("Glow Studio's local server stopped.", err)
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
	showError(msg + "\n\n" + err.Error())
	os.Exit(1)
}
