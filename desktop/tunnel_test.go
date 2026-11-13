package main

// cloudflared (with a fake: this test binary, GLOW_FAKE_CLOUDFLARED=1) and
// "Same Wi-Fi only". The real cloudflared is never run.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseTunnelHost(t *testing.T) {
	cases := map[string]string{
		"2026-11-06T22:00:00Z INF |  https://bright-river-fancy-unicorn.trycloudflare.com                         |": "bright-river-fancy-unicorn.trycloudflare.com",
		"INF |  \x1b[1mhttps://Calm-Lake-7.TryCloudflare.com\x1b[0m  |":                                              "calm-lake-7.trycloudflare.com",
		"INF Thank you for trying Cloudflare Tunnel. See https://api.trycloudflare.com for terms":                    "",
		"INF https://login.trycloudflare.com/x":                                                                      "",
		"INF https://a-b.trycloudflare.com.evil.example":                                                             "a-b.trycloudflare.com",
		"INF http://plain-http.trycloudflare.com":                                                                    "",
		"INF https://x-y.trycloudflare.community":                                                                    "",
		"nothing here": "",
	}
	for line, want := range cases {
		if got := parseTunnelHost(line); got != want {
			t.Errorf("%q -> %q, want %q", line, got, want)
		}
	}
}

func TestTunnelEnvFiltered(t *testing.T) {
	t.Setenv("TUNNEL_TOKEN", "secret")
	t.Setenv("tunnel_origin_cert", "x")
	t.Setenv("CLOUDFLARED_X", "y")
	t.Setenv("GLOW_KEEP", "1")
	env := strings.Join(tunnelEnv(), "\n")
	if strings.Contains(env, "TUNNEL_TOKEN") || strings.Contains(strings.ToUpper(env), "TUNNEL_ORIGIN_CERT") || strings.Contains(env, "CLOUDFLARED_X") || !strings.Contains(env, "GLOW_KEEP=1") {
		t.Errorf("env %s", env)
	}
}

func realTunnel(tweak func(*cloudflaredTunnel)) func(*Share, int) tunnelRunner {
	return func(s *Share, p int) tunnelRunner {
		t := newCloudflaredTunnel(s, p).(*cloudflaredTunnel)
		t.backoff = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}
		t.urlTimeout, t.readyTimeout = 5*time.Second, 5*time.Second
		if tweak != nil {
			tweak(t)
		}
		return t
	}
}

func useFakeCloudflared(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GLOW_CLOUDFLARED_CMD", exe)
	t.Setenv("GLOW_FAKE_CLOUDFLARED", "1")
	t.Setenv("GLOW_FAKE_CF_COUNTER", filepath.Join(t.TempDir(), "count"))
}

func TestShareInternetLinkWithFakeCloudflared(t *testing.T) {
	logPath := captureLog(t)
	useFakeCloudflared(t)
	t.Setenv("TUNNEL_TOKEN", "must-not-reach-cloudflared")
	t.Setenv("CLOUDFLARED_HOSTNAME", "x")
	proxy := freeTCPPort(t)
	t.Setenv("GLOW_FAKE_CF_PROXY", fmt.Sprintf("127.0.0.1:%d", proxy))
	h := newShareHarness(t)
	h.s.tunnelFactory = realTunnel(nil)
	st := h.start("internet", nil)
	host := "fake-share-test-1.trycloudflare.com"
	if st["link"] != "https://"+host+"/?join="+h.token() {
		t.Fatalf("link %v", st["link"])
	}
	waitFor(t, 5*time.Second, func() bool { return h.status()["linkReady"] == true })
	if tn := h.status()["tunnel"].(map[string]any); tn["state"] != "ready" || tn["restarts"] != 0.0 {
		t.Errorf("tunnel %v", tn)
	}
	// a friend through the "internet": the fake proxies like Cloudflare does
	g := h.newGuest("")
	g.base = fmt.Sprintf("http://127.0.0.1:%d", proxy)
	g.host, g.hdr["X-Forwarded-Proto"] = host, "https"
	resp, body := g.req("GET", "/?join="+h.token(), nil, "")
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("GLOW_GUEST")) {
		t.Fatalf("page through the tunnel %d", resp.StatusCode)
	}
	jr, m := g.join(h.token())
	if jr.StatusCode != 200 || !strings.Contains(jr.Header.Get("Set-Cookie"), "Secure") || m["session"].(map[string]any)["secureContext"] != true {
		t.Fatalf("join through the tunnel %d %v", jr.StatusCode, m)
	}
	if resp, _ := g.req("GET", "/__glow/engine/status", nil, ""); resp.StatusCode != 404 {
		t.Errorf("engine API through the tunnel %d", resp.StatusCode)
	}
	if resp, _ := g.req("GET", "/__glow/comfy/queue", nil, ""); resp.StatusCode != 404 {
		t.Errorf("ComfyUI through the tunnel %d", resp.StatusCode)
	}
	// stop: cloudflared is killed (its proxy stops answering)
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	waitFor(t, 5*time.Second, func() bool {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", proxy), 200*time.Millisecond)
		if err == nil {
			c.Close()
		}
		return err != nil
	})
	logs, _ := os.ReadFile(logPath)
	for _, want := range []string{"[tunnel]", "Your quick Tunnel has been created", "link ready https://" + host + "/ (token not logged)", "joined from 203.0.113.7"} {
		if !strings.Contains(string(logs), want) {
			t.Errorf("log lacks %q", want)
		}
	}
	for _, never := range []string{"ENV-LEAK", "BAD-CONFIG", h.token(), "\x1b["} {
		if strings.Contains(string(logs), never) {
			t.Errorf("log has %q", never)
		}
	}
}

