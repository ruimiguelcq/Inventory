import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-order-list-'));
  const databasePath = join(directory, 'inventory.sqlite');
  const server = createInventoryServer({ databasePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrfToken = '';
  const encode = (fields) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, item);
      else params.append(key, value);
    }
    return params;
  };
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual', body: encode(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrfToken = token(await (await get('/orders')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/orders')).text());
    return csrfToken;
  };
  return {
    url, get, post, token, signIn,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

// Customers Ana (1) and Beto (2); products JUNTA (1, $10.00) and ANODO (2, $2.50), 100 in stock each.
async function seed(a) {
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
    email: 'ana@example.com', phone: '+58 412 000 0000',
  })).status, 303);
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Beto', lastName: 'Ruiz', taxId: 'V-2000',
    email: 'beto@example.com', phone: '+58 412 000 0001',
  })).status, 303);
  for (const [partNumber, description, presentation, price] of [
    ['JUNTA', 'Junta de culata', 'KIT', '10.00'],
    ['ANODO', 'Ánodo de sacrificio', 'unidad', '2.50'],
  ]) {
    assert.equal((await a.post('/products', {
      csrfToken: a.csrfToken, partNumber, description, presentation, price, initialQuantity: '100',
    })).status, 303);
  }
}

const orderFields = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, customerId: '1', channelId: '1', discount: '0', notes: '',
  productId: ['1'], quantity: ['1'], ...overrides,
});

const createOrder = (a, overrides = {}) => a.post('/orders', orderFields(a, overrides));

// Three orders: #1001 Ana/Online/JUNTA×2, #1002 Beto/Tienda/JUNTA+ANODO, #1003 Ana/Correo/JUNTA.
async function threeOrders(a) {
  await seed(a);
  assert.equal((await createOrder(a, { customerId: '1', channelId: '1', productId: ['1'], quantity: ['2'], discount: '10' })).headers.get('location'), '/orders/1001');
  assert.equal((await createOrder(a, { customerId: '2', channelId: '2', productId: ['1', '2'], quantity: ['1', '1'] })).headers.get('location'), '/orders/1002');
  assert.equal((await createOrder(a, { customerId: '1', channelId: '3', productId: ['1'], quantity: ['1'] })).headers.get('location'), '/orders/1003');
}

const headerCells = (html) => [...html.match(/<thead>([\s\S]*?)<\/thead>/)[1]
  .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim());
// The outer order row, delimited by this order's link and the next order's link.
const rowfor = (html, number) => {
  const start = html.indexOf(`<a href="/orders/${number}">`);
  if (start === -1) return '';
  const rowStart = html.lastIndexOf('<tr>', start);
  const next = html.slice(start + 1).search(/<a href="\/orders\/\d+">/);
  const end = next === -1 ? html.indexOf('</tbody>', start) : start + 1 + next;
  return html.slice(rowStart, end);
};
const orderLinks = (html) => [...html.matchAll(/class="part-number"><a href="\/orders\/(\d+)"/g)].map((match) => match[1]);
const toolbar = (html) => html.match(/<form class="catalog-toolbar"[\s\S]*?<\/form>/)?.[0] ?? '';

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

test('la lista muestra exactamente las columnas de la lista, sin tarjetas de resumen', async (t) => {
  const a = await app(t);
  await threeOrders(a);
  const html = await (await a.get('/orders')).text();

  assert.deepEqual(headerCells(html),
    ['Pedido', 'Fecha (UTC)', 'Cliente', 'Canal', 'Descuento', 'Total', 'Artículos', 'Estado']);

  // The heading carries only Exportar and Crear pedido; no summary cards anywhere.
  const heading = html.match(/<div class="page-heading">([\s\S]*?)<\/div>\s*<\/div>/)?.[0] ?? '';
  assert.match(heading, />Exportar<\/a>/);
  assert.match(heading, />Crear pedido<\/a>/);
  assert.doesNotMatch(heading, /<section|<article/);
  assert.doesNotMatch(html, /class="table-toolbar"/);

  const row = rowfor(html, '1002');
  assert.match(row, /Beto Ruiz/);
  assert.match(row, /Tienda/);
  assert.match(row, /\$12\.50/);
  assert.match(row, /Abierto/);
});

test('la búsqueda es instantánea por número de pedido y por nombre de cliente', async (t) => {
  const a = await app(t);
  await threeOrders(a);
  const html = await (await a.get('/orders')).text();
  assert.match(toolbar(html), /data-instant-search/);
  assert.match(html, /data-catalog-results/);

  assert.deepEqual(orderLinks(await (await a.get('/orders?q=1001')).text()), ['1001']);
  assert.deepEqual(orderLinks(await (await a.get('/orders?q=%231002')).text()), ['1002']);
  assert.deepEqual(orderLinks(await (await a.get('/orders?q=ana')).text()).sort(), ['1001', '1003']);
  assert.deepEqual(orderLinks(await (await a.get('/orders?q=beto')).text()), ['1002']);

  // The channel name is not part of the search; only number and customer match.
  const none = await (await a.get('/orders?q=Online')).text();
  assert.match(none, /Sin resultados/);
  assert.deepEqual(orderLinks(none), []);
});

