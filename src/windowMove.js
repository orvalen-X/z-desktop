'use strict';

// Extend, way A, layer 4: a window dragged off one display opens on the display under the cursor.
// Every display runs its own Z, so a window cannot cross by itself: the Z it leaves describes it (the app, its window
// key, its params, its title, its size and where it was held) and asks for it here. This file checks the request and
// hands the description to the Z on the display under the cursor, which opens the same window there; the Z it left
// closes its own only when this says it was delivered.
// - The target is the display under the system cursor (asked here, never taken from the page), and must be another
//   display than the sender's, with a Z on it.
// - Nothing moves while Z is locked (the shared lock of layer 3): not knowing means locked.
// - The description is checked and copied field by field: an app id, a window key and a title as short strings,
//   params as plain JSON up to 32 KB, numbers inside fixed ranges. Nothing else crosses.

const APP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_PARAMS = 32 * 1024;

function shortText(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}
function within(v, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;
}

// The window as the target Z will get it, or null when the description is not acceptable.
function cleanWindow(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const appId = typeof spec.appId === 'string' && APP_RE.test(spec.appId) ? spec.appId : null;
  if (!appId) return null;
  let params = null;
  if (spec.params !== undefined && spec.params !== null) {
    let text;
    try {
      text = JSON.stringify(spec.params);
    } catch {
      return null;
    }
    if (typeof text !== 'string' || text.length > MAX_PARAMS) return null;
    params = JSON.parse(text);
    if (!params || typeof params !== 'object') return null;
  }
  const w = within(spec.w, 120, 16000);
  const h = within(spec.h, 80, 16000);
  const grabX = within(spec.grabX, -16000, 16000);
  const grabY = within(spec.grabY, -16000, 16000);
  return {
    appId,
    windowKey: shortText(spec.windowKey, 300),
    title: shortText(spec.title, 300),
    params,
    w,
    h,
    grabX: grabX === null ? 0 : grabX,
    grabY: grabY === null ? 0 : grabY,
  };
}

function createWindowMove({ screen, isLocked, senderDisplay, targetOf }) {
  // From a Z (main.js checks fromZ). Returns { ok } : ok only when the window was handed to another display's Z.
  function send(sender, spec) {
    if (isLocked()) return { ok: false };
    const win = cleanWindow(spec);
    if (!win) return { ok: false };
    const from = senderDisplay(sender);
    if (from == null) return { ok: false };
    let point;
    let display;
    try {
      point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    } catch {
      return { ok: false };
    }
    if (!display || String(display.id) === String(from)) return { ok: false };
    const b = display.bounds;
    if (point.x < b.x || point.y < b.y || point.x >= b.x + b.width || point.y >= b.y + b.height) return { ok: false };
    const wc = targetOf(String(display.id));
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return { ok: false };
    // Where the cursor is on that display, in its own coordinates (Z places the window so it stays under the hand).
    wc.send('zd:window:receive', { ...win, x: point.x - b.x, y: point.y - b.y });
    return { ok: true };
  }
  return { send };
}

module.exports = { createWindowMove, cleanWindow, MAX_PARAMS };
