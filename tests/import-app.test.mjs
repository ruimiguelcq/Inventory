import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { request } from 'node:http';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-import-'));
  const server = createInventoryServer({ databasePath: join(directory, 'inventory.sqlite') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual',
    body: fields instanceof FormData ? fields : new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const csrfToken = token(await (await get('/inventory')).text());
  async function upload(rows, options = { descriptions: 'on', stock: 'on', operation: 'set' }) {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Inventario').addRows(rows);
    const form = new FormData();
    form.set('csrfToken', csrfToken);
    for (const [key, value] of Object.entries(options)) form.set(key, value);
    form.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'inventario.xlsx');
    return post('/imports', form);
  }
  const signIn = async (username, password) => {
    const login = await post('/login', { username, password });
    cookie = login.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/inventory')).text());
  };
  return { url, get, post, token, csrfToken, upload, signIn, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

test('invalid rows and duplicates block the whole batch, including data without a column heading', async (t) => {
  const a = await app(t);
  const preview = await a.upload([
    ['P/N', 'Descripción', 'Presentación', 'Cantidad'],
    ['VALID', 'Válido', 'unidad', 3],
    ['DUP', 'Duplicado', 'KIT', 1],
    ['dup', 'Duplicado también', 'KIT', 2],
    ['MISSING', '', 'SET', 1],
    ['NEG', 'Negativo', 'SET', -1],
    ['FORMULA', 'Fórmula', 'KIT', { formula: '1+2', result: 3 }],
    ['DECIMAL', 'Fracción', 'KIT', 1.5],
    [123, 'Identificador numérico', 'KIT', 1],
  ]);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /P\/N duplicado/);
  assert.match(html, /descripción/);
  assert.match(html, /debajo de cero/);
  assert.match(html, /sin fórmulas/);
  assert.match(html, /número entero/);
  assert.match(html, /P\/N como texto/);
  assert.doesNotMatch(html, /Confirmar importación/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken })).status, 409);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /VALID/);
  const unheaded = await a.upload([['P/N', 'Descripción', 'Presentación'], ['EXTRA', 'Pieza', 'KIT', 99]], { descriptions: 'on' });
  assert.equal(unheaded.status, 400);
  assert.match(await unheaded.text(), /encabezado/);
});

test('Excel preview creates and updates articles only after confirmation, with attributed stock history', async (t) => {
  const a = await app(t);
  const headers = ['P/N', 'Descripción', 'Presentación', 'Marca', 'Ubicación', 'Mínimo de stock', 'Cantidad'];
  const preview = await a.upload([headers, ['001-A', 'Junta marina', 'KIT', 'Motor', 'Caja 1', 2, 5]]);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /Alta/);
  assert.match(html, /Junta marina/);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /001-A/);
  const confirm = { csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken') };
  assert.ok(confirm.confirmationToken);
  assert.equal((await a.post('/imports/confirm', confirm)).status, 303);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /001-A/);
  assert.match(inventory, /<td class="quantity-cell">5<\/td>/);
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /<td>admin<\/td>/);
  assert.match(history, /Importación Excel/);
  assert.match(history, /<td>0<\/td><td>5<\/td>/);
  assert.equal((await a.post('/imports/confirm', confirm)).status, 409);
  const update = await a.upload([headers, ['001-a', 'Junta actualizada', 'KIT', 'Motor', 'Caja 2', 3, 2]],
    { descriptions: 'on', stock: 'on', operation: 'adjust' });
  const updateHtml = await update.text();
  assert.equal(update.status, 200);
  assert.match(updateHtml, /Actualización/);
  assert.match(updateHtml, /Junta marina/);
  assert.match(updateHtml, /Junta actualizada/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken, confirmationToken: a.token(updateHtml, 'confirmationToken') })).status, 303);
  assert.match(await (await a.get('/products/1/history')).text(), /<td>2<\/td><td>5<\/td><td>7<\/td>/);
});

