package main

// Tests for the local AI engine (downloads, install job, ComfyUI process,
// proxy and WebSocket). No GPU, Windows or real model files are needed: files
// come from an in-process mock server and ComfyUI is replaced by this test
// binary itself (GLOW_TEST_MOCK_COMFY=1, see runMockComfy).
//
// Run with the web app copied next to the sources (go:embed), like build.sh:
//   cp -r ../glow ./glow && go test ./... ; rm -rf glow

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("GLOW_TEST_MOCK_COMFY") == "1" {
		runMockComfy()
		return
	}
	os.Exit(m.Run())
}

// ---------------------------------------------------------------- mock files

type mockFiles struct {
	mu          sync.Mutex
	files       map[string][]byte
	reqs        []string                 // "name range"
	cutOnce     map[string]int64         // first response: stop after N bytes (connection drop)
	stallOnce   map[string]int64         // first response: send N bytes then hang
	gate        map[string]chan struct{} // block after half of the file until closed
	ignoreRange bool
	status      map[string]int
	portal      int              // the next N answers are a 200 text/html login page
	served      map[string]int64 // body bytes sent per file
	resumeAt    map[string]int64 // 206 answers start at this offset instead of the requested one
	refuse416   map[string]int   // answer the next N Range requests with 416
	etag        map[string]string
	heads       int
}

func newMockFiles() *mockFiles {
	return &mockFiles{files: map[string][]byte{}, cutOnce: map[string]int64{}, stallOnce: map[string]int64{},
		gate: map[string]chan struct{}{}, status: map[string]int{}, served: map[string]int64{},
		resumeAt: map[string]int64{}, refuse416: map[string]int{}, etag: map[string]string{}}
}

func (m *mockFiles) requests(name string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, r := range m.reqs {
		if strings.HasPrefix(r, name+" ") {
			out = append(out, r)
		}
	}
	return out
}

func (m *mockFiles) all() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string{}, m.reqs...)
}

func (m *mockFiles) servedBytes(name string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.served[name]
}

