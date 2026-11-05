package main

// Free local AI engine: the launcher side of the contract with
// glow/local-engine.js and glow/engine.html.
//
//	GET  /__glow/engine/status    -> state of this PC, packs, engine and install job
//	POST /__glow/engine/install   {"packs":[...],"installDir"?} -> 202 | 400 | 409
//	POST /__glow/engine/cancel    -> 200 (partial downloads are kept)
//	POST /__glow/engine/start     -> 202 (ComfyUI headless, "starting" -> "ready")
//	POST /__glow/engine/stop      -> 200
//	POST /__glow/engine/cleanup   {"job":"<id>","prompts":[...]} -> 200 (deletes that video's selfie + raw outputs, see cleanup.go)
//	ANY  /__glow/comfy/<path>     -> reverse proxy to ComfyUI (see proxy.go)
//
// Test hooks (environment variables; see engine_test.go and test.sh):
//
//	GLOW_ENGINE_DIR          default install folder instead of %LOCALAPPDATA%\GlowStudio\engine
//	GLOW_ENGINE_CATALOG      JSON file replacing the built-in model table (same shape as Catalog)
//	GLOW_ENGINE_URL_REWRITE  "from=to;from2=to2" URL prefix rewrite (e.g. https://=http://127.0.0.1:8181/)
//	GLOW_SKIP_7Z=1           do not run 7zr.exe; create the portable's folder layout instead
//	GLOW_7Z_CMD              command used instead of the downloaded 7zr.exe
//	GLOW_COMFY_CMD           command used instead of python_embeded\python.exe -s ComfyUI\main.py
//	GLOW_COMFY_PORT          preferred ComfyUI port (default 47822, a free one if taken)
//	GLOW_NVIDIA_SMI          nvidia-smi replacement
//	GLOW_FAKE_DISK_FREE_GB   pretend this much disk is free
//	GLOW_DL_STALL_SEC, GLOW_DL_BACKOFF_MS   download stall timeout / first retry delay
//	GLOW_QUEUE_POLL_MS       how often ComfyUI's /queue is asked whether it renders (default 5000)
//	GLOW_PORT, GLOW_IDLE_EXIT (main.go)     launcher port / idle-exit delay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Engine struct {
	mu         sync.Mutex
	cat        *Catalog
	dl         *downloader
	defaultDir string
	configPath string
	installDir string
	man        *Manifest

	job       *Job
	jobCancel context.CancelFunc
	jobDone   chan struct{}

	proc           *comfyProc
	readyProc      *comfyProc
	state          string // "stopped" | "starting" | "ready" | "error" ("not-installed" is derived)
	engErr         string
	comfyPort      int
	runningVersion string
	dynVRAM        *bool
	startedAt      time.Time

	// What ComfyUI's /queue said (polled by watchQueue while it is ready), so
	// the idle exit never stops a render (see comfyBusy).
	lastBusy   time.Time // a prompt was seen running/queued, or was just posted
	qBusy      bool      // the last answer had running or queued prompts
	qFailSince time.Time // /queue has not answered since then (zero: it answers)

	logs *ringLog

	gpuMu   sync.Mutex
	gpu     *gpuInfo
	gpuAt   time.Time     // when gpu was detected (zero: never yet)
	gpuRun  chan struct{} // closed when the running nvidia-smi check ends
	ramOnce sync.Once
	ram     int64

	// Exclusive lock on the install folder, taken when an install or the
	// engine starts, so that two copies of the launcher (e.g. on different
	// ports) never download into or run from the same folder.
	dirUnlock func()
	lockedDir string

	port         int // the launcher's own port, for Origin/Host checks
	shutdownOnce sync.Once
}

// Manifest is <installDir>\glow-engine.json.
type Manifest struct {
	Launcher        string `json:"launcher"`
	Catalog         string `json:"catalog"`
	ComfyVersion    string `json:"comfyVersion,omitempty"`
	EngineExtracted bool   `json:"engineExtracted"`
	// Written when the engine is unpacked: how many files it has (the full list
	// is in engine-files.tsv) and a few key files with their sizes, checked on
	// every status so a quarantined DLL or Python file is noticed.
	EngineFiles int              `json:"engineFiles,omitempty"`
	EngineKey   map[string]int64 `json:"engineKey,omitempty"`
	// EngineSuspect: ComfyUI crashed in a way that means engine files are
	// missing; the next repair unpacks the engine again.
	EngineSuspect bool                  `json:"engineSuspect,omitempty"`
	Packs         map[string]PackRecord `json:"packs"`
	Files         map[string]FileRecord `json:"files"`
	Pending       []string              `json:"pending,omitempty"` // packs of an unfinished install
	PendingRepair bool                  `json:"pendingRepair,omitempty"`
	Updated       string                `json:"updated"`
}

