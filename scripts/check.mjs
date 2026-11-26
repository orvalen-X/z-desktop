// Quick checks that run without Electron: syntax, the address rules, permissions, updates and the five languages.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log('ok  ', name);
  } catch (e) {
    failed++;
    console.log('FAIL', name, '\n     ', e.message);
  }
};

for (const f of ['src/main.js', 'src/preload.js', 'src/config.js', 'src/i18n.js', 'src/permissions.js', 'src/updates.js', 'src/autostart.js', 'src/displays.js', 'src/navGuard.js']) {
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
  for (const f of ['src/offline.html', 'src/titlebar.html', 'src/identify.html']) {
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
test('preload exposes only the full-screen, autostart and display-reading calls', () => {
  const src = readFileSyncSafe('src/preload.js');
  for (const ch of src.match(/'zd:[a-z:]+'/g)) assert.ok(["'zd:fs'", "'zd:fs:get'", "'zd:fs:set'", "'zd:fs:toggle'", "'zd:autostart:get'", "'zd:autostart:set'", "'zd:displays'", "'zd:displays:get'", "'zd:displays:identify'", "'zd:displays:settings'"].includes(ch), ch);
  assert.ok(/api: 2,/.test(src), 'api 2');
  assert.ok(!/require\('(?!electron')/.test(src), 'preload requires only electron');
});
test('main checks every Z request comes from Z itself', () => {
  const src = readFileSyncSafe('src/main.js');
  const handlers = src.match(/ipcMain\.handle\('zd:[a-z:]+', \([^)]*\) =>\s*\(?\s*fromZ\(e\)/g) || [];
  assert.equal(handlers.length, (src.match(/ipcMain\.handle\(/g) || []).length);
  assert.equal(handlers.length, 8);
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

function readFileSyncSafe(f) {
  return require('node:fs').readFileSync(f, 'utf8');
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall checks passed');