func (m *mockFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	m.mu.Lock()
	if r.Method == http.MethodHead {
		// Hugging Face style: a redirect that names the file's sha256 and size.
		m.heads++
		et, data := m.etag[name], m.files[name]
		m.mu.Unlock()
		if et != "" {
			w.Header().Set("X-Linked-Etag", `"`+et+`"`)
			w.Header().Set("X-Linked-Size", strconv.Itoa(len(data)))
			w.Header().Set("Location", "/cdn/"+name)
			w.WriteHeader(http.StatusFound)
		}
		return
	}
	if m.portal > 0 {
		m.portal--
		m.reqs = append(m.reqs, name+" "+r.Header.Get("Range")+" (portal)")
		m.mu.Unlock()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", "40")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<html>Please sign in to Hotel WiFi</html>"))
		return
	}
	m.reqs = append(m.reqs, name+" "+r.Header.Get("Range"))
	if r.Header.Get("Range") != "" && m.refuse416[name] > 0 {
		m.refuse416[name]--
		m.mu.Unlock()
		w.Header().Set("Content-Range", "bytes */1")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	resumeAt, hasResumeAt := m.resumeAt[name]
	data, ok := m.files[name]
	code := m.status[name]
	cut, hasCut := m.cutOnce[name]
	delete(m.cutOnce, name)
	stall, hasStall := m.stallOnce[name]
	delete(m.stallOnce, name)
	gate := m.gate[name]
	ignore := m.ignoreRange
	m.mu.Unlock()
	if code != 0 {
		w.WriteHeader(code)
		return
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	start := int64(0)
	if rg := r.Header.Get("Range"); rg != "" && !ignore {
		fmt.Sscanf(rg, "bytes=%d-", &start)
		if hasResumeAt {
			start = resumeAt
		}
		if start >= int64(len(data)) {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", len(data)))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(data)-1, len(data)))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)-int(start)))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
	}
	body := data[start:]
	m.mu.Lock()
	m.served[name] += int64(len(body)) // what was offered (an upper bound if the client hangs up)
	m.mu.Unlock()
	fl := w.(http.Flusher)
	switch {
	case hasCut:
		w.Write(body[:cut])
		fl.Flush()
		panic(http.ErrAbortHandler) // drop the connection
	case hasStall:
		w.Write(body[:stall])
		fl.Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
		}
		panic(http.ErrAbortHandler)
	case gate != nil:
		half := len(body) / 2
		w.Write(body[:half])
		fl.Flush()
		select {
		case <-gate:
		case <-r.Context().Done():
			return
		}
		w.Write(body[half:])
	default:
		for i := 0; i < len(body); i += 64 << 10 {
			j := i + 64<<10
			if j > len(body) {
				j = len(body)
			}
			if _, err := w.Write(body[i:j]); err != nil {
				return
			}
		}
	}
}

func randBytes(n int, prefix string) []byte {
	b := make([]byte, n)
	rand.Read(b)
	copy(b, prefix)
	return b
}

func shaHex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func quickDownloader() *downloader {
	d := newDownloader()
	d.backoff, d.maxBackoff, d.stall, d.stateEvery = 20*time.Millisecond, 100*time.Millisecond, time.Second, 64<<10
	return d
}

// ---------------------------------------------------------------- downloader

func TestDownloadResumeAfterDrop(t *testing.T) {
	srv := newMockFiles()
	data := randBytes(3<<20, "")
	srv.files["a.bin"] = data
	srv.cutOnce["a.bin"] = 1 << 20
	hs := httptest.NewServer(srv)
	defer hs.Close()
	d := quickDownloader()
	dest := filepath.Join(t.TempDir(), "models", "a.bin")
	f := FileSpec{Name: "a.bin", Label: "A", URL: hs.URL + "/a.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	if err := d.fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
	reqs := srv.requests("a.bin")
	if len(reqs) != 2 || !strings.HasPrefix(reqs[1], "a.bin bytes=") || reqs[1] == "a.bin bytes=0-" {
		t.Fatalf("expected a ranged resume, got %q", reqs)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatal(".part left behind")
	}
	if _, err := os.Stat(dest + ".part.state"); !os.IsNotExist(err) {
		t.Fatal(".part.state left behind")
	}
}

func TestDownloadCancelThenResumeWithState(t *testing.T) {
	srv := newMockFiles()
	data := randBytes(2<<20, "")
	srv.files["b.bin"] = data
	gate := make(chan struct{})
	srv.gate["b.bin"] = gate
	hs := httptest.NewServer(srv)
	defer hs.Close()
	d := quickDownloader()
	dest := filepath.Join(t.TempDir(), "b.bin")
	f := FileSpec{Name: "b.bin", Label: "B", URL: hs.URL + "/b.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	ctx, cancel := context.WithCancel(context.Background())
	var onDisk int64
	var mu sync.Mutex
	errc := make(chan error, 1)
	go func() {
		errc <- d.fetch(ctx, f, dest, dlHooks{onDisk: func(n int64) { mu.Lock(); onDisk = n; mu.Unlock() }})
	}()
	waitFor(t, 5*time.Second, func() bool { mu.Lock(); defer mu.Unlock(); return onDisk >= 1<<20 })
	cancel()
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("want canceled, got %v", err)
	}
	st, err := os.Stat(dest + ".part")
	if err != nil || st.Size() != 1<<20 {
		t.Fatalf("part file: %v %v", st, err)
	}
	if off, _, ok := loadState(dest+".part.state", f); !ok || off != 1<<20 {
		t.Fatalf("state file: ok=%v off=%d", ok, off)
	}
	close(gate)
	delete(srv.gate, "b.bin")
	if err := d.fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	reqs := srv.requests("b.bin")
	if reqs[len(reqs)-1] != fmt.Sprintf("b.bin bytes=%d-", 1<<20) {
		t.Fatalf("resume should start at 1 MiB: %q", reqs)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
}

func TestDownloadResumeCutsUnsyncedTail(t *testing.T) {
	// Killed after a state save: the .part has more bytes than the state
	// describes. They are not trusted (after a power cut they can be zeros):
	// the .part is cut back to the state and the tail downloaded again.
	srv := newMockFiles()
	data := randBytes(2<<20, "")
	srv.files["t.bin"] = data
	gate := make(chan struct{})
	srv.gate["t.bin"] = gate
	hs := httptest.NewServer(srv)
	defer hs.Close()
	d := quickDownloader()
	dest := filepath.Join(t.TempDir(), "t.bin")
	f := FileSpec{Name: "t.bin", Label: "T", URL: hs.URL + "/t.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	var onDisk int64
	errc := make(chan error, 1)
	go func() {
		errc <- d.fetch(ctx, f, dest, dlHooks{onDisk: func(n int64) { mu.Lock(); onDisk = n; mu.Unlock() }})
	}()
	waitFor(t, 5*time.Second, func() bool { mu.Lock(); defer mu.Unlock(); return onDisk >= 1<<20 })
	cancel()
	<-errc
	close(gate)
	delete(srv.gate, "t.bin")
	fh, _ := os.OpenFile(dest+".part", os.O_WRONLY|os.O_APPEND, 0o644)
	fh.Write(data[1<<20 : 1<<20+300000]) // written but no state saved
	fh.Close()
	if err := d.fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	if r := srv.requests("t.bin"); r[len(r)-1] != fmt.Sprintf("t.bin bytes=%d-", 1<<20) {
		t.Fatalf("requests %q", r)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
}

func TestDownloadUnsyncedTailAfterPowerLoss(t *testing.T) {
	// The reviewer's case: an 8 MB file, state saved at 3 MB, and a .part that
	// NTFS shows 1 MB longer, all zeros. Only the 5 MB after the state may be
	// downloaded, not the whole file again after a sha256 mismatch.
	srv := newMockFiles()
	data := randBytes(8<<20, "")
	srv.files["p.bin"] = data
	hs := httptest.NewServer(srv)
	defer hs.Close()
	dest := filepath.Join(t.TempDir(), "p.bin")
	f := FileSpec{Name: "p.bin", Label: "P", URL: hs.URL + "/p.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	os.WriteFile(dest+".part", append(append([]byte{}, data[:3<<20]...), make([]byte, 1<<20)...), 0o644)
	h := sha256.New()
	h.Write(data[:3<<20])
	saveState(dest+".part.state", f, 3<<20, h)
	if err := quickDownloader().fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	if got := srv.servedBytes("p.bin"); got != 5<<20 {
		t.Fatalf("server sent %d bytes for a file with 5 MB left: %q", got, srv.requests("p.bin"))
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
}

func TestDownloadCaptivePortalKeepsPart(t *testing.T) {
	// A laptop wakes up on hotel Wi-Fi: every request gets a 200 login page.
	// The 3 MB already downloaded must survive, and the message must say what
	// to do; once the Wi-Fi works, the download continues where it was.
	srv := newMockFiles()
	data := randBytes(4<<20, "")
	srv.files["m.bin"] = data
	hs := httptest.NewServer(srv)
	defer hs.Close()
	dest := filepath.Join(t.TempDir(), "m.bin")
	f := FileSpec{Name: "m.bin", Label: "M", URL: hs.URL + "/m.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	os.WriteFile(dest+".part", data[:3<<20], 0o644)
	h := sha256.New()
	h.Write(data[:3<<20])
	saveState(dest+".part.state", f, 3<<20, h)
	d := quickDownloader()
	d.maxTries = 3
	srv.portal = 100
	err := d.fetch(context.Background(), f, dest, dlHooks{})
	if err == nil || !strings.Contains(userMsg(err), "sign in to the Wi-Fi") || !strings.Contains(userMsg(err), "Nothing downloaded so far is lost") {
		t.Fatalf("error %v", err)
	}
	if st, _ := os.Stat(dest + ".part"); st == nil || st.Size() != 3<<20 {
		t.Fatalf(".part after the portal answers: %v", st)
	}
	// The Wi-Fi works again.
	srv.mu.Lock()
	srv.portal = 0
	srv.mu.Unlock()
	if err := d.fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	r := srv.requests("m.bin")
	if r[len(r)-1] != fmt.Sprintf("m.bin bytes=%d-", 3<<20) {
		t.Fatalf("did not resume: %q", r)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
}

func TestDownloadOddResumeAnswersKeepPart(t *testing.T) {
	data := randBytes(1<<20, "")
	f := func(url string) FileSpec {
		return FileSpec{Name: "o.bin", Label: "O", URL: url + "/o.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	}
	setup := func(t *testing.T) (*mockFiles, string, FileSpec) {
		srv := newMockFiles()
		srv.files["o.bin"] = data
		hs := httptest.NewServer(srv)
		t.Cleanup(hs.Close)
		dest := filepath.Join(t.TempDir(), "o.bin")
		fs := f(hs.URL)
		os.WriteFile(dest+".part", data[:600000], 0o644)
		h := sha256.New()
		h.Write(data[:600000])
		saveState(dest+".part.state", fs, 600000, h)
		return srv, dest, fs
	}
	check := func(t *testing.T, dest string) {
		got, _ := os.ReadFile(dest)
		if !bytes.Equal(got, data) {
			t.Fatal("content differs")
		}
	}
	t.Run("resumed a little earlier: skip what we have", func(t *testing.T) {
		srv, dest, fs := setup(t)
		srv.resumeAt["o.bin"] = 500000
		if err := quickDownloader().fetch(context.Background(), fs, dest, dlHooks{}); err != nil {
			t.Fatal(err)
		}
		check(t, dest)
		if r := srv.requests("o.bin"); len(r) != 1 {
			t.Fatalf("requests %q", r)
		}
	})
	t.Run("two 416 answers, then it works", func(t *testing.T) {
		srv, dest, fs := setup(t)
		srv.refuse416["o.bin"] = 2
		if err := quickDownloader().fetch(context.Background(), fs, dest, dlHooks{}); err != nil {
			t.Fatal(err)
		}
		check(t, dest)
		if r := srv.requests("o.bin"); len(r) != 3 || r[2] != "o.bin bytes=600000-" {
			t.Fatalf("requests %q", r)
		}
	})
	t.Run("always resumes at the wrong place: start over after 3 answers", func(t *testing.T) {
		srv, dest, fs := setup(t)
		srv.resumeAt["o.bin"] = 700000
		if err := quickDownloader().fetch(context.Background(), fs, dest, dlHooks{}); err != nil {
			t.Fatal(err)
		}
		check(t, dest)
		r := srv.requests("o.bin")
		if len(r) != 4 || r[3] != "o.bin " {
			t.Fatalf("requests %q", r)
		}
	})
	t.Run("200 with another size keeps the part", func(t *testing.T) {
		srv, dest, fs := setup(t)
		fs.Size = int64(len(data)) + 5 // the server's file is "too small"
		d := quickDownloader()
		d.maxTries = 2
		srv.ignoreRange = true
		if err := d.fetch(context.Background(), fs, dest, dlHooks{}); err == nil {
			t.Fatal("expected an error")
		}
		if st, _ := os.Stat(dest + ".part"); st == nil || st.Size() != 600000 {
			t.Fatalf(".part %v", st)
		}
	})
}

func TestDownloadPublisherChanged(t *testing.T) {
	srv := newMockFiles()
	data := randBytes(300000, "")
	srv.files["q.bin"] = data
	hs := httptest.NewServer(srv)
	defer hs.Close()
	f := FileSpec{Name: "q.bin", Label: "Photo model", URL: hs.URL + "/q.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	// The publisher re-uploaded the file: HEAD says so, nothing is downloaded.
	srv.etag["q.bin"] = strings.Repeat("ab", 32)
	err := quickDownloader().fetch(context.Background(), f, filepath.Join(t.TempDir(), "q.bin"), dlHooks{})
	if err == nil || !strings.Contains(userMsg(err), "changed by its publisher") || !strings.Contains(userMsg(err), "latest Glow Studio") {
		t.Fatalf("error %v", err)
	}
	if r := srv.requests("q.bin"); len(r) != 0 {
		t.Fatalf("nothing should be downloaded: %q", r)
	}
	// The pinned file: HEAD agrees, the download goes ahead.
	srv.etag["q.bin"] = shaHex(data)
	if err := quickDownloader().fetch(context.Background(), f, filepath.Join(t.TempDir(), "q.bin"), dlHooks{}); err != nil {
		t.Fatal(err)
	}
	if srv.heads != 2 {
		t.Fatalf("HEAD requests %d", srv.heads)
	}
}

func TestRenameRetry(t *testing.T) {
	dir := t.TempDir()
	from, to := filepath.Join(dir, "a.part"), filepath.Join(dir, "a")
	os.WriteFile(from, []byte("x"), 0o644)
	fails := 3
	osRename = func(a, b string) error {
		if fails > 0 {
			fails--
			return &os.LinkError{Op: "rename", Old: a, New: b, Err: errTransientTest}
		}
		return os.Rename(a, b)
	}
	defer func() { osRename = os.Rename }()
	if err := renameRetry(from, to); err != nil || fails != 0 {
		t.Fatalf("%v %d", err, fails)
	}
	// Held for good: the message points at the antivirus, not at the folder.
	renameRetryFor = 100 * time.Millisecond
	defer func() { renameRetryFor = 5 * time.Second }()
	fails = 1 << 30
	os.WriteFile(from, []byte("x"), 0o644)
	err := renameRetry(from, to)
	if err == nil || !strings.Contains(userMsg(justWrittenError(err, to)), "antivirus") {
		t.Fatalf("%v", err)
	}
}

func TestDownloadResumeWithoutStateRehashes(t *testing.T) {
	srv := newMockFiles()
	data := randBytes(1<<20, "")
	srv.files["c.bin"] = data
	hs := httptest.NewServer(srv)
	defer hs.Close()
	dest := filepath.Join(t.TempDir(), "c.bin")
	os.WriteFile(dest+".part", data[:300000], 0o644) // e.g. left by an older crash, no state
	f := FileSpec{Name: "c.bin", Label: "C", URL: hs.URL + "/c.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	phases := []string{}
	if err := quickDownloader().fetch(context.Background(), f, dest, dlHooks{phase: func(p string) { phases = append(phases, p) }}); err != nil {
		t.Fatal(err)
	}
	if phases[0] != "check" {
		t.Fatalf("expected a check phase first: %v", phases)
	}
	if r := srv.requests("c.bin"); len(r) != 1 || r[0] != "c.bin bytes=300000-" {
		t.Fatalf("requests %q", r)
	}
}

func TestDownloadServerIgnoresRange(t *testing.T) {
	srv := newMockFiles()
	srv.ignoreRange = true
	data := randBytes(1<<20, "")
	srv.files["d.bin"] = data
	hs := httptest.NewServer(srv)
	defer hs.Close()
	dest := filepath.Join(t.TempDir(), "d.bin")
	os.WriteFile(dest+".part", data[:1000], 0o644)
	f := FileSpec{Name: "d.bin", Label: "D", URL: hs.URL + "/d.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	if err := quickDownloader().fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
}

func TestDownloadShaMismatch(t *testing.T) {
	srv := newMockFiles()
	data := randBytes(200000, "")
	srv.files["e.bin"] = data
	hs := httptest.NewServer(srv)
	defer hs.Close()
	dest := filepath.Join(t.TempDir(), "e.bin")
	f := FileSpec{Name: "e.bin", Label: "Video model", URL: hs.URL + "/e.bin", Size: int64(len(data)), SHA256: strings.Repeat("0", 64)}
	err := quickDownloader().fetch(context.Background(), f, dest, dlHooks{})
	var ue *userError
	if !errors.As(err, &ue) || !strings.Contains(ue.msg, "damaged twice") {
		t.Fatalf("want a damaged error, got %v", err)
	}
	if n := len(srv.requests("e.bin")); n != 2 {
		t.Fatalf("want 2 full attempts, got %d", n)
	}
	for _, p := range []string{dest, dest + ".part", dest + ".part.state"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s should not exist", p)
		}
	}
}

func TestDownloadStallRetries(t *testing.T) {
	srv := newMockFiles()
	data := randBytes(500000, "")
	srv.files["f.bin"] = data
	srv.stallOnce["f.bin"] = 100000
	hs := httptest.NewServer(srv)
	defer hs.Close()
	dest := filepath.Join(t.TempDir(), "f.bin")
	f := FileSpec{Name: "f.bin", Label: "F", URL: hs.URL + "/f.bin", Size: int64(len(data)), SHA256: shaHex(data)}
	start := time.Now()
	if err := quickDownloader().fetch(context.Background(), f, dest, dlHooks{}); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("stall was not detected quickly")
	}
	if r := srv.requests("f.bin"); len(r) != 2 || r[1] != "f.bin bytes=100000-" {
		t.Fatalf("requests %q", r)
	}
}

func TestDownload404IsFriendly(t *testing.T) {
	hs := httptest.NewServer(newMockFiles())
	defer hs.Close()
	f := FileSpec{Name: "x.bin", Label: "Photo model", URL: hs.URL + "/x.bin", Size: 10}
	err := quickDownloader().fetch(context.Background(), f, filepath.Join(t.TempDir(), "x.bin"), dlHooks{})
	if err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("got %v", err)
	}
}

func TestDownloadFlexibleSize(t *testing.T) {
	srv := newMockFiles()
	pinned := randBytes(4000, "MZ")
	newer := randBytes(5000, "MZ")
	srv.files["7zr.exe"] = newer
	hs := httptest.NewServer(srv)
	defer hs.Close()
	f := FileSpec{Name: "7zr.exe", Label: "tool", URL: hs.URL + "/7zr.exe", Size: int64(len(pinned)), SHA256: shaHex(pinned),
		SizeFlexible: true, MinSize: 1000, MaxSize: 10000, Magic: "4d5a"}
	dir := t.TempDir()
	if err := quickDownloader().fetch(context.Background(), f, filepath.Join(dir, "a"), dlHooks{}); err != nil {
		t.Fatalf("a newer build (other size, MZ) should be accepted: %v", err)
	}
	bad := append([]byte{}, pinned...)
	bad[100] ^= 1
	srv.files["7zr.exe"] = bad
	if err := quickDownloader().fetch(context.Background(), f, filepath.Join(dir, "b"), dlHooks{}); err == nil {
		t.Fatal("pinned size with a wrong sha256 must be rejected")
	}
	srv.files["7zr.exe"] = randBytes(5000, "XX")
	if err := quickDownloader().fetch(context.Background(), f, filepath.Join(dir, "c"), dlHooks{}); err == nil {
		t.Fatal("a file without the MZ signature must be rejected")
	}
}

func TestURLRewrite(t *testing.T) {
	rw := urlRewriter("https://huggingface.co/=http://127.0.0.1:8181/hf/;https://=http://127.0.0.1:8181/")
	if got := rw("https://huggingface.co/a/b"); got != "http://127.0.0.1:8181/hf/a/b" {
		t.Fatal(got)
	}
	if got := rw("https://github.com/x"); got != "http://127.0.0.1:8181/github.com/x" {
		t.Fatal(got)
	}
}

// ---------------------------------------------------------------- small units

func TestParseNvidiaSmi(t *testing.T) {
	g := parseNvidiaSmi("NVIDIA GeForce RTX 5060, 8151, 576.88\r\n")
	if g == nil || g.Name != "NVIDIA GeForce RTX 5060" || g.VramMB != 8151 || g.Driver != "576.88" || g.DriverOk || g.MinDriver != "580.00" {
		t.Fatalf("%+v", g)
	}
	g = parseNvidiaSmi("NVIDIA GeForce GTX 1050, 2048, 581.57\nNVIDIA GeForce RTX 5060 Laptop GPU, 8188, 581.57\n")
	if g == nil || !strings.Contains(g.Name, "5060") || !g.DriverOk {
		t.Fatalf("%+v", g)
	}
	if parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.") != nil {
		t.Fatal("garbage must give nil")
	}
}

func TestValidateInstallDir(t *testing.T) {
	base := t.TempDir()
	t.Setenv("OneDrive", filepath.Join(base, "Sync"))
	t.Setenv("ProgramFiles", filepath.Join(base, "PF"))
	bad := []string{"", "relative/dir", filepath.Join(base, "Sync", "x"), filepath.Join(base, "OneDrive - Contoso", "x"),
		filepath.Join(base, "PF", "Glow"), filepath.Join(base, "Program Files (x86)", "Glow"), filepath.Join(base, strings.Repeat("a", 120))}
	for _, p := range bad {
		if _, err := validateInstallDir(p); err == nil {
			t.Errorf("%q should be rejected", p)
		}
	}
	if got, err := validateInstallDir(` "` + filepath.Join(base, "Glow") + `" `); err != nil || got != filepath.Join(base, "Glow") {
		t.Errorf("got %q %v", got, err)
	}
	root := string(filepath.Separator)
	if got, err := validateInstallDir(root); err != nil || got != filepath.Join(root, "GlowStudio", "engine") {
		t.Errorf("drive root: %q %v", got, err)
	}
}

func TestRingLogCollapsesProgress(t *testing.T) {
	r := &ringLog{max: 5}
	r.pump(strings.NewReader("start\n\x1b[32mgreen\x1b[0m\r 25%|##  | 1/4\r 50%|#### | 2/4\r100%|######| 4/4\ndone\n"), r.add)
	got := strings.Join(r.last(10), "|")
	if got != "start|green|100%|######| 4/4|done" {
		t.Fatal(got)
	}
	for i := 0; i < 10; i++ {
		r.addf("line %d", i)
	}
	if l := r.last(40); len(l) != 5 || l[4] != "line 9" {
		t.Fatal(l)
	}
}

func TestExplainCrash(t *testing.T) {
	cases := map[string]string{
		"OSError: [WinError 126] ... c10.dll":                       "Visual C++",
		"RuntimeError: The NVIDIA driver on your system is too old": "driver is too old",
		"OSError: [WinError 1455] The paging file is too small":     "paging file",
		"torch.OutOfMemoryError: CUDA out of memory":                "ran out of memory",
	}
	for line, want := range cases {
		if got, _ := explainCrash([]string{line}, nil, false, false); !strings.Contains(got, want) {
			t.Errorf("%q -> %q", line, got)
		}
	}
	for _, line := range []string{"ModuleNotFoundError: No module named 'torch'", "can't open file 'ComfyUI\\main.py'"} {
		if got, damaged := explainCrash([]string{line}, nil, false, false); !damaged || !strings.Contains(got, "Check & repair files") || strings.Contains(got, "Install") {
			t.Errorf("%q -> %q %v", line, got, damaged)
		}
	}
	// c10.dll could not be loaded because it is gone: not a Microsoft component.
	if got, damaged := explainCrash([]string{"OSError: [WinError 126] ... c10.dll"}, nil, false, true); !damaged || !strings.Contains(got, "missing or damaged") {
		t.Errorf("c10 missing -> %q", got)
	}
}

// ---------------------------------------------------------------- launcher harness

type harness struct {
	t      *testing.T
	e      *Engine
	srv    *httptest.Server
	files  *mockFiles
	fsrv   *httptest.Server
	dir    string
	origin string
	cat    *Catalog
	data   map[string][]byte
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, files: newMockFiles(), data: map[string][]byte{}}
	h.fsrv = httptest.NewServer(h.files)
	t.Cleanup(h.fsrv.Close)
	h.dir = t.TempDir()
	mk := func(name, folder, magic string, n int, withSha bool) FileSpec {
		b := randBytes(n, magic)
		h.files.files[name] = b
		h.data[name] = b
		f := FileSpec{Label: "Mock " + name, Name: name, Folder: folder, URL: "https://example.invalid/" + name, Size: int64(n)}
		if withSha {
			f.SHA256 = shaHex(b)
		}
		return f
	}
	tool := mk("7zr.exe", "", "MZ", 3000, true)
	tool.SizeFlexible, tool.MinSize, tool.MaxSize, tool.Magic = true, 1000, 100000, "4d5a"
	eng := mk("portable.7z", "", "7z\xbc\xaf\x27\x1c", 200000, false)
	eng.Magic = "377abcaf271c"
	h.cat = &Catalog{Tool: tool, Engine: eng, Packs: []PackSpec{
		{ID: "core", Files: []FileSpec{mk("still.safetensors", "diffusion_models", "", 1<<20, true), mk("video.safetensors", "diffusion_models", "", 1<<20, true), mk("rife.safetensors", "frame_interpolation", "", 50000, true)}},
		{ID: "singing", Files: []FileSpec{mk("song.safetensors", "diffusion_models", "", 300000, true)}},
		{ID: "fast", Files: []FileSpec{mk("klein.safetensors", "diffusion_models", "", 300000, true)}},
	}}
	catPath := filepath.Join(h.dir, "catalog.json")
	data, _ := json.Marshal(h.cat)
	os.WriteFile(catPath, data, 0o644)
	t.Setenv("GLOW_ENGINE_CATALOG", catPath)
	t.Setenv("GLOW_ENGINE_URL_REWRITE", "https://example.invalid/="+h.fsrv.URL+"/")
	t.Setenv("GLOW_ENGINE_DIR", filepath.Join(h.dir, "GlowStudio", "engine"))
	t.Setenv("GLOW_SKIP_7Z", "1")
	t.Setenv("GLOW_FAKE_DISK_FREE_GB", "500")
	t.Setenv("GLOW_DL_BACKOFF_MS", "20")
	t.Setenv("GLOW_NVIDIA_SMI", writeScript(t, h.dir, "nvidia-smi", "echo 'NVIDIA GeForce RTX 5060, 8151, 576.88'"))
	exe, _ := os.Executable()
	t.Setenv("GLOW_COMFY_CMD", exe)
	t.Setenv("GLOW_TEST_MOCK_COMFY", "1")
	t.Setenv("GLOW_COMFY_PORT", "8185")
	t.Setenv("GLOW_QUEUE_POLL_MS", "100")
	h.start()
	return h
}

// start (re)creates the launcher, as if the app was opened again.
func (h *harness) start() {
	if h.srv != nil {
		h.srv.Close()
	}
	if h.e != nil {
		h.e.Shutdown() // the old "process" ends (and frees the folder lock)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		h.t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	h.e = newEngine(port)
	h.e.dl.stateEvery = 64 << 10
	mux := http.NewServeMux()
	mux.Handle("/__glow/engine/", h.e.apiHandler())
	mux.Handle("/__glow/comfy/", h.e.proxyHandler())
	h.srv = httptest.NewUnstartedServer(mux)
	h.srv.Listener.Close()
	h.srv.Listener = ln
	h.srv.Start()
	h.origin = fmt.Sprintf("http://127.0.0.1:%d", port)
	e := h.e
	h.t.Cleanup(func() { e.Shutdown() })
}

func writeScript(t *testing.T, dir, name, body string) string {
	p := filepath.Join(dir, name)
	os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755)
	return p
}

func (h *harness) do(method, path string, body any, hdr ...string) (int, map[string]any) {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	for i := 0; i+1 < len(hdr); i += 2 {
		if hdr[i] == "Host" {
			req.Host = hdr[i+1]
		} else {
			req.Header.Set(hdr[i], hdr[i+1])
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	raw, _ := io.ReadAll(resp.Body)
	json.Unmarshal(raw, &out)
	if len(out) == 0 {
		out["_raw"] = string(raw)
	}
	return resp.StatusCode, out
}

func (h *harness) status() statusJSON {
	h.t.Helper()
	resp, err := http.Get(h.srv.URL + "/__glow/engine/status")
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	var s statusJSON
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		h.t.Fatal(err)
	}
	return s
}

func (h *harness) waitJob(states ...string) statusJSON {
	h.t.Helper()
	var s statusJSON
	waitFor(h.t, 20*time.Second, func() bool {
		s = h.status()
		if s.Job == nil {
			return false
		}
		for _, st := range states {
			if s.Job.State == st {
				return true
			}
		}
		return false
	})
	return s
}

func (h *harness) waitEngine(state string) statusJSON {
	h.t.Helper()
	var s statusJSON
	waitFor(h.t, 20*time.Second, func() bool { s = h.status(); return s.Engine.State == state })
	return s
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func (h *harness) installCore() {
	h.t.Helper()
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}}); code != 202 {
		h.t.Fatalf("install: %d %v", code, out)
	}
	if s := h.waitJob("done", "error"); s.Job.State != "done" {
		h.t.Fatalf("install failed: %+v", s.Job)
	}
}

// ---------------------------------------------------------------- install job

func TestInstallFlow(t *testing.T) {
	h := newHarness(t)
	s := h.status()
	if s.Launcher != "1.1.0" || s.OS != runtime.GOOS || s.Engine.State != "not-installed" || s.Job != nil || s.Packs["core"].Installed {
		t.Fatalf("initial status %+v", s)
	}
	if s.GPU == nil || s.GPU.VramMB != 8151 || s.GPU.DriverOk || s.GPU.MinDriver != "580.00" {
		t.Fatalf("gpu %+v", s.GPU)
	}
	if s.InstallDir != filepath.Join(h.dir, "GlowStudio", "engine") || s.Engine.Log == nil {
		t.Fatalf("dir %q log %v", s.InstallDir, s.Engine.Log)
	}
	if want := round1(float64(h.cat.packBytes("core")) / 1e9); s.Packs["core"].SizeGB != want || s.Packs["core"].Label != "Dance & party scenes" {
		t.Fatalf("pack %+v", s.Packs["core"])
	}

	// Disk check: needed + 10 GB margin.
	t.Setenv("GLOW_FAKE_DISK_FREE_GB", "12")
	code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}})
	if code != 400 || !strings.Contains(fmt.Sprint(out["error"]), "Not enough free space") {
		t.Fatalf("disk check: %d %v", code, out)
	}
	t.Setenv("GLOW_FAKE_DISK_FREE_GB", "500")
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"bogus"}}); code != 400 {
		t.Fatalf("unknown pack: %d %v", code, out)
	}
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{}, "installDir": "relative"}); code != 400 {
		t.Fatalf("relative dir: %d %v", code, out)
	}

	// Hold one model half-way so the job is visibly running.
	gate := make(chan struct{})
	h.files.gate["video.safetensors"] = gate
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"singing"}}); code != 202 || out["ok"] != true {
		t.Fatalf("install: %d %v", code, out)
	}
	waitFor(t, 10*time.Second, func() bool {
		s := h.status()
		return s.Job != nil && s.Job.File != nil && *s.Job.File == "video.safetensors" && s.Job.BytesDone > 0
	})
	if code, _ := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}}); code != 409 {
		t.Fatalf("second install should be 409, got %d", code)
	}
	if code, out := h.do("POST", "/__glow/engine/start", nil); code != 409 {
		t.Fatalf("start before install should be 409: %d %v", code, out)
	}
	s = h.status()
	if s.Job.Kind != "install" || s.Job.State != "running" || !strings.Contains(s.Job.Step, "Downloading AI model 2 of 4") ||
		s.Job.OverallTotal != h.cat.packBytes("core")+h.cat.packBytes("singing") || s.Job.OverallDone <= s.Job.BytesDone {
		t.Fatalf("running job %+v", s.Job)
	}
	if !h.e.Busy() {
		t.Fatal("a running install must block the idle exit")
	}
	close(gate)
	delete(h.files.gate, "video.safetensors")
	s = h.waitJob("done", "error")
	if s.Job.State != "done" || s.Job.OverallDone != s.Job.OverallTotal || s.Job.Error != nil {
		t.Fatalf("job %+v", s.Job)
	}
	if !s.Packs["core"].Installed || !s.Packs["singing"].Installed || s.Packs["fast"].Installed || s.Engine.State != "stopped" {
		t.Fatalf("packs %+v engine %+v", s.Packs, s.Engine)
	}
	if s.Packs["fast"].RemainingGB != round2(300000/1e9) || s.Packs["core"].RemainingGB != 0 {
		t.Fatalf("remaining %+v", s.Packs)
	}
	if s.Engine.ComfyVersion == nil || *s.Engine.ComfyVersion != "0.44.0" {
		t.Fatalf("comfyVersion %v", s.Engine.ComfyVersion)
	}
	models := filepath.Join(s.InstallDir, portableDir, "ComfyUI", "models")
	for name, folder := range map[string]string{"still.safetensors": "diffusion_models", "rife.safetensors": "frame_interpolation", "song.safetensors": "diffusion_models"} {
		got, err := os.ReadFile(filepath.Join(models, folder, name))
		if err != nil || !bytes.Equal(got, h.data[name]) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(s.InstallDir, "downloads", "portable.7z")); !os.IsNotExist(err) {
		t.Fatal("the engine archive should be deleted after unpacking")
	}
	man := loadManifest(s.InstallDir)
	if !man.EngineExtracted || !man.Packs["core"].Installed || !man.Packs["singing"].Installed || len(man.Pending) != 0 || man.Files["diffusion_models/still.safetensors"].SHA256 != h.cat.Packs[0].Files[0].SHA256 {
		t.Fatalf("manifest %+v", man)
	}

	// Idempotent: nothing is downloaded again.
	before := len(h.files.all())
	h.installCore()
	if len(h.files.all()) != before {
		t.Fatalf("re-install downloaded again: %v", h.files.all()[before:])
	}

	// Repair: a damaged model is noticed and only it is downloaded again.
	p := filepath.Join(models, "diffusion_models", "video.safetensors")
	os.Truncate(p, 100)
	if h.status().Packs["core"].Installed {
		t.Fatal("a truncated model must make core not installed")
	}
	before = len(h.files.all())
	h.installCore()
	if got := h.files.all()[before:]; len(got) != 1 || !strings.HasPrefix(got[0], "video.safetensors") {
		t.Fatalf("repair requests %q", got)
	}
	// Repair without manifest: files on disk are re-checked, not downloaded.
	os.Remove(filepath.Join(s.InstallDir, manifestName))
	os.MkdirAll(filepath.Join(s.InstallDir, "downloads"), 0o755)
	h.start()
	before = len(h.files.all())
	h.installCore()
	for _, r := range h.files.all()[before:] {
		if strings.Contains(r, "safetensors") {
			t.Fatalf("models should be re-checked, not downloaded: %q", h.files.all()[before:])
		}
	}
}

