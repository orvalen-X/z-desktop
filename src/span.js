'use strict';

// One Z across all displays (span mode, layer 0 of the plan, O 27.11 "Z אחד על כל המסכים").
// Way A opens a whole Z on every extra display, so a window that crosses to another display has to open again there
// (O's test 27.11: "פתאום מקפיץ כמו פתיחה של האפליקציה"). Here there is one Z window, as big as all the displays
// together: a window inside Z crosses from one display to the next the way it moves anywhere else on the page.
// - Off by default. The person turns it on in Z (Settings > Displays); it takes effect when Z starts again, so a run is
//   always one mode from start to end (Z restarts by itself after the switch).
// - Windows and Linux on X11 only. Mac keeps a Space per display by default and Wayland does not let an app place its
//   window, so there the switch is not offered.
// - Full screen: the window covers every display and, while Z has the focus, sits above the system's taskbars.
//   Out of full screen: it covers the work areas (the taskbars show), and never sits above other apps.
// - Display facts stay on this computer: nothing here is sent anywhere.

const MAX_DISPLAYS = 16;

function spanSupported(platform, env) {
  if (platform === 'win32') return true;
  if (platform !== 'linux') return false;
  return String((env && env.XDG_SESSION_TYPE) || '').toLowerCase() !== 'wayland';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
function rect(r) {
  const out = { x: num(r && r.x), y: num(r && r.y), width: num(r && r.width), height: num(r && r.height) };
  return [out.x, out.y, out.width, out.height].every(Number.isFinite) && out.width > 0 && out.height > 0 ? out : null;
}

// The smallest rectangle around all the displays (key 'bounds' or 'workArea'), in DIP. null when there is none.
function unionOf(displays, key) {
  const list = Array.isArray(displays) ? displays.slice(0, MAX_DISPLAYS) : [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const d of list) {
    const r = rect(d && d[key]);
    if (!r) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

function createSpan({ screen, platform, env, prefs, savePrefs, restart, setTimer = setTimeout }) {
  const supported = spanSupported(platform, env);
  // The mode of this run, read once at start.
  const active = supported && prefs.span === true;
  let full = true; // Z opens full screen
  let restarting = false;

  function area() {
    let list = [];
    try {
      list = screen.getAllDisplays();
    } catch {
      return null;
    }
    return unionOf(list, full ? 'bounds' : 'workArea') || unionOf(list, 'bounds');
  }

  // Where Z's window goes now (null: not span mode, or no display known).
  function bounds() {
    return active ? area() : null;
  }

  function get() {
    return { supported, on: supported && prefs.span === true, active };
  }

  // From Z's own window only (main.js checks). Saves the choice; when it changes the mode, Z starts again.
  function set(on) {
    if (!supported || typeof on !== 'boolean') return { ...get(), restarting: false };
    if (prefs.span !== on) {
      prefs.span = on;
      savePrefs();
    }
    if (on !== active && !restarting) {
      restarting = true;
      // a moment, so Z's page gets this answer before the app goes
      setTimer(() => restart(), 400);
    }
    return { ...get(), restarting };
  }

  return {
    active: () => active,
    get,
    set,
    bounds,
    full: () => full,
    setFull: (on) => {
      full = on === true;
      return full;
    },
  };
}

module.exports = { createSpan, spanSupported, unionOf };
