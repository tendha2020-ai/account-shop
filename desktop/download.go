package main

// Resumable, verified downloads.
//
// A file is written to <name>.part (ComfyUI ignores that extension) and its
// sha256 is computed while streaming. Every 64 MB, and whenever a download
// stops, the hash state and offset are saved to <name>.part.state, so a resume
// (HTTP Range) continues hashing without re-reading tens of GB: only the bytes
// written after the last saved state (at most ~64 MB, e.g. after the app was
// killed) are re-read. Without a usable state the whole .part is re-hashed
// once. Only a fully verified file is renamed to its final name.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// userError carries a message written for a non-technical user.
type userError struct {
	msg string
	err error
}

func (e *userError) Error() string { return e.msg }
func (e *userError) Unwrap() error { return e.err }

func friendly(err error, msg string) error { return &userError{msg: msg, err: err} }

type downloader struct {
	client     *http.Client
	rewrite    func(string) string
	stall      time.Duration // abort an attempt when no byte arrives for this long
	backoff    time.Duration // first retry delay, doubled up to maxBackoff
	maxBackoff time.Duration
	maxTries   int // attempts in a row without progress
	stateEvery int64
}

type dlHooks struct {
	onDisk func(n int64)      // bytes of this file now on disk (progress bar)
	onNet  func(n int)        // bytes just received from the network (speed)
	phase  func(phase string) // "download", "check", "retry:<seconds>"
	logf   func(format string, a ...any)
}

func newDownloader() *downloader {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   4,
	}
	d := &downloader{
		client:     &http.Client{Transport: tr},
		rewrite:    urlRewriter(os.Getenv("GLOW_ENGINE_URL_REWRITE")),
		stall:      60 * time.Second,
		backoff:    2 * time.Second,
		maxBackoff: 60 * time.Second,
		maxTries:   8,
		stateEvery: 64 << 20,
	}
	if v, err := strconv.Atoi(os.Getenv("GLOW_DL_STALL_SEC")); err == nil && v > 0 {
		d.stall = time.Duration(v) * time.Second
	}
	if v, err := strconv.Atoi(os.Getenv("GLOW_DL_BACKOFF_MS")); err == nil && v > 0 {
		d.backoff = time.Duration(v) * time.Millisecond
		d.maxBackoff = 8 * d.backoff
	}
	return d
}

// urlRewriter implements GLOW_ENGINE_URL_REWRITE="from=to;from2=to2" (prefix
// replacement), used by tests to send every download to a local mock server.
func urlRewriter(spec string) func(string) string {
	type pair struct{ from, to string }
	var pairs []pair
	for _, p := range strings.Split(spec, ";") {
		if i := strings.Index(p, "="); i > 0 {
			pairs = append(pairs, pair{strings.TrimSpace(p[:i]), strings.TrimSpace(p[i+1:])})
		}
	}
	return func(u string) string {
		for _, p := range pairs {
			if strings.HasPrefix(u, p.from) {
				return p.to + u[len(p.from):]
			}
		}
		return u
	}
}