func TestInstallCancelResumeAcrossRestart(t *testing.T) {
	h := newHarness(t)
	gate := make(chan struct{})
	h.files.gate["still.safetensors"] = gate
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core", "fast"}})
	waitFor(t, 10*time.Second, func() bool {
		s := h.status()
		return s.Job != nil && s.Job.File != nil && *s.Job.File == "still.safetensors" && s.Job.BytesDone >= 1<<19
	})
	if code, out := h.do("POST", "/__glow/engine/cancel", nil); code != 200 || out["ok"] != true {
		t.Fatalf("cancel %d %v", code, out)
	}
	s := h.status()
	if s.Job.State != "cancelled" || !strings.Contains(s.Job.Step, "Resume") {
		t.Fatalf("after cancel %+v", s.Job)
	}
	dest := filepath.Join(s.InstallDir, portableDir, "ComfyUI", "models", "diffusion_models", "still.safetensors")
	if st, err := os.Stat(dest + ".part"); err != nil || st.Size() != 1<<19 {
		t.Fatalf("partial file kept? %v %v", st, err)
	}
	if code, _ := h.do("POST", "/__glow/engine/cancel", nil); code != 200 {
		t.Fatal("cancel with no job must be 200")
	}
	close(gate)
	delete(h.files.gate, "still.safetensors")

	// The app is closed and opened again: the paused install is still shown.
	h.e.Shutdown()
	h.start()
	s = h.status()
	if s.Job == nil || s.Job.State != "cancelled" || strings.Join(s.Job.Packs, ",") != "core,fast" || s.Job.OverallDone < 1<<19 {
		t.Fatalf("after restart %+v", s.Job)
	}
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": s.Job.Packs})
	s = h.waitJob("done", "error")
	if s.Job.State != "done" || !s.Packs["fast"].Installed {
		t.Fatalf("resume %+v", s.Job)
	}
	r := h.files.requests("still.safetensors")
	if r[len(r)-1] != fmt.Sprintf("still.safetensors bytes=%d-", 1<<19) {
		t.Fatalf("resume did not use Range: %q", r)
	}
	h.start()
	if h.status().Job != nil {
		t.Fatal("a finished install must not come back after a restart")
	}
}

