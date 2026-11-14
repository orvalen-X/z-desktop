// Quick checks that run without Electron: syntax, the address rules, and the five languages.
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

for (const f of ['src/main.js', 'src/preload.js', 'src/config.js', 'src/i18n.js']) {
  test(`syntax ${f}`, () => execFileSync(process.execPath, ['--check', f]));
}

const cfg = require('../src/config.js');
test('Z loads in the window', () => {
  assert.ok(cfg.isInWindowUrl('https://orvalen.me/'));
  assert.ok(cfg.isInWindowUrl('https://orvalen.me/m/chat?x=1'));
  assert.ok(cfg.isAppUrl('https://orvalen.me/pay'));
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

const i18n = require('../src/i18n.js');
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

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall checks passed');