type PackRecord struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
	At        string `json:"at"`
}

type FileRecord struct {
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256,omitempty"`
	Verified string `json:"verified"`
}

const manifestName = "glow-engine.json"

func loadManifest(dir string) *Manifest {
	m := &Manifest{}
	if data, err := os.ReadFile(filepath.Join(dir, manifestName)); err == nil {
		json.Unmarshal(data, m)
	}
	if m.Packs == nil {
		m.Packs = map[string]PackRecord{}
	}
	if m.Files == nil {
		m.Files = map[string]FileRecord{}
	}
	return m
}

func (m *Manifest) save(dir string) error {
	m.Launcher, m.Catalog, m.Updated = launcherVersion, catalogVersion, time.Now().UTC().Format(time.RFC3339)
	data, _ := json.MarshalIndent(m, "", "  ")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, manifestName+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := renameRetry(tmp, filepath.Join(dir, manifestName)); err != nil {
		return justWrittenError(err, filepath.Join(dir, manifestName))
	}
	return nil
}

// engineDefaultDir is the install folder used unless the user picks another.
func engineDefaultDir() string {
	d := os.Getenv("GLOW_ENGINE_DIR")
	if d == "" {
		d = defaultEngineDir()
	}
	return filepath.Clean(d)
}

// instancePath names the file in which a running launcher records its port
// (%LOCALAPPDATA%\GlowStudio\instance.json), so a second start opens a window
// on it even when it had to use a random port.
func instancePath() string { return filepath.Join(filepath.Dir(engineDefaultDir()), "instance.json") }

const lockName = ".glow-lock"

// lockDirLocked takes the install-folder lock (see Engine.dirUnlock).
func (e *Engine) lockDirLocked(dir string) error {
	if e.dirUnlock != nil && samePath(e.lockedDir, dir) {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dirError(err, dir)
	}
	release, err := lockFile(filepath.Join(dir, lockName))
	if errors.Is(err, errLocked) {
		return friendly(err, "Glow Studio is already running in the background and is using this AI folder. Close this window and open Glow Studio again: it opens the copy that is running.")
	}
	if err != nil {
		e.logs.addf("[launcher] could not lock %s: %v", dir, err)
		return nil // an odd file system: carry on without the lock
	}
	if e.dirUnlock != nil {
		e.dirUnlock()
	}
	e.dirUnlock, e.lockedDir = release, dir
	return nil
}

func newEngine(port int) *Engine {
	e := &Engine{port: port, state: "stopped", logs: &ringLog{max: 400}, dl: newDownloader()}
	e.cat = builtinCatalog()
	if p := os.Getenv("GLOW_ENGINE_CATALOG"); p != "" {
		if data, err := os.ReadFile(p); err == nil {
			c := &Catalog{}
			if err := json.Unmarshal(data, c); err == nil {
				for i := range c.Packs {
					if t, ok := packText[c.Packs[i].ID]; ok && c.Packs[i].Label == "" {
						c.Packs[i].Label, c.Packs[i].Desc = t[0], t[1]
					}
				}
				e.cat = c
			} else {
				fmt.Fprintln(os.Stderr, "GLOW_ENGINE_CATALOG:", err)
			}
		}
	}
	e.defaultDir = engineDefaultDir()
	e.configPath = filepath.Join(filepath.Dir(e.defaultDir), "launcher.json")
	e.installDir = e.defaultDir
	var cfg struct {
		InstallDir string `json:"installDir"`
	}
	if data, err := os.ReadFile(e.configPath); err == nil && json.Unmarshal(data, &cfg) == nil && cfg.InstallDir != "" {
		e.installDir = filepath.Clean(cfg.InstallDir)
	}
	e.man = loadManifest(e.installDir)
	if len(e.man.Pending) > 0 {
		// The last install did not finish (the app was closed): show it as
		// paused so the setup page can offer "Resume".
		j := newJob(e.man.Pending, e.installDir)
		j.Repair = e.man.PendingRepair
		j.State, j.Step = "cancelled", "Paused. Press Resume to continue."
		items, _ := e.planLocked(e.installDir, e.man, e.man.Pending)
		pb := e.progressBaseLocked(e.installDir, e.man, j.Packs, j.Repair, items)
		j.OverallTotal, j.done = pb.total, pb.done
		j.recount()
		e.job = j
	}
	e.gpuInfo(false, 0) // starts nvidia-smi in the background
	return e
}

