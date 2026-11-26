'use strict';

// Extend, way A, layer 4: a window dragged off one display opens on the display under the cursor.
// Every display runs its own Z, so a window cannot cross by itself: the Z it leaves describes it (the app, its window
// key, its params, its title, its size and where it was held) and asks for it here. This file checks the request and
// hands the description to the Z on the display under the cursor, which opens the same window there; the Z it left
// closes its own only when that Z answers that the window is open (r2 below).
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

// r2 (Audit M1): "sent" is not "arrived". The window here closes only when the Z on the other display says it opened it.
// - Every move gets a one-time token from here. The target answers with it (zd:window:arrived) once the window is on
//   its desk, or refuses. Only the Z it was sent to can answer, and only once.
// - No answer within ARRIVE_MS: the move failed and the window stays where it was let go. An answer that comes later
//   is told so, and the target closes the window it opened for it, so the window is never on both displays.
// - Audit S1: one move in flight per sender, and at most one move per MIN_GAP_MS from it (5 a second).
const ARRIVE_MS = 3000;
const MIN_GAP_MS = 200;

function createWindowMove({ screen, isLocked, profileOf, senderDisplay, targetOf, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, newToken }) {
  const waiting = new Map(); // token -> { target, finish }
  const inFlight = new Set(); // senders with a move that was not answered yet
  const lastSend = new Map(); // sender -> when it last sent
  const no = () => Promise.resolve({ ok: false });

  // From a Z (main.js checks fromZ). Resolves { ok } : ok only when the Z on another display opened the window.
  function send(sender, spec) {
    if (isLocked()) return no();
    // Closure-old S3: the profile Z was unlocked by travels from here (never from the page); a desk of anyone else refuses.
    const profile = typeof profileOf === 'function' ? profileOf() : null;
    if (typeof profile !== 'string' || !profile) return no();
    if (inFlight.has(sender)) return no();
    const last = lastSend.get(sender);
    if (last !== undefined && now() - last < MIN_GAP_MS) return no();
    const win = cleanWindow(spec);
    if (!win) return no();
    const from = senderDisplay(sender);
    if (from == null) return no();
    let point;
    let display;
    try {
      point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    } catch {
      return no();
    }
    if (!display || String(display.id) === String(from)) return no();
    const b = display.bounds;
    if (point.x < b.x || point.y < b.y || point.x >= b.x + b.width || point.y >= b.y + b.height) return no();
    const wc = targetOf(String(display.id));
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return no();
    lastSend.set(sender, now());
    const token = newToken();
    return new Promise((resolve) => {
      let timer = null;
      const finish = (ok) => {
        if (!waiting.has(token)) return;
        waiting.delete(token);
        inFlight.delete(sender);
        if (timer !== null) clearTimer(timer);
        resolve({ ok });
      };
      waiting.set(token, { target: wc, finish });
      inFlight.add(sender);
      timer = setTimer(() => finish(false), ARRIVE_MS);
      try {
        // Where the cursor is on that display, in its own coordinates (Z places the window so it stays under the hand).
        wc.send('zd:window:receive', { ...win, x: point.x - b.x, y: point.y - b.y, token, profile });
      } catch {
        finish(false);
      }
    });
  }

  // From the Z the window was sent to: opened (ok true) or refused. Returns { ok } : ok when the answer was still awaited.
  // ok false after opened = too late or not this Z's to answer: the target closes the window it opened.
  function arrived(sender, answer) {
    const token = answer && typeof answer.token === 'string' ? answer.token : null;
    const w = token ? waiting.get(token) : null;
    if (!w || w.target !== sender) return { ok: false };
    w.finish(answer.ok === true);
    return { ok: true };
  }

  return { send, arrived };
}

module.exports = { createWindowMove, cleanWindow, MAX_PARAMS, ARRIVE_MS, MIN_GAP_MS };
