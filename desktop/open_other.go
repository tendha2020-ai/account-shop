//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func openApp(url string) {
	fmt.Println("Glow Studio is running at", url)
	if os.Getenv("GLOW_NO_BROWSER") != "" {
		return
	}
	if runtime.GOOS == "darwin" {
		exec.Command("open", url).Start()
	} else {
		exec.Command("xdg-open", url).Start()
	}
}

func showError(msg string) { fmt.Fprintln(os.Stderr, msg) }

// openFolder is a no-op outside Windows (the folder is shown on the page).
func openFolder(dir string) bool { return false }
