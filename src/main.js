'use strict';

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, dialog, shell, session, net, ipcMain, nativeTheme, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const cfg = require('./config');
const i18n = require('./i18n');
const { createPermissions } = require('./permissions');
const { createUpdates, RELEASES_API } = require('./updates');
const { createAutostart, autostartFromArgs } = require('./autostart');
const { createDisplays } = require('./displays');
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
          additionalArguments: [`--z-desktop-version=${app.getVersion()}`, `--z-desktop-release=${RELEASE_NAME}`],
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

const isFullscreen = () => !!win && !win.isDestroyed() && win.isFullScreen();

function barColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#1c1f26' : '#eef1f5', symbolColor: dark ? '#e9edf3' : '#1b2028', height: BAR_HEIGHT };
}

// Full screen: Z fills everything. Outside it: the window bar on top and Z below, never on top of each other.
function layout() {
  if (!win || win.isDestroyed() || !zView) return;
  const { width, height } = win.getContentBounds();
  const bar = isFullscreen() ? 0 : BAR_HEIGHT;
  barView.setVisible(bar > 0);
  barView.setBounds({ x: 0, y: 0, width, height: bar });
  zView.setBounds({ x: 0, y: bar, width, height: Math.max(0, height - bar) });
}

function tellZ() {
  if (zView && !zView.webContents.isDestroyed()) zView.webContents.send('zd:fs', isFullscreen());
}

// The one way full screen changes: F11, the Mac menu, and the top-bar button in Z all come here.
// Leaving full screen gives a maximized window (O 26.11: Z keeps its size, the system's bars appear around it).
function setFullscreen(on) {
  if (!win || win.isDestroyed()) return false;
  if (on !== isFullscreen()) win.setFullScreen(on);
  return on;
}
function toggleFullscreen() {
  return setFullscreen(!isFullscreen());
}

// ---------- requests from Z's page ----------

// Only Z's own page may ask: the top frame of the Z view, on Z's address. App frames inside Z never get here
// (the preload runs only in the top frame), and this check refuses them even if they tried.
function fromZ(event) {
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
const NO_DISPLAYS = { displays: [], system: { platform: process.platform, wayland: false, canOpenSettings: false, canChange: false } };
function sendDisplays(snap) {
  if (zView && !zView.webContents.isDestroyed()) zView.webContents.send('zd:displays', snap);
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
    send: sendDisplays,
  });
  displays.listen();
}

function listenToZ() {
  ipcMain.handle('zd:fs:get', (e) => (fromZ(e) ? isFullscreen() : false));
  ipcMain.handle('zd:fs:set', (e, on) => (fromZ(e) && typeof on === 'boolean' ? setFullscreen(on) : isFullscreen()));
  ipcMain.handle('zd:fs:toggle', (e) => (fromZ(e) ? toggleFullscreen() : isFullscreen()));
  ipcMain.handle('zd:autostart:get', (e) => (fromZ(e) ? autostart.get() : { supported: false, enabled: false }));
  ipcMain.handle('zd:autostart:set', (e, on) =>
    fromZ(e) && typeof on === 'boolean' ? autostart.set(on) : { supported: false, enabled: false },
  );
  ipcMain.handle('zd:displays:get', (e) => (fromZ(e) && displays ? displays.snapshot() : NO_DISPLAYS));
  // Identify windows open only when Z asks (never at start: Z Setup waits for Z's first visible window).
  ipcMain.handle('zd:displays:identify', (e) => (fromZ(e) && displays ? displays.identify() : { shown: 0 }));
  ipcMain.handle('zd:displays:settings', (e) => (fromZ(e) && displays ? displays.openSystemSettings() : { opened: false }));
}

// ---------- the Z window ----------

function createWindow() {
  win = new BaseWindow({
    width: 1440,
    height: 900,
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

  barView = new WebContentsView({ webPreferences: secureWebPreferences(false) });
  barView.setBackgroundColor(barColors().color);
  barView.webContents.loadFile(TITLEBAR_FILE, { query: { name: RELEASE_NAME || app.getVersion() } });
  barView.webContents.on('will-navigate', (event) => event.preventDefault());

  zView = new WebContentsView({ webPreferences: secureWebPreferences(true) });
  zView.setBackgroundColor('#2b2b2d');
  zView.webContents.setUserAgent(userAgent());

  win.contentView.addChildView(zView);
  win.contentView.addChildView(barView);
  layout();

  // Show once Z has something to paint (or after a moment, so a slow network never hides the window).
  let shown = false;
  const show = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
    zView.webContents.focus();
  };
  zView.webContents.once('dom-ready', show);
  zView.webContents.once('did-fail-load', show);
  setTimeout(show, 3000);

  win.on('resize', layout);
  win.on('enter-full-screen', () => {
    layout();
    tellZ();
  });
  win.on('leave-full-screen', () => {
    if (!win.isMaximized()) win.maximize();
    layout();
    tellZ();
  });
  win.on('focus', () => zView && !zView.webContents.isDestroyed() && zView.webContents.focus());

  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    barView.setBackgroundColor(barColors().color);
    if (!isMac) win.setTitleBarOverlay(barColors());
  });

  // F11 everywhere (and Ctrl+Cmd+F on Mac through the menu) switches full screen.
  zView.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control && !input.meta) {
      event.preventDefault();
      toggleFullscreen();
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
  win.on('moved', () => displays && displays.changed());
  win.on('closed', () => {
    if (displays) displays.closeIdentify();
    // Views are not closed with the window: close them, so nothing keeps running.
    for (const v of [zView, barView]) if (v && !v.webContents.isDestroyed()) v.webContents.close();
    win = null;
    zView = null;
    barView = null;
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
  const startWithComputer = autostartFromArgs(argv);
  if (startWithComputer !== null) autostart.set(startWithComputer);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Every page, window and frame gets the same guards, once.
app.on('web-contents-created', (event, wc) => guardContents(wc));

app.whenReady().then(() => {
  app.userAgentFallback = userAgent();
  loadPrefs();
  // The file also marks this folder as Z's: the Windows uninstaller deletes the folder only when it finds it.
  if (!fs.existsSync(prefsPath())) savePrefs();
  hardenSession(session.defaultSession);
  // The installer passes the person's "start with the computer" checkbox once, on the first start.
  const startWithComputer = autostartFromArgs(process.argv);
  if (startWithComputer !== null) autostart.set(startWithComputer);
  listenToZ();
  buildMenu();
  buildIconMenu();
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
