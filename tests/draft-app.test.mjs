import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-draft-'));
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
  csrfToken = token(await (await get('/drafts')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/drafts')).text());
    return csrfToken;
  };
  return {
    url, get, post, token, signIn,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

async function seed(a) {
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
    email: 'ana@example.com', phone: '+58 412 000 0000',
  })).status, 303);
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Beto', lastName: 'Ruiz', taxId: 'V-2000',
    email: 'beto@example.com', phone: '+58 412 000 0001',
  })).status, 303);
  for (const [partNumber, description, presentation, price, quantity] of [
    ['JUNTA', 'Junta de culata', 'KIT', '10.00', '5'],
    ['ANODO', 'Ánodo de sacrificio', 'unidad', '2.50', '3'],
  ]) {
    assert.equal((await a.post('/products', {
      csrfToken: a.csrfToken, partNumber, description, presentation, price, initialQuantity: quantity,
    })).status, 303);
  }
}

const draftFields = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, customerId: '1', channelId: '1', discount: '0', notes: 'Cotización',
  productId: ['1'], quantity: ['2'], ...overrides,
});
const createDraft = (a, overrides = {}) => a.post('/drafts', draftFields(a, overrides));
const inventory = async (a, id) => (await (await a.get(`/products/${id}`)).text()).match(/Inventario<\/dt><dd>(\d+)/)?.[1];
const draftLinks = (html) => [...html.matchAll(/class="part-number"><a href="\/drafts\/(\d+)"/g)].map((match) => match[1]);
const headerCells = (html) => [...html.match(/<thead>([\s\S]*?)<\/thead>/)[1]
  .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim());

async function download(response, filename) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${filename}"`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  return workbook.worksheets[0];
}

test('crear un borrador con numeración propia no toca el inventario', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.match(await (await a.get('/drafts')).text(), /Todavía no hay borradores/);

  const created = await createDraft(a);
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/drafts/1');

  // The number is #D1 and the detail shows the quote, not an order.
  const detail = await (await a.get('/drafts/1')).text();
  assert.match(detail, /<h1>Borrador #D1<\/h1>/);
  assert.match(detail, /JUNTA/);
  assert.match(detail, /Total<\/dt><dd>\$20\.00<\/dd>/);
  assert.match(detail, /order-pill is-pending[^>]*>[\s\S]*?Abierto/);

  // Inventory is untouched and no movement is recorded.
  assert.equal(await inventory(a, 1), '5');
  const history = await (await a.get('/products/1/history')).text();
  assert.doesNotMatch(history, /#D1/);

  // The next draft takes #D2, keeping its own sequence.
  assert.equal((await createDraft(a)).headers.get('location'), '/drafts/2');
});

test('la lista muestra Pedido · Fecha · Cliente · Estado · Total y busca por número y cliente', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createDraft(a, { customerId: '1', productId: ['1'], quantity: ['2'], discount: '10' })).status, 303);
  assert.equal((await createDraft(a, { customerId: '2', productId: ['1', '2'], quantity: ['1', '1'] })).status, 303);

  const list = await (await a.get('/drafts')).text();
  assert.deepEqual(headerCells(list), ['Pedido', 'Fecha (UTC)', 'Cliente', 'Estado', 'Total']);
  assert.match(list, /#D2/);
  assert.match(list, /#D1/);
  assert.match(list, /Beto Ruiz/);
  assert.match(list, /Ana Pérez/);
  assert.match(list, /18\.00/);

  assert.deepEqual(draftLinks(await (await a.get('/drafts?q=D1')).text()), ['1']);
  assert.deepEqual(draftLinks(await (await a.get('/drafts?q=%23D2')).text()), ['2']);
  assert.deepEqual(draftLinks(await (await a.get('/drafts?q=ana')).text()), ['1']);
  assert.deepEqual(draftLinks(await (await a.get('/drafts?q=beto')).text()), ['2']);
});

test('editar un borrador cambia líneas y total sin tocar el número ni el inventario', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createDraft(a, { productId: ['1'], quantity: ['2'], discount: '10' })).status, 303);
  assert.equal(await inventory(a, 1), '5');

  const form = await (await a.get('/drafts/1/edit')).text();
  assert.match(form, /Editar borrador #D1/);
  // The saved discount pre-fills the percentage input.
  assert.match(form, /value="10" data-order-discount/);

  const saved = await a.post('/drafts/1', draftFields(a, { productId: ['1', '2'], quantity: ['1', '1'], discount: '0', notes: '' }));
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/drafts/1?saved=1');

  const detail = await (await a.get('/drafts/1?saved=1')).text();
  assert.match(detail, /Borrador guardado\./);
  assert.match(detail, /ANODO/);
  assert.match(detail, /Total<\/dt><dd>\$12\.50<\/dd>/);
  assert.equal(await inventory(a, 1), '5');
  assert.equal(await inventory(a, 2), '3');
});