func TestInstallErrorsAreFriendly(t *testing.T) {
	h := newHarness(t)
	h.files.status["rife.safetensors"] = 404
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}})
	s := h.waitJob("done", "error")
	if s.Job.State != "error" || s.Job.Error == nil || !strings.Contains(*s.Job.Error, "not available") {
		t.Fatalf("%+v", s.Job)
	}
	found := false
	for _, l := range s.Engine.Log {
		found = found || strings.Contains(l, "[install]")
	}
	if !found {
		t.Fatalf("install lines should be in the log: %v", s.Engine.Log)
	}
}

func TestInstallDirChoice(t *testing.T) {
	h := newHarness(t)
	other := filepath.Join(h.dir, "D", "GlowAI")
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}, "installDir": other}); code != 202 {
		t.Fatalf("%d %v", code, out)
	}
	s := h.waitJob("done", "error")
	if s.Job.State != "done" || s.InstallDir != other || !s.Packs["core"].Installed {
		t.Fatalf("%+v %q", s.Job, s.InstallDir)
	}
	h.start() // remembered after a restart
	if s := h.status(); s.InstallDir != other || !s.Packs["core"].Installed {
		t.Fatalf("after restart %q", s.InstallDir)
	}
}

func TestExtractWith7zCommand(t *testing.T) {
	h := newHarness(t)
	t.Setenv("GLOW_SKIP_7Z", "")
	// A stand-in for 7zr.exe: checks the arguments, prints 7-Zip style
	// progress (with backspaces) and creates the portable layout.
	script := writeScript(t, h.dir, "fake7z", `[ "$1" = x ] || exit 7
out=""; for a in "$@"; do case "$a" in -o*) out="${a#-o}";; esac; done
[ -f "$2" ] || exit 2
printf '  0%%\b\b\b\b 45%% 10 - ComfyUI_windows_portable\\python_embeded\\python.exe\b\b\b\b100%%\n'
mkdir -p "$out/ComfyUI_windows_portable/ComfyUI" "$out/ComfyUI_windows_portable/python_embeded"
echo "# main" > "$out/ComfyUI_windows_portable/ComfyUI/main.py"
echo "Everything is Ok"`)
	t.Setenv("GLOW_7Z_CMD", "/bin/sh "+script)
	h.installCore()
	s := h.status()
	if !s.Packs["core"].Installed {
		t.Fatal("not installed")
	}
	logs := strings.Join(s.Engine.Log, "\n")
	if !strings.Contains(logs, "[7-zip] Everything is Ok") || strings.Contains(logs, "45%") {
		t.Fatalf("7-zip output handling: %s", logs)
	}

	// A damaged archive is forgotten so Resume downloads it again.
	h2 := newHarness(t)
	t.Setenv("GLOW_SKIP_7Z", "")
	t.Setenv("GLOW_7Z_CMD", "/bin/sh "+writeScript(t, h2.dir, "bad7z", `echo "ERROR: Data Error : ComfyUI_windows_portable\\x"; exit 2`))
	h2.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}})
	s = h2.waitJob("done", "error")
	if s.Job.State != "error" || !strings.Contains(*s.Job.Error, "damaged") {
		t.Fatalf("%+v", s.Job)
	}
	if _, err := os.Stat(filepath.Join(s.InstallDir, "downloads", "portable.7z")); !os.IsNotExist(err) {
		t.Fatal("a damaged archive must be deleted")
	}
}

