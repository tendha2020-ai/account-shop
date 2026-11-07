package main

// The runner (DESIGN i.1-i.3): friends' videos are made by the launcher
// itself, one job at a time, step by step, straight against ComfyUI on
// 127.0.0.1 (no proxy, client_id "glowshare"). A friend's phone that locks or
// leaves the page never stalls anything, and friends never talk to ComfyUI.
//
// Queue policy: the host goes first, at step granularity. A friend's step
// starts only when the host is idle: nothing of the host's in ComfyUI's queue,
// no host video renewed its hold in the last 5 minutes, no install. A running
// friend's step is never cut off, so the host waits at most one step. Among
// friends: strict FIFO by acceptance (videos waiting for approval keep their
// place but are skipped until approved); one friend's job runs all its steps
// before the next one starts (fewer model swaps).

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type comfyFile struct {
	Filename  string `json:"filename"`
	Subfolder string `json:"subfolder"`
	Type      string `json:"type"`
}

func (f comfyFile) annotated() string {
	sub := ""
	if f.Subfolder != "" {
		sub = f.Subfolder + "/"
	}
	t := f.Type
	if t == "" {
		t = "output"
	}
	return sub + f.Filename + " [" + t + "]"
}

type jobFile struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"` // still | clip | song
	Shot    *int    `json:"shot"`
	Width   int     `json:"width,omitempty"`
	Height  int     `json:"height,omitempty"`
	FPS     float64 `json:"fps,omitempty"`
	Seconds float64 `json:"seconds,omitempty"`
	Bytes   int64   `json:"bytes"`

	comfy comfyFile
}

type jobErr struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type jobProgress struct {
	Stage    string  `json:"stage"`
	Shot     *int    `json:"shot"`
	Shots    int     `json:"shots"`
	Pct      float64 `json:"pct"`
	Overall  float64 `json:"overall"`
	Message  string  `json:"message"`
	Step     string  `json:"step"`
	HostBusy bool    `json:"hostBusy,omitempty"`
}

type guestJob struct {
	id, code, guestID string
	state             string
	createdAt         time.Time
	startedAt         time.Time
	finishedAt        time.Time
	expiresAt         time.Time
	plan              *GuestPlan
	selfie, wav       []byte
	thumb             []byte
	progress          *jobProgress
	files             []jobFile
	err               *jobErr
	day               string
	refunded          bool
	cancel            context.CancelFunc
	prompts           []string
	curPrompt         string
	stepIdx           int
	stepTotal         int
	cleaned           bool
	cold              bool   // the engine had to be started for this job
	ip                string // the connection it came from (the daily limit per connection)
}

// finishJobLocked moves a job to a final (or "done"/"downloaded") state,
// refunding the daily limit when the friend got nothing for it (s.mu held).
func (s *Share) finishJobLocked(j *guestJob, state, code, msg string) {
	prev := j.state
	if prev == state {
		return
	}
	now := time.Now()
	j.state = state
	if code != "" {
		j.err = &jobErr{Code: code, Message: msg}
	}
	if j.finishedAt.IsZero() && state != "done" {
		j.finishedAt = now
	}
	refund := false
	switch state {
	case "declined":
		refund = true
	case "expired":
		refund = prev == "waiting-approval" || prev == "queued"
	case "cancelled":
		refund = prev == "waiting-approval" || prev == "queued" || code == "host-cancelled" || code == "sharing-stopped"
	case "failed":
		refund = true // every failure is on the host's side: friends only pick presets
	}
	if refund && !j.refunded {
		if g := s.guests[j.guestID]; g != nil && g.used[j.day] > 0 {
			g.used[j.day]--
		}
		if u := s.ipUsed[j.ip]; u != nil && u[j.day] > 0 {
			u[j.day]--
		}
		j.refunded = true
	}
	if prev == "running" && j.cancel != nil {
		j.cancel()
	}
	if state != "done" && state != "running" {
		j.selfie, j.wav, j.progress = nil, nil, nil
	}
	j.thumb = nil
	if state == "done" || state == "downloaded" {
		j.expiresAt = j.finishedAt.Add(jobKeep)
	}
}

// ---- queue views ----

type queueView struct {
	ahead     int
	hostBusy  bool
	startMin  [2]int
	doneMin   [2]int
	startZero bool
}

