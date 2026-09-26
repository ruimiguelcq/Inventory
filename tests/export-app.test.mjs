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
    { partNumber: '00123', description: 'Junta <marina> & retén', presentation: 'KIT', brand: '=Motor', location: 'Estante Ñ', minimumStock: '0',
      newCategory: 'Motor', newProductType: 'Repuesto', newSupplier: 'Marino S.A.', longDescription: 'Junta con retén de repuesto', price: '12.34' },
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
  assert.deepEqual(sheet.getRow(1).values.slice(1),
    ['P/N', 'Producto', 'Descripción', 'Presentación', 'Marca', 'Ubicación', 'Mínimo de stock', 'Categoría', 'Tipo', 'Proveedor', 'Precio', 'Estado', 'Cantidad']);
  assert.deepEqual(sheet.getRow(2).values.slice(1),
    ['00123', 'Junta <marina> & retén', 'Junta con retén de repuesto', 'KIT', '=Motor', 'Estante Ñ', 0, 'Motor', 'Repuesto', 'Marino S.A.', 12.34, 'Activo', 7]);
  assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('E2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('F3').value, null);
  assert.equal(sheet.getCell('H2').value, 'Motor');
  assert.equal(sheet.getCell('H3').value, null);
  assert.equal(sheet.getCell('I3').value, null);
  assert.equal(sheet.getCell('J3').value, null);
  assert.equal(sheet.getCell('K2').value, 12.34);
  assert.equal(sheet.getCell('K3').value, null);
  assert.equal(sheet.getCell('L3').value, 'Activo');
  assert.equal(sheet.getCell('M3').value, 0);
  assert.equal(await (await a.get('/products')).text(), before);
});

test('Productos export shows Estado Archivado and carries no image column', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await a.post('/products/2/archive', { csrfToken: a.csrfToken })).status, 303);
  const html = await (await a.get('/products?state=all')).text();
  const { sheet } = await download(await a.get(viewLink(html, 'Exportar')), 'productos.xlsx');
  const estado = [...sheet.getRow(1).values].indexOf('Estado');
  assert.ok(estado > 0);
  assert.equal(sheet.getCell(2, estado).value, 'Activo');
  assert.equal(sheet.getCell(3, estado).value, 'Archivado');
  assert.equal([...sheet.getRow(1).values].some((header) => /imagen|foto/i.test(String(header))), false);
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
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['P/N', 'Producto', 'Cantidad']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['00123', 'Junta <marina> & retén', 7]);
  assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['C-3', 'Juego completo', 4]);
});

test('both exports cover every filtered page and never fall back to the full catalog', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'P-001', description: 'Bomba marina', presentation: 'KIT', newCategory: 'Motor',
  })).status, 303);
  const categoryId = (await (await a.get('/products/1/edit')).text()).match(/value="(\d+)" selected>Motor/)?.[1];
  assert.ok(categoryId, 'the created category id is available');
  for (let index = 2; index <= 55; index++) {
    assert.equal((await a.post('/products', {
      csrfToken: a.csrfToken, partNumber: `P-${String(index).padStart(3, '0')}`,
      description: 'Bomba marina', presentation: 'KIT', categoryId,
    })).status, 303);
  }
  for (const partNumber of ['OTRO-1', 'OTRO-2', 'OTRO-3']) {
    assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber, description: 'Ánodo de sacrificio', presentation: 'unidad' })).status, 303);
  }
  const page = await (await a.get(`/products?q=bomba&category=${categoryId}`)).text();
  assert.equal([...page.matchAll(/class="product-description"/g)].length, 50);
  const allProducts = await download(await a.get(viewLink(page, 'Exportar')), 'productos.xlsx');
  assert.equal(allProducts.sheet.rowCount, 56);
  const inventoryPage = await (await a.get('/inventory?q=bomba')).text();
  const allInventory = await download(await a.get(viewLink(inventoryPage, 'Exportar')), 'inventario.xlsx');
  assert.equal(allInventory.sheet.rowCount, 56);
  assert.equal(allInventory.sheet.getCell('A56').value, 'P-055');
  // A hand-crafted export must ask for the whole search; anything else is rejected, never
  // silently widened to the full catalog.
  for (const fields of [
    { view: 'inventory', scope: 'selected' },
    { view: 'inventory', scope: 'selected', id: '9999' },
    { view: 'inventory', scope: 'selected', id: '1.5' },
    { view: 'products', scope: 'unexpected' },
    { view: 'bogus', scope: 'all' },
    { view: 'inventory' },
  ]) {
    const response = await a.get(`/exports?${new URLSearchParams(fields)}`);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal(response.headers.get('content-disposition'), null);
  }
});

test('consulta exports both views while anonymous visitors cannot download', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  await a.signIn('viewer', 'equipo-seguro-123');
  const products = await (await a.get('/products')).text();
  const inventory = await (await a.get('/inventory')).text();
  assert.match(products, />Exportar<\/a>/);
  assert.match(inventory, />Exportar<\/a>/);
  assert.doesNotMatch(products, />Importar</);
  assert.equal((await download(await a.get(viewLink(products, 'Exportar')), 'productos.xlsx')).sheet.rowCount, 4);
  assert.equal((await download(await a.get(viewLink(inventory, 'Exportar')), 'inventario.xlsx')).sheet.rowCount, 4);
  a.cookie = '';
  const anonymous = await a.get('/exports?view=inventory&scope=all');
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/login');
  assert.equal(anonymous.headers.get('content-disposition'), null);
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
  const detail = await (await target.get('/products/1')).text();
  assert.match(detail, /Categoría<\/dt><dd>Motor/);
  assert.match(detail, /Existencias<\/dt><dd>7/);
  assert.match(detail, /Junta con retén de repuesto/);
  assert.match(detail, /Tipo de producto<\/dt><dd>Repuesto/);
  assert.match(detail, /Proveedor<\/dt><dd>Marino S\.A\./);
  assert.match(detail, /\$12\.34/);
  // Equivalent category, type and supplier names never duplicate the named lists.
  assert.equal((await target.post('/products', {
    csrfToken: target.csrfToken, partNumber: 'NUEVO', description: 'Otra junta', presentation: 'KIT',
    newCategory: 'motor', newProductType: 'repuesto', newSupplier: 'marino s.a.',
  })).status, 303);
  const edit = await (await target.get('/products/1/edit')).text();
  assert.equal([...edit.matchAll(/>Motor<\/option>/g)].length, 1);
  assert.equal([...edit.matchAll(/>Repuesto<\/option>/g)].length, 1);
  assert.equal([...edit.matchAll(/>Marino S\.A\.<\/option>/g)].length, 1);
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
  assert.equal(products.sheet.getCell('B1').value, 'Producto');
  assert.equal(products.sheet.getCell('H1').value, 'Categoría');
  assert.equal(products.sheet.getCell('M1').value, 'Cantidad');
  assert.equal((await a.get('/exports?view=inventory&scope=selected')).status, 400);
});

