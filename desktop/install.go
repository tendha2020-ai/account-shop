package main

// The background install job: download (resumable, verified), unpack the
// portable ComfyUI once with 7zr.exe, put models in ComfyUI\models\<folder>,
// and keep <installDir>\glow-engine.json up to date after every file.
// A repair ("Check & repair files") also re-checks every model's sha256 and
// every file of the unpacked engine (engine-files.tsv, written when it was
// unpacked), and downloads/unpacks again whatever is damaged.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
)

// runInstall runs the install job. persist writes the manifest snapshot taken
// when the job was accepted (the unfinished install, so a restart offers Resume).
func (e *Engine) runInstall(ctx context.Context, j *Job, done chan struct{}, persist func() error) {
	defer close(done)
	stopSpeed := make(chan struct{})
	goSafe("download speed", func() { j.trackSpeed(stopSpeed) })
	err := func() (err error) {
		// A bug must not leave the job "running" for ever (that would also keep
		// the launcher from ever quitting): report it as a failed install.
		defer func() {
			if v := recover(); v != nil {
				launcherLog.printf("[launcher] PANIC in the install job (recovered): %v\n%s", v, debug.Stack())
				err = friendly(fmt.Errorf("internal error: %v", v), "Something went wrong in Glow Studio while installing. Press “Try again”.")
			}
		}()
		if persist != nil {
			if err := persist(); err != nil {
				return dirError(err, j.InstallDir)
			}
		}
		return e.install(ctx, j)
	}()
	close(stopSpeed)

	j.mu.Lock()
	j.SpeedBps = 0
	switch {
	case err == nil && j.Repair:
		j.State, j.Step, j.File = "done", "All files are checked and in order.", ""
		j.OverallDone = j.OverallTotal
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
	if err := checkWritable(dir); err != nil {
		return err
	}
	if j.Repair {
		if err := e.checkEngine(ctx, j); err != nil {
			return err
		}
	}
	e.mu.Lock()
	items, _ := e.planLocked(dir, e.man, j.Packs)
	pb := e.progressBaseLocked(dir, e.man, j.Packs, j.Repair, items)
	e.mu.Unlock()
	j.mu.Lock()
	j.OverallTotal, j.done = pb.total, pb.done
	j.recount()
	j.mu.Unlock()

	// Models are numbered over every file of the packs being installed
	// ("model 7 of 11"), so the count does not restart after a Resume.
	models := 0
	for _, it := range items {
		if it.kind == "model" && pb.counted[it.pack] {
			models++
		}
	}
	extracted := func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return extractedIn(dir, e.man)
	}
	for _, it := range items {
		if it.kind != "model" && !extracted() {
			msg := itemText{step: "Downloading the unpacking tool", check: "Checking the unpacking tool"}
			if it.kind == "engine" {
				msg = itemText{step: fmt.Sprintf("Downloading the AI engine (%.1f GB)", float64(it.f.Size)/1e9), check: "Checking the downloaded AI engine"}
			}
			if err := e.fetchItem(ctx, j, it, msg, false); err != nil {
				return err
			}
		}
	}
	if !extracted() {
		if err := e.extractEngine(ctx, j); err != nil {
			return err
		}
	}
	n := 0
	for _, it := range items {
		if it.kind != "model" {
			continue
		}
		msg := itemText{step: "Downloading: " + it.f.Label, check: "Checking what is already downloaded: " + it.f.Label}
		if pb.counted[it.pack] {
			n++
			msg.step = fmt.Sprintf("Downloading AI model %d of %d: %s", n, models, it.f.Label)
			if j.Repair {
				msg.check = fmt.Sprintf("Checking AI model %d of %d: %s", n, models, it.f.Label)
			}
		}
		if err := e.fetchItem(ctx, j, it, msg, j.Repair && pb.counted[it.pack]); err != nil {
			return err
		}
	}

	// Make sure every model folder exists (harmless if it already does).
	for _, f := range []string{"diffusion_models", "text_encoders", "loras", "vae", "frame_interpolation", "audio_encoders"} {
		os.MkdirAll(filepath.Join(dir, portableDir, "ComfyUI", "models", f), 0o755)
	}
	j.set("Finishing up…", "", 0, 0)
	e.mu.Lock()
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
	e.man.Pending, e.man.PendingRepair = nil, false
	write := e.manifestWriterLocked(dir)
	e.mu.Unlock()
	if err := write(); err != nil {
		return dirError(err, dir)
	}
	return nil
}

type itemText struct{ step, check string }

