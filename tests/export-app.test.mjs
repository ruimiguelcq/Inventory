import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-export-'));
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
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/inventory')).text());
  };
  return { url, get, post, token, csrfToken, signIn, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

async function setStock(a, id, quantity) {
  const review = await a.post(`/products/${id}/stock`, { csrfToken: a.csrfToken, operation: 'set', quantity: String(quantity) });
  assert.equal(review.status, 200);
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post(`/products/${id}/stock/confirm`, { csrfToken: a.csrfToken, confirmationToken })).status, 303);
}

// Catalog for the exports: ids 1..3 with a category, a text brand and quantities.
async function seed(a) {
  for (const product of [
    { partNumber: '00123', description: 'Junta <marina> & retén', presentation: 'KIT', brand: '=Motor', location: 'Estante Ñ', minimumStock: '0', newCategory: 'Motor' },
    { partNumber: 'B-2', description: 'Ánodo', presentation: 'unidad' },
    { partNumber: 'C-3', description: 'Juego completo', presentation: 'SET', minimumStock: '2' },
  ]) assert.equal((await a.post('/products', { csrfToken: a.csrfToken, ...product })).status, 303);
  await setStock(a, 1, 7);
  await setStock(a, 3, 4);
}

async function download(response, filename) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${filename}"`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const bytes = await response.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.equal(workbook.worksheets.length, 1);
  return { bytes, sheet: workbook.worksheets[0] };
}

function viewLink(html, label) {
  const href = html.match(new RegExp(`href="([^"]+)"[^>]*>${label}</a>`))?.[1];
  assert.ok(href, `missing ${label} link`);
  return href.replaceAll('&amp;', '&');
}

async function importCatalog(a, bytes, { view = 'products', stock, operation, csrfToken = a.csrfToken } = {}) {
  const form = new FormData();
  form.set('csrfToken', csrfToken);
  form.set('view', view);
  if (stock) { form.set('stock', 'on'); form.set('operation', operation); }
  form.set('file', new Blob([bytes]), 'archivo.xlsx');
  return a.post('/imports', form);
}

test('Productos exports the descriptive catalog with its category and inventory keeps its data', async (t) => {
  const a = await app(t);
  await seed(a);
  const before = await (await a.get('/products')).text();
  const link = viewLink(before, 'Exportar');
  assert.match(link, /view=products/);
  const { sheet } = await download(await a.get(link), 'productos.xlsx');
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['P/N', 'Descripción', 'Presentación', 'Marca', 'Ubicación', 'Mínimo de stock', 'Categoría', 'Cantidad']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['00123', 'Junta <marina> & retén', 'KIT', '=Motor', 'Estante Ñ', 0, 'Motor', 7]);
  assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('D2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('F3').value, null);
  assert.equal(sheet.getCell('G2').value, 'Motor');
  assert.equal(sheet.getCell('G3').value, null);
  assert.equal(sheet.getCell('H3').value, 0);
  assert.equal(await (await a.get('/products')).text(), before);
});

test('Inventario exports only P/N, name and quantity for active articles', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await a.post('/products/2/archive', { csrfToken: a.csrfToken })).status, 303);
  const html = await (await a.get('/inventory')).text();
  const link = viewLink(html, 'Exportar');
  assert.match(link, /view=inventory/);
  assert.match(link, /state=active/);
  // Even a hand-crafted link asking for every state stays active-only.
  const { sheet } = await download(await a.get(link.replace('state=active', 'state=all')), 'inventario.xlsx');
  assert.equal(sheet.rowCount, 3);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['P/N', 'Descripción', 'Cantidad']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['00123', 'Junta <marina> & retén', 7]);
  assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['C-3', 'Juego completo', 4]);
});

