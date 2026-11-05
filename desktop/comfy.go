package main

// Runs the private ComfyUI (Windows portable) headless and watches it.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const preferredComfyPort = 47822 // not 8188, so a user's own ComfyUI does not clash
const startTimeout = 15 * time.Minute

// ringLog keeps the last lines of ComfyUI and installer output for "Details",
// and mirrors them to <installDir>\logs\engine.log for support.
type ringLog struct {
	mu    sync.Mutex
	lines []string
	max   int
	file  *os.File
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
var progressRe = regexp.MustCompile(`^\s*(\S+:\s*)?\d{1,3}%\|`)

func (r *ringLog) add(line string) {
	line = strings.TrimSpace(ansiRe.ReplaceAllString(line, ""))
	if line == "" {
		return
	}
	if rs := []rune(line); len(rs) > 400 {
		line = string(rs[:400]) + "…"
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file != nil {
		fmt.Fprintf(r.file, "%s %s\n", time.Now().Format("15:04:05"), line)
	}
	// tqdm progress bars rewrite one line many times: keep only the latest.
	if n := len(r.lines); n > 0 && progressRe.MatchString(line) && progressRe.MatchString(r.lines[n-1]) {
		r.lines[n-1] = line
		return
	}
	r.lines = append(r.lines, line)
	if len(r.lines) > r.max {
		r.lines = append([]string(nil), r.lines[len(r.lines)-r.max:]...)
	}
}

func (r *ringLog) addf(format string, a ...any) { r.add(fmt.Sprintf(format, a...)) }

func (r *ringLog) last(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n > len(r.lines) {
		n = len(r.lines)
	}
	return append([]string{}, r.lines[len(r.lines)-n:]...)
}

func (r *ringLog) openFile(dir string) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	p := filepath.Join(dir, "engine.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 20<<20 {
		os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	r.mu.Lock()
	if r.file != nil {
		r.file.Close()
	}
	r.file = f
	r.mu.Unlock()
}

// pump splits process output into lines on \n, \r (tqdm) and \b (7-Zip progress).
func (r *ringLog) pump(rd io.Reader, onLine func(string)) {
	br := bufio.NewReaderSize(rd, 64<<10)
	var cur []byte
	for {
		b, err := br.ReadByte()
		if err != nil {
			if len(cur) > 0 {
				onLine(string(cur))
			}
			return
		}
		if b == '\n' || b == '\r' || b == '\b' {
			if len(cur) > 0 {
				onLine(string(cur))
				cur = cur[:0]
			}
			continue
		}
		if len(cur) < 8192 {
			cur = append(cur, b)
		}
	}
}

type comfyProc struct {
	cmd      *exec.Cmd
	port     int
	done     chan struct{} // closed when the process has exited
	stopping bool          // stopped on purpose: state becomes "stopped"
	failMsg  string        // killed by the launcher because of this problem
}

func freePort(preferred int) (int, error) {
	if preferred > 0 {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred)); err == nil {
			ln.Close()
			return preferred, nil
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func comfyEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k := strings.ToUpper(strings.SplitN(kv, "=", 2)[0])
		// A system Python's settings would break the embedded Python.
		if k == "PYTHONHOME" || k == "PYTHONPATH" || k == "PYTHONSTARTUP" || k == "PYTHONIOENCODING" || k == "PYTHONUNBUFFERED" {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "PYTHONIOENCODING=utf-8", "PYTHONUNBUFFERED=1")
}

// comfyArgs are the ComfyUI flags from the launcher contract. Stock defaults
// otherwise: no --lowvram/--highvram (Dynamic VRAM handles the 8 GB card) and
// never --enable-cors-header (the launcher proxies ComfyUI under its own origin).
func comfyArgs(port int) []string {
	return []string{"--windows-standalone-build", "--listen", "127.0.0.1", "--port", strconv.Itoa(port), "--disable-auto-launch"}
}

// startEngine launches ComfyUI. It returns quickly; readiness is tracked in
// the background ("starting" until GET /system_stats answers).
func (e *Engine) startEngine() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.proc != nil && (e.state == "starting" || e.state == "ready") {
		return nil
	}
	if !e.coreInstalledLocked() {
		return friendly(nil, "The AI engine is not installed yet.")
	}
	root := filepath.Join(e.installDir, portableDir)
	preferred := preferredComfyPort
	if v, err := strconv.Atoi(os.Getenv("GLOW_COMFY_PORT")); err == nil && v > 0 {
		preferred = v
	}
	port, err := freePort(preferred)
	if err != nil {
		return friendly(err, "Glow Studio could not find a free local port for the AI engine.")
	}
	var cmd *exec.Cmd
	if custom := strings.Fields(os.Getenv("GLOW_COMFY_CMD")); len(custom) > 0 {
		cmd = exec.Command(custom[0], append(custom[1:], comfyArgs(port)...)...)
	} else {
		args := append([]string{"-s", filepath.Join("ComfyUI", "main.py")}, comfyArgs(port)...)
		cmd = exec.Command(pythonExe(root), args...)
	}
	if st, err := os.Stat(root); err == nil && st.IsDir() {
		cmd.Dir = root
	} else {
		cmd.Dir = e.installDir
	}
	cmd.Env = comfyEnv()
	hideWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout // one ordered stream
	e.logs.openFile(filepath.Join(e.installDir, "logs"))
	e.logs.addf("[launcher] starting the AI engine on 127.0.0.1:%d", port)
	if err := cmd.Start(); err != nil {
		e.state, e.engErr = "error", "The AI engine could not be started: "+err.Error()+". Try installing again (it only repairs what is missing)."
		e.logs.addf("[launcher] start failed: %v", err)
		return friendly(err, e.engErr)
	}
	afterStart(cmd)
	p := &comfyProc{cmd: cmd, port: port, done: make(chan struct{})}
	e.proc, e.state, e.engErr, e.comfyPort, e.runningVersion, e.dynVRAM = p, "starting", "", port, "", nil
	e.startedAt = time.Now()

	go e.logs.pump(stdout, func(line string) {
		e.logs.add(line)
		if strings.Contains(line, "DynamicVRAM support detected and enabled") {
			e.mu.Lock()
			t := true
			e.dynVRAM = &t
			e.mu.Unlock()
		}
	})
	go func() {
		err := cmd.Wait()
		e.mu.Lock()
		close(p.done)
		if e.proc == p {
			e.proc, e.comfyPort = nil, 0
			if p.failMsg != "" {
				e.state, e.engErr = "error", p.failMsg
			} else if p.stopping {
				e.state = "stopped"
			} else {
				e.state = "error"
				e.engErr = explainCrash(e.logs.last(40), err, e.wasReadyLocked(p))
				e.logs.addf("[launcher] the AI engine stopped: %v", err)
			}
		}
		e.mu.Unlock()
	}()
	go e.waitReady(p)
	return nil
}

func (e *Engine) wasReadyLocked(p *comfyProc) bool { return e.readyProc == p }

func (e *Engine) waitReady(p *comfyProc) {
	c := http.Client{Timeout: 3 * time.Second}
	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-p.done:
			return
		case <-time.After(time.Second):
		}
		resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/system_stats", p.port))
		if err != nil {
			continue
		}
		var stats struct {
			System struct {
				ComfyVersion string `json:"comfyui_version"`
			} `json:"system"`
		}
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&stats) == nil
		resp.Body.Close()
		if !ok {
			continue
		}
		e.mu.Lock()
		if e.proc == p && e.state == "starting" {
			e.state, e.readyProc = "ready", p
			e.runningVersion = stats.System.ComfyVersion
			e.logs.addf("[launcher] the AI engine is ready (ComfyUI %s, started in %s)", stats.System.ComfyVersion, time.Since(e.startedAt).Round(time.Second))
		}
		e.mu.Unlock()
		return
	}
	e.mu.Lock()
	timedOut := e.proc == p && e.state == "starting"
	if timedOut {
		p.failMsg = "The AI engine took too long to start. Restart the PC, then press Start again."
		e.logs.add("[launcher] the AI engine did not become ready in time")
	}
	e.mu.Unlock()
	if timedOut {
		killTree(p.cmd)
	}
}

