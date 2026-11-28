// Quick checks that run without Electron: syntax, the address rules, permissions, updates and the five languages.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let failed = 0;
const pending = []; // async checks finish before the result is counted
const fail = (name, e) => {
  failed++;
  console.log('FAIL', name, '\n     ', e.message);
};
const test = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => console.log('ok  ', name), (e) => fail(name, e)));
    else console.log('ok  ', name);
  } catch (e) {
    fail(name, e);
  }
};

for (const f of ['src/main.js', 'src/preload.js', 'src/config.js', 'src/i18n.js', 'src/permissions.js', 'src/updates.js', 'src/autostart.js', 'src/displays.js', 'src/navGuard.js', 'src/surfaces.js', 'src/desks.js', 'src/winKeys.js']) {
  test(`syntax ${f}`, () => execFileSync(process.execPath, ['--check', f]));
}

const cfg = require('../src/config.js');
test('Z loads in the window', () => {
  assert.ok(cfg.isInWindowUrl('https://orvalen.me/'));
  assert.ok(cfg.isInWindowUrl('https://orvalen.me/m/chat?x=1'));
  assert.ok(cfg.isAppUrl('https://orvalen.me/pay'));
});
test('exact host only: no subdomains, no other ports', () => {
  for (const u of ['https://peek.orvalen.me/', 'https://x.orvalen.me/', 'https://orvalen.me:8443/'])
    assert.ok(!cfg.isInWindowUrl(u) && !cfg.isAppUrl(u), u);
});
test('other sites go to the browser', () => {
  for (const u of [
    'https://orvalen-official.com/',
    'https://evil-orvalen.me/',
    'https://orvalen.me.evil.com/',
    'http://orvalen.me/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://example.com/',
  ]) assert.ok(!cfg.isInWindowUrl(u), u);
});
test('Google sign-in is recognised', () => {
  assert.ok(cfg.isGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth?x'));
  assert.ok(!cfg.isGoogleSignIn('https://google.com.evil.com/'));
});
test('only web and mail links open outside', () => {
  assert.ok(cfg.isExternalSafe('https://wa.me/?text=hi'));
  assert.ok(cfg.isExternalSafe('mailto:a@b.c'));
  for (const u of ['file:///C:/Windows/system32/cmd.exe', 'smb://host/share', 'ms-msdt:/id', 'javascript:1'])
    assert.ok(!cfg.isExternalSafe(u), u);
});

const { createPermissions } = require('../src/permissions.js');
const permTest = async () => {
  const saved = {};
  let asked = 0, answer = true;
  const p = createPermissions({
    store: { get: (o) => saved[o], set: (o, d) => (saved[o] = d), clear: () => Object.keys(saved).forEach((k) => delete saved[k]) },
    ask: async () => (asked++, answer),
  });
  const Z = 'https://orvalen.me/call';
  // other sites never get anything, and are never asked about
  assert.equal(await p.request('https://evil.example/', 'media', { mediaTypes: ['video'] }), false);
  assert.equal(await p.request('https://sub.orvalen.me/', 'geolocation', {}), false);
  assert.equal(asked, 0);
  // first camera request asks once; the answer is remembered
  assert.equal(p.check(Z, 'media', { mediaType: 'video' }), false, 'nothing granted before asking');
  assert.equal(await p.request(Z, 'media', { mediaTypes: ['video'] }), true);
  assert.equal(await p.request(Z, 'media', { mediaTypes: ['video'] }), true);
  assert.equal(asked, 1);
  assert.equal(p.check(Z, 'media', { mediaType: 'video' }), true);
  // microphone is its own question; a "no" is remembered too
  answer = false;
  assert.equal(await p.request(Z, 'media', { mediaTypes: ['audio'] }), false);
  assert.equal(await p.request(Z, 'media', { mediaTypes: ['audio'] }), false);
  assert.equal(asked, 2);
  // two requests at once show one dialog
  answer = true;
  const [a, b] = await Promise.all([p.request(Z, 'geolocation', {}), p.request(Z, 'geolocation', {})]);
  assert.ok(a && b);
  assert.equal(asked, 3);
  // notifications need no dialog; unknown permissions are refused
  assert.equal(await p.request(Z, 'notifications', {}), true);
  assert.equal(await p.request(Z, 'hid', {}), false);
  // an app inside Z (cross-origin frame, O 25.11): camera, microphone and location follow Z's own answer, saved
  // under Z; nothing else, and nothing when the top page is not Z
  const APP = 'https://onlycalls.example.workers.dev/';
  assert.equal(await p.request(APP, 'geolocation', {}, Z), true, 'Z already allowed location');
  assert.equal(p.check(APP, 'geolocation', {}, 'https://orvalen.me'), true);
  assert.equal(await p.request(APP, 'media', { mediaTypes: ['audio'] }, Z), false, 'Z said no to the microphone');
  assert.equal(await p.request(APP, 'notifications', {}, Z), false, 'quiet permissions are for Z itself only');
  assert.equal(p.check(APP, 'notifications', {}, Z), false);
  assert.equal(await p.request(APP, 'geolocation', {}, 'https://evil.example/'), false, 'top page not Z');
  assert.equal(await p.request(APP, 'geolocation', {}), false, 'no top page');
  assert.equal(p.check(APP, 'geolocation', {}, 'https://sub.orvalen.me'), false);
  assert.equal(asked, 3, 'a frame never adds a dialog for what Z already answered');
  assert.equal(saved[APP] || saved['https://onlycalls.example.workers.dev'], undefined, 'nothing saved under the frame');
  assert.equal(await p.request(APP, 'media', { mediaTypes: ['video'] }, Z), true, 'camera: Z said yes above');
  delete saved['https://orvalen.me'].camera;
  assert.equal(await p.request(APP, 'media', { mediaTypes: ['video'] }, Z), false, 'Z has not answered: a frame gets no dialog');
  assert.equal(asked, 3, 'still no dialog from a frame');
  assert.equal(saved['https://orvalen.me'].camera, undefined, 'and adds no answer');
  // reset forgets everything
  p.reset();
  assert.equal(p.check(Z, 'media', { mediaType: 'video' }), false);
  await p.request(Z, 'media', { mediaTypes: ['video'] });
  assert.equal(asked, 4);
};
try {
  await permTest();
  console.log('ok   permissions: asked once per kind and origin, remembered, reset');
} catch (e) {
  failed++;
  console.log('FAIL permissions', '\n     ', e.message);
}

const i18n = require('../src/i18n.js');
const i18nEn = i18n.STRINGS.en;

test('message boxes: Hebrew and Arabic lines read right to left, others untouched', () => {
  assert.equal(i18n.boxText('he', 'Z 0.3.3\nשורה'), '\u202BZ 0.3.3\u202C\n\u202Bשורה\u202C');
  assert.ok(i18n.boxText('ar', 'x').startsWith('\u202B'));
  for (const l of ['en', 'es', 'ru']) assert.equal(i18n.boxText(l, 'Z 0.3.3'), 'Z 0.3.3');
  assert.equal(i18n.boxText('he', ''), '');
  // A web address in a permission question stays whole and left to right inside the Hebrew line.
  assert.equal(i18n.boxText('he', i18n.ltrRun('maps.example.com:8080')), '\u202B\u202Amaps.example.com:8080\u202C\u202C');
  assert.ok(/ltrRun\(new URL\(origin\)\.host\)/.test(require('node:fs').readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')));
  assert.equal(i18n.boxText('he', undefined), undefined);
  const main = require('node:fs').readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const direct = main.match(/dialog\s*\.\s*showMessageBox\(/g) || [];
  assert.equal(direct.length, 2, 'every message box goes through showBox');
});

const upd = require('../src/updates.js');
test('updates: version order', () => {
  assert.ok(upd.isNewer('v0.2.1', '0.2.0'));
  assert.ok(upd.isNewer('1.0.0', '0.9.9'));
  assert.ok(upd.isNewer('0.10.0', '0.9.0'));
  assert.ok(!upd.isNewer('v0.2.0', '0.2.0'));
  assert.ok(!upd.isNewer('0.1.9', '0.2.0'));
  assert.ok(!upd.isNewer('0.3.0-beta', '0.2.0'), 'pre-release ignored');
  assert.ok(!upd.isNewer('garbage', '0.2.0'));
});
test('updates: install on Windows and AppImage, notice on Mac and DEB, nothing in development', () => {
  assert.equal(upd.updateMode({ platform: 'win32', isPackaged: true }), 'install');
  assert.equal(upd.updateMode({ platform: 'linux', isPackaged: true, appImage: true }), 'install');
  assert.equal(upd.updateMode({ platform: 'linux', isPackaged: true, appImage: false }), 'notify');
  assert.equal(upd.updateMode({ platform: 'darwin', isPackaged: true }), 'notify');
  assert.equal(upd.updateMode({ platform: 'win32', isPackaged: false }), 'off');
});
test('updates: download link stays on the Releases page', () => {
  const ok = 'https://github.com/orvalen-X/z-desktop/releases/tag/v0.2.1';
  assert.equal(upd.safeReleaseUrl(ok), ok);
  for (const bad of ['https://evil.com/z.dmg', 'https://github.com/orvalen-X/z-desktop-evil/releases/', 'file:///x', null])
    assert.equal(upd.safeReleaseUrl(bad), upd.RELEASES_PAGE + 'latest', String(bad));
});

// The notice flow (Mac, DEB), with a fake release.
async function noticeFlow() {
  const prefs = {};
  const shown = [];
  const opened = [];
  let release = { tag_name: 'v0.2.1', html_url: 'https://github.com/orvalen-X/z-desktop/releases/tag/v0.2.1' };
  let answer = 1;
  const u = upd.createUpdates({
    app: { isPackaged: true },
    version: '0.2.0',
    platform: 'darwin',
    env: {},
    fetchLatest: async () => release,
    openExternal: (url) => opened.push(url),
    ask: async (type, title) => (shown.push(title), answer),
    prefs,
    savePrefs: () => {},
    strings: () => i18nEn,
    log: () => {},
  });
  assert.equal(u.mode, 'notify');
  await u.checkNow(); // "Later"
  assert.equal(shown.length, 1);
  assert.equal(prefs.updSkipped, '0.2.1');
  answer = 0;
  await u.checkNow(); // a manual check still shows it; "Download"
  assert.equal(opened[0], release.html_url);
  release = { tag_name: 'v0.2.0' };
  await u.checkNow(); // up to date
  assert.equal(shown.at(-1), i18nEn.updLatestTitle);
  release = { tag_name: 'v0.3.0', draft: true };
  shown.length = 0;
  await u.checkNow();
  assert.equal(shown[0], i18nEn.updLatestTitle, 'drafts are never offered');
}
test('five languages, same keys', () => {
  assert.deepEqual(i18n.SUPPORTED.sort(), ['ar', 'en', 'es', 'he', 'ru']);
  const keys = Object.keys(i18n.STRINGS.en).sort();
  for (const l of i18n.SUPPORTED) {
    assert.deepEqual(Object.keys(i18n.STRINGS[l]).sort(), keys, l);
    for (const k of keys) assert.ok(String(i18n.STRINGS[l][k]).trim(), `${l}.${k} empty`);
  }
  assert.equal(i18n.STRINGS.he.dir, 'rtl');
  assert.equal(i18n.STRINGS.ar.dir, 'rtl');
});
test('language choice', () => {
  assert.equal(i18n.pickLang(null, ['he-IL']), 'he');
  assert.equal(i18n.pickLang(null, ['iw']), 'he');
  assert.equal(i18n.pickLang('ru', ['he-IL']), 'ru');
  assert.equal(i18n.pickLang(null, ['fr-FR', 'es-ES']), 'es');
  assert.equal(i18n.pickLang(null, ['ja-JP']), 'en');
});

try {
  await noticeFlow();
  console.log('ok   updates: notice shown once, Download opens the release, drafts ignored');
} catch (e) {
  failed++;
  console.log('FAIL updates notice', '\n     ', e.message);
}

// ---------- start with the computer ----------
const auto = require('../src/autostart.js');
test('installer checkbox arrives as --autostart=on/off, nothing else counts', () => {
  assert.equal(auto.autostartFromArgs(['x', '--autostart=on']), true);
  assert.equal(auto.autostartFromArgs(['--autostart=off']), false);
  assert.equal(auto.autostartFromArgs(['--autostart', '--autostart=yes']), null);
});
test('Linux autostart entry: quoted path per the Desktop Entry spec, starts with --autostart', () => {
  const exec = (p) => auto.linuxEntry(p).split('\n').find((l) => l.startsWith('Exec='));
  assert.equal(exec('/opt/Z/z-desktop'), 'Exec="/opt/Z/z-desktop" --autostart');
  // $ and " get \ inside the quotes, and that \ is doubled by the string escape
  assert.equal(exec('/home/a b/Z $x".AppImage'), 'Exec="/home/a b/Z \\\\$x\\\\".AppImage" --autostart');
  // a literal backslash becomes four; % is never a field code
  assert.equal(exec('/h/a\\b%f'), 'Exec="/h/a\\\\\\\\b%%f" --autostart');
  assert.match(auto.linuxEntry('/opt/Z/z'), /^Type=Application$/m);
});
test('Linux autostart: a path with a line break or other control character is refused, nothing written', () => {
  for (const bad of ['/tmp/x\nExec=evil', '/tmp/x\rY', '/tmp/\tz', '/tmp/\u0000'])
    assert.throws(() => auto.linuxEntry(bad), /unsafe path/);
  const files = {};
  const fakeFs = { existsSync: (f) => f in files, mkdirSync: () => {}, writeFileSync: (f, d) => (files[f] = d), unlinkSync: (f) => delete files[f] };
  const a = auto.createAutostart({ app: { isPackaged: true }, platform: 'linux', env: { APPIMAGE: '/tmp/x\nExec=evil' }, fs: fakeFs, path: require('node:path').posix, homedir: '/home/u', execPath: '/opt/Z/z' });
  assert.deepEqual(a.set(true), { supported: true, enabled: false });
  assert.equal(Object.keys(files).length, 0);
});
test('autostart: never registered while developing, Linux file on and off', () => {
  const files = {};
  const fakeFs = {
    existsSync: (f) => f in files,
    mkdirSync: () => {},
    writeFileSync: (f, d) => (files[f] = d),
    unlinkSync: (f) => delete files[f],
  };
  const path = require('node:path').posix; // Linux paths, also when the checks run on Windows
  const mk = (isPackaged, env = {}) =>
    auto.createAutostart({ app: { isPackaged }, platform: 'linux', env, fs: fakeFs, path, homedir: '/home/u', execPath: '/opt/Z/z-desktop' });
  assert.deepEqual(mk(false).set(true), { supported: false, enabled: false });
  assert.equal(Object.keys(files).length, 0);
  const a = mk(true, { APPIMAGE: '/home/u/Z.AppImage' });
  assert.deepEqual(a.set(true), { supported: true, enabled: true });
  assert.match(files['/home/u/.config/autostart/z-desktop.desktop'], /Exec="\/home\/u\/Z\.AppImage" --autostart/);
  assert.deepEqual(a.set(false), { supported: true, enabled: false });
  assert.equal(Object.keys(files).length, 0);
});
test('autostart: Windows registers with --autostart, Mac without arguments', () => {
  const calls = [];
  const app = { isPackaged: true, setLoginItemSettings: (o) => calls.push(o), getLoginItemSettings: () => ({ openAtLogin: calls.at(-1)?.openAtLogin }) };
  const path = require('node:path');
  auto.createAutostart({ app, platform: 'win32', env: {}, fs: {}, path, homedir: 'C:\\u', execPath: 'C:\\Z\\Z.exe' }).set(true);
  assert.deepEqual(calls[0], { openAtLogin: true, args: ['--autostart'] });
  const r = auto.createAutostart({ app, platform: 'darwin', env: {}, fs: {}, path, homedir: '/Users/u', execPath: '/Applications/Z.app' }).set(false);
  assert.deepEqual(calls[1], { openAtLogin: false });
  assert.deepEqual(r, { supported: true, enabled: false });
});

// ---------- local pages: their one inline script must match the hash in their own CSP ----------
{
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  for (const f of ['src/offline.html', 'src/titlebar.html', 'src/identify.html', 'src/update.html']) {
    test(`${f}: CSP hash matches its script`, () => {
      const html = readFileSync(f, 'utf8');
      const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
      const hash = createHash('sha256').update(script).digest('base64');
      assert.ok(html.includes(`'sha256-${hash}'`), `expected sha256-${hash}`);
      assert.ok(!/<script\s+src=/i.test(html), 'no outside scripts');
    });
  }
}

// ---------- the page API: only these names, and the release name travels with the version ----------
test('preload exposes only the full-screen, autostart, display and extend calls', () => {
  const src = readFileSyncSafe('src/preload.js');
  for (const ch of src.match(/'zd:[a-z:]+'/g)) assert.ok(["'zd:fs'", "'zd:fs:get'", "'zd:fs:set'", "'zd:fs:toggle'", "'zd:autostart:get'", "'zd:autostart:set'", "'zd:displays'", "'zd:displays:get'", "'zd:displays:identify'", "'zd:displays:settings'", "'zd:displays:surface'", "'zd:displays:main'", "'zd:desks:set'", "'zd:lock'", "'zd:lock:get'", "'zd:lock:set'", "'zd:lock:request'", "'zd:lock:activity'", "'zd:window:send'", "'zd:window:arrived'", "'zd:window:receive'", "'zd:window:drag'", "'zd:window:drop'", "'zd:window:live'", "'zd:span:get'", "'zd:span:set'", "'zd:span:ready'", "'zd:keys:get'", "'zd:keys:set'", "'zd:keys:oslock'"].includes(ch), ch);
  assert.ok(/api: 9,/.test(src), 'api 9');
  assert.ok(!/require\('(?!electron')/.test(src), 'preload requires only electron');
});
test('main checks every Z request comes from Z itself', () => {
  const src = readFileSyncSafe('src/main.js');
  const handlers = src.match(/ipcMain\.handle\('zd:[a-z:]+', \([^)]*\) =>\s*\(?\s*from(Main)?Z\(e\)/g) || [];
  assert.equal(handlers.length, (src.match(/ipcMain\.handle\(/g) || []).length);
  assert.equal(handlers.length, 24);
  // What only Z's own window decides: extend on/off, span mode, the one-time window names, the main display, autostart, the lock.
  for (const ch of ['zd:desks:set', 'zd:displays:surface', 'zd:displays:main', 'zd:autostart:set', 'zd:lock:set', 'zd:span:set', 'zd:span:ready', 'zd:keys:set']) {
    assert.ok(new RegExp(`ipcMain\\.handle\\('${ch}', \\([^)]*\\) =>\\s*\\(?\\s*fromMainZ\\(e\\)`).test(src), ch);
  }
  // Asking to lock and reporting activity come only from a Z on an extra display, and go only to Z's own window.
  for (const ch of ['zd:lock:request', 'zd:lock:activity']) {
    assert.ok(new RegExp(`ipcMain\\.handle\\('${ch}', \\([^)]*\\) =>\\s*\\(?\\s*fromZ\\(e\\) && !fromMainZ\\(e\\)`).test(src), ch);
  }
  // A new page, a crash or a closed window of Z's own: every display shows the lock again.
  assert.equal((src.match(/lockMirror\.reset\(\)/g) || []).length, 3);
  // The Z on another display must be one of ours, its top frame, on Z's address.
  assert.ok(/desks\.displayOf\(wc\) !== null && !!frame && frame === wc\.mainFrame && cfg\.isAppUrl\(frame\.url\)/.test(src));
});

// ---------- displays (layer 0): read only, numbers only, fixed system-settings targets ----------
{
  const { createDisplays, describe, linuxSettingsTarget } = require('../src/displays.js');
  const listeners = {};
  const D = (id, x, w, h, scale, extra = {}) => ({ id, label: 'Mon ' + id, bounds: { x, y: 0, width: w, height: h }, workArea: { x, y: 0, width: w, height: h - 40 }, scaleFactor: scale, rotation: 0, displayFrequency: 60, internal: false, touchSupport: 'unknown', ...extra });
  let list = [D(1, 0, 1536, 960, 1.25, { internal: true, displayFrequency: 120 }), D(2, -1920, 1920, 1080, 1)];
  const fakeScreen = {
    getAllDisplays: () => list,
    getPrimaryDisplay: () => list[0],
    getDisplayMatching: () => list[1],
    on: (ev, fn) => (listeners[ev] = fn),
  };
  const timers = [];
  const fakeTimers = { setTimeout: (fn) => (timers.push(fn), timers.length), clearTimeout: () => {} };
  const sent = [], opened = [], spawned = [], made = [];
  class FakeWin {
    constructor(o) { this.o = o; this.destroyed = false; made.push(this); this.webContents = { on() {}, setWindowOpenHandler() {} }; }
    setIgnoreMouseEvents(v) { this.ignore = v; }
    once() {}
    loadFile(f, q) { this.file = f; this.query = q.query; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const mk = (platform, env = {}) => createDisplays({
    screen: fakeScreen, BrowserWindow: FakeWin, platform, env, identifyFile: 'identify.html', webPreferences: { sandbox: true },
    shell: { openExternal: (u) => (opened.push(u), Promise.resolve()) },
    spawn: (cmd, args) => (spawned.push([cmd, ...args]), { on() {}, unref() {} }),
    zWindow: () => ({ isDestroyed: () => false, getBounds: () => ({}) }),
    send: (s) => sent.push(s), timers: fakeTimers,
  });
  test('displays: snapshot describes every display in DIP and pixels', () => {
    const s = mk('win32').snapshot();
    assert.equal(s.displays.length, 2);
    const [a, b] = s.displays;
    assert.deepEqual(a.pixels, { width: 1920, height: 1200 });
    assert.equal(a.primary, true); assert.equal(a.internal, true); assert.equal(a.refreshRate, 120);
    assert.equal(b.hasZ, true); assert.equal(b.id, '2'); assert.equal(b.bounds.x, -1920);
    assert.equal(s.system.canChange, false);
  });
  test('displays: odd values are cleaned', () => {
    const d = describe({ id: 3, label: 'x'.repeat(200), bounds: { x: NaN }, scaleFactor: 0, rotation: 45 }, 1, 2);
    assert.equal(d.label.length, 80); assert.equal(d.scaleFactor, 1); assert.equal(d.rotation, 0); assert.equal(d.bounds.x, 0);
  });
  test('displays: a burst of system events reaches Z once', () => {
    const m = mk('win32'); m.listen();
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(typeof listeners[ev], 'function');
    sent.length = 0; timers.length = 0;
    listeners['display-added'](); listeners['display-metrics-changed'](); listeners['display-metrics-changed']();
    timers[timers.length - 1]();
    assert.equal(sent.length, 1);
  });
  test('displays: identify shows numbers 1..n, click-through, then closes', () => {
    made.length = 0; timers.length = 0;
    const m = mk('win32');
    assert.deepEqual(m.identify(), { shown: 2 });
    assert.deepEqual(made.map((w) => w.query.n), ['1', '2']);
    assert.ok(made.every((w) => w.ignore === true && w.o.focusable === false && w.o.frame === false));
    assert.deepEqual(m.identify(), { shown: 2 }, 'a second press while showing opens nothing new');
    assert.equal(made.length, 2);
    timers[timers.length - 1]();
    assert.ok(made.every((w) => w.destroyed));
  });
  test('displays: system settings open only fixed targets', () => {
    opened.length = 0; spawned.length = 0;
    mk('win32').openSystemSettings(); mk('darwin').openSystemSettings();
    assert.deepEqual(opened, ['ms-settings:display', 'x-apple.systempreferences:com.apple.Displays-Settings.extension']);
    assert.deepEqual(mk('linux', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }).openSystemSettings(), { opened: true });
    assert.deepEqual(spawned[0], ['gnome-control-center', 'display']);
    assert.deepEqual(mk('linux', { XDG_CURRENT_DESKTOP: 'XFCE' }).openSystemSettings(), { opened: false });
    assert.equal(linuxSettingsTarget({ XDG_CURRENT_DESKTOP: 'KDE' }).cmd, 'systemsettings');
    assert.equal(mk('linux', { XDG_SESSION_TYPE: 'wayland' }).snapshot().system.wayland, true);
  });
  test('identify page shows only a small number', () => {
    const html = readFileSyncSafe('src/identify.html');
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes('/^[1-9][0-9]?$/'));
    assert.ok(!/<script\s+src=/i.test(html));
  });
}

// ---------- extend (api 3): blank windows only with a fresh one-time name from Z, one per display ----------
{
  const { createSurfaces, NAME_TTL_MS } = require('../src/surfaces.js');
  const D = (id, x) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 }, workArea: { x, y: 0, width: 1920, height: 1040 } });
  let list = [D(1, 0), D(2, 1920)];
  let t = 1000;
  let n = 0;
  const prefs = { mainDisplay: null };
  let saved = 0;
  const mk = (isMac = false) => createSurfaces({
    screen: { getAllDisplays: () => list },
    randomBytes: (k) => Buffer.alloc(k, ++n),
    now: () => t,
    isMac,
    prefs,
    savePrefs: () => (saved += 1),
  });
  const fakeWin = () => {
    const ev = {};
    const w = {
      destroyed: false, fs: false, simple: false, shown: false, handlers: {}, deny: null,
      isDestroyed: () => w.destroyed, destroy: () => { w.destroyed = true; (ev.closed || (() => {}))(); },
      setFullScreen: (on) => (w.fs = on), setSimpleFullScreen: (on) => (w.simple = on), showInactive: () => (w.shown = true),
      top: false, setAlwaysOnTop: (on) => (w.top = on), b: null, setBounds: (b) => (w.b = b),
      on: (name, fn) => (ev[name] = fn),
      webContents: { on: (name, fn) => (w.handlers[name] = fn), setWindowOpenHandler: (fn) => (w.deny = fn) },
    };
    return w;
  };
  test('extend: a name works once, only fresh, only for a connected display', () => {
    const s = mk();
    assert.equal(s.prepare('9'), null, 'unknown display');
    const { name } = s.prepare('2');
    assert.match(name, /^zsurface-[0-9a-f]{32}$/);
    assert.equal(s.claim('zsurface-' + '0'.repeat(32), {}), null, 'a guessed name');
    assert.equal(s.claim('evil', {}), null);
    const c = s.claim(name, { sandbox: true });
    assert.equal(c.displayId, '2');
    assert.deepEqual([c.options.x, c.options.width, c.options.frame, c.options.skipTaskbar], [1920, 1920, false, true]);
    const w = createSurfaces({ screen: { getAllDisplays: () => list }, randomBytes: (k) => Buffer.alloc(k, 7), isMac: false, isWin: true, prefs, savePrefs: () => {} });
    assert.equal(w.claim(w.prepare('2').name, {}).options.skipTaskbar, false, 'Windows: the taskbar steps aside only for a window it knows');
    assert.deepEqual(c.options.webPreferences, { sandbox: true });
    assert.equal(s.claim(name, {}), null, 'single use');
    const late = s.prepare('2').name;
    t += NAME_TTL_MS + 1;
    assert.equal(s.claim(late, {}), null, 'expired');
  });
  test('extend: the window is locked down, covers its display, and goes with it', () => {
    const s = mk();
    const { name } = s.prepare('2');
    s.claim(name, {});
    assert.equal(s.displayOfOpening(name), '2');
    assert.equal(s.displayOfOpening(name), null, 'once');
    const w = fakeWin();
    s.adopt(w, '2');
    assert.ok(w.shown && w.fs && !w.simple);
    assert.equal(w.deny().action, 'deny');
    let stopped = false;
    w.handlers['will-navigate']({ preventDefault: () => (stopped = true) });
    assert.ok(stopped, 'no navigation');
    assert.equal(s.count(), 1);
    list = [D(1, 0)];
    s.prune();
    assert.ok(w.destroyed);
    assert.equal(s.count(), 0);
    list = [D(1, 0), D(2, 1920)];
    const m = mk(true);
    const w2 = fakeWin();
    m.adopt(w2, '2');
    assert.ok(w2.simple && !w2.fs, 'Mac keeps it on its display without a new Space');
    m.closeAll();
    assert.ok(w2.destroyed);
  });
  test('extend: the main display is remembered and Z starts there', () => {
    const s = mk();
    assert.equal(s.startBounds(), null);
    const ev = {};
    const win = { isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false, unmaximize() {}, setBounds: (b) => (win.b = b), maximize: () => (win.max = true), once: (k, f) => (ev[k] = f), setFullScreen() {} };
    assert.deepEqual(s.moveMain(win, '9'), { ok: false });
    assert.deepEqual(s.moveMain(win, '2'), { ok: true });
    assert.equal(prefs.mainDisplay, '2');
    assert.equal(saved, 1);
    assert.deepEqual(win.b, { x: 1920, y: 0, width: 1920, height: 1040 });
    assert.deepEqual(s.startBounds(), { x: 1920, y: 0, width: 1920, height: 1040 });
    list = [D(1, 0)];
    assert.equal(s.startBounds(), null, 'unplugged: start where the system puts it');
    list = [D(1, 0), D(2, 1920)];
  });
  test('extend: above the taskbar only while Z has the focus (not on Mac)', () => {
    const s = mk();
    const w = fakeWin();
    s.adopt(w, '2');
    assert.equal(w.top, false);
    const main = { fs: true, top: false, isDestroyed: () => false, isFullScreen: () => main.fs, setAlwaysOnTop: (on) => (main.top = on) };
    s.setActive(true, main);
    assert.ok(w.top && main.top);
    assert.ok(s.owns(w) && !s.owns(main));
    const w3 = fakeWin();
    s.adopt(w3, '1');
    assert.ok(w3.top, 'a window that opens while Z is active goes above too');
    s.setActive(false, main);
    assert.ok(!w.top && !w3.top && !main.top);
    main.fs = false;
    s.setActive(true, main);
    assert.ok(w.top && !main.top, 'a framed Z window keeps the taskbar');
    s.closeAll();
    const m = mk(true);
    const wm = fakeWin();
    m.adopt(wm, '2');
    m.setActive(true, null);
    assert.equal(wm.top, false, 'Mac: never lifted');
    m.closeAll();
  });
  test('extend: the displays follow Z in and out of full screen, together', () => {
    const s = mk();
    const w = fakeWin();
    s.adopt(w, '2');
    assert.ok(w.fs, 'Z opens full screen, so does every display');
    s.setActive(true, null);
    assert.ok(w.top);
    s.followFullScreen(false);
    assert.ok(!w.fs && !w.top, 'out of full screen: the taskbar shows again');
    assert.deepEqual(w.b, { x: 1920, y: 0, width: 1920, height: 1040 }, 'the work area of its display');
    const w3 = fakeWin();
    s.adopt(w3, '1');
    assert.ok(!w3.fs && w3.b.width === 1920, 'a display that joins now is not full screen either');
    s.followFullScreen(true);
    assert.ok(w.fs && w3.fs && w.top && w3.top);
    s.closeAll();
    const src = readFileSyncSafe('src/main.js');
    assert.ok(src.includes('if (surfaces) surfaces.followFullScreen(true);') && src.includes('if (surfaces) surfaces.followFullScreen(false);'));
  });
  test('extend: moving Z to the display it is on does nothing; a move fades and never stays hidden', () => {
    const s0 = createSurfaces({
      screen: { getAllDisplays: () => list, getDisplayMatching: (b) => list.find((d) => d.bounds.x === b.x) },
      randomBytes: (k) => Buffer.alloc(k, 1), isMac: false, prefs, savePrefs: () => {},
    });
    const ev = {};
    const win = {
      b: { x: 0, y: 0, width: 1920, height: 1040 }, fs: true, op: [], isDestroyed: () => false, getBounds: () => win.b,
      isFullScreen: () => win.fs, isMaximized: () => false, unmaximize() {}, maximize() {}, setBounds: (b) => (win.b = b),
      setOpacity: (v) => win.op.push(v), once: (k, f) => (ev[k] = f), setFullScreen: (on) => (win.fs = on),
    };
    assert.deepEqual(s0.moveMain(win, '1'), { ok: true });
    assert.deepEqual(win.op, [], 'already there');
    assert.equal(prefs.mainDisplay, '1');
    s0.moveMain(win, '2');
    assert.deepEqual(win.op, [0]);
    assert.ok(s0.moving(), 'main skips its own maximize while moving');
    ev['leave-full-screen']();
    assert.equal(win.b.x, 1920);
    assert.ok(win.fs);
    ev['enter-full-screen']();
    assert.deepEqual(win.op, [0, 1]);
    assert.ok(!s0.moving());
    const src = readFileSyncSafe('src/main.js');
    assert.ok(src.includes("if (!win.isMaximized() && !(surfaces && surfaces.moving())) win.maximize();"));
    assert.ok(src.includes("app.on('browser-window-blur', checkFocus);"));
  });
  test('extend: main checks the blank window comes from Z view with a claimed name', () => {
    const src = readFileSyncSafe('src/main.js');
    assert.ok(/if \(blank && surfaces && zView && wc === zView\.webContents\) \{\s*const s = surfaces\.claim\(frameName, secureWebPreferences\(false\)\);/.test(src));
    assert.ok(src.includes("if (blank) return { action: 'deny' };"), 'every other blank window is refused');
    assert.ok(src.includes("zView.webContents.on('did-navigate', () => surfaces && surfaces.closeAll());"), 'a new page of Z closes them');
    assert.ok(src.includes("zView.webContents.on('render-process-gone', () => surfaces && surfaces.closeAll());"), 'a crashed Z closes them');
  });
}
// ---------- extend, way A (api 4): a whole Z on every extra display ----------
{
  const { createDesks } = require('../src/desks.js');
  const D = (id, x) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 }, workArea: { x, y: 0, width: 1920, height: 1040 } });
  const made = [];
  class FakeWin {
    constructor(o) {
      this.o = o; this.ev = {}; this.once_ = {}; this.destroyed = false; this.fs = false; this.simple = false; this.top = false; this.b = null; this.url = '';
      this.wcev = {}; this.reloads = 0;
      this.webContents = { on: (k, f) => (this.wcev[k] = f), reload: () => this.reloads++, setUserAgent: (u) => (this.ua = u), isDestroyed: () => this.destroyed, send() {} };
      made.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; (this.ev.closed || (() => {}))(); }
    on(k, f) { this.ev[k] = f; }
    once(k, f) { this.once_[k] = f; }
    loadURL(u) { this.url = u; }
    showInactive() { this.shown = true; }
    setFullScreen(on) { this.fs = on; }
    setSimpleFullScreen(on) { this.simple = on; }
    setAlwaysOnTop(on) { this.top = on; }
    setBounds(b) { this.b = b; }
    getBounds() { return this.b || { x: 0, y: 0, width: 0, height: 0 }; }
  }
  const mk = (list, main, opts = {}) => createDesks({
    BrowserWindow: FakeWin, screen: { getAllDisplays: () => list.v }, isMac: false, isWin: false,
    webPreferences: (id) => ({ display: id }), startUrl: 'https://orvalen.me/', userAgent: 'ua', mainDisplayId: () => main.v, ...opts,
  });
  test('desks: off by default; on = a whole Z on every display but the main one', () => {
    made.length = 0;
    const list = { v: [D(1, 0), D(2, 1920), D(3, -1920)] };
    const main = { v: '1' };
    const d = mk(list, main);
    d.sync();
    assert.equal(d.count(), 0, 'off until Z turns it on');
    d.setEnabled(true);
    assert.equal(d.count(), 2);
    assert.deepEqual(made.map((w) => w.o.webPreferences.display).sort(), ['2', '3']);
    assert.ok(made.every((w) => w.url === 'https://orvalen.me/' && w.o.frame === false && w.o.show === false && w.o.skipTaskbar === true));
    made[0].once_['ready-to-show']();
    assert.ok(made[0].shown && made[0].fs, 'shown without focus, full screen like Z');
    assert.equal(d.displayOf(made[0].webContents), String(made[0].o.webPreferences.display));
    assert.equal(d.displayOf({}), null, 'a stranger web contents is not one of ours');
    d.setEnabled(false);
    assert.equal(d.count(), 0);
    assert.ok(made.every((w) => w.destroyed));
  });
  test('desks: follows the displays and the main display; a window the person closed stays closed', () => {
    made.length = 0;
    const list = { v: [D(1, 0), D(2, 1920)] };
    const main = { v: '1' };
    const d = mk(list, main);
    d.setEnabled(true);
    assert.equal(made.length, 1);
    main.v = '2';
    d.sync();
    assert.ok(made[0].destroyed, 'Z moved there: that display needs no extra Z');
    assert.equal(made[1].o.webPreferences.display, '1', 'the display it left gets one');
    made[1].destroy();
    d.sync();
    assert.equal(d.count(), 0, 'closed by the person: stays closed');
    list.v = [D(2, 1920)];
    d.sync();
    list.v = [D(1, 0), D(2, 1920)];
    d.sync();
    assert.equal(d.count(), 1, 'the display came back: a new Z');
    d.closeAll();
  });
  test('desks: a crashed Z loads again (3 times, then its window closes); a failed load tries again, waiting longer each time', () => {
    made.length = 0;
    const list = { v: [D(1, 0), D(2, 1920)] };
    const d = mk(list, { v: '1' });
    d.setEnabled(true);
    const w = made[0];
    for (let i = 0; i < 3; i++) w.wcev['render-process-gone']();
    assert.equal(w.reloads, 3);
    assert.equal(d.count(), 1);
    w.wcev['render-process-gone']();
    assert.ok(w.destroyed, 'the fourth crash closes it');
    assert.equal(d.count(), 0);
    d.sync();
    assert.equal(d.count(), 1, 'not counted as closed by the person: the next sync brings a new one');
    const w2 = made[1];
    const realSetTimeout = globalThis.setTimeout;
    const later = [];
    globalThis.setTimeout = (fn, ms) => later.push([fn, ms]);
    try {
      w2.url = '';
      w2.wcev['did-fail-load']({}, -3, '', '', true);
      w2.wcev['did-fail-load']({}, -105, '', '', false);
      assert.equal(later.length, 0, 'a replaced navigation or a frame inside is not a failure');
      w2.wcev['did-fail-load']({}, -105, '', '', true);
      w2.wcev['did-fail-load']({}, -105, '', '', true);
      assert.equal(later.length, 1, 'one try waits at a time');
      const run = () => later.splice(0).forEach(([fn]) => fn());
      run();
      assert.equal(w2.url, 'https://orvalen.me/');
      const waits = [5000];
      for (let i = 0; i < 6; i++) {
        w2.wcev['did-fail-load']({}, -105, '', '', true);
        waits.push(later[0][1]);
        run();
      }
      assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000, 60000], 'longer each time, a minute at most');
      w2.wcev['did-finish-load']();
      w2.wcev['did-fail-load']({}, -105, '', '', true);
      assert.equal(later[0][1], 5000, 'a load that finished starts the count again');
      run();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    d.closeAll();
  });
  test('desks: full screen together, above the taskbar only while Z has the focus; Windows keeps the taskbar entry', () => {
    made.length = 0;
    const list = { v: [D(1, 0), D(2, 1920)] };
    const d = mk(list, { v: '1' });
    d.setEnabled(true);
    const w = made[0];
    w.once_['ready-to-show']();
    d.setActive(true);
    assert.ok(w.top);
    d.followFullScreen(false);
    assert.ok(!w.fs && !w.top);
    assert.deepEqual(w.b, { x: 1920, y: 0, width: 1920, height: 1040 });
    d.followFullScreen(true);
    assert.ok(w.fs && w.top);
    d.followFullScreen(false);
    list.v = [D(1, 0), { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }];
    d.sync();
    assert.deepEqual(w.b, { x: 1920, y: 0, width: 2560, height: 1400 }, 'the display changed size: its Z covers it again');
    assert.equal(d.count(), 1, 'the same Z, not a new one');
    d.closeAll();
    made.length = 0;
    const win = mk(list, { v: '1' }, { isWin: true });
    win.setEnabled(true);
    assert.equal(made[0].o.skipTaskbar, false);
    win.closeAll();
  });
}
// ---------- extend, way A, layer 3 (api 5): one lock for every display, opened only on the main display ----------
{
  const { createLockMirror, ACTIVITY_EVERY_MS } = require('../src/lockMirror.js');
  test('lock: starts locked; only "unlocked by a profile" unlocks; anything else is locked', () => {
    const sent = [];
    const m = createLockMirror({ send: (s) => sent.push(s) });
    assert.deepEqual(m.get(), { locked: true, profile: null }, 'not knowing means locked');
    assert.deepEqual(m.set({ locked: false, profile: 'p_1' }), { locked: false, profile: 'p_1' });
    assert.equal(sent.length, 1);
    m.set({ locked: false, profile: 'p_1' });
    assert.equal(sent.length, 1, 'no change, nothing sent');
    for (const bad of [null, 'open', {}, { locked: 0 }, { locked: false }, { locked: false, profile: '' }, { locked: false, profile: 'a b' }, { locked: false, profile: 'x'.repeat(129) }, { locked: false, profile: 7 }]) {
      m.set({ locked: false, profile: 'p_1' });
      assert.deepEqual(m.set(bad), { locked: true, profile: null }, JSON.stringify(bad));
    }
    m.set({ locked: false, profile: 'p_2' });
    m.reset();
    assert.deepEqual(m.get(), { locked: true, profile: null });
    assert.ok(Object.isFrozen(m.get()));
  });
  test('lock: activity from an extra display reaches Z\'s own window at most once every few seconds', () => {
    let t = 1000;
    const m = createLockMirror({ send() {}, now: () => t });
    assert.equal(m.activity(), true);
    t += ACTIVITY_EVERY_MS - 1;
    assert.equal(m.activity(), false);
    t += 1;
    assert.equal(m.activity(), true);
  });
}
// ---------- extend, way A, layer 4 (api 6): a window dragged off one display opens on the display under the cursor ----------
{
  const { createWindowMove, cleanWindow, MAX_PARAMS, ARRIVE_MS, MIN_GAP_MS } = require('../src/windowMove.js');
  const d1 = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const d2 = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };
  const setup = (opts = {}) => {
    const sent = [];
    const wc2 = { send: (ch, v) => sent.push([ch, v]), isDestroyed: () => false };
    let cursor = opts.cursor || { x: 2000, y: 100 };
    let t = 1000;
    const timers = [];
    let n = 0;
    const m = createWindowMove({
      screen: { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: (p) => (p.x >= 1920 ? d2 : d1) },
      isLocked: () => opts.locked === true,
      profileOf: () => (opts.profile === undefined ? 'p1' : opts.profile),
      senderDisplay: (s) => (s === 'main' ? '1' : s === 'desk2' ? '2' : null),
      targetOf: (id) => (id === '2' ? wc2 : null),
      now: () => t,
      setTimer: (fn, ms) => { const h = { fn, ms, on: true }; timers.push(h); return h; },
      clearTimer: (h) => { h.on = false; },
      newToken: () => `tok${++n}`,
    });
    const fire = () => timers.filter((h) => h.on).forEach((h) => { h.on = false; h.fn(); });
    return { m, sent, wc2, move: (c) => (cursor = c), tick: (ms) => (t += ms), fire, timers };
  };
  const spec = { appId: 'zdocs', windowKey: 'zdocs:abc', title: 'Doc', params: { file: 'f1' }, w: 900, h: 600, grabX: 40, grabY: 12 };
  test('move: the window goes to the Z on the display under the cursor, placed where the cursor is, closed here only once it opened there', async () => {
    const { m, sent, wc2, timers } = setup();
    let done = null;
    const p = m.send('main', spec).then((r) => (done = r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'zd:window:receive');
    assert.deepEqual(sent[0][1], { appId: 'zdocs', windowKey: 'zdocs:abc', title: 'Doc', params: { file: 'f1' }, w: 900, h: 600, grabX: 40, grabY: 12, x: 80, y: 100, token: 'tok1', profile: 'p1' });
    await Promise.resolve();
    assert.equal(done, null, 'sent is not arrived');
    assert.deepEqual(m.arrived('main', { token: 'tok1', ok: true }), { ok: false }, 'only the Z it was sent to answers');
    assert.deepEqual(m.arrived(wc2, { token: 'tok9', ok: true }), { ok: false }, 'an unknown token');
    assert.deepEqual(m.arrived(wc2, { token: 'tok1', ok: true }), { ok: true });
    assert.deepEqual(await p, { ok: true });
    assert.equal(timers[0].on, false, 'the wait ends');
    assert.deepEqual(m.arrived(wc2, { token: 'tok1', ok: true }), { ok: false }, 'only once');
  });
  test('move: a target that refuses or does not answer keeps the window where it was; a late answer is told so', async () => {
    const a = setup();
    const pa = a.m.send('main', spec);
    assert.deepEqual(a.m.arrived(a.wc2, { token: 'tok1', ok: false }), { ok: true });
    assert.deepEqual(await pa, { ok: false }, 'refused');
    const b = setup();
    const pb = b.m.send('main', spec);
    assert.equal(b.timers[0].ms, ARRIVE_MS);
    b.fire();
    assert.deepEqual(await pb, { ok: false }, 'no answer in time');
    assert.deepEqual(b.m.arrived(b.wc2, { token: 'tok1', ok: true }), { ok: false }, 'too late: the target closes what it opened');
    const c = setup();
    c.wc2.send = () => { throw new Error('gone'); };
    assert.deepEqual(await c.m.send('main', spec), { ok: false }, 'the target went away');
  });
  test('move: one move in flight per sender, at most 5 a second', async () => {
    const { m, wc2, tick, sent } = setup();
    const first = m.send('main', spec);
    assert.deepEqual(await m.send('main', spec), { ok: false }, 'while one is in flight');
    m.arrived(wc2, { token: 'tok1', ok: true });
    await first;
    assert.deepEqual(await m.send('main', spec), { ok: false }, 'too soon after the last');
    tick(MIN_GAP_MS);
    m.send('main', spec);
    assert.equal(sent.length, 2);
  });
  test('move: nothing moves while locked, onto the same display, to a display without Z, or from a stranger', async () => {
    assert.deepEqual(await setup({ locked: true }).m.send('main', spec), { ok: false }, 'locked');
    assert.deepEqual(await setup({ profile: null }).m.send('main', spec), { ok: false }, 'no profile unlocked Z');
    const same = setup({ cursor: { x: 100, y: 100 } });
    assert.deepEqual(await same.m.send('main', spec), { ok: false }, 'cursor still on the sender display');
    assert.deepEqual(await setup().m.send('desk2', spec), { ok: false }, 'back onto its own display');
    assert.deepEqual(await setup().m.send('stranger', spec), { ok: false });
    const off = setup({ cursor: { x: 9000, y: 100 } });
    assert.deepEqual(await off.m.send('main', spec), { ok: false }, 'cursor outside every display');
    assert.equal(same.sent.length + off.sent.length, 0);
  });
  test('move: only a clean description crosses', () => {
    for (const bad of [null, 'x', {}, { appId: '../x' }, { appId: 'a'.repeat(65) }, { appId: 'ok', params: 'str' }, { appId: 'ok', params: { big: 'x'.repeat(MAX_PARAMS) } }]) {
      assert.equal(cleanWindow(bad), null, JSON.stringify(bad)?.slice(0, 40));
    }
    const loop = { appId: 'ok', params: {} };
    loop.params.self = loop.params;
    assert.equal(cleanWindow(loop), null, 'params that are not plain JSON');
    const c = cleanWindow({ appId: 'ok', windowKey: '', title: 5, w: 1e9, h: -3, grabX: NaN, extra: 'no', params: { f: () => 1, n: 2 } });
    assert.deepEqual(c, { appId: 'ok', windowKey: null, title: null, params: { n: 2 }, w: null, h: null, grabX: 0, grabY: 0 });
  });
}
// ---------- extend, layer 6 (api 7): a window dragged across displays moves with the hand ----------
{
  const { createWindowLive, FOLLOW_MS, LIVE_MAX_MS, MIN_GAP_MS: LIVE_GAP } = require('../src/windowLive.js');
  const { ARRIVE_MS } = require('../src/windowMove.js');
  const d1 = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const d2 = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };
  const d3 = { id: 3, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } };
  const setup = (opts = {}) => {
    const got = { 2: [], 3: [] };
    const wc2 = { send: (ch, v) => got[2].push([ch, v]), isDestroyed: () => false };
    const wc3 = { send: (ch, v) => got[3].push([ch, v]), isDestroyed: () => false };
    let cursor = opts.cursor || { x: 100, y: 100 };
    let t = 1000;
    let locked = opts.locked === true;
    const timers = [];
    let n = 0;
    const L = createWindowLive({
      screen: { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: (p) => (p.x >= 1920 ? d2 : p.x < 0 ? d3 : d1) },
      isLocked: () => locked,
      profileOf: () => (opts.profile === undefined ? 'p1' : opts.profile),
      senderDisplay: (s) => (s === 'main' ? '1' : null),
      targetOf: (id) => (id === '2' ? wc2 : id === '3' ? wc3 : null),
      now: () => t,
      setTimer: (fn, ms) => { const h = { fn, ms, on: true }; timers.push(h); return h; },
      clearTimer: (h) => { h.on = false; },
      newToken: () => String(++n).padStart(32, 'a'),
    });
    // one follow tick (the newest one still waiting)
    const tick = () => { const h = timers.filter((x) => x.on && x.ms === FOLLOW_MS).pop(); if (h) { h.on = false; h.fn(); } };
    const fireArrive = () => timers.filter((x) => x.on && x.ms === ARRIVE_MS).forEach((h) => { h.on = false; h.fn(); });
    return { L, got, wc2, wc3, move: (c) => (cursor = c), later: (ms) => (t += ms), lock: () => (locked = true), tick, fireArrive, timers };
  };
  const spec = { appId: 'zdocs', windowKey: 'zdocs:abc', title: 'Doc', params: { file: 'f1' }, w: 900, h: 600, grabX: 40, grabY: 12 };
  const kinds = (list) => list.map(([ch, v]) => `${ch === 'zd:window:live' ? '' : ch + ' '}${v.kind}`);
  test('carry: enter when the cursor reaches the other display, follow while it moves there, land and close here only once it is there', async () => {
    const { L, got, wc2, move, tick } = setup();
    const r = L.start('main', spec);
    assert.equal(r.ok, true);
    const token = r.token;
    assert.equal(got[2].length, 0, 'nothing while the cursor is still on its own display');
    move({ x: 1930, y: 200 });
    tick();
    assert.deepEqual(got[2][0], ['zd:window:live', { kind: 'enter', appId: 'zdocs', windowKey: 'zdocs:abc', title: 'Doc', params: { file: 'f1' }, w: 900, h: 600, grabX: 40, grabY: 12, x: 10, y: 200, token, profile: 'p1' }]);
    tick();
    assert.equal(got[2].length, 1, 'no follow when the cursor did not move');
    move({ x: 1990, y: 210 });
    tick();
    assert.deepEqual(got[2][1][1], { kind: 'follow', token, x: 70, y: 210 });
    let done = null;
    const p = L.drop('main', { token, drop: true }).then((v) => (done = v));
    assert.deepEqual(got[2][2][1], { kind: 'land', token, x: 70, y: 210 });
    assert.equal(L.owns(token), true);
    await Promise.resolve();
    assert.equal(done, null, 'let go is not arrived');
    assert.deepEqual(L.arrived('main', { token, ok: true }), { ok: false }, 'only the Z it landed on answers');
    assert.deepEqual(L.arrived(wc2, { token, ok: true }), { ok: true });
    assert.deepEqual(await p, { ok: true });
    assert.deepEqual(L.arrived(wc2, { token, ok: true }), { ok: false }, 'only once');
    tick();
    assert.equal(got[2].length, 3, 'the carry stopped');
  });
  test('carry: back onto its own display or on to a third display, the Z it left closes what it opened', () => {
    const { L, got, move, tick } = setup();
    const { token } = L.start('main', spec);
    move({ x: 2000, y: 10 });
    tick();
    move({ x: 500, y: 10 });
    tick();
    assert.deepEqual(kinds(got[2]), ['enter', 'leave']);
    move({ x: -100, y: 10 });
    tick();
    assert.deepEqual(kinds(got[3]), ['enter']);
    move({ x: 2100, y: 10 });
    tick();
    assert.deepEqual(kinds(got[3]), ['enter', 'leave']);
    assert.deepEqual(kinds(got[2]), ['enter', 'leave', 'enter']);
    assert.ok(got[2].every(([, v]) => v.token === token));
  });
  test('carry: let go on its own display, no answer in time, or a refusal: the window stays here and the other Z closes its copy', async () => {
    const a = setup();
    const ta = a.L.start('main', spec).token;
    a.move({ x: 2000, y: 10 });
    a.tick();
    a.move({ x: 300, y: 10 });
    assert.deepEqual(await a.L.drop('main', { token: ta, drop: true }), { ok: false }, 'let go back home');
    assert.deepEqual(kinds(a.got[2]), ['enter', 'leave']);
    const b = setup();
    const tb = b.L.start('main', spec).token;
    b.move({ x: 2000, y: 10 });
    b.tick();
    const pb = b.L.drop('main', { token: tb, drop: true });
    b.fireArrive();
    assert.deepEqual(await pb, { ok: false }, 'no answer in time');
    assert.deepEqual(kinds(b.got[2]), ['enter', 'land', 'leave']);
    assert.deepEqual(b.L.arrived(b.wc2, { token: tb, ok: true }), { ok: false }, 'too late');
    const c = setup();
    const tc = c.L.start('main', spec).token;
    c.move({ x: 2000, y: 10 });
    c.tick();
    const pc = c.L.drop('main', { token: tc, drop: true });
    c.L.arrived(c.wc2, { token: tc, ok: false });
    assert.deepEqual(await pc, { ok: false }, 'refused');
    const l = setup();
    const tl = l.L.start('main', spec).token;
    l.move({ x: 2000, y: 10 });
    l.tick();
    const pl = l.L.drop('main', { token: tl, drop: true });
    l.lock();
    assert.deepEqual(l.L.arrived(l.wc2, { token: tl, ok: true }), { ok: false }, 'the target is told no: it closes its copy');
    assert.deepEqual(await pl, { ok: false }, 'locked while it landed');
    assert.deepEqual(kinds(l.got[2]), ['enter', 'land', 'leave']);
    const d = setup();
    const td = d.L.start('main', spec).token;
    d.move({ x: 2000, y: 10 });
    d.tick();
    assert.deepEqual(await d.L.drop('main', { token: td, drop: false }), { ok: false }, 'the drag ended without a let go');
    assert.deepEqual(kinds(d.got[2]), ['enter', 'leave']);
    assert.deepEqual(await d.L.drop('main', { token: td, drop: true }), { ok: false }, 'a carry ends once');
  });
  test('carry: locked, no profile, a stranger, a bad description or token, too often, or too long: nothing is carried', async () => {
    assert.equal(setup({ locked: true }).L.start('main', spec).ok, false, 'locked');
    assert.equal(setup({ profile: null }).L.start('main', spec).ok, false, 'no profile');
    assert.equal(setup().L.start('stranger', spec).ok, false, 'not a Z on a display');
    assert.equal(setup().L.start('main', { appId: '../x' }).ok, false, 'bad description');
    const s = setup();
    const t1 = s.L.start('main', spec).token;
    assert.equal(s.L.start('main', spec).ok, false, 'too soon');
    assert.deepEqual(await s.L.drop('main', { token: 'nope', drop: true }), { ok: false }, 'bad token');
    assert.deepEqual(await s.L.drop('other', { token: t1, drop: true }), { ok: false }, 'another Z');
    s.later(LIVE_GAP);
    const t2 = s.L.start('main', spec).token;
    assert.notEqual(t1, t2, 'a new start replaces the old carry');
    assert.deepEqual(await s.L.drop('main', { token: t1, drop: true }), { ok: false });
    s.move({ x: 2000, y: 10 });
    s.tick();
    s.later(LIVE_MAX_MS + 1);
    s.tick();
    assert.deepEqual(kinds(s.got[2]), ['enter', 'leave'], 'a carry that never ends stops by itself');
    const k = setup();
    const tk = k.L.start('main', spec).token;
    k.move({ x: 2000, y: 10 });
    k.tick();
    k.lock();
    k.tick();
    assert.deepEqual(kinds(k.got[2]), ['enter', 'leave'], 'Z locked mid-carry');
    assert.deepEqual(await k.L.drop('main', { token: tk, drop: true }), { ok: false });
  });
  test('carry: main sends the right answers to the right part and checks every request comes from Z', () => {
    const main = readFileSyncSafe('src/main.js');
    assert.ok(/ipcMain\.handle\('zd:window:drag', \(e, spec\) => \(fromZ\(e\) && windowLive \?/.test(main));
    assert.ok(/ipcMain\.handle\('zd:window:drop', \(e, answer\) => \(fromZ\(e\) && windowLive \?/.test(main));
    assert.ok(/windowLive\.owns\(answer\.token\) \? windowLive\.arrived\(e\.sender, answer\) : windowMove\.arrived\(e\.sender, answer\)/.test(main));
  });
}
test('navigation: the top stays on Z, frames inside Z follow their own redirects', () => {
  const { createNavigationGuard } = require('../src/navGuard.js');
  const opened = [];
  let google = 0;
  const guard = createNavigationGuard({ cfg, offlineUrl: 'file:///z/offline.html', openOutside: (u) => opened.push(u), explainGoogle: () => google++ });
  const ev = (isMainFrame) => ({ isMainFrame, stopped: false, preventDefault() { this.stopped = true; } });
  const run = (url, main) => { const e = ev(main); guard(e, url); return e.stopped; };
  // a site in a ZeuS frame redirects (example.com -> www.example.com): it stays in its frame
  assert.equal(run('https://www.example.com/home', false), false);
  assert.equal(run('https://accounts.google.com/x', false), false);
  // the top of the window leaving Z is stopped and opens outside; Google gets the explanation
  assert.equal(run('https://evil.example/', true), true);
  assert.equal(run('https://accounts.google.com/o/oauth2/auth', true), true);
  // no isMainFrame (unknown) counts as the top
  assert.equal(run('https://evil.example/2', undefined), true);
  // Z itself and the offline page stay
  assert.equal(run(cfg.START_URL, true), false);
  assert.equal(run('file:///z/offline.html?r=1', true), false);
  assert.deepEqual(opened, ['https://evil.example/', 'https://evil.example/2']);
  assert.equal(google, 1);
  const main = readFileSyncSafe('src/main.js');
  assert.ok(/wc\.on\('will-navigate', onNavigate\)/.test(main) && /wc\.on\('will-redirect', onNavigate\)/.test(main));
  assert.ok(/createNavigationGuard\(/.test(main));
});

// ---------- the update screen at start (O 28.11) ----------
test('update screen: only its own page and two words act; everything about it is stopped', () => {
  const { createNavigationGuard, updateAction } = require('../src/navGuard.js');
  const U = 'file:///z/update.html';
  assert.equal(updateAction(U + '?do=update', U), 'update');
  assert.equal(updateAction(U + '?do=later', U), 'later');
  assert.equal(updateAction(U + '?do=rm', U), '');
  assert.equal(updateAction('file:///z/other.html?do=update', U), null);
  assert.equal(updateAction('https://orvalen.me/?do=update', U), null);
  const acts = [], opened = [];
  const guard = createNavigationGuard({ cfg, offlineUrl: 'file:///z/offline.html', openOutside: (u) => opened.push(u), explainGoogle() {}, updateUrl: U, onUpdateAction: (w) => acts.push(w) });
  const ev = () => ({ isMainFrame: true, stopped: false, preventDefault() { this.stopped = true; } });
  for (const u of [U + '?do=update', U + '?do=later', U + '?do=x', U]) { const e = ev(); guard(e, u); assert.ok(e.stopped, u); }
  assert.deepEqual(acts, ['update', 'later']);
  assert.deepEqual(opened, []);
});
test('update screen: release notes are short plain lines', () => {
  const { releaseNotes } = require('../src/updates.js');
  assert.deepEqual(releaseNotes('## Title\n- **Bold** item\n* [link](https://x) two\n1. three `code`\nplain text\n'), ['Bold item', 'link two', 'three code']);
  assert.deepEqual(releaseNotes(null), []);
  assert.deepEqual(releaseNotes('- a‮b‏\u0007'), ['ab']);
  assert.equal(releaseNotes(Array.from({ length: 12 }, (_, i) => `- n${i}`).join('\n')).length, 8);
  assert.equal(releaseNotes('- ' + 'x'.repeat(300))[0].length, 140);
});
test('update screen: launch check finds a newer version, gives up quietly otherwise', async () => {
  const { createUpdates } = require('../src/updates.js');
  const base = { version: '0.4.3', platform: 'win32', env: {}, fetchLatest: async () => null, openExternal() {}, ask: async () => 1, prefs: {}, savePrefs() {}, strings: () => ({}), log() {} };
  const off = createUpdates({ ...base, app: { isPackaged: false } });
  assert.equal(await off.launchCheck(50), null);
  const main = readFileSyncSafe('src/main.js');
  assert.ok(/startZ\(\);\n\}/.test(main), 'createWindow starts with the check');
  assert.ok(/updates\.mode !== 'install' \|\| !net\.isOnline\(\)/.test(main), 'no network or no install mode: Z as before');
  assert.ok(/if \(!found\) return loadZ\(\);/.test(main));
  assert.ok(/storages: \['cachestorage'\]/.test(main) && !/storages: \[[^\]]*serviceworkers/.test(main), 'after an app update: page caches only, never the worker (push)');
  assert.ok(/async function startZ\(\) \{\n  await freshAfterAppUpdate\(\);/.test(main));
  assert.ok(/UPDATE_STALL_MS/.test(main) && /updates\.defer\(\);\n\s+loadZ\(\);/.test(main), 'stalled or later: Z opens');
});
test('update screen: words in five languages', () => {
  const { STRINGS } = require('../src/i18n.js');
  for (const l of Object.keys(STRINGS)) for (const k of ['ulTitle', 'ulLead', 'ulNotes', 'ulUpdate', 'ulLater', 'ulKeep', 'ulPrep', 'ulPrepSub', 'ulNoOff']) assert.ok(STRINGS[l][k], `${l}.${k}`);
  for (const l of Object.keys(STRINGS)) assert.ok(STRINGS[l].ulLead.includes('{name}') && STRINGS[l].ulPrepSub.includes('{name}'), l);
});

// ---------- one Z across all displays (span mode, api 8) ----------
{
  const { createSpan, spanSupported, unionOf } = require('../src/span.js');
  const D = (x, y, w, h, wa) => ({ bounds: { x, y, width: w, height: h }, workArea: wa || { x, y, width: w, height: h - 40 } });
  test('span: offered on Windows and Linux X11 only', () => {
    assert.equal(spanSupported('win32', {}), true);
    assert.equal(spanSupported('linux', { XDG_SESSION_TYPE: 'x11' }), true);
    assert.equal(spanSupported('linux', { XDG_SESSION_TYPE: 'wayland' }), false);
    assert.equal(spanSupported('darwin', {}), false);
  });
  test('span: the rectangle around every display, also left of and above the main one', () => {
    assert.deepEqual(unionOf([D(0, 0, 1920, 1080), D(-1536, 200, 1536, 864)], 'bounds'), { x: -1536, y: 0, width: 3456, height: 1080 });
    assert.deepEqual(unionOf([D(0, 0, 1920, 1080), D(0, -1080, 1920, 1080)], 'workArea'), { x: 0, y: -1080, width: 1920, height: 2120 });
    assert.equal(unionOf([], 'bounds'), null);
    assert.equal(unionOf([{ bounds: { x: 'a', y: 0, width: 10, height: 10 } }, { bounds: { x: 0, y: 0, width: 0, height: 5 } }], 'bounds'), null);
    assert.equal(unionOf(null, 'bounds'), null);
  });
  const mk = (prefs, platform = 'win32', list = [D(0, 0, 1920, 1080), D(1920, 0, 1920, 1080)]) => {
    const log = { saved: 0, restarts: 0, timers: [] };
    const span = createSpan({
      screen: { getAllDisplays: () => list },
      platform,
      env: {},
      prefs,
      savePrefs: () => log.saved++,
      restart: () => log.restarts++,
      setTimer: (fn) => log.timers.push(fn),
    });
    return { span, log };
  };
  test('span: off by default, nothing placed', () => {
    const { span } = mk({});
    assert.deepEqual(span.get(), { supported: true, on: false, active: false });
    assert.equal(span.bounds(), null);
  });
  test('span: on covers every display in full screen, every work area out of it', () => {
    const { span } = mk({ span: true });
    assert.equal(span.active(), true);
    assert.deepEqual(span.bounds(), { x: 0, y: 0, width: 3840, height: 1080 });
    span.setFull(false);
    assert.deepEqual(span.bounds(), { x: 0, y: 0, width: 3840, height: 1040 });
  });
  test('span: out of full screen the window bar sits on the primary display (bottom-aligned, unequal heights)', () => {
    // O's displays 27.11: a 3440x1440 display on the left, the 1920x1200 primary one on the right, bottoms in line
    const wide = D(-3440, -240, 3440, 1440);
    const laptop = D(0, 0, 1920, 1200);
    const span = createSpan({
      screen: { getAllDisplays: () => [wide, laptop], getPrimaryDisplay: () => laptop },
      platform: 'win32', env: {}, prefs: { span: true }, savePrefs: () => {}, restart: () => {},
    });
    assert.equal(span.barRect(34), null, 'full screen: no bar');
    span.setFull(false);
    assert.deepEqual(span.barRect(34), { x: 3440, y: 240, width: 1920, height: 34 });
    const off = createSpan({ screen: { getAllDisplays: () => [laptop], getPrimaryDisplay: () => laptop }, platform: 'win32', env: {}, prefs: {}, savePrefs: () => {}, restart: () => {} });
    off.setFull(false);
    assert.equal(off.barRect(34), null, 'not span mode: no bar here');
  });
  test('span: while Z loads, its page covers the main display only and every other display gets the Z logo', () => {
    // O's displays 27.11, and two more: 4 displays (O: "even with 4 connected")
    const wide = D(-3440, -240, 3440, 1440);
    const laptop = D(0, 0, 1920, 1200);
    const above = D(0, -1080, 1920, 1080);
    const right = D(1920, 0, 1280, 1024);
    const span = createSpan({
      screen: { getAllDisplays: () => [wide, laptop, above, right], getPrimaryDisplay: () => laptop },
      platform: 'win32', env: {}, prefs: { span: true }, savePrefs: () => {}, restart: () => {},
    });
    // the window starts at (-3440, -1080): the union of all four
    assert.deepEqual(span.mainBox(34), { x: 3440, y: 1080, width: 1920, height: 1200 }, 'full screen: no bar');
    assert.deepEqual(span.bootRects(), [
      { x: 0, y: 840, width: 3440, height: 1440 },
      { x: 3440, y: 0, width: 1920, height: 1080 },
      { x: 5360, y: 1080, width: 1280, height: 1024 },
    ]);
    span.setFull(false);
    // out of full screen: work areas (40 px taskbar), and the main box starts below the window bar
    assert.deepEqual(span.mainBox(34), { x: 3440, y: 1080 + 34, width: 1920, height: 1160 - 34 });
    assert.equal(span.bootRects().length, 3);
    const off = createSpan({ screen: { getAllDisplays: () => [laptop], getPrimaryDisplay: () => laptop }, platform: 'win32', env: {}, prefs: {}, savePrefs: () => {}, restart: () => {} });
    assert.equal(off.mainBox(34), null);
    assert.deepEqual(off.bootRects(), []);
  });
  test('span: the boot covers start, reload and sign-out, ends when Z says so or after a minute, and its page is a picture', () => {
    const main = readFileSyncSafe('src/main.js');
    assert.ok(/if \(details && details\.isMainFrame && !details\.isSameDocument\) \{\n\s+lockMirror\.reset\(\);\n(\s+\/\/[^\n]*\n)+\s+if \(cfg\.isAppUrl\(details\.url\)\) spanBootStart\(\);\n\s+else spanBootEnd\(\);/.test(main), 'every new page of Z; the offline page at once');
    assert.ok(/if \(spanning\) spanBootStart\(\);/.test(main), 'the first page');
    assert.ok(/const BOOT_MAX_MS = 60000;/.test(main) && /bootTimer = setTimeout\(spanBootEnd, BOOT_MAX_MS\);/.test(main), 'never hidden for good');
    assert.ok(/ipcMain\.handle\('zd:span:ready', \(e\) => \(fromMainZ\(e\) && span && span\.active\(\) \? spanBootEnd\(\) : false\)\);/.test(main));
    assert.ok(/const v = new WebContentsView\(\{ webPreferences: secureWebPreferences\(false\) \}\);/.test(main), 'no preload for the logo views');
    assert.ok(/v\.webContents\.on\('will-navigate', \(event\) => event\.preventDefault\(\)\);/.test(main));
    assert.ok(/v\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\);/.test(main));
    const html = readFileSyncSafe('src/boot.html');
    assert.ok(!/<script/i.test(html), 'no script at all');
    assert.ok(html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`));
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, '')), 'no network');
  });
  test('span: the bar asks only through its own page, for minimize or close', () => {
    const main = readFileSyncSafe('src/main.js');
    assert.ok(/if \(u\.protocol !== 'file:' \|\| path\.normalize\(fileURLToPath\(u\)\) !== path\.normalize\(TITLEBAR_FILE\)\) return null;/.test(main));
    assert.ok(/return what === 'minimize' \|\| what === 'close' \? what : null;/.test(main));
    assert.ok(/barView\.webContents\.on\('will-navigate', \(event, url\) => \{\n    event\.preventDefault\(\);\n    if \(!spanning/.test(main));
    const html = readFileSyncSafe('src/titlebar.html');
    assert.ok(html.includes('href="?do=minimize"') && html.includes('href="?do=close"'));
  });
  test('span: switching saves the choice and restarts once; the same mode does not restart', () => {
    const prefs = {};
    const { span, log } = mk(prefs);
    assert.equal(span.set(true).restarting, true);
    assert.equal(span.set(true).restarting, true);
    assert.equal(prefs.span, true);
    assert.equal(log.saved, 1);
    assert.equal(log.timers.length, 1, 'one restart only');
    log.timers[0]();
    assert.equal(log.restarts, 1);
    assert.equal(span.active(), false, 'this run keeps its mode');
    const again = mk({ span: true });
    assert.equal(again.span.set(true).restarting, false);
    assert.equal(again.log.timers.length, 0);
  });
  test('span: Mac and Wayland never span, even with the choice saved', () => {
    const { span, log } = mk({ span: true }, 'darwin');
    assert.deepEqual(span.get(), { supported: false, on: false, active: false });
    assert.equal(span.set(true).restarting, false);
    assert.equal(log.timers.length, 0);
    assert.equal(span.bounds(), null);
  });
  test('span: a bad answer from the page changes nothing', () => {
    const prefs = {};
    const { span, log } = mk(prefs);
    assert.equal(span.set('yes').restarting, false);
    assert.equal(prefs.span, undefined);
    assert.equal(log.saved, 0);
  });
  test('span: main turns off both extend ways and follows display changes', () => {
    const src = readFileSyncSafe('src/main.js');
    assert.ok(/if \(!span\.active\(\)\) startExtend\(\);/.test(src));
    assert.ok(/send: \(snap\) => \{\n\s+if \(span && span\.active\(\)\) fitSpan\(\);/.test(src));
    assert.ok(/p && p\.span === true/.test(src), 'only a real true turns it on');
    // A way out that does not need Z's page (it may be offline), and a restart never repeats one-time arguments.
    assert.ok(/const SPAN_OFF_ARG = '--one-display';/.test(src));
    assert.ok(/arguments: SPAN_OFF_ARG/.test(src), 'Windows taskbar menu entry');
    assert.ok(/if \(argv\.includes\(SPAN_OFF_ARG\) && span\) span\.set\(false\);/.test(src), 'from a second start');
    assert.ok(/loadPrefs\(\);\n\s+\/\/ `--one-display` at start/.test(src), 'at start, before any window');
    assert.ok(/app\.relaunch\(\{ args: restartArgs\(process\.argv\) \}\)/.test(src));
  });
  test('span: a restart drops the one-time arguments and keeps the rest', () => {
    const src = readFileSyncSafe('src/main.js');
    const m = src.match(/const ONCE_ARGS[\s\S]*?\n}\n/);
    assert.ok(m);
    const f = new Function('RESET_ARG', 'UPDATE_ARG', 'SPAN_OFF_ARG', 'AUTOSTART_ARG', `${m[0]}; return restartArgs;`)('--reset-permissions', '--check-updates', '--one-display', '--autostart');
    assert.deepEqual(f(['z.exe', '--reset-permissions', '--check-updates', '--one-display', '--autostart=on', '.', '--x']), ['.', '--x']);
  });
}

// ---------- the Windows key in full screen (api 9, O 27.11) ----------
{
  const { createWinKeys, isLeaveFullscreen, HOLD_WORLD } = require('../src/winKeys.js');
  const fakeContents = () => {
    const on = {};
    const runs = [];
    return {
      on: (ev, fn) => {
        on[ev] = fn;
      },
      emit: (ev, ...a) => on[ev] && on[ev](...a),
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: (world, scripts, gesture) => {
        runs.push({ world, code: scripts[0].code, gesture });
        return Promise.resolve(true);
      },
      runs,
    };
  };
  const make = (over = {}) => {
    const c = fakeContents();
    const st = { enabled: true, wanted: true, t: 0, timers: [] };
    const k = createWinKeys({
      platform: 'win32',
      enabled: () => st.enabled,
      wanted: () => st.wanted,
      contents: () => c,
      now: () => st.t,
      setTimeout: (fn) => {
        st.timers.push(fn);
        return st.timers.length;
      },
      clearTimeout: () => {},
      ...over,
    });
    k.attach(c);
    const flush = () => {
      const fns = st.timers.splice(0);
      for (const fn of fns) fn();
    };
    return { c, st, k, flush };
  };
  test('win keys: full screen holds the page (own world, with a gesture), leaving lets go', () => {
    const { c, st, k } = make();
    k.changed();
    assert.equal(c.runs.length, 1);
    assert.equal(c.runs[0].world, HOLD_WORLD);
    assert.equal(c.runs[0].gesture, true);
    assert.match(c.runs[0].code, /requestFullscreen/);
    c.emit('enter-html-full-screen');
    k.changed();
    assert.equal(c.runs.length, 1, 'already held: nothing again');
    st.enabled = false;
    k.changed();
    assert.match(c.runs[1].code, /exitFullscreen/);
    assert.match(c.runs[1].code, /for \(/, 'all the way out, also a video over the hold (Closure-old M2)');
  });
  test('win keys: hold, a video over it, the window leaves full screen: the page leaves full screen too', async () => {
    const { c, st, k } = make();
    k.changed();
    c.emit('enter-html-full-screen');
    await new Promise((r) => setImmediate(r));
    // a video goes full screen over the hold (Chromium sends no new event), then the window leaves full screen
    st.wanted = false;
    k.changed();
    assert.equal(c.runs.length, 2);
    assert.match(c.runs[1].code, /exitFullscreen/);
  });
  test("win keys: a video's own full screen in a windowed Z is never ended", () => {
    const { c, st, k } = make();
    st.wanted = false;
    c.emit('enter-html-full-screen'); // the video, not the hold
    k.changed();
    assert.equal(c.runs.length, 0);
    assert.equal(k.isOurs(), false);
  });
  test('win keys: only on Windows, only when wanted', () => {
    const mac = make({ platform: 'darwin' });
    mac.k.changed();
    assert.equal(mac.c.runs.length, 0);
    assert.equal(mac.k.supported, false);
    const out = make();
    out.st.wanted = false;
    out.k.changed();
    assert.equal(out.c.runs.length, 0, 'out of full screen: no hold');
  });
  test('win keys: a lost hold comes back, but never in a loop', () => {
    const { c, st, k, flush } = make();
    k.changed();
    for (let i = 0; i < 10; i++) {
      c.emit('enter-html-full-screen');
      c.emit('leave-html-full-screen');
      flush();
    }
    assert.equal(c.runs.length, 5, 'at most 5 tries in 10 seconds');
    st.t = 20000;
    k.changed();
    assert.equal(c.runs.length, 6, 'a real change starts again');
  });
  test('win keys: a new page starts without the hold and is held once it loads', () => {
    const { c, k, flush } = make();
    k.changed();
    c.emit('enter-html-full-screen');
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    assert.equal(k.isHeld(), false);
    c.emit('did-finish-load');
    flush();
    assert.equal(c.runs.length, 2);
  });
  test('win keys: Ctrl+Alt+Esc is the way out, nothing else', () => {
    const k = (over) => ({ type: 'keyDown', key: 'Escape', control: true, alt: true, meta: false, shift: false, ...over });
    assert.equal(isLeaveFullscreen(k()), true);
    for (const bad of [k({ type: 'keyUp' }), k({ control: false }), k({ alt: false }), k({ meta: true }), k({ shift: true }), k({ key: 'Delete' })])
      assert.equal(isLeaveFullscreen(bad), false);
  });
  test('win keys: wired in main (Z window only, a quiet keyboard lock, Windows lock tells Z)', () => {
    const src = readFileSyncSafe('src/main.js');
    assert.ok(/winKeys\.attach\(zView\.webContents\);/.test(src));
    assert.ok(/!\(span && span\.active\(\)\) &&\n\s+win\.isFullScreen\(\)/.test(src), 'not in span mode (layer 2)');
    assert.ok(/cfg\.isAppUrl\(zView\.webContents\.getURL\(\)\)/.test(src), 'never the offline page');
    assert.ok(/powerMonitor\.on\('lock-screen'/.test(src));
    assert.ok(/p && p\.winKeys === false/.test(src), 'only a real false turns it off');
    const { QUIET, createPermissions } = require('../src/permissions.js');
    assert.ok(QUIET.has('keyboardLock'));
    const perms = createPermissions({ store: { get: () => undefined, set: () => {}, clear: () => {} }, ask: () => true });
    assert.equal(perms.check('https://orvalen.me/', 'keyboardLock'), true, "Z's own page");
    assert.equal(perms.check('https://evil.example/', 'keyboardLock'), false, 'any other page');
    assert.equal(perms.check('https://x.workers.dev/', 'keyboardLock', {}, 'https://orvalen.me/'), false, 'an app frame inside Z');
  });
}

function readFileSyncSafe(f) {
  return require('node:fs').readFileSync(f, 'utf8');
}

await Promise.all(pending);
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall checks passed');

