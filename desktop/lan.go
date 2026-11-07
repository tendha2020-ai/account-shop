package main

// "Same Wi-Fi only" (DESIGN g): the friends' page also listens on this PC's
// private home-network address (RFC 1918: 10/8, 172.16/12, 192.168/16) and
// only there, never on 0.0.0.0 or a public address, and it refuses visitors
// from outside that network. Windows asks once whether Glow Studio may use
// networks (the host page explains: tick Private networks, press Allow).

import (
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
)

type lanAddr struct {
	Name string // interface name ("Wi-Fi")
	IP   net.IP
	Net  *net.IPNet // its subnet: only visitors from here are let in
}

type ifaceAddrs struct {
	Name  string
	Flags net.Flags
	Addrs []*net.IPNet
}

var virtualIfaceRe = regexp.MustCompile(`(?i)vEthernet|Hyper-V|WSL|VirtualBox|VMware|Docker|vbox|Bluetooth|TAP-|Tunnel|ZeroTier|Hamachi|WireGuard|Tailscale|VPN|npcap|Loopback`)
var homeIfaceRe = regexp.MustCompile(`(?i)Wi-?Fi|Wireless|WLAN|Ethernet`)

// lanCandidates: up, not loopback or point-to-point, not virtual/VPN, private IPv4.
func lanCandidates(ifs []ifaceAddrs) []lanAddr {
	var out []lanAddr
	for _, it := range ifs {
		if it.Flags&net.FlagUp == 0 || it.Flags&net.FlagLoopback != 0 || it.Flags&net.FlagPointToPoint != 0 || virtualIfaceRe.MatchString(it.Name) {
			continue
		}
		for _, a := range it.Addrs {
			ip := a.IP.To4()
			if ip == nil || !ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback() {
				continue
			}
			out = append(out, lanAddr{Name: it.Name, IP: ip, Net: &net.IPNet{IP: ip.Mask(a.Mask), Mask: a.Mask}})
		}
	}
	return out
}

// pickLAN prefers the address of the default route, then a Wi-Fi/Ethernet
// adapter, then the first candidate.
func pickLAN(cands []lanAddr, routeIP net.IP) (*lanAddr, bool) {
	for i := range cands {
		if routeIP != nil && cands[i].IP.Equal(routeIP) {
			return &cands[i], true
		}
	}
	for i := range cands {
		if homeIfaceRe.MatchString(cands[i].Name) {
			return &cands[i], true
		}
	}
	if len(cands) > 0 {
		return &cands[0], true
	}
	return nil, false
}

func systemIfaces() []ifaceAddrs {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []ifaceAddrs
	for _, it := range ifs {
		addrs, _ := it.Addrs()
		ia := ifaceAddrs{Name: it.Name, Flags: it.Flags}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				ia.Addrs = append(ia.Addrs, n)
			}
		}
		out = append(out, ia)
	}
	return out
}

// defaultRouteIP: the source address the system would use to reach the
// internet (a UDP "connect" sends no packet; 192.0.2.1 is a documentation address).
func defaultRouteIP() net.IP {
	c, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 9})
	if err != nil {
		return nil
	}
	defer c.Close()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok {
		return a.IP.To4()
	}
	return nil
}

// detectLAN finds the address for "Same Wi-Fi only". GLOW_LAN_IP forces one
// (tests): it must belong to a local interface; loopback is allowed only there.
func detectLAN() (*lanAddr, error) {
	ifs := systemIfaces()
	if forced := os.Getenv("GLOW_LAN_IP"); forced != "" {
		return forcedLAN(forced, ifs)
	}
	if a, ok := pickLAN(lanCandidates(ifs), defaultRouteIP()); ok {
		return a, nil
	}
	return nil, errors.New("no private IPv4 address on this PC")
}

func forcedLAN(forced string, ifs []ifaceAddrs) (*lanAddr, error) {
	ip := net.ParseIP(forced).To4()
	if ip == nil {
		return nil, fmt.Errorf("GLOW_LAN_IP %q is not an IPv4 address", forced)
	}
	if !ip.IsPrivate() && !ip.IsLoopback() {
		return nil, fmt.Errorf("GLOW_LAN_IP %s is not a private address", ip)
	}
	for _, it := range ifs {
		for _, a := range it.Addrs {
			if a.IP.To4() == nil {
				continue
			}
			loop := it.Flags&net.FlagLoopback != 0
			if a.IP.Equal(ip) || (loop && ip.IsLoopback() && a.Contains(ip)) {
				return &lanAddr{Name: it.Name, IP: ip, Net: &net.IPNet{IP: ip.Mask(a.Mask), Mask: a.Mask}}, nil
			}
		}
	}
	return nil, fmt.Errorf("GLOW_LAN_IP %s is not an address of this PC", ip)
}

// lanBindable: the LAN listener only ever binds a private (or, for tests, a
// loopback) IPv4 address, never an unspecified or public one.
func lanBindable(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && !v4.IsUnspecified() && (v4.IsPrivate() || (v4.IsLoopback() && os.Getenv("GLOW_LAN_IP") != ""))
}

// listenGuest opens the friends' listener on 127.0.0.1 and, with lan, on the
// LAN address too: the same port on both, the preferred one, else 47832-47840,
// else a random one.
func listenGuest(preferred int, lan *lanAddr) (ln, lanLn net.Listener, port int, err error) {
	if lan != nil && !lanBindable(lan.IP) {
		return nil, nil, 0, fmt.Errorf("refusing to listen on %s: not a private address", lan.IP)
	}
	try := func(p int) bool {
		l, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err != nil {
			return false
		}
		port = l.Addr().(*net.TCPAddr).Port
		if lan != nil {
			ll, err := net.Listen("tcp4", net.JoinHostPort(lan.IP.String(), strconv.Itoa(port)))
			if err != nil {
				l.Close()
				return false
			}
			lanLn = ll
		}
		ln = l
		return true
	}
	var ports []int
	if preferred > 0 {
		ports = append(ports, preferred)
		if preferred == 47831 {
			for p := 47832; p <= 47840; p++ {
				ports = append(ports, p)
			}
		}
	}
	for _, p := range ports {
		if try(p) {
			return ln, lanLn, port, nil
		}
	}
	for i := 0; i < 5; i++ {
		if try(0) {
			return ln, lanLn, port, nil
		}
	}
	return nil, nil, 0, errors.New("no free port for the friends' page")
}