func (e *Engine) saveConfigLocked() {
	data, _ := json.MarshalIndent(map[string]string{"installDir": e.installDir}, "", "  ")
	os.MkdirAll(filepath.Dir(e.configPath), 0o755)
	os.WriteFile(e.configPath, data, 0o644)
}

// ---- files and packs ----

func fileKey(f FileSpec) string {
	if f.Folder == "" {
		return "downloads/" + f.Name
	}
	return f.Folder + "/" + f.Name
}

func fileDest(dir string, f FileSpec) string {
	if f.Folder == "" {
		return filepath.Join(dir, "downloads", f.Name)
	}
	return filepath.Join(dir, portableDir, "ComfyUI", "models", f.Folder, f.Name)
}

// verifiedIn: the manifest says f was verified and it is still on disk with
// that size (re-hashing ~100 GB on every start would take minutes).
func verifiedIn(dir string, m *Manifest, f FileSpec) bool {
	rec, ok := m.Files[fileKey(f)]
	if !ok {
		return false
	}
	if f.SizeFlexible {
		// a newer build of an unversioned download is fine; the pinned one must match
		if rec.Size == f.Size && f.SHA256 != "" && rec.SHA256 != f.SHA256 {
			return false
		}
	} else if rec.Size != f.Size || (f.SHA256 != "" && rec.SHA256 != f.SHA256) {
		return false
	}
	st, err := os.Stat(fileDest(dir, f))
	return err == nil && st.Size() == rec.Size
}

// onDiskBytes is how much of f is already downloaded (verified or not).
func onDiskBytes(dest string, f FileSpec) int64 {
	if st, err := os.Stat(dest); err == nil && (st.Size() == f.Size || f.SizeFlexible) {
		return st.Size()
	}
	return partBytes(dest)
}

// remainingLocked is what is left to download for one pack.
func (e *Engine) remainingLocked(id string) int64 {
	p := e.cat.pack(id)
	if p == nil {
		return 0
	}
	files := p.Files
	if id == "core" && !extractedIn(e.installDir, e.man) {
		files = append([]FileSpec{e.cat.Tool, e.cat.Engine}, files...)
	}
	var need int64
	for _, f := range files {
		if !verifiedIn(e.installDir, e.man, f) {
			if left := f.Size - onDiskBytes(fileDest(e.installDir, f), f); left > 0 {
				need += left
			}
		}
	}
	return need
}

func extractedIn(dir string, m *Manifest) bool {
	if !m.EngineExtracted {
		return false
	}
	root := filepath.Join(dir, portableDir)
	if _, err := os.Stat(filepath.Join(root, "ComfyUI", "main.py")); err != nil {
		return false
	}
	if os.Getenv("GLOW_COMFY_CMD") == "" && os.Getenv("GLOW_SKIP_7Z") == "" {
		if _, err := os.Stat(pythonExe(root)); err != nil {
			return false
		}
	}
	// A few key files recorded at unpack time (Python, PyTorch's DLLs, ComfyUI
	// core): if an antivirus removed one, the engine needs unpacking again.
	for rel, size := range m.EngineKey {
		if st, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil || st.Size() != size {
			return false
		}
	}
	return true
}

func (e *Engine) packInstalledLocked(id string) bool {
	p := e.cat.pack(id)
	if p == nil {
		return false
	}
	if id == "core" && !extractedIn(e.installDir, e.man) {
		return false
	}
	for _, f := range p.Files {
		if !verifiedIn(e.installDir, e.man, f) {
			return false
		}
	}
	return true
}

func (e *Engine) coreInstalledLocked() bool { return e.packInstalledLocked("core") }

type planItem struct {
	f      FileSpec
	key    string
	dest   string
	kind   string // "tool" | "engine" | "model"
	pack   string // the tool and the engine belong to "core"
	needed bool
	onDisk int64
}

