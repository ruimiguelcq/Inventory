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
  return { get, post, token, csrfToken, set cookie(value) { cookie = value; } };
}

async function seed(a) {
  for (const product of [
    { partNumber: '00123', description: 'Junta <marina> & retén', presentation: 'KIT', brand: '=Motor', location: 'Estante Ñ', minimumStock: '0' },
    { partNumber: 'B-2', description: 'Ánodo', presentation: 'unidad' },
    { partNumber: 'C-3', description: 'Juego completo', presentation: 'SET', minimumStock: '2' },
  ]) assert.equal((await a.post('/products', { csrfToken: a.csrfToken, ...product })).status, 303);
  const review = await a.post('/products/1/stock', { csrfToken: a.csrfToken, operation: 'set', quantity: '7', reason: 'Recuento' });
  assert.equal((await a.post('/products/1/stock/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(await review.text(), 'confirmationToken'),
  })).status, 303);
}

async function download(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="inventario.*\.xlsx"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const bytes = await response.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.equal(workbook.worksheets.length, 1);
  return { bytes, sheet: workbook.worksheets[0] };
}

test('the inventory downloads all articles as Excel values without changing articles or history', async (t) => {
  const a = await app(t);
  await seed(a);
  const before = await (await a.get('/inventory')).text();
  const history = await (await a.get('/products/1/history')).text();
  const link = before.match(/href="([^"]+)"[^>]*>Exportar<\/a>/)?.[1];
  assert.ok(link, 'The inventory offers a complete Excel download');
  const { sheet } = await download(await a.get(link.replaceAll('&amp;', '&')));
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['P/N', 'Descripción', 'Presentación', 'Marca', 'Ubicación', 'Mínimo de stock', 'Cantidad']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['00123', 'Junta <marina> & retén', 'KIT', '=Motor', 'Estante Ñ', 0, 7]);
  assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('D2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('F3').value, null);
  assert.equal(sheet.getCell('G3').value, 0);
  assert.equal(await (await a.get('/inventory')).text(), before);
  assert.equal(await (await a.get('/products/1/history')).text(), history);
});

test('selected rows export only those articles and an empty or invalid selection never exports everything', async (t) => {
  const a = await app(t);
  await seed(a);
  const html = await (await a.get('/inventory')).text();
  assert.match(html, /<form[^>]*method="post"[^>]*action="\/exports"/);
  assert.match(html, /name="scope" value="selected"/);
  assert.match(html, /type="checkbox" name="id" value="1"[^>]*aria-label="Seleccionar 00123"/);
  assert.match(html, /Exportar selección a Excel/);
  const selection = new URLSearchParams({ csrfToken: a.csrfToken, scope: 'selected' });
  for (const id of ['3', '1', '1']) selection.append('id', id);
  const { sheet } = await download(await a.post('/exports', selection));
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('A2').value, '00123');
  assert.equal(sheet.getCell('A3').value, 'C-3');
  assert.equal((await a.post('/exports', { scope: 'selected', id: '1' })).status, 403);
  for (const query of ['scope=selected', 'scope=selected&id=1&id=999', 'scope=selected&id=1.5', 'scope=selected&id=oops', 'scope=unexpected', '']) {
    const fields = new URLSearchParams(query);
    fields.set('csrfToken', a.csrfToken);
    const response = await a.post('/exports', fields);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match(await response.text(), /Selecciona|selección|exportación/);
  }
});

