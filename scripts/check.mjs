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

for (const f of ['src/main.js', 'src/preload.js', 'src/config.js', 'src/i18n.js', 'src/permissions.js', 'src/updates.js']) {
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

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall checks passed');
