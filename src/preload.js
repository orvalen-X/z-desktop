'use strict';

// What the wrapper tells Z, and the only things Z may ask of it:
// - that it runs inside the desktop app, on which system, at which version and release name;
// - full screen: read it, switch it, hear when it changes (the top-bar button, O 26.11);
// - "start Z when the computer starts": read it and switch it.
// No file, system or network access is exposed to the page. The main process also checks that each request
// comes from Z's own page (not from an app frame inside it) before it does anything.

const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : '';
};

const fsListeners = new Set();
ipcRenderer.on('zd:fs', (_event, on) => {
  for (const fn of fsListeners) {
    try {
      fn(on === true);
    } catch {
      /* one listener failing does not stop the others */
    }
  }
});

contextBridge.exposeInMainWorld(
  'zDesktop',
  Object.freeze({
    isDesktopApp: true,
    api: 1,
    platform: process.platform,
    version: arg('z-desktop-version'),
    release: arg('z-desktop-release'),
    fullscreen: Object.freeze({
      get: () => ipcRenderer.invoke('zd:fs:get'),
      set: (on) => ipcRenderer.invoke('zd:fs:set', on === true),
      toggle: () => ipcRenderer.invoke('zd:fs:toggle'),
      onChange: (fn) => {
        if (typeof fn !== 'function') return () => {};
        fsListeners.add(fn);
        return () => {
          fsListeners.delete(fn);
        };
      },
    }),
    autostart: Object.freeze({
      get: () => ipcRenderer.invoke('zd:autostart:get'),
      set: (on) => ipcRenderer.invoke('zd:autostart:set', on === true),
    }),
  }),
);
