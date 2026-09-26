import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-purchase-selection-'));
  const server = createInventoryServer({ databasePath: join(directory, 'inventory.sqlite') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrfToken = '';
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual',
    body: fields instanceof URLSearchParams ? fields : new URLSearchParams(fields),
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

function selection(ids, csrfToken) {
  const params = new URLSearchParams({ csrfToken });
  for (const id of ids) params.append('id', String(id));
  return params;
}

async function setStock(a, id, quantity) {
  const review = await a.post(`/products/${id}/stock`, { csrfToken: a.csrfToken, operation: 'set', quantity: String(quantity) });
  assert.equal(review.status, 200);
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post(`/products/${id}/stock/confirm`, { csrfToken: a.csrfToken, confirmationToken })).status, 303);
}

// Four active articles to build inventory selections from.
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

const lineIdFrom = (html) => Number(html.match(/name="line-(\d+)"/)[1]);
const lineCountFrom = (html) => [...html.matchAll(/name="line-\d+"/g)].length;

test('adds the inventory selection to a new purchase list', async (t) => {
  const a = await app(t);
  await seed(a);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /formaction="\/purchase-orders\/add-selection"/);
  assert.match(inventory, /Añadir a lista de compra/);

  // Duplicate ids are collapsed: the selection is two distinct articles.
  const review = await a.post('/purchase-orders/add-selection', selection(['1', '2', '2'], a.csrfToken));
  assert.equal(review.status, 200);
  const html = await review.text();
  assert.match(html, /2 artículos seleccionados/);
  assert.match(html, /JUNTA/);
  assert.match(html, /ANODO/);
  assert.match(html, /value="new">Nueva lista de compra/);

  const confirmed = await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken'), destination: 'new',
  });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get('location'), '/purchase-orders/1?added=selection');

  const detail = await (await a.get('/purchase-orders/1?added=selection')).text();
  assert.match(detail, /Artículos añadidos a la lista/);
  assert.match(detail, /JUNTA/);
  assert.match(detail, /ANODO/);
  assert.equal(lineCountFrom(detail), 2);
  // New lines start with an empty requested quantity.
  assert.match(detail, /name="line-\d+" value=""/);
});

test('adds to an existing draft without duplicating lines or overwriting quantities', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);
  assert.equal((await a.post(`/purchase-orders/${id}/lines`, { csrfToken: a.csrfToken, productId: '1' })).status, 303);
  const lineId = lineIdFrom(await (await a.get(`/purchase-orders/${id}`)).text());
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '5' })).status, 303);

  const review = await a.post('/purchase-orders/add-selection', selection(['1', '2'], a.csrfToken));
  const html = await review.text();
  assert.match(html, new RegExp(`<option value="${id}">Compra #${id}`));
  const confirmed = await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken'), destination: String(id),
  });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get('location'), `/purchase-orders/${id}?added=selection`);

  const detail = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.equal(lineCountFrom(detail), 2);
  // The repeated article keeps its line and quantity; the new one starts empty.
  assert.match(detail, new RegExp(`name="line-${lineId}" value="5"`));
  assert.match(detail, /name="line-\d+" value=""/);
});

test('consulta cannot add to a list and keeps its inventory export', async (t) => {
  const a = await app(t);
  await seed(a);
  for (const role of ['manager', 'viewer']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }

  const viewerToken = await a.signIn('viewer', 'equipo-seguro-123');
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /Exportar selección a Excel/);
  assert.doesNotMatch(inventory, /Añadir a lista de compra/);
  assert.equal((await a.post('/purchase-orders/add-selection', selection(['1'], viewerToken))).status, 403);
  assert.equal((await a.post('/purchase-orders/add-selection/confirm', { csrfToken: viewerToken, destination: 'new' })).status, 403);

  const managerToken = await a.signIn('manager', 'equipo-seguro-123');
  assert.equal((await a.post('/purchase-orders/add-selection', selection(['1'], managerToken))).status, 200);

  // CSRF is required.
  const noCsrf = new URLSearchParams();
  noCsrf.append('id', '1');
  assert.equal((await a.post('/purchase-orders/add-selection', noCsrf)).status, 403);
});

test('an empty or invalid selection creates nothing', async (t) => {
  const a = await app(t);
  await seed(a);
  for (const ids of [[], ['1.5'], ['abc'], ['0'], ['9999']]) {
    const response = await a.post('/purchase-orders/add-selection', selection(ids, a.csrfToken));
    assert.equal(response.status, 400, JSON.stringify(ids));
  }
  assert.match(await (await a.get('/purchase-orders')).text(), /Todavía no hay listas de compra/);
});

test('an article archived between selection and confirmation is not added', async (t) => {
  const a = await app(t);
  await seed(a);
  const review = await a.post('/purchase-orders/add-selection', selection(['1'], a.csrfToken));
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post('/products/1/archive', { csrfToken: a.csrfToken })).status, 303);

  const confirmed = await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken, destination: 'new',
  });
  assert.equal(confirmed.status, 400);
  assert.match(await confirmed.text(), /ya no está activo/);
  assert.match(await (await a.get('/purchase-orders')).text(), /Todavía no hay listas de compra/);
});

test('archived lists are not offered as destinations until reopened', async (t) => {
  const a = await app(t);
  await seed(a);
  const id = await createOrder(a);
  assert.equal((await a.post(`/purchase-orders/${id}/archive`, { csrfToken: a.csrfToken })).status, 303);

  const review = await a.post('/purchase-orders/add-selection', selection(['1'], a.csrfToken));
  const html = await review.text();
  assert.doesNotMatch(html, new RegExp(`<option value="${id}">`));
  const confirmed = await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken'), destination: String(id),
  });
  assert.equal(confirmed.status, 400);
  assert.match(await confirmed.text(), /ya no está en borrador/);

  // Reopening makes it available again.
  assert.equal((await a.post(`/purchase-orders/${id}/reopen`, { csrfToken: a.csrfToken })).status, 303);
  const reopened = await a.post('/purchase-orders/add-selection', selection(['1'], a.csrfToken));
  assert.match(await reopened.text(), new RegExp(`<option value="${id}">`));
});

test('adding the selection never changes stock or movement history', async (t) => {
  const a = await app(t);
  await seed(a);
  const historyBefore = await (await a.get('/products/1/history')).text();
  const detailBefore = await (await a.get('/products/1')).text();

  const review = await a.post('/purchase-orders/add-selection', selection(['1', '3'], a.csrfToken));
  assert.equal((await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(await review.text(), 'confirmationToken'), destination: 'new',
  })).status, 303);

  assert.equal(await (await a.get('/products/1/history')).text(), historyBefore);
  assert.equal(await (await a.get('/products/1')).text(), detailBefore);
});

test('the confirmation is single-use and a stale token creates nothing', async (t) => {
  const a = await app(t);
  await seed(a);
  const review = await a.post('/purchase-orders/add-selection', selection(['1'], a.csrfToken));
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken, destination: 'new',
  })).status, 303);

  const repeat = await a.post('/purchase-orders/add-selection/confirm', {
    csrfToken: a.csrfToken, confirmationToken, destination: 'new',
  });
  assert.equal(repeat.status, 400);
  assert.match(await repeat.text(), /Vuelve a seleccionar/);
  assert.doesNotMatch(await (await a.get('/purchase-orders')).text(), /Compra #2/);
});
