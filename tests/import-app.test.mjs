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
  async function upload(rows, { view = 'products', csrfToken: uploadedToken = csrfToken, ...options } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Datos').addRows(rows);
    const form = new FormData();
    form.set('csrfToken', uploadedToken);
    form.set('view', view);
    for (const [key, value] of Object.entries(options)) form.set(key, value);
    form.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'datos.xlsx');
    return post('/imports', form);
  }
  async function confirm(response) {
    assert.equal(response.status, 200);
    const html = await response.text();
    const fields = { csrfToken, confirmationToken: token(html, 'confirmationToken') };
    assert.ok(fields.confirmationToken, html);
    return post('/imports/confirm', fields);
  }
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/inventory')).text());
  };
  return { url, get, post, token, csrfToken, upload, confirm, signIn, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

test('the catalog import creates and updates articles with their category and optional stock', async (t) => {
  const a = await app(t);
  const headers = ['P/N', 'Descripción', 'Presentación', 'Marca', 'Ubicación', 'Mínimo de stock', 'Categoría', 'Cantidad'];
  const preview = await a.upload([headers, ['001-A', 'Junta marina', 'KIT', 'Motor', 'Caja 1', 2, 'Juntas', 5]],
    { stock: 'on', operation: 'set' });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /Alta/);
  assert.match(html, /Categoría: Juntas/);
  assert.match(html, /0 → 5 KIT/);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /001-A/);
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken') };
  assert.ok(fields.confirmationToken);
  assert.equal((await a.post('/imports/confirm', fields)).status, 303);
  assert.equal((await a.post('/imports/confirm', fields)).status, 409);
  const detail = await (await a.get('/products/1')).text();
  assert.match(detail, /Categoría<\/dt><dd>Juntas/);
  assert.match(detail, /Existencias<\/dt><dd>5/);
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /<td>admin<\/td>/);
  assert.match(history, /Importación Excel/);
  assert.match(history, /<td>0<\/td><td>5<\/td>/);

  const update = await a.upload([['P/N', 'Descripción', 'Presentación', 'Categoría'], ['001-a', 'Junta actualizada', 'KIT', 'juntas']]);
  const updateHtml = await update.text();
  assert.equal(update.status, 200);
  assert.match(updateHtml, /Actualización/);
  assert.match(updateHtml, /Junta marina/);
  assert.match(updateHtml, /Junta actualizada/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken, confirmationToken: a.token(updateHtml, 'confirmationToken') })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Junta actualizada/);
  // Equivalent casing reuses the existing category instead of duplicating it.
  const edit = await (await a.get('/products/1/edit')).text();
  assert.equal([...edit.matchAll(/>Juntas<\/option>/g)].length, 1);
  assert.match(await (await a.get('/products/1/stock')).text(), /Disponible: <strong>5<\/strong>/);
});

test('category columns follow the optional-column rule: absent preserves, empty clears', async (t) => {
  const a = await app(t);
  assert.equal((await a.confirm(await a.upload([['P/N', 'Descripción', 'Presentación', 'Categoría'], ['CAT', 'Con categoría', 'SET', 'Motor']]))).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Categoría<\/dt><dd>Motor/);
  assert.equal((await a.confirm(await a.upload([['P/N', 'Descripción', 'Presentación'], ['CAT', 'Renombrada', 'SET']]))).status, 303);
  const preserved = await (await a.get('/products/1')).text();
  assert.match(preserved, /Renombrada/);
  assert.match(preserved, /Categoría<\/dt><dd>Motor/);
  assert.equal((await a.confirm(await a.upload([['P/N', 'Descripción', 'Presentación', 'Categoría'], ['CAT', 'Sin categoría', 'SET', '']]))).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Categoría<\/dt><dd>Sin categoría/);
  const longCategory = await a.upload([['P/N', 'Descripción', 'Presentación', 'Categoría'], ['OTRO', 'Mala', 'SET', 'x'.repeat(101)]]);
  assert.equal(longCategory.status, 200);
  const longHtml = await longCategory.text();
  assert.match(longHtml, /100 caracteres/);
  assert.doesNotMatch(longHtml, /Confirmar importación/);
});

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
  ], { stock: 'on', operation: 'set' });
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
  const unheaded = await a.upload([['P/N', 'Descripción', 'Presentación'], ['EXTRA', 'Pieza', 'KIT', 99]]);
  assert.equal(unheaded.status, 400);
  assert.match(await unheaded.text(), /encabezado/);
});

test('a failed catalog batch leaves no partial products or categories behind', async (t) => {
  const a = await app(t);
  const preview = await a.upload([
    ['P/N', 'Descripción', 'Presentación', 'Categoría'],
    ['NUEVO', 'Debe crearse', 'KIT', 'Nueva'],
    ['ROTO', '', 'KIT', 'Otra'],
  ]);
  assert.equal(preview.status, 200);
  const failedHtml = await preview.text();
  assert.match(failedHtml, /Errores|Error/);
  assert.doesNotMatch(failedHtml, /Confirmar importación/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken })).status, 409);
  assert.doesNotMatch(await (await a.get('/products/new')).text(), /Nueva|Otra/);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /NUEVO/);
});