// fetchItem makes sure one file is on disk and verified. recheck (a repair)
// hashes a file again even if the manifest says it was verified.
func (e *Engine) fetchItem(ctx context.Context, j *Job, it planItem, msg itemText, recheck bool) error {
	e.mu.Lock()
	ok := verifiedIn(j.InstallDir, e.man, it.f)
	e.mu.Unlock()
	if ok && !recheck {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	onDisk := func(n int64) {
		j.mu.Lock()
		j.BytesDone = n
		j.done[it.key] = min(n, it.f.Size)
		j.recount()
		j.mu.Unlock()
	}
	hk := dlHooks{
		onDisk: onDisk,
		onNet:  func(n int) { j.net.Add(int64(n)) },
		phase: func(ph string) {
			m := msg.step
			switch {
			case ph == "check":
				m = msg.check
			case strings.HasPrefix(ph, "retry:"):
				m = fmt.Sprintf("The connection dropped. Trying again in %s s… (%s)", strings.TrimPrefix(ph, "retry:"), it.f.Label)
			}
			j.mu.Lock()
			j.Step, j.File, j.BytesTotal = m, it.f.Name, it.f.Size
			j.mu.Unlock()
		},
		logf: func(format string, a ...any) { e.logs.add("[install] " + fmt.Sprintf(format, a...)) },
	}
	if recheck {
		j.set(msg.check, it.f.Name, 0, it.f.Size)
	} else {
		j.set(msg.step, it.f.Name, it.onDisk, it.f.Size)
	}

	// A complete file that is not in the manifest yet, or a repair: check it.
	if st, err := os.Stat(it.dest); err == nil {
		good, err := verifyExisting(ctx, it.f, it.dest, hk)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fileError(err, it.dest)
		}
		if good {
			e.logs.addf("[install] %s is on disk and checked", it.f.Name)
			onDisk(st.Size())
			return e.recordFile(j.InstallDir, it, st.Size(), "")
		}
		e.logs.addf("[install] %s on disk is damaged or outdated; downloading it again", it.f.Name)
		e.mu.Lock()
		delete(e.man.Files, it.key)
		e.mu.Unlock()
		if err := removeRetry(it.dest); err != nil {
			return fileError(err, it.dest)
		}
		onDisk(partBytes(it.dest))
	}
	j.set(msg.step, it.f.Name, partBytes(it.dest), it.f.Size)
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
	e.man.Files[it.key] = FileRecord{Size: size, SHA256: sha, Verified: time.Now().UTC().Format(time.RFC3339)}
	write := e.manifestWriterLocked(dir)
	e.mu.Unlock()
	if err := write(); err != nil {
		return dirError(err, dir)
	}
	return nil
}

var pctRe = regexp.MustCompile(`(\d{1,3})%`)

// sevenZipProgressRe: a 7-Zip progress update ("  45% 10 - ComfyUI_windows_portable\…",
// " 3%", "100% 1234") — not a message for people.
var sevenZipProgressRe = regexp.MustCompile(`^\d{1,3}%(\s+\d+)?(\s+[-+U]\s.*)?$`)

const sevenZipProgress = "[7-zip] unpacking… "