func TestTunnelRestartChangesLink(t *testing.T) {
	useFakeCloudflared(t)
	t.Setenv("GLOW_FAKE_CF_EXIT_AFTER_MS", "400")
	h := newShareHarness(t)
	h.s.tunnelFactory = realTunnel(nil)
	st := h.start("internet", nil)
	first, changed := st["link"].(string), st["linkChangedAt"]
	if !strings.Contains(first, "fake-share-test-1.") {
		t.Fatalf("first link %s", first)
	}
	waitFor(t, 10*time.Second, func() bool {
		l, _ := h.status()["link"].(string)
		return strings.Contains(l, "fake-share-test-2.")
	})
	st = h.status()
	if tn := st["tunnel"].(map[string]any); tn["restarts"] != 1.0 {
		t.Errorf("tunnel %v", tn)
	}
	if st["linkChangedAt"] == changed && changed != nil {
		t.Logf("linkChangedAt %v (same second)", st["linkChangedAt"])
	}
	if st["state"] != "on" {
		t.Errorf("state %v", st["state"])
	}
	// the gate follows the new name; the old one is refused
	g := h.newGuest("")
	g.host = "fake-share-test-1.trycloudflare.com"
	g.hdr["X-Forwarded-Proto"] = "https"
	if resp, _ := g.req("GET", "/", nil, ""); resp.StatusCode != 421 {
		t.Errorf("old tunnel name %d", resp.StatusCode)
	}
	g.host = "fake-share-test-2.trycloudflare.com"
	if resp, _ := g.req("GET", "/", nil, ""); resp.StatusCode != 200 {
		t.Errorf("new tunnel name %d", resp.StatusCode)
	}
}

func TestTunnelFailuresStopStarting(t *testing.T) {
	for _, tc := range []struct {
		name, env, msg string
		tweak          func(*cloudflaredTunnel)
	}{
		{"address mismatch", "GLOW_FAKE_CF_QT_MISMATCH", "stopped working", nil},
		{"no address", "GLOW_FAKE_CF_SILENT", "stopped working", func(c *cloudflaredTunnel) { c.urlTimeout = 300 * time.Millisecond }},
		{"rate limited", "GLOW_FAKE_CF_FAIL", "busy", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			useFakeCloudflared(t)
			t.Setenv(tc.env, "1")
			h := newShareHarness(t)
			h.s.tunnelFactory = realTunnel(func(c *cloudflaredTunnel) {
				c.maxRestarts = 2
				if tc.tweak != nil {
					tc.tweak(c)
				}
			})
			if code, st := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "Ana"}); code != 202 || st["state"] != "starting" {
				t.Fatalf("start %d %v", code, st["state"])
			}
			waitFor(t, 15*time.Second, func() bool { return h.status()["state"] == "off" })
			st := h.status()
			if e, _ := st["lastError"].(string); !strings.Contains(e, tc.msg) {
				t.Errorf("lastError %q", e)
			}
		})
	}
}