test('the inventory import only updates existing articles and rejects unknown references', async (t) => {
  const a = await app(t);
  assert.equal((await a.confirm(await a.upload([['P/N', 'Descripción', 'Presentación'], ['CAT', 'Catálogo', 'SET']]))).status, 303);
  assert.match(await (await a.get('/products/1/stock')).text(), /Disponible: <strong>0<\/strong>/);
  const unknown = await a.upload([['P/N', 'Cantidad'], ['UNKNOWN', 1]], { view: 'inventory', operation: 'set' });
  assert.equal(unknown.status, 200);
  const unknownHtml = await unknown.text();
  assert.match(unknownHtml, /P\/N no encontrado/);
  assert.doesNotMatch(unknownHtml, /Confirmar importación/);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /UNKNOWN/);
  // Description columns are ignored: inventory only changes quantities.
  const preview = await a.upload([['P/N', 'Descripción', 'Cantidad'], ['CAT', 'Ignorado', 7]], { view: 'inventory', operation: 'set' });
  const html = await preview.text();
  assert.match(html, /Actualización/);
  assert.match(html, /Sin cambios de catálogo/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken') })).status, 303);
  const catalog = await (await a.get('/inventory')).text();
  assert.match(catalog, /Catálogo/);
  assert.doesNotMatch(catalog, /Ignorado/);
  assert.match(await (await a.get('/products/1/history')).text(), /<td>7<\/td><td>0<\/td><td>7<\/td>/);
  // Inventario requires an explicit operation and its own columns.
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['CAT', 1]], { view: 'inventory' })).status, 400);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['CAT', 1]], { view: 'inventory', operation: 'other' })).status, 400);
  const missing = await a.upload([['P/N'], ['CAT']], { view: 'inventory', operation: 'set' });
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /P\/N y Cantidad/);
});

test('cancellation invalidates a confirmation and a preview is replaced, not doubled', async (t) => {
  const a = await app(t);
  const preview = await a.upload([['P/N', 'Cantidad'], ['CAT', -3]], { view: 'inventory', operation: 'adjust' });
  assert.equal(preview.status, 200);
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  await a.confirm(await a.upload([['P/N', 'Descripción', 'Presentación'], ['OTRO', 'Otro', 'KIT']]));
  assert.equal((await a.post('/imports/cancel', fields)).status, 303);
  assert.equal((await a.post('/imports/confirm', fields)).status, 409);
});

test('concurrent changes reject the complete import without creating any other rows', async (t) => {
  const a = await app(t);
  await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'EXISTS', description: 'Original', presentation: 'KIT' });
  const preview = await a.upload([
    ['P/N', 'Descripción', 'Presentación', 'Cantidad'],
    ['NEW', 'No debe crearse', 'unidad', 5], ['EXISTS', 'Importado', 'KIT', 10],
  ], { stock: 'on', operation: 'set' });
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  await a.post('/products/1', { csrfToken: a.csrfToken, partNumber: 'EXISTS', description: 'Editado por otro usuario', presentation: 'KIT' });
  const conflict = await a.post('/imports/confirm', fields);
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /han cambiado/);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /Editado por otro usuario/);
  assert.doesNotMatch(inventory, /No debe crearse|Importado/);
  assert.match(await (await a.get('/products/1/history')).text(), /Todavía no hay movimientos/);
  const stockPreview = await a.upload([['P/N', 'Cantidad'], ['EXISTS', 12]], { view: 'inventory', operation: 'set' });
  const pending = { csrfToken: a.csrfToken, confirmationToken: a.token(await stockPreview.text(), 'confirmationToken') };
  const manual = await a.post('/products/1/stock', { csrfToken: a.csrfToken, operation: 'adjust', quantity: '2' });
  await a.post('/products/1/stock/confirm', { csrfToken: a.csrfToken, confirmationToken: a.token(await manual.text(), 'confirmationToken') });
  assert.equal((await a.post('/imports/confirm', pending)).status, 409);
  assert.match(await (await a.get('/products/1/stock')).text(), /Disponible: <strong>2<\/strong>/);
});

test('imports require a valid view, workbook and CSRF verification', async (t) => {
  const a = await app(t);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['PART', 1]], { view: 'other' })).status, 400);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['PART', 1]], { view: 'products' })).status, 400);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['PART', 1]], { view: 'inventory' })).status, 400);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['PART', 1]], { view: 'inventory', operation: 'other' })).status, 400);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['PART', 1]], { view: 'inventory', operation: 'set', csrfToken: '' })).status, 403);
  for (const path of ['/imports/confirm', '/imports/cancel']) assert.equal((await a.post(path, {})).status, 403);
  const form = new FormData();
  form.set('csrfToken', a.csrfToken);
  form.set('view', 'products');
  form.set('file', new Blob(['invalid workbook']), 'broken.xlsx');
  const broken = await a.post('/imports', form);
  assert.equal(broken.status, 400);
  assert.match(await broken.text(), /No se pudo leer/);
  form.set('file', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]), 'large.xlsx');
  assert.equal((await a.post('/imports', form)).status, 400);
  const manyRows = [['P/N', 'Descripción', 'Presentación'], ...Array.from({ length: 1001 }, (_, i) => [`P-${i}`, 'Repuesto', 'unidad'])];
  assert.equal((await a.upload(manyRows)).status, 400);
});

