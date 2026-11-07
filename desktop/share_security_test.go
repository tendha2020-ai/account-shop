package main

// Fixes from the security and UX reviews of "Share with friends": the request
// log can't be grown or forged from the friends' page; sessions without a name
// can't take every slot and end with "New link"; name slots are freed; the
// daily limit and Block follow a friend across cookies; "Stop now" tells
// friends' pages before the link closes; the closing state has a deadline.

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLogLinesCantBeForged(t *testing.T) {
	dir := t.TempDir()
	launcherLog.open(filepath.Join(dir, "launcher.log"), logRotateBytes)
	defer launcherLog.close()
	launcherLog.printf("[http] POST %s -> 404", "/__glow/share/x\r\n2026-11-07 03:00:00.000 [share] guest u0123456789ab \"Ana\" blocked by the host")
	launcherLog.line("ok \x1b[31mred\x1b[0m\u2028next\u0085end")
	launcherLog.line(strings.Repeat("x", maxLogMessage+500))
	data, _ := os.ReadFile(filepath.Join(dir, "launcher.log"))
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	for _, l := range lines {
		if strings.HasPrefix(l, "2026-11-07 03:00:00.000") {
			t.Fatalf("a forged line: %q", l)
		}
		if strings.ContainsAny(l, "\x1b\r\u2028\u0085") {
			t.Fatalf("control characters left: %q", l)
		}
	}
	if !strings.HasPrefix(lines[1], "    2026-11-07 03:00:00.000 [share]") {
		t.Errorf("continuation not indented: %q", lines[1])
	}
	if last := lines[len(lines)-1]; len(last) > maxLogMessage+200 || !strings.Contains(last, "500 more bytes not logged") {
		t.Errorf("long line not cut (%d bytes)", len(last))
	}
}