// planLocked lists what an install of packs into dir involves and how many
// bytes of disk it still needs.
func (e *Engine) planLocked(dir string, m *Manifest, packs []string) ([]planItem, int64) {
	var items []planItem
	add := func(f FileSpec, kind, pack string) {
		it := planItem{f: f, key: fileKey(f), dest: fileDest(dir, f), kind: kind, pack: pack}
		it.needed = !verifiedIn(dir, m, f)
		if it.needed {
			it.onDisk = onDiskBytes(it.dest, f)
		}
		items = append(items, it)
	}
	extracted := extractedIn(dir, m)
	if !extracted {
		add(e.cat.Tool, "tool", "core")
		add(e.cat.Engine, "engine", "core")
	}
	for _, id := range packs {
		if p := e.cat.pack(id); p != nil {
			for _, f := range p.Files {
				add(f, "model", id)
			}
		}
	}
	var need int64
	for _, it := range items {
		if it.needed && it.f.Size > it.onDisk {
			need += it.f.Size - it.onDisk
		}
	}
	if !extracted {
		need += engineUnpackedBytes
	}
	return items, need
}

type progressBase struct {
	total   int64
	done    map[string]int64
	counted map[string]bool // packs whose files make up the overall bar
}

// progressBaseLocked works out the overall progress of an install so that it
// stays the same across Resume, Try again and app restarts: it counts every file
// of the packs being installed (verified files as done; 7-Zip and the engine
// archive as done once the engine is unpacked), not only what is left. A pack
// that was installed before (adding an add-on later) does not count, unless it
// is being repaired or has files to fetch again.
func (e *Engine) progressBaseLocked(dir string, m *Manifest, packs []string, repair bool, items []planItem) progressBase {
	pb := progressBase{done: map[string]int64{}, counted: map[string]bool{}}
	for _, id := range packs {
		if repair || !m.Packs[id].Installed {
			pb.counted[id] = true
		}
	}
	for _, it := range items {
		if it.needed {
			pb.counted[it.pack] = true
		}
	}
	for _, it := range items {
		if !pb.counted[it.pack] {
			continue
		}
		pb.total += it.f.Size
		switch {
		case !it.needed && repair && it.kind == "model":
			pb.done[it.key] = 0 // hashed again by this repair
		case !it.needed:
			pb.done[it.key] = it.f.Size
		default:
			pb.done[it.key] = min(it.onDisk, it.f.Size)
		}
	}
	if pb.counted["core"] && extractedIn(dir, m) {
		n := e.cat.Tool.Size + e.cat.Engine.Size
		pb.total += n
		pb.done["engine:unpacked"] = n
	}
	return pb
}

func normalizePacks(in []string, cat *Catalog) ([]string, error) {
	seen := map[string]bool{"core": true}
	out := []string{"core"}
	for _, p := range in {
		p = strings.ToLower(strings.TrimSpace(p))
		if p == "" || seen[p] {
			continue
		}
		if cat.pack(p) == nil {
			return nil, fmt.Errorf("Unknown add-on %q.", p)
		}
		seen[p] = true
		out = append(out, p)
	}
	return out, nil
}

