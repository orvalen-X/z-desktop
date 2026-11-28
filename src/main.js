'use strict';

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, dialog, shell, session, net, ipcMain, nativeTheme, screen, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const fs = require('node:fs');
const cfg = require('./config');
const i18n = require('./i18n');
const { createPermissions } = require('./permissions');
const { createUpdates, releaseNotes, withTimeout, LAUNCH_CHECK_MS, RELEASES_API } = require('./updates');
const { createAutostart, autostartFromArgs, AUTOSTART_ARG } = require('./autostart');
const { createDisplays } = require('./displays');
const { createSurfaces } = require('./surfaces');
const { createDesks } = require('./desks');
const { createLockMirror } = require('./lockMirror');
const { createWindowMove } = require('./windowMove');
const { createWindowLive } = require('./windowLive');
const { createSpan } = require('./span');
const { randomBytes } = require('node:crypto');
const { createNavigationGuard, isPageFile } = require('./navGuard');
const { createWinKeys, isLeaveFullscreen } = require('./winKeys');
const pkg = require('../package.json');

// One Z per computer: a second launch focuses the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const isMac = process.platform === 'darwin';
// Reconnect attempts: quick at first, then calmer while the site stays unreachable.
const RETRY_STEPS_MS = [5000, 10000, 20000, 30000];
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const OFFLINE_URL = pathToFileURL(OFFLINE_FILE).href;
const TITLEBAR_FILE = path.join(__dirname, 'titlebar.html');
const BOOT_FILE = path.join(__dirname, 'boot.html');
// The update screen at start (O 28.11, sketch B): shown before Z loads when a newer version is ready.
const UPDATE_FILE = path.join(__dirname, 'update.html');
const onUpdatePage = () => !!zView && !zView.webContents.isDestroyed() && isPageFile(zView.webContents.getURL(), UPDATE_FILE);
// "Update and open" pressed and the download stops moving for this long: Z opens instead (next start offers again).
const UPDATE_STALL_MS = 90 * 1000;
// Height of the window bar shown when Z leaves full screen (sketch 3). In full screen it is 0.
const BAR_HEIGHT = 34;
// The name people see instead of a version number (O 26.11: "Z · DNA"); the number stays for updates.
const RELEASE_NAME = typeof pkg.zReleaseName === 'string' && pkg.zReleaseName.trim() ? pkg.zReleaseName.trim() : '';

// The Z window holds two views: the window bar on top (only outside full screen) and Z below it.
let win = null;
let zView = null;
let barView = null;
let offline = false;
let retryTimer = null;
let prefs = { lang: null, perms: {}, updSkipped: null, mainDisplay: null, span: false, winKeys: true };
const RESET_ARG = '--reset-permissions';
const UPDATE_ARG = '--check-updates';
// Leaves span mode from outside Z's page (it may be offline): the taskbar menu on Windows, or `z --one-display`.
const SPAN_OFF_ARG = '--one-display';
// Arguments that ask for something once: a restart never repeats them.
const ONCE_ARGS = new Set([RESET_ARG, UPDATE_ARG, SPAN_OFF_ARG]);
function restartArgs(argv) {
  return argv.slice(1).filter((a) => !ONCE_ARGS.has(a) && !a.startsWith(`${AUTOSTART_ARG}=`));
}

// ---------- small preferences file (language, permission answers, a skipped update notice) ----------

function prefsPath() {
  return path.join(app.getPath('userData'), 'z-desktop.json');
}
function loadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
    if (p && typeof p.lang === 'string') prefs.lang = p.lang;
    if (p && p.perms && typeof p.perms === 'object') prefs.perms = p.perms;
    if (p && typeof p.updSkipped === 'string') prefs.updSkipped = p.updSkipped;
    if (p && typeof p.mainDisplay === 'string' && p.mainDisplay.length <= 40) prefs.mainDisplay = p.mainDisplay;
    if (p && p.span === true) prefs.span = true;
    // the Windows key is Z's in full screen unless the person switched it off (O 27.11)
    if (p && p.winKeys === false) prefs.winKeys = false;
  } catch {
    /* first run */
  }
}
function savePrefs() {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs));
  } catch {
    /* read-only disk: not important */
  }
}
function lang() {
  return i18n.pickLang(prefs.lang, app.getPreferredSystemLanguages());
}
function t() {
  return i18n.strings(lang());
}

// ---------- the browser identity Z sees ----------

// Drop the "Electron" and app tokens so sites see a normal Chrome, and add one clear marker for Z.
let cachedUserAgent = null;
function userAgent() {
  if (cachedUserAgent) return cachedUserAgent;
  const base = app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp('\\s' + app.getName() + '\\/\\S+', 'i'), '')
    .replace(/\sZDesktop\/\S+/i, '');
  cachedUserAgent = `${base} ZDesktop/${app.getVersion()}`;
  return cachedUserAgent;
}

// Every system message box goes through here, so RTL languages read right to left (i18n.boxText).
function showBox(parent, opts) {
  const l = lang();
  const o = { ...opts };
  for (const k of ['title', 'message', 'detail']) o[k] = i18n.boxText(l, o[k]);
  if (Array.isArray(o.buttons)) o.buttons = o.buttons.map((b) => i18n.boxText(l, b));
  return parent ? dialog.showMessageBox(parent, o) : dialog.showMessageBox(o);
}

// ---------- security for everything that loads ----------

function askPermission(origin, kinds) {
  const s = t();
  const names = kinds.map((k) => s['perm' + k[0].toUpperCase() + k.slice(1)]);
  const what = names.join(s.permJoin);
  return showBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question',
    title: 'Z',
    message: s.permAsk.replace('{what}', what),
    detail: `${i18n.ltrRun(new URL(origin).host)}\n\n${s.permDetail}`,
    buttons: [s.permAllow, s.permDeny],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => response === 0);
}