func TestInstallProgressStableAcrossResume(t *testing.T) {
	// Overall progress must not jump back after Resume, Try again or an app
	// restart: verified files count as done, and models are numbered over all.
	h := newHarness(t)
	gate := make(chan struct{})
	h.files.gate["video.safetensors"] = gate
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}})
	waitFor(t, 10*time.Second, func() bool {
		s := h.status()
		return s.Job != nil && s.Job.File != nil && *s.Job.File == "video.safetensors" && s.Job.BytesDone > 0
	})
	h.do("POST", "/__glow/engine/cancel", nil)
	paused := h.status().Job
	total := h.cat.packBytes("core")
	if paused.OverallTotal != total || paused.OverallDone < h.cat.Tool.Size+h.cat.Engine.Size+(1<<20) {
		t.Fatalf("paused %+v (core %d)", paused, total)
	}
	gate2 := make(chan struct{})
	h.files.gate["video.safetensors"] = gate2 // hold the resumed download too
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}})
	var j *jobJSON
	waitFor(t, 10*time.Second, func() bool {
		j = h.status().Job
		return j.File != nil && *j.File == "video.safetensors" && strings.HasPrefix(j.Step, "Downloading")
	})
	if j.OverallTotal != total || j.OverallDone < paused.OverallDone || !strings.Contains(j.Step, "AI model 2 of 3") {
		t.Fatalf("after Resume %+v (paused at %d of %d)", j, paused.OverallDone, paused.OverallTotal)
	}
	h.do("POST", "/__glow/engine/cancel", nil)
	h.start() // the app is closed and opened again
	j = h.status().Job
	if j.State != "cancelled" || j.OverallTotal != total || j.OverallDone < paused.OverallDone {
		t.Fatalf("after restart %+v", j)
	}
	close(gate)
	close(gate2)
	delete(h.files.gate, "video.safetensors")
	h.installCore()
	// Adding a pack later counts only that pack.
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core", "singing"}})
	s := h.waitJob("done", "error")
	if s.Job.State != "done" || s.Job.OverallTotal != h.cat.packBytes("singing") {
		t.Fatalf("add-on %+v", s.Job)
	}
}

