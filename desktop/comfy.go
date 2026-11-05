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
	if e.job != nil && e.job.Repair && e.job.state() == "running" {
		return friendly(nil, "Glow Studio is checking the AI files. Please wait until it is finished.")
	}
	if err := e.lockDirLocked(e.installDir); err != nil {
		return err
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
	// Our own pipe (not StdoutPipe): Wait must not close it while the last
	// lines, which say why ComfyUI stopped, are still being read.
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = pw, pw // one ordered stream
	e.logs.openFile(filepath.Join(e.installDir, "logs"))
	e.logs.addf("[launcher] starting the AI engine on 127.0.0.1:%d", port)
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		e.state, e.engErr = "error", "The AI engine could not be started ("+err.Error()+"). Press “Check & repair files”; if that does not help, your antivirus may be blocking it."
		e.logs.addf("[launcher] start failed: %v", err)
		return friendly(err, e.engErr)
	}
	pw.Close() // the child has its own copy
	afterStart(cmd)
	// Privacy: selfies and unlabelled outputs a closed page could not clean up.
	go func(dir string) {
		if n := sweepOldFiles(dir, sweepAge); n > 0 {
			e.logs.addf("[launcher] removed %d old AI copies of selfies and videos", n)
		}
	}(e.installDir)
	p := &comfyProc{cmd: cmd, port: port, done: make(chan struct{})}
	e.proc, e.state, e.engErr, e.comfyPort, e.runningVersion, e.dynVRAM = p, "starting", "", port, "", nil
	e.startedAt, e.qBusy, e.qFailSince = time.Now(), false, time.Time{}
	installDir := e.installDir

	pumped := make(chan struct{})
	go func() {
		defer close(pumped)
		defer pr.Close()
		e.logs.pump(pr, func(line string) {
			e.logs.add(line)
			if strings.Contains(line, "DynamicVRAM support detected and enabled") {
				e.mu.Lock()
				t := true
				e.dynVRAM = &t
				e.mu.Unlock()
			}
		})
	}()
	go func() {
		err := cmd.Wait()
		// Everything ComfyUI printed is in the pipe now: read it to the end
		// before explaining the crash. (A child process that inherited the
		// pipe could keep it open, so do not wait for ever.)
		select {
		case <-pumped:
		case <-time.After(5 * time.Second):
		}
		lines := e.logs.last(60)
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
				c10 := filepath.Join(installDir, portableDir, "python_embeded", "Lib", "site-packages", "torch", "lib", "c10.dll")
				c10Missing := os.Getenv("GLOW_COMFY_CMD") == "" && !fileExists(c10)
				msg, damaged := explainCrash(lines, err, e.wasReadyLocked(p), c10Missing)
				e.engErr = msg
				e.logs.addf("[launcher] the AI engine stopped: %v", err)
				if damaged && samePath(installDir, e.installDir) {
					// "Check & repair files" will unpack the engine again.
					e.man.EngineSuspect = true
					e.man.save(installDir)
				}
			}
		}
		e.mu.Unlock()
	}()
	go e.waitReady(p)
	return nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

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
		ready := e.proc == p && e.state == "starting"
		if ready {
			e.state, e.readyProc = "ready", p
			e.runningVersion = stats.System.ComfyVersion
			e.logs.addf("[launcher] the AI engine is ready (ComfyUI %s, started in %s)", stats.System.ComfyVersion, time.Since(e.startedAt).Round(time.Second))
		}
		e.mu.Unlock()
		if ready {
			go e.watchQueue(p)
		}
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

// How long a ComfyUI that is alive but does not answer /queue still counts as
// busy: while loading 14 GB of weights under memory pressure it can be slow to
// answer for a while. After a "rendering" answer this is generous; after an
// "idle" one it only covers a prompt that might have started since.
const (
	busyNoAnswerAfterBusy = 20 * time.Minute
	busyNoAnswerAfterIdle = 2 * time.Minute
)

var busyLinger = 20 * time.Second // busy for this long after the last sign of work (tests shorten it)

// watchQueue asks ComfyUI every few seconds (all the time, not only once the
// window is closed) whether prompts are running or queued, so the idle exit has
// a fresh answer and never kills a render.
func (e *Engine) watchQueue(p *comfyProc) {
	every := 5 * time.Second
	if v, err := strconv.Atoi(os.Getenv("GLOW_QUEUE_POLL_MS")); err == nil && v > 0 {
		every = time.Duration(v) * time.Millisecond
	}
	timeout := 2 * every
	if timeout < 3*time.Second {
		timeout = 3 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		busy, err := queueBusy(p.port, timeout)
		e.mu.Lock()
		if e.proc != p {
			e.mu.Unlock()
			return
		}
		if err != nil {
			if e.qFailSince.IsZero() {
				e.qFailSince = time.Now()
			}
		} else {
			e.qFailSince, e.qBusy = time.Time{}, busy
			if busy {
				e.lastBusy = time.Now()
			}
		}
		e.mu.Unlock()
		select {
		case <-p.done:
			return
		case <-t.C:
		}
	}
}

