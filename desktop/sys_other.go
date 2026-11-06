//go:build !windows

package main

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Non-Windows builds exist for development and tests (the real engine is the
// Windows portable ComfyUI). They follow the same code paths.

func defaultEngineDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		h = os.TempDir()
	}
	return filepath.Join(h, ".glowstudio", "engine")
}

func pythonExe(root string) string { return filepath.Join(root, "python_embeded", "python.exe") }

// hideWindow puts the child in its own process group so killTree can end it
// together with anything it started.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func afterStart(cmd *exec.Cmd) {}

func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	syscall.Kill(-pid, syscall.SIGTERM)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(-pid, 0) != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	syscall.Kill(-pid, syscall.SIGKILL)
	cmd.Process.Kill()
}

func nvidiaSmiCandidates() []string {
	var c []string
	if p, err := exec.LookPath("nvidia-smi"); err == nil {
		c = append(c, p)
	}
	return append(c, "/usr/bin/nvidia-smi")
}

func diskFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(existingParent(path), &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

func totalRAM() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, _ := strconv.ParseInt(fields[1], 10, 64)
			return kb * 1024
		}
	}
	return 0
}

func platformDirCheck(p string) error { return nil }

// errLocked: another process holds the lock.
var errLocked = errors.New("locked by another process")

// lockFile takes an exclusive lock on path (created if needed) that lasts until
// release is called or the process ends.
func lockFile(path string) (release func(), err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errLocked
		}
		return nil, err
	}
	return func() { f.Close() }, nil
}

func isDiskFull(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}

func isFileBusy(err error) bool { return errors.Is(err, syscall.ETXTBSY) }

func isAccessDenied(err error) bool {
	return errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EROFS)
}

func isPathTooLong(err error) bool { return errors.Is(err, syscall.ENAMETOOLONG) }

// isTransientFSErr: other systems do not refuse renames of open files.
func isTransientFSErr(err error) bool { return errors.Is(err, errTransientTest) }

// processName is the program of process pid ("" when unknown; Linux only).
func processName(pid int) string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		return ""
	}
	return strings.SplitN(string(b), "\x00", 2)[0]
}

// stopProcess asks an older launcher to quit (SIGTERM: it stops its engine first).
func stopProcess(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
