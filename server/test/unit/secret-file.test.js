import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSecretFile } from '../../scripts/lib/embedded-pg.js';

test('el archivo de contraseña temporal vive en un directorio propio y se borra al terminar', async () => {
  let seen;
  const out = await withSecretFile('secreto-1\n', async (file) => {
    seen = file;
    assert.equal(fs.readFileSync(file, 'utf8'), 'secreto-1\n');
    // Creado con flag 'wx': no se puede volver a crear encima.
    assert.throws(() => fs.writeFileSync(file, 'x', { flag: 'wx' }), { code: 'EEXIST' });
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(fs.existsSync(seen), false);
  assert.equal(fs.existsSync(path.dirname(seen)), false);
});

test('se borra aunque falle lo que lo usa', async () => {
  let seen;
  await assert.rejects(withSecretFile('x', async (file) => {
    seen = file;
    throw new Error('falla');
  }), /falla/);
  assert.equal(fs.existsSync(path.dirname(seen)), false);
});