// validateInstallDir checks a folder the user typed. It returns the folder the
// engine will use (a bare drive like D:\ becomes D:\GlowStudio\engine).
func validateInstallDir(p string) (string, error) {
	p = strings.Trim(strings.TrimSpace(p), `"'`)
	if p == "" {
		return "", errors.New("Please choose a folder.")
	}
	if runtime.GOOS == "windows" && strings.HasPrefix(p, `\\`) {
		return "", errors.New("Please choose a folder on this PC's own drive, not a network folder.")
	}
	if !filepath.IsAbs(p) {
		return "", errors.New(`Please type the full folder path, for example D:\GlowStudio.`)
	}
	p = filepath.Clean(p)
	if filepath.Dir(p) == p { // drive root
		p = filepath.Join(p, "GlowStudio", "engine")
	}
	lower := strings.ToLower(filepath.ToSlash(p))
	parts := strings.Split(lower, "/")
	inside := func(base string) bool {
		if base == "" {
			return false
		}
		b := strings.TrimSuffix(strings.ToLower(filepath.ToSlash(filepath.Clean(base))), "/")
		return lower == b || strings.HasPrefix(lower, b+"/")
	}
	for _, part := range parts {
		if part == "onedrive" || strings.HasPrefix(part, "onedrive -") || strings.HasPrefix(part, "onedrive-") {
			return "", errors.New("Please don't use a OneDrive folder: OneDrive would try to upload about 100 GB of AI files. Choose a normal folder, for example D:\\GlowStudio.")
		}
	}
	for _, env := range []string{"OneDrive", "OneDriveConsumer", "OneDriveCommercial"} {
		if inside(os.Getenv(env)) {
			return "", errors.New("Please don't use a OneDrive folder: OneDrive would try to upload about 100 GB of AI files. Choose a normal folder, for example D:\\GlowStudio.")
		}
	}
	for _, part := range parts {
		if part == "program files" || part == "program files (x86)" {
			return "", errors.New("Please don't use Program Files: Windows blocks changes there. Choose a normal folder, for example D:\\GlowStudio.")
		}
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		if inside(os.Getenv(env)) {
			return "", errors.New("Please don't use Program Files: Windows blocks changes there. Choose a normal folder, for example D:\\GlowStudio.")
		}
	}
	for _, env := range []string{"SystemRoot", "windir"} {
		if inside(os.Getenv(env)) {
			return "", errors.New("Please don't use the Windows folder. Choose a normal folder, for example D:\\GlowStudio.")
		}
	}
	if len(p) > 100 {
		return "", errors.New(`This folder path is too long for the AI engine. Please choose a shorter one, for example D:\GlowStudio.`)
	}
	if err := platformDirCheck(p); err != nil {
		return "", err
	}
	return p, nil
}

func checkWritable(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dirError(err, dir)
	}
	probe := filepath.Join(dir, ".glow-write-test")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return dirError(err, dir)
	}
	os.Remove(probe)
	return nil
}

func existingParent(p string) string {
	p = filepath.Clean(p)
	for {
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			return p
		}
		p = parent
	}
}

func (e *Engine) freeBytes(dir string) int64 {
	if v := os.Getenv("GLOW_FAKE_DISK_FREE_GB"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int64(f * 1e9)
		}
	}
	n, err := diskFree(dir)
	if err != nil {
		return -1
	}
	return n
}

// ---- GPU ----

type gpuInfo struct {
	Name      string `json:"name"`
	VramMB    int    `json:"vramMB"`
	Driver    string `json:"driver"`
	DriverOk  bool   `json:"driverOk"`
	MinDriver string `json:"minDriver"`
}

// gpuInfo returns the last nvidia-smi result without waiting for nvidia-smi
// (which can take many seconds while a laptop GPU wakes up or a driver is
// being updated): a check runs in the background when there is no result yet,
// when it is older than 2 minutes, or on refresh ("Check again"). It waits at
// most wait for a running check. pending is true while there is no result yet.
func (e *Engine) gpuInfo(refresh bool, wait time.Duration) (g *gpuInfo, pending bool) {
	e.gpuMu.Lock()
	if (refresh || e.gpuAt.IsZero() || time.Since(e.gpuAt) > 2*time.Minute) && e.gpuRun == nil {
		run := make(chan struct{})
		e.gpuRun = run
		go func() {
			found := detectGPU()
			e.gpuMu.Lock()
			e.gpu, e.gpuAt, e.gpuRun = found, time.Now(), nil
			e.gpuMu.Unlock()
			close(run)
		}()
	}
	run := e.gpuRun
	e.gpuMu.Unlock()
	if run != nil && wait > 0 {
		select {
		case <-run:
		case <-time.After(wait):
		}
	}
	e.gpuMu.Lock()
	defer e.gpuMu.Unlock()
	return e.gpu, e.gpuAt.IsZero()
}

func detectGPU() *gpuInfo {
	cands := nvidiaSmiCandidates()
	if p := os.Getenv("GLOW_NVIDIA_SMI"); p != "" {
		cands = []string{p}
	}
	tried := map[string]bool{}
	for _, c := range cands {
		if tried[strings.ToLower(c)] {
			continue
		}
		tried[strings.ToLower(c)] = true
		if _, err := os.Stat(c); err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		cmd := exec.CommandContext(ctx, c, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits")
		hideWindow(cmd)
		out, err := cmd.Output()
		cancel()
		if err != nil {
			continue
		}
		if g := parseNvidiaSmi(string(out)); g != nil {
			return g
		}
	}
	return nil
}

// parseNvidiaSmi reads "NVIDIA GeForce RTX 5060, 8151, 581.57" lines and
// returns the card with the most memory.
func parseNvidiaSmi(out string) *gpuInfo {
	var best *gpuInfo
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSpace(line), ",")
		if len(f) < 3 {
			continue
		}
		name := strings.TrimSpace(f[0])
		vram, err := strconv.ParseFloat(strings.TrimSpace(f[1]), 64)
		if err != nil || name == "" {
			continue
		}
		drv := strings.TrimSpace(f[2])
		g := &gpuInfo{Name: name, VramMB: int(vram), Driver: drv, MinDriver: minDriverText}
		if major, err := strconv.Atoi(strings.SplitN(drv, ".", 2)[0]); err == nil {
			g.DriverOk = major >= minDriverMajor
		}
		if best == nil || g.VramMB > best.VramMB {
			best = g
		}
	}
	return best
}