test('descriptions and stock can be imported independently and cancellation invalidates confirmation', async (t) => {
  const a = await app(t);
  async function confirm(response) {
    assert.equal(response.status, 200);
    const html = await response.text();
    const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken') };
    assert.ok(fields.confirmationToken, html);
    return a.post('/imports/confirm', fields);
  }
  assert.equal((await confirm(await a.upload([
    ['P/N', 'Descripción', 'Presentación', 'Marca', 'Cantidad'], ['CAT', 'Catálogo', 'SET', 'Original', 99],
  ], { descriptions: 'on' }))).status, 303);
  assert.match(await (await a.get('/products/1/stock')).text(), /Disponible: <strong>0<\/strong>/);
  assert.match(await (await a.get('/products/1/history')).text(), /Todavía no hay movimientos/);
  assert.equal((await confirm(await a.upload([
    ['P/N', 'Descripción', 'Presentación', 'Cantidad'], ['CAT', 'Ignorado', 'KIT', 7],
  ], { stock: 'on', operation: 'set' }))).status, 303);
  const catalog = await (await a.get('/inventory')).text();
  assert.match(catalog, /Catálogo/);
  assert.doesNotMatch(catalog, /Ignorado/);
  assert.match(await (await a.get('/products/1/history')).text(), /<td>7<\/td><td>0<\/td><td>7<\/td>/);
  assert.equal((await confirm(await a.upload([
    ['P/N', 'Descripción', 'Presentación'], ['CAT', 'Nueva descripción', 'SET'],
  ], { descriptions: 'on' }))).status, 303);
  assert.match(await (await a.get('/products')).text(), /Original/);
  const preview = await a.upload([['P/N', 'Cantidad'], ['CAT', -3]], { stock: 'on', operation: 'adjust' });
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  assert.equal((await a.post('/imports/cancel', fields)).status, 303);
  assert.equal((await a.post('/imports/confirm', fields)).status, 409);
  assert.match(await (await a.get('/products/1/stock')).text(), /Disponible: <strong>7<\/strong>/);
  const unknown = await a.upload([['P/N', 'Cantidad'], ['UNKNOWN', 1]], { stock: 'on', operation: 'set' });
  assert.match(await unknown.text(), /P\/N no encontrado/);
});

test('concurrent changes reject the complete import without creating any other rows', async (t) => {
  const a = await app(t);
  await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'EXISTS', description: 'Original', presentation: 'KIT' });
  const preview = await a.upload([
    ['P/N', 'Descripción', 'Presentación', 'Cantidad'],
    ['NEW', 'No debe crearse', 'unidad', 5], ['EXISTS', 'Importado', 'KIT', 10],
  ]);
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  await a.post('/products/1', { csrfToken: a.csrfToken, partNumber: 'EXISTS', description: 'Editado por otro usuario', presentation: 'KIT' });
  const conflict = await a.post('/imports/confirm', fields);
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /han cambiado/);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /Editado por otro usuario/);
  assert.doesNotMatch(inventory, /No debe crearse|Importado/);
  assert.match(await (await a.get('/products/1/history')).text(), /Todavía no hay movimientos/);
  const stockPreview = await a.upload([['P/N', 'Cantidad'], ['EXISTS', 12]], { stock: 'on', operation: 'set' });
  const pending = { csrfToken: a.csrfToken, confirmationToken: a.token(await stockPreview.text(), 'confirmationToken') };
  const manual = await a.post('/products/1/stock', { csrfToken: a.csrfToken, operation: 'adjust', quantity: '2' });
  await a.post('/products/1/stock/confirm', { csrfToken: a.csrfToken, confirmationToken: a.token(await manual.text(), 'confirmationToken') });
  assert.equal((await a.post('/imports/confirm', pending)).status, 409);
  assert.match(await (await a.get('/products/1/stock')).text(), /Disponible: <strong>2<\/strong>/);
});

test('imports require explicit stock mode, valid workbook and CSRF verification', async (t) => {
  const a = await app(t);
  const rows = [['P/N', 'Cantidad'], ['PART', 1]];
  for (const options of [{}, { stock: 'on' }, { stock: 'on', operation: 'other' }]) {
    assert.equal((await a.upload(rows, options)).status, 400);
  }
  assert.equal((await a.upload(rows, { stock: 'on', operation: 'set', csrfToken: '' })).status, 403);
  for (const path of ['/imports/confirm', '/imports/cancel']) assert.equal((await a.post(path, {})).status, 403);
  const form = new FormData();
  form.set('csrfToken', a.csrfToken);
  form.set('descriptions', 'on');
  form.set('file', new Blob(['invalid workbook']), 'broken.xlsx');
  const broken = await a.post('/imports', form);
  assert.equal(broken.status, 400);
  assert.match(await broken.text(), /No se pudo leer/);
  form.set('file', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]), 'large.xlsx');
  assert.equal((await a.post('/imports', form)).status, 400);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ...Array.from({ length: 1001 }, (_, i) => [`P-${i}`, 1])], { stock: 'on', operation: 'set' })).status, 400);
});

