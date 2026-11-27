'use strict';

// Camera, microphone and location are never granted silently.
// The first time Z asks, the person sees a system dialog. The answer is saved per permission and per origin,
// and "Reset permissions" (right-click the Z icon, or the Mac menu) forgets every saved answer.

const cfg = require('./config');

const SENSITIVE = ['camera', 'microphone', 'geolocation'];
// Granted to Z without a dialog: the operating system or Z itself already asks for these.
// keyboardLock: Z's page locks the keys it uses in full screen (the Windows key, Alt+Tab, Ctrl+W, ...; O 27.11).
const QUIET = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// Which sensitive kinds a Chromium permission request stands for.
function kindsFor(permission, details) {
  if (permission === 'geolocation') return ['geolocation'];
  if (permission === 'media') {
    const types = (details && (details.mediaTypes || (details.mediaType ? [details.mediaType] : []))) || [];
    const kinds = [];
    if (types.includes('video')) kinds.push('camera');
    if (types.includes('audio')) kinds.push('microphone');
    return kinds.length ? kinds : ['camera', 'microphone'];
  }
  return [];
}

// The site that answers for a request (O 25.11). Z's own pages answer for themselves. An app inside Z runs in a frame
// from its own address (OnlyCalls: a workers.dev site); Chromium lets that frame ask only for what Z's iframe
// `allow` delegates to it, and then, as in a browser, the answer belongs to the top-level site, Z. So a frame counts
// only for camera, microphone and location, only while the window's top page is Z, and only with Z's own saved yes:
// a frame never opens a dialog and never adds an answer (Z asks on its own page first, z#517). Anything else from a
// frame (notifications, clipboard, ...) stays refused.
function scopeOf(url, topUrl, permission) {
  if (cfg.isAppUrl(url)) return { origin: originOf(url), framed: false };
  if (topUrl && cfg.isAppUrl(topUrl) && (permission === 'geolocation' || permission === 'media')) {
    return { origin: originOf(topUrl), framed: true };
  }
  return null;
}

function createPermissions({ store, ask }) {
  // store: { get(origin) -> {kind: bool}, set(origin, decisions), clear() }
  // ask: (origin, kinds) -> Promise<boolean>   (shows the system dialog)
  let queue = Promise.resolve();

  function saved(origin, kinds) {
    const d = store.get(origin) || {};
    if (kinds.every((k) => d[k] === true)) return true;
    if (kinds.some((k) => d[k] === false)) return false;
    return undefined;
  }

  // Asynchronous request from a page. topUrl: the window's top page (for a request from a frame inside Z).
  function request(url, permission, details, topUrl) {
    const scope = scopeOf(url, topUrl, permission);
    if (!scope) return Promise.resolve(false);
    const { origin } = scope;
    if (QUIET.has(permission)) return Promise.resolve(!scope.framed);
    const kinds = kindsFor(permission, details);
    if (!kinds.length) return Promise.resolve(false);
    const known = saved(origin, kinds);
    if (known !== undefined) return Promise.resolve(known);
    if (scope.framed) return Promise.resolve(false); // Z has not answered yet: Z asks on its own page, not a frame
    // One dialog at a time; a second request for the same thing reuses the first answer.
    const run = queue.then(async () => {
      const again = saved(origin, kinds);
      if (again !== undefined) return again;
      const pending = kinds.filter((k) => (store.get(origin) || {})[k] === undefined);
      const allowed = !!(await ask(origin, pending));
      const next = { ...(store.get(origin) || {}) };
      for (const k of pending) next[k] = allowed;
      store.set(origin, next);
      return allowed;
    });
    queue = run.catch(() => false);
    return run;
  }

  // Synchronous check (navigator.permissions.query and similar): only what was already allowed.
  function check(url, permission, details, topUrl) {
    const scope = scopeOf(url, topUrl, permission);
    if (!scope) return false;
    if (QUIET.has(permission)) return !scope.framed;
    const kinds = kindsFor(permission, details);
    if (!kinds.length) return false;
    return saved(scope.origin, kinds) === true;
  }

  return { request, check, reset: () => store.clear() };
}

module.exports = { createPermissions, kindsFor, scopeOf, SENSITIVE, QUIET };
