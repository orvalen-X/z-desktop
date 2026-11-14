'use strict';

const { app, BrowserWindow, Menu, dialog, shell, session, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const cfg = require('./config');
const i18n = require('./i18n');

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
let prefs = { lang: null };

// ---------- small preferences file (only the language the person chose in Z) ----------

function prefsPath() {
  return path.join(app.getPath('userData'), 'z-desktop.json');
}
function loadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
    if (p && typeof p.lang === 'string') prefs.lang = p.lang;
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

function hardenSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    callback(cfg.isAppUrl(origin) && cfg.ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return cfg.isAppUrl(requestingOrigin) && cfg.ALLOWED_PERMISSIONS.has(permission);
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
  // Navigation inside the window: only Z and its sign-in service.
  const onNavigate = (event, url) => {
    if (url.split('?')[0] === OFFLINE_URL) return;
    if (cfg.isInWindowUrl(url)) return;
    event.preventDefault();
    if (cfg.isGoogleSignIn(url)) explainGoogle();
    else openOutside(url);
  };
  wc.on('will-navigate', onNavigate);
  wc.on('will-redirect', onNavigate);

  // New windows: Z's own pages and blank print windows stay in Z, everything else opens in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '' || cfg.isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#2b2b2d',
          webPreferences: secureWebPreferences(false),
        },
      };
    }
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

// ---------- app life ----------

app.on('second-instance', () => {
  if (!win) return;
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
  createWindow();

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

// Closing the window quits Z (staying in the tray comes in a later layer).
app.on('window-all-closed', () => app.quit());