const permissions = createPermissions({
  store: {
    get: (origin) => prefs.perms[origin],
    set: (origin, decisions) => {
      prefs.perms[origin] = decisions;
      savePrefs();
    },
    clear: () => {
      prefs.perms = {};
      savePrefs();
    },
  },
  ask: askPermission,
});

function resetPermissions() {
  const s = t();
  showBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question',
    title: s.resetTitle,
    message: s.resetTitle,
    detail: s.resetBody,
    buttons: [s.resetConfirm, s.cancel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => {
    if (response !== 0) return;
    permissions.reset();
    // Reload so any camera or microphone already in use is released.
    if (zView && !zView.webContents.isDestroyed() && !offline) zView.webContents.reload();
  });
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const top = wc && !wc.isDestroyed() ? wc.getURL() : '';
    const url = details.requestingUrl || top;
    permissions
      .request(url, permission, details, details.isMainFrame === false ? top : '')
      .then(callback)
      .catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    // a cross-origin frame inside Z: Electron names the page that embeds it (O 25.11)
    const top = (details && details.embeddingOrigin) || (details && details.isMainFrame === false && wc && !wc.isDestroyed() ? wc.getURL() : '');
    return permissions.check(requestingOrigin, permission, details, top);
  });
  // No downloads of programs into the wrapper's folder: files go to the normal Downloads folder with a save dialog.
  ses.on('will-download', (event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

function openOutside(url) {
  if (cfg.isExternalSafe(url)) shell.openExternal(url);
}

function explainGoogle() {
  const s = t();
  showBox(win, {
    type: 'info',
    title: s.googleTitle,
    message: s.googleTitle,
    detail: s.googleBody,
    buttons: [s.ok, s.googleOpenBrowser],
    defaultId: 0,
    cancelId: 0,
  }).then(({ response }) => {
    if (response === 1) openOutside(cfg.START_URL);
  });
}

function guardContents(wc) {
  // Navigation inside the window: the top stays on Z; frames inside Z navigate like in any browser (navGuard.js).
  const onNavigate = createNavigationGuard({
    cfg,
    offlineUrl: OFFLINE_URL,
    openOutside,
    explainGoogle,
    updateFile: UPDATE_FILE,
    onUpdateAction: (what) => (zView && wc === zView.webContents ? onUpdateScreen(what) : undefined),
  });
  wc.on('will-navigate', onNavigate);
  wc.on('will-redirect', onNavigate);

  // New windows: Z's own pages stay in Z, everything else opens in the browser.
  // Blank windows are refused: Electron cannot tell whether Z or a third-party frame inside Z opened one
  // (the referrer is empty for both), and a blank window can be filled with a fake sign-in form.
  wc.setWindowOpenHandler(({ url, frameName }) => {
    const blank = url === 'about:blank' || url === '';
    // Extend: a blank window Z's own page prepared a moment ago (one-time name), only from Z's view.
    if (blank && surfaces && zView && wc === zView.webContents) {
      const s = surfaces.claim(frameName, secureWebPreferences(false));
      if (s) return { action: 'allow', overrideBrowserWindowOptions: s.options };
    }
    if (cfg.isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#2b2b2d',
          webPreferences: secureWebPreferences(false),
        },
      };
    }
    if (blank) return { action: 'deny' };
    if (cfg.isGoogleSignIn(url)) explainGoogle();
    else openOutside(url);
    return { action: 'deny' };
  });

  // Never attach a <webview>.
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

// display: the id of the display a whole Z runs on (extend, way A); empty for Z's own window.
// The window bar's button in span mode: 'minimize' or 'close' when url is the bar's own page asking for it, else null.
function barAction(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:' || path.normalize(fileURLToPath(u)) !== path.normalize(TITLEBAR_FILE)) return null;
    const what = u.searchParams.get('do');
    return what === 'minimize' || what === 'close' ? what : null;
  } catch {
    return null;
  }
}

function secureWebPreferences(withPreload, display) {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: true,
    ...(withPreload
      ? {
          preload: path.join(__dirname, 'preload.js'),
          additionalArguments: [
            `--z-desktop-version=${app.getVersion()}`,
            `--z-desktop-release=${RELEASE_NAME}`,
            ...(display ? [`--z-desktop-display=${display}`] : []),
            ...(span && span.active() ? ['--z-desktop-span=1', `--z-desktop-span-bar=${BAR_HEIGHT}`] : []),
          ],
        }
      : {}),
  };
}

// ---------- updates of the app itself ----------

function ask(type, message, detail, buttons) {
  return showBox(win && !win.isDestroyed() ? win : undefined, {
    type,
    title: 'Z',
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  }).then(({ response }) => response);
}

