package main

// The background install job: download (resumable, verified), unpack the
// portable ComfyUI once with 7zr.exe, put models in ComfyUI\models\<folder>,
// and keep <installDir>\glow-engine.json up to date after every file.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func (e *Engine) runInstall(ctx context.Context, j *Job, done chan struct{}) {
	defer close(done)
	stopSpeed := make(chan struct{})
	go j.trackSpeed(stopSpeed)
	err := e.install(ctx, j)
	close(stopSpeed)

	j.mu.Lock()
	j.SpeedBps = 0
	switch {
	case err == nil:
		j.State, j.Step, j.File = "done", "All done! The free AI engine is installed.", ""
		j.OverallDone = j.OverallTotal
	case ctx.Err() != nil:
		j.State, j.Step = "cancelled", "Paused. Press Resume to continue."
	default:
		j.State, j.Step, j.Err = "error", "The install stopped.", userMsg(err)
	}
	j.mu.Unlock()
	switch {
	case err == nil:
		e.logs.add("[install] finished")
	case ctx.Err() != nil:
		e.logs.add("[install] paused (partial downloads are kept)")
	default:
		if inner := errors.Unwrap(err); inner != nil {
			e.logs.addf("[install] stopped: %v", inner)
		}
		e.logs.addf("[install] %s", userMsg(err))
	}
	e.mu.Lock()
	if e.job == j {
		e.jobCancel = nil
	}
	e.mu.Unlock()
}

// trackSpeed keeps a smoothed download speed (bytes per second).
func (j *Job) trackSpeed(stop chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	prev, prevAt := j.net.Load(), time.Now()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			cur := j.net.Load()
			inst := float64(cur-prev) / now.Sub(prevAt).Seconds()
			prev, prevAt = cur, now
			j.mu.Lock()
			if j.SpeedBps == 0 {
				j.SpeedBps = inst
			} else {
				j.SpeedBps = 0.75*j.SpeedBps + 0.25*inst
			}
			if j.SpeedBps < 1 {
				j.SpeedBps = 0
			}
			j.mu.Unlock()
		}
	}
}

func (j *Job) set(step, file string, done, total int64) {
	j.mu.Lock()
	j.Step, j.File, j.BytesDone, j.BytesTotal = step, file, done, total
	j.mu.Unlock()
}

func (e *Engine) install(ctx context.Context, j *Job) error {
	dir := j.InstallDir
	e.mu.Lock()
	items, _ := e.planLocked(dir, e.man, j.Packs)
	e.mu.Unlock()

	var todo []planItem
	j.mu.Lock()
	j.OverallTotal, j.done = 0, map[string]int64{}
	for _, it := range items {
		if it.needed {
			todo = append(todo, it)
			j.OverallTotal += it.f.Size
			j.done[it.key] = it.onDisk
		}
	}
	j.recount()
	j.mu.Unlock()

	if err := checkWritable(dir); err != nil {
		return err
	}
	models := 0
	for _, it := range todo {
		if it.kind == "model" {
			models++
		}
	}
	n := 0
	extracted := func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return extractedIn(dir, e.man)
	}
	for _, it := range items {
		if it.kind != "model" && !extracted() {
			step := "Downloading the unpacking tool"
			if it.kind == "engine" {
				step = fmt.Sprintf("Downloading the AI engine (%.1f GB)", float64(it.f.Size)/1e9)
			}
			if err := e.fetchItem(ctx, j, it, step); err != nil {
				return err
			}
		}
	}
	if !extracted() {
		if err := e.extractEngine(ctx, j); err != nil {
			return err
		}
	}
	for _, it := range items {
		if it.kind != "model" {
			continue
		}
		if it.needed {
			n++
		}
		if err := e.fetchItem(ctx, j, it, fmt.Sprintf("Downloading AI model %d of %d: %s", n, models, it.f.Label)); err != nil {
			return err
		}
	}

	// Make sure every model folder exists (harmless if it already does).
	for _, f := range []string{"diffusion_models", "text_encoders", "loras", "vae", "frame_interpolation", "audio_encoders"} {
		os.MkdirAll(filepath.Join(dir, portableDir, "ComfyUI", "models", f), 0o755)
	}
	j.set("Finishing up…", "", 0, 0)
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339)
	for _, id := range j.Packs {
		ok := true
		if p := e.cat.pack(id); p != nil {
			for _, f := range p.Files {
				ok = ok && verifiedIn(dir, e.man, f)
			}
		}
		if ok {
			e.man.Packs[id] = PackRecord{Installed: true, Version: catalogVersion, At: now}
		}
	}
	e.man.Pending = nil
	if err := e.man.save(dir); err != nil {
		return dirError(err, dir)
	}
	return nil
}

