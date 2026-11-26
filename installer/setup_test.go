package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeSys struct {
	ran       atomic.Int32
	fail      error
	failTimes int32  // fail only the first n starts (0 = always when fail is set)
	installed string // the version Installed reports
	appears   string // a version that turns up installed only after the first start (a security program's own run)
}

func (s *fakeSys) RunInstaller(ctx context.Context, path string) error {
	n := s.ran.Add(1)
	if s.failTimes > 0 && n > s.failTimes {
		return nil
	}
	return s.fail
}

func (s *fakeSys) Installed(version string) bool {
	if s.appears != "" && s.ran.Load() > 0 {
		return s.appears == version
	}
	return s.installed != "" && s.installed == version
}

func (s *fakeSys) Hold(path string) (func(), error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return func() { f.Close() }, nil
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// server serves SHA256SUMS.txt and the installer; dropAt cuts the first download after that many bytes.
func server(t *testing.T, payload []byte, hash string, dropAt int) (*httptest.Server, *atomic.Int32) {
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  Z-0.3.0-mac-universal.dmg\n%s  Z-Setup-0.3.0.exe\n%s  Z-Web-Setup-0.3.0.exe\n", sum([]byte("x")), hash, sum([]byte("y")))
	})
	mux.HandleFunc("/Z-Setup-0.3.0.exe", func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		from := 0
		if rg := r.Header.Get("Range"); rg != "" {
			from, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(rg, "bytes="), "-"))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, len(payload)-1, len(payload)))
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)-from))
			w.WriteHeader(http.StatusPartialContent)
		} else {
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		}
		body := payload[from:]
		if n == 1 && dropAt > 0 {
			w.Write(body[:dropAt])
			if hj, ok := w.(http.Hijacker); ok {
				c, _, _ := hj.Hijack()
				c.Close()
			}
			return
		}
		w.Write(body)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s, &calls
}

func flow(t *testing.T, base string, sys System) (*Flow, *[]Progress) {
	var got []Progress
	return &Flow{
		Client:  http.DefaultClient,
		Base:    base + "/",
		WorkDir: t.TempDir(),
		Sys:     sys,
		Report:  func(p Progress) { got = append(got, p) },
		Now:     time.Now,
	}, &got
}

