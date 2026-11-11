// Etapa 10: informe para auditoría (GET /api/audit-report) y datos de la empresa
// (Administración › Empresa: nombre y logo). Base sembrada: Ana tiene un control finalizado de la
// semana anterior; Bruno, un borrador de esta semana (no cuenta: solo controles vigentes).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf, prevP, pkeyOf, pad } from '../../src/domain/period.js';

let api;
const cur = periodOf(new Date());
const prev = prevP(cur);
const anaCtl = `c-t-ana-${pkeyOf(prev)}`;
const months = [...new Set([`${prev.y}-${pad(prev.m)}`, `${cur.y}-${pad(cur.m)}`])].join(',');

before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const report = (user, qs) => api.call(user, 'GET', `/api/audit-report?${qs}`);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(40, 7)]);
const empresa = async () => (await api.call('consulta', 'GET', '/api/settings/empresa')).json();
const putLogo = (user, buf, version) => api.call(user, 'PUT', '/api/settings/empresa/logo', { file: buf.toString('base64') }, version == null ? {} : ifMatch(version));

describe('informe para auditoría', () => {
  test('una sola consulta arma todas las secciones con los controles vigentes', async () => {
    const r = await report('admin', `months=${months}`);
    assert.equal(r.statusCode, 200, r.body);
    const R = r.json();
    assert.equal(R.header.company, "Villa D'agri · Mantenimiento");
    assert.ok(R.header.issuer.length > 0, 'quién emitió');
    assert.deepEqual(R.sections, ['resumen', 'poseedores', 'faltantes', 'movimientos', 'compras', 'novedades', 'plantillas', 'firmas']);
    const ana = R.holders.find((h) => h.key === 't-ana');
    assert.ok(ana, 'Ana está');
    assert.deepEqual(ana.columns.map((c) => c.id), [anaCtl]);
    const bruno = R.holders.find((h) => h.key === 't-bruno');
    assert.deepEqual(bruno.columns, [], 'el borrador de Bruno no es un control vigente');
    assert.ok(ana.rows.length > 0 && ana.rows.every((x) => x.cells[anaCtl]));
    assert.ok(R.movements.some((m) => m.type === 'entrega_inicial' && m.holderKey === 't-ana') || R.movements.length === 0);
    assert.equal(R.summary.done, R.holders.reduce((s, h) => s + h.columns.length, 0));
    assert.ok(Array.isArray(R.novedades));
    assert.equal(R.costsShown, true, 'admin ve costos');
  });

  test('permiso, costos solo con purchases_view, filtros y límites', async () => {
    assert.equal((await report(null, `months=${months}`)).statusCode, 401);
    const g = await report('gerencia', `months=${months}&sections=compras`);
    assert.equal(g.statusCode, 200, g.body);
    assert.equal(g.json().costsShown, true);
    const resp = await report('responsable', `months=${months}&sections=compras,resumen`);
    assert.equal(resp.statusCode, 200);
    assert.equal(resp.json().costsShown, false);
    assert.ok(!('costoConocido' in resp.json().purchaseTotals));
    const only = (await report('admin', `months=${months}&techs=t-bruno&cajas=none`)).json();
    assert.deepEqual(only.holders.map((h) => h.key), ['t-bruno']);
    const big = await report('admin', 'from=2020-01&to=2026-01');
    assert.equal(big.statusCode, 422);
    assert.equal(big.json().error, 'report_too_large');
    assert.match(big.json().message, /24 meses/);
    assert.equal((await report('admin', 'months=2026-13')).statusCode, 400);
    assert.equal((await report('admin', '')).statusCode, 400);
    assert.equal((await report('admin', `months=${months}&sections=nada`)).statusCode, 400);
    assert.equal((await report('admin', `months=${months}&otro=1`)).statusCode, 400);
  });
});

describe('empresa: nombre y logo', () => {
  test('nombre con plantillas_edit, If-Match y auditoría; aparece en el informe', async () => {
    const e = await empresa();
    assert.deepEqual(e, { name: "Villa D'agri · Mantenimiento", logo: null, version: 0 });
    const put = (user, body, v) => api.call(user, 'PUT', '/api/settings/empresa', body, v == null ? {} : ifMatch(v));
    assert.equal((await put('responsable', { name: 'Otra' }, 0)).statusCode, 403);
    assert.equal((await put('admin', { name: 'Otra' })).statusCode, 428);
    assert.equal((await put('admin', { name: '   ' }, 0)).statusCode, 422);
    const ok = await put('admin', { name: 'Planta Norte · Mantenimiento' }, 0);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().version, 1);
    assert.equal((await put('admin', { name: 'Vieja' }, 0)).statusCode, 409);
    const au = await api.q("SELECT detail FROM audit_log WHERE action = 'empresa_settings' ORDER BY at DESC LIMIT 1");
    assert.equal(au[0].detail, 'Nombre de la empresa: Planta Norte · Mantenimiento');
    assert.equal((await report('consulta', `months=${months}&sections=resumen`)).json().header.company, 'Planta Norte · Mantenimiento');
    const st = (await api.call('consulta', 'GET', '/api/state')).json();
    assert.equal(st.settings.empresa.name, 'Planta Norte · Mantenimiento');
  });

  test('logo: PNG o JPEG por sus bytes, hasta 512 KB, servido con su tipo y nosniff', async () => {
    let v = (await empresa()).version;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r1 = await putLogo('admin', svg, v);
    assert.equal(r1.statusCode, 422);
    assert.equal(r1.json().error, 'invalid_image');
    const html = Buffer.from('<html><body>no</body></html>');
    assert.equal((await putLogo('admin', html, v)).statusCode, 422);
    const huge = Buffer.concat([png, Buffer.alloc(512 * 1024)]);
    const r2 = await putLogo('admin', huge, v);
    assert.equal(r2.statusCode, 413, r2.body);
    assert.equal(r2.json().error, 'too_large');
    assert.equal((await api.call('admin', 'PUT', '/api/settings/empresa/logo', { file: '***' }, ifMatch(v))).statusCode, 400);
    assert.equal((await putLogo('responsable', png, v)).statusCode, 403);
    assert.equal((await api.call('admin', 'GET', '/api/empresa/logo')).statusCode, 404);
    const ok = await putLogo('admin', png, v);
    assert.equal(ok.statusCode, 200, ok.body);
    const e = ok.json();
    assert.equal(e.logo.contentType, 'image/png');
    assert.equal(e.logo.size, png.length);
    assert.match(e.logo.url, /^\/api\/empresa\/logo\?v=[0-9a-f]{16}$/);
    const img = await api.call('consulta', 'GET', e.logo.url);
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.ok(img.rawPayload.equals(png), 'los mismos bytes');
    assert.equal((await api.call(null, 'GET', e.logo.url)).statusCode, 401);
    assert.equal((await report('admin', `months=${months}&sections=resumen`)).json().header.logo.url, e.logo.url);
    // La base también rechaza un tipo que no sea PNG o JPEG.
    await assert.rejects(api.q("UPDATE company_logo SET content_type = 'image/svg+xml'"), (err) => err.code === '23514');
    v = e.version;
    const del = await api.call('admin', 'DELETE', '/api/settings/empresa/logo', undefined, ifMatch(v));
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(del.json().logo, null);
    assert.equal((await api.call('admin', 'GET', '/api/empresa/logo')).statusCode, 404);
    const au = await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'empresa_logo'");
    assert.equal(au[0].n, 2);
  });
});