func (q queueView) startJSON() any {
	if q.startZero {
		return [2]int{0, 0}
	}
	return q.startMin
}

func roundAhead(lo, hi float64, nothing bool) [2]int {
	if nothing {
		return [2]int{0, 0}
	}
	return roundRange(lo, hi)
}

// queueViewLocked: for every waiting job, how many videos are ahead and the
// honest wait (DESIGN i.3 ETAs), in minutes.
func (s *Share) queueViewLocked(hostEta [2]float64, noEta int, hostBusy bool) map[string]queueView {
	out := map[string]queueView{}
	lo, hi, ahead := s.aheadLocked(hostEta, noEta, hostBusy)
	for _, j := range s.order {
		if j.state != "waiting-approval" && j.state != "queued" {
			continue
		}
		nothing := ahead == 0 && !hostBusy
		v := queueView{ahead: ahead, hostBusy: hostBusy, startMin: roundAhead(lo, hi, nothing), startZero: nothing}
		lo += float64(j.plan.EstimateMin[0])
		hi += float64(j.plan.EstimateMin[1])
		v.doneMin = roundRange(lo, hi)
		out[j.id] = v
		ahead++
	}
	return out
}

// aheadLocked: minutes of work in front of the queue (the host's own video
// and the running friend's job) and how many videos that is.
func (s *Share) aheadLocked(hostEta [2]float64, noEta int, hostBusy bool) (lo, hi float64, ahead int) {
	if hostBusy {
		lo += hostEta[0] + 5*float64(noEta)
		hi += hostEta[1] + 10*float64(noEta)
	}
	if r := s.running; r != nil && r.state == "running" {
		f := 0.0
		if r.progress != nil {
			f = r.progress.Overall
		}
		lo += float64(r.plan.EstimateMin[0]) * (1 - f)
		hi += float64(r.plan.EstimateMin[1]) * (1 - f)
		ahead++
	}
	return lo, hi, ahead
}

// queuePreviewLocked: the queue a new job with plan p would join now.
func (s *Share) queuePreviewLocked(p *GuestPlan) map[string]any {
	sum, noEta := s.eng.hostEta()
	busy, _ := s.eng.hostBusy()
	lo, hi, ahead := s.aheadLocked(sum, noEta, busy)
	for _, j := range s.order {
		if j.state == "waiting-approval" || j.state == "queued" {
			lo += float64(j.plan.EstimateMin[0])
			hi += float64(j.plan.EstimateMin[1])
			ahead++
		}
	}
	nothing := ahead == 0 && !busy
	start := roundAhead(lo, hi, nothing)
	done := roundRange(lo+float64(p.EstimateMin[0]), hi+float64(p.EstimateMin[1]))
	return map[string]any{"ahead": ahead, "hostBusy": busy, "startMin": start, "doneMin": done}
}

func (q queueView) jsonFull() map[string]any {
	return map[string]any{"ahead": q.ahead, "hostBusy": q.hostBusy, "startMin": q.startJSON(), "doneMin": q.doneMin}
}

// ---- the runner ----

func (s *Share) runLoop(ctx context.Context) {
	s.mu.Lock()
	wake := s.wake
	s.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-time.After(s.hostCheckEvery):
		}
		j := s.nextJob()
		if j == nil {
			continue
		}
		if busy, _ := s.hostActive(ctx); busy {
			continue // the host's own video goes first
		}
		s.runJob(ctx, j)
	}
}

func (s *Share) nextJob() *guestJob {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "on" && s.state != "closing" {
		return nil
	}
	for _, j := range s.order {
		if j.state == "queued" {
			return j
		}
	}
	return nil
}

