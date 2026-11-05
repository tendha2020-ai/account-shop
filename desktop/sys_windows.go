//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceExW      = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGlobalMemoryStatusEx     = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetDriveTypeW            = kernel32.NewProc("GetDriveTypeW")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
)

const (
	createNoWindow          = 0x08000000
	processSetQuota         = 0x0100
	processTerminate        = 0x0001
	jobObjectExtendedLimit  = 9
	jobLimitKillOnJobClose  = 0x2000
	driveRemote             = 4
	driveCDROM              = 5
	errorDiskFull           = 112
	errorHandleDiskFull     = 39
	errorSharingViolation   = 32
	errorLockViolation      = 33
	errorAccessDenied       = 5
	errorPathNotFound       = 3
	errorInvalidName        = 123
	errorFilenameExcedRange = 206
)

func defaultEngineDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if d, err := os.UserCacheDir(); err == nil {
			base = d
		} else if h, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(h, "AppData", "Local")
		}
	}
	return filepath.Join(base, "GlowStudio", "engine")
}

func pythonExe(root string) string { return filepath.Join(root, "python_embeded", "python.exe") }

// hideWindow keeps console programs (python, 7zr, nvidia-smi, taskkill) from
// flashing a black window: the launcher itself is a GUI program.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// killJob: every ComfyUI process is put in a Job Object that is killed when the
// launcher's last handle closes, so ComfyUI never outlives the launcher, even
// if the launcher crashes or is ended from Task Manager.
var killJob syscall.Handle

func init() {
	h, _, _ := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return
	}
	type basicLimit struct {
		PerProcessUserTimeLimit int64
		PerJobUserTimeLimit     int64
		LimitFlags              uint32
		MinimumWorkingSetSize   uintptr
		MaximumWorkingSetSize   uintptr
		ActiveProcessLimit      uint32
		Affinity                uintptr
		PriorityClass           uint32
		SchedulingClass         uint32
	}
	type ioCounters struct{ A, B, C, D, E, F uint64 }
	type extendedLimit struct {
		Basic                 basicLimit
		Io                    ioCounters
		ProcessMemoryLimit    uintptr
		JobMemoryLimit        uintptr
		PeakProcessMemoryUsed uintptr
		PeakJobMemoryUsed     uintptr
	}
	var info extendedLimit
	info.Basic.LimitFlags = jobLimitKillOnJobClose
	r, _, _ := procSetInformationJobObject.Call(h, jobObjectExtendedLimit, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if r == 0 {
		syscall.CloseHandle(syscall.Handle(h))
		return
	}
	killJob = syscall.Handle(h)
}

func afterStart(cmd *exec.Cmd) {
	if killJob == 0 || cmd.Process == nil {
		return
	}
	ph, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(cmd.Process.Pid))
	if err != nil {
		return
	}
	procAssignProcessToJobObject.Call(uintptr(killJob), uintptr(ph))
	syscall.CloseHandle(ph)
}

// killTree ends a process and everything it started.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	tk := filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe")
	if _, err := os.Stat(tk); err != nil {
		tk = "taskkill"
	}
	k := exec.Command(tk, "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	hideWindow(k)
	done := make(chan struct{})
	go func() { k.Run(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
	}
	cmd.Process.Kill()
}

func nvidiaSmiCandidates() []string {
	var c []string
	if p, err := exec.LookPath("nvidia-smi.exe"); err == nil {
		c = append(c, p)
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	c = append(c, filepath.Join(root, "System32", "nvidia-smi.exe"), `C:\Windows\System32\nvidia-smi.exe`)
	if pf := os.Getenv("ProgramFiles"); pf != "" {
		c = append(c, filepath.Join(pf, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"))
	}
	return c
}

// diskFree returns the bytes free for this user on the drive holding path
// (the nearest existing parent folder is used if path does not exist yet).
func diskFree(path string) (int64, error) {
	p := existingParent(path)
	ptr, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return 0, err
	}
	var free, total, totalFree uint64
	r, _, e := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&free)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&totalFree)))
	if r == 0 {
		return 0, e
	}
	return int64(free), nil
}

func totalRAM() int64 {
	type memStatusEx struct {
		Length               uint32
		MemoryLoad           uint32
		TotalPhys            uint64
		AvailPhys            uint64
		TotalPageFile        uint64
		AvailPageFile        uint64
		TotalVirtual         uint64
		AvailVirtual         uint64
		AvailExtendedVirtual uint64
	}
	var m memStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	if r == 0 {
		return 0
	}
	return int64(m.TotalPhys)
}

// platformDirCheck rejects network drives and CD drives.
func platformDirCheck(p string) error {
	vol := filepath.VolumeName(p)
	if strings.HasPrefix(vol, `\\`) {
		return errors.New("Please choose a folder on this PC's own drive, not a network folder.")
	}
	if vol == "" {
		return nil
	}
	ptr, err := syscall.UTF16PtrFromString(vol + `\`)
	if err != nil {
		return nil
	}
	t, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(ptr)))
	switch t {
	case driveRemote:
		return fmt.Errorf("Drive %s is a network drive. Please choose a folder on this PC's own drive.", vol)
	case driveCDROM:
		return fmt.Errorf("Drive %s is a CD/DVD drive. Please choose another drive.", vol)
	case 1: // DRIVE_NO_ROOT_DIR
		return fmt.Errorf("Drive %s was not found on this PC.", vol)
	}
	return nil
}

// errLocked: another process holds the lock.
var errLocked = errors.New("locked by another process")

// lockFile opens path with no sharing allowed: a second launcher gets a sharing
// violation until this one exits (or crashes: Windows closes the handle).
func lockFile(path string) (release func(), err error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil,
		syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		var en syscall.Errno
		if errors.As(err, &en) && (en == errorSharingViolation || en == errorLockViolation) {
			return nil, errLocked
		}
		return nil, err
	}
	return func() { syscall.CloseHandle(h) }, nil
}

func isDiskFull(err error) bool {
	var en syscall.Errno
	if errors.As(err, &en) {
		return en == errorDiskFull || en == errorHandleDiskFull
	}
	return false
}

func isFileBusy(err error) bool {
	var en syscall.Errno
	if errors.As(err, &en) {
		return en == errorSharingViolation || en == errorLockViolation
	}
	return false
}

func isAccessDenied(err error) bool {
	var en syscall.Errno
	if errors.As(err, &en) && en == errorAccessDenied {
		return true
	}
	return errors.Is(err, os.ErrPermission)
}

// isTransientFSErr: errors Windows gives while another program (antivirus,
// search indexer, backup) briefly has a file open; worth retrying.
func isTransientFSErr(err error) bool {
	if errors.Is(err, errTransientTest) {
		return true
	}
	var en syscall.Errno
	if errors.As(err, &en) {
		return en == errorAccessDenied || en == errorSharingViolation || en == errorLockViolation
	}
	return false
}

func isPathTooLong(err error) bool {
	var en syscall.Errno
	if errors.As(err, &en) {
		return en == errorFilenameExcedRange
	}
	return false
}
