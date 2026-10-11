// Copies the xterm.js terminal files from node_modules into www/vendor
// (the APK has no internet-loaded scripts, everything is bundled).
import fs from 'node:fs';
import path from 'node:path';

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'www/vendor/xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'www/vendor/xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'www/vendor/addon-fit.js'],
];

fs.mkdirSync('www/vendor', { recursive: true });
let missing = 0;
for (const [from, to] of files) {
  if (!fs.existsSync(from)) {
    console.error('MISSING: ' + from);
    missing++;
    continue;
  }
  fs.copyFileSync(from, to);
  console.log('copied ' + from + ' -> ' + to + ' (' + fs.statSync(to).size + ' bytes)');
}
if (missing) {
  console.error('xterm files not found. Check @xterm/xterm and @xterm/addon-fit versions in package.json.');
  process.exit(1);
}