func TestRepairChecksEngineAndModels(t *testing.T) {
	h := newHarness(t)
	h.installCore()
	dir := h.status().InstallDir
	root := filepath.Join(dir, portableDir)
	list, err := os.ReadFile(filepath.Join(dir, engineListName))
	if err != nil || !strings.Contains(string(list), "\tpython_embeded/Lib/site-packages/torch/__init__.py\n") || strings.Contains(string(list), "models/") {
		t.Fatalf("engine list: %v\n%s", err, list)
	}
	man := loadManifest(dir)
	if man.EngineFiles < 5 || man.EngineKey["python_embeded/Lib/site-packages/torch/lib/c10.dll"] == 0 || man.EngineKey["ComfyUI/main.py"] == 0 {
		t.Fatalf("manifest engine info %d %v", man.EngineFiles, man.EngineKey)
	}

	// 1. An antivirus removed a key DLL: noticed by status, fixed by an install.
	os.Remove(filepath.Join(root, "python_embeded", "Lib", "site-packages", "torch", "lib", "c10.dll"))
	if s := h.status(); s.Packs["core"].Installed || s.Engine.State != "not-installed" {
		t.Fatalf("a missing key file must show core as not installed: %+v", s.Engine)
	}
	before := len(h.files.all())
	h.installCore()
	// (7zr.exe is kept after unpacking, so only the engine archive is fetched.)
	if got := h.files.all()[before:]; len(got) != 1 || !strings.HasPrefix(got[0], "portable.7z") {
		t.Fatalf("engine should be fetched again: %q", got)
	}
	if !fileExists(filepath.Join(root, "python_embeded", "Lib", "site-packages", "torch", "lib", "c10.dll")) {
		t.Fatal("not unpacked again")
	}

	// 2. Another engine file is gone (not a key file): only the repair's full
	// check finds it, and unpacks the engine again. The models stay.
	gone := filepath.Join(root, "python_embeded", "Lib", "site-packages", "torch", "__init__.py")
	os.Remove(gone)
	if !h.status().Packs["core"].Installed {
		t.Fatal("status only checks key files")
	}
	h.do("POST", "/__glow/engine/start", nil)
	h.waitEngine("ready")
	// A video is being made: no repair now (it would stop ComfyUI mid-render).
	h.do("POST", "/__glow/comfy/mock/busy?on=1", nil)
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}, "repair": true}); code != 409 || !strings.Contains(fmt.Sprint(out["error"]), "video is being made") {
		t.Fatalf("repair during a render %d %v", code, out)
	}
	h.do("POST", "/__glow/comfy/mock/busy?on=0", nil)
	// Right after a video (a prompt was just posted) the repair is fine.
	h.do("POST", "/__glow/comfy/prompt", map[string]any{"prompt": map[string]any{}, "client_id": "x"})
	before = len(h.files.all())
	if code, out := h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}, "repair": true}); code != 202 {
		t.Fatalf("repair %d %v", code, out)
	}
	if st := h.status().Engine.State; st == "ready" || st == "starting" {
		t.Fatalf("repair must stop the engine first: %s", st)
	}
	s := h.waitJob("done", "error")
	if s.Job.State != "done" || !s.Job.Repair || s.Job.Step != "All files are checked and in order." || !fileExists(gone) {
		t.Fatalf("repair %+v", s.Job)
	}
	got := h.files.all()[before:]
	if len(got) != 1 || !strings.HasPrefix(got[0], "portable.7z") {
		t.Fatalf("repair requests %q", got)
	}
	logs := strings.Join(s.Engine.Log, "\n")
	if !strings.Contains(logs, "AI engine files are missing or changed (for example python_embeded/Lib/site-packages/torch/__init__.py)") {
		t.Fatalf("log %s", logs)
	}

	// 3. A model damaged in place (same size): the repair re-hashes it.
	still := filepath.Join(root, "ComfyUI", "models", "diffusion_models", "still.safetensors")
	fh, _ := os.OpenFile(still, os.O_WRONLY, 0)
	fh.WriteAt([]byte("garbage"), 1000)
	fh.Close()
	before = len(h.files.all())
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}, "repair": true})
	s = h.waitJob("done", "error")
	if got := h.files.all()[before:]; s.Job.State != "done" || len(got) != 1 || !strings.HasPrefix(got[0], "still.safetensors") {
		t.Fatalf("re-hash repair %+v %q", s.Job, got)
	}
	if b, _ := os.ReadFile(still); !bytes.Equal(b, h.data["still.safetensors"]) {
		t.Fatal("still not repaired")
	}

	// 4. ComfyUI says a Python module is missing: the next repair unpacks again
	// even though every listed file is there.
	t.Setenv("GLOW_TEST_MOCK_MODE", "fail-module")
	h.do("POST", "/__glow/engine/start", nil)
	s = h.waitEngine("error")
	if s.Engine.Error == nil || !strings.Contains(*s.Engine.Error, "Check & repair files") || !loadManifest(dir).EngineSuspect {
		t.Fatalf("crash %+v", s.Engine)
	}
	t.Setenv("GLOW_TEST_MOCK_MODE", "")
	before = len(h.files.all())
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}, "repair": true})
	s = h.waitJob("done", "error")
	if got := h.files.all()[before:]; s.Job.State != "done" || len(got) != 1 || loadManifest(dir).EngineSuspect {
		t.Fatalf("suspect repair %+v %q", s.Job, got)
	}
	h.do("POST", "/__glow/engine/start", nil)
	h.waitEngine("ready")
}

func TestCrashReasonIsNotLost(t *testing.T) {
	// Lots of output, then the reason on the last line, then exit: the launcher
	// must read the pipe to the end before it explains the crash.
	h := newHarness(t)
	h.installCore()
	t.Setenv("GLOW_TEST_MOCK_MODE", "fail-start-long")
	for i := 0; i < 8; i++ {
		h.do("POST", "/__glow/engine/start", nil)
		s := h.waitEngine("error")
		if s.Engine.Error == nil || !strings.Contains(*s.Engine.Error, "Visual C++") {
			msg := "<nil>"
			if s.Engine.Error != nil {
				msg = *s.Engine.Error
			}
			t.Fatalf("run %d: %s", i, msg)
		}
		if !strings.Contains(strings.Join(s.Engine.Log, "\n"), "c10.dll") {
			t.Fatalf("run %d: last line missing from the log", i)
		}
	}
}

func TestInstallFolderLock(t *testing.T) {
	// Two copies of the launcher (different ports) must not use one folder.
	h := newHarness(t)
	gate := make(chan struct{})
	h.files.gate["still.safetensors"] = gate
	defer close(gate)
	h.do("POST", "/__glow/engine/install", map[string]any{"packs": []string{"core"}})
	waitFor(t, 10*time.Second, func() bool { j := h.status().Job; return j != nil && j.File != nil && *j.File == "still.safetensors" })
	other := newEngine(1)
	defer other.Shutdown()
	other.mu.Lock()
	err := other.lockDirLocked(other.installDir)
	other.mu.Unlock()
	if err == nil || !strings.Contains(userMsg(err), "already running in the background") {
		t.Fatalf("second copy: %v", err)
	}
	h.do("POST", "/__glow/engine/cancel", nil)
	h.e.Shutdown() // the first copy quits: the folder is free
	other.mu.Lock()
	err = other.lockDirLocked(other.installDir)
	other.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
}

func TestStatusDoesNotWaitForNvidiaSmi(t *testing.T) {
	h := newHarness(t)
	t.Setenv("GLOW_NVIDIA_SMI", writeScript(t, h.dir, "slow-smi", "sleep 3; echo 'NVIDIA GeForce RTX 5060 Laptop GPU, 8151, 581.57'"))
	h.start()
	t0 := time.Now()
	s := h.status()
	if d := time.Since(t0); d > 2*time.Second || s.GPU != nil || !s.GPUPending {
		t.Fatalf("first status took %s: gpu %+v pending %v", d, s.GPU, s.GPUPending)
	}
	waitFor(t, 6*time.Second, func() bool { s = h.status(); return s.GPU != nil })
	if s.GPUPending || !s.GPU.DriverOk || !strings.Contains(s.GPU.Name, "Laptop") {
		t.Fatalf("%+v", s.GPU)
	}
	// "Check again" (refresh=1) waits for a fresh answer.
	t.Setenv("GLOW_NVIDIA_SMI", writeScript(t, h.dir, "smi2", "sleep 1; echo 'NVIDIA GeForce RTX 5060, 8151, 590.10'"))
	resp, err := http.Get(h.srv.URL + "/__glow/engine/status?refresh=1")
	if err != nil {
		t.Fatal(err)
	}
	json.NewDecoder(resp.Body).Decode(&s)
	resp.Body.Close()
	if s.GPU == nil || s.GPU.Driver != "590.10" {
		t.Fatalf("refresh %+v", s.GPU)
	}
}