// ---- status ----

type packJSON struct {
	Installed   bool    `json:"installed"`
	SizeGB      float64 `json:"sizeGB"`
	Label       string  `json:"label"`
	Desc        string  `json:"desc"`
	RemainingGB float64 `json:"remainingGB"` // still to download (partial downloads count as done)
}

type engineJSON struct {
	State        string   `json:"state"`
	ComfyVersion *string  `json:"comfyVersion"`
	Error        *string  `json:"error"`
	Log          []string `json:"log"`
	DynamicVRAM  *bool    `json:"dynamicVram"` // true once ComfyUI logs "DynamicVRAM support detected and enabled"
}

type statusJSON struct {
	Launcher     string              `json:"launcher"`
	OS           string              `json:"os"`
	InstallDir   string              `json:"installDir"`
	DefaultDir   string              `json:"defaultInstallDir"`
	GPU          *gpuInfo            `json:"gpu"`
	GPUPending   bool                `json:"gpuPending"` // nvidia-smi has not answered yet: gpu null means "still checking"
	RAMGB        *float64            `json:"ramGB"`
	DiskFreeGB   float64             `json:"diskFreeGB"`
	DiskMarginGB float64             `json:"diskMarginGB"`
	Packs        map[string]packJSON `json:"packs"`
	Engine       engineJSON          `json:"engine"`
	Job          *jobJSON            `json:"job"`
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }
func round2(x float64) float64 { return math.Round(x*100) / 100 }

func (e *Engine) status(refreshGPU bool) statusJSON {
	// Never held up by nvidia-smi: "Check again" (refresh=1) waits a little for
	// a fresh answer, the very first status waits up to 1 s (no flicker), the
	// rest return the cached answer at once.
	wait := time.Second
	if refreshGPU {
		wait = 6 * time.Second
	}
	gpu, pending := e.gpuInfo(refreshGPU, wait)
	e.ramOnce.Do(func() { e.ram = totalRAM() })
	e.mu.Lock()
	defer e.mu.Unlock()
	s := statusJSON{
		Launcher: launcherVersion, OS: runtime.GOOS, InstallDir: e.installDir, DefaultDir: e.defaultDir,
		GPU: gpu, GPUPending: pending, DiskMarginGB: diskMarginBytes / 1e9, Packs: map[string]packJSON{},
	}
	if e.ram > 0 {
		r := round1(float64(e.ram) / (1 << 30)) // RAM is sold in GiB ("32 GB")
		s.RAMGB = &r
	}
	if free := e.freeBytes(e.installDir); free >= 0 {
		s.DiskFreeGB = round1(float64(free) / 1e9)
	}
	for _, p := range e.cat.Packs {
		pj := packJSON{Installed: e.packInstalledLocked(p.ID), SizeGB: round1(float64(e.cat.packBytes(p.ID)) / 1e9), Label: p.Label, Desc: p.Desc}
		if !pj.Installed {
			pj.RemainingGB = round2(float64(e.remainingLocked(p.ID)) / 1e9)
		}
		s.Packs[p.ID] = pj
	}
	s.Engine = engineJSON{State: e.engineStateLocked(), Log: e.logs.last(40), DynamicVRAM: e.dynVRAM}
	switch {
	case e.state == "ready" && e.runningVersion != "":
		v := e.runningVersion
		s.Engine.ComfyVersion = &v
	case extractedIn(e.installDir, e.man):
		v := e.man.ComfyVersion
		if v == "" {
			v = comfyVersion
		}
		s.Engine.ComfyVersion = &v
	}
	if e.state == "error" && e.engErr != "" {
		msg := e.engErr
		s.Engine.Error = &msg
	}
	if e.job != nil {
		j := e.job.snapshot()
		s.Job = &j
	}
	return s
}

