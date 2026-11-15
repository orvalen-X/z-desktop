'use strict';

// Keeps the app itself up to date. Z inside the window updates from the web on its own; this is only the wrapper.
//
// Where the update comes from: the public Releases page of orvalen-X/z-desktop. A version appears there only
// when Orvalen publishes it (the build makes a draft first), so a draft or a test build never reaches anyone.
//
// How it is installed:
//   Windows and Linux AppImage: downloaded in the background, checked against the SHA-512 in the release,
//     installed when Z restarts. The person chooses "Restart now" or "Later" (then it installs on quit).
//   macOS and Linux DEB: a short notice with a Download button. macOS only installs signed updates, and a DEB
//     is installed by the system's package tool. Both become automatic in the signing layer.

const RELEASES_API = 'https://api.github.com/repos/orvalen-X/z-desktop/releases/latest';
const RELEASES_PAGE = 'https://github.com/orvalen-X/z-desktop/releases/';
const FIRST_CHECK_MS = 30 * 1000;
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
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
    autoUpdater.on('error', (e) => log('update error', e && e.message));
    autoUpdater.on('update-downloaded', (info) => onDownloaded(info && info.version));
    updater = autoUpdater;
    return updater;
  }

  async function onDownloaded(v, again = false) {
    if (!v || (readyVersion === v && !again)) return;
    readyVersion = v;
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
  };
}

module.exports = { createUpdates, isNewer, parseVersion, safeReleaseUrl, updateMode, RELEASES_API, RELEASES_PAGE };
