'use strict';

const { app, BrowserWindow, Menu, dialog, shell, session, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const cfg = require('./config');
const i18n = require('./i18n');
const { createPermissions } = require('./permissions');
const { createUpdates, RELEASES_API } = require('./updates');

// One Z per computer: a second launch focuses the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const isMac = process.platform === 'darwin';
// Reconnect attempts: quick at first, then calmer while the site stays unreachable.
const RETRY_STEPS_MS = [5000, 10000, 20000, 30000];
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const OFFLINE_URL = pathToFileURL(OFFLINE_FILE).href;

let win = null;
let offline = false;
let retryTimer = null;
let prefs = { lang: null, perms: {}, updSkipped: null };
const RESET_ARG = '--reset-permissions';
const UPDATE_ARG = '--check-updates';

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

// ---------- security for everything that loads ----------

function askPermission(origin, kinds) {
  const s = t();
  const names = kinds.map((k) => s['perm' + k[0].toUpperCase() + k.slice(1)]);
  const what = names.join(s.permJoin);
  return dialog
    .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question',
      title: 'Z',
      message: s.permAsk.replace('{what}', what),
      detail: `${new URL(origin).host}\n\n${s.permDetail}`,
      buttons: [s.permAllow, s.permDeny],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => response === 0);
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
  dialog
    .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question',
      title: s.resetTitle,
      message: s.resetTitle,
      detail: s.resetBody,
      buttons: [s.resetConfirm, s.cancel],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      permissions.reset();
      // Reload so any camera or microphone already in use is released.
      if (win && !win.isDestroyed() && !offline) win.webContents.reload();
    });
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl || wc.getURL();
    permissions
      .request(url, permission, details)
      .then(callback)
      .catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return permissions.check(requestingOrigin, permission, details);
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
  dialog
    .showMessageBox(win, {
      type: 'info',
      title: s.googleTitle,
      message: s.googleTitle,
      detail: s.googleBody,
      buttons: [s.ok, s.googleOpenBrowser],
      defaultId: 0,
      cancelId: 0,
    })
    .then(({ response }) => {
      if (response === 1) openOutside(cfg.START_URL);
    });
}

function guardContents(wc) {
  // Navigation inside the window: only Z.
  const onNavigate = (event, url) => {
    if (url.split('?')[0] === OFFLINE_URL) return;
    if (cfg.isInWindowUrl(url)) return;
    event.preventDefault();
    if (cfg.isGoogleSignIn(url)) explainGoogle();
    else openOutside(url);
  };
  wc.on('will-navigate', onNavigate);
  wc.on('will-redirect', onNavigate);

  // New windows: Z's own pages stay in Z, everything else opens in the browser.
  // Blank windows are refused: Electron cannot tell whether Z or a third-party frame inside Z opened one
  // (the referrer is empty for both), and a blank window can be filled with a fake sign-in form.
  wc.setWindowOpenHandler(({ url }) => {
    const blank = url === 'about:blank' || url === '';
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

function secureWebPreferences(withPreload) {
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
          additionalArguments: [`--z-desktop-version=${app.getVersion()}`],
        }
      : {}),
  };
}

// ---------- updates of the app itself ----------

function ask(type, message, detail, buttons) {
  return dialog
    .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type,
      title: 'Z',
      message,
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    })
    .then(({ response }) => response);
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

// ---------- offline screen ----------

function showOffline() {
  if (!win || win.isDestroyed()) return;
  offline = true;
  const s = t();
  win.loadFile(OFFLINE_FILE, {
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
  win.loadURL(cfg.START_URL);
}

// ---------- the Z window ----------

function rememberZLanguage() {
  if (!win || win.isDestroyed() || !cfg.isAppUrl(win.webContents.getURL())) return;
  win.webContents
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

function toggleFullscreen() {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(!win.isFullScreen());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    fullscreen: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#2b2b2d',
    title: 'Z',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: secureWebPreferences(true),
  });

  win.webContents.setUserAgent(userAgent());

  win.once('ready-to-show', () => win.show());

  // F11 everywhere (and Ctrl+Cmd+F on Mac through the menu) switches full screen.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control && !input.meta) {
      event.preventDefault();
      toggleFullscreen();
    }
  });

  win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    // -3 = a navigation was replaced by another one: not a failure.
    if (isMainFrame && code !== -3 && cfg.isInWindowUrl(url)) showOffline();
  });
  win.webContents.on('did-navigate', (event, url) => {
    if (cfg.isInWindowUrl(url)) {
      offline = false;
      retryStep = 0;
      clearTimeout(retryTimer);
    }
  });
  win.webContents.on('did-finish-load', rememberZLanguage);
  win.webContents.on('did-navigate-in-page', rememberZLanguage);

  win.on('closed', () => {
    win = null;
    clearTimeout(retryTimer);
  });

  if (net.isOnline()) loadZ();
  else showOffline();
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
        { label: s.menuReload, accelerator: 'Cmd+R', click: () => (offline ? loadZ() : win && win.webContents.reload()) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: s.menuFullscreen },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
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
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Every page, window and frame gets the same guards, once.
app.on('web-contents-created', (event, wc) => guardContents(wc));

app.whenReady().then(() => {
  app.userAgentFallback = userAgent();
  loadPrefs();
  hardenSession(session.defaultSession);
  buildMenu();
  buildIconMenu();
  createWindow();
  if (process.argv.includes(RESET_ARG)) resetPermissions();
  if (process.argv.includes(UPDATE_ARG)) updates.checkNow();
  updates.start();

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

// Closing the window quits Z (staying in the tray comes in a later layer).
app.on('window-all-closed', () => app.quit());
