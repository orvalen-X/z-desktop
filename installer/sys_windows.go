//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	user32                 = windows.NewLazySystemDLL("user32.dll")
	dwmapi                 = windows.NewLazySystemDLL("dwmapi.dll")
	procSetWindowLongPtrW  = user32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtrW  = user32.NewProc("GetWindowLongPtrW")
	procSetWindowPos       = user32.NewProc("SetWindowPos")
	procGetDpiForWindow    = user32.NewProc("GetDpiForWindow")
	procShowWindow         = user32.NewProc("ShowWindow")
	procReleaseCapture     = user32.NewProc("ReleaseCapture")
	procSendMessageW       = user32.NewProc("SendMessageW")
	procMessageBoxW        = user32.NewProc("MessageBoxW")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procDwmSetWindowAttrib = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	gwlStyle               = ^uintptr(15) // -16
	wsPopup                = 0x80000000
	wsMinimizeBox          = 0x00020000
	wsSysMenu              = 0x00080000
	wsVisible              = 0x10000000
	swpNoZOrder            = 0x0004
	swpFrameChanged        = 0x0020
	swpShowWindow          = 0x0040
	swMinimize             = 6
	wmNcLButtonDown        = 0x00A1
	htCaption              = 2
	dwmwaCornerPref        = 33
	dwmwcpRound            = 2
	smCxScreen, smCyScreen = 0, 1
)

// shapeWindow turns the standard window into sketch 2's window: no system frame (the page draws its own
// minimize and close), rounded corners on Windows 11, the right size for the screen's DPI, centered.
func shapeWindow(hwnd windows.HWND, w, h int) {
	h32 := uintptr(hwnd)
	style := uintptr(wsPopup | wsMinimizeBox | wsSysMenu | wsVisible)
	procSetWindowLongPtrW.Call(h32, gwlStyle, style)
	dpi, _, _ := procGetDpiForWindow.Call(h32)
	if dpi == 0 {
		dpi = 96
	}
	pw, ph := w*int(dpi)/96, h*int(dpi)/96
	sw, _, _ := procGetSystemMetrics.Call(smCxScreen)
	sh, _, _ := procGetSystemMetrics.Call(smCyScreen)
	x, y := (int(sw)-pw)/2, (int(sh)-ph)/2
	procSetWindowPos.Call(h32, 0, uintptr(x), uintptr(y), uintptr(pw), uintptr(ph), swpNoZOrder|swpFrameChanged|swpShowWindow)
	pref := uint32(dwmwcpRound)
	procDwmSetWindowAttrib.Call(h32, dwmwaCornerPref, uintptr(unsafe.Pointer(&pref)), 4)
}

func minimize(hwnd windows.HWND) { procShowWindow.Call(uintptr(hwnd), swMinimize) }

// dragWindow lets the person move the window by its top strip, like a title bar.
func dragWindow(hwnd windows.HWND) {
	procReleaseCapture.Call()
	procSendMessageW.Call(uintptr(hwnd), wmNcLButtonDown, htCaption, 0)
}

// installStarted is true from the moment the full installer runs: from then on Cancel waits.
var installStarted atomic.Bool

type winSys struct {
	onTick func(Progress)
	log    func(format string, args ...any)
}