test('el filtro por Canal combina con la búsqueda', async (t) => {
  const a = await app(t);
  await threeOrders(a);
  const filtered = await (await a.get('/orders?channel=2')).text();
  assert.deepEqual(orderLinks(filtered), ['1002']);
  assert.match(toolbar(filtered), /<option value="2" selected>Tienda<\/option>/);

  assert.deepEqual(orderLinks(await (await a.get('/orders?channel=3')).text()), ['1003']);
  assert.deepEqual(orderLinks(await (await a.get('/orders?channel=1&q=beto')).text()), []);
});

test('la paginación es fija de 50 con Anterior y Siguiente, sin selector de tamaño', async (t) => {
  const a = await app(t);
  await seed(a);
  for (let index = 1; index <= 51; index += 1) assert.equal((await createOrder(a)).status, 303);

  const first = await (await a.get('/orders')).text();
  assert.equal(orderLinks(first).length, 50);
  assert.match(first, /51 pedidos · Página 1 de 2/);
  assert.match(first, /href="\/orders\?page=2"/);
  assert.doesNotMatch(first, /page=1/);
  assert.doesNotMatch(toolbar(first), /pageSize/);

  const second = await (await a.get('/orders?page=2')).text();
  assert.equal(orderLinks(second).length, 1);
  assert.match(second, /Página 2 de 2/);
  assert.match(second, /href="\/orders\?page=1"/);
  assert.doesNotMatch(second, /page=3/);
});

test('pulsar Artículos muestra el desglose con producto, P/N, presentación y cantidad', async (t) => {
  const a = await app(t);
  await threeOrders(a);
  const html = await (await a.get('/orders')).text();

  const single = rowfor(html, '1001');
  assert.match(single, /<details class="order-breakdown">/);
  assert.match(single, /<summary>1 artículo<\/summary>/);

  const multi = rowfor(html, '1002');
  assert.match(multi, /<summary>2 artículos<\/summary>/);
  assert.match(multi, /JUNTA/);
  assert.match(multi, /ANODO/);
  assert.match(multi, /KIT/);
  assert.match(multi, /EA/);
  assert.match(multi, /Producto<\/th>[\s\S]*P\/N<\/th>[\s\S]*Presentación<\/th>[\s\S]*Cantidad<\/th>/);
});

test('Exportar genera un Excel con una fila por pedido y las columnas de la lista, sin desglose', async (t) => {
  const a = await app(t);
  await threeOrders(a);
  const html = await (await a.get('/orders')).text();
  const href = html.match(/href="([^"]+)"[^>]*>Exportar<\/a>/)?.[1]?.replaceAll('&amp;', '&');
  assert.match(href, /\/exports\?/);
  assert.match(href, /view=orders/);
  assert.match(href, /scope=all/);

  const { sheet } = await download(await a.get(href), 'pedidos.xlsx');
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(1).values.slice(1),
    ['Pedido', 'Fecha', 'Cliente', 'Canal', 'Descuento', 'Total', 'Artículos', 'Estado']);
  // Newest order first: #1003, #1002, #1001.
  assert.equal(sheet.getCell('A2').value, '#1003');
  assert.match(String(sheet.getCell('B2').value), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(sheet.getCell('C2').value, 'Ana Pérez');
  assert.equal(sheet.getCell('D2').value, 'Correo');
  assert.equal(sheet.getCell('E2').value, 0);
  assert.equal(sheet.getCell('F2').value, 10);
  assert.equal(sheet.getCell('G2').value, 1);
  assert.equal(sheet.getCell('H2').value, 'Abierto');
  assert.equal(sheet.getCell('A4').value, '#1001');
  assert.equal(sheet.getCell('E4').value, 0.1);
  assert.equal(sheet.getCell('F4').value, 18);
  assert.equal(sheet.getCell('G3').value, 2);
  // No breakdown inside the workbook: product names and P/N never appear.
  const cells = [];
  sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value))));
  assert.equal(cells.includes('JUNTA'), false);
  assert.equal(cells.includes('ANODO'), false);
});

test('la exportación sigue la búsqueda y el filtro de canal, y Consulta puede exportar sin crear', async (t) => {
  const a = await app(t);
  await threeOrders(a);
  const filtered = await (await a.get('/orders?channel=2')).text();
  const href = filtered.match(/href="([^"]+)"[^>]*>Exportar<\/a>/)?.[1]?.replaceAll('&amp;', '&');
  assert.match(href, /channel=2/);
  const { sheet } = await download(await a.get(href), 'pedidos.xlsx');
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('A2').value, '#1002');

  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  await a.signIn('viewer', 'equipo-seguro-123');
  const list = await (await a.get('/orders')).text();
  assert.match(list, />Exportar<\/a>/);
  assert.doesNotMatch(list, /Crear pedido/);
  assert.equal((await download(await a.get('/exports?view=orders&scope=all'), 'pedidos.xlsx')).sheet.rowCount, 4);
  assert.equal((await a.get('/exports?view=orders&scope=selected')).status, 400);
});
