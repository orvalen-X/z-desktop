'use strict';

// What the wrapper tells Z, and the only things Z may ask of it:
// - that it runs inside the desktop app, on which system, at which version and release name;
// - full screen: read it, switch it, hear when it changes (the top-bar button, O 26.11);
// - "start Z when the computer starts": read it and switch it;
// - displays (api 2): read the connected displays, hear when they change, show a number on each, open the system's
//   display settings. Nothing that changes the system.
// - extend (api 3): a one-time name for a plain window on one display (Z draws there itself), and moving Z's own
//   window to the display the person chooses.
// - extend, way A (api 4): which display this Z runs on (a whole Z on an extra display gets its id; Z's own window
//   gets none), and, for Z's own window only, turning a whole Z on every extra display on or off.
// - one lock for every display (api 5): Z's own window tells its lock state; a Z on an extra display reads it, hears
//   when it changes, may ask Z's own window to lock (never to unlock) and tells it the person is working there.
// No file, system or network access is exposed to the page. The main process also checks that each request
// comes from Z's own page (not from an app frame inside it) before it does anything.

const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : '';
};

function fanOut(set, value) {
  for (const fn of set) {
    try {
      fn(value);
    } catch {
      /* one listener failing does not stop the others */
    }
  }
}
function subscribe(set, fn) {
  if (typeof fn !== 'function') return () => {};
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

const fsListeners = new Set();
ipcRenderer.on('zd:fs', (_event, on) => fanOut(fsListeners, on === true));

const displayListeners = new Set();
ipcRenderer.on('zd:displays', (_event, snap) => fanOut(displayListeners, snap));

const lockListeners = new Set();
ipcRenderer.on('zd:lock', (_event, state) => fanOut(lockListeners, state));
const lockRequestListeners = new Set();
ipcRenderer.on('zd:lock:request', () => fanOut(lockRequestListeners));
const activityListeners = new Set();
ipcRenderer.on('zd:lock:activity', () => fanOut(activityListeners));

contextBridge.exposeInMainWorld(
  'zDesktop',
  Object.freeze({
    isDesktopApp: true,
    api: 5,
    platform: process.platform,
    version: arg('z-desktop-version'),
    release: arg('z-desktop-release'),
    display: Object.freeze({ id: arg('z-desktop-display') || null, main: !arg('z-desktop-display') }),
    desks: Object.freeze({ set: (on) => ipcRenderer.invoke('zd:desks:set', on === true) }),
    lock: Object.freeze({
      get: () => ipcRenderer.invoke('zd:lock:get'),
      set: (locked, profile) =>
        ipcRenderer.invoke('zd:lock:set', { locked: locked !== false, profile: typeof profile === 'string' ? profile : null }),
      onChange: (fn) => subscribe(lockListeners, fn),
      request: () => ipcRenderer.invoke('zd:lock:request'),
      onRequest: (fn) => subscribe(lockRequestListeners, fn),
      activity: () => ipcRenderer.invoke('zd:lock:activity'),
      onActivity: (fn) => subscribe(activityListeners, fn),
    }),
    fullscreen: Object.freeze({
      get: () => ipcRenderer.invoke('zd:fs:get'),
      set: (on) => ipcRenderer.invoke('zd:fs:set', on === true),
      toggle: () => ipcRenderer.invoke('zd:fs:toggle'),
      onChange: (fn) => subscribe(fsListeners, fn),
    }),
    autostart: Object.freeze({
      get: () => ipcRenderer.invoke('zd:autostart:get'),
      set: (on) => ipcRenderer.invoke('zd:autostart:set', on === true),
    }),
    displays: Object.freeze({
      list: () => ipcRenderer.invoke('zd:displays:get'),
      onChange: (fn) => subscribe(displayListeners, fn),
      identify: () => ipcRenderer.invoke('zd:displays:identify'),
      openSystemSettings: () => ipcRenderer.invoke('zd:displays:settings'),
      surface: (id) => ipcRenderer.invoke('zd:displays:surface', String(id)),
      setMain: (id) => ipcRenderer.invoke('zd:displays:main', String(id)),
    }),
  }),
);
