'use strict';

// Extend (multi-monitor, O 26.11 "2+3 together", way B): ONE Z spans all displays. Z's page opens one plain window
// per extra display and draws on it itself (wallpaper, top bar, later its windows), like a second screen of the
// same desk. This file only lets that happen safely:
// - A blank window is allowed ONLY with a one-time name that Z's own page asked for a moment ago (the name is
//   random, single use and expires). Every other blank window stays refused (a third-party frame inside Z could fill
//   one with a fake sign-in form).
// - The window covers its display and nothing else: no address, no navigation, no new windows, no preload.
// - Z's own window can move to the display the person chooses ("Main display", the Dock goes with it); the choice is
//   remembered on this computer only.
// - The displays follow Z's own window: full screen together, out of full screen together.
// - On Windows the window keeps its taskbar entry: the taskbar steps aside only for a full-screen window it knows.
// - While Z has the focus, its windows sit above the system's taskbar on every display (Windows and Linux draw the
//   taskbar over a full-screen window that is not the active one). Another app taking the focus lets it back.
// Nothing here changes the system's own display settings.

const NAME_PREFIX = 'zsurface-';
const NAME_TTL_MS = 10000;
const NAME_RE = /^zsurface-[0-9a-f]{32}$/;

function createSurfaces({ screen, randomBytes, now, isMac, isWin, prefs, savePrefs, later }) {
  const clock = now || Date.now;
  // One turn later: on Windows Electron sends enter-full-screen and leave-full-screen BEFORE the window changes
  // (NativeWindowViews::SetFullScreen notifies first, then calls widget()->SetFullscreen in the same call), so work
  // that needs the changed window runs right after that call, not inside the event (same as winKeys.js).
  const afterChange = later || ((f) => setTimeout(f, 0));
  const pending = new Map(); // name -> { displayId, at }
  const opening = new Map(); // name -> displayId, between the open handler and did-create-window
  const open = new Map(); // displayId -> window
  let active = false; // one of Z's windows has the focus
  let moving = false; // Z's own window is on its way to another display
  let full = true; // Z's own window is full screen (installed Z opens full screen); the other displays follow it
  const LIFT = !isMac; // Mac: the old-style full screen already hides the menu bar and the Dock there

  function lift(w, on) {
    if (!LIFT || !w || w.isDestroyed()) return;
    try {
      w.setAlwaysOnTop(on, 'screen-saver');
    } catch {
      /* the window is closing */
    }
  }

  // Z gained or lost the focus. mainWin is lifted too, but only in full screen (a framed window keeps its taskbar).
  function setActive(on, mainWin) {
    active = !!on;
    for (const w of open.values()) lift(w, active && full);
    if (mainWin && !mainWin.isDestroyed()) lift(mainWin, active && mainWin.isFullScreen());
  }

  const owns = (w) => {
    for (const x of open.values()) if (x === w) return true;
    return false;
  };

  const findDisplay = (id) => screen.getAllDisplays().find((d) => String(d.id) === String(id)) || null;

  function sweep() {
    const t = clock();
    for (const [name, p] of pending) if (t - p.at > NAME_TTL_MS) pending.delete(name);
  }

  // Z asks for a window on a display: a one-time name it must pass to window.open within a few seconds.
  function prepare(displayId) {
    sweep();
    const d = findDisplay(displayId);
    if (!d) return null;
    const name = NAME_PREFIX + randomBytes(16).toString('hex');
    pending.set(name, { displayId: String(d.id), at: clock() });
    return { name };
  }

  // The window-open handler asks: is this blank window one Z prepared? Returns the window's options, or null.
  function claim(frameName, webPreferences) {
    sweep();
    if (typeof frameName !== 'string' || !NAME_RE.test(frameName)) return null;
    const p = pending.get(frameName);
    if (!p) return null;
    pending.delete(frameName);
    const d = findDisplay(p.displayId);
    if (!d) return null;
    opening.set(frameName, p.displayId);
    const b = d.bounds;
    return {
      displayId: p.displayId,
      options: {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        frame: false,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: true,
        // Windows hides its taskbar over a full-screen window only when the taskbar knows that window, so there it
        // keeps its taskbar entry (grouped under Z's own button). Elsewhere it stays out of the taskbar.
        skipTaskbar: !isWin,
        autoHideMenuBar: true,
        backgroundColor: '#2b2b2d',
        title: 'Z',
        webPreferences,
      },
    };
  }

  // did-create-window names the window by the same one-time name: which display it was made for (once).
  function displayOfOpening(frameName) {
    const id = typeof frameName === 'string' ? opening.get(frameName) : undefined;
    if (id === undefined) return null;
    opening.delete(frameName);
    return id;
  }

  // The window exists: lock it down, cover its display, and remember it (one per display).
  function adopt(w, displayId) {
    const prev = open.get(displayId);
    if (prev && prev !== w && !prev.isDestroyed()) prev.destroy();
    open.set(displayId, w);
    const wc = w.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Shown without taking the focus from where the person is working.
    w.showInactive();
    cover(w, displayId);
    if (active && full) lift(w, true);
    w.on('closed', () => {
      if (open.get(displayId) === w) open.delete(displayId);
    });
  }

  // Full screen: the whole display (Mac: the old-style full screen keeps the window on its display without a new
  // Space). Not full screen: the display's work area, so the system's taskbar or Dock shows, like Z's own window.
  function cover(w, displayId) {
    if (!w || w.isDestroyed()) return;
    if (full) {
      if (isMac) w.setSimpleFullScreen(true);
      else w.setFullScreen(true);
      return;
    }
    if (isMac) w.setSimpleFullScreen(false);
    else w.setFullScreen(false);
    const d = findDisplay(displayId);
    if (d) w.setBounds({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height });
  }

  // Z's own window entered or left full screen: every display does the same (not while it moves to another display).
  function followFullScreen(on) {
    if (moving || !!on === full) return;
    full = !!on;
    for (const [id, w] of open) {
      cover(w, id);
      lift(w, active && full);
    }
  }

  // A display went away: its window goes too. Z hears the change and stops drawing there.
  function prune() {
    const ids = new Set(screen.getAllDisplays().map((d) => String(d.id)));
    for (const [id, w] of open) {
      if (!ids.has(id)) {
        if (!w.isDestroyed()) w.destroy();
        open.delete(id);
      }
    }
  }

  // Z's page reloaded or left: the windows it drew on are closed (the new page opens its own).
  function closeAll() {
    pending.clear();
    opening.clear();
    for (const w of open.values()) if (!w.isDestroyed()) w.destroy();
    open.clear();
  }

  // ---- the main display: where Z's own window (and its Dock) lives ----

  function savedMain() {
    const id = prefs.mainDisplay;
    return typeof id === 'string' && findDisplay(id) ? findDisplay(id) : null;
  }

  // Where Z's window should start: the remembered display, if it is still connected.
  function startBounds() {
    const d = savedMain();
    if (!d) return null;
    const a = d.workArea;
    return { x: a.x, y: a.y, width: a.width, height: a.height };
  }

  // Move Z's window to a display and remember the choice. Full screen stays full screen. Already there: nothing moves.
  // The window is see-through while it travels, so the person sees one jump, not the steps in between.
  function moveMain(win, displayId) {
    const d = findDisplay(displayId);
    if (!d || !win || win.isDestroyed()) return { ok: false };
    prefs.mainDisplay = String(d.id);
    savePrefs();
    const here = typeof screen.getDisplayMatching === 'function' ? screen.getDisplayMatching(win.getBounds()) : null;
    if (here && String(here.id) === String(d.id)) return { ok: true };
    const a = d.workArea;
    const fade = (v) => {
      try {
        if (!win.isDestroyed()) win.setOpacity(v);
      } catch {
        /* not supported here */
      }
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      moving = false;
      fade(1);
    };
    const place = () => {
      if (win.isDestroyed()) return;
      if (win.isMaximized()) win.unmaximize();
      win.setBounds({ x: a.x, y: a.y, width: a.width, height: a.height });
    };
    moving = true;
    fade(0);
    if (win.isFullScreen()) {
      // Placed only once the window has really left full screen: inside the event (Windows) the system still restores
      // the old bounds after it, so Z went back full screen on the display it came from while the choice was saved
      // (O 28.11: "Main display only", Display 1 chosen, Z opens on Display 2).
      win.once('leave-full-screen', () =>
        afterChange(() => {
          if (win.isDestroyed()) return finish();
          place();
          win.once('enter-full-screen', () => afterChange(finish));
          win.setFullScreen(true);
        }),
      );
      // Whatever the system does, the window never stays invisible.
      setTimeout(finish, 2000);
      win.setFullScreen(false);
    } else {
      place();
      win.maximize();
      finish();
    }
    return { ok: true };
  }

  return {
    prepare,
    claim,
    displayOfOpening,
    adopt,
    prune,
    closeAll,
    startBounds,
    moveMain,
    setActive,
    followFullScreen,
    owns,
    moving: () => moving,
    count: () => open.size,
  };
}

module.exports = { createSurfaces, NAME_PREFIX, NAME_TTL_MS };
