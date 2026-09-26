import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-purchase-export-'));
  const databasePath = join(directory, 'inventory.sqlite');
  let server = createInventoryServer({ databasePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrfToken = '';
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual',
    body: new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrfToken = token(await (await get('/inventory')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/inventory')).text());
    return csrfToken;
  };
  return {
    url, get, post, token, signIn,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

async function setStock(a, id, quantity) {
  const review = await a.post(`/products/${id}/stock`, { csrfToken: a.csrfToken, operation: 'set', quantity: String(quantity) });
  assert.equal(review.status, 200);
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post(`/products/${id}/stock/confirm`, { csrfToken: a.csrfToken, confirmationToken })).status, 303);
}

// Four articles with a mix of stock states, enough to exercise the purchase list.
async function seed(a) {
  const products = [
    { partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT', minimumStock: '2' },
    { partNumber: 'ANODO', description: 'Ánodo de sacrificio', presentation: 'unidad' },
    { partNumber: 'KIT-BOMBA', description: 'Kit bomba de achique', presentation: 'SET', minimumStock: '4' },
    { partNumber: 'FILTRO', description: 'Filtro de aceite', presentation: 'unidad', minimumStock: '1' },
  ];
  for (const product of products) {
    assert.equal((await a.post('/products', { csrfToken: a.csrfToken, ...product })).status, 303);
  }
  await setStock(a, 1, 0);
  await setStock(a, 2, 3);
  await setStock(a, 3, 2);
  await setStock(a, 4, 1);
}

async function createOrder(a, token = a.csrfToken) {
  const response = await a.post('/purchase-orders', { csrfToken: token });
  assert.equal(response.status, 303);
  return Number(response.headers.get('location').match(/\/purchase-orders\/(\d+)/)[1]);
}

async function addLine(a, id, productId, token = a.csrfToken) {
  return a.post(`/purchase-orders/${id}/lines`, { csrfToken: token, productId: String(productId) });
}

// Each line row links to its product, so the line id can be read straight from the detail page.
function lineForProduct(html, productId) {
  for (const row of html.split('<tr>')) {
    if (row.includes(`href="/products/${productId}"`)) {
      const match = row.match(/name="line-(\d+)"/);
      if (match) return Number(match[1]);
    }
  }
  throw new Error(`no line for product ${productId}`);
}

async function setQuantity(a, id, productId, quantity, token = a.csrfToken) {
  const html = await (await a.get(`/purchase-orders/${id}`)).text();
  const lineId = lineForProduct(html, productId);
  const response = await a.post(`/purchase-orders/${id}`, { csrfToken: token, [`line-${lineId}`]: String(quantity) });
  assert.equal(response.status, 303);
  return lineId;
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

test('exports exactly P/N, name and requested quantity as text, including archived articles', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303); // JUNTA
  assert.equal((await addLine(a, id, 2)).status, 303); // ANODO
  await setQuantity(a, id, 1, 5);
  await setQuantity(a, id, 2, 2);
  // An article archived after it joined the list stays identified and is still exported.
  assert.equal((await a.post('/products/2/archive', { csrfToken: a.csrfToken })).status, 303);

  const detail = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(detail, /ANODO[\s\S]*Archivado/);

  const { sheet } = await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`);
  assert.equal(sheet.rowCount, 3);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['P/N', 'Nombre', 'Cantidad solicitada']);
  assert.equal(sheet.getRow(1).values.slice(1).length, 3);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['ANODO', 'Ánodo de sacrificio', 2]);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['JUNTA', 'Junta de culata', 5]);
  assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('C2').value, 2);

  const listing = await (await a.get('/purchase-orders')).text();
  assert.match(listing, new RegExp(`/purchase-orders/${id}/export`));
});

test('refuses to export an empty or incomplete list without producing a file', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);

  const empty = await a.get(`/purchase-orders/${id}/export`);
  assert.equal(empty.status, 400);
  assert.equal(empty.headers.get('content-disposition'), null);
  assert.match(await empty.text(), /no tiene artículos que exportar/);

  assert.equal((await addLine(a, id, 1)).status, 303);
  // A draft may stay incomplete, but it cannot be exported while a quantity is empty.
  const incomplete = await a.get(`/purchase-orders/${id}/export`);
  assert.equal(incomplete.status, 400);
  assert.equal(incomplete.headers.get('content-disposition'), null);
  assert.match(await incomplete.text(), /enteros mayores que cero/);
  // The page still shows the export action and the rejected export stored nothing.
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), new RegExp(`/purchase-orders/${id}/export`));
  assert.match(await (await a.get('/purchase-orders')).text(), /0\/1/);

  await setQuantity(a, id, 1, 3);
  const { sheet } = await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`);
  assert.equal(sheet.rowCount, 2);
});

test('consulta views and exports while only gestión and administración archive and reopen', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  await setQuantity(a, id, 1, 4);
  for (const role of ['manager', 'viewer']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }

  const viewerToken = await a.signIn('viewer', 'equipo-seguro-123');
  const listing = await (await a.get('/purchase-orders')).text();
  assert.match(listing, new RegExp(`/purchase-orders/${id}/export`));
  assert.doesNotMatch(await (await a.get(`/purchase-orders/${id}`)).text(), /Archivar|Reabrir|Guardar borrador/);
  assert.equal((await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`)).sheet.rowCount, 2);
  assert.equal((await a.post(`/purchase-orders/${id}/archive`, { csrfToken: viewerToken })).status, 403);
  assert.equal((await a.post(`/purchase-orders/${id}/reopen`, { csrfToken: viewerToken })).status, 403);

  const managerToken = await a.signIn('manager', 'equipo-seguro-123');
  assert.equal((await a.post(`/purchase-orders/${id}/archive`, { csrfToken: managerToken })).status, 303);
  assert.equal((await a.post(`/purchase-orders/${id}/reopen`, { csrfToken: managerToken })).status, 303);
  assert.equal((await a.post(`/purchase-orders/${id}/reopen`, { csrfToken: managerToken })).status, 303);

  // CSRF is required for the status changes.
  assert.equal((await a.post(`/purchase-orders/${id}/archive`, {})).status, 403);

  a.csrfToken = await a.signIn('admin', 'marina-segura-123');
  assert.equal((await a.post(`/purchase-orders/${id}/archive`, { csrfToken: a.csrfToken })).status, 303);
  assert.equal((await a.get('/purchase-orders/9999/export')).status, 404);
});

test('archived lists are read-only, stay exportable and reopen into an editable draft', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  assert.equal((await addLine(a, id, 2)).status, 303);
  await setQuantity(a, id, 1, 5);
  await setQuantity(a, id, 2, 2);
  const lineId = lineForProduct(await (await a.get(`/purchase-orders/${id}`)).text(), 1);

  const archived = await a.post(`/purchase-orders/${id}/archive`, { csrfToken: a.csrfToken });
  assert.equal(archived.status, 303);
  assert.equal(archived.headers.get('location'), `/purchase-orders/${id}?archived=1`);

  const archivedDetail = await (await a.get(archived.headers.get('location'))).text();
  assert.match(archivedDetail, /Lista archivada/);
  assert.match(archivedDetail, /Archivada/);
  assert.doesNotMatch(archivedDetail, /name="line-|Guardar borrador|Añadir artículo/);
  assert.match(archivedDetail, /Reabrir/);
  assert.match((await (await a.get('/purchase-orders')).text()), /Archivada/);

  // An archived list is still exportable.
  assert.equal((await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`)).sheet.rowCount, 3);

  // Editing is refused until the list is reopened.
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '9' })).status, 400);
  assert.equal((await addLine(a, id, 3)).status, 400);
  assert.equal((await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken })).status, 400);

  const reopened = await a.post(`/purchase-orders/${id}/reopen`, { csrfToken: a.csrfToken });
  assert.equal(reopened.status, 303);
  assert.equal(reopened.headers.get('location'), `/purchase-orders/${id}?reopened=1`);
  const reopenedDetail = await (await a.get(reopened.headers.get('location'))).text();
  assert.match(reopenedDetail, /Lista reabierta/);
  assert.match(reopenedDetail, new RegExp(`name="line-${lineId}" value="5"`));

  // Editing works again after reopening.
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '7' })).status, 303);
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), new RegExp(`name="line-${lineId}" value="7"`));
});

