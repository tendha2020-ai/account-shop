//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// openApp prefers an Edge or Chrome "app" window (no tabs or address bar),
// falling back to the default browser.
func openApp(url string) {
	var candidates []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		if base := os.Getenv(env); base != "" {
			candidates = append(candidates,
				filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
		}
	}
	for _, exe := range candidates {
		if _, err := os.Stat(exe); err == nil {
			cmd := exec.Command(exe, "--app="+url, "--window-size=1280,860")
			if cmd.Start() == nil {
				return
			}
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func showError(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	text, _ := syscall.UTF16PtrFromString(msg)
	title, _ := syscall.UTF16PtrFromString("Glow Studio")
	box.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