// hostActive: the host's own work goes first (DESIGN i.3).
func (s *Share) hostActive(ctx context.Context) (bool, string) {
	if busy, why := s.eng.hostBusy(); busy {
		return true, why
	}
	port, state := s.eng.shareComfy()
	if state != "ready" {
		return false, ""
	}
	q, err := comfyQueue(ctx, port)
	if err != nil {
		return false, ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range append(q.running, q.pending...) {
		if !s.ours[id] {
			return true, "making a video"
		}
	}
	return false, ""
}

type queueIDs struct{ running, pending []string }

func comfyQueue(ctx context.Context, port int) (queueIDs, error) {
	var out queueIDs
	var q struct {
		Running [][]any `json:"queue_running"`
		Pending [][]any `json:"queue_pending"`
	}
	if err := comfyGetJSON(ctx, port, "/queue", &q); err != nil {
		return out, err
	}
	ids := func(list [][]any) []string {
		var r []string
		for _, it := range list {
			if len(it) > 1 {
				if s, ok := it[1].(string); ok {
					r = append(r, s)
				}
			}
		}
		return r
	}
	out.running, out.pending = ids(q.Running), ids(q.Pending)
	return out, nil
}

func comfyGetJSON(ctx context.Context, port int, path string, v any) error {
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	resp, err := localClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(v)
}

func comfyPostJSON(ctx context.Context, port int, path string, body any) (*http.Response, []byte, error) {
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(c, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := localClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return resp, data, err
}

// interruptPrompt stops one prompt (targeted /interrupt) and drops it from the queue.
func interruptPrompt(port int, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	comfyPostJSON(ctx, port, "/interrupt", map[string]string{"prompt_id": id})
	comfyPostJSON(ctx, port, "/queue", map[string]any{"delete": []string{id}})
}

func uuid4() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := fmt.Sprintf("%x", b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func randSeed() uint32 {
	var b [4]byte
	rand.Read(b[:])
	return binary.LittleEndian.Uint32(b[:])
}

// stepError: transient errors (lost prompt, out of memory, ComfyUI restarted)
// get one more try of the step; others end the job.
type stepError struct {
	transient bool
	code      string
	msg       string
	err       error
}

func (e *stepError) Error() string { return e.code + ": " + e.err.Error() }

func transientErr(err error) *stepError {
	return &stepError{transient: true, code: "engine", msg: "", err: err}
}

func (s *Share) hostName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.settings.HostName != "" {
		return s.settings.HostName
	}
	return "Your friend"
}

func (s *Share) engineFailMsg() string {
	return s.hostName() + "'s PC had a problem making this video. Try again later — it didn't count toward your limit."
}

func (s *Share) runJob(ctx context.Context, j *guestJob) {
	jctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	if j.state != "queued" || (s.state != "on" && s.state != "closing") {
		s.mu.Unlock()
		return
	}
	j.state, j.startedAt, j.cancel = "running", time.Now(), cancel
	j.stepTotal, j.stepIdx = len(j.plan.steps), 0
	s.running = j
	selfie, wav := j.selfie, j.wav
	s.mu.Unlock()
	s.logf("job %s started (%d steps)", j.id, len(j.plan.steps))
	err := s.execute(jctx, j, selfie, wav)
	failMsg := s.engineFailMsg() // (takes s.mu itself)

	s.mu.Lock()
	s.running = nil
	j.cancel = nil
	j.curPrompt = ""
	now := time.Now()
	ok := err == nil && j.state == "running"
	stopped := j.state != "running" // cancelled, blocked, sharing stopped
	if ok {
		j.finishedAt = now
		s.finishJobLocked(j, "done", "", "")
		j.selfie, j.wav, j.progress = nil, nil, nil
		s.lastFinished = now
	} else if !stopped {
		msg := failMsg
		var se *stepError
		code := "engine"
		if errors.As(err, &se) && se.msg != "" {
			msg = se.msg
		}
		s.finishJobLocked(j, "failed", code, msg)
		s.lastFinished = now
	}
	dur := now.Sub(j.startedAt).Round(time.Second)
	s.mu.Unlock()
	switch {
	case ok:
		s.logf("job %s done in %s", j.id, dur)
	case stopped:
		s.logf("job %s stopped after %s", j.id, dur)
		time.Sleep(s.cancelGrace) // let ComfyUI drop the interrupted step before its files go
		s.cleanupJob(j, "cancelled")
	default:
		s.logf("job %s failed after %s: %v", j.id, dur, err)
		s.cleanupJob(j, "failed")
	}
	s.kick()
}

// ensureEngine starts the engine if needed and waits until it is ready.
func (s *Share) ensureEngine(ctx context.Context, j *guestJob) (int, error) {
	port, state := s.eng.shareComfy()
	if state == "ready" {
		return port, nil
	}
	if state == "error" || state == "not-installed" {
		return 0, &stepError{code: "engine", err: fmt.Errorf("engine %s", state)}
	}
	s.setCold(j)
	if state == "stopped" {
		s.logf("starting the AI engine for a friend's video")
		if err := s.eng.startEngine(); err != nil {
			return 0, &stepError{code: "engine", err: err}
		}
	}
	deadline := time.Now().Add(s.engineWait)
	t0 := time.Now()
	for time.Now().Before(deadline) {
		port, state = s.eng.shareComfy()
		switch state {
		case "ready":
			s.progress(j, "starting", -1, 1, s.hostName()+"'s PC has started its AI.", "", false)
			return port, nil
		case "error", "not-installed", "stopped":
			return 0, &stepError{code: "engine", err: fmt.Errorf("engine %s while starting", state)}
		}
		s.progress(j, "starting", -1, math.Min(0.95, time.Since(t0).Seconds()/60), s.hostName()+"'s PC is starting its AI (about a minute)", "", false)
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(min(time.Second, s.pollEvery)):
		}
	}
	return 0, &stepError{code: "engine", err: errors.New("the engine did not become ready in time")}
}

func (s *Share) setCold(j *guestJob) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !j.cold {
		j.cold = true
	}
}