// fetchItem makes sure one file is on disk and verified.
func (e *Engine) fetchItem(ctx context.Context, j *Job, it planItem, step string) error {
	e.mu.Lock()
	ok := verifiedIn(j.InstallDir, e.man, it.f)
	e.mu.Unlock()
	if ok {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	onDisk := func(n int64) {
		j.mu.Lock()
		j.BytesDone = n
		j.done[it.key] = n
		j.recount()
		j.mu.Unlock()
	}
	hk := dlHooks{
		onDisk: onDisk,
		onNet:  func(n int) { j.net.Add(int64(n)) },
		phase: func(ph string) {
			msg := step
			switch {
			case ph == "check":
				msg = "Checking what is already downloaded: " + it.f.Label
			case strings.HasPrefix(ph, "retry:"):
				msg = fmt.Sprintf("The connection dropped. Trying again in %s s… (%s)", strings.TrimPrefix(ph, "retry:"), it.f.Label)
			}
			j.mu.Lock()
			j.Step, j.File, j.BytesTotal = msg, it.f.Name, it.f.Size
			j.mu.Unlock()
		},
		logf: func(format string, a ...any) { e.logs.add("[install] " + fmt.Sprintf(format, a...)) },
	}
	j.set(step, it.f.Name, it.onDisk, it.f.Size)

	// A complete file that is not in the manifest yet (e.g. a repair): check it.
	if st, err := os.Stat(it.dest); err == nil {
		good, err := verifyExisting(ctx, it.f, it.dest, hk)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fileError(err, it.dest)
		}
		if good {
			e.logs.addf("[install] %s is already on disk and checked", it.f.Name)
			onDisk(st.Size())
			return e.recordFile(j.InstallDir, it, st.Size(), "")
		}
		e.logs.addf("[install] %s on disk is damaged or outdated; downloading it again", it.f.Name)
		if err := os.Remove(it.dest); err != nil {
			return fileError(err, it.dest)
		}
	}
	e.logs.addf("[install] downloading %s (%s)", it.f.Name, gb(it.f.Size))
	start := time.Now()
	if err := e.dl.fetch(ctx, it.f, it.dest, hk); err != nil {
		return err
	}
	st, err := os.Stat(it.dest)
	if err != nil {
		return fileError(err, it.dest)
	}
	onDisk(st.Size())
	e.logs.addf("[install] %s verified (%s in %s)", it.f.Name, gb(st.Size()), time.Since(start).Round(time.Second))
	return e.recordFile(j.InstallDir, it, st.Size(), it.f.SHA256)
}