// sevenZipLine sorts one line of 7-Zip output: progress (pct >= 0), a real
// message, or nothing (the backspaces and spaces 7-Zip uses to redraw its
// progress leave empty pieces).
func sevenZipLine(line string) (msg string, pct int) {
	t := strings.TrimSpace(line)
	if t == "" {
		return "", -1
	}
	if sevenZipProgressRe.MatchString(t) {
		m := pctRe.FindStringSubmatch(t)
		p, _ := strconv.Atoi(m[1])
		return "", min(p, 100)
	}
	return t, -1
}

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
		// Test mode: create the folder layout the real archive contains, with
		// a few stand-ins for its key files.
		for _, d := range []string{"ComfyUI/models", "ComfyUI/input", "ComfyUI/output", "ComfyUI/comfy", "python_embeded/Lib/site-packages/torch/lib"} {
			if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
				return dirError(err, root)
			}
		}
		for name, body := range map[string]string{
			"ComfyUI/main.py":                                    "# placeholder written in GLOW_SKIP_7Z test mode\n",
			"ComfyUI/comfy/model_management.py":                  "# placeholder\n",
			"python_embeded/python313.dll":                       "MZ placeholder\n",
			"python_embeded/Lib/site-packages/torch/lib/c10.dll": "MZ placeholder c10\n",
			"python_embeded/Lib/site-packages/torch/__init__.py": "# placeholder\n",
		} {
			os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), []byte(body), 0o644)
		}
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
			return friendly(err, "The unpacking tool could not run. Your antivirus may have blocked it. Press “Try again”.")
		}
		afterStart(cmd)
		var tail []string
		pumped := make(chan struct{})
		lastFile := -10
		go func() {
			defer close(pumped)
			defer recoverLog("7-zip output")
			e.logs.pump(out, func(line string) {
				msg, pct := sevenZipLine(line)
				if pct >= 0 {
					j.set(step, e.cat.Engine.Name, size*int64(pct)/100, size)
					// one line in Details, updated in place; the log file gets every 10 %
					toFile := pct >= lastFile+10 || pct == 100
					if toFile {
						lastFile = pct
					}
					e.logs.setProgress(sevenZipProgress, fmt.Sprintf("%s%d%%", sevenZipProgress, pct), toFile)
					return
				}
				if msg == "" {
					return
				}
				e.logs.add("[7-zip] " + msg)
				if tail = append(tail, msg); len(tail) > 20 {
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
				return friendly(werr, "The drive got full while unpacking the AI engine. Free up some space, then press “Try again”.")
			case strings.Contains(text, "can not open the file as archive") || strings.Contains(text, "crc failed") ||
				strings.Contains(text, "data error") || strings.Contains(text, "headers error") || strings.Contains(text, "unexpected end"):
				// The archive is damaged: forget it so Resume downloads it again.
				os.Remove(archive)
				e.mu.Lock()
				delete(e.man.Files, fileKey(e.cat.Engine))
				write := e.manifestWriterLocked(dir)
				e.mu.Unlock()
				write()
				return friendly(werr, "The AI engine download was damaged. Press “Try again” to download it again.")
			case code == 8:
				return friendly(werr, "This PC ran out of memory while unpacking the AI engine. Close other programs, then press “Try again”.")
			}
			return friendly(werr, fmt.Sprintf("Unpacking the AI engine failed (7-Zip error %d). Your antivirus may have blocked it. Press “Try again”.", code))
		}
	}
	if _, err := os.Stat(filepath.Join(root, "ComfyUI", "main.py")); err != nil {
		return friendly(err, "The AI engine was unpacked but some of its files are missing. Your antivirus may have removed them. Press “Try again”.")
	}
	if os.Getenv("GLOW_SKIP_7Z") == "" && os.Getenv("GLOW_COMFY_CMD") == "" {
		if _, err := os.Stat(pythonExe(root)); err != nil {
			return friendly(err, "The AI engine was unpacked but its Python is missing. Your antivirus may have removed it. Press “Try again”.")
		}
	}
	// Remember what was unpacked, so a repair can tell if files went missing.
	j.set("Checking the unpacked AI engine…", "", 0, 0)
	count, key, lerr := writeEngineList(dir, root)
	if lerr != nil {
		e.logs.addf("[install] could not write the engine file list: %v", lerr)
	} else {
		e.logs.addf("[install] the AI engine has %d files", count)
	}
	e.mu.Lock()
	e.man.EngineExtracted, e.man.ComfyVersion = true, comfyVersion
	e.man.EngineFiles, e.man.EngineKey, e.man.EngineSuspect = count, key, false
	delete(e.man.Files, fileKey(e.cat.Engine))
	write := e.manifestWriterLocked(dir)
	e.mu.Unlock()
	if err := write(); err != nil {
		return dirError(err, dir)
	}
	// The 2 GB archive is not needed any more.
	os.Remove(archive)
	os.Remove(archive + ".part.state")
	j.set(step, e.cat.Engine.Name, size, size)
	e.logs.add("[install] the AI engine is unpacked")
	return nil
}

// ---- engine file list (repair) ----

const engineListName = "engine-files.tsv"

// Folders inside the portable that are the user's (or ComfyUI's own) data,
// not part of the engine: not listed, never checked.
var engineSkip = map[string]bool{
	"comfyui/models": true, "comfyui/input": true, "comfyui/output": true, "comfyui/user": true,
	"comfyui/temp": true, "comfyui/custom_nodes": true,
}

// Key files checked by extractedIn on every status (cheap: a few stats).
var engineKeyRe = regexp.MustCompile(`(?i)^(python_embeded/python\.exe|python_embeded/python3\d*\.dll|python_embeded/lib/site-packages/torch/lib/(c10|c10_cuda|torch_cpu|torch_cuda|torch_python)\.dll|comfyui/main\.py|comfyui/execution\.py|comfyui/nodes\.py|comfyui/server\.py|comfyui/comfy/model_management\.py)$`)