test('los estados Abierto/Completado se alternan y un completado no se edita', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createDraft(a)).status, 303);

  const completed = await a.post('/drafts/1/complete', { csrfToken: a.csrfToken });
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get('location'), '/drafts/1?complete=1');
  const afterComplete = await (await a.get('/drafts/1?complete=1')).text();
  assert.match(afterComplete, /Borrador completado\./);
  assert.match(afterComplete, /order-pill is-fulfilled[^>]*>[\s\S]*?Completado/);
  assert.doesNotMatch(afterComplete, /Marcar como completado/);
  // A completed draft is not editable: the edit form redirects back to the ficha.
  assert.equal((await a.get('/drafts/1/edit')).headers.get('location'), '/drafts/1');

  assert.equal((await a.post('/drafts/1/reopen', { csrfToken: a.csrfToken })).status, 303);
  assert.match(await (await a.get('/drafts/1?reopen=1')).text(), /Borrador reabierto\./);
});

test('eliminar un borrador lo quita de la lista sin reutilizar su número', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createDraft(a)).status, 303);
  assert.equal((await createDraft(a)).headers.get('location'), '/drafts/2');

  const removed = await a.post('/drafts/1/delete', { csrfToken: a.csrfToken });
  assert.equal(removed.status, 303);
  assert.equal(removed.headers.get('location'), '/drafts?deleted=1');
  assert.match(await (await a.get('/drafts?deleted=1')).text(), /Borrador eliminado\./);
  assert.deepEqual(draftLinks(await (await a.get('/drafts')).text()), ['2']);

  // The sequence does not go back: the next draft is #D3.
  assert.equal((await createDraft(a)).headers.get('location'), '/drafts/3');
});

test('Exportar descarga los borradores con las columnas de la lista', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createDraft(a, { customerId: '1', discount: '10' })).status, 303);
  assert.equal((await createDraft(a, { customerId: '2' })).status, 303);

  const list = await (await a.get('/drafts')).text();
  const href = list.match(/href="([^"]+)"[^>]*>Exportar<\/a>/)?.[1]?.replaceAll('&amp;', '&');
  assert.match(href, /view=drafts/);
  assert.match(href, /scope=all/);

  const sheet = await download(await a.get(href), 'borradores.xlsx');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Pedido', 'Fecha', 'Cliente', 'Estado', 'Total']);
  assert.equal(sheet.getCell('A2').value, '#D2');
  assert.equal(sheet.getCell('C2').value, 'Beto Ruiz');
  assert.equal(sheet.getCell('D2').value, 'Abierto');
  assert.equal(sheet.getCell('E2').value, 20);
});

test('valida cliente, líneas y cantidades y exige CSRF', async (t) => {
  const a = await app(t);
  await seed(a);
  const cases = [
    [{ customerId: '' }, /cliente registrado/],
    [{ customerId: '999' }, /cliente seleccionado/],
    [{ productId: [''], quantity: [''] }, /al menos un artículo/],
    [{ productId: ['999'], quantity: ['1'] }, /ya no existe/],
    [{ productId: ['1'], quantity: ['0'] }, /cantidad entera mayor que cero/],
    [{ productId: ['1'], quantity: ['1.5'] }, /cantidad entera mayor que cero/],
  ];
  for (const [overrides, message] of cases) {
    const response = await createDraft(a, overrides);
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.match(await response.text(), message);
  }
  assert.doesNotMatch(await (await a.get('/drafts')).text(), /#D\d/);
  assert.equal((await a.post('/drafts', { customerId: '1', channelId: '1', productId: ['1'], quantity: ['1'] })).status, 403);
});

test('Consulta ve y exporta borradores pero no crea, edita ni elimina', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createDraft(a)).status, 303);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);

  await a.signIn('viewer', 'equipo-seguro-123');
  assert.equal((await a.get('/drafts')).status, 200);
  assert.equal((await a.get('/drafts/1')).status, 200);
  assert.doesNotMatch(await (await a.get('/drafts')).text(), /Crear borrador/);
  const detail = await (await a.get('/drafts/1')).text();
  assert.doesNotMatch(detail, /Editar|Marcar como completado|Eliminar/);
  assert.equal((await a.get('/drafts/new')).status, 403);
  assert.equal((await createDraft(a)).status, 403);
  assert.equal((await a.post('/drafts/1/delete', { csrfToken: a.csrfToken })).status, 403);
  assert.equal((await download(await a.get('/exports?view=drafts&scope=all'), 'borradores.xlsx')).rowCount, 2);
});