test('both exports cover every filtered page and never fall back to the full catalog', async (t) => {
  const a = await app(t);
  for (let index = 1; index <= 55; index++) {
    assert.equal((await a.post('/products', {
      csrfToken: a.csrfToken, partNumber: `P-${String(index).padStart(3, '0')}`,
      description: 'Bomba marina', presentation: 'KIT', ...(index === 1 ? { newCategory: 'Motor' } : { categoryId: '1' }),
    })).status, 303);
  }
  for (const partNumber of ['OTRO-1', 'OTRO-2', 'OTRO-3']) {
    assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber, description: 'Ánodo de sacrificio', presentation: 'unidad' })).status, 303);
  }
  const page = await (await a.get('/products?q=bomba&category=1')).text();
  assert.equal([...page.matchAll(/name="id" value="(\d+)"/g)].length, 50);
  const allProducts = await download(await a.get(viewLink(page, 'Exportar')), 'productos.xlsx');
  assert.equal(allProducts.sheet.rowCount, 56);
  const inventoryPage = await (await a.get('/inventory?q=bomba')).text();
  const allInventory = await download(await a.get(viewLink(inventoryPage, 'Exportar')), 'inventario.xlsx');
  assert.equal(allInventory.sheet.rowCount, 56);
  assert.equal(allInventory.sheet.getCell('A56').value, 'P-055');
  // A selection that is empty or invalid never becomes a full download.
  for (const fields of [
    { view: 'inventory', scope: 'selected' },
    { view: 'inventory', scope: 'selected', id: '9999' },
    { view: 'inventory', scope: 'selected', id: '1.5' },
    { view: 'inventory', scope: 'selected', id: 'oops' },
    { view: 'products', scope: 'unexpected' },
    { view: 'bogus', scope: 'all' },
    { view: 'inventory' },
  ]) {
    const response = await a.post('/exports', { csrfToken: a.csrfToken, ...fields });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal(response.headers.get('content-disposition'), null);
  }
});

test('a selected export downloads only those articles and requires a real selection', async (t) => {
  const a = await app(t);
  await seed(a);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /<form[^>]*method="post"[^>]*action="\/exports"/);
  assert.match(inventory, /name="view" value="inventory"/);
  assert.match(inventory, /name="scope" value="selected"/);
  assert.match(inventory, /type="checkbox" name="id" value="1"[^>]*aria-label="Seleccionar 00123"/);
  const selection = new URLSearchParams({ csrfToken: a.csrfToken, view: 'inventory', scope: 'selected' });
  for (const id of ['3', '1', '1']) selection.append('id', id);
  const { sheet } = await download(await a.post('/exports', selection), 'inventario.xlsx');
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('A2').value, '00123');
  assert.equal(sheet.getCell('A3').value, 'C-3');
  assert.equal((await a.post('/exports', { view: 'inventory', scope: 'selected', id: '1' })).status, 403);
});

test('consulta exports both views while anonymous visitors cannot download', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  const viewerToken = await a.signIn('viewer', 'equipo-seguro-123');
  const products = await (await a.get('/products')).text();
  const inventory = await (await a.get('/inventory')).text();
  assert.match(products, />Exportar<\/a>/);
  assert.match(inventory, />Exportar<\/a>/);
  assert.doesNotMatch(products, />Importar</);
  assert.equal((await download(await a.get(viewLink(products, 'Exportar')), 'productos.xlsx')).sheet.rowCount, 4);
  assert.equal((await download(await a.get(viewLink(inventory, 'Exportar')), 'inventario.xlsx')).sheet.rowCount, 4);
  assert.equal((await download(await a.post('/exports', {
    csrfToken: viewerToken, view: 'inventory', scope: 'selected', id: '2',
  }), 'inventario.xlsx')).sheet.getCell('A2').value, 'B-2');
  a.cookie = '';
  for (const response of [await a.get('/exports?view=inventory&scope=all'), await a.post('/exports', { view: 'inventory', scope: 'selected', id: '1' })]) {
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(response.headers.get('content-disposition'), null);
  }
});

test('an exported catalog can be reimported with categories and quantities, without duplicating anything', async (t) => {
  const source = await app(t);
  await seed(source);
  const { bytes } = await download(await source.get(viewLink(await (await source.get('/products')).text(), 'Exportar')), 'productos.xlsx');
  const target = await app(t);
  const preview = await importCatalog(target, bytes, { view: 'products', stock: true, operation: 'set' });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /3 altas · 0 actualizaciones · 0 filas con errores/);
  assert.match(html, /Junta &lt;marina&gt; &amp; retén/);
  assert.match(html, /Motor/);
  assert.doesNotMatch(await (await target.get('/inventory')).text(), /00123/);
  assert.equal((await target.post('/imports/confirm', {
    csrfToken: target.csrfToken, confirmationToken: target.token(html, 'confirmationToken'),
  })).status, 303);
  assert.match(await (await target.get('/products/1')).text(), /Categoría<\/dt><dd>Motor/);
  assert.match(await (await target.get('/products/1')).text(), /Existencias<\/dt><dd>7/);
  // Equivalent category names never duplicate the category.
  assert.equal((await target.post('/products', {
    csrfToken: target.csrfToken, partNumber: 'NUEVO', description: 'Otra junta', presentation: 'KIT', newCategory: 'motor',
  })).status, 303);
  const edit = await (await target.get('/products/1/edit')).text();
  assert.equal([...edit.matchAll(/>Motor<\/option>/g)].length, 1);
  // Reimporting the same workbook sets the same totals instead of doubling them.
  const repeat = await importCatalog(target, bytes, { view: 'products', stock: true, operation: 'set' });
  assert.equal(repeat.status, 200);
  const repeatText = await repeat.text();
  assert.match(repeatText, /0 altas · 3 actualizaciones · 0 filas con errores/);
  assert.equal((await target.post('/imports/confirm', {
    csrfToken: target.csrfToken, confirmationToken: target.token(repeatText, 'confirmationToken'),
  })).status, 303);
  assert.match(await (await target.get('/products/1/stock')).text(), /Disponible: <strong>7<\/strong>/);
  assert.match(await (await target.get('/products/1/history')).text(), /Importación Excel/);
});