func TestRequestSummaryIsBounded(t *testing.T) {
	dir := t.TempDir()
	launcherLog.open(filepath.Join(dir, "launcher.log"), logRotateBytes)
	defer launcherLog.close()
	st := &reqStats{label: "test"}
	h := countRequests(st, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	for i := 0; i < 3000; i++ {
		for _, p := range []string{"/__glow/guest/%d" + strings.Repeat("A", 100), "/__glow/engine/x%d", "/__glow/share/y%d/z", "/__glow/comfy/q%d", "/__glow/guest/jobs/%d/files/a/b"} {
			r, _ := http.NewRequest("GET", "http://x"+fmt.Sprintf(p, i), nil)
			h.ServeHTTP(&discardWriter{h: http.Header{}}, r)
		}
	}
	st.mu.Lock()
	n := len(st.counts)
	st.mu.Unlock()
	if n > 10 {
		t.Fatalf("%d kinds in the summary", n)
	}
	line := st.flush()
	if len(line) > 400 || strings.Contains(line, "AAAA") {
		t.Fatalf("summary %q", line)
	}
	// the map itself is capped too, whatever the groups
	for i := 0; i < 500; i++ {
		st.add(fmt.Sprintf("k%d", i), 200, 0)
	}
	if st.mu.Lock(); len(st.counts) > maxRequestGroups+1 {
		t.Errorf("%d keys", len(st.counts))
	}
	st.mu.Unlock()
	// the host listener's POST line has the kind, never the path
	launcherLog.open(filepath.Join(dir, "launcher2.log"), logRotateBytes)
	hh := countRequests(&reqStats{}, true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	r, _ := http.NewRequest("POST", "http://x/__glow/engine/y%0A2026-11-07%2003:00:01.000%20[launcher]%20exiting:%20idle%20exit%20(FORGED)", nil)
	hh.ServeHTTP(&discardWriter{h: http.Header{}}, r)
	data, _ := os.ReadFile(filepath.Join(dir, "launcher2.log"))
	if strings.Contains(string(data), "FORGED") || !strings.Contains(string(data), "[http] POST /__glow/engine/other -> 404") {
		t.Fatalf("log %q", data)
	}
}

type discardWriter struct {
	h    http.Header
	code int
}

func (d *discardWriter) Header() http.Header         { return d.h }
func (d *discardWriter) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriter) WriteHeader(c int)           { d.code = c }

func TestFriendsPageRequestsDontGrowTheLog(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	guestRequests.flush()
	g := h.newGuest("203.0.113.40")
	for i := 0; i < 200; i++ {
		g.req("GET", fmt.Sprintf("/__glow/guest/%d%s", i, strings.Repeat("A", 2000)), nil, "")
		g.req("POST", fmt.Sprintf("/__glow/share/x%%0D%%0A%d", i), strings.NewReader("{}"), "application/json")
	}
	line := guestRequests.flush()
	if len(line) > 300 || strings.Contains(line, "AAAA") {
		t.Fatalf("summary %q", line)
	}
	// and a stranger hammering made-up paths is slowed down like any other request
	limited := false
	for i := 0; i < 200 && !limited; i++ {
		resp, _ := g.req("GET", "/__glow/guest/nope", nil, "")
		limited = resp.StatusCode == 429
	}
	if !limited {
		t.Error("no rate limit on unknown friend API paths")
	}
}

func TestShareUnnamedSessions(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	// many people open the link without typing a name, from many connections: a real friend still gets in
	var ghosts []*guestClient
	for i := 0; i < 40; i++ {
		g := h.newGuest(fmt.Sprintf("198.51.100.%d", 10+i))
		if resp, m := g.join(h.token()); resp.StatusCode != 200 {
			t.Fatalf("ghost %d: %d %v", i, resp.StatusCode, m)
		}
		ghosts = append(ghosts, g)
	}
	friend := h.joined("RealFriend", "203.0.113.9")
	st := h.status()
	if n := len(st["unnamedGuests"].([]any)); n > maxUnnamedSessions || n == 0 || st["unnamed"].(float64) != float64(n) {
		t.Fatalf("unnamed %v / %v", n, st["unnamed"])
	}
	// the oldest ghosts were ended to make room
	if code, _ := ghosts[0].getJSON("/__glow/guest/session"); code != 401 {
		t.Errorf("oldest ghost still has a session: %d", code)
	}
	// the host sees them with an id and can block one
	u := st["unnamedGuests"].([]any)[0].(map[string]any)
	if code, _ := h.hostDo("POST", "/__glow/share/guests/"+u["id"].(string)+"/block", map[string]any{"blocked": true}); code != 200 {
		t.Fatalf("block unnamed %d", code)
	}
	// per connection: at most maxUnnamedPerIP at once (the oldest of that connection makes room)
	var same []*guestClient
	for i := 0; i < maxUnnamedPerIP+2; i++ {
		g := h.newGuest("192.0.2.77")
		if resp, _ := g.join(h.token()); resp.StatusCode != 200 {
			t.Fatalf("same-connection join %d: %d", i, resp.StatusCode)
		}
		same = append(same, g)
	}
	alive := 0
	for _, g := range same {
		if code, _ := g.getJSON("/__glow/guest/session"); code == 200 {
			alive++
		}
	}
	if alive != maxUnnamedPerIP {
		t.Errorf("%d unnamed sessions from one connection", alive)
	}
	// and new sessions per connection are rate limited
	limited := false
	for i := 0; i < maxJoinsPerIP+2 && !limited; i++ {
		resp, _ := h.newGuest("192.0.2.77").join(h.token())
		limited = resp.StatusCode == 429
	}
	if !limited {
		t.Error("joins from one connection are not limited")
	}
	// New link: everyone without a name is disconnected (an old-link session can't name itself later)
	last := ghosts[len(ghosts)-1]
	if code, _ := last.getJSON("/__glow/guest/session"); code != 200 {
		t.Fatalf("newest ghost lost its session early: %d", code)
	}
	h.hostDo("POST", "/__glow/share/new-link", map[string]any{})
	if code, _ := last.getJSON("/__glow/guest/session"); code != 401 {
		t.Errorf("unnamed session survived New link: %d", code)
	}
	if code, _ := last.postJSON("/__glow/guest/name", map[string]string{"name": "Late Stranger"}); code != 401 {
		t.Errorf("old-link session named itself after New link: %d", code)
	}
	if n := h.status()["unnamed"].(float64); n != 0 {
		t.Errorf("unnamed after New link: %v", n)
	}
	// friends with a name stay
	if code, _ := friend.getJSON("/__glow/guest/session"); code != 200 {
		t.Errorf("named friend lost the session on New link: %d", code)
	}
	// a session without a name ends 10 minutes after joining, however often it asks
	h.s.mu.Lock()
	h.s.unnamedTTL = 300 * time.Millisecond
	h.s.mu.Unlock()
	p := h.newGuest("203.0.113.50")
	p.join(h.token())
	for i := 0; i < 5; i++ {
		time.Sleep(100 * time.Millisecond)
		p.getJSON("/__glow/guest/session")
	}
	if code, _ := p.getJSON("/__glow/guest/session"); code != 401 {
		t.Errorf("polling kept an unnamed session alive: %d", code)
	}
	// one that types its name in time keeps it
	q := h.newGuest("203.0.113.51")
	q.join(h.token())
	if code, _ := q.postJSON("/__glow/guest/name", map[string]string{"name": "Quick"}); code != 200 {
		t.Fatalf("name %d", code)
	}
	time.Sleep(400 * time.Millisecond)
	if code, _ := q.getJSON("/__glow/guest/session"); code != 200 {
		t.Errorf("named session ended with the unnamed limit: %d", code)
	}
}

func TestShareNameSlotsAreFreed(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", map[string]any{"dailyLimit": 1})
	for i := 0; i < maxNamedGuests; i++ {
		g := h.joined(fmt.Sprintf("x%d", i), fmt.Sprintf("198.51.100.%d", 60+i))
		if code, _ := g.postJSON("/__glow/guest/leave", map[string]any{}); code != 200 {
			t.Fatalf("leave %d", code)
		}
	}
	if n := len(h.status()["guests"].([]any)); n != 0 {
		t.Errorf("friends who left are still listed: %d", n)
	}
	real := h.joined("RealFriend", "203.0.113.20")
	if code, _ := real.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 202 {
		t.Fatalf("real friend can't make a video: %d", code)
	}
	// 12 friends here now: the 13th waits; blocking one frees a slot
	var here []*guestClient
	for i := 0; i < maxNamedGuests-1; i++ {
		here = append(here, h.joined(fmt.Sprintf("y%d", i), fmt.Sprintf("198.51.100.%d", 100+i)))
	}
	late := h.newGuest("203.0.113.21")
	late.join(h.token())
	if code, m := late.postJSON("/__glow/guest/name", map[string]string{"name": "Late"}); code != 409 || m["error"] != "full" {
		t.Fatalf("13th friend: %d %v", code, m)
	}
	var id string
	for _, g := range h.status()["guests"].([]any) {
		if g.(map[string]any)["name"] == "y0" {
			id = g.(map[string]any)["id"].(string)
		}
	}
	h.hostDo("POST", "/__glow/share/guests/"+id+"/block", map[string]any{"blocked": true})
	if code, m := late.postJSON("/__glow/guest/name", map[string]string{"name": "Late"}); code != 200 {
		t.Fatalf("after a block: %d %v", code, m)
	}
	_ = here
}

func TestShareSameFriendKeepsTheirLimit(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", map[string]any{"dailyLimit": 1})
	ben := h.joined("Ben", "203.0.113.30")
	_, m := ben.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	id := jobOf(m)["id"].(string)
	h.waitJob(id, "done")
	ben.postJSON("/__glow/guest/jobs/"+id+"/done", map[string]any{})
	if code, m := ben.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 429 {
		t.Fatalf("second video: %d %v", code, m)
	}
	// the same link in a private window (a new cookie), the same name, the same connection: the same limit
	again := h.joined("Ben", "203.0.113.30")
	if code, m := again.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 429 || m["error"] != "daily-limit" {
		t.Fatalf("new cookie, same friend: %d %v", code, m)
	}
	if _, s := again.getJSON("/__glow/guest/session"); s["session"].(map[string]any)["limits"].(map[string]any)["left"] != 0.0 {
		t.Errorf("limits %v", s["session"].(map[string]any)["limits"])
	}
	// another name from the same connection: a person of their own, but one connection makes at most 2x the limit a day
	c := h.joined("Cleo", "203.0.113.30")
	_, m = c.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	if jobOf(m) == nil {
		t.Fatalf("Cleo %v", m)
	}
	h.waitJob(jobOf(m)["id"].(string), "done")
	d := h.joined("Dee", "203.0.113.30")
	if code, m := d.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 429 || m["connection"] != true {
		t.Fatalf("third person on one connection: %d %v", code, m)
	}
	// Ben leaves and comes back from another connection with his name: still his limit
	ben.postJSON("/__glow/guest/leave", map[string]any{})
	again.postJSON("/__glow/guest/leave", map[string]any{})
	back := h.joined("ben", "198.51.100.200")
	if code, m := back.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 429 {
		t.Fatalf("Ben back from another connection: %d %v", code, m)
	}
	// Block: also the connection, for the rest of this sharing period (a new cookie doesn't help); Unblock undoes it
	e := h.joined("Eve", "192.0.2.99")
	var eid string
	for _, g := range h.status()["guests"].([]any) {
		if g.(map[string]any)["name"] == "Eve" {
			eid = g.(map[string]any)["id"].(string)
		}
	}
	h.hostDo("POST", "/__glow/share/guests/"+eid+"/block", map[string]any{"blocked": true})
	if code, m := e.getJSON("/__glow/guest/session"); code != 403 || m["host"].(map[string]any)["name"] != "Ana" {
		t.Errorf("blocked session %d %v", code, m)
	}
	resp, m2 := h.newGuest("192.0.2.99").join(h.token())
	if resp.StatusCode != 403 || m2["error"] != "blocked" {
		t.Errorf("blocked connection joined again: %d %v", resp.StatusCode, m2)
	}
	h.hostDo("POST", "/__glow/share/guests/"+eid+"/block", map[string]any{"blocked": false})
	if code, _ := e.getJSON("/__glow/guest/session"); code != 200 {
		t.Errorf("unblocked session %d", code)
	}
	if resp, _ := h.newGuest("192.0.2.99").join(h.token()); resp.StatusCode != 200 {
		t.Errorf("unblocked connection %d", resp.StatusCode)
	}
	// a blocked friend who comes back with their name on another connection is still blocked
	h.hostDo("POST", "/__glow/share/guests/"+eid+"/block", map[string]any{"blocked": true})
	e2 := h.newGuest("198.51.100.201")
	e2.join(h.token())
	if code, m := e2.postJSON("/__glow/guest/name", map[string]string{"name": "Eve"}); code != 403 || m["error"] != "blocked" {
		t.Errorf("blocked name came back: %d %v", code, m)
	}
}

func TestShareStopNowTellsFriends(t *testing.T) {
	h := newShareHarness(t)
	h.s.stopGrace = 400 * time.Millisecond
	h.start("internet", nil)
	g := h.joined("Quin", "203.0.113.60")
	h.comfy.mu.Lock()
	h.comfy.delay = time.Second
	h.comfy.mu.Unlock()
	_, m := g.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	id := jobOf(m)["id"].(string)
	h.waitJob(id, "running")
	t0 := time.Now()
	if code, st := h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true}); code != 200 || st["state"] != "off" {
		t.Fatalf("stop now %d %v", code, st["state"])
	}
	if time.Since(t0) > 300*time.Millisecond {
		t.Errorf("Stop now took %s", time.Since(t0))
	}
	code, mm := g.getJSON("/__glow/guest/jobs/" + id)
	if code != 410 || mm["error"] != "sharing-stopped" || mm["host"].(map[string]any)["name"] != "Ana" {
		t.Fatalf("friend during the grace: %d %v", code, mm)
	}
	if busy, _ := h.s.BusyReason(); busy {
		t.Error("busy after Stop now")
	}
	waitFor(t, 3*time.Second, func() bool {
		_, err := http.Get(g.base + "/")
		return err != nil
	})
	for _, sub := range []string{"input", "output"} {
		for _, f := range h.comfy.files(sub) {
			if strings.HasPrefix(f, "gq-") || strings.HasPrefix(f, "selfie_gq-") {
				t.Errorf("%s/%s left after stop", sub, f)
			}
		}
	}
	// starting again right after works (a pending close finishes first)
	h.s.stopGrace = 5 * time.Second
	h.start("internet", nil)
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	h.start("internet", nil)
	if st := h.status(); st["state"] != "on" {
		t.Fatalf("restart %v", st["state"])
	}
}