func TestParseSumsFindsOnlyTheFullWindowsInstaller(t *testing.T) {
	h := strings.Repeat("ab", 32)
	rel, err := ParseSums(strings.NewReader("zz  Z-Web-Setup-0.3.0.exe\n" + h + "  Z-Setup-0.3.0.exe\n"))
	if err != nil || rel.Version != "0.3.0" || rel.File != "Z-Setup-0.3.0.exe" || rel.SHA256 != h {
		t.Fatalf("got %+v %v", rel, err)
	}
	for _, bad := range []string{"", h + "  Z-Setup-0.3.0.exe.evil\n", h + "  ../Z-Setup-0.3.0.exe\n", "nothex  Z-Setup-1.0.0.exe\n"} {
		if _, err := ParseSums(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestWholeFlowDownloadsChecksInstalls(t *testing.T) {
	payload := []byte(strings.Repeat("Z", 700_000))
	s, _ := server(t, payload, sum(payload), 0)
	sys := &fakeSys{}
	fl, got := flow(t, s.URL, sys)
	if err := fl.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sys.ran.Load() != 1 {
		t.Fatal("installer did not run")
	}
	last := (*got)[len(*got)-1]
	if last.Phase != PhaseReady || last.P != 1 {
		t.Fatalf("last progress %+v", last)
	}
	for i := 1; i < len(*got); i++ {
		if (*got)[i].P < (*got)[i-1].P {
			t.Fatalf("progress went back: %+v then %+v", (*got)[i-1], (*got)[i])
		}
	}
	if _, err := os.Stat(filepath.Join(fl.WorkDir, "Z-Setup-0.3.0.exe")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("installer file left behind after install")
	}
}

func TestDroppedConnectionResumesFromTheLastByte(t *testing.T) {
	payload := []byte(strings.Repeat("0123456789", 100_000))
	s, calls := server(t, payload, sum(payload), 300_000)
	sys := &fakeSys{}
	fl, _ := flow(t, s.URL, sys)
	err := fl.Run(context.Background())
	var f *Failure
	if !errors.As(err, &f) || f.Kind != "off" {
		t.Fatalf("want offline failure, got %v", err)
	}
	st, _ := os.Stat(filepath.Join(fl.WorkDir, "Z-Setup-0.3.0.exe.part"))
	if st == nil || st.Size() == 0 {
		t.Fatal("nothing kept for the next attempt")
	}
	kept := st.Size()
	if err := fl.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || sys.ran.Load() != 1 || kept >= int64(len(payload)) {
		t.Fatalf("calls %d ran %d kept %d", calls.Load(), sys.ran.Load(), kept)
	}
}

func TestWrongHashNeverRuns(t *testing.T) {
	payload := []byte("not the real Z")
	s, _ := server(t, payload, sum([]byte("the real Z")), 0)
	sys := &fakeSys{}
	fl, _ := flow(t, s.URL, sys)
	err := fl.Run(context.Background())
	var f *Failure
	if !errors.As(err, &f) || f.Kind != "bad" {
		t.Fatalf("want check failure, got %v", err)
	}
	if sys.ran.Load() != 0 {
		t.Fatal("a file that failed the check was run")
	}
	if _, err := os.Stat(filepath.Join(fl.WorkDir, "Z-Setup-0.3.0.exe")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed file was kept")
	}
}

func TestInstallerFailureIsReported(t *testing.T) {
	payload := []byte("Z")
	s, _ := server(t, payload, sum(payload), 0)
	sys := &fakeSys{fail: errors.New("exit 2")}
	fl, _ := flow(t, s.URL, sys)
	fl.InstallWait = 50 * time.Millisecond
	var f *Failure
	if err := fl.Run(context.Background()); !errors.As(err, &f) || f.Kind != "inst" || sys.ran.Load() != installTries {
		t.Fatalf("got %v after %d starts", err, sys.ran.Load())
	}
	if _, err := os.Stat(filepath.Join(fl.WorkDir, "Z-Setup-0.3.0.exe")); err != nil {
		t.Fatal("the checked file must be kept for the next try")
	}
}

func TestSecurityProgramHoldsTheFirstStart(t *testing.T) {
	payload := []byte("Z")
	s, _ := server(t, payload, sum(payload), 0)
	sys := &fakeSys{fail: errors.New("blocked"), failTimes: 1}
	fl, _ := flow(t, s.URL, sys)
	fl.InstallWait = 50 * time.Millisecond
	if err := fl.Run(context.Background()); err != nil || sys.ran.Load() != 2 {
		t.Fatalf("got %v after %d starts", err, sys.ran.Load())
	}
}

func TestInstalledByTheSecurityProgramCounts(t *testing.T) {
	payload := []byte("Z")
	s, _ := server(t, payload, sum(payload), 0)
	sys := &fakeSys{fail: errors.New("blocked"), appears: "0.3.0"}
	fl, _ := flow(t, s.URL, sys)
	fl.InstallWait = 50 * time.Millisecond
	if err := fl.Run(context.Background()); err != nil || sys.ran.Load() != 1 {
		t.Fatalf("got %v after %d starts", err, sys.ran.Load())
	}
}

func TestNoServerIsOffline(t *testing.T) {
	fl, _ := flow(t, "http://127.0.0.1:1", &fakeSys{})
	var f *Failure
	if err := fl.Run(context.Background()); !errors.As(err, &f) || f.Kind != "off" {
		t.Fatalf("got %v", err)
	}
}

func TestOnlyGitHubHostsOverHttps(t *testing.T) {
	ok := []string{"https://github.com/x", "https://objects.githubusercontent.com/y", "https://release-assets.githubusercontent.com/z"}
	no := []string{"http://github.com/x", "https://github.com:444/x", "https://evil.com/x", "https://github.com.evil.com/x", "https://raw.githubusercontent.com/x"}
	for _, s := range ok {
		u, _ := url.Parse(s)
		if !hostAllowed(u) {
			t.Fatal("refused", s)
		}
	}
	for _, s := range no {
		u, _ := url.Parse(s)
		if hostAllowed(u) {
			t.Fatal("allowed", s)
		}
	}
	if releaseLatest != "https://github.com/orvalen-X/z-desktop/releases/latest" {
		t.Fatal("release base moved")
	}
}

func TestLanguagePick(t *testing.T) {
	cases := map[string]string{"he-IL": "he", "iw": "he", "ar-SA": "ar", "es-419": "es", "ru-RU": "ru", "en-US": "en", "fr-FR": "en", "": "en"}
	for in, want := range cases {
		if got := pickLang([]string{in}); got != want {
			t.Fatalf("%q -> %q, want %q", in, got, want)
		}
	}
	if got := pickLang([]string{"fr-FR", "he-IL"}); got != "he" {
		t.Fatalf("second choice ignored: %q", got)
	}
}

func TestPartialFromTheWrongPlaceStartsOver(t *testing.T) {
	payload := []byte(strings.Repeat("abc", 1000))
	mux := http.NewServeMux()
	mux.HandleFunc("/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  Z-Setup-0.3.0.exe\n", sum(payload))
	})
	mux.HandleFunc("/Z-Setup-0.3.0.exe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(payload)-1, len(payload)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(payload)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	sys := &fakeSys{}
	fl, _ := flow(t, s.URL, sys)
	part := filepath.Join(fl.WorkDir, "Z-Setup-0.3.0.exe.part")
	if err := os.WriteFile(part, payload[:100], 0o600); err != nil {
		t.Fatal(err)
	}
	var f *Failure
	if err := fl.Run(context.Background()); !errors.As(err, &f) || f.Kind != "off" {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(part); !errors.Is(err, os.ErrNotExist) || sys.ran.Load() != 0 {
		t.Fatal("kept a partial file the server did not continue")
	}
}

func TestBothFilesComeFromTheSameRelease(t *testing.T) {
	payload := []byte("Z")
	mux := http.NewServeMux()
	mux.HandleFunc("/o/z/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://"+r.Host+"/o/z/releases/tag/v0.3.0", http.StatusFound)
	})
	mux.HandleFunc("/o/z/releases/download/v0.3.0/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  Z-Setup-0.3.0.exe\n", sum(payload))
	})
	mux.HandleFunc("/o/z/releases/download/v0.3.0/Z-Setup-0.3.0.exe", func(w http.ResponseWriter, r *http.Request) { w.Write(payload) })
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	sys := &fakeSys{}
	fl, _ := flow(t, "", sys)
	fl.Base, fl.Latest = "", s.URL+"/o/z/releases/latest"
	if err := fl.Run(context.Background()); err != nil || sys.ran.Load() != 1 {
		t.Fatalf("got %v ran %d base %s", err, sys.ran.Load(), fl.Base)
	}
	for _, bad := range []string{"https://evil.com/o/z/releases/tag/v0.3.0", "/o/z/releases/tag/../../x", "/o/z/releases/tag/latest", "/other/z/releases/tag/v0.3.0"} {
		mux := http.NewServeMux()
		mux.HandleFunc("/o/z/releases/latest", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, bad, http.StatusFound) })
		s := httptest.NewServer(mux)
		fl, _ := flow(t, "", &fakeSys{})
		fl.Latest = s.URL + "/o/z/releases/latest"
		if err := fl.ResolveLatest(context.Background()); err == nil {
			t.Fatalf("followed %q to %s", bad, fl.Base)
		}
		s.Close()
	}
}