// RunInstaller runs the full NSIS installer silently (per user, no admin prompt) and waits for it.
// While it runs, the bar eases from 92% toward 99.5%.
func (s *winSys) RunInstaller(ctx context.Context, path string) error {
	installStarted.Store(true)
	defer installStarted.Store(false)
	cmd := exec.Command(path, "/S")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if s.log != nil {
		s.log("starting installer %s", filepath.Base(path))
	}
	if err := cmd.Start(); err != nil {
		if s.log != nil {
			s.log("installer did not start: %v", err)
		}
		return fmt.Errorf("could not start the installer: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	p := shareVerify
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	limit := time.After(10 * time.Minute)
	for {
		select {
		case err := <-done:
			if err != nil {
				if s.log != nil {
					s.log("installer ended: %v", err)
				}
				return fmt.Errorf("installer: %w", err)
			}
			return nil
		case <-tick.C:
			p += (0.995 - p) * 0.05
			if s.onTick != nil {
				s.onTick(Progress{Phase: PhaseInstall, P: p})
			}
		case <-limit:
			_ = cmd.Process.Kill()
			return errors.New("installer took too long")
		}
	}
}

// Hold opens the file for reading and lets others only read it, so from the check until the installer has run
// nobody can write, rename or delete it.
func (s *winSys) Hold(path string) (func(), error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return func() { _ = windows.CloseHandle(h) }, nil
}

// findInstalledZ looks up Z in the current user's installed programs (what the full installer registers) and
// returns the path to Z.exe, or "".
func findInstalledZ() string { exe, _ := findZ(""); return exe }

// installedZVersion is the version of the installed Z (its Uninstall entry's DisplayVersion), or "".
func installedZVersion() string { _, ver := findZ(""); return ver }

// Installed: this version of Z is registered for this user and its Z.exe is there.
func (s *winSys) Installed(version string) bool { exe, _ := findZ(version); return exe != "" }

// findZ returns Z.exe and the version of the installed Z, of the given version ("" = any), or "", "".
// It matches the full installer's Uninstall entry (DisplayName "Z", Publisher Orvalen), then looks for Z.exe in
// the folders that entry and HKCU\Software\<same key> point to.
func findZ(version string) (string, string) {
	const root = `Software\Microsoft\Windows\CurrentVersion\Uninstall`
	k, err := registry.OpenKey(registry.CURRENT_USER, root, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return "", ""
	}
	defer k.Close()
	names, _ := k.ReadSubKeyNames(-1)
	for _, n := range names {
		sk, err := registry.OpenKey(registry.CURRENT_USER, root+`\`+n, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		name, _, _ := sk.GetStringValue("DisplayName")
		pub, _, _ := sk.GetStringValue("Publisher")
		ver, _, _ := sk.GetStringValue("DisplayVersion")
		loc, _, _ := sk.GetStringValue("InstallLocation")
		icon, _, _ := sk.GetStringValue("DisplayIcon")
		uninst, _, _ := sk.GetStringValue("UninstallString")
		sk.Close()
		if name != "Z" || !strings.Contains(pub, "Orvalen") || (version != "" && ver != version) {
			continue
		}
		var swLoc string
		if ak, err := registry.OpenKey(registry.CURRENT_USER, `Software\`+n, registry.QUERY_VALUE); err == nil {
			swLoc, _, _ = ak.GetStringValue("InstallLocation")
			ak.Close()
		}
		for _, d := range zDirCandidates(loc, swLoc, icon, uninst) {
			exe := filepath.Join(d, "Z.exe")
			if st, err := os.Stat(exe); err == nil && !st.IsDir() {
				return exe, ver
			}
		}
	}
	return "", ""
}

func waitForInstalledZ(max time.Duration) string {
	deadline := time.Now().Add(max)
	for {
		if exe := findInstalledZ(); exe != "" || time.Now().After(deadline) {
			return exe
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// launchZ opens Z on its own (it outlives Z Setup) and passes the "start with the computer" checkbox once.
func launchZ(exe string, autostart bool) error {
	arg := "--autostart=off"
	if autostart {
		arg = "--autostart=on"
	}
	cmd := exec.Command(exe, arg)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	return cmd.Start()
}

var (
	zWinMu    sync.Mutex
	zWinExe   string
	zWinFound bool
	zWinCb    = syscall.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		if !windows.IsWindowVisible(hwnd) {
			return 1
		}
		var pid uint32
		if _, err := windows.GetWindowThreadProcessId(hwnd, &pid); err != nil || pid == 0 {
			return 1
		}
		if strings.EqualFold(processImage(pid), zWinExe) {
			zWinFound = true
			return 0 // stop
		}
		return 1
	})
)

// processImage is the full path of a running program, or "".
func processImage(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

// zWindowShown: a visible window of this Z.exe is on the screen.
func zWindowShown(exe string) bool {
	zWinMu.Lock()
	defer zWinMu.Unlock()
	zWinExe, zWinFound = exe, false
	_ = windows.EnumWindows(zWinCb, nil) // returns an error when the callback stops early
	return zWinFound
}

// waitForZWindow waits until Z's own window is on the screen, at most max. Z shows its window once its first
// page is ready (or after 3 seconds), so this is when the person really sees Z.
func waitForZWindow(exe string, max time.Duration) bool {
	deadline := time.Now().Add(max)
	for {
		if zWindowShown(exe) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// noWebView: the window engine (WebView2, part of Windows 11 and updated Windows 10) is missing.
func noWebView(lang string) {
	msg := map[string]string{
		"he": "חסר רכיב של Windows שהתקנת Z צריכה (WebView2). אפשר להוריד את ההתקנה המלאה של Z מ-orvalen-official.com.",
		"ar": "ينقص مكوّن من Windows يحتاجه مثبّت Z ‏(WebView2). يمكنك تنزيل مثبّت Z الكامل من orvalen-official.com.",
		"es": "Falta un componente de Windows que necesita el instalador de Z (WebView2). Descarga el instalador completo de Z en orvalen-official.com.",
		"ru": "Не хватает компонента Windows, нужного установщику Z (WebView2). Скачайте полный установщик Z на orvalen-official.com.",
		"en": "A Windows component Z Setup needs (WebView2) is missing. Download the full Z installer from orvalen-official.com.",
	}[lang]
	t, _ := windows.UTF16PtrFromString("Z")
	m, _ := windows.UTF16PtrFromString(msg)
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x40)
}
