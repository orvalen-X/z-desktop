'use strict';

// Extend, way A (O 26.11 "Z מלא בכל מסך"): every extra display runs a whole Z of its own. It is the same Z, the same
// account and the same session as Z's own window, so every app works there exactly as it does on the main display.
// Moving a window between displays reopens it on the other one (Z does that, a later layer).
// This file only keeps one such window per extra display, and keeps them in step with Z's own window:
// - Z's own page turns it on or off (Settings > Displays > Multiple displays). Off: no extra windows.
// - The display Z's own window is on gets none. A display that comes gets one, a display that goes takes its window.
// - Full screen together: Z's own window enters or leaves full screen, every display does the same.
// - While Z has the focus, its windows sit above the system's taskbar (Windows and Linux draw it over a full-screen
//   window that is not the active one). On Windows each window keeps its taskbar entry, grouped under Z's button:
//   the taskbar steps aside only for a full-screen window it knows.
// - A window the person closes stays closed until the displays change or extend is turned on again.
// - A window whose Z crashed loads again (up to 3 times); one that could not load tries again after 5 seconds.
// Each window loads Z's own address with the same preload, which tells Z the display it is on (--z-desktop-display).
// Navigation and new windows are guarded like Z's own view (guardContents runs for every web contents).
// Nothing here changes the system's own display settings.

const MAX_CRASHES = 3;
const RETRY_MS = 5000;

function createDesks({ BrowserWindow, screen, isMac, isWin, webPreferences, startUrl, userAgent, mainDisplayId, onCreate }) {
  const open = new Map(); // displayId -> window
  const closedByPerson = new Set();
  const closingByUs = new WeakSet();
  let enabled = false;
  let full = true; // Z's own window opens full screen
  let active = false;
  const LIFT = !isMac;

  const displays = () => screen.getAllDisplays();
  const findDisplay = (id) => displays().find((d) => String(d.id) === String(id)) || null;

  function lift(w, on) {
    if (!LIFT || !w || w.isDestroyed()) return;
    try {
      w.setAlwaysOnTop(on, 'screen-saver');
    } catch {
      /* the window is closing */
    }
  }

  // Full screen: the whole display. Not full screen: the display's work area (the taskbar or Dock shows).
  function cover(w, id) {
    if (!w || w.isDestroyed()) return;
    if (full) {
      if (isMac) w.setSimpleFullScreen(true);
      else w.setFullScreen(true);
      return;
    }
    if (isMac) w.setSimpleFullScreen(false);
    else w.setFullScreen(false);
    const d = findDisplay(id);
    if (d) w.setBounds({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height });
  }

  function shut(id) {
    const w = open.get(id);
    open.delete(id);
    if (w && !w.isDestroyed()) {
      closingByUs.add(w);
      w.destroy();
    }
  }

  function make(d) {
    const id = String(d.id);
    const b = d.bounds;
    const w = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      show: false,
      fullscreenable: true,
      minimizable: false,
      maximizable: false,
      skipTaskbar: !isWin,
      autoHideMenuBar: true,
      backgroundColor: '#2b2b2d',
      title: 'Z',
      webPreferences: webPreferences(id),
    });
    open.set(id, w);
    if (userAgent) w.webContents.setUserAgent(userAgent);
    w.once('ready-to-show', () => {
      if (w.isDestroyed()) return;
      // Shown without taking the focus from where the person is working.
      w.showInactive();
      cover(w, id);
      if (active && full) lift(w, true);
    });
    // A display whose Z crashed or could not load must not stay a frozen or empty window over that display:
    // it loads again (a crash up to 3 times; after that it closes until the displays change or extend is switched).
    let crashes = 0;
    w.webContents.on('render-process-gone', () => {
      if (w.isDestroyed() || open.get(id) !== w) return;
      crashes += 1;
      if (crashes > MAX_CRASHES) shut(id);
      else w.webContents.reload();
    });
    w.webContents.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
      // -3 = a navigation was replaced by another one: not a failure.
      if (!isMainFrame || code === -3) return;
      setTimeout(() => {
        if (!w.isDestroyed() && open.get(id) === w) w.loadURL(startUrl);
      }, RETRY_MS);
    });
    w.on('closed', () => {
      if (open.get(id) === w) open.delete(id);
      if (!closingByUs.has(w) && enabled) closedByPerson.add(id);
    });
    if (typeof onCreate === 'function') onCreate(w, id);
    w.loadURL(startUrl);
    return w;
  }

  // Open what is wanted, close what is not. Runs on every display change, main-display change and switch.
  function sync() {
    const all = displays();
    const ids = new Set(all.map((d) => String(d.id)));
    for (const id of Array.from(closedByPerson)) if (!ids.has(id)) closedByPerson.delete(id);
    const mainId = mainDisplayId();
    const want = new Set(enabled && mainId != null ? all.map((d) => String(d.id)).filter((id) => id !== String(mainId)) : []);
    for (const id of Array.from(open.keys())) if (!want.has(id)) shut(id);
    for (const d of all) {
      const id = String(d.id);
      if (!want.has(id) || open.has(id) || closedByPerson.has(id)) continue;
      make(d);
    }
  }

  function setEnabled(on) {
    const next = on === true;
    if (next && !enabled) closedByPerson.clear();
    enabled = next;
    sync();
    return enabled;
  }

  function followFullScreen(on) {
    if (!!on === full) return;
    full = !!on;
    for (const [id, w] of open) {
      cover(w, id);
      lift(w, active && full);
    }
  }

  function setActive(on) {
    active = !!on;
    for (const w of open.values()) lift(w, active && full);
  }

  function closeAll() {
    for (const id of Array.from(open.keys())) shut(id);
  }

  // Which display a web contents belongs to (its top page is a Z on that display), or null.
  function displayOf(wc) {
    for (const [id, w] of open) if (!w.isDestroyed() && w.webContents === wc) return id;
    return null;
  }

  // The web contents of the Z on a display, or null.
  function webContentsOf(id) {
    const w = open.get(String(id));
    return w && !w.isDestroyed() && !w.webContents.isDestroyed() ? w.webContents : null;
  }

  const owns = (w) => {
    for (const x of open.values()) if (x === w) return true;
    return false;
  };

  function each(fn) {
    for (const [id, w] of open) if (!w.isDestroyed() && !w.webContents.isDestroyed()) fn(w.webContents, id);
  }

  return {
    sync,
    setEnabled,
    enabled: () => enabled,
    followFullScreen,
    setActive,
    closeAll,
    displayOf,
    webContentsOf,
    owns,
    each,
    count: () => open.size,
  };
}

module.exports = { createDesks };