async function fetchLatestRelease() {
  const res = await net.fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ZDesktop/${app.getVersion()}` },
  });
  if (res.status === 404) return null; // nothing published yet
  if (!res.ok) throw new Error(`releases ${res.status}`);
  return res.json();
}

const updates = createUpdates({
  app,
  version: app.getVersion(),
  platform: process.platform,
  env: process.env,
  fetchLatest: fetchLatestRelease,
  openExternal: (url) => shell.openExternal(url),
  ask,
  prefs,
  savePrefs,
  strings: t,
  log: (...a) => console.warn('[z-desktop]', ...a),
});

// ---------- the update screen at start (O 28.11) ----------

// The new release's title as typed on GitHub ("Z · DNA 0.4.4"), when it is plain and its number is this version's.
function releaseTitle(raw, v) {
  if (typeof raw !== 'string') return `Z ${v}`;
  const n = raw.normalize('NFC').replace(/[^\p{L}0-9 ·\-.,:()'_]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  const nums = n.match(/\d+\.\d+\.\d+/g) || [];
  if (!n || nums.some((x) => x !== v) || n === v || n === `v${v}`) return `Z ${v}`;
  return nums.length ? n : `${n} ${v}`;
}

let updateStall = null;

// At start: a short check first. A newer version → the update screen; anything else → Z, as before.
async function startZ() {
  if (updates.mode !== 'install' || !net.isOnline()) {
    if (net.isOnline()) loadZ();
    else showOffline();
    return;
  }
  // The Z logo of the boot screen while the check runs (a few hundred milliseconds, at most a few seconds).
  zView.webContents.loadFile(BOOT_FILE);
  // Both answers within LAUNCH_CHECK_MS: a slow or half-open network never holds Z's start (no title/notes then).
  const [found, rel] = await Promise.all([updates.launchCheck(), withTimeout(fetchLatestRelease().catch(() => null), LAUNCH_CHECK_MS)]);
  if (!zView || zView.webContents.isDestroyed()) return;
  if (!found) return loadZ();
  // The screen is the offer now: no system box about the same update on top of it (the download goes on).
  updates.defer();
  const v = found.version;
  const same = rel && typeof rel.tag_name === 'string' && rel.tag_name.replace(/^v/, '') === v;
  const s = t();
  zView.webContents.loadFile(UPDATE_FILE, {
    query: {
      lang: lang(),
      dir: s.dir,
      dark: nativeTheme.shouldUseDarkColors ? '1' : '0',
      name: releaseTitle(same ? rel.name : null, v),
      from: app.getVersion(),
      to: v,
      title: s.ulTitle,
      lead: s.ulLead,
      notes: s.ulNotes,
      update: s.ulUpdate,
      later: s.ulLater,
      keep: s.ulKeep,
      prep: s.ulPrep,
      prepSub: s.ulPrepSub,
      nooff: s.ulNoOff,
      // URLSearchParams turns an array into repeated keys: n=…&n=…
      n: same ? releaseNotes(rel.body) : [],
    },
  });
}

// A button on the update screen: "update" (install now, Z restarts by itself) or "later" (Z opens; asked again next start).
function onUpdateScreen(what) {
  if (!onUpdatePage()) return;
  if (what === 'later') {
    updates.defer();
    loadZ();
    return;
  }
  if (what !== 'update') return;
  const giveUp = () => {
    clearTimeout(updateStall);
    updates.defer();
    loadZ();
  };
  const report = (pct) => {
    clearTimeout(updateStall);
    updateStall = setTimeout(giveUp, UPDATE_STALL_MS);
    if (onUpdatePage()) {
      zView.webContents.executeJavaScript(`window.zu && window.zu.progress(${Number(pct) || 0})`, true).catch(() => {});
    }
  };
  updateStall = setTimeout(giveUp, UPDATE_STALL_MS);
  updates.installNow({ progress: report, fail: giveUp });
}

// ---------- offline screen ----------

function showOffline() {
  if (!win || win.isDestroyed()) return;
  offline = true;
  const s = t();
  zView.webContents.loadFile(OFFLINE_FILE, {
    query: {
      lang: lang(),
      dir: s.dir,
      title: s.offlineTitle,
      body: s.offlineBody,
      retry: s.offlineRetry,
      trying: s.offlineTrying,
    },
  });
  scheduleRetry();
}

let retryStep = 0;
function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
  retryTimer = setTimeout(() => {
    if (!offline || !win || win.isDestroyed()) return;
    if (net.isOnline()) {
      retryStep++;
      loadZ();
    } else scheduleRetry();
  }, wait);
}

function loadZ() {
  offline = false;
  clearTimeout(retryTimer);
  zView.webContents.loadURL(cfg.START_URL);
}

// ---------- the Z window ----------

function rememberZLanguage() {
  if (!zView || zView.webContents.isDestroyed() || !cfg.isAppUrl(zView.webContents.getURL())) return;
  zView.webContents
    .executeJavaScript('document.documentElement.lang', true)
    .then((l) => {
      const code = i18n.pickLang(l, []);
      if (l && code !== prefs.lang && i18n.SUPPORTED.includes(code)) {
        prefs.lang = code;
        savePrefs();
        buildMenu();
        buildIconMenu();
      }
    })
    .catch(() => {});
}

// ---------- full screen and the window bar ----------

// Z's own window's full screen, as the window's own events tell it. Not win.isFullScreen() inside those events: on
// Windows Electron sends enter-full-screen and leave-full-screen BEFORE the window changes (NativeWindowViews::
// SetFullScreen notifies, then calls widget()->SetFullscreen), so it still gives the old answer there. Reading it
// then never held the page, and the Windows key and Alt+Tab stayed with Windows (O 28.11, 0.4.3).
// macOS and Linux tell after the change, so there the window itself answers, as before.
let winFull = false;
const windowFull = () => (process.platform === 'win32' ? winFull : win.isFullScreen());
const isFullscreen = () => !!win && !win.isDestroyed() && (span && span.active() ? span.full() : windowFull());

// The Windows key belongs to Z while Z's own window is in full screen (winKeys.js, O 27.11).
const winKeys = createWinKeys({
  platform: process.platform,
  enabled: () => prefs.winKeys !== false,
  wanted: () =>
    !!win &&
    !win.isDestroyed() &&
    !(span && span.active()) &&
    windowFull() &&
    !!zView &&
    !zView.webContents.isDestroyed() &&
    cfg.isAppUrl(zView.webContents.getURL()),
  contents: () => (zView ? zView.webContents : null),
});

const NO_WIN_KEYS = Object.freeze({ supported: false, enabled: false });
function winKeysState() {
  return winKeys.supported ? { supported: true, enabled: prefs.winKeys !== false } : NO_WIN_KEYS;
}
function setWinKeys(on) {
  if (winKeys.supported && on !== (prefs.winKeys !== false)) {
    prefs.winKeys = on;
    savePrefs();
    winKeys.changed();
  }
  return winKeysState();
}

function barColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#1c1f26' : '#eef1f5', symbolColor: dark ? '#e9edf3' : '#1b2028', height: BAR_HEIGHT };
}

// Full screen: Z fills everything. Outside it: the window bar on top and Z below, never on top of each other.
function layout() {
  if (!win || win.isDestroyed() || !zView) return;
  const { width, height } = win.getContentBounds();
  // Span mode out of full screen: the bar sits over the top of the primary display only, and Z's page (which covers
  // every display) keeps that strip free itself (api 8: span.bar).
  const spanBar = span && span.active() ? span.barRect(BAR_HEIGHT) : null;
  if (span && span.active()) {
    barView.setVisible(!!spanBar);
    if (spanBar) barView.setBounds(spanBar);
    // While Z's page loads it covers the main display only, and every other display shows the app's Z logo
    // (spanBoot below); then Z's page covers every display.
    const box = spanBooting ? span.mainBox(BAR_HEIGHT) : null;
    zView.setBounds(box || { x: 0, y: 0, width, height });
    placeBootViews(box ? span.bootRects() : []);
    sendSpanOrigin();
    return;
  }
  const bar = isFullscreen() ? 0 : BAR_HEIGHT;
  barView.setVisible(bar > 0);
  barView.setBounds({ x: 0, y: 0, width, height: bar });
  zView.setBounds({ x: 0, y: bar, width, height: Math.max(0, height - bar) });
}

// Span mode: where Z's page starts on the system's desk (DIP), from the window's content and the page's own view. Z
// places every display on its page from this (api 10: span.origin), not from window.screenX, which is the window's
// outer corner and can differ from where the page really starts (O 28.11: a strip of the other display at the seam).
let spanOrigin = null;
function viewOrigin() {
  if (!win || win.isDestroyed() || !zView) return null;
  try {
    const c = win.getContentBounds();
    const v = zView.getBounds();
    const o = { x: Math.round(c.x + v.x), y: Math.round(c.y + v.y) };
    return Number.isFinite(o.x) && Number.isFinite(o.y) ? o : null;
  } catch {
    return null;
  }
}
function sendSpanOrigin() {
  const o = viewOrigin();
  if (!o || (spanOrigin && spanOrigin.x === o.x && spanOrigin.y === o.y)) return;
  spanOrigin = o;
  if (!zView.webContents.isDestroyed()) zView.webContents.send('zd:span:origin', o);
}

function tellZ() {
  const on = isFullscreen();
  if (zView && !zView.webContents.isDestroyed()) zView.webContents.send('zd:fs', on);
  if (desks) desks.each((wc) => wc.send('zd:fs', on));
}

// The one way full screen changes: F11, the Mac menu, and the top-bar button in Z all come here.
// Leaving full screen gives a maximized window (O 26.11: Z keeps its size, the system's bars appear around it).
function setFullscreen(on) {
  if (!win || win.isDestroyed()) return false;
  if (span && span.active()) {
    // Span mode: one window over every display, so full screen is the same everywhere (O 27.11: all together).
    if (on !== span.full()) {
      span.setFull(on);
      fitSpan();
      tellZ();
      liftSpan();
    }
    return on;
  }
  if (on !== isFullscreen()) win.setFullScreen(on);
  return on;
}
// Ctrl+Alt+Esc: out of full screen, back to Windows (O 27.11: with the Windows key and Alt+Tab Z's own, the one way
// back). Only in full screen, and not on a Mac (its keys come with the Mac layer).
function leaveFullscreenKey(input) {
  return !isMac && isLeaveFullscreen(input) && isFullscreen();
}
function toggleFullscreen() {
  return setFullscreen(!isFullscreen());
}

// Span mode: Z's window covers every display (or every work area out of full screen) and follows display changes.
let span = null;

// Span mode, while Z's page loads (start, reload, sign-out; O 27.11: the loading logo in the centre of every display,
// even with 4): Z's page covers the main display only, so its own boot screen (whatever theme) is that display's size
// and centred on it, and every other display shows boot.html. Z's page says when its boot screen is gone
// (span.ready, api 8); a page that never says it gets every display after BOOT_MAX_MS, so nothing stays hidden.
const BOOT_MAX_MS = 60000;
let spanBooting = false;
let bootTimer = null;
const bootViews = [];
function spanBootStart() {
  if (!span || !span.active()) return;
  spanBooting = true;
  clearTimeout(bootTimer);
  bootTimer = setTimeout(spanBootEnd, BOOT_MAX_MS);
  layout();
}
function spanBootEnd() {
  clearTimeout(bootTimer);
  bootTimer = null;
  if (!spanBooting) return true;
  spanBooting = false;
  layout();
  return true;
}
// One boot.html view per other display: made when needed, taken away when the displays are fewer or Z is ready.
function placeBootViews(rects) {
  if (!win || win.isDestroyed()) return;
  while (bootViews.length > rects.length) {
    const v = bootViews.pop();
    try {
      win.contentView.removeChildView(v);
      v.webContents.close();
    } catch {
      /* the window is closing */
    }
  }
  while (bootViews.length < rects.length) {
    const v = new WebContentsView({ webPreferences: secureWebPreferences(false) });
    v.setBackgroundColor('#121316');
    v.webContents.on('will-navigate', (event) => event.preventDefault());
    v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    v.webContents.loadFile(BOOT_FILE);
    win.contentView.addChildView(v);
    bootViews.push(v);
  }
  rects.forEach((r, i) => bootViews[i].setBounds(r));
}
function fitSpan() {
  if (!win || win.isDestroyed() || !span) return;
  const b = span.bounds();
  if (b) win.setBounds(b);
  layout();
}
// While Z has the focus and is full screen, its window sits above the taskbars (Windows and Linux draw a taskbar
// over a window that only covers it). Another app taking the focus lets them back.
function liftSpan() {
  if (!win || win.isDestroyed() || !span || !span.active()) return;
  try {
    win.setAlwaysOnTop(span.full() && win.isFocused(), 'screen-saver');
  } catch {
    /* the window is closing */
  }
}

// ---------- requests from Z's page ----------

// Only Z's own page may ask: the top frame of the Z view, on Z's address. App frames inside Z never get here
// (the preload runs only in the top frame), and this check refuses them even if they tried.
// The Z on another display (extend, way A) may ask too, except for what only Z's own window decides (fromMainZ).
function fromZ(event) {
  if (fromMainZ(event)) return true;
  const wc = event.sender;
  const frame = event.senderFrame;
  return !!desks && !!wc && desks.displayOf(wc) !== null && !!frame && frame === wc.mainFrame && cfg.isAppUrl(frame.url);
}
function fromMainZ(event) {
  const wc = zView && zView.webContents;
  const frame = event.senderFrame;
  return !!wc && event.sender === wc && !!frame && frame === wc.mainFrame && cfg.isAppUrl(frame.url);
}

const autostart = createAutostart({
  app,
  platform: process.platform,
  env: process.env,
  fs,
  path,
  homedir: app.getPath('home'),
  execPath: process.execPath,
});

// Displays (layer 0): read only. The screen module exists only after the app is ready, so this is made there.
let displays = null;
const NO_SPAN = Object.freeze({ supported: false, on: false, active: false, restarting: false });
const NO_DISPLAYS = { displays: [], system: { platform: process.platform, wayland: false, canOpenSettings: false, canChange: false } };
function sendDisplays(snap) {
  if (zView && !zView.webContents.isDestroyed()) zView.webContents.send('zd:displays', snap);
  if (desks) desks.each((wc) => wc.send('zd:displays', snap));
}
// Extend (way A): a whole Z on every extra display. Made after the app is ready.
let desks = null;
// The display Z's own window is on now.
function mainDisplayId() {
  if (!win || win.isDestroyed()) return null;
  try {
    return String(screen.getDisplayMatching(win.getBounds()).id);
  } catch {
    return null;
  }
}
// Extend, way A, layer 3: one lock for every display. Z's own window locks and unlocks; the others only show it.
const lockMirror = createLockMirror({ send: (state) => desks && desks.each((wc) => wc.send('zd:lock', state)) });
// Extend, way A, layer 4: a window dragged off one display opens on the display under the cursor. Made with the
// screen module, after the app is ready.
let windowMove = null;
// Layer 6: a window dragged across displays moves with the hand (made with windowMove).
let windowLive = null;
// A request from a Z on an extra display, passed on to Z's own window (which decides).
function askMainZ(channel) {
  if (!zView || zView.webContents.isDestroyed()) return false;
  zView.webContents.send(channel);
  return true;
}
// Extend (way B): Z draws on one plain window per extra display. Made with the displays, after the app is ready.
let surfaces = null;
// While Z (its own window or one on another display) has the focus, its windows stay above the taskbar. The check
// waits a moment, so moving the focus between two of Z's windows does not let the taskbar flash in.
let focusCheck = null;
function checkFocus() {
  clearTimeout(focusCheck);
  focusCheck = setTimeout(() => {
    if (!surfaces) return;
    const f = BrowserWindow.getFocusedWindow();
    const on = !!f && !!win && (f === win || surfaces.owns(f) || (!!desks && desks.owns(f)));
    surfaces.setActive(on, win && !win.isDestroyed() ? win : null);
    if (desks) desks.setActive(on);
  }, 120);
}
function startDisplays() {
  displays = createDisplays({
    screen,
    BrowserWindow,
    shell,
    spawn,
    platform: process.platform,
    env: process.env,
    identifyFile: path.join(__dirname, 'identify.html'),
    webPreferences: secureWebPreferences(false),
    zWindow: () => win,
    send: (snap) => {
      if (span && span.active()) fitSpan();
      if (surfaces) surfaces.prune();
      if (desks) desks.sync();
      sendDisplays(snap);
    },
  });
  displays.listen();
}

function listenToZ() {
  ipcMain.handle('zd:fs:get', (e) => (fromZ(e) ? isFullscreen() : false));
  ipcMain.handle('zd:fs:set', (e, on) => (fromZ(e) && typeof on === 'boolean' ? setFullscreen(on) : isFullscreen()));
  ipcMain.handle('zd:fs:toggle', (e) => (fromZ(e) ? toggleFullscreen() : isFullscreen()));
  // api 9: the Windows key in full screen. Only Z's own window switches it.
  ipcMain.handle('zd:keys:get', (e) => (fromZ(e) ? winKeysState() : NO_WIN_KEYS));
  ipcMain.handle('zd:keys:set', (e, on) => (fromMainZ(e) && typeof on === 'boolean' ? setWinKeys(on) : winKeysState()));
  ipcMain.handle('zd:autostart:get', (e) => (fromZ(e) ? autostart.get() : { supported: false, enabled: false }));
  ipcMain.handle('zd:autostart:set', (e, on) =>
    fromMainZ(e) && typeof on === 'boolean' ? autostart.set(on) : { supported: false, enabled: false },
  );
  ipcMain.handle('zd:displays:get', (e) => (fromZ(e) && displays ? displays.snapshot() : NO_DISPLAYS));
  // Identify windows open only when Z asks (never at start: Z Setup waits for Z's first visible window).
  ipcMain.handle('zd:displays:identify', (e) => (fromZ(e) && displays ? displays.identify() : { shown: 0 }));
  ipcMain.handle('zd:displays:settings', (e) => (fromZ(e) && displays ? displays.openSystemSettings() : { opened: false }));
  // Extend, way A: Z's own window turns a whole Z on every extra display on or off (its Multiple displays choice).
  // Layer 3: only Z's own window sets the lock; an extra display reads it, may ask to lock, and reports activity.
  ipcMain.handle('zd:lock:get', (e) => (fromZ(e) ? lockMirror.get() : { locked: true, profile: null }));
  ipcMain.handle('zd:lock:set', (e, state) => (fromMainZ(e) ? lockMirror.set(state) : lockMirror.get()));
  ipcMain.handle('zd:lock:request', (e) => (fromZ(e) && !fromMainZ(e) ? askMainZ('zd:lock:request') : false));
  ipcMain.handle('zd:lock:activity', (e) =>
    fromZ(e) && !fromMainZ(e) && lockMirror.activity() ? askMainZ('zd:lock:activity') : false,
  );
  // Layer 4: any Z may hand a window to the Z on the display under the cursor (windowMove checks the rest).
  ipcMain.handle('zd:window:send', (e, spec) => (fromZ(e) && windowMove ? windowMove.send(e.sender, spec) : { ok: false }));
  // r2: the target Z answers that it opened the window (or refused); only then does the Z it left close its own.
  // Layer 6: the answer for a window carried with the hand goes to windowLive, any other to windowMove.
  ipcMain.handle('zd:window:arrived', (e, answer) =>
    fromZ(e) && windowMove
      ? windowLive && answer && windowLive.owns(answer.token) ? windowLive.arrived(e.sender, answer) : windowMove.arrived(e.sender, answer)
      : { ok: false },
  );
  // Layer 6: the cursor left a Z's page while it drags a window (start), and the hand let go or came back (drop).
  ipcMain.handle('zd:window:drag', (e, spec) => (fromZ(e) && windowLive ? windowLive.start(e.sender, spec) : { ok: false }));
  ipcMain.handle('zd:window:drop', (e, answer) => (fromZ(e) && windowLive ? windowLive.drop(e.sender, answer) : { ok: false }));
  ipcMain.handle('zd:desks:set', (e, on) => (fromMainZ(e) && desks && typeof on === 'boolean' ? desks.setEnabled(on) : false));
  // api 8: one Z across all displays (span mode), read by any Z, switched only by Z's own window.
  ipcMain.handle('zd:span:get', (e) => (fromZ(e) && span ? span.get() : NO_SPAN));
  ipcMain.handle('zd:span:set', (e, on) => (fromMainZ(e) && span && typeof on === 'boolean' ? span.set(on) : NO_SPAN));
  // Z's page: its boot screen is gone, so it may cover every display now (span mode; a no-op otherwise)
  ipcMain.handle('zd:span:ready', (e) => (fromMainZ(e) && span && span.active() ? spanBootEnd() : false));
  // api 10: where Z's own page starts on the desk in span mode (null otherwise); changes come as zd:span:origin
  ipcMain.handle('zd:span:origin', (e) => (fromMainZ(e) && span && span.active() ? viewOrigin() : null));
  // Extend: a one-time window name for one display (Z then calls window.open('', name)).
  ipcMain.handle('zd:displays:surface', (e, id) =>
    fromMainZ(e) && surfaces && (typeof id === 'string' || typeof id === 'number') ? surfaces.prepare(String(id)) : null,
  );
  // The main display: Z's own window (and its Dock) moves there; remembered on this computer.
  ipcMain.handle('zd:displays:main', (e, id) =>
    fromMainZ(e) && surfaces && (typeof id === 'string' || typeof id === 'number') ? surfaces.moveMain(win, String(id)) : { ok: false },
  );
}

// ---------- the Z window ----------

// Span mode: no frame and no system full screen; Z's window is placed over every display and stays there.
function spanWindowOptions() {
  return {
    ...(span.bounds() || { width: 1440, height: 900 }),
    show: false,
    frame: false,
    fullscreen: false,
    fullscreenable: false,
    maximizable: false,
    resizable: false,
    movable: false,
    autoHideMenuBar: true,
    backgroundColor: '#2b2b2d',
    title: RELEASE_NAME ? `Z ${RELEASE_NAME}` : 'Z',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  };
}

function createWindow() {
  // The display the person chose for Z (Settings > Displays > Main display), when it is still connected.
  const start = surfaces ? surfaces.startBounds() : null;
  const spanning = !!span && span.active();
  win = new BaseWindow(spanning ? spanWindowOptions() : {
    width: 1440,
    height: 900,
    ...(start || {}),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // Z always opens in full screen, also when it starts with the computer (O 26.11).
    fullscreen: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#2b2b2d',
    title: RELEASE_NAME ? `Z ${RELEASE_NAME}` : 'Z',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // Our own window bar (sketch 3); the system keeps drawing its window buttons over it.
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: barColors() }),
  });
  // It opens in full screen (fullscreen: true above, before any listener); its own events tell every change after.
  winFull = !spanning;
  if (spanning) {
    win.on('focus', liftSpan);
    win.on('blur', liftSpan);
  }

  barView = new WebContentsView({ webPreferences: secureWebPreferences(false) });
  barView.setBackgroundColor(barColors().color);
  // Span mode: the window has no system frame, so the bar draws its own minimize and close buttons (span mode is fixed
  // for the run). A button asks by trying to open the bar's own page with ?do=minimize or ?do=close; that is refused
  // like every other navigation here, and only that exact page and those two words do anything.
  barView.webContents.loadFile(TITLEBAR_FILE, {
    query: { name: RELEASE_NAME || app.getVersion(), ...(spanning ? { controls: '1' } : {}) },
  });
  barView.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (!spanning || !win || win.isDestroyed()) return;
    const what = barAction(url);
    if (what === 'minimize') win.minimize();
    else if (what === 'close') win.close();
  });

  zView = new WebContentsView({ webPreferences: secureWebPreferences(true) });
  zView.setBackgroundColor('#2b2b2d');
  zView.webContents.setUserAgent(userAgent());
  // Extend: a window Z prepared for a display is locked down and covers that display.
  zView.webContents.on('did-create-window', (child, details) => {
    const id = surfaces && surfaces.displayOfOpening(details && details.frameName);
    if (id) surfaces.adopt(child, id);
  });
  // A new page of Z (reload, sign-out), a crash or a closed window: every display shows the lock until Z says again.
  zView.webContents.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) {
      lockMirror.reset();
      // span mode: a new page of Z boots on the main display, the others show the Z logo until it is ready. The
      // app's own offline page never says ready, so it gets every display at once (Closure NIT 1 on #26).
      if (cfg.isAppUrl(details.url)) spanBootStart();
      else spanBootEnd();
    }
  });
  // A new page of Z (reload, sign-out) opens its own windows: the old page's are closed.
  zView.webContents.on('did-navigate', () => surfaces && surfaces.closeAll());
  // Z's page crashed: the windows it drew on would stay frozen over the other displays. Close them.
  zView.webContents.on('render-process-gone', () => surfaces && surfaces.closeAll());
  zView.webContents.on('render-process-gone', () => lockMirror.reset());
  winKeys.attach(zView.webContents);

  win.contentView.addChildView(zView);
  win.contentView.addChildView(barView);
  if (spanning) spanBootStart();
  layout();

  // Show once Z has something to paint (or after a moment, so a slow network never hides the window).
  let shown = false;
  const show = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
    // Some systems keep a new window inside one display: place it over all of them again once it shows.
    if (spanning) fitSpan();
    zView.webContents.focus();
  };
  zView.webContents.once('dom-ready', show);
  zView.webContents.once('did-fail-load', show);
  setTimeout(show, 3000);

  win.on('resize', layout);
  if (spanning) win.on('move', layout);
  win.on('enter-full-screen', () => {
    winFull = true;
    layout();
    tellZ();
    if (surfaces) surfaces.followFullScreen(true);
    if (desks) desks.followFullScreen(true);
    checkFocus();
    winKeys.changed();
  });
  win.on('leave-full-screen', () => {
    winFull = false;
    // On its way to another display (Main display), the move places the window itself.
    if (!win.isMaximized() && !(surfaces && surfaces.moving())) win.maximize();
    layout();
    tellZ();
    if (surfaces) surfaces.followFullScreen(false);
    if (desks && !(surfaces && surfaces.moving())) desks.followFullScreen(false);
    checkFocus();
    winKeys.changed();
  });
  win.on('focus', () => zView && !zView.webContents.isDestroyed() && zView.webContents.focus());

  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    barView.setBackgroundColor(barColors().color);
    if (!isMac && !spanning) win.setTitleBarOverlay(barColors());
  });

  // F11 everywhere (and Ctrl+Cmd+F on Mac through the menu) switches full screen.
  zView.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control && !input.meta) {
      event.preventDefault();
      toggleFullscreen();
    } else if (leaveFullscreenKey(input)) {
      event.preventDefault();
      setFullscreen(false);
    }
  });

  zView.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    // -3 = a navigation was replaced by another one: not a failure.
    if (isMainFrame && code !== -3 && cfg.isInWindowUrl(url)) showOffline();
  });
  zView.webContents.on('did-navigate', (event, url) => {
    if (cfg.isInWindowUrl(url)) {
      offline = false;
      retryStep = 0;
      clearTimeout(retryTimer);
    }
  });
  zView.webContents.on('did-finish-load', rememberZLanguage);
  zView.webContents.on('did-navigate-in-page', rememberZLanguage);

  // Z moved to another display: tell Z which display it is on now.
  win.on('moved', () => {
    if (displays) displays.changed();
    // The display Z's own window is on gets no extra Z; the one it left gets one.
    if (desks) desks.sync();
  });
  win.on('closed', () => {
    if (displays) displays.closeIdentify();
    lockMirror.reset();
    if (surfaces) surfaces.closeAll();
    if (desks) desks.closeAll();
    // Views are not closed with the window: close them, so nothing keeps running.
    for (const v of [zView, barView]) if (v && !v.webContents.isDestroyed()) v.webContents.close();
    win = null;
    zView = null;
    barView = null;
    clearTimeout(retryTimer);
  });

  startZ();
}

// ---------- menu ----------

function buildMenu() {
  const s = t();
  if (!isMac) {
    // Windows and Linux: no menu bar at all. Copy, paste and F11 keep working.
    Menu.setApplicationMenu(null);
    return;
  }
  // Mac needs a menu for copy, paste and the usual shortcuts.
  const template = [
    {
      label: 'Z',
      submenu: [
        { role: 'about', label: s.menuAbout },
        { label: s.updCheck, click: () => updates.checkNow() },
        { type: 'separator' },
        { label: s.resetTitle, click: resetPermissions },
        { type: 'separator' },
        { role: 'hide', label: s.menuHide },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: s.menuQuit },
      ],
    },
    {
      label: s.menuEdit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: s.menuView,
      submenu: [
        { label: s.menuReload, accelerator: 'Cmd+R', click: () => (offline ? loadZ() : zView && zView.webContents.reload()) },
        { type: 'separator' },
        { label: s.menuFullscreen, accelerator: 'Ctrl+Cmd+F', click: toggleFullscreen },
        ...(app.isPackaged ? [] : [{ label: 'Developer tools', click: () => zView && zView.webContents.toggleDevTools() }]),
      ],
    },
    { label: s.menuWindow, submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Right-click on the Z icon: "Reset permissions" and "Check for updates" (Windows taskbar, Mac Dock and menu;
// Linux uses the .desktop actions).
function buildIconMenu() {
  const s = t();
  if (process.platform === 'win32') {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: RESET_ARG,
        iconPath: process.execPath,
        iconIndex: 0,
        title: s.resetTitle,
        description: s.resetBody,
      },
      {
        program: process.execPath,
        arguments: UPDATE_ARG,
        iconPath: process.execPath,
        iconIndex: 0,
        title: s.updCheck,
        description: s.updCheck,
      },
      // Only while span mode is chosen: the way back that works even when Z's page cannot load.
      ...(prefs.span === true
        ? [{ program: process.execPath, arguments: SPAN_OFF_ARG, iconPath: process.execPath, iconIndex: 0, title: s.spanOff, description: s.spanOff }]
        : []),
    ]);
  } else if (isMac && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: s.resetTitle, click: resetPermissions },
        { label: s.updCheck, click: () => updates.checkNow() },
      ]),
    );
  }
}

// ---------- app life ----------

app.on('second-instance', (event, argv) => {
  if (!win) return;
  if (argv.includes(RESET_ARG)) resetPermissions();
  if (argv.includes(UPDATE_ARG)) updates.checkNow();
  if (argv.includes(SPAN_OFF_ARG) && span) span.set(false);
  const startWithComputer = autostartFromArgs(argv);
  if (startWithComputer !== null) autostart.set(startWithComputer);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Every page, window and frame gets the same guards, once.
app.on('web-contents-created', (event, wc) => guardContents(wc));

// Extend, way A and way B (not in span mode). Made after the app is ready.
function startExtend() {
  surfaces = createSurfaces({ screen, randomBytes, isMac, isWin: process.platform === 'win32', prefs, savePrefs });
  desks = createDesks({
    BrowserWindow,
    screen,
    isMac,
    isWin: process.platform === 'win32',
    webPreferences: (id) => secureWebPreferences(true, id),
    startUrl: cfg.START_URL,
    userAgent: userAgent(),
    mainDisplayId,
    // F11 on any display switches full screen for all of them (Z's own window leads).
    onCreate: (w) =>
      w.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control && !input.meta) {
          event.preventDefault();
          toggleFullscreen();
        } else if (leaveFullscreenKey(input)) {
          event.preventDefault();
          setFullscreen(false);
        }
      }),
  });
}

app.whenReady().then(() => {
  app.userAgentFallback = userAgent();
  loadPrefs();
  // `--one-display` at start: span mode off before any window is made (no restart needed).
  if (process.argv.includes(SPAN_OFF_ARG) && prefs.span === true) {
    prefs.span = false;
    savePrefs();
  }
  // The file also marks this folder as Z's: the Windows uninstaller deletes the folder only when it finds it.
  if (!fs.existsSync(prefsPath())) savePrefs();
  hardenSession(session.defaultSession);
  // The installer passes the person's "start with the computer" checkbox once, on the first start.
  const startWithComputer = autostartFromArgs(process.argv);
  if (startWithComputer !== null) autostart.set(startWithComputer);
  listenToZ();
  buildMenu();
  buildIconMenu();
  span = createSpan({
    screen,
    platform: process.platform,
    env: process.env,
    prefs,
    savePrefs,
    restart: () => {
      app.relaunch({ args: restartArgs(process.argv) });
      app.quit();
    },
  });
  // Span mode is the whole extend: no Z per display (way A) and no blank windows per display (way B) in this run.
  if (!span.active()) startExtend();
  const moveDeps = {
    screen,
    newToken: () => randomBytes(16).toString('hex'),
    isLocked: () => lockMirror.get().locked,
    profileOf: () => lockMirror.get().profile,
    senderDisplay: (wc) => (zView && wc === zView.webContents ? mainDisplayId() : desks ? desks.displayOf(wc) : null),
    targetOf: (id) =>
      id === mainDisplayId() ? (zView && !zView.webContents.isDestroyed() ? zView.webContents : null) : desks ? desks.webContentsOf(id) : null,
  };
  windowMove = createWindowMove(moveDeps);
  windowLive = createWindowLive(moveDeps);
  // Windows locked (Win+L, which no app can catch): Z's own window locks Z too (O 27.11). Only where the key is Z's.
  if (winKeys.supported) {
    powerMonitor.on('lock-screen', () => {
      if (prefs.winKeys !== false && zView && !zView.webContents.isDestroyed()) zView.webContents.send('zd:keys:oslock');
    });
  }
  app.on('browser-window-focus', checkFocus);
  app.on('browser-window-blur', checkFocus);
  createWindow();
  startDisplays();
  if (process.argv.includes(RESET_ARG)) resetPermissions();
  if (process.argv.includes(UPDATE_ARG)) updates.checkNow();
  updates.start();

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

// Closing the window quits Z (staying in the tray comes in a later layer).
app.on('window-all-closed', () => app.quit());
