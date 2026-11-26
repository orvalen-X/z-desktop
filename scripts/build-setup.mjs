// Builds Z Setup (installer/), the small branded program the site offers: dist/Z-Setup.exe.
// It always installs the newest release, so the same name works from every release
// (https://github.com/orvalen-X/z-desktop/releases/latest/download/Z-Setup.exe).
// The same file is also saved under the release's name and number, e.g. dist/Z-DNA-0.3.5.exe (O): the download
// page offers that one, so the downloaded file says which version it installs. Z-Setup.exe stays for old links.
// x64 only: Windows on ARM runs it as it runs the full x64 installer it downloads.
// Needs Go (go.mod picks the exact version). Unsigned, like the other installers, until signing is turned on.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'installer');
const out = join(root, 'dist', 'Z-Setup.exe');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
// "Setup" is refused: Z-Setup-<version>.exe is the full installer, and Windows file names ignore case.
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[A-Za-z]{1,16}$/.test(pkg.zReleaseName || '') || /^setup$/i.test(pkg.zReleaseName)) {
  console.error('package.json needs "version" like 1.2.3 and "zReleaseName" of 1 to 16 Latin letters, not "Setup"');
  process.exit(1);
}
const named = join(root, 'dist', `Z-${pkg.zReleaseName}-${version}.exe`);
const v4 = `${version}.0`;

function go(args, env = {}) {
  console.log('> go', args.join(' '));
  execFileSync('go', args, { cwd: dir, stdio: 'inherit', env: { ...process.env, ...env } });
}

go(['vet', './...']);
go(['test', './...']);
const win = { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' };
go(['vet', './...'], win);
// Icon (id 1, used by the window), manifest (no admin prompt, sharp on high-DPI screens) and file details.
go(['run', 'github.com/tc-hib/go-winres@v0.3.3', 'make', '--in', 'winres/winres.json', '--arch', 'amd64',
  '--file-version', v4, '--product-version', v4]);
mkdirSync(join(root, 'dist'), { recursive: true });
try {
  go(['build', '-trimpath', '-ldflags', '-s -w -H windowsgui', '-o', out, '.'], win);
} finally {
  rmSync(join(dir, 'rsrc_windows_amd64.syso'), { force: true });
}
// When signing is switched on, sign Z-Setup.exe before this copy, so both files are signed.
copyFileSync(out, named);
const mb = (statSync(out).size / 1048576).toFixed(1);
console.log(`built ${out} and ${named} (${mb} MB)`);