// The pinned download: size + sha256 checked before every start, a damaged
// file fetched again once, a wrong file refused, other versions removed.
func TestCloudflaredDownloadAndVerify(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("GLOW_FAKE_CLOUDFLARED", "1")
	t.Setenv("GLOW_FAKE_CF_COUNTER", filepath.Join(t.TempDir(), "count"))
	t.Setenv("GLOW_CLOUDFLARED_CMD", "")
	script := []byte("#!/bin/sh\nexec \"" + exe + "\" \"$@\"\n# stand-in for cloudflared in tests\n")
	files := newMockFiles()
	files.files["cloudflared-test.exe"] = script
	srv := httptest.NewServer(files)
	defer srv.Close()
	t.Setenv("GLOW_ENGINE_URL_REWRITE", "https://example.invalid/="+srv.URL+"/")
	sum := sha256.Sum256(script)
	old, oldAny := cloudflaredFile, cloudflaredAnyOS
	cloudflaredFile = FileSpec{Label: "Secure link tool (test)", Name: "cloudflared-test.exe", URL: "https://example.invalid/cloudflared-test.exe",
		Size: int64(len(script)), SHA256: hex.EncodeToString(sum[:])}
	cloudflaredAnyOS = true
	defer func() { cloudflaredFile, cloudflaredAnyOS = old, oldAny }()

	h := newShareHarness(t)
	h.s.tunnelFactory = realTunnel(nil)
	tools := toolsDir()
	os.MkdirAll(tools, 0o755)
	os.WriteFile(filepath.Join(tools, "cloudflared-2025.1.1.exe"), []byte("old"), 0o755)
	h.start("internet", nil)
	if n := len(files.requests("cloudflared-test.exe")); n != 1 {
		t.Fatalf("%d downloads", n)
	}
	dest := filepath.Join(tools, "cloudflared-test.exe")
	if !fileMatches(dest, cloudflaredFile) {
		t.Fatal("the downloaded file does not match")
	}
	if _, err := os.Stat(filepath.Join(tools, "cloudflared-2025.1.1.exe")); err == nil {
		t.Error("an old version was kept")
	}
	if b, _ := os.ReadFile(filepath.Join(tools, "cloudflared-glow.yml")); string(b) != "no-autoupdate: true\n" {
		t.Errorf("config %q", b)
	}
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	// verified again before every start: unchanged -> no download
	h.start("internet", nil)
	if n := len(files.requests("cloudflared-test.exe")); n != 1 {
		t.Fatalf("%d downloads for an intact file", n)
	}
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	// damaged on disk (antivirus, disk error, tampering): fetched again
	os.WriteFile(dest, append(script[:len(script)-1:len(script)-1], 'X'), 0o755)
	h.start("internet", nil)
	if n := len(files.requests("cloudflared-test.exe")); n != 2 {
		t.Fatalf("%d downloads after damage", n)
	}
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	// the server sends another file: refused, never run
	os.Remove(dest)
	files.mu.Lock()
	files.files["cloudflared-test.exe"] = append([]byte("#!/bin/sh\necho EVIL\n"), make([]byte, len(script)-20)...)
	files.mu.Unlock()
	if code, _ := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "internet", "hostName": "Ana"}); code != 202 {
		t.Fatal("start")
	}
	waitFor(t, 20*time.Second, func() bool { return h.status()["state"] == "off" })
	if e, _ := h.status()["lastError"].(string); e != msgSafety {
		t.Errorf("lastError %q", e)
	}
	if _, err := os.Stat(dest); err == nil {
		t.Error("a file that failed its check was left in place")
	}
}

// ---------------------------------------------------------------- Same Wi-Fi only

func TestLANCandidates(t *testing.T) {
	n := func(cidr string) *net.IPNet {
		ip, nw, _ := net.ParseCIDR(cidr)
		nw.IP = ip
		return nw
	}
	up := net.FlagUp | net.FlagBroadcast
	ifs := []ifaceAddrs{
		{Name: "Loopback Pseudo-Interface 1", Flags: up | net.FlagLoopback, Addrs: []*net.IPNet{n("127.0.0.1/8")}},
		{Name: "vEthernet (WSL)", Flags: up, Addrs: []*net.IPNet{n("172.20.16.1/20")}},
		{Name: "Tailscale", Flags: up, Addrs: []*net.IPNet{n("100.101.1.2/32")}},
		{Name: "Ethernet 2", Flags: 0, Addrs: []*net.IPNet{n("192.168.50.2/24")}},
		{Name: "Public", Flags: up, Addrs: []*net.IPNet{n("203.0.113.5/24")}},
		{Name: "Link", Flags: up, Addrs: []*net.IPNet{n("169.254.3.4/16"), n("fe80::1/64")}},
		{Name: "VPN adapter", Flags: up | net.FlagPointToPoint, Addrs: []*net.IPNet{n("10.8.0.2/24")}},
		{Name: "Wi-Fi", Flags: up, Addrs: []*net.IPNet{n("fd00::5/64"), n("192.168.1.23/24")}},
		{Name: "Ethernet", Flags: up, Addrs: []*net.IPNet{n("10.0.0.7/8")}},
	}
	c := lanCandidates(ifs)
	if len(c) != 2 || c[0].Name != "Wi-Fi" || c[0].IP.String() != "192.168.1.23" || c[0].Net.String() != "192.168.1.0/24" || c[1].IP.String() != "10.0.0.7" {
		t.Fatalf("candidates %+v", c)
	}
	if a, _ := pickLAN(c, net.ParseIP("10.0.0.7")); a.IP.String() != "10.0.0.7" {
		t.Errorf("route preference %v", a.IP)
	}
	if a, _ := pickLAN(c, net.ParseIP("172.20.16.1")); a.Name != "Wi-Fi" {
		t.Errorf("name preference %v", a.Name)
	}
	if _, ok := pickLAN(nil, nil); ok {
		t.Error("no candidates")
	}
	t.Setenv("GLOW_LAN_IP", "")
	for ip, want := range map[string]bool{"0.0.0.0": false, "8.8.8.8": false, "192.168.1.2": true, "10.1.2.3": true, "172.16.0.1": true, "172.32.0.1": false, "127.0.0.1": false, "100.64.0.1": false} {
		if got := lanBindable(net.ParseIP(ip)); got != want {
			t.Errorf("lanBindable(%s) = %v", ip, got)
		}
	}
	if _, _, _, err := listenGuest(0, &lanAddr{IP: net.ParseIP("0.0.0.0"), Net: n("0.0.0.0/0")}); err == nil {
		t.Error("listening on 0.0.0.0 was allowed")
	}
	if _, err := forcedLAN("8.8.8.8", ifs); err == nil {
		t.Error("a public GLOW_LAN_IP was accepted")
	}
	if _, err := forcedLAN("192.168.1.99", ifs); err == nil {
		t.Error("an address of no interface was accepted")
	}
	if a, err := forcedLAN("127.0.0.2", ifs); err != nil || a.Net.String() != "127.0.0.0/8" {
		t.Errorf("loopback test address %v %v", a, err)
	}
}

