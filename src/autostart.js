'use strict';

// "Start Z when the computer starts" (O 26.11): off unless the person turns it on, in the installer or in Z.
// Windows and Mac use the system's login items; Linux uses the standard autostart folder.
// Z always opens in full screen, also when it starts with the computer.

const AUTOSTART_ARG = '--autostart';

// A path inside the Exec line of a .desktop file: quoted, with the four reserved characters escaped.
function desktopQuote(p) {
  return '"' + String(p).replace(/(["`$\\])/g, '\\$1') + '"';
}

function linuxEntry(execPath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Z',
    `Exec=${desktopQuote(execPath)} ${AUTOSTART_ARG}`,
    'Icon=z-desktop',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function createAutostart({ app, platform, env, fs, path, homedir, execPath }) {
  // During development the "app" is Electron itself: never register that with the system.
  const supported = !!app.isPackaged && ['win32', 'darwin', 'linux'].includes(platform);

  function linuxFile() {
    const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir, '.config');
    return path.join(base, 'autostart', 'z-desktop.desktop');
  }
  // An AppImage runs from a temporary mount: start the AppImage file itself.
  const linuxExec = () => env.APPIMAGE || execPath;

  function get() {
    if (!supported) return { supported: false, enabled: false };
    try {
      if (platform === 'linux') return { supported: true, enabled: fs.existsSync(linuxFile()) };
      const s = app.getLoginItemSettings(platform === 'win32' ? { args: [AUTOSTART_ARG] } : undefined);
      return { supported: true, enabled: !!s.openAtLogin };
    } catch {
      return { supported: true, enabled: false };
    }
  }

  function set(on) {
    if (!supported) return get();
    const enabled = on === true;
    try {
      if (platform === 'linux') {
        const file = linuxFile();
        if (enabled) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, linuxEntry(linuxExec()), { mode: 0o644 });
        } else if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } else if (platform === 'win32') {
        app.setLoginItemSettings({ openAtLogin: enabled, args: [AUTOSTART_ARG] });
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled });
      }
    } catch {
      /* the system refused: the answer below says what is true now */
    }
    return get();
  }

  return { get, set };
}

// "--autostart=on" / "--autostart=off" on the command line: how the installer passes the person's checkbox.
function autostartFromArgs(argv) {
  for (const a of argv || []) {
    if (a === `${AUTOSTART_ARG}=on`) return true;
    if (a === `${AUTOSTART_ARG}=off`) return false;
  }
  return null;
}

module.exports = { createAutostart, autostartFromArgs, linuxEntry, desktopQuote, AUTOSTART_ARG };
