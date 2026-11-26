'use strict';

// Extend, way A, layer 3 (O 26.11 "רק במסך הראשי"): one lock for every display, opened only on the main display.
// Z's own window is the only one that locks and unlocks. It tells the app its lock state here, and every Z on an
// extra display only shows that state: it never locks the server, never asks for a code and never unlocks itself.
// - The state starts locked, and goes back to locked whenever Z's own page starts a new page, crashes or closes.
//   Not knowing means locked.
// - Only Z's own window sets it (main.js checks fromMainZ). The extra displays read it and hear when it changes.
// - The profile is the id of the user who opened the lock, so a display that still shows another user's desk
//   knows it must start again. It never leaves this computer.
// - A Z on an extra display may only ask Z's own window to lock (never to unlock), and may tell it that the person
//   is working there, so Z's own window does not lock itself for "no activity" while the person works elsewhere.

const LOCKED = Object.freeze({ locked: true, profile: null });
const PROFILE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVITY_EVERY_MS = 5000;

function createLockMirror({ send, now }) {
  const clock = now || Date.now;
  let state = LOCKED;
  let lastActivity = -Infinity;

  function publish(next) {
    if (next.locked === state.locked && next.profile === state.profile) return state;
    state = next;
    send(state);
    return state;
  }

  // From Z's own window. Anything that is not exactly "unlocked, by this profile" counts as locked.
  function set(value) {
    const v = value && typeof value === 'object' ? value : {};
    if (v.locked === false && typeof v.profile === 'string' && PROFILE_RE.test(v.profile)) {
      return publish(Object.freeze({ locked: false, profile: v.profile }));
    }
    return publish(LOCKED);
  }

  const reset = () => publish(LOCKED);

  // Activity on an extra display reaches Z's own window at most once every few seconds.
  function activity() {
    const t = clock();
    if (t - lastActivity < ACTIVITY_EVERY_MS) return false;
    lastActivity = t;
    return true;
  }

  return { set, reset, get: () => state, activity };
}

module.exports = { createLockMirror, ACTIVITY_EVERY_MS };