// progress updates a running job's progress (DESIGN d.3 Job.progress).
func (s *Share) progress(j *guestJob, stage string, shot int, pct float64, msg, step string, hostBusy bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if j.state != "running" {
		return
	}
	// weights: starting (only when the engine had to start), upload, each step
	total := 3.0
	if j.cold {
		total += 60
	}
	for _, st := range j.plan.steps {
		total += j.plan.stepSeconds(st)
	}
	before := 0.0
	cur := 3.0
	switch stage {
	case "starting":
		cur = 60
	case "upload":
		if j.cold {
			before = 60
		}
	default:
		if j.cold {
			before = 60
		}
		before += 3
		for i, st := range j.plan.steps {
			if i >= j.stepIdx-1 {
				break
			}
			before += j.plan.stepSeconds(st)
		}
		cur = j.plan.stepSeconds(step)
	}
	overall := math.Max(0, math.Min(1, (before+cur*math.Max(0, math.Min(1, pct)))/total))
	if j.progress != nil && overall < j.progress.Overall {
		overall = j.progress.Overall
	}
	p := &jobProgress{Stage: stage, Shots: len(j.plan.Shots), Pct: math.Round(math.Max(0, math.Min(1, pct))*1000) / 1000,
		Overall: math.Round(overall*1000) / 1000, Message: msg, Step: step, HostBusy: hostBusy}
	if shot >= 0 {
		k := shot
		p.Shot = &k
	}
	j.progress = p
}

func (s *Share) execute(ctx context.Context, j *guestJob, selfie, wav []byte) error {
	port, err := s.ensureEngine(ctx, j)
	if err != nil {
		return err
	}
	s.progress(j, "upload", -1, 0, "Sending your photo to "+s.hostName()+"'s AI…", "", false)
	in := stepInputs{selfie: "glow/selfie_" + j.id + ".jpg", stills: map[int]string{}}
	upload := func(port int) error {
		for name, data := range labelFiles() {
			if err := comfyUpload(ctx, port, name, data); err != nil {
				return err
			}
		}
		if err := comfyUpload(ctx, port, "selfie_"+j.id+".jpg", selfie); err != nil {
			return err
		}
		if wav != nil {
			if err := comfyUpload(ctx, port, "audio_"+j.id+".wav", wav); err != nil {
				return err
			}
		}
		return nil
	}
	if wav != nil {
		in.audio = "glow/audio_" + j.id + ".wav"
	}
	if err := upload(port); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &stepError{code: "engine", err: fmt.Errorf("upload: %w", err)}
	}
	s.progress(j, "upload", -1, 1, "Your photo is on "+s.hostName()+"'s PC.", "", false)
	for idx, step := range j.plan.steps {
		s.mu.Lock()
		j.stepIdx = idx + 1
		s.mu.Unlock()
		if err := s.waitHostIdle(ctx, j, step); err != nil {
			return err
		}
		take := 0
		t0 := time.Now()
		for {
			res, sg, err := s.runStep(ctx, port, j, step, take, in)
			if err == nil {
				s.recordStep(ctx, port, j, step, sg, res, &in, time.Since(t0))
				break
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var se *stepError
			if !errors.As(err, &se) || !se.transient || take >= 1 {
				return err
			}
			take++
			s.logf("job %s step %s: %v; trying the step once more", j.id, step, se.err)
			// ComfyUI may have restarted (the host pressed Stop, or it crashed)
			if port, err = s.ensureEngine(ctx, j); err != nil {
				return err
			}
			if err := upload(port); err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return &stepError{code: "engine", err: fmt.Errorf("upload: %w", err)}
			}
		}
	}
	return nil
}

