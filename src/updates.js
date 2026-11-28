'use strict';

// Keeps the app itself up to date. Z inside the window updates from the web on its own; this is only the wrapper.
//
// Where the update comes from: the public Releases page of orvalen-X/z-desktop. A version appears there only
// when Orvalen publishes it (the build makes a draft first), so a draft or a test build never reaches anyone.
//
// How it is installed:
//   Windows and Linux AppImage: downloaded in the background and checked against the SHA-512 in the release.
//     It installs only when the person clicks "Restart now"; with "Later", Z asks again on the next start.
//   At start (O 28.11): Z first asks, in a short check, whether a newer version is ready. If it is, a Z screen offers
//     it ("Update and open" / "Open without updating") before Z loads; see launchCheck/installNow and update.html.
//     No network, a slow answer or no update: Z opens as before. "Open without updating" asks again next start.
//   macOS and Linux DEB: a short notice with a Download button. macOS only installs signed updates, and a DEB
//     is installed by the system's package tool. Both become automatic in the signing layer.

const RELEASES_API = 'https://api.github.com/repos/orvalen-X/z-desktop/releases/latest';
const RELEASES_PAGE = 'https://github.com/orvalen-X/z-desktop/releases/';
const FIRST_CHECK_MS = 30 * 1000;
const LAUNCH_CHECK_MS = 4000;
const EVERY_MS = 6 * 60 * 60 * 1000;

