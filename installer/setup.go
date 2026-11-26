// Z Setup: the small branded program people download from the site (approved sketch 2, O 26.11).
//
// It finds the newest Z release on GitHub, downloads the full Windows installer (resuming after a dropped
// connection), checks its SHA-256 against the release's SHA256SUMS.txt, runs it silently (so updates and
// uninstall keep working exactly as today), and opens Z. This file has no Windows code, so the whole flow is
// tested on any system; the window and the system calls live in *_windows.go.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Where releases live. Only these hosts are ever contacted, also after a redirect.
const (
	// The newest release's page. It redirects to /releases/tag/<tag>; both files are then read from that one tag,
	// so a release published in between can never pair one release's checksums with another's installer.
	releaseLatest = "https://github.com/orvalen-X/z-desktop/releases/latest"
	sumsName      = "SHA256SUMS.txt"
)

var allowedHosts = []string{"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}

// The full installer inside the release, e.g. "Z-Setup-0.3.0.exe".
var tagPath = regexp.MustCompile(`/releases/tag/(v\d+\.\d+\.\d+)$`)

var installerName = regexp.MustCompile(`^Z-Setup-(\d+\.\d+\.\d+)\.exe$`)

// Phases the window shows (sketch 2).
const (
	PhaseStart    = "wel"
	PhaseDownload = "dl"
	PhaseVerify   = "vf"
	PhaseInstall  = "in"
	PhaseReady    = "rd"
)

// Progress is what the window needs to draw: the phase, 0..1 overall, and the download numbers.
type Progress struct {
	Phase string  `json:"phase"`
	P     float64 `json:"p"`
	Done  int64   `json:"done"`
	Total int64   `json:"total"`
	Secs  int     `json:"secs"`
}

// Failure kinds the window knows: "off" (no connection, can resume) and "bad" (check failed / install failed).
type Failure struct {
	Kind string
	Err  error
}

func (f *Failure) Error() string { return f.Kind + ": " + f.Err.Error() }

func offline(err error) error { return &Failure{Kind: "off", Err: err} }
func bad(err error) error     { return &Failure{Kind: "bad", Err: err} }

// notInstalled: the file passed the check but the installer did not finish (often a security program holding it).
// The checked file is kept, so trying again does not download it again.
func notInstalled(err error) error { return &Failure{Kind: "inst", Err: err} }

// System is everything that touches the computer, so tests can replace it.
type System interface {
	// RunInstaller runs the full installer silently and waits for it.
	RunInstaller(ctx context.Context, path string) error
	// Installed tells whether this version of Z is now installed for this user.
	Installed(version string) bool
	// Hold keeps the file from being changed (by anyone, even the same user) from before its check until the
	// installer has run. The returned func lets go of it.
	Hold(path string) (func(), error)
}

// The full installer is well under this; anything bigger is not ours.
const maxInstaller = 512 << 20

// Flow holds one run of Z Setup.
type Flow struct {
	Client *http.Client
	Latest string        // the newest release's page; Run reads its tag and sets Base from it
	Base   string        // where the release's files are (set by Run from Latest, or by tests directly)
	Tag    string        // the release tag Run resolved (e.g. "v0.3.0"); "" when Base was set directly
	Stall  time.Duration // a download with no bytes for this long counts as a lost connection (0 = 60s)
	// InstallWait is how long a failed installer start waits for Z to turn up anyway (0 = 30s).
	InstallWait time.Duration
	WorkDir     string // where the download is kept between attempts
	Sys         System
	Report      func(Progress)
	Now         func() time.Time
}

// Share of the bar each phase gets (sketch 2: download to 86%, check to 92%, install to 100%).
const (
	shareDownload = 0.86
	shareVerify   = 0.92
)

// NewClient refuses every redirect that leaves https or the allowed hosts.
func NewClient() *http.Client {
	return &http.Client{
		Timeout: 0, // a large file on a slow line can take long: a stalled one is caught in Download
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			IdleConnTimeout:       30 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 8 {
				return errors.New("too many redirects")
			}
			if !hostAllowed(req.URL) {
				return fmt.Errorf("redirect to %s refused", req.URL.Host)
			}
			return nil
		},
	}
}

func hostAllowed(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.Port() != "" {
		return false
	}
	h := strings.ToLower(u.Hostname())
	for _, a := range allowedHosts {
		if h == a {
			return true
		}
	}
	return false
}

// Release is the installer to fetch and the hash it must have.
type Release struct {
	Version string
	File    string
	SHA256  string
}