// waitHostIdle: a friend's step starts only while the host is idle.
func (s *Share) waitHostIdle(ctx context.Context, j *guestJob, step string) error {
	st, k := stepParts(step)
	for {
		busy, _ := s.hostActive(ctx)
		if !busy {
			return nil
		}
		s.progress(j, st, k, 0, s.hostName()+" is making a video too — yours continues right after", step, true)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.hostCheckEvery):
		}
	}
}

type historyEntry struct {
	Outputs map[string]map[string]json.RawMessage `json:"outputs"`
	Status  struct {
		StatusStr string            `json:"status_str"`
		Completed bool              `json:"completed"`
		Messages  []json.RawMessage `json:"messages"`
	} `json:"status"`
}

var oomRe = regexp.MustCompile(`(?i)out of memory|OutOfMemory|Allocation on device|not enough memory|DefaultCPUAllocator|CUBLAS_STATUS_ALLOC_FAILED`)

// runStep queues one graph and waits for it.
func (s *Share) runStep(ctx context.Context, port int, j *guestJob, step string, take int, in stepInputs) (*historyEntry, *stepGraph, error) {
	sg, err := buildStepGraph(j.plan, j.id, step, take, in)
	if err != nil {
		return nil, nil, &stepError{code: "engine", err: err}
	}
	if err := assertGuestGraph(sg.graph, j.id, sg.guestOut); err != nil {
		return nil, nil, &stepError{code: "engine", err: fmt.Errorf("graph check: %w", err)}
	}
	if err := assertGuestTexts(sg.graph, j.plan); err != nil {
		return nil, nil, &stepError{code: "engine", err: fmt.Errorf("graph check: %w", err)}
	}
	st, k := stepParts(step)
	id := uuid4()
	s.mu.Lock()
	s.ours[id] = true
	j.prompts = append(j.prompts, id)
	j.curPrompt = id
	s.mu.Unlock()
	s.progress(j, st, k, 0, sg.message, step, false)
	resp, body, err := comfyPostJSON(ctx, port, "/prompt", map[string]any{"prompt": sg.graph, "client_id": "glowshare", "prompt_id": id})
	if err != nil {
		if ctx.Err() != nil {
			interruptPrompt(port, id) // it may have been queued just before the cancel
			return nil, nil, ctx.Err()
		}
		return nil, nil, transientErr(fmt.Errorf("queue: %w", err))
	}
	var pr struct {
		NodeErrors map[string]json.RawMessage `json:"node_errors"`
	}
	json.Unmarshal(body, &pr)
	if resp.StatusCode != http.StatusOK || len(pr.NodeErrors) > 0 {
		nodes := make([]string, 0, len(pr.NodeErrors))
		for n := range pr.NodeErrors {
			nodes = append(nodes, n)
		}
		s.logf("job %s step %s refused by the AI engine (HTTP %d, nodes %v)", j.id, step, resp.StatusCode, nodes)
		return nil, nil, &stepError{code: "engine", err: fmt.Errorf("prompt refused (HTTP %d)", resp.StatusCode)}
	}
	t0 := time.Now()
	expected := j.plan.stepSeconds(step)
	absent := 0
	lastQueue := time.Time{}
	waitingBehind := false
	for {
		select {
		case <-ctx.Done():
			interruptPrompt(port, id)
			return nil, nil, ctx.Err()
		case <-time.After(s.pollEvery):
		}
		if time.Since(t0) > s.stepTimeout {
			interruptPrompt(port, id)
			return nil, nil, transientErr(errors.New("the step took too long"))
		}
		var h map[string]historyEntry
		if err := comfyGetJSON(ctx, port, "/history/"+url.PathEscape(id), &h); err != nil {
			if ctx.Err() != nil {
				interruptPrompt(port, id)
				return nil, nil, ctx.Err()
			}
			if _, state := s.eng.shareComfy(); state != "ready" {
				return nil, nil, transientErr(fmt.Errorf("the AI engine stopped (%s)", state))
			}
			continue
		}
		if e, ok := h[id]; ok {
			okRun, msg, interrupted := historyOutcome(&e)
			if okRun {
				return &e, sg, nil
			}
			if interrupted {
				return nil, nil, transientErr(errors.New("interrupted"))
			}
			if oomRe.MatchString(msg) {
				return nil, nil, transientErr(errors.New("out of memory"))
			}
			return nil, nil, &stepError{code: "engine", err: fmt.Errorf("execution error: %.200s", msg)}
		}
		if time.Since(lastQueue) >= 5*s.pollEvery || waitingBehind {
			lastQueue = time.Now()
			q, err := comfyQueue(ctx, port)
			if err == nil {
				in := func(l []string) bool {
					for _, x := range l {
						if x == id {
							return true
						}
					}
					return false
				}
				switch {
				case in(q.running):
					absent, waitingBehind = 0, false
				case in(q.pending):
					absent, waitingBehind = 0, len(q.running) > 0
				default:
					absent++
					if absent >= 2 {
						return nil, nil, transientErr(errors.New("the step was lost"))
					}
				}
			}
		}
		if waitingBehind {
			t0 = time.Now() // our step has not started yet
			s.progress(j, st, k, 0, s.hostName()+" is making a video too — yours continues right after", step, true)
		} else {
			s.progress(j, st, k, math.Min(0.95, time.Since(t0).Seconds()/expected), sg.message, step, false)
		}
	}
}