func (e *Engine) engineStateLocked() string {
	switch e.state {
	case "starting", "ready", "error":
		return e.state
	}
	if !e.coreInstalledLocked() {
		return "not-installed"
	}
	return "stopped"
}

// ---- lifecycle used by main.go ----

// Busy is true while something must not be interrupted by the idle exit:
// an install job, or ComfyUI prompts running or queued.
func (e *Engine) Busy() bool {
	e.mu.Lock()
	installing := e.job != nil && e.job.state() == "running"
	e.mu.Unlock()
	return installing || e.comfyBusy()
}

// Shutdown pauses a running install (keeping partial files) and kills ComfyUI.
func (e *Engine) Shutdown() {
	e.shutdownOnce.Do(func() {
		e.mu.Lock()
		cancel, done := e.jobCancel, e.jobDone
		e.mu.Unlock()
		if cancel != nil {
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}
		e.stopEngine()
		e.mu.Lock()
		if e.dirUnlock != nil {
			e.dirUnlock()
			e.dirUnlock = nil
		}
		e.mu.Unlock()
	})
}

// ---- HTTP API ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func userMsg(err error) string {
	var ue *userError
	if errors.As(err, &ue) {
		return ue.msg
	}
	return err.Error()
}

func (e *Engine) apiHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !e.guard(w, r) {
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/__glow/engine/")
		if name == "status" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				errJSON(w, http.StatusMethodNotAllowed, "use GET")
				return
			}
			writeJSON(w, http.StatusOK, e.status(r.URL.Query().Get("refresh") == "1"))
			return
		}
		post := map[string]func(http.ResponseWriter, *http.Request){
			"install": e.handleInstall, "cancel": e.handleCancel, "start": e.handleStart, "stop": e.handleStop,
			"cleanup": e.handleCleanup,
		}
		h, ok := post[name]
		if !ok {
			errJSON(w, http.StatusNotFound, "not found")
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			errJSON(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		h(w, r)
	})
}