// ParseSums finds the Windows installer line in SHA256SUMS.txt ("<hex>  <file>").
func ParseSums(r io.Reader) (Release, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 2 {
			continue
		}
		name := strings.TrimPrefix(f[1], "*")
		m := installerName.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		h := strings.ToLower(f[0])
		if len(h) != 64 {
			return Release{}, fmt.Errorf("bad hash for %s", name)
		}
		if _, err := hex.DecodeString(h); err != nil {
			return Release{}, fmt.Errorf("bad hash for %s", name)
		}
		return Release{Version: m[1], File: name, SHA256: h}, nil
	}
	if err := sc.Err(); err != nil {
		return Release{}, err
	}
	return Release{}, errors.New("no Windows installer in SHA256SUMS.txt")
}

func (fl *Flow) get(ctx context.Context, name string, from int64) (*http.Response, error) {
	u, err := url.Parse(fl.Base + name)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ZSetup")
	if from > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", from))
	}
	return fl.Client.Do(req)
}

// ResolveLatest asks the newest release's page where it points, without following it, and sets Base to that
// release's download folder.
func (fl *Flow) ResolveLatest(ctx context.Context) error {
	if fl.Latest == "" {
		return nil
	}
	page, err := url.Parse(fl.Latest)
	if err != nil {
		return bad(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, page.String(), nil)
	if err != nil {
		return bad(err)
	}
	req.Header.Set("User-Agent", "ZSetup")
	c := *fl.Client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := c.Do(req)
	if err != nil {
		return offline(err)
	}
	res.Body.Close()
	loc, err := res.Location()
	if err != nil || res.StatusCode/100 != 3 {
		return offline(fmt.Errorf("newest release not found: %s", res.Status))
	}
	m := tagPath.FindStringSubmatch(loc.Path)
	// Same repository too: only <this repo>/releases/tag/<tag> is accepted (GitHub may change the letter case).
	if m == nil || loc.Scheme != page.Scheme || loc.Host != page.Host ||
		!strings.EqualFold(loc.Path, strings.TrimSuffix(page.Path, "/latest")+"/tag/"+m[1]) {
		return bad(fmt.Errorf("unexpected release address %s", loc.Redacted()))
	}
	fl.Tag = m[1]
	fl.Base = page.Scheme + "://" + page.Host + strings.TrimSuffix(loc.Path, "/tag/"+m[1]) + "/download/" + m[1] + "/"
	return nil
}

// FindRelease reads SHA256SUMS.txt of the newest release.
func (fl *Flow) FindRelease(ctx context.Context) (Release, error) {
	res, err := fl.get(ctx, sumsName, 0)
	if err != nil {
		return Release{}, offline(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Release{}, offline(fmt.Errorf("%s: %s", sumsName, res.Status))
	}
	rel, err := ParseSums(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return Release{}, bad(err)
	}
	return rel, nil
}

// Download fetches the installer into WorkDir, continuing a partial file from an earlier attempt.
func (fl *Flow) Download(ctx context.Context, rel Release) (string, error) {
	if err := os.MkdirAll(fl.WorkDir, 0o700); err != nil { // on Windows the folder sits in the user's own %TEMP%
		return "", bad(err)
	}
	final := filepath.Join(fl.WorkDir, rel.File)
	part := final + ".part"
	// A finished file from an earlier run that passes the check is used as it is.
	if ok, _ := fileHashIs(final, rel.SHA256); ok {
		return final, nil
	}
	var have int64
	if st, err := os.Stat(part); err == nil {
		have = st.Size()
	}
	// A download that stops sending (no reset, just silence) is ended after a quiet spell: it then counts as a
	// lost connection, keeps what arrived, and the window offers to try again.
	stall := fl.Stall
	if stall <= 0 {
		stall = 60 * time.Second
	}
	dctx, cancel := context.WithCancel(ctx)
	defer cancel()
	quiet := time.AfterFunc(stall, cancel)
	defer quiet.Stop()
	res, err := fl.get(dctx, rel.File, have)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", offline(err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusPartialContent && have > 0:
		// The server must continue exactly where the file stopped.
		if !strings.HasPrefix(res.Header.Get("Content-Range"), fmt.Sprintf("bytes %d-", have)) {
			_ = os.Remove(part)
			return "", offline(errors.New("server did not continue where the download stopped, starting over"))
		}
	case res.StatusCode == http.StatusOK:
		have = 0 // the server sent the whole file: start over
	case res.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		_ = os.Remove(part)
		return "", offline(errors.New("partial file no longer matches, starting over"))
	default:
		return "", offline(fmt.Errorf("%s: %s", rel.File, res.Status))
	}
	total := have + res.ContentLength
	if res.ContentLength < 0 {
		total = 0
	}
	if total > maxInstaller {
		return "", bad(fmt.Errorf("%s is too large", rel.File))
	}
	flags := os.O_CREATE | os.O_WRONLY
	if have > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(part, flags, 0o600)
	if err != nil {
		return "", bad(err)
	}
	done := have
	start, startDone := fl.Now(), done
	buf := make([]byte, 256<<10)
	lastReport := time.Time{}
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			quiet.Reset(stall)
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return "", bad(werr)
			}
			done += int64(n)
			if done > maxInstaller {
				f.Close()
				_ = os.Remove(part)
				return "", bad(fmt.Errorf("%s is too large", rel.File))
			}
			if now := fl.Now(); now.Sub(lastReport) > 120*time.Millisecond {
				lastReport = now
				fl.report(PhaseDownload, done, total, start, startDone)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "", offline(rerr) // what arrived is kept for the next attempt
		}
	}
	if err := f.Close(); err != nil {
		return "", bad(err)
	}
	fl.report(PhaseDownload, done, total, start, startDone)
	if err := os.Rename(part, final); err != nil {
		return "", bad(err)
	}
	return final, nil
}