// historyOutcome reads a /history entry like local-engine.js historyOutcome.
func historyOutcome(h *historyEntry) (ok bool, errMsg string, interrupted bool) {
	var errText string
	hadErr, intr := false, false
	for _, raw := range h.Status.Messages {
		var m []json.RawMessage
		if json.Unmarshal(raw, &m) != nil || len(m) < 1 {
			continue
		}
		var kind string
		json.Unmarshal(m[0], &kind)
		switch kind {
		case "execution_error":
			hadErr = true
			if len(m) > 1 {
				var d struct {
					Message string `json:"exception_message"`
					Type    string `json:"exception_type"`
				}
				json.Unmarshal(m[1], &d)
				errText = d.Type + ": " + d.Message
			}
		case "execution_interrupted":
			intr = true
		}
	}
	if h.Status.StatusStr == "error" || hadErr || intr {
		return false, errText, intr && !hadErr
	}
	if h.Status.StatusStr == "success" || h.Status.Completed {
		return true, "", false
	}
	return len(h.Outputs) > 0, "", false
}

func firstOutput(out map[string]json.RawMessage) (comfyFile, bool) {
	for _, key := range []string{"images", "gifs", "video", "videos", "audio", "files"} {
		var list []comfyFile
		if raw, ok := out[key]; ok && json.Unmarshal(raw, &list) == nil && len(list) > 0 && list[0].Filename != "" {
			return list[0], true
		}
	}
	return comfyFile{}, false
}

