'use strict';

// The only thing the wrapper tells Z: that it runs inside the desktop app, on which system, at which version.
// No file, system or network access is exposed to the page.

const { contextBridge } = require('electron');

const versionArg = process.argv.find((a) => a.startsWith('--z-desktop-version='));

contextBridge.exposeInMainWorld(
  'zDesktop',
  Object.freeze({
    isDesktopApp: true,
    platform: process.platform,
    version: versionArg ? versionArg.split('=')[1] : '',
  }),
);
