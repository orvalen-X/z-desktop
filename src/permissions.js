'use strict';

// Camera, microphone and location are never granted silently.
// The first time Z asks, the person sees a system dialog. The answer is saved per permission and per origin,
// and "Reset permissions" (right-click the Z icon, or the Mac menu) forgets every saved answer.

const cfg = require('./config');

const SENSITIVE = ['camera', 'microphone', 'geolocation'];
// Granted to Z without a dialog: the operating system or Z itself already asks for these.
const QUIET = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

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

  // Asynchronous request from a page.
  function request(url, permission, details) {
    const origin = originOf(url);
    if (!cfg.isAppUrl(url)) return Promise.resolve(false);
    if (QUIET.has(permission)) return Promise.resolve(true);
    const kinds = kindsFor(permission, details);
    if (!kinds.length) return Promise.resolve(false);
    const known = saved(origin, kinds);
    if (known !== undefined) return Promise.resolve(known);
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
  function check(url, permission, details) {
    if (!cfg.isAppUrl(url)) return false;
    if (QUIET.has(permission)) return true;
    const kinds = kindsFor(permission, details);
    if (!kinds.length) return false;
    return saved(originOf(url), kinds) === true;
  }

  return { request, check, reset: () => store.clear() };
}

module.exports = { createPermissions, kindsFor, SENSITIVE, QUIET };
