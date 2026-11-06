// Regenerates tests/e2e/fixtures/*.txt: `node tests/e2e/make-fixtures.mjs`
// legacy-2.0.0.txt is produced by the real 2.0.0 app (git baseline 11296b1) so it carries
// genuine 2.0.0 records and SHA-256 PIN hashes; one extra user gets the old `fnv:` fallback hash.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, FIX, startServer, launchBrowser, openPage, sleep } from './harness.mjs';

const BASELINE = '11296b1';
const HEAD = 'PAÑOL · archivo de datos\r\nGuardalo, compartilo o abrilo desde la app Pañol. No lo edites a mano.\r\n';
const sha = (salt, pin) => 'sha256:' + crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
function fnv(salt, pin) { // same fallback as 2.0.0 hashPin without crypto.subtle
  const txt = salt + ':' + pin; let h1 = 0x811c9dc5, h2 = 0x1234567;
  for (let i = 0; i < txt.length; i++) { h1 = Math.imul(h1 ^ txt.charCodeAt(i), 16777619); h2 = Math.imul(h2 + txt.charCodeAt(i), 2654435761); }
  return 'fnv:' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}
const AT = '2026-11-01T10:00:00.000Z';
const admin = { name: 'Ana Admin', role: 'admin', active: true, salt: 'salt1', pinHash: sha('salt1', '1234'), createdAt: AT, updatedAt: AT };
const file = (data) => HEAD + JSON.stringify({ app: 'panol', format: 'panol-txt', version: 2, savedAt: AT, data });
const write = (name, txt) => { fs.writeFileSync(path.join(FIX, name), txt); console.log('  wrote ' + name); };
const base = () => ({ users: { uadmin: { ...admin } }, techs: { t1: { name: 'Tomás Uno', legajo: '100', shiftId: 'manana', active: true, createdAt: AT } } });

fs.mkdirSync(FIX, { recursive: true });
write('garbage.txt', 'asdkjh 123 ### esto no es un archivo de Pañol');
write('empty.txt', '');
write('data-array.txt', '{"app":"panol","data":[]}');
write('data-empty.txt', '{"app":"panol","data":{}}');
write('wrong-shape.txt', file({ users: { uadmin: { ...admin } }, techs: { t1: 'str', t2: null, t3: { name: 5 } } }));
write('proto-key.txt', HEAD + '{"app":"panol","data":{"users":{"uadmin":' + JSON.stringify(admin) + '},"techs":{"__proto__":{"name":"x","polluted":true}}}}');
write('no-admin.txt', file({ users: { uc: { ...admin, name: 'Carla Consulta', role: 'consulta' } } }));
write('xss-ids.txt', file({ ...base(), techs: { 't1"><img src=x onerror=window.__xss=1>': { name: 'Id malicioso', legajo: '1', shiftId: 'manana', active: true, createdAt: AT } } }));
write('xss-turnos.txt', file({ config: { turnos: { list: [{ id: '"><img src=x onerror=window.__xss=2>', name: 'Turno trampa', order: 1 }], updatedAt: '2099-01-01T00:00:00.000Z' } } }));
write('xss-numbers.txt', file({ ...base(), tools: { h1: { name: 'Pinza', serialized: false, active: true, createdAt: AT } },
  assignments: { a1: { techId: 't1', toolId: 'h1', qty: '<img src=x onerror=window.__xss=3>', active: true, since: AT } } }));
const evil = '<img src=x onerror="window.__xss=4">';
write('xss-text.txt', file({ users: { uadmin: { ...admin } },
  techs: { t1: { name: evil + ' Tec', legajo: '"><svg onload=window.__xss=5>', shiftId: 'manana', active: true, createdAt: AT } },
  categories: { g1: { name: evil, createdAt: AT } },
  tools: { h1: { name: evil + ' Herr', description: evil, categoryId: 'g1', serialized: false, active: true, createdAt: AT } },
  movements: { m1: { type: 'ingreso', toolId: 'h1', qty: 3, transfers: [{ toolId: 'h1', qty: 3, from: 'externo', to: 'disponible', unitId: null }], notes: evil, at: AT } } }));

// Legacy export made by the 2.0.0 app itself.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panol-baseline-'));
const tar = spawnSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', path.join(tmp, 'b.tar'), BASELINE]);
if (tar.status) throw new Error('git archive failed: ' + tar.stderr);
spawnSync('tar', ['-xf', 'b.tar'], { cwd: tmp });
const srv = await startServer(tmp);
const browser = await launchBrowser();
try {
  const page = await openPage(browser, srv);
  await page.goto('/');
  await page.ready();
  const txt = await page.eval(`(async () => {
    const id = 'u' + uid(), salt = uid();
    await put('users', id, { name: 'Ana Admin', role: 'admin', active: true, salt, pinHash: await hashPin('1234', salt), createdAt: nowISO(), updatedAt: nowISO() });
    setUser(id);
    const id2 = 'u' + uid(), s2 = uid();
    await put('users', id2, { name: 'Rita Resp', role: 'responsable', active: true, salt: s2, pinHash: await hashPin('5678', s2), createdAt: nowISO(), updatedAt: nowISO(), by: id });
    DEMO_FLAG = true; try { await seedDemo(); } finally { DEMO_FLAG = false; }
    return serialize(); })()`);
  const p = JSON.parse(txt.slice(txt.indexOf('{')));
  if (!Object.values(p.data.users).every((u) => u.pinHash.startsWith('sha256:'))) throw new Error('expected sha256 hashes from 2.0.0');
  p.data.users.ufnvlegacy = { name: 'Fede Fnv', role: 'responsable', active: true, salt: 'fnvsalt', pinHash: fnv('fnvsalt', '9999'), createdAt: AT, updatedAt: AT };
  write('legacy-2.0.0.txt', HEAD + JSON.stringify(p));
  await page.dispose();
} finally {
  await browser.close();
  await srv.close();
  await sleep(200);
  fs.rmSync(tmp, { recursive: true, force: true });
}
