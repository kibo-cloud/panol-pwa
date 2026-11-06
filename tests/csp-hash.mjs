// Keeps the CSP of index.html in sync with its inline script.
//   node tests/csp-hash.mjs          -> rewrites the 'sha256-…' source in the CSP meta
//   node tests/csp-hash.mjs --check  -> exits 1 if the CSP does not match the script
// Run it after every edit of the <script> block: with a stale hash the browser blocks the app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
// The HTML parser turns CRLF into LF before the hash is computed, so hash the normalized text.
const m = /<script>([\s\S]*?)<\/script>/.exec(html.replace(/\r\n?/g, '\n'));
if (!m) { console.error('no inline <script> found'); process.exit(1); }
const hash = `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`;
const re = /'sha256-[A-Za-z0-9+/=]+'|'sha256-PENDING'/;
const cspLine = html.split('\n').find((l) => l.includes('http-equiv="Content-Security-Policy"')) || '';
const current = (cspLine.match(re) || [''])[0];
if (process.argv.includes('--check')) {
  if (current !== hash) { console.error(`CSP hash out of date: ${current} != ${hash} (run node tests/csp-hash.mjs)`); process.exit(1); }
  console.log('CSP hash ok ' + hash);
} else if (current === hash) {
  console.log('CSP hash already up to date ' + hash);
} else {
  fs.writeFileSync(file, html.replace(cspLine, cspLine.replace(re, hash)));
  console.log('CSP hash updated ' + hash);
}
