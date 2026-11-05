package main

// ComfyUI is reachable only through the launcher, under the launcher's own
// origin: /__glow/comfy/<path> -> http://127.0.0.1:<comfyPort>/<path>
// (HTTP and the /ws WebSocket). ComfyUI runs WITHOUT --enable-cors-header so
// its own origin check stays on; the launcher checks the browser's Host,
// Origin and Sec-Fetch-Site itself and strips Origin before forwarding
// (ComfyUI would otherwise answer 403 because Host and Origin ports differ).

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// guard rejects requests that do not come from the launcher's own pages:
//   - Host must be the launcher's loopback address (stops DNS rebinding),
//   - Origin, when sent, must be the launcher's origin,
//   - Sec-Fetch-Site, when sent, must be same-origin ("none" only for GET,
//     e.g. opening a /view link directly).
//
// Requests without Origin and Sec-Fetch-Site (curl, other local programs) are
// allowed: such programs could reach ComfyUI's loopback port directly anyway.
func (e *Engine) guard(w http.ResponseWriter, r *http.Request) bool {
	if !e.allowedHost(r.Host) {
		errJSON(w, http.StatusForbidden, "forbidden")
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		ok := site == "same-origin" || (site == "none" && (r.Method == http.MethodGet || r.Method == http.MethodHead))
		if !ok {
			errJSON(w, http.StatusForbidden, "forbidden")
			return false
		}
	}
	if origin := r.Header.Get("Origin"); origin != "" && !e.allowedOrigin(origin) {
		errJSON(w, http.StatusForbidden, "forbidden")
		return false
	}
	return true
}

func (e *Engine) allowedHost(host string) bool {
	h, port, err := net.SplitHostPort(host)
	if err != nil || port != fmt.Sprint(e.port) {
		return false
	}
	return h == "127.0.0.1" || strings.EqualFold(h, "localhost") || h == "::1"
}

func (e *Engine) allowedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Path != "" || u.User != nil {
		return false
	}
	return e.allowedHost(u.Host)
}

type comfyPortKey struct{}

func (e *Engine) proxyHandler() http.Handler {
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			port := pr.In.Context().Value(comfyPortKey{}).(int)
			pr.Out.URL.Path = "/" + strings.TrimPrefix(pr.In.URL.Path, "/__glow/comfy/")
			if pr.In.URL.RawPath != "" {
				pr.Out.URL.RawPath = "/" + strings.TrimPrefix(pr.In.URL.RawPath, "/__glow/comfy/")
			} else {
				pr.Out.URL.RawPath = ""
			}
			pr.SetURL(&url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", port)})
			// Validated above; ComfyUI 403s a Host/Origin port mismatch.
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Referer")
			pr.Out.Header.Del("Cookie")
		},
		Transport: &http.Transport{
			Proxy:               nil, // never send loopback traffic to a system proxy
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     60 * time.Second,
			DisableCompression:  true,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return // the page went away
			}
			errJSON(w, http.StatusBadGateway, "The AI engine did not answer.")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !e.guard(w, r) {
			return
		}
		e.mu.Lock()
		port, state := e.comfyPort, e.state
		e.mu.Unlock()
		if state != "ready" || port == 0 {
			errJSON(w, http.StatusServiceUnavailable, "engine not ready")
			return
		}
		rp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), comfyPortKey{}, port)))
	})
}