type partState struct {
	Offset int64  `json:"offset"`
	Hash   []byte `json:"hash"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
}

func saveState(path string, f FileSpec, off int64, h hash.Hash) error {
	b, err := h.(encoding.BinaryMarshaler).MarshalBinary()
	if err != nil {
		return err
	}
	data, _ := json.Marshal(partState{Offset: off, Hash: b, URL: f.URL, Size: f.Size})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadState(path string, f FileSpec) (int64, hash.Hash, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, nil, false
	}
	var st partState
	if json.Unmarshal(data, &st) != nil || st.URL != f.URL || st.Size != f.Size || st.Offset < 0 {
		return 0, nil, false
	}
	h := sha256.New()
	if h.(encoding.BinaryUnmarshaler).UnmarshalBinary(st.Hash) != nil {
		return 0, nil, false
	}
	return st.Offset, h, true
}

// partBytes reports how much of f is already on disk (for progress totals).
func partBytes(dest string) int64 {
	if st, err := os.Stat(dest + ".part"); err == nil {
		return st.Size()
	}
	return 0
}

// hashRange adds bytes [from, from+n) of path to h.
func hashRange(ctx context.Context, path string, from, n int64, h hash.Hash) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	if _, err := in.Seek(from, io.SeekStart); err != nil {
		return err
	}
	return hashReader(ctx, in, n, h, nil)
}

func hashFile(ctx context.Context, path string, limit int64, h hash.Hash, onDisk func(int64)) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	return hashReader(ctx, in, limit, h, onDisk)
}

func hashReader(ctx context.Context, in io.Reader, limit int64, h hash.Hash, onDisk func(int64)) error {
	buf := make([]byte, 4<<20)
	var n int64
	for limit < 0 || n < limit {
		if err := ctx.Err(); err != nil {
			return err
		}
		want := int64(len(buf))
		if limit >= 0 && limit-n < want {
			want = limit - n
		}
		k, err := in.Read(buf[:want])
		if k > 0 {
			h.Write(buf[:k])
			n += int64(k)
			if onDisk != nil {
				onDisk(n)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if limit >= 0 && n != limit {
		return fmt.Errorf("short read: %d of %d bytes", n, limit)
	}
	return nil
}

// verifyExisting checks a complete file that is on disk but not recorded as
// verified (for example after the manifest was deleted).
func verifyExisting(ctx context.Context, f FileSpec, dest string, hk dlHooks) (bool, error) {
	st, err := os.Stat(dest)
	if err != nil {
		return false, nil
	}
	if f.SHA256 == "" || (f.SizeFlexible && st.Size() != f.Size) {
		return sizeAndMagicOK(f, dest, st.Size()), nil
	}
	if st.Size() != f.Size {
		return false, nil
	}
	hk.phase("check")
	h := sha256.New()
	if err := hashFile(ctx, dest, -1, h, hk.onDisk); err != nil {
		return false, err
	}
	return hex.EncodeToString(h.Sum(nil)) == f.SHA256, nil
}

func sizeAndMagicOK(f FileSpec, path string, size int64) bool {
	if f.SizeFlexible {
		if size < f.MinSize || (f.MaxSize > 0 && size > f.MaxSize) {
			return false
		}
	} else if size != f.Size {
		return false
	}
	return magicOK(f, path)
}

func magicOK(f FileSpec, path string) bool {
	if f.Magic == "" {
		return true
	}
	want, err := hex.DecodeString(f.Magic)
	if err != nil {
		return false
	}
	in, err := os.Open(path)
	if err != nil {
		return false
	}
	defer in.Close()
	got := make([]byte, len(want))
	if _, err := io.ReadFull(in, got); err != nil {
		return false
	}
	return string(got) == string(want)
}

type retryable struct{ err error }

func (r *retryable) Error() string { return r.err.Error() }
func (r *retryable) Unwrap() error { return r.err }

// fetch downloads f to dest, resuming and verifying. It returns nil only when
// dest holds the verified file.
func (d *downloader) fetch(ctx context.Context, f FileSpec, dest string, hk dlHooks) error {
	if hk.onDisk == nil {
		hk.onDisk = func(int64) {}
	}
	if hk.onNet == nil {
		hk.onNet = func(int) {}
	}
	if hk.phase == nil {
		hk.phase = func(string) {}
	}
	if hk.logf == nil {
		hk.logf = func(string, ...any) {}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return dirError(err, filepath.Dir(dest))
	}
	part, stPath := dest+".part", dest+".part.state"
	src := d.rewrite(f.URL)

	// Work out where to resume and restore the hash state.
	h := sha256.New()
	var off int64
	if st, err := os.Stat(part); err == nil {
		size := st.Size()
		if !f.SizeFlexible && f.Size > 0 && size > f.Size {
			os.Remove(part)
			os.Remove(stPath)
			size = 0
		}
		if size > 0 {
			if so, sh, ok := loadState(stPath, f); ok && so <= size {
				off, h = so, sh
				if so < size { // bytes written after the last state save
					hk.phase("check")
					if err := hashRange(ctx, part, so, size-so, h); err == nil {
						off = size
						saveState(stPath, f, off, h)
					} else if ctx.Err() != nil {
						return ctx.Err()
					} else {
						_, h, _ = loadState(stPath, f) // back to the saved hash
						if err := os.Truncate(part, so); err != nil {
							return fileError(err, part)
						}
					}
				}
				hk.logf("resuming %s at %s", f.Name, gb(off))
			} else {
				hk.phase("check")
				hk.logf("checking the partly downloaded %s (%s)", f.Name, gb(size))
				h = sha256.New()
				if err := hashFile(ctx, part, size, h, hk.onDisk); err != nil {
					if ctx.Err() != nil {
						return ctx.Err()
					}
					os.Remove(part)
					os.Remove(stPath)
					h, size = sha256.New(), 0
				}
				off = size
				if off > 0 {
					saveState(stPath, f, off, h)
				}
			}
		}
	} else {
		os.Remove(stPath)
	}
	hk.onDisk(off)

	want := f.Size // may be adjusted for SizeFlexible files
	tries, shaFails, sizeFails := 0, 0, 0
	restart := func() {
		os.Remove(part)
		os.Remove(stPath)
		h, off = sha256.New(), 0
		hk.onDisk(0)
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		complete := !f.SizeFlexible && want > 0 && off == want
		var err error
		var progressed bool
		if !complete {
			hk.phase("download")
			var got int64
			got, want, err = d.attempt(ctx, f, src, part, stPath, off, want, h, hk)
			progressed = got > off
			off = got
			if err == nil {
				complete = true
			}
		}
		if complete {
			ok, why := d.finalCheck(f, part, off, want, h)
			if ok {
				if err := os.Rename(part, dest); err != nil {
					return fileError(err, dest)
				}
				os.Remove(stPath)
				return nil
			}
			hk.logf("%s: %s", f.Name, why)
			if strings.HasPrefix(why, "sha256") {
				shaFails++
				if shaFails >= 2 {
					restart()
					return friendly(errors.New(why), fmt.Sprintf("The download of “%s” was damaged twice in a row. Press Resume to try again. If this keeps happening, check your internet connection.", f.Label))
				}
			} else {
				sizeFails++
				if sizeFails >= 3 {
					restart()
					return friendly(errors.New(why), fmt.Sprintf("The download server sent the wrong file for “%s”. Please try again later.", f.Label))
				}
			}
			restart()
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var ue *userError
		if errors.As(err, &ue) {
			return err
		}
		var rt *retryable
		if !errors.As(err, &rt) {
			return err
		}
		if progressed {
			tries = 0
		}
		tries++
		if tries > d.maxTries {
			return friendly(err, "The download keeps stopping because the internet connection is not working. Check your connection, then press Resume. Nothing downloaded so far is lost.")
		}
		wait := d.backoff << (tries - 1)
		if wait > d.maxBackoff || wait <= 0 {
			wait = d.maxBackoff
		}
		var ra *retryAfter
		if errors.As(err, &ra) && ra.d > wait {
			wait = ra.d
			if wait > 2*time.Minute {
				wait = 2 * time.Minute
			}
		}
		hk.logf("%s: %v; trying again in %s", f.Name, err, wait.Round(time.Second))
		hk.phase(fmt.Sprintf("retry:%d", int(wait.Round(time.Second)/time.Second)))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

type retryAfter struct {
	d   time.Duration
	err error
}

func (r *retryAfter) Error() string { return r.err.Error() }
func (r *retryAfter) Unwrap() error { return &retryable{r.err} }

func (d *downloader) finalCheck(f FileSpec, part string, off, want int64, h hash.Hash) (bool, string) {
	st, err := os.Stat(part)
	if err != nil {
		return false, "size: part file missing"
	}
	if st.Size() != off {
		return false, fmt.Sprintf("size: part file has %d bytes, expected %d", st.Size(), off)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if f.SizeFlexible {
		if off == f.Size && f.SHA256 != "" {
			if sum != f.SHA256 {
				return false, "sha256 mismatch: got " + sum
			}
			return true, ""
		}
		if !sizeAndMagicOK(f, part, off) {
			return false, fmt.Sprintf("size: unexpected file (%d bytes)", off)
		}
		return true, ""
	}
	if off != f.Size {
		return false, fmt.Sprintf("size: got %d bytes, expected %d", off, f.Size)
	}
	if f.SHA256 != "" {
		if sum != f.SHA256 {
			return false, "sha256 mismatch: got " + sum
		}
		return true, ""
	}
	if !magicOK(f, part) {
		return false, "size: file does not start with the expected signature"
	}
	return true, ""
}

// attempt performs one HTTP request and appends to part. It returns the new
// offset, the (possibly learnt) total size and nil when the body ended at the
// expected size.
func (d *downloader) attempt(ctx context.Context, f FileSpec, src, part, stPath string, off, want int64, h hash.Hash, hk dlHooks) (int64, int64, error) {
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, http.MethodGet, src, nil)
	if err != nil {
		return off, want, friendly(err, "A download address is not valid: "+src)
	}
	req.Header.Set("User-Agent", "GlowStudio/"+launcherVersion)
	req.Header.Set("Accept-Encoding", "identity")
	if off > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", off))
	}
	resp, err := d.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return off, want, ctx.Err()
		}
		return off, want, &retryable{err}
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusPartialContent:
		start, total, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if !ok || start != off {
			// The server resumed somewhere else: start this file over.
			return d.truncate(part, stPath, h, hk), want, &retryable{fmt.Errorf("server resumed at %d instead of %d", start, off)}
		}
		if total > 0 {
			if f.SizeFlexible {
				want = total
			} else if total != f.Size {
				return off, want, &retryable{fmt.Errorf("server file is %d bytes, expected %d", total, f.Size)}
			}
		}
	case resp.StatusCode == http.StatusOK:
		if off > 0 {
			hk.logf("%s: the server does not support resuming; starting this file again", f.Name)
			off = d.truncate(part, stPath, h, hk)
		}
		if resp.ContentLength > 0 {
			if f.SizeFlexible {
				want = resp.ContentLength
			} else if f.Size > 0 && resp.ContentLength != f.Size {
				return off, want, &retryable{fmt.Errorf("server sent %d bytes, expected %d (captive portal or proxy?)", resp.ContentLength, f.Size)}
			}
		}
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		// We may already have every byte.
		if !f.SizeFlexible && off == f.Size {
			return off, want, nil
		}
		if _, total, ok := parseContentRange(resp.Header.Get("Content-Range")); ok && total == off && f.SizeFlexible {
			return off, total, nil
		}
		return d.truncate(part, stPath, h, hk), want, &retryable{errors.New("range not satisfiable")}
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		err := fmt.Errorf("server answered HTTP %d", resp.StatusCode)
		if s, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil && s > 0 {
			return off, want, &retryAfter{time.Duration(s) * time.Second, err}
		}
		return off, want, &retryable{err}
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone ||
		resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return off, want, friendly(fmt.Errorf("HTTP %d for %s", resp.StatusCode, src),
			fmt.Sprintf("“%s” is not available from the download server right now (error %d). Please try again later.", f.Label, resp.StatusCode))
	default:
		return off, want, &retryable{fmt.Errorf("server answered HTTP %d", resp.StatusCode)}
	}

	out, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return off, want, fileError(err, part)
	}
	if _, err := out.Seek(off, io.SeekStart); err != nil {
		out.Close()
		return off, want, fileError(err, part)
	}
	bw := bufio.NewWriterSize(out, 1<<20)
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	var stalled atomic.Bool
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-actx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, last.Load())) > d.stall {
					stalled.Store(true)
					cancel()
					return
				}
			}
		}
	}()

	savedAt := off
	// finish flushes what was received and records the hash state so that a
	// later resume does not need to re-read the file.
	finish := func(werr error) (int64, int64, error) {
		ferr := bw.Flush()
		if ferr == nil {
			ferr = out.Sync()
		}
		cerr := out.Close()
		if werr == nil && ferr != nil {
			werr = ferr
		}
		if werr == nil && cerr != nil {
			werr = cerr
		}
		if ferr == nil && cerr == nil && off > 0 {
			saveState(stPath, f, off, h)
		} // else: the last saved state (if any) still describes synced bytes
		return off, want, werr
	}

	buf := make([]byte, 1<<20)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			last.Store(time.Now().UnixNano())
			if !f.SizeFlexible && f.Size > 0 && off+int64(n) > f.Size {
				out.Close()
				return d.truncate(part, stPath, h, hk), want, &retryable{errors.New("server sent more data than expected")}
			}
			if _, werr := bw.Write(buf[:n]); werr != nil {
				return finish(fileError(werr, part))
			}
			h.Write(buf[:n])
			off += int64(n)
			hk.onNet(n)
			hk.onDisk(off)
			if off-savedAt >= d.stateEvery {
				if err := bw.Flush(); err != nil {
					return finish(fileError(err, part))
				}
				out.Sync()
				saveState(stPath, f, off, h)
				savedAt = off
			}
		}
		if rerr == io.EOF {
			if want > 0 && off < want {
				return finish(&retryable{fmt.Errorf("connection closed at %d of %d bytes", off, want)})
			}
			return finish(nil)
		}
		if rerr != nil {
			if ctx.Err() != nil {
				_, _, _ = finish(nil)
				return off, want, ctx.Err()
			}
			if stalled.Load() {
				return finish(&retryable{fmt.Errorf("no data for %s", d.stall)})
			}
			return finish(&retryable{rerr})
		}
	}
}

func (d *downloader) truncate(part, stPath string, h hash.Hash, hk dlHooks) int64 {
	os.Truncate(part, 0)
	os.Remove(stPath)
	h.Reset()
	hk.onDisk(0)
	return 0
}

func parseContentRange(v string) (start, total int64, ok bool) {
	// "bytes 100-999/1000" or "bytes 100-999/*"
	v = strings.TrimSpace(v)
	if !strings.HasPrefix(v, "bytes ") {
		return 0, 0, false
	}
	v = v[len("bytes "):]
	if strings.HasPrefix(v, "*/") { // 416 form: "bytes */1000"
		t, err := strconv.ParseInt(v[2:], 10, 64)
		return -1, t, err == nil
	}
	dash, slash := strings.Index(v, "-"), strings.Index(v, "/")
	if dash < 0 || slash < dash {
		return 0, 0, false
	}
	s, err := strconv.ParseInt(v[:dash], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	t := int64(-1)
	if tv := v[slash+1:]; tv != "*" {
		if t, err = strconv.ParseInt(tv, 10, 64); err != nil {
			return 0, 0, false
		}
	}
	return s, t, true
}

func fileError(err error, path string) error {
	switch {
	case isDiskFull(err):
		return friendly(err, "The drive is full. Free up some space (or choose another folder), then press Resume. Nothing downloaded so far is lost.")
	case isFileBusy(err):
		return friendly(err, "Another program is using one of the AI files. Stop the AI engine (and close other AI programs), then press Resume.")
	case isAccessDenied(err):
		return friendly(err, "Glow Studio is not allowed to write to “"+filepath.Dir(path)+"”. Please choose another folder.")
	case isPathTooLong(err):
		return friendly(err, "The install folder path is too long. Please choose a shorter folder, like D:\\GlowStudio.")
	}
	return friendly(err, "Glow Studio could not save a file ("+err.Error()+"). Press Resume to try again, or choose another folder.")
}

func dirError(err error, dir string) error { return fileError(err, filepath.Join(dir, "x")) }

func gb(n int64) string { return fmt.Sprintf("%.2f GB", float64(n)/1e9) }