test('an inventory workbook only updates existing quantities when reimported with Establecer en', async (t) => {
  const source = await app(t);
  await seed(source);
  const { bytes } = await download(await source.get(viewLink(await (await source.get('/inventory')).text(), 'Exportar')), 'inventario.xlsx');
  const target = await app(t);
  for (const product of [
    { partNumber: '00123', description: 'Junta', presentation: 'KIT' },
    { partNumber: 'B-2', description: 'Ánodo', presentation: 'unidad' },
    { partNumber: 'C-3', description: 'Juego', presentation: 'SET' },
  ]) assert.equal((await target.post('/products', { csrfToken: target.csrfToken, ...product })).status, 303);
  await setStock(target, 1, 3);
  const preview = await importCatalog(target, bytes, { view: 'inventory', stock: true, operation: 'set' });
  assert.equal(preview.status, 200);
  const previewText = await preview.text();
  assert.match(previewText, /0 altas · 3 actualizaciones · 0 filas con errores/);
  assert.equal((await target.post('/imports/confirm', {
    csrfToken: target.csrfToken, confirmationToken: target.token(previewText, 'confirmationToken'),
  })).status, 303);
  // 7, not 3 + 7: setting must not add the exported quantities on top.
  assert.match(await (await target.get('/products/1/stock')).text(), /Disponible: <strong>7<\/strong>/);
  assert.match(await (await target.get('/products/2/stock')).text(), /Disponible: <strong>0<\/strong>/);
});

test('an empty inventory downloads a workbook with headers and no phantom articles', async (t) => {
  const a = await app(t);
  const { sheet } = await download(await a.get('/exports?view=inventory&scope=all'), 'inventario.xlsx');
  assert.equal(sheet.rowCount, 1);
  assert.equal(sheet.getCell('A1').value, 'P/N');
  assert.equal(sheet.getCell('C1').value, 'Cantidad');
  const products = await download(await a.get('/exports?view=products&scope=all'), 'productos.xlsx');
  assert.equal(products.sheet.rowCount, 1);
  assert.equal(products.sheet.getCell('G1').value, 'Categoría');
  assert.equal((await a.get('/exports?view=inventory&scope=selected')).status, 400);
});

test('consulta can download a selection larger than the HTTP URL limit', async (t) => {
  const a = await app(t);
  for (let batch = 0; batch < 3; batch++) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Productos');
    sheet.addRow(['P/N', 'Descripción', 'Presentación']);
    for (let row = 1; row <= 800; row++) {
      sheet.addRow([`P-${String(batch * 800 + row).padStart(4, '0')}`, 'Repuesto', 'unidad']);
    }
    const preview = await importCatalog(a, await workbook.xlsx.writeBuffer(), { view: 'products' });
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal((await a.post('/imports/confirm', {
      csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken'),
    })).status, 303);
  }
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  const viewerToken = await a.signIn('viewer', 'equipo-seguro-123');
  const inventory = await (await a.get('/inventory')).text();
  assert.equal([...inventory.matchAll(/type="checkbox" name="id" value="(\d+)"/g)].length, 50);
  const selection = new URLSearchParams({ csrfToken: viewerToken, view: 'inventory', scope: 'selected' });
  for (let id = 1; id <= 2400; id++) selection.append('id', String(id));
  assert.ok(Buffer.byteLength(selection.toString()) > 16_384);
  const { sheet } = await download(await a.post('/exports', selection), 'inventario.xlsx');
  assert.equal(sheet.rowCount, 2401);
  assert.equal(sheet.getCell('A2').value, 'P-0001');
  assert.equal(sheet.getCell('A2401').value, 'P-2400');
});
