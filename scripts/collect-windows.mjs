// Puts the Windows release files side by side in dist/, the way the release and the update check expect them.
//   dist/nsis-web/  the small web installer, one package per processor type, and latest.yml (used for updates)
//   dist-full/      the full installer for computers without a steady connection (built separately so it does
//                   not overwrite latest.yml); only the installer itself is taken from there
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function take(dir, test, expectAtLeast) {
  const files = existsSync(dir) ? readdirSync(dir).filter(test) : [];
  if (files.length < expectAtLeast) {
    console.error(`expected at least ${expectAtLeast} file(s) in ${dir}/, found`, files);
    process.exit(1);
  }
  for (const f of files) {
    copyFileSync(join(dir, f), join('dist', f));
    console.log('collected', f);
  }
}

take(join('dist', 'nsis-web'), (f) => /^Z-Web-Setup-.*\.exe$/.test(f), 1);
take(join('dist', 'nsis-web'), (f) => /\.nsis\.7z$/.test(f), 2); // x64 and arm64
take(join('dist', 'nsis-web'), (f) => /\.blockmap$/.test(f) || f === 'latest.yml', 0);
take('dist-full', (f) => /^Z-Setup-.*\.exe$/.test(f), 1);
if (!existsSync(join('dist', 'latest.yml'))) {
  console.error('latest.yml is missing: the apps would not find updates');
  process.exit(1);
}