func (fl *Flow) report(phase string, done, total int64, start time.Time, startDone int64) {
	if fl.Report == nil {
		return
	}
	p := Progress{Phase: phase, Done: done, Total: total}
	if total > 0 {
		p.P = shareDownload * float64(done) / float64(total)
		if el := fl.Now().Sub(start).Seconds(); el > 0.5 && done > startDone {
			rate := float64(done-startDone) / el
			p.Secs = int(float64(total-done)/rate + 0.999)
		}
	}
	fl.Report(p)
}

func fileHashIs(path, want string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	return hex.EncodeToString(h.Sum(nil)) == want, nil
}

// Verify checks the downloaded installer's SHA-256. Run deletes a file that fails: nothing from it runs.
func (fl *Flow) Verify(path string, rel Release) error {
	if fl.Report != nil {
		fl.Report(Progress{Phase: PhaseVerify, P: shareDownload})
	}
	ok, err := fileHashIs(path, rel.SHA256)
	if err != nil {
		return bad(err)
	}
	if !ok {
		return bad(errors.New("SHA-256 does not match the release"))
	}
	if fl.Report != nil {
		fl.Report(Progress{Phase: PhaseVerify, P: shareVerify})
	}
	return nil
}

// Install runs the full installer silently. The bar eases toward the end while it runs.
// Security programs (Avast, AVG and others) can stop the first start of an unsigned installer while they scan it,
// and sometimes start it again themselves once it is cleared. So a failed start is not the end: Z Setup waits a
// little, counts it as done if that version of Z turns up installed, and otherwise tries again.
const installTries = 3

func (fl *Flow) Install(ctx context.Context, path, version string) error {
	if fl.Report != nil {
		fl.Report(Progress{Phase: PhaseInstall, P: shareVerify})
	}
	wait := fl.InstallWait
	if wait <= 0 {
		wait = 30 * time.Second
	}
	// A repair of the version that is already there cannot be told apart that way: then only a clean start counts.
	already := fl.Sys.Installed(version)
	var err error
	for try := 1; try <= installTries; try++ {
		if err = fl.Sys.RunInstaller(ctx, path); err == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if already {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait / 3):
			}
			continue
		}
		if !already && fl.waitInstalled(ctx, version, wait) {
			err = nil
			break
		}
	}
	if err != nil {
		return notInstalled(err)
	}
	if fl.Report != nil {
		fl.Report(Progress{Phase: PhaseReady, P: 1})
	}
	return nil
}

func (fl *Flow) waitInstalled(ctx context.Context, version string, max time.Duration) bool {
	deadline := time.Now().Add(max)
	for {
		if fl.Sys.Installed(version) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(max / 10):
		}
	}
}

// Run is the whole way from nothing to an installed Z.
func (fl *Flow) Run(ctx context.Context) error {
	if fl.Report != nil {
		fl.Report(Progress{Phase: PhaseStart})
	}
	if err := fl.ResolveLatest(ctx); err != nil {
		return err
	}
	rel, err := fl.FindRelease(ctx)
	if err != nil {
		return err
	}
	if fl.Tag != "" && fl.Tag != "v"+rel.Version {
		return bad(fmt.Errorf("release %s lists installer %s", fl.Tag, rel.Version))
	}
	path, err := fl.Download(ctx, rel)
	if err != nil {
		return err
	}
	// From the check until the installer has run, nobody can change the file.
	release, err := fl.Sys.Hold(path)
	if err != nil {
		return bad(err)
	}
	if err := fl.Verify(path, rel); err != nil {
		release()
		_ = os.Remove(path)
		return err
	}
	err = fl.Install(ctx, path, rel.Version)
	release()
	if err == nil {
		_ = os.Remove(path) // done with it; Z updates itself from now on
	}
	return err
}
