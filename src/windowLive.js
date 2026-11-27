'use strict';

// Extend, layer 6 (api 7, O 27.11 "הרחבה אמיתית של המסך"): a window dragged across displays moves with the hand.
// Layer 4 moves a window only when it is let go on another display. Here the Z the window is leaving starts a carry as
// soon as the cursor leaves its page, and this file follows the system cursor (read here, never taken from the page):
// - the cursor reaches another display with a Z on it: that Z gets "enter" (the same checked description as layer 4,
//   with a one-time token and the profile Z was unlocked by) and opens the window under the hand;
// - while the cursor stays there that Z gets "follow" (only where the cursor is), about 60 times a second;
// - the cursor goes back, or on to a third display: the Z it left gets "leave" and closes the window it opened;
// - the hand lets go (zd:window:drop): on another display that Z gets "land" and answers, like layer 4, once the window
//   is on its desk (zd:window:arrived); only then does the Z it left close its own. No answer within ARRIVE_MS: the
//   carry failed, that Z gets "leave", and the window stays on the display it came from.
// Nothing is carried while Z is locked. One carry per Z, at most one start per MIN_GAP_MS from it, and a carry that
// never ends stops by itself after LIVE_MAX_MS. A Z that goes away (either end) ends its carries.

const { cleanWindow, ARRIVE_MS } = require('./windowMove');

const FOLLOW_MS = 16;
const LIVE_MAX_MS = 60000;
const MIN_GAP_MS = 200;
const TOKEN_RE = /^[a-f0-9]{32}$/;

const gone = (wc) => !wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed());

function createWindowLive({ screen, isLocked, profileOf, senderDisplay, targetOf, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, newToken }) {
  const carries = new Map(); // sender -> carry
  const lastStart = new Map(); // sender -> when it last started one
  const landing = new Map(); // token -> { target, finish }

  function post(wc, msg) {
    if (gone(wc)) return false;
    try {
      wc.send('zd:window:live', msg);
      return true;
    } catch {
      return false;
    }
  }

  // Where the cursor is now: the display under it when that is another display with a Z on it, else no target.
  function look(carry) {
    let point;
    let display;
    try {
      point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    } catch {
      return { wc: null };
    }
    if (!point || !display) return { wc: null };
    const b = display.bounds;
    if (point.x < b.x || point.y < b.y || point.x >= b.x + b.width || point.y >= b.y + b.height) return { wc: null };
    const from = senderDisplay(carry.sender);
    if (from == null || String(display.id) === String(from)) return { wc: null };
    const wc = targetOf(String(display.id));
    if (gone(wc) || wc === carry.sender) return { wc: null };
    return { wc, x: point.x - b.x, y: point.y - b.y };
  }

  function leaveTarget(carry) {
    if (carry.target) post(carry.target, { kind: 'leave', token: carry.token });
    carry.target = null;
    carry.at = null;
  }

  function stopTicks(carry) {
    if (carry.timer !== null) clearTimer(carry.timer);
    carry.timer = null;
  }

  function end(carry) {
    stopTicks(carry);
    leaveTarget(carry);
    if (carries.get(carry.sender) === carry) carries.delete(carry.sender);
  }

  function step(carry) {
    const seen = look(carry);
    if (seen.wc !== carry.target) {
      leaveTarget(carry);
      if (seen.wc && post(seen.wc, { kind: 'enter', ...carry.win, x: seen.x, y: seen.y, token: carry.token, profile: carry.profile })) {
        carry.target = seen.wc;
        carry.at = { x: seen.x, y: seen.y };
      }
      return;
    }
    if (seen.wc && (!carry.at || carry.at.x !== seen.x || carry.at.y !== seen.y)) {
      carry.at = { x: seen.x, y: seen.y };
      post(seen.wc, { kind: 'follow', token: carry.token, x: seen.x, y: seen.y });
    }
  }

  function tick(carry) {
    carry.timer = null;
    if (carries.get(carry.sender) !== carry) return;
    if (gone(carry.sender) || isLocked() || now() - carry.since > LIVE_MAX_MS) {
      end(carry);
      return;
    }
    step(carry);
    carry.timer = setTimer(() => tick(carry), FOLLOW_MS);
  }

  // From a Z (main.js checks fromZ): the cursor just left its page while it drags a window. { ok, token }.
  function start(sender, spec) {
    const no = { ok: false };
    if (isLocked()) return no;
    const profile = typeof profileOf === 'function' ? profileOf() : null;
    if (typeof profile !== 'string' || !profile) return no;
    const win = cleanWindow(spec);
    if (!win) return no;
    if (senderDisplay(sender) == null) return no;
    const last = lastStart.get(sender);
    if (last !== undefined && now() - last < MIN_GAP_MS) return no;
    for (const k of Array.from(lastStart.keys())) if (gone(k)) lastStart.delete(k);
    for (const c of Array.from(carries.values())) if (gone(c.sender)) end(c);
    const before = carries.get(sender);
    if (before) end(before);
    lastStart.set(sender, now());
    const carry = { sender, token: newToken(), win, profile, target: null, at: null, timer: null, since: now() };
    carries.set(sender, carry);
    tick(carry);
    return { ok: true, token: carry.token };
  }

  // From the same Z: the hand let go (drop true) or the drag ended on its own page (drop false). Resolves { ok }: ok
  // only when the Z on the display under the hand answered that the window is on its desk.
  function drop(sender, answer) {
    const token = answer && typeof answer.token === 'string' && TOKEN_RE.test(answer.token) ? answer.token : null;
    const carry = token ? carries.get(sender) : null;
    if (!carry || carry.token !== token) return Promise.resolve({ ok: false });
    stopTicks(carry);
    carries.delete(sender);
    if (answer.drop !== true || isLocked()) {
      leaveTarget(carry);
      return Promise.resolve({ ok: false });
    }
    step(carry);
    const target = carry.target;
    if (!target || !carry.at) {
      leaveTarget(carry);
      return Promise.resolve({ ok: false });
    }
    return new Promise((resolve) => {
      let timer = null;
      const finish = (ok) => {
        if (!landing.has(token)) return;
        landing.delete(token);
        if (timer !== null) clearTimer(timer);
        if (!ok) post(target, { kind: 'leave', token });
        resolve({ ok });
      };
      landing.set(token, { target, finish });
      timer = setTimer(() => finish(false), ARRIVE_MS);
      if (!post(target, { kind: 'land', token, x: carry.at.x, y: carry.at.y })) finish(false);
    });
  }

  // From the Z the window landed on: { ok } true when this answer was still awaited (false = not ours, or too late).
  function arrived(sender, answer) {
    const token = answer && typeof answer.token === 'string' ? answer.token : null;
    const w = token ? landing.get(token) : null;
    if (!w || w.target !== sender) return { ok: false };
    w.finish(answer.ok === true);
    return { ok: true };
  }

  return { start, drop, arrived, owns: (token) => typeof token === 'string' && landing.has(token) };
}

module.exports = { createWindowLive, FOLLOW_MS, LIVE_MAX_MS, MIN_GAP_MS };
