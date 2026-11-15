// Writes dist/SHA256SUMS-<name>.txt for the installers, so people can check a download.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2] || process.platform;
const files = readdirSync('dist').filter((f) => /\.(exe|7z|dmg|AppImage|deb)$/.test(f)).sort();
if (!files.length) {
  console.error('no installers in dist/');
  process.exit(1);
}
const lines = files.map((f) => `${createHash('sha256').update(readFileSync(join('dist', f))).digest('hex')}  ${f}`);
writeFileSync(join('dist', `SHA256SUMS-${name}.txt`), lines.join('\n') + '\n');
console.log(lines.join('\n'));
