// esc(): todo texto de usuario se escapa antes de entrar al HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/ui/dom.js';

test('escapa los cinco caracteres peligrosos', () => {
  assert.equal(esc('<img src=x onerror="alert(\'x\')">&'), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
});
test('null y undefined quedan vacíos; números y booleanos como texto', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
});
test('texto normal (con acentos y ñ) no cambia', () => {
  assert.equal(esc('Pañol · Técnico 1021'), 'Pañol · Técnico 1021');
});
