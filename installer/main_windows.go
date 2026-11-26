//go:build windows

package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

//go:embed ui/index.html
var page string

// The window of sketch 2, in CSS pixels; scaled to the screen's DPI.
const winW, winH = 900, 560

type app struct {
	w         webview2.WebView
	hwnd      windows.HWND
	workDir   string
	lang      string
	mu        sync.Mutex
	cancel    context.CancelFunc
	running   bool
	autostart bool
	quitting  bool
}

func main() {
	runtime.LockOSThread()
	a := &app{workDir: filepath.Join(os.TempDir(), "ZSetup")}
	langs, _ := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	a.lang = pickLang(langs)
	_ = os.MkdirAll(a.workDir, 0o700)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		// Keep the browser's own files out of the Downloads folder.
		DataPath: filepath.Join(a.workDir, "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title:  "Z",
			Width:  winW,
			Height: winH,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		noWebView(a.lang)
		return
	}
	a.w = w
	a.hwnd = windows.HWND(uintptr(w.Window()))
	shapeWindow(a.hwnd, winW, winH)

	must(w.Bind("zsStart", a.start))
	must(w.Bind("zsRetry", a.start))
	must(w.Bind("zsRepair", a.start))
	must(w.Bind("zsCancel", a.cancelAndClose))
	must(w.Bind("zsClose", a.close))
	must(w.Bind("zsMin", func() { minimize(a.hwnd) }))
	must(w.Bind("zsDrag", func() { dragWindow(a.hwnd) }))
	must(w.Bind("zsAutostart", func(on bool) { a.mu.Lock(); a.autostart = on; a.mu.Unlock() }))
	must(w.Bind("zsOpen", a.openInstalled))

	installed := findInstalledZ() != ""
	init, _ := json.Marshal(map[string]any{"lang": a.lang, "installed": installed, "autostart": false})
	// zs.init runs once the page is ready; the page then asks to start (or shows "already installed").
	w.Init("window.addEventListener('DOMContentLoaded',()=>zs.init(" + string(init) + "))")
	w.SetHtml(page)
	w.Run()
	w.Destroy()
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func (a *app) eval(js string) {
	a.w.Dispatch(func() { a.w.Eval(js) })
}

func (a *app) progress(p Progress) {
	b, _ := json.Marshal(p)
	a.eval("zs.progress(" + string(b) + ")")
}

// start runs the whole flow in the background; a second call while running does nothing.
func (a *app) start() {
	a.mu.Lock()
	if a.running {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel, a.running = cancel, true
	a.mu.Unlock()

	go func() {
		defer func() {
			a.mu.Lock()
			a.running = false
			a.mu.Unlock()
		}()
		fl := &Flow{
			Client:  NewClient(),
			Latest:  releaseLatest,
			WorkDir: filepath.Join(a.workDir, "dl"),
			Sys:     &winSys{onTick: a.progress, log: a.logf},
			Report:  a.progress,
			Now:     time.Now,
		}
		err := fl.Run(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			a.logf("failed: %v", err)
		}
		var f *Failure
		if errors.As(err, &f) {
			a.eval("zs.fail(" + jsString(f.Kind) + "," + jsString(short(f.Err.Error())) + ")")
			return
		}
		if err != nil {
			a.eval("zs.fail('bad'," + jsString(short(err.Error())) + ")")
			return
		}
		a.finish()
	}()
}

// finish opens Z with the person's "start with the computer" choice and closes Z Setup after the fade.
func (a *app) finish() {
	a.mu.Lock()
	on := a.autostart
	a.mu.Unlock()
	a.eval("zs.ready()")
	exe := waitForInstalledZ(10 * time.Second)
	if exe != "" {
		_ = launchZ(exe, on)
	}
	time.Sleep(2200 * time.Millisecond)
	a.close()
}

func (a *app) openInstalled() {
	if exe := findInstalledZ(); exe != "" {
		_ = launchZ(exe, false)
	}
	a.close()
}

// cancelAndClose stops a download (its partial file is removed) and closes. An install that already started
// is left to finish: stopping it halfway would leave Z broken.
func (a *app) cancelAndClose() {
	a.mu.Lock()
	cancel := a.cancel
	installing := a.running && installStarted.Load()
	a.mu.Unlock()
	if installing {
		return
	}
	if cancel != nil {
		cancel()
	}
	_ = os.RemoveAll(filepath.Join(a.workDir, "dl"))
	a.close()
}

func (a *app) close() {
	a.mu.Lock()
	if a.quitting {
		a.mu.Unlock()
		return
	}
	a.quitting = true
	a.mu.Unlock()
	a.w.Dispatch(func() { a.w.Terminate() })
}

// logf keeps a short record in %TEMP%\ZSetup\setup.log, so a failure on someone's computer can be explained.
func (a *app) logf(format string, args ...any) {
	path := filepath.Join(a.workDir, "setup.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 256<<10 {
		_ = os.Remove(path) // keep it small: only the latest runs matter
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// short keeps the window's detail line to one readable line.
func short(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 140 {
		s = s[:140] + "…"
	}
	return s
}

func jsString(s string) string { b, _ := json.Marshal(s); return string(b) }
