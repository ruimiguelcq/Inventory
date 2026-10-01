import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-order-annul-'));
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

// One customer (1) and two priced articles: JUNTA (5 in stock, $10.00) and ANODO (3, $2.50).
async function seed(a) {
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
    email: 'ana@example.com', phone: '+58 412 000 0000',
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

// #1001 discounts 2 JUNTA and 1 ANODO, leaving 3 and 2.
const createOrder = (a, overrides = {}) => a.post('/orders', {
  csrfToken: a.csrfToken, customerId: '1', channelId: '1', discount: '0', notes: '',
  productId: ['1', '2'], quantity: ['2', '1'], ...overrides,
});

const annul = (a, number) => a.post(`/orders/${number}/annul`, { csrfToken: a.csrfToken });
const inventory = async (a, id) => (await (await a.get(`/products/${id}`)).text()).match(/Inventario<\/dt><dd>(\d+)/)?.[1];
const orderLinks = (html) => [...html.matchAll(/class="part-number"><a href="\/orders\/(\d+)"/g)].map((match) => match[1]);

test('anular repone exactamente las cantidades descontadas con un movimiento por línea', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).headers.get('location'), '/orders/1001');
  assert.equal(await inventory(a, 1), '3');
  assert.equal(await inventory(a, 2), '2');

  const annulled = await annul(a, 1001);
  assert.equal(annulled.status, 303);
  assert.equal(annulled.headers.get('location'), '/orders/1001?annulled=1');

  // Exactly the discounted quantities are restored, never more.
  assert.equal(await inventory(a, 1), '5');
  assert.equal(await inventory(a, 2), '3');

  // One positive movement per line, with the order origin, after the original decrement.
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /<td>2<\/td><td>3<\/td><td>5<\/td>/);
  assert.match(history, /Anulación del pedido #1001/);
  assert.match(history, /<td>-2<\/td><td>5<\/td><td>3<\/td>/);
  assert.equal([...history.matchAll(/>Pedido</g)].length, 2);
  const historyTwo = await (await a.get('/products/2/history')).text();
  assert.match(historyTwo, /<td>1<\/td><td>2<\/td><td>3<\/td>/);
});

test('el pedido anulado sigue visible con Estado Anulado y la lista filtra Abiertos/Anulados/Todos', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);

  const active = await (await a.get('/orders')).text();
  assert.deepEqual(orderLinks(active), ['1001']);
  assert.match(active, /<option value="open" selected>Abiertos<\/option>/);

  assert.equal((await annul(a, 1001)).status, 303);

  // Active view hides it; Anulados and Todos show it with its status.
  const actives = await (await a.get('/orders')).text();
  assert.deepEqual(orderLinks(actives), []);
  assert.doesNotMatch(actives, /#1001/);

  const annulled = await (await a.get('/orders?state=annulled')).text();
  assert.deepEqual(orderLinks(annulled), ['1001']);
  assert.match(annulled, /<td><span class="status-tag">Anulado<\/span><\/td>/);
  assert.match(annulled, /<option value="annulled" selected>Anulados<\/option>/);

  const all = await (await a.get('/orders?state=all')).text();
  assert.deepEqual(orderLinks(all), ['1001']);
  assert.match(all, /<option value="all" selected>Todos<\/option>/);

  const detail = await (await a.get('/orders/1001?annulled=1')).text();
  assert.match(detail, /<span class="order-pill is-annulled"><span class="order-pill__dot" aria-hidden="true"><\/span>Anulado<\/span>/);
  assert.match(detail, /Pedido anulado y stock repuesto\./);
});

test('un pedido anulado no se puede anular dos veces y el inventario no cambia', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);
  assert.equal((await annul(a, 1001)).status, 303);
  assert.equal(await inventory(a, 1), '5');

  const again = await annul(a, 1001);
  assert.equal(again.status, 409);
  assert.match(await again.text(), /ya está anulado/);
  assert.equal(await inventory(a, 1), '5');
  assert.equal(await inventory(a, 2), '3');
  // The ficha never offers Anular again.
  assert.doesNotMatch(await (await a.get('/orders/1001')).text(), /Anular pedido/);
});

test('Consulta no puede anular; Gestión y Administración sí', async (t) => {
  const a = await app(t);
  await seed(a);
  for (const role of ['manager', 'viewer']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }
  assert.equal((await createOrder(a)).status, 303);

  await a.signIn('viewer', 'equipo-seguro-123');
  assert.equal((await a.get('/orders/1001')).status, 200);
  assert.doesNotMatch(await (await a.get('/orders/1001')).text(), /Anular pedido/);
  assert.equal((await annul(a, 1001)).status, 403);
  assert.equal(await inventory(a, 1), '3');

  await a.signIn('manager', 'equipo-seguro-123');
  assert.match(await (await a.get('/orders/1001')).text(), /Anular pedido/);
  assert.equal((await annul(a, 1001)).status, 303);
  assert.equal(await inventory(a, 1), '5');
});

test('la anulación exige CSRF y repone desde cero sin quedar negativo', async (t) => {
  const a = await app(t);
  await seed(a);
  // The order takes all five JUNTA, leaving the inventory at zero.
  assert.equal((await createOrder(a, { productId: ['1'], quantity: ['5'] })).status, 303);
  assert.equal(await inventory(a, 1), '0');
  assert.equal((await a.post('/orders/1001/annul', {})).status, 403);
  assert.equal(await inventory(a, 1), '0');

  assert.equal((await annul(a, 1001)).status, 303);
  assert.equal(await inventory(a, 1), '5');
  assert.ok(Number(await inventory(a, 1)) >= 0);
});