test('gestión imports are attributed and consulta cannot preview or confirm even after demotion', async (t) => {
  const a = await app(t);
  await a.post('/users', { csrfToken: a.csrfToken, username: 'gestion', password: 'gestion-segura-123', role: 'manager' });
  const managerToken = await a.signIn('gestion', 'gestion-segura-123');
  const rows = [['P/N', 'Descripción', 'Presentación', 'Cantidad'], ['MANAGER', '<Junta>', 'KIT', 3]];
  const review = await a.upload(rows, { csrfToken: managerToken, descriptions: 'on', stock: 'on', operation: 'set' });
  const html = await review.text();
  assert.match(html, /&lt;Junta&gt;/);
  const fields = { csrfToken: managerToken, confirmationToken: a.token(html, 'confirmationToken') };
  const adminToken = await a.signIn('admin', 'marina-segura-123');
  assert.equal((await a.post('/imports/confirm', { ...fields, csrfToken: adminToken })).status, 409);
  // Keep the manager session alive while the administrator changes the role.
  const managerToken2 = await a.signIn('gestion', 'gestion-segura-123');
  const valid = await a.upload(rows, { csrfToken: managerToken2, descriptions: 'on', stock: 'on', operation: 'set' });
  const validFields = { csrfToken: managerToken2, confirmationToken: a.token(await valid.text(), 'confirmationToken') };
  assert.equal((await a.post('/imports/confirm', { ...validFields, quantity: '999', userId: '1' })).status, 303);
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /<td>gestion<\/td>/);
  assert.match(history, /<td>0<\/td><td>3<\/td>/);
  const pending = await a.upload(rows, { csrfToken: managerToken2, descriptions: 'on' });
  const pendingFields = { csrfToken: managerToken2, confirmationToken: a.token(await pending.text(), 'confirmationToken') };
  const managerCookie = a.cookie;
  const newAdminToken = await a.signIn('admin', 'marina-segura-123');
  await a.post('/users/2/role', { csrfToken: newAdminToken, role: 'viewer' });
  a.cookie = managerCookie;
  assert.equal((await a.get('/imports')).status, 403);
  assert.equal((await a.post('/imports/confirm', pendingFields)).status, 403);
  assert.equal((await a.upload(rows)).status, 403);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /Importar Excel/);
});

test('an invalid replacement preserves the last valid preview', async (t) => {
  const a = await app(t);
  const preview = await a.upload([['P/N', 'Descripción', 'Presentación'], ['VALID', 'Válido', 'KIT']], { descriptions: 'on' });
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  const invalid = await a.upload([['P/N', 'Descripción', 'Presentación'], ['INVALID', '', 'KIT']], { descriptions: 'on' });
  assert.doesNotMatch(await invalid.text(), /Confirmar importación/);
  assert.equal((await a.post('/imports/confirm', fields)).status, 303);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /VALID/);
  assert.doesNotMatch(inventory, /INVALID/);
});

test('cancellation invalidates an upload whose request body is still arriving', async (t) => {
  const a = await app(t);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Inventario').addRows([['P/N', 'Descripción', 'Presentación'], ['LATE', 'Tardío', 'KIT']]);
  const form = new FormData();
  form.set('csrfToken', a.csrfToken);
  form.set('descriptions', 'on');
  form.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'inventario.xlsx');
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const pending = request(`${a.url}/imports`, {
    method: 'POST', headers: { cookie: a.cookie, Expect: '100-continue',
      'content-type': encoded.headers.get('content-type'), 'content-length': body.length },
  });
  t.after(() => pending.destroy());
  const result = new Promise((resolve, reject) => {
    pending.on('response', (response) => { response.resume(); resolve(response.statusCode); });
    pending.on('error', reject);
  });
  await new Promise((resolve) => { pending.once('continue', resolve); pending.flushHeaders(); });
  assert.equal((await a.post('/imports/cancel', { csrfToken: a.csrfToken })).status, 303);
  pending.end(body);
  assert.equal(await result, 409);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /LATE/);
});