func queueBusy(port int, timeout time.Duration) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/queue", port), nil)
	resp, err := localClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var q struct {
		Running []json.RawMessage `json:"queue_running"`
		Pending []json.RawMessage `json:"queue_pending"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&q); err != nil {
		return false, err
	}
	return len(q.Running) > 0 || len(q.Pending) > 0, nil
}

// markBusy: a prompt was just posted through the proxy.
func (e *Engine) markBusy() {
	e.mu.Lock()
	e.lastBusy = time.Now()
	e.mu.Unlock()
}

// renderingNow asks ComfyUI itself whether a prompt is running or queued
// (for decisions taken now, like a repair); if it does not answer, the
// idle-exit view (comfyBusy) decides.
func (e *Engine) renderingNow() bool {
	e.mu.Lock()
	port, ready := e.comfyPort, e.proc != nil && e.state == "ready"
	e.mu.Unlock()
	if !ready {
		return false
	}
	busy, err := queueBusy(port, 3*time.Second)
	if err != nil {
		return e.comfyBusy()
	}
	return busy
}

// comfyBusy reports whether ComfyUI has prompts running or queued (from
// watchQueue; it never waits for ComfyUI itself). It errs on the side of
// "busy": it is what keeps the idle exit from killing a render.
func (e *Engine) comfyBusy() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.proc == nil || e.state != "ready" {
		return false
	}
	if time.Since(e.lastBusy) < busyLinger {
		return true
	}
	if !e.qFailSince.IsZero() { // alive, but /queue does not answer
		limit := busyNoAnswerAfterIdle
		if e.qBusy {
			limit = busyNoAnswerAfterBusy
		}
		return time.Since(e.qFailSince) < limit
	}
	return e.qBusy
}

var localClient = &http.Client{Transport: &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 4}}

const msgEngineDamaged = "Some AI engine files are missing or damaged (antivirus programs sometimes remove them). Press “Check & repair files”: Glow Studio checks every file and downloads the AI engine again if needed (about 2 GB; your AI models are kept)."

// explainCrash turns the last log lines into advice for a non-technical user.
// damaged is true when engine files are missing (the next repair unpacks the
// engine again). c10Missing: PyTorch's c10.dll is not on disk, so a "could not
// load c10.dll" error is a removed file, not a missing Microsoft component.
func explainCrash(lines []string, err error, wasReady, c10Missing bool) (msg string, damaged bool) {
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
	case has("c10.dll", "winerror 126", "vcruntime140", "msvcp140", "dll load failed") && c10Missing:
		return msgEngineDamaged, true
	case has("c10.dll", "winerror 126", "vcruntime140", "msvcp140", "dll load failed"):
		return "Windows is missing a free Microsoft component (Visual C++ Redistributable). Install it from https://aka.ms/vc14/vc_redist.x64.exe, then press Start again.", false
	case has("nvidia driver on your system is too old", "driver version is insufficient", "cuda driver version is insufficient"):
		return "Your NVIDIA driver is too old for the AI engine. Update it from https://www.nvidia.com/Download/index.aspx, restart the PC, then press Start again.", false
	case has("no cuda gpus are available", "torch not compiled with cuda", "found no nvidia driver", "no nvidia gpu"):
		return "No compatible NVIDIA graphics card was found. The free AI engine needs an NVIDIA RTX card with an up-to-date driver.", false
	case has("winerror 1455", "paging file is too small"):
		return "Windows ran out of memory (the paging file is too small). Close other programs, let Windows manage the paging file size automatically, then press Start again.", false
	case has("out of memory", "outofmemoryerror", "cuda error: out of memory"):
		return "The graphics card ran out of memory. Close games and other heavy programs, then press Start again.", false
	case has("address already in use", "winerror 10048", "only one usage of each socket address"):
		return "Another program was using the AI engine's port. Press Start again.", false
	case has("modulenotfounderror", "no module named", "importerror", "no such file or directory", "can't open file"):
		return msgEngineDamaged, true
	}
	if wasReady {
		return "The AI engine stopped unexpectedly. Press Start to run it again. If this keeps happening, close other programs and open Details.", false
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return fmt.Sprintf("The AI engine could not start (exit code %d). Press Start to try again; open Details to see what happened.", ee.ExitCode()), false
	}
	return "The AI engine could not start. Press Start to try again; open Details to see what happened.", false
}