// "1.2.3" or "v1.2.3" -> [1, 2, 3]; anything else (including pre-releases such as 1.2.3-beta) -> null.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// The download link from a release must stay on this repository's Releases page.
function safeReleaseUrl(url) {
  return typeof url === 'string' && url.startsWith(RELEASES_PAGE) && !/[\s"'<>]/.test(url) ? url : RELEASES_PAGE + 'latest';
}

// The release's own text (what O writes on GitHub) as at most 8 short plain lines: only list items ("- ", "* ",
// "1. "), markdown marks and links dropped, control and direction characters removed. Shown with textContent only.
function releaseNotes(body) {
  if (typeof body !== 'string') return [];
  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = /^\s*(?:[-*+]|\d{1,2}[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const line = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~#>]/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140)
      .trim();
    if (line) out.push(line);
    if (out.length === 8) break;
  }
  return out;
}

function updateMode({ platform, isPackaged, appImage }) {
  if (!isPackaged) return 'off';
  if (platform === 'win32') return 'install';
  if (platform === 'linux' && appImage) return 'install';
  return 'notify';
}

function createUpdates({ app, version, platform, env, fetchLatest, openExternal, ask, prefs, savePrefs, strings, log }) {
  const mode = updateMode({ platform, isPackaged: app.isPackaged, appImage: !!env.APPIMAGE });
  let timer = null;
  let updater = null;
  let busy = false;
  let readyVersion = null;
  // "Open without updating" at start: no other offer in this run unless the person asks (menu); next start asks again.
  let deferred = false;
  // "Update and open" pressed before the download finished: install the moment it is ready.
  let installWhenReady = false;
  let onProgress = null;
  let onFail = null;

  function remember(key, v) {
    prefs[key] = v;
    savePrefs();
  }

  // ----- notify mode (macOS, DEB) -----

  async function checkNotify(manual) {
    const rel = await fetchLatest();
    const tag = rel && rel.tag_name;
    if (!rel || rel.draft || rel.prerelease || !isNewer(tag, version)) {
      if (manual) await ask('info', strings().updLatestTitle, strings().updLatestBody, [strings().ok]);
      return;
    }
    const v = parseVersion(tag).join('.');
    if (!manual && prefs.updSkipped === v) return;
    const s = strings();
    const choice = await ask('info', s.updAvailTitle.replace('{v}', v), s.updAvailBody, [s.updDownload, s.updLater]);
    if (choice === 0) openExternal(safeReleaseUrl(rel.html_url));
    else remember('updSkipped', v);
  }

  // ----- install mode (Windows, AppImage) -----

  function getUpdater() {
    if (updater) return updater;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    // Installs only when the person clicks "Restart now". With "Later", the next start asks again.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
    autoUpdater.on('error', (e) => {
      log('update error', e && e.message);
      if (installWhenReady) {
        installWhenReady = false;
        if (onFail) onFail();
      }
    });
    autoUpdater.on('download-progress', (p) => {
      if (onProgress && p && Number.isFinite(p.percent)) onProgress(Math.max(0, Math.min(100, p.percent)));
    });
    autoUpdater.on('update-downloaded', (info) => onDownloaded(info && info.version));
    updater = autoUpdater;
    return updater;
  }

  async function onDownloaded(v, again = false) {
    if (!v) return;
    if (installWhenReady) {
      readyVersion = v;
      if (onProgress) onProgress(100);
      updater.quitAndInstall(true, true);
      return;
    }
    if (readyVersion === v && !again) return;
    readyVersion = v;
    if (deferred && !again) return;
    const s = strings();
    const choice = await ask('info', s.updReadyTitle.replace('{v}', v), s.updReadyBody, [s.updRestart, s.updLater]);
    // Silent install, then Z opens again by itself.
    if (choice === 0) updater.quitAndInstall(true, true);
  }

  async function checkInstall(manual) {
    if (readyVersion) {
      if (manual) await onDownloaded(readyVersion, true);
      return;
    }
    const result = await getUpdater().checkForUpdates();
    const found = result && result.updateInfo && isNewer(result.updateInfo.version, version);
    if (!found && manual) await ask('info', strings().updLatestTitle, strings().updLatestBody, [strings().ok]);
    if (found && manual) await ask('info', strings().updDownloadingTitle, strings().updDownloadingBody, [strings().ok]);
  }

  // ----- at start (install mode only) -----

  // A newer version, found within `ms`, or null (off, offline, slow, none, or any error). The download starts at once
  // (autoDownload); the screen shows its progress only after "Update and open".
  async function launchCheck(ms = LAUNCH_CHECK_MS) {
    if (mode !== 'install' || busy) return null;
    busy = true;
    let timer;
    try {
      const result = await Promise.race([
        getUpdater().checkForUpdates(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
      const v = result && result.updateInfo && result.updateInfo.version;
      if (!v || !isNewer(v, version)) return null;
      return { version: parseVersion(v).join('.') };
    } catch (e) {
      log('launch check failed', e && e.message);
      return null;
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  }

  // "Update and open": installs as soon as the download is ready (now, if it already is). progress(0..100) follows
  // the download; fail() means it could not finish, and Z opens instead (the next start offers it again).
  function installNow({ progress, fail } = {}) {
    if (mode !== 'install') return false;
    onProgress = progress || null;
    onFail = fail || null;
    if (readyVersion) {
      if (onProgress) onProgress(100);
      getUpdater().quitAndInstall(true, true);
      return true;
    }
    installWhenReady = true;
    getUpdater();
    return true;
  }

  // ----- schedule -----

  async function check(manual = false) {
    if (mode === 'off' || busy) return;
    busy = true;
    try {
      if (mode === 'install') await checkInstall(manual);
      else await checkNotify(manual);
    } catch (e) {
      log('update check failed', e && e.message);
      if (manual) await ask('warning', strings().updFailedTitle, strings().updFailedBody, [strings().ok]);
    } finally {
      busy = false;
    }
  }

  function next(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      check(false).finally(() => next(EVERY_MS));
    }, ms);
  }

  return {
    mode,
    start: () => mode !== 'off' && next(FIRST_CHECK_MS),
    stop: () => clearTimeout(timer),
    checkNow: () => check(true),
    launchCheck,
    installNow,
    defer: () => {
      deferred = true;
      installWhenReady = false;
      onProgress = null;
      onFail = null;
    },
  };
}

module.exports = { createUpdates, isNewer, parseVersion, releaseNotes, safeReleaseUrl, updateMode, LAUNCH_CHECK_MS, RELEASES_API, RELEASES_PAGE };