func TestStalledDownloadCountsAsOffline(t *testing.T) {
	payload := []byte(strings.Repeat("s", 10000))
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	mux := http.NewServeMux()
	mux.HandleFunc("/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  Z-Setup-0.3.0.exe\n", sum(payload))
	})
	mux.HandleFunc("/Z-Setup-0.3.0.exe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		w.Write(payload[:500])
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	fl, _ := flow(t, s.URL, &fakeSys{})
	fl.Stall = 300 * time.Millisecond
	var f *Failure
	if err := fl.Run(context.Background()); !errors.As(err, &f) || f.Kind != "off" {
		t.Fatalf("got %v", err)
	}
	if st, _ := os.Stat(filepath.Join(fl.WorkDir, "Z-Setup-0.3.0.exe.part")); st == nil || st.Size() != 500 {
		t.Fatal("what arrived was not kept")
	}
}

func TestTagAndInstallerVersionMustAgree(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/o/z/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/o/z/releases/tag/v0.4.0", http.StatusFound)
	})
	mux.HandleFunc("/o/z/releases/download/v0.4.0/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  Z-Setup-0.3.0.exe\n", sum([]byte("Z")))
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	sys := &fakeSys{}
	fl, _ := flow(t, "", sys)
	fl.Base, fl.Latest = "", s.URL+"/o/z/releases/latest"
	var f *Failure
	if err := fl.Run(context.Background()); !errors.As(err, &f) || f.Kind != "bad" || sys.ran.Load() != 0 {
		t.Fatalf("got %v", err)
	}
}

func TestRepairOfTheSameVersionNeedsARealStart(t *testing.T) {
	payload := []byte("Z")
	s, _ := server(t, payload, sum(payload), 0)
	sys := &fakeSys{fail: errors.New("blocked"), installed: "0.3.0"}
	fl, _ := flow(t, s.URL, sys)
	fl.InstallWait = 30 * time.Millisecond
	var f *Failure
	if err := fl.Run(context.Background()); !errors.As(err, &f) || f.Kind != "inst" || sys.ran.Load() != installTries {
		t.Fatalf("got %v after %d starts", err, sys.ran.Load())
	}
}

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		have, tag string
		want      bool
	}{
		{"0.3.2", "v0.3.3", true},
		{"0.3.3", "v0.3.3", false},
		{"0.3.10", "v0.3.9", false},
		{"0.9.9", "v1.0.0", true},
		{"1.0.0", "v0.9.9", false},
		{"", "v0.3.3", false},
		{"0.3", "v0.3.3", false},
		{"0.3.2-beta", "v0.3.3", false},
		{"0.3.2", "latest", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.have, c.tag); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.have, c.tag, got, c.want)
		}
	}
}