func TestShareClosingDeadline(t *testing.T) {
	h := newShareHarness(t)
	h.s.closeGrace = 2 * time.Second
	h.start("internet", nil)
	d := h.joined("Dan", "203.0.113.70")
	_, md := d.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil)
	h.waitJob(jobOf(md)["id"].(string), "done")
	h.hostDo("POST", "/__glow/share/stop", map[string]any{})
	st := h.status()
	cl := st["closing"].(map[string]any)
	by, err := time.Parse(time.RFC3339, fmt.Sprint(cl["closesBy"]))
	if err != nil || cl["running"] != false || by.Before(time.Now()) || by.After(time.Now().Add(3*time.Second)) {
		t.Fatalf("closing %v", cl)
	}
	if code, m := d.getJSON("/__glow/guest/jobs/" + jobOf(md)["id"].(string)); code != 200 || m["job"].(map[string]any)["sharing"] != "closing" {
		t.Errorf("friend's job during closing: %d %v", code, m)
	}
	waitFor(t, 6*time.Second, func() bool { return h.status()["state"] == "off" })
}

// "Try again" on the host card after the internet link gave up: a new tunnel (and link); not in Wi-Fi mode.
func TestShareRelinkAfterTheLinkFailed(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	h.s.mu.Lock()
	old := h.s.tun.(*fakeTunnel)
	h.s.mu.Unlock()
	old.mu.Lock()
	old.state = "failed"
	old.mu.Unlock()
	if tn := h.status()["tunnel"].(map[string]any); tn["state"] != "failed" {
		t.Fatalf("tunnel %v", tn)
	}
	if code, st := h.hostDo("POST", "/__glow/share/relink", map[string]any{}); code != 200 || st["state"] != "on" {
		t.Fatalf("relink %d %v", code, st)
	}
	waitFor(t, 3*time.Second, func() bool { return h.status()["tunnel"].(map[string]any)["state"] == "ready" })
	h.s.mu.Lock()
	same := h.s.tun == tunnelRunner(old)
	h.s.mu.Unlock()
	if same {
		t.Error("the same tunnel")
	}
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	t.Setenv("GLOW_LAN_IP", "127.0.0.2")
	h.start("wifi", nil)
	if code, m := h.hostDo("POST", "/__glow/share/relink", map[string]any{}); code != 409 || m["error"] != "not-on" {
		t.Errorf("relink in Wi-Fi mode %d %v", code, m)
	}
}