func (e *Engine) recordFile(dir string, it planItem, size int64, sha string) error {
	if sha == "" && (!it.f.SizeFlexible || size == it.f.Size) {
		sha = it.f.SHA256 // verifyExisting compared against it
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.man.Files[it.key] = FileRecord{Size: size, SHA256: sha, Verified: time.Now().UTC().Format(time.RFC3339)}
	if err := e.man.save(dir); err != nil {
		return dirError(err, dir)
	}
	return nil
}

var pctRe = regexp.MustCompile(`(\d{1,3})%`)

// extractEngine unpacks the portable ComfyUI with 7zr.exe (once).
func (e *Engine) extractEngine(ctx context.Context, j *Job) error {
	dir := j.InstallDir
	archive := fileDest(dir, e.cat.Engine)
	size := e.cat.Engine.Size
	root := filepath.Join(dir, portableDir)
	step := "Unpacking the AI engine. This takes a few minutes…"
	j.set(step, e.cat.Engine.Name, 0, size)
	e.logs.addf("[install] unpacking %s into %s", filepath.Base(archive), dir)

	if os.Getenv("GLOW_SKIP_7Z") != "" {
		// Test mode: create the folder layout the real archive contains.
		for _, d := range []string{"ComfyUI/models", "ComfyUI/input", "ComfyUI/output", "python_embeded"} {
			if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
				return dirError(err, root)
			}
		}
		os.WriteFile(filepath.Join(root, "ComfyUI", "main.py"), []byte("# placeholder written in GLOW_SKIP_7Z test mode\n"), 0o644)
	} else {
		exe := fileDest(dir, e.cat.Tool)
		var pre []string
		if c := strings.Fields(os.Getenv("GLOW_7Z_CMD")); len(c) > 0 {
			exe, pre = c[0], c[1:]
		}
		args := append(pre, "x", archive, "-o"+dir, "-y", "-bso0", "-bsp1", "-bse1")
		cmd := exec.Command(exe, args...)
		cmd.Dir = dir
		hideWindow(cmd)
		out, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = cmd.Stdout
		if err := cmd.Start(); err != nil {
			return friendly(err, "The unpacking tool could not run. Your antivirus may have blocked it. Press Resume to try again.")
		}
		afterStart(cmd)
		var tail []string
		pumped := make(chan struct{})
		go func() {
			defer close(pumped)
			e.logs.pump(out, func(line string) {
				if m := pctRe.FindAllStringSubmatch(line, -1); len(m) > 0 {
					pct, _ := strconv.Atoi(m[len(m)-1][1])
					j.set(step, e.cat.Engine.Name, size*int64(pct)/100, size)
					return
				}
				e.logs.add("[7-zip] " + line)
				if tail = append(tail, line); len(tail) > 20 {
					tail = tail[1:]
				}
			})
		}()
		waitErr := make(chan error, 1)
		go func() { <-pumped; waitErr <- cmd.Wait() }()
		var werr error
		select {
		case <-ctx.Done():
			killTree(cmd)
			<-waitErr
			return ctx.Err()
		case werr = <-waitErr:
		}
		code := 0
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			code = ee.ExitCode()
		} else if werr != nil {
			code = -1
		}
		// 0 = OK, 1 = warnings only (some files could not be overwritten).
		if code != 0 && code != 1 {
			text := strings.ToLower(strings.Join(tail, "\n"))
			switch {
			case strings.Contains(text, "not enough space") || strings.Contains(text, "disk full"):
				return friendly(werr, "The drive got full while unpacking the AI engine. Free up some space, then press Resume.")
			case strings.Contains(text, "can not open the file as archive") || strings.Contains(text, "crc failed") ||
				strings.Contains(text, "data error") || strings.Contains(text, "headers error") || strings.Contains(text, "unexpected end"):
				// The archive is damaged: forget it so Resume downloads it again.
				os.Remove(archive)
				e.mu.Lock()
				delete(e.man.Files, fileKey(e.cat.Engine))
				e.man.save(dir)
				e.mu.Unlock()
				return friendly(werr, "The AI engine download was damaged. Press Resume to download it again.")
			case code == 8:
				return friendly(werr, "This PC ran out of memory while unpacking the AI engine. Close other programs, then press Resume.")
			}
			return friendly(werr, fmt.Sprintf("Unpacking the AI engine failed (7-Zip error %d). Your antivirus may have blocked it. Press Resume to try again.", code))
		}
	}
	if _, err := os.Stat(filepath.Join(root, "ComfyUI", "main.py")); err != nil {
		return friendly(err, "The AI engine was unpacked but some of its files are missing. Your antivirus may have removed them. Press Resume to try again.")
	}
	if os.Getenv("GLOW_SKIP_7Z") == "" && os.Getenv("GLOW_COMFY_CMD") == "" {
		if _, err := os.Stat(pythonExe(root)); err != nil {
			return friendly(err, "The AI engine was unpacked but its Python is missing. Your antivirus may have removed it. Press Resume to try again.")
		}
	}
	e.mu.Lock()
	e.man.EngineExtracted, e.man.ComfyVersion = true, comfyVersion
	delete(e.man.Files, fileKey(e.cat.Engine))
	err := e.man.save(dir)
	e.mu.Unlock()
	if err != nil {
		return dirError(err, dir)
	}
	// The 2 GB archive is not needed any more.
	os.Remove(archive)
	os.Remove(archive + ".part.state")
	j.set(step, e.cat.Engine.Name, size, size)
	e.logs.add("[install] the AI engine is unpacked")
	return nil
}