func (e *Engine) handleInstall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Packs      []string `json:"packs"`
		InstallDir *string  `json:"installDir"`
		// Repair: check every file again (sha256 of each model, the full file
		// list of the unpacked engine) and fetch or unpack again what is damaged.
		Repair bool `json:"repair"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "The request was not understood.")
		return
	}
	packs, err := normalizePacks(req.Packs, e.cat)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	e.mu.Lock()
	running := e.job != nil && e.job.state() == "running"
	dir, engineOn := e.installDir, e.proc != nil
	e.mu.Unlock()
	if running {
		errJSON(w, http.StatusConflict, "An install is already running.")
		return
	}
	if req.InstallDir != nil && strings.TrimSpace(*req.InstallDir) != "" {
		d, err := validateInstallDir(*req.InstallDir)
		if err != nil {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		dir = d
	}
	changing := !samePath(dir, e.currentDir())
	if changing && engineOn {
		errJSON(w, http.StatusConflict, "Stop the AI engine before choosing another folder.")
		return
	}
	if err := checkWritable(dir); err != nil {
		errJSON(w, http.StatusBadRequest, userMsg(err))
		return
	}
	if req.Repair && !changing && engineOn {
		// Repairing replaces files ComfyUI has open: stop it first, but never
		// in the middle of a video.
		if e.renderingNow() {
			errJSON(w, http.StatusConflict, "A video is being made right now. Wait until it is finished, then press “Check & repair files” again.")
			return
		}
		e.stopEngine()
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.job != nil && e.job.state() == "running" {
		errJSON(w, http.StatusConflict, "An install is already running.")
		return
	}
	if err := e.lockDirLocked(dir); err != nil {
		errJSON(w, http.StatusConflict, userMsg(err))
		return
	}
	man := e.man
	if !samePath(dir, e.installDir) {
		man = loadManifest(dir)
	}
	_, need := e.planLocked(dir, man, packs)
	if need > 0 {
		free := e.freeBytes(dir)
		if free >= 0 && free < need+int64(diskMarginBytes) {
			drive := filepath.VolumeName(dir)
			if drive == "" {
				drive = "this drive"
			}
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": fmt.Sprintf("Not enough free space on %s. The AI files need about %.0f GB plus %.0f GB to spare, but only %.0f GB is free. Free up space or choose a folder on another drive.",
					drive, math.Ceil(float64(need)/1e9), diskMarginBytes/1e9, math.Floor(float64(free)/1e9)),
				"neededGB": round1(float64(need+int64(diskMarginBytes)) / 1e9), "freeGB": round1(float64(free) / 1e9),
			})
			return
		}
	}
	if !samePath(dir, e.installDir) {
		e.installDir, e.man = dir, man
		e.saveConfigLocked()
		e.state, e.engErr = "stopped", ""
	}
	e.man.Pending, e.man.PendingRepair = packs, req.Repair
	if err := e.man.save(dir); err != nil {
		errJSON(w, http.StatusBadRequest, userMsg(dirError(err, dir)))
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := newJob(packs, dir)
	j.Repair = req.Repair
	j.Step = "Getting ready…"
	e.job, e.jobCancel, e.jobDone = j, cancel, make(chan struct{})
	e.logs.openFile(filepath.Join(dir, "logs"))
	verb := "starting"
	if req.Repair {
		verb = "checking and repairing"
	}
	e.logs.addf("[install] %s: %s in %s", verb, strings.Join(packs, ", "), dir)
	go e.runInstall(ctx, j, e.jobDone)
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (e *Engine) currentDir() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.installDir
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func (e *Engine) handleCancel(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	cancel, done := e.jobCancel, e.jobDone
	running := e.job != nil && e.job.state() == "running"
	e.mu.Unlock()
	if !running || cancel == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "idle": true})
		return
	}
	cancel()
	select { // let the job save its progress so the next status shows "cancelled"
	case <-done:
	case <-time.After(5 * time.Second):
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (e *Engine) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := e.startEngine(); err != nil {
		errJSON(w, http.StatusConflict, userMsg(err))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (e *Engine) handleStop(w http.ResponseWriter, r *http.Request) {
	e.stopEngine()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- install job state ----

type Job struct {
	mu           sync.Mutex
	Kind         string
	State        string
	Step         string
	File         string
	BytesDone    int64
	BytesTotal   int64
	OverallDone  int64
	OverallTotal int64
	SpeedBps     float64
	Err          string
	Packs        []string
	InstallDir   string
	Repair       bool             // a "Check & repair files" run
	done         map[string]int64 // bytes on disk (or checked) per file of this job
	net          atomic.Int64
}

type jobJSON struct {
	Kind         string   `json:"kind"`
	State        string   `json:"state"`
	Step         string   `json:"step"`
	File         *string  `json:"file"`
	BytesDone    int64    `json:"bytesDone"`
	BytesTotal   int64    `json:"bytesTotal"`
	OverallDone  int64    `json:"overallDone"`
	OverallTotal int64    `json:"overallTotal"`
	SpeedBps     float64  `json:"speedBps"`
	Error        *string  `json:"error"`
	EtaSec       *float64 `json:"etaSec"`
	Packs        []string `json:"packs"`
	InstallDir   string   `json:"installDir"`
	Repair       bool     `json:"repair"`
}

func newJob(packs []string, dir string) *Job {
	return &Job{Kind: "install", State: "running", Packs: append([]string{}, packs...), InstallDir: dir, done: map[string]int64{}}
}

func (j *Job) state() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.State
}

// recount must be called with j.mu held.
func (j *Job) recount() {
	keys := make([]string, 0, len(j.done))
	for k := range j.done {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var n int64
	for _, k := range keys {
		n += j.done[k]
	}
	j.OverallDone = n
}

func (j *Job) snapshot() jobJSON {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := jobJSON{Kind: j.Kind, State: j.State, Step: j.Step, BytesDone: j.BytesDone, BytesTotal: j.BytesTotal,
		OverallDone: j.OverallDone, OverallTotal: j.OverallTotal, SpeedBps: math.Round(j.SpeedBps),
		Packs: append([]string{}, j.Packs...), InstallDir: j.InstallDir, Repair: j.Repair}
	if j.File != "" {
		f := j.File
		s.File = &f
	}
	if j.Err != "" {
		m := j.Err
		s.Error = &m
	}
	if j.State == "running" && j.SpeedBps > 1000 && j.OverallTotal > j.OverallDone {
		eta := math.Round(float64(j.OverallTotal-j.OverallDone) / j.SpeedBps)
		s.EtaSec = &eta
	}
	return s
}