var safeOutputName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,200}$`)

// recordStep keeps what a finished step made: the raw file for the next steps,
// the labelled file for the friend.
func (s *Share) recordStep(ctx context.Context, port int, j *guestJob, step string, sg *stepGraph, h *historyEntry, in *stepInputs, took time.Duration) {
	st, k := stepParts(step)
	if sg.rawOut != "" {
		if f, ok := firstOutput(h.Outputs[sg.rawOut]); ok {
			if st == "still" {
				in.stills[k] = f.annotated()
			} else if st == "song" {
				in.song = f.annotated()
			}
		}
	}
	f, ok := firstOutput(h.Outputs[sg.guestOut])
	if !ok || !safeOutputName.MatchString(f.Filename) || f.Subfolder != "glow" || (f.Type != "" && f.Type != "output") ||
		!strings.HasPrefix(f.Filename, j.id+"_") {
		s.logf("job %s step %s: the labelled file is missing", j.id, step)
		return
	}
	jf := jobFile{comfy: f}
	shot := k
	switch st {
	case "still":
		jf.Name, jf.Kind, jf.Shot, jf.Width, jf.Height = fmt.Sprintf("still-%d.png", k), "still", &shot, 720, 1248
	case "video":
		jf.Name, jf.Kind, jf.Shot, jf.Width, jf.Height, jf.FPS, jf.Seconds = fmt.Sprintf("clip-%d.mp4", k), "clip", &shot, j.plan.Video.Width, j.plan.Video.Height, 32, i2vSeconds
	case "lipsync":
		jf.Name, jf.Kind, jf.Shot, jf.Width, jf.Height, jf.FPS, jf.Seconds = fmt.Sprintf("clip-%d.mp4", k), "clip", &shot, 480, 832, 16, s2vSeconds
	case "song":
		jf.Name, jf.Kind, jf.Seconds = "song.mp4", "song", j.plan.Song.Seconds
	}
	jf.Bytes = s.outputSize(ctx, port, f)
	s.mu.Lock()
	kept := j.files[:0]
	for _, x := range j.files {
		if x.Name != jf.Name {
			kept = append(kept, x)
		}
	}
	j.files = append(kept, jf)
	s.mu.Unlock()
	s.logf("job %s step %s done in %s", j.id, step, took.Round(time.Second))
}

func (s *Share) outputPath(f comfyFile) string {
	if !safeOutputName.MatchString(f.Filename) || (f.Subfolder != "glow" && f.Subfolder != "") {
		return ""
	}
	return filepath.Join(s.eng.shareInstallDir(), portableDir, "ComfyUI", "output", f.Subfolder, f.Filename)
}

func (s *Share) outputSize(ctx context.Context, port int, f comfyFile) int64 {
	if p := s.outputPath(f); p != "" {
		if st, err := os.Stat(p); err == nil {
			return st.Size()
		}
	}
	rc, n, err := comfyView(ctx, port, f)
	if err != nil {
		return 0
	}
	defer rc.Close()
	if n >= 0 {
		return n
	}
	c, _ := io.Copy(io.Discard, rc)
	return c
}

func comfyView(ctx context.Context, port int, f comfyFile) (io.ReadCloser, int64, error) {
	q := url.Values{"filename": {f.Filename}, "subfolder": {f.Subfolder}, "type": {"output"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/view?%s", port, q.Encode()), nil)
	resp, err := localClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.Body, resp.ContentLength, nil
}

// openOutput opens a labelled output for a friend's download: from ComfyUI
// when it runs, else from the output folder on disk.
func (s *Share) openOutput(f comfyFile) (io.ReadCloser, int64, error) {
	if port, state := s.eng.shareComfy(); state == "ready" {
		if rc, n, err := comfyView(context.Background(), port, f); err == nil {
			return rc, n, nil
		}
	}
	p := s.outputPath(f)
	if p == "" {
		return nil, 0, errors.New("bad output name")
	}
	fh, err := os.Open(p)
	if err != nil {
		return nil, 0, err
	}
	st, err := fh.Stat()
	if err != nil {
		fh.Close()
		return nil, 0, err
	}
	return fh, st.Size(), nil
}

// comfyUpload puts a file in ComfyUI's input\glow (POST /upload/image).
func comfyUpload(ctx context.Context, port int, name string, data []byte) error {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("image", name)
	fw.Write(data)
	mw.WriteField("type", "input")
	mw.WriteField("subfolder", "glow")
	mw.WriteField("overwrite", "true")
	mw.Close()
	c, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/upload/image", port), &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := localClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		Name      string `json:"name"`
		Subfolder string `json:"subfolder"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out) != nil {
		return fmt.Errorf("upload of %s: HTTP %d", name, resp.StatusCode)
	}
	if out.Name != name || out.Subfolder != "glow" {
		return fmt.Errorf("upload of %s was stored as %s/%s", name, out.Subfolder, out.Name)
	}
	return nil
}

// cleanupJob deletes a friend's files (selfie, song part, every output) and
// ComfyUI's history of their prompts. A running job is cleaned by the runner
// once it has stopped.
func (s *Share) cleanupJob(j *guestJob, why string) {
	s.mu.Lock()
	if j.cleaned || s.running == j {
		s.mu.Unlock()
		return
	}
	j.cleaned = true
	prompts := append([]string(nil), j.prompts...)
	j.selfie, j.wav, j.thumb = nil, nil, nil
	s.mu.Unlock()
	n := removeJobFiles(s.eng.shareInstallDir(), j.id)
	port, state := s.eng.shareComfy()
	if state == "ready" && len(prompts) > 0 {
		deleteComfyHistory(port, prompts)
	}
	s.logf("job %s %s, %d file(s) removed", j.id, why, n)
}