func TestShareWifiMode(t *testing.T) {
	h := newShareHarness(t)
	t.Setenv("GLOW_LAN_IP", "127.0.0.2")
	st := h.start("wifi", nil)
	lan := st["lan"].(map[string]any)
	port := int(lan["port"].(float64))
	if lan["ip"] != "127.0.0.2" || lan["subnet"] != "127.0.0.0/8" || st["link"] != fmt.Sprintf("http://127.0.0.2:%d/?join=%s", port, h.token()) || st["tunnel"] != nil || st["linkReady"] != true {
		t.Fatalf("status %v", st)
	}
	h.s.mu.Lock()
	lanAddrStr := h.s.lanLn.Addr().String()
	h.s.mu.Unlock()
	if lanAddrStr != fmt.Sprintf("127.0.0.2:%d", port) {
		t.Errorf("LAN listener on %s", lanAddrStr)
	}
	// only that address: another local address on the same port does not answer
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() {
				if c, err := net.DialTimeout("tcp", net.JoinHostPort(n.IP.String(), fmt.Sprint(port)), 300*time.Millisecond); err == nil {
					c.Close()
					t.Errorf("the friends' page answers on %s", n.IP)
				}
			}
		}
	}
	g := h.newGuest("")
	g.base = fmt.Sprintf("http://127.0.0.2:%d", port)
	resp, m := g.join(h.token())
	if resp.StatusCode != 200 || strings.Contains(resp.Header.Get("Set-Cookie"), "Secure") || m["session"].(map[string]any)["secureContext"] != false || m["session"].(map[string]any)["mode"] != "wifi" {
		t.Fatalf("LAN join %d %v %q", resp.StatusCode, m, resp.Header.Get("Set-Cookie"))
	}
	bad := h.newGuest("")
	bad.base, bad.host = g.base, fmt.Sprintf("127.0.0.1:%d", port)
	if resp, _ := bad.req("GET", "/", nil, ""); resp.StatusCode != 421 {
		t.Errorf("LAN listener with a loopback Host %d", resp.StatusCode)
	}
	// visitors from outside the network are refused
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Host, req.RemoteAddr = fmt.Sprintf("127.0.0.2:%d", port), "192.168.7.7:5555"
	h.s.guestHandler("lan").ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Errorf("visitor from another network %d", rec.Code)
	}
	// switching to Anywhere while on: the link changes, the LAN listener closes
	if code, st := h.hostDo("POST", "/__glow/share/settings", map[string]any{"mode": "internet"}); code != 200 || st["mode"] != "internet" {
		t.Fatalf("mode switch %d %v", code, st)
	}
	waitFor(t, 5*time.Second, func() bool {
		l, _ := h.status()["link"].(string)
		return strings.HasPrefix(l, "https://"+fakeTunnelHost)
	})
	if _, err := http.Get(g.base + "/"); err == nil {
		t.Error("the LAN listener still answers after switching to Anywhere")
	}
	h.hostDo("POST", "/__glow/share/stop", map[string]any{"now": true})
	t.Setenv("GLOW_LAN_IP", "8.8.8.8")
	if code, m := h.hostDo("POST", "/__glow/share/start", map[string]any{"mode": "wifi", "hostName": "Ana"}); code != 409 || m["error"] != "no-lan" {
		t.Errorf("no LAN %d %v", code, m)
	}
}