// stopEngine kills ComfyUI and everything it started.
func (e *Engine) stopEngine() {
	e.mu.Lock()
	p := e.proc
	if p == nil {
		if e.state == "error" || e.state == "starting" || e.state == "ready" {
			e.state, e.engErr = "stopped", ""
		}
		e.mu.Unlock()
		return
	}
	p.stopping = true
	e.mu.Unlock()
	e.logs.add("[launcher] stopping the AI engine")
	killTree(p.cmd)
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
	}
	e.mu.Lock()
	if e.proc == p { // Wait never returned: forget it anyway
		e.proc, e.comfyPort = nil, 0
	}
	e.state, e.engErr = "stopped", ""
	e.mu.Unlock()
}

// comfyBusy reports whether ComfyUI has prompts running or queued.
func (e *Engine) comfyBusy() bool {
	e.mu.Lock()
	port, state := e.comfyPort, e.state
	e.mu.Unlock()
	if port == 0 || state != "ready" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/queue", port), nil)
	resp, err := localClient.Do(req)
	if err != nil {
		// ComfyUI's web server keeps answering while it renders; no answer
		// right after a busy one is treated as still busy, once.
		e.mu.Lock()
		busy := time.Since(e.lastBusy) < 30*time.Second
		e.mu.Unlock()
		return busy
	}
	defer resp.Body.Close()
	var q struct {
		Running []json.RawMessage `json:"queue_running"`
		Pending []json.RawMessage `json:"queue_pending"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&q) != nil {
		return false
	}
	busy := len(q.Running) > 0 || len(q.Pending) > 0
	if busy {
		e.mu.Lock()
		e.lastBusy = time.Now()
		e.mu.Unlock()
	}
	return busy
}

var localClient = &http.Client{Transport: &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 4}}

// explainCrash turns the last log lines into advice for a non-technical user.
func explainCrash(lines []string, err error, wasReady bool) string {
	all := strings.ToLower(strings.Join(lines, "\n"))
	has := func(s ...string) bool {
		for _, x := range s {
			if strings.Contains(all, x) {
				return true
			}
		}
		return false
	}
	switch {
	case has("c10.dll", "winerror 126", "vcruntime140", "msvcp140"):
		return "Windows is missing a free Microsoft component (Visual C++ Redistributable). Install it from https://aka.ms/vc14/vc_redist.x64.exe, then press Start again."
	case has("nvidia driver on your system is too old", "driver version is insufficient", "cuda driver version is insufficient"):
		return "Your NVIDIA driver is too old for the AI engine. Update it from https://www.nvidia.com/Download/index.aspx, restart the PC, then press Start again."
	case has("no cuda gpus are available", "torch not compiled with cuda", "found no nvidia driver", "no nvidia gpu"):
		return "No compatible NVIDIA graphics card was found. The free AI engine needs an NVIDIA RTX card with an up-to-date driver."
	case has("winerror 1455", "paging file is too small"):
		return "Windows ran out of memory (the paging file is too small). Close other programs, let Windows manage the paging file size automatically, then press Start again."
	case has("out of memory", "outofmemoryerror", "cuda error: out of memory"):
		return "The graphics card ran out of memory. Close games and other heavy programs, then press Start again."
	case has("address already in use", "winerror 10048", "only one usage of each socket address"):
		return "Another program was using the AI engine's port. Press Start again."
	case has("modulenotfounderror", "importerror", "no such file or directory", "can't open file"):
		return "Some AI engine files are missing or damaged. Press Install to repair (only missing files are downloaded)."
	}
	if wasReady {
		return "The AI engine stopped unexpectedly. Press Start to run it again. If this keeps happening, close other programs and open Details."
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return fmt.Sprintf("The AI engine could not start (exit code %d). Press Start to try again; open Details to see what happened.", ee.ExitCode())
	}
	return "The AI engine could not start. Press Start to try again; open Details to see what happened."
}
