'use strict';

// Displays (multi-monitor layer 0, O 26.11): Z may READ which displays are connected and hear when that changes,
// show a big number on each display ("Identify"), and open the system's own display settings.
// Nothing here changes the system: no arrangement, resolution, scale or main display. Those come in a later layer
// with O's written word. Display facts stay on this computer: they go only to Z's own page, never to a server.

const IDENTIFY_MS = 2600;
const IDENTIFY_SIZE = 220;
const CHANGE_SETTLE_MS = 150;

// Fixed targets only: nothing from the page ever reaches these.
const SYSTEM_SETTINGS = {
  win32: { url: 'ms-settings:display' },
  darwin: { url: 'x-apple.systempreferences:com.apple.Displays-Settings.extension' },
};
const LINUX_SETTINGS = [
  { desktop: /gnome|unity|budgie|pantheon/i, cmd: 'gnome-control-center', args: ['display'] },
  { desktop: /kde|plasma/i, cmd: 'systemsettings', args: ['kcm_kscreen'] },
];

const num = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
const rect = (r) => ({ x: num(r && r.x), y: num(r && r.y), width: num(r && r.width), height: num(r && r.height) });

// One display as Z sees it. bounds/workArea are in DIP (Electron's units); pixels = DIP × scaleFactor.
function describe(d, primaryId, zDisplayId) {
  const scale = num(d.scaleFactor) || 1;
  const b = rect(d.bounds);
  return {
    id: String(d.id),
    label: typeof d.label === 'string' ? d.label.slice(0, 80) : '',
    bounds: b,
    workArea: rect(d.workArea),
    scaleFactor: scale,
    pixels: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) },
    rotation: [0, 90, 180, 270].includes(d.rotation) ? d.rotation : 0,
    refreshRate: num(d.displayFrequency),
    internal: d.internal === true,
    touch: d.touchSupport === 'available',
    primary: d.id === primaryId,
    hasZ: d.id === zDisplayId,
  };
}

function linuxSettingsTarget(env) {
  const desktop = `${(env && env.XDG_CURRENT_DESKTOP) || ''}:${(env && env.DESKTOP_SESSION) || ''}`;
  return LINUX_SETTINGS.find((t) => t.desktop.test(desktop)) || null;
}

function createDisplays({ screen, BrowserWindow, shell, spawn, platform, env, identifyFile, webPreferences, zWindow, send, timers }) {
  const T = timers || { setTimeout, clearTimeout };
  let settleTimer = null;
  let identifyWins = [];
  let listening = false;

  function zDisplayId() {
    const w = zWindow();
    if (!w || w.isDestroyed()) return null;
    try {
      return screen.getDisplayMatching(w.getBounds()).id;
    } catch {
      return null;
    }
  }

  function snapshot() {
    const primary = screen.getPrimaryDisplay();
    const zId = zDisplayId();
    const displays = screen.getAllDisplays().map((d) => describe(d, primary && primary.id, zId));
    return {
      displays,
      system: {
        platform,
        wayland: platform === 'linux' && String((env && env.XDG_SESSION_TYPE) || '').toLowerCase() === 'wayland',
        canOpenSettings: !!(SYSTEM_SETTINGS[platform] || (platform === 'linux' && linuxSettingsTarget(env))),
        canChange: false,
      },
    };
  }

  // The system fires several events for one plug or one scale change: tell Z once, after it settles.
  function changed() {
    if (settleTimer) T.clearTimeout(settleTimer);
    settleTimer = T.setTimeout(() => {
      settleTimer = null;
      try {
        send(snapshot());
      } catch {
        /* Z's page is reloading: it asks again when it is back */
      }
    }, CHANGE_SETTLE_MS);
  }

  function listen() {
    if (listening) return;
    listening = true;
    screen.on('display-added', changed);
    screen.on('display-removed', changed);
    screen.on('display-metrics-changed', changed);
  }

  function closeIdentify() {
    for (const w of identifyWins) if (!w.isDestroyed()) w.destroy();
    identifyWins = [];
  }

  // A big number in the middle of each display, for a moment. Numbers follow the order Z shows (1 = first in the list).
  function identify() {
    if (identifyWins.length) return { shown: identifyWins.length };
    const all = screen.getAllDisplays();
    all.forEach((d, i) => {
      const b = d.bounds;
      const w = new BrowserWindow({
        x: Math.round(b.x + (b.width - IDENTIFY_SIZE) / 2),
        y: Math.round(b.y + (b.height - IDENTIFY_SIZE) / 2),
        width: IDENTIFY_SIZE,
        height: IDENTIFY_SIZE,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences,
      });
      w.setIgnoreMouseEvents(true);
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.once('ready-to-show', () => !w.isDestroyed() && w.showInactive());
      w.loadFile(identifyFile, { query: { n: String(i + 1) } });
      identifyWins.push(w);
    });
    T.setTimeout(closeIdentify, IDENTIFY_MS);
    return { shown: all.length };
  }

  function openSystemSettings() {
    const target = SYSTEM_SETTINGS[platform];
    if (target) {
      shell.openExternal(target.url).catch(() => {});
      return { opened: true };
    }
    if (platform === 'linux') {
      const t = linuxSettingsTarget(env);
      if (!t) return { opened: false };
      try {
        const child = spawn(t.cmd, t.args, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        return { opened: true };
      } catch {
        return { opened: false };
      }
    }
    return { opened: false };
  }

  return { snapshot, listen, identify, openSystemSettings, closeIdentify, changed };
}

module.exports = { createDisplays, describe, linuxSettingsTarget, IDENTIFY_MS, CHANGE_SETTLE_MS };