test('exporting and archiving never change stock or movement history', async (t) => {
  const a = await app(t);
  await seed(a);
  const historyBefore = await (await a.get('/products/1/history')).text();
  const detailBefore = await (await a.get('/products/1')).text();

  const id = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  await setQuantity(a, id, 1, 9);
  await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`);
  assert.equal((await a.post(`/purchase-orders/${id}/archive`, { csrfToken: a.csrfToken })).status, 303);
  // Export can be repeated while archived.
  await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`);
  assert.equal((await a.post(`/purchase-orders/${id}/reopen`, { csrfToken: a.csrfToken })).status, 303);
  await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`);

  assert.equal(await (await a.get('/products/1/history')).text(), historyBefore);
  assert.equal(await (await a.get('/products/1')).text(), detailBefore);
});

test('an archived article already in the list is exported and can still be removed while drafting', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  await setQuantity(a, id, 1, 3);
  assert.equal((await a.post('/products/1/archive', { csrfToken: a.csrfToken })).status, 303);

  const before = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(before, /Archivado/);
  assert.equal((await download(await a.get(`/purchase-orders/${id}/export`), `compra-${id}.xlsx`)).sheet.getCell('A2').value, 'JUNTA');

  const lineId = lineForProduct(before, 1);
  assert.equal((await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken })).status, 303);
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), /Todavía no hay artículos/);
  // With no lines left the list is no longer exportable.
  assert.equal((await a.get(`/purchase-orders/${id}/export`)).status, 400);
});