func TestInstanceFile(t *testing.T) {
	t.Setenv("GLOW_ENGINE_DIR", filepath.Join(t.TempDir(), "GlowStudio", "engine"))
	if readInstancePort() != 0 {
		t.Fatal("no file yet")
	}
	writeInstancePort(41234)
	if p := readInstancePort(); p != 41234 || filepath.Base(filepath.Dir(instancePath())) != "GlowStudio" {
		t.Fatalf("%d %s", p, instancePath())
	}
	removeInstancePort(1) // someone else's: kept
	if readInstancePort() != 41234 {
		t.Fatal("removed another instance's file")
	}
	removeInstancePort(41234)
	if readInstancePort() != 0 {
		t.Fatal("not removed")
	}
}

// ---------------------------------------------------------------- security

func TestGuard(t *testing.T) {
	h := newHarness(t)
	ok := [][]string{
		{},
		{"Origin", h.origin, "Sec-Fetch-Site", "same-origin"},
		{"Sec-Fetch-Site", "none"},
		{"Host", strings.Replace(h.origin, "http://127.0.0.1", "localhost", 1)},
	}
	for _, hd := range ok {
		if code, out := h.do("GET", "/__glow/engine/status", nil, hd...); code != 200 {
			t.Errorf("%v should pass: %d %v", hd, code, out)
		}
	}
	bad := [][]string{
		{"Origin", "https://evil.example"},
		{"Origin", "null"},
		{"Origin", "http://127.0.0.1:1"},
		{"Sec-Fetch-Site", "cross-site"},
		{"Sec-Fetch-Site", "same-site"},
		{"Host", "evil.example" + h.origin[strings.LastIndex(h.origin, ":"):]}, // DNS rebinding
	}
	for _, hd := range bad {
		if code, _ := h.do("GET", "/__glow/engine/status", nil, hd...); code != 403 {
			t.Errorf("%v should be 403, got %d", hd, code)
		}
		if code, _ := h.do("GET", "/__glow/comfy/system_stats", nil, hd...); code != 403 {
			t.Errorf("comfy %v should be 403, got %d", hd, code)
		}
	}
	if code, _ := h.do("POST", "/__glow/engine/start", nil, "Sec-Fetch-Site", "none"); code != 403 {
		t.Error("POST with Sec-Fetch-Site none must be rejected")
	}
	if code, _ := h.do("GET", "/__glow/engine/install", nil); code != 405 {
		t.Error("GET install must be 405")
	}
	if code, _ := h.do("GET", "/__glow/engine/nope", nil); code != 404 {
		t.Error("unknown endpoint must be 404")
	}
}

// ---------------------------------------------------------------- ComfyUI process + proxy

func TestComfyLifecycleAndProxy(t *testing.T) {
	h := newHarness(t)
	if code, out := h.do("GET", "/__glow/comfy/system_stats", nil); code != 503 || out["error"] != "engine not ready" {
		t.Fatalf("not ready: %d %v", code, out)
	}
	h.installCore()
	if code, out := h.do("POST", "/__glow/engine/start", nil, "Origin", h.origin); code != 202 {
		t.Fatalf("start %d %v", code, out)
	}
	if st := h.status().Engine.State; st != "starting" && st != "ready" {
		t.Fatalf("state after start: %s", st)
	}
	s := h.waitEngine("ready")
	if s.Engine.ComfyVersion == nil || *s.Engine.ComfyVersion != "0.44.0-mock" || s.Engine.DynamicVRAM == nil || !*s.Engine.DynamicVRAM {
		t.Fatalf("ready %+v", s.Engine)
	}
	logs := strings.Join(s.Engine.Log, "\n")
	if !strings.Contains(logs, "mock comfy listening") || !strings.Contains(logs, "--windows-standalone-build --listen 127.0.0.1 --port") ||
		!strings.Contains(logs, "--disable-auto-launch") || strings.Contains(logs, "enable-cors") || !strings.Contains(logs, "PYTHONIOENCODING=utf-8") {
		t.Fatalf("log %s", logs)
	}
	if strings.Count(logs, "%|") != 1 {
		t.Fatalf("tqdm lines should collapse: %s", logs)
	}

	// HTTP through the proxy: Origin is checked by the launcher, then removed.
	code, out := h.do("POST", "/__glow/comfy/prompt", map[string]any{"prompt": map[string]any{}, "client_id": "c1"},
		"Origin", h.origin, "Sec-Fetch-Site", "same-origin", "Content-Type", "application/json")
	if code != 200 || out["prompt_id"] == nil {
		t.Fatalf("prompt via proxy: %d %v", code, out)
	}
	code, out = h.do("GET", "/__glow/comfy/mock/headers?x=1", nil, "Origin", h.origin)
	if code != 200 || out["origin"] != "" || !strings.HasPrefix(fmt.Sprint(out["host"]), "127.0.0.1:") || out["path"] != "/mock/headers" || out["query"] != "x=1" {
		t.Fatalf("forwarded headers %v", out)
	}
	if code, _ := h.do("GET", "/__glow/comfy/history/abc", nil, "Origin", "https://evil.example"); code != 403 {
		t.Fatal("cross-origin must be rejected by the launcher")
	}

	// WebSocket upgrade through the proxy.
	ws := dialWS(t, h.srv.Listener.Addr().String(), "/__glow/comfy/ws?clientId=c2", h.origin)
	if msg := ws.read(t); !strings.Contains(msg, `"type":"status"`) || !strings.Contains(msg, `"sid":"c2"`) {
		t.Fatalf("first ws message %s", msg)
	}
	h.do("POST", "/__glow/comfy/prompt", map[string]any{"prompt": map[string]any{}, "client_id": "c2"}, "Origin", h.origin)
	var types []string
	for i := 0; i < 10; i++ {
		var m struct {
			Type string `json:"type"`
			Data struct {
				Node *string `json:"node"`
			} `json:"data"`
		}
		json.Unmarshal([]byte(ws.read(t)), &m)
		types = append(types, m.Type)
		if m.Type == "executing" && m.Data.Node == nil {
			break
		}
	}
	if strings.Join(types, ",") != "execution_start,progress,progress,executed,executing" {
		t.Fatalf("ws events %v", types)
	}
	ws.conn.Close()
	if code := dialWSStatus(t, h.srv.Listener.Addr().String(), "/__glow/comfy/ws?clientId=c3", "https://evil.example"); code != 403 {
		t.Fatalf("cross-origin ws must be 403, got %d", code)
	}

	// Idle exit is blocked while ComfyUI has prompts running: a prompt that was
	// just posted counts at once, then /queue (polled all the time) decides.
	busyLinger = 300 * time.Millisecond
	defer func() { busyLinger = 20 * time.Second }()
	if !h.e.Busy() {
		t.Fatal("a prompt was just posted: busy")
	}
	waitFor(t, 3*time.Second, func() bool { return !h.e.Busy() })
	h.do("POST", "/__glow/comfy/mock/busy?on=1", nil)
	waitFor(t, 3*time.Second, func() bool { return h.e.Busy() })
	// ComfyUI is loading weights and /queue answers too slowly: still busy.
	h.do("POST", "/__glow/comfy/mock/slowqueue?ms=8000", nil)
	time.Sleep(4 * time.Second) // > the 3 s /queue timeout and the linger
	if !h.e.Busy() {
		t.Fatal("a render with a slow /queue must keep the launcher alive")
	}
	h.do("POST", "/__glow/comfy/mock/slowqueue?ms=0", nil)
	h.do("POST", "/__glow/comfy/mock/busy?on=0", nil)
	waitFor(t, 15*time.Second, func() bool { return !h.e.Busy() })

	// Crash: state error with advice and the last log lines.
	h.do("POST", "/__glow/comfy/mock/crash", nil)
	s = h.waitEngine("error")
	if s.Engine.Error == nil || !strings.Contains(*s.Engine.Error, "ran out of memory") || !strings.Contains(strings.Join(s.Engine.Log, "\n"), "OutOfMemoryError") {
		t.Fatalf("crash %+v", s.Engine)
	}
	if code, _ := h.do("GET", "/__glow/comfy/system_stats", nil); code != 503 {
		t.Fatal("proxy must be 503 after a crash")
	}

	// Start again, then stop: the process is gone.
	h.do("POST", "/__glow/engine/start", nil)
	h.waitEngine("ready")
	h.e.mu.Lock()
	port := h.e.comfyPort
	h.e.mu.Unlock()
	if code, _ := h.do("POST", "/__glow/engine/stop", nil); code != 200 {
		t.Fatal("stop")
	}
	if s := h.status(); s.Engine.State != "stopped" || s.Engine.Error != nil {
		t.Fatalf("after stop %+v", s.Engine)
	}
	if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second); err == nil {
		c.Close()
		t.Fatal("ComfyUI still listening after stop")
	}

	// Shutdown (idle exit / fatal error) kills it too.
	h.do("POST", "/__glow/engine/start", nil)
	h.waitEngine("ready")
	h.e.mu.Lock()
	port = h.e.comfyPort
	h.e.mu.Unlock()
	h.e.Shutdown()
	if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second); err == nil {
		c.Close()
		t.Fatal("ComfyUI still listening after Shutdown")
	}
}