// Blocking someone blocks new joins from their connections, not the friends who are already here on one of them.
func TestShareBlockKeepsOtherFriendsOnTheConnection(t *testing.T) {
	h := newShareHarness(t)
	h.start("internet", nil)
	ben := h.joined("Ben", "203.0.113.80")
	dan := h.joined("Dan", "203.0.113.81")
	dan.hdr["Cf-Connecting-Ip"] = "203.0.113.80" // Dan also came through Ben's connection (the same Wi-Fi)
	dan.getJSON("/__glow/guest/session")
	var id string
	for _, g := range h.status()["guests"].([]any) {
		if g.(map[string]any)["name"] == "Dan" {
			id = g.(map[string]any)["id"].(string)
		}
	}
	h.hostDo("POST", "/__glow/share/guests/"+id+"/block", map[string]any{"blocked": true})
	if code, m := ben.submit(jobReq("party-hall", 5, "music", "beat", "best"), testJPEG(300, 400, ""), nil); code != 202 {
		t.Fatalf("Ben, already here on the blocked connection: %d %v", code, m)
	}
	if resp, m := h.newGuest("203.0.113.80").join(h.token()); resp.StatusCode != 403 || m["error"] != "blocked" {
		t.Errorf("new join from the blocked connection: %d %v", resp.StatusCode, m)
	}
}