test('an exported workbook can be reviewed and imported with the same catalog and quantities', async (t) => {
  const source = await app(t);
  await seed(source);
  const { bytes } = await download(await source.get('/exports?scope=all'));
  const target = await app(t);
  const form = new FormData();
  form.set('csrfToken', target.csrfToken);
  form.set('descriptions', 'on');
  form.set('stock', 'on');
  form.set('operation', 'set');
  form.set('file', new Blob([bytes]), 'inventario.xlsx');
  const preview = await target.post('/imports', form);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /3 altas · 0 actualizaciones · 0 filas con errores/);
  assert.match(html, /Junta &lt;marina&gt; &amp; retén/);
  assert.match(html, /0 → 7 KIT/);
  assert.doesNotMatch(await (await target.get('/inventory')).text(), /00123/);
  assert.equal((await target.post('/imports/confirm', {
    csrfToken: target.csrfToken, confirmationToken: target.token(html, 'confirmationToken'),
  })).status, 303);
  const { sheet } = await download(await target.get('/exports?scope=all'));
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['00123', 'Junta <marina> & retén', 'KIT', '=Motor', 'Estante Ñ', 0, 7]);
  assert.equal(sheet.getCell('A3').value, 'B-2');
  for (const cell of ['D3', 'E3', 'F3']) assert.equal(sheet.getCell(cell).value, null);
  assert.equal(sheet.getCell('G3').value, 0);
  assert.equal(sheet.getCell('A4').value, 'C-3');
  assert.equal(sheet.getCell('C4').value, 'SET');
  assert.equal(sheet.getCell('F4').value, 2);
  const repeat = await target.post('/imports', form);
  assert.equal(repeat.status, 200);
  assert.match(await repeat.text(), /0 altas · 3 actualizaciones · 0 filas con errores/);
  assert.match(await (await target.get('/products/1/history')).text(), /Importación Excel/);
});

test('consulta and gestión can export all or selected articles while anonymous users cannot download', async (t) => {
  const a = await app(t);
  await seed(a);
  for (const role of ['viewer', 'manager']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }
  for (const role of ['viewer', 'manager']) {
    const login = await a.post('/login', { username: role, password: 'equipo-seguro-123' });
    a.cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await a.get('/inventory')).text();
    assert.match(html, />Exportar<\/a>/);
    assert.match(html, /Exportar selección a Excel/);
    assert.equal((await download(await a.get('/exports?scope=all'))).sheet.rowCount, 4);
    assert.equal((await download(await a.post('/exports', { csrfToken: a.token(html), scope: 'selected', id: '2' }))).sheet.getCell('A2').value, 'B-2');
  }
  a.cookie = '';
  for (const response of [await a.get('/exports?scope=all'), await a.post('/exports', { scope: 'selected', id: '1' })]) {
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(response.headers.get('content-disposition'), null);
  }
});

test('an empty inventory downloads a workbook with headers and no phantom articles', async (t) => {
  const a = await app(t);
  const { sheet } = await download(await a.get('/exports?scope=all'));
  assert.equal(sheet.rowCount, 1);
  assert.equal(sheet.getCell('A1').value, 'P/N');
  assert.equal(sheet.getCell('G1').value, 'Cantidad');
  assert.equal((await a.get('/exports?scope=selected')).status, 400);
});

test('consulta can download a selection larger than the HTTP URL limit', async (t) => {
  const a = await app(t);
  // Populate through the reviewed import flow in supported batches.
  for (let batch = 0; batch < 3; batch++) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventario');
    sheet.addRow(['P/N', 'Descripción', 'Presentación']);
    for (let row = 1; row <= 800; row++) {
      sheet.addRow([`P-${String(batch * 800 + row).padStart(4, '0')}`, 'Repuesto', 'unidad']);
    }
    const form = new FormData();
    form.set('csrfToken', a.csrfToken);
    form.set('descriptions', 'on');
    form.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'lote.xlsx');
    const preview = await a.post('/imports', form);
    assert.equal(preview.status, 200);
    assert.equal((await a.post('/imports/confirm', {
      csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken'),
    })).status, 303);
  }
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  const login = await a.post('/login', { username: 'viewer', password: 'equipo-seguro-123' });
  a.cookie = login.headers.get('set-cookie').split(';')[0];
  // The table paginates the selection to the visible page, but the export endpoint
  // still accepts an explicit selection too large for a GET URL.
  const inventory = await (await a.get('/inventory')).text();
  assert.equal([...inventory.matchAll(/type="checkbox" name="id" value="(\d+)"/g)].length, 50);
  const selection = new URLSearchParams({ csrfToken: a.token(inventory), scope: 'selected' });
  const ids = Array.from({ length: 2400 }, (_, index) => String(index + 1));
  for (const id of ids) selection.append('id', id);
  assert.ok(Buffer.byteLength(selection.toString()) > 16_384);
  const { sheet } = await download(await a.post('/exports', selection));
  assert.equal(sheet.rowCount, 2401);
  assert.equal(sheet.getCell('A2').value, 'P-0001');
  assert.equal(sheet.getCell('A2401').value, 'P-2400');
});