func TestComfyStartFailure(t *testing.T) {
	h := newHarness(t)
	h.installCore()
	t.Setenv("GLOW_TEST_MOCK_MODE", "fail-start")
	h.do("POST", "/__glow/engine/start", nil)
	s := h.waitEngine("error")
	if s.Engine.Error == nil || !strings.Contains(*s.Engine.Error, "Visual C++") {
		t.Fatalf("%+v", s.Engine)
	}
}

// ---------------------------------------------------------------- tiny WebSocket client

type wsConn struct {
	conn net.Conn
	br   *bufio.Reader
}

func wsHandshake(t *testing.T, addr, path, origin string) (net.Conn, *bufio.Reader, int) {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(randBytes(16, ""))
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nOrigin: %s\r\nSec-Fetch-Site: same-origin\r\n\r\n", path, addr, key, origin)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode == 101 {
		h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(h[:]) {
			t.Fatal("bad accept")
		}
	}
	return c, br, resp.StatusCode
}

func dialWS(t *testing.T, addr, path, origin string) *wsConn {
	c, br, code := wsHandshake(t, addr, path, origin)
	if code != 101 {
		t.Fatalf("ws upgrade: %d", code)
	}
	return &wsConn{c, br}
}

func dialWSStatus(t *testing.T, addr, path, origin string) int {
	c, _, code := wsHandshake(t, addr, path, origin)
	c.Close()
	return code
}

func (w *wsConn) read(t *testing.T) string {
	w.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	op, payload, err := readFrame(w.br)
	if err != nil || op != 1 {
		t.Fatalf("ws read: op %d %v", op, err)
	}
	return string(payload)
}

func readFrame(br *bufio.Reader) (byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := int64(hdr[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		io.ReadFull(br, b[:])
		n = int64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		io.ReadFull(br, b[:])
		n = int64(binary.BigEndian.Uint64(b[:]))
	}
	var mask [4]byte
	if hdr[1]&0x80 != 0 {
		io.ReadFull(br, mask[:])
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(br, p); err != nil {
		return 0, nil, err
	}
	if hdr[1]&0x80 != 0 {
		for i := range p {
			p[i] ^= mask[i%4]
		}
	}
	return hdr[0] & 0x0f, p, nil
}

func writeFrame(w io.Writer, op byte, p []byte) error {
	hdr := []byte{0x80 | op}
	switch {
	case len(p) < 126:
		hdr = append(hdr, byte(len(p)))
	case len(p) < 65536:
		hdr = append(hdr, 126, byte(len(p)>>8), byte(len(p)))
	default:
		hdr = append(hdr, 127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(len(p)))
	}
	_, err := w.Write(append(hdr, p...))
	return err
}

// ---------------------------------------------------------------- mock ComfyUI (child process)

// runMockComfy imitates the parts of ComfyUI v0.44.0 the launcher relies on,
// including its origin_only_middleware (403 on Host/Origin mismatch).
func runMockComfy() {
	port := ""
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port = os.Args[i+1]
		}
	}
	fmt.Println("[START] Security scan")
	fmt.Println("args:", strings.Join(os.Args[1:], " "))
	fmt.Println("env PYTHONIOENCODING=" + os.Getenv("PYTHONIOENCODING"))
	switch os.Getenv("GLOW_TEST_MOCK_MODE") {
	case "fail-start":
		fmt.Fprintln(os.Stderr, "OSError: [WinError 126] The specified module could not be found. Error loading \"c10.dll\"")
		os.Exit(1)
	case "fail-start-long":
		// Lots of output, then a traceback whose LAST line is the reason.
		w := bufio.NewWriter(os.Stdout)
		for i := 0; i < 2000; i++ {
			fmt.Fprintf(w, "Import times for module %d: %s\n", i, strings.Repeat("x", 90))
		}
		w.WriteString("Traceback (most recent call last):\n")
		for i := 0; i < 20; i++ {
			fmt.Fprintf(w, "  File \"torch\\__init__.py\", line %d, in <module>\n", i)
		}
		w.WriteString("OSError: [WinError 126] The specified module could not be found. Error loading \"C:\\x\\torch\\lib\\c10.dll\" or one of its dependencies.\n")
		w.Flush()
		os.Exit(1)
	case "fail-module":
		fmt.Fprintln(os.Stderr, "ModuleNotFoundError: No module named 'torch'")
		os.Exit(1)
	}
	fmt.Print("Loading: 10%|#    | 1/10\rLoading: 60%|######   | 6/10\rLoading: 100%|##########| 10/10\n")
	fmt.Println("DynamicVRAM support detected and enabled")
	time.Sleep(300 * time.Millisecond)

	var mu sync.Mutex
	busy := false
	var slow time.Duration
	clients := map[string]net.Conn{}
	mux := http.NewServeMux()
	mux.HandleFunc("/system_stats", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"system":{"os":"nt","comfyui_version":"0.44.0-mock","embedded_python":true},"devices":[{"name":"cuda:0 NVIDIA GeForce RTX 5060 : cudaMallocAsync","vram_total":8500000000}]}`)
	})
	mux.HandleFunc("/mock/slowqueue", func(w http.ResponseWriter, r *http.Request) {
		ms, _ := strconv.Atoi(r.URL.Query().Get("ms"))
		mu.Lock()
		slow = time.Duration(ms) * time.Millisecond
		mu.Unlock()
		fmt.Fprint(w, `{}`)
	})
	mux.HandleFunc("/queue", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		d := slow
		mu.Unlock()
		time.Sleep(d)
		mu.Lock()
		defer mu.Unlock()
		if busy {
			fmt.Fprint(w, `{"queue_running":[[0,"p1",{},{},["14"]]],"queue_pending":[]}`)
		} else {
			fmt.Fprint(w, `{"queue_running":[],"queue_pending":[]}`)
		}
	})
	mux.HandleFunc("/mock/busy", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		busy = r.URL.Query().Get("on") == "1"
		mu.Unlock()
		fmt.Fprint(w, `{}`)
	})
	mux.HandleFunc("/mock/crash", func(w http.ResponseWriter, r *http.Request) {
		fmt.Println("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB")
		fmt.Fprint(w, `{}`)
		go func() { time.Sleep(50 * time.Millisecond); os.Exit(1) }()
	})
	mux.HandleFunc("/mock/headers", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"origin": r.Header.Get("Origin"), "host": r.Host, "path": r.URL.Path, "query": r.URL.RawQuery})
	})
	mux.HandleFunc("/prompt", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ClientID string `json:"client_id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		id := "11111111-2222-3333-4444-555555555555"
		fmt.Fprintf(w, `{"prompt_id":"%s","number":1,"node_errors":{}}`, id)
		mu.Lock()
		c := clients[body.ClientID]
		mu.Unlock()
		if c != nil {
			go func() {
				for _, m := range []string{
					`{"type":"execution_start","data":{"prompt_id":"` + id + `"}}`,
					`{"type":"progress","data":{"value":1,"max":2,"prompt_id":"` + id + `","node":"12"}}`,
					`{"type":"progress","data":{"value":2,"max":2,"prompt_id":"` + id + `","node":"12"}}`,
					`{"type":"executed","data":{"node":"14","output":{"images":[{"filename":"x_still_00001_.png","subfolder":"glow","type":"output"}]},"prompt_id":"` + id + `"}}`,
					`{"type":"executing","data":{"node":null,"prompt_id":"` + id + `"}}`,
				} {
					writeFrame(c, 1, []byte(m))
				}
			}()
		}
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "expected websocket", 400)
			return
		}
		key := r.Header.Get("Sec-WebSocket-Key")
		hj, _ := w.(http.Hijacker)
		conn, rw, err := hj.Hijack()
		if err != nil {
			return
		}
		sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
		rw.Flush()
		id := r.URL.Query().Get("clientId")
		mu.Lock()
		clients[id] = conn
		mu.Unlock()
		writeFrame(conn, 1, []byte(`{"type":"status","data":{"status":{"exec_info":{"queue_remaining":0}},"sid":"`+id+`"}}`))
		go func() {
			defer conn.Close()
			for {
				op, _, err := readFrame(rw.Reader)
				if err != nil || op == 8 {
					return
				}
			}
		}()
	})
	// ComfyUI's origin_only_middleware.
	guarded := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			w.WriteHeader(403)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !strings.HasSuffix(o, "//"+r.Host) {
			fmt.Println("WARNING: request with non matching host and origin", r.Host, "!=", o, ", returning 403")
			w.WriteHeader(403)
			return
		}
		mux.ServeHTTP(w, r)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Println("OSError: [Errno 98] address already in use")
		os.Exit(1)
	}
	fmt.Println("mock comfy listening on", ln.Addr())
	http.Serve(ln, guarded)
}
