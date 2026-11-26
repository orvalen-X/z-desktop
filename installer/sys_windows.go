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
}

// RunInstaller runs the full NSIS installer silently (per user, no admin prompt) and waits for it.
// While it runs, the bar eases from 92% toward 99.5%.
func (s *winSys) RunInstaller(ctx context.Context, path string) error {
	installStarted.Store(true)
	defer installStarted.Store(false)
	cmd := exec.Command(path, "/S")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		return err
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

// findInstalledZ looks up Z in the current user's installed programs (what the full installer registers) and
// returns the path to Z.exe, or "".
func findInstalledZ() string {
	const root = `Software\Microsoft\Windows\CurrentVersion\Uninstall`
	k, err := registry.OpenKey(registry.CURRENT_USER, root, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return ""
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
		loc, _, _ := sk.GetStringValue("InstallLocation")
		sk.Close()
		if name != "Z" || !strings.Contains(pub, "Orvalen") || loc == "" {
			continue
		}
		exe := filepath.Join(loc, "Z.exe")
		if st, err := os.Stat(exe); err == nil && !st.IsDir() {
			return exe
		}
	}
	return ""
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