test('gestión imports both views while consulta cannot reach the forms even after demotion', async (t) => {
  const a = await app(t);
  await a.post('/users', { csrfToken: a.csrfToken, username: 'gestion', password: 'gestion-segura-123', role: 'manager' });
  const managerToken = await a.signIn('gestion', 'gestion-segura-123');
  const review = await a.upload([['P/N', 'Descripción', 'Presentación', 'Cantidad'], ['MANAGER', '<Junta>', 'KIT', 3]],
    { csrfToken: managerToken, stock: 'on', operation: 'set' });
  const html = await review.text();
  assert.match(html, /&lt;Junta&gt;/);
  const fields = { csrfToken: managerToken, confirmationToken: a.token(html, 'confirmationToken') };
  const adminToken = await a.signIn('admin', 'marina-segura-123');
  assert.equal((await a.post('/imports/confirm', { ...fields, csrfToken: adminToken })).status, 409);
  // Keep the manager session alive while the administrator changes the role.
  const managerToken2 = await a.signIn('gestion', 'gestion-segura-123');
  const valid = await a.upload([['P/N', 'Descripción', 'Presentación', 'Cantidad'], ['MANAGER', '<Junta>', 'KIT', 3]],
    { csrfToken: managerToken2, stock: 'on', operation: 'set' });
  const validFields = { csrfToken: managerToken2, confirmationToken: a.token(await valid.text(), 'confirmationToken') };
  assert.equal((await a.post('/imports/confirm', validFields)).status, 303);
  assert.match(await (await a.get('/products/1/history')).text(), /<td>gestion<\/td>/);
  assert.equal((await a.get('/imports?view=products')).status, 200);
  assert.equal((await a.get('/imports?view=inventory')).status, 200);
  const pending = await a.upload([['P/N', 'Descripción', 'Presentación'], ['MANAGER', 'Otra', 'KIT']], { csrfToken: managerToken2 });
  const pendingFields = { csrfToken: managerToken2, confirmationToken: a.token(await pending.text(), 'confirmationToken') };
  const managerCookie = a.cookie;
  const newAdminToken = await a.signIn('admin', 'marina-segura-123');
  await a.post('/users/2/role', { csrfToken: newAdminToken, role: 'viewer' });
  a.cookie = managerCookie;
  for (const path of ['/imports?view=products', '/imports?view=inventory']) assert.equal((await a.get(path)).status, 403);
  assert.equal((await a.post('/imports/confirm', pendingFields)).status, 403);
  assert.equal((await a.upload([['P/N', 'Cantidad'], ['MANAGER', 1]], { csrfToken: managerToken2, view: 'inventory', operation: 'set' })).status, 403);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /Importar/);
});

test('an invalid replacement preserves the last valid preview', async (t) => {
  const a = await app(t);
  const preview = await a.upload([['P/N', 'Descripción', 'Presentación'], ['VALID', 'Válido', 'KIT']]);
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  const invalid = await a.upload([['P/N', 'Descripción', 'Presentación'], ['INVALID', '', 'KIT']]);
  assert.doesNotMatch(await invalid.text(), /Confirmar importación/);
  assert.equal((await a.post('/imports/confirm', fields)).status, 303);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /VALID/);
  assert.doesNotMatch(inventory, /INVALID/);
});

test('the inventory view rejects unknown references instead of creating articles', async (t) => {
  const a = await app(t);
  const unknown = await a.upload([['P/N', 'Cantidad'], ['NO-EXISTE', 4]], { view: 'inventory', operation: 'adjust' });
  assert.equal(unknown.status, 200);
  assert.match(await unknown.text(), /solo actualiza artículos existentes/);
  assert.equal((await a.get('/products?q=NO-EXISTE')).status, 200);
  assert.match(await (await a.get('/products?q=NO-EXISTE')).text(), /Sin resultados/);
});

test('cancellation invalidates an upload whose request body is still arriving', async (t) => {
  const a = await app(t);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Datos').addRows([['P/N', 'Descripción', 'Presentación'], ['LATE', 'Tardío', 'KIT']]);
  const form = new FormData();
  form.set('csrfToken', a.csrfToken);
  form.set('view', 'products');
  form.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'datos.xlsx');
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
  assert.equal((await a.post('/imports/cancel', { csrfToken: a.csrfToken, view: 'products' })).status, 303);
  pending.end(body);
  assert.equal(await result, 409);
  assert.doesNotMatch(await (await a.get('/inventory')).text(), /LATE/);
});