// writeEngineList records every file of the freshly unpacked engine (size and
// path) in <installDir>\engine-files.tsv.
func writeEngineList(dir, root string) (count int, key map[string]int64, err error) {
	key = map[string]int64{}
	tmp := filepath.Join(dir, engineListName+".tmp")
	f, err := os.Create(tmp)
	if err != nil {
		return 0, nil, err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	fmt.Fprintf(w, "# Glow Studio: files of the unpacked AI engine (ComfyUI %s), size<TAB>path\n", comfyVersion)
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if engineSkip[strings.ToLower(rel)] || d.Name() == "__pycache__" {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		fmt.Fprintf(w, "%d\t%s\n", info.Size(), rel)
		count++
		if engineKeyRe.MatchString(rel) {
			key[rel] = info.Size()
		}
		return nil
	})
	if ferr := w.Flush(); err == nil {
		err = ferr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = renameRetry(tmp, filepath.Join(dir, engineListName))
	}
	if err != nil {
		os.Remove(tmp)
		return 0, nil, err
	}
	return count, key, nil
}

// checkEngineFiles compares the unpacked engine with engine-files.tsv and
// returns the files that are missing or have another size.
func checkEngineFiles(ctx context.Context, dir string, progress func(done, total int)) (bad []string, checked int, err error) {
	root := filepath.Join(dir, portableDir)
	data, err := os.ReadFile(filepath.Join(dir, engineListName))
	if err != nil {
		// Unpacked by an older Glow Studio: check the key files we know of.
		if os.Getenv("GLOW_SKIP_7Z") != "" || os.Getenv("GLOW_COMFY_CMD") != "" {
			return nil, 0, nil
		}
		for _, rel := range []string{"ComfyUI/main.py", "ComfyUI/nodes.py", "ComfyUI/execution.py", "ComfyUI/comfy/model_management.py",
			"python_embeded/python.exe", "python_embeded/Lib/site-packages/torch/lib/c10.dll", "python_embeded/Lib/site-packages/torch/lib/torch_cuda.dll"} {
			checked++
			if !fileExists(filepath.Join(root, filepath.FromSlash(rel))) {
				bad = append(bad, rel)
			}
		}
		return bad, checked, nil
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		if i%500 == 0 {
			if err := ctx.Err(); err != nil {
				return bad, checked, err
			}
			if progress != nil {
				progress(i, len(lines))
			}
		}
		tab := strings.IndexByte(line, '\t')
		if tab <= 0 || strings.HasPrefix(line, "#") {
			continue
		}
		size, err := strconv.ParseInt(line[:tab], 10, 64)
		if err != nil {
			continue
		}
		rel := strings.TrimRight(line[tab+1:], "\r")
		checked++
		st, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil || st.Size() != size {
			bad = append(bad, rel)
		}
	}
	return bad, checked, nil
}

// checkEngine is the first step of a repair: when files of the unpacked engine
// are missing or changed (or ComfyUI crashed because of missing files), it
// marks the engine as not unpacked, so the install downloads the portable again
// (about 2 GB) and unpacks it over the old one. The models are kept.
func (e *Engine) checkEngine(ctx context.Context, j *Job) error {
	dir := j.InstallDir
	e.mu.Lock()
	unpacked, suspect := extractedIn(dir, e.man), e.man.EngineSuspect
	e.mu.Unlock()
	if !unpacked {
		return nil // the install unpacks it anyway (missing key file or never unpacked)
	}
	step := "Checking the AI engine files…"
	j.set(step, "", 0, 0)
	bad, checked, err := checkEngineFiles(ctx, dir, func(done, total int) {
		j.mu.Lock()
		j.Step = fmt.Sprintf("Checking the AI engine files… %d%%", done*100/max(total, 1))
		j.mu.Unlock()
	})
	if err != nil {
		return err
	}
	if len(bad) == 0 && !suspect {
		e.logs.addf("[repair] the AI engine is complete (%d files checked)", checked)
		return nil
	}
	if len(bad) > 0 {
		ex := bad
		if len(ex) > 5 {
			ex = ex[:5]
		}
		e.logs.addf("[repair] %d AI engine files are missing or changed (for example %s); the AI engine will be downloaded and unpacked again", len(bad), strings.Join(ex, ", "))
	} else {
		e.logs.add("[repair] the AI engine failed to start because files were missing; it will be downloaded and unpacked again")
	}
	e.mu.Lock()
	e.man.EngineExtracted = false
	write := e.manifestWriterLocked(dir)
	e.mu.Unlock()
	if err := write(); err != nil {
		return dirError(err, dir)
	}
	return nil
}
